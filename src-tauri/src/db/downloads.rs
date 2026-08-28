//! Очередь загрузок: пачки ссылок со своими настройками тегов.
//!
//! Пачки лежат в базе, поэтому очередь переживает перезапуск приложения.
//! Сама обработка — в [`crate::import`], здесь только хранение.

use rusqlite::{params, Connection, OptionalExtension};

use super::now_iso;
use crate::error::Result;
use crate::model::{ImportBatch, ImportFailure};

fn row_to_batch(row: &rusqlite::Row) -> rusqlite::Result<ImportBatch> {
    let mods: String = row.get("mods")?;
    let failed: String = row.get("failed")?;
    let beatmap_ids: String = row.get("beatmap_ids")?;
    let beatmapset_ids: String = row.get("beatmapset_ids")?;
    Ok(ImportBatch {
        batch_id: row.get("batch_id")?,
        name: row.get("name")?,
        mods: serde_json::from_str(&mods).unwrap_or_default(),
        status: row.get("status")?,
        stage: row.get("stage")?,
        beatmap_ids: serde_json::from_str(&beatmap_ids).unwrap_or_default(),
        beatmapset_ids: serde_json::from_str(&beatmapset_ids).unwrap_or_default(),
        total: row.get("total")?,
        done: row.get("done")?,
        added: row.get("added")?,
        skipped: row.get("skipped")?,
        failed: serde_json::from_str(&failed).unwrap_or_default(),
        created_at: row.get("created_at")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
    })
}

const COLS: &str = "batch_id, name, mods, status, stage, beatmap_ids, beatmapset_ids, \
                    total, done, added, skipped, failed, created_at, started_at, finished_at";

/// Новая пачка в конце очереди. Возвращает запись, как её видит фронт.
pub fn insert(
    conn: &Connection,
    batch_id: &str,
    name: &str,
    mods: &[String],
    beatmap_ids: &[i64],
    beatmapset_ids: &[i64],
) -> Result<ImportBatch> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO import_batches (
            batch_id, name, mods, status, stage, beatmap_ids, beatmapset_ids,
            total, created_at
         ) VALUES (?1, ?2, ?3, 'queued', 'queued', ?4, ?5, ?6, ?7)",
        params![
            batch_id,
            name,
            serde_json::to_string(mods)?,
            serde_json::to_string(beatmap_ids)?,
            serde_json::to_string(beatmapset_ids)?,
            (beatmap_ids.len() + beatmapset_ids.len()) as i64,
            now,
        ],
    )?;
    Ok(get(conn, batch_id)?.expect("пачка только что создана"))
}

pub fn get(conn: &Connection, batch_id: &str) -> Result<Option<ImportBatch>> {
    let sql = format!("SELECT {COLS} FROM import_batches WHERE batch_id = ?1");
    let found = conn
        .query_row(&sql, params![batch_id], row_to_batch)
        .optional()?;
    Ok(found)
}

/// Вся очередь, свежие сверху. Активная и ждущие пачки — первыми.
pub fn list(conn: &Connection) -> Result<Vec<ImportBatch>> {
    let sql = format!(
        "SELECT {COLS} FROM import_batches
          ORDER BY CASE status
                     WHEN 'running' THEN 0
                     WHEN 'queued'  THEN 1
                     ELSE 2
                   END, created_at DESC, rowid DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_batch)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Самая старая пачка в очереди — следующая на обработку.
pub fn next_queued(conn: &Connection) -> Result<Option<ImportBatch>> {
    let sql = format!(
        "SELECT {COLS} FROM import_batches
          WHERE status = 'queued'
          ORDER BY created_at ASC, rowid ASC
          LIMIT 1"
    );
    let found = conn.query_row(&sql, [], row_to_batch).optional()?;
    Ok(found)
}

/// Живая правка прогресса: стадия и счётчики, без смены статуса.
pub fn save_progress(
    conn: &Connection,
    batch_id: &str,
    stage: &str,
    done: i64,
    total: i64,
    added: i64,
    skipped: i64,
    failed: &[ImportFailure],
) -> Result<()> {
    conn.execute(
        "UPDATE import_batches
            SET stage = ?2, done = ?3, total = ?4, added = ?5, skipped = ?6, failed = ?7
          WHERE batch_id = ?1",
        params![
            batch_id,
            stage,
            done,
            total,
            added,
            skipped,
            serde_json::to_string(failed)?
        ],
    )?;
    Ok(())
}

/// Смена статуса. Взятие в работу проставляет `started_at`, конец — `finished_at`.
pub fn set_status(conn: &Connection, batch_id: &str, status: &str, stage: &str) -> Result<()> {
    let now = now_iso();
    let started = if status == "running" {
        Some(now.clone())
    } else {
        None
    };
    let finished = matches!(status, "done" | "failed" | "cancelled").then_some(now);
    conn.execute(
        "UPDATE import_batches
            SET status = ?2, stage = ?3,
                started_at = COALESCE(?4, started_at),
                finished_at = COALESCE(?5, finished_at)
          WHERE batch_id = ?1",
        params![batch_id, status, stage, started, finished],
    )?;
    Ok(())
}

/// Повтор пачки: она снова встаёт в очередь с нуля, ошибки стираются.
/// Готовые карты при повторной загрузке обновятся, а не задвоятся.
pub fn reset(conn: &Connection, batch_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE import_batches
            SET status = 'queued', stage = 'queued', done = 0, added = 0, skipped = 0,
                failed = '[]', started_at = NULL, finished_at = NULL
          WHERE batch_id = ?1",
        params![batch_id],
    )?;
    Ok(())
}

pub fn remove(conn: &Connection, batch_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM import_batches WHERE batch_id = ?1",
        params![batch_id],
    )?;
    Ok(())
}

/// Уборка: стереть всё, что уже не качается и не ждёт.
pub fn clear_finished(conn: &Connection) -> Result<()> {
    conn.execute(
        "DELETE FROM import_batches
          WHERE status IN ('done', 'failed', 'cancelled')",
        [],
    )?;
    Ok(())
}

/// Пачки, застрявшие в `running` после падения приложения: при старте их
/// надо вернуть в очередь, иначе очередь встанет навсегда.
pub fn revive_stuck(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE import_batches
            SET status = 'queued', stage = 'queued'
          WHERE status = 'running'",
        [],
    )?;
    Ok(())
}
