//! Исключения: чего не берём.
//!
//! Раньше это было размазано — одно поле в правилах шаблона на «не брать из
//! этих маппулов», галочка на «не повторять маппера», а «не брать ничего из
//! прошлого турнира» вообще нельзя было выразить. Теперь всё «нельзя» в одном
//! списке, у каждого пункта своя строгость и видно, сколько карт он отсекает.
//!
//! Исключения складываются по уровням: серия → пул. Исключение серии
//! применяется ко всем её пулам и на уровне пула не отключается — только
//! выключается у самой серии.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{AppError, Result};
use crate::model::{Exclusion, ExclusionTarget};

/// Кому принадлежит исключение.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    Series(i64),
    Pool(i64),
    Template(i64),
}

impl Owner {
    fn kind(&self) -> &'static str {
        match self {
            Owner::Series(_) => "series",
            Owner::Pool(_) => "pool",
            Owner::Template(_) => "template",
        }
    }

    fn id(&self) -> i64 {
        match self {
            Owner::Series(id) | Owner::Pool(id) | Owner::Template(id) => *id,
        }
    }

    pub fn parse(kind: &str, id: i64) -> Result<Owner> {
        match kind {
            "series" => Ok(Owner::Series(id)),
            "pool" => Ok(Owner::Pool(id)),
            "template" => Ok(Owner::Template(id)),
            other => Err(AppError::Other(format!(
                "Неизвестный владелец исключения: {other}"
            ))),
        }
    }
}

/// Исключение как оно лежит в базе, без подписей и счётчиков.
#[derive(Debug, Clone)]
pub struct Raw {
    pub id: i64,
    pub target: ExclusionTarget,
    pub strict: bool,
    pub enabled: bool,
}

fn row_to_raw(row: &rusqlite::Row) -> rusqlite::Result<Option<Raw>> {
    let json: String = row.get("target")?;
    // Цель, которую не удалось разобрать, — это исключение из будущей версии
    // или испорченная строка. Молча применять её нельзя, поэтому пропускаем.
    let Ok(target) = serde_json::from_str::<ExclusionTarget>(&json) else {
        return Ok(None);
    };
    Ok(Some(Raw {
        id: row.get("id")?,
        target,
        strict: row.get::<_, i64>("strict")? != 0,
        enabled: row.get::<_, i64>("enabled")? != 0,
    }))
}

pub fn raw_list(conn: &Connection, owner: Owner) -> Result<Vec<Raw>> {
    let mut stmt = conn.prepare(
        "SELECT id, target, strict, enabled FROM exclusions
         WHERE owner_kind = ?1 AND owner_id = ?2 ORDER BY position ASC, id ASC",
    )?;
    let rows = stmt.query_map(params![owner.kind(), owner.id()], row_to_raw)?;

    let mut out = Vec::new();
    for row in rows {
        if let Some(raw) = row? {
            out.push(raw);
        }
    }
    Ok(out)
}

// ─────────────────────────────────────────────────────────────── запись

