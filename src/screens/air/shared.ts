// Общее у панели эфира и приложения.
//
// Горячие клавиши живут здесь, а не в панели: работать они должны на любом
// экране, даже когда панели на нём нет. Отсчёт кадра — здесь же, потому что
// его считают и панель, и подготовка.

import { useEffect, useState } from 'react';
import { useAir } from '@/lib/air/store';
import type { SceneId } from '@/lib/air/types';

/** Сколько кадру осталось и какую долю он уже отыграл. */
export interface Frame {
  /** Секунды до ухода. `null` — кадр стоит, пока не сменят. */
  left: number | null;
  /** От 0 до 1. Для полосы под названием кадра. */
  part: number;
}

/**
 * Отсчёт текущего кадра.
 *
 * Считается по времени слоя, а не тиками стора: тик у него 400 мс, и полоса
 * дёргалась бы. Здесь свои 200 мс, и они не стоят ничего — это чистая
 * арифметика над двумя метками времени.
 */
export function useFrame(): Frame {
  const airing = useAir((st) => st.airing);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, []);

  const top = airing === null ? null : (airing.layers[airing.layers.length - 1] ?? null);
  if (top === null || top.until === null) return { left: null, part: 0 };

  const from = Date.parse(top.since);
  const to = Date.parse(top.until);
  const span = Math.max(1, to - from);

  return {
    left: Math.max(0, Math.round((to - now) / 1000)),
    part: Math.min(1, Math.max(0, (now - from) / span)),
  };
}

/**
 * Горячие клавиши эфира. Работают на любом экране, пока эфир идёт: хост судит
 * матч, а не сидит в пульте.
 *
 * В полях ввода не срабатывают — там пробел это пробел.
 */
export function useAirKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;

      const air = useAir.getState();
      if (air.status?.live !== true) return;

      if (e.code === 'Space') {
        e.preventDefault();
        void air.next();
      } else if (e.key === 'Pause' || e.key.toLowerCase() === 'p') {
        e.preventDefault();
        air.freeze(!air.frozen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/**
 * Кадры быстрого доступа в паузе. Во время матча выбирать не из чего — там
 * кадр следует за матчем, — а между матчами это самое частое движение хоста.
 */
export const QUICK: { id: SceneId; label: string }[] = [
  { id: 'matchLive', label: 'Матч' },
  { id: 'bracket', label: 'Сетка' },
  { id: 'nextUp', label: 'Что дальше' },
  { id: 'standings', label: 'Кто в игре' },
  { id: 'idle', label: 'Заставка' },
];

/** Время кадра словом: «4 с» или «стоит». */
export const leftLabel = (left: number | null): string => (left === null ? 'стоит' : `${left} с`);
