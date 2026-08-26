//! История: сводки завершённых турниров, их летопись и перенос между
//! компьютерами.
//!
//! История — единственное окно, в котором турнир виден уже целиком сыгранным,
//! поэтому сводка считает сама то, что нигде не хранится: счёт финала,
//! «без поражений», самый долгий матч.

use std::collections::HashMap;
use std::path::Path;

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;

use super::matches as matches_db;
use super::tournaments as tournaments_db;
use crate::db::Db;
use crate::model::{Bracket, Match};

// ─────────────────────────────────────────────────── структуры для фронта

/// Игрок в сводке: ник, цвет в этом турнире и id — фронту хватает на аватар.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPlayer {
    pub player_id: i64,
    pub nickname: String,
    pub color: String,
}

/// Финальный матч: кто играл и с каким счётом.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFinal {
    pub nick_a: String,
    pub nick_b: String,
    pub color_a: String,
    pub color_b: String,
    /// Счёт вместе с преимуществом сетки: так финал подписан на сетке, и
    /// «2:0 при преимуществе 1» не выглядело бы выигрышем до первой карты.
    pub score_a: i64,
    pub score_b: i64,
    pub is_walkover: bool,
}

/// Карточка завершённого турнира в списке истории.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySummary {
    pub id: i64,
    pub name: String,
    pub finished_at: Option<String>,
    pub player_count: i64,
    pub match_count: i64,
    pub champion: Option<HistoryPlayer>,
    /// Первые три места, по возрастанию места.
    pub podium: Vec<HistoryPlayer>,
    pub final_match: Option<HistoryFinal>,
    /// Объявленный фонд. `None` — турнир играли без денег.
    pub prize_fund: Option<i64>,
    /// Заметки-достижения: «чемпион без поражений», «самый долгий матч»,
    /// «N матчей».
    pub notes: Vec<String>,
}

/// Покартовый результат: строка маппула и кто её взял.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMapResult {
    pub n: i64,
    pub slot_label: String,
    pub winner_nick: Option<String>,
    pub winner_color: Option<String>,
}

/// Матч в летописи турнира: всё, что о нём можно спросить задним числом.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchLogView {
    pub id: i64,
    pub bracket: String,
    pub round: i64,
    /// Как матч подписан на сетке: «Финал нижней, матч 2».
    pub title: String,
    pub nick_a: Option<String>,
    pub nick_b: Option<String>,
    pub color_a: Option<String>,
    pub color_b: Option<String>,
    pub score_a: i64,
    pub score_b: i64,
    pub is_walkover: bool,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub maps: Vec<HistoryMapResult>,
}

/// Детальный вид: сетка целиком плюс летопись матчей.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDetail {
    pub bracket: Bracket,
    pub matches: Vec<MatchLogView>,
}

// ─────────────────────────────────────────────────────────── список

pub fn list(conn: &Connection) -> Result<Vec<HistorySummary>> {
    let mut st = conn.prepare(
        "SELECT id FROM tournaments WHERE status = 'finished'
          ORDER BY finished_at DESC, id DESC",
    )?;
    let ids = st
        .query_map([], |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        out.push(summary_of(conn, id)?);
    }
    Ok(out)
}

