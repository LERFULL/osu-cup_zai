import { useEffect, useState } from 'react';
import { Button, Menu, MenuItem, MenuSeparator } from '@/components';
import { plural } from '@/lib/format';
import type { EditImpact, Match, Player, Pool, TournamentPlayer } from '@/lib/types';
import * as ipc from '@/lib/ipc';
import s from './Editor.module.css';

interface Props {
  m: Match;
  players: TournamentPlayer[];
  /** Кого можно посадить вместо участника: замена работает вперёд. */
  outside: Player[];
  pools: Pool[];
  emergency: boolean;
  /** Турнир идёт или сыгран: до старта правится всё и без аварийной правки. */
  live: boolean;
  /** Название матча — то же, что подписано на сетке. */
  title: string;
  /** Зрительский банк включён: лучший матч отмечается здесь. */
  spectator: boolean;
  bestMatchId: number | null;
  onClose: () => void;
  run: (work: () => Promise<unknown>) => void;
}

/** Что за операцию подтверждаем. */
type Ask =
  | { kind: 'reset' }
  | { kind: 'walkover'; winner: TournamentPlayer }
  | { kind: 'score'; winner: TournamentPlayer };

/**
 * Меню правки матча. Состав зависит от состояния матча: у ждущего нечего
 * сносить, у сыгранного нечего начинать.
 */
