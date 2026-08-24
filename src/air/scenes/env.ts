// Что сцена знает про сам эфир, а не про кадр.
//
// Одно поле, и оно про ограничение снаружи: браузер не даёт играть звук до
// действия пользователя. Тащить это в каждый `payload` значит повторять одно
// и то же в каждой сцене.

import { createContext, useContext } from 'react';

export interface AirEnv {
  /** Зритель разрешил звук. До этого превью-аудио молчит. */
  sound: boolean;
}

const Ctx = createContext<AirEnv>({ sound: false });

export const EnvProvider = Ctx.Provider;

export const useEnv = (): AirEnv => useContext(Ctx);

/**
 * Срок кадра. Нужен сценам, которые двигаются сами: проход камеры по сетке,
 * прокрутка титров, смена обложек в маппуле.
 *
 * Отсчёт ведётся от времени слоя, а не от того, когда сцена смонтировалась:
 * зашедший посреди кадра должен увидеть его там, где он сейчас, а не с начала.
 */
export interface AirLayerTime {
  since: string;
  /** `null` — кадр стоит, пока его не сменят. */
  until: string | null;
}

const LayerCtx = createContext<AirLayerTime>({ since: new Date(0).toISOString(), until: null });

export const LayerProvider = LayerCtx.Provider;

export const useLayer = (): AirLayerTime => useContext(LayerCtx);
