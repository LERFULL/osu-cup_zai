// Сборка содержимого сцен из доменных данных.
//
// Всё, что попадает в кадр, собирается здесь и уходит зрителю готовым: ник,
// цвет, аватар, сеяние, личный счёт — все пять полей, а не ссылки на них.
// Страница не достраивает данные и не догадывается, поэтому сломать её можно
// только сломав сборку.

import { CARD_H, COL_W, layoutBracket } from '@/lib/bracketLayout';
import { derive, modsFor } from '@/lib/derive';
import { formatLength, formatSpan, plural } from '@/lib/format';
import type {
  Beatmap,
  Bracket,
  BracketSide,
  EditorState,
  Match,
  MatchRow,
  MatchState,
  ModTag,
  Player,
  PlayerStats,
  Pool,
  PrizeView,
  Standing,
  TournamentPlayer,
} from '@/lib/types';
import type {
  AirBracketCard,
  AirBracketHead,
  AirBracketLink,
  AirBracketSide,
  AirBracketStop,
  AirMap,
  AirMoney,
  AirPlayer,
  AirRow,
  AirScore,
  AirTurn,
  BountyHeadsPayload,
  BountyTakenPayload,
  BracketPayload,
  ChampionPayload,
  CreditsPayload,
  FundBoardPayload,
  FundBoardRow,
  JackpotPayload,
  LobbyGame,
  MapProgressPayload,
  MapResultPayload,
  MatchIntroPayload,
  MatchLivePayload,
  MatchResultPayload,
  NextUpPayload,
  OsuProfile,
  PlayerCardPayload,
  RecordsPayload,
  RookieRacePayload,
  SpectatorBankPayload,
  StandingsPayload,
  StatsPayload,
  TrailerPlayersPayload,
  TrailerStakesPayload,
  TrailerTitlePayload,
} from './types';

/**
 * Всё, из чего собираются кадры. Собирается пультом один раз на событие и
 * передаётся сборщикам целиком: перечислять двенадцать аргументов на каждую
 * сцену — это двенадцать способов забыть один.
 */
export interface AirContext {
  bracket: Bracket;
  /** Глобальные игроки: `osuUserId` есть только здесь. */
  players: Player[];
  editor: EditorState;
  pools: Pool[];
  /** Внутренняя статистика по игроку. */
  stats: Map<number, PlayerStats>;
  /** Профили osu!: pp и ранги. Игрок без привязки сюда не попадает. */
  profiles: Map<number, OsuProfile>;
  /** Журналы сыгранных матчей — из них считаются рекорды и разбор по модам. */
  logs: MatchState[];
  /** Призовой фонд: `null` — турнир без фонда. */
  prize: PrizeView | null;
}

// ─────────────────────────────────────────────────────────── общие части

export function airPlayer(ctx: AirContext, playerId: number | null): AirPlayer | null {
  if (playerId === null) return null;
  const inside = ctx.bracket.players.find((p) => p.playerId === playerId) ?? null;
  const global = ctx.players.find((p) => p.id === playerId) ?? null;
  if (inside === null && global === null) return null;

  return {
    id: playerId,
    nick: inside?.nickname ?? global?.nickname ?? 'игрок',
    color: inside?.color ?? global?.color ?? '#8a91a3',
    osuUserId: global?.osuUserId ?? null,
    seed: inside?.seed ?? null,
  };
}

/** Игрок, которого точно нет в кадре: пустое место в сетке. */
const UNKNOWN: AirPlayer = {
  id: -1,
  nick: '—',
  color: '#7f8799',
  osuUserId: null,
  seed: null,
};

const sure = (p: AirPlayer | null): AirPlayer => p ?? UNKNOWN;

/** Название раунда так, как оно подписано на сетке. */
export function roundTitle(ctx: AirContext, m: Match): string {
  const round = ctx.editor.rounds.find((r) => r.bracket === m.bracket && r.round === m.round);
  const title = round?.title ?? `раунд ${m.round}`;
  return round !== undefined && round.matches > 1
    ? `${title}, матч ${m.slotInBracket + 1}`
    : title;
}

/**
 * Карта для кадра. Звёзды, длина и BPM пересчитаны под мод той же формулой,
 * что в карточке карты: зритель видит то, что реально будет играться.
 */
export function airMap(slot: string, mod: ModTag, map: Beatmap | null, starsWithMods: number | null): AirMap {
  if (map === null) {
    return {
      slot,
      mod,
      beatmapsetId: null,
      title: 'карта не подобрана',
      version: '',
      stars: null,
      length: null,
      bpm: null,
      mapper: null,
    };
  }

  const d = derive(map, modsFor(mod));
  return {
    slot,
    mod,
    beatmapsetId: map.beatmapsetId,
    title: `${map.artist} — ${map.title}`,
    version: map.version,
    stars: starsWithMods ?? map.difficultyRating,
    length: d.totalLength,
    bpm: d.bpm,
    mapper: map.creator,
  };
}

const rowMap = (row: MatchRow): AirMap =>
  airMap(row.slotLabel, row.mod, row.beatmap, row.starRatingWithMods);

function airRow(row: MatchRow): AirRow {
  const base = rowMap(row);
  switch (row.state.kind) {
    case 'banned':
      return { ...base, state: 'banned', by: row.state.by, winner: null, n: row.state.n };
    case 'playing':
      return { ...base, state: 'playing', by: row.state.by, winner: null, n: null };
    case 'played':
      return { ...base, state: 'played', by: null, winner: row.state.winner, n: row.state.n };
    case 'locked':
      return { ...base, state: 'locked', by: null, winner: null, n: null };
    case 'free':
      return { ...base, state: 'free', by: null, winner: null, n: null };
  }
}

/** Чей ход и что он делает — та же строка, что видит судья. */
export function airTurn(m: MatchState, name: (id: number | null) => string): AirTurn {
  switch (m.phase.kind) {
    case 'notStarted':
      return { text: 'Матч скоро начнётся', actor: null };
    case 'ban':
      return {
        text: `Ход ${name(m.phase.actor)} — бан ${Math.floor(m.phase.done / 2) + 1} из ${m.phase.total / 2}`,
        actor: m.phase.actor,
      };
    case 'pick':
      return { text: `Ход ${name(m.phase.actor)} — пик`, actor: m.phase.actor };
    case 'result':
      return { text: `Идёт ${m.phase.slotLabel}`, actor: null };
    case 'finished':
      return {
        text: m.phase.winner === null ? 'Матч завершён' : `Победил ${name(m.phase.winner)}`,
        actor: m.phase.winner,
      };
  }
}

