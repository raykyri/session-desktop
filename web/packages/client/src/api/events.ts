// The SSE bridge (07 §4.2, `05-run-lifecycle-and-streaming.md` §4, §9).
//
// One `events.subscribe` subscription for the app's lifetime. Incoming events
// are queued and flushed on a 16 ms trailing timer, and a flush runs inside
// `notifyManager.batch` so a burst of twenty patches yields one render rather
// than twenty.
//
// Event routing is defined once, here: run events go to the `liveTurns`
// store and never touch the query cache (a run at 30 events/s would invalidate
// list queries thirty times a second), everything else is a targeted
// `setQueryData` through the reducers in `@session/shared`, and anything the
// parser calls `malformed` or `unsupported` becomes a scoped invalidation, so
// an event the client cannot apply still triggers a refetch instead of
// leaving the cache stale.

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

/** The interest set is published on a trailing timer: opening five documents
 * in a row is one call, not five (`03-api-and-events.md` §3). */
export const INTEREST_DEBOUNCE_MS = 200;

/** How often the open threads are declared again while one stays open. The
 * server drops a declaration after 90 s (`PRESENCE_TTL_MS`); a background
 * tab's timers may run up to a minute late, so this leaves room for that. */
export const TREE_INTEREST_RENEW_MS = 30_000;

/** After this long without a declaration the server may have dropped an open
 * thread, and with it, for a reader of a public thread who is not a member,
 * the thread's events: the thread refetches when the tab is shown again. */
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
      // A redelivery must not replace a detail that has moved on since.
      if (client.getQueryData(queryKeys.tree(event.tree.id)) === undefined) {
        client.setQueryData(queryKeys.tree(event.tree.id), detail);
      }
      // Only the reader's own lists for the thread's workspace gain the row.
      writeDetailSummary(client, detail, { insert: true, keepExisting: true });
      patchActiveNodes(client, event.node);
      // The new thread's Home card reads its root from here, so it shows
      // without a round trip.
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
      // Another person's change arrives without the reader's own fields
      // (role, last view, Follow, Archive and Trash); those keep the values
      // the cache holds.
      mapSummaries(client, (summary) => patchSummaryFromTreeEvent(summary, event.tree));
      patchDetail(client, event.tree.id, (detail) =>
        patchResearchDetailTree(detail, mergeTreeEvent(detail?.tree, event.tree)),
      );
      if (event.type !== "research.tree.updated") {
        // What another person's Archive or restore means for the reader's
        // copy (the owner's Archive shows to members) is the server's answer.
        if (treeEventOmitsOwnState(event.tree)) invalidate(client, queryKeys.tree(event.tree.id));
        // Archiving moves the thread between the `includeArchived` scopes,
        // and which list it belongs to is the server's answer, not a patch's.
        // The highlights feed reads from unarchived threads only
        // (`db/repos/highlights.ts:feed`), so archiving retires this thread's
        // rows and restoring brings them back (`10` §4). A restored thread
        // (from the Archive or the Trash) has a Home card again, and an
        // archived one has none.
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
      // Sent for a thread deleted and for one moved to the Trash (`trashed`):
      // either way it leaves every list but the Trash's, which
      // `research.trash.changed` refetches. The thread's saved page state
      // (selection, unsent branches, scroll) is kept for Restore and goes
      // only with a deletion, as on the desktop.
      if (!event.trashed) forgetThread(event.treeId);
      eachTreeList(client, (summaries) => {
        const next = summaries.filter((summary) => summary.id !== event.treeId);
        return next.length === summaries.length ? summaries : next;
      });
      // A shared thread the reader left, was removed from or lost to its
      // owner's Trash leaves the shared lists too; a member's own Trash lists
      // it again through `research.trash.changed`.
      dropFromSharedLists(client, new Set([event.treeId]));
      // A thread page that has it open re-reads it, so a reader who lost it
      // gets the unavailable state (a removed query would leave the page
      // showing the copy it holds); a cached copy nobody shows is dropped.
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
      // Drafts are per person; the event names the workspace whose list
      // changed, and that list refetches.
      invalidate(client, queryKeys.drafts(event.workspaceId));
      return;

    case "research.node.created": {
      // A summary count is a delta, so it is added once per node: the tab that
      // forked has already counted it through `useForkResearchNode`, and a
      // redelivery after a reconnect must not count it again. Knowing the node
      // is what tells the two apart (07 §4.1).
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
      // The markdown itself is not on the event, so the open document refetches,
      // and so does its Home card's preview.
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
      // The event carries no state, as on the desktop: the workspace's folder
      // state refetches.
      invalidate(
        client,
        event.workspaceId === undefined ? ["folders"] : queryKeys.folders(event.workspaceId),
      );
      return;

    case "research.recap.pending":
      // A viewer hint with no cache behind it: the recap itself arrives as a
      // node update, which is what the summary and the document render from.
      // This only decides whether the answer shows a spinner in the recap's
      // slot while the job runs (09 §2).
      useRecapPendingStore.getState().set(event.nodeId, event.pending);
      return;

    case "research.queue.changed":
      // The event carries the chain's whole queue, so it replaces the cached
      // one rather than patching it.
      patchDetailQueue(client, event.treeId, event.headNodeId, event.items);
      return;

    case "models.updated": {
      client.setQueryData<{ models: unknown[] }>(queryKeys.runtimeConfig(), (config) =>
        config ? { ...config, models: event.models } : config,
      );
      return;
    }

    case "notification.requested": {
      // The server stored it in the inbox, which refetches whatever the
      // setting says.
      invalidate(client, ["notifications"]);
      // The bridge is the only ingress for server notifications, so the
      // `showNotifications` preference, which governs the toast only, is
      // enforced here.
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
      // Access, members or visibility changed: the lists, the thread and its
      // sharing state refetch.
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
      // A login invitation to the reader was created.
      invalidate(client, queryKeys.receivedInvites());
      return;

    case "research.presence.changed":
      // The event carries the thread's whole viewer list.
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
  // The item is the thread's root entry with its follow-ups: what a Home card
  // that loaded its root on its own shows (a note's edited text, a new
  // follow-up).
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
            // A workspace created in another tab arrives without its tree
            // count; the list refetches rather than displaying a guess.
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
      // Another tab changed them; the mirror follows the server (06 §6).
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

/** The lists a reconnect refetches: everything events keep fresh (07 §4.2). */
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

/** The caches an unparseable event of this type could have changed. */
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

/** Mounted document views, by node id, with a count so two views of one node
 * do not cancel each other's interest on unmount. */
const interest = new Map<string, number>();
/** Open threads, by tree id, counted the same way (web only: presence, and a
 * public thread's events for a reader who is not a member). */
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
 * is open the bridge declares the set again every `TREE_INTEREST_RENEW_MS`
 * and when the tab is shown again. */
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

/** Test helper: drops the registry and any pending publish. */
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
  /** The id the server assigned this connection, once it announced it. */
  connectionId: () => string | null;
  /** Publishes the interest set now rather than on the trailing timer. */
  flushInterest: () => void;
  close: () => void;
}

export interface EventBridgeOptions {
  queryClient: QueryClient;
  client?: SessionTrpcClient;
  /** Replaced in tests; defaults to `events.setInterest`. */
  setInterest?: (connectionId: string, nodeIds: string[], treeIds: string[]) => Promise<unknown>;
  /** How often open threads are declared again; replaced in tests. Defaults
   * to `TREE_INTEREST_RENEW_MS`. */
  renewIntervalMs?: number;
  /** What to do when the stream reports that the session is gone. Defaults to
   * a full navigation to `/login`. */
  onUnauthorized?: () => void;
}

/**
 * Whether a subscription error is the server saying the session is gone.
 *
 * `TRPCClientError` includes the formatter's `data.code`; the raw shape is read
 * too, because an error that crossed the SSE framing keeps `shape` and not
 * always `data`. Only an explicit unauthorized code signs the tab out; a
 * transient connection drop instead goes through the link's own reconnect.
 */
export function isUnauthorizedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    data?: { code?: unknown } | null;
    shape?: { data?: { code?: unknown } } | null;
  };
  return candidate.data?.code === "UNAUTHORIZED" || candidate.shape?.data?.code === "UNAUTHORIZED";
}

