import type { CSSProperties } from 'react';
import type { ModTag } from '@/lib/types';
import s from './Hex.module.css';

type CssVars = CSSProperties & Record<string, string | number>;

/** Цвет мода живёт в токенах — здесь только соответствие тега переменной. */
const MOD_VAR: Record<ModTag, string> = {
  NM: 'var(--nm)',
  HD: 'var(--hd)',
  HR: 'var(--hr)',
  DT: 'var(--dt)',
  FM: 'var(--fm)',
  EZ: 'var(--ez)',
  TB: 'var(--tb)',
};

export interface HexProps {
  mod: ModTag;
  /** Что написано внутри. По умолчанию — сам мод-тег. */
  label?: string;
  size?: 'sm' | 'md';
  /** Мод недоступен: серая заливка, свечения нет. */
  dim?: boolean;
  glow?: boolean;
  className?: string;
}

export function Hex({ mod, label, size = 'md', dim = false, glow = false, className }: HexProps) {
  const style: CssVars = { '--mod': MOD_VAR[mod] };

  const cls = [s.wrap, size === 'sm' ? s.sm : null, dim ? s.dim : glow ? s.glow : null, className]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={cls} style={style}>
      <span className={s.hex}>{label ?? mod}</span>
    </span>
  );
}
