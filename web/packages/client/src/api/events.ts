// The SSE bridge (07 §4.2, `05-run-lifecycle-and-streaming.md` §4, §9).
//
// One `events.subscribe` subscription for the app's lifetime. Incoming events
// are queued and flushed on a 16 ms trailing timer, and a flush runs inside
// `notifyManager.batch` so a burst of twenty patches yields one render rather
// than twenty.
//
// Where an event lands is decided once, here: run events go to the `liveTurns`
// store and never touch the query cache (a run at 30 events/s would invalidate
// list queries thirty times a second), everything else is a targeted
// `setQueryData` through the reducers in `@session/shared`, and anything the
// parser calls `malformed` or `unsupported` becomes a scoped invalidation —
// Unrecognized or malformed server events trigger cache invalidation and refetching to prevent silent stale state.

import type {
  EncyclopediaPage,
  EncyclopediaPageSummary,
  JournalEntry,
  ParsedResearchEvent,
  RecentActivityPage,
  ResearchFolderState,
  ResearchHighlightFeedItem,
  ResearchNodeContent,
  ResearchTreeDetail,
  SessionEvent,
  Workspace,
} from "@session/shared";
import {
  parseResearchEvent,
  patchResearchDetailHighlightCreated,
  patchResearchDetailHighlightsRemoved,
  patchResearchDetailNode,
  patchResearchDetailTree,
  patchResearchNodeContent,
  patchResearchSummaryForCreatedNode,
  patchResearchSummaryForNode,
  patchResearchSummaryForRemovedNodes,
  patchResearchSummaryTree,
  removeResearchDetailNodes,
  researchSummaryFromDetail,
} from "@session/shared";
import { notifyManager, type InfiniteData, type QueryClient } from "@tanstack/react-query";

import { useConnectionStore } from "../stores/connection.js";
import { useLiveTurnsStore, type RunEvent } from "../stores/liveTurns.js";
import { notificationFromPayload, useNotificationsStore } from "../stores/notifications.js";
import { useRecapPendingStore } from "../stores/recapPending.js";
import { normalizeSettings, useSettingsStore } from "../stores/settings.js";

import { setEventInterest } from "./api.js";
import {
  cachedNode,
  cachedTreeTitle,
  dropActiveNodes,
  eachTreeList,
  eventPatchedListKeys,
  invalidateHighlightLabels,
  invalidateKeys as invalidate,
  mapSummaries,
  patchActiveNodes,
  patchActivityFeedNode,
  patchDetail,
  queryKeys,
  treeIdForNode,
} from "./cache.js";
import { trpc, type SessionTrpcClient } from "./trpc.js";

/** Matches the desktop's `useSessionEvents.ts:37-51`. */
export const EVENT_COALESCE_MS = 16;

/** The interest set is published on a trailing timer: opening five documents
 * in a row is one call, not five (`03-api-and-events.md` §3). */
export const INTEREST_DEBOUNCE_MS = 200;

/** The first event of every connection (`routers/encyclopedia.ts`). */
export const CONNECTION_READY = "connection.ready";

/* -------------------------------------------------------------------------
 * Run events
 * ---------------------------------------------------------------------- */

/** Narrows the parsed union into the subset `liveTurns` accepts. The parser
 * has already validated the turn and the sequence number, so nothing is cast
 * here. */
