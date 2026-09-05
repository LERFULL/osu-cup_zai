import { useMemo, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import type { Collection, Folder, Place } from '@/lib/types';
import { Button, Menu, MenuItem, MenuSeparator } from '@/components';
import { filterIsSet, filterSummary, maps } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import { useApp } from '@/store/app';
import s from './Explorer.module.css';

interface Props {
  /** Активное место списка — подсвечивается среди плиток. */
  place: Place;
  /** Папка, которую сейчас смотрим. null — верхний уровень. */
  folder: number | null;
  /** Открыть место со списком карт. */
  onOpenPlace: (place: Place) => void;
  /** Зайти в папку (или выйти к корню). */
  onBrowse: (folder: number | null) => void;
}

/** Что тащим мышью: папку или коллекцию. */
type Drag =
  | { kind: 'folder'; id: number }
  | { kind: 'collection'; id: number }
  | null;

/** Куда положили: ключ папки-цели или `root`. */
type Drop = { folder: number | null } | null;

/**
 * Проводник библиотеки — как в Windows: плитки папок и коллекций, вложенность
 * без ограничений, хлебные крошки и перетаскивание. Слева списка больше нет:
 * навигация живёт в главной области.
 */
export function Explorer({ place, folder, onOpenPlace, onBrowse }: Props) {
  const { collections, folders, untagged, filter, resetFilter, refreshCollections } = useApp();
  const [making, setMaking] = useState<{ kind: 'folder' | 'plain' | 'smart'; name: string } | null>(
    null,
  );
  const [menu, setMenu] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [drop, setDrop] = useState<Drop>(null);

  const hasFilter = filterIsSet(filter);
  const atRoot = folder === null;

  /** Путь от корня до текущей папки — для хлебных крошек. */
  const crumbs = useMemo(() => {
    const path: Folder[] = [];
    let cur = folder;
    while (cur !== null) {
      const f = folders.find((x) => x.id === cur);
      if (f === undefined) break;
      path.unshift(f);
      cur = f.parentId;
    }
    return path;
  }, [folders, folder]);

  const subFolders = folders.filter((f) => (f.parentId ?? null) === folder);
  const here = collections.filter((c) => (c.folderId ?? null) === folder);
  const nothingInside = subFolders.length === 0 && here.length === 0;

  async function create() {
    if (!making) return;
    const name = making.name.trim();
    const kind = making.kind;
    setMaking(null);
    if (name === '') return;

    if (kind === 'folder') {
      await ipc.createFolder(name, folder);
    } else if (kind === 'plain') {
      const made = await ipc.createCollection(name, null);
      if (folder !== null) await ipc.moveCollection(made.id, folder, 1);
    } else {
      const made = await ipc.createSmartCollection(name, null, {
        ...filter,
        collectionId: null,
      });
      if (folder !== null) await ipc.moveCollection(made.id, folder, 1);
      resetFilter();
    }
    await refreshCollections();
  }

  async function removeCollection(id: number) {
    setMenu(null);
    if (!window.confirm('Удалить коллекцию? Сами карты останутся в библиотеке.')) return;
    await ipc.deleteCollection(id);
    await refreshCollections();
  }

  async function removeFolder(id: number) {
    setMenu(null);
    if (
      !window.confirm(
        'Удалить папку? Содержимое не пропадёт — папки и коллекции из неё поднимутся на уровень выше.',
      )
    )
      return;
    await ipc.deleteFolder(id);
    // Удалили ту папку, в которой стоим, — выходим наверх.
    if (crumbs.some((f) => f.id === id)) onBrowse(crumbs[crumbs.length - 2]?.id ?? null);
    await refreshCollections();
  }

  async function rename(item: Collection | Folder) {
    setMenu(null);
    const next = window.prompt('Новое название', item.name);
    if (next === null || next.trim() === '') return;
    if ('isSmart' in item) await ipc.renameCollection(item.id, next.trim());
    else await ipc.renameFolder(item.id, next.trim());
    await refreshCollections();
  }

  async function duplicate(c: Collection) {
    setMenu(null);
    await ipc.duplicateCollection(c.id);
    await refreshCollections();
  }

  // ───────────────────────────────────────────────── перетаскивание

  const dragData = (e: ReactDragEvent, item: Exclude<Drag, null>) => {
    e.stopPropagation();
    setDrag(item);
    e.dataTransfer.setData('text/plain', JSON.stringify(item));
    e.dataTransfer.effectAllowed = 'move';
  };

  /** Бросок на папку-цель (null — текущая папка/корень). Бэкенд сам
   *  отвергнет папку внутрь себя — останется показать ошибку. */
  async function settle(target: number | null) {
    setDrop(null);
    const item = drag;
    setDrag(null);
    if (item === null) return;

    try {
      if (item.kind === 'folder') {
        await ipc.moveFolder(item.id, target, 1);
        await refreshCollections();
        return;
      }
      await ipc.moveCollection(item.id, target, 1);
      await refreshCollections();
    } catch (e) {
      window.alert(String(e).replace(/^Error:\s*/, ''));
    }
  }

  const dropProps = (target: number | null) => ({
    onDragOver: (e: ReactDragEvent) => {
      if (drag === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDrop({ folder: target });
    },
    onDragLeave: () => setDrop((cur) => (cur !== null && cur.folder === target ? null : cur)),
    onDrop: (e: ReactDragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      void settle(target);
    },
  });

  // ───────────────────────────────────────────────────── плитки

  const systemTile = (p: Place, name: string, note: string, badge?: string, gold?: boolean) => (
    <button
      className={[s.tile, s.system, samePlace(place, p) ? s.on : null].filter(Boolean).join(' ')}
      onClick={() => onOpenPlace(p)}
      type="button"
    >
      <span className={[s.glyph, gold === true ? s.gold : null].filter(Boolean).join(' ')} aria-hidden>
        ♫
      </span>
      <span className={s.tileName}>{name}</span>
      <span className={s.tileNote}>{note}</span>
      {badge !== undefined ? (
        <span className={[s.tileCount, gold === true ? s.waiting : null].filter(Boolean).join(' ')}>
          {badge}
        </span>
      ) : null}
    </button>
  );

  const folderTile = (f: Folder) => {
    const inside =
      folders.filter((x) => x.parentId === f.id).length +
      collections.filter((c) => c.folderId === f.id).length;
    const dropping = drop !== null && drop.folder === f.id;
    return (
      <div
        key={`f${f.id}`}
        className={[s.tile, dropping ? s.over : null].filter(Boolean).join(' ')}
        draggable
        onDragStart={(e) => dragData(e, { kind: 'folder', id: f.id })}
        onDragEnd={() => {
          setDrag(null);
          setDrop(null);
        }}
        {...dropProps(f.id)}
      >
        <button className={s.tileMain} onClick={() => onBrowse(f.id)} type="button">
          <span className={[s.glyph, s.folderGlyph].join(' ')} aria-hidden>
            ▤
          </span>
          <span className={s.tileName}>{f.name}</span>
          <span className={s.tileNote}>{inside > 0 ? `${inside} внутри` : 'пусто'}</span>
        </button>
        <button
          className={s.more}
          onClick={() => setMenu(menu === `f${f.id}` ? null : `f${f.id}`)}
          type="button"
          aria-label="Действия с папкой"
        >
          ⋯
        </button>
        <Menu open={menu === `f${f.id}`} onClose={() => setMenu(null)} align="right">
          <MenuItem onClick={() => void rename(f)}>Переименовать</MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => void removeFolder(f.id)} danger>
            Удалить
          </MenuItem>
        </Menu>
      </div>
    );
  };

  const collectionTile = (c: Collection) => (
    <div
      key={`c${c.id}`}
      className={[s.tile, s.collection].join(' ')}
      draggable
      onDragStart={(e) => dragData(e, { kind: 'collection', id: c.id })}
      onDragEnd={() => {
        setDrag(null);
        setDrop(null);
      }}
    >
      <button
        className={s.tileMain}
        onClick={() => onOpenPlace({ kind: 'collection', id: c.id })}
        type="button"
        {...(c.isSmart && c.filter !== null ? { title: filterSummary(c.filter) } : {})}
      >
        <span className={s.dot} style={{ background: c.color ?? '#4A5164' }} aria-hidden />
        <span className={s.tileName}>
          {c.name}
          {c.isSmart ? <span className={s.smart}>умная</span> : null}
        </span>
        <span className={s.tileNote}>{c.count > 0 ? maps(c.count) : 'пусто'}</span>
      </button>
      <button
        className={s.more}
        onClick={() => setMenu(menu === `c${c.id}` ? null : `c${c.id}`)}
        type="button"
        aria-label="Действия с коллекцией"
      >
        ⋯
      </button>
      <Menu open={menu === `c${c.id}`} onClose={() => setMenu(null)} align="right">
        <MenuItem onClick={() => void rename(c)}>Переименовать</MenuItem>
        <MenuItem onClick={() => void duplicate(c)}>Дублировать</MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => void removeCollection(c.id)} danger>
          Удалить
        </MenuItem>
      </Menu>
    </div>
  );

  return (
    <div className={s.wrap}>
      <div className={s.top}>
        <nav className={s.crumbs} aria-label="Путь по библиотеке">
          <button
            className={[s.crumb, atRoot ? s.crumbOn : null].filter(Boolean).join(' ')}
            onClick={() => onBrowse(null)}
            type="button"
          >
            Библиотека
          </button>
          {crumbs.map((f, i) => (
            <span key={f.id} className={s.crumbRow}>
              <span className={s.sep} aria-hidden>
                ›
              </span>
              <button
                className={[s.crumb, i === crumbs.length - 1 ? s.crumbOn : null]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => onBrowse(f.id)}
                type="button"
              >
                {f.name}
              </button>
            </span>
          ))}
        </nav>

        <div className={s.actions}>
          {making ? (
            <input
              className={s.input}
              value={making.name}
              autoFocus
              placeholder={
                making.kind === 'folder'
                  ? 'Название папки'
                  : making.kind === 'smart'
                    ? 'Название умной'
                    : 'Название коллекции'
              }
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
              <Button size="sm" onClick={() => setMaking({ kind: 'folder', name: '' })}>
                + Папка
              </Button>
              <Button size="sm" onClick={() => setMaking({ kind: 'plain', name: '' })}>
                + Коллекция
              </Button>
              <Button
                size="sm"
                disabled={!hasFilter}
                title={hasFilter ? filterSummary(filter) : 'Сначала задай фильтр в списке'}
                onClick={() => setMaking({ kind: 'smart', name: filterSummary(filter) })}
              >
                Умная из фильтра
              </Button>
            </>
          )}
        </div>
      </div>

      <div className={s.grid} {...dropProps(null)}>
        {atRoot ? (
          <>
            {systemTile({ kind: 'all' }, 'Все карты', 'вся библиотека целиком')}
            {systemTile(
              { kind: 'untagged' },
              'Без мод-тегов',
              'ждут разметки под генерацию',
              String(untagged),
              untagged > 0,
            )}
          </>
        ) : null}

        {subFolders.map(folderTile)}
        {here.map(collectionTile)}

        {nothingInside ? (
          <div className={s.empty}>
            {atRoot
              ? 'Создай первую коллекцию — сложи в неё карты по турнирам, пачкам или настроению.'
              : 'В этой папке пока пусто: перетащи сюда коллекцию или создай новую.'}
          </div>
        ) : null}
      </div>

      {drag !== null ? (
        <div className={s.hint}>
          {drag.kind === 'folder' ? 'Папка' : 'Коллекция'} тащится — брось на папку или крошку пути
        </div>
      ) : null}
    </div>
  );
}

function samePlace(a: Place, b: Place): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'collection' && b.kind === 'collection') return a.id === b.id;
  return true;
}
