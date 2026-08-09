//! Маппулы: сам набор карт по слотам.
//!
//! Сыгранный пул неизменяем — иначе история и статистика поедут задним числом.
//! Попытка его отредактировать создаёт копию `v2` с ссылкой на оригинал.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};

use super::now_iso;
use crate::error::{AppError, Result};
use crate::model::{Beatmap, Pool, PoolSlot};

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
        beatmap: None,
        warnings: Vec::new(),
    })
}

fn slots_of(conn: &Connection, pool_id: i64) -> Result<Vec<PoolSlot>> {
    let mut stmt = conn.prepare(
        "SELECT id, slot_label, mod, beatmap_id, pinned, star_rating_with_mods, fm_mods, position
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
    Ok(Pool {
        id: row.get("id")?,
        name: row.get("name")?,
        template_id: row.get("template_id")?,
        template_name: row.get("template_name")?,
        folder_id: row.get("folder_id")?,
        status: row.get("status")?,
        version: row.get("version")?,
        parent_pool_id: row.get("parent_pool_id")?,
        display_fields: fields
            .and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok())
            .unwrap_or_else(|| DEFAULT_FIELDS.iter().map(|s| s.to_string()).collect()),
        is_locked: row.get::<_, i64>("is_locked")? != 0,
        created_at: row.get("created_at")?,
        slots: Vec::new(),
    })
}

const LIST_SQL: &str = "SELECT p.id, p.name, p.template_id, t.name AS template_name,
            p.folder_id, p.status, p.version, p.parent_pool_id, p.display_fields,
            p.is_locked, p.created_at
     FROM pools p LEFT JOIN pool_templates t ON t.id = p.template_id";

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

    fill_warnings(&mut pool);
    Ok(pool)
}

/// Предупреждения считаются при каждом чтении, а не хранятся: карту могли
/// отредактировать в библиотеке уже после того, как она попала в пул.
pub fn fill_warnings(pool: &mut Pool) {
    let mut seen_maps: HashMap<i64, usize> = HashMap::new();
    let mut seen_mappers: HashMap<String, usize> = HashMap::new();

    for slot in pool.slots.iter() {
        if let Some(bid) = slot.beatmap_id {
            *seen_maps.entry(bid).or_insert(0) += 1;
        }
        if let Some(map) = &slot.beatmap {
            if let Some(creator) = &map.creator {
                *seen_mappers.entry(creator.to_lowercase()).or_insert(0) += 1;
            }
        }
    }

    for slot in pool.slots.iter_mut() {
        let mut warnings = Vec::new();

        if let Some(bid) = slot.beatmap_id {
            if seen_maps.get(&bid).copied().unwrap_or(0) > 1 {
                warnings.push("карта уже есть в другом слоте".to_string());
            }
        }

        if let Some(map) = &slot.beatmap {
            if !map.mods.iter().any(|m| m == &slot.mod_tag) {
                warnings.push(format!("у карты не разрешён {}", slot.mod_tag));
            }
            if let Some(creator) = &map.creator {
                if seen_mappers
                    .get(&creator.to_lowercase())
                    .copied()
                    .unwrap_or(0)
                    > 1
                {
                    warnings.push("маппер повторяется".to_string());
                }
            }
            if map.is_gone {
                warnings.push("карта пропала с osu!".to_string());
            }
        }

        slot.warnings = warnings;
    }
}

// ─────────────────────────────────────────────────────────── запись

pub fn create(conn: &Connection, name: &str, template_id: Option<i64>) -> Result<i64> {
    conn.execute(
        "INSERT INTO pools (name, template_id, status, version, display_fields, created_at)
         VALUES (?1, ?2, 'draft', 1, ?3, ?4)",
        params![
            name.trim(),
            template_id,
            serde_json::to_string(&DEFAULT_FIELDS)?,
            now_iso()
        ],
    )?;
    Ok(conn.last_insert_rowid())
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
            (name, template_id, folder_id, status, version, parent_pool_id,
             display_fields, is_locked, created_at)
         SELECT ?2, template_id, folder_id, status, ?3, ?4, display_fields, 0, ?5
         FROM pools WHERE id = ?1",
        params![id, new_name, new_version, parent, now_iso()],
    )?;
    let new_id = conn.last_insert_rowid();

    conn.execute(
        "INSERT INTO pool_slots
            (pool_id, slot_label, mod, beatmap_id, pinned, star_rating_with_mods, fm_mods, position)
         SELECT ?2, slot_label, mod, beatmap_id, pinned, star_rating_with_mods, fm_mods, position
         FROM pool_slots WHERE pool_id = ?1",
        params![id, new_id],
    )?;

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
            (pool_id, slot_label, mod, beatmap_id, pinned, star_rating_with_mods, fm_mods, position)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
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
        beatmap: None,
        warnings: Vec::new(),
    });
    relabel(&mut slots);
    replace_slots(conn, pool_id, &slots)
}

pub fn remove_slot(conn: &Connection, pool_id: i64, position: i64) -> Result<()> {
    let mut slots = slots_of(conn, pool_id)?;
    let index = index_at(&slots, position)?;
    slots.remove(index);
    relabel(&mut slots);
    replace_slots(conn, pool_id, &slots)
}

pub fn change_slot_mod(conn: &Connection, pool_id: i64, position: i64, mod_tag: &str) -> Result<()> {
    let mut slots = slots_of(conn, pool_id)?;
    let index = index_at(&slots, position)?;
    slots[index].mod_tag = mod_tag.to_string();
    relabel(&mut slots);
    replace_slots(conn, pool_id, &slots)
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

/// Все карты, стоящие в перечисленных пулах — для правила «не повторять
/// карты из прошлых маппулов турнира».
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
