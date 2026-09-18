// The canonical message store ↔ AI SDK conversion (`04-agent-runtime.md` §4,
// §8).
//
// The app owns the conversation: a node's context is its ancestors' stored
// `ModelMessage`s along the tree path, plus the new user message this attempt
// is asking. Three things happen on the way out — provider reasoning metadata
// is dropped when the thread changed model, attached documents become the
// parts the target provider actually accepts, and the whole thing is cut down
// to the context budget — and all three only shape what the model sees. The
// displayed document is unaffected.

import type { SessionDatabase } from "@session/db";
import { documents as documentsRepo, messages as messagesRepo } from "@session/db";
import type { DocumentInfo, ModelEntry, ResearchNode, Turn } from "@session/shared";
import { estimateTokenCount } from "@session/shared";
import type {
  AssistantContent,
  FilePart,
  ImagePart,
  ModelMessage,
  TextPart,
  ToolContent,
  UserContent,
} from "ai";

import { extractionKind } from "../uploads/limits.js";

import type { RunToolContext } from "./tools/context.js";
import { chunkDocumentText, documentPlainText } from "./tools/documentRead.js";

/** `04-agent-runtime.md` §4. Deliberately below every model's real window:
 * the budget is what keeps a long thread cheap, not only what keeps it legal. */
export const CONTEXT_BUDGET_TOKENS = 200_000;

/** How many nodes at the end of the path keep their tool results in full. */
const NODES_KEEPING_TOOL_RESULTS = 2;

export const ELIDED_TOOL_RESULT = "[tool result elided]";

/** A document a model without file input receives as text
 * (`04-agent-runtime.md` §8). Beyond it the model is pointed at
 * `document_read`. */
export const MAX_INLINE_DOCUMENT_CHARS = 60_000;

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

interface PathMessage {
  nodeId: string;
  message: ModelMessage;
  /** Which model produced an assistant message, for the reasoning rule. */
  model: string | null;
}

/** The ancestors' stored messages, root first, with reasoning kept only where
 * the producing model is the one about to run. */
export function ancestorContext(
  db: SessionDatabase,
  userId: string,
  node: Pick<ResearchNode, "id" | "model">,
): PathMessage[] {
  return messagesRepo.ancestorMessages(db, userId, node.id).map((stored) => {
    const message = stored.message as ModelMessage;
    return {
      nodeId: stored.nodeId,
      model: stored.model,
      message:
        stored.model !== null && stored.model !== node.model
          ? stripForeignReasoning(message)
          : message,
    };
  });
}

/** Tokens, estimated the way `04` §4 specifies: characters over four, applied
 * to the message's serialized form so tool payloads and file parts count. */
