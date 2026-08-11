/**
 * Заглушки турнирной части для показа вёрстки в браузере.
 *
 * Повторяют правила из `src-tauri/src/db/{bracket,tournaments,matches}.rs`:
 * сетка, порядок банов и пиков, открытие тайбрейка, продвижение по сетке.
 * Без этого экран матча нельзя посмотреть глазами — а именно там больше
 * всего состояний. Настоящей базы здесь нет: всё живёт до перезагрузки.
 */

import type {
  Bracket,
  ByRound,
  Match,
  MatchAction,
  MatchRow,
  MatchState,
  Phase,
  Player,
  PlayerStats,
  RowState,
  RuleProblem,
  Standing,
  Tournament,
  TournamentPlayer,
} from './types';
import { checkFeasible } from './feasible';

type Args = Record<string, unknown>;

/** Палитра — та же, что в `db/players.rs`. */
const PALETTE = [
  '#ff6fb1',
  '#5bc8f5',
  '#7ed957',
  '#ffd03b',
  '#c77dff',
  '#ff6b6b',
  '#4dd6c1',
  '#f7913d',
];

/** Насыщенность и светлота по кругу — как в `db/players.rs`. */
const TONES: [number, number][] = [
  [0.62, 0.66],
  [0.78, 0.58],
  [0.52, 0.74],
];

/**
 * Цвет по номеру. Первые восемь — палитра, дальше считаем свои: на турнир
 * в двадцать человек восьми цветов не хватает, а повторы в сетке не различить.
 */
function colorAt(n: number): string {
  if (n < PALETTE.length) return PALETTE[n]!;

  const step = n - PALETTE.length;
  const hue = (196 + step * 137.508) % 360;
  const [sat, light] = TONES[step % TONES.length]!;

  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];

  const hex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

let nextId = 500;
const newId = () => nextId++;

interface DevMatch extends Match {
  actions: MatchAction[];
}

const players: Player[] = [];
const tournaments: Tournament[] = [];
const matches: DevMatch[] = [];

// ─────────────────────────────────────────────────────────────── сетка

/** Ближайшая степень двойки, не меньше `n`. */
function bracketSize(n: number): number {
  let size = 2;
  while (size < n) size *= 2;
  return size;
}

/** Порядок сеяния: 1 против последнего, сильные расходятся по половинам. */
function seedOrder(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const round = order.length * 2 + 1;
    const next: number[] = [];
    for (const s of order) {
      next.push(s);
      next.push(round - s);
    }
    order = next;
  }
  return order;
}

interface Seat {
  bracket: Match['bracket'];
  round: number;
  slot: number;
  playerA: number | null;
  playerB: number | null;
  nextWin: number | null;
  nextLose: number | null;
}

/** Сетка под фактический состав — та же схема, что в Rust. */
function buildSeats(size: number, seeded: (number | null)[]): Seat[] {
  const full = bracketSize(Math.max(size, 2));
  const order = seedOrder(full);
  const seats: Seat[] = [];

  const add = (
    bracket: Match['bracket'],
    round: number,
    slot: number,
    playerA: number | null = null,
    playerB: number | null = null,
  ) => {
    seats.push({ bracket, round, slot, playerA, playerB, nextWin: null, nextLose: null });
    return seats.length - 1;
  };

  const upper: number[][] = [];
  let round = 1;
  let width = full / 2;
  for (;;) {
    const row: number[] = [];
    for (let slot = 0; slot < width; slot++) {
      const a = round === 1 ? (seeded[(order[slot * 2] ?? 1) - 1] ?? null) : null;
      const b = round === 1 ? (seeded[(order[slot * 2 + 1] ?? 1) - 1] ?? null) : null;
      row.push(add('upper', round, slot, a, b));
    }
    upper.push(row);
    if (width === 1) break;
    width /= 2;
    round += 1;
  }

  const lower: number[][] = [];
  if (full >= 4) {
    let lowerWidth = full / 4;
    let lowerRound = 1;
    lower.push(Array.from({ length: lowerWidth }, (_, s) => add('lower', lowerRound, s)));

    let takeDrop = true;
    while (lowerWidth >= 1) {
      lowerRound += 1;
      const w = takeDrop ? lowerWidth : Math.floor(lowerWidth / 2);
      if (w === 0) break;
      lower.push(Array.from({ length: w }, (_, s) => add('lower', lowerRound, s)));
      if (!takeDrop) lowerWidth = Math.floor(lowerWidth / 2);
      takeDrop = !takeDrop;
      if (lowerWidth === 0) break;
    }
  }

  const grand = add('grand', 1, 0);

  upper.forEach((row, r) => {
    row.forEach((idx, slot) => {
      const seat = seats[idx];
      if (seat === undefined) return;
      seat.nextWin = r + 1 < upper.length ? (upper[r + 1]?.[slot >> 1] ?? grand) : grand;
      seat.nextLose =
        lower.length === 0
          ? null
          : r === 0
            ? (lower[0]?.[slot >> 1] ?? null)
            : (lower[r * 2 - 1]?.[slot] ?? null);
    });
  });

  lower.forEach((row, r) => {
    row.forEach((idx, slot) => {
      const seat = seats[idx];
      if (seat === undefined) return;
      const next = lower[r + 1];
      seat.nextWin =
        next === undefined ? grand : (next.length === row.length ? next[slot] : next[slot >> 1]) ?? grand;
    });
  });

  return prune(seats);
}

