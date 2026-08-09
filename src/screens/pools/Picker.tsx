import { useEffect, useState } from 'react';
import { Chip, Empty, MapRow, Panel } from '@/components';
import type { Beatmap, LibraryFilter, PoolSlot } from '@/lib/types';
import { EMPTY_FILTER } from '@/lib/types';
import { coverUrl, filterSummary } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import s from './Picker.module.css';

interface Props {
  poolId: number;
  slot: PoolSlot;
  /** Карты, занятые другими слотами: одну и ту же брать дважды нельзя. */
  taken: ReadonlySet<number>;
  onPick: (map: Beatmap) => void;
  onImport: () => void;
  onClose: () => void;
}

/** Где ищем: в границах слота или во всей библиотеке. */
type Scope = 'slot' | 'all';

/**
 * Подбор карты в слот. По умолчанию видно ровно то, из чего выбирала бы
 * генерация — иначе руками можно поставить карту, которую шаблон не взял бы,
 * и потом гадать, почему пул выглядит не так.
 */
export function Picker({ poolId, slot, taken, onPick, onImport, onClose }: Props) {
  const [scope, setScope] = useState<Scope>('slot');
  const [query, setQuery] = useState('');
  const [slotFilter, setSlotFilter] = useState<LibraryFilter | null>(null);
  const [items, setItems] = useState<Beatmap[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Условия слота приходят с той же стороны, что и генерация, — не собираем
  // их заново на фронте, чтобы они не разошлись.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const f = await ipc.getSlotFilter(poolId, slot.position);
        if (alive) setSlotFilter(f);
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [poolId, slot.position]);

  useEffect(() => {
    if (scope === 'slot' && slotFilter === null) return;

    let alive = true;
    setLoading(true);

    // Пауза, чтобы каждая буква не уходила в базу отдельным запросом.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const base =
            scope === 'slot' && slotFilter !== null
              ? slotFilter
              : { ...EMPTY_FILTER, mods: [slot.mod] };
          const page = await ipc.listBeatmaps({ ...base, query }, 0, 200);
          if (!alive) return;
          setItems(page.items);
          setTotal(page.total);
          setError(null);
        } catch (e) {
          if (alive) setError(String(e));
        } finally {
          if (alive) setLoading(false);
        }
      })();
    }, 180);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [scope, slotFilter, query, slot.mod]);

  const conditions =
    scope === 'slot' && slotFilter !== null
      ? filterSummary({ ...slotFilter, query: '' })
      : `мод ${slot.mod}`;

  return (
    <Panel
      title={`Карта в слот ${slot.slotLabel}`}
      subtitle={`${total} подходит · ${conditions}`}
      onClose={onClose}
    >
      <input
        className={s.search}
        value={query}
        placeholder="Поиск по названию, артисту, мапперу"
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className={s.scopes}>
        <Chip active={scope === 'slot'} onClick={() => setScope('slot')}>
          по слоту
        </Chip>
        <Chip active={scope === 'all'} onClick={() => setScope('all')}>
          вся библиотека
        </Chip>
        <Chip onClick={onImport}>своя карта</Chip>
      </div>

      {error !== null ? (
        <Empty title="Не получилось прочитать библиотеку" note={error} />
      ) : items.length === 0 && !loading ? (
        <Empty
          title="Ничего не нашлось"
          note={
            scope === 'slot'
              ? 'Под условия слота карт нет. Посмотри всю библиотеку или добавь карту по ссылке.'
              : 'Попробуй другой запрос.'
          }
        />
      ) : (
        <div className={s.list}>
          {items.map((m) => {
            const busy = taken.has(m.beatmapId) && m.beatmapId !== slot.beatmapId;
            const suits = m.mods.includes(slot.mod);
            return (
              <div key={m.beatmapId} className={s.row}>
                <MapRow
                  kind="plain"
                  stars={m.difficultyRating}
                  {...(m.totalLength !== null ? { length: m.totalLength } : {})}
                  {...(m.bpm !== null ? { bpm: m.bpm } : {})}
                  cover={coverUrl(m.coverPath)}
                  title={`${m.artist} — ${m.title}`}
                  version={m.version}
                  // Мод слота, а не первый тег карты: выбираем именно в этот слот.
                  mod={slot.mod}
                  selected={slot.beatmapId === m.beatmapId}
                  onClick={() => onPick(m)}
                />
                {busy || !suits ? (
                  <div className={s.tags}>
                    {busy ? <span className={s.busy}>уже в пуле</span> : null}
                    {suits ? null : <span className={s.other}>без тега {slot.mod}</span>}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