/** Ищет игрока по имени внутри матча — для строки хода. */
const namer = (ctx: AirContext) => (id: number | null) => airPlayer(ctx, id)?.nick ?? '—';

// ──────────────────────────────────────────────────────── сцены матча


// ─────────────────────────────────────────────── деньги в кадре

/** Заработок игрока на сейчас. */
function earnedOf(ctx: AirContext, playerId: number): number {
  return ctx.prize?.rows.find((r) => r.playerId === playerId)?.total ?? 0;
}

/** Группы сидов и ступень множителя — та же математика, что в Rust. */
function seedGroup(seed: number | null): number {
  if (seed === null) return 4;
  if (seed <= 2) return 0;
  if (seed <= 4) return 1;
  if (seed <= 8) return 2;
  if (seed <= 16) return 3;
  return 4;
}

/** Ступень множителя за андердога числом — для расчёта денег после матча. */
function underdogStep(winnerSeed: number | null, loserSeed: number | null): number {
  if (winnerSeed === null || loserSeed === null) return 1;
  const diff = seedGroup(winnerSeed) - seedGroup(loserSeed);
  if (diff === 1) return 1.5;
  if (diff === 2) return 2;
  if (diff >= 3) return 3;
  return 1;
}

/** Ступень андердога словами — «андердог ×3», а не коэффициент. */
export function underdogLabel(
  winnerSeed: number | null,
  loserSeed: number | null,
): string | null {
  if (winnerSeed === null || loserSeed === null) return null;
  const diff = seedGroup(winnerSeed) - seedGroup(loserSeed);
  if (diff === 1) return 'андердог ×1.5';
  if (diff === 2) return 'андердог ×2';
  if (diff >= 3) return 'андердог ×3';
  return null;
}

/** Живые деньги матча — счётчик движка «за карты».
 *
 * Полоса денег в «Ходе матча» существует только у движка «за карты»: это
 * живой счётчик, который растёт с каждой картой. У движков «за места» и
 * «за победы» ничего по ходу матча не меняется — полоса висела бы мёртвым
 * грузом; цена победы в таких матчах показывается в представлении и в
 * итогах. Головы — врезкой перед матчем, им своя сцена.
 *
 * Заработок в полосе — за этот матч, а не за турнир: зритель смотрит
 * «сколько взял прямо сейчас», а не таблицу итогов. */
function matchMoney(ctx: AirContext, m: MatchState): AirMoney | null {
  const cfg = ctx.prize?.config ?? null;
  if (cfg === null || cfg.engine.kind !== 'maps') return null;
  const price = ctx.prize?.mapPrice ?? null;
  if (price === null) return null;

  const stake = ctx.prize?.live.find((l) => l.matchId === m.id) ?? null;
  return {
    aEarned: stake?.mapsA ?? 0,
    bEarned: stake?.mapsB ?? 0,
    perWin: price.win,
    perLoss: price.loss,
    winPrice: stake?.winPrice ?? 0,
    headA: stake?.headA ?? 0,
    headB: stake?.headB ?? 0,
  };
}

/** Ступень андердога для победителя матча. */
function matchUnderdog(ctx: AirContext, m: MatchState): string | null {
  if (ctx.prize?.config.addons.underdog !== true || m.winnerId === null) return null;
  const winnerSeed = ctx.bracket.players.find((p) => p.playerId === m.winnerId)?.seed ?? null;
  const loserId = m.playerA === m.winnerId ? m.playerB : m.playerA;
  const loserSeed = ctx.bracket.players.find((p) => p.playerId === loserId)?.seed ?? null;
  return underdogLabel(winnerSeed, loserSeed);
}

/** Деньги после матча: что каждый унесёт из этой встречи.
 *
 * Считается из тех же цен, которыми платит Rust: победа в матче, карты и
 * снятая голова. Проигравший при движке «за карты» уносит утешительные
 * карты — это видно и в итогах, и в таблице заработков. */
function matchMoneyAfter(
  ctx: AirContext,
  m: MatchState,
): MatchResultPayload['after'] {
  const prize = ctx.prize ?? null;
  const cfg = prize?.config ?? null;
  if (prize === null || cfg === null || m.winnerId === null || m.isWalkover) return null;

  const loserId = m.playerA === m.winnerId ? m.playerB : m.playerA;
  const winnerSeed =
    ctx.bracket.players.find((p) => p.playerId === m.winnerId)?.seed ?? null;
  const loserSeed = ctx.bracket.players.find((p) => p.playerId === loserId)?.seed ?? null;
  const key = `${m.bracket}:${m.round}`;

  // Цена победы: движок «за матчи» и надстройка выплат, со ступенью андердога.
  const step =
    cfg.addons.underdog && winnerSeed !== null && loserSeed !== null
      ? underdogStep(winnerSeed, loserSeed)
      : 1;
  let winPrice = 0;
  if (cfg.engine.kind === 'matches') {
    winPrice += prize.matchPrices.find((r) => r.key === key)?.price ?? 0;
  }
  if (cfg.addons.matchPayments !== null) {
    winPrice += prize.paymentPrices.find((r) => r.key === key)?.price ?? 0;
  }
  winPrice = Math.floor(winPrice * step);

  // Карты: победные по двойной цене, утешительные по одинарной.
  let winnerMaps = 0;
  let loserMaps = 0;
  if (cfg.engine.kind === 'maps' && prize.mapPrice !== null) {
    const discount = m.bracket === 'lower' ? Math.max(0, Math.min(100, cfg.engine.lowerDiscount)) / 100 : 1;
    const per = prize.mapPrice.unit * discount;
    const winMaps = m.winnerId === m.playerA ? m.scoreA : m.scoreB;
    const loseMaps = m.winnerId === m.playerA ? m.scoreB : m.scoreA;
    winnerMaps = Math.floor(winMaps * 2 * per);
    loserMaps = Math.floor(loseMaps * per);
  }

  // Голова, снятая в этом матче: последнее снятие баунти из этого матча.
  let headTaken = 0;
  const last = prize.lastBounty;
  if (last !== null && last.victimId === loserId && last.killerId === m.winnerId) {
    headTaken = last.taken;
  }

  const winnerTake = winPrice + winnerMaps + headTaken;
  const loserTake = loserMaps;
  if (winnerTake === 0 && loserTake === 0) return null;

  return {
    winnerTake,
    loserTake,
    winPrice,
    headTaken,
    winnerMaps,
    loserMaps,
  };
}

