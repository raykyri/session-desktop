// Query hooks and their options (07 §4.1).
//
// Every read of server state goes through one of these: the key factory in
// `cache.ts` is re-exported here because `api/queries` is the import path the
// rest of the client uses, and the options objects are shared with the router
// loaders, which need the same key and fetcher a component would use.

import type {
  InboxNotificationPage,
  RecentActivityCursor,
  RecentActivityScope,
  RecentResearchQuery,
  ResearchDraft,
  ResearchFolderState,
  ResearchNode,
  ResearchNodeContent,
  ResearchTree,
  ResearchTreeDetail,
  ResearchTreeSummary,
  ResearchTreeVisibility,
  MemberRole,
  ThreadInvite,
  ThreadMember,
  ThreadViewer,
  Turn,
  UserSettings,
} from "@session/shared";
import { recentResearchQueryFromNode } from "@session/shared/lib/activity";
import { isActiveResearchStatus } from "@session/shared/lib/researchChains";
import {
  patchResearchDetailNode,
  patchResearchDetailTree,
  patchResearchSummaryForCreatedNode,
  patchResearchSummaryForRemovedNodes,
  patchResearchSummaryTree,
  removeResearchDetailNodes,
} from "@session/shared/lib/researchEvents";
import { nodeResponseSnapshotAt, nodeStatus } from "@session/shared/lib/researchNodeTypes";
import {
  queryOptions,
  useInfiniteQuery,
  type InfiniteData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { CONNECTION_FALLBACK_DELAY_MS, useConnectionStore } from "../stores/connection.js";
import { useLiveTurnsStore, type LiveTurnStatus } from "../stores/liveTurns.js";
import { clearLocalAccountState } from "../stores/localAccount.js";
import { useSettingsStore } from "../stores/settings.js";

import {
  acceptThreadInvite,
  createThreadInvite,
  getThreadPresence,
  leaveThread,
  getUnreadNotificationCount,
  listNotifications,
  listReceivedInvites,
  markAllNotificationsRead,
  markNotificationRead,
  listSharedResearchTrees,
  listThreadInvites,
  listThreadMembers,
  removeThreadMember,
  revokeThreadInvite,
  setResearchTreeVisibility,
  setThreadFollowed,
  setThreadMemberRole,
  archiveResearchTree,
  cancelResearchNode,
  createInvites,
  createResearchPost,
  createResearchPostFollowUp,
  createResearchTree,
  createResearchWorkspace,
  deleteResearchDraft,
  emptyResearchTrash,
  hydrateResearchPostTweet,
  listRecentActivityForTrees,
  listResearchDrafts,
  listResearchTrash,
  reorderResearchDrafts,
  restoreResearchTreeFromTrash,
  saveResearchDraft,
  trashResearchTree,
  updateResearchPost,
  forkResearchNode,
  askResearchFollowup,
  cancelQueuedResearchFollowup,
  retryQueuedResearchFollowup,
  getMe,
  getResearchNodeContent,
  getResearchTree,
  getRuntimeConfig,
  getSettings,
  getUsageSummary,
  listRecentActivity,
  listResearchActivity,
  listResearchFolders,
  listResearchHighlights,
  listResearchTrees,
  listResearchWorkspaces,
  listUsers,
  logout,
  markResearchTreeViewed,
  removeResearchBranch,
  removeResearchTree,
  renameResearchTree,
  restoreResearchTree,
  retryResearchNode,
  setResearchFolders,
  setUserLimits,
  updateSettings,
  type SettingsUpdate,
} from "./api.js";
import {
  cachedNode,
  dropActiveNodes,
  dropFromSharedLists,
  eachTreeList,
  invalidateKeys,
  mapSummaries,
  patchActiveNodes,
  patchDetail,
  patchDetailQueue,
  queryKeys,
  writeDetailSummary,
  writeRelaunch,
} from "./cache.js";
import { addNodeInterest, addTreeInterest, interestedTreeIds } from "./events.js";

export { queryKeys, eventPatchedListKeys } from "./cache.js";

/** Query client defaults: lists maintained by the event bridge do not auto-expire, preventing background refetches from conflicting with event-driven updates. */
export const queryClientDefaults = {
  queries: {
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: 1,
  },
} as const;

/** How often a displayed active node re-reads its snapshot while the stream is
 * down (`05-run-lifecycle-and-streaming.md` §9). */
export const SNAPSHOT_POLL_MS = 2_000;

/* -------------------------------------------------------------------------
 * Options, shared with the router loaders
 * ---------------------------------------------------------------------- */

export const meQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.me(),
    queryFn: () => getMe(),
    // Checked on navigation; stale time bounds how long authentication state
    // is cached without refetching.
    staleTime: 30_000,
    retry: false,
  });

export const settingsQueryOptions = () =>
  queryOptions({ queryKey: queryKeys.settings(), queryFn: () => getSettings() });

export const runtimeConfigQueryOptions = () =>
  queryOptions({ queryKey: queryKeys.runtimeConfig(), queryFn: () => getRuntimeConfig() });