pub fn add(conn: &Connection, owner: Owner, target: &ExclusionTarget, strict: bool) -> Result<i64> {
    let next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM exclusions
         WHERE owner_kind = ?1 AND owner_id = ?2",
        params![owner.kind(), owner.id()],
        |r| r.get(0),
    )?;

    conn.execute(
        "INSERT INTO exclusions (owner_kind, owner_id, target, strict, enabled, position)
         VALUES (?1, ?2, ?3, ?4, 1, ?5)",
        params![
            owner.kind(),
            owner.id(),
            serde_json::to_string(target)?,
            strict as i64,
            next
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn remove(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM exclusions WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn set_strict(conn: &Connection, id: i64, strict: bool) -> Result<()> {
    conn.execute(
        "UPDATE exclusions SET strict = ?2 WHERE id = ?1",
        params![id, strict as i64],
    )?;
    Ok(())
}

pub fn set_enabled(conn: &Connection, id: i64, enabled: bool) -> Result<()> {
    conn.execute(
        "UPDATE exclusions SET enabled = ?2 WHERE id = ?1",
        params![id, enabled as i64],
    )?;
    Ok(())
}

/// Копия исключений одного владельца другому — при дублировании пула и серии.
pub fn copy(conn: &Connection, from: Owner, to: Owner) -> Result<()> {
    conn.execute(
        "INSERT INTO exclusions (owner_kind, owner_id, target, strict, enabled, position)
         SELECT ?3, ?4, target, strict, enabled, position
         FROM exclusions WHERE owner_kind = ?1 AND owner_id = ?2",
        params![from.kind(), from.id(), to.kind(), to.id()],
    )?;
    Ok(())
}

pub fn delete_all(conn: &Connection, owner: Owner) -> Result<()> {
    conn.execute(
        "DELETE FROM exclusions WHERE owner_kind = ?1 AND owner_id = ?2",
        params![owner.kind(), owner.id()],
    )?;
    Ok(())
}

/// Исключения, ссылавшиеся на старый пул, начинают ссылаться на новый.
///
/// Новая версия занимает место прежней, и правило «не брать из раунда 1»
/// должно про неё знать: иначе после правки пула оно тихо перестало бы
/// работать, продолжая висеть в списке.
pub fn repoint_pool(conn: &Connection, from: i64, to: i64) -> Result<()> {
    conn.execute(
        "UPDATE exclusions
            SET target = json_set(target, '$.id', ?2)
          WHERE json_extract(target, '$.kind') = 'pool'
            AND json_extract(target, '$.id') = ?1",
        params![from, to],
    )?;
    Ok(())
}

// ────────────────────────────────────────────── цель → множество карт

/// Карты, которые исключение запрещает. `None` — исключение не про
/// конкретные карты, а про состав пула (`sameMapperInside`).
///
/// Второе значение — пропала ли цель: удалённый маппул не должен молча
/// превращать строгое правило в пустое.
pub fn resolve(conn: &Connection, target: &ExclusionTarget) -> Result<(Option<Vec<i64>>, bool)> {
    match target {
        ExclusionTarget::SameMapperInside => Ok((None, false)),

        ExclusionTarget::Pool { id } => {
            if !exists(conn, "pools", *id)? {
                return Ok((Some(Vec::new()), true));
            }
            Ok((Some(super::pools::beatmaps_in_pools(conn, &[*id])?), false))
        }

        ExclusionTarget::Series { id } => {
            if !exists(conn, "series", *id)? {
                return Ok((Some(Vec::new()), true));
            }
            let pools = super::series::pool_ids(conn, *id)?;
            Ok((Some(super::pools::beatmaps_in_pools(conn, &pools)?), false))
        }

        ExclusionTarget::Tournament { id } => {
            if !exists(conn, "tournaments", *id)? {
                return Ok((Some(Vec::new()), true));
            }
            Ok((Some(tournament_maps(conn, &[*id])?), false))
        }

        ExclusionTarget::RecentTournaments { count } => {
            let ids = recent_tournaments(conn, (*count).max(1))?;
            Ok((Some(tournament_maps(conn, &ids)?), false))
        }

        ExclusionTarget::PlayedBy { player_id } => {
            if !exists(conn, "players", *player_id)? {
                return Ok((Some(Vec::new()), true));
            }
            Ok((Some(played_by(conn, *player_id)?), false))
        }

        ExclusionTarget::Mapper { name } => Ok((Some(by_mapper(conn, name)?), false)),

        ExclusionTarget::Beatmaps { ids } => Ok((Some(ids.clone()), false)),
    }
}

fn exists(conn: &Connection, table: &str, id: i64) -> Result<bool> {
    // Имя таблицы подставляется из перечисления выше, а не из запроса фронта.
    let sql = format!("SELECT 1 FROM {table} WHERE id = ?1");
    Ok(conn
        .query_row(&sql, params![id], |r| r.get::<_, i64>(0))
        .optional()?
        .is_some())
}

/// Карты из маппулов, привязанных к турнирам. «Играли в этом турнире» — это
/// весь его маппул: карта лежала на столе, и брать её снова не стоит даже
/// если до неё не дошла очередь.
fn tournament_maps(conn: &Connection, tournament_ids: &[i64]) -> Result<Vec<i64>> {
    if tournament_ids.is_empty() {
        return Ok(Vec::new());
    }
    let holes = super::placeholders(tournament_ids.len());
    let sql = format!(
        "SELECT DISTINCT s.beatmap_id
           FROM pool_slots s
          WHERE s.beatmap_id IS NOT NULL
            AND (s.pool_id IN (SELECT pool_id FROM tournament_pools WHERE tournament_id IN ({holes}))
              OR s.pool_id IN (SELECT pool_id FROM matches
                                WHERE pool_id IS NOT NULL AND tournament_id IN ({holes})))"
    );

    let mut args: Vec<i64> = tournament_ids.to_vec();
    args.extend_from_slice(tournament_ids);

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| r.get::<_, i64>(0))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Последние N турниров: сначала завершённые по дате финиша, потом идущие.
fn recent_tournaments(conn: &Connection, count: i64) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM tournaments
         ORDER BY COALESCE(finished_at, created_at) DESC, id DESC
         LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![count], |r| r.get::<_, i64>(0))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Карты, которые игрок действительно играл: пикнутые и сыгранные строки
/// его матчей. Именно журнал, а не маппул: банённую карту он не играл.
fn played_by(conn: &Connection, player_id: i64) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT s.beatmap_id
           FROM match_actions a
           JOIN matches m ON m.id = a.match_id
           JOIN pool_slots s ON s.pool_id = m.pool_id AND s.slot_label = a.slot_label
          WHERE a.type IN ('pick', 'result')
            AND s.beatmap_id IS NOT NULL
            AND (m.player_a = ?1 OR m.player_b = ?1)",
    )?;
    let rows = stmt.query_map(params![player_id], |r| r.get::<_, i64>(0))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn by_mapper(conn: &Connection, name: &str) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT beatmap_id FROM beatmaps WHERE creator IS NOT NULL AND creator = ?1 COLLATE NOCASE",
    )?;
    let rows = stmt.query_map(params![name.trim()], |r| r.get::<_, i64>(0))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

