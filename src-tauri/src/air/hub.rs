//! Хаб зрителей: держит состояние и рассылает изменения.
//!
//! Два состояния вместо одного — из-за задержки. `live` — правда хоста, она
//! меняется в момент нажатия. `aired` — то, что уже видят зрители. Подключившийся
//! получает именно `aired`: иначе он оказался бы впереди всех остальных и увидел
//! бы кадр, которого пока ни у кого нет.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{broadcast, Mutex};
use tokio::time::Instant;

use super::state::{AirState, Layer, Wire};

/// Кадр, который ждёт своей задержки.
struct Pending {
    /// Когда уйдёт зрителям.
    at: Instant,
    /// Состояние целиком, а не только сообщение: по нему потом собирается
    /// снимок для тех, кто подключится.
    state: AirState,
    wire: Wire,
}

pub struct AirHub {
    /// Готовые строки сообщений. Ёмкость с запасом: отставший зритель
    /// получит `Lagged` и переподключится, а не подвесит рассылку.
    tx: broadcast::Sender<String>,
    live: Mutex<AirState>,
    aired: Mutex<AirState>,
    queue: Mutex<VecDeque<Pending>>,
    delay_ms: AtomicU64,
}

impl AirHub {
    pub fn new(state: AirState, delay_secs: i64) -> Arc<Self> {
        let (tx, _) = broadcast::channel(256);
        Arc::new(Self {
            tx,
            live: Mutex::new(state.clone()),
            aired: Mutex::new(state),
            queue: Mutex::new(VecDeque::new()),
            delay_ms: AtomicU64::new(delay_secs.clamp(0, 30) as u64 * 1000),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }

    // ─────────────────────────────────────────────────────────── задержка

    pub fn delay_secs(&self) -> i64 {
        (self.delay_ms.load(Ordering::SeqCst) / 1000) as i64
    }

    pub async fn set_delay(&self, secs: i64) {
        let secs = secs.clamp(0, 30);
        self.delay_ms.store(secs as u64 * 1000, Ordering::SeqCst);
        self.live.lock().await.air.delay = secs;
        self.aired.lock().await.air.delay = secs;
    }

    pub async fn pending(&self) -> i64 {
        self.queue.lock().await.len() as i64
    }

    // ────────────────────────────────────────────────────────── состояние

    pub async fn aired(&self) -> AirState {
        self.aired.lock().await.clone()
    }

    /// Новый кадр. Смена стека слоёв — это всегда переход с анимацией.
    pub async fn push_scene(&self, layers: Vec<Layer>, theme: Option<Value>) {
        let mut next = self.live.lock().await.clone();
        next.layers = layers.clone();
        if let Some(theme) = theme {
            next.theme = theme;
        }
        self.enqueue(next, Wire::Scene { layers }).await;
    }

    /// Точечное обновление внутри слоя: счёт, новый бан, таймер. Кадр
    /// остаётся тем же, поэтому и сообщение маленькое.
    pub async fn push_patch(&self, layer_id: String, payload: Value) {
        let mut next = self.live.lock().await.clone();
        // Слой, которого нет в кадре, патчить нечего: молча пропускаем, иначе
        // отставший патч после смены сцены поднял бы ошибку на пустом месте.
        let Some(slot) = next.layers.iter_mut().find(|l| l.id == layer_id) else {
            return;
        };
        slot.payload = payload.clone();
        self.enqueue(
            next,
            Wire::Patch {
                layer: layer_id,
                payload,
            },
        )
        .await;
    }

    /// Кладёт кадр в очередь и, если задержки нет, отдаёт сразу. Так у
    /// задержки 0 нет ни лишнего кванта времени, ни отдельной ветки кода.
    async fn enqueue(&self, state: AirState, wire: Wire) {
        *self.live.lock().await = state.clone();

        let delay = self.delay_ms.load(Ordering::SeqCst);
        if delay == 0 {
            self.commit(state, wire).await;
            return;
        }

        self.queue.lock().await.push_back(Pending {
            at: Instant::now() + Duration::from_millis(delay),
            state,
            wire,
        });
    }

    /// Отдаёт кадр зрителям.
    async fn commit(&self, state: AirState, wire: Wire) {
        *self.aired.lock().await = state;
        let _ = self.tx.send(wire.encode());
    }

    /// Снимает последний ещё не ушедший кадр. Это и есть настоящая отмена:
    /// пока задержка держит кадр, его никто не видел.
    pub async fn revert(&self) -> bool {
        let popped = self.queue.lock().await.pop_back();
        let Some(_) = popped else {
            return false;
        };

        // Правда хоста возвращается к последнему кадру в очереди, а если
        // очередь опустела — к тому, что видят зрители.
        let restored = {
            let queue = self.queue.lock().await;
            match queue.back() {
                Some(last) => last.state.clone(),
                None => self.aired.lock().await.clone(),
            }
        };
        *self.live.lock().await = restored;
        true
    }

    /// Раз в тик отдаёт всё, чему пришло время. Вызывается из своей задачи,
    /// поднятой вместе с сервером.
    pub async fn tick(&self) {
        loop {
            let now = Instant::now();
            let ready = {
                let mut queue = self.queue.lock().await;
                match queue.front() {
                    Some(front) if front.at <= now => queue.pop_front(),
                    _ => None,
                }
            };
            let Some(frame) = ready else { return };
            self.commit(frame.state, frame.wire).await;
        }
    }

    /// Эфир остановлен: зритель видит надпись поверх последнего кадра.
    /// Всё, что не успело уйти, не уходит: эфира уже нет.
    pub async fn close(&self, reason: &str) {
        self.queue.lock().await.clear();
        let _ = self.tx.send(
            Wire::Closed {
                reason: reason.to_string(),
            }
            .encode(),
        );
    }

    /// Пинг: сокет, умерший без кадра закрытия, иначе висел бы до таймаута TCP.
    pub fn ping(&self) {
        let _ = self.tx.send(Wire::Ping.encode());
    }
}