export const workspacesQueryOptions = () =>
  queryOptions({ queryKey: queryKeys.workspaces(), queryFn: () => listResearchWorkspaces() });

export const foldersQueryOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: queryKeys.folders(workspaceId),
    queryFn: () => listResearchFolders(workspaceId),
    enabled: workspaceId !== "",
  });

export const treesQueryOptions = (scope: { workspaceId: string; includeArchived?: boolean }) => {
  const includeArchived = scope.includeArchived ?? false;
  return queryOptions({
    queryKey: queryKeys.trees({ workspaceId: scope.workspaceId, includeArchived }),
    queryFn: () => listResearchTrees({ workspaceId: scope.workspaceId, includeArchived }),
    enabled: scope.workspaceId !== "",
  });
};

/* -------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------- */

export function useMe() {
  return useQuery(meQueryOptions());
}

export function useSignedIn(): boolean {
  return Boolean(useMe().data);
}

export function useSettings() {
  const signedIn = useSignedIn();
  return useQuery({ ...settingsQueryOptions(), enabled: signedIn });
}

export function useRuntimeConfig() {
  return useQuery(runtimeConfigQueryOptions());
}

export function useWorkspaces() {
  return useQuery(workspacesQueryOptions());
}

export function useFolders(workspaceId: string) {
  return useQuery(foldersQueryOptions(workspaceId));
}

export function useTreeSummaries(scope: { workspaceId: string; includeArchived?: boolean }) {
  return useQuery(treesQueryOptions(scope));
}

/** Polling interval for guest viewers of active runs when real-time events are
 * unavailable. */
export const GUEST_THREAD_POLL_MS = 15_000;

/** Fetches thread detail. For authenticated users, detail is updated via
 * server events; for unauthenticated guests (`eventless`), it refetches on
 * window focus and polls at `GUEST_THREAD_POLL_MS` while runs are active. */
export function useTreeDetail(treeId: string | undefined, options: { eventless?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.tree(treeId ?? ""),
    queryFn: () => getResearchTree(treeId ?? ""),
    enabled: Boolean(treeId),
    ...(options.eventless
      ? {
          refetchOnWindowFocus: "always" as const,
          refetchInterval: (query: { state: { data: ResearchTreeDetail | undefined } }) =>
            query.state.data?.nodes.some((node) => isActiveResearchStatus(nodeStatus(node)))
              ? GUEST_THREAD_POLL_MS
              : false,
        }
      : {}),
  });
}

/**
 * Refetches cached thread detail and presence when opened by a non-member
 * viewer of a public thread, unless another mounted view currently maintains
 * open interest. Must be invoked before `useThreadInterest`.
 */
export function useRefetchThreadOnOpen(treeId: string, outsideAudience: boolean): void {
  const client = useQueryClient();
  const outsideRef = useRef(outsideAudience);
  useEffect(() => {
    if (!outsideRef.current || interestedTreeIds().includes(treeId)) return;
    void client.invalidateQueries({ queryKey: queryKeys.tree(treeId) });
    void client.invalidateQueries({ queryKey: queryKeys.presence(treeId) });
  }, [client, treeId]);
}

export function useActiveNodes() {
  return useQuery({ queryKey: queryKeys.activeNodes(), queryFn: () => listResearchActivity() });
}

export function useHighlightsFeed(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.highlightsFeed(workspaceId),
    queryFn: () => listResearchHighlights(workspaceId),
    enabled: workspaceId !== "",
  });
}

/** Token counts are not pushed over SSE; refresh mounted usage views every 30 seconds. */
export const USAGE_STALE_MS = 30_000;

export function useUsage() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: queryKeys.usage(),
    queryFn: () => getUsageSummary(),
    staleTime: USAGE_STALE_MS,
    refetchInterval: USAGE_STALE_MS,
    enabled: signedIn,
  });
}

export function useAdminUsers(enabled = true) {
  return useQuery({
    queryKey: queryKeys.adminUsers(),
    queryFn: () => listUsers(),
    staleTime: USAGE_STALE_MS,
    refetchInterval: USAGE_STALE_MS,
    enabled,
  });
}

/** The workspace's saved drafts, newest first unless reordered. */
export function useResearchDrafts(workspaceId: string) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: queryKeys.drafts(workspaceId),
    queryFn: () => listResearchDrafts(workspaceId),
    enabled: signedIn && workspaceId !== "",
  });
}

/** Lists trashed threads in the workspace in reverse chronological order. */
export function useResearchTrash(workspaceId: string) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: queryKeys.trash(workspaceId),
    queryFn: () => listResearchTrash(workspaceId),
    enabled: signedIn && workspaceId !== "",
  });
}

/* -------------------------------------------------------------------------
 * Sharing (web only)
 * ---------------------------------------------------------------------- */

/** Queries threads shared with the current user in the active (`shared`),
 * archived, or trashed state. */
