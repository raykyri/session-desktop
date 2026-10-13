use super::{
    AgentAdapter, ComposerPolicy, ShellCommandIntegration, SpawnAgentRequest,
    TranscriptLifecycleEvent, WorkspaceObservation, ensure_on_path,
    model_from_claude_native_transcript_line, record_shell_fork_lineage, shell_quote_path,
};
use crate::config::SessionConfig;
use crate::host::Host;
use crate::pty::{
    CommandPlan, PaneMeta, SupportFile, agent_pane_envs, plan_to_spec, recoverable_dir, spawn_pty,
};
use crate::state::{AppState, PaneInfo, PaneKind};
use crate::transcript::{Turn, TurnStatus, TurnStatusReason, rfc3339_to_epoch_ms};

#[cfg(test)]
use crate::transcript::TurnBlock;
use crate::workspace::{
    ActiveWorkspaceSource, AgentInfo, AgentStatus, PrepareAgentWorkspaceRequest, attach_agent_pane,
    mark_agent_failed, mark_agent_spawn_failed, prepare_agent_workspace_with_parent,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

const CLAUDE_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "PermissionDenied",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "Elicitation",
    "ElicitationResult",
    "SessionEnd",
];

const CLAUDE_NOTIFICATION_MATCHERS: &[(&str, &str)] = &[
    ("permission_prompt", "Notification.permission_prompt"),
    ("idle_prompt", "Notification.idle_prompt"),
    ("elicitation_dialog", "Notification.elicitation_dialog"),
];

const CLAUDE_PERMISSION_MODES: &[&str] = &[
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "dontAsk",
    "manual",
    "plan",
];

/// Effort levels accepted by the Claude CLI's `--effort` flag. Every current
/// Claude model (Opus, Fable, Sonnet) supports the full range.
const CLAUDE_EFFORT_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max", "ultracode"];

#[derive(Clone, Debug)]
pub struct ClaudeAdapter {
    binary: String,
    plugin_dir: PathBuf,
}

impl ClaudeAdapter {
    pub fn new(config: &SessionConfig) -> Self {
        Self {
            binary: config.claude_binary(),
            plugin_dir: config.claude_plugin_dir.clone(),
        }
    }

    /// `--plugin-dir` args that inject the session-managed plugin (and its skills)
    /// into a launched Claude instance. Emitted only when the plugin directory
    /// actually exists, so a checkout without one launches cleanly. This is the
    /// sole skill-injection vector: it points at a session-owned directory and never
    /// touches the user's `~/.claude` or the project's `.claude`.
    fn plugin_dir_args(&self, host: &Host) -> Vec<String> {
        // The bundled plugin lives beside the Session app. It is not implicitly
        // present on an SSH host, and passing its Mac path would make Claude
        // reject an otherwise valid remote launch. Lifecycle hooks are shipped
        // separately as a pane-owned settings file; remote plugin installation
        // can be added later without coupling basic terminal support to it.
        if host.is_local() && self.plugin_dir.is_dir() {
            vec![
                "--plugin-dir".to_string(),
                self.plugin_dir.display().to_string(),
            ]
        } else {
            Vec::new()
        }
    }

    fn ensure_binary(&self) -> Result<String, String> {
        let binary = ensure_on_path(&self.binary).ok_or_else(|| {
            format!(
                "Claude adapter binary '{}' was not found on PATH or standard macOS tool paths. Install Claude Code or update adapters.claude.binary in session.config.json.",
                self.binary
            )
        })?;
        Ok(binary.display().to_string())
    }

    fn host_for_group(&self, state: &AppState, group_id: &str) -> Result<Host, String> {
        let group = state.group(group_id)?;
        Ok(crate::host::for_group(
            group.as_ref().and_then(|group| group.remote.as_ref()),
        ))
    }

    fn binary_for_host(&self, host: &Host) -> Result<String, String> {
        if host.is_local() {
            self.ensure_binary()
        } else if self.binary.trim().is_empty() {
            Err("Claude adapter binary cannot be empty for a remote launch".to_string())
        } else {
            // Resolve on the machine that will execute it. `spawn_pty` hands
            // this name to tmux on the far side; checking the local PATH here
            // would turn a valid Linux install into a false negative (or leak
            // a Mac-only absolute path into the command plan).
            Ok(self.binary.clone())
        }
    }

    fn cwd_for_host(
        &self,
        host: &Host,
        path: &str,
        missing_message: impl FnOnce() -> String,
    ) -> Result<PathBuf, String> {
        if host.is_local() {
            recoverable_dir(path).ok_or_else(missing_message)
        } else {
            Ok(PathBuf::from(path))
        }
    }

    pub fn ensure_binary_for_sdk(&self) -> Result<String, String> {
        self.ensure_binary()
    }
}

