// AI SDK stream parts to the durable transcript format
// (`04-agent-runtime.md` §3, `docs/02-domain-model-and-database.md` §3.3).
//
// `Turn`/`TurnBlock` is the desktop's format and the web keeps it: the
// timeline projection, the revision hash, highlights, recap extraction, and
// the document view all read it. One provider step becomes one assistant turn
// (its text and its tool calls) and, when the step called tools, one user turn
// holding the results — the shape the CLIs produced, so the renderer needs no
// second case.
//
// Reasoning is the one thing deliberately dropped: the desktop never displayed
// it, so persisting it would put text into the answer's revision hash that
// nothing renders. It becomes a "thinking" indicator instead.

import type { Turn, TurnBlock } from "@session/shared";
import type { TextStreamPart, ToolSet } from "ai";

export interface MapperHandlers {
  /** Appended text for the turn currently streaming. */
  onTextDelta?: (turnId: string, text: string) => void;
  /** Reasoning started or ended; no content is carried. */
  onThinking?: (active: boolean) => void;
  /** A turn reached its final form and should be persisted and published. */
  onTurnCommitted?: (turn: Turn) => void;
  /** Google Search grounding ran inside the provider: how many queries it
   * billed (`04-agent-runtime.md` §6.2). No owned tool was called, so this is
   * the only place the usage can be counted. */
  onGroundedSearch?: (queries: number) => void;
}

export interface MapperOptions {
  /** Prefix of every turn id. The node id, so turn ids are unique per node
   * and stable across a resume. */
  runId: string;
  /** Maps to `Turn.agentId`; the web platform uses the node ID because it has no separate agent records. */
  agentId: string;
  /** First step number. A resume continues past the turns the interrupted
   * attempt already committed, so their ids are never reused. */
  startStep?: number;
  /** First `sourceIndex`, likewise continued across a resume. */
  startSourceIndex?: number;
  now?: () => number;
}

// Every field Vertex sends is optional *and* nullable; the shapes below say so
// rather than trusting `?.` to cover a `null` the types denied.
interface GroundingChunk {
  web?: { uri?: string | null; title?: string | null } | null;
}

interface GroundingMetadata {
  webSearchQueries?: string[] | null;
  groundingChunks?: GroundingChunk[] | null;
  searchEntryPoint?: { renderedContent?: string | null } | null;
}

function groundingOf(metadata: unknown): GroundingMetadata | null {
  if (typeof metadata !== "object" || metadata === null) {
    return null;
  }
  const google = (metadata as Record<string, unknown>)["google"];
  if (typeof google !== "object" || google === null) {
    return null;
  }
  const grounding = (google as Record<string, unknown>)["groundingMetadata"];
  if (typeof grounding !== "object" || grounding === null) {
    return null;
  }
  return grounding;
}

/**
 * Stateful across one attempt: parts in, turns out.
 *
 * Nothing here writes to the database or emits an event; the loop does both
 * from the handlers, which keeps the mapping testable against a recorded
 * stream on its own (`12-testing-linting-ci.md` §3.3).
 */
export class TurnMapper {
  readonly #options: Required<Omit<MapperOptions, "now">> & { now: () => number };
  readonly #handlers: MapperHandlers;
  readonly #committed: Turn[] = [];

  #step: number;
  #sourceIndex: number;
  #assistantBlocks: TurnBlock[] = [];
  #text = "";
  #toolResults: TurnBlock[] = [];
  #thinking = false;
  #sources: { url: string; title: string }[] = [];

