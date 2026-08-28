//! Структуры ответов osu! API v2 (поля — как в API, snake_case)
//! и перевод их в наши модели из `crate::model`.
//!
//! Всё, что API может не прислать, — `Option`. Паниковать здесь нельзя ни на чём.

use serde::Deserialize;

use crate::model::{Beatmap, BeatmapAttributes, Failtimes};

// ───────────────────────────────────────────────────────────────── токен

/// Ответ `POST /oauth/token`.
#[derive(Debug, Clone, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    /// Секунды до истечения. По факту 86400, но полагаться на это не будем.
    #[serde(default = "default_expires_in")]
    pub expires_in: u64,
    #[serde(default)]
    pub token_type: Option<String>,
}

fn default_expires_in() -> u64 {
    86_400
}

/// Тело ошибки OAuth. Неверный ключ даёт `{"error":"invalid_client"}`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct OauthError {
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub error_description: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

// ───────────────────────────────────────────────────────────────── карты

/// Одна сложность: `GET /beatmaps/{id}` и элементы `beatmaps[]` внутри сета.
#[derive(Debug, Clone, Deserialize)]
pub struct BeatmapDto {
    pub id: i64,
    #[serde(default)]
    pub beatmapset_id: Option<i64>,
    #[serde(default)]
    pub checksum: Option<String>,

    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub user_id: Option<i64>,

    #[serde(default)]
    pub difficulty_rating: f64,
    #[serde(default)]
    pub bpm: Option<f64>,
    #[serde(default)]
    pub total_length: Option<i64>,
    #[serde(default)]
    pub hit_length: Option<i64>,

    #[serde(default)]
    pub cs: Option<f64>,
    #[serde(default)]
    pub ar: Option<f64>,
    /// В API это OD.
    #[serde(default)]
    pub accuracy: Option<f64>,
    /// В API это HP.
    #[serde(default)]
    pub drain: Option<f64>,

    #[serde(default)]
    pub count_circles: Option<i64>,
    #[serde(default)]
    pub count_sliders: Option<i64>,
    #[serde(default)]
    pub count_spinners: Option<i64>,
    #[serde(default)]
    pub max_combo: Option<i64>,

    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub last_updated: Option<String>,

    /// График фейлов: два массива по 100 чисел. Может прийти `null`.
    #[serde(default)]
    pub failtimes: Option<Failtimes>,

    /// Вложенный сет. У ответа `/beatmapsets/{id}` внутри диффов его нет.
    #[serde(default)]
    pub beatmapset: Option<BeatmapsetDto>,
}

/// Набор: `GET /beatmapsets/{id}`. Заодно вложен в каждую карту из `/beatmaps/{id}`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct BeatmapsetDto {
    #[serde(default)]
    pub id: Option<i64>,

    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub artist_unicode: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub title_unicode: Option<String>,
    #[serde(default)]
    pub creator: Option<String>,
    #[serde(default)]
    pub user_id: Option<i64>,
    #[serde(default)]
    pub source: Option<String>,

    /// Строка тегов через пробел.
    #[serde(default)]
    pub tags: Option<String>,
    /// Теги паков, в которые входит сет.
    #[serde(default)]
    pub pack_tags: Option<Vec<String>>,

    /// Жанр и язык приходят то числом, то объектом `{id, name}` — держим оба варианта.
    #[serde(default)]
    pub genre_id: Option<i64>,
    #[serde(default)]
    pub language_id: Option<i64>,
    #[serde(default)]
    pub genre: Option<NamedIdDto>,
    #[serde(default)]
    pub language: Option<NamedIdDto>,

    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub ranked_date: Option<String>,
    #[serde(default)]
    pub submitted_date: Option<String>,
    #[serde(default)]
    pub last_updated: Option<String>,
    #[serde(default)]
    pub bpm: Option<f64>,

    #[serde(default)]
    pub covers: Option<CoversDto>,
    #[serde(default)]
    pub preview_url: Option<String>,

    /// Все сложности сета. Есть только у `/beatmapsets/*`.
    #[serde(default)]
    pub beatmaps: Option<Vec<BeatmapDto>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct NamedIdDto {
    #[serde(default)]
    pub id: Option<i64>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct CoversDto {
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default, rename = "cover@2x")]
    pub cover_2x: Option<String>,
    #[serde(default)]
    pub card: Option<String>,
    #[serde(default, rename = "card@2x")]
    pub card_2x: Option<String>,
    #[serde(default)]
    pub list: Option<String>,
    #[serde(default, rename = "list@2x")]
    pub list_2x: Option<String>,
}

