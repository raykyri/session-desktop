mod adapters;
mod browser_backend;
mod browser_engine;
mod claude_sdk;
mod config;
mod connection_limit;
mod control_socket;
mod events;
mod file_server;
mod github_auth;
mod headless_process;
mod human_browser;
mod launch_path;
mod legacy_files;
mod native_support;
mod persistence;
mod research;
mod research_anchors;
mod research_artifacts;
mod research_images;
mod research_recap;
mod research_runtime;
mod research_widgets;
mod show_hide_shortcut;
mod sleep;
mod state;
mod thread_graph;
mod title_generation;
mod transcript;
mod tweets;
mod updater;
mod user_notifications;
mod wikilinks;
mod workspace;

use config::{RuntimeConfig, SessionConfig};
use control_socket::start_control_socket;
use native_support::{
    native_support_set_browser_background, native_support_set_browser_overlay_open,
    native_support_set_iframe_shortcut_fallback,
};
use research::{
    ApplyResearchRecapCandidateRequest, CreateResearchTreeRequest, GenerateResearchRecapRequest,
    RecentResearchQueryCursor, ResearchBranchRemoval, ResearchDraft, ResearchFolderState,
    ResearchHighlight, ResearchHighlightAnchor, ResearchHighlightFeedItem, ResearchNode,
    ResearchNodeContent, ResearchNodeView, ResearchRecapCandidate, ResearchTree,
    ResearchTreeDetail, ResearchTreeSummary, UpdateResearchDocumentRequest,
    UpdateResearchDocumentResult,
};
use show_hide_shortcut::{
    show_hide_shortcut_capture_set, show_hide_shortcut_get, show_hide_shortcut_set,
};
use sleep::SleepGuard;
use state::{AppState, ResearchRelaunch};
use tauri::{Manager, Url};
use workspace::{
    AgentInfo, AgentStatus, GroupInfo, create_research_workspace,
    ensure_default_research_workspace, move_research_workspace, remove_research_workspace,
    rename_research_workspace, validate_launch_workspace,
};

fn handle_global_shortcut(
    app: &tauri::AppHandle,
    shortcut: &tauri_plugin_global_shortcut::Shortcut,
    event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
    show_hide_shortcut::handle_global_shortcut(app, shortcut, event);
}

/// Menu ids for the custom items installed by `customize_app_menu`.
#[cfg(desktop)]
const QUIT_MENU_ID: &str = "session-quit";
#[cfg(desktop)]
const NEW_WINDOW_MENU_ID: &str = "session-new-window";
#[cfg(desktop)]
const RELOAD_INTERFACE_MENU_ID: &str = "session-reload-interface";

/// Reworks the default menu for Session's single-window behavior:
///
/// - Adds "New Window" to the otherwise-empty File menu. Since Session owns one shared
///   session in one window, the action surfaces that window rather than constructing
///   a second webview over the same state.
/// - Adds "Reload Interface" to the View menu. It is native (rather than a DOM
///   shortcut) so it remains usable when WebKit's renderer is unhealthy, and reloads
///   only the webview while preserving research processes.
/// - Strips the native "Close Window" items (⌘W on macOS, Alt+F4 elsewhere) so the
///   webview receives ⌘W itself and the frontend handles it.
/// - On macOS, replaces the predefined "Quit" item with our own ⌘Q item. The native
///   item is hard-wired to Cocoa's `terminate:` selector, which tao does not intercept
///   (it implements `applicationWillTerminate:` but not `applicationShouldTerminate:`),
///   so ⌘Q would terminate the process instantly — bypassing both the `CloseRequested`
///   and `ExitRequested` handlers and quitting without confirmation even while agents
///   are running. Our replacement emits a `MenuEvent` we handle in `on_menu_event`.
///
/// Every other default item is preserved — notably the Edit menu that wires up ⌘C/⌘V/⌘A.
#[cfg(desktop)]
fn customize_app_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::MenuItemBuilder;
    use tauri::menu::{Menu, MenuItemKind};

    let menu = Menu::default(app.handle())?;
    for item in menu.items()? {
        let MenuItemKind::Submenu(submenu) = item else {
            continue;
        };
        let submenu_label = submenu.text()?.replace('&', "");
        if submenu_label == "File" {
            let new_window = MenuItemBuilder::with_id(NEW_WINDOW_MENU_ID, "New Window")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;
            submenu.insert(&new_window, 0)?;
        }
        if submenu_label == "View" {
            let reload_interface =
                MenuItemBuilder::with_id(RELOAD_INTERFACE_MENU_ID, "Reload Interface")
                    .accelerator("CmdOrCtrl+Alt+R")
                    .build(app)?;
            submenu.insert(&reload_interface, 0)?;
        }
        for (index, sub_item) in submenu.items()?.into_iter().enumerate() {
            let MenuItemKind::Predefined(predefined) = &sub_item else {
                continue;
            };
            // Match against the (mnemonic-stripped) label so platform copies line up.
            let label = predefined.text().unwrap_or_default().replace('&', "");
            if label == "Close Window" || label == "Close" {
                submenu.remove(predefined)?;
                continue;
            }
            // The macOS predefined Quit reads "Quit <app>"; preserve its label and
            // slot, but back it with our own handler instead of `terminate:`.
            #[cfg(target_os = "macos")]
            if label.starts_with("Quit") {
                let replacement = MenuItemBuilder::with_id(QUIT_MENU_ID, &label)
                    .accelerator("CmdOrCtrl+Q")
                    .build(app)?;
                submenu.remove(predefined)?;
                submenu.insert(&replacement, index)?;
            }
            // Only the macOS Quit replacement needs the item's slot.
            #[cfg(not(target_os = "macos"))]
            let _ = index;
        }
    }
    app.set_menu(menu)?;
    Ok(())
}

/// Handles the custom application menu items.
#[cfg(desktop)]
fn handle_app_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    if event.id().as_ref() == NEW_WINDOW_MENU_ID {
        show_main_window(app);
        return;
    }
    if event.id().as_ref() == RELOAD_INTERFACE_MENU_ID {
        reload_main_webview(app);
        return;
    }
    if event.id().as_ref() != QUIT_MENU_ID {
        return;
    }
    let Some(state) = app.try_state::<AppState>() else {
        app.exit(0);
        return;
    };
    if state.should_confirm_exit() {
        state.request_exit_confirmation();
    } else {
        app.exit(0);
    }
}

#[tauri::command(async)]
fn get_runtime_config(state: tauri::State<'_, AppState>) -> Result<RuntimeConfig, String> {
    let mut runtime = state.config().runtime();
    runtime.file_server_port = state.file_server_port();
    Ok(runtime)
}

#[tauri::command(async)]
fn probe_agent_adapters(
    state: tauri::State<'_, AppState>,
    force: Option<bool>,
) -> Result<Vec<adapters::AdapterMetadata>, String> {
    adapters::probe_adapter_metadata_for_config(state.config(), force.unwrap_or(false))
}

#[cfg(target_os = "macos")]
fn open_path_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("failed to open {}: {err}", path.display()))
}

#[cfg(target_os = "linux")]
fn open_path_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("failed to open {}: {err}", path.display()))
}

#[cfg(target_os = "windows")]
fn open_path_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("failed to open {}: {err}", path.display()))
}

/// Surfaces a fatal startup error in a native dialog, for GUI (Finder/Dock)
/// launches that have no terminal to show the `eprintln`. Best-effort: if
/// `osascript` fails the message is still on stderr for a terminal launch.
#[cfg(target_os = "macos")]
fn notify_fatal_startup(message: &str) {
    // AppleScript string literals escape backslash and double-quote; embedded
    // newlines are fine inside the quoted literal.
    let escaped = message.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "display dialog \"{escaped}\" with title \"Session\" buttons {{\"Quit\"}} default button \"Quit\" with icon stop"
    );
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .status();
}

#[cfg(not(target_os = "macos"))]
fn notify_fatal_startup(_message: &str) {}

/// Surfaces a non-fatal startup warning (persisted state moved aside, entries
/// dropped during recovery) in a native dialog without blocking startup.
/// Best-effort: the message is already on stderr for terminal launches.
///
/// Uses the dialog plugin (as the folder picker does) rather than spawning
/// `osascript`: `show` is non-blocking and cross-platform, the message needs no
/// AppleScript escaping, and there is no unreaped child left as a zombie.
fn notify_startup_warning(app: &tauri::AppHandle, message: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

    app.dialog()
        .message(message)
        .title("Session")
        .kind(MessageDialogKind::Warning)
        .show(|_| {});
}

/// Shows the native folder chooser in-process and returns the selected path, or
/// `None` when the user cancels. Blocks the calling thread, so callers must be
/// `#[tauri::command(async)]` (the panel itself is dispatched to the main thread
/// by the plugin).
fn pick_folder_dialog(app: &tauri::AppHandle, title: &str) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let mut dialog = app.dialog().file().set_title(title);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    match dialog.blocking_pick_folder() {
        Some(path) => path
            .into_path()
            .map(|p| Some(p.to_string_lossy().into_owned()))
            .map_err(|err| format!("folder chooser returned an unusable path: {err}")),
        None => Ok(None),
    }
}

/// Opens a URL in the user's default external browser (or mail client). Only
/// http(s)/mailto are accepted; the URL is passed as a single argv to the OS opener
/// (no shell), so it can't trigger arbitrary scheme handlers or shell injection.
#[tauri::command(async)]
fn open_external_url(state: tauri::State<'_, AppState>, url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:")) {
        return Err("refusing to open a non-http(s)/mailto URL externally".to_string());
    }
    if let Some(port) = state.file_server_port()
        && is_file_server_url(&url, port)
    {
        return Err(
            "refusing to open a file-server URL externally (would leak the access token)"
                .to_string(),
        );
    }
    open_in_os_browser(&url)
}

fn validated_preview_url(url: &str, file_server_port: u16) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|err| format!("invalid Session preview URL: {err}"))?;
    if parsed.scheme() != "http"
        || !matches!(parsed.host_str(), Some("127.0.0.1" | "localhost"))
        || parsed.port_or_known_default() != Some(file_server_port)
    {
        return Err("refusing to resolve a URL outside the Session file server".to_string());
    }
    Ok(parsed)
}

/// Opens the source file behind a protected Session preview without disclosing the
/// preview capability to the external application. The URL is validated against
/// the live file-server port and resolved through the same thread roots/exact grants
/// enforced by the server before it becomes a file:// URL.
#[tauri::command(async)]
fn browser_open_preview_external(
    state: tauri::State<'_, AppState>,
    url: String,
) -> Result<(), String> {
    let port = state
        .file_server_port()
        .ok_or_else(|| "the file server is not running".to_string())?;
    let parsed = validated_preview_url(&url, port)?;
    // A widget's stored HTML is a fragment written for the sandboxed widget
    // page; a browser would load it from file:// without that page's CSP.
    if parsed.path().starts_with(research_widgets::URL_PREFIX) {
        return Err("Answer widgets open only in Session's browser".to_string());
    }
    let source = file_server::resolve_tokenized_file_path(&state, parsed.path())?;
    let mut file_url = Url::from_file_path(&source)
        .map_err(|_| format!("failed to build a file URL for {}", source.display()))?;
    file_url.set_fragment(parsed.fragment());
    open_in_os_browser(file_url.as_str())
}

