import { useEffect, useRef, useState } from 'react';
import { Area, Button, Panel } from '@/components';
import * as ipc from '@/lib/ipc';
import { maps } from '@/lib/format';
import type { ImportProgress, ParsedLinks } from '@/lib/types';
import s from './Import.module.css';

interface Props {
  onClose: () => void;
  onDone: () => void;
}

const PLACEHOLDER = `Вставь сюда что угодно — чат из Discord, список из блокнота, JSON.
Ссылки найдутся сами:

https://osu.ppy.sh/beatmapsets/1084284#osu/2271897
osu.ppy.sh/b/2271897
https://osu.ppy.sh/beatmapsets/1084284`;

export function Import({ onClose, onDone }: Props) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<ParsedLinks | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const batch = useRef<string | null>(null);

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

  useEffect(() => {
    const un = ipc.onImportProgress((p) => {
      if (batch.current === null || p.batchId === batch.current) setProgress(p);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const total = found ? found.beatmapIds.length + found.beatmapsetIds.length : 0;
  const running = progress !== null && progress.stage !== 'done' && progress.stage !== 'cancelled';

  async function start() {
    if (!found || total === 0) return;
    batch.current = await ipc.importLinks(found);
  }

  const done = progress?.stage === 'done';

  return (
    <Panel title="Добавить по ссылкам" onClose={onClose}>
      <Area
        label="Ссылки"
        value={text}
        onChange={setText}
        placeholder={PLACEHOLDER}
        rows={10}
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
                  из них наборов: {found.beatmapsetIds.length} — из каждого добавятся все сложности
                </span>
              ) : null}
              {found.unknown.length > 0 ? (
                <span className={s.note}>не распознано ссылок: {found.unknown.length}</span>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {progress ? (
        <div className={s.progress}>
          <div className={s.bar}>
            <div
              className={s.fill}
              style={{
                width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%`,
              }}
            />
          </div>
          <div className={s.stat}>
            {done
              ? `Готово: добавлено ${progress.added}, пропущено как дубли ${progress.skipped}`
              : `${stageName(progress.stage)} — ${progress.done} из ${progress.total}`}
          </div>

          {progress.failed.length > 0 ? (
            <div className={s.failed}>
              Не удалось загрузить: {progress.failed.length}
              <ul>
                {progress.failed.slice(0, 5).map((f, i) => (
                  <li key={i}>
                    {f.ref} — {f.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={s.actions}>
        {done ? (
          <Button variant="primary" onClick={onDone}>
            Показать в библиотеке
          </Button>
        ) : (
          <Button variant="primary" disabled={total === 0 || running} onClick={() => void start()}>
            {running ? 'Загружаю…' : `Загрузить ${total > 0 ? maps(total) : ''}`}
          </Button>
        )}
      </div>
    </Panel>
  );
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
    case 'cancelled':
      return 'Отменено';
    case 'done':
      return 'Готово';
    default:
      return 'В очереди';
  }
}
