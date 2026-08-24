// Пульт во время эфира.
//
// Порядок здесь — порядок вопросов, которые задаёт себе хост: что в эфире,
// что будет дальше, чем это заменить. Всё, что нужно один раз за вечер —
// ссылки, код, задержка, бюджет паузы, — убрано под «Настройки эфира»: во
// время игры это шум, из-за которого не видно главного.
//
// Миниатюра — та же страница в маленьком размере, а не картинка: рисовать
// превью отдельно значит иметь два кадра, которые однажды разойдутся.

import { useState } from 'react';
import { Button, Field, Switch } from '@/components';
import { sceneMeta } from '@/lib/air/catalog';
import { useAir } from '@/lib/air/store';
import { playlistSummary } from '@/lib/air/playlist';
import type { SceneId } from '@/lib/air/types';
import { isTauri } from '@/lib/host';
import { Card } from './Card';
import { leftLabel, QUICK, useFrame } from './shared';
import s from './Live.module.css';

/** Показ в браузере: настоящего сервера нет, кадр идёт каналом внутри окна. */
const inTauri = isTauri();

export function Live() {
  const air = useAir();
  const { status, config, airing, proposals, overflow, frozen, playlist, lobby, error } = air;
  const frame = useFrame();

  const [minutes, setMinutes] = useState(6);
  const [text, setText] = useState('');
  const [settings, setSettings] = useState(false);

  if (status === null) return null;

  const plan = air.plan();
  const previewSrc = inTauri
    ? status.localUrl
    : `${window.location.origin}/air.html?transport=channel`;

  const copy = (value: string) => void navigator.clipboard.writeText(value).catch(() => undefined);

  return (
    <div className={s.live}>
      {error !== null ? <div className={s.error}>{error}</div> : null}

      {/* ── главная строка: что в эфире и что дальше */}
      <div className={s.top}>
        <section className={s.now}>
          <div className={s.nowHead}>
            <span className={s.tag}>Сейчас в эфире</span>
            <span className={s.nowTime}>{leftLabel(frame.left)}</span>
            {status.pending > 0 ? (
              <Button size="sm" variant="danger" onClick={() => void air.revert()}>
                Вернуть
              </Button>
            ) : null}
          </div>

          <div className={s.nowWhat}>
            {airing === null ? 'кадра ещё нет' : sceneMeta(airing.id).title}
          </div>
          <div className={s.bar}>
            <div className={s.barFill} style={{ width: `${(frame.part * 100).toFixed(1)}%` }} />
          </div>

          <div className={s.preview}>
            <iframe className={s.frame} src={previewSrc} title="Кадр эфира" />
          </div>

          <div className={s.nowFoot}>
            <span className={s.viewers}>
              <i aria-hidden /> смотрят {status.viewers}
            </span>
            {status.delay > 0 ? (
              <span className={s.delay}>
                задержка {status.delay} с
                {status.pending > 0 ? ` · ${status.pending} кадр ждёт` : ' · всё ушло'}
              </span>
            ) : null}
          </div>
        </section>

        <section className={s.next}>
          <div className={s.nextHead}>
            <span className={s.tag}>Дальше</span>
            <span className={plan.automatic ? s.auto : s.manual}>
              {plan.automatic ? 'выйдет само' : 'ждёт кнопки'}
            </span>
          </div>

          <div className={s.nextWhat}>{plan.label}</div>
          <div className={s.nextNote}>{plan.note}</div>

          <div className={s.nextRow}>
            <Button variant="primary" onClick={() => void air.next()}>
              Дальше ▸
            </Button>
            {proposals.length > 0 ? (
              <Button onClick={() => air.skip()}>Пропустить</Button>
            ) : null}
            <Button
              {...(frozen ? ({ variant: 'primary' } as const) : {})}
              onClick={() => air.freeze(!frozen)}
            >
              {frozen ? 'Отпустить' : 'Замереть'}
            </Button>
          </div>

          {/* Очередь: что стоит за первым кадром. */}
          {proposals.length > 1 ? (
            <div className={s.queue}>
              {proposals.slice(1).map((p, index) => (
                <div key={`${p.id}-${index}`} className={s.queueRow}>
                  <span className={s.queueMark} aria-hidden>
                    ↓
                  </span>
                  {p.label}
                </div>
              ))}
            </div>
          ) : null}

          {overflow > 0 ? (
            <div className={s.warn}>
              Очередь глубиной три: {overflow} предложений вытеснено, они не вернутся
            </div>
          ) : null}

          {/* Плейлист паузы виден целиком: «что планируется» — это он. */}
          <div className={s.pause}>
            <div className={s.pauseHead}>
              <span className={s.tag}>Пауза</span>
              <span className={s.pauseNote}>
                {playlist === null ? 'соберётся к паузе' : playlistSummary(playlist)}
              </span>
              <Switch
                checked={config.pauseAuto}
                onChange={(value) => void air.patchConfig({ pauseAuto: value })}
              >
                сама
              </Switch>
            </div>

            {playlist !== null ? (
              <div className={s.playlist}>
                {playlist.items.map((item, index) => (
                  <div
                    key={`${item.id}-${index}`}
                    className={[
                      s.slot,
                      index < air.playlistAt ? s.slotDone : null,
                      index === air.playlistAt ? s.slotNext : null,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <span>{sceneMeta(item.id).title}</span>
                    <span className={s.slotTime}>
                      {item.seconds > 0 ? `${Math.round(item.seconds)} с` : 'по остатку'}
                    </span>
                  </div>
                ))}
                {playlist.items.length === 0 ? (
                  <div className={s.quiet}>Показывать в паузу нечего — включи сцены в настройках</div>
                ) : null}
              </div>
            ) : null}

            <div className={s.countdown}>
              <Field
                label="Следующий матч через, минуты"
                type="number"
                min={1}
                max={60}
                value={minutes}
                onChange={(e) => setMinutes(Math.max(1, Number(e.target.value)))}
              />
              <Button size="sm" onClick={() => air.setCountdown(minutes)}>
                Отсчёт
              </Button>
              {air.countdownUntil !== null ? (
                <Button size="sm" onClick={() => air.setCountdown(null)}>
                  Снять
                </Button>
              ) : null}
            </div>
          </div>
        </section>
      </div>

      {/* ── быстрые кадры и вся сетка заготовок */}
      <section className={s.scenesBlock}>
        <div className={s.scenesHead}>
          <span className={s.tag}>Вывести кадр</span>
          <span className={s.quiet}>клик — сразу в эфир</span>
        </div>

        <div className={s.quickRow}>
          {QUICK.map((q) => (
            <button
              key={q.id}
              className={s.quickBtn}
              type="button"
              title={sceneMeta(q.id).about}
              onClick={() => void air.pick(q.id)}
            >
              {q.label}
            </button>
          ))}

          <span className={s.say}>
            <input
              className={s.sayInput}
              value={text}
              placeholder="своя надпись в кадр"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && text.trim() !== '') void air.say(text.trim());
              }}
            />
            <Button size="sm" disabled={text.trim() === ''} onClick={() => void air.say(text.trim())}>
              В эфир
            </Button>
          </span>
        </div>

        <SceneGrid />
      </section>

      {/* ── всё остальное: один раз за вечер */}
      <section className={s.rest}>
        <button className={s.restHead} type="button" onClick={() => setSettings(!settings)}>
          <span className={s.tag}>Ссылки, код и настройки эфира</span>
          <span className={s.restMark} aria-hidden>
            {settings ? '⌃' : '⌄'}
          </span>
        </button>

        {settings ? (
          <div className={s.restBody}>
            <Card title="Куда смотреть">
              {status.publicUrl !== null ? (
                <Link label="Публичная ссылка" value={status.publicUrl} onCopy={copy} />
              ) : null}
              {status.publicError !== null ? (
                <div className={s.warn}>{status.publicError}</div>
              ) : null}

              <Link label="Источник для OBS" value={status.localUrl} onCopy={copy} />
              {status.lanUrl !== null ? (
                <Link label="В этой сети" value={status.lanUrl} onCopy={copy} />
              ) : null}

              <div className={s.codeRow}>
                <span className={s.codeLabel}>код доступа</span>
                <span className={s.code}>{status.code}</span>
                <Button
                  size="sm"
                  onClick={() => {
                    if (
                      window.confirm(
                        'Сменить код? Все, кто смотрит сейчас, отключатся и получат «эфир закрыт». Новую ссылку придётся разослать заново.',
                      )
                    ) {
                      void air.newCode();
                    }
                  }}
                >
                  Сменить
                </Button>
              </div>

              <div className={s.hintRow}>
                {config.publicLink
                  ? 'Ссылка живёт, пока открыто приложение. Одной аудитории давай что-то одно: у ссылки своя задержка, у стрима своя.'
                  : 'Эфир локальный. Свой видеофайл можно показывать только в этом режиме.'}
              </div>
            </Card>

            <Card title="Как ведём">
              <div className={s.modes}>
                {(
                  [
                    ['manual', 'Руками', 'сценарий считается, но не выводится'],
                    ['confirm', 'С подтверждением', 'предложение ждёт кнопки'],
                    ['auto', 'Сам', 'кадры выходят без нажатий'],
                  ] as const
                ).map(([mode, title, note]) => (
                  <button
                    key={mode}
                    className={[s.mode, config.mode === mode ? s.modeOn : null]
                      .filter(Boolean)
                      .join(' ')}
                    type="button"
                    onClick={() => void air.patchConfig({ mode })}
                  >
                    <span className={s.modeTitle}>{title}</span>
                    <span className={s.modeNote}>{note}</span>
                  </button>
                ))}
              </div>

              <Field
                label="Ожидаемая пауза между матчами, минуты"
                type="number"
                min={1}
                max={30}
                value={Math.round(config.pauseBudget / 60)}
                onChange={(e) =>
                  void air.patchConfig({
                    pauseBudget: Math.max(60, Number(e.target.value) * 60),
                  })
                }
              />

              <Switch
                checked={config.showViewers}
                onChange={(value) => void air.patchConfig({ showViewers: value })}
              >
                Показывать зрителям счётчик зрителей
              </Switch>

              <Button size="sm" onClick={() => void air.clearShows()}>
                Сбросить счётчики показов
              </Button>
            </Card>

            {lobby !== null ? (
              <Card title="Лобби osu!" note={`матч ${lobby.roomId}`}>
                {lobby.error !== null ? (
                  <div className={s.warn}>лобби не читается: {lobby.error}</div>
                ) : (
                  <div className={s.quiet}>
                    {lobby.currentGameId !== null
                      ? 'карта играется — счёт появится, когда она кончится'
                      : `прочитано карт: ${lobby.games.length}`}
                  </div>
                )}
              </Card>
            ) : null}
          </div>
        ) : null}
      </section>

      <div className={s.foot}>
        <span className={s.keys}>
          Пробел — дальше · Esc — пропустить · P — замереть
          {status.delay > 0 ? ' · «Вернуть» снимает кадр, пока держится задержка' : ''}
        </span>
        <Button
          variant="danger"
          onClick={() => {
            if (window.confirm('Остановить эфир? Зрители увидят «эфир окончен».')) {
              void air.stop();
            }
          }}
        >
          Остановить эфир
        </Button>
      </div>
    </div>
  );
}