export function runEventFromParsed(event: ParsedResearchEvent): RunEvent | null {
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

function applyResearchEvent(client: QueryClient, event: ParsedResearchEvent): void {
  switch (event.type) {
    case "research.tree.created": {
      const detail: ResearchTreeDetail = { tree: event.tree, nodes: [event.node] };
      client.setQueryData(queryKeys.tree(event.tree.id), detail);
      const summary = researchSummaryFromDetail(detail);
      eachTreeList(client, (summaries) =>
        summaries.some((existing) => existing.id === summary.id)
          ? summaries
          : [summary, ...summaries],
      );
      patchActiveNodes(client, event.node);
      // A new root question is a new feed row, and the feed is keyset
      // paginated: there is no correct place to splice it in by hand.
      invalidate(client, ["activity"]);
      return;
    }

    case "research.tree.updated":
    case "research.tree.archived":
    case "research.tree.restored": {
      invalidateHighlightLabels(client, cachedTreeTitle(client, event.tree.id), event.tree.title);
      mapSummaries(client, (summary) => patchResearchSummaryTree(summary, event.tree));
      patchDetail(client, event.tree.id, (detail) => patchResearchDetailTree(detail, event.tree));
      if (event.type !== "research.tree.updated") {
        // Archiving moves the thread between the `includeArchived` scopes,
        // and which list it belongs to is the server's answer, not a patch's.
        // The highlights feed reads from unarchived threads only
        // (`db/repos/highlights.ts:feed`), so archiving retires this thread's
        // rows and restoring brings them back (`10` §4).
        invalidate(client, ["trees"], ["highlightsFeed"]);
      }
      return;
    }

    case "research.tree.removed": {
      eachTreeList(client, (summaries) => {
        const next = summaries.filter((summary) => summary.id !== event.treeId);
        return next.length === summaries.length ? summaries : next;
      });
      client.removeQueries({ queryKey: queryKeys.tree(event.treeId) });
      dropActiveNodes(client, (node) => node.treeId === event.treeId);
      invalidate(client, ["activity"], ["highlightsFeed"]);
      return;
    }

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
      invalidate(client, ["activity"]);
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
      invalidate(client, ["activity"], ["highlightsFeed"]);
      return;
    }

    case "research.document.updated": {
      const knownNode = cachedNode(client, event.tree.id, event.node.id);
      invalidateHighlightLabels(
        client,
        knownNode === undefined ? undefined : (knownNode.title ?? null),
        event.node.title ?? null,
      );
      mapSummaries(client, (summary) => patchResearchSummaryTree(summary, event.tree));
      patchDetail(client, event.tree.id, (detail) => {
        const withTree = patchResearchDetailTree(detail, event.tree);
        return patchResearchDetailNode(withTree, event.node);
      });
      // The markdown itself is not on the event, so the open document refetches.
      invalidate(client, queryKeys.nodeContent(event.node.id));
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
      // The feed row carries the tree and node labels, which the event does not.
      invalidate(client, ["highlightsFeed"]);
      return;
    }

    case "research.highlight.removed":
    case "research.highlights.removed": {
      const ids =
        event.type === "research.highlight.removed" ? [event.highlightId] : event.highlightIds;
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

    case "research.recap.pending":
      // A viewer hint with no cache behind it: the recap itself arrives as a
      // node update, which is what the summary and the document render from.
      // This only decides whether the answer shows a spinner in the recap's
      // slot while the job runs (09 §2).
      useRecapPendingStore.getState().set(event.nodeId, event.pending);
      return;

    case "models.updated": {
      client.setQueryData<{ models: unknown[] }>(queryKeys.runtimeConfig(), (config) =>
        config ? { ...config, models: event.models } : config,
      );
      return;
    }

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

function applyOtherEvent(client: QueryClient, event: SessionEvent): void {
  const payload = event.payload;
  switch (event.type) {
    case "encyclopedia.page.updated": {
      const page = payload["page"] as EncyclopediaPage | undefined;
      if (!page || typeof page.slug !== "string") return;
      client.setQueryData(queryKeys.encyclopediaPage(page.workspaceId, page.slug), page);
      client.setQueryData<EncyclopediaPageSummary[]>(
        queryKeys.encyclopedia(page.workspaceId),
        (pages) => {
          if (!pages) return pages;
          const summary: EncyclopediaPageSummary = {
            slug: page.slug,
            term: page.term,
            title: page.title,
            status: page.status,
            workspaceId: page.workspaceId,
            createdAt: page.createdAt,
            updatedAt: page.updatedAt,
            sourceCount: page.sources.length,
          };
          const index = pages.findIndex((existing) => existing.slug === page.slug);
          if (index === -1) return [...pages, summary];
          const next = [...pages];
          next[index] = summary;
          return next;
        },
      );
      return;
    }

    case "encyclopedia.page.removed": {
      const workspaceId = payload["workspaceId"];
      const slug = payload["slug"];
      if (typeof workspaceId !== "string" || typeof slug !== "string") return;
      client.removeQueries({ queryKey: queryKeys.encyclopediaPage(workspaceId, slug) });
      client.setQueryData<EncyclopediaPageSummary[]>(
        queryKeys.encyclopedia(workspaceId),
        (pages) => (pages ? pages.filter((page) => page.slug !== slug) : pages),
      );
      return;
    }

    case "journal.entry.updated": {
      const entry = payload["entry"] as JournalEntry | undefined;
      if (!entry || typeof entry.id !== "string") return;
      if (!replaceJournalEntry(client, entry)) invalidate(client, ["activity"]);
      return;
    }

    case "journal.entry.removed": {
      const id = payload["id"];
      if (typeof id !== "string") return;
      removeJournalEntry(client, id);
      return;
    }

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
      client.removeQueries({ queryKey: queryKeys.encyclopedia(workspaceId) });
      invalidate(client, ["trees"], ["activity"], ["highlightsFeed"]);
      return;
    }

    case "folders.updated": {
      const workspaceId = payload["workspaceId"];
      const state = payload["state"] as ResearchFolderState | undefined;
      if (typeof workspaceId !== "string" || !state) return;
      client.setQueryData(queryKeys.folders(workspaceId), state);
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

    case "notification.requested": {
      // The bridge is the only ingress for server-originated toasts, so the
      // `showNotifications` preference is enforced here. The store does not
      // know about settings, and the server keeps sending the events either
      // way — a notification the user opted out of is still a run that
      // finished, and the caches that reflect it are patched above.
      if (!useSettingsStore.getState().settings.showNotifications) return;
      const item = notificationFromPayload(payload, event.timestamp);
      if (item) useNotificationsStore.getState().push(item);
      return;
    }

    default:
      return;
  }
}

function replaceJournalEntry(client: QueryClient, entry: JournalEntry): boolean {
  let found = false;
  client.setQueriesData<InfiniteData<RecentActivityPage>>({ queryKey: ["activity"] }, (data) => {
    if (!data) return data;
    const pages = data.pages.map((page) => {
      const items = page.items.map((item) => {
        if (item.kind !== "journal" || item.entry.id !== entry.id) return item;
        found = true;
        return { ...item, entry };
      });
      return found ? { ...page, items } : page;
    });
    return found ? { ...data, pages } : data;
  });
  return found;
}

function removeJournalEntry(client: QueryClient, id: string): void {
  client.setQueriesData<InfiniteData<RecentActivityPage>>({ queryKey: ["activity"] }, (data) => {
    if (!data) return data;
    let changed = false;
    const pages = data.pages.map((page) => {
      const items = page.items.filter((item) => !(item.kind === "journal" && item.entry.id === id));
      if (items.length === page.items.length) return page;
      changed = true;
      return { ...page, items };
    });
    return changed ? { ...data, pages } : data;
  });
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
    const parsed = parseResearchEvent(event);
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
  return [["trees"], ["tree"], ["activity"], ["highlightsFeed"], ["activeNodes"]];
}

/* -------------------------------------------------------------------------
 * Interest
 * ---------------------------------------------------------------------- */

/** Mounted document views, by node id, with a count so two views of one node
 * do not cancel each other's interest on unmount. */
const interest = new Map<string, number>();
let interestTimer: ReturnType<typeof setTimeout> | null = null;
let publishInterest: ((nodeIds: string[]) => void) | null = null;

function scheduleInterest(): void {
  if (interestTimer !== null) clearTimeout(interestTimer);
  interestTimer = setTimeout(() => {
    interestTimer = null;
    publishInterest?.([...interest.keys()]);
  }, INTEREST_DEBOUNCE_MS);
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

/** Test seam: drops the registry and any pending publish. */
export function resetNodeInterest(): void {
  interest.clear();
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
  setInterest?: (connectionId: string, nodeIds: string[]) => Promise<unknown>;
  /** What to do when the stream reports that the session is gone. Defaults to
   * a full navigation to `/login`. */
  onUnauthorized?: () => void;
}

/**
 * Whether a subscription error is the server saying the session is gone.
 *
 * `TRPCClientError` carries the formatter's `data.code`; the raw shape is read
 * too, because an error that crossed the SSE framing keeps `shape` and not
 * always `data`. Only explicit unauthorized status codes trigger sign-out; transient connection drops attempt reconnection without clearing the user session.
 */
export function isUnauthorizedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    data?: { code?: unknown } | null;
    shape?: { data?: { code?: unknown } } | null;
  };
  return candidate.data?.code === "UNAUTHORIZED" || candidate.shape?.data?.code === "UNAUTHORIZED";
}

/** The default `onUnauthorized`: a real navigation, not a router push. When the session expires, performing a full page redirect to /login ensures all memory and query caches are cleanly reinitialized.). The path being left is handed to `/login` the
 * way the route guard hands it over. */
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

  const publisher = (nodeIds: string[]): void => {
    if (connectionId === null) return;
    void publish(connectionId, nodeIds).catch(() => {
      // If the connection has terminated on the server, interest subscriptions will be re-sent on reconnection.
    });
  };
  publishInterest = publisher;

  const signOut = (): void => {
    if (signedOut) return;
    signedOut = true;
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
          publishInterest?.([...interest.keys()]);
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
      publishInterest?.([...interest.keys()]);
    },
    close: () => {
      closed = true;
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
      queue = [];
      // Avoid clearing publish callbacks if a newly mounted bridge instance has already registered its own publisher.
      if (publishInterest === publisher) publishInterest = null;
      subscription.unsubscribe();
      useConnectionStore.getState().setStatus("closed");
    },
  };
}