/**
 * Срезает со скелета всё, чего в этом составе не будет: матч, в который
 * приходит меньше двух участников, играть не с кем. Зеркалит `prune`
 * из `db/bracket.rs`.
 */
function prune(seats: Seat[]): Seat[] {
  // Кто придёт в матч: id известного игрока либо null — победитель матча,
  // который ещё не сыгран.
  const arrivals: (number | null)[][] = seats.map((s) =>
    [s.playerA, s.playerB].filter((p): p is number => p !== null),
  );

  // Ссылки идут только вперёд, поэтому хватает одного прохода.
  const kept = seats.map(() => false);
  seats.forEach((seat, i) => {
    const here = arrivals[i] ?? [];
    if (here.length === 1) {
      if (seat.nextWin !== null) arrivals[seat.nextWin]?.push(here[0] ?? null);
      return;
    }
    if (here.length === 0) return;

    kept[i] = true;
    for (const next of [seat.nextWin, seat.nextLose]) {
      if (next !== null) arrivals[next]?.push(null);
    }
  });

  // Пропущенные матчи прозрачны: их единственный участник едет дальше
  // по той же ссылке, поэтому идём по ней до настоящего матча.
  const resolve = (from: number): number | null => {
    let idx = from;
    for (;;) {
      if (kept[idx] === true) return idx;
      const next = seats[idx]?.nextWin ?? null;
      if (next === null || arrivals[idx]?.length !== 1) return null;
      idx = next;
    }
  };

  const index = seats.map(() => -1);
  const out: Seat[] = [];
  seats.forEach((seat, i) => {
    if (kept[i] !== true) return;
    index[i] = out.length;
    const here = arrivals[i] ?? [];
    out.push({ ...seat, playerA: here[0] ?? null, playerB: here[1] ?? null });
  });

  seats.forEach((seat, i) => {
    const at = index[i] ?? -1;
    if (at < 0) return;
    const target = out[at];
    if (target === undefined) return;

    const win = seat.nextWin === null ? null : resolve(seat.nextWin);
    const lose = seat.nextLose === null ? null : resolve(seat.nextLose);
    target.nextWin = win === null ? null : (index[win] ?? null);
    target.nextLose = lose === null ? null : (index[lose] ?? null);
  });

  renumber(out);
  return out;
}

/** Номера раундов и мест заново: после срезки в них появляются дыры. */
function renumber(seats: Seat[]): void {
  for (const bracket of ['upper', 'lower', 'grand'] as const) {
    const rounds = [...new Set(seats.filter((s) => s.bracket === bracket).map((s) => s.round))].sort(
      (a, b) => a - b,
    );
    for (const s of seats) {
      if (s.bracket === bracket) s.round = rounds.indexOf(s.round) + 1;
    }
  }

  let prev = '';
  let slot = 0;
  for (const s of seats) {
    const key = `${s.bracket}:${s.round}`;
    if (key !== prev) {
      prev = key;
      slot = 0;
    }
    s.slot = slot++;
  }
}

// ──────────────────────────────────────────────────────── общее чтение

const findT = (id: unknown): Tournament => {
  const found = tournaments.find((x) => x.id === id);
  if (!found) throw new Error('Турнир не найден');
  return found;
};

const findM = (id: unknown): DevMatch => {
  const found = matches.find((x) => x.id === id);
  if (!found) throw new Error('Матч не найден');
  return found;
};

const at = (rule: ByRound, round: number): number => rule.rounds[String(round)] ?? rule.default;

function freeColor(taken: string[]): string {
  for (let n = 0; n < 512; n++) {
    const candidate = colorAt(n);
    if (!taken.some((t) => t.toLowerCase() === candidate.toLowerCase())) return candidate;
  }
  return PALETTE[0]!;
}

/** Счёт по сыгранным картам — как в Rust, считается из журнала. */
function score(m: DevMatch): [number, number] {
  let a = 0;
  let b = 0;
  for (const x of m.actions) {
    if (x.type !== 'result') continue;
    if (x.winnerId === m.playerA) a += 1;
    if (x.winnerId === m.playerB) b += 1;
  }
  return [a, b];
}

/** Тайбрейк открывается, только когда оба в шаге от победы. */
function tiebreakerOpen(m: DevMatch, target: number): boolean {
  const [a, b] = score(m);
  return a === target - 1 && b === target - 1;
}

