// Панель эфира: единственное место, откуда им управляют.
//
// Раньше управление жило в двух местах — полный пульт в разделе «Эфир» и
// плавающий док поверх любого экрана. Два пульта обязаны совпадать, а
// плавающий вдобавок можно свернуть в ноль — ровно в тот момент, когда он
// нужен. Поэтому панель одна и стоит колонкой в разметке: рядом с судейством
// на экране матча и рядом с сеткой на экране турнира.
//
// Во время матча здесь нет выбора сцен, потому что выбирать не из чего: у
// каждого состояния матча есть один правильный кадр. Есть только исключения —
// замереть, выпустить придержанный пик, своя надпись. Выбор появляется в
// паузе, и там же он к месту.
//
// Миниатюра — та же страница зрителя в маленьком размере, а не отдельный
// рисунок: два кадра однажды разошлись бы.

import { useState } from 'react';
import { Button, Field } from '@/components';
import { sceneMeta } from '@/lib/air/catalog';
import { useAir } from '@/lib/air/store';
import { playlistSummary } from '@/lib/air/playlist';
import { isTauri } from '@/lib/host';
import { leftLabel, QUICK, useFrame } from './shared';
import s from './Panel.module.css';

/** Показ в браузере: настоящего сервера нет, кадр идёт каналом внутри окна. */
const inTauri = isTauri();

export function Panel() {
  const air = useAir();
  const { status, airing, frozen, playlist, error } = air;
  const frame = useFrame();

  const [minutes, setMinutes] = useState(6);
  const [text, setText] = useState('');

  if (status?.live !== true) return null;

  const plan = air.plan();
  const previewSrc = inTauri
    ? status.localUrl
    : `${window.location.origin}/air.html?transport=channel`;

  // В паузе у эфира появляются решения: чем занять экран, пока не играют.
  // Во время матча их нет, и показывать пустой блок незачем.
  const inPause = air.watching === null || air.watching.status === 'finished';

  return (
    <aside className={s.panel}>
      <header className={s.head}>
        <span className={s.live}>
          <i aria-hidden /> Эфир
        </span>
        <span className={s.time}>{leftLabel(frame.left)}</span>
      </header>

      {error !== null ? <div className={s.error}>{error}</div> : null}

      {/* ── что в кадре */}
      <div className={s.block}>
        <div className={s.label}>Сейчас</div>
        <div className={s.what}>{airing === null ? 'кадра ещё нет' : sceneMeta(airing.id).title}</div>
        <div className={s.bar}>
          <div className={s.barFill} style={{ width: `${(frame.part * 100).toFixed(1)}%` }} />
        </div>
        <div className={s.preview}>
          <iframe className={s.frame} src={previewSrc} title="Кадр эфира" />
        </div>
      </div>

      {/* ── что дальше. Без этого хост не знает, что произойдёт, и потому
             смотрит в панель вместо матча. */}
      <div className={s.block}>
        <div className={s.label}>
          Дальше
          <span className={plan.automatic ? s.auto : s.manual}>
            {plan.automatic ? 'само' : 'по кнопке'}
          </span>
        </div>
        <div className={s.what}>{plan.label}</div>
        <div className={s.note}>{plan.note}</div>

        <div className={s.row}>
          <Button
            size="sm"
            {...(plan.automatic ? {} : ({ variant: 'primary' } as const))}
            onClick={() => void air.next()}
          >
            {plan.automatic ? 'Дальше ▸' : 'Выпустить ▸'}
          </Button>
          <Button
            size="sm"
            {...(frozen ? ({ variant: 'primary' } as const) : {})}
            onClick={() => air.freeze(!frozen)}
          >
            {frozen ? 'Отпустить' : 'Замереть'}
          </Button>
        </div>
      </div>

      {/* ── пауза: единственное место, где есть настоящий выбор */}
      {inPause ? (
        <div className={s.block}>
          <div className={s.label}>
            Пауза
            <span className={s.quiet}>
              {playlist === null ? 'соберётся к паузе' : playlistSummary(playlist)}
            </span>
          </div>

          <div className={s.chips}>
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

          <div className={s.countdown}>
            <Field
              label="Следующий матч через, минуты"
              type="number"
              min={1}
              max={60}
              value={minutes}
              onChange={(e) => setMinutes(Math.max(1, Number(e.target.value)))}
            />
            <Button size="sm" onClick={() => air.setCountdown(minutes)}>
              Отсчёт
            </Button>
            {air.countdownUntil !== null ? (
              <Button size="sm" onClick={() => air.setCountdown(null)}>
                Снять
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* ── своя надпись: единственное, чего состояние турнира знать не может */}
      <div className={s.block}>
        <div className={s.label}>Своя надпись</div>
        <div className={s.say}>
          <input
            className={s.sayInput}
            value={text}
            placeholder="перерыв 10 минут"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && text.trim() !== '') void air.say(text.trim());
            }}
          />
          <Button size="sm" disabled={text.trim() === ''} onClick={() => void air.say(text.trim())}>
            В эфир
          </Button>
        </div>
      </div>

      <footer className={s.foot}>
        <span className={s.keys}>Пробел — дальше · P — замереть</span>
        <Button
          size="sm"
          variant="danger"
          onClick={() => {
            if (window.confirm('Остановить эфир? Зрители увидят «эфир окончен».')) {
              void air.stop();
            }
          }}
        >
          Остановить
        </Button>
      </footer>
    </aside>
  );
}
