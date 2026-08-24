/**
 * Заглушка эфира для показа в браузере.
 *
 * Настоящего сервера здесь нет: состояние уходит в канал внутри браузера, а
 * страница зрителя читает его оттуда же. Смысл ровно один — можно открыть
 * пульт и `air.html` в двух вкладках и посмотреть все двадцать шесть сцен
 * живьём, не собирая приложение.
 */

import type {
  AirLayer,
  AirMessage,
  AirState,
  AirStatus,
  OsuProfile,
  SceneId,
  SceneShow,
} from './air/types';
import { CHANNEL } from '@/air/transport';

type Args = Record<string, unknown>;

/** Один канал на весь показ. Открывается лениво: в собранном приложении не нужен. */
let channel: BroadcastChannel | null = null;

function bus(): BroadcastChannel {
  if (channel === null) {
    channel = new BroadcastChannel(CHANNEL);
    // Страницу могли открыть позже пульта — отвечаем снимком на её запрос.
    channel.onmessage = (e: MessageEvent<{ kind?: string }>) => {
      if (e.data.kind === 'hello') send({ kind: 'snapshot', state });
    };
  }
  return channel;
}

function send(message: AirMessage) {
  bus().postMessage(message);
}

const started = new Date().toISOString();

let state: AirState = {
  air: {
    tournament: 'Показ вёрстки',
    startedAt: started,
    delay: 0,
  },
  layers: [{ id: 'idle', since: started, until: null, payload: {} }],
  theme: { accent: '#ff6fb1' },
};

let status: AirStatus = {
  live: false,
  tournamentId: null,
  port: 0,
  localUrl: '',
  startedAt: null,
  delay: 0,
  pending: 0,
  aired: null,
  lobby: null,
};

const configs = new Map<number, string>();
const shows = new Map<number, SceneShow[]>();

function showsOf(tournamentId: number): SceneShow[] {
  return shows.get(tournamentId) ?? [];
}

function num(a: Args, key: string): number {
  const v = a[key];
  return typeof v === 'number' ? v : 0;
}

function str(a: Args, key: string): string {
  const v = a[key];
  return typeof v === 'string' ? v : '';
}

export function airHandlers(): Record<string, (a: Args) => unknown> {
  return {
    air_status: () => ({ ...status, aired: status.live ? state : null }),

    air_start: (a) => {
      state = {
        ...state,
        air: {
          ...state.air,
          tournament: str(a, 'tournament'),
          startedAt: new Date().toISOString(),
          delay: num(a, 'delay'),
        },
      };
      status = {
        ...status,
        live: true,
        tournamentId: num(a, 'tournamentId'),
        port: 7777,
        // Адреса ненастоящие: в браузере кадр идёт каналом, а не по сети.
        localUrl: `${window.location.origin}/air.html?transport=channel`,
        startedAt: state.air.startedAt,
        delay: num(a, 'delay'),
      };
      send({ kind: 'snapshot', state });
      return { ...status, aired: state };
    },

    air_stop: () => {
      send({ kind: 'closed', reason: 'Эфир окончен' });
      status = { ...status, live: false, startedAt: null };
      return { ...status, aired: null };
    },

    air_scene: (a) => {
      const layers = (Array.isArray(a['layers']) ? a['layers'] : []) as AirLayer[];
      state = { ...state, layers };
      send({ kind: 'scene', layers });
      return undefined;
    },

    air_patch: (a) => {
      const layer = str(a, 'layer') as SceneId;
      const payload = a['payload'] as AirState['layers'][number]['payload'];
      state = {
        ...state,
        layers: state.layers.map((l) => (l.id === layer ? { ...l, payload } : l)),
      };
      send({ kind: 'patch', layer, payload });
      return undefined;
    },

    // Задержки в браузере нет: возвращать нечего, кадр ушёл сразу.
    air_revert: () => false,

    air_set_delay: (a) => {
      state = { ...state, air: { ...state.air, delay: num(a, 'seconds') } };
      status = { ...status, delay: num(a, 'seconds') };
      send({ kind: 'snapshot', state });
      return undefined;
    },

    // Опроса лобби в браузере нет: обращаться к osu! отсюда всё равно нельзя.
    air_lobby_start: () => undefined,
    air_lobby_stop: () => undefined,
    set_match_lobby: () => undefined,

    air_config: (a) => configs.get(num(a, 'tournamentId')) ?? null,
    air_set_config: (a) => {
      configs.set(num(a, 'tournamentId'), str(a, 'json'));
      return undefined;
    },

    air_shows: (a) => showsOf(num(a, 'tournamentId')),
    air_note_show: (a) => {
      const id = num(a, 'tournamentId');
      const sceneId = str(a, 'sceneId') as SceneId;
      const objectKey = str(a, 'objectKey');
      const list = [...showsOf(id)];
      const had = list.find((x) => x.sceneId === sceneId && x.objectKey === objectKey);
      if (had === undefined) {
        list.push({ sceneId, objectKey, shows: 1, lastAt: new Date().toISOString() });
      } else {
        had.shows += 1;
        had.lastAt = new Date().toISOString();
      }
      shows.set(id, list);
      return list;
    },
    air_clear_shows: (a) => {
      shows.set(num(a, 'tournamentId'), []);
      return [];
    },

    /** Правдоподобные цифры, чтобы карточка игрока не была пустой. */
    air_profiles: (a) => {
      const ids = Array.isArray(a['osuUserIds']) ? a['osuUserIds'] : [];
      return ids
        .filter((x): x is number => typeof x === 'number')
        .map(
          (osuUserId, i): OsuProfile => ({
            osuUserId,
            username: `player${osuUserId}`,
            pp: 6800 - i * 420,
            globalRank: 12_400 + i * 3100,
            countryRank: 240 + i * 90,
            countryCode: 'RU',
            accuracy: 98.4 - i * 0.6,
            playCount: 84_000 - i * 5000,
          }),
        );
    },
  };
}
