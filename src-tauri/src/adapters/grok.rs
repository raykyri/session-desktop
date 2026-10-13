use super::{
    AgentAdapter, ComposerPolicy, ShellCommandIntegration, SpawnAgentRequest,
    TranscriptLifecycleEvent, ensure_on_path, model_from_claude_native_transcript_line,
    shell_quote_path,
};
use crate::config::SessionConfig;
use crate::pty::{
    CommandPlan, PaneMeta, agent_pane_envs, plan_to_spec, recoverable_dir, spawn_pty,
};
use crate::state::{AppState, PaneInfo, PaneKind};
use crate::transcript::{Turn, TurnBlock};
use crate::workspace::{
    AgentInfo, AgentStatus, PrepareAgentWorkspaceRequest, attach_agent_pane, mark_agent_failed,
    mark_agent_spawn_failed, prepare_agent_workspace_with_parent,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::env;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// The xAI Grok Build lifecycle hook events Session installs. Grok discovers global
/// hooks from `~/.grok/hooks/*.json` (not `user-settings.json`); each entry runs a
/// command per event with the event JSON on stdin. Session drives the agent timeline
/// from the same core events it uses for Claude. Grok has no pre-decision permission
/// event, but its passive `PermissionDenied` event still updates status and activity.
const GROK_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionDenied",
    "Stop",
    "StopFailure",
    "Notification",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "SessionEnd",
];

/// Adapter for the xAI Grok Build CLI. Grok ships a Claude-compatible hook system
/// (shell commands run at lifecycle events, event JSON on stdin), so Session integrates
/// it like its Claude and Codex adapters: a Session-managed
/// hook file is installed at `~/.grok/hooks/session.json` and a shim forwards each
/// lifecycle event back to Session via `session notify <event>`. The hook command no-ops
/// outside Session (it checks for the `SESSION_*` env vars only Session-launched panes set),
/// so standalone `grok` runs are unaffected. Agent status (running, idle, awaiting
/// permission) is driven by these hooks; the transcript timeline binds to the
/// transcript path the `SessionStart` hook reports when Grok provides one.
#[derive(Clone, Debug)]
pub struct GrokAdapter {
    binary: String,
}

impl GrokAdapter {
    pub fn new(config: &SessionConfig) -> Self {
        Self {
            binary: config.grok_binary(),
        }
    }

    pub(crate) fn ensure_binary(&self) -> Result<String, String> {
        let binary = ensure_on_path(&self.binary).ok_or_else(|| {
            format!(
                "Grok adapter binary '{}' was not found on PATH or standard macOS tool paths. Install the Grok CLI or update adapters.grok.binary in session.config.json.",
                self.binary
            )
        })?;
        Ok(binary.display().to_string())
    }
}

impl AgentAdapter for GrokAdapter {
    fn id(&self) -> &'static str {
        "grok"
    }

    fn display_name(&self) -> &'static str {
        "Grok"
    }

    fn configured_binary(&self) -> &str {
        &self.binary
    }

    fn launch(&self, state: &AppState, request: SpawnAgentRequest) -> Result<PaneInfo, String> {
        self.spawn_pane(state, request)
    }

    fn shell_commands(&self) -> Vec<ShellCommandIntegration> {
        // Grok ships the same binary as both `grok` and `agent`. Wrap both so a
        // typed `agent` in a Session shell is supervised like `grok`. `session agent`
        // stays the public CLI and is not this alias.
        vec![
            ShellCommandIntegration {
                command_name: "grok",
                adapter_id: self.id(),
            },
            ShellCommandIntegration {
                command_name: "agent",
                adapter_id: self.id(),
            },
        ]
    }

    fn parse_transcript_line(
        &self,
        agent_id: &str,
        source_index: usize,
        line: &str,
    ) -> Option<Turn> {
        parse_transcript_line(agent_id, source_index, line)
    }

    fn parse_transcript_lifecycle_event(&self, line: &str) -> Option<TranscriptLifecycleEvent> {
        parse_transcript_lifecycle_event(line)
    }

    fn transcript_line_model(&self, line: &str) -> Option<String> {
        // Grok sessions use the Claude-native JSONL shape for assistant turns.
        model_from_claude_native_transcript_line(line)
    }

    fn supports_fork(&self) -> bool {
        true
    }

    fn supports_research(&self) -> bool {
        true
    }

    fn fork_pane(
        &self,
        state: &AppState,
        source: &AgentInfo,
        use_worktree: bool,
        prompt: Option<&str>,
    ) -> Result<(PaneInfo, AgentInfo), String> {
        GrokAdapter::fork_pane(self, state, source, use_worktree, prompt)
    }

    fn composer_policy(&self) -> ComposerPolicy {
        ComposerPolicy {
            ready_statuses: vec![
                AgentStatus::AwaitingInput,
                AgentStatus::Done,
                AgentStatus::Idle,
            ],
            queue_statuses: vec![
                AgentStatus::Starting,
                AgentStatus::Running,
                AgentStatus::AwaitingPermission,
            ],
            steer_statuses: vec![AgentStatus::Starting, AgentStatus::Running],
        }
    }
}

impl GrokAdapter {
    fn spawn_pane(&self, state: &AppState, request: SpawnAgentRequest) -> Result<PaneInfo, String> {
        let binary = self.ensure_binary()?;
        let _options = GrokLaunchOptions::from_value(request.options)?;
        ensure_grok_integration()?;

        let agent = prepare_agent_workspace_with_parent(
            state,
            PrepareAgentWorkspaceRequest {
                group_id: request.group_id,
                base_repo: request.base_repo,
                base_ref: request.base_ref,
                adapter: self.id().to_string(),
                model: request.model.clone(),
                effort: None,
                use_worktree: request.use_worktree.unwrap_or(false),
            },
            request.parent_id.as_deref(),
        )?;
        let cwd = request
            .cwd
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(&agent.worktree_dir));
        if !cwd.is_dir() {
            let _ = mark_agent_failed(state, &agent.id);
            return Err(format!(
                "Grok working directory {} does not exist",
                cwd.display()
            ));
        }

        let has_initial_prompt = prompt_has_initial_text(&request.prompt);
        let args = build_grok_args(&cwd, request.model.as_deref(), &request.prompt);

        let pane_id = state.next_id("pane");
        let envs = agent_pane_envs(state, &pane_id, &agent.id)?;

        // SessionStart may fire immediately after exec. Reserve the pane binding
        // before spawn so the control socket's pane/agent scope check accepts that
        // first hook instead of losing the session and transcript identity.
        attach_grok_agent_pane(state, &agent.id, pane_id.clone(), has_initial_prompt)?;
        let spawn_result = plan_to_spec(
            state,
            PaneMeta {
                pane_id: Some(pane_id.clone()),
                agent_id: Some(agent.id.clone()),
                group_id: agent.group_id.clone(),
                kind: PaneKind::Agent,
                title: self.display_name().to_string(),
                last_osc_title: None,
                initial_size: request.initial_size,
                recovered: false,
            },
            CommandPlan {
                program: binary,
                args,
                cwd,
                envs,
                support_files: Vec::new(),
                support_file_fallback: None,
            },
        )
        .and_then(|spec| spawn_pty(state, spec));

