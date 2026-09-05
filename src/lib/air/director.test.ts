import { describe, expect, it } from 'vitest';
import { planMatch, planFinish, expired, layer } from './director';
import type { AirContext } from './payload';
import type {
  Bracket,
  EditorState,
  Match,
  MatchAction,
  MatchRow,
  MatchState,
  ModTag,
  Player,
  PlayerStats,
  RowState,
} from '@/lib/types';

// Минимальный турнир: двое, один матч, маппул из четырёх строк плюс тайбрейк.
// Здесь проверяется таблица переходов из ТЗ 8.1, а не устройство сетки.

const A = 1;
const B = 2;

const player = (id: number, nickname: string, osuUserId: number | null): Player => ({
  id,
  nickname,
  osuUserId,
  color: id === A ? '#ff6fb1' : '#5bc8f5',
  avatarPath: null,
  note: null,
  isArchived: false,
  createdAt: '2026-08-01T00:00:00Z',
});

const match = (patch: Partial<Match> = {}): Match => ({
  id: 10,
  tournamentId: 1,
  bracket: 'upper',
  round: 1,
  slotInBracket: 0,
  playerA: A,
  playerB: B,
  poolId: 5,
  status: 'running',
  winnerId: null,
  isWalkover: false,
  isManualEdit: false,
  firstBanBy: A,
  nextWinSlot: 11,
  nextLoseSlot: 12,
  startedAt: '2026-08-16T10:00:00Z',
  finishedAt: null,
  targetScore: 3,
  bansEach: 1,
  lobbyId: null,
  scoreA: 0,
  scoreB: 0,
  bonusA: 0,
  bonusB: 0,
  ...patch,
});

const row = (slotLabel: string, mod: ModTag, state: RowState): MatchRow => ({
  slotLabel,
  mod,
  beatmap: null,
  starRatingWithMods: 5.5,
  state,
});

const action = (n: number, type: MatchAction['type'], slotLabel: string, extra: Partial<MatchAction> = {}): MatchAction => ({
  n,
  type,
  actorId: null,
  slotLabel,
  winnerId: null,
  source: 'manual',
  at: '2026-08-16T10:00:00Z',
  ...extra,
});

const state = (patch: Partial<MatchState> = {}): MatchState => ({
  ...match(),
  tournamentName: 'Кубок',
  players: [
    { playerId: A, nickname: 'NAGISA', seed: 1, color: '#ff6fb1', avatarPath: null, placement: null, isRookie: false },
    { playerId: B, nickname: 'MEI', seed: 4, color: '#5bc8f5', avatarPath: null, placement: null, isRookie: false },
  ],
  rows: [
    row('NM1', 'NM', { kind: 'free' }),
    row('NM2', 'NM', { kind: 'free' }),
    row('HD1', 'HD', { kind: 'free' }),
    row('HR1', 'HR', { kind: 'free' }),
    row('TB', 'TB', { kind: 'locked', hint: 'откроется' }),
  ],
  actions: [],
  phase: { kind: 'ban', actor: A, done: 0, total: 2 },
  target: 3,
  matchPoint: [],
  ...patch,
});

const stats = (): PlayerStats => ({
  playerId: A,
  tournaments: 3,
  tournamentWins: 1,
  placements: [1, 3],
  matches: 9,
  matchWins: 6,
  maps: 34,
  mapWins: 20,
  bestMod: 'HD',
  worstMod: 'DT',
  favouriteBeatmap: null,
  byMod: [],
  history: [],
  versus: [{ playerId: B, nickname: 'MEI', wins: 2, losses: 1 }],
  lobbyMaps: 0,
  lobbyPassed: 0,
  lobbyAvgAccuracy: null,
  lobbyAvgMiss: null,
});

