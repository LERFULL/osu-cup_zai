// Импорт маппула из JSON-файла: выбор файла, предпросмотр и подтверждение.
// Кнопка-триггер приходит снаружи: в списке пулов это кнопка, в редакторе —
// пункт меню «⋯», а диалог у них один и тот же.
import { useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components';
import type { PoolImportPreview, PoolImportResult } from '@/lib/types';
import { maps as mapsWord, plural } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import s from './ImportJson.module.css';

interface Props {
  /** Импорт прошёл: новый пул уже создан, экран сам решает, что с ним делать. */
  onImported: (result: PoolImportResult) => void;
  /** Триггер: кнопка или пункт меню, открывающие выбор файла. */
  children: (open: () => void) => ReactNode;
}

type Stage =
  | { kind: 'confirm'; json: string; preview: PoolImportPreview }
  | { kind: 'busy'; what: string }
  | { kind: 'error'; text: string }
  | null;

export function ImportJson({ onImported, children }: Props) {
  const file = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>(null);

  function pick() {
    setStage(null);
    file.current?.click();
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    // Сбрасываем выбор: иначе повторный выбор того же файла не вызовет change.
    const chosen = e.target.files?.[0] ?? null;
    e.target.value = '';
    if (chosen === null) return;

    try {
      const json = await chosen.text();
      const preview = await ipc.importPoolPreview(json);
      setStage({ kind: 'confirm', json, preview });
    } catch (err) {
      setStage({ kind: 'error', text: String(err) });
    }
  }

  async function confirmImport(json: string, saveMaps: boolean, what: string) {
    setStage({ kind: 'busy', what });
    try {
      const result = await ipc.importPool(json, saveMaps);
      setStage(null);
      onImported(result);
    } catch (err) {
      setStage({ kind: 'error', text: String(err) });
    }
  }

  return (
    <>
      {children(pick)}

      <input
        ref={file}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => void onFile(e)}
      />

      {stage !== null ? (
        <div className={s.veil} onClick={() => stage.kind !== 'busy' && setStage(null)}>
          <div className={s.card} onClick={(e) => e.stopPropagation()}>
            {stage.kind === 'confirm' ? (
              <>
                <div className={s.title}>Импорт маппула</div>
                <div className={s.pool}>{stage.preview.poolName}</div>

                <p className={s.text}>
                  {stage.preview.newMaps > 0 ? (
                    <>
                      В файле {mapsWord(stage.preview.knownMaps + stage.preview.newMaps)}, из них{' '}
                      <b>{stage.preview.newMaps}</b>{' '}
                      {plural(stage.preview.newMaps, 'новая', 'новые', 'новых')} — сохранить в
                      библиотеку?
                    </>
                  ) : (
                    <>Все {mapsWord(stage.preview.knownMaps)} из файла уже в библиотеке.</>
                  )}
                </p>

                {stage.preview.newMaps > 0 ? (
                  <p className={s.hint}>
                    Новые скачаются с osu! — нужен ключ. Без ключа и сети слоты с ними останутся
                    пустыми, остальной пул соберётся как есть.
                  </p>
                ) : null}

                <div className={s.actions}>
                  <Button
                    variant="primary"
                    onClick={() =>
                      void confirmImport(
                        stage.json,
                        stage.preview.newMaps > 0,
                        stage.preview.newMaps > 0 ? 'Тянем карты с osu!…' : 'Собираем пул…',
                      )
                    }
                  >
                    {stage.preview.newMaps > 0 ? 'Импортировать с картами' : 'Импортировать'}
                  </Button>

                  {stage.preview.newMaps > 0 ? (
                    <Button onClick={() => void confirmImport(stage.json, false, 'Собираем пул…')}>
                      Только пул
                    </Button>
                  ) : null}

                  <Button onClick={() => setStage(null)}>Отмена</Button>
                </div>
              </>
            ) : stage.kind === 'busy' ? (
              <>
                <div className={s.title}>Импорт маппула</div>
                <p className={s.text}>{stage.what}</p>
                <div className={s.actions}>
                  <Button disabled>Подожди…</Button>
                </div>
              </>
            ) : (
              <>
                <div className={s.title}>Импорт не удался</div>
                <p className={s.error}>{stage.text}</p>
                <div className={s.actions}>
                  <Button onClick={() => setStage(null)}>Закрыть</Button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
