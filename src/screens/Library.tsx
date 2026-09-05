import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button, Chip, Empty, MapRow, Menu, MenuItem, RangeSlider } from '@/components';
import {
  MOD_TAGS,
  type Beatmap,
  type LibraryFilter,
  type ModTag,
  type Place,
  type SortKey,
} from '@/lib/types';
import { coverUrl, filterIsSet, filterSummary, maps } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import { useApp } from '@/store/app';
import { Explorer } from './library/Explorer';
import { Card } from './library/Card';
import { Bulk } from './library/Bulk';
import { Summary } from './library/Summary';
import { useBeatmapPages } from './library/useBeatmaps';
import s from './Library.module.css';

/** Высота строки плюс зазор — шаг виртуального списка. */
const STEP = 56;

/** Строка списка: набор или его сложность под ним. */
interface Row {
  map: Beatmap;
  child: boolean;
}

/** Сортировка: подписи для человека и порядок в меню. */
const SORTS: { key: SortKey; name: string }[] = [
  { key: 'added', name: 'По дате добавления' },
  { key: 'stars', name: 'По звёздам' },
  { key: 'bpm', name: 'По BPM' },
  { key: 'length', name: 'По длине' },
  { key: 'title', name: 'По названию' },
  { key: 'artist', name: 'По артисту' },
];

/** Где находимся сейчас — выводится из фильтра. */
function placeOf(filter: LibraryFilter): Place {
  if (filter.noMods) return { kind: 'untagged' };
  if (filter.collectionId !== null) return { kind: 'collection', id: filter.collectionId };
  return { kind: 'all' };
}

