//! Тесты слоя базы: схема, фильтрация, коллекции, метки.
//!
//! Каждый тест поднимает свою базу в памяти — состояние между ними не течёт.

use rusqlite::Connection;

use crate::db::{beatmaps, collections, labels, matches, players, tournaments};
use crate::model::{
    Beatmap, BeatmapAttributes, ByRound, LibraryFilter, Phase, Range, RowState, SkillsetTag,
};

const SCHEMA: &str = include_str!("schema.sql");
const BUILTIN_TEMPLATES: &str = include_str!("migrations/002_builtin_templates.sql");
const SERIES: &str = include_str!("migrations/003_series_sources_exclusions.sql");
const EDITOR: &str = include_str!("migrations/004_tournament_editor.sql");

fn db() -> Connection {
    let conn = Connection::open_in_memory().expect("база в памяти");
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    conn.execute_batch(SCHEMA).expect("схема применилась");
    conn.execute_batch(BUILTIN_TEMPLATES)
        .expect("шаблоны из коробки применились");
    conn.execute_batch(SERIES).expect("серии применились");
    conn.execute_batch(EDITOR).expect("редактор турниров применился");
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

/// Раздел «Без мод-тегов» — второе системное место библиотеки. Состав у него
/// считается сам, и карта уходит из него ровно тогда, когда ей проставили тег.
#[test]
fn untagged_place_holds_maps_until_they_get_a_mod() {
    let conn = db();

    let mut bare = map(1, "A", "Без тегов", 5.0);
    bare.mods = vec![];
    beatmaps::upsert(&conn, &bare).unwrap();
    // map() по умолчанию отдаёт карту с NM — она сюда попасть не должна.
    beatmaps::upsert(&conn, &map(2, "B", "С тегом", 6.0)).unwrap();

    let f = LibraryFilter {
        no_mods: true,
        ..Default::default()
    };
    let page = beatmaps::list(&conn, &f, 0, 50).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].beatmap_id, 1);
    assert_eq!(beatmaps::count_without_mods(&conn).unwrap(), 1);

    // Проставили тег — карта уехала из раздела и из его счётчика.
    beatmaps::set_mods(&conn, 1, &["HD".into()]).unwrap();
    assert_eq!(beatmaps::list(&conn, &f, 0, 50).unwrap().total, 0);
    assert_eq!(beatmaps::count_without_mods(&conn).unwrap(), 0);

    // Сняли все теги — вернулась обратно.
    beatmaps::set_mods(&conn, 1, &[]).unwrap();
    assert_eq!(beatmaps::count_without_mods(&conn).unwrap(), 1);
}

/// Раздел совмещается с остальными условиями фильтра: внутри него можно
/// искать и сужать по звёздам, не выходя наружу.
#[test]
fn untagged_place_combines_with_filter() {
    let conn = db();
    for (id, stars) in [(1, 3.0), (2, 7.0)] {
        let mut m = map(id, "A", &format!("Map {id}"), stars);
        m.mods = vec![];
        beatmaps::upsert(&conn, &m).unwrap();
    }

    let f = LibraryFilter {
        no_mods: true,
        stars: Range {
            min: Some(6.0),
            max: None,
        },
        ..Default::default()
    };
    let page = beatmaps::list(&conn, &f, 0, 50).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].beatmap_id, 2);
}

// ───────────────────────────────────────── шаблоны и генерация маппулов

use crate::db::exclusions::Owner;
use crate::db::{exclusions, generate, pools, series, sources, supply, templates};
use crate::model::{ExclusionTarget, GenRules, Source, SourceSet, TemplateSlotInput};

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
fn summary_describes_what_is_on_screen() {
    let conn = db();
    tagged(&conn, 1, "a", 180.0, &["NM"]);
    tagged(&conn, 2, "b", 200.0, &["NM", "HD"]);
    tagged(&conn, 3, "c", 150.0, &["HD"]);
    // Карта без тегов: в разбивку по модам не попадёт, но в общий счёт — да.
    let mut bare = map(4, "Artist", "Map 4", 6.0);
    bare.mods = vec![];
    beatmaps::upsert(&conn, &bare).unwrap();

    let got = beatmaps::summary(&conn, &LibraryFilter::default()).unwrap();

    assert_eq!(got.total, 4);
    assert_eq!(got.untagged, 1);
    // Карта с двумя тегами считается в обоих: сумма по модам законно
    // больше числа карт.
    let nm = got.by_mod.iter().find(|m| m.mod_tag == "NM").unwrap();
    let hd = got.by_mod.iter().find(|m| m.mod_tag == "HD").unwrap();
    assert_eq!(nm.count, 2);
    assert_eq!(hd.count, 2);

    assert_eq!(got.bpm_min, Some(150.0));
    assert_eq!(got.bpm_max, Some(200.0));
    assert_eq!(got.stars_min, Some(6.0));
}

#[test]
fn summary_follows_the_filter() {
    let conn = db();
    tagged(&conn, 1, "a", 180.0, &["NM"]);
    tagged(&conn, 2, "b", 200.0, &["HD"]);

    let filter = LibraryFilter {
        mods: vec!["HD".to_string()],
        ..Default::default()
    };

    // Сводка должна описывать выдачу, а не всю библиотеку: иначе она
    // рассказывала бы не о том, что человек видит.
    let got = beatmaps::summary(&conn, &filter).unwrap();
    assert_eq!(got.total, 1);
    assert_eq!(got.bpm_min, Some(200.0));
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
fn series_never_repeats_a_map_across_its_pools() {
    let conn = db();
    // Девять карт на три пула по три слота — хватает ровно впритык.
    for id in 1..=9 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM", "TB"]);
    }

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 2, None), slot_in("TB", 1, None)]).unwrap();

    let reports = generate::generate_series(&conn, t.id, "Осень", 3).unwrap();
    assert_eq!(reports.len(), 3);

    let mut seen = std::collections::HashSet::new();
    for r in &reports {
        for slot in &r.pool.slots {
            let id = slot.beatmap_id.expect("карт должно хватить на все слоты");
            assert!(
                seen.insert(id),
                "карта {id} попала в два маппула одного турнира"
            );
        }
    }
    assert_eq!(seen.len(), 9);
}

#[test]
fn series_reports_when_library_runs_dry() {
    let conn = db();
    // Карт на два пула не хватает: во втором останутся пустые слоты.
    for id in 1..=4 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM", "TB"]);
    }

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 2, None), slot_in("TB", 1, None)]).unwrap();

    let reports = generate::generate_series(&conn, t.id, "Осень", 2).unwrap();

    let second = &reports[1];
    assert!(
        second.notes.iter().any(|n| n.strict && n.text.contains("пустой")),
        "о нехватке карт надо сказать, а не молча оставить пустые слоты: {:?}",
        second.notes
    );
    assert!(
        second
            .notes
            .iter()
            .any(|n| n.blockers.iter().any(|b| b.reason.contains("серии"))),
        "в отчёте должно быть видно, что карты забрали соседние пулы серии: {:?}",
        second.notes
    );
}

#[test]
fn overlapping_maps_between_pools_are_found() {
    let conn = db();
    for id in 1..=3 {
        tagged(&conn, id, "mapper", 180.0, &["NM"]);
    }

    // Одну и ту же карту кладём в два разных пула — так бывает, когда
    // маппулы собирали руками в разное время.
    let first = pools::create(&conn, "Раунд 1", None).unwrap();
    let second = pools::create(&conn, "Раунд 2", None).unwrap();
    for pool in [first, second] {
        pools::add_slot(&conn, pool, "NM").unwrap();
        let slots = pools::get(&conn, pool).unwrap().slots;
        pools::set_slot_beatmap(&conn, slots[0].id, Some(1)).unwrap();
    }

    let found = pools::overlaps_between_pools(&conn, &[first, second]).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].beatmap_id, 1);
    assert_eq!(found[0].pools.len(), 2);

    // Один пул сам с собой не пересекается.
    assert!(pools::overlaps_between_pools(&conn, &[first]).unwrap().is_empty());
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

    let rows = supply::template_supply(&conn, t.id).unwrap();
    assert_eq!(rows[0].need, 4);
    assert_eq!(rows[0].available, 3);
    assert_eq!(rows[1].available, 1);
    // Мод-тег — первый отсекатель: под HD подходит одна карта из четырёх.
    assert!(rows[1]
        .blockers
        .iter()
        .any(|b| b.reason.contains("мод-тегом HD")));
}

#[test]
fn generated_pool_fills_every_slot_without_repeats() {
    let conn = db();
    for id in 1..=6 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM", "TB"]);
    }

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 4, None), slot_in("TB", 1, None)]).unwrap();

    let report = generate::generate(&conn, t.id, "Тир 2", None).unwrap();
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

    let report = generate::generate(&conn, t.id, "Пул", None).unwrap();
    // Молча отдать пул с дырками нельзя — пользователь должен узнать причину.
    // Заметка на каждый пустой слот: их адрес и есть половина ответа.
    assert_eq!(report.notes.len(), 2);
    let places: Vec<&str> = report
        .notes
        .iter()
        .filter_map(|n| n.slot_label.as_deref())
        .collect();
    assert_eq!(places, vec!["NM2", "NM3"]);
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
    exclusions::add(
        &conn,
        Owner::Template(t.id),
        &ExclusionTarget::SameMapperInside,
        true,
    )
    .unwrap();

    let report = generate::generate(&conn, t.id, "Пул", None).unwrap();
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
    exclusions::add(
        &conn,
        Owner::Template(t.id),
        &ExclusionTarget::Pool { id: old },
        true,
    )
    .unwrap();

    let report = generate::generate(&conn, t.id, "Новый", None).unwrap();
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

    let report = generate::generate(&conn, t.id, "Пул", None).unwrap();
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

    let report = generate::generate(&conn, t.id, "Пул", None).unwrap();
    assert!(report.notes.iter().any(|n| n.text.contains("разброс BPM")));
}

