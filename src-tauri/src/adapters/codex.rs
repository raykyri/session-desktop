use super::{
    AgentAdapter, ComposerPolicy, ShellCommandIntegration, SpawnAgentRequest,
    TranscriptLifecycleEvent, WorkspaceObservation, ensure_on_path,
    model_from_codex_transcript_line, record_shell_fork_lineage, shell_quote_arg, shell_quote_path,
};
use crate::config::SessionConfig;
use crate::host::{self, Host};
use crate::pty::{
    CommandPlan, PaneMeta, agent_pane_envs, plan_to_spec, recoverable_dir, spawn_pty,
};
use crate::state::{AppState, PaneInfo, PaneKind};
use crate::transcript::{
    Turn, TurnBlock, TurnContextStatus, TurnStatus, TurnStatusReason, string_field,
};
use crate::workspace::{
    ActiveWorkspaceSource, AgentInfo, AgentStatus, PrepareAgentWorkspaceRequest, attach_agent_pane,
    configured_worktree_root_for_cwd, mark_agent_failed, mark_agent_spawn_failed,
    prepare_agent_workspace_with_parent,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

const CODEX_SESSION_PROFILE: &str = "session-codex";
const CODEX_CODE_MODE_HOST: &str = "codex-code-mode-host";
const CODEX_SESSION_WORKTREE_INSTRUCTIONS: &str = "Session worktree policy: When you directly create a Git worktree for the user, ensure the directory in the SESSION_WORKTREE_ROOT environment variable exists and use it as the worktree's parent directory. Do not use SESSION_WORKSPACE_ROOT as the worktree parent. Treat SESSION_WORKTREE_ROOT as an opaque filesystem path.";
const CODEX_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "PreToolUse",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "SubagentStart",
    "SubagentStop",
    "Stop",
];

#[derive(Clone, Debug)]
pub struct CodexAdapter {
    binary: String,
}

impl CodexAdapter {
    pub fn new(config: &SessionConfig) -> Self {
        Self {
            binary: config.codex_binary(),
        }
    }

    pub(crate) fn ensure_binary(&self) -> Result<String, String> {
        let binary = ensure_on_path(&self.binary).ok_or_else(|| {
            format!(
                "Codex adapter binary '{}' was not found on PATH or standard macOS tool paths. Install Codex CLI or update adapters.codex.binary in session.config.json.",
                self.binary
            )
        })?;
        let binary = codex_binary_with_code_mode_host(binary);
        Ok(binary.display().to_string())
    }

    fn host_for_group(&self, state: &AppState, group_id: &str) -> Result<Host, String> {
        let group = state.group(group_id)?;
        Ok(host::for_group(
            group.as_ref().and_then(|group| group.remote.as_ref()),
        ))
    }

