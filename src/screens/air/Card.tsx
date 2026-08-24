import type { ReactNode } from 'react';
import s from './Card.module.css';

/**
 * Карточка раздела пульта. Не `Panel` из общих: та — боковая панель с крестиком,
 * а здесь блоки стоят в колонке и не закрываются.
 */
export function Card({
  title,
  note,
  right,
  children,
}: {
  title: string;
  note?: string;
  /** Кнопка или значение в правом углу заголовка. */
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={s.card}>
      <header className={s.head}>
        <div>
          <h2 className={s.title}>{title}</h2>
          {note !== undefined ? <p className={s.note}>{note}</p> : null}
        </div>
        {right !== undefined ? <div className={s.right}>{right}</div> : null}
      </header>
      <div className={s.body}>{children}</div>
    </section>
  );
}
