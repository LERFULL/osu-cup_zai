//! Маппулы: сам набор карт по слотам.
//!
//! Сыгранный пул неизменяем — иначе история и статистика поедут задним числом.
//! Попытка его отредактировать создаёт копию `v2` с ссылкой на оригинал.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{now_iso, series, sources};
use crate::error::{AppError, Result};
use crate::model::{Beatmap, Pool, PoolSlot, SlotWarning};

/// Что показывать в строке пула по умолчанию. Наследуется картинкой при экспорте.
const DEFAULT_FIELDS: [&str; 3] = ["stars", "length", "bpm"];

fn row_to_slot(row: &rusqlite::Row) -> rusqlite::Result<PoolSlot> {
    let fm: Option<String> = row.get("fm_mods")?;
    Ok(PoolSlot {
        id: row.get("id")?,
        slot_label: row.get("slot_label")?,
        mod_tag: row.get("mod")?,
        beatmap_id: row.get("beatmap_id")?,
        pinned: row.get::<_, i64>("pinned")? != 0,
        star_rating_with_mods: row.get("star_rating_with_mods")?,
        fm_mods: fm
            .and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok())
            .unwrap_or_default(),
        position: row.get("position")?,
        sources: sources::parse(row.get("sources")?),
        beatmap: None,
        warnings: Vec::new(),
    })
}

fn slots_of(conn: &Connection, pool_id: i64) -> Result<Vec<PoolSlot>> {
    let mut stmt = conn.prepare(
        "SELECT id, slot_label, mod, beatmap_id, pinned, star_rating_with_mods, fm_mods,
                position, sources
         FROM pool_slots WHERE pool_id = ?1 ORDER BY position ASC, id ASC",
    )?;
    let rows = stmt.query_map(params![pool_id], row_to_slot)?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn row_to_pool(row: &rusqlite::Row) -> rusqlite::Result<Pool> {
    let fields: Option<String> = row.get("display_fields")?;
    let series_id: Option<i64> = row.get("series_id")?;
    let position: i64 = row.get("series_position")?;
    let stored: Option<String> = row.get("series_label")?;
    Ok(Pool {
        id: row.get("id")?,
        name: row.get("name")?,
        template_id: row.get("template_id")?,
        template_name: row.get("template_name")?,
        series_id,
        series_name: row.get("series_name")?,
        series_kind: row.get("series_kind")?,
        // Без своей метки она считается по месту в серии — и потому следует
        // за перестановкой раундов, а не отстаёт от неё.
        series_label: series_id.map(|_| series::label_at(stored, position)),
        series_position: position,
        status: row.get("status")?,
        version: row.get("version")?,
        parent_pool_id: row.get("parent_pool_id")?,
        display_fields: fields
            .and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok())
            .unwrap_or_else(|| DEFAULT_FIELDS.iter().map(|s| s.to_string()).collect()),
        sources: sources::parse(row.get("sources")?),
        is_locked: row.get::<_, i64>("is_locked")? != 0,
        created_at: row.get("created_at")?,
        slots: Vec::new(),
    })
}

const LIST_SQL: &str = "SELECT p.id, p.name, p.template_id, t.name AS template_name,
            p.series_id, se.name AS series_name, se.kind AS series_kind,
            p.series_label, p.series_position,
            p.status, p.version, p.parent_pool_id, p.display_fields, p.sources,
            p.is_locked, p.created_at
     FROM pools p
     LEFT JOIN pool_templates t ON t.id = p.template_id
     LEFT JOIN series se ON se.id = p.series_id";

/// Список пулов со слотами, но без карт: в списке достаточно структуры
/// и средних звёзд, а тянуть карты на каждый пул слишком дорого.
pub fn list(conn: &Connection) -> Result<Vec<Pool>> {
    let mut stmt = conn.prepare(&format!("{LIST_SQL} ORDER BY p.created_at DESC, p.id DESC"))?;
    let rows = stmt.query_map([], row_to_pool)?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    for p in out.iter_mut() {
        p.slots = slots_of(conn, p.id)?;
    }
    Ok(out)
}

/// Один пул целиком: со слотами, картами и предупреждениями по строкам.
pub fn get(conn: &Connection, id: i64) -> Result<Pool> {
    let mut pool = conn
        .query_row(&format!("{LIST_SQL} WHERE p.id = ?1"), params![id], row_to_pool)
        .optional()?
        .ok_or_else(|| AppError::Other("Маппул не найден".into()))?;

    pool.slots = slots_of(conn, id)?;

    let ids: Vec<i64> = pool.slots.iter().filter_map(|s| s.beatmap_id).collect();
    let maps = super::beatmaps::by_ids(conn, &ids)?;
    // Одна карта может стоять в двух слотах — берём копией, а не изъятием.
    let by_id: HashMap<i64, Beatmap> = maps.into_iter().map(|m| (m.beatmap_id, m)).collect();

    for slot in pool.slots.iter_mut() {
        if let Some(bid) = slot.beatmap_id {
            slot.beatmap = by_id.get(&bid).cloned();
        }
    }

    let context = context_for(conn, &pool)?;
    fill_warnings(&mut pool, &context);
    Ok(pool)
}