/// A local link from a research thread, resolved and authorized for preview.
/// `path` is the canonical source file; `url` is its token-scoped preview URL.
struct ResolvedLocalLink {
    url: String,
    sandbox: bool,
    path: std::path::PathBuf,
}

/// Resolves a local link in a research thread. Absolute paths resolve as-is;
/// relative ones resolve against the thread's workspace folder. Either way the
/// canonical result must lie under the thread's roots and outside Session's
/// private state (`file_server::resolve_under_thread_roots`).
fn resolve_local_link_target(
    state: &AppState,
    owner_id: &str,
    path: &str,
) -> Result<ResolvedLocalLink, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("nothing to open".to_string());
    }
    let requested = std::path::Path::new(trimmed);
    let requested = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        state.owner_working_dir(owner_id)?.join(requested)
    };
    // Checks the owner before the path, so an unknown owner is reported as such.
    let token = state.owner_file_token(owner_id)?;
    let canonical = file_server::resolve_under_thread_roots(state, owner_id, &requested)
        .ok_or_else(|| format!("'{trimmed}' was not found"))?;
    let port = state
        .file_server_port()
        .ok_or_else(|| "the file server is not running".to_string())?;
    let token = if file_server::is_executable_preview_path(&canonical) {
        state.exact_file_preview_token(owner_id, &canonical)?
    } else {
        token
    };
    Ok(ResolvedLocalLink {
        url: file_server::file_url(port, &token, &canonical),
        sandbox: true,
        path: canonical,
    })
}

fn open_local_link(
    state: &AppState,
    owner_id: &str,
    resolved: ResolvedLocalLink,
) -> Result<serde_json::Value, String> {
    let source = &resolved.path;
    if !source.is_file() || !file_server::is_browser_previewable_path(source) {
        reveal_path_in_file_manager(source)?;
        return Ok(serde_json::json!({
            "disposition": "revealed",
            "url": null,
            "sandbox": false,
        }));
    }
    state.emit(events::SessionEvent::new(
        "browser.open",
        Some(owner_id.to_string()),
        None,
        serde_json::json!({
            "url": resolved.url,
            "sandbox": resolved.sandbox,
        }),
    ));
    Ok(serde_json::json!({
        "disposition": "preview",
        "url": resolved.url,
        "sandbox": resolved.sandbox,
    }))
}

/// Open a validated local link using the safest useful default: known
/// browser-renderable files get a token-scoped sandboxed preview, while
/// directories and unknown/binary formats are only revealed in the OS file
/// manager. In particular, clicking an installer or disk image never mounts or
/// launches it.
#[tauri::command(async)]
fn browser_open_local_path(
    state: tauri::State<'_, AppState>,
    owner_id: String,
    path: String,
) -> Result<serde_json::Value, String> {
    let resolved = resolve_local_link_target(&state, &owner_id, &path)?;
    open_local_link(&state, &owner_id, resolved)
}

/// Reveal a validated local link without opening or executing it.
#[tauri::command(async)]
fn browser_reveal_local_path(
    state: tauri::State<'_, AppState>,
    owner_id: String,
    path: String,
) -> Result<(), String> {
    let resolved = resolve_local_link_target(&state, &owner_id, &path)?;
    reveal_path_in_file_manager(&resolved.path)
}

/// Deliberate context-menu action for handing a validated local link to its OS
/// default application. Unlike the primary click path, this may mount a disk
/// image or launch an application, so the frontend never calls it implicitly.
#[tauri::command(async)]
fn browser_open_local_path_external(
    state: tauri::State<'_, AppState>,
    owner_id: String,
    path: String,
) -> Result<(), String> {
    let resolved = resolve_local_link_target(&state, &owner_id, &path)?;
    open_path_with_default_app(&resolved.path)
}

#[cfg(target_os = "macos")]
fn open_path_with_default_app(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("failed to open {}: {err}", path.display()))
}

#[cfg(not(target_os = "macos"))]
fn open_path_with_default_app(path: &std::path::Path) -> Result<(), String> {
    open_path_in_file_manager(path)
}

#[cfg(target_os = "macos")]
fn reveal_path_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("failed to reveal {}: {err}", path.display()))
}

#[cfg(not(target_os = "macos"))]
fn reveal_path_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    let parent = path.parent().unwrap_or(path);
    open_path_in_file_manager(parent)
}

/// Grants `path` to a research thread's previews and opens it in the thread's
/// sandboxed browser overlay with the Codex fragment renderer.
fn open_codex_visualization(
    state: &AppState,
    owner_id: String,
    path: &std::path::Path,
) -> Result<serde_json::Value, String> {
    let canonical = state.grant_owner_file_preview(&owner_id, path)?;
    let port = state
        .file_server_port()
        .ok_or_else(|| "the file server is not running".to_string())?;
    let token = state.exact_file_preview_token(&owner_id, &canonical)?;
    let url = format!(
        "{}?codex-inline-vis=1",
        file_server::file_url(port, &token, &canonical)
    );
    state.emit(events::SessionEvent::new(
        "browser.open",
        Some(owner_id),
        None,
        serde_json::json!({ "url": url, "sandbox": true }),
    ));
    Ok(serde_json::json!({ "url": url, "sandbox": true }))
}

/// Resolve and open the HTML fragment named by a transcript
/// `::codex-inline-vis` directive. The file name is untrusted transcript text;
/// the sessions and the visualization root come only from Session state: the
/// file must belong to exactly one of the thread's Codex sessions.
#[tauri::command(async)]
async fn browser_open_codex_inline_visualization(
    state: tauri::State<'_, AppState>,
    owner_id: String,
    file: String,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let session_ids = state.owner_codex_session_ids(&owner_id)?;
        if session_ids.is_empty() {
            return Err("this thread has no Codex session with visualizations".to_string());
        }
        let visualization_root = state
            .config()
            .workspace_root
            .join(".codex")
            .join("visualizations");
        let file = file.trim();
        let mut matches = Vec::new();
        let mut last_error = None;
        for session_id in &session_ids {
            match file_server::resolve_codex_inline_visualization(
                &visualization_root,
                session_id,
                file,
            ) {
                Ok(path) => matches.push(path),
                Err(err) => last_error = Some(err),
            }
        }
        let path = match matches.as_slice() {
            [only] => only.clone(),
            [] => {
                return Err(last_error
                    .unwrap_or_else(|| format!("Codex visualization '{file}' was not found")));
            }
            _ => return Err(format!("Codex visualization '{file}' is ambiguous")),
        };
        open_codex_visualization(&state, owner_id, &path)
    })
    .await
    .map_err(|err| format!("browser_open_codex_inline_visualization task failed: {err}"))?
}

/// Resolve and open an absolute HTML-fragment path from the current Codex
/// `visualize` content-reference contract. The transcript path is untrusted:
/// it must resolve beneath the thread's roots or Session's durable designs
/// directory before it receives an exact preview grant.
#[tauri::command(async)]
async fn browser_open_codex_visualization_reference(
    state: tauri::State<'_, AppState>,
    owner_id: String,
    path: String,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if state.owner_codex_session_ids(&owner_id)?.is_empty() {
            return Err(
                "visualization references can only be opened for a Codex session".to_string(),
            );
        }
        let designs_root = state.config().workspace_root.join("designs");
        let path = file_server::resolve_codex_visualization_reference(
            &designs_root,
            &state.owner_file_roots(&owner_id),
            std::path::Path::new(path.trim()),
        )?;
        open_codex_visualization(&state, owner_id, &path)
    })
    .await
    .map_err(|err| format!("browser_open_codex_visualization_reference task failed: {err}"))?
}

fn is_file_server_url(url: &str, port: u16) -> bool {
    url.starts_with(&format!("http://127.0.0.1:{port}/"))
        || url.starts_with(&format!("http://localhost:{port}/"))
}

#[cfg(target_os = "macos")]
fn open_in_os_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("failed to open externally: {err}"))
}

#[cfg(target_os = "linux")]
fn open_in_os_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("failed to open externally: {err}"))
}

#[cfg(target_os = "windows")]
fn open_in_os_browser(url: &str) -> Result<(), String> {
    // Avoid `cmd /C start`: Rust quotes argv by MSVCRT rules, but cmd.exe re-parses
    // `&|<>^` outside double quotes, so a URL like https://x/?a=1&b=2 would be split
    // (and the tail run as a separate command). Invoke the protocol handler directly
    // via rundll32 — no shell is involved, so the URL reaches the handler intact.
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("failed to open externally: {err}"))
}

// The list/refetch commands below are async on purpose, not because their
// reads are slow (each is a short clone under the model lock) but because sync
// commands run on the macOS main thread: the frontend calls them in bursts on
// every agent/research event, exactly while backend threads (research
// settle, the persist snapshot) hold the model lock, so a sync command would
// block the main thread on that mutex and turn every research start/stop into
// a visible stall.
#[tauri::command]
async fn list_groups(state: tauri::State<'_, AppState>) -> Result<Vec<GroupInfo>, String> {
    state.list_groups()
}

#[tauri::command]
async fn ensure_default_research_workspace_command(
    state: tauri::State<'_, AppState>,
) -> Result<GroupInfo, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || ensure_default_research_workspace(&state))
        .await
        .map_err(|err| format!("ensure_default_research_workspace task failed: {err}"))?
}

#[tauri::command]
async fn research_workspace_create_pick(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<GroupInfo>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        match pick_folder_dialog(&app, "Select a research folder")? {
            Some(path) => create_research_workspace(&state, None, path).map(Some),
            None => Ok(None),
        }
    })
    .await
    .map_err(|err| format!("research_workspace_create_pick task failed: {err}"))?
}

#[tauri::command]
fn research_workspace_rename(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
    name: Option<String>,
) -> Result<GroupInfo, String> {
    rename_research_workspace(&state, &workspace_id, name)
}

#[tauri::command]
async fn research_workspace_move_pick(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<Option<GroupInfo>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        match pick_folder_dialog(&app, "Select a new location for this research folder")? {
            Some(path) => move_research_workspace(&state, &workspace_id, path).map(Some),
            None => Ok(None),
        }
    })
    .await
    .map_err(|err| format!("research_workspace_move_pick task failed: {err}"))?
}

#[tauri::command]
fn research_workspace_remove(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<String>, String> {
    remove_research_workspace(&state, &workspace_id)
}

#[tauri::command]
fn research_workspace_reveal(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<(), String> {
    let workspace = state
        .list_research_workspaces()?
        .into_iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| format!("research workspace {workspace_id} was not found"))?;
    let path = std::path::Path::new(&workspace.dir);
    if !path.is_dir() {
        return Err(format!(
            "research folder '{}' is unavailable",
            workspace.dir
        ));
    }
    open_path_in_file_manager(path)
}

#[tauri::command]
async fn list_agents(state: tauri::State<'_, AppState>) -> Result<Vec<AgentInfo>, String> {
    state.list_agents()
}

#[tauri::command]
async fn list_research_trees(
    state: tauri::State<'_, AppState>,
    include_archived: Option<bool>,
) -> Result<Vec<ResearchTreeSummary>, String> {
    if include_archived.unwrap_or(false) {
        state.list_research_trees_with_archived(true)
    } else {
        state.list_research_trees()
    }
}

#[tauri::command]
fn reorder_research_trees(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
    archived: bool,
    tree_ids: Vec<String>,
) -> Result<(), String> {
    state.reorder_research_trees(&workspace_id, archived, tree_ids)
}

#[tauri::command]
fn list_research_folders(state: tauri::State<'_, AppState>) -> Result<ResearchFolderState, String> {
    state.research_folders()
}

#[tauri::command]
fn set_research_folders(
    state: tauri::State<'_, AppState>,
    folders: ResearchFolderState,
) -> Result<ResearchFolderState, String> {
    state.set_research_folders(folders)
}

#[tauri::command]
fn list_research_drafts(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<ResearchDraft>, String> {
    state.list_research_drafts(&workspace_id)
}

/// `images` replaces the draft's images and reads each file; None keeps
/// them. Runs off the main thread: the file reads and the state write (when
/// images are released) can be slow.
#[tauri::command]
async fn save_research_draft(
    state: tauri::State<'_, AppState>,
    id: Option<String>,
    workspace_id: String,
    prompt: String,
    images: Option<Vec<research_images::ImageInput>>,
) -> Result<ResearchDraft, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let images = images
            .map(|images| {
                research_images::attachments_for_inputs(&state.config().workspace_root, &images)
            })
            .transpose()?;
        state.save_research_draft_with_images(id, &workspace_id, prompt, images)
    })
    .await
    .map_err(|err| format!("save_research_draft task failed: {err}"))?
}