export function matchIntro(ctx: AirContext, m: MatchState): MatchIntroPayload {
  const a = sure(airPlayer(ctx, m.playerA));
  const b = sure(airPlayer(ctx, m.playerB));
  const versus = ctx.stats.get(a.id)?.versus.find((v) => v.playerId === b.id) ?? null;

  return {
    a,
    b,
    versusA: versus?.wins ?? 0,
    versusB: versus?.losses ?? 0,
    target: m.target,
    round: roundTitle(ctx, m),
  };
}

export function matchLive(ctx: AirContext, m: MatchState): MatchLivePayload {
  return {
    a: sure(airPlayer(ctx, m.playerA)),
    b: sure(airPlayer(ctx, m.playerB)),
    scoreA: m.scoreA + m.bonusA,
    scoreB: m.scoreB + m.bonusB,
    bonus: m.bonusA + m.bonusB,
    target: m.target,
    round: roundTitle(ctx, m),
    rows: m.rows.map(airRow),
    turn: airTurn(m, namer(ctx)),
    matchPoint: m.matchPoint,
    money: matchMoney(ctx, m),
  };
}

/** Карта, которую только что забанили: последний бан в журнале. */
export function banReveal(
  ctx: AirContext,
  m: MatchState,
): { map: AirMap; n: number; by: AirPlayer | null } | null {
  const last = lastN(m, 'ban');
  for (const row of m.rows) {
    if (row.state.kind !== 'banned' || row.state.n !== last) continue;
    // Номер бана считаем по порядку среди банов, а не по номеру в журнале:
    // в журнале лежат ещё пики и результаты.
    const order = m.actions.filter((a) => a.type === 'ban').findIndex((a) => a.n === last);
    return { map: rowMap(row), n: order + 1, by: airPlayer(ctx, row.state.by) };
  }
  return null;
}

export function pickReveal(ctx: AirContext, m: MatchState): { map: AirMap; by: AirPlayer | null } | null {
  const row = m.rows.find((r) => r.state.kind === 'playing');
  if (row === undefined || row.state.kind !== 'playing') return null;
  return { map: rowMap(row), by: airPlayer(ctx, row.state.by) };
}

/** Номер последнего действия нужного вида. */
function lastN(m: MatchState, type: 'ban' | 'pick' | 'result'): number {
  const list = m.actions.filter((a) => a.type === type);
  return list.length === 0 ? -1 : (list[list.length - 1]?.n ?? -1);
}

/**
 * Карта играется прямо сейчас. Время начала и длина берутся из лобби, если оно
 * подключено: у судьи этих данных нет вовсе, а без них полосы прогресса тоже нет.
 */
export function mapProgress(
  ctx: AirContext,
  m: MatchState,
  game: LobbyGame | null,
): MapProgressPayload | null {
  const row = m.rows.find((r) => r.state.kind === 'playing');
  if (row === undefined) return null;

  const map = rowMap(row);
  const length = game?.totalLength ?? map.length;
  const startedAt = game?.startTime ?? null;
  if (length === null || startedAt === null) return null;

  // Длина из лобби приходит без учёта мода — считаем её той же формулой.
  const rate = game !== null && game.mods.some((x) => x === 'DT' || x === 'NC') ? 1.5 : 1;

  return {
    map,
    a: sure(airPlayer(ctx, m.playerA)),
    b: sure(airPlayer(ctx, m.playerB)),
    scoreA: m.scoreA + m.bonusA,
    scoreB: m.scoreB + m.bonusB,
    startedAt,
    length: Math.round(length / rate),
    money: matchMoney(ctx, m),
  };
}

/**
 * Результат карты. Цифры приходят из лобби; без него остаётся победитель,
 * и сцена показывает счёт по картам без очков.
 */
export function mapResult(
  ctx: AirContext,
  m: MatchState,
  game: LobbyGame | null,
): MapResultPayload | null {
  // Последняя сыгранная строка — та, чей результат стоит позже всех в журнале.
  const last = lastN(m, 'result');
  const row = m.rows.find((r) => r.state.kind === 'played' && r.state.n === last);
  if (row === undefined || row.state.kind !== 'played') return null;

  const a = sure(airPlayer(ctx, m.playerA));
  const b = sure(airPlayer(ctx, m.playerB));

  return {
    map: rowMap(row),
    winner: airPlayer(ctx, row.state.winner),
    scores: game === null ? [] : lobbyScores(game, [a, b]),
    scoreA: m.scoreA + m.bonusA,
    scoreB: m.scoreB + m.bonusB,
    a,
    b,
    money: matchMoney(ctx, m),
    underdog: matchUnderdog(ctx, m),
  };
}

/**
 * Скоры из лобби, сопоставленные с игроками турнира.
 *
 * Сопоставление идёт по `osuUserId`: в лобби игрок может сидеть под другим
 * ником. Кого сопоставить не удалось, в кадр не попадает — судья при этом
 * выбирает победителя руками, и сцена от этого не ломается.
 */
function lobbyScores(game: LobbyGame, sides: AirPlayer[]): AirScore[] {
  const out: AirScore[] = [];
  for (const side of sides) {
    if (side.osuUserId === null) continue;
    const score = game.scores.find((s) => s.userId === side.osuUserId);
    if (score === undefined) continue;
    out.push({
      playerId: side.id,
      nick: side.nick,
      color: side.color,
      score: score.totalScore,
      // API отдаёт долю, а в кадре нужны проценты.
      accuracy: score.accuracy === null ? null : score.accuracy * 100,
      combo: score.maxCombo,
      miss: score.miss,
      rank: score.rank,
      mods: score.mods,
    });
  }
  // Первым идёт победитель карты: корона должна стоять сверху.
  return out.sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
}

