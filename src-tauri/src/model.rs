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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub min: Option<f64>,
    pub max: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
///
/// У каждого правила своя строгость: строгое не выполнилось — слот остался
/// пустым, мягкое — слот заполнился, а нарушение попало в отчёт. «Только
/// ranked» и потолок длины строгие по умолчанию: их обходят осознанно.
/// Разброс BPM и баланс скилсетов — мягкие: это пожелания к пулу целиком,
/// и запирать ими отдельный слот бессмысленно.
///
/// `no_repeat_mapper` и `no_repeat_from_pools` уехали в исключения, чтобы всё
/// «чего не берём» лежало в одном месте. Поля тут больше нет — миграция 003
/// перенесла их значения и вычистила из JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenRules {
    #[serde(default)]
    pub min_bpm_spread: Option<f64>,
    #[serde(default)]
    pub min_bpm_spread_strict: bool,
    #[serde(default)]
    pub ranked_only: bool,
    #[serde(default = "yes")]
    pub ranked_only_strict: bool,
    #[serde(default)]
    pub balance_skillsets: bool,
    #[serde(default)]
    pub balance_skillsets_strict: bool,
    #[serde(default)]
    pub length_max: Option<i64>,
    #[serde(default = "yes")]
    pub length_max_strict: bool,
}

fn yes() -> bool {
    true
}

impl Default for GenRules {
    fn default() -> Self {
        Self {
            min_bpm_spread: None,
            min_bpm_spread_strict: false,
            ranked_only: false,
            ranked_only_strict: true,
            balance_skillsets: false,
            balance_skillsets_strict: false,
            length_max: None,
            length_max_strict: true,
        }
    }
}

// ─────────────────────────────────────────────── источники карт

/// Откуда брать карты. `Filter` — сохранённые условия без коллекции: так
/// «текущий фильтр библиотеки» становится источником, не превращаясь в
/// умную коллекцию, которой потом никто не пользуется.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Source {
    #[serde(rename = "library")]
    Library,
    #[serde(rename = "collection")]
    Collection { id: i64 },
    #[serde(rename = "filter")]
    Filter { filter: LibraryFilter },
}

/// Набор источников уровня. `union` — все сливаются в один набор, `ordered` —
/// берём из первого, чего не хватило, добираем из второго.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSet {
    #[serde(default)]
    pub items: Vec<Source>,
    #[serde(default = "union")]
    pub mode: String,
}

fn union() -> String {
    "union".into()
}

impl Default for SourceSet {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            mode: union(),
        }
    }
}

impl SourceSet {
    /// Пустой набор ничего не задаёт: уровень наследует источники выше.
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn ordered(&self) -> bool {
        // Один источник по приоритету — это тот же union: переключатель
        // в панели при этом скрыт, но данные могли остаться от прошлого раза.
        self.mode == "ordered" && self.items.len() > 1
    }
}

/// Источник с названием и числом карт — то, что показывает панель.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub source: Source,
    pub name: String,
    pub count: i64,
    /// Коллекция-источник удалена. Правило при этом не применяется молча.
    pub missing: bool,
}

/// Какие источники применяются к пулу и откуда они пришли.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveSources {
    pub set: SourceSet,
    pub items: Vec<SourceInfo>,
    /// «свои», «от серии — Осень 2026», «от шаблона», «вся библиотека».
    pub origin: String,
    /// Есть ли у самого уровня свои источники: панели нужно знать,
    /// показывать «унаследовано» или нет.
    pub own: bool,
    pub total: i64,
}

// ─────────────────────────────────────────────────── исключения

/// Чего не берём. Всё «нельзя» в одном перечислении: разбросанное по
/// правилам, полям и галочкам, оно не читается целиком ни в одном месте.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ExclusionTarget {
    #[serde(rename = "pool")]
    Pool { id: i64 },
    #[serde(rename = "series")]
    Series { id: i64 },
    /// Всё, что стояло в маппулах этого турнира.
    #[serde(rename = "tournament")]
    Tournament { id: i64 },
    #[serde(rename = "recentTournaments")]
    RecentTournaments { count: i64 },
    /// Карты, которые этот игрок уже играл.
    #[serde(rename = "playedBy")]
    PlayedBy { player_id: i64 },
    #[serde(rename = "mapper")]
    Mapper { name: String },
    /// Руками отобранные карты.
    #[serde(rename = "beatmaps")]
    Beatmaps { ids: Vec<i64> },
    /// Не два пула одного маппера внутри пула. Про состав, а не про id,
    /// поэтому считается во время подбора.
    #[serde(rename = "sameMapperInside")]
    SameMapperInside,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exclusion {
    pub id: i64,
    pub target: ExclusionTarget,
    pub strict: bool,
    pub enabled: bool,
    /// Читаемое имя цели: «Осень — раунд 1», «Серия „Зима 2026“».
    pub label: String,
    /// Откуда пришло: `None` — своё, иначе «серия „Осень 2026“».
    pub inherited_from: Option<String>,
    /// Цель удалена — исключение не применяется, но и не исчезает само:
    /// правило, пропавшее незаметно, хуже неработающего.
    pub missing: bool,
    /// Сколько карт отсекает от общего набора кандидатов пула.
    pub cut: i64,
}

