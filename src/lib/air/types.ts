// Состояние эфира и содержимое сцен. Зеркалят `src-tauri/src/air/state.rs` —
// менять только парой.
//
// Главное правило: страница ничего не достраивает. Если в кадре нужны ник, цвет,
// аватар, сеяние и личный счёт — все пять лежат в `payload`. Отсюда и вид этих
// типов: они не ссылаются на доменные структуры турнира, а повторяют ровно то,
// что видно в кадре. Это делает страницу тупой и надёжной.

import type { ModTag } from '@/lib/types';

// ────────────────────────────────────────────────── состояние и протокол

export interface AirLayer {
  id: SceneId;
  /** Когда слой вошёл в эфир: от этого времени считаются анимации и таймеры. */
  since: string;
  /** Когда уйдёт сам. `null` — стоит, пока не сменят. */
  until: string | null;
  payload: ScenePayload;
}

export interface AirMeta {
  tournament: string;
  startedAt: string;
}

export interface AirTheme {
  accent: string;
  /** Дальше сюда добавляются токены — форма объекта задана под это сразу. */
  [key: string]: string;
}

export interface AirState {
  air: AirMeta;
  /** Снизу вверх: первый слой — основа, последний — то, что сверху. */
  layers: AirLayer[];
  theme: AirTheme;
}

/** Сообщение зрителю. */
export type AirMessage =
  | { kind: 'snapshot'; state: AirState }
  | { kind: 'scene'; layers: AirLayer[] }
  | { kind: 'patch'; layer: SceneId; payload: ScenePayload }
  | { kind: 'closed'; reason: string }
  | { kind: 'ping' };

// ─────────────────────────────────────────────────────────── общие части

/** Игрок так, как он выглядит в кадре. */
export interface AirPlayer {
  id: number;
  nick: string;
  color: string;
  /** Адрес аватара страница собирает сама: `a.ppy.sh/{id}`. `null` — буква ника. */
  osuUserId: number | null;
  seed: number | null;
}

/** Карта так, как она выглядит в кадре. Звёзды, длина и BPM — уже под модом. */
export interface AirMap {
  slot: string;
  mod: ModTag;
  /** Обложку страница собирает сама: `assets.ppy.sh/beatmaps/{id}/covers/...`. */
  beatmapsetId: number | null;
  title: string;
  version: string;
  stars: number | null;
  length: number | null;
  bpm: number | null;
  mapper: string | null;
}

export type AirRowState = 'free' | 'banned' | 'playing' | 'played' | 'locked';

export interface AirRow extends AirMap {
  state: AirRowState;
  /** Кто забанил или пикнул. */
  by: number | null;
  /** Кто выиграл карту. */
  winner: number | null;
  /** Номер бана — «✕ бан 3». */
  n: number | null;
}

/** Чей ход и что он делает. Строку собирает хост, страница её только рисует. */
export interface AirTurn {
  /** «Ход NAGISA — бан 2 из 3». */
  text: string;
  /** Чей ход: по нему подсвечивается сторона. */
  actor: number | null;
}

/** Результат одного игрока на карте. Приходит из лобби, поэтому всё необязательно. */
export interface AirScore {
  playerId: number;
  nick: string;
  color: string;
  score: number | null;
  accuracy: number | null;
  combo: number | null;
  miss: number | null;
  rank: string | null;
  mods: string[];
}

// ───────────────────────────────────────────────────────── каталог сцен

export const MATCH_SCENES = [
  'matchIntro',
  'firstBanDraw',
  'matchLive',
  'banReveal',
  'pickReveal',
  'mapProgress',
  'mapResult',
  'matchPoint',
  'decider',
  'matchResult',
] as const;

export const PAUSE_SCENES = [
  'bracket',
  'poolShowcase',
  'standings',
  'nextUp',
  'countdown',
  'playerCard',
  'headToHead',
  'playerPath',
  'records',
  'modStats',
  'poolRecap',
  'champion',
  'credits',
  'idle',
  'message',
  'clip',
] as const;