#[test]
fn reroll_keeps_pinned_slots() {
    let conn = db();
    for id in 1..=8 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM"]);
    }

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 3, None)]).unwrap();

    let first = generate::generate(&conn, t.id, "Пул", None).unwrap().pool;
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

    let before = generate::generate(&conn, t.id, "Пул", None).unwrap().pool;
    let untouched: Vec<Option<i64>> = before.slots[1..].iter().map(|s| s.beatmap_id).collect();

    let after = generate::reroll_slots(&conn, before.id, &[before.slots[0].position])
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
    pools::remove_slots(&conn, id, &[1]).unwrap();
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
    // Дубль называет слот, в котором карта уже стоит, — иначе искать его глазами.
    assert!(pool.slots[0]
        .warnings
        .iter()
        .any(|w| w.strict && w.text.contains("уже стоит в NM2")));
    // Карта 2 разрешена только в NM, а стоит в слоте HD.
    assert!(pool.slots[2]
        .warnings
        .iter()
        .any(|w| w.strict && w.text.contains("мод-тега HD")));
    // Маппер один на все три слота — это мягкое замечание, а не ошибка.
    assert!(pool.slots[2]
        .warnings
        .iter()
        .any(|w| !w.strict && w.text.contains("alice")));
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

    let report = generate::generate(&conn, t.id, "Пул", None).unwrap();
    assert_eq!(report.pool.slots[0].beatmap_id, Some(3));
}

// ────────────────────────────────── серии, источники и исключения

/// Коллекция с готовым составом — самый частый источник.
fn collection_of(conn: &Connection, name: &str, ids: &[i64]) -> i64 {
    let c = collections::create(conn, name, None).unwrap();
    collections::add_beatmaps(conn, c.id, ids).unwrap();
    c.id
}

fn set_of(items: Vec<Source>, mode: &str) -> SourceSet {
    SourceSet {
        items,
        mode: mode.into(),
    }
}

#[test]
fn old_rules_move_into_exclusions_on_migration() {
    // Шаблон со старыми правилами — как он лежал до третьей версии схемы.
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn.execute(
        "INSERT INTO pool_templates (id, name, rules, is_builtin, created_at)
         VALUES (7, 'Старый', '{\"noRepeatMapper\":true,\"noRepeatFromPools\":[3,4]}', 0, 'x')",
        [],
    )
    .unwrap();

    conn.execute_batch(SERIES).unwrap();

    let list = exclusions::raw_list(&conn, Owner::Template(7)).unwrap();
    assert!(
        list.iter()
            .any(|e| e.target == ExclusionTarget::SameMapperInside),
        "«не повторять маппера» должно переехать в исключения: {list:?}"
    );
    let pools_banned: Vec<i64> = list
        .iter()
        .filter_map(|e| match e.target {
            ExclusionTarget::Pool { id } => Some(id),
            _ => None,
        })
        .collect();
    assert_eq!(pools_banned, vec![3, 4]);

    // Из правил они должны исчезнуть: одно условие в двух местах разойдётся.
    let rules: String = conn
        .query_row("SELECT rules FROM pool_templates WHERE id = 7", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(!rules.contains("noRepeatMapper"), "осталось в правилах: {rules}");
    assert!(!rules.contains("noRepeatFromPools"));
}

#[test]
fn ordered_sources_take_from_the_first_one_first() {
    let conn = db();
    for id in 1..=4 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM"]);
    }
    let trusted = collection_of(&conn, "Проверенные", &[1, 2]);

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 2, None)]).unwrap();
    templates::set_sources(
        &conn,
        t.id,
        Some(&set_of(
            vec![Source::Collection { id: trusted }, Source::Library],
            "ordered",
        )),
    )
    .unwrap();

    let report = generate::generate(&conn, t.id, "Пул", None).unwrap();
    let mut ids: Vec<i64> = report
        .pool
        .slots
        .iter()
        .filter_map(|s| s.beatmap_id)
        .collect();
    ids.sort_unstable();
    assert_eq!(
        ids,
        vec![1, 2],
        "оба слота должны закрыться проверенными, добор из библиотеки не нужен"
    );
}

#[test]
fn ordered_sources_fall_through_when_the_first_runs_out() {
    let conn = db();
    for id in 1..=4 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM"]);
    }
    let trusted = collection_of(&conn, "Проверенные", &[1]);

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 3, None)]).unwrap();
    templates::set_sources(
        &conn,
        t.id,
        Some(&set_of(
            vec![Source::Collection { id: trusted }, Source::Library],
            "ordered",
        )),
    )
    .unwrap();

    let report = generate::generate(&conn, t.id, "Пул", None).unwrap();
    let ids: Vec<i64> = report
        .pool
        .slots
        .iter()
        .filter_map(|s| s.beatmap_id)
        .collect();
    assert_eq!(ids.len(), 3, "добор из библиотеки должен закрыть остальные");
    assert!(ids.contains(&1), "карта из первого источника обязана попасть");
}

#[test]
fn slot_sources_win_over_the_pool_and_the_series() {
    let conn = db();
    for id in 1..=4 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM"]);
    }
    let only_four = collection_of(&conn, "Только четвёртая", &[4]);
    let first_two = collection_of(&conn, "Первые две", &[1, 2]);

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 2, None)]).unwrap();

    let report = generate::generate(&conn, t.id, "Пул", None).unwrap();
    let pool_id = report.pool.id;
    pools::set_sources(
        &conn,
        pool_id,
        Some(&set_of(vec![Source::Collection { id: first_two }], "union")),
    )
    .unwrap();

    // Второму слоту задали свой источник — он и должен победить.
    let slots = pools::get(&conn, pool_id).unwrap().slots;
    pools::set_slots_sources(
        &conn,
        pool_id,
        &[slots[1].position],
        Some(&set_of(vec![Source::Collection { id: only_four }], "union")),
    )
    .unwrap();

    let after = generate::reroll(&conn, pool_id, false).unwrap().pool;
    assert_eq!(after.slots[1].beatmap_id, Some(4));
    assert!(matches!(after.slots[0].beatmap_id, Some(1) | Some(2)));
}

#[test]
fn narrow_slot_picks_before_the_wide_one() {
    let conn = db();
    // Единственная HD-карта разрешена и в NM: если первым выберет NM,
    // HD останется пустым — а он и есть узкий слот.
    tagged(&conn, 1, "a", 180.0, &["NM", "HD"]);
    tagged(&conn, 2, "b", 180.0, &["NM"]);

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 1, None), slot_in("HD", 1, None)]).unwrap();

    for _ in 0..5 {
        let report = generate::generate(&conn, t.id, "Пул", None).unwrap();
        assert_eq!(
            report.pool.slots[1].beatmap_id,
            Some(1),
            "узкий слот должен выбирать первым: {:?}",
            report.notes
        );
        assert_eq!(report.pool.slots[0].beatmap_id, Some(2));
    }
}

#[test]
fn soft_exclusion_fills_the_slot_and_says_so() {
    let conn = db();
    tagged(&conn, 1, "a", 180.0, &["NM"]);

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 1, None)]).unwrap();
    exclusions::add(
        &conn,
        Owner::Template(t.id),
        &ExclusionTarget::Beatmaps { ids: vec![1] },
        false,
    )
    .unwrap();

    let report = generate::generate(&conn, t.id, "Пул", None).unwrap();
    assert_eq!(
        report.pool.slots[0].beatmap_id,
        Some(1),
        "мягкое правило не запрещает, а предупреждает"
    );
    assert!(report
        .notes
        .iter()
        .any(|n| !n.strict && n.text.contains("нарушением")));
}

#[test]
fn strict_exclusion_leaves_the_slot_empty_with_numbers() {
    let conn = db();
    tagged(&conn, 1, "a", 180.0, &["NM"]);
    tagged(&conn, 2, "b", 180.0, &["NM"]);

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 1, None)]).unwrap();
    exclusions::add(
        &conn,
        Owner::Template(t.id),
        &ExclusionTarget::Beatmaps { ids: vec![1, 2] },
        true,
    )
    .unwrap();

    let report = generate::generate(&conn, t.id, "Пул", None).unwrap();
    assert!(report.pool.slots[0].beatmap_id.is_none());

    let note = report
        .notes
        .iter()
        .find(|n| n.slot_label.as_deref() == Some("NM1"))
        .expect("о пустом слоте надо сказать");
    assert!(note.strict);
    // Не «мало карт», а сколько именно и что отсекло.
    let cut: i64 = note.blockers.iter().map(|b| b.cut).sum();
    assert_eq!(cut, 2, "цифры должны сходиться: {:?}", note.blockers);
}

#[test]
fn disabled_exclusion_stops_applying() {
    let conn = db();
    tagged(&conn, 1, "a", 180.0, &["NM"]);

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 1, None)]).unwrap();
    let ex = exclusions::add(
        &conn,
        Owner::Template(t.id),
        &ExclusionTarget::Beatmaps { ids: vec![1] },
        true,
    )
    .unwrap();

    assert!(generate::generate(&conn, t.id, "Пул", None)
        .unwrap()
        .pool
        .slots[0]
        .beatmap_id
        .is_none());

    exclusions::set_enabled(&conn, ex, false).unwrap();
    assert_eq!(
        generate::generate(&conn, t.id, "Пул", None)
            .unwrap()
            .pool
            .slots[0]
            .beatmap_id,
        Some(1)
    );
}

