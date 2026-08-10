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

/// Тянет аватар с osu! по ID профиля и запоминает путь к файлу.
///
/// Отдельной командой, а не побочным действием сохранения: сеть может
/// быть недоступна, и это не повод отказываться сохранять игрока.
#[tauri::command]
pub async fn fetch_player_avatar(state: State<'_, Arc<AppState>>, id: i64) -> Result<Player> {
    let osu_user_id = state.db.with(|conn| {
        let player = db::get(conn, id)?;
        Ok(player.and_then(|p| p.osu_user_id))
    })?;

    let Some(osu_user_id) = osu_user_id else {
        return Err(crate::error::AppError::Other(
            "У игрока не указан ID профиля osu!".into(),
        ));
    };

    let bytes = state.osu.download_avatar(osu_user_id).await?;
    let path = state.covers.put_avatar(osu_user_id, &bytes)?;
    let path = path.to_string_lossy().to_string();

    state.db.with(|conn| {
        db::set_avatar_path(conn, id, Some(&path))?;
        Ok(db::get(conn, id)?.expect("игрок только что читался"))
    })
}

/// Аватар в профиле меняют когда угодно, поэтому раз в несколько дней
/// перекачиваем его сами. Молча: обновление аватаров — не то, ради чего
/// стоит показывать ошибку, если интернета сейчас нет.
const AVATAR_STALE_DAYS: u64 = 7;

/// Обновляет аватары, которым больше недели, и подтягивает недостающие.
/// Возвращает список игроков — уже с новыми путями.
#[tauri::command]
pub async fn refresh_player_avatars(
    state: State<'_, Arc<AppState>>,
    include_archived: bool,
) -> Result<Vec<Player>> {
    let players = state.db.with(|conn| Ok(db::list(conn, include_archived)?))?;

    for p in &players {
        let Some(osu_user_id) = p.osu_user_id else {
            continue;
        };

        let stale = match state.covers.avatar_age_days(osu_user_id) {
            None => true,
            Some(days) => days >= AVATAR_STALE_DAYS,
        };
        if !stale && p.avatar_path.is_some() {
            continue;
        }

        // Сеть могла отвалиться — это не повод ронять весь список.
        let Ok(bytes) = state.osu.download_avatar(osu_user_id).await else {
            continue;
        };
        let Ok(path) = state.covers.put_avatar(osu_user_id, &bytes) else {
            continue;
        };

        let path = path.to_string_lossy().to_string();
        let _ = state
            .db
            .with(|conn| Ok(db::set_avatar_path(conn, p.id, Some(&path))?));
    }

    state.db.with(|conn| Ok(db::list(conn, include_archived)?))
}
