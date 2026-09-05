//! Пересчёт того, чего API не отдаёт: AR/OD/CS/HP, BPM и длина с учётом модов.
//!
//! osu! возвращает только «голые» значения карты, а в турнире слот почти всегда с модом.
//! Скорость (DT/HT) меняет AR и OD не линейно, а через окно в миллисекундах —
//! именно так, как считает сама игра.

use serde::{Deserialize, Serialize};

use crate::model::Beatmap;

use super::dto::{mods_bits, BIT_DT, BIT_EZ, BIT_HR, BIT_HT};

/// Значения карты с учётом мода слота.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Derived {
    pub cs: f64,
    pub ar: f64,
    pub od: f64,
    pub hp: f64,
    pub bpm: f64,
    /// Полная длина в секундах.
    pub total_length: i64,
}

/// AR -> окно появления нот в миллисекундах.
pub fn ar_to_ms(ar: f64) -> f64 {
    if ar < 5.0 {
        1800.0 - 120.0 * ar
    } else {
        1200.0 - 150.0 * (ar - 5.0)
    }
}

/// Миллисекунды -> AR.
pub fn ms_to_ar(ms: f64) -> f64 {
    if ms > 1200.0 {
        (1800.0 - ms) / 120.0
    } else {
        5.0 + (1200.0 - ms) / 150.0
    }
}

/// OD -> окно попадания «300» в миллисекундах.
pub fn od_to_ms(od: f64) -> f64 {
    79.5 - 6.0 * od
}

/// Миллисекунды -> OD.
pub fn ms_to_od(ms: f64) -> f64 {
    (79.5 - ms) / 6.0
}

/// Пересчёт под моды. `mods` — строка вида «NM», «HR», «HDDT», «HR,DT».
///
/// Порядок обязателен: сначала HR или EZ (они правят сами числа),
/// потом DT или HT (они правят скорость, а значит и окна в миллисекундах).
pub fn derive(map: &Beatmap, mods: &str) -> Derived {
    let bits = mods_bits(mods);

    let mut cs = map.cs.unwrap_or(0.0);
    let mut ar = map.ar.unwrap_or(0.0);
    let mut od = map.accuracy.unwrap_or(0.0);
    let mut hp = map.drain.unwrap_or(0.0);
    let mut bpm = map.bpm.unwrap_or(0.0);
    let length = map.total_length.unwrap_or(0) as f64;

    // ── шаг 1: сложность самой карты
    if bits & BIT_HR != 0 {
        cs = (cs * 1.3).min(10.0);
        ar = (ar * 1.4).min(10.0);
        od = (od * 1.4).min(10.0);
        hp = (hp * 1.4).min(10.0);
    } else if bits & BIT_EZ != 0 {
        cs *= 0.5;
        ar *= 0.5;
        od *= 0.5;
        hp *= 0.5;
    }

    // ── шаг 2: скорость. NC несёт в себе бит DT, отдельной ветки не нужно.
    let rate = if bits & BIT_DT != 0 {
        1.5
    } else if bits & BIT_HT != 0 {
        0.75
    } else {
        1.0
    };

    let total_length = if rate == 1.0 {
        length.round()
    } else {
        bpm *= rate;
        // Окна сжимаются во столько же раз, во сколько ускоряется музыка.
        ar = ms_to_ar(ar_to_ms(ar) / rate).clamp(0.0, 11.0);
        od = ms_to_od(od_to_ms(od) / rate).clamp(0.0, 11.0);
        (length / rate).round()
    };

    Derived {
        cs: round1(cs),
        ar: round1(ar),
        od: round1(od),
        hp: round1(hp),
        bpm: round1(bpm),
        total_length: total_length.max(0.0) as i64,
    }
}