#[test]
fn exclusion_on_a_deleted_pool_is_marked_not_dropped() {
    let conn = db();
    tagged(&conn, 1, "a", 180.0, &["NM"]);
    let gone = pools::create(&conn, "Удалённый", None).unwrap();

    let t = templates::create(&conn, "Свой").unwrap();
    exclusions::add(
        &conn,
        Owner::Template(t.id),
        &ExclusionTarget::Pool { id: gone },
        true,
    )
    .unwrap();
    pools::delete(&conn, gone).unwrap();

    let list = templates::get(&conn, t.id).unwrap().exclusions;
    assert_eq!(list.len(), 1, "правило не должно исчезать незаметно");
    assert!(list[0].missing);
    assert!(list[0].label.contains("удалён"));
}

#[test]
fn series_exclusion_reaches_every_pool_inside() {
    let conn = db();
    for id in 1..=3 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM"]);
    }

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 1, None)]).unwrap();

    let sid = series::create(&conn, "Осень", "tournament").unwrap();
    exclusions::add(
        &conn,
        Owner::Series(sid),
        &ExclusionTarget::Beatmaps { ids: vec![1, 2] },
        true,
    )
    .unwrap();

    let report = generate::generate(&conn, t.id, "Раунд 1", Some(sid)).unwrap();
    assert_eq!(report.pool.slots[0].beatmap_id, Some(3));

    // В панели пула оно видно как унаследованное, а не как своё.
    let whence = generate::whence(&conn, report.pool.id).unwrap();
    let inherited = whence
        .exclusions
        .iter()
        .find(|e| e.inherited_from.is_some())
        .expect("исключение серии должно быть видно в пуле");
    assert!(inherited.inherited_from.as_deref().unwrap().contains("Осень"));
    assert_eq!(inherited.cut, 2);
}

#[test]
fn round_labels_follow_the_order_but_hand_set_ones_stay() {
    let conn = db();
    for id in 1..=6 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM"]);
    }

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 1, None)]).unwrap();

    let sid = series::create(&conn, "Осень", "tournament").unwrap();
    let a = generate::generate(&conn, t.id, "Первый", Some(sid)).unwrap().pool.id;
    let b = generate::generate(&conn, t.id, "Второй", Some(sid)).unwrap().pool.id;
    let c = generate::generate(&conn, t.id, "Третий", Some(sid)).unwrap().pool.id;

    let labels = |conn: &rusqlite::Connection| -> Vec<String> {
        series::get(conn, sid)
            .unwrap()
            .pools
            .into_iter()
            .map(|p| p.label.unwrap_or_default())
            .collect()
    };
    assert_eq!(labels(&conn), ["раунд 1", "раунд 2", "раунд 3"]);

    // Перетащили последний в начало: номера обязаны пересчитаться, иначе
    // перестановка выглядит так, будто ничего не произошло.
    series::reorder_pools(&conn, sid, &[c, a, b]).unwrap();
    assert_eq!(labels(&conn), ["раунд 1", "раунд 2", "раунд 3"]);
    assert_eq!(
        pools::get(&conn, c).unwrap().series_label.as_deref(),
        Some("раунд 1"),
        "пул, ставший первым, должен зваться первым раундом"
    );

    // А своё название держится за пулом, куда его ни переставь.
    series::set_pool_label(&conn, b, Some("полуфинал")).unwrap();
    series::reorder_pools(&conn, sid, &[b, c, a]).unwrap();
    assert_eq!(labels(&conn), ["полуфинал", "раунд 2", "раунд 3"]);

    // Пустая строка возвращает метку к автоматической.
    series::set_pool_label(&conn, b, None).unwrap();
    assert_eq!(labels(&conn), ["раунд 1", "раунд 2", "раунд 3"]);
}

#[test]
fn reroll_does_not_lock_the_pool_out_with_its_own_maps() {
    // Пул исключает свою же серию — так делают, чтобы не повторять карты
    // прошлых раундов. Перекат при этом должен работать: карты, которые
    // снимаются со слотов, снова свободны.
    let conn = db();
    for id in 1..=3 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM"]);
    }

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 1, None)]).unwrap();

    let sid = series::create(&conn, "Осень", "free").unwrap();
    let report = generate::generate(&conn, t.id, "Раунд 1", Some(sid)).unwrap();
    let pool_id = report.pool.id;
    assert!(report.pool.slots[0].beatmap_id.is_some());

    exclusions::add(
        &conn,
        Owner::Pool(pool_id),
        &ExclusionTarget::Series { id: sid },
        true,
    )
    .unwrap();

    let again = generate::reroll(&conn, pool_id, false).unwrap();
    assert!(
        again.pool.slots[0].beatmap_id.is_some(),
        "перекат опустошил пул его же прошлым составом: {:?}",
        again.notes
    );
}

#[test]
fn series_pools_do_not_share_maps() {
    let conn = db();
    for id in 1..=4 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM"]);
    }

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 2, None)]).unwrap();

    let reports = generate::generate_series(&conn, t.id, "Осень", 2).unwrap();
    let mut all: Vec<i64> = reports
        .iter()
        .flat_map(|r| r.pool.slots.iter().filter_map(|s| s.beatmap_id))
        .collect();
    all.sort_unstable();
    assert_eq!(all, vec![1, 2, 3, 4]);

    // Метки раундов подставляются сами и держат порядок.
    let series = series::get(&conn, reports[0].pool.series_id.unwrap()).unwrap();
    let labels: Vec<Option<String>> = series.pools.iter().map(|p| p.label.clone()).collect();
    assert_eq!(
        labels,
        vec![Some("раунд 1".to_string()), Some("раунд 2".to_string())]
    );
}

#[test]
fn rolling_the_whole_series_frees_maps_first() {
    let conn = db();
    for id in 1..=4 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM"]);
    }

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 2, None)]).unwrap();
    let reports = generate::generate_series(&conn, t.id, "Осень", 2).unwrap();
    let sid = reports[0].pool.series_id.unwrap();

    // Карт ровно на два пула: без освобождения первый пул считал бы занятыми
    // карты второго и остался бы с дырками.
    let again = generate::roll_series(&conn, sid, false).unwrap();
    for r in &again {
        assert!(
            r.pool.slots.iter().all(|s| s.beatmap_id.is_some()),
            "все слоты должны закрыться: {:?}",
            r.notes
        );
    }
    let mut all: Vec<i64> = again
        .iter()
        .flat_map(|r| r.pool.slots.iter().filter_map(|s| s.beatmap_id))
        .collect();
    all.sort_unstable();
    assert_eq!(all, vec![1, 2, 3, 4]);
}

#[test]
fn free_series_allows_repeats_tournament_one_does_not() {
    let conn = db();
    tagged(&conn, 1, "a", 180.0, &["NM"]);

    let sid = series::create(&conn, "Любимые", "free").unwrap();
    series::set_no_repeat_inside(&conn, sid, false).unwrap();

    let first = pools::create(&conn, "Пул 1", None).unwrap();
    let second = pools::create(&conn, "Пул 2", None).unwrap();
    for id in [first, second] {
        pools::add_slot(&conn, id, "NM").unwrap();
        let slot = pools::get(&conn, id).unwrap().slots[0].id;
        pools::set_slot_beatmap(&conn, slot, Some(1)).unwrap();
        assert!(series::add_pool(&conn, sid, id).unwrap().is_empty());
    }

    // Свободная серия повтор терпит, но показывает его.
    assert_eq!(series::repeats(&conn, sid).unwrap().len(), 1);

    // Обратно в турнирную с повтором нельзя: тип обещал бы то, чего нет.
    let clashes = series::set_kind(&conn, sid, "tournament").unwrap();
    assert_eq!(clashes.len(), 1);
    assert_eq!(clashes[0].pools.len(), 2);
    assert_eq!(series::get(&conn, sid).unwrap().kind, "free");
}

#[test]
fn tournament_series_refuses_to_drop_the_no_repeat_rule() {
    let conn = db();
    let sid = series::create(&conn, "Осень", "tournament").unwrap();
    assert!(series::set_no_repeat_inside(&conn, sid, false).is_err());
    assert!(series::get(&conn, sid).unwrap().no_repeat_inside);
}

#[test]
fn deleting_a_series_keeps_its_pools() {
    let conn = db();
    let sid = series::create(&conn, "Осень", "free").unwrap();
    let pool = pools::create(&conn, "Пул", None).unwrap();
    series::add_pool(&conn, sid, pool).unwrap();

    series::delete(&conn, sid).unwrap();
    let back = pools::get(&conn, pool).unwrap();
    assert_eq!(back.series_id, None);
    assert_eq!(back.series_label, None);
}

#[test]
fn new_version_takes_the_same_place_in_the_series() {
    let conn = db();
    tagged(&conn, 1, "a", 180.0, &["NM"]);

    let sid = series::create(&conn, "Осень", "tournament").unwrap();
    let pool = pools::create(&conn, "Раунд 1", None).unwrap();
    series::add_pool(&conn, sid, pool).unwrap();
    pools::add_slot(&conn, pool, "NM").unwrap();

    // На старый пул ссылается исключение другого шаблона.
    let t = templates::create(&conn, "Свой").unwrap();
    exclusions::add(
        &conn,
        Owner::Template(t.id),
        &ExclusionTarget::Pool { id: pool },
        true,
    )
    .unwrap();

    conn.execute("UPDATE pools SET is_locked = 1 WHERE id = ?1", [pool])
        .unwrap();
    let next = pools::writable(&conn, pool).unwrap();
    assert_ne!(next, pool);

    let fresh = pools::get(&conn, next).unwrap();
    assert_eq!(fresh.series_id, Some(sid));
    assert_eq!(fresh.series_label.as_deref(), Some("раунд 1"));

    // Старая версия ушла в архив и освободила раунд.
    assert_eq!(pools::get(&conn, pool).unwrap().status, "archived");
    let inside = series::pools_of(&conn, sid).unwrap();
    assert_eq!(inside.len(), 2);
    assert_eq!(series::live_pool_ids(&conn, sid).unwrap(), vec![next]);

    // Исключение переехало на новую версию, а не осталось висеть впустую.
    let list = exclusions::raw_list(&conn, Owner::Template(t.id)).unwrap();
    assert_eq!(list[0].target, ExclusionTarget::Pool { id: next });
}

