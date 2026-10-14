use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub agent_id: String,
    pub session_id: Option<String>,
    pub role: String,
    pub blocks: Vec<TurnBlock>,
    pub source_index: usize,
    /// Milliseconds since the Unix epoch when the native transcript recorded
    /// this turn; None for adapters or records without time data (and for
    /// transcripts persisted before the field existed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<TurnStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_reason: Option<TurnStatusReason>,
    /// Whether this record is still part of the context Codex will reconstruct
    /// for the next turn. This is deliberately independent from `status`: an
    /// interrupted response can remain visible while a later rollback excludes
    /// its whole user-turn segment from active model context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_status: Option<TurnContextStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_native_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_message_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatus {
    Superseded,
    Interrupted,
    Uncertain,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatusReason {
    CodexRollback,
    Interrupted,
    ClaudePromptBranch,
    UnknownBranch,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnContextStatus {
    RolledBack,
}

/// A block of one turn, as the frontend receives it.
///
/// Both `rename_all` settings are load-bearing and easy to confuse: on an enum,
/// `rename_all` renames the *variants* (so the `type` tag reads `toolResult`),
/// while `rename_all_fields` renames the fields *inside* variants. Without the
/// latter, struct-variant fields keep their Rust spelling — which is what
/// happened here: `toolResult` shipped with `tool_use_id`/`is_error` while
/// `TurnBlock` in `src/types.ts` had always declared `toolUseId`/`isError`. The
/// frontend therefore never paired a tool result with its call and never
/// rendered a tool error as one.
///
/// The `alias` attributes are the migration: `ThreadRecord` embeds these blocks
/// and is persisted, so every session recorded before this fix has the old
/// spelling on disk. Serialization now emits camelCase only; deserialization
/// accepts both, forever, because those files are never rewritten.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum TurnBlock {
    Text {
        text: String,
    },
    ToolUse {
        id: Option<String>,
        name: String,
        input: Value,
    },
    ToolResult {
        #[serde(alias = "tool_use_id")]
        tool_use_id: Option<String>,
        content: Value,
        #[serde(alias = "is_error")]
        is_error: bool,
    },
    Raw {
        value: Value,
    },
}

pub(crate) fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

/// Strips session-injected tagged instruction blocks from the front of a user
/// message, mirroring `stripLeadingTaggedInstructionBlocks` in
/// web/packages/shared/src/app/taggedInstructions.ts: repeated `# `-labelled prefix lines and
/// line-structured `<tag>…</tag>` blocks (depth-matched) are removed until
/// real content is reached. Returns `None` when nothing but instruction
/// blocks remain. Narrower than the frontend on purpose — only whole-line
/// tags are recognized, so a message merely *containing* markup is kept
/// rather than over-stripped. Tests use it to check that injected blocks,
/// such as the research launch instruction, strip as one leading block.
#[cfg(test)]
pub(crate) fn strip_leading_tagged_instruction_blocks(text: &str) -> Option<&str> {
    let mut current = text;
    let mut removed = false;
    loop {
        let Some(content_start) = tagged_instruction_content_start(current) else {
            // Only `# ` label lines or blank lines remain. If blocks were
            // stripped, those labels belonged to them; otherwise the message
            // was headings all along and stays as it is.
            return if removed { None } else { Some(current) };
        };
        let content = &current[content_start..];
        let first_line_end = content.find('\n').unwrap_or(content.len());
        let first_line =
            trim_horizontal_whitespace(strip_trailing_carriage_return(&content[..first_line_end]));
        if parse_inline_tag(first_line).is_some() {
            let cut = content_start + first_line_end;
            current = current.get(cut + 1..).unwrap_or("");
            removed = true;
            continue;
        }
        let Some(opening_tag) = parse_opening_tag(first_line) else {
            // Real content: keep the remainder as-is, including any `# ` lines
            // before it — headings are content when no block follows them.
            return Some(current);
        };
        let mut depth = 1usize;
        let mut cursor = content_start + first_line_end;
        let mut block_end = None;
        while cursor < current.len() {
            let line_start = cursor + 1;
            let line_end = current[line_start..]
                .find('\n')
                .map(|index| line_start + index)
                .unwrap_or(current.len());
            let line = trim_horizontal_whitespace(strip_trailing_carriage_return(
                &current[line_start..line_end],
            ));
            if parse_opening_tag(line) == Some(opening_tag) {
                depth += 1;
            } else if parse_closing_tag(line) == Some(opening_tag) {
                depth -= 1;
                if depth == 0 {
                    block_end = Some(line_end);
                    break;
                }
            }
            cursor = line_end;
        }
        // An unterminated block is content, not an instruction wrapper.
        let Some(block_end) = block_end else {
            return Some(current);
        };
        current = current.get(block_end + 1..).unwrap_or("");
        removed = true;
    }
}

