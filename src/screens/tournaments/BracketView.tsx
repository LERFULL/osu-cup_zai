import { useMemo, useState } from 'react';
import { Avatar } from '@/components';
import { coverUrl, plural } from '@/lib/format';
import type { Bracket, BracketSide, Match, Standing, TournamentPlayer } from '@/lib/types';
import { COL_W, layoutBracket } from '@/lib/bracketLayout';
import s from './BracketView.module.css';

/** Что можно тащить в сетку: игрока из состава или из другого места сетки. */
export const DRAG_PLAYER = 'application/x-osucup-player';

interface Props {
  bracket: Bracket;
  onOpenMatch: (id: number) => void;
  /** Режим настройки: клик по матчу открывает правку, а не сам матч. */
  editing?: boolean;
  onPickMatch?: (id: number, at: { x: number; y: number }) => void;
  /** Матч с открытой правкой — его карточка подсвечена. */
  picked?: number | null;
  /**
   * Можно ли менять места в первом раунде мышью. Дальше первого раунда места
   * заполняются результатами, и перетаскивать там нечего.
   */
  canSeat?: boolean;
  onSeat?: (playerId: number, ontoPlayerId: number) => void;
}

const SIDE_SHORT: Record<BracketSide, string> = {
  upper: 'ВС',
  lower: 'НС',
  grand: 'ГФ',
};

/**
 * Название раунда. Считаем от конца: последний раунд — финал, перед ним
 * полуфинал. Так подпись не врёт на сетке любого размера.
 */
function roundTitle(side: BracketSide, round: number, last: number): string {
  if (side === 'grand') return 'Гранд-финал';
  const left = last - round;
  if (left === 0) return side === 'upper' ? 'Финал верхней' : 'Финал нижней';
  if (left === 1) return 'Полуфинал';
  return `Раунд ${round}`;
}

/** Короткое имя матча для подписей вида «Проигравший ВС R1-2». */
function shortName(m: Match): string {
  return `${SIDE_SHORT[m.bracket]} R${m.round}-${m.slotInBracket + 1}`;
}

/** Место словами: у первых трёх есть имена, дальше просто номер. */
function placeLabel(placement: number): string {
  if (placement === 1) return 'Победитель';
  if (placement === 2) return 'Финалист';
  return `${placement} место`;
}