// ──────────────────────────────────────────────────────── серии

/// Группа маппулов. Турнирная знает про раунды и не повторяет карты внутри
/// себя, свободная — просто ящик: архив сезона, «мои любимые NM-пулы».
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub id: i64,
    pub name: String,
    /// tournament | free
    pub kind: String,
    pub color: Option<String>,
    pub note: Option<String>,
    pub sources: Option<SourceSet>,
    pub exclusions: Vec<Exclusion>,
    pub no_repeat_inside: bool,
    /// Значение по умолчанию для строк пулов серии.
    pub display_fields: Option<Vec<String>>,
    pub position: i64,
    pub created_at: String,
    pub pools: Vec<SeriesPool>,
}

/// Пул внутри серии — ровно то, что показывает её список: метка раунда,
/// состав одной строкой и сколько предупреждений внутри.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesPool {
    pub pool_id: i64,
    pub position: i64,
    pub label: Option<String>,
    pub name: String,
    pub status: String,
    pub version: i64,
    pub is_locked: bool,
    pub shape: String,
    pub slots: i64,
    pub filled: i64,
    pub stars_min: Option<f64>,
    pub stars_max: Option<f64>,
    pub stars_avg: Option<f64>,
    pub warnings: i64,
}

/// Размах звёзд одного пула серии — строка диаграммы роста сложности.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesStep {
    pub pool_id: i64,
    pub label: String,
    pub stars_min: Option<f64>,
    pub stars_max: Option<f64>,
    pub stars_avg: Option<f64>,
    /// Средняя ниже предыдущего пула. Предупреждение мягкое: бывает намеренно.
    pub below_previous: bool,
}

/// Сводка серии: пять чисел сверху экрана и всё, что за ними стоит.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesStats {
    pub pools: i64,
    pub maps_total: i64,
    pub maps_unique: i64,
    /// Карт, встречающихся в двух и более пулах серии.
    pub repeats: i64,
    pub stars_min: Option<f64>,
    pub stars_max: Option<f64>,
    pub mappers: i64,
    pub mappers_repeated: i64,
    /// Карт, которые уже стояли в маппулах прошлых турниров.
    pub played_before: i64,
    pub steps: Vec<SeriesStep>,
    pub repeat_rows: Vec<PoolOverlap>,
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
    #[serde(default)]
    pub sources: Option<SourceSet>,
    /// Только на выход: правятся исключения отдельными командами, а не
    /// сохранением шаблона целиком.
    #[serde(default, skip_deserializing)]
    pub exclusions: Vec<Exclusion>,
    pub created_at: String,
    pub slots: Vec<TemplateSlot>,
}

/// Что именно отсекло карты и сколько. Ответ на «почему слот пустой»:
/// не «мало карт», а «диапазон звёзд отрезал 214, исключение прошлого
/// турнира — ещё 38».
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocker {
    pub reason: String,
    pub cut: i64,
}

/// Сколько карт нужно под слот и сколько осталось после всех правил.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotSupply {
    pub position: i64,
    pub slot_label: String,
    #[serde(rename = "mod")]
    pub mod_tag: String,
    pub need: i64,
    /// Подходит под мод, звёзды и скилсеты — до исключений.
    pub matching: i64,
    /// Из них отсечено исключениями.
    pub excluded: i64,
    pub available: i64,
    /// По убыванию отсечённого.
    pub blockers: Vec<Blocker>,
    /// Откуда пришли источники слота: «свои», «от серии — Осень 2026».
    pub origin: String,
}

// ────────────────────────────────────────────────────────── маппулы

