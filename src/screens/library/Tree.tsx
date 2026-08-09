import { useState } from 'react';
import type { Collection } from '@/lib/types';
import { Button, Menu, MenuItem, MenuSeparator } from '@/components';
import { filterIsSet, filterSummary } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import { useApp } from '@/store/app';
import s from './Tree.module.css';

interface Props {
  activeId: number | null;
  onSelect: (id: number | null) => void;
}

/** Что именно создаём после выбора в меню. */
type Making = { kind: 'plain' | 'smart'; name: string } | null;

/**
 * Дерево коллекций. «Все карты» — всегда первый пункт и он же способ
 * выйти из любой коллекции.
 */
export function Tree({ activeId, onSelect }: Props) {
  const { collections, refreshCollections, filter, resetFilter } = useApp();
  const [adding, setAdding] = useState(false);
  const [making, setMaking] = useState<Making>(null);
  const [menu, setMenu] = useState<number | null>(null);

  const plain = collections.filter((c) => !c.isSmart);
  const smart = collections.filter((c) => c.isSmart);
  const hasFilter = filterIsSet(filter);

  function begin(kind: 'plain' | 'smart') {
    setAdding(false);
    // Умной сразу предлагаем имя из условий фильтра — его останется только принять.
    setMaking({ kind, name: kind === 'smart' ? filterSummary(filter) : '' });
  }

  async function create() {
    if (!making) return;
    const name = making.name.trim();
    const kind = making.kind;
    // Закрываемся до запроса: второй Enter или потеря фокуса не создадут дубль.
    setMaking(null);
    if (name === '') return;

    const made =
      kind === 'smart'
        ? await ipc.createSmartCollection(name, null, { ...filter, collectionId: null })
        : await ipc.createCollection(name, null);

    await refreshCollections();
    onSelect(made.id);
    // Условия уехали внутрь коллекции — оставлять их ещё и в чипах значит
    // показывать фильтр, который уже никуда не применяется.
    if (kind === 'smart') resetFilter();
  }

  async function remove(id: number) {
    setMenu(null);
    await ipc.deleteCollection(id);
    if (activeId === id) onSelect(null);
    await refreshCollections();
  }

  async function rename(c: Collection) {
    setMenu(null);
    const next = window.prompt('Новое название', c.name);
    if (next === null || next.trim() === '') return;
    await ipc.renameCollection(c.id, next.trim());
    await refreshCollections();
  }

  async function duplicate(c: Collection) {
    setMenu(null);
    const made = await ipc.duplicateCollection(c.id);
    await refreshCollections();
    onSelect(made.id);
  }

  const row = (c: Collection) => (
    <div key={c.id} className={s.rowWrap}>
      <button
        className={[s.row, activeId === c.id ? s.on : null].filter(Boolean).join(' ')}
        onClick={() => onSelect(c.id)}
        type="button"
        {...(c.isSmart && c.filter !== null ? { title: filterSummary(c.filter) } : {})}
      >
        <span className={s.dot} style={{ background: c.color ?? '#4A5164' }} aria-hidden />
        <span className={s.name}>{c.name}</span>
        {c.isSmart ? null : <span className={s.count}>{c.count}</span>}
      </button>

      <button
        className={s.more}
        onClick={() => setMenu(menu === c.id ? null : c.id)}
        type="button"
        aria-label="Действия"
      >
        ⋯
      </button>

      <Menu open={menu === c.id} onClose={() => setMenu(null)} align="right">
        <MenuItem onClick={() => void rename(c)}>Переименовать</MenuItem>
        <MenuItem onClick={() => void duplicate(c)}>Дублировать</MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => void remove(c.id)} danger>
          Удалить
        </MenuItem>
      </Menu>
    </div>
  );

  return (
    <aside className={s.tree}>
      <button
        className={[s.row, s.all, activeId === null ? s.on : null].filter(Boolean).join(' ')}
        onClick={() => onSelect(null)}
        type="button"
      >
        <span className={s.name}>Все карты</span>
      </button>

      {plain.length > 0 ? (
        <>
          <div className={s.head}>Коллекции</div>
          {plain.map(row)}
        </>
      ) : null}

      {smart.length > 0 ? (
        <>
          <div className={s.head}>Умные коллекции</div>
          {smart.map(row)}
        </>
      ) : null}

      <div className={s.bottom}>
        {making ? (
          <input
            className={s.input}
            value={making.name}
            autoFocus
            placeholder={making.kind === 'smart' ? 'Название умной' : 'Название'}
            onChange={(e) => setMaking({ ...making, name: e.target.value })}
            onBlur={() => void create()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setMaking(null);
              }
            }}
          />
        ) : (
          <>
            <Button size="sm" onClick={() => setAdding(true)}>
              + Коллекция
            </Button>
            <Menu open={adding} onClose={() => setAdding(false)} up>
              <MenuItem onClick={() => begin('plain')} note="Складываешь карты руками">
                Обычная
              </MenuItem>
              <MenuItem
                onClick={() => begin('smart')}
                disabled={!hasFilter}
                note={hasFilter ? filterSummary(filter) : 'Сначала задай фильтр'}
              >
                Умная из текущего фильтра
              </MenuItem>
            </Menu>
          </>
        )}
      </div>
    </aside>
  );
}
