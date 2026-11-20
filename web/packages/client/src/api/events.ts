// The SSE bridge (07 §4.2, `05-run-lifecycle-and-streaming.md` §4, §9).
//
// One `events.subscribe` subscription for the app's lifetime. Incoming events
// are queued and flushed on a 16 ms trailing timer, and a flush runs inside
// `notifyManager.batch` so batched patches yield a single render.
//
// Event routing is defined once, here: run events go to the `liveTurns`
// store and never touch the query cache (high-frequency run events would
// repeatedly invalidate list queries), everything else is a targeted
// `setQueryData` through the reducers in `@session/shared`, and malformed or
// unsupported events trigger scoped invalidations to refetch affected caches.

import type {
  ParsedSessionEvent,
  RecentActivityItem,
  User,
  ResearchHighlightFeedItem,
  ResearchNodeContent,
  ResearchTreeDetail,
  SessionEvent,
  Workspace,
} from "@session/shared";
import {
  parseSessionEvent,
  recentActivityItemId,
  recentActivityItemSchema,
  patchResearchNodeContent,
} from "@session/shared";
import { recentResearchQueryFromNode } from "@session/shared/lib/activity";
import {
  patchResearchDetailHighlightCreated,
  patchResearchDetailHighlightsRemoved,
  patchResearchDetailNode,
  patchResearchDetailTree,
  patchResearchSummaryForCreatedNode,
  patchResearchSummaryForNode,
  patchResearchSummaryForRemovedNodes,
  removeResearchDetailNodes,
} from "@session/shared/lib/researchEvents";
import { notifyManager, type QueryClient } from "@tanstack/react-query";

import { forgetThread } from "../features/thread/persistence.js";
import { useConnectionStore } from "../stores/connection.js";
import { useLiveTurnsStore, type RunEvent } from "../stores/liveTurns.js";
import { hideLocalAccountState } from "../stores/localAccount.js";
import { useNotificationsStore } from "../stores/notifications.js";
import { useRecapPendingStore } from "../stores/recapPending.js";
import { normalizeSettings, useSettingsStore } from "../stores/settings.js";

import { setEventInterest } from "./api.js";
import {
  cachedNode,
  cachedTreeTitle,
  dropActiveNodes,
  dropFromSharedLists,
  eachTreeList,
  eventPatchedListKeys,
  invalidateHighlightLabels,
  invalidateKeys as invalidate,
  mapSummaries,
  mergeTreeEvent,
  patchActiveNodes,
  patchActivityFeedItem,
  patchActivityFeedNode,
  patchDetail,
  patchDetailQueue,
  patchSummaryFromTreeEvent,
  queryKeys,
  removeActivityFeedItem,
  treeEventOmitsOwnState,
  treeIdForNode,
  writeDetailSummary,
  type ActivityQueryScope,
} from "./cache.js";
import { trpc, type SessionTrpcClient } from "./trpc.js";

/** Matches the desktop's `useSessionEvents.ts:37-51`. */
export const EVENT_COALESCE_MS = 16;

/** The interest set is published on a trailing debounce timer to coalesce
 * rapid document opens (`03-api-and-events.md` §3). */
export const INTEREST_DEBOUNCE_MS = 200;

/** Interval to renew open-thread declarations. Server declarations expire after
 * 90 s (`PRESENCE_TTL_MS`), so this renewal interval accounts for delayed timer
 * execution in background tabs. */
export const TREE_INTEREST_RENEW_MS = 30_000;

/** Duration after which an undeclared open thread declaration lapses on the
 * server. If elapsed, non-member public thread readers refetch the thread when
 * the tab becomes visible. */
export const TREE_INTEREST_LAPSE_MS = 90_000;

/** The first event of every connection (`routers/events.ts`). */
export const CONNECTION_READY = "connection.ready";

/* -------------------------------------------------------------------------
 * Run events
 * ---------------------------------------------------------------------- */

/** Narrows the parsed union into the subset `liveTurns` accepts. The parser
 * has already validated the turn and the sequence number, so nothing is cast
 * here. */
