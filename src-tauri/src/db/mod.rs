//! Слой SQLite. Одно соединение под мьютексом — приложение однопользовательское,
//! конкуренции за запись нет, а WAL и busy_timeout закрывают редкие пересечения.

pub mod air;
pub mod beatmaps;
pub mod bracket;
pub mod collections;
pub mod downloads;
pub mod exclusions;
pub mod feasible;
pub mod generate;
pub mod history;
pub mod labels;
pub mod matches;
pub mod players;
pub mod pools;
pub mod prize;
pub mod series;
pub mod sources;
pub mod supply;
pub mod templates;
pub mod tournaments;

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, Transaction};

use crate::error::{AppError, Result};

/// Полная схема первой версии. Все выражения идемпотентны (IF NOT EXISTS),
/// поэтому повторное применение безопасно.
const SCHEMA_V1: &str = include_str!("schema.sql");

/// Шаблоны из коробки. Отдельной версией, а не частью схемы: у того, кто уже
/// запускал приложение, схема применена, а шаблонов ещё нет.
const BUILTIN_TEMPLATES: &str = include_str!("migrations/002_builtin_templates.sql");

/// Серии, источники и исключения. Здесь есть ALTER TABLE, поэтому, в отличие
/// от схемы, выражение не идемпотентно: применяется ровно один раз по версии.
const SERIES: &str = include_str!("migrations/003_series_sources_exclusions.sql");

/// Редактор турниров: привязка маппулов к раундам, преимущество сетки,
/// замороженное правило матча и журнал правок.
const EDITOR: &str = include_str!("migrations/004_tournament_editor.sql");

/// Эфир: настройки, счётчик показов сцен и ссылка на лобби матча.
const AIR: &str = include_str!("migrations/005_air.sql");

/// Призовой фонд: конфиг в турнире, флаг новичка и значения приложения.
const PRIZE: &str = include_str!("migrations/006_prize.sql");

/// Загрузки: очередь пачек, память модов удалённых карт, кеш профилей osu!.
const DOWNLOADS: &str = include_str!("migrations/007_downloads.sql");

/// Библиотека 2.0: вложенные папки коллекций. Список карт всегда агрегируется
/// по наборам — переключателя больше нет, миграция для этого не нужна.
const LIBRARY: &str = include_str!("migrations/008_library_folders.sql");

/// Серия ↔ турнир: жёсткая привязка одной серии к одному турниру.
const SERIES_TOURNAMENT: &str = include_str!("migrations/009_series_tournament.sql");

/// Миграции по возрастанию версии. Чтобы добавить версию 6, допиши пару
/// `(6, include_str!("migrations/006_...sql"))` — цикл применит её сам.
const MIGRATIONS: &[(i64, &str)] = &[
    (1, SCHEMA_V1),
    (2, BUILTIN_TEMPLATES),
    (3, SERIES),
    (4, EDITOR),
    (5, AIR),
    (6, PRIZE),
    (7, DOWNLOADS),
    (8, LIBRARY),
    (9, SERIES_TOURNAMENT),
];

/// Версия схемы, которую ожидает текущий код.
const TARGET_VERSION: i64 = 9;

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// Открывает (и при необходимости создаёт) базу, настраивает прагмы
    /// и доводит схему до целевой версии.
    pub fn open(path: impl AsRef<Path>) -> Result<Db> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }

        let conn = Connection::open(path)?;

        // journal_mode возвращает строку, поэтому только через execute_batch/query_row.
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        conn.busy_timeout(std::time::Duration::from_millis(5000))?;

        let db = Db {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    /// Читает user_version и применяет все миграции, версия которых выше текущей.
    pub fn migrate(&self) -> Result<()> {
        let conn = self.lock()?;

        let mut version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;

        for (target, sql) in MIGRATIONS {
            if *target <= version {
                continue;
            }
            // Без явной транзакции: внутри схемы есть PRAGMA journal_mode,
            // которую SQLite не отдаёт менять в открытой транзакции.
            conn.execute_batch(sql)?;
            conn.execute_batch(&format!("PRAGMA user_version = {target};"))?;
            version = *target;
        }

        if version < TARGET_VERSION {
            return Err(AppError::Db(format!(
                "База осталась на версии {version}, а нужна {TARGET_VERSION}"
            )));
        }
        Ok(())
    }

    /// Доступ к соединению для чтения и одиночных записей.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.lock()?;
        f(&conn)
    }

    /// Транзакция: закрывается коммитом, при ошибке замыкания — откатом.
    pub fn with_tx<T>(&self, f: impl FnOnce(&Transaction) -> Result<T>) -> Result<T> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    /// Заменяет соединение на новое — файл под ним могли подменить при
    /// импорте базы. Мьютекс уже даёт изменчивость из-под `&self`, старое
    /// соединение закрывается тем же присваиванием.
    pub fn reopen(&self, path: impl AsRef<Path>) -> Result<()> {
        let fresh = Db::open(path)?;
        let mut guard = self.lock()?;
        *guard = fresh
            .conn
            .into_inner()
            .map_err(|_| AppError::Db("Соединение с базой повреждено после сбоя".into()))?;
        Ok(())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| AppError::Db("Соединение с базой повреждено после сбоя".into()))
    }
}

/// Текущее время в RFC3339 (UTC) — единый формат для всех колонок с датами.
pub fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

// ──────────────────────────────────────────────────────── общие мелочи

/// Строка вида `?,?,?` под нужное число биндингов.
pub(crate) fn placeholders(n: usize) -> String {
    let mut s = String::with_capacity(n * 2);
    for i in 0..n {
        if i > 0 {
            s.push(',');
        }
        s.push('?');
    }
    s
}

/// Предел переменных в запросе SQLite — 999. Режем пачки с запасом.
pub(crate) const CHUNK: usize = 500;

#[cfg(test)]
mod tests;
