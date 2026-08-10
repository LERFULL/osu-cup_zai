import { useMemo } from 'react';
import type { Bracket, BracketSide, Match, TournamentPlayer } from '@/lib/types';
import s from './BracketView.module.css';

interface Props {
  bracket: Bracket;
  onOpenMatch: (id: number) => void;
}

/** Геометрия сетки. Держим в одном месте: по ней же считаются линии связей. */
const CARD_H = 64;
const V_GAP = 20;
const COL_W = 214;
const COL_GAP = 62;
const HEAD_H = 26;

const SIDE_TITLE: Record<BracketSide, string> = {
  upper: 'Верхняя сетка',
  lower: 'Нижняя сетка',
  grand: 'Гранд-финал',
};

const SIDE_SHORT: Record<BracketSide, string> = {
  upper: 'ВС',
  lower: 'НС',
  grand: 'ГФ',
};

/**
 * Название раунда. Считаем от конца: последний раунд — финал, перед ним
 * полуфинал. Так подпись не врёт на сетке любого размера.
 */
function roundTitle(side: BracketSide, round: number, last: number): string {
  if (side === 'grand') return 'Гранд-финал';
  const left = last - round;
  if (left === 0) return side === 'upper' ? 'Финал верхней' : 'Финал нижней';
  if (left === 1) return 'Полуфинал';
  return `Раунд ${round}`;
}

/** Короткое имя матча для подписей вида «Проигравший ВС R1-2». */
function shortName(m: Match): string {
  return `${SIDE_SHORT[m.bracket]} R${m.round}-${m.slotInBracket + 1}`;
}

