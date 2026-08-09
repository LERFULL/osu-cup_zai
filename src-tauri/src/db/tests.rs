//! Тесты слоя базы: схема, фильтрация, коллекции, метки.
//!
//! Каждый тест поднимает свою базу в памяти — состояние между ними не течёт.

use rusqlite::Connection;

use crate::db::{beatmaps, collections, labels};
use crate::model::{Beatmap, BeatmapAttributes, LibraryFilter, Range, SkillsetTag};

const SCHEMA: &str = include_str!("schema.sql");
const BUILTIN_TEMPLATES: &str = include_str!("migrations/002_builtin_templates.sql");

fn db() -> Connection {
    let conn = Connection::open_in_memory().expect("база в памяти");
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    conn.execute_batch(SCHEMA).expect("схема применилась");
    conn.execute_batch(BUILTIN_TEMPLATES)
        .expect("шаблоны из коробки применились");
    conn
}

fn map(id: i64, artist: &str, title: &str, stars: f64) -> Beatmap {
    Beatmap {
        beatmap_id: id,
        beatmapset_id: Some(id * 10),
        checksum: None,
        artist: artist.into(),
        artist_unicode: None,
        title: title.into(),
        title_unicode: None,
        version: "Extra".into(),
        creator: Some("mapper".into()),
        creator_id: Some(1),
        difficulty_rating: stars,
        bpm: Some(180.0),
        total_length: Some(200),
        hit_length: Some(190),
        cs: Some(4.0),
        ar: Some(9.0),
        accuracy: Some(8.0),
        drain: Some(5.0),
        count_circles: Some(100),
        count_sliders: Some(50),
        count_spinners: Some(1),
        max_combo: Some(500),
        status: Some("ranked".into()),
        ranked_date: None,
        last_updated: None,
        tags: None,
        pack_tags: None,
        genre_id: None,
        language_id: None,
        failtimes: None,
        cover_path: None,
        preview_path: None,
        note: None,
        is_manual: false,
        is_gone: false,
        added_at: "2026-01-01T00:00:00Z".into(),
        mods: vec!["NM".into()],
        fm_mods: vec![],
        skillsets: vec![],
        labels: vec![],
        set_count: None,
    }
}

#[test]
fn schema_applies_and_is_idempotent() {
    let conn = db();
    // Повторное применение не должно падать — на этом держатся миграции.
    conn.execute_batch(SCHEMA).expect("схема применилась дважды");
}

#[test]
fn upsert_reports_new_then_existing() {
    let conn = db();
    assert!(beatmaps::upsert(&conn, &map(1, "Camellia", "Ghost", 6.2)).unwrap());
    assert!(!beatmaps::upsert(&conn, &map(1, "Camellia", "Ghost", 6.2)).unwrap());
}

#[test]
fn upsert_keeps_user_note() {
    let conn = db();
    beatmaps::upsert(&conn, &map(1, "Camellia", "Ghost", 6.2)).unwrap();
    beatmaps::set_note(&conn, 1, "проверено").unwrap();

    // Повторный импорт обновляет данные с osu!, но заметку не трогает.
    beatmaps::upsert(&conn, &map(1, "Camellia", "Ghost", 6.5)).unwrap();

    let got = beatmaps::get(&conn, 1).unwrap().unwrap();
    assert_eq!(got.note.as_deref(), Some("проверено"));
    assert_eq!(got.difficulty_rating, 6.5);
}

#[test]
fn get_returns_mods_and_skillsets() {
    let conn = db();
    let mut m = map(1, "Camellia", "Ghost", 6.2);
    m.mods = vec!["NM".into(), "HD".into()];
    m.skillsets = vec![SkillsetTag {
        skillset: "stream".into(),
        suggested: true,
    }];
    beatmaps::upsert(&conn, &m).unwrap();

    let got = beatmaps::get(&conn, 1).unwrap().unwrap();
    assert_eq!(got.mods.len(), 2);
    assert_eq!(got.skillsets.len(), 1);
    assert!(got.skillsets[0].suggested);
}

