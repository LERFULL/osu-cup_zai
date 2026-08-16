import type { TournamentEdit } from '@/lib/types';
import s from './Editor.module.css';

/** Время правки без даты: журнал читают в тот же день, когда правят. */
function clock(at: string): string {
  const t = new Date(at.includes('T') ? at : `${at.replace(' ', 'T')}Z`);
  if (Number.isNaN(t.getTime())) return '';
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

/**
 * Журнал правок: новые первыми. Отменённая правка не исчезает — она
 * зачёркивается, а рядом стоит парная отмена: история вмешательств должна
 * оставаться видимой.
 */
export function EditsLog({ edits }: { edits: TournamentEdit[] }) {
  if (edits.length === 0) return <div className={s.muted}>Турнир ещё не правили.</div>;

  return (
    <div className={s.log}>
      {edits.map((e) => (
        <div
          key={e.n}
          className={[
            s.logRow,
            e.emergency ? s.logDanger : null,
            e.undoneBy !== null ? s.logUndone : null,
          ]
            .filter(Boolean)
            .join(' ')}
          title={e.emergency ? 'аварийная правка' : undefined}
        >
          <span className={s.logN}>{e.n}</span>
          <span className={s.logNote}>{e.note}</span>
          <span className={s.logAt}>{clock(e.at)}</span>
        </div>
      ))}
    </div>
  );
}
