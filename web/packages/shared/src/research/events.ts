// The web's additions to the research event parser in `lib/researchEvents.ts`
// (`03-api-and-events.md` §3): the run streaming events
// (`05-run-lifecycle-and-streaming.md` §4), `models.updated`, and the patch
// that applies a node event's queue position to the content a viewer shows.
// Every other research event, and the reducers that apply them to cached
// trees and summaries, come from the desktop's module unchanged.

import { parseResearchEvent } from "../lib/researchEvents.js";
import { isTurn } from "../schemas/turn.js";
import type { ModelInfo, ModelProvider } from "../types/account.js";
import type {
  ParsedResearchEvent,
  ResearchNodeContent,
  ResearchNodeEvent,
  ResearchNodeStatus,
  SessionEvent,
  Turn,
} from "../wire/index.js";

/** An attempt opened its provider stream. `attempt` distinguishes a retry or
 * auto-resume from the original run, so a viewer showing a stale attempt's
 * output can drop it. */
interface RunStartedEvent {
  type: "research.run.started";
  nodeId: string;
  attempt: number;
  seq: number;
  model: string;
  timestamp: number;
}

/** Reasoning is or is no longer streaming. No reasoning content is sent. */
interface RunThinkingEvent {
  type: "research.run.thinking";
  nodeId: string;
  seq: number;
  active: boolean;
  timestamp: number;
}

/** Text appended to the in-flight turn since the previous delta. */
interface TurnDeltaEvent {
  type: "research.turn.delta";
  nodeId: string;
  seq: number;
  turnId: string;
  text: string;
  timestamp: number;
}

/** A durable turn, replacing any live turn with the same id. */
interface TurnCommittedEvent {
  type: "research.turn.committed";
  nodeId: string;
  seq: number;
  turn: Turn;
  timestamp: number;
}

/** The attempt settled. Precedes the terminal `research.node.updated`, which
 * remains the authoritative carrier of the node. */
interface RunFinishedEvent {
  type: "research.run.finished";
  nodeId: string;
  attempt: number;
  seq: number;
  status: ResearchNodeStatus;
  error?: string;
  timestamp: number;
}

/** Provider availability changed, so the model picker's entries changed. */
interface ModelsUpdatedEvent {
  type: "models.updated";
  models: ModelInfo[];
  timestamp: number;
}

export type ResearchRunEvent =
  RunStartedEvent | RunThinkingEvent | TurnDeltaEvent | TurnCommittedEvent | RunFinishedEvent;

/** Every event this build can apply: the desktop's research events, the run
 * events and `models.updated`. A closed union, so a new server event takes
 * the explicit recovery path until its client effects are implemented. */
export type ParsedSessionEvent = ParsedResearchEvent | ResearchRunEvent | ModelsUpdatedEvent;

export type SessionEventParseResult =
  | { kind: "event"; event: ParsedSessionEvent }
  | { kind: "notResearch" }
  | { kind: "unsupported"; type: string }
  | { kind: "malformed"; type: string };

const RUN_STATUSES = new Set<string>([
  "queued",
  "starting",
  "running",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
]);

const MODEL_PROVIDERS = new Set<ModelProvider>(["vertex", "openrouter", "anthropic"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isModelInfo(value: unknown): value is ModelInfo {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    typeof value.provider === "string" &&
    MODEL_PROVIDERS.has(value.provider as ModelProvider) &&
    typeof value.adminOnly === "boolean" &&
    typeof value.available === "boolean" &&
    typeof value.supportsFiles === "boolean" &&
    typeof value.supportsImages === "boolean"
  );
}

function parseRunEvent(
  type: string,
  payload: Record<string, unknown>,
  timestamp: number,
): ResearchRunEvent | null | undefined {
  const nodeId = payload.nodeId;
  const seq = payload.seq;
  switch (type) {
    case "research.run.started":
      return typeof nodeId === "string" &&
        isFiniteNumber(payload.attempt) &&
        isFiniteNumber(seq) &&
        typeof payload.model === "string"
        ? { type, nodeId, attempt: payload.attempt, seq, model: payload.model, timestamp }
        : null;
    case "research.run.thinking":
      return typeof nodeId === "string" &&
        isFiniteNumber(seq) &&
        typeof payload.active === "boolean"
        ? { type, nodeId, seq, active: payload.active, timestamp }
        : null;
    case "research.turn.delta":
      return typeof nodeId === "string" &&
        isFiniteNumber(seq) &&
        typeof payload.turnId === "string" &&
        typeof payload.text === "string"
        ? { type, nodeId, seq, turnId: payload.turnId, text: payload.text, timestamp }
        : null;
    case "research.turn.committed":
      return typeof nodeId === "string" && isFiniteNumber(seq) && isTurn(payload.turn)
        ? { type, nodeId, seq, turn: payload.turn as Turn, timestamp }
        : null;
    case "research.run.finished":
      return typeof nodeId === "string" &&
        isFiniteNumber(payload.attempt) &&
        isFiniteNumber(seq) &&
        typeof payload.status === "string" &&
        RUN_STATUSES.has(payload.status) &&
        (payload.error === undefined || payload.error === null || typeof payload.error === "string")
        ? {
            type,
            nodeId,
            attempt: payload.attempt,
            seq,
            status: payload.status as ResearchNodeStatus,
            // `exactOptionalPropertyTypes`: omit the key rather than set it
            // to undefined when the run finished without an error.
            ...(typeof payload.error === "string" ? { error: payload.error } : {}),
            timestamp,
          }
        : null;
    default:
      return undefined;
  }
}

/**
 * Narrows a server event into the closed union the client's reducers accept.
 * Run events and `models.updated` are parsed here; every other research event
 * goes through the desktop's `parseResearchEvent`.
 */
export function parseSessionEvent(event: SessionEvent): SessionEventParseResult {
  if (event.type === "models.updated") {
    const models = isRecord(event.payload) ? event.payload.models : undefined;
    return isFiniteNumber(event.timestamp) && Array.isArray(models) && models.every(isModelInfo)
      ? { kind: "event", event: { type: "models.updated", models, timestamp: event.timestamp } }
      : { kind: "malformed", type: event.type };
  }
  if (event.type.startsWith("research.run.") || event.type.startsWith("research.turn.")) {
    if (!isFiniteNumber(event.timestamp) || !isRecord(event.payload)) {
      return { kind: "malformed", type: event.type };
    }
    const parsed = parseRunEvent(event.type, event.payload, event.timestamp);
    if (parsed === undefined) {
      return { kind: "unsupported", type: event.type };
    }
    return parsed === null
      ? { kind: "malformed", type: event.type }
      : { kind: "event", event: parsed };
  }
  return parseResearchEvent(event);
}

/** Apply a node event to the content the viewer is showing for that node.
 *
 * The node and the queue position travel together on the event and are the
 * two fields of `ResearchNodeContent` a node event is authoritative for; the
 * turns are the streaming protocol's business. `queuePosition` is only ever
 * present while a node waits for admission, so an event without it clears the
 * cached one rather than leaving a stale place in the queue on screen. */
export function patchResearchNodeContent(
  content: ResearchNodeContent | null,
  event: Pick<ResearchNodeEvent, "node" | "queuePosition">,
): ResearchNodeContent | null {
  if (!content || content.node.id !== event.node.id) {
    return content;
  }
  if (content.node === event.node && content.queuePosition === event.queuePosition) {
    return content;
  }
  const next: ResearchNodeContent = { ...content, node: event.node };
  if (event.queuePosition === undefined) {
    delete next.queuePosition;
  } else {
    next.queuePosition = event.queuePosition;
  }
  return next;
}
