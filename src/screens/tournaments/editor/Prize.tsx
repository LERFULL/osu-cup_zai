import { useEffect, useRef, useState } from 'react';
import { Button, Field, Modal, Switch } from '@/components';
import { money } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import type { PrizeConfig, PrizeEngine, PrizeView } from '@/lib/types';
import type { EditorCtx } from './Editor';
import s from './Prize.module.css';

/** Движки фонда: ровно один, переключателем. */
const ENGINES: { kind: PrizeEngine['kind']; shares: number[]; title: string; note: string }[] = [
  {
    kind: 'places',
    shares: [34, 24, 17, 11, 8, 6],
    title: 'За места',
    note: 'платят первые N мест по процентам',
  },
  {
    kind: 'matches',
    shares: [],
    title: 'За победы в матчах',
    note: 'чем ближе к финалу, тем дороже победа',
  },
  {
    kind: 'maps',
    shares: [],
    title: 'За карты',
    note: 'живой счётчик: каждая взятая карта платит',
  },
  {
    kind: 'bounty',
    shares: [30, 22, 16, 12, 9, 6, 5],
    title: 'Охота за головами',
    note: 'весь фонд — на головах сидов: выбил — забрал',
  },
];

const ENGINE_TITLE: Record<PrizeEngine['kind'], string> = {
  places: 'за места',
  matches: 'за победы в матчах',
  maps: 'за карты',
  bounty: 'охота за головами',
};

/** Движок под кнопку: свежий, с дефолтами под свой вид. */
function engineOf(kind: PrizeEngine['kind'], shares: number[], players: number): PrizeEngine {
  if (kind === 'bounty') {
    // Голов столько, сколько игроков: лишние сиды — пустая трата процентов.
    const fit = shares.slice(0, Math.max(2, players));
    const sum = fit.reduce((a, b) => a + b, 0);
    const fixed = sum === 100 ? fit : renormalize(fit);
    return { kind, shares: fixed, growth: 200, lowerDiscount: 50, rollover: false };
  }
  return {
    kind,
    shares: shares.length > 0 ? [...shares] : [],
    growth: 200,
    lowerDiscount: players <= 4 ? 100 : 50,
    rollover: false,
  };
}

/** Подогнать проценты к сотне, сохраняя пропорции. */
function renormalize(shares: number[]): number[] {
  if (shares.length === 0) return [100];
  const sum = shares.reduce((a, b) => a + b, 0);
  if (sum <= 0) return shares.map(() => Math.round(100 / shares.length));
  const scaled = shares.map((x) => Math.max(1, Math.round((x * 100) / sum)));
  const left = 100 - scaled.reduce((a, b) => a + b, 0);
  scaled[0] = Math.max(1, (scaled[0] ?? 1) + left);
  return scaled;
}

function emptyConfig(players: number): PrizeConfig {
  return {
    fund: 10_000,
    engine: engineOf('places', [34, 24, 17, 11, 8, 6], players),
    addons: {
      bounty: null,
      matchPayments: null,
      rookieRace: null,
      underdog: false,
      spectator: null,
      jackpot: false,
    },
    bestMatchId: null,
    jackpotIn: 0,
    rolledOut: 0,
  };
}

const clone = (c: PrizeConfig): PrizeConfig => JSON.parse(JSON.stringify(c)) as PrizeConfig;

/** Краткая сводка надстроек — строчкой в секции. */
function addonsBrief(c: PrizeConfig): string {
  const parts: string[] = [];
  if (c.addons.bounty !== null) parts.push('деньги на голове');
  if (c.addons.matchPayments !== null) parts.push('выплаты за матчи');
  if (c.addons.rookieRace !== null) parts.push('гонка новичков');
  if (c.addons.underdog) parts.push('андердог');
  if (c.addons.spectator !== null) parts.push('зрительский банк');
  if (c.addons.jackpot) parts.push('джекпот');
  return parts.length === 0 ? 'без надстроек' : parts.join(' · ');
}

/**
 * Призовой фонд. В секции редактора — только сводка и кнопка: настраивают
 * фонд редко, а места он занимает много. Вся настройка — в компактном
 * диалоге, который открывается кнопкой и закрывается кнопкой.
 */
