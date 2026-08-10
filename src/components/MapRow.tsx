import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import type { ModTag } from '@/lib/types';
import type { GripProps } from '@/lib/useReorder';
import { Hex } from './Hex';
import { Button } from './Button';
import s from './MapRow.module.css';

type CssVars = CSSProperties & Record<string, string | number>;

const MOD_VAR: Record<ModTag, string> = {
  NM: 'var(--nm)',
  HD: 'var(--hd)',
  HR: 'var(--hr)',
  DT: 'var(--dt)',
  FM: 'var(--fm)',
  EZ: 'var(--ez)',
  TB: 'var(--tb)',
};

/** Правая часть строки — единственное, что меняется между экранами. */
export type MapRowEnd =
  | { kind: 'plain'; stars: number; length?: number; bpm?: number }
  | { kind: 'ban'; n: number }
  | { kind: 'live' }
  | { kind: 'done'; winner: string; color: string }
  | { kind: 'lock'; hint: string }
  | { kind: 'pick'; onPick: () => void };

export interface MapRowBase {
  cover: string | null;
  title: string;
  version: string;
  artist?: string;
  /** Метка слота маппула, например NM1. Без неё в шестиугольнике сам мод. */
  slot?: string;
  mod: ModTag;
  /** У карты не проставлено ни одного мод-тега. Шестиугольник приглушён и
   *  показывает прочерк: «NM по умолчанию» выдавал бы тег, которого нет. */
  untagged?: boolean;
  /** Отмечена галочкой — попадёт под массовое действие. */
  selected?: boolean;
  /** Открыта в боковой панели. Подсвечивается рамкой, галочку не ставит:
   *  посмотреть карту и выбрать её для удаления — разные намерения. */
  opened?: boolean;
  onClick?: () => void;
  /** Показать чекбокс. С обработчиком он кликается отдельно от строки. */
  checkbox?: boolean;
  onToggleSelect?: (shift: boolean) => void;
  /** Ручка перетаскивания слева. Тянется только она, а не вся строка:
   *  иначе нажатие на любую кнопку внутри начинало бы перетаскивание.
   *  Обработчики приходят снаружи — порядок строк знает список, а не строка. */
  gripProps?: GripProps;
  /** Сколько ещё сложностей в наборе. Кнопка видна всегда, а не по наведению:
   *  иначе о свёрнутых сложностях нельзя догадаться, не поводив мышью. */
  expand?: { count: number; open: boolean; onToggle: () => void };
  /** Кнопки слота. Занимают своё место в строке, ничего не загораживая. */
  tools?: ReactNode;
  /** Показывать кнопки всегда, а не по наведению. Для действия, которого
   *  прямо сейчас ждут: искать его мышью — лишний шаг. */
  toolsPinned?: boolean;
  className?: string;
}

export type MapRowProps = MapRowBase & MapRowEnd;

function time(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

const STATE_CLASS: Record<MapRowEnd['kind'], string | null> = {
  plain: null,
  ban: s.ban ?? null,
  live: s.live ?? null,
  done: s.done ?? null,
  lock: s.lock ?? null,
  pick: null,
};

export function MapRow(props: MapRowProps) {
  const {
    cover,
    title,
    version,
    artist,
    slot,
    mod,
    untagged,
    selected,
    opened,
    onClick,
    checkbox,
    onToggleSelect,
    gripProps,
    expand,
    tools,
    toolsPinned,
    className,
  } = props;

  // Приглушённые состояния гасит обёртка шестиугольника — свечения у них нет.
  const glow = props.kind === 'plain' || props.kind === 'live' || props.kind === 'pick';
  const muted = props.kind === 'ban' || props.kind === 'lock';

  const style: CssVars = { '--mod': MOD_VAR[mod] };

  const cls = [
    s.row,
    STATE_CLASS[props.kind],
    selected ? s.selected : null,
    opened ? s.opened : null,
    onClick ? s.clickable : null,
    tools !== undefined && toolsPinned !== true ? s.withTools : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!onClick) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  const stop = (e: MouseEvent) => e.stopPropagation();

  return (
    <div
      className={cls}
      style={style}
      {...(onClick
        ? {
            onClick,
            onKeyDown: keyDown,
            role: 'button',
            tabIndex: 0,
            'aria-current': opened === true,
          }
        : {})}
    >
      {cover !== null && (
        <div className={s.cover} style={{ backgroundImage: `url("${cover}")` }} aria-hidden />
      )}
      <div className={s.shade} aria-hidden />
      <div className={s.tint} aria-hidden />

      {gripProps !== undefined ? (
        <span className={s.grip} title="Потянуть, чтобы переставить" onClick={stop} {...gripProps}>
          ⠿
        </span>
      ) : null}

      {checkbox === true ? (
        onToggleSelect ? (
          <button
            className={s.cb}
            type="button"
            aria-pressed={selected === true}
            aria-label={selected === true ? 'Снять выделение' : 'Выделить'}
            onClick={(e) => {
              stop(e);
              onToggleSelect(e.shiftKey);
            }}
          >
            ✓
          </button>
        ) : (
          <span className={s.cb} aria-hidden>
            ✓
          </span>
        )
      ) : null}

      <div className={s.info}>
        <div className={s.title}>{artist !== undefined ? `${artist} — ${title}` : title}</div>
        <div className={s.sub}>{version}</div>
      </div>

      {expand !== undefined ? (
        <button
          className={[s.expand, expand.open ? s.expandOpen : null].filter(Boolean).join(' ')}
          type="button"
          aria-expanded={expand.open}
          title={expand.open ? 'Свернуть сложности' : 'Показать все сложности набора'}
          onClick={(e) => {
            stop(e);
            expand.onToggle();
          }}
        >
          <span className={s.expandArrow} aria-hidden>
            ▸
          </span>
          {expand.count}
        </button>
      ) : null}

      <div className={s.end}>
        {props.kind === 'plain' && (
          <span>
            <span className={s.sr}>{props.stars.toFixed(2)}★</span>
            {props.length !== undefined ? ` · ${time(props.length)}` : ''}
            {props.bpm !== undefined ? ` · ${Math.round(props.bpm)} BPM` : ''}
          </span>
        )}

        {props.kind === 'ban' && <span className={s.banx}>✕ бан {props.n}</span>}

        {props.kind === 'live' && (
          <span className={s.nowtag}>
            <i aria-hidden />
            идёт
          </span>
        )}

        {props.kind === 'done' && (
          <span className={s.won} style={{ '--win': props.color } as CssVars}>
            <span className={s.crown} aria-hidden>
              ♛
            </span>
            <i aria-hidden />
            {props.winner}
          </span>
        )}

        {props.kind === 'lock' && <span className={s.lockt}>{props.hint}</span>}

        {props.kind === 'pick' && (
          <Button
            variant="primary"
            size="sm"
            onClick={(e) => {
              stop(e);
              props.onPick();
            }}
          >
            Выбрать
          </Button>
        )}
      </div>

      {tools !== undefined ? (
        // Кнопки внутри строки, а строка кликается целиком: без этого нажатие
        // на любую из них заодно открывало бы карту.
        <div
          className={[s.tools, toolsPinned === true ? s.toolsPinned : null]
            .filter(Boolean)
            .join(' ')}
          onClick={stop}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {tools}
        </div>
      ) : null}

      <span className={s.hexslot}>
        <Hex
          mod={mod}
          glow={glow && untagged !== true}
          dim={muted || untagged === true}
          {...(untagged === true ? { label: '—' } : slot !== undefined ? { label: slot } : {})}
        />
      </span>
    </div>
  );
}
