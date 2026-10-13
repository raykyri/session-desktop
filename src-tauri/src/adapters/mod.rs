pub mod claude;
pub mod codex;
pub mod grok;

use crate::config::SessionConfig;
use crate::transcript::{Turn, TurnBlock};
// The canonical JSON string-field extractor. Re-exported so the adapters can reach it
// as `super::string_field` and share the one definition (see `transcript::string_field`).
pub(crate) use crate::transcript::string_field;
use claude::ClaudeAdapter;
use codex::CodexAdapter;
use grok::GrokAdapter;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Single-quotes an arbitrary argument for safe interpolation into a POSIX shell
/// command. Used to embed a session id into an adapter's resume command line.
pub(crate) fn shell_quote_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Whether a `transcript_path` reported by an adapter's hook notification may be
/// bound and tailed.
///
/// A hook arrives over the control socket carrying the pane's token, so a
/// prompt-injected agent can forge a `SessionStart` and point `transcript_path`
/// at any file. We can't fully validate the *first* path (SessionStart is how
/// Session discovers it, and the agent may not have written the file yet), but we
/// constrain it several ways: a `.jsonl` extension, an absolute path (a relative
/// one would resolve against an unknown cwd), and — when the target already
/// exists — a regular file, so a forged hook can't aim the tailer at a directory,
/// a symlink, or a FIFO/device (which could block the tail thread). Once a
/// transcript is bound we additionally require any later path to be a sibling in
/// the same session directory. Adapters keep a session's rollouts in one flat
/// directory, so a legitimate rotation stays a sibling while a forged mid-session
/// hook can no longer relocate the tail to an unrelated file (another agent's
/// transcript, a device/FIFO, an arbitrary log). The Claude adapter delegates
/// here so the guard stays single-sourced.
pub(crate) fn hook_transcript_path_acceptable(current: Option<&str>, candidate: &str) -> bool {
    let candidate = Path::new(candidate);
    if candidate.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
        return false;
    }
    if !candidate.is_absolute() {
        return false;
    }
    // `symlink_metadata` does not follow the final component, so a symlink is seen as a
    // symlink (not a regular file) and rejected. A path that doesn't exist yet is allowed
    // through — the agent may not have written its transcript at SessionStart time.
    if let Ok(meta) = std::fs::symlink_metadata(candidate)
        && !meta.file_type().is_file()
    {
        return false;
    }
    match current {
        Some(current) => Path::new(current).parent() == candidate.parent(),
        None => true,
    }
}

/// Parse a single line from a Claude-style or Grok-native rollout transcript (the
/// JSONL format used by Claude Code and by Grok Build's Claude-compatible sessions).
/// This is used for the `transcript_path` that Grok reports via its SessionStart hook.
pub(crate) fn parse_claude_native_transcript_line(
    agent_id: &str,
    source_index: usize,
    line: &str,
) -> Option<Turn> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    parse_claude_native_transcript_value(agent_id, source_index, &value)
}

/// As [`parse_claude_native_transcript_line`], but over an already-parsed value.
/// Lets a caller that also inspects the same line for other shapes (the Grok
/// adapter's synthetic-format fallback) parse the JSON once instead of per attempt.
pub(crate) fn parse_claude_native_transcript_value(
    agent_id: &str,
    source_index: usize,
    value: &Value,
) -> Option<Turn> {
    let message = value.get("message").unwrap_or(value);
    let role = message
        .get("role")
        .or_else(|| value.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("event")
        .to_string();
    let session_id = string_field(value, "session_id").or_else(|| string_field(value, "sessionId"));
    let content = message.get("content").or_else(|| value.get("content"))?;
    let blocks = parse_claude_native_blocks(content);

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
        timestamp: native_timestamp_ms(value),
        status: None,
        status_reason: None,
        context_status: None,
        native_id: string_field(value, "uuid"),
        parent_native_id: string_field(value, "parentUuid")
            .or_else(|| string_field(value, "parent_uuid")),
        native_message_id: string_field(message, "id"),
    })
}

