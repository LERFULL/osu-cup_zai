//! Карты: запись, чтение, фильтрация и пагинация.
//!
//! Все функции принимают `&Connection`. Внутри `Db::with_tx` замыкание получает
//! `&Transaction`, который сам приводится к `&Connection`, так что пачку записей
//! можно складывать в одну транзакцию без отдельных сигнатур.

use std::collections::HashMap;

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row, ToSql};

use super::{now_iso, placeholders, CHUNK};
use crate::error::Result;
use crate::model::{
    Beatmap, BeatmapAttributes, Label, LibraryFilter, LibrarySummary, ModCount, Page, SkillsetTag,
};

/// Колонки карты в одном месте: и список, и карточка читают одинаково.
const COLS: &str = "b.beatmap_id, b.beatmapset_id, b.checksum, \
     b.artist, b.artist_unicode, b.title, b.title_unicode, b.version, b.creator, b.creator_id, \
     b.difficulty_rating, b.bpm, b.total_length, b.hit_length, \
     b.cs, b.ar, b.accuracy, b.drain, \
     b.count_circles, b.count_sliders, b.count_spinners, b.max_combo, \
     b.status, b.ranked_date, b.last_updated, b.tags, b.pack_tags, b.genre_id, b.language_id, \
     b.failtimes, b.cover_path, b.preview_path, b.note, b.is_manual, b.is_gone, b.added_at";

/// Карта без связей — моды, скилсеты и метки доливаются отдельным проходом.
fn map_row(row: &Row) -> rusqlite::Result<Beatmap> {
    let failtimes: Option<String> = row.get("failtimes")?;
    Ok(Beatmap {
        beatmap_id: row.get("beatmap_id")?,
        beatmapset_id: row.get("beatmapset_id")?,
        checksum: row.get("checksum")?,

        artist: row.get("artist")?,
        artist_unicode: row.get("artist_unicode")?,
        title: row.get("title")?,
        title_unicode: row.get("title_unicode")?,
        version: row.get("version")?,
        creator: row.get("creator")?,
        creator_id: row.get("creator_id")?,

        difficulty_rating: row.get("difficulty_rating")?,
        bpm: row.get("bpm")?,
        total_length: row.get("total_length")?,
        hit_length: row.get("hit_length")?,
        cs: row.get("cs")?,
        ar: row.get("ar")?,
        accuracy: row.get("accuracy")?,
        drain: row.get("drain")?,
        count_circles: row.get("count_circles")?,
        count_sliders: row.get("count_sliders")?,
        count_spinners: row.get("count_spinners")?,
        max_combo: row.get("max_combo")?,

        status: row.get("status")?,
        ranked_date: row.get("ranked_date")?,
        last_updated: row.get("last_updated")?,
        tags: row.get("tags")?,
        pack_tags: row.get("pack_tags")?,
        genre_id: row.get("genre_id")?,
        language_id: row.get("language_id")?,
        // Битый JSON в кеше не повод ронять список.
        failtimes: failtimes.and_then(|s| serde_json::from_str(&s).ok()),

        cover_path: row.get("cover_path")?,
        preview_path: row.get("preview_path")?,

        note: row.get("note")?,
        is_manual: row.get::<_, i64>("is_manual")? != 0,
        is_gone: row.get::<_, i64>("is_gone")? != 0,
        added_at: row.get("added_at")?,

        mods: Vec::new(),
        fm_mods: Vec::new(),
        skillsets: Vec::new(),
        labels: Vec::new(),
        set_count: None,
    })
}

/// Моды или FM-моды для пачки карт. `table` — только наш литерал, не ввод снаружи.
fn load_mod_table(
    conn: &Connection,
    table: &str,
    ids: &[i64],
) -> Result<HashMap<i64, Vec<String>>> {
    let mut out: HashMap<i64, Vec<String>> = HashMap::new();
    for chunk in ids.chunks(CHUNK) {
        let sql = format!(
            "SELECT beatmap_id, \"mod\" FROM {table} WHERE beatmap_id IN ({}) \
             ORDER BY beatmap_id, \"mod\"",
            placeholders(chunk.len())
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(chunk.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, m) = row?;
            out.entry(id).or_default().push(m);
        }
    }
    Ok(out)
}

fn load_skillsets(conn: &Connection, ids: &[i64]) -> Result<HashMap<i64, Vec<SkillsetTag>>> {
    let mut out: HashMap<i64, Vec<SkillsetTag>> = HashMap::new();
    for chunk in ids.chunks(CHUNK) {
        let sql = format!(
            "SELECT beatmap_id, skillset, suggested FROM beatmap_skillsets \
             WHERE beatmap_id IN ({}) ORDER BY beatmap_id, skillset",
            placeholders(chunk.len())
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(chunk.iter()), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                SkillsetTag {
                    skillset: r.get(1)?,
                    suggested: r.get::<_, i64>(2)? != 0,
                },
            ))
        })?;
        for row in rows {
            let (id, tag) = row?;
            out.entry(id).or_default().push(tag);
        }
    }
    Ok(out)
}

