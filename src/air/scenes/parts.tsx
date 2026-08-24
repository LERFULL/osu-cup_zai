// Общие части кадра. Всё, что встречается больше чем в одной сцене, живёт
// здесь: иначе двадцать шесть сцен превращаются в двадцать шесть вёрсток.

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { AirMap, AirPlayer } from '@/lib/air/types';
import type { ModTag } from '@/lib/types';
import s from './parts.module.css';

type Vars = CSSProperties & Record<string, string | number>;

/** Стиль строки списка: по нему считается задержка появления. */
export const at = (index: number): Vars => ({ '--i': index });

/**
 * Число, которое замечают, когда оно меняется.
 *
 * Счёт — главное событие в кадре, а подмена цифры на месте незаметна: глаз
 * ловит движение, а не значение. Поэтому при смене число толкается.
 */
export function Roll({ value, className }: { value: number | string; className?: string | undefined }) {
  const previous = useRef(value);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setChanged(true);
    const id = window.setTimeout(() => setChanged(false), 520);
    return () => window.clearTimeout(id);
  }, [value]);

  return (
    <span className={[className, changed ? s.rollPop : null].filter(Boolean).join(' ')}>
      {value}
    </span>
  );
}

/** Обложка набора берётся прямо с osu!: через хост она не идёт. */
export function coverOf(beatmapsetId: number | null): string | null {
  return beatmapsetId === null
    ? null
    : `https://assets.ppy.sh/beatmaps/${beatmapsetId}/covers/cover@2x.jpg`;
}

/** Аватар — тоже прямо с osu!, и тоже без авторизации. */
export function avatarOf(osuUserId: number | null): string | null {
  return osuUserId === null ? null : `https://a.ppy.sh/${osuUserId}`;
}

/** Превью-аудио набора. Десять секунд, отдаётся без токена. */
export function previewOf(beatmapsetId: number | null): string | null {
  return beatmapsetId === null ? null : `https://b.ppy.sh/preview/${beatmapsetId}.mp3`;
}

