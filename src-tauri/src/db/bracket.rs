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

/// Полная сетка на `size` мест. `seeded[i]` — id игрока на позиции сеяния
/// `i + 1`, либо `None`, если место пустое (тогда соперник проходит дальше
/// технической победой — это решает уже вызывающий код).
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
    seats
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let seats = build(8, &vec![None; 8]);
        let grand = seats.iter().position(|s| s.bracket == "grand").unwrap();

        for (i, s) in seats.iter().enumerate() {
            if i == grand {
                assert_eq!(s.next_win, None, "гранд-финал никуда не ведёт");
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
        let seats = build(8, &vec![None; 8]);
        let upper = seats.iter().filter(|s| s.bracket == "upper").count();
        let lower = seats.iter().filter(|s| s.bracket == "lower").count();
        let grand = seats.iter().filter(|s| s.bracket == "grand").count();

        assert_eq!(upper, 7);
        assert_eq!(grand, 1);
        // Каждый, кроме победителя верхней сетки, должен где-то проиграть
        // второй раз: матчей нижней сетки на один меньше, чем её участников.
        assert_eq!(lower, 6);
    }

    #[test]
    fn first_round_seats_seeded_players() {
        let players: Vec<Option<i64>> = (1..=4).map(Some).collect();
        let seats = build(4, &players);
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
        let seats = build(4, &vec![None; 4]);
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
}