  constructor(options: MapperOptions, handlers: MapperHandlers = {}) {
    this.#options = {
      runId: options.runId,
      agentId: options.agentId,
      startStep: options.startStep ?? 0,
      startSourceIndex: options.startSourceIndex ?? 0,
      now: options.now ?? Date.now,
    };
    this.#handlers = handlers;
    this.#step = this.#options.startStep;
    this.#sourceIndex = this.#options.startSourceIndex;
  }

  get assistantTurnId(): string {
    return `${this.#options.runId}-assistant-${this.#step}`;
  }

  get userTurnId(): string {
    return `${this.#options.runId}-user-${this.#step}`;
  }

  /** Text streamed into the turn that has not been committed yet — what the
   * in-flight checkpoint stores and a rejoining client renders. */
  get inFlightText(): string {
    return this.#text;
  }

  get committedTurns(): readonly Turn[] {
    return this.#committed;
  }

  /** The turn the checkpoint writes: the current step as it stands. */
  inFlightTurn(): Turn | null {
    if (this.#text === "" && this.#assistantBlocks.length === 0) {
      return null;
    }
    return this.#makeTurn(this.assistantTurnId, "assistant", this.#currentAssistantBlocks(), false);
  }

  #currentAssistantBlocks(): TurnBlock[] {
    return this.#text === ""
      ? [...this.#assistantBlocks]
      : [{ type: "text", text: this.#text }, ...this.#assistantBlocks];
  }

  #makeTurn(id: string, role: string, blocks: TurnBlock[], advance: boolean): Turn {
    const turn: Turn = {
      id,
      agentId: this.#options.agentId,
      role,
      blocks,
      sourceIndex: this.#sourceIndex,
      timestamp: this.#options.now(),
    };
    if (advance) {
      this.#sourceIndex += 1;
    }
    return turn;
  }

  #setThinking(active: boolean): void {
    if (this.#thinking === active) {
      return;
    }
    this.#thinking = active;
    this.#handlers.onThinking?.(active);
  }

  /** Feeds one `fullStream` part. Unknown part types are ignored rather than
   * rejected: the SDK adds part kinds between minor versions, and a run must
   * not fail because a new one appeared. */
  handle(part: TextStreamPart<ToolSet>): void {
    switch (part.type) {
      case "text-delta": {
        if (part.text === "") {
          return;
        }
        this.#setThinking(false);
        this.#text += part.text;
        this.#handlers.onTextDelta?.(this.assistantTurnId, part.text);
        return;
      }
      case "reasoning-start":
        this.#setThinking(true);
        return;
      case "reasoning-end":
        this.#setThinking(false);
        return;
      case "source": {
        // Grounded answers reach the SDK two ways depending on which Gemini
        // API the provider used: `groundingMetadata` on the step, or `source`
        // parts. Both end up in the same synthetic `google_search` result, so
        // the timeline and the Sources footer do not care which one arrived.
        if (part.sourceType === "url" && part.url !== "") {
          this.#sources.push({ url: part.url, title: part.title ?? part.url });
        }
        return;
      }
      case "tool-call": {
        this.#setThinking(false);
        this.#assistantBlocks.push({
          type: "toolUse",
          id: part.toolCallId,
          name: part.toolName,
          input: part.input,
        });
        return;
      }
      case "tool-result": {
        this.#toolResults.push({
          type: "toolResult",
          toolUseId: part.toolCallId,
          content: part.output,
          isError: false,
        });
        return;
      }
      case "tool-error": {
        this.#toolResults.push({
          type: "toolResult",
          toolUseId: part.toolCallId,
          content: { error: errorText(part.error) },
          isError: true,
        });
        return;
      }
      case "finish-step": {
        this.#setThinking(false);
        this.#applyGrounding(part.providerMetadata);
        this.#commitStep();
        return;
      }
      default:
        return;
    }
  }

  /**
   * Google Search grounding produces no tool call: the search happened inside
   * the provider and comes back as metadata on the step. Turning it into the
   * same `toolUse`/`toolResult` pair the owned tools produce is what lets the
   * timeline and the Sources footer render a grounded answer without a second
   * code path (`04-agent-runtime.md` §6.2). The Search Suggestions block is
   * carried through because Google's terms require displaying it.
   */
  #applyGrounding(metadata: unknown): void {
    const grounding = groundingOf(metadata);
    const queries = grounding?.webSearchQueries ?? [];
    const chunks = grounding?.groundingChunks ?? [];
    const results: { url: string; title: string }[] = [];
    const seen = new Set<string>();
    for (const source of [
      ...chunks.flatMap((chunk) =>
        chunk.web?.uri === undefined || chunk.web.uri === null
          ? []
          : [{ url: chunk.web.uri, title: chunk.web.title ?? chunk.web.uri }],
      ),
      ...this.#sources,
    ]) {
      if (seen.has(source.url)) {
        continue;
      }
      seen.add(source.url);
      results.push(source);
    }
    if (queries.length === 0 && results.length === 0) {
      return;
    }
    // Billing is per query, several per prompt (`04` §6.2). A step that
    // grounded without naming its queries still cost one search.
    this.#handlers.onGroundedSearch?.(Math.max(queries.length, 1));
    const entryPoint = grounding?.searchEntryPoint?.renderedContent;
    const toolUseId = `${this.assistantTurnId}-google-search`;
    this.#assistantBlocks.push({
      type: "toolUse",
      id: toolUseId,
      name: "google_search",
      input: { queries },
    });
    this.#toolResults.push({
      type: "toolResult",
      toolUseId,
      content: {
        results,
        ...(entryPoint === undefined || entryPoint === null
          ? {}
          : { searchEntryPoint: entryPoint }),
      },
      isError: false,
    });
  }

  #commitStep(): void {
    const assistantBlocks = this.#currentAssistantBlocks();
    if (assistantBlocks.length > 0) {
      const turn = this.#makeTurn(this.assistantTurnId, "assistant", assistantBlocks, true);
      this.#committed.push(turn);
      this.#handlers.onTurnCommitted?.(turn);
    }
    if (this.#toolResults.length > 0) {
      const turn = this.#makeTurn(this.userTurnId, "user", [...this.#toolResults], true);
      this.#committed.push(turn);
      this.#handlers.onTurnCommitted?.(turn);
    }
    this.#assistantBlocks = [];
    this.#toolResults = [];
    this.#sources = [];
    this.#text = "";
    this.#step += 1;
  }

  /**
   * Commits whatever the stream left open. A cancelled or failed attempt keeps
   * its partial text — the user is looking at it — so the last step is closed
   * as a turn rather than discarded.
   */
  finish(): void {
    if (this.#text !== "" || this.#assistantBlocks.length > 0 || this.#toolResults.length > 0) {
      this.#commitStep();
    }
    this.#setThinking(false);
  }
}

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message: unknown = error.message;
    if (typeof message === "string") {
      return message;
    }
  }
  // A provider-executed tool reports its failure as the JSON payload it would
  // have returned, not as an `Error` (`ai` turns a `tool-result` carrying
  // `isError` into a `tool-error` whose `error` is that value). `String()` on
  // it is "[object Object]", which tells the reader nothing.
  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      // Circular, or a value `JSON` refuses: there is nothing left to say
      // about it that is more useful than that it failed.
      return "the tool reported an error that could not be read";
    }
  }
  return String(error);
}