#[tauri::command]
fn delete_research_draft(
    state: tauri::State<'_, AppState>,
    draft_id: String,
) -> Result<(), String> {
    state.delete_research_draft(&draft_id)
}

#[tauri::command]
fn reorder_research_drafts(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
    draft_ids: Vec<String>,
) -> Result<Vec<ResearchDraft>, String> {
    state.reorder_research_drafts(&workspace_id, draft_ids)
}

#[tauri::command]
async fn list_research_activity(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ResearchNodeView>, String> {
    state
        .list_research_activity()
        .map(|nodes| nodes.iter().map(ResearchNode::view).collect())
}

#[tauri::command]
fn list_research_highlights(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ResearchHighlightFeedItem>, String> {
    state.list_research_highlights()
}

#[tauri::command]
async fn list_recent_activity(
    state: tauri::State<'_, AppState>,
    limit: Option<usize>,
    before: Option<RecentResearchQueryCursor>,
) -> Result<research::RecentActivityPage, String> {
    state.list_recent_activity(limit.unwrap_or(50), before)
}

#[tauri::command]
async fn list_recent_activity_for_trees(
    state: tauri::State<'_, AppState>,
    tree_ids: Vec<String>,
) -> Result<Vec<research::RecentResearchQuery>, String> {
    state.list_recent_activity_for_trees(&tree_ids)
}

#[tauri::command]
async fn get_research_tree(
    state: tauri::State<'_, AppState>,
    tree_id: String,
) -> Result<ResearchTreeDetail, String> {
    // A thread in the Trash does not open; Restore brings it back first.
    let detail = state.research_tree(&tree_id)?;
    if detail.tree.is_trashed() {
        return Err(format!(
            "research tree {tree_id} is in the Trash; restore it to open it"
        ));
    }
    Ok(detail)
}

#[tauri::command]
async fn create_research_tree(
    state: tauri::State<'_, AppState>,
    request: CreateResearchTreeRequest,
    images: Option<Vec<research_images::ImageInput>>,
) -> Result<ResearchTreeDetail, String> {
    let state = state.inner().clone();
    let mut attachments = tweets::resolve_research_message_attachments(&request.prompt).await;
    tauri::async_runtime::spawn_blocking(move || {
        // Probe before inserting a tree or reserving an agent. The frontend
        // performs the same preflight before creating a default workspace, but
        // this backend guard also covers stale UI state and direct IPC callers.
        adapters::ensure_adapter_ready_for_research(state.config(), &request.adapter)?;
        attachments.extend(research_images::attachments_for_inputs(
            &state.config().workspace_root,
            images.as_deref().unwrap_or_default(),
        )?);
        // Admission holds the workspace-mutation guard so a concurrent folder
        // removal can't slip between validation and the node insert —
        // the spawn itself runs unguarded (it's slow, and the Queued node
        // already marks the workspace busy).
        let detail = {
            let _guard = workspace::lock_research_workspace_mutations()?;
            validate_launch_workspace(&state, &request.group_id)?;
            state.create_research_tree_with_attachments(request, attachments)?
        };
        let root = detail
            .nodes
            .first()
            .cloned()
            .ok_or_else(|| "new research tree has no root node".to_string())?;
        let workspace = match state.research_workspace_for_node(&root.id) {
            Ok(workspace) => workspace,
            Err(err) => {
                let _ = state.fail_research_node(&root.id, err.clone());
                remove_unlaunched_research_tree(&state, &detail.tree.id);
                return Err(err);
            }
        };
        match launch_fresh_research_run(
            &state,
            &root.id,
            &workspace,
            tweets::prompt_with_research_attachments(root.prompt().to_string(), root.attachments()),
        ) {
            Ok(_) => state.research_tree(&detail.tree.id),
            Err(err) => {
                remove_unlaunched_research_tree(&state, &detail.tree.id);
                Err(err)
            }
        }
    })
    .await
    .map_err(|err| format!("create_research_tree task failed: {err}"))?
}

fn launch_research_execution(
    state: &AppState,
    node: &research::ResearchNode,
    workspace: &workspace::GroupInfo,
    prompt: String,
    fork_from: Option<&workspace::AgentInfo>,
) -> Result<research::ResearchNode, String> {
    let preferences = match persistence::load_preferences(&state.config().workspace_root) {
        Ok(preferences) => preferences,
        Err(err) => {
            let _ = state.fail_research_node(&node.id, err.clone());
            return Err(err);
        }
    };
    let prompt = research::prompt_with_research_launch_instruction(
        prompt,
        preferences.research_launch_instruction.as_deref(),
    );
    let guidance = research_widgets::agent_guidance(preferences.research_inline_widgets_enabled());
    let resume = fork_from.and_then(|agent| agent.session_id.clone());
    research_runtime::launch(
        state,
        node,
        workspace,
        prompt,
        resume,
        fork_from.is_some(),
        guidance,
    )
}

/// Launches a fresh (non-forked) agent run for a research node.
/// Shared by root-run creation, retries, and document/conversation follow-ups.
fn launch_fresh_research_run(
    state: &AppState,
    node_id: &str,
    workspace: &workspace::GroupInfo,
    prompt: String,
) -> Result<research::ResearchNode, String> {
    let node = state.research_node(node_id)?;
    launch_research_execution(state, &node, workspace, prompt, None)
}

#[tauri::command]
async fn read_research_report(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&path);
        if !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            return Err("Choose a Markdown (.md) report".to_string());
        }
        std::fs::read_to_string(path).map_err(|err| format!("Could not read report: {err}"))
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn import_research_report(
    state: tauri::State<'_, AppState>,
    request: research::ImportResearchReportRequest,
) -> Result<ResearchTreeDetail, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let detail = {
            let _guard = workspace::lock_research_workspace_mutations()?;
            validate_launch_workspace(&state, &request.workspace_id)?;
            state.import_research_report(request)?
        };
        research_recap::schedule(&state, &detail.tree.root_node_id);
        Ok(detail)
    })
    .await
    .map_err(|err| format!("report import failed: {err}"))?
}

#[tauri::command]
async fn create_research_post(
    state: tauri::State<'_, AppState>,
    request: research::CreateResearchPostRequest,
) -> Result<ResearchTreeDetail, String> {
    let state = state.inner().clone();
    let attachments = tweets::resolve_research_message_attachments(&request.body).await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = workspace::lock_research_workspace_mutations()?;
        validate_launch_workspace(&state, &request.workspace_id)?;
        state.create_research_post(request, attachments)
    })
    .await
    .map_err(|err| format!("create_research_post task failed: {err}"))?
}

#[tauri::command]
async fn create_research_post_follow_up(
    state: tauri::State<'_, AppState>,
    parent_node_id: String,
    body: String,
) -> Result<ResearchNodeView, String> {
    let state = state.inner().clone();
    let attachments = tweets::resolve_research_message_attachments(&body).await;
    tauri::async_runtime::spawn_blocking(move || {
        state.create_research_post_follow_up(&parent_node_id, body, attachments)
    })
    .await
    .map_err(|err| format!("create_research_post_follow_up task failed: {err}"))?
    .map(|node| node.view())
}

#[tauri::command]
fn update_research_post(
    state: tauri::State<'_, AppState>,
    request: research::UpdateResearchPostRequest,
) -> Result<research::UpdateResearchPostResult, String> {
    state.update_research_post(request)
}

#[tauri::command]
async fn update_research_document(
    state: tauri::State<'_, AppState>,
    request: UpdateResearchDocumentRequest,
) -> Result<UpdateResearchDocumentResult, String> {
    let state = state.inner().clone();
    // Blocking: a body edit atomically replaces and fsyncs the durable response
    // snapshot before the in-memory metadata is announced. Serialize with
    // research-folder replacement/removal as well, or another window could
    // detach the tree after validation but before the edit commits.
    tauri::async_runtime::spawn_blocking(move || {
        let _workspace_guard = workspace::lock_research_workspace_mutations()?;
        state.update_research_document(request)
    })
    .await
    .map_err(|err| format!("update_research_document task failed: {err}"))?
}

/// Saves an image pasted or dropped into a research composer and returns its
/// attachment. It stays pending until a question or draft that includes it
/// is saved (see `research_images`).
#[tauri::command]
async fn save_research_image(
    state: tauri::State<'_, AppState>,
    data_base64: String,
    file_name: Option<String>,
) -> Result<tweets::ResearchMessageAttachment, String> {
    let root = state.config().workspace_root.clone();
    // Refuse an oversized image before decoding it.
    if data_base64.len() as u64 > research_images::MAX_INPUT_IMAGE_BYTES.div_ceil(3) * 4 + 4 {
        return Err(format!(
            "Images must be {} MB or smaller.",
            research_images::MAX_INPUT_IMAGE_BYTES / (1024 * 1024)
        ));
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_base64.trim())
            .map_err(|err| format!("failed to decode the image: {err}"))?;
        let image = research_images::save_pending(&root, &bytes, file_name.as_deref())?;
        research_images::sweep_stale_pending(&root, &state.research_image_ids_in_use()?);
        Ok(image)
    })
    .await
    .map_err(|err| format!("save_research_image task failed: {err}"))?
}

/// Copies an image file dropped on a research composer (the window receives
/// native drops as paths) and returns its attachment, as
/// `save_research_image` does.
#[tauri::command]
async fn import_research_image(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<tweets::ResearchMessageAttachment, String> {
    let root = state.config().workspace_root.clone();
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let image = research_images::import_pending(&root, std::path::Path::new(&path))?;
        research_images::sweep_stale_pending(&root, &state.research_image_ids_in_use()?);
        Ok(image)
    })
    .await
    .map_err(|err| format!("import_research_image task failed: {err}"))?
}

/// The thumbnail of an image attached to a research message, as a `data:`
/// URL, for message and composer strips.
#[tauri::command]
async fn read_research_image_thumbnail(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<String, String> {
    let root = state.config().workspace_root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        research_images::read_thumbnail_data_url(&root, &id)
    })
    .await
    .map_err(|err| format!("read_research_image_thumbnail task failed: {err}"))?
}

