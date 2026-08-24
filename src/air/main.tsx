import { createRoot } from 'react-dom/client';
import { Viewer } from './Viewer';
import './air.css';

// Своя точка входа, а не главное приложение: страница зрителя не должна тянуть
// код IPC, библиотеки и редакторов. Здесь нет и StrictMode — двойной прогон
// эффектов в разработке дважды открывал бы соединение и дважды заводил таймеры.

const root = document.getElementById('air');
if (!root) throw new Error('Не найден корневой элемент');

createRoot(root).render(<Viewer />);
