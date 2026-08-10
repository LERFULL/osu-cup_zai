import { useEffect, useState } from 'react';
import type { LibraryFilter, LibrarySummary, ModTag } from '@/lib/types';
import { MOD_TAGS } from '@/lib/types';
import { formatLength, formatSpan, maps } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import s from './Summary.module.css';

interface Props {
  filter: LibraryFilter;
  /** Меняется после импорта и массовых правок — повод пересчитать. */
  revision: number;
}

/**
 * Из чего состоит текущая коллекция.
 *
 * Собирать маппул, не зная, сколько под рукой HD и какой в коллекции разброс
 * звёзд, — значит гадать. Панель отвечает на это одной строкой и считается
 * тем же фильтром, что и список: она всегда описывает то, что на экране.
 */
export function Summary({ filter, revision }: Props) {
  const [data, setData] = useState<LibrarySummary | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void ipc
      .librarySummary(filter)
      .then((next) => {
        if (alive) setData(next);
      })
      .catch(() => {
        // Сводка — не то, ради чего стоит показывать ошибку поверх списка.
        if (alive) setData(null);
      });
    return () => {
      alive = false;
    };
  }, [filter, revision]);

  if (data === null || data.total === 0) return null;

  const byMod = new Map<string, number>(data.byMod.map((m) => [m.mod, m.count]));
  const stars =
    data.starsMin === null || data.starsMax === null
      ? '—'
      : `${data.starsMin.toFixed(1)}–${data.starsMax.toFixed(1)}`;
  const bpm =
    data.bpmMin === null || data.bpmMax === null
      ? '—'
      : `${Math.round(data.bpmMin)}–${Math.round(data.bpmMax)}`;

  return (
    <div className={s.wrap}>
      <button
        className={s.head}
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className={s.arrow} data-open={open} aria-hidden>
          ▸
        </span>

        {/* Мод-теги — главное, ради чего сюда смотрят: по ним сразу видно,
            хватит ли карт на слоты маппула. */}
        <span className={s.mods}>
          {MOD_TAGS.map((m: ModTag) => {
            const n = byMod.get(m) ?? 0;
            return (
              <span
                key={m}
                className={n === 0 ? s.modZero : s.mod}
                style={n === 0 ? undefined : { color: `var(--${m.toLowerCase()})` }}
                title={`${m}: ${maps(n)}`}
              >
                {m} {n}
              </span>
            );
          })}
        </span>

        <span className={s.brief}>
          {stars}★ · {bpm} BPM
        </span>

        {data.untagged > 0 ? (
          <span className={s.untagged} title="Без мод-тегов генерация их не увидит">
            без тегов {data.untagged}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className={s.details}>
          <div className={s.cell}>
            <span className={s.label}>Звёзды</span>
            <span className={s.value}>
              {stars}
              {data.starsAvg !== null ? (
                <span className={s.avg}>в среднем {data.starsAvg.toFixed(2)}</span>
              ) : null}
            </span>
          </div>

          <div className={s.cell}>
            <span className={s.label}>Длина</span>
            <span className={s.value}>
              {formatLength(data.lengthAvg)}
              <span className={s.avg}>всего {formatSpan(data.lengthTotal)}</span>
            </span>
          </div>

          <div className={s.cell}>
            <span className={s.label}>BPM</span>
            <span className={s.value}>{bpm}</span>
          </div>

          <div className={s.cell}>
            <span className={s.label}>Карт</span>
            <span className={s.value}>
              {data.total}
              {data.untagged > 0 ? (
                <span className={s.avg}>размечено {data.total - data.untagged}</span>
              ) : (
                <span className={s.avg}>все размечены</span>
              )}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
