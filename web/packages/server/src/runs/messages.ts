// The canonical message store ↔ AI SDK conversion (`04-agent-runtime.md` §4,
// §8).
//
// The app stores the conversation: a node's context is its ancestors' stored
// `ModelMessage`s along the tree path (`RunRequest.history`, read by the
// store), plus the new user message this attempt is asking. Two things happen on the way out — provider reasoning metadata
// is dropped when the thread changed model, and the whole thing is cut down to
// the context budget — and both only shape what the model sees. The displayed
// document is unaffected.

import type { Turn } from "@session/shared";
import { estimateTokenCount } from "@session/shared";
import type { AssistantContent, ModelMessage, TextPart, ToolContent } from "ai";

import type { ContextMessage, SummaryCache } from "./store.js";

/** `04-agent-runtime.md` §4. Below each model's context window to limit
 * the cost of long threads. */
export const CONTEXT_BUDGET_TOKENS = 200_000;

/** Number of trailing nodes that retain complete tool results. */
const NODES_KEEPING_TOOL_RESULTS = 2;

export const ELIDED_TOOL_RESULT = "[tool result elided]";

/** A summarizer for the oldest exchanges, injected so this module has no
 * provider dependency; `metadata.ts` supplies the `gemini-flash` one. */
export type ContextSummarizer = (input: {
  text: string;
  signal?: AbortSignal | undefined;
}) => Promise<string | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Removes the parts and metadata that only mean something to the provider
 * that produced them.
 *
 * Same-model forks keep reasoning blocks, because Fable 5.1 wants its own
 * thinking replayed intact; a cross-model fork drops them, since another
 * provider either ignores them or rejects them, and a signature computed by
 * one provider cannot be re-verified by another.
 */
function withoutProviderOptions<T extends Record<string, unknown>>(value: T): T {
  const copy: Record<string, unknown> = { ...value };
  delete copy["providerOptions"];
  return copy as T;
}

export function stripForeignReasoning(message: ModelMessage): ModelMessage {
  const stripped = withoutProviderOptions(message as unknown as Record<string, unknown>);
  const bare = stripped as unknown as ModelMessage;
  if (bare.role !== "assistant" || typeof bare.content === "string") {
    return bare;
  }
  const parts = bare.content as unknown[];
  const content = parts
    .filter(
      (part) =>
        !(isRecord(part) && (part["type"] === "reasoning" || part["type"] === "reasoning-file")),
    )
    .map((part) => (isRecord(part) ? withoutProviderOptions(part) : part));
  return { ...bare, content: content as AssistantContent };
}

/** The ancestors' stored messages, root first, with reasoning kept only where
 * the producing model is `model`, the one about to run. */
export function ancestorContext(
  history: readonly ContextMessage[],
  model: string,
): ContextMessage[] {
  return history.map((stored) => ({
    nodeId: stored.nodeId,
    model: stored.model,
    message:
      stored.model !== null && stored.model !== model
        ? stripForeignReasoning(stored.message)
        : stored.message,
  }));
}

/** The byte length of a binary payload, or null when the value is not one.
 * `file` parts carry `data` and `image` parts carry `image`
 * (`documentParts`), and either may be a view over an `ArrayBuffer`. */
function binaryByteLength(value: unknown): number | null {
  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }
  if (ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  return null;
}

/**
 * Tokens contributed by one part.
 *
 * Binary payloads are measured, not serialized. `JSON.stringify` of a
 * `Uint8Array` emits `{"0":1,"1":2,…}` — about 12.5 bytes of string per byte of
 * file — so a 20 MiB PDF (the per-document ceiling) would build a ~279 MB
 * transient string and hold the event loop for well over a second, with ten
 * attachments allowed per question. Every SSE stream stalls for that time and
 * `/healthz` cannot answer, which is enough for Fly to take the machine out of
 * the pool. And the work is discarded regardless: `estimateTokenCount` samples
 * at most 2,048 code units.
 *
 * `byteLength / 4` is the same characters-over-four rule the text path uses,
 * which is as meaningful as any number here — a provider bills an attachment by
 * its own rules, and this estimate exists to decide what to elide.
 */
function estimatePartTokens(part: unknown): number {
  if (isRecord(part)) {
    if (typeof part["text"] === "string") {
      return estimateTokenCount(part["text"]);
    }
    const bytes = binaryByteLength(part["data"]) ?? binaryByteLength(part["image"]);
    if (bytes !== null) {
      return Math.max(1, Math.round(bytes / 4));
    }
  }
  return estimateTokenCount(JSON.stringify(part ?? ""));
}

