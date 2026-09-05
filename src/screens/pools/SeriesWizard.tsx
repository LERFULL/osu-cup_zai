import { useEffect, useState } from 'react';
import { Button, Modal } from '@/components';
import type { GenNote, PoolTemplate, SeriesKind, Tournament } from '@/lib/types';
import { templateSize } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import s from './SeriesWizard.module.css';

interface Props {
  templates: PoolTemplate[];
  onClose: () => void;
  /** Готово: серия создана. Возвращает её id и отчёт генерации, если была. */
  onDone: (seriesId: number, notes: GenNote[]) => void;
}

/**
 * Диалог «Создать серию». Имя, тип, турнир и — при желании — шаблон,
 * по которому серия накатывается сразу. Всё в одном месте, без цепочки
 * window.prompt: серия — самое частое действие раздела, и начинать его
 * нужно одним понятным окном.
 */
export function SeriesWizard({ templates, onClose, onDone }: Props) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SeriesKind>('tournament');
  const [tournamentId, setTournamentId] = useState<number | null>(null);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [count, setCount] = useState('4');
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ipc
      .listTournaments()
      .then(setTournaments)
      .catch(() => setTournaments([]));
  }, []);

  const template = templates.find((t) => t.id === templateId) ?? null;

  async function create() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const trimmed = name.trim();
      if (template !== null) {
        // Серия по шаблону: генерируем пулы сразу и привязываем турнир.
        const n = Math.floor(Number(count.trim()));
        if (!Number.isFinite(n) || n < 1 || n > 24) {
          setError('Число маппулов — от 1 до 24');
          return;
        }
        const reports = await ipc.generateSeries(template.id, trimmed === '' ? template.name : trimmed, n);
        const first = reports[0];
        const seriesId = first?.pool.seriesId ?? null;
        if (seriesId !== null && tournamentId !== null) {
          await ipc.setSeriesTournament(seriesId, tournamentId);
          // Маппулы серии сразу уезжают в турнир по раундам.
          await ipc.addTournamentSeries(tournamentId, seriesId).catch(() => undefined);
        }
        onClose();
        if (seriesId !== null) onDone(seriesId, reports.flatMap((r) => r.notes));
        return;
      }

      const made = await ipc.createSeries(trimmed === '' ? 'Новая серия' : trimmed, kind);
      if (tournamentId !== null) {
        await ipc.setSeriesTournament(made.id, tournamentId);
        await ipc.addTournamentSeries(tournamentId, made.id).catch(() => undefined);
      }
      onClose();
      onDone(made.id, []);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ''));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Создать серию"
      note="Серия — набор маппулов под один турнир: по одному на раунд, карты между ними не повторяются."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" onClick={() => void create()} disabled={busy}>
            {template !== null ? `Создать ${count || '…'} маппул(ов)` : 'Создать серию'}
          </Button>
        </>
      }
    >
      <div className={s.form}>
        <label className={s.field}>
          <span className={s.label}>Название</span>
          <input
            className={s.input}
            value={name}
            autoFocus
            placeholder={template !== null ? template.name : 'Осень 2026'}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
            }}
          />
        </label>

        <div className={s.field}>
          <span className={s.label}>Тип</span>
          <div className={s.kinds}>
            <button
              className={[s.kind, kind === 'tournament' ? s.kindOn : null].filter(Boolean).join(' ')}
              onClick={() => setKind('tournament')}
              type="button"
            >
              Турнирная
              <span className={s.kindNote}>карты внутри не повторяются</span>
            </button>
            <button
              className={[s.kind, kind === 'free' ? s.kindOn : null].filter(Boolean).join(' ')}
              onClick={() => setKind('free')}
              type="button"
            >
              Свободная
              <span className={s.kindNote}>просто папка для пулов</span>
            </button>
          </div>
        </div>

        <label className={s.field}>
          <span className={s.label}>Турнир</span>
          <select
            className={s.input}
            value={tournamentId ?? ''}
            onChange={(e) => setTournamentId(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">— пока без турнира —</option>
            {tournaments.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <span className={s.hint}>Привязку можно задать и позже, в самой серии.</span>
        </label>

        <label className={s.field}>
          <span className={s.label}>Шаблон (необязательно)</span>
          <select
            className={s.input}
            value={templateId ?? ''}
            onChange={(e) => setTemplateId(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">— собрать маппулы позже —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({templateSize(t)} слотов)
              </option>
            ))}
          </select>
        </label>

        {template !== null ? (
          <label className={s.field}>
            <span className={s.label}>Сколько маппулов</span>
            <input
              className={s.input}
              value={count}
              inputMode="numeric"
              onChange={(e) => setCount(e.target.value)}
            />
            <span className={s.hint}>По одному на раунд — карты между ними не повторятся.</span>
          </label>
        ) : null}

        {error !== null ? <div className={s.error}>{error}</div> : null}
      </div>
    </Modal>
  );
}