    fn binary_for_host(&self, host: &Host) -> Result<String, String> {
        if host.is_local() {
            self.ensure_binary()
        } else if self.binary.trim().is_empty() {
            Err("Codex adapter binary cannot be empty for a remote launch".to_string())
        } else {
            // The configured program is resolved by tmux on the SSH host. A
            // local PATH check would reject a valid remote install or turn a
            // local macOS path into the remote command by accident.
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

    fn integration_for_host(
        &self,
        host: &Host,
    ) -> Result<(Option<PathBuf>, Option<String>), String> {
        if host.is_local() {
            Ok((Some(ensure_codex_integration()?), None))
        } else {
            let session_cli = host
                .remote()
                .map(|remote| remote.session_cli.clone())
                .ok_or_else(|| "remote Codex launch lost its host configuration".to_string())?;
            Ok((None, Some(session_cli)))
        }
    }
}

fn codex_binary_with_code_mode_host(binary: PathBuf) -> PathBuf {
    if codex_code_mode_host_is_sibling(&binary) {
        return binary;
    }

    let Ok(target) = fs::canonicalize(&binary) else {
        return binary;
    };

    if target != binary && codex_code_mode_host_is_sibling(&target) {
        return target;
    }

    binary
}

fn codex_code_mode_host_is_sibling(binary: &Path) -> bool {
    binary
        .parent()
        .is_some_and(|dir| dir.join(CODEX_CODE_MODE_HOST).is_file())
}

impl AgentAdapter for CodexAdapter {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn display_name(&self) -> &'static str {
        "Codex"
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
            command_name: "codex",
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
        model_from_codex_transcript_line(line)
    }

    fn transcript_workspace_observation(&self, line: &str) -> Option<WorkspaceObservation> {
        codex_workspace_observation(line)
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
        is_codex_status_event(line)
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
        CodexAdapter::fork_pane(self, state, source, use_worktree, prompt)
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

impl CodexAdapter {
    fn spawn_pane(&self, state: &AppState, request: SpawnAgentRequest) -> Result<PaneInfo, String> {
        let options = CodexLaunchOptions::from_value(request.options)?;
        let resume_session_id = request
            .resume_session_id
            .as_deref()
            .map(str::trim)
            .filter(|session_id| !session_id.is_empty())
            .map(ToString::to_string);
        if request.fork_session && resume_session_id.is_none() {
            return Err("a Codex history fork requires a session id".to_string());
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
                effort: options.reasoning_effort.clone(),
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
        let (codex_home, remote_hook_cli) = self.integration_for_host(&host)?;
        if host.is_local() && !cwd.is_dir() {
            let _ = mark_agent_failed(state, &agent.id);
            return Err(format!(
                "Codex working directory {} does not exist",
                cwd.display()
            ));
        }

        let has_initial_prompt = prompt_has_initial_text(&request.prompt);
        let tail_args = if let Some(session_id) = resume_session_id {
            let mut args = vec![
                if request.fork_session {
                    "fork"
                } else {
                    "resume"
                }
                .to_string(),
                session_id,
            ];
            if has_initial_prompt {
                args.push("--".to_string());
                args.push(request.prompt.trim().to_string());
            }
            args
        } else {
            prompt_tail_args(&request.prompt)
        };
        let worktree_root = codex_worktree_root(state, &agent, &cwd)?;
        let args = build_codex_args(
            &cwd,
            host.is_local()
                .then_some(state.config().workspace_root.as_path()),
            request.model.as_deref(),
            &options,
            worktree_root
                .as_deref()
                .map(|_| CODEX_SESSION_WORKTREE_INSTRUCTIONS),
            remote_hook_cli.as_deref(),
            tail_args,
        );
        let pane_id = state.next_id("pane");
        let mut envs = agent_pane_envs(state, &pane_id, &agent.id)?;
        if let Some(codex_home) = codex_home {
            envs.push(("CODEX_HOME".to_string(), codex_home.display().to_string()));
        }
        add_codex_worktree_root_env(&mut envs, worktree_root.as_deref());

        // Bind before spawn so a fast SessionStart hook can authenticate against the
        // pane/agent scope and record the native session identity. The spawn-failure
        // path clears this reserved binding.
        attach_codex_agent_pane(state, &agent.id, pane_id.clone(), has_initial_prompt)?;

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

    /// Forks `source` into a new Codex agent pane using `codex fork <session> [prompt]`.
    /// Codex records a fresh session id for the fork, so the source session keeps
    /// running independently.
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
                "this Codex session isn't ready to fork yet (no session id); send a turn first"
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
        agent.fork_point = Some(session_id.clone());
        agent.root_session_id = source
            .root_session_id
            .clone()
            .or_else(|| Some(session_id.clone()));
        agent.status = AgentStatus::Idle;
        state.update_agent(agent.clone())?;

        let host = self.host_for_group(state, &agent.group_id)?;
        let binary = self.binary_for_host(&host)?;
        let (codex_home, remote_hook_cli) = self.integration_for_host(&host)?;
        let cwd = self.cwd_for_host(&host, &agent.worktree_dir, || {
            format!(
                "fork working directory {} does not exist",
                agent.worktree_dir
            )
        })?;
        let options = CodexLaunchOptions {
            reasoning_effort: agent.effort.clone(),
            ..CodexLaunchOptions::default()
        };
        let prompt = prompt.map(str::trim).unwrap_or_default();
        let has_initial_prompt = !prompt.is_empty();
        let worktree_root = codex_worktree_root(state, &agent, &cwd)?;
        let args = build_codex_fork_args(
            &cwd,
            host.is_local()
                .then_some(state.config().workspace_root.as_path()),
            agent.model.as_deref(),
            &options,
            worktree_root
                .as_deref()
                .map(|_| CODEX_SESSION_WORKTREE_INSTRUCTIONS),
            remote_hook_cli.as_deref(),
            &session_id,
            if has_initial_prompt {
                Some(prompt)
            } else {
                None
            },
        );

        let pane_id = state.next_id("pane");
        let mut envs = agent_pane_envs(state, &pane_id, &agent.id)?;
        if let Some(codex_home) = codex_home {
            envs.push(("CODEX_HOME".to_string(), codex_home.display().to_string()));
        }
        add_codex_worktree_root_env(&mut envs, worktree_root.as_deref());

        // Bind before spawn so a fast Codex SessionStart hook passes the control
        // socket's agent/pane scope check. mark_agent_spawn_failed clears this
        // reserved binding if the process fails to launch.
        attach_codex_agent_pane(state, &agent.id, pane_id.clone(), has_initial_prompt)?;

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

/// Reasoning levels accepted by the Codex CLI's `model_reasoning_effort`
/// config across supported models.
const CODEX_REASONING_EFFORT_LEVELS: &[&str] = &["low", "medium", "high", "xhigh", "max", "ultra"];

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CodexLaunchOptions {
    #[serde(default)]
    sandbox: Option<String>,
    #[serde(default)]
    approval_policy: Option<String>,
    #[serde(default)]
    approvals_reviewer: Option<String>,
    #[serde(default)]
    reasoning_effort: Option<String>,
    // Kept only so saved launcher options that still carry `search: true` parse
    // cleanly under `deny_unknown_fields`; --search is now always emitted.
    #[serde(default)]
    #[allow(dead_code)]
    search: bool,
}

impl CodexLaunchOptions {
    fn from_value(value: Value) -> Result<Self, String> {
        if value.is_null() {
            return Ok(Self::default());
        }

        let mut options: CodexLaunchOptions = serde_json::from_value(value)
            .map_err(|err| format!("invalid Codex adapter options: {err}"))?;
        options.sandbox = normalize_option(
            "sandbox",
            options.sandbox.as_deref(),
            &["read-only", "workspace-write", "danger-full-access"],
        )?;
        options.approval_policy = normalize_option(
            "approvalPolicy",
            options.approval_policy.as_deref(),
            &["untrusted", "on-request", "never"],
        )?;
        options.approvals_reviewer = normalize_option(
            "approvalsReviewer",
            options.approvals_reviewer.as_deref(),
            &["auto_review"],
        )?;
        // The full range of GPT-6 Astra and GPT-5.6 (Sol, Terra, Luna); the
        // CLI rejects a level a custom model does not support.
        options.reasoning_effort = normalize_option(
            "reasoningEffort",
            options.reasoning_effort.as_deref(),
            CODEX_REASONING_EFFORT_LEVELS,
        )?;
        Ok(options)
    }
}

fn normalize_option(
    field: &str,
    value: Option<&str>,
    allowed: &[&str],
) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if allowed.contains(&value) {
        Ok(Some(value.to_string()))
    } else {
        Err(format!(
            "invalid Codex adapter option {field}='{value}'; expected one of {}",
            allowed.join(", ")
        ))
    }
}

fn build_codex_args(
    cwd: &Path,
    additional_workspace_root: Option<&Path>,
    model: Option<&str>,
    options: &CodexLaunchOptions,
    developer_instructions: Option<&str>,
    remote_hook_cli: Option<&str>,
    tail_args: Vec<String>,
) -> Vec<String> {
    let mut args = vec!["--cd".to_string(), cwd.display().to_string()];
    if let Some(additional_workspace_root) = additional_workspace_root {
        args.push("--add-dir".to_string());
        args.push(additional_workspace_root.display().to_string());
    }

    if let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    push_codex_hook_integration(&mut args, remote_hook_cli);
    if let Some(developer_instructions) = developer_instructions {
        args.push("--config".to_string());
        args.push(format!(
            "developer_instructions={}",
            toml_string(developer_instructions)
        ));
    }
    let sandbox = options.sandbox.as_deref().unwrap_or("workspace-write");
    args.push("--sandbox".to_string());
    args.push(sandbox.to_string());
    if let Some(approval_policy) = options.approval_policy.as_deref()
        && options.approvals_reviewer.as_deref() != Some("auto_review")
    {
        args.push("--ask-for-approval".to_string());
        args.push(approval_policy.to_string());
    }
    if let Some(approvals_reviewer) = options.approvals_reviewer.as_deref() {
        args.push("--config".to_string());
        args.push(format!(
            "approvals_reviewer={}",
            toml_string(approvals_reviewer)
        ));
    }
    if let Some(reasoning_effort) = options.reasoning_effort.as_deref() {
        args.push("--config".to_string());
        args.push(format!(
            "model_reasoning_effort={}",
            toml_string(reasoning_effort)
        ));
    }
    args.push("--search".to_string());

    args.extend(tail_args);
    args
}

fn build_codex_fork_args(
    cwd: &Path,
    additional_workspace_root: Option<&Path>,
    model: Option<&str>,
    options: &CodexLaunchOptions,
    developer_instructions: Option<&str>,
    remote_hook_cli: Option<&str>,
    session_id: &str,
    prompt: Option<&str>,
) -> Vec<String> {
    let mut tail_args = vec!["fork".to_string(), session_id.trim().to_string()];
    if let Some(prompt) = prompt.map(str::trim).filter(|prompt| !prompt.is_empty()) {
        // Delimit the prompt with `--` so a fork prompt that happens to start with
        // `-` (e.g. a forged `agent.fork` payload of "--dangerously-bypass-...") is
        // parsed as the positional prompt, not as a Codex flag that could weaken the
        // sandbox and approval settings. Mirrors the initial-launch path (`prompt_tail_args`).
        tail_args.push("--".to_string());
        tail_args.push(prompt.to_string());
    }
    build_codex_args(
        cwd,
        additional_workspace_root,
        model,
        options,
        developer_instructions,
        remote_hook_cli,
        tail_args,
    )
}

/// Local Codex panes use Session's generated profile in the user's CODEX_HOME.
/// A remote pane must not point CODEX_HOME at a pane support directory: doing
/// so would hide the remote user's auth, config, and session history. Instead,
/// inject only the Session lifecycle hooks as process-local config overrides and
/// leave the remote Codex home untouched.
fn push_codex_hook_integration(args: &mut Vec<String>, remote_hook_cli: Option<&str>) {
    let Some(session_cli) = remote_hook_cli else {
        args.push("--profile".to_string());
        args.push(CODEX_SESSION_PROFILE.to_string());
        return;
    };

    args.push("--config".to_string());
    args.push("features.hooks=true".to_string());
    let command_prefix = shell_quote_arg(session_cli);
    for event in CODEX_HOOK_EVENTS {
        let command = toml_string(&format!("{command_prefix} notify {event}"));
        let entry = if *event == "SessionStart" {
            format!(
                "hooks.{event}=[{{matcher=\"startup|resume\",hooks=[{{type=\"command\",command={command},timeout=5}}]}}]"
            )
        } else {
            format!("hooks.{event}=[{{hooks=[{{type=\"command\",command={command},timeout=5}}]}}]")
        };
        args.push("--config".to_string());
        args.push(entry);
    }
}

fn codex_worktree_root(
    state: &AppState,
    agent: &AgentInfo,
    cwd: &Path,
) -> Result<Option<String>, String> {
    let group = state
        .group(&agent.group_id)?
        .ok_or_else(|| format!("group {} was not found", agent.group_id))?;
    let host = host::for_group(group.remote.as_ref());
    let cwd = cwd
        .to_str()
        .ok_or_else(|| "Codex working directory is not valid UTF-8".to_string())?;
    configured_worktree_root_for_cwd(state, &host, cwd, &group)
        .map(|root| root.map(|root| root.display().to_string()))
}

fn add_codex_worktree_root_env(envs: &mut Vec<(String, String)>, root: Option<&str>) {
    if let Some(root) = root {
        envs.push(("SESSION_WORKTREE_ROOT".to_string(), root.to_string()));
    }
}

fn prompt_tail_args(prompt: &str) -> Vec<String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        Vec::new()
    } else {
        vec!["--".to_string(), prompt.to_string()]
    }
}

fn prompt_has_initial_text(prompt: &str) -> bool {
    !prompt.trim().is_empty()
}

fn attach_codex_agent_pane(
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

fn ensure_codex_integration() -> Result<PathBuf, String> {
    let codex_home = codex_home()?;
    let session_cli = crate::launch_path::session_cli_path()
        .map_err(|err| format!("{err} (needed for Codex hooks)"))?;
    write_codex_integration_files(&codex_home, &session_cli)?;
    Ok(codex_home)
}

fn codex_home() -> Result<PathBuf, String> {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))
        .ok_or_else(|| "CODEX_HOME and HOME are not set; cannot configure Codex hooks".to_string())
}

fn write_codex_integration_files(codex_home: &Path, session_cli: &Path) -> Result<(), String> {
    let session_dir = codex_home.join("session");
    fs::create_dir_all(&session_dir)
        .map_err(|err| format!("failed to create {}: {err}", session_dir.display()))?;

    let shim_path = session_dir.join("session-codex-hook");
    let shim = codex_hook_shim();
    fs::write(&shim_path, shim)
        .map_err(|err| format!("failed to write {}: {err}", shim_path.display()))?;
    fs::set_permissions(&shim_path, fs::Permissions::from_mode(0o755))
        .map_err(|err| format!("failed to chmod {}: {err}", shim_path.display()))?;

    let profile_path = codex_home.join(format!("{CODEX_SESSION_PROFILE}.config.toml"));
    let existing_profile = fs::read_to_string(&profile_path).ok();
    let profile = codex_profile_toml(&shim_path, session_cli, existing_profile.as_deref());
    fs::write(&profile_path, profile)
        .map_err(|err| format!("failed to write {}: {err}", profile_path.display()))?;

    Ok(())
}

fn codex_hook_shim() -> &'static str {
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

fn codex_profile_toml(
    shim_path: &Path,
    session_cli: &Path,
    existing_profile: Option<&str>,
) -> String {
    let command_prefix = shell_quote_path(shim_path);
    let mut raw = String::new();
    raw.push_str("# Generated by Session. Do not edit.\n");
    raw.push_str(
        "# This profile enables Session Codex lifecycle hooks only for Session-launched panes.\n",
    );
    raw.push_str(&format!(
        "# Session executable: {}\n\n",
        session_cli.display()
    ));
    raw.push_str("[features]\n");
    raw.push_str("hooks = true\n\n");

    for event in CODEX_HOOK_EVENTS {
        if *event == "SessionStart" {
            raw.push_str("[[hooks.SessionStart]]\n");
            raw.push_str("matcher = \"startup|resume\"\n");
        } else {
            raw.push_str(&format!("[[hooks.{event}]]\n"));
        }
        raw.push_str(&format!("[[hooks.{event}.hooks]]\n"));
        raw.push_str("type = \"command\"\n");
        raw.push_str(&format!(
            "command = {}\n",
            toml_string(&format!("{command_prefix} {event}"))
        ));
        raw.push_str("timeout = 5\n\n");
    }

    if let Some(state) = existing_profile.and_then(codex_hooks_state_toml) {
        raw.push('\n');
        raw.push_str(state.trim_start_matches('\n'));
        if !raw.ends_with('\n') {
            raw.push('\n');
        }
    }

    raw
}

fn codex_hooks_state_toml(raw: &str) -> Option<&str> {
    let mut offset = 0;
    for line in raw.split_inclusive('\n') {
        if line.trim() == "[hooks.state]" {
            return Some(&raw[offset..]);
        }
        offset += line.len();
    }
    None
}

fn toml_string(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            other => escaped.push(other),
        }
    }
    escaped.push('"');
    escaped
}