fn load_labels(conn: &Connection, ids: &[i64]) -> Result<HashMap<i64, Vec<Label>>> {
    let mut out: HashMap<i64, Vec<Label>> = HashMap::new();
    for chunk in ids.chunks(CHUNK) {
        let sql = format!(
            "SELECT bl.beatmap_id, l.id, l.name, l.color \
             FROM beatmap_labels bl JOIN labels l ON l.id = bl.label_id \
             WHERE bl.beatmap_id IN ({}) ORDER BY bl.beatmap_id, l.name",
            placeholders(chunk.len())
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(chunk.iter()), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                Label {
                    id: r.get(1)?,
                    name: r.get(2)?,
                    color: r.get(3)?,
                },
            ))
        })?;
        for row in rows {
            let (id, label) = row?;
            out.entry(id).or_default().push(label);
        }
    }
    Ok(out)
}

/// Доливает связи одним проходом на всю страницу, без запроса на карту.
fn attach(conn: &Connection, maps: &mut [Beatmap]) -> Result<()> {
    if maps.is_empty() {
        return Ok(());
    }
    let ids: Vec<i64> = maps.iter().map(|m| m.beatmap_id).collect();
    let mut mods = load_mod_table(conn, "beatmap_mods", &ids)?;
    let mut fm = load_mod_table(conn, "beatmap_fm_mods", &ids)?;
    let mut skillsets = load_skillsets(conn, &ids)?;
    let mut labels = load_labels(conn, &ids)?;

    for map in maps.iter_mut() {
        map.mods = mods.remove(&map.beatmap_id).unwrap_or_default();
        map.fm_mods = fm.remove(&map.beatmap_id).unwrap_or_default();
        map.skillsets = skillsets.remove(&map.beatmap_id).unwrap_or_default();
        map.labels = labels.remove(&map.beatmap_id).unwrap_or_default();
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────── запись

/// Кладёт карту в базу. `true` — карта новая, `false` — уже была и обновлена.
///
/// При повторном импорте пользовательские поля не трогаются: заметка, `is_manual`,
/// `added_at`, а также мод-теги и скилсеты, проставленные руками, остаются на месте.
/// Обновляются только данные с osu!.
pub fn upsert(conn: &Connection, map: &Beatmap) -> Result<bool> {
    let failtimes = match &map.failtimes {
        Some(f) => Some(serde_json::to_string(f)?),
        None => None,
    };

    let existed = conn
        .query_row(
            "SELECT 1 FROM beatmaps WHERE beatmap_id = ?1",
            params![map.beatmap_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();

    if existed {
        conn.execute(
            "UPDATE beatmaps SET
                beatmapset_id = ?2, checksum = ?3,
                artist = ?4, artist_unicode = ?5, title = ?6, title_unicode = ?7,
                version = ?8, creator = ?9, creator_id = ?10,
                difficulty_rating = ?11, bpm = ?12, total_length = ?13, hit_length = ?14,
                cs = ?15, ar = ?16, accuracy = ?17, drain = ?18,
                count_circles = ?19, count_sliders = ?20, count_spinners = ?21, max_combo = ?22,
                status = ?23, ranked_date = ?24, last_updated = ?25,
                tags = ?26, pack_tags = ?27, genre_id = ?28, language_id = ?29, failtimes = ?30,
                cover_path = COALESCE(?31, cover_path),
                preview_path = COALESCE(?32, preview_path),
                note = COALESCE(?33, note),
                is_gone = ?34
             WHERE beatmap_id = ?1",
            params![
                map.beatmap_id,
                map.beatmapset_id,
                map.checksum,
                map.artist,
                map.artist_unicode,
                map.title,
                map.title_unicode,
                map.version,
                map.creator,
                map.creator_id,
                map.difficulty_rating,
                map.bpm,
                map.total_length,
                map.hit_length,
                map.cs,
                map.ar,
                map.accuracy,
                map.drain,
                map.count_circles,
                map.count_sliders,
                map.count_spinners,
                map.max_combo,
                map.status,
                map.ranked_date,
                map.last_updated,
                map.tags,
                map.pack_tags,
                map.genre_id,
                map.language_id,
                failtimes,
                map.cover_path,
                map.preview_path,
                map.note,
                map.is_gone as i64,
            ],
        )?;
    } else {
        let added_at = if map.added_at.trim().is_empty() {
            now_iso()
        } else {
            map.added_at.clone()
        };
        conn.execute(
            "INSERT INTO beatmaps (
                beatmap_id, beatmapset_id, checksum,
                artist, artist_unicode, title, title_unicode, version, creator, creator_id,
                difficulty_rating, bpm, total_length, hit_length,
                cs, ar, accuracy, drain,
                count_circles, count_sliders, count_spinners, max_combo,
                status, ranked_date, last_updated, tags, pack_tags, genre_id, language_id,
                failtimes, cover_path, preview_path, note, is_manual, is_gone, added_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30,
                ?31, ?32, ?33, ?34, ?35, ?36
             )",
            params![
                map.beatmap_id,
                map.beatmapset_id,
                map.checksum,
                map.artist,
                map.artist_unicode,
                map.title,
                map.title_unicode,
                map.version,
                map.creator,
                map.creator_id,
                map.difficulty_rating,
                map.bpm,
                map.total_length,
                map.hit_length,
                map.cs,
                map.ar,
                map.accuracy,
                map.drain,
                map.count_circles,
                map.count_sliders,
                map.count_spinners,
                map.max_combo,
                map.status,
                map.ranked_date,
                map.last_updated,
                map.tags,
                map.pack_tags,
                map.genre_id,
                map.language_id,
                failtimes,
                map.cover_path,
                map.preview_path,
                map.note,
                map.is_manual as i64,
                map.is_gone as i64,
                added_at,
            ],
        )?;
    }

    // OR IGNORE: то, что пользователь проставил руками, остаётся.
    // Для свежей вставки сюда подмешивается память модов: карта могла
    // раньше жить в библиотеке, её удалили и теперь добавили заново —
    // прежние теги возвращаются сами, руками их ставить не надо.
    let (tag_mods, tag_fm) = if existed {
        (map.mods.clone(), map.fm_mods.clone())
    } else {
        restore_remod(conn, map.beatmap_id, &map.mods, &map.fm_mods)
    };
    {
        let mut stmt = conn
            .prepare("INSERT OR IGNORE INTO beatmap_mods (beatmap_id, \"mod\") VALUES (?1, ?2)")?;
        for m in &tag_mods {
            stmt.execute(params![map.beatmap_id, m])?;
        }
    }
    {
        let mut stmt = conn.prepare(
            "INSERT OR IGNORE INTO beatmap_fm_mods (beatmap_id, \"mod\") VALUES (?1, ?2)",
        )?;
        for m in &tag_fm {
            stmt.execute(params![map.beatmap_id, m])?;
        }
    }
    {
        let mut stmt = conn.prepare(
            "INSERT OR IGNORE INTO beatmap_skillsets (beatmap_id, skillset, suggested) \
             VALUES (?1, ?2, ?3)",
        )?;
        for tag in &map.skillsets {
            stmt.execute(params![map.beatmap_id, tag.skillset, tag.suggested as i64])?;
        }
    }

    Ok(!existed)
}

pub fn exists(conn: &Connection, id: i64) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM beatmaps WHERE beatmap_id = ?1",
            params![id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Какие из переданных id уже есть в библиотеке — для отсева дублей при импорте.
pub fn existing_ids(conn: &Connection, ids: &[i64]) -> Result<Vec<i64>> {
    let mut out = Vec::new();
    for chunk in ids.chunks(CHUNK) {
        let sql = format!(
            "SELECT beatmap_id FROM beatmaps WHERE beatmap_id IN ({})",
            placeholders(chunk.len())
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(chunk.iter()), |r| r.get::<_, i64>(0))?;
        for row in rows {
            out.push(row?);
        }
    }
    Ok(out)
}

pub fn delete(conn: &Connection, ids: &[i64]) -> Result<()> {
    // Память модов — до удаления: строка карты исчезнет вместе с каскадом
    // тегов, а сюда мы складываем, что на ней было проставлено. При
    // повторной загрузке той же карты теги вернутся сами (см. `upsert`).
    for chunk in ids.chunks(CHUNK) {
        let sql = format!(
            "SELECT beatmap_id FROM beatmaps WHERE beatmap_id IN ({})",
            placeholders(chunk.len())
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(chunk.iter()), |r| r.get::<_, i64>(0))?;
        for row in rows {
            remember_mods(conn, row?);
        }
    }

    for chunk in ids.chunks(CHUNK) {
        let sql = format!(
            "DELETE FROM beatmaps WHERE beatmap_id IN ({})",
            placeholders(chunk.len())
        );
        // Связи снимаются каскадом — foreign_keys включены при открытии базы.
        conn.execute(&sql, params_from_iter(chunk.iter()))?;
    }
    Ok(())
}

/// Возвращает сохранённые теги удалённой карты, склеенные с новыми. Без
/// дублей: что уже стоит в `mods`, из памяти второй раз не приходит.
fn restore_remod(
    conn: &Connection,
    beatmap_id: i64,
    fresh: &[String],
    fresh_fm: &[String],
) -> (Vec<String>, Vec<String>) {
    let saved: Option<(String, String)> = conn
        .query_row(
            "SELECT mods, fm_mods FROM beatmap_remod WHERE beatmap_id = ?1",
            params![beatmap_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();

    let Some((mods_json, fm_json)) = saved else {
        return (fresh.to_vec(), fresh_fm.to_vec());
    };

    let old: Vec<String> = serde_json::from_str(&mods_json).unwrap_or_default();
    let old_fm: Vec<String> = serde_json::from_str(&fm_json).unwrap_or_default();

    let mut mods = fresh.to_vec();
    for m in old {
        if !mods.contains(&m) {
            mods.push(m);
        }
    }
    let mut fm = fresh_fm.to_vec();
    for m in old_fm {
        if !fm.contains(&m) {
            fm.push(m);
        }
    }
    (mods, fm)
}

/// Есть ли уже атрибуты без модов — чтобы не ходить в сеть второй раз за
/// скилсетом карты, которая раньше уже скачивалась.
pub fn has_attributes(conn: &Connection, beatmap_id: i64) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM beatmap_attributes WHERE beatmap_id = ?1 AND mods = ''",
            params![beatmap_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Запоминает мод-теги карты на случай, если её удалят, а потом добавят заново.
fn remember_mods(conn: &Connection, beatmap_id: i64) {
    let mods: Vec<String> = conn
        .prepare("SELECT \"mod\" FROM beatmap_mods WHERE beatmap_id = ?1")
        .and_then(|mut st| {
            st.query_map(params![beatmap_id], |r| r.get::<_, String>(0))
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();
    let fm: Vec<String> = conn
        .prepare("SELECT \"mod\" FROM beatmap_fm_mods WHERE beatmap_id = ?1")
        .and_then(|mut st| {
            st.query_map(params![beatmap_id], |r| r.get::<_, String>(0))
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();

    // Пустой памяти быть не может: зачем помнить, что тегов не было.
    // Пустая запись затирается — так после «удалил и пере-tagировал»
    // возвращаются свежие теги, а не то, что было до них.
    if mods.is_empty() && fm.is_empty() {
        let _ = conn.execute(
            "DELETE FROM beatmap_remod WHERE beatmap_id = ?1",
            params![beatmap_id],
        );
        return;
    }

    let _ = conn.execute(
        "INSERT INTO beatmap_remod (beatmap_id, mods, fm_mods, saved_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(beatmap_id) DO UPDATE
            SET mods = ?2, fm_mods = ?3, saved_at = ?4",
        params![
            beatmap_id,
            serde_json::to_string(&mods).unwrap_or_else(|_| "[]".into()),
            serde_json::to_string(&fm).unwrap_or_else(|_| "[]".into()),
            now_iso()
        ],
    );
}

// ─────────────────────────────────────────────────────────────── чтение

pub fn get(conn: &Connection, id: i64) -> Result<Option<Beatmap>> {
    let sql = format!("SELECT {COLS} FROM beatmaps b WHERE b.beatmap_id = ?1");
    let found = conn.query_row(&sql, params![id], map_row).optional()?;

    match found {
        Some(map) => {
            let mut one = [map];
            attach(conn, &mut one)?;
            let [map] = one;
            Ok(Some(map))
        }
        None => Ok(None),
    }
}

/// Все сложности набора, от простой к сложной.
pub fn set_difficulties(conn: &Connection, set_id: i64) -> Result<Vec<Beatmap>> {
    let sql = format!(
        "SELECT {COLS} FROM beatmaps b
         WHERE b.beatmapset_id = ?1
         ORDER BY b.difficulty_rating ASC, b.beatmap_id ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![set_id], map_row)?;

    let mut maps = Vec::new();
    for row in rows {
        maps.push(row?);
    }
    attach(conn, &mut maps)?;
    Ok(maps)
}

/// Условия фильтра и параметры к ним. Значения идут только биндингами,
/// в SQL не попадает ни один пользовательский символ.
struct Where {
    joins: String,
    conds: Vec<String>,
    args: Vec<Box<dyn ToSql>>,
}

/// FTS5 ломается на кавычках и операторах, поэтому каждое слово запроса
/// оборачиваем в кавычки и добавляем `*`. Апострофы в `YUC'e` при этом работают.
fn fts_query(raw: &str) -> Option<String> {
    let words: Vec<String> = raw
        .split_whitespace()
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{}\"*", w.replace('"', "\"\"")))
        .collect();

    if words.is_empty() {
        None
    } else {
        Some(words.join(" "))
    }
}

fn push_range(w: &mut Where, col: &str, r: &crate::model::Range) {
    if let Some(min) = r.min {
        w.conds.push(format!("{col} >= ?"));
        w.args.push(Box::new(min));
    }
    if let Some(max) = r.max {
        w.conds.push(format!("{col} <= ?"));
        w.args.push(Box::new(max));
    }
}

fn build_where(conn: &Connection, f: &LibraryFilter) -> Result<Where> {
    // Умная коллекция — это сохранённый фильтр. Она заменяет собой текущий,
    // иначе два набора условий начали бы противоречить друг другу.
    if let Some(cid) = f.collection_id {
        let smart: Option<(i64, Option<String>)> = conn
            .query_row(
                "SELECT is_smart, filter FROM collections WHERE id = ?1",
                params![cid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        if let Some((1, Some(json))) = smart {
            if let Ok(mut inner) = serde_json::from_str::<LibraryFilter>(&json) {
                // Поиск и сортировку, набранные прямо сейчас, оставляем поверх.
                inner.collection_id = None;
                if !f.query.trim().is_empty() {
                    inner.query = f.query.clone();
                }
                inner.sort = f.sort.clone();
                inner.dir = f.dir.clone();
                return build_where(conn, &inner);
            }
        }
    }

    let mut w = Where {
        joins: String::new(),
        conds: Vec::new(),
        args: Vec::new(),
    };

    // Порядок важен: параметры биндятся позиционно, поэтому джойны идут первыми
    // и их аргументы попадают в список раньше условий WHERE.
    if let Some(q) = fts_query(&f.query) {
        w.joins
            .push_str(" JOIN beatmaps_fts fts ON fts.rowid = b.beatmap_id");
        w.conds.push("beatmaps_fts MATCH ?".into());
        w.args.push(Box::new(q));
    }

    // Обычная коллекция — условием, а не джойном: так порядок параметров
    // не зависит от того, есть ли поиск.
    if let Some(cid) = f.collection_id {
        w.conds.push(
            "EXISTS (SELECT 1 FROM collection_beatmaps cb
                     WHERE cb.beatmap_id = b.beatmap_id AND cb.collection_id = ?)"
                .into(),
        );
        w.args.push(Box::new(cid));
    }

    // «Без мод-тегов» — карта без единой записи в beatmap_mods. NOT EXISTS,
    // а не «mod IS NULL»: у карты их несколько, а отсутствие — это именно
    // отсутствие строк.
    if f.no_mods {
        w.conds.push(
            "NOT EXISTS (SELECT 1 FROM beatmap_mods m WHERE m.beatmap_id = b.beatmap_id)".into(),
        );
    }

    if !f.mods.is_empty() {
        // Карта подходит, если разрешена хотя бы в одном из выбранных мод-тегов.
        w.conds.push(format!(
            "EXISTS (SELECT 1 FROM beatmap_mods m WHERE m.beatmap_id = b.beatmap_id AND m.mod IN ({}))",
            placeholders(f.mods.len())
        ));
        for m in &f.mods {
            w.args.push(Box::new(m.clone()));
        }
    }

    // Скилсеты — наоборот: нужны все выбранные сразу.
    for sk in &f.skillsets {
        w.conds.push(
            "EXISTS (SELECT 1 FROM beatmap_skillsets s WHERE s.beatmap_id = b.beatmap_id AND s.skillset = ?)"
                .into(),
        );
        w.args.push(Box::new(sk.clone()));
    }

    if !f.label_ids.is_empty() {
        w.conds.push(format!(
            "EXISTS (SELECT 1 FROM beatmap_labels l WHERE l.beatmap_id = b.beatmap_id AND l.label_id IN ({}))",
            placeholders(f.label_ids.len())
        ));
        for id in &f.label_ids {
            w.args.push(Box::new(*id));
        }
    }

    if !f.statuses.is_empty() {
        w.conds
            .push(format!("b.status IN ({})", placeholders(f.statuses.len())));
        for s in &f.statuses {
            w.args.push(Box::new(s.clone()));
        }
    }

    push_range(&mut w, "b.difficulty_rating", &f.stars);
    push_range(&mut w, "b.bpm", &f.bpm);
    push_range(&mut w, "b.total_length", &f.length);

    Ok(w)
}

/// Ключ сортировки. Префикс нужен потому, что при схлопывании наборов внешний
/// запрос читает уже готовый подзапрос, где алиаса `b` нет.
fn sort_key(f: &LibraryFilter, prefix: &str) -> String {
    let col = match f.sort.as_str() {
        "stars" => "difficulty_rating",
        "bpm" => "bpm",
        "length" => "total_length",
        "title" => "title COLLATE NOCASE",
        "artist" => "artist COLLATE NOCASE",
        _ => "added_at",
    };
    let dir = if f.dir.eq_ignore_ascii_case("asc") {
        "ASC"
    } else {
        "DESC"
    };
    // Второй ключ обязателен: на равных значениях пагинация иначе поедет.
    format!("{prefix}{col} {dir}, {prefix}beatmap_id {dir}")
}

fn order_by(f: &LibraryFilter) -> String {
    format!("ORDER BY {}", sort_key(f, "b."))
}

/// Страница библиотеки. Фильтрация и срез целиком на стороне SQL —
/// библиотека рассчитана на десятки тысяч карт.
pub fn list(
    conn: &Connection,
    f: &LibraryFilter,
    offset: i64,
    limit: i64,
) -> Result<Page<Beatmap>> {
    let w = build_where(conn, f)?;
    let where_sql = if w.conds.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", w.conds.join(" AND "))
    };

    // Ручные карты набора не имеют. Партиция по отрицательному id держит их
    // порознь: иначе все они схлопнулись бы в один «набор без номера».
    const SET_KEY: &str = "COALESCE(b.beatmapset_id, -b.beatmap_id)";

    let total: i64 = {
        let what = if f.group_sets {
            format!("COUNT(DISTINCT {SET_KEY})")
        } else {
            "COUNT(*)".to_string()
        };
        let sql = format!(
            "SELECT {what} FROM beatmaps b{joins}{where_sql}",
            joins = w.joins
        );
        let args: Vec<&dyn ToSql> = w.args.iter().map(|a| a.as_ref()).collect();
        conn.query_row(&sql, args.as_slice(), |r| r.get(0))?
    };

    let limit = limit.clamp(1, 500);
    let offset = offset.max(0);

    // В схлопнутом виде от набора остаётся одна строка — та, что первой идёт
    // по текущей сортировке. Считаем и сколько сложностей за ней стоит,
    // чтобы строка могла показать «ещё 4».
    let sql = if f.group_sets {
        format!(
            "SELECT * FROM (
               SELECT {COLS},
                      COUNT(*) OVER (PARTITION BY {SET_KEY}) AS set_count,
                      ROW_NUMBER() OVER (PARTITION BY {SET_KEY} ORDER BY {inner}) AS rn
               FROM beatmaps b{joins}{where_sql}
             ) WHERE rn = 1 ORDER BY {outer} LIMIT ? OFFSET ?",
            joins = w.joins,
            inner = sort_key(f, "b."),
            outer = sort_key(f, ""),
        )
    } else {
        format!(
            "SELECT {COLS} FROM beatmaps b{joins}{where_sql} {order} LIMIT ? OFFSET ?",
            joins = w.joins,
            order = order_by(f),
        )
    };

    let mut args: Vec<Box<dyn ToSql>> = w.args;
    args.push(Box::new(limit));
    args.push(Box::new(offset));
    let refs: Vec<&dyn ToSql> = args.iter().map(|a| a.as_ref()).collect();

    let mut stmt = conn.prepare(&sql)?;
    let group = f.group_sets;
    let rows = stmt.query_map(refs.as_slice(), move |r| {
        let mut m = map_row(r)?;
        if group {
            m.set_count = Some(r.get("set_count")?);
        }
        Ok(m)
    })?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row?);
    }
    attach(conn, &mut items)?;

    Ok(Page {
        items,
        total,
        offset,
    })
}

/// Карты по списку id, в порядке самого списка. Пропавшие id просто выпадают.
pub fn by_ids(conn: &Connection, ids: &[i64]) -> Result<Vec<Beatmap>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut found: Vec<Beatmap> = Vec::new();
    for chunk in ids.chunks(CHUNK) {
        let sql = format!(
            "SELECT {COLS} FROM beatmaps b WHERE b.beatmap_id IN ({})",
            placeholders(chunk.len())
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(chunk.iter()), map_row)?;
        for row in rows {
            found.push(row?);
        }
    }
    attach(conn, &mut found)?;

    // Порядок задаёт вызывающий: слоты маппула идут не по id.
    let mut by_id: HashMap<i64, Beatmap> = found.into_iter().map(|m| (m.beatmap_id, m)).collect();
    Ok(ids.iter().filter_map(|id| by_id.remove(id)).collect())
}

/// Все id карт под фильтром, без страниц. Нужно там, где состав важен целиком:
/// источник слота шаблона может быть и умной коллекцией, а её состав — это
/// фильтр, а не таблица связей.
pub fn ids_for(conn: &Connection, f: &LibraryFilter) -> Result<Vec<i64>> {
    let w = build_where(conn, f)?;
    let where_sql = if w.conds.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", w.conds.join(" AND "))
    };
    let sql = format!(
        "SELECT b.beatmap_id FROM beatmaps b{joins}{where_sql}",
        joins = w.joins
    );

    let refs: Vec<&dyn ToSql> = w.args.iter().map(|a| a.as_ref()).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(refs.as_slice(), |r| r.get::<_, i64>(0))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Сколько карт попадает под фильтр. Нужен счётчику умной коллекции:
/// её состав нигде не хранится и считается по сохранённым условиям.
pub fn count_for(conn: &Connection, f: &LibraryFilter) -> Result<i64> {
    let w = build_where(conn, f)?;
    let where_sql = if w.conds.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", w.conds.join(" AND "))
    };
    let sql = format!(
        "SELECT COUNT(*) FROM beatmaps b{joins}{where_sql}",
        joins = w.joins
    );

    let refs: Vec<&dyn ToSql> = w.args.iter().map(|a| a.as_ref()).collect();
    Ok(conn.query_row(&sql, refs.as_slice(), |r| r.get(0))?)
}

/// Из чего состоит текущая выдача: моды, звёзды, длина, BPM.
///
/// Считается тем же фильтром, что и список, — иначе сводка описывала бы
/// не то, что человек видит на экране. Три запроса вместо одного: общий
/// разбор и разбивка по модам считаются по-разному, а склеивать их в один
/// запрос значит получить кратные строки из-за джойна тегов.
pub fn summary(conn: &Connection, f: &LibraryFilter) -> Result<LibrarySummary> {
    let w = build_where(conn, f)?;
    let where_sql = if w.conds.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", w.conds.join(" AND "))
    };
    let args: Vec<&dyn ToSql> = w.args.iter().map(|a| a.as_ref()).collect();

    type Totals = (
        i64,
        Option<f64>,
        Option<f64>,
        Option<f64>,
        Option<f64>,
        Option<i64>,
        Option<f64>,
        Option<f64>,
    );
    let totals: Totals = conn.query_row(
        &format!(
            "SELECT COUNT(*),
                    MIN(b.difficulty_rating), MAX(b.difficulty_rating), AVG(b.difficulty_rating),
                    AVG(b.total_length), SUM(b.total_length),
                    MIN(b.bpm), MAX(b.bpm)
               FROM beatmaps b{joins}{where_sql}",
            joins = w.joins
        ),
        args.as_slice(),
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
            ))
        },
    )?;

    let untagged: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM beatmaps b{joins}{where_sql}{and} NOT EXISTS (
                 SELECT 1 FROM beatmap_mods m WHERE m.beatmap_id = b.beatmap_id
             )",
            joins = w.joins,
            and = if w.conds.is_empty() { " WHERE" } else { " AND" }
        ),
        args.as_slice(),
        |r| r.get(0),
    )?;

    // Карта с несколькими тегами считается в каждом: тег отвечает на вопрос
    // «куда её можно поставить», и сумма по модам законно больше числа карт.
    let mut st = conn.prepare(&format!(
        "SELECT m.mod, COUNT(*)
           FROM beatmaps b{joins}
           JOIN beatmap_mods m ON m.beatmap_id = b.beatmap_id
          {where_sql}
          GROUP BY m.mod
          ORDER BY m.mod",
        joins = w.joins
    ))?;
    let by_mod = st
        .query_map(args.as_slice(), |r| {
            Ok(ModCount {
                mod_tag: r.get(0)?,
                count: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(LibrarySummary {
        total: totals.0,
        untagged,
        by_mod,
        stars_min: totals.1,
        stars_max: totals.2,
        stars_avg: totals.3,
        length_avg: totals.4,
        length_total: totals.5,
        bpm_min: totals.6,
        bpm_max: totals.7,
    })
}

/// Сколько карт ещё без мод-тегов. Отдельным запросом, а не через `list`:
/// дереву нужно одно число, а не страница.
pub fn count_without_mods(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM beatmaps b
         WHERE NOT EXISTS (SELECT 1 FROM beatmap_mods m WHERE m.beatmap_id = b.beatmap_id)",
        [],
        |r| r.get(0),
    )?)
}

// ───────────────────────────────────────────── пользовательские поля

fn replace_tags(conn: &Connection, table: &str, id: i64, values: &[String]) -> Result<()> {
    conn.execute(
        &format!("DELETE FROM {table} WHERE beatmap_id = ?1"),
        params![id],
    )?;
    let mut stmt = conn.prepare(&format!(
        "INSERT OR IGNORE INTO {table} (beatmap_id, mod) VALUES (?1, ?2)"
    ))?;
    for v in values {
        stmt.execute(params![id, v])?;
    }
    Ok(())
}

pub fn set_mods(conn: &Connection, id: i64, mods: &[String]) -> Result<()> {
    replace_tags(conn, "beatmap_mods", id, mods)
}

pub fn set_fm_mods(conn: &Connection, id: i64, mods: &[String]) -> Result<()> {
    replace_tags(conn, "beatmap_fm_mods", id, mods)
}

/// Проставленное руками перестаёт быть предложенным — флаг suggested снимается.
pub fn set_skillsets(conn: &Connection, id: i64, skillsets: &[String]) -> Result<()> {
    conn.execute(
        "DELETE FROM beatmap_skillsets WHERE beatmap_id = ?1",
        params![id],
    )?;
    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO beatmap_skillsets (beatmap_id, skillset, suggested) VALUES (?1, ?2, 0)",
    )?;
    for s in skillsets {
        stmt.execute(params![id, s])?;
    }
    Ok(())
}

