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
    case 'done':
      return 'Готово';
    default:
      return 'В очереди';
  }
}

/**
 * Идущая загрузка по ссылкам — в рейле, над «Настройками».
 *
 * Поставил карты на скачку и ушёл в маппулы или турниры: карточка едет
 * следом и показывает, докачалось ли. Без неё за загрузкой можно было
 * следить, только не уходя с экрана библиотеки.
 */
export function ImportCard() {
  const { importing, dismissImport, go } = useApp();
  if (importing === null) return null;

  const p = importing;
  const done = p.stage === 'done';
  const cancelled = p.stage === 'cancelled';
  const percent = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;

  return (
    <div className={[s.card, done ? s.done : null].filter(Boolean).join(' ')}>
      <div className={s.head}>
        <span className={s.title}>{done ? 'Карты добавлены' : 'Загрузка карт'}</span>
        <button
          className={s.x}
          type="button"
          aria-label="Скрыть"
          onClick={dismissImport}
          title={done ? 'Скрыть' : 'Скрыть — загрузка продолжится'}
        >
          ✕
        </button>
      </div>

      {!done && !cancelled ? (
        <div className={s.bar}>
          <div className={s.fill} style={{ width: `${percent}%` }} />
        </div>
      ) : null}

      <div className={s.stat}>
        {done
          ? `Добавлено ${p.added}${p.skipped > 0 ? `, дублей ${p.skipped}` : ''}`
          : `${stageName(p.stage)} — ${p.done} из ${p.total}`}
      </div>

      {p.failed.length > 0 ? (
        <div className={s.failed}>не загрузилось: {p.failed.length}</div>
      ) : null}

      {done ? (
        <button
          className={s.go}
          type="button"
          onClick={() => {
            dismissImport();
            go('library');
          }}
        >
          Показать в библиотеке
        </button>
      ) : null}
    </div>
  );
}