#[test]
fn group_sets_counts_only_what_passed_the_filter() {
    let conn = db();
    // Один набор, три сложности, но под фильтр звёзд проходят только две.
    for (id, ver, stars) in [(1, "Easy", 2.0), (2, "Hard", 5.0), (3, "Extra", 6.0)] {
        let mut m = map(id, "A", "Song", stars);
        m.beatmapset_id = Some(555);
        m.version = ver.into();
        beatmaps::upsert(&conn, &m).unwrap();
    }

    let f = LibraryFilter {
        group_sets: true,
        stars: crate::model::Range {
            min: Some(4.0),
            max: None,
        },
        ..Default::default()
    };

    let page = beatmaps::list(&conn, &f, 0, 50).unwrap();
    assert_eq!(page.items.len(), 1);
    // Счётчик обещает то, что раскроется по клику, а не всё содержимое набора.
    assert_eq!(page.items[0].set_count, Some(2));
}

#[test]
fn group_sets_collapses_difficulties_into_one_row() {
    let conn = db();
    // Три сложности одного набора и одна чужая.
    for (id, ver, stars) in [(1, "Easy", 2.0), (2, "Hard", 4.0), (3, "Extra", 6.0)] {
        let mut m = map(id, "A", "Song", stars);
        m.beatmapset_id = Some(777);
        m.version = ver.into();
        beatmaps::upsert(&conn, &m).unwrap();
    }
    beatmaps::upsert(&conn, &map(9, "B", "Other", 5.0)).unwrap();

    let mut f = LibraryFilter {
        group_sets: true,
        sort: "stars".into(),
        dir: "desc".into(),
        ..Default::default()
    };

    let page = beatmaps::list(&conn, &f, 0, 50).unwrap();
    assert_eq!(page.total, 2, "два набора, а не четыре сложности");
    assert_eq!(page.items.len(), 2);

    let song = page
        .items
        .iter()
        .find(|m| m.beatmapset_id == Some(777))
        .expect("набор в списке");
    // Показываем ту сложность, что первой идёт по сортировке — самую высокую.
    assert_eq!(song.version, "Extra");
    assert_eq!(song.set_count, Some(3));

    let other = page
        .items
        .iter()
        .find(|m| m.beatmap_id == 9)
        .expect("чужая карта");
    assert_eq!(other.set_count, Some(1));

    // Без схлопывания — по строке на сложность, и счётчика нет.
    f.group_sets = false;
    let flat = beatmaps::list(&conn, &f, 0, 50).unwrap();
    assert_eq!(flat.total, 4);
    assert!(flat.items.iter().all(|m| m.set_count.is_none()));
}

#[test]
fn group_sets_keeps_manual_maps_apart() {
    let conn = db();
    // У ручных карт набора нет: они не должны слиться в одну строку.
    for id in 1..=3 {
        let mut m = map(id, "A", &format!("Manual {id}"), id as f64);
        m.beatmapset_id = None;
        m.is_manual = true;
        beatmaps::upsert(&conn, &m).unwrap();
    }

    let f = LibraryFilter {
        group_sets: true,
        ..Default::default()
    };
    let page = beatmaps::list(&conn, &f, 0, 50).unwrap();
    assert_eq!(page.total, 3);
    assert!(page.items.iter().all(|m| m.set_count == Some(1)));
}

#[test]
fn list_paginates_without_losing_rows() {
    let conn = db();
    for i in 1..=25 {
        beatmaps::upsert(&conn, &map(i, "A", &format!("Song {i}"), i as f64 / 4.0)).unwrap();
    }

    let f = LibraryFilter::default();
    let first = beatmaps::list(&conn, &f, 0, 10).unwrap();
    let second = beatmaps::list(&conn, &f, 10, 10).unwrap();
    let third = beatmaps::list(&conn, &f, 20, 10).unwrap();

    assert_eq!(first.total, 25);
    assert_eq!(first.items.len(), 10);
    assert_eq!(third.items.len(), 5);

    // Ни одна карта не должна попасть на две страницы: added_at у всех одинаковый,
    // порядок держится вторым ключом сортировки.
    let mut ids: Vec<i64> = first
        .items
        .iter()
        .chain(&second.items)
        .chain(&third.items)
        .map(|m| m.beatmap_id)
        .collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), 25);
}

#[test]
fn search_survives_apostrophe_in_artist() {
    let conn = db();
    beatmaps::upsert(&conn, &map(1, "YUC'e", "Future Cake", 5.0)).unwrap();
    beatmaps::upsert(&conn, &map(2, "Camellia", "Ghost", 6.0)).unwrap();

    let mut f = LibraryFilter::default();
    f.query = "YUC'e".into();

    let page = beatmaps::list(&conn, &f, 0, 50).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].beatmap_id, 1);
}

