import { useEffect, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Area, Button, Field } from '@/components';
import * as ipc from '@/lib/ipc';
import { maps, plural, templateShape, templateSize } from '@/lib/format';
import type {
  CredentialsCheck,
  GenReport,
  ImportProgress,
  ParsedLinks,
  PoolTemplate,
} from '@/lib/types';
import { useApp } from '@/store/app';
import s from './Onboarding.module.css';

const REGISTER_URL = 'https://osu.ppy.sh/home/account/edit#new-oauth-application';

const STEP_COUNT = 6;

const LINKS_PLACEHOLDER = `Вставь любые ссылки на карты osu! — списком или одним куском:

https://osu.ppy.sh/beatmapsets/1084284#osu/2271897
osu.ppy.sh/b/2271897`;

/** Ники из textarea: по одному на строку, пустые строки и повторы отброшены. */
function nicknamesOf(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const nick = raw.trim();
    if (nick === '') continue;
    const key = nick.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(nick);
  }
  return out;
}

function stageName(stage: ImportProgress['stage']): string {
  switch (stage) {
    case 'fetching':
      return 'Тяну с osu!';
    case 'saving':
      return 'Сохраняю';
    case 'covers':
      return 'Качаю обложки';
    case 'skillsets':
      return 'Считаю скилсеты';
    case 'done':
      return 'Готово';
    case 'cancelled':
      return 'Отменено';
    default:
      return 'В очереди';
  }
}

/**
 * Первый запуск. Шесть шагов, каждый можно пропустить: онбординг создаёт
 * настоящий турнир, а не песочницу, но всё, что не сделано здесь, делается
 * потом в обычных разделах.
 */
