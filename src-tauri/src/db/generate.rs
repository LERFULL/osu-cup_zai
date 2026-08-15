//! Генерация маппула.
//!
//! Порядок работы задан один раз и не меняется от места вызова:
//!
//! 1. набор-кандидат по источникам с учётом режима (`union` / `ordered`);
//! 2. строгие исключения и строгие правила сужают набор — это делает `supply`,
//!    он же считает, что и сколько отсекло;
//! 3. слоты выбирают по возрастанию запаса: самый узкий первым, иначе он
//!    останется без карт, пока широкие расхватают общее;
//! 4. внутри слота выбор случайный, а мягкие правила работают весами, а не
//!    фильтром: слот заполнится, а нарушение попадёт в отчёт;
//! 5. закреплённые слоты не трогаются, их карты вычтены из набора;
//! 6. звёзды берутся под модом слота из кеша атрибутов.
//!
//! Один движок на всё: скатать пул, перекатить пул, перекатить выделенные
//! слоты, скатать серию. Разница только в том, какие слоты считать свободными.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};

use super::exclusions::{Owner, Raw, Ready};
use super::supply::{self, SlotPool};
use super::{beatmaps, exclusions, pools, series, templates};
use crate::error::{AppError, Result};
use crate::model::{
    ExclusionTarget, GenNote, GenReport, GenRules, Pool, PoolSlot, PoolTemplate, SlotSupply,
    SourceSet, TemplateSlot,
};

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

// ─────────────────────────────────────────────────────────── кандидаты

/// Карта-кандидат: только то, что нужно правилам подбора.
struct Cand {
    bpm: Option<f64>,
    creator: Option<String>,
    skills: Vec<String>,
    ranked: bool,
    length: Option<i64>,
}

fn load_cands(conn: &Connection, ids: &HashSet<i64>) -> Result<HashMap<i64, Cand>> {
    let list: Vec<i64> = ids.iter().copied().collect();
    let maps = beatmaps::by_ids(conn, &list)?;

    Ok(maps
        .into_iter()
        .map(|m| {
            (
                m.beatmap_id,
                Cand {
                    bpm: m.bpm,
                    creator: m.creator,
                    skills: m.skillsets.into_iter().map(|s| s.skillset).collect(),
                    ranked: matches!(m.status.as_deref(), Some("ranked") | Some("approved")),
                    length: m.total_length,
                },
            )
        })
        .collect())
}

// ────────────────────────────────────────────────────── правила подбора

/// Строгость правила «два пула одного маппера». `None` — правила нет.
type SameMapper = Option<bool>;

/// Всё, что решает выбор внутри слота.
struct Picking<'a> {
    base: &'a GenRules,
    /// Мягкие исключения по картам: не запрещают, но проигрывают при равных.
    soft: &'a [HashSet<i64>],
    same_mapper: SameMapper,
}

/// Что уже занято набранным пулом.
struct Taken {
    ids: HashSet<i64>,
    /// Маппер → метки слотов, где он уже стоит. Именно метки, а не счётчик:
    /// отчёт должен сказать «Sotarks уже в HD1», а не «маппер повторяется».
    mappers: HashMap<String, Vec<String>>,
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

    fn add(&mut self, id: i64, label: &str, c: Option<&Cand>) {
        self.ids.insert(id);
        let Some(c) = c else { return };
        if let Some(m) = &c.creator {
            self.mappers
                .entry(m.to_lowercase())
                .or_default()
                .push(label.to_string());
        }
        if c.skills.iter().any(|s| s == "aim") {
            self.aim += 1;
        }
        if c.skills.iter().any(|s| s == "speed") {
            self.speed += 1;
        }
    }

