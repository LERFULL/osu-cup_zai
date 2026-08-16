// Цвета игроков. Зеркалят `db/players.rs` — менять только парой.
//
// Первые восемь — палитра, дальше считаются свои: на турнир в двадцать
// человек восьми цветов не хватает, а повторы в сетке не различить.

const PALETTE = [
  '#ff6fb1',
  '#5bc8f5',
  '#7ed957',
  '#ffd03b',
  '#c77dff',
  '#ff6b6b',
  '#4dd6c1',
  '#f7913d',
] as const;

/** Насыщенность и светлота по кругу: близкие оттенки расходятся по яркости. */
const TONES: [number, number][] = [
  [0.62, 0.66],
  [0.78, 0.58],
  [0.52, 0.74],
];

function hslToHex(hue: number, sat: number, light: number): string {
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;

  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];

  const hex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Цвет по номеру: золотое сечение по кругу оттенков после палитры. */
export function colorAt(n: number): string {
  const known = PALETTE[n];
  if (known !== undefined) return known;

  const step = n - PALETTE.length;
  const hue = (196 + step * 137.508) % 360;
  const [sat, light] = TONES[step % TONES.length] ?? [0.62, 0.66];
  return hslToHex(hue, sat, light);
}

/** Первый свободный цвет — как free_color на Rust. */
export function freeColor(taken: string[]): string {
  const busy = new Set(taken.map((c) => c.toLowerCase()));
  for (let n = 0; n < 512; n++) {
    const candidate = colorAt(n);
    if (!busy.has(candidate.toLowerCase())) return candidate;
  }
  return colorAt(0);
}

/**
 * Палитра выбора цвета: шестнадцать. Больше в один ряд кружков не влезает,
 * а различать на глаз двадцать оттенков всё равно не выходит.
 */
export const COLORS: string[] = Array.from({ length: 16 }, (_, n) => colorAt(n));
