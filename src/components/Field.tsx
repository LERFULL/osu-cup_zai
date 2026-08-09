import type { InputHTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';
import s from './Field.module.css';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label: string;
  hint?: ReactNode;
  error?: string;
  /** Кнопка или значок справа внутри поля. */
  addon?: ReactNode;
}

export function Field({ label, hint, error, addon, id, ...rest }: FieldProps) {
  const auto = useId();
  const fieldId = id ?? auto;

  return (
    <div className={s.field}>
      <label className={s.label} htmlFor={fieldId}>
        {label}
      </label>

      <div className={[s.box, error ? s.bad : null].filter(Boolean).join(' ')}>
        <input className={s.input} id={fieldId} {...rest} />
        {addon ? <div className={s.addon}>{addon}</div> : null}
      </div>

      {error ? (
        <div className={s.err}>{error}</div>
      ) : hint ? (
        <div className={s.hint}>{hint}</div>
      ) : null}
    </div>
  );
}

/** Многострочное поле — для вставки списка ссылок. */
export interface AreaProps {
  label: string;
  hint?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}

export function Area({ label, hint, value, onChange, placeholder, rows = 8 }: AreaProps) {
  const id = useId();

  return (
    <div className={s.field}>
      <label className={s.label} htmlFor={id}>
        {label}
      </label>
      <textarea
        className={s.area}
        id={id}
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        {...(placeholder !== undefined ? { placeholder } : {})}
      />
      {hint ? <div className={s.hint}>{hint}</div> : null}
    </div>
  );
}
