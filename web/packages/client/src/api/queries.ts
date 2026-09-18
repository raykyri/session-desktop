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
  patchResearchSummaryTree,
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
import { useEffect, useRef } from "react";

import { useConnectionStore } from "../stores/connection.js";
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

/** Defaults for the app's `QueryClient`. Event-patched lists never go stale on
 * their own: the subscription is what keeps them current, and a background
 * refetch would race the patches. */
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

export function useUsage(days?: number) {
  return useQuery({ queryKey: queryKeys.usage(), queryFn: () => getUsageSummary(days) });
}

export function useAdminUsers(enabled = true) {
  return useQuery({ queryKey: queryKeys.adminUsers(), queryFn: () => listUsers(), enabled });
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
 * The streaming protocol's client half (`05-run-lifecycle-and-streaming.md`
 * §4, §9).
 *
 * The snapshot seeds the live buffer with the sequence number it was taken at,
 * the bridge applies only `seq === lastSeq + 1`, and a gap refetches instead of
 * rendering text with a hole in it. When the run settles the buffer is dropped
 * in the same pass that installs the durable snapshot, so the timeline does not
 * flash: both paths produce the same `Turn[]`.
 */
export function useNodeContent(nodeId: string | undefined): NodeContentView {
  const id = nodeId ?? "";
  const pollWhileDown = useConnectionStore((state) => state.status !== "open");
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
  const { data: content, refetch } = query;
  const active = content ? isActiveResearchStatus(content.node.status) : false;
  const settledWithSnapshot =
    content !== undefined && !active && content.node.responseSnapshotAt != null;

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
  // refetch does not reset a buffer that has already moved past it.
  const seededSeq = useRef<number | null>(null);
  useEffect(() => {
    if (id === "" || !content || !active) return;
    const seq = content.seq ?? 0;
    const buffered = useLiveTurnsStore.getState().byNode[id];
    if (seededSeq.current === seq && buffered && !buffered.gap) return;
    if (buffered && !buffered.gap && buffered.lastSeq > seq) return;
    seededSeq.current = seq;
    seed(id, {
      turns: content.turns,
      inFlightText: content.inFlightText ?? "",
      seq,
      status: "running",
    });
  }, [id, content, active, seed]);

  // A gap means the buffer froze rather than render a hole; the snapshot is
  // the only way back to a consistent view.
  const gap = live?.gap === true;
  useEffect(() => {
    if (!gap || id === "") return;
    void refetch();
  }, [gap, id, refetch]);

  // `run.finished` lands before the terminal `node.updated`; the durable
  // snapshot exists only once the node carries `responseSnapshotAt`. One
  // refetch after that, then the buffer goes.
  const finished = live?.status === "finished";
  const refetchedForSnapshot = useRef(false);
  useEffect(() => {
    if (id === "" || !finished) return;
    if (settledWithSnapshot) {
      clear(id);
      seededSeq.current = null;
      refetchedForSnapshot.current = false;
      return;
    }
    if (refetchedForSnapshot.current) return;
    refetchedForSnapshot.current = true;
    void refetch();
  }, [id, finished, settledWithSnapshot, clear, refetch]);

  const useLive = live !== undefined && active;
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
      patchDetail(client, node.treeId, (detail) => patchResearchDetailNode(detail, node));
      patchActiveNodes(client, node);
      invalidateKeys(client, ["trees"], ["activity"]);
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
      const previous = cachedNode(client, node.treeId, node.id);
      patchDetail(client, node.treeId, (detail) => patchResearchDetailNode(detail, node));
      patchActiveNodes(client, node);
      patchActivityFeedNode(client, node);
      if (!previous) invalidateKeys(client, ["trees"]);
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
      dropActiveNodes(client, (node) => removed.has(node.id));
      for (const nodeId of removed) {
        client.removeQueries({ queryKey: queryKeys.nodeContent(nodeId) });
      }
      // Counts on the summary need the removed rows, which the caller may not
      // have cached; the tree is the authority.
      invalidateKeys(client, queryKeys.tree(removal.treeId), ["trees"], ["activity"]);
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
      // Nothing in the cache belongs to a signed-out tab.
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