export function useSharedTrees(
  place: "shared" | "archive" | "trash" = "shared",
  /** Workspace scope when filtering member trash. */
  workspaceId?: string,
) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: queryKeys.shared(place, workspaceId),
    queryFn: () => listSharedResearchTrees(place, workspaceId),
    enabled: signedIn,
  });
}

/** Fetches thread members and owner. */
export function useThreadMembers(treeId: string, enabled = true) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: queryKeys.members(treeId),
    queryFn: () => listThreadMembers(treeId),
    enabled: signedIn && enabled && treeId !== "",
  });
}

/** Lists pending thread invitations for the thread owner. */
export function useThreadInvites(treeId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.invites(treeId),
    queryFn: () => listThreadInvites(treeId),
    enabled: enabled && treeId !== "",
  });
}

/** Lists pending thread invitations addressed to the authenticated user. */
export function useReceivedInvites() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: queryKeys.receivedInvites(),
    queryFn: () => listReceivedInvites(),
    enabled: signedIn,
  });
}

/** Paginated query for the user's notification inbox in reverse chronological
 * order (`notifications.list`). */
export function useNotificationInbox(enabled = true) {
  const signedIn = useSignedIn();
  return useInfiniteQuery({
    queryKey: queryKeys.notifications(),
    queryFn: ({ pageParam }) => listNotifications(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: signedIn && enabled,
  });
}

/** Queries unread notification count for badge display. */
export function useUnreadNotificationCount() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: queryKeys.unreadNotifications(),
    queryFn: () => getUnreadNotificationCount(),
    enabled: signedIn,
    select: (data) => data.count,
  });
}

type InboxPages = InfiniteData<InboxNotificationPage, string | null>;

/** Marks the cached inbox entries `ids` (all when null) read at `at`, and
 * decrements the cached unread count by the number of updated entries. */
function markInboxRead(client: QueryClient, ids: ReadonlySet<string> | null, at: number): void {
  let changed = 0;
  client.setQueryData<InboxPages>(queryKeys.notifications(), (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) => {
              if (item.readAt !== null || (ids !== null && !ids.has(item.id))) return item;
              changed += 1;
              return { ...item, readAt: at };
            }),
          })),
        }
      : data,
  );
  client.setQueryData<{ count: number }>(queryKeys.unreadNotifications(), (data) =>
    data ? { count: ids === null ? 0 : Math.max(0, data.count - changed) } : data,
  );
}

export function useMarkNotificationRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onMutate: (id) => markInboxRead(client, new Set([id]), Date.now()),
    onError: () => invalidateKeys(client, ["notifications"]),
  });
}

export function useMarkAllNotificationsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onMutate: () => markInboxRead(client, null, Date.now()),
    onError: () => invalidateKeys(client, ["notifications"]),
  });
}

/** Queries active thread viewers. Synchronized via `research.presence.changed`
 * for authenticated users; guests do not transmit presence. */
export function useThreadPresence(treeId: string): ThreadViewer[] {
  const signedIn = useSignedIn();
  return (
    useQuery({
      queryKey: queryKeys.presence(treeId),
      queryFn: () => getThreadPresence(treeId),
      enabled: signedIn && treeId !== "",
    }).data ?? NO_VIEWERS
  );
}

const NO_VIEWERS: ThreadViewer[] = [];

/**
 * Registers active interest in the thread while mounted (`events.setInterest`).
 * Maintains presence tracking and event delivery for non-member viewers of public
 * threads.
 */
export function useThreadInterest(treeId: string | undefined, enabled = true): void {
  useEffect(() => {
    if (!treeId || !enabled) return;
    return addTreeInterest(treeId);
  }, [enabled, treeId]);
}

export function useSetTreeVisibility() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { treeId: string; visibility: ResearchTreeVisibility }) =>
      setResearchTreeVisibility(input.treeId, input.visibility),
    onSuccess: (tree) => {
      writeTree(client, tree);
      mapSummaries(client, (summary) =>
        summary.id === tree.id && tree.visibility !== undefined
          ? { ...summary, visibility: tree.visibility }
          : summary,
      );
      // The All Users feed lists public threads only.
      invalidateKeys(client, ["activity"]);
    },
  });
}

export function useSetThreadMemberRole() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { treeId: string; userId: string; role: MemberRole }) =>
      setThreadMemberRole(input.treeId, input.userId, input.role),
    onSuccess: (members, input) => client.setQueryData(queryKeys.members(input.treeId), members),
  });
}

export function useRemoveThreadMember() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { treeId: string; userId: string }) =>
      removeThreadMember(input.treeId, input.userId),
    onSuccess: (_result, input) => {
      client.setQueryData<ThreadMember[]>(queryKeys.members(input.treeId), (members) =>
        members?.filter((member) => member.userId !== input.userId),
      );
      invalidateKeys(client, queryKeys.members(input.treeId), queryKeys.tree(input.treeId));
    },
  });
}

