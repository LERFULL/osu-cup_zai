import type { ReactNode } from 'react';
import s from './Rail.module.css';

export interface RailItem {
  id: string;
  icon: ReactNode;
  label: string;
}

export interface RailProps {
  items: RailItem[];
  active: string;
  onSelect: (id: string) => void;
  footer?: ReactNode;
}

export function Rail({ items, active, onSelect, footer }: RailProps) {
  return (
    <nav className={s.rail}>
      <div className={s.brand}>
        <span className={s.mark} aria-hidden />
        osu!cup
      </div>

      <div className={s.items}>
        {items.map((item) => (
          <button
            key={item.id}
            className={[s.item, item.id === active ? s.on : null].filter(Boolean).join(' ')}
            onClick={() => onSelect(item.id)}
            type="button"
            aria-current={item.id === active ? 'page' : undefined}
          >
            <span className={s.icon} aria-hidden>
              {item.icon}
            </span>
            {item.label}
          </button>
        ))}
      </div>

      {footer ? <div className={s.footer}>{footer}</div> : null}
    </nav>
  );
}
