//! Шаблоны маппулов: структура будущего пула, а не сам пул.
//!
//! Слоты шаблона хранятся списком с позициями. Редактор присылает список
//! целиком, а не по одному слоту: перетаскивание меняет порядок сразу у
//! нескольких, и частичные правки пришлось бы сверять между собой.

use rusqlite::{params, Connection, OptionalExtension};

use super::now_iso;
use crate::error::{AppError, Result};
use crate::model::{
    GenRules, LibraryFilter, PoolTemplate, Range, SlotSupply, TemplateSlot, TemplateSlotInput,
};

fn row_to_slot(row: &rusqlite::Row) -> rusqlite::Result<TemplateSlot> {
    let skillsets: Option<String> = row.get("required_skillsets")?;
    Ok(TemplateSlot {
        id: row.get("id")?,
        mod_tag: row.get("mod")?,
        count: row.get("count")?,
        star_min: row.get("star_min")?,
        star_max: row.get("star_max")?,
        source_collection_id: row.get("source_collection_id")?,
        // Испорченный JSON не повод потерять весь слот — он просто останется
        // без требований к скилсетам.
        required_skillsets: skillsets
            .and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok())
            .unwrap_or_default(),
        position: row.get("position")?,
    })
}

fn slots_of(conn: &Connection, template_id: i64) -> Result<Vec<TemplateSlot>> {
    let mut stmt = conn.prepare(
        "SELECT id, mod, count, star_min, star_max, source_collection_id,
                required_skillsets, position
         FROM template_slots WHERE template_id = ?1 ORDER BY position ASC, id ASC",
    )?;
    let rows = stmt.query_map(params![template_id], row_to_slot)?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn row_to_template(row: &rusqlite::Row) -> rusqlite::Result<PoolTemplate> {
    let rules: String = row.get("rules")?;
    Ok(PoolTemplate {
        id: row.get("id")?,
        name: row.get("name")?,
        rules: serde_json::from_str(&rules).unwrap_or_default(),
        created_at: row.get("created_at")?,
        slots: Vec::new(),
    })
}

pub fn list(conn: &Connection) -> Result<Vec<PoolTemplate>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, rules, created_at FROM pool_templates
         ORDER BY is_builtin DESC, id ASC",
    )?;
    let rows = stmt.query_map([], row_to_template)?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    for t in out.iter_mut() {
        t.slots = slots_of(conn, t.id)?;
    }
    Ok(out)
}

pub fn get(conn: &Connection, id: i64) -> Result<PoolTemplate> {
    let mut found = conn
        .query_row(
            "SELECT id, name, rules, created_at FROM pool_templates WHERE id = ?1",
            params![id],
            row_to_template,
        )
        .optional()?
        .ok_or_else(|| AppError::Other("Шаблон не найден".into()))?;

    found.slots = slots_of(conn, id)?;
    Ok(found)
}

pub fn create(conn: &Connection, name: &str) -> Result<PoolTemplate> {
    conn.execute(
        "INSERT INTO pool_templates (name, rules, is_builtin, created_at) VALUES (?1, '{}', 0, ?2)",
        params![name.trim(), now_iso()],
    )?;
    get(conn, conn.last_insert_rowid())
}

pub fn rename(conn: &Connection, id: i64, name: &str) -> Result<()> {
    conn.execute(
        "UPDATE pool_templates SET name = ?2 WHERE id = ?1",
        params![id, name.trim()],
    )?;
    Ok(())
}

pub fn set_rules(conn: &Connection, id: i64, rules: &GenRules) -> Result<()> {
    conn.execute(
        "UPDATE pool_templates SET rules = ?2 WHERE id = ?1",
        params![id, serde_json::to_string(rules)?],
    )?;
    Ok(())
}

/// Слоты заменяются целиком. Позиция берётся из порядка в списке — так
/// перетаскивание в редакторе не требует отдельной команды.
pub fn set_slots(conn: &Connection, id: i64, slots: &[TemplateSlotInput]) -> Result<()> {
    conn.execute(
        "DELETE FROM template_slots WHERE template_id = ?1",
        params![id],
    )?;

    let mut stmt = conn.prepare(
        "INSERT INTO template_slots
            (template_id, mod, count, star_min, star_max,
             source_collection_id, required_skillsets, position)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?;

    for (i, s) in slots.iter().enumerate() {
        // Ноль слотов сгенерировал бы пустую строку в пуле — режем на входе.
        let count = s.count.clamp(1, 32);
        stmt.execute(params![
            id,
            s.mod_tag,
            count,
            s.star_min,
            s.star_max,
            s.source_collection_id,
            serde_json::to_string(&s.required_skillsets)?,
            i as i64,
        ])?;
    }
    Ok(())
}

pub fn duplicate(conn: &Connection, id: i64) -> Result<PoolTemplate> {
    conn.execute(
        "INSERT INTO pool_templates (name, rules, is_builtin, created_at)
         SELECT name || ' — копия', rules, 0, ?2 FROM pool_templates WHERE id = ?1",
        params![id, now_iso()],
    )?;
    let new_id = conn.last_insert_rowid();

    conn.execute(
        "INSERT INTO template_slots
            (template_id, mod, count, star_min, star_max,
             source_collection_id, required_skillsets, position)
         SELECT ?2, mod, count, star_min, star_max,
                source_collection_id, required_skillsets, position
         FROM template_slots WHERE template_id = ?1",
        params![id, new_id],
    )?;

    get(conn, new_id)
}

/// Удаление шаблона не трогает пулы, скатанные по нему: у пула останется
/// `template_id = NULL`, а карты и слоты на месте.
pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM pool_templates WHERE id = ?1", params![id])?;
    Ok(())
}

// ────────────────────────────────────── сколько карт есть под слоты

/// Фильтр, эквивалентный слоту: его источник, диапазон звёзд, мод и скилсеты
/// плюс те правила шаблона, которые сужают выбор карт.
///
/// Тем же фильтром открывается панель подбора карты в слот — иначе руками
/// можно было бы поставить карту, которую генерация никогда бы не взяла.
pub fn slot_filter(slot: &TemplateSlot, rules: &GenRules) -> LibraryFilter {
    LibraryFilter {
        mods: vec![slot.mod_tag.clone()],
        skillsets: slot.required_skillsets.clone(),
        statuses: if rules.ranked_only {
            vec!["ranked".to_string()]
        } else {
            vec![]
        },
        stars: Range {
            min: slot.star_min,
            max: slot.star_max,
        },
        length: Range {
            min: None,
            max: rules.length_max.map(|l| l as f64),
        },
        collection_id: slot.source_collection_id,
        ..LibraryFilter::default()
    }
}

/// Сколько карт нужно под каждый слот и сколько подходит в его источнике.
/// Считается по одному слоту независимо: пересечения между слотами тут не
/// видны, их ловит уже сама генерация.
pub fn supply(conn: &Connection, id: i64) -> Result<Vec<SlotSupply>> {
    let template = get(conn, id)?;
    let mut out = Vec::new();

    for slot in &template.slots {
        let filter = slot_filter(slot, &template.rules);
        let ids = super::beatmaps::ids_for(conn, &filter)?;
        out.push(SlotSupply {
            position: slot.position,
            mod_tag: slot.mod_tag.clone(),
            need: slot.count,
            available: ids.len() as i64,
        });
    }
    Ok(out)
}