/// An image attached to a research message, as a `data:` URL.
#[tauri::command]
async fn read_research_image(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<String, String> {
    let root = state.config().workspace_root.clone();
    tauri::async_runtime::spawn_blocking(move || research_images::read_data_url(&root, &id))
        .await
        .map_err(|err| format!("read_research_image task failed: {err}"))?
}

/// The tree is committed before its root run launches so a crash mid-launch is
/// recoverable, but a root that never launched holds nothing durable. Leaving
/// retaining it after a launch failure accumulated obsolete entries the caller could not
/// even identify — the command returns the error, not the tree id — while the
/// dialog keeps the prompt for a retry. Best-effort: if the removal itself
/// fails, the failed tree remains visible (and removable) in the sidebar.
fn remove_unlaunched_research_tree(state: &AppState, tree_id: &str) {
    if let Err(err) = state.remove_unlaunched_research_tree(tree_id) {
        eprintln!("session: failed to remove unlaunched research tree {tree_id}: {err}");
    }
}

fn load_research_node_content(
    state: &AppState,
    node_id: &str,
) -> Result<ResearchNodeContent, String> {
    let mut content = state.research_node_content(&node_id)?;
    // A corrupt or oversized snapshot must not wedge the node: fall back to
    // the transcript exactly as if no snapshot existed, keeping the read
    // failure only as diagnostic context if nothing else is viewable.
    let snapshot_error = match research::read_response_snapshot_with_revision(
        &state.config().workspace_root,
        &node_id,
    ) {
        Ok(Some(snapshot)) => {
            content.response_revision = Some(snapshot.revision);
            content.turns = snapshot.turns;
            return Ok(content);
        }
        Ok(None) => None,
        Err(err) => {
            eprintln!("session: unreadable research response snapshot {node_id}: {err}");
            Some(err)
        }
    };
    if content
        .node
        .binding()
        .is_some_and(|binding| binding.transcript_path.is_some())
        && matches!(
            content.node.status(),
            research::ResearchNodeStatus::Complete
                | research::ResearchNodeStatus::Failed
                | research::ResearchNodeStatus::Cancelled
        )
    {
        let ancestor_prompts = state
            .research_node_ancestor_prompts(&node_id)
            .unwrap_or_default();
        match research::load_transcript_response(state.config(), &content.node, &ancestor_prompts) {
            Ok(turns) => content.turns = turns,
            // No snapshot, no live turns, and the adapter transcript is
            // unreadable: return the node with the failure recorded rather
            // than erroring, which would wedge the workspace on a retry
            // loop that can never succeed and hide the node entirely.
            Err(err) if content.turns.is_empty() => {
                content.source_error = Some(match snapshot_error {
                    Some(snapshot_error) => format!("{snapshot_error}; {err}"),
                    None => err,
                });
            }
            Err(_) => {}
        }
    } else if content.turns.is_empty() {
        content.source_error = snapshot_error;
    }
    Ok(content)
}

#[tauri::command]
async fn get_research_node_content(
    state: tauri::State<'_, AppState>,
    node_id: String,
) -> Result<ResearchNodeContent, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || load_research_node_content(&state, &node_id))
        .await
        .map_err(|err| format!("get_research_node_content task failed: {err}"))?
}

#[tauri::command]
async fn fork_research_node(
    state: tauri::State<'_, AppState>,
    parent_node_id: String,
    prompt: String,
    anchor: Option<research::NodeAnchor>,
    inline: Option<bool>,
    replaces_node_id: Option<String>,
    images: Option<Vec<research_images::ImageInput>>,
    // The agent, model and effort the user chose for this follow-up; None
    // keeps the one the parent's type picks (`create_research_child_with_agent`).
    agent: Option<research::AgentSpec>,
) -> Result<ResearchNodeView, String> {
    let state = state.inner().clone();
    let inline = inline.unwrap_or(false);
    let mut attachments = tweets::resolve_research_message_attachments(&prompt).await;
    tauri::async_runtime::spawn_blocking(move || {
        attachments.extend(research_images::attachments_for_inputs(
            &state.config().workspace_root,
            images.as_deref().unwrap_or_default(),
        )?);
        // Same admission guard as create_research_tree: the Queued child must
        // be admitted atomically with the workspace checks, or a concurrent
        // folder removal could invalidate its workspace before the fork.
        let (parent, workspace, child) = {
            let _guard = workspace::lock_research_workspace_mutations()?;
            let parent = state.research_node(&parent_node_id)?;
            let workspace = state.research_workspace_for_node(&parent_node_id)?;
            validate_launch_workspace(&state, &workspace.id)?;
            let child = match replaces_node_id.as_deref() {
                // Create the edited question before removing the failed node.
                // If creation fails, preserve the failed node and partial answer.
                Some(replaced) => {
                    let child = state.create_research_child_replacing(
                        &parent_node_id,
                        prompt,
                        anchor,
                        inline,
                        attachments,
                        replaced,
                        agent,
                    )?;
                    if let Err(err) = state.remove_research_branch(replaced) {
                        // A replaced branch head handed its queue to the
                        // new question; give it back before the rollback.
                        state.move_research_followups(&child.id, replaced);
                        let _ = state.remove_unsent_research_branch(&child.id);
                        return Err(err);
                    }
                    child
                }
                None => state.create_research_child_with_agent(
                    &parent_node_id,
                    prompt,
                    anchor,
                    inline,
                    attachments,
                    agent,
                )?,
            };
            (parent, workspace, child)
        };
        launch_research_child_run(&state, &parent, &workspace, &child)
    })
    .await
    .map_err(|err| format!("fork_research_node task failed: {err}"))?
    .map(|node| node.view())
}

/// Asks a follow-up at the end of the inline chain holding `node_id`: sent at
/// once when the chain's last answer can take it and nothing is queued
/// ahead, else added to the chain's queue (see `state::research_followups`).
#[tauri::command]
async fn ask_research_followup(
    state: tauri::State<'_, AppState>,
    node_id: String,
    prompt: String,
    images: Option<Vec<research_images::ImageInput>>,
    agent: Option<research::AgentSpec>,
) -> Result<state::ResearchFollowupAsk, String> {
    let state = state.inner().clone();
    let mut attachments = tweets::resolve_research_message_attachments(&prompt).await;
    tauri::async_runtime::spawn_blocking(move || {
        attachments.extend(research_images::attachments_for_inputs(
            &state.config().workspace_root,
            images.as_deref().unwrap_or_default(),
        )?);
        state.ask_research_followup(&node_id, prompt, attachments, agent)
    })
    .await
    .map_err(|err| format!("ask_research_followup task failed: {err}"))?
}

/// Removes a queued follow-up and returns its chain's queue.
#[tauri::command]
async fn cancel_research_followup(
    state: tauri::State<'_, AppState>,
    item_id: String,
) -> Result<Vec<research::ResearchFollowupQueueItem>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.cancel_research_followup(&item_id))
        .await
        .map_err(|err| format!("cancel_research_followup task failed: {err}"))?
}

/// Sends a queued follow-up whose send was refused again, and returns its
/// chain's queue.
#[tauri::command]
async fn retry_research_followup(
    state: tauri::State<'_, AppState>,
    item_id: String,
) -> Result<Vec<research::ResearchFollowupQueueItem>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.retry_research_followup(&item_id))
        .await
        .map_err(|err| format!("retry_research_followup task failed: {err}"))?
}

/// A tree's queued follow-ups, keyed by chain head.
#[tauri::command]
async fn list_research_followups(
    state: tauri::State<'_, AppState>,
    tree_id: String,
) -> Result<std::collections::HashMap<String, Vec<research::ResearchFollowupQueueItem>>, String> {
    state.research_followups(&tree_id)
}

/// Takes over the queued follow-ups earlier builds kept in the webview's
/// storage. Returns how many were added; ids already queued are skipped.
#[tauri::command]
async fn import_research_followups(
    state: tauri::State<'_, AppState>,
    items: Vec<state::LegacyQueuedResearchFollowup>,
) -> Result<usize, String> {
    let state = state.inner().clone();
    let mut items = items;
    for item in &mut items {
        item.attachments = tweets::resolve_research_message_attachments(&item.prompt).await;
    }
    tauri::async_runtime::spawn_blocking(move || state.import_research_followups(items))
        .await
        .map_err(|err| format!("import_research_followups task failed: {err}"))?
}

/// Starts the run of a follow-up asked through the queue (sent at once or
/// later), then gives it a model title as `fork_research_node`'s caller does
/// for other follow-ups. Every launch failure settles the node as Failed
/// (`launch_research_child_run`).
fn launch_queued_research_followup(state: &AppState, node: &ResearchNode) {
    let launch = (|| -> Result<(ResearchNode, workspace::GroupInfo), String> {
        let parent_id = node
            .parent_node_id
            .as_deref()
            .ok_or_else(|| "a queued follow-up has no parent".to_string())?;
        let parent = state.research_node(parent_id)?;
        let workspace = state.research_workspace_for_node(&node.id)?;
        let launched = launch_research_child_run(state, &parent, &workspace, node)?;
        Ok((launched, workspace))
    })();
    let (launched, workspace) = match launch {
        Ok(launched) => launched,
        Err(err) => {
            // Settling an already-failed node only refines its error.
            let _ = state.fail_research_node(&node.id, err.clone());
            eprintln!(
                "session: queued research follow-up {} failed to launch: {err}",
                node.id
            );
            return;
        }
    };
    // Title generation is a separate model request; its failure leaves the
    // prompt-derived title, and a title the user set meanwhile is kept.
    let state = state.clone();
    std::thread::spawn(move || {
        let Ok(title) =
            title_generation::generate_research_agent_title(state.config(), &launched, &workspace)
        else {
            return;
        };
        if state
            .research_node(&launched.id)
            .is_ok_and(|node| node.title.is_none())
        {
            let _ = state.set_research_node_title(&launched.id, title);
        }
    });
}