fn parse_transcript_line(agent_id: &str, source_index: usize, line: &str) -> Option<Turn> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("response_item") {
        return None;
    }
    let payload = value.get("payload")?;
    let item_type = payload.get("type").and_then(Value::as_str)?;
    let session_id =
        string_field(&value, "session_id").or_else(|| string_field(&value, "sessionId"));

    let (role, blocks) = match item_type {
        "message" => {
            let role = payload.get("role").and_then(Value::as_str)?;
            if role == "developer" || role == "system" {
                return None;
            }
            let blocks = parse_codex_message_blocks(payload.get("content"))?;
            (role.to_string(), blocks)
        }
        "function_call" | "custom_tool_call" => {
            let name = string_field(payload, "name").unwrap_or_else(|| "tool".to_string());
            (
                "assistant".to_string(),
                vec![TurnBlock::ToolUse {
                    id: string_field(payload, "call_id")
                        .or_else(|| string_field(payload, "callId"))
                        .or_else(|| string_field(payload, "id")),
                    name,
                    input: codex_tool_input(payload),
                }],
            )
        }
        "function_call_output" | "custom_tool_call_output" => (
            "assistant".to_string(),
            vec![TurnBlock::ToolResult {
                tool_use_id: string_field(payload, "call_id")
                    .or_else(|| string_field(payload, "callId")),
                content: payload.get("output").cloned().unwrap_or(Value::Null),
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
        native_id: codex_payload_turn_id(payload),
        parent_native_id: None,
        native_message_id: string_field(payload, "id"),
    })
}

fn codex_workspace_observation(line: &str) -> Option<WorkspaceObservation> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    let raw_cwd = match value.get("type").and_then(Value::as_str)? {
        "turn_context" => value
            .get("payload")?
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::trim),
        "event_msg" => {
            let payload = value.get("payload")?;
            if payload.get("type").and_then(Value::as_str) != Some("item_completed") {
                return None;
            }
            let item = payload.get("item")?;
            if item.get("type").and_then(Value::as_str) != Some("CommandExecution") {
                return None;
            }
            item.get("cwd").and_then(Value::as_str).map(str::trim)
        }
        _ => None,
    }?;
    if raw_cwd.is_empty() {
        return None;
    }
    Some(WorkspaceObservation {
        cwd: decode_codex_cwd(raw_cwd)?,
        source: ActiveWorkspaceSource::Codex,
        session_id: codex_observation_session_id(&value),
        observed_at_millis: super::native_timestamp_ms(&value)
            .and_then(|millis| u128::try_from(millis).ok()),
    })
}

fn decode_codex_cwd(raw_cwd: &str) -> Option<String> {
    if raw_cwd.starts_with("file:") {
        url::Url::parse(raw_cwd)
            .ok()?
            .to_file_path()
            .ok()
            .map(|path| path.display().to_string())
    } else {
        Some(raw_cwd.to_string())
    }
}

