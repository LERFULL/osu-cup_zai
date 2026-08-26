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
  EditorBye,
  EditorCheck,
  EditorRound,
  EditorState,
  Match,
  MatchAction,
  MatchRow,
  MatchState,
  Phase,
  Player,
  PlayerStats,
  PoolOverlap,
  RowState,
  RuleProblem,
  Standing,
  Tournament,
  TournamentEdit,
  PrizeConfig,
  PrizeView,
} from './types';
import { checkFeasible } from './feasible';
import { freeColor } from './colors';
import { plural } from './format';

type Args = Record<string, unknown>;

let nextId = 500;
const newId = () => nextId++;

interface DevMatch extends Match {
  actions: MatchAction[];
}

const players: Player[] = [];
const tournaments: Tournament[] = [];
const matches: DevMatch[] = [];

/** Переходящий джекпот заглушки: в браузере всегда пустой. */
const mockJackpot = 0;

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

/**
 * Состав с живыми ником и аватаром: в Rust они приходят JOIN'ом с players,
 * поэтому копия внутри турнира устаревала бы после переименования или после
 * подтянутого аватара.
 */
const roster = (t: Tournament): Tournament['players'] =>
  t.players.map((seat) => {
    const p = players.find((x) => x.id === seat.playerId);
    return p === undefined ? seat : { ...seat, nickname: p.nickname, avatarPath: p.avatarPath };
  });

const findM = (id: unknown): DevMatch => {
  const found = matches.find((x) => x.id === id);
  if (!found) throw new Error('Матч не найден');
  return found;
};

/** Задано ли своё значение для этого раунда — как ByRound::own на Rust. */
const ownRule = (rule: ByRound, bracket: Match['bracket'], round: number): number | null =>
  rule.rounds[`${bracket}:${round}`] ?? rule.rounds[String(round)] ?? null;

/** Значение правила для раунда сетки — как ByRound::at_key на Rust. */
const atKey = (rule: ByRound, bracket: Match['bracket'], round: number): number =>
  ownRule(rule, bracket, round) ?? rule.default;

/** Правило матча: взятое на старте, а у неначатого — турнирное. */
function ruleOf(m: DevMatch): [number, number] {
  const t = findT(m.tournamentId);
  return [
    m.targetScore ?? atKey(t.targetScore, m.bracket, m.round),
    m.bansEach ?? atKey(t.bansPerRound, m.bracket, m.round),
  ];
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

/**
 * Преимущество сетки в гранд-финале: победы, которые матч решают, но
 * сыгранными картами не являются. Считается отдельно от счёта — иначе
 * попало бы в покартовую статистику.
 */
function bonus(m: DevMatch): [number, number] {
  if (m.bracket !== 'grand') return [0, 0];
  const t = tournaments.find((x) => x.id === m.tournamentId);
  const advantage = t?.grandAdvantage ?? 0;
  if (advantage <= 0) return [0, 0];

  const fromUpper = matches.find(
    (x) => x.tournamentId === m.tournamentId && x.bracket === 'upper' && x.nextWinSlot === m.id,
  )?.winnerId;
  if (fromUpper === null || fromUpper === undefined) return [0, 0];
  if (fromUpper === m.playerA) return [advantage, 0];
  if (fromUpper === m.playerB) return [0, advantage];
  return [0, 0];
}

/** Счёт вместе с преимуществом: по нему матч и решается. */
function standing(m: DevMatch): [number, number] {
  const [a, b] = score(m);
  const [ba, bb] = bonus(m);
  return [a + ba, b + bb];
}

/** Тайбрейк открывается, только когда оба в шаге от победы. */
function tiebreakerOpen(m: DevMatch, target: number): boolean {
  const [a, b] = standing(m);
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

  const [a, b] = standing(m);
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

/** Раунды турнира в порядке игры. */
function stagesOf(t: Tournament): [Match['bracket'], number][] {
  const order = { upper: 0, lower: 1, grand: 2 } as const;
  const out: [Match['bracket'], number][] = [];
  for (const m of matches
    .filter((x) => x.tournamentId === t.id)
    .sort((x, y) => order[x.bracket] - order[y.bracket] || x.round - y.round)) {
    if (!out.some(([b, r]) => b === m.bracket && r === m.round)) out.push([m.bracket, m.round]);
  }
  if (out.length > 0) return out;

  // Сетки ещё нет — считаем раунды по составу: править правило финала,
  // не собрав сетку, нормально.
  if (t.players.length < 2) return [];
  for (const seat of buildSeats(t.players.length, seatOrder(t))) {
    if (!out.some(([b, r]) => b === seat.bracket && r === seat.round)) {
      out.push([seat.bracket, seat.round]);
    }
  }
  return out.sort(([ba, ra], [bb, rb]) => order[ba] - order[bb] || ra - rb);
}

/** Места сеяния: у кого номер задан — по нему, остальных доливаем по списку. */
function seatOrder(t: Tournament): (number | null)[] {
  const size = bracketSize(Math.max(t.players.length, 2));
  const seats: (number | null)[] = Array.from({ length: size }, () => null);
  const rest: number[] = [];

  for (const p of t.players) {
    const seed = p.seed;
    if (seed !== null && seed >= 1 && seed <= size && seats[seed - 1] === null) {
      seats[seed - 1] = p.playerId;
    } else {
      rest.push(p.playerId);
    }
  }
  for (const id of rest) {
    const free = seats.indexOf(null);
    if (free >= 0) seats[free] = id;
  }
  return seats;
}

/**
 * Пул раздаётся на раунд заранее — как assign_pools в Rust. Раунд с
 * закреплённым пулом берёт его и в круге не участвует: привязка сильнее.
 */
function assignPools(t: Tournament) {
  if (t.poolIds.length === 0) return;

  const bound = Object.values(t.poolByRound);
  const free = t.poolIds.filter((pool) => !bound.includes(pool));
  const cycle = free.length > 0 ? free : t.poolIds;

  let n = 0;
  for (const [bracket, round] of stagesOf(t)) {
    const key = `${bracket}:${round}`;
    const pool = t.poolByRound[key] ?? cycle[n++ % cycle.length] ?? null;
    for (const m of matches) {
      if (m.tournamentId !== t.id || m.bracket !== bracket || m.round !== round) continue;
      if (m.poolId === null) m.poolId = pool;
    }
  }
}

/** Раскладывает маппулы заново, не трогая начатые матчи. */
function reassignPools(t: Tournament) {
  for (const m of matches) {
    if (m.tournamentId !== t.id) continue;
    if (m.actions.length === 0 && m.status !== 'finished') m.poolId = null;
  }
  assignPools(t);
}

/**
 * Собирает сетку по текущему составу. Зовётся и при первом построении, и при
 * правке состава: сетка — это предпросмотр, и отвечать на правку она должна
 * сразу.
 */
function buildBracket(t: Tournament) {
  if (t.players.length < 2) throw new Error('Для сетки нужно хотя бы два игрока');

  const seats = buildSeats(t.players.length, seatOrder(t));
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
      targetScore: null,
      bansEach: null,
      lobbyId: null,
      scoreA: 0,
      scoreB: 0,
      bonusA: 0,
      bonusB: 0,
      actions: [],
    });
  });

  // Кто прошёл первый раунд без игры: матча у него нет, а знать надо.
  t.byeSeeds = t.players
    .map((p, i) => ({ seed: p.seed ?? i + 1, playerId: p.playerId }))
    .filter(
      ({ playerId }) =>
        !seats.some(
          (s) =>
            s.bracket === 'upper' &&
            s.round === 1 &&
            (s.playerA === playerId || s.playerB === playerId),
        ),
    )
    .map(({ seed }) => seed);

  if (t.status === 'draft') t.status = 'seeded';
  t.bracketSize = t.players.length;

  assignPools(t);
  advanceWalkovers(t);
}

