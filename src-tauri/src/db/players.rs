//! Игроки и их статистика.
//!
//! Всё, что можно посчитать из истории матчей, здесь и считается: никаких
//! накопительных счётчиков в базе, чтобы правка результата задним числом
//! не оставляла расхождений.

use anyhow::Result;
use rusqlite::{params, Connection};

use crate::model::{Player, PlayerStats, PlayerVersus};

fn row_to_player(row: &rusqlite::Row) -> rusqlite::Result<Player> {
    Ok(Player {
        id: row.get("id")?,
        nickname: row.get("nickname")?,
        osu_user_id: row.get("osu_user_id")?,
        color: row.get("color")?,
        avatar_path: row.get("avatar_path")?,
        note: row.get("note")?,
        is_archived: row.get::<_, i64>("is_archived")? != 0,
        created_at: row.get("created_at")?,
    })
}

const COLS: &str = "id, nickname, osu_user_id, color, avatar_path, note, is_archived, created_at";

/// Палитра для новых игроков: берётся по кругу, чтобы соседи в списке
/// не сливались. Те же цвета предлагает карточка игрока — при правке
/// менять оба места.
const PALETTE: [&str; 8] = [
    "#ff6fb1", "#5bc8f5", "#7ed957", "#ffd03b", "#c77dff", "#ff6b6b", "#4dd6c1", "#f7913d",
];

/// Первый цвет палитры, который ещё не занят. Если заняты все, берём по
/// кругу: совпадение лучше, чем отказ добавить игрока.
pub fn free_color(conn: &Connection, taken: &[String]) -> String {
    PALETTE
        .iter()
        .find(|c| !taken.iter().any(|t| t.eq_ignore_ascii_case(c)))
        .map(|c| c.to_string())
        .unwrap_or_else(|| {
            let total: i64 = conn
                .query_row("SELECT COUNT(*) FROM players", [], |r| r.get(0))
                .unwrap_or(0);
            PALETTE[total as usize % PALETTE.len()].to_string()
        })
}