fn summary_of(conn: &Connection, id: i64) -> Result<HistorySummary> {
    let t = tournaments_db::get(conn, id)?;

    let player_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tournament_players WHERE tournament_id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    let match_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM matches WHERE tournament_id = ?1",
        params![id],
        |r| r.get(0),
    )?;

    // Чемпион — первое место. Берём из состава, а не из сетки: место уже
    // посчитано при завершении и хранится.
    let champion: Option<HistoryPlayer> = conn
        .query_row(
            "SELECT tp.player_id, p.nickname, tp.color
               FROM tournament_players tp JOIN players p ON p.id = tp.player_id
              WHERE tp.tournament_id = ?1 AND tp.placement = 1",
            params![id],
            |r| {
                Ok(HistoryPlayer {
                    player_id: r.get(0)?,
                    nickname: r.get(1)?,
                    color: r.get(2)?,
                })
            },
        )
        .ok();

    // Пьедестал: первые три места, сколько бы их ни нашлось.
    let mut st = conn.prepare(
        "SELECT tp.player_id, p.nickname, tp.color
           FROM tournament_players tp JOIN players p ON p.id = tp.player_id
          WHERE tp.tournament_id = ?1 AND tp.placement IS NOT NULL AND tp.placement <= 3
          ORDER BY tp.placement",
    )?;
    let podium = st
        .query_map(params![id], |r| {
            Ok(HistoryPlayer {
                player_id: r.get(0)?,
                nickname: r.get(1)?,
                color: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Финал — последний матч сетки: без ссылки вперёд, гранд-финал первым
    // (на двоих его не бывает, и вся сетка решается одним матчем верхней).
    let final_match = last_match(conn, id)?;
    let final_view = final_match.as_ref().and_then(|m| {
        let (a, b) = (m.player_a?, m.player_b?);
        let (nick_a, color_a) = look(conn, id, a)?;
        let (nick_b, color_b) = look(conn, id, b)?;
        Some(HistoryFinal {
            nick_a,
            nick_b,
            color_a,
            color_b,
            score_a: m.score_a + m.bonus_a,
            score_b: m.score_b + m.bonus_b,
            is_walkover: m.is_walkover,
        })
    });

    let mut notes = Vec::new();

    if let Some(ch) = &champion {
        let losses: i64 = conn.query_row(
            "SELECT COUNT(*) FROM matches
              WHERE tournament_id = ?1 AND status = 'finished'
                AND winner_id IS NOT NULL AND winner_id <> ?2
                AND (player_a = ?2 OR player_b = ?2)",
            params![id, ch.player_id],
            |r| r.get(0),
        )?;
        if losses == 0 {
            notes.push("чемпион без поражений".into());
        }
    }

    // Самый долгий матч: без него из списка не видно, что один турнир тянулся
    // час, а второй закрылся за вечер.
    let longest: Option<(f64, i64)> = conn
        .query_row(
            "SELECT (julianday(finished_at) - julianday(started_at)) * 86400.0, id
               FROM matches
              WHERE tournament_id = ?1 AND started_at IS NOT NULL AND finished_at IS NOT NULL
              ORDER BY 1 DESC LIMIT 1",
            params![id],
            |r| Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)?)),
        )
        .ok();
    if let Some((secs, match_id)) = longest {
        if secs >= 60.0 {
            let minutes = (secs / 60.0).round() as i64;
            let title = matches_db::get(conn, match_id)
                .and_then(|m| matches_db::title_of(conn, &m))
                .unwrap_or_else(|_| "матч".into());
            notes.push(format!("самый долгий матч — {minutes} мин ({title})"));
        }
    }

    notes.push(format!(
        "{} {}",
        match_count,
        tournaments_db::matches_word(match_count)
    ));

    let prize_fund = t
        .prize
        .as_ref()
        .map(|c| c.fund)
        .filter(|fund| *fund > 0);

    Ok(HistorySummary {
        id: t.id,
        name: t.name,
        finished_at: t.finished_at,
        player_count,
        match_count,
        champion,
        podium,
        final_match: final_view,
        prize_fund,
        notes,
    })
}

/// Последний матч сетки со счётом.
fn last_match(conn: &Connection, id: i64) -> Result<Option<Match>> {
    let found = conn
        .query_row(
            "SELECT * FROM matches
              WHERE tournament_id = ?1 AND next_win_slot IS NULL
              ORDER BY CASE bracket WHEN 'grand' THEN 0 WHEN 'lower' THEN 1 ELSE 2 END
              LIMIT 1",
            params![id],
            tournaments_db::row_to_match,
        )
        .ok();
    let Some(mut m) = found else {
        return Ok(None);
    };
    tournaments_db::fill_scores(conn, &mut m)?;
    Ok(Some(m))
}