/** Leaves a shared thread and removes it from cached lists. */
export function useLeaveThread() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (treeId: string) => leaveThread(treeId),
    onSuccess: (_result, treeId) => {
      dropTrees(client, [treeId]);
      client.removeQueries({ queryKey: queryKeys.members(treeId) });
      invalidateKeys(client, ["activity"], ["highlightsFeed"], ["trash"]);
    },
  });
}

export function useCreateThreadInvite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createThreadInvite,
    onSuccess: (created) => {
      client.setQueryData<ThreadInvite[]>(queryKeys.invites(created.invite.treeId), (invites) =>
        invites ? [...invites.filter((i) => i.id !== created.invite.id), created.invite] : invites,
      );
      invalidateKeys(client, queryKeys.invites(created.invite.treeId));
    },
  });
}

export function useRevokeThreadInvite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (invite: ThreadInvite) => revokeThreadInvite(invite.id),
    onSuccess: (revoked) =>
      client.setQueryData<ThreadInvite[]>(queryKeys.invites(revoked.treeId), (invites) =>
        invites?.filter((invite) => invite.id !== revoked.id),
      ),
  });
}

/** Accepts a thread invitation by token or invitation id, returning the updated thread. */
export function useAcceptThreadInvite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: acceptThreadInvite,
    onSuccess: (tree) => {
      invalidateKeys(
        client,
        ["shared"],
        ["trees"],
        queryKeys.receivedInvites(),
        queryKeys.tree(tree.id),
        queryKeys.members(tree.id),
        queryKeys.feedRoot(tree.id),
      );
    },
  });
}

/** Updates notification subscription preference for new questions and notes in the thread. */
export function useSetThreadFollowed() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { treeId: string; value: boolean }) =>
      setThreadFollowed(input.treeId, input.value),
    onSuccess: (tree) => writeTree(client, tree),
  });
}

/** Pending feed root requests queued within the current event loop turn for
 * batch retrieval. */
let pendingFeedRoots: {
  ids: Set<string>;
  result: Promise<Map<string, RecentResearchQuery>>;
} | null = null;

/** Fetches a thread's root entry, coalescing concurrent calls in the same
 * event loop turn into a single batch request. */
export function loadFeedRoot(treeId: string): Promise<RecentResearchQuery | null> {
  if (!pendingFeedRoots) {
    const ids = new Set<string>();
    const result = Promise.resolve().then(async () => {
      pendingFeedRoots = null;
      const all = [...ids];
      const chunks: string[][] = [];
      for (let start = 0; start < all.length; start += FEED_ROOT_BATCH) {
        chunks.push(all.slice(start, start + FEED_ROOT_BATCH));
      }
      const pages = await Promise.all(chunks.map((chunk) => listRecentActivityForTrees(chunk)));
      return new Map(pages.flat().map((root) => [root.treeId, root]));
    });
    pendingFeedRoots = { ids, result };
  }
  pendingFeedRoots.ids.add(treeId);
  return pendingFeedRoots.result.then((roots) => roots.get(treeId) ?? null);
}

/** At most this many ids per `feed.recentQueriesForTrees` call (the server's
 * limit is 200). */
const FEED_ROOT_BATCH = 100;

export const feedRootQueryOptions = (treeId: string) =>
  queryOptions({
    queryKey: queryKeys.feedRoot(treeId),
    queryFn: () => loadFeedRoot(treeId),
  });

/** Fetches the thread's root query for card preview display. */
export function useFeedRoot(treeId: string, enabled = true) {
  return useQuery({ ...feedRootQueryOptions(treeId), enabled: enabled && treeId !== "" });
}

export function useActivityFeed(scope: {
  scope: RecentActivityScope;
  workspaceId?: string | null;
}) {
  const workspaceId = scope.scope === "workspace" ? scope.workspaceId || null : null;
  return useInfiniteQuery({
    queryKey: queryKeys.activity({ scope: scope.scope, workspaceId }),
    queryFn: ({ pageParam }) =>
      listRecentActivity({
        scope: scope.scope,
        ...(workspaceId ? { workspaceId } : {}),
        before: pageParam,
      }),
    initialPageParam: null as RecentActivityCursor | null,
    getNextPageParam: (page) => page.nextCursor ?? null,
    enabled: scope.scope !== "workspace" || workspaceId !== null,
  });
}

/* -------------------------------------------------------------------------
 * Node content: snapshot plus ordered deltas
 * ---------------------------------------------------------------------- */

export interface NodeContentView {
  content: ResearchNodeContent | undefined;
  /** Committed turns, from the live buffer while a run streams and from the
   * durable snapshot once it completes. */
  turns: Turn[];
  /** Text produced since the last committed turn. */
  inFlightText: string;
  source: "live" | "snapshot";
  status: LiveTurnStatus;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
}

/**
 * Determines whether snapshot polling fallback is active after the stream connection
 * has been disconnected beyond the configured grace period (`05-run-lifecycle-and-streaming.md` §9).
 * Re-evaluates on timer expiration when the grace deadline passes without intermediate state changes.
 */
