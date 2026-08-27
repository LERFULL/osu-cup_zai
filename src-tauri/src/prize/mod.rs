//! Призовой фонд: движки, надстройки и проверки. Чистый модуль без SQLite —
//! всё, что ему нужно, приходит структурой, поэтому математика проверяется
//! тестами без базы.
//!
//! Деньги — целые рубли. Единственное дробное число — цена карты движка
//! «за карты»: она нормируется на ожидаемое число карт и потому не обязана
//! быть целой, а выплаты округляются вниз и оттого не падают.
//!
//! Проверка лестницы считается динамикой по собственному пути игрока:
//! исходов у сетки на шестнадцать игроков около миллиарда, а путей — десятки,
//! и заработок зависит только от них.

use std::collections::HashMap;

use crate::model::{
    BountyEvent, BountyHead, LadderCheck, MapPrice, MatchPaymentsCfg, PlaceLadder, PrizeConfig,
    PrizeEngineCfg, PrizeRow, PrizeView, RookieRow, RoundPrice,
};

// ───────────────────────────────────────────────────── форма сетки

/// Матч таким, каким его видит фонд: связи, результат и счёт по картам.
#[derive(Debug, Clone, Default)]
pub struct ShapeMatch {
    pub id: i64,
    pub bracket: String,
    pub round: i64,
    pub slot: i64,
    /// Матч, куда идёт победитель. `None` — выше некуда.
    pub next_win: Option<i64>,
    /// Матч, куда падает проигравший. `None` — выбыл из турнира.
    pub next_lose: Option<i64>,
    pub seed_a: Option<i64>,
    pub seed_b: Option<i64>,
    /// Сид победителя, если матч сыгран.
    pub winner_seed: Option<i64>,
    /// Сыгран технической победой: денег не приносит.
    pub walkover: bool,
    pub finished: bool,
    /// Матч идёт прямо сейчас: у него есть обе стороны и счёт ещё открыт.
    /// Живые выплаты движка «за карты» идут и по такому матчу — число на
    /// экране растёт по ходу игры, а не появляется в конце.
    pub running: bool,
    /// До скольких побед.
    pub target: i64,
    /// Карт, выигранных каждой стороной.
    pub maps_a: i64,
    pub maps_b: i64,
}

impl ShapeMatch {
    /// Сид проигравшего, если матч сыгран.
    pub fn loser_seed(&self) -> Option<i64> {
        if !self.finished || self.winner_seed.is_none() {
            return None;
        }
        match self.winner_seed {
            Some(s) if Some(s) == self.seed_a => self.seed_b,
            _ => self.seed_a,
        }
    }
}

/// Участник глазами фонда.
#[derive(Debug, Clone)]
pub struct ShapePlayer {
    pub player_id: i64,
    pub nickname: String,
    pub color: String,
    pub seed: Option<i64>,
    pub rookie: bool,
    /// Итоговое или текущее место. `None` — ещё играет.
    pub place: Option<i64>,
}

/// Вход расчёта: форма, участники и конфиг.
pub struct Input<'a> {
    /// Фактические матчи: по ним идут живые выплаты.
    pub matches: &'a [ShapeMatch],
    /// Каноническая сетка того же размера, без срезки: по ней идёт проверка
    /// лестницы. Скидки без игры меняют пути, и проверка на неполной сетке
    /// ловила бы артефакты состава, а не ошибки конфигурации.
    pub ladder_matches: &'a [ShapeMatch],
    pub players: &'a [ShapePlayer],
    pub config: &'a PrizeConfig,
    /// Джекпот приложения на сейчас.
    pub jackpot_now: i64,
    pub finished: bool,
    /// Отмеченный лучший матч: (id, подпись).
    pub best_match: Option<(i64, String)>,
}

// ───────────────────────────────────────────────────────── нормировка

