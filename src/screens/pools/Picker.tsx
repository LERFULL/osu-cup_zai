import { useEffect, useState } from 'react';
import { Chip, Empty, MapRow, Panel } from '@/components';
import type { Beatmap, PoolSlot, SlotPicker } from '@/lib/types';
import { EMPTY_FILTER } from '@/lib/types';
import { coverUrl, filterSummary, maps } from '@/lib/format';
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
 *
 * Исключённые карты скрыты, но посчитаны: строка «скрыто 74 карты» с кнопкой
 * «показать всё» честнее молча урезанного списка.
 */
export function Picker({ poolId, slot, taken, onPick, onImport, onClose }: Props) {
  const [scope, setScope] = useState<Scope>('slot');
  const [query, setQuery] = useState('');
  const [rules, setRules] = useState<SlotPicker | null>(null);
  const [showHidden, setShowHidden] = useState(false);
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
        const found = await ipc.slotPicker(poolId, slot.position);
        if (alive) setRules(found);
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [poolId, slot.position]);

  useEffect(() => {
    if (scope === 'slot' && rules === null) return;

    let alive = true;
    setLoading(true);

    // Пауза, чтобы каждая буква не уходила в базу отдельным запросом.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const base =
            scope === 'slot' && rules !== null
              ? rules.filter
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
  }, [scope, rules, query, slot.mod]);

  const banned = new Set(rules?.hidden ?? []);
  const applyExclusions = scope === 'slot' && !showHidden;
  const shown = applyExclusions ? items.filter((m) => !banned.has(m.beatmapId)) : items;
  const cutOff = items.length - shown.length;

  const conditions =
    scope === 'slot' && rules !== null
      ? filterSummary({ ...rules.filter, query: '' })
      : `мод ${slot.mod}`;

  return (
    <Panel
      title={`Карта в слот ${slot.slotLabel}`}
      subtitle={`${scope === 'slot' && rules !== null ? rules.available : total} подходит · ${conditions}`}
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

      {rules !== null && scope === 'slot' ? (
        <div className={s.origin}>источник: {rules.origin}</div>
      ) : null}

      {cutOff > 0 || (showHidden && banned.size > 0 && scope === 'slot') ? (
        <div className={s.hidden}>
          <span>
            {showHidden
              ? `${maps(banned.size)} нарушают исключения`
              : `скрыто ${maps(cutOff)} по исключениям`}
          </span>
          <button className={s.link} onClick={() => setShowHidden(!showHidden)} type="button">
            {showHidden ? 'скрыть' : 'показать всё'}
          </button>
        </div>
      ) : null}

      {error !== null ? (
        <Empty title="Не получилось прочитать библиотеку" note={error} />
      ) : shown.length === 0 && !loading ? (
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
          {shown.map((m) => {
            const busy = taken.has(m.beatmapId) && m.beatmapId !== slot.beatmapId;
            const suits = m.mods.includes(slot.mod);
            const excluded = banned.has(m.beatmapId);
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
                {busy || !suits || excluded ? (
                  <div className={s.tags}>
                    {busy ? <span className={s.busy}>уже в пуле</span> : null}
                    {suits ? null : <span className={s.other}>без тега {slot.mod}</span>}
                    {excluded ? <span className={s.busy}>под исключением</span> : null}
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
