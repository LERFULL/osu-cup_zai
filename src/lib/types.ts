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
  groupSets: false,
  sort: 'added',
  dir: 'desc',
};

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
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
