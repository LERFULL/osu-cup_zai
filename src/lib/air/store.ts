// Стор эфира. Здесь живёт то, что ведёт трансляцию: очередь кадров, текущий
// кадр, плейлист паузы и таймеры.
//
// Он не привязан к экрану пульта нарочно: хост судит матч на одном экране, а
// эфир идёт сам. Поэтому стор сам опрашивает идущий матч и сам решает, что
// показать, а пульт только рисует то, что здесь уже посчитано.
//
// Режима управления один. Кадр выходит сам, потому что судья и хост — один
// человек, и выбирать во время матча не из чего: у каждого состояния матча
// есть ровно один правильный кадр. Единственное исключение — вскрытие пика,
// которое можно придержать ради драмы.

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
  normalizeStyle,
  normalizeTemplate,
  type AirConfig,
  type AirLayer,
  type AirStatus,
  type AirTheme,
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
  error: string | null;

  /** Доменные данные, из которых собираются кадры. */
  ctx: AirContext | null;
  /** Матч, за которым следим. */
  watching: MatchState | null;

  airing: Airing | null;
  /**
   * Кадры, ждущие вывода. Обычно пусто или один: одно действие судьи даёт один
   * кадр. Список — потому что бывает и два: результат карты, а за ним матчпоинт.
   */
  proposals: Proposal[];
  /** Автоматика замерла на текущем кадре. */
  frozen: boolean;
  /**
   * Показ ещё не начат: сервер поднял эфир, но кадры стоят на заставке.
   *
   * Нужен ровно для старта: поднять сервер — полдела, хосту ещё надо скопировать
   * адрес, добавить источник в OBS и убедиться, что кадр виден. Пока он не
   * нажал «Начать показ», эфир не двигается: ни плейлист паузы, ни кадры
   * матча — предложения копятся в очереди и выйдут после кнопки.
   */
  standby: boolean;
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

  // ── эфир
  start: () => Promise<void>;
  /** Снять показ с ожидания: кадры идут, плейлист паузы собирается. */
  beginShow: () => void;
  stop: () => Promise<void>;
  refreshStatus: () => Promise<void>;

  // ── вывод
  /** Выводит кадр в эфир. */
  air: (p: Proposal) => Promise<void>;
  /** Дальше по сценарию: первое предложение или следующая сцена паузы. */
  next: () => Promise<void>;
  /** Замереть на текущем кадре или отпустить автоматику. */
  freeze: (value: boolean) => void;
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

  // ── правка очереди: хост видит порядок кадров целиком и может его менять
  /** Поднять кадр в очереди. */
  moveProposal: (from: number, to: number) => void;
  /** Убрать кадр из очереди. */
  dropProposal: (index: number) => void;
  /** Показать кадр из очереди сейчас, не дожидаясь своей очереди. */
  playProposal: (index: number) => Promise<void>;
  /** Добавить заготовку в конец очереди. */
  pushScene: (id: SceneId, objectKey?: string) => void;

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
  error: null,

  ctx: null,
  watching: null,

  airing: null,
  proposals: [],
  frozen: false,
  standby: false,
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
      // значениями по умолчанию, а не падаем на чужой форме. Стили и шаблон
      // прогоняем через нормализацию: прежние имена («Сдержанно» и другие)
      // переводятся на новые, чтобы смена словаря не ломала сохранённое.
      const saved = raw === null ? {} : (JSON.parse(raw) as Partial<AirConfig>);
      const merged: AirConfig = {
        ...DEFAULT_CONFIG,
        ...saved,
        style: normalizeStyle(saved.style),
        template: normalizeTemplate(saved.template),
        pace:
          typeof saved.pace === 'number' && Number.isFinite(saved.pace)
            ? Math.min(2, Math.max(0.5, saved.pace))
            : 1,
        sceneStyle: Object.fromEntries(
          Object.entries(saved.sceneStyle ?? {}).map(([id, style]) => [id, normalizeStyle(style)]),
        ),
      };
      set({
        tournamentId,
        config: merged,
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
    } catch (e) {
      set({ error: String(e) });
    }
  },

  // ───────────────────────────────────────────────────────────── эфир

  async start() {
    const { tournamentId, ctx } = get();
    if (tournamentId === null) return;

    try {
      const status = await ipc.airStart(tournamentId, ctx?.bracket.name ?? 'Турнир');
      set({ status, error: null, proposals: [], frozen: false, standby: true });

      // Эфир мог запуститься посреди турнира — это нормальный ход: заставка
      // до первого события, счётчики показов при этом не пустые. Заставка не
      // держит кадр: плейлист паузы сменит её на первом же тике.
      await place(get, set, 'idle', '', false);
      attachTimers(get);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  beginShow() {
    // Хост скопировал адрес и поднял OBS — показ начинается. Очередь,
    // накопленная в ожидании, выйдет сама на первом же тике.
    set({ standby: false, pauseDone: false });
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
      await ipc.airScene(p.layers, themeOf(get()));
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

  freeze(value) {
    set({ frozen: value });
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

    if (state.standby) {
      return {
        label: 'показ не начат',
        source: 'hold',
        note: 'эфир поднят, кадр стоит на заставке — скопируй адрес, подними OBS и нажми «Начать показ»',
        automatic: false,
      };
    }

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
      const held = heldPick(state);
      const tail = rest > 0 ? ` · за ним ещё ${rest}` : '';
      return {
        label: first.label,
        source: 'match',
        note: held ? `придержан — выпусти кнопкой${tail}` : `выйдет, когда кадр отыграет${tail}`,
        automatic: !held,
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

  // ── правка очереди: хост видит порядок кадров и меняет его без мыши в матче

  moveProposal(from, to) {
    const proposals = [...get().proposals];
    if (from < 0 || from >= proposals.length) return;
    const to2 = Math.min(proposals.length - 1, Math.max(0, to));
    if (from === to2) return;
    const [item] = proposals.splice(from, 1);
    if (item === undefined) return;
    proposals.splice(to2, 0, item);
    set({ proposals });
  },

  dropProposal(index) {
    const proposals = get().proposals;
    if (index < 0 || index >= proposals.length) return;
    set({ proposals: proposals.filter((_, at) => at !== index) });
  },

  async playProposal(index) {
    const state = get();
    const proposal = state.proposals[index];
    if (proposal === undefined) return;
    set({ proposals: state.proposals.filter((_, at) => at !== index), hold: false });
    await state.air(proposal);
  },

  pushScene(id, objectKey = '') {
    const state = get();
    const proposal = buildScene(state, id, objectKey);
    if (proposal === null) {
      set({ error: `Сцену «${sceneMeta(id).title}» сейчас показать нечем` });
      return;
    }
    set({ proposals: [...state.proposals, proposal], pauseDone: false });
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
    if (inPause(now) && !now.standby && now.playlist === null && !now.pauseDone) openPause(get, set);

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
 * Тема, уходящая на страницу вместе с кадром: акцент, стиль анимации и шаблон.
 *
 * Всё это лежит в теме, а не в каждом слое, потому что тема уже доходит до
 * страницы как есть — Rust её не разбирает и не должен. Ключ `style` — стиль
 * на весь эфир, `style:<sceneId>` — переопределение для одной сцены,
 * `template` — шаблон кадра (декорации и палитра).
 */
function themeOf(state: AirStore): AirTheme {
  const theme: AirTheme = {
    accent: '#ff6fb1',
    style: state.config.style,
    template: state.config.template,
  };
  for (const [id, style] of Object.entries(state.config.sceneStyle)) {
    if (style !== undefined) theme[`style:${id}`] = style;
  }
  return theme;
}

/** Свободный текст в строки: пустые и пробельные убираются. */
function linesOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Собирает всё, из чего строятся кадры.
 *
 * Дорого, поэтому не на каждый тик: только на старте эфира, после матча и по
 * кнопке. Журналы сыгранных матчей читаются отдельно — без них не посчитать
 * ни рекорды, ни разбор по модам.
 */
async function loadContext(tournamentId: number): Promise<AirContext> {
  const [bracket, editor, players, pools, prize] = await Promise.all([
    ipc.tournamentBracket(tournamentId),
    ipc.tournamentEditor(tournamentId),
    ipc.listPlayers(true),
    ipc.listPools(),
    ipc.prizeState(tournamentId).catch(() => null),
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

  return { bracket, editor, players, pools, stats, profiles, logs, prize };
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

  // Лобби появилось или сменилось — поднимаем опрос. Сравниваем и матч,
  // и номер комнаты: привязка того же лобби к другому матчу должна
  // перезапустить опрос, а не оставить цифры от старого матча.
  if (
    next.lobbyId !== null &&
    (state.lobby === null ||
      state.lobby.matchId !== next.id ||
      state.lobby.roomId !== next.lobbyId)
  ) {
    try {
      // Сначала гасим старый опрос, если он был: слот опроса один на сессию.
      await ipc.airLobbyStop();
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

  // Привязку сняли (или матч без лобби сменил привязанный): опрос обязан
  // остановиться сразу. Иначе он молча тратил бы лимит osu! и продолжал
  // показывать в эфире цифры лобби, к которому матч уже не привязан.
  if (next.lobbyId === null && state.lobby !== null) {
    await ipc.airLobbyStop();
    set({ lobby: null });
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

  const fresh = director.planMatch(ctx, prev, next, currentGame(state.lobby, next), state.config.pace);
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
    const [bracket, editor, prize] = await Promise.all([
      ipc.tournamentBracket(id),
      ipc.tournamentEditor(id),
      ipc.prizeState(id).catch(() => null),
    ]);
    const had = get().ctx;
    if (had === null) return;
    // Фонд освежается вместе с сеткой: живой счётчик и баунти меняются
    // с каждым результатом карты, а не только по окончании матча.
    set({ ctx: { ...had, bracket, editor, prize: prize ?? had.prize } });
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

/**
 * Кладёт кадры в очередь и выпускает их сам.
 *
 * Сам — потому что режима управления один: у каждого состояния матча есть
 * ровно один правильный кадр, и спрашивать про него не за что. Не сам эфир
 * не выходит только в двух случаях: хост замер или придерживает пик.
 *
 * Кадры не рвут друг друга: если сейчас играет сцена с таймером — бан, пик,
 * результат — новое событие встанет за ней в очередь и выйдет, когда текущая
 * отыграет. Прервать идущий кадр может только начало матча: игру ждать
 * нельзя, и сцена паузы доигрывает не больше двух секунд.
 */
function enqueue(get: Get, set: Set, fresh: Proposal[]) {
  const state = get();
  const opensMatch = fresh.some((p) => isMatchScene(p.id));

  set({
    proposals: [...state.proposals, ...fresh],
    // В матче что-то произошло — отыгранная пауза больше не отыграна.
    pauseDone: false,
    // Игра началась: отсчёт до неё больше ничего не считает.
    ...(opensMatch ? { countdownUntil: null } : {}),
  });

  // Показ ещё не начат: кадры копятся в очереди и выйдут после кнопки.
  // Очередь, а не выкидывание: хост начнёт показ в любой момент, и эфир
  // обязан догнать матч, а не потерять его события.
  if (state.standby) return;

  if (state.frozen) return;

  // Пик придержан: кадр стоит в очереди и ждёт кнопки. Всё, что встало за ним,
  // ждёт тоже — иначе результат карты вышел бы раньше её вскрытия.
  if (heldPick(get())) return;

  const airing = state.airing;
  const top = airing?.layers[airing.layers.length - 1] ?? null;

  // В эфире сцена с таймером, и она ещё не отыграла: очередь подождёт её
  // конца — выпускайهم будет runTimers. Исключение — начало игры поверх
  // сцены паузы: пауза доигрывает две секунды и уходит.
  if (airing !== null && top !== null && top.until !== null && !director.expired(top)) {
    if (isMatchScene(airing.id) || !opensMatch) return;

    const cut = [...airing.layers.slice(0, -1), director.cutShort(top)];
    set({ airing: { ...airing, layers: cut }, playlist: null, playlistAt: 0, hold: false });
    // Слой тот же, поменялся только срок: анимация входа не перезапустится.
    void ipc.airScene(cut, themeOf(get()));
    return;
  }

  void get().next();
}

/** Первым в очереди стоит придержанный пик: он ждёт кнопки. */
function heldPick(state: AirStore): boolean {
  return state.config.holdPicks && state.proposals[0]?.id === 'pickReveal';
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
  return (
    state.config.pauseAuto && !state.frozen && !state.hold && !state.pauseDone && !state.standby
  );
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
  const forever = top !== undefined && top.until === null;

  // Очередь — прежде всего: она выходит и поверх бессрочного кадра («Ход
  // матча», заставка), и сразу за отыгранной врезкой. Врезка бана не должна
  // закрывать собой следующий бан: каждый кадр отыгрывает свой срок до конца,
  // а очередь ждёт под ним. Придержанный пик, заморозка и ожидание OBS не
  // трогаются: они ждут решения хоста, а не таймера.
  if (
    state.proposals.length > 0 &&
    !heldPick(state) &&
    !state.frozen &&
    !state.standby &&
    (forever || done)
  ) {
    const first = state.proposals[0];
    if (first !== undefined) {
      // Очередь важнее ручной постановки: событие матча выходит, даже если
      // хост держал перед ним свою сцену.
      set({ proposals: state.proposals.slice(1), hold: false });
      await get().air(first);
      return;
    }
  }

  if (airing.after.kind === 'pause') {
    // Кадр без срока — заставка или надпись. Он стоит бесконечно, и раньше
    // это и ломало автопоказ: эфир запускался заставкой, а плейлист паузы
    // ждал события, которого не бывает. Теперь такой кадр сам и есть повод
    // взять следующую сцену — если хост не держит его нарочно.
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

  await ipc.airScene(after, themeOf(state));
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
    pace: state.config.pace,
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
  // Темп эфира ужимает и растягивает заготовки: одна ручка вместо правки
  // каждой сцены отдельно. Плейлист паузы зовёт с готовыми секундами — они
  // уже посчитаны под бюджет, темп их не трогает.
  const pace = state.config.pace;
  const secs =
    seconds ?? (meta.timing === 'fixed' ? Math.max(0.5, meta.max / Math.max(0.25, pace)) : 0);
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
    case 'playerCard':
      return done(build.playerCard(ctx, Number(objectKey.replace('p:', ''))));
    case 'records': {
      const tally = build.buildTally(ctx);
      return tally.records.length === 0 ? null : done({ items: tally.records });
    }
    case 'stats': {
      const stats = build.stats(ctx);
      return stats === null ? null : done(stats);
    }
    case 'champion':
      return done(build.champion(ctx));
    case 'credits': {
      // Титры знают то, чего нет в модели турнира: организаторов, судей, ссылки
      // и соцсети. Их знает только эфир — поэтому достраиваются здесь, где виден
      // конфиг, а не в payload, где виден только контекст.
      if (ctx.bracket.status !== 'finished') return null;
      const texts = state.config.finalTexts;
      return done({
        ...build.credits(ctx),
        organizers: linesOf(texts.organizers),
        judges: linesOf(texts.judges),
        links: linesOf(texts.links),
        socials: linesOf(texts.socials),
      });
    }
    case 'fundBoard':
      return done(build.fundBoard(ctx));
    case 'fundFlow':
      return done(build.fundBoard(ctx));
    case 'topEarners': {
      const board = build.fundBoard(ctx);
      return board === null || board.earned.length === 0 ? null : done(board);
    }
    case 'trailerTitle':
      return done(build.trailerTitle(ctx));
    case 'trailerPlayers':
      return done(build.trailerPlayers(ctx));
    case 'trailerStakes':
      return done(build.trailerStakes(ctx));
    case 'rookieRace':
      return done(build.rookieRace(ctx));
    case 'spectatorBank':
      return done(build.spectatorBank(ctx));
    case 'jackpotScene':
      return done(build.jackpotScene(ctx));
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

  if (id === 'playerCard') {
    // Первыми — те, кто играет в следующем матче: их карточка к месту, а
    // карточка случайного игрока — просто заполнение времени. Порядок здесь
    // и решает, кого покажут: пауза берёт объекты по нему.
    const next = ctx.bracket.matches.find(
      (m) => m.status !== 'finished' && m.playerA !== null && m.playerB !== null,
    );
    const soon = [next?.playerA, next?.playerB].filter((x): x is number => x != null);
    return [...ctx.bracket.players]
      .sort((x, y) => Number(soon.includes(y.playerId)) - Number(soon.includes(x.playerId)))
      .map((p) => `p:${p.playerId}`);
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
    case 'countdown':
      return 'отсчёт не запущен';
    case 'champion':
    case 'credits':
      return 'турнир ещё не сыгран';
    case 'playerCard':
      return 'нет статистики по игроку';
    case 'records':
      return 'сыграно слишком мало';
    case 'stats':
      return 'сыграно слишком мало';
    case 'bracket':
      return 'сетки ещё нет';
    case 'fundBoard':
    case 'fundFlow':
      return 'фонд не задан';
    case 'topEarners':
      return 'никто ещё ничего не заработал';
    case 'trailerTitle':
    case 'trailerPlayers':
      return 'состав меньше двух';
    case 'trailerStakes':
      return 'данных о турнире нет';
    case 'rookieRace':
      return 'надстройка выключена или новичков меньше двух';
    case 'spectatorBank':
      return 'зрительский банк выключен';
    case 'jackpotScene':
      return 'джекпот выключен';
    case 'bountyHeads':
    case 'bountyTaken':
      return 'надстройка выключена или голов нет';
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