/** Tokens, estimated the way `04` §4 specifies: characters over four, applied
 * to the message's serialized form so tool payloads and file parts count. */
export function estimateMessageTokens(message: ModelMessage): number {
  if (typeof message.content === "string") {
    return estimateTokenCount(message.content);
  }
  let total = 0;
  for (const part of message.content as unknown[]) {
    total += estimatePartTokens(part);
  }
  return total;
}

export function estimateTokens(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/** Replaces one tool message's outputs with the placeholder, keeping the
 * call/result pairing the providers require. */
function elideToolMessage(message: ModelMessage): ModelMessage {
  if (message.role !== "tool" || typeof message.content === "string") {
    return message;
  }
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === "tool-result"
        ? { ...part, output: { type: "text" as const, value: ELIDED_TOOL_RESULT } }
        : part,
    ) as ToolContent,
  };
}

function nodeOrder(path: readonly ContextMessage[]): string[] {
  const seen: string[] = [];
  for (const entry of path) {
    if (!seen.includes(entry.nodeId)) {
      seen.push(entry.nodeId);
    }
  }
  return seen;
}

/** The prose of one node's exchange, for the summarizer. */
function exchangeText(messages: readonly ModelMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      continue;
    }
    if (typeof message.content === "string") {
      parts.push(`${message.role}: ${message.content}`);
      continue;
    }
    const text = (message.content as unknown[])
      .filter((part): part is TextPart => isRecord(part) && part["type"] === "text")
      .map((part) => part.text)
      .join("\n");
    if (text.trim() !== "") {
      parts.push(`${message.role}: ${text}`);
    }
  }
  return parts.join("\n\n");
}

function readSummary(cache: SummaryCache | undefined, nodeId: string): string | null {
  try {
    return cache?.read(nodeId) ?? null;
  } catch {
    return null;
  }
}

function writeSummary(cache: SummaryCache | undefined, nodeId: string, summary: string): void {
  try {
    cache?.write(nodeId, summary);
  } catch {
    // Nothing downstream depends on the cache existing.
  }
}

export interface CompactionResult {
  messages: ModelMessage[];
  estimatedTokens: number;
  elidedToolResults: boolean;
  summarizedThrough: string | null;
}

/**
 * Cuts the ancestor context down to the budget, in the two steps `04` §4
 * prescribes: tool results older than the last two nodes become a placeholder,
 * and if that is not enough the oldest nodes' exchanges are replaced by one
 * summary, generated once and cached on the node it covers so every sibling
 * and descendant reuses it.
 */
