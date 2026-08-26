import { useEffect, useRef, useState } from 'react';
import { Button, Field, Switch } from '@/components';
import { money } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import type { PrizeConfig, PrizeEngine, PrizeView } from '@/lib/types';
import type { EditorCtx } from './Editor';
import s from './Editor.module.css';

/** Пресеты из ТЗ: одна кнопка — готовое устройство фонда. */
const PRESETS: { kind: string; title: string; note: string }[] = [
  { kind: 'pro', title: 'Про', note: 'равные силы: места и зрительский банк' },
  { kind: 'local', title: 'Локальный смешанный', note: 'профи и новички вперемешку' },
  { kind: 'rookie', title: 'Новичковый', note: 'платят почти всем, две гонки' },
  { kind: 'show', title: 'Шоу', note: 'всё ради картинки' },
];

const ENGINES: { kind: PrizeEngine['kind']; shares: number[]; title: string; note: string }[] = [
  {
    kind: 'places',
    shares: [50, 30, 20],
    title: 'Только за места',
    note: 'платят трое — за статус',
  },
  {
    kind: 'places',
    shares: [34, 24, 17, 11, 8, 6],
    title: 'За места, но шире',
    note: 'платит каждый третий — по умолчанию',
  },
  {
    kind: 'matches',
    shares: [],
    title: 'За победы в матчах',
    note: 'чем ближе к финалу, тем дороже',
  },
  {
    kind: 'maps',
    shares: [],
    title: 'За карты',
    note: 'живой счётчик на протяжении матча',
  },
];