function Link({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: (value: string) => void;
}) {
  return (
    <div className={s.link}>
      <span className={s.linkLabel}>{label}</span>
      <span className={s.linkValue}>{value}</span>
      <Button size="sm" onClick={() => onCopy(value)}>
        Скопировать
      </Button>
    </div>
  );
}

/**
 * Сетка включённых заготовок.
 *
 * Показанное раньше не запрещено: запрет мешал вернуться к сетке или к маппулу,
 * а решать, что уже надоело, — дело хоста, а не программы. Число показов
 * подписано, и этого достаточно. Автоподбор в паузу повторы всё равно
 * не берёт — там за это отвечает бюджет, а не кнопка.
 */
function SceneGrid() {
  const air = useAir();
  const shownTimes = (id: SceneId, objectKey: string) =>
    air.shows.find((x) => x.sceneId === id && x.objectKey === objectKey)?.shows ?? 0;

  const items = air.manual();

  return (
    <div className={s.scenes}>
      {items.map((c) => {
        const meta = sceneMeta(c.id);
        const shows = shownTimes(c.id, c.objectKey);
        // Про кого кадр — важнее, чем «по игроку»: двенадцать одинаковых
        // кнопок без имён неразличимы, и выбрать из них нельзя.
        const note = !c.available
          ? (c.reason ?? 'нет данных')
          : [c.objectName, shows > 0 ? `показывали ${shows}` : null]
              .filter(Boolean)
              .join(' · ') || meta.about;

        return (
          <button
            key={`${c.id}-${c.objectKey}`}
            className={[
              s.scene,
              !c.available ? s.sceneOff : null,
              meta.kind === 'match' ? s.sceneMatch : null,
              c.required ? s.sceneWanted : null,
            ]
              .filter(Boolean)
              .join(' ')}
            type="button"
            disabled={!c.available}
            title={c.available ? meta.about : (c.reason ?? '')}
            onClick={() => void air.pick(c.id, c.objectKey)}
          >
            <span className={s.sceneTitle}>{meta.title}</span>
            <span className={s.sceneNote}>{note}</span>
          </button>
        );
      })}
    </div>
  );
}
