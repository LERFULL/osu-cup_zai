// Общие типы приложения. Зеркалят структуры Rust — менять только парой.

export const MOD_TAGS = ['NM', 'HD', 'HR', 'DT', 'FM', 'EZ', 'TB'] as const;
export type ModTag = (typeof MOD_TAGS)[number];

export const SKILLSETS = [
  'aim',
  'jump',
  'stream',
  'speed',
  'tech',
  'alt',
  'finger control',
  'reading',
  'stamina',
  'consistency',
  'gimmick',
] as const;
export type Skillset = (typeof SKILLSETS)[number];

export type RankStatus =
  | 'graveyard'
  | 'wip'
  | 'pending'
  | 'ranked'
  | 'approved'
  | 'qualified'
  | 'loved';

// ─────────────────────────────────────────────────────────────── карты

export interface Beatmap {
  beatmapId: number;
  beatmapsetId: number | null;
  checksum: string | null;

  artist: string;
  artistUnicode: string | null;
  title: string;
  titleUnicode: string | null;
  version: string;
  creator: string | null;
  creatorId: number | null;

  difficultyRating: number;
  bpm: number | null;
  totalLength: number | null;
  hitLength: number | null;
  cs: number | null;
  ar: number | null;
  accuracy: number | null;
  drain: number | null;
  countCircles: number | null;
  countSliders: number | null;
  countSpinners: number | null;
  maxCombo: number | null;

  status: RankStatus | null;
  rankedDate: string | null;
  lastUpdated: string | null;
  tags: string | null;
  packTags: string | null;
  genreId: number | null;
  languageId: number | null;
  failtimes: Failtimes | null;

  coverPath: string | null;
  previewPath: string | null;

  note: string | null;
  isManual: boolean;
  isGone: boolean;
  addedAt: string;

  mods: ModTag[];
  fmMods: string[];
  skillsets: SkillsetTag[];
  labels: Label[];

  /** Заполняется только в списке библиотеки, где строка — весь набор:
   *  сколько сложностей внутри и какой у них разброс звёзд. */
  setCount?: number | null;
  setStarsMin?: number | null;
  setStarsMax?: number | null;
}

export interface Failtimes {
  fail: number[];
  exit: number[];
}

export interface SkillsetTag {
  skillset: Skillset;
  suggested: boolean;
}

export interface Label {
  id: number;
  name: string;
  color: string | null;
}

/** Атрибуты карты под конкретной комбинацией модов. mods='' — NoMod. */
export interface BeatmapAttributes {
  beatmapId: number;
  mods: string;
  starRating: number | null;
  aimDifficulty: number | null;
  speedDifficulty: number | null;
  sliderFactor: number | null;
  speedNoteCount: number | null;
  maxCombo: number | null;
  fetchedAt: string;
}

/** AR/OD/CS/HP и BPM, пересчитанные под мод на своей стороне. */
export interface DerivedStats {
  cs: number | null;
  ar: number | null;
  od: number | null;
  hp: number | null;
  bpm: number | null;
  totalLength: number | null;
}

// ─────────────────────────────────────────────────────────── коллекции

export interface Folder {
  id: number;
  name: string;
  position: number;
  /** Родительская папка. null — папка лежит на верхнем уровне.
   *  Папки вкладываются друг в друга без ограничений, как в проводнике. */
  parentId: number | null;
}

export interface Collection {
  id: number;
  name: string;
  color: string | null;
  icon: string | null;
  folderId: number | null;
  position: number;
  isSmart: boolean;
  filter: LibraryFilter | null;
  count: number;
  createdAt: string;
}

/**
 * Где в библиотеке находимся. Два первых места — системные: их нельзя
 * ни удалить, ни переименовать, и состав у них считается сам.
 */
export type Place =
  | { kind: 'all' }
  | { kind: 'untagged' }
  | { kind: 'collection'; id: number };

// ─────────────────────────────────────────────────────────────── фильтр

export type SortKey = 'added' | 'stars' | 'bpm' | 'length' | 'title' | 'artist';
export type SortDir = 'asc' | 'desc';

export interface Range {
  min: number | null;
  max: number | null;
}

export interface LibraryFilter {
  query: string;
  mods: ModTag[];
  skillsets: Skillset[];
  labelIds: number[];
  statuses: RankStatus[];
  stars: Range;
  bpm: Range;
  length: Range;
  collectionId: number | null;
  /** Только карты, у которых не проставлено ни одного мод-тега.
   *  Это место в библиотеке, а не условие: счётчику и кнопке «Сохранить
   *  как умную» он не мешает, а сброс фильтра его не трогает. */
  noMods: boolean;
  sort: SortKey;
  dir: SortDir;
}