export function matchResult(ctx: AirContext, m: MatchState): MatchResultPayload | null {
  const winner = airPlayer(ctx, m.winnerId);
  if (winner === null) return null;

  const a = sure(airPlayer(ctx, m.playerA));
  const b = sure(airPlayer(ctx, m.playerB));
  const loser = winner.id === a.id ? b : a;

  return {
    a,
    b,
    scoreA: m.scoreA + m.bonusA,
    scoreB: m.scoreB + m.bonusB,
    winner,
    walkover: m.isWalkover,
    winnerGoes: whereNext(ctx, m.nextWinSlot),
    // Проигравший в верхней падает в нижнюю, а в нижней — из турнира. Если
    // матч по ссылке не нашёлся, говорим хотя бы куда: молча терять строку
    // «куда пошёл» нельзя, ради неё сцена и существует.
    loserGoes:
      m.nextLoseSlot === null
        ? `${loser.nick} вылетает`
        : (whereNext(ctx, m.nextLoseSlot) ?? 'в нижнюю сетку'),
    round: roundTitle(ctx, m),
    underdog: matchUnderdog(ctx, m),
    after: matchMoneyAfter(ctx, m),
  };
}

function whereNext(ctx: AirContext, matchId: number | null): string | null {
  if (matchId === null) return null;
  const next = ctx.bracket.matches.find((x) => x.id === matchId);
  return next === undefined ? null : roundTitle(ctx, next);
}

// ─────────────────────────────────────────────────────── сцены паузы

/**
 * Сетка целиком. Координат в кадре нет: колонки раскладывает сама сцена, а путь
 * прошедшего дальше читается по подсветке его ячеек в его цвете.
 */
export function bracketScene(ctx: AirContext): BracketPayload {
  // Раскладка та же, что в приложении: сетка в эфире должна быть той же самой,
  // а не похожей. Масштаб крупнее — кадр в 1920 смотрят с дивана.
  const layout = layoutBracket(ctx.bracket.matches);
  const byId = new Map(ctx.bracket.players.map((p) => [p.playerId, p]));

  const cards: AirBracketCard[] = layout.shown.map((m) => ({
    id: m.id,
    x: layout.colX(layout.columnOf(m)) * K,
    y: layout.topOf(m) * K,
    w: COL_W * K,
    h: CARD_H * K,
    a: bracketSide(ctx, m, 'a'),
    b: bracketSide(ctx, m, 'b'),
    done: m.status === 'finished',
    live: m.status === 'running',
  }));

  const links: AirBracketLink[] = layout.links.map((l) => ({
    key: l.key,
    d: scalePath(l.d, K),
    drop: l.drop,
    color: l.playerId === null ? null : (byId.get(l.playerId)?.color ?? null),
  }));

  const heads: AirBracketHead[] = layout.heads.map((h) => ({
    key: h.key,
    title: headTitle(ctx, h),
    x: h.x * K,
    y: h.y * K,
    w: COL_W * K,
  }));

  const width = layout.width * K;
  const height = layout.height * K;

  return { width, height, cards, links, heads, stops: cameraStops(cards, width, height) };
}

/** Насколько сетка эфира крупнее сетки приложения. */
const K = 2.1;

/** Часть кадра под сетку: заголовок сцены сверху занимает своё. */
const VIEW_W = 1920 - 2 * 72;
const VIEW_H = 1080 - 250;

/**
 * Наименьший масштаб, при котором ник в карточке ещё читается с дивана.
 *
 * От него зависит всё остальное: сетка, которая не влезает в кадр при этом
 * масштабе, показывается не целиком, а по частям.
 */
const MIN_SCALE = 0.62;

/** Воздух вокруг остановки: карточки не должны упираться в край кадра. */
const PAD = 56;

/**
 * Разрыв по вертикали, после которого начинается другой ряд сетки.
 *
 * Верхняя и нижняя сетки стоят на разной высоте, и показывать их одной
 * остановкой значит не показать ни одной: масштаб упадёт вдвое.
 */
const BAND_GAP = CARD_H * K;

/**
 * Маршрут камеры по сетке.
 *
 * Мелкая сетка встаёт в кадр целиком — по ней и ходить незачем. Крупная в кадр
 * не влезает: если её всё же вписать, ники станут нечитаемыми, поэтому камера
 * идёт по ней рядами и колонками. Соседние остановки делят колонку — иначе
 * связь между ними обрывается ровно на стыке.
 *
 * Пустые раунды камера не посещает: на старте турнира в полуфинале никого
 * нет, и остановка на пустых карточках — поездка в никуда. Живой для камеры
 * кусок — где есть игрок, идущий матч или сыгранный матч: к пустому она
 * вернётся, когда туда кто-то дойдёт.
 */
function cameraStops(cards: AirBracketCard[], width: number, height: number): AirBracketStop[] {
  const whole: AirBracketStop = { x: 0, y: 0, w: width, h: height, cards: [] };
  if (cards.length === 0) return [whole];
  if (Math.min(VIEW_W / width, VIEW_H / height) >= MIN_SCALE) return [whole];

  // Живые карточки: в них есть игрок, они идут или уже сыграны.
  const alive = cards.filter((c) => c.live || c.done || c.a !== null || c.b !== null);
  if (alive.length === 0) return [whole];

  const stops: AirBracketStop[] = [];
  for (const band of bands(alive)) {
    for (const chunk of columnChunks(band)) {
      const left = Math.min(...chunk.map((c) => c.x));
      const right = Math.max(...chunk.map((c) => c.x + c.w));
      const top = Math.min(...chunk.map((c) => c.y));
      const bottom = Math.max(...chunk.map((c) => c.y + c.h));

      stops.push({
        x: Math.max(0, left - PAD),
        y: Math.max(0, top - PAD * 2),
        w: right - left + PAD * 2,
        h: bottom - top + PAD * 3,
        cards: chunk.filter((c) => c.live).map((c) => c.id),
      });
    }
  }

  // Сперва обзор целиком: зритель должен увидеть, куда мы идём, и только
  // потом ехать по частям.
  return stops.length === 0 ? [whole] : [whole, ...stops];
}

