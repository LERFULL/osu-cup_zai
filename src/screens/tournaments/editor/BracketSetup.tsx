import { Button, Field } from '@/components';
import { plural } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import type { EditorCtx } from './Editor';
import s from './Editor.module.css';

/**
 * Сетка. Число игроков не выбирается — оно равно составу, поэтому здесь
 * только то, что от состава не следует: bye, преимущество сетки и пересборка.
 */
export function BracketSetup({ id, t, state, emergency, run }: EditorCtx) {
  const total = state.matchesTotal > 0 ? state.matchesTotal : state.projectedMatches;
  const live = t.status === 'running' || t.status === 'finished';
  const target = t.targetScore.rounds['grand:1'] ?? t.targetScore.default;

  return (
    <>
      <div className={s.sub}>
        {t.players.length < 2
          ? 'Меньше двух игроков — сетки не будет.'
          : `${t.players.length} игроков — двойная сетка, ${total} ` +
            plural(total, 'матч', 'матча', 'матчей')}
      </div>

      {state.byes.length > 0 ? (
        <div className={s.group}>
          <div className={s.groupTitle}>Без игры в первом раунде</div>
          {state.byes.map((bye) => (
            <div key={bye.seed} className={s.row}>
              <span className={s.seedNo}>#{bye.seed}</span>
              <span className={s.rowName}>{bye.nickname}</span>
            </div>
          ))}
          <div className={s.hint}>{state.byes[0]?.why}</div>
        </div>
      ) : null}

      <div className={s.group}>
        <div className={s.groupTitle}>Преимущество сетки</div>
        <Field
          label="Побед вперёд у победителя верхней"
          type="number"
          min={0}
          max={3}
          key={`advantage-${t.grandAdvantage}`}
          defaultValue={t.grandAdvantage}
          hint={
            t.grandAdvantage === 0
              ? 'выключено — гранд-финал начинается при 0:0'
              : `победитель верхней начинает гранд-финал при ${t.grandAdvantage}:0, играют до ${target}`
          }
          onBlur={(e) => {
            const value = Number(e.target.value);
            if (!Number.isFinite(value) || value === t.grandAdvantage) return;
            run(() => ipc.setTournamentGrandAdvantage(id, value));
          }}
        />
      </div>

      <div className={s.buttons}>
        <Button
          size="sm"
          disabled={t.players.length < 2 || (live && !emergency)}
          title={live ? 'Пересборка сетки идущего турнира стёрла бы результаты' : undefined}
          onClick={() => run(() => ipc.startTournament(id))}
        >
          Пересобрать сетку
        </Button>
        <Button
          size="sm"
          disabled={t.players.length < 2 || (live && !emergency)}
          onClick={() => run(() => ipc.shuffleTournamentSeeds(id, emergency))}
        >
          Перемешать
        </Button>
      </div>

      {live ? (
        <div className={s.hint}>
          Турнир идёт: структура сетки закрыта. Правится только то, что ещё не сыграно, — кликни
          по матчу на сетке.
        </div>
      ) : null}
    </>
  );
}
