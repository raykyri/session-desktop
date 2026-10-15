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

/** Query client defaults: lists the event bridge keeps fresh never auto-expire, so a background refetch cannot race an event-driven update. */
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
    // The guard runs on every navigation; a signed-out tab must find out
    // within a session, not within a page load.
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

/** How often a guest's open thread is re-read while a run in it is active:
 * guests get no events. */
export const GUEST_THREAD_POLL_MS = 15_000;

/** A thread's detail. Events keep it fresh for the owner, the members and a
 * signed-in reader who has it open; a guest (`eventless`) gets none, so the
 * detail is re-read when the tab regains focus and, while a run is active,
 * every `GUEST_THREAD_POLL_MS`. */
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
 * Re-reads a cached thread and its presence when the page opens it, for a
 * reader outside its event audience between visits (a public thread's
 * reader who is not a member: the server sends its events only while it is
 * declared open, `useThreadInterest`). Not when another view of this tab
 * kept it open meanwhile. Call before `useThreadInterest`, whose declaration
 * this checks for.
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

/** The workspace's threads in the Trash, most recently trashed first. Its
 * folders in the Trash are in the folder state. */
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

/** Threads shared with the reader: outside their Archive and Trash
 * (`shared`), in their Archive, or in their Trash. */
export function useSharedTrees(
  place: "shared" | "archive" | "trash" = "shared",
  /** The workspace whose Trash is listed (a member's Trash is per
   * workspace). */
  workspaceId?: string,
) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: queryKeys.shared(place, workspaceId),
    queryFn: () => listSharedResearchTrees(place, workspaceId),
    enabled: signedIn,
  });
}

/** A thread's owner and members. Anyone signed in who may read it. */
export function useThreadMembers(treeId: string, enabled = true) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: queryKeys.members(treeId),
    queryFn: () => listThreadMembers(treeId),
    enabled: signedIn && enabled && treeId !== "",
  });
}

/** A thread's pending invitations; only its owner may list them. */
export function useThreadInvites(treeId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.invites(treeId),
    queryFn: () => listThreadInvites(treeId),
    enabled: enabled && treeId !== "",
  });
}

/** Invitations addressed to the signed-in account's GitHub login. */
export function useReceivedInvites() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: queryKeys.receivedInvites(),
    queryFn: () => listReceivedInvites(),
    enabled: signedIn,
  });
}

/** The reader's notification inbox, newest first, a page at a time
 * (`notifications.list`). `notification.requested` and `notifications.read`
 * refetch it (`api/events.ts`). */
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

/** How many notifications the reader has not read, for the sidebar badge. */
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
 * lowers the cached unread count by as many as changed. */
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

/** Who has the thread open, kept current by `research.presence.changed`.
 * Guests have no event stream, so no presence. */
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
 * Declares the thread open on this connection while the component is
 * mounted (`events.setInterest` `treeIds`): presence, and for a public
 * thread read by someone who is not a member, its events. The bridge renews
 * the declaration before the server lets it lapse.
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

/** Leaves a thread shared with the caller: it goes from every list. */
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

/** Accepts an invitation by its link's token or, for one addressed to the
 * caller's login, by id. Answers with the thread as the caller now sees it. */
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

/** Notify me: notifications for new questions and notes in the thread. */
export function useSetThreadFollowed() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { treeId: string; value: boolean }) =>
      setThreadFollowed(input.treeId, input.value),
    onSuccess: (tree) => writeTree(client, tree),
  });
}

/** Feed roots requested in the same tick, read with one call. */
let pendingFeedRoots: {
  ids: Set<string>;
  result: Promise<Map<string, RecentResearchQuery>>;
} | null = null;

/** Reads one thread's root entry, batched with the other cards that ask in
 * the same tick (the desktop's `onLoadTrees`, which loads the visible cards'
 * roots together). */
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

