import { useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button, Field } from '@/components';
import * as ipc from '@/lib/ipc';
import type { CredentialsCheck } from '@/lib/types';
import { useApp } from '@/store/app';
import s from './Onboarding.module.css';

const REGISTER_URL = 'https://osu.ppy.sh/home/account/edit#new-oauth-application';

export default function Onboarding() {
  const finish = useApp((st) => st.finishOnboarding);

  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CredentialsCheck | null>(null);

  const filled = clientId.trim() !== '' && secret.trim() !== '';

  async function check() {
    setChecking(true);
    setResult(null);
    try {
      const creds = { clientId: clientId.trim(), clientSecret: secret.trim() };
      const res = await ipc.checkCredentials(creds);
      setResult(res);
      if (res.kind === 'ok') await ipc.saveCredentials(creds);
    } catch (e) {
      setResult({ kind: 'invalid', message: String(e) });
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className={s.screen}>
      <div className={s.card}>
        <div className={s.brand}>
          <span className={s.mark} aria-hidden />
          osu!cup
        </div>

        <h1 className={s.h1}>Ключ osu!</h1>
        <p className={s.lead}>
          Нужен, чтобы приложение могло тянуть карты с osu!. Это не вход в аккаунт — прога видит
          только публичные данные карт, ни профиля, ни скоров. Создаётся один раз за две минуты.
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
          <Button variant="primary" disabled={!filled || checking} onClick={() => void check()}>
            {checking ? 'Проверяю…' : 'Проверить и продолжить'}
          </Button>
          <Button onClick={() => void finish()}>Потом — работать без интернета</Button>
        </div>

        {result?.kind === 'ok' ? (
          <div className={s.next}>
            <Button variant="primary" onClick={() => void finish()}>
              Дальше
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
