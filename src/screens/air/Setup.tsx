// Настройка эфира до запуска.
//
// Порядок блоков — порядок решений: сначала что вообще можно показывать, потом
// сколько это длится, и только в конце — куда идёт кадр. Решений мало нарочно:
// эфир идёт сам, и настраивать в нём почти нечего.

import { Button, Field, Switch } from '@/components';
import { Card } from './Card';
import { RoundPlans } from './RoundPlans';
import { MATCH_LIST, PAUSE_LIST, type SceneMeta } from '@/lib/air/catalog';
import { useAir } from '@/lib/air/store';
import type { SceneId } from '@/lib/air/types';
import s from './Setup.module.css';

export function Setup() {
  const { config, patchConfig, start, ctx, error } = useAir();

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

      <Card title="Кто ведёт кадры" note="эфир идёт сам — судить и вести его может один человек">
        <Switch
          checked={config.holdPicks}
          onChange={(v) => void patchConfig({ holdPicks: v })}
          note="Пик — тот момент, который хочется вскрыть тогда, когда решил ты, а не когда судья ввёл. Всё остальное выходит без нажатий"
        >
          Придерживать вскрытие пика
        </Switch>
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

      <Card title="Куда идёт кадр">
        <div className={s.obs}>
          <div className={s.obsWhat}>Браузерный источник в OBS</div>
          <div className={s.obsHow}>
            Адрес появится после запуска. Размер источника и канвы — 1920×1080: на других
            размерах кадр масштабируется, и текст плывёт.
          </div>
        </div>
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
          {ctx === null ? 'Сначала выбери турнир' : 'Адрес для браузерного источника в OBS'}
        </span>
      </div>
    </div>
  );
}