fn look(conn: &Connection, tournament_id: i64, player_id: i64) -> Option<(String, String)> {
    conn.query_row(
        "SELECT p.nickname, tp.color
           FROM tournament_players tp JOIN players p ON p.id = tp.player_id
          WHERE tp.tournament_id = ?1 AND tp.player_id = ?2",
        params![tournament_id, player_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )
    .ok()
}

// ─────────────────────────────────────────────────────────── деталь

pub fn detail(conn: &Connection, id: i64) -> Result<HistoryDetail> {
    let bracket = tournaments_db::bracket_of(conn, id)?;

    // Цвет и ник — из состава турнира: в сетке игрок подписан именно ими.
    let mut who: HashMap<i64, (String, String)> = HashMap::new();
    for p in &bracket.tournament.players {
        who.insert(p.player_id, (p.nickname.clone(), p.color.clone()));
    }

    let mut st = conn.prepare(
        "SELECT * FROM matches WHERE tournament_id = ?1
          ORDER BY CASE bracket WHEN 'upper' THEN 0 WHEN 'lower' THEN 1 ELSE 2 END,
                   round, slot_in_bracket",
    )?;
    let mut rows = st
        .query_map(params![id], tournaments_db::row_to_match)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut out = Vec::with_capacity(rows.len());
    for m in &mut rows {
        tournaments_db::fill_scores(conn, m)?;
        let title = matches_db::title_of(conn, m)?;

        let actions = matches_db::actions(conn, m.id)?;
        let maps = actions
            .iter()
            .filter(|a| a.kind == "result")
            .map(|a| {
                let winner = a
                    .winner_id
                    .and_then(|w| who.get(&w))
                    .map(|(nick, color)| (nick.clone(), color.clone()));
                HistoryMapResult {
                    n: a.n,
                    slot_label: a.slot_label.clone(),
                    winner_nick: winner.as_ref().map(|(nick, _)| nick.clone()),
                    winner_color: winner.map(|(_, color)| color),
                }
            })
            .collect();

        out.push(MatchLogView {
            id: m.id,
            bracket: m.bracket.clone(),
            round: m.round,
            title,
            nick_a: m.player_a.and_then(|p| who.get(&p)).map(|(n, _)| n.clone()),
            nick_b: m.player_b.and_then(|p| who.get(&p)).map(|(n, _)| n.clone()),
            color_a: m.player_a.and_then(|p| who.get(&p)).map(|(_, c)| c.clone()),
            color_b: m.player_b.and_then(|p| who.get(&p)).map(|(_, c)| c.clone()),
            score_a: m.score_a + m.bonus_a,
            score_b: m.score_b + m.bonus_b,
            is_walkover: m.is_walkover,
            started_at: m.started_at.clone(),
            finished_at: m.finished_at.clone(),
            maps,
        });
    }

    Ok(HistoryDetail {
        bracket,
        matches: out,
    })
}

// ─────────────────────────────────────────────── экспорт и импорт турнира

/// JSON-снимок турнира для переноса на другой компьютер.
///
/// Внутри — тот же snapshot, что держит отмена правок, плюс имя, фонд, ники
/// и флаги новичков: без них импорт не найдёт игроков в чужой базе — id там
/// другие, единственная общая валюта это ник.
pub fn export_tournament(conn: &Connection, id: i64) -> Result<String> {
    let t = tournaments_db::get(conn, id)?;
    let mut root: serde_json::Value =
        serde_json::from_str(&tournaments_db::snapshot(conn, id)?)?;
    let obj = root
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("снимок турнира оказался не объектом"))?;

    obj.insert("name".into(), serde_json::Value::String(t.name.clone()));
    obj.insert(
        "prize".into(),
        match &t.prize {
            Some(config) => serde_json::to_value(config)?,
            None => serde_json::Value::Null,
        },
    );

    if let Some(players) = obj
        .get_mut("players")
        .and_then(|v| v.as_array_mut())
    {
        for entry in players.iter_mut() {
            let Some(pid) = entry.get("playerId").and_then(|v| v.as_i64()) else {
                continue;
            };
            let extra: Option<(String, i64)> = conn
                .query_row(
                    "SELECT p.nickname, tp.is_rookie
                       FROM tournament_players tp JOIN players p ON p.id = tp.player_id
                      WHERE tp.tournament_id = ?1 AND tp.player_id = ?2",
                    params![id, pid],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok();
            if let Some((nick, rookie)) = extra {
                entry["nickname"] = serde_json::Value::String(nick);
                entry["isRookie"] = serde_json::Value::Bool(rookie != 0);
            }
        }
    }

    Ok(serde_json::to_string(&root)?)
}

/// Создаёт новый турнир из снимка. Игроки склеиваются по никам, id матчей
/// и игроков переразводятся на местные. Возвращает id нового турнира.
pub fn import_tournament(conn: &Connection, json: &str) -> Result<i64> {
    let root: serde_json::Value = serde_json::from_str(json)?;
    let obj = root
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("в файле нет снимка турнира"))?;

    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Турнир")
        .trim();
    anyhow::ensure!(!name.is_empty(), "у турнира должно быть название");

    // Строковые JSON-поля турнира перекладываем как есть.
    let field = |key: &str| -> String {
        obj.get(key)
            .map(|v| v.to_string())
            .unwrap_or_else(|| "null".into())
    };
    let prize = obj.get("prize").map(|v| v.to_string());

    conn.execute(
        "INSERT INTO tournaments
           (name, status, bracket_size, target_score, bans_per_round, first_ban,
            no_repeat_pool, pool_by_round, grand_advantage, bye_seeds,
            created_at, finished_at, prize)
         VALUES (?1, 'finished', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                 datetime('now'), COALESCE(?10, datetime('now')), ?11)",
        params![
            format!("{name} (импорт)"),
            obj.get("bracketSize").and_then(|v| v.as_i64()).unwrap_or(0),
            field("targetScore"),
            field("bansPerRound"),
            obj.get("firstBan").and_then(|v| v.as_str()).unwrap_or("random"),
            obj.get("noRepeatPool").and_then(|v| v.as_bool()).unwrap_or(true),
            field("poolByRound"),
            obj.get("grandAdvantage").and_then(|v| v.as_i64()).unwrap_or(0),
            field("byeSeeds"),
            obj.get("finishedAt").and_then(|v| v.as_str()),
            prize,
        ],
    )?;
    let tournament_id = conn.last_insert_rowid();

    // Игроки: сначала разводим id, потом вставляем состав.
    let empty = Vec::new();
    let players = obj
        .get("players")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    let mut player_ids: HashMap<i64, i64> = HashMap::new();

    for (i, entry) in players.iter().enumerate() {
        let old = entry.get("playerId").and_then(|v| v.as_i64());
        let nick = entry
            .get("nickname")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|n| !n.is_empty());

        let known: Option<i64> = nick.and_then(|n| {
            conn.query_row(
                "SELECT id FROM players WHERE nickname = ?1 COLLATE NOCASE LIMIT 1",
                params![n],
                |r| r.get(0),
            )
            .ok()
        });

        // Нет ника — игрока не узнать; даём нейтральное имя, чтобы сетка
        // не рассыпалась на пустые места.
        let fallback = format!("игрок {}", i + 1);
        let nickname = nick.unwrap_or(fallback.as_str());
        let new_id = match known {
            Some(id) => id,
            None => super::players::create(
                conn,
                nickname,
                None,
                entry.get("color").and_then(|v| v.as_str()),
            )?,
        };
        if let Some(old) = old {
            player_ids.insert(old, new_id);
        }

        conn.execute(
            "INSERT INTO tournament_players
               (tournament_id, player_id, seed, color, placement, is_rookie)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                tournament_id,
                new_id,
                entry.get("seed").and_then(|v| v.as_i64()),
                entry
                    .get("color")
                    .and_then(|v| v.as_str())
                    .unwrap_or("#ff6fb1"),
                entry.get("placement").and_then(|v| v.as_i64()),
                entry.get("isRookie").and_then(|v| v.as_bool()).unwrap_or(false),
            ],
        )?;
    }

    let map_player = |id: &serde_json::Value| -> Option<i64> {
        id.as_i64().and_then(|old| player_ids.get(&old).copied())
    };

    // Матчи вставляются в порядке снимка, а связи разводим вторым проходом:
    // ссылка вперёд не может указывать на строку, которой ещё нет.
    let empty = Vec::new();
    let snapshot_matches = obj
        .get("matches")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    let mut match_ids: HashMap<i64, i64> = HashMap::new();

    for entry in snapshot_matches {
        let old_id = entry.get("id").and_then(|v| v.as_i64());
        let number = |key: &str| entry.get(key).and_then(|v| v.as_i64());
        let text = |key: &str| entry.get(key).and_then(|v| v.as_str());

        conn.execute(
            "INSERT INTO matches
               (tournament_id, bracket, round, slot_in_bracket, player_a, player_b,
                status, winner_id, is_walkover, is_manual_edit, first_ban_by,
                started_at, finished_at, target_score, bans_each, lobby_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                tournament_id,
                text("bracket").unwrap_or("upper"),
                number("round").unwrap_or(1),
                number("slot").unwrap_or(0),
                entry.get("playerA").and_then(|v| map_player(v)),
                entry.get("playerB").and_then(|v| map_player(v)),
                text("status").unwrap_or("finished"),
                entry.get("winnerId").and_then(|v| map_player(v)),
                entry.get("walkover").and_then(|v| v.as_i64()).unwrap_or(0),
                entry.get("manual").and_then(|v| v.as_i64()).unwrap_or(0),
                entry.get("firstBanBy").and_then(|v| map_player(v)),
                text("startedAt"),
                text("finishedAt"),
                number("target"),
                number("bans"),
                number("lobbyId"),
            ],
        )?;
        if let Some(old_id) = old_id {
            match_ids.insert(old_id, conn.last_insert_rowid());
        }
    }

    for entry in snapshot_matches {
        let Some(old_id) = entry.get("id").and_then(|v| v.as_i64()) else {
            continue;
        };
        let new_id = match_ids.get(&old_id).copied();
        let link = |key: &str| -> Option<i64> {
            entry
                .get(key)
                .and_then(|v| v.as_i64())
                .and_then(|old| match_ids.get(&old).copied())
        };
        conn.execute(
            "UPDATE matches SET next_win_slot = ?2, next_lose_slot = ?3 WHERE id = ?1",
            params![new_id, link("nextWin"), link("nextLose")],
        )?;
    }

    // Пулы и серии не переносим: на другом компьютере их может не быть,
    // а матч без маппула в истории читается по счёту и нику.
    if let Some(actions) = obj.get("actions").and_then(|v| v.as_array()) {
        for entry in actions {
            let Some(old_match) = entry.get("matchId").and_then(|v| v.as_i64()) else {
                continue;
            };
            let Some(new_match) = match_ids.get(&old_match) else {
                continue;
            };
            conn.execute(
                "INSERT INTO match_actions
                   (match_id, n, type, actor_id, slot_label, winner_id, source, at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    new_match,
                    entry.get("n").and_then(|v| v.as_i64()).unwrap_or(1),
                    entry.get("type").and_then(|v| v.as_str()).unwrap_or("result"),
                    entry.get("actorId").and_then(|v| map_player(v)),
                    entry.get("slotLabel").and_then(|v| v.as_str()).unwrap_or(""),
                    entry.get("winnerId").and_then(|v| map_player(v)),
                    entry.get("source").and_then(|v| v.as_str()).unwrap_or("manual"),
                    entry.get("at").and_then(|v| v.as_str()).unwrap_or(""),
                ],
            )?;
        }
    }

    Ok(tournament_id)
}

