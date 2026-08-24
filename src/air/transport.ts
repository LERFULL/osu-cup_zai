// Транспорт страницы зрителя.
//
// Страница не знает, где заканчивается её соединение: сегодня это локальный
// сервер, за ним может стоять туннель, а когда-нибудь — свой релей. Ровно
// поэтому здесь одна абстракция, а не «подключиться к cloudflared».
//
// Второй вариант — канал внутри браузера. Он нужен, чтобы смотреть эфир, не
// собирая приложение: пульт в браузере пишет состояние туда же, откуда его
// читает эта страница.

import type { AirMessage } from '@/lib/air/types';

/** Имя канала для показа в браузере. Знают обе стороны и больше никто. */
export const CHANNEL = 'osucup-air';

/** Страница просит снимок: пульт мог начать раньше, чем её открыли. */
export interface HelloMessage {
  kind: 'hello';
}

export type Link =
  /** Состояние идёт, кадр живой. */
  | { kind: 'open' }
  /** Связь потеряна. Кадр не подменяем: лучше замерший счёт, чем чёрный экран. */
  | { kind: 'lost' }
  /** Эфир остановлен хостом. */
  | { kind: 'closed'; reason: string }
  /** Кода нет или он больше не действует. */
  | { kind: 'denied' };

export interface Transport {
  stop: () => void;
}

interface Handlers {
  message: (m: AirMessage) => void;
  link: (l: Link) => void;
}

/** Что вообще открыли: адрес эфира или показ в браузере. */
export function readParams(): { code: string; channel: boolean; ws: string | null } {
  const q = new URLSearchParams(window.location.search);
  return {
    code: q.get('code') ?? '',
    channel: q.get('transport') === 'channel',
    ws: q.get('ws'),
  };
}

/** Смотрят через OBS: там автозапуск звука разрешён и кнопка не нужна. */
export function isObs(): boolean {
  return /OBS/i.test(navigator.userAgent);
}

export function connect(handlers: Handlers): Transport {
  const params = readParams();
  return params.channel ? viaChannel(handlers) : viaSocket(params, handlers);
}

/**
 * Разбирает сообщение на «это про кадр» и «это про сам эфир».
 *
 * Один разбор на оба транспорта нарочно: разойдись они — и «эфир окончен»
 * показывался бы по ссылке, но не при показе в браузере, а такую разницу
 * замечают в последнюю очередь. Возвращает `true`, если эфира больше нет.
 */
function route(message: AirMessage, handlers: Handlers): boolean {
  if (message.kind === 'closed') {
    handlers.link({ kind: 'closed', reason: message.reason });
    return true;
  }
  if (message.kind === 'kicked') {
    handlers.link({ kind: 'denied' });
    return true;
  }
  handlers.message(message);
  return false;
}

/**
 * Показ в браузере. Ни сервера, ни кода доступа: канал живёт внутри одного
 * браузера, наружу из него ничего не уходит.
 */
function viaChannel(handlers: Handlers): Transport {
  const channel = new BroadcastChannel(CHANNEL);

  channel.onmessage = (e: MessageEvent<AirMessage | HelloMessage>) => {
    // Своё же «дай снимок» обратно не читаем.
    if (e.data.kind === 'hello') return;
    route(e.data, handlers);
  };

  handlers.link({ kind: 'open' });
  channel.postMessage({ kind: 'hello' } satisfies HelloMessage);

  return { stop: () => channel.close() };
}

/** Через сколько пробуем переподключиться. Растёт до десяти секунд. */
const RETRY = [400, 900, 2000, 4000, 10_000];

function viaSocket(
  params: { code: string; ws: string | null },
  handlers: Handlers,
): Transport {
  let socket: WebSocket | null = null;
  let attempt = 0;
  let timer: number | null = null;
  let stopped = false;
  /** Хост сказал, что эфира больше нет: переподключаться незачем. */
  let finished = false;
  /** Открывалось ли соединение хоть раз. Этим и отличаем «код не подошёл»
   *  от «связь оборвалась»: причину закрытия браузер не сообщает. */
  let everOpened = false;

  const address = () => {
    if (params.ws !== null && params.ws !== '') return params.ws;
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${window.location.host}/air?code=${encodeURIComponent(params.code)}`;
  };

  const retry = () => {
    if (stopped || finished) return;
    const wait = RETRY[Math.min(attempt, RETRY.length - 1)] ?? 10_000;
    attempt += 1;
    timer = window.setTimeout(open, wait);
  };

  function open() {
    if (stopped || finished) return;

    const ws = new WebSocket(address());
    socket = ws;

    ws.onopen = () => {
      attempt = 0;
      everOpened = true;
      handlers.link({ kind: 'open' });
    };

    ws.onmessage = (e: MessageEvent<string>) => {
      let parsed: AirMessage;
      try {
        parsed = JSON.parse(e.data) as AirMessage;
      } catch {
        // Испорченное сообщение — не повод гасить кадр.
        return;
      }

      if (route(parsed, handlers)) finished = true;
    };

    ws.onclose = () => {
      socket = null;
      if (stopped || finished) return;
      // Ни разу не открылось — значит сервер отказал: кода нет или он не тот.
      handlers.link(everOpened ? { kind: 'lost' } : { kind: 'denied' });
      retry();
    };
  }

  open();

  return {
    stop: () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      socket?.close();
    },
  };
}
