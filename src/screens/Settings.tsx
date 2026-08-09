import { useEffect, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button, Field } from '@/components';
import * as ipc from '@/lib/ipc';
import type { CredentialsCheck } from '@/lib/types';
import { useApp } from '@/store/app';
import s from './Settings.module.css';

const REGISTER_URL = 'https://osu.ppy.sh/home/account/edit#new-oauth-application';

export default function Settings() {
  const status = useApp((st) => st.status);

  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CredentialsCheck | null>(null);
  const [cacheMb, setCacheMb] = useState<number | null>(null);

  useEffect(() => {
    void ipc.getCredentials().then((c) => {
      if (!c) return;
      setClientId(c.clientId);
      setSecret(c.clientSecret);
    });
    void ipc.getCacheSize().then((bytes) => setCacheMb(bytes / 1024 / 1024));
  }, []);

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
