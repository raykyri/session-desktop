//! Moves highlight and branch anchors to an edited text by their quote.
//!
//! An anchor (`ResearchHighlightAnchor`) is captured from the rendered text of
//! an answer: `exact` is the selected passage, `prefix` and `suffix` the text
//! around it, and `start`/`end` its UTF-16 offsets in that rendered text. When
//! a document's Markdown or a post's text is replaced, each anchor is looked
//! up in the old and in the new source by its quote. The comparison ignores
//! everything but letters and digits, so Markdown syntax (`**`, `#`, list
//! markers, line breaks) on either side of a rendered quote does not prevent a
//! match.
//!
//! The lookup in one text:
//!   1. Every occurrence of the quote is a candidate.
//!   2. Candidates whose prefix and suffix both agree (the last and first
//!      `CONTEXT_CHARS` characters of each side) win; the one nearest the
//!      expected offset is chosen, ties going to the earlier one.
//!   3. Otherwise a single candidate that keeps one side is chosen.
//!   4. Otherwise there is no match.
//!
//! The outcome for an anchor:
//!   - no letters or digits in the quote, or no match in the old text: the
//!     anchor is left as it is (nothing in the source identifies it, so the
//!     edit is not taken to have removed it);
//!   - a match in the old text and in the new text: the anchor moves by the
//!     distance between the two matches;
//!   - a match in the old text only: the quote no longer matches.
//!
//! src/lib/researchAnchors.ts implements the same rules for the editor's
//! notice; tests/researchAnchors.test.ts and the tests below pin shared cases.

use crate::research::{ResearchHighlight, ResearchHighlightAnchor};

/// Characters of normalized context compared on each side of a quote.
pub const CONTEXT_CHARS: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AnchorOutcome {
    /// Nothing in the old text identifies the quote; the anchor is kept as is.
    Unchanged,
    /// The quote is found in the new text: the anchor's new offsets.
    Moved { start: usize, end: usize },
    /// The quote was in the old text and is not in the new text.
    Unmatched,
}

/// Letters and digits of a text, with the UTF-16 offset of each in the
/// original text.
struct Normalized {
    text: String,
    /// Byte index in `text` of each character, in order.
    char_bytes: Vec<usize>,
    /// UTF-16 offset in the original text of each character.
    utf16: Vec<usize>,
}

impl Normalized {
    fn new(source: &str) -> Self {
        let mut text = String::new();
        let mut char_bytes = Vec::new();
        let mut utf16 = Vec::new();
        let mut offset = 0usize;
        for character in source.chars() {
            if character.is_alphanumeric() {
                char_bytes.push(text.len());
                utf16.push(offset);
                text.push(character);
            }
            offset += character.len_utf16();
        }
        Self {
            text,
            char_bytes,
            utf16,
        }
    }

    fn utf16_at(&self, byte: usize) -> usize {
        let index = self
            .char_bytes
            .binary_search(&byte)
            .expect("matches start on a character boundary");
        self.utf16[index]
    }
}

