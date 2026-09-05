import { MOD_TAGS, type Pool } from '@/lib/types';
import s from './PoolComposition.module.css';

/**
 * Наглядный состав маппула: по каждому мод-тегу — сегмент шириной по числу
 * слотов и точки-заполненности. По такой полоске видно, что пул «тяжелее»
 * к DT и где пусто, не открывая редактор.
 */
export function PoolComposition({ pool, compact = false }: { pool: Pool; compact?: boolean }) {
  const total = pool.slots.length;
  if (total === 0) return <span className={s.empty}>слотов нет</span>;

  const filled = pool.slots.filter((x) => x.beatmapId !== null).length;
  const stars = pool.slots
    .map((x) => x.starRatingWithMods ?? x.beatmap?.difficultyRating ?? null)
    .filter((v): v is number => v !== null);

  const parts = MOD_TAGS.map((m) => ({
    mod: m,
    count: pool.slots.filter((x) => x.mod === m).length,
    done: pool.slots.filter((x) => x.mod === m && x.beatmapId !== null).length,
  })).filter((x) => x.count > 0);

  return (
    <span className={[s.wrap, compact ? s.compact : null].filter(Boolean).join(' ')}>
      <span className={s.bar} role="img" aria-label={`Состав: ${parts.map((p) => `${p.mod}×${p.count}`).join(', ')}`}>
        {parts.map((p) => (
          <span
            key={p.mod}
            className={s.seg}
            style={{ '--mod': `var(--${p.mod.toLowerCase()})`, flexGrow: p.count } as React.CSSProperties}
            title={`${p.mod}: ${p.done} из ${p.count}`}
          >
            {Array.from({ length: p.count }, (_, i) => (
              <i key={i} className={i < p.done ? s.dot : s.dotEmpty} aria-hidden />
            ))}
          </span>
        ))}
      </span>
      <span className={s.note}>
        {filled} / {total}
        {stars.length > 0 ? ` · ${Math.min(...stars).toFixed(1)}–${Math.max(...stars).toFixed(1)}★` : ''}
      </span>
    </span>
  );
}
