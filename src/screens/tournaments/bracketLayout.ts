// Геометрия турнирной сетки. Вынесена из вида отдельно: расположение
// матчей — единственное, что легко сломать незаметно, и его проверяют тесты.

import type { BracketSide, Match } from '@/lib/types';

/** Держим в одном месте: по этим же числам считаются линии связей. */
export const CARD_H = 64;
export const V_GAP = 20;
/** Между верхней и нижней сеткой — больше воздуха, чем между матчами. */
export const SIDE_GAP = 54;
export const COL_W = 214;
export const COL_GAP = 62;
export const HEAD_H = 26;

/** Подпись колонки: своя у каждого ряда, потому что раунды называются по-разному. */
export interface Head {
  key: string;
  side: BracketSide;
  round: number;
  /** Последний раунд этого ряда — по нему подпись понимает, что она финал. */
  lastRound: number;
  x: number;
  y: number;
}

/** Связь между матчами. Цвет подставляет вид: раскладка о игроках не знает. */
export interface Link {
  key: string;
  d: string;
  /** Падение в нижнюю сетку, а не проход дальше. */
  drop: boolean;
  /** Кто прошёл этим путём: победитель матча либо упавший вниз проигравший. */
  playerId: number | null;
}

export interface Layout {
  /** Матчи, которые вообще показываем. */
  shown: Match[];
  columnOf: (m: Match) => number;
  colX: (column: number) => number;
  topOf: (m: Match) => number;
  width: number;
  height: number;
  heads: Head[];
  links: Link[];
}

/**
 * Раскладка всей сетки одним полотном.
 *
 * Колонка считается не по номеру раунда, а по тому, сколько раундов сыграют
 * после него: раунд стоит настолько левее гранд-финала, насколько он глубоко
 * от конца турнира. Поэтому первый раунд нижней сетки оказывается под вторым
 * раундом верхней — он и играется позже, — а финал верхней и финал нижней не
 * делят одну колонку. Ряды: верхняя сетка, под ней нижняя, гранд-финал — на
 * высоте верхней.
 */