/** The default `onUnauthorized`: a real navigation, not a router push, so
 * every in-memory store and query cache is reinitialized on the way back to
 * `/login`. The path being left is handed to `/login` the same way the route
 * guard hands it over. */
function redirectToLogin(): void {
  const here = `${window.location.pathname}${window.location.search}`;
  const target = here === "/login" ? "/login" : `/login?redirect=${encodeURIComponent(here)}`;
  window.location.assign(target);
}

/**
 * Opens the subscription and keeps it open for the app's lifetime. The link
 * reconnects on its own with backoff; every (re)connect invalidates the
 * event-patched lists and re-seeds the snapshot of every displayed active
 * node, because the stream has no replay buffer
 * (`05-run-lifecycle-and-streaming.md` §4).
 */
export function connectEventBridge(options: EventBridgeOptions): EventBridgeHandle {
  const { queryClient } = options;
  const client = options.client ?? trpc();
  const publish = options.setInterest ?? setEventInterest;
  const onUnauthorized = options.onUnauthorized ?? redirectToLogin;
  const connection = useConnectionStore.getState();

  let connectionId: string | null = null;
  /** The sign-out is announced once; the link keeps retrying until the
   * navigation takes effect. */
  let signedOut = false;
  /** Reset on every `connection.ready`, so one lost session is checked once
   * per disconnection rather than once per retry. */
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

  // Open threads are declared again before the server's 90 s lapse, and at
  // once when the tab is shown again (a hidden tab's timers can run late). A
  // thread whose declaration may have lapsed refetches: a reader of a public
  // thread who is not a member got its events only through it.
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
    // The account's unsent drafts and branches stay stored for it and are
    // hidden until it signs in again (`stores/localAccount.ts`).
    hideLocalAccountState();
    onUnauthorized();
  };

  /**
   * One session check per disconnection. A subscription error does not say why
   * the stream ended — a native `EventSource` reports a refused 401 and a
   * dropped connection the same way — so the session itself is asked. Only a
   * successful `null` signs the tab out; a failed check is a network problem,
   * which is what the link's own reconnect is for.
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
        // Unreachable server: the stream's own retry is the recovery.
        sessionChecked = false;
      });
  };

  const resynchronize = (): void => {
    // A `research.recap.pending: false` sent while disconnected is lost, and
    // nothing refetched carries the flag, so the spinners go: a recap that
    // finished meanwhile arrives with the refetched nodes, and one still
    // running shows when its node update arrives.
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
      // Stop reconnecting after session expiry to avoid a loop while the user
      // is signed out.
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
      // Only clear the shared callback if it is still this instance's; a
      // newly mounted bridge may have already installed its own.
      if (publishInterest === publisher) publishInterest = null;
      subscription.unsubscribe();
      useConnectionStore.getState().setStatus("closed");
    },
  };
}
