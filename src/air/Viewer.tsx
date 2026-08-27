// Страница зрителя. По ссылке открывается это, и нажать здесь нельзя ничего,
// кроме звука и полного экрана.
//
// Единственное правило: приложение пушит состояние, страница его рисует.
// Отсюда всё остальное — страница не делает запросов, ничего не считает и не
// знает, что существует база, библиотека и другие турниры.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AirLayer,
  AirMap,
  AirMessage,
  AirState,
  AirStyle,
  AirTheme,
  MatchLivePayload,
} from '@/lib/air/types';
import { connect, isObs, type Link } from './transport';
import { EnvProvider, LayerProvider } from './scenes/env';
import { renderScene } from './scenes/registry';
import type { SceneId } from '@/lib/air/types';
import s from './Viewer.module.css';

/** Кадр строится под этот размер и масштабируется целиком. */
const STAGE_W = 1920;
const STAGE_H = 1080;

/** Через сколько без движения мыши курсор уходит. */
const CURSOR_IDLE = 3000;

/**
 * Пробный кадр: страница открыта как `air.html?demo`.
 *
 * Это не эфир, а выставочный стенд: один статический «Ход матча» на
 * подставленных данных. Нужно, чтобы поднять источник в OBS и выставить его
 * размер до того, как кто-то начнёт смотреть. Ни соединения, ни живых данных —
 * кадр не изменится, сколько бы его ни держали открытым.
 */
const DEMO = window.location.search.includes('demo');

/** Подставленные игроки: цвета взяты настоящие — акцент и голубой эфира. */
const DEMO_A = { id: 1, nick: 'NAGISA', color: '#ff6fb1', osuUserId: null, seed: 1 } as const;
const DEMO_B = { id: 2, nick: 'KIRA', color: '#5bc8f5', osuUserId: null, seed: 2 } as const;

/** Подставленная карта: значения округлены до правдоподобных, не до реальных. */
const demoMap = (
  slot: string,
  mod: AirMap['mod'],
  title: string,
  version: string,
  stars: number,
  length: number,
  bpm: number,
): AirMap => ({
  slot,
  mod,
  beatmapsetId: null,
  title,
  version,
  stars,
  length,
  bpm,
  mapper: null,
});

/** Все состояния строки маппула в одном кадре: столько видно только вживую. */
const DEMO_LIVE: MatchLivePayload = {
  a: DEMO_A,
  b: DEMO_B,
  scoreA: 2,
  scoreB: 1,
  bonus: 0,
  target: 4,
  round: 'Финал верхней сетки',
  rows: [
    { ...demoMap('NM1', 'NM', 'Camellia', 'Garakuta Doll', 5.9, 214, 200), state: 'played', by: 1, winner: 1, n: null },
    { ...demoMap('NM2', 'NM', 'UNDEAD CORPORATION', 'Everything will freeze', 6.2, 245, 185), state: 'played', by: 2, winner: 2, n: null },
    { ...demoMap('NM3', 'NM', 'xi', 'Blue Zenith', 6.4, 303, 190), state: 'banned', by: 2, winner: null, n: 1 },
    { ...demoMap('HD1', 'HD', 'Frums', 'Visions', 5.8, 219, 174), state: 'playing', by: 1, winner: null, n: null },
    { ...demoMap('DT1', 'DT', 'Kurosaki Maon', 'Setsuna no Kaze', 6.0, 172, 240), state: 'free', by: null, winner: null, n: null },
    { ...demoMap('TB', 'TB', 'The Quick Brown Fox', 'The Big Black', 7.1, 371, 210), state: 'locked', by: null, winner: null, n: null },
  ],
  turn: { text: 'Ход NAGISA — пик', actor: 1 },
  matchPoint: [1],
  // Пробному кадру деньги не нужны: он выставляет раскладку, а не фонд.
  money: null,
};

/** Состояние пробного кадра: один слой и тема по умолчанию. */
function demoState(): AirState {
  const now = new Date().toISOString();
  return {
    air: { tournament: 'Пробный кадр', startedAt: now },
    layers: [{ id: 'matchLive', since: now, until: null, payload: DEMO_LIVE }],
    theme: { accent: '#ff6fb1', style: 'calm' },
  };
}

/** Эффективный стиль слоя: переопределение сцены или стиль всего эфира. */
function styleOf(theme: AirTheme | null, id: string): AirStyle {
  return (theme?.[`style:${id}`] ?? theme?.style ?? 'calm') as AirStyle;
}

/**
 * Тип траектории камеры — по сцене.
 *
 * Кинематограф — это не «наезд на всё», а разные планы: у «Хода матча» камера
 * скользит вдоль маппула, у представления — облетает соперников, у врезок —
 * резкий короткий наезд, у финалов — медленный подъём. Скорости тоже свои:
 * короткая сцена летит быстрее, длинная — тянется.
 */
