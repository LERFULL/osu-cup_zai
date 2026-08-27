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
import type { AirStyle, AirTemplate, SceneId } from '@/lib/air/types';
import { STYLE_TITLES, TEMPLATE_TITLES } from '@/lib/air/types';
import s from './Setup.module.css';

/**
 * Сцены про деньги появляются только под включённую механику: движок мест не
 * даёт ни одной, кроме табло, а «Шоу» даёт все. Фонд не раздувает каталог у
 * тех, кто им не пользуется, — сцену включает настройка турнира, а не вкус.
 */
function moneySceneVisible(id: SceneId, prize: PrizeView | null): boolean {
  switch (id) {
    case 'fundBoard':
    case 'fundFlow':
      return prize !== null;
    case 'topEarners':
      return prize !== null;
    case 'bountyHeads':
    case 'bountyTaken':
      return prize?.config.addons.bounty != null || prize?.config.engine.kind === 'bounty';
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

/** Три стиля по замыслу, а не по силе: подпись говорит, чем они отличаются.
 * Стиль — это движение: как кадр входит, как меняется, есть ли камера. */
const STYLES: { id: AirStyle; about: string }[] = [
  {
    id: 'sport',
    about: 'проф-подача: быстро и ёмко, без трюков — важно, как играют и что сыграли',
  },
  {
    id: 'show',
    about: 'камера стоит, картинка складывается по кусочкам — удерживает зрителя красотой сборки',
  },
  {
    id: 'cinema',
    about: 'камера летает в 3D между сценами — трепет больших турниров, каждый матч событие',
  },
];

/** Три шаблона: пространство, в котором идёт анимация — декорации и палитра. */
const TEMPLATES: { id: AirTemplate; about: string }[] = [
  {
    id: 'cup',
    about: 'родной тёмный osu!cup: стекло, акцент турнира, техничная сетка',
  },
  {
    id: 'rome',
    about: 'белое пространство, колонны и золото: античность в геометрии, турнир как гладиаторский',
  },
  {
    id: 'osu',
    about: 'арена оригинальной игры: треугольники, кольца, фирменные розовый и жёлтый',
  },
];

/** Значения селекта стиля сцены: пустое — «как у всех». */
const STYLE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'как у всех' },
  ...STYLES.map((st) => ({ value: st.id, label: STYLE_TITLES[st.id] })),
];

/** Шаги темпа: от «величественно» до «максимум скорости». */
const PACES: { value: number; label: string }[] = [
  { value: 0.5, label: '0.5×' },
  { value: 0.75, label: '0.75×' },
  { value: 1, label: '1×' },
  { value: 1.25, label: '1.25×' },
  { value: 1.5, label: '1.5×' },
  { value: 2, label: '2×' },
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

/** Мини-демо шаблона: маленький кадр в стиле выбранного шаблона — палитра
 * и фактура читаются без запуска эфира. */
function TemplateDemo({ kind }: { kind: AirTemplate }) {
  return (
    <div className={s.tplDemo} data-tpl={kind}>
      <i className={s.tplCol} style={{ '--c': 0 } as React.CSSProperties} />
      <i className={s.tplCol} style={{ '--c': 1 } as React.CSSProperties} />
      <i className={s.tplCol} style={{ '--c': 2 } as React.CSSProperties} />
      <i className={s.tplCol} style={{ '--c': 3 } as React.CSSProperties} />
      <span className={s.tplTitle}>Финал</span>
      <span className={s.tplLine} />
      <span className={s.tplLine} />
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
  const { config, patchConfig, start, ctx, error, status, standby, beginShow } = useAir();
  const live = status?.live === true;
  const prize = ctx?.prize ?? null;
  const waiting = live && standby;

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
        note="как ведёт себя кадр: скорости входа, камера, переходы. Отдельную сцену можно переопределить в списке заготовок"
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

      <Card
        title="Шаблон кадра"
        note="что в кадре: декорации, палитра, типографика. Один на весь эфир — задают подачу турнира"
      >
        <div className={s.styles}>
          {TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              className={[s.style, config.template === tpl.id ? s.styleOn : null]
                .filter(Boolean)
                .join(' ')}
              onClick={() => void patchConfig({ template: tpl.id })}
            >
              <span className={s.styleTitle}>{TEMPLATE_TITLES[tpl.id]}</span>
              <span className={s.styleAbout}>{tpl.about}</span>
              <TemplateDemo kind={tpl.id} />
            </button>
          ))}
        </div>
      </Card>

      <Card title="Темп заготовок" note="одна ручка на все сцены: долгие ужимаются, короткие растягиваются">
        <div className={s.pace}>
          {PACES.map((p) => (
            <button
              key={p.value}
              type="button"
              className={[s.paceStep, config.pace === p.value ? s.paceOn : null]
                .filter(Boolean)
                .join(' ')}
              onClick={() => void patchConfig({ pace: p.value })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className={s.paceNote}>
          {config.pace < 0.9
            ? 'сцены идут дольше — в эфире больше воздуха'
            : config.pace > 1.1
              ? `сцены быстрее в ${config.pace}× — темп плотный`
              : 'длительности из каталога, как задумано'}
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

      <Card title="Куда идёт кадр" note="браузерный источник в OBS, размер 1920×1080">
        <div className={s.obs}>
          {live ? (
            <>
              <div className={s.obsAddr}>{status?.localUrl}</div>
              <div className={s.obsRow}>
                <Button
                  size="sm"
                  variant={waiting ? 'primary' : 'ghost'}
                  onClick={() => void copy(status?.localUrl ?? '')}
                >
                  Скопировать адрес
                </Button>
                <Button size="sm" onClick={() => void openDemoFrame()}>
                  Пробный кадр
                </Button>
              </div>
              <div className={s.obsHow}>
                {waiting
                  ? 'Скопируй адрес, добавь его в OBS как браузерный источник и выровняй по размеру — показ начнётся по кнопке внизу, эфир не убежит. '
                  : ''}
                Размер источника и канвы — 1920×1080: на других размерах кадр масштабируется, и текст плывёт.
              </div>
            </>
          ) : (
            <div className={s.obsWhat}>Браузерный источник в OBS</div>
          )}
        </div>
      </Card>

      <div className={s.go}>
        {waiting ? (
          <>
            <Button
              variant="primary"
              onClick={() => {
                beginShow();
                onStarted?.();
              }}
            >
              Начать показ
            </Button>
            <span className={s.goNote}>
              Эфир поднят и ждёт: адрес выше, кадр стоит на заставке. Показ начнётся
              с трейлеров турнира — успей включить OBS
            </span>
          </>
        ) : (
          <>
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
                  : 'После запуска эфир подождёт: скопируешь адрес и поднимешь OBS — потом начнёшь показ'}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
