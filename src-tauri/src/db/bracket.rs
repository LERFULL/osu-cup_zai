//! Построение сетки на двойное выбывание.
//!
//! Считается один раз при создании турнира и сохраняется целиком: связи
//! «победитель идёт туда, проигравший сюда» удобнее иметь в базе, чем
//! пересчитывать при каждом показе.
//!
//! Модуль сознательно не знает про SQLite — на входе размер и сеяние,
//! на выходе список заготовок матчей. Так его можно проверить тестами
//! без базы.

/// Заготовка матча: связи ещё индексами внутри `Vec`, а не id из базы.
#[derive(Debug, Clone, PartialEq)]
pub struct Seat {
    pub bracket: &'static str,
    pub round: i64,
    pub slot: i64,
    /// Кто здесь играет, если известно с самого начала (первый раунд).
    pub player_a: Option<i64>,
    pub player_b: Option<i64>,
    pub next_win: Option<usize>,
    pub next_lose: Option<usize>,
}

/// Ближайшая степень двойки, не меньше `n`. Меньше двух участников
/// турнира не бывает.
pub fn bracket_size(n: usize) -> usize {
    let mut size = 2;
    while size < n {
        size *= 2;
    }
    size
}

/// Порядок сеяния для верхней сетки: 1 против последнего, 2 против
/// предпоследнего и так далее вглубь. Сильные встречаются не раньше финала.
///
/// Возвращает позиции (с единицы) в порядке пар: [1, 8, 5, 4, 3, 6, 7, 2].
pub fn seed_order(size: usize) -> Vec<usize> {
    let mut order = vec![1usize, 2];
    while order.len() < size {
        let round = order.len() * 2 + 1;
        let mut next = Vec::with_capacity(order.len() * 2);
        for s in order {
            next.push(s);
            next.push(round - s);
        }
        order = next;
    }
    order
}

/// Сетка под фактический состав. `seeded[i]` — id игрока на позиции сеяния
/// `i + 1`, либо `None`, если место пустое.
///
/// Скелет считается на ближайшую степень двойки, а потом с него срезается
/// всё, чего на самом деле не будет: при пятерых на восьми местах трое
/// сильнейших проходят первый раунд сами, и рисовать им матч с пустотой
/// незачем. Смотри `prune`.
///
/// Раунды нижней сетки чередуются: в чётных к выбывшим из верхней сетки
/// приходит новая партия, в нечётных играют между собой уже упавшие.
pub fn build(size: usize, seeded: &[Option<i64>]) -> Vec<Seat> {
    let size = bracket_size(size.max(2));
    let order = seed_order(size);

    let mut seats: Vec<Seat> = Vec::new();

    // ── верхняя сетка
    // upper[r] — индексы матчей раунда r (с нуля).
    let mut upper: Vec<Vec<usize>> = Vec::new();
    let mut round = 1i64;
    let mut width = size / 2;

    while width >= 1 {
        let mut row = Vec::with_capacity(width);
        for slot in 0..width {
            let (a, b) = if round == 1 {
                let ia = order[slot * 2] - 1;
                let ib = order[slot * 2 + 1] - 1;
                (
                    seeded.get(ia).copied().flatten(),
                    seeded.get(ib).copied().flatten(),
                )
            } else {
                (None, None)
            };
            row.push(seats.len());
            seats.push(Seat {
                bracket: "upper",
                round,
                slot: slot as i64,
                player_a: a,
                player_b: b,
                next_win: None,
                next_lose: None,
            });
        }
        upper.push(row);
        if width == 1 {
            break;
        }
        width /= 2;
        round += 1;
    }

    // ── нижняя сетка
    // Раунды идут парами: «приём выбывших» и «свои против своих».
    let mut lower: Vec<Vec<usize>> = Vec::new();
    let mut lower_round = 1i64;
    let mut lower_width = size / 4;

    // Первый раунд нижней сетки — из проигравших первого раунда верхней.
    if size >= 4 {
        let mut row = Vec::with_capacity(lower_width);
        for slot in 0..lower_width {
            row.push(seats.len());
            seats.push(Seat {
                bracket: "lower",
                round: lower_round,
                slot: slot as i64,
                player_a: None,
                player_b: None,
                next_win: None,
                next_lose: None,
            });
        }
        lower.push(row);

        // Дальше: приём выбывших (та же ширина), затем сужение вдвое.
        let mut take_drop = true;
        while lower_width >= 1 {
            lower_round += 1;
            let width = if take_drop {
                lower_width
            } else {
                lower_width / 2
            };
            if width == 0 {
                break;
            }

            let mut row = Vec::with_capacity(width);
            for slot in 0..width {
                row.push(seats.len());
                seats.push(Seat {
                    bracket: "lower",
                    round: lower_round,
                    slot: slot as i64,
                    player_a: None,
                    player_b: None,
                    next_win: None,
                    next_lose: None,
                });
            }
            lower.push(row);

            if !take_drop {
                lower_width /= 2;
            }
            take_drop = !take_drop;
            if lower_width == 0 {
                break;
            }
        }
    }

    // ── гранд-финал
    let grand = seats.len();
    seats.push(Seat {
        bracket: "grand",
        round: 1,
        slot: 0,
        player_a: None,
        player_b: None,
        next_win: None,
        next_lose: None,
    });

    link(&mut seats, &upper, &lower, grand);
    prune(seats)
}