#[test]
fn search_does_not_break_on_fts_operators() {
    let conn = db();
    beatmaps::upsert(&conn, &map(1, "Camellia", "Ghost", 6.0)).unwrap();

    // Кавычки, звёздочки и OR — обычный ввод пользователя, а не синтаксис FTS.
    for q in ["\"", "*", "OR", "a AND", "(((", "NEAR/2"] {
        let mut f = LibraryFilter::default();
        f.query = q.into();
        beatmaps::list(&conn, &f, 0, 50).unwrap_or_else(|e| panic!("запрос {q:?} упал: {e}"));
    }
}

#[test]
fn filter_by_mod_and_stars() {
    let conn = db();
    let mut easy = map(1, "A", "Easy", 3.0);
    easy.mods = vec!["NM".into()];
    let mut hard = map(2, "B", "Hard", 7.0);
    hard.mods = vec!["DT".into()];
    beatmaps::upsert(&conn, &easy).unwrap();
    beatmaps::upsert(&conn, &hard).unwrap();

    let mut f = LibraryFilter::default();
    f.mods = vec!["DT".into()];
    assert_eq!(beatmaps::list(&conn, &f, 0, 50).unwrap().total, 1);

    let mut g = LibraryFilter::default();
    g.stars = Range {
        min: Some(5.0),
        max: None,
    };
    let page = beatmaps::list(&conn, &g, 0, 50).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].beatmap_id, 2);
}

#[test]
fn skillset_filter_requires_all() {
    let conn = db();
    let mut m = map(1, "A", "Both", 5.0);
    m.skillsets = vec![
        SkillsetTag {
            skillset: "aim".into(),
            suggested: false,
        },
        SkillsetTag {
            skillset: "stream".into(),
            suggested: false,
        },
    ];
    beatmaps::upsert(&conn, &m).unwrap();

    let mut only_aim = map(2, "B", "Aim", 5.0);
    only_aim.skillsets = vec![SkillsetTag {
        skillset: "aim".into(),
        suggested: false,
    }];
    beatmaps::upsert(&conn, &only_aim).unwrap();

    let mut f = LibraryFilter::default();
    f.skillsets = vec!["aim".into(), "stream".into()];
    let page = beatmaps::list(&conn, &f, 0, 50).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].beatmap_id, 1);
}

#[test]
fn collection_filters_and_survives_deletion() {
    let conn = db();
    beatmaps::upsert(&conn, &map(1, "A", "One", 4.0)).unwrap();
    beatmaps::upsert(&conn, &map(2, "B", "Two", 5.0)).unwrap();

    let col = collections::create(&conn, "Фан", Some("#FF6FB1")).unwrap();
    collections::add_beatmaps(&conn, col.id, &[1]).unwrap();

    let mut f = LibraryFilter::default();
    f.collection_id = Some(col.id);
    assert_eq!(beatmaps::list(&conn, &f, 0, 50).unwrap().total, 1);

    let listed = collections::list(&conn).unwrap();
    assert_eq!(listed[0].count, 1);

    // Удаление коллекции не должно уносить карты из библиотеки.
    collections::delete(&conn, col.id).unwrap();
    let all = LibraryFilter::default();
    assert_eq!(beatmaps::list(&conn, &all, 0, 50).unwrap().total, 2);
}

#[test]
fn smart_collection_applies_saved_filter() {
    let conn = db();
    beatmaps::upsert(&conn, &map(1, "A", "Low", 3.0)).unwrap();
    beatmaps::upsert(&conn, &map(2, "B", "High", 8.0)).unwrap();

    let mut saved = LibraryFilter::default();
    saved.stars = Range {
        min: Some(6.0),
        max: None,
    };
    let smart = collections::create_smart(&conn, "Сложные", None, &saved).unwrap();

    let mut f = LibraryFilter::default();
    f.collection_id = Some(smart.id);
    let page = beatmaps::list(&conn, &f, 0, 50).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].beatmap_id, 2);
}

#[test]
fn deleting_beatmap_clears_collection_link() {
    let conn = db();
    beatmaps::upsert(&conn, &map(1, "A", "One", 4.0)).unwrap();
    let col = collections::create(&conn, "Фан", None).unwrap();
    collections::add_beatmaps(&conn, col.id, &[1]).unwrap();

    beatmaps::delete(&conn, &[1]).unwrap();

    let left: i64 = conn
        .query_row("SELECT COUNT(*) FROM collection_beatmaps", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0);
}

