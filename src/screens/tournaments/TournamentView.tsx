import { useCallback, useEffect, useState } from 'react';
import { Button, Empty } from '@/components';
import { plural } from '@/lib/format';
import type {
  Bracket,
  EditorState,
  Player,
  Pool,
  PrizeView,
  Series,
  TournamentPlayer,
} from '@/lib/types';
import * as ipc from '@/lib/ipc';
import { copyImage, renderBracketImage } from '@/lib/exportImage';
import { useAir } from '@/lib/air/store';
import { Panel } from '@/screens/air/Panel';
import { Setup } from '@/screens/air/Setup';
import { BracketView } from './BracketView';
import { MatchView } from './MatchView';
import { Editor } from './editor/Editor';
import { MatchEdit } from './editor/MatchEdit';
import s from './TournamentView.module.css';

interface Props {
  id: number;
  onClose: () => void;
}

/** Где открыто меню правки матча. */
interface Pick {
  matchId: number;
  x: number;
  y: number;
}

/** Стадия турнира словом: по кнопкам в шапке её угадывать не надо. */
const STATUS: Record<Bracket['status'], string> = {
  draft: 'черновик',
  seeded: 'сетка готова',
  running: 'идёт',
  stopped: 'остановлен',
  finished: 'сыгран',
};

/**
 * Экран турнира. Сетка и режим настройки живут рядом: правка видна на сетке
 * сразу, а не в отдельном предпросмотре. У черновика настройка открыта сама —
 * без состава и маппулов на экране всё равно нечего показывать.
 */