/// Что нужно знать о мире, чтобы разметить строки пула: чем заняты соседние
/// пулы серии, какие диапазоны звёзд требует шаблон, что уже играли.
#[derive(Default)]
pub struct Context {
    /// Карта → метка раунда соседнего пула серии, где она уже стоит.
    pub in_series: HashMap<i64, String>,
    /// Мод-тег слота → допустимый диапазон звёзд по шаблону.
    pub stars: HashMap<String, (Option<f64>, Option<f64>)>,
    /// Карта → название турнира, в котором она уже была.
    pub played: HashMap<i64, String>,
}

/// Собирает контекст для одного пула. Три запроса — но только при чтении
/// одного пула, а не списка: без них строка не может сказать, почему карта
/// проблемная, и предупреждения сводятся к «что-то не так».
pub fn context_for(conn: &Connection, pool: &Pool) -> Result<Context> {
    let mut out = Context::default();

    if let Some(series_id) = pool.series_id {
        let mut stmt = conn.prepare(
            "SELECT s.beatmap_id, CASE WHEN p.series_id IS NULL THEN p.name
                     ELSE COALESCE(NULLIF(p.series_label, ''),
                                   'раунд ' || (p.series_position + 1)) END AS place
               FROM pool_slots s
               JOIN pools p ON p.id = s.pool_id
              WHERE p.series_id = ?1 AND p.id <> ?2
                AND p.status <> 'archived' AND s.beatmap_id IS NOT NULL
              ORDER BY p.series_position ASC",
        )?;
        let rows = stmt.query_map(params![series_id, pool.id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (bid, place) = row?;
            out.in_series.entry(bid).or_insert(place);
        }
    }

    if let Some(template_id) = pool.template_id {
        for slot in super::templates::slots_of(conn, template_id)? {
            out.stars
                .entry(slot.mod_tag)
                .or_insert((slot.star_min, slot.star_max));
        }
    }

    let ids: Vec<i64> = pool.slots.iter().filter_map(|s| s.beatmap_id).collect();
    if !ids.is_empty() {
        let holes = super::placeholders(ids.len());
        let sql = format!(
            "SELECT DISTINCT s.beatmap_id, tr.name
               FROM pool_slots s
               JOIN tournament_pools tp ON tp.pool_id = s.pool_id
               JOIN tournaments tr ON tr.id = tp.tournament_id
              WHERE s.beatmap_id IN ({holes}) AND s.pool_id <> ?{}",
            ids.len() + 1
        );
        let mut args: Vec<i64> = ids.clone();
        args.push(pool.id);

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (bid, name) = row?;
            out.played.entry(bid).or_insert(name);
        }
    }

    Ok(out)
}

/// Предупреждения считаются при каждом чтении, а не хранятся: карту могли
/// отредактировать в библиотеке уже после того, как она попала в пул.
///
/// Строгое нарушение — красное, мягкое — жёлтое. После генерации строгих быть
/// не может: они появляются только при ручной правке.
pub fn fill_warnings(pool: &mut Pool, ctx: &Context) {
    let mut seen_maps: HashMap<i64, Vec<String>> = HashMap::new();
    let mut seen_mappers: HashMap<String, usize> = HashMap::new();

    for slot in pool.slots.iter() {
        if let Some(bid) = slot.beatmap_id {
            seen_maps
                .entry(bid)
                .or_default()
                .push(slot.slot_label.clone());
        }
        if let Some(map) = &slot.beatmap {
            if let Some(creator) = &map.creator {
                *seen_mappers.entry(creator.to_lowercase()).or_insert(0) += 1;
            }
        }
    }

    for slot in pool.slots.iter_mut() {
        let mut warnings: Vec<SlotWarning> = Vec::new();

        if let Some(bid) = slot.beatmap_id {
            if let Some(places) = seen_maps.get(&bid) {
                let others: Vec<&String> = places.iter().filter(|l| **l != slot.slot_label).collect();
                if let Some(first) = others.first() {
                    warnings.push(SlotWarning {
                        text: format!("эта карта уже стоит в {first}"),
                        strict: true,
                    });
                }
            }

            if let Some(place) = ctx.in_series.get(&bid) {
                warnings.push(SlotWarning {
                    // Внутри турнирной серии это ошибка, внутри свободной —
                    // предупреждение. Тип серии решает строгость.
                    text: format!("уже играется в {place}"),
                    strict: pool.series_kind.as_deref() == Some("tournament"),
                });
            }

            if let Some(tournament) = ctx.played.get(&bid) {
                warnings.push(SlotWarning {
                    text: format!("играли в «{tournament}»"),
                    strict: false,
                });
            }
        }

        if let Some(map) = &slot.beatmap {
            if !map.mods.iter().any(|m| m == &slot.mod_tag) {
                warnings.push(SlotWarning {
                    text: format!("у карты нет мод-тега {}", slot.mod_tag),
                    strict: true,
                });
            }

            if let Some((lo, hi)) = ctx.stars.get(&slot.mod_tag) {
                let stars = slot
                    .star_rating_with_mods
                    .unwrap_or(map.difficulty_rating);
                let below = lo.is_some_and(|l| stars + 0.005 < l);
                let above = hi.is_some_and(|h| stars > h + 0.005);
                if below || above {
                    warnings.push(SlotWarning {
                        text: format!(
                            "{stars:.1} при диапазоне {}",
                            range_text(*lo, *hi)
                        ),
                        strict: true,
                    });
                }
            }

            if let Some(creator) = &map.creator {
                if seen_mappers
                    .get(&creator.to_lowercase())
                    .copied()
                    .unwrap_or(0)
                    > 1
                {
                    warnings.push(SlotWarning {
                        text: format!("второй пул от {creator}"),
                        strict: false,
                    });
                }
            }

            if map.is_gone {
                warnings.push(SlotWarning {
                    text: "карты больше нет на сайте".into(),
                    strict: true,
                });
            }
        }

        slot.warnings = warnings;
    }
}

