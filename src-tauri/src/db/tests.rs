//! Тесты слоя базы: схема, фильтрация, коллекции, метки.
//!
//! Каждый тест поднимает свою базу в памяти — состояние между ними не течёт.

use rusqlite::Connection;

use crate::db::{beatmaps, collections, labels};
use crate::model::{Beatmap, BeatmapAttributes, LibraryFilter, Range, SkillsetTag};

const SCHEMA: &str = include_str!("schema.sql");

fn db() -> Connection {
    let conn = Connection::open_in_memory().expect("база в памяти");
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    conn.execute_batch(SCHEMA).expect("схема применилась");
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
