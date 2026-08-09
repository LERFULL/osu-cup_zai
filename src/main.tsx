import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/tokens.css';

// В браузере Tauri нет — подставляем транспорт-заглушку, чтобы вёрстку
// можно было смотреть без сборки приложения. В собранной проге не срабатывает.
if (import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)) {
  const { installMockIpc } = await import('./lib/devIpc');
  installMockIpc();
}

const root = document.getElementById('root');
if (!root) throw new Error('Не найден корневой элемент');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
