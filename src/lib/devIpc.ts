// Подмена транспорта Tauri для разработки вёрстки в обычном браузере.
// В собранном приложении не подключается — main.tsx зовёт установку только
// когда реального Tauri в окне нет.

import type { Beatmap, LibraryFilter } from './types';
import { COLLECTIONS, LABELS, MAPS } from './mock';

type Args = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

function filtered(f: LibraryFilter): Beatmap[] {
  const q = f.query.trim().toLowerCase();

  return MAPS.filter((m) => {
    if (q !== '') {
      const hay = `${m.artist} ${m.title} ${m.version} ${m.creator ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.mods.length > 0 && !m.mods.some((x) => f.mods.includes(x))) return false;
    if (f.skillsets.length > 0) {
      const own = m.skillsets.map((s) => s.skillset);
      if (!f.skillsets.every((s) => own.includes(s))) return false;
    }
    const lo = num(f.stars.min);
    const hi = num(f.stars.max);
    if (lo !== null && m.difficultyRating < lo) return false;
    if (hi !== null && m.difficultyRating > hi) return false;
    if (f.collectionId !== null && m.beatmapId % 2 === 0) return false;
    return true;
  });
}

const HANDLERS: Record<string, (a: Args) => unknown> = {
  get_status: () => ({
    hasCredentials: true,
    online: true,
    onboarded: true,
    dbPath: 'C:\\Users\\…\\osucup.sqlite',
    cachePath: 'C:\\Users\\…\\covers',
  }),
  set_onboarded: () => undefined,
  get_credentials: () => ({ clientId: '00000', clientSecret: '••••••••' }),
  save_credentials: () => undefined,
  check_credentials: () => ({ kind: 'ok' }),
  clear_credentials: () => undefined,

  list_beatmaps: (a) => {
    const f = a['filter'] as LibraryFilter;
    const offset = (a['offset'] as number) ?? 0;
    const limit = (a['limit'] as number) ?? 100;
    const all = filtered(f);
    return { items: all.slice(offset, offset + limit), total: all.length, offset };
  },
  get_beatmap: (a) => MAPS.find((m) => m.beatmapId === a['beatmapId']) ?? null,
  get_set_difficulties: () => MAPS.slice(0, 4),
  get_attributes: () => [],
  delete_beatmaps: () => undefined,
  set_beatmap_mods: () => undefined,
  set_beatmap_fm_mods: () => undefined,
  set_beatmap_skillsets: () => undefined,
  set_beatmap_note: () => undefined,
  bulk_add_mod: () => undefined,
  bulk_add_skillset: () => undefined,

  list_labels: () => LABELS,
  create_label: (a) => ({ id: 99, name: String(a['name']), color: a['color'] ?? null }),
  set_beatmap_labels: () => undefined,
  bulk_add_label: () => undefined,

  list_collections: () => COLLECTIONS,
  list_folders: () => [],
  create_collection: (a) => ({
    id: Math.floor(Math.random() * 1000) + 10,
    name: String(a['name']),
    color: a['color'] ?? null,
    icon: null,
    folderId: null,
    position: 9,
    isSmart: false,
    filter: null,
    count: 0,
    createdAt: '2026-08-09T00:00:00Z',
  }),
  create_smart_collection: () => COLLECTIONS[2],
  rename_collection: () => undefined,
  set_collection_color: () => undefined,
  move_collection: () => undefined,
  duplicate_collection: () => COLLECTIONS[0],
  delete_collection: () => undefined,
  add_to_collection: () => undefined,
  remove_from_collection: () => undefined,
  create_folder: (a) => ({ id: 1, name: String(a['name']), position: 0 }),
  rename_folder: () => undefined,
  delete_folder: () => undefined,

  parse_links: (a) => {
    const text = String(a['text'] ?? '');
    const ids = [...text.matchAll(/#osu\/(\d+)|\/b\/(\d+)|\/beatmaps\/(\d+)/g)].map((m) =>
      Number(m[1] ?? m[2] ?? m[3]),
    );
    const sets = [...text.matchAll(/beatmapsets\/(\d+)(?!#)/g)].map((m) => Number(m[1]));
    return { beatmapIds: [...new Set(ids)], beatmapsetIds: [...new Set(sets)], unknown: [] };
  },
  import_links: () => 'mock-batch',
  retry_failed: () => 'mock-batch',
  cancel_batch: () => undefined,
  get_queue_status: () => ({ pending: 0, done: 0, failed: 0, budget: 60, activeBatch: null }),
  cache_size: () => 42 * 1024 * 1024,
  clear_cache: () => undefined,

  // Плагин событий: подписка принимается, но события в браузере не приходят.
  'plugin:event|listen': () => 1,
  'plugin:event|unlisten': () => undefined,
  'plugin:opener|open_url': (a) => {
    window.open(String(a['url']), '_blank', 'noopener');
    return undefined;
  },
};

/** Ставится один раз при старте, если настоящего Tauri в окне нет. */
export function installMockIpc(): void {
  const w = window as unknown as Record<string, unknown>;

  // Обработчики колбэков Tauri живут в window по числовому идентификатору.
  let nextId = 1;

  w['__TAURI_INTERNALS__'] = {
    invoke: (cmd: string, args: Args = {}) => {
      const handler = HANDLERS[cmd];
      if (!handler) return Promise.reject(new Error(`Команда ${cmd} не заглушена`));
      return Promise.resolve(handler(args));
    },
    transformCallback: (cb: unknown) => {
      const id = nextId++;
      w[`_${id}`] = cb;
      return id;
    },
    convertFileSrc: (p: string) => p,
  };

  console.info('osu!cup: вёрстка в браузере, данные подставлены для примера');
}