/// Best-effort per-record timestamp from a native transcript value, in
/// milliseconds since the Unix epoch: RFC3339 strings or numeric epochs under
/// the common field spellings. None when the record carries no usable time.
pub(crate) fn native_timestamp_ms(value: &Value) -> Option<i64> {
    let field = value
        .get("timestamp")
        .or_else(|| value.get("created_at"))
        .or_else(|| value.get("createdAt"))?;
    match field {
        Value::String(text) => crate::transcript::rfc3339_to_epoch_ms(text),
        Value::Number(number) => {
            let raw = number
                .as_i64()
                .or_else(|| number.as_f64().map(|float| float as i64))?;
            // Second-resolution epochs sit far below any millisecond epoch of
            // the same era; scale them up rather than misreading them as 1970.
            if raw >= 1_000_000_000_000 {
                Some(raw)
            } else {
                raw.checked_mul(1_000)
            }
        }
        _ => None,
    }
}

/// As [`parse_claude_native_lifecycle_event`], but over an already-parsed value (see
/// [`parse_claude_native_transcript_value`]).
pub(crate) fn parse_claude_native_lifecycle_value(
    value: &Value,
) -> Option<TranscriptLifecycleEvent> {
    if value.get("interruptedMessageId").is_some() || value.get("interrupted_message_id").is_some()
    {
        return Some(TranscriptLifecycleEvent::Interrupted);
    }

    let message = value.get("message").unwrap_or(value);
    let content = message.get("content").or_else(|| value.get("content"))?;
    claude_native_content_has_interruption_marker(content)
        .then_some(TranscriptLifecycleEvent::Interrupted)
}

fn claude_native_content_has_interruption_marker(content: &Value) -> bool {
    match content {
        Value::String(text) => is_claude_interruption_marker(text),
        Value::Array(items) => items.iter().any(|item| {
            item.get("type").and_then(Value::as_str) == Some("text")
                && item
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(is_claude_interruption_marker)
        }),
        _ => false,
    }
}

pub(crate) fn is_claude_interruption_marker(text: &str) -> bool {
    matches!(
        text.trim(),
        "[Request interrupted by user]" | "[Request interrupted by user for tool use]"
    )
}

fn parse_claude_native_blocks(content: &Value) -> Vec<TurnBlock> {
    match content {
        Value::String(text) => vec![TurnBlock::Text { text: text.clone() }],
        Value::Array(items) => items.iter().filter_map(parse_claude_native_block).collect(),
        other => vec![TurnBlock::Raw {
            value: other.clone(),
        }],
    }
}

