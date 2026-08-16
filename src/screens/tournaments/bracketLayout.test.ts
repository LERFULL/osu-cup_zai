import { describe, expect, it } from 'vitest';
import type { Match } from '@/lib/types';
import { CARD_H, COL_W, HEAD_H, layoutBracket } from './bracketLayout';

/**
 * Скелет двойной сетки на восемь игроков — тот же, что строит генератор:
 * верхняя R1—R3, нижняя R1—R4 (последний — финал нижней), гранд-финал.
 * Связи заданы руками, чтобы тест проверял раскладку, а не генератор.
 */
function eight(): Match[] {
  const id = {
    u1: [11, 12, 13, 14],
    u2: [21, 22],
    u3: [31],
    l1: [41, 42],
    l2: [51, 52],
    l3: [61],
    l4: [71],
    gf: 81,
  };

  const seat = (
    matchId: number,
    bracket: Match['bracket'],
    round: number,
    slot: number,
    nextWinSlot: number | null,
    nextLoseSlot: number | null,
  ): Match => ({
    id: matchId,
    tournamentId: 1,
    bracket,
    round,
    slotInBracket: slot,
    playerA: null,
    playerB: null,
    poolId: null,
    status: 'pending',
    winnerId: null,
    isWalkover: false,
    isManualEdit: false,
    firstBanBy: null,
    nextWinSlot,
    nextLoseSlot,
    startedAt: null,
    finishedAt: null,
    targetScore: null,
    bansEach: null,
    scoreA: 0,
    scoreB: 0,
    bonusA: 0,
    bonusB: 0,
  });

  return [
    // Верхняя: победитель дальше по верхней, проигравший падает в нижнюю.
    seat(id.u1[0]!, 'upper', 1, 0, id.u2[0]!, id.l1[0]!),
    seat(id.u1[1]!, 'upper', 1, 1, id.u2[0]!, id.l1[0]!),
    seat(id.u1[2]!, 'upper', 1, 2, id.u2[1]!, id.l1[1]!),
    seat(id.u1[3]!, 'upper', 1, 3, id.u2[1]!, id.l1[1]!),
    seat(id.u2[0]!, 'upper', 2, 0, id.u3[0]!, id.l2[0]!),
    seat(id.u2[1]!, 'upper', 2, 1, id.u3[0]!, id.l2[1]!),
    seat(id.u3[0]!, 'upper', 3, 0, id.gf, id.l4[0]!),
    // Нижняя: проигравший вылетает, поэтому падений дальше нет.
    seat(id.l1[0]!, 'lower', 1, 0, id.l2[0]!, null),
    seat(id.l1[1]!, 'lower', 1, 1, id.l2[1]!, null),
    seat(id.l2[0]!, 'lower', 2, 0, id.l3[0]!, null),
    seat(id.l2[1]!, 'lower', 2, 1, id.l3[0]!, null),
    seat(id.l3[0]!, 'lower', 3, 0, id.l4[0]!, null),
    seat(id.l4[0]!, 'lower', 4, 0, id.gf, null),
    seat(id.gf, 'grand', 1, 0, null, null),
  ];
}

/**
 * Сетка на девять игроков — та, что получается после срезки лишнего.
 * Формы кривее, чем у полной: у верхней сетки одинокий матч первого раунда,
 * а падения из неё уходят через колонку. Связи именно здесь и путались.
 */
function pruned(): Match[] {
  const seat = (
    matchId: number,
    bracket: Match['bracket'],
    round: number,
    slot: number,
    nextWinSlot: number | null,
    nextLoseSlot: number | null,
  ): Match => ({
    id: matchId,
    tournamentId: 1,
    bracket,
    round,
    slotInBracket: slot,
    playerA: null,
    playerB: null,
    poolId: null,
    status: 'pending',
    winnerId: null,
    isWalkover: false,
    isManualEdit: false,
    firstBanBy: null,
    nextWinSlot,
    nextLoseSlot,
    startedAt: null,
    finishedAt: null,
    targetScore: null,
    bansEach: null,
    scoreA: 0,
    scoreB: 0,
    bonusA: 0,
    bonusB: 0,
  });

  return [
    seat(510, 'upper', 1, 0, 511, 518),
    seat(511, 'upper', 2, 0, 515, 518),
    seat(512, 'upper', 2, 1, 515, 519),
    seat(513, 'upper', 2, 2, 516, 520),
    seat(514, 'upper', 2, 3, 516, 520),
    seat(515, 'upper', 3, 0, 517, 521),
    seat(516, 'upper', 3, 1, 517, 522),
    seat(517, 'upper', 4, 0, 525, 524),
    seat(518, 'lower', 1, 0, 519, null),
    seat(519, 'lower', 2, 0, 521, null),
    seat(520, 'lower', 2, 1, 522, null),
    seat(521, 'lower', 3, 0, 523, null),
    seat(522, 'lower', 3, 1, 523, null),
    seat(523, 'lower', 4, 0, 524, null),
    seat(524, 'lower', 5, 0, 525, null),
    seat(525, 'grand', 1, 0, null, null),
  ];
}

