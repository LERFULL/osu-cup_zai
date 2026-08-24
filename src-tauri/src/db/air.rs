//! Что эфир хранит в базе.
//!
//! Хранится ровно то, что должно пережить перезапуск: настройки эфира этого
//! турнира, счётчик показов сцен и номер лобби у матча. Само состояние кадра
//! здесь не лежит — оно живёт в памяти, потому что после перезапуска эфира
//! показывать вчерашний кадр незачем.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::now_iso;

/// Сколько раз сцена выходила в эфир в этом турнире.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneShow {
    pub scene_id: String,
    /// Для сцен «по объекту» — игрок или пара. Пусто у обычных.
    pub object_key: String,
    pub shows: i64,
    pub last_at: Option<String>,
}

/// Настройки эфира турнира. Пустая строка — настроек ещё нет.
pub fn config(conn: &Connection, tournament_id: i64) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT json FROM air_config WHERE tournament_id = ?1",
            params![tournament_id],
            |r| r.get::<_, String>(0),
        )
        .ok())
}

pub fn set_config(conn: &Connection, tournament_id: i64, json: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO air_config (tournament_id, json, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(tournament_id) DO UPDATE SET json = ?2, updated_at = ?3",
        params![tournament_id, json, now_iso()],
    )?;
    Ok(())
}

pub fn shows(conn: &Connection, tournament_id: i64) -> Result<Vec<SceneShow>> {
    let mut st = conn.prepare(
        "SELECT scene_id, object_key, shows, last_at
           FROM air_shows WHERE tournament_id = ?1
          ORDER BY scene_id, object_key",
    )?;
    let rows = st.query_map(params![tournament_id], |r| {
        Ok(SceneShow {
            scene_id: r.get(0)?,
            object_key: r.get(1)?,
            shows: r.get(2)?,
            last_at: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Отмечает показ. Время нужно правилу «дольше всех не показывалась»,
/// счётчик — правилу неповторяемости.
pub fn note_show(
    conn: &Connection,
    tournament_id: i64,
    scene_id: &str,
    object_key: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO air_shows (tournament_id, scene_id, object_key, shows, last_at)
         VALUES (?1, ?2, ?3, 1, ?4)
         ON CONFLICT(tournament_id, scene_id, object_key)
           DO UPDATE SET shows = shows + 1, last_at = ?4",
        params![tournament_id, scene_id, object_key, now_iso()],
    )?;
    Ok(())
}

/// Сбрасывает историю показов: турнир решили провести заново с теми же сценами.
pub fn clear_shows(conn: &Connection, tournament_id: i64) -> Result<()> {
    conn.execute(
        "DELETE FROM air_shows WHERE tournament_id = ?1",
        params![tournament_id],
    )?;
    Ok(())
}

/// Номер лобби матча. `None` — матч ведётся только судьёй.
pub fn set_lobby(conn: &Connection, match_id: i64, room_id: Option<i64>) -> Result<()> {
    if let Some(id) = room_id {
        anyhow::ensure!(id > 0, "номер лобби — это число из адреса матча osu!");
    }
    let changed = conn.execute(
        "UPDATE matches SET lobby_id = ?2 WHERE id = ?1",
        params![match_id, room_id],
    )?;
    anyhow::ensure!(changed == 1, "матча {match_id} нет");
    Ok(())
}

// ────────────────────────────────────────────────── профили osu!

/// Профиль игрока для сцен с цифрами.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsuProfile {
    pub osu_user_id: i64,
    pub username: Option<String>,
    pub pp: Option<f64>,
    pub global_rank: Option<i64>,
    pub country_rank: Option<i64>,
    pub country_code: Option<String>,
    /// Проценты, как их показывает профиль.
    pub accuracy: Option<f64>,
    pub play_count: Option<i64>,
}

/// Свежий профиль из кеша. Сутки — потому что за эфир ранг не меняется,
/// а бюджет запросов один на всё приложение.
pub fn cached_profile(conn: &Connection, osu_user_id: i64) -> Option<OsuProfile> {
    let json: String = conn
        .query_row(
            "SELECT json FROM osu_profiles
              WHERE osu_user_id = ?1
                AND julianday('now') - julianday(fetched_at) < 1.0",
            params![osu_user_id],
            |r| r.get(0),
        )
        .ok()?;
    serde_json::from_str(&json).ok()
}

pub fn save_profile(conn: &Connection, profile: &OsuProfile) -> Result<()> {
    conn.execute(
        "INSERT INTO osu_profiles (osu_user_id, json, fetched_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(osu_user_id) DO UPDATE SET json = ?2, fetched_at = ?3",
        params![
            profile.osu_user_id,
            serde_json::to_string(profile)?,
            now_iso()
        ],
    )?;
    Ok(())
}