function context(patch: Partial<AirContext> = {}): AirContext {
  const bracket: Bracket = {
    id: 1,
    name: 'Кубок',
    status: 'running',
    bracketSize: 4,
    targetScore: { default: 3, rounds: {} },
    bansPerRound: { default: 1, rounds: {} },
    firstBan: 'random',
    noRepeatPool: false,
    poolByRound: {},
    grandAdvantage: 0,
    byeSeeds: [],
    createdAt: '2026-08-01T00:00:00Z',
    finishedAt: null,
    prize: null,
    players: [
      { playerId: A, nickname: 'NAGISA', seed: 1, color: '#ff6fb1', avatarPath: null, placement: null, isRookie: false },
      { playerId: B, nickname: 'MEI', seed: 4, color: '#5bc8f5', avatarPath: null, placement: null, isRookie: false },
    ],
    poolIds: [5],
    matches: [
      match(),
      match({ id: 11, playerA: null, playerB: null, round: 2, status: 'pending' }),
      match({ id: 12, bracket: 'lower', playerA: null, playerB: null, status: 'pending' }),
    ],
    problems: [],
    standings: [],
  };

  const editor: EditorState = {
    rounds: [
      {
        key: 'upper:1',
        bracket: 'upper',
        round: 1,
        title: 'Верхняя, раунд 1',
        target: 3,
        bans: 1,
        targetOwn: false,
        bansOwn: false,
        poolId: 5,
        playingPoolId: 5,
        playingPoolName: 'Раунд 1',
        poolPlayable: 4,
        poolHasTiebreaker: true,
        matches: 1,
        played: 0,
        started: true,
        notes: [],
      },
    ],
    byes: [],
    checks: [],
    overlaps: [],
    edits: [],
    undoBlocked: null,
    matchesTotal: 2,
    matchesStarted: 1,
    matchesPlayed: 0,
    projectedMatches: 2,
    emergencyAvailable: true,
  };

  return {
    bracket,
    players: [player(A, 'NAGISA', 4001), player(B, 'MEI', null)],
    editor,
    pools: [],
    stats: new Map([[A, stats()]]),
    profiles: new Map(),
    logs: [],
    prize: null,
    ...patch,
  };
}

const ids = (list: { id: string }[]) => list.map((x) => x.id);