#[cfg(test)]
fn tagged_instruction_content_start(text: &str) -> Option<usize> {
    let mut start = 0;
    while start < text.len() {
        let line_end = text[start..]
            .find('\n')
            .map(|index| start + index)
            .unwrap_or(text.len());
        let line = strip_trailing_carriage_return(&text[start..line_end]);
        if !is_tagged_instruction_prefix_line(line) {
            return Some(start);
        }
        if line_end == text.len() {
            return None;
        }
        start = line_end + 1;
    }
    None
}

#[cfg(test)]
fn is_tagged_instruction_prefix_line(line: &str) -> bool {
    line.starts_with("# ") || trim_horizontal_whitespace(line).is_empty()
}

#[cfg(test)]
fn strip_trailing_carriage_return(value: &str) -> &str {
    value.strip_suffix('\r').unwrap_or(value)
}

#[cfg(test)]
fn trim_horizontal_whitespace(value: &str) -> &str {
    value.trim_matches(|char: char| char != '\n' && char != '\r' && char.is_whitespace())
}

#[cfg(test)]
fn parse_inline_tag(line: &str) -> Option<&str> {
    if line.len() < 7 || !line.starts_with('<') {
        return None;
    }
    let opening_end = line.find('>')?;
    if opening_end < 2 {
        return None;
    }
    let tag = &line[1..opening_end];
    if !is_instruction_tag_name(tag) {
        return None;
    }
    let closing = format!("</{tag}>");
    line.ends_with(&closing).then_some(tag)
}

#[cfg(test)]
fn parse_opening_tag(line: &str) -> Option<&str> {
    if line.len() < 3 || !line.starts_with('<') || !line.ends_with('>') {
        return None;
    }
    let tag = &line[1..line.len() - 1];
    if tag == r#"session_instruction source="agent_driver""# {
        return Some("session_instruction");
    }
    is_instruction_tag_name(tag).then_some(tag)
}

#[cfg(test)]
fn parse_closing_tag(line: &str) -> Option<&str> {
    if line.len() < 4 || !line.starts_with("</") || !line.ends_with('>') {
        return None;
    }
    let tag = &line[2..line.len() - 1];
    is_instruction_tag_name(tag).then_some(tag)
}

#[cfg(test)]
fn is_instruction_tag_name(tag: &str) -> bool {
    !tag.is_empty()
        && tag
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || char == '_' || char == '-')
}

