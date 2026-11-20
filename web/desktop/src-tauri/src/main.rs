// Prevents an extra console window on Windows in release; the app is macOS
// only, and this keeps the template's behaviour if that changes.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    session_desktop_lib::run()
}
