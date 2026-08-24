//! Состояние эфира и протокол к странице зрителя.
//!
//! Зеркалят `src/lib/air/types.ts` — менять только парой. Здесь нет ни одной
//! доменной структуры турнира: `payload` собирает хост и присылает готовым,
//! Rust его только пересылает. Из этого следует, что новая сцена не требует
//! правок на этой стороне вовсе.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Один слой кадра. Обычно слой один, при врезке — два: врезка накрывает
/// сцену, а не заменяет её, поэтому под ней остаётся живое состояние матча.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    /// Какой рендерер рисует слой: `matchLive`, `banReveal`, `bracket`.
    pub id: String,
    /// Когда слой вошёл в эфир. От этого считаются анимации и таймеры,
    /// поэтому именно время, а не «пришло сообщение»: зашедший посреди сцены
    /// видит конечное положение, а не перезапуск с начала.
    pub since: String,
    /// Когда слой уйдёт сам. `None` — стоит, пока не сменят.
    pub until: Option<String>,
    pub payload: Value,
}

/// Про сам эфир, а не про кадр.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirMeta {
    pub tournament: String,
    pub started_at: String,
    /// Считает Rust: хост этого числа не знает, а страница его показывает.
    /// Что бы ни прислал фронт, поле перезаписывается здесь.
    #[serde(default)]
    pub viewers: i64,
    /// Показывать число зрителей в кадре.
    #[serde(default)]
    pub show_viewers: bool,
    /// Задержка, с которой состояние уходит зрителям. Секунды.
    #[serde(default)]
    pub delay: i64,
    /// Публичной ссылки нет — эфир только локальный. Страница по этому полю
    /// решает, можно ли играть свой видеофайл: через Cloudflare раздавать
    /// видео нельзя, а локально и в OBS — можно.
    #[serde(default)]
    pub local_only: bool,
}

/// Всё, что нужно кадру. Больше в состоянии ничего нет: ни списка сцен,
/// ни очереди — очередь дело пульта, зрителю она не нужна.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirState {
    pub air: AirMeta,
    /// Снизу вверх: первый слой — основа, последний — то, что сверху.
    pub layers: Vec<Layer>,
    /// Набор токенов темы, а не одна строка с акцентом: цвет — только первое,
    /// что захочется настроить.
    pub theme: Value,
}

impl AirState {
    /// Пустой эфир: заставка до первого события.
    pub fn initial(tournament: String, started_at: String, delay: i64, local_only: bool) -> Self {
        Self {
            air: AirMeta {
                tournament,
                started_at: started_at.clone(),
                viewers: 0,
                show_viewers: false,
                delay,
                local_only,
            },
            layers: vec![Layer {
                id: "idle".to_string(),
                since: started_at,
                until: None,
                payload: Value::Object(serde_json::Map::new()),
            }],
            theme: serde_json::json!({ "accent": "#ff6fb1" }),
        }
    }
}

/// Сообщение зрителю. `scene` всегда означает переход с анимацией,
/// `patch` — точечное обновление внутри той же сцены.
///
/// «Без анимации» относится к **переходу между сценами**, а не к самому
/// изменению: счёт внутри сцены перекатывается цифрой, новый бан гасит
/// строку. `patch` просто не выкидывает кадр и не выводит новый.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Wire {
    /// Сразу после подключения: полное состояние.
    Snapshot { state: AirState },
    /// Смена кадра: новый стек слоёв целиком.
    Scene { layers: Vec<Layer> },
    /// Изменение внутри слоя: счёт, новый бан, таймер.
    Patch { layer: String, payload: Value },
    /// Зрителей стало больше или меньше. Кадр от этого не перерисовывается.
    Viewers { viewers: i64 },
    /// Эфир остановлен. Страница показывает надпись поверх последнего кадра,
    /// а не чёрный экран.
    Closed { reason: String },
    /// Хост сменил код доступа — эта ссылка больше не действует.
    Kicked,
    /// Чтобы туннель не закрыл соединение по простою.
    Ping,
}

impl Wire {
    /// Готовая строка для отправки. Ошибка сериализации здесь невозможна
    /// (внутри только `Value` и примитивы), но падать из-за неё эфир не должен.
    pub fn encode(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| r#"{"kind":"ping"}"#.to_string())
    }
}

/// Что пульт знает про эфир. Отдаётся на каждый запрос и после каждого действия.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AirStatus {
    /// Эфир поднят.
    pub live: bool,
    /// По какому турниру идёт эфир. Пульт другого турнира по этому полю
    /// понимает, что кадры сейчас не его, и не перебивает чужой эфир.
    pub tournament_id: Option<i64>,
    pub port: u16,
    /// `http://127.0.0.1:PORT?code=XXXX` — источник для OBS, всегда есть.
    pub local_url: String,
    /// Та же страница по адресу в локальной сети: смотреть с другой машины
    /// дома публичная ссылка не нужна.
    pub lan_url: Option<String>,
    /// Публичная ссылка. `None` — эфир локальный, туннеля нет.
    pub public_url: Option<String>,
    /// Почему публичной ссылки нет, если её просили.
    pub public_error: Option<String>,
    pub code: String,
    pub viewers: i64,
    pub started_at: Option<String>,
    pub delay: i64,
    /// Кадров, ждущих задержки: пока их больше нуля, вывод можно вернуть.
    pub pending: i64,
    /// Что сейчас в эфире у зрителей — по нему пульт рисует «Сейчас в эфире».
    pub aired: Option<AirState>,
    /// Состояние опроса лобби у идущего матча.
    pub lobby: Option<LobbyStatus>,
}

/// Что происходит с опросом мультиплеерного лобби.
///
/// Здесь только то, что переживает перерисовку панели. Последняя причина отказа
/// и текущая карта приходят пультом из событий `air:lobby` — держать их копию
/// ещё и здесь значит иметь два источника для одной строки на экране.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LobbyStatus {
    pub match_id: i64,
    /// Номер лобби osu!.
    pub room_id: i64,
    /// Опрос идёт.
    pub polling: bool,
}
