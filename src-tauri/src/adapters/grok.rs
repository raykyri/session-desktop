use super::{AgentAdapter, ensure_on_path};
use crate::config::SessionConfig;
use crate::transcript::{Turn, TurnBlock};
use serde_json::Value;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// Adapter for the xAI Grok Build CLI. Research runs start it headlessly (see
/// `research_runtime`); this adapter resolves its executable and finds and
/// parses the session transcripts Grok writes under its config home.
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

    fn parse_transcript_line(
        &self,
        agent_id: &str,
        source_index: usize,
        line: &str,
    ) -> Option<Turn> {
        parse_transcript_line(agent_id, source_index, line)
    }

    fn supports_research(&self) -> bool {
        true
    }
}

impl GrokAdapter {}

/// The Grok config home. Honors a `GROK_HOME` override (used by tests and unusual
/// installs); otherwise `~/.grok`, where Grok keeps its user settings and sessions.
fn grok_home() -> Result<PathBuf, String> {
    env::var_os("GROK_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".grok")))
        .ok_or_else(|| "GROK_HOME and HOME are not set; cannot locate Grok sessions".to_string())
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
    use serde_json::json;

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
}