/** Ряды сетки по вертикали: верхняя, под ней нижняя. */
function bands(cards: AirBracketCard[]): AirBracketCard[][] {
  const sorted = [...cards].sort((x, y) => x.y - y.y);
  const out: AirBracketCard[][] = [];
  let current: AirBracketCard[] = [];
  let edge = Number.NEGATIVE_INFINITY;

  for (const card of sorted) {
    if (current.length > 0 && card.y > edge + BAND_GAP) {
      out.push(current);
      current = [];
    }
    current.push(card);
    edge = Math.max(edge, card.y + card.h);
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Колонки ряда, собранные в куски по ширине кадра. */
function columnChunks(band: AirBracketCard[]): AirBracketCard[][] {
  const xs = [...new Set(band.map((c) => c.x))].sort((x, y) => x - y);
  const maxWidth = VIEW_W / MIN_SCALE;
  const out: AirBracketCard[][] = [];
  let from = 0;

  while (from < xs.length) {
    const left = xs[from] ?? 0;
    let to = from;

    while (to + 1 < xs.length) {
      const next = xs[to + 1] ?? 0;
      const inside = band.filter((c) => c.x >= left && c.x <= next);
      const right = Math.max(...inside.map((c) => c.x + c.w));
      if (right - left > maxWidth) break;
      to += 1;
    }

    const edge = xs[to] ?? 0;
    out.push(band.filter((c) => c.x >= left && c.x <= edge));
    if (to >= xs.length - 1) break;
    // Перекрытие в одну колонку. `to > from` всегда, кроме одной слишком
    // широкой колонки — тогда шагаем вперёд, чтобы не встать намертво.
    from = to > from ? to : from + 1;
  }

  return out;
}

/** Сдвиг и растяжение готового пути SVG. Путь состоит только из M, H и V. */
function scalePath(d: string, k: number): string {
  return d
    .trim()
    .split(/\s+/)
    .map((token) => {
      const value = Number(token);
      return Number.isFinite(value) ? String(Math.round(value * k * 100) / 100) : token;
    })
    .join(' ');
}

/** Подпись колонки: та же, что на сетке приложения. */
function headTitle(ctx: AirContext, head: { side: BracketSide; round: number; lastRound: number }): string {
  const own = ctx.editor.rounds.find((r) => r.bracket === head.side && r.round === head.round);
  if (own !== undefined) return own.title;
  if (head.side === 'grand') return 'Гранд-финал';
  const left = head.lastRound - head.round;
  if (left === 0) return head.side === 'upper' ? 'Финал верхней' : 'Финал нижней';
  if (left === 1) return 'Полуфинал';
  return `Раунд ${head.round}`;
}

/** Сторона матча в сетке: кто сидит и с каким счётом. */
function bracketSide(ctx: AirContext, m: Match, seat: 'a' | 'b'): AirBracketSide | null {
  const playerId = seat === 'a' ? m.playerA : m.playerB;
  const score = seat === 'a' ? m.scoreA + m.bonusA : m.scoreB + m.bonusB;
  const p = airPlayer(ctx, playerId);

  if (p === null) {
    // Пустое место без объяснения — самое непонятное в сетке. Считаем по
    // обратным ссылкам: кто должен сюда приехать.
    const from = ctx.bracket.matches.filter(
      (x) => x.status !== 'finished' && (x.nextWinSlot === m.id || x.nextLoseSlot === m.id),
    );
    const which = seat === 'a' ? 0 : m.playerA === null ? 1 : 0;
    const source = from[which] ?? null;
    return {
      nick: '',
      color: '#2a2f3d',
      score: 0,
      won: false,
      waiting:
        source === null
          ? 'ждёт соперника'
          : source.nextWinSlot === m.id
            ? `победитель ${shortName(source)}`
            : `проигравший ${shortName(source)}`,
    };
  }

  return {
    nick: p.nick,
    color: p.color,
    score,
    won: m.winnerId !== null && m.winnerId === playerId,
    waiting: null,
  };
}

const SIDE_SHORT: Record<BracketSide, string> = { upper: 'ВС', lower: 'НС', grand: 'ГФ' };

const shortName = (m: Match): string =>
  `${SIDE_SHORT[m.bracket]} R${m.round}-${m.slotInBracket + 1}`;

export function standings(ctx: AirContext): StandingsPayload {
  const rows = ctx.bracket.players.map((p) => {
    const losses = ctx.bracket.matches.filter(
      (m) => m.status === 'finished' && m.winnerId !== null && m.winnerId !== p.playerId &&
        (m.playerA === p.playerId || m.playerB === p.playerId),
    ).length;
    const global = ctx.players.find((x) => x.id === p.playerId) ?? null;
    return {
      nick: p.nickname,
      color: p.color,
      osuUserId: global?.osuUserId ?? null,
      place: p.placement,
      losses,
      // В двойной сетке из турнира выбывают со второго поражения.
      out: p.placement !== null && p.placement > 1,
    };
  });

  // Кто ещё в игре — сверху, вылетевшие — по местам.
  rows.sort((x, y) => {
    if (x.out !== y.out) return x.out ? 1 : -1;
    return (x.place ?? 99) - (y.place ?? 99);
  });
  return { rows };
}

export function nextUp(ctx: AirContext): NextUpPayload {
  const ready = ctx.bracket.matches
    .filter((m) => m.status !== 'finished')
    .sort((x, y) => sortKey(x) - sortKey(y));

  const line = (m: Match) => ({
    round: roundTitle(ctx, m),
    a: airPlayer(ctx, m.playerA),
    b: airPlayer(ctx, m.playerB),
  });

  const first = ready[0];
  return {
    next: first === undefined ? null : line(first),
    then: ready.slice(1, 3).map(line),
  };
}

/** Порядок матчей: сначала те, где оба участника известны. */
function sortKey(m: Match): number {
  const side = m.bracket === 'upper' ? 0 : m.bracket === 'lower' ? 1 : 2;
  const ready = m.playerA !== null && m.playerB !== null ? 0 : 1000;
  return ready + side * 100 + m.round * 10 + m.slotInBracket;
}

export function playerCard(ctx: AirContext, playerId: number): PlayerCardPayload | null {
  const player = airPlayer(ctx, playerId);
  const stats = ctx.stats.get(playerId);
  if (player === null || stats === undefined) return null;

  const profile = player.osuUserId === null ? null : ctx.profiles.get(player.osuUserId) ?? null;

  return {
    player,
    // Игрок без привязки к профилю показывается только со своей статистикой:
    // пустых полей в кадре не остаётся.
    osu:
      profile === null
        ? null
        : {
            pp: profile.pp,
            globalRank: profile.globalRank,
            countryRank: profile.countryRank,
            accuracy: profile.accuracy,
            playCount: profile.playCount,
          },
    tournaments: stats.tournaments,
    tournamentWins: stats.tournamentWins,
    matches: stats.matches,
    matchWins: stats.matchWins,
    maps: stats.maps,
    mapWins: stats.mapWins,
    bestMod: stats.bestMod,
    worstMod: stats.worstMod,
  };
}

// ────────────────────────────────────────── итоги по журналам матчей

/** Сколько раз карту играли и банили. Ключ — id карты. */
interface MapTally {
  map: AirMap;
  played: number;
  banned: number;
}

/** Разбор журналов сыгранных матчей. Считается один раз на паузу. */
export interface Tally {
  maps: MapTally[];
  /** Самая близкая карта, длинная серия, быстрый матч, забаненная карта. */
  records: RecordsPayload['items'];
}

export function buildTally(ctx: AirContext): Tally {
  const byMap = new Map<string, MapTally>();

  for (const m of ctx.logs) {
    for (const row of m.rows) {
      const map = rowMap(row);
      const key = `${row.slotLabel}|${map.title}`;
      const tally = byMap.get(key) ?? { map, played: 0, banned: 0 };

      if (row.state.kind === 'played') {
        tally.played += 1;
      } else if (row.state.kind === 'banned') {
        tally.banned += 1;
      }
      byMap.set(key, tally);
    }
  }

  const maps = [...byMap.values()].sort((x, y) => y.played + y.banned - (x.played + x.banned));
  return { maps, records: records(ctx, maps) };
}

function records(ctx: AirContext, maps: MapTally[]): RecordsPayload['items'] {
  const items: RecordsPayload['items'] = [];

  // Самая забаненная карта.
  const mostBanned = [...maps].sort((x, y) => y.banned - x.banned)[0];
  if (mostBanned !== undefined && mostBanned.banned > 0) {
    items.push({
      title: 'Чаще всех банят',
      value: mostBanned.map.title,
      note: `${mostBanned.banned} ${plural(mostBanned.banned, 'раз', 'раза', 'раз')} · ${mostBanned.map.slot}`,
    });
  }

  // Самый близкий матч: минимальная разница в счёте среди доигранных.
  const closest = ctx.logs
    .filter((m) => m.winnerId !== null && !m.isWalkover)
    .sort(
      (x, y) =>
        Math.abs(x.scoreA - x.scoreB) - Math.abs(y.scoreA - y.scoreB) ||
        y.scoreA + y.scoreB - (x.scoreA + x.scoreB),
    )[0];
  if (closest !== undefined) {
    items.push({
      title: 'Самый близкий матч',
      value: `${closest.scoreA + closest.bonusA}:${closest.scoreB + closest.bonusB}`,
      note: roundTitle(ctx, closest),
    });
  }

  // Самая длинная серия побед по картам — считается по итогам турнира.
  const streak = [...ctx.bracket.standings].sort((x, y) => y.bestStreak - x.bestStreak)[0];
  if (streak !== undefined && streak.bestStreak > 1) {
    items.push({
      title: 'Самая длинная серия',
      value: `${streak.nickname} — ${streak.bestStreak} ${plural(streak.bestStreak, 'карта', 'карты', 'карт')}`,
      note: 'подряд',
    });
  }

  // Самый быстрый матч по времени между началом и концом.
  const fastest = ctx.logs
    .filter((m) => m.startedAt !== null && m.finishedAt !== null && !m.isWalkover)
    .map((m) => ({ m, secs: span(m.startedAt, m.finishedAt) }))
    .filter((x) => x.secs > 0)
    .sort((x, y) => x.secs - y.secs)[0];
  if (fastest !== undefined) {
    items.push({
      title: 'Самый быстрый матч',
      value: formatSpan(fastest.secs),
      note: roundTitle(ctx, fastest.m),
    });
  }

  return items;
}

function span(from: string | null, to: string | null): number {
  if (from === null || to === null) return 0;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 1000);
}

/** Подробная статистика турнира — сцена «Цифры турнира».
 *
 * Отдельно от «Рекордов»: рекорды — про исключительное (самый быстрый, самый
 * близкий), а здесь — про массу: сколько сыграли, чем играли, кто сейчас
 * впереди по картам. Всё считается по журналам и standings — то, что
 * подводка озвучила бы между матчами. */
export function stats(ctx: AirContext): StatsPayload | null {
  const finished = ctx.bracket.matches.filter((m) => m.status === 'finished');
  if (finished.length === 0) return null;

  // Карты — по журналам: строка «сыграна» это один игровой заход.
  const mods = new Map<string, number>();
  let maps = 0;
  let longest: { title: string; version: string; length: number } | null = null;
  for (const log of ctx.logs) {
    for (const row of log.rows) {
      if (row.state.kind !== 'played') continue;
      maps += 1;
      mods.set(row.mod, (mods.get(row.mod) ?? 0) + 1);
      const m = rowMap(row);
      if (m.length !== null && (longest === null || m.length > longest.length)) {
        longest = { title: m.title, version: m.version, length: m.length };
      }
    }
  }

  // Средняя длина матча — в картах, а не в минутах: минута зависит от пауз
  // и лагов лобби, а карта — единица игры.
  const perMatch = maps / Math.max(1, finished.length);
  const avgMatch = `${perMatch.toFixed(1)} ${plural(Math.round(perMatch), 'карта', 'карты', 'карт')} за матч`;

  const top = [...ctx.bracket.standings]
    .sort((x, y) => y.mapWins - x.mapWins || y.matchWins - x.matchWins)
    .slice(0, 5)
    .map((row) => ({
      nick: row.nickname,
      color: row.color,
      osuUserId: ctx.players.find((p) => p.id === row.playerId)?.osuUserId ?? null,
      maps: row.mapWins,
      matches: row.matchWins,
    }))
    .filter((row) => row.maps > 0 || row.matches > 0);

  return {
    matches: { played: finished.length, total: ctx.bracket.matches.length },
    maps,
    avgMatch,
    longest,
    mods: [...mods.entries()]
      .map(([mod, count]) => ({ mod, count }))
      .sort((x, y) => y.count - x.count),
    top,
  };
}


export function champion(ctx: AirContext): ChampionPayload | null {
  const podium = ctx.bracket.standings.filter((s) => s.placement <= 3);
  if (podium.length === 0) return null;

  return {
    podium: podium.map((s: Standing) => ({
      place: s.placement,
      nick: s.nickname,
      color: s.color,
      osuUserId: ctx.players.find((p) => p.id === s.playerId)?.osuUserId ?? null,
      matches: `${s.matchWins}—${s.matchLosses}`,
      maps: `${s.mapWins}—${s.mapLosses}`,
      // Пьедестал берёт выплаты из призового фонда — это модель, а не настройка.
      earned: ctx.prize === null ? null : earnedOf(ctx, s.playerId),
    })),
  };
}

export function credits(ctx: AirContext): CreditsPayload {
  const rows = [...ctx.bracket.players]
    .sort((x: TournamentPlayer, y: TournamentPlayer) => (x.placement ?? 99) - (y.placement ?? 99))
    .map((p) => ({ place: p.placement, nick: p.nickname, color: p.color }));

  return {
    tournament: ctx.bracket.name,
    duration: formatSpan(span(ctx.bracket.createdAt, ctx.bracket.finishedAt)),
    rows,
    // Организаторы, судьи, ссылки и соцсети контекст не знает: их знает только
    // эфир. Стор дополняет их из настроек — здесь они пустые, чтобы тип сходился.
    organizers: [],
    judges: [],
    links: [],
    socials: [],
  };
}

/** «3:18» для подписи длины карты — тот же формат, что в приложении. */
export const mapLength = formatLength;

// ──────────────────────────────────────────────── сцены про деньги

/**
 * Табло фонда: как деньги распределены и кто сколько уже заработал.
 *
 * Схема собирается из конфига движка и надстроек — «за что вообще платят»,
 * а не суммы настроек: игроку важно, что он может получить, а не чем
 * организатор щёлкал в редакторе.
 */
export function fundBoard(ctx: AirContext): FundBoardPayload | null {
  const prize = ctx.prize;
  if (prize === null) return null;

  const scheme: FundBoardRow[] = [];
  const money = (n: number) => n;

  if (prize.config.engine.kind === 'places') {
    prize.config.engine.shares.forEach((share, i) => {
      if (i >= prize.ladder.length) return;
      scheme.push({
        title: `${i + 1} место`,
        note: `${share}%`,
        amount: money(prize.ladder[i]?.guarantee ?? 0),
        kind: 'places',
      });
    });
  } else if (prize.config.engine.kind === 'matches') {
    prize.matchPrices.forEach((r) => {
      if (r.price <= 0) return;
      scheme.push({
        title: `Победа · ${r.title}`,
        note: r.matches > 1 ? `${r.matches} матча` : null,
        amount: money(r.price),
        kind: 'matches',
      });
    });
  } else if (prize.config.engine.kind === 'bounty') {
    // Охота: строки — головы по сидам, изначальные, до снятий.
    prize.config.engine.shares.forEach((share, i) => {
      const amount = Math.floor((prize.engineShare * share) / 100);
      if (amount <= 0) return;
      scheme.push({
        title: `Голова ${i + 1} сида`,
        note: prize.config.engine.rollover ? 'с перекатом' : 'выбил — забрал',
        amount: money(amount),
        kind: 'bounty',
      });
    });
  } else if (prize.mapPrice !== null) {
    scheme.push({
      title: 'Карта в победном матче',
      note: null,
      amount: money(prize.mapPrice.win),
      kind: 'maps',
    });
    scheme.push({
      title: 'Карта в проигранном матче',
      note: 'играешь — зарабатываешь',
      amount: money(prize.mapPrice.loss),
      kind: 'maps',
    });
  }

  if (prize.config.addons.matchPayments !== null) {
    prize.paymentPrices.forEach((r) => {
      if (r.price <= 0) return;
      scheme.push({
        title: `Матч · ${r.title}`,
        note: r.matches > 1 ? `${r.matches} матча` : null,
        amount: money(r.price),
        kind: 'matches',
      });
    });
  }

  const heads = prize.heads.reduce((a, h) => a + h.amount, 0);
  if (prize.config.addons.bounty !== null && heads > 0) {
    scheme.push({
      title: 'Деньги на голове',
      note: prize.heads.map((h) => h.nickname).join(', '),
      amount: money(heads),
      kind: 'bounty',
    });
  }
  if (prize.config.addons.rookieRace !== null) {
    scheme.push({
      title: 'Гонка новичков',
      note: 'вторая таблица',
      amount: money(prize.config.addons.rookieRace),
      kind: 'rookie',
    });
  }

  if (prize.config.addons.spectator !== null) {
    scheme.push({
      title: 'Зрительский банк',
      note: 'лучший матч',
      amount: money(prize.config.addons.spectator),
      kind: 'spectator',
    });
  }

  if (prize.remainder > 0) {
    scheme.push({
      title: 'Остаток',
      note: prize.config.addons.jackpot ? 'уезжает в джекпот' : null,
      amount: money(prize.remainder),
      kind: 'jackpot',
    });
  }

  const earned = prize.rows
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 8)
    .map((r) => ({
      nick: r.nickname,
      color: r.color,
      osuUserId: ctx.players.find((p) => p.id === r.playerId)?.osuUserId ?? null,
      amount: r.total,
    }));

  return {
    fund: prize.fundEffective,
    paid: prize.rows.reduce((a, r) => a + r.total, 0),
    scheme,
    earned,
    remainder: prize.remainder,
  };
}