impl AgentAdapter for ClaudeAdapter {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn display_name(&self) -> &'static str {
        "Claude"
    }

    fn configured_binary(&self) -> &str {
        &self.binary
    }

    fn supports_remote(&self) -> bool {
        true
    }

    fn launch(&self, state: &AppState, request: SpawnAgentRequest) -> Result<PaneInfo, String> {
        self.spawn_pane(state, request)
    }

    fn shell_commands(&self) -> Vec<ShellCommandIntegration> {
        vec![ShellCommandIntegration {
            command_name: "claude",
            adapter_id: self.id(),
        }]
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
        model_from_claude_native_transcript_line(line)
    }

    fn transcript_workspace_observation(&self, line: &str) -> Option<WorkspaceObservation> {
        claude_workspace_observation(line)
    }

    fn resolve_transcript_turns(
        &self,
        agent_id: &str,
        source_index_offset: usize,
        lines: &[String],
    ) -> Vec<Turn> {
        resolve_transcript_turns_from(agent_id, source_index_offset, lines)
    }

    fn transcript_line_can_update_turn_status(&self, line: &str) -> bool {
        claude_line_can_update_turn_status(line)
    }

    fn supports_fork(&self) -> bool {
        true
    }

    fn supports_research(&self) -> bool {
        true
    }

    fn supports_fork_at_message(&self) -> bool {
        true
    }

    fn fork_pane(
        &self,
        state: &AppState,
        source: &AgentInfo,
        use_worktree: bool,
        prompt: Option<&str>,
    ) -> Result<(PaneInfo, AgentInfo), String> {
        ClaudeAdapter::fork_pane(self, state, source, use_worktree, prompt)
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

impl ClaudeAdapter {
    fn spawn_pane(&self, state: &AppState, request: SpawnAgentRequest) -> Result<PaneInfo, String> {
        let options = ClaudeLaunchOptions::from_value(request.options)?;
        let resume_session_id = request
            .resume_session_id
            .as_deref()
            .map(str::trim)
            .filter(|session_id| !session_id.is_empty())
            .map(ToString::to_string);
        if request.fork_session && resume_session_id.is_none() {
            return Err("a Claude history fork requires a session id".to_string());
        }
        let lineage_cwd = request
            .cwd
            .as_deref()
            .or(request.base_repo.as_deref())
            .map(str::to_string);

        let mut agent = prepare_agent_workspace_with_parent(
            state,
            PrepareAgentWorkspaceRequest {
                group_id: request.group_id,
                base_repo: request.base_repo,
                base_ref: request.base_ref,
                adapter: self.id().to_string(),
                model: request.model.clone(),
                effort: options.effort.clone(),
                use_worktree: request.use_worktree.unwrap_or(false),
            },
            request.parent_id.as_deref(),
        )?;
        if let Some(session_id) = resume_session_id.as_ref() {
            if request.fork_session {
                let lineage_cwd = lineage_cwd
                    .as_deref()
                    .unwrap_or(&agent.worktree_dir)
                    .to_string();
                agent = record_shell_fork_lineage(
                    state,
                    agent,
                    self.id(),
                    Some(session_id),
                    &lineage_cwd,
                )?;
            } else {
                agent.session_id = Some(session_id.clone());
            }
            agent.status = AgentStatus::Idle;
            state.update_agent(agent.clone())?;
        }
        let cwd = request
            .cwd
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(&agent.worktree_dir));
        let host = self.host_for_group(state, &agent.group_id)?;
        let binary = self.binary_for_host(&host)?;
        if host.is_local() && !cwd.is_dir() {
            let _ = mark_agent_failed(state, &agent.id);
            return Err(format!(
                "Claude working directory {} does not exist",
                cwd.display()
            ));
        }
        let pane_id = state.next_id("pane");
        let (settings_path, hook_settings) =
            match hook_settings_support_file(state.config(), &pane_id) {
                Ok(planned) => planned,
                Err(err) => {
                    let _ = mark_agent_failed(state, &agent.id);
                    return Err(err);
                }
            };
        let mut args = vec![
            "--settings".to_string(),
            settings_path.display().to_string(),
        ];
        args.extend(self.plugin_dir_args(&host));

        if let Some(model) = request.model.filter(|model| !model.trim().is_empty()) {
            args.push("--model".to_string());
            args.push(model);
        }
        push_effort_args(&mut args, agent.effort.as_deref());

        let permission_mode = options.permission_mode.unwrap_or("auto".to_string());
        args.push("--permission-mode".to_string());
        args.push(permission_mode);

        if let Some(session_id) = resume_session_id {
            args.push("--resume".to_string());
            args.push(session_id);
            if request.fork_session {
                args.push("--fork-session".to_string());
            }
        }

        let prompt = request.prompt.trim();
        let has_prompt = !prompt.is_empty();
        if has_prompt {
            // Delimit the prompt with `--` so a prompt that starts with `-` (e.g.
            // queued text delivered to a new session) is parsed as the positional
            // prompt rather than as a Claude flag. Mirrors `fork_pane`.
            args.push("--".to_string());
            args.push(prompt.to_string());
        }

        let envs = agent_pane_envs(state, &pane_id, &agent.id)?;

        attach_agent_pane(state, &agent.id, pane_id.clone())?;

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
                support_files: vec![hook_settings],
                support_file_fallback: None,
            },
        )
        .and_then(|spec| spawn_pty(state, spec));

        match spawn_result {
            Ok(pane) => {
                if !has_prompt {
                    // Launched without a prompt: Claude opens interactively and is
                    // ready, so present the tab as idle rather than working.
                    // Field-scoped write — a full-struct update here would race the
                    // SessionStart hook recording session_id.
                    state.set_agent_status(&agent.id, AgentStatus::Idle)?;
                }
                Ok(pane)
            }
            Err(err) => {
                let _ = mark_agent_spawn_failed(state, &agent.id, &pane_id);
                Err(err)
            }
        }
    }

    /// Forks `source` into a new agent pane: a fresh Claude started with
    /// `--resume <source session> --fork-session [prompt]`, so it inherits the
    /// source's transcript but writes to a new session id (the source is unaffected).
    /// Runs in the source's directory, or a fresh worktree when `use_worktree` is set.
    pub fn fork_pane(
        &self,
        state: &AppState,
        source: &AgentInfo,
        use_worktree: bool,
        prompt: Option<&str>,
    ) -> Result<(PaneInfo, AgentInfo), String> {
        let session_id = source
            .session_id
            .clone()
            .map(|session| session.trim().to_string())
            .filter(|session| !session.is_empty())
            .ok_or_else(|| {
                "this Claude session isn't ready to fork yet (no session id); send a turn first"
                    .to_string()
            })?;

        let mut agent = prepare_agent_workspace_with_parent(
            state,
            PrepareAgentWorkspaceRequest {
                group_id: Some(source.group_id.clone()),
                // Worktree forks branch off the group's base repo; in-place forks run
                // in the source's own directory so they see the same files.
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

        // Record fork lineage and the no-prompt idle status before the process starts,
        // so the fork's own hooks (SessionStart, or the first turn's hooks via
        // adopt_forked_session_identity, which record the new session_id) can't race
        // ahead of the lineage write — the stale-payload guards key off fork_point.
        agent.fork_point = Some(session_id.clone());
        agent.root_session_id = source
            .root_session_id
            .clone()
            .or_else(|| Some(session_id.clone()));
        agent.status = AgentStatus::Idle;
        state.update_agent(agent.clone())?;

        let host = self.host_for_group(state, &agent.group_id)?;
        let binary = self.binary_for_host(&host)?;
        let cwd = self.cwd_for_host(&host, &agent.worktree_dir, || {
            format!(
                "fork working directory {} does not exist",
                agent.worktree_dir
            )
        })?;

        let pane_id = state.next_id("pane");
        let (settings_path, hook_settings) =
            match hook_settings_support_file(state.config(), &pane_id) {
                Ok(planned) => planned,
                Err(err) => {
                    let _ = mark_agent_failed(state, &agent.id);
                    return Err(err);
                }
            };

        let mut args = vec![
            "--settings".to_string(),
            settings_path.display().to_string(),
        ];
        args.extend(self.plugin_dir_args(&host));
        if let Some(model) = agent.model.clone().filter(|model| !model.trim().is_empty()) {
            args.push("--model".to_string());
            args.push(model);
        }
        push_effort_args(&mut args, agent.effort.as_deref());
        args.push("--permission-mode".to_string());
        args.push("auto".to_string());
        args.push("--resume".to_string());
        args.push(session_id);
        args.push("--fork-session".to_string());
        let prompt = prompt.map(str::trim).unwrap_or_default();
        let has_prompt = !prompt.is_empty();
        if has_prompt {
            // Delimit the prompt with `--` so a fork prompt that starts with `-`
            // (e.g. a forged `agent.fork` payload of "--dangerously-skip-permissions")
            // is parsed as the positional prompt rather than as a Claude flag that
            // would disable the forked agent's permission prompts.
            args.push("--".to_string());
            args.push(prompt.to_string());
        }

        let envs = agent_pane_envs(state, &pane_id, &agent.id)?;

        attach_agent_pane(state, &agent.id, pane_id.clone())?;

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
                support_files: vec![hook_settings],
                support_file_fallback: None,
            },
        )
        .and_then(|spec| spawn_pty(state, spec));

        let pane = match spawn_result {
            Ok(pane) => pane,
            Err(err) => {
                let _ = mark_agent_spawn_failed(state, &agent.id, &pane_id);
                return Err(err);
            }
        };

        let forked = if has_prompt {
            state.agent(&agent.id)?.unwrap_or_else(|| agent.clone())
        } else {
            // Restore Idle after the early pane bind (attach promotes to Running, but a
            // resumed fork with no prompt is simply ready). Use a field-scoped status
            // write, not a full-struct update: the spawned fork's SessionStart hook may
            // already be recording its new session_id/transcript on another thread, and a
            // stale snapshot write here would wipe them.
            state
                .set_agent_status(&agent.id, AgentStatus::Idle)?
                .unwrap_or_else(|| agent.clone())
        };

        Ok((pane, forked))
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaudeLaunchOptions {
    #[serde(default)]
    permission_mode: Option<String>,
    #[serde(default)]
    effort: Option<String>,
}

impl ClaudeLaunchOptions {
    fn from_value(value: Value) -> Result<Self, String> {
        if value.is_null() {
            return Ok(Self {
                permission_mode: None,
                effort: None,
            });
        }
        let mut options: ClaudeLaunchOptions = serde_json::from_value(value)
            .map_err(|err| format!("invalid Claude adapter options: {err}"))?;
        options.permission_mode = match options.permission_mode.map(|mode| mode.trim().to_string())
        {
            Some(permission_mode) if permission_mode.is_empty() => None,
            Some(permission_mode)
                if CLAUDE_PERMISSION_MODES.contains(&permission_mode.as_str()) =>
            {
                Some(permission_mode)
            }
            Some(permission_mode) => {
                return Err(format!(
                    "invalid Claude adapter option permissionMode='{permission_mode}'; expected one of {}",
                    CLAUDE_PERMISSION_MODES.join(", ")
                ));
            }
            None => None,
        };
        options.effort = match options.effort.map(|effort| effort.trim().to_string()) {
            Some(effort) if effort.is_empty() => None,
            Some(effort) if CLAUDE_EFFORT_LEVELS.contains(&effort.as_str()) => Some(effort),
            Some(effort) => {
                return Err(format!(
                    "invalid Claude adapter option effort='{effort}'; expected one of {}",
                    CLAUDE_EFFORT_LEVELS.join(", ")
                ));
            }
            None => None,
        };
        Ok(options)
    }
}

/// Generates a random hex nonce for a per-spawn hook-settings filename, so the path
/// is not guessable by another same-user process trying to pre-plant or locate it.
fn hook_settings_nonce() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|err| format!("failed to generate hook settings nonce: {err}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Writes a per-pane, per-spawn Claude hook-settings file and returns its path for
/// `--settings`.
///
/// This used to write one fixed, shared `.session/session-hooks.json` that every Claude
/// pane loaded. Because that path was stable and writable by any process running as
/// the desktop user, a prompt-injected agent in one pane could overwrite it to inject
/// a lifecycle-hook command into *another* pane's Claude — which runs with that pane's
/// `SESSION_TOKEN` — crossing Session's per-pane authority boundary. Writing a new,
/// unpredictably-named file per spawn under a `0700` `.session/hooks/` dir, created with
/// `O_EXCL` at `0600`, removes the shared target and the pre-planted-file/symlink
/// race: there is no stable path to overwrite, and a file planted at our random path
/// makes the exclusive create fail (we error out rather than write through it). A
/// same-user process can still overwrite our specific file in the window before Claude
/// reads it — same-uid file tampering is not preventable — but it can no longer target
/// a shared file or a guessable per-pane path.
/// Plans the per-spawn Claude hook settings file: the path Claude receives via
/// `--settings`, and the `SupportFile` the spawn backend materializes before
/// the process starts. Declarative on purpose — nothing is written here, so a
/// future remote backend can ship the same file to its host. The support-file
/// contract preserves the previous inline writer's security behavior: owner-only
/// directory chain, per-pane prefix pruning, and O_EXCL creation at 0600.
pub fn hook_settings_support_file(
    config: &SessionConfig,
    pane_id: &str,
) -> Result<(PathBuf, SupportFile), String> {
    // Session mints pane ids itself, but validate before using one in a filename so a
    // malformed caller can never traverse out of the hooks dir or spoof another pane's
    // prefix during the prune below.
    if pane_id.is_empty()
        || !pane_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(format!("invalid pane id for hook settings: {pane_id:?}"));
    }

    let hooks_dir = config.workspace_root.join(".session").join("hooks");
    let session_cli = crate::launch_path::session_cli_path()
        .map_err(|err| format!("failed to resolve Session executable for hooks: {err}"))?;
    let mut hooks = serde_json::Map::new();
    for event in CLAUDE_HOOK_EVENTS {
        hooks.insert(
            event.to_string(),
            json!([
                {
                    "matcher": "",
                    "hooks": [
                        {
                            "type": "command",
                            "command": format!("{} notify {}", shell_quote_path(&session_cli), event)
                        }
                    ]
                }
            ]),
        );
    }
    hooks.insert(
        "Notification".to_string(),
        json!(
            CLAUDE_NOTIFICATION_MATCHERS
                .iter()
                .map(|(matcher, event)| json!({
                    "matcher": matcher,
                    "hooks": [
                        {
                            "type": "command",
                            "command": format!("{} notify {}", shell_quote_path(&session_cli), event)
                        }
                    ]
                }))
                .collect::<Vec<_>>()
        ),
    );

    let settings = json!({ "hooks": hooks });
    let raw = serde_json::to_string_pretty(&settings)
        .map_err(|err| format!("failed to encode hook settings: {err}"))?;

    let settings_path = hooks_dir.join(format!("{pane_id}-{}.json", hook_settings_nonce()?));
    let support_file = SupportFile {
        root: hooks_dir,
        path: settings_path.clone(),
        contents: raw,
        mode: 0o600,
        // Never follow/truncate a pre-existing path: a planted file or symlink
        // at the random target must fail the create instead of being written
        // through.
        create_new: true,
        // Drop this pane's previous hook file(s) so the directory stays bounded
        // to one file per live pane instead of growing on every spawn/resume.
        prune_prefix: Some(format!("{pane_id}-")),
    };
    Ok((settings_path, support_file))
}

fn parse_transcript_line(agent_id: &str, source_index: usize, line: &str) -> Option<Turn> {
    super::parse_claude_native_transcript_line(agent_id, source_index, line)
}

fn claude_workspace_observation(line: &str) -> Option<WorkspaceObservation> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    if value
        .get("isSidechain")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let content = value.get("message")?.get("content")?.as_array()?;
    if !content
        .iter()
        .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
    {
        return None;
    }
    let cwd = value.get("cwd")?.as_str()?.trim();
    (!cwd.is_empty()).then(|| WorkspaceObservation {
        cwd: cwd.to_string(),
        source: ActiveWorkspaceSource::Claude,
        session_id: value
            // Claude rewrites camel-case `sessionId` when it copies fork
            // history, but preserves the originating snake-case `session_id`.
            // True child records carry the child id in both fields, making the
            // snake-case value the stable inherited-history discriminator.
            .get("session_id")
            .or_else(|| value.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::to_string),
        observed_at_millis: value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(rfc3339_to_epoch_ms)
            .and_then(|millis| u128::try_from(millis).ok()),
    })
}