export type MatchSceneId = (typeof MATCH_SCENES)[number];
export type PauseSceneId = (typeof PAUSE_SCENES)[number];
export type SceneId = MatchSceneId | PauseSceneId;

// ──────────────────────────────────────────────────── содержимое сцен

export interface IdlePayload {
  tournament: string;
  note: string | null;
}

export interface MessagePayload {
  text: string;
  note: string | null;
}

export interface MatchIntroPayload {
  a: AirPlayer;
  b: AirPlayer;
  /** Личный счёт этих двоих до матча. */
  versusA: number;
  versusB: number;
  target: number;
  round: string;
}

export interface FirstBanDrawPayload {
  a: AirPlayer;
  b: AirPlayer;
  /** Кто банит первым. */
  first: number;
  /** «жеребьёвка» или «по сеянию» — почему именно он. */
  why: string;
}

export interface MatchLivePayload {
  a: AirPlayer;
  b: AirPlayer;
  scoreA: number;
  scoreB: number;
  /** Преимущество сетки — часть счёта, но не сыгранная карта. */
  bonus: number;
  target: number;
  round: string;
  rows: AirRow[];
  turn: AirTurn;
  matchPoint: number[];
}

export interface BanRevealPayload {
  map: AirMap;
  n: number;
  by: AirPlayer | null;
}

export interface PickRevealPayload {
  map: AirMap;
  by: AirPlayer | null;
}

export interface MapProgressPayload {
  map: AirMap;
  a: AirPlayer;
  b: AirPlayer;
  scoreA: number;
  scoreB: number;
  /** Когда карта началась в лобби. Прогресс страница считает по времени. */
  startedAt: string;
  /** Длина под модом, секунды. */
  length: number;
}

export interface MapResultPayload {
  map: AirMap;
  winner: AirPlayer | null;
  /** Пусто, если лобби не подключено: счёт по картам покажем без цифр. */
  scores: AirScore[];
  scoreA: number;
  scoreB: number;
  a: AirPlayer;
  b: AirPlayer;
}

export interface MatchPointPayload {
  who: AirPlayer;
  a: AirPlayer;
  b: AirPlayer;
  scoreA: number;
  scoreB: number;
}

export interface DeciderPayload {
  /** Тайбрейк, если он есть в маппуле. */
  map: AirMap | null;
  a: AirPlayer;
  b: AirPlayer;
  scoreA: number;
  scoreB: number;
  why: string;
}

export interface MatchResultPayload {
  a: AirPlayer;
  b: AirPlayer;
  scoreA: number;
  scoreB: number;
  winner: AirPlayer;
  walkover: boolean;
  /** Куда пошёл победитель и куда упал проигравший. */
  winnerGoes: string | null;
  loserGoes: string | null;
  round: string;
}

/** Сторона матча в сетке. */
export interface AirBracketSide {
  nick: string;
  color: string;
  score: number;
  won: boolean;
  /** Откуда придёт игрок, если места ещё нет: «Победитель ВС R2-1». */
  waiting: string | null;
}

/**
 * Карточка матча в сетке — с координатами.
 *
 * Раскладку считает хост той же функцией, что рисует сетку в приложении:
 * сетка в эфире должна быть той же самой, а не похожей. Страница получает
 * готовые числа и не знает ни про раунды, ни про то, кто куда падает.
 */
export interface AirBracketCard {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  a: AirBracketSide | null;
  b: AirBracketSide | null;
  done: boolean;
  live: boolean;
}

/** Связь между матчами: готовый путь SVG. */
export interface AirBracketLink {
  key: string;
  d: string;
  /** Падение в нижнюю сетку, а не проход дальше. */
  drop: boolean;
  /** Цвет прошедшего этим путём. `null` — ветка ещё не сыграна. */
  color: string | null;
}

/** Подпись колонки. */
export interface AirBracketHead {
  key: string;
  title: string;
  x: number;
  y: number;
  w: number;
}

