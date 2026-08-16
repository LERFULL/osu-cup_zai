import { Field } from '@/components';
import type { ByRound, EditorRound, FirstBan } from '@/lib/types';
import * as ipc from '@/lib/ipc';
import type { EditorCtx } from './Editor';
import s from './Editor.module.css';

const FIRST_BAN: [FirstBan, string][] = [
  ['random', 'жеребьёвкой'],
  ['higherSeed', 'старший по сеянию'],
  ['lowerSeed', 'младший по сеянию'],
];

/**
 * Правила: общие значения и исключения по раундам.
 *
 * Унаследованное значение показывается серым — видно, что оно от общего
 * правила, а не задано здесь. Изменённое идёт обычным текстом, и рядом
 * появляется ⟲.
 */
export function Rules({ id, t, state, run }: EditorCtx) {
  const rules = (target: ByRound, bans: ByRound, firstBan: FirstBan, noRepeat: boolean) =>
    run(() => ipc.setTournamentRules(id, target, bans, firstBan, noRepeat));

  /** Ячейка правила раунда: пустая — вернуть общее. */
  const cell = (round: EditorRound, kind: 'target' | 'bans') => {
    const own = kind === 'target' ? round.targetOwn : round.bansOwn;
    const value = kind === 'target' ? round.target : round.bans;

    return (
      <input
        className={own ? `${s.cell} ${s.cellOwn}` : s.cell}
        type="number"
        min={kind === 'target' ? 1 : 0}
        max={kind === 'target' ? 16 : 8}
        // key сбрасывает поле при перечитывании: иначе после ⟲ в нём осталось
        // бы старое число, которого в турнире уже нет.
        key={`${round.key}-${kind}-${value}-${String(own)}`}
        defaultValue={value}
        title={own ? 'задано для этого раунда' : 'от общего правила'}
        onBlur={(e) => {
          const next = Number(e.target.value);
          if (!Number.isFinite(next) || next === value) return;
          run(() =>
            ipc.setTournamentRoundRule(
              id,
              round.key,
              kind === 'target' ? next : round.targetOwn ? round.target : null,
              kind === 'bans' ? next : round.bansOwn ? round.bans : null,
            ),
          );
        }}
      />
    );
  };

  return (
    <>
      <div className={s.two}>
        <Field
          label="До скольких побед"
          type="number"
          min={1}
          max={16}
          key={`target-${t.targetScore.default}`}
          defaultValue={t.targetScore.default}
          onBlur={(e) => {
            const value = Number(e.target.value);
            if (!Number.isFinite(value) || value < 1 || value === t.targetScore.default) return;
            rules(
              { default: value, rounds: t.targetScore.rounds },
              t.bansPerRound,
              t.firstBan,
              t.noRepeatPool,
            );
          }}
        />
        <Field
          label="Банов на игрока"
          type="number"
          min={0}
          max={8}
          key={`bans-${t.bansPerRound.default}`}
          defaultValue={t.bansPerRound.default}
          onBlur={(e) => {
            const value = Number(e.target.value);
            if (!Number.isFinite(value) || value < 0 || value === t.bansPerRound.default) return;
            rules(
              t.targetScore,
              { default: value, rounds: t.bansPerRound.rounds },
              t.firstBan,
              t.noRepeatPool,
            );
          }}
        />
      </div>

      <div className={s.group}>
        <div className={s.groupTitle}>Кто банит первым</div>
        <div className={s.chips}>
          {FIRST_BAN.map(([value, label]) => (
            <button
              key={value}
              className={t.firstBan === value ? s.chipOn : s.chip}
              type="button"
              onClick={() => rules(t.targetScore, t.bansPerRound, value, t.noRepeatPool)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className={s.group}>
        <div className={s.groupTitle}>Исключения по раундам</div>
        {state.rounds.length === 0 ? (
          <div className={s.muted}>
            Раунды появятся, когда в турнире будет хотя бы два игрока.
          </div>
        ) : (
          <div className={s.rounds}>
            <div className={s.roundHead}>
              <span>Раунд</span>
              <span>Побед</span>
              <span>Банов</span>
              <span />
            </div>

            {state.rounds.map((round) => (
              <div key={round.key} className={s.round}>
                <span className={s.roundName} title={round.title}>
                  {round.title}
                </span>
                {cell(round, 'target')}
                {cell(round, 'bans')}
                {round.targetOwn || round.bansOwn ? (
                  <button
                    className={s.reset}
                    type="button"
                    title="Вернуть к общему правилу"
                    onClick={() => run(() => ipc.setTournamentRoundRule(id, round.key, null, null))}
                  >
                    ⟲
                  </button>
                ) : (
                  <span />
                )}

                {round.notes.map((note) => (
                  <span key={note} className={s.note}>
                    {note}
                  </span>
                ))}
                {round.started ? (
                  <span className={s.hint}>
                    раунд уже играется — правило подействует со следующего его матча
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