function other(m: DevMatch, playerId: number): number | null {
  return m.playerA === playerId ? m.playerB : m.playerA;
}

function phaseOf(m: DevMatch, target: number, bansTotal: number): Phase {
  if (m.status === 'finished') return { kind: 'finished', winner: m.winnerId };
  if (m.firstBanBy === null || m.poolId === null) return { kind: 'notStarted' };

  const second = other(m, m.firstBanBy);
  if (second === null) return { kind: 'notStarted' };

  // Чей ход по счёту: чётные достаются первому, нечётные — второму.
  const first = m.firstBanBy;
  const turn = (n: number) => (n % 2 === 0 ? first : second);

  const bans = m.actions.filter((x) => x.type === 'ban').length;
  if (bans < bansTotal * 2) {
    return { kind: 'ban', actor: turn(bans), done: bans, total: bansTotal * 2 };
  }

  const [a, b] = score(m);
  if (a >= target || b >= target) {
    return { kind: 'finished', winner: a >= target ? m.playerA : m.playerB };
  }

  const picks = m.actions.filter((x) => x.type === 'pick');
  const results = m.actions.filter((x) => x.type === 'result');
  const live = picks[picks.length - 1];
  if (live !== undefined && picks.length > results.length) {
    return { kind: 'result', slotLabel: live.slotLabel };
  }

  // Очередь сквозная: банил первым — пикает первым, иначе на стыке фаз
  // один и тот же игрок ходил бы дважды подряд.
  return { kind: 'pick', actor: turn(bans + picks.length) };
}

function rowsOf(m: DevMatch, target: number, poolOf: (id: number) => MatchRow[]): MatchRow[] {
  if (m.poolId === null) return [];

  const picks = m.actions.filter((x) => x.type === 'pick');
  const last = picks[picks.length - 1];
  const playing =
    last !== undefined && !m.actions.some((x) => x.type === 'result' && x.slotLabel === last.slotLabel)
      ? last.slotLabel
      : null;

  return poolOf(m.poolId).map((row) => {
    const ban = m.actions.find((x) => x.type === 'ban' && x.slotLabel === row.slotLabel);
    const result = m.actions.find((x) => x.type === 'result' && x.slotLabel === row.slotLabel);
    const pick = m.actions.find((x) => x.type === 'pick' && x.slotLabel === row.slotLabel);

    let state: RowState;
    if (result !== undefined) {
      state = { kind: 'played', winner: result.winnerId, n: result.n };
    } else if (playing === row.slotLabel) {
      state = { kind: 'playing', by: pick?.actorId ?? null };
    } else if (ban !== undefined) {
      state = { kind: 'banned', by: ban.actorId, n: ban.n };
    } else if (row.mod === 'TB' && !tiebreakerOpen(m, target)) {
      state = { kind: 'locked', hint: 'Откроется при равном счёте в шаге от победы' };
    } else {
      state = { kind: 'free' };
    }

    return { ...row, state };
  });
}

/** Садит игрока на первое свободное место — как seat_player в Rust. */
function seatPlayer(matchId: number | null, playerId: number | null) {
  if (matchId === null || playerId === null) return;
  const target = matches.find((x) => x.id === matchId);
  if (!target) return;
  if (target.playerA === playerId || target.playerB === playerId) return;
  if (target.playerA === null) target.playerA = playerId;
  else if (target.playerB === null) target.playerB = playerId;
}

function promote(m: DevMatch) {
  if (m.winnerId === null) return;
  const loser = m.playerA === m.winnerId ? m.playerB : m.playerA;
  seatPlayer(m.nextWinSlot, m.winnerId);
  seatPlayer(m.nextLoseSlot, loser);
}

/**
 * Закрывает матч и продвигает победителя. Если он был последним в сетке —
 * закрывает и турнир: как close + finish_if_done в Rust.
 */
function close(m: DevMatch, winnerId: number, walkover: boolean) {
  m.status = 'finished';
  m.winnerId = winnerId;
  m.isWalkover = walkover;
  m.finishedAt = new Date().toISOString();
  promote(m);

  const t = tournaments.find((x) => x.id === m.tournamentId);
  if (t !== undefined) {
    advanceWalkovers(t);
    finishIfDone(t);
  }
}

/** Сыграна ли сетка целиком. */
function allPlayed(t: Tournament): boolean {
  return matches
    .filter((m) => m.tournamentId === t.id)
    .every((m) => m.status === 'finished');
}

/**
 * Победитель турнира — тот, кто выиграл последний матч сетки. Спрашивать
 * про гранд-финал нельзя: на двоих его не бывает.
 */
function championOf(t: Tournament): number | null {
  const order = { grand: 0, lower: 1, upper: 2 } as const;
  const last = matches
    .filter((m) => m.tournamentId === t.id && m.nextWinSlot === null)
    .sort((x, y) => order[x.bracket] - order[y.bracket])[0];
  return last?.winnerId ?? null;
}

