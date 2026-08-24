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
  EditImpact,
  EditorState,
  ExclusionOwner,
  ExclusionTarget,
  FirstBan,
  Folder,
  GenReport,
  GenRules,
  ImportProgress,
  Label,
  LibraryFilter,
  LibrarySummary,
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
  PoolWhence,
  QueueStatus,
  Series,
  SeriesKind,
  SeriesStats,
  Skillset,
  SlotPicker,
  SlotSupply,
  SourceSet,
  TemplateSlotInput,
  Tournament,
} from './types';
import type {
  AirLayer,
  AirStatus,
  AirTheme,
  LobbyUpdate,
  OsuProfile,
  SceneId,
  ScenePayload,
  SceneShow,
} from './air/types';

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

export const librarySummary = (filter: LibraryFilter) =>
  invoke<LibrarySummary>('library_summary', { filter });

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

export const bulkRemoveMod = (beatmapIds: number[], mod: ModTag) =>
  invoke<void>('bulk_remove_mod', { beatmapIds, mod });

/** Снять с выделенных карт все мод-теги разом. */
export const bulkClearMods = (beatmapIds: number[]) =>
  invoke<void>('bulk_clear_mods', { beatmapIds });

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

/** Редактор сохраняется целиком — имя, правила, источники и слоты одной транзакцией. */
export const saveTemplate = (
  id: number,
  name: string,
  rules: GenRules,
  sources: SourceSet | null,
  slots: TemplateSlotInput[],
) => invoke<PoolTemplate>('save_template', { id, name, rules, sources, slots });

export const duplicateTemplate = (id: number) => invoke<PoolTemplate>('duplicate_template', { id });
export const deleteTemplate = (id: number) => invoke<void>('delete_template', { id });

/** Запас по слотам шаблона: что подходит и что отсекло остальное. */
export const templateSupply = (id: number) => invoke<SlotSupply[]>('template_supply', { id });

// ────────────────────────────────────────────────────────── маппулы

export const listPools = () => invoke<Pool[]>('list_pools');
export const getPool = (id: number) => invoke<Pool>('get_pool', { id });

export const createPool = (name: string, seriesId: number | null = null) =>
  invoke<Pool>('create_pool', { name, seriesId });

/** Возвращает id пула, в который ушла правка: у сыгранного он будет новым. */
export const renamePool = (id: number, name: string) => invoke<number>('rename_pool', { id, name });

export const setPoolStatus = (id: number, status: PoolStatus) =>
  invoke<void>('set_pool_status', { id, status });

export const setPoolDisplayFields = (id: number, fields: PoolField[]) =>
  invoke<void>('set_pool_display_fields', { id, fields });

/** Свои источники пула. `null` — вернуть наследование серии или шаблона. */
export const setPoolSources = (id: number, sources: SourceSet | null) =>
  invoke<Pool>('set_pool_sources', { id, sources });

export const duplicatePool = (id: number) => invoke<Pool>('duplicate_pool', { id });
export const deletePool = (id: number) => invoke<void>('delete_pool', { id });

// Слоты адресуются позицией, а не id: правка сыгранного пула уходит в копию,
// где id другие, а порядок тот же. Ответ — пул целиком, с его настоящим id.

export const setSlotBeatmap = (poolId: number, position: number, beatmapId: number | null) =>
  invoke<Pool>('set_slot_beatmap', { poolId, position, beatmapId });

/** Пакетное действие над выделением: одно закрепление на все слоты. */
export const setSlotsPinned = (poolId: number, positions: number[], pinned: boolean) =>
  invoke<Pool>('set_slots_pinned', { poolId, positions, pinned });

export const setSlotFmMods = (poolId: number, position: number, mods: string[]) =>
  invoke<Pool>('set_slot_fm_mods', { poolId, position, mods });

export const setSlotsMod = (poolId: number, positions: number[], mod: ModTag) =>
  invoke<Pool>('set_slots_mod', { poolId, positions, mod });

/** Свои источники выделенных слотов. `null` — вернуть наследование пула. */
export const setSlotsSources = (
  poolId: number,
  positions: number[],
  sources: SourceSet | null,
) => invoke<Pool>('set_slots_sources', { poolId, positions, sources });

export const addPoolSlot = (poolId: number, mod: ModTag) =>
  invoke<Pool>('add_pool_slot', { poolId, mod });

