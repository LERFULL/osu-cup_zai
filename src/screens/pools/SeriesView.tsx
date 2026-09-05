import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Empty, Menu, MenuItem, MenuSeparator } from '@/components';
import type { GenNote, Pool, PoolTemplate, Series, SeriesPool, SeriesStats, SeriesStep, Tournament } from '@/lib/types';
import { formatStars, maps, poolsWord, starsRange } from '@/lib/format';
import { useReorder } from '@/lib/useReorder';
import * as ipc from '@/lib/ipc';
import { Report } from './Report';
import { SeriesRules } from './Rules';
import { useApp } from '@/store/app';
import s from './SeriesView.module.css';

interface Props {
  id: number;
  onOpenPool: (poolId: number, notes: GenNote[]) => void;
  /** Обновить списки раздела: состав и названия серий там же. */
  onChanged: () => void | Promise<void>;
  /** Вернуться к списку серий. */
  onExit: () => void;
}

/** Ширина диаграммы роста сложности в звёздах — общая шкала для всех строк. */
function scale(steps: SeriesStep[]): { lo: number; hi: number } {
  const values = steps.flatMap((x) =>
    [x.starsMin, x.starsMax].filter((v): v is number => v !== null),
  );
  if (values.length === 0) return { lo: 0, hi: 10 };
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // Одинаковые границы дали бы деление на ноль и полоску нулевой ширины.
  return hi - lo < 0.4 ? { lo: lo - 0.2, hi: hi + 0.2 } : { lo, hi };
}

