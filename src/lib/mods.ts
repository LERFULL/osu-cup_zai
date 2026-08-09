import type { ModTag } from './types';

/** Битмаска osu! для комбинаций, которые нужны при запросе звёзд. */
const BITS: Record<string, number> = {
  NF: 1,
  EZ: 2,
  HD: 8,
  HR: 16,
  SD: 32,
  DT: 64,
  HT: 256,
  NC: 576,
  FL: 1024,
};

/** 'HDDT' -> 72. Неизвестные пары символов игнорируются. */
export function modsToBits(mods: string): number {
  let bits = 0;
  for (let i = 0; i + 1 < mods.length + 1; i += 2) {
    const pair = mods.slice(i, i + 2).toUpperCase();
    const bit = BITS[pair];
    if (bit != null) bits |= bit;
  }
  return bits;
}

/** Мод-тег слота -> моды, под которыми надо считать звёзды. */
export function slotMods(tag: ModTag): string {
  switch (tag) {
    case 'HD':
      return 'HD';
    case 'HR':
      return 'HR';
    case 'DT':
      return 'DT';
    case 'EZ':
      return 'EZ';
    // FM и TB играются с любыми модами, показываем базовые звёзды.
    default:
      return '';
  }
}

export const MOD_COLOR: Record<ModTag, string> = {
  NM: 'var(--nm)',
  HD: 'var(--hd)',
  HR: 'var(--hr)',
  DT: 'var(--dt)',
  FM: 'var(--fm)',
  EZ: 'var(--fm)',
  TB: 'var(--tb)',
};
