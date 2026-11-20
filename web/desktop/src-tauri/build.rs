// The app's commands are declared here (an app manifest), so the page may
// call only those `capabilities/default.json` grants, from the app's own
// pages (review round 1 of phase 3, finding 6).

const COMMANDS: &[&str] = &[
    "replica_open",
    "replica_select",
    "replica_batch",
    "replica_close",
    "replica_delete",
    "keychain_get",
    "keychain_set",
    "keychain_delete",
    "app_about",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