// ──────────────────────────────────────────────────────────── подписи

/// Читаемое имя цели. Без него список исключений — набор чисел.
pub fn label(conn: &Connection, target: &ExclusionTarget) -> Result<String> {
    Ok(match target {
        ExclusionTarget::SameMapperInside => "Два пула одного маппера".to_string(),

        ExclusionTarget::Pool { id } => match pool_title(conn, *id)? {
            Some(name) => name,
            None => format!("Маппул {id} удалён"),
        },

        ExclusionTarget::Series { id } => match name_of(conn, "series", *id)? {
            Some(name) => format!("Серия «{name}»"),
            None => format!("Серия {id} удалена"),
        },

        ExclusionTarget::Tournament { id } => match name_of(conn, "tournaments", *id)? {
            Some(name) => format!("Турнир «{name}»"),
            None => format!("Турнир {id} удалён"),
        },

        ExclusionTarget::RecentTournaments { count } => {
            format!("Последние {count} {}", tournaments_word(*count))
        }

        ExclusionTarget::PlayedBy { player_id } => match nickname(conn, *player_id)? {
            Some(nick) => format!("Что играл {nick}"),
            None => format!("Игрок {player_id} удалён"),
        },

        ExclusionTarget::Mapper { name } => format!("Маппер {name}"),

        ExclusionTarget::Beatmaps { ids } => {
            format!("Отобранные карты: {}", ids.len())
        }
    })
}

fn tournaments_word(n: i64) -> &'static str {
    let tail = (n % 100).abs();
    let last = tail % 10;
    if (11..=19).contains(&tail) {
        "турниров"
    } else if (2..=4).contains(&last) {
        "турнира"
    } else if last == 1 {
        "турнир"
    } else {
        "турниров"
    }
}

/// Название маппула вместе с меткой раунда и версией: в списке исключений
/// «Осень — раунд 1 (v2)» читается, а «Маппул 14» — нет.
fn pool_title(conn: &Connection, id: i64) -> Result<Option<String>> {
    let found: Option<(String, Option<String>, i64)> = conn
        .query_row(
            "SELECT name, series_label, version FROM pools WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;

    Ok(found.map(|(name, label, version)| {
        let mut out = name;
        if let Some(label) = label.filter(|l| !l.trim().is_empty()) {
            out = format!("{out} — {label}");
        }
        if version > 1 {
            out = format!("{out} (v{version})");
        }
        out
    }))
}

fn name_of(conn: &Connection, table: &str, id: i64) -> Result<Option<String>> {
    let sql = format!("SELECT name FROM {table} WHERE id = ?1");
    Ok(conn
        .query_row(&sql, params![id], |r| r.get::<_, String>(0))
        .optional()?)
}

fn nickname(conn: &Connection, id: i64) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT nickname FROM players WHERE id = ?1",
            params![id],
            |r| r.get::<_, String>(0),
        )
        .optional()?)
}

// ─────────────────────────────────────────────── собранные исключения

/// Исключение, готовое к применению: со множеством карт и подписью.
pub struct Ready {
    pub raw: Raw,
    pub label: String,
    pub inherited_from: Option<String>,
    pub missing: bool,
    /// `None` — про состав пула, а не про конкретные карты.
    pub ids: Option<HashSet<i64>>,
}

impl Ready {
    /// Применяется ли прямо сейчас: выключенное и с пропавшей целью — нет.
    pub fn live(&self) -> bool {
        self.raw.enabled && !self.missing
    }
}

/// Все исключения уровней, снизу вверх, с разрешёнными множествами карт.
/// `levels` — владелец и подпись «откуда»: `None` для своих.
pub fn ready(conn: &Connection, levels: &[(Owner, Option<String>)]) -> Result<Vec<Ready>> {
    let mut out = Vec::new();
    for (owner, from) in levels {
        for raw in raw_list(conn, *owner)? {
            let label = label(conn, &raw.target)?;
            let (ids, missing) = resolve(conn, &raw.target)?;
            out.push(Ready {
                raw,
                label,
                inherited_from: from.clone(),
                missing,
                ids: ids.map(|v| v.into_iter().collect()),
            });
        }
    }
    Ok(out)
}

/// То же для панели: с числом отсечённых карт от общего набора кандидатов.
///
/// Считаем от набора всего пула, а не по слоту: в панели одна строка на
/// исключение, и число в ней должно отвечать на «сколько ты у меня забрал».
pub fn to_model(ready: &[Ready], candidates: &HashSet<i64>) -> Vec<Exclusion> {
    ready
        .iter()
        .map(|r| Exclusion {
            id: r.raw.id,
            target: r.raw.target.clone(),
            strict: r.raw.strict,
            enabled: r.raw.enabled,
            label: r.label.clone(),
            inherited_from: r.inherited_from.clone(),
            missing: r.missing,
            cut: match &r.ids {
                Some(ids) => candidates.iter().filter(|id| ids.contains(id)).count() as i64,
                // Про состав пула: сколько отсечёт, заранее не известно —
                // зависит от того, кто уже встал в слоты.
                None => 0,
            },
        })
        .collect()
}