/// Проставляет «победитель туда, проигравший сюда».
fn link(seats: &mut [Seat], upper: &[Vec<usize>], lower: &[Vec<usize>], grand: usize) {
    // Верхняя сетка: победитель — в следующий раунд, проигравший — в нижнюю.
    for r in 0..upper.len() {
        for (slot, &idx) in upper[r].iter().enumerate() {
            let win = if r + 1 < upper.len() {
                Some(upper[r + 1][slot / 2])
            } else {
                Some(grand)
            };

            // Проигравшие первого раунда идут в первый раунд нижней сетки,
            // остальные — в «приёмные» раунды: 2, 4, 6…
            let lose = if lower.is_empty() {
                None
            } else if r == 0 {
                lower.first().map(|row| row[slot / 2])
            } else {
                lower.get(r * 2 - 1).and_then(|row| row.get(slot).copied())
            };

            seats[idx].next_win = win;
            seats[idx].next_lose = lose;
        }
    }

    // Нижняя сетка: проигравший выбывает окончательно.
    for r in 0..lower.len() {
        for (slot, &idx) in lower[r].iter().enumerate() {
            let win = match lower.get(r + 1) {
                Some(next) => {
                    // Если следующий раунд той же ширины — это приём выбывших,
                    // место сохраняется; если вдвое уже — пары сходятся.
                    let target = if next.len() == lower[r].len() {
                        slot
                    } else {
                        slot / 2
                    };
                    next.get(target).copied()
                }
                None => Some(grand),
            };
            seats[idx].next_win = win;
            seats[idx].next_lose = None;
        }
    }
}

/// Кто придёт в матч: конкретный игрок — по сеянию или проходом без игры —
/// либо победитель матча, который ещё не сыгран.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Arrival {
    Known(i64),
    Unknown,
}

fn known(a: &Arrival) -> Option<i64> {
    match a {
        Arrival::Known(id) => Some(*id),
        Arrival::Unknown => None,
    }
}

/// Куда ссылка ведёт на самом деле: пропущенные матчи прозрачны.
///
/// У пропущенного матча участник ровно один, и он едет дальше по той же
/// ссылке — значит, идём по ней, пока не встретим настоящий матч.
fn resolve(seats: &[Seat], kept: &[bool], arrivals: &[Vec<Arrival>], from: usize) -> Option<usize> {
    let mut idx = from;
    loop {
        if kept[idx] {
            return Some(idx);
        }
        match seats[idx].next_win {
            Some(next) if arrivals[idx].len() == 1 => idx = next,
            _ => return None,
        }
    }
}