fn parse_claude_native_block(value: &Value) -> Option<TurnBlock> {
    let block_type = value.get("type").and_then(Value::as_str);
    match block_type {
        Some("text") => value
            .get("text")
            .and_then(Value::as_str)
            .map(|text| TurnBlock::Text {
                text: text.to_string(),
            }),
        Some("tool_use") => Some(TurnBlock::ToolUse {
            id: string_field(value, "id"),
            name: value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string(),
            input: value.get("input").cloned().unwrap_or(Value::Null),
        }),
        Some("tool_result") => Some(TurnBlock::ToolResult {
            tool_use_id: string_field(value, "tool_use_id")
                .or_else(|| string_field(value, "toolUseId")),
            content: value.get("content").cloned().unwrap_or(Value::Null),
            is_error: value
                .get("is_error")
                .or_else(|| value.get("isError"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        Some(_) => Some(TurnBlock::Raw {
            value: value.clone(),
        }),
        None => value.as_str().map(|text| TurnBlock::Text {
            text: text.to_string(),
        }),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TranscriptLifecycleEvent {
    Interrupted,
}

pub trait AgentAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    /// The configured executable name or path used by every launch and probe.
    fn configured_binary(&self) -> &str;

    fn parse_transcript_line(
        &self,
        agent_id: &str,
        source_index: usize,
        line: &str,
    ) -> Option<Turn>;

    fn resolve_transcript_turns(
        &self,
        agent_id: &str,
        source_index_offset: usize,
        lines: &[String],
    ) -> Vec<Turn> {
        lines
            .iter()
            .enumerate()
            .filter_map(|(index, line)| {
                self.parse_transcript_line(agent_id, source_index_offset + index, line)
            })
            .collect()
    }

    /// Whether this adapter has a supported research runtime.
    fn supports_research(&self) -> bool {
        false
    }
}

pub struct AdapterRegistry {
    adapters: Vec<Box<dyn AgentAdapter>>,
}

impl AdapterRegistry {
    pub fn new(adapters: Vec<Box<dyn AgentAdapter>>) -> Self {
        Self { adapters }
    }

    pub fn get(&self, adapter_id: &str) -> Result<&dyn AgentAdapter, String> {
        self.adapters
            .iter()
            .find(|adapter| adapter.id() == adapter_id)
            .map(|adapter| adapter.as_ref())
            .ok_or_else(|| format!("unknown agent adapter '{adapter_id}'"))
    }

    pub fn metadata(&self) -> Vec<AdapterMetadata> {
        self.adapters
            .iter()
            .map(|adapter| {
                let configured_binary = adapter.configured_binary().to_string();
                let resolved_binary =
                    ensure_on_path(&configured_binary).map(|path| path.display().to_string());
                let installed = resolved_binary.is_some();
                let login_command = adapter_login_command(adapter.id(), &configured_binary);
                // The updater runs through the executable Session resolved,
                // so it updates the installation research launches.
                let update_command = adapter_update_command(
                    adapter.id(),
                    resolved_binary.as_deref().unwrap_or(&configured_binary),
                );
                AdapterMetadata {
                    id: adapter.id().to_string(),
                    label: adapter.display_name().to_string(),
                    default: adapter.id() == "claude",
                    supports_research: adapter.supports_research(),
                    supports_recap_generation: matches!(adapter.id(), "claude" | "codex" | "grok"),
                    configured_binary,
                    resolved_binary,
                    readiness: if installed {
                        AdapterReadiness::Ready
                    } else {
                        AdapterReadiness::Missing
                    },
                    message: (!installed).then(|| {
                        format!(
                            "{} was not found. Install it or configure its binary path.",
                            adapter.display_name()
                        )
                    }),
                    research_readiness: if installed {
                        AdapterReadiness::Ready
                    } else {
                        AdapterReadiness::Missing
                    },
                    version: None,
                    auth: AdapterAuthState::Unknown,
                    auth_detail: None,
                    checked_at: None,
                    login_command,
                    install_command: adapter_install_command(adapter.id()).map(str::to_string),
                    install_url: adapter_install_url(adapter.id()).map(str::to_string),
                    update_command,
                    instance_id: format!("local:{}", adapter.id()),
                    target: AdapterTargetMetadata::local(),
                }
            })
            .collect()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AdapterReadiness {
    Ready,
    Missing,
    NeedsAuth,
    UnsupportedVersion,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AdapterAuthState {
    Authenticated,
    Unauthenticated,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterMetadata {
    pub id: String,
    pub label: String,
    pub default: bool,
    /// Whether the adapter can run and branch through the research harness.
    pub supports_research: bool,
    /// Whether the adapter supports the isolated structured-output request used
    /// for research recap generation.
    pub supports_recap_generation: bool,
    /// Executable name/path from session.config.json after home expansion.
    pub configured_binary: String,
    /// Resolved executable used for launch, absent when it cannot be found.
    pub resolved_binary: Option<String>,
    pub readiness: AdapterReadiness,
    pub message: Option<String>,
    /// Headless Research can have stricter version/auth requirements than an
    /// interactive terminal session.
    pub research_readiness: AdapterReadiness,
    pub version: Option<String>,
    pub auth: AdapterAuthState,
    /// Why sign-in could not be verified, set when a probe leaves `auth`
    /// `Unknown`: the status command failed to run, or its output matched
    /// neither a signed-in nor a signed-out result. It never carries the
    /// command's output, which can include account details.
    pub auth_detail: Option<String>,
    pub checked_at: Option<u64>,
    pub login_command: Option<String>,
    pub install_command: Option<String>,
    pub install_url: Option<String>,
    pub update_command: Option<String>,
    /// Stable provider-instance identity. The first implementation has one
    /// configured instance per adapter and target; the contract does not need
    /// to change when account/home profiles are added later.
    pub instance_id: String,
    pub target: AdapterTargetMetadata,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterTargetMetadata {
    pub kind: String,
    pub id: Option<String>,
    pub label: String,
}

impl AdapterTargetMetadata {
    fn local() -> Self {
        Self {
            kind: "local".to_string(),
            id: None,
            label: "This Mac".to_string(),
        }
    }
}

struct ProbeOutput {
    success: bool,
    text: String,
}

fn adapter_version_args(adapter_id: &str) -> &'static [&'static str] {
    match adapter_id {
        "claude" => &["-v"],
        _ => &["--version"],
    }
}

fn adapter_auth_args(adapter_id: &str) -> Option<&'static [&'static str]> {
    match adapter_id {
        "claude" => Some(&["auth", "status", "--json"]),
        "codex" => Some(&["login", "status"]),
        "grok" => Some(&["auth", "status"]),
        _ => None,
    }
}

fn adapter_login_command(adapter_id: &str, binary: &str) -> Option<String> {
    let binary = shell_quote_arg(binary);
    match adapter_id {
        "claude" => Some(format!("{binary} auth login")),
        "codex" | "grok" => Some(format!("{binary} login")),
        _ => None,
    }
}

fn adapter_install_command(adapter_id: &str) -> Option<&'static str> {
    match adapter_id {
        "claude" => Some("curl -fsSL https://claude.ai/install.sh | bash"),
        "codex" => Some("curl -fsSL https://chatgpt.com/codex/install.sh | sh"),
        "grok" => Some("curl -fsSL https://x.ai/cli/install.sh | bash"),
        _ => None,
    }
}

fn adapter_install_url(adapter_id: &str) -> Option<&'static str> {
    match adapter_id {
        "claude" => Some("https://docs.anthropic.com/en/docs/claude-code/setup"),
        "codex" => Some("https://developers.openai.com/codex/cli"),
        "grok" => Some("https://docs.x.ai/build/overview"),
        _ => None,
    }
}

/// The provider's own update command, run through `binary`. Only Claude Code
/// has one (`claude update`, which updates the installation it is run from).
/// Codex has none: a package-manager command such as `npm install -g` would
/// update an npm installation that need not be the one Session launches, so
/// no update command is offered and the setup guide asks the user to update
/// it the way it was installed.
fn adapter_update_command(adapter_id: &str, binary: &str) -> Option<String> {
    let binary = shell_quote_arg(binary);
    match adapter_id {
        "claude" => Some(format!("{binary} update")),
        _ => None,
    }
}

fn run_adapter_probe(binary: &str, args: &[&str]) -> Result<ProbeOutput, String> {
    let command = format!("{binary} {}", args.join(" "));
    let mut process = Command::new(binary);
    process.args(args);
    run_adapter_probe_command(process, &command)
}

fn run_adapter_probe_command(mut process: Command, command: &str) -> Result<ProbeOutput, String> {
    let mut child = process
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to run `{command}`: {err}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("`{command}` stdout was not piped"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("`{command}` stderr was not piped"))?;
    let stdout_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.take(64 * 1024).read_to_end(&mut bytes);
        bytes
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.take(64 * 1024).read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!("`{command}` timed out"));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!("failed to wait for `{command}`: {err}"));
            }
        }
    };
    let mut bytes = stdout_reader.join().unwrap_or_default();
    bytes.extend(stderr_reader.join().unwrap_or_default());
    Ok(ProbeOutput {
        success: status.success(),
        text: String::from_utf8_lossy(&bytes).trim().to_string(),
    })
}

fn first_probe_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| {
            line.chars()
                .filter(|character| !character.is_control())
                .take(160)
                .collect()
        })
}

