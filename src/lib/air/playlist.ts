// Набор сцен под бюджет паузы.
//
// Это ответ на «эфир не должен превращаться в очень долгое событие». Турнир из
// четырнадцати матчей с пятью минутами заставок между ними — это два лишних
// часа, поэтому сцены укладываются в отведённое время, а не крутятся до упора.
//
// Чистая функция без обращений к базе: всё, что нужно решению, приходит
// параметрами. Поэтому её и держат тесты, а не глаз.

import { sceneMeta } from './catalog';
import type { SceneId, SceneShow } from './types';

/** Сколько секунд оставляем свободными в конце паузы. */
export const RESERVE = 20;

/**
 * Сколько раз одна и та же заготовка может выйти за одну паузу.
 *
 * Без этого предела пауза превращается в парад одной сцены: у карточки игрока
 * столько объектов, сколько людей в турнире, и все двенадцать честно влезают в
 * четыре минуты. Смотреть на это невозможно, поэтому счёт идёт по заготовке,
 * а не по объекту.
 */
export const MAX_PER_SCENE = 2;

/** Заготовка, которую можно рассмотреть на эту паузу. */
export interface Candidate {
  id: SceneId;
  /** Для сцен «по объекту» — игрок или пара. Пусто у обычных. */
  objectKey: string;
  /**
   * Про кого этот кадр: ник, пара ников, название маппула.
   *
   * Нужен пульту: двенадцать кнопок «Карточка игрока» без имён неразличимы, и
   * выбрать из них нельзя — можно только угадать.
   */
  objectName: string | null;
  /** Данные под этот момент есть. */
  available: boolean;
  /** Почему сцену взять нельзя. Показывается в пульте приглушённой строкой. */
  reason: string | null;
  /**
   * Обязательна именно сейчас: сетка после последнего матча раунда, маппул
   * перед матчем с новым маппулом.
   */
  required: boolean;
}

export interface PlaylistItem {
  id: SceneId;
  objectKey: string;
  /** Сколько секунд сцена стоит в эфире. */
  seconds: number;
}

export interface Dropped {
  id: SceneId;
  objectKey: string;
  reason: string;
}

export interface Playlist {
  items: PlaylistItem[];
  /** Что не взяли и почему. Молча отсечённое читается как «показали всё». */
  dropped: Dropped[];
  /** Сумма длительностей. */
  total: number;
  budget: number;
}

export interface PlaylistInput {
  /** Сколько секунд отведено на паузу. */
  budget: number;
  candidates: Candidate[];
  /** История показов этого турнира. */
  shows: SceneShow[];
  /** Хост поставил «следующий матч через N минут» — тогда хвост это отсчёт. */
  hasCountdown: boolean;
  /**
   * Порядок сцен, заданный хостом на этот раунд.
   *
   * Есть — идём по нему; нет — подбираем сами по «дольше всех не
   * показывалась». Пустая сцена из плана молча пропускается, а не останавливает
   * паузу: повод виден в `dropped`, но экран не встаёт.
   */
  order?: SceneId[] | undefined;
}

/** Сколько раз эта заготовка уже выходила и когда последний раз. */
function shownAs(shows: SceneShow[], id: SceneId, objectKey: string): SceneShow | null {
  return (
    shows.find((s) => s.sceneId === id && s.objectKey === objectKey) ?? null
  );
}

/**
 * Порядок разбора: сначала обязательные к моменту, потом «дольше всех не
 * показывалась». Ни разу не показанная считается самой давней — иначе свежие
 * заготовки никогда бы не выходили.
 */
function order_(candidates: Candidate[], shows: SceneShow[]): Candidate[] {
  return [...candidates].sort((x, y) => {
    if (x.required !== y.required) return x.required ? -1 : 1;
    const sx = shownAs(shows, x.id, x.objectKey);
    const sy = shownAs(shows, y.id, y.objectKey);
    const ax = sx?.lastAt ?? '';
    const ay = sy?.lastAt ?? '';
    if (ax !== ay) return ax < ay ? -1 : 1;
    // Одинаково давно — по числу показов, реже показанная вперёд.
    return (sx?.shows ?? 0) - (sy?.shows ?? 0);
  });
}

/**
 * Порядок из плана раунда.
 *
 * Одна строка плана — один кадр. Сцена, указанная дважды, берёт два разных
 * объекта: «карточка игрока» дважды это два игрока, а не один дважды.
 * Хвостовые сцены — отсчёт и «что дальше» — из тела выкидываем: они и так
 * встают последними, а в середине паузы им места нет.
 */
function byPlan(plan: SceneId[], candidates: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  const taken = new Set<string>();

  for (const id of plan) {
    if (TAILS.includes(id)) continue;
    const found = candidates.find(
      (c) => c.id === id && !taken.has(`${c.id}|${c.objectKey}`),
    );
    if (found === undefined) continue;
    taken.add(`${found.id}|${found.objectKey}`);
    out.push(found);
  }
  return out;
}

/** Заготовку уже показывали, а второй раз она не выходит. */
function usedUp(candidate: Candidate, shows: SceneShow[]): boolean {
  if (sceneMeta(candidate.id).repeatable) return false;
  const seen = shownAs(shows, candidate.id, candidate.objectKey);
  return (seen?.shows ?? 0) > 0;
}

