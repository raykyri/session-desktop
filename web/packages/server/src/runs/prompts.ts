// Launch prompt assembly (`04-agent-runtime.md` §5).
//
// The pieces — the system prompt, the wrapper the user's own instruction is
// neutralized into, and the quoted-passage form — are in `@session/shared`,
// ported from `research.rs` with their tests. This module only decides which
// of them an attempt needs, and puts the instruction block in the system
// prompt rather than in the user message.
//
// The widget guidance, the imported-document form and the tweet reference
// block were removed with the research API (plan `01` A2): widgets are not
// built (decision P21), and documents and attachments have no records in the
// spaces contract. M5a assembles a node's question from its record (`03` G7).

import {
  RESEARCH_LAUNCH_INSTRUCTION_TAG,
  RESEARCH_SYSTEM_PROMPT,
  clampResearchLaunchInstruction,
  neutralizedInstructionMarkup,
  queryFollowupPrompt,
} from "@session/shared";

function taggedBlock(tag: string, body: string): string {
  return `<${tag}>\n${body}\n</${tag}>`;
}

/**
 * The system prompt for one attempt: the fixed research prompt, then the
 * account's optional research instruction.
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
  /** The question as the asker wrote it. */
  prompt: string;
  /** The passage of the parent answer the question was asked about, for a
   * branch from a selection. */
  passage?: string | null | undefined;
}

/** The text of the new user message: the bare question, or the question with
 * the passage it was asked about. */
export function researchUserText(input: UserTextInput): string {
  const passage = input.passage ?? "";
  return passage === "" ? input.prompt : queryFollowupPrompt(passage, input.prompt);
}
