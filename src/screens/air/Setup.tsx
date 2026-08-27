// Настройка эфира до запуска.
//
// Порядок блоков — порядок решений: сначала что вообще можно показывать, потом
// сколько это длится, и только в конце — куда идёт кадр. Решений мало нарочно:
// эфир идёт сам, и настраивать в нём почти нечего.

import { useEffect, useState } from 'react';
import { Button, Field, Switch } from '@/components';
import { Card } from './Card';
import { RoundPlans } from './RoundPlans';
import { MATCH_LIST, PAUSE_LIST, type SceneMeta } from '@/lib/air/catalog';
import { useAir } from '@/lib/air/store';
import { isTauri } from '@/lib/host';
import type { PrizeView } from '@/lib/types';
import type { AirStyle, SceneId } from '@/lib/air/types';
import { STYLE_TITLES } from '@/lib/air/types';
import s from './Setup.module.css';

/**
 * Сцены про деньги появляются только под включённую механику: движок мест не
 * даёт ни одной, кроме табло, а «Шоу» даёт все. Фонд не раздувает каталог у
 * тех, кто им не пользуется, — сцену включает настройка турнира, а не вкус.
 */
function moneySceneVisible(id: SceneId, prize: PrizeView | null): boolean {
  switch (id) {
    case 'fundBoard':
      return prize !== null;
    case 'bountyHeads':
    case 'bountyTaken':
      return prize?.config.addons.bounty != null;
    case 'rookieRace':
      return prize?.config.addons.rookieRace != null;
    case 'spectatorBank':
      return prize?.config.addons.spectator != null;
    case 'jackpotScene':
      return prize?.config.addons.jackpot === true;
    default:
      return true;
  }
}

/** Три стиля по замыслу, а не по силе: подпись говорит, чем они отличаются. */
const STYLES: { id: AirStyle; about: string }[] = [
  { id: 'calm', about: 'проявление и небольшой подъём — эфир говорит, а не показывает трюки' },
  { id: 'assembled', about: 'кадр монтируется: части приезжают по очереди и с разных сторон' },
  { id: 'cinematic', about: 'как фильм: планки, летящая камера, планы глубины и блик света' },
];

/** Значения селекта стиля сцены: пустое — «как у всех». */
const STYLE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'как у всех' },
  ...STYLES.map((st) => ({ value: st.id, label: STYLE_TITLES[st.id] })),
];

/**
 * Мини-демо стиля: маленький кадр с «заголовком» и тремя «строками», который
 * проигрывает выбранный стиль прямо в кнопке. Перезапуск — сменой key.
 */
function StyleDemo({ kind, run }: { kind: AirStyle; run: number }) {
  return (
    <div key={run} className={s.demo} {...(run > 0 ? { 'data-demo': kind } : {})}>
      <span className={s.demoHead} />
      <span className={s.demoBar} style={{ '--i': 0 } as React.CSSProperties} />
      <span className={s.demoBar} style={{ '--i': 1 } as React.CSSProperties} />
      <span className={s.demoBar} style={{ '--i': 2 } as React.CSSProperties} />
    </div>
  );
}

/**
 * Окно пробного кадра: тот же `air.html` с параметром `demo` — страница сама
 * рисует «Ход матча» на подставленных данных, без эфира и соединения. Окно, а
 * не вкладка: размер 1920×1080 важнее всего остального, его и выставляют в OBS.
 */
async function openDemoFrame(): Promise<void> {
  // В показе вёрстки в браузере окон Tauri нет — там хватит и вкладки.
  if (!isTauri()) {
    window.open('air.html?demo', '_blank');
    return;
  }
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    // Окно уже открыто — не плодим второе, просто поднимаем первое.
    const existing = await WebviewWindow.getByLabel('demo-frame');
    if (existing !== null) {
      await existing.setFocus();
      return;
    }
    const win = new WebviewWindow('demo-frame', {
      url: 'air.html?demo',
      width: 1920,
      height: 1080,
      title: 'Пробный кадр',
    });
    // Отказ (нет прав, занятая метка) приходит событием, а не исключением —
    // молчать нельзя: кнопка, которая ничего не делает, хуже ошибки.
    void win.once('tauri://error', (e) => {
      useAir.setState({ error: `Пробный кадр не открылся: ${String(e.payload)}` });
    });
  } catch (e) {
    useAir.setState({ error: `Пробный кадр не открылся: ${String(e)}` });
  }
}

