// Подмена транспорта Tauri для разработки вёрстки в обычном браузере.
// В собранном приложении не подключается — main.tsx зовёт установку только
// когда реального Tauri в окне нет.
//
// Заглушка держит состояние в памяти: правки мод-тегов, скилсетов, заметок и
// состава коллекций ведут себя так же, как в приложении. При перезагрузке
// страницы всё возвращается к началу — настоящей базы здесь нет.

import type {
  Beatmap,
  Blocker,
  Bracket,
  Collection,
  Exclusion,
  ExclusionOwner,
  ExclusionTarget,
  GenNote,
  GenReport,
  GenRules,
  LibraryFilter,
  ModTag,
  Pool,
  PoolSlot,
  PoolTemplate,
  Series,
  SeriesKind,
  Skillset,
  SlotSupply,
  SlotWarning,
  Source,
  SourceSet,
  TemplateSlot,
} from './types';
import { COLLECTIONS, LABELS, MAPS } from './mock';
import { tournamentHandlers } from './devTournaments';
import { airHandlers } from './devAir';
import { EMPTY_FILTER, EMPTY_RULES, MOD_TAGS } from './types';

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
    rules: { ...EMPTY_RULES },
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
    sources: null,
    exclusions: [],
  },
  {
    id: 2,
    name: 'Короткий',
    rules: { ...EMPTY_RULES },
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
    sources: null,
    exclusions: [],
  },
];

const pools: Pool[] = [];
const seriesList: Series[] = [];

/** Исключения всех уровней: ключ — «вид владельца + id». */
const exclusions = new Map<string, Exclusion[]>();

/**
 * Метка пула в серии: своя, если её задали руками, иначе — по месту.
 * Автоматическую не храним: записанная в базу, она отстала бы от первой же
 * перестановки, и перетаскивание выглядело бы так, будто оно ничего не сделало.
 */
function labelAt(p: Pool): string | null {
  if (p.seriesId === null) return null;
  const own = p.seriesLabel;
  return own !== null && own.trim() !== '' ? own : `раунд ${p.seriesPosition + 1}`;
}

/** Пул с посчитанной меткой — так его видит фронт. */
function shown(p: Pool): Pool {
  return { ...p, seriesLabel: labelAt(p) };
}

function ownerKey(kind: ExclusionOwner, id: number): string {
  return `${kind}:${id}`;
}

function ownExclusions(kind: ExclusionOwner, id: number): Exclusion[] {
  return exclusions.get(ownerKey(kind, id)) ?? [];
}

/** Подпись цели — как label на Rust, только по данным заглушки. */
function exclusionLabel(target: ExclusionTarget): string {
  switch (target.kind) {
    case 'sameMapperInside':
      return 'Два пула одного маппера';
    case 'pool':
      return pools.find((p) => p.id === target.id)?.name ?? `Маппул ${target.id} удалён`;
    case 'series':
      return `Серия «${seriesList.find((x) => x.id === target.id)?.name ?? target.id}»`;
    case 'tournament':
      return `Турнир ${target.id}`;
    case 'recentTournaments':
      return `Последние ${target.count} турниров`;
    case 'playedBy':
      return `Что играл игрок ${target.playerId}`;
    case 'mapper':
      return `Маппер ${target.name}`;
    case 'beatmaps':
      return `Отобранные карты: ${target.ids.length}`;
  }
}

/** Карты, которые запрещает исключение. `null` — правило про состав пула. */
function exclusionIds(target: ExclusionTarget): number[] | null {
  switch (target.kind) {
    case 'sameMapperInside':
      return null;
    case 'pool': {
      const found = pools.find((p) => p.id === target.id);
      return found === undefined
        ? []
        : found.slots.map((x) => x.beatmapId).filter((x): x is number => x !== null);
    }
    case 'series': {
      const inside = pools.filter((p) => p.seriesId === target.id);
      return inside.flatMap((p) =>
        p.slots.map((x) => x.beatmapId).filter((x): x is number => x !== null),
      );
    }
    case 'beatmaps':
      return target.ids;
    case 'mapper':
      return maps.filter((m) => (m.creator ?? '').toLowerCase() === target.name.toLowerCase())
        .map((m) => m.beatmapId);
    default:
      // Турниров и игроков в заглушке нет — правило есть, а карт под ним нет.
      return [];
  }
}

/** Исключения пула: серия и шаблон сверху, свои снизу. */
function readyFor(p: Pool): Exclusion[] {
  const out: Exclusion[] = [];
  if (p.seriesId !== null) {
    const name = p.seriesName ?? 'серия';
    for (const x of ownExclusions('series', p.seriesId)) {
      out.push({ ...x, inheritedFrom: `серия «${name}»` });
    }
  }
  if (p.templateId !== null) {
    const name = p.templateName ?? 'шаблон';
    for (const x of ownExclusions('template', p.templateId)) {
      out.push({ ...x, inheritedFrom: `шаблон «${name}»` });
    }
  }
  out.push(...ownExclusions('pool', p.id));
  return out;
}

/** Карты соседних пулов серии — тот же запрет, что и на Rust. */
function seriesBan(p: Pool): number[] {
  if (p.seriesId === null) return [];
  const own = seriesList.find((x) => x.id === p.seriesId);
  if (own === undefined || !own.noRepeatInside) return [];
  return pools
    .filter((x) => x.seriesId === p.seriesId && x.id !== p.id && x.status !== 'archived')
    .flatMap((x) => x.slots.map((y) => y.beatmapId).filter((y): y is number => y !== null));
}

function template(id: unknown): PoolTemplate {
  const found = templates.find((t) => t.id === id);
  if (!found) throw new Error('Шаблон не найден');
  found.exclusions = ownExclusions('template', found.id);
  return found;
}