export const removePoolSlots = (poolId: number, positions: number[]) =>
  invoke<Pool>('remove_pool_slots', { poolId, positions });

/** Новый порядок задаётся списком нынешних позиций. */
export const reorderPoolSlots = (poolId: number, order: number[]) =>
  invoke<Pool>('reorder_pool_slots', { poolId, order });

/** Фильтр слота и карты, скрытые исключениями, — для панели подбора. */
export const slotPicker = (poolId: number, position: number) =>
  invoke<SlotPicker>('slot_picker', { poolId, position });

/** Источники, исключения, правила и запас — содержимое панели «Откуда берём». */
export const poolWhence = (poolId: number) => invoke<PoolWhence>('pool_whence', { poolId });

export const generatePool = (templateId: number, name: string, seriesId: number | null = null) =>
  invoke<GenReport>('generate_pool', { templateId, name, seriesId });

export const rerollPool = (poolId: number, keepPinned: boolean) =>
  invoke<GenReport>('reroll_pool', { poolId, keepPinned });

/** Перекат выделенных слотов: остальные карты остаются на местах. */
export const rerollSlots = (poolId: number, positions: number[]) =>
  invoke<GenReport>('reroll_slots', { poolId, positions });

// ─────────────────────────────────────────────────────── исключения

export const addExclusion = (
  ownerKind: ExclusionOwner,
  ownerId: number,
  target: ExclusionTarget,
  strict: boolean,
) => invoke<void>('add_exclusion', { ownerKind, ownerId, target, strict });

export const removeExclusion = (id: number) => invoke<void>('remove_exclusion', { id });

export const setExclusionStrict = (id: number, strict: boolean) =>
  invoke<void>('set_exclusion_strict', { id, strict });

export const setExclusionEnabled = (id: number, enabled: boolean) =>
  invoke<void>('set_exclusion_enabled', { id, enabled });

// ───────────────────────────────────────────────────────────── серии

export const listSeries = () => invoke<Series[]>('list_series');
export const getSeries = (id: number) => invoke<Series>('get_series', { id });

export const createSeries = (name: string, kind: SeriesKind) =>
  invoke<Series>('create_series', { name, kind });

export const renameSeries = (id: number, name: string) =>
  invoke<void>('rename_series', { id, name });

export const setSeriesColor = (id: number, color: string | null) =>
  invoke<void>('set_series_color', { id, color });

export const setSeriesNote = (id: number, note: string | null) =>
  invoke<void>('set_series_note', { id, note });

/**
 * Смена типа. Непустой ответ — повторы, из-за которых тип не сменился:
 * турнирная серия обещает, что карты в ней не повторяются.
 */
export const setSeriesKind = (id: number, kind: SeriesKind) =>
  invoke<PoolOverlap[]>('set_series_kind', { id, kind });

export const setSeriesNoRepeat = (id: number, value: boolean) =>
  invoke<PoolOverlap[]>('set_series_no_repeat', { id, value });

export const setSeriesSources = (id: number, sources: SourceSet | null) =>
  invoke<Series>('set_series_sources', { id, sources });

export const setSeriesDisplayFields = (id: number, fields: PoolField[] | null) =>
  invoke<void>('set_series_display_fields', { id, fields });

export const duplicateSeries = (id: number) => invoke<Series>('duplicate_series', { id });

/** Удаление серии не удаляет маппулы: они возвращаются в общий список. */
export const deleteSeries = (id: number) => invoke<void>('delete_series', { id });

export const reorderSeries = (ids: number[]) => invoke<void>('reorder_series', { ids });

/** Непустой ответ — повторы, из-за которых пул не перенесён. */
export const addPoolToSeries = (seriesId: number, poolId: number) =>
  invoke<PoolOverlap[]>('add_pool_to_series', { seriesId, poolId });

export const removePoolFromSeries = (poolId: number) =>
  invoke<void>('remove_pool_from_series', { poolId });

export const reorderSeriesPools = (seriesId: number, poolIds: number[]) =>
  invoke<Series>('reorder_series_pools', { seriesId, poolIds });

export const setSeriesPoolLabel = (poolId: number, label: string | null) =>
  invoke<void>('set_series_pool_label', { poolId, label });

export const seriesStats = (id: number) => invoke<SeriesStats>('series_stats', { id });
export const seriesRepeats = (id: number) => invoke<PoolOverlap[]>('series_repeats', { id });