export function runEventFromParsed(event: ParsedSessionEvent): RunEvent | null {
  switch (event.type) {
    case "research.run.started":
      return { type: "run.started", nodeId: event.nodeId, seq: event.seq };
    case "research.run.thinking":
      return { type: "run.thinking", nodeId: event.nodeId, seq: event.seq };
    case "research.run.finished":
      return { type: "run.finished", nodeId: event.nodeId, seq: event.seq };
    case "research.turn.delta":
      return {
        type: "turn.delta",
        nodeId: event.nodeId,
        seq: event.seq,
        text: event.text,
        turnId: event.turnId,
      };
    case "research.turn.committed":
      return { type: "turn.committed", nodeId: event.nodeId, seq: event.seq, turn: event.turn };
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------
 * Applying one parsed research event
 * ---------------------------------------------------------------------- */

function applyResearchEvent(client: QueryClient, event: ParsedSessionEvent): void {
  switch (event.type) {
    case "research.tree.created": {
      const detail: ResearchTreeDetail = { tree: event.tree, nodes: [event.node] };
      // A redelivery must not overwrite existing detail that has already updated.
      if (client.getQueryData(queryKeys.tree(event.tree.id)) === undefined) {
        client.setQueryData(queryKeys.tree(event.tree.id), detail);
      }
      // Only the current user's lists for the workspace receive the new summary.
      writeDetailSummary(client, detail, { insert: true, keepExisting: true });
      patchActiveNodes(client, event.node);
      // Populate the feed root cache so the thread's card renders without an
      // additional request.
      const root = recentResearchQueryFromNode(event.node, true);
      if (root && client.getQueryData(queryKeys.feedRoot(event.tree.id)) === undefined) {
        client.setQueryData(queryKeys.feedRoot(event.tree.id), { ...root, children: [] });
      }
      return;
    }

    case "research.tree.updated":
    case "research.tree.archived":
    case "research.tree.restored": {
      invalidateHighlightLabels(client, cachedTreeTitle(client, event.tree.id), event.tree.title);
      // Remote updates omit user-specific fields (role, last view, Follow,
      // Archive, and Trash); preserve existing cached values.
      mapSummaries(client, (summary) => patchSummaryFromTreeEvent(summary, event.tree));
      patchDetail(client, event.tree.id, (detail) =>
        patchResearchDetailTree(detail, mergeTreeEvent(detail?.tree, event.tree)),
      );
      if (event.type !== "research.tree.updated") {
        // When remote archive or restore events omit user-specific state, refetch
        // the thread detail from the server.
        if (treeEventOmitsOwnState(event.tree)) invalidate(client, queryKeys.tree(event.tree.id));
        // Archiving changes the `includeArchived` scope of a thread. Invalidate
        // tree lists, shared lists, the highlights feed (which includes
        // unarchived threads only), and the feed root.
        invalidate(
          client,
          ["trees"],
          ["shared"],
          ["highlightsFeed"],
          queryKeys.feedRoot(event.tree.id),
        );
      }
      return;
    }

    case "research.tree.removed": {
      // Emitted when a thread is permanently deleted or moved to Trash (`trashed`).
      // The thread is removed from all non-trash lists. Saved navigation state
      // is retained if trashed, or cleared if permanently deleted.
      if (!event.trashed) forgetThread(event.treeId);
      eachTreeList(client, (summaries) => {
        const next = summaries.filter((summary) => summary.id !== event.treeId);
        return next.length === summaries.length ? summaries : next;
      });
      // Remove the thread from shared lists if the user left, was removed,
      // or the owner moved it to Trash.
      dropFromSharedLists(client, new Set([event.treeId]));
      // Invalidate active thread queries to display the unavailable state, and
      // remove inactive queries.
      client.removeQueries({ queryKey: queryKeys.tree(event.treeId), type: "inactive" });
      void client.invalidateQueries({ queryKey: queryKeys.tree(event.treeId) });
      client.removeQueries({ queryKey: queryKeys.feedRoot(event.treeId) });
      client.removeQueries({ queryKey: queryKeys.members(event.treeId) });
      client.removeQueries({ queryKey: queryKeys.invites(event.treeId) });
      dropActiveNodes(client, (node) => node.treeId === event.treeId);
      invalidate(client, ["highlightsFeed"]);
      return;
    }

    case "research.trash.changed":
      invalidate(
        client,
        event.workspaceId === undefined ? ["trash"] : queryKeys.trash(event.workspaceId),
        // A member's Trash holds shared threads too (`sharing.listShared`).
        queryKeys.shared("trash"),
      );
      return;

    case "research.drafts.changed":
      // Drafts are user-scoped; invalidate the drafts list for the specified
      // workspace.
      invalidate(client, queryKeys.drafts(event.workspaceId));
      return;

    case "research.node.created": {
      // Check whether the node is already cached to avoid duplicate count
      // increments on redelivery (07 §4.1).
      const known = cachedNode(client, event.node.treeId, event.node.id) !== undefined;
      patchDetail(client, event.node.treeId, (detail) =>
        patchResearchDetailNode(detail, event.node),
      );
      if (!known) {
        mapSummaries(client, (summary) =>
          patchResearchSummaryForCreatedNode(summary, event.node, event.timestamp),
        );
      }
      patchActiveNodes(client, event.node);
      // A Home card lists its root's direct follow-ups.
      invalidate(client, queryKeys.feedRoot(event.node.treeId));
      return;
    }

    case "research.node.updated": {
      const previous = cachedNode(client, event.node.treeId, event.node.id);
      invalidateHighlightLabels(
        client,
        previous === undefined ? undefined : (previous.title ?? null),
        event.node.title ?? null,
      );
      patchDetail(client, event.node.treeId, (detail) =>
        patchResearchDetailNode(detail, event.node),
      );
      client.setQueryData<ResearchNodeContent>(queryKeys.nodeContent(event.node.id), (content) =>
        content ? (patchResearchNodeContent(content, event) ?? content) : content,
      );
      if (previous) {
        mapSummaries(client, (summary) =>
          patchResearchSummaryForNode(summary, previous, event.node, event.timestamp),
        );
      } else {
        invalidate(client, ["trees"]);
      }
      patchActiveNodes(client, event.node);
      patchActivityFeedNode(client, event.node);
      return;
    }

    case "research.node.removed": {
      const detail = client.getQueryData<ResearchTreeDetail>(queryKeys.tree(event.treeId));
      const removed = new Set(event.removedNodeIds);
      const removedNodes = (detail?.nodes ?? []).filter((node) => removed.has(node.id));
      patchDetail(client, event.treeId, (current) =>
        removeResearchDetailNodes(current, event.treeId, removed),
      );
      mapSummaries(client, (summary) =>
        patchResearchSummaryForRemovedNodes(summary, event.treeId, removedNodes, event.timestamp),
      );
      dropActiveNodes(client, (node) => removed.has(node.id));
      for (const nodeId of removed) {
        client.removeQueries({ queryKey: queryKeys.nodeContent(nodeId) });
      }
      invalidate(client, ["highlightsFeed"], queryKeys.feedRoot(event.treeId));
      return;
    }

    case "research.document.updated": {
      const knownNode = cachedNode(client, event.tree.id, event.node.id);
      invalidateHighlightLabels(
        client,
        knownNode === undefined ? undefined : (knownNode.title ?? null),
        event.node.title ?? null,
      );
      mapSummaries(client, (summary) => patchSummaryFromTreeEvent(summary, event.tree));
      patchDetail(client, event.tree.id, (detail) => {
        const withTree = patchResearchDetailTree(detail, mergeTreeEvent(detail?.tree, event.tree));
        return patchResearchDetailNode(withTree, event.node);
      });
      // The event payload does not include markdown content; refetch the
      // node content and feed root preview.
      invalidate(client, queryKeys.nodeContent(event.node.id), queryKeys.feedRoot(event.tree.id));
      if (event.removedHighlightCount > 0) invalidate(client, ["highlightsFeed"]);
      return;
    }

    case "research.highlight.created": {
      const treeId = treeIdForNode(client, event.nodeId);
      if (treeId) {
        patchDetail(client, treeId, (detail) =>
          patchResearchDetailHighlightCreated(detail, event.nodeId, event.highlight),
        );
      }
      // The feed row includes the tree and node labels, which the event does not.
      invalidate(client, ["highlightsFeed"]);
      return;
    }

    case "research.highlights.removed": {
      const ids = event.highlightIds;
      const treeId = treeIdForNode(client, event.nodeId);
      if (treeId) {
        patchDetail(client, treeId, (detail) =>
          patchResearchDetailHighlightsRemoved(detail, event.nodeId, ids),
        );
      }
      const removed = new Set(ids);
      client.setQueriesData<ResearchHighlightFeedItem[]>(
        { queryKey: ["highlightsFeed"] },
        (items) => {
          if (!items) return items;
          const next = items.filter((item) => !removed.has(item.highlightId));
          return next.length === items.length ? items : next;
        },
      );
      return;
    }

    case "research.folders.changed":
      // The event payload carries no folder state; refetch the workspace folder
      // state.
      invalidate(
        client,
        event.workspaceId === undefined ? ["folders"] : queryKeys.folders(event.workspaceId),
      );
      return;

    case "research.recap.pending":
      // Transient UI state without cache persistence: indicates whether the recap
      // generation job is in progress while awaiting the node update (09 §2).
      useRecapPendingStore.getState().set(event.nodeId, event.pending);
      return;

    case "research.queue.changed":
      // The event payload contains the complete chain queue, replacing the cached
      // queue.
      patchDetailQueue(client, event.treeId, event.headNodeId, event.items);
      return;

    case "models.updated": {
      client.setQueryData<{ models: unknown[] }>(queryKeys.runtimeConfig(), (config) =>
        config ? { ...config, models: event.models } : config,
      );
      return;
    }

    case "notification.requested": {
      // Invalidate the notifications inbox query.
      invalidate(client, ["notifications"]);
      // Enforce the `showNotifications` preference for client toasts at the event ingress.
      if (!useSettingsStore.getState().settings.showNotifications) return;
      const { id, title, body, tone, timeoutMs, createdAt, href } = event.notification;
      useNotificationsStore.getState().push({
        id,
        title,
        body,
        tone,
        timeoutMs,
        createdAt,
        ...(href === undefined ? {} : { href }),
      });
      return;
    }

    case "notifications.read":
      // Marked read in another tab (or this one, after its own patch).
      invalidate(client, ["notifications"]);
      return;

    case "research.sharing.changed":
      // Invalidate tree lists, shared lists, thread detail, members, invites,
      // and feed root queries when sharing settings change.
      invalidate(
        client,
        ["trees"],
        ["shared"],
        queryKeys.tree(event.treeId),
        queryKeys.members(event.treeId),
        queryKeys.invites(event.treeId),
        queryKeys.feedRoot(event.treeId),
      );
      return;

    case "research.invites.changed":
      // Invalidate received invitations when an invitation for the user is created.
      invalidate(client, queryKeys.receivedInvites());
      return;

    case "research.presence.changed":
      // The event payload contains the full list of active thread viewers.
      client.setQueryData(queryKeys.presence(event.treeId), event.viewers);
      return;

    case "research.run.started":
    case "research.run.thinking":
    case "research.turn.delta":
    case "research.turn.committed":
    case "research.run.finished":
      // Handled by the caller, which routes them to `liveTurns`.
      return;
  }
}

/* -------------------------------------------------------------------------
 * Non-research events
 * ---------------------------------------------------------------------- */

interface FeedEventMetadata {
  id: string;
  kind: "research";
  authorId: string;
  workspaceId: string | null;
}

function feedEventMetadata(payload: Record<string, unknown>): FeedEventMetadata | null {
  const id = payload["id"];
  const kind = payload["kind"];
  const authorId = payload["authorId"];
  const workspaceId = payload["workspaceId"];
  if (
    typeof id !== "string" ||
    kind !== "research" ||
    typeof authorId !== "string" ||
    (workspaceId !== null && typeof workspaceId !== "string")
  ) {
    return null;
  }
  return { id, kind, authorId, workspaceId };
}

function cachedActivityScopes(client: QueryClient): ActivityQueryScope[] {
  const scopes: ActivityQueryScope[] = [];
  for (const query of client.getQueryCache().findAll({ queryKey: ["activity"] })) {
    const value = query.queryKey[1];
    if (typeof value !== "object" || value === null) continue;
    const scope = (value as Record<string, unknown>)["scope"];
    const workspaceId = (value as Record<string, unknown>)["workspaceId"];
    if (
      (scope !== "all" && scope !== "mine" && scope !== "workspace") ||
      (workspaceId !== null && typeof workspaceId !== "string")
    ) {
      continue;
    }
    scopes.push({ scope, workspaceId });
  }
  return scopes;
}

function feedItemBelongs(
  scope: ActivityQueryScope,
  metadata: FeedEventMetadata,
  userId: string | null,
): boolean {
  if (scope.scope === "all") return true;
  if (userId === null || metadata.authorId !== userId) return false;
  if (scope.scope === "mine") return true;
  return metadata.workspaceId === scope.workspaceId;
}

function applyFeedItemUpserted(client: QueryClient, payload: Record<string, unknown>): void {
  const metadata = feedEventMetadata(payload);
  const parsed = recentActivityItemSchema.safeParse(payload["item"]);
  if (!metadata || !parsed.success) {
    invalidate(client, ["activity"]);
    return;
  }
  const item: RecentActivityItem = parsed.data;
  const expectedId = `research:${metadata.id}`;
  if (recentActivityItemId(item) !== expectedId) {
    invalidate(client, ["activity"]);
    return;
  }
  const userId = client.getQueryData<User>(queryKeys.me())?.id ?? null;
  for (const scope of cachedActivityScopes(client)) {
    const key = queryKeys.activity(scope);
    if (!feedItemBelongs(scope, metadata, userId)) {
      removeActivityFeedItem(client, key, expectedId);
      continue;
    }
    if (!patchActivityFeedItem(client, key, item)) invalidate(client, key);
  }
  // Update cached feed root if the item is a thread root entry with follow-ups.
  const rootKey = queryKeys.feedRoot(item.query.treeId);
  if (client.getQueryData(rootKey) !== undefined && item.query.parentNodeId == null) {
    client.setQueryData(rootKey, item.query);
  }
}

function applyFeedItemRemoved(client: QueryClient, payload: Record<string, unknown>): void {
  const metadata = feedEventMetadata(payload);
  if (!metadata) {
    invalidate(client, ["activity"]);
    return;
  }
  const userId = client.getQueryData<User>(queryKeys.me())?.id ?? null;
  const id = `research:${metadata.id}`;
  for (const scope of cachedActivityScopes(client)) {
    if (feedItemBelongs(scope, metadata, userId)) {
      removeActivityFeedItem(client, queryKeys.activity(scope), id);
    }
  }
}

function applyOtherEvent(client: QueryClient, event: SessionEvent): void {
  const payload = event.payload;
  switch (event.type) {
    case "feed.item.upserted":
      applyFeedItemUpserted(client, payload);
      return;

    case "feed.item.removed":
      applyFeedItemRemoved(client, payload);
      return;

    case "workspace.created":
    case "workspace.updated": {
      const workspace = payload["workspace"] as Workspace | undefined;
      if (!workspace || typeof workspace.id !== "string") return;
      client.setQueryData<(Workspace & { treeCount: number })[]>(
        queryKeys.workspaces(),
        (workspaces) => {
          if (!workspaces) return workspaces;
          const index = workspaces.findIndex((existing) => existing.id === workspace.id);
          if (index === -1) {
            // A newly created workspace event lacks tree count metadata;
            // refetch the workspaces list.
            invalidate(client, queryKeys.workspaces());
            return workspaces;
          }
          const next = [...workspaces];
          next[index] = { ...workspaces[index], ...workspace } as Workspace & {
            treeCount: number;
          };
          next.sort((left, right) => left.position - right.position);
          return next;
        },
      );
      return;
    }

    case "workspace.removed": {
      const workspaceId = payload["workspaceId"];
      if (typeof workspaceId !== "string") return;
      client.setQueryData<Workspace[]>(queryKeys.workspaces(), (workspaces) =>
        workspaces ? workspaces.filter((workspace) => workspace.id !== workspaceId) : workspaces,
      );
      client.removeQueries({ queryKey: queryKeys.folders(workspaceId) });
      invalidate(client, ["trees"], ["highlightsFeed"]);
      return;
    }

    case "settings.updated": {
      const settings = payload["settings"];
      if (typeof settings !== "object" || settings === null) return;
      client.setQueryData(queryKeys.settings(), settings);
      // Synchronize the local settings store with the updated server settings (06 §6).
      useSettingsStore.getState().replace(normalizeSettings(settings));
      return;
    }

    default:
      return;
  }
}

/* -------------------------------------------------------------------------
 * The batch
 * ---------------------------------------------------------------------- */

/** Query keys refetched upon reconnect to restore event-maintained state (07 §4.2). */
const RECONNECT_KEYS: readonly (readonly unknown[])[] = eventPatchedListKeys.map((scope) => [
  scope,
]);

/** Applies one coalesced batch. Exported for the tests, which drive it
 * directly rather than through a socket. */
export function applyEventBatch(events: readonly SessionEvent[], client: QueryClient): void {
  const liveTurns = useLiveTurnsStore.getState();
  for (const event of events) {
    const parsed = parseSessionEvent(event);
    switch (parsed.kind) {
      case "event": {
        const runEvent = runEventFromParsed(parsed.event);
        if (runEvent) {
          liveTurns.applyRunEvent(runEvent);
          break;
        }
        applyResearchEvent(client, parsed.event);
        break;
      }
      case "malformed":
      case "unsupported":
        // Discard events that fail parsing and refetch the affected scope
        // instead (`07` §4.2).
        invalidate(client, ...scopeFor(parsed.type));
        break;
      case "notResearch":
        applyOtherEvent(client, event);
        break;
    }
  }
}

/** Cache keys potentially affected by an unparseable event of the given type. */
function scopeFor(type: string): readonly (readonly unknown[])[] {
  if (type.startsWith("models.")) return [queryKeys.runtimeConfig()];
  return [
    ["trees"],
    ["tree"],
    ["activity"],
    ["feedRoot"],
    ["highlightsFeed"],
    ["activeNodes"],
    ["drafts"],
    ["trash"],
  ];
}

/* -------------------------------------------------------------------------
 * Interest
 * ---------------------------------------------------------------------- */

/** Reference count of mounted document views by node id to retain interest
 * while any view remains mounted. */
const interest = new Map<string, number>();
/** Reference count of open threads by tree id for presence tracking and
 * non-member event subscriptions. */
const treeInterest = new Map<string, number>();
let interestTimer: ReturnType<typeof setTimeout> | null = null;
let publishInterest: ((nodeIds: string[], treeIds: string[]) => void) | null = null;

function publishNow(): void {
  publishInterest?.([...interest.keys()], [...treeInterest.keys()]);
}

function scheduleInterest(): void {
  if (interestTimer !== null) clearTimeout(interestTimer);
  interestTimer = setTimeout(() => {
    interestTimer = null;
    publishNow();
  }, INTEREST_DEBOUNCE_MS);
}

/** Registers a thread as open. Returns the release function. While a thread
 * is open, the bridge renews interest every `TREE_INTEREST_RENEW_MS` and when
 * tab visibility is restored. */
export function addTreeInterest(treeId: string): () => void {
  treeInterest.set(treeId, (treeInterest.get(treeId) ?? 0) + 1);
  scheduleInterest();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (treeInterest.get(treeId) ?? 1) - 1;
    if (count <= 0) treeInterest.delete(treeId);
    else treeInterest.set(treeId, count);
    scheduleInterest();
  };
}

export function interestedTreeIds(): string[] {
  return [...treeInterest.keys()];
}

/** Registers a node as displayed. Returns the release function. */
export function addNodeInterest(nodeId: string): () => void {
  interest.set(nodeId, (interest.get(nodeId) ?? 0) + 1);
  scheduleInterest();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (interest.get(nodeId) ?? 1) - 1;
    if (count <= 0) interest.delete(nodeId);
    else interest.set(nodeId, count);
    scheduleInterest();
  };
}