/** Деньги на голове — врезка перед матчем: что висит на каждом.
 *
 * Работает и для надстройки баунти, и для движка охоты: головы в виде одни. */
export function bountyHeads(ctx: AirContext, m: MatchState): BountyHeadsPayload | null {
  const prize = ctx.prize;
  if (prize === null) return null;
  const hasBounty =
    prize.config.addons.bounty !== null || prize.config.engine.kind === 'bounty';
  if (!hasBounty) return null;
  const a = airPlayer(ctx, m.playerA);
  const b = airPlayer(ctx, m.playerB);
  if (a === null || b === null) return null;

  const headOf = (id: number) =>
    prize.heads.find((h) => h.playerId === id)?.amount ?? 0;
  if (headOf(a.id) === 0 && headOf(b.id) === 0) return null;

  return { a, b, headA: headOf(a.id), headB: headOf(b.id) };
}

/** Баунти снято: последнее снятие, если оно из этого матча. */
export function bountyTaken(
  ctx: AirContext,
  m: MatchState,
): BountyTakenPayload | null {
  const prize = ctx.prize;
  if (prize === null || prize.lastBounty === null) return null;
  const { lastBounty } = prize;

  const loserId = m.playerA === m.winnerId ? m.playerB : m.playerA;
  if (lastBounty.victimId !== loserId) return null;

  const killer = airPlayer(ctx, lastBounty.killerId);
  const victim = airPlayer(ctx, lastBounty.victimId);
  if (killer === null || victim === null) return null;

  return { killer, victim, taken: lastBounty.taken, moved: lastBounty.moved };
}

