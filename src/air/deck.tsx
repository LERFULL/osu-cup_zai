// Декорации шаблона — архитектура кадра, на которой сцены раскладывают
// содержимое. Стиль отвечает за движение, шаблон — за пространство: Рим это
// белое поле с колоннами и золотом, osu! — тёмная арена с треугольниками и
// кольцами, osu!cup — родное тёмное стекло с акцентом турнира.
//
// Декорации не знают про данные: в них нет ников, счёта и карт. Чистая сцена —
// и потому одна на все сцены. А вот стиль доходит и сюда: спортивный ставит
// декорации сразу и не двигает, зрительский складывает их по очереди, кино —
// разводит по глубине и медленно ведёт (селекторы по data-anim на слое).

import type { AirTemplate } from '@/lib/air/types';
import s from './deck.module.css';

export function Deck({ template }: { template: AirTemplate }) {
  if (template === 'rome') return <RomeDeck />;
  if (template === 'osu') return <OsuDeck />;
  return <CupDeck />;
}

/** osu!cup: тёмное стекло и акцент турнира — родной вид приложения. */
function CupDeck() {
  return (
    <div className={s.cup} aria-hidden>
      <div className={s.cupGlow} />
      <div className={s.cupGlowBack} />
      <div className={s.cupGrid} />
    </div>
  );
}

/**
 * Древний Рим: белое пространство, колонны по краям, золотые линии.
 *
 * Античность читается архитектурой, а не рисунками: колонна это линия с
 * капителью, фриз это золотая нить сверху и снизу, мрамор это тёплая белизна
 * с мягкими тенями. Ничего буквального — только эпоха в геометрии.
 */
function RomeDeck() {
  return (
    <div className={s.rome} aria-hidden>
      <div className={s.romeMarble} />
      {/* Фриз: золотая нить сверху и снизу кадра */}
      <div className={s.romeFrieze} />
      <div className={`${s.romeFrieze} ${s.romeFriezeBottom}`} />
      {/* Колонны: по паре с каждого края, ближе и дальше — глубина без
          перспективы, просто две яркости */}
      <div className={s.romeCols}>
        <i style={{ '--c': 0 } as React.CSSProperties} />
        <i style={{ '--c': 1 } as React.CSSProperties} />
        <i style={{ '--c': 2 } as React.CSSProperties} />
        <i style={{ '--c': 3 } as React.CSSProperties} />
        <i style={{ '--c': 4 } as React.CSSProperties} />
        <i style={{ '--c': 5 } as React.CSSProperties} />
      </div>
      {/* Арка за содержимым: полукруг золота, еле заметный */}
      <div className={s.romeArch} />
    </div>
  );
}

/**
 * Оригинальный osu!: тёмная арена с треугольниками и кольцами_approach.
 *
 * Фирменное узнаётся без логотипа: розовый и жёлтый на тёмном, треугольники
 * летят вверх (как на экранах игры), кольцо approach-circle медленно
 * сжимается где-то на заднем плане.
 */
function OsuDeck() {
  return (
    <div className={s.osu} aria-hidden>
      <div className={s.osuGlow} />
      {/* Треугольники: столько, сколько в игре, — лёгкий поток вверх */}
      <div className={s.osuTris}>
        {Array.from({ length: 14 }, (_, i) => (
          <i key={i} style={{ '--i': i } as React.CSSProperties} />
        ))}
      </div>
      {/* Кольцо подхода: сжимается и растворяется, по кругу */}
      <div className={s.osuRing} />
      <div className={`${s.osuRing} ${s.osuRingLate}`} />
    </div>
  );
}