        match spawn_result {
            Ok(pane) => Ok(pane),
            Err(err) => {
                let _ = mark_agent_spawn_failed(state, &agent.id, &pane_id);
                Err(err)
            }
        }
    }

    /// Forks a Grok session into a new independent session using
    /// `--resume <source> --fork-session`, optionally in a Session worktree.
    pub fn fork_pane(
        &self,
        state: &AppState,
        source: &AgentInfo,
        use_worktree: bool,
        prompt: Option<&str>,
    ) -> Result<(PaneInfo, AgentInfo), String> {
        let binary = self.ensure_binary()?;
        ensure_grok_integration()?;
        let session_id = source
            .session_id
            .clone()
            .map(|session| session.trim().to_string())
            .filter(|session| !session.is_empty())
            .ok_or_else(|| {
                "this Grok session isn't ready to fork yet (no session id); send a turn first"
                    .to_string()
            })?;

        let mut agent = prepare_agent_workspace_with_parent(
            state,
            PrepareAgentWorkspaceRequest {
                group_id: Some(source.group_id.clone()),
                base_repo: if use_worktree {
                    None
                } else {
                    Some(source.worktree_dir.clone())
                },
                base_ref: Some("HEAD".to_string()),
                adapter: self.id().to_string(),
                model: source.model.clone(),
                effort: source.effort.clone(),
                use_worktree,
            },
            Some(&source.id),
        )?;
        agent.fork_point = Some(session_id.clone());
        agent.root_session_id = source
            .root_session_id
            .clone()
            .or_else(|| Some(session_id.clone()));
        agent.status = AgentStatus::Idle;
        state.update_agent(agent.clone())?;

        let cwd = recoverable_dir(&agent.worktree_dir).ok_or_else(|| {
            format!(
                "fork working directory {} does not exist",
                agent.worktree_dir
            )
        })?;
        let prompt = prompt.map(str::trim).unwrap_or_default();
        let has_initial_prompt = !prompt.is_empty();
        let args = build_grok_fork_args(
            &cwd,
            agent.model.as_deref(),
            &session_id,
            has_initial_prompt.then_some(prompt),
        );

        let pane_id = state.next_id("pane");
        let envs = agent_pane_envs(state, &pane_id, &agent.id)?;

        // Reserve the binding before spawn so a fast SessionStart hook passes the
        // authenticated pane/agent scope check. Roll it back if process creation fails.
        attach_grok_agent_pane(state, &agent.id, pane_id.clone(), has_initial_prompt)?;
        let spawn_result = plan_to_spec(
            state,
            PaneMeta {
                pane_id: Some(pane_id.clone()),
                agent_id: Some(agent.id.clone()),
                group_id: agent.group_id.clone(),
                kind: PaneKind::Agent,
                title: self.display_name().to_string(),
                last_osc_title: None,
                initial_size: None,
                recovered: false,
            },
            CommandPlan {
                program: binary,
                args,
                cwd,
                envs,
                support_files: Vec::new(),
                support_file_fallback: None,
            },
        )
        .and_then(|spec| spawn_pty(state, spec));

        match spawn_result {
            Ok(pane) => {
                let forked = state.agent(&agent.id)?.unwrap_or_else(|| agent.clone());
                Ok((pane, forked))
            }
            Err(err) => {
                let _ = mark_agent_spawn_failed(state, &agent.id, &pane_id);
                Err(err)
            }
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrokLaunchOptions {}

impl GrokLaunchOptions {
    fn from_value(value: Value) -> Result<Self, String> {
        if value.is_null() {
            return Ok(Self::default());
        }
        serde_json::from_value(value).map_err(|err| format!("invalid Grok adapter options: {err}"))
    }
}

/// Builds the argument list for a Session-launched Grok process. Uses the xAI Grok
/// Build CLI contract: `--cwd <dir>` for the working directory, `--model <model>`,
/// and the initial prompt as a trailing positional argument (which starts the
/// interactive TUI and submits the prompt immediately — unlike `-p/--prompt`, which
/// runs headless and exits, so it can't back an interactive pane).
fn build_grok_args(cwd: &Path, model: Option<&str>, prompt: &str) -> Vec<String> {
    let mut args = Vec::new();

    // The working directory is passed explicitly so Grok runs in the agent's cwd
    // even when the process cwd differs (e.g. worktree paths).
    args.push("--cwd".to_string());
    args.push(cwd.display().to_string());

    if let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }

    // The interactive initial prompt is a trailing positional, so it must come after
    // all flags. Delimit it with `--` so a prompt that starts with `-` (e.g. queued
    // text delivered to a new session) is parsed as the positional prompt rather
    // than as a Grok flag; mirrors the Claude and Codex launch paths.
    let prompt = prompt.trim();
    if !prompt.is_empty() {
        args.push("--".to_string());
        args.push(prompt.to_string());
    }

    args
}

fn build_grok_fork_args(
    cwd: &Path,
    model: Option<&str>,
    session_id: &str,
    prompt: Option<&str>,
) -> Vec<String> {
    let mut args = build_grok_args(cwd, model, "");
    args.push("--resume".to_string());
    args.push(session_id.to_string());
    args.push("--fork-session".to_string());
    if let Some(prompt) = prompt.map(str::trim).filter(|prompt| !prompt.is_empty()) {
        args.push("--".to_string());
        args.push(prompt.to_string());
    }
    args
}

/// Ensures the Session Grok hook integration is present. Writes are skipped when
/// the shim script and `hooks/session.json` already match the expected content.
/// Best-effort cleanup also strips stale Session entries from the legacy
/// `user-settings.json` location (Grok never loads hooks from there).
fn ensure_grok_integration() -> Result<(), String> {
    let grok_home = grok_home()?;
    write_grok_integration_files(&grok_home)
}

/// The Grok config home. Honors a `GROK_HOME` override (used by tests and unusual
/// installs); otherwise `~/.grok`, where Grok keeps its user settings and sessions.
fn grok_home() -> Result<PathBuf, String> {
    env::var_os("GROK_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".grok")))
        .ok_or_else(|| "GROK_HOME and HOME are not set; cannot configure Grok hooks".to_string())
}

/// Path of the Session-owned global hook file under `$GROK_HOME/hooks/`. Grok merges
/// every `*.json` in that directory as always-trusted global hooks.
fn grok_hooks_file_path(grok_home: &Path) -> PathBuf {
    grok_home.join("hooks").join("session.json")
}

/// Native Grok conversations live at
/// `$GROK_HOME/sessions/<percent-encoded-cwd>/<session-id>/chat_history.jsonl`.
/// Very long cwd values use a hashed group directory, so scan the one-level group
/// list as a fallback when the conventional path is not present yet.
fn grok_session_transcript_path(grok_home: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty()
        || session_id.len() > 128
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }

    let sessions_root = grok_home.join("sessions");
    let encoded_cwd = percent_encode_grok_cwd(cwd);
    let conventional = sessions_root
        .join(&encoded_cwd)
        .join(session_id)
        .join("chat_history.jsonl");
    if conventional.parent().is_some_and(Path::is_dir) {
        return Some(conventional);
    }

    if let Ok(groups) = fs::read_dir(&sessions_root) {
        for group in groups.flatten() {
            let Ok(file_type) = group.file_type() else {
                continue;
            };
            if !file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            // Hashed long-cwd group names carry the original directory in `.cwd`.
            // Require that proof before accepting a non-conventional group; hook
            // payloads are agent-controlled and must not bind another project's
            // transcript merely by naming its session id.
            let Ok(recorded_cwd) = fs::read_to_string(group.path().join(".cwd")) else {
                continue;
            };
            if recorded_cwd.trim_end() != cwd {
                continue;
            }
            let candidate = group.path().join(session_id).join("chat_history.jsonl");
            if candidate.parent().is_some_and(Path::is_dir) {
                return Some(candidate);
            }
        }
    }

    // SessionStart normally fires after the session directory is created. If the
    // filesystem is briefly behind, return the predictable path and let the tail's
    // normal warm-up polling wait for chat_history.jsonl to appear.
    (encoded_cwd.len() <= 255).then_some(conventional)
}

pub(crate) fn research_session_transcript_path(cwd: &Path, session_id: &str) -> Option<PathBuf> {
    let home = grok_home().ok()?;
    grok_session_transcript_path(&home, &cwd.display().to_string(), session_id)
}

fn percent_encode_grok_cwd(cwd: &str) -> String {
    let mut encoded = String::with_capacity(cwd.len());
    for byte in cwd.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(*byte as char);
        } else {
            const HEX: &[u8; 16] = b"0123456789ABCDEF";
            encoded.push('%');
            encoded.push(HEX[(byte >> 4) as usize] as char);
            encoded.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    encoded
}

fn write_grok_integration_files(grok_home: &Path) -> Result<(), String> {
    let session_dir = grok_home.join("session");
    fs::create_dir_all(&session_dir)
        .map_err(|err| format!("failed to create {}: {err}", session_dir.display()))?;

    let shim_path = session_dir.join("session-grok-hook");

    // Only rewrite the shim when missing, content differs, or permissions are wrong.
    if !shim_is_up_to_date(&shim_path) {
        fs::write(&shim_path, grok_hook_shim())
            .map_err(|err| format!("failed to write {}: {err}", shim_path.display()))?;
        fs::set_permissions(&shim_path, fs::Permissions::from_mode(0o755))
            .map_err(|err| format!("failed to chmod {}: {err}", shim_path.display()))?;
    }

    let hooks_dir = grok_home.join("hooks");
    fs::create_dir_all(&hooks_dir)
        .map_err(|err| format!("failed to create {}: {err}", hooks_dir.display()))?;

    let hooks_path = grok_hooks_file_path(grok_home);
    let desired = grok_hooks_file_contents(&shim_path);
    // Session fully owns this file; rewrite only when content drifts (missing events,
    // stale shim path, leftover matchers from older installs).
    if !hooks_file_is_up_to_date(&hooks_path, &desired) {
        fs::write(&hooks_path, desired)
            .map_err(|err| format!("failed to write {}: {err}", hooks_path.display()))?;
    }

    // Older Session versions installed hooks into `user-settings.json`, which Grok
    // does not load. Strip our entries so the invalid config does not confuse users
    // or reappear after a manual merge; failures here are non-fatal.
    let _ = strip_stale_user_settings_hooks(grok_home, &shim_path);

    Ok(())
}

/// POSIX shim that forwards a Grok lifecycle event to `session notify <event>`. No-ops
/// (exit 0) unless launched inside a Session pane, so a standalone `grok` run that
/// inherits the globally-installed hook is unaffected. The event JSON Grok writes to
/// the shim's stdin is passed through to Session, which reads it as the hook payload.
fn grok_hook_shim() -> &'static str {
    r#"#!/bin/sh
event="${1:-}"
if [ -z "$event" ]; then
  exit 0
fi
if [ -z "${SESSION_SOCK:-}" ] || [ -z "${SESSION_TOKEN:-}" ] || [ -z "${SESSION_PANE_ID:-}" ] || [ -z "${SESSION_AGENT_ID:-}" ] || [ -z "${SESSION_CLI:-}" ]; then
  exit 0
fi
exec "$SESSION_CLI" notify "$event"
"#
}