export function layoutBracket(matches: Match[]): Layout {
  // Матчи, в которые никто не пришёл (обе ветки закончились техпобедами),
  // в сетке не показываем: играть там нечего, а место они занимают.
  const shown = matches.filter((m) => !(m.isWalkover && m.winnerId === null));
  const byMatch = new Map(shown.map((m) => [m.id, m]));

  /** Раунд как целое: колонку получает он, а не отдельный матч. */
  const keyOf = (m: Match) => `${m.bracket}:${m.round}`;

  // Какой раунд питает какой — по этому графу и считается колонка.
  const after = new Map<string, Set<string>>();
  for (const m of shown) {
    for (const id of [m.nextWinSlot, m.nextLoseSlot]) {
      const target = id === null ? undefined : byMatch.get(id);
      if (target === undefined) continue;
      const from = keyOf(m);
      const to = keyOf(target);
      if (from === to) continue;
      const set = after.get(from) ?? new Set<string>();
      set.add(to);
      after.set(from, set);
    }
  }

  // Сколько раундов сыграют после этого — самым длинным путём до конца.
  const toEnd = new Map<string, number>();
  const depth = (key: string, seen: Set<string>): number => {
    const known = toEnd.get(key);
    if (known !== undefined) return known;
    // Круга в турнирной сетке быть не может, но на битых данных зацикливаться незачем.
    if (seen.has(key)) return 0;
    seen.add(key);
    const out = after.get(key);
    const value = out === undefined ? 0 : Math.max(0, ...[...out].map((k) => depth(k, seen) + 1));
    seen.delete(key);
    toEnd.set(key, value);
    return value;
  };

  const last = Math.max(0, ...shown.map((m) => depth(keyOf(m), new Set())));
  const columnOf = (m: Match): number => last - depth(keyOf(m), new Set());

  /**
   * Питающие матчи той же сетки. Падение из верхней в нижнюю на вертикаль
   * не влияет: иначе нижняя сетка растянулась бы по высоте верхней.
   */
  const parentsOf = (m: Match) =>
    shown.filter(
      (x) => x.bracket === m.bracket && (x.nextWinSlot === m.id || x.nextLoseSlot === m.id),
    );

  // Позиции считаем колонками слева направо: матч встаёт по центру своих
  // предков, но не наезжая на соседа сверху.
  const y = new Map<number, number>();
  const place = (side: BracketSide, from: number): number => {
    const mine = shown.filter((m) => m.bracket === side);
    const columns = [...new Set(mine.map((m) => columnOf(m)))].sort((a, b) => a - b);
    let bottom = from;

    for (const column of columns) {
      let cursor = from;
      const inColumn = mine
        .filter((m) => columnOf(m) === column)
        .sort((a, b) => a.slotInBracket - b.slotInBracket);

      for (const m of inColumn) {
        const parents = parentsOf(m)
          .map((p) => y.get(p.id))
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

  const upperBottom = place('upper', HEAD_H);
  const hasLower = shown.some((m) => m.bracket === 'lower');
  // У нижней сетки своя строка заголовков: её раунды называются иначе.
  const lowerHead = upperBottom - V_GAP + SIDE_GAP;
  const lowerBottom = hasLower ? place('lower', lowerHead + HEAD_H) : upperBottom;

  // Гранд-финал — продолжение верхней сетки: он встаёт на её высоте, а линия
  // из нижней поднимается к нему. Между сетками его не ставим — иначе путь
  // победителя верхней ломается ровно там, где важнее всего.
  const grand = shown.find((m) => m.bracket === 'grand');
  if (grand !== undefined) {
    const fromUpper = shown.find((x) => x.bracket === 'upper' && x.nextWinSlot === grand.id);
    const anchor = fromUpper === undefined ? undefined : y.get(fromUpper.id);
    const parents = shown
      .filter((x) => x.nextWinSlot === grand.id || x.nextLoseSlot === grand.id)
      .map((x) => y.get(x.id))
      .filter((v): v is number => v !== undefined);
    y.set(
      grand.id,
      anchor ?? (parents.length > 0 ? parents.reduce((a, b) => a + b, 0) / parents.length : HEAD_H),
    );
  }

  const colX = (column: number) => column * (COL_W + COL_GAP);
  const topOf = (m: Match) => y.get(m.id) ?? 0;
  const width = (last + 1) * COL_W + last * COL_GAP;
  const height = Math.max(
    ...[...y.values()].map((v) => v + CARD_H),
    lowerBottom,
    HEAD_H + CARD_H,
  );

  const headsOf = (side: 'upper' | 'lower', top: number): Head[] => {
    const columnByRound = new Map<number, number>();
    for (const m of shown) {
      if (m.bracket === side) columnByRound.set(m.round, columnOf(m));
    }
    const rounds = [...columnByRound.keys()].sort((a, b) => a - b);
    const lastRound = rounds[rounds.length - 1] ?? 0;
    return rounds.map((round) => ({
      key: `${side}-${round}`,
      side,
      round,
      lastRound,
      x: colX(columnByRound.get(round) ?? 0),
      y: top,
    }));
  };

  const heads: Head[] = [
    ...headsOf('upper', 0),
    ...(hasLower ? headsOf('lower', lowerHead) : []),
    ...(grand === undefined
      ? []
      : [
          {
            key: 'grand',
            side: 'grand' as const,
            round: grand.round,
            lastRound: grand.round,
            x: colX(columnOf(grand)),
            y: Math.max(topOf(grand) - HEAD_H, 0),
          },
        ]),
  ];

  // Линии уголком, как в турнирных сетках: победитель идёт сплошной,
  // упавший в нижнюю сетку — пунктиром.
  const links: Link[] = shown.flatMap((m) => {
    const from = y.get(m.id);
    if (from === undefined) return [];

    return (
      [
        [m.nextWinSlot, false],
        [m.nextLoseSlot, true],
      ] as const
    ).flatMap(([targetId, drop]) => {
      const target = targetId === null ? undefined : byMatch.get(targetId);
      const to = target === undefined ? undefined : y.get(target.id);
      if (target === undefined || to === undefined) return [];

      const x1 = colX(columnOf(m)) + COL_W;
      const x2 = colX(columnOf(target));
      // Уголок ломается посередине между карточками. На связи через пустую
      // колонку — финал верхней в гранд-финал — вид получается тот же.
      const mid = (x1 + x2) / 2;
      const y1 = from + CARD_H / 2;
      const y2 = to + CARD_H / 2;

      // Путь по сетке помечаем только сыгранный: несыгранная ветка — это
      // ещё не чей-то путь, и цвет ей не нужен.
      const loser =
        m.winnerId === null ? null : m.playerA === m.winnerId ? m.playerB : m.playerA;

      return [
        {
          key: `${m.id}-${target.id}-${drop ? 'lose' : 'win'}`,
          d: `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`,
          drop,
          playerId: drop ? loser : m.winnerId,
        },
      ];
    });
  });

  return { shown, columnOf, colX, topOf, width, height, heads, links };
}
