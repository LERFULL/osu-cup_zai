use std::sync::Arc;

use tauri::State;

use crate::db::matches as db;
use crate::error::Result;
use crate::model::{EditImpact, MatchState};
use crate::state::AppState;

/// Экран матча целиком: строки маппула, журнал, чей ход.
#[tauri::command]
pub async fn match_state(state: State<'_, Arc<AppState>>, id: i64) -> Result<MatchState> {
    state.db.with(|conn| Ok(db::state(conn, id)?))
}

#[tauri::command]
pub async fn set_match_pool(
    state: State<'_, Arc<AppState>>,
    id: i64,
    pool_id: Option<i64>,
) -> Result<MatchState> {
    state.db.with_tx(|tx| {
        db::set_pool(tx, id, pool_id)?;
        Ok(db::state(tx, id)?)
    })
}

#[tauri::command]
pub async fn set_match_first_ban(
    state: State<'_, Arc<AppState>>,
    id: i64,
    player_id: i64,
) -> Result<MatchState> {
    state.db.with_tx(|tx| {
        db::set_first_ban(tx, id, player_id)?;
        Ok(db::state(tx, id)?)
    })
}

#[tauri::command]
pub async fn ban_slot(
    state: State<'_, Arc<AppState>>,
    id: i64,
    slot_label: String,
) -> Result<MatchState> {
    state.db.with_tx(|tx| {
        db::ban(tx, id, &slot_label)?;
        Ok(db::state(tx, id)?)
    })
}

#[tauri::command]
pub async fn pick_slot(
    state: State<'_, Arc<AppState>>,
    id: i64,
    slot_label: String,
) -> Result<MatchState> {
    state.db.with_tx(|tx| {
        db::pick(tx, id, &slot_label)?;
        Ok(db::state(tx, id)?)
    })
}

#[tauri::command]
pub async fn record_result(
    state: State<'_, Arc<AppState>>,
    id: i64,
    winner_id: i64,
) -> Result<MatchState> {
    state.db.with_tx(|tx| {
        db::result(tx, id, winner_id)?;
        Ok(db::state(tx, id)?)
    })
}

#[tauri::command]
pub async fn undo_match_action(state: State<'_, Arc<AppState>>, id: i64) -> Result<MatchState> {
    state.db.with_tx(|tx| {
        db::undo(tx, id)?;
        Ok(db::state(tx, id)?)
    })
}

#[tauri::command]
pub async fn set_match_walkover(
    state: State<'_, Arc<AppState>>,
    id: i64,
    winner_id: i64,
    emergency: bool,
) -> Result<MatchState> {
    state.db.with_tx(|tx| {
        db::walkover(tx, id, winner_id, emergency)?;
        Ok(db::state(tx, id)?)
    })
}

/// Ручной счёт — на случай, когда матч сыграли не через приложение.
#[tauri::command]
pub async fn set_match_manual_result(
    state: State<'_, Arc<AppState>>,
    id: i64,
    winner_id: i64,
    score_a: i64,
    score_b: i64,
    emergency: bool,
) -> Result<MatchState> {
    state.db.with_tx(|tx| {
        db::set_manual_result(tx, id, winner_id, score_a, score_b, emergency)?;
        Ok(db::state(tx, id)?)
    })
}

/// Что случится, если снести результат матча. Считается до правки, а не
/// показывается после неё.
#[tauri::command]
pub async fn match_impact(state: State<'_, Arc<AppState>>, id: i64) -> Result<EditImpact> {
    state.db.with(|conn| Ok(db::impact(conn, id)?))
}

/// Снос результата: матч возвращается в ожидание, сетка ниже сбрасывается.
#[tauri::command]
pub async fn reset_match(
    state: State<'_, Arc<AppState>>,
    id: i64,
    emergency: bool,
) -> Result<MatchState> {
    state.db.with_tx(|tx| {
        db::reset(tx, id, emergency)?;
        Ok(db::state(tx, id)?)
    })
}

/// Замена участника в конкретном месте сетки.
#[tauri::command]
pub async fn replace_match_player(
    state: State<'_, Arc<AppState>>,
    id: i64,
    slot: String,
    player_id: i64,
    emergency: bool,
) -> Result<MatchState> {
    state.db.with_tx(|tx| {
        db::replace_player(tx, id, &slot, player_id, emergency)?;
        Ok(db::state(tx, id)?)
    })
}