#[test]
fn duplicate_collection_copies_contents() {
    let conn = db();
    beatmaps::upsert(&conn, &map(1, "A", "One", 4.0)).unwrap();
    beatmaps::upsert(&conn, &map(2, "B", "Two", 5.0)).unwrap();

    let col = collections::create(&conn, "Фан", None).unwrap();
    collections::add_beatmaps(&conn, col.id, &[1, 2]).unwrap();

    let copy = collections::duplicate(&conn, col.id).unwrap();
    assert_eq!(copy.count, 2);
    assert_ne!(copy.id, col.id);
}

#[test]
fn labels_are_idempotent_by_name() {
    let conn = db();
    let a = labels::create(&conn, "фан", None).unwrap();
    let b = labels::create(&conn, "ФАН", None).unwrap();
    assert_eq!(a.id, b.id);
    assert_eq!(labels::list(&conn).unwrap().len(), 1);
}

#[test]
fn auto_skillsets_reads_attributes() {
    let m = map(1, "A", "One", 6.0);
    let attr = BeatmapAttributes {
        beatmap_id: 1,
        mods: String::new(),
        star_rating: Some(6.0),
        aim_difficulty: Some(2.0),
        speed_difficulty: Some(2.6),
        slider_factor: Some(0.9),
        speed_note_count: Some(500.0),
        max_combo: Some(900),
        fetched_at: "2026-01-01T00:00:00Z".into(),
    };

    let got = beatmaps::auto_skillsets(&m, &attr);
    assert!(got.contains(&"speed".to_string()));
    assert!(got.contains(&"tech".to_string()));
    assert!(got.contains(&"stream".to_string()));
    assert!(!got.contains(&"stamina".to_string()));
}

#[test]
fn auto_skillsets_survives_zero_aim() {
    let m = map(1, "A", "One", 6.0);
    let attr = BeatmapAttributes {
        beatmap_id: 1,
        mods: String::new(),
        star_rating: None,
        aim_difficulty: Some(0.0),
        speed_difficulty: Some(3.0),
        slider_factor: None,
        speed_note_count: None,
        max_combo: None,
        fetched_at: "2026-01-01T00:00:00Z".into(),
    };
    // Деления на ноль быть не должно.
    let got = beatmaps::auto_skillsets(&m, &attr);
    assert!(!got.contains(&"speed".to_string()));
}

/// Путь правок из карточки карты: что нажали — то и лежит в базе после
/// перечитывания. Мод-теги, скилсеты и заметка правятся по отдельности и
/// не затирают друг друга.
#[test]
fn card_edits_survive_reread() {
    let conn = db();
    let mut m = map(1, "Camellia", "Ghost", 6.2);
    m.mods = vec!["NM".into()];
    m.skillsets = vec![SkillsetTag {
        skillset: "stream".into(),
        suggested: true,
    }];
    beatmaps::upsert(&conn, &m).unwrap();

    beatmaps::set_mods(&conn, 1, &["HD".into(), "DT".into()]).unwrap();
    beatmaps::set_skillsets(&conn, 1, &["speed".into(), "tech".into()]).unwrap();
    beatmaps::set_note(&conn, 1, "играли в финале").unwrap();

    let got = beatmaps::get(&conn, 1).unwrap().unwrap();

    let mut mods = got.mods.clone();
    mods.sort();
    assert_eq!(mods, vec!["DT".to_string(), "HD".to_string()]);

    let mut skills: Vec<String> = got.skillsets.iter().map(|s| s.skillset.clone()).collect();
    skills.sort();
    assert_eq!(skills, vec!["speed".to_string(), "tech".to_string()]);
    // Проставленное руками больше не считается предложенным.
    assert!(got.skillsets.iter().all(|s| !s.suggested));

    assert_eq!(got.note.as_deref(), Some("играли в финале"));

    // Снять всё — тоже правка: пустой список должен доехать до базы.
    beatmaps::set_mods(&conn, 1, &[]).unwrap();
    beatmaps::set_skillsets(&conn, 1, &[]).unwrap();
    let empty = beatmaps::get(&conn, 1).unwrap().unwrap();
    assert!(empty.mods.is_empty());
    assert!(empty.skillsets.is_empty());
    // А заметка при этом на месте.
    assert_eq!(empty.note.as_deref(), Some("играли в финале"));
}