/// Parses an RFC3339 timestamp ("2026-07-17T09:30:12.345Z", offset forms
/// included) to milliseconds since the Unix epoch. Hand-rolled so transcript
/// parsing stays dependency-free; anything unparseable yields None.
pub(crate) fn rfc3339_to_epoch_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        let slice = text.get(range)?;
        if !slice.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        slice.parse::<i64>().ok()
    };
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || !matches!(bytes.get(10), Some(&b'T' | &b't' | &b' '))
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return None;
    }
    let year = digits(0..4)?;
    let month = digits(5..7)?;
    let day = digits(8..10)?;
    let hour = digits(11..13)?;
    let minute = digits(14..16)?;
    let second = digits(17..19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }
    // Leap seconds ("…:60Z") clamp to the following second rather than failing.
    let second = second.min(60);

    let mut index = 19;
    let mut millis = 0i64;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index == start {
            return None;
        }
        // Millisecond precision: pad short fractions, truncate long ones.
        let fraction = &text[start..index.min(start + 3)];
        let mut value = fraction.parse::<i64>().ok()?;
        for _ in fraction.len()..3 {
            value *= 10;
        }
        millis = value;
    }
    let offset_minutes = match bytes.get(index) {
        Some(&b'Z' | &b'z') if index + 1 == bytes.len() => 0,
        Some(sign @ (&b'+' | &b'-')) => {
            if bytes.get(index + 3) != Some(&b':') || index + 6 != bytes.len() {
                return None;
            }
            let hours = digits(index + 1..index + 3)?;
            let minutes = digits(index + 4..index + 6)?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            (if *sign == b'+' { 1 } else { -1 }) * (hours * 60 + minutes)
        }
        _ => return None,
    };

    // Days-from-civil (Howard Hinnant): Gregorian date to days since the epoch.
    let adjusted_year = if month <= 2 { year - 1 } else { year };
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let year_of_era = adjusted_year - era * 400;
    let month_index = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;

    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1_000 + millis)
}

#[cfg(test)]
mod timestamp_tests {
    use super::rfc3339_to_epoch_ms;

    #[test]
    fn parses_utc_with_and_without_fraction() {
        assert_eq!(rfc3339_to_epoch_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(rfc3339_to_epoch_ms("1970-01-01T00:00:00.250Z"), Some(250));
        // 2026-07-17T09:30:12.345Z, cross-checked against `date -d ... +%s`.
        assert_eq!(
            rfc3339_to_epoch_ms("2026-07-17T09:30:12.345Z"),
            Some(1_784_280_612_345)
        );
        // Fractions pad and truncate to millisecond precision.
        assert_eq!(rfc3339_to_epoch_ms("1970-01-01T00:00:00.5Z"), Some(500));
        assert_eq!(
            rfc3339_to_epoch_ms("1970-01-01T00:00:00.123456Z"),
            Some(123)
        );
    }

    #[test]
    fn honors_numeric_offsets() {
        assert_eq!(
            rfc3339_to_epoch_ms("1970-01-01T02:00:00+02:00"),
            Some(0),
            "positive offsets subtract"
        );
        assert_eq!(
            rfc3339_to_epoch_ms("1969-12-31T19:00:00-05:00"),
            Some(0),
            "negative offsets add"
        );
    }

    #[test]
    fn rejects_malformed_inputs() {
        for input in [
            "",
            "not a date",
            "2026-07-17",
            "2026-07-17T09:30",
            "2026-07-17T09:30:12",
            "2026-13-01T00:00:00Z",
            "2026-07-17T09:30:12.Z",
            "2026-07-17T09:30:12+0200",
            "2026-07-17T09:30:12Zextra",
        ] {
            assert_eq!(rfc3339_to_epoch_ms(input), None, "input: {input:?}");
        }
    }
}

#[cfg(test)]
mod append_tests {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool_result() -> TurnBlock {
        TurnBlock::ToolResult {
            tool_use_id: Some("call_1".to_string()),
            content: json!("ok"),
            is_error: true,
        }
    }