export const EMPTY_FILTER: LibraryFilter = {
  query: '',
  mods: [],
  skillsets: [],
  labelIds: [],
  statuses: [],
  stars: { min: null, max: null },
  bpm: { min: null, max: null },
  length: { min: null, max: null },
  collectionId: null,
  noMods: false,
  sort: 'added',
  dir: 'desc',
};

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
}

/** Сколько карт под мод-тегом. Карта с несколькими тегами считается в каждом. */
export interface ModCount {
  mod: ModTag;
  count: number;
}

/**
 * Из чего состоит то, что сейчас на экране библиотеки. Считается по тому же
 * фильтру, что и список.
 */
export interface LibrarySummary {
  total: number;
  /** Карты без единого мод-тега — генерация их не увидит. */
  untagged: number;
  byMod: ModCount[];
  starsMin: number | null;
  starsMax: number | null;
  starsAvg: number | null;
  /** Секунды. */
  lengthAvg: number | null;
  lengthTotal: number | null;
  bpmMin: number | null;
  bpmMax: number | null;
}

// ────────────────────────────────────────────────── ключ и подключение

export interface ApiCredentials {
  clientId: string;
  clientSecret: string;
}

export type CredentialsCheck =
  | { kind: 'ok' }
  | { kind: 'invalid'; message: string }
  | { kind: 'offline'; message: string };

export interface AppStatus {
  hasCredentials: boolean;
  online: boolean;
  onboarded: boolean;
  /** Подсказки при первом входе в матч уже показывались. */
  matchHintsSeen: boolean;
  dbPath: string;
  cachePath: string;
}

// ────────────────────────────────────────────── импорт по ссылкам

/** Что парсер нашёл в тексте. */
export interface ParsedLinks {
  beatmapIds: number[];
  beatmapsetIds: number[];
  /** Строки, похожие на ссылку osu!, но не распознанные. */
  unknown: string[];
}

/** Карты попадают в библиотеку только на стадии saving — когда пачка скачалась целиком. */
export type ImportStage =
  | 'queued'
  | 'fetching'
  | 'saving'
  | 'covers'
  | 'skillsets'
  | 'done'
  | 'cancelled'
  | 'failed';

export interface ImportProgress {
  batchId: string;
  stage: ImportStage;
  done: number;
  total: number;
  added: number;
  skipped: number;
  failed: ImportFailure[];
}

export interface ImportFailure {
  ref: string;
  reason: string;
}

