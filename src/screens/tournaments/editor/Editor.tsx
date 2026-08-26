import { useState } from 'react';
import { Button, Switch } from '@/components';
import type { Bracket, EditorSection, EditorState, Player, Pool, Series } from '@/lib/types';
import * as ipc from '@/lib/ipc';
import { Rules } from './Rules';
import { Prize } from './Prize';
import { BracketSetup } from './BracketSetup';
import { Pools } from './Pools';
import { Roster } from './Roster';
import { EditsLog } from './EditsLog';
import s from './Editor.module.css';

/** Что нужно каждому разделу: сам турнир, его проверки и способ применить правку. */
export interface EditorCtx {
  id: number;
  t: Bracket;
  state: EditorState;
  /** Включена ли аварийная правка. */
  emergency: boolean;
  /** Выполнить правку и перечитать турнир целиком. */
  run: (work: () => Promise<unknown>) => void;
  players: Player[];
  pools: Pool[];
  series: Series[];
}

interface Props extends EditorCtx {
  onEmergency: (next: boolean) => void;
}

const TITLE: Record<EditorSection, string> = {
  rules: 'Правила',
  prize: 'Призовой фонд',
  bracket: 'Сетка',
  pools: 'Маппулы',
  players: 'Участники',
};

/** Счётчик у заголовка: что в разделе есть, а не сколько в нём полей. */
function summary(section: EditorSection, ctx: EditorCtx): string {
  const { t, state } = ctx;
  switch (section) {
    case 'rules':
      return `до ${t.targetScore.default} побед`;
    case 'prize':
      return t.prize === null ? 'нет' : `${t.prize.fund.toLocaleString('ru-RU')} ₽`;
    case 'bracket':
      return state.matchesTotal > 0
        ? `${state.matchesTotal} матчей`
        : `${state.projectedMatches} матчей`;
    case 'pools':
      return `${t.poolIds.length}`;
    case 'players':
      return `${t.players.length}`;
  }
}

/**
 * Колонка разделов. Открыт всегда один: разделы длинные, и два открытых
 * в колонку не влезают.
 */
export function Editor({ onEmergency, ...ctx }: Props) {
  const [open, setOpen] = useState<EditorSection>(
    ctx.t.status === 'draft' ? 'players' : 'rules',
  );
  const [log, setLog] = useState(false);

  const { id, state, emergency, run } = ctx;
  const last = state.edits[0];
  const problems = (section: EditorSection) =>
    state.checks.filter((c) => c.section === section).length;

  const section = (key: EditorSection, content: () => React.ReactNode) => {
    const bad = problems(key);
    const on = open === key;
    return (
      <div key={key}>
        <button
          className={on ? `${s.head} ${s.headOn}` : s.head}
          type="button"
          onClick={() => setOpen(key)}
          aria-expanded={on}
        >
          {TITLE[key]}
          <span className={s.count}>{summary(key, ctx)}</span>
          {bad > 0 ? <span className={s.bad}>⚠ {bad}</span> : null}
        </button>
        {on ? <div className={s.body}>{content()}</div> : null}
      </div>
    );
  };

  return (
    <aside className={emergency ? `${s.col} ${s.colDanger}` : s.col}>
      <div className={s.list}>
        {section('rules', () => (
          <Rules {...ctx} />
        ))}
        {section('prize', () => (
          <Prize {...ctx} />
        ))}
        {section('bracket', () => (
          <BracketSetup {...ctx} />
        ))}
        {section('pools', () => (
          <Pools {...ctx} />
        ))}
        {section('players', () => (
          <Roster {...ctx} />
        ))}
      </div>

      <footer className={s.foot}>
        <button className={s.edits} type="button" onClick={() => setLog(!log)}>
          {state.edits.length === 0
            ? 'Правок пока нет'
            : `${state.edits.length} правок · последняя: ${last?.note ?? ''}`}
          <span className={s.count}>{log ? '▾' : '▸'}</span>
        </button>

        {log ? <EditsLog edits={state.edits} /> : null}

        <div className={s.footRow}>
          <Button
            size="sm"
            disabled={state.undoBlocked !== null}
            title={state.undoBlocked ?? 'Отменить последнюю правку (Ctrl+Z)'}
            onClick={() => run(() => ipc.undoTournamentEdit(id))}
          >
            ↶ Отменить последнюю
          </Button>
        </div>
        {state.undoBlocked !== null && state.edits.length > 0 ? (
          <div className={s.hint}>{state.undoBlocked}</div>
        ) : null}

        {state.emergencyAvailable ? (
          <div className={emergency ? s.danger : undefined}>
            <Switch
              checked={emergency}
              onChange={onEmergency}
              note="Разрешает менять сыгранное. Каждая правка попадёт в историю турнира,
                    а матчи ниже по сетке сбросятся."
            >
              Аварийная правка
            </Switch>
          </div>
        ) : null}
      </footer>
    </aside>
  );
}