/// Ответ `GET /beatmaps?ids[]=...`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct BeatmapsResponse {
    #[serde(default)]
    pub beatmaps: Vec<BeatmapDto>,
}

/// Ответ `POST /beatmaps/{id}/attributes`.
#[derive(Debug, Clone, Deserialize)]
pub struct AttributesEnvelope {
    pub attributes: DifficultyAttributesDto,
}

/// Звёзды и скилл-разбивка под модами. Единственный источник SR с модами.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct DifficultyAttributesDto {
    #[serde(default)]
    pub star_rating: Option<f64>,
    #[serde(default)]
    pub aim_difficulty: Option<f64>,
    #[serde(default)]
    pub speed_difficulty: Option<f64>,
    #[serde(default)]
    pub slider_factor: Option<f64>,
    #[serde(default)]
    pub speed_note_count: Option<f64>,
    #[serde(default)]
    pub max_combo: Option<i64>,
}

// ────────────────────────────────────────────────────────── биты модов

/// Битовые значения модов, которые нужны турнирнику.
/// `NC` = 576, потому что несёт в себе бит `DT` (64) плюс свой (512).
pub const MOD_BITS: [(&str, u32); 7] = [
    ("EZ", 2),
    ("HD", 8),
    ("HR", 16),
    ("DT", 64),
    ("HT", 256),
    ("NC", 576),
    ("FL", 1024),
];

pub const BIT_EZ: u32 = 2;
pub const BIT_HD: u32 = 8;
pub const BIT_HR: u32 = 16;
pub const BIT_DT: u32 = 64;
pub const BIT_HT: u32 = 256;
pub const BIT_NC: u32 = 576;
pub const BIT_FL: u32 = 1024;

/// Строка модов -> битовая маска. Понимает «HDDT», «HD,DT», «hd dt», «NM».
pub fn mods_bits(mods: &str) -> u32 {
    let upper = mods.to_ascii_uppercase();
    let mut bits = 0;
    for (tag, bit) in MOD_BITS {
        if upper.contains(tag) {
            bits |= bit;
        }
    }
    bits
}

/// Битовая маска -> человекочитаемая строка. Пустая маска — «NM».
pub fn mods_label(bits: u32) -> String {
    if bits == 0 {
        return "NM".to_string();
    }
    let mut out = String::new();
    if bits & BIT_EZ != 0 {
        out.push_str("EZ");
    }
    if bits & BIT_HD != 0 {
        out.push_str("HD");
    }
    if bits & BIT_HR != 0 {
        out.push_str("HR");
    }
    if bits & BIT_HT != 0 {
        out.push_str("HT");
    }
    // NC узнаём по своему биту, иначе это обычный DT.
    if bits & BIT_NC == BIT_NC {
        out.push_str("NC");
    } else if bits & BIT_DT != 0 {
        out.push_str("DT");
    }
    if bits & BIT_FL != 0 {
        out.push_str("FL");
    }
    if out.is_empty() {
        "NM".to_string()
    } else {
        out
    }
}

// ─────────────────────────────────────────────────────────── конвертация

