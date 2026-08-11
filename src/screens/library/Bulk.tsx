import { useState } from 'react';
import { Button, Menu, MenuItem, MenuSeparator } from '@/components';
import {
  MOD_TAGS,
  SKILLSETS,
  type Beatmap,
  type Collection,
  type ModTag,
  type Skillset,
} from '@/lib/types';
import { maps } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import s from './Bulk.module.css';

interface Props {
  /** Выделенные карты. */
  ids: number[];
  /** Они же целиком — по ним видно, какие теги уже стоят. */
  selected: Beatmap[];
  collections: Collection[];
  /** Коллекция, в которой сейчас находимся, — из неё можно убрать. */
  here: Collection | null;
  onClear: () => void;
  /** Данные изменились: перечитать список и счётчики коллекций. */
  onChanged: () => Promise<void>;
  onDelete: () => Promise<void>;
}

type Open = 'collection' | 'skill' | null;

/** Панель массовых действий. Появляется, когда выделена хоть одна карта. */
export function Bulk({ ids, selected, collections, here, onClear, onChanged, onDelete }: Props) {
  const [open, setOpen] = useState<Open>(null);
  const [busy, setBusy] = useState(false);

  // Умные коллекции наполняются фильтром, руками в них не положишь.
  const targets = collections.filter((c) => !c.isSmart);

  // Сколько выделенных карт уже под этим тегом. Без этого нажатие вслепую:
  // непонятно, ставишь ты тег или он уже стоит у половины.
  const withMod = new Map<ModTag, number>(
    MOD_TAGS.map((m) => [m, selected.filter((x) => x.mods.includes(m)).length]),
  );
  const tagged = selected.filter((x) => x.mods.length > 0).length;

  async function run(action: () => Promise<void>) {
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

  /**
   * Одно нажатие ставит тег всем выделенным, а если он уже у всех — снимает.
   * Половина отмеченных — это «ещё не у всех», поэтому такое нажатие
   * дотягивает тег до остальных, а не снимает у тех, у кого он есть.
   */
  function flipMod(m: ModTag) {
    const have = withMod.get(m) ?? 0;
    void run(() =>
      have === selected.length && have > 0 ? ipc.bulkRemoveMod(ids, m) : ipc.bulkAddMod(ids, m),
    );
  }

  return (
    <div className={s.bulk}>
      <span className={s.count}>Выбрано {maps(ids.length)}</span>

      {/* Мод-теги вынесены из меню в саму панель: их ставят и снимают чаще
          всего остального, а по счётчикам сразу видно, где чего не хватает. */}
      <div className={s.mods}>
        {MOD_TAGS.map((m) => {
          const have = withMod.get(m) ?? 0;
          const all = have === selected.length && have > 0;
          const some = have > 0 && !all;

          return (
            <button
              key={m}
              className={[s.mod, all ? s.modAll : null, some ? s.modSome : null]
                .filter(Boolean)
                .join(' ')}
              type="button"
              disabled={busy}
              aria-pressed={all}
              title={
                all
                  ? `${m} стоит у всех — снять`
                  : some
                    ? `${m} стоит у ${have} из ${selected.length} — поставить остальным`
                    : `Поставить ${m} всем выделенным`
              }
              onClick={() => flipMod(m)}
            >
              {m}
              {have > 0 ? <span className={s.modCount}>{all ? '✓' : have}</span> : null}
            </button>
          );
        })}

        <button
          className={s.clearMods}
          type="button"
          disabled={busy || tagged === 0}
          title="Снять все мод-теги с выделенных карт"
          onClick={() => void run(() => ipc.bulkClearMods(ids))}
        >
          Снять все
        </button>
      </div>

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
                  onClick={() => {
                    setOpen(null);
                    void run(() => ipc.addToCollection(c.id, ids));
                  }}
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
                  onClick={() => {
                    setOpen(null);
                    void run(() => ipc.removeFromCollection(here.id, ids));
                  }}
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
          <Button size="sm" disabled={busy} onClick={() => toggle('skill')}>
            Скилсет ▾
          </Button>
          <Menu open={open === 'skill'} onClose={() => setOpen(null)} up>
            {SKILLSETS.map((k: Skillset) => (
              <MenuItem
                key={k}
                onClick={() => {
                  setOpen(null);
                  void run(() => ipc.bulkAddSkillset(ids, k));
                }}
              >
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
