import { useEffect } from 'react';
import { useApp } from '@/store/app';
import { useAir } from '@/lib/air/store';
import { isTauri } from '@/lib/host';
import { ImportCard, Rail } from '@/components';
import Onboarding from '@/screens/Onboarding';
import Library from '@/screens/Library';
import Downloads from '@/screens/Downloads';
import Players from '@/screens/Players';
import Pools from '@/screens/Pools';
import Settings from '@/screens/Settings';
import Tournaments from '@/screens/Tournaments';
import Home from '@/screens/Home';
import History from '@/screens/History';
import { useAirKeys } from '@/screens/air/shared';
import s from './App.module.css';

const NAV = [
  { id: 'home', icon: '◆', label: 'Главная' },
  { id: 'tournaments', icon: '⛁', label: 'Турниры' },
  { id: 'pools', icon: '☰', label: 'Маппулы' },
  { id: 'library', icon: '♪', label: 'Библиотека' },
  { id: 'downloads', icon: '⤓', label: 'Загрузки' },
  { id: 'players', icon: '⚉', label: 'Игроки' },
  { id: 'history', icon: '⏱', label: 'История' },
] as const;

export default function App() {
  const { status, ready, fatal, route, go, init } = useApp();
  const air = useAir((st) => st.status);

  useEffect(() => {
    void init();
  }, [init]);

  // Горячие клавиши эфира живут здесь, а не в пульте: они должны работать на
  // любом экране, и ровно один раз. Два обработчика — это пробел, выводящий
  // два кадра подряд.
  useAirKeys();

  // Пока эфир идёт, метка висит в шапке на любом экране, а закрытие окна
  // спрашивает подтверждение: закрыли окно — эфир умер, и узнать об этом
  // после того, как зрители увидели чёрный экран, поздно.
  const live = air?.live === true;

  useEffect(() => {
    if (!live) return;
    let unlisten: (() => void) | null = null;

    void (async () => {
      // Окна нет при показе вёрстки в браузере — там подтверждать нечего.
      if (!isTauri()) return;
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const w = getCurrentWindow();
      unlisten = await w.onCloseRequested((e) => {
        if (!window.confirm('Закрыть приложение? Эфир на этом закончится.')) {
          e.preventDefault();
        }
      });
    })();

    return () => unlisten?.();
  }, [live]);

  if (!ready) {
    return (
      <div className={s.boot}>
        <div className={s.bgglow} />
      </div>
    );
  }

  if (fatal !== null) {
    return (
      <div className={s.app}>
        <div className={s.bgglow} />
        <div className={s.fatal}>
          <h1>Приложение не запустилось</h1>
          <p>{fatal}</p>
        </div>
      </div>
    );
  }

  // Первый запуск ведёт себя как отдельное приложение: рейла нет, пока не введён ключ.
  if (status && !status.onboarded) {
    return (
      <div className={s.app}>
        <div className={s.bgglow} />
        <Onboarding />
      </div>
    );
  }

  return (
    <div className={s.app}>
      <div className={s.bgglow} />
      <Rail
        items={NAV.map((n) => ({ id: n.id, icon: n.icon, label: n.label }))}
        active={route}
        onSelect={(id) => go(id as typeof route)}
        footer={
          <>
            <ImportCard />
            <button className={s.railBtn} onClick={() => go('settings')} type="button">
              <span aria-hidden>⚙</span> Настройки
            </button>
          </>
        }
      />
      <main className={s.main}>
        {route === 'library' && <Library />}
        {route === 'downloads' && <Downloads />}
        {route === 'settings' && <Settings />}
        {route === 'home' && <Home />}
        {route === 'tournaments' && <Tournaments />}
        {route === 'pools' && <Pools />}
        {route === 'players' && <Players />}
        {route === 'history' && <History />}
      </main>

    </div>
  );
}
