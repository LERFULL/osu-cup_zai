import { useCallback, useId, useRef } from 'react';
import s from './RangeSlider.module.css';

export type RangeValue = [number | null, number | null];

export interface RangeSliderProps {
  min: number;
  max: number;
  step?: number;
  value: RangeValue;
  onChange: (v: RangeValue) => void;
  /** Как подписать значение. По умолчанию — как есть. */
  format?: (n: number) => string;
  label?: string;
}

export function RangeSlider({
  min,
  max,
  step = 1,
  value,
  onChange,
  format,
  label,
}: RangeSliderProps) {
  const id = useId();
  const track = useRef<HTMLDivElement>(null);

  // null означает «граница не задана» — показываем её на краю шкалы.
  const lo = value[0] ?? min;
  const hi = value[1] ?? max;

  const show = useCallback((n: number) => (format ? format(n) : String(n)), [format]);
  const pct = (n: number) => ((n - min) / (max - min)) * 100;

  const setLo = (n: number) => {
    const next = Math.min(n, hi);
    onChange([next <= min ? null : next, value[1]]);
  };

  const setHi = (n: number) => {
    const next = Math.max(n, lo);
    onChange([value[0], next >= max ? null : next]);
  };

  const untouched = value[0] === null && value[1] === null;

  return (
    <div className={s.wrap}>
      {label ? (
        <div className={s.head}>
          <span className={s.label}>{label}</span>
          <span className={[s.readout, untouched ? s.any : null].filter(Boolean).join(' ')}>
            {untouched ? 'любые' : `${show(lo)} — ${show(hi)}`}
          </span>
        </div>
      ) : null}

      <div className={s.track} ref={track}>
        <div className={s.rail} />
        <div
          className={s.fill}
          style={{ left: `${pct(lo)}%`, right: `${100 - pct(hi)}%` }}
          aria-hidden
        />

        <input
          className={s.input}
          id={`${id}-lo`}
          type="range"
          min={min}
          max={max}
          step={step}
          value={lo}
          onChange={(e) => setLo(Number(e.target.value))}
          aria-label={label ? `${label}: минимум` : 'Минимум'}
        />
        <input
          className={s.input}
          id={`${id}-hi`}
          type="range"
          min={min}
          max={max}
          step={step}
          value={hi}
          onChange={(e) => setHi(Number(e.target.value))}
          aria-label={label ? `${label}: максимум` : 'Максимум'}
        />
      </div>
    </div>
  );
}
