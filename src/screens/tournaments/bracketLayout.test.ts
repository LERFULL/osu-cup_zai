import { describe, expect, it } from 'vitest';
import type { Match } from '@/lib/types';
import { CARD_H, HEAD_H, layoutBracket } from './bracketLayout';

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
    scoreA: 0,
    scoreB: 0,
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

/** Колонки по стороне и раунду — то, что и видно глазом на сетке. */
function columns(matches: Match[]): Record<string, number> {
  const layout = layoutBracket(matches);
  const out: Record<string, number> = {};
  for (const m of layout.shown) out[`${m.bracket}${m.round}`] = layout.columnOf(m);
  return out;
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
