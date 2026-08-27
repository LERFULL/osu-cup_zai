// Сценарий эфира: какое событие в приложении какой кадр выводит.
//
// Один и тот же набор переходов лежит в основе всех трёх режимов управления.
// Отличается только то, кто нажимает: в ручном — хост, в режиме с подтверждением
// предложение ждёт кнопки, в авто выходит сразу. Поэтому здесь нет ни одного
// упоминания режима: режиссёр считает, что показать, а не когда.

import { sceneMeta } from './catalog';
import * as build from './payload';
import type { AirContext } from './payload';
import type { AirLayer, LobbyGame, SceneId, ScenePayload } from './types';
import type { MatchState } from '@/lib/types';

/**
 * Куда уходит кадр, когда отыграет. Не готовый стек слоёв, а именно «куда»:
 * между постановкой предложения и его выводом проходят секунды, и за это время
 * матч успевает уйти вперёд. Замороженный стек вернул бы в эфир вчерашний счёт.
 */
export type After =
  /** «Ход матча», пересобранный по нынешнему состоянию. */
  | { kind: 'live' }
  /** Идущая карта, а если её нет — «Ход матча». */
  | { kind: 'progress' }
  /** Плейлист паузы. */
  | { kind: 'pause' }
  /** Заданный кадр: он от состояния матча не зависит. */
  | { kind: 'layers'; layers: AirLayer[] };

/** Предложение вывести кадр. */
export interface Proposal {
  id: SceneId;
  /** Ключ объекта для сцен «по объекту»: игрок или пара. */
  objectKey: string;
  /** Что именно покажет — строка карточки в пульте. */
  label: string;
  /** Готовый стек слоёв: обычно один, при врезке два. */
  layers: AirLayer[];
  /** Сколько секунд кадр стоит. 0 — без таймера. */
  seconds: number;
  /** Стрелка из ТЗ 8.1: что встаёт в эфир, когда этот кадр отыграл. */
  after: After;
}

export const nowIso = (): string => new Date().toISOString();

export const plusSeconds = (secs: number, from = Date.now()): string =>
  new Date(from + secs * 1000).toISOString();

/** Слой с таймером или без. `seconds` 0 означает «стоит, пока не сменят». */
export function layer(id: SceneId, payload: ScenePayload, seconds = 0): AirLayer {
  const at = Date.now();
  return {
    id,
    since: new Date(at).toISOString(),
    until: seconds > 0 ? plusSeconds(seconds, at) : null,
    payload,
  };
}

/** Основа кадра матча — сцена, поверх которой ложатся врезки. */
export function liveLayer(ctx: AirContext, m: MatchState): AirLayer {
  return layer('matchLive', build.matchLive(ctx, m));
}

/** Сколько секунд отвести сцене: свободный бюджет — берём максимум.
 *
 * `pace` — темп эфира из настроек: 1 — как задумано, больше — быстрее. */
const secondsOf = (id: SceneId, pace = 1): number => {
  const meta = sceneMeta(id);
  if (meta.timing !== 'fixed') return 0;
  return Math.max(0.5, meta.max / Math.max(0.25, pace));
};

/** Кадр из одной сцены. */
function single(
  id: SceneId,
  payload: ScenePayload,
  label: string,
  after: After,
  objectKey = '',
  pace = 1,
): Proposal {
  const seconds = secondsOf(id, pace);
  return { id, objectKey, label, layers: [layer(id, payload, seconds)], seconds, after };
}

/** Врезка: накрывает «Ход матча» и уходит сама, возвращая её обратно. */
function overlay(
  id: SceneId,
  payload: ScenePayload,
  label: string,
  base: AirLayer,
  after: After,
  pace = 1,
): Proposal {
  const seconds = secondsOf(id, pace);
  return {
    id,
    objectKey: '',
    label,
    layers: [base, layer(id, payload, seconds)],
    seconds,
    after,
  };
}

const count = (m: MatchState, type: 'ban' | 'pick' | 'result'): number =>
  m.actions.filter((a) => a.type === type).length;

/**
 * Что показать по разнице между прошлым и нынешним состоянием матча.
 *
 * Одно действие судьи может дать несколько кадров: результат карты выводит
 * «Результат», а за ним «Матчпоинт», если после него кому-то осталась одна
 * победа. Поэтому список, а не один кадр.
 */
