mod cache;
mod commands;
mod config;
mod db;
mod error;
mod import;
mod links;
mod model;
mod osu;
mod queue;
mod state;

use std::sync::Arc;

use tauri::Manager;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // База и кеш лежат в папке данных приложения, рядом с конфигом.
            let data_dir = app.path().app_data_dir()?;
            let state = AppState::new(data_dir)?;
            app.manage(Arc::new(state));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // состояние и ключ
            commands::system::get_status,
            commands::system::set_onboarded,
            commands::system::get_credentials,
            commands::system::save_credentials,
            commands::system::check_credentials,
            commands::system::clear_credentials,
            commands::system::get_queue_status,
            commands::system::cache_size,
            commands::system::clear_cache,
            // библиотека
            commands::library::list_beatmaps,
            commands::library::count_without_mods,
            commands::library::get_beatmap,
            commands::library::get_set_difficulties,
            commands::library::get_attributes,
            commands::library::delete_beatmaps,
            commands::library::set_beatmap_mods,
            commands::library::set_beatmap_fm_mods,
            commands::library::set_beatmap_skillsets,
            commands::library::set_beatmap_note,
            commands::library::bulk_add_mod,
            commands::library::bulk_add_skillset,
            // метки
            commands::library::list_labels,
            commands::library::create_label,
            commands::library::set_beatmap_labels,
            commands::library::bulk_add_label,
            // коллекции
            commands::collections::list_collections,
            commands::collections::list_folders,
            commands::collections::create_collection,
            commands::collections::create_smart_collection,
            commands::collections::rename_collection,
            commands::collections::set_collection_color,
            commands::collections::move_collection,
            commands::collections::duplicate_collection,
            commands::collections::delete_collection,
            commands::collections::add_to_collection,
            commands::collections::remove_from_collection,
            commands::collections::create_folder,
            commands::collections::rename_folder,
            commands::collections::delete_folder,
            // шаблоны маппулов
            commands::pools::list_templates,
            commands::pools::get_template,
            commands::pools::create_template,
            commands::pools::save_template,
            commands::pools::duplicate_template,
            commands::pools::delete_template,
            commands::pools::template_supply,
            // маппулы
            commands::pools::list_pools,
            commands::pools::get_pool,
            commands::pools::create_pool,
            commands::pools::rename_pool,
            commands::pools::set_pool_status,
            commands::pools::set_pool_display_fields,
            commands::pools::duplicate_pool,
            commands::pools::delete_pool,
            // слоты маппула
            commands::pools::set_slot_beatmap,
            commands::pools::set_slot_pinned,
            commands::pools::set_slot_fm_mods,
            commands::pools::set_slot_mod,
            commands::pools::add_pool_slot,
            commands::pools::remove_pool_slot,
            commands::pools::reorder_pool_slots,
            commands::pools::slot_filter,
            // генерация
            commands::pools::generate_pool,
            commands::pools::generate_pool_series,
            commands::pools::reroll_pool,
            commands::pools::reroll_slot,
            // импорт
            commands::imports::parse_links,
            commands::imports::import_links,
            commands::imports::retry_failed,
            commands::imports::cancel_batch,
            // игроки
            commands::players::list_players,
            commands::players::get_player,
            commands::players::create_player,
            commands::players::update_player,
            commands::players::archive_player,
            commands::players::delete_player,
            commands::players::player_stats,
            commands::players::fetch_player_avatar,
            commands::players::refresh_player_avatars,
            // турниры
            commands::tournaments::list_tournaments,
            commands::tournaments::get_tournament,
            commands::tournaments::create_tournament,
            commands::tournaments::rename_tournament,
            commands::tournaments::set_tournament_rules,
            commands::tournaments::delete_tournament,
            commands::tournaments::add_tournament_player,
            commands::tournaments::remove_tournament_player,
            commands::tournaments::set_tournament_seeds,
            commands::tournaments::set_tournament_player_color,
            commands::tournaments::set_tournament_pools,
            commands::tournaments::start_tournament,
            commands::tournaments::confirm_tournament,
            commands::tournaments::reopen_tournament,
            commands::tournaments::tournament_bracket,
            commands::tournaments::tournament_pool_overlaps,
            commands::tournaments::finish_tournament,
            // матчи
            commands::matches::match_state,
            commands::matches::set_match_pool,
            commands::matches::set_match_first_ban,
            commands::matches::ban_slot,
            commands::matches::pick_slot,
            commands::matches::record_result,
            commands::matches::undo_match_action,
            commands::matches::set_match_walkover,
            commands::matches::set_match_manual_result,
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить приложение");
}
