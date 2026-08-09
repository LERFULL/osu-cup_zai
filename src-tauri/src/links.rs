//! Разбор произвольного текста на ссылки osu!.
//!
//! Пользователь вставляет что угодно — кусок чата, JSON с комментариями, список из блокнота.
//! Задача: вытащить оттуда id карт и наборов, а всё подозрительное сложить в `unknown`,
//! чтобы человек увидел, что именно не разобралось.

use std::collections::HashSet;

use once_cell::sync::Lazy;
use regex::Regex;

use crate::model::ParsedLinks;

/// Сколько нераспознанных строк показываем максимум — список для человека, не для машины.
const UNKNOWN_LIMIT: usize = 20;

/// Кандидат: всё, что выглядит как адрес на `ppy.sh`.
///
/// Схема и `www.` необязательны, поддомен любой — нужный хост отбирается отдельно.
/// Перед адресом требуем разделитель, иначе `xppy.sh` и `почта@ppy.sh` дают ложные срабатывания.
/// В путь не пускаем скобки, кавычки и запятую: так ссылка не склеивается с markdown-разметкой
/// `[текст](ссылка)` и с текстом вокруг.
///
/// Группы: 1 — ссылка целиком, 2 — хост, 3 — путь.
static OSU_LINK: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)(?:^|[^0-9a-z.@-])((?:https?://)?((?:[a-z0-9-]+\.)*ppy\.sh)(/[^\s<>"'`()\[\]{},]*)?)"#,
    )
    .unwrap()
});

