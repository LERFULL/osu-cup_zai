use std::sync::Arc;

use tauri::State;

use crate::db::collections as col;
use crate::error::Result;
use crate::model::{Collection, Folder, LibraryFilter};
use crate::state::AppState;

#[tauri::command]
pub async fn list_collections(state: State<'_, Arc<AppState>>) -> Result<Vec<Collection>> {
    state.db.with(col::list)
}

#[tauri::command]
pub async fn list_folders(state: State<'_, Arc<AppState>>) -> Result<Vec<Folder>> {
    state.db.with(col::list_folders)
}

#[tauri::command]
pub async fn create_collection(
    state: State<'_, Arc<AppState>>,
    name: String,
    color: Option<String>,
) -> Result<Collection> {
    state
        .db
        .with(|conn| col::create(conn, &name, color.as_deref()))
}

#[tauri::command]
pub async fn create_smart_collection(
    state: State<'_, Arc<AppState>>,
    name: String,
    color: Option<String>,
    filter: LibraryFilter,
) -> Result<Collection> {
    state
        .db
        .with(|conn| col::create_smart(conn, &name, color.as_deref(), &filter))
}

#[tauri::command]
pub async fn rename_collection(
    state: State<'_, Arc<AppState>>,
    id: i64,
    name: String,
) -> Result<()> {
    state.db.with(|conn| col::rename(conn, id, &name))
}

#[tauri::command]
pub async fn set_collection_color(
    state: State<'_, Arc<AppState>>,
    id: i64,
    color: String,
) -> Result<()> {
    state.db.with(|conn| col::set_color(conn, id, &color))
}

#[tauri::command]
pub async fn move_collection(
    state: State<'_, Arc<AppState>>,
    id: i64,
    folder_id: Option<i64>,
    position: i64,
) -> Result<()> {
    state
        .db
        .with(|conn| col::move_to(conn, id, folder_id, position))
}

#[tauri::command]
pub async fn duplicate_collection(
    state: State<'_, Arc<AppState>>,
    id: i64,
) -> Result<Collection> {
    state.db.with_tx(|tx| col::duplicate(tx, id))
}

#[tauri::command]
pub async fn delete_collection(state: State<'_, Arc<AppState>>, id: i64) -> Result<()> {
    state.db.with(|conn| col::delete(conn, id))
}

#[tauri::command]
pub async fn add_to_collection(
    state: State<'_, Arc<AppState>>,
    collection_id: i64,
    beatmap_ids: Vec<i64>,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| col::add_beatmaps(tx, collection_id, &beatmap_ids))
}

#[tauri::command]
pub async fn remove_from_collection(
    state: State<'_, Arc<AppState>>,
    collection_id: i64,
    beatmap_ids: Vec<i64>,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| col::remove_beatmaps(tx, collection_id, &beatmap_ids))
}

#[tauri::command]
pub async fn create_folder(state: State<'_, Arc<AppState>>, name: String) -> Result<Folder> {
    state.db.with(|conn| col::create_folder(conn, &name))
}

#[tauri::command]
pub async fn rename_folder(
    state: State<'_, Arc<AppState>>,
    id: i64,
    name: String,
) -> Result<()> {
    state.db.with(|conn| col::rename_folder(conn, id, &name))
}

#[tauri::command]
pub async fn delete_folder(state: State<'_, Arc<AppState>>, id: i64) -> Result<()> {
    state.db.with(|conn| col::delete_folder(conn, id))
}
