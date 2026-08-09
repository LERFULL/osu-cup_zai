use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::error::Result;
use crate::model::ParsedLinks;
use crate::state::AppState;

/// Разбор вставленного текста. Сети не касается — ответ мгновенный,
/// поэтому список найденного можно показывать прямо во время набора.
#[tauri::command]
pub async fn parse_links(text: String) -> Result<ParsedLinks> {
    Ok(crate::links::parse(&text))
}

#[tauri::command]
pub async fn import_links(app: AppHandle, parsed: ParsedLinks) -> Result<String> {
    crate::import::spawn_import(app, parsed)
}

#[tauri::command]
pub async fn retry_failed(
    app: AppHandle,
    _state: State<'_, Arc<AppState>>,
    beatmap_ids: Vec<i64>,
) -> Result<String> {
    crate::import::retry(app, beatmap_ids)
}

#[tauri::command]
pub async fn cancel_batch(state: State<'_, Arc<AppState>>, batch_id: String) -> Result<()> {
    state.batches.cancel(&batch_id).await;
    Ok(())
}
