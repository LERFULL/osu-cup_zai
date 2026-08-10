// Подмена транспорта Tauri для разработки вёрстки в обычном браузере.
// В собранном приложении не подключается — main.tsx зовёт установку только
// когда реального Tauri в окне нет.
//
// Заглушка держит состояние в памяти: правки мод-тегов, скилсетов, заметок и
// состава коллекций ведут себя так же, как в приложении. При перезагрузке
// страницы всё возвращается к началу — настоящей базы здесь нет.

import type {
  Beatmap,
  Collection,
  GenRules,
  LibraryFilter,
  ModTag,
  Pool,
  PoolSlot,
  PoolTemplate,
  Skillset,
  TemplateSlot,
} from './types';
import { COLLECTIONS, LABELS, MAPS } from './mock';
import { tournamentHandlers } from './devTournaments';
import { EMPTY_FILTER, EMPTY_RULES } from './types';

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
  if (f.noMods && m.mods.length > 0) return false;
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

// ─────────────────────────────────────── шаблоны и маппулы

const templates: PoolTemplate[] = [
  {
    id: 1,
    name: 'Стандарт 1v1',
    rules: { ...EMPTY_RULES, noRepeatMapper: true },
    createdAt: '2026-01-01T00:00:00Z',
    slots: (
      [
        ['NM', 4],
        ['HD', 2],
        ['HR', 2],
        ['DT', 2],
        ['FM', 1],
        ['TB', 1],
      ] as [ModTag, number][]
    ).map(([mod, count], i) => ({
      id: 10 + i,
      mod,
      count,
      starMin: null,
      starMax: null,
      sourceCollectionId: null,
      requiredSkillsets: [],
      position: i,
    })),
  },
  {
    id: 2,
    name: 'Короткий',
    rules: { ...EMPTY_RULES, noRepeatMapper: true },
    createdAt: '2026-01-01T00:00:00Z',
    slots: (
      [
        ['NM', 3],
        ['HD', 1],
        ['HR', 1],
        ['DT', 1],
        ['TB', 1],
      ] as [ModTag, number][]
    ).map(([mod, count], i) => ({
      id: 20 + i,
      mod,
      count,
      starMin: null,
      starMax: null,
      sourceCollectionId: null,
      requiredSkillsets: [],
      position: i,
    })),
  },
];

const pools: Pool[] = [];

function template(id: unknown): PoolTemplate {
  const found = templates.find((t) => t.id === id);
  if (!found) throw new Error('Шаблон не найден');
  return found;
}

function pool(id: unknown): Pool {
  const found = pools.find((p) => p.id === id);
  if (!found) throw new Error('Маппул не найден');
  return withMaps(found);
}

function at(p: Pool, position: unknown): PoolSlot {
  const found = p.slots.find((x) => x.position === position);
  if (!found) throw new Error('Слот не найден');
  return found;
}

function blankSlot(mod: ModTag, position: number): PoolSlot {
  return {
    id: nextId++,
    slotLabel: '',
    mod,
    beatmapId: null,
    pinned: false,
    starRatingWithMods: null,
    fmMods: [],
    position,
    beatmap: null,
    warnings: [],
  };
}

/** TB всегда последний, номера идут подряд — как в relabel на Rust. */
function relabel(p: Pool): void {
  p.slots.sort((a, b) => Number(a.mod === 'TB') - Number(b.mod === 'TB') || a.position - b.position);
  const seen = new Map<string, number>();
  p.slots.forEach((slot, i) => {
    const n = seen.get(slot.mod) ?? 0;
    slot.slotLabel = slot.mod === 'TB' ? 'TB' : `${slot.mod}${n + 1}`;
    seen.set(slot.mod, n + 1);
    slot.position = i;
  });
}

