// Главная — продолжение работы, а не список разделов.
// Карточка незаконченного турнира, крупное «Новый турнир» и последние
// маппулы: то, куда человек сейчас пойдёт, уже на первом экране.

import { useEffect, useState } from 'react';
import { Button } from '@/components';
import { plural, poolAverageStars, slots as slotsWord } from '@/lib/format';
import type { Bracket, BracketSide, Match, Pool, Tournament } from '@/lib/types';
import * as ipc from '@/lib/ipc';
import { useApp } from '@/store/app';
import s from './Home.module.css';

/** Статус маппула словом — те же слова, что в редакторе пула. */
const POOL_STATUS: Record<Pool['status'], string> = {
  draft: 'черновик',
  ready: 'готов',
  archived: 'архив',
};

const RESUME_STATUS: Record<'running' | 'stopped', string> = {
  running: 'идёт',
  stopped: 'остановлен',
};

/** Турнир, к которому можно вернуться. */
type Resumable = Tournament & { status: 'running' | 'stopped' };

function isResumable(t: Tournament): t is Resumable {
  return t.status === 'running' || t.status === 'stopped';
}

/** Куда вернуться: самый свежий идущий, а если идущих нет — свежий остановленный. */
function pickResume(items: Tournament[]): Resumable | null {
  const alive = items.filter(isResumable).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return alive.find((t) => t.status === 'running') ?? alive[0] ?? null;
}

/** Порядок рядов сетки: верхняя раньше нижней, гранд-финал позже всех. */
const SIDE_ORDER: Record<BracketSide, number> = { upper: 0, lower: 1, grand: 2 };

/** Название раунда — как подписано на сетке: последний раунд ряда — финал,
 *  предпоследний — полуфинал, остальные по номеру. */
function roundLabel(side: BracketSide, round: number, matches: Match[]): string {
  if (side === 'grand') return 'Гранд-финал';
  const last = matches
    .filter((m) => m.bracket === side)
    .reduce((top, m) => Math.max(top, m.round), 0);
  const row = side === 'upper' ? 'верхней' : 'нижней';
  const left = last - round;
  if (left === 0) return `Финал ${row}`;
  if (left === 1) return `Полуфинал ${row}`;
  return `Раунд ${round} ${row}`;
}

/** Какой раунд сейчас на сцене. Идущий матч говорит сам за себя; если ничего
 *  не идёт (турнир остановлен), смотрим ближайший играбельный — тот, в
 *  который оба игрока уже пришли. */
function currentRound(matches: Match[]): { label: string; live: boolean } | null {
  const running = matches.filter((m) => m.status === 'running');
  const base =
    running.length > 0
      ? running
      : matches.filter((m) => m.status === 'pending' && m.playerA !== null && m.playerB !== null);
  const pick = [...base].sort(
    (a, b) => SIDE_ORDER[a.bracket] - SIDE_ORDER[b.bracket] || a.round - b.round,
  )[0];
  if (pick === undefined) return null;
  return { label: roundLabel(pick.bracket, pick.round, matches), live: running.length > 0 };
}

