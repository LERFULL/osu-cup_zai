// Сцены матча — то, что идёт по ходу игры.
//
// Врезки (`banReveal`, `pickReveal`, `mapResult`) не заменяют «Ход матча», а
// накрывают её с затемнением: в состоянии два слоя, и под врезкой остаётся
// живой счёт. Поэтому здесь они и нарисованы как накладка, а не как кадр.

import { useEffect, useState } from 'react';
import type {
  BanRevealPayload,
  MapProgressPayload,
  MapResultPayload,
  MatchIntroPayload,
  MatchLivePayload,
  MatchResultPayload,
  PickRevealPayload,
} from '@/lib/air/types';
import { big, coverOf, Face, Frame, Head, Hex, MapLine, Roll, stars, time } from './parts';
import s from './match.module.css';

/** Секунды, прошедшие с момента. Тикает раз в 200 мс — этого хватает полосе. */
function useElapsed(since: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, []);
  const from = Date.parse(since);
  if (!Number.isFinite(from)) return 0;
  return Math.max(0, (now - from) / 1000);
}

// ─────────────────────────────────────────────────────── представление

export function MatchIntro({ p }: { p: MatchIntroPayload }) {
  return (
    <div className={s.versus}>
      <div className={s.versusRound}>{p.round}</div>

      <div className={s.versusGrid}>
        <div className={s.versusSide}>
          <Face player={p.a} size={260} />
          <div className={s.versusNick} style={{ color: p.a.color }}>
            {p.a.nick}
          </div>
          {p.a.seed !== null ? <div className={s.versusSeed}>сеяние #{p.a.seed}</div> : null}
        </div>

        <div className={s.versusMiddle}>
          <div className={s.versusScore}>
            <span style={{ color: p.a.color }}>{p.versusA}</span>
            <i>:</i>
            <span style={{ color: p.b.color }}>{p.versusB}</span>
          </div>
          <div className={s.versusLabel}>личный счёт</div>
          <div className={s.versusTarget}>до {p.target} побед</div>
        </div>

        <div className={s.versusSide}>
          <Face player={p.b} size={260} />
          <div className={s.versusNick} style={{ color: p.b.color }}>
            {p.b.nick}
          </div>
          {p.b.seed !== null ? <div className={s.versusSeed}>сеяние #{p.b.seed}</div> : null}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────── жеребьёвка

// ────────────────────────────────────────────────────────── ход матча

export function MatchLive({ p }: { p: MatchLivePayload }) {
  // Строки идут группами по мод-тегам — так маппул читается, а не сливается
  // в один длинный список.
  const groups: { mod: string; rows: MatchLivePayload['rows'] }[] = [];
  for (const row of p.rows) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.mod === row.mod) last.rows.push(row);
    else groups.push({ mod: row.mod, rows: [row] });
  }

  // Номер строки во всём маппуле, а не в группе: задержка появления должна
  // идти сверху вниз по кадру, а не начинаться заново в каждой группе.
  let line = 0;

  return (
    <div className={s.live}>
      <div className={s.liveTop}>
        <Head
          player={p.a}
          size={82}
          glow={p.turn.actor === p.a.id}
          note={p.matchPoint.includes(p.a.id) ? <span className={s.mp}>матчпоинт</span> : p.round}
        />
        <div className={s.liveScore}>
          <Roll value={p.scoreA} className={p.scoreA > p.scoreB ? s.liveLead : undefined} />
          <i>:</i>
          <Roll value={p.scoreB} className={p.scoreB > p.scoreA ? s.liveLead : undefined} />
          <div className={s.liveTarget}>
            до {p.target}
            {p.bonus > 0 ? ` · преимущество +${p.bonus}` : ''}
          </div>
        </div>
        <Head
          player={p.b}
          size={82}
          right
          glow={p.turn.actor === p.b.id}
          note={p.matchPoint.includes(p.b.id) ? <span className={s.mp}>матчпоинт</span> : p.round}
        />
      </div>

      {/* Ключ по тексту: строка «чей ход» меняется патчем, без смены кадра, и
          без пересоздания её появление не проигралось бы заново. */}
      <div key={p.turn.text} className={s.liveTurn}>
        {p.turn.text}
      </div>

      <div className={s.livePool}>
        {groups.map((group) => (
          <div key={group.mod} className={s.liveGroup}>
            {group.rows.map((row) => {
              const who =
                row.state === 'played'
                  ? row.winner
                  : row.state === 'banned' || row.state === 'playing'
                    ? row.by
                    : null;
              const color =
                who === null ? null : who === p.a.id ? p.a.color : who === p.b.id ? p.b.color : null;
              line += 1;

              return (
                <MapLine
                  key={row.slot}
                  map={row}
                  compact
                  index={line - 1}
                  className={s.liveLine}
                  dim={row.state === 'banned' || row.state === 'locked'}
                  glow={row.state === 'playing'}
                  stripe={color}
                  end={<RowEnd row={row} a={p.a} b={p.b} />}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function RowEnd({
  row,
  a,
  b,
}: {
  row: MatchLivePayload['rows'][number];
  a: MatchLivePayload['a'];
  b: MatchLivePayload['b'];
}) {
  const nick = (id: number | null) => (id === a.id ? a.nick : id === b.id ? b.nick : '—');
  const color = (id: number | null) => (id === a.id ? a.color : id === b.id ? b.color : 'var(--txt3)');

  switch (row.state) {
    case 'banned':
      return <span className={s.endBan}>✕ бан {row.n}</span>;
    case 'playing':
      return (
        <span className={s.endLive}>
          <i aria-hidden />
          идёт
        </span>
      );
    case 'played':
      return (
        <span className={s.endWon} style={{ color: color(row.winner) }}>
          <span aria-hidden>♛</span> {nick(row.winner)}
        </span>
      );
    case 'locked':
      return <span className={s.endLock}>откроется при равном счёте</span>;
    case 'free':
      return (
        <span className={s.endFree}>
          <span className={s.endStars}>{stars(row.stars)}★</span>
          {row.length !== null ? <span>{time(row.length)}</span> : null}
        </span>
      );
  }
}

// ────────────────────────────────────────────────────────────── врезки

/** Общая рамка врезки: затемнение поверх кадра и карточка по центру. */
function Overlay({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={s.overlay}>
      <div className={[s.card, wide === true ? s.cardWide : null].filter(Boolean).join(' ')}>
        {children}
      </div>
    </div>
  );
}

export function BanReveal({ p }: { p: BanRevealPayload }) {
  return (
    <Overlay>
      <div className={s.banHead}>
        <span className={s.banMark} aria-hidden>
          ✕
        </span>
        <div>
          <div className={s.banWhat}>бан {p.n}</div>
          {p.by !== null ? (
            <div className={s.banWho} style={{ color: p.by.color }}>
              {p.by.nick}
            </div>
          ) : null}
        </div>
      </div>
      <MapLine map={p.map} dim className={s.banLine} />
    </Overlay>
  );
}

export function PickReveal({ p }: { p: PickRevealPayload }) {
  const cover = coverOf(p.map.beatmapsetId);

  return (
    <Overlay wide>
      <div className={s.pick}>
        {cover !== null ? (
          <div className={s.pickCover} style={{ backgroundImage: `url("${cover}")` }} aria-hidden />
        ) : null}
        <div className={s.pickShade} aria-hidden />

        <div className={s.pickText}>
          <div className={s.pickWho}>
            {p.by === null ? 'пик' : (
              <>
                пик <span style={{ color: p.by.color }}>{p.by.nick}</span>
              </>
            )}
          </div>
          <div className={s.pickTitle}>{p.map.title}</div>
          <div className={s.pickVersion}>
            {p.map.version}
            {p.map.mapper !== null ? ` · ${p.map.mapper}` : ''}
          </div>

          <div className={s.pickNums}>
            <span className={s.pickStars}>{stars(p.map.stars)}★</span>
            <span>{time(p.map.length)}</span>
            {p.map.bpm !== null ? <span>{Math.round(p.map.bpm)} BPM</span> : null}
          </div>
        </div>

        <Hex mod={p.map.mod} label={p.map.slot} />
      </div>
    </Overlay>
  );
}

export function MapResult({ p }: { p: MapResultPayload }) {
  return (
    <Overlay wide>
      <div className={s.resultHead}>
        {p.winner !== null ? (
          <>
            <span className={s.crown} aria-hidden>
              ♛
            </span>
            <span className={s.resultWho} style={{ color: p.winner.color }}>
              {p.winner.nick}
            </span>
            <span className={s.resultTook}>берёт {p.map.slot}</span>
          </>
        ) : (
          <span className={s.resultTook}>{p.map.slot} разыгран</span>
        )}
        <span className={s.resultScore}>
          {p.scoreA} : {p.scoreB}
        </span>
      </div>

      <MapLine map={p.map} className={s.resultLine} />

      {/* Цифры есть только когда подключено лобби: у судьи их нет вовсе. */}
      {p.scores.length > 0 ? (
        <div className={s.scores}>
          {p.scores.map((score, index) => (
            <div
              key={score.playerId}
              className={[s.scoreRow, index === 0 ? s.scoreRowTop : null].filter(Boolean).join(' ')}
              style={{ '--who': score.color, '--i': index } as React.CSSProperties}
            >
              <span className={s.scoreNick}>{score.nick}</span>
              <span className={s.scorePoints}>{big(score.score)}</span>
              <span className={s.scoreDetail}>
                {score.accuracy !== null ? `${score.accuracy.toFixed(2)}%` : '—'}
              </span>
              <span className={s.scoreDetail}>
                {score.combo !== null ? `${score.combo}x` : '—'}
              </span>
              <span className={s.scoreDetail}>
                {score.miss !== null && score.miss > 0 ? `${score.miss} мисс` : 'FC'}
              </span>
              {score.mods.length > 0 ? (
                <span className={s.scoreMods}>{score.mods.join('')}</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className={s.noScores}>счёт по картам {p.scoreA} : {p.scoreB}</div>
      )}
    </Overlay>
  );
}

// ─────────────────────────────────────────────────── матчпоинт и итог

export function MatchResult({ p }: { p: MatchResultPayload }) {
  const loser = p.winner.id === p.a.id ? p.b : p.a;

  return (
    <Frame title="Итог матча" note={p.round}>
      <div className={s.final}>
        <div className={s.finalWinner} style={{ '--who': p.winner.color } as React.CSSProperties}>
          <span className={s.crown} aria-hidden>
            ♛
          </span>
          <Face player={p.winner} size={190} />
          <div className={s.finalNick}>{p.winner.nick}</div>
        </div>

        <div className={s.finalScore}>
          {p.walkover ? (
            <div className={s.finalWalkover}>без игры</div>
          ) : (
            <div className={s.finalNums}>
              {p.scoreA} : {p.scoreB}
            </div>
          )}
        </div>

        <div className={s.finalGoes}>
          {p.winnerGoes !== null ? (
            <div className={s.finalGo}>
              <span style={{ color: p.winner.color }}>{p.winner.nick}</span> → {p.winnerGoes}
            </div>
          ) : null}
          {p.loserGoes !== null ? (
            <div className={s.finalGoDim}>
              <span style={{ color: loser.color }}>{loser.nick}</span> → {p.loserGoes}
            </div>
          ) : null}
        </div>
      </div>
    </Frame>
  );
}

// ──────────────────────────────────────────────────────── карта идёт

/**
 * Идёт карта. Живого счёта здесь нет и быть не может: пока карта не кончилась,
 * API отдаёт пустой массив скоров. Зато честно видно, что играется, сколько
 * прошло и сколько осталось.
 */
export function MapProgress({ p }: { p: MapProgressPayload }) {
  const elapsed = useElapsed(p.startedAt);
  const done = p.length <= 0 ? 0 : Math.min(1, elapsed / p.length);
  const left = Math.max(0, p.length - elapsed);
  const cover = coverOf(p.map.beatmapsetId);

  return (
    <div className={s.progress}>
      {cover !== null ? (
        <div className={s.progressCover} style={{ backgroundImage: `url("${cover}")` }} aria-hidden />
      ) : null}
      <div className={s.progressShade} aria-hidden />

      <div className={s.progressBody}>
        <div className={s.progressTop}>
          <Hex mod={p.map.mod} label={p.map.slot} />
          <div className={s.progressWhat}>
            <div className={s.progressTitle}>{p.map.title}</div>
            <div className={s.progressVersion}>{p.map.version}</div>
          </div>
          <div className={s.progressScore}>
            <span style={{ color: p.a.color }}>{p.scoreA}</span>
            <i>:</i>
            <span style={{ color: p.b.color }}>{p.scoreB}</span>
          </div>
        </div>

        <div className={s.bar}>
          <div className={s.barFill} style={{ width: `${(done * 100).toFixed(2)}%` }} />
        </div>

        <div className={s.progressTimes}>
          <span className={s.progressNow}>{time(elapsed)}</span>
          <span className={s.progressLeft}>осталось {time(left)}</span>
          <span className={s.progressTotal}>{time(p.length)}</span>
        </div>
      </div>
    </div>
  );
}