interface Props {
  /** Эфир поднялся: подготовка кончилась, дальше место хоста — у турнира. */
  onStarted?: () => void;
}

export function Setup({ onStarted }: Props) {
  const { config, patchConfig, start, ctx, error, status } = useAir();
  const live = status?.live === true;
  const prize = ctx?.prize ?? null;

  const visible = (meta: SceneMeta): boolean => moneySceneVisible(meta.id, prize);

  const copy = (value: string) =>
    void navigator.clipboard.writeText(value).catch(() => undefined);

  // ── живой предпросмотр стиля: играет в наведённой кнопке, а без наведения —
  // в выбранной. Счётчик перезапускает демо, пока оно на виду.
  const [hover, setHover] = useState<AirStyle | null>(null);
  const [play, setPlay] = useState(0);
  const showing = hover ?? config.style;

  useEffect(() => {
    const id = window.setInterval(() => setPlay((p) => p + 1), 3200);
    return () => window.clearInterval(id);
  }, []);

  const toggle = (id: SceneId) => {
    const has = config.enabled.includes(id);
    void patchConfig({
      enabled: has ? config.enabled.filter((x) => x !== id) : [...config.enabled, id],
    });
  };

  /** Переопределение стиля одной сцены: пустое значение убирает ключ. */
  const setSceneStyle = (id: SceneId, value: string) => {
    const next = { ...config.sceneStyle };
    if (value === '') delete next[id];
    else next[id] = value as AirStyle;
    void patchConfig({ sceneStyle: next });
  };

  const group = (title: string, note: string, list: SceneMeta[]) => (
    <Card title={title} note={note}>
      <div className={s.scenes}>
        {list.filter(visible).map((meta) => {
          const on = config.enabled.includes(meta.id);
          return (
            <div key={meta.id} className={s.sceneWrap}>
              <label
                className={[s.scene, on ? s.sceneOn : null].filter(Boolean).join(' ')}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(meta.id)}
                />
                <span className={s.sceneText}>
                  <span className={s.sceneTitle}>{meta.title}</span>
                  <span className={s.sceneAbout}>{meta.about}</span>
                </span>
                <span className={s.sceneTime}>
                  {meta.timing === 'fixed'
                    ? `${meta.min}–${meta.max} с`
                    : meta.timing === 'data'
                      ? 'по данным'
                      : 'без таймера'}
                </span>
              </label>

              {/* Стиль этой сцены: нужен редко — финал «кинематографом», а
                  остальное спокойно. Пустое значение — как у всего эфира. */}
              {on ? (
                <label className={s.sceneStyle}>
                  <span>стиль входа</span>
                  <select
                    value={config.sceneStyle[meta.id] ?? ''}
                    onChange={(e) => setSceneStyle(meta.id, e.target.value)}
                  >
                    {STYLE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );

  const text = (key: keyof typeof config.finalTexts, label: string, hint: string) => (
    <label className={s.text}>
      <span className={s.textLabel}>{label}</span>
      <textarea
        rows={3}
        value={config.finalTexts[key]}
        placeholder={hint}
        onChange={(e) =>
          void patchConfig({ finalTexts: { ...config.finalTexts, [key]: e.target.value } })
        }
      />
    </label>
  );

  return (
    <div className={s.setup}>
      {error !== null ? <div className={s.error}>{error}</div> : null}

      <Card title="Кто ведёт кадры" note="эфир идёт сам — судить и вести его может один человек">
        <Switch
          checked={config.holdPicks}
          onChange={(v) => void patchConfig({ holdPicks: v })}
          note="Пик — тот момент, который хочется вскрыть тогда, когда решил ты, а не когда судья ввёл. Всё остальное выходит без нажатий"
        >
          Придерживать вскрытие пика
        </Switch>
      </Card>

      <Card
        title="Стиль анимации"
        note="один на весь эфир; отдельную сцену можно переопределить в списке заготовок"
      >
        <div className={s.styles}>
          {STYLES.map((st) => (
            <button
              key={st.id}
              type="button"
              className={[s.style, config.style === st.id ? s.styleOn : null]
                .filter(Boolean)
                .join(' ')}
              onMouseEnter={() => setHover(st.id)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(st.id)}
              onBlur={() => setHover(null)}
              onClick={() => {
                void patchConfig({ style: st.id });
                setPlay((p) => p + 1);
              }}
            >
              <span className={s.styleTitle}>{STYLE_TITLES[st.id]}</span>
              <span className={s.styleAbout}>{st.about}</span>
              <StyleDemo kind={st.id} run={showing === st.id ? play + 1 : 0} />
            </button>
          ))}
        </div>
      </Card>

      {group(
        'Заготовки матча',
        'Невключённая сцена не появится в эфире никогда',
        MATCH_LIST,
      )}
      {group('Заготовки паузы', 'Из них собирается то, чем занят экран между матчами', PAUSE_LIST)}

      <RoundPlans />

      <Card title="Сколько это длится">
        <Field
          label="Ожидаемая пауза, минуты"
          type="number"
          min={1}
          max={30}
          value={Math.round(config.pauseBudget / 60)}
          hint="Сцены подбираются под это время, а не крутятся до упора"
          onChange={(e) =>
            void patchConfig({ pauseBudget: Math.max(1, Number(e.target.value)) * 60 })
          }
        />

        <Switch
          checked={config.pauseAuto}
          onChange={(v) => void patchConfig({ pauseAuto: v })}
          note="Сцены между матчами меняются сами, по бюджету паузы. Без этого экран стоит на заставке, пока не нажмёшь"
        >
          Пауза идёт сама
        </Switch>

      </Card>

      <Card title="Тексты финала" note="появятся в титрах, когда турнир доигран">
        <div className={s.texts}>
          {text('organizers', 'Организаторы', 'по строке на человека')}
          {text('judges', 'Судьи', 'по строке на человека')}
          {text('links', 'Ссылки', 'канал, чат, донаты — по строке на адрес')}
          {text('socials', 'Соцсети', 'по строке на адрес')}
        </div>
        <div className={s.textsNote}>Всё необязательное: пустое поле в титры не попадёт.</div>
      </Card>

      <Card title="Пробный кадр" note="выставить источник в OBS, пока никто не смотрит">
        <div className={s.obs}>
          <div className={s.demoWhat}>
            Откроется окно 1920×1080 со «Ходом матча» на подставленных данных: NAGISA против
            KIRA, счёт 2:1, все состояния строк маппула. Этот кадр и есть источник — добавь его
            в OBS и выровняй по размеру.
          </div>
          <Button onClick={() => void openDemoFrame()}>Показать ход матча</Button>
        </div>
      </Card>

      <Card title="Куда идёт кадр">
        <div className={s.obs}>
          <div className={s.obsWhat}>Браузерный источник в OBS</div>
          {live ? (
            <>
              <div className={s.obsAddr}>{status?.localUrl}</div>
              <Button size="sm" onClick={() => void copy(status?.localUrl ?? '')}>
                Скопировать адрес
              </Button>
            </>
          ) : null}
          <div className={s.obsHow}>
            {live ? '' : 'Адрес появится после запуска. '}
            Размер источника и канвы — 1920×1080: на других размерах кадр масштабируется,
            и текст плывёт.
          </div>
        </div>
      </Card>

      <div className={s.go}>
        <Button
          variant="primary"
          disabled={ctx === null || live}
          onClick={() =>
            void (async () => {
              await start();
              // Ушёл — значит подготовка кончилась. Не ушёл — повод виден строкой
              // ошибки, и уводить хоста с экрана, где он её прочтёт, нельзя.
              if (useAir.getState().status?.live === true) onStarted?.();
            })()
          }
        >
          Запустить эфир
        </Button>
        <span className={s.goNote}>
          {ctx === null
            ? 'Сначала собери сетку'
            : live
              ? 'Эфир уже идёт — управление на экране турнира'
              : 'Дальше эфир идёт сам: кадр следует за матчем'}
        </span>
      </div>
    </div>
  );
}
