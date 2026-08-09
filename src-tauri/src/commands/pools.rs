use std::sync::Arc;

use tauri::State;

use crate::db::{generate, pools as pool_db, templates as tpl_db};
use crate::error::Result;
use crate::model::{
    GenReport, GenRules, LibraryFilter, Pool, PoolTemplate, SlotSupply, TemplateSlotInput,
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

/// Редактор сохраняется целиком: имя, правила и все слоты одной транзакцией.
/// Частичное сохранение оставило бы шаблон с новыми правилами и старыми слотами.
#[tauri::command]
pub async fn save_template(
    state: State<'_, Arc<AppState>>,
    id: i64,
    name: String,
    rules: GenRules,
    slots: Vec<TemplateSlotInput>,
) -> Result<PoolTemplate> {
    state.db.with_tx(|tx| {
        tpl_db::rename(tx, id, &name)?;
        tpl_db::set_rules(tx, id, &rules)?;
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
    state.db.with(|conn| tpl_db::delete(conn, id))
}

#[tauri::command]
pub async fn template_supply(
    state: State<'_, Arc<AppState>>,
    id: i64,
) -> Result<Vec<SlotSupply>> {
    state.db.with(|conn| tpl_db::supply(conn, id))
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
pub async fn create_pool(state: State<'_, Arc<AppState>>, name: String) -> Result<Pool> {
    state.db.with_tx(|tx| {
        let id = pool_db::create(tx, &name, None)?;
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

#[tauri::command]
pub async fn duplicate_pool(state: State<'_, Arc<AppState>>, id: i64) -> Result<Pool> {
    state.db.with_tx(|tx| {
        let new_id = pool_db::duplicate(tx, id, false)?;
        pool_db::get(tx, new_id)
    })
}

#[tauri::command]
pub async fn delete_pool(state: State<'_, Arc<AppState>>, id: i64) -> Result<()> {
    state.db.with(|conn| pool_db::delete(conn, id))
}

// ─────────────────────────────────────────────────────────────── слоты
//
// Правка слота может уехать в свежую копию, если пул уже сыгран, поэтому
// каждая такая команда возвращает пул целиком — вместе с его настоящим id.

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

#[tauri::command]
pub async fn set_slot_pinned(
    state: State<'_, Arc<AppState>>,
    pool_id: i64,
    position: i64,
    pinned: bool,
) -> Result<Pool> {
    state.db.with_tx(|tx| {
        let target = pool_db::writable(tx, pool_id)?;
        let pool = pool_db::get(tx, target)?;
        let slot = slot_at(&pool, position)?;
        pool_db::set_slot_pinned(tx, slot, pinned)?;
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
pub async fn set_slot_mod(
    state: State<'_, Arc<AppState>>,
    pool_id: i64,
    position: i64,
    r#mod: String,
) -> Result<Pool> {
    state.db.with_tx(|tx| {
        let target = pool_db::writable(tx, pool_id)?;
        pool_db::change_slot_mod(tx, target, position, &r#mod)?;
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
pub async fn remove_pool_slot(
    state: State<'_, Arc<AppState>>,
    pool_id: i64,
    position: i64,
) -> Result<Pool> {
    state.db.with_tx(|tx| {
        let target = pool_db::writable(tx, pool_id)?;
        pool_db::remove_slot(tx, target, position)?;
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

// ─────────────────────────────────────────────────────────── генерация

#[tauri::command]
pub async fn generate_pool(
    state: State<'_, Arc<AppState>>,
    template_id: i64,
    name: String,
) -> Result<GenReport> {
    state
        .db
        .with_tx(|tx| generate::generate(tx, template_id, &name))
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

#[tauri::command]
pub async fn reroll_slot(
    state: State<'_, Arc<AppState>>,
    pool_id: i64,
    position: i64,
) -> Result<GenReport> {
    state.db.with_tx(|tx| {
        let target = pool_db::writable(tx, pool_id)?;
        let pool = pool_db::get(tx, target)?;
        let slot = slot_at(&pool, position)?;
        generate::reroll_slot(tx, target, slot)
    })
}

/// Фильтр библиотеки, суженный под слот: тот же, по которому шла генерация.
/// Без него панель подбора предлагала бы карты, которые генерация не взяла бы.
#[tauri::command]
pub async fn slot_filter(
    state: State<'_, Arc<AppState>>,
    pool_id: i64,
    position: i64,
) -> Result<LibraryFilter> {
    state.db.with(|conn| {
        let pool = pool_db::get(conn, pool_id)?;
        let index = index_at(&pool, position)?;
        let mod_tag = pool.slots[index].mod_tag.clone();

        let Some(template_id) = pool.template_id else {
            return Ok(LibraryFilter {
                mods: vec![mod_tag],
                ..LibraryFilter::default()
            });
        };

        let template = tpl_db::get(conn, template_id)?;
        match template.slots.iter().find(|t| t.mod_tag == mod_tag) {
            Some(slot) => Ok(tpl_db::slot_filter(slot, &template.rules)),
            None => Ok(LibraryFilter {
                mods: vec![mod_tag],
                ..LibraryFilter::default()
            }),
        }
    })
}

// ──────────────────────────────────────────────────────── мелочи

fn index_at(pool: &Pool, position: i64) -> Result<usize> {
    pool_db::index_at(&pool.slots, position)
}

fn slot_at(pool: &Pool, position: i64) -> Result<i64> {
    Ok(pool.slots[index_at(pool, position)?].id)
}