// ─────────────────────────────────────────────── экспорт и импорт базы

/// Штамп для имени файла: 2026-02-10-180503.
fn stamp() -> Result<String> {
    let fmt = time::macros::format_description!(
        "[year]-[month]-[day]-[hour][minute][second]"
    );
    Ok(time::OffsetDateTime::now_utc().format(&fmt)?)
}

/// Сливает журнал WAL в основной файл. Без чекпоинта копия базы — это вчерашняя
/// база: свежие записи сидят рядом в -wal.
fn checkpoint(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    Ok(())
}

/// Копия базы в папку данных. `backups: true` — в папку бэкапов с именем по
/// штампу, иначе в `exports` для переноса. Возвращает полный путь.
pub fn export_database(
    conn: &Connection,
    data_dir: &Path,
    db_path: &Path,
    backup: bool,
) -> Result<String> {
    let folder = if backup { "backups" } else { "exports" };
    let dir = data_dir.join(folder);
    std::fs::create_dir_all(&dir)?;

    let name = if backup {
        format!("osucup-{}.db", stamp()?)
    } else {
        "osucup-база.db".to_string()
    };
    let dst = dir.join(name);

    checkpoint(conn)?;
    std::fs::copy(db_path, &dst)?;
    Ok(dst.to_string_lossy().into_owned())
}