#[test]
fn series_stats_count_growth_and_repeats() {
    let conn = db();
    // Два пула: во втором звёзды выше, одна карта общая.
    for id in 1..=3 {
        let mut m = map(id, "Artist", &format!("Map {id}"), 5.0);
        m.creator = Some("alice".into());
        m.mods = vec!["NM".into()];
        beatmaps::upsert(&conn, &m).unwrap();
    }
    let mut hard = map(4, "Artist", "Hard", 7.0);
    hard.creator = Some("bob".into());
    hard.mods = vec!["NM".into()];
    beatmaps::upsert(&conn, &hard).unwrap();

    let sid = series::create(&conn, "Осень", "free").unwrap();
    series::set_no_repeat_inside(&conn, sid, false).unwrap();

    let first = pools::create(&conn, "Раунд 1", None).unwrap();
    let second = pools::create(&conn, "Раунд 2", None).unwrap();
    for (pool, maps) in [(first, [1, 2]), (second, [1, 4])] {
        for _ in 0..2 {
            pools::add_slot(&conn, pool, "NM").unwrap();
        }
        let slots = pools::get(&conn, pool).unwrap().slots;
        for (slot, id) in slots.iter().zip(maps.iter()) {
            pools::set_slot_beatmap(&conn, slot.id, Some(*id)).unwrap();
        }
        series::add_pool(&conn, sid, pool).unwrap();
    }

    let stats = series::stats(&conn, sid).unwrap();
    assert_eq!(stats.pools, 2);
    assert_eq!(stats.maps_total, 4);
    assert_eq!(stats.maps_unique, 3);
    assert_eq!(stats.repeats, 1);
    assert_eq!(stats.mappers, 2);
    assert_eq!(stats.mappers_repeated, 1);
    assert_eq!(stats.stars_min, Some(5.0));
    assert_eq!(stats.stars_max, Some(7.0));
    assert_eq!(stats.steps.len(), 2);
    assert!(!stats.steps[1].below_previous, "к финалу сложность растёт");
    assert_eq!(stats.repeat_rows.len(), 1);
    assert_eq!(stats.repeat_rows[0].pool_ids, vec![first, second]);
}

#[test]
fn falling_difficulty_is_flagged_softly() {
    let conn = db();
    let mut easy = map(1, "Artist", "Easy", 4.0);
    easy.mods = vec!["NM".into()];
    beatmaps::upsert(&conn, &easy).unwrap();
    let mut hard = map(2, "Artist", "Hard", 8.0);
    hard.mods = vec!["NM".into()];
    beatmaps::upsert(&conn, &hard).unwrap();

    let sid = series::create(&conn, "Осень", "tournament").unwrap();
    for (name, bid) in [("Раунд 1", 2), ("Раунд 2", 1)] {
        let pool = pools::create(&conn, name, None).unwrap();
        pools::add_slot(&conn, pool, "NM").unwrap();
        let slot = pools::get(&conn, pool).unwrap().slots[0].id;
        pools::set_slot_beatmap(&conn, slot, Some(bid)).unwrap();
        series::add_pool(&conn, sid, pool).unwrap();
    }

    let stats = series::stats(&conn, sid).unwrap();
    assert!(!stats.steps[0].below_previous);
    assert!(
        stats.steps[1].below_previous,
        "падение сложности к финалу надо показать"
    );
}

#[test]
fn map_from_another_pool_of_the_series_is_flagged_in_the_row() {
    let conn = db();
    tagged(&conn, 1, "a", 180.0, &["NM"]);

    let sid = series::create(&conn, "Осень", "free").unwrap();
    series::set_no_repeat_inside(&conn, sid, false).unwrap();

    let first = pools::create(&conn, "Раунд 1", None).unwrap();
    let second = pools::create(&conn, "Раунд 2", None).unwrap();
    for id in [first, second] {
        pools::add_slot(&conn, id, "NM").unwrap();
        let slot = pools::get(&conn, id).unwrap().slots[0].id;
        pools::set_slot_beatmap(&conn, slot, Some(1)).unwrap();
        series::add_pool(&conn, sid, id).unwrap();
    }

    let pool = pools::get(&conn, second).unwrap();
    let warn = pool.slots[0]
        .warnings
        .iter()
        .find(|w| w.text.contains("уже играется"))
        .expect("строка должна сказать, где карта уже стоит");
    // Серия свободная — замечание мягкое.
    assert!(!warn.strict);
    assert!(warn.text.contains("раунд 1"));
}

#[test]
fn stars_outside_the_template_range_are_flagged() {
    let conn = db();
    let mut m = map(1, "Artist", "Map", 8.0);
    m.mods = vec!["NM".into()];
    beatmaps::upsert(&conn, &m).unwrap();

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(
        &conn,
        t.id,
        &[TemplateSlotInput {
            mod_tag: "NM".into(),
            count: 1,
            star_min: Some(5.0),
            star_max: Some(6.4),
            source_collection_id: None,
            required_skillsets: vec![],
        }],
    )
    .unwrap();

    // Генерация такую карту не возьмёт — ставим руками.
    let report = generate::generate(&conn, t.id, "Пул", None).unwrap();
    let slot = pools::get(&conn, report.pool.id).unwrap().slots[0].id;
    pools::set_slot_beatmap(&conn, slot, Some(1)).unwrap();

    let pool = pools::get(&conn, report.pool.id).unwrap();
    assert!(pool.slots[0]
        .warnings
        .iter()
        .any(|w| w.strict && w.text.contains("8.0 при диапазоне 5.0—6.4")));
}

#[test]
fn whence_shows_where_sources_came_from() {
    let conn = db();
    for id in 1..=3 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM"]);
    }
    let picked = collection_of(&conn, "Отбор", &[1, 2]);

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 1, None)]).unwrap();

    let sid = series::create(&conn, "Осень", "tournament").unwrap();
    series::set_sources(
        &conn,
        sid,
        Some(&set_of(vec![Source::Collection { id: picked }], "union")),
    )
    .unwrap();

    let report = generate::generate(&conn, t.id, "Раунд 1", Some(sid)).unwrap();
    let whence = generate::whence(&conn, report.pool.id).unwrap();

    assert!(!whence.sources.own, "источники пришли от серии, а не свои");
    assert!(whence.sources.origin.contains("Осень"));
    assert_eq!(whence.sources.total, 2);
    assert_eq!(whence.supply.len(), 1);
    assert_eq!(whence.supply[0].slot_label, "NM1");
    assert_eq!(whence.supply[0].available, 2);
    assert!(whence.rules_origin.contains("Свой"));
}

#[test]
fn picker_hides_excluded_maps_but_counts_them() {
    let conn = db();
    for id in 1..=3 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM"]);
    }

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 1, None)]).unwrap();
    exclusions::add(
        &conn,
        Owner::Template(t.id),
        &ExclusionTarget::Beatmaps { ids: vec![2, 3] },
        true,
    )
    .unwrap();

    let report = generate::generate(&conn, t.id, "Пул", None).unwrap();
    let picker = generate::slot_candidates(&conn, report.pool.id, 0).unwrap();

    assert_eq!(picker.available, 1);
    assert_eq!(picker.hidden, vec![2, 3]);
    assert_eq!(picker.filter.mods, vec!["NM".to_string()]);
}

#[test]
fn sources_without_a_common_part_give_nothing() {
    let conn = db();
    tagged(&conn, 1, "a", 180.0, &["HD"]);

    // Источник-фильтр только про HD, а слот про DT — общего нет.
    let set = set_of(
        vec![Source::Filter {
            filter: LibraryFilter {
                mods: vec!["HD".into()],
                ..LibraryFilter::default()
            },
        }],
        "union",
    );
    let base = LibraryFilter {
        mods: vec!["DT".into()],
        ..LibraryFilter::default()
    };
    assert!(sources::ids(&conn, &set, &base).unwrap().is_empty());

    // А по HD источник карту отдаёт.
    let hd = LibraryFilter {
        mods: vec!["HD".into()],
        ..LibraryFilter::default()
    };
    assert_eq!(sources::ids(&conn, &set, &hd).unwrap(), vec![1]);
}

#[test]
fn bulk_slot_actions_touch_only_the_selection() {
    let conn = db();
    for id in 1..=4 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM", "HD"]);
    }

    let pool = pools::create(&conn, "Пул", None).unwrap();
    for _ in 0..4 {
        pools::add_slot(&conn, pool, "NM").unwrap();
    }

    pools::set_slots_pinned(&conn, pool, &[1, 2], true).unwrap();
    let pinned: Vec<bool> = pools::get(&conn, pool)
        .unwrap()
        .slots
        .iter()
        .map(|s| s.pinned)
        .collect();
    assert_eq!(pinned, vec![false, true, true, false]);

    pools::change_slots_mod(&conn, pool, &[2, 3], "HD").unwrap();
    let labels: Vec<String> = pools::get(&conn, pool)
        .unwrap()
        .slots
        .iter()
        .map(|s| s.slot_label.clone())
        .collect();
    assert_eq!(labels, vec!["NM1", "NM2", "HD1", "HD2"]);

    pools::remove_slots(&conn, pool, &[0, 3]).unwrap();
    let left: Vec<String> = pools::get(&conn, pool)
        .unwrap()
        .slots
        .iter()
        .map(|s| s.slot_label.clone())
        .collect();
    assert_eq!(left, vec!["NM1", "HD1"]);
}

