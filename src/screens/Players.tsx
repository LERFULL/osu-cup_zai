import { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Menu, MenuItem, MenuSeparator, Switch } from '@/components';
import type { Player } from '@/lib/types';
import { coverUrl } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import { PlayerCard } from './players/PlayerCard';
import s from './Players.module.css';

export default function Players() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [menu, setMenu] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setPlayers(await ipc.listPlayers(showArchived));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [showArchived]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Аватар в профиле меняют когда угодно — раз в неделю перекачиваем его
  // сами. Список уже показан, обновление доезжает следом и молча: без
  // сети аватары просто останутся прежними.
  useEffect(() => {
    let alive = true;
    void ipc
      .refreshPlayerAvatars(showArchived)
      .then((fresh) => {
        if (alive) setPlayers(fresh);
      })
      .catch(() => {
        // Молчим намеренно: не та задача, ради которой стоит ругаться.
      });
    return () => {
      alive = false;
    };
  }, [showArchived]);

  if (open !== null) {
    return (
      <PlayerCard
        id={open}
        onClose={() => {
          setOpen(null);
          void reload();
        }}
      />
    );
  }

  async function add() {
    const nickname = window.prompt('Ник игрока');
    if (nickname === null || nickname.trim() === '') return;
    try {
      const made = await ipc.createPlayer(nickname.trim());
      await reload();
      setOpen(made.id);
    } catch (e) {
      setError(String(e));
    }
  }

  async function archive(p: Player) {
    setMenu(null);
    await ipc.archivePlayer(p.id, !p.isArchived);
    await reload();
  }

  async function remove(p: Player) {
    setMenu(null);
    const ok = window.confirm(
      `Удалить ${p.nickname} без следа? Если игрок уже участвовал в турнирах, лучше убрать в архив — история останется читаемой.`,
    );
    if (!ok) return;
    try {
      await ipc.deletePlayer(p.id);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className={s.screen}>
      <div className={s.bar}>
        <h1 className={s.h1}>Игроки</h1>
        <div className={s.right}>
          <Switch checked={showArchived} onChange={setShowArchived}>
            С архивом
          </Switch>
          <Button onClick={() => void add()}>Добавить игрока</Button>
        </div>
      </div>

      {error !== null && <div className={s.error}>{error}</div>}

      <div className={s.body}>
        {players.length === 0 ? (
          <Empty
            title="Пока никого"
            note="Добавьте игроков — они понадобятся, чтобы собрать турнирную сетку."
            actions={<Button onClick={() => void add()}>Добавить игрока</Button>}
          />
        ) : (
          <div className={s.grid}>
            {players.map((p) => (
              <div
                key={p.id}
                className={p.isArchived ? `${s.card} ${s.archived}` : s.card}
                onClick={() => setOpen(p.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setOpen(p.id);
                }}
                role="button"
                tabIndex={0}
              >
                {p.avatarPath !== null ? (
                  <img
                    className={s.avatar}
                    src={coverUrl(p.avatarPath) ?? ''}
                    alt=""
                    style={{ borderColor: p.color }}
                  />
                ) : (
                  <span className={s.dot} style={{ background: p.color }} aria-hidden />
                )}
                <span className={s.nick}>{p.nickname}</span>
                {p.osuUserId !== null && <span className={s.osu}>osu! {p.osuUserId}</span>}
                {p.isArchived && <span className={s.tag}>в архиве</span>}
                <button
                  className={s.more}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu(menu === p.id ? null : p.id);
                  }}
                  type="button"
                  aria-label="Ещё"
                >
                  ⋯
                </button>
                <Menu open={menu === p.id} onClose={() => setMenu(null)} align="right">
                  <MenuItem onClick={() => setOpen(p.id)}>Открыть</MenuItem>
                  <MenuItem onClick={() => void archive(p)}>
                    {p.isArchived ? 'Вернуть из архива' : 'В архив'}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    danger
                    note="История матчей тоже пропадёт"
                    onClick={() => void remove(p)}
                  >
                    Удалить
                  </MenuItem>
                </Menu>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
