// Launch prompt assembly (`04-agent-runtime.md` §5), for a run of a space
// thread (phase 2a). The system prompt is Session's research prompt, then the
// ask's skill (a skill of the space, by id), then the asker's own research
// instruction; both are neutralized into tagged blocks so text that spells a
// closing tag cannot end the block early and be read as Session's own words.
// The messages are the exchanges before the run on its branch, as the asker
// reads them, then the question.

import {
  RESEARCH_LAUNCH_INSTRUCTION_TAG,
  RESEARCH_SYSTEM_PROMPT,
  clampResearchLaunchInstruction,
  neutralizedInstructionMarkup,
} from "@session/shared";
import type { Exchange } from "@session/sync/server";
import type { ModelMessage } from "ai";

/** The tag a space skill's prompt is wrapped in. */
export const SKILL_TAG = "session_space_skill";

/** The most characters of earlier exchanges a run is given; older ones are
 * left out first. */
export const HISTORY_MAX_CHARS = 400_000;

function taggedBlock(tag: string, body: string): string {
  return `<${tag}>\n${body}\n</${tag}>`;
}

export function researchSystemPrompt(
  instruction?: string | null,
  skill?: { name: string; prompt: string } | null,
): string {
  const blocks = [RESEARCH_SYSTEM_PROMPT];
  const prompt = (skill?.prompt ?? "").trim();
  if (skill && prompt !== "")
    blocks.push(
      taggedBlock(
        SKILL_TAG,
        neutralizedInstructionMarkup(`${skill.name.trim()}\n\n${clampResearchLaunchInstruction(prompt)}`),
      ),
    );
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

/** The messages of a run: its branch's earlier exchanges (the newest that
 * fit HISTORY_MAX_CHARS), then its question. An exchange without an answer
 * is left out. */
export function runMessages(history: readonly Exchange[], q: string): ModelMessage[] {
  const kept: Exchange[] = [];
  let size = q.length;
  for (const x of [...history].reverse()) {
    if (x.a === "" || x.q === "") continue;
    size += x.q.length + x.a.length;
    if (size > HISTORY_MAX_CHARS) break;
    kept.unshift(x);
  }
  return [
    ...kept.flatMap((x): ModelMessage[] => [
      { role: "user", content: x.q },
      { role: "assistant", content: x.a },
    ]),
    { role: "user", content: q },
  ];
}
