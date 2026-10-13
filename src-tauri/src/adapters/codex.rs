use super::{AgentAdapter, ensure_on_path};
use crate::config::SessionConfig;
use crate::transcript::{
    Turn, TurnBlock, TurnContextStatus, TurnStatus, TurnStatusReason, string_field,
};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const CODEX_CODE_MODE_HOST: &str = "codex-code-mode-host";

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

    fn parse_transcript_line(
        &self,
        agent_id: &str,
        source_index: usize,
        line: &str,
    ) -> Option<Turn> {
        parse_transcript_line(agent_id, source_index, line)
    }

    fn resolve_transcript_turns(
        &self,
        agent_id: &str,
        source_index_offset: usize,
        lines: &[String],
    ) -> Vec<Turn> {
        resolve_transcript_turns_from(agent_id, source_index_offset, lines)
    }

    fn supports_research(&self) -> bool {
        true
    }
}

impl CodexAdapter {}

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
    use serde_json::json;
    use std::env;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

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