export function MatchEdit({
  m,
  players,
  outside,
  pools,
  emergency,
  live,
  title,
  spectator,
  bestMatchId,
  onClose,
  run,
}: Props) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [impact, setImpact] = useState<EditImpact | null>(null);
  const [scoreA, setScoreA] = useState(String(m.scoreA));
  const [scoreB, setScoreB] = useState(String(m.scoreB));

  // Последствия считает Rust обходом сетки: список сбрасываемого нельзя
  // написать руками, его надо спросить.
  useEffect(() => {
    if (ask === null || ask.kind === 'score') {
      setImpact(null);
      return;
    }
    let alive = true;
    void ipc.matchImpact(m.id).then((got) => {
      if (alive) setImpact(got);
    });
    return () => {
      alive = false;
    };
  }, [ask, m.id]);

  const played = m.status === 'finished';
  const started = m.firstBanBy !== null || m.scoreA + m.scoreB > 0;
  // До старта турнира править нечего запрещать: сыгранного ещё нет.
  const allowed = emergency || !live;
  // Сколько кандидатов показываем в меню: на каждое место свой список,
  // и вдвое длиннее он в меню уже не читается.
  const seats = outside.slice(0, 4);
  const name = (id: number | null) =>
    players.find((p) => p.playerId === id)?.nickname ?? 'игрок';

  const locked = (key: string, label: string) => (
    <MenuItem key={key} disabled note="включи аварийную правку" onClick={() => undefined}>
      {label}
    </MenuItem>
  );

  if (ask !== null) {
    return (
      <div className={s.shade} onMouseDown={() => setAsk(null)}>
        <div className={s.dialog} onMouseDown={(e) => e.stopPropagation()}>
          {ask.kind === 'score' ? (
            <>
              <div className={s.dialogTitle}>Ручной счёт: {title}</div>
              <div className={s.impactRow}>
                Журнал банов и пиков будет заменён, а карты этого матча перестанут считаться
                по мод-тегам: журнал им больше не соответствует.
              </div>
              <div className={s.score}>
                <label className={s.scoreSide}>
                  <div className={s.sub}>{name(m.playerA)}</div>
                  <input
                    className={s.cell}
                    type="number"
                    min={0}
                    value={scoreA}
                    onChange={(e) => setScoreA(e.target.value)}
                  />
                </label>
                <label className={s.scoreSide}>
                  <div className={s.sub}>{name(m.playerB)}</div>
                  <input
                    className={s.cell}
                    type="number"
                    min={0}
                    value={scoreB}
                    onChange={(e) => setScoreB(e.target.value)}
                  />
                </label>
              </div>
              <div className={s.dialogButtons}>
                <Button size="sm" onClick={() => setAsk(null)}>
                  Отмена
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    const a = Number(scoreA);
                    const b = Number(scoreB);
                    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
                    setAsk(null);
                    onClose();
                    run(() =>
                      ipc.setMatchManualResult(m.id, ask.winner.playerId, a, b, emergency),
                    );
                  }}
                >
                  Победил {ask.winner.nickname}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className={s.dialogTitle}>
                {ask.kind === 'reset'
                  ? `Снести результат «${title}»?`
                  : `Техническая победа в «${title}»: ${ask.winner.nickname}?`}
              </div>

              <div className={s.impact}>
                {impact === null ? (
                  <div className={s.impactRow}>Считаю последствия…</div>
                ) : (
                  <>
                    {impact.matches.length > 0 ? (
                      <div className={s.impactRow}>
                        <span className={s.impactMark}>—</span>
                        сбросятся матчи: {impact.matches.join(' · ')}
                      </div>
                    ) : null}
                    {impact.returns.map((line) => (
                      <div key={line} className={s.impactRow}>
                        <span className={s.impactMark}>—</span>
                        {line}
                      </div>
                    ))}
                    {impact.players.length > 0 ? (
                      <div className={s.impactRow}>
                        <span className={s.impactMark}>—</span>
                        пересчитается статистика: {impact.players.join(', ')}
                      </div>
                    ) : null}
                    {impact.maps > 0 ? (
                      <div className={s.impactRow}>
                        <span className={s.impactMark}>—</span>
                        {impact.maps === 1 ? 'перестанет' : 'перестанут'} учитываться {impact.maps}{' '}
                        {plural(
                          impact.maps,
                          'сыгранная карта',
                          'сыгранные карты',
                          'сыгранных карт',
                        )}
                      </div>
                    ) : null}
                    {impact.reopensTournament ? (
                      <div className={s.impactRow}>
                        <span className={s.impactMark}>—</span>
                        турнир перестанет быть завершённым, места обнулятся
                      </div>
                    ) : null}
                  </>
                )}
              </div>

              <div className={s.dialogButtons}>
                <Button size="sm" onClick={() => setAsk(null)}>
                  Отмена
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    setAsk(null);
                    onClose();
                    if (ask.kind === 'reset') {
                      run(() => ipc.resetMatch(m.id, emergency));
                    } else {
                      run(() => ipc.setMatchWalkover(m.id, ask.winner.playerId, emergency));
                    }
                  }}
                >
                  {ask.kind === 'reset' ? 'Снести' : 'Засчитать'}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <Menu open onClose={onClose}>
      {/* Маппул матча правится и без аварийной правки — пока матч не начат. */}
      {!started ? (
        pools.map((p) => (
          <MenuItem
            key={p.id}
            {...(p.id === m.poolId ? { note: 'этот и играется' } : {})}
            onClick={() => {
              onClose();
              run(() => ipc.setMatchPool(m.id, p.id));
            }}
          >
            {p.id === m.poolId ? '✓ ' : ''}Маппул: {p.name}
          </MenuItem>
        ))
      ) : (
        <MenuItem disabled note="матч уже начали" onClick={() => undefined}>
          Сменить маппул
        </MenuItem>
      )}

      {spectator && played && !m.isWalkover ? (
        <>
          <MenuSeparator />
          <MenuItem
            note="зрительский банк: приз за лучший матч"
            onClick={() => {
              onClose();
              run(() =>
                ipc.setBestMatch(
                  m.tournamentId,
                  bestMatchId === m.id ? null : m.id,
                ),
              );
            }}
          >
            {bestMatchId === m.id ? '✓ ' : ''}Лучший матч вечера
          </MenuItem>
        </>
      ) : null}

      <MenuSeparator />

      {played ? (
        <>
          {players.map((p) =>
            allowed ? (
              <MenuItem
                key={`score-${p.playerId}`}
                note={m.winnerId === p.playerId ? 'изменить счёт' : 'сменить победителя'}
                onClick={() => {
                  setScoreA(String(m.scoreA));
                  setScoreB(String(m.scoreB));
                  setAsk({ kind: 'score', winner: p });
                }}
              >
                Ручной счёт, победил {p.nickname}
              </MenuItem>
            ) : (
              locked(`score-${p.playerId}`, `Ручной счёт, победил ${p.nickname}`)
            ),
          )}
          <MenuSeparator />
          {allowed ? (
            <MenuItem
              danger
              note={m.isWalkover ? 'снять техпобеду' : 'матчи ниже по сетке сбросятся'}
              onClick={() => setAsk({ kind: 'reset' })}
            >
              {m.isWalkover ? 'Снять техническую победу' : 'Снести и переиграть'}
            </MenuItem>
          ) : (
            locked('reset', 'Снести и переиграть')
          )}
        </>
      ) : (
        <>
          {players.map((p) =>
            allowed ? (
              <MenuItem
                key={`wo-${p.playerId}`}
                note="карты в статистику не пойдут"
                onClick={() => setAsk({ kind: 'walkover', winner: p })}
              >
                Техническая победа: {p.nickname}
              </MenuItem>
            ) : (
              locked(`wo-${p.playerId}`, `Техническая победа: ${p.nickname}`)
            ),
          )}

          {allowed && started ? (
            <>
              <MenuSeparator />
              {players.map((p) => (
                <MenuItem
                  key={`manual-${p.playerId}`}
                  note="журнал банов и пиков будет заменён"
                  onClick={() => setAsk({ kind: 'score', winner: p })}
                >
                  Завершить с ручным счётом: {p.nickname}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem danger note="журнал матча удалится" onClick={() => setAsk({ kind: 'reset' })}>
                Снести и переиграть
              </MenuItem>
            </>
          ) : null}

          {/* Посадить игрока вручную: только пока в матче не начали играть. */}
          {allowed && !started ? (
            <>
              <MenuSeparator />
              {(['a', 'b'] as const).flatMap((slot) =>
                seats.map((other) => (
                  <MenuItem
                    key={`seat-${slot}-${other.id}`}
                    note={`вместо ${name(slot === 'a' ? m.playerA : m.playerB)}`}
                    onClick={() => {
                      onClose();
                      run(() => ipc.replaceMatchPlayer(m.id, slot, other.id, emergency));
                    }}
                  >
                    Посадить {other.nickname}
                  </MenuItem>
                )),
              )}
              {/* Меню не резиновое: остальных сажаем из раздела «Участники»,
                  и об этом лучше сказать, чем молча оборвать список. */}
              {outside.length > seats.length ? (
                <MenuItem
                  disabled
                  note="остальные — в разделе «Участники»"
                  onClick={() => undefined}
                >
                  …и ещё {outside.length - seats.length}
                </MenuItem>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </Menu>
  );
}
