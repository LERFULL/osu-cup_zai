import { useCallback, useEffect, useState } from 'react';
import { Avatar, Button, Empty, MapRow, Menu, MenuItem, MenuSeparator } from '@/components';
import type { MapRowEnd } from '@/components';
import type {
  Beatmap,
  MatchRow,
  MatchState,
  ModTag,
  Pool,
  TournamentPlayer,
} from '@/lib/types';
import { coverUrl } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import s from './MatchView.module.css';

interface Props {
  id: number;
  onClose: () => void;
}

/** Строка состояния: чей ход и что он делает. */
function turnLine(m: MatchState, name: (id: number | null) => string): string {
  switch (m.phase.kind) {
    case 'notStarted':
      return m.poolId === null ? 'Выбери маппул' : 'Кто банит первым?';
    case 'ban':
      return `Ход ${name(m.phase.actor)} — бан ${Math.floor(m.phase.done / 2) + 1} из ${
        m.phase.total / 2
      }`;
    case 'pick':
      return `Ход ${name(m.phase.actor)} — пик`;
    case 'result':
      return `Кто выиграл ${m.phase.slotLabel}?`;
    case 'finished':
      return m.phase.winner === null ? 'Матч завершён' : `Победил ${name(m.phase.winner)}`;
  }
}