/**
 * Остановка камеры: какую часть полотна показать.
 *
 * Сетка на десять матчей в кадр целиком читается плохо, поэтому камера идёт по
 * ней. Считает остановки хост — он один знает, где живое и где только что
 * доиграли.
 */
export interface AirBracketStop {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Что подсветить на этой остановке. Пусто — просто обзор. */
  cards: number[];
}

export interface BracketPayload {
  width: number;
  height: number;
  cards: AirBracketCard[];
  links: AirBracketLink[];
  heads: AirBracketHead[];
  /** Маршрут камеры. Одна остановка — сетка стоит целиком. */
  stops: AirBracketStop[];
}

export interface PoolShowcasePayload {
  title: string;
  groups: { mod: ModTag; maps: AirMap[] }[];
}

export interface StandingsPayload {
  rows: {
    nick: string;
    color: string;
    osuUserId: number | null;
    place: number | null;
    losses: number;
    out: boolean;
  }[];
}

export interface NextUpPayload {
  next: { round: string; a: AirPlayer | null; b: AirPlayer | null } | null;
  then: { round: string; a: AirPlayer | null; b: AirPlayer | null }[];
}

export interface CountdownPayload {
  /** Момент, до которого идёт отсчёт. Считает страница — по времени, не по тикам. */
  until: string;
  label: string;
}

export interface PlayerCardPayload {
  player: AirPlayer;
  /** Профиль osu!. `null` — игрок не привязан, показываем только своё. */
  osu: {
    pp: number | null;
    globalRank: number | null;
    countryRank: number | null;
    accuracy: number | null;
    playCount: number | null;
  } | null;
  tournaments: number;
  tournamentWins: number;
  matches: number;
  matchWins: number;
  maps: number;
  mapWins: number;
  bestMod: string | null;
  worstMod: string | null;
}

export interface HeadToHeadPayload {
  a: AirPlayer;
  b: AirPlayer;
  winsA: number;
  winsB: number;
  matches: { round: string; score: string; winner: number | null }[];
  /** Любимая карта каждого. Пусто — не играли столько, чтобы было видно. */
  favourites: { playerId: number; title: string }[];
}

export interface PlayerPathPayload {
  player: AirPlayer;
  steps: { round: string; against: string; score: string; won: boolean }[];
}

export interface RecordsPayload {
  /** Строки собирает хост: он один знает, что посчиталось, а что нет. */
  items: { title: string; value: string; note: string | null }[];
}

export interface ModStatsPayload {
  rows: { mod: ModTag; played: number; banned: number; blowouts: number }[];
}

export interface PoolRecapPayload {
  rows: (AirMap & { played: number; banned: number })[];
}

export interface ChampionPayload {
  podium: {
    place: number;
    nick: string;
    color: string;
    osuUserId: number | null;
    matches: string;
    maps: string;
  }[];
}

export interface CreditsPayload {
  tournament: string;
  duration: string;
  rows: { place: number | null; nick: string; color: string }[];
}

export interface ClipPayload {
  /** Адрес файла. Раздаётся только локальным сервером — см. `localOnly`. */
  src: string;
  title: string | null;
}

/** Все виды содержимого. Сцена выбирает рендерер по `id`, а не по форме данных. */
export type ScenePayload =
  | IdlePayload
  | MessagePayload
  | MatchIntroPayload
  | FirstBanDrawPayload
  | MatchLivePayload
  | BanRevealPayload
  | PickRevealPayload
  | MapProgressPayload
  | MapResultPayload
  | MatchPointPayload
  | DeciderPayload
  | MatchResultPayload
  | BracketPayload
  | PoolShowcasePayload
  | StandingsPayload
  | NextUpPayload
  | CountdownPayload
  | PlayerCardPayload
  | HeadToHeadPayload
  | PlayerPathPayload
  | RecordsPayload
  | ModStatsPayload
  | PoolRecapPayload
  | ChampionPayload
  | CreditsPayload
  | ClipPayload
  | Record<string, never>;