fn codex_observation_session_id(value: &Value) -> Option<String> {
    string_field(value, "session_id")
        .or_else(|| string_field(value, "sessionId"))
        .or_else(|| {
            value.get("payload").and_then(|payload| {
                string_field(payload, "session_id")
                    .or_else(|| string_field(payload, "sessionId"))
                    .or_else(|| string_field(payload, "thread_id"))
            })
        })
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
    // Codex rollback removes complete replay segments newest-first until it has
    // crossed the requested number of genuine user boundaries. A newer
    // tool/context-only segment is removed too, but does not decrement the
    // count. Model those segments explicitly rather than treating every
    // task_started or role=user record as an independent user turn.
    let mut active_segments: Vec<CodexReplaySegment> = Vec::new();
    let mut interrupted_turn_ids = HashSet::new();
    let mut rolled_back_source_indices = HashSet::new();
    let mut seen_native_message_ids = HashSet::new();

    for (relative_index, line) in lines.iter().enumerate() {
        let source_index = source_index_offset + relative_index;
        let value = match serde_json::from_str::<Value>(line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        if value.get("type").and_then(Value::as_str) == Some("response_item") {
            let segment_index = value.get("payload").and_then(|payload| {
                record_codex_response_segment(
                    &mut active_segments,
                    codex_payload_turn_id(payload),
                    codex_payload_is_user_turn_boundary(payload),
                )
            });
            if let Some(turn) = parse_transcript_line(agent_id, source_index, line) {
                if let Some(segment_index) = segment_index {
                    active_segments[segment_index]
                        .turn_source_indices
                        .push(source_index);
                }
                if should_add_codex_turn(&turn, &mut seen_native_message_ids) {
                    turns.push(turn);
                }
            }
            continue;
        }

        if value.get("type").and_then(Value::as_str) == Some("compacted") {
            for turn in codex_compacted_record_turns(agent_id, source_index, &value) {
                if should_add_codex_turn(&turn, &mut seen_native_message_ids) {
                    turns.push(turn);
                }
            }
            continue;
        }

        let Some(payload) = value
            .get("payload")
            .filter(|_| value.get("type").and_then(Value::as_str) == Some("event_msg"))
        else {
            continue;
        };
        match payload.get("type").and_then(Value::as_str) {
            Some("task_started") => {
                if let Some(turn_id) = string_field(payload, "turn_id") {
                    start_codex_replay_segment(&mut active_segments, turn_id);
                }
            }
            Some("user_message") => {
                // This event is Codex's non-contextual user boundary. Context
                // reinjections appear only as response items and are filtered
                // by codex_payload_is_user_turn_boundary below.
                if let Some(segment) = active_segments.last_mut() {
                    segment.counts_as_user_turn = true;
                }
            }
            Some("turn_aborted") => {
                if let Some(turn_id) = string_field(payload, "turn_id") {
                    interrupted_turn_ids.insert(turn_id);
                }
            }
            Some("thread_rolled_back") => {
                let num_turns = payload
                    .get("num_turns")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let mut remaining = num_turns;
                while remaining > 0 {
                    let Some(segment) = active_segments.pop() else {
                        break;
                    };
                    rolled_back_source_indices.extend(segment.turn_source_indices);
                    if segment.counts_as_user_turn {
                        remaining -= 1;
                    }
                }
            }
            _ => {}
        }
    }

    for turn in &mut turns {
        if turn
            .native_id
            .as_deref()
            .is_some_and(|turn_id| interrupted_turn_ids.contains(turn_id))
        {
            turn.status = Some(TurnStatus::Interrupted);
            turn.status_reason = Some(TurnStatusReason::Interrupted);
        }
        if rolled_back_source_indices.contains(&turn.source_index) {
            turn.context_status = Some(TurnContextStatus::RolledBack);
        }
    }

    turns
}

const COMPACTED_SOURCE_INDEX_STRIDE: usize = 1_000_000;

/// Returns true the first time a native message id is seen. Turns without a
/// native message id are always admitted. This prevents a message from
/// appearing twice when it is recorded both as a `response_item` and inside a
/// later `compacted.replacement_history`.
fn should_add_codex_turn(turn: &Turn, seen_native_message_ids: &mut HashSet<String>) -> bool {
    turn.native_message_id
        .as_ref()
        .map_or(true, |id| seen_native_message_ids.insert(id.clone()))
}

/// Expands a Codex `compacted` record into the user/assistant `message` entries
/// it summarizes. The top-level `compacted` line itself does not appear as a
/// turn; instead, each entry in `payload.replacement_history` becomes a turn
/// with a synthetic source index derived from the parent line so it is unique
/// and stable across re-reads. This makes the right pane transcript keep
/// working after Codex replaces earlier `response_item` records with a compacted
/// summary.
fn codex_compacted_record_turns(agent_id: &str, source_index: usize, value: &Value) -> Vec<Turn> {
    let Some(payload) = value.get("payload") else {
        return Vec::new();
    };
    let Some(history) = payload.get("replacement_history").and_then(Value::as_array) else {
        return Vec::new();
    };
    let session_id = string_field(value, "session_id").or_else(|| string_field(value, "sessionId"));
    let parent_timestamp = super::native_timestamp_ms(value);
    let mut turns = Vec::new();

    for (index, item) in history.iter().enumerate() {
        let item_type = item.get("type").and_then(Value::as_str);
        if item_type == Some("compaction") {
            // A nested compaction is an encrypted summary of an earlier
            // compaction; it has no human-readable content to display.
            continue;
        }
        if item_type != Some("message") {
            continue;
        }
        let Some(role) = item.get("role").and_then(Value::as_str) else {
            continue;
        };
        if role == "developer" || role == "system" {
            continue;
        }
        let Some(blocks) = parse_codex_message_blocks(item.get("content")) else {
            continue;
        };
        if blocks.is_empty() {
            continue;
        }
        let compacted_source_index = (source_index + 1)
            .saturating_mul(COMPACTED_SOURCE_INDEX_STRIDE)
            .saturating_add(index);
        turns.push(Turn {
            id: format!("{agent_id}-{compacted_source_index}"),
            agent_id: agent_id.to_string(),
            session_id: session_id.clone(),
            role: role.to_string(),
            blocks,
            source_index: compacted_source_index,
            timestamp: super::native_timestamp_ms(item).or(parent_timestamp),
            status: None,
            status_reason: None,
            context_status: None,
            native_id: codex_payload_turn_id(item),
            parent_native_id: None,
            native_message_id: string_field(item, "id"),
        });
    }

    turns
}

struct CodexReplaySegment {
    turn_id: String,
    counts_as_user_turn: bool,
    turn_source_indices: Vec<usize>,
}

fn start_codex_replay_segment(segments: &mut Vec<CodexReplaySegment>, turn_id: String) {
    if segments
        .last()
        .is_some_and(|segment| segment.turn_id == turn_id)
    {
        return;
    }
    segments.push(CodexReplaySegment {
        turn_id,
        counts_as_user_turn: false,
        turn_source_indices: Vec::new(),
    });
}

fn record_codex_response_segment(
    segments: &mut Vec<CodexReplaySegment>,
    turn_id: Option<String>,
    counts_as_user_turn: bool,
) -> Option<usize> {
    let segment_index = match turn_id {
        Some(turn_id) => {
            if let Some(index) = segments
                .iter()
                .rposition(|segment| segment.turn_id == turn_id)
            {
                index
            } else {
                start_codex_replay_segment(segments, turn_id);
                segments.len() - 1
            }
        }
        None => segments.len().checked_sub(1)?,
    };
    if let Some(segment) = segments.get_mut(segment_index) {
        segment.counts_as_user_turn |= counts_as_user_turn;
    }
    Some(segment_index)
}

fn codex_payload_is_user_turn_boundary(payload: &Value) -> bool {
    if payload.get("type").and_then(Value::as_str) != Some("message")
        || payload.get("role").and_then(Value::as_str) != Some("user")
    {
        return false;
    }
    match payload.get("content") {
        Some(Value::String(text)) => codex_user_text_is_turn_boundary(text),
        Some(Value::Array(items)) => items.iter().any(|item| {
            if item.get("type").and_then(Value::as_str) == Some("input_image") {
                return true;
            }
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("input_text" | "text")
            ) && item
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(codex_user_text_is_turn_boundary)
        }),
        _ => false,
    }
}

fn codex_user_text_is_turn_boundary(text: &str) -> bool {
    let text = text.trim();
    !text.is_empty() && !codex_user_text_is_contextual(text)
}

/// Mirrors the stable wrappers Codex uses for user-role context closely enough
/// for old rollouts that lack `EventMsg::UserMessage`. Do not classify arbitrary
/// XML-looking text as context: a user's whole prompt can legitimately be
/// wrapped in `<request>` (or any other application-specific tag), and treating
/// it as plumbing makes a later rollback consume one extra real turn.
fn codex_user_text_is_contextual(text: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "# agents.md instructions",
        "<environment_context",
        "<user_shell_command>",
        "<turn_aborted>",
        "<subagent_notification>",
        "<codex_internal_context",
        "<goal_context>",
        "<recommended_plugins>",
        "<additional_context",
        "<hook_prompt",
    ];
    let text = text.trim_start().to_ascii_lowercase();
    PREFIXES.iter().any(|prefix| text.starts_with(prefix))
}

fn codex_payload_turn_id(payload: &Value) -> Option<String> {
    payload
        .get("internal_chat_message_metadata_passthrough")
        .and_then(|metadata| string_field(metadata, "turn_id"))
        .or_else(|| string_field(payload, "turn_id"))
}

fn is_codex_status_event(line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    // A `compacted` record replaces earlier history with its own
    // `replacement_history`, so the whole visible transcript has to be re-resolved
    // rather than appended one line at a time.
    if value.get("type").and_then(Value::as_str) == Some("compacted") {
        return true;
    }
    if value.get("type").and_then(Value::as_str) != Some("event_msg") {
        return false;
    }
    let Some(event_type) = value
        .get("payload")
        .and_then(|payload| payload.get("type"))
        .and_then(Value::as_str)
    else {
        return false;
    };
    matches!(event_type, "turn_aborted" | "thread_rolled_back")
}

