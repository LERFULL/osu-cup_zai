// Сцены матча — то, что идёт по ходу игры.
//
// Врезки (`banReveal`, `pickReveal`, `mapResult`) не заменяют «Ход матча», а
// накрывают её с затемнением: в состоянии два слоя, и под врезкой остаётся
// живой счёт. Поэтому здесь они и нарисованы как накладка, а не как кадр.

import { useEffect, useState } from 'react';
import type {
  BanRevealPayload,
  BountyHeadsPayload,
  BountyTakenPayload,
  MapProgressPayload,
  MapResultPayload,
  MatchIntroPayload,
  MatchLivePayload,
  MatchResultPayload,
  PickRevealPayload,
} from '@/lib/air/types';
import { useLayer } from './env';
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

  // Маппул на двенадцать карт в одну колонку не встаёт: строки ужимаются ниже
  // читаемого, а последняя — обычно тайбрейк — уезжает за край кадра. Большой
  // пул идёт двумя колонками, сбалансированными по числу строк: мод-группы
  // не режутся, а делятся между колонками целиком.
  const twoCols = p.rows.length >= 9;
  const columns = twoCols ? splitColumns(groups) : [groups];

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

      {/* Живые деньги матча — только движку «за карты»: это счётчик, который
          растёт с каждой картой. Остальные движки по ходу матча ничего не
          меняют, и полоса висела бы мёртвым грузом. */}
      {p.money !== null && (p.money.perLoss > 0 || p.money.aEarned > 0 || p.money.bEarned > 0) ? (
        <div className={s.liveMoney}>
          <span className={s.liveMoneySide} style={{ color: p.a.color }}>
            <Roll value={`${p.money.aEarned.toLocaleString('ru-RU')} ₽`} />
            {p.money.headA > 0 ? (
              <span className={s.liveMoneyHead}>
                голова {p.money.headA.toLocaleString('ru-RU')} ₽
              </span>
            ) : null}
          </span>
          <span className={s.liveMoneyMid}>
            {[
              p.money.perLoss > 0
                ? `карта — ${p.money.perLoss.toLocaleString('ru-RU')} ₽`
                : null,
              p.money.winPrice > 0
                ? `победа — ${p.money.winPrice.toLocaleString('ru-RU')} ₽`
                : null,
            ]
              .filter((x) => x !== null)
              .join('  ·  ')}
          </span>
          <span className={`${s.liveMoneySide} ${s.liveMoneyRight}`} style={{ color: p.b.color }}>
            {p.money.headB > 0 ? (
              <span className={s.liveMoneyHead}>
                голова {p.money.headB.toLocaleString('ru-RU')} ₽
              </span>
            ) : null}
            <Roll value={`${p.money.bEarned.toLocaleString('ru-RU')} ₽`} />
          </span>
        </div>
      ) : null}

      <div className={[s.livePool, twoCols ? s.livePoolCols : null].filter(Boolean).join(' ')}>
        {columns.map((column, ci) => (
          <div key={ci} className={s.liveColumn}>
            {column.map((group) => (
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
                      dense={twoCols}
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
        ))}
      </div>
    </div>
  );
}

/** Делит группы маппула на две сбалансированные колонки — по числу строк. */
function splitColumns(
  groups: { mod: string; rows: MatchLivePayload['rows'] }[],
): { mod: string; rows: MatchLivePayload['rows'] }[][] {
  const total = groups.reduce((a, g) => a + g.rows.length, 0);
  const left: typeof groups = [];
  const right: typeof groups = [];
  let taken = 0;
  for (const group of groups) {
    // Половина пула ещё не набрана — группа идёт налево. Ровно половина и
    // дальше — направо: правая колонка не должна остаться пустой.
    if (taken < total / 2 || right.length === 0 && left.length === groups.length - 1) {
      left.push(group);
      taken += group.rows.length;
    } else {
      right.push(group);
    }
  }
  return [left, right];
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

/** Длительность слоя в секундах — врезка двигается по ней, а не по своим
 * догадкам: зашедший посреди кадра не должен видеть анимацию с начала. */
function useLayerSeconds(fallback: number): number {
  const { since, until } = useLayer();
  const from = Date.parse(since);
  const to = until === null ? NaN : Date.parse(until);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return fallback;
  return Math.max(1.5, (to - from) / 1000);
}

/**
 * Бан и пик — не «появилась карточка», а движение одной и той же карты:
 * строка маппула уезжает вправо за экран, слева вылетает окно с подробностями,
 * окно уходит вправо — и строка возвращается в маппул слева. Всё на одной
 * оси: карта едет по кадру, а не меняет обличье.
 */
function RevealFlow({
  kind,
  map,
  n,
  fallbackSeconds,
  children,
}: {
  kind: 'ban' | 'pick';
  map: BanRevealPayload['map'];
  n?: number;
  fallbackSeconds: number;
  children: React.ReactNode;
}) {
  const seconds = useLayerSeconds(fallbackSeconds);
  const style = { '--dur': `${seconds}s` } as React.CSSProperties;

  return (
    <div className={s.reveal} style={style}>
      <div className={s.revealDim} aria-hidden />

      {/* Строка маппула на своём месте: уезжает вправо за экран. */}
      <div className={s.revealRow}>
        <MapLine map={map} compact className={s.revealLine} />
      </div>

      {/* Окно с подробностями: влетает слева, стоит, уходит вправо. */}
      <div className={s.revealCardWrap}>
        <div className={[s.revealCard, kind === 'ban' ? s.revealCardBan : null].filter(Boolean).join(' ')}>
          {children}
        </div>
      </div>

      {/* Возврат: та же строка возвращается в маппул — уже с меткой. */}
      <div className={s.revealRow}>
        <MapLine
          map={map}
          compact
          dim={kind === 'ban'}
          glow={kind === 'pick'}
          className={s.revealBack}
          end={
            kind === 'ban' ? (
              <span className={s.endBan}>✕ бан {n ?? 1}</span>
            ) : (
              <span className={s.endLive}>
                <i aria-hidden />
                в игру
              </span>
            )
          }
        />
      </div>
    </div>
  );
}

export function BanReveal({ p }: { p: BanRevealPayload }) {
  const cover = coverOf(p.map.beatmapsetId);

  return (
    <RevealFlow kind="ban" map={p.map} n={p.n} fallbackSeconds={3}>
      <div className={s.revealHead}>
        <span className={s.revealMark} aria-hidden>
          ✕
        </span>
        <div>
          <div className={s.revealWhat}>бан {p.n}</div>
          {p.by !== null ? (
            <div className={s.revealWho} style={{ color: p.by.color }}>
              {p.by.nick}
            </div>
          ) : null}
        </div>
      </div>

      <div className={s.revealBody}>
        {cover !== null ? (
          <div className={s.revealCover} style={{ backgroundImage: `url("${cover}")` }} aria-hidden />
        ) : null}

        <div className={s.revealText}>
          <div className={s.revealTitle}>{p.map.title}</div>
          <div className={s.revealVersion}>
            {p.map.version}
            {p.map.mapper !== null ? ` · ${p.map.mapper}` : ''}
          </div>
          <div className={s.revealNums}>
            <span className={s.pickStars}>{stars(p.map.stars)}★</span>
            <span>{time(p.map.length)}</span>
            {p.map.bpm !== null ? <span>{Math.round(p.map.bpm)} BPM</span> : null}
          </div>
          <div className={s.revealVerdict}>карта выбывает из маппула</div>
        </div>

        <Hex mod={p.map.mod} label={p.map.slot} />
      </div>
    </RevealFlow>
  );
}

export function PickReveal({ p }: { p: PickRevealPayload }) {
  const cover = coverOf(p.map.beatmapsetId);

  return (
    <RevealFlow kind="pick" map={p.map} fallbackSeconds={5}>
      <div className={s.revealHead}>
        <span className={s.revealMarkPick} aria-hidden>
          ▸
        </span>
        <div>
          <div className={s.revealWhatPick}>пик</div>
          {p.by !== null ? (
            <div className={s.revealWho} style={{ color: p.by.color }}>
              {p.by.nick}
            </div>
          ) : null}
        </div>
      </div>

      <div className={s.revealBody}>
        {cover !== null ? (
          <div className={s.revealCover} style={{ backgroundImage: `url("${cover}")` }} aria-hidden />
        ) : null}

        <div className={s.revealText}>
          <div className={s.revealTitle}>{p.map.title}</div>
          <div className={s.revealVersion}>
            {p.map.version}
            {p.map.mapper !== null ? ` · ${p.map.mapper}` : ''}
          </div>
          <div className={s.revealNums}>
            <span className={s.pickStars}>{stars(p.map.stars)}★</span>
            <span>{time(p.map.length)}</span>
            {p.map.bpm !== null ? <span>{Math.round(p.map.bpm)} BPM</span> : null}
          </div>
          <div className={s.revealVerdictPick}>играется следующим</div>
        </div>

        <Hex mod={p.map.mod} label={p.map.slot} />
      </div>
    </RevealFlow>
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

      {/* Живые деньги: счётчик карт, цена победы и головы. */}
      {p.money !== null ? (
        <div className={s.moneyRow}>
          <span className={s.moneySide} style={{ color: p.a.color }}>
            <span className={s.moneyEarned}>{p.money.aEarned.toLocaleString('ru-RU')} ₽</span>
            {p.money.headA > 0 ? (
              <span className={s.moneyHead}>голова {p.money.headA.toLocaleString('ru-RU')} ₽</span>
            ) : null}
          </span>
          <span className={s.moneyPer}>
            {[
              p.money.perLoss > 0
                ? `карта ${p.money.perLoss.toLocaleString('ru-RU')} ₽ · победная ${p.money.perWin.toLocaleString('ru-RU')} ₽`
                : null,
              p.money.winPrice > 0
                ? `победа в матче ${p.money.winPrice.toLocaleString('ru-RU')} ₽`
                : null,
            ]
              .filter((x) => x !== null)
              .join('  ·  ')}
          </span>
          <span className={s.moneySide} style={{ color: p.b.color }}>
            <span className={s.moneyEarned}>{p.money.bEarned.toLocaleString('ru-RU')} ₽</span>
            {p.money.headB > 0 ? (
              <span className={s.moneyHead}>голова {p.money.headB.toLocaleString('ru-RU')} ₽</span>
            ) : null}
          </span>
        </div>
      ) : null}
      {p.underdog !== null ? <div className={s.underdogTag}>{p.underdog}</div> : null}

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
          {p.underdog !== null ? <div className={s.underdogTag}>{p.underdog}</div> : null}
        </div>
      </div>

      {/* Что по деньгам будет после матча: сколько каждый уносит из встречи. */}
      {p.after !== null ? (
        <div className={s.afterMoney}>
          <div className={s.afterTitle}>деньги после матча</div>
          <div className={s.afterRow} style={{ '--who': p.winner.color } as React.CSSProperties}>
            <span className={s.afterNick}>{p.winner.nick}</span>
            <span className={s.afterSum}>+{p.after.winnerTake.toLocaleString('ru-RU')} ₽</span>
            <span className={s.afterParts}>
              {[
                p.after.winPrice > 0 ? `победа ${p.after.winPrice.toLocaleString('ru-RU')} ₽` : null,
                p.after.winnerMaps > 0 ? `карты ${p.after.winnerMaps.toLocaleString('ru-RU')} ₽` : null,
                p.after.headTaken > 0 ? `голова ${p.after.headTaken.toLocaleString('ru-RU')} ₽` : null,
              ]
                .filter((x) => x !== null)
                .join(' · ')}
            </span>
          </div>
          {p.after.loserTake > 0 ? (
            <div className={s.afterRow} style={{ '--who': loser.color } as React.CSSProperties}>
              <span className={s.afterNick}>{loser.nick}</span>
              <span className={s.afterSum}>+{p.after.loserTake.toLocaleString('ru-RU')} ₽</span>
              <span className={s.afterParts}>
                карты {p.after.loserMaps.toLocaleString('ru-RU')} ₽
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
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

        {/* Живой счётчик: число растёт по ходу матча, а не появляется в конце. */}
        {p.money !== null ? (
          <div className={s.progressMoney}>
            <span className={s.progressMoneySide} style={{ color: p.a.color }}>
              {p.money.aEarned.toLocaleString('ru-RU')} ₽
              {p.money.headA > 0 ? (
                <span className={s.progressMoneyHead}>
                  голова {p.money.headA.toLocaleString('ru-RU')} ₽
                </span>
              ) : null}
            </span>
            <span className={s.progressMoneyHint}>
              {[
                p.money.perLoss > 0
                  ? `карта — ${p.money.perLoss.toLocaleString('ru-RU')} ₽`
                  : null,
                p.money.winPrice > 0
                  ? `победа — ${p.money.winPrice.toLocaleString('ru-RU')} ₽`
                  : null,
              ]
                .filter((x) => x !== null)
                .join('  ·  ')}
            </span>
            <span className={s.progressMoneySide} style={{ color: p.b.color }}>
              {p.money.bEarned.toLocaleString('ru-RU')} ₽
              {p.money.headB > 0 ? (
                <span className={s.progressMoneyHead}>
                  голова {p.money.headB.toLocaleString('ru-RU')} ₽
                </span>
              ) : null}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────── деньги на голове

/** Головы перед матчем: что висит на каждом — то, что соперник может снять. */
export function BountyHeads({ p }: { p: BountyHeadsPayload }) {
  return (
    <Frame title="Деньги на голове" note="выбил — забрал сразу">
      <div className={s.headsVs}>
        <div className={s.headsSide} style={{ '--who': p.a.color } as React.CSSProperties}>
          <Head player={p.a} size={140} glow={p.headA > 0} />
          <div className={s.headsSum}>{p.headA > 0 ? `${p.headA.toLocaleString('ru-RU')} ₽` : '—'}</div>
          <div className={s.headsNote}>{p.headA > 0 ? 'снимает соперник' : 'ничего не висит'}</div>
        </div>

        <div className={s.headsMid} aria-hidden>
          VS
        </div>

        <div
          className={[s.headsSide, s.headsSideR].filter(Boolean).join(' ')}
          style={{ '--who': p.b.color } as React.CSSProperties}
        >
          <Head player={p.b} size={140} glow={p.headB > 0} right />
          <div className={s.headsSum}>{p.headB > 0 ? `${p.headB.toLocaleString('ru-RU')} ₽` : '—'}</div>
          <div className={s.headsNote}>{p.headB > 0 ? 'снимает соперник' : 'ничего не висит'}</div>
        </div>
      </div>
    </Frame>
  );
}

/** Баунти снято: кто снял, сколько забрал и сколько переехало на голову. */
export function BountyTaken({ p }: { p: BountyTakenPayload }) {
  return (
    <Frame title="Баунти снято" note="выбил — забрал сразу">
      <div className={s.taken}>
        <div className={s.takenSide} style={{ '--who': p.killer.color } as React.CSSProperties}>
          <Head player={p.killer} size={150} glow />
          <div className={s.takenNick}>{p.killer.nick}</div>
          <div className={s.takenSum}>+{p.taken.toLocaleString('ru-RU')} ₽</div>
        </div>

        <div className={s.takenArrow} aria-hidden>
          →
        </div>

        <div className={s.takenSide} style={{ '--who': p.victim.color } as React.CSSProperties}>
          <Head player={p.victim} size={110} />
          <div className={s.takenNick}>{p.victim.nick}</div>
          <div className={s.takenNote}>с головы сняли</div>
        </div>
      </div>

      {p.moved > 0 ? (
        <div className={s.takenMoved}>
          <span style={{ color: p.killer.color }}>{p.killer.nick}</span> теперь сам с головой в{' '}
          {p.moved.toLocaleString('ru-RU')} ₽ — снять её может следующий
        </div>
      ) : null}
    </Frame>
  );
}