/** Гонка новичков: вторая таблица отдельной сценой. */
export function rookieRace(ctx: AirContext): RookieRacePayload | null {
  const prize = ctx.prize;
  const amount = prize?.config.addons.rookieRace ?? null;
  if (prize === null || amount === null) return null;

  const rows = prize.rookieRows.map((r) => {
    const player = ctx.bracket.players.find((p) => p.playerId === r.playerId);
    return {
      nick: r.nickname,
      color: r.color,
      osuUserId: ctx.players.find((p) => p.id === r.playerId)?.osuUserId ?? null,
      place: player?.placement ?? null,
      out: r.status === 'out',
    };
  });
  if (rows.length < 2) return null;

  return { amount, rows };
}

/** Зрительский банк: за что голосуют и кто взял. */
export function spectatorBank(ctx: AirContext): SpectatorBankPayload | null {
  const prize = ctx.prize;
  const amount = prize?.config.addons.spectator ?? null;
  if (prize === null || amount === null) return null;

  return {
    amount,
    note: 'приз за лучший матч вечера — отмечает хост',
    best: prize.bestMatch?.label ?? null,
  };
}

/** Джекпот: сколько переедет в следующий турнир. */
export function jackpotScene(ctx: AirContext): JackpotPayload | null {
  const prize = ctx.prize;
  if (prize === null || !prize.config.addons.jackpot) return null;
  return {
    projected: Math.max(0, prize.remainder),
    current: prize.jackpotNow,
  };
}

