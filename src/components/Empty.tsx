import type { ReactNode } from 'react';
import s from './Empty.module.css';

/**
 * Пустое состояние — не «ничего нет», а действие.
 * Заголовок говорит, что сделать, кнопки это делают.
 */
export interface EmptyProps {
  title: string;
  note?: string;
  actions?: ReactNode;
}

export function Empty({ title, note, actions }: EmptyProps) {
  return (
    <div className={s.wrap}>
      <div className={s.title}>{title}</div>
      {note ? <div className={s.note}>{note}</div> : null}
      {actions ? <div className={s.actions}>{actions}</div> : null}
    </div>
  );
}
