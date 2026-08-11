//! Матч: баны, пики, результаты.
//!
//! В базе лежит только журнал действий. Счёт, чей ход и состояние строк
//! маппула считаются из него заново при каждом запросе — поэтому «отменить»
//! это просто удалить хвост журнала, а не откатывать накопленные поля.

use anyhow::Result;
use rusqlite::{params, Connection};

use crate::model::{Match, MatchAction, MatchRow, MatchState, Phase, RowState};

pub fn get(conn: &Connection, id: i64) -> Result<Match> {
    let mut m = conn.query_row(
        "SELECT * FROM matches WHERE id = ?1",
        params![id],
        super::tournaments::row_to_match,
    )?;
    super::tournaments::fill_scores(conn, &mut m)?;
    Ok(m)
}

pub fn actions(conn: &Connection, match_id: i64) -> Result<Vec<MatchAction>> {
    let mut st = conn.prepare(
        "SELECT n, type, actor_id, slot_label, winner_id, source, at
           FROM match_actions WHERE match_id = ?1 ORDER BY n",
    )?;
    let rows = st.query_map(params![match_id], |r| {
        Ok(MatchAction {
            n: r.get(0)?,
            kind: r.get(1)?,
            actor_id: r.get(2)?,
            slot_label: r.get(3)?,
            winner_id: r.get(4)?,
            source: r.get(5)?,
            at: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn set_pool(conn: &Connection, match_id: i64, pool_id: Option<i64>) -> Result<()> {
    let played: i64 = conn.query_row(
        "SELECT COUNT(*) FROM match_actions WHERE match_id = ?1",
        params![match_id],
        |r| r.get(0),
    )?;
    anyhow::ensure!(
        played == 0,
        "в матче уже есть баны или пики — маппул менять нельзя"
    );

    conn.execute(
        "UPDATE matches SET pool_id = ?2 WHERE id = ?1",
        params![match_id, pool_id],
    )?;
    Ok(())
}

/// Кто банит первым. Пока не задан, матч не начинается: порядок банов
/// зависит от этого выбора.
pub fn set_first_ban(conn: &Connection, match_id: i64, player_id: i64) -> Result<()> {
    let m = get(conn, match_id)?;
    anyhow::ensure!(
        m.player_a == Some(player_id) || m.player_b == Some(player_id),
        "этот игрок не участвует в матче"
    );

    // Сетку ещё могут пересобрать — играть по ней рано.
    let status: String = conn.query_row(
        "SELECT status FROM tournaments WHERE id = ?1",
        params![m.tournament_id],
        |r| r.get(0),
    )?;
    anyhow::ensure!(
        status != "seeded",
        "сетка ещё не запущена — подтверди её на экране турнира"
    );

    conn.execute(
        "UPDATE matches
            SET first_ban_by = ?2,
                status = CASE WHEN status = 'pending' THEN 'running' ELSE status END,
                started_at = COALESCE(started_at, datetime('now'))
          WHERE id = ?1",
        params![match_id, player_id],
    )?;
    Ok(())
}
/// Второй игрок матча.
fn other(m: &Match, player_id: i64) -> Option<i64> {
    if m.player_a == Some(player_id) {
        m.player_b
    } else {
        m.player_a
    }
}

/// Считает по журналу, что матчу делать дальше.
///
/// Ходы идут строго по очереди, начиная с назначенного первым: банил
/// первым — пикает первым. Очередь сквозная, банов и пиков вместе, иначе
/// на стыке фаз один и тот же игрок ходил бы дважды подряд. После каждого
/// пика ждём результат: без него следующий ход невозможен.
fn phase_of(m: &Match, target: i64, bans_total: i64, actions: &[MatchAction]) -> Phase {
    if m.status == "finished" {
        return Phase::Finished { winner: m.winner_id };
    }
    let (Some(first), Some(_)) = (m.first_ban_by, m.pool_id) else {
        return Phase::NotStarted;
    };
    let Some(second) = other(m, first) else {
        return Phase::NotStarted;
    };

    // Чей ход по счёту: чётные достаются первому, нечётные — второму.
    let turn = |n: i64| if n % 2 == 0 { first } else { second };

    let bans = actions.iter().filter(|a| a.kind == "ban").count() as i64;
    if bans < bans_total * 2 {
        return Phase::Ban {
            actor: turn(bans),
            done: bans,
            total: bans_total * 2,
        };
    }

    // Победа набрана — матч сыгран.
    if m.score_a >= target || m.score_b >= target {
        let winner = if m.score_a >= target {
            m.player_a
        } else {
            m.player_b
        };
        return Phase::Finished { winner };
    }

    let picks = actions.iter().filter(|a| a.kind == "pick").count() as i64;
    let results = actions.iter().filter(|a| a.kind == "result").count() as i64;

    // Пик без результата: карта играется прямо сейчас.
    if picks > results {
        let slot_label = actions
            .iter()
            .filter(|a| a.kind == "pick")
            .next_back()
            .map(|a| a.slot_label.clone())
            .unwrap_or_default();
        return Phase::Result { slot_label };
    }

    Phase::Pick {
        actor: turn(bans + picks),
    }
}

/// Тайбрейк открывается, когда обоим осталась одна победа.
fn tiebreaker_open(score_a: i64, score_b: i64, target: i64) -> bool {
    score_a == target - 1 && score_b == target - 1
}

/// Строки маппула с их состоянием.
fn rows_of(
    conn: &Connection,
    m: &Match,
    target: i64,
    actions: &[MatchAction],
) -> Result<Vec<MatchRow>> {
    let Some(pool_id) = m.pool_id else {
        return Ok(Vec::new());
    };

    let pool = super::pools::get(conn, pool_id)?;
    let tb_open = tiebreaker_open(m.score_a, m.score_b, target);
    let playing = actions
        .iter()
        .filter(|a| a.kind == "pick")
        .next_back()
        .filter(|pick| {
            !actions
                .iter()
                .any(|a| a.kind == "result" && a.slot_label == pick.slot_label)
        })
        .map(|a| a.slot_label.clone());

    let mut out = Vec::with_capacity(pool.slots.len());
    for slot in &pool.slots {
        let ban = actions
            .iter()
            .find(|a| a.kind == "ban" && a.slot_label == slot.slot_label);
        let result = actions
            .iter()
            .find(|a| a.kind == "result" && a.slot_label == slot.slot_label);
        let pick = actions
            .iter()
            .find(|a| a.kind == "pick" && a.slot_label == slot.slot_label);

        let state = if let Some(r) = result {
            RowState::Played {
                winner: r.winner_id,
                n: r.n,
            }
        } else if playing.as_deref() == Some(slot.slot_label.as_str()) {
            RowState::Playing {
                by: pick.and_then(|p| p.actor_id),
            }
        } else if let Some(b) = ban {
            RowState::Banned {
                by: b.actor_id,
                n: b.n,
            }
        } else if slot.mod_tag == "TB" && !tb_open {
            RowState::Locked {
                hint: "Откроется при равном счёте в шаге от победы".to_string(),
            }
        } else {
            RowState::Free
        };

        out.push(MatchRow {
            slot_label: slot.slot_label.clone(),
            mod_tag: slot.mod_tag.clone(),
            beatmap: slot.beatmap.clone(),
            star_rating_with_mods: slot.star_rating_with_mods,
            state,
        });
    }
    Ok(out)
}

/// Всё состояние экрана матча.
pub fn state(conn: &Connection, match_id: i64) -> Result<MatchState> {
    let m = get(conn, match_id)?;
    let t = super::tournaments::get(conn, m.tournament_id)?;
    let target = t.target_score.at(m.round);
    let bans = t.bans_per_round.at(m.round);

    let actions = actions(conn, match_id)?;
    let phase = phase_of(&m, target, bans, &actions);
    let rows = rows_of(conn, &m, target, &actions)?;

    // Матчпоинт — это «осталась одна победа», а у доигранного матча впереди
    // ничего не осталось: у проигравшего при 4:3 метка висела бы как насмешка.
    let mut match_point = Vec::new();
    if !matches!(phase, Phase::Finished { .. }) {
        if m.score_a == target - 1 {
            match_point.extend(m.player_a);
        }
        if m.score_b == target - 1 {
            match_point.extend(m.player_b);
        }
    }

    Ok(MatchState {
        tournament_name: t.name.clone(),
        players: t
            .players
            .iter()
            .filter(|p| Some(p.player_id) == m.player_a || Some(p.player_id) == m.player_b)
            .cloned()
            .collect(),
        rows,
        actions,
        phase,
        target,
        match_point,
        match_info: m,
    })
}

// ──────────────────────────────────────────────────────────── действия

/// Дописывает действие в конец журнала. Номера идут строго с единицы
/// без пропусков — на этом держится и отмена, и нумерация в интерфейсе.
fn push(
    conn: &Connection,
    match_id: i64,
    kind: &str,
    actor: Option<i64>,
    slot_label: &str,
    winner: Option<i64>,
) -> Result<()> {
    let n: i64 = conn.query_row(
        "SELECT COALESCE(MAX(n), 0) + 1 FROM match_actions WHERE match_id = ?1",
        params![match_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO match_actions (match_id, n, type, actor_id, slot_label, winner_id, at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))",
        params![match_id, n, kind, actor, slot_label, winner],
    )?;
    Ok(())
}

/// Строка должна быть в маппуле и ещё свободна: банить забаненное или
/// пикать сыгранное — это ошибка ввода, а не состояние матча.
fn free_row(state: &MatchState, slot_label: &str) -> Result<()> {
    let row = state
        .rows
        .iter()
        .find(|r| r.slot_label == slot_label)
        .ok_or_else(|| anyhow::anyhow!("в маппуле нет строки {slot_label}"))?;

    match row.state {
        RowState::Free => Ok(()),
        RowState::Locked { .. } => Err(anyhow::anyhow!("{slot_label} ещё закрыт")),
        _ => Err(anyhow::anyhow!("{slot_label} уже разыгран")),
    }
}

pub fn ban(conn: &Connection, match_id: i64, slot_label: &str) -> Result<()> {
    let st = state(conn, match_id)?;
    let Phase::Ban { actor, .. } = st.phase else {
        anyhow::bail!("сейчас не фаза банов");
    };
    free_row(&st, slot_label)?;
    push(conn, match_id, "ban", Some(actor), slot_label, None)
}

pub fn pick(conn: &Connection, match_id: i64, slot_label: &str) -> Result<()> {
    let st = state(conn, match_id)?;
    let Phase::Pick { actor } = st.phase else {
        anyhow::bail!("сейчас не фаза пиков");
    };
    free_row(&st, slot_label)?;
    push(conn, match_id, "pick", Some(actor), slot_label, None)
}

/// Кто выиграл текущую карту. Если после этого набралась победа —
/// матч закрывается и победитель уходит дальше по сетке.
pub fn result(conn: &Connection, match_id: i64, winner_id: i64) -> Result<()> {
    let st = state(conn, match_id)?;
    let Phase::Result { slot_label } = st.phase else {
        anyhow::bail!("сейчас нечего засчитывать: карта не пикнута");
    };

    let m = &st.match_info;
    anyhow::ensure!(
        m.player_a == Some(winner_id) || m.player_b == Some(winner_id),
        "этот игрок не участвует в матче"
    );

    push(
        conn,
        match_id,
        "result",
        None,
        &slot_label,
        Some(winner_id),
    )?;

    // Пересчитываем: победа могла оказаться последней.
    let after = state(conn, match_id)?;
    if let Phase::Finished { winner: Some(w) } = after.phase {
        close(conn, match_id, w, false)?;
    }
    Ok(())
}

/// Отменяет последнее действие. Нажимать можно сколько угодно раз подряд:
/// журнал укорачивается с конца, а состояние считается заново.
pub fn undo(conn: &Connection, match_id: i64) -> Result<()> {
    let last: Option<i64> = conn
        .query_row(
            "SELECT MAX(n) FROM match_actions WHERE match_id = ?1",
            params![match_id],
            |r| r.get(0),
        )
        .ok()
        .flatten();

    let Some(n) = last else {
        return Ok(());
    };

    conn.execute(
        "DELETE FROM match_actions WHERE match_id = ?1 AND n = ?2",
        params![match_id, n],
    )?;

    // Матч мог быть закрыт этим действием — открываем обратно вместе
    // с местами в следующих матчах сетки.
    reopen(conn, match_id)?;
    Ok(())
}

/// Закрывает матч и продвигает победителя по сетке. Если этот матч был
/// Закрывает матч и продвигает победителя по сетке. Если этот матч был
/// последним — закрывает и турнир: искать «завершить» глазами не нужно.
fn close(conn: &Connection, match_id: i64, winner_id: i64, walkover: bool) -> Result<()> {
    conn.execute(
        "UPDATE matches
            SET status = 'finished', winner_id = ?2, is_walkover = ?3,
                finished_at = datetime('now')
          WHERE id = ?1",
        params![match_id, winner_id, walkover as i64],
    )?;
    super::tournaments::promote(conn, match_id)?;

    let m = get(conn, match_id)?;
    super::tournaments::advance_walkovers(conn, m.tournament_id)?;
    super::tournaments::finish_if_done(conn, m.tournament_id)?;
    Ok(())
}

/// Возвращает матч в игру: убирает его результат и вычищает игроков,
/// которых он успел рассадить по следующим матчам.
fn reopen(conn: &Connection, match_id: i64) -> Result<()> {
    let m = get(conn, match_id)?;
    let Some(winner) = m.winner_id else {
        return Ok(());
    };
    let loser = if m.player_a == Some(winner) {
        m.player_b
    } else {
        m.player_a
    };

    for (next, who) in [(m.next_win_slot, Some(winner)), (m.next_lose_slot, loser)] {
        let (Some(next), Some(who)) = (next, who) else {
            continue;
        };
        // Если следующий матч уже сыгран, откат сломал бы его историю.
        let started: i64 = conn.query_row(
            "SELECT COUNT(*) FROM match_actions WHERE match_id = ?1",
            params![next],
            |r| r.get(0),
        )?;
        anyhow::ensure!(
            started == 0,
            "следующий матч уже начали — сначала отмени его"
        );

        conn.execute(
            "UPDATE matches
                SET player_a = CASE WHEN player_a = ?2 THEN NULL ELSE player_a END,
                    player_b = CASE WHEN player_b = ?2 THEN NULL ELSE player_b END
              WHERE id = ?1",
            params![next, who],
        )?;
    }

    conn.execute(
        "UPDATE matches
            SET status = 'running', winner_id = NULL, is_walkover = 0, finished_at = NULL
          WHERE id = ?1",
        params![match_id],
    )?;

    // Этот матч мог быть последним в сетке — тогда турнир уже подвёл итоги.
    super::tournaments::reopen_if_finished(conn, m.tournament_id)?;
    Ok(())
}

/// Техническая победа: карты не игрались, в покартовую статистику матч
/// не попадёт.
pub fn walkover(conn: &Connection, match_id: i64, winner_id: i64) -> Result<()> {
    let m = get(conn, match_id)?;
    anyhow::ensure!(
        m.player_a == Some(winner_id) || m.player_b == Some(winner_id),
        "этот игрок не участвует в матче"
    );
    close(conn, match_id, winner_id, true)
}

/// Ручной режим — на крайний случай: счёт ставится как есть, матч
/// помечается отредактированным.
pub fn set_manual_result(
    conn: &Connection,
    match_id: i64,
    winner_id: i64,
    score_a: i64,
    score_b: i64,
) -> Result<()> {
    let m = get(conn, match_id)?;
    anyhow::ensure!(
        m.player_a == Some(winner_id) || m.player_b == Some(winner_id),
        "этот игрок не участвует в матче"
    );
    anyhow::ensure!(score_a >= 0 && score_b >= 0, "счёт не может быть отрицательным");

    // Журнал заменяем целиком: иначе счёт разошёлся бы с историей карт.
    conn.execute(
        "DELETE FROM match_actions WHERE match_id = ?1",
        params![match_id],
    )?;
    conn.execute(
        "UPDATE matches SET is_manual_edit = 1 WHERE id = ?1",
        params![match_id],
    )?;

    for (winner, count) in [(m.player_a, score_a), (m.player_b, score_b)] {
        for _ in 0..count {
            push(conn, match_id, "result", None, "—", winner)?;
        }
    }
    close(conn, match_id, winner_id, false)
}