export function interestedNodeIds(): string[] {
  return [...interest.keys()];
}

/** Test helper: clears active interest tracking and any pending publish timer. */
export function resetNodeInterest(): void {
  interest.clear();
  treeInterest.clear();
  if (interestTimer !== null) clearTimeout(interestTimer);
  interestTimer = null;
}

/* -------------------------------------------------------------------------
 * The subscription
 * ---------------------------------------------------------------------- */

export interface EventBridgeHandle {
  /** The connection ID assigned by the server once announced. */
  connectionId: () => string | null;
  /** Publishes the interest set immediately rather than waiting for the trailing timer. */
  flushInterest: () => void;
  close: () => void;
}

export interface EventBridgeOptions {
  queryClient: QueryClient;
  client?: SessionTrpcClient;
  /** Replaced in tests; defaults to `events.setInterest`. */
  setInterest?: (connectionId: string, nodeIds: string[], treeIds: string[]) => Promise<unknown>;
  /** How often open thread interest is renewed; overridden in tests. Defaults
   * to `TREE_INTEREST_RENEW_MS`. */
  renewIntervalMs?: number;
  /** Action invoked when the event stream reports an expired or invalid
   * session. Defaults to navigation to `/login`. */
  onUnauthorized?: () => void;
}

/**
 * Determines whether a subscription error indicates an expired or invalid session.
 *
 * `TRPCClientError` includes the formatter's `data.code`; the raw shape is read
 * as well, because an error that crossed the SSE framing retains `shape` and not
 * always `data`. Only an explicit unauthorized code initiates sign-out; a
 * transient connection drop triggers normal reconnection.
 */