fn classify_auth(adapter_id: &str, output: &ProbeOutput) -> AdapterAuthState {
    if adapter_id == "claude"
        && let Ok(value) = serde_json::from_str::<Value>(&output.text)
        && let Some(authenticated) = value
            .get("loggedIn")
            .or_else(|| value.get("authenticated"))
            .and_then(Value::as_bool)
    {
        return if authenticated {
            AdapterAuthState::Authenticated
        } else {
            AdapterAuthState::Unauthenticated
        };
    }
    let text = output.text.to_ascii_lowercase();
    if text.contains("not logged in")
        || text.contains("not authenticated")
        || text.contains("unauthenticated")
        || text.contains("login required")
        || text.contains("no credentials")
    {
        return AdapterAuthState::Unauthenticated;
    }
    if output.success
        && (text.contains("logged in")
            || text.contains("authenticated")
            || text.contains("authentication: valid"))
    {
        return AdapterAuthState::Authenticated;
    }
    AdapterAuthState::Unknown
}

/// The sign-in state an auth probe establishes, and why it is inconclusive
/// when it is. A probe that fails to run, or whose output is not recognized,
/// leaves the state `Unknown`: neither signed in nor signed out.
fn auth_probe_result(
    adapter_id: &str,
    args: &[&str],
    probe: Result<ProbeOutput, String>,
) -> (AdapterAuthState, Option<String>) {
    match probe {
        Ok(output) => match classify_auth(adapter_id, &output) {
            AdapterAuthState::Unknown => (
                AdapterAuthState::Unknown,
                Some(format!(
                    "`{} {}` returned a result Session does not recognize{}.",
                    adapter_id,
                    args.join(" "),
                    if output.success {
                        ""
                    } else {
                        " and exited with an error"
                    }
                )),
            ),
            state => (state, None),
        },
        Err(err) => (
            AdapterAuthState::Unknown,
            Some(format!("The sign-in status check failed: {err}.")),
        ),
    }
}

