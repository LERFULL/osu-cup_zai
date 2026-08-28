//! Игроки и их статистика.
//!
//! Всё, что можно посчитать из истории матчей, здесь и считается: никаких
//! накопительных счётчиков в базе, чтобы правка результата задним числом
//! не оставляла расхождений.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

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
const DEFAULT_PALETTE: [&str; 8] = [
    "#ff6fb1", "#5bc8f5", "#7ed957", "#ffd03b", "#c77dff", "#ff6b6b", "#4dd6c1", "#f7913d",
];

/// Формат цвета игрока: ровно #rrggbb.
fn is_hex_color(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().all(|x| x.is_ascii_hexdigit())
}

/// Палитра приложения: своя из настроек (app_kv «palette») или стандартная.
/// Битая запись — не катастрофа, просто вернём стандартную.
pub fn palette(conn: &Connection) -> Vec<String> {
    super::prize::kv_get(conn, "palette")
        .and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
        .filter(|v| v.len() == DEFAULT_PALETTE.len() && v.iter().all(|c| is_hex_color(c)))
        .unwrap_or_else(|| DEFAULT_PALETTE.iter().map(|s| s.to_string()).collect())
}

/// Своя палитра из настроек: восемь цветов формата #rrggbb.
pub fn set_palette(conn: &Connection, colors: &[String]) -> Result<()> {
    anyhow::ensure!(
        colors.len() == DEFAULT_PALETTE.len(),
        "в палитре должно быть {} цветов, а пришло {}",
        DEFAULT_PALETTE.len(),
        colors.len()
    );
    for c in colors {
        anyhow::ensure!(is_hex_color(c), "цвет «{c}» — не #rrggbb");
    }
    super::prize::kv_set(conn, "palette", &serde_json::to_string(colors)?)?;
    Ok(())
}

/// Цвет с номером за пределами палитры: на турнир в двадцать человек восьми
/// цветов не хватает, а повторы в сетке не различить. Оттенок каждый раз
/// уходит на пол-оборота от предыдущего, поэтому соседние номера далеки
/// друг от друга.
fn generated(n: usize) -> String {
    let step = (n - DEFAULT_PALETTE.len()) as f64;
    let hue = (196.0 + step * 137.508) % 360.0;
    // Насыщенность и светлота чередуются, чтобы близкие оттенки
    // расходились ещё и по яркости.
    let (sat, light) = match (n - DEFAULT_PALETTE.len()) % 3 {
        0 => (0.62, 0.66),
        1 => (0.78, 0.58),
        _ => (0.52, 0.74),
    };
    hsl_to_hex(hue, sat, light)
}

/// Цвет по номеру из стандартной палитры.
pub fn color_at(n: usize) -> String {
    match DEFAULT_PALETTE.get(n) {
        Some(c) => c.to_string(),
        None => generated(n),
    }
}