/** Пересобирает сетку, пока она только построена: правку видно сразу. */
function rebuildIfSeeded(t: Tournament) {
  if (t.status === 'seeded') buildBracket(t);
}

/** Номера сеяния подряд с первого: сеяние — это порядок, а не метка. */
function writeSeeds(t: Tournament, order: number[]) {
  t.players.sort((x, y) => order.indexOf(x.playerId) - order.indexOf(y.playerId));
  t.players.forEach((p, i) => {
    p.seed = i + 1;
  });
}

/**
 * Правка состава и сетки: до старта свободно, после — только аварийная.
 * Возвращает, идёт ли турнир.
 */
function structural(t: Tournament, emergency: boolean): boolean {
  const live = t.status === 'running' || t.status === 'finished';
  if (live && !emergency) {
    throw new Error(
      'Турнир уже идёт — включи аварийную правку, чтобы менять состав и сетку',
    );
  }
  return live;
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

// ────────────────────────────────────────────────────── журнал правок

/** Снимок турнира: сам турнир и его матчи целиком. */
interface Snapshot {
  tournament: Tournament;
  matches: DevMatch[];
}

interface DevEdit extends TournamentEdit {
  before: Snapshot;
  /** Отпечаток сыгранного сразу после правки: по нему видно, играли ли потом. */
  play: string;
}

const editLog = new Map<number, DevEdit[]>();

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function snapshotOf(t: Tournament): Snapshot {
  return {
    tournament: clone(t),
    matches: matches.filter((m) => m.tournamentId === t.id).map(clone),
  };
}

function restoreSnapshot(t: Tournament, snap: Snapshot) {
  Object.assign(t, clone(snap.tournament));
  for (let k = matches.length - 1; k >= 0; k--) {
    if (matches[k]?.tournamentId === t.id) matches.splice(k, 1);
  }
  matches.push(...snap.matches.map(clone));
}

/**
 * Отпечаток сыгранного: матч и число действий в нём. Время для этого не
 * годится — правку и следующий за ней бан разделяют миллисекунды.
 */
function playState(t: Tournament): string {
  return matches
    .filter((m) => m.tournamentId === t.id && m.actions.length > 0)
    .sort((x, y) => x.id - y.id)
    .map((m) => `${m.id}:${m.actions.length}`)
    .join(',');
}

function pushEdit(
  t: Tournament,
  kind: string,
  emergency: boolean,
  note: string,
  before: Snapshot,
): number {
  const list = editLog.get(t.id) ?? [];
  const n = list.length + 1;
  list.push({
    n,
    kind,
    at: new Date().toISOString(),
    emergency,
    note,
    undoneBy: null,
    before,
    play: playState(t),
  });
  editLog.set(t.id, list);
  return n;
}

/** Последняя правка, которую ещё можно отменить. */
function lastUndoable(t: Tournament): DevEdit | undefined {
  return [...(editLog.get(t.id) ?? [])]
    .reverse()
    .find((e) => e.undoneBy === null && e.kind !== 'undo');
}

/** Сколько матчей трогали после правки. */
function playedSince(t: Tournament, marker: string): number {
  const parse = (raw: string) =>
    new Map(
      raw
        .split(',')
        .filter((part) => part !== '')
        .map((part) => part.split(':') as [string, string]),
    );

  const was = parse(marker);
  const now = parse(playState(t));
  let touched = 0;
  for (const [id, count] of now) if (was.get(id) !== count) touched += 1;
  for (const id of was.keys()) if (!now.has(id)) touched += 1;
  return touched;
}

function undoBlocked(t: Tournament): string | null {
  const last = lastUndoable(t);
  if (last === undefined) return 'правок пока нет';
  const played = playedSince(t, last.play);
  if (played === 0) return null;
  return `после этой правки сыграли ${played} ${plural(played, 'матч', 'матча', 'матчей')} — отменяй их сначала`;
}

function undoLastEdit(t: Tournament) {
  const last = lastUndoable(t);
  if (last === undefined) throw new Error('Отменять нечего: правок нет');

  const played = playedSince(t, last.play);
  if (played > 0) {
    throw new Error(
      `После этой правки сыграли ${played} ${plural(played, 'матч', 'матча', 'матчей')} — отмени их сначала`,
    );
  }

  const now = snapshotOf(t);
  restoreSnapshot(t, last.before);
  // Запись не исчезает: рядом ложится парная отмена, а у правки — ссылка на неё.
  last.undoneBy = pushEdit(t, 'undo', false, `отмена правки ${last.n}: ${last.note}`, now);
}

/**
 * Название раунда с указанием ряда. Зеркалит round_title в
 * `db/tournaments.rs`: в таблице раундов «Полуфинал» без ряда встречается
 * дважды, и какой из них верхний — не видно.
 */
function roundTitle(bracket: Match['bracket'], round: number, last: number): string {
  if (bracket === 'grand') return 'Гранд-финал';
  const upper = bracket === 'upper';
  const left = last - round;
  if (left === 0) return upper ? 'Финал верхней' : 'Финал нижней';
  if (left === 1) return upper ? 'Верхняя, полуфинал' : 'Нижняя, полуфинал';
  return upper ? `Верхняя, раунд ${round}` : `Нижняя, раунд ${round}`;
}

/** Название матча так, как он подписан на сетке. */
function titleOf(m: DevMatch): string {
  const mine = matches.filter((x) => x.tournamentId === m.tournamentId);
  const last = Math.max(...mine.filter((x) => x.bracket === m.bracket).map((x) => x.round), 0);
  const siblings = mine.filter((x) => x.bracket === m.bracket && x.round === m.round).length;
  const title = roundTitle(m.bracket, m.round, last);
  return siblings > 1 ? `${title}, матч ${m.slotInBracket + 1}` : title;
}

/** Матчи, куда этот уже отправил игроков: обход сетки вперёд. */
function forward(m: DevMatch): DevMatch[] {
  const out: DevMatch[] = [];
  if (m.winnerId === null) return out;
  const loser = m.playerA === m.winnerId ? m.playerB : m.playerA;

  for (const [next, who] of [
    [m.nextWinSlot, m.winnerId],
    [m.nextLoseSlot, loser],
  ] as [number | null, number | null][]) {
    if (next === null || who === null) continue;
    const target = matches.find((x) => x.id === next);
    if (target === undefined) continue;
    if (!out.includes(target)) out.push(target);
    for (const deeper of forward(target)) if (!out.includes(deeper)) out.push(deeper);
  }
  return out;
}

/** Возвращает матч в ожидание и снимает всё, что он раздал вперёд. */
function wipe(m: DevMatch) {
  if (m.winnerId !== null) {
    const loser = m.playerA === m.winnerId ? m.playerB : m.playerA;
    for (const [next, who] of [
      [m.nextWinSlot, m.winnerId],
      [m.nextLoseSlot, loser],
    ] as [number | null, number | null][]) {
      if (next === null || who === null) continue;
      const target = matches.find((x) => x.id === next);
      if (target === undefined) continue;
      wipe(target);
      if (target.playerA === who) target.playerA = null;
      if (target.playerB === who) target.playerB = null;
    }
  }

  m.actions.length = 0;
  m.status = 'pending';
  m.winnerId = null;
  m.isWalkover = false;
  m.isManualEdit = false;
  m.firstBanBy = null;
  m.startedAt = null;
  m.finishedAt = null;
  m.targetScore = null;
  m.bansEach = null;
  // Маппул остаётся: снос результата — это «переиграть», а не «выбрать заново».
}

// ──────────────────────────────────────────────────────────── команды

/** Чем турнирная часть заглушки ходит в маппулы. */
export interface PoolAccess {
  rows: (poolId: number) => MatchRow[];
  list: () => { id: number; name: string; isLocked: boolean }[];
  series: (seriesId: number) => { name: string; poolIds: number[] };
  overlaps: (poolIds: number[]) => PoolOverlap[];
}

export function tournamentHandlers(pools: PoolAccess): Record<string, (a: Args) => unknown> {
  const poolRows = pools.rows;
  const poolName = (id: number) =>
    pools.list().find((p) => p.id === id)?.name ?? `маппул ${id}`;

  const stateOf = (m: DevMatch): MatchState => {
    const t = findT(m.tournamentId);
    const [target, bans] = ruleOf(m);
    const [scoreA, scoreB] = score(m);
    const [bonusA, bonusB] = bonus(m);
    const phase = phaseOf(m, target, bans);

    // Матчпоинт — это «осталась одна победа», а у доигранного матча впереди
    // ничего не осталось.
    const matchPoint: number[] = [];
    if (phase.kind !== 'finished') {
      if (scoreA + bonusA === target - 1 && m.playerA !== null) matchPoint.push(m.playerA);
      if (scoreB + bonusB === target - 1 && m.playerB !== null) matchPoint.push(m.playerB);
    }

    return {
      ...m,
      scoreA,
      scoreB,
      bonusA,
      bonusB,
      tournamentName: t.name,
      players: roster(t).filter((p) => p.playerId === m.playerA || p.playerId === m.playerB),
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

  /**
   * Раунды турнира со своими правилами и маппулами — как round_rules в Rust.
   * До построения сетки считаются по составу.
   */
  const roundsOf = (t: Tournament): EditorRound[] => {
    const stages = stagesOf(t);
    const lastOf = (bracket: Match['bracket']) =>
      Math.max(...stages.filter(([b]) => b === bracket).map(([, r]) => r), 0);

    const bound = Object.values(t.poolByRound);
    const free = t.poolIds.filter((pool) => !bound.includes(pool));
    const cycle = free.length > 0 ? free : t.poolIds;
    let n = 0;

    return stages.map(([bracket, round]) => {
      const key = `${bracket}:${round}`;
      const own = t.poolByRound[key] ?? null;
      const byCycle = own ?? (cycle.length === 0 ? null : (cycle[n++ % cycle.length] ?? null));

      const mine = matches.filter(
        (m) => m.tournamentId === t.id && m.bracket === bracket && m.round === round,
      );
      // Матч мог получить свой маппул руками — тогда играется он.
      const playing = mine.find((m) => m.poolId !== null)?.poolId ?? byCycle;

      const rows = playing === null ? [] : poolRows(playing);
      const playable = rows.filter((r) => r.mod !== 'TB' && r.beatmap !== null).length;
      const hasTiebreaker = rows.some((r) => r.mod === 'TB' && r.beatmap !== null);

      const target = atKey(t.targetScore, bracket, round);
      const bans = atKey(t.bansPerRound, bracket, round);

      return {
        key,
        bracket,
        round,
        title: roundTitle(bracket, round, lastOf(bracket)),
        target,
        bans,
        targetOwn: ownRule(t.targetScore, bracket, round) !== null,
        bansOwn: ownRule(t.bansPerRound, bracket, round) !== null,
        poolId: own,
        playingPoolId: playing,
        playingPoolName: playing === null ? null : poolName(playing),
        poolPlayable: playable,
        poolHasTiebreaker: hasTiebreaker,
        matches: mine.length,
        played: mine.filter((m) => m.status === 'finished').length,
        started: mine.some((m) => m.actions.length > 0),
        notes:
          playing === null ? [] : checkFeasible({ playable, hasTiebreaker, target, bansEach: bans }),
      };
    });
  };

  /** Сходятся ли правила с привязанными маппулами — как rule_problems в Rust. */
  const problemsOf = (t: Tournament): RuleProblem[] =>
    roundsOf(t)
      .filter((r) => r.notes.length > 0)
      .map((r) => ({
        key: r.key,
        title: r.title,
        poolId: r.playingPoolId,
        poolName: r.playingPoolName ?? 'маппул не выбран',
        target: r.target,
        bansEach: r.bans,
        notes: r.notes,
      }));

  /** Пересечения карт с названиями раундов вместо имён маппулов. */
  const overlapsOf = (t: Tournament, rounds: EditorRound[]): PoolOverlap[] => {
    const roundOf = new Map<number, string>();
    for (const r of rounds) {
      if (r.playingPoolId !== null && !roundOf.has(r.playingPoolId)) {
        roundOf.set(r.playingPoolId, r.title);
      }
    }
    return pools.overlaps(t.poolIds).map((row) => ({
      ...row,
      pools: row.poolIds.map((id, i) => roundOf.get(id) ?? row.pools[i] ?? poolName(id)),
    }));
  };

  /** Кто прошёл первый раунд без игры и почему. */
  const byesOf = (t: Tournament): EditorBye[] => {
    const built = matches.some((m) => m.tournamentId === t.id);
    let seeds = t.byeSeeds;

    if (!built) {
      if (t.players.length < 2) return [];
      const seats = buildSeats(t.players.length, seatOrder(t));
      seeds = t.players
        .map((p, i) => ({ seed: p.seed ?? i + 1, playerId: p.playerId }))
        .filter(
          ({ playerId }) =>
            !seats.some(
              (s) =>
                s.bracket === 'upper' &&
                s.round === 1 &&
                (s.playerA === playerId || s.playerB === playerId),
            ),
        )
        .map(({ seed }) => seed);
    }

    const size = bracketSize(Math.max(t.players.length, 2));
    const why = `сетка на ${size}, игроков ${t.players.length} — соперника в первом раунде нет`;
    return seeds.map((seed) => ({
      seed,
      nickname:
        t.players.find((p, i) => (p.seed ?? i + 1) === seed)?.nickname ?? 'игрок',
      why,
    }));
  };

  /** Всё, что нужно колонке разделов — как editor в Rust. */
  const editorOf = (t: Tournament): EditorState => {
    const rounds = roundsOf(t);
    const overlaps = overlapsOf(t, rounds);
    const checks: EditorCheck[] = [];
    const add = (section: EditorCheck['section'], text: string, blocking = false) =>
      checks.push({ section, text, blocking });

    for (const round of rounds) {
      for (const note of round.notes) add('rules', `${round.title}: ${note}`);
    }
    if (t.players.length < 2) add('players', 'для сетки нужно хотя бы два игрока', true);
    if (t.poolIds.length === 0) add('pools', 'выбери хотя бы один маппул', true);

    if (t.noRepeatPool) {
      const where = new Map<number, string[]>();
      for (const round of rounds) {
        if (round.poolId === null) continue;
        where.set(round.poolId, [...(where.get(round.poolId) ?? []), round.title]);
      }
      for (const [pool, titles] of where) {
        if (titles.length < 2) continue;
        add(
          'pools',
          `«${poolName(pool)}» привязан к ${titles.join(' и ')}: привязка сильнее правила — маппул сыграют дважды`,
        );
      }
      if (t.poolIds.length > 0 && rounds.length > t.poolIds.length) {
        const repeat = rounds.length - t.poolIds.length;
        add(
          'pools',
          `раундов ${rounds.length}, маппулов ${t.poolIds.length} — ${repeat} ` +
            `${plural(repeat, 'раунд', 'раунда', 'раундов')} доиграют повтором`,
        );
      }
    }

    for (const pool of pools.list()) {
      if (t.poolIds.includes(pool.id) && pool.isLocked) {
        add('pools', `«${pool.name}» уже играли — правка уведёт в новую версию`);
      }
    }
    for (const row of overlaps) add('pools', `${row.name}: ${row.pools.join(' и ')}`);

    const colors = t.players.map((p) => p.color.toLowerCase());
    if (new Set(colors).size < colors.length || colors.length > 16) {
      add('players', 'цвета кончились — похожие могут путаться в сетке');
    }

    const mine = matches.filter((m) => m.tournamentId === t.id);
    return {
      rounds,
      byes: byesOf(t),
      checks,
      overlaps,
      edits: (editLog.get(t.id) ?? [])
        .map(({ before: _before, play: _play, ...rest }) => rest)
        .reverse(),
      undoBlocked: undoBlocked(t),
      matchesTotal: mine.length,
      matchesStarted: mine.filter((m) => m.actions.length > 0).length,
      matchesPlayed: mine.filter((m) => m.status === 'finished').length,
      projectedMatches:
        t.players.length < 2 ? 0 : buildSeats(t.players.length, seatOrder(t)).length,
      emergencyAvailable:
        t.status === 'running' || t.status === 'finished' || t.status === 'stopped',
    };
  };

  /** Итоговая таблица — как standings в Rust. */
  const standingsOf = (t: Tournament): Standing[] => {
    if (t.status !== 'finished') return [];

    return roster(t)
      .map((p) => {
        const own = matches.filter(
          (m) => m.tournamentId === t.id && (m.playerA === p.playerId || m.playerB === p.playerId),
        );

        let mapWins = 0;
        let mapLosses = 0;
        let matchWins = 0;
        let matchLosses = 0;
        let walkovers = 0;
        for (const m of own) {
          const [a, b] = score(m);
          const mine = m.playerA === p.playerId ? a : b;
          mapWins += mine;
          mapLosses += m.playerA === p.playerId ? b : a;
          if (m.status !== 'finished' || m.winnerId === null) continue;
          if (m.winnerId === p.playerId) {
            matchWins += 1;
            if (m.isWalkover) walkovers += 1;
          } else matchLosses += 1;
        }

        // Разбивка по мод-тегам и самая длинная серия побед по картам:
        // тег берём из строки маппула, по которой карту играли.
        const perMod = new Map<string, { played: number; won: number }>();
        let streak = 0;
        let bestStreak = 0;
        for (const m of [...own].sort((x, y) => x.id - y.id)) {
          const rows = m.poolId === null ? [] : poolRows(m.poolId);
          for (const x of m.actions) {
            if (x.type !== 'result') continue;
            const won = x.winnerId === p.playerId;
            streak = won ? streak + 1 : 0;
            bestStreak = Math.max(bestStreak, streak);

            const mod = rows.find((r) => r.slotLabel === x.slotLabel)?.mod;
            if (mod === undefined) continue;
            const cell = perMod.get(mod) ?? { played: 0, won: 0 };
            cell.played += 1;
            if (won) cell.won += 1;
            perMod.set(mod, cell);
          }
        }

        const tb = perMod.get('TB') ?? { played: 0, won: 0 };
        return {
          playerId: p.playerId,
          nickname: p.nickname,
          color: p.color,
          avatarPath: p.avatarPath,
          placement: p.placement ?? Number.MAX_SAFE_INTEGER,
          matchWins,
          matchLosses,
          mapWins,
          mapLosses,
          byMod: [...perMod.entries()]
            .filter(([mod]) => mod !== 'TB')
            .map(([mod, v]) => ({ mod, ...v }))
            .sort((x, y) => y.played - x.played || x.mod.localeCompare(y.mod)),
          tiebreakers: tb.played,
          tiebreakersWon: tb.won,
          walkovers,
          bestStreak,
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
    players: roster(t),
    matches: matches
      .filter((x) => x.tournamentId === t.id)
      .map((x) => {
        const [scoreA, scoreB] = score(x);
        const [bonusA, bonusB] = bonus(x);
        return { ...x, scoreA, scoreB, bonusA, bonusB };
      }),
    problems: problemsOf(t),
    standings: standingsOf(t),
  });

  /** Добавление в состав: нужно и команде, и посадке на место сеяния. */
  const addPlayer = (t: Tournament, playerId: number, emergency: boolean) => {
    const live = structural(t, emergency);
    const p = players.find((x) => x.id === playerId);
    if (!p) throw new Error('Игрок не найден');
    if (t.players.some((x) => x.playerId === p.id)) return;

    const before = snapshotOf(t);
    t.players.push({
      playerId: p.id,
      nickname: p.nickname,
      seed: t.players.length + 1,
      // Цвет в турнире свой: одинаковые в сетке не различить.
      color: freeColor(t.players.map((x) => x.color)),
      avatarPath: p.avatarPath,
      placement: null,
      isRookie: false,
    });
    rebuildIfSeeded(t);
    pushEdit(t, 'playersAdd', live, `добавлен ${p.nickname}`, before);
  };


  // ───────────────────────────────────────────── призовой фонд (упрощённо)

  /** Приблизительный вид фонда: вёрстке важны поля, а не математика —
   * настоящий расчёт живёт в Rust и покрыт тестами. */
  const mockPrizeView = (t: Tournament, config: PrizeConfig): PrizeView => {
    const seats = roster(t);
    const bountyTotal = config.addons.bounty?.amounts.reduce((a, b) => a + b, 0) ?? 0;
    const payments = config.addons.matchPayments?.amount ?? 0;
    const rookie = config.addons.rookieRace ?? 0;
    const spectator = config.addons.spectator ?? 0;
    const effective = config.fund + config.jackpotIn;
    const engineShare = effective - bountyTotal - payments - rookie - spectator;

    const problems: string[] = [];
    if (engineShare < 0) problems.push('надстройки съедают больше фонда, чем в нём есть');
    if (config.engine.kind === 'places') {
      const shares = config.engine.shares;
      if (shares.reduce((a, b) => a + b, 0) !== 100) {
        problems.push('проценты мест должны давать в сумме сто');
      }
      if (shares.slice(1).some((v, i) => v >= (shares[i] ?? 0))) {
        problems.push('проценты мест должны убывать');
      }
    }

    const amounts: number[] =
      config.engine.kind === 'places'
        ? config.engine.shares.map((share) => Math.floor((engineShare * share) / 100))
        : [];
    if (amounts.length > 0) {
      const left = engineShare - amounts.reduce((a, b) => a + b, 0);
      amounts[0] = (amounts[0] ?? 0) + left;
    }

    const ladder = seats.map((_p, i) => ({
      place: i + 1,
      guarantee: amounts[i] ?? 0,
      engineMax: amounts[i] ?? 0,
      maxTotal: (amounts[i] ?? 0) + (i > 0 ? bountyTotal : 0),
      group: i + 1,
    }));

    const rows = seats.map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      color: p.color,
      seed: p.seed,
      rookie: p.isRookie,
      place: p.placement,
      places: amounts[(p.placement ?? 1) - 1] ?? 0,
      matches: 0,
      maps: 0,
      bounty: 0,
      rookiePrize: 0,
      spectator: 0,
      total: amounts[(p.placement ?? 1) - 1] ?? 0,
    }));

    const matchPrices =
      config.engine.kind === 'matches' && matches.length > 0
        ? [...new Set(matches.filter((m) => m.tournamentId === t.id).map((m) => `${m.bracket}:${m.round}`))]
            .sort()
            .map((key) => {
              const [bracket, round] = key.split(':');
              const own = matches.filter(
                (m) => m.tournamentId === t.id && m.bracket === bracket && m.round === Number(round),
              );
              return {
                key,
                title:
                  bracket === 'grand'
                    ? 'Гранд-финал'
                    : `Раунд ${round} ${bracket === 'upper' ? 'верхней' : 'нижней'}`,
                matches: own.length,
                price: Math.floor(engineShare / Math.max(1, matches.length)),
              };
            })
        : [];

    return {
      config,
      fundEffective: effective,
      engineShare,
      ladder,
      check: problems.length > 0
        ? { ok: false, brokenAt: null, text: problems[0] ?? 'фонд не сходится' }
        : { ok: true, brokenAt: null, text: 'места убывают по всей лестнице' },
      note: bountyTotal > 0 && ladder.length > 3
        ? `4-е место может унести до ${bountyTotal + (amounts[3] ?? 0)} ₽ при гарантированных ${amounts[2] ?? 0} ₽ за 3-е — это работа надстройки, а не ошибка`
        : null,
      matchPrices,
      paymentPrices: [],
      mapPrice:
        config.engine.kind === 'maps'
          ? { win: Math.floor(engineShare / 60) * 2, loss: Math.floor(engineShare / 60), unit: engineShare / 60 }
          : null,
      spread: config.engine.kind === 'maps' ? { min: engineShare - 500, max: engineShare + 800 } : null,
      rows,
      heads: (config.addons.bounty?.amounts ?? []).map((amount, i) => {
        const seat = seats.find((x) => x.seed === i + 1);
        return {
          playerId: seat?.playerId ?? 0,
          nickname: seat?.nickname ?? '—',
          seed: i + 1,
          amount,
        };
      }),
      lastBounty: null,
      rookieRows: seats
        .filter((p) => p.isRookie)
        .map((p, i) => ({
          playerId: p.playerId,
          nickname: p.nickname,
          color: p.color,
          place: i + 1,
          status: p.placement === null ? 'alive' : 'out',
          earned: 0,
        })),
      bestMatch: null,
      remainder: effective - rows.reduce((a, r) => a + r.total, 0),
      jackpotNow: mockJackpot,
      finished: t.status === 'finished',
      problems,
    };
  };

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

    list_tournaments: () => tournaments.map((t) => ({ ...t, players: roster(t) })),
    get_tournament: (a) => {
      const t = findT(a['id']);
      return { ...t, players: roster(t) };
    },

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
        poolByRound: {},
        grandAdvantage: 0,
        byeSeeds: [],
        createdAt: new Date().toISOString(),
        finishedAt: null,
        prize: null,
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
      const before = snapshotOf(t);
      t.targetScore = a['targetScore'] as ByRound;
      t.bansPerRound = a['bansPerRound'] as ByRound;
      t.firstBan = a['firstBan'] as Tournament['firstBan'];
      t.noRepeatPool = a['noRepeatPool'] === true;
      pushEdit(t, 'rules', false, 'правила матчей', before);
      return t;
    },

    /** Исключение по раунду: своё правило вместо общего. */
    set_tournament_round_rule: (a) => {
      const t = findT(a['id']);
      const key = String(a['key']);
      const target = typeof a['target'] === 'number' ? a['target'] : null;
      const bans = typeof a['bans'] === 'number' ? a['bans'] : null;

      if (target !== null && key.startsWith('grand') && target <= t.grandAdvantage) {
        throw new Error(
          `При преимуществе ${t.grandAdvantage} играть до ${target} побед нельзя: ` +
            'матч выигран до первой карты',
        );
      }

      const before = snapshotOf(t);
      const apply = (rule: ByRound, value: number | null) => {
        const rounds = { ...rule.rounds };
        if (value === null) delete rounds[key];
        else rounds[key] = value;
        return { ...rule, rounds };
      };
      t.targetScore = apply(t.targetScore, target);
      t.bansPerRound = apply(t.bansPerRound, bans);

      const title = roundsOf(t).find((r) => r.key === key)?.title ?? key;
      pushEdit(t, 'rules', false, `правило раунда «${title}»`, before);
      return undefined;
    },

    /** Закрепляет маппул за раундом. `null` — «любой свободный». */
    set_tournament_round_pool: (a) => {
      const t = findT(a['id']);
      const key = String(a['key']);
      const pool = typeof a['poolId'] === 'number' ? a['poolId'] : null;
      const before = snapshotOf(t);

      const map = { ...t.poolByRound };
      if (pool === null) delete map[key];
      else {
        map[key] = pool;
        // Пул, привязанный к раунду, но не добавленный в турнир, добавляется
        // сам: иначе привязка не сработала бы молча.
        if (!t.poolIds.includes(pool)) t.poolIds = [...t.poolIds, pool];
      }
      t.poolByRound = map;
      reassignPools(t);

      const title = roundsOf(t).find((r) => r.key === key)?.title ?? key;
      pushEdit(t, 'pools', false, `маппул раунда «${title}»`, before);
      return undefined;
    },

    /** Серия целиком: её маппулы раскладываются по раундам по порядку. */
    add_tournament_series: (a) => {
      const t = findT(a['id']);
      const series = pools.series(a['seriesId'] as number);
      if (series.poolIds.length === 0) throw new Error('В серии нет маппулов');

      const before = snapshotOf(t);
      for (const pool of series.poolIds) {
        if (!t.poolIds.includes(pool)) t.poolIds = [...t.poolIds, pool];
      }
      const map = { ...t.poolByRound };
      roundsOf(t).forEach((round, i) => {
        const pool = series.poolIds[i];
        if (pool !== undefined) map[round.key] = pool;
      });
      t.poolByRound = map;
      reassignPools(t);

      pushEdit(t, 'pools', false, `серия «${series.name}» разложена по раундам`, before);
      return undefined;
    },

    set_tournament_grand_advantage: (a) => {
      const t = findT(a['id']);
      const value = Number(a['value']) || 0;
      if (value < 0 || value > 3) throw new Error('Преимущество сетки — от нуля до трёх');

      const target = atKey(t.targetScore, 'grand', 1);
      if (value >= target) {
        throw new Error(
          `Гранд-финал играется до ${target} побед — преимущество ${value} выиграло бы его ` +
            'до первой карты',
        );
      }
      const started = matches.some(
        (m) => m.tournamentId === t.id && m.bracket === 'grand' && m.actions.length > 0,
      );
      if (started) throw new Error('Гранд-финал уже играется — преимущество в нём менять поздно');

      const before = snapshotOf(t);
      t.grandAdvantage = value;
      pushEdit(t, 'grandAdvantage', false, `преимущество сетки — ${value}`, before);
      return undefined;
    },

    tournament_editor: (a) => editorOf(findT(a['id'])),

    undo_tournament_edit: (a) => {
      const t = findT(a['id']);
      undoLastEdit(t);
      return bracketOf(t);
    },

    delete_tournament: (a) => {
      const i = tournaments.findIndex((x) => x.id === a['id']);
      if (i >= 0) tournaments.splice(i, 1);
      for (let k = matches.length - 1; k >= 0; k--) {
        if (matches[k]?.tournamentId === a['id']) matches.splice(k, 1);
      }
      editLog.delete(a['id'] as number);
      return undefined;
    },

    add_tournament_player: (a) => {
      addPlayer(findT(a['id']), a['playerId'] as number, a['emergency'] === true);
      return undefined;
    },

    prize_state: (a) => {
      const t = findT(a['id']);
      return t.prize === null ? null : mockPrizeView(t, t.prize);
    },

    prize_preview: (a) => {
      const t = findT(a['id']);
      return mockPrizeView(t, a['config'] as PrizeConfig);
    },

    set_tournament_prize: (a) => {
      const t = findT(a['id']);
      const config = a['config'] as PrizeConfig;
      t.prize = config.fund > 0 ? config : null;
      return mockPrizeView(t, config);
    },

    set_player_rookie: (a) => {
      const t = findT(a['id']);
      const seat = t.players.find((x) => x.playerId === a['playerId']);
      if (seat) seat.isRookie = a['rookie'] === true;
      return undefined;
    },

    set_best_match: (a) => {
      const t = findT(a['id']);
      if (t.prize === null) throw new Error('зрительский банк не задан: фонда нет');
      t.prize.bestMatchId = typeof a['matchId'] === 'number' ? a['matchId'] : null;
      return undefined;
    },

    jackpot_value: () => mockJackpot,

    remove_tournament_player: (a) => {
      const t = findT(a['id']);
      const live = structural(t, a['emergency'] === true);
      const playerId = a['playerId'] as number;
      const seat = t.players.find((x) => x.playerId === playerId);
      if (seat === undefined) return undefined;

      // В идущем турнире имя игрока держится на его строке в составе: убрав её,
      // мы бы стёрли подпись у сыгранных матчей.
      if (live) {
        const played = matches.some(
          (m) =>
            m.tournamentId === t.id &&
            (m.playerA === playerId || m.playerB === playerId) &&
            (m.status === 'finished' || m.actions.length > 0),
        );
        if (played) {
          throw new Error(
            `${seat.nickname} уже играл в этом турнире — сначала снеси его результаты`,
          );
        }
      }

      const before = snapshotOf(t);
      t.players = t.players.filter((x) => x.playerId !== playerId);
      for (const m of matches) {
        if (m.tournamentId !== t.id || m.status === 'finished' || m.actions.length > 0) continue;
        if (m.playerA === playerId) m.playerA = null;
        if (m.playerB === playerId) m.playerB = null;
      }
      t.players.forEach((p, i) => {
        p.seed = i + 1;
      });
      rebuildIfSeeded(t);
      pushEdit(t, 'playersRemove', live, `убран ${seat.nickname}`, before);
      return undefined;
    },

    set_tournament_seeds: (a) => {
      const t = findT(a['id']);
      const live = structural(t, a['emergency'] === true);
      const before = snapshotOf(t);
      writeSeeds(t, (a['order'] as number[]) ?? []);
      rebuildIfSeeded(t);
      pushEdit(t, 'seeds', live, 'сеяние', before);
      return undefined;
    },

    swap_tournament_seeds: (a) => {
      const t = findT(a['id']);
      const live = structural(t, a['emergency'] === true);
      const first = a['playerA'] as number;
      const second = a['playerB'] as number;
      if (first === second) throw new Error('Это один и тот же игрок');

      const order = t.players.map((p) => p.playerId);
      const ia = order.indexOf(first);
      const ib = order.indexOf(second);
      if (ia < 0 || ib < 0) throw new Error('Игрок не участвует в турнире');

      const before = snapshotOf(t);
      [order[ia], order[ib]] = [order[ib]!, order[ia]!];
      writeSeeds(t, order);
      rebuildIfSeeded(t);

      const nick = (id: number) =>
        t.players.find((p) => p.playerId === id)?.nickname ?? 'игрок';
      pushEdit(t, 'seeds', live, `${nick(first)} ↔ ${nick(second)}`, before);
      return undefined;
    },

    place_tournament_player: (a) => {
      const t = findT(a['id']);
      const playerId = a['playerId'] as number;
      const emergency = a['emergency'] === true;

      if (!t.players.some((p) => p.playerId === playerId)) {
        addPlayer(t, playerId, emergency);
      }
      const live = structural(t, emergency);
      const before = snapshotOf(t);

      const order = t.players.map((p) => p.playerId).filter((x) => x !== playerId);
      const at = Math.min(Math.max(Number(a['seed']) || 1, 1) - 1, order.length);
      order.splice(at, 0, playerId);
      writeSeeds(t, order);
      rebuildIfSeeded(t);

      const nick = t.players.find((p) => p.playerId === playerId)?.nickname ?? 'игрок';
      pushEdit(t, 'seeds', live, `${nick} на ${at + 1}-е сеяние`, before);
      return undefined;
    },

    shuffle_tournament_seeds: (a) => {
      const t = findT(a['id']);
      const live = structural(t, a['emergency'] === true);
      const before = snapshotOf(t);

      const order = t.players.map((p) => p.playerId);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      writeSeeds(t, order);
      rebuildIfSeeded(t);
      pushEdit(t, 'seeds', live, 'сеяние перемешано', before);
      return undefined;
    },

    set_tournament_player_color: (a) => {
      const t = findT(a['id']);
      const seat = t.players.find((x) => x.playerId === a['playerId']);
      if (!seat) return undefined;
      const before = snapshotOf(t);
      seat.color = String(a['color']);
      pushEdit(t, 'playerColor', false, `цвет ${seat.nickname}`, before);
      return undefined;
    },

    set_tournament_pools: (a) => {
      const t = findT(a['id']);
      const before = snapshotOf(t);
      t.poolIds = (a['poolIds'] as number[]) ?? [];

      // Маппул, убранный из турнира, не может оставаться закреплённым за раундом.
      t.poolByRound = Object.fromEntries(
        Object.entries(t.poolByRound).filter(([, pool]) => t.poolIds.includes(pool)),
      );
      reassignPools(t);
      pushEdit(t, 'pools', false, 'список маппулов', before);
      return undefined;
    },

    start_tournament: (a) => {
      const t = findT(a['id']);
      if (t.status === 'running' || t.status === 'finished') {
        throw new Error('Турнир уже идёт — пересобрать сетку значит потерять результаты');
      }
      const before = snapshotOf(t);
      buildBracket(t);
      pushEdit(t, 'bracketRebuild', false, 'сетка собрана заново', before);
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

    stop_tournament: (a) => {
      const t = findT(a['id']);
      if (t.status !== 'running') throw new Error('Останавливать можно только идущий турнир');
      t.status = 'stopped';
      return bracketOf(t);
    },

    resume_tournament: (a) => {
      const t = findT(a['id']);
      if (t.status !== 'stopped') throw new Error('Продолжать можно только остановленный');
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
      t.byeSeeds = [];
      return bracketOf(t);
    },

    tournament_bracket: (a) => bracketOf(findT(a['id'])),

    /** Карты, попавшие сразу в несколько маппулов турнира. */
    tournament_pool_overlaps: (a) => {
      const t = findT(a['id']);
      return overlapsOf(t, roundsOf(t));
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
      const t = findT(m.tournamentId);
      const before = snapshotOf(t);
      m.poolId = typeof a['poolId'] === 'number' ? a['poolId'] : null;
      pushEdit(t, 'matchPool', false, `маппул матча «${titleOf(m)}»`, before);
      return stateOf(m);
    },

    set_match_first_ban: (a) => {
      const m = findM(a['id']);
      if (m.actions.length > 0) throw new Error('Матч уже начали');
      m.firstBanBy = a['playerId'] as number;
      m.status = 'running';
      m.startedAt ??= new Date().toISOString();

      // Правило матча запоминаем здесь: с этого момента оно его собственное.
      const [target, bans] = ruleOf(m);
      m.targetScore ??= target;
      m.bansEach ??= bans;
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
      const t = findT(m.tournamentId);
      const winner = a['winnerId'] as number;
      const live = structural(t, a['emergency'] === true);
      const before = snapshotOf(t);

      m.actions.length = 0;
      close(m, winner, true);
      const nick = t.players.find((p) => p.playerId === winner)?.nickname ?? 'игрок';
      pushEdit(t, 'matchWalkover', live, `техпобеда в «${titleOf(m)}»: ${nick}`, before);
      return stateOf(m);
    },

    set_match_manual_result: (a) => {
      const m = findM(a['id']);
      const t = findT(m.tournamentId);
      const winner = a['winnerId'] as number;
      const scoreA = Number(a['scoreA']);
      const scoreB = Number(a['scoreB']);
      if (scoreA < 0 || scoreB < 0) throw new Error('Счёт не может быть отрицательным');

      const live = structural(t, a['emergency'] === true);
      const before = snapshotOf(t);

      // Ручной счёт заменяет журнал: держать половину истории хуже, чем никакой.
      m.actions.length = 0;
      for (let i = 0; i < scoreA; i++) push(m, 'result', null, '—', m.playerA);
      for (let i = 0; i < scoreB; i++) push(m, 'result', null, '—', m.playerB);

      m.isManualEdit = true;
      close(m, winner, false);
      pushEdit(t, 'matchResult', live, `ручной счёт в «${titleOf(m)}»: ${scoreA}:${scoreB}`, before);
      return stateOf(m);
    },

    /** Что случится, если снести результат: считается до правки. */
    match_impact: (a) => {
      const m = findM(a['id']);
      const t = findT(m.tournamentId);
      const ahead = forward(m);
      const touched = [m, ...ahead];

      const nick = (id: number | null) =>
        id === null ? null : (t.players.find((p) => p.playerId === id)?.nickname ?? 'игрок');

      const people: string[] = [];
      let maps = 0;
      for (const one of touched) {
        maps += one.actions.filter((x) => x.type === 'result').length;
        for (const who of [one.playerA, one.playerB]) {
          const name = nick(who);
          if (name !== null && !people.includes(name)) people.push(name);
        }
      }

      const returns: string[] = [];
      if (m.winnerId !== null && m.nextLoseSlot !== null) {
        const loser = nick(m.playerA === m.winnerId ? m.playerB : m.playerA);
        if (loser !== null) {
          returns.push(`${loser} вернётся из нижней сетки в турнир без поражения`);
        }
      }

      return {
        matches: ahead.map(titleOf),
        players: people,
        maps,
        returns,
        reopensTournament: t.status === 'finished',
      };
    },

    /** Снос результата: матч возвращается в ожидание, сетка ниже сбрасывается. */
    reset_match: (a) => {
      const m = findM(a['id']);
      const t = findT(m.tournamentId);
      const live = structural(t, a['emergency'] === true);
      const before = snapshotOf(t);

      wipe(m);
      // Проход без игры мог быть настоящим: если соперника нет, матч закроется
      // снова сам.
      advanceWalkovers(t);
      reopenIfFinished(t);
      pushEdit(t, 'matchReset', live, `снесён результат «${titleOf(m)}»`, before);
      return stateOf(m);
    },

    /** Замена участника в конкретном месте сетки. */
    replace_match_player: (a) => {
      const m = findM(a['id']);
      const t = findT(m.tournamentId);
      const slot = String(a['slot']);
      const playerId = a['playerId'] as number;
      if (slot !== 'a' && slot !== 'b') throw new Error('Непонятное место в матче');

      const live = structural(t, a['emergency'] === true);
      if (m.actions.length > 0 || m.status === 'finished') {
        throw new Error('Матч уже играли — сначала снеси его результат');
      }
      if (t.players.some((p) => p.playerId === playerId)) {
        throw new Error('Этот игрок уже в турнире — у него было бы два места в сетке');
      }

      const before = snapshotOf(t);
      const p = players.find((x) => x.id === playerId);
      if (!p) throw new Error('Игрок не найден');

      // Заменяющий появляется в составе, но сетку не пересобирает: место у него
      // уже есть, а пересборка стёрла бы сыгранное.
      t.players.push({
        playerId: p.id,
        nickname: p.nickname,
        seed: t.players.length + 1,
        color: freeColor(t.players.map((x) => x.color)),
        avatarPath: p.avatarPath,
        placement: null,
        isRookie: false,
      });

      const was = slot === 'a' ? m.playerA : m.playerB;
      const wasNick = t.players.find((x) => x.playerId === was)?.nickname ?? 'пустого места';
      if (slot === 'a') m.playerA = playerId;
      else m.playerB = playerId;

      pushEdit(
        t,
        'playerSwap',
        live,
        `в «${titleOf(m)}» вместо ${wasNick} играет ${p.nickname}`,
        before,
      );
      return stateOf(m);
    },

    // Список маппулов нужен экрану матча и сборке турнира.
    __pool_names: () => pools.list(),
  };
}