function useSnapshotPollFallback(): boolean {
  const disconnectedSince = useConnectionStore((state) =>
    state.status === "open" ? null : state.disconnectedSince,
  );
  const [, retest] = useState(0);
  useEffect(() => {
    if (disconnectedSince === null) return;
    const remaining = disconnectedSince + CONNECTION_FALLBACK_DELAY_MS - Date.now();
    if (remaining <= 0) return;
    // Store state does not change when the deadline passes; the timer triggers
    // a re-render to re-evaluate fallback eligibility.
    const timer = setTimeout(() => retest((count) => count + 1), remaining);
    return () => clearTimeout(timer);
  }, [disconnectedSince]);
  return useConnectionStore.getState().shouldPollSnapshots();
}

/**
 * Client implementation of the streaming protocol
 * (`05-run-lifecycle-and-streaming.md` §4, §9).
 *
 * The snapshot seeds the live buffer with its corresponding sequence number,
 * and the bridge applies subsequent deltas in order, refetching the snapshot
 * on sequence gaps rather than rendering incomplete content. When the run
 * completes, the live buffer is cleared as the durable snapshot is applied,
 * preventing visual flicker as both produce identical `Turn[]` structures.
 */
export function useNodeContent(nodeId: string | undefined): NodeContentView {
  const id = nodeId ?? "";
  const pollWhileDown = useSnapshotPollFallback();
  const live = useLiveTurnsStore((state) => (id === "" ? undefined : state.byNode[id]));
  const seed = useLiveTurnsStore((state) => state.seed);
  const clear = useLiveTurnsStore((state) => state.clear);

  const query = useQuery({
    queryKey: queryKeys.nodeContent(id),
    queryFn: () => getResearchNodeContent(id),
    enabled: id !== "",
    // Refetch on mount, focus, and reconnect because the stream lacks a replay
    // buffer; snapshots must be authoritative.
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  // `refetch` is stable across renders; the query object is not, and effects
  // keyed on it would re-subscribe on every render.
  const { data: content, dataUpdatedAt, refetch } = query;
  const active = content ? isActiveResearchStatus(nodeStatus(content.node)) : false;
  // Indicates whether the durable snapshot is ready. Completed runs persist a final
  // response snapshot on `research.node.updated` (`05-run-lifecycle-and-streaming.md` §4),
  // while failed, cancelled, or interrupted runs rely directly on their terminal node status.
  const durableReady =
    content !== undefined &&
    !active &&
    (nodeResponseSnapshotAt(content.node) !== null || nodeStatus(content.node) !== "complete");

  // Polls active nodes only while the stream is disconnected.
  const shouldPoll = pollWhileDown && active;
  useEffect(() => {
    if (!shouldPoll || id === "") return;
    const timer = setInterval(() => void refetch(), SNAPSHOT_POLL_MS);
    return () => clearInterval(timer);
  }, [shouldPoll, id, refetch]);

  useNodeInterest(active ? id : undefined);

  // Buffer seeding is keyed on sequence numbers to prevent resetting a buffer
  // that has advanced beyond the snapshot. Tracking `dataUpdatedAt` ensures
  // gap-recovery refetches re-evaluate even when structural sharing returns
  // an unchanged content reference.
  const seededSeq = useRef<number | null>(null);
  useEffect(() => {
    if (id === "" || !content || !active) return;
    const seq = content.seq ?? 0;
    const buffered = useLiveTurnsStore.getState().byNode[id];
    if (seededSeq.current === seq && buffered && !buffered.gap) return;
    if (buffered && !buffered.gap && buffered.lastSeq > seq) return;
    seededSeq.current = seq;
    // The snapshot includes committed turns for the attempt, preserving
    // previously rendered turns upon gap recovery (`05-run-lifecycle-and-streaming.md` §2, §4).
    seed(id, {
      turns: content.turns,
      inFlightText: content.inFlightText ?? "",
      seq,
      status: "running",
    });
  }, [id, content, dataUpdatedAt, active, seed]);

  // A sequence gap halts stream delta application until refetching the full
  // snapshot restores sequence continuity.
  const gap = live?.gap === true;
  useEffect(() => {
    if (!gap || id === "") return;
    void refetch();
  }, [gap, id, refetch]);

  // `run.finished` precedes the terminal `node.updated`, so wait for
  // `durableReady` before fetching the committed snapshot. Retain buffered
  // stream content when the refetch fails and retry on the next update.
  const finished = live?.status === "finished";
  const refetchedForSnapshot = useRef(false);
  useEffect(() => {
    if (id === "" || !finished || !durableReady) return;
    if (refetchedForSnapshot.current) return;
    refetchedForSnapshot.current = true;
    void refetch().then((result) => {
      if (result.isError) {
        refetchedForSnapshot.current = false;
        return;
      }
      seededSeq.current = null;
      refetchedForSnapshot.current = false;
      clear(id);
    });
  }, [id, finished, durableReady, clear, refetch]);

  // The live buffer remains authoritative until cleared to prevent visual flicker
  // between `run.finished` and the final committed snapshot refetch (§4).
  const useLive = live !== undefined && (active || live.status === "finished");
  return {
    content,
    turns: useLive ? live.turns : (content?.turns ?? []),
    inFlightText: useLive ? live.inFlightText : (content?.inFlightText ?? ""),
    source: useLive ? "live" : "snapshot",
    status: live?.status ?? (active ? "running" : "idle"),
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => void refetch(),
  };
}

/**
 * Registers interest in a displayed node to receive turn deltas over SSE
 * (`events.setInterest`). Debounced and reference-counted.
 */
export function useNodeInterest(nodeId: string | undefined): void {
  useEffect(() => {
    if (!nodeId) return;
    return addNodeInterest(nodeId);
  }, [nodeId]);
}

/* -------------------------------------------------------------------------
 * Mutations
 * ---------------------------------------------------------------------- */

/** Updates cached tree summaries and detail with newly returned tree data. */
function writeTree(client: QueryClient, tree: ResearchTree): void {
  mapSummaries(client, (summary) => patchResearchSummaryTree(summary, tree));
  patchDetail(client, tree.id, (detail) => patchResearchDetailTree(detail, tree));
}

/** Writes full thread detail to cache and recomputes summary counts. `insert`
 * adds newly created threads to the user's workspace lists. */
function writeDetail(
  client: QueryClient,
  detail: ResearchTreeDetail,
  options: { insert: boolean },
): void {
  client.setQueryData(queryKeys.tree(detail.tree.id), detail);
  writeDetailSummary(client, detail, options);
  for (const node of detail.nodes) patchActiveNodes(client, node);
}

/** Populates feed root cache from thread detail for initial card display. */
function writeFeedRoot(client: QueryClient, detail: ResearchTreeDetail): void {
  const root = detail.nodes.find((node) => node.id === detail.tree.rootNodeId);
  const entry = root ? recentResearchQueryFromNode(root, true) : null;
  if (entry) client.setQueryData(queryKeys.feedRoot(detail.tree.id), { ...entry, children: [] });
}

export function useCreateResearchTree() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createResearchTree,
    onSuccess: (detail) => {
      writeDetail(client, detail, { insert: true });
      writeFeedRoot(client, detail);
      // Invalidate activity feed queries to include the newly created root question
      // in paginated results.
      invalidateKeys(client, ["activity"]);
    },
  });
}