fn range_text(lo: Option<f64>, hi: Option<f64>) -> String {
    match (lo, hi) {
        (Some(a), Some(b)) => format!("{a:.1}—{b:.1}"),
        (Some(a), None) => format!("от {a:.1}"),
        (None, Some(b)) => format!("до {b:.1}"),
        (None, None) => "без границ".into(),
    }
}

// ─────────────────────────────────────────────────────────── запись

pub fn create(conn: &Connection, name: &str, template_id: Option<i64>) -> Result<i64> {
    // Поля строки нового маппула — глобальный дефолт из настроек; без
    // настройки — встроенный набор. Уже созданные пулы не пересматриваем.
    let fields = super::prize::kv_get(conn, "defaultFields")
        .and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
        .unwrap_or_else(|| DEFAULT_FIELDS.iter().map(|s| s.to_string()).collect());

    conn.execute(
        "INSERT INTO pools (name, template_id, status, version, display_fields, created_at)
         VALUES (?1, ?2, 'draft', 1, ?3, ?4)",
        params![
            name.trim(),
            template_id,
            serde_json::to_string(&fields)?,
            now_iso()
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Свои источники пула. `None` — наследовать серию или шаблон.
pub fn set_sources(conn: &Connection, id: i64, set: Option<&crate::model::SourceSet>) -> Result<()> {
    conn.execute(
        "UPDATE pools SET sources = ?2 WHERE id = ?1",
        params![id, sources::dump(set)?],
    )?;
    Ok(())
}

/// Свои источники слота. `None` — наследовать пул.
pub fn set_slot_sources(
    conn: &Connection,
    slot_id: i64,
    set: Option<&crate::model::SourceSet>,
) -> Result<()> {
    conn.execute(
        "UPDATE pool_slots SET sources = ?2 WHERE id = ?1",
        params![slot_id, sources::dump(set)?],
    )?;
    Ok(())
}

pub fn rename(conn: &Connection, id: i64, name: &str) -> Result<()> {
    conn.execute(
        "UPDATE pools SET name = ?2 WHERE id = ?1",
        params![id, name.trim()],
    )?;
    Ok(())
}

pub fn set_status(conn: &Connection, id: i64, status: &str) -> Result<()> {
    if !matches!(status, "draft" | "ready" | "archived") {
        return Err(AppError::Other(format!("Неизвестный статус пула: {status}")));
    }
    conn.execute(
        "UPDATE pools SET status = ?2 WHERE id = ?1",
        params![id, status],
    )?;
    Ok(())
}

pub fn set_display_fields(conn: &Connection, id: i64, fields: &[String]) -> Result<()> {
    conn.execute(
        "UPDATE pools SET display_fields = ?2 WHERE id = ?1",
        params![id, serde_json::to_string(fields)?],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    super::exclusions::delete_all(conn, super::exclusions::Owner::Pool(id))?;
    conn.execute("DELETE FROM pools WHERE id = ?1", params![id])?;
    Ok(())
}

/// Заперт ли пул для правок. Замок ставит матч, в котором пул сыграли:
/// история и статистика не должны меняться задним числом.
pub fn is_locked(conn: &Connection, id: i64) -> Result<bool> {
    let locked: Option<i64> = conn
        .query_row("SELECT is_locked FROM pools WHERE id = ?1", params![id], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(locked.unwrap_or(0) != 0)
}

/// Копия пула. `next_version` = true — это правка сыгранного: копия получает
/// то же имя, версию на единицу больше и ссылку на оригинал.
///
/// Внутри серии новая версия занимает **то же место**: метка раунда и позиция
/// переезжают на неё, старая уходит в архив серии, а исключения, ссылавшиеся
/// на прежний пул, начинают ссылаться на новый. Иначе после правки сыгранного
/// пула серия осталась бы с архивной версией в раунде, а правило «не брать из
/// раунда 1» тихо перестало бы работать.
pub fn duplicate(conn: &Connection, id: i64, next_version: bool) -> Result<i64> {
    let (name, version): (String, i64) = conn
        .query_row("SELECT name, version FROM pools WHERE id = ?1", params![id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?
        .ok_or_else(|| AppError::Other("Маппул не найден".into()))?;

    let (new_name, new_version, parent) = if next_version {
        (name, version + 1, Some(id))
    } else {
        (format!("{name} — копия"), 1, None)
    };

    conn.execute(
        "INSERT INTO pools
            (name, template_id, series_id, series_position, series_label, status, version,
             parent_pool_id, display_fields, sources, is_locked, created_at)
         SELECT ?2, template_id, series_id, series_position, series_label, status,
                ?3, ?4, display_fields, sources, 0, ?5
         FROM pools WHERE id = ?1",
        params![id, new_name, new_version, parent, now_iso()],
    )?;
    let new_id = conn.last_insert_rowid();

    conn.execute(
        "INSERT INTO pool_slots
            (pool_id, slot_label, mod, beatmap_id, pinned, star_rating_with_mods, fm_mods,
             position, sources)
         SELECT ?2, slot_label, mod, beatmap_id, pinned, star_rating_with_mods, fm_mods,
                position, sources
         FROM pool_slots WHERE pool_id = ?1",
        params![id, new_id],
    )?;

    super::exclusions::copy(
        conn,
        super::exclusions::Owner::Pool(id),
        super::exclusions::Owner::Pool(new_id),
    )?;

    if next_version {
        // Старая версия уходит в архив серии и освобождает место в раунде.
        conn.execute(
            "UPDATE pools SET status = 'archived', series_label = NULL WHERE id = ?1",
            params![id],
        )?;
        super::exclusions::repoint_pool(conn, id, new_id)?;
    } else {
        // Копию кладут рядом, а не вместо: в серию её вносят руками.
        conn.execute(
            "UPDATE pools SET series_id = NULL, series_position = 0, series_label = NULL
              WHERE id = ?1",
            params![new_id],
        )?;
    }

    Ok(new_id)
}

/// Пул, в который можно писать. Сыгранный подменяется свежей копией `v2`,
/// и дальше правки идут уже в неё.
pub fn writable(conn: &Connection, id: i64) -> Result<i64> {
    if is_locked(conn, id)? {
        duplicate(conn, id, true)
    } else {
        Ok(id)
    }
}

// ─────────────────────────────────────────────────────────────── слоты

/// Метки слотов: NM1, NM2, DT1… TB без номера, потому что он всегда один.
pub fn label_for(mod_tag: &str, index: usize) -> String {
    if mod_tag == "TB" {
        "TB".to_string()
    } else {
        format!("{mod_tag}{}", index + 1)
    }
}

/// Слоты заменяются целиком — тем же приёмом, что и в шаблоне: перетаскивание
/// меняет порядок сразу у нескольких.
pub fn replace_slots(conn: &Connection, pool_id: i64, slots: &[PoolSlot]) -> Result<()> {
    conn.execute("DELETE FROM pool_slots WHERE pool_id = ?1", params![pool_id])?;

    let mut stmt = conn.prepare(
        "INSERT INTO pool_slots
            (pool_id, slot_label, mod, beatmap_id, pinned, star_rating_with_mods, fm_mods,
             position, sources)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )?;

    for (i, s) in slots.iter().enumerate() {
        stmt.execute(params![
            pool_id,
            s.slot_label,
            s.mod_tag,
            s.beatmap_id,
            s.pinned as i64,
            s.star_rating_with_mods,
            serde_json::to_string(&s.fm_mods)?,
            i as i64,
            sources::dump(s.sources.as_ref())?,
        ])?;
    }
    Ok(())
}

pub fn set_slot_beatmap(conn: &Connection, slot_id: i64, beatmap_id: Option<i64>) -> Result<()> {
    conn.execute(
        "UPDATE pool_slots SET beatmap_id = ?2 WHERE id = ?1",
        params![slot_id, beatmap_id],
    )?;
    Ok(())
}

pub fn set_slot_pinned(conn: &Connection, slot_id: i64, pinned: bool) -> Result<()> {
    conn.execute(
        "UPDATE pool_slots SET pinned = ?2 WHERE id = ?1",
        params![slot_id, pinned as i64],
    )?;
    Ok(())
}

pub fn set_slot_fm_mods(conn: &Connection, slot_id: i64, mods: &[String]) -> Result<()> {
    conn.execute(
        "UPDATE pool_slots SET fm_mods = ?2 WHERE id = ?1",
        params![slot_id, serde_json::to_string(mods)?],
    )?;
    Ok(())
}

/// Индекс слота по его позиции. Позиция, а не id: правка сыгранного пула
/// уводит запись в свежую копию, где id слотов уже другие, а порядок тот же.
pub fn index_at(slots: &[PoolSlot], position: i64) -> Result<usize> {
    slots
        .iter()
        .position(|s| s.position == position)
        .ok_or_else(|| AppError::Other("Слот не найден".into()))
}

/// Метки слотов зависят от порядка: NM1, NM2… Пересчитываются после любой
/// правки состава, иначе после удаления слота в номерах останется дырка.
pub fn relabel(slots: &mut [PoolSlot]) {
    // TB всегда последний — это правило пула, а не оформление.
    slots.sort_by_key(|s| (s.mod_tag == "TB", s.position));

    let mut counters: HashMap<String, usize> = HashMap::new();
    for (i, slot) in slots.iter_mut().enumerate() {
        let n = counters.entry(slot.mod_tag.clone()).or_insert(0);
        slot.slot_label = label_for(&slot.mod_tag, *n);
        *n += 1;
        slot.position = i as i64;
    }
}

pub fn add_slot(conn: &Connection, pool_id: i64, mod_tag: &str) -> Result<()> {
    let mut slots = slots_of(conn, pool_id)?;
    slots.push(PoolSlot {
        id: 0,
        slot_label: String::new(),
        mod_tag: mod_tag.to_string(),
        beatmap_id: None,
        pinned: false,
        star_rating_with_mods: None,
        fm_mods: Vec::new(),
        position: slots.len() as i64,
        sources: None,
        beatmap: None,
        warnings: Vec::new(),
    });
    relabel(&mut slots);
    replace_slots(conn, pool_id, &slots)
}

/// Убрать несколько слотов сразу — одно действие над выделением, а не N правок:
/// иначе метки пересчитывались бы после каждого удаления, и позиции, которые
/// пришли с фронта, поехали бы на середине пачки.
pub fn remove_slots(conn: &Connection, pool_id: i64, positions: &[i64]) -> Result<()> {
    let mut slots = slots_of(conn, pool_id)?;
    let gone: HashSet<i64> = positions.iter().copied().collect();
    slots.retain(|s| !gone.contains(&s.position));
    relabel(&mut slots);
    replace_slots(conn, pool_id, &slots)
}

/// Сменить мод у нескольких слотов сразу. TB в пуле один: если он уже есть,
/// пачка его не задвоит.
pub fn change_slots_mod(
    conn: &Connection,
    pool_id: i64,
    positions: &[i64],
    mod_tag: &str,
) -> Result<()> {
    let mut slots = slots_of(conn, pool_id)?;
    let touch: HashSet<i64> = positions.iter().copied().collect();

    if mod_tag == "TB" {
        let already = slots
            .iter()
            .any(|s| s.mod_tag == "TB" && !touch.contains(&s.position));
        if already || touch.len() > 1 {
            return Err(AppError::Other(
                "Тайбрейк в пуле ровно один — на несколько слотов его не поставить".into(),
            ));
        }
    }

    for slot in slots.iter_mut() {
        if touch.contains(&slot.position) {
            slot.mod_tag = mod_tag.to_string();
        }
    }
    relabel(&mut slots);
    replace_slots(conn, pool_id, &slots)
}

/// Закрепить или открепить несколько слотов сразу.
pub fn set_slots_pinned(
    conn: &Connection,
    pool_id: i64,
    positions: &[i64],
    pinned: bool,
) -> Result<()> {
    let slots = slots_of(conn, pool_id)?;
    let touch: HashSet<i64> = positions.iter().copied().collect();
    for slot in &slots {
        if touch.contains(&slot.position) {
            set_slot_pinned(conn, slot.id, pinned)?;
        }
    }
    Ok(())
}

/// Свои источники у нескольких слотов сразу. `None` — вернуть наследование.
pub fn set_slots_sources(
    conn: &Connection,
    pool_id: i64,
    positions: &[i64],
    set: Option<&crate::model::SourceSet>,
) -> Result<()> {
    let slots = slots_of(conn, pool_id)?;
    let touch: HashSet<i64> = positions.iter().copied().collect();
    for slot in &slots {
        if touch.contains(&slot.position) {
            set_slot_sources(conn, slot.id, set)?;
        }
    }
    Ok(())
}

/// Новый порядок задаётся списком нынешних позиций. Позиции, которых в списке
/// нет, дописываются в конец: потерять слот из-за неполного порядка нельзя.
pub fn reorder(conn: &Connection, pool_id: i64, order: &[i64]) -> Result<()> {
    let slots = slots_of(conn, pool_id)?;

    let mut moved = Vec::with_capacity(slots.len());
    for position in order {
        let index = index_at(&slots, *position)?;
        moved.push(slots[index].clone());
    }
    for slot in &slots {
        if !order.contains(&slot.position) {
            moved.push(slot.clone());
        }
    }

    relabel(&mut moved);
    replace_slots(conn, pool_id, &moved)
}

/// Карты, попавшие больше чем в один из указанных маппулов.
///
/// В рамках турнира или турнирной серии это ошибка: карта всплывёт в двух
/// матчах, а игроки приедут на неё подготовленными. Следить за этим по строкам
/// вручную невозможно, поэтому считаем запросом.
pub fn overlaps_between_pools(
    conn: &Connection,
    pool_ids: &[i64],
) -> Result<Vec<crate::model::PoolOverlap>> {
    if pool_ids.len() < 2 {
        return Ok(Vec::new());
    }

    let holes = super::placeholders(pool_ids.len());
    let sql = format!(
        "SELECT s.beatmap_id,
                COALESCE(b.artist || ' — ' || b.title, 'карта ' || s.beatmap_id) AS name,
                GROUP_CONCAT(DISTINCT CASE WHEN p.series_id IS NULL THEN p.name
                     ELSE COALESCE(NULLIF(p.series_label, ''),
                                   'раунд ' || (p.series_position + 1)) END) AS pools,
                GROUP_CONCAT(DISTINCT s.pool_id) AS ids
           FROM pool_slots s
           JOIN pools p ON p.id = s.pool_id
           LEFT JOIN beatmaps b ON b.beatmap_id = s.beatmap_id
          WHERE s.beatmap_id IS NOT NULL AND s.pool_id IN ({holes})
          GROUP BY s.beatmap_id
         HAVING COUNT(DISTINCT s.pool_id) > 1
          ORDER BY name COLLATE NOCASE"
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(pool_ids.iter()), |r| {
        let split = |raw: Option<String>| -> Vec<String> {
            raw.unwrap_or_default()
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        };
        Ok(crate::model::PoolOverlap {
            beatmap_id: r.get(0)?,
            name: r.get(1)?,
            pools: split(r.get::<_, Option<String>>(2)?),
            pool_ids: split(r.get::<_, Option<String>>(3)?)
                .into_iter()
                .filter_map(|s| s.parse::<i64>().ok())
                .collect(),
        })
    })?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }

    // Порядок пулов внутри строки — как в серии: «перекатить в последнем»
    // должно означать последний раунд, а не случайный из GROUP_CONCAT.
    let rank: HashMap<i64, usize> = pool_ids.iter().copied().zip(0..).collect();
    for row in out.iter_mut() {
        let mut pairs: Vec<(usize, i64)> = row
            .pool_ids
            .iter()
            .map(|id| (rank.get(id).copied().unwrap_or(usize::MAX), *id))
            .collect();
        pairs.sort_unstable();
        row.pool_ids = pairs.into_iter().map(|(_, id)| id).collect();
        row.pools = names_of(conn, &row.pool_ids)?;
    }
    Ok(out)
}

/// Названия пулов по id, в порядке списка: метка раунда, если она есть.
fn names_of(conn: &Connection, pool_ids: &[i64]) -> Result<Vec<String>> {
    let mut out = Vec::with_capacity(pool_ids.len());
    for id in pool_ids {
        let found: Option<String> = conn
            .query_row(
                "SELECT CASE WHEN pools.series_id IS NULL THEN pools.name
                     ELSE COALESCE(NULLIF(pools.series_label, ''),
                                   'раунд ' || (pools.series_position + 1)) END FROM pools WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        out.push(found.unwrap_or_else(|| format!("маппул {id}")));
    }
    Ok(out)
}

// ─────────────────────────────────────────────── импорт и экспорт JSON

/// Слот маппула в JSON-файле. Одна форма на экспорт и импорт: файл,
/// выгруженный из приложения, возвращается обратно без потерь.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PoolJsonSlot {
    #[serde(default)]
    pub slot_label: String,
    #[serde(rename = "mod")]
    pub mod_tag: String,
    #[serde(default)]
    pub beatmap_id: Option<i64>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub fm_mods: Vec<String>,
}

/// Файл маппула. `status` выгружается для человека, при импорте не
/// используется: новый пул всегда черновик — жизненный цикл не переносится.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolJson {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub slots: Vec<PoolJsonSlot>,
}

/// Что показывает диалог импорта до записи в базу: состав файла и сколько
/// карт придётся скачивать с osu!.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolImportPreview {
    pub pool_name: String,
    pub slots: Vec<PoolJsonSlot>,
    pub known_maps: i64,
    pub new_maps: i64,
}

/// Итог импорта: готовый пул и судьба карт, которых не было в библиотеке.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolImportResult {
    pub pool: Pool,
    pub saved_maps: i64,
    pub skipped_maps: i64,
}

/// Разбор файла с проверками. Ошибки — на человеческом языке: файл может быть
/// отредактирован руками, и «invalid type: null» из serde никому не скажет,
/// что именно не так.
pub fn parse_import(json: &str) -> Result<PoolJson> {
    let file: PoolJson = serde_json::from_str(json)
        .map_err(|e| AppError::Other(format!("Файл не похож на маппул: {e}")))?;

    if file.name.trim().is_empty() {
        return Err(AppError::Other(
            "У маппула в файле нет названия — импортировать нечего".into(),
        ));
    }

    for (i, slot) in file.slots.iter().enumerate() {
        if !crate::model::MOD_TAGS.contains(&slot.mod_tag.as_str()) {
            let place = if slot.slot_label.is_empty() {
                format!("№{}", i + 1)
            } else {
                slot.slot_label.clone()
            };
            return Err(AppError::Other(format!(
                "Неизвестный мод «{}» в слоте {place}",
                slot.mod_tag
            )));
        }
    }

    Ok(file)
}

/// Маппул в JSON: { name, status, slots: [{ slotLabel, mod, beatmapId, pinned, fmMods }] }.
pub fn export_json(conn: &Connection, pool_id: i64) -> Result<String> {
    let pool = get(conn, pool_id)?;
    let file = PoolJson {
        name: pool.name,
        status: Some(pool.status),
        slots: pool
            .slots
            .iter()
            .map(|s| PoolJsonSlot {
                slot_label: s.slot_label.clone(),
                mod_tag: s.mod_tag.clone(),
                beatmap_id: s.beatmap_id,
                pinned: s.pinned,
                fm_mods: s.fm_mods.clone(),
            })
            .collect(),
    };
    Ok(serde_json::to_string_pretty(&file)?)
}

/// Разбор без записи: диалог импорта решает, скачивать ли недостающие карты.
pub fn preview_import(conn: &Connection, json: &str) -> Result<PoolImportPreview> {
    let file = parse_import(json)?;
    let ids = import_beatmap_ids(&file);
    let known = existing_beatmap_ids(conn, &ids)?;
    let known_maps = ids.iter().filter(|id| known.contains(*id)).count() as i64;

    Ok(PoolImportPreview {
        pool_name: file.name.trim().to_string(),
        known_maps,
        new_maps: ids.len() as i64 - known_maps,
        slots: file.slots,
    })
}

/// Уникальные id карт из файла, в порядке первого появления.
pub fn import_beatmap_ids(file: &PoolJson) -> Vec<i64> {
    let mut out: Vec<i64> = Vec::new();
    for slot in &file.slots {
        if let Some(id) = slot.beatmap_id {
            if !out.contains(&id) {
                out.push(id);
            }
        }
    }
    out
}

/// Какие из перечисленных карт уже лежат в библиотеке.
pub fn existing_beatmap_ids(conn: &Connection, ids: &[i64]) -> Result<HashSet<i64>> {
    let mut out = HashSet::new();
    for chunk in ids.chunks(super::CHUNK) {
        if chunk.is_empty() {
            continue;
        }
        let sql = format!(
            "SELECT beatmap_id FROM beatmaps WHERE beatmap_id IN ({})",
            super::placeholders(chunk.len())
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(chunk.iter()), |r| {
            r.get::<_, i64>(0)
        })?;
        for row in rows {
            out.insert(row?);
        }
    }
    Ok(out)
}

/// Создаёт пул-черновик из разобранного файла. Возвращает id нового пула.
///
/// Карта, которой нет в библиотеке, оставляет слот пустым: хранить висячий
/// `beatmap_id` нельзя — внешний ключ на `beatmaps` не даст вставить строку, а
/// строка-призрак с несуществующей картой попала бы в матчи и генерацию и
/// выглядела бы играемой. Слот остаётся с меткой и модом: его видно, его можно
/// заполнить руками, и пул не притворяется собранным. Сколько карт пропущено,
/// импорт сообщает счётчиком.
pub fn import_pool(conn: &Connection, file: &PoolJson) -> Result<i64> {
    let known = existing_beatmap_ids(conn, &import_beatmap_ids(file))?;
    let id = create(conn, file.name.trim(), None)?;

    let mut stmt = conn.prepare(
        "INSERT INTO pool_slots
            (pool_id, slot_label, mod, beatmap_id, pinned, star_rating_with_mods, fm_mods,
             position, sources)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, NULL)",
    )?;

    for (i, slot) in file.slots.iter().enumerate() {
        // Пустую метку в файле заполняем по правилу пула — как при добавлении слота.
        let label = if slot.slot_label.trim().is_empty() {
            label_for(&slot.mod_tag, i)
        } else {
            slot.slot_label.trim().to_string()
        };
        let beatmap_id = slot.beatmap_id.filter(|id| known.contains(id));

        stmt.execute(params![
            id,
            label,
            slot.mod_tag,
            beatmap_id,
            slot.pinned as i64,
            serde_json::to_string(&slot.fm_mods)?,
            i as i64,
        ])?;
    }
    Ok(id)
}

/// Карты, лежащие хотя бы в одном из указанных маппулов.
pub fn beatmaps_in_pools(conn: &Connection, pool_ids: &[i64]) -> Result<Vec<i64>> {
    if pool_ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT DISTINCT beatmap_id FROM pool_slots
         WHERE beatmap_id IS NOT NULL AND pool_id IN ({})",
        super::placeholders(pool_ids.len())
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(pool_ids.iter()), |r| {
        r.get::<_, i64>(0)
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

    /// База с полным набором миграций — та же схема, что у приложения.
    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("база в памяти");
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        for (version, sql) in super::super::MIGRATIONS {
            conn.execute_batch(sql)
                .unwrap_or_else(|e| panic!("миграция {version} не применилась: {e}"));
        }
        conn
    }

    fn slot(label: &str, mod_tag: &str, beatmap_id: Option<i64>) -> PoolJsonSlot {
        PoolJsonSlot {
            slot_label: label.into(),
            mod_tag: mod_tag.into(),
            beatmap_id,
            pinned: false,
            fm_mods: vec![],
        }
    }

    #[test]
    fn export_import_json_round_trip() {
        let conn = db();
        super::super::beatmaps::upsert(&conn, &test_map(7)).unwrap();

        let pool_id = create(&conn, "Вечерний", None).unwrap();
        replace_slots(
            &conn,
            pool_id,
            &[
                PoolSlot {
                    id: 0,
                    slot_label: "NM1".into(),
                    mod_tag: "NM".into(),
                    beatmap_id: Some(7),
                    pinned: true,
                    star_rating_with_mods: None,
                    fm_mods: vec![],
                    position: 0,
                    sources: None,
                    beatmap: None,
                    warnings: vec![],
                },
                PoolSlot {
                    id: 0,
                    slot_label: "TB".into(),
                    mod_tag: "TB".into(),
                    beatmap_id: None,
                    pinned: false,
                    star_rating_with_mods: None,
                    fm_mods: vec![],
                    position: 1,
                    sources: None,
                    beatmap: None,
                    warnings: vec![],
                },
            ],
        )
        .unwrap();

        // Экспорт → разбор → импорт: состав и порядок слотов не меняются.
        let json = export_json(&conn, pool_id).unwrap();
        let file = parse_import(&json).unwrap();
        let imported = import_pool(&conn, &file).unwrap();

        let got = get(&conn, imported).unwrap();
        assert_eq!(got.name, "Вечерний");
        assert_eq!(got.status, "draft");
        assert_eq!(got.slots.len(), 2);
        assert_eq!(got.slots[0].slot_label, "NM1");
        assert_eq!(got.slots[0].beatmap_id, Some(7));
        assert!(got.slots[0].pinned);
        assert_eq!(got.slots[1].slot_label, "TB");
        assert_eq!(got.slots[1].beatmap_id, None);
    }

    #[test]
    fn import_skips_maps_missing_from_library() {
        let conn = db();
        super::super::beatmaps::upsert(&conn, &test_map(7)).unwrap();

        let file = PoolJson {
            name: "Чужой пул".into(),
            status: Some("ready".into()),
            slots: vec![
                slot("NM1", "NM", Some(7)),
                slot("HD1", "HD", Some(999_999)), // нет в библиотеке
            ],
        };

        // Превью честно считает: одна карта есть, одна новая.
        let preview = preview_import(&conn, &serde_json::to_string(&file).unwrap()).unwrap();
        assert_eq!(preview.known_maps, 1);
        assert_eq!(preview.new_maps, 1);
        assert_eq!(preview.pool_name, "Чужой пул");

        // Импорт без карт: неизвестная оставляет слот пустым, а не падает
        // на внешнем ключе и не притворяется заполненной.
        let id = import_pool(&conn, &file).unwrap();
        let got = get(&conn, id).unwrap();
        assert_eq!(got.slots[0].beatmap_id, Some(7));
        assert_eq!(got.slots[1].beatmap_id, None);
        assert_eq!(got.slots[1].mod_tag, "HD");
    }

    #[test]
    fn broken_json_and_unknown_mod_report_human_errors() {
        let e = parse_import("не json вообще").unwrap_err().to_string();
        assert!(e.contains("не похож на маппул"), "{e}");

        let e = parse_import(r#"{"slots":[]}"#).unwrap_err().to_string();
        assert!(e.contains("названия"), "{e}");

        let e = parse_import(r#"{"name":"X","slots":[{"slotLabel":"NM1","mod":"XX"}]}"#)
            .unwrap_err()
            .to_string();
        assert!(e.contains("Неизвестный мод"), "{e}");
    }

    /// Минимальная карта для внешнего ключа.
    fn test_map(id: i64) -> crate::model::Beatmap {
        crate::model::Beatmap {
            beatmap_id: id,
            beatmapset_id: Some(id * 10),
            checksum: None,
            artist: "A".into(),
            artist_unicode: None,
            title: "Song".into(),
            title_unicode: None,
            version: "Extra".into(),
            creator: None,
            creator_id: None,
            difficulty_rating: 5.0,
            bpm: Some(180.0),
            total_length: Some(120),
            hit_length: None,
            cs: None,
            ar: None,
            accuracy: None,
            drain: None,
            count_circles: None,
            count_sliders: None,
            count_spinners: None,
            max_combo: None,
            status: None,
            ranked_date: None,
            last_updated: None,
            tags: None,
            pack_tags: None,
            genre_id: None,
            language_id: None,
            failtimes: None,
            cover_path: None,
            preview_path: None,
            note: None,
            is_manual: false,
            is_gone: false,
            added_at: "2026-01-01T00:00:00Z".into(),
            mods: vec!["NM".into()],
            fm_mods: vec![],
            skillsets: vec![],
            labels: vec![],
            set_count: None,
            set_stars_min: None,
            set_stars_max: None,
        }
    }
}
