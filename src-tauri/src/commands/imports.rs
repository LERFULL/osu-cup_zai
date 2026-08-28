use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::error::Result;
use crate::model::{ImportBatch, ParsedLinks};
use crate::state::AppState;

/// Разбор вставленного текста. Сети не касается — ответ мгновенный,
/// поэтому список найденного можно показывать прямо во время набора.
#[tauri::command]
pub async fn parse_links(text: String) -> Result<ParsedLinks> {
    Ok(crate::links::parse(&text))
}

/// Поставить пачку ссылок в очередь загрузок. `mods` — авто-теги на все
/// карты пачки (например ["NM"]): ни одной не осталось без разметки.
#[tauri::command]
pub async fn download_queue_add(
    app: AppHandle,
    parsed: ParsedLinks,
    mods: Vec<String>,
    name: Option<String>,
) -> Result<ImportBatch> {
    let name = match name {
        Some(n) if !n.trim().is_empty() => n.trim().to_string(),
        _ => "Пачка".into(),
    };
    crate::import::enqueue(app, parsed, mods, name)
}

/// Вся очередь: идущие, ждущие и закончившиеся пачки.
#[tauri::command]
pub async fn download_queue_list(state: State<'_, Arc<AppState>>) -> Result<Vec<ImportBatch>> {
    state.db.with(crate::db::downloads::list)
}

/// Отменить пачку: ждущая снимается сразу, идущая — на ближайшем шаге.
#[tauri::command]
pub async fn download_queue_cancel(app: AppHandle, batch_id: String) -> Result<ImportBatch> {
    crate::import::cancel(app, &batch_id).await
}

/// Отправить пачку заново — например, если она кончилась с ошибками.
#[tauri::command]
pub async fn download_queue_retry(app: AppHandle, batch_id: String) -> Result<ImportBatch> {
    crate::import::retry(app, &batch_id)
}

/// Убрать пачку из списка. Идущую сначала надо отменить.
#[tauri::command]
pub async fn download_queue_remove(app: AppHandle, batch_id: String) -> Result<()> {
    crate::import::remove(app, &batch_id)
}

/// Убрать из списка всё, что уже не качается и не ждёт.
#[tauri::command]
pub async fn download_queue_clear(app: AppHandle) -> Result<()> {
    crate::import::clear_finished(app)
}
