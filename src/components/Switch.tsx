import type { ReactNode } from 'react';
import s from './Switch.module.css';

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
  /** Пояснение под строкой — когда из названия не видно, что правило делает. */
  note?: ReactNode;
  disabled?: boolean;
}

/** Переключатель правила: вся строка кликабельна, не только сам тумблер. */
export function Switch({ checked, onChange, children, note, disabled = false }: SwitchProps) {
  const cls = [s.sw, checked ? s.on : null, disabled ? s.off : null].filter(Boolean).join(' ');

  return (
    <button
      className={cls}
      onClick={() => onChange(!checked)}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
    >
      <i className={s.knob} aria-hidden />
      <span className={s.body}>
        <span className={s.label}>{children}</span>
        {note !== undefined ? <span className={s.note}>{note}</span> : null}
      </span>
    </button>
  );
}
