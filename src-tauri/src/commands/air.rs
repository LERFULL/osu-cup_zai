//! Команды эфира. Ровно транспорт и то, что должно пережить перезапуск:
//! сцены, переходы и подбор под бюджет считает пульт.

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::air::state::{AirStatus, Layer};
use crate::db::air as db;
use crate::error::{AppError, Result};
use crate::state::AppState;

#[tauri::command]
pub async fn air_status(state: State<'_, Arc<AppState>>) -> Result<AirStatus> {
    state.air.status().await
}

#[tauri::command]
pub async fn air_start(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    tournament_id: i64,
    tournament: String,
    delay: i64,
) -> Result<AirStatus> {
    state
        .air
        .start(&app, tournament_id, tournament, delay)
        .await
}

#[tauri::command]
pub async fn air_stop(state: State<'_, Arc<AppState>>) -> Result<AirStatus> {
    state.air.stop().await
}

/// Новый кадр: стек слоёв целиком. Обычно слой один, при врезке два — врезка
/// накрывает сцену, а не заменяет её.
#[tauri::command]
pub async fn air_scene(
    state: State<'_, Arc<AppState>>,
    layers: Vec<Layer>,
    theme: Option<serde_json::Value>,
) -> Result<()> {
    state.air.scene(layers, theme).await
}

/// Точечное обновление внутри слоя: счёт, новый бан, таймер. Кадр остаётся тем же.
#[tauri::command]
pub async fn air_patch(
    state: State<'_, Arc<AppState>>,
    layer: String,
    payload: serde_json::Value,
) -> Result<()> {
    state.air.patch(layer, payload).await
}

/// Снимает кадр, пока его держит задержка. Пока он не ушёл, его никто не видел —
/// это и есть настоящая отмена вывода.
#[tauri::command]
pub async fn air_revert(state: State<'_, Arc<AppState>>) -> Result<bool> {
    state.air.revert().await
}

#[tauri::command]
pub async fn air_set_delay(state: State<'_, Arc<AppState>>, seconds: i64) -> Result<()> {
    state.air.set_delay(seconds).await
}

// ─────────────────────────────────────────────────────────────────── лобби

/// Поднимает опрос лобби. Опрос идёт, только пока матч идёт.
#[tauri::command]
pub async fn air_lobby_start(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    match_id: i64,
    room_id: i64,
) -> Result<()> {
    let inner = Arc::clone(&state);
    state.air.lobby_start(&app, inner, match_id, room_id).await
}

#[tauri::command]
pub async fn air_lobby_stop(state: State<'_, Arc<AppState>>) -> Result<()> {
    state.air.lobby_stop().await
}

/// Номер лобби матча. Вводится один раз при старте матча, поле необязательное.
#[tauri::command]
pub async fn set_match_lobby(
    state: State<'_, Arc<AppState>>,
    id: i64,
    room_id: Option<i64>,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| Ok(db::set_lobby(tx, id, room_id)?))
}

// ──────────────────────────────────────────────── настройки и показы

/// Настройки эфира этого турнира одной строкой JSON: форму знает пульт.
#[tauri::command]
pub async fn air_config(state: State<'_, Arc<AppState>>, tournament_id: i64) -> Result<Option<String>> {
    state.db.with(|conn| Ok(db::config(conn, tournament_id)?))
}

#[tauri::command]
pub async fn air_set_config(
    state: State<'_, Arc<AppState>>,
    tournament_id: i64,
    json: String,
) -> Result<()> {
    // Битый JSON в базе означал бы настройки, которые нельзя ни прочитать,
    // ни починить из интерфейса.
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| AppError::Other(format!("Настройки эфира не читаются: {e}")))?;
    state
        .db
        .with_tx(|tx| Ok(db::set_config(tx, tournament_id, &json)?))
}

/// Сколько раз какая сцена выходила. Живёт с турниром, а не с сессией эфира.
#[tauri::command]
pub async fn air_shows(
    state: State<'_, Arc<AppState>>,
    tournament_id: i64,
) -> Result<Vec<db::SceneShow>> {
    state.db.with(|conn| Ok(db::shows(conn, tournament_id)?))
}

#[tauri::command]
pub async fn air_note_show(
    state: State<'_, Arc<AppState>>,
    tournament_id: i64,
    scene_id: String,
    object_key: String,
) -> Result<Vec<db::SceneShow>> {
    state.db.with_tx(|tx| {
        db::note_show(tx, tournament_id, &scene_id, &object_key)?;
        Ok(db::shows(tx, tournament_id)?)
    })
}

#[tauri::command]
pub async fn air_clear_shows(
    state: State<'_, Arc<AppState>>,
    tournament_id: i64,
) -> Result<Vec<db::SceneShow>> {
    state.db.with_tx(|tx| {
        db::clear_shows(tx, tournament_id)?;
        Ok(db::shows(tx, tournament_id)?)
    })
}

/// Профили osu! участников: pp, ранги, точность.
///
/// Тянутся по одному разу на игрока и живут сутки — за эфир ранг не меняется,
/// а бюджет запросов один на всё приложение. Игрок без привязки к профилю
/// молча пропускается: сцена строится по тому, что есть, и пустых полей в
/// кадре не остаётся.
#[tauri::command]
pub async fn air_profiles(
    state: State<'_, Arc<AppState>>,
    osu_user_ids: Vec<i64>,
) -> Result<Vec<db::OsuProfile>> {
    let mut out = Vec::new();
    let mut missing = Vec::new();

    for id in osu_user_ids {
        match state.db.with(|conn| Ok(db::cached_profile(conn, id)))? {
            Some(profile) => out.push(profile),
            None => missing.push(id),
        }
    }

    if missing.is_empty() {
        return Ok(out);
    }

    // Без ключа кеша хватит: сцена покажет внутреннюю статистику и не сломается.
    let Ok(creds) = state.credentials() else {
        return Ok(out);
    };

    for id in missing {
        state.limiter.acquire().await;
        let Ok(dto) = state.osu.user(&creds, id).await else {
            continue;
        };
        let stats = dto.statistics.unwrap_or_default();
        let profile = db::OsuProfile {
            osu_user_id: dto.id,
            username: dto.username,
            pp: stats.pp,
            global_rank: stats.global_rank,
            country_rank: stats.country_rank,
            country_code: dto.country_code,
            accuracy: stats.hit_accuracy,
            play_count: stats.play_count,
        };
        state.db.with_tx(|tx| Ok(db::save_profile(tx, &profile)?))?;
        out.push(profile);
    }

    Ok(out)
}