export function planMatch(
  ctx: AirContext,
  prev: MatchState | null,
  next: MatchState,
  lobby: LobbyGame | null,
  pace = 1,
): Proposal[] {
  const out: Proposal[] = [];
  const base = liveLayer(ctx, next);
  const live: After = { kind: 'live' };

  // ── матч открыт
  if (prev === null || prev.id !== next.id) {
    // Деньги на голове идут врезкой перед представлением: сначала что
    // на кону, потом кто играет.
    const heads = build.bountyHeads(ctx, next);
    if (heads !== null) {
      const intro = layer('matchIntro', build.matchIntro(ctx, next), secondsOf('matchIntro', pace));
      out.push(
        single('bountyHeads', heads, `Головы — ${heads.a.nick} и ${heads.b.nick}`, {
          kind: 'layers',
          layers: [intro],
        }, '', pace),
      );
    }
    out.push(
      single('matchIntro', build.matchIntro(ctx, next), representation(next, ctx), live, '', pace),
    );
    // Дальше по этому же состоянию сравнивать не с чем: остальные события
    // будут на следующих обновлениях.
    return out;
  }

  // ── бан сделан
  if (count(next, 'ban') > count(prev, 'ban')) {
    const reveal = build.banReveal(ctx, next);
    if (reveal !== null) {
      out.push(
        overlay(
          'banReveal',
          reveal,
          `Бан ${reveal.n} — ${reveal.map.slot} ${reveal.by === null ? '' : `от ${reveal.by.nick}`}`.trim(),
          base,
          live,
          pace,
        ),
      );
    }
  }

  // ── пик сделан: за врезкой идёт не «Ход матча», а идущая карта
  if (count(next, 'pick') > count(prev, 'pick')) {
    const reveal = build.pickReveal(ctx, next);
    if (reveal !== null) {
      out.push(
        overlay(
          'pickReveal',
          reveal,
          `Пик ${reveal.map.slot}${reveal.by === null ? '' : ` — ${reveal.by.nick}`}`,
          base,
          { kind: 'progress' },
          pace,
        ),
      );
    }
  }

  // ── карта закончилась
  if (count(next, 'result') > count(prev, 'result')) {
    const result = build.mapResult(ctx, next, lobby);
    if (result !== null) {
      out.push(
        overlay(
          'mapResult',
          result,
          `Результат ${result.map.slot}${result.winner === null ? '' : ` — взял ${result.winner.nick}`}`,
          base,
          live,
          pace,
        ),
      );
    }
  }

  // ── матч завершён: дальше плейлист паузы, а не «Ход матча»
  if (prev.status !== 'finished' && next.status === 'finished') {
    const result = build.matchResult(ctx, next);
    if (result !== null) {
      out.push(
        single(
          'matchResult',
          result,
          `Итог матча — победил ${result.winner.nick}`,
          { kind: 'pause' },
          '',
          pace,
        ),
      );
    }

    // С головы сняли деньги — событие матча, а не паузы: деньги видно сразу
    const bounty = build.bountyTaken(ctx, next);
    if (bounty !== null) {
      out.push(
        single(
          'bountyTaken',
          bounty,
          `Баунти снято — ${bounty.killer.nick} забирает ${bounty.taken}`,
          { kind: 'pause' },
          '',
          pace,
        ),
      );
    }
  }

  return out;
}

function representation(m: MatchState, ctx: AirContext): string {
  const a = build.airPlayer(ctx, m.playerA)?.nick ?? '—';
  const b = build.airPlayer(ctx, m.playerB)?.nick ?? '—';
  return `Представление — ${a} против ${b}`;
}

/**
 * Турнир завершён: пьедестал, за ним титры. Отдельно от матчей, потому что
 * это событие турнира, а не матча.
 */
export function planFinish(ctx: AirContext, pace = 1): Proposal[] {
  const out: Proposal[] = [];
  const podium = build.champion(ctx);
  const titles = build.credits(ctx);

  if (podium !== null) {
    out.push(
      single(
        'champion',
        podium,
        `Пьедестал — победитель ${podium.podium[0]?.nick ?? '—'}`,
        { kind: 'layers', layers: [layer('credits', titles, secondsOf('credits', pace))] },
        '',
        pace,
      ),
    );
  }
  out.push(single('credits', titles, 'Титры', { kind: 'pause' }, '', pace));
  return out;
}

/**
 * Обрезка: матч открыли посреди сцены.
 *
 * Ждать конца сцены нельзя — началась игра. Но и рубить кадр в тот же миг тоже
 * плохо: смена без перехода читается как сбой. Поэтому сцена доигрывает
 * не больше двух секунд.
 */
export const CUT_SHORT = 2;

export function cutShort(current: AirLayer): AirLayer {
  return { ...current, until: plusSeconds(CUT_SHORT) };
}

/** Слой отыграл своё время. */
export function expired(l: AirLayer, at = Date.now()): boolean {
  if (l.until === null) return false;
  const deadline = Date.parse(l.until);
  return Number.isFinite(deadline) && deadline <= at;
}