export function TournamentView({ id, onClose }: Props) {
  const [bracket, setBracket] = useState<Bracket | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [series, setSeries] = useState<Series[]>([]);
  const [prize, setPrize] = useState<PrizeView | null>(null);
  const [match, setMatch] = useState<number | null>(null);
  /** Открыта подготовка эфира: стиль, наполнение паузы, адрес для OBS. */
  const [airSetup, setAirSetup] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Эфир идёт по этому турниру.
   *
   * Именно по этому: эфир один на приложение, и панель чужого турнира не должна
   * предлагать управлять кадрами, которые ему не принадлежат.
   */
  const airLive = useAir(
    (st) => st.status?.live === true && st.status.tournamentId === id,
  );

  const [editing, setEditing] = useState(false);
  const [emergency, setEmergency] = useState(false);
  const [pick, setPick] = useState<Pick | null>(null);

  /**
   * Аварийная правка при живом эфире. Показывать зрителям, как пересобирается
   * сетка, незачем: эфир уходит в заставку, а после «Готово» возвращается
   * сеткой — уже с новым состоянием.
   */
  const emergencyEdit = useCallback((value: boolean) => {
    setEmergency(value);
    void useAir.getState().setEditing(value);
  }, []);

  const reload = useCallback(async () => {
    // Сетку читаем и показываем отдельно от остального: если запнётся
    // что-то второстепенное — маппулы, серии, — экран не должен остаться
    // с прошлым состоянием турнира.
    try {
      setBracket(await ipc.tournamentBracket(id));
      setError(null);
    } catch (e) {
      setError(String(e));
      return;
    }

    try {
      const [ed, ps, pl, sr, pr] = await Promise.all([
        ipc.tournamentEditor(id),
        ipc.listPlayers(false),
        ipc.listPools(),
        ipc.listSeries(),
        ipc.prizeState(id),
      ]);
      setEditor(ed);
      setPlayers(ps);
      setPools(pl);
      setSeries(sr);
      setPrize(pr);
      // Аварийная правка держится только пока турнир идёт.
      // Аварийная правка держится только пока турнир идёт. Зовём напрямую,
      // а не через обёртку: чтение турнира не должно зависеть от неё.
      if (!ed.emergencyAvailable) {
        setEmergency(false);
        void useAir.getState().setEditing(false);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Эфир привязан к турниру, внутри которого открыт: своего выбора турнира у
  // него больше нет, и знать про него он должен с первого открытия экрана.
  useEffect(() => {
    void useAir.getState().load(id);
  }, [id]);

  // Черновик — это ещё не турнир, а сборка: настройку открываем сразу.
  // Отдельно от чтения: иначе она открывалась бы заново после каждой правки.
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (bracket === null || seen) return;
    setSeen(true);
    if (bracket.status === 'draft') setEditing(true);
  }, [bracket, seen]);

  /** Правка: применяем и перечитываем турнир целиком. */
  const run = useCallback(
    (work: () => Promise<unknown>) => {
      void (async () => {
        try {
          await work();
          setError(null);
        } catch (e) {
          setError(String(e));
        }
        await reload();
      })();
    },
    [reload],
  );

  // Esc выходит из режима настройки, Ctrl+Z отменяет последнюю правку.
  useEffect(() => {
    if (!editing || match !== null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && pick === null) {
        setEditing(false);
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'z') {
        const el = document.activeElement;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        run(() => ipc.undoTournamentEdit(id));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, match, pick, id, run]);

  if (match !== null) {
    return (
      <MatchView
        id={match}
        onClose={() => {
          setMatch(null);
          void reload();
        }}
      />
    );
  }

  // Подготовка эфира — подэкран турнира, а не раздел приложения: без турнира
  // эфира не бывает, и выбирать его там было нечем.
  if (airSetup) {
    return (
      <div className={s.screen}>
        <header className={s.bar}>
          <button className={s.back} onClick={() => setAirSetup(false)} type="button">
            ← {bracket?.name ?? 'Турнир'}
          </button>
          <h1 className={s.h1}>Эфир</h1>
          <span className={s.sub}>что и как показывать зрителям</span>
        </header>
        <div className={s.body}>
          <div className={s.col}>
            <Setup onStarted={() => setAirSetup(false)} />
          </div>
        </div>
      </div>
    );
  }

  if (bracket === null || editor === null) {
    return (
      <div className={s.screen}>
        <header className={s.bar}>
          <button className={s.back} onClick={onClose} type="button">
            ← Турниры
          </button>
        </header>
        <div className={s.body}>
          <Empty title={error ?? 'Читаю турнир…'} />
        </div>
      </div>
    );
  }

  const t = bracket;
  // Сетка построена, но турнир ещё не запущен: её можно рассмотреть,
  // пересобрать с другим сеянием или вернуть состав в черновик.
  const seeded = t.status === 'seeded';
  const done = t.status === 'finished';
  const stopped = t.status === 'stopped';
  const live = t.status === 'running' || done || stopped;
  const champion = t.players.find((p) => p.placement === 1) ?? null;
  const blocking = editor.checks.filter((c) => c.blocking);

  const picked = pick === null ? null : (t.matches.find((m) => m.id === pick.matchId) ?? null);
  const inside = new Set(t.players.map((p) => p.playerId));
  const sides = (m: typeof picked): TournamentPlayer[] =>
    m === null
      ? []
      : t.players.filter((p) => p.playerId === m.playerA || p.playerId === m.playerB);

  /** Сетка картинкой в буфер; без буфера — файлом. */
  function bracketPicture() {
    void (async () => {
      try {
        const blob = await renderBracketImage(t);
        await copyImage(blob, `${t.name} — сетка.png`);
      } catch (e) {
        setError(String(e));
      }
    })();
  }

  /** Сетка целиком — она же предпросмотр правок. */
  const canvas =
    t.matches.length === 0 ? (
      <Empty
        title="Сетки пока нет"
        note={
          t.players.length < 2
            ? 'Добавь хотя бы двух игроков — сетка появится здесь.'
            : `${t.players.length} игроков — двойная сетка, ${editor.projectedMatches} матчей.`
        }
        actions={
          <Button
            variant="primary"
            disabled={blocking.length > 0}
            title={blocking[0]?.text}
            onClick={() => run(() => ipc.startTournament(id))}
          >
            Построить сетку
          </Button>
        }
      />
    ) : (
      <BracketView
        bracket={t}
        prize={prize}
        onOpenMatch={setMatch}
        editing={editing}
        picked={pick?.matchId ?? null}
        onPickMatch={(matchId, at) => setPick({ matchId, x: at.x, y: at.y })}
        canSeat={editing && !live}
        onSeat={(dragged, onto) => {
          setPick(null);
          run(() =>
            inside.has(dragged)
              ? ipc.swapTournamentSeeds(id, dragged, onto, emergency)
              : ipc.placeTournamentPlayer(
                  id,
                  dragged,
                  t.players.find((p) => p.playerId === onto)?.seed ?? 1,
                  emergency,
                ),
          );
        }}
      />
    );

  return (
    <div className={s.screen}>
      <header className={s.bar}>
        <button className={s.back} onClick={onClose} type="button">
          ← Турниры
        </button>
        <h1 className={s.h1}>{t.name}</h1>
        <span className={s.status}>{STATUS[t.status]}</span>
        <span className={s.sub}>
          {done
            ? `${t.players.length} игроков · ${editor.matchesPlayed} матчей сыграно`
            : `${t.players.length} игроков · ${t.poolIds.length} маппулов · до ${t.targetScore.default} побед`}
        </span>

        {editing ? <span className={s.mark}>Настройка</span> : null}
        {emergency ? <span className={s.markDanger}>Аварийная правка</span> : null}

        <div className={s.right}>
          {seeded ? (
            <>
              <Button onClick={() => run(() => ipc.reopenTournament(id))}>
                Вернуть к составу
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  // Запуск — конец подготовки: держать колонку разделов
                  // открытой после него значит показывать сборку идущего
                  // турнира вместо самого турнира.
                  setEditing(false);
                  setPick(null);
                  run(() => ipc.confirmTournament(id));
                }}
              >
                Запустить турнир
              </Button>
            </>
          ) : null}

          {/* Турнир не всегда доигрывается в тот же вечер. Остановка ничего не
              теряет: результаты на месте, продолжить можно когда угодно. */}
          {t.status === 'running' ? (
            <Button
              onClick={() => {
                if (
                  window.confirm(
                    'Остановить турнир? Матчи по нему играть будет нельзя, пока не продолжишь. Результаты останутся.',
                  )
                ) {
                  run(() => ipc.stopTournament(id));
                }
              }}
            >
              Остановить
            </Button>
          ) : null}

          {stopped ? (
            <Button variant="primary" onClick={() => run(() => ipc.resumeTournament(id))}>
              Продолжить турнир
            </Button>
          ) : null}

          {/* Эфир — событие вечера, а не матча: начинают его отсюда. */}
          {t.matches.length > 0 ? (
            <Button size="sm" onClick={bracketPicture} title="Сетка картинкой в буфер">
              Картинкой
            </Button>
          ) : null}

          <Button onClick={() => setAirSetup(true)}>
            {airLive ? 'Эфир идёт' : 'Эфир'}
          </Button>

          <Button
            {...(editing ? ({ variant: 'primary' } as const) : {})}
            onClick={() => setEditing(!editing)}
          >
            {editing ? 'Готово' : 'Настройка'}
          </Button>
        </div>
      </header>

      {error !== null ? <div className={s.error}>{error}</div> : null}

      {seeded ? (
        <div className={s.pending}>
          Сетка построена. Посмотри, всё ли устраивает: пока турнир не запущен, её можно
          пересобрать или поменять состав.
        </div>
      ) : null}

      {stopped ? (
        <div className={s.pending}>
          Турнир остановлен. Результаты на месте, но матчи по нему не идут — нажми «Продолжить
          турнир», когда соберётесь дальше.
        </div>
      ) : null}

      {/* Вне режима настройки предупреждения всё равно видны: узнать о
          нестыковке посреди матча — значит узнать поздно. */}
      {!editing && t.problems.length > 0 ? (
        <button className={s.problems} type="button" onClick={() => setEditing(true)}>
          Правила и маппул не сходятся: {t.problems[0]?.title} — {t.problems[0]?.notes[0]}
          {t.problems.length > 1
            ? ` · и ещё ${t.problems.length - 1} ${plural(t.problems.length - 1, 'раунд', 'раунда', 'раундов')}`
            : ''}
          <span className={s.problemsMore}>Открыть настройку</span>
        </button>
      ) : null}

      {done && champion !== null ? (
        <div className={s.finished}>Турнир завершён · победитель {champion.nickname}</div>
      ) : null}

      <div className={s.body}>
        <div className={airLive ? s.withAir : undefined}>
          {editing ? (
            <div className={s.split}>
              <Editor
                id={id}
                t={t}
                state={editor}
                emergency={emergency}
                onEmergency={emergencyEdit}
                run={run}
                players={players}
                pools={pools}
                series={series}
              />
              <div className={s.pane}>{canvas}</div>
            </div>
          ) : (
            <div className={s.pane}>{canvas}</div>
          )}

          {/* В паузе между матчами хост стоит здесь, и решения эфира — здесь же. */}
          {airLive ? <Panel /> : null}
        </div>
      </div>

      {/* Меню правки матча встаёт там, где по нему щёлкнули. */}
      {picked !== null && pick !== null ? (
        <div className={s.floating} style={{ left: pick.x, top: pick.y }}>
          <MatchEdit
            m={picked}
            players={sides(picked)}
            outside={players.filter((p) => !inside.has(p.id))}
            pools={pools}
            emergency={emergency}
            live={live}
            spectator={prize?.config.addons.spectator != null}
            bestMatchId={prize?.config.bestMatchId ?? null}
            title={roundOf(picked.id, editor, t)}
            onClose={() => setPick(null)}
            run={run}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Название матча: берём подпись его раунда, как на сетке. */
function roundOf(matchId: number, editor: EditorState, t: Bracket): string {
  const m = t.matches.find((x) => x.id === matchId);
  if (m === undefined) return 'матч';
  const round = editor.rounds.find((r) => r.bracket === m.bracket && r.round === m.round);
  const title = round?.title ?? `раунд ${m.round}`;
  return round !== undefined && round.matches > 1
    ? `${title}, матч ${m.slotInBracket + 1}`
    : title;
}
