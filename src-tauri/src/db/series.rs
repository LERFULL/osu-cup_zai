//! Серии маппулов.
//!
//! Серия — группа пулов с типом. Турнирная знает про раунды и не повторяет
//! карты внутри себя: маппулы одного турнира с общими картами — это карта,
//! которую разыграют дважды, а игроки приедут на неё подготовленными.
//! Свободная — просто ящик: архив сезона, «мои любимые NM-пулы».
//!
//! Серия заменила папку: две сущности «группа маппулов» не нужны, а у серии
//! есть свои источники, исключения и статистика.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};

use super::{exclusions::Owner, now_iso, sources};
use crate::error::{AppError, Result};
use crate::model::{
    PoolOverlap, Series, SeriesPool, SeriesStats, SeriesStep, SourceSet,
};

fn row_to_series(row: &rusqlite::Row) -> rusqlite::Result<Series> {
    let fields: Option<String> = row.get("display_fields")?;
    Ok(Series {
        id: row.get("id")?,
        name: row.get("name")?,
        kind: row.get("kind")?,
        color: row.get("color")?,
        note: row.get("note")?,
        sources: sources::parse(row.get("sources")?),
        exclusions: Vec::new(),
        no_repeat_inside: row.get::<_, i64>("no_repeat_inside")? != 0,
        display_fields: fields.and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok()),
        tournament_id: row.get("tournament_id")?,
        position: row.get("position")?,
        created_at: row.get("created_at")?,
        pools: Vec::new(),
    })
}

const COLS: &str = "id, name, kind, color, note, sources, no_repeat_inside,
                    display_fields, tournament_id, position, created_at";

/// Список серий со составом, но без исключений: в дереве нужны только
/// названия, тип и счётчики.
pub fn list(conn: &Connection) -> Result<Vec<Series>> {
    let mut stmt =
        conn.prepare(&format!("SELECT {COLS} FROM series ORDER BY position ASC, id ASC"))?;
    let rows = stmt.query_map([], row_to_series)?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    for s in out.iter_mut() {
        s.pools = pools_of(conn, s.id)?;
    }
    Ok(out)
}

/// Одна серия целиком: состав и собственные исключения с подписями.
pub fn get(conn: &Connection, id: i64) -> Result<Series> {
    let mut found = conn
        .query_row(
            &format!("SELECT {COLS} FROM series WHERE id = ?1"),
            params![id],
            row_to_series,
        )
        .optional()?
        .ok_or_else(|| AppError::Other("Серия не найдена".into()))?;

    found.pools = pools_of(conn, id)?;

    // Счётчик отсечённого тут не считаем: он зависит от слота, а на экране
    // серии слотов нет. В панели пула он появится вместе с запасом.
    let ready = super::exclusions::ready(conn, &[(Owner::Series(id), None)])?;
    found.exclusions = super::exclusions::to_model(&ready, &HashSet::new());
    Ok(found)
}

/// Пулы серии в порядке позиции, каждый — со своей строкой для списка.
pub fn pools_of(conn: &Connection, series_id: i64) -> Result<Vec<SeriesPool>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, status, version, is_locked, series_position, series_label
           FROM pools WHERE series_id = ?1
          ORDER BY series_position ASC, id ASC",
    )?;

    let rows = stmt.query_map(params![series_id], |r| {
        Ok((
            r.get::<_, i64>("id")?,
            r.get::<_, String>("name")?,
            r.get::<_, String>("status")?,
            r.get::<_, i64>("version")?,
            r.get::<_, i64>("is_locked")? != 0,
            r.get::<_, i64>("series_position")?,
            r.get::<_, Option<String>>("series_label")?,
        ))
    })?;

    let mut heads = Vec::new();
    for row in rows {
        heads.push(row?);
    }

    let mut out = Vec::with_capacity(heads.len());
    for (id, name, status, version, is_locked, position, label) in heads {
        let pool = super::pools::get(conn, id)?;
        let stars: Vec<f64> = pool
            .slots
            .iter()
            .filter_map(|s| {
                s.star_rating_with_mods
                    .or(s.beatmap.as_ref().map(|m| m.difficulty_rating))
            })
            .collect();

        out.push(SeriesPool {
            pool_id: id,
            position,
            label: Some(label_at(label, position)),
            name,
            status,
            version,
            is_locked,
            shape: shape_of(&pool),
            slots: pool.slots.len() as i64,
            filled: pool.slots.iter().filter(|s| s.beatmap_id.is_some()).count() as i64,
            stars_min: stars.iter().copied().reduce(f64::min),
            stars_max: stars.iter().copied().reduce(f64::max),
            stars_avg: if stars.is_empty() {
                None
            } else {
                Some(stars.iter().sum::<f64>() / stars.len() as f64)
            },
            warnings: pool.slots.iter().map(|s| s.warnings.len() as i64).sum(),
        });
    }
    Ok(out)
}

