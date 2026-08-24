// Мини-пульт: эфир под рукой на любом экране.
//
// Хост ведёт матч на экране матча, а не в разделе «Эфир». Уходить туда за
// каждым кадром — это и есть то время, которое эфир должен экономить, поэтому
// управление приезжает к хосту, а не хост к нему.
//
// Здесь ровно то, что нужно во время игры: что в эфире и сколько ему осталось,
// что выйдет дальше, кнопка вывода и пять частых кадров. Всё остальное —
// ссылки, бюджет паузы, задержка — живёт в полном пульте.

import { useState } from 'react';
import { useAir } from '@/lib/air/store';
import { sceneMeta } from '@/lib/air/catalog';
import { useApp } from '@/store/app';
import { leftLabel, QUICK, useFrame } from './shared';
import s from './Dock.module.css';

export function Dock() {
  const air = useAir();
  const go = useApp((st) => st.go);
  const frame = useFrame();
  const [open, setOpen] = useState(true);

  const status = air.status;
  if (status?.live !== true) return null;

  const plan = air.plan();
  const now = air.airing === null ? 'кадра ещё нет' : sceneMeta(air.airing.id).title;

  if (!open) {
    return (
      <button className={s.pill} type="button" onClick={() => setOpen(true)}>
        <i aria-hidden />
        <span className={s.pillNow}>{now}</span>
        <span className={s.pillNext}>дальше: {plan.label}</span>
      </button>
    );
  }

  return (
    <aside className={s.dock}>
      <header className={s.head}>
        <span className={s.live}>
          <i aria-hidden /> Эфир
        </span>
        <button className={s.link} type="button" onClick={() => go('air')}>
          Пульт
        </button>
        <button className={s.fold} type="button" onClick={() => setOpen(false)} aria-label="Свернуть">
          ⌄
        </button>
      </header>

      {/* ── что в эфире */}
      <div className={s.block}>
        <div className={s.label}>
          Сейчас
          <span className={s.time}>{leftLabel(frame.left)}</span>
        </div>
        <div className={s.what}>{now}</div>
        <div className={s.bar}>
          <div className={s.barFill} style={{ width: `${(frame.part * 100).toFixed(1)}%` }} />
        </div>
      </div>

      {/* ── что дальше. Главное здесь: без этого хост не знает, что произойдёт. */}
      <div className={[s.block, s.blockNext].join(' ')}>
        <div className={s.label}>
          Дальше
          <span className={plan.automatic ? s.auto : s.manual}>
            {plan.automatic ? 'само' : 'по кнопке'}
          </span>
        </div>
        <div className={s.what}>{plan.label}</div>
        <div className={s.note}>{plan.note}</div>

        <div className={s.row}>
          <button className={s.go} type="button" onClick={() => void air.next()}>
            Дальше ▸
          </button>
          <button
            className={air.frozen ? s.btnOn : s.btn}
            type="button"
            onClick={() => air.freeze(!air.frozen)}
          >
            {air.frozen ? 'Отпустить' : 'Замереть'}
          </button>
        </div>
      </div>

      {/* ── частые кадры */}
      <div className={s.quick}>
        {QUICK.map((q) => (
          <button
            key={q.id}
            className={s.chip}
            type="button"
            title={sceneMeta(q.id).about}
            onClick={() => void air.pick(q.id)}
          >
            {q.label}
          </button>
        ))}
      </div>

      {air.error !== null ? <div className={s.error}>{air.error}</div> : null}
    </aside>
  );
}
