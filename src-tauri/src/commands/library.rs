use std::sync::Arc;

use tauri::State;

use crate::db::beatmaps;
use crate::error::Result;
use crate::model::{Beatmap, BeatmapAttributes, Label, LibraryFilter, LibrarySummary, Page};
use crate::state::AppState;

#[tauri::command]
pub async fn list_beatmaps(
    state: State<'_, Arc<AppState>>,
    filter: LibraryFilter,
    offset: i64,
    limit: i64,
) -> Result<Page<Beatmap>> {
    state
        .db
        .with(|conn| beatmaps::list(conn, &filter, offset, limit))
}

/// Счётчик раздела «Без мод-тегов» в дереве коллекций.
#[tauri::command]
pub async fn count_without_mods(state: State<'_, Arc<AppState>>) -> Result<i64> {
    state.db.with(beatmaps::count_without_mods)
}

/// Из чего состоит то, что сейчас на экране: моды, звёзды, длина, BPM.
#[tauri::command]
pub async fn library_summary(
    state: State<'_, Arc<AppState>>,
    filter: LibraryFilter,
) -> Result<LibrarySummary> {
    state.db.with(|conn| beatmaps::summary(conn, &filter))
}

#[tauri::command]
pub async fn get_beatmap(
    state: State<'_, Arc<AppState>>,
    beatmap_id: i64,
) -> Result<Option<Beatmap>> {
    state.db.with(|conn| beatmaps::get(conn, beatmap_id))
}

#[tauri::command]
pub async fn get_set_difficulties(
    state: State<'_, Arc<AppState>>,
    beatmapset_id: i64,
) -> Result<Vec<Beatmap>> {
    state
        .db
        .with(|conn| beatmaps::set_difficulties(conn, beatmapset_id))
}

#[tauri::command]
pub async fn get_attributes(
    state: State<'_, Arc<AppState>>,
    beatmap_id: i64,
) -> Result<Vec<BeatmapAttributes>> {
    state
        .db
        .with(|conn| beatmaps::get_attributes(conn, beatmap_id))
}

#[tauri::command]
pub async fn delete_beatmaps(
    state: State<'_, Arc<AppState>>,
    beatmap_ids: Vec<i64>,
) -> Result<()> {
    state.db.with_tx(|tx| beatmaps::delete(tx, &beatmap_ids))
}

#[tauri::command]
pub async fn set_beatmap_mods(
    state: State<'_, Arc<AppState>>,
    beatmap_id: i64,
    mods: Vec<String>,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| beatmaps::set_mods(tx, beatmap_id, &mods))
}

#[tauri::command]
pub async fn set_beatmap_fm_mods(
    state: State<'_, Arc<AppState>>,
    beatmap_id: i64,
    mods: Vec<String>,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| beatmaps::set_fm_mods(tx, beatmap_id, &mods))
}

#[tauri::command]
pub async fn set_beatmap_skillsets(
    state: State<'_, Arc<AppState>>,
    beatmap_id: i64,
    skillsets: Vec<String>,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| beatmaps::set_skillsets(tx, beatmap_id, &skillsets))
}

#[tauri::command]
pub async fn set_beatmap_note(
    state: State<'_, Arc<AppState>>,
    beatmap_id: i64,
    note: String,
) -> Result<()> {
    state
        .db
        .with(|conn| beatmaps::set_note(conn, beatmap_id, &note))
}

#[tauri::command]
pub async fn bulk_add_mod(
    state: State<'_, Arc<AppState>>,
    beatmap_ids: Vec<i64>,
    r#mod: String,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| beatmaps::bulk_add_mod(tx, &beatmap_ids, &r#mod))
}

#[tauri::command]
pub async fn bulk_add_skillset(
    state: State<'_, Arc<AppState>>,
    beatmap_ids: Vec<i64>,
    skillset: String,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| beatmaps::bulk_add_skillset(tx, &beatmap_ids, &skillset))
}

// ─────────────────────────────────────────────────────────────── метки

#[tauri::command]
pub async fn list_labels(state: State<'_, Arc<AppState>>) -> Result<Vec<Label>> {
    state.db.with(crate::db::labels::list)
}

#[tauri::command]
pub async fn create_label(
    state: State<'_, Arc<AppState>>,
    name: String,
    color: Option<String>,
) -> Result<Label> {
    state
        .db
        .with(|conn| crate::db::labels::create(conn, &name, color.as_deref()))
}

#[tauri::command]
pub async fn set_beatmap_labels(
    state: State<'_, Arc<AppState>>,
    beatmap_id: i64,
    label_ids: Vec<i64>,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| crate::db::labels::set_for_beatmap(tx, beatmap_id, &label_ids))
}

#[tauri::command]
pub async fn bulk_add_label(
    state: State<'_, Arc<AppState>>,
    beatmap_ids: Vec<i64>,
    label_id: i64,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| crate::db::labels::bulk_add(tx, &beatmap_ids, label_id))
}
