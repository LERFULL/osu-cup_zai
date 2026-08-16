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
  // Пустая полоса между сетками: по ней ведём падения, которым уголком
  // не пройти, не задев чужие матчи.
  const corridor = upperBottom - V_GAP + SIDE_GAP / 2;

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
  //
  // Вертикаль уголка у каждого матча-цели своя: если ломать все связи на
  // середине зазора, вертикали разных матчей ложатся одна на другую и сетка
  // читается как клубок. Связи в один и тот же матч вертикаль делят — это и
  // есть та самая турнирная скоба.
  interface Edge {
    key: string;
    from: Match;
    target: Match;
    drop: boolean;
  }

  const edges: Edge[] = shown.flatMap((m) =>
    (
      [
        [m.nextWinSlot, false],
        [m.nextLoseSlot, true],
      ] as const
    ).flatMap(([targetId, drop]) => {
      const target = targetId === null ? undefined : byMatch.get(targetId);
      if (target === undefined) return [];
      return [
        {
          key: `${m.id}-${target.id}-${drop ? 'lose' : 'win'}`,
          from: m,
          target,
          drop,
        },
      ];
    }),
  );

  const cards = shown.map((m) => ({
    id: m.id,
    left: colX(columnOf(m)),
    right: colX(columnOf(m)) + COL_W,
    top: topOf(m),
    bottom: topOf(m) + CARD_H,
  }));

  /** Отрезки маршрута — по ним и считаем, задевает ли связь карточки. */
  const parts = (d: string) => {
    const tokens = d.trim().split(/\s+/);
    const out: { x: [number, number]; y: [number, number] }[] = [];
    let at = { x: Number(tokens[1]), y: Number(tokens[2]) };

    for (let i = 3; i < tokens.length; i += 2) {
      const value = Number(tokens[i + 1]);
      const next = tokens[i] === 'H' ? { x: value, y: at.y } : { x: at.x, y: value };
      out.push({
        x: [Math.min(at.x, next.x), Math.max(at.x, next.x)],
        y: [Math.min(at.y, next.y), Math.max(at.y, next.y)],
      });
      at = next;
    }
    return out;
  };

  /** Сколько чужих карточек задевает маршрут. */
  const hits = (edge: Edge, d: string): number => {
    let count = 0;
    for (const card of cards) {
      // Свои карточки не считаем: связь из них и выходит.
      if (card.id === edge.from.id || card.id === edge.target.id) continue;
      for (const seg of parts(d)) {
        const insideX = seg.x[1] > card.left + 1 && seg.x[0] < card.right - 1;
        const insideY = seg.y[1] > card.top + 1 && seg.y[0] < card.bottom - 1;
        if (insideX && insideY) count += 1;
      }
    }
    return count;
  };

  const endsOf = (edge: Edge) => ({
    x1: colX(columnOf(edge.from)) + COL_W,
    x2: colX(columnOf(edge.target)),
    // Проход дальше выходит из середины карточки, падение вниз — из её низа:
    // так две связи одного матча расходятся сразу.
    y1: topOf(edge.from) + (edge.drop ? CARD_H - 8 : CARD_H / 2),
    y2: topOf(edge.target) + CARD_H / 2,
  });

  /** Уголок: вправо до зазора, вертикаль, вправо до цели. */
  const elbow = (edge: Edge, gap: number, at: number) => {
    const { x1, x2, y1, y2 } = endsOf(edge);
    const mid = colX(gap) + COL_W + COL_GAP * at;
    return `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`;
  };

  /**
   * Обход по коридору между сетками: вниз в пустую полосу, поперёк неё и
   * снова вниз у самой цели.
   *
   * Нужен падениям через колонку: на нечётном составе проигравший из первого
   * раунда верхней летит мимо чужих матчей, и уголком его не провести — любая
   * из двух длинных горизонталей ляжет на карточку.
   */
  const detour = (edge: Edge, at: number) => {
    const { x1, x2, y1, y2 } = endsOf(edge);
    const first = colX(columnOf(edge.from)) + COL_W + COL_GAP * at;
    const lastGap = colX(columnOf(edge.target) - 1) + COL_W + COL_GAP * at;
    return `M ${x1} ${y1} H ${first} V ${corridor} H ${lastGap} V ${y2} H ${x2}`;
  };

  /**
   * Доля зазора для каждой связи.
   *
   * Считается по зазору, в котором связь ломается: все его связи делят одну
   * полосу, и разводить их надо между собой.
   *
   * Две связи в один матч делят вертикаль только тогда, когда приходят с
   * разных сторон: сверху и снизу. Тогда они сходятся в точке и рисуют ту
   * самую турнирную скобу. А вот оба проигравших первого раунда падают в
   * нижнюю сетку сверху — общая вертикаль слепила бы их в одну линию, и
   * увидеть, что связей две, было бы нельзя.
   */
  const fraction = new Map<string, number>();
  const byGap = new Map<number, Edge[]>();
  for (const edge of edges) {
    byGap.set(columnOf(edge.from), [...(byGap.get(columnOf(edge.from)) ?? []), edge]);
  }

  for (const [, group] of byGap) {
    // Пучок связей, который вправе делить одну вертикаль: пара «сверху и
    // снизу» в один матч. Всё остальное едет по своей.
    const bundles: Edge[][] = [];
    const seen = new Set<string>();

    for (const edge of group) {
      if (seen.has(edge.key)) continue;
      const sameTarget = group.filter((x) => x.target.id === edge.target.id);
      const middle = topOf(edge.target) + CARD_H / 2;
      const above = sameTarget.filter((x) => topOf(x.from) + CARD_H / 2 < middle).length;

      if (sameTarget.length === 2 && above === 1) {
        bundles.push(sameTarget);
        for (const x of sameTarget) seen.add(x.key);
      } else {
        bundles.push([edge]);
        seen.add(edge.key);
      }
    }

    // Сверху вниз по цели: так связи не перехлёстываются между собой.
    bundles.sort((a, b) => topOf(a[0]!.target) - topOf(b[0]!.target));
    bundles.forEach((bundle, i) => {
      const at = 0.2 + (0.6 * (i + 1)) / (bundles.length + 1);
      for (const edge of bundle) fraction.set(edge.key, at);
    });
  }

  const links: Link[] = edges.map((edge) => {
    const at = fraction.get(edge.key) ?? 0.5;
    const from = columnOf(edge.from);
    const to = columnOf(edge.target);

    // Перебираем маршруты и берём первый, который никого не задевает:
    // обычный уголок в своём зазоре, потом в остальных, потом обход.
    const routes = [elbow(edge, from, at)];
    for (let gap = from + 1; gap < to; gap++) routes.push(elbow(edge, gap, at));
    if (edge.drop && to - from > 1) routes.push(detour(edge, at));

    let d = routes[0]!;
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of routes) {
      const count = hits(edge, candidate);
      if (count < best) {
        best = count;
        d = candidate;
      }
      if (best === 0) break;
    }

    // Путь по сетке помечаем только сыгранный: несыгранная ветка — это
    // ещё не чей-то путь, и цвет ей не нужен.
    const m = edge.from;
    const loser = m.winnerId === null ? null : m.playerA === m.winnerId ? m.playerB : m.playerA;

    return {
      key: edge.key,
      d,
      drop: edge.drop,
      playerId: edge.drop ? loser : m.winnerId,
    };
  });

  // Падения рисуем первыми: они длинные, и поверх сплошных линий пути
  // победителя читались бы хуже.
  links.sort((a, b) => Number(b.drop) - Number(a.drop));

  return { shown, columnOf, colX, topOf, width, height, heads, links };
}
