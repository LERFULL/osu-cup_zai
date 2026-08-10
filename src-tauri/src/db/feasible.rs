//! Хватит ли карт на матч по заданным правилам.
//!
//! Правила и маппул задаются в разных местах и в разное время, поэтому
//! несовместимость легко собрать по частям: девять карт, по два бана
//! каждому и игра до четырёх побед не сходятся, но по отдельности
//! каждое число выглядит разумным. Считаем это здесь, один раз, и
//! показываем до начала матча, а не в момент, когда играть уже нечем.

/// Сколько карт нужно и сколько есть. Тайбрейк считаем отдельно: он
/// разыгрывается не всегда, и запирать им проверку неправильно.
#[derive(Debug, Clone, Copy)]
pub struct Demand {
    /// Строк в маппуле без тайбрейка.
    pub playable: i64,
    /// Есть ли в маппуле тайбрейк.
    pub has_tiebreaker: bool,
    /// До скольких побед играем.
    pub target: i64,
    /// Банов на игрока.
    pub bans_each: i64,
}

/// Что не сходится. Пустой список — правила выполнимы.
pub fn check(d: Demand) -> Vec<String> {
    let mut out = Vec::new();

    if d.target < 1 {
        out.push("Играть до нуля побед нельзя".to_string());
    }
    if d.bans_each < 0 {
        out.push("Отрицательное число банов".to_string());
    }
    if d.target < 1 || d.bans_each < 0 {
        return out;
    }

    let bans = d.bans_each * 2;
    // Худший случай — счёт до последней карты: обоим нужно по target-1
    // победе, и только следующая карта заканчивает матч.
    let longest = d.target * 2 - 1;

    if bans >= d.playable {
        out.push(format!(
            "Банов {bans}, а играбельных карт {} — банить будет нечего",
            d.playable
        ));
        return out;
    }

    let left = d.playable - bans;

    // Тайбрейк закрывает ровно последнюю карту самой длинной серии.
    let need = if d.has_tiebreaker {
        longest - 1
    } else {
        longest
    };

    if left < need {
        let tail = if d.has_tiebreaker {
            " (не считая тайбрейк)"
        } else {
            ""
        };
        out.push(format!(
            "После банов останется {left}, а до {} побед может понадобиться {need}{tail}",
            d.target
        ));
    }

    if !d.has_tiebreaker && left == need {
        out.push(
            "Тайбрейка в маппуле нет: при равном счёте решать будет последняя оставшаяся карта"
                .to_string(),
        );
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(playable: i64, tb: bool, target: i64, bans: i64) -> Demand {
        Demand {
            playable,
            has_tiebreaker: tb,
            target,
            bans_each: bans,
        }
    }

    #[test]
    fn nine_maps_two_bans_each_to_four_wins_does_not_fit() {
        // Тот самый случай из обкатки: 8 играбельных + тайбрейк,
        // по два бана каждому — остаётся 4, а нужно 6.
        let notes = check(d(8, true, 4, 2));
        assert!(!notes.is_empty(), "правила невыполнимы, это надо показать");
    }

    #[test]
    fn standard_pool_fits() {
        // 10 играбельных плюс тайбрейк, по одному бану, до 5 побед.
        assert!(check(d(10, true, 5, 1)).is_empty());
    }

    #[test]
    fn bans_eating_whole_pool_is_reported() {
        let notes = check(d(4, false, 2, 2));
        assert!(notes.iter().any(|n| n.contains("банить будет нечего")));
    }

    #[test]
    fn missing_tiebreaker_is_only_a_warning_when_maps_suffice() {
        // 7 играбельных, по одному бану: остаётся 5 — ровно самая длинная
        // серия до трёх побед. Играть можно, но предупредить стоит.
        let notes = check(d(7, false, 3, 1));
        assert_eq!(notes.len(), 1);
        assert!(notes[0].contains("Тайбрейка"));
    }

    #[test]
    fn zero_target_is_rejected() {
        assert!(!check(d(10, true, 0, 1)).is_empty());
    }
}