/// Предложенные скилсеты из атрибутов. Проставленное руками не задевает:
/// то, что уже стоит подтверждённым, остаётся подтверждённым.
pub fn suggest_skillsets(conn: &Connection, id: i64, skillsets: &[String]) -> Result<()> {
    conn.execute(
        "DELETE FROM beatmap_skillsets WHERE beatmap_id = ?1 AND suggested = 1",
        params![id],
    )?;
    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO beatmap_skillsets (beatmap_id, skillset, suggested) VALUES (?1, ?2, 1)",
    )?;
    for s in skillsets {
        stmt.execute(params![id, s])?;
    }
    Ok(())
}

pub fn set_note(conn: &Connection, id: i64, note: &str) -> Result<()> {
    conn.execute(
        "UPDATE beatmaps SET note = ?2 WHERE beatmap_id = ?1",
        params![id, note],
    )?;
    Ok(())
}

pub fn set_cover_path(conn: &Connection, id: i64, path: &str) -> Result<()> {
    conn.execute(
        "UPDATE beatmaps SET cover_path = ?2 WHERE beatmap_id = ?1",
        params![id, path],
    )?;
    Ok(())
}

pub fn bulk_add_mod(conn: &Connection, ids: &[i64], m: &str) -> Result<()> {
    let mut stmt =
        conn.prepare("INSERT OR IGNORE INTO beatmap_mods (beatmap_id, mod) VALUES (?1, ?2)")?;
    for id in ids {
        stmt.execute(params![id, m])?;
    }
    Ok(())
}