export function time(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export const stars = (n: number | null): string => (n === null ? '—' : n.toFixed(2));

/** Крупные числа читаются с трёх метров только с разделителями. */
export const big = (n: number | null): string =>
  n === null ? '—' : Math.round(n).toLocaleString('ru-RU');

/** Кадр сцены: заголовок сверху, содержимое под ним. */
export function Frame({
  title,
  note,
  children,
  wide,
}: {
  title: string;
  note?: string | null;
  children: ReactNode;
  /** Содержимое занимает всю ширину без отступов по бокам. */
  wide?: boolean;
}) {
  return (
    <div className={s.frame}>
      <header className={s.head}>
        <h1 className={s.title}>{title}</h1>
        {note != null && note !== '' ? <p className={s.note}>{note}</p> : null}
      </header>
      <div className={wide === true ? s.bodyWide : s.body}>{children}</div>
    </div>
  );
}
/** Кружок игрока: аватар из профиля, а без него — первая буква ника. */
export function Face({ player, size }: { player: AirPlayer; size: number }) {
  const src = avatarOf(player.osuUserId);
  const box: CSSProperties = { width: size, height: size, borderColor: player.color };

  if (src !== null) {
    return <img className={s.face} style={box} src={src} alt="" />;
  }
  return (
    <span
      className={s.letter}
      style={{ ...box, background: player.color, fontSize: Math.round(size * 0.42) }}
      aria-hidden
    >
      {player.nick.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Шестиугольник мода — справа от строки карты, как в приложении. */
export function Hex({
  mod,
  label,
  small,
}: {
  mod: ModTag;
  /** Что написано внутри. По умолчанию — сам мод-тег. */
  label?: string;
  small?: boolean;
}) {
  const style: Vars = { '--mod': `var(--${mod.toLowerCase()})` };
  return (
    <span className={[s.hexWrap, small === true ? s.hexSm : null].filter(Boolean).join(' ')} style={style}>
      <span className={s.hex}>{label != null && label !== '' ? label : mod}</span>
    </span>
  );
}

/** Игрок с аватаром, ником в своём цвете и подписью под ним. */
export function Head({
  player,
  size = 96,
  note,
  right,
  glow,
}: {
  player: AirPlayer;
  size?: number;
  note?: ReactNode;
  /** Зеркальная раскладка — для правой стороны кадра. */
  right?: boolean;
  glow?: boolean;
}) {
  const style: Vars = { '--who': player.color };
  return (
    <div
      className={[s.head2, right === true ? s.head2Right : null, glow === true ? s.head2Glow : null]
        .filter(Boolean)
        .join(' ')}
      style={style}
    >
      <Face player={player} size={size} />
      <div className={s.head2Text}>
        <div className={s.nick}>{player.nick}</div>
        {note != null ? <div className={s.head2Note}>{note}</div> : null}
      </div>
    </div>
  );
}

/** Строка карты: обложка фоном, название, цифры и шестиугольник справа. */
export function MapLine({
  map,
  end,
  dim,
  glow,
  stripe,
  compact,
  className,
  index,
}: {
  map: AirMap;
  end?: ReactNode;
  /** Забаненная или закрытая: обложка в чёрно-белом, свечения нет. */
  dim?: boolean;
  glow?: boolean;
  /** Полоса цветом игрока слева: чей это пик или бан. */
  stripe?: string | null;
  /**
   * Название и сложность в одну строку. Нужно там, где строк много: маппул
   * бывает на двенадцать карт плюс тайбрейк, и в две строки они не встают.
   */
  compact?: boolean;
  className?: string | undefined;
  /** Место в списке: по нему считается задержка появления. */
  index?: number;
}) {
  const cover = coverOf(map.beatmapsetId);
  const style: Vars = {
    '--mod': `var(--${map.mod.toLowerCase()})`,
    ...(stripe != null ? { '--who': stripe } : {}),
    ...(index != null ? { '--i': index } : {}),
  };

  return (
    <div
      className={[
        s.line,
        index != null ? s.lineIn : null,
        compact === true ? s.lineCompact : null,
        dim === true ? s.lineDim : null,
        glow === true ? s.lineGlow : null,
        stripe != null ? s.lineStripe : null,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
    >
      {cover !== null ? (
        <div className={s.lineCover} style={{ backgroundImage: `url("${cover}")` }} aria-hidden />
      ) : null}
      <div className={s.lineShade} aria-hidden />

      <div className={s.lineText}>
        <div className={s.lineTitle}>
          {map.title}
          {compact === true ? <span className={s.lineVersion}>{map.version}</span> : null}
        </div>
        {compact === true ? null : (
          <div className={s.lineSub}>
            {map.version}
            {map.mapper !== null ? ` · ${map.mapper}` : ''}
          </div>
        )}
      </div>

      <div className={s.lineEnd}>
        {end ?? (
          <span className={s.lineNums}>
            <span className={s.sr}>{stars(map.stars)}★</span>
            {map.length !== null ? <span className={s.dim}>{time(map.length)}</span> : null}
            {map.bpm !== null ? <span className={s.dim}>{Math.round(map.bpm)} BPM</span> : null}
          </span>
        )}
      </div>

      <Hex mod={map.mod} label={map.slot} />
    </div>
  );
}

/** Счёт двоих крупно, с целевым числом под ним. */
export function Score({
  a,
  b,
  scoreA,
  scoreB,
  target,
  bonus,
}: {
  a: AirPlayer;
  b: AirPlayer;
  scoreA: number;
  scoreB: number;
  target: number;
  bonus?: number;
}) {
  return (
    <div className={s.score}>
      <span className={s.scoreSide} style={{ color: a.color }}>
        {a.nick}
      </span>
      <span className={s.scoreNums}>
        <span className={scoreA > scoreB ? s.lead : undefined}>{scoreA}</span>
        <i>:</i>
        <span className={scoreB > scoreA ? s.lead : undefined}>{scoreB}</span>
      </span>
      <span className={`${s.scoreSide} ${s.scoreRight}`} style={{ color: b.color }}>
        {b.nick}
      </span>
      <span className={s.scoreTarget}>
        до {target}
        {/* Преимущество сетки — часть счёта, но не сыгранная карта: без подписи
            счёт 1:0 до первой карты выглядит ошибкой. */}
        {bonus !== undefined && bonus > 0 ? ` · преимущество +${bonus}` : ''}
      </span>
    </div>
  );
}

/** Плашка с числом и подписью — из них собраны все сцены со статистикой. */
export function Stat({
  name,
  value,
  note,
  index,
}: {
  name: string;
  value: ReactNode;
  note?: string | null;
  /** Место в списке: по нему считается задержка появления. */
  index?: number;
}) {
  return (
    <div
      className={[s.stat, index != null ? s.statIn : null].filter(Boolean).join(' ')}
      {...(index != null ? { style: at(index) } : {})}
    >
      <div className={s.statName}>{name}</div>
      <div className={s.statValue}>{value}</div>
      {note != null && note !== '' ? <div className={s.statNote}>{note}</div> : null}
    </div>
  );
}

/** Большая цифра посреди кадра: отсчёт, счёт, место. */
export function Huge({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <div className={s.huge} style={color != null ? { color } : undefined}>
      {children}
    </div>
  );
}
