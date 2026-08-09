import { useState } from 'react';
import type { Collection } from '@/lib/types';
import { Button } from '@/components';
import * as ipc from '@/lib/ipc';
import { useApp } from '@/store/app';
import s from './Tree.module.css';

interface Props {
  activeId: number | null;
  onSelect: (id: number | null) => void;
}

/**
 * Дерево коллекций. «Все карты» — всегда первый пункт и он же способ
 * выйти из любой коллекции.
 */
export function Tree({ activeId, onSelect }: Props) {
  const { collections, refreshCollections } = useApp();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [menu, setMenu] = useState<number | null>(null);

  const plain = collections.filter((c) => !c.isSmart);
  const smart = collections.filter((c) => c.isSmart);

  async function create() {
    const trimmed = name.trim();
    if (trimmed === '') {
      setCreating(false);
      return;
    }
    const made = await ipc.createCollection(trimmed, null);
    setName('');
    setCreating(false);
    await refreshCollections();
    onSelect(made.id);
  }

  async function remove(id: number) {
    await ipc.deleteCollection(id);
    setMenu(null);
    if (activeId === id) onSelect(null);
    await refreshCollections();
  }

  async function rename(c: Collection) {
    const next = window.prompt('Новое название', c.name);
    setMenu(null);
    if (next === null || next.trim() === '') return;
    await ipc.renameCollection(c.id, next.trim());
    await refreshCollections();
  }

  const row = (c: Collection) => (
    <div key={c.id} className={s.rowWrap}>
      <button
        className={[s.row, activeId === c.id ? s.on : null].filter(Boolean).join(' ')}
        onClick={() => onSelect(c.id)}
        type="button"
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

      {menu === c.id ? (
        <div className={s.menu}>
          <button onClick={() => void rename(c)} type="button">
            Переименовать
          </button>
          <button onClick={() => void remove(c.id)} type="button" className={s.danger}>
            Удалить
          </button>
        </div>
      ) : null}
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
        {creating ? (
          <input
            className={s.input}
            value={name}
            autoFocus
            placeholder="Название"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void create()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
              if (e.key === 'Escape') {
                setName('');
                setCreating(false);
              }
            }}
          />
        ) : (
          <Button size="sm" onClick={() => setCreating(true)}>
            + Коллекция
          </Button>
        )}
      </div>
    </aside>
  );
}
