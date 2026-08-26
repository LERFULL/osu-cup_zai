// История: завершённые турниры. Список со сводками, детальный вид с сеткой
// и летописью матчей, перенос турнира и базы между компьютерами.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, Button, Empty } from '@/components';
import * as ipc from '@/lib/ipc';
import { isTauri } from '@/lib/host';
import { money, plural } from '@/lib/format';
import type { HistoryDetail, HistorySummary, MatchLogView } from '@/lib/types';
import { BracketView } from '@/screens/tournaments/BracketView';
import s from './History.module.css';

/** Дата из базы: «2026-02-10 18:00:05» или ISO — обе одинаково читаются. */
function formatDate(raw: string | null): string {
  if (raw === null) return '';
  const t = new Date(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(t.getTime())) return '';
  return t.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Файл базы в base64 — в таком виде его принимает Rust. */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result as ArrayBuffer);
      let binary = '';
      // String.fromCharCode не берёт больше ~32k аргументов — режем пачками.
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      resolve(btoa(binary));
    };
    reader.onerror = () => reject(reader.error ?? new Error('файл не прочитался'));
    reader.readAsArrayBuffer(file);
  });
}

/** Скачивает строку как файл: файлового диалога у окна нет, Blob решает. */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function History() {
  const [items, setItems] = useState<HistorySummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Путь к выгруженной базе: показать в папке можно только по нему. */
  const [dbPath, setDbPath] = useState<string | null>(null);

  const importInput = useRef<HTMLInputElement>(null);
  const baseInput = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      setItems(await ipc.historyList());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // ─────────────────────────────────────────────── детальный вид

  useEffect(() => {
    if (openId === null) {
      setDetail(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const d = await ipc.historyDetail(openId);
        if (alive) {
          setDetail(d);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [openId]);

  if (openId !== null && detail !== null) {
    return (
      <DetailView
        detail={detail}
        onBack={() => {
          setOpenId(null);
          void reload();
        }}
      />
    );
  }

  // ─────────────────────────────────────────────── список

  async function importTournament(file: File): Promise<void> {
    try {
      setBusy(true);
      const json = await file.text();
      await ipc.importTournament(json);
      await reload();
      setNote('Турнир импортирован');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function importDatabase(file: File): Promise<void> {
    try {
      setBusy(true);
      await ipc.importDatabase(await toBase64(file));
      await reload();
      setNote('База заменена — остальные экраны перечитают её при открытии');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function exportDatabase(): Promise<void> {
    try {
      setBusy(true);
      const path = await ipc.exportDatabase();
      setDbPath(path);
      setNote(`Копия базы: ${path}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function backup(): Promise<void> {
    try {
      setBusy(true);
      const name = await ipc.backupDatabase();
      setNote(`Бэкап создан: ${name}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function restore(name: string): Promise<void> {
    if (!window.confirm(`Вернуть базу из бэкапа ${name}? Всё, что сделано после него, пропадёт.`)) {
      return;
    }
    try {
      setBusy(true);
      await ipc.restoreBackup(name);
      await reload();
      setNote(`База восстановлена из ${name}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function revealDatabase(path: string): Promise<void> {
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(path);
    } catch (e) {
      setError(String(e));
    }
  }

  const card = (t: HistorySummary) => (
    <div
      key={t.id}
      className={s.card}
      onClick={() => setOpenId(t.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') setOpenId(t.id);
      }}
      role="button"
      tabIndex={0}
    >
      <div className={s.cardTop}>
        <div className={s.name}>{t.name}</div>
        <div className={s.date}>{formatDate(t.finishedAt)}</div>
      </div>

      <div className={s.podium}>
        {t.podium.map((p, i) => (
          <div key={p.playerId} className={i === 0 ? s.stepFirst : s.step}>
            <span className={s.place}>{i + 1}</span>
            <Avatar nickname={p.nickname} color={p.color} size={i === 0 ? 30 : 24} />
            <span className={i === 0 ? s.championNick : s.stepNick}>{p.nickname}</span>
          </div>
        ))}
      </div>

      <div className={s.cardMeta}>
        {t.finalMatch !== null ? (
          <span className={s.finalScore}>
            <span style={{ color: t.finalMatch.colorA }}>{t.finalMatch.nickA}</span>
            <span className={s.score}>
              {t.finalMatch.scoreA}:{t.finalMatch.scoreB}
            </span>
            <span style={{ color: t.finalMatch.colorB }}>{t.finalMatch.nickB}</span>
            {t.finalMatch.isWalkover ? <span className={s.tag}>без игры</span> : null}
          </span>
        ) : null}
        {t.prizeFund !== null ? <span className={s.fund}>{money(t.prizeFund)}</span> : null}
        <span className={s.shape}>
          {t.playerCount} {plural(t.playerCount, 'игрок', 'игрока', 'игроков')}
        </span>
      </div>

      {t.notes.length > 0 ? <div className={s.notes}>{t.notes.join(' · ')}</div> : null}
    </div>
  );

  return (
    <div className={s.screen}>
      <header className={s.bar}>
        <h1 className={s.h1}>История</h1>
        <div className={s.right}>
          <Button disabled={busy} onClick={() => importInput.current?.click()}>
            Импорт турнира
          </Button>
        </div>
      </header>

      {error !== null ? <div className={s.error}>{error}</div> : null}
      {note !== null ? <div className={s.note}>{note}</div> : null}

      <input
        ref={importInput}
        className={s.hiddenInput}
        type="file"
        accept="application/json"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file !== undefined) void importTournament(file);
        }}
      />
      <input
        ref={baseInput}
        className={s.hiddenInput}
        type="file"
        accept=".db,application/octet-stream"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file !== undefined) void importDatabase(file);
        }}
      />

      <div className={s.body}>
        <div className={s.col}>
          {items.length === 0 ? (
            <Empty
              title="Здесь пока пусто"
              note="Заверши первый турнир — или перенеси готовый файлом с другого компьютера."
              actions={
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => importInput.current?.click()}
                >
                  Импорт турнира
                </Button>
              }
            />
          ) : (
            items.map(card)
          )}

          <DataBaseCard
            busy={busy}
            dbPath={dbPath}
            canReveal={isTauri()}
            onReveal={() => void revealDatabase(dbPath as string)}
            onExport={() => void exportDatabase()}
            onImport={() => baseInput.current?.click()}
            onBackup={() => void backup()}
            onRestore={(name) => void restore(name)}
          />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── деталь

function DetailView({
  detail,
  onBack,
}: {
  detail: HistoryDetail;
  onBack: () => void;
}) {
  const [openMatch, setOpenMatch] = useState<number | null>(null);
  const [exported, setExported] = useState(false);

  async function exportJson(): Promise<void> {
    const json = await ipc.exportTournament(detail.bracket.id);
    download(`${detail.bracket.name}.json`, json);
    setExported(true);
  }

  return (
    <div className={s.screen}>
      <header className={s.bar}>
        <Button size="sm" onClick={onBack}>
          ← История
        </Button>
        <h1 className={s.h1}>{detail.bracket.name}</h1>
        <span className={s.date}>{formatDate(detail.bracket.finishedAt)}</span>
        <div className={s.right}>
          <Button size="sm" onClick={() => void exportJson()} aria-disabled={exported}>
            {exported ? 'Скачан' : 'Экспорт'}
          </Button>
        </div>
      </header>

      <div className={s.body}>
        <div className={s.col}>
          <BracketView bracket={detail.bracket} onOpenMatch={(id) => setOpenMatch(id)} />

          <div className={s.logHead}>Все матчи</div>
          <div className={s.log}>
            {detail.matches.map((m) => (
              <MatchRow
                key={m.id}
                match={m}
                open={openMatch === m.id}
                onToggle={() => setOpenMatch(openMatch === m.id ? null : m.id)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Строка летописи: раунд, кто с кем, счёт; раскрывается в покартовый список. */
function MatchRow({
  match,
  open,
  onToggle,
}: {
  match: MatchLogView;
  open: boolean;
  onToggle: () => void;
}) {
  const maps = match.maps;
  return (
    <div className={s.matchRow}>
      <button
        className={s.matchLine}
        type="button"
        onClick={maps.length > 0 ? onToggle : undefined}
        aria-disabled={maps.length === 0}
      >
        <span className={s.matchTitle}>{match.title}</span>
        <span className={s.matchPlayers}>
          <span style={{ color: match.colorA ?? undefined }}>{match.nickA ?? '—'}</span>
          <span className={s.score}>
            {match.scoreA}:{match.scoreB}
          </span>
          <span style={{ color: match.colorB ?? undefined }}>{match.nickB ?? '—'}</span>
        </span>
        <span className={s.matchTags}>
          {match.isWalkover ? <span className={s.tag}>без игры</span> : null}
          {maps.length > 0 ? (
            <span className={s.chevron} aria-hidden>
              {open ? '▾' : '▸'}
            </span>
          ) : null}
        </span>
      </button>

      {open && maps.length > 0 ? (
        <div className={s.maps}>
          {maps.map((map) => (
            <div key={map.n} className={s.mapRow}>
              <span className={s.mapSlot}>{map.slotLabel}</span>
              <span className={s.mapDot} style={{ background: map.winnerColor ?? 'var(--txt3)' }} />
              <span className={s.mapWinner}>
                {map.winnerNick !== null ? ` победил ${map.winnerNick}` : ' без победителя'}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────── перенос всей базы

/** Перенос базы: экспорт в папку данных, импорт файлом, бэкапы. */
function DataBaseCard({
  busy,
  dbPath,
  canReveal,
  onReveal,
  onExport,
  onImport,
  onBackup,
  onRestore,
}: {
  busy: boolean;
  /** Путь к последней выгрузке — по нему открывается папка. */
  dbPath: string | null;
  canReveal: boolean;
  onReveal: () => void;
  onExport: () => void;
  onImport: () => void;
  onBackup: () => void;
  onRestore: (name: string) => void;
}) {
  const [backups, setBackups] = useState<string[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        setBackups(await ipc.listBackups());
      } catch {
        setBackups([]);
      }
    })();
  }, [busy]);

  return (
    <div className={s.db}>
      <div className={s.dbTitle}>Перенос между компьютерами</div>
      <div className={s.dbNote}>
        Турнир — файлом JSON, вся база — одним файлом. Бэкапы лежат в папке данных
        приложения.
      </div>
      <div className={s.dbActions}>
        <Button size="sm" disabled={busy} onClick={onExport}>
          Экспорт базы
        </Button>
        <Button size="sm" disabled={busy} onClick={onImport}>
          Импорт базы
        </Button>
        <Button size="sm" disabled={busy} onClick={onBackup}>
          Сделать бэкап
        </Button>
      </div>

      {dbPath !== null ? (
        <div className={s.dbPath}>
          <span className={s.dbPathText}>{dbPath}</span>
          {canReveal ? (
            <Button size="sm" onClick={onReveal}>
              Открыть папку
            </Button>
          ) : null}
        </div>
      ) : null}

      {backups.length > 0 ? (
        <div className={s.backups}>
          {backups.map((name) => (
            <div key={name} className={s.backupRow}>
              <span className={s.backupName}>{name}</span>
              <Button size="sm" disabled={busy} onClick={() => onRestore(name)}>
                Восстановить
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