export function BracketView({ bracket, onOpenMatch }: Props) {
  const byId = useMemo(() => {
    const map = new Map<number, TournamentPlayer>();
    for (const p of bracket.players) map.set(p.playerId, p);
    return map;
  }, [bracket.players]);

  /** Сеяние: своё, а если не проставлено — порядок в составе. */
  const seedOf = useMemo(() => {
    const map = new Map<number, number>();
    bracket.players.forEach((p, i) => map.set(p.playerId, p.seed ?? i + 1));
    return map;
  }, [bracket.players]);

  /**
   * Откуда придёт игрок в пустое место. Считается по обратным ссылкам:
   * пустая клетка без объяснения — самое непонятное место в сетке.
   */
  const waitingFor = useMemo(() => {
    const map = new Map<number, string[]>();
    const add = (target: number | null, label: string) => {
      if (target === null) return;
      map.set(target, [...(map.get(target) ?? []), label]);
    };
    for (const m of bracket.matches) {
      add(m.nextWinSlot, `Победитель ${shortName(m)}`);
      add(m.nextLoseSlot, `Проигравший ${shortName(m)}`);
    }
    return map;
  }, [bracket.matches]);

  const champion = bracket.players.find((p) => p.placement === 1) ?? null;

  /** Ячейка стороны матча: сеяние, игрок и счёт. */
  function slot(m: Match, side: 'a' | 'b') {
    const id = side === 'a' ? m.playerA : m.playerB;
    const player = id === null ? null : (byId.get(id) ?? null);
    const score = side === 'a' ? m.scoreA : m.scoreB;
    const other = side === 'a' ? m.scoreB : m.scoreA;
    const won = m.winnerId !== null && id !== null && m.winnerId === id;
    const lost = m.winnerId !== null && id !== null && !won;

    // Подпись берём по порядку: первое пустое место — первый источник.
    const pending = waitingFor.get(m.id) ?? [];
    const hint = side === 'a' ? pending[0] : pending[m.playerA === null ? 1 : 0];

    return (
      <div className={[s.slot, won ? s.won : null, lost ? s.lost : null].filter(Boolean).join(' ')}>
        {player === null ? (
          <>
            <span className={s.seedEmpty} aria-hidden>
              ?
            </span>
            <span className={s.tbd}>{hint ?? 'ждёт соперника'}</span>
          </>
        ) : (
          <>
            <span className={s.seed}>#{seedOf.get(player.playerId) ?? '—'}</span>
            <span className={s.stripe} style={{ background: player.color }} aria-hidden />
            <span className={s.nick}>{player.nickname}</span>
            <span className={score > other ? s.scoreLead : s.score}>{score}</span>
          </>
        )}
      </div>
    );
  }

  /** Одна сторона сетки: колонки раундов, позиции и линии связей. */
  function renderSide(side: BracketSide) {
    const inSide = bracket.matches.filter((m) => m.bracket === side);
    if (inSide.length === 0) return null;

    const rounds = [...new Set(inSide.map((m) => m.round))].sort((a, b) => a - b);
    const last = rounds[rounds.length - 1] ?? 1;

    // Кто питает этот матч — нужно, чтобы поставить его напротив предков.
    const sources = new Map<number, number[]>();
    for (const m of inSide) {
      for (const target of [m.nextWinSlot, m.nextLoseSlot]) {
        if (target === null || !inSide.some((x) => x.id === target)) continue;
        sources.set(target, [...(sources.get(target) ?? []), m.id]);
      }
    }

    // Позиции считаем колонками слева направо: матч встаёт по центру своих
    // предков, но не наезжая на соседа сверху.
    const y = new Map<number, number>();
    for (const round of rounds) {
      let cursor = 0;
      const column = inSide
        .filter((m) => m.round === round)
        .sort((a, b) => a.slotInBracket - b.slotInBracket);

      for (const m of column) {
        const parents = (sources.get(m.id) ?? [])
          .map((id) => y.get(id))
          .filter((v): v is number => v !== undefined);
        const wanted =
          parents.length > 0 ? parents.reduce((a, b) => a + b, 0) / parents.length : cursor;
        const at = Math.max(wanted, cursor);
        y.set(m.id, at);
        cursor = at + CARD_H + V_GAP;
      }
    }

    const colX = (round: number) => rounds.indexOf(round) * (COL_W + COL_GAP);
    const height = Math.max(...[...y.values()].map((v) => v + CARD_H), CARD_H);
    const width = rounds.length * COL_W + (rounds.length - 1) * COL_GAP;

    // Линии рисуем под карточками: уголком, как в турнирных сетках.
    const links = inSide.flatMap((m) => {
      const target = inSide.find((x) => x.id === m.nextWinSlot);
      const from = y.get(m.id);
      const to = target === undefined ? undefined : y.get(target.id);
      if (target === undefined || from === undefined || to === undefined) return [];

      const x1 = colX(m.round) + COL_W;
      const x2 = colX(target.round);
      const mid = x1 + COL_GAP / 2;
      const y1 = from + CARD_H / 2;
      const y2 = to + CARD_H / 2;
      const winner = m.winnerId === null ? null : (byId.get(m.winnerId) ?? null);

      return [
        {
          key: `${m.id}-${target.id}`,
          d: `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`,
          color: winner?.color ?? null,
        },
      ];
    });

    return (
      <section key={side} className={s.side}>
        <div className={s.sideTitle}>{SIDE_TITLE[side]}</div>

        <div className={s.scroll}>
          <div className={s.canvas} style={{ width, height: height + HEAD_H }}>
            {rounds.map((round) => (
              <div
                key={`h-${round}`}
                className={s.roundTitle}
                style={{ left: colX(round), width: COL_W }}
              >
                {roundTitle(side, round, last)}
              </div>
            ))}

            <svg className={s.links} width={width} height={height + HEAD_H} aria-hidden>
              {links.map((l) => (
                <path
                  key={l.key}
                  d={l.d}
                  transform={`translate(0 ${HEAD_H})`}
                  className={s.link}
                  {...(l.color !== null ? { style: { stroke: l.color, opacity: 0.85 } } : {})}
                />
              ))}
            </svg>

            {inSide.map((m) => {
              const ready = m.playerA !== null && m.playerB !== null;
              const done = m.status === 'finished';
              return (
                <button
                  key={m.id}
                  className={[s.match, done ? s.done : null, ready && !done ? s.ready : null]
                    .filter(Boolean)
                    .join(' ')}
                  type="button"
                  disabled={!ready}
                  onClick={() => onOpenMatch(m.id)}
                  style={{
                    left: colX(m.round),
                    top: (y.get(m.id) ?? 0) + HEAD_H,
                    width: COL_W,
                  }}
                  title={ready ? shortName(m) : 'Ждёт результатов прошлых матчей'}
                >
                  {slot(m, 'a')}
                  {slot(m, 'b')}
                  {m.isWalkover ? <span className={s.tag}>без игры</span> : null}
                  {m.isManualEdit ? <span className={s.tag}>вручную</span> : null}
                </button>
              );
            })}
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className={s.wrap}>
      {champion !== null ? (
        <div className={s.champion}>
          <span className={s.crown} aria-hidden>
            ♛
          </span>
          <span className={s.stripe} style={{ background: champion.color }} aria-hidden />
          {champion.nickname} — победитель
        </div>
      ) : null}

      {renderSide('upper')}
      {renderSide('lower')}
      {renderSide('grand')}
    </div>
  );
}
