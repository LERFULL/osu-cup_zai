// Каталог заготовок. Одно место, где записано, что за сцена, сколько она стоит
// в эфире и можно ли показывать её второй раз.
//
// Длительности взяты из ТЗ. Две вместо одной, потому что бюджет паузы бывает
// тесным и свободным: при тесном берётся минимальная, при свободном —
// максимальная, а ниже минимальной сцена не сокращается, а не берётся вовсе.

import type { SceneId } from './types';
import { MATCH_SCENES } from './types';

/** Как сцена узнаёт, когда ей уйти. */
export type Timing =
  /** Столько секунд, сколько отвела заготовка. */
  | 'fixed'
  /** По данным: длина карты, остаток отсчёта, длина видеофайла. */
  | 'data'
  /** Не уходит сама. */
  | 'none';

export interface SceneMeta {
  id: SceneId;
  kind: 'match' | 'pause';
  /** Как сцена называется в пульте. */
  title: string;
  /** Что в кадре — подпись под названием в списке заготовок. */
  about: string;
  timing: Timing;
  /** Секунды. У `timing` кроме `fixed` не используются. */
  min: number;
  max: number;
  /** Можно показывать не один раз за турнир. */
  repeatable: boolean;
  /**
   * Повторы считаются по объекту, а не по сцене: карточка NAGISA не мешает
   * показать карточку KIRA.
   */
  byObject: boolean;
  /**
   * Врезка: накрывает «Ход матча» с затемнением, а не заменяет её. Поэтому в
   * состоянии два слоя, а не один — иначе врезка тащила бы в себе копию матча.
   */
  overlay: boolean;
}

const meta = (m: SceneMeta): SceneMeta => m;

