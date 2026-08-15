import { useCallback, useRef, useState } from 'react';

/**
 * Перетаскивание строк списка мышью.
 *
 * Штатный HTML5 drag-and-drop здесь не годился: он не даёт обратной связи
 * во время перетаскивания — строка не едет за курсором, соседи не
 * расступаются, — и со стороны это выглядит как «не работает». Здесь всё
 * на pointer events: захваченная строка следует за курсором, остальные
 * плавно сдвигаются, а в базу новый порядок уходит один раз, на отпускании.
 */

export interface DragState {
  /** Индекс строки, которую держат. */
  from: number;
  /** Куда она встанет, если отпустить сейчас. */
  to: number;
  /** Сдвиг захваченной строки по вертикали, px. */
  offset: number;
}

interface Options {
  /** Сколько строк в списке. */
  count: number;
  /** Отпустили: новый порядок индексов. Пустую перестановку не зовём. */
  onDrop: (from: number, to: number) => void;
}

/** Что вешается на ручку перетаскивания. */
export interface GripProps {
  onPointerDown: (e: React.PointerEvent) => void;
  style: { cursor: string; touchAction: string };
}

export interface Reorder {
  drag: DragState | null;
  /** Повесить на ручку строки. */
  handleProps: (index: number) => GripProps;
  /** Стиль строки: сдвиг под текущее состояние перетаскивания. */
  rowStyle: (index: number) => React.CSSProperties;
}

export function useReorder({ count, onDrop }: Options): Reorder {
  const [drag, setDrag] = useState<DragState | null>(null);

  // Высоту строки и стартовую точку держим в ref: они нужны обработчикам
  // движения, а перерисовывать из-за них нечего.
  const geom = useRef({ startY: 0, rowH: 0 });

  // Куда встанет строка — тоже в ref. Читать это из обновляющей функции
  // setDrag нельзя: в строгом режиме React зовёт её дважды, и перестановка
  // применялась бы два раза — вторая отменяла бы первую.
  const aim = useRef<DragState | null>(null);

  const handleProps = useCallback(
    (index: number) => ({
      style: { cursor: 'grab', touchAction: 'none' },
      onPointerDown: (e: React.PointerEvent) => {
        // Только основная кнопка: правой вызывают меню, а не тянут.
        if (e.button !== 0) return;
        e.preventDefault();

        const row = (e.currentTarget as HTMLElement).closest('[data-row]');
        if (!(row instanceof HTMLElement)) return;

        // Шаг перестановки — высота строки вместе с зазором между строками.
        const rect = row.getBoundingClientRect();
        const next = row.nextElementSibling;
        const gap =
          next instanceof HTMLElement ? next.getBoundingClientRect().top - rect.bottom : 0;
        geom.current = { startY: e.clientY, rowH: rect.height + Math.max(0, gap) };

        const start = { from: index, to: index, offset: 0 };
        aim.current = start;
        setDrag(start);

        const move = (ev: PointerEvent) => {
          const offset = ev.clientY - geom.current.startY;
          const step = geom.current.rowH || 1;
          const shift = Math.round(offset / step);
          const to = Math.min(Math.max(index + shift, 0), count - 1);
          const state = { from: index, to, offset };
          aim.current = state;
          setDrag(state);
        };

        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);

          const done = aim.current;
          aim.current = null;
          setDrag(null);
          if (done !== null && done.from !== done.to) onDrop(done.from, done.to);
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      },
    }),
    [count, onDrop],
  );

  const rowStyle = useCallback(
    (index: number): React.CSSProperties => {
      if (drag === null) return {};

      // Захваченная строка едет за курсором и идёт поверх остальных.
      if (index === drag.from) {
        return {
          transform: `translateY(${drag.offset}px)`,
          position: 'relative',
          zIndex: 20,
          cursor: 'grabbing',
          // Тень отделяет её от списка — видно, что строку держат.
          filter: 'drop-shadow(0 8px 22px rgb(0 0 0 / 0.55))',
        };
      }

      // Остальные расступаются ровно на одну позицию — туда, откуда
      // ушла захваченная строка.
      const step = geom.current.rowH;
      const movingDown = drag.to > drag.from;
      const between = movingDown
        ? index > drag.from && index <= drag.to
        : index < drag.from && index >= drag.to;

      return {
        transform: between ? `translateY(${movingDown ? -step : step}px)` : undefined,
        transition: 'transform 0.16s cubic-bezier(0.2, 0.7, 0.3, 1)',
      };
    },
    [drag],
  );

  return { drag, handleProps, rowStyle };
}
