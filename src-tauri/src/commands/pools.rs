use std::sync::Arc;

use tauri::State;

use crate::db::beatmaps;
use crate::db::exclusions::Owner;
use crate::db::{
    exclusions as ex_db, generate, pools as pool_db, series as series_db, supply as supply_db,
    templates as tpl_db,
};
use crate::error::Result;
use crate::model::{
    Beatmap, ExclusionTarget, GenReport, GenRules, Pool, PoolTemplate, PoolWhence, SlotPicker,
    SlotSupply, SourceSet, TemplateSlotInput,
};
use crate::state::AppState;

// ─────────────────────────────────────────────────────────── шаблоны

#[tauri::command]
pub async fn list_templates(state: State<'_, Arc<AppState>>) -> Result<Vec<PoolTemplate>> {
    state.db.with(tpl_db::list)
}

#[tauri::command]
pub async fn get_template(state: State<'_, Arc<AppState>>, id: i64) -> Result<PoolTemplate> {
    state.db.with(|conn| tpl_db::get(conn, id))
}

#[tauri::command]
pub async fn create_template(
    state: State<'_, Arc<AppState>>,
    name: String,
) -> Result<PoolTemplate> {
    state.db.with(|conn| tpl_db::create(conn, &name))
}

/// Редактор сохраняется целиком: имя, правила, источники и все слоты одной
/// транзакцией. Частичное сохранение оставило бы шаблон с новыми правилами
/// и старыми слотами.
#[tauri::command]
pub async fn save_template(
    state: State<'_, Arc<AppState>>,
    id: i64,
    name: String,
    rules: GenRules,
    sources: Option<SourceSet>,
    slots: Vec<TemplateSlotInput>,
) -> Result<PoolTemplate> {
    state.db.with_tx(|tx| {
        tpl_db::rename(tx, id, &name)?;
        tpl_db::set_rules(tx, id, &rules)?;
        tpl_db::set_sources(tx, id, sources.as_ref())?;
        tpl_db::set_slots(tx, id, &slots)?;
        tpl_db::get(tx, id)
    })
}

#[tauri::command]
pub async fn duplicate_template(
    state: State<'_, Arc<AppState>>,
    id: i64,
) -> Result<PoolTemplate> {
    state.db.with_tx(|tx| tpl_db::duplicate(tx, id))
}

#[tauri::command]
pub async fn delete_template(state: State<'_, Arc<AppState>>, id: i64) -> Result<()> {
    state.db.with_tx(|tx| tpl_db::delete(tx, id))
}

/// Сколько карт подходит под каждый слот шаблона и что отсекло остальные.
#[tauri::command]
pub async fn template_supply(
    state: State<'_, Arc<AppState>>,
    id: i64,
) -> Result<Vec<SlotSupply>> {
    state.db.with(|conn| supply_db::template_supply(conn, id))
}

// ─────────────────────────────────────────────────────────── маппулы

#[tauri::command]
pub async fn list_pools(state: State<'_, Arc<AppState>>) -> Result<Vec<Pool>> {
    state.db.with(pool_db::list)
}

#[tauri::command]
pub async fn get_pool(state: State<'_, Arc<AppState>>, id: i64) -> Result<Pool> {
    state.db.with(|conn| pool_db::get(conn, id))
}

#[tauri::command]
pub async fn create_pool(
    state: State<'_, Arc<AppState>>,
    name: String,
    series_id: Option<i64>,
) -> Result<Pool> {
    state.db.with_tx(|tx| {
        let id = pool_db::create(tx, &name, None)?;
        if let Some(sid) = series_id {
            series_db::add_pool(tx, sid, id)?;
        }
        pool_db::get(tx, id)
    })
}

#[tauri::command]
pub async fn rename_pool(state: State<'_, Arc<AppState>>, id: i64, name: String) -> Result<i64> {
    state.db.with_tx(|tx| {
        let target = pool_db::writable(tx, id)?;
        pool_db::rename(tx, target, &name)?;
        Ok(target)
    })
}

#[tauri::command]
pub async fn set_pool_status(
    state: State<'_, Arc<AppState>>,
    id: i64,
    status: String,
) -> Result<()> {
    state.db.with(|conn| pool_db::set_status(conn, id, &status))
}