pub fn list(conn: &Connection, include_archived: bool) -> Result<Vec<Player>> {
    let sql = format!(
        "SELECT {COLS} FROM players {} ORDER BY is_archived, nickname COLLATE NOCASE",
        if include_archived {
            ""
        } else {
            "WHERE is_archived = 0"
        }
    );
    let mut st = conn.prepare(&sql)?;
    let rows = st.query_map([], row_to_player)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<Player>> {
    let sql = format!("SELECT {COLS} FROM players WHERE id = ?1");
    let mut st = conn.prepare(&sql)?;
    let mut rows = st.query_map(params![id], row_to_player)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn create(
    conn: &Connection,
    nickname: &str,
    osu_user_id: Option<i64>,
    color: Option<&str>,
) -> Result<i64> {
    let nickname = nickname.trim();
    anyhow::ensure!(!nickname.is_empty(), "у игрока должен быть ник");

    let taken: i64 = conn.query_row("SELECT COUNT(*) FROM players", [], |r| r.get(0))?;
    let color = color
        .map(|c| c.to_string())
        .unwrap_or_else(|| PALETTE[taken as usize % PALETTE.len()].to_string());

    conn.execute(
        "INSERT INTO players (nickname, osu_user_id, color, created_at)
         VALUES (?1, ?2, ?3, datetime('now'))",
        params![nickname, osu_user_id, color],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update(
    conn: &Connection,
    id: i64,
    nickname: &str,
    osu_user_id: Option<i64>,
    color: &str,
    note: Option<&str>,
) -> Result<()> {
    let nickname = nickname.trim();
    anyhow::ensure!(!nickname.is_empty(), "у игрока должен быть ник");

    conn.execute(
        "UPDATE players SET nickname = ?2, osu_user_id = ?3, color = ?4, note = ?5 WHERE id = ?1",
        params![id, nickname, osu_user_id, color, note],
    )?;
    Ok(())
}

pub fn set_archived(conn: &Connection, id: i64, archived: bool) -> Result<()> {
    conn.execute(
        "UPDATE players SET is_archived = ?2 WHERE id = ?1",
        params![id, archived as i64],
    )?;
    Ok(())
}

/// Удалять можно только тех, кто ещё нигде не играл: иначе история матчей
/// осталась бы с пустыми именами. Остальных — в архив.
pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    let played: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tournament_players WHERE player_id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    anyhow::ensure!(
        played == 0,
        "игрок уже участвовал в турнирах — его можно только убрать в архив"
    );

    conn.execute("DELETE FROM players WHERE id = ?1", params![id])?;
    Ok(())
}

/// Сводка по игроку. Считается запросами по истории, поэтому всегда
/// согласована с тем, что видно в матчах.
pub fn stats(conn: &Connection, id: i64) -> Result<PlayerStats> {
    let (tournaments, tournament_wins) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(placement = 1), 0)
           FROM tournament_players WHERE player_id = ?1",
        params![id],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
    )?;

    let mut st = conn.prepare(
        "SELECT placement FROM tournament_players
          WHERE player_id = ?1 AND placement IS NOT NULL ORDER BY placement",
    )?;
    let placements = st
        .query_map(params![id], |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let (matches, match_wins) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(winner_id = ?1), 0)
           FROM matches
          WHERE status = 'finished' AND (player_a = ?1 OR player_b = ?1)",
        params![id],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
    )?;

    // Карты: считаем только сыгранные, где известен победитель.
    let (maps, map_wins) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(a.winner_id = ?1), 0)
           FROM match_actions a
           JOIN matches m ON m.id = a.match_id
          WHERE a.type = 'result' AND a.winner_id IS NOT NULL
            AND (m.player_a = ?1 OR m.player_b = ?1)",
        params![id],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
    )?;

    // Лучший и худший мод — по доле побед, но только там, где сыграно
    // хотя бы две карты: на одной статистики нет.
    let mut st = conn.prepare(
        "SELECT s.mod,
                COUNT(*) AS played,
                COALESCE(SUM(a.winner_id = ?1), 0) AS won
           FROM match_actions a
           JOIN matches m ON m.id = a.match_id
           JOIN pool_slots s ON s.pool_id = m.pool_id AND s.slot_label = a.slot_label
          WHERE a.type = 'result' AND a.winner_id IS NOT NULL
            AND (m.player_a = ?1 OR m.player_b = ?1)
          GROUP BY s.mod
         HAVING played >= 2
          ORDER BY (won * 1.0 / played) DESC, played DESC",
    )?;
    let by_mod = st
        .query_map(params![id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let best_mod = by_mod.first().map(|(m, _, _)| m.clone());
    let worst_mod = if by_mod.len() > 1 {
        by_mod.last().map(|(m, _, _)| m.clone())
    } else {
        None
    };

    // Любимая карта — чаще всего выигранная.
    let favourite_beatmap = conn
        .query_row(
            "SELECT s.beatmap_id
               FROM match_actions a
               JOIN matches m ON m.id = a.match_id
               JOIN pool_slots s ON s.pool_id = m.pool_id AND s.slot_label = a.slot_label
              WHERE a.type = 'result' AND a.winner_id = ?1 AND s.beatmap_id IS NOT NULL
              GROUP BY s.beatmap_id
              ORDER BY COUNT(*) DESC
              LIMIT 1",
            params![id],
            |r| r.get::<_, i64>(0),
        )
        .ok();

    // Личные счёты: соперник — тот, кто стоял с другой стороны матча.
    let mut st = conn.prepare(
        "SELECT p.id, p.nickname,
                COALESCE(SUM(m.winner_id = ?1), 0) AS wins,
                COALESCE(SUM(m.winner_id = p.id), 0) AS losses
           FROM matches m
           JOIN players p
             ON p.id = CASE WHEN m.player_a = ?1 THEN m.player_b ELSE m.player_a END
          WHERE m.status = 'finished' AND (m.player_a = ?1 OR m.player_b = ?1)
          GROUP BY p.id
          ORDER BY (wins + losses) DESC, p.nickname COLLATE NOCASE",
    )?;
    let versus = st
        .query_map(params![id], |r| {
            Ok(PlayerVersus {
                player_id: r.get(0)?,
                nickname: r.get(1)?,
                wins: r.get(2)?,
                losses: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(PlayerStats {
        player_id: id,
        tournaments,
        tournament_wins,
        placements,
        matches,
        match_wins,
        maps,
        map_wins,
        best_mod,
        worst_mod,
        favourite_beatmap,
        versus,
    })
}
