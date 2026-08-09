//! Генерация маппула по шаблону.
//!
//! Правила из шаблона делятся на две части. Те, что сужают выбор карт
//! (диапазон звёзд, источник, ranked, длина), уходят в SQL — их удобно
//! считать базе. Те, что зависят от уже набранного пула (не повторять
//! маппера, разброс BPM, баланс скилсетов), считаются здесь.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};

use super::{beatmaps, pools, templates};
use crate::error::{AppError, Result};
use crate::model::{GenReport, GenRules, PoolSlot, PoolTemplate};

/// xorshift64*. Криптографии тут не нужно — нужен разный порядок карт
/// при каждом перекате, а внешняя зависимость ради этого лишняя.
struct Rng(u64);

impl Rng {
    fn new() -> Rng {
        let nanos = time::OffsetDateTime::now_utc().unix_timestamp_nanos() as u64;
        // Ноль — неподвижная точка xorshift, поэтому младший бит взводим всегда.
        Rng(nanos | 1)
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn shuffle<T>(&mut self, v: &mut [T]) {
        for i in (1..v.len()).rev() {
            let j = (self.next() % (i as u64 + 1)) as usize;
            v.swap(i, j);
        }
    }
}

/// Карта-кандидат: только то, что нужно правилам.
struct Cand {
    id: i64,
    bpm: Option<f64>,
    creator: Option<String>,
    skills: Vec<String>,
}

struct PlanSlot {
    label: String,
    mod_tag: String,
    /// Индекс списка кандидатов. `None` — слот, которого нет в шаблоне:
    /// карту в него можно только поставить руками.
    source: Option<usize>,
    pinned: bool,
    beatmap_id: Option<i64>,
    fm_mods: Vec<String>,
}

/// Что уже занято набранным пулом.
struct Taken {
    ids: HashSet<i64>,
    /// Именно счётчик, а не множество: при замене карты маппер должен
    /// освобождаться, а не оставаться занятым навсегда.
    mappers: HashMap<String, usize>,
    aim: usize,
    speed: usize,
}

impl Taken {
    fn new() -> Taken {
        Taken {
            ids: HashSet::new(),
            mappers: HashMap::new(),
            aim: 0,
            speed: 0,
        }
    }

    fn add(&mut self, c: &Cand) {
        self.ids.insert(c.id);
        if let Some(m) = &c.creator {
            *self.mappers.entry(m.to_lowercase()).or_insert(0) += 1;
        }
        if c.skills.iter().any(|s| s == "aim") {
            self.aim += 1;
        }
        if c.skills.iter().any(|s| s == "speed") {
            self.speed += 1;
        }
    }

    fn remove(&mut self, c: &Cand) {
        self.ids.remove(&c.id);
        if let Some(m) = &c.creator {
            let key = m.to_lowercase();
            if let Some(n) = self.mappers.get_mut(&key) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    self.mappers.remove(&key);
                }
            }
        }
        if c.skills.iter().any(|s| s == "aim") {
            self.aim = self.aim.saturating_sub(1);
        }
        if c.skills.iter().any(|s| s == "speed") {
            self.speed = self.speed.saturating_sub(1);
        }
    }

    fn free(&self, c: &Cand, rules: &GenRules) -> bool {
        if self.ids.contains(&c.id) {
            return false;
        }
        if rules.no_repeat_mapper {
            if let Some(m) = &c.creator {
                if self.mappers.contains_key(&m.to_lowercase()) {
                    return false;
                }
            }
        }
        true
    }
}

// ────────────────────────────────────────────────────── кандидаты

fn load_candidates(
    conn: &Connection,
    template: &PoolTemplate,
    excluded: &HashSet<i64>,
) -> Result<Vec<Vec<Cand>>> {
    let mut out = Vec::with_capacity(template.slots.len());

    for slot in &template.slots {
        let filter = templates::slot_filter(slot, &template.rules);
        let ids = beatmaps::ids_for(conn, &filter)?;
        let maps = beatmaps::by_ids(conn, &ids)?;

        out.push(
            maps.into_iter()
                .filter(|m| !m.is_gone && !excluded.contains(&m.beatmap_id))
                .map(|m| Cand {
                    id: m.beatmap_id,
                    bpm: m.bpm,
                    creator: m.creator.clone(),
                    skills: m.skillsets.into_iter().map(|s| s.skillset).collect(),
                })
                .collect(),
        );
    }
    Ok(out)
}