/// Бэкап в папку данных приложения. Возвращает имя файла.
pub fn backup_database(
    conn: &Connection,
    data_dir: &Path,
    db_path: &Path,
) -> Result<String> {
    let dir = data_dir.join("backups");
    std::fs::create_dir_all(&dir)?;
    let name = format!("osucup-{}.db", stamp()?);

    checkpoint(conn)?;
    std::fs::copy(db_path, dir.join(&name))?;
    Ok(name)
}

/// Имена бэкапов, новые сверху.
pub fn list_backups(data_dir: &Path) -> Result<Vec<String>> {
    let dir = data_dir.join("backups");
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut names: Vec<String> = std::fs::read_dir(&dir)?
        .filter_map(|entry| entry.ok())
        .filter(|e| e.path().extension().map(|x| x == "db").unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort_by(|a, b| b.cmp(a));
    Ok(names)
}

/// Подменяет файл базы содержимым `bytes` и переоткрывает соединение.
///
/// Порядок — сначала запись во временное имя и только потом снос: наполовину
/// скопированный файл не должен становиться рабочей базой.
fn replace_database(db: &Db, db_path: &Path, bytes: &[u8]) -> Result<()> {
    anyhow::ensure!(
        bytes.starts_with(b"SQLite format 3\0"),
        "в файле нет базы SQLite"
    );

    let tmp = db_path.with_extension("importing");
    std::fs::write(&tmp, bytes)?;

    // Открытое соединение держит файл: под Windows занятый файл не заменить,
    // поэтому прежде чем трогать пути, переключаемся на пустую базу в памяти.
    db.reopen(":memory:")?;

    let _ = std::fs::remove_file(db_path);
    let _ = std::fs::remove_file(db_path.with_extension("sqlite-wal"));
    let _ = std::fs::remove_file(db_path.with_extension("sqlite-shm"));
    std::fs::rename(&tmp, db_path)?;

    db.reopen(db_path)?;
    Ok(())
}

/// Заменяет базу файлом, принесённым с другого компьютера (base64).
pub fn import_database(db: &Db, db_path: &Path, data: &str) -> Result<()> {
    let bytes = base64_decode(data)?;
    replace_database(db, db_path, &bytes)
}

/// Возвращает базу из бэкапа. Имя проверяется на посторонние пути: команда
/// принимает его с фронта.
pub fn restore_backup(db: &Db, data_dir: &Path, db_path: &Path, name: &str) -> Result<()> {
    anyhow::ensure!(
        !name.contains(['/', '\\']) && !name.contains(".."),
        "непонятное имя бэкапа"
    );
    let path = data_dir.join("backups").join(name);
    anyhow::ensure!(path.exists(), "бэкапа {name} нет");

    // Чекпоинт до копирования: бэкап, снятый секунду назад, уже видит всё,
    // что писалось до него. with отпускает мьютекс до подмены файла — reopen
    // внутри захватил бы его второй раз.
    db.with(|conn| Ok(checkpoint(conn)?))?;
    let bytes = std::fs::read(&path)?;
    replace_database(db, db_path, &bytes)
}

// ───────────────────────────────────────────────────────── base64

/// Раскодировка base64 со стандартным алфавитом. Своя, а не из крейта:
/// тащить зависимость ради одной команды переноса базы не хочется.
fn base64_decode(raw: &str) -> Result<Vec<u8>> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut table = [255u8; 256];
    for (i, &c) in ALPHABET.iter().enumerate() {
        table[c as usize] = i as u8;
    }

    let mut out = Vec::with_capacity(raw.len() / 4 * 3);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;

    for &ch in raw.as_bytes() {
        if ch.is_ascii_whitespace() {
            continue;
        }
        if ch == b'=' {
            break;
        }
        let value = table[ch as usize];
        anyhow::ensure!(value != 255, "в base64 посторонний символ");
        buf = (buf << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}
