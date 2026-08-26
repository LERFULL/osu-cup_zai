//! Турниры: состав, сетка, продвижение по ней.

use anyhow::Result;
use rusqlite::{params, Connection};

use super::bracket;
use crate::model::{
    round_key, Bracket, ByRound, EditorBye, EditorCheck, EditorRound, EditorState, Match,
    RuleProblem, Standing, Tournament, TournamentEdit, TournamentPlayer,
};

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
        target_score: row.get("target_score")?,
        bans_each: row.get("bans_each")?,
        lobby_id: row.get("lobby_id")?,
        score_a: 0,
        score_b: 0,
        bonus_a: 0,
        bonus_b: 0,
    })
}

/// Счёт по картам берём из действий: он всегда согласован с историей.
///
/// Преимущество сетки идёт отдельным полем, а не прибавкой к счёту: матч
/// оно решает, но сыгранной картой не является, и в покартовую статистику
/// ему попадать нельзя.
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
    m.bonus_a = 0;
    m.bonus_b = 0;

    if m.bracket != "grand" {
        return Ok(());
    }

    let advantage: i64 = conn.query_row(
        "SELECT grand_advantage FROM tournaments WHERE id = ?1",
        params![m.tournament_id],
        |r| r.get(0),
    )?;
    if advantage <= 0 {
        return Ok(());
    }

    // Преимущество достаётся тому, кто приехал сюда из верхней сетки.
    let from_upper: Option<i64> = conn
        .query_row(
            "SELECT winner_id FROM matches
              WHERE tournament_id = ?1 AND bracket = 'upper' AND next_win_slot = ?2
              LIMIT 1",
            params![m.tournament_id, m.id],
            |r| r.get(0),
        )
        .ok()
        .flatten();

    if from_upper.is_some() && from_upper == m.player_a {
        m.bonus_a = advantage;
    } else if from_upper.is_some() && from_upper == m.player_b {
        m.bonus_b = advantage;
    }
    Ok(())
}

fn by_round(raw: &str, fallback: i64) -> ByRound {
    serde_json::from_str(raw).unwrap_or_else(|_| ByRound::new(fallback))
}