/// Звёзды под модом слота, если их успели посчитать на osu!. Пока атрибуты
/// не загружены, остаётся `None`, и в строке показываются базовые звёзды.
fn stars_with_mods(conn: &Connection, beatmap_id: i64, mod_tag: &str) -> Result<Option<f64>> {
    // FM и TB играются без фиксированного мода, NM — без модов вообще.
    let mods = match mod_tag {
        "HD" | "HR" | "DT" | "EZ" => mod_tag,
        _ => "",
    };
    let found: Option<Option<f64>> = conn
        .query_row(
            "SELECT star_rating FROM beatmap_attributes WHERE beatmap_id = ?1 AND mods = ?2",
            params![beatmap_id, mods],
            |r| r.get(0),
        )
        .optional()?;
    Ok(found.flatten())
}

// ─────────────────────────────────────────────────────────── подбор

fn preferred_skill(taken: &Taken) -> Option<&'static str> {
    if taken.aim > taken.speed {
        Some("speed")
    } else if taken.speed > taken.aim {
        Some("aim")
    } else {
        None
    }
}

/// Первый подходящий кандидат из уже перемешанного списка. При балансе
/// скилсетов сначала ищется тот, кого в пуле меньше.
fn pick(cands: &[Cand], taken: &Taken, rules: &GenRules) -> Option<usize> {
    if rules.balance_skillsets {
        if let Some(want) = preferred_skill(taken) {
            let found = cands
                .iter()
                .position(|c| taken.free(c, rules) && c.skills.iter().any(|s| s == want));
            if found.is_some() {
                return found;
            }
        }
    }
    cands.iter().position(|c| taken.free(c, rules))
}

fn bpm_spread(plan: &[PlanSlot], lists: &[Vec<Cand>]) -> Option<(f64, f64)> {
    let mut values: Vec<f64> = Vec::new();
    for slot in plan {
        if let (Some(bid), Some(src)) = (slot.beatmap_id, slot.source) {
            if let Some(c) = lists[src].iter().find(|c| c.id == bid) {
                if let Some(b) = c.bpm {
                    values.push(b);
                }
            }
        }
    }
    if values.len() < 2 {
        return None;
    }
    let lo = values.iter().copied().fold(f64::INFINITY, f64::min);
    let hi = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    Some((lo, hi))
}

/// Разброс BPM — свойство всего пула, а не отдельной карты, поэтому чинится
/// после набора: слоты по очереди пробуют поменять карту на более далёкую
/// по темпу, пока разброс не дотянет до заданного.
fn widen_bpm(
    plan: &mut [PlanSlot],
    lists: &[Vec<Cand>],
    taken: &mut Taken,
    rules: &GenRules,
    want: f64,
) -> f64 {
    let mut best = match bpm_spread(plan, lists) {
        Some((lo, hi)) => hi - lo,
        None => return 0.0,
    };

    for _ in 0..plan.len() {
        if best >= want {
            break;
        }
        let mut moved = false;

        for i in 0..plan.len() {
            if plan[i].pinned {
                continue;
            }
            let Some(src) = plan[i].source else { continue };
            let Some(current_id) = plan[i].beatmap_id else {
                continue;
            };
            let Some(current_pos) = lists[src].iter().position(|c| c.id == current_id) else {
                continue;
            };

            // Кандидата примеряем при снятой текущей карте: иначе её маппер
            // и id считались бы занятыми ей же самой.
            taken.remove(&lists[src][current_pos]);

            let mut chosen: Option<usize> = None;
            for (j, c) in lists[src].iter().enumerate() {
                if c.bpm.is_none() || !taken.free(c, rules) {
                    continue;
                }
                plan[i].beatmap_id = Some(c.id);
                let spread = match bpm_spread(plan, lists) {
                    Some((lo, hi)) => hi - lo,
                    None => 0.0,
                };
                if spread > best + 0.01 {
                    best = spread;
                    chosen = Some(j);
                    if best >= want {
                        break;
                    }
                }
            }

            match chosen {
                Some(j) => {
                    plan[i].beatmap_id = Some(lists[src][j].id);
                    taken.add(&lists[src][j]);
                    moved = true;
                }
                None => {
                    plan[i].beatmap_id = Some(current_id);
                    taken.add(&lists[src][current_pos]);
                }
            }

            if best >= want {
                break;
            }
        }

        if !moved {
            break;
        }
    }

    best
}