export default function Onboarding() {
  const startImport = useApp((st) => st.startImport);
  const importing = useApp((st) => st.importing);

  const [step, setStep] = useState(1);

  // Шаг 2: ключ osu!
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CredentialsCheck | null>(null);
  // Ключ уже есть — проверенный сейчас или спасённый когда-то. От этого зависит
  // предупреждение на шаге карт: без ключа загрузка не пойдёт.
  const [credsOk, setCredsOk] = useState(
    () => useApp.getState().status?.hasCredentials === true,
  );

  // Шаг 3: карты по ссылкам
  const [linksText, setLinksText] = useState('');
  const [found, setFound] = useState<ParsedLinks | null>(null);

  // Шаг 4: маппул по шаблону
  const [templates, setTemplates] = useState<PoolTemplate[] | null>(null);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [rolling, setRolling] = useState(false);
  const [pool, setPool] = useState<GenReport | null>(null);
  const [poolError, setPoolError] = useState<string | null>(null);

  // Шаг 5: игроки и сборка турнира
  const [playersText, setPlayersText] = useState('');
  const [playerIds, setPlayerIds] = useState<number[]>([]);
  const [playersBusy, setPlayersBusy] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [tournamentId, setTournamentId] = useState<number | null>(null);

  // Разбор ссылок идёт на каждое изменение — он не ходит в сеть и стоит копейки.
  useEffect(() => {
    if (linksText.trim() === '') {
      setFound(null);
      return;
    }
    let alive = true;
    void ipc.parseLinks(linksText).then((p) => {
      if (alive) setFound(p);
    });
    return () => {
      alive = false;
    };
  }, [linksText]);

  // Шаблоны читаем один раз — при первом показе шага маппула.
  useEffect(() => {
    if (step !== 4 || templates !== null) return;
    let alive = true;
    void ipc
      .listTemplates()
      .then((list) => {
        if (!alive) return;
        setTemplates(list);
        // «Стандарт 1v1» (id 1) уже выбран — иначе первый попавшийся.
        setTemplateId(list.some((t) => t.id === 1) ? 1 : (list[0]?.id ?? null));
      })
      .catch((e) => {
        if (alive) setPoolError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [step, templates]);

  const filled = clientId.trim() !== '' && secret.trim() !== '';
  const total = found ? found.beatmapIds.length + found.beatmapsetIds.length : 0;
  const running =
    importing !== null && importing.stage !== 'done' && importing.stage !== 'cancelled';
  const importDone = importing?.stage === 'done';
  const poolMaps = pool ? pool.pool.slots.filter((x) => x.beatmapId !== null).length : 0;
  const nicknames = nicknamesOf(playersText);

  async function check() {
    setChecking(true);
    setResult(null);
    try {
      const creds = { clientId: clientId.trim(), clientSecret: secret.trim() };
      const res = await ipc.checkCredentials(creds);
      setResult(res);
      if (res.kind === 'ok') {
        await ipc.saveCredentials(creds);
        setCredsOk(true);
      }
    } catch (e) {
      setResult({ kind: 'invalid', message: String(e) });
    } finally {
      setChecking(false);
    }
  }

  async function rollPool() {
    if (templateId === null) return;
    setRolling(true);
    setPoolError(null);
    try {
      setPool(await ipc.generatePool(templateId, 'Маппул первого турнира', null));
    } catch (e) {
      setPoolError(String(e));
    } finally {
      setRolling(false);
    }
  }

  /** Создаёт перечисленных игроков, дубликаты по нику пропускает.
   *  Blur поля и клик по «Собрать турнир» ловят одну и ту же работу —
   *  гонки нет, второй вызов ждёт первый. */
  const creating = useRef<Promise<number[]> | null>(null);

  function ensurePlayers(): Promise<number[]> {
    if (creating.current !== null) return creating.current;
    const nicks = nicknamesOf(playersText);
    if (nicks.length === 0) {
      setPlayerIds([]);
      return Promise.resolve([]);
    }
    const job = (async () => {
      setPlayersBusy(true);
      try {
        const known = new Map(
          (await ipc.listPlayers(true)).map((p) => [p.nickname.trim().toLowerCase(), p.id]),
        );
        const ids: number[] = [];
        for (const nick of nicks) {
          const key = nick.toLowerCase();
          const present = known.get(key);
          if (present !== undefined) {
            ids.push(present);
            continue;
          }
          const made = await ipc.createPlayer(nick);
          known.set(key, made.id);
          ids.push(made.id);
        }
        setPlayerIds(ids);
        return ids;
      } finally {
        setPlayersBusy(false);
      }
    })();
    creating.current = job;
    void job.catch(() => undefined).finally(() => {
      creating.current = null;
    });
    return job;
  }

  /** Создать игроков, не собирая турнир:blur textarea. */
  async function savePlayers() {
    try {
      await ensurePlayers();
    } catch {
      // Причину покажет сборка турнира — сейчас достаточно промолчать.
    }
  }

  async function buildTournament() {
    setBuilding(true);
    setBuildError(null);
    try {
      const ids = await ensurePlayers();
      if (ids.length < 2) throw new Error('для сетки нужно хотя бы два игрока');

      const t = await ipc.createTournament('Первый турнир', 4, 1);
      for (const playerId of ids) {
        await ipc.addTournamentPlayer(t.id, playerId);
      }
      // Скатанный на прошлом шаге маппул привязываем сразу — турнир готов к запуску.
      if (pool !== null) await ipc.setTournamentPools(t.id, [pool.pool.id]);
      await ipc.shuffleTournamentSeeds(t.id);
      await ipc.startTournament(t.id);

      setTournamentId(t.id);
      setStep(6);
    } catch (e) {
      setBuildError(String(e));
    } finally {
      setBuilding(false);
    }
  }

  /** Конец онбординга: онбординг пройден, ведём в турниры. `openId` — открыть
   *  собранный турнир сразу: экран турниров забирает его из стора, как при
   *  «Продолжить» с Главной. */
  async function leave(openId: number | null = null) {
    await ipc.setOnboarded(true);
    const status = await ipc.getStatus();
    useApp.setState({
      status,
      route: 'tournaments',
      ...(openId !== null ? { openTournament: openId } : {}),
    });
  }

  return (
    <div className={s.screen}>
      <div className={s.card}>
        {step > 1 ? (
          <button className={s.skip} type="button" onClick={() => void leave()}>
            Пропустить
          </button>
        ) : null}

        {step > 1 ? (
          <div className={s.brand}>
            <span className={s.mark} aria-hidden />
            osu!cup
          </div>
        ) : null}

        {step === 1 ? (
          <>
            <h1 className={s.logo}>
              <span className={s.markBig} aria-hidden />
              osu!cup
            </h1>
            <p className={s.lead}>
              Турниры по osu! в кругу своих — от сетки до трансляции за один вечер.
            </p>
            <div className={s.actions}>
              <Button variant="primary" onClick={() => setStep(2)}>
                Пройти за 2 минуты
              </Button>
              <Button onClick={() => void leave()}>Пропустить</Button>
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <h1 className={s.h1}>Ключ osu!</h1>
            <p className={s.lead}>
              Нужен, чтобы приложение могло тянуть карты с osu!. Это не вход в аккаунт — прога
              видит только публичные данные карт, ни профиля, ни скоров. Создаётся один раз за
              две минуты.
            </p>

            <ol className={s.steps}>
              <li>Открой страницу регистрации приложения</li>
              <li>Нажми New OAuth Application, имя — любое</li>
              <li>Callback URL оставь пустым</li>
              <li>Скопируй сюда Client ID и Client Secret</li>
            </ol>

            <Button className={s.link} onClick={() => void openUrl(REGISTER_URL)}>
              Открыть страницу регистрации ↗
            </Button>

            <div className={s.fields}>
              <Field
                label="Client ID"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="например, 41287"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
              />
              <Field
                label="Client Secret"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="длинная строка из букв и цифр"
                type="password"
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            {result ? (
              <div className={[s.result, s[result.kind]].filter(Boolean).join(' ')}>
                {result.kind === 'ok' ? '✓ Ключ работает' : result.message}
              </div>
            ) : null}

            <div className={s.actions}>
              <Button
                className={result?.kind === 'ok' ? s.checkOk : undefined}
                disabled={!filled || checking}
                onClick={() => void check()}
              >
                {checking ? 'Проверяю…' : result?.kind === 'ok' ? '✓ Работает' : 'Проверить'}
              </Button>
              <Button variant="primary" disabled={!credsOk} onClick={() => setStep(3)}>
                Дальше
              </Button>
              <Button disabled={checking} onClick={() => setStep(3)}>
                Потом — работать без интернета
              </Button>
            </div>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <h1 className={s.h1}>Карты</h1>
            <p className={s.lead}>
              Библиотека — запас, из которого катаются маппулы. Вставь ссылки на карты с osu!:
              каждая станет строкой с обложкой, звёздами и мод-тегами.
            </p>

            {!credsOk ? (
              <div className={s.warn}>
                Без ключа osu! карты не загрузятся. Вернись на шаг назад или добавь ключ позже
                в настройках — шаг можно и просто пропустить.
              </div>
            ) : null}

            <Area
              label="Ссылки на карты"
              value={linksText}
              onChange={setLinksText}
              placeholder={LINKS_PLACEHOLDER}
              rows={7}
            />

            {found ? (
              <div className={s.found}>
                {total === 0 ? (
                  <span className={s.dim}>Ссылок на карты пока не видно</span>
                ) : (
                  <span className={s.ok}>Нашлось {maps(total)}</span>
                )}
              </div>
            ) : null}

            {importing ? (
              <div className={s.progress}>
                <div className={s.bar}>
                  <div
                    className={s.fill}
                    style={{
                      width: `${
                        importing.total > 0 ? (importing.done / importing.total) * 100 : 0
                      }%`,
                    }}
                  />
                </div>
                <div className={s.stat}>
                  {importDone
                    ? `Готово: добавлено ${importing.added}, пропущено как дубли ${importing.skipped}`
                    : `${stageName(importing.stage)} — ${importing.done} из ${importing.total}`}
                </div>
              </div>
            ) : null}

            <div className={s.actions}>
              {importDone ? (
                <Button variant="primary" onClick={() => setStep(4)}>
                  Дальше
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={total === 0 || running}
                  onClick={() => {
                    if (found !== null) void startImport(found);
                  }}
                >
                  {running ? 'Загружаю…' : total > 0 ? `Загрузить ${maps(total)}` : 'Загрузить'}
                </Button>
              )}
              <Button onClick={() => setStep(4)}>Пропустить этот шаг</Button>
            </div>
          </>
        ) : null}

        {step === 4 ? (
          <>
            <h1 className={s.h1}>Маппул</h1>
            <p className={s.lead}>
              Маппул — карты, из которых играются матчи. Выбери шаблон и скатай: подходящие
              карты подберутся сами, слоты уже расставлены по модам.
            </p>

            {templates === null && poolError === null ? (
              <p className={s.dim}>Читаю шаблоны…</p>
            ) : null}

            <div className={s.templates}>
              {(templates ?? []).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={[s.tpl, t.id === templateId ? s.tplOn : null]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => {
                    setTemplateId(t.id);
                    // Смена шаблона обнуляет скатанное — катать заново.
                    setPool(null);
                  }}
                >
                  <span className={s.tplName}>{t.name}</span>
                  <span className={s.tplShape}>{templateShape(t)}</span>
                  <span className={s.tplSize}>{maps(templateSize(t))}</span>
                </button>
              ))}
            </div>

            {pool !== null ? (
              <div className={s.summary}>
                <span className={s.ok}>Скатано {maps(poolMaps)}</span>
                <span className={s.dim}>
                  {poolMaps === 0
                    ? 'библиотека пуста — добавь карты на прошлом шаге, пул дошьётся позже'
                    : `«${pool.pool.name}» уже готов играть в матчах`}
                </span>
              </div>
            ) : null}

            {poolError !== null ? <div className={s.error}>{poolError}</div> : null}

            <div className={s.actions}>
              {pool !== null ? (
                <Button variant="primary" onClick={() => setStep(5)}>
                  Дальше
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={templateId === null || rolling}
                  onClick={() => void rollPool()}
                >
                  {rolling ? 'Скатываю…' : 'Скатать маппул'}
                </Button>
              )}
              <Button onClick={() => setStep(5)}>Пропустить этот шаг</Button>
            </div>
          </>
        ) : null}

        {step === 5 ? (
          <>
            <h1 className={s.h1}>Игроки</h1>
            <p className={s.lead}>
              Впиши тех, кто играет сегодня, — по нику на строку, минимум два. Игроки
              сохранятся в общий список, а из них соберётся сетка первого турнира.
            </p>

            {tournamentId === null ? (
              <div onBlur={() => void savePlayers()}>
                <Area
                  label="Ники игроков"
                  value={playersText}
                  onChange={setPlayersText}
                  placeholder={'NAGISA\nKIRA\nYUKI'}
                  rows={7}
                />
                <div className={s.count}>
                  {playerIds.length > 0
                    ? `${playerIds.length} ${plural(playerIds.length, 'игрок', 'игрока', 'игроков')}`
                    : 'нужно минимум два'}
                  {nicknames.length > playerIds.length
                    ? ' — остальные создадутся при сборке'
                    : ''}
                </div>
              </div>
            ) : (
              <div className={s.summary}>
                <span className={s.ok}>Турнир собран</span>
                <span className={s.dim}>«Первый турнир» — сетка уже построена</span>
              </div>
            )}

            {buildError !== null ? <div className={s.error}>{buildError}</div> : null}

            <div className={s.actions}>
              {tournamentId === null ? (
                <Button
                  variant="primary"
                  disabled={nicknames.length < 2 || building || playersBusy}
                  onClick={() => void buildTournament()}
                >
                  {building ? 'Собираю…' : 'Собрать турнир'}
                </Button>
              ) : (
                <Button variant="primary" onClick={() => setStep(6)}>
                  Дальше
                </Button>
              )}
              <Button disabled={building} onClick={() => setStep(6)}>
                Пропустить этот шаг
              </Button>
            </div>
          </>
        ) : null}

        {step === 6 ? (
          <>
            <h1 className={s.h1}>
              {tournamentId !== null ? 'Сетка готова' : 'Всё готово'}
            </h1>
            <p className={s.lead}>
              {tournamentId !== null
                ? `«Первый турнир»: ${
                    playerIds.length
                  } ${plural(playerIds.length, 'игрок', 'игрока', 'игроков')}${
                    pool !== null ? ' и маппул' : ''
                  }. Посмотри сетку — запускать её будешь уже там.`
                : 'Первый турнир можно собрать в любой момент в разделе «Турниры».'}
            </p>
            <div className={s.actions}>
              {tournamentId !== null ? (
                <>
                  <Button variant="primary" onClick={() => void leave(tournamentId)}>
                    Открыть турнир
                  </Button>
                  <Button onClick={() => void leave()}>К списку турниров</Button>
                </>
              ) : (
                <Button variant="primary" onClick={() => void leave()}>
                  К списку турниров
                </Button>
              )}
            </div>
          </>
        ) : null}

        <div className={s.nav}>
          {step > 1 ? (
            <Button size="sm" onClick={() => setStep(step - 1)}>
              ← Назад
            </Button>
          ) : (
            <span />
          )}
          <div className={s.dots} aria-hidden>
            {Array.from({ length: STEP_COUNT }, (_, i) => (
              <span
                key={i}
                className={[
                  s.dot,
                  i + 1 === step ? s.dotNow : null,
                  i + 1 < step ? s.dotDone : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
              />
            ))}
          </div>
          <span className={s.stepNum}>
            {step} из {STEP_COUNT}
          </span>
        </div>
      </div>
    </div>
  );
}