/// JSON-поле, которого может не быть: старая запись читается как пустая.
fn json_or_default<T: Default + serde::de::DeserializeOwned>(raw: Option<String>) -> T {
    raw.and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn row_to_tournament(row: &rusqlite::Row) -> rusqlite::Result<Tournament> {
    let prize_raw: Option<String> = row.get("prize")?;
    Ok(Tournament {
        id: row.get("id")?,
        name: row.get("name")?,
        status: row.get("status")?,
        bracket_size: row.get("bracket_size")?,
        target_score: by_round(&row.get::<_, String>("target_score")?, 4),
        bans_per_round: by_round(&row.get::<_, String>("bans_per_round")?, 1),
        first_ban: row.get("first_ban")?,
        no_repeat_pool: row.get::<_, i64>("no_repeat_pool")? != 0,
        pool_by_round: json_or_default(row.get("pool_by_round")?),
        grand_advantage: row.get("grand_advantage")?,
        bye_seeds: json_or_default(row.get("bye_seeds")?),
        created_at: row.get("created_at")?,
        finished_at: row.get("finished_at")?,
        prize: prize_raw.and_then(|s| serde_json::from_str(&s).ok()),
        players: Vec::new(),
        pool_ids: Vec::new(),
    })
}

const COLS: &str = "id, name, status, bracket_size, target_score, bans_per_round, \
                    first_ban, no_repeat_pool, pool_by_round, grand_advantage, \
                    bye_seeds, created_at, finished_at, prize";

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
        "SELECT tp.player_id, p.nickname, tp.seed, tp.color, p.avatar_path, tp.placement, tp.is_rookie
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
            avatar_path: r.get(4)?,
            placement: r.get(5)?,
            is_rookie: r.get::<_, i64>(6)? != 0,
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

/// Правила матчей. Правятся всегда: будущие раунды не зависят от того,
/// что уже сыграли, а правило идущего матча взято на его старте.
pub fn set_rules(
    conn: &Connection,
    id: i64,
    target: &ByRound,
    bans: &ByRound,
    first_ban: &str,
    no_repeat_pool: bool,
) -> Result<()> {
    anyhow::ensure!(
        target.default >= 1 && target.default <= 16,
        "до скольких побед — от одной до шестнадцати"
    );
    anyhow::ensure!(
        bans.default >= 0 && bans.default <= 8,
        "банов на игрока — от нуля до восьми"
    );
    anyhow::ensure!(
        matches!(first_ban, "random" | "higherSeed" | "lowerSeed"),
        "непонятно, кто банит первым"
    );

    let before = snapshot(conn, id)?;
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
    push_edit(conn, id, "rules", false, "правила матчей", before)?;
    Ok(())
}

/// Исключение по раунду: своё правило вместо общего. `None` — вернуть общее.
pub fn set_round_rule(
    conn: &Connection,
    id: i64,
    key: &str,
    target: Option<i64>,
    bans: Option<i64>,
) -> Result<()> {
    let t = get(conn, id)?;
    let mut target_rule = t.target_score;
    let mut bans_rule = t.bans_per_round;

    if let Some(value) = target {
        anyhow::ensure!(
            (1..=16).contains(&value),
            "до скольких побед — от одной до шестнадцати"
        );
        // Преимущество сетки не должно выигрывать матч до первой карты.
        if key.starts_with("grand") {
            anyhow::ensure!(
                value > t.grand_advantage,
                "при преимуществе {} играть до {} побед нельзя: матч выигран до первой карты",
                t.grand_advantage,
                value
            );
        }
        target_rule.rounds.insert(key.to_string(), value);
    } else {
        target_rule.rounds.remove(key);
    }

    if let Some(value) = bans {
        anyhow::ensure!(
            (0..=8).contains(&value),
            "банов на игрока — от нуля до восьми"
        );
        bans_rule.rounds.insert(key.to_string(), value);
    } else {
        bans_rule.rounds.remove(key);
    }

    let before = snapshot(conn, id)?;
    conn.execute(
        "UPDATE tournaments SET target_score = ?2, bans_per_round = ?3 WHERE id = ?1",
        params![
            id,
            serde_json::to_string(&target_rule)?,
            serde_json::to_string(&bans_rule)?,
        ],
    )?;

    let title = round_title_of(conn, id, key)?;
    push_edit(
        conn,
        id,
        "rules",
        false,
        &format!("правило раунда «{title}»"),
        before,
    )?;
    Ok(())
}

/// Преимущество сетки в гранд-финале.
pub fn set_grand_advantage(conn: &Connection, id: i64, value: i64) -> Result<()> {
    anyhow::ensure!((0..=3).contains(&value), "преимущество сетки — от нуля до трёх");

    let t = get(conn, id)?;
    let target = t.target_score.at_key("grand", 1);
    anyhow::ensure!(
        value < target,
        "гранд-финал играется до {target} побед — преимущество {value} выиграло бы его до первой карты"
    );

    // Пока гранд-финал не начат, это обычная правка: счёт ещё не сложился.
    let started: i64 = conn.query_row(
        "SELECT COUNT(*) FROM matches m
           JOIN match_actions a ON a.match_id = m.id
          WHERE m.tournament_id = ?1 AND m.bracket = 'grand'",
        params![id],
        |r| r.get(0),
    )?;
    anyhow::ensure!(
        started == 0,
        "гранд-финал уже играется — преимущество в нём менять поздно"
    );

    let before = snapshot(conn, id)?;
    conn.execute(
        "UPDATE tournaments SET grand_advantage = ?2 WHERE id = ?1",
        params![id, value],
    )?;
    push_edit(
        conn,
        id,
        "grandAdvantage",
        false,
        &format!("преимущество сетки — {value}"),
        before,
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM tournaments WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn status_of(conn: &Connection, id: i64) -> Result<String> {
    Ok(conn.query_row(
        "SELECT status FROM tournaments WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )?)
}

/// Правка состава и сетки. До старта — свободно, после — только аварийная.
/// Возвращает, идёт ли турнир: правка живого попадёт в журнал как аварийная.
pub fn structural(conn: &Connection, id: i64, emergency: bool) -> Result<bool> {
    let status = status_of(conn, id)?;
    // Остановленный считается начатым: в нём уже играли, и пересобирать его
    // состав так же опасно, как у идущего.
    let live = status == "running" || status == "finished" || status == "stopped";
    anyhow::ensure!(
        !live || emergency,
        "турнир уже идёт — включи аварийную правку, чтобы менять состав и сетку"
    );
    Ok(live)
}

/// Сетку можно строить заново, пока турнир не запущен: у построенной,
/// но не утверждённой достаточно поменять сеяние и скатать ещё раз.
fn seedable(conn: &Connection, id: i64) -> Result<()> {
    let status = status_of(conn, id)?;
    anyhow::ensure!(
        status == "draft" || status == "seeded",
        "турнир уже идёт — пересобрать сетку значит потерять результаты"
    );
    Ok(())
}

/// Пересобирает сетку, если она уже построена: правка состава должна быть
/// видна на сетке сразу, а не после отдельного нажатия.
fn rebuild_if_seeded(conn: &Connection, id: i64) -> Result<()> {
    if status_of(conn, id)? == "seeded" {
        build_bracket(conn, id)?;
    }
    Ok(())
}

pub fn add_player(
    conn: &Connection,
    tournament_id: i64,
    player_id: i64,
    emergency: bool,
) -> Result<()> {
    let live = structural(conn, tournament_id, emergency)?;
    let before = snapshot(conn, tournament_id)?;

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

    let seat: i64 = conn.query_row(
        "SELECT COUNT(*) + 1 FROM tournament_players WHERE tournament_id = ?1",
        params![tournament_id],
        |r| r.get(0),
    )?;

    let added = conn.execute(
        "INSERT OR IGNORE INTO tournament_players (tournament_id, player_id, color, seed)
         VALUES (?1, ?2, ?3, ?4)",
        params![tournament_id, player_id, color, seat],
    )?;
    if added == 0 {
        return Ok(());
    }

    rebuild_if_seeded(conn, tournament_id)?;
    let nick = nickname(conn, player_id)?;
    push_edit(
        conn,
        tournament_id,
        "playersAdd",
        live,
        &format!("добавлен {nick}"),
        before,
    )?;
    Ok(())
}

pub fn remove_player(
    conn: &Connection,
    tournament_id: i64,
    player_id: i64,
    emergency: bool,
) -> Result<()> {
    let live = structural(conn, tournament_id, emergency)?;

    // В идущем турнире имя игрока держится на его строке в составе: убрав её,
    // мы бы стёрли подпись у сыгранных матчей. Поэтому сыгравшего не убираем —
    // сначала надо снести его результаты.
    if live {
        let played: i64 = conn.query_row(
            "SELECT COUNT(*) FROM matches m
              WHERE m.tournament_id = ?1
                AND (m.player_a = ?2 OR m.player_b = ?2)
                AND (m.status = 'finished'
                     OR EXISTS (SELECT 1 FROM match_actions a WHERE a.match_id = m.id))",
            params![tournament_id, player_id],
            |r| r.get(0),
        )?;
        anyhow::ensure!(
            played == 0,
            "{} уже играл в этом турнире — сначала снеси его результаты",
            nickname(conn, player_id)?
        );
    }

    let before = snapshot(conn, tournament_id)?;

    let gone = conn.execute(
        "DELETE FROM tournament_players WHERE tournament_id = ?1 AND player_id = ?2",
        params![tournament_id, player_id],
    )?;
    if gone == 0 {
        return Ok(());
    }

    // Место в несыгранном матче освобождаем: пустое честнее, чем чужое имя.
    conn.execute(
        "UPDATE matches
            SET player_a = CASE WHEN player_a = ?2 THEN NULL ELSE player_a END,
                player_b = CASE WHEN player_b = ?2 THEN NULL ELSE player_b END
          WHERE tournament_id = ?1 AND status <> 'finished'
            AND NOT EXISTS (SELECT 1 FROM match_actions a WHERE a.match_id = matches.id)",
        params![tournament_id, player_id],
    )?;

    renumber_seeds(conn, tournament_id)?;
    rebuild_if_seeded(conn, tournament_id)?;

    let nick = nickname(conn, player_id)?;
    push_edit(
        conn,
        tournament_id,
        "playersRemove",
        live,
        &format!("убран {nick}"),
        before,
    )?;
    Ok(())
}

fn nickname(conn: &Connection, player_id: i64) -> Result<String> {
    Ok(conn
        .query_row(
            "SELECT nickname FROM players WHERE id = ?1",
            params![player_id],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "игрок".to_string()))
}

/// Номера сеяния подряд с первого: после удаления в них появляется дыра,
/// а сеяние — это порядок, а не метка.
fn renumber_seeds(conn: &Connection, tournament_id: i64) -> Result<()> {
    let order: Vec<i64> = players_of(conn, tournament_id)?
        .into_iter()
        .map(|p| p.player_id)
        .collect();
    write_seeds(conn, tournament_id, &order)
}

fn write_seeds(conn: &Connection, tournament_id: i64, order: &[i64]) -> Result<()> {
    for (i, player_id) in order.iter().enumerate() {
        conn.execute(
            "UPDATE tournament_players SET seed = ?3
              WHERE tournament_id = ?1 AND player_id = ?2",
            params![tournament_id, player_id, i as i64 + 1],
        )?;
    }
    Ok(())
}

/// Сеяние: порядок в списке задаёт номера с первого.
pub fn set_seeds(
    conn: &Connection,
    tournament_id: i64,
    order: &[i64],
    emergency: bool,
) -> Result<()> {
    let live = structural(conn, tournament_id, emergency)?;
    let before = snapshot(conn, tournament_id)?;
    write_seeds(conn, tournament_id, order)?;
    rebuild_if_seeded(conn, tournament_id)?;
    push_edit(conn, tournament_id, "seeds", live, "сеяние", before)?;
    Ok(())
}

/// Меняет местами двух игроков сетки. Пересчитывается сеяние: место в первом
/// раунде из него и следует.
pub fn swap_seeds(conn: &Connection, tournament_id: i64, a: i64, b: i64, emergency: bool) -> Result<()> {
    anyhow::ensure!(a != b, "это один и тот же игрок");
    let live = structural(conn, tournament_id, emergency)?;
    let before = snapshot(conn, tournament_id)?;

    let mut order: Vec<i64> = players_of(conn, tournament_id)?
        .into_iter()
        .map(|p| p.player_id)
        .collect();
    let (Some(ia), Some(ib)) = (
        order.iter().position(|x| *x == a),
        order.iter().position(|x| *x == b),
    ) else {
        anyhow::bail!("игрок не участвует в турнире");
    };
    order.swap(ia, ib);

    write_seeds(conn, tournament_id, &order)?;
    rebuild_if_seeded(conn, tournament_id)?;
    push_edit(
        conn,
        tournament_id,
        "seeds",
        live,
        &format!("{} ↔ {}", nickname(conn, a)?, nickname(conn, b)?),
        before,
    )?;
    Ok(())
}

/// Сажает игрока на место сеяния: если он ещё не в турнире — заводит его там.
pub fn place_player(
    conn: &Connection,
    tournament_id: i64,
    player_id: i64,
    seed: i64,
    emergency: bool,
) -> Result<()> {
    let already: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tournament_players WHERE tournament_id = ?1 AND player_id = ?2",
        params![tournament_id, player_id],
        |r| r.get(0),
    )?;
    if already == 0 {
        add_player(conn, tournament_id, player_id, emergency)?;
    }

    let live = structural(conn, tournament_id, emergency)?;
    let before = snapshot(conn, tournament_id)?;

    let mut order: Vec<i64> = players_of(conn, tournament_id)?
        .into_iter()
        .map(|p| p.player_id)
        .filter(|x| *x != player_id)
        .collect();
    let at = (seed.max(1) as usize - 1).min(order.len());
    order.insert(at, player_id);

    write_seeds(conn, tournament_id, &order)?;
    rebuild_if_seeded(conn, tournament_id)?;
    push_edit(
        conn,
        tournament_id,
        "seeds",
        live,
        &format!("{} на {}-е сеяние", nickname(conn, player_id)?, at + 1),
        before,
    )?;
    Ok(())
}

/// Случайное сеяние. Сетка при этом пересобирается: перемешать состав и
/// оставить старые пары — значит соврать.
pub fn shuffle_seeds(conn: &Connection, tournament_id: i64, emergency: bool) -> Result<()> {
    let live = structural(conn, tournament_id, emergency)?;
    let before = snapshot(conn, tournament_id)?;

    let mut order: Vec<i64> = players_of(conn, tournament_id)?
        .into_iter()
        .map(|p| p.player_id)
        .collect();

    // Тасование Фишера — Йетса на случайных числах SQLite: своего генератора
    // в зависимостях нет, а random() здесь под рукой.
    for i in (1..order.len()).rev() {
        let roll: i64 = conn.query_row("SELECT ABS(RANDOM())", [], |r| r.get(0))?;
        let j = (roll as usize) % (i + 1);
        order.swap(i, j);
    }

    write_seeds(conn, tournament_id, &order)?;
    rebuild_if_seeded(conn, tournament_id)?;
    push_edit(conn, tournament_id, "seeds", live, "сеяние перемешано", before)?;
    Ok(())
}

pub fn set_player_color(
    conn: &Connection,
    tournament_id: i64,
    player_id: i64,
    color: &str,
) -> Result<()> {
    let before = snapshot(conn, tournament_id)?;
    conn.execute(
        "UPDATE tournament_players SET color = ?3 WHERE tournament_id = ?1 AND player_id = ?2",
        params![tournament_id, player_id, color],
    )?;
    push_edit(
        conn,
        tournament_id,
        "playerColor",
        false,
        &format!("цвет {}", nickname(conn, player_id)?),
        before,
    )?;
    Ok(())
}

pub fn set_pools(conn: &Connection, tournament_id: i64, pool_ids: &[i64]) -> Result<()> {
    let before = snapshot(conn, tournament_id)?;

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

    // Маппул, убранный из турнира, не может оставаться закреплённым за раундом:
    // привязка, ведущая в никуда, хуже её отсутствия.
    drop_missing_bindings(conn, tournament_id, pool_ids)?;
    reassign_pools(conn, tournament_id)?;
    push_edit(conn, tournament_id, "pools", false, "список маппулов", before)?;
    Ok(())
}

/// Убирает привязки к маппулам, которых в турнире больше нет.
fn drop_missing_bindings(conn: &Connection, tournament_id: i64, pool_ids: &[i64]) -> Result<()> {
    let t = get(conn, tournament_id)?;
    let kept: std::collections::HashMap<String, i64> = t
        .pool_by_round
        .into_iter()
        .filter(|(_, pool)| pool_ids.contains(pool))
        .collect();
    conn.execute(
        "UPDATE tournaments SET pool_by_round = ?2 WHERE id = ?1",
        params![tournament_id, serde_json::to_string(&kept)?],
    )?;
    Ok(())
}

/// Закрепляет маппул за раундом. `None` — «любой свободный».
pub fn set_round_pool(
    conn: &Connection,
    tournament_id: i64,
    key: &str,
    pool_id: Option<i64>,
) -> Result<()> {
    let before = snapshot(conn, tournament_id)?;
    let t = get(conn, tournament_id)?;
    let mut map = t.pool_by_round.clone();

    match pool_id {
        Some(pool) => {
            // Пул, привязанный к раунду, но не добавленный в турнир,
            // добавляется сам: иначе привязка не сработает молча.
            if !t.pool_ids.contains(&pool) {
                let at = t.pool_ids.len() as i64;
                conn.execute(
                    "INSERT OR IGNORE INTO tournament_pools (tournament_id, pool_id, position)
                     VALUES (?1, ?2, ?3)",
                    params![tournament_id, pool, at],
                )?;
            }
            map.insert(key.to_string(), pool);
        }
        None => {
            map.remove(key);
        }
    }

    conn.execute(
        "UPDATE tournaments SET pool_by_round = ?2 WHERE id = ?1",
        params![tournament_id, serde_json::to_string(&map)?],
    )?;
    reassign_pools(conn, tournament_id)?;

    let title = round_title_of(conn, tournament_id, key)?;
    push_edit(
        conn,
        tournament_id,
        "pools",
        false,
        &format!("маппул раунда «{title}»"),
        before,
    )?;
    Ok(())
}

/// Берёт маппулы серии по порядку и раскладывает по раундам турнира.
pub fn add_series(conn: &Connection, tournament_id: i64, series_id: i64) -> Result<()> {
    let pools = super::series::live_pool_ids(conn, series_id)?;
    anyhow::ensure!(!pools.is_empty(), "в серии нет маппулов");

    let before = snapshot(conn, tournament_id)?;
    let t = get(conn, tournament_id)?;

    let mut list = t.pool_ids.clone();
    for pool in &pools {
        if !list.contains(pool) {
            list.push(*pool);
        }
    }
    conn.execute(
        "DELETE FROM tournament_pools WHERE tournament_id = ?1",
        params![tournament_id],
    )?;
    for (i, pool_id) in list.iter().enumerate() {
        conn.execute(
            "INSERT INTO tournament_pools (tournament_id, pool_id, position) VALUES (?1, ?2, ?3)",
            params![tournament_id, pool_id, i as i64],
        )?;
    }

    // Раунды в порядке игры получают пулы серии по порядку: серия под турнир
    // и собирается по раундам, и ручная раскладка тут только мешала бы.
    let mut map = t.pool_by_round.clone();
    let after = get(conn, tournament_id)?;
    for (i, round) in round_rules(conn, &after)?.into_iter().enumerate() {
        let Some(pool) = pools.get(i) else { break };
        map.insert(round.key, *pool);
    }
    conn.execute(
        "UPDATE tournaments SET pool_by_round = ?2 WHERE id = ?1",
        params![tournament_id, serde_json::to_string(&map)?],
    )?;
    reassign_pools(conn, tournament_id)?;

    let name: String = conn
        .query_row(
            "SELECT name FROM series WHERE id = ?1",
            params![series_id],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "серия".to_string());
    push_edit(
        conn,
        tournament_id,
        "pools",
        false,
        &format!("серия «{name}» разложена по раундам"),
        before,
    )?;
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

/// Строит сетку и показывает её на утверждение.
///
/// Турнир при этом не начинается: сетку можно рассмотреть, пересобрать
/// с другим сеянием или вернуть в черновик. Матчи играются только после
/// `confirm` — иначе первый же взгляд на неудачную сетку был бы поздним.
///
/// Вызывать внутри транзакции: матчи вставляются пачкой и связываются
/// вторым проходом, а половина сетки — это не сетка.
pub fn start(conn: &Connection, id: i64) -> Result<()> {
    seedable(conn, id)?;
    let before = snapshot(conn, id)?;
    build_bracket(conn, id)?;
    push_edit(conn, id, "bracketRebuild", false, "сетка собрана заново", before)?;
    Ok(())
}

/// Собственно построение: без журнала и без проверки статуса — их делают
/// вызывающие. Правка состава пересобирает сетку этой же функцией.
fn build_bracket(conn: &Connection, id: i64) -> Result<()> {
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

    // Кто прошёл первый раунд без игры: в сетке его матча нет, а знать об
    // этом надо — и при показе, и при проверке правок.
    let byes: Vec<i64> = players
        .iter()
        .enumerate()
        .filter(|(i, p)| {
            let seat = p.seed.unwrap_or(*i as i64 + 1);
            !seats.iter().any(|s| {
                s.bracket == "upper"
                    && s.round == 1
                    && (s.player_a == Some(p.player_id) || s.player_b == Some(p.player_id))
            }) && seat >= 1
        })
        .map(|(i, p)| p.seed.unwrap_or(i as i64 + 1))
        .collect();

    conn.execute(
        "UPDATE tournaments
            SET status = CASE WHEN status = 'draft' THEN 'seeded' ELSE status END,
                bracket_size = ?2, bye_seeds = ?3
          WHERE id = ?1",
        params![id, players.len() as i64, serde_json::to_string(&byes)?],
    )?;

    assign_pools(conn, id)?;
    advance_walkovers(conn, id)?;
    Ok(())
}

/// Раздаёт маппулы по матчам заранее и возвращает то, что стоит знать.
///
/// Пакет пулов выбирается на турнире целиком, поэтому спрашивать пул
/// в начале каждого матча незачем: раскладываем их по раундам сразу.
/// Матчи одного раунда играют одним пулом — так раунд сравним внутри
/// себя, — а пулы идут по кругу, то есть возврат к уже сыгранному
/// случается только после всех остальных. Раунд с закреплённым пулом
/// берёт его и в круге не участвует: привязка сильнее правила.
pub fn assign_pools(conn: &Connection, tournament_id: i64) -> Result<Vec<String>> {
    let t = get(conn, tournament_id)?;
    if t.pool_ids.is_empty() {
        return Ok(vec!["Маппулы к турниру не привязаны".to_string()]);
    }

    // Раунды в порядке игры: сначала верхняя сетка, потом нижняя, гранд-финал
    // последним. Ключ — пара (сетка, раунд): у каждого свой пул.
    let stages = stages_of(conn, tournament_id)?;
    let free: Vec<i64> = t
        .pool_ids
        .iter()
        .copied()
        .filter(|pool| !t.pool_by_round.values().any(|bound| bound == pool))
        .collect();
    // Все пулы закреплены — по кругу пойдут они же, иначе раунду без
    // привязки не досталось бы ничего.
    let cycle = if free.is_empty() { &t.pool_ids } else { &free };

    let mut n = 0usize;
    for (bracket, round) in &stages {
        let key = round_key(bracket, *round);
        let pool = match t.pool_by_round.get(&key) {
            Some(bound) => *bound,
            None => {
                let pool = cycle[n % cycle.len()];
                n += 1;
                pool
            }
        };
        conn.execute(
            "UPDATE matches SET pool_id = ?4
              WHERE tournament_id = ?1 AND bracket = ?2 AND round = ?3
                AND pool_id IS NULL",
            params![tournament_id, bracket, round, pool],
        )?;
    }

    let mut notes = Vec::new();
    if t.no_repeat_pool && stages.len() > t.pool_ids.len() {
        notes.push(format!(
            "Раундов {}, а маппулов {} — со второго круга они пойдут по второму разу",
            stages.len(),
            t.pool_ids.len()
        ));
    }
    Ok(notes)
}

/// Раскладывает маппулы заново: у матчей, которые ещё не начинали, привязка
/// снимается и выдаётся снова. Начатые не трогаем — там уже банили по этому
/// маппулу.
fn reassign_pools(conn: &Connection, tournament_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE matches SET pool_id = NULL
          WHERE tournament_id = ?1
            AND NOT EXISTS (SELECT 1 FROM match_actions a WHERE a.match_id = matches.id)
            AND status <> 'finished'",
        params![tournament_id],
    )?;
    assign_pools(conn, tournament_id)?;
    Ok(())
}

/// Раунды турнира в порядке игры.
fn stages_of(conn: &Connection, tournament_id: i64) -> Result<Vec<(String, i64)>> {
    let mut st = conn.prepare(
        "SELECT DISTINCT bracket, round FROM matches
          WHERE tournament_id = ?1
          ORDER BY CASE bracket WHEN 'upper' THEN 0 WHEN 'lower' THEN 1 ELSE 2 END, round",
    )?;
    let rows = st
        .query_map(params![tournament_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Утверждает построенную сетку: с этого момента турнир идёт.
pub fn confirm(conn: &Connection, id: i64) -> Result<()> {
    let status: String = conn.query_row(
        "SELECT status FROM tournaments WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    anyhow::ensure!(
        status == "seeded",
        "запускать можно только построенную, но ещё не начатую сетку"
    );

    // Сломанная призовая лестница не даёт запустить турнир: кто-то
    // заработал бы больше, проиграв раньше, и в эфире это заметят мгновенно.
    super::prize::ensure_startable(conn, id)?;
    super::prize::carry_jackpot(conn, id)?;

    conn.execute(
        "UPDATE tournaments SET status = 'running' WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

/// Останавливает идущий турнир.
///
/// Нужно затем, что турнир не всегда доигрывается: тусовка разошлась, состав
/// поменялся, вечер кончился. До этого выйти из «идёт» было нельзя вовсе —
/// закрыть турнир умел только последний сыгранный матч, и незаконченный висел
/// идущим навсегда. Результаты остаются на месте: остановка — это не отмена.
pub fn stop(conn: &Connection, id: i64) -> Result<()> {
    let status = status_of(conn, id)?;
    anyhow::ensure!(
        status == "running",
        "останавливать можно только идущий турнир"
    );
    conn.execute(
        "UPDATE tournaments SET status = 'stopped' WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

/// Возвращает остановленный турнир в игру.
pub fn resume(conn: &Connection, id: i64) -> Result<()> {
    let status = status_of(conn, id)?;
    anyhow::ensure!(status == "stopped", "продолжать можно только остановленный");
    conn.execute(
        "UPDATE tournaments SET status = 'running' WHERE id = ?1",
        params![id],
    )?;
    // Пока турнир стоял, последний матч могли досудить: тогда продолжать нечего
    // и он закрывается сразу.
    finish_if_done(conn, id)?;
    Ok(())
}

/// Возвращает турнир в черновик вместе со сброшенной сеткой.
/// Разрешено, только пока не сыграно ни одного матча по-настоящему.
pub fn reopen(conn: &Connection, id: i64) -> Result<()> {
    let played: i64 = conn.query_row(
        "SELECT COUNT(*) FROM match_actions a
           JOIN matches m ON m.id = a.match_id
          WHERE m.tournament_id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    anyhow::ensure!(
        played == 0,
        "в сетке уже играли — пересобрать её значит потерять результаты"
    );

    conn.execute("DELETE FROM matches WHERE tournament_id = ?1", params![id])?;
    conn.execute(
        "UPDATE tournaments SET status = 'draft', bracket_size = 0, bye_seeds = NULL
          WHERE id = ?1",
        params![id],
    )?;
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

        if let Some((match_id, winner)) = found {
            conn.execute(
                "UPDATE matches
                    SET status = 'finished', winner_id = ?2, is_walkover = 1,
                        finished_at = datetime('now')
                  WHERE id = ?1",
                params![match_id, winner],
            )?;
            promote(conn, match_id)?;
            continue;
        }

        // Матч, в который уже некому прийти: оба источника закончились
        // техпобедами. Такой матч закрываем без победителя — иначе он
        // навсегда останется «ждёт соперника» и запрёт всё, что за ним.
        let empty: Option<i64> = conn
            .query_row(
                "SELECT id FROM matches m
                  WHERE tournament_id = ?1 AND status = 'pending'
                    AND player_a IS NULL AND player_b IS NULL
                    AND EXISTS (
                      SELECT 1 FROM matches src
                       WHERE src.tournament_id = m.tournament_id
                         AND (src.next_win_slot = m.id OR src.next_lose_slot = m.id)
                    )
                    AND NOT EXISTS (
                      SELECT 1 FROM matches src
                       WHERE src.tournament_id = m.tournament_id
                         AND (src.next_win_slot = m.id OR src.next_lose_slot = m.id)
                         AND src.status <> 'finished'
                    )
                  LIMIT 1",
                params![tournament_id],
                |r| r.get(0),
            )
            .ok();

        let Some(match_id) = empty else {
            break;
        };

        conn.execute(
            "UPDATE matches
                SET status = 'finished', winner_id = NULL, is_walkover = 1,
                    finished_at = datetime('now')
              WHERE id = ?1",
            params![match_id],
        )?;
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

    let problems = rule_problems(conn, &tournament)?;
    let standings = if tournament.status == "finished" {
        standings(conn, &tournament, &matches)?
    } else {
        Vec::new()
    };

    Ok(Bracket {
        tournament,
        matches,
        problems,
        standings,
    })
}

/// Название раунда — то же, что подписано на сетке, но с указанием ряда:
/// в таблице раундов «Полуфинал» без него встречается дважды, а какой из них
/// верхний, читателю не видно.
pub fn round_title(bracket: &str, round: i64, last: i64) -> String {
    if bracket == "grand" {
        return "Гранд-финал".to_string();
    }
    let upper = bracket == "upper";
    match last - round {
        0 if upper => "Финал верхней".to_string(),
        0 => "Финал нижней".to_string(),
        1 if upper => "Верхняя, полуфинал".to_string(),
        1 => "Нижняя, полуфинал".to_string(),
        _ if upper => format!("Верхняя, раунд {round}"),
        _ => format!("Нижняя, раунд {round}"),
    }
}

/// Название раунда по его ключу — для журнала правок и предупреждений.
fn round_title_of(conn: &Connection, tournament_id: i64, key: &str) -> Result<String> {
    let t = get(conn, tournament_id)?;
    Ok(round_rules(conn, &t)?
        .into_iter()
        .find(|r| r.key == key)
        .map(|r| r.title)
        .unwrap_or_else(|| key.to_string()))
}

/// Сколько карт в маппуле: играбельных и есть ли тайбрейк.
fn pool_shape(conn: &Connection, pool_id: i64) -> (i64, bool) {
    match super::pools::get(conn, pool_id) {
        Ok(pool) => (
            pool.slots
                .iter()
                .filter(|s| s.mod_tag != "TB" && s.beatmap_id.is_some())
                .count() as i64,
            pool.slots
                .iter()
                .any(|s| s.mod_tag == "TB" && s.beatmap_id.is_some()),
        ),
        Err(_) => (0, false),
    }
}

/// Раунды турнира со своими правилами и маппулами.
///
/// До построения сетки считаются по проектной — той, что получится при
/// текущем составе: править правило финала, ещё не собрав сетку, нормально,
/// а показывать при этом одну строку «общее правило» — нет.
pub fn round_rules(conn: &Connection, t: &Tournament) -> Result<Vec<EditorRound>> {
    let stages = stages_of(conn, t.id)?;
    let stages = if stages.is_empty() {
        projected_stages(t)
    } else {
        stages
    };

    // Последний раунд каждого ряда — по нему подпись понимает, что она финал.
    let last_of = |bracket: &str| -> i64 {
        stages
            .iter()
            .filter(|(b, _)| b == bracket)
            .map(|(_, r)| *r)
            .max()
            .unwrap_or(0)
    };

    let names = pool_names(conn)?;
    let mut out = Vec::with_capacity(stages.len());
    let mut free: Vec<i64> = t
        .pool_ids
        .iter()
        .copied()
        .filter(|pool| !t.pool_by_round.values().any(|bound| bound == pool))
        .collect();
    if free.is_empty() {
        free = t.pool_ids.clone();
    }
    let mut cycle = 0usize;

    for (bracket, round) in &stages {
        let key = round_key(bracket, *round);
        let bound = t.pool_by_round.get(&key).copied();
        let playing = match bound {
            Some(pool) => Some(pool),
            None if free.is_empty() => None,
            None => {
                let pool = free[cycle % free.len()];
                cycle += 1;
                Some(pool)
            }
        };

        // Матч мог получить свой маппул руками — тогда играется он.
        let actual: Option<i64> = conn
            .query_row(
                "SELECT pool_id FROM matches
                  WHERE tournament_id = ?1 AND bracket = ?2 AND round = ?3 AND pool_id IS NOT NULL
                  LIMIT 1",
                params![t.id, bracket, round],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        let playing = actual.or(playing);

        let (playable, has_tiebreaker) = match playing {
            Some(pool) => pool_shape(conn, pool),
            None => (0, false),
        };

        let target = t.target_score.at_key(bracket, *round);
        let bans = t.bans_per_round.at_key(bracket, *round);

        let notes = if playing.is_some() {
            super::feasible::check(super::feasible::Demand {
                playable,
                has_tiebreaker,
                target,
                bans_each: bans,
            })
        } else {
            Vec::new()
        };

        let (matches, played, started) = conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(status = 'finished'), 0),
                    COALESCE(SUM(EXISTS (SELECT 1 FROM match_actions a WHERE a.match_id = m.id)), 0)
               FROM matches m
              WHERE tournament_id = ?1 AND bracket = ?2 AND round = ?3",
            params![t.id, bracket, round],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            },
        )?;

        out.push(EditorRound {
            title: round_title(bracket, *round, last_of(bracket)),
            key,
            bracket: bracket.clone(),
            round: *round,
            target,
            bans,
            target_own: t.target_score.own(bracket, *round).is_some(),
            bans_own: t.bans_per_round.own(bracket, *round).is_some(),
            pool_id: bound,
            playing_pool_id: playing,
            playing_pool_name: playing.and_then(|pool| names.get(&pool).cloned()),
            pool_playable: playable,
            pool_has_tiebreaker: has_tiebreaker,
            matches,
            played,
            started: started > 0,
            notes,
        });
    }
    Ok(out)
}

/// Раунды, которые получатся при текущем составе. Скелет строится в памяти:
/// показать раунды до сборки сетки нужно, а писать их в базу — нет.
fn projected_stages(t: &Tournament) -> Vec<(String, i64)> {
    if t.players.len() < 2 {
        return Vec::new();
    }
    let size = bracket::bracket_size(t.players.len());
    let seats = bracket::build(size, &seat_order(&t.players, size));

    let mut out: Vec<(String, i64)> = Vec::new();
    for seat in &seats {
        let pair = (seat.bracket.to_string(), seat.round);
        if !out.contains(&pair) {
            out.push(pair);
        }
    }
    out.sort_by_key(|(bracket, round)| {
        (
            match bracket.as_str() {
                "upper" => 0,
                "lower" => 1,
                _ => 2,
            },
            *round,
        )
    });
    out
}

/// Названия маппулов: в турнире их немного, а спрашивать по одному в цикле —
/// десятки запросов.
fn pool_names(conn: &Connection) -> Result<std::collections::HashMap<i64, String>> {
    let mut st = conn.prepare("SELECT id, name FROM pools")?;
    let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<std::collections::HashMap<_, _>>>()?)
}

/// Сходятся ли правила с привязанными маппулами.
///
/// И то и другое выбирают здесь же, на экране турнира, и порознь каждое
/// число выглядит разумным: девять карт, по два бана каждому, игра до
/// четырёх побед. Проверяем по раундам: у каждого свой маппул.
pub fn rule_problems(conn: &Connection, t: &Tournament) -> Result<Vec<RuleProblem>> {
    Ok(round_rules(conn, t)?
        .into_iter()
        .filter(|r| !r.notes.is_empty())
        .map(|r| RuleProblem {
            key: r.key,
            title: r.title,
            pool_id: r.playing_pool_id,
            pool_name: r
                .playing_pool_name
                .unwrap_or_else(|| "маппул не выбран".to_string()),
            target: r.target,
            bans_each: r.bans,
            notes: r.notes,
        })
        .collect())
}

/// Итоговая таблица: места и то, чем они добыты.
///
/// Считается по матчам и их журналам, а не по накопленным счётчикам: любая
/// правка турнира сразу видна в итогах, и расходиться им не с чем.
fn standings(conn: &Connection, t: &Tournament, matches: &[Match]) -> Result<Vec<Standing>> {
    let mut out: Vec<Standing> = Vec::with_capacity(t.players.len());

    for p in &t.players {
        let own: Vec<&Match> = matches
            .iter()
            .filter(|m| m.player_a == Some(p.player_id) || m.player_b == Some(p.player_id))
            .collect();

        let mut row = Standing {
            player_id: p.player_id,
            nickname: p.nickname.clone(),
            color: p.color.clone(),
            avatar_path: p.avatar_path.clone(),
            placement: p.placement.unwrap_or(i64::MAX),
            match_wins: 0,
            match_losses: 0,
            map_wins: 0,
            map_losses: 0,
            by_mod: Vec::new(),
            tiebreakers: 0,
            tiebreakers_won: 0,
            walkovers: 0,
            best_streak: 0,
        };

        for m in &own {
            let mine = if m.player_a == Some(p.player_id) {
                m.score_a
            } else {
                m.score_b
            };
            let theirs = if m.player_a == Some(p.player_id) {
                m.score_b
            } else {
                m.score_a
            };
            row.map_wins += mine;
            row.map_losses += theirs;

            if m.status != "finished" || m.winner_id.is_none() {
                continue;
            }
            if m.winner_id == Some(p.player_id) {
                row.match_wins += 1;
                if m.is_walkover {
                    row.walkovers += 1;
                }
            } else {
                row.match_losses += 1;
            }
        }

        // Разбивка по мод-тегам: тег берём из строки маппула, по которой
        // карту играли. Тайбрейк считаем отдельно — он решает матч.
        let mut st = conn.prepare(
            "SELECT s.mod, COUNT(*), COALESCE(SUM(a.winner_id = ?2), 0)
               FROM match_actions a
               JOIN matches m ON m.id = a.match_id
               JOIN pool_slots s ON s.pool_id = m.pool_id AND s.slot_label = a.slot_label
              WHERE a.type = 'result' AND a.winner_id IS NOT NULL
                AND m.tournament_id = ?1
                AND (m.player_a = ?2 OR m.player_b = ?2)
              GROUP BY s.mod
              ORDER BY COUNT(*) DESC, s.mod",
        )?;
        let per_mod = st
            .query_map(params![t.id, p.player_id], |r| {
                Ok(crate::model::ModStats {
                    mod_tag: r.get(0)?,
                    played: r.get(1)?,
                    won: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        for row_mod in &per_mod {
            if row_mod.mod_tag == "TB" {
                row.tiebreakers = row_mod.played;
                row.tiebreakers_won = row_mod.won;
            }
        }
        row.by_mod = per_mod.into_iter().filter(|x| x.mod_tag != "TB").collect();

        // Самая длинная серия побед по картам подряд — по всему турниру,
        // в порядке матчей и действий внутри них.
        let mut st = conn.prepare(
            "SELECT a.winner_id
               FROM match_actions a
               JOIN matches m ON m.id = a.match_id
              WHERE a.type = 'result' AND m.tournament_id = ?1
                AND (m.player_a = ?2 OR m.player_b = ?2)
              ORDER BY m.id, a.n",
        )?;
        let winners = st
            .query_map(params![t.id, p.player_id], |r| r.get::<_, Option<i64>>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut streak = 0i64;
        for winner in winners {
            if winner == Some(p.player_id) {
                streak += 1;
                row.best_streak = row.best_streak.max(streak);
            } else {
                streak = 0;
            }
        }

        out.push(row);
    }

    // Места считаются в `finish`; здесь только раскладываем по возрастанию.
    out.sort_by(|a, b| {
        a.placement
            .cmp(&b.placement)
            .then_with(|| b.match_wins.cmp(&a.match_wins))
            .then_with(|| a.nickname.cmp(&b.nickname))
    });
    Ok(out)
}

/// Победитель турнира — тот, кто выиграл последний матч сетки.
///
/// Спрашивать про гранд-финал нельзя: на двоих его не бывает, там всё
/// решает единственный матч верхней сетки.
fn champion_of(conn: &Connection, id: i64) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT winner_id FROM matches
              WHERE tournament_id = ?1 AND next_win_slot IS NULL
              ORDER BY CASE bracket WHEN 'grand' THEN 0 WHEN 'lower' THEN 1 ELSE 2 END
              LIMIT 1",
            params![id],
            |r| r.get(0),
        )
        .ok()
        .flatten())
}

/// Сыграна ли сетка целиком.
fn all_played(conn: &Connection, id: i64) -> Result<bool> {
    let left: i64 = conn.query_row(
        "SELECT COUNT(*) FROM matches WHERE tournament_id = ?1 AND status <> 'finished'",
        params![id],
        |r| r.get(0),
    )?;
    Ok(left == 0)
}

/// Закрывает турнир, если последний матч сыгран.
///
/// Зовётся после каждого закрытого матча: досматривать сетку глазами и
/// нажимать «завершить» — работа, которую видно из журнала.
pub fn finish_if_done(conn: &Connection, id: i64) -> Result<bool> {
    let status: String = conn.query_row(
        "SELECT status FROM tournaments WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    if status != "running" || !all_played(conn, id)? {
        return Ok(false);
    }
    finish(conn, id)?;
    Ok(true)
}

/// Возвращает завершённый турнир в игру: отмена результата в последнем
/// матче снимает и места, и дату окончания.
pub fn reopen_if_finished(conn: &Connection, id: i64) -> Result<()> {
    let status: String = conn.query_row(
        "SELECT status FROM tournaments WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    if status != "finished" || all_played(conn, id)? {
        return Ok(());
    }

    // Джекпот, уехавший из этого турнира, возвращается: отменой последнего
    // матча турнир снова открыт, и остаток посчитается заново.
    super::prize::unroll_jackpot(conn, id)?;

    conn.execute(
        "UPDATE tournament_players SET placement = NULL WHERE tournament_id = ?1",
        params![id],
    )?;
    conn.execute(
        "UPDATE tournaments SET status = 'running', finished_at = NULL WHERE id = ?1",
        params![id],
    )?;
    Ok(())
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

    let champion = champion_of(conn, id)?;

    // Места проставляем с нуля: турнир могли переоткрыть отменой действия
    // и доиграть иначе.
    conn.execute(
        "UPDATE tournament_players SET placement = NULL WHERE tournament_id = ?1",
        params![id],
    )?;

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

    // Невыданный остаток фонда не сгорает: с включённым джекпотом он уезжает
    // в фонд следующего турнира.
    super::prize::roll_jackpot(conn, id)?;
    Ok(())
}

// ────────────────────────────────────────────────────── журнал правок

/// Снимок турнира целиком: сам турнир, состав, маппулы, матчи и их действия.
///
/// На нём держится отмена. Хранить обратную операцию на каждый вид правки —
/// двенадцать способов ошибиться, а снимок один и тот же для всех, и правка
/// цвета откатывается тем же кодом, что снос результата.
pub fn snapshot(conn: &Connection, id: i64) -> Result<String> {
    Ok(conn.query_row(
        "SELECT json_object(
             'status',         t.status,
             'bracketSize',    t.bracket_size,
             'targetScore',    t.target_score,
             'bansPerRound',   t.bans_per_round,
             'firstBan',       t.first_ban,
             'noRepeatPool',   t.no_repeat_pool,
             'poolByRound',    t.pool_by_round,
             'grandAdvantage', t.grand_advantage,
             'byeSeeds',       t.bye_seeds,
             'finishedAt',     t.finished_at,
             'players', (SELECT json_group_array(json_object(
                   'playerId', tp.player_id, 'seed', tp.seed,
                   'color', tp.color, 'placement', tp.placement))
                 FROM tournament_players tp WHERE tp.tournament_id = t.id),
             'pools', (SELECT json_group_array(json_object(
                   'poolId', tpl.pool_id, 'position', tpl.position))
                 FROM tournament_pools tpl WHERE tpl.tournament_id = t.id),
             'matches', (SELECT json_group_array(json_object(
                   'id', m.id, 'bracket', m.bracket, 'round', m.round,
                   'slot', m.slot_in_bracket, 'playerA', m.player_a, 'playerB', m.player_b,
                   'poolId', m.pool_id, 'status', m.status, 'winnerId', m.winner_id,
                   'walkover', m.is_walkover, 'manual', m.is_manual_edit,
                   'firstBanBy', m.first_ban_by, 'nextWin', m.next_win_slot,
                   'nextLose', m.next_lose_slot, 'startedAt', m.started_at,
                   'finishedAt', m.finished_at, 'target', m.target_score, 'bans', m.bans_each,
                   'lobbyId', m.lobby_id))
                 FROM matches m WHERE m.tournament_id = t.id),
             'actions', (SELECT json_group_array(json_object(
                   'matchId', a.match_id, 'n', a.n, 'type', a.type, 'actorId', a.actor_id,
                   'slotLabel', a.slot_label, 'winnerId', a.winner_id,
                   'source', a.source, 'at', a.at))
                 FROM match_actions a JOIN matches m2 ON m2.id = a.match_id
                WHERE m2.tournament_id = t.id)
           )
           FROM tournaments t WHERE t.id = ?1",
        params![id],
        |r| r.get(0),
    )?)
}

/// Возвращает турнир в состояние снимка.
///
/// Матчи вставляются в два прохода, как при построении сетки: ссылка вперёд
/// не может указывать на строку, которой ещё нет.
fn restore(conn: &Connection, id: i64, snap: &str) -> Result<()> {
    conn.execute(
        "UPDATE tournaments
            SET status          = json_extract(?2, '$.status'),
                bracket_size    = json_extract(?2, '$.bracketSize'),
                target_score    = json_extract(?2, '$.targetScore'),
                bans_per_round  = json_extract(?2, '$.bansPerRound'),
                first_ban       = json_extract(?2, '$.firstBan'),
                no_repeat_pool  = json_extract(?2, '$.noRepeatPool'),
                pool_by_round   = json_extract(?2, '$.poolByRound'),
                grand_advantage = json_extract(?2, '$.grandAdvantage'),
                bye_seeds       = json_extract(?2, '$.byeSeeds'),
                finished_at     = json_extract(?2, '$.finishedAt')
          WHERE id = ?1",
        params![id, snap],
    )?;

    conn.execute(
        "DELETE FROM match_actions
          WHERE match_id IN (SELECT id FROM matches WHERE tournament_id = ?1)",
        params![id],
    )?;
    conn.execute("DELETE FROM matches WHERE tournament_id = ?1", params![id])?;
    conn.execute(
        "DELETE FROM tournament_players WHERE tournament_id = ?1",
        params![id],
    )?;
    conn.execute(
        "DELETE FROM tournament_pools WHERE tournament_id = ?1",
        params![id],
    )?;

    conn.execute(
        "INSERT INTO tournament_players (tournament_id, player_id, seed, color, placement)
         SELECT ?1, json_extract(v.value, '$.playerId'), json_extract(v.value, '$.seed'),
                json_extract(v.value, '$.color'), json_extract(v.value, '$.placement')
           FROM json_each(json_extract(?2, '$.players')) v",
        params![id, snap],
    )?;
    conn.execute(
        "INSERT INTO tournament_pools (tournament_id, pool_id, position)
         SELECT ?1, json_extract(v.value, '$.poolId'), json_extract(v.value, '$.position')
           FROM json_each(json_extract(?2, '$.pools')) v",
        params![id, snap],
    )?;

    conn.execute(
        "INSERT INTO matches
           (id, tournament_id, bracket, round, slot_in_bracket, player_a, player_b, pool_id,
            status, winner_id, is_walkover, is_manual_edit, first_ban_by,
            started_at, finished_at, target_score, bans_each, lobby_id)
         SELECT json_extract(v.value, '$.id'), ?1,
                json_extract(v.value, '$.bracket'), json_extract(v.value, '$.round'),
                json_extract(v.value, '$.slot'), json_extract(v.value, '$.playerA'),
                json_extract(v.value, '$.playerB'), json_extract(v.value, '$.poolId'),
                json_extract(v.value, '$.status'), json_extract(v.value, '$.winnerId'),
                json_extract(v.value, '$.walkover'), json_extract(v.value, '$.manual'),
                json_extract(v.value, '$.firstBanBy'), json_extract(v.value, '$.startedAt'),
                json_extract(v.value, '$.finishedAt'), json_extract(v.value, '$.target'),
                json_extract(v.value, '$.bans'), json_extract(v.value, '$.lobbyId')
           FROM json_each(json_extract(?2, '$.matches')) v",
        params![id, snap],
    )?;
    conn.execute(
        "UPDATE matches
            SET next_win_slot = (
                  SELECT json_extract(v.value, '$.nextWin')
                    FROM json_each(json_extract(?2, '$.matches')) v
                   WHERE json_extract(v.value, '$.id') = matches.id),
                next_lose_slot = (
                  SELECT json_extract(v.value, '$.nextLose')
                    FROM json_each(json_extract(?2, '$.matches')) v
                   WHERE json_extract(v.value, '$.id') = matches.id)
          WHERE tournament_id = ?1",
        params![id, snap],
    )?;
    conn.execute(
        "INSERT INTO match_actions
           (match_id, n, type, actor_id, slot_label, winner_id, source, at)
         SELECT json_extract(v.value, '$.matchId'), json_extract(v.value, '$.n'),
                json_extract(v.value, '$.type'), json_extract(v.value, '$.actorId'),
                json_extract(v.value, '$.slotLabel'), json_extract(v.value, '$.winnerId'),
                json_extract(v.value, '$.source'), json_extract(v.value, '$.at')
           FROM json_each(json_extract(?2, '$.actions')) v",
        params![id, snap],
    )?;
    Ok(())
}

/// Дописывает правку в журнал. Номера идут с единицы без пропусков —
/// как у действий матча.
pub fn push_edit(
    conn: &Connection,
    id: i64,
    kind: &str,
    emergency: bool,
    note: &str,
    before: String,
) -> Result<i64> {
    let n: i64 = conn.query_row(
        "SELECT COALESCE(MAX(n), 0) + 1 FROM tournament_edits WHERE tournament_id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO tournament_edits (tournament_id, n, kind, at, emergency, payload)
         VALUES (?1, ?2, ?3, datetime('now'), ?4,
                 json_object('note', ?5, 'before', json(?6), 'play', ?7))",
        params![
            id,
            n,
            kind,
            emergency as i64,
            note,
            before,
            play_state(conn, id)?
        ],
    )?;
    Ok(n)
}

/// Отпечаток сыгранного: по матчу и числу действий в нём.
///
/// По нему видно, играли ли после правки. Время для этого не годится: правку
/// и следующий за ней бан разделяют миллисекунды, а `datetime('now')` считает
/// секундами — отмена оказывалась бы запрещена или разрешена по случайности.
fn play_state(conn: &Connection, id: i64) -> Result<String> {
    Ok(conn.query_row(
        "SELECT COALESCE(GROUP_CONCAT(line, ','), '') FROM (
             SELECT a.match_id || ':' || COUNT(*) AS line
               FROM match_actions a JOIN matches m ON m.id = a.match_id
              WHERE m.tournament_id = ?1
              GROUP BY a.match_id
              ORDER BY a.match_id
         )",
        params![id],
        |r| r.get(0),
    )?)
}

pub fn edits(conn: &Connection, id: i64) -> Result<Vec<TournamentEdit>> {
    let mut st = conn.prepare(
        "SELECT n, kind, at, emergency, COALESCE(json_extract(payload, '$.note'), ''), undone_by
           FROM tournament_edits WHERE tournament_id = ?1 ORDER BY n DESC",
    )?;
    let rows = st.query_map(params![id], |r| {
        Ok(TournamentEdit {
            n: r.get(0)?,
            kind: r.get(1)?,
            at: r.get(2)?,
            emergency: r.get::<_, i64>(3)? != 0,
            note: r.get(4)?,
            undone_by: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Последняя правка, которую ещё можно отменить: её номер, отпечаток
/// сыгранного на тот момент, снимок и подпись.
fn last_undoable(conn: &Connection, id: i64) -> Option<(i64, String, String, String)> {
    conn.query_row(
        "SELECT n, COALESCE(json_extract(payload, '$.play'), ''),
                json_extract(payload, '$.before'),
                COALESCE(json_extract(payload, '$.note'), '')
           FROM tournament_edits
          WHERE tournament_id = ?1 AND undone_by IS NULL AND kind <> 'undo'
          ORDER BY n DESC LIMIT 1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .ok()
}

/// Сколько матчей сыграли после правки. Пока их нет, отмена честна:
/// пересчёт вернёт турнир в состояние, которое действительно было.
fn played_since(conn: &Connection, id: i64, marker: &str) -> Result<i64> {
    let parse = |raw: &str| -> std::collections::HashMap<String, String> {
        raw.split(',')
            .filter(|part| !part.is_empty())
            .filter_map(|part| part.split_once(':'))
            .map(|(m, n)| (m.to_string(), n.to_string()))
            .collect()
    };

    let was = parse(marker);
    let now = parse(&play_state(conn, id)?);

    // Матч, у которого журнал стал другим, — это матч, который трогали.
    let mut touched = 0;
    for (match_id, count) in &now {
        if was.get(match_id) != Some(count) {
            touched += 1;
        }
    }
    for match_id in was.keys() {
        if !now.contains_key(match_id) {
            touched += 1;
        }
    }
    Ok(touched)
}

/// Почему отмена недоступна. `None` — можно отменять.
fn undo_blocked(conn: &Connection, id: i64) -> Result<Option<String>> {
    let Some((_, marker, _, _)) = last_undoable(conn, id) else {
        return Ok(Some("правок пока нет".to_string()));
    };
    let played = played_since(conn, id, &marker)?;
    if played == 0 {
        return Ok(None);
    }
    Ok(Some(format!(
        "после этой правки сыграли {played} {} — отменяй их сначала",
        matches_word(played)
    )))
}

/// «1 матч», «2 матча», «5 матчей»: без этого предупреждение читается
/// как машинный вывод, а не как фраза.
pub fn matches_word(n: i64) -> &'static str {
    plural(n, "матч", "матча", "матчей")
}

/// «1 раунд», «2 раунда», «5 раундов».
pub fn rounds_word(n: i64) -> &'static str {
    plural(n, "раунд", "раунда", "раундов")
}

fn plural(n: i64, one: &'static str, few: &'static str, many: &'static str) -> &'static str {
    let ones = n % 10;
    let tens = n % 100;
    if ones == 1 && tens != 11 {
        one
    } else if (2..=4).contains(&ones) && !(12..=14).contains(&tens) {
        few
    } else {
        many
    }
}

/// Отменяет последнюю правку.
///
/// Запись при этом не исчезает: рядом появляется парная правка-отмена, а у
/// отменённой заполняется `undone_by`. История вмешательств должна оставаться
/// видимой — иначе она перестаёт быть историей.
pub fn undo_last_edit(conn: &Connection, id: i64) -> Result<()> {
    let Some((n, marker, before, note)) = last_undoable(conn, id) else {
        anyhow::bail!("отменять нечего: правок нет");
    };

    let played = played_since(conn, id, &marker)?;
    anyhow::ensure!(
        played == 0,
        "после этой правки сыграли {played} {} — отмени их сначала",
        matches_word(played)
    );

    let now = snapshot(conn, id)?;
    restore(conn, id, &before)?;
    let pair = push_edit(
        conn,
        id,
        "undo",
        false,
        &format!("отмена правки {n}: {note}"),
        now,
    )?;
    conn.execute(
        "UPDATE tournament_edits SET undone_by = ?3 WHERE tournament_id = ?1 AND n = ?2",
        params![id, n, pair],
    )?;
    Ok(())
}

// ───────────────────────────────────────────────────── состояние редактора

/// Кто прошёл первый раунд без игры и почему.
fn byes_of(conn: &Connection, t: &Tournament) -> Result<Vec<EditorBye>> {
    let built: i64 = conn.query_row(
        "SELECT COUNT(*) FROM matches WHERE tournament_id = ?1",
        params![t.id],
        |r| r.get(0),
    )?;

    // У построенной сетки берём посчитанное при сборке: состав мог измениться
    // после старта, и проектная сетка соврала бы.
    let seeds: Vec<i64> = if built > 0 {
        t.bye_seeds.clone()
    } else if t.players.len() < 2 {
        Vec::new()
    } else {
        let size = bracket::bracket_size(t.players.len());
        let seats = bracket::build(size, &seat_order(&t.players, size));
        t.players
            .iter()
            .enumerate()
            .filter(|(_, p)| {
                !seats.iter().any(|s| {
                    s.bracket == "upper"
                        && s.round == 1
                        && (s.player_a == Some(p.player_id) || s.player_b == Some(p.player_id))
                })
            })
            .map(|(i, p)| p.seed.unwrap_or(i as i64 + 1))
            .collect()
    };

    let size = bracket::bracket_size(t.players.len().max(2));
    let why = format!(
        "сетка на {size}, игроков {} — соперника в первом раунде нет",
        t.players.len()
    );

    Ok(seeds
        .into_iter()
        .map(|seed| EditorBye {
            seed,
            nickname: t
                .players
                .iter()
                .enumerate()
                .find(|(i, p)| p.seed.unwrap_or(*i as i64 + 1) == seed)
                .map(|(_, p)| p.nickname.clone())
                .unwrap_or_else(|| "игрок".to_string()),
            why: why.clone(),
        })
        .collect())
}

/// Всё, что нужно колонке разделов: проверки, раунды, bye и журнал.
pub fn editor(conn: &Connection, id: i64) -> Result<EditorState> {
    let t = get(conn, id)?;
    let rounds = round_rules(conn, &t)?;
    let byes = byes_of(conn, &t)?;
    let names = pool_names(conn)?;

    let mut checks: Vec<EditorCheck> = Vec::new();
    let check = |list: &mut Vec<EditorCheck>, section: &str, text: String, blocking: bool| {
        list.push(EditorCheck {
            section: section.to_string(),
            text,
            blocking,
        });
    };

    // Правило и маппул не сходятся — по раунду, а не общим предупреждением.
    for round in &rounds {
        for note in &round.notes {
            check(
                &mut checks,
                "rules",
                format!("{}: {note}", round.title),
                false,
            );
        }
    }

    if t.players.len() < 2 {
        check(
            &mut checks,
            "players",
            "для сетки нужно хотя бы два игрока".to_string(),
            true,
        );
    }
    if t.pool_ids.is_empty() {
        check(
            &mut checks,
            "pools",
            "выбери хотя бы один маппул".to_string(),
            true,
        );
    }

    // Один пул на два раунда при включённом «не повторять»: правила спорят
    // между собой, и привязка сильнее.
    if t.no_repeat_pool {
        let mut seen: std::collections::HashMap<i64, Vec<String>> =
            std::collections::HashMap::new();
        for round in &rounds {
            if let Some(pool) = round.pool_id {
                seen.entry(pool).or_default().push(round.title.clone());
            }
        }
        for (pool, where_) in &seen {
            if where_.len() < 2 {
                continue;
            }
            let name = names
                .get(pool)
                .cloned()
                .unwrap_or_else(|| format!("маппул {pool}"));
            check(
                &mut checks,
                "pools",
                format!(
                    "«{name}» привязан к {}: привязка сильнее правила — маппул сыграют дважды",
                    where_.join(" и ")
                ),
                false,
            );
        }

        if !t.pool_ids.is_empty() && rounds.len() > t.pool_ids.len() {
            let repeat = rounds.len() - t.pool_ids.len();
            check(
                &mut checks,
                "pools",
                format!(
                    "раундов {}, маппулов {} — {repeat} {} доиграют повтором",
                    rounds.len(),
                    t.pool_ids.len(),
                    rounds_word(repeat as i64)
                ),
                false,
            );
        }
    }

    // Сыгранный пул заперт: правка уведёт в новую версию, а турнир останется
    // на старой — знать об этом надо до правки.
    for pool in &t.pool_ids {
        let locked: i64 = conn
            .query_row(
                "SELECT is_locked FROM pools WHERE id = ?1",
                params![pool],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if locked != 0 {
            let name = names
                .get(pool)
                .cloned()
                .unwrap_or_else(|| format!("маппул {pool}"));
            check(
                &mut checks,
                "pools",
                format!("«{name}» уже играли — правка уведёт в новую версию"),
                false,
            );
        }
    }

    // Карты, попавшие в два пула турнира: их разыграют дважды. Место называем
    // раундом, а не именем пула — на сетке видно именно раунды.
    let mut overlaps = super::pools::overlaps_between_pools(conn, &t.pool_ids)?;
    let round_of: std::collections::HashMap<i64, String> = rounds
        .iter()
        .filter_map(|r| r.playing_pool_id.map(|pool| (pool, r.title.clone())))
        .collect();
    for row in &mut overlaps {
        row.pools = row
            .pool_ids
            .iter()
            .enumerate()
            .map(|(i, pool)| {
                round_of
                    .get(pool)
                    .cloned()
                    .or_else(|| row.pools.get(i).cloned())
                    .unwrap_or_else(|| format!("маппул {pool}"))
            })
            .collect();
    }
    for row in &overlaps {
        check(
            &mut checks,
            "pools",
            format!("{}: {}", row.name, row.pools.join(" и ")),
            false,
        );
    }

    // Цвета кончились: в палитре шестнадцать, дальше приложение считает свои,
    // и похожие оттенки в сетке не различить.
    let colors: Vec<String> = t.players.iter().map(|p| p.color.to_lowercase()).collect();
    let unique: std::collections::HashSet<&String> = colors.iter().collect();
    if unique.len() < colors.len() || colors.len() > 16 {
        check(
            &mut checks,
            "players",
            "цвета кончились — похожие могут путаться в сетке".to_string(),
            false,
        );
    }

    let (matches_total, matches_started, matches_played) = conn.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(EXISTS (SELECT 1 FROM match_actions a WHERE a.match_id = m.id)), 0),
                COALESCE(SUM(status = 'finished'), 0)
           FROM matches m WHERE tournament_id = ?1",
        params![id],
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        },
    )?;

    // Сколько матчей будет при текущем составе: на двойном выбывании это
    // 2n−2, но с срезкой лишнего честнее посчитать сам скелет.
    let projected_matches = if t.players.len() < 2 {
        0
    } else {
        let size = bracket::bracket_size(t.players.len());
        bracket::build(size, &seat_order(&t.players, size)).len() as i64
    };

    Ok(EditorState {
        rounds,
        byes,
        checks,
        overlaps,
        edits: edits(conn, id)?,
        undo_blocked: undo_blocked(conn, id)?,
        matches_total,
        matches_started,
        matches_played,
        projected_matches,
        emergency_available: t.status == "running"
            || t.status == "finished"
            || t.status == "stopped",
    })
}
