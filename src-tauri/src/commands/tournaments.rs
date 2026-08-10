use std::sync::Arc;

use tauri::State;

use crate::db::tournaments as db;
use crate::error::Result;
use crate::model::{Bracket, ByRound, Tournament};
use crate::state::AppState;

#[tauri::command]
pub async fn list_tournaments(state: State<'_, Arc<AppState>>) -> Result<Vec<Tournament>> {
    state.db.with(|conn| Ok(db::list(conn)?))
}

#[tauri::command]
pub async fn get_tournament(state: State<'_, Arc<AppState>>, id: i64) -> Result<Tournament> {
    state.db.with(|conn| Ok(db::get(conn, id)?))
}

#[tauri::command]
pub async fn create_tournament(
    state: State<'_, Arc<AppState>>,
    name: String,
    target_score: i64,
    bans_per_round: i64,
) -> Result<Tournament> {
    state.db.with(|conn| {
        let id = db::create(conn, &name, target_score, bans_per_round)?;
        Ok(db::get(conn, id)?)
    })
}

#[tauri::command]
pub async fn rename_tournament(
    state: State<'_, Arc<AppState>>,
    id: i64,
    name: String,
) -> Result<()> {
    state.db.with(|conn| Ok(db::rename(conn, id, &name)?))
}

/// Правила матчей: до скольких побед, сколько банов, кто банит первым.
#[tauri::command]
pub async fn set_tournament_rules(
    state: State<'_, Arc<AppState>>,
    id: i64,
    target_score: ByRound,
    bans_per_round: ByRound,
    first_ban: String,
    no_repeat_pool: bool,
) -> Result<Tournament> {
    state.db.with(|conn| {
        db::set_rules(
            conn,
            id,
            &target_score,
            &bans_per_round,
            &first_ban,
            no_repeat_pool,
        )?;
        Ok(db::get(conn, id)?)
    })
}

#[tauri::command]
pub async fn delete_tournament(state: State<'_, Arc<AppState>>, id: i64) -> Result<()> {
    state.db.with(|conn| Ok(db::delete(conn, id)?))
}

#[tauri::command]
pub async fn add_tournament_player(
    state: State<'_, Arc<AppState>>,
    id: i64,
    player_id: i64,
) -> Result<()> {
    state
        .db
        .with(|conn| Ok(db::add_player(conn, id, player_id)?))
}

#[tauri::command]
pub async fn remove_tournament_player(
    state: State<'_, Arc<AppState>>,
    id: i64,
    player_id: i64,
) -> Result<()> {
    state
        .db
        .with(|conn| Ok(db::remove_player(conn, id, player_id)?))
}

/// Сеяние задаётся порядком списка — так же, как порядок слотов в шаблоне.
#[tauri::command]
pub async fn set_tournament_seeds(
    state: State<'_, Arc<AppState>>,
    id: i64,
    order: Vec<i64>,
) -> Result<()> {
    state.db.with_tx(|tx| Ok(db::set_seeds(tx, id, &order)?))
}

#[tauri::command]
pub async fn set_tournament_player_color(
    state: State<'_, Arc<AppState>>,
    id: i64,
    player_id: i64,
    color: String,
) -> Result<()> {
    state
        .db
        .with(|conn| Ok(db::set_player_color(conn, id, player_id, &color)?))
}

#[tauri::command]
pub async fn set_tournament_pools(
    state: State<'_, Arc<AppState>>,
    id: i64,
    pool_ids: Vec<i64>,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| Ok(db::set_pools(tx, id, &pool_ids)?))
}

/// Строит сетку. С этого момента состав участников закрыт.
#[tauri::command]
pub async fn start_tournament(state: State<'_, Arc<AppState>>, id: i64) -> Result<Bracket> {
    state.db.with_tx(|tx| {
        db::start(tx, id)?;
        Ok(db::bracket_of(tx, id)?)
    })
}

#[tauri::command]
pub async fn tournament_bracket(state: State<'_, Arc<AppState>>, id: i64) -> Result<Bracket> {
    state.db.with(|conn| Ok(db::bracket_of(conn, id)?))
}

#[tauri::command]
pub async fn finish_tournament(state: State<'_, Arc<AppState>>, id: i64) -> Result<Tournament> {
    state.db.with_tx(|tx| {
        db::finish(tx, id)?;
        Ok(db::get(tx, id)?)
    })
}
