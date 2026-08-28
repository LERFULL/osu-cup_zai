import { create } from 'zustand';
import type {
  AppStatus,
  Collection,
  Folder,
  ImportBatch,
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
  | 'downloads'
  | 'players'
  | 'history'
  | 'settings';

interface AppState {
  status: AppStatus | null;
  route: Route;
  /** Турнир, который экран турниров должен открыть при входе. Главная
   *  кладёт его перед переходом («Продолжить», «Новый турнир»), экран
   *  турниров забирает и обнуляет. */
  openTournament: number | null;
  ready: boolean;
  /** Приложение не смогло подняться: база не открылась или сорвался вызов. */
  fatal: string | null;

  collections: Collection[];
  folders: Folder[];
  labels: Label[];
  /** Сколько карт ещё без мод-тегов — счётчик системного раздела дерева. */
  untagged: number;

  filter: LibraryFilter;

  /** Идущая загрузка. Живёт в сторе, а не в окне: поставил на скачку —
   *  и ушёл в другой раздел, она не прервётся. */
  importing: ImportProgress | null;
  /** Загрузка, карточку которой убрали с глаз. Сама она при этом идёт
   *  дальше, но обратно не всплывает. */
  hiddenBatch: string | null;
  /** Очередь загрузок целиком: идущие, ждущие и закончившиеся пачки. */
  queue: ImportBatch[];

  init: () => Promise<void>;
  go: (route: Route) => void;
  setOpenTournament: (id: number | null) => void;
  refreshCollections: () => Promise<void>;
  /** Только счётчик «Без мод-тегов» — после правки тегов одной карты. */
  refreshUntagged: () => Promise<void>;
  refreshLabels: () => Promise<void>;
  /** Очередь загрузок целиком — после событий и правок списка. */
  refreshQueue: () => Promise<void>;
  setFilter: (patch: Partial<LibraryFilter>) => void;
  resetFilter: () => void;
  finishOnboarding: () => Promise<void>;
  /** Ставит пачку в очередь загрузок и возвращает управление сразу. */
  addToQueue: (parsed: ParsedLinks, mods: string[], name?: string) => Promise<void>;
  /** Убирает карточку доделанной загрузки. */
  dismissImport: () => void;
}

export const useApp = create<AppState>((set, get) => ({
  status: null,
  route: 'home',
  openTournament: null,
  ready: false,
  fatal: null,

  collections: [],
  folders: [],
  labels: [],
  untagged: 0,

  filter: EMPTY_FILTER,
  importing: null,
  hiddenBatch: null,
  queue: [],

  async init() {
    try {
      const status = await ipc.getStatus();
      set({ status, ready: true, fatal: null });
      await Promise.all([get().refreshCollections(), get().refreshLabels(), get().refreshQueue()]);

      // Подписка живёт столько же, сколько приложение: прогресс нужен и
      // тогда, когда пользователь ушёл в турниры или маппулы.
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

      // Список очереди меняется извне (пачка взялась в работу, отменилась,
      // кончилась) — перечитываем его целиком.
      void ipc.onDownloadsChanged(() => {
        void get().refreshQueue();
      });
    } catch (e) {
      // Экран с причиной лучше, чем вечная пустота.
      set({ ready: true, fatal: String(e) });
    }
  },

  go(route) {
    set({ route });
  },

  // Экран турниров держит свой выбор в локальном состоянии, поэтому с
  // другого экрана дотянуться до него можно только через стор.
  setOpenTournament(id) {
    set({ openTournament: id });
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

  async refreshQueue() {
    try {
      set({ queue: await ipc.downloadQueueList() });
    } catch {
      // Очередь — необязательная часть старта: не считали, покажем позже,
      // когда придёт первое событие downloads:changed.
    }
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

  async addToQueue(parsed, mods, name) {
    await ipc.downloadQueueAdd(parsed, mods, name);
    await get().refreshQueue();
  },

  dismissImport() {
    const mine = get().importing;
    if (mine === null) return;
    // Карточка исчезает, но сама загрузка продолжается: помечаем её как
    // скрытую, чтобы следующие события не вернули карточку на экран.
    set({ importing: null, hiddenBatch: mine.batchId });
  },
}));
