//! Токен osu! и проверка ключа.
//!
//! Токен держится ТОЛЬКО в памяти процесса: на диск не пишется никогда.
//! Обновляется сам за минуту до истечения. Состояние под `tokio::sync::Mutex`,
//! так что параллельные вызовы не устроят гонку и не сходят за токеном дважды.

use std::time::{Duration, Instant};

use reqwest::header::{ACCEPT, AUTHORIZATION};
use tokio::sync::Mutex;

use crate::error::{AppError, Result};
use crate::model::{ApiCredentials, CredentialsCheck};

use super::dto::TokenResponse;
use super::{API_BASE, API_VERSION, TOKEN_URL};

/// Текст для неверного ключа.
pub const MSG_INVALID: &str =
    "Ключ не подошёл. Проверь, что скопировал Client ID и Client Secret целиком";

/// Текст для случая «сети нет».
pub const MSG_OFFLINE: &str = "Нет соединения с osu!. Проверю ключ позже";

/// За сколько секунд до истечения идём за новым токеном.
const RENEW_MARGIN_SECS: u64 = 60;

/// Минимальный срок жизни, чтобы не долбить сервер, если пришла странная `expires_in`.
const MIN_LIFETIME_SECS: u64 = 30;

/// Живой токен вместе с ключом, на который он выдан.
struct Cached {
    value: String,
    expires_at: Instant,
    client_id: String,
    client_secret: String,
}

/// Хранилище токена. Секрет наружу не показывает и в `Debug` не попадает.
#[derive(Default)]
pub struct Auth {
    state: Mutex<Option<Cached>>,
}

impl std::fmt::Debug for Auth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Auth { .. }")
    }
}

impl Auth {
    pub fn new() -> Self {
        Self::default()
    }

    /// Живой токен. Сам обновляет за 60 секунд до истечения и при смене ключа.
    ///
    /// Мьютекс держится на время похода в сеть — это и есть защита от гонки:
    /// второй вызов подождёт и заберёт уже готовый токен.
    pub async fn token(&self, creds: &ApiCredentials, http: &reqwest::Client) -> Result<String> {
        let id = creds.client_id.trim();
        let secret = creds.client_secret.trim();
        if id.is_empty() || secret.is_empty() {
            return Err(AppError::NoCredentials);
        }

        let mut guard = self.state.lock().await;

        if let Some(cached) = guard.as_ref() {
            // Токен годится, только если он выдан на тот же ключ и ещё не истёк.
            let same_key = cached.client_id == id && cached.client_secret == secret;
            if same_key && Instant::now() < cached.expires_at {
                return Ok(cached.value.clone());
            }
        }

        let fresh = request_token(id, secret, http).await?;
        let value = fresh.value.clone();
        *guard = Some(fresh);
        Ok(value)
    }

    /// Забыть токен. Зовётся, когда osu! ответил 401 на обычный запрос.
    pub async fn invalidate(&self) {
        *self.state.lock().await = None;
    }

    /// Живая проверка ключа: сначала токен, потом `GET /beatmaps/75`.
    ///
    /// Ничего не кеширует — это отдельная разовая операция для экрана настроек.
    pub async fn check(creds: &ApiCredentials, http: &reqwest::Client) -> CredentialsCheck {
        let id = creds.client_id.trim();
        let secret = creds.client_secret.trim();
        if id.is_empty() || secret.is_empty() {
            return CredentialsCheck::Invalid {
                message: MSG_INVALID.to_string(),
            };
        }

        let token = match request_token(id, secret, http).await {
            Ok(t) => t.value,
            Err(AppError::BadCredentials) => {
                return CredentialsCheck::Invalid {
                    message: MSG_INVALID.to_string(),
                }
            }
            // Всё прочее — сеть легла или сервер приболел: ключ проверим позже.
            Err(_) => {
                return CredentialsCheck::Offline {
                    message: MSG_OFFLINE.to_string(),
                }
            }
        };

        let url = format!("{API_BASE}/beatmaps/75");
        let sent = http
            .get(&url)
            .header(AUTHORIZATION, format!("Bearer {token}"))
            .header("x-api-version", API_VERSION)
            .header(ACCEPT, "application/json")
            .send()
            .await;

        match sent {
            Ok(resp) if resp.status().as_u16() == 401 => CredentialsCheck::Invalid {
                message: MSG_INVALID.to_string(),
            },
            Ok(_) => CredentialsCheck::Ok,
            Err(_) => CredentialsCheck::Offline {
                message: MSG_OFFLINE.to_string(),
            },
        }
    }
}

/// Запрос нового токена. `invalid_client` и 401 -> ключ плохой, обрыв связи -> офлайн.
async fn request_token(
    client_id: &str,
    client_secret: &str,
    http: &reqwest::Client,
) -> Result<Cached> {
    let form = [
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("grant_type", "client_credentials"),
        ("scope", "public"),
    ];

    let resp = http
        .post(TOKEN_URL)
        .header(ACCEPT, "application/json")
        .form(&form)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                AppError::Offline
            } else {
                AppError::from(e)
            }
        })?;

    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        // Тело может не прочитаться — это не повод падать.
        let body = resp.text().await.unwrap_or_default();
        if status == 400 || status == 401 || body.contains("invalid_client") {
            return Err(AppError::BadCredentials);
        }
        return Err(AppError::Api { status });
    }

    let parsed: TokenResponse = resp.json().await.map_err(|e| {
        AppError::Other(format!("osu! прислал непонятный ответ на запрос токена: {e}"))
    })?;

    if parsed.access_token.trim().is_empty() {
        return Err(AppError::BadCredentials);
    }

    let lifetime = parsed
        .expires_in
        .saturating_sub(RENEW_MARGIN_SECS)
        .max(MIN_LIFETIME_SECS);

    Ok(Cached {
        value: parsed.access_token,
        expires_at: Instant::now() + Duration::from_secs(lifetime),
        client_id: client_id.to_string(),
        client_secret: client_secret.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Без ключа в сеть не ходим вообще.
    #[tokio::test]
    async fn empty_credentials_are_rejected() {
        let auth = Auth::new();
        let http = reqwest::Client::new();
        let creds = ApiCredentials::default();

        match auth.token(&creds, &http).await {
            Err(AppError::NoCredentials) => {}
            other => panic!("ждали NoCredentials, получили {other:?}"),
        }

        let check = Auth::check(&creds, &http).await;
        assert!(matches!(check, CredentialsCheck::Invalid { .. }));
    }
}