#[test]
fn smart_collection_saves_current_filter() {
    let conn = db();
    for (i, stars) in [4.0, 6.5, 7.2].iter().enumerate() {
        let mut m = map(i as i64 + 1, "A", "T", *stars);
        m.mods = vec!["DT".into()];
        beatmaps::upsert(&conn, &m).unwrap();
    }

    let saved = LibraryFilter {
        mods: vec!["DT".into()],
        stars: Range {
            min: Some(6.0),
            max: None,
        },
        ..Default::default()
    };
    let made = collections::create_smart(&conn, "DT 6★+", None, &saved).unwrap();
    assert!(made.is_smart);

    // Заходим в умную коллекцию без других условий — работает её фильтр.
    let here = LibraryFilter {
        collection_id: Some(made.id),
        ..Default::default()
    };
    let page = beatmaps::list(&conn, &here, 0, 50).unwrap();
    assert_eq!(page.total, 2);
}

#[test]
fn adding_to_collection_is_idempotent() {
    let conn = db();
    for i in 1..=3 {
        beatmaps::upsert(&conn, &map(i, "A", "T", 5.0)).unwrap();
    }
    let c = collections::create(&conn, "Кубок", None).unwrap();

    collections::add_beatmaps(&conn, c.id, &[1, 2]).unwrap();
    // Повторное добавление той же карты не плодит дублей.
    collections::add_beatmaps(&conn, c.id, &[2, 3]).unwrap();
    assert_eq!(collections::list(&conn).unwrap()[0].count, 3);

    collections::remove_beatmaps(&conn, c.id, &[2]).unwrap();
    assert_eq!(collections::list(&conn).unwrap()[0].count, 2);

    // Убрали из коллекции — карта осталась в библиотеке.
    assert!(beatmaps::get(&conn, 2).unwrap().is_some());
}

#[test]
fn attributes_round_trip() {
    let conn = db();
    beatmaps::upsert(&conn, &map(1, "A", "One", 4.0)).unwrap();

    let attr = BeatmapAttributes {
        beatmap_id: 1,
        mods: "DT".into(),
        star_rating: Some(7.4),
        aim_difficulty: Some(3.0),
        speed_difficulty: Some(3.2),
        slider_factor: Some(0.98),
        speed_note_count: Some(320.0),
        max_combo: Some(1200),
        fetched_at: "2026-01-01T00:00:00Z".into(),
    };
    beatmaps::put_attributes(&conn, &attr).unwrap();

    // Повторная запись обновляет, а не плодит строки.
    beatmaps::put_attributes(&conn, &attr).unwrap();

    let got = beatmaps::get_attributes(&conn, 1).unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].mods, "DT");
    assert_eq!(got[0].star_rating, Some(7.4));
}

// ───────────────────────────────────────── шаблоны и генерация маппулов

use crate::db::{generate, pools, templates};
use crate::model::{GenRules, TemplateSlotInput};

fn slot_in(mod_tag: &str, count: i64, source: Option<i64>) -> TemplateSlotInput {
    TemplateSlotInput {
        mod_tag: mod_tag.into(),
        count,
        star_min: None,
        star_max: None,
        source_collection_id: source,
        required_skillsets: vec![],
    }
}

/// Карта с нужными мод-тегами: без них слот шаблона её не увидит.
fn tagged(conn: &Connection, id: i64, mapper: &str, bpm: f64, mods: &[&str]) {
    let mut m = map(id, "Artist", &format!("Map {id}"), 6.0);
    m.creator = Some(mapper.into());
    m.bpm = Some(bpm);
    m.mods = mods.iter().map(|s| s.to_string()).collect();
    beatmaps::upsert(conn, &m).unwrap();
}

#[test]
fn builtin_templates_are_seeded_once() {
    let conn = db();
    // Миграция идемпотентна: повторный запуск не должен удваивать шаблоны.
    conn.execute_batch(BUILTIN_TEMPLATES).unwrap();

    let list = templates::list(&conn).unwrap();
    assert_eq!(list.len(), 2);

    let standard = list.iter().find(|t| t.name == "Стандарт 1v1").unwrap();
    assert_eq!(standard.slots.iter().map(|s| s.count).sum::<i64>(), 12);

    let short = list.iter().find(|t| t.name == "Короткий").unwrap();
    assert_eq!(short.slots.iter().map(|s| s.count).sum::<i64>(), 7);
}

