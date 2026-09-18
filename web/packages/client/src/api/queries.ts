// Query hooks and their options (07 §4.1).
//
// Every read of server state goes through one of these: the key factory in
// `cache.ts` is re-exported here because `api/queries` is the import path the
// rest of the client uses, and the options objects are shared with the router
// loaders, which need the same key and fetcher a component would use.

import type {
  RecentActivityCursor,
  ResearchFolderState,
  ResearchNodeContent,
  ResearchTree,
  ResearchTreeDetail,
  Turn,
  UserSettings,
} from "@session/shared";
import {
  isActiveResearchStatus,
  patchResearchDetailNode,
  patchResearchDetailTree,
  patchResearchSummaryForCreatedNode,
  patchResearchSummaryForNode,
  patchResearchSummaryForRemovedNodes,
  patchResearchSummaryTree,
  removeResearchDetailNodes,
  researchSummaryFromDetail,
} from "@session/shared";
import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { CONNECTION_FALLBACK_DELAY_MS, useConnectionStore } from "../stores/connection.js";
import { useLiveTurnsStore, type LiveTurnStatus } from "../stores/liveTurns.js";

import {
  archiveResearchTree,
  cancelResearchNode,
  createInvites,
  createResearchTree,
  createResearchWorkspace,
  forkResearchNode,
  getMe,
  getResearchNodeContent,
  getResearchTree,
  getRuntimeConfig,
  getSettings,
  getUsageSummary,
  listDocuments,
  listEncyclopediaPages,
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
  setResearchTreeBookmarked,
  setResearchTreeFollowed,
  setUserLimits,
  updateSettings,
  type SettingsUpdate,
  getEncyclopediaPage,
} from "./api.js";
import {
  cachedNode,
  dropActiveNodes,
  eachTreeList,
  invalidateKeys,
  mapSummaries,
  patchActiveNodes,
  patchActivityFeedNode,
  patchDetail,
  queryKeys,
} from "./cache.js";
import { addNodeInterest } from "./events.js";

export { queryKeys, eventPatchedListKeys } from "./cache.js";

/** Query client defaults: lists updated via server events do not auto-expire to prevent background refetches from colliding with event updates. */
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

export const encyclopediaQueryOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: queryKeys.encyclopedia(workspaceId),
    queryFn: () => listEncyclopediaPages(workspaceId),
    enabled: workspaceId !== "",
  });

/* -------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------- */

export function useMe() {
  return useQuery(meQueryOptions());
}

export function useSettings() {
  return useQuery(settingsQueryOptions());
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

export function useTreeDetail(treeId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.tree(treeId ?? ""),
    queryFn: () => getResearchTree(treeId ?? ""),
    enabled: Boolean(treeId),
  });
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

export function useEncyclopediaPages(workspaceId: string) {
  return useQuery(encyclopediaQueryOptions(workspaceId));
}

export function useEncyclopediaPage(workspaceId: string, slug: string) {
  return useQuery({
    queryKey: queryKeys.encyclopediaPage(workspaceId, slug),
    queryFn: () => getEncyclopediaPage(workspaceId, slug),
    enabled: workspaceId !== "" && slug !== "",
  });
}

export function useDocuments(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.documents(workspaceId),
    queryFn: () => listDocuments(workspaceId),
    enabled: workspaceId !== "",
  });
}

/** Usage queries use a 30-second stale time because token counts are not broadcast over SSE events and must be periodically refetched. */
export const USAGE_STALE_MS = 30_000;

export function useUsage(days?: number) {
  return useQuery({
    queryKey: queryKeys.usage(),
    queryFn: () => getUsageSummary(days),
    staleTime: USAGE_STALE_MS,
  });
}

export function useAdminUsers(enabled = true) {
  return useQuery({
    queryKey: queryKeys.adminUsers(),
    queryFn: () => listUsers(),
    staleTime: USAGE_STALE_MS,
    enabled,
  });
}

export function useActivityFeed(scope: { workspaceId: string; bookmarkedOnly?: boolean }) {
  const bookmarkedOnly = scope.bookmarkedOnly ?? false;
  return useInfiniteQuery({
    queryKey: queryKeys.activity({ workspaceId: scope.workspaceId, bookmarkedOnly }),
    queryFn: ({ pageParam }) =>
      listRecentActivity({
        workspaceId: scope.workspaceId,
        bookmarkedOnly,
        before: pageParam,
      }),
    initialPageParam: null as RecentActivityCursor | null,
    getNextPageParam: (page) => page.nextCursor ?? null,
    enabled: scope.workspaceId !== "",
  });
}

/* -------------------------------------------------------------------------
 * Node content: snapshot plus ordered deltas
 * ---------------------------------------------------------------------- */