/** Раздаёт места: чем позже вылет, тем выше место — как finish в Rust. */
function finishTournament(t: Tournament) {
  const champion = championOf(t);
  for (const p of t.players) p.placement = null;

  const winner = t.players.find((p) => p.playerId === champion);
  if (winner !== undefined) winner.placement = 1;

  const order = { grand: 2, lower: 1, upper: 0 } as const;
  const byExit = matches
    .filter((m) => m.tournamentId === t.id && m.winnerId !== null)
    .sort(
      (x, y) =>
        order[y.bracket] - order[x.bracket] || y.round - x.round || x.slotInBracket - y.slotInBracket,
    );

  let place = 2;
  for (const m of byExit) {
    const loser = m.playerA === m.winnerId ? m.playerB : m.playerA;
    if (loser === null || loser === champion) continue;
    const seat = t.players.find((p) => p.playerId === loser);
    if (seat === undefined || seat.placement !== null) continue;
    seat.placement = place++;
  }

  t.status = 'finished';
  t.finishedAt = new Date().toISOString();
}

/** Закрывает турнир, если последний матч сыгран. */
function finishIfDone(t: Tournament) {
  if (t.status !== 'running' || !allPlayed(t)) return;
  finishTournament(t);
}

/** Отмена результата в последнем матче снимает и итоги турнира. */
function reopenIfFinished(t: Tournament) {
  if (t.status !== 'finished' || allPlayed(t)) return;
  for (const p of t.players) p.placement = null;
  t.status = 'running';
  t.finishedAt = null;
}

/** Пул раздаётся на раунд заранее — как assign_pools в Rust. */
function assignPools(t: Tournament) {
  if (t.poolIds.length === 0) return;

  const order = { upper: 0, lower: 1, grand: 2 } as const;
  const stages: string[] = [];
  for (const m of matches
    .filter((x) => x.tournamentId === t.id)
    .sort((x, y) => order[x.bracket] - order[y.bracket] || x.round - y.round)) {
    const key = `${m.bracket}:${m.round}`;
    if (!stages.includes(key)) stages.push(key);
  }

  for (const m of matches.filter((x) => x.tournamentId === t.id)) {
    if (m.poolId !== null) continue;
    const i = stages.indexOf(`${m.bracket}:${m.round}`);
    m.poolId = t.poolIds[i % t.poolIds.length] ?? null;
  }
}

/**
 * Техпобеды и матчи, в которые уже некому прийти — как advance_walkovers
 * в Rust. Матч без обоих игроков закрываем без победителя: иначе он
 * навсегда останется «ждёт соперника» и запрёт всё, что за ним.
 */
function advanceWalkovers(t: Tournament) {
  const mine = () => matches.filter((x) => x.tournamentId === t.id);
  const sourcesDone = (m: DevMatch) =>
    !mine().some(
      (src) =>
        (src.nextWinSlot === m.id || src.nextLoseSlot === m.id) && src.status !== 'finished',
    );

  for (;;) {
    const alone = mine().find(
      (m) =>
        m.status === 'pending' &&
        (m.playerA === null) !== (m.playerB === null) &&
        sourcesDone(m),
    );
    if (alone !== undefined) {
      close(alone, (alone.playerA ?? alone.playerB) as number, true);
      continue;
    }

    const empty = mine().find(
      (m) =>
        m.status === 'pending' &&
        m.playerA === null &&
        m.playerB === null &&
        mine().some((src) => src.nextWinSlot === m.id || src.nextLoseSlot === m.id) &&
        sourcesDone(m),
    );
    if (empty === undefined) break;

    empty.status = 'finished';
    empty.winnerId = null;
    empty.isWalkover = true;
    empty.finishedAt = new Date().toISOString();
  }
}

// ──────────────────────────────────────────────────────────── команды

