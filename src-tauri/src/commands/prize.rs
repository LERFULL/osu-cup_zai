//! Команды призового фонда. Сигнатуры зеркалят `src/lib/ipc.ts`.

use std::sync::Arc;

use tauri::State;

use crate::db::prize as db;
use crate::error::Result;
use crate::model::{PrizeConfig, PrizeView};
use crate::state::AppState;

/// Фонд турнира с сохранённым конфигом. `None` — фонда нет.
#[tauri::command]
pub async fn prize_state(
    state: State<'_, Arc<AppState>>,
    id: i64,
) -> Result<Option<PrizeView>> {
    state.db.with(|conn| Ok(db::state(conn, id)?))
}

/// Взгляд на фонд с непосохранённым конфигом: редактор пересчитывает
/// проверку лестницы на каждую правку, а не по кнопке.
#[tauri::command]
pub async fn prize_preview(
    state: State<'_, Arc<AppState>>,
    id: i64,
    config: PrizeConfig,
) -> Result<PrizeView> {
    state.db.with(|conn| Ok(db::view(conn, id, &config)?))
}

/// Записать конфиг фонда. Фонд нуля снимает его вовсе.
#[tauri::command]
pub async fn set_tournament_prize(
    state: State<'_, Arc<AppState>>,
    id: i64,
    config: PrizeConfig,
    emergency: bool,
) -> Result<PrizeView> {
    state.db.with(|conn| {
        db::set_config(conn, id, &config, emergency)?;
        Ok(db::view(conn, id, &config)?)
    })
}

/// Галочка новичка для гонки.
#[tauri::command]
pub async fn set_player_rookie(
    state: State<'_, Arc<AppState>>,
    id: i64,
    player_id: i64,
    rookie: bool,
) -> Result<()> {
    state.db.with(|conn| Ok(db::set_rookie(conn, id, player_id, rookie)?))
}

/// Отметить лучший матч для зрительского банка.
#[tauri::command]
pub async fn set_best_match(
    state: State<'_, Arc<AppState>>,
    id: i64,
    match_id: Option<i64>,
) -> Result<()> {
    state.db.with(|conn| Ok(db::set_best_match(conn, id, match_id)?))
}

/// Переходящий джекпот приложения: живая цифра в анонсе следующего турнира.
#[tauri::command]
pub async fn jackpot_value(state: State<'_, Arc<AppState>>) -> Result<i64> {
    state
        .db
        .with(|conn| Ok(db::kv_get(conn, "jackpot").and_then(|v| v.parse().ok()).unwrap_or(0)))
}
