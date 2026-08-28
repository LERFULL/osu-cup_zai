import { useApp } from '@/store/app';
import type { ImportProgress } from '@/lib/types';
import s from './ImportCard.module.css';

/** Что происходит с загрузкой прямо сейчас. */
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

/**
 * Очередь загрузок — в рейле, над «Настройками».
 *
 * Поставил пачки на скачку и ушёл в маппулы или турниры: карточка едет
 * следом и показывает, докачалось ли, а сколько пачек ещё ждёт — цифрой.
 * Клик ведёт в раздел «Загрузки».
 */
export function ImportCard() {
  const { importing, queue, dismissImport, go } = useApp();

  const queued = queue.filter((b) => b.status === 'queued').length;
  if (importing === null && queued === 0) return null;

  // Живой прогресс приходит событием; в очереди он же лежит в записи пачки.
  const active = importing ?? queue.find((b) => b.status === 'running') ?? null;
  const stage = active?.stage;
  const status = active !== null && 'status' in active ? active.status : null;
  const done = stage === 'done' || status === 'done';
  const cancelled = stage === 'cancelled' || status === 'cancelled';
  const failed = stage === 'failed' || status === 'failed';

  const total = active?.total ?? 0;
  const percent = total > 0 ? Math.round(((active?.done ?? 0) / total) * 100) : 0;

  const head = done
    ? 'Карты добавлены'
    : failed
      ? 'Загрузка не удалась'
      : cancelled
        ? 'Отменено'
        : 'Загрузка карт';

  return (
    <div
      className={[s.card, done ? s.done : null].filter(Boolean).join(' ')}
      onClick={() => go('downloads')}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') go('downloads');
      }}
    >
      <div className={s.head}>
        <span className={s.title}>{head}</span>
        <button
          className={s.x}
          type="button"
          aria-label="Скрыть"
          onClick={(e) => {
            e.stopPropagation();
            dismissImport();
          }}
          title={done ? 'Скрыть' : 'Скрыть — загрузка продолжится'}
        >
          ✕
        </button>
      </div>

      {active !== null && !done && !cancelled && !failed ? (
        <div className={s.bar}>
          <div className={s.fill} style={{ width: `${percent}%` }} />
        </div>
      ) : null}

      <div className={s.stat}>
        {active !== null
          ? done
            ? `Добавлено ${active.added}${active.skipped > 0 ? `, дублей ${active.skipped}` : ''}`
            : `${stageName(active.stage)} — ${active.done} из ${total}`
          : null}
        {queued > 0 ? (
          <span className={s.queued}>{queued} в очереди</span>
        ) : null}
      </div>

      {active !== null && active.failed.length > 0 && !done ? (
        <div className={s.failed}>не загрузилось: {active.failed.length}</div>
      ) : null}
    </div>
  );
}