/// Цвет по номеру с палитрой из настроек: как `color_at`, но первые восемь
/// берутся из сохранённой палитры.
pub fn color_in(palette: &[String], n: usize) -> String {
    match palette.get(n) {
        Some(c) => c.clone(),
        None => generated(n),
    }
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
/// а повторять цвет в одной сетке — тем более. Палитру берём из
/// настроек: свой набор цветов действует и здесь.
pub fn free_color(conn: &Connection, taken: &[String]) -> String {
    let palette = palette(conn);
    let mut n = 0usize;
    loop {
        let candidate = color_in(&palette, n);
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
        .unwrap_or_else(|| color_in(&palette(conn), taken as usize));

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

/// Объединение дубля: всё, что сделал `merge_id`, переезжает на `keep_id`,
/// osu! ID подтягивается, если у оставшегося его не было, дубль уходит в архив.
/// Возвращает обновлённого keep-игрока.
///
/// Личную статистику не пересчитываем и не переносим: она вся считается
/// запросами по истории матчей и потому пересчитывается сама.
pub fn merge(conn: &Connection, keep_id: i64, merge_id: i64) -> Result<Player> {
    anyhow::ensure!(
        keep_id != merge_id,
        "игрока нельзя объединить с самим собой"
    );

    let keep = get(conn, keep_id)?.ok_or_else(|| anyhow::anyhow!("Игрок не найден"))?;
    let gone =
        get(conn, merge_id)?.ok_or_else(|| anyhow::anyhow!("Игрок для объединения не найден"))?;

    // Оба в одном матче — коллизия, которую переносом ссылок не разрулить:
    // после склейки игрок оказался бы играющим сам с собой.
    let both: i64 = conn.query_row(
        "SELECT COUNT(*) FROM matches
          WHERE (player_a = ?1 AND player_b = ?2) OR (player_a = ?2 AND player_b = ?1)",
        params![keep_id, merge_id],
        |r| r.get(0),
    )?;
    anyhow::ensure!(
        both == 0,
        "эти игроки играли друг с другом в одном матче — объединить нельзя"
    );

    // osu! ID забираем, только если у оставшегося своего нет: свой всегда важнее.
    if keep.osu_user_id.is_none() && gone.osu_user_id.is_some() {
        conn.execute(
            "UPDATE players SET osu_user_id = ?2 WHERE id = ?1",
            params![keep_id, gone.osu_user_id],
        )?;
    }

    // Матчи: обе стороны, победитель и первый бан.
    conn.execute(
        "UPDATE matches SET player_a = ?2 WHERE player_a = ?1",
        params![merge_id, keep_id],
    )?;
    conn.execute(
        "UPDATE matches SET player_b = ?2 WHERE player_b = ?1",
        params![merge_id, keep_id],
    )?;
    conn.execute(
        "UPDATE matches SET winner_id = ?2 WHERE winner_id = ?1",
        params![merge_id, keep_id],
    )?;
    conn.execute(
        "UPDATE matches SET first_ban_by = ?2 WHERE first_ban_by = ?1",
        params![merge_id, keep_id],
    )?;

    // Действия матчей: кто баннил и кто забрал карту.
    conn.execute(
        "UPDATE match_actions SET actor_id = ?2 WHERE actor_id = ?1",
        params![merge_id, keep_id],
    )?;
    conn.execute(
        "UPDATE match_actions SET winner_id = ?2 WHERE winner_id = ?1",
        params![merge_id, keep_id],
    )?;

    // Участия в турнирах. Если keep уже играет турнир, строка дубля не нужна:
    // своё место и своё место в сетке у keep уже есть, место дубля уходит.
    // Иначе строка переезжает целиком, вместе с местом: результат дубля в том
    // турнире и есть результат оставшегося — иначе чемпионство потерялось бы.
    conn.execute(
        "DELETE FROM tournament_players WHERE player_id = ?1
           AND tournament_id IN (SELECT tournament_id FROM tournament_players WHERE player_id = ?2)",
        params![merge_id, keep_id],
    )?;
    conn.execute(
        "UPDATE tournament_players SET player_id = ?2 WHERE player_id = ?1",
        params![merge_id, keep_id],
    )?;

    // Дубль — в архив, не в удаление: на его id всё ещё ссылается история.
    set_archived(conn, merge_id, true)?;

    Ok(get(conn, keep_id)?.expect("keep только что читался"))
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
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
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

// ────────────────────────────────────────────── профиль osu! игрока

/// Свежий (за сутки) расширенный профиль из кеша.
pub fn cached_user_profile(
    conn: &Connection,
    osu_user_id: i64,
) -> anyhow::Result<Option<crate::model::PlayerOsuProfile>> {
    let json: Option<String> = conn
        .query_row(
            "SELECT json FROM osu_user_cache
              WHERE osu_user_id = ?1
                AND julianday('now') - julianday(fetched_at) < 1.0",
            params![osu_user_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
}

/// Профиль из кеша любого возраста: сетевые ошибки не должны ронять карточку.
pub fn user_profile_any_age(
    conn: &Connection,
    osu_user_id: i64,
) -> anyhow::Result<Option<crate::model::PlayerOsuProfile>> {
    let json: Option<String> = conn
        .query_row(
            "SELECT json FROM osu_user_cache WHERE osu_user_id = ?1",
            params![osu_user_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
}

/// Кладёт профиль в кеш и заодно снимок за сегодняшний день.
pub fn save_user_profile(
    conn: &Connection,
    profile: &crate::model::PlayerOsuProfile,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO osu_user_cache (osu_user_id, json, fetched_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(osu_user_id) DO UPDATE SET json = ?2, fetched_at = ?3",
        params![
            profile.osu_user_id,
            serde_json::to_string(profile)?,
            profile.fetched_at
        ],
    )?;

    // Снимок — не чаще одного в день: день берём из даты загрузки профиля.
    let day = profile.fetched_at.get(..10).unwrap_or("").to_string();
    if day.len() == 10 {
        conn.execute(
            "INSERT INTO osu_snapshots (osu_user_id, day, pp, global_rank, accuracy, play_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(osu_user_id, day) DO UPDATE SET
                pp = ?3, global_rank = ?4, accuracy = ?5, play_count = ?6",
            params![
                profile.osu_user_id,
                day,
                profile.pp,
                profile.global_rank,
                profile.accuracy,
                profile.play_count
            ],
        )?;
    }
    Ok(())
}

/// История снимков по дням, старые в начале — линия прогресса рисуется слева
/// направо именно в этом порядке.
pub fn snapshots(
    conn: &Connection,
    osu_user_id: i64,
) -> anyhow::Result<Vec<crate::model::OsuSnapshot>> {
    let mut stmt = conn.prepare(
        "SELECT day, pp, global_rank, accuracy, play_count
           FROM osu_snapshots
          WHERE osu_user_id = ?1
          ORDER BY day ASC",
    )?;
    let rows = stmt.query_map(params![osu_user_id], |r| {
        Ok(crate::model::OsuSnapshot {
            day: r.get(0)?,
            pp: r.get(1)?,
            global_rank: r.get(2)?,
            accuracy: r.get(3)?,
            play_count: r.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
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

    /// База только под app_kv: остальное палитре не нужно.
    fn kv_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .unwrap();
        conn
    }

    #[test]
    fn custom_palette_drives_free_color() {
        let conn = kv_conn();
        let own: Vec<String> = (0..8).map(|i| format!("#00{i:02x}aa")).collect();
        set_palette(&conn, &own).unwrap();

        assert_eq!(palette(&conn), own);
        assert_eq!(free_color(&conn, &[]), "#0000aa");

        // Занятые из палитры пропускаются, дальше идут считаные.
        let next = free_color(&conn, &own);
        assert!(!own.contains(&next), "свободный цвет не из палитры");
    }

    #[test]
    fn set_palette_rejects_wrong_input() {
        let conn = kv_conn();
        let short: Vec<String> = (0..7).map(|i| format!("#00{i:02x}aa")).collect();
        assert!(
            set_palette(&conn, &short).is_err(),
            "семь цветов — не палитра"
        );

        let bad = vec!["#ff6fb1".to_string(); 8];
        assert!(set_palette(&conn, &bad).is_ok());
        let named: Vec<String> = ["red".to_string()]
            .into_iter()
            .chain((1..8).map(|i| format!("#00{i:02x}aa")))
            .collect();
        // «red» — не hex, но запись выше уже прошла: проверяем отклонение
        // именованного цвета отдельной попыткой.
        assert!(
            set_palette(&conn, &named).is_err(),
            "именованный цвет не проходит"
        );
        // Палитра при этом осталась прежней — валидной.
        assert_eq!(palette(&conn), bad);
    }

    // ─────────────────────────────────────────── объединение игроков

    /// База с полным набором миграций: объединению нужны матчи и турниры.
    fn full_db() -> Connection {
        let conn = Connection::open_in_memory().expect("база в памяти");
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        for (version, sql) in super::super::MIGRATIONS {
            conn.execute_batch(sql)
                .unwrap_or_else(|e| panic!("миграция {version} не применилась: {e}"));
        }
        conn
    }

    fn player(conn: &Connection, nickname: &str, osu_user_id: Option<i64>) -> i64 {
        create(conn, nickname, osu_user_id, None).unwrap()
    }

    fn tournament(conn: &Connection) -> i64 {
        conn.execute(
            "INSERT INTO tournaments (name, bracket_size, created_at) VALUES ('Кубок', 4, '2026-01-01')",
            [],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn match_row(conn: &Connection, t: i64, a: i64, b: i64, winner: Option<i64>) -> i64 {
        conn.execute(
            "INSERT INTO matches (tournament_id, bracket, round, slot_in_bracket, player_a, player_b, status, winner_id)
             VALUES (?1, 'upper', 1, 0, ?2, ?3, 'finished', ?4)",
            params![t, a, b, winner],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        if let Some(w) = winner {
            conn.execute(
                "INSERT INTO match_actions (match_id, n, type, actor_id, slot_label, winner_id, at)
                 VALUES (?1, 1, 'result', ?2, 'NM1', ?2, '2026-01-01')",
                params![id, w],
            )
            .unwrap();
        }
        id
    }

    #[test]
    fn merge_moves_everything_and_archives_the_duplicate() {
        let conn = full_db();
        let keep = player(&conn, "X", None);
        let gone = player(&conn, "NICK", Some(4242));
        let foe = player(&conn, "Y", None);

        let t1 = tournament(&conn);
        let t2 = tournament(&conn);

        // keep выиграл матч у foe; дубль выиграл свой. osu! ID только у дубля.
        let m1 = match_row(&conn, t1, keep, foe, Some(keep));
        let m2 = match_row(&conn, t1, gone, foe, Some(gone));

        conn.execute(
            "INSERT INTO tournament_players (tournament_id, player_id, seed, color, placement)
             VALUES (?1, ?2, 1, '#fff', 1)",
            params![t1, gone],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tournament_players (tournament_id, player_id, seed, color, placement)
             VALUES (?1, ?2, 2, '#fff', 3)",
            params![t2, keep],
        )
        .unwrap();
        // Турнир, где играли оба: строка дубля должна уйти, своя остаться.
        conn.execute(
            "INSERT INTO tournament_players (tournament_id, player_id, seed, color, placement)
             VALUES (?1, ?2, 3, '#fff', 5)",
            params![t2, gone],
        )
        .unwrap();

        let merged = merge(&conn, keep, gone).unwrap();

        // osu! ID переехал, дубль в архиве, keep — нет.
        assert_eq!(merged.osu_user_id, Some(4242));
        assert!(!merged.is_archived);
        assert!(get(&conn, gone).unwrap().unwrap().is_archived);

        // Оба матча теперь принадлежат keep, победители и действия переехали.
        for m in [m1, m2] {
            let (a, b, w): (i64, i64, Option<i64>) = conn
                .query_row(
                    "SELECT player_a, player_b, winner_id FROM matches WHERE id = ?1",
                    params![m],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
            assert_eq!(a, keep, "матч {m}: сторона A");
            assert_eq!(b, foe, "матч {m}: сторона B");
            assert_eq!(w, Some(keep), "матч {m}: победитель");
        }
        let actor: i64 = conn
            .query_row(
                "SELECT actor_id FROM match_actions WHERE match_id = ?1",
                params![m2],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(actor, keep);

        // Участия: свой турнир остался со своим местом, чужой переехал вместе
        // с первым местом, общий турнир не задвоился.
        let rows: Vec<(i64, Option<i64>)> = {
            let mut st = conn
                .prepare(
                    "SELECT tournament_id, placement FROM tournament_players
                      WHERE player_id = ?1 ORDER BY tournament_id",
                )
                .unwrap();
            st.query_map(params![keep], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        assert_eq!(rows, vec![(t1, Some(1)), (t2, Some(3))], "{rows:?}");

        // Статистика считается сама — и уже видит оба матча и оба турнира.
        let stats = stats(&conn, keep).unwrap();
        assert_eq!(stats.matches, 2);
        assert_eq!(stats.match_wins, 2);
        assert_eq!(stats.tournaments, 2);
        assert_eq!(stats.tournament_wins, 1);
    }

    #[test]
    fn merge_rejects_players_who_met_in_a_match() {
        let conn = full_db();
        let t = tournament(&conn);
        let a = player(&conn, "A", None);
        let b = player(&conn, "B", None);
        match_row(&conn, t, a, b, Some(a));

        let err = merge(&conn, a, b).unwrap_err().to_string();
        assert!(err.contains("друг с другом"), "{err}");
    }
}