#[derive(Clone, Debug)]
struct ClaudeGraphNode {
    uuid: String,
    parent_uuid: Option<String>,
    source_index: usize,
    is_typed_user_prompt: bool,
}

#[cfg(test)]
fn resolve_transcript_turns(agent_id: &str, lines: &[String]) -> Vec<Turn> {
    resolve_transcript_turns_from(agent_id, 0, lines)
}

fn resolve_transcript_turns_from(
    agent_id: &str,
    source_index_offset: usize,
    lines: &[String],
) -> Vec<Turn> {
    let mut turns = Vec::new();
    let mut nodes_by_uuid: HashMap<String, ClaudeGraphNode> = HashMap::new();
    let mut children_by_parent: HashMap<String, Vec<String>> = HashMap::new();
    let mut leaf_uuids = Vec::new();
    let mut interrupted_uuids = HashSet::new();
    let mut interrupted_message_ids = HashSet::new();

    for (relative_index, line) in lines.iter().enumerate() {
        let source_index = source_index_offset + relative_index;
        let value = match serde_json::from_str::<Value>(line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        if value.get("type").and_then(Value::as_str) == Some("last-prompt")
            && let Some(leaf_uuid) = super::string_field(&value, "leafUuid")
                .or_else(|| super::string_field(&value, "leaf_uuid"))
        {
            leaf_uuids.push(leaf_uuid);
        }

        if super::parse_claude_native_lifecycle_value(&value).is_some()
            && let Some(uuid) = super::string_field(&value, "uuid")
        {
            interrupted_uuids.insert(uuid);
        }
        if let Some(interrupted_message_id) = super::string_field(&value, "interruptedMessageId")
            .or_else(|| super::string_field(&value, "interrupted_message_id"))
        {
            interrupted_message_ids.insert(interrupted_message_id);
        }

        if let Some(uuid) = super::string_field(&value, "uuid") {
            let parent_uuid = super::string_field(&value, "parentUuid")
                .or_else(|| super::string_field(&value, "parent_uuid"));
            if let Some(parent_uuid) = parent_uuid.as_ref() {
                children_by_parent
                    .entry(parent_uuid.clone())
                    .or_default()
                    .push(uuid.clone());
            }
            nodes_by_uuid.insert(
                uuid.clone(),
                ClaudeGraphNode {
                    uuid,
                    parent_uuid,
                    source_index,
                    is_typed_user_prompt: is_claude_typed_user_prompt(&value),
                },
            );
        }

        if let Some(turn) =
            super::parse_claude_native_transcript_value(agent_id, source_index, &value)
        {
            turns.push(turn);
        }
    }

    let active_uuids = selected_claude_leaf(&nodes_by_uuid, &leaf_uuids)
        .map(|leaf_uuid| claude_ancestor_set(leaf_uuid, &nodes_by_uuid))
        .unwrap_or_default();
    let (superseded_uuids, uncertain_uuids) =
        resolve_claude_prompt_branch_statuses(&nodes_by_uuid, &children_by_parent, &active_uuids);

    for turn in &mut turns {
        let native_id = turn.native_id.as_deref();
        if native_id.is_some_and(|uuid| superseded_uuids.contains(uuid)) {
            turn.status = Some(TurnStatus::Superseded);
            turn.status_reason = Some(TurnStatusReason::ClaudePromptBranch);
        } else if native_id.is_some_and(|uuid| interrupted_uuids.contains(uuid))
            || turn
                .native_message_id
                .as_deref()
                .is_some_and(|message_id| interrupted_message_ids.contains(message_id))
        {
            turn.status = Some(TurnStatus::Interrupted);
            turn.status_reason = Some(TurnStatusReason::Interrupted);
        } else if native_id.is_some_and(|uuid| uncertain_uuids.contains(uuid)) {
            turn.status = Some(TurnStatus::Uncertain);
            turn.status_reason = Some(TurnStatusReason::UnknownBranch);
        }
    }

    turns
}

fn selected_claude_leaf<'a>(
    nodes_by_uuid: &'a HashMap<String, ClaudeGraphNode>,
    leaf_uuids: &'a [String],
) -> Option<&'a str> {
    let latest_typed_user = nodes_by_uuid
        .values()
        .filter(|node| node.is_typed_user_prompt)
        .max_by_key(|node| node.source_index);

    if let Some(latest_typed_user) = latest_typed_user {
        return leaf_uuids
            .iter()
            .rev()
            .find(|leaf_uuid| {
                claude_ancestor_set(leaf_uuid, nodes_by_uuid)
                    .contains(latest_typed_user.uuid.as_str())
            })
            .map(String::as_str);
    }

    leaf_uuids
        .iter()
        .rev()
        .find(|leaf_uuid| nodes_by_uuid.contains_key(leaf_uuid.as_str()))
        .map(String::as_str)
}

