import { useCallback, useMemo, useState } from 'react';
import { Button, Menu, MenuItem } from '@/components';
import { COLORS } from '@/lib/colors';
import type { TournamentPlayer } from '@/lib/types';
import { useReorder } from '@/lib/useReorder';
import * as ipc from '@/lib/ipc';
import type { EditorCtx } from './Editor';
import s from './Editor.module.css';

/**
 * Состав. Порядок в списке — и есть сеяние, поэтому перетаскивание сразу
 * уходит в турнир, а не в отдельную кнопку «сохранить».
 */
export function Roster({ id, t, state, emergency, players, run }: EditorCtx) {
  const [menu, setMenu] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const inside = useMemo(() => new Set(t.players.map((p) => p.playerId)), [t.players]);
  const byeSeeds = useMemo(() => new Set(state.byes.map((b) => b.seed)), [state.byes]);
  const taken = useMemo(
    () => new Set(t.players.map((p) => p.color.toLowerCase())),
    [t.players],
  );

  const order = t.players.map((p) => p.playerId);
  const onDrop = useCallback(
    (from: number, to: number) => {
      const next = [...order];
      const moved = next.splice(from, 1)[0];
      if (moved === undefined) return;
      next.splice(to, 0, moved);
      run(() => ipc.setTournamentSeeds(id, next, emergency));
    },
    // order собирается заново на каждом чтении турнира, поэтому сравниваем
    // его по составу, а не по ссылке.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, emergency, order.join(','), run],
  );

  const reorder = useReorder({ count: t.players.length, onDrop });

  // До старта турнира сыгранного нет, и запрещать замену незачем.
  const live = t.status === 'running' || t.status === 'finished';
  const allowed = emergency || !live;

  /** Кого можно посадить вместо участника: замена работает вперёд. */
  const outside = players.filter((p) => !inside.has(p.id));

  /** Первый неначатый матч игрока — туда и садится заменяющий. */
  const seatOf = (playerId: number) => {
    const m = t.matches.find(
      (x) =>
        x.status !== 'finished' &&
        x.firstBanBy === null &&
        (x.playerA === playerId || x.playerB === playerId),
    );
    if (m === undefined) return null;
    return { matchId: m.id, slot: m.playerA === playerId ? ('a' as const) : ('b' as const) };
  };

  const found = outside.filter((p) =>
    query.trim() === '' ? true : p.nickname.toLowerCase().includes(query.trim().toLowerCase()),
  );

  function create() {
    const nickname = window.prompt('Ник игрока');
    if (nickname === null || nickname.trim() === '') return;
    run(async () => {
      const made = await ipc.createPlayer(nickname.trim());
      await ipc.addTournamentPlayer(id, made.id, emergency);
    });
  }

  const row = (p: TournamentPlayer, i: number) => {
    const seed = p.seed ?? i + 1;
    const swap = seatOf(p.playerId);

    return (
      <div key={p.playerId} className={s.seed} data-row style={reorder.rowStyle(i)}>
        <span className={s.grip} aria-hidden {...reorder.handleProps(i)}>
          ⋮⋮
        </span>
        <span className={s.seedNo}>{seed}</span>

        <div className={s.wrap}>
          <button
            className={s.dot}
            style={{ background: p.color }}
            type="button"
            aria-label="Цвет игрока"
            onClick={() => setMenu(menu === `color-${p.playerId}` ? null : `color-${p.playerId}`)}
          />
          <Menu open={menu === `color-${p.playerId}`} onClose={() => setMenu(null)}>
            <div className={s.palette}>
              {COLORS.map((color) => {
                const own = color.toLowerCase() === p.color.toLowerCase();
                const busy = taken.has(color.toLowerCase()) && !own;
                return (
                  <button
                    key={color}
                    className={[s.swatch, busy ? s.swatchTaken : null, own ? s.swatchOn : null]
                      .filter(Boolean)
                      .join(' ')}
                    style={{ background: color }}
                    type="button"
                    title={own ? 'этот цвет и стоит' : busy ? 'цвет занят' : color}
                    onClick={() => {
                      setMenu(null);
                      // Тот же цвет — не правка: журнал вмешательств не должен
                      // пухнуть от нажатий, которые ничего не изменили.
                      if (own) return;
                      run(() => ipc.setTournamentPlayerColor(id, p.playerId, color));
                    }}
                  />
                );
              })}
            </div>
          </Menu>
        </div>

        <span className={s.seedName}>{p.nickname}</span>
        {byeSeeds.has(seed) ? <span className={s.bye}>без игры</span> : null}

        <button
          className={p.isRookie ? s.rookieOn : s.rookie}
          type="button"
          title="Новичок — играет во второй гонке призового фонда, если она включена"
          onClick={() => run(() => ipc.setPlayerRookie(id, p.playerId, !p.isRookie))}
        >
          новичок
        </button>

        <div className={s.wrap}>
          <button
            className={s.more}
            type="button"
            aria-label="Действия"
            onClick={() => setMenu(menu === `more-${p.playerId}` ? null : `more-${p.playerId}`)}
          >
            ⋯
          </button>
          <Menu open={menu === `more-${p.playerId}`} onClose={() => setMenu(null)} align="right">
            {!allowed ? (
              <MenuItem disabled note="включи аварийную правку" onClick={() => undefined}>
                Заменить участника
              </MenuItem>
            ) : swap === null ? (
              <MenuItem disabled note="все его матчи уже начаты" onClick={() => undefined}>
                Заменить участника
              </MenuItem>
            ) : outside.length === 0 ? (
              <MenuItem disabled note="свободных игроков нет" onClick={() => undefined}>
                Заменить участника
              </MenuItem>
            ) : (
              outside.slice(0, 12).map((other) => (
                <MenuItem
                  key={other.id}
                  note="сыгранные матчи останутся за прежним игроком"
                  onClick={() => {
                    setMenu(null);
                    run(() =>
                      ipc.replaceMatchPlayer(swap.matchId, swap.slot, other.id, emergency),
                    );
                  }}
                >
                  Вместо него играет {other.nickname}
                </MenuItem>
              ))
            )}
          </Menu>
        </div>

        <button
          className={s.x}
          type="button"
          aria-label="Убрать из турнира"
          onClick={() => run(() => ipc.removeTournamentPlayer(id, p.playerId, emergency))}
        >
          ✕
        </button>
      </div>
    );
  };

  return (
    <>
      <div className={s.sub}>Порядок в списке задаёт сеяние — перетаскивай строки.</div>

      {t.players.length === 0 ? (
        <div className={s.muted}>Никого нет — найди игроков ниже.</div>
      ) : (
        <div className={s.seeds}>{t.players.map(row)}</div>
      )}

      {state.checks
        .filter((c) => c.section === 'players')
        .map((c) => (
          <div key={c.text} className={c.blocking ? s.err : s.warn}>
            {c.text}
          </div>
        ))}

      <div className={s.search}>
        <input
          className={s.cell}
          style={{ textAlign: 'left', padding: '7px 9px' }}
          type="search"
          value={query}
          placeholder="Найти игрока"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className={s.found}>
          {found.slice(0, 30).map((p) => (
            <button
              key={p.id}
              className={s.add}
              type="button"
              onClick={() => run(() => ipc.addTournamentPlayer(id, p.id, emergency))}
            >
              <span className={s.dot} style={{ background: p.color }} aria-hidden />+ {p.nickname}
            </button>
          ))}
        </div>
      </div>

      <div className={s.buttons}>
        <Button size="sm" onClick={create}>
          + Создать игрока
        </Button>
      </div>
    </>
  );
}
