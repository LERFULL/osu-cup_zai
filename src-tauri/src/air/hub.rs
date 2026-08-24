//! Хаб зрителей: держит состояние и рассылает изменения.
//!
//! Состояние одно. Раньше их было два — «правда хоста» и «то, что уже видят
//! зрители», — потому что кадр мог лежать в очереди задержки. Задержки больше
//! нет: она существовала, чтобы свести ссылку со стримом и чтобы кадр можно
//! было снять до показа. Ссылки нет, а снятие заменено на «придержать
//! и выпустить» — кадр, который ждёт кнопки, а не уже ушедший назад.
//!
//! Отсюда и простота: кадр уходит зрителям в тот же миг, что меняется у хоста,
//! и подключившийся получает ровно то, что у всех.

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::{broadcast, Mutex};

use super::state::{AirState, Layer, Wire};

pub struct AirHub {
    /// Готовые строки сообщений. Ёмкость с запасом: отставший зритель
    /// получит `Lagged` и переподключится, а не подвесит рассылку.
    tx: broadcast::Sender<String>,
    state: Mutex<AirState>,
}

impl AirHub {
    pub fn new(state: AirState) -> Arc<Self> {
        let (tx, _) = broadcast::channel(256);
        Arc::new(Self {
            tx,
            state: Mutex::new(state),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }

    /// Что сейчас в эфире. Отсюда берётся снимок для подключившегося.
    pub async fn aired(&self) -> AirState {
        self.state.lock().await.clone()
    }

    /// Новый кадр. Смена стека слоёв — это всегда переход с анимацией.
    pub async fn push_scene(&self, layers: Vec<Layer>, theme: Option<Value>) {
        let mut state = self.state.lock().await;
        state.layers = layers.clone();
        if let Some(theme) = theme {
            state.theme = theme;
        }
        let _ = self.tx.send(Wire::Scene { layers }.encode());
    }

    /// Точечное обновление внутри слоя: счёт, новый бан, таймер. Кадр
    /// остаётся тем же, поэтому и сообщение маленькое.
    pub async fn push_patch(&self, layer_id: String, payload: Value) {
        let mut state = self.state.lock().await;
        // Слой, которого нет в кадре, патчить нечего: молча пропускаем, иначе
        // отставший патч после смены сцены поднял бы ошибку на пустом месте.
        let Some(slot) = state.layers.iter_mut().find(|l| l.id == layer_id) else {
            return;
        };
        slot.payload = payload.clone();
        let _ = self.tx.send(
            Wire::Patch {
                layer: layer_id,
                payload,
            }
            .encode(),
        );
    }

    /// Эфир остановлен: зритель видит надпись поверх последнего кадра.
    pub async fn close(&self, reason: &str) {
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
