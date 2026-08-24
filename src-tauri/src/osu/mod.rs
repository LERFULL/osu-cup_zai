//! Слой доступа к osu! API v2.
//!
//! Здесь только сеть и превращение ответов в наши модели: ни базы, ни кеша, ни очереди.
//! Токен живёт в памяти процесса, ключ приходит снаружи параметром на каждый вызов.

pub mod auth;
pub mod client;
pub mod derive;
pub mod dto;

/// База API v2. Всё, кроме получения токена и картинок, идёт отсюда.
pub const API_BASE: &str = "https://osu.ppy.sh/api/v2";

/// Выдача токена по client_credentials.
pub const TOKEN_URL: &str = "https://osu.ppy.sh/oauth/token";

/// Версия API — обязательный заголовок `x-api-version` на каждом запросе к v2.
pub const API_VERSION: &str = "20240529";

/// Как приложение представляется серверу.
pub const USER_AGENT: &str = "osu-cup/0.1";

/// Обложки лежат отдельно и отдаются без авторизации.
pub const ASSETS_BASE: &str = "https://assets.ppy.sh";

pub use auth::{Auth, MSG_INVALID, MSG_OFFLINE};
pub use client::OsuClient;
pub use derive::{derive, Derived};
pub use dto::{
    mods_bits, mods_label, to_attributes, to_beatmap, AttributesEnvelope, BeatmapDto,
    BeatmapsResponse, BeatmapsetDto, DifficultyAttributesDto, MatchDto, MatchGameDto,
    TokenResponse,
};