/// Состав пула одной строкой: «NM×4 · HD×2 · TB×1».
fn shape_of(pool: &crate::model::Pool) -> String {
    let mut order: Vec<String> = Vec::new();
    let mut counts: HashMap<String, i64> = HashMap::new();
    for slot in &pool.slots {
        if !counts.contains_key(&slot.mod_tag) {
            order.push(slot.mod_tag.clone());
        }
        *counts.entry(slot.mod_tag.clone()).or_insert(0) += 1;
    }
    if order.is_empty() {
        return "слотов нет".into();
    }
    order
        .iter()
        .map(|m| format!("{m}×{}", counts.get(m).copied().unwrap_or(0)))
        .collect::<Vec<_>>()
        .join(" · ")
}

pub fn pool_ids(conn: &Connection, series_id: i64) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM pools WHERE series_id = ?1 ORDER BY series_position ASC, id ASC",
    )?;
    let rows = stmt.query_map(params![series_id], |r| r.get::<_, i64>(0))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Пулы серии, кроме архивных: статистика и правило «не повторять внутри»
/// считаются по актуальным версиям.
pub fn live_pool_ids(conn: &Connection, series_id: i64) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM pools WHERE series_id = ?1 AND status <> 'archived'
          ORDER BY series_position ASC, id ASC",
    )?;
    let rows = stmt.query_map(params![series_id], |r| r.get::<_, i64>(0))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

// ─────────────────────────────────────────────────────────────── запись

pub fn create(conn: &Connection, name: &str, kind: &str) -> Result<i64> {
    let kind = check_kind(kind)?;
    let next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM series",
        [],
        |r| r.get(0),
    )?;

    conn.execute(
        "INSERT INTO series (name, kind, no_repeat_inside, position, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            name.trim(),
            kind,
            // Смысл турнирной серии именно в этом, поэтому включено и не гасится.
            (kind == "tournament") as i64,
            next,
            now_iso()
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

fn check_kind(kind: &str) -> Result<&str> {
    match kind {
        "tournament" | "free" => Ok(kind),
        other => Err(AppError::Other(format!("Неизвестный тип серии: {other}"))),
    }
}

pub fn rename(conn: &Connection, id: i64, name: &str) -> Result<()> {
    conn.execute(
        "UPDATE series SET name = ?2 WHERE id = ?1",
        params![id, name.trim()],
    )?;
    Ok(())
}

pub fn set_color(conn: &Connection, id: i64, color: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE series SET color = ?2 WHERE id = ?1",
        params![id, color],
    )?;
    Ok(())
}

pub fn set_note(conn: &Connection, id: i64, note: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE series SET note = ?2 WHERE id = ?1",
        params![id, note],
    )?;
    Ok(())
}

/// Привязать серию к турниру (None — отвязать). Один турнир держит одну
/// серию: уникальный индекс по tournament_id не даст привязать вторую,
/// а турнир, которого нет, отсекается здесь.
pub fn set_tournament(conn: &Connection, id: i64, tournament_id: Option<i64>) -> Result<()> {
    if let Some(tid) = tournament_id {
        let found: Option<i64> = conn
            .query_row(
                "SELECT id FROM tournaments WHERE id = ?1",
                params![tid],
                |r| r.get(0),
            )
            .optional()?;
        if found.is_none() {
            return Err(AppError::Other("Турнир не найден".into()));
        }
    }
    conn.execute(
        "UPDATE series SET tournament_id = ?2 WHERE id = ?1",
        params![id, tournament_id],
    )?;
    Ok(())
}

