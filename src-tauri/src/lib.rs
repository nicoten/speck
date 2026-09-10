mod agent;
mod commands;
mod library;
pub mod openspec;
mod tasks;
mod watch;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state = commands::init_state(app.handle());
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_project,
            commands::read_doc,
            commands::library_list,
            commands::library_add,
            commands::library_remove,
            commands::cli_info,
            commands::start_agent_session,
            commands::stop_agent_session,
            commands::running_sessions,
            commands::set_task_done,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