export interface NodeContentView {
  content: ResearchNodeContent | undefined;
  /** Committed turns, from the live buffer while a run streams and from the
   * durable snapshot once it settles. */
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
 * The event bridge strictly applies sequential turn updates; missing sequence numbers trigger a snapshot refetch to prevent missing content. When the run settles the buffer is dropped
 * in the same pass that installs the durable snapshot, so the timeline does not
 * flash: both paths produce the same `Turn[]`.
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
  const active = content ? isActiveResearchStatus(content.node.status) : false;
  // What the buffer is waiting for: the durable snapshot the terminal
  // `research.node.updated` stamps (`05-run-lifecycle-and-streaming.md` §4).
  // A run that ends `failed`, `cancelled` or `interrupted` never writes one,
  // and `getNodeContent` falls back to `run_turns` for it (`03` §4), so for
  // those the terminal status is itself the signal.
  const durableReady =
    content !== undefined &&
    !active &&
    (content.node.responseSnapshotAt != null || content.node.status !== "complete");

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

/** A whole detail: the authoritative shape, so the summary is recomputed from
 * it rather than patched field by field. */
function writeDetail(client: QueryClient, detail: ResearchTreeDetail): void {
  client.setQueryData(queryKeys.tree(detail.tree.id), detail);
  const summary = researchSummaryFromDetail(detail);
  eachTreeList(client, (summaries) => {
    const index = summaries.findIndex((existing) => existing.id === summary.id);
    if (index === -1) return [summary, ...summaries];
    const next = [...summaries];
    next[index] = summary;
    return next;
  });
  for (const node of detail.nodes) patchActiveNodes(client, node);
}

export function useCreateResearchTree() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createResearchTree,
    onSuccess: (detail) => {
      writeDetail(client, detail);
      // A new root question is a new feed row, and the feed is keyset
      // paginated: there is no correct place to splice it in by hand.
      invalidateKeys(client, ["activity"]);
    },
  });
}

export function useForkResearchNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: forkResearchNode,
    onSuccess: (node) => {
      // Apply optimistic tree and node summary updates so the subsequent server
      // event does not duplicate the count change.
      patchDetail(client, node.treeId, (detail) => patchResearchDetailNode(detail, node));
      mapSummaries(client, (summary) =>
        patchResearchSummaryForCreatedNode(summary, node, Date.now()),
      );
      patchActiveNodes(client, node);
      // A follow-up question is a new feed row, and the feed is keyset
      // paginated: there is no correct place to splice it in by hand.
      invalidateKeys(client, ["activity"]);
    },
  });
}

export function useRetryResearchNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { nodeId: string; model?: string }) =>
      retryResearchNode(input.nodeId, input.model),
    onSuccess: (detail, input) => {
      writeDetail(client, detail);
      // The retried node starts a fresh attempt from sequence zero.
      invalidateKeys(client, queryKeys.nodeContent(input.nodeId));
    },
  });
}

export function useCancelResearchNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: cancelResearchNode,
    onSuccess: (node) => {
      // The summary counts are a delta between the node the caches held and
      // the one that came back, so they have to be applied here, from the
      // predecessor, before it is overwritten: the `research.node.updated`
      // this call publishes would otherwise read the already-cancelled node as
      // its own predecessor and move nothing.
      const previous = cachedNode(client, node.treeId, node.id);
      patchDetail(client, node.treeId, (detail) => patchResearchDetailNode(detail, node));
      patchActiveNodes(client, node);
      patchActivityFeedNode(client, node);
      if (previous) {
        mapSummaries(client, (summary) =>
          patchResearchSummaryForNode(summary, previous, node, Date.now()),
        );
      } else {
        invalidateKeys(client, ["trees"]);
      }
    },
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

export function useSetTreeFollowed() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { treeId: string; value: boolean }) =>
      setResearchTreeFollowed(input.treeId, input.value),
    onSuccess: (tree) => writeTree(client, tree),
  });
}

export function useSetTreeBookmarked() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { treeId: string; value: boolean }) =>
      setResearchTreeBookmarked(input.treeId, input.value),
    onSuccess: (tree) => {
      writeTree(client, tree);
      // The bookmarked feed is a different list, not a filter of a cached one.
      invalidateKeys(client, ["activity"]);
    },
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
      invalidateKeys(client, ["trees"]);
    },
  });
}

export function useRemoveResearchTree() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: removeResearchTree,
    onSuccess: (_result, treeId) => {
      eachTreeList(client, (summaries) => summaries.filter((summary) => summary.id !== treeId));
      client.removeQueries({ queryKey: queryKeys.tree(treeId) });
      dropActiveNodes(client, (node) => node.treeId === treeId);
      invalidateKeys(client, ["activity"], ["highlightsFeed"]);
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
      // finds no removed rows left and subtracts nothing a second time. If the tree detail is not in cache, counts remain unmodified as a fallback.
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