/// Набор с указанием конкретной сложности: `/beatmapsets/1234567#osu/765432`.
/// Режим игнорируем — важен только id диффа.
static RE_SET_DIFF: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^/beatmapsets/(\d+)[^#]*#[a-z]*/?(\d+)").unwrap());

/// Набор целиком: `/beatmapsets/1234567` с любым хвостом — `/discussion`, `?mode=osu`, слэш.
static RE_SET: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^/beatmapsets/(\d+)(?:[/?&#].*)?$").unwrap());

/// Конкретная сложность: короткая `/b/765432` и полная `/beatmaps/765432`.
static RE_MAP: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^/(?:b|beatmaps)/(\d+)(?:[/?&#].*)?$").unwrap());

/// Старая форма набора: `/s/1234567`.
static RE_SET_OLD: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^/s/(\d+)(?:[/?&#].*)?$").unwrap());

/// Что нашли в одной ссылке.
enum Hit {
    /// Конкретная сложность и набор, из которого она взята, если он был в ссылке.
    Map { id: i64, from_set: Option<i64> },
    /// Набор целиком.
    Set(i64),
}

/// Достаёт id карт и наборов из произвольного текста.
///
/// Порядок сохраняется по первому появлению, дубли выкидываются.
/// Голые числа за ссылки не считаются — только адреса.
pub fn parse(text: &str) -> ParsedLinks {
    let mut out = ParsedLinks::default();

    let mut seen_maps: HashSet<i64> = HashSet::new();
    let mut seen_sets: HashSet<i64> = HashSet::new();
    let mut seen_unknown: HashSet<String> = HashSet::new();
    // Наборы, для которых где-то в тексте нашлась конкретная сложность.
    let mut sets_with_diff: HashSet<i64> = HashSet::new();

    for caps in OSU_LINK.captures_iter(text) {
        let whole = trim_tail(caps.get(1).map_or("", |m| m.as_str()));
        let host = caps.get(2).map_or("", |m| m.as_str()).to_ascii_lowercase();
        let path = trim_tail(caps.get(3).map_or("", |m| m.as_str()));

        match recognize(&host, path) {
            Some(Hit::Map { id, from_set }) => {
                if let Some(set_id) = from_set {
                    sets_with_diff.insert(set_id);
                }
                if seen_maps.insert(id) {
                    out.beatmap_ids.push(id);
                }
            }
            Some(Hit::Set(id)) => {
                if seen_sets.insert(id) {
                    out.beatmapset_ids.push(id);
                }
            }
            None => {
                if out.unknown.len() < UNKNOWN_LIMIT && seen_unknown.insert(whole.to_string()) {
                    out.unknown.push(whole.to_string());
                }
            }
        }
    }

    // Если у набора есть конкретный дифф, сам набор не нужен: иначе затянем все сложности.
    out.beatmapset_ids.retain(|id| !sets_with_diff.contains(id));

    out
}

/// Разбирает один адрес. `None` — похоже на osu!, но не распознано.
fn recognize(host: &str, path: &str) -> Option<Hit> {
    if !host_is_osu(host) || path.is_empty() {
        return None;
    }

    if let Some(c) = RE_SET_DIFF.captures(path) {
        // Битый id диффа делает всю ссылку непонятной, набор из неё тоже не берём.
        let set_id = to_id(&c[1]);
        let map_id = to_id(&c[2])?;
        return Some(Hit::Map {
            id: map_id,
            from_set: set_id,
        });
    }
    if let Some(c) = RE_SET.captures(path) {
        return Some(Hit::Set(to_id(&c[1])?));
    }
    if let Some(c) = RE_MAP.captures(path) {
        return Some(Hit::Map {
            id: to_id(&c[1])?,
            from_set: None,
        });
    }
    if let Some(c) = RE_SET_OLD.captures(path) {
        return Some(Hit::Set(to_id(&c[1])?));
    }

    None
}

/// Хосты, на которых ссылки действительно ведут на карты.
/// Всё остальное — `assets.ppy.sh`, `b.ppy.sh` и прочее — уедет в `unknown`.
fn host_is_osu(host: &str) -> bool {
    matches!(
        host,
        "ppy.sh"
            | "www.ppy.sh"
            | "osu.ppy.sh"
            | "www.osu.ppy.sh"
            | "old.ppy.sh"
            | "www.old.ppy.sh"
    )
}

/// Срезает знаки препинания, прилипшие к концу ссылки в живом тексте:
/// точка в конце предложения, кавычки, звёздочки markdown.
fn trim_tail(s: &str) -> &str {
    s.trim_end_matches(|c| matches!(c, '.' | ',' | ';' | ':' | '!' | '?' | '"' | '\'' | '*' | '_'))
}

/// Строка в id. Только положительное целое, влезающее в i64 — переполнение не паникует.
fn to_id(s: &str) -> Option<i64> {
    match s.parse::<i64>() {
        Ok(n) if n > 0 => Some(n),
        _ => None,
    }
}

// ────────────────────────────────────────────────────────────────── тесты

#[cfg(test)]
mod tests {
    use super::*;

    /// Набор без указания сложности.
    #[test]
    fn set_only() {
        let r = parse("https://osu.ppy.sh/beatmapsets/1234567");
        assert_eq!(r.beatmapset_ids, vec![1234567]);
        assert!(r.beatmap_ids.is_empty());
        assert!(r.unknown.is_empty());
    }

    /// Набор с якорем на дифф даёт только дифф.
    #[test]
    fn set_with_diff_gives_diff_only() {
        let r = parse("https://osu.ppy.sh/beatmapsets/1234567#osu/765432");
        assert_eq!(r.beatmap_ids, vec![765432]);
        assert!(r.beatmapset_ids.is_empty());
    }

    /// Режим в якоре не важен.
    #[test]
    fn mode_in_anchor_ignored() {
        let r = parse("https://osu.ppy.sh/beatmapsets/1234567#mania/7654");
        assert_eq!(r.beatmap_ids, vec![7654]);
        assert!(r.beatmapset_ids.is_empty());
    }

    /// Короткая форма карты `/b/`.
    #[test]
    fn short_map_form() {
        let r = parse("https://osu.ppy.sh/b/765432");
        assert_eq!(r.beatmap_ids, vec![765432]);
    }

    /// Полная форма карты `/beatmaps/`.
    #[test]
    fn full_map_form() {
        let r = parse("https://osu.ppy.sh/beatmaps/765432");
        assert_eq!(r.beatmap_ids, vec![765432]);
    }

    /// Старая форма набора `/s/`.
    #[test]
    fn old_set_form() {
        let r = parse("https://osu.ppy.sh/s/1234567");
        assert_eq!(r.beatmapset_ids, vec![1234567]);
    }

    /// Схема, `www` и `old` — всё это одна и та же ссылка.
    #[test]
    fn scheme_www_and_old_hosts() {
        let r = parse(
            "osu.ppy.sh/b/1\nhttp://osu.ppy.sh/b/2\nhttps://www.osu.ppy.sh/b/3\nold.ppy.sh/b/4",
        );
        assert_eq!(r.beatmap_ids, vec![1, 2, 3, 4]);
        assert!(r.unknown.is_empty());
    }

    /// Хвосты после адреса: раздел, query, завершающий слэш.
    #[test]
    fn trailing_parts() {
        let r = parse(
            "https://osu.ppy.sh/beatmapsets/11/discussion
             https://osu.ppy.sh/beatmapsets/22?mode=osu
             https://osu.ppy.sh/beatmapsets/33/
             https://osu.ppy.sh/b/44?mode=osu&m=0
             https://osu.ppy.sh/beatmapsets/55?mode=osu#osu/66",
        );
        assert_eq!(r.beatmapset_ids, vec![11, 22, 33]);
        assert_eq!(r.beatmap_ids, vec![44, 66]);
        assert!(r.unknown.is_empty());
    }

    /// Ссылка в скобках, в кавычках и в конце предложения с точкой.
    #[test]
    fn brackets_quotes_and_final_dot() {
        let r = parse(
            r#"Смотри (https://osu.ppy.sh/b/111), потом "https://osu.ppy.sh/b/222" и https://osu.ppy.sh/b/333."#,
        );
        assert_eq!(r.beatmap_ids, vec![111, 222, 333]);
        assert!(r.unknown.is_empty());
    }

    /// Markdown-ссылка `[текст](адрес)`.
    #[test]
    fn markdown_link() {
        let r =
            parse("[тайбрейк](https://osu.ppy.sh/beatmapsets/999#osu/888) и [набор](osu.ppy.sh/s/777)");
        assert_eq!(r.beatmap_ids, vec![888]);
        assert_eq!(r.beatmapset_ids, vec![777]);
        assert!(r.unknown.is_empty());
    }

    /// Дубли выкидываются, порядок первого появления сохраняется.
    #[test]
    fn dedup_keeps_first_order() {
        let r = parse(
            "osu.ppy.sh/b/300 osu.ppy.sh/b/100 osu.ppy.sh/beatmaps/300
             osu.ppy.sh/s/50 osu.ppy.sh/beatmapsets/50 osu.ppy.sh/b/100",
        );
        assert_eq!(r.beatmap_ids, vec![300, 100]);
        assert_eq!(r.beatmapset_ids, vec![50]);
    }

    /// Набор и дифф того же набора схлопываются в один дифф.
    #[test]
    fn set_collapses_into_diff() {
        let r = parse(
            "https://osu.ppy.sh/beatmapsets/1234567
             https://osu.ppy.sh/beatmapsets/1234567#osu/765432
             https://osu.ppy.sh/beatmapsets/7654321",
        );
        assert_eq!(r.beatmap_ids, vec![765432]);
        assert_eq!(r.beatmapset_ids, vec![7654321]);
    }

    /// Схлопывание работает и когда набор встретился после диффа.
    #[test]
    fn set_collapses_in_reverse_order() {
        let r = parse(
            "https://osu.ppy.sh/beatmapsets/42#osu/99
             https://osu.ppy.sh/beatmapsets/42",
        );
        assert_eq!(r.beatmap_ids, vec![99]);
        assert!(r.beatmapset_ids.is_empty());
    }

    /// Живой кусок чата: ссылки вперемешку с текстом, временем и числами.
    #[test]
    fn mixed_discord_chat() {
        let text = r#"
NAGISA — Сегодня, в 21:03
короче вот пул на завтра
https://osu.ppy.sh/beatmapsets/1234567#osu/2650201 <- NM1, изи
https://osu.ppy.sh/b/2650202 NM2

KIRA — Сегодня, в 21:05
хд возьмём отсюда: osu.ppy.sh/beatmapsets/998877
а ТБ вот (https://osu.ppy.sh/beatmapsets/555#osu/556).
кстати 2650202 уже был, но ладно
профиль мой https://osu.ppy.sh/users/4242 если что
"#;
        let r = parse(text);
        assert_eq!(r.beatmap_ids, vec![2650201, 2650202, 556]);
        assert_eq!(r.beatmapset_ids, vec![998877]);
        assert_eq!(r.unknown, vec!["https://osu.ppy.sh/users/4242"]);
    }

    /// Голое число — не id.
    #[test]
    fn bare_numbers_are_not_ids() {
        let r = parse("возьми 1234567 и ещё 765432, а также #osu/999");
        assert_eq!(r, ParsedLinks::default());
    }

    /// Похоже на osu!, но не карта — в unknown, строкой как есть.
    #[test]
    fn unrecognized_goes_to_unknown() {
        let r = parse(
            "https://osu.ppy.sh/users/2
             https://assets.ppy.sh/beatmaps/1234567/covers/card@2x.jpg
             https://osu.ppy.sh/b/777",
        );
        assert_eq!(r.beatmap_ids, vec![777]);
        assert_eq!(
            r.unknown,
            vec![
                "https://osu.ppy.sh/users/2",
                "https://assets.ppy.sh/beatmaps/1234567/covers/card@2x.jpg",
            ]
        );
    }

    /// Список unknown обрезается на двадцати.
    #[test]
    fn unknown_is_capped() {
        let text = (0..50)
            .map(|i| format!("https://osu.ppy.sh/users/{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let r = parse(&text);
        assert_eq!(r.unknown.len(), UNKNOWN_LIMIT);
        assert_eq!(r.unknown[0], "https://osu.ppy.sh/users/0");
    }

    /// Ноль и число, не влезающее в i64, не роняют разбор.
    #[test]
    fn broken_ids_do_not_panic() {
        let r = parse(
            "https://osu.ppy.sh/b/99999999999999999999999999
             https://osu.ppy.sh/b/0
             https://osu.ppy.sh/beatmapsets/0
             https://osu.ppy.sh/b/5",
        );
        assert_eq!(r.beatmap_ids, vec![5]);
        assert!(r.beatmapset_ids.is_empty());
        assert_eq!(r.unknown.len(), 3);
    }

    /// Похожий хост — не наш хост.
    #[test]
    fn lookalike_host_is_not_matched() {
        let r = parse("зайди на notppy.sh/b/1 и напиши на почту me@ppy.sh");
        assert_eq!(r, ParsedLinks::default());
    }

    /// Пустой ввод.
    #[test]
    fn empty_input() {
        assert_eq!(parse(""), ParsedLinks::default());
        assert_eq!(parse("   \n\t  "), ParsedLinks::default());
    }

    /// Текст без единой ссылки на osu!.
    #[test]
    fn text_without_links() {
        let r = parse("Привет! Завтра в восемь, приноси свой пул.\nhttps://example.com/page");
        assert_eq!(r, ParsedLinks::default());
    }
}