/** Patches cache with a newly created node. Summary counts update only if
 * the node was not already recorded by a preceding `research.node.created`
 * event. */
function writeCreatedNode(client: QueryClient, node: ResearchNode): void {
  const known = cachedNode(client, node.treeId, node.id) !== undefined;
  patchDetail(client, node.treeId, (detail) => patchResearchDetailNode(detail, node));
  if (!known) {
    mapSummaries(client, (summary) =>
      patchResearchSummaryForCreatedNode(summary, node, Date.now()),
    );
  }
  patchActiveNodes(client, node);
}

export function useForkResearchNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: forkResearchNode,
    onSuccess: (node) => {
      writeCreatedNode(client, node);
      // Invalidate activity feed queries to integrate the follow-up question
      // into paginated results.
      invalidateKeys(client, ["activity"]);
    },
  });
}

/** Appends a follow-up query to a chain (`followups.ask`), immediately
 * patching the node or appending it to the cached chain queue. */
export function useAskResearchFollowup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: askResearchFollowup,
    onSuccess: (result) => {
      if (result.kind === "queued") {
        const { item } = result;
        patchDetail(client, item.treeId, (detail) => {
          if (!detail) return detail;
          const current = (detail.queues ?? {})[item.headNodeId] ?? [];
          if (current.some((existing) => existing.id === item.id)) return detail;
          return { ...detail, queues: { ...detail.queues, [item.headNodeId]: [...current, item] } };
        });
        return;
      }
      writeCreatedNode(client, result.node);
      invalidateKeys(client, ["activity"]);
    },
  });
}

/** Cancels or retries a queued follow-up, updating cached queue state from
 * the response. */
export function useQueuedFollowupAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      action: "cancel" | "retry";
      treeId: string;
      headNodeId: string;
      itemId: string;
    }) => ({
      ...input,
      items:
        input.action === "cancel"
          ? await cancelQueuedResearchFollowup(input.itemId)
          : await retryQueuedResearchFollowup(input.itemId),
    }),
    onSuccess: ({ treeId, headNodeId, items }) =>
      patchDetailQueue(client, treeId, headNodeId, items),
  });
}

export function useRetryResearchNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { nodeId: string; model?: string }) =>
      retryResearchNode(input.nodeId, input.model),
    onSuccess: (detail, input) => {
      writeRelaunch(client, { detail });
      // Invalidate node content query to reset stream buffer state for retry attempt.
      invalidateKeys(client, queryKeys.nodeContent(input.nodeId));
    },
  });
}

export function useCancelResearchNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: cancelResearchNode,
    onSuccess: (node) => writeRelaunch(client, { node }),
  });
}

