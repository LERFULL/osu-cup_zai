//! Турниры: состав, сетка, продвижение по ней.

use anyhow::Result;
use rusqlite::{params, Connection};

use super::bracket;
use crate::model::{Bracket, ByRound, Match, Tournament, TournamentPlayer};

pub fn row_to_match(row: &rusqlite::Row) -> rusqlite::Result<Match> {
    Ok(Match {
        id: row.get("id")?,
        tournament_id: row.get("tournament_id")?,
        bracket: row.get("bracket")?,
        round: row.get("round")?,
        slot_in_bracket: row.get("slot_in_bracket")?,
        player_a: row.get("player_a")?,
        player_b: row.get("player_b")?,
        pool_id: row.get("pool_id")?,
        status: row.get("status")?,
        winner_id: row.get("winner_id")?,
        is_walkover: row.get::<_, i64>("is_walkover")? != 0,
        is_manual_edit: row.get::<_, i64>("is_manual_edit")? != 0,
        first_ban_by: row.get("first_ban_by")?,
        next_win_slot: row.get("next_win_slot")?,
        next_lose_slot: row.get("next_lose_slot")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        score_a: 0,
        score_b: 0,
    })
}

/// Счёт по картам берём из действий: он всегда согласован с историей.
pub fn fill_scores(conn: &Connection, m: &mut Match) -> Result<()> {
    let (a, b) = conn.query_row(
        "SELECT COALESCE(SUM(winner_id = ?2), 0), COALESCE(SUM(winner_id = ?3), 0)
           FROM match_actions
          WHERE match_id = ?1 AND type = 'result'",
        params![m.id, m.player_a, m.player_b],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
    )?;
    m.score_a = a;
    m.score_b = b;
    Ok(())
}

fn by_round(raw: &str, fallback: i64) -> ByRound {
    serde_json::from_str(raw).unwrap_or_else(|_| ByRound::new(fallback))
}

fn row_to_tournament(row: &rusqlite::Row) -> rusqlite::Result<Tournament> {
    Ok(Tournament {
        id: row.get("id")?,
        name: row.get("name")?,
        status: row.get("status")?,
        bracket_size: row.get("bracket_size")?,
        target_score: by_round(&row.get::<_, String>("target_score")?, 4),
        bans_per_round: by_round(&row.get::<_, String>("bans_per_round")?, 1),
        first_ban: row.get("first_ban")?,
        no_repeat_pool: row.get::<_, i64>("no_repeat_pool")? != 0,
        created_at: row.get("created_at")?,
        finished_at: row.get("finished_at")?,
        players: Vec::new(),
        pool_ids: Vec::new(),
    })
}

const COLS: &str = "id, name, status, bracket_size, target_score, bans_per_round, \
                    first_ban, no_repeat_pool, created_at, finished_at";

pub fn list(conn: &Connection) -> Result<Vec<Tournament>> {
    let sql = format!("SELECT {COLS} FROM tournaments ORDER BY created_at DESC, id DESC");
    let mut st = conn.prepare(&sql)?;
    let mut out = st
        .query_map([], row_to_tournament)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for t in &mut out {
        t.players = players_of(conn, t.id)?;
        t.pool_ids = pools_of(conn, t.id)?;
    }
    Ok(out)
}

pub fn get(conn: &Connection, id: i64) -> Result<Tournament> {
    let sql = format!("SELECT {COLS} FROM tournaments WHERE id = ?1");
    let mut t = conn.query_row(&sql, params![id], row_to_tournament)?;
    t.players = players_of(conn, id)?;
    t.pool_ids = pools_of(conn, id)?;
    Ok(t)
}