// ────────────────────────────────────────────────── трейлеры турнира

/** Формат турнира словами: сетка, участники, счёт матча. */
function formatOf(ctx: AirContext): string {
  const double = ctx.bracket.matches.some((m) => m.bracket === 'lower');
  const grid = double ? 'двойная выбывание' : 'сетка на вылет';
  const players = ctx.bracket.players.length;
  const target = ctx.bracket.targetScore.default;
  return `${grid} · ${players} участников · до ${target} побед в матче`;
}

/** Трейлер-название: что за турнир, формат и чем играют. */
export function trailerTitle(ctx: AirContext): TrailerTitlePayload | null {
  if (ctx.bracket.players.length < 2) return null;

  const poolNames = [
    ...new Set(
      ctx.editor.rounds
        .map((r) => r.playingPoolName)
        .filter((name): name is string => name !== null && name !== ''),
    ),
  ];
  const poolIds = new Set(
    ctx.editor.rounds
      .map((r) => r.playingPoolId)
      .filter((id): id is number => id !== null),
  );
  const maps = ctx.pools
    .filter((p) => poolIds.has(p.id))
    .reduce((a, p) => a + p.slots.length, 0);

  return {
    tournament: ctx.bracket.name,
    format: formatOf(ctx),
    pools: poolNames,
    maps,
  };
}

/** Трейлер-участники: все игроки, камера едет по списку. */
export function trailerPlayers(ctx: AirContext): TrailerPlayersPayload | null {
  const rows = ctx.bracket.players
    .slice()
    .sort((a, b) => (a.seed ?? 99) - (b.seed ?? 99))
    .map((p) => ({
      nick: p.nickname,
      color: p.color,
      osuUserId: ctx.players.find((x) => x.id === p.playerId)?.osuUserId ?? null,
      seed: p.seed,
      rookie: p.isRookie,
    }));
  if (rows.length < 2) return null;
  return { tournament: ctx.bracket.name, rows };
}

/** Трейлер-кону: фонд и его устройство. */
export function trailerStakes(ctx: AirContext): TrailerStakesPayload | null {
  const prize = ctx.prize;
  const scheme: { title: string; note: string | null; amount: number }[] = [];

  if (prize !== null) {
    const cfg = prize.config;
    switch (cfg.engine.kind) {
      case 'places':
        scheme.push({
          title: 'Места',
          note: `платят первые ${cfg.engine.shares.length}`,
          amount: prize.engineShare,
        });
        break;
      case 'matches':
        scheme.push({
          title: 'Победы в матчах',
          note: 'ближе к финалу — дороже',
          amount: prize.engineShare,
        });
        break;
      case 'maps':
        scheme.push({
          title: 'Каждая карта',
          note: 'живой счётчик',
          amount: prize.engineShare,
        });
        break;
      case 'bounty':
        scheme.push({
          title: 'Охота за головами',
          note: cfg.engine.rollover ? 'с перекатом' : 'выбил — забрал',
          amount: prize.engineShare,
        });
        break;
    }
    if (cfg.addons.bounty !== null) {
      scheme.push({
        title: 'Деньги на голове',
        note: 'снимает победитель',
        amount: cfg.addons.bounty.amounts.reduce((a, b) => a + b, 0),
      });
    }
    if (cfg.addons.matchPayments !== null) {
      scheme.push({
        title: 'Выплаты за матчи',
        note: 'поверх движка',
        amount: cfg.addons.matchPayments.amount,
      });
    }
    if (cfg.addons.rookieRace !== null) {
      scheme.push({ title: 'Гонка новичков', note: 'отдельный зачёт', amount: cfg.addons.rookieRace });
    }
    if (cfg.addons.spectator !== null) {
      scheme.push({ title: 'Зрительский банк', note: 'лучший матч', amount: cfg.addons.spectator });
    }
  }

  return {
    tournament: ctx.bracket.name,
    fund: prize?.fundEffective ?? null,
    scheme,
    format: formatOf(ctx),
  };
}