function pool(id: unknown): Pool {
  const found = pools.find((p) => p.id === id);
  if (!found) throw new Error('Маппул не найден');
  return shown(withMaps(found));
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
    sources: null,
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
  const mappers = new Map<string, number>();

  for (const slot of p.slots) {
    slot.beatmap = maps.find((m) => m.beatmapId === slot.beatmapId) ?? null;
    const creator = slot.beatmap?.creator;
    if (creator) mappers.set(creator, (mappers.get(creator) ?? 0) + 1);
  }

  // Где ещё в серии стоит эта карта: строка должна назвать место, а не факт.
  const elsewhere = new Map<number, string>();
  if (p.seriesId !== null) {
    for (const other of pools) {
      if (other.seriesId !== p.seriesId || other.id === p.id) continue;
      for (const slot of other.slots) {
        if (slot.beatmapId !== null && !elsewhere.has(slot.beatmapId)) {
          elsewhere.set(slot.beatmapId, labelAt(other) ?? other.name);
        }
      }
    }
  }

  const template = templates.find((x) => x.id === p.templateId);

  for (const slot of p.slots) {
    const warnings: SlotWarning[] = [];

    if (slot.beatmapId !== null) {
      const twin = p.slots.find(
        (x) => x.beatmapId === slot.beatmapId && x.slotLabel !== slot.slotLabel,
      );
      if (twin !== undefined) {
        warnings.push({ text: `эта карта уже стоит в ${twin.slotLabel}`, strict: true });
      }
      const place = elsewhere.get(slot.beatmapId);
      if (place !== undefined) {
        warnings.push({
          text: `уже играется в ${place}`,
          strict: p.seriesKind === 'tournament',
        });
      }
    }

    if (slot.beatmap && !slot.beatmap.mods.includes(slot.mod)) {
      warnings.push({ text: `у карты нет мод-тега ${slot.mod}`, strict: true });
    }

    const from = template?.slots.find((x) => x.mod === slot.mod);
    if (from !== undefined && slot.beatmap) {
      const stars = slot.starRatingWithMods ?? slot.beatmap.difficultyRating;
      const below = from.starMin !== null && stars + 0.005 < from.starMin;
      const above = from.starMax !== null && stars > from.starMax + 0.005;
      if (below || above) {
        const lo = from.starMin?.toFixed(1) ?? '—';
        const hi = from.starMax?.toFixed(1) ?? '—';
        warnings.push({ text: `${stars.toFixed(1)} при диапазоне ${lo}—${hi}`, strict: true });
      }
    }

    const creator = slot.beatmap?.creator;
    if (creator && (mappers.get(creator) ?? 0) > 1) {
      warnings.push({ text: `второй пул от ${creator}`, strict: false });
    }
    slot.warnings = warnings;
  }
  return p;
}

