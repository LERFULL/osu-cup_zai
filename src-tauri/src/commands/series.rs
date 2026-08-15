//! Команды серий маппулов.
//!
//! Часть команд возвращает `Vec<PoolOverlap>` вместо ошибки: включить
//! «не повторять внутри серии» или перетащить в неё пул с чужими картами —
//! это не сбой, а выбор. Пустой список значит «сделано», непустой — «так
//! нельзя, вот что мешает», и решает пользователь.

use std::sync::Arc;

use tauri::State;

use crate::db::{generate, pools as pool_db, series as series_db};
use crate::error::Result;
use crate::model::{GenReport, PoolOverlap, Series, SeriesStats, SourceSet};
use crate::state::AppState;

#[tauri::command]
pub async fn list_series(state: State<'_, Arc<AppState>>) -> Result<Vec<Series>> {
    state.db.with(series_db::list)
}

#[tauri::command]
pub async fn get_series(state: State<'_, Arc<AppState>>, id: i64) -> Result<Series> {
    state.db.with(|conn| series_db::get(conn, id))
}

#[tauri::command]
pub async fn create_series(
    state: State<'_, Arc<AppState>>,
    name: String,
    kind: String,
) -> Result<Series> {
    state.db.with_tx(|tx| {
        let id = series_db::create(tx, &name, &kind)?;
        series_db::get(tx, id)
    })
}

#[tauri::command]
pub async fn rename_series(
    state: State<'_, Arc<AppState>>,
    id: i64,
    name: String,
) -> Result<()> {
    state.db.with(|conn| series_db::rename(conn, id, &name))
}

#[tauri::command]
pub async fn set_series_color(
    state: State<'_, Arc<AppState>>,
    id: i64,
    color: Option<String>,
) -> Result<()> {
    state
        .db
        .with(|conn| series_db::set_color(conn, id, color.as_deref()))
}

#[tauri::command]
pub async fn set_series_note(
    state: State<'_, Arc<AppState>>,
    id: i64,
    note: Option<String>,
) -> Result<()> {
    state
        .db
        .with(|conn| series_db::set_note(conn, id, note.as_deref()))
}

/// Смена типа. Обратно в турнирную — только если между пулами нет повторов:
/// иначе возвращается их список, а тип остаётся прежним.
#[tauri::command]
pub async fn set_series_kind(
    state: State<'_, Arc<AppState>>,
    id: i64,
    kind: String,
) -> Result<Vec<PoolOverlap>> {
    state.db.with_tx(|tx| series_db::set_kind(tx, id, &kind))
}

#[tauri::command]
pub async fn set_series_no_repeat(
    state: State<'_, Arc<AppState>>,
    id: i64,
    value: bool,
) -> Result<Vec<PoolOverlap>> {
    state
        .db
        .with_tx(|tx| series_db::set_no_repeat_inside(tx, id, value))
}

#[tauri::command]
pub async fn set_series_sources(
    state: State<'_, Arc<AppState>>,
    id: i64,
    sources: Option<SourceSet>,
) -> Result<Series> {
    state.db.with_tx(|tx| {
        series_db::set_sources(tx, id, sources.as_ref())?;
        series_db::get(tx, id)
    })
}

/// Значение по умолчанию для строк пулов серии. `null` — своего нет.
#[tauri::command]
pub async fn set_series_display_fields(
    state: State<'_, Arc<AppState>>,
    id: i64,
    fields: Option<Vec<String>>,
) -> Result<()> {
    state
        .db
        .with(|conn| series_db::set_display_fields(conn, id, fields.as_deref()))
}

#[tauri::command]
pub async fn duplicate_series(state: State<'_, Arc<AppState>>, id: i64) -> Result<Series> {
    state.db.with_tx(|tx| {
        let new_id = series_db::duplicate(tx, id)?;
        series_db::get(tx, new_id)
    })
}