#[tauri::command]
pub async fn set_pool_display_fields(
    state: State<'_, Arc<AppState>>,
    id: i64,
    fields: Vec<String>,
) -> Result<()> {
    state
        .db
        .with(|conn| pool_db::set_display_fields(conn, id, &fields))
}

/// Свои источники пула. `null` — вернуть наследование серии или шаблона.
#[tauri::command]
pub async fn set_pool_sources(
    state: State<'_, Arc<AppState>>,
    id: i64,
    sources: Option<SourceSet>,
) -> Result<Pool> {
    state.db.with_tx(|tx| {
        let target = pool_db::writable(tx, id)?;
        pool_db::set_sources(tx, target, sources.as_ref())?;
        pool_db::get(tx, target)
    })
}

#[tauri::command]
pub async fn duplicate_pool(state: State<'_, Arc<AppState>>, id: i64) -> Result<Pool> {
    state.db.with_tx(|tx| {
        let new_id = pool_db::duplicate(tx, id, false)?;
        pool_db::get(tx, new_id)
    })
}

#[tauri::command]
pub async fn delete_pool(state: State<'_, Arc<AppState>>, id: i64) -> Result<()> {
    state.db.with_tx(|tx| pool_db::delete(tx, id))
}

// ─────────────────────────────────────────────────────────────── слоты
//
// Слоты адресуются позицией, а не id: правка сыгранного пула уводит запись
// в свежую копию, где id слотов уже другие, а порядок тот же. Каждая команда
// возвращает пул целиком — вместе с его настоящим id.

#[tauri::command]
pub async fn set_slot_beatmap(
    state: State<'_, Arc<AppState>>,
    pool_id: i64,
    position: i64,
    beatmap_id: Option<i64>,
) -> Result<Pool> {
    state.db.with_tx(|tx| {
        let target = pool_db::writable(tx, pool_id)?;
        let pool = pool_db::get(tx, target)?;
        let slot = slot_at(&pool, position)?;
        pool_db::set_slot_beatmap(tx, slot, beatmap_id)?;
        pool_db::get(tx, target)
    })
}

/// Закрепить или открепить выделенные слоты — одним действием, а не по одному.
#[tauri::command]
pub async fn set_slots_pinned(
    state: State<'_, Arc<AppState>>,
    pool_id: i64,
    positions: Vec<i64>,
    pinned: bool,
) -> Result<Pool> {
    state.db.with_tx(|tx| {
        let target = pool_db::writable(tx, pool_id)?;
        pool_db::set_slots_pinned(tx, target, &positions, pinned)?;
        pool_db::get(tx, target)
    })
}

#[tauri::command]
pub async fn set_slot_fm_mods(
    state: State<'_, Arc<AppState>>,
    pool_id: i64,
    position: i64,
    mods: Vec<String>,
) -> Result<Pool> {
    state.db.with_tx(|tx| {
        let target = pool_db::writable(tx, pool_id)?;
        let pool = pool_db::get(tx, target)?;
        let slot = slot_at(&pool, position)?;
        pool_db::set_slot_fm_mods(tx, slot, &mods)?;
        pool_db::get(tx, target)
    })
}

