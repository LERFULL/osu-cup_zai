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
