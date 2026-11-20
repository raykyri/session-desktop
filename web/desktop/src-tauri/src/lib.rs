//! Session for Mac (phase 3): the web client in a Tauri window, with its
//! replica and outbox in SQLite and its device token in the Keychain.
//!
//! - `replica_*` (`replica.rs`): each person's replica, one SQLite file
//!   under the app's data directory that the page names by the person's
//!   handle; the process holds an exclusive lock on the file it opened.
//! - `keychain_get`, `keychain_set` and `keychain_delete` (`keychain.rs`)
//!   keep one Keychain item: the device token, the device's id, the person's
//!   handle and their account as last read.
//! - `app_about` (`about.rs`) is what the app tells the server about the Mac
//!   when it asks for a sign-in.
//! - `tauri-plugin-opener` opens http, https and mailto links in the
//!   system's apps (`capabilities/default.json` scopes it); a page that asks
//!   for a new window (`window.open`, a link with `target="_blank"`) gets
//!   none, and an http or https link opens in the browser (`links.rs`).
//! - `tauri-plugin-single-instance`: starting the app again focuses the
//!   window that is open.
//!
//! The app's commands are reachable only as `capabilities/default.json`
//! grants them (`build.rs` declares them), from the app's own pages.

use std::sync::Arc;

use tauri::{Manager, Runtime, WebviewWindowBuilder};

mod about;
mod keychain;
mod links;
mod replica;

pub use replica::Replicas;

/// The app on a runtime: its plugins (but the single instance), commands
/// and state, and its window. The tests run it on Tauri's mock runtime.
pub fn app<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            replica::replica_open,
            replica::replica_select,
            replica::replica_batch,
            replica::replica_close,
            replica::replica_delete,
            keychain::keychain_get,
            keychain::keychain_set,
            keychain::keychain_delete,
            about::app_about,
        ])
        .setup(|app| {
            // the Keychain service and the data directory are the app's
            // identifier's, so a dev build (`tauri.dev.conf.json`) keeps
            // its own
            if app.try_state::<keychain::Keychain>().is_none() {
                app.manage(keychain::Keychain::system(&app.config().identifier));
            }
            if app.try_state::<Arc<Replicas>>().is_none() {
                let dir = app.path().app_data_dir()?;
                app.manage(Arc::new(Replicas::new(dir)));
            }
            // the window, made here to take the new-window handler
            if let Some(config) = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
            {
                let handle = app.handle().clone();
                WebviewWindowBuilder::from_config(app.handle(), &config)?
                    .on_new_window(move |url, _| links::new_window(&handle, &url))
                    .build()?;
            }
            Ok(())
        })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // the single-instance plugin first: a second process hands over and
    // exits before anything else starts
    let builder =
        tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    app(builder)
        .run(tauri::generate_context!())
        .expect("error while running Session");
}

#[cfg(test)]
mod acl_tests;
