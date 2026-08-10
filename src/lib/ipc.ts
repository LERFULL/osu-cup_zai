// Единственное место, где фронт зовёт Rust. Все команды типизированы здесь.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  ApiCredentials,
  AppStatus,
  Beatmap,
  BeatmapAttributes,
  Bracket,
  ByRound,
  Collection,
  CredentialsCheck,
  FirstBan,
  Folder,
  GenReport,
  GenRules,
  ImportProgress,
  Label,
  LibraryFilter,
  MatchState,
  ModTag,
  Page,
  ParsedLinks,
  Player,
  PlayerStats,
  Pool,
  PoolField,
  PoolOverlap,
  PoolStatus,
  PoolTemplate,
  QueueStatus,
  Skillset,
  SlotSupply,
  TemplateSlotInput,
  Tournament,
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

/** Сколько карт ещё без мод-тегов — счётчик системного раздела дерева. */
export const countWithoutMods = () => invoke<number>('count_without_mods');

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

// ───────────────────────────────────────────────── шаблоны маппулов

export const listTemplates = () => invoke<PoolTemplate[]>('list_templates');
export const getTemplate = (id: number) => invoke<PoolTemplate>('get_template', { id });
export const createTemplate = (name: string) => invoke<PoolTemplate>('create_template', { name });

/** Редактор сохраняется целиком — имя, правила и слоты одной транзакцией. */
export const saveTemplate = (
  id: number,
  name: string,
  rules: GenRules,
  slots: TemplateSlotInput[],
) => invoke<PoolTemplate>('save_template', { id, name, rules, slots });

export const duplicateTemplate = (id: number) => invoke<PoolTemplate>('duplicate_template', { id });
export const deleteTemplate = (id: number) => invoke<void>('delete_template', { id });

/** Сколько карт нужно под каждый слот и сколько нашлось в источнике. */
export const templateSupply = (id: number) => invoke<SlotSupply[]>('template_supply', { id });

// ────────────────────────────────────────────────────────── маппулы

export const listPools = () => invoke<Pool[]>('list_pools');
export const getPool = (id: number) => invoke<Pool>('get_pool', { id });
export const createPool = (name: string) => invoke<Pool>('create_pool', { name });

/** Возвращает id пула, в который ушла правка: у сыгранного он будет новым. */
export const renamePool = (id: number, name: string) => invoke<number>('rename_pool', { id, name });

export const setPoolStatus = (id: number, status: PoolStatus) =>
  invoke<void>('set_pool_status', { id, status });

export const setPoolDisplayFields = (id: number, fields: PoolField[]) =>
  invoke<void>('set_pool_display_fields', { id, fields });

export const duplicatePool = (id: number) => invoke<Pool>('duplicate_pool', { id });
export const deletePool = (id: number) => invoke<void>('delete_pool', { id });

// Слоты адресуются позицией, а не id: правка сыгранного пула уходит в копию,
// где id другие, а порядок тот же. Ответ — пул целиком, с его настоящим id.

export const setSlotBeatmap = (poolId: number, position: number, beatmapId: number | null) =>
  invoke<Pool>('set_slot_beatmap', { poolId, position, beatmapId });

export const setSlotPinned = (poolId: number, position: number, pinned: boolean) =>
  invoke<Pool>('set_slot_pinned', { poolId, position, pinned });

export const setSlotFmMods = (poolId: number, position: number, mods: string[]) =>
  invoke<Pool>('set_slot_fm_mods', { poolId, position, mods });

export const setSlotMod = (poolId: number, position: number, mod: ModTag) =>
  invoke<Pool>('set_slot_mod', { poolId, position, mod });

export const addPoolSlot = (poolId: number, mod: ModTag) =>
  invoke<Pool>('add_pool_slot', { poolId, mod });

export const removePoolSlot = (poolId: number, position: number) =>
  invoke<Pool>('remove_pool_slot', { poolId, position });

/** Новый порядок задаётся списком нынешних позиций. */
export const reorderPoolSlots = (poolId: number, order: number[]) =>
  invoke<Pool>('reorder_pool_slots', { poolId, order });

/** Фильтр библиотеки, суженный под слот: тот же, по которому шла генерация. */
export const getSlotFilter = (poolId: number, position: number) =>
  invoke<LibraryFilter>('slot_filter', { poolId, position });

export const generatePool = (templateId: number, name: string) =>
  invoke<GenReport>('generate_pool', { templateId, name });

/** Серия маппулов под турнир: карты внутри серии не повторяются. */
export const generatePoolSeries = (templateId: number, names: string[]) =>
  invoke<GenReport[]>('generate_pool_series', { templateId, names });

/** Карты, попавшие сразу в несколько маппулов турнира. */
export const tournamentPoolOverlaps = (id: number) =>
  invoke<PoolOverlap[]>('tournament_pool_overlaps', { id });

export const rerollPool = (poolId: number, keepPinned: boolean) =>
  invoke<GenReport>('reroll_pool', { poolId, keepPinned });

export const rerollSlot = (poolId: number, position: number) =>
  invoke<GenReport>('reroll_slot', { poolId, position });

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