#[test]
fn tiebreaker_cannot_be_set_on_several_slots_at_once() {
    let conn = db();
    let pool = pools::create(&conn, "Пул", None).unwrap();
    for _ in 0..3 {
        pools::add_slot(&conn, pool, "NM").unwrap();
    }

    assert!(pools::change_slots_mod(&conn, pool, &[0, 1], "TB").is_err());

    pools::change_slots_mod(&conn, pool, &[0], "TB").unwrap();
    // Второй TB тоже не пройдёт: он в пуле ровно один.
    let slots = pools::get(&conn, pool).unwrap().slots;
    let other = slots.iter().find(|s| s.mod_tag == "NM").unwrap().position;
    assert!(pools::change_slots_mod(&conn, pool, &[other], "TB").is_err());
}

#[test]
fn rerolling_selected_slots_keeps_the_rest() {
    let conn = db();
    for id in 1..=8 {
        tagged(&conn, id, &format!("mapper{id}"), 180.0, &["NM"]);
    }

    let t = templates::create(&conn, "Свой").unwrap();
    templates::set_slots(&conn, t.id, &[slot_in("NM", 4, None)]).unwrap();
    let before = generate::generate(&conn, t.id, "Пул", None).unwrap().pool;

    let keep: Vec<Option<i64>> = before.slots[2..].iter().map(|s| s.beatmap_id).collect();
    let after = generate::reroll_slots(&conn, before.id, &[0, 1]).unwrap().pool;

    let still: Vec<Option<i64>> = after.slots[2..].iter().map(|s| s.beatmap_id).collect();
    assert_eq!(keep, still, "невыделенные слоты трогать нельзя");
    assert!(after.slots[..2].iter().all(|s| s.beatmap_id.is_some()));
}

#[test]
fn manual_pool_cannot_be_rolled() {
    let conn = db();
    let pool = pools::create(&conn, "Руками", None).unwrap();
    pools::add_slot(&conn, pool, "NM").unwrap();
    assert!(generate::reroll(&conn, pool, false).is_err());
}

// ─────────────────────────────────────────────── игроки, турниры, матчи

/// Турнир с готовой сеткой: игроки, маппул из трёх карт и запуск.
/// Турнир с построенной и утверждённой сеткой — по нему можно играть.
fn tournament(conn: &mut Connection, nicks: &[&str]) -> i64 {
    let t = seeded_tournament(conn, nicks);
    tournaments::confirm(conn, t).unwrap();
    t
}

/// Турнир с построенной, но ещё не утверждённой сеткой.
fn seeded_tournament(conn: &mut Connection, nicks: &[&str]) -> i64 {
    let t = tournaments::create(conn, "Кубок", 2, 1).unwrap();
    for nick in nicks {
        let p = players::create(conn, nick, None, None).unwrap();
        tournaments::add_player(conn, t, p, false).unwrap();
    }
    tournaments::start(conn, t).unwrap();
    t
}

/// Маппул на пять строк: по две карты под NM и HD плюс тайбрейк.
/// Меньше не годится — что-то надо забанить, а что-то ещё сыграть.
fn pool_with_tb(conn: &Connection) -> i64 {
    for id in 1..=5 {
        beatmaps::upsert(conn, &map(id, "a", "t", 5.0)).unwrap();
    }
    let pool = pools::create(conn, "Пул", None).unwrap();
    for (i, mod_tag) in ["NM", "NM", "HD", "HD", "TB"].iter().enumerate() {
        pools::add_slot(conn, pool, mod_tag).unwrap();
        let slots = pools::get(conn, pool).unwrap().slots;
        pools::set_slot_beatmap(conn, slots[i].id, Some(i as i64 + 1)).unwrap();
    }
    pool
}

#[test]
fn player_delete_only_before_tournaments() {
    let mut conn = db();
    let p = players::create(&conn, "Ari", None, None).unwrap();
    players::delete(&conn, p).unwrap();
    assert!(players::get(&conn, p).unwrap().is_none());

    let p = players::create(&conn, "Bo", None, None).unwrap();
    let t = tournaments::create(&conn, "Кубок", 2, 1).unwrap();
    tournaments::add_player(&conn, t, p, false).unwrap();

    // Уже играл — только в архив, иначе история осталась бы без имени.
    assert!(players::delete(&conn, p).is_err());
    players::set_archived(&conn, p, true).unwrap();
    assert!(players::get(&conn, p).unwrap().unwrap().is_archived);

    let _ = &mut conn;
}

#[test]
fn tournament_players_get_distinct_colors() {
    let conn = db();
    let a = players::create(&conn, "Ari", None, None).unwrap();
    // Второму ставим тот же цвет, что у первого.
    let first = players::get(&conn, a).unwrap().unwrap().color;
    let b = players::create(&conn, "Bo", None, Some(&first)).unwrap();

    let t = tournaments::create(&conn, "Кубок", 2, 1).unwrap();
    tournaments::add_player(&conn, t, a, false).unwrap();
    tournaments::add_player(&conn, t, b, false).unwrap();

    let colors: Vec<String> = tournaments::players_of(&conn, t)
        .unwrap()
        .into_iter()
        .map(|p| p.color)
        .collect();
    assert_ne!(colors[0], colors[1], "цвета в турнире должны различаться");
    // Личный цвет игрока при этом не менялся.
    assert_eq!(players::get(&conn, b).unwrap().unwrap().color, first);
}

#[test]
fn odd_player_count_seats_the_bye_straight_into_the_next_round() {
    let mut conn = db();
    // Трое на сетку из четырёх: сильнейшему играть в первом раунде не с кем.
    let t = tournament(&mut conn, &["Ari", "Bo", "Cy"]);
    let br = tournaments::bracket_of(&conn, t).unwrap();

    // Размер сетки — это фактический состав, а не округление вверх: «трое
    // игроков» и «сетка на 4» рядом читаются как ошибка.
    assert_eq!(br.tournament.bracket_size, 3);

    // Матча с пустотой в сетке нет вовсе: он бы занимал место и требовал
    // техпобеды там, где играть изначально не с кем.
    let first: Vec<_> = br
        .matches
        .iter()
        .filter(|m| m.bracket == "upper" && m.round == 1)
        .collect();
    assert_eq!(first.len(), 1, "в первом раунде играет одна пара");
    assert!(first[0].player_a.is_some() && first[0].player_b.is_some());

    // Прошедший без игры уже сидит в следующем матче и ждёт соперника.
    let next = first[0].next_win_slot.unwrap();
    let next = br.matches.iter().find(|m| m.id == next).unwrap();
    assert_eq!(
        [next.player_a, next.player_b].iter().flatten().count(),
        1,
        "одно место занято, второе ждёт победителя"
    );
}

#[test]
fn roster_locked_after_start() {
    let mut conn = db();
    let t = tournament(&mut conn, &["Ari", "Bo"]);
    let extra = players::create(&conn, "Cy", None, None).unwrap();

    assert!(tournaments::add_player(&conn, t, extra, false).is_err());
    assert!(tournaments::start(&mut conn, t).is_err());
}

#[test]
fn seeded_bracket_can_be_rebuilt_but_not_played() {
    let mut conn = db();
    let t = seeded_tournament(&mut conn, &["Ari", "Bo"]);
    let pool = pool_with_tb(&conn);
    tournaments::set_pools(&conn, t, &[pool]).unwrap();

    // Сетка построена, но турнир ещё не идёт.
    assert_eq!(tournaments::get(&conn, t).unwrap().status, "seeded");

    // Играть по неутверждённой сетке нельзя: она ещё может смениться.
    let m = tournaments::bracket_of(&conn, t)
        .unwrap()
        .matches
        .into_iter()
        .find(|m| m.player_a.is_some() && m.player_b.is_some())
        .unwrap();
    let a = m.player_a.unwrap();
    assert!(matches::set_first_ban(&conn, m.id, a).is_err());

    // Зато можно пересобрать её заново, а потом запустить.
    assert!(tournaments::start(&mut conn, t).is_ok());
    tournaments::confirm(&conn, t).unwrap();
    assert_eq!(tournaments::get(&conn, t).unwrap().status, "running");

    let m = tournaments::bracket_of(&conn, t)
        .unwrap()
        .matches
        .into_iter()
        .find(|m| m.player_a.is_some() && m.player_b.is_some())
        .unwrap();
    assert!(matches::set_first_ban(&conn, m.id, m.player_a.unwrap()).is_ok());
}

#[test]
fn reopen_returns_unplayed_bracket_to_draft() {
    let mut conn = db();
    let t = seeded_tournament(&mut conn, &["Ari", "Bo", "Cy"]);

    tournaments::reopen(&conn, t).unwrap();
    let back = tournaments::get(&conn, t).unwrap();
    assert_eq!(back.status, "draft");
    assert_eq!(back.bracket_size, 0);
    assert!(tournaments::bracket_of(&conn, t)
        .unwrap()
        .matches
        .is_empty());

    // Состав снова открыт.
    let extra = players::create(&conn, "Di", None, None).unwrap();
    assert!(tournaments::add_player(&conn, t, extra, false).is_ok());
}

