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

  /** Сколько сложностей у набора. Есть только в схлопнутом списке. */
  setCount?: number | null;
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
  /** Схлопывать сложности одного набора в одну строку. */
  groupSets: boolean;
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
  groupSets: false,
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

/** Карты появляются в библиотеке уже на стадии saving, остальное дотягивается фоном. */
export type ImportStage =
  | 'queued'
  | 'fetching'
  | 'saving'
  | 'covers'
  | 'skillsets'
  | 'done'
  | 'cancelled';

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

export interface GenRules {
  noRepeatMapper: boolean;
  /** Маппулы, карты из которых брать нельзя. */
  noRepeatFromPools: number[];
  minBpmSpread: number | null;
  rankedOnly: boolean;
  balanceSkillsets: boolean;
  lengthMax: number | null;
}

export const EMPTY_RULES: GenRules = {
  noRepeatMapper: false,
  noRepeatFromPools: [],
  minBpmSpread: null,
  rankedOnly: false,
  balanceSkillsets: false,
  lengthMax: null,
};

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
  createdAt: string;
  slots: TemplateSlot[];
}

/** Сколько карт нужно под слот и сколько нашлось в его источнике. */
export interface SlotSupply {
  position: number;
  mod: ModTag;
  need: number;
  available: number;
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

export interface PoolSlot {
  id: number;
  slotLabel: string;
  mod: ModTag;
  beatmapId: number | null;
  pinned: boolean;
  starRatingWithMods: number | null;
  fmMods: string[];
  position: number;
  /** Есть только при чтении одного пула — в списке карты не нужны. */
  beatmap: Beatmap | null;
  warnings: string[];
}

export interface Pool {
  id: number;
  name: string;
  templateId: number | null;
  templateName: string | null;
  folderId: number | null;
  status: PoolStatus;
  version: number;
  parentPoolId: number | null;
  displayFields: PoolField[];
  /** Сыгранный пул неизменяем: правка уводит в свежую копию. */
  isLocked: boolean;
  createdAt: string;
  slots: PoolSlot[];
}

/** Итог генерации: сам пул и то, что не получилось выдержать. */
export interface GenReport {
  pool: Pool;
  notes: string[];
}

/** Карта, попавшая сразу в несколько маппулов одного турнира. */
export interface PoolOverlap {
  beatmapId: number;
  /** «Исполнитель — название», как в строке карты. */
  name: string;
  /** Названия маппулов, в которых она встретилась. */
  pools: string[];
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
}

// ────────────────────────────────────────────────────────────── турниры

/**
 * `seeded` — сетка построена, но турнир ещё не начат: её можно
 * рассмотреть, пересобрать или вернуть состав в черновик.
 */
export type TournamentStatus = 'draft' | 'seeded' | 'running' | 'finished';

/** Кто банит первым: жеребьёвкой или по сеянию. */
export type FirstBan = 'random' | 'higherSeed' | 'lowerSeed';

/**
 * Значение с исключениями по раундам: общее число, а по конкретным
 * раундам — только там, где решили иначе.
 */
export interface ByRound {
  default: number;
  rounds: Record<string, number>;
}

export interface TournamentPlayer {
  playerId: number;
  nickname: string;
  seed: number | null;
  /** Цвет в рамках этого турнира — глобальный при этом не меняется. */
  color: string;
  placement: number | null;
}

export interface Tournament {
  id: number;
  name: string;
  status: TournamentStatus;
  bracketSize: number;
  targetScore: ByRound;
  bansPerRound: ByRound;
  firstBan: FirstBan;
  noRepeatPool: boolean;
  createdAt: string;
  finishedAt: string | null;
  players: TournamentPlayer[];
  poolIds: number[];
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
  /** Счёт по картам. Считается из журнала действий, а не хранится. */
  scoreA: number;
  scoreB: number;
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
 * Считается там, где и то и другое выбирают, — на экране турнира.
 */
export interface RuleProblem {
  poolId: number;
  poolName: string;
  /** Раунд, для которого правило задано отдельно. `null` — общее правило. */
  round: number | null;
  target: number;
  bansEach: number;
  notes: string[];
}

/** Строка итоговой таблицы турнира. */
export interface Standing {
  playerId: number;
  nickname: string;
  color: string;
  placement: number;
  matchWins: number;
  matchLosses: number;
  mapWins: number;
  mapLosses: number;
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
