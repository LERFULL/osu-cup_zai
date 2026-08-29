import { useEffect, useMemo, useState } from 'react';
import { Area, Button, Chip, Empty, Field } from '@/components';
import { MOD_TAGS, type ImportBatch, type ModTag, type ParsedLinks } from '@/lib/types';
import { maps } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import { useApp } from '@/store/app';
import s from './Downloads.module.css';

const PLACEHOLDER = `Вставь сюда что угодно — чат из Discord, список из блокнота, JSON.
Ссылки найдутся сами:

https://osu.ppy.sh/beatmapsets/1084284#osu/2271897
osu.ppy.sh/b/2271897
https://osu.ppy.sh/beatmapsets/1084284`;

/** Как называется то, что происходит с пачкой прямо сейчас. */
function stageName(stage: ImportBatch['stage']): string {
  switch (stage) {
    case 'fetching':
      return 'Тяну с osu!';
    case 'skillsets':
      return 'Считаю скилсеты';
    case 'covers':
      return 'Качаю обложки';
    case 'saving':
      return 'Сохраняю';
    case 'cancelled':
      return 'Отменено';
    case 'failed':
      return 'Ошибка';
    case 'done':
      return 'Готово';
    default:
      return 'В очереди';
  }
}

function fmtTime(iso: string | null): string {
  if (iso === null || iso === '') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function Downloads() {
  const { queue, addToQueue, refreshQueue, refreshCollections, go } = useApp();

  // Форма новой пачки.
  const [text, setText] = useState('');
  const [found, setFound] = useState<ParsedLinks | null>(null);
  const [mods, setMods] = useState<ModTag[]>(['NM']);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Разбор идёт на каждое изменение — он не ходит в сеть и стоит копейки.
  useEffect(() => {
    if (text.trim() === '') {
      setFound(null);
      return;
    }
    let alive = true;
    void ipc.parseLinks(text).then((p) => {
      if (alive) setFound(p);
    });
    return () => {
      alive = false;
    };
  }, [text]);

  // Список мог измениться, пока пользователь сидел в другом разделе:
  // на входе на экран его освежать не помешает.
  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);

  const total = found ? found.beatmapIds.length + found.beatmapsetIds.length : 0;

  /** Ждущие и идущие — сверху, закончившиеся — снизу. Порядок даёт бэкенд. */
  const pending = useMemo(
    () => queue.filter((b) => b.status === 'queued' || b.status === 'running'),
    [queue],
  );
  const finished = useMemo(
    () => queue.filter((b) => b.status !== 'queued' && b.status !== 'running'),
    [queue],
  );

  function toggleMod(m: ModTag) {
    setMods((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  }

  async function add() {
    if (!found || total === 0) return;
    setAdding(true);
    setError(null);
    try {
      await addToQueue(found, mods);
      // Форма очищается, а пачка уезжает в очередь ниже.
      setText('');
      setFound(null);
      setName('');
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  }

  async function cancel(b: ImportBatch) {
    setError(null);
    try {
      await ipc.downloadQueueCancel(b.batchId);
      await refreshQueue();
    } catch (e) {
      setError(String(e));
    }
  }

  async function retry(b: ImportBatch) {
    setError(null);
    try {
      await ipc.downloadQueueRetry(b.batchId);
      await refreshQueue();
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove(b: ImportBatch) {
    setError(null);
    try {
      await ipc.downloadQueueRemove(b.batchId);
      await refreshQueue();
    } catch (e) {
      setError(String(e));
    }
  }

  async function clearFinished() {
    setError(null);
    try {
      await ipc.downloadQueueClear();
      await refreshQueue();
    } catch (e) {
      setError(String(e));
    }
  }

  async function showLibrary() {
    await refreshCollections();
    go('library');
  }

  return (
    <div className={s.screen}>
      <div className={s.bar}>
        <h1 className={s.h1}>Загрузки</h1>
        <div className={s.right}>
          {finished.length > 0 ? (
            <Button size="sm" onClick={() => void clearFinished()}>
              Очистить готовые
            </Button>
          ) : null}
        </div>
      </div>

      {error !== null && <div className={s.error}>{error}</div>}

      <div className={s.body}>
        <div className={s.cols}>
          <section className={s.form}>
            <div className={s.blockTitle}>Новая пачка</div>

            <Area
              label="Ссылки на карты"
              value={text}
              onChange={setText}
              placeholder={PLACEHOLDER}
              rows={8}
            />

            {found ? (
              <div className={s.found}>
                {total === 0 ? (
                  <span className={s.none}>Ссылок на карты пока не видно</span>
                ) : (
                  <>
                    <span className={s.ok}>Нашлось {maps(total)}</span>
                    {found.beatmapsetIds.length > 0 ? (
                      <span className={s.note}>
                        из них наборов: {found.beatmapsetIds.length} — из каждого добавятся все
                        сложности
                      </span>
                    ) : null}
                    {found.unknown.length > 0 ? (
                      <span className={s.note}>не распознано ссылок: {found.unknown.length}</span>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}

            <div className={s.mods}>
              <span className={s.label}>Мод-теги пачки</span>
              <div className={s.chips}>
                {MOD_TAGS.map((m) => (
                  <Chip key={m} active={mods.includes(m)} onClick={() => toggleMod(m)}>
                    {m}
                  </Chip>
                ))}
              </div>
              <span className={s.hint}>
                Встанут автоматически на все карты пачки — хоть на сорок ссылок сразу, руками
                ничего размечать не придётся. Карты появятся в библиотеке, только когда пачка
                скачается целиком.
              </span>
            </div>

            <Field
              label="Название (необязательно)"
              placeholder="Например: NM-пачка на вечер"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
            />

            <div className={s.actions}>
              <Button
                variant="primary"
                disabled={total === 0 || adding}
                onClick={() => void add()}
              >
                {adding ? 'Ставлю…' : `В очередь${total > 0 ? ` — ${maps(total)}` : ''}`}
              </Button>
            </div>
          </section>

          <section className={s.list}>
            <div className={s.blockTitle}>Очередь</div>

            {queue.length === 0 ? (
              <div className={s.empty}>
                <Empty
                  title="Очередь пуста"
                  note="Вставь ссылки слева, выбери мод-теги и отправь пачку. Скачивается одна за одной, карты доезжают в библиотеку только целиком."
                />
              </div>
            ) : (
              <>
                {pending.map((b) => (
                  <BatchCard key={b.batchId} batch={b} onCancel={cancel} />
                ))}
                {finished.map((b) => (
                  <BatchCard
                    key={b.batchId}
                    batch={b}
                    onRetry={retry}
                    onRemove={remove}
                    onShow={showLibrary}
                  />
                ))}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

interface CardProps {
  batch: ImportBatch;
  onCancel?: (b: ImportBatch) => void | Promise<void>;
  onRetry?: (b: ImportBatch) => void | Promise<void>;
  onRemove?: (b: ImportBatch) => void | Promise<void>;
  onShow?: () => void | Promise<void>;
}

/** Одна пачка очереди: статус, прогресс и действия над ней. */
function BatchCard({ batch, onCancel, onRetry, onRemove, onShow }: CardProps) {
  const b = batch;
  const running = b.status === 'running';
  const active = running || b.status === 'queued';
  const done = b.status === 'done';
  const failed = b.status === 'failed';
  const cancelled = b.status === 'cancelled';

  const percent = b.total > 0 ? Math.round((b.done / b.total) * 100) : 0;

  const status = done
    ? 'Готово'
    : failed
      ? 'Ошибка'
      : cancelled
        ? 'Отменено'
        : stageName(b.stage);

  const statusClass = done
    ? s.statusDone
    : failed
      ? s.statusFailed
      : cancelled
        ? s.statusCancelled
        : s.statusActive;

  return (
    <div
      className={[
        s.card,
        running ? s.cardRunning : null,
        done ? s.cardDone : null,
        failed ? s.cardFailed : null,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className={s.head}>
        <span className={s.name}>{b.name !== '' ? b.name : 'Пачка'}</span>
        <span className={[s.status, statusClass].join(' ')}>{status}</span>
      </div>

      <div className={s.meta}>
        {b.mods.length > 0 ? (
          <div className={s.modChips}>
            {b.mods.map((m) => (
              <span key={m} className={s.modChip} data-mod={m.toLowerCase()}>
                {m}
              </span>
            ))}
          </div>
        ) : (
          <span className={s.noMods}>без авто-тегов</span>
        )}
        <span className={s.when}>{fmtTime(b.startedAt ?? b.createdAt)}</span>
      </div>

      {active && !done ? (
        <div className={s.progressWrap}>
          <div className={s.track}>
            <div className={s.fill} style={{ width: `${percent}%` }} />
          </div>
          <span className={s.count}>
            {b.done} из {b.total}
          </span>
        </div>
      ) : null}

      {done ? (
        <div className={s.result}>
          Добавлено {b.added}
          {b.skipped > 0 ? `, дублей ${b.skipped}` : ''}
        </div>
      ) : null}

      {b.failed.length > 0 ? (
        <div className={s.failedList}>
          {failed && b.failed.length > 0 && b.failed[0]?.ref === 'пачка' ? (
            <span className={s.failedAll}>{b.failed[0]?.reason}</span>
          ) : (
            <>Не загрузилось: {b.failed.length}</>
          )}
        </div>
      ) : null}

      <div className={s.cardActions}>
        {active ? (
          <Button size="sm" onClick={() => void onCancel?.(b)}>
            Отменить
          </Button>
        ) : null}
        {failed || cancelled ? (
          <Button size="sm" onClick={() => void onRetry?.(b)}>
            Повторить
          </Button>
        ) : null}
        {done ? (
          <Button size="sm" variant="primary" onClick={() => void onShow?.()}>
            Показать в библиотеке
          </Button>
        ) : null}
        {!active ? (
          <button
            className={s.x}
            type="button"
            aria-label="Убрать из списка"
            title="Убрать из списка"
            onClick={() => void onRemove?.(b)}
          >
            ✕
          </button>
        ) : null}
      </div>
    </div>
  );
}
