import { useState } from 'react';
import { Button, Menu, MenuItem, MenuSeparator, Switch } from '@/components';
import * as ipc from '@/lib/ipc';
import type { EditorCtx } from './Editor';
import s from './Editor.module.css';

/**
 * Маппулы турнира и их привязка к раундам.
 *
 * По умолчанию раунд играет «любым свободным» — пулы идут по кругу. Выбор
 * конкретного фиксирует его за раундом и выводит из круга: привязка сильнее
 * общего правила.
 */
export function Pools({ id, t, state, pools, series, run }: EditorCtx) {
  const [menu, setMenu] = useState<string | null>(null);

  const withSeries = series.filter((x) => x.pools.length > 0);
  const name = (poolId: number) => pools.find((p) => p.id === poolId)?.name ?? `маппул ${poolId}`;

  // Тексты проверок, которые уже показаны блоком пересечений.
  const fromOverlap = new Set(state.overlaps.map((o) => `${o.name}: ${o.pools.join(' и ')}`));

  return (
    <>
      {pools.length === 0 ? (
        <div className={s.muted}>Сначала собери хотя бы один маппул.</div>
      ) : (
        <div className={s.chips}>
          {pools.map((p) => {
            const on = t.poolIds.includes(p.id);
            return (
              <button
                key={p.id}
                className={on ? s.chipOn : s.chip}
                type="button"
                onClick={() =>
                  run(() =>
                    ipc.setTournamentPools(
                      id,
                      on ? t.poolIds.filter((x) => x !== p.id) : [...t.poolIds, p.id],
                    ),
                  )
                }
              >
                {p.name}
              </button>
            );
          })}
        </div>
      )}

      <div className={s.buttons}>
        <div className={s.wrap}>
          <Button
            size="sm"
            disabled={withSeries.length === 0}
            title={
              withSeries.length === 0
                ? 'Серий с маппулами пока нет'
                : 'Взять маппулы серии по порядку и разложить по раундам'
            }
            onClick={() => setMenu(menu === 'series' ? null : 'series')}
          >
            + Добавить серию
          </Button>
          <Menu open={menu === 'series'} onClose={() => setMenu(null)}>
            {withSeries.map((x) => (
              <MenuItem
                key={x.id}
                note={
                  x.tournamentId === id
                    ? `привязана, ${x.pools.length} маппулов`
                    : `${x.pools.length} маппулов по порядку`
                }
                onClick={() => {
                  setMenu(null);
                  run(async () => {
                    await ipc.addTournamentSeries(id, x.id);
                    // Серия привязывается к турниру в обе стороны: из серии
                    // и из турнира — связь одна.
                    if (x.tournamentId !== id) {
                      await ipc.setSeriesTournament(x.id, id).catch(() => undefined);
                    }
                  });
                }}
              >
                {x.name}
              </MenuItem>
            ))}
          </Menu>
        </div>
      </div>

      <div className={s.group}>
        <Switch
          checked={t.noRepeatPool}
          onChange={(next) =>
            run(() =>
              ipc.setTournamentRules(id, t.targetScore, t.bansPerRound, t.firstBan, next),
            )
          }
          note="Пока не сыграны все, маппул не повторится"
        >
          Не повторять маппул
        </Switch>
      </div>

      <div className={s.group}>
        <div className={s.groupTitle}>Маппул по раундам</div>
        {state.rounds.length === 0 ? (
          <div className={s.muted}>Раунды появятся вместе с составом.</div>
        ) : (
          state.rounds.map((round) => (
            <div key={round.key} className={s.bind}>
              <span className={s.bindName}>{round.title}</span>

              <div className={s.wrap}>
                <button
                  className={round.poolId === null ? s.pick : `${s.pick} ${s.pickOn}`}
                  type="button"
                  title={
                    round.poolId === null && round.playingPoolName !== null
                      ? `по кругу достанется «${round.playingPoolName}»`
                      : undefined
                  }
                  onClick={() => setMenu(menu === round.key ? null : round.key)}
                >
                  {round.poolId === null
                    ? round.playingPoolName === null
                      ? 'маппулов нет'
                      : 'любой свободный'
                    : name(round.poolId)}
                </button>
                <Menu open={menu === round.key} onClose={() => setMenu(null)} align="right">
                  <MenuItem
                    note="маппулы пойдут по кругу"
                    onClick={() => {
                      setMenu(null);
                      run(() => ipc.setTournamentRoundPool(id, round.key, null));
                    }}
                  >
                    {round.poolId === null ? '✓ ' : ''}Любой свободный
                  </MenuItem>
                  <MenuSeparator />
                  {pools.map((p) => (
                    <MenuItem
                      key={p.id}
                      onClick={() => {
                        setMenu(null);
                        run(() => ipc.setTournamentRoundPool(id, round.key, p.id));
                      }}
                    >
                      {round.poolId === p.id ? '✓ ' : ''}
                      {p.name}
                    </MenuItem>
                  ))}
                </Menu>
              </div>

              {round.poolId !== null ? (
                <button
                  className={s.x}
                  type="button"
                  aria-label="Снять привязку"
                  onClick={() => run(() => ipc.setTournamentRoundPool(id, round.key, null))}
                >
                  ✕
                </button>
              ) : (
                <span />
              )}
            </div>
          ))
        )}
      </div>

      {state.overlaps.length > 0 ? (
        <div className={s.warn}>
          Карты встречаются в двух маппулах турнира — их разыграют дважды:
          {state.overlaps.map((o) => (
            <div key={o.beatmapId}>
              {o.name}: {o.pools.join(' и ')}
            </div>
          ))}
        </div>
      ) : null}

      {/* Пересечения карт уже показаны выше своим блоком — второй раз
          тем же текстом не повторяем. */}
      {state.checks
        .filter((c) => c.section === 'pools' && !fromOverlap.has(c.text))
        .map((c) => (
          <div key={c.text} className={c.blocking ? s.err : s.warn}>
            {c.text}
          </div>
        ))}
    </>
  );
}
