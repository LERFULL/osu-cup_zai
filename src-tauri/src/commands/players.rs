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
    state
        .db
        .with(|conn| Ok(db::set_archived(conn, id, archived)?))
}

#[tauri::command]
pub async fn delete_player(state: State<'_, Arc<AppState>>, id: i64) -> Result<()> {
    state.db.with(|conn| Ok(db::delete(conn, id)?))
}

/// Объединение дубля: все матчи, действия и участия `mergeId` переходят на
/// `keepId`, дубль уходит в архив. Возвращает обновлённого keep-игрока —
/// статистика у него уже пересчиталась, она вся живёт запросами.
#[tauri::command]
pub async fn merge_players(
    state: State<'_, Arc<AppState>>,
    keep_id: i64,
    merge_id: i64,
) -> Result<Player> {
    state.db.with_tx(|tx| Ok(db::merge(tx, keep_id, merge_id)?))
}

#[tauri::command]
pub async fn player_stats(state: State<'_, Arc<AppState>>, id: i64) -> Result<PlayerStats> {
    state.db.with(|conn| Ok(db::stats(conn, id)?))
}

/// Расширенный профиль osu! игрока: pp, ранги, уровень, оценки, команда.
///
/// Тянется не чаще раза в сутки, между этим — из кеша. `refresh` позволяет
/// перечитать силой: кнопка «Обновить» в карточке. Сетевая ошибка не роняет
/// карточку, если профиль уже лежит в кеше пусть и старый.
#[tauri::command]
pub async fn player_osu_profile(
    state: State<'_, Arc<AppState>>,
    id: i64,
    refresh: Option<bool>,
) -> Result<crate::model::PlayerOsuProfileWithHistory> {
    let osu_user_id = state
        .db
        .with(|conn| Ok(db::get(conn, id)?.and_then(|p| p.osu_user_id)))?;

    let Some(osu_user_id) = osu_user_id else {
        // Игрок без привязки к osu! — карточка покажет внутреннюю статистику.
        return Ok(crate::model::PlayerOsuProfileWithHistory {
            profile: None,
            history: vec![],
        });
    };

    let force = refresh.unwrap_or(false);
    let cached = if force {
        None
    } else {
        state
            .db
            .with(|conn| Ok(db::cached_user_profile(conn, osu_user_id)?))?
    };

    let profile = match cached {
        Some(p) => Some(p),
        None => {
            let fetched = match state.credentials() {
                Ok(creds) => {
                    state.limiter.acquire().await;
                    match state.osu.user(&creds, osu_user_id).await {
                        Ok(dto) => Ok(crate::osu::to_player_profile(dto)),
                        Err(e) => Err(e),
                    }
                }
                Err(e) => Err(e),
            };

            match fetched {
                Ok(profile) => {
                    state
                        .db
                        .with(|conn| Ok(db::save_user_profile(conn, &profile)?))?;
                    Some(profile)
                }
                // Свежего нет, но старый кеш лучше пустоты: карточка
                // останется читаемой даже без интернета.
                Err(_) => state
                    .db
                    .with(|conn| Ok(db::user_profile_any_age(conn, osu_user_id)?))?,
            }
        }
    };

    let history = state
        .db
        .with(|conn| Ok(db::snapshots(conn, osu_user_id)?))?;

    Ok(crate::model::PlayerOsuProfileWithHistory { profile, history })
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
    let players = state
        .db
        .with(|conn| Ok(db::list(conn, include_archived)?))?;

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