pub fn bulk_remove_mod(conn: &Connection, ids: &[i64], m: &str) -> Result<()> {
    let mut stmt = conn.prepare("DELETE FROM beatmap_mods WHERE beatmap_id = ?1 AND mod = ?2")?;
    for id in ids {
        stmt.execute(params![id, m])?;
    }
    Ok(())
}

/// Снимает с карт все мод-теги разом: разметить пачку заново обычно проще,
/// чем снимать теги по одному.
pub fn bulk_clear_mods(conn: &Connection, ids: &[i64]) -> Result<()> {
    let mut stmt = conn.prepare("DELETE FROM beatmap_mods WHERE beatmap_id = ?1")?;
    for id in ids {
        stmt.execute(params![id])?;
    }
    Ok(())
}

pub fn bulk_add_skillset(conn: &Connection, ids: &[i64], skillset: &str) -> Result<()> {
    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO beatmap_skillsets (beatmap_id, skillset, suggested) VALUES (?1, ?2, 0)",
    )?;
    for id in ids {
        stmt.execute(params![id, skillset])?;
    }
    Ok(())
}

// ────────────────────────────────────── звёзды и атрибуты под модами

pub fn get_attributes(conn: &Connection, id: i64) -> Result<Vec<BeatmapAttributes>> {
    let mut stmt = conn.prepare(
        "SELECT beatmap_id, mods, star_rating, aim_difficulty, speed_difficulty,
                slider_factor, speed_note_count, max_combo, fetched_at
         FROM beatmap_attributes WHERE beatmap_id = ?1 ORDER BY mods",
    )?;
    let rows = stmt.query_map(params![id], |r| {
        Ok(BeatmapAttributes {
            beatmap_id: r.get(0)?,
            mods: r.get(1)?,
            star_rating: r.get(2)?,
            aim_difficulty: r.get(3)?,
            speed_difficulty: r.get(4)?,
            slider_factor: r.get(5)?,
            speed_note_count: r.get(6)?,
            max_combo: r.get(7)?,
            fetched_at: r.get(8)?,
        })
    })?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn put_attributes(conn: &Connection, a: &BeatmapAttributes) -> Result<()> {
    conn.execute(
        "INSERT INTO beatmap_attributes
            (beatmap_id, mods, star_rating, aim_difficulty, speed_difficulty,
             slider_factor, speed_note_count, max_combo, fetched_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(beatmap_id, mods) DO UPDATE SET
             star_rating = excluded.star_rating,
             aim_difficulty = excluded.aim_difficulty,
             speed_difficulty = excluded.speed_difficulty,
             slider_factor = excluded.slider_factor,
             speed_note_count = excluded.speed_note_count,
             max_combo = excluded.max_combo,
             fetched_at = excluded.fetched_at",
        params![
            a.beatmap_id,
            a.mods,
            a.star_rating,
            a.aim_difficulty,
            a.speed_difficulty,
            a.slider_factor,
            a.speed_note_count,
            a.max_combo,
            a.fetched_at,
        ],
    )?;
    Ok(())
}

/// Скилсеты, которые можно предположить по атрибутам. Помечаются как предложенные
/// и в интерфейсе отличаются от подтверждённых.
pub fn auto_skillsets(map: &Beatmap, attr: &BeatmapAttributes) -> Vec<String> {
    let mut out = Vec::new();

    if let (Some(speed), Some(aim)) = (attr.speed_difficulty, attr.aim_difficulty) {
        // Карта без аима — вырожденный случай, делить на ноль незачем.
        if aim > 0.01 {
            let ratio = speed / aim;
            if ratio > 1.15 {
                out.push("speed".to_string());
            } else if ratio < 0.75 {
                out.push("aim".to_string());
            }
        }
    }

    if attr.slider_factor.is_some_and(|s| s < 0.95) {
        out.push("tech".to_string());
    }
    if attr.speed_note_count.is_some_and(|c| c > 400.0) {
        out.push("stream".to_string());
    }
    if map.total_length.is_some_and(|l| l > 240) {
        out.push("stamina".to_string());
    }

    out
}
