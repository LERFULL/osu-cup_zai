import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button, Chip, Empty, MapRow, RangeSlider } from '@/components';
import { MOD_TAGS, type Beatmap, type ModTag } from '@/lib/types';
import { coverUrl, filterIsSet, filterSummary, maps } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import { useApp } from '@/store/app';
import { Tree } from './library/Tree';
import { Import } from './library/Import';
import { Card } from './library/Card';
import { Bulk } from './library/Bulk';
import { useBeatmapPages } from './library/useBeatmaps';
import s from './Library.module.css';

/** Высота строки плюс зазор — шаг виртуального списка. */
const STEP = 56;

export default function Library() {
  const { filter, setFilter, resetFilter, collections, refreshCollections } = useApp();
  const [importing, setImporting] = useState(false);
  const [opened, setOpened] = useState<number | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  // Точка отсчёта для выделения диапазона по Shift.
  const anchor = useRef<number | null>(null);

  const { items, total, loading, error, loadMore, patch, drop, reload } = useBeatmapPages(filter);

  // В DOM живут только видимые строки: библиотека рассчитана на десятки тысяч карт.
  const rows = useVirtualizer({
    count: items.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => STEP,
    overscan: 10,
  });

  const virtual = rows.getVirtualItems();
  const lastIndex = virtual.length > 0 ? (virtual[virtual.length - 1]?.index ?? 0) : -1;

  // Следующая страница подтягивается, когда до конца осталось меньше экрана.
  useEffect(() => {
    if (lastIndex >= 0 && lastIndex >= items.length - 20) void loadMore();
  }, [lastIndex, items.length, loadMore]);

  // Сменили фильтр — выделение сбрасывается: держать выбранными карты,
  // которых на экране больше нет, значит удалить их не глядя.
  useEffect(() => {
    setPicked(new Set());
    anchor.current = null;
  }, [filter]);

  const here = useMemo(
    () => collections.find((c) => c.id === filter.collectionId) ?? null,
    [collections, filter.collectionId],
  );

  const dirty = filterIsSet(filter);

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
          const m = items[i];
          if (m) next.add(m.beatmapId);
        }
        return next;
      }

      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

    if (!shift) anchor.current = index;
  }

  async function removePicked() {
    const ids = [...picked];
    await ipc.deleteBeatmaps(ids);
    drop(ids);
    setPicked(new Set());
    anchor.current = null;
    await refreshCollections();
  }

  function clearPicked() {
    setPicked(new Set());
    anchor.current = null;
  }

  return (
    <div className={s.screen}>
      <Tree
        activeId={filter.collectionId}
        onSelect={(id) => {
          const target = collections.find((c) => c.id === id) ?? null;
          setFilter({ collectionId: id });
          // Умная коллекция сама себе фильтр: чужие условия она не применяет,
          // поэтому и показывать их набранными нечестно.
          if (target?.isSmart === true) resetFilter();
        }}
      />

      <div className={s.main}>
        <header className={s.bar}>
          <div className={s.where}>
            <h1 className={s.h1}>{here ? here.name : 'Все карты'}</h1>
            <span className={s.count}>{loading ? '…' : maps(total)}</span>
            {here ? (
              <button
                className={s.exit}
                onClick={() => setFilter({ collectionId: null })}
                type="button"
                title="Выйти в «Все карты»"
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
            <Button variant="primary" onClick={() => setImporting(true)}>
              + По ссылкам
            </Button>
          </div>
        </header>

        <div className={s.filters}>
          <div className={s.mods}>
            {MOD_TAGS.map((m) => (
              <Chip key={m} active={filter.mods.includes(m)} onClick={() => toggleMod(m)}>
                {m}
              </Chip>
            ))}
          </div>

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
        </div>

        <div className={s.list} ref={listRef}>
          {error ? (
            <Empty title="Не получилось прочитать библиотеку" note={error} />
          ) : items.length === 0 && !loading ? (
            <Empty
              title={here ? 'В этой коллекции пока пусто' : 'Здесь пока пусто'}
              note="Вставь список ссылок на карты — прога найдёт их сама и загрузит."
              actions={
                <Button variant="primary" onClick={() => setImporting(true)}>
                  Добавить по ссылкам
                </Button>
              }
            />
          ) : (
            <div className={s.canvas} style={{ height: rows.getTotalSize() }}>
              {virtual.map((v) => {
                const m = items[v.index];
                if (!m) return null;
                return (
                  <div
                    key={m.beatmapId}
                    className={s.slot}
                    style={{ transform: `translateY(${v.start}px)` }}
                  >
                    <MapRow
                      kind="plain"
                      stars={m.difficultyRating}
                      {...(m.totalLength !== null ? { length: m.totalLength } : {})}
                      {...(m.bpm !== null ? { bpm: m.bpm } : {})}
                      cover={coverUrl(m.coverPath)}
                      title={displayTitle(m)}
                      version={m.version}
                      mod={(m.mods[0] as ModTag) ?? 'NM'}
                      selected={picked.has(m.beatmapId) || opened === m.beatmapId}
                      checkbox
                      onToggleSelect={(shift) => togglePick(v.index, m.beatmapId, shift)}
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
            ids={[...picked]}
            collections={collections}
            here={here}
            onClear={clearPicked}
            onChanged={async () => {
              await reload();
              await refreshCollections();
            }}
            onDelete={removePicked}
          />
        ) : null}
      </div>

      {opened !== null ? (
        <Card beatmapId={opened} onClose={() => setOpened(null)} onChanged={patch} />
      ) : null}

      {importing ? (
        <Import
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            setFilter({ sort: 'added', dir: 'desc' });
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