/** Пачка в очереди загрузок. Живёт в базе — очередь переживает перезапуск. */
export interface ImportBatch {
  batchId: string;
  name: string;
  /** Авто-теги, которые встанут на все карты пачки. */
  mods: ModTag[] | string[];
  /** queued running done failed cancelled */
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  stage: ImportStage;
  beatmapIds: number[];
  beatmapsetIds: number[];
  total: number;
  done: number;
  added: number;
  skipped: number;
  failed: ImportFailure[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// ──────────────────────────────────────────────────────── очередь

export interface QueueStatus {
  pending: number;
  done: number;
  failed: number;
  /** Запросов, доступных прямо сейчас в окне 60/мин. */
  budget: number;
  activeBatch: string | null;
}

// ─────────────────────────────────────────────── шаблоны маппулов

/**
 * Правила генерации. У каждого своя строгость: строгое не выполнилось —
 * слот остался пустым, мягкое — слот заполнился, а нарушение попало в отчёт.
 *
 * «Не повторять маппера» и «не брать из этих маппулов» переехали в исключения:
 * всё «чего не берём» лежит в одном месте.
 */
export interface GenRules {
  minBpmSpread: number | null;
  minBpmSpreadStrict: boolean;
  rankedOnly: boolean;
  rankedOnlyStrict: boolean;
  balanceSkillsets: boolean;
  balanceSkillsetsStrict: boolean;
  lengthMax: number | null;
  lengthMaxStrict: boolean;
}

export const EMPTY_RULES: GenRules = {
  minBpmSpread: null,
  minBpmSpreadStrict: false,
  rankedOnly: false,
  rankedOnlyStrict: true,
  balanceSkillsets: false,
  balanceSkillsetsStrict: false,
  lengthMax: null,
  lengthMaxStrict: true,
};

// ─────────────────────────────────────────────────── источники карт

/** Откуда брать карты. */
export type Source =
  | { kind: 'library' }
  | { kind: 'collection'; id: number }
  | { kind: 'filter'; filter: LibraryFilter };

/** `union` — все источники сливаются, `ordered` — по приоритету. */
export type SourceMode = 'union' | 'ordered';

export interface SourceSet {
  items: Source[];
  mode: SourceMode;
}

/** Источник с названием и числом карт — то, что показывает панель. */
export interface SourceInfo {
  source: Source;
  name: string;
  count: number;
  /** Коллекция-источник удалена. Правило при этом не применяется молча. */
  missing: boolean;
}

/** Какие источники применяются и откуда они пришли. */
export interface EffectiveSources {
  set: SourceSet;
  items: SourceInfo[];
  /** «свои», «от серии — Осень 2026», «вся библиотека». */
  origin: string;
  /** Есть ли у самого уровня свои источники. */
  own: boolean;
  total: number;
}

// ───────────────────────────────────────────────────── исключения

/** Чего не берём. Всё «нельзя» в одном перечислении. */
export type ExclusionTarget =
  | { kind: 'pool'; id: number }
  | { kind: 'series'; id: number }
  | { kind: 'tournament'; id: number }
  | { kind: 'recentTournaments'; count: number }
  | { kind: 'playedBy'; playerId: number }
  | { kind: 'mapper'; name: string }
  | { kind: 'beatmaps'; ids: number[] }
  | { kind: 'sameMapperInside' };

export const EXCLUSION_KINDS = [
  'pool',
  'series',
  'tournament',
  'recentTournaments',
  'playedBy',
  'mapper',
  'beatmaps',
  'sameMapperInside',
] as const;
export type ExclusionKind = (typeof EXCLUSION_KINDS)[number];

/** Кому принадлежит исключение. */
export type ExclusionOwner = 'series' | 'pool' | 'template';

export interface Exclusion {
  id: number;
  target: ExclusionTarget;
  strict: boolean;
  enabled: boolean;
  /** Читаемое имя цели: «Осень — раунд 1», «Серия „Зима 2026“». */
  label: string;
  /** Откуда пришло: `null` — своё, иначе «серия „Осень 2026“». */
  inheritedFrom: string | null;
  /** Цель удалена — правило не применяется, но и не исчезает само. */
  missing: boolean;
  /** Сколько карт отсекает от общего набора кандидатов. */
  cut: number;
}

// ────────────────────────────────────────────────────────── серии

export type SeriesKind = 'tournament' | 'free';

export interface Series {
  id: number;
  name: string;
  kind: SeriesKind;
  color: string | null;
  note: string | null;
  sources: SourceSet | null;
  exclusions: Exclusion[];
  noRepeatInside: boolean;
  /** Значение по умолчанию для строк пулов серии. */
  displayFields: PoolField[] | null;
  /** Турнир, к которому серия привязана жёстко. Один турнир — одна серия. */
  tournamentId: number | null;
  position: number;
  createdAt: string;
  pools: SeriesPool[];
}

/** Пул внутри серии — ровно то, что показывает её список. */
export interface SeriesPool {
  poolId: number;
  position: number;
  label: string | null;
  name: string;
  status: PoolStatus;
  version: number;
  isLocked: boolean;
  /** «NM×4 · HD×2 · TB×1». */
  shape: string;
  slots: number;
  filled: number;
  starsMin: number | null;
  starsMax: number | null;
  starsAvg: number | null;
  warnings: number;
}

/** Строка диаграммы роста сложности. */
export interface SeriesStep {
  poolId: number;
  label: string;
  starsMin: number | null;
  starsMax: number | null;
  starsAvg: number | null;
  /** Средняя ниже предыдущего пула. Предупреждение мягкое. */
  belowPrevious: boolean;
}

export interface SeriesStats {
  pools: number;
  mapsTotal: number;
  mapsUnique: number;
  repeats: number;
  starsMin: number | null;
  starsMax: number | null;
  mappers: number;
  mappersRepeated: number;
  playedBefore: number;
  steps: SeriesStep[];
  repeatRows: PoolOverlap[];
}

export interface TemplateSlot {
  id: number;
  mod: ModTag;
  count: number;
  starMin: number | null;
  starMax: number | null;
  sourceCollectionId: number | null;
  requiredSkillsets: Skillset[];
  position: number;
}

/** Слот, каким его отправляет редактор: порядок задаёт сам список. */
export type TemplateSlotInput = Omit<TemplateSlot, 'id' | 'position'>;

export interface PoolTemplate {
  id: number;
  name: string;
  rules: GenRules;
  sources: SourceSet | null;
  exclusions: Exclusion[];
  createdAt: string;
  slots: TemplateSlot[];
}

/** Что и сколько отсекло карты. */
export interface Blocker {
  reason: string;
  cut: number;
}

/** Сколько карт нужно под слот и сколько осталось после всех правил. */
export interface SlotSupply {
  position: number;
  slotLabel: string;
  mod: ModTag;
  need: number;
  /** Подходит под мод, звёзды и скилсеты — до исключений. */
  matching: number;
  /** Из них отсечено исключениями. */
  excluded: number;
  available: number;
  /** По убыванию отсечённого. */
  blockers: Blocker[];
  /** Откуда пришли источники слота. */
  origin: string;
}

// ────────────────────────────────────────────────────────── маппулы

export type PoolStatus = 'draft' | 'ready' | 'archived';

/** Что показывать в строке пула. Наследуется картинкой при экспорте. */
export const POOL_FIELDS = [
  'stars',
  'length',
  'bpm',
  'ar',
  'od',
  'cs',
  'hp',
  'mapper',
  'skillsets',
] as const;
export type PoolField = (typeof POOL_FIELDS)[number];

/** Что не так со строкой. Строгое — красным, мягкое — жёлтым. */
export interface SlotWarning {
  text: string;
  strict: boolean;
}

export interface PoolSlot {
  id: number;
  slotLabel: string;
  mod: ModTag;
  beatmapId: number | null;
  pinned: boolean;
  starRatingWithMods: number | null;
  fmMods: string[];
  position: number;
  /** Свои источники слота. `null` — наследует пул. */
  sources: SourceSet | null;
  /** Есть только при чтении одного пула — в списке карты не нужны. */
  beatmap: Beatmap | null;
  warnings: SlotWarning[];
}

export interface Pool {
  id: number;
  name: string;
  templateId: number | null;
  templateName: string | null;
  seriesId: number | null;
  seriesName: string | null;
  seriesKind: SeriesKind | null;
  /** Метка раунда внутри серии: «раунд 1», «финал». */
  seriesLabel: string | null;
  seriesPosition: number;
  status: PoolStatus;
  version: number;
  parentPoolId: number | null;
  displayFields: PoolField[];
  /** Свои источники пула. `null` — наследует серия или шаблон. */
  sources: SourceSet | null;
  /** Сыгранный пул неизменяем: правка уводит в свежую копию. */
  isLocked: boolean;
  createdAt: string;
  slots: PoolSlot[];
}

/** Строка отчёта генерации: адрес и цифры, а не «что-то не сошлось». */
export interface GenNote {
  poolId: number | null;
  poolName: string;
  /** Слот, к которому относится заметка. `null` — про пул целиком. */
  slotLabel: string | null;
  text: string;
  /** Правило было строгим: слот остался пустым. */
  strict: boolean;
  blockers: Blocker[];
}

/** Итог генерации: сам пул и то, что не получилось выдержать. */
export interface GenReport {
  pool: Pool;
  notes: GenNote[];
}

/** Что применяется к пулу — содержимое панели «Откуда берём». */
export interface PoolWhence {
  sources: EffectiveSources;
  /** Унаследованные сверху, потом свои. */
  exclusions: Exclusion[];
  rules: GenRules;
  rulesOrigin: string;
  supply: SlotSupply[];
  /** Звёзды под модами ещё не посчитаны. */
  starsPending: number;
}

/** Что показывать в панели подбора карты в слот. */
export interface SlotPicker {
  filter: LibraryFilter;
  available: number;
  /** Карты, отсечённые строгими исключениями. */
  hidden: number[];
  origin: string;
}

/** Карта, попавшая сразу в несколько маппулов турнира или серии. */
export interface PoolOverlap {
  beatmapId: number;
  /** «Исполнитель — название», как в строке карты. */
  name: string;
  /** Названия маппулов, в которых она встретилась. */
  pools: string[];
  /** Их id, в том же порядке. */
  poolIds: number[];
}

// ─────────────────────────────────────── импорт и экспорт маппула JSON

/** Слот маппула в JSON-файле: одна форма на экспорт и импорт. */
export interface PoolJsonSlot {
  slotLabel: string;
  mod: ModTag;
  beatmapId: number | null;
  pinned: boolean;
  fmMods: string[];
}

/** Файл маппула. Статус выгружается для человека, при импорте не действует. */
export interface PoolJson {
  name: string;
  status: PoolStatus | null;
  slots: PoolJsonSlot[];
}

/** Что показывает диалог импорта до записи: состав файла и раскладка
 *  известных библиотеке карт — по ней решают, скачивать ли недостающие. */
export interface PoolImportPreview {
  poolName: string;
  slots: PoolJsonSlot[];
  /** Карты из файла, которые уже лежат в библиотеке. */
  knownMaps: number;
  /** Карты, которых в библиотеке нет. */
  newMaps: number;
}

/** Итог импорта: созданный пул и судьба карт, которых не было в библиотеке. */
export interface PoolImportResult {
  pool: Pool;
  /** Скачали с osu! и положили в библиотеку. */
  savedMaps: number;
  /** Не скачались — нет ключа, нет сети или карты больше не существует. */
  skippedMaps: number;
}

// ─────────────────────────────────────────────────────────────── игроки

export interface Player {
  id: number;
  nickname: string;
  osuUserId: number | null;
  color: string;
  avatarPath: string | null;
  note: string | null;
  isArchived: boolean;
  createdAt: string;
}

/** Личный счёт с конкретным соперником. */
export interface PlayerVersus {
  playerId: number;
  nickname: string;
  wins: number;
  losses: number;
}

/** Строка истории выступлений игрока: один турнир. */
export interface PlayerAppearance {
  tournamentId: number;
  tournamentName: string;
  /** Когда закончился турнир. `null` — ещё идёт. */
  finishedAt: string | null;
  /** Занятое место: 1 — победитель, дальше по порядку вылета. */
  placement: number | null;
  /** Матчей сыграно и выиграно в этом турнире. */
  matches: number;
  matchWins: number;
}

/** Результаты по мод-тегам: сыграно и выиграно карт. */
export interface ModStats {
  mod: string;
  played: number;
  won: number;
}

/** Всё посчитано по истории матчей на момент запроса. */
export interface PlayerStats {
  playerId: number;
  tournaments: number;
  tournamentWins: number;
  /** Занятые места, по возрастанию. */
  placements: number[];
  matches: number;
  matchWins: number;
  maps: number;
  mapWins: number;
  bestMod: string | null;
  worstMod: string | null;
  favouriteBeatmap: number | null;
  /** Сыграно и выиграно по каждому мод-тегу. */
  byMod: ModStats[];
  /** По одному турниру на строку, новые сверху. */
  history: PlayerAppearance[];
  versus: PlayerVersus[];
  /** Турнирная статистика из привязанных лобби — пишет её osu!, а не судья. */
  lobbyMaps: number;
  lobbyPassed: number;
  /** Средняя точность по картам из лобби, 0..1. */
  lobbyAvgAccuracy: number | null;
  /** Среднее число промахов за карту. */
  lobbyAvgMiss: number | null;
}

/** Расширенный профиль osu! — то, что тянет карточка игрока с API. */
export interface PlayerOsuProfile {
  osuUserId: number;
  username: string | null;
  countryCode: string | null;
  /** Команда профиля, если игрок в ней состоит. */
  teamName: string | null;
  teamTag: string | null;
  pp: number | null;
  globalRank: number | null;
  countryRank: number | null;
  /** Проценты, как на сайте. */
  accuracy: number | null;
  playCount: number | null;
  /** Секунды за игрой. */
  playTime: number | null;
  maxCombo: number | null;
  rankedScore: number | null;
  totalScore: number | null;
  hitCount: number | null;
  replaysWatched: number | null;
  /** Уровень профиля и прогресс до следующего, проценты 0..100. */
  levelCurrent: number | null;
  levelProgress: number | null;
  gradesSS: number | null;
  gradesS: number | null;
  gradesA: number | null;
  /** Игры по месяцам: [«2026-01», 1234], старые в конце. */
  monthlyPlaycounts: [string, number][];
  fetchedAt: string;
}

/** Снимок профиля за день — точка линии прогресса. */
export interface OsuSnapshot {
  day: string;
  pp: number | null;
  globalRank: number | null;
  accuracy: number | null;
  playCount: number | null;
}

export interface PlayerOsuProfileWithHistory {
  profile: PlayerOsuProfile | null;
  /** Снимки по дням, старые в начале. */
  history: OsuSnapshot[];
}

// ────────────────────────────────────────────────────────────── турниры

/**
 * `seeded` — сетка построена, но турнир ещё не начат: её можно
 * рассмотреть, пересобрать или вернуть состав в черновик.
 *
 * `stopped` — турнир не доигран и отложен. Не всякий турнир доигрывается
 * в тот же вечер, а до этого статуса выйти из «идёт» было нельзя вовсе:
 * закрыть турнир умел только последний сыгранный матч.
 */
export type TournamentStatus = 'draft' | 'seeded' | 'running' | 'stopped' | 'finished';

/** Кто банит первым: жеребьёвкой или по сеянию. */
export type FirstBan = 'random' | 'higherSeed' | 'lowerSeed';

/**
 * Значение с исключениями по раундам: общее число, а по конкретным
 * раундам — только там, где решили иначе.
 *
 * Ключ раунда — «upper:2», «lower:1», «grand:1»: у верхней и нижней сетки
 * свои раунды, одним номером их не разделить.
 */
export interface ByRound {
  default: number;
  rounds: Record<string, number>;
}

/** Ключ раунда — тот же, что и на стороне Rust. */
export const roundKey = (bracket: BracketSide, round: number) => `${bracket}:${round}`;

export interface TournamentPlayer {
  playerId: number;
  nickname: string;
  seed: number | null;
  /** Цвет в рамках этого турнира — глобальный при этом не меняется. */
  color: string;
  /** Аватар из профиля osu!. Свой у игрока, а не у турнира. */
  avatarPath: string | null;
  placement: number | null;
  /** Новичок — играет во второй гонке, если она включена. */
  isRookie: boolean;
}

export interface Tournament {
  id: number;
  name: string;
  status: TournamentStatus;
  /** Фактическое число игроков, а не округление вверх до степени двойки. */
  bracketSize: number;
  targetScore: ByRound;
  bansPerRound: ByRound;
  firstBan: FirstBan;
  noRepeatPool: boolean;
  /** Какой маппул закреплён за раундом. Ключ — «upper:2». */
  poolByRound: Record<string, number>;
  /** Сколько побед победитель верхней получает в гранд-финале заранее. */
  grandAdvantage: number;
  /** Сеяния, прошедшие первый раунд без игры. */
  byeSeeds: number[];
  createdAt: string;
  finishedAt: string | null;
  /** Призовой фонд. `null` — без фонда, всё работает как раньше. */
  prize: PrizeConfig | null;
  players: TournamentPlayer[];
  poolIds: number[];
}

// ─────────────────────────────────────────────────────── призовой фонд

export type PrizeEngineKind = 'places' | 'matches' | 'maps' | 'bounty';

export interface PrizeEngine {
  kind: PrizeEngineKind;
  /** places: проценты по местам, убывающие, в сумме сто.
   *  bounty: проценты на голове каждого сида, в сумме сто. */
  shares: number[];
  /** matches: во сколько раз дороже следующий раунд верхней, проценты. */
  growth: number;
  /** matches/maps: скидка нижней сетки, проценты. */
  lowerDiscount: number;
  /** bounty: режим переката — половина убийце, половина ему на голову. */
  rollover: boolean;
}

export interface BountyConfig {
  /** Сумма на каждом сиде: [700, 450, 350] — на первом, втором и третьем. */
  amounts: number[];
  /** Режим переката: половина убийце, половина ему на голову. */
  rollover: boolean;
}

export interface MatchPaymentsConfig {
  amount: number;
  growth: number;
  lowerDiscount: number;
}

export interface PrizeAddons {
  bounty: BountyConfig | null;
  matchPayments: MatchPaymentsConfig | null;
  rookieRace: number | null;
  underdog: boolean;
  spectator: number | null;
  jackpot: boolean;
}

/** Конфигурация призового фонда: движок ровно один, надстроек сколько угодно. */
export interface PrizeConfig {
  /** Объявленный фонд, ₽. Ноль — фонда нет. */
  fund: number;
  engine: PrizeEngine;
  addons: PrizeAddons;
  /** Матч, отмеченный хостом как лучший (зрительский банк). */
  bestMatchId: number | null;
  /** Сколько вкатилось из переходящего джекпота при старте. */
  jackpotIn: number;
  /** Сколько уехало в джекпот при завершении. */
  rolledOut: number;
}

/** Строка лестницы мест: гарантия движка и максимум с надстройками. */
export interface PlaceLadder {
  place: number;
  guarantee: number;
  /** Максимум движка без надстроек — то, что сравнивает строгая проверка. */
  engineMax: number;
  maxTotal: number;
  /** Группа мест: выбывшие одного раунда сидят в одной группе. */
  group: number;
}

export interface LadderCheck {
  ok: boolean;
  brokenAt: number | null;
  text: string;
}

export interface RoundPrice {
  /** «upper:2». */
  key: string;
  title: string;
  matches: number;
  price: number;
}

export interface MapPrice {
  /** Карта, взятая в победном матче. */
  win: number;
  /** Карта, взятая в проигранном матче. */
  loss: number;
  unit: number;
}

export interface MoneySpan {
  min: number;
  max: number;
}

export interface PrizeRow {
  playerId: number;
  nickname: string;
  color: string;
  seed: number | null;
  rookie: boolean;
  place: number | null;
  places: number;
  matches: number;
  maps: number;
  bounty: number;
  rookiePrize: number;
  spectator: number;
  total: number;
}

export interface BountyHead {
  playerId: number;
  nickname: string;
  seed: number | null;
  amount: number;
}

export interface BountyEvent {
  killerId: number;
  killerNick: string;
  killerColor: string;
  victimId: number;
  victimNick: string;
  victimColor: string;
  taken: number;
  /** Сколько переехало на голову победителю (режим переката). */
  moved: number;
  at: string;
}

export interface RookieRow {
  playerId: number;
  nickname: string;
  color: string;
  place: number | null;
  status: 'alive' | 'out';
  earned: number;
}

export interface BestMatchView {
  id: number;
  label: string;
  aNick: string;
  bNick: string;
}

/** Деньги идущего матча: что на кону и сколько взято по ходу игры. */
export interface LiveStake {
  matchId: number;
  seedA: number | null;
  seedB: number | null;
  /** Цена победы в этом матче: движок «за матчи» и/или матчевые выплаты. */
  winPrice: number;
  /** Голова на игроке сейчас (баунти, с учётом переката). */
  headA: number;
  headB: number;
  /** Живые деньги за взятые карты (движок «за карты»), одинарная цена. */
  mapsA: number;
  mapsB: number;
}

/** Весь взгляд на фонд турнира: и для редактора, и для эфира, и для итогов. */
export interface PrizeView {
  config: PrizeConfig;
  /** Фонд с учётом вкатанного джекпота. */
  fundEffective: number;
  /** Сколько остаётся движку после надстроек. */
  engineShare: number;
  ladder: PlaceLadder[];
  check: LadderCheck;
  note: string | null;
  matchPrices: RoundPrice[];
  paymentPrices: RoundPrice[];
  mapPrice: MapPrice | null;
  spread: MoneySpan | null;
  rows: PrizeRow[];
  heads: BountyHead[];
  lastBounty: BountyEvent | null;
  /** Идущие матчи с их деньгами: что на кону и сколько взято по ходу игры. */
  live: LiveStake[];
  rookieRows: RookieRow[];
  bestMatch: BestMatchView | null;
  /** Сколько фонда не выплачено на сейчас. */
  remainder: number;
  /** Переходящий джекпот приложения на сейчас. */
  jackpotNow: number;
  finished: boolean;
  /** Ошибки конфигурации: с ними турнир не запустить. */
  problems: string[];
}

export type BracketSide = 'upper' | 'lower' | 'grand';
export type MatchStatus = 'pending' | 'running' | 'finished';

export interface Match {
  id: number;
  tournamentId: number;
  bracket: BracketSide;
  round: number;
  slotInBracket: number;
  playerA: number | null;
  playerB: number | null;
  poolId: number | null;
  status: MatchStatus;
  winnerId: number | null;
  isWalkover: boolean;
  isManualEdit: boolean;
  firstBanBy: number | null;
  nextWinSlot: number | null;
  nextLoseSlot: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Правило, взятое на старте матча. `null` — матч ещё не начинали. */
  targetScore: number | null;
  bansEach: number | null;
  /** Номер мультиплеерного лобби osu!. `null` — матч ведётся только судьёй,
   *  и цифр по картам у эфира не будет. */
  lobbyId: number | null;
  /** Счёт по картам. Считается из журнала действий, а не хранится. */
  scoreA: number;
  scoreB: number;
  /** Преимущество сетки: матч решает, но сыгранной картой не является. */
  bonusA: number;
  bonusB: number;
}

/** Турнир вместе с сеткой. */
export interface Bracket extends Tournament {
  matches: Match[];
  /** Правила и привязанные маппулы, которые не сходятся между собой. */
  problems: RuleProblem[];
  /** Итоги. Заполняются у завершённого турнира. */
  standings: Standing[];
}

/**
 * Правила турнира и маппул не сходятся: карт не хватит доиграть матч.
 * Считается по раундам — у каждого своё правило и свой маппул.
 */
export interface RuleProblem {
  /** Ключ раунда: «upper:2». */
  key: string;
  /** Как раунд подписан на сетке: «Финал верхней». */
  title: string;
  poolId: number | null;
  poolName: string;
  target: number;
  bansEach: number;
  notes: string[];
}

// ────────────────────────────────────────────────── редактор турнира

/** Строка таблицы раундов: правило, маппул и что с ними не так. */
export interface EditorRound {
  key: string;
  bracket: BracketSide;
  round: number;
  title: string;
  target: number;
  bans: number;
  /** Значение задано для этого раунда, а не унаследовано от общего. */
  targetOwn: boolean;
  bansOwn: boolean;
  /** Маппул, закреплённый за раундом. `null` — «любой свободный». */
  poolId: number | null;
  /** Что раунд играет на самом деле: закреплённый или выданный по кругу. */
  playingPoolId: number | null;
  playingPoolName: string | null;
  poolPlayable: number;
  poolHasTiebreaker: boolean;
  matches: number;
  played: number;
  /** Хоть один матч раунда начат: правило внутри него уже не поменять. */
  started: boolean;
  notes: string[];
}

/** Сеяние, прошедшее первый раунд без игры, и почему. */
export interface EditorBye {
  seed: number;
  nickname: string;
  why: string;
}

export type EditorSection = 'rules' | 'prize' | 'bracket' | 'pools' | 'players';

/** Предупреждение раздела. Блокирует только то, без чего сетку не построить. */
export interface EditorCheck {
  section: EditorSection;
  text: string;
  blocking: boolean;
}

/** Одна запись журнала правок турнира. */
export interface TournamentEdit {
  n: number;
  kind: string;
  at: string;
  emergency: boolean;
  /** Что поменяли, человеческими словами: «маппул раунда 2». */
  note: string;
  /** `n` правки-отмены, если эту откатили. */
  undoneBy: number | null;
}

/** Всё, что нужно колонке разделов. */
export interface EditorState {
  rounds: EditorRound[];
  byes: EditorBye[];
  checks: EditorCheck[];
  /** Карты, попавшие в два маппула турнира, с названиями раундов. */
  overlaps: PoolOverlap[];
  edits: TournamentEdit[];
  /** Почему отмена недоступна. `null` — можно отменять. */
  undoBlocked: string | null;
  matchesTotal: number;
  matchesStarted: number;
  matchesPlayed: number;
  /** Сколько матчей будет в сетке при текущем составе. */
  projectedMatches: number;
  emergencyAvailable: boolean;
}

/** Что случится, если применить правку сыгранного. */
export interface EditImpact {
  /** Названия матчей, которые сбросятся. */
  matches: string[];
  /** Игроки, чья статистика пересчитается. */
  players: string[];
  /** Сколько сыгранных карт перестанет учитываться. */
  maps: number;
  /** Кто вернётся в турнир и с каким счётом поражений. */
  returns: string[];
  reopensTournament: boolean;
}

/**
 * Строка итоговой таблицы турнира. Здесь турнир виден целиком сыгранным,
 * поэтому цифр больше, чем в сетке.
 */
export interface Standing {
  playerId: number;
  nickname: string;
  color: string;
  avatarPath: string | null;
  placement: number;
  matchWins: number;
  matchLosses: number;
  mapWins: number;
  mapLosses: number;
  /** Сыграно и выиграно карт по каждому мод-тегу этого турнира. */
  byMod: ModStats[];
  /** Тайбрейков сыграно и выиграно: они решают матч и стоят отдельно. */
  tiebreakers: number;
  tiebreakersWon: number;
  /** Матчей, доставшихся без игры. */
  walkovers: number;
  /** Самая длинная серия побед по картам подряд. */
  bestStreak: number;
}

// ─────────────────────────────────────────────────────────────── матч

export type ActionKind = 'ban' | 'pick' | 'result';

export interface MatchAction {
  n: number;
  type: ActionKind;
  actorId: number | null;
  slotLabel: string;
  winnerId: number | null;
  source: string;
  at: string;
}

/** Состояние строки маппула в матче. */
export type RowState =
  | { kind: 'free' }
  | { kind: 'banned'; by: number | null; n: number }
  | { kind: 'playing'; by: number | null }
  | { kind: 'played'; winner: number | null; n: number }
  | { kind: 'locked'; hint: string };

export interface MatchRow {
  slotLabel: string;
  mod: ModTag;
  beatmap: Beatmap | null;
  starRatingWithMods: number | null;
  state: RowState;
}

/** Что матчу делать дальше. Выводится из журнала целиком. */
export type Phase =
  | { kind: 'notStarted' }
  | { kind: 'ban'; actor: number; done: number; total: number }
  | { kind: 'pick'; actor: number }
  | { kind: 'result'; slotLabel: string }
  | { kind: 'finished'; winner: number | null };

export interface MatchState extends Match {
  tournamentName: string;
  players: TournamentPlayer[];
  rows: MatchRow[];
  actions: MatchAction[];
  phase: Phase;
  /** До скольких побед играет этот матч. */
  target: number;
  /** Кому осталась одна победа. */
  matchPoint: number[];
}

// ─────────────────────────────────────────────────────────── история

/** Игрок в сводке истории: ник, цвет в том турнире и id. */
export interface HistoryPlayer {
  playerId: number;
  nickname: string;
  color: string;
}

/** Финал турнира: кто играл и с каким счётом. */
export interface HistoryFinal {
  nickA: string;
  nickB: string;
  colorA: string;
  colorB: string;
  scoreA: number;
  scoreB: number;
  isWalkover: boolean;
}

/** Карточка завершённого турнира в списке истории. */
export interface HistorySummary {
  id: number;
  name: string;
  finishedAt: string | null;
  playerCount: number;
  matchCount: number;
  champion: HistoryPlayer | null;
  /** Первые три места, по возрастанию места. */
  podium: HistoryPlayer[];
  finalMatch: HistoryFinal | null;
  /** Объявленный фонд. `null` — турнир играли без денег. */
  prizeFund: number | null;
  /** Заметки-достижения: «чемпион без поражений», «самый долгий матч». */
  notes: string[];
}

/** Покартовый результат: строка маппула и кто её взял. */
export interface HistoryMapResult {
  n: number;
  slotLabel: string;
  winnerNick: string | null;
  winnerColor: string | null;
}

/** Матч в летописи турнира. */
export interface MatchLogView {
  id: number;
  bracket: BracketSide;
  round: number;
  /** Как матч подписан на сетке: «Финал нижней, матч 2». */
  title: string;
  nickA: string | null;
  nickB: string | null;
  colorA: string | null;
  colorB: string | null;
  scoreA: number;
  scoreB: number;
  isWalkover: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  maps: HistoryMapResult[];
}

/** Детальный вид турнира в истории: сетка целиком плюс летопись матчей. */
export interface HistoryDetail {
  bracket: Bracket;
  matches: MatchLogView[];
}
