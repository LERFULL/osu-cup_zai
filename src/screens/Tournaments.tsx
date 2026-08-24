import { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Menu, MenuItem, MenuSeparator } from '@/components';
import type { Tournament } from '@/lib/types';
import * as ipc from '@/lib/ipc';
import { TournamentView } from './tournaments/TournamentView';
import s from './Tournaments.module.css';

const STATUS_LABEL: Record<Tournament['status'], string> = {
  draft: 'черновик',
  seeded: 'сетка готова',
  running: 'идёт',
  stopped: 'остановлен',
  finished: 'завершён',
};

/** Сводка турнира одной строкой: состав и стадия. */
function shape(t: Tournament): string {
  // Размер сетки не показываем: он округлён вверх до степени двойки, и
  // «3 игрока · сетка на 4» читается как ошибка, а не как устройство сетки.
  const parts = [`${t.players.length} игроков`];
  parts.push(`до ${t.targetScore.default} побед`);
  if (t.poolIds.length > 0) parts.push(`${t.poolIds.length} маппулов`);
  return parts.join(' · ');
}

export default function Tournaments() {
  const [items, setItems] = useState<Tournament[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [menu, setMenu] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setItems(await ipc.listTournaments());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (open !== null) {
    return (
      <TournamentView
        id={open}
        onClose={() => {
          setOpen(null);
          void reload();
        }}
      />
    );
  }

  async function create() {
    const name = window.prompt('Название турнира', 'Новый кубок');
    if (name === null || name.trim() === '') return;
    try {
      // Значения по умолчанию правятся на экране турнира — здесь не спрашиваем,
      // чтобы создание оставалось одним движением.
      const made = await ipc.createTournament(name.trim(), 4, 1);
      await reload();
      setOpen(made.id);
    } catch (e) {
      setError(String(e));
    }
  }

  async function rename(t: Tournament) {
    setMenu(null);
    const name = window.prompt('Новое название', t.name);
    if (name === null || name.trim() === '') return;
    await ipc.renameTournament(t.id, name.trim());
    await reload();
  }

  async function remove(t: Tournament) {
    setMenu(null);
    if (!window.confirm(`Удалить «${t.name}»? Сетка и результаты матчей пропадут.`)) return;
    await ipc.deleteTournament(t.id);
    await reload();
  }

  const live = items.filter((t) => t.status !== 'finished');
  const done = items.filter((t) => t.status === 'finished');

  const card = (t: Tournament) => (
    <div key={t.id} className={s.card}>
      <div className={s.text}>
        <div className={s.name}>
          {t.name}
          <span className={t.status === 'running' ? s.running : s.status}>
            {STATUS_LABEL[t.status]}
          </span>
        </div>
        <div className={s.shape}>{shape(t)}</div>
      </div>

      <div className={s.actions}>
        <Button
          size="sm"
          {...(t.status === 'running' ? ({ variant: 'primary' } as const) : {})}
          onClick={() => setOpen(t.id)}
        >
          {t.status === 'draft'
            ? 'Собрать'
            : t.status === 'seeded'
              ? 'Проверить сетку'
              : t.status === 'stopped'
                ? 'Продолжить'
                : 'Открыть'}
        </Button>
        <button
          className={s.more}
          onClick={() => setMenu(menu === t.id ? null : t.id)}
          type="button"
          aria-label="Действия"
        >
          ⋯
        </button>
        <Menu open={menu === t.id} onClose={() => setMenu(null)} align="right">
          <MenuItem onClick={() => void rename(t)}>Переименовать</MenuItem>
          <MenuSeparator />
          <MenuItem danger note="Вместе с сеткой и матчами" onClick={() => void remove(t)}>
            Удалить
          </MenuItem>
        </Menu>
      </div>
    </div>
  );

  return (
    <div className={s.screen}>
      <header className={s.bar}>
        <h1 className={s.h1}>Турниры</h1>
        <div className={s.right}>
          <Button variant="primary" onClick={() => void create()}>
            + Новый турнир
          </Button>
        </div>
      </header>

      <div className={s.body}>
        <div className={s.col}>
          {error !== null ? <Empty title="Не получилось прочитать турниры" note={error} /> : null}

          {items.length === 0 ? (
            <Empty
              title="Турниров пока нет"
              note="Собери сетку из игроков и маппулов — приложение поведёт матчи по ней."
              actions={
                <Button variant="primary" onClick={() => void create()}>
                  Новый турнир
                </Button>
              }
            />
          ) : (
            <>
              {live.map(card)}
              {done.length > 0 ? (
                <>
                  <div className={s.head}>Завершённые</div>
                  {done.map(card)}
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