pub fn set_sources(conn: &Connection, id: i64, set: Option<&SourceSet>) -> Result<()> {
    conn.execute(
        "UPDATE series SET sources = ?2 WHERE id = ?1",
        params![id, sources::dump(set)?],
    )?;
    Ok(())
}

pub fn set_display_fields(conn: &Connection, id: i64, fields: Option<&[String]>) -> Result<()> {
    let json = match fields {
        Some(f) => Some(serde_json::to_string(f)?),
        None => None,
    };
    conn.execute(
        "UPDATE series SET display_fields = ?2 WHERE id = ?1",
        params![id, json],
    )?;
    Ok(())
}

/// Тип серии. Обратно в турнирную — только если между пулами нет повторов:
/// иначе тип обещал бы то, чего в серии уже нет.
pub fn set_kind(conn: &Connection, id: i64, kind: &str) -> Result<Vec<PoolOverlap>> {
    let kind = check_kind(kind)?;

    if kind == "tournament" {
        let clashes = repeats(conn, id)?;
        if !clashes.is_empty() {
            return Ok(clashes);
        }
    }

    conn.execute(
        "UPDATE series SET kind = ?2, no_repeat_inside = ?3 WHERE id = ?1",
        params![id, kind, (kind == "tournament") as i64],
    )?;
    Ok(Vec::new())
}

/// Правило «карты не повторяются внутри серии». У турнирной не гасится.
pub fn set_no_repeat_inside(conn: &Connection, id: i64, value: bool) -> Result<Vec<PoolOverlap>> {
    let kind: String = conn
        .query_row("SELECT kind FROM series WHERE id = ?1", params![id], |r| {
            r.get(0)
        })
        .optional()?
        .ok_or_else(|| AppError::Other("Серия не найдена".into()))?;

    if kind == "tournament" && !value {
        return Err(AppError::Other(
            "У турнирной серии карты не повторяются — в этом её смысл. \
             Смени тип на свободную, если повторы нужны."
                .into(),
        ));
    }

    if value {
        let clashes = repeats(conn, id)?;
        if !clashes.is_empty() {
            return Ok(clashes);
        }
    }

    conn.execute(
        "UPDATE series SET no_repeat_inside = ?2 WHERE id = ?1",
        params![id, value as i64],
    )?;
    Ok(Vec::new())
}

/// Удаление серии не удаляет маппулы: они возвращаются в общий список.
pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "UPDATE pools SET series_id = NULL, series_position = 0, series_label = NULL
          WHERE series_id = ?1",
        params![id],
    )?;
    super::exclusions::delete_all(conn, Owner::Series(id))?;
    conn.execute("DELETE FROM series WHERE id = ?1", params![id])?;
    Ok(())
}

/// Копия серии со своими правилами. Пулы не копируются: серия — это
/// группировка, и дублировать её вместе с двенадцатью пулами никто не просил.
pub fn duplicate(conn: &Connection, id: i64) -> Result<i64> {
    let next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM series",
        [],
        |r| r.get(0),
    )?;

    conn.execute(
        "INSERT INTO series (name, kind, color, note, sources, no_repeat_inside,
                             display_fields, position, created_at)
         SELECT name || ' — копия', kind, color, note, sources, no_repeat_inside,
                display_fields, ?2, ?3
         FROM series WHERE id = ?1",
        params![id, next, now_iso()],
    )?;
    let new_id = conn.last_insert_rowid();
    super::exclusions::copy(conn, Owner::Series(id), Owner::Series(new_id))?;
    Ok(new_id)
}

/// Порядок серий в дереве.
pub fn reorder(conn: &Connection, ids: &[i64]) -> Result<()> {
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE series SET position = ?2 WHERE id = ?1",
            params![id, i as i64],
        )?;
    }
    Ok(())
}

// ────────────────────────────────────────────────────────────── состав

/// Метка раунда по номеру. Подставляется сама, но правится руками.
pub fn default_label(index: usize) -> String {
    format!("раунд {}", index + 1)
}

