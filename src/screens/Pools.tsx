import { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Menu, MenuItem, MenuSeparator } from '@/components';
import type { GenNote, Pool, PoolTemplate, Series } from '@/lib/types';
import { templateShape, templateSize } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import { TemplateEditor } from './pools/TemplateEditor';
import { PoolEditor } from './pools/PoolEditor';
import { ImportJson } from './pools/ImportJson';
import { SeriesView } from './pools/SeriesView';
import { SeriesWizard } from './pools/SeriesWizard';
import { PoolComposition } from './pools/PoolComposition';
import s from './Pools.module.css';

/** Категории раздела. Три сущности — три вкладки, вперемешку их больше нет. */
type Tab = 'pools' | 'series' | 'templates';

/** Фильтр списка маппулов внутри вкладки. */
type PoolFilter = 'all' | 'loose' | 'archive';

/** Что открыто поверх списка. */
type Open = { kind: 'template'; id: number } | { kind: 'pool'; id: number } | null;

export default function Pools() {
  const [tab, setTab] = useState<Tab>('pools');
  const [poolFilter, setPoolFilter] = useState<PoolFilter>('all');
  const [pools, setPools] = useState<Pool[]>([]);
  const [series, setSeries] = useState<Series[]>([]);
  const [templates, setTemplates] = useState<PoolTemplate[]>([]);
  const [open, setOpen] = useState<Open>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<GenNote[]>([]);
  const [wizard, setWizard] = useState(false);
  const [showSeries, setShowSeries] = useState<number | null>(null);

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
    const made = await ipc.createPool(name.trim(), null);
    await reload();
    setOpen({ kind: 'pool', id: made.id });
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

  /** Шаблон используется только отсюда — это разовое действие, а не режим. */
  async function roll(t: PoolTemplate) {
    setMenu(null);
    const name = window.prompt('Название маппула', t.name);
    if (name === null || name.trim() === '') return;
    await guard(async () => {
      const report = await ipc.generatePool(t.id, name.trim(), null);
      setNotes(report.notes);
      setOpen({ kind: 'pool', id: report.pool.id });
    });
  }

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
      if (first?.pool.seriesId != null) {
        setTab('series');
        setShowSeries(first.pool.seriesId);
      }
    });
  }

  const templateCard = (t: PoolTemplate) => (
    <div key={t.id} className={s.card}>
      <div className={s.text}>
        <div className={s.name}>{t.name}</div>
        <div className={s.shape}>
          {templateShape(t)} — {templateSize(t)} слотов
        </div>
      </div>

      <div className={s.actions}>
        <Button size="sm" onClick={() => setOpen({ kind: 'template', id: t.id })}>
          Изменить
        </Button>
        <Button size="sm" variant="primary" onClick={() => void roll(t)} title="Разовый маппул по этой структуре">
          ↻ Создать маппул
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
            Создать серию из шаблона
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

  const seriesCard = (x: Series) => (
    <div key={x.id} className={s.card}>
      <div className={s.text}>
        <div className={s.name}>
          <span className={s.dot} style={{ background: x.color ?? '#4A5164' }} aria-hidden />
          {x.name}
          <span className={s.kindTag}>{x.kind === 'tournament' ? 'турнирная' : 'свободная'}</span>
          {x.tournamentId !== null ? <span className={s.locked}>турнир привязан</span> : null}
        </div>
        <div className={s.shape}>
          {x.pools.length > 0
            ? `${x.pools.length} маппулов · ${x.pools.filter((p) => p.isLocked).length} сыграно`
            : 'маппулов пока нет'}
        </div>
      </div>

      <div className={s.actions}>
        <Button size="sm" variant="primary" onClick={() => setShowSeries(x.id)}>
          Открыть
        </Button>
        <button
          className={s.more}
          onClick={() => setMenu(menu === `s${x.id}` ? null : `s${x.id}`)}
          type="button"
          aria-label="Действия"
        >
          ⋯
        </button>
        <Menu open={menu === `s${x.id}`} onClose={() => setMenu(null)} align="right">
          <MenuItem
            danger
            note="Маппулы останутся"
            onClick={() => {
              setMenu(null);
              void guard(async () => {
                if (!window.confirm(`Удалить серию «${x.name}»? Маппулы останутся.`)) return;
                await ipc.deleteSeries(x.id);
                await reload();
              });
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
          {p.seriesName !== null ? (
            <button
              className={s.tag}
              onClick={() => {
                setTab('series');
                if (p.seriesId !== null) setShowSeries(p.seriesId);
              }}
              type="button"
            >
              {p.seriesName}
              {p.seriesLabel !== null ? ` · ${p.seriesLabel}` : ''}
            </button>
          ) : null}
        </div>
        <PoolComposition pool={p} />
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
  const visiblePools =
    poolFilter === 'archive'
      ? pools.filter((p) => p.status === 'archived')
      : poolFilter === 'loose'
        ? live.filter((p) => p.seriesId === null)
        : live;

  // Открытая серия занимает вкладку целиком.
  if (showSeries !== null) {
    return (
      <div className={s.screen}>
        <SeriesView
          id={showSeries}
          onOpenPool={(poolId, next) => {
            setNotes(next);
            setOpen({ kind: 'pool', id: poolId });
          }}
          onChanged={reload}
          onExit={() => {
            setShowSeries(null);
            void reload();
          }}
        />
      </div>
    );
  }

  return (
    <div className={s.screen}>
      <div className={s.pane}>
        <header className={s.tabbar}>
          <div className={s.tabs}>
            {(
              [
                ['pools', 'Маппулы', live.length],
                ['series', 'Серии', series.length],
                ['templates', 'Шаблоны', templates.length],
              ] as [Tab, string, number][]
            ).map(([key, name, count]) => (
              <button
                key={key}
                className={[s.tab, tab === key ? s.tabOn : null].filter(Boolean).join(' ')}
                onClick={() => setTab(key)}
                type="button"
              >
                {name}
                <span className={s.tabCount}>{count}</span>
              </button>
            ))}
          </div>

          <div className={s.right}>
            {tab === 'pools' ? (
              <>
                <ImportJson
                  onImported={(res) => {
                    // Импорт создаёт новый пул — открываем его в редакторе.
                    void reload();
                    setOpen({ kind: 'pool', id: res.pool.id });
                  }}
                >
                  {(openIt) => (
                    <Button size="sm" onClick={openIt} title="Собрать пул из файла .json">
                      Импорт JSON
                    </Button>
                  )}
                </ImportJson>
                <Button variant="primary" onClick={() => void makePool()}>
                  + Пустой маппул
                </Button>
              </>
            ) : null}

            {/* Серия — самое частое создание в разделе: кнопка на виду. */}
            {tab === 'series' ? (
              <Button variant="primary" onClick={() => setWizard(true)}>
                + Создать серию
              </Button>
            ) : null}

            {tab === 'templates' ? (
              <Button variant="primary" onClick={() => void makeTemplate()}>
                + Создать шаблон
              </Button>
            ) : null}
          </div>
        </header>

        {tab === 'pools' ? (
          <div className={s.subFilters}>
            {(
              [
                ['all', 'Все'],
                ['loose', 'Без серии'],
                ['archive', 'Архив'],
              ] as [PoolFilter, string][]
            ).map(([key, name]) => (
              <button
                key={key}
                className={[s.chip, poolFilter === key ? s.chipOn : null].filter(Boolean).join(' ')}
                onClick={() => setPoolFilter(key)}
                type="button"
              >
                {name}
              </button>
            ))}
          </div>
        ) : null}

        <div className={s.body}>
          <div className={s.col}>
            {error !== null ? <div className={s.error}>{error}</div> : null}

            {tab === 'templates' ? (
              templates.length === 0 ? (
                <Empty
                  title="Шаблонов пока нет"
                  note="Шаблон — это структура пула: сколько карт под каждый мод и откуда их брать. Использовать его можно из этой вкладки — создать маппул или сразу серию."
                  actions={
                    <Button variant="primary" onClick={() => void makeTemplate()}>
                      Создать шаблон
                    </Button>
                  }
                />
              ) : (
                templates.map(templateCard)
              )
            ) : null}

            {tab === 'series' ? (
              series.length === 0 ? (
                <Empty
                  title="Серий пока нет"
                  note="Серия — набор маппулов под один турнир. Создай пустую или сразу накатай по шаблону — по одному маппулу на раунд."
                  actions={
                    <Button variant="primary" onClick={() => setWizard(true)}>
                      Создать серию
                    </Button>
                  }
                />
              ) : (
                series.map(seriesCard)
              )
            ) : null}

            {tab === 'pools' ? (
              visiblePools.length === 0 ? (
                <Empty
                  title={
                    poolFilter === 'archive'
                      ? 'Архив пуст'
                      : poolFilter === 'loose'
                        ? 'Свободных маппулов нет'
                        : 'Маппулов пока нет'
                  }
                  note={
                    poolFilter === 'archive'
                      ? 'Сюда попадают маппулы, убранные из работы.'
                      : 'Собери руками, импортируй JSON или скатай из шаблона.'
                  }
                  actions={
                    <Button variant="primary" onClick={() => void makePool()}>
                      Пустой маппул
                    </Button>
                  }
                />
              ) : (
                visiblePools.map(poolCard)
              )
            ) : null}
          </div>
        </div>
      </div>

      {wizard ? (
        <SeriesWizard
          templates={templates}
          onClose={() => setWizard(false)}
          onDone={(seriesId, genNotes) => {
            void reload();
            setTab('series');
            setShowSeries(seriesId);
            if (genNotes.length > 0) setNotes(genNotes);
          }}
        />
      ) : null}
    </div>
  );
}
