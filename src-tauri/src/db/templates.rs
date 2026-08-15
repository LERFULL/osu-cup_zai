//! Шаблоны маппулов: структура будущего пула, а не сам пул.
//!
//! Слоты шаблона хранятся списком с позициями. Редактор присылает список
//! целиком, а не по одному слоту: перетаскивание меняет порядок сразу у
//! нескольких, и частичные правки пришлось бы сверять между собой.

use rusqlite::{params, Connection, OptionalExtension};

use super::{exclusions::Owner, now_iso, sources};
use crate::error::{AppError, Result};
use crate::model::{
    GenRules, LibraryFilter, PoolTemplate, Range, SourceSet, TemplateSlot, TemplateSlotInput,
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

pub fn slots_of(conn: &Connection, template_id: i64) -> Result<Vec<TemplateSlot>> {
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
        sources: sources::parse(row.get("sources")?),
        exclusions: Vec::new(),
        created_at: row.get("created_at")?,
        slots: Vec::new(),
    })
}

const COLS: &str = "id, name, rules, sources, created_at";

pub fn list(conn: &Connection) -> Result<Vec<PoolTemplate>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM pool_templates ORDER BY is_builtin DESC, id ASC"
    ))?;
    let rows = stmt.query_map([], row_to_template)?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    for t in out.iter_mut() {
        t.slots = slots_of(conn, t.id)?;
        t.exclusions = super::exclusions::to_model(
            &super::exclusions::ready(conn, &[(Owner::Template(t.id), None)])?,
            &std::collections::HashSet::new(),
        );
    }
    Ok(out)
}

pub fn get(conn: &Connection, id: i64) -> Result<PoolTemplate> {
    let mut found = conn
        .query_row(
            &format!("SELECT {COLS} FROM pool_templates WHERE id = ?1"),
            params![id],
            row_to_template,
        )
        .optional()?
        .ok_or_else(|| AppError::Other("Шаблон не найден".into()))?;

    found.slots = slots_of(conn, id)?;

    // Счётчик отсечённого считается вместе с запасом слота — здесь набора
    // кандидатов ещё нет, поэтому в списке шаблона он нулевой.
    let ready = super::exclusions::ready(conn, &[(Owner::Template(id), None)])?;
    found.exclusions = super::exclusions::to_model(&ready, &std::collections::HashSet::new());
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

/// Источники шаблона. `None` — вся библиотека, если серия и пул своих не задали.
pub fn set_sources(conn: &Connection, id: i64, set: Option<&SourceSet>) -> Result<()> {
    conn.execute(
        "UPDATE pool_templates SET sources = ?2 WHERE id = ?1",
        params![id, sources::dump(set)?],
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
        "INSERT INTO pool_templates (name, rules, sources, is_builtin, created_at)
         SELECT name || ' — копия', rules, sources, 0, ?2 FROM pool_templates WHERE id = ?1",
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

    super::exclusions::copy(conn, Owner::Template(id), Owner::Template(new_id))?;
    get(conn, new_id)
}

/// Удаление шаблона не трогает пулы, скатанные по нему: у пула останется
/// `template_id = NULL`, а карты и слоты на месте.
pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    super::exclusions::delete_all(conn, Owner::Template(id))?;
    conn.execute("DELETE FROM pool_templates WHERE id = ?1", params![id])?;
    Ok(())
}

// ────────────────────────────────────── условия слота одним фильтром

/// Условия самого слота: мод, диапазон звёзд, скилсеты. Без правил шаблона —
/// от них зависит, что считать отсечённым, и `supply` применяет их по одному.
pub fn slot_base(slot: &TemplateSlot) -> LibraryFilter {
    LibraryFilter {
        mods: vec![slot.mod_tag.clone()],
        skillsets: slot.required_skillsets.clone(),
        stars: Range {
            min: slot.star_min,
            max: slot.star_max,
        },
        ..LibraryFilter::default()
    }
}

/// Фильтр, эквивалентный слоту: его условия плюс те правила, которые заданы
/// строгими. Мягкие правила сюда не попадают — они работают весами при
/// подборе, а не фильтром: иначе «по возможности» ничем не отличалось бы
/// от «строго».
///
/// Тем же фильтром открывается панель подбора карты в слот — иначе руками
/// можно было бы поставить карту, которую генерация никогда бы не взяла.
pub fn slot_filter(slot: &TemplateSlot, rules: &GenRules) -> LibraryFilter {
    let mut f = slot_base(slot);

    if rules.ranked_only && rules.ranked_only_strict {
        f.statuses = vec!["ranked".to_string()];
    }
    if rules.length_max_strict {
        if let Some(max) = rules.length_max {
            f.length.max = Some(max as f64);
        }
    }
    // Коллекция-источник слота — самый узкий уровень источников. Остальные
    // уровни накладывает `sources::tiers`, который тоже получает этот фильтр.
    f.collection_id = slot.source_collection_id;
    f
}
