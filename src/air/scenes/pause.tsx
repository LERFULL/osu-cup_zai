// Сцены паузы — то, чем занят экран между матчами.
//
// Именно они отличают эфир от таблицы результатов, и они же главный источник
// затягивания. Поэтому каждая укладывается в отведённые ей секунды, а какие
// сцены вообще выйдут, решает бюджет паузы, а не порядок в этом файле.

import { useEffect, useState } from 'react';
import type {
  AirBracketStop,
  BracketPayload,
  ChampionPayload,
  CountdownPayload,
  CreditsPayload,
  IdlePayload,
  MessagePayload,
  NextUpPayload,
  PlayerCardPayload,
  RecordsPayload,
  StandingsPayload,
} from '@/lib/air/types';
import { useLayer } from './env';
import { big, Face, Frame, Head, Stat } from './parts';
import s from './pause.module.css';

// ─────────────────────────────────────────────────────────────── сетка

/**
 * Сетка целиком — та же, что в приложении: карточки на своих местах и линии
 * связей между ними. Раскладку и пути считает хост той же функцией, что рисует
 * сетку на экране турнира, поэтому расходиться им негде.
 *
 * Камера идёт по сетке остановками. Крупную сетку нельзя просто вписать в кадр:
 * ники станут нечитаемыми, а сетка без читаемых ников — картинка, а не сетка.
 */
