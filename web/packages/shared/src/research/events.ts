// The web's additions to the research event parser in `lib/researchEvents.ts`
// (`03-api-and-events.md` §3): the run streaming events
// (`05-run-lifecycle-and-streaming.md` §4), `models.updated`, and the patch
// that applies a node event's queue position to the content a viewer shows.
// Every other research event, and the reducers that apply them to cached
// trees and summaries, come from the desktop's module unchanged.

import { parseResearchEvent } from "../lib/researchEvents.js";
import { isTurn } from "../schemas/turn.js";
import type { ModelInfo, ModelProvider } from "../types/account.js";
import type { NotificationPayload, ThreadViewer } from "../types/sharing.js";
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

/** A server notification for this person: a run they asked finished, a new
 * question or note in a thread they follow, a branch from their answer, an
 * invitation. The server also stores it in the person's inbox
 * (`notifications.list`) under the same id. */
export interface NotificationRequestedEvent {
  type: "notification.requested";
  notification: NotificationPayload;
  timestamp: number;
}

/** Who has a thread open changed. */
export interface ResearchPresenceChangedEvent {
  type: "research.presence.changed";
  treeId: string;
  viewers: ThreadViewer[];
  timestamp: number;
}

/** The caller's access to a thread, or its members or visibility, changed:
 * lists and the thread refetch. */
export interface ResearchSharingChangedEvent {
  type: "research.sharing.changed";
  treeId: string;
  timestamp: number;
}

/** An invitation addressed to the caller's login was created. */
export interface ResearchInvitesChangedEvent {
  type: "research.invites.changed";
  treeId: string;
  timestamp: number;
}

/** Notifications in the caller's inbox were marked read (in any of their
 * tabs): the inbox and its unread count refetch. */
export interface NotificationsReadEvent {
  type: "notifications.read";
  timestamp: number;
}

/** The web's collaboration events (`03-api-and-events.md` §3). */
export type CollaborationEvent =
  | NotificationRequestedEvent
  | NotificationsReadEvent
  | ResearchPresenceChangedEvent
  | ResearchSharingChangedEvent
  | ResearchInvitesChangedEvent;

/** Every event this build can apply: the desktop's research events, the run
 * events, `models.updated` and the collaboration events. A closed union, so a
 * new server event takes the explicit recovery path until its client effects
 * are implemented. */
export type ParsedSessionEvent =
  ParsedResearchEvent | ResearchRunEvent | ModelsUpdatedEvent | CollaborationEvent;

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

const NOTIFICATION_TONES = new Set(["info", "success", "warning", "error"]);
const NOTIFICATION_KINDS = new Set(["runFinished", "followUp", "branch", "invite"]);

/** Narrows a `notification.requested` payload. Anything missing a required
 * field is rejected rather than shown as an incomplete toast. */
function notificationOf(payload: Record<string, unknown>): NotificationPayload | null {
  const { id, title, body, tone, timeoutMs, createdAt, href, kind, treeId } = payload;
  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    typeof body !== "string" ||
    !isFiniteNumber(timeoutMs) ||
    !isFiniteNumber(createdAt)
  ) {
    return null;
  }
  return {
    id,
    title,
    body,
    tone:
      typeof tone === "string" && NOTIFICATION_TONES.has(tone)
        ? (tone as NotificationPayload["tone"])
        : "info",
    timeoutMs,
    createdAt,
    ...(typeof href === "string" && href.startsWith("/") ? { href } : {}),
    ...(typeof kind === "string" && NOTIFICATION_KINDS.has(kind)
      ? { kind: kind as NonNullable<NotificationPayload["kind"]> }
      : {}),
    ...(typeof treeId === "string" ? { treeId } : {}),
  };
}

function isViewer(value: unknown): value is ThreadViewer {
  return (
    isRecord(value) &&
    typeof value.userId === "string" &&
    typeof value.login === "string" &&
    (value.name === null || typeof value.name === "string") &&
    (value.avatarUrl === null || typeof value.avatarUrl === "string")
  );
}

/** The collaboration events, or undefined for another type. */
function parseCollaborationEvent(event: SessionEvent): SessionEventParseResult | undefined {
  const { type, payload, timestamp } = event;
  if (
    type !== "notification.requested" &&
    type !== "notifications.read" &&
    type !== "research.presence.changed" &&
    type !== "research.sharing.changed" &&
    type !== "research.invites.changed"
  ) {
    return undefined;
  }
  if (!isFiniteNumber(timestamp) || !isRecord(payload)) {
    return { kind: "malformed", type };
  }
  switch (type) {
    case "notification.requested": {
      const notification = notificationOf(payload);
      return notification
        ? { kind: "event", event: { type, notification, timestamp } }
        : { kind: "malformed", type };
    }
    case "notifications.read":
      return { kind: "event", event: { type, timestamp } };
    case "research.presence.changed":
      return typeof payload.treeId === "string" &&
        Array.isArray(payload.viewers) &&
        payload.viewers.every(isViewer)
        ? {
            kind: "event",
            event: { type, treeId: payload.treeId, viewers: payload.viewers, timestamp },
          }
        : { kind: "malformed", type };
    case "research.sharing.changed":
    case "research.invites.changed":
      return typeof payload.treeId === "string"
        ? { kind: "event", event: { type, treeId: payload.treeId, timestamp } }
        : { kind: "malformed", type };
  }
}

/**
 * Narrows a server event into the closed union the client's reducers accept.
 * Run events, `models.updated` and the collaboration events are parsed here;
 * every other research event goes through the desktop's `parseResearchEvent`.
 */
export function parseSessionEvent(event: SessionEvent): SessionEventParseResult {
  const collaboration = parseCollaborationEvent(event);
  if (collaboration !== undefined) {
    return collaboration;
  }
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
