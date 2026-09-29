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
  const blocks = [RESEARCH_SYSTEM_PROMPT];
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
  node: Pick<ResearchNode, "prompt" | "queryAnchor" | "attachments">;
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
  let text = node.prompt;
  if (input.parentDocument) {
    text = documentFollowupPrompt(input.parentDocument.title, input.parentDocument.markdown, text);
  } else if (node.queryAnchor) {
    text = queryFollowupPrompt(node.queryAnchor.exact, text);
  }
  return promptWithResearchAttachments(text, node.attachments ?? []);
}
