// Реестр сцен: `id` выбирает рендерер.
//
// Именно реестр, а не один длинный разбор всех сцен. От этого зависит больше,
// чем кажется: рендерер, читающий описание кадра из данных, добавляется сюда
// одной строкой — и это единственное, что нужно для пользовательских шаблонов.
// Неизвестный `id` не роняет страницу: эфир идёт дальше без этого слоя.

import type { ComponentType } from 'react';
import type { SceneId, ScenePayload } from '@/lib/air/types';
import * as match from './match';
import * as pause from './pause';

/** Рендерер получает своё содержимое и ничего больше. */
type Renderer = ComponentType<{ p: never }>;

const REGISTRY: Partial<Record<SceneId, Renderer>> = {
  // сцены матча
  matchIntro: match.MatchIntro as Renderer,
  matchLive: match.MatchLive as Renderer,
  banReveal: match.BanReveal as Renderer,
  pickReveal: match.PickReveal as Renderer,
  mapProgress: match.MapProgress as Renderer,
  mapResult: match.MapResult as Renderer,
  matchResult: match.MatchResult as Renderer,
  bountyHeads: match.BountyHeads as Renderer,
  bountyTaken: match.BountyTaken as Renderer,

  // сцены паузы
  bracket: pause.BracketScene as Renderer,
  standings: pause.Standings as Renderer,
  nextUp: pause.NextUp as Renderer,
  countdown: pause.Countdown as Renderer,
  playerCard: pause.PlayerCard as Renderer,
  records: pause.Records as Renderer,
  champion: pause.Champion as Renderer,
  credits: pause.Credits as Renderer,
  fundBoard: pause.FundBoard as Renderer,
  fundFlow: pause.FundFlow as Renderer,
  topEarners: pause.TopEarners as Renderer,
  rookieRace: pause.RookieRace as Renderer,
  spectatorBank: pause.SpectatorBank as Renderer,
  jackpotScene: pause.JackpotScene as Renderer,
  trailerTitle: pause.TrailerTitle as Renderer,
  trailerPlayers: pause.TrailerPlayers as Renderer,
  trailerStakes: pause.TrailerStakes as Renderer,
  idle: pause.Idle as Renderer,
  message: pause.Message as Renderer,
};

/** Рисует слой. `null` — такого рендерера нет, слой пропускается молча. */
export function renderScene(id: SceneId, payload: ScenePayload): React.ReactElement | null {
  const Scene = REGISTRY[id];
  if (Scene === undefined) return null;
  return <Scene p={payload as never} />;
}

export const knownScene = (id: SceneId): boolean => REGISTRY[id] !== undefined;