fn parse_transcript_lifecycle_event(line: &str) -> Option<TranscriptLifecycleEvent> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("event_msg") {
        return None;
    }
    let payload = value.get("payload")?;
    match payload.get("type").and_then(Value::as_str) {
        Some("turn_aborted") => Some(TranscriptLifecycleEvent::Interrupted),
        Some("task_started") => Some(TranscriptLifecycleEvent::TurnStarted),
        // TurnComplete. Codex also emits Stop mid-turn (review jobs, internal
        // TUI queue); only this record means the parent turn actually finished.
        Some("task_complete") => Some(TranscriptLifecycleEvent::TurnCompleted),
        _ => None,
    }
}

fn parse_codex_message_blocks(content: Option<&Value>) -> Option<Vec<TurnBlock>> {
    match content? {
        Value::String(text) => Some(vec![TurnBlock::Text { text: text.clone() }]),
        Value::Array(items) => {
            let mut blocks = Vec::new();
            let mut index = 0;
            while index < items.len() {
                // Current Codex transcripts split a pasted image across three
                // content items: an opening <image ...> text item, the base64
                // input_image payload, and a closing </image> text item. Keep
                // the safe on-disk marker while dropping the huge data URL so
                // the frontend can load the source path as a thumbnail.
                if let Some(marker) = codex_image_marker_at(items, index) {
                    blocks.push(TurnBlock::Text { text: marker });
                    index += 3;
                    continue;
                }

                let item = &items[index];
                let block_type = item.get("type").and_then(Value::as_str);
                if matches!(block_type, Some("input_text" | "output_text" | "text"))
                    && let Some(text) = item.get("text").and_then(Value::as_str)
                {
                    blocks.push(TurnBlock::Text {
                        text: text.to_string(),
                    });
                }
                index += 1;
            }
            Some(blocks)
        }
        _ => None,
    }
}

fn codex_image_marker_at(items: &[Value], index: usize) -> Option<String> {
    let opening = items.get(index)?;
    let image = items.get(index + 1)?;
    let closing = items.get(index + 2)?;
    let opening_text = opening
        .get("type")
        .and_then(Value::as_str)
        .filter(|kind| matches!(*kind, "input_text" | "text"))
        .and_then(|_| opening.get("text"))
        .and_then(Value::as_str)?
        .trim();
    let is_image_payload = image.get("type").and_then(Value::as_str) == Some("input_image");
    let closing_text = closing
        .get("type")
        .and_then(Value::as_str)
        .filter(|kind| matches!(*kind, "input_text" | "text"))
        .and_then(|_| closing.get("text"))
        .and_then(Value::as_str)?
        .trim();

    (is_image_payload
        && opening_text.starts_with("<image ")
        && opening_text.ends_with('>')
        && closing_text == "</image>")
        .then(|| format!("{opening_text}\n</image>"))
}