export default function Library() {
  const { filter, setFilter, resetFilter, collections, folders, refreshCollections, refreshUntagged, go } =
    useApp();
  // Проводник — лицо библиотеки. Открываемся в нём, а не в списке.
  const [browse, setBrowse] = useState<number | null>(null);
  const [explorer, setExplorer] = useState(true);
  const [sortMenu, setSortMenu] = useState(false);
  const [opened, setOpened] = useState<number | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  // Состав выдачи меняют не только фильтры: импорт, удаление и массовые
  // правки тоже. Счётчик заставляет сводку пересчитаться после них.
  const [revision, setRevision] = useState(0);
  const bumpSummary = () => setRevision((n) => n + 1);
  const listRef = useRef<HTMLDivElement>(null);
  // Точка отсчёта для выделения диапазона по Shift.
  const anchor = useRef<number | null>(null);

  const { items, total, loading, error, loadMore, patch, drop, reload } = useBeatmapPages(filter);

  // Развёрнутые наборы и их сложности. Сложности тянутся один раз на набор:
  // в схлопнутом списке их нет, а лезть за ними при каждом рендере незачем.
  const [spread, setSpread] = useState<ReadonlySet<number>>(new Set());
  const [kids, setKids] = useState<Readonly<Record<number, Beatmap[]>>>({});

  /**
   * Выделение и массовые действия оперируют наборами. Одна карта = один
   * объект: отметив строку, человек имеет в виду весь набор, поэтому
   * выбранная сложность раскрывается в id всех сложностей набора.
   * Раскрываются лениво и кешируются — как и для показа сложностей.
   */
  const [bulkIds, setBulkIds] = useState<number[]>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const out: number[] = [];
      for (const id of picked) {
        const m = items.find((x) => x.beatmapId === id);
        if (m === undefined) continue;
        const set = m.beatmapsetId;
        if (set === null || (m.setCount ?? 1) <= 1) {
          out.push(id);
          continue;
        }
        const list = kids[set] ?? (await ipc.getSetDifficulties(set));
        if (!alive) return;
        if (kids[set] === undefined) setKids((prev) => ({ ...prev, [set]: list }));
        out.push(...list.map((k) => k.beatmapId));
      }
      setBulkIds(out);
    })();
    return () => {
      alive = false;
    };
  }, [picked, items, kids]);

  // Плоский список строк: сложности развёрнутого набора встают сразу под ним.
  // Виртуализатору нужен именно плоский, иначе он не посчитает высоту.
  const shown = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const m of items) {
      out.push({ map: m, child: false });
      const set = m.beatmapsetId;
      if (set === null || !spread.has(set)) continue;
      for (const k of kids[set] ?? []) {
        if (k.beatmapId !== m.beatmapId) out.push({ map: k, child: true });
      }
    }
    return out;
  }, [items, spread, kids]);

  // В DOM живут только видимые строки: библиотека рассчитана на десятки тысяч карт.
  const rows = useVirtualizer({
    count: shown.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => STEP,
    overscan: 10,
  });

  const virtual = rows.getVirtualItems();
  const lastIndex = virtual.length > 0 ? (virtual[virtual.length - 1]?.index ?? 0) : -1;

  // Следующая страница подтягивается, когда до конца осталось меньше экрана.
  useEffect(() => {
    if (lastIndex >= 0 && lastIndex >= shown.length - 20) void loadMore();
  }, [lastIndex, shown.length, loadMore]);

  // Сменили фильтр — выделение сбрасывается: держать выбранными карты,
  // которых на экране больше нет, значит удалить их не глядя.
  useEffect(() => {
    setPicked(new Set());
    setSpread(new Set());
    anchor.current = null;
  }, [filter]);

  const here = useMemo(
    () => collections.find((c) => c.id === filter.collectionId) ?? null,
    [collections, filter.collectionId],
  );

  const place = placeOf(filter);
  const untagged = place.kind === 'untagged';
  /** Название места — оно же заголовок области списка. */
  const title = untagged ? 'Без мод-тегов' : (here?.name ?? 'Все карты');

  const dirty = filterIsSet(filter);
  const sortName = SORTS.find((x) => x.key === filter.sort)?.name ?? 'По дате добавления';

  /** Хлебные крошки места: путь по папкам до коллекции. */
  const crumbs = useMemo(() => {
    if (here === null) return [];
    const path: string[] = [];
    let cur = here.folderId;
    while (cur !== null) {
      const f = folders.find((x) => x.id === cur);
      if (f === undefined) break;
      path.unshift(f.name);
      cur = f.parentId;
    }
    return path;
  }, [here, folders]);

  function openPlace(next: Place) {
    setExplorer(false);
    if (next.kind === 'untagged') {
      // Системный раздел и коллекция — разные места: вместе они бы
      // показывали пересечение, которого пользователь не просил.
      setFilter({ collectionId: null, noMods: true });
      return;
    }
    if (next.kind === 'all') {
      setFilter({ collectionId: null, noMods: false });
      return;
    }
    const target = collections.find((c) => c.id === next.id) ?? null;
    setFilter({ collectionId: next.id, noMods: false });
    // Умная коллекция сама себе фильтр: чужие условия она не применяет,
    // поэтому и показывать их набранными нечестно.
    if (target?.isSmart === true) resetFilter();
  }

  /** Выйти из списка обратно в проводник — в папку, где лежит коллекция. */
  function backToExplorer() {
    setBrowse(here?.folderId ?? null);
    setExplorer(true);
  }

  function toggleMod(m: ModTag) {
    const has = filter.mods.includes(m);
    setFilter({ mods: has ? filter.mods.filter((x) => x !== m) : [...filter.mods, m] });
  }

  /** Сохранить условия фильтра как умную коллекцию. */
  async function saveAsSmart() {
    const name = window.prompt('Название умной коллекции', filterSummary(filter));
    if (name === null || name.trim() === '') return;
    const made = await ipc.createSmartCollection(name.trim(), null, {
      ...filter,
      collectionId: null,
    });
    await refreshCollections();
    setFilter({ collectionId: made.id });
    resetFilter();
  }

  /** Развернуть или свернуть набор. Сложности догружаются при первом раскрытии. */
  async function toggleSpread(setId: number) {
    if (spread.has(setId)) {
      setSpread((prev) => {
        const next = new Set(prev);
        next.delete(setId);
        return next;
      });
      return;
    }

    if (kids[setId] === undefined) {
      const list = await ipc.getSetDifficulties(setId);
      setKids((prev) => ({ ...prev, [setId]: list }));
    }
    setSpread((prev) => new Set(prev).add(setId));
  }

  /**
   * Выделение. Состояние меняется только функционально: при частых кликах
   * подряд соседние обновления попадают в один пакет, и чтение `picked`
   * из замыкания рендера теряло бы предыдущий выбор.
   */
  function togglePick(index: number, id: number, shift: boolean) {
    setPicked((prev) => {
      const next = new Set(prev);

      // Shift выделяет всё от прошлой отметки до текущей — это и есть
      // «выделить подряд», не кликая каждую строку.
      const from = anchor.current;
      if (shift && from !== null) {
        const [a, b] = from < index ? [from, index] : [index, from];
        for (let i = a; i <= b; i++) {
          const r = shown[i];
          if (r) next.add(r.map.beatmapId);
        }
        return next;
      }

      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

    if (!shift) anchor.current = index;
  }

  /**
   * Выделение протягиванием: зажал чекбокс и повёл — отмечаются все строки
   * по пути. Мышь может уйти за пределы строки и даже списка, поэтому
   * ведём по всему окну, а не по элементу.
   *
   * Направление задаёт первая строка: если начали с невыделенной — ведём
   * выделение, если с выделенной — снимаем. Так одно и то же движение
   * работает в обе стороны.
   */
  function startSweep(index: number, id: number, shift: boolean) {
    // Shift — это выделение диапазона, а не протягивание: они бы мешали.
    if (shift) {
      togglePick(index, id, true);
      return;
    }

    const adding = !picked.has(id);
    let last = index;

    const apply = (to: number) => {
      setPicked((prev) => {
        const next = new Set(prev);
        const [a, b] = last < to ? [last, to] : [to, last];
        for (let i = a; i <= b; i++) {
          const r = shown[i];
          if (!r) continue;
          if (adding) next.add(r.map.beatmapId);
          else next.delete(r.map.beatmapId);
        }
        return next;
      });
      last = to;
    };

    apply(index);
    anchor.current = index;

    const move = (e: PointerEvent) => {
      // Строка под курсором: у каждой в разметке лежит её номер.
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const row = el instanceof Element ? el.closest('[data-index]') : null;
      if (!(row instanceof HTMLElement)) return;

      const to = Number(row.dataset['index']);
      if (Number.isFinite(to) && to !== last) apply(to);
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      anchor.current = last;
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  async function removePicked() {
    await ipc.deleteBeatmaps(bulkIds);
    drop(bulkIds);
    setPicked(new Set());
    anchor.current = null;
    await refreshCollections();
    bumpSummary();
  }

  function clearPicked() {
    setPicked(new Set());
    anchor.current = null;
  }

  /** Убрать одну карту — из строки списка или из раскрытого набора. */
  async function removeOne(map: Beatmap) {
    // Строка набора — весь набор: предупреждаем честно.
    const whole = map.beatmapsetId !== null && (map.setCount ?? 1) > 1;
    const what = whole
      ? `«${displayTitle(map)}» и все её ${map.setCount} сложностей`
      : `«${displayTitle(map)} [${map.version}]»`;
    if (!window.confirm(`Убрать ${what} из библиотеки?`)) return;

    const ids =
      whole && map.beatmapsetId !== null
        ? (kids[map.beatmapsetId] ?? (await ipc.getSetDifficulties(map.beatmapsetId))).map(
            (k) => k.beatmapId,
          )
        : [map.beatmapId];

    await ipc.deleteBeatmaps(ids);
    if (opened === map.beatmapId) setOpened(null);

    const set = map.beatmapsetId;
    if (set !== null && kids[set] !== undefined) {
      setKids((prev) => ({
        ...prev,
        [set]: (prev[set] ?? []).filter((k) => !ids.includes(k.beatmapId)),
      }));
    }

    // Строка представляет весь набор: удалив её, пересчитываем список —
    // и удалять сложность, которой больше нет, нельзя.
    if (whole) await reload();
    else drop(ids);

    await refreshCollections();
    bumpSummary();
  }

  /**
   * Правка карты из карточки. В «Без мод-тегов» карта, которой только что
   * проставили тег, этому месту уже не принадлежит — убираем её из списка
   * сразу, а не по возвращении на экран.
   */
  function tagged(map: Beatmap) {
    if (untagged && map.mods.length > 0) {
      drop([map.beatmapId]);
      if (opened === map.beatmapId) setOpened(null);
    } else {
      patch(map);
    }
  }

  // ─────────────────────────────────────────────────── список карт

  const listView = (
    <div className={s.main}>
      <header className={s.bar}>
        <div className={s.where}>
          <button className={s.home} onClick={backToExplorer} type="button" title="В проводник">
            ‹
          </button>
          <nav className={s.path}>
            <h1 className={s.h1}>{title}</h1>
            {crumbs.length > 0 ? (
              <span className={s.pathNote}>{crumbs.join(' › ')}</span>
            ) : null}
          </nav>
          <span className={s.count}>{loading ? '…' : maps(total)}</span>
          {place.kind !== 'all' ? (
            <button
              className={s.exit}
              onClick={() => {
                setFilter({ collectionId: null, noMods: false });
              }}
              type="button"
              title="Вернуться ко всем картам"
            >
              ✕
            </button>
          ) : null}
        </div>

        <div className={s.right}>
          <input
            className={s.search}
            value={filter.query}
            placeholder="Поиск по названию, артисту, мапперу"
            onChange={(e) => setFilter({ query: e.target.value })}
          />
          <Button variant="primary" onClick={() => go('downloads')} title="Ссылки, очередь и авто-теги пачек">
            + Загрузки
          </Button>
        </div>
      </header>

      <div className={s.filters}>
        {/* В «Без мод-тегов» чипы модов не показываем: у этих карт тегов нет,
            и любой выбранный дал бы гарантированно пустой список. */}
        {untagged ? (
          <span className={s.hint}>
            Проставь мод-теги — и карта уедет отсюда в генерацию маппулов
          </span>
        ) : (
          <div className={s.mods}>
            {MOD_TAGS.map((m) => (
              <Chip key={m} active={filter.mods.includes(m)} onClick={() => toggleMod(m)}>
                {m}
              </Chip>
            ))}
          </div>
        )}

        <div className={s.slider}>
          <RangeSlider
            label="Звёзды"
            min={0}
            max={12}
            step={0.1}
            value={[filter.stars.min, filter.stars.max]}
            onChange={([min, max]) => setFilter({ stars: { min, max } })}
            format={(n) => n.toFixed(1)}
          />
        </div>

        <Chip
          active={false}
          onClick={() => {
            // Выделить всё, что сейчас на экране: протягивание по строкам
            // на сотне карт — это всё же работа.
            setPicked(new Set(shown.map((r) => r.map.beatmapId)));
          }}
          title="Выделить все карты на экране"
        >
          Выделить все
        </Chip>

        {dirty ? (
          <div className={s.saveFilter}>
            <Button size="sm" onClick={() => void saveAsSmart()}>
              Сохранить как умную
            </Button>
            <Button size="sm" onClick={resetFilter}>
              Сбросить
            </Button>
          </div>
        ) : null}

        <div className={s.sort}>
          <button
            className={s.sortBtn}
            onClick={() => setSortMenu(!sortMenu)}
            type="button"
            title="Порядок списка"
          >
            {sortName}
            <span className={s.sortDir} aria-hidden>
              {filter.dir === 'asc' ? '↑' : '↓'}
            </span>
          </button>
          <Menu open={sortMenu} onClose={() => setSortMenu(false)} align="right">
            {SORTS.map((x) => (
              <MenuItem
                key={x.key}
                onClick={() => {
                  setSortMenu(false);
                  if (filter.sort !== x.key) setFilter({ sort: x.key });
                }}
              >
                {x.name}
              </MenuItem>
            ))}
            <MenuItem
              onClick={() => {
                setSortMenu(false);
                setFilter({
                  dir: filter.dir === 'asc' ? 'desc' : 'asc',
                });
              }}
              note="направление"
            >
              {filter.dir === 'asc' ? 'Сменить на убывание ↓' : 'Сменить на возрастание ↑'}
            </MenuItem>
          </Menu>
        </div>
      </div>

      <Summary filter={filter} revision={revision} />

      <div className={s.list} ref={listRef}>
        {error ? (
          <Empty title="Не получилось прочитать библиотеку" note={error} />
        ) : items.length === 0 && !loading ? (
          untagged ? (
            <Empty
              title="Все карты размечены"
              note="Как только появится карта без мод-тегов, она окажется здесь — и её будет видно, пока ей не проставят теги."
            />
          ) : (
            <Empty
              title={here ? 'В этой коллекции пока пусто' : 'Здесь пока пусто'}
              note="Вставь список ссылок в загрузках — прога найдёт их сама и докачает пачкой."
              actions={
                <Button variant="primary" onClick={() => go('downloads')}>
                  Открыть загрузки
                </Button>
              }
            />
          )
        ) : (
          <div className={s.canvas} style={{ height: rows.getTotalSize() }}>
            {virtual.map((v) => {
              const row = shown[v.index];
              if (!row) return null;
              const m = row.map;
              const set = m.beatmapsetId;
              const extra = m.setCount ?? 1;
              const multi = !row.child && extra > 1;

              return (
                <div
                  key={row.child ? `k${m.beatmapId}` : m.beatmapId}
                  className={[s.slot, row.child ? s.child : null].filter(Boolean).join(' ')}
                  style={{ transform: `translateY(${v.start}px)` }}
                  data-index={v.index}
                >
                  <MapRow
                    kind="plain"
                    stars={m.difficultyRating}
                    {...(m.totalLength !== null ? { length: m.totalLength } : {})}
                    {...(m.bpm !== null ? { bpm: m.bpm } : {})}
                    cover={coverUrl(m.coverPath)}
                    title={displayTitle(m)}
                    version={multi ? `${extra} сложностей` : m.version}
                    mod={m.mods[0] ?? 'NM'}
                    mods={m.mods}
                    untagged={m.mods.length === 0}
                    selected={picked.has(m.beatmapId)}
                    opened={opened === m.beatmapId}
                    checkbox
                    {...(!row.child && set !== null && extra > 1
                      ? {
                          expand: {
                            count: extra,
                            open: spread.has(set),
                            onToggle: () => void toggleSpread(set),
                          },
                        }
                      : {})}
                    tools={
                      <button
                        className={s.rowX}
                        onClick={() => void removeOne(m)}
                        type="button"
                        aria-label="Убрать из библиотеки"
                        title="Убрать из библиотеки"
                      >
                        ✕
                      </button>
                    }
                    onToggleSelect={(shift) => togglePick(v.index, m.beatmapId, shift)}
                    onSweepSelect={(shift) => startSweep(v.index, m.beatmapId, shift)}
                    onClick={() => setOpened(m.beatmapId)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {picked.size > 0 ? (
        <Bulk
          ids={bulkIds.length > 0 ? bulkIds : [...picked]}
          selected={shown.filter((r) => picked.has(r.map.beatmapId)).map((r) => r.map)}
          collections={collections}
          here={here}
          onClear={clearPicked}
          onChanged={async () => {
            await reload();
            await refreshCollections();
            void refreshUntagged();
            bumpSummary();
          }}
          onDelete={removePicked}
        />
      ) : null}
    </div>
  );

  return (
    <div className={s.screen}>
      {explorer ? (
        <Explorer place={place} folder={browse} onOpenPlace={openPlace} onBrowse={setBrowse} />
      ) : (
        listView
      )}

      {opened !== null ? (
        <Card
          beatmapId={opened}
          onClose={() => setOpened(null)}
          onChanged={tagged}
          onSaved={() => {
            void refreshUntagged();
            // Проставили теги — разбивка по модам в сводке уже другая.
            bumpSummary();
          }}
          onOpen={setOpened}
          onDeleted={(ids) => {
            drop(ids);
            setPicked((prev) => {
              const next = new Set(prev);
              for (const id of ids) next.delete(id);
              return next;
            });
            void refreshCollections();
            bumpSummary();
          }}
        />
      ) : null}
    </div>
  );
}

function displayTitle(m: Beatmap): string {
  const artist = m.artist.trim();
  return artist === '' ? m.title : `${artist} — ${m.title}`;
}