/// Текущее время в UTC строкой RFC3339. Если форматирование не удалось — пустая строка.
pub fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// Карта из API -> наша `Beatmap`.
///
/// `parent` — сет, если карта пришла внутри `/beatmapsets/{id}` и своего `beatmapset` не имеет.
/// Данные сета (артист, название, автор, теги) берутся из вложенного сета, иначе из `parent`,
/// иначе остаются пустыми — падать из-за отсутствия сета нельзя.
pub fn to_beatmap(dto: &BeatmapDto, parent: Option<&BeatmapsetDto>) -> Beatmap {
    let set = dto.beatmapset.as_ref().or(parent);

    let pack_tags = set.and_then(|s| s.pack_tags.as_ref()).and_then(|tags| {
        let joined = tags.join(" ");
        if joined.trim().is_empty() {
            None
        } else {
            Some(joined)
        }
    });

    Beatmap {
        beatmap_id: dto.id,
        beatmapset_id: dto.beatmapset_id.or_else(|| set.and_then(|s| s.id)),
        checksum: dto.checksum.clone(),

        artist: set.map(|s| s.artist.clone()).unwrap_or_default(),
        artist_unicode: set.and_then(|s| s.artist_unicode.clone()),
        title: set.map(|s| s.title.clone()).unwrap_or_default(),
        title_unicode: set.and_then(|s| s.title_unicode.clone()),
        version: dto.version.clone(),
        creator: set.and_then(|s| s.creator.clone()),
        creator_id: set.and_then(|s| s.user_id).or(dto.user_id),

        difficulty_rating: dto.difficulty_rating,
        bpm: dto.bpm.or_else(|| set.and_then(|s| s.bpm)),
        total_length: dto.total_length,
        hit_length: dto.hit_length,
        cs: dto.cs,
        ar: dto.ar,
        accuracy: dto.accuracy,
        drain: dto.drain,
        count_circles: dto.count_circles,
        count_sliders: dto.count_sliders,
        count_spinners: dto.count_spinners,
        max_combo: dto.max_combo,

        status: dto
            .status
            .clone()
            .or_else(|| set.and_then(|s| s.status.clone())),
        ranked_date: set.and_then(|s| s.ranked_date.clone()),
        last_updated: dto
            .last_updated
            .clone()
            .or_else(|| set.and_then(|s| s.last_updated.clone())),
        tags: set.and_then(|s| s.tags.clone()),
        pack_tags,
        genre_id: set.and_then(|s| s.genre_id.or_else(|| s.genre.as_ref().and_then(|g| g.id))),
        language_id: set.and_then(|s| {
            s.language_id
                .or_else(|| s.language.as_ref().and_then(|l| l.id))
        }),
        failtimes: dto.failtimes.clone(),

        // Файлы кладёт кеш-слой, здесь их знать неоткуда.
        cover_path: None,
        preview_path: None,

        note: None,
        is_manual: false,
        is_gone: false,
        added_at: now_iso(),

        mods: Vec::new(),
        fm_mods: Vec::new(),
        skillsets: Vec::new(),
        labels: Vec::new(),
        set_count: None,
    }
}

/// Ответ `/attributes` -> наша `BeatmapAttributes`. `mods` — та маска, которой спрашивали.
pub fn to_attributes(
    beatmap_id: i64,
    mods: u32,
    dto: &DifficultyAttributesDto,
) -> BeatmapAttributes {
    BeatmapAttributes {
        beatmap_id,
        mods: mods_label(mods),
        star_rating: dto.star_rating,
        aim_difficulty: dto.aim_difficulty,
        speed_difficulty: dto.speed_difficulty,
        slider_factor: dto.slider_factor,
        speed_note_count: dto.speed_note_count,
        max_combo: dto.max_combo,
        fetched_at: now_iso(),
    }
}

/// Ответ `/users/{id}` -> расширенный профиль для карточки игрока.
/// Всё необязательно: недостающие поля карточка просто не покажет.
pub fn to_player_profile(dto: UserDto) -> crate::model::PlayerOsuProfile {
    let stats = dto.statistics.unwrap_or_default();
    let team = dto.team.unwrap_or_default();
    let grades = stats.grade_counts.unwrap_or_default();
    let level = stats.level.unwrap_or_default();

    // Скрытые оценки (ssh и пр.) складываются с видимыми: карточка
    // показывает три числа, как на сайте без наведения.
    let ss = match (grades.ss, grades.ssh) {
        (Some(a), Some(b)) => Some(a + b),
        (a, b) => a.or(b),
    };
    let s = match (grades.s, grades.sh) {
        (Some(a), Some(b)) => Some(a + b),
        (a, b) => a.or(b),
    };

    let monthly = dto
        .monthly_playcounts
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| Some((m.start_date?.get(..7)?.to_string(), m.count.unwrap_or(0))))
        .collect();

    crate::model::PlayerOsuProfile {
        osu_user_id: dto.id,
        username: dto.username,
        country_code: dto.country_code,
        team_name: team.name,
        team_tag: team.tag,
        pp: stats.pp,
        global_rank: stats.global_rank,
        country_rank: stats.country_rank,
        accuracy: stats.hit_accuracy,
        play_count: stats.play_count,
        play_time: stats.play_time,
        max_combo: stats.max_combo,
        ranked_score: stats.ranked_score,
        total_score: stats.total_score,
        hit_count: stats.hit_count,
        replays_watched: stats.replays_watched,
        level_current: level.current,
        level_progress: level.progress,
        grades_ss: ss,
        grades_s: s,
        grades_a: grades.a,
        monthly_playcounts: monthly,
        fetched_at: now_iso(),
    }
}