fn resolve_claude_prompt_branch_statuses(
    nodes_by_uuid: &HashMap<String, ClaudeGraphNode>,
    children_by_parent: &HashMap<String, Vec<String>>,
    active_uuids: &HashSet<String>,
) -> (HashSet<String>, HashSet<String>) {
    let mut superseded_uuids = HashSet::new();
    let mut uncertain_uuids = HashSet::new();

    for child_uuids in children_by_parent.values() {
        let typed_children = child_uuids
            .iter()
            .filter_map(|uuid| nodes_by_uuid.get(uuid))
            .filter(|node| node.is_typed_user_prompt)
            .collect::<Vec<_>>();
        if typed_children.len() < 2 {
            continue;
        }

        let active_count = typed_children
            .iter()
            .filter(|node| active_uuids.contains(node.uuid.as_str()))
            .count();
        match active_count {
            1 => {
                for node in typed_children {
                    if !active_uuids.contains(node.uuid.as_str()) {
                        mark_claude_subtree(
                            node.uuid.as_str(),
                            children_by_parent,
                            &mut superseded_uuids,
                        );
                    }
                }
            }
            0 => {
                for node in typed_children {
                    mark_claude_subtree(
                        node.uuid.as_str(),
                        children_by_parent,
                        &mut uncertain_uuids,
                    );
                }
            }
            _ => {}
        }
    }

    (superseded_uuids, uncertain_uuids)
}