fn probe_adapter_metadata(mut metadata: AdapterMetadata) -> AdapterMetadata {
    metadata.checked_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok());
    let Some(binary) = metadata.resolved_binary.clone() else {
        return metadata;
    };
    let version_output = match run_adapter_probe(&binary, adapter_version_args(&metadata.id)) {
        Ok(output) if output.success => output,
        Ok(output) => {
            metadata.readiness = AdapterReadiness::Error;
            metadata.research_readiness = AdapterReadiness::Error;
            metadata.message = Some(
                first_probe_line(&output.text)
                    .unwrap_or_else(|| format!("{} version check failed", metadata.label)),
            );
            return metadata;
        }
        Err(err) => {
            metadata.readiness = AdapterReadiness::Error;
            metadata.research_readiness = AdapterReadiness::Error;
            metadata.message = Some(err);
            return metadata;
        }
    };
    metadata.version = first_probe_line(&version_output.text);
    metadata.message = None;

    if metadata.id == "claude"
        && let Some(version) = crate::claude_sdk::parse_claude_version(&version_output.text)
        && !version.meets_floor()
    {
        metadata.research_readiness = AdapterReadiness::UnsupportedVersion;
        metadata.message = Some(format!(
            "Claude Code {} is installed, but Research requires 2.1.0 or newer.",
            version.display()
        ));
    }

    if let Some(args) = adapter_auth_args(&metadata.id) {
        let probe = run_adapter_probe(&binary, args);
        (metadata.auth, metadata.auth_detail) = auth_probe_result(&metadata.id, args, probe);
        if metadata.auth == AdapterAuthState::Unauthenticated {
            metadata.readiness = AdapterReadiness::NeedsAuth;
            metadata.research_readiness = AdapterReadiness::NeedsAuth;
            metadata.message = metadata.login_command.as_ref().map(|command| {
                format!(
                    "{} is not signed in. Run `{command}` and check again.",
                    metadata.label
                )
            });
        }
    }
    metadata
}

/// Runs provider probes concurrently so one slow CLI consumes only its own
/// timeout rather than serially delaying every status card and launcher.
struct AdapterProbeCacheEntry {
    stored_at: Instant,
    metadata: Vec<AdapterMetadata>,
}

static ADAPTER_PROBE_CACHE: OnceLock<Mutex<HashMap<String, AdapterProbeCacheEntry>>> =
    OnceLock::new();
const ADAPTER_PROBE_CACHE_TTL: Duration = Duration::from_secs(30);

fn adapter_probe_cache() -> &'static Mutex<HashMap<String, AdapterProbeCacheEntry>> {
    ADAPTER_PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn adapter_probe_cache_key(metadata: &[AdapterMetadata]) -> String {
    format!(
        "local\n{}",
        metadata
            .iter()
            .map(|adapter| format!("{}={}", adapter.id, adapter.configured_binary))
            .collect::<Vec<_>>()
            .join("\n")
    )
}

fn cached_adapter_metadata(key: &str) -> Option<Vec<AdapterMetadata>> {
    let cache = adapter_probe_cache().lock().ok()?;
    let entry = cache.get(key)?;
    (entry.stored_at.elapsed() <= ADAPTER_PROBE_CACHE_TTL).then(|| entry.metadata.clone())
}

pub fn probe_adapter_metadata_for_config(
    config: &SessionConfig,
    force: bool,
) -> Result<Vec<AdapterMetadata>, String> {
    let base = adapter_registry(config).metadata();
    let key = adapter_probe_cache_key(&base);
    if !force && let Some(metadata) = cached_adapter_metadata(&key) {
        return Ok(metadata);
    }

    let handles = base
        .into_iter()
        .map(|metadata| {
            let fallback = metadata.clone();
            let handle = std::thread::spawn(move || probe_adapter_metadata(metadata));
            (fallback, handle)
        })
        .collect::<Vec<_>>();
    let metadata: Vec<AdapterMetadata> = handles
        .into_iter()
        .map(|(fallback, handle)| handle.join().unwrap_or(fallback))
        .collect();
    if let Ok(mut cache) = adapter_probe_cache().lock() {
        cache.insert(
            key,
            AdapterProbeCacheEntry {
                stored_at: Instant::now(),
                metadata: metadata.clone(),
            },
        );
    }
    Ok(metadata)
}

