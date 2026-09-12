//! AppKit/WebKit support. Surviving C symbols retain their compatibility names.
use crate::events::SessionEvent;
use crate::state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
static APP_STATE: OnceLock<Mutex<Option<AppState>>> = OnceLock::new();
static EVENTS_LISTENER_READY: AtomicBool = AtomicBool::new(false);
pub fn set_events_listener_ready(ready: bool) {
    EVENTS_LISTENER_READY.store(ready, Ordering::Release);
}

fn events_listener_ready() -> bool {
    EVENTS_LISTENER_READY.load(Ordering::Acquire)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AppShortcutCommand {
    FocusResearchTab(u8),
    OpenNewResearch,
    CycleResearchTab(i8),
    MoveResearchItem(i8),
    OpenSettings,
    OpenCommandPalette,
    ToggleLeftSidebar,
    NewDocument,
    FocusFollowups,
    OpenFolderMenu,
    ToggleSourceBrowser,
}

impl AppShortcutCommand {
    fn event_fields(self) -> (&'static str, Option<u8>) {
        match self {
            Self::FocusResearchTab(index) => ("focusResearchTab", Some(index)),
            Self::OpenNewResearch => ("openNewResearch", None),
            Self::CycleResearchTab(-1) => ("cycleResearchTabPrevious", None),
            Self::CycleResearchTab(_) => ("cycleResearchTabNext", None),
            Self::MoveResearchItem(-1) => ("moveResearchItemUp", None),
            Self::MoveResearchItem(_) => ("moveResearchItemDown", None),
            Self::OpenSettings => ("openSettings", None),
            Self::OpenCommandPalette => ("openCommandPalette", None),
            Self::ToggleLeftSidebar => ("toggleLeftSidebar", None),
            Self::NewDocument => ("newDocument", None),
            Self::FocusFollowups => ("focusFollowups", None),
            Self::OpenFolderMenu => ("openFolderMenu", None),
            Self::ToggleSourceBrowser => ("toggleSourceBrowser", None),
        }
    }
}

/// Mirrors src/lib/appShortcuts.ts. Only claim commands the frontend executes;
/// unrecognized chords continue through WebKit/AppKit's responder chain.
fn classify_web_app_shortcut(
    key: &str,
    shift: bool,
    control: bool,
    option: bool,
    command: bool,
) -> Option<AppShortcutCommand> {
    let normalized = key.to_lowercase();
    let key = match normalized.as_str() {
        "{" => "[",
        "}" => "]",
        other => other,
    };
    if command && !control && option && !shift {
        return match key {
            "arrowup" => Some(AppShortcutCommand::MoveResearchItem(-1)),
            "arrowdown" => Some(AppShortcutCommand::MoveResearchItem(1)),
            _ => None,
        };
    }
    if (command != control) && !option && !shift {
        if let [digit @ b'1'..=b'9'] = key.as_bytes() {
            return Some(AppShortcutCommand::FocusResearchTab(digit - b'1'));
        }
        if key == "," {
            return Some(AppShortcutCommand::OpenSettings);
        }
    }
    if !command && control && !option && key == "tab" {
        return Some(AppShortcutCommand::CycleResearchTab(if shift {
            -1
        } else {
            1
        }));
    }
    if command && !control && !option {
        return match (key, shift) {
            ("n" | "t", false) => Some(AppShortcutCommand::OpenNewResearch),
            ("g", true) => Some(AppShortcutCommand::ToggleLeftSidebar),
            ("[", true) => Some(AppShortcutCommand::CycleResearchTab(-1)),
            ("]", true) => Some(AppShortcutCommand::CycleResearchTab(1)),
            ("k", false) => Some(AppShortcutCommand::OpenCommandPalette),
            ("d", false) => Some(AppShortcutCommand::NewDocument),
            ("j", false) => Some(AppShortcutCommand::FocusFollowups),
            ("o", false) => Some(AppShortcutCommand::OpenFolderMenu),
            ("e", true) => Some(AppShortcutCommand::ToggleSourceBrowser),
            _ => None,
        };
    }
    None
}

#[cfg(target_os = "macos")]
#[allow(dead_code)]
mod imp {
    use super::APP_STATE;
    use crate::state::AppState;
    use std::ffi::c_void;
    use std::ffi::{CString, c_char};
    use std::sync::Mutex;
    unsafe extern "C" {
        fn session_native_application_is_active() -> i32;
        fn session_native_completion_sound_play(system_name: *const c_char) -> i32;
        fn session_native_completion_sound_play_file(system_path: *const c_char) -> i32;
        fn session_native_completion_sound_play_data(
            name: *const c_char,
            bytes: *const u8,
            bytes_len: usize,
        ) -> i32;
        fn session_native_support_bridge_available() -> i32;
        fn session_native_support_initialize(native_view: *mut c_void) -> i32;
        fn session_native_support_shutdown();
        fn session_native_support_set_iframe_shortcut_fallback(active: i32) -> i32;
        fn session_native_support_set_browser_overlay_open(active: i32) -> i32;
        fn session_native_support_set_human_browser_webview(
            native_view: *mut c_void,
            active: i32,
        ) -> i32;
        fn session_native_support_set_human_browser_loading_background(
            native_view: *mut c_void,
            active: i32,
        ) -> i32;
        fn session_native_support_human_browser_history_state(native_view: *mut c_void) -> i32;
        fn session_native_support_prepare_for_webview_reload() -> i32;
        fn session_native_support_should_claim_web_app_shortcut(
            has_terminal_keyboard_owner: i32,
            responder_state: i32,
            iframe_fallback_eligible: i32,
        ) -> i32;
        fn session_native_support_should_claim_browser_escape(
            browser_overlay_open: i32,
            key: *const c_char,
            control: i32,
            option: i32,
            command: i32,
        ) -> i32;
        fn session_native_support_human_browser_defers_editable_sensitive_shortcut(
            key: *const c_char,
            shift: i32,
            control: i32,
            option: i32,
            command: i32,
        ) -> i32;
        fn session_native_support_set_browser_background(red: f64, green: f64, blue: f64) -> i32;
    }
    fn cstring(value: &str, label: &str) -> Result<CString, String> {
        CString::new(value).map_err(|_| format!("{label} contains an interior NUL byte"))
    }
    pub fn available() -> bool {
        // SAFETY: the function has no arguments or borrowed state and is linked
        // from the pinned SessionNativeSupport Swift package in build.rs.
        unsafe { session_native_support_bridge_available() == 1 }
    }

    pub fn application_is_active() -> bool {
        // SAFETY: the function has no borrowed state and synchronously reads
        // NSApplication.isActive on the main actor.
        unsafe { session_native_application_is_active() == 1 }
    }

    pub fn play_system_sound(system_name: &str) -> Result<(), String> {
        let system_name = cstring(system_name, "completion system sound name")?;
        // SAFETY: Swift copies the string synchronously and plays an allowlisted
        // NSSound name resolved by the Rust catalog on the main actor.
        if unsafe { session_native_completion_sound_play(system_name.as_ptr()) } == 1 {
            Ok(())
        } else {
            Err("completion sound was not recognized or could not be played".to_string())
        }
    }

    pub fn play_system_sound_file(system_path: &str) -> Result<(), String> {
        let system_path = cstring(system_path, "completion system sound path")?;
        // SAFETY: Swift copies the allowlisted path synchronously and loads the
        // OS-provided audio file on the main actor.
        if unsafe { session_native_completion_sound_play_file(system_path.as_ptr()) } == 1 {
            Ok(())
        } else {
            Err("completion system sound file could not be played".to_string())
        }
    }

    pub fn play_bundled_sound(name: &str, bytes: &[u8]) -> Result<(), String> {
        let name = cstring(name, "bundled completion sound name")?;
        // SAFETY: Swift copies the name and audio data synchronously before this
        // call returns, then caches the resulting NSSound on the main actor.
        if unsafe {
            session_native_completion_sound_play_data(name.as_ptr(), bytes.as_ptr(), bytes.len())
        } == 1
        {
            Ok(())
        } else {
            Err("bundled completion sound could not be played".to_string())
        }
    }

    pub fn initialize(native_view: *mut c_void, state: AppState) -> Result<(), String> {
        if native_view.is_null() {
            return Err("Tauri returned a null native content view".into());
        }
        let slot = APP_STATE.get_or_init(|| Mutex::new(None));
        *slot
            .lock()
            .map_err(|_| "native support state lock poisoned")? = Some(state);
        // SAFETY: Tauri owns the view throughout this synchronous main-thread call.
        if unsafe { session_native_support_initialize(native_view) } == 1 {
            Ok(())
        } else {
            *slot
                .lock()
                .map_err(|_| "native support state lock poisoned")? = None;
            Err("failed to bind native support to the app WKWebView".into())
        }
    }

    pub fn set_iframe_shortcut_fallback(active: bool) -> Result<(), String> {
        // SAFETY: the scalar is copied synchronously on the main actor.
        if unsafe { session_native_support_set_iframe_shortcut_fallback(i32::from(active)) } == 1 {
            Ok(())
        } else {
            Err("native support host is not attached".to_string())
        }
    }

    pub fn set_browser_overlay_open(active: bool) -> Result<(), String> {
        // SAFETY: the scalar is copied synchronously on the main actor.
        if unsafe { session_native_support_set_browser_overlay_open(i32::from(active)) } == 1 {
            Ok(())
        } else {
            Err("native support host is not attached".to_string())
        }
    }

    pub fn set_human_browser_webview(native_view: *mut c_void, active: bool) -> Result<(), String> {
        if active && native_view.is_null() {
            return Err("human browser native view is null".to_string());
        }
        // SAFETY: Tauri owns the WKWebView for the duration of this synchronous
        // call. Swift stores it weakly and never assumes ownership of it.
        if unsafe {
            session_native_support_set_human_browser_webview(native_view, i32::from(active))
        } == 1
        {
            Ok(())
        } else {
            Err("native support host rejected the human browser webview".to_string())
        }
    }

    pub fn set_human_browser_loading_background(
        native_view: *mut c_void,
        active: bool,
    ) -> Result<(), String> {
        if native_view.is_null() {
            return Err("human browser native view is null".to_string());
        }
        // SAFETY: Tauri owns the WKWebView for this synchronous call, and Swift
        // changes only its public underPageBackgroundColor property.
        if unsafe {
            session_native_support_set_human_browser_loading_background(
                native_view,
                i32::from(active),
            )
        } == 1
        {
            Ok(())
        } else {
            Err("native support host rejected the human browser background update".to_string())
        }
    }

    pub fn human_browser_history_state(native_view: *mut c_void) -> u8 {
        if native_view.is_null() {
            return 0;
        }
        // SAFETY: Tauri owns the WKWebView for this synchronous query. Swift
        // reads only WebKit's navigation-list state on the main actor.
        unsafe { session_native_support_human_browser_history_state(native_view) }.clamp(0, 3) as u8
    }

    pub fn prepare_for_webview_reload() -> Result<(), String> {
        // SAFETY: the reset is synchronous main-actor state bookkeeping. It
        // clears document-owned routing and cancels stale probes.
        if unsafe { session_native_support_prepare_for_webview_reload() } == 1 {
            Ok(())
        } else {
            Err("native support host is not attached".to_string())
        }
    }

    pub fn shutdown() {
        super::set_events_listener_ready(false);
        // SAFETY: shutdown is idempotent and synchronously tears down Swift-owned
        // views on the main thread.
        unsafe { session_native_support_shutdown() };
        if let Some(state) = APP_STATE.get()
            && let Ok(mut state) = state.lock()
        {
            *state = None;
        }
    }

    pub fn should_claim_web_app_shortcut(
        has_terminal_keyboard_owner: bool,
        responder_state: i32,
        iframe_fallback_eligible: bool,
    ) -> bool {
        // SAFETY: all arguments are scalar values. Swift validates the
        // responder-state discriminant before exercising the pure routing
        // helper linked from the same package as the native support bridge.
        unsafe {
            session_native_support_should_claim_web_app_shortcut(
                i32::from(has_terminal_keyboard_owner),
                responder_state,
                i32::from(iframe_fallback_eligible),
            ) == 1
        }
    }

    pub fn should_claim_browser_escape(
        browser_overlay_open: bool,
        key: &str,
        control: bool,
        option: bool,
        command: bool,
    ) -> bool {
        let Ok(key) = CString::new(key) else {
            return false;
        };
        // SAFETY: the key is a valid NUL-terminated string for the duration of
        // this pure routing probe and all remaining arguments are scalar.
        unsafe {
            session_native_support_should_claim_browser_escape(
                i32::from(browser_overlay_open),
                key.as_ptr(),
                i32::from(control),
                i32::from(option),
                i32::from(command),
            ) == 1
        }
    }

    pub fn human_browser_defers_editable_sensitive_shortcut(
        key: &str,
        shift: bool,
        control: bool,
        option: bool,
        command: bool,
    ) -> bool {
        let Ok(key) = CString::new(key) else {
            return false;
        };
        // SAFETY: the key is a valid NUL-terminated string for the duration of
        // the synchronous call and all remaining arguments are scalar values.
        unsafe {
            session_native_support_human_browser_defers_editable_sensitive_shortcut(
                key.as_ptr(),
                i32::from(shift),
                i32::from(control),
                i32::from(option),
                i32::from(command),
            ) == 1
        }
    }

    pub fn set_browser_background(red: f64, green: f64, blue: f64) -> Result<(), String> {
        // SAFETY: scalar color components are validated by the Swift host.
        if unsafe { session_native_support_set_browser_background(red, green, blue) } == 1 {
            Ok(())
        } else {
            Err("invalid browser background".into())
        }
    }
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
mod imp {
    use crate::state::AppState;
    use std::ffi::c_void;
    pub fn available() -> bool {
        false
    }

    pub fn application_is_active() -> bool {
        false
    }

    pub fn play_system_sound(_system_name: &str) -> Result<(), String> {
        Err("completion sounds are only available on macOS".to_string())
    }

    pub fn play_system_sound_file(_system_path: &str) -> Result<(), String> {
        Err("completion sounds are only available on macOS".to_string())
    }

    pub fn play_bundled_sound(_name: &str, _bytes: &[u8]) -> Result<(), String> {
        Err("completion sounds are only available on macOS".to_string())
    }

    pub fn initialize(_native_view: *mut c_void, _state: AppState) -> Result<(), String> {
        Err("native support are only available on macOS".to_string())
    }

    pub fn set_iframe_shortcut_fallback(_active: bool) -> Result<(), String> {
        Err("native support are only available on macOS".to_string())
    }

    pub fn set_browser_overlay_open(_active: bool) -> Result<(), String> {
        Err("native support are only available on macOS".to_string())
    }

    pub fn set_human_browser_webview(
        _native_view: *mut c_void,
        _active: bool,
    ) -> Result<(), String> {
        Ok(())
    }

    pub fn set_human_browser_loading_background(
        _native_view: *mut c_void,
        _active: bool,
    ) -> Result<(), String> {
        Ok(())
    }

    pub fn human_browser_history_state(_native_view: *mut c_void) -> u8 {
        0
    }

    pub fn prepare_for_webview_reload() -> Result<(), String> {
        Ok(())
    }

    pub fn shutdown() {}

    pub fn set_browser_background(_red: f64, _green: f64, _blue: f64) -> Result<(), String> {
        Ok(())
    }
}

#[allow(unused_imports)]
pub use imp::{
    application_is_active, available, human_browser_history_state, initialize,
    prepare_for_webview_reload, set_browser_overlay_open, set_human_browser_loading_background,
    set_human_browser_webview, set_iframe_shortcut_fallback, shutdown,
};

fn with_app_state(operation: impl FnOnce(&AppState)) {
    let Some(slot) = APP_STATE.get() else { return };
    let Ok(state) = slot.lock() else { return };
    let Some(state) = state.as_ref() else { return };
    operation(state);
}

fn callback_string(pointer: *const std::ffi::c_char) -> Option<String> {
    if pointer.is_null() {
        return None;
    }
    // SAFETY: Swift supplies a valid, NUL-terminated UTF-8 string for the
    // synchronous duration of each callback.
    unsafe { std::ffi::CStr::from_ptr(pointer) }
        .to_str()
        .ok()
        .map(ToString::to_string)
}

#[cfg(target_os = "macos")]
#[unsafe(no_mangle)]
pub extern "C" fn session_native_support_system_sleep_changed(sleeping: i32) {
    with_app_state(|state| {
        crate::pty::remote_system_sleep_changed(state, sleeping != 0);
    });
}

#[cfg(target_os = "macos")]
#[unsafe(no_mangle)]
pub extern "C" fn session_native_support_did_begin_interface_health_check() -> u64 {
    if !events_listener_ready() {
        return 0;
    }
    let mut generation = 0;
    with_app_state(|state| {
        generation = crate::begin_interface_health_probe(state.clone());
    });
    generation
}

#[cfg(target_os = "macos")]
#[unsafe(no_mangle)]
pub extern "C" fn session_native_support_did_cancel_interface_health_check() {
    crate::cancel_interface_health_probe();
}

#[cfg(target_os = "macos")]
#[unsafe(no_mangle)]
pub extern "C" fn session_native_support_did_detect_unhealthy_webview(generation: u64) {
    if generation == 0 {
        return;
    }
    with_app_state(|state| {
        crate::request_unhealthy_interface_reload(
            state.clone(),
            generation,
            false,
            "WKWebView compositor failed its interface recovery health check",
        );
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn session_native_support_did_request_browser_escape() -> i32 {
    if !events_listener_ready() {
        return 0;
    }
    let mut emitted = false;
    with_app_state(|state| {
        state.emit(SessionEvent::new(
            "browser.escape_requested",
            None,
            None,
            serde_json::json!({}),
        ));
        emitted = true;
    });
    i32::from(emitted)
}

#[unsafe(no_mangle)]
pub extern "C" fn session_native_support_did_receive_app_shortcut(
    key: *const std::ffi::c_char,
    shift: i32,
    control: i32,
    option: i32,
    command: i32,
    repeat: i32,
) -> i32 {
    let Some(key) = callback_string(key) else {
        return 0;
    };
    // Same delivery gate as the terminal-scoped classifier above: never
    // consume a chord the frontend cannot receive.
    if !events_listener_ready() {
        return 0;
    }
    let Some(shortcut) =
        classify_web_app_shortcut(&key, shift == 1, control == 1, option == 1, command == 1)
    else {
        return 0;
    };
    let (command, tab_index) = shortcut.event_fields();
    let mut emitted = false;
    with_app_state(|state| {
        state.emit(SessionEvent::new(
            "app.shortcut",
            None,
            None,
            serde_json::json!({
                "command": command,
                "tabIndex": tab_index,
                "repeat": repeat == 1,
            }),
        ));
        emitted = true;
    });
    i32::from(emitted)
}

#[tauri::command]
pub fn native_support_set_iframe_shortcut_fallback(active: bool) -> Result<(), String> {
    set_iframe_shortcut_fallback(active)
}

#[tauri::command]
pub fn native_support_set_browser_overlay_open(active: bool) -> Result<(), String> {
    set_browser_overlay_open(active)
}

pub fn play_completion_sound(sound_id: &str) -> Result<(), String> {
    use crate::completion_sound::CompletionSound;

    match crate::completion_sound::sound_for_id(sound_id)? {
        Some(CompletionSound::System(name)) => imp::play_system_sound(name),
        Some(CompletionSound::SystemFile(path)) => imp::play_system_sound_file(path),
        Some(CompletionSound::Bundled { name, bytes }) => imp::play_bundled_sound(name, bytes),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn completion_sound_play(sound_id: String) -> Result<(), String> {
    play_completion_sound(&sound_id)
}

#[tauri::command]
pub fn completion_sound_set(
    state: tauri::State<'_, AppState>,
    sound_id: String,
) -> Result<(), String> {
    state.set_completion_sound(&sound_id)
}

#[tauri::command]
pub fn native_support_set_browser_background(
    red: f64,
    green: f64,
    blue: f64,
) -> Result<(), String> {
    if ![red, green, blue]
        .iter()
        .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
    {
        return Err("invalid browser background".into());
    }
    imp::set_browser_background(red, green, blue)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn swift_native_support_bridge_is_linked() {
        assert!(super::available());
    }

    #[test]
    fn swift_web_app_shortcut_routing_preserves_terminal_and_dom_ownership() {
        const OUTSIDE_WEB_VIEW: i32 = 0;
        const OUTER_WEB_VIEW: i32 = 1;
        const WEB_VIEW_DESCENDANT: i32 = 2;
        const HUMAN_BROWSER: i32 = 3;

        for responder_state in [
            OUTSIDE_WEB_VIEW,
            OUTER_WEB_VIEW,
            WEB_VIEW_DESCENDANT,
            HUMAN_BROWSER,
        ] {
            for iframe_fallback_eligible in [false, true] {
                assert!(!super::imp::should_claim_web_app_shortcut(
                    true,
                    responder_state,
                    iframe_fallback_eligible
                ));
            }
        }
        assert!(super::imp::should_claim_web_app_shortcut(
            false,
            OUTSIDE_WEB_VIEW,
            false
        ));
        assert!(super::imp::should_claim_web_app_shortcut(
            false,
            OUTER_WEB_VIEW,
            false
        ));
        assert!(!super::imp::should_claim_web_app_shortcut(
            false,
            WEB_VIEW_DESCENDANT,
            false
        ));
        // A ⌘ chord typed while a cross-document iframe holds DOM focus must
        // be claimed natively: the host document's window-level handlers never
        // see keys delivered to the framed document.
        assert!(super::imp::should_claim_web_app_shortcut(
            false,
            WEB_VIEW_DESCENDANT,
            true
        ));
        // A child WKWebView is outside the app document, so neither its outer
        // responder nor its content descendants can deliver Session shortcuts to
        // the React window listener.
        assert!(super::imp::should_claim_web_app_shortcut(
            false,
            HUMAN_BROWSER,
            false
        ));
    }

    #[test]
    fn browser_escape_is_claimed_before_terminal_or_browser_responder_routing() {
        let escape = "\u{1b}";
        assert!(!super::imp::should_claim_browser_escape(
            false, escape, false, false, false
        ));
        assert!(super::imp::should_claim_browser_escape(
            true, escape, false, false, false
        ));
        assert!(!super::imp::should_claim_browser_escape(
            true, "x", false, false, false
        ));
        for (control, option, command) in [
            (true, false, false),
            (false, true, false),
            (false, false, true),
        ] {
            assert!(!super::imp::should_claim_browser_escape(
                true, escape, control, option, command
            ));
        }
    }

    #[test]
    fn human_browser_leaves_editable_sensitive_shortcuts_with_the_page() {
        assert!(
            super::imp::human_browser_defers_editable_sensitive_shortcut(
                "ArrowUp", false, false, true, true
            )
        );
        assert!(
            super::imp::human_browser_defers_editable_sensitive_shortcut(
                "ArrowDown",
                false,
                false,
                true,
                true
            )
        );
        assert!(
            super::imp::human_browser_defers_editable_sensitive_shortcut(
                "w", false, true, false, false
            )
        );
        assert!(
            !super::imp::human_browser_defers_editable_sensitive_shortcut(
                "ArrowUp", true, false, true, true
            )
        );
        assert!(
            !super::imp::human_browser_defers_editable_sensitive_shortcut(
                "w", false, false, false, true
            )
        );
        assert!(
            !super::imp::human_browser_defers_editable_sensitive_shortcut(
                "t", false, false, false, true
            )
        );
    }
}

#[cfg(test)]
mod shortcut_tests {
    use super::*;

    #[test]
    fn native_commands_use_the_current_research_wire_names() {
        for (key, shift, control, option, command, expected) in [
            ("n", false, false, false, true, ("openNewResearch", None)),
            ("t", false, false, false, true, ("openNewResearch", None)),
            ("d", false, false, false, true, ("newDocument", None)),
            ("k", false, false, false, true, ("openCommandPalette", None)),
            (
                "4",
                false,
                true,
                false,
                false,
                ("focusResearchTab", Some(3)),
            ),
            (
                "Tab",
                true,
                true,
                false,
                false,
                ("cycleResearchTabPrevious", None),
            ),
            (
                "}",
                true,
                false,
                false,
                true,
                ("cycleResearchTabNext", None),
            ),
            (
                "ArrowUp",
                false,
                false,
                true,
                true,
                ("moveResearchItemUp", None),
            ),
            ("g", true, false, false, true, ("toggleLeftSidebar", None)),
            ("j", false, false, false, true, ("focusFollowups", None)),
            ("o", false, false, false, true, ("openFolderMenu", None)),
            ("e", true, false, false, true, ("toggleSourceBrowser", None)),
            (",", false, false, false, true, ("openSettings", None)),
        ] {
            assert_eq!(
                classify_web_app_shortcut(key, shift, control, option, command)
                    .map(AppShortcutCommand::event_fields),
                Some(expected),
                "{key}"
            );
        }
    }

    #[test]
    fn retired_terminal_shortcuts_and_native_editing_keys_are_not_consumed() {
        for (key, shift) in [
            ("+", false),
            ("-", false),
            ("0", false),
            ("w", false),
            ("d", true),
            ("n", true),
            ("t", true),
            ("h", true),
            ("l", true),
            ("r", true),
            ("c", false),
            ("q", false),
            ("a", false),
        ] {
            assert_eq!(
                classify_web_app_shortcut(key, shift, false, false, true),
                None,
                "{key}"
            );
        }
        assert_eq!(
            classify_web_app_shortcut("w", false, true, false, false),
            None
        );
        assert_eq!(
            classify_web_app_shortcut("e", true, true, false, false),
            None
        );
    }

    #[test]
    fn invalid_browser_colors_are_rejected_before_native_dispatch() {
        for red in [f64::NAN, f64::INFINITY, -0.1, 1.1] {
            assert!(native_support_set_browser_background(red, 0.0, 0.0).is_err());
        }
    }
}