/** Карты набора источников. Пустой набор — вся библиотека. */
function fromSources(set: SourceSet | null): number[] {
  if (set === null || set.items.length === 0) return maps.map((m) => m.beatmapId);

  const out: number[] = [];
  const seen = new Set<number>();
  for (const src of set.items) {
    for (const id of idsOfSource(src)) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

function idsOfSource(src: Source): number[] {
  if (src.kind === 'library') return maps.map((m) => m.beatmapId);
  if (src.kind === 'collection') {
    const own = collections.find((c) => c.id === src.id);
    if (own?.isSmart === true && own.filter !== null) {
      const inner = own.filter;
      return maps.filter((m) => matches(m, inner)).map((m) => m.beatmapId);
    }
    return [...(members.get(src.id) ?? [])];
  }
  return maps.filter((m) => matches(m, src.filter)).map((m) => m.beatmapId);
}

/** Источники слота: свои, потом пул, серия и шаблон — как slot_levels на Rust. */
function levelsFor(
  slot: PoolSlot | null,
  p: Pool | null,
  t: PoolTemplate | undefined,
  from: TemplateSlot | undefined,
): { set: SourceSet | null; origin: string } {
  if (slot?.sources != null) return { set: slot.sources, origin: 'свои' };
  if (p?.sources != null) return { set: p.sources, origin: 'от маппула' };

  const own = p?.seriesId != null ? seriesList.find((x) => x.id === p.seriesId) : undefined;
  if (own?.sources != null) return { set: own.sources, origin: `от серии — ${own.name}` };

  if (from?.sourceCollectionId != null) {
    return {
      set: { items: [{ kind: 'collection', id: from.sourceCollectionId }], mode: 'union' },
      origin: 'от шаблона — слот',
    };
  }
  if (t?.sources != null) return { set: t.sources, origin: `от шаблона «${t.name}»` };
  return { set: null, origin: 'вся библиотека' };
}

/** Условия слота, применённые по одному, — с подписями для blockers. */
function narrow(
  ids: number[],
  from: TemplateSlot,
  rules: GenRules,
): { matching: number[]; left: number[]; blockers: Blocker[] } {
  const blockers: Blocker[] = [];
  let left = ids;

  const step = (reason: string, keep: (m: Beatmap) => boolean) => {
    const next = left.filter((id) => {
      const m = maps.find((x) => x.beatmapId === id);
      return m !== undefined && keep(m);
    });
    if (left.length - next.length > 0) {
      blockers.push({ reason, cut: left.length - next.length });
    }
    left = next;
  };

  step(`нет карт с мод-тегом ${from.mod}`, (m) => m.mods.includes(from.mod));

  if (from.starMin !== null || from.starMax !== null) {
    const lo = from.starMin?.toFixed(1) ?? '—';
    const hi = from.starMax?.toFixed(1) ?? '—';
    step(
      `звёзды ${lo}—${hi}`,
      (m) =>
        (from.starMin === null || m.difficultyRating >= from.starMin) &&
        (from.starMax === null || m.difficultyRating <= from.starMax),
    );
  }

  if (from.requiredSkillsets.length > 0) {
    step(`нужны скилсеты: ${from.requiredSkillsets.join(', ')}`, (m) => {
      const own = m.skillsets.map((k) => k.skillset);
      return from.requiredSkillsets.every((k) => own.includes(k));
    });
  }

  // То, что осталось после условий самого слота, и есть matching: дальше
  // идут правила шаблона, и их вклад считается отдельными строками.
  const matching = left;

  if (rules.rankedOnly && rules.rankedOnlyStrict) {
    step('строго ranked', (m) => m.status === 'ranked' || m.status === 'approved');
  }
  if (rules.lengthMaxStrict && rules.lengthMax !== null) {
    const max = rules.lengthMax;
    const mmss = `${Math.floor(max / 60)}:${String(max % 60).padStart(2, '0')}`;
    step(`длиннее ${mmss}`, (m) => (m.totalLength === null ? true : m.totalLength <= max));
  }

  return { matching, left, blockers };
}

/** Слот шаблона под мод-тег: у пула, собранного руками, шаблона нет. */
function templateSlotFor(t: PoolTemplate | undefined, mod: ModTag): TemplateSlot {
  const found = t?.slots.find((x) => x.mod === mod);
  if (found !== undefined) return found;
  return {
    id: 0,
    mod,
    count: 1,
    starMin: null,
    starMax: null,
    sourceCollectionId: null,
    requiredSkillsets: [],
    position: 0,
  };
}

interface SlotPool {
  supply: SlotSupply;
  allowed: number[];
  hidden: number[];
  matching: number[];
}

/**
 * Запас одного слота: что подходит и что отсекло остальное.
 *
 * `released` — карты слотов, которые сейчас освобождаются. Они снова свободны,
 * и держать их в запретах значит опустошать пул его же прошлым составом.
 */
function supplyOf(p: Pool, slot: PoolSlot, released: Set<number> = new Set()): SlotPool {
  const t = templates.find((x) => x.id === p.templateId);
  const from = templateSlotFor(t, slot.mod);
  const rules = t?.rules ?? EMPTY_RULES;
  const level = levelsFor(slot, p, t, from);

  const narrowed = narrow(fromSources(level.set), from, rules);
  const blockers = [...narrowed.blockers];

  const banned = new Set<number>();
  const bite = (raw: number[], label: string) => {
    const ids = raw.filter((id) => !released.has(id));
    const cut = narrowed.left.filter((id) => ids.includes(id) && !banned.has(id)).length;
    if (cut > 0) blockers.push({ reason: `исключено: ${label}`, cut });
    for (const id of ids) banned.add(id);
  };

  for (const ex of readyFor(p)) {
    if (!ex.enabled || ex.missing || !ex.strict) continue;
    const ids = exclusionIds(ex.target);
    if (ids !== null) bite(ids, ex.label);
  }

  const inside = seriesBan(p);
  if (inside.length > 0) bite(inside, 'уже в других пулах серии');

  const allowed = narrowed.left.filter((id) => !banned.has(id));
  blockers.sort((a, b) => b.cut - a.cut);

  return {
    allowed,
    hidden: narrowed.left.filter((id) => banned.has(id)),
    matching: narrowed.matching,
    supply: {
      position: slot.position,
      slotLabel: slot.slotLabel,
      mod: slot.mod,
      need: 1,
      matching: narrowed.matching.length,
      excluded: Math.max(0, narrowed.matching.length - allowed.length),
      available: allowed.length,
      blockers,
      origin: level.origin,
    },
  };
}

/**
 * Набор пула. Как на Rust: узкий слот выбирает первым, мягкие правила —
 * веса, а не фильтр, и на каждый пустой слот пишется заметка с цифрами.
 */
function fill(p: Pool, keepPinned: boolean, only: number[] | null = null): GenReport {
  const t = templates.find((x) => x.id === p.templateId);
  const rules = t?.rules ?? EMPTY_RULES;

  const held = (slot: PoolSlot) =>
    only !== null ? !only.includes(slot.position) : keepPinned && slot.pinned;

  const live = readyFor(p).filter((x) => x.enabled && !x.missing);

  const soft = live
    .filter((x) => !x.strict)
    .map((x) => ({ label: x.label, ids: exclusionIds(x.target) }))
    .filter((x): x is { label: string; ids: number[] } => x.ids !== null);

  const sameMapper = live
    .filter((x) => x.target.kind === 'sameMapperInside')
    .reduce<boolean | null>((acc, x) => (acc === true ? true : x.strict), null);

  const released = new Set(
    p.slots
      .filter((slot) => !held(slot))
      .map((slot) => slot.beatmapId)
      .filter((id): id is number => id !== null),
  );

  const rows = p.slots.map((slot) => ({ slot, ...supplyOf(p, slot, released) }));
  const usedIds = new Set<number>();
  const usedMappers = new Map<string, string>();

  for (const row of rows) {
    if (held(row.slot) && row.slot.beatmapId !== null) {
      usedIds.add(row.slot.beatmapId);
      const creator = maps.find((m) => m.beatmapId === row.slot.beatmapId)?.creator;
      if (creator) usedMappers.set(creator.toLowerCase(), row.slot.slotLabel);
    } else {
      row.slot.beatmapId = null;
    }
  }

  const notes: GenNote[] = [];
  const note = (slotLabel: string | null, text: string, strict: boolean, blockers: Blocker[]) =>
    notes.push({ poolId: p.id, poolName: p.name, slotLabel, text, strict, blockers });

  // Самый узкий слот выбирает первым — иначе широкие расхватают общее.
  const order = rows
    .filter((row) => !held(row.slot))
    .sort((a, b) => a.allowed.length - b.allowed.length);

  for (const row of order) {
    const free = row.allowed.filter((id) => {
      if (usedIds.has(id)) return false;
      if (sameMapper === true) {
        const creator = maps.find((m) => m.beatmapId === id)?.creator;
        if (creator && usedMappers.has(creator.toLowerCase())) return false;
      }
      return true;
    });

    // Мягкие правила — веса: карта под исключением проигрывает, но берётся,
    // если других нет.
    const scored = free
      .map((id) => {
        const creator = (maps.find((m) => m.beatmapId === id)?.creator ?? '').toLowerCase();
        let penalty = soft.filter((x) => x.ids.includes(id)).length * 10;
        if (sameMapper === false && usedMappers.has(creator)) penalty += 8;
        return { id, penalty };
      })
      .sort((a, b) => a.penalty - b.penalty);

    const best = scored[0];
    if (best === undefined) {
      const top = row.supply.blockers
        .slice(0, 3)
        .map((b) => `${b.reason} (−${b.cut})`)
        .join(', ');
      note(
        row.slot.slotLabel,
        `пустой: под правила подходит ${row.allowed.length} карт` +
          (top === '' ? '' : `. Отсекли: ${top}`),
        true,
        row.supply.blockers,
      );
      continue;
    }

    const creator = maps.find((m) => m.beatmapId === best.id)?.creator ?? '';
    for (const x of soft) {
      if (x.ids.includes(best.id)) {
        note(
          row.slot.slotLabel,
          `взят с нарушением: попала под исключение «${x.label}» (правило мягкое)`,
          false,
          [],
        );
      }
    }
    const at = usedMappers.get(creator.toLowerCase());
    if (sameMapper === false && at !== undefined) {
      note(
        row.slot.slotLabel,
        `взят с нарушением: маппер повторяется: ${creator} уже в ${at} (правило мягкое)`,
        false,
        [],
      );
    }

    row.slot.beatmapId = best.id;
    usedIds.add(best.id);
    if (creator) usedMappers.set(creator.toLowerCase(), row.slot.slotLabel);
  }

  if (rules.minBpmSpread !== null) {
    const tempos = p.slots
      .map((x) => maps.find((m) => m.beatmapId === x.beatmapId)?.bpm ?? null)
      .filter((x): x is number => x !== null);
    const got = tempos.length < 2 ? 0 : Math.max(...tempos) - Math.min(...tempos);
    if (got + 0.01 < rules.minBpmSpread) {
      note(
        null,
        `разброс BPM вышел ${got.toFixed(0)} вместо ${rules.minBpmSpread.toFixed(0)} — ` +
          'карт с другим темпом в источниках нет',
        rules.minBpmSpreadStrict,
        [],
      );
    }
  }

  // Читать отчёт сверху вниз вместе с пулом удобнее, чем в порядке выбора.
  const rank = new Map(p.slots.map((x, i) => [x.slotLabel, i]));
  const place = (label: string | null) =>
    label === null ? Number.MAX_SAFE_INTEGER : (rank.get(label) ?? 1e8);
  notes.sort((a, b) => place(a.slotLabel) - place(b.slotLabel));

  return { pool: withMaps(p), notes };
}

/** Пустые слоты по шаблону — структура будущего пула без карт. */
function blankSlots(t: PoolTemplate): PoolSlot[] {
  const ordered = [...t.slots].sort((a, b) => Number(a.mod === 'TB') - Number(b.mod === 'TB'));
  const out: PoolSlot[] = [];
  for (const from of ordered) {
    for (let n = 0; n < (from.mod === 'TB' ? 1 : from.count); n++) {
      out.push({
        ...blankSlot(from.mod, out.length),
        slotLabel: from.mod === 'TB' ? 'TB' : `${from.mod}${n + 1}`,
      });
    }
  }
  return out;
}

function newPool(name: string, t: PoolTemplate | null, seriesId: number | null): Pool {
  const own = seriesId === null ? undefined : seriesList.find((x) => x.id === seriesId);
  const at = pools.filter((x) => x.seriesId === seriesId).length;
  const made: Pool = {
    id: nextId++,
    name,
    templateId: t?.id ?? null,
    templateName: t?.name ?? null,
    seriesId,
    seriesName: own?.name ?? null,
    seriesKind: own?.kind ?? null,
    seriesLabel: null,
    seriesPosition: at,
    status: 'draft',
    version: 1,
    parentPoolId: null,
    displayFields: ['stars', 'length', 'bpm'],
    sources: null,
    isLocked: false,
    createdAt: '2026-08-09T00:00:00Z',
    slots: t === null ? [] : blankSlots(t),
  };
  pools.push(made);
  return made;
}

/** Серия целиком: состав считается по пулам, как в series::get. */
function seriesOf(id: unknown): Series {
  const found = seriesList.find((x) => x.id === id);
  if (!found) throw new Error('Серия не найдена');

  found.exclusions = ownExclusions('series', found.id);
  found.pools = pools
    .filter((p) => p.seriesId === found.id)
    .sort((a, b) => a.seriesPosition - b.seriesPosition)
    .map((p) => {
      const full = withMaps(p);
      const stars = full.slots
        .map((x) => x.starRatingWithMods ?? x.beatmap?.difficultyRating ?? null)
        .filter((x): x is number => x !== null);

      const shape = new Map<ModTag, number>();
      for (const slot of full.slots) shape.set(slot.mod, (shape.get(slot.mod) ?? 0) + 1);

      return {
        poolId: p.id,
        position: p.seriesPosition,
        label: labelAt(p),
        name: p.name,
        status: p.status,
        version: p.version,
        isLocked: p.isLocked,
        shape:
          shape.size === 0
            ? 'слотов нет'
            : [...shape].map(([mod, n]) => `${mod}×${n}`).join(' · '),
        slots: full.slots.length,
        filled: full.slots.filter((x) => x.beatmapId !== null).length,
        starsMin: stars.length === 0 ? null : Math.min(...stars),
        starsMax: stars.length === 0 ? null : Math.max(...stars),
        starsAvg: stars.length === 0 ? null : stars.reduce((a, b) => a + b, 0) / stars.length,
        warnings: full.slots.reduce((n, x) => n + x.warnings.length, 0),
      };
    });
  return found;
}

/** Карты, встречающиеся больше чем в одном пуле серии. */
function overlaps(poolIds: number[]) {
  const where = new Map<number, number[]>();
  for (const id of poolIds) {
    const own = pools.find((p) => p.id === id);
    if (own === undefined) continue;
    for (const slot of own.slots) {
      if (slot.beatmapId === null) continue;
      const list = where.get(slot.beatmapId) ?? [];
      if (!list.includes(id)) list.push(id);
      where.set(slot.beatmapId, list);
    }
  }

  const name = (id: number) => {
    const own = pools.find((p) => p.id === id);
    if (own === undefined) return `маппул ${id}`;
    return labelAt(own) ?? own.name;
  };

  return [...where]
    .filter(([, list]) => list.length > 1)
    .map(([beatmapId, list]) => {
      const m = maps.find((x) => x.beatmapId === beatmapId);
      return {
        beatmapId,
        name: m === undefined ? `карта ${beatmapId}` : `${m.artist} — ${m.title}`,
        pools: list.map(name),
        poolIds: list,
      };
    });
}

const HANDLERS: Record<string, (a: Args) => unknown> = {
  get_status: () => ({
    hasCredentials: true,
    online: true,
    onboarded: true,
    matchHintsSeen: true,
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

  /** Сводка по выдаче — тем же фильтром, что и список. */
  library_summary: (a) => {
    const all = filtered(a['filter'] as LibraryFilter);

    const byMod = MOD_TAGS.map((mod) => ({
      mod,
      count: all.filter((m) => m.mods.includes(mod)).length,
    })).filter((x) => x.count > 0);

    const nums = (pick: (m: Beatmap) => number | null): number[] =>
      all.map(pick).filter((v): v is number => v !== null && Number.isFinite(v));

    const stars = nums((m) => m.difficultyRating);
    const lengths = nums((m) => m.totalLength);
    const bpms = nums((m) => m.bpm);
    const avg = (v: number[]) => (v.length === 0 ? null : v.reduce((x, y) => x + y, 0) / v.length);

    return {
      total: all.length,
      untagged: all.filter((m) => m.mods.length === 0).length,
      byMod,
      starsMin: stars.length === 0 ? null : Math.min(...stars),
      starsMax: stars.length === 0 ? null : Math.max(...stars),
      starsAvg: avg(stars),
      lengthAvg: avg(lengths),
      lengthTotal: lengths.length === 0 ? null : lengths.reduce((x, y) => x + y, 0),
      bpmMin: bpms.length === 0 ? null : Math.min(...bpms),
      bpmMax: bpms.length === 0 ? null : Math.max(...bpms),
    };
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
  bulk_remove_mod: (a) => {
    const mod = String(a['mod']) as ModTag;
    const set = new Set(ids(a, 'beatmapIds'));
    for (const m of maps) if (set.has(m.beatmapId)) m.mods = m.mods.filter((x) => x !== mod);
    return undefined;
  },
  bulk_clear_mods: (a) => {
    const set = new Set(ids(a, 'beatmapIds'));
    for (const m of maps) if (set.has(m.beatmapId)) m.mods = [];
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

  list_templates: () => templates.map((t) => ({ ...t, exclusions: ownExclusions('template', t.id) })),
  get_template: (a) => template(a['id']),
  create_template: (a) => {
    const made: PoolTemplate = {
      id: nextId++,
      name: String(a['name']),
      rules: { ...EMPTY_RULES },
      createdAt: '2026-08-09T00:00:00Z',
      slots: [],
      sources: null,
      exclusions: [],
    };
    templates.push(made);
    return made;
  },
  save_template: (a) => {
    const t = template(a['id']);
    t.name = String(a['name']);
    t.rules = a['rules'] as GenRules;
    t.sources = (a['sources'] as SourceSet | null) ?? null;
    const slots = Array.isArray(a['slots']) ? (a['slots'] as TemplateSlot[]) : [];
    t.slots = slots.map((x, i) => ({ ...x, id: nextId++, position: i }));
    // Пулы этого шаблона показывают его имя в строке — обновляем вместе.
    for (const p of pools) if (p.templateId === t.id) p.templateName = t.name;
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
    exclusions.set(
      ownerKey('template', copy.id),
      ownExclusions('template', src.id).map((x) => ({ ...x, id: nextId++ })),
    );
    return copy;
  },
  delete_template: (a) => {
    const i = templates.findIndex((x) => x.id === a['id']);
    if (i >= 0) templates.splice(i, 1);
    return undefined;
  },
  template_supply: (a) => {
    const t = template(a['id']);
    // Считаем по пустому пулу этого шаблона: запас зависит от слотов, а не
    // от того, что в них уже стоит.
    const ghost: Pool = {
      id: -1,
      name: t.name,
      templateId: t.id,
      templateName: t.name,
      seriesId: null,
      seriesName: null,
      seriesKind: null,
      seriesLabel: null,
      seriesPosition: 0,
      status: 'draft',
      version: 1,
      parentPoolId: null,
      displayFields: [],
      sources: null,
      isLocked: false,
      createdAt: '2026-08-09T00:00:00Z',
      slots: blankSlots(t),
    };
    return t.slots.map((slot) => {
      const row = ghost.slots.find((x) => x.mod === slot.mod) ?? ghost.slots[0];
      if (row === undefined) {
        return {
          position: slot.position,
          slotLabel: slot.mod,
          mod: slot.mod,
          need: slot.count,
          matching: 0,
          excluded: 0,
          available: 0,
          blockers: [],
          origin: 'вся библиотека',
        };
      }
      const built = supplyOf(ghost, row);
      return { ...built.supply, position: slot.position, need: slot.count };
    });
  },

  set_template_sources: (a) => {
    const t = template(a['id']);
    t.sources = (a['sources'] as SourceSet | null) ?? null;
    return t;
  },

  list_pools: () => pools.map((p) => shown(withMaps(p))),
  get_pool: (a) => pool(a['id']),
  create_pool: (a) => {
    const seriesId = typeof a['seriesId'] === 'number' ? a['seriesId'] : null;
    return withMaps(newPool(String(a['name']), null, seriesId));
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
  set_pool_sources: (a) => {
    const p = pool(a['id']);
    p.sources = (a['sources'] as SourceSet | null) ?? null;
    return withMaps(p);
  },
  duplicate_pool: (a) => {
    const src = pool(a['id']);
    const copy: Pool = {
      ...src,
      id: nextId++,
      name: `${src.name} — копия`,
      // Копию кладут рядом, а не вместо: в серию её вносят руками.
      seriesId: null,
      seriesName: null,
      seriesKind: null,
      seriesLabel: null,
      seriesPosition: 0,
      slots: src.slots.map((x) => ({ ...x, id: nextId++ })),
    };
    pools.push(copy);
    return withMaps(copy);
  },
  delete_pool: (a) => {
    const i = pools.findIndex((x) => x.id === a['id']);
    if (i >= 0) pools.splice(i, 1);
    exclusions.delete(ownerKey('pool', a['id'] as number));
    return undefined;
  },

  set_slot_beatmap: (a) => {
    const p = pool(a['poolId']);
    const slot = at(p, a['position']);
    slot.beatmapId = typeof a['beatmapId'] === 'number' ? a['beatmapId'] : null;
    return withMaps(p);
  },
  set_slots_pinned: (a) => {
    const p = pool(a['poolId']);
    const touch = ids(a, 'positions');
    for (const slot of p.slots) {
      if (touch.includes(slot.position)) slot.pinned = a['pinned'] === true;
    }
    return withMaps(p);
  },
  set_slot_fm_mods: (a) => {
    const p = pool(a['poolId']);
    at(p, a['position']).fmMods = strings(a, 'mods');
    return withMaps(p);
  },
  set_slots_mod: (a) => {
    const p = pool(a['poolId']);
    const touch = ids(a, 'positions');
    const mod = String(a['mod']) as ModTag;

    if (mod === 'TB') {
      const already = p.slots.some((x) => x.mod === 'TB' && !touch.includes(x.position));
      if (already || touch.length > 1) {
        throw new Error('Тайбрейк в пуле ровно один — на несколько слотов его не поставить');
      }
    }
    for (const slot of p.slots) if (touch.includes(slot.position)) slot.mod = mod;
    relabel(p);
    return withMaps(p);
  },
  set_slots_sources: (a) => {
    const p = pool(a['poolId']);
    const touch = ids(a, 'positions');
    const set = (a['sources'] as SourceSet | null) ?? null;
    for (const slot of p.slots) if (touch.includes(slot.position)) slot.sources = set;
    return withMaps(p);
  },
  add_pool_slot: (a) => {
    const p = pool(a['poolId']);
    p.slots.push(blankSlot(String(a['mod']) as ModTag, p.slots.length));
    relabel(p);
    return withMaps(p);
  },
  remove_pool_slots: (a) => {
    const p = pool(a['poolId']);
    const gone = ids(a, 'positions');
    p.slots = p.slots.filter((x) => !gone.includes(x.position));
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

  slot_picker: (a) => {
    const p = pool(a['poolId']);
    const slot = at(p, a['position']);
    const t = templates.find((x) => x.id === p.templateId);
    const from = templateSlotFor(t, slot.mod);
    const built = supplyOf(p, slot);

    const rules = t?.rules ?? EMPTY_RULES;
    return {
      filter: {
        ...EMPTY_FILTER,
        mods: [from.mod],
        skillsets: from.requiredSkillsets,
        stars: { min: from.starMin, max: from.starMax },
        statuses: rules.rankedOnly && rules.rankedOnlyStrict ? ['ranked'] : [],
        length: {
          min: null,
          max: rules.lengthMaxStrict ? rules.lengthMax : null,
        },
        collectionId: from.sourceCollectionId,
      },
      available: built.allowed.length,
      hidden: built.hidden,
      origin: built.supply.origin,
    };
  },

  pool_whence: (a) => {
    const p = pool(a['poolId']);
    const t = templates.find((x) => x.id === p.templateId);
    const rows = p.slots.map((slot) => supplyOf(p, slot));

    // Число отсечённого считаем от набора до исключений — иначе оно всегда нуль.
    const before = new Set(rows.flatMap((r) => r.matching));
    const shown: Exclusion[] = readyFor(p).map((x) => {
      const own = exclusionIds(x.target);
      return {
        ...x,
        cut: own === null ? 0 : own.filter((id) => before.has(id)).length,
      };
    });

    const level = levelsFor(null, p, t, undefined);
    const items = (level.set?.items ?? [{ kind: 'library' }]).map((src) => ({
      source: src,
      name:
        src.kind === 'library'
          ? 'вся библиотека'
          : src.kind === 'collection'
            ? (collections.find((c) => c.id === src.id)?.name ?? `коллекция ${src.id} удалена`)
            : 'фильтр',
      count: idsOfSource(src).length,
      missing: src.kind === 'collection' && !collections.some((c) => c.id === src.id),
    }));

    return {
      sources: {
        set: level.set ?? { items: [{ kind: 'library' }], mode: 'union' },
        items,
        origin: level.origin,
        own: p.sources != null,
        total: fromSources(level.set).length,
      },
      exclusions: shown,
      rules: t?.rules ?? EMPTY_RULES,
      rulesOrigin:
        t === undefined ? 'своих правил нет — пул собран вручную' : `от шаблона «${t.name}»`,
      supply: rows.map((r) => r.supply),
      starsPending: 0,
    };
  },

  generate_pool: (a) => {
    const t = template(a['templateId']);
    const seriesId = typeof a['seriesId'] === 'number' ? a['seriesId'] : null;
    return fill(newPool(String(a['name']), t, seriesId), false);
  },

  reroll_pool: (a) => {
    const p = pool(a['poolId']);
    if (templates.every((x) => x.id !== p.templateId)) {
      throw new Error('Этот маппул собран вручную — скатывать его не по чему');
    }
    return fill(p, a['keepPinned'] === true);
  },
  reroll_slots: (a) => {
    const p = pool(a['poolId']);
    if (templates.every((x) => x.id !== p.templateId)) {
      throw new Error('Этот маппул собран вручную — скатывать его не по чему');
    }
    return fill(p, true, ids(a, 'positions'));
  },

  // ─────────────────────────────────────────────── исключения

  add_exclusion: (a) => {
    const kind = String(a['ownerKind']) as ExclusionOwner;
    const ownerId = a['ownerId'] as number;
    const target = a['target'] as ExclusionTarget;
    const key = ownerKey(kind, ownerId);
    const list = exclusions.get(key) ?? [];
    list.push({
      id: nextId++,
      target,
      strict: a['strict'] === true,
      enabled: true,
      label: exclusionLabel(target),
      inheritedFrom: null,
      missing: false,
      cut: 0,
    });
    exclusions.set(key, list);
    return undefined;
  },
  remove_exclusion: (a) => {
    for (const [key, list] of exclusions) {
      exclusions.set(
        key,
        list.filter((x) => x.id !== a['id']),
      );
    }
    return undefined;
  },
  set_exclusion_strict: (a) => {
    for (const list of exclusions.values()) {
      for (const x of list) if (x.id === a['id']) x.strict = a['strict'] === true;
    }
    return undefined;
  },
  set_exclusion_enabled: (a) => {
    for (const list of exclusions.values()) {
      for (const x of list) if (x.id === a['id']) x.enabled = a['enabled'] === true;
    }
    return undefined;
  },

  // ───────────────────────────────────────────────────── серии

  list_series: () => seriesList.map((x) => seriesOf(x.id)),
  get_series: (a) => seriesOf(a['id']),
  create_series: (a) => {
    const kind = String(a['kind']) as SeriesKind;
    const made: Series = {
      id: nextId++,
      name: String(a['name']),
      kind,
      color: null,
      note: null,
      sources: null,
      exclusions: [],
      noRepeatInside: kind === 'tournament',
      displayFields: null,
      position: seriesList.length,
      createdAt: '2026-08-09T00:00:00Z',
      pools: [],
    };
    seriesList.push(made);
    return made;
  },
  rename_series: (a) => {
    const x = seriesList.find((y) => y.id === a['id']);
    if (x) {
      x.name = String(a['name']);
      for (const p of pools) if (p.seriesId === x.id) p.seriesName = x.name;
    }
    return undefined;
  },
  set_series_color: (a) => {
    const x = seriesList.find((y) => y.id === a['id']);
    if (x) x.color = (a['color'] as string | null) ?? null;
    return undefined;
  },
  set_series_note: (a) => {
    const x = seriesList.find((y) => y.id === a['id']);
    if (x) x.note = (a['note'] as string | null) ?? null;
    return undefined;
  },
  set_series_kind: (a) => {
    const x = seriesList.find((y) => y.id === a['id']);
    if (!x) return [];
    const kind = String(a['kind']) as SeriesKind;

    if (kind === 'tournament') {
      const clashes = overlaps(pools.filter((p) => p.seriesId === x.id).map((p) => p.id));
      if (clashes.length > 0) return clashes;
    }
    x.kind = kind;
    x.noRepeatInside = kind === 'tournament';
    for (const p of pools) if (p.seriesId === x.id) p.seriesKind = kind;
    return [];
  },
  set_series_no_repeat: (a) => {
    const x = seriesList.find((y) => y.id === a['id']);
    if (!x) return [];
    const value = a['value'] === true;
    if (x.kind === 'tournament' && !value) {
      throw new Error(
        'У турнирной серии карты не повторяются — в этом её смысл. ' +
          'Смени тип на свободную, если повторы нужны.',
      );
    }
    if (value) {
      const clashes = overlaps(pools.filter((p) => p.seriesId === x.id).map((p) => p.id));
      if (clashes.length > 0) return clashes;
    }
    x.noRepeatInside = value;
    return [];
  },
  set_series_sources: (a) => {
    const x = seriesList.find((y) => y.id === a['id']);
    if (x) x.sources = (a['sources'] as SourceSet | null) ?? null;
    return seriesOf(a['id']);
  },
  set_series_display_fields: (a) => {
    const x = seriesList.find((y) => y.id === a['id']);
    if (x) x.displayFields = (a['fields'] as Series['displayFields']) ?? null;
    return undefined;
  },
  duplicate_series: (a) => {
    const src = seriesList.find((y) => y.id === a['id']);
    if (!src) throw new Error('Серия не найдена');
    const copy: Series = {
      ...src,
      id: nextId++,
      name: `${src.name} — копия`,
      position: seriesList.length,
      pools: [],
    };
    seriesList.push(copy);
    exclusions.set(
      ownerKey('series', copy.id),
      ownExclusions('series', src.id).map((x) => ({ ...x, id: nextId++ })),
    );
    return copy;
  },
  delete_series: (a) => {
    const i = seriesList.findIndex((y) => y.id === a['id']);
    if (i >= 0) seriesList.splice(i, 1);
    for (const p of pools) {
      if (p.seriesId === a['id']) {
        p.seriesId = null;
        p.seriesName = null;
        p.seriesKind = null;
        p.seriesLabel = null;
        p.seriesPosition = 0;
      }
    }
    exclusions.delete(ownerKey('series', a['id'] as number));
    return undefined;
  },
  reorder_series: (a) => {
    const order = ids(a, 'ids');
    for (const x of seriesList) {
      const at = order.indexOf(x.id);
      if (at >= 0) x.position = at;
    }
    seriesList.sort((x, y) => x.position - y.position);
    return undefined;
  },

  add_pool_to_series: (a) => {
    const seriesId = a['seriesId'] as number;
    const poolId = a['poolId'] as number;
    const own = seriesList.find((x) => x.id === seriesId);
    if (!own) throw new Error('Серия не найдена');

    if (own.noRepeatInside) {
      const inside = pools.filter((p) => p.seriesId === seriesId).map((p) => p.id);
      if (!inside.includes(poolId)) inside.push(poolId);
      const clashes = overlaps(inside);
      if (clashes.length > 0) return clashes;
    }

    const p = pool(poolId);
    const at = pools.filter((x) => x.seriesId === seriesId).length;
    p.seriesId = seriesId;
    p.seriesName = own.name;
    p.seriesKind = own.kind;
    p.seriesPosition = at;
    return [];
  },
  remove_pool_from_series: (a) => {
    const p = pool(a['poolId']);
    p.seriesId = null;
    p.seriesName = null;
    p.seriesKind = null;
    p.seriesLabel = null;
    p.seriesPosition = 0;
    return undefined;
  },
  reorder_series_pools: (a) => {
    const order = ids(a, 'poolIds');
    for (const p of pools) {
      const at = order.indexOf(p.id);
      if (at >= 0 && p.seriesId === a['seriesId']) p.seriesPosition = at;
    }
    return seriesOf(a['seriesId']);
  },
  set_series_pool_label: (a) => {
    const p = pools.find((x) => x.id === a['poolId']);
    if (p === undefined) throw new Error('Маппул не найден');
    const raw = (a['label'] as string | null) ?? null;
    const clean = raw === null || raw.trim() === '' ? null : raw.trim();
    p.seriesLabel = clean === `раунд ${p.seriesPosition + 1}` ? null : clean;
    return undefined;
  },

  series_stats: (a) => {
    const own = seriesOf(a['id']);
    const inside = pools
      .filter((p) => p.seriesId === own.id && p.status !== 'archived')
      .sort((x, y) => x.seriesPosition - y.seriesPosition)
      .map(withMaps);

    const perMap = new Map<number, number>();
    const mappers = new Map<string, number>();
    let total = 0;
    let previous: number | null = null;
    const allStars: number[] = [];

    const steps = inside.map((p) => {
      const stars: number[] = [];
      for (const slot of p.slots) {
        if (slot.beatmapId !== null) {
          total += 1;
          perMap.set(slot.beatmapId, (perMap.get(slot.beatmapId) ?? 0) + 1);
        }
        const creator = slot.beatmap?.creator;
        if (creator) mappers.set(creator.toLowerCase(), (mappers.get(creator.toLowerCase()) ?? 0) + 1);
        const sr = slot.starRatingWithMods ?? slot.beatmap?.difficultyRating ?? null;
        if (sr !== null) {
          stars.push(sr);
          allStars.push(sr);
        }
      }

      const avg = stars.length === 0 ? null : stars.reduce((x, y) => x + y, 0) / stars.length;
      const below = avg !== null && previous !== null && avg + 0.005 < previous;
      if (avg !== null) previous = avg;

      return {
        poolId: p.id,
        label: labelAt(p) ?? p.name,
        starsMin: stars.length === 0 ? null : Math.min(...stars),
        starsMax: stars.length === 0 ? null : Math.max(...stars),
        starsAvg: avg,
        belowPrevious: below,
      };
    });

    return {
      pools: inside.length,
      mapsTotal: total,
      mapsUnique: perMap.size,
      repeats: [...perMap.values()].filter((n) => n > 1).length,
      starsMin: allStars.length === 0 ? null : Math.min(...allStars),
      starsMax: allStars.length === 0 ? null : Math.max(...allStars),
      mappers: mappers.size,
      mappersRepeated: [...mappers.values()].filter((n) => n > 1).length,
      playedBefore: 0,
      steps,
      repeatRows: overlaps(inside.map((p) => p.id)),
    };
  },
  series_repeats: (a) =>
    overlaps(pools.filter((p) => p.seriesId === a['id']).map((p) => p.id)),

  /** Серия под турнир: создаётся сама серия и count пулов в ней. */
  generate_series: (a) => {
    const t = template(a['templateId']);
    const name = String(a['name']).trim() === '' ? t.name : String(a['name']).trim();
    const count = Number(a['count']) || 1;

    const made = HANDLERS['create_series']?.({ name, kind: 'tournament' }) as Series;
    const out: GenReport[] = [];
    for (let i = 0; i < count; i++) {
      out.push(fill(newPool(`${name} — раунд ${i + 1}`, t, made.id), false));
    }
    return out;
  },

  roll_series: (a) => {
    const seriesId = a['seriesId'] as number;
    const keepPinned = a['keepPinned'] === true;
    const inside = pools
      .filter((p) => p.seriesId === seriesId && p.status !== 'archived')
      .sort((x, y) => x.seriesPosition - y.seriesPosition);
    if (inside.length === 0) throw new Error('В серии нет маппулов');

    // Сначала освобождаем слоты: иначе первый пул считал бы занятыми карты
    // последнего и сам себе сузил бы выбор.
    for (const p of inside) {
      for (const slot of p.slots) {
        if (!keepPinned || !slot.pinned) slot.beatmapId = null;
      }
    }
    return inside.map((p) => fill(p, keepPinned));
  },

  reroll_repeat: (a) => {
    const p = pool(a['poolId']);
    const positions = p.slots
      .filter((x) => x.beatmapId === a['beatmapId'])
      .map((x) => x.position);
    return fill(p, true, positions);
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
  ...tournamentHandlers({
    rows: (poolId) =>
      withMaps(pools.find((p) => p.id === poolId) ?? ({ slots: [] } as unknown as Pool)).slots.map(
        (slot) => ({
          slotLabel: slot.slotLabel,
          mod: slot.mod,
          beatmap: slot.beatmap,
          starRatingWithMods: slot.starRatingWithMods,
          state: { kind: 'free' },
        }),
      ),
    list: () => pools.map((p) => ({ id: p.id, name: p.name, isLocked: p.isLocked })),
    series: (seriesId) => {
      const own = seriesList.find((x) => x.id === seriesId);
      return {
        name: own?.name ?? `серия ${seriesId}`,
        poolIds: pools
          .filter((p) => p.seriesId === seriesId && p.status !== 'archived')
          .sort((a, b) => a.seriesPosition - b.seriesPosition)
          .map((p) => p.id),
      };
    },
    overlaps,
  }),

  // Эфир: сцены уходят в канал внутри браузера, а не по сети. Так пульт и
  // `air.html` в двух вкладках дают посмотреть все сцены живьём.
  ...airHandlers(),
};

/**
 * Ответ, отвязанный от состояния заглушки.
 *
 * Настоящий IPC Tauri сериализует ответ в JSON, поэтому каждый вызов отдаёт
 * свежую копию. Заглушка обязана вести себя так же. Отдай она ссылку на свои
 * массивы — и любой код, сравнивающий «было» со «стало», сломался бы молча:
 * прошлое состояние дорастало бы вместе с нынешним.
 *
 * Именно так и случилось с эфиром. Он весь построен на разнице состояний матча,
 * а `match_state` отдавал живой `actions`: длина «прошлого» всегда совпадала с
 * длиной «нынешнего», разницы не находилось, и ни один кадр матча не выходил —
 * в приложении при этом всё работало.
 */
function detached<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Ставится один раз при старте, если настоящего Tauri в окне нет. */
export function installMockIpc(): void {
  const w = window as unknown as Record<string, unknown>;

  // Обработчики колбэков Tauri живут в window по числовому идентификатору.
  let callbackId = 1;

  // Метка заглушки: по ней пульт понимает, что настоящего сервера эфира нет
  // и кадр надо смотреть каналом внутри браузера, а не по локальному адресу.
  w['__OSUCUP_MOCK__'] = true;

  w['__TAURI_INTERNALS__'] = {
    invoke: (cmd: string, args: Args = {}) => {
      const handler = HANDLERS[cmd];
      if (!handler) return Promise.reject(new Error(`Команда ${cmd} не заглушена`));
      return Promise.resolve(detached(handler(args)));
    },
    transformCallback: (cb: unknown) => {
      const id = callbackId++;
      w[`_${id}`] = cb;
      return id;
    },
    convertFileSrc: (p: string) => p,
  };

  seedDemoTournament();

  console.info('osu!cup: вёрстка в браузере, данные подставлены для примера');
}

/**
 * Идущий турнир с первого открытия.
 *
 * Без него в браузере не посмотреть ни матч, ни эфир: оба живут внутри
 * турнира со сеткой, а собирать её руками через восемь экранов ради того,
 * чтобы взглянуть на одну сцену, — это ровно та работа, которой заглушка
 * и должна избавлять. Собирается теми же обработчиками, что зовёт интерфейс,
 * а не записью в массивы: расходись они — заглушка врала бы про свои же
 * правила.
 */
function seedDemoTournament(): void {
  const call = <T,>(cmd: string, args: Args = {}): T => {
    const handler = HANDLERS[cmd];
    if (handler === undefined) throw new Error(`Команда ${cmd} не заглушена`);
    return handler(args) as T;
  };

  const NICKS = ['NAGISA', 'KIRA', 'YUKI', 'REI', 'AKARI', 'SORA', 'MIKU', 'HANA'];

  try {
    // Маппул: без него матч не начать — первым же действием идёт бан.
    const pool = call<GenReport>('generate_pool', {
      name: 'Маппул вечера',
      templateId: 1,
      seriesId: null,
    }).pool;

    const t = call<{ id: number }>('create_tournament', {
      name: 'osu!cup — вечер вторника',
      targetScore: 4,
      bansPerRound: 1,
    });

    for (const nickname of NICKS) {
      const made = call<{ id: number }>('create_player', { nickname });
      call('add_tournament_player', { id: t.id, playerId: made.id });
    }

    call('set_tournament_pools', { id: t.id, poolIds: [pool.id] });
    call('shuffle_tournament_seeds', { id: t.id });

    // Фонд в демо — «Локальный смешанный»: деньги-сцены эфира без него
    // не показать, а показывать их надо.
    call('set_tournament_prize', {
      id: t.id,
      config: {
        fund: 10_000,
        engine: { kind: 'places', shares: [34, 24, 17, 11, 8, 6], growth: 200, lowerDiscount: 50 },
        addons: {
          bounty: { amounts: [700, 450, 350], rollover: true },
          matchPayments: { amount: 2_500, growth: 200, lowerDiscount: 50 },
          rookieRace: 1_500,
          underdog: true,
          spectator: 1_000,
          jackpot: true,
        },
        bestMatchId: null,
        jackpotIn: 0,
        rolledOut: 0,
      },
      emergency: false,
    });

    // Сетка и запуск: турнир должен быть «идёт», иначе эфир справедливо
    // отвечает, что показывать нечего.
    call('start_tournament', { id: t.id });
    call('confirm_tournament', { id: t.id });

    // Первый матч открыт и ждёт первого бана — то самое состояние, в котором
    // эфир показывает «Представление», а дальше идут баны и пики.
    const bracket = call<Bracket>('tournament_bracket', { id: t.id });
    const first = bracket.matches.find(
      (m) => m.playerA !== null && m.playerB !== null && m.status === 'pending',
    );
    if (first !== undefined) {
      call('set_match_pool', { id: first.id, poolId: pool.id });
      call('set_match_first_ban', { id: first.id, playerId: first.playerA });
    }
  } catch (e) {
    // Заглушка не должна ронять показ вёрстки: без демо-турнира экраны
    // откроются пустыми, и это лучше белого экрана.
    console.warn('osu!cup: демо-турнир не собрался', e);
  }
}
