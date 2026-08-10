import type { CSSProperties, ReactNode } from 'react';
import type { ModTag } from '@/lib/types';
import type { GripProps } from '@/lib/useReorder';
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
  /** Ручка перетаскивания. Появляется, только если строку можно двигать.
   *  Обработчики приходят снаружи: порядок строк знает список, а не строка. */
  gripProps?: GripProps;
  dragging?: boolean;
  className?: string;
}

/** Строка слота шаблона: плашка мода, содержимое и хвост. */
export function SlotLine({
  mod,
  badge,
  children,
  end,
  gripProps,
  dragging = false,
  className,
}: SlotLineProps) {
  const style: CssVars = { '--mod': MOD_VAR[mod] };

  return (
    <div
      className={[s.line, dragging ? s.dragging : null, className].filter(Boolean).join(' ')}
      style={style}
    >
      {gripProps !== undefined ? (
        <span className={s.grip} title="Потянуть, чтобы переставить" {...gripProps}>
          ⠿
        </span>
      ) : null}
      <b className={s.badge}>{badge ?? mod}</b>
      <div className={s.body}>{children}</div>
      {end !== undefined ? <div className={s.end}>{end}</div> : null}
    </div>
  );
}
