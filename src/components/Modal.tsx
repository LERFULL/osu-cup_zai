import { useEffect } from 'react';
import type { ReactNode } from 'react';
import s from './Modal.module.css';

/**
 * Диалог поверх экрана. Один на всё приложение: фон, крестик, Esc и клик по
 * фону закрывают. Содержимое — просто дети, обрамление здесь.
 */
export function Modal({
  title,
  note,
  wide,
  onClose,
  children,
  footer,
}: {
  title: string;
  note?: string | null;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  // Esc закрывает — но не раньше, чем поля ввода перестанут его слушать:
  // слушатель висит на окне и срабатывает только без фокуса в поле.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className={s.back}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className={[s.card, wide === true ? s.cardWide : null].filter(Boolean).join(' ')}>
        <header className={s.head}>
          <div>
            <h2 className={s.title}>{title}</h2>
            {note != null && note !== '' ? <p className={s.note}>{note}</p> : null}
          </div>
          <button className={s.close} type="button" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </header>

        <div className={s.body}>{children}</div>

        {footer != null ? <footer className={s.foot}>{footer}</footer> : null}
      </div>
    </div>
  );
}
