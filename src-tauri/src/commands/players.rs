use std::sync::Arc;

use tauri::State;

use crate::db::players as db;
use crate::error::Result;
use crate::model::{Player, PlayerStats};
use crate::state::AppState;

#[tauri::command]
pub async fn list_players(
    state: State<'_, Arc<AppState>>,
    include_archived: bool,
) -> Result<Vec<Player>> {
    state.db.with(|conn| Ok(db::list(conn, include_archived)?))
}

#[tauri::command]
pub async fn get_player(state: State<'_, Arc<AppState>>, id: i64) -> Result<Option<Player>> {
    state.db.with(|conn| Ok(db::get(conn, id)?))
}

#[tauri::command]
pub async fn create_player(
    state: State<'_, Arc<AppState>>,
    nickname: String,
    osu_user_id: Option<i64>,
) -> Result<Player> {
    state.db.with(|conn| {
        let id = db::create(conn, &nickname, osu_user_id, None)?;
        Ok(db::get(conn, id)?.expect("игрок только что создан"))
    })
}

#[tauri::command]
pub async fn update_player(
    state: State<'_, Arc<AppState>>,
    id: i64,
    nickname: String,
    osu_user_id: Option<i64>,
    color: String,
    note: Option<String>,
) -> Result<()> {
    state.db.with(|conn| {
        Ok(db::update(
            conn,
            id,
            &nickname,
            osu_user_id,
            &color,
            note.as_deref(),
        )?)
    })
}

#[tauri::command]
pub async fn archive_player(
    state: State<'_, Arc<AppState>>,
    id: i64,
    archived: bool,
) -> Result<()> {
    state.db.with(|conn| Ok(db::set_archived(conn, id, archived)?))
}

#[tauri::command]
pub async fn delete_player(state: State<'_, Arc<AppState>>, id: i64) -> Result<()> {
    state.db.with(|conn| Ok(db::delete(conn, id)?))
}

#[tauri::command]
pub async fn player_stats(state: State<'_, Arc<AppState>>, id: i64) -> Result<PlayerStats> {
    state.db.with(|conn| Ok(db::stats(conn, id)?))
}