export function Prize(ctx: EditorCtx) {
  const { id, t, emergency, run } = ctx;
  const [config, setConfig] = useState<PrizeConfig>(() => t.prize ?? emptyConfig(t.players.length));
  const [view, setView] = useState<PrizeView | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);

  // Турнир перечитали после чужой правки — подхватываем сохранённое.
  useEffect(() => {
    if (t.prize !== null) setConfig(t.prize);
  }, [t.prize]);

  // Первое чтение фонда — без него и проверки нет.
  useEffect(() => {
    void ipc.prizeState(id).then((v) => setView(v));
  }, [id]);

  const has = t.prize !== null;

  /** Применить правку: сохранить и тут же получить пересчитанный вид. */
  function apply(patch: (c: PrizeConfig) => void) {
    const next = clone(config);
    patch(next);
    setConfig(next);
    run(async () => {
      const v = await ipc.setTournamentPrize(id, next, emergency);
      setView(v);
    });
  }

  /** Правка одного числа без пересохранения на каждый символ. */
  function commitNumber(raw: string, patch: (c: PrizeConfig, value: number) => void) {
    const value = Math.round(Number(raw));
    if (!Number.isFinite(value) || value < 0) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => apply((c) => patch(c, value)), 500);
  }

  if (!has) {
    return (
      <>
        <div className={s.sub}>
          Необязательный: без фонда всё работает как раньше. Деньги считаются
          сами и видны в эфире.
        </div>
        <div className={s.buttons}>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              const fresh = emptyConfig(t.players.length);
              setConfig(fresh);
              setOpen(true);
              run(async () => {
                const v = await ipc.setTournamentPrize(id, fresh, emergency);
                setView(v);
              });
            }}
          >
            + Призовой фонд
          </Button>
        </div>
      </>
    );
  }

  const problems = view?.problems ?? [];

  return (
    <>
      <div className={s.summary}>
        <div className={s.sumRow}>
          <span className={s.sumLabel}>фонд</span>
          <span className={s.sumValue}>{money(config.fund)}</span>
        </div>
        <div className={s.sumRow}>
          <span className={s.sumLabel}>движок</span>
          <span className={s.sumValue}>{ENGINE_TITLE[config.engine.kind]}</span>
        </div>
        <div className={s.sumRow}>
          <span className={s.sumLabel}>надстройки</span>
          <span className={s.sumNote}>{addonsBrief(config)}</span>
        </div>
        {view !== null ? (
          <div className={view.check.ok && problems.length === 0 ? s.ok : s.bad}>
            {view.check.ok && problems.length === 0 ? '✓ ' : '⚠ '}
            {problems.length > 0 ? problems[0] : view.check.text}
          </div>
        ) : null}
      </div>

      <div className={s.buttons}>
        <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
          Настроить фонд
        </Button>
      </div>

      {open ? (
        <PrizeDialog
          ctx={ctx}
          config={config}
          view={view}
          apply={apply}
          commit={commitNumber}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

// ───────────────────────────────────────────────────────────── диалог

interface DialogProps {
  ctx: EditorCtx;
  config: PrizeConfig;
  view: PrizeView | null;
  apply: (patch: (c: PrizeConfig) => void) => void;
  commit: (raw: string, patch: (c: PrizeConfig, value: number) => void) => void;
  onClose: () => void;
}

/** Компактный диалог: сумма, движок, надстройки и пример внизу. */
function PrizeDialog({ ctx, config, view, apply, commit, onClose }: DialogProps) {
  const t = ctx.t;
  const bountyEngine = config.engine.kind === 'bounty';

  return (
    <Modal
      wide
      title="Призовой фонд"
      note="Каждая правка сразу сохраняется и пересчитывает проверку. Внизу — пример того, как деньги себя поведут в турнире."
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={() => apply((c) => (c.fund = 0))}>
            Снять фонд
          </Button>
          <Button size="sm" variant="primary" onClick={onClose}>
            Готово
          </Button>
        </>
      }
    >
      {/* ── сумма */}
      <div className={s.two}>
        <Field
          label="Фонд, ₽"
          type="number"
          min={0}
          step={500}
          key={`fund-${config.fund}`}
          defaultValue={config.fund}
          hint="остаток округления идёт первому месту"
          onBlur={(e) => commitNumberBlur(e, commit)}
        />
        <div className={s.fundNote}>
          <span>{bountyEngine ? 'на головах' : 'движку остаётся'}</span>
          <b className={(view?.engineShare ?? 0) < 0 ? s.bad : undefined}>
            {money(view?.engineShare ?? 0)}
          </b>
          {config.addons.jackpot && view !== null ? (
            <span>джекпот вкатан: {money(config.jackpotIn)}</span>
          ) : null}
        </div>
      </div>

      {/* ── движок */}
      <section className={s.group}>
        <h3 className={s.groupTitle}>Движок — ровно один</h3>
        <div className={s.chips}>
          {ENGINES.map((e) => {
            const on =
              config.engine.kind === e.kind &&
              (e.kind !== 'places' || config.engine.shares.join(',') === e.shares.join(',')) &&
              (e.kind !== 'bounty' || config.engine.shares.join(',') === e.shares.join(','));
            return (
              <button
                key={e.title}
                className={on ? s.chipOn : s.chip}
                type="button"
                title={e.note}
                onClick={() =>
                  apply((c) => {
                    c.engine = engineOf(e.kind, e.shares, t.players.length);
                    // Охота уже платит за головы: надстройка баунти ей не нужна.
                    if (e.kind === 'bounty') c.addons.bounty = null;
                  })
                }
              >
                {e.title}
              </button>
            );
          })}
        </div>
        <div className={s.engineNote}>
          {ENGINES.find((e) => e.kind === config.engine.kind)?.note}
        </div>
      </section>

      {config.engine.kind === 'places' ? (
        <PlacesEditor config={config} view={view} apply={apply} commit={commit} />
      ) : null}

      {config.engine.kind === 'matches' ? (
        <MatchesEditor config={config} view={view} apply={apply} />
      ) : null}

      {config.engine.kind === 'maps' ? <MapsEditor config={config} view={view} apply={apply} /> : null}

      {bountyEngine ? (
        <BountyEngineEditor config={config} view={view} apply={apply} commit={commit} />
      ) : null}

      {/* ── надстройки */}
      <section className={s.group}>
        <h3 className={s.groupTitle}>Надстройки</h3>

        {bountyEngine ? (
          <div className={s.engineNote}>
            Движок охоты уже платит за головы — надстройка «деньги на голове» ему не нужна.
          </div>
        ) : (
          <BountyAddon config={config} view={view} apply={apply} commit={commit} />
        )}

        <MatchPaymentsAddon config={config} view={view} apply={apply} commit={commit} />

        <Switch
          checked={config.addons.rookieRace !== null}
          onChange={(v) =>
            apply((c) => {
              c.addons.rookieRace = v ? Math.round(c.fund * 0.3) : null;
            })
          }
          note="Фонд режется надвое: общий зачёт и отдельный зачёт новичков. Сетка одна, гонки две"
        >
          Гонка новичков
        </Switch>
        {config.addons.rookieRace !== null ? (
          <div className={s.addonBody}>
            <label className={s.addonRow}>
              <span className={s.rowName}>доля новичков, ₽</span>
              <input
                className={s.cell}
                type="number"
                min={0}
                key={`rr-${config.addons.rookieRace}`}
                defaultValue={config.addons.rookieRace}
                onBlur={(e) =>
                  commit(e.target.value, (c, v) => {
                    c.addons.rookieRace = v;
                  })
                }
              />
            </label>
            <div className={s.addonRow}>
              <span className={s.rowName}>новичков в составе</span>
              <span className={s.rowValue}>
                {t.players.filter((p) => p.isRookie).length} — галочка у участника
              </span>
            </div>
          </div>
        ) : null}

        {/* Множитель андердога имеет смысл только там, где платят за победы
            в матчах: движок «за победы» или надстройка выплат. В остальных
            конфигурациях он ничего не умножает — и прячется, а не висит
            бессмысленной галочкой. */}
        {config.engine.kind === 'matches' || config.addons.matchPayments !== null ? (
          <Switch
            checked={config.addons.underdog}
            onChange={(v) =>
              apply((c) => {
                c.addons.underdog = v;
              })
            }
            note="Победа над более сильным сидом платит ступенью: ×1.5, ×2, ×3 — умножает цену победы в матче"
          >
            Множитель за андердога
          </Switch>
        ) : null}

        <Switch
          checked={config.addons.spectator !== null}
          onChange={(v) =>
            apply((c) => {
              c.addons.spectator = v ? Math.round(c.fund * 0.1) : null;
              if (!v) c.bestMatchId = null;
            })
          }
          note="Часть фонда на приз за лучший матч. Победителя отмечает хост: голосование в чате приложение не читает"
        >
          Зрительский банк
        </Switch>

        {config.addons.spectator !== null ? (
          <div className={s.addonBody}>
            <label className={s.addonRow}>
              <span className={s.rowName}>доля банка, ₽</span>
              <input
                className={s.cell}
                type="number"
                min={0}
                key={`sp-${config.addons.spectator}`}
                defaultValue={config.addons.spectator}
                onBlur={(e) =>
                  commit(e.target.value, (c, v) => {
                    c.addons.spectator = v;
                  })
                }
              />
            </label>
            {view?.bestMatch != null ? (
              <div className={s.addonRow}>
                <span className={s.rowName}>лучший матч</span>
                <span className={s.rowValue}>{view.bestMatch.label}</span>
              </div>
            ) : null}
          </div>
        ) : null}

        <Switch
          checked={config.addons.jackpot}
          onChange={(v) =>
            apply((c) => {
              c.addons.jackpot = v;
            })
          }
          note={
            view !== null && view.jackpotNow > 0
              ? `невыданный остаток не сгорает: сейчас в джекпоте ${money(view.jackpotNow)} — он вкатится в этот фонд при старте`
              : 'невыданный остаток не сгорает, а падает в фонд следующего турнира'
          }
        >
          Переходящий джекпот
        </Switch>
      </section>

      {/* ── пример: как поведут себя деньги */}
      <MoneyExample config={config} view={view} />

      {/* ── проверки */}
      {view !== null ? (
        <section className={s.group}>
          <h3 className={s.groupTitle}>Проверка</h3>
          {view.problems.map((p) => (
            <div key={p} className={s.err}>
              {p}
            </div>
          ))}
          <div className={view.check.ok ? s.ok : s.err}>
            {view.check.ok ? '✓ ' : '⚠ '}
            {view.check.text}
          </div>
          {view.note !== null ? <div className={s.warn}>{view.note}</div> : null}
        </section>
      ) : null}
    </Modal>
  );
}

/** Коммит числа из поля суммы фонда. */
function commitNumberBlur(
  e: React.FocusEvent<HTMLInputElement>,
  commit: (raw: string, patch: (c: PrizeConfig, value: number) => void) => void,
) {
  commit(e.target.value, (c, v) => {
    c.fund = v;
  });
}

// ─────────────────────────────────────────────────── параметры движков

interface EngineProps {
  config: PrizeConfig;
  view: PrizeView | null;
  apply: (patch: (c: PrizeConfig) => void) => void;
  commit: (raw: string, patch: (c: PrizeConfig, value: number) => void) => void;
}

/** Проценты мест с живыми суммами: видно и долю, и рубли.
 *
 * Два способа посмотреть одно и то же: таблица для правки (проценты и суммы
 * в строках) и сетка для взгляда (лестница мест без участников — сразу видно,
 * как деньги падают от чемпиона вниз). */
function PlacesEditor({ config, view, apply, commit }: EngineProps) {
  const [grid, setGrid] = useState(false);
  const shares = config.engine.shares;
  const share = view?.engineShare ?? 0;
  const sum = shares.reduce((a, b) => a + b, 0);
  const amounts = shares.map(
    (p, i) => view?.ladder[i]?.guarantee ?? Math.floor((share * p) / 100),
  );
  const maxAmount = Math.max(1, ...amounts);

  return (
    <section className={s.group}>
      <h3 className={s.groupTitle}>
        Раскладка мест
        <span className={s.viewTabs}>
          <button
            type="button"
            className={grid ? undefined : s.viewOn}
            onClick={() => setGrid(false)}
          >
            таблица
          </button>
          <button
            type="button"
            className={grid ? s.viewOn : undefined}
            onClick={() => setGrid(true)}
          >
            сетка
          </button>
        </span>
      </h3>

      {grid ? (
        /* Сетка: лестница мест — ширина ступени это деньги, участник не
           нужен, чтобы увидеть, как фонд ложится по местам. */
        <div className={s.ladder}>
          {shares.map((p, i) => (
            <div key={i} className={s.ladderStep} style={{ '--i': i } as React.CSSProperties}>
              <span className={s.ladderPlace}>{i + 1}</span>
              <span className={s.ladderBar} aria-hidden>
                <i style={{ width: `${Math.max(3, (amounts[i] ?? 0) / maxAmount * 100).toFixed(1)}%` }} />
              </span>
              <span className={s.ladderMoney}>{money(amounts[i] ?? 0)}</span>
              <span className={s.ladderPct}>{p}%</span>
            </div>
          ))}
          <div className={s.ladderNote}>
            {shares.length} {pluralPlaces(shares.length)} · участников в кадре нет — только деньги по местам
          </div>
        </div>
      ) : (
        <div className={s.rounds}>
          {shares.map((sharePercent, i) => {
            const amount = amounts[i] ?? 0;
            return (
              <div key={i} className={s.round}>
                <span className={s.roundName}>{i + 1} место</span>
                <input
                  className={s.cell}
                  type="number"
                  min={1}
                  max={100}
                  key={`share-${i}-${sharePercent}`}
                  defaultValue={sharePercent}
                  title="процент фонда"
                  onBlur={(e) =>
                    commit(e.target.value, (c, v) => {
                      c.engine.shares[i] = Math.max(1, Math.min(100, v));
                      c.engine.shares = [...c.engine.shares];
                    })
                  }
                />
                <span className={s.rowValue}>{money(amount)}</span>
                <button
                  className={s.reset}
                  type="button"
                  title="Убрать место из раскладки"
                  onClick={() =>
                    apply((c) => {
                      c.engine.shares = c.engine.shares.filter((_, j) => j !== i);
                    })
                  }
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className={s.addonRow}>
        <span className={s.rowName}>сумма процентов</span>
        <span className={sum === 100 ? s.rowValue : s.bad}>{sum}%</span>
      </div>

      <div className={s.buttons}>
        <Button
          size="sm"
          onClick={() =>
            apply((c) => {
              const last = c.engine.shares[c.engine.shares.length - 1] ?? 20;
              c.engine.shares = [...c.engine.shares, Math.max(1, Math.floor(last / 2))];
            })
          }
        >
          + Оплачиваемое место
        </Button>
      </div>
    </section>
  );
}

/** «2 места / 5 мест» — подпись под сеткой. */
function pluralPlaces(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'место';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'места';
  return 'мест';
}

/** Форма матчевых выплат: рост, скидка и честная таблица цен. */
function MatchesEditor({ config, view, apply }: Omit<EngineProps, 'commit'>) {
  return (
    <section className={s.group}>
      <h3 className={s.groupTitle}>Форма выплат</h3>
      <PercentRow
        label="рост к финалу"
        value={config.engine.growth}
        onCommit={(v) =>
          apply((c) => {
            c.engine.growth = v;
          })
        }
      />
      <PercentRow
        label="скидка нижней сетки"
        value={config.engine.lowerDiscount}
        onCommit={(v) =>
          apply((c) => {
            c.engine.lowerDiscount = v;
          })
        }
      />
      <PriceTable prices={view?.matchPrices ?? []} />
      <div className={s.hint}>
        Приложение нормирует форму так, чтобы сумма по всем матчам сошлась с долей движка ровно.
      </div>
    </section>
  );
}

/** Цена карты: фиксированная, фонд гуляет в пределах сыгранных карт. */
function MapsEditor({ config, view, apply }: Omit<EngineProps, 'commit'>) {
  const price = view?.mapPrice ?? null;
  return (
    <section className={s.group}>
      <h3 className={s.groupTitle}>Цена карты</h3>
      <PercentRow
        label="скидка нижней сетки"
        value={config.engine.lowerDiscount}
        onCommit={(v) =>
          apply((c) => {
            c.engine.lowerDiscount = v;
          })
        }
      />
      {price !== null ? (
        <>
          <div className={s.addonRow}>
            <span className={s.rowName}>карта в победном матче</span>
            <span className={s.rowValue}>{money(price.win)}</span>
          </div>
          <div className={s.addonRow}>
            <span className={s.rowName}>карта в проигранном матче</span>
            <span className={s.rowValue}>{money(price.loss)}</span>
          </div>
        </>
      ) : (
        <div className={s.hint}>Цена посчитается, когда в турнире будет хотя бы два игрока.</div>
      )}
      {view?.spread != null ? (
        <div className={s.hint}>
          Разброс фонда: от {money(view.spread.min)} до {money(view.spread.max)} — итог гуляет в
          пределах числа сыгранных карт.
        </div>
      ) : null}
    </section>
  );
}

/** Движок охоты: проценты на голове каждого сида и режим переката. */
function BountyEngineEditor({ config, view, apply, commit }: EngineProps) {
  const shares = config.engine.shares;
  const share = view?.engineShare ?? 0;
  const sum = shares.reduce((a, b) => a + b, 0);

  return (
    <section className={s.group}>
      <h3 className={s.groupTitle}>Головы по сидам</h3>
      <div className={s.rounds}>
        {shares.map((sharePercent, i) => {
          const amount = Math.floor((share * sharePercent) / 100);
          return (
            <div key={i} className={s.round}>
              <span className={s.roundName}>{i + 1} сид</span>
              <input
                className={s.cell}
                type="number"
                min={1}
                max={100}
                key={`bshare-${i}-${sharePercent}`}
                defaultValue={sharePercent}
                title="процент фонда на голове"
                onBlur={(e) =>
                  commit(e.target.value, (c, v) => {
                    c.engine.shares[i] = Math.max(1, Math.min(100, v));
                    c.engine.shares = [...c.engine.shares];
                  })
                }
              />
              <span className={s.rowValue}>{money(amount)}</span>
              <button
                className={s.reset}
                type="button"
                title="Убрать голову"
                onClick={() =>
                  apply((c) => {
                    c.engine.shares = c.engine.shares.filter((_, j) => j !== i);
                  })
                }
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>

      <div className={s.addonRow}>
        <span className={s.rowName}>сумма процентов</span>
        <span className={sum === 100 ? s.rowValue : s.bad}>{sum}%</span>
      </div>

      <div className={s.buttons}>
        <Button
          size="sm"
          onClick={() =>
            apply((c) => {
              const last = c.engine.shares[c.engine.shares.length - 1] ?? 10;
              c.engine.shares = [...c.engine.shares, Math.max(1, Math.floor(last / 2))];
            })
          }
        >
          + Голова на следующий сид
        </Button>
      </div>

      <Switch
        checked={config.engine.rollover}
        onChange={(v) =>
          apply((c) => {
            c.engine.rollover = v;
          })
        }
        note="Половина уходит убийце, половина переезжает ему на голову — к финалу на лидере висит заметная сумма"
      >
        Режим переката
      </Switch>
    </section>
  );
}

// ───────────────────────────────────────────────────────── надстройки

/** Надстройка «деньги на голове»: фиксированные суммы на первых сидах. */
function BountyAddon({ config, view, apply, commit }: EngineProps) {
  void view;
  const bountyTotal = config.addons.bounty?.amounts.reduce((a, b) => a + b, 0) ?? 0;
  return (
    <>
      <Switch
        checked={config.addons.bounty !== null}
        onChange={(v) =>
          apply((c) => {
            c.addons.bounty = v
              ? { amounts: [700, 450, 350].map((x) => Math.min(x, c.fund)), rollover: false }
              : null;
          })
        }
        note="Сумма на первых сидах. Выбил — забрал сразу; с перекатом половина переезжает на голову убийцы"
      >
        Деньги на голове
      </Switch>

      {config.addons.bounty !== null ? (
        <div className={s.addonBody}>
          {config.addons.bounty.amounts.map((amount, i) => (
            <label key={i} className={s.addonRow}>
              <span className={s.rowName}>{i + 1} сид</span>
              <input
                className={s.cell}
                type="number"
                min={0}
                key={`bounty-${i}-${amount}`}
                defaultValue={amount}
                onBlur={(e) =>
                  commit(e.target.value, (c, v) => {
                    const arr = c.addons.bounty?.amounts ?? [];
                    arr[i] = v;
                    if (c.addons.bounty) c.addons.bounty.amounts = arr;
                  })
                }
              />
            </label>
          ))}
          <div className={s.addonRow}>
            <span className={s.rowName}>всего на головах</span>
            <span className={s.rowValue}>{money(bountyTotal)}</span>
          </div>
          <Switch
            checked={config.addons.bounty.rollover}
            onChange={(v) =>
              apply((c) => {
                if (c.addons.bounty) c.addons.bounty.rollover = v;
              })
            }
            note="Половина уходит убийце, половина переезжает ему на голову"
          >
            Режим переката
          </Switch>
        </div>
      ) : null}
    </>
  );
}

/** Надстройка «выплаты за матчи»: доля фонда поверх движка мест. */
function MatchPaymentsAddon({ config, view, apply, commit }: EngineProps) {
  return (
    <>
      <Switch
        checked={config.addons.matchPayments !== null}
        onChange={(v) =>
          apply((c) => {
            c.addons.matchPayments = v
              ? {
                  amount: Math.round(c.fund * 0.25),
                  growth: 200,
                  lowerDiscount: c.engine.kind === 'matches' ? c.engine.lowerDiscount : 50,
                }
              : null;
            if (!v) c.addons.underdog = false;
          })
        }
        note="Доля фонда за победы в матчах поверх движка: чем ближе к финалу, тем дороже"
      >
        Выплаты за матчи
      </Switch>

      {config.addons.matchPayments !== null ? (
        <div className={s.addonBody}>
          <label className={s.addonRow}>
            <span className={s.rowName}>доля, ₽</span>
            <input
              className={s.cell}
              type="number"
              min={0}
              key={`mp-${config.addons.matchPayments.amount}`}
              defaultValue={config.addons.matchPayments.amount}
              onBlur={(e) =>
                commit(e.target.value, (c, v) => {
                  if (c.addons.matchPayments) c.addons.matchPayments.amount = v;
                })
              }
            />
          </label>
          <PercentRow
            label="рост к финалу"
            value={config.addons.matchPayments.growth}
            onCommit={(v) =>
              apply((c) => {
                if (c.addons.matchPayments) c.addons.matchPayments.growth = v;
              })
            }
          />
          <PercentRow
            label="скидка нижней сетки"
            value={config.addons.matchPayments.lowerDiscount}
            onCommit={(v) =>
              apply((c) => {
                if (c.addons.matchPayments) c.addons.matchPayments.lowerDiscount = v;
              })
            }
          />
          <PriceTable prices={view?.paymentPrices ?? []} />
        </div>
      ) : null}
    </>
  );
}

// ─────────────────────────────────────────── пример: как ведут себя деньги

/**
 * Простой пример того, что собрал организатор: какая доля куда уходит и что
 * из этого увидят игроки. Считается из того же вида, что и эфир, — цифры
 * совпадают с кадром.
 */
function MoneyExample({ config, view }: { config: PrizeConfig; view: PrizeView | null }) {
  if (view === null) {
    return (
      <section className={s.group}>
        <h3 className={s.groupTitle}>Как отыграются деньги</h3>
        <div className={s.hint}>Пример появится, когда фонд пересчитается.</div>
      </section>
    );
  }

  const fund = Math.max(1, view.fundEffective);
  const share = view.engineShare;
  const parts: { label: string; amount: number; color: string }[] = [
    {
      label: ENGINE_TITLE[config.engine.kind],
      amount: share,
      color: 'var(--gold, #ffd03b)',
    },
  ];
  if (config.addons.bounty !== null) {
    parts.push({
      label: 'головы',
      amount: config.addons.bounty.amounts.reduce((a, b) => a + b, 0),
      color: 'var(--red, #ff6b6b)',
    });
  }
  if (config.addons.matchPayments !== null) {
    parts.push({ label: 'выплаты за матчи', amount: config.addons.matchPayments.amount, color: 'var(--cyan, #5bc8f5)' });
  }
  if (config.addons.rookieRace !== null) {
    parts.push({ label: 'гонка новичков', amount: config.addons.rookieRace, color: 'var(--green, #7ed957)' });
  }
  if (config.addons.spectator !== null) {
    parts.push({ label: 'зрительский банк', amount: config.addons.spectator, color: 'var(--pink, #ff6fb1)' });
  }

  // Строки-примеры: по движку и по надстройкам. Каждая — одна мысль.
  const lines: { text: string; note?: string | undefined }[] = [];
  switch (config.engine.kind) {
    case 'places':
      for (const row of view.ladder.slice(0, 3)) {
        lines.push({
          text: `${row.place} место — ${money(row.guarantee)}`,
          note: row.maxTotal > row.guarantee ? `с надстройками до ${money(row.maxTotal)}` : undefined,
        });
      }
      break;
    case 'matches':
      for (const row of view.matchPrices.slice(0, 3)) {
        lines.push({
          text: `${row.title} — победа ${money(row.price)}`,
          note: `${row.matches} ${row.matches === 1 ? 'матч' : 'матчей'}`,
        });
      }
      break;
    case 'maps':
      if (view.mapPrice !== null) {
        lines.push({
          text: `карта — ${money(view.mapPrice.loss)} · победная ${money(view.mapPrice.win)}`,
          note: 'счётчик растёт по ходу матча',
        });
      }
      if (view.spread != null) {
        lines.push({
          text: `итог от ${money(view.spread.min)} до ${money(view.spread.max)}`,
          note: 'зависит от числа взятых карт',
        });
      }
      break;
    case 'bounty':
      for (const [i, percent] of config.engine.shares.slice(0, 3).entries()) {
        lines.push({
          text: `голова ${i + 1} сида — ${money(Math.floor((share * percent) / 100))}`,
          note: i === 0 ? 'снимает победитель матча' : undefined,
        });
      }
      if (config.engine.rollover) {
        lines.push({
          text: 'перекат: половина убийце, половина — ему на голову',
          note: 'к финалу голова лидера растёт',
        });
      }
      break;
  }

  if (config.addons.matchPayments !== null && view.paymentPrices.length > 0) {
    const first = view.paymentPrices[0];
    if (first !== undefined) {
      lines.push({
        text: `+ победа в ${first.title.toLowerCase()} — ${money(first.price)}`,
        note: 'надстройка поверх движка',
      });
    }
  }
  if (config.addons.bounty !== null) {
    const head = config.addons.bounty.amounts[0] ?? 0;
    lines.push({
      text: `+ голова 1 сида — ${money(head)}`,
      note: 'снимается победой над ним',
    });
  }
  if (config.addons.rookieRace !== null) {
    lines.push({
      text: `+ новички делят ${money(config.addons.rookieRace)}`,
      note: 'отдельный зачёт в той же сетке',
    });
  }
  if (config.addons.spectator !== null) {
    lines.push({
      text: `+ лучший матч — ${money(config.addons.spectator)}`,
      note: 'отмечает хост после турнира',
    });
  }
  if (config.addons.jackpot) {
    lines.push({
      text: 'невыданный остаток переедет в следующий турнир',
      note: view.jackpotNow > 0 ? `сейчас в джекпоте ${money(view.jackpotNow)}` : undefined,
    });
  }

  const champion = view.ladder[0];

  /* Подсказки при нехватке: не «ошибка», а что сделать. Надстройки режут
     долю движка — когда она уходит в минус, у организатора есть ровно
     несколько разумных ходов, и они все перечислены. */
  const shortfall = share < 0;
  const hints: string[] = [];
  if (shortfall) {
    const overspend = Math.abs(share);
    hints.push(`надстройки просят на ${money(overspend)} больше, чем есть в фонде`);
    if (config.addons.matchPayments !== null) hints.push('уменьши долю «выплат за матчи» или сними надстройку');
    if (config.addons.rookieRace !== null) hints.push('режь «гонку новичков» — её доля задаётся руками');
    if (config.addons.spectator !== null) hints.push('уменьши «зрительский банк»');
    if (config.addons.bounty !== null) hints.push('уменьши суммы на головах');
    hints.push('или добавь в фонд — все доли пересчитаются сами');
  }

  return (
    <section className={s.group}>
      <h3 className={s.groupTitle}>Как отыграются деньги</h3>

      {/* Водопад: фонд сверху, потоки под ним с долями, остаток — внизу.
          Читается сверху вниз как рассказ: есть столько, уходит столько,
          остаётся столько. */}
      <div className={s.waterfall}>
        <div className={s.wfFund}>
          <span className={s.wfFundLabel}>фонд</span>
          <b className={s.wfFundSum}>{money(fund)}</b>
          {config.addons.jackpot && view.jackpotNow > 0 ? (
            <span className={s.wfFundNote}>джекпот вкатан: {money(view.jackpotNow)}</span>
          ) : null}
        </div>

        <div className={s.wfSplit} aria-hidden />

        <div className={s.wfStreams}>
          {parts.map((p) => (
            <div key={p.label} className={s.wfStream}>
              <span className={s.wfDot} style={{ background: p.color }} aria-hidden />
              <span className={s.wfLabel}>{p.label}</span>
              <span className={s.wfBar} aria-hidden>
                <i
                  style={{
                    width: `${Math.max(2, Math.min(100, (p.amount / fund) * 100)).toFixed(1)}%`,
                    background: p.color,
                  }}
                />
              </span>
              <b className={s.wfAmount}>{money(p.amount)}</b>
              <span className={s.wfPct}>
                {Math.round((Math.max(0, p.amount) / fund) * 100)}%
              </span>
            </div>
          ))}
        </div>

        {shortfall ? (
          <div className={s.wfRest}>
            движку не хватает {money(Math.abs(share))} — уменьши надстройки или добавь в фонд
          </div>
        ) : share > 0 ? (
          <div className={s.wfRest}>
            движку остаётся {money(share)}
            {config.addons.jackpot ? ' · невыданный остаток уедет в джекпот' : ''}
          </div>
        ) : null}
      </div>

      {hints.length > 0 ? (
        <div className={s.wfHints}>
          {hints.map((h) => (
            <div key={h}>→ {h}</div>
          ))}
        </div>
      ) : null}

      <div className={s.example}>
        {lines.length === 0 ? (
          <div className={s.hint}>Добавь движок или надстройки — пример соберётся сам.</div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className={s.exampleRow} style={{ '--i': i } as React.CSSProperties}>
              <span className={s.exampleText}>{line.text}</span>
              {line.note !== undefined ? <span className={s.exampleNote}>{line.note}</span> : null}
            </div>
          ))
        )}
        {champion !== undefined && config.engine.kind !== 'bounty' ? (
          <div className={s.exampleChamp}>
            чемпион унесёт до <b>{money(champion.maxTotal)}</b>
            <span>
              {champion.guarantee > 0
                ? `гарантия ${money(champion.guarantee)} · потолок с надстройками ${money(champion.maxTotal)}`
                : 'потолок зависит от пути по сетке'}
            </span>
          </div>
        ) : null}
        {config.engine.kind === 'bounty' ? (
          <div className={s.exampleChamp}>
            весь фонд — <b>{money(share)}</b> на головах
            <span>неснятую голову чемпиона он забирает сам</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────── мелочи

function PercentRow({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  return (
    <label className={s.addonRow}>
      <span className={s.rowName}>{label}</span>
      <span className={s.percentWrap}>
        <input
          className={s.cell}
          type="number"
          min={0}
          max={400}
          key={`pct-${label}-${value}`}
          defaultValue={value}
          onBlur={(e) => {
            const next = Math.round(Number(e.target.value));
            if (!Number.isFinite(next) || next === value) return;
            onCommit(Math.max(0, Math.min(400, next)));
          }}
        />
        <span className={s.percentSign}>%</span>
      </span>
    </label>
  );
}

/** Таблица «раунд → цена победы» — то, что видит и организатор, и игрок. */
function PriceTable({ prices }: { prices: { key: string; title: string; matches: number; price: number }[] }) {
  if (prices.length === 0) return null;
  return (
    <div className={s.rounds}>
      <div className={s.roundHead}>
        <span>Раунд</span>
        <span>Матчей</span>
        <span>Победа</span>
        <span />
      </div>
      {prices.map((r) => (
        <div key={r.key} className={s.round}>
          <span className={s.roundName} title={r.title}>
            {r.title}
          </span>
          <span className={s.roundNo}>{r.matches}</span>
          <span className={s.rowValue}>{money(r.price)}</span>
          <span />
        </div>
      ))}
    </div>
  );
}