function camOf(id: SceneId): 'live' | 'intro' | 'overlay' | 'progress' | 'pause' | 'final' | 'trailer' {
  switch (id) {
    case 'matchLive':
      return 'live';
    case 'matchIntro':
      return 'intro';
    case 'banReveal':
    case 'pickReveal':
    case 'mapResult':
    case 'bountyHeads':
      return 'overlay';
    case 'mapProgress':
      return 'progress';
    case 'matchResult':
    case 'bountyTaken':
    case 'champion':
    case 'credits':
      return 'final';
    case 'trailerTitle':
    case 'trailerPlayers':
    case 'trailerStakes':
      return 'trailer';
    default:
      return 'pause';
  }
}

const CAM_CLASS: Record<ReturnType<typeof camOf>, string | undefined> = {
  live: s.camLive,
  intro: s.camIntro,
  overlay: s.camOverlay,
  progress: s.camProgress,
  pause: s.camPause,
  final: s.camFinal,
  trailer: s.camTrailer,
};

/**
 * Сколько уходящий кадр ещё висит под новым.
 *
 * Без этого смена кадра — рез: старое исчезает в тот же миг, и эфир выглядит
 * листалкой картинок. Должно совпадать с `--move` в `air.css`.
 */
const LEAVE = 420;

export function Viewer() {
  const [state, setState] = useState<AirState | null>(DEMO ? demoState() : null);
  const [link, setLink] = useState<Link>(DEMO ? { kind: 'open' } : { kind: 'lost' });
  // В OBS автозапуск звука разрешён — там кнопки нет вовсе. Пробному кадру
  // слушать нечего: карта не играется, только раскладка.
  const [sound, setSound] = useState(() => isObs() || DEMO);
  /** Страница открыта в рамке — это миниатюра пульта, а не зритель. */
  const framed = window.self !== window.top;

  // ── состояние приходит сообщениями
  const apply = useCallback((m: AirMessage) => {
    setState((prev) => {
      switch (m.kind) {
        case 'snapshot':
          return m.state;
        case 'scene':
          if (prev === null) return prev;
          // Тему прикладывает мок показа в браузере: смена стиля доходит до
          // открытой страницы без перезагрузки. Настоящий сервер тему в этом
          // сообщении не присылает — она и так лежит в каждом снимке.
          return m.theme === undefined
            ? { ...prev, layers: m.layers }
            : { ...prev, layers: m.layers, theme: m.theme };
        case 'patch': {
          if (prev === null) return prev;
          // Патч бьёт по слою, а не по кадру: смены сцены здесь нет, и
          // переход не запускается — зато внутри сцены всё анимируется как обычно.
          const layers = prev.layers.map((l) =>
            l.id === m.layer ? { ...l, payload: m.payload } : l,
          );
          return { ...prev, layers };
        }
        default:
          return prev;
      }
    });
  }, []);

  useEffect(() => {
    // Пробный кадр живёт без соединения: он и не должен никуда ходить.
    if (DEMO) return;
    const transport = connect({ message: apply, link: setLink });
    return () => transport.stop();
  }, [apply]);

  // ── масштаб кадра: переверстки нет, кадр целиком вписывается в окно
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const fit = () =>
      setScale(Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // ── курсора в кадре быть не должно
  useEffect(() => {
    let timer = window.setTimeout(() => document.body.classList.add('idle'), CURSOR_IDLE);
    const wake = () => {
      document.body.classList.remove('idle');
      window.clearTimeout(timer);
      timer = window.setTimeout(() => document.body.classList.add('idle'), CURSOR_IDLE);
    };
    window.addEventListener('mousemove', wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousemove', wake);
      document.body.classList.remove('idle');
    };
  }, []);

  // ── акцент турнира приходит в состоянии
  useEffect(() => {
    const accent = state?.theme.accent;
    if (accent != null && accent !== '') {
      document.documentElement.style.setProperty('--accent', accent);
    }
  }, [state?.theme.accent]);

  const stage = useRef<HTMLDivElement | null>(null);
  const fullscreen = () => {
    if (document.fullscreenElement !== null) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  };

  const layers = state?.layers ?? [];
  const leaving = useLeaving(layers);

  return (
    <div className={s.screen} onDoubleClick={fullscreen}>
      <div
        ref={stage}
        className={s.stage}
        style={{ width: STAGE_W, height: STAGE_H, transform: `translate(-50%, -50%) scale(${scale})` }}
      >
        <EnvProvider value={{ sound }}>
          {/* Уходящий кадр висит под новым, пока не отыграет свой уход: без
              этого смена читается как рез, а эфир — как листалка картинок. */}
          {leaving.map((l) => (
            <Layer key={`out-${l.id}-${l.since}`} layer={l} top={false} theme={state?.theme ?? null} leaving />
          ))}
          {layers.map((l, index) => (
            <Layer
              key={`${l.id}-${l.since}`}
              layer={l}
              top={index === layers.length - 1}
              theme={state?.theme ?? null}
            />
          ))}
        </EnvProvider>

        {/* Связи нет — кадр не подменяем: лучше замерший счёт, чем чёрный
            экран. Надпись висит поверх последнего, что успело прийти. */}
        {link.kind === 'lost' && state !== null && !DEMO ? (
          <div className={s.badge}>связь потеряна</div>
        ) : null}
      </div>

      {state === null && link.kind !== 'closed' ? (
        <div className={s.plain}>Подключаюсь к эфиру…</div>
      ) : null}

      {link.kind === 'closed' ? <div className={s.over}>{link.reason}</div> : null}

      {/* Браузеры не дают проигрывать аудио до действия пользователя, поэтому
          превью-аудио маппула молчит, пока зритель не нажмёт. Кнопка уходит
          после нажатия и больше не появляется.

          В миниатюре пульта её нет вовсе: там кадр и так без звука, а кнопка
          закрывала бы половину предпросмотра. */}
      {!sound && !framed ? (
        <button className={s.sound} type="button" onClick={() => setSound(true)}>
          <span aria-hidden>♪</span> Включить звук
        </button>
      ) : null}
    </div>
  );
}

/**
 * Один слой кадра.
 *
 * Анимация входа привязана ко времени слоя, а не к приходу сообщения: зашедший
 * посреди сцены видит конечное положение, а не дёргающийся перезапуск. Стиль
 * анимации приходит в теме и ставится сюда атрибутом `data-anim` — по нему
 * сцены и достраивают свой вход (селекторы в `air.css` и в модулях сцен).
 *
 * «Кинематограф» — другой язык кадра, а не вариант «Сдержанно» с наездом:
 * планки письма-бокса, летающая камера с траекторией по сцене и глубина у
 * объектов — заголовки ближе, списки дальше. Камера летит весь кадр, а не
 * только на входе.
 */
function Layer({
  layer,
  top,
  leaving,
  theme,
}: {
  layer: AirLayer;
  top: boolean;
  leaving?: boolean;
  theme: AirTheme | null;
}) {
  const fresh = useRef<boolean>(Date.now() - Date.parse(layer.since) < 900);
  const content = renderScene(layer.id, layer.payload);
  if (content === null) return null;

  const style = styleOf(theme, layer.id);
  // `data-fresh` отличает только что вошедший слой: «кинематограф» цепляется
  // за весь слой целиком, и метка нужна, чтобы не задеть уходящий кадр —
  // тому нужна своя анимация ухода.
  const freshAttr = leaving !== true && fresh.current ? { 'data-fresh': '' } : {};

  return (
    <div
      data-anim={style}
      data-scene={layer.id}
      {...freshAttr}
      className={[
        s.layer,
        top ? s.layerTop : null,
        leaving === true ? s.layerOut : fresh.current ? s.layerIn : null,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {style === 'cinematic' ? (
        <>
          {/* Планки, блик и виньетка — элементы фильма, а не сцены: сцена
              про турнир, обвязка — про камеру. */}
          <div className={s.cineBar} aria-hidden />
          <div className={`${s.cineBar} ${s.cineBarBottom}`} aria-hidden />
          <div className={s.cineSweep} aria-hidden />
          <div className={s.cineVignette} aria-hidden />
          {/* Мир и камера. Мир даёт перспективу, камера летит по своей
              траектории всю сцену — у каждой сцены она своя. Вход делает сам
              слой (`cineIn` в `air.css`). */}
          <div className={s.cineWorld}>
            <div className={`${s.cineCam} ${CAM_CLASS[camOf(layer.id)] ?? ''}`}>
              <LayerProvider value={{ since: layer.since, until: layer.until }}>
                {content}
              </LayerProvider>
            </div>
          </div>
        </>
      ) : (
        <LayerProvider value={{ since: layer.since, until: layer.until }}>{content}</LayerProvider>
      )}
    </div>
  );
}

/**
 * Кадры, которые только что сменились. Держим их ровно на время ухода и потом
 * забываем: иначе страница копила бы всё, что когда-либо показывали.
 *
 * Слой узнаём по `id` и времени входа: тот же слой с новым `until` — это
 * обрезка кадра, а не смена, и уходить ему не надо.
 */
function useLeaving(layers: AirLayer[]): AirLayer[] {
  const [out, setOut] = useState<AirLayer[]>([]);
  const previous = useRef<AirLayer[]>([]);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const key = (l: AirLayer) => `${l.id}-${l.since}`;
    const now = new Set(layers.map(key));
    const gone = previous.current.filter((l) => !now.has(key(l)));
    previous.current = layers;
    if (gone.length === 0) return;

    setOut(gone);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setOut([]);
    }, LEAVE);
  }, [layers]);

  // Таймер снимаем только при уходе со страницы. Снимать его в уборке эффекта
  // нельзя: следующее состояние приходит раньше, уборка гасит таймер, и
  // уходящий кадр остаётся висеть под новым навсегда.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return out;
}