export function tournamentHandlers(
  poolRows: (poolId: number) => MatchRow[],
  poolNames: () => { id: number; name: string }[],
): Record<string, (a: Args) => unknown> {
  const stateOf = (m: DevMatch): MatchState => {
    const t = findT(m.tournamentId);
    const target = at(t.targetScore, m.round);
    const bans = at(t.bansPerRound, m.round);
    const [scoreA, scoreB] = score(m);
    const phase = phaseOf(m, target, bans);

    // Матчпоинт — это «осталась одна победа», а у доигранного матча впереди
    // ничего не осталось.
    const matchPoint: number[] = [];
    if (phase.kind !== 'finished') {
      if (scoreA === target - 1 && m.playerA !== null) matchPoint.push(m.playerA);
      if (scoreB === target - 1 && m.playerB !== null) matchPoint.push(m.playerB);
    }

    return {
      ...m,
      scoreA,
      scoreB,
      tournamentName: t.name,
      players: t.players.filter((p) => p.playerId === m.playerA || p.playerId === m.playerB),
      rows: rowsOf(m, target, poolRows),
      actions: m.actions,
      phase,
      target,
      matchPoint,
    };
  };

  const push = (
    m: DevMatch,
    type: MatchAction['type'],
    actorId: number | null,
    slotLabel: string,
    winnerId: number | null,
  ) => {
    m.actions.push({
      n: m.actions.length + 1,
      type,
      actorId,
      slotLabel,
      winnerId,
      source: 'manual',
      at: new Date().toISOString(),
    });
  };

  const freeRow = (m: DevMatch, slotLabel: string) => {
    const row = stateOf(m).rows.find((r) => r.slotLabel === slotLabel);
    if (row === undefined) throw new Error(`в маппуле нет строки ${slotLabel}`);
    if (row.state.kind === 'locked') throw new Error(`${slotLabel} ещё закрыт`);
    if (row.state.kind !== 'free') throw new Error(`${slotLabel} уже разыгран`);
  };

  /** Сходятся ли правила с привязанными маппулами — как rule_problems в Rust. */
  const problemsOf = (t: Tournament): RuleProblem[] => {
    const rounds: (number | null)[] = [null];
    for (const key of [
      ...Object.keys(t.targetScore.rounds),
      ...Object.keys(t.bansPerRound.rounds),
    ]) {
      const n = Number(key);
      if (Number.isFinite(n) && !rounds.includes(n)) rounds.push(n);
    }

    const out: RuleProblem[] = [];
    for (const poolId of t.poolIds) {
      const rows = poolRows(poolId);
      const name = poolNames().find((p) => p.id === poolId)?.name ?? `маппул ${poolId}`;

      for (const round of rounds) {
        const target = round === null ? t.targetScore.default : at(t.targetScore, round);
        const bansEach = round === null ? t.bansPerRound.default : at(t.bansPerRound, round);

        // Раунд с теми же числами, что и общее правило, ничего не добавит.
        if (
          round !== null &&
          target === t.targetScore.default &&
          bansEach === t.bansPerRound.default
        ) {
          continue;
        }

        const notes = checkFeasible({
          playable: rows.filter((r) => r.mod !== 'TB').length,
          hasTiebreaker: rows.some((r) => r.mod === 'TB'),
          target,
          bansEach,
        });
        if (notes.length > 0) {
          out.push({ poolId, poolName: name, round, target, bansEach, notes });
        }
      }
    }
    return out;
  };

  /** Итоговая таблица — как standings в Rust. */
  const standingsOf = (t: Tournament): Standing[] => {
    if (t.status !== 'finished') return [];

    return t.players
      .map((p) => {
        const own = matches.filter(
          (m) => m.tournamentId === t.id && (m.playerA === p.playerId || m.playerB === p.playerId),
        );

        let mapWins = 0;
        let mapLosses = 0;
        let matchWins = 0;
        let matchLosses = 0;
        for (const m of own) {
          const [a, b] = score(m);
          const mine = m.playerA === p.playerId ? a : b;
          mapWins += mine;
          mapLosses += m.playerA === p.playerId ? b : a;
          if (m.status !== 'finished' || m.winnerId === null) continue;
          if (m.winnerId === p.playerId) matchWins += 1;
          else matchLosses += 1;
        }

        return {
          playerId: p.playerId,
          nickname: p.nickname,
          color: p.color,
          placement: p.placement ?? Number.MAX_SAFE_INTEGER,
          matchWins,
          matchLosses,
          mapWins,
          mapLosses,
        };
      })
      .sort(
        (x, y) =>
          x.placement - y.placement ||
          y.matchWins - x.matchWins ||
          x.nickname.localeCompare(y.nickname),
      );
  };

  const bracketOf = (t: Tournament): Bracket => ({
    ...t,
    matches: matches
      .filter((x) => x.tournamentId === t.id)
      .map((x) => {
        const [scoreA, scoreB] = score(x);
        return { ...x, scoreA, scoreB };
      }),
    problems: problemsOf(t),
    standings: standingsOf(t),
  });

  return {
    // ─────────────────────────────────────────────────────── игроки

    list_players: (a) =>
      players.filter((p) => (a['includeArchived'] === true ? true : !p.isArchived)),
    get_player: (a) => players.find((p) => p.id === a['id']) ?? null,

    create_player: (a) => {
      const made: Player = {
        id: newId(),
        nickname: String(a['nickname']),
        osuUserId: typeof a['osuUserId'] === 'number' ? a['osuUserId'] : null,
        color: freeColor(players.map((p) => p.color)),
        avatarPath: null,
        note: null,
        isArchived: false,
        createdAt: new Date().toISOString(),
      };
      players.push(made);
      return made;
    },

    update_player: (a) => {
      const p = players.find((x) => x.id === a['id']);
      if (!p) throw new Error('Игрок не найден');
      p.nickname = String(a['nickname']);
      p.osuUserId = typeof a['osuUserId'] === 'number' ? a['osuUserId'] : null;
      p.color = String(a['color']);
      p.note = typeof a['note'] === 'string' ? a['note'] : null;
      return undefined;
    },

    archive_player: (a) => {
      const p = players.find((x) => x.id === a['id']);
      if (p) p.isArchived = a['archived'] === true;
      return undefined;
    },

    // Аватары тянутся с a.ppy.sh — в браузерной песочнице их не достать,
    // поэтому в заглушке просто нечего показывать.
    fetch_player_avatar: (a) => {
      const p = players.find((x) => x.id === a['id']);
      if (!p) throw new Error('Игрок не найден');
      if (p.osuUserId === null) throw new Error('У игрока не указан ID профиля osu!');
      return p;
    },

    refresh_player_avatars: (a) =>
      players.filter((p) => (a['includeArchived'] === true ? true : !p.isArchived)),

    delete_player: (a) => {
      const played = tournaments.some((t) => t.players.some((p) => p.playerId === a['id']));
      if (played) throw new Error('Игрок уже участвовал в турнирах — убери его в архив');
      const i = players.findIndex((x) => x.id === a['id']);
      if (i >= 0) players.splice(i, 1);
      return undefined;
    },

    player_stats: (a): PlayerStats => {
      const id = a['id'] as number;
      const own = matches.filter((m) => m.playerA === id || m.playerB === id);
      const finished = own.filter((m) => m.status === 'finished');

      let maps = 0;
      let mapWins = 0;
      for (const m of own) {
        for (const x of m.actions) {
          if (x.type !== 'result') continue;
          maps += 1;
          if (x.winnerId === id) mapWins += 1;
        }
      }

      const versus = new Map<number, { wins: number; losses: number }>();
      for (const m of finished) {
        const foe = m.playerA === id ? m.playerB : m.playerA;
        if (foe === null) continue;
        const cell = versus.get(foe) ?? { wins: 0, losses: 0 };
        if (m.winnerId === id) cell.wins += 1;
        else cell.losses += 1;
        versus.set(foe, cell);
      }

      const mine = tournaments.filter((t) => t.players.some((p) => p.playerId === id));

      // Разбивка по модам: тег берём из строки маппула, как в Rust.
      const perMod = new Map<string, { played: number; won: number }>();
      for (const m of own) {
        const rows = m.poolId === null ? [] : poolRows(m.poolId);
        for (const x of m.actions) {
          if (x.type !== 'result') continue;
          const mod = rows.find((r) => r.slotLabel === x.slotLabel)?.mod;
          if (mod === undefined) continue;
          const cell = perMod.get(mod) ?? { played: 0, won: 0 };
          cell.played += 1;
          if (x.winnerId === id) cell.won += 1;
          perMod.set(mod, cell);
        }
      }

      return {
        playerId: id,
        tournaments: mine.length,
        tournamentWins: mine.filter(
          (t) => t.players.find((p) => p.playerId === id)?.placement === 1,
        ).length,
        placements: mine
          .map((t) => t.players.find((p) => p.playerId === id)?.placement ?? null)
          .filter((x): x is number => x !== null)
          .sort((x, y) => x - y),
        matches: finished.length,
        matchWins: finished.filter((m) => m.winnerId === id).length,
        maps,
        mapWins,
        bestMod: null,
        worstMod: null,
        favouriteBeatmap: null,
        byMod: [...perMod.entries()]
          .map(([mod, v]) => ({ mod, ...v }))
          .sort((x, y) => x.mod.localeCompare(y.mod)),
        history: mine.map((t) => {
          const inThis = finished.filter((m) => m.tournamentId === t.id);
          return {
            tournamentId: t.id,
            tournamentName: t.name,
            finishedAt: t.finishedAt,
            placement: t.players.find((p) => p.playerId === id)?.placement ?? null,
            matches: inThis.length,
            matchWins: inThis.filter((m) => m.winnerId === id).length,
          };
        }),
        versus: [...versus.entries()].map(([playerId, v]) => ({
          playerId,
          nickname: players.find((p) => p.id === playerId)?.nickname ?? 'игрок',
          ...v,
        })),
      };
    },

    // ────────────────────────────────────────────────────── турниры

    list_tournaments: () => tournaments,
    get_tournament: (a) => findT(a['id']),

    create_tournament: (a) => {
      const made: Tournament = {
        id: newId(),
        name: String(a['name']),
        status: 'draft',
        bracketSize: 0,
        targetScore: { default: Number(a['targetScore']) || 4, rounds: {} },
        bansPerRound: { default: Number(a['bansPerRound']) || 1, rounds: {} },
        firstBan: 'random',
        noRepeatPool: true,
        createdAt: new Date().toISOString(),
        finishedAt: null,
        players: [],
        poolIds: [],
      };
      tournaments.push(made);
      return made;
    },

    rename_tournament: (a) => {
      findT(a['id']).name = String(a['name']);
      return undefined;
    },

    set_tournament_rules: (a) => {
      const t = findT(a['id']);
      t.targetScore = a['targetScore'] as ByRound;
      t.bansPerRound = a['bansPerRound'] as ByRound;
      t.firstBan = a['firstBan'] as Tournament['firstBan'];
      t.noRepeatPool = a['noRepeatPool'] === true;
      return t;
    },

    delete_tournament: (a) => {
      const i = tournaments.findIndex((x) => x.id === a['id']);
      if (i >= 0) tournaments.splice(i, 1);
      for (let k = matches.length - 1; k >= 0; k--) {
        if (matches[k]?.tournamentId === a['id']) matches.splice(k, 1);
      }
      return undefined;
    },

    add_tournament_player: (a) => {
      const t = findT(a['id']);
      if (t.status !== 'draft') throw new Error('Состав закрыт: сетка уже построена');
      const p = players.find((x) => x.id === a['playerId']);
      if (!p) throw new Error('Игрок не найден');
      if (t.players.some((x) => x.playerId === p.id)) return undefined;

      const seat: TournamentPlayer = {
        playerId: p.id,
        nickname: p.nickname,
        seed: null,
        // Цвет в турнире свой: одинаковые в сетке не различить.
        color: freeColor(t.players.map((x) => x.color)),
        placement: null,
      };
      t.players.push(seat);
      return undefined;
    },

    remove_tournament_player: (a) => {
      const t = findT(a['id']);
      if (t.status !== 'draft') throw new Error('Состав закрыт: сетка уже построена');
      t.players = t.players.filter((x) => x.playerId !== a['playerId']);
      return undefined;
    },

    set_tournament_seeds: (a) => {
      const t = findT(a['id']);
      const order = (a['order'] as number[]) ?? [];
      t.players.sort((x, y) => order.indexOf(x.playerId) - order.indexOf(y.playerId));
      t.players.forEach((p, i) => {
        p.seed = i + 1;
      });
      return undefined;
    },

    set_tournament_player_color: (a) => {
      const seat = findT(a['id']).players.find((x) => x.playerId === a['playerId']);
      if (seat) seat.color = String(a['color']);
      return undefined;
    },

    set_tournament_pools: (a) => {
      findT(a['id']).poolIds = (a['poolIds'] as number[]) ?? [];
      return undefined;
    },

    start_tournament: (a) => {
      const t = findT(a['id']);
      if (t.players.length < 2) throw new Error('Для сетки нужно хотя бы два игрока');

      const size = bracketSize(t.players.length);
      const seeded: (number | null)[] = Array.from({ length: size }, (_, i) => {
        const p = t.players[i];
        return p === undefined ? null : p.playerId;
      });

      const seats = buildSeats(size, seeded);
      const ids = seats.map(() => newId());

      for (let k = matches.length - 1; k >= 0; k--) {
        if (matches[k]?.tournamentId === t.id) matches.splice(k, 1);
      }

      seats.forEach((seat, i) => {
        matches.push({
          id: ids[i]!,
          tournamentId: t.id,
          bracket: seat.bracket,
          round: seat.round,
          slotInBracket: seat.slot,
          playerA: seat.playerA,
          playerB: seat.playerB,
          poolId: null,
          status: 'pending',
          winnerId: null,
          isWalkover: false,
          isManualEdit: false,
          firstBanBy: null,
          nextWinSlot: seat.nextWin === null ? null : (ids[seat.nextWin] ?? null),
          nextLoseSlot: seat.nextLose === null ? null : (ids[seat.nextLose] ?? null),
          startedAt: null,
          finishedAt: null,
          scoreA: 0,
          scoreB: 0,
          actions: [],
        });
      });

      // Сетка построена, но турнир ещё не идёт: её можно рассмотреть
      // и пересобрать. Играть по ней разрешает только confirm.
      t.status = 'seeded';
      t.bracketSize = size;

      assignPools(t);
      advanceWalkovers(t);
      return bracketOf(t);
    },

    confirm_tournament: (a) => {
      const t = findT(a['id']);
      if (t.status !== 'seeded') {
        throw new Error('Запускать можно только построенную, но ещё не начатую сетку');
      }
      t.status = 'running';
      return bracketOf(t);
    },

    reopen_tournament: (a) => {
      const t = findT(a['id']);
      const played = matches.some((m) => m.tournamentId === t.id && m.actions.length > 0);
      if (played) throw new Error('В сетке уже играли — пересобрать её значит потерять результаты');

      for (let k = matches.length - 1; k >= 0; k--) {
        if (matches[k]?.tournamentId === t.id) matches.splice(k, 1);
      }
      t.status = 'draft';
      t.bracketSize = 0;
      return bracketOf(t);
    },

    tournament_bracket: (a) => bracketOf(findT(a['id'])),

    /** Карты, попавшие сразу в несколько маппулов турнира. */
    tournament_pool_overlaps: (a) => {
      const t = findT(a['id']);
      const where = new Map<number, Set<string>>();

      for (const id of t.poolIds) {
        const name = poolNames().find((p) => p.id === id)?.name ?? `маппул ${id}`;
        for (const row of poolRows(id)) {
          const beatmapId = row.beatmap?.beatmapId;
          if (beatmapId === undefined) continue;
          const seen = where.get(beatmapId) ?? new Set<string>();
          seen.add(name);
          where.set(beatmapId, seen);
        }
      }

      return [...where.entries()]
        .filter(([, pools]) => pools.size > 1)
        .map(([beatmapId, pools]) => {
          const row = t.poolIds
            .flatMap((id) => poolRows(id))
            .find((r) => r.beatmap?.beatmapId === beatmapId);
          const map = row?.beatmap;
          return {
            beatmapId,
            name: map ? `${map.artist} — ${map.title}` : `карта ${beatmapId}`,
            pools: [...pools],
          };
        });
    },

    finish_tournament: (a) => {
      const t = findT(a['id']);
      finishTournament(t);
      return t;
    },

    // ───────────────────────────────────────────────────────── матч

    match_state: (a) => stateOf(findM(a['id'])),

    set_match_pool: (a) => {
      const m = findM(a['id']);
      if (m.actions.length > 0) throw new Error('Матч уже начали — маппул не сменить');
      m.poolId = typeof a['poolId'] === 'number' ? a['poolId'] : null;
      return stateOf(m);
    },

    set_match_first_ban: (a) => {
      const m = findM(a['id']);
      if (m.actions.length > 0) throw new Error('Матч уже начали');
      m.firstBanBy = a['playerId'] as number;
      m.status = 'running';
      m.startedAt ??= new Date().toISOString();
      return stateOf(m);
    },

    ban_slot: (a) => {
      const m = findM(a['id']);
      const phase = stateOf(m).phase;
      if (phase.kind !== 'ban') throw new Error('Сейчас не фаза банов');
      const slot = String(a['slotLabel']);
      freeRow(m, slot);
      push(m, 'ban', phase.actor, slot, null);
      return stateOf(m);
    },

    pick_slot: (a) => {
      const m = findM(a['id']);
      const phase = stateOf(m).phase;
      if (phase.kind !== 'pick') throw new Error('Сейчас не фаза пиков');
      const slot = String(a['slotLabel']);
      freeRow(m, slot);
      push(m, 'pick', phase.actor, slot, null);
      return stateOf(m);
    },

    record_result: (a) => {
      const m = findM(a['id']);
      const phase = stateOf(m).phase;
      if (phase.kind !== 'result') throw new Error('Сейчас нечего засчитывать');
      push(m, 'result', null, phase.slotLabel, a['winnerId'] as number);

      const after = stateOf(m);
      if (after.phase.kind === 'finished' && after.phase.winner !== null) {
        close(m, after.phase.winner, false);
      }
      return stateOf(m);
    },

    undo_match_action: (a) => {
      const m = findM(a['id']);
      m.actions.pop();

      // Матч мог быть закрыт этим действием — открываем обратно вместе
      // с местами в следующих матчах сетки.
      if (m.winnerId !== null) {
        const loser = m.playerA === m.winnerId ? m.playerB : m.playerA;
        for (const [next, who] of [
          [m.nextWinSlot, m.winnerId],
          [m.nextLoseSlot, loser],
        ] as [number | null, number | null][]) {
          if (next === null || who === null) continue;
          const target = matches.find((x) => x.id === next);
          if (!target) continue;
          if (target.playerA === who) target.playerA = null;
          if (target.playerB === who) target.playerB = null;
        }
        m.winnerId = null;
        m.isWalkover = false;
        m.finishedAt = null;
      }
      m.status = m.actions.length > 0 ? 'running' : 'pending';

      // Этот матч мог быть последним в сетке — турнир уже подвёл итоги.
      const t = tournaments.find((x) => x.id === m.tournamentId);
      if (t !== undefined) reopenIfFinished(t);
      return stateOf(m);
    },

    set_match_walkover: (a) => {
      const m = findM(a['id']);
      m.actions.length = 0;
      close(m, a['winnerId'] as number, true);
      return stateOf(m);
    },

    set_match_manual_result: (a) => {
      const m = findM(a['id']);
      const winner = a['winnerId'] as number;
      const scoreA = Number(a['scoreA']);
      const scoreB = Number(a['scoreB']);

      // Ручной счёт заменяет журнал: держать половину истории хуже, чем никакой.
      m.actions.length = 0;
      for (let i = 0; i < scoreA; i++) push(m, 'result', null, `ручной ${i + 1}`, m.playerA);
      for (let i = 0; i < scoreB; i++) push(m, 'result', null, `ручной ${scoreA + i + 1}`, m.playerB);

      m.isManualEdit = true;
      close(m, winner, false);
      return stateOf(m);
    },

    // Список маппулов нужен экрану матча и сборке турнира.
    __pool_names: () => poolNames(),
  };
}