/// Builds the Session-owned `hooks/session.json` document. Grok's lifecycle events
/// (`SessionStart`, `UserPromptSubmit`, `Stop`, …) reject a `matcher` field
/// (`LifecycleMatcherNotAllowed`), so entries omit it; an omitted matcher on tool
/// events matches every tool.
fn grok_hooks_document(shim_path: &Path) -> Value {
    let command_prefix = shell_quote_path(shim_path);
    let mut hooks = serde_json::Map::new();
    for event in GROK_HOOK_EVENTS {
        hooks.insert(
            event.to_string(),
            json!([
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": format!("{command_prefix} {event}"),
                        }
                    ]
                }
            ]),
        );
    }
    json!({ "hooks": hooks })
}

fn grok_hooks_file_contents(shim_path: &Path) -> String {
    // Pretty JSON with trailing newline so re-writes are stable and diffs are readable.
    let mut raw = serde_json::to_string_pretty(&grok_hooks_document(shim_path))
        .expect("hooks document is always serializable");
    raw.push('\n');
    raw
}

/// Whether a hook matcher entry is one Session installed, i.e. one of its `command`s
/// runs the Session Grok shim. Used when stripping stale entries from the legacy
/// `user-settings.json` path. Matches on filename so absolute paths from previous
/// installations are cleaned up too.
fn is_session_grok_hook_entry(entry: &Value, shim_path: &Path) -> bool {
    let needle = shim_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("session-grok-hook");
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| {
            hooks.iter().any(|hook| {
                hook.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|command| command.contains(needle))
            })
        })
}

/// Returns whether the shim script exists, has exactly the expected content, and
/// has all executable bits set.
fn shim_is_up_to_date(shim_path: &Path) -> bool {
    let Ok(content) = fs::read_to_string(shim_path) else {
        return false;
    };
    if content != grok_hook_shim() {
        return false;
    }
    match fs::metadata(shim_path) {
        Ok(meta) => (meta.permissions().mode() & 0o111) == 0o111,
        Err(_) => false,
    }
}

fn hooks_file_is_up_to_date(hooks_path: &Path, desired: &str) -> bool {
    fs::read_to_string(hooks_path).is_ok_and(|content| content == desired)
}