#[tauri::command]
pub async fn set_slots_mod(
    state: State<'_, Arc<AppState>>,
    pool_id: i64,
    positions: Vec<i64>,
    r#mod: String,
) -> Result<Pool> {
    state.db.with_tx(|tx| {
        let target = pool_db::writable(tx, pool_id)?;
        pool_db::change_slots_mod(tx, target, &positions, &r#mod)?;
        pool_db::get(tx, target)
    })
}

/// Свои источники выделенных слотов. `null` — вернуть наследование пула.
#[tauri::command]
pub async fn set_slots_sources(
    state: State<'_, Arc<AppState>>,
    pool_id: i64,
    positions: Vec<i64>,
    sources: Option<SourceSet>,
) -> Result<Pool> {
    state.db.with_tx(|tx| {
        let target = pool_db::writable(tx, pool_id)?;
        pool_db::set_slots_sources(tx, target, &positions, sources.as_ref())?;
        pool_db::get(tx, target)
    })
}

#[tauri::command]
pub async fn add_pool_slot(
    state: State<'_, Arc<AppState>>,
    pool_id: i64,
    r#mod: String,
) -> Result<Pool> {
    state.db.with_tx(|tx| {
        let target = pool_db::writable(tx, pool_id)?;
        pool_db::add_slot(tx, target, &r#mod)?;
        pool_db::get(tx, target)
    })
}

#[tauri::command]
pub async fn remove_pool_slots(
    state: State<'_, Arc<AppState>>,
    pool_id: i64,
    positions: Vec<i64>,
) -> Result<Pool> {
    state.db.with_tx(|tx| {
        let target = pool_db::writable(tx, pool_id)?;
        pool_db::remove_slots(tx, target, &positions)?;
        pool_db::get(tx, target)
    })
}

/// Новый порядок задаётся списком нынешних позиций.
#[tauri::command]
pub async fn reorder_pool_slots(
    state: State<'_, Arc<AppState>>,
    pool_id: i64,
    order: Vec<i64>,
) -> Result<Pool> {
    state.db.with_tx(|tx| {
        let target = pool_db::writable(tx, pool_id)?;
        pool_db::reorder(tx, target, &order)?;
        pool_db::get(tx, target)
    })
}

// ─────────────────────────────────────────────── импорт и экспорт JSON

/// Маппул в JSON: текст собирается здесь, файл на диск кладёт фронт
/// через Blob — файлового диалога у окна нет.
#[tauri::command]
pub async fn export_pool_json(state: State<'_, Arc<AppState>>, pool_id: i64) -> Result<String> {
    state.db.with(|conn| pool_db::export_json(conn, pool_id))
}

/// Разбор файла без записи в базу: диалог импорта показывает, сколько карт
/// уже в библиотеке, а сколько придётся скачивать с osu!.
#[tauri::command]
pub async fn import_pool_preview(
    state: State<'_, Arc<AppState>>,
    json: String,
) -> Result<pool_db::PoolImportPreview> {
    state.db.with(|conn| pool_db::preview_import(conn, &json))
}

/// Импорт файла: создаёт пул-черновик со слотами из файла.
///
/// `save_maps` — скачать карты, которых нет в библиотеке: без ключа или сети
/// они пропускаются со счётчиком, слоты остаются пустыми, а импорт не падает.
#[tauri::command]
pub async fn import_pool(
    state: State<'_, Arc<AppState>>,
    json: String,
    save_maps: bool,
) -> Result<pool_db::PoolImportResult> {
    let state = state.inner().clone();

    // Разбор и проверка — без сети и без базы: кривой файл падает понятным текстом.
    let parsed = pool_db::parse_import(&json)?;

    // Какие карты уже есть — их не трогаем, остальные кандидаты на скачивание.
    let ids = pool_db::import_beatmap_ids(&parsed);
    let known = state.db.with(|conn| pool_db::existing_beatmap_ids(conn, &ids))?;
    let missing: Vec<i64> = ids.into_iter().filter(|id| !known.contains(id)).collect();

    let mut fetched: Vec<Beatmap> = Vec::new();
    if save_maps && !missing.is_empty() {
        // Нет ключа — нет и скачивания: пул всё равно создаётся.
        if let Ok(creds) = state.credentials() {
            for chunk in missing.chunks(crate::import::BATCH) {
                state
                    .limiter
                    .acquire_reserving(crate::import::LOBBY_RESERVE)
                    .await;
                match state.osu.beatmaps(&creds, chunk).await {
                    Ok(maps) => fetched.extend(maps),
                    // Сеть лежит — дёргать её дальше бессмысленно: оставшиеся
                    // карты уходят в пропущенные.
                    Err(_) => break,
                }
            }
        }
    }

    let saved = fetched.len() as i64;
    let skipped = (missing.len() - fetched.len()) as i64;

    let pool_id = state.db.with_tx(|tx| {
        for map in &fetched {
            beatmaps::upsert(tx, map)?;
        }
        pool_db::import_pool(tx, &parsed)
    })?;

    // Обложки скачанных карт — тем же порядком, что и обычный импорт: строки
    // пула сразу выглядят обжито. В лучшем усилии: без сети обложек просто нет.
    let mut sets: Vec<i64> = fetched.iter().filter_map(|m| m.beatmapset_id).collect();
    sets.sort_unstable();
    sets.dedup();

    for set_id in sets {
        let with_set: Vec<i64> = fetched
            .iter()
            .filter(|m| m.beatmapset_id == Some(set_id))
            .map(|m| m.beatmap_id)
            .collect();

        // Файл уже в кеше — качать нечего, но путь в карту прописать надо:
        // после удаления и повторного добавления строка в базе новая.
        let path = if state.covers.has(set_id) {
            Some(state.covers.path_for(set_id).to_string_lossy().to_string())
        } else if let Ok(bytes) = state.osu.download_cover(set_id).await {
            state
                .covers
                .put(set_id, &bytes)
                .ok()
                .map(|p| p.to_string_lossy().to_string())
        } else {
            None
        };

        if let Some(path) = path {
            let _ = state.db.with(|conn| {
                for id in &with_set {
                    beatmaps::set_cover_path(conn, *id, &path)?;
                }
                Ok(())
            });
        }
    }

    let pool = state.db.with(|conn| pool_db::get(conn, pool_id))?;
    Ok(pool_db::PoolImportResult {
        pool,
        saved_maps: saved,
        skipped_maps: skipped,
    })
}

// ─────────────────────────────────────────────────────────── генерация

#[tauri::command]
pub async fn generate_pool(
    state: State<'_, Arc<AppState>>,
    template_id: i64,
    name: String,
    series_id: Option<i64>,
) -> Result<GenReport> {
    state
        .db
        .with_tx(|tx| generate::generate(tx, template_id, &name, series_id))
}

#[tauri::command]
pub async fn reroll_pool(
    state: State<'_, Arc<AppState>>,
    pool_id: i64,
    keep_pinned: bool,
) -> Result<GenReport> {
    state
        .db
        .with_tx(|tx| generate::reroll(tx, pool_id, keep_pinned))
}

/// Перекат выделенных слотов: остальные карты остаются на местах.
#[tauri::command]
pub async fn reroll_slots(
    state: State<'_, Arc<AppState>>,
    pool_id: i64,
    positions: Vec<i64>,
) -> Result<GenReport> {
    state
        .db
        .with_tx(|tx| generate::reroll_slots(tx, pool_id, &positions))
}

/// Что применяется к пулу: источники, исключения, правила и запас по слотам.
#[tauri::command]
pub async fn pool_whence(state: State<'_, Arc<AppState>>, pool_id: i64) -> Result<PoolWhence> {
    state.db.with(|conn| generate::whence(conn, pool_id))
}

/// Фильтр слота и карты, скрытые исключениями, — для панели подбора.
#[tauri::command]
pub async fn slot_picker(
    state: State<'_, Arc<AppState>>,
    pool_id: i64,
    position: i64,
) -> Result<SlotPicker> {
    state
        .db
        .with(|conn| generate::slot_candidates(conn, pool_id, position))
}

// ───────────────────────────────────────────────────────── исключения

/// Исключение у серии, пула или шаблона. Владелец приходит парой
/// «вид + id»: список у всех трёх устроен одинаково.
#[tauri::command]
pub async fn add_exclusion(
    state: State<'_, Arc<AppState>>,
    owner_kind: String,
    owner_id: i64,
    target: ExclusionTarget,
    strict: bool,
) -> Result<()> {
    state.db.with_tx(|tx| {
        let owner = Owner::parse(&owner_kind, owner_id)?;
        ex_db::add(tx, owner, &target, strict)?;
        Ok(())
    })
}

#[tauri::command]
pub async fn remove_exclusion(state: State<'_, Arc<AppState>>, id: i64) -> Result<()> {
    state.db.with_tx(|tx| ex_db::remove(tx, id))
}

#[tauri::command]
pub async fn set_exclusion_strict(
    state: State<'_, Arc<AppState>>,
    id: i64,
    strict: bool,
) -> Result<()> {
    state.db.with(|conn| ex_db::set_strict(conn, id, strict))
}

#[tauri::command]
pub async fn set_exclusion_enabled(
    state: State<'_, Arc<AppState>>,
    id: i64,
    enabled: bool,
) -> Result<()> {
    state.db.with(|conn| ex_db::set_enabled(conn, id, enabled))
}

// ──────────────────────────────────────────────────────── мелочи

fn index_at(pool: &Pool, position: i64) -> Result<usize> {
    pool_db::index_at(&pool.slots, position)
}

fn slot_at(pool: &Pool, position: i64) -> Result<i64> {
    Ok(pool.slots[index_at(pool, position)?].id)
}
