use std::sync::Arc;

use tauri::State;

use crate::db::players as players_db;
use crate::db::prize as prize_db;
use crate::error::{AppError, Result};
use crate::model::{ApiCredentials, AppStatus, CredentialsCheck, QueueStatus};
use crate::osu::auth::Auth;
use crate::state::AppState;

/// Поля строки карты, которые знает редактор маппула. Настройка «по умолчанию»
/// не должна пропускать значения, которых нет на экране пула.
const FIELD_WHITELIST: [&str; 9] = [
    "stars", "length", "bpm", "ar", "od", "cs", "hp", "mapper", "skillsets",
];

#[tauri::command]
pub async fn get_status(state: State<'_, Arc<AppState>>) -> Result<AppStatus> {
    let cfg = state.cfg.get();
    Ok(AppStatus {
        has_credentials: cfg.credentials().is_some(),
        online: true,
        onboarded: cfg.onboarded,
        match_hints_seen: cfg.match_hints_seen,
        db_path: state.db_path.to_string_lossy().to_string(),
        cache_path: state.data_dir.join("covers").to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn set_onboarded(state: State<'_, Arc<AppState>>, value: bool) -> Result<()> {
    state.cfg.set_onboarded(value)
}

/// Подсказки при первом входе в матч больше не показываем.
#[tauri::command]
pub async fn set_match_hints_seen(state: State<'_, Arc<AppState>>) -> Result<()> {
    state.cfg.set_match_hints_seen()
}

#[tauri::command]
pub async fn get_credentials(state: State<'_, Arc<AppState>>) -> Result<Option<ApiCredentials>> {
    Ok(state.cfg.credentials())
}

#[tauri::command]
pub async fn save_credentials(
    state: State<'_, Arc<AppState>>,
    creds: ApiCredentials,
) -> Result<()> {
    state.cfg.set_credentials(&creds)
}

#[tauri::command]
pub async fn check_credentials(
    state: State<'_, Arc<AppState>>,
    creds: ApiCredentials,
) -> Result<CredentialsCheck> {
    // Проверяем именно тот ключ, что сейчас в полях, а не сохранённый:
    // кнопка «Проверить» должна работать до сохранения.
    Ok(Auth::check(&creds, &state.osu.http).await)
}

#[tauri::command]
pub async fn clear_credentials(state: State<'_, Arc<AppState>>) -> Result<()> {
    state.cfg.clear_credentials()
}

#[tauri::command]
pub async fn get_queue_status(state: State<'_, Arc<AppState>>) -> Result<QueueStatus> {
    Ok(QueueStatus {
        pending: 0,
        done: 0,
        failed: 0,
        budget: state.limiter.budget().await,
        active_batch: state.batches.active().await,
    })
}

#[tauri::command]
pub async fn cache_size(state: State<'_, Arc<AppState>>) -> Result<u64> {
    Ok(state.covers.size())
}

#[tauri::command]
pub async fn clear_cache(state: State<'_, Arc<AppState>>) -> Result<()> {
    state.covers.clear()
}

// ───────────────────────────────────────────── настройки приложения

/// Поля строки карты, с которыми создаются новые маппулы. `null` — настройка
/// не задана, действует встроенный набор (звёзды, длина, BPM).
#[tauri::command]
pub async fn default_fields(state: State<'_, Arc<AppState>>) -> Result<Option<Vec<String>>> {
    state.db.with(|conn| {
        Ok(prize_db::kv_get(conn, "defaultFields")
            .and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok()))
    })
}

/// Поля строки карты для новых маппулов. Порядок сохраняется как есть;
/// существующие пулы не пересматриваются.
#[tauri::command]
pub async fn set_default_fields(
    state: State<'_, Arc<AppState>>,
    fields: Vec<String>,
) -> Result<()> {
    state.db.with(|conn| {
        for f in &fields {
            if !FIELD_WHITELIST.contains(&f.as_str()) {
                return Err(AppError::Other(format!("неизвестное поле строки: {f}")));
            }
        }
        Ok(prize_db::kv_set(
            conn,
            "defaultFields",
            &serde_json::to_string(&fields)?,
        )?)
    })
}

/// Палитра цветов игроков: восемь hex-цветов из настроек или стандартная.
#[tauri::command]
pub async fn player_palette(state: State<'_, Arc<AppState>>) -> Result<Vec<String>> {
    state.db.with(|conn| Ok(players_db::palette(conn)))
}

/// Своя палитра игроков. Цвета назначаются только новым игрокам — уже
/// раскрашенные не перекрашиваются.
#[tauri::command]
pub async fn set_player_palette(
    state: State<'_, Arc<AppState>>,
    colors: Vec<String>,
) -> Result<()> {
    state.db.with(|conn| Ok(players_db::set_palette(conn, &colors)?))
}

/// Язык интерфейса. Приложение одноязычное: настройка хранится, но
/// выбрать можно только русский.
#[tauri::command]
pub async fn language(state: State<'_, Arc<AppState>>) -> Result<String> {
    state.db.with(|conn| Ok(prize_db::kv_get(conn, "lang").unwrap_or_else(|| "ru".into())))
}

#[tauri::command]
pub async fn set_language(state: State<'_, Arc<AppState>>, lang: String) -> Result<()> {
    state.db.with(|conn| {
        if lang != "ru" {
            return Err(AppError::Other(
                "русский — единственный язык приложения".into(),
            ));
        }
        Ok(prize_db::kv_set(conn, "lang", &lang)?)
    })
}

/// Автобэкап раз в N запусков. 0 — выключен.
#[tauri::command]
pub async fn backup_every(state: State<'_, Arc<AppState>>) -> Result<i64> {
    state
        .db
        .with(|conn| Ok(prize_db::kv_get_i64(conn, "backupEvery", 0)))
}

#[tauri::command]
pub async fn set_backup_every(state: State<'_, Arc<AppState>>, every: i64) -> Result<()> {
    state.db.with(|conn| {
        if !(0..=1000).contains(&every) {
            return Err(AppError::Other(
                "автобэкап: 0 — выключить, иначе раз в N запусков (до 1000)".into(),
            ));
        }
        Ok(prize_db::kv_set_i64(conn, "backupEvery", every)?)
    })
}