export function BracketView({
  bracket,
  onOpenMatch,
  editing = false,
  onPickMatch,
  picked = null,
  canSeat = false,
  onSeat,
}: Props) {
  // Куда сейчас метится перетаскивание: подсветка только на допустимом месте.
  const [over, setOver] = useState<number | null>(null);

  const byId = useMemo(() => {
    const map = new Map<number, TournamentPlayer>();
    for (const p of bracket.players) map.set(p.playerId, p);
    return map;
  }, [bracket.players]);

  /** Сеяние: своё, а если не проставлено — порядок в составе. */
  const seedOf = useMemo(() => {
    const map = new Map<number, number>();
    bracket.players.forEach((p, i) => map.set(p.playerId, p.seed ?? i + 1));
    return map;
  }, [bracket.players]);

  /**
   * Откуда придёт игрок в пустое место. Считается по обратным ссылкам:
   * пустая клетка без объяснения — самое непонятное место в сетке. Источники,
   * которые уже доехали, из подписи убираем: «ждёт победителя ВС R3-1», когда
   * тот победитель сидит в этом же матче, читается как ошибка.
   */
  const waitingFor = useMemo(() => {
    const map = new Map<number, string[]>();
    const add = (target: number | null, label: string, arrived: boolean) => {
      if (target === null || arrived) return;
      map.set(target, [...(map.get(target) ?? []), label]);
    };
    for (const m of bracket.matches) {
      const played = m.status === 'finished';
      add(m.nextWinSlot, `Победитель ${shortName(m)}`, played);
      // Проигравшего у матча без победителя нет вовсе: техпобеда над пустотой.
      add(m.nextLoseSlot, `Проигравший ${shortName(m)}`, played);
    }
    return map;
  }, [bracket.matches]);

  // Раскладка — чистая функция в bracketLayout.ts: расположение матчей проще
  // всего сломать незаметно, поэтому его держат тесты, а не глаз.
  const layout = useMemo(() => layoutBracket(bracket.matches), [bracket.matches]);

  /** Ячейка стороны матча: сеяние, игрок и счёт. */
  function slot(m: Match, side: 'a' | 'b') {
    const id = side === 'a' ? m.playerA : m.playerB;
    const player = id === null ? null : (byId.get(id) ?? null);
    // Преимущество сетки — часть счёта матча, но не сыгранная карта.
    const score = (side === 'a' ? m.scoreA : m.scoreB) + (side === 'a' ? m.bonusA : m.bonusB);
    const other = (side === 'a' ? m.scoreB : m.scoreA) + (side === 'a' ? m.bonusB : m.bonusA);
    const won = m.winnerId !== null && id !== null && m.winnerId === id;
    const lost = m.winnerId !== null && id !== null && !won;

    // Подпись берём по порядку: первое пустое место — первый источник.
    const pending = waitingFor.get(m.id) ?? [];
    const hint = side === 'a' ? pending[0] : pending[m.playerA === null ? 1 : 0];
    // Места первого раунда верхней сетки можно менять мышью: остальные
    // заполняются результатами, и тащить туда некого.
    const seatable = canSeat && m.bracket === 'upper' && m.round === 1 && id !== null;

    return (
      <div
        className={[
          s.slot,
          won ? s.won : null,
          lost ? s.lost : null,
          seatable ? s.seatable : null,
          seatable && over === id ? s.seatOver : null,
        ]
          .filter(Boolean)
          .join(' ')}
        draggable={seatable}
        onDragStart={(e) => {
          if (!seatable || id === null) return;
          e.dataTransfer.setData(DRAG_PLAYER, String(id));
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (!seatable) return;
          // Перетаскивание принимаем, только если тащат игрока.
          if (!e.dataTransfer.types.includes(DRAG_PLAYER)) return;
          e.preventDefault();
          setOver(id);
        }}
        onDragLeave={() => {
          if (over === id) setOver(null);
        }}
        onDrop={(e) => {
          setOver(null);
          if (!seatable || id === null) return;
          const raw = e.dataTransfer.getData(DRAG_PLAYER);
          const dragged = Number(raw);
          if (!Number.isFinite(dragged) || dragged === id) return;
          e.preventDefault();
          e.stopPropagation();
          onSeat?.(dragged, id);
        }}
      >
        {player === null ? (
          <>
            <span className={s.seedEmpty} aria-hidden>
              ?
            </span>
            <span className={s.tbd}>{hint ?? 'ждёт соперника'}</span>
          </>
        ) : (
          <>
            <span className={s.seed}>#{seedOf.get(player.playerId) ?? '—'}</span>
            <span className={s.stripe} style={{ background: player.color }} aria-hidden />
            <span className={s.nick}>{player.nickname}</span>
            <span className={score > other ? s.scoreLead : s.score}>{score}</span>
          </>
        )}
      </div>
    );
  }

  const champion = bracket.players.find((p) => p.placement === 1) ?? null;
  const podium = bracket.standings.filter((x) => x.placement <= 3);

  return (
    <div className={s.wrap}>
      {bracket.status === 'finished' ? (
        <Results standings={bracket.standings} podium={podium} />
      ) : champion !== null ? (
        <div className={s.champion}>
          <span className={s.crown} aria-hidden>
            ♛
          </span>
          <Avatar
            nickname={champion.nickname}
            color={champion.color}
            src={coverUrl(champion.avatarPath)}
            size={34}
          />
          {champion.nickname} — победитель
        </div>
      ) : null}

      <div className={s.scroll}>
        <div className={s.canvas} style={{ width: layout.width, height: layout.height }}>
          {layout.heads.map((h) => (
            <div key={h.key} className={s.roundTitle} style={{ left: h.x, top: h.y, width: COL_W }}>
              {roundTitle(h.side, h.round, h.lastRound)}
            </div>
          ))}

          <svg className={s.links} width={layout.width} height={layout.height} aria-hidden>
            {layout.links.map((l) => {
              // Цветом идёт только сыгранная связь: путь игрока по сетке
              // должен читаться, а несыгранная ветка — это ещё не путь.
              const color = l.playerId === null ? null : (byId.get(l.playerId)?.color ?? null);
              return (
                <path
                  key={l.key}
                  d={l.d}
                  className={[s.link, l.drop ? s.linkDrop : null].filter(Boolean).join(' ')}
                  {...(color !== null ? { style: { stroke: color, opacity: 0.85 } } : {})}
                />
              );
            })}
          </svg>

          {layout.shown.map((m) => {
            const ready = m.playerA !== null && m.playerB !== null;
            const done = m.status === 'finished';
            const advantage = m.bonusA + m.bonusB;
            // В режиме настройки открывается правка матча, а не сам матч:
            // клик по сетке во время настройки — это правка.
            const clickable = editing || ready;

            return (
              <button
                key={m.id}
                className={[
                  s.match,
                  done ? s.done : null,
                  ready && !done ? s.ready : null,
                  picked === m.id ? s.picked : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
                type="button"
                disabled={!clickable}
                onClick={(e) => {
                  if (editing) {
                    onPickMatch?.(m.id, { x: e.clientX, y: e.clientY });
                    return;
                  }
                  onOpenMatch(m.id);
                }}
                style={{
                  left: layout.colX(layout.columnOf(m)),
                  top: layout.topOf(m),
                  width: COL_W,
                }}
                title={
                  editing
                    ? `${shortName(m)} — правка матча`
                    : ready
                      ? shortName(m)
                      : 'Ждёт результатов прошлых матчей'
                }
              >
                {slot(m, 'a')}
                {slot(m, 'b')}
                <span className={s.tags}>
                  {advantage > 0 ? (
                    <span className={s.tag}>преимущество +{advantage}</span>
                  ) : null}
                  {m.isWalkover ? <span className={s.tag}>без игры</span> : null}
                  {m.isManualEdit ? <span className={s.tag}>вручную</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Итоги турнира: пьедестал и таблица всех участников. */
function Results({ standings, podium }: { standings: Standing[]; podium: Standing[] }) {
  const maps = (p: Standing) => p.mapWins + p.mapLosses;
  const share = (p: Standing) =>
    maps(p) === 0 ? null : Math.round((p.mapWins / maps(p)) * 100);

  return (
    <section className={s.results}>
      <div className={s.resultsTitle}>Турнир сыгран</div>

      <div className={s.podium}>
        {podium.map((p) => (
          <div
            key={p.playerId}
            className={[s.step, p.placement === 1 ? s.stepFirst : null].filter(Boolean).join(' ')}
            style={{ '--who': p.color } as React.CSSProperties}
          >
            <div className={s.place}>{placeLabel(p.placement)}</div>

            <div className={s.podiumHead}>
              <Avatar
                nickname={p.nickname}
                color={p.color}
                src={coverUrl(p.avatarPath)}
                size={p.placement === 1 ? 52 : 42}
              />
              <div className={s.podiumNames}>
                <div className={s.podiumNick}>{p.nickname}</div>
                <div className={s.podiumScore}>
                  {p.matchWins}—{p.matchLosses} по матчам
                  {p.matchLosses === 0 ? ' · без поражений' : ''}
                </div>
              </div>
            </div>

            <div className={s.stats}>
              <div className={s.stat}>
                <span className={s.statName}>карты</span>
                <span className={s.statValue}>
                  {p.mapWins}—{p.mapLosses}
                  {share(p) !== null ? ` · ${share(p)}%` : ''}
                </span>
              </div>
              {p.bestStreak > 1 ? (
                <div className={s.stat}>
                  <span className={s.statName}>серия</span>
                  <span className={s.statValue}>
                    {p.bestStreak} {plural(p.bestStreak, 'карта', 'карты', 'карт')} подряд
                  </span>
                </div>
              ) : null}
              {p.tiebreakers > 0 ? (
                <div className={s.stat}>
                  <span className={s.statName}>тайбрейки</span>
                  <span className={s.statValue}>
                    {p.tiebreakersWon} из {p.tiebreakers}
                  </span>
                </div>
              ) : null}
              {p.walkovers > 0 ? (
                <div className={s.stat}>
                  <span className={s.statName}>без игры</span>
                  <span className={s.statValue}>{p.walkovers}</span>
                </div>
              ) : null}
            </div>

            {p.byMod.length > 0 ? (
              <div className={s.mods}>
                {p.byMod.slice(0, 4).map((mod) => (
                  <span key={mod.mod} className={s.mod} title={`${mod.mod}: сыграно ${mod.played}`}>
                    {mod.mod} {mod.won}/{mod.played}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {standings.length > podium.length ? (
        <div className={s.table}>
          {standings.slice(podium.length).map((p) => (
            <div key={p.playerId} className={s.tableRow}>
              <span className={s.tablePlace}>{p.placement}</span>
              <Avatar
                nickname={p.nickname}
                color={p.color}
                src={coverUrl(p.avatarPath)}
                size={22}
              />
              <span className={s.tableNick}>{p.nickname}</span>
              <span className={s.tableScore}>
                {p.matchWins}—{p.matchLosses} по матчам · {p.mapWins}—{p.mapLosses} по картам
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
