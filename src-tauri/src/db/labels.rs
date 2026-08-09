//! Метки — свободные ярлыки пользователя: «фан», «мем», «проверено».

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::Result;
use crate::model::Label;

pub fn list(conn: &Connection) -> Result<Vec<Label>> {
    let mut stmt =
        conn.prepare("SELECT id, name, color FROM labels ORDER BY name COLLATE NOCASE ASC")?;
    let rows = stmt.query_map([], |r| {
        Ok(Label {
            id: r.get(0)?,
            name: r.get(1)?,
            color: r.get(2)?,
        })
    })?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Идемпотентно по имени: повторное создание возвращает существующую метку,
/// а не плодит дубли.
///
/// Сравнение регистронезависимое и делается в Rust: `COLLATE NOCASE` в SQLite
/// сворачивает только латиницу, поэтому «фан» и «ФАН» он считает разными.
pub fn create(conn: &Connection, name: &str, color: Option<&str>) -> Result<Label> {
    let name = name.trim();
    let key = name.to_lowercase();

    let mut stmt = conn.prepare("SELECT id, name, color FROM labels")?;
    let rows = stmt.query_map([], |r| {
        Ok(Label {
            id: r.get(0)?,
            name: r.get(1)?,
            color: r.get(2)?,
        })
    })?;

    for row in rows {
        let label = row?;
        if label.name.to_lowercase() == key {
            return Ok(label);
        }
    }
    drop(stmt);

    conn.execute(
        "INSERT INTO labels (name, color) VALUES (?1, ?2)",
        params![name, color],
    )?;

    Ok(Label {
        id: conn.last_insert_rowid(),
        name: name.to_string(),
        color: color.map(str::to_string),
    })
}

pub fn set_for_beatmap(conn: &Connection, beatmap_id: i64, label_ids: &[i64]) -> Result<()> {
    conn.execute(
        "DELETE FROM beatmap_labels WHERE beatmap_id = ?1",
        params![beatmap_id],
    )?;
    let mut stmt = conn
        .prepare("INSERT OR IGNORE INTO beatmap_labels (beatmap_id, label_id) VALUES (?1, ?2)")?;
    for id in label_ids {
        stmt.execute(params![beatmap_id, id])?;
    }
    Ok(())
}

pub fn bulk_add(conn: &Connection, beatmap_ids: &[i64], label_id: i64) -> Result<()> {
    let mut stmt = conn
        .prepare("INSERT OR IGNORE INTO beatmap_labels (beatmap_id, label_id) VALUES (?1, ?2)")?;
    for id in beatmap_ids {
        stmt.execute(params![id, label_id])?;
    }
    Ok(())
}
