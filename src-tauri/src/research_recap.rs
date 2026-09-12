//! Optional derived metadata; generation never delays research completion.
use crate::research::{self, ResearchNodeStatus};
use crate::state::AppState;
use crate::transcript::{Turn, TurnBlock};
use pulldown_cmark::{Event, Parser, TagEnd};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

pub const MIN_RECAP_CHARS: usize = 800;
// Bound command-line and model input size. Oversized answers are skipped rather
// than summarized from a truncated excerpt that could omit their conclusion.
const MAX_SOURCE_BYTES: usize = 80_000;

static JOBS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct Job(String);
impl Drop for Job {
    fn drop(&mut self) {
        if let Ok(mut jobs) = JOBS.get_or_init(Default::default).lock() {
            jobs.remove(&self.0);
        }
    }
}

pub fn schedule(state: &AppState, node_id: &str) {
    // Unit tests exercise extraction, provider calls, and stale-result handling
    // separately; lifecycle fixtures must never launch installed, paid agents.
    if cfg!(test) {
        return;
    }
    let Ok(node) = state.research_node(node_id) else {
        return;
    };
    if !node.kind.is_run()
        || node.status != ResearchNodeStatus::Complete
        || node.response_snapshot_at.is_none()
        || node.recap.is_some()
        || !matches!(node.adapter.as_str(), "claude" | "codex" | "grok")
    {
        return;
    }
    let key = format!(
        "{}:{}:{:?}",
        state.config().workspace_root.display(),
        node.id,
        node.response_snapshot_at
    );
    let Ok(mut jobs) = JOBS.get_or_init(Default::default).lock() else {
        return;
    };
    if !jobs.insert(key.clone()) {
        return;
    }
    drop(jobs);
    let state = state.clone();
    std::thread::spawn(move || {
        let _job = Job(key);
        let result = (|| -> Result<(), String> {
            let Some(snapshot) = research::read_response_snapshot_with_revision(
                &state.config().workspace_root,
                &node.id,
            )?
            else {
                return Ok(());
            };
            let Some(answer) = recap_source(&snapshot.turns) else {
                return Ok(());
            };
            if answer.len() + node.prompt.len() > MAX_SOURCE_BYTES {
                return Ok(());
            }
            let workspace = state.research_workspace_for_node(&node.id)?;
            let text = crate::title_generation::generate_research_recap(
                state.config(),
                &node,
                &workspace,
                &answer,
            )?;
            state.save_research_recap(&node, &snapshot.revision, text)
        })();
        if let Err(err) = result {
            eprintln!("qmux: recap generation failed for {}: {err}", node.id);
        }
    });
}

/// Select assistant prose after the last tool activity. Keep the most recent
/// text group as a fallback for a trailing housekeeping tool, like the UI fold.
/// Raw reasoning blocks and user/tool payloads never enter the summarizer.
pub fn recap_source(turns: &[Turn]) -> Option<String> {
    let mut text = Vec::new();
    let mut fallback = Vec::new();
    for turn in turns
        .iter()
        .filter(|turn| research::turn_is_in_active_context(turn))
    {
        for block in &turn.blocks {
            match block {
                TurnBlock::Text { text: value }
                    if turn.role == "assistant" && !value.trim().is_empty() =>
                {
                    text.push(value.as_str());
                }
                TurnBlock::ToolUse { .. } | TurnBlock::ToolResult { .. } => {
                    if !text.is_empty() {
                        fallback = std::mem::take(&mut text);
                    }
                }
                _ => {}
            }
        }
    }
    let markdown = if text.is_empty() { fallback } else { text }.join("\n\n");
    let plain = plain_text(&markdown);
    (plain.chars().count() >= MIN_RECAP_CHARS && plain.len() <= MAX_SOURCE_BYTES).then_some(plain)
}

fn plain_text(markdown: &str) -> String {
    let mut plain = String::new();
    for event in Parser::new(markdown) {
        match event {
            Event::Text(text) | Event::Code(text) => plain.push_str(&text),
            Event::SoftBreak
            | Event::HardBreak
            | Event::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::CodeBlock
                | TagEnd::Item
                | TagEnd::TableCell,
            ) => plain.push(' '),
            _ => {}
        }
    }
    plain.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn normalize_recap(raw: &str) -> Option<String> {
    let plain = plain_text(raw);
    let text = plain
        .strip_prefix("Summary:")
        .or_else(|| plain.strip_prefix("summary:"))
        .unwrap_or(&plain)
        .trim();
    // Reject runaway output rather than cutting a caveat mid-sentence.
    (!text.is_empty() && text.chars().count() <= 1_200).then(|| text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(role: &str, blocks: Vec<TurnBlock>) -> Turn {
        serde_json::from_value(serde_json::json!({
            "id": "test", "agentId": "test", "role": role,
            "blocks": blocks, "sourceIndex": 0,
        }))
        .unwrap()
    }
    fn text(value: &str) -> TurnBlock {
        TurnBlock::Text { text: value.into() }
    }

    #[test]
    fn cutoff_counts_visible_unicode_text_not_link_targets_or_markup() {
        assert!(recap_source(&[turn("assistant", vec![text(&"é".repeat(799))])]).is_none());
        assert!(
            recap_source(&[turn(
                "assistant",
                vec![text(&format!("**{}**", "é".repeat(800)))]
            )])
            .is_some()
        );
        assert!(
            recap_source(&[turn(
                "assistant",
                vec![text(&format!(
                    "[short](https://example.com/{})",
                    "x".repeat(1000)
                ))]
            )])
            .is_none()
        );
    }

    #[test]
    fn source_excludes_prompt_reasoning_and_tool_activity() {
        let tool = TurnBlock::ToolUse {
            id: None,
            name: "search".into(),
            input: serde_json::json!({}),
        };
        let answer = "Final answer. ".repeat(70).trim().to_string();
        let turns = vec![
            turn("user", vec![text(&"question".repeat(200))]),
            turn(
                "assistant",
                vec![text(&"commentary".repeat(200)), tool.clone()],
            ),
            turn(
                "assistant",
                vec![
                    TurnBlock::Raw {
                        value: serde_json::json!({"thinking": "private reasoning"}),
                    },
                    text(&answer),
                ],
            ),
        ];
        assert_eq!(recap_source(&turns), Some(answer.clone()));
        let mut trailing = turns;
        trailing.push(turn("assistant", vec![tool]));
        assert_eq!(recap_source(&trailing), Some(answer));
    }

    #[test]
    fn recap_is_plain_and_bounded() {
        assert_eq!(
            normalize_recap("**Summary:** *Read Cusk.*\nThen [Heti](https://example.com)."),
            Some("Read Cusk. Then Heti.".into())
        );
        assert!(normalize_recap(" \n ").is_none());
        assert!(normalize_recap(&"x".repeat(1201)).is_none());
    }
}