/// Метка пула в серии. Своя, если её задали руками; иначе — по месту в серии.
///
/// Автоматическую метку нарочно не храним: она обязана следовать за порядком,
/// а записанная в базу отстала бы от первой же перестановки — и перетаскивание
/// выглядело бы так, будто оно ничего не сделало.
pub fn label_at(stored: Option<String>, position: i64) -> String {
    match stored {
        Some(own) if !own.trim().is_empty() => own,
        _ => default_label(position.max(0) as usize),
    }
}

/// Пул входит в серию. Возвращает повторы, если серия их не терпит, —
/// тогда перенос не выполняется и решает пользователь.
pub fn add_pool(conn: &Connection, series_id: i64, pool_id: i64) -> Result<Vec<PoolOverlap>> {
    let no_repeat: bool = conn
        .query_row(
            "SELECT no_repeat_inside FROM series WHERE id = ?1",
            params![series_id],
            |r| Ok(r.get::<_, i64>(0)? != 0),
        )
        .optional()?
        .ok_or_else(|| AppError::Other("Серия не найдена".into()))?;

    if no_repeat {
        let mut ids = live_pool_ids(conn, series_id)?;
        if !ids.contains(&pool_id) {
            ids.push(pool_id);
        }
        let clashes = super::pools::overlaps_between_pools(conn, &ids)?;
        if !clashes.is_empty() {
            return Ok(clashes);
        }
    }

    let next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(series_position) + 1, 0) FROM pools WHERE series_id = ?1",
        params![series_id],
        |r| r.get(0),
    )?;

    // Метку не пишем: без своей она считается по месту.
    conn.execute(
        "UPDATE pools SET series_id = ?2, series_position = ?3 WHERE id = ?1",
        params![pool_id, series_id, next],
    )?;
    Ok(Vec::new())
}

/// Пул уходит из серии в общий список. Сама серия остаётся.
pub fn remove_pool(conn: &Connection, pool_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE pools SET series_id = NULL, series_position = 0, series_label = NULL
          WHERE id = ?1",
        params![pool_id],
    )?;
    Ok(())
}

/// Порядок пулов внутри серии. Он же порядок катания и порядок раундов.
pub fn reorder_pools(conn: &Connection, series_id: i64, pool_ids: &[i64]) -> Result<()> {
    for (i, id) in pool_ids.iter().enumerate() {
        conn.execute(
            "UPDATE pools SET series_position = ?2 WHERE id = ?1 AND series_id = ?3",
            params![id, i as i64, series_id],
        )?;
    }
    Ok(())
}

