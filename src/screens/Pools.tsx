import { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Menu, MenuItem, MenuSeparator } from '@/components';
import type { GenNote, Pool, PoolTemplate, Series } from '@/lib/types';
import { poolShape, slots as slotsWord, templateShape, templateSize } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import { TemplateEditor } from './pools/TemplateEditor';
import { PoolEditor } from './pools/PoolEditor';
import { SeriesView } from './pools/SeriesView';
import { Tree, type Place } from './pools/Tree';
import s from './Pools.module.css';

/** Что открыто поверх списка. */
type Open = { kind: 'template'; id: number } | { kind: 'pool'; id: number } | null;

const COLORS = ['#FF6FB1', '#5BC8F5', '#7ED957', '#FFD03B', '#C77DFF', '#FF6B6B'];

export default function Pools() {
  const [place, setPlace] = useState<Place>({ kind: 'all' });
  const [pools, setPools] = useState<Pool[]>([]);
  const [series, setSeries] = useState<Series[]>([]);
  const [templates, setTemplates] = useState<PoolTemplate[]>([]);
  const [open, setOpen] = useState<Open>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<GenNote[]>([]);

  const reload = useCallback(async () => {
    try {
      const [p, t, se] = await Promise.all([
        ipc.listPools(),
        ipc.listTemplates(),
        ipc.listSeries(),
      ]);
      setPools(p);
      setTemplates(t);
      setSeries(se);
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

  async function guard(work: () => Promise<void>) {
    try {
      await work();
      setError(null);
    } catch (e) {
      setError(String(e));
    }
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
    const into = place.kind === 'series' ? place.id : null;
    const made = await ipc.createPool(name.trim(), into);
    await reload();
    setOpen({ kind: 'pool', id: made.id });
  }

  async function makeSeries(kind: 'tournament' | 'free') {
    const name = window.prompt('Название серии', kind === 'tournament' ? 'Осень 2026' : 'Ящик');
    if (name === null || name.trim() === '') return;
    const made = await ipc.createSeries(name.trim(), kind);
    await reload();
    setPlace({ kind: 'series', id: made.id });
  }

  async function roll(t: PoolTemplate) {
    setMenu(null);
    const name = window.prompt('Название маппула', t.name);
    if (name === null || name.trim() === '') return;
    await guard(async () => {
      const into = place.kind === 'series' ? place.id : null;
      const report = await ipc.generatePool(t.id, name.trim(), into);
      setNotes(report.notes);
      setOpen({ kind: 'pool', id: report.pool.id });
    });
  }

  /** Серия под турнир: создаётся сама серия и N пулов по одному на раунд. */
  async function rollSeries(t: PoolTemplate) {
    setMenu(null);
    const name = window.prompt('Название серии', t.name);
    if (name === null || name.trim() === '') return;

    const raw = window.prompt(
      'Сколько маппулов накатить под турнир?\nПо одному на раунд — карты между ними не повторятся.',
      '4',
    );
    if (raw === null) return;
    const count = Number(raw.trim());
    if (!Number.isFinite(count) || count < 1) return;

    await guard(async () => {
      const reports = await ipc.generateSeries(t.id, name.trim(), count);
      await reload();
      const first = reports[0];
      if (first?.pool.seriesId != null) setPlace({ kind: 'series', id: first.pool.seriesId });
    });
  }

  async function renameTemplate(t: PoolTemplate) {
    setMenu(null);
    const name = window.prompt('Новое название', t.name);
    if (name === null || name.trim() === '') return;
    await ipc.saveTemplate(t.id, name.trim(), t.rules, t.sources, t.slots);
    await reload();
  }

  async function renamePool(p: Pool) {
    setMenu(null);
    const name = window.prompt('Новое название', p.name);
    if (name === null || name.trim() === '') return;
    await ipc.renamePool(p.id, name.trim());
    await reload();
  }

  /** Перенос пула в серию. Повторы не переносим молча — показываем список. */
  async function intoSeries(seriesId: number, poolId: number) {
    await guard(async () => {
      const clashes = await ipc.addPoolToSeries(seriesId, poolId);
      if (clashes.length > 0) {
        setError(
          `Маппул не перенесён: карты повторяются — ${clashes
            .map((c) => `${c.name} (${c.pools.join(', ')})`)
            .join('; ')}. Перекатай их или переключи серию в свободную.`,
        );
        return;
      }
      await reload();
    });
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
          <MenuItem
            onClick={() => void rollSeries(t)}
            note="Новая серия, карты между маппулами не повторятся"
          >
            Накатать серию под турнир
          </MenuItem>
          <MenuSeparator />
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
    <div
      key={p.id}
      className={s.card}
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/plain', `pool:${p.id}`)}
      title="Можно перетащить в серию"
    >
      <div className={s.text}>
        <div className={s.name}>
          {p.name}
          {p.version > 1 ? <span className={s.version}>v{p.version}</span> : null}
          {p.isLocked ? <span className={s.locked}>сыгран</span> : null}
          {p.seriesName !== null ? (
            <button
              className={s.tag}
              onClick={() => p.seriesId !== null && setPlace({ kind: 'series', id: p.seriesId })}
              type="button"
            >
              {p.seriesName}
              {p.seriesLabel !== null ? ` · ${p.seriesLabel}` : ''}
            </button>
          ) : null}
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

          {series.length > 0 ? (
            <MenuItem
              onClick={() => setMenu(`into${p.id}`)}
              note={p.seriesName !== null ? `Сейчас в «${p.seriesName}»` : 'Сейчас без серии'}
            >
              В серию…
            </MenuItem>
          ) : null}

          {p.seriesId !== null ? (
            <MenuItem
              onClick={() => {
                setMenu(null);
                void ipc.removePoolFromSeries(p.id).then(reload);
              }}
            >
              Вынести из серии
            </MenuItem>
          ) : null}

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

        <Menu open={menu === `into${p.id}`} onClose={() => setMenu(null)} align="right">
          {series.map((x) => (
            <MenuItem
              key={x.id}
              onClick={() => {
                setMenu(null);
                void intoSeries(x.id, p.id);
              }}
              disabled={x.id === p.seriesId}
              note={x.kind === 'tournament' ? 'турнирная' : 'свободная'}
            >
              {x.name}
            </MenuItem>
          ))}
        </Menu>
      </div>
    </div>
  );

  const live = pools.filter((p) => p.status !== 'archived');
  const counts = {
    all: live.length,
    loose: live.filter((p) => p.seriesId === null).length,
    templates: templates.length,
    archive: pools.filter((p) => p.status === 'archived').length,
  };

  /** Что показывать справа для выбранного узла дерева. */
  function content() {
    if (place.kind === 'series') {
      return (
        <SeriesView
          id={place.id}
          onOpenPool={(poolId, next) => {
            setNotes(next);
            setOpen({ kind: 'pool', id: poolId });
          }}
          onChanged={reload}
        />
      );
    }

    const title =
      place.kind === 'templates'
        ? 'Шаблоны'
        : place.kind === 'archive'
          ? 'Архив'
          : place.kind === 'loose'
            ? 'Без серии'
            : 'Все маппулы';

    const list =
      place.kind === 'templates'
        ? templates
        : place.kind === 'archive'
          ? pools.filter((p) => p.status === 'archived')
          : place.kind === 'loose'
            ? live.filter((p) => p.seriesId === null)
            : live;

    return (
      <div className={s.pane}>
        <header className={s.bar}>
          <h1 className={s.h1}>{title}</h1>
          <span className={s.count}>{list.length}</span>
          <div className={s.right}>
            {place.kind === 'templates' ? (
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

        <div className={s.body}>
          <div className={s.col}>
            {error !== null ? <div className={s.error}>{error}</div> : null}

            {list.length === 0 ? (
              place.kind === 'templates' ? (
                <Empty
                  title="Шаблонов пока нет"
                  note="Шаблон — это структура пула: сколько карт под каждый мод и откуда их брать."
                  actions={
                    <Button variant="primary" onClick={() => void makeTemplate()}>
                      Создать шаблон
                    </Button>
                  }
                />
              ) : place.kind === 'archive' ? (
                <Empty title="Архив пуст" note="Сюда попадают маппулы, убранные из работы." />
              ) : (
                <Empty
                  title="Маппулов пока нет"
                  note="Скатай пул по шаблону или собери руками."
                  actions={
                    <>
                      <Button
                        variant="primary"
                        onClick={() => setPlace({ kind: 'templates' })}
                      >
                        К шаблонам
                      </Button>
                      <Button onClick={() => void makePool()}>Пустой маппул</Button>
                    </>
                  }
                />
              )
            ) : place.kind === 'templates' ? (
              (list as PoolTemplate[]).map(templateCard)
            ) : (
              (list as Pool[]).map(poolCard)
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={s.screen}>
      <Tree
        place={place}
        series={series}
        counts={counts}
        onSelect={setPlace}
        onMakeSeries={(kind) => void makeSeries(kind)}
        onMakePool={() => void makePool()}
        onDropPool={(seriesId, poolId) => void intoSeries(seriesId, poolId)}
        onRename={(x) =>
          void guard(async () => {
            const name = window.prompt('Название серии', x.name);
            if (name === null || name.trim() === '') return;
            await ipc.renameSeries(x.id, name.trim());
            await reload();
          })
        }
        onColor={(x) =>
          void guard(async () => {
            // Цвет из палитры по кругу: диалог выбора ради шести оттенков лишний.
            const at = COLORS.indexOf(x.color ?? '');
            const next = COLORS[(at + 1) % COLORS.length] ?? COLORS[0] ?? null;
            await ipc.setSeriesColor(x.id, next);
            await reload();
          })
        }
        onKind={(x) =>
          void guard(async () => {
            const next = x.kind === 'tournament' ? 'free' : 'tournament';
            const clashes = await ipc.setSeriesKind(x.id, next);
            if (clashes.length > 0) {
              setError(
                `Тип не сменился: карты повторяются — ${clashes
                  .map((c) => `${c.name} (${c.pools.join(', ')})`)
                  .join('; ')}.`,
              );
              return;
            }
            await reload();
          })
        }
        onDuplicate={(x) =>
          void guard(async () => {
            const made = await ipc.duplicateSeries(x.id);
            await reload();
            setPlace({ kind: 'series', id: made.id });
          })
        }
        onDelete={(x) =>
          void guard(async () => {
            if (!window.confirm(`Удалить серию «${x.name}»? Маппулы останутся.`)) return;
            await ipc.deleteSeries(x.id);
            if (place.kind === 'series' && place.id === x.id) setPlace({ kind: 'all' });
            await reload();
          })
        }
        onReorder={(ids) =>
          void guard(async () => {
            await ipc.reorderSeries(ids);
            await reload();
          })
        }
      />

      {content()}
    </div>
  );
}