/** Колонки по стороне и раунду — то, что и видно глазом на сетке. */
function columns(matches: Match[]): Record<string, number> {
  const layout = layoutBracket(matches);
  const out: Record<string, number> = {};
  for (const m of layout.shown) out[`${m.bracket}${m.round}`] = layout.columnOf(m);
  return out;
}

/** Отрезки пути «M x y (H x | V y)…» — маршрут может быть и с обходом. */
function segments(d: string) {
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
}

/** Вертикальные отрезки маршрута: именно они и сливаются в одну линию. */
function verticals(d: string) {
  return segments(d).filter((seg) => seg.x[0] === seg.x[1] && seg.y[1] > seg.y[0]);
}

/**
 * Проверки читаемости связей, одни и те же для любой сетки: линии не лежат
 * друг на друге и не проходят по карточкам.
 */
function expectReadableLinks(matches: Match[], where: string) {
  const layout = layoutBracket(matches);

  for (const a of layout.links) {
    for (const b of layout.links) {
      if (a.key >= b.key) continue;
      for (const va of verticals(a.d)) {
        for (const vb of verticals(b.d)) {
          if (va.x[0] !== vb.x[0]) continue;
          const overlap = Math.min(va.y[1], vb.y[1]) - Math.max(va.y[0], vb.y[0]);
          expect(overlap, `${where}: ${a.key} и ${b.key} идут по одной линии`).toBeLessThanOrEqual(
            0,
          );
        }
      }
    }
  }

  const cards = layout.shown.map((m) => ({
    id: m.id,
    left: layout.colX(layout.columnOf(m)),
    right: layout.colX(layout.columnOf(m)) + COL_W,
    top: layout.topOf(m),
    bottom: layout.topOf(m) + CARD_H,
  }));

  for (const link of layout.links) {
    // Свои карточки не считаем: связь из них и выходит.
    const own = link.key.split('-').slice(0, 2).map(Number);
    for (const card of cards) {
      if (own.includes(card.id)) continue;
      for (const seg of segments(link.d)) {
        const insideX = seg.x[1] > card.left + 1 && seg.x[0] < card.right - 1;
        const insideY = seg.y[1] > card.top + 1 && seg.y[0] < card.bottom - 1;
        expect(insideX && insideY, `${where}: ${link.key} проходит по карточке`).toBe(false);
      }
    }
  }
}