/// Removes Session-owned hook entries from the legacy `user-settings.json` location.
/// Pre-fix Session versions wrote hooks there, but Grok only discovers global hooks
/// from `~/.grok/hooks/*.json` (and Claude/Cursor compat paths). Leaving the stale
/// entries is harmless at runtime but confuses anyone inspecting settings; strip
/// them when present. Returns `Ok(true)` when the file was rewritten.
fn strip_stale_user_settings_hooks(grok_home: &Path, shim_path: &Path) -> Result<bool, String> {
    let settings_path = grok_home.join("user-settings.json");
    let Ok(raw) = fs::read_to_string(&settings_path) else {
        return Ok(false);
    };
    if raw.trim().is_empty() {
        return Ok(false);
    }
    let mut settings: Value = serde_json::from_str(&raw)
        .map_err(|err| format!("failed to parse {}: {err}", settings_path.display()))?;
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return Ok(false);
    };

    let mut changed = false;
    // Walk every event (including ones we no longer install, e.g. PermissionRequest)
    // so leftover Session entries from older versions are fully removed.
    let event_keys: Vec<String> = hooks.keys().cloned().collect();
    for event in event_keys {
        let Some(list) = hooks.get_mut(&event).and_then(Value::as_array_mut) else {
            continue;
        };
        let before = list.len();
        list.retain(|item| !is_session_grok_hook_entry(item, shim_path));
        if list.len() != before {
            changed = true;
        }
        if list.is_empty() {
            hooks.remove(&event);
            changed = true;
        }
    }
    if hooks.is_empty()
        && let Some(obj) = settings.as_object_mut()
    {
        obj.remove("hooks");
        changed = true;
    }
    if !changed {
        return Ok(false);
    }

    let raw = serde_json::to_string_pretty(&settings)
        .map_err(|err| format!("failed to encode {}: {err}", settings_path.display()))?;
    fs::write(&settings_path, raw)
        .map_err(|err| format!("failed to write {}: {err}", settings_path.display()))?;
    Ok(true)
}

fn prompt_has_initial_text(prompt: &str) -> bool {
    !prompt.trim().is_empty()
}

fn attach_grok_agent_pane(
    state: &AppState,
    agent_id: &str,
    pane_id: String,
    has_initial_prompt: bool,
) -> Result<AgentInfo, String> {
    let agent = attach_agent_pane(state, agent_id, pane_id)?;
    if !has_initial_prompt {
        // Field-scoped write — a full-struct update here would race the SessionStart
        // hook recording session_id on another thread. Return the post-write state so
        // callers see the final Idle status.
        if let Some(updated) = state.set_agent_status(agent_id, AgentStatus::Idle)? {
            return Ok(updated);
        }
    }
    Ok(agent)
}

/// Parses a transcript line for a Grok agent.
///
/// Grok Build uses Claude-compatible rollout transcripts (the path it reports in
/// the SessionStart hook under `transcript_path`). We therefore support the native
/// Claude-style JSONL format first (same as the Claude adapter). We also support
/// the synthetic "response_item" format (used by Codex) as a fallback for the
/// session-managed transcript path or future Grok plugin writers.
///
/// ```json
/// // Native (Claude/Grok rollout)
/// {"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}
///
/// // Synthetic (response_item)
/// {"type":"response_item","payload":{"type":"message","role":"user","content":[...]},"session_id":"..."}
/// ```
fn parse_transcript_line(agent_id: &str, source_index: usize, line: &str) -> Option<Turn> {
    // Parse once, then try each shape against the same value — the tail calls this per
    // line, so re-parsing per attempt doubled the JSON work on hot streaming output.
    let value = serde_json::from_str::<Value>(line).ok()?;

    // Current Grok chat_history.jsonl format. Assistant records may carry both
    // visible text and multiple tool calls; tool results are separate records.
    if value.get("content").is_some()
        || value.get("tool_calls").is_some()
        || value.get("tool_call_id").is_some()
        || matches!(
            value.get("type").and_then(Value::as_str),
            Some("reasoning" | "backend_tool_call")
        )
    {
        return parse_grok_chat_history_value(agent_id, source_index, &value);
    }

    // Primary: native Claude-compatible rollout format. This is what Grok reports
    // via its SessionStart hook for real sessions (under ~/.grok/sessions/...).
    if let Some(turn) = super::parse_claude_native_transcript_value(agent_id, source_index, &value)
    {
        return Some(turn);
    }

    // Fallback: synthetic response_item format (for the .session/grok fallback path
    // or if a future plugin emits it).
    if value.get("type").and_then(Value::as_str) != Some("response_item") {
        return None;
    }
    let payload = value.get("payload")?;
    let item_type = payload.get("type").and_then(Value::as_str)?;
    let session_id = super::string_field(&value, "session_id")
        .or_else(|| super::string_field(&value, "sessionId"));

    let (role, blocks) = match item_type {
        "message" => {
            let role = payload.get("role").and_then(Value::as_str)?;
            if role == "developer" || role == "system" {
                return None;
            }
            let blocks = parse_grok_synthetic_message_blocks(payload.get("content"))?;
            (role.to_string(), blocks)
        }
        "tool_use" | "function_call" | "custom_tool_call" => {
            let name = super::string_field(payload, "name").unwrap_or_else(|| "tool".to_string());
            (
                "assistant".to_string(),
                vec![TurnBlock::ToolUse {
                    id: super::string_field(payload, "id")
                        .or_else(|| super::string_field(payload, "call_id"))
                        .or_else(|| super::string_field(payload, "callId")),
                    name,
                    input: payload.get("input").cloned().unwrap_or(Value::Null),
                }],
            )
        }
        "tool_result" | "function_call_output" | "custom_tool_call_output" => (
            "assistant".to_string(),
            vec![TurnBlock::ToolResult {
                tool_use_id: super::string_field(payload, "tool_use_id")
                    .or_else(|| super::string_field(payload, "toolUseId"))
                    .or_else(|| super::string_field(payload, "call_id"))
                    .or_else(|| super::string_field(payload, "callId")),
                content: payload.get("content").cloned().unwrap_or(Value::Null),
                is_error: payload
                    .get("is_error")
                    .or_else(|| payload.get("isError"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }],
        ),
        _ => return None,
    };

    if blocks.is_empty() {
        return None;
    }

    Some(Turn {
        id: format!("{agent_id}-{source_index}"),
        agent_id: agent_id.to_string(),
        session_id,
        role,
        blocks,
        source_index,
        timestamp: super::native_timestamp_ms(&value),
        status: None,
        status_reason: None,
        context_status: None,
        native_id: super::string_field(payload, "id"),
        parent_native_id: None,
        native_message_id: super::string_field(payload, "id"),
    })
}

fn parse_grok_chat_history_value(
    agent_id: &str,
    source_index: usize,
    value: &Value,
) -> Option<Turn> {
    let record_type = value.get("type").and_then(Value::as_str)?;
    let (role, blocks, native_message_id) = match record_type {
        "user" => {
            // Grok persists injected project/skill reminders as synthetic user
            // records. They are private harness context rather than conversation.
            if value.get("synthetic_reason").is_some() {
                return None;
            }
            let mut blocks = parse_grok_synthetic_message_blocks(value.get("content"))?;
            for block in &mut blocks {
                if let TurnBlock::Text { text } = block {
                    if let Some(normalized) = normalize_grok_user_message_text(text) {
                        *text = normalized;
                    }
                }
            }
            ("user".to_string(), blocks, None)
        }
        "assistant" => {
            let mut blocks =
                parse_grok_synthetic_message_blocks(value.get("content")).unwrap_or_default();
            // Grok emits `content: ""` for tool-only assistant records. Keeping
            // that as a text block creates an empty message boundary between
            // tool batches, preventing the transcript timeline from grouping
            // consecutive calls into one disclosure.
            blocks.retain(
                |block| !matches!(block, TurnBlock::Text { text } if text.trim().is_empty()),
            );
            if let Some(tool_calls) = value.get("tool_calls").and_then(Value::as_array) {
                for tool_call in tool_calls {
                    let arguments = match tool_call.get("arguments") {
                        Some(Value::String(raw)) => {
                            serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.clone()))
                        }
                        Some(arguments) => arguments.clone(),
                        None => Value::Null,
                    };
                    blocks.push(TurnBlock::ToolUse {
                        id: super::string_field(tool_call, "id"),
                        name: super::string_field(tool_call, "name")
                            .unwrap_or_else(|| "tool".to_string()),
                        input: arguments,
                    });
                }
            }
            ("assistant".to_string(), blocks, None)
        }
        "tool_result" => {
            let tool_use_id = super::string_field(value, "tool_call_id");
            (
                "assistant".to_string(),
                vec![TurnBlock::ToolResult {
                    tool_use_id: tool_use_id.clone(),
                    content: value.get("content").cloned().unwrap_or(Value::Null),
                    is_error: value
                        .get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                }],
                tool_use_id,
            )
        }
        _ => return None,
    };

    if blocks.is_empty()
        || blocks
            .iter()
            .all(|block| matches!(block, TurnBlock::Text { text } if text.trim().is_empty()))
    {
        return None;
    }

    Some(Turn {
        id: format!("{agent_id}-{source_index}"),
        agent_id: agent_id.to_string(),
        session_id: None,
        role,
        blocks,
        source_index,
        timestamp: super::native_timestamp_ms(value),
        status: None,
        status_reason: None,
        context_status: None,
        native_id: native_message_id.clone(),
        parent_native_id: None,
        native_message_id,
    })
}

