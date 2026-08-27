//! Призовой фонд поверх SQLite: сбор формы сетки, значения приложения
//! и жизненный цикл джекпота.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;

use super::tournaments;
use crate::error::{AppError, Result};
use crate::model::{PrizeConfig, Tournament};
use crate::prize::{self, Input, ShapeMatch, ShapePlayer};

// ─────────────────────────────────────────────── значения приложения

pub fn kv_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM app_kv WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn kv_set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO app_kv (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn kv_del(conn: &Connection, key: &str) -> Result<()> {
    conn.execute("DELETE FROM app_kv WHERE key = ?1", params![key])?;
    Ok(())
}

/// Целое значение приложения: отсутствует или битое — дефолт.
/// Настройки вроде «автобэкап раз в N запусков» не должны падать из-за
/// кривой записи в базе.
pub fn kv_get_i64(conn: &Connection, key: &str, default: i64) -> i64 {
    kv_get(conn, key)
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(default)
}

/// Записать целое значение приложения.
pub fn kv_set_i64(conn: &Connection, key: &str, value: i64) -> Result<()> {
    kv_set(conn, key, &value.to_string())
}

/// Переходящий джекпот приложения: невыданный остаток прошлых турниров.
pub fn jackpot(conn: &Connection) -> i64 {
    kv_get(conn, "jackpot")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0)
}

fn jackpot_add(conn: &Connection, delta: i64) -> Result<()> {
    let next = (jackpot(conn) + delta).max(0);
    kv_set(conn, "jackpot", &next.to_string())
}

// ───────────────────────────────────────────────────────── форма сетки

/// Фактические матчи турнира как форма фонда.
///
/// Счёта в таблице матчей нет и быть не может: он считается из журнала
/// действий (см. `tournaments::fill_scores`). Колонок `score_a`/`score_b`
/// здесь никогда не было — запросы, которые их читали, валили весь экран
/// турнира ошибкой «no such column».
fn shape_of(conn: &Connection, t: &Tournament) -> Result<Vec<ShapeMatch>> {
    let mut st = conn.prepare(
        "SELECT m.id, m.bracket, m.round, m.slot_in_bracket, m.next_win_slot, m.next_lose_slot,
                m.player_a, m.player_b, m.winner_id, m.is_walkover, m.status,
                m.target_score, m.first_ban_by,
                COALESCE((SELECT COUNT(*) FROM match_actions r
                           WHERE r.match_id = m.id AND r.type = 'result'
                             AND r.winner_id = m.player_a), 0) AS maps_a,
                COALESCE((SELECT COUNT(*) FROM match_actions r
                           WHERE r.match_id = m.id AND r.type = 'result'
                             AND r.winner_id = m.player_b), 0) AS maps_b
           FROM matches m WHERE m.tournament_id = ?1",
    )?;
    let rows = st.query_map(params![t.id], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, Option<i64>>(4)?,
            r.get::<_, Option<i64>>(5)?,
            r.get::<_, Option<i64>>(6)?,
            r.get::<_, Option<i64>>(7)?,
            r.get::<_, Option<i64>>(8)?,
            r.get::<_, i64>(9)?,
            r.get::<_, String>(10)?,
            r.get::<_, Option<i64>>(11)?,
            r.get::<_, Option<i64>>(12)?,
            r.get::<_, i64>(13)?,
            r.get::<_, i64>(14)?,
        ))
    })?;

    let seed_of = |pid: Option<i64>| -> Option<i64> {
        pid.and_then(|id| t.players.iter().find(|p| p.player_id == id).and_then(|p| p.seed))
    };
    let winner_seed = |pid: Option<i64>| -> Option<i64> { seed_of(pid) };

    let mut out = Vec::new();
    for row in rows.collect::<rusqlite::Result<Vec<_>>>()? {
        let (id, bracket, round, slot, next_win, next_lose, a, b, winner, walkover, status, target, _, score_a, score_b) = row;
        // Замороженное правило матча сильнее правила раунда.
        let target = target
            .or_else(|| Some(t.target_score.at_key(&bracket, round)))
            .unwrap_or(4)
            .max(1);
        out.push(ShapeMatch {
            id,
            bracket,
            round,
            slot,
            next_win,
            next_lose,
            seed_a: seed_of(a),
            seed_b: seed_of(b),
            winner_seed: if status == "finished" {
                winner_seed(winner)
            } else {
                None
            },
            walkover: walkover != 0,
            finished: status == "finished",
            running: status == "running" && a.is_some() && b.is_some(),
            target,
            maps_a: score_a,
            maps_b: score_b,
        });
    }
    Ok(out)
}

