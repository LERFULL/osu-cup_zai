import { describe, expect, it } from 'vitest';
import { buildPlaylist, MAX_PER_SCENE, RESERVE, type Candidate } from './playlist';
import { sceneMeta } from './catalog';
import type { SceneId, SceneShow } from './types';

const can = (id: SceneId, patch: Partial<Candidate> = {}): Candidate => ({
  id,
  objectKey: '',
  objectName: null,
  available: true,
  reason: null,
  required: false,
  ...patch,
});

const shown = (id: SceneId, lastAt: string, shows = 1, objectKey = ''): SceneShow => ({
  sceneId: id,
  objectKey,
  shows,
  lastAt,
});

const ids = (list: { id: SceneId }[]) => list.map((x) => x.id);

describe('плейлист паузы', () => {
  it('кончается тем, что будет дальше, а не случайной статистикой', () => {
    const list = buildPlaylist({
      budget: 240,
      candidates: [can('records'), can('standings'), can('nextUp')],
      shows: [],
      hasCountdown: false,
    });

    expect(ids(list.items).at(-1)).toBe('nextUp');
  });

  it('с отсчётом хвостом становится он, а место в бюджете не занимает', () => {
    const list = buildPlaylist({
      budget: 120,
      candidates: [can('bracket'), can('nextUp'), can('countdown')],
      shows: [],
      hasCountdown: true,
    });

    expect(ids(list.items).at(-1)).toBe('countdown');
    expect(ids(list.items)).not.toContain('nextUp');
    expect(list.items.at(-1)?.seconds).toBe(0);
  });

  it('не выходит за бюджет и оставляет запас', () => {
    const list = buildPlaylist({
      budget: 90,
      candidates: [
        can('bracket'),
        can('standings'),
        can('records'),
        can('playerCard'),
        can('nextUp'),
      ],
      shows: [],
      hasCountdown: false,
    });

    expect(list.total).toBeLessThanOrEqual(90 - RESERVE);
  });

  it('при тесном бюджете берёт минимальную длительность, при свободном — максимальную', () => {
    const tight = buildPlaylist({
      // 20 запаса + 8 «что дальше» + 12 сетки — ровно в притык.
      budget: 40,
      candidates: [can('bracket'), can('nextUp')],
      shows: [],
      hasCountdown: false,
    });
    const bracketTight = tight.items.find((x) => x.id === 'bracket');
    expect(bracketTight?.seconds).toBe(sceneMeta('bracket').min);

    const loose = buildPlaylist({
      budget: 600,
      candidates: [can('bracket'), can('nextUp')],
      shows: [],
      hasCountdown: false,
    });
    const bracketLoose = loose.items.find((x) => x.id === 'bracket');
    expect(bracketLoose?.seconds).toBe(sceneMeta('bracket').max);
  });

  it('не повторяет то, что уже показывали', () => {
    const list = buildPlaylist({
      budget: 300,
      candidates: [can('playerCard'), can('nextUp')],
      shows: [shown('playerCard', '2026-08-16T10:00:00Z')],
      hasCountdown: false,
    });

    expect(ids(list.items)).not.toContain('playerCard');
    expect(list.dropped).toEqual([
      { id: 'playerCard', objectKey: '', reason: 'уже показывали' },
    ]);
  });

  it('карточка одного игрока не мешает показать карточку другого', () => {
    const list = buildPlaylist({
      budget: 300,
      candidates: [
        can('playerCard', { objectKey: 'p:1' }),
        can('playerCard', { objectKey: 'p:2' }),
        can('nextUp'),
      ],
      shows: [shown('playerCard', '2026-08-16T10:00:00Z', 1, 'p:1')],
      hasCountdown: false,
    });

    const cards = list.items.filter((x) => x.id === 'playerCard');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.objectKey).toBe('p:2');
  });

  it('обязательные к моменту идут первыми', () => {
    const list = buildPlaylist({
      budget: 300,
      candidates: [
        can('records'),
        can('standings'),
        can('bracket', { required: true }),
        can('nextUp'),
      ],
      shows: [],
      hasCountdown: false,
    });

    expect(ids(list.items)[0]).toBe('bracket');
  });

  it('из повторяемых берёт ту, что дольше всех не показывалась', () => {
    const list = buildPlaylist({
      // Хватает ровно на одну сцену помимо хвоста.
      budget: 20 + 8 + 12,
      candidates: [can('standings'), can('bracket'), can('nextUp')],
      shows: [
        shown('standings', '2026-08-16T09:00:00Z'),
        shown('bracket', '2026-08-16T11:00:00Z'),
      ],
      hasCountdown: false,
    });

    expect(ids(list.items)).toContain('standings');
    expect(ids(list.items)).not.toContain('bracket');
  });

  it('сцену без данных не берёт и говорит повод', () => {
    const list = buildPlaylist({
      budget: 300,
      candidates: [
        can('playerCard', { available: false, reason: 'нет статистики по игроку' }),
        can('nextUp'),
      ],
      shows: [],
      hasCountdown: false,
    });

    expect(ids(list.items)).not.toContain('headToHead');
    expect(list.dropped[0]?.reason).toBe('нет статистики по игроку');
  });

  it('сцены без таймера в плейлист не попадают', () => {
    const list = buildPlaylist({
      budget: 300,
      candidates: [can('idle'), can('message'), can('nextUp')],
      shows: [],
      hasCountdown: false,
    });

    expect(ids(list.items)).toEqual(['nextUp']);
    expect(list.dropped.map((d) => d.id).sort()).toEqual(['idle', 'message']);
  });

  it('крошечный бюджет не даёт отрицательных длительностей', () => {
    const list = buildPlaylist({
      budget: 5,
      candidates: [can('bracket'), can('nextUp')],
      shows: [],
      hasCountdown: false,
    });

    expect(list.items.every((x) => x.seconds >= 0)).toBe(true);
    expect(ids(list.items)).not.toContain('bracket');
  });

  /**
   * Двенадцать карточек игрока честно влезают в четыре минуты — и превращают
   * паузу в парад одной сцены. Предел считается по заготовке, а не по объекту.
   */
  it('одна заготовка не занимает всю паузу, сколько бы объектов у неё ни было', () => {
    const players = Array.from({ length: 12 }, (_, i) =>
      can('playerCard', { objectKey: `p:${i + 1}` }),
    );

    const list = buildPlaylist({
      budget: 600,
      candidates: [...players, can('bracket'), can('standings'), can('nextUp')],
      shows: [],
      hasCountdown: false,
    });

    const cards = ids(list.items).filter((id) => id === 'playerCard');
    expect(cards).toHaveLength(MAX_PER_SCENE);
    expect(list.dropped.filter((d) => d.id === 'playerCard')).not.toHaveLength(0);
  });

  it('одинаковые заготовки не стоят подряд', () => {
    const list = buildPlaylist({
      budget: 600,
      candidates: [
        can('playerCard', { objectKey: 'p:1' }),
        can('playerCard', { objectKey: 'p:2' }),
        can('bracket'),
        can('standings'),
        can('nextUp'),
      ],
      shows: [],
      hasCountdown: false,
    });

    const order = ids(list.items);
    const pairs = order.slice(1).filter((id, i) => id === order[i]);
    expect(pairs).toHaveLength(0);
  });
});