pub fn ensure_adapter_ready_for_research(
    config: &SessionConfig,
    adapter_id: &str,
) -> Result<AdapterMetadata, String> {
    let metadata = probe_adapter_metadata_for_config(config, false)?
        .into_iter()
        .find(|metadata| metadata.id == adapter_id)
        .ok_or_else(|| format!("unknown agent adapter '{adapter_id}'"))?;
    if metadata.research_readiness == AdapterReadiness::Ready {
        Ok(metadata)
    } else {
        Err(metadata
            .message
            .clone()
            .unwrap_or_else(|| format!("{} is not ready to run Research.", metadata.label)))
    }
}

pub fn adapter_registry(config: &SessionConfig) -> AdapterRegistry {
    AdapterRegistry::new(vec![
        Box::new(ClaudeAdapter::new(config)),
        Box::new(CodexAdapter::new(config)),
        Box::new(GrokAdapter::new(config)),
    ])
}

pub(crate) fn ensure_on_path(binary: &str) -> Option<PathBuf> {
    let binary_path = Path::new(binary);
    if binary_path.components().count() > 1 {
        return binary_path.is_file().then(|| binary_path.to_path_buf());
    }

    crate::launch_path::resolve_binary(binary)
}

pub fn adapter_supports_research(config: &SessionConfig, adapter_id: &str) -> bool {
    adapter_registry(config)
        .get(adapter_id)
        .is_ok_and(|adapter| adapter.supports_research())
}

/// Mints a random v4 UUID: Grok research and metadata session ids, scratch
/// file names and recap ids.
pub(crate) fn new_uuid_v4() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|err| format!("OS CSPRNG unavailable; cannot mint a session id: {err}"))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

