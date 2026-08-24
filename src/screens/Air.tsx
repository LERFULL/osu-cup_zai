// Экран эфира. Пульт и матч живут на разных экранах: правка эфира не должна
// мешать вести матч, а метка «Эфир» видна на обоих.

import { useEffect, useState } from 'react';
import { Button, Empty } from '@/components';
import { useAir } from '@/lib/air/store';
import * as ipc from '@/lib/ipc';
import type { Tournament } from '@/lib/types';
import { Live } from './air/Live';
import { Setup } from './air/Setup';
import s from './Air.module.css';

export default function Air() {
  const air = useAir();
  const [list, setList] = useState<Tournament[]>([]);
  const [failed, setFailed] = useState<string | null>(null);

  // Один раз при открытии. Стор берём через `getState`, а не из хука: иначе
  // эффект зависел бы от состояния, которое сам же и меняет.
  useEffect(() => {
    void (async () => {
      try {
        const all = await ipc.listTournaments();
        setList(all);
        setFailed(null);

        // Если эфир уже идёт, пульт открывается на его турнире, а не на выборе:
        // эфир один на приложение, и выбирать тут нечего.
        const status = await ipc.airStatus();
        const pick = status.tournamentId ?? all.find((t) => t.status === 'running')?.id ?? null;
        if (pick !== null) await useAir.getState().load(pick);
      } catch (e) {
        setFailed(String(e));
      }
    })();
  }, []);

  const live = air.status?.live === true;
  const chosen = list.find((t) => t.id === air.tournamentId) ?? null;

  if (failed !== null) {
    return (
      <div className={s.screen}>
        <Empty title="Не получилось прочитать турниры" note={failed} />
      </div>
    );
  }

  // Выбор турнира. Живой эфир его не предлагает: он уже привязан.
  if (chosen === null || (!live && air.tournamentId === null)) {
    const playable = list.filter((t) => t.status === 'running' || t.status === 'seeded');

    return (
      <div className={s.screen}>
        <header className={s.bar}>
          <h1 className={s.h1}>Эфир</h1>
        </header>
        <div className={s.body}>
          <div className={s.col}>
            {playable.length === 0 ? (
              <Empty
                title="Эфир нечего показывать"
                note="Собери сетку и запусти турнир — тогда эфиру будет что транслировать."
              />
            ) : (
              <>
                <div className={s.pickHead}>По какому турниру ведём эфир</div>
                {playable.map((t) => (
                  <button
                    key={t.id}
                    className={s.pick}
                    type="button"
                    onClick={() => void air.load(t.id)}
                  >
                    <span className={s.pickName}>{t.name}</span>
                    <span className={s.pickNote}>
                      {t.players.length} игроков ·{' '}
                      {t.status === 'running' ? 'идёт' : 'сетка готова'}
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={s.screen}>
      <header className={s.bar}>
        <h1 className={s.h1}>Эфир</h1>
        <span className={s.where}>{chosen.name}</span>
        {live ? (
          <span className={s.mark}>
            <i aria-hidden /> в эфире
          </span>
        ) : null}

        <div className={s.right}>
          {!live ? (
            <Button size="sm" onClick={() => air.reset()}>
              Другой турнир
            </Button>
          ) : null}
        </div>
      </header>

      <div className={s.body}>
        <div className={live ? s.wide : s.col}>{live ? <Live /> : <Setup />}</div>
      </div>
    </div>
  );
}