/// Один знак после запятой — в интерфейсе больше не нужно.
fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Заготовка карты: CS 4, AR 9, OD 8, HP 6, 180 BPM, 200 секунд.
    fn sample() -> Beatmap {
        Beatmap {
            beatmap_id: 1,
            beatmapset_id: None,
            checksum: None,
            artist: "Camellia".into(),
            artist_unicode: None,
            title: "GHOST".into(),
            title_unicode: None,
            version: "Haunted".into(),
            creator: None,
            creator_id: None,
            difficulty_rating: 8.35,
            bpm: Some(180.0),
            total_length: Some(200),
            hit_length: Some(190),
            cs: Some(4.0),
            ar: Some(9.0),
            accuracy: Some(8.0),
            drain: Some(6.0),
            count_circles: None,
            count_sliders: None,
            count_spinners: None,
            max_combo: None,
            status: None,
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
            added_at: String::new(),
            mods: vec![],
            fm_mods: vec![],
            skillsets: vec![],
            labels: vec![],
            set_count: None,
            set_stars_min: None,
            set_stars_max: None,
        }
    }

    #[test]
    fn nm_changes_nothing() {
        let d = derive(&sample(), "NM");
        assert_eq!(d.cs, 4.0);
        assert_eq!(d.ar, 9.0);
        assert_eq!(d.od, 8.0);
        assert_eq!(d.hp, 6.0);
        assert_eq!(d.bpm, 180.0);
        assert_eq!(d.total_length, 200);
    }

    #[test]
    fn hr_multiplies_and_caps_at_ten() {
        let d = derive(&sample(), "HR");
        assert_eq!(d.cs, 5.2); // 4 x 1.3
        assert_eq!(d.ar, 10.0); // 12.6 упёрлось в потолок
        assert_eq!(d.od, 10.0); // 11.2 упёрлось в потолок
        assert_eq!(d.hp, 8.4); // 6 x 1.4
        assert_eq!(d.bpm, 180.0);
        assert_eq!(d.total_length, 200);
    }

    #[test]
    fn ez_halves_everything() {
        let d = derive(&sample(), "EZ");
        assert_eq!(d.cs, 2.0);
        assert_eq!(d.ar, 4.5);
        assert_eq!(d.od, 4.0);
        assert_eq!(d.hp, 3.0);
        assert_eq!(d.bpm, 180.0);
        assert_eq!(d.total_length, 200);
    }

    #[test]
    fn dt_recounts_ar_through_milliseconds() {
        let d = derive(&sample(), "DT");
        // AR9 -> 600 мс -> 400 мс -> 10.33
        assert_eq!(d.ar, 10.3);
        // OD8 -> 31.5 мс -> 21 мс -> 9.75
        assert_eq!(d.od, 9.8);
        assert_eq!(d.cs, 4.0);
        assert_eq!(d.hp, 6.0);
        assert_eq!(d.bpm, 270.0);
        assert_eq!(d.total_length, 133);
    }

    #[test]
    fn nc_works_like_dt() {
        assert_eq!(derive(&sample(), "NC"), derive(&sample(), "DT"));
    }

    #[test]
    fn ht_slows_down() {
        let d = derive(&sample(), "HT");
        // AR9 -> 600 мс -> 800 мс -> 7.67
        assert_eq!(d.ar, 7.7);
        // OD8 -> 31.5 мс -> 42 мс -> 6.25
        assert_eq!(d.od, 6.3);
        assert_eq!(d.bpm, 135.0);
        assert_eq!(d.total_length, 267);
    }

    #[test]
    fn hr_dt_applies_in_order() {
        let d = derive(&sample(), "HRDT");
        assert_eq!(d.cs, 5.2);
        // AR 9 -> HR 12.6 -> потолок 10 -> 450 мс -> 300 мс -> 11
        assert_eq!(d.ar, 11.0);
        // OD 8 -> HR 11.2 -> потолок 10 -> 19.5 мс -> 13 мс -> 11.08, режем до 11
        assert_eq!(d.od, 11.0);
        assert_eq!(d.hp, 8.4);
        assert_eq!(d.bpm, 270.0);
        assert_eq!(d.total_length, 133);
    }

    #[test]
    fn missing_values_do_not_panic() {
        let mut map = sample();
        map.ar = None;
        map.cs = None;
        map.accuracy = None;
        map.drain = None;
        map.bpm = None;
        map.total_length = None;

        let d = derive(&map, "HDDT");
        assert_eq!(d.bpm, 0.0);
        assert_eq!(d.total_length, 0);
    }
}