export function SeriesView({ id, onOpenPool, onChanged, onExit }: Props) {
  const [series, setSeries] = useState<Series | null>(null);
  const [allSeries, setAllSeries] = useState<Series[]>([]);
  const [stats, setStats] = useState<SeriesStats | null>(null);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [templates, setTemplates] = useState<PoolTemplate[]>([]);
  const [loose, setLoose] = useState<Pool[]>([]);
  const [menu, setMenu] = useState<string | null>(null);
  const [rules, setRules] = useState(false);
  const [notes, setNotes] = useState<GenNote[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { go, setOpenTournament } = useApp();

  // Список пулов для перетаскивания. Через ref, а не через замыкание рендера:
  // ручка строки создаётся один раз, а порядок меняется на каждом переносе.
  const latest = useRef<SeriesPool[]>([]);
  latest.current = series?.pools ?? [];

  const load = useCallback(async () => {
    try {
      const [x, st, ts, tps, ps, all] = await Promise.all([
        ipc.getSeries(id),
        ipc.seriesStats(id),
        ipc.listTournaments().catch(() => [] as Tournament[]),
        ipc.listTemplates(),
        ipc.listPools(),
        ipc.listSeries(),
      ]);
      setSeries(x);
      setStats(st);
      setTournaments(ts);
      setTemplates(tps);
      setLoose(ps.filter((p) => p.status !== 'archived' && p.seriesId === null));
      setAllSeries(all);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function guard(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Порядок пулов — он же порядок раундов и порядок катания.
   *
   * Новый список считается снаружи, а не внутри `setSeries`: обновляющую
   * функцию React в строгом режиме зовёт дважды, и запрос из неё уходил бы
   * тоже дважды — вторая перестановка отменяла бы первую.
   */
  const move = useCallback(
    (from: number, to: number) => {
      const list = [...latest.current];
      const [moved] = list.splice(from, 1);
      if (moved === undefined) return;
      list.splice(to, 0, moved);

      // Показываем новый порядок сразу: иначе строка на миг отскакивала бы назад.
      setSeries((prev) => (prev === null ? prev : { ...prev, pools: list }));

      void ipc
        .reorderSeriesPools(
          id,
          list.map((x) => x.poolId),
        )
        .then(() => {
          void load();
          void onChanged();
        })
        .catch((e: unknown) => setError(String(e)));
    },
    [id, load, onChanged],
  );

  const reorder = useReorder({ count: series?.pools.length ?? 0, onDrop: move });

  if (series === null || stats === null) {
    return (
      <div className={s.screen}>
        {error !== null ? <Empty title="Не получилось открыть серию" note={error} /> : null}
      </div>
    );
  }

  const x = series;

  async function rename() {
    setMenu(null);
    const name = window.prompt('Название серии', x.name);
    if (name === null || name.trim() === '') return;
    await guard(async () => {
      await ipc.renameSeries(x.id, name.trim());
      await load();
      await onChanged();
    });
  }

  async function roll(keepPinned: boolean) {
    setMenu(null);
    await guard(async () => {
      const reports = await ipc.rollSeries(x.id, keepPinned);
      setNotes(reports.flatMap((r) => r.notes));
      await load();
      await onChanged();
    });
  }

  async function label(pool: SeriesPool) {
    const next = window.prompt('Метка раунда', pool.label ?? '');
    if (next === null) return;
    await guard(async () => {
      await ipc.setSeriesPoolLabel(pool.poolId, next.trim() === '' ? null : next.trim());
      await load();
    });
  }

  async function rerollRepeat(poolId: number, beatmapId: number) {
    await guard(async () => {
      const report = await ipc.rerollRepeat(poolId, beatmapId);
      setNotes(report.notes);
      await load();
    });
  }

  /** Привязка серии к турниру — она же «отправить маппулы в турнир». */
  async function bindTournament(tournamentId: number | null) {
    setMenu(null);
    await guard(async () => {
      if (tournamentId !== null) {
        // Маппулы серии сразу становятся пулами турнира.
        await ipc.addTournamentSeries(tournamentId, x.id).catch(() => undefined);
      }
      await ipc.setSeriesTournament(x.id, tournamentId);
      await load();
      await onChanged();
    });
  }

  const band = scale(stats.steps);
  const span = band.hi - band.lo;
  /** Место звёзд на общей шкале, в процентах ширины дорожки. */
  const at = (v: number) => ((v - band.lo) / span) * 100;

  return (
    <div className={s.screen}>
      <header className={s.bar}>
        <button className={s.back} onClick={onExit} type="button" title="К списку серий">
          ‹
        </button>
        <button className={s.title} onClick={() => void rename()} type="button">
          <span className={s.dot} style={{ background: x.color ?? '#4A5164' }} aria-hidden />
          {x.name}
        </button>
        <span className={s.kind}>{x.kind === 'tournament' ? 'турнирная' : 'свободная'}</span>
        <span className={s.sub}>
          {poolsWord(x.pools.length)} · {maps(stats.mapsTotal)}
        </span>

        {/* Турнир серии: выбор здесь же, без походов в редактор турнира. */}
        <div className={s.wrap}>
          <Button size="sm" onClick={() => setMenu(menu === 'tour' ? null : 'tour')}>
            {x.tournamentId !== null
              ? `Турнир: ${
                  tournaments.find((t) => t.id === x.tournamentId)?.name ?? `#${x.tournamentId}`
                }`
              : 'Турнир не привязан'}
          </Button>
          <Menu open={menu === 'tour'} onClose={() => setMenu(null)} align="right">
            {tournaments.map((t) => (
              <MenuItem
                key={t.id}
                onClick={() => void bindTournament(t.id)}
                disabled={t.id === x.tournamentId}
                {...(allSeries.some((other) => other.tournamentId === t.id && other.id !== x.id)
                  ? { note: 'к этому турниру уже привязана серия' }
                  : {})}
              >
                {t.name}
              </MenuItem>
            ))}
            {x.tournamentId !== null ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={() => void bindTournament(null)} danger>
                  Отвязать турнир
                </MenuItem>
              </>
            ) : null}
          </Menu>
        </div>

        {x.tournamentId !== null ? (
          <Button
            size="sm"
            onClick={() => {
              setOpenTournament(x.tournamentId);
              go('tournaments');
            }}
            title="Открыть редактор турнира"
          >
            К турниру ↗
          </Button>
        ) : null}

        <div className={s.right}>
          <Button size="sm" onClick={() => setRules(!rules)}>
            Правила серии
          </Button>
          <Button size="sm" onClick={() => void roll(true)} disabled={busy || x.pools.length === 0}>
            ↻ Скатать серию
          </Button>

          {/* Добавить маппул — три пути рядом: пустой, из шаблона, из уже готовых. */}
          <div className={s.wrap}>
            <Button
              size="sm"
              variant="primary"
              onClick={() => setMenu(menu === 'add' ? null : 'add')}
            >
              + Добавить маппул
            </Button>
            <Menu open={menu === 'add'} onClose={() => setMenu(null)} align="right">
              <MenuItem
                onClick={() => {
                  setMenu(null);
                  void guard(async () => {
                    const made = await ipc.createPool(`${x.name} — новый`, x.id);
                    await load();
                    await onChanged();
                    onOpenPool(made.id, []);
                  });
                }}
                note="собрать вручную"
              >
                Пустой маппул
              </MenuItem>

              {templates.length > 0 ? (
                <MenuItem onClick={() => setMenu('fromTemplate')} note="структура и состав подтянутся">
                  Из шаблона…
                </MenuItem>
              ) : null}

              {loose.length > 0 ? (
                <MenuItem onClick={() => setMenu('fromLoose')} note="перенести без генерации">
                  Существующий…
                </MenuItem>
              ) : null}
            </Menu>

            <Menu open={menu === 'fromTemplate'} onClose={() => setMenu(null)} align="right">
              {templates.map((t) => (
                <MenuItem
                  key={t.id}
                  onClick={() => {
                    setMenu(null);
                    void guard(async () => {
                      const report = await ipc.generatePool(t.id, `${x.name} — ${t.name}`, x.id);
                      setNotes(report.notes);
                      await load();
                      await onChanged();
                      onOpenPool(report.pool.id, report.notes);
                    });
                  }}
                >
                  {t.name}
                </MenuItem>
              ))}
            </Menu>

            <Menu open={menu === 'fromLoose'} onClose={() => setMenu(null)} align="right">
              {loose.map((p) => (
                <MenuItem
                  key={p.id}
                  onClick={() => {
                    setMenu(null);
                    void guard(async () => {
                      const clashes = await ipc.addPoolToSeries(x.id, p.id);
                      if (clashes.length > 0) {
                        setError(
                          `Маппул не перенесён: карты повторяются — ${clashes
                            .map((c) => `${c.name} (${c.pools.join(', ')})`)
                            .join('; ')}.`,
                        );
                        return;
                      }
                      await load();
                      await onChanged();
                    });
                  }}
                  note={p.name}
                >
                  {p.seriesLabel ?? p.name}
                </MenuItem>
              ))}
            </Menu>
          </div>

          <div className={s.wrap}>
            <Button size="sm" onClick={() => setMenu(menu === 'more' ? null : 'more')}>
              ⋯
            </Button>
            <Menu open={menu === 'more'} onClose={() => setMenu(null)} align="right">
              <MenuItem onClick={() => void rename()}>Переименовать</MenuItem>
              <MenuItem
                onClick={() => void roll(false)}
                note="Закрепления не спасут — карты сменятся все"
              >
                Скатать заново целиком
              </MenuItem>
            </Menu>
          </div>
        </div>
      </header>

      <div className={s.body}>
        <div className={s.col}>
          {error !== null ? <div className={s.error}>{error}</div> : null}

          {notes.length > 0 ? (
            <Report notes={notes} onClose={() => setNotes([])} withPool />
          ) : null}

          {rules ? (
            <SeriesRules
              series={x}
              onClose={() => setRules(false)}
              onChanged={async () => {
                await load();
                await onChanged();
              }}
            />
          ) : null}

          <section className={s.cards}>
            <div className={s.card}>
              <div className={s.big}>{stats.mapsTotal}</div>
              <div className={s.small}>
                карт всего
                {stats.mapsUnique !== stats.mapsTotal ? ` (${stats.mapsUnique} уникальных)` : ''}
              </div>
            </div>
            <div className={[s.card, stats.repeats > 0 ? s.alarm : null].filter(Boolean).join(' ')}>
              <div className={s.big}>{stats.repeats}</div>
              <div className={s.small}>повторов</div>
            </div>
            <div className={s.card}>
              <div className={s.big}>{starsRange(stats.starsMin, stats.starsMax)}</div>
              <div className={s.small}>звёзды</div>
            </div>
            <div className={s.card}>
              <div className={s.big}>{stats.mappers}</div>
              <div className={s.small}>
                мапперов
                {stats.mappersRepeated > 0 ? `, ${stats.mappersRepeated} повторяются` : ''}
              </div>
            </div>
            <div className={s.card}>
              <div className={s.big}>{stats.playedBefore}</div>
              <div className={s.small}>играли раньше</div>
            </div>
          </section>

          {stats.steps.some((step) => step.starsAvg !== null) ? (
            <section className={s.panel}>
              <h3 className={s.h3}>Рост сложности</h3>
              <div className={s.chart}>
                {stats.steps.map((step) => (
                  <div key={step.poolId} className={s.step}>
                    <span className={s.stepName}>{step.label}</span>
                    {step.starsMin !== null && step.starsMax !== null ? (
                      <>
                        <span className={s.from}>{formatStars(step.starsMin)}</span>
                        <span className={s.track}>
                          <span
                            className={s.range}
                            style={{
                              left: `${at(step.starsMin).toFixed(1)}%`,
                              width: `${Math.max(1, at(step.starsMax) - at(step.starsMin)).toFixed(1)}%`,
                            }}
                          />
                          {step.starsAvg !== null ? (
                            <span
                              className={s.avg}
                              style={{ left: `${at(step.starsAvg).toFixed(1)}%` }}
                            />
                          ) : null}
                        </span>
                        <span className={s.to}>{formatStars(step.starsMax)}</span>
                      </>
                    ) : (
                      <span className={s.trackEmpty}>карт нет</span>
                    )}
                    {step.belowPrevious ? (
                      <span className={s.below} title="Бывает намеренно — это только подпись">
                        ⚠ ниже предыдущего
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className={s.panel}>
            <h3 className={s.h3}>Маппулы</h3>

            {x.pools.length === 0 ? (
              <p className={s.hint}>
                В серии пока нет маппулов. Перетащи их сюда из общего списка или добавь пустой.
              </p>
            ) : null}

            {x.pools.map((pool, i) => (
              <div key={pool.poolId} className={s.pool} data-row style={reorder.rowStyle(i)}>
                <span
                  className={s.grip}
                  title="Потянуть, чтобы сменить порядок раундов"
                  {...reorder.handleProps(i)}
                >
                  ⠿
                </span>

                <button
                  className={s.poolLabel}
                  onClick={() => void label(pool)}
                  type="button"
                  title="Сменить метку раунда"
                >
                  {pool.label ?? '—'}
                </button>

                <button
                  className={s.poolMain}
                  onClick={() => onOpenPool(pool.poolId, [])}
                  type="button"
                >
                  <span className={s.poolName}>
                    {pool.name}
                    {pool.version > 1 ? <span className={s.version}>v{pool.version}</span> : null}
                    {pool.isLocked ? <span className={s.locked}>сыгран</span> : null}
                  </span>
                  <span className={s.poolShape}>{pool.shape}</span>
                </button>

                <span className={s.poolStars}>
                  {pool.starsAvg !== null ? `${formatStars(pool.starsAvg)}★` : '—'}
                </span>
                <span className={s.poolFilled}>
                  {pool.filled} / {pool.slots}
                </span>
                {pool.warnings > 0 ? (
                  <span className={s.poolWarn} title="Предупреждений в строках">
                    ⚠ {pool.warnings}
                  </span>
                ) : (
                  <span className={s.poolOk} />
                )}

                <button
                  className={s.poolX}
                  onClick={() =>
                    void guard(async () => {
                      await ipc.removePoolFromSeries(pool.poolId);
                      await load();
                      await onChanged();
                    })
                  }
                  type="button"
                  title="Вынести из серии"
                >
                  ✕
                </button>
              </div>
            ))}
          </section>

          {stats.repeatRows.length > 0 ? (
            <section className={s.panel}>
              <h3 className={s.h3}>Повторы</h3>
              <p className={s.hint}>
                {x.kind === 'tournament'
                  ? 'В турнирной серии повторов быть не должно — эти внесли руками после генерации.'
                  : 'Карта стоит в двух маппулах серии.'}
              </p>

              {stats.repeatRows.map((row) => {
                const last = row.poolIds[row.poolIds.length - 1];
                return (
                  <div key={row.beatmapId} className={s.repeat}>
                    <span className={s.repeatName}>{row.name}</span>
                    <span className={s.repeatWhere}>{row.pools.join(' · ')}</span>
                    {last !== undefined ? (
                      <Button
                        size="sm"
                        onClick={() => void rerollRepeat(last, row.beatmapId)}
                        disabled={busy}
                      >
                        ↻ Перекатить в {row.pools[row.pools.length - 1]}
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