    /// The frontend's `TurnBlock` union in `src/types.ts` is the contract this
    /// has to satisfy. It went unmet for a long time because enum `rename_all`
    /// does not reach struct-variant fields, and nothing asserted the shape.
    #[test]
    fn strip_leading_tagged_instruction_blocks_mirrors_the_frontend_semantics() {
        // Whole-message block: nothing left.
        assert_eq!(
            strip_leading_tagged_instruction_blocks(
                "<system-reminder>\ninjected\n</system-reminder>"
            ),
            None
        );
        // Leading block followed by real content: the block goes, the
        // content stays.
        assert_eq!(
            strip_leading_tagged_instruction_blocks(
                "<system-reminder>\ninjected\n</system-reminder>\n\nReal question"
            ),
            Some("\nReal question")
        );
        // Repeated blocks with `# ` labels between them all strip together.
        assert_eq!(
            strip_leading_tagged_instruction_blocks(
                "# label\n<a-tag>\none\n</a-tag>\n# other\n<b-tag>\ntwo\n</b-tag>\nkept"
            ),
            Some("kept")
        );
        // Inline single-line tag blocks strip too.
        assert_eq!(
            strip_leading_tagged_instruction_blocks("<note>inline</note>\nkept"),
            Some("kept")
        );
        // Headings without a following block are content, kept intact.
        assert_eq!(
            strip_leading_tagged_instruction_blocks("# My heading\ncontent"),
            Some("# My heading\ncontent")
        );
        // An unterminated block is content, not an instruction wrapper.
        assert_eq!(
            strip_leading_tagged_instruction_blocks("<config>\nkey = value"),
            Some("<config>\nkey = value")
        );
        // The exact attributed Session driver block is trusted and stripped.
        assert_eq!(
            strip_leading_tagged_instruction_blocks(
                "<session_instruction source=\"agent_driver\">\nsafety\n</session_instruction>\nkept"
            ),
            Some("kept")
        );
        // Other tag lines with attributes are not instruction tags.
        assert_eq!(
            strip_leading_tagged_instruction_blocks("<ide_context file=\"a.rs\">\nbody"),
            Some("<ide_context file=\"a.rs\">\nbody")
        );
        // Nested same-name blocks are depth-matched like the frontend.
        assert_eq!(
            strip_leading_tagged_instruction_blocks("<t>\n<t>\ninner\n</t>\n</t>\nkept"),
            Some("kept")
        );
    }

    #[test]
    fn blocks_serialize_with_the_field_names_the_frontend_declares() {
        assert_eq!(
            serde_json::to_value(tool_result()).unwrap(),
            json!({
                "type": "toolResult",
                "toolUseId": "call_1",
                "content": "ok",
                "isError": true,
            })
        );
        assert_eq!(
            serde_json::to_value(TurnBlock::ToolUse {
                id: Some("call_1".to_string()),
                name: "Read".to_string(),
                input: json!({ "path": "/tmp/x" }),
            })
            .unwrap(),
            json!({ "type": "toolUse", "id": "call_1", "name": "Read", "input": { "path": "/tmp/x" } })
        );
        assert_eq!(
            serde_json::to_value(TurnBlock::Text {
                text: "hi".to_string()
            })
            .unwrap(),
            json!({ "type": "text", "text": "hi" })
        );
    }

    /// Thread records embed these blocks and are persisted, so sessions written
    /// before the rename still hold the old spelling. Those files are never
    /// rewritten; the aliases have to stay.
    #[test]
    fn blocks_recorded_before_the_rename_still_deserialize() {
        let legacy = json!({
            "type": "toolResult",
            "tool_use_id": "call_1",
            "content": "ok",
            "is_error": true,
        });
        assert_eq!(
            serde_json::from_value::<TurnBlock>(legacy).unwrap(),
            tool_result()
        );
    }

    #[test]
    fn blocks_round_trip_through_their_own_serialization() {
        for block in [
            tool_result(),
            TurnBlock::Text {
                text: "hi".to_string(),
            },
            TurnBlock::ToolUse {
                id: None,
                name: "Read".to_string(),
                input: Value::Null,
            },
            TurnBlock::Raw {
                value: json!({ "any": "thing" }),
            },
        ] {
            let encoded = serde_json::to_value(&block).unwrap();
            assert_eq!(
                serde_json::from_value::<TurnBlock>(encoded.clone()).unwrap(),
                block,
                "failed to round-trip {encoded}"
            );
        }
    }
}
