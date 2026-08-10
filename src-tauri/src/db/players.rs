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

/// Цвет по номеру. Первые восемь — палитра, дальше считаем свои: на
/// турнир в двадцать человек восьми цветов не хватает, а повторы в сетке
/// не различить. Оттенок каждый раз уходит на пол-оборота от предыдущего,
/// поэтому соседние номера далеки друг от друга.
pub fn color_at(n: usize) -> String {
    if n < PALETTE.len() {
        return PALETTE[n].to_string();
    }

    // Золотое сечение по кругу оттенков: точки не сходятся в кучу даже
    // на сотне игроков.
    let step = (n - PALETTE.len()) as f64;
    let hue = (196.0 + step * 137.508) % 360.0;
    // Насыщенность и светлота чередуются, чтобы близкие оттенки
    // расходились ещё и по яркости.
    let (sat, light) = match (n - PALETTE.len()) % 3 {
        0 => (0.62, 0.66),
        1 => (0.78, 0.58),
        _ => (0.52, 0.74),
    };
    hsl_to_hex(hue, sat, light)
}

fn hsl_to_hex(h: f64, s: f64, l: f64) -> String {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = l - c / 2.0;

    let (r, g, b) = match h as i64 / 60 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };

    let to255 = |v: f64| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    format!("#{:02x}{:02x}{:02x}", to255(r), to255(g), to255(b))
}

/// Первый цвет, который ещё не занят. Палитра идёт первой, дальше —
/// считаные: отказывать в добавлении игрока из-за цветов неправильно,
/// а повторять цвет в одной сетке — тем более.
pub fn free_color(_conn: &Connection, taken: &[String]) -> String {
    let mut n = 0usize;
    loop {
        let candidate = color_at(n);
        if !taken.iter().any(|t| t.eq_ignore_ascii_case(&candidate)) {
            return candidate;
        }
        n += 1;
        // Столько игроков в одном турнире не бывает — страховка от вечного цикла.
        if n > 512 {
            return candidate;
        }
    }
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
        .unwrap_or_else(|| color_at(taken as usize));

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

pub fn set_avatar_path(conn: &Connection, id: i64, path: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE players SET avatar_path = ?2 WHERE id = ?1",
        params![id, path],
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
    let ranked_mods = st
        .query_map(params![id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let best_mod = ranked_mods.first().map(|(m, _, _)| m.clone());
    let worst_mod = if ranked_mods.len() > 1 {
        ranked_mods.last().map(|(m, _, _)| m.clone())
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

    // Разбивка по мод-тегам — без порога «хотя бы две карты»: таблица
    // показывает всё, а лучший/худший мод выделяет и так.
    let mut st = conn.prepare(
        "SELECT s.mod, COUNT(*), COALESCE(SUM(a.winner_id = ?1), 0)
           FROM match_actions a
           JOIN matches m ON m.id = a.match_id
           JOIN pool_slots s ON s.pool_id = m.pool_id AND s.slot_label = a.slot_label
          WHERE a.type = 'result' AND a.winner_id IS NOT NULL
            AND (m.player_a = ?1 OR m.player_b = ?1)
          GROUP BY s.mod
          ORDER BY s.mod",
    )?;
    let by_mod = st
        .query_map(params![id], |r| {
            Ok(crate::model::ModStats {
                mod_tag: r.get(0)?,
                played: r.get(1)?,
                won: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // История выступлений: один турнир на строку. Место берём из состава,
    // число матчей считаем по матчам турнира с участием игрока.
    let mut st = conn.prepare(
        "SELECT t.id, t.name, t.finished_at, tp.placement,
                (SELECT COUNT(*) FROM matches mt
                  WHERE mt.tournament_id = t.id AND mt.status = 'finished'
                    AND (mt.player_a = ?1 OR mt.player_b = ?1)) AS played,
                (SELECT COUNT(*) FROM matches mt
                  WHERE mt.tournament_id = t.id AND mt.status = 'finished'
                    AND mt.winner_id = ?1) AS won
           FROM tournament_players tp
           JOIN tournaments t ON t.id = tp.tournament_id
          WHERE tp.player_id = ?1
          ORDER BY t.created_at DESC, t.id DESC",
    )?;
    let history = st
        .query_map(params![id], |r| {
            Ok(crate::model::PlayerAppearance {
                tournament_id: r.get(0)?,
                tournament_name: r.get(1)?,
                finished_at: r.get(2)?,
                placement: r.get(3)?,
                matches: r.get(4)?,
                match_wins: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

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
        by_mod,
        history,
        versus,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colors_do_not_repeat_on_a_big_roster() {
        // Двадцать участников — обычный размер, а палитры хватает на восемь.
        let colors: Vec<String> = (0..20).map(color_at).collect();
        let unique: std::collections::HashSet<&String> = colors.iter().collect();
        assert_eq!(unique.len(), 20, "цвета игроков не должны повторяться");
    }

    #[test]
    fn generated_colors_are_valid_hex() {
        for n in 0..64 {
            let c = color_at(n);
            assert_eq!(c.len(), 7, "{c} — не #rrggbb");
            assert!(c.starts_with('#'));
            assert!(
                u32::from_str_radix(&c[1..], 16).is_ok(),
                "{c} — не шестнадцатеричный"
            );
        }
    }

    #[test]
    fn free_color_skips_taken_ones() {
        let taken: Vec<String> = (0..8).map(color_at).collect();
        let conn = Connection::open_in_memory().unwrap();
        let next = free_color(&conn, &taken);
        assert!(
            !taken.contains(&next),
            "занятый цвет не должен выдаваться повторно"
        );
    }
}
