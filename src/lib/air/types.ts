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

/** Стиль анимации эфира. Выбирается один на весь эфир, сцена может переопределить. */
export type AirStyle = 'calm' | 'assembled' | 'cinematic';

/** Человекочитаемые названия стилей — пульт и страница согласны на одни слова. */
export const STYLE_TITLES: Record<AirStyle, string> = {
  calm: 'Сдержанно',
  assembled: 'Собирается',
  cinematic: 'Кинематограф',
};

/** Сообщение зрителю. */
export type AirMessage =
  | { kind: 'snapshot'; state: AirState }
  | {
      /** Смена кадра: новый стек слоёв целиком. */
      layers: AirLayer[];
      /**
       * Тема, если сменилась вместе с кадром. Настоящий сервер кладёт тему
       * только в снимок (зритель, зашедший позже, получит её целиком), а вот
       * мок в браузере прикладывает её и сюда — чтобы стиль можно было менять,
       * не перезагружая страницу.
       */
      theme?: AirTheme;
      kind: 'scene';
    }
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
  'matchLive',
  'banReveal',
  'pickReveal',
  'mapProgress',
  'mapResult',
  'matchResult',
  'bountyHeads',
  'bountyTaken',
] as const;

export const PAUSE_SCENES = [
  'trailerTitle',
  'trailerPlayers',
  'trailerStakes',
  'bracket',
  'standings',
  'nextUp',
  'countdown',
  'playerCard',
  'records',
  'champion',
  'credits',
  'fundBoard',
  'fundFlow',
  'topEarners',
  'rookieRace',
  'spectatorBank',
  'jackpotScene',
  'idle',
  'message',
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
  /** Живые деньги матча: цена победы, головы, счётчик карт. */
  money: AirMoney | null;
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

/** Живые деньги матча: кто сколько уже заработал и что на кону. */
export interface AirMoney {
  aEarned: number;
  bEarned: number;
  /** Цена карты в этом матче — победная и утешительная. */
  perWin: number;
  perLoss: number;
  /** Цена победы в матче: движок «за матчи» и/или матчевые выплаты. */
  winPrice: number;
  /** Голова на игроке сейчас (баунти, с учётом переката). */
  headA: number;
  headB: number;
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
  /** Живой счётчик движка «за карты». `null` — фонд не про карты. */
  money: AirMoney | null;
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
  /** Живой счётчик движка «за карты». */
  money: AirMoney | null;
  /** Ступень андердога — «андердог ×3», а не коэффициент. */
  underdog: string | null;
}

/** Деньги, которые каждый унесёт из закрывшегося матча. */
export interface MatchMoneyAfter {
  /** Итог победителя: победа, победные карты и снятая голова. */
  winnerTake: number;
  /** Утешительные карты проигравшего (движок «за карты»). */
  loserTake: number;
  /** Из них — цена победы в матче (движок «за матчи» и/или выплаты). */
  winPrice: number;
  /** Из них — снятая голова. */
  headTaken: number;
  /** Победные карты победителя, рублями. */
  winnerMaps: number;
  /** Утешительные карты проигравшего, рублями. */
  loserMaps: number;
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
  /** Ступень андердога — «андердог ×3», а не коэффициент. */
  underdog: string | null;
  /** Что по деньгам будет после матча. `null` — матч ничего не принёс. */
  after: MatchMoneyAfter | null;
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

export interface RecordsPayload {
  /** Строки собирает хост: он один знает, что посчиталось, а что нет. */
  items: { title: string; value: string; note: string | null }[];
}

/** Строка табло фонда: источник денег и сумма. */
export interface FundBoardRow {
  title: string;
  note: string | null;
  amount: number;
  /** Цвет строки: места — золотой, надстройки — свой. */
  kind: 'places' | 'matches' | 'maps' | 'bounty' | 'rookie' | 'spectator' | 'jackpot' | 'rest';
}

export interface FundBoardPayload {
  fund: number;
  paid: number;
  /** Как фонд распределён. */
  scheme: FundBoardRow[];
  /** Кто сколько уже заработал, по убыванию. */
  earned: { nick: string; color: string; osuUserId: number | null; amount: number }[];
  /** Осталось раздать — уходит в джекпот, если он включён. */
  remainder: number;
}

export interface BountyHeadsPayload {
  a: AirPlayer;
  b: AirPlayer;
  /** Сколько висит на каждом — то, что соперник может снять. */
  headA: number;
  headB: number;
}

export interface BountyTakenPayload {
  killer: AirPlayer;
  victim: AirPlayer;
  taken: number;
  /** Сколько переехало на голову убийцы — режим переката. */
  moved: number;
}

export interface RookieRacePayload {
  amount: number;
  rows: { nick: string; color: string; osuUserId: number | null; place: number | null; out: boolean }[];
}

export interface SpectatorBankPayload {
  amount: number;
  /** За что голосуют — формулировка банка. */
  note: string;
  /** Кто уже взял: подпись лучшего матча. `null` — ещё не отмечен. */
  best: string | null;
}

export interface JackpotPayload {
  /** Сколько переедет в следующий турнир, если сейчас закончить. */
  projected: number;
  /** Сколько лежит в джекпоте прямо сейчас. */
  current: number;
}

// ───────────────────────────────────────────────── трейлеры турнира

/** Первый показ — не то же самое, что эфир по ходу игры. Трейлеры выходят
 * до первого матча и рассказывают, что за турнир сейчас начнётся. */

export interface TrailerTitlePayload {
  tournament: string;
  /** «двойная выбывание · 8 участников · 33 матча». */
  format: string;
  /** Названия маппулов, разложенных по раундам. */
  pools: string[];
  /** Сколько карт всего лежит в этих маппулах. */
  maps: number;
}

export interface TrailerPlayersPayload {
  tournament: string;
  rows: {
    nick: string;
    color: string;
    osuUserId: number | null;
    seed: number | null;
    rookie: boolean;
  }[];
}

export interface TrailerStakesPayload {
  tournament: string;
  /** `null` — турнир без фонда: сцена покажет формат. */
  fund: number | null;
  /** Движок и надстройки — по строке на источник денег. */
  scheme: { title: string; note: string | null; amount: number }[];
  /** «двойная выбывание · до 4 побед в матче». */
  format: string;
}

export interface ChampionPayload {
  podium: {
    place: number;
    nick: string;
    color: string;
    osuUserId: number | null;
    matches: string;
    maps: string;
    /** Кто сколько унёс — из призового фонда. `null` — фонда нет. */
    earned: number | null;
  }[];
}

export interface CreditsPayload {
  tournament: string;
  duration: string;
  rows: { place: number | null; nick: string; color: string }[];
  /** Организаторы и судьи, ссылки и соцсети — по строке на человека/адрес. */
  organizers: string[];
  judges: string[];
  links: string[];
  socials: string[];
}

/** Все виды содержимого. Сцена выбирает рендерер по `id`, а не по форме данных. */
export type ScenePayload =
  | IdlePayload
  | MessagePayload
  | MatchIntroPayload
  | MatchLivePayload
  | BanRevealPayload
  | PickRevealPayload
  | MapProgressPayload
  | MapResultPayload
  | MatchResultPayload
  | BountyHeadsPayload
  | BountyTakenPayload
  | BracketPayload
  | StandingsPayload
  | NextUpPayload
  | CountdownPayload
  | PlayerCardPayload
  | RecordsPayload
  | ChampionPayload
  | CreditsPayload
  | FundBoardPayload
  | RookieRacePayload
  | SpectatorBankPayload
  | JackpotPayload
  | TrailerTitlePayload
  | TrailerPlayersPayload
  | TrailerStakesPayload
  | Record<string, never>;

// ──────────────────────────────────────────────── пульт: что знает хост

/** Настройки эфира турнира. Лежат в базе одной строкой JSON. */
export interface AirConfig {
  /**
   * Придерживать вскрытие пика: кадр ждёт кнопки, а не выходит сам.
   *
   * Единственное исключение из «эфир идёт сам», и существует оно ровно для
   * драмы: пик — тот момент, который хочется вскрыть тогда, когда решил ты,
   * а не когда судья ввёл. Всё остальное выходит без нажатий, потому что
   * судья и хост — один человек.
   */
  holdPicks: boolean;
  /** Включённые заготовки. Невключённая сцена не появится никогда. */
  enabled: SceneId[];
  /**
   * Стиль анимации на весь эфир: как кадры входят в экран.
   *
   * Выбирается один, потому что эфир — это одно целое: смешанные по стилю
   * переходы читаются как сбой, а не как разнообразие.
   */
  style: AirStyle;
  /** Переопределение стиля для отдельной сцены. Ключа нет — как у всех. */
  sceneStyle: Partial<Record<SceneId, AirStyle>>;
  /**
   * Тексты финала: организаторы, судьи, ссылки и соцсети. В модели турнира их
   * нет — их знает только эфир, поэтому лежат здесь, а не в редакторе.
   * Каждое поле — свободный текст, строки через \n.
   */
  finalTexts: {
    organizers: string;
    judges: string;
    links: string;
    socials: string;
  };
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
}

export const DEFAULT_CONFIG: AirConfig = {
  // По умолчанию не придерживаем: эфир не должен требовать внимания.
  holdPicks: false,
  // Включено всё: каждая сцена считается по самому турниру, и данных под них
  // не надо доносить руками.
  enabled: [...MATCH_SCENES, ...PAUSE_SCENES],
  // Сдержанно: эфир говорит, а не показывает трюки. Два других стиля —
  // осознанный выбор, а не настройка по умолчанию.
  style: 'calm',
  sceneStyle: {},
  finalTexts: { organizers: '', judges: '', links: '', socials: '' },
  roundPlans: {},
  pauseBudget: 240,
  pauseAuto: true,
  message: '',
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