/// Launches the run for an admitted (Queued) research child from its parent's
/// type: posts and documents (authored, imported, transcripts) launch fresh
/// runs with saved content as context; exchanges fork the native session.
/// Shared by the fork command and retry, which relaunches a reset child
/// through the same dispatch. Every failure path settles the child as Failed
/// before returning the error.
fn launch_research_child_run(
    state: &AppState,
    parent: &ResearchNode,
    workspace: &GroupInfo,
    child: &ResearchNode,
) -> Result<ResearchNode, String> {
    let prompt =
        tweets::prompt_with_research_attachments(child.prompt().to_string(), child.attachments());
    // A highlight-targeted follow-up sends the quoted passage with the
    // question. Only the sent prompt includes the quote; the child's
    // displayed prompt stays the bare question, which boundary matching
    // still finds as a normalized substring of the sent prompt.
    let question = match child.passage_anchor() {
        Some(anchor) => research::query_followup_prompt(&anchor.exact, &prompt),
        None => prompt,
    };
    // Without a session to fork, launch a fresh run with the parent's saved
    // content as context. Display only the child's question, which remains
    // a substring of the sent prompt for response-boundary matching.
    let context_prompt = match parent.follow_up_launch() {
        research::FollowUpLaunch::Fork => None,
        research::FollowUpLaunch::Context(research::FollowUpContext::Document) => {
            Some(state.research_document_followup_prompt(&parent.id, &question))
        }
        research::FollowUpLaunch::Context(research::FollowUpContext::Snapshot) => {
            // For exported conversations and imported reports, pass the prompt
            // and anchor separately. The prompt builder neutralizes tags in the
            // quoted passage as it does for serialized turns, then wraps it.
            Some(state.research_snapshot_followup_prompt(
                &parent.id,
                &tweets::prompt_with_research_attachments(
                    child.prompt().to_string(),
                    child.attachments(),
                ),
                child.passage_anchor(),
            ))
        }
        research::FollowUpLaunch::Context(research::FollowUpContext::Post) => {
            Some(state.research_post_followup_prompt(&parent.id, &question))
        }
    };
    if let Some(launch_prompt) = context_prompt {
        let launch_prompt = match launch_prompt {
            Ok(launch_prompt) => launch_prompt,
            Err(err) => {
                let _ = state.fail_research_node(&child.id, err.clone());
                return Err(err);
            }
        };
        return launch_fresh_research_run(state, &child.id, workspace, launch_prompt);
    }
    // A forked parent is an exchange; its binding names the session.
    let binding = parent.binding().cloned().unwrap_or_default();
    let live_source = binding
        .agent_id
        .as_deref()
        .and_then(|agent_id| state.agent(agent_id).ok().flatten());
    let mut source = match live_source {
        Some(source) => source,
        None => {
            let session_id = match binding.native_session_id.clone() {
                Some(session_id) => session_id,
                None => {
                    let err =
                        "the parent research session has no native session id to fork".to_string();
                    let _ = state.fail_research_node(&child.id, err.clone());
                    return Err(err);
                }
            };
            AgentInfo {
                id: binding
                    .agent_id
                    .clone()
                    .unwrap_or_else(|| format!("research-source-{}", parent.id)),
                group_id: parent.group_id.clone(),
                adapter: parent.adapter().to_string(),
                worktree_dir: binding.worktree_dir.clone(),
                session_id: Some(session_id.clone()),
                transcript_path: binding.transcript_path.clone(),
                status: AgentStatus::Done,
                model: parent.model().map(str::to_string),
                effort: parent.effort().map(str::to_string),
                thread_id: None,
                branch_id: None,
                created_at: parent.created_at,
                pane_id: None,
            }
        }
    };
    // Native checkpoints come from the parent run, but execution ownership
    // and cwd always come from the tree's current durable workspace.
    source.group_id = workspace.id.clone();
    source.worktree_dir = workspace.dir.clone();
    // The follow-up runs at the child's (inherited) effort, applied by the
    // adapter's fork path the same way `model` is re-applied.
    source.effort = child.effort().map(str::to_string);
    launch_research_execution(state, child, workspace, question, Some(&source))
}

/// Retries a Failed (or Cancelled) research run in place: the node keeps its
/// id and every launch input, is reset back to `Queued`, and relaunches
/// through the same machinery that launched it originally — a fresh spawn for
/// roots, the parent-kind dispatch for children. On a launch failure the node
/// settles as Failed again with the new error; unlike `create_research_tree`
/// there is no freshly created tree to roll back.
#[tauri::command]
async fn retry_research_node(
    state: tauri::State<'_, AppState>,
    node_id: String,
) -> Result<ResearchTreeDetail, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        relaunch_research_node(&state, &node_id, ResearchRelaunch::Retry)
    })
    .await
    .map_err(|err| format!("retry_research_node task failed: {err}"))?
}

/// Reruns a settled exchange in place: as `retry_research_node`, but a
/// Complete answer is accepted too and replaced by the new run. Follow-ups
/// already sent from it keep their answers.
#[tauri::command]
async fn rerun_research_node(
    state: tauri::State<'_, AppState>,
    node_id: String,
) -> Result<ResearchTreeDetail, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        relaunch_research_node(&state, &node_id, ResearchRelaunch::Rerun)
    })
    .await
    .map_err(|err| format!("rerun_research_node task failed: {err}"))?
}

fn relaunch_research_node(
    state: &AppState,
    node_id: &str,
    relaunch: ResearchRelaunch,
) -> Result<ResearchTreeDetail, String> {
    // Same admission guard as create/fork: the node must flip back to Queued
    // atomically with the workspace checks, or a concurrent folder removal
    // could invalidate its workspace before the relaunch. The reset itself
    // refuses anything that is not a settled run of the kind `relaunch`
    // accepts, so a double-click cannot relaunch twice.
    let node = {
        let _guard = workspace::lock_research_workspace_mutations()?;
        let node = state.research_node(node_id)?;
        validate_launch_workspace(state, &node.group_id)?;
        match relaunch {
            ResearchRelaunch::Retry => state.reset_research_node_for_retry(node_id)?,
            ResearchRelaunch::Rerun => {
                // A rerun replaces an answer that may be Complete: refuse
                // before the reset when the parent cannot anchor the
                // relaunch, rather than settle the node as Failed below.
                if let Some(parent_id) = node.parent_node_id.as_deref() {
                    if state.research_node(parent_id)?.status()
                        != research::ResearchNodeStatus::Complete
                    {
                        return Err(
                            "the answer this question follows must complete before it can be rerun"
                                .to_string(),
                        );
                    }
                }
                state.reset_research_node_for_rerun(node_id)?
            }
        }
    };
    // Failures past this point must settle the re-queued node: leaving it
    // Queued would pin the tree as an active run nothing ever finishes.
    let workspace = match state.research_workspace_for_node(node_id) {
        Ok(workspace) => workspace,
        Err(err) => {
            let _ = state.fail_research_node(node_id, err.clone());
            return Err(err);
        }
    };
    let launch = match node.parent_node_id.as_deref() {
        None => launch_fresh_research_run(
            state,
            &node.id,
            &workspace,
            tweets::prompt_with_research_attachments(node.prompt().to_string(), node.attachments()),
        ),
        Some(parent_id) => {
            let parent = match state.research_node(parent_id) {
                Ok(parent) => parent,
                Err(err) => {
                    let _ = state.fail_research_node(&node.id, err.clone());
                    return Err(err);
                }
            };
            // The original fork required a completed parent; a parent that
            // has since been re-run (or whose checkpoint regressed) cannot
            // anchor the relaunch.
            if parent.status() != research::ResearchNodeStatus::Complete {
                let err = "research follow-ups require a completed parent response".to_string();
                let _ = state.fail_research_node(&node.id, err.clone());
                return Err(err);
            }
            launch_research_child_run(state, &parent, &workspace, &node)
        }
    };
    launch?;
    state.research_tree(&node.tree_id)
}

#[tauri::command]
async fn cancel_research_node(
    state: tauri::State<'_, AppState>,
    node_id: String,
) -> Result<ResearchNodeView, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.cancel_research_node(&node_id))
        .await
        .map_err(|err| format!("cancel_research_node task failed: {err}"))?
        .map(|node| node.view())
}

#[tauri::command]
fn rename_research_tree(
    state: tauri::State<'_, AppState>,
    tree_id: String,
    title: String,
) -> Result<ResearchTree, String> {
    state.rename_research_tree(&tree_id, title)
}

#[tauri::command]
fn rename_research_node(
    state: tauri::State<'_, AppState>,
    node_id: String,
    title: String,
) -> Result<ResearchNodeView, String> {
    state
        .set_research_node_title(&node_id, title)
        .map(|node| node.view())
}

#[tauri::command]
fn set_research_chain_order(
    state: tauri::State<'_, AppState>,
    head_node_id: String,
    node_ids: Vec<String>,
) -> Result<ResearchNodeView, String> {
    state
        .set_research_chain_order(&head_node_id, node_ids)
        .map(|node| node.view())
}

#[tauri::command]
async fn create_research_highlight(
    state: tauri::State<'_, AppState>,
    node_id: String,
    anchor: ResearchHighlightAnchor,
) -> Result<ResearchHighlight, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.create_research_highlight(&node_id, anchor))
        .await
        .map_err(|err| format!("research highlight task failed: {err}"))?
}

#[tauri::command]
async fn remove_research_highlights(
    state: tauri::State<'_, AppState>,
    node_id: String,
    highlight_ids: Vec<String>,
) -> Result<Vec<ResearchHighlight>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state.remove_research_highlights(&node_id, &highlight_ids)
    })
    .await
    .map_err(|err| format!("research highlight task failed: {err}"))?
}

#[tauri::command]
async fn mark_research_tree_viewed(
    state: tauri::State<'_, AppState>,
    tree_id: String,
) -> Result<ResearchTree, String> {
    state.mark_research_tree_viewed(&tree_id)
}

#[tauri::command]
fn archive_research_tree(
    state: tauri::State<'_, AppState>,
    tree_id: String,
) -> Result<ResearchTree, String> {
    state.archive_research_tree(&tree_id)
}

#[tauri::command]
fn restore_research_tree(
    state: tauri::State<'_, AppState>,
    tree_id: String,
) -> Result<ResearchTree, String> {
    state.restore_research_tree(&tree_id)
}

/// Deletes a tree permanently, whether or not it is in the Trash.
#[tauri::command]
fn remove_research_tree(state: tauri::State<'_, AppState>, tree_id: String) -> Result<(), String> {
    state.remove_research_tree(&tree_id)
}

#[tauri::command]
fn trash_research_tree(
    state: tauri::State<'_, AppState>,
    tree_id: String,
) -> Result<ResearchTree, String> {
    state.trash_research_tree(&tree_id)
}

#[tauri::command]
fn restore_research_tree_from_trash(
    state: tauri::State<'_, AppState>,
    tree_id: String,
) -> Result<ResearchTree, String> {
    state.restore_research_tree_from_trash(&tree_id)
}