export function MatchView({ id, onClose }: Props) {
  const [m, setM] = useState<MatchState | null>(null);
  const [pools, setPools] = useState<Pool[]>([]);
  const [menu, setMenu] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [state, list] = await Promise.all([ipc.matchState(id), ipc.listPools()]);
      setM(state);
      setPools(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Любое действие возвращает состояние целиком — держим только его. */
  const run = useCallback(async (work: () => Promise<MatchState>) => {
    setBusy(true);
    try {
      setM(await work());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // Горячие клавиши: цифра выбирает строку, B банит, P пикает,
  // стрелки отдают карту игроку, Ctrl+Z отменяет, Esc уходит к сетке.
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (m === null) return;
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void run(() => ipc.undoMatchAction(id));
        return;
      }

      if (/^[0-9]$/.test(e.key)) {
        // 1–9 — строки по порядку, 0 — десятая.
        const index = e.key === '0' ? 9 : Number(e.key) - 1;
        if (index < m.rows.length) setCursor(index);
        return;
      }

      const row = m.rows[cursor];
      if (row === undefined) return;

      const key = e.key.toLowerCase();
      if (key === 'b' || key === 'и') {
        void run(() => ipc.banSlot(id, row.slotLabel));
      } else if (key === 'p' || key === 'з') {
        void run(() => ipc.pickSlot(id, row.slotLabel));
      } else if (e.key === 'ArrowLeft' && m.playerA !== null) {
        void run(() => ipc.recordResult(id, m.playerA as number));
      } else if (e.key === 'ArrowRight' && m.playerB !== null) {
        void run(() => ipc.recordResult(id, m.playerB as number));
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [m, cursor, id, onClose, run]);

  if (m === null) {
    return (
      <div className={s.screen}>
        <header className={s.bar}>
          <button className={s.back} onClick={onClose} type="button">
            ← К сетке
          </button>
        </header>
        <div className={s.body}>
          <Empty title={error ?? 'Читаю матч…'} />
        </div>
      </div>
    );
  }

  const state = m;
  const byId = new Map<number, TournamentPlayer>(state.players.map((p) => [p.playerId, p]));
  const name = (pid: number | null) =>
    pid === null ? '—' : (byId.get(pid)?.nickname ?? 'игрок');
  const color = (pid: number | null) =>
    pid === null ? 'var(--txt3)' : (byId.get(pid)?.color ?? 'var(--txt3)');
  const avatar = (pid: number | null) =>
    pid === null ? null : (byId.get(pid)?.avatarPath ?? null);

  const canBan = state.phase.kind === 'ban';
  const canPick = state.phase.kind === 'pick';
  const waitingResult = state.phase.kind === 'result';

  // Строки идут группами по мод-тегам — так маппул читается, а не сливается
  // в один длинный список.
  const groups: { mod: ModTag; rows: MatchRow[] }[] = [];
  for (const row of state.rows) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.mod === row.mod) last.rows.push(row);
    else groups.push({ mod: row.mod, rows: [row] });
  }

  /** Правая часть строки — состояние карты в матче. */
  function rowEnd(row: MatchRow, stars: number, map: Beatmap | null): MapRowEnd {
    switch (row.state.kind) {
      case 'banned':
        return { kind: 'ban', n: row.state.n };
      case 'played':
        return {
          kind: 'done',
          winner: name(row.state.winner),
          color: color(row.state.winner),
        };
      case 'playing':
        return { kind: 'live' };
      case 'locked':
        return { kind: 'lock', hint: row.state.hint };
      case 'free':
        return {
          kind: 'plain',
          stars,
          ...(map?.totalLength != null ? { length: map.totalLength } : {}),
          ...(map?.bpm != null ? { bpm: map.bpm } : {}),
        };
    }
  }

  return (
    <div className={s.screen}>
      <header className={s.bar}>
        <button className={s.back} onClick={onClose} type="button">
          ← К сетке
        </button>
        <span className={s.where}>
          {state.tournamentName} · раунд {state.round}
        </span>

        <div className={s.right}>
          <Button
            size="sm"
            disabled={busy || state.actions.length === 0}
            onClick={() => void run(() => ipc.undoMatchAction(id))}
            title="Отменить последнее действие (Ctrl+Z)"
          >
            ↶ Отменить
          </Button>
          <div className={s.wrap}>
            <Button size="sm" onClick={() => setMenu(menu === 'more' ? null : 'more')}>
              ⋯
            </Button>
            <Menu open={menu === 'more'} onClose={() => setMenu(null)} align="right">
              {/* Пул раздан по раунду заранее — здесь только правка,
                  если для конкретного матча нужен другой. */}
              {state.actions.length === 0
                ? pools.map((p) => (
                    <MenuItem
                      key={`pool-${p.id}`}
                      onClick={() => {
                        setMenu(null);
                        void run(() => ipc.setMatchPool(id, p.id));
                      }}
                      {...(p.id === state.poolId ? { note: 'сейчас играется этот' } : {})}
                    >
                      {p.id === state.poolId ? '✓ ' : '   '}
                      Маппул: {p.name}
                    </MenuItem>
                  ))
                : null}
              {state.actions.length === 0 && pools.length > 0 ? <MenuSeparator /> : null}

              {state.players.map((p) => (
                <MenuItem
                  key={p.playerId}
                  onClick={() => {
                    setMenu(null);
                    void run(() => ipc.setMatchWalkover(id, p.playerId));
                  }}
                  note="Карты в статистику не пойдут"
                >
                  Техническая победа: {p.nickname}
                </MenuItem>
              ))}
              <MenuSeparator />
              {state.players.map((p) => (
                <MenuItem
                  key={`manual-${p.playerId}`}
                  onClick={() => {
                    setMenu(null);
                    const raw = window.prompt(
                      `Счёт матча в формате «${name(state.playerA)}:${name(state.playerB)}», например 4:2`,
                    );
                    if (raw === null) return;
                    const [a, b] = raw.split(':').map((x) => Number(x.trim()));
                    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
                    void run(() => ipc.setMatchManualResult(id, p.playerId, a as number, b as number));
                  }}
                  note="Журнал банов и пиков будет заменён"
                >
                  Ручной счёт, победил {p.nickname}
                </MenuItem>
              ))}
            </Menu>
          </div>
        </div>
      </header>

      {error !== null ? <div className={s.error}>{error}</div> : null}

      <div className={s.body}>
        <div className={s.col}>
          <div className={s.score}>
            <div className={s.side}>
              <Avatar
                nickname={name(state.playerA)}
                color={color(state.playerA)}
                src={coverUrl(avatar(state.playerA))}
                size={44}
              />
              <span className={s.nick}>{name(state.playerA)}</span>
              {state.matchPoint.includes(state.playerA ?? -1) ? (
                <span className={s.mp}>матчпоинт</span>
              ) : null}
            </div>
            <div className={s.numbers}>
              {state.scoreA + state.bonusA} : {state.scoreB + state.bonusB}
              <span className={s.target}>
                до {state.target}
                {/* Преимущество сетки — часть счёта, но не сыгранная карта:
                    без пояснения счёт 1:0 до первой карты выглядит ошибкой. */}
                {state.bonusA + state.bonusB > 0
                  ? ` · преимущество +${state.bonusA + state.bonusB}`
                  : ''}
              </span>
            </div>
            <div className={`${s.side} ${s.sideRight}`}>
              {state.matchPoint.includes(state.playerB ?? -1) ? (
                <span className={s.mp}>матчпоинт</span>
              ) : null}
              <span className={s.nick}>{name(state.playerB)}</span>
              <Avatar
                nickname={name(state.playerB)}
                color={color(state.playerB)}
                src={coverUrl(avatar(state.playerB))}
                size={44}
              />
            </div>
          </div>

          <div className={s.turn}>{turnLine(state, name)}</div>

          {state.poolId === null ? (
            <div className={s.setup}>
              <div className={s.setupTitle}>Маппул матча</div>
              <div className={s.chips}>
                {pools.length === 0 ? (
                  <span className={s.muted}>Маппулов нет — собери хотя бы один.</span>
                ) : (
                  pools.map((p) => (
                    <button
                      key={p.id}
                      className={s.chip}
                      type="button"
                      onClick={() => void run(() => ipc.setMatchPool(id, p.id))}
                    >
                      {p.name}
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : state.firstBanBy === null ? (
            <div className={s.setup}>
              <div className={s.setupTitle}>Кто банит первым</div>
              <div className={s.chips}>
                {state.players.map((p) => (
                  <button
                    key={p.playerId}
                    className={s.chip}
                    type="button"
                    onClick={() => void run(() => ipc.setMatchFirstBan(id, p.playerId))}
                  >
                    {p.nickname}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* Лобби нужно эфиру: без него он покажет счёт по картам, но без
              очков, точности и комбо. Матчу оно не нужно вовсе, поэтому поле
              необязательное и стоит одной строкой. */}
          <div className={s.lobby}>
            <span className={s.lobbyLabel}>Лобби osu!</span>
            {state.lobbyId === null ? (
              <button
                className={s.lobbyLink}
                type="button"
                onClick={() => {
                  const raw = window.prompt(
                    'Ссылка на мультиплеерный матч или его номер. Эфир возьмёт оттуда очки, точность и комбо.',
                  );
                  if (raw === null) return;
                  const found = /(\d{5,})/.exec(raw);
                  if (found === null) {
                    setError('В этой строке нет номера матча');
                    return;
                  }
                  void run(async () => {
                    await ipc.setMatchLobby(id, Number(found[1]));
                    return ipc.matchState(id);
                  });
                }}
              >
                привязать
              </button>
            ) : (
              <>
                <span className={s.lobbyId}>{state.lobbyId}</span>
                <button
                  className={s.lobbyLink}
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      await ipc.setMatchLobby(id, null);
                      return ipc.matchState(id);
                    })
                  }
                >
                  снять
                </button>
              </>
            )}
          </div>

          <div className={s.pool}>
            {groups.map((group) => (
              <div key={group.mod} className={s.group}>
                {group.rows.map((row) => {
                  const index = state.rows.indexOf(row);
                  const clickable = row.state.kind === 'free' && (canBan || canPick) && !busy;
                  const map = row.beatmap;
                  const stars = row.starRatingWithMods ?? map?.difficultyRating ?? 0;

                  return (
                    <div
                      key={row.slotLabel}
                      className={[s.slot, index === cursor ? s.cursor : null]
                        .filter(Boolean)
                        .join(' ')}
                      onMouseEnter={() => setCursor(index)}
                    >
                      <MapRow
                        {...rowEnd(row, stars, map)}
                        cover={coverUrl(map?.coverPath)}
                        title={map === null ? 'карта не подобрана' : `${map.artist} — ${map.title}`}
                        version={map?.version ?? ''}
                        mod={row.mod}
                        slot={row.slotLabel}
                        {...(clickable
                          ? {
                              onClick: () =>
                                void run(() =>
                                  canBan
                                    ? ipc.banSlot(id, row.slotLabel)
                                    : ipc.pickSlot(id, row.slotLabel),
                                ),
                            }
                          : {})}
                        {...(clickable
                          ? {
                              tools: (
                                <Button
                                  size="sm"
                                  {...(canPick ? ({ variant: 'primary' } as const) : {})}
                                  onClick={() =>
                                    void run(() =>
                                      canBan
                                        ? ipc.banSlot(id, row.slotLabel)
                                        : ipc.pickSlot(id, row.slotLabel),
                                    )
                                  }
                                >
                                  {canBan ? 'BAN' : 'PICK'}
                                </Button>
                              ),
                            }
                          : {})}
                        {...(waitingResult && row.state.kind === 'playing'
                          ? {
                              toolsPinned: true,
                              tools: (
                                <>
                                  <span className={s.who}>кто выиграл</span>
                                  {state.players.map((p) => (
                                    <Button
                                      key={p.playerId}
                                      size="sm"
                                      variant="primary"
                                      disabled={busy}
                                      onClick={() => void run(() => ipc.recordResult(id, p.playerId))}
                                    >
                                      {p.nickname}
                                    </Button>
                                  ))}
                                </>
                              ),
                            }
                          : {})}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div className={s.keys}>
            1–9 выбрать строку · B бан · P пик · ← → победитель · Ctrl+Z отменить · Esc к сетке
          </div>
        </div>
      </div>
    </div>
  );
}
