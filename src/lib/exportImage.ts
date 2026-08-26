// Экспорт картинкой: маппул и сетка турнира как PNG.
//
// Всё считается в браузере, Rust не участвует: canvas умеет и обложки, и
// моноширинные цифры, а сетку дешевле собрать SVG-строкой и растеризовать её
// тем же canvas — раскладку берём готовую из bracketLayout, ту же, что рисует
// экран турнира. Один пресет, без настроек: тёмная тема, как в приложении.

import type { Bracket, BracketSide, Match, Pool, TournamentPlayer } from './types';
import { coverUrl } from './format';
import { derive, modsFor } from './derive';
import { CARD_H, COL_W, layoutBracket } from './bracketLayout';

// ─────────────────────────────────────────────────────────────── общее

/** Фон картинки — чуть светлее фона приложения, чтобы на нём читались строки. */
const BG = '#0E1015';
const CARD = '#161922';
const LINE = '#232838';
const TEXT = '#F4F5F8';
const MUTED = '#8A91A3';
const MONO = '"IBM Plex Mono", ui-monospace, monospace';
const SANS = '"Manrope Variable", system-ui, "Segoe UI", sans-serif';

/** Цвет мод-тега — та же палитра, что в плашках слотов (tokens.css). */
const MOD_HEX: Record<string, string> = {
  NM: '#E9ECF2',
  HD: '#FFD03B',
  HR: '#FF6B6B',
  DT: '#5BC8F5',
  FM: '#C77DFF',
  EZ: '#7ED957',
  TB: '#7ED957',
};

/** Шапка «osu!cup · 2026»: имя турнира, если он известен, и текущий год. */
function headLine(tournamentName: string | null): string {
  return `${tournamentName ?? 'osu!cup'} · ${new Date().getFullYear()}`;
}

/** Загрузка картинки без TTL и без исключений: не вышло — null. */
function loadImage(url: string, cors: boolean): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    if (cors) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * Обложка карты для канваса. Сначала локальный кеш (в браузерном моке это
 * data: URL, в Tauri — файл через asset-протокол), потом assets.ppy.sh:
 * обложки с osu! отдаются без CORS-заголовков, так что удалённая попытка
 * рассчитывать не на что — но если когда-нибудь появятся, заработает сама.
 */