/** Движок с нуля под кнопку пресета: скидка нижней сетки на четверых не нужна. */
function engineOf(kind: PrizeEngine['kind'], shares: number[], players: number): PrizeEngine {
  return {
    kind,
    shares: shares.length > 0 ? [...shares] : [],
    growth: 200,
    lowerDiscount: players <= 4 ? 100 : 50,
  };
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

/**
 * Призовой фонд: пресет одной кнопкой, потом сумма, потом движок — ровно
 * один, переключателем, — и под ним надстройки галочками.
 *
 * Каждая правка сразу уходит в турнир и пересчитывает проверку лестницы:
 * считать её руками организатор не должен.
 */
export function Prize({ id, t, emergency, run }: EditorCtx) {
  const [config, setConfig] = useState<PrizeConfig>(() => t.prize ?? emptyConfig(t.players.length));
  const [view, setView] = useState<PrizeView | null>(null);
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

  const share = view?.engineShare ?? 0;
  const bountyTotal = config.addons.bounty?.amounts.reduce((a, b) => a + b, 0) ?? 0;

  const underdogPossible = config.engine.kind === 'matches' || config.addons.matchPayments !== null;

  if (!has) {
    return (
      <>
        <div className={s.sub}>
          Необязательный: без фонда всё работает как раньше. Фонд считается сам и виден в эфире.
        </div>
        <div className={s.buttons}>
          <Button size="sm" variant="primary" onClick={() => apply(() => undefined)}>
            + Призовой фонд
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className={s.sub}>
        Сначала пресет одной кнопкой, потом сумма фонда, потом движок — ровно
        один, переключателем, — и под ним надстройки галочками.
      </div>

      <div className={s.group}>
        <div className={s.groupTitle}>Пресеты</div>
        <div className={s.chips}>
          {PRESETS.map((p) => (
            <button
              key={p.kind}
              className={s.chip}
              type="button"
              title={p.note}
              onClick={() => {
                // Пресет собирается тем же кодом, что и Rust.
                const fund = config.fund;
                const players = t.players.length;
                const shareOf = (part: number) => Math.round((fund * part) / 100);
                const next = clone(config);
                next.fund = fund;
                next.engine =
                  p.kind === 'pro'
                    ? engineOf('places', [50, 30, 20], players)
                    : p.kind === 'local'
                      ? engineOf('places', [34, 24, 17, 11, 8, 6], players)
                      : p.kind === 'rookie'
                        ? engineOf('matches', [], players)
                        : engineOf('maps', [], players);
                next.addons =
                  p.kind === 'pro'
                    ? { ...emptyConfig(players).addons, spectator: shareOf(10) }
                    : p.kind === 'local'
                      ? {
                          ...emptyConfig(players).addons,
                          matchPayments: {
                            amount: shareOf(25),
                            growth: 200,
                            lowerDiscount: players <= 4 ? 100 : 50,
                          },
                          bounty: {
                            amounts: [
                              Math.round((shareOf(10) * 467) / 1000),
                              Math.round((shareOf(10) * 30) / 100),
                              Math.round((shareOf(10) * 233) / 1000),
                            ],
                            rollover: false,
                          },
                          spectator: shareOf(10),
                        }
                      : p.kind === 'rookie'
                        ? { ...emptyConfig(players).addons, rookieRace: shareOf(30), underdog: true }
                        : {
                            ...emptyConfig(players).addons,
                            bounty: { amounts: [shareOf(12), shareOf(8), shareOf(5)], rollover: true },
                            spectator: shareOf(10),
                            jackpot: true,
                          };
                next.bestMatchId = null;
                const withFund = next;
                setConfig(withFund);
                run(async () => {
                  const v = await ipc.setTournamentPrize(id, withFund, emergency);
                  setView(v);
                });
              }}
            >
              {p.title}
            </button>
          ))}
        </div>
      </div>

      <div className={s.two}>
        <Field
          label="Фонд, ₽"
          type="number"
          min={0}
          step={500}
          key={`fund-${config.fund}`}
          defaultValue={config.fund}
          hint="остаток округления идёт первому месту"
          onBlur={(e) => commitNumber(e.target.value, (c, v) => (c.fund = v))}
        />
        <div className={s.fundNote}>
          <span>движку остаётся</span>
          <b className={share < 0 ? s.bad : undefined}>{money(share)}</b>
          {config.addons.jackpot && view !== null ? (
            <span>джекпот вкатан: {money(config.jackpotIn)}</span>
          ) : null}
        </div>
      </div>

      <div className={s.group}>
        <div className={s.groupTitle}>Движок</div>
        <div className={s.chips}>
          {ENGINES.map((e, i) => {
            const on =
              config.engine.kind === e.kind &&
              (e.kind !== 'places' ||
                config.engine.shares.join(',') === e.shares.join(','));
            return (
              <button
                key={i}
                className={on ? s.chipOn : s.chip}
                type="button"
                title={e.note}
                onClick={() =>
                  apply((c) => {
                    c.engine = engineOf(e.kind, e.shares, t.players.length);
                  })
                }
              >
                {e.title}
              </button>
            );
          })}
        </div>
      </div>

      {config.engine.kind === 'places' ? (
        <PlacesEditor config={config} view={view} apply={apply} commit={commitNumber} />
      ) : null}

      {config.engine.kind === 'matches' ? (
        <MatchesEditor config={config} view={view} apply={apply} />
      ) : null}

      {config.engine.kind === 'maps' ? <MapsEditor config={config} view={view} apply={apply} /> : null}

      <div className={s.group}>
        <div className={s.groupTitle}>Надстройки</div>

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
                    commitNumber(e.target.value, (c, v) => {
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
              note="Половина уходит убийце, половина переезжает ему на голову — к финалу на лидере висит заметная сумма"
            >
              Режим переката
            </Switch>
          </div>
        ) : null}

        <Switch
          checked={config.addons.matchPayments !== null}
          onChange={(v) =>
            apply((c) => {
              c.addons.matchPayments = v
                ? {
                    amount: Math.round(c.fund * 0.25),
                    growth: 200,
                    lowerDiscount: t.players.length <= 4 ? 100 : 50,
                  }
                : null;
              if (!v) c.addons.underdog = false;
            })
          }
          note="Доля фонда за победы в матчах поверх движка мест: чем ближе к финалу, тем дороже"
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
                  commitNumber(e.target.value, (c, v) => {
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
                  commitNumber(e.target.value, (c, v) => (c.addons.rookieRace = v))
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

        <Switch
          checked={config.addons.underdog}
          onChange={(v) =>
            apply((c) => {
              c.addons.underdog = v;
            })
          }
          note={
            underdogPossible
              ? 'Победа над более сильным сидом платит ступенью: ×1.5, ×2, ×3 — показывается ступенью, а не коэффициентом'
              : 'работает поверх выплат за матчи — включи движок «за победы» или надстройку выплат'
          }
        >
          Множитель за андердога
        </Switch>

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
                  commitNumber(e.target.value, (c, v) => (c.addons.spectator = v))
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
      </div>

      {/* Проверка лестницы: пересчитывается на каждую правку. */}
      {view !== null ? (
        <>
          {view.problems.map((p) => (
            <div key={p} className={s.err}>
              {p}
            </div>
          ))}
          <div className={view.check.ok ? s.ladderOk : s.err}>
            {view.check.ok ? '✓ ' : '⚠ '}
            {view.check.text}
          </div>
          {view.note !== null ? <div className={s.warn}>{view.note}</div> : null}
          <div className={s.buttons}>
            <Button size="sm" onClick={() => apply((c) => (c.fund = 0))} variant="ghost">
              Снять фонд
            </Button>
          </div>
        </>
      ) : null}
    </>
  );
}

// ───────────────────────────────────────────────────── параметры движков

interface EngineProps {
  config: PrizeConfig;
  view: PrizeView | null;
  apply: (patch: (c: PrizeConfig) => void) => void;
  commit: (raw: string, patch: (c: PrizeConfig, value: number) => void) => void;
}

/** Проценты мест с живыми суммами: видно и долю, и рубли. */
function PlacesEditor({ config, view, apply, commit }: EngineProps) {
  const shares = config.engine.shares;
  const share = view?.engineShare ?? 0;
  const sum = shares.reduce((a, b) => a + b, 0);

  return (
    <div className={s.group}>
      <div className={s.groupTitle}>Раскладка мест</div>
      <div className={s.rounds}>
        {shares.map((sharePercent, i) => {
          const amount = view?.ladder[i]?.guarantee ?? Math.floor((share * sharePercent) / 100);
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
    </div>
  );
}

/** Форма матчевых выплат: рост, скидка и честная таблица цен. */
function MatchesEditor({ config, view, apply }: Omit<EngineProps, 'commit'>) {
  return (
    <div className={s.group}>
      <div className={s.groupTitle}>Форма выплат</div>
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
        Приложение нормирует форму так, чтобы сумма по всем матчам сошлась с долей
        движка ровно.
      </div>
    </div>
  );
}

/** Цена карты: фиксированная, фонд гуляет в пределах сыгранных карт. */
function MapsEditor({ config, view, apply }: Omit<EngineProps, 'commit'>) {
  const price = view?.mapPrice ?? null;
  return (
    <div className={s.group}>
      <div className={s.groupTitle}>Цена карты</div>
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
          Разброс фонда: от {money(view.spread.min)} до {money(view.spread.max)} — итог гуляет
          в пределах числа сыгранных карт.
        </div>
      ) : null}
    </div>
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