/// Что не так со строкой. Строгое нарушение — красная иконка, мягкое — жёлтая.
/// Строгих после генерации быть не может: они появляются только при ручной правке.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotWarning {
    pub text: String,
    pub strict: bool,
}

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
    /// Свои источники слота. `None` — наследует пул.
    pub sources: Option<SourceSet>,
    /// Заполняется только при чтении одного пула — в списке карты не нужны.
    pub beatmap: Option<Beatmap>,
    pub warnings: Vec<SlotWarning>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pool {
    pub id: i64,
    pub name: String,
    pub template_id: Option<i64>,
    pub template_name: Option<String>,
    pub series_id: Option<i64>,
    pub series_name: Option<String>,
    /// tournament | free — от типа зависит, можно ли повторять карты.
    pub series_kind: Option<String>,
    /// Метка раунда внутри серии: «раунд 1», «финал».
    pub series_label: Option<String>,
    pub series_position: i64,
    pub status: String,
    pub version: i64,
    pub parent_pool_id: Option<i64>,
    pub display_fields: Vec<String>,
    /// Свои источники пула. `None` — наследует серия или шаблон.
    pub sources: Option<SourceSet>,
    /// Сыгранный пул неизменяем: правка уводит в свежую копию.
    pub is_locked: bool,
    pub created_at: String,
    pub slots: Vec<PoolSlot>,
}

/// Строка отчёта генерации: адрес и цифры, а не «что-то не сошлось».
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenNote {
    pub pool_id: Option<i64>,
    pub pool_name: String,
    /// Слот, к которому относится заметка. `None` — про пул целиком.
    pub slot_label: Option<String>,
    pub text: String,
    /// Правило было строгим: слот остался пустым, а не заполнился с оговоркой.
    pub strict: bool,
    /// Что и сколько отсекло — раскрывается под строкой отчёта.
    pub blockers: Vec<Blocker>,
}

/// Итог генерации: сам пул и то, что не получилось выдержать.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenReport {
    pub pool: Pool,
    pub notes: Vec<GenNote>,
}

/// Что применяется к пулу: источники, исключения, правила и запас по слотам.
///
/// Отдельной командой, а не полем пула: считать это при каждом чтении списка
/// маппулов — десятки запросов на пул, а нужно оно только в открытой панели.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolWhence {
    pub sources: EffectiveSources,
    /// Унаследованные сверху, потом свои.
    pub exclusions: Vec<Exclusion>,
    pub rules: GenRules,
    /// Откуда правила: «от шаблона „Стандарт 1v1“» или «своих правил нет».
    pub rules_origin: String,
    pub supply: Vec<SlotSupply>,
    /// Звёзды под модами не посчитаны: без ключа или пока не докачались.
    pub stars_pending: i64,
}

/// Что показывать в панели подбора карты в слот.
///
/// Исключения применяются и здесь: иначе руками можно поставить карту, которую
/// генерация никогда бы не взяла. Но убранные карты именно скрыты, а не
/// выброшены — строка «скрыто 74 карты по исключениям» с кнопкой «показать
/// всё» честнее молча урезанного списка.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotPicker {
    /// Фильтр библиотеки, суженный под слот: тот же, по которому шла генерация.
    pub filter: LibraryFilter,
    /// Сколько карт остаётся после всех правил.
    pub available: i64,
    /// Карты, отсечённые строгими исключениями.
    pub hidden: Vec<i64>,
    /// Откуда пришли источники слота: «свои», «от серии — Осень 2026».
    pub origin: String,
}

/// Карта, попавшая сразу в несколько маппулов одного турнира или серии.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolOverlap {
    pub beatmap_id: i64,
    /// «Исполнитель — название», как показывается в строке карты.
    pub name: String,
    /// Названия маппулов, в которых она встретилась.
    pub pools: Vec<String>,
    /// Их id, в том же порядке — чтобы можно было перекатить последний.
    pub pool_ids: Vec<i64>,
}

/// Сколько карт под каждым мод-тегом. Карта с несколькими тегами
/// считается в каждом: тег — это «где её можно поставить», а не сорт.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModCount {
    #[serde(rename = "mod")]
    pub mod_tag: String,
    pub count: i64,
}

/// Из чего состоит то, что сейчас на экране библиотеки.
///
/// Считается по тому же фильтру, что и список: смотреть на коллекцию и
/// не знать, сколько в ней HD и какой там разброс звёзд, — значит собирать
/// маппул вслепую.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySummary {
    pub total: i64,
    /// Карты без единого мод-тега — генерация их не увидит.
    pub untagged: i64,
    pub by_mod: Vec<ModCount>,
    pub stars_min: Option<f64>,
    pub stars_max: Option<f64>,
    pub stars_avg: Option<f64>,
    /// Секунды.
    pub length_avg: Option<f64>,
    pub length_total: Option<i64>,
    pub bpm_min: Option<f64>,
    pub bpm_max: Option<f64>,
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

