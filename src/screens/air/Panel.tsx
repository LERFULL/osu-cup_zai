// Панель эфира: единственное место, откуда им управляют.
//
// Управление построено вокруг очереди: хост видит, что в эфире, что выйдет
// следующим и что за этим — и может менять порядок, не дожидаясь момента.
// Раньше очередь была невидима, и ведущий узнавал о том, что эфир собирался
// показать, только по самой смене кадра.
//
// Миниатюра — та же страница зрителя в маленьком размере, а не отдельный
// рисунок: два кадра однажды разошлись бы. Ключ пересоздания — старт эфира:
// перезагрузить страницу после рестарта сервера она обязана сама.

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
  const { status, airing, frozen, standby, playlist, playlistAt, error, watching, ctx } = air;
  const frame = useFrame();

  const [minutes, setMinutes] = useState(6);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  /** Развёрнутый выбор сцен: вся сетка заготовок, а не пять частых. */
  const [picker, setPicker] = useState(false);

  if (status?.live !== true) return null;

  const plan = air.plan();
  const previewSrc = inTauri
    ? status.localUrl
    : `${window.location.origin}/air.html?transport=channel`;

  // В паузе у эфира появляются решения: чем занять экран, пока не играют.
  // Во время матча их нет, и показывать пустой блок незачем.
  const inPause = watching === null || watching.status === 'finished';

  // Матч на сейчас: ники, счёт, раунд — то, что хосту нужно знать, не
  // оборачиваясь к экрану матча.
  const matchA = ctx?.bracket.players.find((p) => p.playerId === watching?.playerA) ?? null;
  const matchB = ctx?.bracket.players.find((p) => p.playerId === watching?.playerB) ?? null;

  const copyAddr = () => {
    void navigator.clipboard.writeText(status.localUrl).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <aside className={s.panel}>
      <header className={s.head}>
        <span className={s.live}>
          <i aria-hidden /> Эфир
        </span>
        <span className={s.time}>{leftLabel(frame.left)}</span>
      </header>

      {error !== null ? <div className={s.error}>{error}</div> : null}

      {/* ── показ не начат: адрес и кнопка. Эфир поднят, но ждёт OBS. */}
      {standby ? (
        <div className={s.standby}>
          <div className={s.standbyTitle}>Показ не начат</div>
          <div className={s.standbyAddr}>{status.localUrl}</div>
          <div className={s.standbyRow}>
            <Button size="sm" onClick={copyAddr}>
              {copied ? 'Скопировано ✓' : 'Скопировать адрес'}
            </Button>
            <Button size="sm" variant="primary" onClick={() => air.beginShow()}>
              Начать показ
            </Button>
          </div>
          <div className={s.standbyNote}>
            Кадр стоит на заставке и никуда не уедет — подними OBS и жми «Начать показ»
          </div>
        </div>
      ) : null}

      {/* ── что в кадре */}
      <div className={s.block}>
        <div className={s.label}>Сейчас</div>
        <div className={s.what}>{airing === null ? 'кадра ещё нет' : sceneMeta(airing.id).title}</div>
        <div className={s.bar}>
          <div className={s.barFill} style={{ width: `${(frame.part * 100).toFixed(1)}%` }} />
        </div>
        <div className={s.preview}>
          {/* Ключ — старт эфира: после рестарта сервера страница зрителя
              пересоздаётся, а не висит с оборванным соединением. */}
          <iframe
            key={status.startedAt ?? 'air'}
            className={s.frame}
            src={previewSrc}
            title="Кадр эфира"
          />
        </div>
      </div>

      {/* ── матч на сейчас: кто играет и какой счёт */}
      {matchA !== null && matchB !== null && watching !== null ? (
        <div className={s.block}>
          <div className={s.label}>Матч</div>
          <div className={s.match}>
            <span style={{ color: matchA.color }}>{matchA.nickname}</span>
            <b className={s.matchScore}>
              {watching.scoreA + watching.bonusA} : {watching.scoreB + watching.bonusB}
            </b>
            <span style={{ color: matchB.color }}>{matchB.nickname}</span>
          </div>
        </div>
      ) : null}

      {/* ── очередь кадров: что выйдет и что за ним, с правкой на месте.
             Ведущий видит план эфира целиком — не только ближайший кадр. */}
      {air.proposals.length > 0 ? (
        <div className={s.block}>
          <div className={s.label}>
            Очередь
            <span className={s.quiet}>
              {air.proposals.length} {air.proposals.length === 1 ? 'кадр' : 'кадров'}
            </span>
          </div>
          <div className={s.queue}>
            {air.proposals.map((p, i) => (
              <div key={`${p.id}-${i}`} className={s.queueRow}>
                <span className={s.queueNum}>{i + 1}</span>
                <span className={s.queueLabel} title={p.label}>
                  {p.label}
                </span>
                <span className={s.queueTime}>{p.seconds > 0 ? `${Math.round(p.seconds)} с` : '—'}</span>
                <button
                  className={s.queueBtn}
                  type="button"
                  aria-label="Выше"
                  disabled={i === 0}
                  onClick={() => air.moveProposal(i, i - 1)}
                >
                  ↑
                </button>
                <button
                  className={s.queueBtn}
                  type="button"
                  aria-label="Ниже"
                  disabled={i === air.proposals.length - 1}
                  onClick={() => air.moveProposal(i, i + 1)}
                >
                  ↓
                </button>
                <button
                  className={s.queueBtn}
                  type="button"
                  aria-label="Показать сейчас"
                  title="Показать сейчас"
                  onClick={() => void air.playProposal(i)}
                >
                  ▸
                </button>
                <button
                  className={s.queueBtn}
                  type="button"
                  aria-label="Убрать"
                  title="Убрать из очереди"
                  onClick={() => air.dropProposal(i)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className={s.note}>
            {plan.automatic ? 'кадры выходят сами, по мере отыгрыша' : 'первый ждёт кнопки — придержан или заморожено'}
          </div>
        </div>
      ) : null}

      {/* ── что дальше */}
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

      {/* ── сцены руками: быстрые и полная сетка. Во время матча эфир идёт
             сам, но хост — хозяин: показать «кто при деньгах» посреди матча
             законно, и искать эту кнопку не должно приходиться. */}
      <div className={s.block}>
        <div className={s.label}>
          Сцены
          {inPause && playlist !== null ? (
            <span className={s.quiet}>{playlistSummary(playlist)}</span>
          ) : null}
        </div>

        {/* Плейлист паузы: что эфир покажет до следующего матча */}
        {inPause && playlist !== null && playlist.items.length > 0 ? (
          <div className={s.playlist}>
            {playlist.items.map((item, i) => (
              <div
                key={`${item.id}-${i}`}
                className={[s.playlistRow, i === playlistAt ? s.playlistNow : null]
                  .filter(Boolean)
                  .join(' ')}
              >
                <span className={s.playlistNum}>{i < playlistAt ? '✓' : i + 1}</span>
                <span className={s.playlistTitle}>{sceneMeta(item.id).title}</span>
                <span className={s.playlistSecs}>{Math.round(item.seconds)} с</span>
              </div>
            ))}
          </div>
        ) : null}

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
          <button
            className={[s.chip, s.chipMore].filter(Boolean).join(' ')}
            type="button"
            onClick={() => setPicker((v) => !v)}
          >
            {picker ? '×' : '≡'} Все сцены
          </button>
        </div>

        {/* Выбор всех сцен: сетка заготовок с поводами. Заготовка, под
              которую нет данных, выключена и объясняет, почему. */}
        {picker ? (
          <div className={s.picker}>
            {air.manual().map((c) => (
              <button
                key={`${c.id}-${c.objectKey}`}
                className={[s.pick, c.available ? null : s.pickOff]
                  .filter(Boolean)
                  .join(' ')}
                type="button"
                disabled={!c.available}
                title={c.available ? sceneMeta(c.id).about : (c.reason ?? '')}
                onClick={() => {
                  setPicker(false);
                  if (c.available) void air.pick(c.id, c.objectKey);
                }}
              >
                <span className={s.pickTitle}>{sceneMeta(c.id).title}</span>
                {c.objectName !== null ? <span className={s.pickObj}>{c.objectName}</span> : null}
                {c.available ? null : <span className={s.pickWhy}>{c.reason}</span>}
              </button>
            ))}
          </div>
        ) : null}

        {/* Отсчёт — только в паузе: во время матча он не считает ничего. */}
        {inPause ? (
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
        ) : null}
      </div>

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
        <div className={s.footInfo}>
          <button className={s.addr} type="button" onClick={copyAddr} title="Скопировать адрес эфира">
            {copied ? 'адрес скопирован ✓' : status.localUrl}
          </button>
        </div>
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