/// Своя метка раунда. Пустая строка возвращает метку к автоматической, а
/// значение, совпавшее с автоматическим, своим не становится: иначе оно
/// перестало бы следовать за порядком после первой же перестановки.
pub fn set_pool_label(conn: &Connection, pool_id: i64, label: Option<&str>) -> Result<()> {
    let clean = label.map(str::trim).filter(|s| !s.is_empty());

    let position: i64 = conn
        .query_row(
            "SELECT series_position FROM pools WHERE id = ?1",
            params![pool_id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);

    let keep = match clean {
        Some(own) if own == default_label(position.max(0) as usize) => None,
        other => other,
    };

    conn.execute(
        "UPDATE pools SET series_label = ?2 WHERE id = ?1",
        params![pool_id, keep],
    )?;
    Ok(())
}

// ──────────────────────────────────────────────────────── статистика

/// Карты, встречающиеся больше чем в одном пуле серии.
pub fn repeats(conn: &Connection, series_id: i64) -> Result<Vec<PoolOverlap>> {
    let ids = live_pool_ids(conn, series_id)?;
    super::pools::overlaps_between_pools(conn, &ids)
}

/// Сводка серии: пять чисел сверху, диаграмма роста сложности и повторы.
///
/// Считается по актуальным версиям пулов: архивные не участвуют, иначе
/// каждая правка сыгранного пула удваивала бы все числа.
pub fn stats(conn: &Connection, series_id: i64) -> Result<SeriesStats> {
    let pool_ids = live_pool_ids(conn, series_id)?;

    let mut steps: Vec<SeriesStep> = Vec::new();
    let mut total = 0i64;
    let mut unique: HashSet<i64> = HashSet::new();
    let mut per_map: HashMap<i64, usize> = HashMap::new();
    let mut mappers: HashMap<String, usize> = HashMap::new();
    let mut stars_min: Option<f64> = None;
    let mut stars_max: Option<f64> = None;
    let mut previous_avg: Option<f64> = None;

    for pid in &pool_ids {
        let pool = super::pools::get(conn, *pid)?;
        let label = label_at(pool.series_label.clone(), pool.series_position);

        let mut stars: Vec<f64> = Vec::new();

        for slot in &pool.slots {
            if let Some(bid) = slot.beatmap_id {
                total += 1;
                unique.insert(bid);
                *per_map.entry(bid).or_insert(0) += 1;
            }
            if let Some(map) = &slot.beatmap {
                if let Some(creator) = &map.creator {
                    *mappers.entry(creator.to_lowercase()).or_insert(0) += 1;
                }
            }
            if let Some(sr) = slot
                .star_rating_with_mods
                .or(slot.beatmap.as_ref().map(|m| m.difficulty_rating))
            {
                stars.push(sr);
            }
        }

        let lo = stars.iter().copied().reduce(f64::min);
        let hi = stars.iter().copied().reduce(f64::max);
        let avg = if stars.is_empty() {
            None
        } else {
            Some(stars.iter().sum::<f64>() / stars.len() as f64)
        };

        stars_min = min_opt(stars_min, lo);
        stars_max = max_opt(stars_max, hi);

        // Предупреждение мягкое, только подпись: бывает намеренно.
        let below = match (avg, previous_avg) {
            (Some(now), Some(before)) => now + 0.005 < before,
            _ => false,
        };
        if avg.is_some() {
            previous_avg = avg;
        }

        steps.push(SeriesStep {
            pool_id: *pid,
            label,
            stars_min: lo,
            stars_max: hi,
            stars_avg: avg,
            below_previous: below,
        });
    }

    // Карты, которые уже стояли в маппулах прошлых турниров, — но не в этой
    // серии: собственные пулы серии в «играли раньше» не считаются.
    let played_before = played_before(conn, &unique, &pool_ids)?;

    Ok(SeriesStats {
        pools: pool_ids.len() as i64,
        maps_total: total,
        maps_unique: unique.len() as i64,
        repeats: per_map.values().filter(|n| **n > 1).count() as i64,
        stars_min,
        stars_max,
        mappers: mappers.len() as i64,
        mappers_repeated: mappers.values().filter(|n| **n > 1).count() as i64,
        played_before,
        steps,
        repeat_rows: super::pools::overlaps_between_pools(conn, &pool_ids)?,
    })
}

fn min_opt(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.min(y)),
        (x, y) => x.or(y),
    }
}

fn max_opt(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.max(y)),
        (x, y) => x.or(y),
    }
}

/// Сколько карт серии уже были в маппулах прошлых турниров.
///
/// Собственные пулы серии из подсчёта исключены: карта, стоящая в её же
/// раунде, — это «играем сейчас», а не «играли раньше». Иначе серия,
/// привязанная к идущему турниру, целиком считалась бы уже игранной.
fn played_before(conn: &Connection, maps: &HashSet<i64>, own: &[i64]) -> Result<i64> {
    if maps.is_empty() {
        return Ok(0);
    }

    // Пустой список превратился бы в `NOT IN ()` — синтаксически неверно,
    // поэтому подставляем невозможный id.
    let args: Vec<i64> = if own.is_empty() { vec![-1] } else { own.to_vec() };
    let sql = format!(
        "SELECT DISTINCT s.beatmap_id
           FROM pool_slots s
          WHERE s.beatmap_id IS NOT NULL
            AND s.pool_id NOT IN ({})
            AND (s.pool_id IN (SELECT pool_id FROM tournament_pools)
              OR s.pool_id IN (SELECT pool_id FROM matches WHERE pool_id IS NOT NULL))",
        super::placeholders(args.len())
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
        r.get::<_, i64>(0)
    })?;

    let mut played: HashSet<i64> = HashSet::new();
    for row in rows {
        played.insert(row?);
    }

    Ok(maps.iter().filter(|id| played.contains(id)).count() as i64)
}