export function estimateMessageTokens(message: ModelMessage): number {
  if (typeof message.content === "string") {
    return estimateTokenCount(message.content);
  }
  let total = 0;
  for (const part of message.content as unknown[]) {
    if (isRecord(part) && typeof part["text"] === "string") {
      total += estimateTokenCount(part["text"]);
      continue;
    }
    total += estimateTokenCount(JSON.stringify(part ?? ""));
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

function nodeOrder(path: readonly PathMessage[]): string[] {
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

function readSummary(db: SessionDatabase, userId: string, nodeId: string): string | null {
  try {
    const cached = messagesRepo.getSummary(db, userId, nodeId);
    return cached?.coversThroughNodeId === nodeId ? cached.summary : null;
  } catch {
    return null;
  }
}

function writeSummary(db: SessionDatabase, userId: string, nodeId: string, summary: string): void {
  try {
    messagesRepo.saveSummary(db, userId, nodeId, summary, nodeId);
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
  db: SessionDatabase,
  userId: string,
  path: readonly PathMessage[],
  options: {
    budgetTokens?: number;
    summarize?: ContextSummarizer | undefined;
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
  const cached = readSummary(db, userId, coversThrough);
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
      writeSummary(db, userId, coversThrough, summary);
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

/** Which shape of part a provider takes for a document (`04` §8). */
export type DocumentPartStyle = "file" | "text";

export function documentPartStyle(entry: ModelEntry): DocumentPartStyle {
  return entry.supportsFiles ? "file" : "text";
}

function inlineDocumentText(ctx: RunToolContext, document: DocumentInfo): TextPart {
  const text = documentPlainText(ctx, document.id);
  if (text === "") {
    return {
      type: "text",
      text: `<document id="${document.id}" name="${document.name}">\n[no text could be extracted]\n</document>`,
    };
  }
  if (text.length <= MAX_INLINE_DOCUMENT_CHARS) {
    return {
      type: "text",
      text: `<document id="${document.id}" name="${document.name}">\n${text}\n</document>`,
    };
  }
  const chunks = chunkDocumentText(text);
  const head = chunks[0] ?? text.slice(0, MAX_INLINE_DOCUMENT_CHARS);
  return {
    type: "text",
    text:
      `<document id="${document.id}" name="${document.name}" chunks="${chunks.length}">\n${head}\n</document>\n` +
      `The document continues; read the remaining chunks with document_read({ documentId: "${document.id}", chunk: 1 }).`,
  };
}

/**
 * The parts one attached document contributes to the user message.
 *
 * Text formats are inlined for every provider — they are already text, and a
 * file part would only make them opaque. PDFs and images go as file and image
 * parts to the models that accept them, and as extracted text to the ones that
 * do not.
 */
export function documentParts(
  ctx: RunToolContext,
  entry: ModelEntry,
  document: DocumentInfo,
  bytes: Uint8Array | null,
): (TextPart | FilePart | ImagePart)[] {
  const kind = extractionKind(document.mime);
  if (kind === "text" || kind === "docx") {
    return [inlineDocumentText(ctx, document)];
  }
  if (kind === "image") {
    if (!entry.supportsImages || bytes === null) {
      return [
        {
          type: "text",
          text: `<document id="${document.id}" name="${document.name}" mime="${document.mime}">\n[this model cannot read images]\n</document>`,
        },
      ];
    }
    return [{ type: "image", image: bytes, mediaType: document.mime }];
  }
  if (!entry.supportsFiles || bytes === null) {
    return [inlineDocumentText(ctx, document)];
  }
  return [{ type: "file", data: bytes, mediaType: document.mime, filename: document.name }];
}

export interface BuildMessagesInput {
  ctx: RunToolContext;
  node: ResearchNode;
  entry: ModelEntry;
  /** The assembled text of the new user message (`prompts.ts`). */
  userText: string;
  /** Documents attached to this node, in display order. */
  documents: readonly DocumentInfo[];
  /** Committed exchanges of an interrupted attempt, kept as context on resume
   * (`05-run-lifecycle-and-streaming.md` §7). */
  priorMessages?: readonly ModelMessage[] | undefined;
  summarize?: ContextSummarizer | undefined;
  budgetTokens?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface BuiltMessages {
  messages: ModelMessage[];
  estimatedTokens: number;
  elidedToolResults: boolean;
  summarizedThrough: string | null;
}

/** Reads a document's bytes, or null when the volume no longer has them: a
 * missing file degrades to extracted text rather than failing the run. */
async function readDocumentBytes(
  ctx: RunToolContext,
  documentId: string,
): Promise<Uint8Array | null> {
  const path = documentsRepo.storagePath(ctx.db, ctx.userId, documentId);
  if (path === null) {
    return null;
  }
  try {
    const { readFile } = await import("node:fs/promises");
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

/** The whole request body for one attempt: ancestors, then this node's
 * question with its documents, then whatever an interrupted attempt already
 * produced. */
export async function buildMessages(input: BuildMessagesInput): Promise<BuiltMessages> {
  const { ctx, node, entry } = input;
  const path = ancestorContext(ctx.db, ctx.userId, node);
  const compacted = await compactContext(ctx.db, ctx.userId, path, {
    ...(input.budgetTokens === undefined ? {} : { budgetTokens: input.budgetTokens }),
    summarize: input.summarize,
    signal: input.signal,
  });

  const content: (TextPart | FilePart | ImagePart)[] = [{ type: "text", text: input.userText }];
  for (const document of input.documents) {
    const kind = extractionKind(document.mime);
    const needsBytes = kind === "pdf" || kind === "image";
    const bytes = needsBytes ? await readDocumentBytes(ctx, document.id) : null;
    content.push(...documentParts(ctx, entry, document, bytes));
  }

  const messages: ModelMessage[] = [
    ...compacted.messages,
    { role: "user", content: content as UserContent },
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
 * the resumed attempt replaces it.
 */
export function messagesFromCommittedTurns(turns: readonly Turn[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const toolNames = new Map<string, string>();
  for (const turn of turns) {
    if (turn.role === "assistant") {
      const content: AssistantContent = [];
      for (const block of turn.blocks) {
        if (block.type === "text" && block.text !== "") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "toolUse") {
          const toolCallId = block.id ?? `${turn.id}-${content.length}`;
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
    const results: ToolContent = [];
    for (const block of turn.blocks) {
      if (block.type !== "toolResult") {
        continue;
      }
      const toolCallId = block.toolUseId ?? "";
      if (toolCallId === "") {
        continue;
      }
      results.push({
        type: "tool-result",
        toolCallId,
        toolName: toolNames.get(toolCallId) ?? "web_search",
        output: block.isError
          ? { type: "error-json", value: (block.content ?? null) as never }
          : { type: "json", value: (block.content ?? null) as never },
      });
    }
    if (results.length > 0) {
      messages.push({ role: "tool", content: results });
    }
  }
  return messages;
}