/// Матч двух игроков с маппулом и назначенным первым баном.
///
/// Турнир берём на четверых: на двоих вся сетка — один матч, и проверить
/// на нём продвижение победителя дальше уже не на чем.
fn ready_match(conn: &mut Connection) -> (i64, i64, i64) {
    let t = tournament(conn, &["Ari", "Bo", "Cy", "Di"]);
    let pool = pool_with_tb(conn);
    tournaments::set_pools(conn, t, &[pool]).unwrap();

    let br = tournaments::bracket_of(conn, t).unwrap();
    let m = br
        .matches
        .iter()
        .find(|m| m.player_a.is_some() && m.player_b.is_some())
        .unwrap();

    matches::set_pool(conn, m.id, Some(pool)).unwrap();
    let (a, b) = (m.player_a.unwrap(), m.player_b.unwrap());
    matches::set_first_ban(conn, m.id, a).unwrap();
    (m.id, a, b)
}

#[test]
fn ban_order_alternates_and_picks_keep_the_queue() {
    let mut conn = db();
    let (m, a, b) = ready_match(&mut conn);

    // По одному бану на игрока: сначала A, потом B.
    let st = matches::state(&conn, m).unwrap();
    assert!(matches!(st.phase, Phase::Ban { actor, .. } if actor == a));

    matches::ban(&conn, m, "NM1").unwrap();
    let st = matches::state(&conn, m).unwrap();
    assert!(matches!(st.phase, Phase::Ban { actor, .. } if actor == b));

    matches::ban(&conn, m, "HD1").unwrap();

    // Очередь сквозная: после бана B ходит снова A, а не B второй раз подряд.
    let st = matches::state(&conn, m).unwrap();
    assert!(matches!(st.phase, Phase::Pick { actor } if actor == a));

    matches::pick(&conn, m, "NM2").unwrap();
    matches::result(&conn, m, a).unwrap();
    let st = matches::state(&conn, m).unwrap();
    assert!(matches!(st.phase, Phase::Pick { actor } if actor == b));
}

#[test]
fn banned_row_cannot_be_picked() {
    let mut conn = db();
    let (m, _, _) = ready_match(&mut conn);
    matches::ban(&conn, m, "NM1").unwrap();
    matches::ban(&conn, m, "HD1").unwrap();

    assert!(matches::pick(&conn, m, "NM1").is_err());
    // И банить дважды тоже нельзя.
    assert!(matches::ban(&conn, m, "NM1").is_err());
}

#[test]
fn tiebreaker_opens_only_at_match_point() {
    let mut conn = db();
    let (m, a, b) = ready_match(&mut conn);
    matches::ban(&conn, m, "NM1").unwrap();
    matches::ban(&conn, m, "HD1").unwrap();

    // Счёт 0:0, до победы 2 — тайбрейк закрыт.
    let st = matches::state(&conn, m).unwrap();
    let tb = st.rows.iter().find(|r| r.mod_tag == "TB").unwrap();
    assert!(matches!(tb.state, RowState::Locked { .. }));
    assert!(matches::pick(&conn, m, "TB1").is_err());

    // Разводим счёт 1:1 — тайбрейк открывается.
    matches::pick(&conn, m, "NM2").unwrap();
    matches::result(&conn, m, a).unwrap();
    matches::pick(&conn, m, "HD2").unwrap();
    matches::result(&conn, m, b).unwrap();

    let st = matches::state(&conn, m).unwrap();
    assert_eq!((st.match_info.score_a, st.match_info.score_b), (1, 1));
    assert_eq!(st.match_point.len(), 2, "оба в шаге от победы");
    let tb = st.rows.iter().find(|r| r.mod_tag == "TB").unwrap();
    assert!(matches!(tb.state, RowState::Free));
}

#[test]
fn undo_rolls_back_result_and_reopens_match() {
    let mut conn = db();
    let (m, a, _) = ready_match(&mut conn);
    matches::ban(&conn, m, "NM1").unwrap();
    matches::ban(&conn, m, "HD1").unwrap();

    for slot in ["NM2", "HD2"] {
        matches::pick(&conn, m, slot).unwrap();
        matches::result(&conn, m, a).unwrap();
    }

    // Две победы при цели 2 — матч закрыт, победитель уехал дальше.
    let st = matches::state(&conn, m).unwrap();
    assert_eq!(st.match_info.status, "finished");
    assert_eq!(st.match_info.winner_id, Some(a));
    assert_eq!(
        st.match_point.len(),
        0,
        "у доигранного матча матчпоинта нет"
    );
    let next = st.match_info.next_win_slot.unwrap();
    let after = matches::get(&conn, next).unwrap();
    assert!(after.player_a == Some(a) || after.player_b == Some(a));

    matches::undo(&conn, m).unwrap();

    let st = matches::state(&conn, m).unwrap();
    assert_eq!(st.match_info.status, "running");
    assert_eq!(st.match_info.winner_id, None);
    assert_eq!(st.match_info.score_a, 1);
    // И из следующего матча игрока убрали.
    let after = matches::get(&conn, next).unwrap();
    assert!(after.player_a != Some(a) && after.player_b != Some(a));
}

#[test]
fn changing_pool_blocked_after_first_ban() {
    let mut conn = db();
    let (m, _, _) = ready_match(&mut conn);
    let other = pool_with_tb(&conn);

    matches::set_pool(&conn, m, Some(other)).unwrap();
    matches::ban(&conn, m, "NM1").unwrap();
    assert!(matches::set_pool(&conn, m, Some(other)).is_err());
}

#[test]
fn manual_result_replaces_log() {
    let mut conn = db();
    let (m, a, b) = ready_match(&mut conn);
    matches::ban(&conn, m, "NM1").unwrap();

    // Ручной счёт в идущем турнире — аварийная правка: без неё не пускаем.
    assert!(matches::set_manual_result(&conn, m, b, 0, 2, false).is_err());
    matches::set_manual_result(&conn, m, b, 0, 2, true).unwrap();

    let st = matches::state(&conn, m).unwrap();
    assert_eq!(st.match_info.status, "finished");
    assert_eq!(st.match_info.winner_id, Some(b));
    assert_eq!((st.match_info.score_a, st.match_info.score_b), (0, 2));
    assert!(st.match_info.is_manual_edit);
    // Бан из журнала ушёл вместе с остальной историей.
    assert!(!st.actions.iter().any(|x| x.kind == "ban"));
    let _ = a;
}

#[test]
fn odd_roster_leaves_no_dead_matches() {
    let mut conn = db();
    // Пятеро на сетке в восемь мест: три матча первого раунда — техпобеды,
    // а один матч нижней сетки остаётся вообще без участников.
    let t = tournament(&mut conn, &["Ari", "Bo", "Cy", "Di", "Ed"]);

    let br = tournaments::bracket_of(&conn, t).unwrap();

    // Ни один матч не должен ждать соперника, которому неоткуда взяться:
    // такой матч запирал бы всю ветку до конца турнира.
    for m in &br.matches {
        let waiting_forever = m.status == "pending"
            && m.player_a.is_none()
            && m.player_b.is_none()
            && !br.matches.iter().any(|src| {
                (src.next_win_slot == Some(m.id) || src.next_lose_slot == Some(m.id))
                    && src.status != "finished"
            });
        assert!(
            !waiting_forever,
            "матч {} ({} r{}) заперт: игроки не придут",
            m.id, m.bracket, m.round
        );
    }

    // Все пятеро расставлены по сетке, никто не потерялся.
    let seated: std::collections::HashSet<i64> = br
        .matches
        .iter()
        .flat_map(|m| [m.player_a, m.player_b])
        .flatten()
        .collect();
    assert_eq!(seated.len(), 5, "в сетке должны стоять все пятеро");
}

#[test]
fn loser_of_upper_match_drops_into_lower_bracket() {
    let mut conn = db();
    // Четверо: у проигравшего первого раунда есть куда падать.
    let t = tournament(&mut conn, &["Ari", "Bo", "Cy", "Di"]);
    let pool = pool_with_tb(&conn);
    tournaments::set_pools(&conn, t, &[pool]).unwrap();

    let br = tournaments::bracket_of(&conn, t).unwrap();
    let m = br
        .matches
        .iter()
        .find(|m| m.bracket == "upper" && m.round == 1)
        .unwrap()
        .clone();
    let (a, b) = (m.player_a.unwrap(), m.player_b.unwrap());

    matches::set_pool(&conn, m.id, Some(pool)).unwrap();
    matches::set_first_ban(&conn, m.id, a).unwrap();
    matches::ban(&conn, m.id, "NM1").unwrap();
    matches::ban(&conn, m.id, "HD1").unwrap();
    for slot in ["NM2", "HD2"] {
        matches::pick(&conn, m.id, slot).unwrap();
        matches::result(&conn, m.id, a).unwrap();
    }

    // Победитель — выше, проигравший — в нижнюю сетку, а не из турнира.
    let up = matches::get(&conn, m.next_win_slot.unwrap()).unwrap();
    assert!(up.player_a == Some(a) || up.player_b == Some(a));

    let down = matches::get(&conn, m.next_lose_slot.unwrap()).unwrap();
    assert_eq!(down.bracket, "lower");
    assert!(
        down.player_a == Some(b) || down.player_b == Some(b),
        "проигравший должен получить второй шанс в нижней сетке"
    );
}

/// Доигрывает матч до конца: баны, пики и результаты в пользу победителя.
fn play_out(conn: &Connection, pool: i64, match_id: i64, winner: i64) {
    let m = matches::get(conn, match_id).unwrap();
    if m.pool_id.is_none() {
        matches::set_pool(conn, match_id, Some(pool)).unwrap();
    }
    if m.first_ban_by.is_none() {
        matches::set_first_ban(conn, match_id, m.player_a.unwrap()).unwrap();
    }

    loop {
        match matches::state(conn, match_id).unwrap().phase {
            Phase::Ban { .. } => {
                let slot = free_slot(conn, match_id);
                matches::ban(conn, match_id, &slot).unwrap();
            }
            Phase::Pick { .. } => {
                let slot = free_slot(conn, match_id);
                matches::pick(conn, match_id, &slot).unwrap();
            }
            Phase::Result { .. } => matches::result(conn, match_id, winner).unwrap(),
            Phase::Finished { .. } => break,
            Phase::NotStarted => panic!("матч не готов к игре"),
        }
    }
}