// ──────────────────────────────────────────────── пульт: что знает хост

export type AirMode = 'manual' | 'confirm' | 'auto';

/** Настройки эфира турнира. Лежат в базе одной строкой JSON. */
export interface AirConfig {
  mode: AirMode;
  /** Включённые заготовки. Невключённая сцена не появится никогда. */
  enabled: SceneId[];
  /**
   * Порядок сцен паузы по раундам. Ключ — `${bracket}:${round}`.
   *
   * Пауза перед матчами раунда идёт по этому списку, а не подбирается сама:
   * перед первым раундом уместно одно, перед финалом другое, и решать это
   * лучше заранее, а не в тот момент, когда все ждут начала. Раунда в списке
   * нет — подбор идёт сам, как без плана.
   */
  roundPlans: Record<string, SceneId[]>;
  /** Ожидаемая пауза, секунды. */
  pauseBudget: number;
  /**
   * Плейлист паузы идёт сам, без нажатий.
   *
   * Отдельно от режима управления нарочно: подтверждать каждый кадр статистики
   * между матчами — это работа на пустом месте, а вот кадры матча хост как раз
   * может хотеть выпускать руками.
   */
  pauseAuto: boolean;
  /** Своя надпись для сцены `message`. */
  message: string;
  /** Файл для сцены `clip`. */
  clip: string;
}

export const DEFAULT_CONFIG: AirConfig = {
  mode: 'confirm',
  // Включено всё, что считается по самому турниру. Выключен только свой
  // видеофайл: под него нужен файл, а без файла кнопка была бы обманом.
  enabled: [
    ...MATCH_SCENES,
    ...PAUSE_SCENES.filter((id) => id !== 'clip'),
  ],
  roundPlans: {},
  pauseBudget: 240,
  pauseAuto: true,
  message: '',
  clip: '',
};

/** Состояние эфира со стороны Rust. */
export interface AirStatus {
  live: boolean;
  tournamentId: number | null;
  port: number;
  /** Адрес для OBS. Единственный: сервер слушает только петлю. */
  localUrl: string;
  startedAt: string | null;
  aired: AirState | null;
  lobby: { matchId: number; roomId: number; polling: boolean } | null;
}

/** Сколько раз сцена выходила в эфир в этом турнире. */
export interface SceneShow {
  sceneId: SceneId;
  objectKey: string;
  shows: number;
  lastAt: string | null;
}

/** Профиль osu! для сцен с цифрами. */
export interface OsuProfile {
  osuUserId: number;
  username: string | null;
  pp: number | null;
  globalRank: number | null;
  countryRank: number | null;
  countryCode: string | null;
  accuracy: number | null;
  playCount: number | null;
}

// ─────────────────────────────────────────────────────────────── лобби

export interface LobbyScore {
  userId: number | null;
  totalScore: number;
  accuracy: number | null;
  maxCombo: number | null;
  passed: boolean;
  rank: string | null;
  mods: string[];
  great: number | null;
  ok: number | null;
  meh: number | null;
  miss: number | null;
}

export interface LobbyGame {
  gameId: number;
  beatmapId: number | null;
  beatmapsetId: number | null;
  title: string | null;
  startTime: string | null;
  /** `null` — карта играется прямо сейчас. */
  endTime: string | null;
  mods: string[];
  /** Без учёта мода: пересчёт делает `derive`, той же формулой, что и карточка. */
  totalLength: number | null;
  /** Пусто, пока карта не кончилась: живого счёта во время карты API не даёт. */
  scores: LobbyScore[];
}

export interface LobbyUser {
  userId: number;
  username: string | null;
  avatarUrl: string | null;
  countryCode: string | null;
}

export interface LobbyUpdate {
  matchId: number;
  roomId: number;
  currentGameId: number | null;
  at: string;
  games: LobbyGame[];
  users: LobbyUser[];
  error: string | null;
}
