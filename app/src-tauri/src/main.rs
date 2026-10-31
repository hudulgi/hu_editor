// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::Docs::default())
        .invoke_handler(tauri::generate_handler![
            commands::launch_path,
            commands::open_document,
            commands::close_document,
            commands::index_status,
            commands::disk_changed,
            commands::view,
            commands::find,
            commands::cancel_find,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
