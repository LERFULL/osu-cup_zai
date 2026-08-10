//! Коллекции, умные коллекции и папки.
//!
//! Коллекция — это место, где ты находишься, а не фильтр. Удаление коллекции
//! никогда не трогает сами карты.

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};

use super::{now_iso, placeholders, CHUNK};
use crate::error::{AppError, Result};
use crate::model::{Collection, Folder, LibraryFilter};

fn row_to_collection(row: &rusqlite::Row) -> rusqlite::Result<Collection> {
    let filter_json: Option<String> = row.get("filter")?;
    Ok(Collection {
        id: row.get("id")?,
        name: row.get("name")?,
        color: row.get("color")?,
        icon: row.get("icon")?,
        folder_id: row.get("folder_id")?,
        position: row.get("position")?,
        is_smart: row.get::<_, i64>("is_smart")? != 0,
        // Испорченный фильтр не должен ронять весь список — коллекция
        // просто покажется без него.
        filter: filter_json.and_then(|j| serde_json::from_str::<LibraryFilter>(&j).ok()),
        count: row.get("cnt")?,
        created_at: row.get("created_at")?,
    })
}

/// Счётчик карт. У обычной коллекции это число строк в ней; у умной —
/// размер выдачи по сохранённому фильтру. Умных обычно несколько, и гнать
/// подсчёт каждого на каждый показ дорого, поэтому считаем один раз
/// запросом по всем коллекциям сразу.
const LIST_SQL: &str = "SELECT c.id, c.name, c.color, c.icon, c.folder_id, c.position,
            c.is_smart, c.filter, c.created_at,
            CASE WHEN c.is_smart = 1 THEN 0 ELSE (
                SELECT COUNT(*) FROM collection_beatmaps cb WHERE cb.collection_id = c.id
            ) END AS cnt
     FROM collections c";

pub fn list(conn: &Connection) -> Result<Vec<Collection>> {
    let mut stmt = conn.prepare(&format!(
        "{LIST_SQL} ORDER BY c.is_smart ASC, c.position ASC, c.id ASC"
    ))?;
    let rows = stmt.query_map([], row_to_collection)?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }

    // Умные коллекции: их состав — это фильтр, и счётчик заполняем живым
    // подсчётом, а не нулём из списка. Считаем только те, что есть на экране.
    for c in out.iter_mut().filter(|c| c.is_smart) {
        if let Some(filter) = &c.filter {
            c.count = super::beatmaps::count_for(conn, filter)?;
        }
    }
    Ok(out)
}

fn get(conn: &Connection, id: i64) -> Result<Collection> {
    conn.query_row(&format!("{LIST_SQL} WHERE c.id = ?1"), params![id], |r| {
        row_to_collection(r)
    })
    .optional()?
    .ok_or_else(|| AppError::Other("Коллекция не найдена".into()))
}

fn next_position(conn: &Connection, folder_id: Option<i64>) -> Result<i64> {
    let max: Option<i64> = conn.query_row(
        "SELECT MAX(position) FROM collections
         WHERE folder_id IS ?1 OR (?1 IS NULL AND folder_id IS NULL)",
        params![folder_id],
        |r| r.get(0),
    )?;
    Ok(max.unwrap_or(0) + 1)
}

pub fn create(conn: &Connection, name: &str, color: Option<&str>) -> Result<Collection> {
    let position = next_position(conn, None)?;
    conn.execute(
        "INSERT INTO collections (name, color, position, is_smart, created_at)
         VALUES (?1, ?2, ?3, 0, ?4)",
        params![name.trim(), color, position, now_iso()],
    )?;
    get(conn, conn.last_insert_rowid())
}

pub fn create_smart(
    conn: &Connection,
    name: &str,
    color: Option<&str>,
    filter: &LibraryFilter,
) -> Result<Collection> {
    let position = next_position(conn, None)?;
    conn.execute(
        "INSERT INTO collections (name, color, position, is_smart, filter, created_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?5)",
        params![
            name.trim(),
            color,
            position,
            serde_json::to_string(filter)?,
            now_iso()
        ],
    )?;
    get(conn, conn.last_insert_rowid())
}