export async function compactContext(
  path: readonly ContextMessage[],
  options: {
    budgetTokens?: number;
    summarize?: ContextSummarizer | undefined;
    summaries?: SummaryCache | undefined;
    signal?: AbortSignal | undefined;
  } = {},
): Promise<CompactionResult> {
  const budget = options.budgetTokens ?? CONTEXT_BUDGET_TOKENS;
  let messages = path.map((entry) => entry.message);
  let estimated = estimateTokens(messages);
  if (estimated <= budget) {
    return {
      messages,
      estimatedTokens: estimated,
      elidedToolResults: false,
      summarizedThrough: null,
    };
  }

  const order = nodeOrder(path);
  const recent = new Set(order.slice(-NODES_KEEPING_TOOL_RESULTS));
  messages = path.map((entry) =>
    recent.has(entry.nodeId) ? entry.message : elideToolMessage(entry.message),
  );
  estimated = estimateTokens(messages);
  if (estimated <= budget || options.summarize === undefined) {
    return {
      messages,
      estimatedTokens: estimated,
      elidedToolResults: true,
      summarizedThrough: null,
    };
  }

  // Everything but the last two nodes collapses into one summary message.
  const summarizedNodes = order.slice(0, Math.max(0, order.length - NODES_KEEPING_TOOL_RESULTS));
  const coversThrough = summarizedNodes.at(-1);
  if (coversThrough === undefined) {
    return {
      messages,
      estimatedTokens: estimated,
      elidedToolResults: true,
      summarizedThrough: null,
    };
  }
  const covered = new Set(summarizedNodes);
  // The cache is an optimization, not a correctness requirement: a node that
  // has been removed since it was summarized must cost a re-summarization, not
  // the run.
  const cached = readSummary(options.summaries, coversThrough);
  let summary = cached;
  if (summary === null) {
    const text = exchangeText(
      path.filter((entry) => covered.has(entry.nodeId)).map((e) => e.message),
    );
    summary = await options.summarize({
      text,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (summary !== null) {
      writeSummary(options.summaries, coversThrough, summary);
    }
  }
  if (summary === null) {
    return {
      messages,
      estimatedTokens: estimated,
      elidedToolResults: true,
      summarizedThrough: null,
    };
  }
  const tail = path.filter((entry) => !covered.has(entry.nodeId)).map((entry) => entry.message);
  const head: ModelMessage = {
    role: "user",
    content: `Summary of the earlier conversation in this thread:\n\n${summary}`,
  };
  messages = [head, ...tail];
  return {
    messages,
    estimatedTokens: estimateTokens(messages),
    elidedToolResults: true,
    summarizedThrough: coversThrough,
  };
}

export interface BuildMessagesInput {
  /** The thread's earlier exchanges, root first, as stored. */
  history: readonly ContextMessage[];
  /** The model about to run, for the reasoning rule (`ancestorContext`). */
  model: string;
  /** The assembled text of the new user message (`prompts.ts`). */
  userText: string;
  /** Committed exchanges of an interrupted attempt, kept as context on resume
   * (`05-run-lifecycle-and-streaming.md` §7). */
  priorMessages?: readonly ModelMessage[] | undefined;
  summarize?: ContextSummarizer | undefined;
  summaries?: SummaryCache | undefined;
  budgetTokens?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface BuiltMessages {
  messages: ModelMessage[];
  estimatedTokens: number;
  elidedToolResults: boolean;
  summarizedThrough: string | null;
}

/** The whole request body for one attempt: ancestors, then this node's
 * question, then whatever an interrupted attempt already produced. */
export async function buildMessages(input: BuildMessagesInput): Promise<BuiltMessages> {
  const path = ancestorContext(input.history, input.model);
  const compacted = await compactContext(path, {
    ...(input.budgetTokens === undefined ? {} : { budgetTokens: input.budgetTokens }),
    summarize: input.summarize,
    summaries: input.summaries,
    signal: input.signal,
  });

  const messages: ModelMessage[] = [
    ...compacted.messages,
    { role: "user", content: [{ type: "text", text: input.userText }] },
    ...(input.priorMessages ?? []),
  ];
  return {
    messages,
    estimatedTokens: estimateTokens(messages),
    elidedToolResults: compacted.elidedToolResults,
    summarizedThrough: compacted.summarizedThrough,
  };
}

/**
 * The messages an interrupted attempt already earned
 * (`05-run-lifecycle-and-streaming.md` §7).
 *
 * Committed turns are real exchanges — the model asked for a search and read
 * its result — so a resume replays them and continues, rather than paying for
 * them again. The in-flight partial is not here: it was never committed, and
 * the resumed attempt replaces it. A tool call without a result, and a result
 * without its call, are left out: a provider refuses a request that holds
 * either (a turn stored before the mapper dropped unanswered calls).
 */
export function messagesFromCommittedTurns(turns: readonly Turn[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const toolNames = new Map<string, string>();
  const results = new Set<string>();
  const calls = new Set<string>();
  for (const turn of turns)
    for (const block of turn.blocks) {
      if (block.type === "toolResult" && block.toolUseId) results.add(block.toolUseId);
      if (block.type === "toolUse" && block.id) calls.add(block.id);
    }
  for (const turn of turns) {
    if (turn.role === "assistant") {
      const content: AssistantContent = [];
      for (const block of turn.blocks) {
        if (block.type === "text" && block.text !== "") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "toolUse" && block.id && results.has(block.id)) {
          const toolCallId = block.id;
          toolNames.set(toolCallId, block.name);
          content.push({
            type: "tool-call",
            toolCallId,
            toolName: block.name,
            input: block.input ?? {},
          });
        }
      }
      if (content.length > 0) {
        messages.push({ role: "assistant", content });
      }
      continue;
    }
    const answers: ToolContent = [];
    for (const block of turn.blocks) {
      if (block.type !== "toolResult") {
        continue;
      }
      const toolCallId = block.toolUseId ?? "";
      if (!calls.has(toolCallId)) {
        continue;
      }
      answers.push({
        type: "tool-result",
        toolCallId,
        toolName: toolNames.get(toolCallId) ?? "web_search",
        output: block.isError
          ? { type: "error-json", value: (block.content ?? null) as never }
          : { type: "json", value: (block.content ?? null) as never },
      });
    }
    if (answers.length > 0) {
      messages.push({ role: "tool", content: answers });
    }
  }
  return messages;
}