fn mark_claude_subtree(
    root_uuid: &str,
    children_by_parent: &HashMap<String, Vec<String>>,
    output: &mut HashSet<String>,
) {
    let mut stack = vec![root_uuid.to_string()];
    while let Some(uuid) = stack.pop() {
        if !output.insert(uuid.clone()) {
            continue;
        }
        if let Some(children) = children_by_parent.get(uuid.as_str()) {
            stack.extend(children.iter().cloned());
        }
    }
}

fn claude_ancestor_set(
    leaf_uuid: &str,
    nodes_by_uuid: &HashMap<String, ClaudeGraphNode>,
) -> HashSet<String> {
    let mut ancestors = HashSet::new();
    let mut current = Some(leaf_uuid);
    let mut guard = 0usize;
    while let Some(uuid) = current {
        if guard >= nodes_by_uuid.len().saturating_add(1) || !ancestors.insert(uuid.to_string()) {
            break;
        }
        guard += 1;
        current = nodes_by_uuid
            .get(uuid)
            .and_then(|node| node.parent_uuid.as_deref());
    }
    ancestors
}

/// Writes the ancestor chain of the message *before* `anchor` to a new session
/// file beside the source, producing a transcript that ends where the fork
/// begins. Claude discovers it by scanning the project directory, and derives
/// the session id from the filename, so the copy needs no registration beyond
/// existing at `<project>/<uuid>.jsonl`.
///
/// Records are copied opaquely apart from `sessionId`: the format contains
/// fields we neither model nor need to understand, and rewriting only the one
/// field that must change keeps this tolerant of upstream additions.
///
/// Note there is no `last-prompt`/`leafUuid` marker written here. Appending one
/// to an untruncated copy looks like it should steer the resume to an earlier
/// leaf, but Claude ignores it and replays the full history — truncation is the
/// only mechanism that actually works.
/// Appends `--effort <level>` when the session has a recorded reasoning effort,
/// mirroring how `--model` is re-applied on every launch shape.
fn push_effort_args(args: &mut Vec<String>, effort: Option<&str>) {
    if let Some(effort) = effort.map(str::trim).filter(|effort| !effort.is_empty()) {
        args.push("--effort".to_string());
        args.push(effort.to_string());
    }
}

fn claude_line_can_update_turn_status(line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    value.get("type").and_then(Value::as_str) == Some("last-prompt")
        || super::parse_claude_native_lifecycle_value(&value).is_some()
        || is_claude_typed_user_prompt(&value)
}

fn is_claude_typed_user_prompt(value: &Value) -> bool {
    if value.get("type").and_then(Value::as_str) != Some("user") {
        return false;
    }
    let message = value.get("message").unwrap_or(value);
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return false;
    }
    if value
        .get("isMeta")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || value
            .get("isSidechain")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return false;
    }
    if is_claude_tool_result(value) || super::parse_claude_native_lifecycle_value(value).is_some() {
        return false;
    }
    let Some(content) = message.get("content").or_else(|| value.get("content")) else {
        return false;
    };
    let text = claude_content_text(content);
    let trimmed = text.trim_start();
    !trimmed.is_empty() && !is_claude_automated_user_text(trimmed)
}

