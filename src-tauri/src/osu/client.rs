//! HTTP-клиент к osu! API v2.
//!
//! Знает про заголовки, ретраи и превращение статусов в `AppError`.
//! Ключ не хранит — он приходит параметром, токен лежит в [`Auth`].

use std::time::Duration;

use reqwest::header::{ACCEPT, AUTHORIZATION};
use reqwest::Response;
use serde::de::DeserializeOwned;

use crate::error::{AppError, Result};
use crate::model::{ApiCredentials, Beatmap, BeatmapAttributes};

use super::auth::Auth;
use super::dto::{
    to_attributes, to_beatmap, AttributesEnvelope, BeatmapDto, BeatmapsResponse, BeatmapsetDto,
    MatchDto, UserDto,
};
use super::{API_BASE, API_VERSION, ASSETS_BASE, USER_AGENT};

/// Таймаут одного запроса.
const TIMEOUT_SECS: u64 = 20;

/// Паузы между повторами на 429 и 5xx. Итого до четырёх попыток.
const RETRY_DELAYS: [u64; 3] = [1, 3, 7];

/// Потолок id в одном `GET /beatmaps?ids[]=` — жёсткое ограничение API.
const IDS_PER_REQUEST: usize = 50;

#[derive(Debug)]
pub struct OsuClient {
    pub http: reqwest::Client,
    pub auth: Auth,
}

impl Default for OsuClient {
    fn default() -> Self {
        Self::new()
    }
}

impl OsuClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(TIMEOUT_SECS))
            .user_agent(USER_AGENT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self {
            http,
            auth: Auth::new(),
        }
    }

    /// Одна карта. Нет такой — `NotFound`.
    pub async fn beatmap(&self, creds: &ApiCredentials, id: i64) -> Result<Beatmap> {
        let url = format!("{API_BASE}/beatmaps/{id}");
        let dto: BeatmapDto = self.get_json(creds, &url, &[], Some(id)).await?;
        Ok(to_beatmap(&dto, None))
    }

    /// Пачка карт. Сам режет список по 50 штук за запрос.
    ///
    /// Несуществующие id osu! молча выкидывает — в ответе их просто не будет.
    pub async fn beatmaps(&self, creds: &ApiCredentials, ids: &[i64]) -> Result<Vec<Beatmap>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }

        let url = format!("{API_BASE}/beatmaps");
        let mut out = Vec::with_capacity(ids.len());

        for chunk in ids.chunks(IDS_PER_REQUEST) {
            let query: Vec<(&str, String)> = chunk
                .iter()
                .map(|id| ("ids[]", id.to_string()))
                .collect();

            let resp: BeatmapsResponse = self.get_json(creds, &url, &query, None).await?;
            out.extend(resp.beatmaps.iter().map(|dto| to_beatmap(dto, None)));
        }

        Ok(out)
    }

    /// Все сложности набора одним запросом.
    pub async fn beatmapset(&self, creds: &ApiCredentials, set_id: i64) -> Result<Vec<Beatmap>> {
        let url = format!("{API_BASE}/beatmapsets/{set_id}");
        let set: BeatmapsetDto = self.get_json(creds, &url, &[], Some(set_id)).await?;

        // Диффы внутри сета своего `beatmapset` не несут — отдаём им родителя,
        // иначе останутся без артиста и названия.
        let maps = set
            .beatmaps
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .map(|dto| to_beatmap(dto, Some(&set)))
            .collect();

        Ok(maps)
    }

    /// Звёзды и скилл-разбивка под модами. Единственный способ узнать SR с модами.
    pub async fn attributes(
        &self,
        creds: &ApiCredentials,
        id: i64,
        mods: u32,
    ) -> Result<BeatmapAttributes> {
        let token = self.auth.token(creds, &self.http).await?;
        let url = format!("{API_BASE}/beatmaps/{id}/attributes");
        let body = serde_json::json!({ "mods": mods, "ruleset": "osu" });

        let resp = send_retrying(|| {
            self.http
                .post(&url)
                .header(AUTHORIZATION, format!("Bearer {token}"))
                .header("x-api-version", API_VERSION)
                .header(ACCEPT, "application/json")
                .json(&body)
        })
        .await?;

        let resp = self.check_status(resp, Some(id)).await?;
        let envelope: AttributesEnvelope = parse_json(resp).await?;
        Ok(to_attributes(id, mods, &envelope.attributes))
    }

    /// Мультиплеерное лобби. `after` — курсор по событиям.
    ///
    /// Курсор сдвигать самому нельзя как попало: событие игры создаётся при
    /// старте карты, а результаты дописываются в него же. Правило вызова
    /// живёт в [`crate::air::lobby`], здесь только запрос.
    pub async fn match_state(
        &self,
        creds: &ApiCredentials,
        room_id: i64,
        after: Option<i64>,
    ) -> Result<MatchDto> {
        let url = format!("{API_BASE}/matches/{room_id}");
        let query: Vec<(&str, String)> = match after {
            Some(cursor) => vec![("after", cursor.to_string())],
            None => Vec::new(),
        };
        self.get_json(creds, &url, &query, Some(room_id)).await
    }

    /// Профиль игрока: pp, ранги, точность, аватар. Тянется по одному разу
    /// на игрока за эфир и кешируется.
    pub async fn user(&self, creds: &ApiCredentials, user_id: i64) -> Result<UserDto> {
        let url = format!("{API_BASE}/users/{user_id}/osu");
        self.get_json(creds, &url, &[], Some(user_id)).await
    }

    /// Обложка набора. Лежит на assets.ppy.sh и авторизации не требует.
    pub async fn download_cover(&self, set_id: i64) -> Result<Vec<u8>> {        let url = format!("{ASSETS_BASE}/beatmaps/{set_id}/covers/list@2x.jpg");

        let resp = send_retrying(|| self.http.get(&url)).await?;
        let resp = self.check_status(resp, Some(set_id)).await?;

        let bytes = resp.bytes().await.map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                AppError::Offline
            } else {
                AppError::Other(format!("Обложку скачать не вышло: {e}"))
            }
        })?;

        Ok(bytes.to_vec())
    }

    /// Аватар игрока. Как и обложки, лежит на статике и токена не требует.
    /// Отдаётся редиректом на текущую картинку профиля.
    pub async fn download_avatar(&self, user_id: i64) -> Result<Vec<u8>> {
        let url = format!("https://a.ppy.sh/{user_id}");

        let resp = send_retrying(|| self.http.get(&url)).await?;
        let resp = self.check_status(resp, Some(user_id)).await?;

        let bytes = resp.bytes().await.map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                AppError::Offline
            } else {
                AppError::Other(format!("Аватар скачать не вышло: {e}"))
            }
        })?;

        Ok(bytes.to_vec())
    }

    /// GET к api/v2 с токеном, обязательными заголовками, ретраем и разбором JSON.
    async fn get_json<T: DeserializeOwned>(
        &self,
        creds: &ApiCredentials,
        url: &str,
        query: &[(&str, String)],
        not_found_id: Option<i64>,
    ) -> Result<T> {
        let token = self.auth.token(creds, &self.http).await?;

        let resp = send_retrying(|| {
            self.http
                .get(url)
                .query(query)
                .header(AUTHORIZATION, format!("Bearer {token}"))
                .header("x-api-version", API_VERSION)
                .header(ACCEPT, "application/json")
        })
        .await?;

        let resp = self.check_status(resp, not_found_id).await?;
        parse_json(resp).await
    }

    /// Статус -> ошибка. 404 — нет карты, 401 — ключ протух или плохой.
    async fn check_status(&self, resp: Response, not_found_id: Option<i64>) -> Result<Response> {
        let status = resp.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(resp);
        }

        match status {
            404 => Err(AppError::NotFound(not_found_id.unwrap_or_default())),
            401 => {
                // Токен мог просто устареть — выбрасываем, следующий вызов возьмёт новый.
                self.auth.invalidate().await;
                Err(AppError::BadCredentials)
            }
            _ => Err(AppError::Api { status }),
        }
    }
}