/// Срезает со скелета всё, чего в этом составе не будет.
///
/// Матч, в который приходит меньше двух участников, играть не с кем: один
/// проходит дальше сам, а если не пришёл никто — ветка обрывается. Из
/// восьмиместного скелета на пятерых так остаются ровно восемь настоящих
/// матчей, а не одиннадцать, три из которых — техпобеды над пустотой.
fn prune(seats: Vec<Seat>) -> Vec<Seat> {
    let mut arrivals: Vec<Vec<Arrival>> = seats
        .iter()
        .map(|s| {
            [s.player_a, s.player_b]
                .iter()
                .filter_map(|p| p.map(Arrival::Known))
                .collect()
        })
        .collect();

    // Ссылки идут только вперёд, поэтому хватает одного прохода: к моменту
    // разбора матча все, кто в него ведёт, уже посчитаны.
    let mut kept = vec![false; seats.len()];
    for i in 0..seats.len() {
        let here = arrivals[i].clone();
        if here.len() == 1 {
            if let Some(next) = seats[i].next_win {
                arrivals[next].push(here[0]);
            }
            continue;
        }
        if here.is_empty() {
            continue;
        }

        kept[i] = true;
        for next in [seats[i].next_win, seats[i].next_lose]
            .into_iter()
            .flatten()
        {
            arrivals[next].push(Arrival::Unknown);
        }
    }

    // Место в матче сохраняем: если сверху ждут победителя, а снизу уже стоит
    // прошедший без игры, менять их местами значит перекрутить линии сетки.
    let mut out: Vec<Seat> = Vec::new();
    let mut index = vec![usize::MAX; seats.len()];
    for (i, seat) in seats.iter().enumerate() {
        if !kept[i] {
            continue;
        }
        index[i] = out.len();
        out.push(Seat {
            player_a: arrivals[i].first().and_then(known),
            player_b: arrivals[i].get(1).and_then(known),
            ..seat.clone()
        });
    }

    for (i, seat) in seats.iter().enumerate() {
        if index[i] == usize::MAX {
            continue;
        }
        let win = seat
            .next_win
            .and_then(|n| resolve(&seats, &kept, &arrivals, n));
        let lose = seat
            .next_lose
            .and_then(|n| resolve(&seats, &kept, &arrivals, n));
        let target = &mut out[index[i]];
        target.next_win = win.map(|t| index[t]);
        target.next_lose = lose.map(|t| index[t]);
    }

    renumber(&mut out);
    out
}