async function loadCover(coverPath: string | null, setId: number | null): Promise<HTMLImageElement | null> {
  const local = coverUrl(coverPath);
  if (local !== null) {
    const img = await loadImage(local, false);
    if (img !== null) return img;
  }
  if (setId !== null) {
    return loadImage(`https://assets.ppy.sh/beatmaps/${setId}/covers/cover.jpg`, true);
  }
  return null;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    // Испачканный кросс-доменной картинкой canvas бросает SecurityError
    // синхронно; webkit-варианты вместо этого отдают null — ловим оба.
    try {
      canvas.toBlob(
        (b) => (b === null ? reject(new Error('PNG не собрался')) : resolve(b)),
        'image/png',
      );
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** Скачивает Blob файлом: файлового диалога у окна нет. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export type CopyOutcome = 'clipboard' | 'download';

/**
 * Кладёт PNG в буфер обмена, а когда буфера нет — скачивает файлом.
 *
 * ClipboardItem может отсутствовать (WebView2, headless-браузер), а запись —
 * отказать без фокуса окна: оба случая уходят в скачивание, молча.
 */
export async function copyImage(blob: Blob, filename: string): Promise<CopyOutcome> {
  try {
    const w = window as unknown as { ClipboardItem?: typeof ClipboardItem };
    if (
      typeof ClipboardItem === 'function' &&
      w.ClipboardItem !== undefined &&
      navigator.clipboard !== undefined
    ) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return 'clipboard';
    }
  } catch {
    // Буфер недоступен — ниже скачивание, это штатный путь, а не ошибка.
  }
  downloadBlob(blob, filename);
  return 'download';
}

// ───────────────────────────────────────────────────────── маппул

const POOL_W = 1200;
const ROW_H = 108;
const ROW_GAP = 14;
const COVER_W = 192;
const PAD = 48;
const HEAD_H = 132;

/**
 * Маппул картинкой: тёмный фон, шапка с названием, обложки, строки слотов.
 * Обложки грузятся с фолбэком: не загрузилась — плейсхолдер-прямоугольник.
 */
export async function renderPoolImage(pool: Pool, tournamentName: string | null): Promise<Blob> {
  const rows = pool.slots;
  const height = HEAD_H + rows.length * (ROW_H + ROW_GAP) + PAD;
  const covers = await Promise.all(
    rows.map((slot) =>
      slot.beatmap === null ? Promise.resolve(null) : loadCover(slot.beatmap.coverPath, slot.beatmap.beatmapsetId),
    ),
  );

  try {
    return await drawPool(pool, tournamentName, height, covers);
  } catch {
    // Канвас испачкан кросс-доменной картинкой без CORS — рисуем без обложек:
    // картинка без обложек лучше, чем никакой.
    const none: (HTMLImageElement | null)[] = rows.map(() => null);
    return drawPool(pool, tournamentName, height, none);
  }
}

function drawPool(
  pool: Pool,
  tournamentName: string | null,
  height: number,
  covers: (HTMLImageElement | null)[],
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = POOL_W;
  canvas.height = Math.max(height, HEAD_H + ROW_H + PAD);
  const ctx = canvas.getContext('2d');
  if (ctx === null) return Promise.reject(new Error('Canvas недоступен'));

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Шапка: название пула крупно, под ним — турнир и год.
  ctx.fillStyle = TEXT;
  ctx.font = `700 40px ${SANS}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(pool.name, PAD, 68);
  ctx.fillStyle = MUTED;
  ctx.font = `20px ${SANS}`;
  ctx.fillText(headLine(tournamentName), PAD, 100);
  ctx.fillStyle = LINE;
  ctx.fillRect(PAD, HEAD_H - 18, POOL_W - PAD * 2, 2);

  pool.slots.forEach((slot, i) => {
    const y = HEAD_H + i * (ROW_H + ROW_GAP);
    const map = slot.beatmap;
    const cover = covers[i] ?? null;

    // Обложка или её место: 16:9, в рост строки.
    if (cover !== null) {
      drawCover(ctx, cover, PAD, y, COVER_W, ROW_H);
    } else {
      ctx.fillStyle = CARD;
      roundRect(ctx, PAD, y, COVER_W, ROW_H, 8);
      ctx.fill();
      ctx.strokeStyle = LINE;
      ctx.stroke();
    }

    const labelX = PAD + COVER_W + 24;
    const textX = labelX + 96;

    // Метка слота цветом мода.
    ctx.fillStyle = MOD_HEX[slot.mod] ?? TEXT;
    ctx.font = `700 26px ${SANS}`;
    ctx.fillText(slot.slotLabel, labelX, y + 44);

    ctx.fillStyle = TEXT;
    ctx.font = `600 26px ${SANS}`;
    ctx.fillText(map === null ? 'карта не подобрана' : `${map.artist} — ${map.title}`, textX, y + 44);

    // Вторая строка: сложность и маппер.
    ctx.fillStyle = MUTED;
    ctx.font = `20px ${SANS}`;
    const second =
      map === null
        ? slot.mod === 'FM' && slot.fmMods.length > 0
          ? `разрешено: ${slot.fmMods.join(' ')}`
          : 'выбрать из библиотеки'
        : [map.version, map.creator ?? null].filter((x) => x !== null && x !== '').join(' · ');
    ctx.fillText(cut(ctx, second, POOL_W - PAD - 300 - textX), textX, y + 78);

    // Цифры — моноширинным, прижаты вправо: звёзды под модом и BPM.
    if (map !== null) {
      const stars = slot.starRatingWithMods ?? map.difficultyRating;
      const d = derive(map, modsFor(slot.mod));
      ctx.font = `500 22px ${MONO}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = MOD_HEX[slot.mod] ?? TEXT;
      ctx.fillText(`${stars.toFixed(2)}★`, POOL_W - PAD, y + 44);
      ctx.fillStyle = MUTED;
      ctx.fillText(d.bpm === null ? '' : `${Math.round(d.bpm)} BPM`, POOL_W - PAD, y + 78);
      ctx.textAlign = 'left';
    }

    if (slot.pinned) {
      // Закреплённый слот помечаем точкой у метки: перекат его не тронет.
      ctx.fillStyle = MUTED;
      ctx.font = `20px ${SANS}`;
      ctx.fillText('📌', labelX - 30, y + 44);
    }
  });

  // Счётчик пустых строк не рисуем: незаполненные слоты видны сами.
  return canvasBlob(canvas);
}

/** Обложка вписывается в прямоугольник с обрезкой лишнего. */
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.save();
  roundRect(ctx, x, y, w, h, 8);
  ctx.clip();
  // Обложки шире своей высоты: центрируем по ширине, лишнее срезает clip.
  const scale = h / img.height;
  const width = img.width * scale;
  ctx.drawImage(img, x + (w - width) / 2, y, width, h);
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  // roundRect есть во всех современных движках; на его отсутствие не рассчитываем.
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
}