/// Первая строка маппула, которую ещё можно взять.
fn free_slot(conn: &Connection, match_id: i64) -> String {
    matches::state(conn, match_id)
        .unwrap()
        .rows
        .into_iter()
        .find(|r| matches!(r.state, RowState::Free))
        .expect("свободная карта в маппуле")
        .slot_label
}

#[test]
fn last_match_finishes_the_tournament_and_hands_out_places() {
    let mut conn = db();
    let t = tournament(&mut conn, &["Ari", "Bo"]);
    let pool = pool_with_tb(&conn);
    tournaments::set_pools(&conn, t, &[pool]).unwrap();

    let br = tournaments::bracket_of(&conn, t).unwrap();
    assert_eq!(br.matches.len(), 1, "на двоих вся сетка — один матч");
    assert_eq!(br.tournament.status, "running");

    let m = br.matches[0].clone();
    let (a, b) = (m.player_a.unwrap(), m.player_b.unwrap());
    play_out(&conn, pool, m.id, a);

    // Сетка кончилась — турнир закрылся сам, без отдельной кнопки.
    let br = tournaments::bracket_of(&conn, t).unwrap();
    assert_eq!(br.tournament.status, "finished");
    assert!(br.tournament.finished_at.is_some());

    let places: Vec<(i64, i64)> = br
        .standings
        .iter()
        .map(|s| (s.player_id, s.placement))
        .collect();
    assert_eq!(places, vec![(a, 1), (b, 2)]);
    assert_eq!(br.standings[0].match_wins, 1);
    assert_eq!(br.standings[1].match_losses, 1);
}

#[test]
fn undoing_the_deciding_result_reopens_the_tournament() {
    let mut conn = db();
    let t = tournament(&mut conn, &["Ari", "Bo"]);
    let pool = pool_with_tb(&conn);
    tournaments::set_pools(&conn, t, &[pool]).unwrap();

    let m = tournaments::bracket_of(&conn, t).unwrap().matches[0].clone();
    play_out(&conn, pool, m.id, m.player_a.unwrap());
    assert_eq!(tournaments::get(&conn, t).unwrap().status, "finished");

    matches::undo(&conn, m.id).unwrap();

    // Итог оказался поспешным — места снимаются вместе с результатом.
    let br = tournaments::bracket_of(&conn, t).unwrap();
    assert_eq!(br.tournament.status, "running");
    assert!(br.tournament.finished_at.is_none());
    assert!(br.standings.is_empty());
    assert!(br.tournament.players.iter().all(|p| p.placement.is_none()));
}

#[test]
fn unplayable_rules_are_reported_next_to_the_pools() {
    let mut conn = db();
    let t = seeded_tournament(&mut conn, &["Ari", "Bo"]);

    // Пять карт, из них тайбрейк; по два бана каждому — на игру до двух
    // побед не остаётся ничего.
    let pool = pool_with_tb(&conn);
    let rules = |bans: i64| {
        tournaments::set_rules(
            &conn,
            t,
            &ByRound::new(2),
            &ByRound::new(bans),
            "random",
            true,
        )
        .unwrap();
    };

    rules(2);
    tournaments::set_pools(&conn, t, &[pool]).unwrap();

    let br = tournaments::bracket_of(&conn, t).unwrap();
    assert_eq!(br.problems.len(), 1, "нестыковку видно на экране турнира");
    assert_eq!(br.problems[0].pool_id, Some(pool));
    // На двоих вся сетка — один матч верхней, за него и отвечает правило.
    assert_eq!(br.problems[0].key, "upper:1");
    assert!(!br.problems[0].notes.is_empty());

    // По одному бану карт хватает — предупреждение уходит.
    rules(1);
    let br = tournaments::bracket_of(&conn, t).unwrap();
    assert!(br.problems.is_empty());
}

// ────────────────────────────────────────────────── редактор турниров

#[test]
fn rounds_show_up_before_the_bracket_is_built() {
    let conn = db();
    let t = tournaments::create(&conn, "Кубок", 4, 1).unwrap();
    for nick in ["Ari", "Bo", "Cy", "Di"] {
        let p = players::create(&conn, nick, None, None).unwrap();
        tournaments::add_player(&conn, t, p, false).unwrap();
    }

    // Сетки ещё нет, но править правило финала надо уже сейчас: считаем
    // раунды по составу.
    let rounds = tournaments::editor(&conn, t).unwrap().rounds;
    let keys: Vec<&str> = rounds.iter().map(|r| r.key.as_str()).collect();
    assert_eq!(
        keys,
        vec!["upper:1", "upper:2", "lower:1", "lower:2", "grand:1"]
    );
    assert_eq!(rounds[1].title, "Финал верхней");
    assert_eq!(rounds[4].title, "Гранд-финал");
    // Пока правило не задано отдельно, оно унаследовано — это видно по флагу.
    assert!(rounds.iter().all(|r| !r.target_own && r.target == 4));
}

#[test]
fn round_rule_applies_only_to_its_own_round() {
    let mut conn = db();
    let t = seeded_tournament(&mut conn, &["Ari", "Bo", "Cy", "Di"]);

    // Финал верхней играем длиннее группового: это и есть исключение.
    tournaments::set_round_rule(&conn, t, "upper:2", Some(5), Some(2)).unwrap();

    let rounds = tournaments::editor(&conn, t).unwrap().rounds;
    let by = |key: &str| rounds.iter().find(|r| r.key == key).unwrap().clone();
    assert_eq!((by("upper:2").target, by("upper:2").bans), (5, 2));
    assert!(by("upper:2").target_own && by("upper:2").bans_own);
    // Нижняя сетка со своим первым раундом ничего не переняла: у неё свой ключ.
    assert_eq!(by("lower:1").target, 2);
    assert!(!by("lower:1").target_own);

    // ⟲ — возврат к общему: запись из исключений уходит.
    tournaments::set_round_rule(&conn, t, "upper:2", None, None).unwrap();
    let rounds = tournaments::editor(&conn, t).unwrap().rounds;
    let upper_final = rounds.iter().find(|r| r.key == "upper:2").unwrap();
    assert_eq!(upper_final.target, 2);
    assert!(!upper_final.target_own);
}

#[test]
fn match_takes_its_rule_at_the_start_and_keeps_it() {
    let mut conn = db();
    let (m, _, _) = ready_match(&mut conn);
    let t = matches::get(&conn, m).unwrap().tournament_id;

    assert_eq!(matches::state(&conn, m).unwrap().target, 2);

    // Правило поменяли посреди матча: идущий матч играет по своему прежнему,
    // иначе уже сыгранные карты пересчитались бы под новый счёт.
    tournaments::set_rules(
        &conn,
        t,
        &ByRound::new(5),
        &ByRound::new(1),
        "random",
        true,
    )
    .unwrap();
    assert_eq!(matches::state(&conn, m).unwrap().target, 2);

    // А неначатый матч того же раунда берёт новое правило.
    let other = tournaments::bracket_of(&conn, t)
        .unwrap()
        .matches
        .into_iter()
        .find(|x| x.id != m && x.bracket == "upper" && x.round == 1)
        .unwrap();
    assert_eq!(matches::state(&conn, other.id).unwrap().target, 5);
}

#[test]
fn pool_bound_to_a_round_wins_over_the_cycle() {
    let mut conn = db();
    let t = seeded_tournament(&mut conn, &["Ari", "Bo", "Cy", "Di"]);
    let first = pool_with_tb(&conn);
    let finals = pools::create(&conn, "Финалы", None).unwrap();
    tournaments::set_pools(&conn, t, &[first]).unwrap();

    // Пул, привязанный к раунду, но не добавленный в турнир, добавляется сам:
    // иначе привязка не сработала бы молча.
    tournaments::set_round_pool(&conn, t, "grand:1", Some(finals)).unwrap();
    assert!(tournaments::get(&conn, t).unwrap().pool_ids.contains(&finals));

    let br = tournaments::bracket_of(&conn, t).unwrap();
    let grand = br.matches.iter().find(|m| m.bracket == "grand").unwrap();
    assert_eq!(grand.pool_id, Some(finals));
    // Остальные раунды закреплённый пул по кругу не получают.
    assert!(br
        .matches
        .iter()
        .filter(|m| m.bracket != "grand")
        .all(|m| m.pool_id == Some(first)));

    // Маппул убрали из турнира — привязка не может остаться висеть.
    tournaments::set_pools(&conn, t, &[first]).unwrap();
    let after = tournaments::get(&conn, t).unwrap();
    assert!(after.pool_by_round.is_empty());
}

