//! История: список завершённых турниров, их летопись и перенос между
//! компьютерами. Сигнатуры зеркалят `src/lib/ipc.ts`.

use std::sync::Arc;

use tauri::State;

use crate::db::history as db;
use crate::error::Result;
use crate::state::AppState;

#[tauri::command]
pub async fn history_list(state: State<'_, Arc<AppState>>) -> Result<Vec<db::HistorySummary>> {
    state.db.with(|conn| Ok(db::list(conn)?))
}

#[tauri::command]
pub async fn history_detail(state: State<'_, Arc<AppState>>, id: i64) -> Result<db::HistoryDetail> {
    state.db.with(|conn| Ok(db::detail(conn, id)?))
}

/// Снимок турнира в JSON. Фронт сам скачивает его через Blob: файлового
/// диалога в приложении нет, а запоминать путь незачем.
#[tauri::command]
pub async fn export_tournament(state: State<'_, Arc<AppState>>, id: i64) -> Result<String> {
    state.db.with(|conn| Ok(db::export_tournament(conn, id)?))
}

/// Турнир из JSON-снимка. Возвращает id нового турнира.
#[tauri::command]
pub async fn import_tournament(
    state: State<'_, Arc<AppState>>,
    json: String,
) -> Result<i64> {
    state.db.with_tx(|tx| Ok(db::import_tournament(tx, &json)?))
}

/// Копия базы в папку данных. Возвращает полный путь — фронт показывает его
/// пользователю и умеет открыть папку.
#[tauri::command]
pub async fn export_database(
    state: State<'_, Arc<AppState>>,
    backup: bool,
) -> Result<String> {
    state
        .db
        .with(|conn| Ok(db::export_database(conn, &state.data_dir, &state.db_path, backup)?))
}

/// Заменяет базу файлом с другого компьютера. Содержимое приходит base64:
/// фронт читает его через FileReader, путей с фронта не бывает.
#[tauri::command]
pub async fn import_database(state: State<'_, Arc<AppState>>, data: String) -> Result<()> {
    Ok(db::import_database(&state.db, &state.db_path, &data)?)
}

#[tauri::command]
pub async fn backup_database(state: State<'_, Arc<AppState>>) -> Result<String> {
    state
        .db
        .with(|conn| Ok(db::backup_database(conn, &state.data_dir, &state.db_path)?))
}

#[tauri::command]
pub async fn list_backups(state: State<'_, Arc<AppState>>) -> Result<Vec<String>> {
    Ok(db::list_backups(&state.data_dir)?)
}

#[tauri::command]
pub async fn restore_backup(state: State<'_, Arc<AppState>>, name: String) -> Result<()> {
    Ok(db::restore_backup(&state.db, &state.data_dir, &state.db_path, &name)?)
}