#[test]
fn template_slots_are_replaced_wholesale() {
    let conn = db();
    let t = templates::create(&conn, "Свой").unwrap();

    templates::set_slots(&conn, t.id, &[slot_in("NM", 2, None), slot_in("TB", 1, None)]).unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("HD", 1, None)]).unwrap();

    let got = templates::get(&conn, t.id).unwrap();
    assert_eq!(got.slots.len(), 1);
    assert_eq!(got.slots[0].mod_tag, "HD");
    assert_eq!(got.slots[0].position, 0);
}

#[test]
fn template_supply_counts_maps_per_slot() {
    let conn = db();
    for id in 1..=3 {
        tagged(&conn, id, "mapper", 180.0, &["NM"]);
    }
    tagged(&conn, 10, "other", 180.0, &["HD"]);

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 4, None), slot_in("HD", 1, None)]).unwrap();

    let supply = templates::supply(&conn, t.id).unwrap();
    assert_eq!(supply[0].need, 4);
    assert_eq!(supply[0].available, 3);
    assert_eq!(supply[1].available, 1);
}

#[test]
fn generated_pool_fills_every_slot_without_repeats() {
    let conn = db();
    for id in 1..=6 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM", "TB"]);
    }

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 4, None), slot_in("TB", 1, None)]).unwrap();

    let report = generate::generate(&conn, t.id, "Тир 2").unwrap();
    assert!(
        report.notes.is_empty(),
        "заметок быть не должно: {:?}",
        report.notes
    );
    assert_eq!(report.pool.slots.len(), 5);
    assert!(report.pool.slots.iter().all(|s| s.beatmap_id.is_some()));

    // Одна карта — один слот.
    let ids: Vec<i64> = report
        .pool
        .slots
        .iter()
        .filter_map(|s| s.beatmap_id)
        .collect();
    let unique: std::collections::HashSet<i64> = ids.iter().copied().collect();
    assert_eq!(ids.len(), unique.len());

    // TB всегда последний и ровно один.
    assert_eq!(report.pool.slots.last().unwrap().slot_label, "TB");
    assert_eq!(
        report
            .pool
            .slots
            .iter()
            .filter(|s| s.mod_tag == "TB")
            .count(),
        1
    );
    assert_eq!(report.pool.slots[0].slot_label, "NM1");
    assert_eq!(report.pool.slots[3].slot_label, "NM4");
}

#[test]
fn generation_reports_when_maps_run_out() {
    let conn = db();
    tagged(&conn, 1, "mapper", 180.0, &["NM"]);

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 3, None)]).unwrap();

    let report = generate::generate(&conn, t.id, "Пул").unwrap();
    // Молча отдать пул с дырками нельзя — пользователь должен узнать причину.
    assert_eq!(report.notes.len(), 1);
    assert!(report.notes[0].contains("NM2"));
    assert!(report.pool.slots[0].beatmap_id.is_some());
    assert!(report.pool.slots[1].beatmap_id.is_none());
}

#[test]
fn no_repeat_mapper_limits_one_map_per_mapper() {
    let conn = db();
    // Четыре карты, но мапперов двое.
    tagged(&conn, 1, "alice", 180.0, &["NM"]);
    tagged(&conn, 2, "alice", 180.0, &["NM"]);
    tagged(&conn, 3, "bob", 180.0, &["NM"]);
    tagged(&conn, 4, "bob", 180.0, &["NM"]);

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 4, None)]).unwrap();
    templates::set_rules(
        &conn,
        t.id,
        &GenRules {
            no_repeat_mapper: true,
            ..GenRules::default()
        },
    )
    .unwrap();

    let report = generate::generate(&conn, t.id, "Пул").unwrap();
    let filled = report
        .pool
        .slots
        .iter()
        .filter(|s| s.beatmap_id.is_some())
        .count();
    assert_eq!(filled, 2, "маппер не должен повторяться");
    assert!(!report.notes.is_empty());
}

