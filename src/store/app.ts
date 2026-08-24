import { create } from 'zustand';
import type {
  AppStatus,
  Collection,
  Folder,
  ImportProgress,
  Label,
  LibraryFilter,
  ParsedLinks,
} from '@/lib/types';
import { EMPTY_FILTER } from '@/lib/types';
import * as ipc from '@/lib/ipc';

export type Route =
  | 'home'
  | 'tournaments'
  | 'pools'
  | 'library'
  | 'players'
  | 'history'
  | 'settings';

interface AppState {
  status: AppStatus | null;
  route: Route;
  ready: boolean;
  /** Приложение не смогло подняться: база не открылась или сорвался вызов. */
  fatal: string | null;

  collections: Collection[];
  folders: Folder[];
  labels: Label[];
  /** Сколько карт ещё без мод-тегов — счётчик системного раздела дерева. */
  untagged: number;

  filter: LibraryFilter;

  /** Идущая загрузка по ссылкам. Живёт в сторе, а не в окне импорта:
   *  поставил на скачку — и ушёл в другой раздел, она не прервётся. */
  importing: ImportProgress | null;
  /** Загрузка, карточку которой убрали с глаз. Сама она при этом идёт
   *  дальше, но обратно не всплывает. */
  hiddenBatch: string | null;

  init: () => Promise<void>;
  go: (route: Route) => void;
  refreshCollections: () => Promise<void>;
  /** Только счётчик «Без мод-тегов» — после правки тегов одной карты. */
  refreshUntagged: () => Promise<void>;
  refreshLabels: () => Promise<void>;
  setFilter: (patch: Partial<LibraryFilter>) => void;
  resetFilter: () => void;
  finishOnboarding: () => Promise<void>;
  /** Ставит загрузку и возвращает управление сразу. */
  startImport: (parsed: ParsedLinks) => Promise<void>;
  /** Убирает карточку доделанной загрузки. */
  dismissImport: () => void;
}

export const useApp = create<AppState>((set, get) => ({
  status: null,
  route: 'home',
  ready: false,
  fatal: null,

  collections: [],
  folders: [],
  labels: [],
  untagged: 0,

  filter: EMPTY_FILTER,
  importing: null,
  hiddenBatch: null,

  async init() {
    try {
      const status = await ipc.getStatus();
      set({ status, ready: true, fatal: null });
      await Promise.all([get().refreshCollections(), get().refreshLabels()]);

      // Подписка живёт столько же, сколько приложение: прогресс нужен и
      // тогда, когда окно импорта закрыто, а пользователь ушёл в турниры.
      void ipc.onImportProgress((p) => {
        if (get().hiddenBatch === p.batchId) {
          // Карточку этой загрузки убрали — обратно не показываем,
          // но счётчики всё равно держим свежими.
          if (p.stage === 'saving' || p.stage === 'done') void get().refreshCollections();
          return;
        }
        set({ importing: p });

        // Карты доехали — счётчики дерева пересчитываем сами, где бы
        // пользователь сейчас ни находился.
        if (p.stage === 'saving' || p.stage === 'done') void get().refreshCollections();
      });
    } catch (e) {
      // Экран с причиной лучше, чем вечная пустота.
      set({ ready: true, fatal: String(e) });
    }
  },

  go(route) {
    set({ route });
  },

  async refreshCollections() {
    // Счётчик «Без мод-тегов» меняется от тех же действий, что и состав
    // коллекций: импорт, удаление, простановка тегов. Читаем их вместе.
    const [collections, folders, untagged] = await Promise.all([
      ipc.listCollections(),
      ipc.listFolders(),
      ipc.countWithoutMods(),
    ]);
    set({ collections, folders, untagged });
  },

  async refreshUntagged() {
    set({ untagged: await ipc.countWithoutMods() });
  },

  async refreshLabels() {
    set({ labels: await ipc.listLabels() });
  },

  setFilter(patch) {
    set({ filter: { ...get().filter, ...patch } });
  },

  resetFilter() {
    // Коллекция и «Без мод-тегов» — это место, где ты находишься, а не фильтр.
    // Сброс их не трогает.
    const { collectionId, noMods } = get().filter;
    set({ filter: { ...EMPTY_FILTER, collectionId, noMods } });
  },

  async finishOnboarding() {
    await ipc.setOnboarded(true);
    const status = await ipc.getStatus();
    set({ status, route: 'home' });
  },

  async startImport(parsed) {
    const batchId = await ipc.importLinks(parsed);
    // Очередь начнёт присылать прогресс только со следующего события,
    // поэтому показываем «поставлено в очередь» сразу.
    set({
      hiddenBatch: null,
      importing: {
        batchId,
        stage: 'queued',
        done: 0,
        total: parsed.beatmapIds.length + parsed.beatmapsetIds.length,
        added: 0,
        skipped: 0,
        failed: [],
      },
    });
  },

  dismissImport() {
    const mine = get().importing;
    if (mine === null) return;
    // Карточка исчезает, но сама загрузка продолжается: помечаем её как
    // скрытую, чтобы следующие события не вернули карточку на экран.
    set({ importing: null, hiddenBatch: mine.batchId });
  },
}));