/** Обрезает текст под ширину с многоточием — canvas не умеет переносов. */
function cut(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 40 || ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

// ─────────────────────────────────────────────────────────── сетка

/**
 * Сетка турнира картинкой: та же раскладка, что на экране, собранная в SVG
 * (простые прямоугольники и текст системным шрифтом) и растертая в PNG.
 */
export async function renderBracketImage(bracket: Bracket): Promise<Blob> {
  const layout = layoutBracket(bracket.matches);
  const PAD_ALL = 32;
  const TITLE_H = 76;
  const width = layout.width + PAD_ALL * 2;
  const height = layout.height + PAD_ALL * 2 + TITLE_H;

  const svg = bracketSvg(bracket, layout, PAD_ALL, TITLE_H, width, height);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  // SVG из data: URL не пачкает канвас: внешних ресурсов внутри нет.
  const img = await loadImage(url, false);
  if (img === null) throw new Error('Сетка не собралась в картинку');

  const scale = 2; // двухкратный масштаб — текст на сетке мелкий, резкость нужна.
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('Canvas недоступен');
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, width, height);

  return canvasBlob(canvas);
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Название раунда — та же формула, что в BracketView. */
function roundTitle(side: BracketSide, round: number, last: number): string {
  if (side === 'grand') return 'Гранд-финал';
  const left = last - round;
  if (left === 0) return side === 'upper' ? 'Финал верхней' : 'Финал нижней';
  if (left === 1) return 'Полуфинал';
  return `Раунд ${round}`;
}

export function bracketSvg(
  bracket: Bracket,
  layout: ReturnType<typeof layoutBracket>,
  pad: number,
  titleH: number,
  width: number,
  height: number,
): string {
  const byId = new Map<number, TournamentPlayer>();
  bracket.players.forEach((p, i) => byId.set(p.playerId, { ...p, seed: p.seed ?? i + 1 }));

  const out: string[] = [];
  const push = (s: string) => out.push(s);

  push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `font-family="${SANS.replace(/"/g, "'")}">`,
  );
  push(`<rect width="${width}" height="${height}" fill="${BG}"/>`);

  // Шапка: турнир и год.
  push(
    `<text x="${pad}" y="${pad + 30}" fill="${TEXT}" font-size="26" font-weight="700">` +
      `${esc(bracket.name)}</text>`,
  );
  push(
    `<text x="${pad}" y="${pad + 58}" fill="${MUTED}" font-size="15">${esc(headLine(null))}</text>`,
  );

  const off = `translate(${pad} ${pad + titleH})`;

  // Подписи раундов.
  for (const h of layout.heads) {
    push(
      `<text x="${h.x}" y="${h.y + 18}" fill="${MUTED}" font-size="13" ` +
        `font-weight="600">${esc(roundTitle(h.side, h.round, h.lastRound))}</text>`,
    );
  }

  // Линии связей — серые, уголком; падение в нижнюю сетку пунктиром.
  push(`<g transform="${off}" fill="none" stroke="#39415A" stroke-width="2">`);
  for (const link of layout.links) {
    const dash = link.drop ? ' stroke-dasharray="6 6"' : '';
    push(`<path d="${link.d}"${dash}/>`);
  }
  push('</g>');

  // Карточки матчей.
  push(`<g transform="${off}">`);
  for (const m of layout.shown) {
    const x = layout.colX(layout.columnOf(m));
    const y = layout.topOf(m);
    const done = m.status === 'finished';
    push(
      `<rect x="${x}" y="${y}" width="${COL_W}" height="${CARD_H}" rx="10" ` +
        `fill="${CARD}" stroke="${done ? '#2F3648' : LINE}"/>`,
    );
    sideRow(m, 'a');
    sideRow(m, 'b');
  }
  push('</g>');
  push('</svg>');

  return out.join('\n');

  function sideRow(m: Match, side: 'a' | 'b'): void {
    const x = layout.colX(layout.columnOf(m));
    const y = layout.topOf(m);
    const id = side === 'a' ? m.playerA : m.playerB;
    const rowY = side === 'a' ? y + 27 : y + 51;
    const seed = id === null ? '?' : `#${byId.get(id)?.seed ?? '—'}`;
    const score = (side === 'a' ? m.scoreA + m.bonusA : m.scoreB + m.bonusB).toString();
    const won = m.winnerId !== null && id === m.winnerId;
    const lost = m.winnerId !== null && id !== null && !won;

    push(
      `<text x="${x + 12}" y="${rowY}" fill="${MUTED}" font-size="12" ` +
        `font-family="${MONO.replace(/"/g, "'")}">${esc(seed)}</text>`,
    );

    if (id === null) {
      push(
        `<text x="${x + 44}" y="${rowY}" fill="#565D70" font-size="14">ждёт</text>`,
      );
      return;
    }

    const player = byId.get(id);
    const nick = player?.nickname ?? 'игрок';
    const color = player?.color ?? MUTED;

    // Цветная полоса игрока — как на сетке приложения.
    push(`<rect x="${x + 44}" y="${rowY - 12}" width="3" height="16" fill="${color}"/>`);
    push(
      `<text x="${x + 56}" y="${rowY}" fill="${won ? TEXT : lost ? MUTED : TEXT}" ` +
        `font-size="14"${won ? ' font-weight="700"' : ''}>${esc(nick)}</text>`,
    );
    push(
      `<text x="${x + COL_W - 12}" y="${rowY}" fill="${won ? TEXT : MUTED}" font-size="14" ` +
        `text-anchor="end" font-family="${MONO.replace(/"/g, "'")}">${esc(score)}</text>`,
    );
  }
}
