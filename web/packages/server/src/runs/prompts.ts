// Launch prompt assembly (`04-agent-runtime.md` §5), for a run of a space
// thread (phase 2a). The system prompt is Session's research prompt, then the
// ask's skill (a skill of the space, by id), then the asker's own research
// instruction; both are neutralized into tagged blocks so text that spells a
// closing tag cannot end the block early and be read as Session's own words.
// The messages are the exchanges before the run on its branch, as the asker
// reads them, each with the tool calls and results of the run that answered
// it (its stored turns), then the question, then the turns this run stored
// already when it resumes (review round 1 of phase 2, F7; phase 2a design
// finding 4). Everything fits a size budget: older exchanges are left out
// first, and an exchange whose turns do not fit is given as its question
// and answer only.

import type { Turn } from "@session/shared";
import {
  RESEARCH_LAUNCH_INSTRUCTION_TAG,
  RESEARCH_SYSTEM_PROMPT,
  clampResearchLaunchInstruction,
  neutralizedInstructionMarkup,
  turnSchema,
} from "@session/shared";
import type { Exchange } from "@session/sync/server";
import type { AssistantContent, ModelMessage, ToolContent } from "ai";

/** The tag a space skill's prompt is wrapped in. */
export const SKILL_TAG = "session_space_skill";

/** The most characters (as JSON) of earlier exchanges a run is given; older
 * ones are left out first. */
export const HISTORY_MAX_CHARS = 400_000;
/** The most characters (as JSON) of one tool result in a run's context; a
 * longer one is clipped. */
export const TOOL_RESULT_MAX_CHARS = 20_000;

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
        neutralizedInstructionMarkup(
          `${skill.name.trim()}\n\n${clampResearchLaunchInstruction(prompt)}`,
        ),
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

/** Stored turns as `Turn`s (`@session/shared`'s schema), or null when one
 * is not a turn (a device's text). */
export function parseTurns(turns: readonly unknown[]): Turn[] | null {
  const out: Turn[] = [];
  for (const t of turns) {
    const r = turnSchema.safeParse(t);
    if (!r.success) return null;
    out.push(r.data as Turn);
  }
  return out;
}

/** The text of an assistant turn's text blocks. */
const textOf = (t: Turn) =>
  t.blocks
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n\n")
    .trim();

/** Whether the last stored turn is the end of an answer: an assistant turn
 * with text and no tool call (a step that finished with no more to do). */
export function endsWithAnswer(turns: readonly Turn[]): boolean {
  const last = turns[turns.length - 1];
  return (
    last?.role === "assistant" && textOf(last) !== "" && !last.blocks.some((b) => b.type === "toolUse")
  );
}

/** JSON of `v`, clipped to `max` characters. */
function clipped(v: unknown, max: number): string {
  const s = typeof v === "string" ? v : (JSON.stringify(v) ?? "null");
  return s.length > max ? `${s.slice(0, max)} [clipped]` : s;
}

/** Turns as model messages: each assistant turn's text and tool calls, each
 * call followed by its result. A call of a tool the run has (`tools`) is a
 * tool call; any other with a result (Google Search grounding, a provider's
 * own tool) is a line of text; a call with no result (the attempt stopped
 * between the call and its result) is left out. */
export function turnMessages(turns: readonly Turn[], tools: ReadonlySet<string>): ModelMessage[] {
  const results = new Map<string, { content: unknown; isError: boolean }>();
  for (const t of turns)
    for (const b of t.blocks)
      if (b.type === "toolResult" && typeof b.toolUseId === "string")
        results.set(b.toolUseId, { content: b.content, isError: b.isError });
  const out: ModelMessage[] = [];
  for (const t of turns) {
    if (t.role !== "assistant") continue;
    const parts: Exclude<AssistantContent, string> = [];
    const done: ToolContent = [];
    for (const b of t.blocks) {
      if (b.type === "text" && b.text.trim() !== "") parts.push({ type: "text", text: b.text });
      if (b.type !== "toolUse" || typeof b.id !== "string") continue;
      const r = results.get(b.id);
      if (!r) continue;
      const value = clipped(r.content, TOOL_RESULT_MAX_CHARS);
      if (tools.has(b.name)) {
        parts.push({ type: "tool-call", toolCallId: b.id, toolName: b.name, input: b.input ?? {} });
        done.push({
          type: "tool-result",
          toolCallId: b.id,
          toolName: b.name,
          output: r.isError ? { type: "error-text", value } : { type: "text", value },
        });
      } else
        parts.push({
          type: "text",
          text: `[${b.name} ${clipped(b.input ?? null, 2000)}] ${value}`,
        });
    }
    if (parts.length) out.push({ role: "assistant", content: parts });
    if (done.length) out.push({ role: "tool", content: done });
  }
  return out;
}

const sizeOf = (m: readonly ModelMessage[]) => JSON.stringify(m).length;

/** The messages of an earlier exchange: its question, then the turns of the
 * run that answered it when they hold that answer, else the answer as
 * text. */
function exchangeMessages(x: Exchange, tools: ReadonlySet<string>, full: boolean): ModelMessage[] {
  const turns = full ? parseTurns(x.turns) : null;
  const last = turns?.filter((t) => t.role === "assistant" && textOf(t) !== "").pop();
  if (turns && last && textOf(last) === x.a.trim())
    return [{ role: "user", content: x.q }, ...turnMessages(turns, tools)];
  return [
    { role: "user", content: x.q },
    { role: "assistant", content: x.a },
  ];
}

/** The messages of a run: its branch's earlier exchanges (the newest that
 * fit HISTORY_MAX_CHARS, each with its tool calls where they fit), then its
 * question, then the turns it stored already (a resumed run continues after
 * them; a last turn whose tool calls have no results is done again). An
 * exchange without an answer is left out. */
export function runMessages(
  history: readonly Exchange[],
  q: string,
  own: readonly Turn[] = [],
  tools: ReadonlySet<string> = new Set(),
): ModelMessage[] {
  const kept: ModelMessage[][] = [];
  let size = q.length;
  for (const x of [...history].reverse()) {
    if (x.a === "" || x.q === "") continue;
    let m = exchangeMessages(x, tools, true);
    if (size + sizeOf(m) > HISTORY_MAX_CHARS) m = exchangeMessages(x, tools, false);
    size += sizeOf(m);
    if (size > HISTORY_MAX_CHARS) break;
    kept.unshift(m);
  }
  const after = turnMessages(own, tools);
  if (after[after.length - 1]?.role === "assistant") after.pop();
  return [...kept.flat(), { role: "user", content: q }, ...after];
}
