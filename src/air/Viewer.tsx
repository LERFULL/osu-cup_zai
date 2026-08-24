// Страница зрителя. По ссылке открывается это, и нажать здесь нельзя ничего,
// кроме звука и полного экрана.
//
// Единственное правило: приложение пушит состояние, страница его рисует.
// Отсюда всё остальное — страница не делает запросов, ничего не считает и не
// знает, что существует база, библиотека и другие турниры.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AirLayer, AirMessage, AirState } from '@/lib/air/types';
import { connect, isObs, type Link } from './transport';
import { EnvProvider, LayerProvider } from './scenes/env';
import { renderScene } from './scenes/registry';
import s from './Viewer.module.css';

/** Кадр строится под этот размер и масштабируется целиком. */
const STAGE_W = 1920;
const STAGE_H = 1080;

/** Через сколько без движения мыши курсор уходит. */
const CURSOR_IDLE = 3000;

/**
 * Сколько уходящий кадр ещё висит под новым.
 *
 * Без этого смена кадра — рез: старое исчезает в тот же миг, и эфир выглядит
 * листалкой картинок. Должно совпадать с `--move` в `air.css`.
 */
const LEAVE = 420;

export function Viewer() {
  const [state, setState] = useState<AirState | null>(null);
  const [link, setLink] = useState<Link>({ kind: 'lost' });
  // В OBS автозапуск звука разрешён — там кнопки нет вовсе.
  const [sound, setSound] = useState(() => isObs());
  /** Страница открыта в рамке — это миниатюра пульта, а не зритель. */
  const framed = window.self !== window.top;

  // ── состояние приходит сообщениями
  const apply = useCallback((m: AirMessage) => {
    setState((prev) => {
      switch (m.kind) {
        case 'snapshot':
          return m.state;
        case 'scene':
          return prev === null ? prev : { ...prev, layers: m.layers };
        case 'patch': {
          if (prev === null) return prev;
          // Патч бьёт по слою, а не по кадру: смены сцены здесь нет, и
          // переход не запускается — зато внутри сцены всё анимируется как обычно.
          const layers = prev.layers.map((l) =>
            l.id === m.layer ? { ...l, payload: m.payload } : l,
          );
          return { ...prev, layers };
        }
        case 'viewers':
          return prev === null ? prev : { ...prev, air: { ...prev.air, viewers: m.viewers } };
        default:
          return prev;
      }
    });
  }, []);

  useEffect(() => {
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
        <EnvProvider value={{ sound, localOnly: state?.air.localOnly ?? true }}>
          {/* Уходящий кадр висит под новым, пока не отыграет свой уход: без
              этого смена читается как рез, а эфир — как листалка картинок. */}
          {leaving.map((l) => (
            <Layer key={`out-${l.id}-${l.since}`} layer={l} top={false} leaving />
          ))}
          {layers.map((l, index) => (
            <Layer key={`${l.id}-${l.since}`} layer={l} top={index === layers.length - 1} />
          ))}
        </EnvProvider>

        {state !== null && state.air.showViewers ? (
          <div className={s.viewers}>
            <i aria-hidden />
            {state.air.viewers}
          </div>
        ) : null}

        {/* Связь потеряна — кадр не подменяем: лучше замерший счёт, чем чёрный
            экран. Надпись висит поверх последнего, что успело прийти. */}
        {link.kind === 'lost' && state !== null ? (
          <div className={s.badge}>связь потеряна</div>
        ) : null}
      </div>

      {state === null && link.kind !== 'denied' && link.kind !== 'closed' ? (
        <div className={s.plain}>Подключаюсь к эфиру…</div>
      ) : null}

      {link.kind === 'denied' ? <div className={s.plain}>Эфир закрыт</div> : null}
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
 * посреди сцены видит конечное положение, а не дёргающийся перезапуск.
 */
function Layer({
  layer,
  top,
  leaving,
}: {
  layer: AirLayer;
  top: boolean;
  leaving?: boolean;
}) {
  const fresh = useRef<boolean>(Date.now() - Date.parse(layer.since) < 900);
  const content = renderScene(layer.id, layer.payload);
  if (content === null) return null;

  return (
    <div
      className={[
        s.layer,
        top ? s.layerTop : null,
        leaving === true ? s.layerOut : fresh.current ? s.layerIn : null,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <LayerProvider value={{ since: layer.since, until: layer.until }}>{content}</LayerProvider>
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
