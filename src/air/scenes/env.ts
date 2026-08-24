// Что сцена знает про сам эфир, а не про кадр.
//
// Два поля, и оба про ограничения снаружи: браузер не даёт играть звук до
// действия пользователя, а через Cloudflare нельзя раздавать видео. Тащить их
// в каждый `payload` значит повторять одно и то же двадцать шесть раз.

import { createContext, useContext } from 'react';

export interface AirEnv {
  /** Зритель разрешил звук. До этого превью-аудио молчит. */
  sound: boolean;
  /** Эфир только локальный — свой видеофайл играть можно. */
  localOnly: boolean;
}

const Ctx = createContext<AirEnv>({ sound: false, localOnly: true });

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