pub fn players_of(conn: &Connection, tournament_id: i64) -> Result<Vec<TournamentPlayer>> {
    let mut st = conn.prepare(
        "SELECT tp.player_id, p.nickname, tp.seed, tp.color, tp.placement
           FROM tournament_players tp
           JOIN players p ON p.id = tp.player_id
          WHERE tp.tournament_id = ?1
          ORDER BY tp.seed IS NULL, tp.seed, p.nickname COLLATE NOCASE",
    )?;
    let rows = st.query_map(params![tournament_id], |r| {
        Ok(TournamentPlayer {
            player_id: r.get(0)?,
            nickname: r.get(1)?,
            seed: r.get(2)?,
            color: r.get(3)?,
            placement: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn pools_of(conn: &Connection, tournament_id: i64) -> Result<Vec<i64>> {
    let mut st = conn.prepare(
        "SELECT pool_id FROM tournament_pools WHERE tournament_id = ?1 ORDER BY position, pool_id",
    )?;
    let rows = st.query_map(params![tournament_id], |r| r.get::<_, i64>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}
pub fn create(conn: &Connection, name: &str, target: i64, bans: i64) -> Result<i64> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "у турнира должно быть название");

    conn.execute(
        "INSERT INTO tournaments (name, bracket_size, target_score, bans_per_round, created_at)
         VALUES (?1, 0, ?2, ?3, datetime('now'))",
        params![
            name,
            serde_json::to_string(&ByRound::new(target))?,
            serde_json::to_string(&ByRound::new(bans))?,
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn rename(conn: &Connection, id: i64, name: &str) -> Result<()> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "у турнира должно быть название");
    conn.execute(
        "UPDATE tournaments SET name = ?2 WHERE id = ?1",
        params![id, name],
    )?;
    Ok(())
}

/// Правила матчей. Пока сетка не запущена, менять можно свободно.
pub fn set_rules(
    conn: &Connection,
    id: i64,
    target: &ByRound,
    bans: &ByRound,
    first_ban: &str,
    no_repeat_pool: bool,
) -> Result<()> {
    conn.execute(
        "UPDATE tournaments
            SET target_score = ?2, bans_per_round = ?3, first_ban = ?4, no_repeat_pool = ?5
          WHERE id = ?1",
        params![
            id,
            serde_json::to_string(target)?,
            serde_json::to_string(bans)?,
            first_ban,
            no_repeat_pool as i64,
        ],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM tournaments WHERE id = ?1", params![id])?;
    Ok(())
}

/// Состав и правила меняются только у черновика: пересобирать сетку,
/// в которой уже играли, значит терять историю.
fn draft(conn: &Connection, id: i64) -> Result<()> {
    let status: String = conn.query_row(
        "SELECT status FROM tournaments WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    anyhow::ensure!(
        status == "draft",
        "турнир уже идёт — состав и правила менять нельзя"
    );
    Ok(())
}

pub fn add_player(conn: &Connection, tournament_id: i64, player_id: i64) -> Result<()> {
    draft(conn, tournament_id)?;

    // Цвет берём личный, а конфликт внутри турнира разводим на свободный
    // из палитры: глобальный цвет игрока при этом не трогаем.
    let color: String = conn.query_row(
        "SELECT color FROM players WHERE id = ?1",
        params![player_id],
        |r| r.get(0),
    )?;

    let taken: Vec<String> = players_of(conn, tournament_id)?
        .into_iter()
        .map(|p| p.color)
        .collect();
    let color = if taken.contains(&color) {
        super::players::free_color(conn, &taken)
    } else {
        color
    };

    conn.execute(
        "INSERT OR IGNORE INTO tournament_players (tournament_id, player_id, color)
         VALUES (?1, ?2, ?3)",
        params![tournament_id, player_id, color],
    )?;
    Ok(())
}

pub fn remove_player(conn: &Connection, tournament_id: i64, player_id: i64) -> Result<()> {
    draft(conn, tournament_id)?;
    conn.execute(
        "DELETE FROM tournament_players WHERE tournament_id = ?1 AND player_id = ?2",
        params![tournament_id, player_id],
    )?;
    Ok(())
}

/// Сеяние: порядок в списке задаёт номера с первого.
pub fn set_seeds(conn: &Connection, tournament_id: i64, order: &[i64]) -> Result<()> {
    draft(conn, tournament_id)?;
    for (i, player_id) in order.iter().enumerate() {
        conn.execute(
            "UPDATE tournament_players SET seed = ?3
              WHERE tournament_id = ?1 AND player_id = ?2",
            params![tournament_id, player_id, i as i64 + 1],
        )?;
    }
    Ok(())
}

pub fn set_player_color(
    conn: &Connection,
    tournament_id: i64,
    player_id: i64,
    color: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE tournament_players SET color = ?3 WHERE tournament_id = ?1 AND player_id = ?2",
        params![tournament_id, player_id, color],
    )?;
    Ok(())
}

pub fn set_pools(conn: &Connection, tournament_id: i64, pool_ids: &[i64]) -> Result<()> {
    conn.execute(
        "DELETE FROM tournament_pools WHERE tournament_id = ?1",
        params![tournament_id],
    )?;
    for (i, pool_id) in pool_ids.iter().enumerate() {
        conn.execute(
            "INSERT INTO tournament_pools (tournament_id, pool_id, position) VALUES (?1, ?2, ?3)",
            params![tournament_id, pool_id, i as i64],
        )?;
    }
    Ok(())
}

/// Раскладывает игроков по местам сеяния: у кого номер задан — по нему,
/// остальных доливаем в порядке списка.
fn seat_order(players: &[TournamentPlayer], size: usize) -> Vec<Option<i64>> {
    let mut seeded: Vec<Option<i64>> = vec![None; size];
    let mut rest = Vec::new();

    for p in players {
        match p.seed {
            Some(s) if s >= 1 && (s as usize) <= size && seeded[s as usize - 1].is_none() => {
                seeded[s as usize - 1] = Some(p.player_id);
            }
            _ => rest.push(p.player_id),
        }
    }
    for pid in rest {
        if let Some(free) = seeded.iter_mut().find(|s| s.is_none()) {
            *free = Some(pid);
        }
    }
    seeded
}

/// Строит сетку и переводит турнир в «идёт».
///
/// Вызывать внутри транзакции: матчи вставляются пачкой и связываются
/// вторым проходом, а половина сетки — это не сетка.
pub fn start(conn: &Connection, id: i64) -> Result<()> {
    draft(conn, id)?;

    let players = players_of(conn, id)?;
    anyhow::ensure!(players.len() >= 2, "для сетки нужно хотя бы два игрока");

    let size = bracket::bracket_size(players.len());
    let seats = bracket::build(size, &seat_order(&players, size));

    conn.execute("DELETE FROM matches WHERE tournament_id = ?1", params![id])?;

    // Сначала вставляем все матчи, потом связываем: ссылки идут вперёд,
    // и id следующего матча на момент вставки ещё неизвестен.
    let mut ids = Vec::with_capacity(seats.len());
    for seat in &seats {
        conn.execute(
            "INSERT INTO matches
               (tournament_id, bracket, round, slot_in_bracket, player_a, player_b)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                seat.bracket,
                seat.round,
                seat.slot,
                seat.player_a,
                seat.player_b
            ],
        )?;
        ids.push(conn.last_insert_rowid());
    }

    for (i, seat) in seats.iter().enumerate() {
        conn.execute(
            "UPDATE matches SET next_win_slot = ?2, next_lose_slot = ?3 WHERE id = ?1",
            params![
                ids[i],
                seat.next_win.map(|n| ids[n]),
                seat.next_lose.map(|n| ids[n]),
            ],
        )?;
    }

    conn.execute(
        "UPDATE tournaments SET status = 'running', bracket_size = ?2 WHERE id = ?1",
        params![id, size as i64],
    )?;

    advance_walkovers(conn, id)?;
    Ok(())
}

/// Если в матче оказался один игрок, он проходит дальше без игры.
/// Повторяем, пока такие матчи находятся: после продвижения может
/// открыться следующий.
pub fn advance_walkovers(conn: &Connection, tournament_id: i64) -> Result<()> {
    loop {
        let found: Option<(i64, i64)> = conn
            .query_row(
                // Пустое место — ещё не признак техпобеды: в нижнюю сетку
                // игрок мог просто не доехать. Ждём, пока все матчи,
                // ведущие сюда, будут сыграны.
                "SELECT id, COALESCE(player_a, player_b) FROM matches m
                  WHERE tournament_id = ?1 AND status = 'pending'
                    AND ((player_a IS NULL) <> (player_b IS NULL))
                    AND NOT EXISTS (
                      SELECT 1 FROM matches src
                       WHERE src.tournament_id = m.tournament_id
                         AND (src.next_win_slot = m.id OR src.next_lose_slot = m.id)
                         AND src.status <> 'finished'
                    )
                  LIMIT 1",
                params![tournament_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();

        let Some((match_id, winner)) = found else {
            break;
        };

        conn.execute(
            "UPDATE matches
                SET status = 'finished', winner_id = ?2, is_walkover = 1,
                    finished_at = datetime('now')
              WHERE id = ?1",
            params![match_id, winner],
        )?;
        promote(conn, match_id)?;
    }
    Ok(())
}

/// Разводит победителя и проигравшего по следующим матчам сетки.
pub fn promote(conn: &Connection, match_id: i64) -> Result<()> {
    type Links = (Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<i64>);
    let (winner, player_a, player_b, next_win, next_lose): Links = conn.query_row(
        "SELECT winner_id, player_a, player_b, next_win_slot, next_lose_slot
           FROM matches WHERE id = ?1",
        params![match_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;

    let Some(winner) = winner else {
        return Ok(());
    };
    let loser = if player_a == Some(winner) {
        player_b
    } else {
        player_a
    };

    if let Some(next) = next_win {
        seat_player(conn, next, winner)?;
    }
    if let (Some(next), Some(loser)) = (next_lose, loser) {
        seat_player(conn, next, loser)?;
    }
    Ok(())
}

/// Садит игрока на первое свободное место матча.
fn seat_player(conn: &Connection, match_id: i64, player_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE matches
            SET player_a = CASE WHEN player_a IS NULL THEN ?2 ELSE player_a END,
                player_b = CASE WHEN player_a IS NOT NULL AND player_b IS NULL
                                THEN ?2 ELSE player_b END
          WHERE id = ?1 AND (player_a IS NULL OR player_b IS NULL)
            AND player_a IS NOT ?2 AND player_b IS NOT ?2",
        params![match_id, player_id],
    )?;
    Ok(())
}

/// Турнир вместе с сеткой — то, из чего рисуется экран.
pub fn bracket_of(conn: &Connection, id: i64) -> Result<Bracket> {
    let tournament = get(conn, id)?;

    let mut st = conn.prepare(
        "SELECT * FROM matches WHERE tournament_id = ?1
          ORDER BY CASE bracket WHEN 'upper' THEN 0 WHEN 'lower' THEN 1 ELSE 2 END,
                   round, slot_in_bracket",
    )?;
    let mut matches = st
        .query_map(params![id], row_to_match)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for m in &mut matches {
        fill_scores(conn, m)?;
    }

    Ok(Bracket {
        tournament,
        matches,
    })
}

/// Итоговые места: чем позже вылет, тем выше место.
pub fn finish(conn: &Connection, id: i64) -> Result<()> {
    let unfinished: i64 = conn.query_row(
        "SELECT COUNT(*) FROM matches
          WHERE tournament_id = ?1 AND status <> 'finished'
            AND player_a IS NOT NULL AND player_b IS NOT NULL",
        params![id],
        |r| r.get(0),
    )?;
    anyhow::ensure!(unfinished == 0, "в сетке остались несыгранные матчи");

    let champion: Option<i64> = conn
        .query_row(
            "SELECT winner_id FROM matches WHERE tournament_id = ?1 AND bracket = 'grand' LIMIT 1",
            params![id],
            |r| r.get(0),
        )
        .ok()
        .flatten();

    if let Some(champion) = champion {
        conn.execute(
            "UPDATE tournament_players SET placement = 1
              WHERE tournament_id = ?1 AND player_id = ?2",
            params![id, champion],
        )?;
    }

    // Порядок вылета: последним проиграл тот, кто занял второе место.
    let mut st = conn.prepare(
        "SELECT CASE WHEN player_a = winner_id THEN player_b ELSE player_a END AS loser
           FROM matches
          WHERE tournament_id = ?1 AND winner_id IS NOT NULL
          ORDER BY CASE bracket WHEN 'grand' THEN 2 WHEN 'lower' THEN 1 ELSE 0 END DESC,
                   round DESC, slot_in_bracket",
    )?;
    let order = st
        .query_map(params![id], |r| r.get::<_, Option<i64>>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut place = 2;
    for loser in order.into_iter().flatten() {
        if Some(loser) == champion {
            continue;
        }
        let changed = conn.execute(
            "UPDATE tournament_players SET placement = ?3
              WHERE tournament_id = ?1 AND player_id = ?2 AND placement IS NULL",
            params![id, loser, place],
        )?;
        if changed > 0 {
            place += 1;
        }
    }

    conn.execute(
        "UPDATE tournaments SET status = 'finished', finished_at = datetime('now')
          WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}
