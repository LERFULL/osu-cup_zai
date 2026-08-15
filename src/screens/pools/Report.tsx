import { useState } from 'react';
import type { GenNote } from '@/lib/types';
import s from './Report.module.css';

interface Props {
  notes: GenNote[];
  onClose: () => void;
  /** Показывать имя пула в строке — нужно только отчёту по всей серии. */
  withPool?: boolean;
}

/**
 * Отчёт генерации: адрес и цифры, а не «что-то не сошлось». Живёт на экране,
 * пока его не закрыли, и открывается снова из шапки.
 */
export function Report({ notes, onClose, withPool }: Props) {
  const [open, setOpen] = useState<number | null>(null);
  if (notes.length === 0) return null;

  const strict = notes.filter((n) => n.strict).length;

  return (
    <section className={s.report}>
      <header className={s.head}>
        <span className={s.title}>
          {strict > 0 ? `${strict} строгих нарушений` : 'Замечания по генерации'}
          <span className={s.count}>{notes.length}</span>
        </span>
        <button className={s.close} onClick={onClose} type="button" aria-label="Скрыть отчёт">
          ✕
        </button>
      </header>

      <div className={s.list}>
        {notes.map((n, i) => (
          <div key={`${n.poolId}-${n.slotLabel}-${i}`} className={s.item}>
            <button
              className={s.line}
              onClick={() => setOpen(open === i ? null : i)}
              type="button"
              disabled={n.blockers.length === 0}
            >
              <span className={n.strict ? s.hard : s.soft} aria-hidden>
                {n.strict ? '✕' : '⚠'}
              </span>
              {withPool === true ? <span className={s.pool}>{n.poolName}</span> : null}
              {n.slotLabel !== null ? <span className={s.slot}>{n.slotLabel}</span> : null}
              <span className={s.text}>{n.text}</span>
              {n.blockers.length > 0 ? (
                <span className={s.more} aria-hidden>
                  {open === i ? '▾' : '▸'}
                </span>
              ) : null}
            </button>

            {open === i ? (
              <div className={s.blockers}>
                {n.blockers.map((b) => (
                  <div key={b.reason} className={s.blocker}>
                    <span className={s.reason}>{b.reason}</span>
                    <span className={s.num}>−{b.cut}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