#[tauri::command]
fn list_research_trash(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ResearchTreeSummary>, String> {
    state.list_research_trash()
}

/// Deletes the trees in one workspace's Trash; returns their ids.
#[tauri::command]
fn empty_research_trash(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<String>, String> {
    state.empty_research_trash(Some(&workspace_id))
}

#[tauri::command]
fn remove_research_branch(
    state: tauri::State<'_, AppState>,
    node_id: String,
) -> Result<ResearchBranchRemoval, String> {
    state.remove_research_branch(&node_id)
}

/// Returns the stored research launch instruction (empty string when unset).
/// The backend owns this preference — see AppPreferences — because research
/// launch prompts are assembled on the Rust side.
#[tauri::command(async)]
fn research_launch_instruction_get(state: tauri::State<'_, AppState>) -> Result<String, String> {
    Ok(
        persistence::load_preferences(&state.config().workspace_root)?
            .research_launch_instruction
            .unwrap_or_default(),
    )
}

/// Persists the research launch instruction. An empty/whitespace value clears
/// it (launches send prompts unchanged); a value over the byte cap is refused.
#[tauri::command(async)]
fn research_launch_instruction_set(
    state: tauri::State<'_, AppState>,
    instruction: String,
) -> Result<(), String> {
    let instruction = research::sanitized_research_launch_instruction(&instruction)?;
    persistence::update_preferences(&state.config().workspace_root, move |preferences| {
        preferences.research_launch_instruction = instruction;
    })
}

/// The stored choice of whether research answers render `session-html` blocks
/// as widgets and research launches include the widget guidance. `None` when
/// never set, which launches treat as on; the frontend then keeps its local
/// setting and stores it.
#[tauri::command(async)]
fn research_inline_widgets_get(state: tauri::State<'_, AppState>) -> Result<Option<bool>, String> {
    Ok(persistence::load_preferences(&state.config().workspace_root)?.research_inline_widgets)
}

#[tauri::command(async)]
fn research_inline_widgets_set(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    persistence::update_preferences(&state.config().workspace_root, move |preferences| {
        preferences.research_inline_widgets = Some(enabled);
    })
}

/// Stores every named revision of `artifact_id` found in the tree's settled
/// answers, so folding an answer or turning widgets off cannot remove it from
/// the artifact's history. Each answer is read again only when its node
/// record or response snapshot changed since the last index of this tree.
/// Returns the number of sources that could not be stored.
fn index_research_artifact(
    state: &AppState,
    tree_id: &str,
    artifact_id: &str,
) -> Result<usize, String> {
    use std::hash::{Hash, Hasher};
    let root = state.config().workspace_root.clone();
    let tree = state.research_tree(tree_id)?;
    let nodes = tree
        .nodes
        .iter()
        .filter(|node| !node.status().is_active())
        .map(|node| {
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            serde_json::to_string(node)
                .unwrap_or_default()
                .hash(&mut hasher);
            research::response_snapshot_stamp(&root, &node.id).hash(&mut hasher);
            (node.id.clone(), hasher.finish())
        })
        .collect::<Vec<_>>();
    research_artifacts::index_tree(&root, tree_id, artifact_id, &nodes, |node_id| {
        let content = load_research_node_content(state, node_id)?;
        Ok(content
            .turns
            .iter()
            .filter(|turn| turn.role == "assistant")
            .flat_map(|turn| &turn.blocks)
            .filter_map(|block| match block {
                transcript::TurnBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect())
    })
}

/// Stores the revision of a displayed widget. Only this source is read: a
/// declared parent that is not stored yet leaves the revision a root
/// (`unresolvedParent`) until the parent is stored, by its own display or by
/// opening the artifact's history.
#[tauri::command(async)]
fn research_artifact_register(
    state: tauri::State<'_, AppState>,
    input: research_artifacts::ArtifactInput,
) -> Result<research_artifacts::ArtifactRevision, String> {
    research_artifacts::register(&state.config().workspace_root, input)
}

/// Lists an artifact's revisions after indexing the whole tree.
#[tauri::command(async)]
fn research_artifact_history(
    state: tauri::State<'_, AppState>,
    tree_id: String,
    artifact_id: String,
) -> Result<serde_json::Value, String> {
    let unresolved = index_research_artifact(&state, &tree_id, &artifact_id)?;
    let revisions =
        research_artifacts::history(&state.config().workspace_root, &tree_id, &artifact_id)?;
    Ok(serde_json::json!({ "revisions": revisions, "unresolved": unresolved }))
}

#[tauri::command(async)]
fn research_artifact_state_get(
    state: tauri::State<'_, AppState>,
    reference: research_artifacts::ArtifactRef,
) -> Result<research_artifacts::ArtifactState, String> {
    research_artifacts::get_state(&state.config().workspace_root, &reference)
}

#[tauri::command(async)]
fn research_artifact_state_update(
    state: tauri::State<'_, AppState>,
    reference: research_artifacts::ArtifactRef,
    action: String,
    value: Option<serde_json::Value>,
) -> Result<research_artifacts::ArtifactState, String> {
    research_artifacts::update_state(&state.config().workspace_root, &reference, &action, value)
}

/// Exports the authored HTML only after the reader chooses a destination,
/// wrapped by `research_widgets::download_document` in the static page's
/// policy (no scripts, no network), since the file opens outside Session's
/// sandbox.
#[tauri::command(async)]
fn research_widget_download(app: tauri::AppHandle, html: String) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    if html.len() > research_widgets::MAX_WIDGET_BYTES {
        return Err("widget exceeds the HTML size limit".into());
    }
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Download widget HTML")
        .set_file_name("session-widget.html")
        .add_filter("HTML", &["html"]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let Some(path) = dialog.blocking_save_file() else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|err| err.to_string())?;
    std::fs::write(path, research_widgets::download_document(&html))
        .map_err(|err| format!("could not save widget: {err}"))?;
    Ok(true)
}

/// Stores one `session-html` block from a research answer under its content
/// hash and returns its static and run URLs on the file server. The HTML comes
/// from answer text the frontend already displays; the URLs only ever load in
/// sandboxed frames under the widget CSP (see `research_widgets`).
#[tauri::command(async)]
async fn research_widget_prepare(
    state: tauri::State<'_, AppState>,
    html: String,
) -> Result<research_widgets::WidgetUrls, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let port = state
            .file_server_port()
            .ok_or_else(|| "the file server is not running".to_string())?;
        let hash = research_widgets::store(&state.config().workspace_root, &html)?;
        research_widgets::widget_urls(port, &hash)
    })
    .await
    .map_err(|err| format!("research_widget_prepare task failed: {err}"))?
}

/// Marks the webview's session-event listener as live. Until this arrives (and
/// again after any page navigation clears it, see `on_page_load` below), the
/// native shortcut classifiers decline to consume chords: their events would
/// be dropped by Tauri with nobody subscribed, turning consumed keystrokes
/// into nothing.
#[tauri::command]
fn mark_events_listener_ready() {
    native_support::set_events_listener_ready(true);
}

#[tauri::command]
fn interface_draft_get(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<Option<String>, String> {
    state.interface_draft(&key)
}

#[tauri::command]
fn interface_draft_set(
    state: tauri::State<'_, AppState>,
    key: String,
    value: Option<String>,
) -> Result<(), String> {
    state.set_interface_draft(&key, value)
}

#[tauri::command]
fn app_confirm_exit(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.mark_exit_confirmed();
    app.exit(0);
    Ok(())
}

/// Whether the frontend has reported its first meaningful paint. Read by the
/// startup watchdog so it only force-shows the window when the frontend never
/// booted — not when the user has already seen the window and hidden it again.
static WINDOW_READY_REPORTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[derive(Default)]
struct InterfaceHealthState {
    generation: u64,
    acknowledged: bool,
    reload_claimed: bool,
}

/// Correlates native post-wake probes, document acknowledgements, compositor
/// failures, and the single reload they may request. Keeping the whole state
/// under one mutex makes the reload claim atomic with the generation check:
/// the Rust event-loop timeout and Swift snapshot timeout can race, but only
/// one of them can reload the current document.
struct InterfaceHealthTracker {
    state: std::sync::Mutex<InterfaceHealthState>,
}

impl InterfaceHealthTracker {
    const fn new() -> Self {
        Self {
            state: std::sync::Mutex::new(InterfaceHealthState {
                generation: 0,
                acknowledged: false,
                reload_claimed: false,
            }),
        }
    }

    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn begin(&self) -> u64 {
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        state.generation = state.generation.wrapping_add(1);
        state.acknowledged = false;
        state.reload_claimed = false;
        state.generation
    }

    fn acknowledge(&self, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        if state.generation != generation {
            return false;
        }
        state.acknowledged = true;
        true
    }

    fn cancel(&self) {
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        state.generation = state.generation.wrapping_add(1);
        state.acknowledged = false;
        state.reload_claimed = false;
    }

    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn claim_unanswered_reload(&self, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        if state.generation != generation || state.acknowledged || state.reload_claimed {
            return false;
        }
        state.reload_claimed = true;
        true
    }

    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn claim_reload(&self, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        if state.generation != generation || state.reload_claimed {
            return false;
        }
        state.reload_claimed = true;
        true
    }

    /// True when a deferred reload retry for `generation` is still meaningful
    /// (same generation, not yet claimed, and still unanswered when required).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn reload_still_pending(&self, generation: u64, require_unanswered: bool) -> bool {
        let state = self.state.lock().unwrap_or_else(|err| err.into_inner());
        if state.generation != generation || state.reload_claimed {
            return false;
        }
        if require_unanswered && state.acknowledged {
            return false;
        }
        true
    }
}

static INTERFACE_HEALTH: InterfaceHealthTracker = InterfaceHealthTracker::new();
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const INTERFACE_HEALTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

pub(crate) fn cancel_interface_health_probe() {
    INTERFACE_HEALTH.cancel();
}

#[tauri::command]
fn acknowledge_interface_health_probe(generation: u64) {
    let _ = INTERFACE_HEALTH.acknowledge(generation);
}

/// Called by AppKit after a wake, suspension gap, pressure recovery, or display
/// transition once Session is visible. The native side separately snapshots
/// WKWebView to exercise the compositor; this event/ack round trip waits for
/// frontend animation frames and proves the document can still schedule paint.
#[cfg(desktop)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn begin_interface_health_probe(state: AppState) -> u64 {
    let generation = INTERFACE_HEALTH.begin();
    state.emit(events::SessionEvent::new(
        "app.interface_health_probe",
        None,
        None,
        serde_json::json!({ "generation": generation }),
    ));
    std::thread::spawn(move || {
        std::thread::sleep(INTERFACE_HEALTH_TIMEOUT);
        request_unhealthy_interface_reload(
            state,
            generation,
            true,
            "frontend did not paint and acknowledge the interface recovery probe",
        );
    });
    generation
}

/// How long to wait before retrying a health-driven reload that was deferred
/// because the main window was unfocused, minimized, or hidden. Short enough
/// that returning to Session recovers a hung document quickly; claim helpers
/// no-op if the generation was cancelled or already reloaded.
#[cfg(desktop)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const INTERFACE_HEALTH_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(2);

/// Called by the native WKWebView snapshot watchdog when the compositor fails
/// or never completes. Reload only the webview; research processes stay
/// alive through the same reset path as the manual recovery command.
#[cfg(desktop)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn request_unhealthy_interface_reload(
    state: AppState,
    generation: u64,
    require_unanswered: bool,
    reason: &'static str,
) {
    let Some(app_handle) = state.app_handle() else {
        return;
    };
    let app_handle_on_main = app_handle.clone();
    let state_for_retry = state.clone();
    let _ = app_handle.run_on_main_thread(move || {
        let Some(window) = app_handle_on_main.get_webview_window("main") else {
            return;
        };
        let eligible = window.is_visible().unwrap_or(false)
            && !window.is_minimized().unwrap_or(true)
            && window.is_focused().unwrap_or(false);
        if !eligible {
            // Do not claim the generation while ineligible — a later focus may
            // still need to reload. Reschedule only while the probe is still
            // open so an overnight unfocused window does not spin threads.
            if INTERFACE_HEALTH.reload_still_pending(generation, require_unanswered) {
                std::thread::spawn(move || {
                    std::thread::sleep(INTERFACE_HEALTH_RETRY_DELAY);
                    request_unhealthy_interface_reload(
                        state_for_retry,
                        generation,
                        require_unanswered,
                        reason,
                    );
                });
            }
            return;
        }
        let claimed = if require_unanswered {
            INTERFACE_HEALTH.claim_unanswered_reload(generation)
        } else {
            INTERFACE_HEALTH.claim_reload(generation)
        };
        if !claimed {
            return;
        }
        eprintln!("session: {reason}; reloading interface");
        reload_main_webview(&app_handle_on_main);
    });
}