/// Удаление серии не удаляет маппулы: они возвращаются в общий список.
#[tauri::command]
pub async fn delete_series(state: State<'_, Arc<AppState>>, id: i64) -> Result<()> {
    state.db.with_tx(|tx| series_db::delete(tx, id))
}

#[tauri::command]
pub async fn reorder_series(state: State<'_, Arc<AppState>>, ids: Vec<i64>) -> Result<()> {
    state.db.with_tx(|tx| series_db::reorder(tx, &ids))
}

// ────────────────────────────────────────────────────────────── состав

/// Пул входит в серию. Непустой ответ — повторы, из-за которых перенос
/// не выполнен.
#[tauri::command]
pub async fn add_pool_to_series(
    state: State<'_, Arc<AppState>>,
    series_id: i64,
    pool_id: i64,
) -> Result<Vec<PoolOverlap>> {
    state
        .db
        .with_tx(|tx| series_db::add_pool(tx, series_id, pool_id))
}

#[tauri::command]
pub async fn remove_pool_from_series(
    state: State<'_, Arc<AppState>>,
    pool_id: i64,
) -> Result<()> {
    state.db.with_tx(|tx| series_db::remove_pool(tx, pool_id))
}

#[tauri::command]
pub async fn reorder_series_pools(
    state: State<'_, Arc<AppState>>,
    series_id: i64,
    pool_ids: Vec<i64>,
) -> Result<Series> {
    state.db.with_tx(|tx| {
        series_db::reorder_pools(tx, series_id, &pool_ids)?;
        series_db::get(tx, series_id)
    })
}

#[tauri::command]
pub async fn set_series_pool_label(
    state: State<'_, Arc<AppState>>,
    pool_id: i64,
    label: Option<String>,
) -> Result<()> {
    state
        .db
        .with(|conn| series_db::set_pool_label(conn, pool_id, label.as_deref()))
}

// ─────────────────────────────────────────────────────── статистика

#[tauri::command]
pub async fn series_stats(state: State<'_, Arc<AppState>>, id: i64) -> Result<SeriesStats> {
    state.db.with(|conn| series_db::stats(conn, id))
}

#[tauri::command]
pub async fn series_repeats(
    state: State<'_, Arc<AppState>>,
    id: i64,
) -> Result<Vec<PoolOverlap>> {
    state.db.with(|conn| series_db::repeats(conn, id))
}

// ─────────────────────────────────────────────────────── генерация

/// Серия под турнир: создаётся сама серия и `count` пулов в ней. Карты
/// внутри серии не повторяются.
#[tauri::command]
pub async fn generate_series(
    state: State<'_, Arc<AppState>>,
    template_id: i64,
    name: String,
    count: i64,
) -> Result<Vec<GenReport>> {
    state
        .db
        .with_tx(|tx| generate::generate_series(tx, template_id, &name, count))
}

/// Скатать серию целиком. Пулы катаются по позиции, карты каждого следующего
/// вычитаются из набора для остальных.
#[tauri::command]
pub async fn roll_series(
    state: State<'_, Arc<AppState>>,
    series_id: i64,
    keep_pinned: bool,
) -> Result<Vec<GenReport>> {
    state
        .db
        .with_tx(|tx| generate::roll_series(tx, series_id, keep_pinned))
}

/// Перекатить карту в последнем пуле, где она встретилась, — кнопка из блока
/// повторов. Слот ищется по карте: его позиция известна только базе.
#[tauri::command]
pub async fn reroll_repeat(
    state: State<'_, Arc<AppState>>,
    pool_id: i64,
    beatmap_id: i64,
) -> Result<GenReport> {
    state.db.with_tx(|tx| {
        let pool = pool_db::get(tx, pool_id)?;
        let positions: Vec<i64> = pool
            .slots
            .iter()
            .filter(|s| s.beatmap_id == Some(beatmap_id))
            .map(|s| s.position)
            .collect();
        generate::reroll_slots(tx, pool_id, &positions)
    })
}
