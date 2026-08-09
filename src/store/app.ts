import { create } from 'zustand';
import type { AppStatus, Collection, Folder, Label, LibraryFilter } from '@/lib/types';
import { EMPTY_FILTER } from '@/lib/types';
import * as ipc from '@/lib/ipc';

export type Route = 'home' | 'tournaments' | 'pools' | 'library' | 'players' | 'history' | 'settings';

interface AppState {
  status: AppStatus | null;
  route: Route;
  ready: boolean;
  /** Приложение не смогло подняться: база не открылась или сорвался вызов. */
  fatal: string | null;

  collections: Collection[];
  folders: Folder[];
  labels: Label[];

  filter: LibraryFilter;

  init: () => Promise<void>;
  go: (route: Route) => void;
  refreshCollections: () => Promise<void>;
  refreshLabels: () => Promise<void>;
  setFilter: (patch: Partial<LibraryFilter>) => void;
  resetFilter: () => void;
  finishOnboarding: () => Promise<void>;
}

export const useApp = create<AppState>((set, get) => ({
  status: null,
  route: 'home',
  ready: false,
  fatal: null,

  collections: [],
  folders: [],
  labels: [],

  filter: EMPTY_FILTER,

  async init() {
    try {
      const status = await ipc.getStatus();
      set({ status, ready: true, fatal: null });
      await Promise.all([get().refreshCollections(), get().refreshLabels()]);
    } catch (e) {
      // Экран с причиной лучше, чем вечная пустота.
      set({ ready: true, fatal: String(e) });
    }
  },

  go(route) {
    set({ route });
  },

  async refreshCollections() {
    const [collections, folders] = await Promise.all([ipc.listCollections(), ipc.listFolders()]);
    set({ collections, folders });
  },

  async refreshLabels() {
    set({ labels: await ipc.listLabels() });
  },

  setFilter(patch) {
    set({ filter: { ...get().filter, ...patch } });
  },

  resetFilter() {
    // Коллекция — это место, где ты находишься, а не фильтр. Сброс её не трогает.
    set({ filter: { ...EMPTY_FILTER, collectionId: get().filter.collectionId } });
  },

  async finishOnboarding() {
    await ipc.setOnboarded(true);
    const status = await ipc.getStatus();
    set({ status, route: 'home' });
  },
}));
