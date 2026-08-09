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
            // импорт
            commands::imports::parse_links,
            commands::imports::import_links,
            commands::imports::retry_failed,
            commands::imports::cancel_batch,
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить приложение");
}