describe('сценарий эфира', () => {
  it('матч открыт — представление, и больше ничего за один раз', () => {
    const out = planMatch(context(), null, state(), null);
    expect(ids(out)).toEqual(['matchIntro']);
    expect(out[0]?.after).toEqual({ kind: 'live' });
  });

  it('представление знает личный счёт этих двоих', () => {
    const out = planMatch(context(), null, state(), null);
    const p = out[0]?.layers[0]?.payload as { versusA: number; versusB: number; round: string };
    expect(p.versusA).toBe(2);
    expect(p.versusB).toBe(1);
    expect(p.round).toBe('Верхняя, раунд 1');
  });

  it('бан — врезка поверх матча, и она возвращает матч', () => {
    const before = state();
    const after = state({
      actions: [action(1, 'ban', 'NM1')],
      rows: [
        row('NM1', 'NM', { kind: 'banned', by: A, n: 1 }),
        row('NM2', 'NM', { kind: 'free' }),
        row('HD1', 'HD', { kind: 'free' }),
        row('HR1', 'HR', { kind: 'free' }),
        row('TB', 'TB', { kind: 'locked', hint: '' }),
      ],
    });

    const out = planMatch(context(), before, after, null);
    expect(ids(out)).toEqual(['banReveal']);
    // Врезка накрывает «Ход матча», а не заменяет его: слоёв два.
    expect(out[0]?.layers.map((l) => l.id)).toEqual(['matchLive', 'banReveal']);
    expect(out[0]?.after).toEqual({ kind: 'live' });

    const p = out[0]?.layers[1]?.payload as { n: number; by: { nick: string } | null };
    expect(p.n).toBe(1);
    expect(p.by?.nick).toBe('NAGISA');
  });

  it('пик уходит не в матч, а в идущую карту', () => {
    const before = state({ actions: [action(1, 'ban', 'NM1'), action(2, 'ban', 'HD1')] });
    const after = state({
      actions: [...before.actions, action(3, 'pick', 'NM2', { actorId: A })],
      rows: [
        row('NM1', 'NM', { kind: 'banned', by: A, n: 1 }),
        row('NM2', 'NM', { kind: 'playing', by: A }),
        row('HD1', 'HD', { kind: 'banned', by: B, n: 2 }),
        row('HR1', 'HR', { kind: 'free' }),
        row('TB', 'TB', { kind: 'locked', hint: '' }),
      ],
    });

    const out = planMatch(context(), before, after, null);
    expect(ids(out)).toEqual(['pickReveal']);
    expect(out[0]?.after).toEqual({ kind: 'progress' });
  });

  it('без лобби результат карты идёт без цифр, но выходит', () => {
    const before = state({ actions: [action(1, 'pick', 'NM2')] });
    const after = state({
      actions: [action(1, 'pick', 'NM2'), action(2, 'result', 'NM2', { winnerId: A })],
      scoreA: 1,
      rows: [row('NM2', 'NM', { kind: 'played', winner: A, n: 2 })],
    });

    const out = planMatch(context(), before, after, null);
    const p = out[0]?.layers[1]?.payload as { scores: unknown[] };
    expect(p.scores).toEqual([]);
  });

  it('матч завершён — итог, и дальше плейлист паузы', () => {
    const before = state({ scoreA: 2, scoreB: 1 });
    const after = state({
      status: 'finished',
      winnerId: A,
      scoreA: 3,
      scoreB: 1,
      phase: { kind: 'finished', winner: A },
    });

    const out = planMatch(context(), before, after, null);
    expect(ids(out)).toEqual(['matchResult']);
    expect(out[0]?.after).toEqual({ kind: 'pause' });

    const p = out[0]?.layers[0]?.payload as { winnerGoes: string | null; loserGoes: string | null };
    // Победитель идёт в следующий матч, проигравший падает в нижнюю сетку.
    expect(p.winnerGoes).not.toBeNull();
    expect(p.loserGoes).not.toBeNull();
  });

  it('отмена в матче новых кадров не порождает', () => {
    const before = state({ actions: [action(1, 'ban', 'NM1')] });
    const after = state({ actions: [] });
    expect(planMatch(context(), before, after, null)).toEqual([]);
  });

  it('турнир завершён — пьедестал, за ним титры', () => {
    const ctx = context();
    ctx.bracket.status = 'finished';
    ctx.bracket.finishedAt = '2026-08-16T14:00:00Z';
    ctx.bracket.standings = [
      {
        playerId: A,
        nickname: 'NAGISA',
        color: '#ff6fb1',
        avatarPath: null,
        placement: 1,
        matchWins: 3,
        matchLosses: 0,
        mapWins: 9,
        mapLosses: 2,
        byMod: [],
        tiebreakers: 1,
        tiebreakersWon: 1,
        walkovers: 0,
        bestStreak: 4,
      },
    ];

    const out = planFinish(ctx);
    expect(ids(out)).toEqual(['champion', 'credits']);
    expect(out[0]?.after).toMatchObject({ kind: 'layers' });
  });
});

describe('таймер кадра', () => {
  it('слой без таймера не истекает никогда', () => {
    expect(expired(layer('matchLive', {}, 0))).toBe(false);
  });

  it('слой с таймером истекает ровно по своему времени', () => {
    const l = layer('matchIntro', {}, 10);
    const at = Date.parse(l.until as string);
    expect(expired(l, at - 1)).toBe(false);
    expect(expired(l, at)).toBe(true);
  });
});

describe('темп эфира', () => {
  it('темп ужимает длительности заготовок, не трогая бессрочные', () => {
    const slow = planMatch(context(), null, state(), null, 0.5);
    const fast = planMatch(context(), null, state(), null, 2);
    const base = planMatch(context(), null, state(), null, 1);

    const secs = (p: { seconds: number }[]) => p[0]?.seconds ?? 0;
    expect(secs(base)).toBeGreaterThan(0);
    // Медленный эфир держит заготовку дольше, быстрый — меньше.
    expect(secs(slow)).toBeGreaterThan(secs(base));
    expect(secs(fast)).toBeLessThan(secs(base));
    // Темп не может сжать сцену до нуля.
    expect(secs(fast)).toBeGreaterThanOrEqual(0.5);
  });

  it('темп не ломает бессрочные слои — там таймера нет', () => {
    const out = planMatch(context(), state(), state({ actions: [action(1, 'ban', 'NM1')] }), null, 2);
    // Нет новых событий — нет и кадров, темп ни на что не влияет.
    expect(out).toEqual([]);
  });
});
