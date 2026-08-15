//! Источники карт: откуда генерация их берёт.
//!
//! Источник задаётся на четырёх уровнях, и каждый следующий уточняет
//! предыдущий: слот → пул → серия → шаблон. Уровень без своих источников
//! наследует верхний, а если своих нет ни у кого — берётся вся библиотека.
//! Так «в основном мои проверенные, добор из библиотеки» настраивается один
//! раз на серию, а не по слоту двенадцать раз.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::Result;
use crate::model::{EffectiveSources, LibraryFilter, Source, SourceInfo, SourceSet};

/// Разбор JSON-колонки с источниками. Испорченный JSON — это «своих нет»,
/// а не потеря пула: наследование сработает уровнем выше.
pub fn parse(raw: Option<String>) -> Option<SourceSet> {
    let set: SourceSet = serde_json::from_str(&raw?).ok()?;
    if set.is_empty() {
        None
    } else {
        Some(set)
    }
}

pub fn dump(set: Option<&SourceSet>) -> Result<Option<String>> {
    match set {
        Some(s) if !s.is_empty() => Ok(Some(serde_json::to_string(s)?)),
        _ => Ok(None),
    }
}

/// Набор источников по умолчанию — вся библиотека.
pub fn whole_library() -> SourceSet {
    SourceSet {
        items: vec![Source::Library],
        mode: "union".into(),
    }
}

// ───────────────────────────────────────────────────── состав источника

/// Карты одного источника под наложенным фильтром слота.
///
/// Фильтр слота (мод, звёзды, скилсеты, строгие правила) применяется здесь же,
/// а не после: у умной коллекции состав — это тоже фильтр, и склеить их в
/// один запрос дешевле, чем считать пересечение множеств в памяти.
fn ids_of(conn: &Connection, source: &Source, base: &LibraryFilter) -> Result<Vec<i64>> {
    match source {
        Source::Library => super::beatmaps::ids_for(conn, base),
        Source::Collection { id } => {
            let mut f = base.clone();
            f.collection_id = Some(*id);
            super::beatmaps::ids_for(conn, &f)
        }
        Source::Filter { filter } => {
            // Условия источника и слота могут не пересекаться вовсе — например,
            // источник только про HD, а слот про DT. Тогда источник под этот
            // слот карт не даёт, и запрос не нужен.
            let Some(mut f) = merge(filter, base) else {
                return Ok(Vec::new());
            };
            // Источник-фильтр мог быть сохранён вместе с коллекцией: она —
            // часть условий, а не место, где мы сейчас стоим.
            if f.collection_id.is_none() {
                f.collection_id = filter.collection_id;
            }
            super::beatmaps::ids_for(conn, &f)
        }
    }
}

/// Условия источника и условия слота вместе: пересечение, а не замена.
/// Диапазоны сужаются до общей части, списки складываются. `None` —
/// пересечения нет, брать нечего.
fn merge(source: &LibraryFilter, slot: &LibraryFilter) -> Option<LibraryFilter> {
    let mut out = slot.clone();

    out.stars = tighten(&source.stars, &slot.stars);
    out.bpm = tighten(&source.bpm, &slot.bpm);
    out.length = tighten(&source.length, &slot.length);

    // Мод-теги: если источник ограничивает моды, слот выбирает из них.
    if !source.mods.is_empty() {
        out.mods = if slot.mods.is_empty() {
            source.mods.clone()
        } else {
            slot.mods
                .iter()
                .filter(|m| source.mods.contains(m))
                .cloned()
                .collect()
        };
        if out.mods.is_empty() {
            return None;
        }
    }

    for sk in &source.skillsets {
        if !out.skillsets.contains(sk) {
            out.skillsets.push(sk.clone());
        }
    }
    for id in &source.label_ids {
        if !out.label_ids.contains(id) {
            out.label_ids.push(*id);
        }
    }
    if out.statuses.is_empty() {
        out.statuses = source.statuses.clone();
    }
    if out.query.trim().is_empty() {
        out.query = source.query.clone();
    }
    out.no_mods = out.no_mods || source.no_mods;
    Some(out)
}

fn tighten(a: &crate::model::Range, b: &crate::model::Range) -> crate::model::Range {
    crate::model::Range {
        min: match (a.min, b.min) {
            (Some(x), Some(y)) => Some(x.max(y)),
            (x, y) => x.or(y),
        },
        max: match (a.max, b.max) {
            (Some(x), Some(y)) => Some(x.min(y)),
            (x, y) => x.or(y),
        },
    }
}