pub fn rename(conn: &Connection, id: i64, name: &str) -> Result<()> {
    conn.execute(
        "UPDATE collections SET name = ?2 WHERE id = ?1",
        params![id, name.trim()],
    )?;
    Ok(())
}

pub fn set_color(conn: &Connection, id: i64, color: &str) -> Result<()> {
    conn.execute(
        "UPDATE collections SET color = ?2 WHERE id = ?1",
        params![id, color],
    )?;
    Ok(())
}

pub fn move_to(conn: &Connection, id: i64, folder_id: Option<i64>, position: i64) -> Result<()> {
    conn.execute(
        "UPDATE collections SET folder_id = ?2, position = ?3 WHERE id = ?1",
        params![id, folder_id, position],
    )?;
    Ok(())
}

pub fn duplicate(conn: &Connection, id: i64) -> Result<Collection> {
    let src = get(conn, id)?;
    let position = next_position(conn, src.folder_id)?;

    conn.execute(
        "INSERT INTO collections (name, color, icon, folder_id, position, is_smart, filter, created_at)
         SELECT name || ' — копия', color, icon, folder_id, ?2, is_smart, filter, ?3
         FROM collections WHERE id = ?1",
        params![id, position, now_iso()],
    )?;
    let new_id = conn.last_insert_rowid();

    conn.execute(
        "INSERT INTO collection_beatmaps (collection_id, beatmap_id, position)
         SELECT ?2, beatmap_id, position FROM collection_beatmaps WHERE collection_id = ?1",
        params![id, new_id],
    )?;

    get(conn, new_id)
}

pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    // Связи уходят каскадом, сами карты остаются в библиотеке.
    conn.execute("DELETE FROM collections WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn add_beatmaps(conn: &Connection, collection_id: i64, ids: &[i64]) -> Result<()> {
    let start: i64 = conn
        .query_row(
            "SELECT MAX(position) FROM collection_beatmaps WHERE collection_id = ?1",
            params![collection_id],
            |r| r.get::<_, Option<i64>>(0),
        )?
        .unwrap_or(0);

    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO collection_beatmaps (collection_id, beatmap_id, position)
         VALUES (?1, ?2, ?3)",
    )?;
    for (i, id) in ids.iter().enumerate() {
        stmt.execute(params![collection_id, id, start + 1 + i as i64])?;
    }
    Ok(())
}

pub fn remove_beatmaps(conn: &Connection, collection_id: i64, ids: &[i64]) -> Result<()> {
    for chunk in ids.chunks(CHUNK) {
        let sql = format!(
            "DELETE FROM collection_beatmaps WHERE collection_id = ? AND beatmap_id IN ({})",
            placeholders(chunk.len())
        );
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(collection_id)];
        for id in chunk {
            args.push(Box::new(*id));
        }
        conn.execute(&sql, params_from_iter(args.iter()))?;
    }
    Ok(())
}

// ──────────────────────────────────────────────────────────────── папки

pub fn list_folders(conn: &Connection) -> Result<Vec<Folder>> {
    let mut stmt =
        conn.prepare("SELECT id, name, position FROM folders ORDER BY position ASC, id ASC")?;
    let rows = stmt.query_map([], |r| {
        Ok(Folder {
            id: r.get(0)?,
            name: r.get(1)?,
            position: r.get(2)?,
        })
    })?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn create_folder(conn: &Connection, name: &str) -> Result<Folder> {
    let max: Option<i64> = conn.query_row("SELECT MAX(position) FROM folders", [], |r| r.get(0))?;
    let position = max.unwrap_or(0) + 1;

    conn.execute(
        "INSERT INTO folders (name, position) VALUES (?1, ?2)",
        params![name.trim(), position],
    )?;

    Ok(Folder {
        id: conn.last_insert_rowid(),
        name: name.trim().to_string(),
        position,
    })
}

pub fn rename_folder(conn: &Connection, id: i64, name: &str) -> Result<()> {
    conn.execute(
        "UPDATE folders SET name = ?2 WHERE id = ?1",
        params![id, name.trim()],
    )?;
    Ok(())
}

/// Папка удаляется, коллекции из неё поднимаются на верхний уровень —
/// это делает внешний ключ ON DELETE SET NULL.
pub fn delete_folder(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM folders WHERE id = ?1", params![id])?;
    Ok(())
}
