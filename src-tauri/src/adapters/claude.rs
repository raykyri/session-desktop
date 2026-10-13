use super::{AgentAdapter, ensure_on_path};
use crate::config::SessionConfig;
use crate::transcript::{Turn, TurnStatus, TurnStatusReason};

#[cfg(test)]
use crate::transcript::TurnBlock;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug)]
pub struct ClaudeAdapter {
    binary: String,
}

impl ClaudeAdapter {
    pub fn new(config: &SessionConfig) -> Self {
        Self {
            binary: config.claude_binary(),
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

impl ClaudeAdapter {}

fn parse_transcript_line(agent_id: &str, source_index: usize, line: &str) -> Option<Turn> {
    super::parse_claude_native_transcript_line(agent_id, source_index, line)
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

// Compatibility shim retained for the transcript parser tests.
#[cfg(test)]
fn parse_block(value: &Value) -> Option<TurnBlock> {
    super::parse_claude_native_block(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::TurnBlock;
    use serde_json::json;

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
}