/// Normalize Grok user-message text so Session renders a real user bubble.
///
/// Current Grok chat histories wrap user-authored text in a `<user_query>`
/// envelope and may also prefix an `<image_files>` harness block when the
/// prompt included attachments. Leaving either tag in the transcript makes
/// Session's generic injected-instruction detector classify the whole turn as
/// private harness context — collapsing the user's words into a
/// `<image_files> <user_query>` chip (or nothing) and never showing them as a
/// message. Extract the query body and turn listed image paths into
/// `[Image: <path>]` markers the transcript can thumbnail.
fn normalize_grok_user_message_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let image_paths = extract_grok_image_file_paths(trimmed);
    let query = extract_grok_user_query(trimmed);

    match (query, image_paths.is_empty()) {
        (None, true) => None,
        (Some(query), true) => Some(query.to_string()),
        (Some(query), false) => {
            // Numbered `[Image #N]` refs are Grok's inline placeholders for the
            // paths listed above; with real path markers they would double-draw.
            let body = strip_numbered_image_refs(query);
            let markers = image_path_markers(&image_paths);
            if body.trim().is_empty() {
                Some(markers.join("\n"))
            } else {
                Some(format!("{}\n{}", markers.join("\n"), body.trim_end()))
            }
        }
        (None, false) => Some(image_path_markers(&image_paths).join("\n")),
    }
}

fn extract_grok_user_query(text: &str) -> Option<&str> {
    const OPEN: &str = "<user_query>";
    const CLOSE: &str = "</user_query>";

    let start = text.find(OPEN)?;
    let content_start = start + OPEN.len();
    let close_rel = text[content_start..].find(CLOSE)?;
    let content = &text[content_start..content_start + close_rel];
    Some(content.trim_matches(['\r', '\n']))
}

/// Paths listed inside a Grok `<image_files>…</image_files>` harness block.
/// Lines look like `1. /absolute/path.png`.
fn extract_grok_image_file_paths(text: &str) -> Vec<String> {
    const OPEN: &str = "<image_files>";
    const CLOSE: &str = "</image_files>";

    let Some(start) = text.find(OPEN) else {
        return Vec::new();
    };
    let content_start = start + OPEN.len();
    let Some(close_rel) = text[content_start..].find(CLOSE) else {
        return Vec::new();
    };
    let body = &text[content_start..content_start + close_rel];
    let mut paths = Vec::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let candidate = line
            .split_once(". ")
            .map(|(_, rest)| rest.trim())
            .unwrap_or(line);
        if candidate.starts_with('/') {
            paths.push(candidate.to_string());
        }
    }
    paths
}

fn image_path_markers(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .map(|path| format!("[Image: {path}]"))
        .collect()
}

/// Drop Grok's pathless `[Image #N]` placeholders once real path markers exist.
fn strip_numbered_image_refs(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("[Image #") {
        result.push_str(&rest[..start]);
        let after_prefix = start + "[Image #".len();
        match rest[after_prefix..].find(']') {
            Some(close_rel) => {
                let digits = &rest[after_prefix..after_prefix + close_rel];
                if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) {
                    rest = &rest[after_prefix + close_rel + 1..];
                    continue;
                }
                // Not a pure numbered ref — keep the opening and continue after it.
                result.push_str(&rest[start..after_prefix]);
                rest = &rest[after_prefix..];
            }
            None => {
                result.push_str(&rest[start..]);
                return result;
            }
        }
    }
    result.push_str(rest);
    result
}

fn parse_transcript_lifecycle_event(line: &str) -> Option<TranscriptLifecycleEvent> {
    // Parse once and check both shapes against the same value (see parse_transcript_line).
    let value = serde_json::from_str::<Value>(line).ok()?;

    // Support Claude-style interruption markers (native rollouts).
    if let Some(ev) = super::parse_claude_native_lifecycle_value(&value) {
        return Some(ev);
    }

    // Support synthetic event_msg for the Session fallback path.
    if value.get("type").and_then(Value::as_str) != Some("event_msg") {
        return None;
    }
    let payload = value.get("payload")?;
    (payload.get("type").and_then(Value::as_str) == Some("turn_aborted"))
        .then_some(TranscriptLifecycleEvent::Interrupted)
}