export default function Home() {
  const go = useApp((st) => st.go);
  const openTournament = useApp((st) => st.setOpenTournament);

  const [tournaments, setTournaments] = useState<Tournament[] | null>(null);
  const [pools, setPools] = useState<Pool[] | null>(null);
  const [bracket, setBracket] = useState<Bracket | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [ts, ps] = await Promise.all([ipc.listTournaments(), ipc.listPools()]);
        if (cancelled) return;
        setTournaments(ts);
        setPools(ps);
        setError(null);

        // Сетка нужна только карточке «Продолжить»: без неё нечем посчитать
        // сыгранные матчи и текущий раунд. Читаем после списка — экран уже
        // может показать название и статус.
        const resume = pickResume(ts);
        if (resume !== null) {
          const b = await ipc.tournamentBracket(resume.id);
          if (!cancelled) setBracket(b);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Дата приводится на каждый вход: экран пересоздаётся при смене раздела,
  // и за это время сутки успевают смениться.
  const today = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(
    new Date(),
  );

  const resume = tournaments !== null ? pickResume(tournaments) : null;
  const fresh =
    pools === null
      ? []
      : [...pools]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
          .slice(0, 3);

  const played = bracket?.matches.filter((m) => m.status === 'finished').length ?? 0;
  const total = bracket?.matches.length ?? 0;
  const round = bracket !== null ? currentRound(bracket.matches) : null;

  /** Открыть конкретный турнир на экране турниров — именно его, а не список. */
  function openById(id: number) {
    openTournament(id);
    go('tournaments');
  }

  // Тот же ход, что кнопка в разделе турниров: спросить имя и создать с
  // обычными правилами — остальное поправимо на экране самого турнира.
  async function create() {
    const name = window.prompt('Название турнира', 'Новый кубок');
    if (name === null || name.trim() === '') return;
    try {
      const made = await ipc.createTournament(name.trim(), 4, 1);
      openById(made.id);
    } catch (e) {
      setError(String(e));
    }
  }

  // Совсем пусто — не пустой экран: одна кнопка, которая двигает вперёд.
  const blank =
    tournaments !== null && pools !== null && tournaments.length === 0 && pools.length === 0;

  const poolCard = (p: Pool) => {
    const avg = poolAverageStars(p);
    const parts: string[] = [];
    if (avg !== null) parts.push(`${avg.toFixed(2)}★`);
    if (p.slots.length > 0) parts.push(slotsWord(p.slots.length));
    return (
      <div
        key={p.id}
        className={[s.poolCard, p.status === 'archived' ? s.archived : null]
          .filter(Boolean)
          .join(' ')}
        onClick={() => go('pools')}
        title="Открыть маппулы"
      >
        <div className={s.poolTop}>
          <span className={s.poolName}>{p.name}</span>
          <span className={p.status === 'ready' ? s.chipGreen : s.chip}>
            {POOL_STATUS[p.status]}
          </span>
        </div>
        <div className={s.poolShape}>{parts.length > 0 ? parts.join(' · ') : 'слотов нет'}</div>
      </div>
    );
  };

  return (
    <div className={s.screen}>
      <div className={s.body}>
        <div className={s.col}>
          <header className={s.hello}>
            <span className={s.brand}>
              <i className={s.mark} aria-hidden />
              osu!cup
            </span>
            <span className={s.date}>{today}</span>
          </header>

          {error !== null ? <div className={s.error}>{error}</div> : null}

          {blank ? (
            <div className={s.blank}>
              <h1 className={s.blankTitle}>Первый турнир за две минуты</h1>
              <p className={s.blankNote}>
                Онбординг пройден, ключ osu! на месте. Дальше просто: скатай маппул по шаблону,
                добавь игроков — сетка построится сама.
              </p>
              <button className={s.big} onClick={() => void create()} type="button">
                + Новый турнир
              </button>
            </div>
          ) : (
            <>
              {resume !== null ? (
                <section
                  className={s.resume}
                  onClick={() => openById(resume.id)}
                  title="Открыть турнир"
                >
                  <div className={s.resumeMain}>
                    <div className={s.resumeTop}>
                      <span className={s.kicker}>Продолжить турнир</span>
                      <span className={resume.status === 'running' ? s.chipGreen : s.chip}>
                        {RESUME_STATUS[resume.status]}
                      </span>
                    </div>
                    <h1 className={s.resumeName}>{resume.name}</h1>

                    {total > 0 ? (
                      <>
                        <div className={s.bar}>
                          <div
                            className={s.barFill}
                            style={{ width: `${Math.round((played / total) * 100)}%` }}
                          />
                        </div>
                        <div className={s.resumeFacts}>
                          <span>
                            сыграно {played} из {total}{' '}
                            {plural(total, 'матч', 'матча', 'матчей')}
                          </span>
                          {round !== null ? (
                            <span>
                              {/* Остановленный турнир ничего не играет, даже если
                                  матч в нём остался в статусе «идёт». */}
                              {round.live && resume.status === 'running' ? 'сейчас' : 'дальже'}:{' '}
                              {round.label}
                            </span>
                          ) : null}
                        </div>
                      </>
                    ) : null}
                  </div>

                  <Button className={s.resumeBtn} onClick={() => openById(resume.id)}>
                    Продолжить <span className={s.arrow}>→</span>
                  </Button>
                </section>
              ) : null}

              <button className={s.big} onClick={() => void create()} type="button">
                + Новый турнир
              </button>

              {fresh.length > 0 ? (
                <section>
                  <div className={s.head}>Последние маппулы</div>
                  <div className={s.poolGrid}>{fresh.map(poolCard)}</div>
                </section>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
