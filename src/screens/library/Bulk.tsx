import { useState } from 'react';
import { Button, Menu, MenuItem, MenuSeparator } from '@/components';
import { MOD_TAGS, SKILLSETS, type Collection, type ModTag, type Skillset } from '@/lib/types';
import { maps } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import s from './Bulk.module.css';

interface Props {
  /** Выделенные карты. */
  ids: number[];
  collections: Collection[];
  /** Коллекция, в которой сейчас находимся, — из неё можно убрать. */
  here: Collection | null;
  onClear: () => void;
  /** Данные изменились: перечитать список и счётчики коллекций. */
  onChanged: () => Promise<void>;
  onDelete: () => Promise<void>;
}

type Open = 'collection' | 'mod' | 'skill' | null;

/** Панель массовых действий. Появляется, когда выделена хоть одна карта. */
export function Bulk({ ids, collections, here, onClear, onChanged, onDelete }: Props) {
  const [open, setOpen] = useState<Open>(null);
  const [busy, setBusy] = useState(false);

  // Умные коллекции наполняются фильтром, руками в них не положишь.
  const targets = collections.filter((c) => !c.isSmart);

  async function run(action: () => Promise<void>) {
    setOpen(null);
    setBusy(true);
    try {
      await action();
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  function toggle(which: Exclude<Open, null>) {
    setOpen(open === which ? null : which);
  }

  return (
    <div className={s.bulk}>
      <span className={s.count}>Выбрано {maps(ids.length)}</span>

      <div className={s.actions}>
        <div className={s.holder}>
          <Button size="sm" disabled={busy} onClick={() => toggle('collection')}>
            В коллекцию ▾
          </Button>
          <Menu open={open === 'collection'} onClose={() => setOpen(null)} up>
            {targets.length === 0 ? (
              <MenuItem onClick={() => setOpen(null)} disabled note="Создай её слева">
                Коллекций пока нет
              </MenuItem>
            ) : (
              targets.map((c) => (
                <MenuItem
                  key={c.id}
                  onClick={() => void run(() => ipc.addToCollection(c.id, ids))}
                >
                  {c.name}
                </MenuItem>
              ))
            )}

            {here !== null && !here.isSmart ? (
              <>
                <MenuSeparator />
                {/* Название не склоняем — в родительном падеже оно бы ломалось
                    на любом, что не «кубок». Мы и так внутри этой коллекции. */}
                <MenuItem
                  onClick={() => void run(() => ipc.removeFromCollection(here.id, ids))}
                  danger
                  note="Карты останутся в библиотеке"
                >
                  Убрать из коллекции
                </MenuItem>
              </>
            ) : null}
          </Menu>
        </div>

        <div className={s.holder}>
          <Button size="sm" disabled={busy} onClick={() => toggle('mod')}>
            Мод-тег ▾
          </Button>
          <Menu open={open === 'mod'} onClose={() => setOpen(null)} up>
            {MOD_TAGS.map((m: ModTag) => (
              <MenuItem key={m} onClick={() => void run(() => ipc.bulkAddMod(ids, m))}>
                {m}
              </MenuItem>
            ))}
          </Menu>
        </div>

        <div className={s.holder}>
          <Button size="sm" disabled={busy} onClick={() => toggle('skill')}>
            Скилсет ▾
          </Button>
          <Menu open={open === 'skill'} onClose={() => setOpen(null)} up>
            {SKILLSETS.map((k: Skillset) => (
              <MenuItem key={k} onClick={() => void run(() => ipc.bulkAddSkillset(ids, k))}>
                {k}
              </MenuItem>
            ))}
          </Menu>
        </div>

        <Button size="sm" disabled={busy} onClick={onClear}>
          Снять выделение
        </Button>

        <Button size="sm" variant="danger" disabled={busy} onClick={() => void onDelete()}>
          Удалить из библиотеки
        </Button>
      </div>
    </div>
  );
}