/// Заполняет план картами. Возвращает заметки о том, чего выдержать не вышло.
fn run(plan: &mut [PlanSlot], lists: &mut [Vec<Cand>], rules: &GenRules) -> Vec<String> {
    let mut rng = Rng::new();
    for list in lists.iter_mut() {
        rng.shuffle(list);
    }

    let mut taken = Taken::new();

    // Закреплённые слоты занимают своё место до того, как начнётся подбор.
    for slot in plan.iter() {
        if let (Some(bid), Some(src)) = (slot.beatmap_id, slot.source) {
            if let Some(c) = lists[src].iter().find(|c| c.id == bid) {
                taken.add(c);
            } else {
                taken.ids.insert(bid);
            }
        } else if let Some(bid) = slot.beatmap_id {
            taken.ids.insert(bid);
        }
    }

    let mut empty: Vec<String> = Vec::new();

    for i in 0..plan.len() {
        if plan[i].beatmap_id.is_some() {
            continue;
        }
        let Some(src) = plan[i].source else {
            empty.push(plan[i].label.clone());
            continue;
        };

        match pick(&lists[src], &taken, rules) {
            Some(j) => {
                plan[i].beatmap_id = Some(lists[src][j].id);
                taken.add(&lists[src][j]);
            }
            None => empty.push(plan[i].label.clone()),
        }
    }

    let mut notes = Vec::new();

    if !empty.is_empty() {
        notes.push(format!(
            "Карт не хватило на {}. Расширь диапазон звёзд или добавь карт в источник.",
            empty.join(", ")
        ));
    }

    if let Some(want) = rules.min_bpm_spread {
        let got = widen_bpm(plan, lists, &mut taken, rules, want);
        if got + 0.01 < want {
            notes.push(format!(
                "Разброс BPM вышел {got:.0} вместо {want:.0} — карт с другим темпом в источниках нет."
            ));
        }
    }

    notes
}

// ──────────────────────────────────────────────────── сборка плана

/// Слоты шаблона в порядке генерации: TB всегда в конце и всегда один.
fn ordered_slots(template: &PoolTemplate) -> Vec<(usize, i64)> {
    let mut out: Vec<(usize, i64)> = Vec::new();
    let mut tb: Option<usize> = None;

    for (i, s) in template.slots.iter().enumerate() {
        if s.mod_tag == "TB" {
            tb = Some(i);
        } else {
            out.push((i, s.count.max(1)));
        }
    }
    if let Some(i) = tb {
        out.push((i, 1));
    }
    out
}

fn plan_from_template(template: &PoolTemplate) -> Vec<PlanSlot> {
    let mut counters: HashMap<String, usize> = HashMap::new();
    let mut plan = Vec::new();

    for (index, count) in ordered_slots(template) {
        let mod_tag = template.slots[index].mod_tag.clone();
        for _ in 0..count {
            let n = counters.entry(mod_tag.clone()).or_insert(0);
            let label = pools::label_for(&mod_tag, *n);
            *n += 1;
            plan.push(PlanSlot {
                label,
                mod_tag: mod_tag.clone(),
                source: Some(index),
                pinned: false,
                beatmap_id: None,
                fm_mods: Vec::new(),
            });
        }
    }
    plan
}

/// План по уже существующему пулу: структура сохраняется, меняются только карты.
///
/// Слот пула привязывается к слоту шаблона по мод-тегу. Если в шаблоне два
/// слота с одним модом, берётся первый — их источники всё равно описывают
/// один и тот же мод-тег.
fn plan_from_pool(slots: &[PoolSlot], template: &PoolTemplate, keep_pinned: bool) -> Vec<PlanSlot> {
    slots
        .iter()
        .map(|s| {
            let source = template.slots.iter().position(|t| t.mod_tag == s.mod_tag);
            let pinned = keep_pinned && s.pinned;
            PlanSlot {
                label: s.slot_label.clone(),
                mod_tag: s.mod_tag.clone(),
                source,
                pinned,
                beatmap_id: if pinned { s.beatmap_id } else { None },
                fm_mods: s.fm_mods.clone(),
            }
        })
        .collect()
}

