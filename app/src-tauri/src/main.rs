// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::Docs::default())
        .invoke_handler(tauri::generate_handler![
            commands::launch_path,
            commands::roots,
            commands::list_dir,
            commands::path_chain,
            commands::path_kind,
            commands::open_document,
            commands::new_document,
            commands::load_settings,
            commands::save_settings,
            commands::close_document,
            commands::index_status,
            commands::disk_changed,
            commands::detect_dialect,
            commands::view,
            commands::edit,
            commands::undo,
            commands::redo,
            commands::copy,
            commands::edit_box,
            commands::copy_box,
            commands::replace_all,
            commands::save,
            commands::save_as,
            commands::set_encoding,
            commands::save_converted,
            commands::find,
            commands::cancel_find,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
