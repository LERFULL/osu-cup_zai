import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import s from './Chip.module.css';

type CssVars = CSSProperties & Record<string, string | number>;

export interface ChipProps {
  children: ReactNode;
  /** Цвет активного состояния. По умолчанию розовый. */
  color?: string;
  active?: boolean;
  /** Показать крестик снятия. Клик по нему не всплывает до onClick. */
  onRemove?: () => void;
  onClick?: () => void;
  title?: string;
}

export function Chip({ children, color, active = false, onRemove, onClick, title }: ChipProps) {
  const style: CssVars = {};
  if (color) style['--chip'] = color;

  const cls = [s.chip, active ? s.active : null, onClick ? s.clickable : null]
    .filter(Boolean)
    .join(' ');

  const remove = (e: MouseEvent) => {
    e.stopPropagation();
    onRemove?.();
  };

  return (
    <span
      className={cls}
      style={style}
      {...(title !== undefined ? { title } : {})}
      {...(onClick ? { onClick, role: 'button', tabIndex: 0 } : {})}
    >
      {children}
      {onRemove ? (
        <button className={s.x} onClick={remove} type="button" aria-label="Убрать">
          ✕
        </button>
      ) : null}
    </span>
  );
}
