// Настройка эфира до запуска.
//
// Порядок блоков — порядок решений: сначала кто ведёт кадры, потом что вообще
// можно показывать, потом сколько это длится, и только в конце — как зрители
// это получат. Проверка связи стоит рядом с публичной ссылкой, а не отдельно:
// узнать, что туннель не проходит, надо до эфира, а не посреди турнира.

import { Button, Field, Switch } from '@/components';
import { Card } from './Card';
import { RoundPlans } from './RoundPlans';
import { MATCH_LIST, PAUSE_LIST, type SceneMeta } from '@/lib/air/catalog';
import { useAir } from '@/lib/air/store';
import type { AirMode, SceneId } from '@/lib/air/types';
import s from './Setup.module.css';

const MODES: { id: AirMode; title: string; about: string }[] = [
  {
    id: 'manual',
    title: 'Ручной',
    about: 'Ничего не происходит само. Придержать вскрытие пика ради драмы — можно.',
  },
  {
    id: 'confirm',
    title: 'С подтверждением',
    about: 'Приложение считает переходы, но ждёт кнопки. Сценарий помнить не надо.',
  },
  {
    id: 'auto',
    title: 'Авто',
    about: 'Кадры выходят сами. Судишь матч и об эфире не думаешь.',
  },
];

export function Setup() {
  const { config, patchConfig, probe, runProbe, downloadTunnel, start, ctx, error } = useAir();

  const toggle = (id: SceneId) => {
    const has = config.enabled.includes(id);
    void patchConfig({
      enabled: has ? config.enabled.filter((x) => x !== id) : [...config.enabled, id],
    });
  };

  const group = (title: string, note: string, list: SceneMeta[]) => (
    <Card title={title} note={note}>
      <div className={s.scenes}>
        {list.map((meta) => (
          <label
            key={meta.id}
            className={[s.scene, config.enabled.includes(meta.id) ? s.sceneOn : null]
              .filter(Boolean)
              .join(' ')}
          >
            <input
              type="checkbox"
              checked={config.enabled.includes(meta.id)}
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
        ))}
      </div>
    </Card>
  );

  return (
    <div className={s.setup}>
      {error !== null ? <div className={s.error}>{error}</div> : null}

      <Card title="Кто ведёт кадры">
        <div className={s.modes}>
          {MODES.map((mode) => (
            <button
              key={mode.id}
              className={[s.mode, config.mode === mode.id ? s.modeOn : null]
                .filter(Boolean)
                .join(' ')}
              type="button"
              onClick={() => void patchConfig({ mode: mode.id })}
            >
              <span className={s.modeTitle}>{mode.title}</span>
              <span className={s.modeAbout}>{mode.about}</span>
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
        <div className={s.row}>
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
          <Field
            label="Задержка, секунды"
            type="number"
            min={0}
            max={30}
            value={config.delay}
            hint="Пока кадр не ушёл, его можно вернуть. Заодно сводит ссылку со стримом"
            onChange={(e) =>
              void patchConfig({ delay: Math.min(30, Math.max(0, Number(e.target.value))) })
            }
          />
        </div>

        <Switch
          checked={config.pauseAuto}
          onChange={(v) => void patchConfig({ pauseAuto: v })}
          note="Сцены между матчами меняются сами, по бюджету паузы. Без этого экран стоит на заставке, пока не нажмёшь"
        >
          Пауза идёт сама
        </Switch>

        <Switch
          checked={config.showViewers}
          onChange={(v) => void patchConfig({ showViewers: v })}
          note="Число в углу кадра"
        >
          Показывать число зрителей
        </Switch>
      </Card>

      <Card title="Как зрители это получат">
        <Switch
          checked={config.publicLink}
          onChange={(v) => void patchConfig({ publicLink: v })}
          note="Без неё останется локальный адрес — для OBS этого достаточно"
        >
          Публичная ссылка
        </Switch>

        {config.publicLink ? (
          <>
            <Field
              label="Сколько зрителей ожидается"
              type="number"
              min={1}
              max={2000}
              value={config.expectedViewers}
              hint={
                config.expectedViewers > 200
                  ? 'Больше 200 быстрый туннель не держит: дальше отдаётся отказ. Нужен именованный туннель с аккаунтом Cloudflare или свой сервер'
                  : 'Быстрый туннель держит примерно 200 одновременных зрителей'
              }
              {...(config.expectedViewers > 200
                ? { error: 'больше 200 быстрый туннель не отдаст' }
                : {})}
              onChange={(e) =>
                void patchConfig({ expectedViewers: Math.max(1, Number(e.target.value)) })
              }
            />

            <div className={s.probe}>
              <div className={s.probeHead}>
                <span className={s.probeTitle}>Проверка связи</span>
                <Button size="sm" onClick={() => void runProbe()}>
                  Проверить
                </Button>
              </div>

              {probe === null ? (
                <p className={s.probeNote}>
                  Публичная ссылка живёт, пока открыто приложение. Проверь связь заранее — узнать
                  о проблеме посреди турнира поздно.
                </p>
              ) : (
                <>
                  <div className={s.checks}>
                    <Check ok={probe.dataChannel} label="канал данных туннеля" />
                    <Check ok={probe.binary} label="cloudflared на месте" />
                  </div>

                  {probe.hint !== '' ? <p className={s.probeHint}>{probe.hint}</p> : null}

                  {!probe.binary ? (
                    <div className={s.install}>
                      <div className={s.installPath}>{probe.installPath}</div>
                      <Button size="sm" onClick={() => void downloadTunnel()}>
                        Скачать cloudflared
                      </Button>
                    </div>
                  ) : (
                    <div className={s.installPath}>{probe.binaryPath}</div>
                  )}
                </>
              )}
            </div>
          </>
        ) : null}
      </Card>

      <div className={s.go}>
        <Button
          variant="primary"
          disabled={ctx === null}
          onClick={() => void start()}
        >
          Запустить эфир
        </Button>
        <span className={s.goNote}>
          {ctx === null
            ? 'Сначала выбери турнир'
            : config.publicLink
              ? 'Ссылка живёт, пока открыто приложение'
              : 'Локальный эфир: адрес для OBS и для машин в этой сети'}
        </span>
      </div>
    </div>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={[s.check, ok ? s.checkOk : s.checkBad].join(' ')}>
      <span aria-hidden>{ok ? '✓' : '✕'}</span> {label}
    </span>
  );
}
