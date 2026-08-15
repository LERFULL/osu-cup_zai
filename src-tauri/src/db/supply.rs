//! Запас: сколько карт подходит под слот и что именно отсекло остальные.
//!
//! Раньше слот просто оставался пустым, и было не видно, почему: звёзд не
//! хватило, коллекция маленькая или всё исключено. Здесь считается по шагам,
//! и каждый шаг сообщает своё число — «диапазон звёзд отрезал 214, исключение
//! прошлого турнира — ещё 38». Это же считает и генерация: узкий слот должен
//! выбирать первым, а для этого надо заранее знать, кто из них узкий.

use std::collections::HashSet;

use rusqlite::Connection;

use super::exclusions::Ready;
use super::{sources, templates};
use crate::error::Result;
use crate::model::{
    Blocker, GenRules, LibraryFilter, Pool, PoolTemplate, Range, SlotSupply, SourceSet,
    TemplateSlot,
};

/// Уровень источников: свой набор и как его называть в подписи.
pub type Level = (Option<SourceSet>, String);

/// Кандидаты слота и его запас.
pub struct SlotPool {
    /// Карты по приоритету источников. `union` — один уровень.
    pub tiers: Vec<Vec<i64>>,
    /// Карты, прошедшие условия слота, но ещё не отсечённые исключениями.
    /// От этого набора считается «сколько ты у меня забрал» в панели: от
    /// урезанного оно всегда выходило бы нулём.
    pub matched: HashSet<i64>,
    pub supply: SlotSupply,
}

impl SlotPool {
    pub fn available(&self) -> i64 {
        self.supply.available
    }
}

/// Условия слота, применяемые по одному, — с подписью для blockers.
struct Step {
    reason: String,
    apply: Box<dyn Fn(&mut LibraryFilter)>,
}

fn step(reason: String, apply: impl Fn(&mut LibraryFilter) + 'static) -> Step {
    Step {
        reason,
        apply: Box::new(apply),
    }
}

/// Шаги сужения: сначала свойства самого слота, потом строгие правила.
/// Порядок важен — числа в blockers читаются как «сначала отрезало это,
/// потом ещё вот это».
fn steps(slot: &TemplateSlot, rules: &GenRules) -> Vec<Step> {
    let mut out = Vec::new();

    let mod_tag = slot.mod_tag.clone();
    out.push(step(format!("нет карт с мод-тегом {mod_tag}"), move |f| {
        f.mods = vec![mod_tag.clone()];
    }));

    if slot.star_min.is_some() || slot.star_max.is_some() {
        let (lo, hi) = (slot.star_min, slot.star_max);
        out.push(step(format!("звёзды {}", range_text(lo, hi)), move |f| {
            f.stars = Range { min: lo, max: hi };
        }));
    }

    if !slot.required_skillsets.is_empty() {
        let want = slot.required_skillsets.clone();
        out.push(step(
            format!("нужны скилсеты: {}", want.join(", ")),
            move |f| f.skillsets = want.clone(),
        ));
    }

    if rules.ranked_only && rules.ranked_only_strict {
        out.push(step("строго ranked".to_string(), |f| {
            f.statuses = vec!["ranked".to_string()];
        }));
    }

    if rules.length_max_strict {
        if let Some(max) = rules.length_max {
            out.push(step(format!("длиннее {}", mmss(max)), move |f| {
                f.length.max = Some(max as f64);
            }));
        }
    }

    out
}

fn range_text(lo: Option<f64>, hi: Option<f64>) -> String {
    match (lo, hi) {
        (Some(a), Some(b)) => format!("{a:.1}—{b:.1}"),
        (Some(a), None) => format!("от {a:.1}"),
        (None, Some(b)) => format!("до {b:.1}"),
        (None, None) => "без границ".into(),
    }
}

fn mmss(seconds: i64) -> String {
    let s = seconds.max(0);
    format!("{}:{:02}", s / 60, s % 60)
}

/// Первый уровень со своими источниками — он и работает. Остальные ниже
/// наследуются: пустой уровень ничего не задаёт.
fn pick_level(levels: &[Level]) -> (SourceSet, String) {
    for (set, origin) in levels {
        if let Some(set) = set {
            if !set.is_empty() {
                return (set.clone(), origin.clone());
            }
        }
    }
    (sources::whole_library(), "вся библиотека".to_string())
}

