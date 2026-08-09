import { useCallback, useEffect, useRef, useState } from 'react';
import type { Beatmap, LibraryFilter, Page } from '@/lib/types';
import * as ipc from '@/lib/ipc';

const PAGE = 100;

/**
 * Постраничная подгрузка библиотеки. Фильтрация целиком на стороне SQL,
 * в памяти живёт только то, что уже пролистали.
 */
export function useBeatmapPages(filter: LibraryFilter) {
  const [items, setItems] = useState<Beatmap[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Ответ на устаревший фильтр не должен затирать свежий список.
  const run = useRef(0);
  // Пока страница едет, второй запрос на неё же не отправляем.
  const busy = useRef(false);
  // Зеркало длины и общего числа: нужны внутри loadMore, но не должны
  // пересоздавать её и дёргать эффект подгрузки.
  const loaded = useRef(0);
  const known = useRef(0);

  useEffect(() => {
    const my = ++run.current;
    busy.current = false;
    setLoading(true);
    setError(null);

    ipc
      .listBeatmaps(filter, 0, PAGE)
      .then((page: Page<Beatmap>) => {
        if (my !== run.current) return;
        loaded.current = page.items.length;
        known.current = page.total;
        setItems(page.items);
        setTotal(page.total);
      })
      .catch((e: unknown) => {
        if (my !== run.current) return;
        loaded.current = 0;
        known.current = 0;
        setError(String(e));
        setItems([]);
        setTotal(0);
      })
      .finally(() => {
        if (my === run.current) setLoading(false);
      });
  }, [filter]);

  const loadMore = useCallback(async () => {
    if (busy.current) return;
    if (loaded.current >= known.current) return;

    const my = run.current;
    const offset = loaded.current;
    busy.current = true;

    try {
      const page = await ipc.listBeatmaps(filter, offset, PAGE);
      if (my !== run.current) return;
      loaded.current = offset + page.items.length;
      known.current = page.total;
      setItems((prev) => [...prev, ...page.items]);
      setTotal(page.total);
    } catch {
      // Страница не доехала — молча останавливаемся, уже загруженное остаётся.
    } finally {
      busy.current = false;
    }
  }, [filter]);

  const patch = useCallback((map: Beatmap) => {
    setItems((prev) => prev.map((m) => (m.beatmapId === map.beatmapId ? map : m)));
  }, []);

  const drop = useCallback((ids: number[]) => {
    const gone = new Set(ids);
    setItems((prev) => {
      const next = prev.filter((m) => !gone.has(m.beatmapId));
      loaded.current = next.length;
      return next;
    });
    setTotal((t) => {
      const next = Math.max(0, t - ids.length);
      known.current = next;
      return next;
    });
  }, []);

  return { items, total, loading, error, loadMore, patch, drop };
}