fn is_claude_tool_result(value: &Value) -> bool {
    value.get("toolUseResult").is_some()
        || value.get("sourceToolAssistantUUID").is_some()
        || value
            .get("message")
            .and_then(|message| message.get("content"))
            .or_else(|| value.get("content"))
            .is_some_and(|content| claude_content_has_block_type(content, "tool_result"))
}

fn claude_content_has_block_type(content: &Value, block_type: &str) -> bool {
    matches!(
        content,
        Value::Array(items) if items
            .iter()
            .any(|item| item.get("type").and_then(Value::as_str) == Some(block_type))
    )
}

fn claude_content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn is_claude_automated_user_text(text: &str) -> bool {
    const AUTOMATED_PREFIXES: &[&str] = &[
        "<task-notification>",
        "<local-command",
        "<command-name>",
        "<bash-",
        "<system-reminder>",
        "<local-command-caveat>",
    ];
    AUTOMATED_PREFIXES
        .iter()
        .any(|prefix| text.starts_with(prefix))
}

fn parse_transcript_lifecycle_event(line: &str) -> Option<TranscriptLifecycleEvent> {
    super::parse_claude_native_lifecycle_event(line)
}

// Compatibility shim retained for the transcript parser tests.
#[cfg(test)]
fn parse_block(value: &Value) -> Option<TurnBlock> {
    super::parse_claude_native_block(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, GrokAdapterConfig,
    };
    use crate::transcript::TurnBlock;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn workspace_observation_uses_tool_call_cwd() {
        let line = json!({
            "type": "assistant",
            "cwd": "/repo/.claude/worktrees/feature",
            "sessionId": "child-session",
            "session_id": "child-session",
            "timestamp": "2026-08-13T23:00:00.123Z",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "name": "EnterWorktree",
                    "input": { "name": "feature" }
                }]
            }
        })
        .to_string();

        assert_eq!(
            claude_workspace_observation(&line),
            Some(WorkspaceObservation {
                cwd: "/repo/.claude/worktrees/feature".to_string(),
                source: ActiveWorkspaceSource::Claude,
                session_id: Some("child-session".to_string()),
                observed_at_millis: Some(1_786_662_000_123),
            })
        );
    }

    #[test]
    fn workspace_observation_prefers_source_identity_on_copied_fork_history() {
        let line = json!({
            "type": "assistant",
            "cwd": "/source/checkout",
            "sessionId": "child-session",
            "session_id": "source-session",
            "timestamp": "2026-08-13T23:00:00.123Z",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "name": "Bash",
                    "input": { "command": "pwd" }
                }]
            }
        })
        .to_string();

        assert_eq!(
            claude_workspace_observation(&line).and_then(|observation| observation.session_id),
            Some("source-session".to_string())
        );
    }

    #[test]
    fn workspace_observation_ignores_sidechains_and_non_tool_messages() {
        let sidechain = json!({
            "isSidechain": true,
            "cwd": "/wrong",
            "message": { "content": [{ "type": "tool_use", "name": "Bash" }] }
        })
        .to_string();
        let user = json!({
            "cwd": "/wrong",
            "message": { "content": [{ "type": "text", "text": "hello" }] }
        })
        .to_string();

        assert_eq!(claude_workspace_observation(&sidechain), None);
        assert_eq!(claude_workspace_observation(&user), None);
    }

    #[test]
    fn remote_claude_uses_remote_binary_and_omits_the_local_plugin() {
        let plugin_dir = unique_test_dir("session-claude-local-plugin");
        let adapter = ClaudeAdapter {
            binary: "/opt/remote/bin/claude".to_string(),
            plugin_dir: plugin_dir.clone(),
        };
        let host = Host::Remote(crate::host::RemoteTarget {
            id: "remote-1".to_string(),
            label: "builder".to_string(),
            ssh: "builder.example".to_string(),
            session_cli: "/opt/remote/bin/session-cli".to_string(),
            workspace_root: Some("/srv/session".to_string()),
            multiplexer: crate::workspace::RemoteMultiplexer::Tmux,
        });

        assert!(AgentAdapter::supports_remote(&adapter));
        assert_eq!(
            adapter.binary_for_host(&host).unwrap(),
            "/opt/remote/bin/claude"
        );
        assert!(adapter.plugin_dir_args(&host).is_empty());
        assert_eq!(
            adapter
                .cwd_for_host(&host, "/srv/project", || "missing".to_string())
                .unwrap(),
            PathBuf::from("/srv/project")
        );

        fs::remove_dir_all(plugin_dir).ok();
    }

    #[test]
    fn hook_settings_are_written_under_session_workspace_root() {
        let workspace_root = unique_test_dir("session-claude-global-hooks");
        let project_dir = unique_test_dir("session-claude-project");
        let config = SessionConfig {
            remotes: Default::default(),
            workspace_root: workspace_root.clone(),
            socket_path: unique_test_dir("session-claude-hooks-socket").join("session.sock"),
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
        };

        let (settings_path, support_file) = hook_settings_support_file(&config, "pane-1").unwrap();
        crate::pty::materialize_support_files(&[support_file]).unwrap();

        // Per-pane, per-spawn file under a 0700 `.session/hooks/` dir, created 0600.
        let hooks_dir = workspace_root.join(".session/hooks");
        assert!(
            settings_path.starts_with(&hooks_dir),
            "unexpected hook path: {settings_path:?}"
        );
        let name = settings_path
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(
            name.starts_with("pane-1-") && name.ends_with(".json"),
            "unexpected hook filename: {name}"
        );
        assert!(settings_path.is_file());
        assert_eq!(
            fs::metadata(&settings_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!project_dir.join(".session/session-hooks.json").exists());

        // A second spawn for the same pane prunes the first file so the dir stays
        // bounded to one file per pane, and generates a new unguessable name.
        let (second_path, second_file) = hook_settings_support_file(&config, "pane-1").unwrap();
        crate::pty::materialize_support_files(&[second_file]).unwrap();
        assert_ne!(second_path, settings_path);
        assert!(!settings_path.exists());
        assert!(second_path.is_file());

        let raw = fs::read_to_string(&second_path).unwrap();
        assert!(raw.contains("\"hooks\""));
        for event in CLAUDE_HOOK_EVENTS {
            assert!(
                raw.contains(&format!(" notify {event}")),
                "missing hook for {event}"
            );
        }

        let _ = fs::remove_dir_all(workspace_root);
        let _ = fs::remove_dir_all(project_dir);
    }

    fn unique_test_dir(prefix: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()))
    }

    fn claude_system_line(uuid: &str, parent_uuid: Option<&str>) -> String {
        claude_line(
            "system",
            uuid,
            parent_uuid,
            json!({ "role": "system", "content": "" }),
            json!({ "content": "" }),
        )
    }

    fn claude_user_line(uuid: &str, parent_uuid: Option<&str>, text: &str) -> String {
        claude_line(
            "user",
            uuid,
            parent_uuid,
            json!({ "role": "user", "content": text }),
            json!({}),
        )
    }

    fn claude_assistant_line(
        uuid: &str,
        parent_uuid: Option<&str>,
        message_id: &str,
        text: &str,
    ) -> String {
        claude_line(
            "assistant",
            uuid,
            parent_uuid,
            json!({ "id": message_id, "role": "assistant", "content": [{ "type": "text", "text": text }] }),
            json!({}),
        )
    }

    fn claude_tool_use_line(
        uuid: &str,
        parent_uuid: Option<&str>,
        message_id: &str,
        tool_use_id: &str,
    ) -> String {
        claude_line(
            "assistant",
            uuid,
            parent_uuid,
            json!({
                "id": message_id,
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": tool_use_id,
                    "name": "Read",
                    "input": { "file_path": "src/main.rs" }
                }]
            }),
            json!({}),
        )
    }

    fn claude_tool_result_line(
        uuid: &str,
        parent_uuid: Option<&str>,
        source_tool_assistant_uuid: &str,
        tool_use_id: &str,
    ) -> String {
        claude_line(
            "user",
            uuid,
            parent_uuid,
            json!({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": "ok"
                }]
            }),
            json!({
                "sourceToolAssistantUUID": source_tool_assistant_uuid,
                "toolUseResult": { "type": "text", "content": "ok" }
            }),
        )
    }

    fn claude_last_prompt_line(leaf_uuid: &str) -> String {
        json!({
            "type": "last-prompt",
            "lastPrompt": "prompt",
            "leafUuid": leaf_uuid,
            "sessionId": "session-1"
        })
        .to_string()
    }

    fn claude_line(
        entry_type: &str,
        uuid: &str,
        parent_uuid: Option<&str>,
        message: serde_json::Value,
        extra: serde_json::Value,
    ) -> String {
        let mut value = json!({
            "type": entry_type,
            "uuid": uuid,
            "message": message,
            "sessionId": "session-1"
        });
        if let Some(parent_uuid) = parent_uuid {
            value["parentUuid"] = json!(parent_uuid);
        }
        if let Some(extra) = extra.as_object() {
            for (key, value_to_insert) in extra {
                value[key.as_str()] = value_to_insert.clone();
            }
        }
        value.to_string()
    }

    fn turn_by_native_id<'a>(turns: &'a [Turn], native_id: &str) -> &'a Turn {
        turns
            .iter()
            .find(|turn| turn.native_id.as_deref() == Some(native_id))
            .unwrap_or_else(|| panic!("turn with native id {native_id} not found"))
    }

    #[test]
    fn parse_claude_interrupted_lifecycle_events() {
        let plain_interrupt = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": "[Request interrupted by user]" }]
            }
        })
        .to_string();
        let tool_interrupt = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": "[Request interrupted by user for tool use]" }]
            },
            "interruptedMessageId": "msg_123"
        })
        .to_string();
        let ordinary_user_message = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": "please keep going" }]
            }
        })
        .to_string();

        assert_eq!(
            parse_transcript_lifecycle_event(&plain_interrupt),
            Some(TranscriptLifecycleEvent::Interrupted)
        );
        assert_eq!(
            parse_transcript_lifecycle_event(&tool_interrupt),
            Some(TranscriptLifecycleEvent::Interrupted)
        );
        assert_eq!(
            parse_transcript_lifecycle_event(&ordinary_user_message),
            None
        );
    }

    #[test]
    fn resolve_claude_transcript_marks_inactive_prompt_branch_superseded() {
        let lines = vec![
            claude_system_line("root", None),
            claude_user_line("old-user", Some("root"), "typo"),
            claude_assistant_line("old-assistant", Some("old-user"), "msg-old", "old answer"),
            claude_user_line("new-user", Some("root"), "corrected"),
            claude_assistant_line("new-assistant", Some("new-user"), "msg-new", "new answer"),
            claude_last_prompt_line("new-assistant"),
        ];

        let turns = resolve_transcript_turns("agent-1", &lines);

        let old_user = turn_by_native_id(&turns, "old-user");
        let old_assistant = turn_by_native_id(&turns, "old-assistant");
        let new_user = turn_by_native_id(&turns, "new-user");
        assert_eq!(old_user.status, Some(TurnStatus::Superseded));
        assert_eq!(
            old_user.status_reason,
            Some(TurnStatusReason::ClaudePromptBranch)
        );
        assert_eq!(old_assistant.status, Some(TurnStatus::Superseded));
        assert_eq!(new_user.status, None);
    }

    #[test]
    fn bounded_claude_resolution_preserves_absolute_source_indices() {
        let lines = vec![
            claude_system_line("root", None),
            claude_user_line("user-1", Some("root"), "prompt"),
        ];

        let turns = resolve_transcript_turns_from("agent-1", 500, &lines);

        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].source_index, 500);
        assert_eq!(turns[1].source_index, 501);
        assert_eq!(turns[1].id, "agent-1-501");
    }

    #[test]
    fn resolve_claude_transcript_does_not_supersede_parallel_tool_branches() {
        let lines = vec![
            claude_system_line("root", None),
            claude_user_line("user-1", Some("root"), "inspect files"),
            claude_tool_use_line("tool-a", Some("user-1"), "msg-tools", "toolu_a"),
            claude_tool_use_line("tool-b", Some("tool-a"), "msg-tools", "toolu_b"),
            claude_tool_result_line("result-a", Some("tool-a"), "tool-a", "toolu_a"),
            claude_tool_result_line("result-b", Some("tool-b"), "tool-b", "toolu_b"),
            claude_last_prompt_line("result-b"),
        ];

        let turns = resolve_transcript_turns("agent-1", &lines);

        assert!(turns.iter().all(|turn| turn.status.is_none()));
    }

    #[test]
    fn resolve_claude_transcript_marks_ambiguous_prompt_branch_uncertain() {
        let lines = vec![
            claude_system_line("root", None),
            claude_user_line("first-user", Some("root"), "first"),
            claude_user_line("second-user", Some("root"), "second"),
            claude_system_line("unrelated-system", None),
            claude_last_prompt_line("unrelated-system"),
        ];

        let turns = resolve_transcript_turns("agent-1", &lines);

        assert_eq!(
            turn_by_native_id(&turns, "first-user").status,
            Some(TurnStatus::Uncertain)
        );
        assert_eq!(
            turn_by_native_id(&turns, "second-user").status,
            Some(TurnStatus::Uncertain)
        );
    }

    #[test]
    fn resolve_claude_transcript_treats_stale_leaf_branch_as_uncertain() {
        let lines = vec![
            claude_system_line("root", None),
            claude_user_line("old-user", Some("root"), "old"),
            claude_assistant_line("old-assistant", Some("old-user"), "msg-old", "old answer"),
            claude_last_prompt_line("old-assistant"),
            claude_user_line("new-user", Some("root"), "new"),
        ];

        let turns = resolve_transcript_turns("agent-1", &lines);

        assert_eq!(
            turn_by_native_id(&turns, "new-user").status,
            Some(TurnStatus::Uncertain)
        );
        assert_ne!(
            turn_by_native_id(&turns, "new-user").status,
            Some(TurnStatus::Superseded)
        );
    }

    #[test]
    fn resolve_claude_transcript_marks_interrupted_message_id() {
        let lines = vec![
            claude_system_line("root", None),
            claude_user_line("user-1", Some("root"), "go"),
            claude_assistant_line("assistant-1", Some("user-1"), "msg_123", "partial"),
            json!({
                "type": "user",
                "uuid": "interrupt-1",
                "parentUuid": "assistant-1",
                "message": {
                    "role": "user",
                    "content": [{ "type": "text", "text": "[Request interrupted by user]" }]
                },
                "interruptedMessageId": "msg_123"
            })
            .to_string(),
            claude_last_prompt_line("interrupt-1"),
        ];

        let turns = resolve_transcript_turns("agent-1", &lines);

        assert_eq!(
            turn_by_native_id(&turns, "assistant-1").status,
            Some(TurnStatus::Interrupted)
        );
        assert_eq!(
            turn_by_native_id(&turns, "interrupt-1").status,
            Some(TurnStatus::Interrupted)
        );
    }

    #[test]
    fn parse_tool_blocks_preserves_correlation_ids() {
        let tool_use = json!({
            "type": "tool_use",
            "id": "toolu_1",
            "name": "Bash",
            "input": { "cmd": "pwd" }
        });

        match parse_block(&tool_use).expect("tool_use should parse") {
            TurnBlock::ToolUse { id, name, input } => {
                assert_eq!(id.as_deref(), Some("toolu_1"));
                assert_eq!(name, "Bash");
                assert_eq!(input["cmd"], "pwd");
            }
            other => panic!("expected tool use, got {other:?}"),
        }

        let tool_result = json!({
            "type": "tool_result",
            "tool_use_id": "toolu_1",
            "content": "ok",
            "is_error": true
        });

        match parse_block(&tool_result).expect("tool_result should parse") {
            TurnBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                assert_eq!(tool_use_id.as_deref(), Some("toolu_1"));
                assert_eq!(content, "ok");
                assert!(is_error);
            }
            other => panic!("expected tool result, got {other:?}"),
        }
    }

    #[test]
    fn parse_tool_result_accepts_camel_case_id() {
        let tool_result = json!({
            "type": "tool_result",
            "toolUseId": "toolu_2",
            "content": "ok"
        });

        match parse_block(&tool_result).expect("tool_result should parse") {
            TurnBlock::ToolResult { tool_use_id, .. } => {
                assert_eq!(tool_use_id.as_deref(), Some("toolu_2"));
            }
            other => panic!("expected tool result, got {other:?}"),
        }
    }

    #[test]
    fn launch_options_reject_unknown_fields() {
        let err = ClaudeLaunchOptions::from_value(json!({ "bogus": true })).unwrap_err();

        assert!(err.contains("invalid Claude adapter options"));
    }

    #[test]
    fn launch_options_validate_permission_mode() {
        for mode in CLAUDE_PERMISSION_MODES {
            let options = ClaudeLaunchOptions::from_value(json!({ "permissionMode": mode }))
                .expect("current Claude permission mode should be accepted");
            assert_eq!(options.permission_mode.as_deref(), Some(*mode));
        }

        let err =
            ClaudeLaunchOptions::from_value(json!({ "permissionMode": "always" })).unwrap_err();

        assert!(err.contains("invalid Claude adapter option permissionMode"));
        assert!(ClaudeLaunchOptions::from_value(json!({ "permissionMode": "default" })).is_err());
    }

    #[test]
    fn launch_options_validate_effort() {
        for level in CLAUDE_EFFORT_LEVELS {
            let options = ClaudeLaunchOptions::from_value(json!({ "effort": level }))
                .expect("current Claude effort level should be accepted");
            assert_eq!(options.effort.as_deref(), Some(*level));
        }

        let blank = ClaudeLaunchOptions::from_value(json!({ "effort": "  " })).unwrap();
        assert_eq!(blank.effort, None);

        let err = ClaudeLaunchOptions::from_value(json!({ "effort": "extreme" })).unwrap_err();
        assert!(err.contains("invalid Claude adapter option effort"));
    }
}