export function useRenameResearchTree() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { treeId: string; title: string }) =>
      renameResearchTree(input.treeId, input.title),
    onSuccess: (tree) => writeTree(client, tree),
  });
}

export function useMarkTreeViewed() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: markResearchTreeViewed,
    onSuccess: (tree) => {
      writeTree(client, tree);
      // Clear unviewed update and failure flags in cached summaries when marking
      // a tree as viewed.
      mapSummaries(client, (summary) =>
        summary.id === tree.id
          ? { ...summary, hasUnseenUpdate: false, hasUnseenFailure: false }
          : summary,
      );
    },
  });
}

export function useArchiveResearchTree() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { treeId: string; archived: boolean }) =>
      input.archived ? archiveResearchTree(input.treeId) : restoreResearchTree(input.treeId),
    onSuccess: (tree) => {
      writeTree(client, tree);
      // Invalidate tree lists and shared lists when archiving or restoring.
      invalidateKeys(client, ["trees"], ["shared"]);
    },
  });
}

/** Removes deleted or trashed threads from local query caches. */
function dropTrees(client: QueryClient, treeIds: readonly string[]): void {
  const gone = new Set(treeIds);
  eachTreeList(client, (summaries) => {
    const next = summaries.filter((summary) => !gone.has(summary.id));
    return next.length === summaries.length ? summaries : next;
  });
  dropFromSharedLists(client, gone);
  for (const treeId of gone) {
    client.removeQueries({ queryKey: queryKeys.tree(treeId) });
    client.removeQueries({ queryKey: queryKeys.feedRoot(treeId) });
  }
  dropActiveNodes(client, (node) => gone.has(node.treeId));
}

/** Permanently deletes a thread and descendant subtrees. */
export function useRemoveResearchTree() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: removeResearchTree,
    onSuccess: (result, treeId) => {
      dropTrees(client, [treeId, ...result.treeIds]);
      invalidateKeys(client, ["activity"], ["highlightsFeed"], ["trash"], ["shared"]);
    },
  });
}

/** Moves a thread and its descendant subtrees to Trash. Fails if active runs
 * exist in the subtree. */
export function useTrashResearchTree() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: trashResearchTree,
    onSuccess: (tree) => {
      dropTrees(client, [tree.id]);
      // Descendant removals are propagated via `research.tree.removed` events;
      // invalidate trash and activity queries.
      invalidateKeys(
        client,
        queryKeys.trash(tree.workspaceId),
        queryKeys.shared("trash"),
        ["activity"],
        ["highlightsFeed"],
      );
    },
  });
}

/** Restores a thread and its descendant subtrees from Trash. */
export function useRestoreResearchTreeFromTrash() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: restoreResearchTreeFromTrash,
    onSuccess: (tree) => {
      invalidateKeys(
        client,
        queryKeys.trash(tree.workspaceId),
        ["trees"],
        ["shared"],
        ["activity"],
        ["highlightsFeed"],
        queryKeys.feedRoot(tree.id),
      );
    },
  });
}

/** Deletes every thread and folder in the workspace's Trash. */
export function useEmptyResearchTrash() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (workspaceId: string) => emptyResearchTrash(workspaceId),
    onSuccess: (result, workspaceId) => {
      dropTrees(client, result.treeIds);
      client.setQueryData<ResearchTreeSummary[]>(queryKeys.trash(workspaceId), []);
      // Reset trashed shared thread cache for the workspace.
      client.setQueryData<ResearchTreeSummary[]>(queryKeys.shared("trash", workspaceId), []);
      invalidateKeys(client, queryKeys.shared("trash"));
      if (result.folderIds.length > 0) invalidateKeys(client, queryKeys.folders(workspaceId));
    },
  });
}

/* -------------------------------------------------------------------------
 * Posts
 * ---------------------------------------------------------------------- */

/** Saves a note or a link as a new thread. */
export function useCreateResearchPost() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createResearchPost,
    onSuccess: (detail) => {
      writeDetail(client, detail, { insert: true });
      writeFeedRoot(client, detail);
      invalidateKeys(client, ["activity"]);
    },
  });
}

/** Adds a follow-up note under a post. */
export function useCreateResearchPostFollowUp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createResearchPostFollowUp,
    onSuccess: (node) => {
      writeCreatedNode(client, node);
      invalidateKeys(client, ["activity"], queryKeys.feedRoot(node.treeId));
    },
  });
}

/** Updates note text; rejects with CONFLICT if `expectedText` does not match
 * server state. */
export function useUpdateResearchPost() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: updateResearchPost,
    onSuccess: (result) => {
      writeTree(client, result.tree);
      patchDetail(client, result.tree.id, (detail) => patchResearchDetailNode(detail, result.node));
      invalidateKeys(
        client,
        queryKeys.nodeContent(result.node.id),
        queryKeys.feedRoot(result.tree.id),
      );
      if (result.removedHighlightCount > 0) invalidateKeys(client, ["highlightsFeed"]);
    },
  });
}