/// Строка истории выступлений: один турнир.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerAppearance {
    pub tournament_id: i64,
    pub tournament_name: String,
    /// Когда закончился турнир. `None` — ещё идёт.
    pub finished_at: Option<String>,
    pub placement: Option<i64>,
    pub matches: i64,
    pub match_wins: i64,
}

/// Результаты по мод-тегу: сколько карт сыграно и выиграно.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModStats {
    #[serde(rename = "mod")]
    pub mod_tag: String,
    pub played: i64,
    pub won: i64,
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
    /// Сыграно и выиграно по каждому мод-тегу.
    pub by_mod: Vec<ModStats>,
    /// По одному турниру на строку, новые сверху.
    pub history: Vec<PlayerAppearance>,
    pub versus: Vec<PlayerVersus>,
}

// ──────────────────────────────────────────────────────────── турниры

/// До скольких побед играют. Общее число, а по раундам — только там,
/// где решили иначе: финал часто длиннее группового.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ByRound {
    pub default: i64,
    /// Ключ — раунд сетки: «upper:2», «lower:1», «grand:1». У верхней и нижней
    /// сетки свои раунды, одним номером их не разделить. Голое число читается
    /// как «любая сетка, этот раунд» — так лежали данные до редактора.
    #[serde(default)]
    pub rounds: std::collections::HashMap<String, i64>,
}

/// Ключ раунда: по нему адресуются и правила, и привязка маппула.
pub fn round_key(bracket: &str, round: i64) -> String {
    format!("{bracket}:{round}")
}

impl ByRound {
    pub fn new(default: i64) -> ByRound {
        ByRound {
            default,
            rounds: std::collections::HashMap::new(),
        }
    }

    /// Значение для конкретного раунда сетки.
    pub fn at_key(&self, bracket: &str, round: i64) -> i64 {
        self.own(bracket, round).unwrap_or(self.default)
    }

    /// Задано ли для этого раунда своё значение. `None` — унаследовано.
    pub fn own(&self, bracket: &str, round: i64) -> Option<i64> {
        self.rounds
            .get(&round_key(bracket, round))
            .or_else(|| self.rounds.get(&round.to_string()))
            .copied()
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
    /// Фактическое число игроков. Скелет сетки по-прежнему строится на
    /// ближайшую степень двойки, а лишние места срезаются.
    pub bracket_size: i64,
    pub target_score: ByRound,
    pub bans_per_round: ByRound,
    /// random | higherSeed | lowerSeed — решается на старте каждого матча.
    pub first_ban: String,
    pub no_repeat_pool: bool,
    /// Какой маппул закреплён за раундом. Ключ — «upper:2».
    pub pool_by_round: std::collections::HashMap<String, i64>,
    /// Сколько побед победитель верхней получает в гранд-финале заранее.
    pub grand_advantage: i64,
    /// Сеяния, прошедшие первый раунд без игры.
    pub bye_seeds: Vec<i64>,
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
    /// Аватар из профиля osu!. Свой у игрока, а не у турнира.
    pub avatar_path: Option<String>,
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
    /// Правило, взятое на старте матча. `None` — матч ещё не начинали,
    /// значит правило берётся из турнира и может поменяться.
    pub target_score: Option<i64>,
    pub bans_each: Option<i64>,
    /// Счёт по сыгранным картам. Считается из действий, а не хранится.
    pub score_a: i64,
    pub score_b: i64,
    /// Преимущество сетки в гранд-финале: победы, которые в матче считаются,
    /// но сыгранными картами не являются — в покартовую статистику они
    /// поэтому не идут.
    pub bonus_a: i64,
    pub bonus_b: i64,
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

/// Правила турнира и маппул не сходятся: карт не хватит доиграть матч.
///
/// Считается по раундам: у каждого своё правило и свой маппул, и общей
/// проверкой такую нестыковку не поймать.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleProblem {
    /// Ключ раунда: «upper:2».
    pub key: String,
    /// Как раунд называется на сетке: «Финал верхней».
    pub title: String,
    pub pool_id: Option<i64>,
    pub pool_name: String,
    pub target: i64,
    pub bans_each: i64,
    pub notes: Vec<String>,
}

/// Строка таблицы раундов в редакторе: правило, маппул и что с ними не так.
///
/// До построения сетки считается по проектной — той, что получится при
/// текущем составе: править правила финала, не собрав сетку, нормально.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorRound {
    pub key: String,
    pub bracket: String,
    pub round: i64,
    pub title: String,
    pub target: i64,
    pub bans: i64,
    /// Значение задано для этого раунда, а не унаследовано от общего.
    pub target_own: bool,
    pub bans_own: bool,
    /// Маппул, закреплённый за раундом. `None` — «любой свободный».
    pub pool_id: Option<i64>,
    /// Что раунд играет на самом деле: закреплённый или выданный по кругу.
    pub playing_pool_id: Option<i64>,
    pub playing_pool_name: Option<String>,
    /// Карт в маппуле без тайбрейка и есть ли сам тайбрейк.
    pub pool_playable: i64,
    pub pool_has_tiebreaker: bool,
    pub matches: i64,
    pub played: i64,
    /// Хоть один матч раунда начат: правило внутри него уже не поменять.
    pub started: bool,
    /// Нестыковки правила с маппулом этого раунда.
    pub notes: Vec<String>,
}