describe('раскладка двойной сетки', () => {
  it('ставит раунд тем правее, чем меньше играть после него', () => {
    // Нижняя R1 играется после верхней R1, поэтому стоит не под ней,
    // а на колонку правее — под верхней R2. Финал верхней и финал нижней
    // в одну колонку не попадают: сначала играют первый, потом второй.
    expect(columns(eight())).toEqual({
      upper1: 0,
      upper2: 1,
      upper3: 3,
      lower1: 1,
      lower2: 2,
      lower3: 3,
      lower4: 4,
      grand1: 5,
    });
  });

  it('все матчи одного раунда стоят в одной колонке', () => {
    const matches = eight();
    const layout = layoutBracket(matches);
    for (const m of layout.shown) {
      const sameRound = layout.shown.filter((x) => x.bracket === m.bracket && x.round === m.round);
      const seen = new Set(sameRound.map((x) => layout.columnOf(x)));
      expect(seen.size).toBe(1);
    }
  });

  it('кладёт нижнюю сетку целиком под верхнюю, не смешивая ряды', () => {
    const layout = layoutBracket(eight());
    const bottomOfUpper = Math.max(
      ...layout.shown.filter((m) => m.bracket === 'upper').map((m) => layout.topOf(m) + CARD_H),
    );
    const topOfLower = Math.min(
      ...layout.shown.filter((m) => m.bracket === 'lower').map((m) => layout.topOf(m)),
    );
    expect(topOfLower).toBeGreaterThan(bottomOfUpper);
  });

  it('держит гранд-финал на высоте финала верхней, а не между сетками', () => {
    const layout = layoutBracket(eight());
    const grand = layout.shown.find((m) => m.bracket === 'grand');
    const upperFinal = layout.shown.find((m) => m.bracket === 'upper' && m.round === 3);
    expect(grand).toBeDefined();
    expect(upperFinal).toBeDefined();
    expect(layout.topOf(grand!)).toBe(layout.topOf(upperFinal!));
  });

  it('не даёт матчам одной колонки наезжать друг на друга', () => {
    const layout = layoutBracket(eight());
    for (const m of layout.shown) {
      for (const x of layout.shown) {
        if (x.id === m.id || layout.columnOf(x) !== layout.columnOf(m)) continue;
        const gap = Math.abs(layout.topOf(x) - layout.topOf(m));
        expect(gap).toBeGreaterThanOrEqual(CARD_H);
      }
    }
  });

  it('центрирует матч между теми, кто в него проходит', () => {
    const layout = layoutBracket(eight());
    const centre = (id: number) => {
      const m = layout.shown.find((x) => x.id === id);
      return m === undefined ? 0 : layout.topOf(m) + CARD_H / 2;
    };
    // Верхняя R2-1 стоит по центру двух своих матчей первого раунда.
    expect(centre(21)).toBeCloseTo((centre(11) + centre(12)) / 2, 5);
    expect(centre(31)).toBeCloseTo((centre(21) + centre(22)) / 2, 5);
  });

  it('не даёт вертикалям связей лечь друг на друга', () => {
    // Вертикали уголков — главный источник каши на сетке. Две связи в один
    // матч делят вертикаль только когда приходят с разных сторон: тогда они
    // сходятся в точке, а не накладываются отрезками.
    expectReadableLinks(eight(), 'полная сетка');
  });

  it('держит связи читаемыми и на срезанной сетке', () => {
    // На нечётном составе раунды вырезаются, и связь может пойти через
    // колонку — прямо поверх её матчей, если не выбрать зазор для излома.
    expectReadableLinks(pruned(), 'срезанная сетка');
  });

  it('сводит в одну точку только связи с разных сторон матча', () => {
    // Победители двух матчей приходят в следующий сверху и снизу — это
    // турнирная скоба, и ломаться она должна на одной вертикали.
    const layout = layoutBracket(eight());
    const breakX = (d: string) => Number(/H (\S+) V/.exec(d)?.[1] ?? 0);

    const skoba = layout.links.filter((l) => l.key.endsWith('-win') && l.key.includes('-21-'));
    expect(skoba).toHaveLength(2);
    expect(breakX(skoba[0]!.d)).toBe(breakX(skoba[1]!.d));

    // А оба проигравших первого раунда падают в нижнюю сетку сверху —
    // общая вертикаль слепила бы их в одну линию.
    const drops = layout.links.filter((l) => l.key.endsWith('-lose') && l.key.includes('-41-'));
    expect(drops).toHaveLength(2);
    expect(breakX(drops[0]!.d)).not.toBe(breakX(drops[1]!.d));
  });

  it('не пускает ни одну линию по карточке матча', () => {
    // Линия, проходящая сквозь карточку, портит сетку сильнее пересечений:
    // она читается как часть чужого матча.
    expectReadableLinks(eight(), 'полная сетка');
  });

  it('вписывает всё полотно в свои размеры', () => {
    const layout = layoutBracket(eight());
    for (const m of layout.shown) {
      expect(layout.topOf(m)).toBeGreaterThanOrEqual(HEAD_H);
      expect(layout.topOf(m) + CARD_H).toBeLessThanOrEqual(layout.height);
    }
  });

  it('переживает сетку без нижней ветки и без гранд-финала', () => {
    const single = eight().filter((m) => m.bracket === 'upper' && m.round === 1);
    const only = single.map((m) => ({ ...m, nextWinSlot: null, nextLoseSlot: null }));
    const layout = layoutBracket(only);
    expect(layout.shown).toHaveLength(4);
    expect(new Set(only.map((m) => layout.columnOf(m)))).toEqual(new Set([0]));
    expect(layout.links).toHaveLength(0);
  });

  it('не показывает матч, который не сыграют: обе ветки закончились техпобедой', () => {
    const matches = eight().map((m) =>
      m.id === 71 ? { ...m, isWalkover: true, winnerId: null } : m,
    );
    const layout = layoutBracket(matches);
    expect(layout.shown.some((m) => m.id === 71)).toBe(false);
    expect(layout.links.some((l) => l.key.startsWith('71-'))).toBe(false);
  });
});
