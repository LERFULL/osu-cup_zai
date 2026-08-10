import { useEffect } from 'react';
import { useApp } from '@/store/app';
import { Rail } from '@/components';
import Onboarding from '@/screens/Onboarding';
import Library from '@/screens/Library';
import Players from '@/screens/Players';
import Pools from '@/screens/Pools';
import Settings from '@/screens/Settings';
import Tournaments from '@/screens/Tournaments';
import Stub from '@/screens/Stub';
import s from './App.module.css';

const NAV = [
  { id: 'home', icon: '◆', label: 'Главная' },
  { id: 'tournaments', icon: '⛁', label: 'Турниры' },
  { id: 'pools', icon: '☰', label: 'Маппулы' },
  { id: 'library', icon: '♪', label: 'Библиотека' },
  { id: 'players', icon: '⚉', label: 'Игроки' },
  { id: 'history', icon: '⏱', label: 'История' },
] as const;

export default function App() {
  const { status, ready, fatal, route, go, init } = useApp();

  useEffect(() => {
    void init();
  }, [init]);

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
          <button className={s.railBtn} onClick={() => go('settings')} type="button">
            <span aria-hidden>⚙</span> Настройки
          </button>
        }
      />
      <main className={s.main}>
        {route === 'library' && <Library />}
        {route === 'settings' && <Settings />}
        {route === 'home' && <Stub title="Главная" />}
        {route === 'tournaments' && <Tournaments />}
        {route === 'pools' && <Pools />}
        {route === 'players' && <Players />}
        {route === 'history' && <Stub title="История" />}
      </main>
    </div>
  );
}