/// Разложение целой суммы по весам без потери рубля.
pub fn apportion(total: i64, weights: &[f64]) -> Vec<i64> {
    if weights.is_empty() || total <= 0 {
        return vec![0; weights.len()];
    }
    let sum: f64 = weights.iter().sum();
    if sum <= 0.0 {
        return vec![0; weights.len()];
    }

    let exact: Vec<f64> = weights.iter().map(|w| total as f64 * w / sum).collect();
    let floors: Vec<i64> = exact.iter().map(|x| x.floor() as i64).collect();
    let mut left = total - floors.iter().sum::<i64>();

    // Кто больше потерял на округлении, тому и остаток.
    let mut order: Vec<usize> = (0..weights.len()).collect();
    order.sort_by(|&a, &b| {
        let fa = exact[a].fract();
        let fb = exact[b].fract();
        fb.partial_cmp(&fa).unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut out = floors;
    let mut i = 0;
    while left > 0 && !order.is_empty() {
        out[order[i % order.len()]] += 1;
        left -= 1;
        i += 1;
    }
    out
}

fn floor_money(x: f64) -> i64 {
    if x.is_finite() && x > 0.0 {
        x.floor() as i64
    } else {
        0
    }
}

fn by_seed(players: &[ShapePlayer], seed: i64) -> Option<usize> {
    players.iter().position(|p| p.seed == Some(seed))
}

/// Группа сида для множителя за андердога: 1–2 / 3–4 / 5–8 / 9–16 / 17–32.
pub fn seed_group(seed: i64) -> i64 {
    match seed {
        1..=2 => 0,
        3..=4 => 1,
        5..=8 => 2,
        9..=16 => 3,
        _ => 4,
    }
}

/// Ступень множителя за андердога по разнице групп сидов.
pub fn underdog_step(winner_seed: i64, loser_seed: i64) -> f64 {
    match seed_group(winner_seed) - seed_group(loser_seed) {
        1 => 1.5,
        2 => 2.0,
        d if d >= 3 => 3.0,
        _ => 1.0,
    }
}

/// Ступень словами — «андердог ×3», а не «1.73».
pub fn underdog_label(step: f64) -> Option<String> {
    match step {
        s if s == 1.5 => Some("андердог ×1.5".into()),
        s if s == 2.0 => Some("андердог ×2".into()),
        s if s == 3.0 => Some("андердог ×3".into()),
        _ => None,
    }
}

// ───────────────────────────────────────────── веса раундов

/// Вес раунда для «выплат за матчи»: чем ближе к финалу, тем дороже.
///
/// Верхняя сетка растёт по множителю роста, нижняя идёт со скидкой и
/// привязана к раунду верхней, чьих проигравших принимает. Гранд-финал —
/// вдвое дороже финала верхней: он решает титул.
fn round_weights(matches: &[ShapeMatch], growth: i64, lower_discount: i64) -> HashMap<i64, f64> {
    let g = growth.max(100) as f64 / 100.0;
    let d = lower_discount.clamp(0, 100) as f64 / 100.0;

    let upper_rounds: Vec<i64> = {
        let mut v: Vec<i64> = matches
            .iter()
            .filter(|m| m.bracket == "upper")
            .map(|m| m.round)
            .collect();
        v.sort_unstable();
        v.dedup();
        v
    };

    // Ключ веса: 0 — гранд-финал, k>0 — раунд k верхней, −r — раунд r нижней.
    let mut weights: HashMap<i64, f64> = HashMap::new();
    for r in &upper_rounds {
        weights.insert(*r, g.powi((r - 1).max(0) as i32));
    }

    // Какой раунд верхней кормит каждый раунд нижней: смотрим по ссылкам,
    // а не по номерам — после срезки сетки номера перенумерованы.
    let mut feed: HashMap<i64, i64> = HashMap::new();
    for m in matches.iter().filter(|m| m.bracket == "upper") {
        if let Some(t) = m.next_lose {
            if let Some(target) = matches.iter().find(|x| x.id == t) {
                if target.bracket == "lower" {
                    let round = target.round;
                    let k = feed.entry(round).or_insert(m.round);
                    if m.round < *k {
                        *k = m.round;
                    }
                }
            }
        }
    }

    let lower_rounds: Vec<i64> = {
        let mut v: Vec<i64> = matches
            .iter()
            .filter(|m| m.bracket == "lower")
            .map(|m| m.round)
            .collect();
        v.sort_unstable();
        v.dedup();
        v
    };

    let upper_last = upper_rounds.last().copied().unwrap_or(1);
    // Раунды нижней без своей «кормёжки» идут в той же ступени, что и
    // предыдущий: пары «приём выбывших — свои против своих».
    let mut prev_k = 1i64;
    for r in &lower_rounds {
        let k = feed.get(r).copied().unwrap_or(prev_k);
        prev_k = k;
        let base = {
            let kk = k.clamp(1, upper_last);
            weights.get(&kk).copied().unwrap_or(1.0)
        };
        weights.insert(-r, d * base);
    }

    if matches.iter().any(|m| m.bracket == "grand") {
        let top = {
            let kk = upper_last;
            weights.get(&kk).copied().unwrap_or(1.0)
        };
        weights.insert(0, 2.0 * top);
    }
    weights
}

fn weight_key(m: &ShapeMatch) -> i64 {
    match m.bracket.as_str() {
        "grand" => 0,
        "lower" => -m.round,
        _ => m.round,
    }
}

/// Целая цена победы в каждом матче: сумма по сетке сходится с долей ровно.
///
/// Делёж идёт по раундам, а не по матчам: матчи одного раунда стоят
/// одинаково, иначе «Раунд 2 верхней — 769 ₽» и «Раунд 2 верхней — 770 ₽»
/// в одной таблице выглядели бы ошибкой.
fn price_matches(
    matches: &[ShapeMatch],
    share: i64,
    growth: i64,
    lower_discount: i64,
) -> HashMap<i64, i64> {
    if share <= 0 || matches.is_empty() {
        return HashMap::new();
    }
    let weights = round_weights(matches, growth, lower_discount);

    // Раунды в порядке показа, с числом матчей и общим весом.
    let mut rounds: Vec<(i64, Vec<i64>)> = Vec::new();
    for m in matches {
        let key = weight_key(m);
        match rounds.iter_mut().find(|(k, _)| *k == key) {
            Some((_, ids)) => ids.push(m.id),
            None => rounds.push((key, vec![m.id])),
        }
    }

    let w: Vec<f64> = rounds
        .iter()
        .map(|(k, ids)| {
            let weight = weights.get(k).copied().unwrap_or(1.0);
            weight * ids.len() as f64
        })
        .collect();
    let amounts = apportion(share, &w);

    let mut out = HashMap::new();
    for ((_, ids), amount) in rounds.iter().zip(amounts) {
        let base = amount / ids.len() as i64;
        let extra = amount % ids.len() as i64;
        for (i, id) in ids.iter().enumerate() {
            out.insert(*id, base + if (i as i64) < extra { 1 } else { 0 });
        }
    }
    out
}

fn round_title(bracket: &str, round: i64) -> String {
    match bracket {
        "grand" => "Гранд-финал".to_string(),
        "lower" => format!("Раунд {round} нижней"),
        _ => format!("Раунд {round} верхней"),
    }
}

/// Таблица цен по раундам для показа.
fn price_table(matches: &[ShapeMatch], prices: &HashMap<i64, i64>) -> Vec<RoundPrice> {
    if prices.is_empty() {
        return Vec::new();
    }
    let mut keys: Vec<(String, i64)> = matches
        .iter()
        .map(|m| (m.bracket.clone(), m.round))
        .collect();
    keys.sort_by(|a, b| table_rank(a).cmp(&table_rank(b)));
    keys.dedup();

    keys.into_iter()
        .map(|(bracket, round)| {
            let price = matches
                .iter()
                .find(|m| m.bracket == bracket && m.round == round)
                .and_then(|m| prices.get(&m.id))
                .copied()
                .unwrap_or(0);
            RoundPrice {
                key: format!("{bracket}:{round}"),
                title: round_title(&bracket, round),
                matches: matches
                    .iter()
                    .filter(|m| m.bracket == bracket && m.round == round)
                    .count() as i64,
                price,
            }
        })
        .collect()
}

fn table_rank(key: &(String, i64)) -> (i64, i64) {
    match key.0.as_str() {
        "upper" => (0, key.1),
        "lower" => (1, key.1),
        _ => (2, 0),
    }
}

// ────────────────────────────────────────────────────── проверка лестницы

/// Заработок места тремя величинами: минимум без надстроек, максимум
/// движка без надстроек и максимум со всеми надстройками.
///
/// Дробный нарочно: сравнение лестницы идёт до округления, иначе копейки
/// округления ломали равенство там, где его ломать нечем.
#[derive(Debug, Clone, Default, Copy)]
struct EarnSpan {
    min: f64,
    /// Максимум движка: ступень андердога не считает — она надстройка,
    /// карты-утешения проигранного матча — тоже.
    mid: f64,
    max: f64,
}

impl EarnSpan {
    fn add(self, other: EarnSpan) -> EarnSpan {
        EarnSpan {
            min: self.min + other.min,
            mid: self.mid + other.mid,
            max: self.max + other.max,
        }
    }

    /// Пустой диапазон: схлопывается с первым настоящим значением.
    fn empty() -> EarnSpan {
        EarnSpan {
            min: f64::MAX / 4.0,
            mid: f64::MIN / 4.0,
            max: f64::MIN / 4.0,
        }
    }

    /// Схлопнуть два диапазона: минимумы вниз, максимумы вверх.
    fn widen(self, other: EarnSpan) -> EarnSpan {
        EarnSpan {
            min: self.min.min(other.min),
            mid: self.mid.max(other.mid),
            max: self.max.max(other.max),
        }
    }

    fn floor(self) -> EarnSpan {
        EarnSpan {
            min: self.min.floor(),
            mid: self.mid.floor(),
            max: self.max.floor(),
        }
    }
}

fn merge(into: &mut HashMap<i64, EarnSpan>, from: HashMap<i64, EarnSpan>) {
    for (place, span) in from {
        let entry = into.entry(place).or_insert_with(EarnSpan::empty);
        *entry = entry.widen(span);
    }
}

/// Место выбывшего: чем позже проиграл, тем выше место. Порядок тот же,
/// которым итоги расставляет завершение турнира.
fn elimination_rank(m: &ShapeMatch, matches: &HashMap<i64, ShapeMatch>) -> i64 {
    let key = |x: &ShapeMatch| -> (i64, i64, i64, i64) {
        (
            if x.bracket == "grand" { 0 } else { 1 },
            (x.bracket == "lower") as i64,
            -x.round,
            x.slot,
        )
    };
    let me = key(m);
    matches
        .values()
        .filter(|x| x.next_lose.is_none() && x.bracket != "upper")
        .filter(|x| key(x) < me)
        .count() as i64
}

/// Пройти сетку своим путём и собрать минимум и максимум заработка по местам.
///
/// Гарантия идёт без надстроек: андердог ×1, баунти нет. Максимум — со всеми:
/// ступень андердога на каждой победе и любые головы на пути.
fn walk(
    id: i64,
    matches: &HashMap<i64, ShapeMatch>,
    memo: &mut HashMap<i64, HashMap<i64, EarnSpan>>,
    price: &dyn Fn(&ShapeMatch) -> EarnSpan,
    lose_price: &dyn Fn(&ShapeMatch) -> EarnSpan,
) -> HashMap<i64, EarnSpan> {
    if let Some(hit) = memo.get(&id) {
        return hit.clone();
    }
    let Some(m) = matches.get(&id) else {
        return HashMap::new();
    };

    let mut out: HashMap<i64, EarnSpan> = HashMap::new();

    // Победа: заработок за матч и всё, что дальше по цепочке побед.
    let win_here = price(m);
    match m.next_win {
        Some(next) => {
            let tail = walk(next, matches, memo, price, lose_price);
            for (place, span) in tail {
                out.insert(place, win_here.add(span));
            }
        }
        None => {
            out.insert(1, win_here);
        }
    }

    // Поражение: нижняя сетка или выбывание.
    let lose_here = lose_price(m);
    match m.next_lose {
        Some(next) => {
            let tail = walk(next, matches, memo, price, lose_price);
            for (place, span) in tail {
                let candidate = lose_here.add(span);
                let entry = out.entry(place).or_insert_with(EarnSpan::empty);
                *entry = entry.widen(candidate);
            }
        }
        None => {
            let place = elimination_rank(m, matches) + 2;
            let entry = out.entry(place).or_insert_with(EarnSpan::empty);
            *entry = entry.widen(lose_here);
        }
    }

    memo.insert(id, out.clone());
    out
}

// ─────────────────────────────────────────────────────────── расчёт

/// Весь взгляд на фонд: и для редактора, и для эфира, и для итогов.
pub fn compute(input: &Input) -> PrizeView {
    let cfg = input.config;
    let players = input.players;
    let matches = input.matches;

    let effective = cfg.fund + cfg.jackpot_in;
    let bounty_total: i64 = cfg
        .addons
        .bounty
        .as_ref()
        .map(|b| b.amounts.iter().sum())
        .unwrap_or(0);
    let payment_total = cfg
        .addons
        .match_payments
        .as_ref()
        .map(|p| p.amount)
        .unwrap_or(0);
    let rookie_total = cfg.addons.rookie_race.unwrap_or(0);
    let spectator_total = cfg.addons.spectator.unwrap_or(0);
    let engine_share = effective - bounty_total - payment_total - rookie_total - spectator_total;

    let mut problems: Vec<String> = Vec::new();
    if engine_share < 0 {
        problems.push("надстройки съедают больше фонда, чем в нём есть".into());
    }
    if let Some(b) = &cfg.addons.bounty {
        if b.amounts.len() as i64 > players.len() as i64 {
            problems.push("денег на голове больше, чем игроков".into());
        }
        if b.amounts.iter().any(|x| x < &0) {
            problems.push("сумма на голове не может быть отрицательной".into());
        }
    }
    if cfg.engine.kind == "places" {
        let shares = &cfg.engine.shares;
        if shares.iter().sum::<i64>() != 100 {
            problems.push("проценты мест должны давать в сумме сто".into());
        }
        if shares.windows(2).any(|w| w[0] <= w[1]) {
            problems.push("проценты мест должны убывать".into());
        }
        if shares.len() as i64 > players.len() as i64 {
            problems.push("оплачиваемых мест больше, чем игроков".into());
        }
    }
    if cfg.engine.kind == "bounty" {
        let shares = &cfg.engine.shares;
        if shares.iter().sum::<i64>() != 100 {
            problems.push("проценты голов должны давать в сумме сто".into());
        }
        if shares.windows(2).any(|w| w[0] <= w[1]) {
            problems.push("проценты голов должны убывать".into());
        }
        if shares.len() as i64 > players.len() as i64 {
            problems.push("голов больше, чем игроков".into());
        }
        if cfg.addons.bounty.is_some() {
            problems.push(
                "надстройка «деньги на голове» не нужна: движок охоты уже платит за головы".into(),
            );
        }
    }

    // ── движок охоты: вся доля движка раскладывается на головы по сидам.
    // Отдельно от надстройки баунти: там суммы фиксированные и уже вычтены
    // из фонда, здесь деньги — это ровно то, что осталось движку.
    let engine_bounty: Option<(Vec<i64>, bool)> = if cfg.engine.kind == "bounty" {
        let weights: Vec<f64> = cfg.engine.shares.iter().map(|s| *s as f64).collect();
        Some((apportion(engine_share, &weights), cfg.engine.rollover))
    } else {
        None
    };

    // ── цены движка и надстройки
    let engine_prices = if cfg.engine.kind == "matches" {
        price_matches(matches, engine_share, cfg.engine.growth, cfg.engine.lower_discount)
    } else {
        HashMap::new()
    };
    let payment_prices = match &cfg.addons.match_payments {
        Some(MatchPaymentsCfg {
            amount,
            growth,
            lower_discount,
        }) => price_matches(matches, *amount, *growth, *lower_discount),
        None => HashMap::new(),
    };

    // Движок «за карты»: цена единицы нормируется на ожидаемое число карт.
    // Нижняя сетка — со скидкой: иначе бегущий через неё заработал бы больше
    // чемпиона без поражений, и это видно в эфире мгновенно.
    let map_unit: Option<f64> = if cfg.engine.kind == "maps" {
        map_unit_of(matches, engine_share, cfg.engine.lower_discount)
    } else {
        None
    };

    // Цены для проверки лестницы — по канонической сетке: у неё свои матчи
    // и своя нормировка, реюз цен реальной сетки по id выдавал чужие числа.
    let ladder_engine_prices = if cfg.engine.kind == "matches" {
        price_matches(
            input.ladder_matches,
            engine_share,
            cfg.engine.growth,
            cfg.engine.lower_discount,
        )
    } else {
        HashMap::new()
    };
    let ladder_payment_prices = match &cfg.addons.match_payments {
        Some(MatchPaymentsCfg {
            amount,
            growth,
            lower_discount,
        }) => price_matches(input.ladder_matches, *amount, *growth, *lower_discount),
        None => HashMap::new(),
    };
    let ladder_map_unit = if cfg.engine.kind == "maps" {
        map_unit_of(input.ladder_matches, engine_share, cfg.engine.lower_discount)
    } else {
        None
    };
    let ladder_discount = cfg.engine.lower_discount.clamp(0, 100) as f64 / 100.0;
    let ladder_map_price_of = |m: &ShapeMatch| -> f64 {
        let unit = ladder_map_unit.unwrap_or(0.0);
        if m.bracket == "lower" {
            unit * ladder_discount
        } else {
            unit
        }
    };
    let map_discount = cfg.engine.lower_discount.clamp(0, 100) as f64 / 100.0;
    let map_price_of = |m: &ShapeMatch| -> f64 {
        let unit = map_unit.unwrap_or(0.0);
        if m.bracket == "lower" {
            unit * map_discount
        } else {
            unit
        }
    };

    // ── лестница мест
    let (ladder, check) = ladder_view(
        input,
        &ladder_engine_prices,
        &ladder_payment_prices,
        ladder_map_price_of,
        engine_share,
    );
    let note = ladder_note(&ladder, &problems);

    // ── строки игроков
    let mut rows: Vec<PrizeRow> = players
        .iter()
        .map(|p| PrizeRow {
            player_id: p.player_id,
            nickname: p.nickname.clone(),
            color: p.color.clone(),
            seed: p.seed,
            rookie: p.rookie,
            place: p.place,
            places: 0,
            matches: 0,
            maps: 0,
            bounty: 0,
            rookie_prize: 0,
            spectator: 0,
            total: 0,
        })
        .collect();
    let mut by_id: HashMap<i64, usize> = HashMap::new();
    for (i, p) in players.iter().enumerate() {
        by_id.insert(p.player_id, i);
    }

    // Матчевые выплаты: победителю сыгранного матча без технической победы.
    for m in matches.iter().filter(|m| m.finished && !m.walkover) {
        let (Some(w), Some(l)) = (m.winner_seed, m.loser_seed()) else {
            continue;
        };
        let step = if cfg.addons.underdog {
            underdog_step(w, l)
        } else {
            1.0
        };
        let base = engine_prices.get(&m.id).copied().unwrap_or(0)
            + payment_prices.get(&m.id).copied().unwrap_or(0);
        if base <= 0 {
            continue;
        }
        if let Some(p) = players.iter().find(|p| p.seed == Some(w)) {
            let row = &mut rows[by_id[&p.player_id]];
            row.matches += floor_money(base as f64 * step);
        }
    }

    // Карты: победителю матча — T карт по двойной цене, проигравшему — свои
    // по одинарной. Техническая победа карт не считает. Идущий матч платит
    // по одинарной цене обеим сторонам: удвоение победных карт решается
    // итогом матча, и в конце цифра подпрыгивает — это видно и честно.
    if map_unit.is_some() {
        for m in matches.iter().filter(|m| !m.walkover) {
            let per = map_price_of(m);
            for (seed, won) in [(m.seed_a, m.maps_a), (m.seed_b, m.maps_b)] {
                let Some(seed) = seed else { continue };
                let Some(p) = players.iter().find(|p| p.seed == Some(seed)) else {
                    continue;
                };
                let rate = if m.finished && m.winner_seed == Some(seed) {
                    2.0
                } else {
                    1.0
                };
                let row = &mut rows[by_id[&p.player_id]];
                row.maps += floor_money(won as f64 * rate * per);
            }
        }
    }

    // Баунти: головы движка охоты или надстройки снимаются победой.
    let (heads, taken_money, last_bounty) = bounty_state(input, engine_bounty);
    for (player_id, money) in &taken_money {
        if let Some(&idx) = by_id.get(player_id) {
            rows[idx].bounty += money;
        }
    }

    // Живые ставки идущих матчей: что на кону и сколько уже взято. Считаем
    // после баунти — головы на сейчас, с учётом переката.
    let live = live_stakes(input, &engine_prices, &payment_prices, map_price_of, &heads);

    // Итоговые выплаты: места движка, гонка новичков, зрительский банк.
    if input.finished {
        if cfg.engine.kind == "places" {
            let amounts = place_amounts(engine_share, &cfg.engine.shares);
            for (i, row) in rows.iter_mut().enumerate() {
                if let Some(place) = players[i].place {
                    let k = (place - 1) as usize;
                    if k < amounts.len() {
                        row.places = amounts[k];
                    }
                }
            }
        }
        rookie_prizes(input, &mut rows, &by_id);
        spectator_prizes(input, &mut rows);
    }

    for row in rows.iter_mut() {
        row.total =
            row.places + row.matches + row.maps + row.bounty + row.rookie_prize + row.spectator;
    }

    let paid: i64 = rows.iter().map(|r| r.total).sum();

    PrizeView {
        config: cfg.clone(),
        fund_effective: effective,
        engine_share,
        ladder: ladder.clone(),
        check,
        note,
        match_prices: price_table(matches, &engine_prices),
        payment_prices: price_table(matches, &payment_prices),
        map_price: map_unit.map(|u| MapPrice {
            win: floor_money(2.0 * u),
            loss: floor_money(u),
            unit: u,
        }),
        spread: map_unit.map(|_| {
            // Минимум — все матчи всухую, максимум — все до решающей карты.
            let min: f64 = matches
                .iter()
                .map(|m| 2.0 * m.target.max(0) as f64 * map_price_of(m))
                .sum();
            let max: f64 = matches
                .iter()
                .map(|m| {
                    let t = m.target.max(1) as f64;
                    (2.0 * t + (t - 1.0)) * map_price_of(m)
                })
                .sum();
            crate::model::MoneySpan {
                min: floor_money(min),
                max: floor_money(max),
            }
        }),
        rows,
        heads,
        last_bounty,
        live,
        rookie_rows: rookie_rows(input),
        best_match: input
            .best_match
            .as_ref()
            .map(|(id, label)| crate::model::BestMatchView {
                id: *id,
                label: label.clone(),
                a_nick: String::new(),
                b_nick: String::new(),
            }),
        remainder: effective - paid,
        jackpot_now: input.jackpot_now,
        finished: input.finished,
        problems,
    }
}


/// Цена единицы карты движка «за карты» для данного набора матчей.
fn map_unit_of(matches: &[ShapeMatch], share: i64, lower_discount: i64) -> Option<f64> {
    if share <= 0 || matches.is_empty() {
        return None;
    }
    let d = lower_discount.clamp(0, 100) as f64 / 100.0;
    let expected: f64 = matches
        .iter()
        .map(|m| {
            let t = m.target.max(1) as f64;
            let units = 2.0 * t + (t - 1.0) / 2.0;
            if m.bracket == "lower" {
                units * d
            } else {
                units
            }
        })
        .sum();
    if expected > 0.0 {
        Some(share as f64 / expected)
    } else {
        None
    }
}

/// Суммы за места движка: остаток округления идёт первому месту.
fn place_amounts(share: i64, shares: &[i64]) -> Vec<i64> {
    if share <= 0 || shares.is_empty() {
        return vec![0; shares.len()];
    }
    let mut out: Vec<i64> = shares.iter().map(|s| share * s / 100).collect();
    let left = share - out.iter().sum::<i64>();
    if let Some(first) = out.first_mut() {
        *first += left;
    }
    out
}

/// Лестница мест: гарантия движка и максимум с надстройками.
///
/// Возвращает и строки для показа, и строгую проверку: сравнение идёт по
/// точным ценам до округления, а показ — уже целыми рублями.
fn ladder_view(
    input: &Input,
    engine_prices: &HashMap<i64, i64>,
    payment_prices: &HashMap<i64, i64>,
    map_price_of: impl Fn(&ShapeMatch) -> f64,
    engine_share: i64,
) -> (Vec<PlaceLadder>, LadderCheck) {
    let cfg = input.config;
    let source = input.ladder_matches;
    let matches: HashMap<i64, ShapeMatch> = source.iter().map(|m| (m.id, m.clone())).collect();
    if matches.is_empty() {
        return (Vec::new(), LadderCheck {
            ok: true,
            broken_at: None,
            text: "сетку ещё не из чего собирать".into(),
        });
    }

    // Группа мест: место = матч выбывания, выбывшие одного раунда — одна
    // группа. Внутри группы порядок мест условен, проверяется только стык
    // групп.
    let group_of = elimination_groups(&matches);

    // Движок охоты: лестница мест не имеет смысла — деньги идут за головы, а
    // не за места. Максимум любого места — все головы, гарантия — ноль, и
    // сравнивать ступени не с чем: кто с кого какую голову снимет, сетка
    // знать не может.
    if cfg.engine.kind == "bounty" {
        let heads_total = engine_share
            + cfg
                .addons
                .bounty
                .as_ref()
                .map(|b| b.amounts.iter().sum())
                .unwrap_or(0);
        let n = source
            .iter()
            .filter(|m| m.next_lose.is_none() && m.bracket != "upper")
            .count()
            .max(1) as i64
            + 1;
        let rows: Vec<PlaceLadder> = (1..=n)
            .map(|place| PlaceLadder {
                place,
                guarantee: 0,
                engine_max: 0,
                max_total: heads_total,
                group: group_of.get(&place).copied().unwrap_or(place),
            })
            .collect();
        return (
            rows,
            LadderCheck {
                ok: true,
                broken_at: None,
                text: "охота за головами: деньги идут за головы, места не сравниваются".into(),
            },
        );
    }

    // Движок мест платит по местам напрямую; матчевые и карты — по пути.
    let use_places = cfg.engine.kind == "places";
    let place_amounts_engine = if use_places {
        place_amounts(engine_share, &cfg.engine.shares)
    } else {
        Vec::new()
    };
    let place_exact = |place: i64| -> f64 {
        if !use_places {
            return 0.0;
        }
        let k = (place - 1) as usize;
        match cfg.engine.shares.get(k) {
            Some(s) => engine_share as f64 * *s as f64 / 100.0,
            None => 0.0,
        }
    };
    let _ = &place_amounts_engine;

    let underdog = cfg.addons.underdog;
    let price = |m: &ShapeMatch| -> EarnSpan {
        let base = engine_prices.get(&m.id).copied().unwrap_or(0)
            + payment_prices.get(&m.id).copied().unwrap_or(0);
        let maps = 2.0 * m.target.max(0) as f64 * map_price_of(m);
        let step = if underdog { 3.0 } else { 1.0 };
        EarnSpan {
            min: base as f64 + maps,
            mid: base as f64 + maps,
            max: base as f64 * step + maps,
        }
    };
    let lose_price = |m: &ShapeMatch| -> EarnSpan {
        let maps = (m.target.max(1) - 1) as f64 * map_price_of(m);
        EarnSpan {
            min: 0.0,
            mid: 0.0,
            max: maps,
        }
    };

    let mut memo: HashMap<i64, HashMap<i64, EarnSpan>> = HashMap::new();
    let mut per_place: HashMap<i64, EarnSpan> = HashMap::new();

    // Старт — первый раунд верхней сетки: каноническая сетка всегда полная.
    let starts: Vec<i64> = source
        .iter()
        .filter(|m| m.bracket == "upper" && m.round == 1)
        .map(|m| m.id)
        .collect();
    let starts = if starts.is_empty() {
        vec![source[0].id]
    } else {
        starts
    };

    for id in starts {
        let tail = walk(id, &matches, &mut memo, &price, &lose_price);
        merge(&mut per_place, tail);
    }

    // Баунти в максимуме: любую голову можно снять на своём пути.
    let bounty_total: i64 = cfg
        .addons
        .bounty
        .as_ref()
        .map(|b| b.amounts.iter().sum())
        .unwrap_or(0);

    let n = source
        .iter()
        .filter(|m| m.next_lose.is_none() && m.bracket != "upper")
        .count()
        .max(1) as i64
        + 1;
    let mut rows: Vec<PlaceLadder> = Vec::with_capacity(n as usize);
    for place in 1..=n {
        let span = per_place.get(&place).copied().unwrap_or_default().floor();
        let places = place_amounts_engine
            .get((place - 1) as usize)
            .copied()
            .unwrap_or(0);
        let guarantee = places + span.min as i64;
        let engine_max = places + span.mid as i64;
        let mut max_total = places + span.max as i64;
        if place > 1 {
            max_total += bounty_total;
        }
        rows.push(PlaceLadder {
            place,
            guarantee,
            engine_max,
            max_total,
            group: group_of.get(&place).copied().unwrap_or(place),
        });
    }

    // Строгая проверка: точные суммы до округления, копеечный люфт не считается.
    let mut check = LadderCheck {
        ok: true,
        broken_at: None,
        text: "места убывают по всей лестнице".into(),
    };
    for w in rows.windows(2) {
        if w[1].group == w[0].group {
            continue;
        }
        let lower_max = place_exact(w[1].place)
            + per_place.get(&w[1].place).copied().unwrap_or_default().mid;
        let upper_min = place_exact(w[0].place)
            + per_place.get(&w[0].place).copied().unwrap_or_default().min;
        if lower_max > upper_min + 0.01 {
            check = LadderCheck {
                ok: false,
                broken_at: Some(w[1].place),
                text: format!(
                    "места не убывают: {}-е может унести {} ₽ при гарантированных {} ₽ за {}-е",
                    w[1].place,
                    lower_max.floor(),
                    upper_min.floor(),
                    w[0].place
                ),
            };
            break;
        }
    }

    (rows, check)
}


/// Место → группа: выбывшие одного раунда нижней сетки сидят в одном месте
/// таблицы, гранд-финал — своя группа, чемпион — своя.
fn elimination_groups(matches: &HashMap<i64, ShapeMatch>) -> HashMap<i64, i64> {
    let key = |x: &ShapeMatch| -> (i64, i64, i64, i64) {
        (
            if x.bracket == "grand" { 0 } else { 1 },
            (x.bracket == "lower") as i64,
            -x.round,
            x.slot,
        )
    };
    let mut elim: Vec<&ShapeMatch> = matches
        .values()
        .filter(|x| x.next_lose.is_none() && x.bracket != "upper")
        .collect();
    elim.sort_by_key(|m| key(m));

    let mut out: HashMap<i64, i64> = HashMap::new();
    out.insert(1, 0);
    let mut group = 0i64;
    let mut prev: Option<(String, i64)> = None;
    for (i, m) in elim.iter().enumerate() {
        let round = (m.bracket.clone(), m.round);
        if prev.as_ref() != Some(&round) {
            group += 1;
            prev = Some(round);
        }
        out.insert(i as i64 + 2, group);
    }
    out
}

fn ladder_note(ladder: &[PlaceLadder], problems: &[String]) -> Option<String> {
    if !problems.is_empty() || ladder.len() < 2 {
        return None;
    }
    // Самая громкая перестановка мест: сколько максимум может унести место,
    // стоящее ниже, против гарантии стоящего выше.
    let mut best: Option<(i64, i64, i64)> = None;
    for w in ladder.windows(2) {
        let gap = w[1].max_total - w[0].guarantee;
        if gap > 0 && best.map(|(_, g, _)| g < gap).unwrap_or(true) {
            best = Some((w[1].place, w[1].max_total, w[0].guarantee));
        }
    }
    best.map(|(place, max, guarantee)| {
        format!(
            "{place}-е место может унести до {max} ₽ при гарантированных {guarantee} ₽ за {}-е — это работа надстроек, а не ошибка",
            place - 1
        )
    })
}

// ──────────────────────────────────────────────────────── баунти

/// Пройденные матчи в порядке игры.
fn played_in_order<'a>(input: &'a Input<'a>) -> Vec<&'a ShapeMatch> {
    let mut played: Vec<&ShapeMatch> = input
        .matches
        .iter()
        .filter(|m| m.finished && !m.walkover && m.winner_seed.is_some())
        .collect();
    played.sort_by_key(|m| m.id);
    played
}

/// Головы на сейчас, снятые деньги по игрокам и последнее снятие.
///
/// Источник голов один: движок охоты (вся доля движка по сидам) или надстройка
/// баунти (фиксированные суммы). Правила снятия одни и те же.
fn bounty_state(
    input: &Input,
    engine_bounty: Option<(Vec<i64>, bool)>,
) -> (Vec<BountyHead>, Vec<(i64, i64)>, Option<BountyEvent>) {
    let (amounts, rollover) = match engine_bounty {
        Some((amounts, rollover)) => (amounts, rollover),
        None => match input.config.addons.bounty.clone() {
            Some(b) => (b.amounts, b.rollover),
            None => return (Vec::new(), Vec::new(), None),
        },
    };
    let players = input.players;

    let mut heads: HashMap<i64, i64> = HashMap::new();
    for (i, amount) in amounts.iter().enumerate() {
        let seed = (i + 1) as i64;
        if let Some(p) = players.iter().find(|p| p.seed == Some(seed)) {
            heads.insert(p.player_id, *amount);
        }
    }

    let mut taken: Vec<(i64, i64)> = Vec::new();
    let mut last: Option<BountyEvent> = None;

    for m in played_in_order(input) {
        let Some(loser_seed) = m.loser_seed() else { continue };
        let Some(winner_seed) = m.winner_seed else { continue };
        let Some(victim) = players.iter().find(|p| p.seed == Some(loser_seed)) else {
            continue;
        };
        let Some(&amount) = heads.get(&victim.player_id) else {
            continue;
        };
        let Some(winner) = players.iter().find(|p| p.seed == Some(winner_seed)) else {
            continue;
        };

        let (money, moved) = if rollover {
            let half = amount / 2;
            (half, amount - half)
        } else {
            (amount, 0)
        };

        heads.remove(&victim.player_id);
        if moved > 0 {
            *heads.entry(winner.player_id).or_insert(0) += moved;
        }
        taken.push((winner.player_id, money));
        last = Some(BountyEvent {
            killer_id: winner.player_id,
            killer_nick: winner.nickname.clone(),
            killer_color: winner.color.clone(),
            victim_id: victim.player_id,
            victim_nick: victim.nickname.clone(),
            victim_color: victim.color.clone(),
            taken: money,
            moved,
            at: String::new(),
        });
    }

    // Чемпион забирает неснятую голову сам: свою голову он защитил. Головы
    // после технических побед остаются висеть — их заберёт джекпот.
    if input.finished {
        if let Some(champ) = players.iter().find(|p| p.place == Some(1)) {
            if let Some(&amount) = heads.get(&champ.player_id) {
                taken.push((champ.player_id, amount));
                heads.remove(&champ.player_id);
            }
        }
    }

    let list = heads
        .iter()
        .filter_map(|(pid, amount)| {
            players
                .iter()
                .find(|p| p.player_id == *pid)
                .map(|p| BountyHead {
                    player_id: p.player_id,
                    nickname: p.nickname.clone(),
                    seed: p.seed,
                    amount: *amount,
                })
        })
        .collect();
    (list, taken, last)
}

// ─────────────────────────────────────────────────────── живые ставки

/// Деньги идущих матчей: цена победы, головы и взятые карты — по ходу игры.
///
/// Фонд не обязан молчать до конца матча: у движка «за карты» цифра растёт
/// с каждой картой, у движка «за матчи» и матчевых выплат видна цена победы,
/// у баунти — сколько висит на сопернике. Матчи без денег в кадр не попадают.
fn live_stakes(
    input: &Input,
    engine_prices: &HashMap<i64, i64>,
    payment_prices: &HashMap<i64, i64>,
    map_price_of: impl Fn(&ShapeMatch) -> f64,
    heads: &[BountyHead],
) -> Vec<crate::model::LiveStake> {
    let head_of = |seed: Option<i64>| -> i64 {
        let Some(seed) = seed else { return 0 };
        input
            .players
            .iter()
            .find(|p| p.seed == Some(seed))
            .and_then(|p| heads.iter().find(|h| h.player_id == p.player_id))
            .map(|h| h.amount)
            .unwrap_or(0)
    };

    let mut out = Vec::new();
    for m in input.matches.iter().filter(|m| m.running && !m.walkover) {
        let win_price = engine_prices.get(&m.id).copied().unwrap_or(0)
            + payment_prices.get(&m.id).copied().unwrap_or(0);
        let maps_price = map_price_of(m);
        let stake = crate::model::LiveStake {
            match_id: m.id,
            seed_a: m.seed_a,
            seed_b: m.seed_b,
            win_price,
            head_a: head_of(m.seed_a),
            head_b: head_of(m.seed_b),
            maps_a: floor_money(m.maps_a as f64 * maps_price),
            maps_b: floor_money(m.maps_b as f64 * maps_price),
        };
        if stake.win_price > 0 || stake.head_a > 0 || stake.head_b > 0 || stake.maps_a > 0 || stake.maps_b > 0 {
            out.push(stake);
        }
    }
    out
}

// ───────────────────────────────────────── гонка новичков и зрительский банк

/// Гонка новичков: живые выше выбывших, выбывшие — по местам.
fn rookie_rows(input: &Input) -> Vec<RookieRow> {
    if input.config.addons.rookie_race.is_none() {
        return Vec::new();
    }
    let mut rows: Vec<RookieRow> = input
        .players
        .iter()
        .filter(|p| p.rookie)
        .map(|p| RookieRow {
            player_id: p.player_id,
            nickname: p.nickname.clone(),
            color: p.color.clone(),
            place: None,
            status: if p.place.is_some() { "out".into() } else { "alive".into() },
            earned: 0,
        })
        .collect();

    let place_of = |id: i64| -> Option<i64> {
        input
            .players
            .iter()
            .find(|p| p.player_id == id)
            .and_then(|p| p.place)
    };
    // Живые ещё могут всё: они в гонке выше любого выбывшего.
    rows.sort_by(|a, b| {
        let alive_a = place_of(a.player_id).is_none();
        let alive_b = place_of(b.player_id).is_none();
        match (alive_a, alive_b) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => place_of(a.player_id)
                .cmp(&place_of(b.player_id))
                .then_with(|| a.nickname.cmp(&b.nickname)),
        }
    });
    for (i, row) in rows.iter_mut().enumerate() {
        row.place = Some((i + 1) as i64);
    }
    rows
}

/// Выплаты новичкам — завершённому турниру.
fn rookie_prizes(input: &Input, rows: &mut [PrizeRow], by_id: &HashMap<i64, usize>) {
    let Some(amount) = input.config.addons.rookie_race else {
        return;
    };
    if amount <= 0 {
        return;
    }
    let rookies = rookie_rows(input);
    if rookies.is_empty() {
        return;
    }

    let pay = |rows: &mut [PrizeRow], amounts: &[i64]| {
        for (i, r) in rookies.iter().enumerate() {
            if let Some(money) = amounts.get(i) {
                if let Some(&idx) = by_id.get(&r.player_id) {
                    rows[idx].rookie_prize = *money;
                }
            }
        }
    };

    if input.config.engine.kind == "places" {
        // Тот же профиль процентов: сколько новичков, столько и призовых мест.
        let amounts = place_amounts(amount, &input.config.engine.shares);
        pay(rows, &amounts);
    } else {
        // Матчи и карты: доля новичка пропорциональна его игровому заработку.
        let weights: Vec<f64> = rookies
            .iter()
            .map(|r| {
                by_id
                    .get(&r.player_id)
                    .map(|&i| (rows[i].matches + rows[i].maps) as f64)
                    .unwrap_or(0.0)
            })
            .collect();
        if weights.iter().sum::<f64>() <= 0.0 {
            return;
        }
        let amounts = apportion(amount, &weights);
        pay(rows, &amounts);
    }
}

/// Зрительский банк: лучший матч, половина каждому из его игроков.
fn spectator_prizes(input: &Input, rows: &mut [PrizeRow]) {
    let Some(amount) = input.config.addons.spectator else {
        return;
    };
    let Some((best, _)) = input.best_match else {
        return;
    };
    let Some(m) = input
        .matches
        .iter()
        .find(|m| m.id == best && m.finished && !m.walkover)
    else {
        return;
    };

    let half = amount / 2;
    let other = amount - half;
    for (seed, money) in [(m.seed_a, half), (m.seed_b, other)] {
        let Some(seed) = seed else { continue };
        if let Some(p) = input.players.iter().find(|p| p.seed == Some(seed)) {
            if let Some(row) = rows.iter_mut().find(|r| r.player_id == p.player_id) {
                row.spectator += money;
            }
        }
    }
}

// ─────────────────────────────────────────────────────────── пресеты

pub const PRESET_PRO: &str = "pro";
pub const PRESET_LOCAL: &str = "local";
pub const PRESET_ROOKIE: &str = "rookie";
pub const PRESET_SHOW: &str = "show";

/// Пресет одной кнопкой: фонд остаётся тем, что уже ввёл организатор.
pub fn preset(kind: &str, fund: i64) -> PrizeConfig {
    let share = |part: i64| fund * part / 100;
    match kind {
        PRESET_PRO => PrizeConfig {
            fund,
            engine: PrizeEngineCfg::places(vec![50, 30, 20]),
            addons: crate::model::PrizeAddonsCfg {
                spectator: Some(share(10)),
                ..Default::default()
            },
            ..Default::default()
        },
        PRESET_LOCAL => {
            let bounty = share(10);
            PrizeConfig {
                fund,
                engine: PrizeEngineCfg::places(vec![34, 24, 17, 11, 8, 6]),
                addons: crate::model::PrizeAddonsCfg {
                    match_payments: Some(MatchPaymentsCfg {
                        amount: share(25),
                        growth: 200,
                        lower_discount: 50,
                    }),
                    bounty: Some(crate::model::BountyCfg {
                        amounts: vec![bounty * 467 / 1000, bounty * 3 / 10, bounty * 233 / 1000],
                        rollover: false,
                    }),
                    spectator: Some(share(10)),
                    ..Default::default()
                },
                ..Default::default()
            }
        }
        PRESET_ROOKIE => PrizeConfig {
            fund,
            engine: PrizeEngineCfg::matches(200, 50),
            addons: crate::model::PrizeAddonsCfg {
                rookie_race: Some(share(30)),
                underdog: true,
                ..Default::default()
            },
            ..Default::default()
        },
        _ => PrizeConfig {
            fund,
            engine: PrizeEngineCfg::maps(),
            addons: crate::model::PrizeAddonsCfg {
                bounty: Some(crate::model::BountyCfg {
                    amounts: vec![share(12), share(8), share(5)],
                    rollover: true,
                }),
                spectator: Some(share(10)),
                jackpot: true,
                ..Default::default()
            },
            ..Default::default()
        },
    }
}

// ─────────────────────────────────────────────────────────── тесты

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::bracket;

    fn player(id: i64, seed: i64, rookie: bool) -> ShapePlayer {
        ShapePlayer {
            player_id: id,
            nickname: format!("p{id}"),
            color: "#fff".into(),
            seed: Some(seed),
            rookie,
            place: None,
        }
    }

    /// Сетка из заготовок с реальным сеянием: идентификаторы — индексы.
    fn shape(size: usize, targets: i64) -> Vec<ShapeMatch> {
        let seeded: Vec<Option<i64>> = (1..=size as i64).map(Some).collect();
        let seats = bracket::build(size, &seeded);
        seats
            .iter()
            .enumerate()
            .map(|(i, s)| ShapeMatch {
                id: i as i64,
                bracket: s.bracket.to_string(),
                round: s.round,
                slot: s.slot,
                next_win: s.next_win.map(|n| n as i64),
                next_lose: s.next_lose.map(|n| n as i64),
                seed_a: s.player_a,
                seed_b: s.player_b,
                winner_seed: None,
                walkover: false,
                finished: false,
                running: false,
                target: targets,
                maps_a: 0,
                maps_b: 0,
            })
            .collect()
    }

    fn view(matches: &[ShapeMatch], players: &[ShapePlayer], cfg: &PrizeConfig) -> PrizeView {
        compute(&Input {
            matches,
            ladder_matches: matches,
            players,
            config: cfg,
            jackpot_now: 0,
            finished: false,
            best_match: None,
        })
    }

    #[test]
    fn apportion_keeps_total() {
        let out = apportion(10_000, &[34.0, 24.0, 16.5, 11.5, 8.0, 6.0]);
        assert_eq!(out.iter().sum::<i64>(), 10_000);
        assert_eq!(out[0], 3_400);
        assert_eq!(out[2], 1_650);
    }

    #[test]
    fn apportion_edge_cases() {
        assert!(apportion(100, &[]).is_empty());
        assert_eq!(apportion(0, &[1.0, 1.0]), vec![0, 0]);
        assert_eq!(apportion(3, &[1.0, 1.0]), vec![2, 1]);
    }

    #[test]
    fn underdog_steps_by_group() {
        assert_eq!(underdog_step(1, 2), 1.0);
        assert_eq!(underdog_step(3, 1), 1.5);
        assert_eq!(underdog_step(5, 1), 2.0);
        assert_eq!(underdog_step(15, 1), 3.0);
        // Фаворит множителя не получает.
        assert_eq!(underdog_step(1, 15), 1.0);
    }

    #[test]
    fn places_remainder_goes_to_first() {
        let amounts = place_amounts(10_000, &[34, 24, 17, 11, 8, 6]);
        assert_eq!(amounts.iter().sum::<i64>(), 10_000);
        assert_eq!(amounts[0], 3_400);
    }

    #[test]
    fn places_ladder_catches_bad_shares() {
        let cfg = PrizeConfig {
            fund: 1000,
            engine: PrizeEngineCfg::places(vec![30, 40, 30]),
            ..Default::default()
        };
        let players: Vec<ShapePlayer> = (1..=4).map(|i| player(i, i, false)).collect();
        let matches = shape(4, 4);
        let v = view(&matches, &players, &cfg);
        assert!(v.problems.iter().any(|p| p.contains("убывать")));
        assert!(!v.check.ok);
    }

    #[test]
    fn places_engine_view() {
        let cfg = PrizeConfig {
            fund: 10_000,
            engine: PrizeEngineCfg::places(vec![50, 30, 20]),
            ..Default::default()
        };
        let players: Vec<ShapePlayer> = (1..=8).map(|i| player(i, i, false)).collect();
        let matches = shape(8, 4);
        let v = view(&matches, &players, &cfg);
        assert!(v.check.ok, "{}", v.check.text);
        assert_eq!(v.ladder[0].guarantee, 5_000);
        assert_eq!(v.ladder[1].guarantee, 3_000);
        assert_eq!(v.ladder[2].guarantee, 2_000);
        assert_eq!(v.ladder[3].guarantee, 0);
    }

    /// Дефолтные выплаты за матчи проходят лестницу на всех размерах сетки.
    #[test]
    fn matches_engine_ladder_holds_by_default() {
        for size in [4usize, 8, 16, 32] {
            let cfg = PrizeConfig {
                fund: 10_000,
                engine: PrizeEngineCfg::matches(200, 50),
                ..Default::default()
            };
            let players: Vec<ShapePlayer> = (1..=size as i64).map(|i| player(i, i, false)).collect();
            let matches = shape(size, 4);
            let v = view(&matches, &players, &cfg);
            assert!(v.check.ok, "размер {size}: {}", v.check.text);
            // Сумма цен матчей сходится с долей движка ровно.
            let prices = price_matches(&matches, 10_000, 200, 50);
            assert_eq!(prices.values().sum::<i64>(), 10_000);
            // Чемпион гарантированно богаче второго места.
            assert!(v.ladder[0].guarantee > v.ladder[1].guarantee);
        }
    }

    /// Матчи с плоской формой ловятся проверкой: бегущий через нижнюю сетку
    /// зарабатывал бы больше чемпиона.
    #[test]
    fn matches_engine_flat_shape_breaks_ladder() {
        let cfg = PrizeConfig {
            fund: 10_000,
            engine: PrizeEngineCfg::matches(100, 100),
            ..Default::default()
        };
        let players: Vec<ShapePlayer> = (1..=16).map(|i| player(i, i, false)).collect();
        let matches = shape(16, 4);
        let v = view(&matches, &players, &cfg);
        assert!(!v.check.ok, "плоская форма обязана ломать лестницу: {}", v.check.text);
    }

    /// Движок карт без скидки нижней сетки ловится проверкой: бегущий через
    /// нижнюю сетку набирает побед больше, чем стоящий выше.
    #[test]
    fn maps_engine_without_discount_breaks_ladder() {
        let mut cfg = PrizeConfig {
            fund: 10_000,
            engine: PrizeEngineCfg::maps(),
            addons: crate::model::PrizeAddonsCfg::default(),
            ..Default::default()
        };
        cfg.engine.lower_discount = 100;
        let players: Vec<ShapePlayer> = (1..=16).map(|i| player(i, i, false)).collect();
        let matches = shape(16, 4);
        let v = view(&matches, &players, &cfg);
        assert!(!v.check.ok, "без скидки лестница обязана ломаться");
    }

    /// Матчевые выплаты с плоской формой ломают лестницу вместе с движком
    /// мест: четверо выбывших одного раунда не должны обогнать третье место.
    #[test]
    fn match_payments_can_break_places_ladder() {
        let cfg = PrizeConfig {
            fund: 100_000,
            engine: PrizeEngineCfg::places(vec![34, 24, 17, 11, 8, 6]),
            addons: crate::model::PrizeAddonsCfg {
                match_payments: Some(MatchPaymentsCfg {
                    amount: 80_000,
                    growth: 100,
                    lower_discount: 100,
                }),
                ..Default::default()
            },
            ..Default::default()
        };
        let players: Vec<ShapePlayer> = (1..=16).map(|i| player(i, i, false)).collect();
        let matches = shape(16, 4);
        let v = view(&matches, &players, &cfg);
        assert!(!v.check.ok, "плоские матчевые поверх мест обязаны ломать лестницу");
    }

    #[test]
    fn maps_engine_ladder_holds_by_default() {
        for size in [4usize, 8, 16] {
            let cfg = PrizeConfig {
                fund: 10_000,
                engine: PrizeEngineCfg::maps(),
                ..Default::default()
            };
            let players: Vec<ShapePlayer> = (1..=size as i64).map(|i| player(i, i, false)).collect();
            let matches = shape(size, 4);
            let v = view(&matches, &players, &cfg);
            assert!(v.check.ok, "размер {size}: {}", v.check.text);
            assert!(v.ladder[0].guarantee > v.ladder[1].guarantee);
            assert!(v.spread.is_some());
            assert!(v.spread.as_ref().unwrap().min <= v.spread.as_ref().unwrap().max);
        }
    }

    /// Неполный состав: ежу без игры лестница обязана сходиться.
    #[test]
    fn ladder_holds_on_partial_roster() {
        for count in [3usize, 5, 6, 7, 12] {
            // На четверых скидка нижней сетки не нужна: финалист верхней,
            // упавший прямо в финал нижней, и так обгоняет бегуна снизу.
            let discount = if count <= 4 { 100 } else { 50 };
            let cfg = PrizeConfig {
                fund: 10_000,
                engine: PrizeEngineCfg::matches(200, discount),
                ..Default::default()
            };
            let players: Vec<ShapePlayer> =
                (1..=count as i64).map(|i| player(i, i, false)).collect();
            let seeded: Vec<Option<i64>> = (1..=count as i64).map(Some).collect();
            let seats = bracket::build(count, &seeded);
            let matches: Vec<ShapeMatch> = seats
                .iter()
                .enumerate()
                .map(|(i, s)| ShapeMatch {
                    id: i as i64,
                    bracket: s.bracket.to_string(),
                    round: s.round,
                    slot: s.slot,
                    next_win: s.next_win.map(|n| n as i64),
                    next_lose: s.next_lose.map(|n| n as i64),
                    seed_a: s.player_a,
                    seed_b: s.player_b,
                    winner_seed: None,
                    walkover: false,
                    finished: false,
                    running: false,
                    target: 4,
                    maps_a: 0,
                    maps_b: 0,
                })
                .collect();
            // Проверка идёт по канонической сетке того же размера.
            let size = bracket::bracket_size(count);
            let canonical = shape(size, 4);
            let v = compute(&Input {
                matches: &matches,
                ladder_matches: &canonical,
                players: &players,
                config: &cfg,
                jackpot_now: 0,
                finished: false,
                best_match: None,
            });
            assert!(v.check.ok, "состав {count}: {}", v.check.text);
        }
    }

    /// Баунти с перекатом: половина убийце, половина ему на голову.
    #[test]
    fn bounty_rollover_moves_head() {
        let cfg = PrizeConfig {
            fund: 10_000,
            engine: PrizeEngineCfg::places(vec![50, 30, 20]),
            addons: crate::model::PrizeAddonsCfg {
                bounty: Some(crate::model::BountyCfg {
                    amounts: vec![700, 450, 350],
                    rollover: true,
                }),
                ..Default::default()
            },
            ..Default::default()
        };
        let mut players: Vec<ShapePlayer> = (1..=4).map(|i| player(i, i, false)).collect();
        let mut matches = shape(4, 4);

        // Сид 1 проигрывает сиду 4 в первом раунде верхней.
        matches[0].finished = true;
        matches[0].winner_seed = Some(4);
        matches[0].walkover = false;

        let v = view(&matches, &players, &cfg);
        let row4 = v.rows.iter().find(|r| r.seed == Some(4)).unwrap();
        assert_eq!(row4.bounty, 350, "убийце — половина");
        // Половина переехала на голову убийцы.
        assert!(v.heads.iter().any(|h| h.seed == Some(4) && h.amount == 350));

        // Без переката — вся сумма сразу.
        let cfg2 = PrizeConfig {
            fund: 10_000,
            engine: PrizeEngineCfg::places(vec![50, 30, 20]),
            addons: crate::model::PrizeAddonsCfg {
                bounty: Some(crate::model::BountyCfg {
                    amounts: vec![700, 450, 350],
                    rollover: false,
                }),
                ..Default::default()
            },
            ..Default::default()
        };
        let v2 = view(&matches, &players, &cfg2);
        let row4b = v2.rows.iter().find(|r| r.seed == Some(4)).unwrap();
        assert_eq!(row4b.bounty, 700);
        assert!(!v2.heads.iter().any(|h| h.seed == Some(4)));

        players.clear();
    }

    /// Техническая победа денег не приносит.
    #[test]
    fn walkover_pays_nothing() {
        let cfg = PrizeConfig {
            fund: 10_000,
            engine: PrizeEngineCfg::matches(200, 50),
            ..Default::default()
        };
        let players: Vec<ShapePlayer> = (1..=4).map(|i| player(i, i, false)).collect();
        let mut matches = shape(4, 4);
        matches[0].finished = true;
        matches[0].walkover = true;
        matches[0].winner_seed = Some(4);

        let v = view(&matches, &players, &cfg);
        assert!(v.rows.iter().all(|r| r.matches == 0));
        assert_eq!(v.remainder, 10_000);
    }

    /// Матчевые выплаты с множителем за андердога платят ступенью.
    #[test]
    fn underdog_multiplies_match_payment() {
        let cfg = PrizeConfig {
            fund: 10_000,
            engine: PrizeEngineCfg::matches(200, 50),
            addons: crate::model::PrizeAddonsCfg {
                underdog: true,
                ..Default::default()
            },
            ..Default::default()
        };
        let players: Vec<ShapePlayer> = (1..=8).map(|i| player(i, i, false)).collect();
        let mut matches = shape(8, 4);
        // Первый матч верхней сетки — сид 1 против сида 8, цена раунда единая.
        let base = {
            let clean = view(&matches, &players, &cfg);
            clean.match_prices[0].price
        };
        matches[0].finished = true;
        // Сид 8 (группа 5–8) бьёт сида 1 (группа 1–2): разница два — ×2.
        matches[0].winner_seed = Some(8);

        let v = view(&matches, &players, &cfg);
        let row8 = v.rows.iter().find(|r| r.seed == Some(8)).unwrap();
        assert_eq!(row8.matches, base * 2, "цена раунда {base}");

        // А победа фаворита не множится.
        matches[0].winner_seed = Some(1);
        let v2 = view(&matches, &players, &cfg);
        let row1 = v2.rows.iter().find(|r| r.seed == Some(1)).unwrap();
        assert_eq!(row1.matches, base);
    }

    /// Гонка новичков платит завершённому турниру по местам среди новичков.
    #[test]
    fn rookie_race_pays_by_places() {
        let cfg = PrizeConfig {
            fund: 10_000,
            engine: PrizeEngineCfg::places(vec![50, 30, 20]),
            addons: crate::model::PrizeAddonsCfg {
                rookie_race: Some(2_000),
                ..Default::default()
            },
            ..Default::default()
        };
        let mut players: Vec<ShapePlayer> = (1..=8).map(|i| player(i, i, false)).collect();
        players[6].rookie = true; // сид 7
        players[7].rookie = true; // сид 8
        players[7].place = Some(5);
        players[6].place = Some(7);

        let matches = shape(8, 4);
        let v = compute(&Input {
            matches: &matches,
            ladder_matches: &matches,
            players: &players,
            config: &cfg,
            jackpot_now: 0,
            finished: true,
            best_match: None,
        });

        // Новичков двое: 50% и 30% от 2000.
        let better = v
            .rows
            .iter()
            .find(|r| r.player_id == players[7].player_id)
            .unwrap();
        assert_eq!(better.rookie_prize, 1_000);
        let worse = v
            .rows
            .iter()
            .find(|r| r.player_id == players[6].player_id)
            .unwrap();
        assert_eq!(worse.rookie_prize, 600);
    }




    /// Пресеты оставляют движку долю и не ломают лестницу.
    #[test]
    fn presets_are_consistent() {
        for kind in [PRESET_PRO, PRESET_LOCAL, PRESET_ROOKIE, PRESET_SHOW] {
            let cfg = preset(kind, 10_000);
            let size = 16;
            let players: Vec<ShapePlayer> =
                (1..=size as i64).map(|i| player(i, i, false)).collect();
            let matches = shape(size, 4);
            let v = view(&matches, &players, &cfg);
            assert!(v.engine_share > 0, "пресет {kind}: доля движка {}", v.engine_share);
            assert!(v.check.ok, "пресет {kind}: {}", v.check.text);
        }
    }

    /// Лестница с надстройками даёт справку, а не запрет.
    #[test]
    fn addons_give_note_not_ban() {
        let cfg = PrizeConfig {
            fund: 10_000,
            engine: PrizeEngineCfg::places(vec![34, 24, 17, 11, 8, 6]),
            addons: crate::model::PrizeAddonsCfg {
                bounty: Some(crate::model::BountyCfg {
                    amounts: vec![700, 450, 350],
                    rollover: true,
                }),
                ..Default::default()
            },
            ..Default::default()
        };
        let players: Vec<ShapePlayer> = (1..=16).map(|i| player(i, i, false)).collect();
        let matches = shape(16, 4);
        let v = view(&matches, &players, &cfg);
        assert!(v.check.ok, "справка не запрещает: {}", v.check.text);
        assert!(v.note.is_some(), "надстройки переставляют места — это видно в справке");
    }

    /// Идущий матч платит за взятые карты сразу, по одинарной цене;
    /// победные удваиваются, когда матч доигран.
    #[test]
    fn maps_engine_pays_live_during_the_match() {
        let cfg = PrizeConfig {
            fund: 10_000,
            engine: PrizeEngineCfg::maps(),
            ..Default::default()
        };
        let players: Vec<ShapePlayer> = (1..=4).map(|i| player(i, i, false)).collect();
        let mut matches = shape(4, 4);
        // Первый матч идёт прямо сейчас, счёт по картам 2:1.
        matches[0].running = true;
        matches[0].maps_a = 2;
        matches[0].maps_b = 1;

        let v = view(&matches, &players, &cfg);
        let unit = v.map_price.as_ref().unwrap().loss as f64;
        let seed_b = matches[0].seed_b.expect("в первом матче есть оба сида");
        let live_a = v.rows.iter().find(|r| r.seed == Some(1)).unwrap().maps;
        let live_b = v.rows.iter().find(|r| r.seed == Some(seed_b)).unwrap().maps;
        assert!(
            (live_a as f64 - 2.0 * unit).abs() < 1.5,
            "живые карты по одинарной цене: {live_a} против {}",
            2.0 * unit
        );
        assert!((live_b as f64 - unit).abs() < 1.5, "карта проигравшего: {live_b}");

        // Живая ставка видна и в списке идущих матчей.
        assert_eq!(v.live.len(), 1, "идущий матч с картами даёт живую ставку");
        assert_eq!(v.live[0].maps_a, live_a);

        // Матч доигран победой первого: его карты удвоились, у второго те же.
        matches[0].running = false;
        matches[0].finished = true;
        matches[0].winner_seed = Some(1);
        let v2 = view(&matches, &players, &cfg);
        let done_a = v2.rows.iter().find(|r| r.seed == Some(1)).unwrap().maps;
        let done_b = v2.rows.iter().find(|r| r.seed == Some(seed_b)).unwrap().maps;
        assert!(done_a > live_a, "удвоение победных карт: {done_a} > {live_a}");
        assert_eq!(done_b, live_b, "карты проигравшего не меняются");
    }

    /// Движок охоты: вся доля движка — на головах, победа снимает голову,
    /// неснятую голову чемпиона забирает он сам.
    #[test]
    fn bounty_engine_pays_for_heads() {
        let cfg = PrizeConfig {
            fund: 10_000,
            engine: PrizeEngineCfg::bounty(vec![30, 25, 20, 15, 10], false),
            ..Default::default()
        };
        let players: Vec<ShapePlayer> = (1..=8).map(|i| player(i, i, false)).collect();
        let mut matches = shape(8, 4);

        // Сид 8 выбивает сида 1: голова первого (30% фонда) уходит убийце.
        matches[0].finished = true;
        matches[0].winner_seed = Some(8);

        let v = view(&matches, &players, &cfg);
        assert!(v.problems.is_empty(), "конфиг валиден: {:?}", v.problems);
        let head1 = 10_000 * 30 / 100;
        let killer = v.rows.iter().find(|r| r.seed == Some(8)).unwrap();
        assert_eq!(killer.bounty, head1, "голова первого сида снимается победой");

        // Головы на сейчас: первой уже нет, остальные висят.
        assert!(v.heads.iter().all(|h| h.seed != Some(1)), "снятой головы нет");
        assert_eq!(v.heads.len(), 4, "остальные головы на месте");

        // Лестница для охоты не сравнивается, но и не запрещает старт.
        assert!(v.check.ok, "{}", v.check.text);
        assert!(v.check.text.contains("голов"));

        // Чемпион (сид 2) доигрывает без поражений и забирает свою голову сам.
        let mut finished = matches.clone();
        let mut champ_place = players.clone();
        champ_place[1].place = Some(1);
        for m in finished.iter_mut() {
            if m.bracket != "grand" {
                continue;
            }
            m.finished = true;
            m.winner_seed = Some(2);
        }
        let v2 = compute(&Input {
            matches: &finished,
            ladder_matches: &matches,
            players: &champ_place,
            config: &cfg,
            jackpot_now: 0,
            finished: true,
            best_match: None,
        });
        let head2 = 10_000 * 25 / 100;
        let champ = v2.rows.iter().find(|r| r.seed == Some(2)).unwrap();
        assert_eq!(champ.bounty, head2, "неснятую голову забирает сам чемпион");
    }

    /// Движок охоты с перекатом: половина убийце, половина ему на голову.
    #[test]
    fn bounty_engine_rollover_moves_half_to_killer() {
        let cfg = PrizeConfig {
            fund: 10_000,
            engine: PrizeEngineCfg::bounty(vec![40, 30, 20, 10], true),
            ..Default::default()
        };
        let players: Vec<ShapePlayer> = (1..=8).map(|i| player(i, i, false)).collect();
        let mut matches = shape(8, 4);
        matches[0].finished = true;
        matches[0].winner_seed = Some(7);

        let v = view(&matches, &players, &cfg);
        let head1 = 10_000 * 40 / 100;
        let killer = v.rows.iter().find(|r| r.seed == Some(7)).unwrap();
        assert_eq!(killer.bounty, head1 / 2, "убийце — половина");

        // Вторая половина переехала на голову убийцы и ждёт следующего.
        let moved = v
            .heads
            .iter()
            .find(|h| h.seed == Some(7))
            .expect("голова переехала убийце");
        assert_eq!(moved.amount, head1 - head1 / 2);
    }

    /// Движок охоты несовместим с надстройкой баунти: платить за одно и то же
    /// дважды — ошибка конфигурации, а не воля организатора.
    #[test]
    fn bounty_engine_rejects_bounty_addon() {
        let cfg = PrizeConfig {
            fund: 10_000,
            engine: PrizeEngineCfg::bounty(vec![50, 30, 20], false),
            addons: crate::model::PrizeAddonsCfg {
                bounty: Some(crate::model::BountyCfg {
                    amounts: vec![700],
                    rollover: false,
                }),
                ..Default::default()
            },
            ..Default::default()
        };
        let players: Vec<ShapePlayer> = (1..=8).map(|i| player(i, i, false)).collect();
        let matches = shape(8, 4);
        let v = view(&matches, &players, &cfg);
        assert!(v.problems.iter().any(|p| p.contains("не нужна")));
    }
}
