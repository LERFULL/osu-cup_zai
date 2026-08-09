import type { LibraryFilter, Range } from './types';

/** Секунды в mm:ss. */
export function formatLength(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function formatStars(stars: number | null | undefined): string {
  if (stars == null || !Number.isFinite(stars)) return '—';
  return stars.toFixed(2);
}

export function formatBpm(bpm: number | null | undefined): string {
  if (bpm == null || !Number.isFinite(bpm)) return '—';
  return String(Math.round(bpm));
}

/** «34 карты», «1 карта», «22 карты» — с правильным окончанием. */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

export function maps(n: number): string {
  return `${n} ${plural(n, 'карта', 'карты', 'карт')}`;
}

/** Есть ли в фильтре хоть одно условие, кроме коллекции и сортировки. */
export function filterIsSet(f: LibraryFilter): boolean {
  return (
    f.query.trim() !== '' ||
    f.mods.length > 0 ||
    f.skillsets.length > 0 ||
    f.labelIds.length > 0 ||
    f.statuses.length > 0 ||
    f.stars.min !== null ||
    f.stars.max !== null ||
    f.bpm.min !== null ||
    f.bpm.max !== null ||
    f.length.min !== null ||
    f.length.max !== null
  );
}

/** Условия фильтра одной строкой — для названия умной коллекции и подсказок. */
export function filterSummary(f: LibraryFilter): string {
  const parts: string[] = [];
  if (f.mods.length > 0) parts.push(f.mods.join(', '));
  const stars = range(f.stars, (n) => n.toFixed(1));
  if (stars !== null) parts.push(`${stars}★`);
  const bpm = range(f.bpm, (n) => String(Math.round(n)));
  if (bpm !== null) parts.push(`${bpm} BPM`);
  const len = range(f.length, formatLength);
  if (len !== null) parts.push(len);
  if (f.skillsets.length > 0) parts.push(f.skillsets.join(', '));
  if (f.query.trim() !== '') parts.push(`«${f.query.trim()}»`);
  return parts.length > 0 ? parts.join(' · ') : 'без условий';
}

function range(r: Range, fmt: (n: number) => string): string | null {
  if (r.min === null && r.max === null) return null;
  if (r.min !== null && r.max !== null) return `${fmt(r.min)}–${fmt(r.max)}`;
  return r.min !== null ? `от ${fmt(r.min)}` : `до ${fmt(r.max as number)}`;
}

/** Путь к файлу на диске -> URL, который отдаст вебвью через asset-протокол. */
export function coverUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return `${convertSrc(path)}`;
}

function convertSrc(path: string): string {
  // Tauri отдаёт локальные файлы через свой протокол; на вебе такого нет.
  const w = window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc?: (p: string) => string } };
  const convert = w.__TAURI_INTERNALS__?.convertFileSrc;
  return convert ? convert(path) : path;
}