/// Проект сетки: что построится текущим составом. Для черновика и проверки
/// лестницы до построения.
fn projected_shape(conn: &Connection, id: i64) -> Result<Vec<ShapeMatch>> {
    let players = tournaments::players_of(conn, id)?;
    if players.len() < 2 {
        return Ok(Vec::new());
    }
    let t = tournaments::get(conn, id)?;
    let size = crate::db::bracket::bracket_size(players.len());
    let seeded = seat_order(&players, size);

    let seats = crate::db::bracket::build(size, &seeded);
    let seed_by_id: std::collections::HashMap<i64, Option<i64>> = players
        .iter()
        .map(|p| (p.player_id, p.seed))
        .collect();

    Ok(seats
        .iter()
        .enumerate()
        .map(|(i, s)| ShapeMatch {
            id: i as i64,
            bracket: s.bracket.to_string(),
            round: s.round,
            slot: s.slot,
            next_win: s.next_win.map(|n| n as i64),
            next_lose: s.next_lose.map(|n| n as i64),
            seed_a: s.player_a.and_then(|p| seed_by_id.get(&p).copied().flatten()),
            seed_b: s.player_b.and_then(|p| seed_by_id.get(&p).copied().flatten()),
            winner_seed: None,
            walkover: false,
            finished: false,
            running: false,
            target: t.target_score.at_key(s.bracket, s.round).max(1),
            maps_a: 0,
            maps_b: 0,
        })
        .collect())
}

