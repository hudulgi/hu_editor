// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::Docs::default())
        .manage(commands::WindowStarts::default())
        .manage(commands::FileSearches::default())
        .invoke_handler(tauri::generate_handler![
            commands::launch_path,
            commands::notices_path,
            commands::read_clipboard,
            commands::roots,
            commands::list_dir,
            commands::path_chain,
            commands::path_kind,
            commands::create_file,
            commands::create_dir,
            commands::rename_path,
            commands::paste,
            commands::delete_path,
            commands::reveal_path,
            commands::open_url,
            commands::open_terminal,
            commands::write_clipboard,
            commands::open_document,
            commands::new_document,
            commands::load_settings,
            commands::save_settings,
            commands::close_document,
            commands::retain_document,
            commands::document_windows,
            commands::open_window,
            commands::window_start,
            commands::index_status,
            commands::disk_changed,
            commands::detect_dialect,
            commands::render_markdown,
            commands::image_data,
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
            commands::count_matches,
            commands::matches_in,
            commands::replacement_for,
            commands::cancel_find,
            commands::toggle_line_comment,
            commands::toggle_block_comment,
            commands::search_files,
            commands::cancel_search_files,
            commands::replace_in_files,
            commands::move_lines,
            commands::copy_lines,
            commands::duplicate_selection,
            commands::block_around,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