/**
 * Разводит одинаковые заготовки, стоящие подряд.
 *
 * Двигаем на месте, а не пересобираем: порядок «дольше всех не показывалась»
 * уже посчитан, и ломать его ради развода — значит терять то, ради чего он
 * считался. Хватает одного прохода: подряд стоящих больше двух не бывает.
 */
function spread(items: PlaylistItem[]): void {
  for (let i = 1; i < items.length; i++) {
    const previous = items[i - 1];
    const current = items[i];
    if (previous === undefined || current === undefined) continue;
    if (previous.id !== current.id) continue;

    // Ищем дальше первую несовпадающую и меняемся с ней местами.
    const other = items.findIndex((x, at) => at > i && x.id !== current.id);
    if (other === -1) continue;
    const swap = items[other];
    if (swap === undefined) continue;
    items[i] = swap;
    items[other] = current;
  }
}

/**
 * Хвостовые сцены: обе про то, что будет после паузы, поэтому в середине им
 * места нет — из них выходит ровно одна и ровно последней.
 */
const TAILS: SceneId[] = ['countdown', 'nextUp'];

/**
 * Собирает плейлист паузы. Пауза кончается тем, что будет дальше, а не
 * случайной статистикой, поэтому последней всегда идёт «Что дальше» или отсчёт.
 */
export function buildPlaylist(input: PlaylistInput): Playlist {
  const { budget, candidates, shows, hasCountdown, order } = input;
  const dropped: Dropped[] = [];
  /** По плану порядок задал хост — считать его заново незачем. */
  const planned = order !== undefined && order.length > 0;

  const usable = Math.max(0, budget - RESERVE);

  // ── хвост паузы
  //
  // Отсчёт берётся, когда известно время следующего матча; если самой
  // заготовки нет под рукой, хвостом становится «Что дальше».
  const preferred: SceneId[] = hasCountdown ? ['countdown', 'nextUp'] : ['nextUp'];
  const tail =
    preferred
      .map((id) => candidates.find((c) => c.id === id && c.available) ?? null)
      .find((c) => c !== null) ?? null;

  // У отсчёта длительность своя — остаток до начала матча, — поэтому места
  // под него в бюджете не занимаем.
  const tailSeconds =
    tail === null || sceneMeta(tail.id).timing !== 'fixed' ? 0 : sceneMeta(tail.id).min;

  const body = planned
    ? byPlan(order, candidates)
    : order_(
        candidates.filter((c) => !TAILS.includes(c.id)),
        shows,
      );

  const items: PlaylistItem[] = [];
  let taken = 0;
  /** Сколько раз каждая заготовка уже взята в эту паузу. */
  const times = new Map<SceneId, number>();

  for (const candidate of body) {
    if (!candidate.available) {
      dropped.push({
        id: candidate.id,
        objectKey: candidate.objectKey,
        reason: candidate.reason ?? 'нет данных',
      });
      continue;
    }
    if (usedUp(candidate, shows)) {
      dropped.push({
        id: candidate.id,
        objectKey: candidate.objectKey,
        reason: 'уже показывали',
      });
      continue;
    }

    const m = sceneMeta(candidate.id);
    // Сцены без таймера в плейлист не идут: пауза с заставкой посередине
    // никогда бы не дошла до конца.
    if (m.timing !== 'fixed') {
      dropped.push({
        id: candidate.id,
        objectKey: candidate.objectKey,
        reason: 'выводится вручную, а не по бюджету',
      });
      continue;
    }

    // Одна заготовка не занимает всю паузу, даже если объектов у неё много.
    // По плану предел не действует: порядок задал хост, и спорить с ним
    // программе не за что.
    if (!planned && (times.get(candidate.id) ?? 0) >= MAX_PER_SCENE) {
      dropped.push({
        id: candidate.id,
        objectKey: candidate.objectKey,
        reason: `в одну паузу берём не больше ${MAX_PER_SCENE} раз`,
      });
      continue;
    }

    if (taken + m.min > usable - tailSeconds) {
      dropped.push({
        id: candidate.id,
        objectKey: candidate.objectKey,
        reason: 'не влезает в бюджет паузы',
      });
      continue;
    }

    items.push({ id: candidate.id, objectKey: candidate.objectKey, seconds: m.min });
    times.set(candidate.id, (times.get(candidate.id) ?? 0) + 1);
    taken += m.min;
  }

  // Две одинаковые сцены подряд читаются как зависший эфир, даже если объекты
  // у них разные. Разводим их, сдвигая вторую дальше по списку. По плану не
  // разводим: если хост поставил их рядом, значит так и надо.
  if (!planned) spread(items);

  // ── свободный бюджет раздаём взятым сценам до их максимума
  let slack = usable - tailSeconds - taken;
  for (const item of items) {
    if (slack <= 0) break;
    const m = sceneMeta(item.id);
    const add = Math.min(slack, m.max - m.min);
    item.seconds += add;
    slack -= add;
  }

  if (tail !== null) {
    items.push({ id: tail.id, objectKey: tail.objectKey, seconds: tailSeconds });
  }

  return {
    items,
    dropped,
    total: items.reduce((sum, x) => sum + x.seconds, 0),
    budget,
  };
}

/** «пауза 4 мин — влезает 3 сцены» одной строкой. */
export function playlistSummary(list: Playlist): string {
  const minutes = Math.round(list.budget / 60);
  const count = list.items.length;
  const word = count === 1 ? 'сцена' : count > 1 && count < 5 ? 'сцены' : 'сцен';
  return `пауза ${minutes} мин — влезает ${count} ${word}`;
}