export function BracketScene({ p }: { p: BracketPayload }) {
  const stop = useStop(p.stops);
  const box = p.stops[stop] ?? { x: 0, y: 0, w: p.width, h: p.height, cards: [] };

  // Вписываем остановку в окно кадра и ведём камеру к её середине.
  const scale = Math.min(BRACKET_VIEW_W / Math.max(1, box.w), BRACKET_VIEW_H / Math.max(1, box.h), 1);
  const dx = BRACKET_VIEW_W / 2 - (box.x + box.w / 2) * scale;
  const dy = BRACKET_VIEW_H / 2 - (box.y + box.h / 2) * scale;
  const glow = new Set(box.cards);
  const played = p.cards.filter((c) => c.done).length;

  return (
    <Frame title="Сетка" note={`${played} из ${p.cards.length} матчей сыграно`}>
      <div className={s.bracketView}>
        <div
          className={s.bracketCanvas}
          style={{
            width: p.width,
            height: p.height,
            transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${scale.toFixed(3)})`,
          }}
        >
          <svg className={s.bracketLinks} width={p.width} height={p.height} aria-hidden>
            {p.links.map((l) => (
              <path
                key={l.key}
                d={l.d}
                className={[s.bracketLink, l.drop ? s.bracketDrop : null].filter(Boolean).join(' ')}
                {...(l.color !== null ? { style: { stroke: l.color, opacity: 0.9 } } : {})}
              />
            ))}
          </svg>

          {p.heads.map((h) => (
            <div
              key={h.key}
              className={s.bracketHead}
              style={{ left: h.x, top: h.y, width: h.w }}
            >
              {h.title}
            </div>
          ))}

          {p.cards.map((card, index) => (
            <div
              key={card.id}
              className={[
                s.bracketCard,
                card.done ? s.bracketDone : null,
                card.live ? s.bracketLive : null,
                glow.has(card.id) ? s.bracketFocus : null,
              ]
                .filter(Boolean)
                .join(' ')}
              style={
                {
                  left: card.x,
                  top: card.y,
                  width: card.w,
                  height: card.h,
                  '--i': index,
                } as React.CSSProperties
              }
            >
              {[card.a, card.b].map((side, seat) => (
                <div
                  key={seat}
                  className={[s.bracketSide, side?.won === true ? s.bracketWon : null]
                    .filter(Boolean)
                    .join(' ')}
                  style={side !== null ? ({ '--who': side.color } as React.CSSProperties) : undefined}
                >
                  {side === null || side.waiting !== null ? (
                    <span className={s.bracketTbd}>{side?.waiting ?? 'ждёт'}</span>
                  ) : (
                    <>
                      <span className={s.bracketStripe} aria-hidden />
                      <span className={s.bracketNick}>{side.nick}</span>
                      <span className={s.bracketScore}>{side.score}</span>
                    </>
                  )}
                </div>
              ))}
              {card.live ? <span className={s.bracketNow}>идёт</span> : null}
            </div>
          ))}
        </div>
      </div>
    </Frame>
  );
}

/** Часть кадра под сетку. Совпадает с расчётом остановок на стороне хоста. */
const BRACKET_VIEW_W = 1920 - 2 * 72;
const BRACKET_VIEW_H = 1080 - 250;

/**
 * На какой остановке камера. Время между остановками делим ровно: сколько
 * секунд отвела сцена, столько камера и идёт, а сколько их — знает только
 * слой, поэтому берём длину прямо у него.
 */
function useStop(stops: AirBracketStop[]): number {
  const { since, until } = useLayer();
  const [at, setAt] = useState(0);

  useEffect(() => {
    if (stops.length < 2) {
      setAt(0);
      return;
    }
    const start = Date.parse(since);
    const end = until === null ? start + 16_000 : Date.parse(until);
    // Последней остановке даём отстояться: обрывать движение ровно на смене
    // кадра — то же, что не показать её вовсе.
    const span = Math.max(1200, (end - start) / stops.length);

    const tick = () => {
      const passed = Date.now() - start;
      setAt(Math.min(stops.length - 1, Math.floor(passed / span)));
    };
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [stops.length, since, until]);

  return at;
}

// ────────────────────────────────────────────────────────────── маппул

// ───────────────────────────────────────────────────────── кто в игре

export function Standings({ p }: { p: StandingsPayload }) {
  const alive = p.rows.filter((r) => !r.out);
  const out = p.rows.filter((r) => r.out);

  return (
    <Frame title="Кто в игре" note={`${alive.length} ещё играют`}>
      <div className={s.two}>
        <div className={s.list}>
          {alive.map((row, index) => (
            <div
              key={row.nick}
              className={s.person}
              style={{ '--who': row.color, '--i': index } as React.CSSProperties}
            >
              <span className={s.personStripe} aria-hidden />
              <span className={s.personNick}>{row.nick}</span>
              <span className={s.personNote}>
                {row.losses === 0
                  ? 'без поражений'
                  : `${row.losses} ${row.losses === 1 ? 'поражение' : 'поражения'}`}
              </span>
            </div>
          ))}
        </div>

        <div className={s.list}>
          {out.map((row, index) => (
            <div
              key={row.nick}
              className={`${s.person} ${s.personOut}`}
              style={{ '--who': row.color, '--i': index } as React.CSSProperties}
            >
              <span className={s.personStripe} aria-hidden />
              <span className={s.personNick}>{row.nick}</span>
              <span className={s.personNote}>
                {row.place === null ? 'вылетел' : `${row.place} место`}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Frame>
  );
}

// ──────────────────────────────────────────────────────── что дальше

export function NextUp({ p }: { p: NextUpPayload }) {
  return (
    <Frame title="Что дальше">
      {p.next === null ? (
        <div className={s.empty}>Матчей больше нет</div>
      ) : (
        <>
          <div className={s.nextMain}>
            <div className={s.nextRound}>{p.next.round}</div>
            <div className={s.nextPair}>
              {p.next.a === null ? (
                <span className={s.nextTbd}>ждёт соперника</span>
              ) : (
                <Head player={p.next.a} size={120} />
              )}
              <span className={s.nextVs}>против</span>
              {p.next.b === null ? (
                <span className={s.nextTbd}>ждёт соперника</span>
              ) : (
                <Head player={p.next.b} size={120} right />
              )}
            </div>
          </div>

          {p.then.length > 0 ? (
            <div className={s.thenList}>
              {p.then.map((line, index) => (
                <div key={index} className={s.then} style={{ '--i': index } as React.CSSProperties}>
                  <span className={s.thenRound}>{line.round}</span>
                  <span className={s.thenPair}>
                    <span style={line.a !== null ? { color: line.a.color } : undefined}>
                      {line.a?.nick ?? '—'}
                    </span>
                    <i>·</i>
                    <span style={line.b !== null ? { color: line.b.color } : undefined}>
                      {line.b?.nick ?? '—'}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </Frame>
  );
}

// ────────────────────────────────────────────────────────────── отсчёт

/**
 * Отсчёт считает страница по времени, а не по тикам от хоста: так цифры
 * одинаковы у всех зрителей и не зависят от того, когда пришло сообщение.
 */
export function Countdown({ p }: { p: CountdownPayload }) {
  const [left, setLeft] = useState(() => secondsLeft(p.until));

  useEffect(() => {
    setLeft(secondsLeft(p.until));
    const id = window.setInterval(() => setLeft(secondsLeft(p.until)), 250);
    return () => window.clearInterval(id);
  }, [p.until]);

  const minutes = Math.floor(left / 60);
  const seconds = left % 60;

  return (
    <div className={s.countdown}>
      <div className={s.countdownLabel}>{left === 0 ? 'начинаем' : p.label}</div>
      {/* Ключ по секунде: цифры должны тикать, а не тихо подменяться.
          Последние десять секунд идут красным — до начала уже близко. */}
      <div
        key={left}
        className={[s.countdownNums, left <= 10 ? s.countdownSoon : null]
          .filter(Boolean)
          .join(' ')}
      >
        {/* Ноль — это не «0:00», а «вот-вот»: висящий ноль читается как
            сломавшийся таймер, а матч начинается, когда сядут играть. */}
        {left === 0 ? '···' : `${minutes}:${String(seconds).padStart(2, '0')}`}
      </div>
    </div>
  );
}

function secondsLeft(until: string): number {
  const at = Date.parse(until);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.round((at - Date.now()) / 1000));
}

// ─────────────────────────────────────────────────── карточка игрока

export function PlayerCard({ p }: { p: PlayerCardPayload }) {
  const share = p.maps === 0 ? null : Math.round((p.mapWins / p.maps) * 100);

  return (
    <Frame title="Игрок">
      <div className={s.card}>
        <div className={s.cardHead} style={{ '--who': p.player.color } as React.CSSProperties}>
          <Face player={p.player} size={200} />
          <div>
            <div className={s.cardNick}>{p.player.nick}</div>
            {/* Игрок без привязки к профилю показывается только со своей
                статистикой — пустых полей в кадре не остаётся. */}
            {p.osu !== null ? (
              <div className={s.cardRanks}>
                {p.osu.globalRank !== null ? <span>#{big(p.osu.globalRank)} в мире</span> : null}
                {p.osu.countryRank !== null ? <span>#{big(p.osu.countryRank)} в стране</span> : null}
                {p.osu.pp !== null ? <span>{big(p.osu.pp)} pp</span> : null}
              </div>
            ) : (
              <div className={s.cardRanks}>
                <span>профиль osu! не привязан</span>
              </div>
            )}
          </div>
        </div>

        <div className={s.stats}>
          <Stat name="турниров" value={p.tournaments} note={p.tournamentWins > 0 ? `${p.tournamentWins} побед` : null} />
          <Stat name="матчей" value={`${p.matchWins}—${p.matches - p.matchWins}`} />
          <Stat name="карт" value={`${p.mapWins}—${p.maps - p.mapWins}`} note={share === null ? null : `${share}%`} />
          {p.bestMod !== null ? <Stat name="любимый мод" value={p.bestMod} /> : null}
          {p.worstMod !== null ? <Stat name="худший мод" value={p.worstMod} /> : null}
          {p.osu?.accuracy != null ? (
            <Stat name="точность" value={`${p.osu.accuracy.toFixed(2)}%`} />
          ) : null}
        </div>
      </div>
    </Frame>
  );
}

// ─────────────────────────────────────────────────── личная встреча

// ─────────────────────────────────────────────────────── путь по сетке

// ────────────────────────────────────────────────────── рекорды и моды

export function Records({ p }: { p: RecordsPayload }) {
  return (
    <Frame title="Рекорды турнира">
      <div className={s.records}>
        {p.items.map((item, index) => (
          <Stat
            key={item.title}
            name={item.title}
            value={item.value}
            note={item.note}
            index={index}
          />
        ))}
      </div>
    </Frame>
  );
}

// ──────────────────────────────────────────────────── пьедестал и титры

export function Champion({ p }: { p: ChampionPayload }) {
  return (
    <div className={s.podium}>
      {p.podium.map((row) => (
        <div
          key={row.nick}
          className={[s.podiumStep, row.place === 1 ? s.podiumFirst : null]
            .filter(Boolean)
            .join(' ')}
          style={{ '--who': row.color, '--i': 3 - row.place } as React.CSSProperties}
        >
          <div className={s.podiumPlace}>
            {row.place === 1 ? 'Победитель' : row.place === 2 ? 'Финалист' : `${row.place} место`}
          </div>
          <Face
            player={{ id: 0, nick: row.nick, color: row.color, osuUserId: row.osuUserId, seed: null }}
            size={row.place === 1 ? 210 : 150}
          />
          <div className={s.podiumNick}>{row.nick}</div>
          <div className={s.podiumScore}>
            <span>{row.matches} по матчам</span>
            <span>{row.maps} по картам</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Credits({ p }: { p: CreditsPayload }) {
  return (
    <Frame title={p.tournament} note={`турнир длился ${p.duration}`}>
      <div className={s.credits}>
        {p.rows.map((row, index) => (
          <div
            key={row.nick}
            className={s.creditsRow}
            style={{ '--i': index } as React.CSSProperties}
          >
            <span className={s.creditsPlace}>{row.place ?? '—'}</span>
            <span className={s.creditsNick} style={{ color: row.color }}>
              {row.nick}
            </span>
          </div>
        ))}
      </div>
    </Frame>
  );
}

// ──────────────────────────────────────────────── заставка и надпись

export function Idle({ p }: { p: IdlePayload }) {
  return (
    <div className={s.idle}>
      <div className={s.idleGlow} aria-hidden />
      <div className={s.idleName}>{p.tournament}</div>
      <div className={s.idleNote}>{p.note ?? 'скоро начнём'}</div>
    </div>
  );
}

export function Message({ p }: { p: MessagePayload }) {
  return (
    <div className={s.message}>
      <div className={s.messageText}>{p.text}</div>
      {p.note !== null && p.note !== '' ? <div className={s.messageNote}>{p.note}</div> : null}
    </div>
  );
}

