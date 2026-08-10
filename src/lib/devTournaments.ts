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
  Tournament,
  TournamentPlayer,
} from './types';

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

/** Полная сетка на двойное выбывание — та же схема, что в Rust. */
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

  return seats;
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
  return (
    PALETTE.find((c) => !taken.some((t) => t.toLowerCase() === c.toLowerCase())) ??
    PALETTE[taken.length % PALETTE.length] ??
    PALETTE[0]!
  );
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

  const bans = m.actions.filter((x) => x.type === 'ban').length;
  if (bans < bansTotal * 2) {
    return {
      kind: 'ban',
      actor: bans % 2 === 0 ? m.firstBanBy : second,
      done: bans,
      total: bansTotal * 2,
    };
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

  // Пикает тот, кто банил вторым, дальше по очереди.
  const actor = picks.length % 2 === 0 ? second : m.firstBanBy;
  return { kind: 'pick', actor };
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

function close(m: DevMatch, winnerId: number, walkover: boolean) {
  m.status = 'finished';
  m.winnerId = winnerId;
  m.isWalkover = walkover;
  m.finishedAt = new Date().toISOString();
  promote(m);
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

    const matchPoint: number[] = [];
    if (scoreA === target - 1 && m.playerA !== null) matchPoint.push(m.playerA);
    if (scoreB === target - 1 && m.playerB !== null) matchPoint.push(m.playerB);

    return {
      ...m,
      scoreA,
      scoreB,
      tournamentName: t.name,
      players: t.players.filter((p) => p.playerId === m.playerA || p.playerId === m.playerB),
      rows: rowsOf(m, target, poolRows),
      actions: m.actions,
      phase: phaseOf(m, target, bans),
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

  const bracketOf = (t: Tournament): Bracket => ({
    ...t,
    matches: matches
      .filter((x) => x.tournamentId === t.id)
      .map((x) => {
        const [scoreA, scoreB] = score(x);
        return { ...x, scoreA, scoreB };
      }),
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
          poolId: t.poolIds[0] ?? null,
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

      t.status = 'running';
      t.bracketSize = size;

      // Место без соперника проходит дальше без игры.
      for (const m of matches.filter((x) => x.tournamentId === t.id)) {
        if (m.round !== 1 || m.bracket !== 'upper') continue;
        if ((m.playerA === null) === (m.playerB === null)) continue;
        close(m, (m.playerA ?? m.playerB) as number, true);
      }

      return bracketOf(t);
    },

    tournament_bracket: (a) => bracketOf(findT(a['id'])),

    finish_tournament: (a) => {
      const t = findT(a['id']);
      t.status = 'finished';
      t.finishedAt = new Date().toISOString();
      const grand = matches.find((m) => m.tournamentId === t.id && m.bracket === 'grand');
      const champion = grand?.winnerId ?? null;
      for (const p of t.players) p.placement = p.playerId === champion ? 1 : null;
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