/// Отправка с повтором на 429 и 5xx: паузы 1с, 3с, 7с.
/// Обрыв связи не повторяем — это сразу офлайн.
async fn send_retrying<F>(build: F) -> Result<Response>
where
    F: Fn() -> reqwest::RequestBuilder,
{
    let mut last = AppError::Offline;

    for attempt in 0..=RETRY_DELAYS.len() {
        match build().send().await {
            Ok(resp) => {
                let status = resp.status().as_u16();
                // Повторяем только то, что и правда может пройти со второго раза.
                let retryable = status == 429 || (500..600).contains(&status);
                if !retryable {
                    return Ok(resp);
                }
                last = AppError::Api { status };
            }
            Err(e) => {
                return Err(if e.is_connect() || e.is_timeout() {
                    AppError::Offline
                } else {
                    AppError::from(e)
                });
            }
        }

        if let Some(pause) = RETRY_DELAYS.get(attempt) {
            tokio::time::sleep(Duration::from_secs(*pause)).await;
        }
    }

    Err(last)
}

/// Разбор тела. Испорченный JSON — это ошибка данных, а не повод падать.
async fn parse_json<T: DeserializeOwned>(resp: Response) -> Result<T> {
    let text = resp.text().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() {
            AppError::Offline
        } else {
            AppError::Other(format!("Ответ osu! не дочитался: {e}"))
        }
    })?;

    serde_json::from_str(&text)
        .map_err(|e| AppError::Other(format!("osu! прислал непонятный ответ: {e}")))
}
