// Хватит ли карт на матч по заданным правилам.
//
// Зеркалит src-tauri/src/db/feasible.rs — менять только парой. Правила
// и маппул задаются в разных местах, поэтому невыполнимую комбинацию
// легко собрать по частям: девять карт, по два бана каждому и игра до
// четырёх побед по отдельности выглядят разумно, а вместе не сходятся.

export interface Demand {
  /** Строк в маппуле без тайбрейка. */
  playable: number;
  hasTiebreaker: boolean;
  /** До скольких побед играем. */
  target: number;
  /** Банов на игрока. */
  bansEach: number;
}

/** Что не сходится. Пустой список — правила выполнимы. */
export function checkFeasible(d: Demand): string[] {
  const out: string[] = [];

  if (d.target < 1) out.push('Играть до нуля побед нельзя');
  if (d.bansEach < 0) out.push('Отрицательное число банов');
  if (d.target < 1 || d.bansEach < 0) return out;

  const bans = d.bansEach * 2;
  // Худший случай — счёт до последней карты: обоим нужно по target-1
  // победе, и только следующая карта заканчивает матч.
  const longest = d.target * 2 - 1;

  if (bans >= d.playable) {
    out.push(`Банов ${bans}, а играбельных карт ${d.playable} — банить будет нечего`);
    return out;
  }

  const left = d.playable - bans;
  // Тайбрейк закрывает ровно последнюю карту самой длинной серии.
  const need = d.hasTiebreaker ? longest - 1 : longest;

  if (left < need) {
    const tail = d.hasTiebreaker ? ' (не считая тайбрейк)' : '';
    out.push(
      `После банов останется ${left}, а до ${d.target} побед может понадобиться ${need}${tail}`,
    );
  }

  if (!d.hasTiebreaker && left === need) {
    out.push(
      'Тайбрейка в маппуле нет: при равном счёте решать будет последняя оставшаяся карта',
    );
  }

  return out;
}
