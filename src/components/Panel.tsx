import { useEffect, type ReactNode } from 'react';
import s from './Panel.module.css';

export interface PanelProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Panel({ title, subtitle, onClose, children, footer }: PanelProps) {
  // Esc закрывает панель — привычнее, чем целиться в крестик.
  // Пока фокус в поле ввода, Esc отдаём полю: там он отменяет правку.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (typing) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside className={s.panel}>
      <header className={s.head}>
        <div className={s.titles}>
          <div className={s.title}>{title}</div>
          {subtitle ? <div className={s.sub}>{subtitle}</div> : null}
        </div>
        <button className={s.close} onClick={onClose} type="button" aria-label="Закрыть">
          ✕
        </button>
      </header>

      <div className={s.body}>{children}</div>

      {footer ? <footer className={s.foot}>{footer}</footer> : null}
    </aside>
  );
}