#[test]
fn no_repeat_from_pools_excludes_played_maps() {
    let conn = db();
    for id in 1..=4 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM"]);
    }

    // Прошлый маппул турнира: карты 1 и 2 уже игрались.
    let old = pools::create(&conn, "Прошлый", None).unwrap();
    pools::add_slot(&conn, old, "NM").unwrap();
    pools::add_slot(&conn, old, "NM").unwrap();
    let slots = pools::get(&conn, old).unwrap().slots;
    pools::set_slot_beatmap(&conn, slots[0].id, Some(1)).unwrap();
    pools::set_slot_beatmap(&conn, slots[1].id, Some(2)).unwrap();

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 2, None)]).unwrap();
    templates::set_rules(
        &conn,
        t.id,
        &GenRules {
            no_repeat_from_pools: vec![old],
            ..GenRules::default()
        },
    )
    .unwrap();

    let report = generate::generate(&conn, t.id, "Новый").unwrap();
    let ids: Vec<i64> = report
        .pool
        .slots
        .iter()
        .filter_map(|s| s.beatmap_id)
        .collect();
    assert_eq!(ids.len(), 2);
    assert!(ids.iter().all(|id| *id == 3 || *id == 4));
}

#[test]
fn min_bpm_spread_pulls_tempos_apart() {
    let conn = db();
    // Три карты рядом по темпу и одна далеко: разброс достижим только с ней.
    tagged(&conn, 1, "a", 180.0, &["NM"]);
    tagged(&conn, 2, "b", 182.0, &["NM"]);
    tagged(&conn, 3, "c", 184.0, &["NM"]);
    tagged(&conn, 4, "d", 240.0, &["NM"]);

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 2, None)]).unwrap();
    templates::set_rules(
        &conn,
        t.id,
        &GenRules {
            min_bpm_spread: Some(50.0),
            ..GenRules::default()
        },
    )
    .unwrap();

    let report = generate::generate(&conn, t.id, "Пул").unwrap();
    let ids: Vec<i64> = report
        .pool
        .slots
        .iter()
        .filter_map(|s| s.beatmap_id)
        .collect();
    assert!(ids.contains(&4), "быстрая карта должна попасть в пул: {ids:?}");
    assert!(
        report.notes.is_empty(),
        "разброс достижим: {:?}",
        report.notes
    );
}

#[test]
fn unreachable_bpm_spread_is_reported_not_hidden() {
    let conn = db();
    tagged(&conn, 1, "a", 180.0, &["NM"]);
    tagged(&conn, 2, "b", 182.0, &["NM"]);

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 2, None)]).unwrap();
    templates::set_rules(
        &conn,
        t.id,
        &GenRules {
            min_bpm_spread: Some(100.0),
            ..GenRules::default()
        },
    )
    .unwrap();

    let report = generate::generate(&conn, t.id, "Пул").unwrap();
    assert!(report.notes.iter().any(|n| n.contains("Разброс BPM")));
}

#[test]
fn reroll_keeps_pinned_slots() {
    let conn = db();
    for id in 1..=8 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM"]);
    }

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 3, None)]).unwrap();

    let first = generate::generate(&conn, t.id, "Пул").unwrap().pool;
    let pinned_map = first.slots[0].beatmap_id;
    pools::set_slot_pinned(&conn, first.slots[0].id, true).unwrap();

    let after = generate::reroll(&conn, first.id, true).unwrap().pool;
    assert_eq!(after.slots[0].beatmap_id, pinned_map);
    assert!(after.slots[0].pinned);
}

#[test]
fn reroll_slot_touches_only_that_slot() {
    let conn = db();
    for id in 1..=8 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM"]);
    }

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 3, None)]).unwrap();

    let before = generate::generate(&conn, t.id, "Пул").unwrap().pool;
    let untouched: Vec<Option<i64>> = before.slots[1..].iter().map(|s| s.beatmap_id).collect();

    let after = generate::reroll_slot(&conn, before.id, before.slots[0].id)
        .unwrap()
        .pool;

    let still: Vec<Option<i64>> = after.slots[1..].iter().map(|s| s.beatmap_id).collect();
    assert_eq!(untouched, still, "остальные слоты меняться не должны");
    assert!(after.slots[0].beatmap_id.is_some());
}

#[test]
fn editing_played_pool_makes_a_new_version() {
    let conn = db();
    tagged(&conn, 1, "a", 180.0, &["NM"]);

    let id = pools::create(&conn, "Финал", None).unwrap();
    pools::add_slot(&conn, id, "NM").unwrap();
    let slot = pools::get(&conn, id).unwrap().slots[0].id;
    pools::set_slot_beatmap(&conn, slot, Some(1)).unwrap();

    // Замок ставит матч, в котором пул сыграли.
    conn.execute("UPDATE pools SET is_locked = 1 WHERE id = ?1", [id])
        .unwrap();

    let target = pools::writable(&conn, id).unwrap();
    assert_ne!(target, id, "сыгранный пул должен копироваться, а не меняться");

    let copy = pools::get(&conn, target).unwrap();
    assert_eq!(copy.version, 2);
    assert_eq!(copy.parent_pool_id, Some(id));
    assert_eq!(copy.name, "Финал");
    assert!(!copy.is_locked);

    // Оригинал остался нетронутым.
    let original = pools::get(&conn, id).unwrap();
    assert_eq!(original.slots[0].beatmap_id, Some(1));
    assert_eq!(original.version, 1);
}