fn normalized(text: &str) -> String {
    text.chars()
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn last_chars(text: &str, count: usize) -> &str {
    let skip = text.chars().count().saturating_sub(count);
    text.char_indices()
        .nth(skip)
        .map_or("", |(index, _)| &text[index..])
}

fn first_chars(text: &str, count: usize) -> &str {
    text.char_indices()
        .nth(count)
        .map_or(text, |(index, _)| &text[..index])
}

/// The UTF-16 offset in `haystack`'s source of the occurrence of `quote`
/// chosen by the rules in the module comment, or None.
fn locate(
    haystack: &Normalized,
    quote: &str,
    prefix: &str,
    suffix: &str,
    near: usize,
) -> Option<usize> {
    let text = haystack.text.as_str();
    let mut best: Option<(usize, usize)> = None;
    let mut loose: Option<usize> = None;
    let mut loose_count = 0usize;
    let mut from = 0usize;
    while let Some(found) = text[from..].find(quote) {
        let at = from + found;
        let prefix_matches = prefix.is_empty() || text[..at].ends_with(prefix);
        let suffix_matches = suffix.is_empty() || text[at + quote.len()..].starts_with(suffix);
        let offset = haystack.utf16_at(at);
        if prefix_matches && suffix_matches {
            let distance = offset.abs_diff(near);
            if best.is_none_or(|(_, best_distance)| distance < best_distance) {
                best = Some((offset, distance));
            }
        } else if prefix_matches || suffix_matches {
            loose = Some(offset);
            loose_count += 1;
        }
        let step = text[at..].chars().next().map_or(1, char::len_utf8);
        from = at + step;
    }
    match (best, loose_count) {
        (Some((offset, _)), _) => Some(offset),
        (None, 1) => loose,
        _ => None,
    }
}

/// Where `anchor` goes when `old_text` is replaced by `new_text`.
pub fn reanchor(anchor: &ResearchHighlightAnchor, old_text: &str, new_text: &str) -> AnchorOutcome {
    let quote = normalized(&anchor.exact);
    if quote.is_empty() {
        return AnchorOutcome::Unchanged;
    }
    let prefix_all = normalized(&anchor.prefix);
    let suffix_all = normalized(&anchor.suffix);
    let prefix = last_chars(&prefix_all, CONTEXT_CHARS);
    let suffix = first_chars(&suffix_all, CONTEXT_CHARS);
    let Some(old_offset) = locate(
        &Normalized::new(old_text),
        &quote,
        prefix,
        suffix,
        anchor.start,
    ) else {
        return AnchorOutcome::Unchanged;
    };
    let Some(new_offset) = locate(
        &Normalized::new(new_text),
        &quote,
        prefix,
        suffix,
        old_offset,
    ) else {
        return AnchorOutcome::Unmatched;
    };
    let length = anchor.end.saturating_sub(anchor.start);
    let start = if new_offset >= old_offset {
        anchor.start.saturating_add(new_offset - old_offset)
    } else {
        anchor.start.saturating_sub(old_offset - new_offset)
    };
    AnchorOutcome::Moved {
        start,
        end: start + length,
    }
}

/// Applies `outcome` to `anchor`: a moved anchor takes its new offsets and,
/// when given, the revision of the new text. Returns false when the quote no
/// longer matches.
pub fn apply_outcome(
    anchor: &mut ResearchHighlightAnchor,
    outcome: &AnchorOutcome,
    revision: Option<&str>,
) -> bool {
    match outcome {
        AnchorOutcome::Unchanged => true,
        AnchorOutcome::Moved { start, end } => {
            anchor.start = *start;
            anchor.end = *end;
            if let Some(revision) = revision {
                anchor.response_revision = revision.to_string();
            }
            true
        }
        AnchorOutcome::Unmatched => false,
    }
}

/// The highlights that still match after the edit (moved where they moved),
/// and the number removed.
pub fn reanchor_highlights(
    highlights: &[ResearchHighlight],
    old_text: &str,
    new_text: &str,
    revision: Option<&str>,
) -> (Vec<ResearchHighlight>, usize) {
    let mut kept = Vec::with_capacity(highlights.len());
    let mut removed = 0usize;
    for highlight in highlights {
        let mut highlight = highlight.clone();
        let outcome = reanchor(&highlight.anchor, old_text, new_text);
        if apply_outcome(&mut highlight.anchor, &outcome, revision) {
            kept.push(highlight);
        } else {
            removed += 1;
        }
    }
    (kept, removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor(exact: &str, prefix: &str, suffix: &str, start: usize) -> ResearchHighlightAnchor {
        ResearchHighlightAnchor {
            version: 1,
            projection: "answer-v1".to_string(),
            response_revision: "old".to_string(),
            start,
            end: start + exact.encode_utf16().count(),
            exact: exact.to_string(),
            prefix: prefix.to_string(),
            suffix: suffix.to_string(),
        }
    }

    // The cases below are repeated in tests/researchAnchors.test.ts.

    #[test]
    fn a_quote_in_an_unchanged_paragraph_moves_with_the_text_before_it() {
        let old = "# Report\n\nThe sky is blue.\n\nGrass is green.";
        let new = "# Report\n\nAn added paragraph.\n\nThe sky is blue.\n\nGrass is green.";
        let quote = anchor("Grass is green", "The sky is blue.\n", ".", 24);
        assert_eq!(
            reanchor(&quote, old, new),
            AnchorOutcome::Moved { start: 45, end: 59 }
        );
    }

    #[test]
    fn markdown_syntax_around_a_rendered_quote_does_not_prevent_a_match() {
        let old = "Revenue grew **12%** in Q3.\n\n- First item";
        let new = "Revenue grew **12%** in Q3 and Q4.\n\n- First item";
        let quote = anchor("Revenue grew 12%", "", " in Q3.\nFirst", 0);
        assert_eq!(
            reanchor(&quote, old, new),
            AnchorOutcome::Moved { start: 0, end: 16 }
        );
    }

    #[test]
    fn a_removed_quote_no_longer_matches() {
        let old = "Keep this.\n\nDrop this sentence.";
        let new = "Keep this.";
        let quote = anchor("Drop this sentence", "Keep this.\n", ".", 11);
        assert_eq!(reanchor(&quote, old, new), AnchorOutcome::Unmatched);
    }

    #[test]
    fn context_chooses_between_repeated_quotes() {
        let old = "Alpha: the result.\n\nBeta: the result.";
        let new = "Beta: the result.\n\nAlpha: the result.\n\nGamma: the result.";
        let quote = anchor("the result", "Beta: ", ".", 26);
        assert_eq!(
            reanchor(&quote, old, new),
            AnchorOutcome::Moved { start: 6, end: 16 }
        );
    }

    #[test]
    fn a_repeated_quote_whose_context_changed_on_both_sides_no_longer_matches() {
        let old = "One the result two.\n\nThree the result four.";
        let new = "Five the result six.\n\nSeven the result eight.";
        let quote = anchor("the result", "One ", " two", 4);
        assert_eq!(reanchor(&quote, old, new), AnchorOutcome::Unmatched);
    }

    #[test]
    fn a_single_occurrence_that_keeps_one_side_still_matches() {
        let old = "Before the passage after.";
        let new = "Changed the passage after.";
        let quote = anchor("the passage", "Before ", " after.", 7);
        assert_eq!(
            reanchor(&quote, old, new),
            AnchorOutcome::Moved { start: 8, end: 19 }
        );
    }

    #[test]
    fn a_quote_not_found_in_the_old_text_is_left_unchanged() {
        let old = "Rendered math: $x^2$.";
        let new = "Something else.";
        let quote = anchor("x²", "", "", 15);
        assert_eq!(reanchor(&quote, old, new), AnchorOutcome::Unchanged);
        let punctuation = anchor("—", "", "", 0);
        assert_eq!(reanchor(&punctuation, old, new), AnchorOutcome::Unchanged);
    }

    #[test]
    fn offsets_count_utf16_units() {
        let old = "😀 smile here.";
        let new = "😀😀 smile here.";
        let quote = anchor("smile", "", " here", 3);
        assert_eq!(
            reanchor(&quote, old, new),
            AnchorOutcome::Moved { start: 5, end: 10 }
        );
    }

    #[test]
    fn reanchoring_highlights_keeps_matches_and_counts_removals() {
        let old = "First point.\n\nSecond point.";
        let new = "First point, revised.";
        let highlights = vec![
            ResearchHighlight {
                id: "a".to_string(),
                anchor: anchor("First point", "", ".", 0),
                created_at: 1,
            },
            ResearchHighlight {
                id: "b".to_string(),
                anchor: anchor("Second point", "First point.\n", ".", 13),
                created_at: 2,
            },
        ];
        let (kept, removed) = reanchor_highlights(&highlights, old, new, Some("new"));
        assert_eq!(removed, 1);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].id, "a");
        assert_eq!(kept[0].anchor.response_revision, "new");
    }
}