/// Сеяние, прошедшее первый раунд без игры, и почему.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorBye {
    pub seed: i64,
    pub nickname: String,
    pub why: String,
}

/// Предупреждение раздела. Блокирует только то, без чего сетку не построить.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorCheck {
    /// rules | bracket | pools | players
    pub section: String,
    pub text: String,
    pub blocking: bool,
}

/// Одна запись журнала правок турнира.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TournamentEdit {
    pub n: i64,
    pub kind: String,
    pub at: String,
    pub emergency: bool,
    /// Что поменяли, человеческими словами: «маппул раунда 2».
    pub note: String,
    /// `n` правки-отмены, если эту откатили.
    pub undone_by: Option<i64>,
}

/// Всё, что нужно колонке разделов. Считается на каждое чтение: правка
/// меняет исходные данные, а производные величины пересчитываются целиком.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorState {
    pub rounds: Vec<EditorRound>,
    pub byes: Vec<EditorBye>,
    pub checks: Vec<EditorCheck>,
    /// Карты, попавшие в два маппула турнира, с названиями раундов.
    pub overlaps: Vec<PoolOverlap>,
    pub edits: Vec<TournamentEdit>,
    /// Почему отмена недоступна. `None` — можно отменять.
    pub undo_blocked: Option<String>,
    /// Сколько матчей уже начато и сыграно — по ним решается, что запирать.
    pub matches_total: i64,
    pub matches_started: i64,
    pub matches_played: i64,
    /// Сколько матчей будет в сетке при текущем составе.
    pub projected_matches: i64,
    /// Аварийная правка вообще доступна: турнир идёт или сыгран.
    pub emergency_available: bool,
}

/// Что случится, если применить правку сыгранного. Считается обходом сетки
/// вперёд, а не пишется руками.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditImpact {
    /// Названия матчей, которые сбросятся.
    pub matches: Vec<String>,
    /// Игроки, чья статистика пересчитается.
    pub players: Vec<String>,
    /// Сколько сыгранных карт перестанет учитываться.
    pub maps: i64,
    /// Кто вернётся в турнир из нижней сетки и с каким счётом поражений.
    pub returns: Vec<String>,
    /// Турнир перестанет быть завершённым.
    pub reopens_tournament: bool,
}

/// Турнир вместе с сеткой — то, из чего рисуется экран турнира.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bracket {
    #[serde(flatten)]
    pub tournament: Tournament,
    pub matches: Vec<Match>,
    /// Правила и привязанные маппулы, которые не сходятся между собой.
    pub problems: Vec<RuleProblem>,
    /// Итоги: кто какое место занял. Заполняется у завершённого турнира.
    pub standings: Vec<Standing>,
}

/// Строка итоговой таблицы турнира.
///
/// Это единственное место, где турнир виден целиком уже сыгранным, поэтому
/// цифр здесь больше, чем в сетке: путь по матчам, доля карт, разбивка по
/// мод-тегам и тайбрейки.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Standing {
    pub player_id: i64,
    pub nickname: String,
    pub color: String,
    pub avatar_path: Option<String>,
    pub placement: i64,
    pub match_wins: i64,
    pub match_losses: i64,
    pub map_wins: i64,
    pub map_losses: i64,
    /// Сыграно и выиграно карт по каждому мод-тегу этого турнира.
    pub by_mod: Vec<ModStats>,
    /// Тайбрейков сыграно и выиграно: они решают матч и стоят отдельно.
    pub tiebreakers: i64,
    pub tiebreakers_won: i64,
    /// Матчей, доставшихся без игры.
    pub walkovers: i64,
    /// Самая длинная серия побед по картам подряд внутри турнира.
    pub best_streak: i64,
}