#[test]
fn slot_labels_renumber_after_removal() {
    let conn = db();
    let id = pools::create(&conn, "Пул", None).unwrap();
    for _ in 0..3 {
        pools::add_slot(&conn, id, "NM").unwrap();
    }
    pools::add_slot(&conn, id, "TB").unwrap();

    let labels: Vec<String> = pools::get(&conn, id)
        .unwrap()
        .slots
        .iter()
        .map(|s| s.slot_label.clone())
        .collect();
    assert_eq!(labels, vec!["NM1", "NM2", "NM3", "TB"]);

    // Убрали средний — номера не должны оставить дырку.
    pools::remove_slot(&conn, id, 1).unwrap();
    let labels: Vec<String> = pools::get(&conn, id)
        .unwrap()
        .slots
        .iter()
        .map(|s| s.slot_label.clone())
        .collect();
    assert_eq!(labels, vec!["NM1", "NM2", "TB"]);
}

#[test]
fn tiebreaker_stays_last_after_reorder() {
    let conn = db();
    let id = pools::create(&conn, "Пул", None).unwrap();
    pools::add_slot(&conn, id, "NM").unwrap();
    pools::add_slot(&conn, id, "TB").unwrap();
    pools::add_slot(&conn, id, "HD").unwrap();

    // Пробуем утащить TB в начало.
    pools::reorder(&conn, id, &[1, 0, 2]).unwrap();

    let labels: Vec<String> = pools::get(&conn, id)
        .unwrap()
        .slots
        .iter()
        .map(|s| s.slot_label.clone())
        .collect();
    assert_eq!(labels.last().unwrap(), "TB");
}

#[test]
fn pool_warnings_catch_duplicates_and_wrong_mod() {
    let conn = db();
    tagged(&conn, 1, "alice", 180.0, &["NM"]);
    tagged(&conn, 2, "alice", 180.0, &["NM"]);

    let id = pools::create(&conn, "Пул", None).unwrap();
    pools::add_slot(&conn, id, "NM").unwrap();
    pools::add_slot(&conn, id, "NM").unwrap();
    pools::add_slot(&conn, id, "HD").unwrap();

    let slots = pools::get(&conn, id).unwrap().slots;
    pools::set_slot_beatmap(&conn, slots[0].id, Some(1)).unwrap();
    pools::set_slot_beatmap(&conn, slots[1].id, Some(1)).unwrap();
    pools::set_slot_beatmap(&conn, slots[2].id, Some(2)).unwrap();

    let pool = pools::get(&conn, id).unwrap();
    assert!(pool.slots[0]
        .warnings
        .iter()
        .any(|w| w.contains("другом слоте")));
    // Карта 2 разрешена только в NM, а стоит в слоте HD.
    assert!(pool.slots[2].warnings.iter().any(|w| w.contains("HD")));
    // Маппер один на все три слота.
    assert!(pool.slots[2].warnings.iter().any(|w| w.contains("маппер")));
}

#[test]
fn smart_collection_works_as_slot_source() {
    let conn = db();
    tagged(&conn, 1, "a", 180.0, &["NM"]);
    tagged(&conn, 2, "b", 180.0, &["NM"]);
    let mut hard = map(3, "Artist", "Hard", 9.0);
    hard.creator = Some("c".into());
    hard.mods = vec!["NM".into()];
    beatmaps::upsert(&conn, &hard).unwrap();

    // Умная коллекция «от 8★» — состав задан фильтром, а не таблицей связей.
    let smart = collections::create_smart(
        &conn,
        "Топ",
        None,
        &LibraryFilter {
            stars: Range {
                min: Some(8.0),
                max: None,
            },
            ..LibraryFilter::default()
        },
    )
    .unwrap();

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 1, Some(smart.id))]).unwrap();

    let report = generate::generate(&conn, t.id, "Пул").unwrap();
    assert_eq!(report.pool.slots[0].beatmap_id, Some(3));
}
