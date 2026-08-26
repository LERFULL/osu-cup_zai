import { useEffect, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button, Chip, Field } from '@/components';
import * as ipc from '@/lib/ipc';
import { POOL_FIELDS, type CredentialsCheck, type PoolField } from '@/lib/types';
import { colorAt } from '@/lib/colors';
import { useApp } from '@/store/app';
import s from './Settings.module.css';

const REGISTER_URL = 'https://osu.ppy.sh/home/account/edit#new-oauth-application';

/** Встроенный набор полей: он действует, пока настройка не задана. */
const BUILTIN_FIELDS: PoolField[] = ['stars', 'length', 'bpm'];

/** Подписи полей — те же, что в редакторе маппула. */
const FIELD_NAMES: Record<PoolField, string> = {
  stars: 'Звёзды',
  length: 'Длина',
  bpm: 'BPM',
  ar: 'AR',
  od: 'OD',
  cs: 'CS',
  hp: 'HP',
  mapper: 'Маппер',
  skillsets: 'Скилсеты',
};

/** Стандартная восьмёрка цветов — та же, что в базе. */
const STANDARD_PALETTE: string[] = Array.from({ length: 8 }, (_, n) => colorAt(n));

/** Сообщение об ошибке IPC — текстом, а не «Error: …». */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function Settings() {
  const status = useApp((st) => st.status);

  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CredentialsCheck | null>(null);
  const [cacheMb, setCacheMb] = useState<number | null>(null);

  // Поля строки карты по умолчанию (для новых маппулов).
  const [fields, setFields] = useState<PoolField[]>(BUILTIN_FIELDS);
  const [fieldsNote, setFieldsNote] = useState<string | null>(null);

  // Палитра игроков.
  const [palette, setPalette] = useState<string[]>(STANDARD_PALETTE);
  const [paletteNote, setPaletteNote] = useState<string | null>(null);

  // Язык.
  const [lang, setLang] = useState('ru');

  // Резервные копии и автобэкап.
  const [backups, setBackups] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [backupNote, setBackupNote] = useState<string | null>(null);
  /** Строка из инпута: пустая — «выкл». */
  const [every, setEvery] = useState('');
  const [everySaved, setEverySaved] = useState(0);

  useEffect(() => {
    void ipc.getCredentials().then((c) => {
      if (!c) return;
      setClientId(c.clientId);
      setSecret(c.clientSecret);
    });
    void ipc.getCacheSize().then((bytes) => setCacheMb(bytes / 1024 / 1024));
    void ipc.getDefaultFields().then((v) => setFields(v ?? BUILTIN_FIELDS));
    void ipc.getPlayerPalette().then(setPalette);
    void ipc.getLanguage().then(setLang);
    void ipc.listBackups().then(setBackups);
    void ipc.getBackupEvery().then((n) => {
      setEverySaved(n);
      setEvery(n === 0 ? '' : String(n));
    });
  }, []);

  /** Перечитать настройки: после восстановления базы они могут стать другими. */
  function reload() {
    void ipc.getDefaultFields().then((v) => setFields(v ?? BUILTIN_FIELDS));
    void ipc.getPlayerPalette().then(setPalette);
    void ipc.getLanguage().then(setLang);
    void ipc.listBackups().then(setBackups);
    void ipc.getBackupEvery().then((n) => {
      setEverySaved(n);
      setEvery(n === 0 ? '' : String(n));
    });
    void ipc.getCacheSize().then((bytes) => setCacheMb(bytes / 1024 / 1024));
  }

  async function saveAndCheck() {
    setChecking(true);
    setResult(null);
    try {
      const creds = { clientId: clientId.trim(), clientSecret: secret.trim() };
      const res = await ipc.checkCredentials(creds);
      setResult(res);
      if (res.kind === 'ok') await ipc.saveCredentials(creds);
    } finally {
      setChecking(false);
    }
  }

  async function wipeCache() {
    await ipc.clearCache();
    setCacheMb(0);
  }

  // ── поля строки по умолчанию

  async function toggleField(f: PoolField) {
    const next = fields.includes(f) ? fields.filter((x) => x !== f) : [...fields, f];
    setFields(next);
    try {
      await ipc.setDefaultFields(next);
      setFieldsNote(
        next.length === 0
          ? 'Сохранено: новые маппулы будут без полей — строка станет короткой'
          : 'Сохранено — подействует на новые маппулы',
      );
    } catch (e) {
      setFieldsNote(errText(e));
    }
  }

  // ── палитра игроков

  function pickColor(index: number, value: string) {
    setPalette((prev) => prev.map((c, i) => (i === index ? value : c)));
  }

  async function savePalette(colors: string[]) {
    setPalette(colors);
    try {
      await ipc.setPlayerPalette(colors);
      setPaletteNote('Сохранено — цвет возьмут новые игроки, у назначенных останется прежний');
    } catch (e) {
      setPaletteNote(errText(e));
    }
  }

  // ── резервные копии

  async function makeBackup() {
    setBusy(true);
    setBackupNote(null);
    try {
      const name = await ipc.backupDatabase();
      setBackups(await ipc.listBackups());
      setBackupNote(`Бэкап создан: ${name}`);
    } catch (e) {
      setBackupNote(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function restore(name: string) {
    if (!window.confirm(`Вернуть базу из бэкапа ${name}? Всё, что сделано после него, пропадёт.`)) {
      return;
    }
    setBusy(true);
    setBackupNote(null);
    try {
      await ipc.restoreBackup(name);
      reload();
      setBackupNote(`База восстановлена из ${name}`);
    } catch (e) {
      setBackupNote(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveEvery() {
    const parsed = every.trim() === '' ? 0 : Number(every);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
      setBackupNote('Автобэкап: 0 — выключить, иначе число запусков от 1 до 1000');
      return;
    }
    try {
      await ipc.setBackupEvery(parsed);
      setEverySaved(parsed);
      setBackupNote(parsed === 0 ? 'Автобэкап выключен' : `Автобэкап: раз в ${parsed} запусков`);
    } catch (e) {
      setBackupNote(errText(e));
    }
  }

  return (
    <div className={s.screen}>
      <div className={s.col}>
        <h1 className={s.h1}>Настройки</h1>

        <section className={s.block}>
          <h2 className={s.h2}>Ключ osu!</h2>
          <p className={s.note}>
            Приложение читает только публичные данные карт: ни профиля, ни скоров оно не видит.
          </p>

          <div className={s.fields}>
            <Field
              label="Client ID"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <Field
              label="Client Secret"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
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
              variant="primary"
              disabled={checking || clientId.trim() === '' || secret.trim() === ''}
              onClick={() => void saveAndCheck()}
            >
              {checking ? 'Проверяю…' : 'Проверить и сохранить'}
            </Button>
            <Button onClick={() => void openUrl(REGISTER_URL)}>Страница регистрации ↗</Button>
          </div>
        </section>

        <section className={s.block}>
          <h2 className={s.h2}>Кеш обложек</h2>
          <p className={s.note}>
            {cacheMb === null ? 'Считаю размер…' : `Занято ${cacheMb.toFixed(1)} МБ`}
          </p>
          <div className={s.actions}>
            <Button onClick={() => void wipeCache()}>Очистить кеш</Button>
          </div>
        </section>

        <section className={s.block}>
          <h2 className={s.h2}>Язык</h2>
          <p className={s.note}>
            Приложение говорит по-русски. Других языков пока нет — переключать не на что.
          </p>
          <div className={s.chips}>
            <Chip active>{lang === 'ru' ? 'Русский' : lang}</Chip>
          </div>
        </section>

        <section className={s.block}>
          <h2 className={s.h2}>Поля строки карты по умолчанию</h2>
          <p className={s.note}>
            С этими полями создаются новые маппулы. У каждого пула набор свой — его меняют в
            редакторе маппула, а существующие пулы не пересматриваются.
          </p>
          <div className={s.chips}>
            {POOL_FIELDS.map((f) => (
              <Chip key={f} active={fields.includes(f)} onClick={() => void toggleField(f)}>
                {FIELD_NAMES[f]}
              </Chip>
            ))}
          </div>
          {fieldsNote ? <p className={s.inlineNote}>{fieldsNote}</p> : null}
        </section>

        <section className={s.block}>
          <h2 className={s.h2}>Палитра цветов игроков</h2>
          <p className={s.note}>
            Восемь цветов, между которыми переключаются новые игроки. Уже назначенные цвета не
            перекрашиваются.
          </p>
          <div className={s.swatches}>
            {palette.map((c, i) => (
              <label key={i} className={s.swatch}>
                <input type="color" value={c} onChange={(e) => pickColor(i, e.target.value)} />
                <span className={s.hex}>{c}</span>
              </label>
            ))}
          </div>
          <div className={s.actions}>
            <Button variant="primary" onClick={() => void savePalette(palette)}>
              Сохранить палитру
            </Button>
            <Button onClick={() => void savePalette(STANDARD_PALETTE)}>Вернуть стандартную</Button>
          </div>
          {paletteNote ? <p className={s.inlineNote}>{paletteNote}</p> : null}
        </section>

        <section className={s.block}>
          <h2 className={s.h2}>Резервная копия</h2>
          <p className={s.note}>
            Копии базы лежат в папке backups рядом с базой. Перенос базы на другой компьютер — на
            странице «История».
          </p>
          <div className={s.actions}>
            <Button variant="primary" disabled={busy} onClick={() => void makeBackup()}>
              {busy ? 'Делаю…' : 'Создать бэкап'}
            </Button>
          </div>

          {backups.length > 0 ? (
            <ul className={s.backupList}>
              {backups.map((name) => (
                <li key={name} className={s.backupRow}>
                  <code className={s.backupName}>{name}</code>
                  <Button size="sm" disabled={busy} onClick={() => void restore(name)}>
                    Восстановить
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.inlineNote}>Бэкапов пока нет</p>
          )}

          <div className={s.everyRow}>
            <span className={s.everyLabel}>Автобэкап раз в</span>
            <input
              className={s.everyInput}
              type="number"
              min={0}
              max={1000}
              step={1}
              value={every}
              placeholder="выкл"
              onChange={(e) => setEvery(e.target.value)}
              aria-label="Число запусков для автобэкапа"
            />
            <span className={s.everyLabel}>запусков</span>
            <Button
              size="sm"
              disabled={busy || everySaved === (every.trim() === '' ? 0 : Number(every))}
              onClick={() => void saveEvery()}
            >
              Сохранить
            </Button>
          </div>
          <p className={s.note}>0 или пусто — не делать автоматически. Счётчик запусков считается с каждого старта приложения.</p>
          {backupNote ? <p className={s.inlineNote}>{backupNote}</p> : null}
        </section>

        <section className={s.block}>
          <h2 className={s.h2}>Где лежат данные</h2>
          <div className={s.paths}>
            <div>
              <span className={s.pathLabel}>База</span>
              <code>{status?.dbPath ?? '—'}</code>
            </div>
            <div>
              <span className={s.pathLabel}>Обложки</span>
              <code>{status?.cachePath ?? '—'}</code>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