/// The window starts hidden (`visible: false` in tauri.conf.json) so startup
/// never shows a blank translucent shell while the session restores and the
/// webview boots. The frontend calls this once its boot snapshot is applied —
/// the first paint the user sees is the restored session. A watchdog in setup
/// shows the window anyway if the frontend never reports in.
#[tauri::command]
fn app_window_ready(app: tauri::AppHandle) -> Result<(), String> {
    WINDOW_READY_REPORTED.store(true, std::sync::atomic::Ordering::Relaxed);
    show_main_window(&app);
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Clears document-owned native routing without touching research processes.
/// This is safe before the native host is initialized (the first page-load
/// callback can run before setup) and idempotent across an explicit reload plus
/// its ensuing PageLoadEvent::Started callback.
fn prepare_main_webview_reload(app: Option<&tauri::AppHandle>) {
    cancel_interface_health_probe();
    native_support::set_events_listener_ready(false);
    if let Some(app) = app {
        human_browser::reset_all(app);
    }
    let _ = native_support::prepare_for_webview_reload();
}

#[cfg(desktop)]
fn reload_main_webview(app: &tauri::AppHandle) {
    prepare_main_webview_reload(Some(app));
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("session: cannot reload interface because the main webview is missing");
        return;
    };
    if let Err(err) = window.reload() {
        eprintln!("session: failed to reload interface: {err}");
    }
}

/// Arms or releases the macOS wake lock. The frontend calls this whenever its
/// "prevent sleep" setting or the set of running agents changes.
#[tauri::command(async)]
fn app_set_prevent_sleep(guard: tauri::State<'_, SleepGuard>, active: bool) -> Result<(), String> {
    guard.set_active(active)
}

#[tauri::command(async)]
async fn generate_research_agent_title(
    state: tauri::State<'_, AppState>,
    node_id: String,
) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let node = state.research_node(&node_id)?;
        if node.node_type() != research::ResearchNodeType::Exchange {
            return Err("only research runs can generate model titles".to_string());
        }
        let workspace = state.research_workspace_for_node(&node_id)?;
        title_generation::generate_research_agent_title(state.config(), &node, &workspace)
    })
    .await
    .map_err(|err| format!("research title task failed: {err}"))?
}

#[tauri::command]
fn research_recap_default_instructions() -> String {
    research_recap::DEFAULT_RECAP_INSTRUCTIONS.to_string()
}

#[tauri::command(async)]
async fn generate_research_recap_candidate(
    state: tauri::State<'_, AppState>,
    request: GenerateResearchRecapRequest,
) -> Result<ResearchRecapCandidate, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let instructions = research_recap::validate_instructions(&request.instructions)?;
        let model = request
            .model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if model
            .is_some_and(|value| value.chars().count() > 256 || value.chars().any(char::is_control))
        {
            return Err("recap model name is invalid".to_string());
        }
        let adapter =
            adapters::ensure_adapter_ready_for_research(state.config(), request.adapter.trim())?;
        if !adapter.supports_recap_generation {
            return Err(format!(
                "{} does not support recap generation",
                adapter.label
            ));
        }
        let node = state.research_node(&request.node_id)?;
        if !node.recap_eligible() || node.status() != research::ResearchNodeStatus::Complete {
            return Err("only completed research runs can generate recaps".to_string());
        }
        let snapshot = research::read_response_snapshot_with_revision(
            &state.config().workspace_root,
            &node.id,
        )?
        .ok_or_else(|| "the completed research answer is unavailable".to_string())?;
        if snapshot.revision != request.expected_response_revision {
            return Err("the answer changed; reopen recap generation and try again".to_string());
        }
        let answer = research_recap::recap_source_for_node(&node, &snapshot.turns)
            .ok_or_else(|| "the answer is not eligible for recap generation".to_string())?;
        let workspace = state.research_workspace_for_node(&node.id)?;
        let text = title_generation::generate_research_recap_with(
            state.config(),
            &node,
            &workspace,
            &answer,
            &adapter.id,
            model,
            instructions,
        )?;
        Ok(ResearchRecapCandidate {
            id: adapters::new_uuid_v4()?,
            text,
            response_revision: snapshot.revision,
            generated_at: state::now_millis(),
            adapter: adapter.id,
            model: model.map(str::to_string),
            instructions: instructions.to_string(),
        })
    })
    .await
    .map_err(|err| format!("recap generation task failed: {err}"))?
}

#[tauri::command(async)]
fn apply_research_recap_candidate(
    state: tauri::State<'_, AppState>,
    request: ApplyResearchRecapCandidateRequest,
) -> Result<ResearchNodeView, String> {
    state
        .apply_research_recap_candidate(request)
        .map(|node| node.view())
}

pub(crate) fn ensure_rustls_crypto_provider() -> Result<(), String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    rustls::crypto::CryptoProvider::get_default()
        .map(|_| ())
        .ok_or_else(|| "failed to install the rustls ring crypto provider".to_string())
}