/** A Home card's root entry, unless `enabled` is false (the card already has
 * one from a feed page). */
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
 * Whether the snapshot poll is on: the stream has been down for the grace
 * period the connection store keeps (`05-run-lifecycle-and-streaming.md` §9).
 *
 * The rule is a deadline rather than a status, so a status change alone cannot
 * drive it — a tab that loses the stream and changes nothing else has to start
 * polling when the grace elapses. The timer is what re-reads the store then;
 * it is shared by every mounted document view, which is why the state is
 * derived here and not inside `useNodeContent`'s poll effect.
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
    // Nothing in the store changes when a deadline passes, so the deadline is
    // what asks for the re-render that reads the rule again.
    const timer = setTimeout(() => retest((count) => count + 1), remaining);
    return () => clearTimeout(timer);
  }, [disconnectedSince]);
  return useConnectionStore.getState().shouldPollSnapshots();
}

/**
 * The streaming protocol's client half (`05-run-lifecycle-and-streaming.md`
 * §4, §9).
 *
 * The snapshot seeds the live buffer with the sequence number it was taken at,
 * and the bridge applies only the next delta in sequence, refetching the
 * snapshot on a gap rather than rendering content with a piece missing. When
 * the run completes, the buffer is dropped in the same pass that installs the
 * durable snapshot, so the timeline does not flash: both paths produce the
 * same `Turn[]`.
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
    // Mount, focus and reconnect all have to reach the server: the stream has
    // no replay buffer, so a stale snapshot is missing text, not merely old.
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  // `refetch` is stable across renders; the query object is not, and effects
  // keyed on it would re-subscribe on every render.
  const { data: content, dataUpdatedAt, refetch } = query;
  const active = content ? isActiveResearchStatus(nodeStatus(content.node)) : false;
  // What the buffer is waiting for: the durable snapshot the terminal
  // `research.node.updated` stamps (`05-run-lifecycle-and-streaming.md` §4).
  // A run that ends `failed`, `cancelled` or `interrupted` never writes one,
  // and `getNodeContent` falls back to `run_turns` for it (`03` §4), so for
  // those the terminal status is itself the signal.
  const durableReady =
    content !== undefined &&
    !active &&
    (nodeResponseSnapshotAt(content.node) !== null || nodeStatus(content.node) !== "complete");

  // Only while the stream is down, and only for a node that is still working:
  // polling a finished node would re-read a snapshot that cannot change.
  const shouldPoll = pollWhileDown && active;
  useEffect(() => {
    if (!shouldPoll || id === "") return;
    const timer = setInterval(() => void refetch(), SNAPSHOT_POLL_MS);
    return () => clearInterval(timer);
  }, [shouldPoll, id, refetch]);

  useNodeInterest(active ? id : undefined);

  // Seeding is keyed on the snapshot's sequence number, so an identical
  // refetch does not reset a buffer that has already moved past it. It runs on
  // `dataUpdatedAt` rather than on `content` alone because structural sharing
  // hands back the very same object when a refetch finds nothing new, and the
  // refetch a gap asks for is exactly that case: without re-seeding from it the
  // buffer would stay frozen on its gap flag.
  const seededSeq = useRef<number | null>(null);
  useEffect(() => {
    if (id === "" || !content || !active) return;
    const seq = content.seq ?? 0;
    const buffered = useLiveTurnsStore.getState().byNode[id];
    if (seededSeq.current === seq && buffered && !buffered.gap) return;
    if (buffered && !buffered.gap && buffered.lastSeq > seq) return;
    seededSeq.current = seq;
    // The snapshot carries every committed turn of the attempt, so re-seeding
    // after a gap restores the turns already on screen rather than dropping
    // them (`05-run-lifecycle-and-streaming.md` §2, §4).
    seed(id, {
      turns: content.turns,
      inFlightText: content.inFlightText ?? "",
      seq,
      status: "running",
    });
  }, [id, content, dataUpdatedAt, active, seed]);

  // A gap means the buffer froze rather than render a hole; the snapshot is
  // the only way back to a consistent view.
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

  // The buffer stays in charge until it is dropped. Between `run.finished` and
  // the durable refetch the cached content is still the pre-finish read, and
  // switching to it there is the flash §4 rules out.
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
 * Declares a node as displayed, so the server sends its turn deltas to this
 * connection (`events.setInterest`). The registry is reference counted and the
 * publish is debounced, so opening a document and its parent is one call.
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

/** A tree row the server just returned: patch every list that holds it and the
 * detail the user may be looking at. */
