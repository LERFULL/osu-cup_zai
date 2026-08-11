import { useMemo } from 'react';
import type { Bracket, BracketSide, Match, Standing, TournamentPlayer } from '@/lib/types';
import { COL_W, layoutBracket } from './bracketLayout';
import s from './BracketView.module.css';

interface Props {
  bracket: Bracket;
  onOpenMatch: (id: number) => void;
}

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

/** Место словами: у первых трёх есть имена, дальше просто номер. */
function placeLabel(placement: number): string {
  if (placement === 1) return 'Победитель';
  if (placement === 2) return 'Финалист';
  return `${placement} место`;
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

  // Раскладка — чистая функция в bracketLayout.ts: расположение матчей проще
  // всего сломать незаметно, поэтому его держат тесты, а не глаз.
  const layout = useMemo(() => layoutBracket(bracket.matches), [bracket.matches]);

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

  const champion = bracket.players.find((p) => p.placement === 1) ?? null;
  const podium = bracket.standings.filter((x) => x.placement <= 3);

  return (
    <div className={s.wrap}>
      {bracket.status === 'finished' ? (
        <Results standings={bracket.standings} podium={podium} />
      ) : champion !== null ? (
        <div className={s.champion}>
          <span className={s.crown} aria-hidden>
            ♛
          </span>
          <span className={s.stripe} style={{ background: champion.color }} aria-hidden />
          {champion.nickname} — победитель
        </div>
      ) : null}

      <div className={s.scroll}>
        <div className={s.canvas} style={{ width: layout.width, height: layout.height }}>
          {layout.heads.map((h) => (
            <div key={h.key} className={s.roundTitle} style={{ left: h.x, top: h.y, width: COL_W }}>
              {roundTitle(h.side, h.round, h.lastRound)}
            </div>
          ))}

          <svg className={s.links} width={layout.width} height={layout.height} aria-hidden>
            {layout.links.map((l) => {
              // Цветом идёт только сыгранная связь: путь игрока по сетке
              // должен читаться, а несыгранная ветка — это ещё не путь.
              const color = l.playerId === null ? null : (byId.get(l.playerId)?.color ?? null);
              return (
                <path
                  key={l.key}
                  d={l.d}
                  className={[s.link, l.drop ? s.linkDrop : null].filter(Boolean).join(' ')}
                  {...(color !== null ? { style: { stroke: color, opacity: 0.85 } } : {})}
                />
              );
            })}
          </svg>

          {layout.shown.map((m) => {
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
                  left: layout.colX(layout.columnOf(m)),
                  top: layout.topOf(m),
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
    </div>
  );
}

/** Итоги турнира: пьедестал и таблица всех участников. */
function Results({ standings, podium }: { standings: Standing[]; podium: Standing[] }) {
  return (
    <section className={s.results}>
      <div className={s.resultsTitle}>Турнир сыгран</div>

      <div className={s.podium}>
        {podium.map((p) => (
          <div
            key={p.playerId}
            className={[s.step, p.placement === 1 ? s.stepFirst : null].filter(Boolean).join(' ')}
            style={{ '--who': p.color } as React.CSSProperties}
          >
            <div className={s.place}>{placeLabel(p.placement)}</div>
            <div className={s.podiumNick}>
              <span className={s.stripe} style={{ background: p.color }} aria-hidden />
              {p.nickname}
            </div>
            <div className={s.podiumScore}>
              {p.matchWins}—{p.matchLosses} по матчам · {p.mapWins}—{p.mapLosses} по картам
            </div>
          </div>
        ))}
      </div>

      {standings.length > podium.length ? (
        <div className={s.table}>
          {standings.slice(podium.length).map((p) => (
            <div key={p.playerId} className={s.tableRow}>
              <span className={s.tablePlace}>{p.placement}</span>
              <span className={s.stripe} style={{ background: p.color }} aria-hidden />
              <span className={s.tableNick}>{p.nickname}</span>
              <span className={s.tableScore}>
                {p.matchWins}—{p.matchLosses}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