fn main() {
    ensure_rustls_crypto_provider().unwrap_or_else(|err| {
        eprintln!("{err}");
        std::process::exit(1);
    });
    match session_cli::run_cli_if_requested() {
        Ok(true) => return,
        Ok(false) => {}
        Err(err) => {
            let (message, exit_code) = session_cli::error_report(&err);
            eprintln!("{message}");
            std::process::exit(exit_code);
        }
    }

    let config = SessionConfig::load().unwrap_or_else(|err| {
        eprintln!("{err}");
        std::process::exit(1);
    });
    let state = AppState::new(config);

    let exit_state = state.clone();

    let builder = tauri::Builder::default()
        // Registered first so a duplicate launch exits before setup() can replace the
        // control socket and respawn the persisted session alongside the running
        // instance. Instances are deduped per app identifier and user session; the
        // second launch hands off to this callback in the surviving process, which
        // just surfaces the existing window. (CLI subcommands returned above and
        // never get here, so `session open` etc. are unaffected.)
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(handle_global_shortcut)
                .build(),
        )
        .on_window_event({
            let state = state.clone();
            move |_window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if state.should_confirm_exit() {
                        api.prevent_close();
                        state.request_exit_confirmation();
                    }
                }
            }
        })
        .on_menu_event(handle_app_menu_event)
        // A page navigation (reload, dev HMR full-reload) tears down the old
        // document's session-event listener and all DOM-owned native routing.
        // Reset both so native shortcut classifiers stop consuming chords and
        // stale pointer/keyboard ownership cannot outlive the old document.
        .on_page_load(|webview, payload| {
            // The quick-launch webview has its own event subscription. Loading
            // or reloading it must not revoke the main document's native
            // shortcut readiness.
            if webview.label() == "main"
                && payload.event() == tauri::webview::PageLoadEvent::Started
            {
                prepare_main_webview_reload(Some(webview.app_handle()));
            }
        });

    // Registering this replaces Tauri's default WebContent termination handler,
    // so every webview must still be explicitly reloaded. The main document
    // additionally clears its native routing first.
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        let label = webview.label();
        eprintln!("session: WebContent process terminated for {label}; reloading");
        if label == "main" {
            prepare_main_webview_reload(Some(webview.app_handle()));
        }
        if let Err(err) = webview.reload() {
            eprintln!("session: failed to reload webview {label}: {err}");
        }
    });

    builder
        .setup({
            let state = state.clone();
            move |app| {
                // First thing, so the login-shell PATH probe (up to seconds under
                // heavy shell profiles) overlaps the rest of startup instead of
                // delaying the first agent launch.
                launch_path::warm_login_shell_path();
                state
                    .attach_app(app.handle().clone())
                    .map_err(std::io::Error::other)?;
                app.manage(human_browser::HumanBrowserManager::default());
                #[cfg(target_os = "macos")]
                if !native_support::available() {
                    return Err(std::io::Error::other(
                        "the native support bridge failed to initialize",
                    )
                    .into());
                }
                #[cfg(target_os = "macos")]
                if let Some(window) = app.get_webview_window("main") {
                    native_support::initialize(window.ns_view()?, state.clone())
                        .map_err(std::io::Error::other)?;
                    // Answer widget scripts run only in a web view without
                    // WebRTC, whose traffic no CSP directive governs.
                    let peer_connections_disabled = native_support::disable_peer_connections();
                    if !peer_connections_disabled {
                        eprintln!(
                            "session: could not turn off WebRTC in the app web view; answer widget scripts stay off"
                        );
                    }
                    research_widgets::set_scripts_allowed(peer_connections_disabled);
                }
                // Best-effort: if the menu tweak fails, ⌘W keeps its default
                // (window-closing) behavior and ⌘Q its instant-quit behavior rather
                // than aborting startup.
                if let Err(err) = customize_app_menu(app) {
                    eprintln!("session: failed to customize app menu: {err}");
                }
                app.manage(show_hide_shortcut::ShowHideShortcutState::default());
                show_hide_shortcut::init(app.handle(), &state.config().workspace_root);
                // On macOS, give the window an NSVisualEffectView so the sidebar can
                // read as a native, translucent source list (Finder/Mail/Xcode). The
                // frontend paints the content panes opaque and leaves the sidebar
                // column transparent, so the material only shows through there.
                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{NSVisualEffectMaterial, apply_vibrancy};
                    if let Some(window) = app.get_webview_window("main")
                        && let Err(err) =
                            apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, None, None)
                    {
                        eprintln!("session: failed to apply window vibrancy: {err}");
                    }
                }
                // Loopback static server for the browser overlay. Start it early
                // so a transcript file link that races startup cannot hit "the
                // file server is not running".
                // Best-effort: if it can't bind, the app still runs (file previews
                // just won't work until relaunch).
                match file_server::start_file_server(state.clone()) {
                    Ok(info) => state.set_file_server(info.port),
                    Err(err) => eprintln!("session: failed to start file server: {err}"),
                }
                app.manage(start_control_socket(state.clone()).map_err(std::io::Error::other)?);
                match browser_backend::start_browser_discovery(Some(state.clone())) {
                    Ok(socket) => {
                        eprintln!(
                            "session: experimental Codex browser discovery listening at {}",
                            socket.path().display()
                        );
                        app.manage(socket);
                    }
                    Err(err) => {
                        eprintln!("session: failed to start Codex browser discovery: {err}")
                    }
                }
                // Refuse to continue if the saved session exists but can't be read:
                // starting empty here would let the first save overwrite it with
                // nothing and no backup. Report the error in the terminal and GUI so a relaunch
                // after fixing the transient cause restores the session intact.
                if let Err(err) = state.preflight_persisted_state() {
                    eprintln!("\nsession: {err}\n");
                    notify_fatal_startup(&err);
                    std::process::exit(1);
                }
                // Remove scratch files left by earlier processes that were killed
                // mid-save (most commonly the final persist racing process exit).
                // Backgrounded: it scans the state dir and only ever removes files
                // whose unique pid-tagged names no live save can be using, so it
                // doesn't need to gate window creation.
                {
                    let workspace_root = state.config().workspace_root.clone();
                    std::thread::spawn(move || {
                        persistence::remove_stale_tmp_files(&workspace_root);
                    });
                }
                // Restore the persisted session before the command handlers go
                // live. Panes saved by older builds are dropped during the load.
                state.set_research_followup_launcher(std::sync::Arc::new(
                    launch_queued_research_followup,
                ));
                state.restore_session();
                workspace::reconcile_imported_research_archives(&state);
                // Send queued follow-ups whose chain freed up while the app
                // was not running to send them.
                state.schedule_research_followup_dispatch(None);
                // Recovery fell back to an empty session (state discarded to a .bak)
                // or dropped entries: say so in a dialog, since a Finder launch never
                // shows stderr and silent session loss looks like Session ate the tabs.
                if let Some(warning) = state.take_recovery_warning() {
                    notify_startup_warning(app.handle(), &warning);
                }
                // Remove scrollback and uploads left by builds with terminal panes.
                {
                    let workspace_root = state.config().workspace_root.clone();
                    std::thread::spawn(move || {
                        legacy_files::remove_terminal_leftovers(&workspace_root);
                    });
                }
                app.manage(state.clone());
                app.manage(SleepGuard::default());
                // Watchdog for the hidden-at-boot window: if the frontend fails
                // to boot (dev server down, bundle error) it can never call
                // app_window_ready, and an invisible app that must be force-quit
                // is worse than a blank window. Show it after a grace period.
                {
                    let app_handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(10));
                        if !WINDOW_READY_REPORTED.load(std::sync::atomic::Ordering::Relaxed) {
                            let app_handle_on_main = app_handle.clone();
                            let _ = app_handle.run_on_main_thread(move || {
                                show_main_window(&app_handle_on_main);
                            });
                        }
                    });
                }
                updater::check_on_startup(app.handle());
                Ok(())
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_window_ready,
            acknowledge_interface_health_probe,
            get_runtime_config,
            probe_agent_adapters,
            github_auth::github_account_get,
            github_auth::github_login_start,
            github_auth::github_login_poll,
            github_auth::github_login_cancel,
            github_auth::github_logout,
            browser_backend::browser_automation_snapshot,
            browser_backend::browser_automation_start_screencast,
            browser_backend::browser_automation_stop_screencast,
            browser_backend::browser_automation_navigate,
            browser_backend::browser_automation_reload,
            browser_backend::browser_automation_navigate_history,
            browser_backend::browser_automation_mouse,
            browser_backend::browser_automation_insert_text,
            browser_backend::browser_automation_key,
            human_browser::human_browser_sync,
            human_browser::human_browser_destroy,
            human_browser::human_browser_hide_all,
            human_browser::human_browser_generation,
            human_browser::human_browser_snapshot,
            human_browser::human_browser_reload,
            human_browser::human_browser_navigate_history,
            open_external_url,
            browser_open_preview_external,
            browser_open_local_path,
            browser_reveal_local_path,
            browser_open_local_path_external,
            browser_open_codex_inline_visualization,
            browser_open_codex_visualization_reference,
            list_groups,
            ensure_default_research_workspace_command,
            research_workspace_create_pick,
            research_workspace_rename,
            research_workspace_move_pick,
            research_workspace_remove,
            research_workspace_reveal,
            list_agents,
            list_research_trees,
            reorder_research_trees,
            list_research_folders,
            set_research_folders,
            list_research_drafts,
            save_research_draft,
            delete_research_draft,
            reorder_research_drafts,
            list_research_activity,
            list_research_highlights,
            list_recent_activity,
            list_recent_activity_for_trees,
            get_research_tree,
            create_research_tree,
            read_research_report,
            import_research_report,
            create_research_post,
            create_research_post_follow_up,
            update_research_document,
            update_research_post,
            save_research_image,
            import_research_image,
            read_research_image,
            read_research_image_thumbnail,
            get_research_node_content,
            fork_research_node,
            ask_research_followup,
            cancel_research_followup,
            retry_research_followup,
            list_research_followups,
            import_research_followups,
            retry_research_node,
            rerun_research_node,
            cancel_research_node,
            rename_research_tree,
            rename_research_node,
            set_research_chain_order,
            create_research_highlight,
            remove_research_highlights,
            mark_research_tree_viewed,
            archive_research_tree,
            restore_research_tree,
            remove_research_tree,
            trash_research_tree,
            restore_research_tree_from_trash,
            list_research_trash,
            empty_research_trash,
            remove_research_branch,
            research_launch_instruction_get,
            research_launch_instruction_set,
            research_inline_widgets_get,
            research_inline_widgets_set,
            research_widget_prepare,
            research_widget_download,
            research_artifact_register,
            research_artifact_history,
            research_artifact_state_get,
            research_artifact_state_update,
            mark_events_listener_ready,
            native_support_set_browser_overlay_open,
            native_support_set_iframe_shortcut_fallback,
            native_support_set_browser_background,
            interface_draft_get,
            interface_draft_set,
            app_confirm_exit,
            app_set_prevent_sleep,
            generate_research_agent_title,
            research_recap_default_instructions,
            generate_research_recap_candidate,
            apply_research_recap_candidate,
            show_hide_shortcut_get,
            show_hide_shortcut_set,
            show_hide_shortcut_capture_set,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Session")
        .run(move |app_handle, event| match event {
            tauri::RunEvent::ExitRequested { api, code, .. }
                if code != Some(tauri::RESTART_EXIT_CODE) && exit_state.should_confirm_exit() =>
            {
                api.prevent_exit();
                exit_state.request_exit_confirmation();
            }
            // The process is really terminating now (exit confirmed, or nothing to
            // confirm). Take down every research session so agent-spawned
            // descendants don't survive as orphans past quit.
            tauri::RunEvent::Exit => {
                // Freeze the on-disk session before killing research sessions, so a
                // persist triggered while they exit cannot replace the final snapshot.
                exit_state.finalize_persistence_for_exit();
                research_runtime::kill_all_sessions();
                native_support::shutdown();
                // Stop the supervisor before touching the pathname. If we unlink
                // first, the watchdog can treat that as a missing socket and bind
                // a replacement while the process is dying.
                if let Some(runtime) =
                    app_handle.try_state::<control_socket::ControlSocketRuntime>()
                {
                    runtime.shutdown();
                } else if exit_state.owns_control_socket() {
                    let _ = std::fs::remove_file(&exit_state.config().socket_path);
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod interface_health_tests {
    use super::InterfaceHealthTracker;

    #[test]
    fn only_the_current_probe_can_be_acknowledged() {
        let tracker = InterfaceHealthTracker::new();
        let first = tracker.begin();
        let second = tracker.begin();

        assert!(!tracker.acknowledge(first));
        assert!(tracker.claim_unanswered_reload(second));
        assert!(!tracker.claim_reload(second));
        let third = tracker.begin();
        assert!(tracker.acknowledge(third));
        assert!(!tracker.claim_unanswered_reload(third));
    }

    #[test]
    fn cancellation_disarms_a_pending_probe() {
        let tracker = InterfaceHealthTracker::new();
        let generation = tracker.begin();

        tracker.cancel();

        assert!(!tracker.claim_reload(generation));
    }

    #[test]
    fn snapshot_and_event_loop_watchdogs_share_one_reload_claim() {
        let tracker = InterfaceHealthTracker::new();
        let generation = tracker.begin();

        assert!(tracker.claim_reload(generation));
        assert!(!tracker.claim_reload(generation));
        assert!(!tracker.claim_unanswered_reload(generation));
    }
}

#[cfg(test)]
mod browser_preview_url_tests {
    use super::validated_preview_url;

    #[test]
    fn accepts_only_the_live_loopback_file_server_origin() {
        let preview = "http://127.0.0.1:8123/token/path/report.html#result";
        let parsed = validated_preview_url(preview, 8123).unwrap();
        assert_eq!(parsed.path(), "/token/path/report.html");
        assert_eq!(parsed.fragment(), Some("result"));

        assert!(validated_preview_url("http://localhost:8123/token/file", 8123).is_ok());
        assert!(validated_preview_url("http://localhost:5173/", 8123).is_err());
        assert!(validated_preview_url("https://localhost:8123/token/file", 8123).is_err());
        assert!(validated_preview_url("http://example.com:8123/token/file", 8123).is_err());
    }
}

#[cfg(test)]
mod local_link_tests {
    use super::resolve_local_link_target;
    use crate::config::{
        AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, GrokAdapterConfig, SessionConfig,
    };
    use crate::state::{AppState, RESEARCH_THREAD_OWNER_PREFIX};
    use crate::workspace::{GroupInfo, WorkspaceScope};
    use std::path::{Path, PathBuf};

    /// A research thread whose workspace folder is `folder`, with the file
    /// server port recorded so link resolution can build preview URLs.
    fn thread_in(folder: &Path, base: &Path) -> (AppState, String) {
        let state = AppState::new(SessionConfig {
            workspace_root: base.join("state"),
            socket_path: base.join("x.sock"),
            adapters: AdapterConfigs {
                claude: ClaudeAdapterConfig {
                    binary: Some("claude".to_string()),
                },
                codex: CodexAdapterConfig {
                    binary: Some("codex".to_string()),
                },
                grok: GrokAdapterConfig {
                    binary: Some("grok".to_string()),
                },
            },
            legacy_claude_binary: None,
        });
        state
            .insert_group_after(
                GroupInfo {
                    id: "group-1".to_string(),
                    name: "project".to_string(),
                    name_override: None,
                    dir: folder.display().to_string(),
                    managed_dir: base.join("managed").display().to_string(),
                    base_repo: None,
                    created_at: 1,
                    scope: WorkspaceScope::Research,
                    imported_research_archive_id: None,
                    agents: Vec::new(),
                },
                None,
            )
            .unwrap();
        let detail = state
            .create_research_tree(crate::research::CreateResearchTreeRequest {
                prompt: "Question".to_string(),
                title: None,
                adapter: "claude".to_string(),
                model: None,
                effort: None,
                group_id: "group-1".to_string(),
            })
            .unwrap();
        state.set_file_server(8123);
        (
            state,
            format!("{RESEARCH_THREAD_OWNER_PREFIX}{}", detail.tree.id),
        )
    }

    fn scratch(label: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/session-local-link-tests")
            .join(format!("{label}-{}", std::process::id()))
    }

    #[test]
    fn relative_links_resolve_against_the_thread_workspace_folder() {
        let base = scratch("relative");
        let folder = base.join("project");
        std::fs::create_dir_all(folder.join("docs")).unwrap();
        std::fs::write(folder.join("docs/notes.md"), "# Notes").unwrap();
        std::fs::write(folder.join("report.html"), "<p>report</p>").unwrap();
        let (state, owner) = thread_in(&folder, &base);

        let notes = resolve_local_link_target(&state, &owner, "docs/notes.md").unwrap();
        assert_eq!(
            notes.path,
            std::fs::canonicalize(folder.join("docs/notes.md")).unwrap()
        );
        assert!(notes.sandbox);
        let thread_token = state.owner_file_token(&owner).unwrap();
        assert!(
            notes
                .url
                .starts_with(&format!("http://127.0.0.1:8123/{thread_token}/")),
            "{}",
            notes.url
        );

        // Executable content gets a token for its exact file only.
        let report = resolve_local_link_target(&state, &owner, "./report.html").unwrap();
        assert!(!report.url.contains(&thread_token), "{}", report.url);

        // Absolute paths inside the folder resolve as they are.
        let absolute = folder.join("docs/notes.md").display().to_string();
        assert_eq!(
            resolve_local_link_target(&state, &owner, &absolute)
                .unwrap()
                .path,
            notes.path
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn links_outside_the_thread_roots_or_from_unknown_owners_are_refused() {
        let base = scratch("refused");
        let folder = base.join("project");
        let outside = base.join("outside");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.md"), "secret").unwrap();
        std::fs::write(folder.join("notes.md"), "notes").unwrap();
        let (state, owner) = thread_in(&folder, &base);

        for path in [
            "../outside/secret.md".to_string(),
            outside.join("secret.md").display().to_string(),
            "missing.md".to_string(),
            "  ".to_string(),
        ] {
            assert!(
                resolve_local_link_target(&state, &owner, &path).is_err(),
                "{path}"
            );
        }
        for unknown in ["pane-1", "__research_thread__:missing"] {
            assert!(resolve_local_link_target(&state, unknown, "notes.md").is_err());
        }
        let _ = std::fs::remove_dir_all(&base);
    }
}