describe('порядок, заданный на раунд', () => {
  it('идёт по плану, а не по «дольше всех не показывалась»', () => {
    const list = buildPlaylist({
      budget: 600,
      candidates: [can('records'), can('bracket'), can('standings'), can('nextUp')],
      // Сетку только что показывали — сам подбор поставил бы её последней.
      shows: [shown('bracket', '2026-08-16T12:00:00.000Z')],
      hasCountdown: false,
      order: ['bracket', 'records', 'standings'],
    });

    expect(ids(list.items)).toEqual(['bracket', 'records', 'standings', 'nextUp']);
  });

  /** Ответ хоста на вопрос про пустые сцены: молча пропустить и взять дальше. */
  it('пустую сцену молча пропускает и берёт следующую', () => {
    const list = buildPlaylist({
      budget: 600,
      candidates: [
        can('bracket'),
        can('records', { available: false, reason: 'сыграно слишком мало' }),
        can('standings'),
        can('nextUp'),
      ],
      shows: [],
      hasCountdown: false,
      order: ['bracket', 'records', 'standings'],
    });

    expect(ids(list.items)).toEqual(['bracket', 'standings', 'nextUp']);
    expect(list.dropped).toEqual([
      { id: 'records', objectKey: '', reason: 'сыграно слишком мало' },
    ]);
  });

  it('одна заготовка дважды в плане берёт два разных объекта', () => {
    const list = buildPlaylist({
      budget: 600,
      candidates: [
        can('playerCard', { objectKey: 'p:1' }),
        can('playerCard', { objectKey: 'p:2' }),
        can('nextUp'),
      ],
      shows: [],
      hasCountdown: false,
      order: ['playerCard', 'playerCard'],
    });

    expect(list.items.map((x) => x.objectKey)).toEqual(['p:1', 'p:2', '']);
  });

  it('хвост ставит эфир: отсчёт из плана в середину не попадает', () => {
    const list = buildPlaylist({
      budget: 600,
      candidates: [can('bracket'), can('standings'), can('countdown'), can('nextUp')],
      shows: [],
      hasCountdown: true,
      order: ['countdown', 'bracket', 'standings'],
    });

    expect(ids(list.items)).toEqual(['bracket', 'standings', 'countdown']);
  });

  it('план не влезает в бюджет — лишнее отсекается с поводом', () => {
    const list = buildPlaylist({
      budget: 60,
      candidates: [can('bracket'), can('standings'), can('records'), can('nextUp')],
      shows: [],
      hasCountdown: false,
      order: ['bracket', 'standings', 'records'],
    });

    // Минута минус запас и хвост — это 32 секунды: сетка и «кто в игре» влезли,
    // рекорды нет.
    expect(ids(list.items)).toEqual(['bracket', 'standings', 'nextUp']);
    expect(list.dropped).toEqual([
      { id: 'records', objectKey: '', reason: 'не влезает в бюджет паузы' },
    ]);
  });

  it('пустой план — подбор идёт сам', () => {
    const list = buildPlaylist({
      budget: 240,
      candidates: [can('bracket'), can('standings'), can('nextUp')],
      shows: [],
      hasCountdown: false,
      order: [],
    });

    expect(ids(list.items).length).toBeGreaterThan(1);
    expect(ids(list.items).at(-1)).toBe('nextUp');
  });
});