/** Retries hydration for unavailable embedded posts. */
export function useHydrateResearchPostTweet() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: hydrateResearchPostTweet,
    onSuccess: (node) => {
      patchDetail(client, node.treeId, (detail) => patchResearchDetailNode(detail, node));
      invalidateKeys(client, queryKeys.nodeContent(node.id), queryKeys.feedRoot(node.treeId));
    },
  });
}

/* -------------------------------------------------------------------------
 * Saved drafts
 * ---------------------------------------------------------------------- */

/** Creates or updates a research draft. Does not re-insert drafts deleted
 * or submitted during editing. */
export function useSaveResearchDraft() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: saveResearchDraft,
    onSuccess: (saved, input) => {
      client.setQueryData<ResearchDraft[]>(queryKeys.drafts(saved.workspaceId), (drafts) => {
        if (!drafts) return drafts;
        if (drafts.some((draft) => draft.id === saved.id)) {
          return drafts.map((draft) => (draft.id === saved.id ? saved : draft));
        }
        return input.id ? drafts : [saved, ...drafts];
      });
    },
  });
}

/** Optimistically removes a draft from cache, reverting on mutation failure. */
export function useDeleteResearchDraft() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (draft: ResearchDraft) => deleteResearchDraft(draft.id),
    onMutate: async (draft) => {
      const key = queryKeys.drafts(draft.workspaceId);
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<ResearchDraft[]>(key);
      client.setQueryData<ResearchDraft[]>(key, (drafts) =>
        drafts?.filter((candidate) => candidate.id !== draft.id),
      );
      return { previous };
    },
    onError: (_error, draft, context) => {
      if (context?.previous)
        client.setQueryData(queryKeys.drafts(draft.workspaceId), context.previous);
    },
  });
}

/** Moves a draft before `beforeId`, or appends to the end when null. */
export function useMoveResearchDraft() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { workspaceId: string; draftIds: string[] }) =>
      reorderResearchDrafts(input.workspaceId, input.draftIds),
    onMutate: async (input) => {
      const key = queryKeys.drafts(input.workspaceId);
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<ResearchDraft[]>(key);
      if (previous) {
        const byId = new Map(previous.map((draft) => [draft.id, draft]));
        client.setQueryData(
          key,
          input.draftIds.flatMap((id) => byId.get(id) ?? []),
        );
      }
      return { previous };
    },
    onSuccess: (drafts, input) => client.setQueryData(queryKeys.drafts(input.workspaceId), drafts),
    onError: (_error, input, context) => {
      if (context?.previous)
        client.setQueryData(queryKeys.drafts(input.workspaceId), context.previous);
    },
  });
}

export function useRemoveResearchBranch() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: removeResearchBranch,
    onSuccess: (removal) => {
      const removed = new Set(removal.removedNodeIds);
      // Node counts are decremented using cached node rows prior to updating detail.
      // Modifying detail directly prevents duplicate decrements when the subsequent
      // `research.node.removed` event arrives.
      const detail = client.getQueryData<ResearchTreeDetail>(queryKeys.tree(removal.treeId));
      const removedNodes = (detail?.nodes ?? []).filter((node) => removed.has(node.id));
      patchDetail(client, removal.treeId, (current) =>
        removeResearchDetailNodes(current, removal.treeId, removed),
      );
      mapSummaries(client, (summary) =>
        patchResearchSummaryForRemovedNodes(summary, removal.treeId, removedNodes, Date.now()),
      );
      dropActiveNodes(client, (node) => removed.has(node.id));
      for (const nodeId of removed) {
        client.removeQueries({ queryKey: queryKeys.nodeContent(nodeId) });
      }
      invalidateKeys(client, ["activity"], ["highlightsFeed"]);
    },
  });
}

export function useSetResearchFolders() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { workspaceId: string; state: ResearchFolderState }) =>
      setResearchFolders(input.workspaceId, input.state),
    onSuccess: (state, input) => {
      client.setQueryData(queryKeys.folders(input.workspaceId), state);
    },
  });
}

export function useCreateWorkspace() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createResearchWorkspace,
    onSuccess: () => invalidateKeys(client, queryKeys.workspaces()),
  });
}

export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SettingsUpdate) => updateSettings(input),
    onSuccess: (settings) => {
      client.setQueryData(queryKeys.settings(), settings);
    },
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => logout(),
    onSuccess: () => {
      // Clear the React Query cache on logout to purge user data from memory.
      client.clear();
      useSettingsStore.getState().reset();
      // Clear locally stored unsent drafts and thread branch navigation state.
      clearLocalAccountState();
    },
  });
}

export function useSetUserLimits() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: setUserLimits,
    onSuccess: () => invalidateKeys(client, queryKeys.adminUsers()),
  });
}

export function useCreateInvites() {
  return useMutation({ mutationFn: createInvites });
}

/** Server settings applied to the local store. Authoritative on load per
 * `06-auth-and-users.md` §6; exported for boot initialization and tests. */
export type ServerSettings = UserSettings & {
  researchLaunchInstruction: string | null;
  defaultWorkspaceId: string | null;
};
