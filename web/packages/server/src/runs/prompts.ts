// Launch prompt assembly (`04-agent-runtime.md` §5).
//
// The pieces — the system prompt, the wrapper the
// user's own instruction is neutralized into, the quoted-passage and
// imported-document forms, the tweet reference block — are all in
// `@session/shared`, ported from `research.rs` with their tests. This module
// only decides which of them a given node needs, and puts the instruction
// blocks in the system prompt rather than in the user message, which is what
// the web can do and the CLIs could not.

import type { ResearchNode } from "@session/shared";
import {
  RESEARCH_LAUNCH_INSTRUCTION_TAG,
  RESEARCH_SYSTEM_PROMPT,
  clampResearchLaunchInstruction,
  documentFollowupPrompt,
  neutralizedInstructionMarkup,
  promptWithResearchAttachments,
  queryFollowupPrompt,
} from "@session/shared";
import { nodeAttachments, nodePrompt, passageAnchor } from "@session/shared/lib/researchNodeTypes";

/**
 * How agents write `session-html` widgets: the desktop's `AGENT_GUIDANCE`
 * (`src-tauri/src/research_widgets.rs`), word for word. The web sends it on
 * every launch; widgets are always on. Widget scripts run on the web when the
 * reader chooses Run scripts, in the sandbox `11-artifacts-and-browser.md` §3
 * describes.
 */
export const SESSION_WIDGET_AGENT_GUIDANCE = `Session renders a fenced code block whose language is session-html as an interactive widget inside the answer.

Add a widget when the reader would understand the answer better by changing something and watching the result. Typical cases: how settings combine (layout rules, configuration options), how a quantity evolves over time or under adjustable parameters (a growth curve, a decay, a probability), how an algorithm proceeds step by step or behaves on different inputs, and how a mechanism responds to its input. In these cases add the widget even when a table of a few fixed cases also answers the literal question; a widget lets the reader try the cases the table leaves out. Do not add one when a sentence, list, table or mermaid diagram already makes the point, and never for decoration; factual answers, short how-tos, definitions and lists of sources need none. Use at most one widget per answer unless the question asks for more.

A widget is an HTML fragment that Session places inside the <body> of a sandboxed page:
- Self-contained: inline <style> and <script> only. Network requests and external resources (scripts, stylesheets, fonts, images, iframes) are blocked.
- Small: under 20 KB; the hard limit is 64 KB.
- Fills the width of the answer column; no fixed widths over 640 px. The frame's height follows the content, so do not size anything with vh units or height: 100%.
- Readable in light and dark mode: inherit the page's text color and background, or define colors for both with @media (prefers-color-scheme: dark).
- Session starts the widget's scripts only when the reader asks it to, so the HTML and CSS must show a meaningful initial state (default values, labels, a static figure) before any script runs.
- Optional saved inputs: window.sessionWidgetState.onRestore(value => { /* validate your versioned JSON state; null means defaults */ }) receives restored state. Call window.sessionWidgetState.save(value) after user input. Values must be JSON, at most 16 KiB; saving only persists when the reader opts in. Include a schema version and validate before applying restored inputs. New revisions start fresh unless the reader explicitly copies the parent state.
- The answer must be complete without the widget: state every conclusion in the prose; the widget illustrates it. Readers without widgets see the block as code, so do not mention Session's frame or how to start the widget.

Write the block as \`\`\`session-html, then the fragment, then \`\`\` on its own line. Optional fence metadata: id="short-stable-id" title="Descriptive title" parent="64-character revision ID". When revising a selected artifact, keep its id and use the supplied revision hash as parent; never invent a parent hash. Legacy fences without metadata remain supported.`;

function taggedBlock(tag: string, body: string): string {
  return `<${tag}>\n${body}\n</${tag}>`;
}

/**
 * The system prompt for one attempt: the fixed research prompt followed by
 * the account's optional research instruction.
 *
 * The user's instruction is clamped and neutralized before it is wrapped, so
 * an instruction that spells the closing tag cannot end the block early and
 * have the remainder read as Session's own words.
 */
export function researchSystemPrompt(instruction?: string | null): string {
  const blocks = [RESEARCH_SYSTEM_PROMPT, SESSION_WIDGET_AGENT_GUIDANCE];
  const trimmed = (instruction ?? "").trim();
  if (trimmed !== "") {
    blocks.push(
      taggedBlock(
        RESEARCH_LAUNCH_INSTRUCTION_TAG,
        neutralizedInstructionMarkup(clampResearchLaunchInstruction(trimmed)),
      ),
    );
  }
  return blocks.join("\n\n");
}

export interface UserTextInput {
  node: ResearchNode;
  /** The markdown of a `document` parent, which has no messages of its own and
   * therefore rides in the child's prompt (`04-agent-runtime.md` §4). */
  parentDocument?: { title: string; markdown: string } | undefined;
}

/**
 * The text of the new user message.
 *
 * Four shapes, in the order they compose: the bare question; the question with
 * the passage it was asked about; the question with an imported report as
 * context; and any of those followed by the resolved X posts attached to it,
 * marked as untrusted reference material.
 */
export function researchUserText(input: UserTextInput): string {
  const { node } = input;
  let text = nodePrompt(node);
  const anchor = passageAnchor(node);
  if (input.parentDocument) {
    text = documentFollowupPrompt(input.parentDocument.title, input.parentDocument.markdown, text);
  } else if (anchor) {
    text = queryFollowupPrompt(anchor.exact, text);
  }
  return promptWithResearchAttachments(text, nodeAttachments(node));
}
