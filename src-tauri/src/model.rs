//! Структуры, которые ходят между Rust и фронтом.
//! Зеркалят `src/lib/types.ts` — менять только парой.

use serde::{Deserialize, Serialize};

pub const MOD_TAGS: [&str; 7] = ["NM", "HD", "HR", "DT", "FM", "EZ", "TB"];

// ─────────────────────────────────────────────────────────────── карты

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Beatmap {
    pub beatmap_id: i64,
    pub beatmapset_id: Option<i64>,
    pub checksum: Option<String>,

    pub artist: String,
    pub artist_unicode: Option<String>,
    pub title: String,
    pub title_unicode: Option<String>,
    pub version: String,
    pub creator: Option<String>,
    pub creator_id: Option<i64>,

    pub difficulty_rating: f64,
    pub bpm: Option<f64>,
    pub total_length: Option<i64>,
    pub hit_length: Option<i64>,
    pub cs: Option<f64>,
    pub ar: Option<f64>,
    pub accuracy: Option<f64>,
    pub drain: Option<f64>,
    pub count_circles: Option<i64>,
    pub count_sliders: Option<i64>,
    pub count_spinners: Option<i64>,
    pub max_combo: Option<i64>,

    pub status: Option<String>,
    pub ranked_date: Option<String>,
    pub last_updated: Option<String>,
    pub tags: Option<String>,
    pub pack_tags: Option<String>,
    pub genre_id: Option<i64>,
    pub language_id: Option<i64>,
    pub failtimes: Option<Failtimes>,

    pub cover_path: Option<String>,
    pub preview_path: Option<String>,

    pub note: Option<String>,
    pub is_manual: bool,
    pub is_gone: bool,
    pub added_at: String,

    pub mods: Vec<String>,
    pub fm_mods: Vec<String>,
    pub skillsets: Vec<SkillsetTag>,
    pub labels: Vec<Label>,

    /// Сколько сложностей у набора. Заполняется только в схлопнутом списке —
    /// в остальных местах строка отвечает сама за себя.
    #[serde(default)]
    pub set_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Failtimes {
    #[serde(default)]
    pub fail: Vec<i64>,
    #[serde(default)]
    pub exit: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsetTag {
    pub skillset: String,
    pub suggested: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Label {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatmapAttributes {
    pub beatmap_id: i64,
    pub mods: String,
    pub star_rating: Option<f64>,
    pub aim_difficulty: Option<f64>,
    pub speed_difficulty: Option<f64>,
    pub slider_factor: Option<f64>,
    pub speed_note_count: Option<f64>,
    pub max_combo: Option<i64>,
    pub fetched_at: String,
}

// ─────────────────────────────────────────────────────────── коллекции

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: i64,
    pub name: String,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub folder_id: Option<i64>,
    pub position: i64,
    pub is_smart: bool,
    pub filter: Option<LibraryFilter>,
    pub count: i64,
    pub created_at: String,
}

// ─────────────────────────────────────────────────────────────── фильтр

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub min: Option<f64>,
    pub max: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFilter {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub mods: Vec<String>,
    #[serde(default)]
    pub skillsets: Vec<String>,
    #[serde(default)]
    pub label_ids: Vec<i64>,
    #[serde(default)]
    pub statuses: Vec<String>,
    #[serde(default)]
    pub stars: Range,
    #[serde(default)]
    pub bpm: Range,
    #[serde(default)]
    pub length: Range,
    #[serde(default)]
    pub collection_id: Option<i64>,
    /// Только карты без единого мод-тега. Это место в библиотеке, а не условие:
    /// сброс фильтра его не трогает, как и коллекцию.
    #[serde(default)]
    pub no_mods: bool,
    /// Схлопывать сложности одного набора в одну строку.
    #[serde(default)]
    pub group_sets: bool,
    #[serde(default = "default_sort")]
    pub sort: String,
    #[serde(default = "default_dir")]
    pub dir: String,
}

fn default_sort() -> String {
    "added".into()
}
fn default_dir() -> String {
    "desc".into()
}

impl Default for LibraryFilter {
    fn default() -> Self {
        Self {
            query: String::new(),
            mods: vec![],
            skillsets: vec![],
            label_ids: vec![],
            statuses: vec![],
            stars: Range::default(),
            bpm: Range::default(),
            length: Range::default(),
            collection_id: None,
            no_mods: false,
            group_sets: false,
            sort: default_sort(),
            dir: default_dir(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: i64,
    pub offset: i64,
}

// ───────────────────────────────────────────────── ключ и подключение

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApiCredentials {
    pub client_id: String,
    pub client_secret: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum CredentialsCheck {
    #[serde(rename = "ok")]
    Ok,
    #[serde(rename = "invalid")]
    Invalid { message: String },
    #[serde(rename = "offline")]
    Offline { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub has_credentials: bool,
    pub online: bool,
    pub onboarded: bool,
    pub db_path: String,
    pub cache_path: String,
}

// ──────────────────────────────────────────────── импорт по ссылкам

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedLinks {
    pub beatmap_ids: Vec<i64>,
    pub beatmapset_ids: Vec<i64>,
    pub unknown: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub batch_id: String,
    pub stage: String,
    pub done: i64,
    pub total: i64,
    pub added: i64,
    pub skipped: i64,
    pub failed: Vec<ImportFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    #[serde(rename = "ref")]
    pub reference: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStatus {
    pub pending: i64,
    pub done: i64,
    pub failed: i64,
    pub budget: i64,
    pub active_batch: Option<String>,
}

// ──────────────────────────────────────────── шаблоны маппулов

/// Правила генерации. Все поля с `default`, поэтому старый шаблон
/// с неполным JSON читается без ошибки.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenRules {
    #[serde(default)]
    pub no_repeat_mapper: bool,
    #[serde(default)]
    pub no_repeat_from_pools: Vec<i64>,
    #[serde(default)]
    pub min_bpm_spread: Option<f64>,
    #[serde(default)]
    pub ranked_only: bool,
    #[serde(default)]
    pub balance_skillsets: bool,
    #[serde(default)]
    pub length_max: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSlot {
    pub id: i64,
    /// Мод-тег слота. `mod` — ключевое слово Rust, поэтому поле названо иначе.
    #[serde(rename = "mod")]
    pub mod_tag: String,
    pub count: i64,
    pub star_min: Option<f64>,
    pub star_max: Option<f64>,
    pub source_collection_id: Option<i64>,
    pub required_skillsets: Vec<String>,
    pub position: i64,
}

/// Слот, каким его присылает редактор: без id и позиции — порядок задаётся
/// самим списком, а id раздаются при сохранении.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSlotInput {
    #[serde(rename = "mod")]
    pub mod_tag: String,
    pub count: i64,
    #[serde(default)]
    pub star_min: Option<f64>,
    #[serde(default)]
    pub star_max: Option<f64>,
    #[serde(default)]
    pub source_collection_id: Option<i64>,
    #[serde(default)]
    pub required_skillsets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolTemplate {
    pub id: i64,
    pub name: String,
    pub rules: GenRules,
    pub created_at: String,
    pub slots: Vec<TemplateSlot>,
}

/// Сколько карт нужно под слот и сколько нашлось в его источнике.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotSupply {
    pub position: i64,
    #[serde(rename = "mod")]
    pub mod_tag: String,
    pub need: i64,
    pub available: i64,
}

// ────────────────────────────────────────────────────────── маппулы

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolSlot {
    pub id: i64,
    pub slot_label: String,
    #[serde(rename = "mod")]
    pub mod_tag: String,
    pub beatmap_id: Option<i64>,
    pub pinned: bool,
    pub star_rating_with_mods: Option<f64>,
    pub fm_mods: Vec<String>,
    pub position: i64,
    /// Заполняется только при чтении одного пула — в списке карты не нужны.
    pub beatmap: Option<Beatmap>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pool {
    pub id: i64,
    pub name: String,
    pub template_id: Option<i64>,
    pub template_name: Option<String>,
    pub folder_id: Option<i64>,
    pub status: String,
    pub version: i64,
    pub parent_pool_id: Option<i64>,
    pub display_fields: Vec<String>,
    pub is_locked: bool,
    pub created_at: String,
    pub slots: Vec<PoolSlot>,
}

/// Итог генерации: сам пул и то, что не получилось выдержать.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenReport {
    pub pool: Pool,
    pub notes: Vec<String>,
}

// ───────────────────────────────────────────────────────────── игроки

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Player {
    pub id: i64,
    pub nickname: String,
    pub osu_user_id: Option<i64>,
    pub color: String,
    pub avatar_path: Option<String>,
    pub note: Option<String>,
    pub is_archived: bool,
    pub created_at: String,
}

/// Личный счёт с конкретным соперником.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerVersus {
    pub player_id: i64,
    pub nickname: String,
    pub wins: i64,
    pub losses: i64,
}

/// Всё посчитано по матчам на момент запроса — отдельного счётчика,
/// который мог бы разойтись с историей, нет.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerStats {
    pub player_id: i64,
    pub tournaments: i64,
    pub tournament_wins: i64,
    /// Занятые места, по возрастанию: 1, 2, 2, 4…
    pub placements: Vec<i64>,
    pub matches: i64,
    pub match_wins: i64,
    pub maps: i64,
    pub map_wins: i64,
    pub best_mod: Option<String>,
    pub worst_mod: Option<String>,
    pub favourite_beatmap: Option<i64>,
    pub versus: Vec<PlayerVersus>,
}

// ──────────────────────────────────────────────────────────── турниры

/// До скольких побед играют. Общее число, а по раундам — только там,
/// где решили иначе: финал часто длиннее группового.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ByRound {
    pub default: i64,
    /// Ключ — номер раунда как строка: JSON не умеет числовые ключи.
    #[serde(default)]
    pub rounds: std::collections::HashMap<String, i64>,
}

impl ByRound {
    pub fn new(default: i64) -> ByRound {
        ByRound {
            default,
            rounds: std::collections::HashMap::new(),
        }
    }

    pub fn at(&self, round: i64) -> i64 {
        self.rounds
            .get(&round.to_string())
            .copied()
            .unwrap_or(self.default)
    }
}

/// Турнир целиком. С фронта приходит полями, а не структурой, поэтому
/// только на сериализацию.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tournament {
    pub id: i64,
    pub name: String,
    pub status: String,
    pub bracket_size: i64,
    pub target_score: ByRound,
    pub bans_per_round: ByRound,
    /// random | higherSeed | lowerSeed — решается на старте каждого матча.
    pub first_ban: String,
    pub no_repeat_pool: bool,
    pub created_at: String,
    pub finished_at: Option<String>,
    pub players: Vec<TournamentPlayer>,
    pub pool_ids: Vec<i64>,
}

/// Игрок внутри турнира. Цвет свой: в другом турнире у него может быть
/// другой, а глобальный при этом не меняется.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TournamentPlayer {
    pub player_id: i64,
    pub nickname: String,
    pub seed: Option<i64>,
    pub color: String,
    pub placement: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    pub id: i64,
    pub tournament_id: i64,
    /// upper | lower | grand
    pub bracket: String,
    pub round: i64,
    pub slot_in_bracket: i64,
    pub player_a: Option<i64>,
    pub player_b: Option<i64>,
    pub pool_id: Option<i64>,
    pub status: String,
    pub winner_id: Option<i64>,
    pub is_walkover: bool,
    pub is_manual_edit: bool,
    pub first_ban_by: Option<i64>,
    pub next_win_slot: Option<i64>,
    pub next_lose_slot: Option<i64>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    /// Счёт по сыгранным картам. Считается из действий, а не хранится.
    pub score_a: i64,
    pub score_b: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchAction {
    pub n: i64,
    /// ban | pick | result
    #[serde(rename = "type")]
    pub kind: String,
    pub actor_id: Option<i64>,
    pub slot_label: String,
    pub winner_id: Option<i64>,
    pub source: String,
    pub at: String,
}

/// Состояние строки маппула в матче.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RowState {
    /// Свободна — можно банить или пикать.
    #[serde(rename = "free")]
    Free,
    #[serde(rename = "banned")]
    Banned { by: Option<i64>, n: i64 },
    /// Пикнута и играется прямо сейчас: ждём, кто выиграл.
    #[serde(rename = "playing")]
    Playing { by: Option<i64> },
    #[serde(rename = "played")]
    Played { winner: Option<i64>, n: i64 },
    /// TB ещё закрыт: откроется на счёте «оба в шаге от победы».
    #[serde(rename = "locked")]
    Locked { hint: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchRow {
    pub slot_label: String,
    #[serde(rename = "mod")]
    pub mod_tag: String,
    pub beatmap: Option<Beatmap>,
    pub star_rating_with_mods: Option<f64>,
    pub state: RowState,
}

/// Что матчу делать дальше. Считается из списка действий целиком,
/// поэтому откат — это просто удаление хвоста.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Phase {
    /// Матч ещё не начат: не выбран маппул или первый банящий.
    #[serde(rename = "notStarted")]
    NotStarted,
    #[serde(rename = "ban")]
    Ban {
        actor: i64,
        done: i64,
        total: i64,
    },
    #[serde(rename = "pick")]
    Pick { actor: i64 },
    /// Карта пикнута — пока не скажут, кто её выиграл, дальше хода нет.
    #[serde(rename = "result")]
    Result { slot_label: String },
    #[serde(rename = "finished")]
    Finished { winner: Option<i64> },
}

/// Полное состояние экрана матча: и сам матч, и строки, и чей ход.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchState {
    #[serde(flatten)]
    pub match_info: Match,
    pub tournament_name: String,
    pub players: Vec<TournamentPlayer>,
    pub rows: Vec<MatchRow>,
    pub actions: Vec<MatchAction>,
    pub phase: Phase,
    /// До скольких побед играет этот матч.
    pub target: i64,
    /// Кому осталась одна победа — метка «матчпоинт».
    pub match_point: Vec<i64>,
}

/// Турнир вместе с сеткой — то, из чего рисуется экран турнира.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bracket {
    #[serde(flatten)]
    pub tournament: Tournament,
    pub matches: Vec<Match>,
}
