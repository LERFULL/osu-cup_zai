import { useState } from 'react';
import { Button, Menu, MenuItem, MenuSeparator } from '@/components';
import type { Series } from '@/lib/types';
import s from './Tree.module.css';

/** Где мы находимся в дереве маппулов. */
export type Place =
  | { kind: 'all' }
  | { kind: 'series'; id: number }
  | { kind: 'loose' }
  | { kind: 'templates' }
  | { kind: 'archive' };

interface Props {
  place: Place;
  series: Series[];
  counts: { all: number; loose: number; templates: number; archive: number };
  onSelect: (place: Place) => void;
  onMakeSeries: (kind: 'tournament' | 'free') => void;
  onMakePool: () => void;
  /** Маппул перетащили на серию. */
  onDropPool: (seriesId: number, poolId: number) => void;
  onRename: (x: Series) => void;
  onColor: (x: Series) => void;
  onKind: (x: Series) => void;
  onDuplicate: (x: Series) => void;
  onDelete: (x: Series) => void;
  onReorder: (ids: number[]) => void;
}

const KIND_NAME = { tournament: 'турнирная', free: 'свободная' } as const;

/**
 * Дерево маппулов: серии, пулы без серии, шаблоны и архив. Устроено как дерево
 * коллекций в библиотеке — одно и то же движение мышью в двух местах.
 */
export function Tree({
  place,
  series,
  counts,
  onSelect,
  onMakeSeries,
  onMakePool,
  onDropPool,
  onRename,
  onColor,
  onKind,
  onDuplicate,
  onDelete,
  onReorder,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [dragged, setDragged] = useState<number | null>(null);

  const system = (kind: Place['kind'], label: string, count: number) => (
    <button
      className={[s.row, s.system, place.kind === kind ? s.on : null].filter(Boolean).join(' ')}
      onClick={() => onSelect({ kind } as Place)}
      type="button"
    >
      <span className={s.name}>{label}</span>
      <span className={s.count}>{count}</span>
    </button>
  );

  return (
    <aside className={s.tree}>
      {system('all', 'Все маппулы', counts.all)}

      {series.length > 0 ? <div className={s.head}>Серии</div> : null}

      {series.map((x) => (
        <div
          key={x.id}
          className={[s.rowWrap, over === x.id ? s.over : null].filter(Boolean).join(' ')}
          onDragOver={(e) => {
            // Перетаскивают либо маппул сюда, либо саму серию для порядка.
            e.preventDefault();
            setOver(x.id);
          }}
          onDragLeave={() => setOver((prev) => (prev === x.id ? null : prev))}
          onDrop={(e) => {
            e.preventDefault();
            setOver(null);

            const raw = e.dataTransfer.getData('text/plain');
            if (raw.startsWith('pool:')) {
              const poolId = Number(raw.slice(5));
              if (Number.isFinite(poolId)) onDropPool(x.id, poolId);
              return;
            }
            if (dragged !== null && dragged !== x.id) {
              const ids = series.map((y) => y.id).filter((y) => y !== dragged);
              const at = ids.indexOf(x.id);
              ids.splice(at < 0 ? ids.length : at, 0, dragged);
              onReorder(ids);
            }
          }}
        >
          <button
            className={[
              s.row,
              place.kind === 'series' && place.id === x.id ? s.on : null,
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => onSelect({ kind: 'series', id: x.id })}
            type="button"
            draggable
            onDragStart={(e) => {
              setDragged(x.id);
              e.dataTransfer.setData('text/plain', `series:${x.id}`);
            }}
            onDragEnd={() => setDragged(null)}
            title={`${KIND_NAME[x.kind]} серия`}
          >
            <span className={s.dot} style={{ background: x.color ?? '#4A5164' }} aria-hidden />
            <span className={s.name}>{x.name}</span>
            <span className={s.count}>{x.pools.length}</span>
          </button>

          <button
            className={s.more}
            onClick={() => setMenu(menu === x.id ? null : x.id)}
            type="button"
            aria-label="Действия"
          >
            ⋯
          </button>

          <Menu open={menu === x.id} onClose={() => setMenu(null)} align="right">
            <MenuItem
              onClick={() => {
                setMenu(null);
                onRename(x);
              }}
            >
              Переименовать
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenu(null);
                onColor(x);
              }}
            >
              Сменить цвет
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenu(null);
                onKind(x);
              }}
              note={`Сейчас ${KIND_NAME[x.kind]}`}
            >
              {x.kind === 'tournament' ? 'Сделать свободной' : 'Сделать турнирной'}
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenu(null);
                onDuplicate(x);
              }}
              note="Правила скопируются, маппулы — нет"
            >
              Дублировать
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              danger
              note="Маппулы вернутся в общий список"
              onClick={() => {
                setMenu(null);
                onDelete(x);
              }}
            >
              Удалить
            </MenuItem>
          </Menu>
        </div>
      ))}

      <div className={s.head}>Ещё</div>
      {system('loose', 'Без серии', counts.loose)}
      {system('templates', 'Шаблоны', counts.templates)}
      {system('archive', 'Архив', counts.archive)}

      <div className={s.bottom}>
        <Button size="sm" onClick={() => setAdding(true)}>
          + Серия
        </Button>
        <Menu open={adding} onClose={() => setAdding(false)} up>
          <MenuItem
            onClick={() => {
              setAdding(false);
              onMakeSeries('tournament');
            }}
            note="По одному маппулу на раунд, карты не повторяются"
          >
            Турнирная
          </MenuItem>
          <MenuItem
            onClick={() => {
              setAdding(false);
              onMakeSeries('free');
            }}
            note="Просто ящик: архив сезона, любимые пулы"
          >
            Свободная
          </MenuItem>
        </Menu>

        <Button size="sm" onClick={onMakePool}>
          + Маппул
        </Button>
      </div>
    </aside>
  );
}