/** Карты и предупреждения доливаются при каждом чтении — как в pools::get. */
function withMaps(p: Pool): Pool {
  const counts = new Map<number, number>();
  const mappers = new Map<string, number>();

  for (const slot of p.slots) {
    slot.beatmap = maps.find((m) => m.beatmapId === slot.beatmapId) ?? null;
    if (slot.beatmapId !== null) counts.set(slot.beatmapId, (counts.get(slot.beatmapId) ?? 0) + 1);
    const creator = slot.beatmap?.creator;
    if (creator) mappers.set(creator, (mappers.get(creator) ?? 0) + 1);
  }

  for (const slot of p.slots) {
    const warnings: string[] = [];
    if (slot.beatmapId !== null && (counts.get(slot.beatmapId) ?? 0) > 1) {
      warnings.push('карта уже есть в другом слоте');
    }
    if (slot.beatmap && !slot.beatmap.mods.includes(slot.mod)) {
      warnings.push(`у карты не разрешён ${slot.mod}`);
    }
    const creator = slot.beatmap?.creator;
    if (creator && (mappers.get(creator) ?? 0) > 1) warnings.push('маппер повторяется');
    slot.warnings = warnings;
  }
  return p;
}

/** Карты, подходящие под слот шаблона. */
function candidates(slot: TemplateSlot): Beatmap[] {
  return maps.filter((m) => {
    if (!m.mods.includes(slot.mod)) return false;
    if (slot.starMin !== null && m.difficultyRating < slot.starMin) return false;
    if (slot.starMax !== null && m.difficultyRating > slot.starMax) return false;
    if (slot.requiredSkillsets.length > 0) {
      const own = m.skillsets.map((k) => k.skillset);
      if (!slot.requiredSkillsets.every((k) => own.includes(k))) return false;
    }
    if (slot.sourceCollectionId !== null) {
      const own = new Set(members.get(slot.sourceCollectionId) ?? []);
      if (!own.has(m.beatmapId)) return false;
    }
    return true;
  });
}