/** Серия под турнир: создаётся сама серия и `count` пулов в ней. */
export const generateSeries = (templateId: number, name: string, count: number) =>
  invoke<GenReport[]>('generate_series', { templateId, name, count });

/** Скатать серию целиком: карты каждого следующего пула вычитаются из набора. */
export const rollSeries = (seriesId: number, keepPinned: boolean) =>
  invoke<GenReport[]>('roll_series', { seriesId, keepPinned });

/** Перекатить карту в том пуле, где она повторилась. */
export const rerollRepeat = (poolId: number, beatmapId: number) =>
  invoke<GenReport>('reroll_repeat', { poolId, beatmapId });

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

// Правка живого турнира требует явного согласия: `emergency` — состояние
// переключателя «аварийная правка», и решение принимает Rust, а не экран.

export const addTournamentPlayer = (id: number, playerId: number, emergency = false) =>
  invoke<void>('add_tournament_player', { id, playerId, emergency });

export const removeTournamentPlayer = (id: number, playerId: number, emergency = false) =>
  invoke<void>('remove_tournament_player', { id, playerId, emergency });

/** Сеяние задаётся порядком списка. */
export const setTournamentSeeds = (id: number, order: number[], emergency = false) =>
  invoke<void>('set_tournament_seeds', { id, order, emergency });

/** Обмен местами в сетке: сеяние пересчитывается. */
export const swapTournamentSeeds = (
  id: number,
  playerA: number,
  playerB: number,
  emergency = false,
) => invoke<void>('swap_tournament_seeds', { id, playerA, playerB, emergency });

/** Сажает игрока на место сеяния, при необходимости добавив его в турнир. */
export const placeTournamentPlayer = (
  id: number,
  playerId: number,
  seed: number,
  emergency = false,
) => invoke<void>('place_tournament_player', { id, playerId, seed, emergency });

/** Случайное сеяние вместе с пересборкой сетки. */
export const shuffleTournamentSeeds = (id: number, emergency = false) =>
  invoke<void>('shuffle_tournament_seeds', { id, emergency });

export const setTournamentPlayerColor = (id: number, playerId: number, color: string) =>
  invoke<void>('set_tournament_player_color', { id, playerId, color });

export const setTournamentPools = (id: number, poolIds: number[]) =>
  invoke<void>('set_tournament_pools', { id, poolIds });

/** Исключение по раунду. `null` в поле — вернуть общее значение. */
export const setTournamentRoundRule = (
  id: number,
  key: string,
  target: number | null,
  bans: number | null,
) => invoke<void>('set_tournament_round_rule', { id, key, target, bans });

/** Закрепляет маппул за раундом. `null` — «любой свободный». */
export const setTournamentRoundPool = (id: number, key: string, poolId: number | null) =>
  invoke<void>('set_tournament_round_pool', { id, key, poolId });

/** Берёт маппулы серии по порядку и раскладывает по раундам. */
export const addTournamentSeries = (id: number, seriesId: number) =>
  invoke<void>('add_tournament_series', { id, seriesId });

/** Преимущество сетки в гранд-финале. */
export const setTournamentGrandAdvantage = (id: number, value: number) =>
  invoke<void>('set_tournament_grand_advantage', { id, value });

/** Раунды, bye, проверки и журнал правок — содержимое колонки разделов. */
export const tournamentEditor = (id: number) => invoke<EditorState>('tournament_editor', { id });

/** Отменяет последнюю правку турнира. */
export const undoTournamentEdit = (id: number) => invoke<Bracket>('undo_tournament_edit', { id });

/** Строит сетку и показывает её на утверждение. Состав дальше закрыт. */
export const startTournament = (id: number) => invoke<Bracket>('start_tournament', { id });

/** Утверждает сетку: с этого момента матчи можно играть. */
export const confirmTournament = (id: number) => invoke<Bracket>('confirm_tournament', { id });

/** Возвращает турнир в черновик и стирает несыгранную сетку. */
export const reopenTournament = (id: number) => invoke<Bracket>('reopen_tournament', { id });

/** Останавливает идущий турнир, не теряя результатов. */
export const stopTournament = (id: number) => invoke<Bracket>('stop_tournament', { id });

