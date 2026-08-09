// Подмена транспорта Tauri для разработки вёрстки в обычном браузере.
// В собранном приложении не подключается — main.tsx зовёт установку только
// когда реального Tauri в окне нет.
//
// Заглушка держит состояние в памяти: правки мод-тегов, скилсетов, заметок и
// состава коллекций ведут себя так же, как в приложении. При перезагрузке
// страницы всё возвращается к началу — настоящей базы здесь нет.

import type { Beatmap, Collection, LibraryFilter, ModTag, Skillset } from './types';
import { COLLECTIONS, LABELS, MAPS } from './mock';

type Args = Record<string, unknown>;

const maps: Beatmap[] = MAPS.map((m) => ({ ...m }));
const collections: Collection[] = COLLECTIONS.map((c) => ({ ...c }));

/** Состав обычных коллекций: id коллекции → id карт. */
const members = new Map<number, number[]>([
  [1, maps.slice(0, 8).map((m) => m.beatmapId)],
  [2, maps.slice(4, 9).map((m) => m.beatmapId)],
]);

let nextId = 100;

function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

function ids(a: Args, key: string): number[] {
  const v = a[key];
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
}

function strings(a: Args, key: string): string[] {
  const v = a[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function text(a: Args, key: string): string {
  const v = a[key];
  return typeof v === 'string' ? v : '';
}

function withCount(c: Collection): Collection {
  return { ...c, count: c.isSmart ? 0 : (members.get(c.id)?.length ?? 0) };
}

function matches(m: Beatmap, f: LibraryFilter): boolean {
  const q = f.query.trim().toLowerCase();
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
  return true;
}

/**
 * Так же, как в build_where на Rust: умная коллекция заменяет собой текущий
 * фильтр целиком, поверх остаётся только поиск. Иначе два набора условий
 * противоречили бы друг другу.
 */
function filtered(f: LibraryFilter): Beatmap[] {
  if (f.collectionId !== null) {
    const c = collections.find((x) => x.id === f.collectionId);
    if (c && c.isSmart && c.filter !== null) {
      const inner = { ...c.filter, collectionId: null };
      if (f.query.trim() !== '') inner.query = f.query;
      return maps.filter((m) => matches(m, inner));
    }
    const own = new Set(members.get(f.collectionId) ?? []);
    return maps.filter((m) => own.has(m.beatmapId) && matches(m, f));
  }
  return maps.filter((m) => matches(m, f));
}

function edit(id: unknown, patch: (m: Beatmap) => void): undefined {
  const m = maps.find((x) => x.beatmapId === id);
  if (m) patch(m);
  return undefined;
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
  get_beatmap: (a) => maps.find((m) => m.beatmapId === a['beatmapId']) ?? null,
  get_set_difficulties: (a) => {
    const set = a['beatmapsetId'];
    const own = maps.filter((m) => m.beatmapsetId === set);
    return own.length > 0 ? own : maps.slice(0, 4);
  },
  get_attributes: () => [],

  delete_beatmaps: (a) => {
    const gone = new Set(ids(a, 'beatmapIds'));
    for (let i = maps.length - 1; i >= 0; i--) {
      const m = maps[i];
      if (m && gone.has(m.beatmapId)) maps.splice(i, 1);
    }
    for (const [id, list] of members) {
      members.set(
        id,
        list.filter((x) => !gone.has(x)),
      );
    }
    return undefined;
  },

  set_beatmap_mods: (a) =>
    edit(a['beatmapId'], (m) => {
      m.mods = strings(a, 'mods') as ModTag[];
    }),
  set_beatmap_fm_mods: (a) =>
    edit(a['beatmapId'], (m) => {
      m.fmMods = strings(a, 'mods');
    }),
  set_beatmap_skillsets: (a) =>
    edit(a['beatmapId'], (m) => {
      // Проставленное руками перестаёт быть предложенным — как и в базе.
      m.skillsets = strings(a, 'skillsets').map((k) => ({
        skillset: k as Skillset,
        suggested: false,
      }));
    }),
  set_beatmap_note: (a) =>
    edit(a['beatmapId'], (m) => {
      m.note = text(a, 'note');
    }),

  bulk_add_mod: (a) => {
    const mod = String(a['mod']) as ModTag;
    const set = new Set(ids(a, 'beatmapIds'));
    for (const m of maps) if (set.has(m.beatmapId) && !m.mods.includes(mod)) m.mods.push(mod);
    return undefined;
  },
  bulk_add_skillset: (a) => {
    const k = String(a['skillset']) as Skillset;
    const set = new Set(ids(a, 'beatmapIds'));
    for (const m of maps) {
      if (set.has(m.beatmapId) && !m.skillsets.some((x) => x.skillset === k)) {
        m.skillsets.push({ skillset: k, suggested: false });
      }
    }
    return undefined;
  },

  list_labels: () => LABELS,
  create_label: (a) => ({ id: nextId++, name: String(a['name']), color: a['color'] ?? null }),
  set_beatmap_labels: () => undefined,
  bulk_add_label: () => undefined,

  list_collections: () => collections.map(withCount),
  list_folders: () => [],

  create_collection: (a) => {
    const made: Collection = {
      id: nextId++,
      name: String(a['name']),
      color: (a['color'] as string) ?? null,
      icon: null,
      folderId: null,
      position: collections.length,
      isSmart: false,
      filter: null,
      count: 0,
      createdAt: '2026-08-09T00:00:00Z',
    };
    collections.push(made);
    members.set(made.id, []);
    return made;
  },

  create_smart_collection: (a) => {
    const made: Collection = {
      id: nextId++,
      name: String(a['name']),
      color: (a['color'] as string) ?? null,
      icon: null,
      folderId: null,
      position: collections.length,
      isSmart: true,
      filter: a['filter'] as LibraryFilter,
      count: 0,
      createdAt: '2026-08-09T00:00:00Z',
    };
    collections.push(made);
    return made;
  },

  rename_collection: (a) => {
    const c = collections.find((x) => x.id === a['id']);
    if (c) c.name = String(a['name']);
    return undefined;
  },
  set_collection_color: (a) => {
    const c = collections.find((x) => x.id === a['id']);
    if (c) c.color = String(a['color']);
    return undefined;
  },
  move_collection: () => undefined,
  duplicate_collection: (a) => {
    const src = collections.find((x) => x.id === a['id']);
    if (!src) return null;
    const copy: Collection = { ...src, id: nextId++, name: `${src.name} — копия` };
    collections.push(copy);
    members.set(copy.id, [...(members.get(src.id) ?? [])]);
    return withCount(copy);
  },
  delete_collection: (a) => {
    const i = collections.findIndex((x) => x.id === a['id']);
    if (i >= 0) collections.splice(i, 1);
    members.delete(a['id'] as number);
    return undefined;
  },

  add_to_collection: (a) => {
    const id = a['collectionId'] as number;
    const own = members.get(id) ?? [];
    const have = new Set(own);
    for (const b of ids(a, 'beatmapIds')) if (!have.has(b)) own.push(b);
    members.set(id, own);
    return undefined;
  },
  remove_from_collection: (a) => {
    const id = a['collectionId'] as number;
    const gone = new Set(ids(a, 'beatmapIds'));
    members.set(id, (members.get(id) ?? []).filter((x) => !gone.has(x)));
    return undefined;
  },

  create_folder: (a) => ({ id: nextId++, name: String(a['name']), position: 0 }),
  rename_folder: () => undefined,
  delete_folder: () => undefined,

  parse_links: (a) => {
    const raw = text(a, 'text');
    const found = [...raw.matchAll(/#osu\/(\d+)|\/b\/(\d+)|\/beatmaps\/(\d+)/g)].map((m) =>
      Number(m[1] ?? m[2] ?? m[3]),
    );
    const sets = [...raw.matchAll(/beatmapsets\/(\d+)(?!#)/g)].map((m) => Number(m[1]));
    return { beatmapIds: [...new Set(found)], beatmapsetIds: [...new Set(sets)], unknown: [] };
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
  let callbackId = 1;

  w['__TAURI_INTERNALS__'] = {
    invoke: (cmd: string, args: Args = {}) => {
      const handler = HANDLERS[cmd];
      if (!handler) return Promise.reject(new Error(`Команда ${cmd} не заглушена`));
      return Promise.resolve(handler(args));
    },
    transformCallback: (cb: unknown) => {
      const id = callbackId++;
      w[`_${id}`] = cb;
      return id;
    },
    convertFileSrc: (p: string) => p,
  };

  console.info('osu!cup: вёрстка в браузере, данные подставлены для примера');
}
