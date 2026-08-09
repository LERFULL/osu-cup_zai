import { useEffect, useRef, type ReactNode } from 'react';
import s from './Menu.module.css';

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  /** С какой стороны от родителя прижать меню. */
  align?: 'left' | 'right';
  /** Раскрыть вверх — для кнопок у нижнего края экрана. */
  up?: boolean;
  children: ReactNode;
}

/**
 * Выпадающее меню. Позиционируется от ближайшего родителя с position: relative.
 * Закрывается кликом мимо и по Esc — иначе меню липнет к экрану.
 */
export function Menu({ open, onClose, align = 'left', up = false, children }: MenuProps) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Меню поверх панели: гасим событие, чтобы Esc не закрыл заодно и её.
      e.stopPropagation();
      onClose();
    };

    // Слушаем на всплытии, но с задержкой в кадр: клик, который открыл меню,
    // не должен тут же его закрыть.
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onDown);
    }, 0);
    document.addEventListener('keydown', onKey, true);

    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  const cls = [s.menu, align === 'right' ? s.right : s.left, up ? s.up : s.down].join(' ');

  return (
    <div className={cls} ref={box} role="menu">
      {children}
    </div>
  );
}

export interface MenuItemProps {
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Вторая строка мелким шрифтом: чем этот пункт отличается от соседнего. */
  note?: string;
}

export function MenuItem({ onClick, children, danger, disabled, note }: MenuItemProps) {
  return (
    <button
      className={[s.item, danger === true ? s.danger : null].filter(Boolean).join(' ')}
      onClick={onClick}
      disabled={disabled === true}
      type="button"
      role="menuitem"
    >
      <span>{children}</span>
      {note !== undefined ? <span className={s.note}>{note}</span> : null}
    </button>
  );
}

export function MenuSeparator() {
  return <div className={s.sep} aria-hidden />;
}