// ─────────────────────────────────────────────────────────────── игроки

export const listPlayers = (includeArchived = false) =>
  invoke<Player[]>('list_players', { includeArchived });

export const getPlayer = (id: number) => invoke<Player | null>('get_player', { id });

export const createPlayer = (nickname: string, osuUserId: number | null = null) =>
  invoke<Player>('create_player', { nickname, osuUserId });

export const updatePlayer = (
  id: number,
  nickname: string,
  osuUserId: number | null,
  color: string,
  note: string | null,
) => invoke<void>('update_player', { id, nickname, osuUserId, color, note });

/** Мягкое удаление: из выбора уходит, история остаётся читаемой. */
export const archivePlayer = (id: number, archived: boolean) =>
  invoke<void>('archive_player', { id, archived });

export const deletePlayer = (id: number) => invoke<void>('delete_player', { id });

export const playerStats = (id: number) => invoke<PlayerStats>('player_stats', { id });

/** Тянет аватар с osu! по ID профиля. Возвращает игрока с путём к файлу. */
export const fetchPlayerAvatar = (id: number) =>
  invoke<Player>('fetch_player_avatar', { id });

/** Обновляет устаревшие аватары и подтягивает недостающие. Молча:
 *  без сети просто вернёт список как есть. */
export const refreshPlayerAvatars = (includeArchived = false) =>
  invoke<Player[]>('refresh_player_avatars', { includeArchived });

// ────────────────────────────────────────────────────────────── турниры

export const listTournaments = () => invoke<Tournament[]>('list_tournaments');
export const getTournament = (id: number) => invoke<Tournament>('get_tournament', { id });

export const createTournament = (name: string, targetScore: number, bansPerRound: number) =>
  invoke<Tournament>('create_tournament', { name, targetScore, bansPerRound });

export const renameTournament = (id: number, name: string) =>
  invoke<void>('rename_tournament', { id, name });

export const setTournamentRules = (
  id: number,
  targetScore: ByRound,
  bansPerRound: ByRound,
  firstBan: FirstBan,
  noRepeatPool: boolean,
) =>
  invoke<Tournament>('set_tournament_rules', {
    id,
    targetScore,
    bansPerRound,
    firstBan,
    noRepeatPool,
  });

export const deleteTournament = (id: number) => invoke<void>('delete_tournament', { id });

export const addTournamentPlayer = (id: number, playerId: number) =>
  invoke<void>('add_tournament_player', { id, playerId });

export const removeTournamentPlayer = (id: number, playerId: number) =>
  invoke<void>('remove_tournament_player', { id, playerId });

/** Сеяние задаётся порядком списка. */
export const setTournamentSeeds = (id: number, order: number[]) =>
  invoke<void>('set_tournament_seeds', { id, order });

export const setTournamentPlayerColor = (id: number, playerId: number, color: string) =>
  invoke<void>('set_tournament_player_color', { id, playerId, color });

export const setTournamentPools = (id: number, poolIds: number[]) =>
  invoke<void>('set_tournament_pools', { id, poolIds });

/** Строит сетку и показывает её на утверждение. Состав дальше закрыт. */
export const startTournament = (id: number) => invoke<Bracket>('start_tournament', { id });

/** Утверждает сетку: с этого момента матчи можно играть. */
export const confirmTournament = (id: number) => invoke<Bracket>('confirm_tournament', { id });

/** Возвращает турнир в черновик и стирает несыгранную сетку. */
export const reopenTournament = (id: number) => invoke<Bracket>('reopen_tournament', { id });

export const tournamentBracket = (id: number) => invoke<Bracket>('tournament_bracket', { id });

export const finishTournament = (id: number) => invoke<Tournament>('finish_tournament', { id });

// ─────────────────────────────────────────────────────────────── матч

// Каждое действие возвращает состояние матча целиком: фаза, счёт и строки
// считаются на стороне Rust, и держать их копию на фронте незачем.

export const matchState = (id: number) => invoke<MatchState>('match_state', { id });

export const setMatchPool = (id: number, poolId: number | null) =>
  invoke<MatchState>('set_match_pool', { id, poolId });

export const setMatchFirstBan = (id: number, playerId: number) =>
  invoke<MatchState>('set_match_first_ban', { id, playerId });

export const banSlot = (id: number, slotLabel: string) =>
  invoke<MatchState>('ban_slot', { id, slotLabel });

export const pickSlot = (id: number, slotLabel: string) =>
  invoke<MatchState>('pick_slot', { id, slotLabel });

export const recordResult = (id: number, winnerId: number) =>
  invoke<MatchState>('record_result', { id, winnerId });

export const undoMatchAction = (id: number) => invoke<MatchState>('undo_match_action', { id });

export const setMatchWalkover = (id: number, winnerId: number) =>
  invoke<MatchState>('set_match_walkover', { id, winnerId });

export const setMatchManualResult = (
  id: number,
  winnerId: number,
  scoreA: number,
  scoreB: number,
) => invoke<MatchState>('set_match_manual_result', { id, winnerId, scoreA, scoreB });
