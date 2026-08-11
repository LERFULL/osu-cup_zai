import { useMemo } from 'react';
import type { Bracket, BracketSide, Match, Standing, TournamentPlayer } from '@/lib/types';
import s from './BracketView.module.css';

interface Props {
  bracket: Bracket;
  onOpenMatch: (id: number) => void;
}

/** Геометрия сетки. Держим в одном месте: по ней же считаются линии связей. */
const CARD_H = 64;
const V_GAP = 20;
/** Между верхней и нижней сеткой — больше воздуха, чем между матчами. */
const SIDE_GAP = 54;
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

  /**
   * Раскладка всей сетки одним полотном: колонки — раунды слева направо,
   * ряды — верхняя сетка, под ней нижняя. Гранд-финал встаёт в свою
   * колонку справа от обоих финалов, и линии в него идут как везде.
   */
  const layout = useMemo(() => {
    // Матчи, в которые никто не пришёл (обе ветки закончились техпобедами),
    // в сетке не показываем: играть там нечего, а место они занимают.
    const shown = bracket.matches.filter((m) => !(m.isWalkover && m.winnerId === null));

    // Колонка матча: раунды верхней и нижней сетки идут своими рядами,
    // но по одной шкале, а гранд-финал — всегда последняя колонка.
    const columnsOf = (side: BracketSide) =>
      [...new Set(shown.filter((m) => m.bracket === side).map((m) => m.round))].sort(
        (a, b) => a - b,
      );

    const upperRounds = columnsOf('upper');
    const lowerRounds = columnsOf('lower');
    const hasGrand = shown.some((m) => m.bracket === 'grand');
    const columns = Math.max(upperRounds.length, lowerRounds.length) + (hasGrand ? 1 : 0);

    const columnOf = (m: Match): number => {
      if (m.bracket === 'grand') return columns - 1;
      const rounds = m.bracket === 'upper' ? upperRounds : lowerRounds;
      return Math.max(rounds.indexOf(m.round), 0);
    };

    // Кто питает этот матч — нужно, чтобы поставить его напротив предков.
    const sources = new Map<number, number[]>();
    for (const m of shown) {
      for (const target of [m.nextWinSlot, m.nextLoseSlot]) {
        if (target === null || !shown.some((x) => x.id === target)) continue;
        sources.set(target, [...(sources.get(target) ?? []), m.id]);
      }
    }

    // Позиции считаем колонками слева направо: матч встаёт по центру своих
    // предков, но не наезжая на соседа сверху. Нижняя сетка начинается там,
    // где кончилась верхняя.
    const y = new Map<number, number>();
    const place = (side: BracketSide, from: number): number => {
      const rounds = side === 'upper' ? upperRounds : lowerRounds;
      let bottom = from;

      for (const round of rounds) {
        let cursor = from;
        const column = shown
          .filter((m) => m.bracket === side && m.round === round)
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
          bottom = Math.max(bottom, cursor);
        }
      }
      return bottom;
    };

    const upperBottom = place('upper', 0);
    const lowerTop = lowerRounds.length > 0 ? upperBottom - V_GAP + SIDE_GAP : upperBottom;
    const lowerBottom = place('lower', lowerTop);

    // Гранд-финал — продолжение обеих веток, поэтому встаёт между ними.
    const grand = shown.find((m) => m.bracket === 'grand');
    if (grand !== undefined) {
      const parents = (sources.get(grand.id) ?? [])
        .map((id) => y.get(id))
        .filter((v): v is number => v !== undefined);
      y.set(
        grand.id,
        parents.length > 0 ? parents.reduce((a, b) => a + b, 0) / parents.length : 0,
      );
    }

    const colX = (column: number) => column * (COL_W + COL_GAP);
    const height = Math.max(...[...y.values()].map((v) => v + CARD_H), lowerBottom, CARD_H);
    const width = columns * COL_W + (columns - 1) * COL_GAP;

    // Заголовки колонок: у верхней и нижней сетки свои названия раундов,
    // поэтому подписываем каждый ряд отдельно.
    const heads = [
      ...upperRounds.map((round, i) => ({
        key: `upper-${round}`,
        title: roundTitle('upper', round, upperRounds[upperRounds.length - 1] ?? round),
        x: colX(i),
        y: 0,
      })),
      ...lowerRounds.map((round, i) => ({
        key: `lower-${round}`,
        title: roundTitle('lower', round, lowerRounds[lowerRounds.length - 1] ?? round),
        x: colX(i),
        y: lowerTop,
      })),
      ...(grand === undefined
        ? []
        : [
            {
              key: 'grand',
              title: SIDE_TITLE.grand,
              x: colX(columns - 1),
              y: Math.max((y.get(grand.id) ?? 0) - HEAD_H - 6, 0),
            },
          ]),
    ];

    // Линии рисуем под карточками: уголком, как в турнирных сетках.
    // Победитель идёт сплошной, упавший в нижнюю сетку — пунктиром.
    const links = shown.flatMap((m) => {
      const from = y.get(m.id);
      if (from === undefined) return [];

      return ([
        [m.nextWinSlot, false],
        [m.nextLoseSlot, true],
      ] as const).flatMap(([targetId, drop]) => {
        const target = shown.find((x) => x.id === targetId);
        const to = target === undefined ? undefined : y.get(target.id);
        if (target === undefined || to === undefined) return [];

        const x1 = colX(columnOf(m)) + COL_W;
        const x2 = colX(columnOf(target));
        const mid = x1 + COL_GAP / 2;
        const y1 = from + CARD_H / 2;
        const y2 = to + CARD_H / 2;

        // Цветом идёт только сыгранная связь: путь игрока по сетке
        // должен читаться, а несыгранная ветка — это ещё не путь.
        const who = m.winnerId === null ? null : byId.get(m.winnerId) ?? null;
        const loser =
          m.winnerId === null
            ? null
            : byId.get(m.playerA === m.winnerId ? m.playerB ?? -1 : m.playerA ?? -1) ?? null;

        return [
          {
            key: `${m.id}-${target.id}-${drop ? 'lose' : 'win'}`,
            d: `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`,
            color: (drop ? loser : who)?.color ?? null,
            drop,
          },
        ];
      });
    });

    return { shown, columnOf, colX, width, height, heads, links, y };
  }, [bracket.matches, byId]);

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
        <div className={s.canvas} style={{ width: layout.width, height: layout.height + HEAD_H }}>
          {layout.heads.map((h) => (
            <div key={h.key} className={s.roundTitle} style={{ left: h.x, top: h.y, width: COL_W }}>
              {h.title}
            </div>
          ))}

          <svg
            className={s.links}
            width={layout.width}
            height={layout.height + HEAD_H}
            aria-hidden
          >
            {layout.links.map((l) => (
              <path
                key={l.key}
                d={l.d}
                transform={`translate(0 ${HEAD_H})`}
                className={[s.link, l.drop ? s.linkDrop : null].filter(Boolean).join(' ')}
                {...(l.color !== null ? { style: { stroke: l.color, opacity: 0.85 } } : {})}
              />
            ))}
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
                  top: (layout.y.get(m.id) ?? 0) + HEAD_H,
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
