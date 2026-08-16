use std::sync::Arc;

use tauri::State;

use crate::db::tournaments as db;
use crate::error::Result;
use crate::model::{Bracket, ByRound, EditorState, PoolOverlap, Tournament};
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
    emergency: bool,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| Ok(db::add_player(tx, id, player_id, emergency)?))
}

#[tauri::command]
pub async fn remove_tournament_player(
    state: State<'_, Arc<AppState>>,
    id: i64,
    player_id: i64,
    emergency: bool,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| Ok(db::remove_player(tx, id, player_id, emergency)?))
}

/// Сеяние задаётся порядком списка — так же, как порядок слотов в шаблоне.
#[tauri::command]
pub async fn set_tournament_seeds(
    state: State<'_, Arc<AppState>>,
    id: i64,
    order: Vec<i64>,
    emergency: bool,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| Ok(db::set_seeds(tx, id, &order, emergency)?))
}

/// Обмен местами в сетке: сеяние пересчитывается, место из него и следует.
#[tauri::command]
pub async fn swap_tournament_seeds(
    state: State<'_, Arc<AppState>>,
    id: i64,
    player_a: i64,
    player_b: i64,
    emergency: bool,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| Ok(db::swap_seeds(tx, id, player_a, player_b, emergency)?))
}

/// Сажает игрока на место сеяния, при необходимости добавив его в турнир.
#[tauri::command]
pub async fn place_tournament_player(
    state: State<'_, Arc<AppState>>,
    id: i64,
    player_id: i64,
    seed: i64,
    emergency: bool,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| Ok(db::place_player(tx, id, player_id, seed, emergency)?))
}

/// Случайное сеяние вместе с пересборкой сетки.
#[tauri::command]
pub async fn shuffle_tournament_seeds(
    state: State<'_, Arc<AppState>>,
    id: i64,
    emergency: bool,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| Ok(db::shuffle_seeds(tx, id, emergency)?))
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
        .with_tx(|tx| Ok(db::set_player_color(tx, id, player_id, &color)?))
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

/// Исключение по раунду: своё правило вместо общего. `null` — вернуть общее.
#[tauri::command]
pub async fn set_tournament_round_rule(
    state: State<'_, Arc<AppState>>,
    id: i64,
    key: String,
    target: Option<i64>,
    bans: Option<i64>,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| Ok(db::set_round_rule(tx, id, &key, target, bans)?))
}

/// Закрепляет маппул за раундом. `null` — «любой свободный».
#[tauri::command]
pub async fn set_tournament_round_pool(
    state: State<'_, Arc<AppState>>,
    id: i64,
    key: String,
    pool_id: Option<i64>,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| Ok(db::set_round_pool(tx, id, &key, pool_id)?))
}

/// Берёт маппулы серии по порядку и раскладывает по раундам.
#[tauri::command]
pub async fn add_tournament_series(
    state: State<'_, Arc<AppState>>,
    id: i64,
    series_id: i64,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| Ok(db::add_series(tx, id, series_id)?))
}

/// Преимущество сетки в гранд-финале.
#[tauri::command]
pub async fn set_tournament_grand_advantage(
    state: State<'_, Arc<AppState>>,
    id: i64,
    value: i64,
) -> Result<()> {
    state
        .db
        .with_tx(|tx| Ok(db::set_grand_advantage(tx, id, value)?))
}

/// Всё, что нужно колонке разделов: раунды, bye, проверки и журнал правок.
#[tauri::command]
pub async fn tournament_editor(state: State<'_, Arc<AppState>>, id: i64) -> Result<EditorState> {
    state.db.with(|conn| Ok(db::editor(conn, id)?))
}

/// Отменяет последнюю правку турнира.
#[tauri::command]
pub async fn undo_tournament_edit(state: State<'_, Arc<AppState>>, id: i64) -> Result<Bracket> {
    state.db.with_tx(|tx| {
        db::undo_last_edit(tx, id)?;
        Ok(db::bracket_of(tx, id)?)
    })
}

/// Строит сетку и показывает её на утверждение. Состав с этого момента
/// закрыт, но турнир ещё не идёт: сетку можно пересобрать или вернуть
/// в черновик.
#[tauri::command]
pub async fn start_tournament(state: State<'_, Arc<AppState>>, id: i64) -> Result<Bracket> {
    state.db.with_tx(|tx| {
        db::start(tx, id)?;
        Ok(db::bracket_of(tx, id)?)
    })
}

/// Утверждает сетку: матчи можно играть.
#[tauri::command]
pub async fn confirm_tournament(state: State<'_, Arc<AppState>>, id: i64) -> Result<Bracket> {
    state.db.with_tx(|tx| {
        db::confirm(tx, id)?;
        Ok(db::bracket_of(tx, id)?)
    })
}

/// Возвращает турнир в черновик и стирает несыгранную сетку.
#[tauri::command]
pub async fn reopen_tournament(state: State<'_, Arc<AppState>>, id: i64) -> Result<Bracket> {
    state.db.with_tx(|tx| {
        db::reopen(tx, id)?;
        Ok(db::bracket_of(tx, id)?)
    })
}

#[tauri::command]
pub async fn tournament_bracket(state: State<'_, Arc<AppState>>, id: i64) -> Result<Bracket> {
    state.db.with(|conn| Ok(db::bracket_of(conn, id)?))
}

/// Карты, попавшие сразу в несколько маппулов турнира.
///
/// Повтор внутри одного турнира — это карта, которая всплывёт в двух
/// матчах: следить за этим по строкам вручную невозможно.
#[tauri::command]
pub async fn tournament_pool_overlaps(
    state: State<'_, Arc<AppState>>,
    id: i64,
) -> Result<Vec<PoolOverlap>> {
    state.db.with(|conn| {
        let pool_ids = db::pools_of(conn, id)?;
        Ok(crate::db::pools::overlaps_between_pools(conn, &pool_ids)?)
    })
}

#[tauri::command]
pub async fn finish_tournament(state: State<'_, Arc<AppState>>, id: i64) -> Result<Tournament> {
    state.db.with_tx(|tx| {
        db::finish(tx, id)?;
        Ok(db::get(tx, id)?)
    })
}