/// Порядок сидов по составу — тот же, которым сетку собирает турнир.
fn seat_order(players: &[crate::model::TournamentPlayer], size: usize) -> Vec<Option<i64>> {
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

// ───────────────────────────────────────────────────── состояние фонда

/// Подпись матча для лучшего: «Финал верхней — NAGISA : KIRA 4:3».
/// Счёт — из журнала действий, в таблице матчей его нет.
fn match_label(conn: &Connection, tournament_id: i64, match_id: i64) -> Result<Option<String>> {
    let row: Option<(String, i64, Option<i64>, Option<i64>, i64, i64)> = conn
        .query_row(
            "SELECT m.bracket, m.round, m.player_a, m.player_b,
                    COALESCE((SELECT COUNT(*) FROM match_actions r
                               WHERE r.match_id = m.id AND r.type = 'result'
                                 AND r.winner_id = m.player_a), 0),
                    COALESCE((SELECT COUNT(*) FROM match_actions r
                               WHERE r.match_id = m.id AND r.type = 'result'
                                 AND r.winner_id = m.player_b), 0)
               FROM matches m WHERE m.id = ?1 AND m.tournament_id = ?2",
            params![match_id, tournament_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .optional()?;
    let Some((bracket, round, a, b, sa, sb)) = row else {
        return Ok(None);
    };

    let players = tournaments::players_of(conn, tournament_id)?;
    let nick = |pid: Option<i64>| -> String {
        pid.and_then(|id| players.iter().find(|p| p.player_id == id))
            .map(|p| p.nickname.clone())
            .unwrap_or_else(|| "—".into())
    };

    // Название раунда — то же, которым сетка подписана на экране.
    let last_round: i64 = conn.query_row(
        "SELECT COALESCE(MAX(round), 0) FROM matches
          WHERE tournament_id = ?1 AND bracket = ?2",
        params![tournament_id, bracket],
        |r| r.get(0),
    )?;
    let title = tournaments::round_title(&bracket, round, last_round);
    Ok(Some(format!(
        "{title} — {} : {} {}:{}",
        nick(a),
        nick(b),
        sa,
        sb
    )))
}

/// Каноническая полная сетка размера турнира: без срезки и бези.
fn canonical_shape(conn: &Connection, id: i64, players: usize) -> Result<Vec<ShapeMatch>> {
    if players < 2 {
        return Ok(Vec::new());
    }
    let t = tournaments::get(conn, id)?;
    let size = crate::db::bracket::bracket_size(players);
    let seeded: Vec<Option<i64>> = (1..=size as i64).map(Some).collect();
    let seats = crate::db::bracket::build(size, &seeded);
    Ok(seats
        .iter()
        .enumerate()
        .map(|(i, s)| ShapeMatch {
            id: i as i64,
            bracket: s.bracket.to_string(),
            round: s.round,
            slot: s.slot,
            next_win: s.next_win.map(|n| n as i64),
            next_lose: s.next_lose.map(|n| n as i64),
            seed_a: s.player_a,
            seed_b: s.player_b,
            winner_seed: None,
            walkover: false,
            finished: false,
            running: false,
            target: t.target_score.at_key(s.bracket, s.round).max(1),
            maps_a: 0,
            maps_b: 0,
        })
        .collect())
}

/// Полный взгляд на фонд турнира с данным конфигом.
pub fn view(conn: &Connection, id: i64, config: &PrizeConfig) -> Result<crate::model::PrizeView> {
    let t = tournaments::get(conn, id)?;
    let status = t.status.clone();

    let players = tournaments::players_of(conn, id)?;
    let mut shape_players: Vec<ShapePlayer> = players
        .iter()
        .map(|p| ShapePlayer {
            player_id: p.player_id,
            nickname: p.nickname.clone(),
            color: p.color.clone(),
            seed: p.seed,
            rookie: p.is_rookie,
            place: p.placement,
        })
        .collect();

    // До построения сетки смотрим проект, после — фактические матчи.
    let bracket_built: i64 = conn.query_row(
        "SELECT COUNT(*) FROM matches WHERE tournament_id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    let matches = if bracket_built > 0 {
        shape_of(conn, &t)?
    } else {
        projected_shape(conn, id)?
    };

    // Проверка лестницы идёт по канонической сетке того же размера: срезка
    // неполного состава меняет пути, и проверка ловила бы артефакты
    // состава, а не ошибки конфигурации.
    let ladder_matches = canonical_shape(conn, id, players.len())?;

    // Живые места: выбывшие из сыгранной сетки получают место сразу.
    if matches.iter().any(|m| m.finished) {
        let mut losers: Vec<&ShapeMatch> = matches
            .iter()
            .filter(|m| {
                m.finished && m.next_lose.is_none() && m.bracket != "upper" && m.winner_seed.is_some()
            })
            .collect();
        losers.sort_by_key(|m| {
            (
                if m.bracket == "grand" { 0 } else { 1 },
                (m.bracket == "lower") as i64,
                -m.round,
                m.slot,
            )
        });
        // Победитель гранд-финала — чемпион, если финал сыгран.
        let champ = matches
            .iter()
            .find(|m| m.bracket == "grand" && m.finished && m.winner_seed.is_some())
            .and_then(|m| m.winner_seed);
        if let Some(seed) = champ {
            if let Some(p) = players.iter().find(|p| p.seed == Some(seed)) {
                if let Some(sp) = shape_players.iter_mut().find(|sp| sp.player_id == p.player_id) {
                    sp.place = Some(1);
                }
            }
        }
        let mut place = 2;
        for m in &losers {
            if let Some(loser) = m.loser_seed() {
                if let Some(p) = players.iter().find(|p| p.seed == Some(loser)) {
                    if let Some(sp) = shape_players.iter_mut().find(|sp| sp.player_id == p.player_id) {
                        if sp.place.is_none() {
                            sp.place = Some(place);
                            place += 1;
                        }
                    }
                }
            }
        }
    }

    let finished = status == "finished";
    let best_match = match config.best_match_id {
        Some(mid) => match_label(conn, id, mid)?.map(|label| (mid, label)),
        None => None,
    };

    Ok(prize::compute(&Input {
        matches: &matches,
        ladder_matches: &ladder_matches,
        players: &shape_players,
        config,
        jackpot_now: jackpot(conn),
        finished,
        best_match,
    }))
}

/// Фонд турнира с сохранённым конфигом.
pub fn state(conn: &Connection, id: i64) -> Result<Option<crate::model::PrizeView>> {
    let t = tournaments::get(conn, id)?;
    match &t.prize {
        Some(config) => Ok(Some(view(conn, id, config)?)),
        None => Ok(None),
    }
}

// ─────────────────────────────────────────────────────── правки фонда

/// Записать конфиг фонда. Идущему турниру — только с аварийной правкой.
pub fn set_config(conn: &Connection, id: i64, config: &PrizeConfig, emergency: bool) -> Result<()> {
    let live = tournaments::structural(conn, id, emergency)?;
    if config.fund < 0 {
        return Err(AppError::Db("фонд не может быть отрицательным".into()));
    }

    let before = tournaments::snapshot(conn, id)?;
    let saved = if config.fund == 0 {
        None
    } else {
        Some(config)
    };
    let raw = saved
        .as_ref()
        .map(|c| serde_json::to_string(c))
        .transpose()?;
    conn.execute(
        "UPDATE tournaments SET prize = ?2 WHERE id = ?1",
        params![id, raw],
    )?;

    let note = if config.fund == 0 {
        "призовой фонд снят".to_string()
    } else {
        format!("призовой фонд: {} ₽", config.fund)
    };
    tournaments::push_edit(conn, id, "prize", live, &note, before)?;
    Ok(())
}

/// Галочка новичка: у неё нет своей правки в журнале — на выплаты она влияет
/// только итогом гонки, а состав не меняет.
pub fn set_rookie(conn: &Connection, id: i64, player_id: i64, rookie: bool) -> Result<()> {
    conn.execute(
        "UPDATE tournament_players SET is_rookie = ?3
          WHERE tournament_id = ?1 AND player_id = ?2",
        params![id, player_id, rookie as i64],
    )?;
    Ok(())
}

/// Отметить лучший матч для зрительского банка.
pub fn set_best_match(conn: &Connection, id: i64, match_id: Option<i64>) -> Result<()> {
    let mut t = tournaments::get(conn, id)?;
    let Some(config) = t.prize.as_mut() else {
        return Err(AppError::Db("зрительский банк не задан: фонда нет".into()));
    };
    if config.addons.spectator.is_none() {
        return Err(AppError::Db(
            "зрительский банк выключен — отмечать лучший матч не для чего".into(),
        ));
    }
    config.best_match_id = match_id;
    conn.execute(
        "UPDATE tournaments SET prize = ?2 WHERE id = ?1",
        params![id, serde_json::to_string(&config)?],
    )?;
    Ok(())
}

// ───────────────────────────────────────────────── джекпот и запуск

/// Строгая проверка перед стартом: сломанная лестница не даёт запустить
/// турнир, ошибки конфигурации — тем более.
pub fn ensure_startable(conn: &Connection, id: i64) -> Result<()> {
    let t = tournaments::get(conn, id)?;
    let Some(config) = &t.prize else {
        return Ok(());
    };
    let v = view(conn, id, config)?;
    if !v.problems.is_empty() {
        return Err(AppError::Db(v.problems.join("; ")));
    }
    if !v.check.ok {
        return Err(AppError::Db(format!(
            "призовая лестница не сходится: {} — турнир с деньгами так не запустить",
            v.check.text
        )));
    }
    Ok(())
}

/// Джекпот вкатывается в фонд при первом старте и живёт в конфиге турнира.
pub fn carry_jackpot(conn: &Connection, id: i64) -> Result<()> {
    let mut t = tournaments::get(conn, id)?;
    let Some(config) = t.prize.as_mut() else {
        return Ok(());
    };
    if !config.addons.jackpot || config.jackpot_in > 0 {
        return Ok(());
    }
    let amount = jackpot(conn);
    if amount <= 0 {
        return Ok(());
    }
    config.jackpot_in = amount;
    conn.execute(
        "UPDATE tournaments SET prize = ?2 WHERE id = ?1",
        params![id, serde_json::to_string(&config)?],
    )?;
    jackpot_add(conn, -amount)?;
    Ok(())
}

/// Остаток фонда уезжает в джекпот следующего турнира.
pub fn roll_jackpot(conn: &Connection, id: i64) -> Result<()> {
    let mut t = tournaments::get(conn, id)?;
    let Some(config) = t.prize.as_mut() else {
        return Ok(());
    };
    if !config.addons.jackpot || config.rolled_out != 0 {
        return Ok(());
    }
    let Some(v) = state(conn, id)? else {
        return Ok(());
    };
    let rolled = v.remainder.max(0);
    config.rolled_out = rolled;
    conn.execute(
        "UPDATE tournaments SET prize = ?2 WHERE id = ?1",
        params![id, serde_json::to_string(&config)?],
    )?;
    jackpot_add(conn, rolled)?;
    Ok(())
}

/// Возврат турнира в игру возвращает и его вклад в джекпот.
pub fn unroll_jackpot(conn: &Connection, id: i64) -> Result<()> {
    let mut t = tournaments::get(conn, id)?;
    let Some(config) = t.prize.as_mut() else {
        return Ok(());
    };
    if config.rolled_out == 0 {
        return Ok(());
    }
    jackpot_add(conn, -config.rolled_out)?;
    config.rolled_out = 0;
    conn.execute(
        "UPDATE tournaments SET prize = ?2 WHERE id = ?1",
        params![id, serde_json::to_string(&config)?],
    )?;
    Ok(())
}

/// Значение джекпота наперёд — для анонса следующего турнира.
pub fn jackpot_json(conn: &Connection) -> String {
    json!({ "jackpot": jackpot(conn) }).to_string()
}
