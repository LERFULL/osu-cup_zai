// Порядок сцен по раундам.
//
// Пауза принадлежит раунду, который после неё начнётся: перед первым раундом
// уместен маппул и личная встреча, перед финалом — путь обоих по сетке. Решать
// это лучше заранее, а не в тот момент, когда все ждут начала.
//
// Раунд без плана подбирается сам, как и раньше, — поэтому заполнять здесь
// ничего не обязательно. «Поставить на все раунды» делает из одного плана
// порядок на весь вечер: чаще всего этого и хватает.

import { useState } from 'react';
import { Button } from '@/components';
import { PAUSE_LIST, sceneMeta } from '@/lib/air/catalog';
import { useAir } from '@/lib/air/store';
import type { SceneId } from '@/lib/air/types';
import { roundKey } from '@/lib/types';
import { Card } from './Card';
import s from './RoundPlans.module.css';

/** Хвостовые сцены ставит эфир сам, последними: в плане им места нет. */
const TAILS: SceneId[] = ['countdown', 'nextUp'];

export function RoundPlans() {
  const { config, patchConfig, ctx } = useAir();
  const rounds = ctx?.editor.rounds ?? [];
  const [openKey, setOpenKey] = useState<string | null>(null);
  /** Что тащим и куда метимся: подсветка только на допустимом месте. */
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  if (rounds.length === 0) {
    return (
      <Card title="Порядок сцен по раундам" note="появится, когда будет собрана сетка">
        <div className={s.quiet}>
          Пока сетки нет, раундов тоже нет. Собери её на экране турнира — здесь появится строка на
          каждый раунд.
        </div>
      </Card>
    );
  }

  const key = openKey ?? roundKey(rounds[0]!.bracket, rounds[0]!.round);
  const open = rounds.find((r) => roundKey(r.bracket, r.round) === key) ?? rounds[0]!;
  const plan = config.roundPlans[key] ?? [];

  const save = (next: SceneId[]) =>
    void patchConfig({ roundPlans: { ...config.roundPlans, [key]: next } });

  /** Свободные заготовки: включённые, не хвостовые. Повторы разрешены. */
  const palette = PAUSE_LIST.filter(
    (m) => config.enabled.includes(m.id) && !TAILS.includes(m.id) && m.timing === 'fixed',
  );

  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = [...plan];
    const [item] = next.splice(from, 1);
    if (item === undefined) return;
    next.splice(to, 0, item);
    save(next);
  };

  const seconds = plan.reduce((sum, id) => sum + sceneMeta(id).min, 0);
  const budget = Math.round(config.pauseBudget / 60);

  return (
    <Card
      title="Порядок сцен по раундам"
      note="пауза перед матчами раунда идёт по этому списку"
    >
      <div className={s.wrap}>
        {/* ── раунды слева: сразу видно, где план есть, а где подбор сам */}
        <div className={s.rounds}>
          {rounds.map((r) => {
            const rk = roundKey(r.bracket, r.round);
            const count = (config.roundPlans[rk] ?? []).length;
            return (
              <button
                key={rk}
                className={[s.round, rk === key ? s.roundOn : null].filter(Boolean).join(' ')}
                type="button"
                onClick={() => setOpenKey(rk)}
              >
                <span className={s.roundTitle}>{r.title}</span>
                <span className={count > 0 ? s.roundCount : s.roundAuto}>
                  {count > 0 ? `${count}` : 'сам'}
                </span>
              </button>
            );
          })}
        </div>

        {/* ── план выбранного раунда */}
        <div className={s.plan}>
          <div className={s.planHead}>
            <span className={s.planTitle}>{open.title}</span>
            <span className={s.planTime}>
              {plan.length === 0
                ? `подбор сам · бюджет ${budget} мин`
                : `${Math.round(seconds)} с из ${budget} мин`}
            </span>
          </div>

          {plan.length === 0 ? (
            <div className={s.empty}>
              Порядок не задан — эфир подберёт сцены сам: обязательные к моменту вперёд, потом те,
              что дольше всех не показывали.
            </div>
          ) : (
            <div className={s.list}>
              {plan.map((id, index) => (
                <div
                  key={`${id}-${index}`}
                  className={[s.row, over === index && drag !== null ? s.rowOver : null]
                    .filter(Boolean)
                    .join(' ')}
                  draggable
                  onDragStart={(e) => {
                    setDrag(index);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => {
                    setDrag(null);
                    setOver(null);
                  }}
                  onDragOver={(e) => {
                    if (drag === null) return;
                    e.preventDefault();
                    setOver(index);
                  }}
                  onDrop={(e) => {
                    if (drag === null) return;
                    e.preventDefault();
                    move(drag, index);
                    setDrag(null);
                    setOver(null);
                  }}
                >
                  <span className={s.grip} aria-hidden>
                    ⠿
                  </span>
                  <span className={s.num}>{index + 1}</span>
                  <span className={s.name}>{sceneMeta(id).title}</span>
                  <span className={s.secs}>
                    {sceneMeta(id).min}–{sceneMeta(id).max} с
                  </span>
                  {/* Клавиатурой — тоже: тащить мышью удобно, но не всегда. */}
                  <button
                    className={s.step}
                    type="button"
                    disabled={index === 0}
                    aria-label="Выше"
                    onClick={() => move(index, index - 1)}
                  >
                    ↑
                  </button>
                  <button
                    className={s.step}
                    type="button"
                    disabled={index === plan.length - 1}
                    aria-label="Ниже"
                    onClick={() => move(index, index + 1)}
                  >
                    ↓
                  </button>
                  <button
                    className={s.drop}
                    type="button"
                    aria-label="Убрать"
                    onClick={() => save(plan.filter((_, at) => at !== index))}
                  >
                    ✕
                  </button>
                </div>
              ))}

              <div className={s.tail}>
                последней эфир поставит сам: отсчёт до матча, а без него — «что дальше»
              </div>
            </div>
          )}

          <div className={s.palette}>
            {palette.map((m) => (
              <button
                key={m.id}
                className={s.add}
                type="button"
                title={m.about}
                onClick={() => save([...plan, m.id])}
              >
                + {m.title}
              </button>
            ))}
          </div>

          <div className={s.actions}>
            <Button
              size="sm"
              variant="primary"
              disabled={plan.length === 0}
              title="Тот же порядок во всех раундах — так получается один план на весь вечер"
              onClick={() => {
                const all: Record<string, SceneId[]> = { ...config.roundPlans };
                for (const r of rounds) all[roundKey(r.bracket, r.round)] = [...plan];
                void patchConfig({ roundPlans: all });
              }}
            >
              Поставить на все раунды
            </Button>
            <Button
              size="sm"
              disabled={plan.length === 0}
              onClick={() => save([])}
            >
              Очистить раунд
            </Button>
            <Button
              size="sm"
              disabled={Object.keys(config.roundPlans).length === 0}
              onClick={() => void patchConfig({ roundPlans: {} })}
            >
              Очистить все
            </Button>
          </div>

          <div className={s.hint}>
            Сцена, под которую в этот момент нет данных, молча пропускается — пауза не встанет.
            Что пропустили и почему, видно в пульте.
          </div>
        </div>
      </div>
    </Card>
  );
}