/// Кандидаты по набору источников, разложенные по приоритету.
///
/// `union` — один уровень со всем сразу. `ordered` — по уровню на источник:
/// подбор берёт из первого, и только если там не нашлось, идёт во второй.
/// Дубли между уровнями убираются: карта, попавшая в первый, во втором не нужна.
pub fn tiers(conn: &Connection, set: &SourceSet, base: &LibraryFilter) -> Result<Vec<Vec<i64>>> {
    if set.is_empty() {
        return Ok(vec![super::beatmaps::ids_for(conn, base)?]);
    }

    if !set.ordered() {
        let mut seen = HashSet::new();
        let mut all = Vec::new();
        for source in &set.items {
            for id in ids_of(conn, source, base)? {
                if seen.insert(id) {
                    all.push(id);
                }
            }
        }
        return Ok(vec![all]);
    }

    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(set.items.len());
    for source in &set.items {
        let mut level = Vec::new();
        for id in ids_of(conn, source, base)? {
            if seen.insert(id) {
                level.push(id);
            }
        }
        out.push(level);
    }
    Ok(out)
}

/// Все карты набора одним множеством — там, где приоритет не важен.
pub fn ids(conn: &Connection, set: &SourceSet, base: &LibraryFilter) -> Result<Vec<i64>> {
    Ok(tiers(conn, set, base)?.into_iter().flatten().collect())
}

// ────────────────────────────────────────────────────── описание для панели

fn collection_name(conn: &Connection, id: i64) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT name FROM collections WHERE id = ?1",
            params![id],
            |r| r.get::<_, String>(0),
        )
        .optional()?)
}

/// Источники с названиями и числом карт — то, что показывает панель.
pub fn describe(conn: &Connection, set: &SourceSet) -> Result<Vec<SourceInfo>> {
    let base = LibraryFilter::default();
    let mut out = Vec::with_capacity(set.items.len());

    for source in &set.items {
        let (name, missing) = match source {
            Source::Library => ("вся библиотека".to_string(), false),
            Source::Collection { id } => match collection_name(conn, *id)? {
                Some(name) => (name, false),
                None => (format!("коллекция {id} удалена"), true),
            },
            Source::Filter { filter } => (describe_filter(filter), false),
        };

        let count = if missing {
            0
        } else {
            ids_of(conn, source, &base)?.len() as i64
        };

        out.push(SourceInfo {
            source: source.clone(),
            name,
            count,
            missing,
        });
    }
    Ok(out)
}

/// Условия фильтра-источника одной строкой. Тем же языком, что подсказки
/// фильтра в библиотеке, — иначе одно и то же читалось бы по-разному.
pub fn describe_filter(f: &LibraryFilter) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !f.mods.is_empty() {
        parts.push(f.mods.join(", "));
    }
    if let Some(s) = range_text(&f.stars, 1, "★") {
        parts.push(s);
    }
    if let Some(s) = range_text(&f.bpm, 0, " BPM") {
        parts.push(s);
    }
    if !f.skillsets.is_empty() {
        parts.push(f.skillsets.join(", "));
    }
    if !f.statuses.is_empty() {
        parts.push(f.statuses.join(", "));
    }
    if !f.query.trim().is_empty() {
        parts.push(format!("«{}»", f.query.trim()));
    }
    if parts.is_empty() {
        "фильтр без условий".to_string()
    } else {
        format!("фильтр: {}", parts.join(" · "))
    }
}

fn range_text(r: &crate::model::Range, digits: usize, unit: &str) -> Option<String> {
    let fmt = |n: f64| format!("{n:.digits$}");
    match (r.min, r.max) {
        (None, None) => None,
        (Some(a), Some(b)) => Some(format!("{}–{}{unit}", fmt(a), fmt(b))),
        (Some(a), None) => Some(format!("от {}{unit}", fmt(a))),
        (None, Some(b)) => Some(format!("до {}{unit}", fmt(b))),
    }
}

/// Какой набор источников на самом деле применяется и откуда он взялся.
///
/// Уровни идут снизу вверх: чей набор нашёлся первым, тот и работает.
/// `labels` — как называть уровень в подписи: «свои», «от серии — Осень 2026».
pub fn effective(
    conn: &Connection,
    levels: &[(Option<SourceSet>, &str)],
) -> Result<EffectiveSources> {
    let mut own = true;
    for (set, origin) in levels {
        let Some(set) = set else {
            own = false;
            continue;
        };
        let items = describe(conn, set)?;
        let total = ids(conn, set, &LibraryFilter::default())?.len() as i64;
        return Ok(EffectiveSources {
            set: set.clone(),
            items,
            origin: (*origin).to_string(),
            own,
            total,
        });
    }

    // Источников нет вовсе — берётся вся библиотека, и это видно подписью.
    let set = whole_library();
    let total = super::beatmaps::ids_for(conn, &LibraryFilter::default())?.len() as i64;
    Ok(EffectiveSources {
        items: vec![SourceInfo {
            source: Source::Library,
            name: "вся библиотека".into(),
            count: total,
            missing: false,
        }],
        set,
        origin: "вся библиотека".into(),
        own: false,
        total,
    })
}
