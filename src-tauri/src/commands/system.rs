use std::sync::Arc;

use tauri::State;

use crate::error::Result;
use crate::model::{ApiCredentials, AppStatus, CredentialsCheck, QueueStatus};
use crate::osu::auth::Auth;
use crate::state::AppState;

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
