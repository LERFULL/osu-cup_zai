//! Хаб зрителей: держит состояние, рассылает изменения, считает подключённых.
//!
//! Два состояния вместо одного — из-за задержки. `live` — правда хоста, она
//! меняется в момент нажатия. `aired` — то, что уже видят зрители. Подключившийся
//! получает именно `aired`: иначе он оказался бы впереди всех остальных и увидел
//! бы кадр, которого пока ни у кого нет.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
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
    code: Mutex<String>,
    viewers: AtomicI64,
    delay_ms: AtomicU64,
    /// Растёт при смене кода: открытые сокеты по нему понимают, что их ссылка
    /// больше не действует.
    generation: AtomicU64,
}

impl AirHub {
    pub fn new(state: AirState, code: String, delay_secs: i64) -> Arc<Self> {
        let (tx, _) = broadcast::channel(256);
        Arc::new(Self {
            tx,
            live: Mutex::new(state.clone()),
            aired: Mutex::new(state),
            queue: Mutex::new(VecDeque::new()),
            code: Mutex::new(code),
            viewers: AtomicI64::new(0),
            delay_ms: AtomicU64::new(delay_secs.clamp(0, 30) as u64 * 1000),
            generation: AtomicU64::new(0),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    // ──────────────────────────────────────────────────────── код доступа

    pub async fn code(&self) -> String {
        self.code.lock().await.clone()
    }

    /// Ссылку могли переслать дальше — код меняется кнопкой. Все текущие
    /// зрители при этом отключаются: их ссылка стала недействительной,
    /// и делать вид, что это не так, значит оставить утёкшую ссылку живой.
    pub async fn set_code(&self, code: String) {
        *self.code.lock().await = code;
        self.generation.fetch_add(1, Ordering::SeqCst);
        let _ = self.tx.send(Wire::Kicked.encode());
    }

    pub async fn code_matches(&self, given: Option<&str>) -> bool {
        let code = self.code.lock().await;
        given.is_some_and(|g| g.eq_ignore_ascii_case(code.as_str()))
    }

    // ──────────────────────────────────────────────────────────── зрители

    pub fn viewers(&self) -> i64 {
        self.viewers.load(Ordering::SeqCst)
    }

    /// Число зрителей идёт мимо очереди задержки: это не кадр, и держать его
    /// десять секунд незачем.
    pub async fn set_viewers(&self, n: i64) {
        self.viewers.store(n, Ordering::SeqCst);
        self.live.lock().await.air.viewers = n;
        self.aired.lock().await.air.viewers = n;
        let _ = self.tx.send(Wire::Viewers { viewers: n }.encode());
    }

    pub async fn add_viewer(&self) -> i64 {
        let n = self.viewers.fetch_add(1, Ordering::SeqCst) + 1;
        self.set_viewers(n).await;
        n
    }

    pub async fn drop_viewer(&self) -> i64 {
        let n = (self.viewers.fetch_sub(1, Ordering::SeqCst) - 1).max(0);
        self.set_viewers(n).await;
        n
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

    /// Настройки, которые задаёт пульт и знает страница.
    pub async fn set_shown_fields(&self, show_viewers: bool, local_only: bool) {
        for state in [&self.live, &self.aired] {
            let mut s = state.lock().await;
            s.air.show_viewers = show_viewers;
            s.air.local_only = local_only;
        }
    }

    /// Новый кадр. Смена стека слоёв — это всегда переход с анимацией.
    pub async fn push_scene(&self, layers: Vec<Layer>, theme: Option<Value>) {
        let mut next = self.live.lock().await.clone();
        next.layers = layers.clone();
        if let Some(theme) = theme {
            next.theme = theme;
        }
        next.air.viewers = self.viewers();
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
        next.air.viewers = self.viewers();
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

    /// Пинг, чтобы туннель не закрыл соединение по простою.
    pub fn ping(&self) {
        let _ = self.tx.send(Wire::Ping.encode());
    }
}
