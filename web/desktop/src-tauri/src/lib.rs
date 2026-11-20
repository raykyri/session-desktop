//! Session for Mac (phase 3): the web client in a Tauri window, with its
//! replica and outbox in SQLite and its device token in the Keychain.
//!
//! - `tauri-plugin-sql` opens the replica's file (`sqlite:replica-<handle>.sqlite`,
//!   under the app's configuration directory) and runs `execute` and
//!   `select`; `sql_batch` (`sql.rs`) runs a batch in one transaction on the
//!   plugin's pool for the same file, as `SqliteStorage` needs.
//! - `keychain_get`, `keychain_set` and `keychain_delete` (`keychain.rs`)
//!   keep one Keychain item: the device token, the device's id, the person's
//!   handle and their account as last read.
//! - `app_about` (`about.rs`) is what the app tells the server about the Mac
//!   when it asks for a sign-in.
//! - `tauri-plugin-opener` opens the browser's approval page.

mod about;
mod keychain;
mod sql;

/// The Keychain service: the app's identifier (`tauri.conf.json`).
pub const KEYCHAIN_SERVICE: &str = "dev.session.spaces";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .manage(keychain::Keychain::system(KEYCHAIN_SERVICE))
        .invoke_handler(tauri::generate_handler![
            sql::sql_batch,
            keychain::keychain_get,
            keychain::keychain_set,
            keychain::keychain_delete,
            about::app_about,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Session");
}