    fn release(&mut self, id: i64, label: &str, c: Option<&Cand>) {
        self.ids.remove(&id);
        let Some(c) = c else { return };
        if let Some(m) = &c.creator {
            let key = m.to_lowercase();
            if let Some(places) = self.mappers.get_mut(&key) {
                places.retain(|l| l != label);
                if places.is_empty() {
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

    /// Какого скилсета в пуле меньше. `None` — их поровну.
    fn wanted_skill(&self) -> Option<&'static str> {
        if self.aim > self.speed {
            Some("speed")
        } else if self.speed > self.aim {
            Some("aim")
        } else {
            None
        }
    }

    fn mapper_at(&self, c: &Cand) -> Option<&str> {
        let key = c.creator.as_ref()?.to_lowercase();
        self.mappers.get(&key)?.first().map(String::as_str)
    }
}

/// Можно ли поставить карту вообще. Строгие правила — здесь, мягкие — весами.
fn blocked(id: i64, c: Option<&Cand>, taken: &Taken, p: &Picking) -> bool {
    if taken.ids.contains(&id) {
        return true;
    }
    let Some(c) = c else { return false };
    if p.same_mapper == Some(true) && taken.mapper_at(c).is_some() {
        return true;
    }
    if p.base.balance_skillsets && p.base.balance_skillsets_strict {
        if let Some(want) = taken.wanted_skill() {
            if !c.skills.iter().any(|s| s == want) {
                return true;
            }
        }
    }
    false
}

/// Чем карта хуже идеальной. Ноль — ни одно мягкое правило не нарушено.
fn penalty(id: i64, c: Option<&Cand>, taken: &Taken, p: &Picking) -> i64 {
    let mut out = 0;
    for set in p.soft {
        if set.contains(&id) {
            out += 10;
        }
    }
    let Some(c) = c else { return out };

    if p.same_mapper == Some(false) && taken.mapper_at(c).is_some() {
        out += 8;
    }
    if p.base.ranked_only && !p.base.ranked_only_strict && !c.ranked {
        out += 6;
    }
    if !p.base.length_max_strict {
        if let (Some(max), Some(len)) = (p.base.length_max, c.length) {
            if len > max {
                out += 6;
            }
        }
    }
    if p.base.balance_skillsets && !p.base.balance_skillsets_strict {
        if let Some(want) = taken.wanted_skill() {
            if !c.skills.iter().any(|s| s == want) {
                out += 3;
            }
        }
    }
    out
}

/// Чем именно карта нарушила мягкие правила — строками для отчёта.
/// Считается до того, как карта попала в `taken`: иначе она сама себя
/// объявила бы повтором.
fn broken(
    id: i64,
    c: Option<&Cand>,
    taken: &Taken,
    p: &Picking,
    soft_labels: &[(HashSet<i64>, String)],
) -> Vec<String> {
    let mut out = Vec::new();

    for (ids, label) in soft_labels {
        if ids.contains(&id) {
            out.push(format!("попала под исключение «{label}» (правило мягкое)"));
        }
    }

    let Some(c) = c else { return out };

    if p.same_mapper == Some(false) {
        if let (Some(place), Some(creator)) = (taken.mapper_at(c), c.creator.as_deref()) {
            out.push(format!(
                "маппер повторяется: {creator} уже в {place} (правило мягкое)"
            ));
        }
    }
    if p.base.ranked_only && !p.base.ranked_only_strict && !c.ranked {
        out.push("карта не ranked (правило мягкое)".to_string());
    }
    if !p.base.length_max_strict {
        if let (Some(max), Some(len)) = (p.base.length_max, c.length) {
            if len > max {
                out.push(format!(
                    "длина {} при потолке {} (правило мягкое)",
                    mmss(len),
                    mmss(max)
                ));
            }
        }
    }
    out
}

fn mmss(seconds: i64) -> String {
    let s = seconds.max(0);
    format!("{}:{:02}", s / 60, s % 60)
}

/// Лучшая карта уровня: минимальный штраф, при равных — первая. Списки
/// перемешаны заранее, поэтому «первая из равных» и есть случайный выбор.
fn best(level: &[i64], cands: &HashMap<i64, Cand>, taken: &Taken, p: &Picking) -> Option<i64> {
    let mut found: Option<(i64, i64)> = None;
    for id in level {
        let c = cands.get(id);
        if blocked(*id, c, taken, p) {
            continue;
        }
        let score = penalty(*id, c, taken, p);
        if score == 0 {
            return Some(*id);
        }
        let better = match found {
            Some((_, best)) => score < best,
            None => true,
        };
        if better {
            found = Some((*id, score));
        }
    }
    found.map(|(id, _)| id)
}

/// Выбор по уровням приоритета: `ordered` берёт из первого источника, и только
/// если там не нашлось — из второго. `union` — один уровень на всё.
fn pick(
    tiers: &[Vec<i64>],
    cands: &HashMap<i64, Cand>,
    taken: &Taken,
    p: &Picking,
) -> Option<i64> {
    tiers.iter().find_map(|level| best(level, cands, taken, p))
}

// ─────────────────────────────────────────────────────────────── план

/// Слот в работе: где он стоит, чем занят и из какого набора выбирает.
struct Slot {
    label: String,
    mod_tag: String,
    fm_mods: Vec<String>,
    sources: Option<SourceSet>,
    /// Индекс набора кандидатов. Слоты с одинаковыми условиями делят один.
    group: usize,
    /// Слот держит свою карту и не перекатывается.
    held: bool,
    /// Закрепление как оно хранится, а не как оно нужно этому перекату.
    pinned: bool,
    beatmap_id: Option<i64>,
}

/// Какие слоты перекатываем. Остальные держат карты и считаются занятыми.
pub enum Scope {
    /// Все слоты заново — закрепления не спасают.
    All,
    /// Все, кроме закреплённых.
    Unpinned,
    /// Только эти позиции. Остальные держат карты, даже незакреплённые.
    Only(Vec<i64>),
}

impl Scope {
    fn holds(&self, slot: &PoolSlot) -> bool {
        match self {
            Scope::All => false,
            Scope::Unpinned => slot.pinned,
            Scope::Only(positions) => !positions.contains(&slot.position),
        }
    }
}

/// Слот шаблона под мод-тег. У пула, собранного руками, шаблона нет — тогда
/// слот описывается одним мод-тегом без прочих условий.
fn template_slot_for(template: Option<&PoolTemplate>, mod_tag: &str) -> TemplateSlot {
    if let Some(found) = template.and_then(|t| t.slots.iter().find(|s| s.mod_tag == mod_tag)) {
        return found.clone();
    }
    TemplateSlot {
        id: 0,
        mod_tag: mod_tag.to_string(),
        count: 1,
        star_min: None,
        star_max: None,
        source_collection_id: None,
        required_skillsets: Vec::new(),
        position: 0,
    }
}

// ──────────────────────────────────────────── исключения и источники

/// Уровни исключений для пула: унаследованные сверху, потом свои.
///
/// Исключение серии применяется ко всем её пулам и на уровне пула не
/// отключается — только выключается у самой серии. Поэтому оно и стоит
/// выше: в списке видно, что оно пришло не отсюда.
fn exclusion_levels(pool: &Pool) -> Vec<(Owner, Option<String>)> {
    let mut out = Vec::new();

    if let Some(id) = pool.series_id {
        let name = pool.series_name.clone().unwrap_or_else(|| "серия".into());
        out.push((Owner::Series(id), Some(format!("серия «{name}»"))));
    }
    if let Some(id) = pool.template_id {
        let name = pool
            .template_name
            .clone()
            .unwrap_or_else(|| "шаблон".into());
        out.push((Owner::Template(id), Some(format!("шаблон «{name}»"))));
    }
    out.push((Owner::Pool(pool.id), None));
    out
}

/// Строгость правила «два пула одного маппера» по собранным исключениям.
/// Строгое перебивает мягкое: если оно задано и там и там, работает строгое.
fn same_mapper_of(ready: &[Ready]) -> SameMapper {
    let mut out: SameMapper = None;
    for r in ready.iter().filter(|r| r.live()) {
        if r.raw.target == ExclusionTarget::SameMapperInside {
            out = Some(out.unwrap_or(false) || r.raw.strict);
        }
    }
    out
}

/// Карты, занятые другими пулами серии, — как обычное строгое исключение.
///
/// Собирается синтетически, а не строкой в таблице: правило живёт у серии
/// переключателем `no_repeat_inside`, но считать и объяснять его удобнее тем
/// же механизмом, что и остальные исключения — тогда оно попадёт и в
/// `blockers`, и в отчёт с числом отсечённых карт.
fn series_ban(conn: &Connection, pool: &Pool) -> Result<Option<Ready>> {
    let Some(series_id) = pool.series_id else {
        return Ok(None);
    };

    let no_repeat: bool = conn
        .query_row(
            "SELECT no_repeat_inside FROM series WHERE id = ?1",
            params![series_id],
            |r| Ok(r.get::<_, i64>(0)? != 0),
        )
        .optional()?
        .unwrap_or(false);
    if !no_repeat {
        return Ok(None);
    }

    let others: Vec<i64> = series::live_pool_ids(conn, series_id)?
        .into_iter()
        .filter(|id| *id != pool.id)
        .collect();
    let ids = pools::beatmaps_in_pools(conn, &others)?;
    if ids.is_empty() {
        return Ok(None);
    }

    Ok(Some(Ready {
        raw: Raw {
            id: 0,
            target: ExclusionTarget::Beatmaps { ids: ids.clone() },
            strict: true,
            enabled: true,
        },
        label: "уже в других пулах серии".to_string(),
        inherited_from: pool.series_name.clone().map(|n| format!("серия «{n}»")),
        missing: false,
        ids: Some(ids.into_iter().collect()),
    }))
}

/// Наборы кандидатов для слотов пула. Слоты с одинаковыми условиями делят
/// один набор: считать его двенадцать раз на пул из четырёх NM незачем.
fn groups_for(
    conn: &Connection,
    pool: &Pool,
    template: Option<&PoolTemplate>,
    series_sources: Option<&SourceSet>,
    ready: &[Ready],
) -> Result<(Vec<SlotPool>, Vec<usize>)> {
    let mut pools_out: Vec<SlotPool> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut per_slot = Vec::with_capacity(pool.slots.len());

    for slot in &pool.slots {
        let own = match &slot.sources {
            Some(set) => serde_json::to_string(set)?,
            None => String::new(),
        };
        let key = format!("{}|{own}", slot.mod_tag);

        if let Some(found) = index.get(&key) {
            per_slot.push(*found);
            continue;
        }

        let tpl_slot = template_slot_for(template, &slot.mod_tag);
        let levels = supply::slot_levels(
            slot.sources.clone(),
            pool,
            series_sources.cloned(),
            template,
            Some(&tpl_slot),
        );
        let rules = template.map(|t| t.rules.clone()).unwrap_or_default();

        let built = supply::for_slot(
            conn,
            &tpl_slot,
            &rules,
            &slot.slot_label,
            slot.position,
            1,
            &levels,
            ready,
        )?;

        index.insert(key, pools_out.len());
        per_slot.push(pools_out.len());
        pools_out.push(built);
    }

    Ok((pools_out, per_slot))
}

// ─────────────────────────────────────────────────────── разброс BPM

fn spread_of(slots: &[Slot], cands: &HashMap<i64, Cand>) -> Option<(f64, f64)> {
    let values: Vec<f64> = slots
        .iter()
        .filter_map(|s| s.beatmap_id)
        .filter_map(|id| cands.get(&id)?.bpm)
        .collect();
    if values.len() < 2 {
        return None;
    }
    Some((
        values.iter().copied().fold(f64::INFINITY, f64::min),
        values.iter().copied().fold(f64::NEG_INFINITY, f64::max),
    ))
}

fn width(slots: &[Slot], cands: &HashMap<i64, Cand>) -> f64 {
    match spread_of(slots, cands) {
        Some((lo, hi)) => hi - lo,
        None => 0.0,
    }
}

/// Разброс BPM — свойство всего пула, а не отдельной карты, поэтому чинится
/// после набора: свободные слоты по очереди пробуют карту с более далёким
/// темпом, пока разброс не дотянет до заданного.
fn widen_bpm(
    slots: &mut [Slot],
    groups: &[SlotPool],
    cands: &HashMap<i64, Cand>,
    taken: &mut Taken,
    p: &Picking,
    want: f64,
) -> f64 {
    let mut best_width = width(slots, cands);

    // Проходов не больше, чем слотов: каждый проход обязан что-то улучшить,
    // иначе дальше улучшать нечем.
    for _ in 0..slots.len() {
        if best_width >= want {
            break;
        }
        let mut moved = false;

        for i in 0..slots.len() {
            if slots[i].held {
                continue;
            }
            let Some(current) = slots[i].beatmap_id else {
                continue;
            };
            let label = slots[i].label.clone();

            // Кандидата примеряем при снятой текущей карте: иначе её маппер
            // и id считались бы занятыми ей же самой.
            taken.release(current, &label, cands.get(&current));

            let mut chosen: Option<i64> = None;
            for level in &groups[slots[i].group].tiers {
                for id in level {
                    let c = cands.get(id);
                    if c.and_then(|c| c.bpm).is_none() || blocked(*id, c, taken, p) {
                        continue;
                    }
                    slots[i].beatmap_id = Some(*id);
                    if width(slots, cands) > best_width + 0.01 {
                        best_width = width(slots, cands);
                        chosen = Some(*id);
                        if best_width >= want {
                            break;
                        }
                    }
                }
                if best_width >= want {
                    break;
                }
            }

            let final_id = chosen.unwrap_or(current);
            slots[i].beatmap_id = Some(final_id);
            taken.add(final_id, &label, cands.get(&final_id));
            if chosen.is_some() {
                moved = true;
            }

            if best_width >= want {
                break;
            }
        }

        if !moved {
            break;
        }
    }

    best_width
}

// ─────────────────────────────────────────────────────────── движок

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

fn to_slots(conn: &Connection, slots: &[Slot]) -> Result<Vec<PoolSlot>> {
    let mut out = Vec::with_capacity(slots.len());
    for (i, s) in slots.iter().enumerate() {
        let stars = match s.beatmap_id {
            Some(bid) => stars_with_mods(conn, bid, &s.mod_tag)?,
            None => None,
        };
        out.push(PoolSlot {
            id: 0,
            slot_label: s.label.clone(),
            mod_tag: s.mod_tag.clone(),
            beatmap_id: s.beatmap_id,
            pinned: s.pinned,
            star_rating_with_mods: stars,
            fm_mods: s.fm_mods.clone(),
            position: i as i64,
            sources: s.sources.clone(),
            beatmap: None,
            warnings: Vec::new(),
        })
    }
    Ok(out)
}

/// Подбор карт в пул. Единственное место, где решается, что куда встанет.
///
/// `scope` говорит, какие слоты свободны. Всё остальное — состав пула, его
/// серия, шаблон, источники и исключения — читается из базы: держать это в
/// аргументах значит однажды передать не то.
pub fn fill(conn: &Connection, pool_id: i64, scope: Scope) -> Result<GenReport> {
    let pool = pools::get(conn, pool_id)?;
    if pool.slots.is_empty() {
        return Err(AppError::Other(
            "В маппуле нет слотов — добавь их или скатай пул по шаблону".into(),
        ));
    }

    let template = match pool.template_id {
        Some(id) => Some(templates::get(conn, id)?),
        None => None,
    };
    let rules = template
        .as_ref()
        .map(|t| t.rules.clone())
        .unwrap_or_default();

    let series_sources = match pool.series_id {
        Some(id) => series::get(conn, id)?.sources,
        None => None,
    };

    let mut ready = exclusions::ready(conn, &exclusion_levels(&pool))?;
    if let Some(ban) = series_ban(conn, &pool)? {
        ready.push(ban);
    }

    // Карты из слотов, которые сейчас освобождаются, снова свободны. Без этого
    // пул, исключающий свою же серию, перекатом опустошал бы себя: его старые
    // карты попадали бы в запрет за миг до того, как их снимут со слотов.
    let released: HashSet<i64> = pool
        .slots
        .iter()
        .filter(|s| !scope.holds(s))
        .filter_map(|s| s.beatmap_id)
        .collect();
    if !released.is_empty() {
        for r in ready.iter_mut() {
            if let Some(ids) = r.ids.as_mut() {
                ids.retain(|id| !released.contains(id));
            }
        }
    }

    let same_mapper = same_mapper_of(&ready);

    let (mut groups, per_slot) =
        groups_for(conn, &pool, template.as_ref(), series_sources.as_ref(), &ready)?;

    // Мягкие исключения одинаковы для всех слотов пула: они про карты, а не
    // про условия слота. Подписи нужны отчёту, множества — весам подбора.
    let soft_labels: Vec<(HashSet<i64>, String)> = ready
        .iter()
        .filter(|r| r.live() && !r.raw.strict)
        .filter_map(|r| r.ids.clone().map(|ids| (ids, r.label.clone())))
        .collect();
    let soft: Vec<HashSet<i64>> = soft_labels.iter().map(|(ids, _)| ids.clone()).collect();

    let picking = Picking {
        base: &rules,
        soft: &soft,
        same_mapper,
    };

    // Порядок внутри уровня перемешиваем один раз: дальше «первый из равных»
    // и есть случайный выбор.
    let mut rng = Rng::new();
    for group in groups.iter_mut() {
        for level in group.tiers.iter_mut() {
            rng.shuffle(level);
        }
    }

    let mut slots: Vec<Slot> = pool
        .slots
        .iter()
        .zip(per_slot.iter())
        .map(|(s, group)| {
            let held = scope.holds(s);
            Slot {
                label: s.slot_label.clone(),
                mod_tag: s.mod_tag.clone(),
                fm_mods: s.fm_mods.clone(),
                sources: s.sources.clone(),
                group: *group,
                held,
                pinned: s.pinned,
                beatmap_id: if held { s.beatmap_id } else { None },
            }
        })
        .collect();

    // Все ids кандидатов и уже стоящие карты: правилам нужны их свойства.
    let mut wanted: HashSet<i64> = groups
        .iter()
        .flat_map(|g| g.tiers.iter().flatten().copied())
        .collect();
    wanted.extend(slots.iter().filter_map(|s| s.beatmap_id));
    let cands = load_cands(conn, &wanted)?;

    let mut taken = Taken::new();
    for s in &slots {
        if let Some(id) = s.beatmap_id {
            taken.add(id, &s.label, cands.get(&id));
        }
    }

    // Самый узкий слот выбирает первым: иначе он останется без карт, пока
    // широкие расхватают общее.
    let mut order: Vec<usize> = (0..slots.len()).filter(|i| !slots[*i].held).collect();
    order.sort_by_key(|i| (groups[slots[*i].group].available(), *i));

    let mut notes: Vec<GenNote> = Vec::new();

    for i in order {
        let group = slots[i].group;
        let label = slots[i].label.clone();
        match pick(&groups[group].tiers, &cands, &taken, &picking) {
            Some(id) => {
                for text in broken(id, cands.get(&id), &taken, &picking, &soft_labels) {
                    notes.push(GenNote {
                        pool_id: Some(pool.id),
                        pool_name: pool.name.clone(),
                        slot_label: Some(label.clone()),
                        text: format!("взят с нарушением: {text}"),
                        strict: false,
                        blockers: Vec::new(),
                    });
                }
                slots[i].beatmap_id = Some(id);
                taken.add(id, &label, cands.get(&id));
            }
            None => {
                let supply = &groups[group].supply;
                notes.push(GenNote {
                    pool_id: Some(pool.id),
                    pool_name: pool.name.clone(),
                    slot_label: Some(label),
                    text: empty_text(supply),
                    strict: true,
                    blockers: supply.blockers.clone(),
                });
            }
        }
    }

    if let Some(want) = rules.min_bpm_spread {
        let got = widen_bpm(&mut slots, &groups, &cands, &mut taken, &picking, want);
        if got + 0.01 < want {
            notes.push(GenNote {
                pool_id: Some(pool.id),
                pool_name: pool.name.clone(),
                slot_label: None,
                text: format!(
                    "разброс BPM вышел {got:.0} вместо {want:.0} — карт с другим темпом \
                     в источниках нет"
                ),
                strict: rules.min_bpm_spread_strict,
                blockers: Vec::new(),
            });
        }
    }

    let written = to_slots(conn, &slots)?;
    pools::replace_slots(conn, pool_id, &written)?;

    // Заметки идут в порядке слотов: читать отчёт сверху вниз вместе с пулом
    // удобнее, чем в порядке, в котором слоты выбирали.
    let rank: HashMap<String, usize> = slots
        .iter()
        .enumerate()
        .map(|(i, s)| (s.label.clone(), i))
        .collect();
    notes.sort_by_key(|n| match &n.slot_label {
        Some(label) => rank.get(label).copied().unwrap_or(usize::MAX - 1),
        None => usize::MAX,
    });

    Ok(GenReport {
        pool: pools::get(conn, pool_id)?,
        notes,
    })
}

/// Почему слот пустой. Без цифр это «мало карт», а с цифрами — рабочая
/// подсказка: что именно расширить.
fn empty_text(supply: &SlotSupply) -> String {
    let mut out = format!("пустой: под правила подходит {} карт", supply.available);
    if !supply.blockers.is_empty() {
        let list: Vec<String> = supply
            .blockers
            .iter()
            .take(3)
            .map(|b| format!("{} (−{})", b.reason, b.cut))
            .collect();
        out.push_str(&format!(". Отсекли: {}", list.join(", ")));
    }
    out
}

// ─────────────────────────────────────────────────────────── команды

/// Пустые слоты по шаблону: структура будущего пула без карт.
fn blank_slots(template: &PoolTemplate) -> Vec<PoolSlot> {
    // TB всегда последний и всегда один — это правило пула, а не оформление.
    let mut ordered: Vec<&TemplateSlot> = Vec::new();
    let mut tb: Option<&TemplateSlot> = None;
    for slot in &template.slots {
        if slot.mod_tag == "TB" {
            tb = Some(slot);
        } else {
            ordered.push(slot);
        }
    }
    if let Some(slot) = tb {
        ordered.push(slot);
    }

    let mut counters: HashMap<String, usize> = HashMap::new();
    let mut out = Vec::new();

    for slot in ordered {
        let times = if slot.mod_tag == "TB" {
            1
        } else {
            slot.count.clamp(1, 32)
        };
        for _ in 0..times {
            let n = counters.entry(slot.mod_tag.clone()).or_insert(0);
            let label = pools::label_for(&slot.mod_tag, *n);
            *n += 1;
            out.push(PoolSlot {
                id: 0,
                slot_label: label,
                mod_tag: slot.mod_tag.clone(),
                beatmap_id: None,
                pinned: false,
                star_rating_with_mods: None,
                fm_mods: Vec::new(),
                position: out.len() as i64,
                sources: None,
                beatmap: None,
                warnings: Vec::new(),
            });
        }
    }
    out
}

/// Новый маппул по шаблону. `series_id` — сразу положить его в серию: тогда
/// правила серии и её исключения действуют уже на первую генерацию.
pub fn generate(
    conn: &Connection,
    template_id: i64,
    name: &str,
    series_id: Option<i64>,
) -> Result<GenReport> {
    let template = templates::get(conn, template_id)?;
    if template.slots.is_empty() {
        return Err(AppError::Other(
            "В шаблоне нет ни одного слота — добавь их в редакторе шаблона".into(),
        ));
    }

    let name = if name.trim().is_empty() {
        template.name.clone()
    } else {
        name.trim().to_string()
    };

    let pool_id = pools::create(conn, &name, Some(template_id))?;
    if let Some(sid) = series_id {
        // Пул пока пуст, повторов быть не может — список конфликтов игнорируем.
        series::add_pool(conn, sid, pool_id)?;
    }
    pools::replace_slots(conn, pool_id, &blank_slots(&template))?;

    fill(conn, pool_id, Scope::All)
}

/// Серия маппулов под турнир: создаётся сама серия и `count` пулов в ней.
///
/// Собирать их по одному неудобно и опасно: карта, попавшая в два пула одного
/// турнира, всплывёт дважды, а уследить за этим руками нельзя. Внутри серии
/// карты не повторяются, и каждый следующий пул катается с оглядкой на все
/// предыдущие.
pub fn generate_series(
    conn: &Connection,
    template_id: i64,
    series_name: &str,
    count: i64,
) -> Result<Vec<GenReport>> {
    if count < 1 {
        return Err(AppError::Other("Не задано ни одного маппула".into()));
    }
    if count > 24 {
        return Err(AppError::Other(
            "Больше двадцати четырёх маппулов за раз — это точно опечатка".into(),
        ));
    }

    let template = templates::get(conn, template_id)?;
    let name = if series_name.trim().is_empty() {
        template.name.clone()
    } else {
        series_name.trim().to_string()
    };

    let series_id = series::create(conn, &name, "tournament")?;

    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count {
        let pool_name = format!("{name} — {}", series::default_label(i as usize));
        out.push(generate(conn, template_id, &pool_name, Some(series_id))?);
    }
    Ok(out)
}

/// Скатать серию целиком. Пулы катаются по позиции, карты каждого следующего
/// вычитаются из набора для остальных.
///
/// Незакреплённые слоты всех пулов сначала освобождаются: иначе первый пул
/// считал бы занятыми старые карты последнего и сам себе сузил бы выбор.
pub fn roll_series(conn: &Connection, series_id: i64, keep_pinned: bool) -> Result<Vec<GenReport>> {
    let ids = series::live_pool_ids(conn, series_id)?;
    if ids.is_empty() {
        return Err(AppError::Other("В серии нет маппулов".into()));
    }

    // Сыгранные пулы уводим в новые версии до начала катания: иначе позиции
    // в серии поехали бы на середине прохода.
    let mut targets = Vec::with_capacity(ids.len());
    for id in ids {
        targets.push(pools::writable(conn, id)?);
    }

    for id in &targets {
        clear(conn, *id, keep_pinned)?;
    }

    let mut out = Vec::with_capacity(targets.len());
    for id in &targets {
        out.push(fill(
            conn,
            *id,
            if keep_pinned {
                Scope::Unpinned
            } else {
                Scope::All
            },
        )?);
    }
    Ok(out)
}

/// Освободить слоты перед катанием серии.
fn clear(conn: &Connection, pool_id: i64, keep_pinned: bool) -> Result<()> {
    let sql = if keep_pinned {
        "UPDATE pool_slots SET beatmap_id = NULL, star_rating_with_mods = NULL
          WHERE pool_id = ?1 AND pinned = 0"
    } else {
        "UPDATE pool_slots SET beatmap_id = NULL, star_rating_with_mods = NULL WHERE pool_id = ?1"
    };
    conn.execute(sql, params![pool_id])?;
    Ok(())
}

/// Перекат существующего пула. `keep_pinned` — не трогать закреплённые слоты.
pub fn reroll(conn: &Connection, pool_id: i64, keep_pinned: bool) -> Result<GenReport> {
    let target = pools::writable(conn, pool_id)?;
    require_template(conn, target)?;
    fill(
        conn,
        target,
        if keep_pinned {
            Scope::Unpinned
        } else {
            Scope::All
        },
    )
}

/// Перекат выделенных слотов: остальные карты остаются на местах и считаются
/// занятыми — включая незакреплённые.
pub fn reroll_slots(conn: &Connection, pool_id: i64, positions: &[i64]) -> Result<GenReport> {
    if positions.is_empty() {
        return Err(AppError::Other("Не выбрано ни одного слота".into()));
    }
    let target = pools::writable(conn, pool_id)?;
    require_template(conn, target)?;
    fill(conn, target, Scope::Only(positions.to_vec()))
}

/// Пул, собранный руками, скатывать не по чему: у него нет ни диапазонов
/// звёзд, ни правил — только строки, которые расставили сами.
fn require_template(conn: &Connection, pool_id: i64) -> Result<()> {
    let has: Option<i64> = conn
        .query_row(
            "SELECT template_id FROM pools WHERE id = ?1",
            params![pool_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();

    if has.is_none() {
        return Err(AppError::Other(
            "Этот маппул собран вручную — скатывать его не по чему".into(),
        ));
    }
    Ok(())
}

// ────────────────────────────────────────────── что применяется к пулу

/// Источники, исключения, правила и запас по слотам — то, что показывает
/// панель «Откуда берём».
pub fn whence(conn: &Connection, pool_id: i64) -> Result<crate::model::PoolWhence> {
    let pool = pools::get(conn, pool_id)?;

    let template = match pool.template_id {
        Some(id) => Some(templates::get(conn, id)?),
        None => None,
    };
    let rules = template
        .as_ref()
        .map(|t| t.rules.clone())
        .unwrap_or_default();
    let rules_origin = match &template {
        Some(t) => format!("от шаблона «{}»", t.name),
        None => "своих правил нет — пул собран вручную".to_string(),
    };

    let (series_sources, series_label) = match pool.series_id {
        Some(id) => {
            let s = series::get(conn, id)?;
            (s.sources, Some(s.name))
        }
        None => (None, None),
    };

    let mut ready = exclusions::ready(conn, &exclusion_levels(&pool))?;
    if let Some(ban) = series_ban(conn, &pool)? {
        ready.push(ban);
    }

    let (groups, per_slot) =
        groups_for(conn, &pool, template.as_ref(), series_sources.as_ref(), &ready)?;

    // Запас — строка на слот, с его меткой и позицией. Наборы общие, поэтому
    // числа у одинаковых слотов совпадают: они и правда тянут из одного места.
    let supply: Vec<SlotSupply> = pool
        .slots
        .iter()
        .zip(per_slot.iter())
        .map(|(slot, group)| {
            let mut row = groups[*group].supply.clone();
            row.position = slot.position;
            row.slot_label = slot.slot_label.clone();
            row.need = 1;
            row
        })
        .collect();

    // Число отсечённого считаем от набора до исключений: в панели одна строка
    // на исключение, и она отвечает на «сколько ты у меня забрал». От уже
    // урезанного набора ответ всегда выходил бы нулевым.
    let all: HashSet<i64> = groups.iter().flat_map(|g| g.matched.iter().copied()).collect();

    let mut levels: Vec<supply::Level> = vec![
        (pool.sources.clone(), "свои".to_string()),
        (
            series_sources,
            match &series_label {
                Some(name) => format!("от серии — {name}"),
                None => "от серии".to_string(),
            },
        ),
    ];
    if let Some(t) = &template {
        levels.push((t.sources.clone(), format!("от шаблона «{}»", t.name)));
    }

    let stars_pending = pool
        .slots
        .iter()
        .filter(|s| s.beatmap_id.is_some() && s.star_rating_with_mods.is_none())
        .count() as i64;

    Ok(crate::model::PoolWhence {
        sources: super::sources::effective(
            conn,
            &levels
                .iter()
                .map(|(set, origin)| (set.clone(), origin.as_str()))
                .collect::<Vec<_>>(),
        )?,
        exclusions: exclusions::to_model(&ready, &all),
        rules,
        rules_origin,
        supply,
        stars_pending,
    })
}

/// Что показывать в панели подбора карты: фильтр слота и то, что исключения
/// из него убрали.
///
/// Скрытые карты именно скрыты, а не выброшены: строка «скрыто 74 карты по
/// исключениям» с кнопкой «показать всё» честнее, чем молча урезанный список.
pub fn slot_candidates(
    conn: &Connection,
    pool_id: i64,
    position: i64,
) -> Result<crate::model::SlotPicker> {
    let pool = pools::get(conn, pool_id)?;
    let index = pools::index_at(&pool.slots, position)?;
    let slot = &pool.slots[index];

    let template = match pool.template_id {
        Some(id) => Some(templates::get(conn, id)?),
        None => None,
    };
    let rules = template
        .as_ref()
        .map(|t| t.rules.clone())
        .unwrap_or_default();
    let tpl_slot = template_slot_for(template.as_ref(), &slot.mod_tag);

    let series_sources = match pool.series_id {
        Some(id) => series::get(conn, id)?.sources,
        None => None,
    };

    let mut ready = exclusions::ready(conn, &exclusion_levels(&pool))?;
    if let Some(ban) = series_ban(conn, &pool)? {
        ready.push(ban);
    }

    let levels = supply::slot_levels(
        slot.sources.clone(),
        &pool,
        series_sources,
        template.as_ref(),
        Some(&tpl_slot),
    );
    let built = supply::for_slot(
        conn,
        &tpl_slot,
        &rules,
        &slot.slot_label,
        slot.position,
        1,
        &levels,
        &ready,
    )?;

    let allowed: HashSet<i64> = built.tiers.iter().flatten().copied().collect();

    // Карты, которые прошли условия слота, но отсечены исключениями. Именно
    // их и скрывает панель по умолчанию.
    let mut hidden: Vec<i64> = Vec::new();
    for r in ready.iter().filter(|r| r.live() && r.raw.strict) {
        let Some(ids) = &r.ids else { continue };
        for id in ids {
            if !allowed.contains(id) {
                hidden.push(*id);
            }
        }
    }
    hidden.sort_unstable();
    hidden.dedup();

    Ok(crate::model::SlotPicker {
        filter: templates::slot_filter(&tpl_slot, &rules),
        available: allowed.len() as i64,
        hidden,
        origin: built.supply.origin,
    })
}
