import type { CSSProperties, ReactNode } from 'react';
import type { ModTag } from '@/lib/types';
import s from './SlotLine.module.css';

type CssVars = CSSProperties & Record<string, string | number>;

const MOD_VAR: Record<ModTag, string> = {
  NM: 'var(--nm)',
  HD: 'var(--hd)',
  HR: 'var(--hr)',
  DT: 'var(--dt)',
  FM: 'var(--fm)',
  EZ: 'var(--ez)',
  TB: 'var(--tb)',
};

export interface SlotLineProps {
  mod: ModTag;
  /** Подпись на плашке: сам мод или мод с количеством. */
  badge?: string;
  children: ReactNode;
  /** Правая часть строки — обычно диапазон или счётчик. */
  end?: ReactNode;
  /** Ручка перетаскивания. Появляется, только если строку можно двигать. */
  onDragStart?: () => void;
  onDragOver?: () => void;
  onDrop?: () => void;
  dragging?: boolean;
  className?: string;
}

/** Строка слота шаблона: плашка мода, содержимое и хвост. */
export function SlotLine({
  mod,
  badge,
  children,
  end,
  onDragStart,
  onDragOver,
  onDrop,
  dragging = false,
  className,
}: SlotLineProps) {
  const style: CssVars = { '--mod': MOD_VAR[mod] };
  const draggable = onDragStart !== undefined;

  return (
    <div
      className={[s.line, dragging ? s.dragging : null, className].filter(Boolean).join(' ')}
      style={style}
      draggable={draggable}
      {...(draggable
        ? {
            onDragStart: () => onDragStart(),
            onDragOver: (e) => {
              e.preventDefault();
              onDragOver?.();
            },
            onDrop: (e) => {
              e.preventDefault();
              onDrop?.();
            },
          }
        : {})}
    >
      {draggable ? (
        <span className={s.grip} aria-hidden>
          ⠿
        </span>
      ) : null}
      <b className={s.badge}>{badge ?? mod}</b>
      <div className={s.body}>{children}</div>
      {end !== undefined ? <div className={s.end}>{end}</div> : null}
    </div>
  );
}