fn to_slots(conn: &Connection, plan: &[PlanSlot]) -> Result<Vec<PoolSlot>> {
    let mut out = Vec::with_capacity(plan.len());
    for (i, p) in plan.iter().enumerate() {
        let stars = match p.beatmap_id {
            Some(bid) => stars_with_mods(conn, bid, &p.mod_tag)?,
            None => None,
        };
        out.push(PoolSlot {
            id: 0,
            slot_label: p.label.clone(),
            mod_tag: p.mod_tag.clone(),
            beatmap_id: p.beatmap_id,
            pinned: p.pinned,
            star_rating_with_mods: stars,
            fm_mods: p.fm_mods.clone(),
            position: i as i64,
            beatmap: None,
            warnings: Vec::new(),
        });
    }
    Ok(out)
}

fn excluded_ids(conn: &Connection, rules: &GenRules) -> Result<HashSet<i64>> {
    Ok(pools::beatmaps_in_pools(conn, &rules.no_repeat_from_pools)?
        .into_iter()
        .collect())
}

// ─────────────────────────────────────────────────────────── команды

/// Новый маппул по шаблону.
pub fn generate(conn: &Connection, template_id: i64, name: &str) -> Result<GenReport> {
    let template = templates::get(conn, template_id)?;
    if template.slots.is_empty() {
        return Err(AppError::Other(
            "В шаблоне нет ни одного слота — добавь их в редакторе шаблона".into(),
        ));
    }

    let excluded = excluded_ids(conn, &template.rules)?;
    let mut lists = load_candidates(conn, &template, &excluded)?;
    let mut plan = plan_from_template(&template);
    let notes = run(&mut plan, &mut lists, &template.rules);

    let name = if name.trim().is_empty() {
        template.name.clone()
    } else {
        name.trim().to_string()
    };
    let pool_id = pools::create(conn, &name, Some(template_id))?;
    let slots = to_slots(conn, &plan)?;
    pools::replace_slots(conn, pool_id, &slots)?;

    Ok(GenReport {
        pool: pools::get(conn, pool_id)?,
        notes,
    })
}

/// Перекат существующего пула. `keep_pinned` — не трогать закреплённые слоты.
pub fn reroll(conn: &Connection, pool_id: i64, keep_pinned: bool) -> Result<GenReport> {
    let target = pools::writable(conn, pool_id)?;
    let pool = pools::get(conn, target)?;

    let template_id = pool.template_id.ok_or_else(|| {
        AppError::Other("Этот маппул собран вручную — скатывать его не по чему".into())
    })?;
    let template = templates::get(conn, template_id)?;

    let excluded = excluded_ids(conn, &template.rules)?;
    let mut lists = load_candidates(conn, &template, &excluded)?;
    let mut plan = plan_from_pool(&pool.slots, &template, keep_pinned);
    let notes = run(&mut plan, &mut lists, &template.rules);

    let slots = to_slots(conn, &plan)?;
    pools::replace_slots(conn, target, &slots)?;

    Ok(GenReport {
        pool: pools::get(conn, target)?,
        notes,
    })
}

/// Перекат одного слота: остальные карты остаются на местах и считаются занятыми.
pub fn reroll_slot(conn: &Connection, pool_id: i64, slot_id: i64) -> Result<GenReport> {
    let target = pools::writable(conn, pool_id)?;
    let pool = pools::get(conn, target)?;

    let template_id = pool.template_id.ok_or_else(|| {
        AppError::Other("Этот маппул собран вручную — скатывать его не по чему".into())
    })?;
    let template = templates::get(conn, template_id)?;

    // После подмены сыгранного пула копией id слотов другие, а порядок тот же.
    let index = pool
        .slots
        .iter()
        .position(|s| s.id == slot_id)
        .ok_or_else(|| AppError::Other("Слот не найден".into()))?;

    let excluded = excluded_ids(conn, &template.rules)?;
    let mut lists = load_candidates(conn, &template, &excluded)?;

    let mut plan = plan_from_pool(&pool.slots, &template, true);
    // Все, кроме одного, закреплены на время переката — включая незакреплённые.
    for (i, p) in plan.iter_mut().enumerate() {
        if i == index {
            p.pinned = false;
            p.beatmap_id = None;
        } else {
            p.pinned = true;
            p.beatmap_id = pool.slots[i].beatmap_id;
        }
    }

    let notes = run(&mut plan, &mut lists, &template.rules);

    // Закрепления восстанавливаем: временные ставились только ради подбора.
    for (i, p) in plan.iter_mut().enumerate() {
        p.pinned = pool.slots[i].pinned;
    }

    let slots = to_slots(conn, &plan)?;
    pools::replace_slots(conn, target, &slots)?;

    Ok(GenReport {
        pool: pools::get(conn, target)?,
        notes,
    })
}