/// Кандидаты и запас одного слота.
///
/// `exclusions` — уже разрешённые исключения всех уровней: строгие отсекают
/// карты насовсем, мягкие уходят в веса подбора.
pub fn for_slot(
    conn: &Connection,
    slot: &TemplateSlot,
    rules: &GenRules,
    label: &str,
    position: i64,
    need: i64,
    levels: &[Level],
    exclusions: &[Ready],
) -> Result<SlotPool> {
    let (set, origin) = pick_level(levels);

    let mut filter = LibraryFilter::default();
    let mut blockers: Vec<Blocker> = Vec::new();

    // Отправная точка — всё, что дают источники, без условий слота.
    let mut before = sources::ids(conn, &set, &filter)?.len() as i64;
    let mut matching = before;

    let plan = steps(slot, rules);
    // Первые шаги — условия самого слота: мод, звёзды, скилсеты. То, что
    // осталось после них, и есть `matching`; дальше идут правила шаблона.
    let own = 1
        + usize::from(slot.star_min.is_some() || slot.star_max.is_some())
        + usize::from(!slot.required_skillsets.is_empty());

    for (i, s) in plan.iter().enumerate() {
        (s.apply)(&mut filter);
        let after = sources::ids(conn, &set, &filter)?.len() as i64;
        if before - after > 0 {
            blockers.push(Blocker {
                reason: s.reason.clone(),
                cut: before - after,
            });
        }
        before = after;
        if i + 1 == own {
            matching = after;
        }
    }

    // Строгие исключения: карты, которых в этом слоте быть не может. Мягкие
    // сюда не попадают — они работают весами при подборе, и вычитать их из
    // запаса значило бы обещать пустой слот там, где он заполнится.
    let raw_tiers = sources::tiers(conn, &set, &filter)?;
    let base_set: HashSet<i64> = raw_tiers.iter().flatten().copied().collect();

    let mut banned: HashSet<i64> = HashSet::new();

    for ex in exclusions.iter().filter(|e| e.live() && e.raw.strict) {
        let Some(ids) = &ex.ids else { continue };
        let cut = base_set
            .iter()
            .filter(|id| ids.contains(id) && !banned.contains(id))
            .count() as i64;
        if cut > 0 {
            blockers.push(Blocker {
                reason: format!("исключено: {}", ex.label),
                cut,
            });
        }
        banned.extend(ids.iter().copied());
    }

    let tiers: Vec<Vec<i64>> = raw_tiers
        .into_iter()
        .map(|level| {
            level
                .into_iter()
                .filter(|id| !banned.contains(id))
                .collect::<Vec<i64>>()
        })
        .collect();

    let available: i64 = tiers.iter().map(|t| t.len() as i64).sum();

    // Самый крупный отсекатель наверху: это ответ на «почему слот пустой».
    blockers.sort_by(|a, b| b.cut.cmp(&a.cut));

    Ok(SlotPool {
        tiers,
        matched: base_set,
        supply: SlotSupply {
            position,
            slot_label: label.to_string(),
            mod_tag: slot.mod_tag.clone(),
            need,
            matching,
            excluded: (matching - available).max(0),
            available,
            blockers,
            origin,
        },
    })
}

// ──────────────────────────────────────────── уровни источников

/// Уровни источников для слота маппула: своё, потом маппул, серия и шаблон.
///
/// Ниже слота стоит маппул, ниже — серия: так «в основном мои проверенные»
/// настраивается один раз на серию, а отдельный слот при необходимости берёт
/// своё. Коллекция-источник слота шаблона считается уровнем шаблона: она
/// описывает не этот конкретный пул, а структуру, по которой его скатали.
pub fn slot_levels(
    slot_sources: Option<SourceSet>,
    pool: &Pool,
    series_sources: Option<SourceSet>,
    template: Option<&PoolTemplate>,
    template_slot: Option<&TemplateSlot>,
) -> Vec<Level> {
    let mut out: Vec<Level> = vec![
        (slot_sources, "свои".to_string()),
        (pool.sources.clone(), "от маппула".to_string()),
    ];

    match (&pool.series_name, series_sources) {
        (Some(name), Some(set)) => out.push((Some(set), format!("от серии — {name}"))),
        _ => out.push((None, "от серии".to_string())),
    }

    if let Some(cid) = template_slot.and_then(|s| s.source_collection_id) {
        out.push((
            Some(SourceSet {
                items: vec![crate::model::Source::Collection { id: cid }],
                mode: "union".into(),
            }),
            "от шаблона — слот".to_string(),
        ));
    }

    if let Some(t) = template {
        out.push((t.sources.clone(), format!("от шаблона «{}»", t.name)));
    }

    out
}

/// Уровни для генерации по шаблону, когда пула ещё нет: слот шаблона,
/// потом серия (если катаем в неё), потом сам шаблон.
pub fn template_levels(
    template: &PoolTemplate,
    template_slot: &TemplateSlot,
    series: Option<(&str, Option<SourceSet>)>,
) -> Vec<Level> {
    let mut out: Vec<Level> = Vec::new();

    if let Some(cid) = template_slot.source_collection_id {
        out.push((
            Some(SourceSet {
                items: vec![crate::model::Source::Collection { id: cid }],
                mode: "union".into(),
            }),
            "от шаблона — слот".to_string(),
        ));
    }

    if let Some((name, set)) = series {
        out.push((set, format!("от серии — {name}")));
    }

    out.push((
        template.sources.clone(),
        format!("от шаблона «{}»", template.name),
    ));
    out
}

// ─────────────────────────────────────────────────── запас шаблона

/// Сколько карт подходит под каждый слот шаблона. Считается по одному слоту
/// независимо: пересечения между слотами тут не видны, их ловит генерация.
pub fn template_supply(conn: &Connection, template_id: i64) -> Result<Vec<SlotSupply>> {
    let template = templates::get(conn, template_id)?;
    let exclusions = super::exclusions::ready(
        conn,
        &[(super::exclusions::Owner::Template(template_id), None)],
    )?;

    let mut out = Vec::new();
    for slot in &template.slots {
        let levels = template_levels(&template, slot, None);
        let label = super::pools::label_for(&slot.mod_tag, 0);
        let pool = for_slot(
            conn,
            slot,
            &template.rules,
            &label,
            slot.position,
            slot.count,
            &levels,
            &exclusions,
        )?;
        out.push(pool.supply);
    }
    Ok(out)
}