// ─────────────────────────────────────────────── матчи мультиплеера

/// Ответ `GET /matches/{id}`.
///
/// Ключевое поле — `current_game_id`: это единственный мгновенный признак
/// «какая карта идёт сейчас». Появляется через пару секунд после старта карты
/// и обнуляется, когда карта кончилась.
#[derive(Debug, Clone, Deserialize)]
pub struct MatchDto {
    #[serde(default)]
    pub events: Vec<MatchEventDto>,
    #[serde(default)]
    pub users: Vec<MatchUserDto>,
    #[serde(default)]
    pub first_event_id: Option<i64>,
    #[serde(default)]
    pub latest_event_id: Option<i64>,
    /// Карта, которая играется прямо сейчас. `None` — между картами.
    #[serde(default)]
    pub current_game_id: Option<i64>,
    #[serde(rename = "match", default)]
    pub info: Option<MatchInfoDto>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MatchInfoDto {
    pub id: i64,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub end_time: Option<String>,
}

/// Событие лобби. Нас интересуют только те, у которых есть `game`.
#[derive(Debug, Clone, Deserialize)]
pub struct MatchEventDto {
    pub id: i64,
    #[serde(default)]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub user_id: Option<i64>,
    #[serde(default)]
    pub game: Option<MatchGameDto>,
}

/// Одна карта в лобби. Событие создаётся при **старте**, а `end_time` и `scores`
/// дописываются в него же — на этом и держится ловушка курсора (см. `air::lobby`).
#[derive(Debug, Clone, Deserialize)]
pub struct MatchGameDto {
    pub id: i64,
    #[serde(default)]
    pub beatmap_id: Option<i64>,
    #[serde(default)]
    pub start_time: Option<String>,
    /// Пока `None`, карта играется и массив `scores` пуст.
    #[serde(default)]
    pub end_time: Option<String>,
    #[serde(default)]
    pub mods: Vec<String>,
    #[serde(default)]
    pub beatmap: Option<BeatmapDto>,
    #[serde(default)]
    pub scores: Vec<MatchScoreDto>,
}

/// Скор одного игрока на карте лобби. Реплеев здесь не бывает: `has_replay`
/// у мультиплеерных скоров всегда `false`, файл остаётся только у игрока.
#[derive(Debug, Clone, Deserialize)]
pub struct MatchScoreDto {
    #[serde(default)]
    pub user_id: Option<i64>,
    /// Новое имя поля; у старой версии API то же число лежит в `score`.
    #[serde(default, alias = "score")]
    pub total_score: Option<i64>,
    #[serde(default)]
    pub accuracy: Option<f64>,
    #[serde(default)]
    pub max_combo: Option<i64>,
    #[serde(default)]
    pub passed: Option<bool>,
    #[serde(default)]
    pub rank: Option<String>,
    #[serde(default)]
    pub mods: Vec<String>,
    #[serde(default)]
    pub statistics: Option<ScoreStatsDto>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ScoreStatsDto {
    #[serde(default, alias = "count_300")]
    pub great: Option<i64>,
    #[serde(default, alias = "count_100")]
    pub ok: Option<i64>,
    #[serde(default, alias = "count_50")]
    pub meh: Option<i64>,
    #[serde(default, alias = "count_miss")]
    pub miss: Option<i64>,
}

/// Участник лобби. Ник и аватар приходят бесплатно вместе с матчем — ранги
/// и pp только отдельным запросом профиля.
#[derive(Debug, Clone, Deserialize)]
pub struct MatchUserDto {
    pub id: i64,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub country_code: Option<String>,
}

// ────────────────────────────────────────────────────────── профиль игрока

/// Ответ `GET /users/{id}` в той части, что нужна сценам с цифрами
/// и карточке игрока.
#[derive(Debug, Clone, Deserialize)]
pub struct UserDto {
    pub id: i64,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub country_code: Option<String>,
    #[serde(default)]
    pub statistics: Option<UserStatsDto>,
    /// Команда профиля. Появилась недавно и есть не у всех — потому Option.
    #[serde(default)]
    pub team: Option<UserTeamDto>,
    /// Игры по месяцам, для графика активности в карточке.
    #[serde(default)]
    pub monthly_playcounts: Option<Vec<MonthlyCountDto>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct UserStatsDto {
    #[serde(default)]
    pub pp: Option<f64>,
    #[serde(default)]
    pub global_rank: Option<i64>,
    #[serde(default)]
    pub country_rank: Option<i64>,
    #[serde(default)]
    pub hit_accuracy: Option<f64>,
    #[serde(default)]
    pub play_count: Option<i64>,
    #[serde(default)]
    pub max_combo: Option<i64>,
    #[serde(default)]
    pub ranked_score: Option<i64>,
    #[serde(default)]
    pub total_score: Option<i64>,
    /// Общее число нажатий за всё время.
    #[serde(default)]
    pub hit_count: Option<i64>,
    #[serde(default)]
    pub replays_watched: Option<i64>,
    /// Секунды за игрой.
    #[serde(default)]
    pub play_time: Option<i64>,
    /// Уровень профиля и прогресс до следующего (0..100).
    #[serde(default)]
    pub level: Option<UserLevelDto>,
    /// Оценки SS/S/A за всё время, включая скрытые (ssh и пр.).
    #[serde(default)]
    pub grade_counts: Option<UserGradesDto>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct UserLevelDto {
    #[serde(default)]
    pub current: Option<i64>,
    #[serde(default)]
    pub progress: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct UserGradesDto {
    #[serde(default, alias = "ss+")]
    pub ss: Option<i64>,
    #[serde(default, alias = "ssh+")]
    pub ssh: Option<i64>,
    #[serde(default, alias = "s+")]
    pub s: Option<i64>,
    #[serde(default, alias = "sh+")]
    pub sh: Option<i64>,
    #[serde(default, alias = "a+")]
    pub a: Option<i64>,
}

/// Команда профиля: то, что карточка показывает бейджем.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UserTeamDto {
    #[serde(default)]
    pub id: Option<i64>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
}

/// Одна точка графика активности: месяц и число игр в нём.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MonthlyCountDto {
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub count: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mods_bits_reads_any_spelling() {
        assert_eq!(mods_bits("NM"), 0);
        assert_eq!(mods_bits("HD"), BIT_HD);
        assert_eq!(mods_bits("HDDT"), BIT_HD | BIT_DT);
        assert_eq!(mods_bits("hd,dt"), BIT_HD | BIT_DT);
        assert_eq!(mods_bits("HR DT"), BIT_HR | BIT_DT);
        // NC несёт в себе бит DT, но не HT.
        assert_eq!(mods_bits("NC"), BIT_NC);
        assert_ne!(mods_bits("NC") & BIT_DT, 0);
        assert_eq!(mods_bits("NC") & BIT_HT, 0);
    }

    #[test]
    fn mods_label_builds_string_back() {
        assert_eq!(mods_label(0), "NM");
        assert_eq!(mods_label(BIT_HD | BIT_DT), "HDDT");
        assert_eq!(mods_label(BIT_NC), "NC");
        assert_eq!(mods_label(BIT_HR | BIT_HD), "HDHR");
    }

    /// Поля `beatmapset` может не быть — это не повод падать.
    #[test]
    fn beatmap_without_set_survives() {
        let dto: BeatmapDto = serde_json::from_str(
            r#"{"id": 75, "version": "Normal", "difficulty_rating": 2.5, "failtimes": null}"#,
        )
        .expect("тестовый json валиден");
        let map = to_beatmap(&dto, None);
        assert_eq!(map.beatmap_id, 75);
        assert_eq!(map.artist, "");
        assert!(map.failtimes.is_none());
        assert!(!map.is_manual);
    }

    #[test]
    fn failtimes_parsed_as_object() {
        let dto: BeatmapDto =
            serde_json::from_str(r#"{"id": 1, "failtimes": {"fail": [1,2,3], "exit": [4,5]}}"#)
                .expect("тестовый json валиден");
        let ft = dto.failtimes.expect("failtimes есть");
        assert_eq!(ft.fail.len(), 3);
        assert_eq!(ft.exit.len(), 2);
    }
}