/** Возвращает остановленный турнир в игру. */
export const resumeTournament = (id: number) => invoke<Bracket>('resume_tournament', { id });

export const tournamentBracket = (id: number) => invoke<Bracket>('tournament_bracket', { id });

/** Карты, попавшие сразу в несколько маппулов турнира. */
export const tournamentPoolOverlaps = (id: number) =>
  invoke<PoolOverlap[]>('tournament_pool_overlaps', { id });

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

export const setMatchWalkover = (id: number, winnerId: number, emergency = false) =>
  invoke<MatchState>('set_match_walkover', { id, winnerId, emergency });

export const setMatchManualResult = (
  id: number,
  winnerId: number,
  scoreA: number,
  scoreB: number,
  emergency = false,
) => invoke<MatchState>('set_match_manual_result', { id, winnerId, scoreA, scoreB, emergency });

/** Что случится, если снести результат: считается до правки, а не после. */
export const matchImpact = (id: number) => invoke<EditImpact>('match_impact', { id });

/** Снос результата: матч возвращается в ожидание, сетка ниже сбрасывается. */
export const resetMatch = (id: number, emergency = false) =>
  invoke<MatchState>('reset_match', { id, emergency });

/** Замена участника в конкретном месте сетки. */
export const replaceMatchPlayer = (
  id: number,
  slot: 'a' | 'b',
  playerId: number,
  emergency = false,
) => invoke<MatchState>('replace_match_player', { id, slot, playerId, emergency });

// ─────────────────────────────────────────────────────────────── эфир

// Rust здесь только транспорт: сцены, переходы и подбор под бюджет считает
// пульт. Поэтому команд мало, и ни одна из них не знает, что такое сцена.

export const airStatus = () => invoke<AirStatus>('air_status');

export const airStart = (tournamentId: number, tournament: string) =>
  invoke<AirStatus>('air_start', { tournamentId, tournament });

export const airStop = () => invoke<AirStatus>('air_stop');

/** Новый кадр: стек слоёв целиком. Обычно один слой, при врезке два. */
export const airScene = (layers: AirLayer[], theme: AirTheme | null = null) =>
  invoke<void>('air_scene', { layers, theme });

/** Точечное обновление внутри слоя: счёт, новый бан, таймер. */
export const airPatch = (layer: SceneId, payload: ScenePayload) =>
  invoke<void>('air_patch', { layer, payload });


/** Опрос лобби. Идёт, только пока матч идёт. */
export const airLobbyStart = (matchId: number, roomId: number) =>
  invoke<void>('air_lobby_start', { matchId, roomId });

export const airLobbyStop = () => invoke<void>('air_lobby_stop');

/** Номер лобби матча. `null` — матч ведётся только судьёй. */
export const setMatchLobby = (id: number, roomId: number | null) =>
  invoke<void>('set_match_lobby', { id, roomId });

/** Настройки эфира турнира. Форму знает пульт, Rust её не разбирает. */
export const airConfig = (tournamentId: number) =>
  invoke<string | null>('air_config', { tournamentId });

export const airSetConfig = (tournamentId: number, json: string) =>
  invoke<void>('air_set_config', { tournamentId, json });

/** Показы сцен. Живут с турниром, а не с сессией эфира. */
export const airShows = (tournamentId: number) =>
  invoke<SceneShow[]>('air_shows', { tournamentId });

export const airNoteShow = (tournamentId: number, sceneId: SceneId, objectKey: string) =>
  invoke<SceneShow[]>('air_note_show', { tournamentId, sceneId, objectKey });

export const airClearShows = (tournamentId: number) =>
  invoke<SceneShow[]>('air_clear_shows', { tournamentId });

/** Профили osu! для сцен с цифрами. Тянутся раз в сутки на игрока. */
export const airProfiles = (osuUserIds: number[]) =>
  invoke<OsuProfile[]>('air_profiles', { osuUserIds });

/** Сколько зрителей смотрит. Прилетает при каждом подключении и отключении. */
export const onAirViewers = (fn: (n: number) => void): Promise<UnlistenFn> =>
  listen<number>('air:viewers', (e) => fn(e.payload));

/** Что показал опрос лобби. */
export const onAirLobby = (fn: (u: LobbyUpdate) => void): Promise<UnlistenFn> =>
  listen<LobbyUpdate>('air:lobby', (e) => fn(e.payload));
