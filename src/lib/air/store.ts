// Стор эфира. Здесь живёт то, что ведёт трансляцию: очередь предложений,
// текущий кадр, плейлист паузы и таймеры.
//
// Он не привязан к экрану пульта нарочно: хост судит матч на одном экране, а
// эфир должен идти сам. Поэтому стор сам опрашивает идущий матч и сам решает,
// что показать, а пульт только рисует то, что здесь уже посчитано.

import { create } from 'zustand';
import * as ipc from '@/lib/ipc';
import { roundKey, type MatchState } from '@/lib/types';
import { isMatchScene, sceneMeta, MATCH_LIST, PAUSE_LIST } from './catalog';
import * as director from './director';
import type { Proposal } from './director';
import * as build from './payload';
import type { AirContext } from './payload';
import { buildPlaylist, type Candidate, type Playlist } from './playlist';
import {
  DEFAULT_CONFIG,
  type AirConfig,
  type AirLayer,
  type AirProbe,
  type AirStatus,
  type LobbyGame,
  type LobbyUpdate,
  type SceneId,
  type SceneShow,
} from './types';

/** Как часто стор смотрит на матч и на таймеры кадра. */
const TICK = 400;

/**
 * Как часто перечитывается сетка.
 *
 * Реже тика нарочно: сетка тянет за собой итоги и проверки правил, и делать это
 * дважды в секунду незачем. Но и совсем не перечитывать нельзя — матч мог
 * начаться уже после того, как эфир прочитал турнир, и тогда он был бы для
 * эфира невидим.
 */
const BRACKET_EVERY = 2000;

/** Глубина очереди предложений. Четвёртое выталкивает самое старое. */
const QUEUE_DEPTH = 3;

/** Что сейчас в эфире с точки зрения хоста. */
interface Airing {
  id: SceneId;
  objectKey: string;
  layers: AirLayer[];
  /** Куда уйти, когда кадр отыграет. Разрешается в момент перехода. */
  after: director.After;
}

/** Что известно про лобби идущего матча. */
interface LobbyState {
  matchId: number;
  roomId: number;
  games: LobbyGame[];
  currentGameId: number | null;
  error: string | null;
  at: string | null;
}

/**
 * Что выйдет следующим.
 *
 * Считается заранее и целиком, потому что «непонятно, что будет дальше» — это
 * не мелкое неудобство пульта, а причина, по которой хост смотрит в пульт
 * вместо матча. Строка здесь готовая: интерфейс её только показывает.
 */
export interface Plan {
  /** Что именно выйдет: «Результат NM2 — взял NAGISA». */
  label: string;
  /** Откуда взялось. */
  source: 'match' | 'pause' | 'hold' | 'none';
  /** Пояснение под строкой: почему это, а не другое. */
  note: string;
  /** Выйдет само, без нажатия. */
  automatic: boolean;
}

interface AirStore {
  tournamentId: number | null;
  config: AirConfig;
  status: AirStatus | null;
  shows: SceneShow[];
  probe: AirProbe | null;
  error: string | null;

  /** Доменные данные, из которых собираются кадры. */
  ctx: AirContext | null;
  /** Матч, за которым следим. */
  watching: MatchState | null;

  airing: Airing | null;
  proposals: Proposal[];
  /** Предложения, вытесненные из очереди. Пульт про это говорит, а не молчит. */
  overflow: number;
  /** Автоматика замерла на текущем кадре. */
  frozen: boolean;
  /**
   * Кадр стоит по решению хоста: плейлист паузы его не сменит.
   *
   * Нужно ровно для сцен без таймера. «Перерыв 10 минут» не должно смахнуть
   * следующей сценой через полсекунды только потому, что автопоказ включён.
   */
  hold: boolean;

  playlist: Playlist | null;
  playlistAt: number;
  /**
   * Плейлист паузы отыгран целиком. Дальше в эфире стоит заставка или отсчёт:
   * бюджет паузы на то и бюджет, чтобы эфир не растягивал турнир.
   */
  pauseDone: boolean;
  /** До какого момента идёт отсчёт. `null` — отсчёта нет. */
  countdownUntil: string | null;

  lobby: LobbyState | null;

  // ── настройка
  load: (tournamentId: number) => Promise<void>;
  patchConfig: (patch: Partial<AirConfig>) => Promise<void>;
  runProbe: () => Promise<void>;
  downloadTunnel: () => Promise<void>;

  // ── эфир
  start: () => Promise<void>;
  stop: () => Promise<void>;
  refreshStatus: () => Promise<void>;

  // ── вывод
  /** Выводит кадр в эфир. */
  air: (p: Proposal) => Promise<void>;
  /** Дальше по сценарию: первое предложение или следующая сцена паузы. */
  next: () => Promise<void>;
  /** Пропускает первое предложение. Оно не возвращается. */
  skip: () => void;
  /** Замереть на текущем кадре или отпустить автоматику. */
  freeze: (value: boolean) => void;
  /** Снимает кадр, пока его держит задержка. */
  revert: () => Promise<void>;
  /** Своя надпись в эфир. */
  say: (text: string) => Promise<void>;
  /** Отсчёт до следующего матча. Минуты. `null` — снять отсчёт. */
  setCountdown: (minutes: number | null) => void;
  /** Выводит выбранную заготовку руками. */
  pick: (id: SceneId, objectKey?: string) => Promise<void>;
  /** Что можно вывести прямо сейчас и почему нет. Только сцены паузы. */
  candidates: () => Candidate[];
  /** То же для сетки кнопок: сцены паузы и те сцены матча, что есть чем собрать. */
  manual: () => Candidate[];
  /** Что выйдет следующим. */
  plan: () => Plan;