/** Набор пула по шаблону. Заглушка берёт карты по порядку, без случайности. */
function fill(
  p: Pool,
  t: PoolTemplate,
  keepPinned: boolean,
  seed: Set<number> = new Set(),
): { pool: Pool; notes: string[] } {
  const kept = keepPinned ? p.slots.filter((x) => x.pinned) : [];
  const used = new Set([...seed, ...kept.map((x) => x.beatmapId)]);
  const mappers = new Set(kept.map((x) => x.beatmap?.creator).filter(Boolean));

  const built: PoolSlot[] = [];
  const empty: string[] = [];
  const ordered = [...t.slots].sort((a, b) => Number(a.mod === 'TB') - Number(b.mod === 'TB'));

  for (const from of ordered) {
    const fit = candidates(from);
    for (let n = 0; n < (from.mod === 'TB' ? 1 : from.count); n++) {
      const label = from.mod === 'TB' ? 'TB' : `${from.mod}${n + 1}`;
      const pinned = kept.find((x) => x.slotLabel === label);
      if (pinned) {
        built.push({ ...pinned, position: built.length });
        continue;
      }

      const pick = fit.find(
        (m) =>
          !used.has(m.beatmapId) &&
          (!t.rules.noRepeatMapper || !mappers.has(m.creator ?? '')),
      );
      if (pick) {
        used.add(pick.beatmapId);
        if (pick.creator) mappers.add(pick.creator);
      } else {
        empty.push(label);
      }

      built.push({
        ...blankSlot(from.mod, built.length),
        slotLabel: label,
        beatmapId: pick?.beatmapId ?? null,
      });
    }
  }

  p.slots = built;
  p.templateId = t.id;
  p.templateName = t.name;

  const notes =
    empty.length > 0
      ? [
          `Карт не хватило на ${empty.join(', ')}. Расширь диапазон звёзд или добавь карт в источник.`,
        ]
      : [];
  return { pool: withMaps(p), notes };
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
    let all = filtered(f);

    // Схлопывание наборов — как в базе: от набора остаётся первая строка,
    // а счётчик говорит, сколько за ней сложностей.
    if (f.groupSets) {
      const seen = new Map<number, Beatmap>();
      const order: number[] = [];
      for (const m of all) {
        // Ручные карты набора не имеют — каждая сама себе набор.
        const key = m.beatmapsetId ?? -m.beatmapId;
        const known = seen.get(key);
        if (known === undefined) {
          seen.set(key, { ...m, setCount: 1 });
          order.push(key);
        } else {
          known.setCount = (known.setCount ?? 1) + 1;
        }
      }
      all = order.map((k) => seen.get(k)).filter((m): m is Beatmap => m !== undefined);
    }

    return { items: all.slice(offset, offset + limit), total: all.length, offset };
  },
  count_without_mods: () => maps.filter((m) => m.mods.length === 0).length,
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

  // ─────────────────────────────────── шаблоны и маппулы

  list_templates: () => templates,
  get_template: (a) => template(a['id']),
  create_template: (a) => {
    const made: PoolTemplate = {
      id: nextId++,
      name: String(a['name']),
      rules: { ...EMPTY_RULES },
      createdAt: '2026-08-09T00:00:00Z',
      slots: [],
    };
    templates.push(made);
    return made;
  },
  save_template: (a) => {
    const t = template(a['id']);
    t.name = String(a['name']);
    t.rules = a['rules'] as GenRules;
    const slots = Array.isArray(a['slots']) ? (a['slots'] as TemplateSlot[]) : [];
    t.slots = slots.map((x, i) => ({ ...x, id: nextId++, position: i }));
    return t;
  },
  duplicate_template: (a) => {
    const src = template(a['id']);
    const copy: PoolTemplate = {
      ...src,
      id: nextId++,
      name: `${src.name} — копия`,
      slots: src.slots.map((x) => ({ ...x, id: nextId++ })),
    };
    templates.push(copy);
    return copy;
  },
  delete_template: (a) => {
    const i = templates.findIndex((x) => x.id === a['id']);
    if (i >= 0) templates.splice(i, 1);
    return undefined;
  },
  template_supply: (a) =>
    template(a['id']).slots.map((slot) => ({
      position: slot.position,
      mod: slot.mod,
      need: slot.count,
      available: candidates(slot).length,
    })),

  list_pools: () => pools,
  get_pool: (a) => pool(a['id']),
  create_pool: (a) => {
    const made: Pool = {
      id: nextId++,
      name: String(a['name']),
      templateId: null,
      templateName: null,
      folderId: null,
      status: 'draft',
      version: 1,
      parentPoolId: null,
      displayFields: ['stars', 'length', 'bpm'],
      isLocked: false,
      createdAt: '2026-08-09T00:00:00Z',
      slots: [],
    };
    pools.push(made);
    return made;
  },
  rename_pool: (a) => {
    const p = pool(a['id']);
    p.name = String(a['name']);
    return p.id;
  },
  set_pool_status: (a) => {
    pool(a['id']).status = a['status'] as Pool['status'];
    return undefined;
  },
  set_pool_display_fields: (a) => {
    pool(a['id']).displayFields = strings(a, 'fields') as Pool['displayFields'];
    return undefined;
  },
  duplicate_pool: (a) => {
    const src = pool(a['id']);
    const copy: Pool = {
      ...src,
      id: nextId++,
      name: `${src.name} — копия`,
      slots: src.slots.map((x) => ({ ...x, id: nextId++ })),
    };
    pools.push(copy);
    return copy;
  },
  delete_pool: (a) => {
    const i = pools.findIndex((x) => x.id === a['id']);
    if (i >= 0) pools.splice(i, 1);
    return undefined;
  },

  set_slot_beatmap: (a) => {
    const p = pool(a['poolId']);
    const slot = at(p, a['position']);
    slot.beatmapId = typeof a['beatmapId'] === 'number' ? a['beatmapId'] : null;
    return withMaps(p);
  },
  set_slot_pinned: (a) => {
    const p = pool(a['poolId']);
    at(p, a['position']).pinned = a['pinned'] === true;
    return withMaps(p);
  },
  set_slot_fm_mods: (a) => {
    const p = pool(a['poolId']);
    at(p, a['position']).fmMods = strings(a, 'mods');
    return withMaps(p);
  },
  set_slot_mod: (a) => {
    const p = pool(a['poolId']);
    at(p, a['position']).mod = String(a['mod']) as ModTag;
    relabel(p);
    return withMaps(p);
  },
  add_pool_slot: (a) => {
    const p = pool(a['poolId']);
    p.slots.push(blankSlot(String(a['mod']) as ModTag, p.slots.length));
    relabel(p);
    return withMaps(p);
  },
  remove_pool_slot: (a) => {
    const p = pool(a['poolId']);
    p.slots = p.slots.filter((x) => x.position !== a['position']);
    relabel(p);
    return withMaps(p);
  },
  reorder_pool_slots: (a) => {
    const p = pool(a['poolId']);
    const order = ids(a, 'order');
    const moved = order
      .map((position) => p.slots.find((x) => x.position === position))
      .filter((x): x is PoolSlot => x !== undefined);
    for (const slot of p.slots) if (!order.includes(slot.position)) moved.push(slot);
    p.slots = moved;
    relabel(p);
    return withMaps(p);
  },
  slot_filter: (a) => {
    const p = pool(a['poolId']);
    const slot = at(p, a['position']);
    const t = templates.find((x) => x.id === p.templateId);
    const from = t?.slots.find((x) => x.mod === slot.mod);
    if (!from) return { ...EMPTY_FILTER, mods: [slot.mod] };
    return {
      ...EMPTY_FILTER,
      mods: [from.mod],
      skillsets: from.requiredSkillsets,
      stars: { min: from.starMin, max: from.starMax },
      collectionId: from.sourceCollectionId,
    };
  },

  generate_pool: (a) => {
    const t = template(a['templateId']);
    const made: Pool = {
      id: nextId++,
      name: String(a['name']),
      templateId: t.id,
      templateName: t.name,
      folderId: null,
      status: 'draft',
      version: 1,
      parentPoolId: null,
      displayFields: ['stars', 'length', 'bpm'],
      isLocked: false,
      createdAt: '2026-08-09T00:00:00Z',
      slots: [],
    };
    pools.push(made);
    return fill(made, t, false);
  },

  // Серия под турнир: каждый следующий пул не берёт карты предыдущих.
  generate_pool_series: (a) => {
    const t = template(a['templateId']);
    const names = (a['names'] as string[]) ?? [];
    const taken = new Set<number>();

    return names.map((name, i) => {
      const made: Pool = {
        id: nextId++,
        name: name.trim() === '' ? `${t.name} ${i + 1}` : name.trim(),
        templateId: t.id,
        templateName: t.name,
        folderId: null,
        status: 'draft',
        version: 1,
        parentPoolId: null,
        displayFields: ['stars', 'length', 'bpm'],
        isLocked: false,
        createdAt: '2026-08-09T00:00:00Z',
        slots: [],
      };
      pools.push(made);

      const report = fill(made, t, false, taken);
      for (const slot of report.pool.slots) {
        if (slot.beatmapId !== null) taken.add(slot.beatmapId);
      }

      const empty = report.pool.slots.filter((x) => x.beatmapId === null).length;
      const notes = [...report.notes];
      if (empty > 0) {
        notes.push(
          `«${made.name}»: не хватило карт на ${empty} слотов — в библиотеке не осталось ` +
            'подходящих, не занятых другими маппулами серии',
        );
      }
      return { pool: report.pool, notes };
    });
  },
  reroll_pool: (a) => {
    const p = pool(a['poolId']);
    const t = templates.find((x) => x.id === p.templateId);
    if (!t) throw new Error('Этот маппул собран вручную — скатывать его не по чему');
    return fill(p, t, a['keepPinned'] === true);
  },
  reroll_slot: (a) => {
    const p = pool(a['poolId']);
    const t = templates.find((x) => x.id === p.templateId);
    if (!t) throw new Error('Этот маппул собран вручную — скатывать его не по чему');
    const slot = at(p, a['position']);
    const used = new Set(
      p.slots.filter((x) => x !== slot).map((x) => x.beatmapId),
    );
    const from = t.slots.find((x) => x.mod === slot.mod);
    const pick = from ? candidates(from).find((m) => !used.has(m.beatmapId)) : undefined;
    slot.beatmapId = pick?.beatmapId ?? null;
    return { pool: withMaps(p), notes: [] };
  },

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

  // Игроки, турниры и матчи живут отдельным модулем: там своя механика
  // сетки и журнала действий, и в общем списке она бы потерялась.
  ...tournamentHandlers(
    (poolId) =>
      withMaps(pools.find((p) => p.id === poolId) ?? { slots: [] } as unknown as Pool).slots.map(
        (slot) => ({
          slotLabel: slot.slotLabel,
          mod: slot.mod,
          beatmap: slot.beatmap,
          starRatingWithMods: slot.starRatingWithMods,
          state: { kind: 'free' },
        }),
      ),
    () => pools.map((p) => ({ id: p.id, name: p.name })),
  ),
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