/// Номера раундов и мест — заново: после срезки в них появляются дыры,
/// а по номеру раунда считаются и правила матча, и подписи колонок.
fn renumber(seats: &mut [Seat]) {
    for bracket in ["upper", "lower", "grand"] {
        let mut rounds: Vec<i64> = seats
            .iter()
            .filter(|s| s.bracket == bracket)
            .map(|s| s.round)
            .collect();
        rounds.sort_unstable();
        rounds.dedup();

        for s in seats.iter_mut().filter(|s| s.bracket == bracket) {
            let at = rounds.iter().position(|r| *r == s.round).unwrap_or(0);
            s.round = at as i64 + 1;
        }
    }

    // Порядок в списке — сверху вниз внутри раунда, поэтому места просто
    // пересчитываем подряд, начиная заново на каждом новом раунде.
    let mut prev: Option<(&str, i64)> = None;
    let mut slot = 0;
    for s in seats.iter_mut() {
        if prev != Some((s.bracket, s.round)) {
            prev = Some((s.bracket, s.round));
            slot = 0;
        }
        s.slot = slot;
        slot += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Полный состав на `n` мест: игроки с id от единицы.
    fn full(n: usize) -> Vec<Option<i64>> {
        (1..=n as i64).map(Some).collect()
    }

    /// Состав из `players` человек на сетке в `size` мест: хвост пуст.
    fn partial(size: usize, players: usize) -> Vec<Option<i64>> {
        (0..size)
            .map(|i| {
                if i < players {
                    Some(i as i64 + 1)
                } else {
                    None
                }
            })
            .collect()
    }

    fn count(seats: &[Seat], bracket: &str) -> usize {
        seats.iter().filter(|s| s.bracket == bracket).count()
    }

    #[test]
    fn size_rounds_up_to_power_of_two() {
        assert_eq!(bracket_size(2), 2);
        assert_eq!(bracket_size(3), 4);
        assert_eq!(bracket_size(5), 8);
        assert_eq!(bracket_size(8), 8);
        assert_eq!(bracket_size(9), 16);
    }

    #[test]
    fn seeding_keeps_favourites_apart() {
        assert_eq!(seed_order(2), vec![1, 2]);
        assert_eq!(seed_order(4), vec![1, 4, 2, 3]);
        // 1 и 2 расходятся по разным половинам и встречаются только в финале.
        assert_eq!(seed_order(8), vec![1, 8, 4, 5, 2, 7, 3, 6]);
    }

    #[test]
    fn every_match_leads_somewhere() {
        let seats = build(8, &full(8));
        let last = seats.len() - 1;

        for (i, s) in seats.iter().enumerate() {
            if i == last {
                assert_eq!(s.next_win, None, "последний матч никуда не ведёт");
            } else {
                assert!(s.next_win.is_some(), "матч {i} ведёт победителя в никуда");
            }
            // Ссылки не должны вести назад: иначе сетка зациклится.
            if let Some(w) = s.next_win {
                assert!(w > i, "матч {i} отправляет победителя назад");
            }
            if let Some(l) = s.next_lose {
                assert!(l > i, "матч {i} отправляет проигравшего назад");
            }
        }
    }

    #[test]
    fn double_elimination_gives_everyone_two_lives() {
        // На 8 участников: 7 матчей верхней + 6 нижней + гранд-финал.
        let seats = build(8, &full(8));

        assert_eq!(count(&seats, "upper"), 7);
        assert_eq!(count(&seats, "grand"), 1);
        // Каждый, кроме победителя верхней сетки, должен где-то проиграть
        // второй раз: матчей нижней сетки на один меньше, чем её участников.
        assert_eq!(count(&seats, "lower"), 6);
    }

    #[test]
    fn first_round_seats_seeded_players() {
        let seats = build(4, &full(4));
        let first: Vec<_> = seats
            .iter()
            .filter(|s| s.bracket == "upper" && s.round == 1)
            .collect();

        assert_eq!(first.len(), 2);
        // 1 против 4, 2 против 3 — сильнейшие разведены по половинам.
        assert_eq!((first[0].player_a, first[0].player_b), (Some(1), Some(4)));
        assert_eq!((first[1].player_a, first[1].player_b), (Some(2), Some(3)));
    }

    #[test]
    fn losers_of_first_round_meet_in_lower_bracket() {
        let seats = build(4, &full(4));
        let first: Vec<usize> = seats
            .iter()
            .enumerate()
            .filter(|(_, s)| s.bracket == "upper" && s.round == 1)
            .map(|(i, _)| i)
            .collect();

        // Оба проигравших первого раунда попадают в один и тот же матч.
        assert_eq!(seats[first[0]].next_lose, seats[first[1]].next_lose);
        assert!(seats[first[0]].next_lose.is_some());
    }

    #[test]
    fn incomplete_roster_gets_a_bracket_of_its_own_size() {
        // Пятеро на восьми местах: трое сильнейших проходят первый раунд
        // сами, и матча у них там нет. Всего на двойном выбывании играется
        // 2n-2 матча — восемь, а не одиннадцать.
        let seats = build(8, &partial(8, 5));
        assert_eq!(seats.len(), 8, "лишние матчи должны быть срезаны");

        let first: Vec<_> = seats
            .iter()
            .filter(|s| s.bracket == "upper" && s.round == 1)
            .collect();
        assert_eq!(first.len(), 1, "в первом раунде играет только одна пара");
        assert_eq!((first[0].player_a, first[0].player_b), (Some(4), Some(5)));

        // Ни в одном матче не осталось места, в которое некому прийти.
        for (i, s) in seats.iter().enumerate() {
            let waiting = s.player_a.is_none()
                && s.player_b.is_none()
                && !seats
                    .iter()
                    .any(|src| src.next_win == Some(i) || src.next_lose == Some(i));
            assert!(!waiting, "матч {i} заперт: игроки не придут");
        }
    }

    #[test]
    fn bye_puts_the_player_straight_into_the_next_round() {
        // Трое: второй с третьим играют, первый ждёт их в финале верхней.
        let seats = build(4, &partial(4, 3));
        let semi = seats
            .iter()
            .find(|s| s.bracket == "upper" && s.round == 1)
            .unwrap();
        assert_eq!((semi.player_a, semi.player_b), (Some(2), Some(3)));

        let upper_final = seats
            .iter()
            .find(|s| s.bracket == "upper" && s.round == 2)
            .unwrap();
        assert_eq!(
            upper_final.player_a,
            Some(1),
            "прошедший без игры уже сидит"
        );
        assert_eq!(upper_final.player_b, None, "второе место ждёт победителя");
    }

    #[test]
    fn two_players_play_a_single_match() {
        // Нижней сетки на двоих нет, значит и гранд-финалу неоткуда взяться:
        // второго участника в него не приведёт ни одна ветка.
        let seats = build(2, &full(2));
        assert_eq!(seats.len(), 1);
        assert_eq!((seats[0].player_a, seats[0].player_b), (Some(1), Some(2)));
        assert_eq!(seats[0].next_win, None);
    }

    #[test]
    fn rounds_are_numbered_without_gaps() {
        // На пятерых первый раунд нижней сетки вырезается целиком —
        // оставшиеся не должны начинаться со второго.
        let seats = build(8, &partial(8, 5));
        for bracket in ["upper", "lower", "grand"] {
            let mut rounds: Vec<i64> = seats
                .iter()
                .filter(|s| s.bracket == bracket)
                .map(|s| s.round)
                .collect();
            rounds.sort_unstable();
            rounds.dedup();

            let expected: Vec<i64> = (1..=rounds.len() as i64).collect();
            assert_eq!(rounds, expected, "раунды {bracket} идут с пропусками");
        }
    }
}