  newCode: () => Promise<void>;
  clearShows: () => Promise<void>;
  /**
   * Турнир правят аварийно. Эфир на это время уходит в заставку: зрителю не
   * надо видеть, как пересобирается сетка.
   */
  setEditing: (value: boolean) => Promise<void>;
  /** Отвязывает пульт от турнира: выбрать другой можно, только пока эфира нет. */
  reset: () => void;

  /** Один шаг таймеров и опроса. Заводится сам при старте эфира. */
  tick: () => Promise<void>;
  /** Перечитывает доменные данные: сетку, состав, маппулы, журналы. */
  refreshContext: () => Promise<void>;
}

let timer: number | null = null;
let unlistenViewers: (() => void) | null = null;
let unlistenLobby: (() => void) | null = null;
/** Когда последний раз перечитывали сетку. */
let bracketAt = 0;

export const useAir = create<AirStore>((set, get) => ({
  tournamentId: null,
  config: DEFAULT_CONFIG,
  status: null,
  shows: [],
  probe: null,
  error: null,

  ctx: null,
  watching: null,

  airing: null,
  proposals: [],
  overflow: 0,
  frozen: false,
  hold: false,

  playlist: null,
  playlistAt: 0,
  pauseDone: false,
  countdownUntil: null,

  lobby: null,

  // ────────────────────────────────────────────────────────── настройка

  async load(tournamentId) {
    try {
      const [raw, shows, status] = await Promise.all([
        ipc.airConfig(tournamentId),
        ipc.airShows(tournamentId),
        ipc.airStatus(),
      ]);

      // Настройки прошлых версий могут не знать новых полей — добираем их
      // значениями по умолчанию, а не падаем на чужой форме.
      const saved = raw === null ? {} : (JSON.parse(raw) as Partial<AirConfig>);
      set({
        tournamentId,
        config: { ...DEFAULT_CONFIG, ...saved },
        shows,
        status,
        error: null,
      });

      await get().refreshContext();
      if (status.live) attachTimers(get);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async patchConfig(patch) {
    const id = get().tournamentId;
    const config = { ...get().config, ...patch };
    set({ config });
    if (id === null) return;
    try {
      await ipc.airSetConfig(id, JSON.stringify(config));
      // Задержку и счётчик зрителей эфир применяет на ходу.
      if (get().status?.live === true) {
        if (patch.delay !== undefined) await ipc.airSetDelay(patch.delay);
        if (patch.showViewers !== undefined) await ipc.airSetShowViewers(patch.showViewers);
        await get().refreshStatus();
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async runProbe() {
    try {
      set({ probe: await ipc.airProbe(), error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async downloadTunnel() {
    try {
      await ipc.airDownloadTunnel();
      await get().runProbe();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  // ───────────────────────────────────────────────────────────── эфир

  async start() {
    const { tournamentId, config, ctx } = get();
    if (tournamentId === null) return;

    try {
      const status = await ipc.airStart(
        tournamentId,
        ctx?.bracket.name ?? 'Турнир',
        config.publicLink,
        config.delay,
        config.showViewers,
      );
      set({ status, error: null, proposals: [], overflow: 0, frozen: false });

      // Эфир мог запуститься посреди турнира — это нормальный ход: заставка
      // до первого события, счётчики показов при этом не пустые. Заставка не
      // держит кадр: плейлист паузы сменит её на первом же тике.
      await place(get, set, 'idle', '', false);
      attachTimers(get);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async stop() {
    try {
      detachTimers();
      await ipc.airLobbyStop();
      set({ status: await ipc.airStop(), airing: null, proposals: [], lobby: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async refreshStatus() {
    try {
      set({ status: await ipc.airStatus() });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  // ──────────────────────────────────────────────────────────── вывод

  async air(p) {
    const { tournamentId } = get();
    try {
      await ipc.airScene(p.layers, null);
      set({ airing: { id: p.id, objectKey: p.objectKey, layers: p.layers, after: p.after } });

      // Показ отмечаем на выводе, а не на подборе: предложение могли пропустить.
      if (tournamentId !== null) {
        set({ shows: await ipc.airNoteShow(tournamentId, p.id, p.objectKey) });
      }
      await get().refreshStatus();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async next() {
    const { proposals } = get();
    // Нажали «дальше» — значит держать кадр больше не надо.
    set({ hold: false, pauseDone: false });

    const first = proposals[0];
    if (first !== undefined) {
      set({ proposals: proposals.slice(1) });
      await get().air(first);
      return;
    }
    // Замирание — это «не делай сам», а не «не слушай меня»: по кнопке кадр
    // выходит и на замороженном эфире.
    await advancePause(get, set, true);
  },

  skip() {
    // Пропущенное предложение не возвращается: это решение, а не отсрочка.
    set({ proposals: get().proposals.slice(1) });
  },

  freeze(value) {
    set({ frozen: value });
  },

  async revert() {
    try {
      await ipc.airRevert();
      await get().refreshStatus();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async say(text) {
    await get().patchConfig({ message: text });
    await get().pick('message');
  },

  setCountdown(minutes) {
    if (minutes === null) {
      set({ countdownUntil: null });
      return;
    }
    set({ countdownUntil: director.plusSeconds(minutes * 60), pauseDone: false });
    // Бюджет паузы теперь известен точно — плейлист пересобираем под него.
    rebuildPlaylist(get, set);
  },

  async pick(id, objectKey = '') {
    // Ручной вывод прерывает план: хост показал не то, что было в плане, и
    // собирать паузу дальше от старого места незачем.
    set({ playlist: null, playlistAt: 0, pauseDone: false });
    // Сцена без таймера, выведенная руками, стоит до следующего решения хоста:
    // «перерыв 10 минут» не должно смахнуть автопоказом через полсекунды.
    await place(get, set, id, objectKey, sceneMeta(id).timing === 'none');
  },

  candidates() {
    const state = get();
    return PAUSE_LIST.filter((m) => state.config.enabled.includes(m.id)).flatMap((m) =>
      objectsFor(state, m.id).map((objectKey) => candidate(state, m.id, objectKey)),
    );
  },

  manual() {
    const state = get();
    // Сцены матча идут первыми: вернуть матч в эфир — самое частое движение
    // хоста, и искать эту кнопку под статистикой он не должен.
    const match = MATCH_LIST.filter(
      (m) => state.config.enabled.includes(m.id) && buildScene(state, m.id, '') !== null,
    ).map((m) => candidate(state, m.id, ''));
    return [...match, ...state.candidates()];
  },

  plan() {
    const state = get();

    if (state.frozen) {
      return {
        label: 'кадр держится',
        source: 'hold',
        note: 'автоматика замерла — отпусти её или выведи кадр сам',
        automatic: false,
      };
    }

    const first = state.proposals[0];
    if (first !== undefined) {
      const rest = state.proposals.length - 1;
      return {
        label: first.label,
        source: 'match',
        note:
          state.config.mode === 'auto'
            ? rest > 0
              ? `выйдет сам · за ним ещё ${rest}`
              : 'выйдет сам'
            : rest > 0
              ? `ждёт кнопки · за ним ещё ${rest}`
              : 'ждёт кнопки',
        automatic: state.config.mode === 'auto',
      };
    }

    if (state.hold) {
      return {
        label: 'кадр стоит',
        source: 'hold',
        note: 'выведен руками и не уйдёт сам — нажми «Дальше»',
        automatic: false,
      };
    }

    const item = state.playlist?.items[state.playlistAt] ?? null;
    if (item !== null) {
      return {
        label: sceneMeta(item.id).title,
        source: 'pause',
        note: state.config.pauseAuto
          ? `пауза · ${Math.round(item.seconds)} с`
          : `пауза · ждёт кнопки`,
        automatic: state.config.pauseAuto,
      };
    }

    if (state.watching !== null && state.watching.status !== 'finished') {
      return {
        label: 'ход матча',
        source: 'none',
        note: 'ждём следующего действия судьи',
        automatic: true,
      };
    }

    return {
      label: state.pauseDone ? (state.countdownUntil === null ? 'заставка' : 'отсчёт') : 'нечего',
      source: 'none',
      note: state.pauseDone
        ? state.countdownUntil === null
          ? 'пауза отыграна — дальше начало матча'
          : 'пауза отыграна, идёт отсчёт до следующего матча'
        : 'плейлист паузы соберётся, когда матч закроется',
      automatic: false,
    };
  },

  async newCode() {
    try {
      set({ status: await ipc.airNewCode() });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async clearShows() {
    const id = get().tournamentId;
    if (id === null) return;
    set({ shows: await ipc.airClearShows(id) });
  },

  async setEditing(value) {
    if (get().status?.live !== true) return;
    // Показывать зрителям, как пересобирается сетка, незачем: на время правки
    // эфир уходит в заставку, а после «Готово» возвращается сеткой — уже новой.
    set({ frozen: value, playlist: null, playlistAt: 0, pauseDone: false });
    if (value) {
      await place(get, set, 'idle', '', false);
      return;
    }
    await get().refreshContext();
    await place(get, set, 'bracket', '', false);
  },

  reset() {
    if (get().status?.live === true) return;
    set({ tournamentId: null, ctx: null, watching: null, shows: [], playlist: null, error: null });
  },

  async tick() {
    const state = get();
    if (state.status?.live !== true) return;

    await watchMatch(get, set);

    // Плейлист собираем заранее, а не в момент перехода: пульт должен
    // показывать, что выйдет дальше, ещё до того, как это выйдет.
    const now = get();
    if (inPause(now) && now.playlist === null && !now.pauseDone) openPause(get, set);

    await runTimers(get, set);
  },

  // Хелпер, который нужен и снаружи, и внутри: собирает доменные данные.
  async refreshContext() {
    const id = get().tournamentId;
    if (id === null) return;
    try {
      set({ ctx: await loadContext(id), error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));

// ──────────────────────────────────────────────────── доменные данные

/**
 * Собирает всё, из чего строятся кадры.
 *
 * Дорого, поэтому не на каждый тик: только на старте эфира, после матча и по
 * кнопке. Журналы сыгранных матчей читаются отдельно — без них не посчитать
 * ни рекорды, ни разбор по модам.
 */
async function loadContext(tournamentId: number): Promise<AirContext> {
  const [bracket, editor, players, pools] = await Promise.all([
    ipc.tournamentBracket(tournamentId),
    ipc.tournamentEditor(tournamentId),
    ipc.listPlayers(true),
    ipc.listPools(),
  ]);

  const inside = bracket.players.map((p) => p.playerId);
  const stats = new Map(
    await Promise.all(inside.map(async (id) => [id, await ipc.playerStats(id)] as const)),
  );

  // Журналы только сыгранных матчей: у несыгранных их нет.
  const logs = await Promise.all(
    bracket.matches
      .filter((m) => m.status === 'finished')
      .map((m) => ipc.matchState(m.id)),
  );

  // Профили тянутся раз в сутки и только для привязанных игроков.
  const osuIds = players
    .filter((p) => inside.includes(p.id) && p.osuUserId !== null)
    .map((p) => p.osuUserId as number);
  const profiles = new Map(
    (osuIds.length === 0 ? [] : await ipc.airProfiles(osuIds)).map((x) => [x.osuUserId, x]),
  );

  return { bracket, editor, players, pools, stats, profiles, logs };
}

// ────────────────────────────────────────────────────── слежка за матчем

type Get = () => AirStore;
type Set = (patch: Partial<AirStore>) => void;

/**
 * Смотрит за идущим матчем и складывает переходы в очередь предложений.
 *
 * Отмена в матче (Ctrl+Z) сюда приходит как состояние с меньшим числом
 * действий: новых предложений не появляется, а основа кадра пересобирается —
 * то есть эфир откатывается тем же путём, что и матч, и назад не анимируется.
 */
async function watchMatch(get: Get, set: Set) {
  await refreshBracket(get, set);

  const state = get();
  const ctx = state.ctx;
  if (ctx === null) return;

  // Остановленный турнир идущих матчей для эфира не имеет: хост отложил игру,
  // и эфир уходит в паузу вместе с ней.
  const running =
    ctx.bracket.status === 'stopped'
      ? null
      : (ctx.bracket.matches.find((m) => m.status === 'running') ?? null);

  if (running === null) {
    // Матчей нет — эфир в паузе. Опрос лобби при этом остановлен.
    if (state.lobby !== null) {
      await ipc.airLobbyStop();
      set({ lobby: null });
    }
    if (state.watching !== null) set({ watching: null });
    return;
  }

  let next: MatchState;
  try {
    next = await ipc.matchState(running.id);
  } catch {
    return;
  }

  // Лобби появилось или сменилось — поднимаем опрос.
  if (next.lobbyId !== null && state.lobby?.roomId !== next.lobbyId) {
    try {
      await ipc.airLobbyStart(next.id, next.lobbyId);
      set({
        lobby: {
          matchId: next.id,
          roomId: next.lobbyId,
          games: [],
          currentGameId: null,
          error: null,
          at: null,
        },
      });
    } catch (e) {
      set({ error: String(e) });
    }
  }

  const prev = state.watching;
  set({ watching: next });

  // Матч закрылся — доменные данные изменились целиком.
  if (prev !== null && prev.status !== 'finished' && next.status === 'finished') {
    void get().refreshContext();
    // Пауза начинается сейчас, а не когда доиграет старый плейлист: он был
    // собран под другой момент, и отсчёт в его хвосте считал бы не от этого
    // матча. Поэтому пауза пересобирается с нуля.
    set({ playlist: null, playlistAt: 0, pauseDone: false, countdownUntil: null });
  }

  if (prev !== null && sameLog(prev, next)) return;

  const fresh = director.planMatch(ctx, prev, next, currentGame(state.lobby, next));
  if (fresh.length === 0) {
    // Ничего нового не показываем, но основа кадра могла устареть: например
    // судья отменил действие. Обновляем её на месте, без перехода.
    if (state.airing?.id === 'matchLive') {
      await ipc.airPatch('matchLive', build.matchLive(ctx, next));
    }
    return;
  }

  enqueue(get, set, fresh);
}

/**
 * Освежает сетку, если пора. Только её и таблицу раундов: остальное в контексте
 * меняется редко и стоит дорого.
 */
async function refreshBracket(get: Get, set: Set) {
  const state = get();
  const id = state.tournamentId;
  if (id === null || state.ctx === null) return;
  if (Date.now() - bracketAt < BRACKET_EVERY) return;
  bracketAt = Date.now();

  try {
    const [bracket, editor] = await Promise.all([
      ipc.tournamentBracket(id),
      ipc.tournamentEditor(id),
    ]);
    const had = get().ctx;
    if (had === null) return;
    set({ ctx: { ...had, bracket, editor } });
  } catch {
    // Не прочиталось — оставляем прошлую сетку: кадр не должен гаснуть из-за
    // одного неудачного чтения.
  }
}

/** Журнал не изменился — сравнивать состояния дальше незачем. */
function sameLog(a: MatchState, b: MatchState): boolean {
  return (
    a.id === b.id &&
    a.actions.length === b.actions.length &&
    a.status === b.status &&
    a.firstBanBy === b.firstBanBy
  );
}

/** Карта, которая играется в лобби прямо сейчас. */
function currentGame(lobby: LobbyState | null, m: MatchState): LobbyGame | null {
  if (lobby === null || lobby.matchId !== m.id) return null;
  // Сначала ищем идущую, потом последнюю закрытую: сцена результата берёт её.
  const live = lobby.games.find((g) => g.gameId === lobby.currentGameId) ?? null;
  if (live !== null) return live;
  const done = lobby.games.filter((g) => g.endTime !== null);
  return done[done.length - 1] ?? null;
}

/** Кладёт предложения в очередь. Очередь глубиной три. */
function enqueue(get: Get, set: Set, fresh: Proposal[]) {
  const state = get();
  const merged = [...state.proposals, ...fresh];
  const kept = merged.slice(Math.max(0, merged.length - QUEUE_DEPTH));
  const opensMatch = fresh.some((p) => isMatchScene(p.id));

  set({
    proposals: kept,
    overflow: state.overflow + (merged.length - kept.length),
    // В матче что-то произошло — отыгранная пауза больше не отыграна.
    pauseDone: false,
    // Игра началась: отсчёт до неё больше ничего не считает.
    ...(opensMatch ? { countdownUntil: null } : {}),
  });

  if (state.config.mode !== 'auto' || state.frozen) return;

  // Началась игра, а в эфире сцена паузы. Ждать её конца нельзя, но и рубить
  // кадр в тот же миг плохо: смена без перехода читается как сбой. Поэтому
  // сцена доигрывает не больше двух секунд — и уходит.
  const airing = state.airing;
  if (airing !== null && !isMatchScene(airing.id) && opensMatch) {
    const top = airing.layers[airing.layers.length - 1];
    if (top !== undefined && !director.expired(top)) {
      const cut = [...airing.layers.slice(0, -1), director.cutShort(top)];
      set({ airing: { ...airing, layers: cut }, playlist: null, playlistAt: 0, hold: false });
      // Слой тот же, поменялся только срок: анимация входа не перезапустится.
      void ipc.airScene(cut, null);
      return;
    }
  }

  void get().next();
}

// ───────────────────────────────────────────────────────────── таймеры

/** Матча в эфире нет: значит идёт пауза, и её занимает плейлист. */
function inPause(state: AirStore): boolean {
  if (state.ctx?.bracket.status === 'stopped') return true;
  const m = state.watching;
  return m === null || m.status === 'finished';
}

/**
 * Пауза между матчами, а не до начала турнира.
 *
 * Разница в том, знает ли эфир, сколько ей осталось. Между матчами знает —
 * это бюджет паузы, — и потому кончается отсчётом до следующего матча. До
 * первого матча не знает ничего: турнир начинают когда соберутся, и отсчёт,
 * упавший в ноль за полчаса до старта, был бы обманом.
 */
function betweenMatches(state: AirStore): boolean {
  return state.ctx?.bracket.matches.some((m) => m.status === 'finished') === true;
}

/**
 * Можно ли двигать плейлист паузы самому.
 *
 * Замороженный кадр и кадр, выведенный руками, не трогаем: оба стоят по
 * решению хоста. Отыгранный бюджет тоже не трогаем — в этом весь смысл
 * бюджета: пауза не должна крутиться до конца турнира.
 */
function canRollPause(state: AirStore): boolean {
  return state.config.pauseAuto && !state.frozen && !state.hold && !state.pauseDone;
}

/** Кадр отыграл своё — что дальше. */
async function runTimers(get: Get, set: Set) {
  const state = get();
  const airing = state.airing;

  // Кадра ещё нет вовсе — начинаем с плейлиста паузы.
  if (airing === null) {
    if (inPause(state) && canRollPause(state)) await advancePause(get, set);
    return;
  }

  const top = airing.layers[airing.layers.length - 1];
  const done = top === undefined || director.expired(top);

  if (airing.after.kind === 'pause') {
    // Кадр без срока — заставка или надпись. Он стоит бесконечно, и раньше
    // это и ломало автопоказ: эфир запускался заставкой, а плейлист паузы
    // ждал события, которого не бывает. Теперь такой кадр сам и есть повод
    // взять следующую сцену — если хост не держит его нарочно.
    const forever = top !== undefined && top.until === null;
    if ((done || forever) && canRollPause(state)) await advancePause(get, set);
    return;
  }

  if (!done) return;

  // Стрелку разрешаем сейчас, а не при постановке предложения: врезка стоит
  // секунды, и за это время матч успевает уйти вперёд. Замороженный кадр
  // вернул бы в эфир счёт, которого больше нет.
  const after = resolveAfter(state, airing.after);
  if (after === null) {
    await advancePause(get, set);
    return;
  }

  await ipc.airScene(after, null);
  const id = after[after.length - 1]?.id ?? airing.id;
  set({ airing: { id, objectKey: '', layers: after, after: { kind: 'live' } } });
}

/** Во что превращается стрелка сценария по нынешнему состоянию. */
function resolveAfter(state: AirStore, after: director.After): AirLayer[] | null {
  if (after.kind === 'layers') return after.layers;

  const ctx = state.ctx;
  const m = state.watching;
  // Матча уже нет — возвращаться к «Ходу матча» некуда, уходим в паузу.
  if (ctx === null || m === null) return null;

  if (after.kind === 'progress') {
    const progress = build.mapProgress(ctx, m, currentGame(state.lobby, m));
    if (progress !== null) return [director.layer('mapProgress', progress)];
  }
  return [director.liveLayer(ctx, m)];
}

/**
 * Следующая сцена паузы. Пауза начинается, когда матч завершён, и кончается,
 * когда открыт следующий: до тех пор экран занят плейлистом.
 *
 * `manual` — хост нажал кнопку. Тогда замирание не мешает: оно про то, что
 * эфир не двигается сам, а не про то, что он не слушает хоста.
 */
async function advancePause(get: Get, set: Set, manual = false) {
  const state = get();
  if (state.frozen && !manual) return;

  // Матч открыт — плейлист паузы прерывается. Статистика подождёт, игра нет.
  const first = state.proposals[0];
  if (first !== undefined && isMatchScene(first.id)) {
    set({ proposals: state.proposals.slice(1), playlist: null, playlistAt: 0, pauseDone: false });
    await get().air(first);
    return;
  }

  let list = state.playlist;
  let at = state.playlistAt;

  if (list === null) {
    list = openPause(get, set);
    at = 0;
  }

  const item = list.items[at];
  if (item === undefined) {
    // Плейлист отыгран. Дальше стоит отсчёт или заставка, и повторять её
    // каждые полсекунды не надо — иначе кадр перезапускался бы без остановки,
    // а пауза шла бы по кругу.
    set({ playlist: null, playlistAt: 0, pauseDone: true });
    if (get().airing?.id !== 'idle' && get().countdownUntil === null) {
      await place(get, set, 'idle', '', false);
    }
    return;
  }

  const proposal = buildScene(get(), item.id, item.objectKey, item.seconds);
  set({ playlistAt: at + 1 });

  if (proposal === null) {
    // Данные пропали, пока сцена ждала очереди — идём дальше, а не встаём.
    await advancePause(get, set, manual);
    return;
  }
  await get().air(proposal);
}

/**
 * Начало паузы: назначаем отсчёт, если он уместен, и собираем плейлист.
 *
 * Пауза между матчами кончается отсчётом до следующего — несколько сцен, а
 * потом «через сколько начнём». Отсчёт запускается сам, потому что длину паузы
 * эфир уже знает: это её бюджет, и просить нажать кнопку тут не за что.
 */
function openPause(get: Get, set: Set): Playlist {
  const state = get();
  if (state.countdownUntil === null && betweenMatches(state)) {
    set({ countdownUntil: director.plusSeconds(state.config.pauseBudget) });
  }
  return rebuildPlaylist(get, set);
}

/**
 * Пересобирает плейлист под нынешний бюджет. Чистый расчёт, без обращений.
 *
 * Отсчёт до следующего матча делает бюджет точным: пока его нет, берём
 * ожидаемую паузу из настроек.
 */
function rebuildPlaylist(get: Get, set: Set): Playlist {
  const state = get();
  const until = state.countdownUntil;
  const budget =
    until === null
      ? state.config.pauseBudget
      : Math.max(0, Math.round((Date.parse(until) - Date.now()) / 1000));

  const list = buildPlaylist({
    budget,
    candidates: state.candidates(),
    shows: state.shows,
    hasCountdown: until !== null,
    order: planFor(state),
  });
  set({ playlist: list, playlistAt: 0 });
  return list;
}

/**
 * Порядок сцен, заданный на раунд, в который вот-вот играем.
 *
 * Пауза принадлежит тому раунду, который после неё начнётся: перед первым
 * раундом уместно одно, перед финалом другое. `undefined` — плана нет, и
 * порядок подбирается сам.
 */
function planFor(state: AirStore): SceneId[] | undefined {
  const ctx = state.ctx;
  if (ctx === null) return undefined;

  const next =
    ctx.bracket.matches.find(
      (m) => m.status !== 'finished' && m.playerA !== null && m.playerB !== null,
    ) ?? ctx.bracket.matches.find((m) => m.status !== 'finished');
  if (next === undefined) return undefined;

  const plan = state.config.roundPlans[roundKey(next.bracket, next.round)];
  return plan === undefined || plan.length === 0 ? undefined : plan;
}

// ────────────────────────────────────────────────── сборка одной сцены

/**
 * Ставит сцену в эфир. `hold` — стоит до следующего решения хоста.
 *
 * Отдельно от `pick` затем, что эфир ставит заставку и сам: на старте и на
 * время аварийной правки. Плейлист здесь не сбрасывается — этим и отличается
 * своя постановка от нажатия хоста: сброс отправлял паузу собираться заново,
 * и она шла по кругу вместо того, чтобы кончиться.
 */
async function place(
  get: Get,
  set: Set,
  id: SceneId,
  objectKey: string,
  hold: boolean,
): Promise<void> {
  const proposal = buildScene(get(), id, objectKey);
  if (proposal === null) {
    set({ error: `Сцену «${sceneMeta(id).title}» сейчас показать нечем` });
    return;
  }
  set({ hold });
  await get().air(proposal);
}

/** Строка сетки кнопок: можно ли вывести и сколько раз уже выводили. */
function candidate(state: AirStore, id: SceneId, objectKey: string): Candidate {
  const ready = buildScene(state, id, objectKey);
  return {
    id,
    objectKey,
    objectName: objectName(state, objectKey),
    available: ready !== null,
    reason: ready === null ? reasonFor(state, id) : null,
    required: requiredNow(state, id),
  };
}

/** Про кого кадр: ник, пара ников, название маппула. */
function objectName(state: AirStore, objectKey: string): string | null {
  const ctx = state.ctx;
  if (ctx === null || objectKey === '') return null;
  const nick = (id: number) =>
    ctx.bracket.players.find((p) => p.playerId === id)?.nickname ?? '—';

  if (objectKey.startsWith('p:')) return nick(Number(objectKey.slice(2)));
  if (objectKey.startsWith('vs:')) {
    const [a, b] = objectKey.slice(3).split('-').map(Number);
    return a === undefined || b === undefined ? null : `${nick(a)} — ${nick(b)}`;
  }
  if (objectKey.startsWith('pool:')) {
    const poolId = Number(objectKey.slice(5));
    return ctx.pools.find((p) => p.id === poolId)?.name ?? null;
  }
  return null;
}

/**
 * Готовит кадр для заготовки. `null` — данных под неё сейчас нет, и это
 * нормальный ответ: сцена просто не выйдет, а пульт скажет повод.
 */
function buildScene(
  state: AirStore,
  id: SceneId,
  objectKey: string,
  seconds?: number,
): Proposal | null {
  const ctx = state.ctx;
  if (ctx === null) return null;

  const meta = sceneMeta(id);
  const secs = seconds ?? (meta.timing === 'fixed' ? meta.max : 0);
  const label = meta.title;
  const done = (payload: object | null): Proposal | null =>
    payload === null
      ? null
      : {
          id,
          objectKey,
          label,
          layers: [director.layer(id, payload as never, secs)],
          seconds: secs,
          // Сцена, выведенная руками, уходит в паузу: сценарий её не звал,
          // и возвращать её «обратно в матч» было бы догадкой.
          after: { kind: 'pause' },
        };

  switch (id) {
    case 'idle':
      return done({ tournament: ctx.bracket.name, note: null });
    case 'message':
      return state.config.message.trim() === ''
        ? null
        : done({ text: state.config.message, note: null });
    case 'clip':
      return state.config.clip.trim() === '' ? null : done({ src: state.config.clip, title: null });
    case 'bracket':
      return ctx.bracket.matches.length === 0 ? null : done(build.bracketScene(ctx));
    case 'standings':
      return ctx.bracket.players.length === 0 ? null : done(build.standings(ctx));
    case 'nextUp': {
      const payload = build.nextUp(ctx);
      return payload.next === null ? null : done(payload);
    }
    case 'countdown':
      return state.countdownUntil === null
        ? null
        : done({ until: state.countdownUntil, label: 'следующий матч через' });
    case 'poolShowcase': {
      const poolId = Number(objectKey.replace('pool:', ''));
      const pool = ctx.pools.find((p) => p.id === poolId) ?? null;
      if (pool === null) return null;
      const round = ctx.editor.rounds.find((r) => r.playingPoolId === poolId) ?? null;
      return done(build.poolShowcase(pool, round?.title ?? pool.name));
    }
    case 'playerCard':
      return done(build.playerCard(ctx, Number(objectKey.replace('p:', ''))));
    case 'playerPath':
      return done(build.playerPath(ctx, Number(objectKey.replace('p:', ''))));
    case 'headToHead': {
      const [a, b] = objectKey.replace('vs:', '').split('-').map(Number);
      return a === undefined || b === undefined ? null : done(build.headToHead(ctx, a, b));
    }
    case 'records': {
      const tally = build.buildTally(ctx);
      return tally.records.length === 0 ? null : done({ items: tally.records });
    }
    case 'modStats': {
      const tally = build.buildTally(ctx);
      return tally.mods.length === 0 ? null : done(build.modStats(tally));
    }
    case 'poolRecap': {
      const recap = build.poolRecap(build.buildTally(ctx));
      return recap.rows.length === 0 ? null : done(recap);
    }
    case 'champion':
      return done(build.champion(ctx));
    case 'credits':
      return ctx.bracket.status === 'finished' ? done(build.credits(ctx)) : null;
    default:
      // Сцены матча выводятся сценарием, а не руками: они привязаны к событию,
      // а не к моменту.
      return isMatchScene(id) ? fromMatch(state, id, secs) : null;
  }
}

/** Сцена матча по нынешнему состоянию — для ручного вывода из сетки кнопок. */
function fromMatch(state: AirStore, id: SceneId, secs: number): Proposal | null {
  const ctx = state.ctx;
  const m = state.watching;
  if (ctx === null || m === null) return null;

  const wrap = (payload: object | null): Proposal | null =>
    payload === null
      ? null
      : {
          id,
          objectKey: '',
          label: sceneMeta(id).title,
          layers: sceneMeta(id).overlay
            ? [director.liveLayer(ctx, m), director.layer(id, payload as never, secs)]
            : [director.layer(id, payload as never, secs)],
          seconds: secs,
          // Врезка возвращает матч, остальное уходит в паузу.
          after: sceneMeta(id).overlay ? { kind: 'live' } : { kind: 'pause' },
        };

  switch (id) {
    case 'matchLive':
      return wrap(build.matchLive(ctx, m));
    case 'matchIntro':
      return wrap(build.matchIntro(ctx, m));
    case 'banReveal':
      return wrap(build.banReveal(ctx, m));
    case 'pickReveal':
      return wrap(build.pickReveal(ctx, m));
    case 'mapProgress':
      return wrap(build.mapProgress(ctx, m, currentGame(state.lobby, m)));
    case 'mapResult':
      return wrap(build.mapResult(ctx, m, currentGame(state.lobby, m)));
    case 'matchResult':
      return wrap(build.matchResult(ctx, m));
    default:
      // Жеребьёвка, матчпоинт и решающая карта — только по событию: показывать
      // их по кнопке значит показывать то, чего в матче не произошло.
      return null;
  }
}

/** Объекты, для которых у сцены «по объекту» есть свой кадр. */
function objectsFor(state: AirStore, id: SceneId): string[] {
  const ctx = state.ctx;
  if (ctx === null || !sceneMeta(id).byObject) return [''];

  if (id === 'playerCard' || id === 'playerPath') {
    // Первыми — те, кто играет в следующем матче: их карточка к месту, а
    // карточка случайного игрока — просто заполнение времени. Плейлист берёт
    // объекты по порядку, поэтому порядок здесь и решает, кого покажут.
    const next = ctx.bracket.matches.find(
      (m) => m.status !== 'finished' && m.playerA !== null && m.playerB !== null,
    );
    const soon = [next?.playerA, next?.playerB].filter((x): x is number => x != null);
    return [...ctx.bracket.players]
      .sort((x, y) => Number(soon.includes(y.playerId)) - Number(soon.includes(x.playerId)))
      .map((p) => `p:${p.playerId}`);
  }
  if (id === 'headToHead') {
    const next = ctx.bracket.matches.find(
      (m) => m.status !== 'finished' && m.playerA !== null && m.playerB !== null,
    );
    return next === undefined ? [] : [`vs:${next.playerA as number}-${next.playerB as number}`];
  }
  if (id === 'poolShowcase') {
    const next = ctx.bracket.matches.find((m) => m.status !== 'finished' && m.poolId !== null);
    return next?.poolId == null ? [] : [`pool:${next.poolId}`];
  }
  return [''];
}

/** Почему сцену взять нельзя. Приглушённая кнопка без повода бесполезна. */
function reasonFor(state: AirStore, id: SceneId): string {
  const ctx = state.ctx;
  if (ctx === null) return 'турнир ещё не прочитан';

  switch (id) {
    case 'message':
      return 'надпись не набрана';
    case 'clip':
      return 'файл не выбран';
    case 'countdown':
      return 'отсчёт не запущен';
    case 'champion':
    case 'credits':
      return 'турнир ещё не сыгран';
    case 'headToHead':
      return 'встретились впервые';
    case 'playerCard':
      return 'нет статистики по игроку';
    case 'records':
    case 'modStats':
    case 'poolRecap':
      return 'сыграно слишком мало';
    case 'poolShowcase':
      return 'маппул следующего матча не назначен';
    case 'bracket':
      return 'сетки ещё нет';
    default:
      return 'нет данных';
  }
}

/** Обязательна к этому моменту. */
function requiredNow(state: AirStore, id: SceneId): boolean {
  const ctx = state.ctx;
  if (ctx === null) return false;

  // Сетка — сразу после того, как раунд доигран целиком: продвижение по сетке
  // это главное, что произошло.
  if (id === 'bracket') {
    const last = state.watching;
    if (last === null || last.status !== 'finished') return false;
    return !ctx.bracket.matches.some(
      (m) => m.bracket === last.bracket && m.round === last.round && m.status !== 'finished',
    );
  }

  // Маппул — перед матчем, маппул которого ещё не разыгрывали.
  if (id === 'poolShowcase') {
    const next = ctx.bracket.matches.find((m) => m.status !== 'finished' && m.poolId !== null);
    if (next?.poolId == null) return false;
    return !ctx.logs.some((m) => m.poolId === next.poolId);
  }

  return false;
}

// ──────────────────────────────────────────────────── таймеры и события

function attachTimers(get: Get) {
  detachTimers();
  bracketAt = 0;

  timer = window.setInterval(() => void get().tick(), TICK);

  void ipc.onAirViewers(() => void get().refreshStatus()).then((off) => {
    unlistenViewers = off;
  });

  void ipc
    .onAirLobby((update: LobbyUpdate) => {
      const state = get();
      const had = state.lobby;
      if (had === null || had.matchId !== update.matchId) return;

      // Карты складываем по id: инкрементальный опрос присылает только то,
      // что изменилось, а нам нужна вся картина матча.
      const games = new Map(had.games.map((g) => [g.gameId, g]));
      for (const game of update.games) games.set(game.gameId, game);

      useAir.setState({
        lobby: {
          ...had,
          games: [...games.values()],
          currentGameId: update.currentGameId,
          error: update.error,
          at: update.at,
        },
      });
    })
    .then((off) => {
      unlistenLobby = off;
    });
}

function detachTimers() {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  unlistenViewers?.();
  unlistenLobby?.();
  unlistenViewers = null;
  unlistenLobby = null;
}