/// The adapter used when research must launch a run without an explicit
/// choice — a follow-up on a document, which has no adapter of its own. The
/// default adapter when it is ready for research (the new run's own follow-ups
/// branch from its session), else the first research-ready adapter. The
/// frontend mirrors this preference to resolve adapter-specific composer
/// affordances.
pub fn default_fork_adapter(config: &SessionConfig) -> Result<String, String> {
    let base = adapter_registry(config).metadata();
    let key = adapter_probe_cache_key(&base);
    let metadata = cached_adapter_metadata(&key).unwrap_or(base);
    metadata
        .iter()
        .find(|adapter| {
            adapter.default
                && adapter.supports_research
                && adapter.research_readiness == AdapterReadiness::Ready
        })
        .or_else(|| {
            metadata.iter().find(|adapter| {
                adapter.supports_research && adapter.research_readiness == AdapterReadiness::Ready
            })
        })
        .map(|adapter| adapter.id.clone())
        .ok_or_else(|| "no installed agent supports research follow-ups".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, GrokAdapterConfig,
    };
    use std::path::PathBuf;

    fn test_config() -> SessionConfig {
        SessionConfig {
            workspace_root: PathBuf::from("/tmp/session-adapter-tests"),
            socket_path: PathBuf::from("/tmp/session-adapter-tests.sock"),
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
        }
    }

    #[test]
    fn registry_rejects_unknown_adapter() {
        let registry = adapter_registry(&test_config());

        let err = match registry.get("missing") {
            Ok(_) => panic!("missing adapter should be rejected"),
            Err(err) => err,
        };

        assert_eq!(err, "unknown agent adapter 'missing'");
    }

    #[test]
    fn runtime_metadata_marks_claude_as_default() {
        let registry = adapter_registry(&test_config());

        let metadata = registry.metadata();
        assert_eq!(metadata.len(), 3);
        assert_eq!(metadata[0].id, "claude");
        assert!(metadata[0].default);
        assert_eq!(metadata[1].id, "codex");
        assert!(!metadata[1].default);
        assert_eq!(metadata[2].id, "grok");
        assert!(!metadata[2].default);
        assert!(
            metadata
                .iter()
                .all(|adapter| adapter.target.kind == "local")
        );
        let config = test_config();
        assert!(adapter_supports_research(&config, "claude"));
        assert!(adapter_supports_research(&config, "codex"));
        assert!(adapter_supports_research(&config, "grok"));
        assert!(
            metadata
                .iter()
                .filter(|adapter| matches!(adapter.id.as_str(), "claude" | "codex" | "grok"))
                .all(|adapter| adapter.supports_recap_generation)
        );
    }

    #[test]
    fn runtime_metadata_reports_a_missing_configured_binary() {
        let mut config = test_config();
        config.adapters.claude.binary =
            Some("/definitely/missing/session-test-provider-binary".to_string());

        let metadata = adapter_registry(&config).metadata();
        let claude = metadata
            .iter()
            .find(|adapter| adapter.id == "claude")
            .expect("claude metadata");
        assert_eq!(
            claude.configured_binary,
            "/definitely/missing/session-test-provider-binary"
        );
        assert_eq!(claude.resolved_binary, None);
        assert_eq!(claude.readiness, AdapterReadiness::Missing);
        assert!(
            claude
                .message
                .as_deref()
                .is_some_and(|message| { message.contains("Claude was not found") })
        );
    }

    #[test]
    fn update_commands_target_the_resolved_executable_or_are_omitted() {
        let mut config = test_config();
        // Any executable stands in for an installed CLI here.
        config.adapters.claude.binary = Some("/bin/sh".to_string());
        let metadata = adapter_registry(&config).metadata();
        let claude = metadata
            .iter()
            .find(|adapter| adapter.id == "claude")
            .expect("claude metadata");
        let resolved = claude.resolved_binary.as_deref().expect("/bin/sh resolves");
        assert_eq!(
            claude.update_command.as_deref(),
            Some(format!("{} update", shell_quote_arg(resolved)).as_str())
        );
        // No updater is known to own a Codex installation, so none is offered
        // (in particular, not an npm command for a standalone install).
        let codex = metadata
            .iter()
            .find(|adapter| adapter.id == "codex")
            .expect("codex metadata");
        assert_eq!(codex.update_command, None);
    }

    #[test]
    fn auth_probe_requires_definitive_status_evidence() {
        assert_eq!(
            classify_auth(
                "claude",
                &ProbeOutput {
                    success: true,
                    text: r#"{"loggedIn":true}"#.to_string(),
                },
            ),
            AdapterAuthState::Authenticated
        );
        assert_eq!(
            classify_auth(
                "codex",
                &ProbeOutput {
                    success: false,
                    text: "Not logged in".to_string(),
                },
            ),
            AdapterAuthState::Unauthenticated
        );
        // Custom providers and older CLIs can reject the probe command even
        // while their environment credentials work. Do not turn ambiguity
        // into a false sign-out gate.
        assert_eq!(
            classify_auth(
                "grok",
                &ProbeOutput {
                    success: false,
                    text: "unknown command: auth".to_string(),
                },
            ),
            AdapterAuthState::Unknown
        );
    }

    #[test]
    fn an_inconclusive_auth_probe_stays_unknown_and_says_why() {
        let args: &[&str] = &["login", "status"];
        // A definitive result needs no explanation.
        assert_eq!(
            auth_probe_result(
                "codex",
                args,
                Ok(ProbeOutput {
                    success: true,
                    text: "Logged in using ChatGPT".to_string(),
                }),
            ),
            (AdapterAuthState::Authenticated, None)
        );
        // Unrecognized output is not a sign-in, and its text (which can name
        // the account) is not repeated in the explanation.
        let (auth, detail) = auth_probe_result(
            "codex",
            args,
            Ok(ProbeOutput {
                success: false,
                text: "profile user@example.com: status unavailable".to_string(),
            }),
        );
        assert_eq!(auth, AdapterAuthState::Unknown);
        let detail = detail.expect("unknown results include diagnostic detail");
        assert!(detail.contains("`codex login status`"), "{detail}");
        assert!(detail.contains("exited with an error"), "{detail}");
        assert!(!detail.contains("user@example.com"), "{detail}");
        // A probe that could not run is inconclusive too, not a failure of
        // the CLI or a sign-out.
        let (auth, detail) = auth_probe_result(
            "codex",
            args,
            Err("`codex login status` timed out".to_string()),
        );
        assert_eq!(auth, AdapterAuthState::Unknown);
        assert_eq!(
            detail.as_deref(),
            Some("The sign-in status check failed: `codex login status` timed out.")
        );
    }
}