export function isUnauthorizedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    data?: { code?: unknown } | null;
    shape?: { data?: { code?: unknown } } | null;
  };
  return candidate.data?.code === "UNAUTHORIZED" || candidate.shape?.data?.code === "UNAUTHORIZED";
}

/** The default `onUnauthorized`: a window navigation, not a router transition,
 * so every in-memory store and query cache reinitializes upon navigating to
 * `/login`. The current path is passed to `/login` matching route guard
 * redirect behavior. */
function redirectToLogin(): void {
  const here = `${window.location.pathname}${window.location.search}`;
  const target = here === "/login" ? "/login" : `/login?redirect=${encodeURIComponent(here)}`;
  window.location.assign(target);
}

/**
 * Opens and maintains the event subscription for the application lifetime.
 * The transport reconnects automatically with backoff. Each reconnection
 * invalidates event-patched lists and re-seeds snapshots for displayed active
 * nodes, as the stream maintains no replay buffer
 * (`05-run-lifecycle-and-streaming.md` §4).
 */
export function connectEventBridge(options: EventBridgeOptions): EventBridgeHandle {
  const { queryClient } = options;
  const client = options.client ?? trpc();
  const publish = options.setInterest ?? setEventInterest;
  const onUnauthorized = options.onUnauthorized ?? redirectToLogin;
  const connection = useConnectionStore.getState();

  let connectionId: string | null = null;
  /** Tracks whether sign-out has been initiated to prevent repeated triggers
   * while awaiting navigation. */
  let signedOut = false;
  /** Reset on each `connection.ready` event so session validity is verified
   * once per disconnection. */
  let sessionChecked = false;
  let queue: SessionEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let opened = false;

  const flush = (): void => {
    flushTimer = null;
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    // One render for the whole batch rather than one per patch (07 §4.2).
    notifyManager.batch(() => {
      applyEventBatch(batch, queryClient);
    });
  };

  const enqueue = (event: SessionEvent): void => {
    queue.push(event);
    flushTimer ??= setTimeout(flush, EVENT_COALESCE_MS);
  };

  /** When open threads were last declared, for the lapse check. */
  let lastTreePublish = 0;
  const publisher = (nodeIds: string[], treeIds: string[]): void => {
    if (connectionId === null) return;
    if (treeIds.length > 0) lastTreePublish = Date.now();
    void publish(connectionId, nodeIds, treeIds).catch(() => {
      // A failed publish is not retried here: the renewal timer and a
      // reconnect republish the whole interest set anyway.
    });
  };
  publishInterest = publisher;

  // Renew open thread declarations before server expiration (90 s) and
  // immediately upon tab visibility. If a declaration may have expired,
  // refetch the thread and presence queries.
  const renewTimer = setInterval(() => {
    if (treeInterest.size > 0 && publishInterest === publisher) publishNow();
  }, options.renewIntervalMs ?? TREE_INTEREST_RENEW_MS);
  // Under Node (the tests) the timer must not keep the process alive.
  (renewTimer as { unref?: () => void }).unref?.();
  const onVisibility = (): void => {
    if (document.visibilityState !== "visible" || treeInterest.size === 0) return;
    if (publishInterest !== publisher || connectionId === null) return;
    const lapsed = Date.now() - lastTreePublish > TREE_INTEREST_LAPSE_MS;
    publishNow();
    if (!lapsed) return;
    for (const treeId of treeInterest.keys()) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tree(treeId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.presence(treeId) });
    }
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }

  const signOut = (): void => {
    if (signedOut) return;
    signedOut = true;
    // Preserve unsent local account drafts and branches in storage while
    // hiding them from active state until re-authentication (`stores/localAccount.ts`).
    hideLocalAccountState();
    onUnauthorized();
  };

  /**
   * Verify the authentication session once per disconnection. Because transport-level
   * subscription errors do not distinguish between 401 Unauthorized and network drops,
   * query `auth.me` directly. A response returning null confirms session expiration and
   * triggers sign-out; network errors rely on client reconnection.
   */
  const verifySession = (): void => {
    if (signedOut || sessionChecked) return;
    sessionChecked = true;
    void client.auth.me
      .query()
      .then((user) => {
        if (closed) return;
        queryClient.setQueryData(queryKeys.me(), user);
        if (user === null) signOut();
      })
      .catch(() => {
        // Unreachable server: transport reconnection handles recovery.
        sessionChecked = false;
      });
  };

  const resynchronize = (): void => {
    // Clear transient pending recap states on reconnect; completed or running
    // recap states synchronize via refetched node queries and subsequent updates.
    useRecapPendingStore.getState().clear();
    for (const key of RECONNECT_KEYS) void queryClient.invalidateQueries({ queryKey: key });
    for (const nodeId of interest.keys()) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.nodeContent(nodeId) });
    }
  };

  const subscription = client.events.subscribe.subscribe(undefined, {
    onData: (event) => {
      if (closed) return;
      if (event.type === CONNECTION_READY) {
        const id = event.payload["connectionId"];
        if (typeof id === "string") {
          connectionId = id;
          // Interest is per connection, so a reconnect republishes it.
          publishNow();
        }
        sessionChecked = false;
        connection.setStatus("open");
        if (opened) resynchronize();
        opened = true;
        return;
      }
      enqueue(event);
    },
    onConnectionStateChange: (state) => {
      if (closed) return;
      switch (state.state) {
        case "pending":
          useConnectionStore.getState().setStatus("open");
          return;
        case "connecting":
          useConnectionStore.getState().setStatus("connecting");
          return;
        case "idle":
          useConnectionStore.getState().setStatus("closed");
          return;
      }
    },
    onError: (error) => {
      if (closed) return;
      useConnectionStore.getState().setStatus("connecting");
      // Stop reconnecting after session expiration to prevent reconnect loops
      // during sign-out.
      if (isUnauthorizedError(error)) signOut();
      else verifySession();
    },
    onStopped: () => {
      if (!closed) useConnectionStore.getState().setStatus("closed");
    },
  });

  return {
    connectionId: () => connectionId,
    flushInterest: () => {
      if (interestTimer !== null) {
        clearTimeout(interestTimer);
        interestTimer = null;
      }
      publishNow();
    },
    close: () => {
      closed = true;
      clearInterval(renewTimer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
      queue = [];
      // Only clear the shared callback if it belongs to this instance; a
      // newly mounted bridge may have installed its own.
      if (publishInterest === publisher) publishInterest = null;
      subscription.unsubscribe();
      useConnectionStore.getState().setStatus("closed");
    },
  };
}