export const SCENES: SceneMeta[] = [
  // ─────────────────────────────────────────────────────── сцены матча
  meta({
    id: 'matchIntro',
    kind: 'match',
    title: 'Представление',
    about: 'Двое друг против друга: сеяние, личный счёт, до скольких побед',
    timing: 'fixed',
    min: 10,
    max: 14,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'matchLive',
    kind: 'match',
    title: 'Ход матча',
    about: 'Главная сцена: маппул, счёт, чей ход и что он делает',
    timing: 'none',
    min: 0,
    max: 0,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'banReveal',
    kind: 'match',
    title: 'Бан',
    about: 'Забаненная карта гаснет, обложка уходит в чёрно-белое',
    timing: 'fixed',
    min: 2.5,
    max: 3,
    repeatable: true,
    byObject: false,
    overlay: true,
  }),
  meta({
    id: 'pickReveal',
    kind: 'match',
    title: 'Пик',
    about: 'Пикнутая карта разворачивается на весь экран',
    timing: 'fixed',
    min: 4,
    max: 5,
    repeatable: true,
    byObject: false,
    overlay: true,
  }),
  meta({
    id: 'mapProgress',
    kind: 'match',
    title: 'Карта идёт',
    about: 'Полоса прогресса, прошло и осталось, счёт по картам',
    timing: 'data',
    min: 0,
    max: 0,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'mapResult',
    kind: 'match',
    title: 'Результат карты',
    about: 'Победитель с короной, очки обоих, точность, комбо',
    timing: 'fixed',
    min: 5,
    max: 7,
    repeatable: true,
    byObject: false,
    overlay: true,
  }),
  meta({
    id: 'matchResult',
    kind: 'match',
    title: 'Итог матча',
    about: 'Счёт, победитель, куда пошёл и куда упал проигравший',
    timing: 'fixed',
    min: 8,
    max: 12,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'bountyHeads',
    kind: 'match',
    title: 'Деньги на голове',
    about: 'Что висит на каждом перед матчем — врезка перед представлением',
    timing: 'fixed',
    min: 5,
    max: 7,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'bountyTaken',
    kind: 'match',
    title: 'Баунти снято',
    about: 'Кто снял, сколько забрал и сколько переехало ему на голову',
    timing: 'fixed',
    min: 4,
    max: 6,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),

  // ─────────────────────────────────────────────────────── сцены паузы

  // Трейлеры: первый показ отличается от эфира по ходу игры. Выходят до
  // первого матча — один раз за турнир.
  meta({
    id: 'trailerTitle',
    kind: 'pause',
    title: 'Трейлер: название',
    about: 'Крупное название турнира, формат и маппулы — что сейчас начнётся',
    timing: 'fixed',
    min: 14,
    max: 20,
    repeatable: false,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'trailerPlayers',
    kind: 'pause',
    title: 'Трейлер: участники',
    about: 'Все игроки с сеянием — камера едет по списку',
    timing: 'fixed',
    min: 14,
    max: 20,
    repeatable: false,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'trailerStakes',
    kind: 'pause',
    title: 'Трейлер: что на кону',
    about: 'Фонд и его устройство: движок и надстройки — что разыгрывают',
    timing: 'fixed',
    min: 12,
    max: 18,
    repeatable: false,
    byObject: false,
    overlay: false,
  }),

  meta({
    id: 'bracket',
    kind: 'pause',
    title: 'Сетка',
    about: 'Сетка целиком, путь каждого игрока в его цвете',
    timing: 'fixed',
    min: 12,
    max: 18,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'standings',
    kind: 'pause',
    title: 'Кто в игре',
    about: 'Кто ещё играет и кто вылетел, с местами и поражениями',
    timing: 'fixed',
    min: 10,
    max: 14,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'nextUp',
    kind: 'pause',
    title: 'Что дальше',
    about: 'Следующий матч и ещё два за ним',
    timing: 'fixed',
    min: 8,
    max: 10,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'countdown',
    kind: 'pause',
    title: 'Отсчёт',
    about: 'Крупные цифры до начала следующего матча',
    timing: 'data',
    min: 0,
    max: 0,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'playerCard',
    kind: 'pause',
    title: 'Карточка игрока',
    about: 'Ранг и pp из osu!, турниров сыграно, любимый и худший мод',
    timing: 'fixed',
    min: 10,
    max: 14,
    repeatable: false,
    byObject: true,
    overlay: false,
  }),
  meta({
    id: 'records',
    kind: 'pause',
    title: 'Рекорды',
    about: 'Самая близкая карта, самая длинная серия, самый быстрый матч',
    timing: 'fixed',
    min: 12,
    max: 16,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'stats',
    kind: 'pause',
    title: 'Цифры турнира',
    about: 'Подробная статистика: матчи, карты, моды, лучшие игроки',
    timing: 'fixed',
    min: 14,
    max: 18,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'champion',
    kind: 'pause',
    title: 'Пьедестал',
    about: 'Три места, счёт по матчам и картам, свечение в цвет',
    timing: 'fixed',
    min: 15,
    max: 25,
    repeatable: false,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'credits',
    kind: 'pause',
    title: 'Титры',
    about: 'Все участники, их места, длительность турнира',
    timing: 'fixed',
    min: 15,
    max: 20,
    repeatable: false,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'fundBoard',
    kind: 'pause',
    title: 'Табло фонда',
    about: 'Как фонд распределён и кто сколько уже заработал',
    timing: 'fixed',
    min: 12,
    max: 16,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'fundFlow',
    kind: 'pause',
    title: 'Куда идут деньги',
    about: 'Фонд течёт по потокам: движок и надстройки, сумма на каждом',
    timing: 'fixed',
    min: 10,
    max: 14,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'topEarners',
    kind: 'pause',
    title: 'Кто при деньгах',
    about: 'Топ заработавших на сейчас — с суммами, по убыванию',
    timing: 'fixed',
    min: 8,
    max: 12,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'rookieRace',
    kind: 'pause',
    title: 'Гонка новичков',
    about: 'Вторая таблица отдельной гонкой — сетка одна, гонки две',
    timing: 'fixed',
    min: 10,
    max: 14,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'spectatorBank',
    kind: 'pause',
    title: 'Зрительский банк',
    about: 'За что голосуют и кто взял приз за лучший матч',
    timing: 'fixed',
    min: 10,
    max: 14,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'jackpotScene',
    kind: 'pause',
    title: 'Джекпот',
    about: 'Сколько переезжает в фонд следующего турнира',
    timing: 'fixed',
    min: 8,
    max: 12,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'idle',
    kind: 'pause',
    title: 'Заставка',
    about: 'Логотип турнира и «скоро начнём»',
    timing: 'none',
    min: 0,
    max: 0,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),
  meta({
    id: 'message',
    kind: 'pause',
    title: 'Своя надпись',
    about: 'Текст, который набирают в пульте: «перерыв 10 минут»',
    timing: 'none',
    min: 0,
    max: 0,
    repeatable: true,
    byObject: false,
    overlay: false,
  }),
];

const BY_ID = new Map<SceneId, SceneMeta>(SCENES.map((s) => [s.id, s]));

export function sceneMeta(id: SceneId): SceneMeta {
  const found = BY_ID.get(id);
  if (found === undefined) throw new Error(`нет заготовки ${id}`);
  return found;
}

export const MATCH_LIST = SCENES.filter((s) => s.kind === 'match');
export const PAUSE_LIST = SCENES.filter((s) => s.kind === 'pause');

/** Врезка накрывает «Ход матча» и уходит сама, возвращая её обратно. */
export const isOverlay = (id: SceneId): boolean => sceneMeta(id).overlay;

/** Сцена матча — та, что идёт по ходу игры, а не в паузе. */
export const isMatchScene = (id: SceneId): boolean =>
  (MATCH_SCENES as readonly SceneId[]).includes(id);
