use serde::Serialize;

/// Ошибка, которую видит фронт. Текст сразу пригоден для показа пользователю.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Не удалось прочитать локальную базу: {0}")]
    Db(String),

    #[error("Нет соединения с osu!")]
    Offline,

    #[error("Ключ не подошёл. Проверь, что скопировал Client ID и Client Secret целиком")]
    BadCredentials,

    #[error("Ключ osu! не задан. Введи его в настройках")]
    NoCredentials,

    #[error("osu! ответил ошибкой {status}")]
    Api { status: u16 },

    #[error("Карта {0} на osu! не найдена")]
    NotFound(i64),

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, AppError>;

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Db(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Other(format!("Испорченные данные: {e}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Other(format!("Ошибка файла: {e}"))
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_connect() || e.is_timeout() {
            AppError::Offline
        } else if let Some(status) = e.status() {
            AppError::Api {
                status: status.as_u16(),
            }
        } else {
            AppError::Other(e.to_string())
        }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Other(e.to_string())
    }
}