function writeTree(client: QueryClient, tree: ResearchTree): void {
  mapSummaries(client, (summary) => patchResearchSummaryTree(summary, tree));
  patchDetail(client, tree.id, (detail) => patchResearchDetailTree(detail, tree));
}

/** A whole detail: the authoritative shape, so the summary's counts are
 * recomputed from it rather than patched field by field. `insert` adds the
 * thread to the reader's own lists for its workspace when they do not hold it
 * (a thread just created); a retry only updates the lists that do. */
function writeDetail(
  client: QueryClient,
  detail: ResearchTreeDetail,
  options: { insert: boolean },
): void {
  client.setQueryData(queryKeys.tree(detail.tree.id), detail);
  writeDetailSummary(client, detail, options);
  for (const node of detail.nodes) patchActiveNodes(client, node);
}

/** A new thread's Home card entry, from its detail, so the card shows without
 * a round trip. */
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
      // A new root question is a new feed row, and the feed is keyset
      // paginated: there is no correct place to splice it in by hand.
      invalidateKeys(client, ["activity"]);
    },
  });
}

/** A node a mutation just created. The summary counts are a delta, so they
 * move only when no cache held the node yet: the `research.node.created`
 * event may have arrived before the response and counted it already. */
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
      // A follow-up question is a new feed row, and the feed is keyset
      // paginated: there is no correct place to splice it in by hand.
      invalidateKeys(client, ["activity"]);
    },
  });
}

/** Asks a follow-up at the end of a chain (`followups.ask`). A follow-up
 * sent at once is patched in as `useForkResearchNode` patches one; a queued
 * one is added to the chain's queue in the cached detail. */
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

/** Cancels or retries a queued follow-up; both answer with the chain's
 * queue after the change. */
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
      // The retried node starts a fresh attempt from sequence zero.
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
      // The attention flags are derived from `lastViewedAt`, which the summary
      // patch deliberately leaves alone.
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
      // A member's Archive is their own list (`sharing.listShared`).
      invalidateKeys(client, ["trees"], ["shared"]);
    },
  });
}

/** Drops threads that left every list but the Trash's (moved to the Trash or
 * deleted) from the caches that hold them. */
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

/** Deletes a thread now, in or out of the Trash, with the children listed
 * under it (Delete now). */
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

/** Moves a thread, and the children listed under it, to the Trash. The
 * server refuses while one of them has an active run. */
export function useTrashResearchTree() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: trashResearchTree,
    onSuccess: (tree) => {
      dropTrees(client, [tree.id]);
      // The children moved with it arrive as `research.tree.removed` events.
      // A member's Trash is their own list (`sharing.listShared`).
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

/** Takes a thread, and its children in the Trash, out of the Trash. */
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
      // The shared threads in this workspace's Trash were left.
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

/** Replaces a note's text; a stale `expectedText` is refused with CONFLICT. */
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

/** Asks again for a note's unavailable X posts. */
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

/** Creates (no id) or updates a draft. An update to a draft no longer listed
 * (sent or deleted meanwhile) does not bring it back. */
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

/** Deletes a draft; the list drops it at once and gets it back on a failure. */
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

/** Moves a draft before `beforeId`, or to the end for null. */
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
      // The counts a removal subtracts are read off the cached rows, so they
      // are read before the detail loses them, and the detail is patched here
      // rather than invalidated: the `research.node.removed` that follows then
      // finds no removed rows left and subtracts nothing a second time. With
      // no cached detail, there is nothing to read or patch, so the counts
      // stay as they are.
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
      // And the unsent drafts and branches this browser kept for the account.
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

/** The server's settings, applied to the local mirror. Exported for the boot
 * sequence and the tests; `06-auth-and-users.md` §6 makes the server's copy
 * authoritative on load. */
export type ServerSettings = UserSettings & {
  researchLaunchInstruction: string | null;
  defaultWorkspaceId: string | null;
};
