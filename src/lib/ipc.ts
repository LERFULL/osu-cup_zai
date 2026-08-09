// Единственное место, где фронт зовёт Rust. Все команды типизированы здесь.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  ApiCredentials,
  AppStatus,
  Beatmap,
  BeatmapAttributes,
  Collection,
  CredentialsCheck,
  Folder,
  ImportProgress,
  Label,
  LibraryFilter,
  ModTag,
  Page,
  ParsedLinks,
  QueueStatus,
  Skillset,
} from './types';

// ─────────────────────────────────────────────────── состояние приложения

export const getStatus = () => invoke<AppStatus>('get_status');
export const setOnboarded = (value: boolean) => invoke<void>('set_onboarded', { value });

// ─────────────────────────────────────────────────────────────── ключ

export const getCredentials = () => invoke<ApiCredentials | null>('get_credentials');
export const saveCredentials = (creds: ApiCredentials) =>
  invoke<void>('save_credentials', { creds });
export const checkCredentials = (creds: ApiCredentials) =>
  invoke<CredentialsCheck>('check_credentials', { creds });
export const clearCredentials = () => invoke<void>('clear_credentials');

// ─────────────────────────────────────────────────────────── библиотека

export const listBeatmaps = (filter: LibraryFilter, offset: number, limit: number) =>
  invoke<Page<Beatmap>>('list_beatmaps', { filter, offset, limit });

export const getBeatmap = (beatmapId: number) =>
  invoke<Beatmap | null>('get_beatmap', { beatmapId });

export const getSetDifficulties = (beatmapsetId: number) =>
  invoke<Beatmap[]>('get_set_difficulties', { beatmapsetId });

export const getAttributes = (beatmapId: number) =>
  invoke<BeatmapAttributes[]>('get_attributes', { beatmapId });

export const deleteBeatmaps = (beatmapIds: number[]) =>
  invoke<void>('delete_beatmaps', { beatmapIds });

export const setBeatmapMods = (beatmapId: number, mods: ModTag[]) =>
  invoke<void>('set_beatmap_mods', { beatmapId, mods });

export const setBeatmapFmMods = (beatmapId: number, mods: string[]) =>
  invoke<void>('set_beatmap_fm_mods', { beatmapId, mods });

export const setBeatmapSkillsets = (beatmapId: number, skillsets: Skillset[]) =>
  invoke<void>('set_beatmap_skillsets', { beatmapId, skillsets });

export const setBeatmapNote = (beatmapId: number, note: string) =>
  invoke<void>('set_beatmap_note', { beatmapId, note });

/** Массовое действие над выделением. */
export const bulkAddMod = (beatmapIds: number[], mod: ModTag) =>
  invoke<void>('bulk_add_mod', { beatmapIds, mod });

export const bulkAddSkillset = (beatmapIds: number[], skillset: Skillset) =>
  invoke<void>('bulk_add_skillset', { beatmapIds, skillset });

// ─────────────────────────────────────────────────────────────── метки

export const listLabels = () => invoke<Label[]>('list_labels');
export const createLabel = (name: string, color: string | null) =>
  invoke<Label>('create_label', { name, color });
export const setBeatmapLabels = (beatmapId: number, labelIds: number[]) =>
  invoke<void>('set_beatmap_labels', { beatmapId, labelIds });
export const bulkAddLabel = (beatmapIds: number[], labelId: number) =>
  invoke<void>('bulk_add_label', { beatmapIds, labelId });

// ─────────────────────────────────────────────────────────── коллекции

export const listCollections = () => invoke<Collection[]>('list_collections');
export const listFolders = () => invoke<Folder[]>('list_folders');

export const createCollection = (name: string, color: string | null) =>
  invoke<Collection>('create_collection', { name, color });

export const createSmartCollection = (name: string, color: string | null, filter: LibraryFilter) =>
  invoke<Collection>('create_smart_collection', { name, color, filter });

export const renameCollection = (id: number, name: string) =>
  invoke<void>('rename_collection', { id, name });

export const setCollectionColor = (id: number, color: string) =>
  invoke<void>('set_collection_color', { id, color });

export const moveCollection = (id: number, folderId: number | null, position: number) =>
  invoke<void>('move_collection', { id, folderId, position });

export const duplicateCollection = (id: number) => invoke<Collection>('duplicate_collection', { id });
export const deleteCollection = (id: number) => invoke<void>('delete_collection', { id });

export const addToCollection = (collectionId: number, beatmapIds: number[]) =>
  invoke<void>('add_to_collection', { collectionId, beatmapIds });

export const removeFromCollection = (collectionId: number, beatmapIds: number[]) =>
  invoke<void>('remove_from_collection', { collectionId, beatmapIds });

export const createFolder = (name: string) => invoke<Folder>('create_folder', { name });
export const renameFolder = (id: number, name: string) => invoke<void>('rename_folder', { id, name });
export const deleteFolder = (id: number) => invoke<void>('delete_folder', { id });

// ────────────────────────────────────────────────────────────── импорт

/** Разбор произвольного текста. Чистая операция, сети не трогает. */
export const parseLinks = (text: string) => invoke<ParsedLinks>('parse_links', { text });

/** Ставит найденное в очередь. Возвращает batchId, прогресс приходит событием. */
export const importLinks = (parsed: ParsedLinks) => invoke<string>('import_links', { parsed });

/** Повтор по картам, которые не загрузились. Возвращает новый batchId. */
export const retryFailed = (beatmapIds: number[]) => invoke<string>('retry_failed', { beatmapIds });
export const cancelBatch = (batchId: string) => invoke<void>('cancel_batch', { batchId });

export const getQueueStatus = () => invoke<QueueStatus>('get_queue_status');
export const getCacheSize = () => invoke<number>('cache_size');
export const clearCache = () => invoke<void>('clear_cache');

// ─────────────────────────────────────────────────────────────── события

export const onImportProgress = (fn: (p: ImportProgress) => void): Promise<UnlistenFn> =>
  listen<ImportProgress>('import:progress', (e) => fn(e.payload));

export const onQueueStatus = (fn: (s: QueueStatus) => void): Promise<UnlistenFn> =>
  listen<QueueStatus>('queue:status', (e) => fn(e.payload));

/** Прилетает, когда обложка докачалась и строку можно перерисовать. */
export const onCoverReady = (fn: (beatmapId: number) => void): Promise<UnlistenFn> =>
  listen<number>('cover:ready', (e) => fn(e.payload));