fn codex_tool_input(payload: &Value) -> Value {
    if let Some(arguments) = payload.get("arguments") {
        if let Some(arguments) = arguments.as_str() {
            return serde_json::from_str(arguments)
                .unwrap_or_else(|_| Value::String(arguments.to_string()));
        }
        return arguments.clone();
    }
    payload.get("input").cloned().unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, GrokAdapterConfig,
    };
    use crate::state::AppState;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn workspace_observation_uses_turn_context_cwd_and_record_session_id() {
        let line = json!({
            "type": "turn_context",
            "session_id": "child-session",
            "payload": { "cwd": "/tmp/feature worktree" }
        })
        .to_string();

        assert_eq!(
            codex_workspace_observation(&line),
            Some(WorkspaceObservation {
                cwd: "/tmp/feature worktree".to_string(),
                source: ActiveWorkspaceSource::Codex,
                session_id: Some("child-session".to_string()),
                observed_at_millis: None,
            })
        );
    }

    #[test]
    fn workspace_observation_decodes_completed_command_file_urls() {
        let line = json!({
            "type": "event_msg",
            "payload": {
                "type": "item_completed",
                "thread_id": "child-session",
                "item": {
                    "type": "CommandExecution",
                    "cwd": "file:///tmp/feature%20worktree",
                    "command": "pwd",
                    "status": "completed"
                }
            }
        })
        .to_string();

        assert_eq!(
            codex_workspace_observation(&line),
            Some(WorkspaceObservation {
                cwd: "/tmp/feature worktree".to_string(),
                source: ActiveWorkspaceSource::Codex,
                session_id: Some("child-session".to_string()),
                observed_at_millis: None,
            })
        );
    }

    #[test]
    fn workspace_observation_ignores_session_and_incomplete_command_records() {
        let session = json!({ "type": "session_meta", "cwd": "/wrong" }).to_string();
        let started = json!({
            "type": "event_msg",
            "payload": {
                "type": "item_started",
                "item": { "type": "CommandExecution", "cwd": "/wrong" }
            }
        })
        .to_string();

        assert_eq!(codex_workspace_observation(&session), None);
        assert_eq!(codex_workspace_observation(&started), None);
    }

    #[test]
    fn launch_options_reject_unknown_fields() {
        let err = CodexLaunchOptions::from_value(json!({ "bogus": true })).unwrap_err();

        assert!(err.contains("invalid Codex adapter options"));
    }

    #[test]
    fn launch_options_reject_removed_profile_and_oss_options() {
        let profile_err = CodexLaunchOptions::from_value(json!({ "profile": "work" })).unwrap_err();
        let oss_err = CodexLaunchOptions::from_value(json!({ "oss": true })).unwrap_err();

        assert!(profile_err.contains("invalid Codex adapter options"));
        assert!(oss_err.contains("invalid Codex adapter options"));
    }

    #[test]
    fn launch_options_validate_known_enums() {
        let err = CodexLaunchOptions::from_value(json!({ "sandbox": "full-send" })).unwrap_err();

        assert!(err.contains("invalid Codex adapter option sandbox"));
    }

    #[test]
    fn launch_options_reject_deprecated_on_failure_approval_policy() {
        let err =
            CodexLaunchOptions::from_value(json!({ "approvalPolicy": "on-failure" })).unwrap_err();

        assert!(err.contains("invalid Codex adapter option approvalPolicy"));
    }

    #[test]
    fn launch_options_validate_approvals_reviewer() {
        let err =
            CodexLaunchOptions::from_value(json!({ "approvalsReviewer": "robot" })).unwrap_err();

        assert!(err.contains("invalid Codex adapter option approvalsReviewer"));
    }

    #[test]
    fn codex_binary_keeps_path_when_code_mode_host_is_sibling() {
        let dir = temp_dir();
        let binary = dir.join("codex");
        let host = dir.join(CODEX_CODE_MODE_HOST);
        fs::write(&binary, "").unwrap();
        fs::write(&host, "").unwrap();

        assert_eq!(codex_binary_with_code_mode_host(binary.clone()), binary);
    }

    #[test]
    fn codex_binary_uses_symlink_target_when_host_alias_is_missing() {
        let root = temp_dir();
        let shim_dir = root.join("shim-bin");
        let real_dir = root.join("real-bin");
        fs::create_dir_all(&shim_dir).unwrap();
        fs::create_dir_all(&real_dir).unwrap();
        let real_binary = real_dir.join("codex");
        let shim_binary = shim_dir.join("codex");
        fs::write(&real_binary, "").unwrap();
        fs::write(real_dir.join(CODEX_CODE_MODE_HOST), "").unwrap();
        std::os::unix::fs::symlink(&real_binary, &shim_binary).unwrap();

        let resolved = codex_binary_with_code_mode_host(shim_binary.clone());

        assert_eq!(resolved, fs::canonicalize(&real_binary).unwrap());
        assert!(!shim_dir.join(CODEX_CODE_MODE_HOST).exists());
    }

    #[test]
    fn build_args_adds_cwd_model_options_and_tail_args() {
        let options = CodexLaunchOptions::from_value(json!({
            "sandbox": "workspace-write",
            "approvalPolicy": "on-request",
            "search": true
        }))
        .unwrap();

        let args = build_codex_args(
            Path::new("/tmp/session"),
            Some(Path::new("/tmp/session/.session/workspaces")),
            Some("gpt-5"),
            &options,
            Some("Use SESSION_WORKTREE_ROOT.\nTreat it as an opaque path."),
            None,
            vec!["--".to_string(), "start here".to_string()],
        );

        assert_eq!(
            args,
            vec![
                "--cd",
                "/tmp/session",
                "--add-dir",
                "/tmp/session/.session/workspaces",
                "--model",
                "gpt-5",
                "--profile",
                "session-codex",
                "--config",
                "developer_instructions=\"Use SESSION_WORKTREE_ROOT.\\nTreat it as an opaque path.\"",
                "--sandbox",
                "workspace-write",
                "--ask-for-approval",
                "on-request",
                "--search",
                "--",
                "start here"
            ]
        );
    }

    #[test]
    fn build_args_adds_auto_review_without_approval_policy_override() {
        let options = CodexLaunchOptions::from_value(json!({
            "sandbox": "workspace-write",
            "approvalPolicy": "on-request",
            "approvalsReviewer": "auto_review"
        }))
        .unwrap();

        let args = build_codex_args(
            Path::new("/tmp/session"),
            None,
            None,
            &options,
            None,
            None,
            Vec::new(),
        );

        assert_eq!(
            args,
            vec![
                "--cd",
                "/tmp/session",
                "--profile",
                "session-codex",
                "--sandbox",
                "workspace-write",
                "--config",
                "approvals_reviewer=\"auto_review\"",
                "--search"
            ]
        );
    }

    #[test]
    fn worktree_root_env_is_only_added_when_resolved() {
        let mut envs = vec![("EXISTING".to_string(), "value".to_string())];
        add_codex_worktree_root_env(&mut envs, None);
        assert_eq!(envs.len(), 1);

        add_codex_worktree_root_env(&mut envs, Some("/repo/.claude/worktrees"));
        assert_eq!(
            envs.last(),
            Some(&(
                "SESSION_WORKTREE_ROOT".to_string(),
                "/repo/.claude/worktrees".to_string()
            ))
        );
    }

    #[test]
    fn launch_options_validate_reasoning_effort() {
        for level in CODEX_REASONING_EFFORT_LEVELS {
            let options = CodexLaunchOptions::from_value(json!({ "reasoningEffort": level }))
                .expect("current Codex reasoning level should be accepted");
            assert_eq!(options.reasoning_effort.as_deref(), Some(*level));
        }

        let err =
            CodexLaunchOptions::from_value(json!({ "reasoningEffort": "extreme" })).unwrap_err();
        assert!(err.contains("invalid Codex adapter option reasoningEffort"));
    }

    #[test]
    fn build_args_adds_reasoning_effort_config() {
        let options =
            CodexLaunchOptions::from_value(json!({ "reasoningEffort": "ultra" })).unwrap();

        let args = build_codex_args(
            Path::new("/tmp/session"),
            None,
            Some("gpt-5.6-luna"),
            &options,
            None,
            None,
            Vec::new(),
        );

        assert_eq!(
            args,
            vec![
                "--cd",
                "/tmp/session",
                "--model",
                "gpt-5.6-luna",
                "--profile",
                "session-codex",
                "--sandbox",
                "workspace-write",
                "--config",
                "model_reasoning_effort=\"ultra\"",
                "--search"
            ]
        );
    }

    #[test]
    fn remote_args_inline_hooks_without_replacing_codex_home() {
        let args = build_codex_args(
            Path::new("/srv/project"),
            None,
            None,
            &CodexLaunchOptions::default(),
            None,
            Some("/opt/session tools/session-cli"),
            Vec::new(),
        );

        assert!(!args.iter().any(|arg| arg == "--profile"));
        assert!(
            args.windows(2)
                .any(|pair| { pair == ["--config", "features.hooks=true"] })
        );
        assert!(args.iter().any(|arg| {
            arg.starts_with("hooks.SessionStart=")
                && arg.contains("matcher=\"startup|resume\"")
                && arg.contains("'/opt/session tools/session-cli' notify SessionStart")
        }));
        assert!(args.iter().any(|arg| {
            arg.starts_with("hooks.Stop=")
                && arg.contains("'/opt/session tools/session-cli' notify Stop")
        }));
    }

    #[test]
    fn prompt_tail_args_trim_and_delimit_initial_prompt() {
        assert_eq!(prompt_tail_args("   "), Vec::<String>::new());
        assert_eq!(
            prompt_tail_args("  start here  "),
            vec!["--".to_string(), "start here".to_string()]
        );
    }

    #[test]
    fn fork_args_include_session_id_and_prompt_when_present() {
        let options = CodexLaunchOptions::from_value(json!({
            "sandbox": "workspace-write",
            "approvalPolicy": "on-request"
        }))
        .unwrap();

        let args = build_codex_fork_args(
            Path::new("/tmp/session"),
            Some(Path::new("/tmp/session/.session/workspaces")),
            Some("gpt-5"),
            &options,
            None,
            None,
            " session-123 ",
            Some("  continue here  "),
        );

        assert_eq!(
            args,
            vec![
                "--cd",
                "/tmp/session",
                "--add-dir",
                "/tmp/session/.session/workspaces",
                "--model",
                "gpt-5",
                "--profile",
                "session-codex",
                "--sandbox",
                "workspace-write",
                "--ask-for-approval",
                "on-request",
                "--search",
                "fork",
                "session-123",
                "--",
                "continue here"
            ]
        );
    }

    #[test]
    fn fork_args_omit_empty_prompt() {
        let options = CodexLaunchOptions::default();

        let args = build_codex_fork_args(
            Path::new("/tmp/session"),
            None,
            None,
            &options,
            None,
            None,
            "session-123",
            Some("   "),
        );

        assert_eq!(
            args,
            vec![
                "--cd",
                "/tmp/session",
                "--profile",
                "session-codex",
                "--sandbox",
                "workspace-write",
                "--search",
                "fork",
                "session-123"
            ]
        );
    }

    #[test]
    fn generated_profile_uses_stable_session_shim_and_inline_hooks() {
        let codex_home = temp_dir();
        let session_cli = Path::new("/Applications/session app/session");

        write_codex_integration_files(&codex_home, session_cli).unwrap();

        let profile_path = codex_home.join("session-codex.config.toml");
        let shim_path = codex_home.join("session").join("session-codex-hook");
        let profile = fs::read_to_string(profile_path).unwrap();
        let shim = fs::read_to_string(shim_path).unwrap();

        assert!(profile.contains("[features]"));
        assert!(profile.contains("hooks = true"));
        assert!(profile.contains("[[hooks.SessionStart]]"));
        assert!(profile.contains("matcher = \"startup|resume\""));
        for event in CODEX_HOOK_EVENTS {
            assert!(
                profile.contains(&format!("[[hooks.{event}]]")),
                "missing hook group for {event}"
            );
            assert!(
                profile.contains(&format!("session-codex-hook' {event}")),
                "missing hook command for {event}"
            );
        }
        assert!(profile.contains("Session executable: /Applications/session app/session"));
        assert!(shim.contains("SESSION_SOCK"));
        assert!(shim.contains("exec \"$SESSION_CLI\" notify \"$event\""));
    }

    #[test]
    fn generated_profile_preserves_codex_hook_trust_state() {
        let codex_home = temp_dir();
        let session_cli = Path::new("/Applications/session app/session");
        let profile_path = codex_home.join("session-codex.config.toml");

        fs::write(
            &profile_path,
            r#"[features]
hooks = true

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "'/old/session-codex-hook' Stop"
timeout = 5

[hooks.state]

[hooks.state."/Users/raymond/.codex/session-codex.config.toml:stop:0:0"]
trusted_hash = "sha256:trusted"
"#,
        )
        .unwrap();

        write_codex_integration_files(&codex_home, session_cli).unwrap();

        let profile = fs::read_to_string(profile_path).unwrap();
        assert!(profile.contains("command = \"'/"));
        assert!(profile.contains("session-codex-hook' Stop"));
        assert!(profile.contains("[hooks.state]"));
        assert!(profile.contains("trusted_hash = \"sha256:trusted\""));
        assert!(!profile.contains("command = \"'/old/session-codex-hook' Stop\""));
    }

    #[test]
    fn interactive_codex_attach_marks_agent_idle() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::Starting;
        agent.pane_id = None;
        state.insert_agent(agent).unwrap();

        let attached =
            attach_codex_agent_pane(&state, "agent-1", "pane-1".to_string(), false).unwrap();

        assert!(matches!(attached.status, AgentStatus::Idle));
        let stored = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(matches!(stored.status, AgentStatus::Idle));
    }

    #[test]
    fn prompted_codex_attach_marks_agent_running() {
        let state = test_state();
        let mut agent = sample_agent();
        agent.status = AgentStatus::Starting;
        agent.pane_id = None;
        state.insert_agent(agent).unwrap();

        let attached =
            attach_codex_agent_pane(&state, "agent-1", "pane-1".to_string(), true).unwrap();

        assert!(matches!(attached.status, AgentStatus::Running));
        let stored = state.agent("agent-1").unwrap().expect("agent exists");
        assert!(matches!(stored.status, AgentStatus::Running));
    }

    #[test]
    fn parse_codex_message_response_items() {
        let user_line = json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "fix the bug" }]
            }
        })
        .to_string();
        let assistant_line = json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "Done." }]
            }
        })
        .to_string();

        let user = parse_transcript_line("agent-1", 3, &user_line).expect("user turn");
        let assistant =
            parse_transcript_line("agent-1", 4, &assistant_line).expect("assistant turn");

        assert_eq!(user.role, "user");
        assert_eq!(assistant.role, "assistant");
        assert_text_block(&user.blocks[0], "fix the bug");
        assert_text_block(&assistant.blocks[0], "Done.");
    }

    #[test]
    fn parse_codex_message_reassembles_clipboard_image_markers() {
        let line = json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "<image name=[Image #1] path=\"/var/folders/example/T/codex-clipboard.png\">"
                    },
                    { "type": "input_image", "image_url": "data:image/png;base64,AAAA" },
                    { "type": "input_text", "text": "</image>" },
                    { "type": "input_text", "text": "Please inspect this image [Image #1]" }
                ]
            }
        })
        .to_string();

        let turn = parse_transcript_line("agent-1", 3, &line).expect("user turn");

        assert_eq!(turn.blocks.len(), 2);
        assert_text_block(
            &turn.blocks[0],
            "<image name=[Image #1] path=\"/var/folders/example/T/codex-clipboard.png\">\n</image>",
        );
        assert_text_block(&turn.blocks[1], "Please inspect this image [Image #1]");
    }

    #[test]
    fn parse_codex_tool_call_and_result_response_items() {
        let call_line = json!({
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "call_id": "call-1",
                "arguments": "{\"cmd\":\"npm test\"}"
            }
        })
        .to_string();
        let result_line = json!({
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "call_id": "call-1",
                "output": "ok"
            }
        })
        .to_string();

        let call = parse_transcript_line("agent-1", 5, &call_line).expect("tool call");
        let result = parse_transcript_line("agent-1", 6, &result_line).expect("tool result");

        assert_eq!(call.role, "assistant");
        match &call.blocks[0] {
            TurnBlock::ToolUse { id, name, input } => {
                assert_eq!(id.as_deref(), Some("call-1"));
                assert_eq!(name, "exec_command");
                assert_eq!(input["cmd"], "npm test");
            }
            other => panic!("unexpected block: {other:?}"),
        }
        match &result.blocks[0] {
            TurnBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                assert_eq!(tool_use_id.as_deref(), Some("call-1"));
                assert_eq!(content, "ok");
                assert!(!is_error);
            }
            other => panic!("unexpected block: {other:?}"),
        }
    }

    #[test]
    fn resolve_codex_transcript_keeps_rolled_back_interrupted_turn_visible() {
        let lines = vec![
            codex_task_started_line("turn-1"),
            codex_user_message_line("turn-1", "typo"),
            codex_assistant_message_line("turn-1", "partial"),
            codex_turn_aborted_line("turn-1"),
            json!({
                "type": "event_msg",
                "payload": { "type": "thread_rolled_back", "num_turns": 1 }
            })
            .to_string(),
            codex_task_started_line("turn-2"),
            codex_user_message_line("turn-2", "corrected"),
            codex_assistant_message_line("turn-2", "final"),
        ];

        let turns = resolve_transcript_turns("agent-1", &lines);

        assert_eq!(turns.len(), 4);
        assert!(turns[0..2].iter().all(|turn| {
            turn.status == Some(TurnStatus::Interrupted)
                && turn.status_reason == Some(TurnStatusReason::Interrupted)
                && turn.context_status == Some(TurnContextStatus::RolledBack)
        }));
        assert!(
            turns[2..]
                .iter()
                .all(|turn| turn.status.is_none() && turn.context_status.is_none())
        );
    }

    #[test]
    fn resolve_codex_transcript_marks_abort_without_rollback_interrupted() {
        let lines = vec![
            codex_task_started_line("turn-1"),
            codex_user_message_line("turn-1", "prompt"),
            codex_assistant_message_line("turn-1", "partial"),
            codex_turn_aborted_line("turn-1"),
        ];

        let turns = resolve_transcript_turns("agent-1", &lines);

        assert_eq!(turns.len(), 2);
        assert!(turns.iter().all(|turn| {
            turn.status == Some(TurnStatus::Interrupted)
                && turn.status_reason == Some(TurnStatusReason::Interrupted)
                && turn.context_status.is_none()
        }));
    }

    #[test]
    fn resolve_codex_transcript_marks_rollback_without_changing_outcome() {
        let lines = vec![
            codex_task_started_line("turn-1"),
            codex_user_message_line("turn-1", "prompt"),
            codex_assistant_message_line("turn-1", "answer"),
            json!({
                "type": "event_msg",
                "payload": { "type": "thread_rolled_back", "num_turns": 1 }
            })
            .to_string(),
        ];

        let turns = resolve_transcript_turns("agent-1", &lines);

        assert_eq!(turns.len(), 2);
        assert!(turns.iter().all(|turn| {
            turn.status.is_none()
                && turn.status_reason.is_none()
                && turn.context_status == Some(TurnContextStatus::RolledBack)
        }));
    }

    #[test]
    fn resolve_codex_transcript_uses_task_boundary_when_items_lack_turn_metadata() {
        let lines = vec![
            codex_task_started_line("turn-1"),
            json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "prompt" }]
                }
            })
            .to_string(),
            json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "answer" }]
                }
            })
            .to_string(),
            json!({
                "type": "event_msg",
                "payload": { "type": "thread_rolled_back", "num_turns": 1 }
            })
            .to_string(),
        ];

        let turns = resolve_transcript_turns("agent-1", &lines);

        assert_eq!(turns.len(), 2);
        assert!(turns.iter().all(|turn| {
            turn.native_id.is_none() && turn.context_status == Some(TurnContextStatus::RolledBack)
        }));
    }

    #[test]
    fn resolve_codex_transcript_does_not_treat_same_turn_steer_as_rollback() {
        let lines = vec![
            codex_task_started_line("turn-1"),
            codex_user_message_line("turn-1", "original"),
            codex_assistant_message_line("turn-1", "first part"),
            codex_user_message_line("turn-1", "steer"),
            codex_assistant_message_line("turn-1", "continued"),
        ];

        let turns = resolve_transcript_turns("agent-1", &lines);

        assert_eq!(turns.len(), 4);
        assert!(turns.iter().all(|turn| {
            turn.status.is_none() && turn.status_reason.is_none() && turn.context_status.is_none()
        }));
    }

    #[test]
    fn resolve_codex_transcript_rolls_back_newer_non_user_segments_too() {
        let lines = vec![
            codex_task_started_line("turn-0"),
            codex_user_message_line("turn-0", "real prompt"),
            codex_assistant_message_line("turn-0", "real answer"),
            codex_task_started_line("turn-1"),
            json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{
                        "type": "input_text",
                        "text": "<environment_context>\ninternal\n</environment_context>"
                    }],
                    "internal_chat_message_metadata_passthrough": { "turn_id": "turn-1" }
                }
            })
            .to_string(),
            json!({
                "type": "event_msg",
                "payload": { "type": "thread_rolled_back", "num_turns": 1 }
            })
            .to_string(),
        ];

        let turns = resolve_transcript_turns("agent-1", &lines);

        assert_eq!(turns.len(), 3);
        assert!(
            turns
                .iter()
                .all(|turn| { turn.context_status == Some(TurnContextStatus::RolledBack) })
        );
    }

    #[test]
    fn resolve_codex_transcript_counts_arbitrary_tagged_prompts_as_user_turns() {
        let lines = vec![
            codex_task_started_line("turn-0"),
            codex_user_message_line("turn-0", "older prompt"),
            codex_assistant_message_line("turn-0", "older answer"),
            codex_task_started_line("turn-1"),
            codex_user_message_line("turn-1", "<request>\nnew prompt\n</request>"),
            codex_assistant_message_line("turn-1", "new answer"),
            json!({
                "type": "event_msg",
                "payload": { "type": "thread_rolled_back", "num_turns": 1 }
            })
            .to_string(),
        ];

        let turns = resolve_transcript_turns("agent-1", &lines);

        assert_eq!(turns.len(), 4);
        assert!(turns[0..2].iter().all(|turn| turn.context_status.is_none()));
        assert!(
            turns[2..]
                .iter()
                .all(|turn| { turn.context_status == Some(TurnContextStatus::RolledBack) })
        );
    }

    #[test]
    fn resolve_codex_transcript_does_not_guess_for_unscoped_records() {
        let lines = vec![
            json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "visible tail" }]
                }
            })
            .to_string(),
            json!({
                "type": "event_msg",
                "payload": { "type": "thread_rolled_back", "num_turns": 1 }
            })
            .to_string(),
        ];

        let turns = resolve_transcript_turns("agent-1", &lines);

        assert_eq!(turns.len(), 1);
        assert!(turns[0].context_status.is_none());
    }

    #[test]
    fn bounded_codex_resolution_preserves_absolute_source_indices() {
        let lines = vec![
            codex_task_started_line("turn-1"),
            codex_user_message_line("turn-1", "prompt"),
        ];

        let turns = resolve_transcript_turns_from("agent-1", 500, &lines);

        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].source_index, 501);
        assert_eq!(turns[0].id, "agent-1-501");
    }

    #[test]
    fn resolve_codex_transcript_expands_compacted_record() {
        let lines = vec![
            json!({
                "type": "compacted",
                "timestamp": "2026-08-18T21:17:36.289Z",
                "payload": {
                    "replacement_history": [
                        {
                            "type": "message",
                            "id": "msg-turn-1",
                            "role": "user",
                            "content": [{ "type": "input_text", "text": "hello" }],
                            "internal_chat_message_metadata_passthrough": {
                                "turn_id": "turn-1"
                            }
                        },
                        {
                            "type": "message",
                            "id": "msg-turn-2",
                            "role": "assistant",
                            "content": [{ "type": "output_text", "text": "hi there" }],
                            "internal_chat_message_metadata_passthrough": {
                                "turn_id": "turn-2"
                            }
                        },
                        {
                            "type": "compaction",
                            "id": "cmp-1"
                        }
                    ]
                }
            })
            .to_string(),
        ];

        let turns = resolve_transcript_turns("agent-1", &lines);

        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].role, "user");
        assert_eq!(turns[0].source_index, 1_000_000);
        assert_eq!(turns[0].native_id.as_deref(), Some("turn-1"));
        assert_text_block(&turns[0].blocks[0], "hello");
        assert_eq!(turns[1].role, "assistant");
        assert_eq!(turns[1].source_index, 1_000_001);
        assert_eq!(turns[1].native_id.as_deref(), Some("turn-2"));
        assert_text_block(&turns[1].blocks[0], "hi there");
    }

    #[test]
    fn resolve_codex_transcript_deduplicates_compacted_messages() {
        let user_message = json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "id": "msg-turn-1",
                "role": "user",
                "content": [{ "type": "input_text", "text": "hello" }],
                "internal_chat_message_metadata_passthrough": {
                    "turn_id": "turn-1"
                }
            }
        })
        .to_string();
        let compacted = json!({
            "type": "compacted",
            "payload": {
                "replacement_history": [
                    {
                        "type": "message",
                        "id": "msg-turn-1",
                        "role": "user",
                        "content": [{ "type": "input_text", "text": "hello again" }],
                        "internal_chat_message_metadata_passthrough": {
                            "turn_id": "turn-1"
                        }
                    },
                    {
                        "type": "message",
                        "id": "msg-turn-2",
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": "hi" }],
                        "internal_chat_message_metadata_passthrough": {
                            "turn_id": "turn-2"
                        }
                    }
                ]
            }
        })
        .to_string();

        let turns = resolve_transcript_turns("agent-1", &[user_message, compacted]);

        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].source_index, 0);
        assert_text_block(&turns[0].blocks[0], "hello");
        assert_eq!(turns[1].source_index, 2_000_001);
        assert_text_block(&turns[1].blocks[0], "hi");
    }

    #[test]
    fn parse_codex_transcript_skips_duplicates_and_private_context() {
        let event_line = json!({
            "type": "event_msg",
            "payload": { "type": "user_message", "message": "fix the bug" }
        })
        .to_string();
        let developer_line = json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "developer",
                "content": [{ "type": "input_text", "text": "hidden" }]
            }
        })
        .to_string();
        let reasoning_line = json!({
            "type": "response_item",
            "payload": { "type": "reasoning", "summary": [] }
        })
        .to_string();

        assert!(parse_transcript_line("agent-1", 1, &event_line).is_none());
        assert!(parse_transcript_line("agent-1", 2, &developer_line).is_none());
        assert!(parse_transcript_line("agent-1", 3, &reasoning_line).is_none());
    }

    #[test]
    fn parse_codex_turn_aborted_lifecycle_event() {
        let abort_line = json!({
            "type": "event_msg",
            "payload": {
                "type": "turn_aborted",
                "turn_id": "turn-1",
                "reason": "interrupted"
            }
        })
        .to_string();
        let user_message_line = json!({
            "type": "event_msg",
            "payload": { "type": "user_message", "message": "fix the bug" }
        })
        .to_string();
        let task_started_line = json!({
            "type": "event_msg",
            "payload": { "type": "task_started", "turn_id": "turn-2" }
        })
        .to_string();
        let task_complete_line = json!({
            "type": "event_msg",
            "payload": { "type": "task_complete", "turn_id": "turn-2" }
        })
        .to_string();

        assert_eq!(
            parse_transcript_lifecycle_event(&abort_line),
            Some(TranscriptLifecycleEvent::Interrupted)
        );
        assert_eq!(
            parse_transcript_lifecycle_event(&task_started_line),
            Some(TranscriptLifecycleEvent::TurnStarted)
        );
        assert_eq!(
            parse_transcript_lifecycle_event(&task_complete_line),
            Some(TranscriptLifecycleEvent::TurnCompleted)
        );
        assert_eq!(parse_transcript_lifecycle_event(&user_message_line), None);
    }

    fn test_state() -> AppState {
        AppState::new(SessionConfig {
            remotes: Default::default(),
            workspace_root: temp_dir(),
            socket_path: PathBuf::from("/tmp/session-codex-test.sock"),
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
        })
    }

    fn sample_agent() -> AgentInfo {
        AgentInfo {
            id: "agent-1".to_string(),
            group_id: "group-1".to_string(),
            adapter: "codex".to_string(),
            worktree_dir: "/tmp/session-codex-test".to_string(),
            branch: None,
            active_workspace: None,
            pane_id: Some("pane-1".to_string()),
            orphaned_queue_pane_id: None,
            session_id: None,
            transcript_path: None,
            status: AgentStatus::Running,
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

    fn codex_task_started_line(turn_id: &str) -> String {
        json!({
            "type": "event_msg",
            "payload": { "type": "task_started", "turn_id": turn_id }
        })
        .to_string()
    }

    fn codex_user_message_line(turn_id: &str, text: &str) -> String {
        codex_message_line(turn_id, "user", "input_text", text)
    }

    fn codex_assistant_message_line(turn_id: &str, text: &str) -> String {
        codex_message_line(turn_id, "assistant", "output_text", text)
    }

    fn codex_message_line(turn_id: &str, role: &str, block_type: &str, text: &str) -> String {
        json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": role,
                "content": [{ "type": block_type, "text": text }],
                "internal_chat_message_metadata_passthrough": { "turn_id": turn_id }
            }
        })
        .to_string()
    }

    fn codex_turn_aborted_line(turn_id: &str) -> String {
        json!({
            "type": "event_msg",
            "payload": { "type": "turn_aborted", "turn_id": turn_id }
        })
        .to_string()
    }

    fn assert_text_block(block: &TurnBlock, expected: &str) {
        match block {
            TurnBlock::Text { text } => assert_eq!(text, expected),
            other => panic!("unexpected block: {other:?}"),
        }
    }

    fn temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = env::temp_dir().join(format!("session-codex-{nanos}-{seq}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
