import { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Field, Switch } from '@/components';
import type { Bracket, Player, Pool } from '@/lib/types';
import * as ipc from '@/lib/ipc';
import { BracketView } from './BracketView';
import { MatchView } from './MatchView';
import s from './TournamentView.module.css';

interface Props {
  id: number;
  onClose: () => void;
}

/**
 * Экран турнира. Пока сетка не построена — сборка состава; после — сама
 * сетка. Открытый матч занимает экран целиком: во время игры ничего,
 * кроме него, не нужно.
 */
export function TournamentView({ id, onClose }: Props) {
  const [bracket, setBracket] = useState<Bracket | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [match, setMatch] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [b, ps, pl] = await Promise.all([
        ipc.tournamentBracket(id),
        ipc.listPlayers(false),
        ipc.listPools(),
      ]);
      setBracket(b);
      setPlayers(ps);
      setPools(pl);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (match !== null) {
    return (
      <MatchView
        id={match}
        onClose={() => {
          setMatch(null);
          void reload();
        }}
      />
    );
  }

  if (bracket === null) {
    return (
      <div className={s.screen}>
        <header className={s.bar}>
          <button className={s.back} onClick={onClose} type="button">
            ← Турниры
          </button>
        </header>
        <div className={s.body}>
          <Empty title={error ?? 'Читаю турнир…'} />
        </div>
      </div>
    );
  }

  const t = bracket;
  const inTournament = new Set(t.players.map((p) => p.playerId));
  const draft = t.status === 'draft';

  async function guard(work: () => Promise<unknown>) {
    try {
      await work();
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className={s.screen}>
      <header className={s.bar}>
        <button className={s.back} onClick={onClose} type="button">
          ← Турниры
        </button>
        <h1 className={s.h1}>{t.name}</h1>
        <span className={s.sub}>
          {draft
            ? `${t.players.length} игроков · ${t.poolIds.length} маппулов`
            : `сетка на ${t.bracketSize} · до ${t.targetScore.default} побед`}
        </span>

        <div className={s.right}>
          {draft ? (
            <Button
              variant="primary"
              disabled={t.players.length < 2 || t.poolIds.length === 0}
              onClick={() => void guard(() => ipc.startTournament(id))}
            >
              Построить сетку
            </Button>
          ) : null}
        </div>
      </header>

      {error !== null ? <div className={s.error}>{error}</div> : null}

      <div className={s.body}>
        {draft ? (
          <div className={s.col}>
            <section className={s.block}>
              <div className={s.blockTitle}>Правила</div>
              <div className={s.rules}>
                <Field
                  label="До скольких побед"
                  type="number"
                  min={1}
                  max={16}
                  defaultValue={t.targetScore.default}
                  onBlur={(e) => {
                    const value = Number(e.target.value);
                    if (!Number.isFinite(value) || value < 1) return;
                    void guard(() =>
                      ipc.setTournamentRules(
                        id,
                        { default: value, rounds: t.targetScore.rounds },
                        t.bansPerRound,
                        t.firstBan,
                        t.noRepeatPool,
                      ),
                    );
                  }}
                />
                <Field
                  label="Банов на игрока"
                  type="number"
                  min={0}
                  max={8}
                  defaultValue={t.bansPerRound.default}
                  onBlur={(e) => {
                    const value = Number(e.target.value);
                    if (!Number.isFinite(value) || value < 0) return;
                    void guard(() =>
                      ipc.setTournamentRules(
                        id,
                        t.targetScore,
                        { default: value, rounds: t.bansPerRound.rounds },
                        t.firstBan,
                        t.noRepeatPool,
                      ),
                    );
                  }}
                />
              </div>

              <div className={s.switchRow}>
                <Switch
                  checked={t.noRepeatPool}
                  onChange={(next) =>
                    void guard(() =>
                      ipc.setTournamentRules(
                        id,
                        t.targetScore,
                        t.bansPerRound,
                        t.firstBan,
                        next,
                      ),
                    )
                  }
                  note="Пока не сыграны все, маппул не повторится"
                >
                  Не повторять маппулы
                </Switch>
              </div>
            </section>

            <section className={s.block}>
              <div className={s.blockTitle}>Маппулы</div>
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
                          void guard(() =>
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
            </section>

            <section className={s.block}>
              <div className={s.blockTitle}>
                Участники
                <span className={s.hint}>порядок задаёт сеяние</span>
              </div>

              {t.players.length === 0 ? (
                <div className={s.muted}>Никого нет — добавь игроков ниже.</div>
              ) : (
                <div className={s.seeds}>
                  {t.players.map((p, i) => (
                    <div key={p.playerId} className={s.seed}>
                      <span className={s.seedNo}>{i + 1}</span>
                      <span className={s.dot} style={{ background: p.color }} aria-hidden />
                      <span className={s.seedName}>{p.nickname}</span>
                      <button
                        className={s.x}
                        type="button"
                        aria-label="Убрать из турнира"
                        onClick={() =>
                          void guard(() => ipc.removeTournamentPlayer(id, p.playerId))
                        }
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className={s.pickers}>
                {players
                  .filter((p) => !inTournament.has(p.id))
                  .map((p) => (
                    <button
                      key={p.id}
                      className={s.chip}
                      type="button"
                      onClick={() => void guard(() => ipc.addTournamentPlayer(id, p.id))}
                    >
                      + {p.nickname}
                    </button>
                  ))}
              </div>
            </section>
          </div>
        ) : (
          <BracketView bracket={t} onOpenMatch={setMatch} />
        )}
      </div>
    </div>
  );
}