#[test]
fn grand_advantage_counts_in_the_match_but_not_in_map_stats() {
    let mut conn = db();
    let t = tournament(&mut conn, &["Ari", "Bo", "Cy", "Di"]);
    let pool = pool_with_tb(&conn);
    tournaments::set_pools(&conn, t, &[pool]).unwrap();
    tournaments::set_round_rule(&conn, t, "grand:1", Some(2), Some(1)).unwrap();
    tournaments::set_grand_advantage(&conn, t, 1).unwrap();

    // Доигрываем всё, кроме гранд-финала: победитель верхней должен приехать
    // туда с преимуществом. Порядок именно такой — нижняя сетка получает
    // выбывших из верхней, и раньше неё играть в ней некому.
    let br = tournaments::bracket_of(&conn, t).unwrap();
    let mut order: Vec<_> = br
        .matches
        .iter()
        .filter(|m| m.bracket != "grand")
        .cloned()
        .collect();
    order.sort_by_key(|m| {
        (
            if m.bracket == "upper" { 0 } else { 1 },
            m.round,
            m.slot_in_bracket,
        )
    });
    for m in &order {
        let live = matches::get(&conn, m.id).unwrap();
        if live.status == "finished" {
            continue;
        }
        play_out(&conn, pool, m.id, live.player_a.unwrap());
    }

    let grand = tournaments::bracket_of(&conn, t)
        .unwrap()
        .matches
        .into_iter()
        .find(|m| m.bracket == "grand")
        .unwrap();
    assert_eq!(
        (grand.bonus_a, grand.bonus_b),
        (1, 0),
        "преимущество достаётся приехавшему из верхней сетки"
    );
    assert_eq!((grand.score_a, grand.score_b), (0, 0), "карт ещё не играли");

    // Матч решается по счёту с преимуществом: одной победы хватит.
    play_out(&conn, pool, grand.id, grand.player_a.unwrap());
    let done = tournaments::bracket_of(&conn, t).unwrap();
    let played = done
        .matches
        .iter()
        .find(|m| m.bracket == "grand")
        .unwrap()
        .score_a;
    assert_eq!(played, 1, "сыграна одна карта, вторую победу дало преимущество");

    // В покартовую статистику преимущество не идёт: карта не игралась.
    // Два матча по две карты плюс одна в гранд-финале — пять, а не шесть.
    let champion = done.standings.iter().find(|s| s.placement == 1).unwrap();
    assert_eq!(champion.map_wins, 5);
}

#[test]
fn advantage_cannot_win_the_grand_final_before_the_first_map() {
    let mut conn = db();
    let t = seeded_tournament(&mut conn, &["Ari", "Bo", "Cy", "Di"]);
    // Гранд-финал играется до двух побед — преимущество в две выиграло бы его
    // до первой карты.
    assert!(tournaments::set_grand_advantage(&conn, t, 2).is_err());
    tournaments::set_grand_advantage(&conn, t, 1).unwrap();
    // И обратно: правило, которое обесценило бы уже выданное преимущество.
    assert!(tournaments::set_round_rule(&conn, t, "grand:1", Some(1), None).is_err());
}

#[test]
fn resetting_a_result_cascades_forward() {
    let mut conn = db();
    let t = tournament(&mut conn, &["Ari", "Bo", "Cy", "Di"]);
    let pool = pool_with_tb(&conn);
    tournaments::set_pools(&conn, t, &[pool]).unwrap();

    let br = tournaments::bracket_of(&conn, t).unwrap();
    let first = br
        .matches
        .iter()
        .find(|m| m.bracket == "upper" && m.round == 1)
        .unwrap()
        .clone();
    let winner = first.player_a.unwrap();
    let loser = first.player_b.unwrap();
    play_out(&conn, pool, first.id, winner);

    // Победитель уже сидит выше, проигравший — в нижней сетке.
    let ahead = first.next_win_slot.unwrap();
    let down = first.next_lose_slot.unwrap();
    assert!(matches::get(&conn, ahead).unwrap().player_a == Some(winner)
        || matches::get(&conn, ahead).unwrap().player_b == Some(winner));

    // Предпросмотр называет, что сбросится, до самой правки.
    let impact = matches::impact(&conn, first.id).unwrap();
    assert!(impact.maps > 0);
    assert!(!impact.returns.is_empty(), "проигравший вернётся в турнир");

    matches::reset(&conn, first.id, true).unwrap();

    let after = matches::get(&conn, first.id).unwrap();
    assert_eq!(after.status, "pending");
    assert_eq!(after.winner_id, None);
    assert_eq!(after.pool_id, Some(pool), "маппул остаётся: матч переигрывают");
    assert!(matches::state(&conn, first.id).unwrap().actions.is_empty());

    // Ни выше, ни ниже по сетке участников этого матча больше нет.
    let ahead = matches::get(&conn, ahead).unwrap();
    assert!(ahead.player_a != Some(winner) && ahead.player_b != Some(winner));
    let down = matches::get(&conn, down).unwrap();
    assert!(down.player_a != Some(loser) && down.player_b != Some(loser));
}

#[test]
fn reset_requires_emergency_while_the_tournament_runs() {
    let mut conn = db();
    let (m, a, _) = ready_match(&mut conn);
    let pool = matches::get(&conn, m).unwrap().pool_id.unwrap();
    play_out(&conn, pool, m, a);

    assert!(matches::reset(&conn, m, false).is_err());
    assert!(matches::reset(&conn, m, true).is_ok());
}

#[test]
fn undo_puts_the_tournament_back_and_keeps_the_record() {
    let mut conn = db();
    let t = seeded_tournament(&mut conn, &["Ari", "Bo", "Cy", "Di"]);
    let pool = pool_with_tb(&conn);
    tournaments::set_pools(&conn, t, &[pool]).unwrap();

    tournaments::set_round_rule(&conn, t, "upper:2", Some(6), None).unwrap();
    let n = tournaments::edits(&conn, t).unwrap()[0].n;

    tournaments::undo_last_edit(&conn, t).unwrap();

    // Значение вернулось к общему.
    let rounds = tournaments::editor(&conn, t).unwrap().rounds;
    assert_eq!(rounds.iter().find(|r| r.key == "upper:2").unwrap().target, 2);

    // Запись не исчезла: рядом легла парная отмена, а у правки — ссылка на неё.
    let log = tournaments::edits(&conn, t).unwrap();
    assert_eq!(log[0].kind, "undo");
    let undone = log.iter().find(|e| e.n == n).unwrap();
    assert_eq!(undone.undone_by, Some(log[0].n));
}

#[test]
fn undo_refuses_when_a_match_was_played_after_the_edit() {
    let mut conn = db();
    let t = tournament(&mut conn, &["Ari", "Bo", "Cy", "Di"]);
    let pool = pool_with_tb(&conn);
    tournaments::set_pools(&conn, t, &[pool]).unwrap();
    tournaments::set_round_rule(&conn, t, "upper:2", Some(3), None).unwrap();

    let first = tournaments::bracket_of(&conn, t)
        .unwrap()
        .matches
        .into_iter()
        .find(|m| m.bracket == "upper" && m.round == 1)
        .unwrap();
    play_out(&conn, pool, first.id, first.player_a.unwrap());

    // Пересчёт вернул бы турнир в состояние, которого не было.
    assert!(tournaments::undo_last_edit(&conn, t).is_err());
    assert!(tournaments::editor(&conn, t)
        .unwrap()
        .undo_blocked
        .is_some());
}

#[test]
fn roster_change_rebuilds_the_bracket_while_it_is_only_seeded() {
    let mut conn = db();
    let t = seeded_tournament(&mut conn, &["Ari", "Bo"]);
    assert_eq!(tournaments::bracket_of(&conn, t).unwrap().matches.len(), 1);

    let extra = players::create(&conn, "Cy", None, None).unwrap();
    tournaments::add_player(&conn, t, extra, false).unwrap();

    // Сетка — это и есть предпросмотр: правка состава видна на ней сразу.
    let br = tournaments::bracket_of(&conn, t).unwrap();
    assert_eq!(br.tournament.status, "seeded");
    assert!(br.matches.len() > 1);
    assert_eq!(br.tournament.bracket_size, 3);
    assert_eq!(
        tournaments::editor(&conn, t).unwrap().byes.len(),
        1,
        "трое на сетке из четырёх — старшему играть не с кем"
    );
}

#[test]
fn substitute_cannot_be_someone_already_in_the_tournament() {
    let mut conn = db();
    let t = tournament(&mut conn, &["Ari", "Bo", "Cy", "Di"]);
    let br = tournaments::bracket_of(&conn, t).unwrap();
    let m = br
        .matches
        .iter()
        .find(|m| m.bracket == "upper" && m.round == 1)
        .unwrap();
    let inside = br.tournament.players[3].player_id;

    // Два места одного игрока в сетке — это уже не сетка.
    assert!(matches::replace_player(&conn, m.id, "a", inside, true).is_err());

    let fresh = players::create(&conn, "Ed", None, None).unwrap();
    matches::replace_player(&conn, m.id, "a", fresh, true).unwrap();
    assert_eq!(matches::get(&conn, m.id).unwrap().player_a, Some(fresh));
    // Заменяющий появился в составе, а прежний остался: его матчи — его.
    let after = tournaments::get(&conn, t).unwrap();
    assert_eq!(after.players.len(), 5);
}

#[test]
fn editor_blocks_only_what_stops_the_bracket() {
    let conn = db();
    let t = tournaments::create(&conn, "Кубок", 4, 1).unwrap();

    let state = tournaments::editor(&conn, t).unwrap();
    let blocking: Vec<&str> = state
        .checks
        .iter()
        .filter(|c| c.blocking)
        .map(|c| c.section.as_str())
        .collect();
    assert_eq!(blocking, vec!["players", "pools"]);

    // Раундов больше, чем маппулов, — предупреждение, но не запрет.
    for nick in ["Ari", "Bo", "Cy", "Di"] {
        let p = players::create(&conn, nick, None, None).unwrap();
        tournaments::add_player(&conn, t, p, false).unwrap();
    }
    let pool = pool_with_tb(&conn);
    tournaments::set_pools(&conn, t, &[pool]).unwrap();

    let state = tournaments::editor(&conn, t).unwrap();
    assert!(state.checks.iter().all(|c| !c.blocking));
    assert!(state
        .checks
        .iter()
        .any(|c| c.section == "pools" && c.text.contains("повтором")));
}
