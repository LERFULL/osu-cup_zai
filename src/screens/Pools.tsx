import { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Menu, MenuItem, MenuSeparator, Tabs } from '@/components';
import type { Pool, PoolTemplate } from '@/lib/types';
import { poolShape, slots as slotsWord, templateShape, templateSize } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import { TemplateEditor } from './pools/TemplateEditor';
import { PoolEditor } from './pools/PoolEditor';
import s from './Pools.module.css';

type Tab = 'pools' | 'templates';

/** Что открыто поверх списка. */
type Open = { kind: 'template'; id: number } | { kind: 'pool'; id: number } | null;

export default function Pools() {
  const [tab, setTab] = useState<Tab>('pools');
  const [pools, setPools] = useState<Pool[]>([]);
  const [templates, setTemplates] = useState<PoolTemplate[]>([]);
  const [open, setOpen] = useState<Open>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  const reload = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([ipc.listPools(), ipc.listTemplates()]);
      setPools(p);
      setTemplates(t);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Редакторы занимают экран целиком: в них правится один объект,
  // и список за спиной только отвлекал бы.
  if (open?.kind === 'template') {
    return (
      <TemplateEditor
        id={open.id}
        onClose={() => {
          setOpen(null);
          void reload();
        }}
        onGenerated={(report) => {
          setNotes(report.notes);
          setOpen({ kind: 'pool', id: report.pool.id });
        }}
      />
    );
  }

  if (open?.kind === 'pool') {
    return (
      <PoolEditor
        id={open.id}
        notes={notes}
        onClose={() => {
          setOpen(null);
          setNotes([]);
          void reload();
        }}
      />
    );
  }

  async function makeTemplate() {
    const name = window.prompt('Название шаблона', 'Новый шаблон');
    if (name === null || name.trim() === '') return;
    const made = await ipc.createTemplate(name.trim());
    await reload();
    setOpen({ kind: 'template', id: made.id });
  }

  async function makePool() {
    const name = window.prompt('Название маппула', 'Новый маппул');
    if (name === null || name.trim() === '') return;
    const made = await ipc.createPool(name.trim());
    await reload();
    setOpen({ kind: 'pool', id: made.id });
  }

  async function roll(t: PoolTemplate) {
    setMenu(null);
    const name = window.prompt('Название маппула', t.name);
    if (name === null || name.trim() === '') return;
    try {
      const report = await ipc.generatePool(t.id, name.trim());
      setNotes(report.notes);
      setOpen({ kind: 'pool', id: report.pool.id });
    } catch (e) {
      setError(String(e));
    }
  }

  async function renameTemplate(t: PoolTemplate) {
    setMenu(null);
    const name = window.prompt('Новое название', t.name);
    if (name === null || name.trim() === '') return;
    await ipc.saveTemplate(t.id, name.trim(), t.rules, t.slots);
    await reload();
  }

  async function renamePool(p: Pool) {
    setMenu(null);
    const name = window.prompt('Новое название', p.name);
    if (name === null || name.trim() === '') return;
    await ipc.renamePool(p.id, name.trim());
    await reload();
  }

  const templateCard = (t: PoolTemplate) => (
    <div key={t.id} className={s.card}>
      <div className={s.text}>
        <div className={s.name}>{t.name}</div>
        <div className={s.shape}>
          {templateShape(t)} — {slotsWord(templateSize(t))}
        </div>
      </div>

      <div className={s.actions}>
        <Button size="sm" onClick={() => setOpen({ kind: 'template', id: t.id })}>
          Изменить
        </Button>
        <Button size="sm" variant="primary" onClick={() => void roll(t)}>
          ↻ Скатать маппул
        </Button>
        <button
          className={s.more}
          onClick={() => setMenu(menu === `t${t.id}` ? null : `t${t.id}`)}
          type="button"
          aria-label="Действия"
        >
          ⋯
        </button>
        <Menu open={menu === `t${t.id}`} onClose={() => setMenu(null)} align="right">
          <MenuItem onClick={() => void renameTemplate(t)}>Переименовать</MenuItem>
          <MenuItem
            onClick={() => {
              setMenu(null);
              void ipc.duplicateTemplate(t.id).then(reload);
            }}
          >
            Дублировать
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            danger
            note="Маппулы, скатанные по нему, останутся"
            onClick={() => {
              setMenu(null);
              void ipc.deleteTemplate(t.id).then(reload);
            }}
          >
            Удалить
          </MenuItem>
        </Menu>
      </div>
    </div>
  );

  const poolCard = (p: Pool) => (
    <div key={p.id} className={s.card}>
      <div className={s.text}>
        <div className={s.name}>
          {p.name}
          {p.version > 1 ? <span className={s.version}>v{p.version}</span> : null}
          {p.isLocked ? <span className={s.locked}>сыгран</span> : null}
        </div>
        <div className={s.shape}>{poolShape(p)}</div>
      </div>

      <div className={s.actions}>
        <Button size="sm" onClick={() => setOpen({ kind: 'pool', id: p.id })}>
          Открыть
        </Button>
        <button
          className={s.more}
          onClick={() => setMenu(menu === `p${p.id}` ? null : `p${p.id}`)}
          type="button"
          aria-label="Действия"
        >
          ⋯
        </button>
        <Menu open={menu === `p${p.id}`} onClose={() => setMenu(null)} align="right">
          <MenuItem onClick={() => void renamePool(p)}>Переименовать</MenuItem>
          <MenuItem
            onClick={() => {
              setMenu(null);
              void ipc.duplicatePool(p.id).then(reload);
            }}
          >
            Дублировать
          </MenuItem>
          <MenuItem
            onClick={() => {
              setMenu(null);
              void ipc
                .setPoolStatus(p.id, p.status === 'archived' ? 'draft' : 'archived')
                .then(reload);
            }}
          >
            {p.status === 'archived' ? 'Вернуть из архива' : 'В архив'}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            danger
            note="Карты останутся в библиотеке"
            onClick={() => {
              setMenu(null);
              void ipc.deletePool(p.id).then(reload);
            }}
          >
            Удалить
          </MenuItem>
        </Menu>
      </div>
    </div>
  );

  const live = pools.filter((p) => p.status !== 'archived');
  const archived = pools.filter((p) => p.status === 'archived');

  return (
    <div className={s.screen}>
      <header className={s.bar}>
        <h1 className={s.h1}>Маппулы</h1>
        <div className={s.right}>
          {tab === 'templates' ? (
            <Button variant="primary" onClick={() => void makeTemplate()}>
              + Создать шаблон
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void makePool()}>
              + Пустой маппул
            </Button>
          )}
        </div>
      </header>

      <div className={s.tabs}>
        <Tabs
          items={[
            { id: 'pools' as const, label: 'Маппулы', count: pools.length },
            { id: 'templates' as const, label: 'Шаблоны', count: templates.length },
          ]}
          active={tab}
          onSelect={setTab}
        />
      </div>

      <div className={s.body}>
        <div className={s.col}>
          {error !== null ? <Empty title="Не получилось прочитать маппулы" note={error} /> : null}

          {tab === 'templates' ? (
            templates.length === 0 ? (
              <Empty
                title="Шаблонов пока нет"
                note="Шаблон — это структура пула: сколько карт под каждый мод и откуда их брать."
                actions={
                  <Button variant="primary" onClick={() => void makeTemplate()}>
                    Создать шаблон
                  </Button>
                }
              />
            ) : (
              templates.map(templateCard)
            )
          ) : pools.length === 0 ? (
            <Empty
              title="Маппулов пока нет"
              note="Скатай пул по шаблону или собери руками."
              actions={
                <>
                  <Button variant="primary" onClick={() => setTab('templates')}>
                    К шаблонам
                  </Button>
                  <Button onClick={() => void makePool()}>Пустой маппул</Button>
                </>
              }
            />
          ) : (
            <>
              {live.map(poolCard)}
              {archived.length > 0 ? (
                <>
                  <div className={s.head}>Архив</div>
                  {archived.map(poolCard)}
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
