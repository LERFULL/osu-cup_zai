import type { Beatmap, ModTag } from './types';

/**
 * Пересчёт того, что osu! API не отдаёт: AR, OD, CS, HP и BPM под модами.
 * Формулы те же, что в `src-tauri/src/osu/derive.rs` — менять только парой.
 *
 * Здесь копия, чтобы карточка перерисовывалась мгновенно при переключении
 * мода, без похода в Rust на каждый клик.
 */
export interface Derived {
  cs: number | null;
  ar: number | null;
  od: number | null;
  hp: number | null;
  bpm: number | null;
  totalLength: number | null;
}

const arToMs = (ar: number) => (ar < 5 ? 1800 - 120 * ar : 1200 - 150 * (ar - 5));
const msToAr = (ms: number) => (ms > 1200 ? (1800 - ms) / 120 : 5 + (1200 - ms) / 150);
const odToMs = (od: number) => 79.5 - 6 * od;
const msToOd = (ms: number) => (79.5 - ms) / 6;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

export function derive(map: Beatmap, mods: string): Derived {
  const m = mods.toUpperCase();

  let cs = map.cs;
  let ar = map.ar;
  let od = map.accuracy;
  let hp = map.drain;
  let bpm = map.bpm;
  let len = map.totalLength;

  // Сначала HR или EZ — они меняют базовые значения.
  if (m.includes('HR')) {
    if (cs !== null) cs = Math.min(10, cs * 1.3);
    if (ar !== null) ar = Math.min(10, ar * 1.4);
    if (od !== null) od = Math.min(10, od * 1.4);
    if (hp !== null) hp = Math.min(10, hp * 1.4);
  } else if (m.includes('EZ')) {
    if (cs !== null) cs *= 0.5;
    if (ar !== null) ar *= 0.5;
    if (od !== null) od *= 0.5;
    if (hp !== null) hp *= 0.5;
  }

  // Потом скорость. AR и OD пересчитываются через миллисекунды, не линейно.
  const rate = m.includes('DT') || m.includes('NC') ? 1.5 : m.includes('HT') ? 0.75 : 1;

  if (rate !== 1) {
    if (bpm !== null) bpm *= rate;
    if (len !== null) len = Math.round(len / rate);
    if (ar !== null) ar = clamp(msToAr(arToMs(ar) / rate), 0, 11);
    if (od !== null) od = clamp(msToOd(odToMs(od) / rate), 0, 11);
  }

  return {
    cs: cs === null ? null : round1(cs),
    ar: ar === null ? null : round1(ar),
    od: od === null ? null : round1(od),
    hp: hp === null ? null : round1(hp),
    bpm: bpm === null ? null : Math.round(bpm),
    totalLength: len,
  };
}

/** Моды, под которыми имеет смысл смотреть карту в карточке. */
export const CARD_MODS: readonly ModTag[] = ['NM', 'HD', 'HR', 'DT', 'EZ'];

/** Что можно разрешить на FM-карте. DT в фримоде не дают: он меняет длину матча. */
export const FM_CHOICES = ['HD', 'HR', 'EZ', 'FL'] as const;

/** Мод-тег -> строка модов для расчёта. HD и FM скорость не меняют. */
export function modsFor(tag: ModTag): string {
  switch (tag) {
    case 'HR':
      return 'HR';
    case 'DT':
      return 'DT';
    case 'EZ':
      return 'EZ';
    default:
      return '';
  }
}