/// Parses blocks from a synthetic response_item payload (mirrors Codex shape).
fn parse_grok_synthetic_message_blocks(content: Option<&Value>) -> Option<Vec<TurnBlock>> {
    match content? {
        Value::String(text) => Some(vec![TurnBlock::Text { text: text.clone() }]),
        Value::Array(items) => {
            let blocks =
                items
                    .iter()
                    .filter_map(|item| {
                        let block_type = item.get("type").and_then(Value::as_str);
                        match block_type {
                            Some("text") => item.get("text").and_then(Value::as_str).map(|text| {
                                TurnBlock::Text {
                                    text: text.to_string(),
                                }
                            }),
                            Some("tool_use") => Some(TurnBlock::ToolUse {
                                id: item
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .map(ToString::to_string),
                                name: item
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .unwrap_or("tool")
                                    .to_string(),
                                input: item.get("input").cloned().unwrap_or(Value::Null),
                            }),
                            Some("tool_result") => Some(TurnBlock::ToolResult {
                                tool_use_id: item
                                    .get("tool_use_id")
                                    .and_then(Value::as_str)
                                    .map(ToString::to_string),
                                content: item.get("content").cloned().unwrap_or(Value::Null),
                                is_error: item
                                    .get("is_error")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                            }),
                            _ => item.get("text").and_then(Value::as_str).map(|text| {
                                TurnBlock::Text {
                                    text: text.to_string(),
                                }
                            }),
                        }
                    })
                    .collect::<Vec<_>>();
            Some(blocks)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, GrokAdapterConfig,
    };
    use crate::state::AppState;
    use std::path::PathBuf;

    fn test_config() -> SessionConfig {
        SessionConfig {
            remotes: Default::default(),
            workspace_root: PathBuf::from("/tmp/session-grok-tests"),
            socket_path: PathBuf::from("/tmp/session-grok-tests.sock"),
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
            claude_plugin_dir: PathBuf::new(),
        }
    }

    fn test_state() -> AppState {
        AppState::new(test_config())
    }

    fn sample_agent() -> AgentInfo {
        AgentInfo {
            id: "agent-1".to_string(),
            group_id: "group-1".to_string(),
            adapter: "grok".to_string(),
            worktree_dir: "/tmp/session-grok-tests".to_string(),
            branch: None,
            active_workspace: None,
            pane_id: None,
            orphaned_queue_pane_id: None,
            session_id: None,
            transcript_path: None,
            status: AgentStatus::Starting,
            model: None,
            effort: None,
            approval_mode: None,
            parent_id: None,
            fork_point: None,
            root_session_id: None,
            thread_id: None,
            branch_id: None,
            native_leaf_id: None,
            paused: false,
            created_at: 1,
        }
    }

    #[test]
    fn launch_options_reject_unknown_fields() {
        let err = GrokLaunchOptions::from_value(json!({ "bogus": true })).unwrap_err();
        assert!(err.contains("invalid Grok adapter options"));
    }

    #[test]
    fn build_args_adds_cwd_model_and_positional_prompt() {
        let args = build_grok_args(Path::new("/tmp/session"), Some("grok-code"), "fix the bug");

        // The prompt is a trailing positional, after --cwd and --model, delimited
        // with `--` so leading-dash text can't be parsed as a flag.
        assert_eq!(
            args,
            vec![
                "--cwd",
                "/tmp/session",
                "--model",
                "grok-code",
                "--",
                "fix the bug"
            ]
        );
    }

    #[test]
    fn build_args_omit_empty_prompt_and_model() {
        let args = build_grok_args(Path::new("/tmp/session"), None, "  ");

        assert_eq!(args, vec!["--cwd", "/tmp/session"]);
    }

    #[test]
    fn fork_args_resume_into_new_session_and_append_prompt() {
        let args = build_grok_fork_args(
            Path::new("/tmp/session"),
            Some("grok-build"),
            "source-session",
            Some(" continue here "),
        );

        assert_eq!(
            args,
            vec![
                "--cwd",
                "/tmp/session",
                "--model",
                "grok-build",
                "--resume",
                "source-session",
                "--fork-session",
                "--",
                "continue here",
            ]
        );
    }

    #[test]
    fn shell_commands_include_grok_and_agent_alias() {
        let commands: Vec<_> = GrokAdapter::new(&test_config())
            .shell_commands()
            .into_iter()
            .map(|command| (command.command_name, command.adapter_id))
            .collect();
        assert_eq!(commands, vec![("grok", "grok"), ("agent", "grok")]);
    }

    #[test]
    fn interactive_attach_marks_agent_idle() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::Starting;
        agent.pane_id = None;
        state.insert_agent(agent).unwrap();

        let attached =
            attach_grok_agent_pane(&state, "agent-1", "pane-1".to_string(), false).unwrap();

        assert!(matches!(attached.status, AgentStatus::Idle));
        let stored = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(matches!(stored.status, AgentStatus::Idle));
    }

    #[test]
    fn prompted_attach_keeps_agent_running() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::Starting;
        agent.pane_id = None;
        state.insert_agent(agent).unwrap();

        let attached =
            attach_grok_agent_pane(&state, "agent-1", "pane-1".to_string(), true).unwrap();

        assert!(matches!(attached.status, AgentStatus::Running));
    }

    #[test]
    fn parse_transcript_line_extracts_user_message() {
        let line = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"text","text":"hello world"}]},"session_id":"sess-1"}"#;

        let turn = parse_transcript_line("agent-1", 0, line).unwrap();

        assert_eq!(turn.role, "user");
        assert_eq!(turn.session_id.as_deref(), Some("sess-1"));
        assert_eq!(turn.blocks.len(), 1);
        match &turn.blocks[0] {
            TurnBlock::Text { text } => assert_eq!(text, "hello world"),
            other => panic!("expected text block, got {other:?}"),
        }
    }

    #[test]
    fn parse_transcript_line_extracts_assistant_tool_use() {
        let line = r#"{"type":"response_item","payload":{"type":"tool_use","name":"bash","id":"call-1","input":{"command":"ls"}},"session_id":"sess-1"}"#;

        let turn = parse_transcript_line("agent-1", 1, line).unwrap();

        assert_eq!(turn.role, "assistant");
        assert_eq!(turn.blocks.len(), 1);
        match &turn.blocks[0] {
            TurnBlock::ToolUse { id, name, input } => {
                assert_eq!(id.as_deref(), Some("call-1"));
                assert_eq!(name, "bash");
                assert_eq!(input["command"], "ls");
            }
            other => panic!("expected tool use block, got {other:?}"),
        }
    }

    #[test]
    fn parse_transcript_line_ignores_developer_messages() {
        let line = r#"{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"text","text":"system"}]},"session_id":"sess-1"}"#;

        assert!(parse_transcript_line("agent-1", 0, line).is_none());
    }

    #[test]
    fn parse_grok_turn_aborted_lifecycle_event() {
        let abort_line = json!({
            "type": "event_msg",
            "payload": { "type": "turn_aborted", "reason": "interrupt" },
            "session_id": "sess-1"
        })
        .to_string();
        let ordinary_event_line = json!({
            "type": "event_msg",
            "payload": { "type": "status", "message": "ok" },
            "session_id": "sess-1"
        })
        .to_string();

        assert_eq!(
            parse_transcript_lifecycle_event(&abort_line),
            Some(TranscriptLifecycleEvent::Interrupted)
        );
        assert_eq!(parse_transcript_lifecycle_event(&ordinary_event_line), None);
    }

    #[test]
    fn native_session_transcript_path_encodes_cwd_and_confines_session_id() {
        let home =
            std::env::temp_dir().join(format!("session-grok-session-path-{}", std::process::id()));
        fs::create_dir_all(home.join("sessions")).unwrap();

        let path = grok_session_transcript_path(
            &home,
            "/Users/example/My Project",
            "019f4b23-836e-7260-909a-b975d090c6f8",
        )
        .unwrap();
        assert_eq!(
            path,
            home.join("sessions")
                .join("%2FUsers%2Fexample%2FMy%20Project")
                .join("019f4b23-836e-7260-909a-b975d090c6f8")
                .join("chat_history.jsonl")
        );
        assert!(grok_session_transcript_path(&home, "/tmp", "../other").is_none());

        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn native_session_transcript_path_resolves_verified_hashed_cwd_group() {
        let home = std::env::temp_dir().join(format!(
            "session-grok-hashed-session-path-{}",
            std::process::id()
        ));
        let group = home.join("sessions").join("long-path-deadbeef");
        let session_id = "019f4b23-836e-7260-909a-b975d090c6f8";
        fs::create_dir_all(group.join(session_id)).unwrap();
        fs::write(group.join(".cwd"), "/very/long/project\n").unwrap();

        let path = grok_session_transcript_path(&home, "/very/long/project", session_id).unwrap();
        assert_eq!(path, group.join(session_id).join("chat_history.jsonl"));
        assert!(grok_session_transcript_path(&home, "/another/project", session_id).is_some());
        assert_ne!(
            grok_session_transcript_path(&home, "/another/project", session_id).unwrap(),
            path
        );

        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn parses_native_grok_chat_history_messages_and_tools() {
        let user = json!({
            "type": "user",
            "content": [{ "type": "text", "text": "inspect the repo" }]
        })
        .to_string();
        let assistant = json!({
            "type": "assistant",
            "content": "I’ll inspect it.",
            "tool_calls": [{
                "id": "call-1",
                "name": "grep",
                "arguments": "{\"pattern\":\"TODO\"}"
            }]
        })
        .to_string();
        let result = json!({
            "type": "tool_result",
            "tool_call_id": "call-1",
            "content": "no matches"
        })
        .to_string();

        let user_turn = parse_transcript_line("agent-1", 10, &user).unwrap();
        assert_eq!(user_turn.role, "user");
        assert!(matches!(
            &user_turn.blocks[0],
            TurnBlock::Text { text } if text == "inspect the repo"
        ));

        let assistant_turn = parse_transcript_line("agent-1", 11, &assistant).unwrap();
        assert_eq!(assistant_turn.blocks.len(), 2);
        assert!(matches!(
            &assistant_turn.blocks[1],
            TurnBlock::ToolUse { id, name, input }
                if id.as_deref() == Some("call-1")
                    && name == "grep"
                    && input["pattern"] == "TODO"
        ));

        let result_turn = parse_transcript_line("agent-1", 12, &result).unwrap();
        assert!(matches!(
            &result_turn.blocks[0],
            TurnBlock::ToolResult { tool_use_id, content, .. }
                if tool_use_id.as_deref() == Some("call-1") && content == "no matches"
        ));

        let tool_only_assistant = json!({
            "type": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "call-2",
                "name": "write",
                "arguments": {"file_path": "notes.md"}
            }]
        })
        .to_string();
        let tool_only_turn = parse_transcript_line("agent-1", 13, &tool_only_assistant).unwrap();
        assert_eq!(tool_only_turn.blocks.len(), 1);
        assert!(matches!(
            &tool_only_turn.blocks[0],
            TurnBlock::ToolUse { id, name, .. }
                if id.as_deref() == Some("call-2") && name == "write"
        ));
    }

    #[test]
    fn unwraps_native_grok_user_query_envelope() {
        let user = json!({
            "type": "user",
            "content": [{
                "type": "text",
                "text": "<user_query>\ninspect the repo\n</user_query>"
            }]
        })
        .to_string();

        let turn = parse_transcript_line("agent-1", 10, &user).unwrap();

        assert_eq!(turn.role, "user");
        assert!(matches!(
            &turn.blocks[0],
            TurnBlock::Text { text } if text == "inspect the repo"
        ));
    }

    #[test]
    fn unwraps_grok_user_query_prefixed_by_image_files() {
        // Reproduces session 019fbe5f…: a follow-up prompt that includes an
        // attachment is stored as <image_files> + <user_query> in one text
        // block. The whole blob must not remain tagged-instruction harness.
        let user = json!({
            "type": "user",
            "content": [{
                "type": "text",
                "text": "<image_files>\nThe following images were provided by the user and saved to the workspace for future use:\n1. /Users/raymond/.grok/sessions/demo/assets/image-9fdc73f2.png\n\nThese images can be copied for use in other locations.\n</image_files>\n\n<user_query>\nokay, can you implement 2? let's see if that looks realistic enough to use.[Image #1] \n</user_query>"
            }, {
                "type": "image",
                "url": "data:image/png;base64,AAAA"
            }]
        })
        .to_string();

        let turn = parse_transcript_line("agent-1", 14, &user).unwrap();

        assert_eq!(turn.role, "user");
        let TurnBlock::Text { text } = &turn.blocks[0] else {
            panic!("expected a text block");
        };
        assert!(
            text.contains("okay, can you implement 2?"),
            "user query must survive: {text:?}"
        );
        assert!(
            text.contains("[Image: /Users/raymond/.grok/sessions/demo/assets/image-9fdc73f2.png]"),
            "image_files path must become a path marker: {text:?}"
        );
        assert!(
            !text.contains("<user_query>") && !text.contains("<image_files>"),
            "harness tags must be stripped: {text:?}"
        );
        assert!(
            !text.contains("[Image #1]"),
            "numbered placeholder should not double-draw next to the path marker: {text:?}"
        );
    }

    #[test]
    fn skips_native_grok_private_context_records() {
        let synthetic = json!({
            "type": "user",
            "content": [{ "type": "text", "text": "private harness context" }],
            "synthetic_reason": "system_reminder"
        })
        .to_string();
        let reasoning = json!({ "type": "reasoning", "summary": [] }).to_string();

        assert!(parse_transcript_line("agent-1", 0, &synthetic).is_none());
        assert!(parse_transcript_line("agent-1", 1, &reasoning).is_none());
    }

    #[test]
    fn grok_hook_shim_is_env_gated_and_forwards_notify() {
        let shim = grok_hook_shim();
        // No-ops outside Session: every required env var is checked.
        assert!(shim.contains("SESSION_SOCK"));
        assert!(shim.contains("SESSION_TOKEN"));
        assert!(shim.contains("SESSION_PANE_ID"));
        assert!(shim.contains("SESSION_AGENT_ID"));
        assert!(shim.contains("SESSION_CLI"));
        // Inside Session it forwards the event to `session notify`.
        assert!(shim.contains(r#"exec "$SESSION_CLI" notify "$event""#));
    }

    #[test]
    fn grok_hooks_document_installs_events_without_matchers() {
        let shim = Path::new("/home/user/.grok/session/session-grok-hook");
        let doc = grok_hooks_document(shim);

        // Every Session event gets exactly one entry whose command runs the shim,
        // and lifecycle events must not carry a matcher (Grok rejects them).
        for event in GROK_HOOK_EVENTS {
            let entries = doc["hooks"][event].as_array().expect("event array");
            assert_eq!(entries.len(), 1, "expected one entry for {event}");
            assert!(
                entries[0].get("matcher").is_none(),
                "{event} must omit matcher"
            );
            assert!(
                is_session_grok_hook_entry(&entries[0], shim),
                "missing Session hook entry for {event}"
            );
            let command = entries[0]["hooks"][0]["command"].as_str().unwrap();
            assert_eq!(command, format!("'{}' {event}", shim.display()));
        }
        // PermissionRequest is Claude-only and must not be installed for Grok.
        assert!(doc["hooks"].get("PermissionRequest").is_none());
    }

    #[test]
    fn write_grok_integration_files_creates_shim_and_hooks_file() {
        let home =
            std::env::temp_dir().join(format!("session-grok-home-create-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);

        write_grok_integration_files(&home).unwrap();

        let shim_path = home.join("session").join("session-grok-hook");
        let shim_meta = fs::metadata(&shim_path).expect("shim written");
        // Executable bit set so Grok can run it.
        assert_eq!(shim_meta.permissions().mode() & 0o111, 0o111);

        // Grok discovers global hooks from hooks/*.json — not user-settings.json.
        let hooks_path = home.join("hooks").join("session.json");
        let hooks_raw = fs::read_to_string(&hooks_path).unwrap();
        assert_eq!(hooks_raw, grok_hooks_file_contents(&shim_path));
        let hooks: Value = serde_json::from_str(&hooks_raw).unwrap();
        for event in GROK_HOOK_EVENTS {
            assert!(
                hooks["hooks"][event].is_array(),
                "missing hooks for {event}"
            );
            assert!(
                hooks["hooks"][event][0].get("matcher").is_none(),
                "{event} must omit matcher"
            );
        }
        assert!(!home.join("user-settings.json").exists());

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn write_grok_integration_files_is_noop_when_already_correct() {
        let home =
            std::env::temp_dir().join(format!("session-grok-home-noop-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);

        write_grok_integration_files(&home).unwrap();

        let shim_path = home.join("session").join("session-grok-hook");
        let hooks_path = home.join("hooks").join("session.json");

        // Make both files unwritable (shim keeps its exec bits) so any rewrite
        // attempt fails rather than silently producing identical bytes.
        fs::set_permissions(&shim_path, fs::Permissions::from_mode(0o555)).unwrap();
        fs::set_permissions(&hooks_path, fs::Permissions::from_mode(0o444)).unwrap();

        let result = write_grok_integration_files(&home);

        fs::set_permissions(&shim_path, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&hooks_path, fs::Permissions::from_mode(0o644)).unwrap();

        result.expect("second call should not write anything");

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn write_grok_integration_files_repairs_missing_or_stale_hooks() {
        let home =
            std::env::temp_dir().join(format!("session-grok-home-repair-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);

        write_grok_integration_files(&home).unwrap();

        let shim_path = home.join("session").join("session-grok-hook");
        let hooks_path = home.join("hooks").join("session.json");

        // Corrupt the hooks file: drop Stop and leave a stale SessionStart path.
        let corrupted = json!({
            "hooks": {
                "SessionStart": [{
                    "matcher": "",
                    "hooks": [{
                        "type": "command",
                        "command": "'/old/home/.grok/session/session-grok-hook' SessionStart"
                    }]
                }],
                "UserPromptSubmit": [{
                    "hooks": [{
                        "type": "command",
                        "command": format!("'{}' UserPromptSubmit", shim_path.display())
                    }]
                }]
            }
        });
        fs::write(
            &hooks_path,
            serde_json::to_string_pretty(&corrupted).unwrap(),
        )
        .unwrap();

        // Re-run should fully rewrite to the expected document.
        write_grok_integration_files(&home).unwrap();

        let repaired = fs::read_to_string(&hooks_path).unwrap();
        assert_eq!(repaired, grok_hooks_file_contents(&shim_path));

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn write_grok_integration_files_strips_legacy_user_settings_hooks() {
        let home =
            std::env::temp_dir().join(format!("session-grok-home-legacy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();

        let shim = home.join("session").join("session-grok-hook");
        // Simulate the pre-fix install: hooks only lived in user-settings.json.
        // Keep a user-owned SessionStart entry that cleanup must preserve.
        let legacy = json!({
            "model": "grok-code-fast",
            "hooks": {
                "SessionStart": [
                    {
                        "matcher": "",
                        "hooks": [{
                            "type": "command",
                            "command": format!("'{}' SessionStart", shim.display())
                        }]
                    },
                    {
                        "hooks": [{ "type": "command", "command": "echo user-hook" }]
                    }
                ],
                "Stop": [{
                    "matcher": "",
                    "hooks": [{
                        "type": "command",
                        "command": format!("'{}' Stop", shim.display())
                    }]
                }],
                "PermissionRequest": [{
                    "matcher": "",
                    "hooks": [{
                        "type": "command",
                        "command": format!("'{}' PermissionRequest", shim.display())
                    }]
                }]
            }
        });
        fs::write(
            home.join("user-settings.json"),
            serde_json::to_string_pretty(&legacy).unwrap(),
        )
        .unwrap();

        write_grok_integration_files(&home).unwrap();

        // New install path exists.
        assert!(home.join("hooks").join("session.json").exists());

        let cleaned: Value =
            serde_json::from_str(&fs::read_to_string(home.join("user-settings.json")).unwrap())
                .unwrap();
        // Unrelated settings preserved; user SessionStart hook kept; Session entries gone.
        assert_eq!(cleaned["model"], "grok-code-fast");
        let session_start = cleaned["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(session_start.len(), 1);
        assert_eq!(session_start[0]["hooks"][0]["command"], "echo user-hook");
        assert!(cleaned["hooks"].get("Stop").is_none());
        assert!(cleaned["hooks"].get("PermissionRequest").is_none());

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn parse_transcript_line_supports_claude_native_format_for_grok() {
        // Typical lines from a Grok/Claude-style rollout.jsonl (what SessionStart binds).
        let user_line = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": "hello from grok" }]
            },
            "session_id": "grok-sess-1"
        })
        .to_string();

        let turn = parse_transcript_line("agent-g1", 0, &user_line).expect("native user line");
        assert_eq!(turn.role, "user");
        assert_eq!(turn.session_id.as_deref(), Some("grok-sess-1"));
        match &turn.blocks[0] {
            TurnBlock::Text { text } => assert_eq!(text, "hello from grok"),
            other => panic!("expected text, got {other:?}"),
        }

        let tool_use_line = json!({
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "tool-99",
                    "name": "read_file",
                    "input": { "path": "foo.txt" }
                }]
            }
        })
        .to_string();

        let turn = parse_transcript_line("agent-g1", 1, &tool_use_line).unwrap();
        assert_eq!(turn.role, "assistant");
        match &turn.blocks[0] {
            TurnBlock::ToolUse { id, name, input } => {
                assert_eq!(id.as_deref(), Some("tool-99"));
                assert_eq!(name, "read_file");
                assert_eq!(input["path"], "foo.txt");
            }
            other => panic!("expected tool use {other:?}"),
        }
    }

    #[test]
    fn parse_transcript_lifecycle_supports_native_and_synthetic_for_grok() {
        let native_interrupt = json!({
            "type": "user",
            "message": {
                "content": [{ "type": "text", "text": "[Request interrupted by user]" }]
            }
        })
        .to_string();

        assert_eq!(
            parse_transcript_lifecycle_event(&native_interrupt),
            Some(TranscriptLifecycleEvent::Interrupted)
        );

        let synthetic = json!({
            "type": "event_msg",
            "payload": { "type": "turn_aborted" }
        })
        .to_string();

        assert_eq!(
            parse_transcript_lifecycle_event(&synthetic),
            Some(TranscriptLifecycleEvent::Interrupted)
        );
    }
}
