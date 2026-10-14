// The query key factory (07 §4.1) and the cache writers built on it.
//
// Centralized query keys keep component reads and event-bridge cache patches
// consistent. Optimistic mutations and server-event reducers share these
// writers so they produce identical summary objects.
//
// `queries.ts` re-exports `queryKeys`, which is the import path the rest of
// the client uses; the factory is defined here so the writers can use it without a
// cycle through the hooks.

import type {
  RecentActivityItem,
  RecentActivityPage,
  RecentActivityScope,
  RecentResearchQuery,
  ResearchFollowupQueueItem,
  ResearchNode,
  ResearchTree,
  ResearchTreeDetail,
  ResearchTreeSummary,
} from "@session/shared";
import { recentActivityItemId } from "@session/shared";
import {
  patchResearchSummaryTree,
  researchSummaryFromDetail,
  upsertResearchActivity,
} from "@session/shared/lib/researchEvents";
import { nodeRecap, nodeStatus } from "@session/shared/lib/researchNodeTypes";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";

export interface ActivityQueryScope {
  scope: RecentActivityScope;
  workspaceId: string | null;
}

export const queryKeys = {
  me: () => ["me"] as const,
  settings: () => ["settings"] as const,
  runtimeConfig: () => ["runtimeConfig"] as const,
  usage: () => ["usage"] as const,
  workspaces: () => ["workspaces"] as const,
  folders: (workspaceId: string) => ["folders", workspaceId] as const,
  trees: (scope: { workspaceId: string; includeArchived: boolean }) => ["trees", scope] as const,
  tree: (treeId: string) => ["tree", treeId] as const,
  nodeContent: (nodeId: string) => ["nodeContent", nodeId] as const,
  activity: (scope: ActivityQueryScope) => ["activity", scope] as const,
  /** One Home card's root entry (`feed.recentQueriesForTrees`); null when the
   * thread has none to show (archived, in the Trash, gone). */
  feedRoot: (treeId: string) => ["feedRoot", treeId] as const,
  highlightsFeed: (workspaceId: string) => ["highlightsFeed", workspaceId] as const,
  activeNodes: () => ["activeNodes"] as const,
  adminUsers: () => ["adminUsers"] as const,
  /** The workspace's saved drafts (`drafts.list`). */
  drafts: (workspaceId: string) => ["drafts", workspaceId] as const,
  /** The workspace's threads in the Trash (`research.listTrash`). */
  trash: (workspaceId: string) => ["trash", workspaceId] as const,
  /** Threads shared with the reader (`sharing.listShared`), outside their
   * Archive and Trash, in their Archive, or in their Trash. */
  shared: (place: "shared" | "archive" | "trash") => ["shared", place] as const,
  /** A thread's owner and members (`sharing.listMembers`). */
  members: (treeId: string) => ["members", treeId] as const,
  /** A thread's pending invitations, for its owner (`invites.list`). */
  invites: (treeId: string) => ["invites", treeId] as const,
  /** Invitations addressed to the reader's GitHub login (`invites.received`). */
  receivedInvites: () => ["receivedInvites"] as const,
  /** Who has a thread open (`events.presence`, `research.presence.changed`). */
  presence: (treeId: string) => ["presence", treeId] as const,
} as const;

/** The lists the bridge invalidates on reconnect: everything the server keeps
 * fresh through events rather than through refetching (07 §4.2). */
export const eventPatchedListKeys = [
  "trees",
  "tree",
  "activity",
  "feedRoot",
  "highlightsFeed",
  "activeNodes",
  "workspaces",
  "folders",
  "drafts",
  "trash",
  "shared",
  "members",
  "invites",
  "receivedInvites",
  "presence",
] as const;

export function invalidateKeys(
  client: QueryClient,
  ...keys: readonly (readonly unknown[])[]
): void {
  for (const queryKey of keys) void client.invalidateQueries({ queryKey });
}

/** Every `["trees", scope]` list, whatever its workspace and archive scope. */
export function eachTreeList(
  client: QueryClient,
  update: (summaries: ResearchTreeSummary[]) => ResearchTreeSummary[],
): void {
  client.setQueriesData<ResearchTreeSummary[]>({ queryKey: ["trees"] }, (summaries) =>
    summaries ? update(summaries) : summaries,
  );
}

/** Every `["shared", place]` list (web only). Kept apart from
 * `eachTreeList`: a new thread is never inserted into these, since which of
 * them lists a thread is the server's answer. */
export function eachSharedList(
  client: QueryClient,
  update: (summaries: ResearchTreeSummary[]) => ResearchTreeSummary[],
): void {
  client.setQueriesData<ResearchTreeSummary[]>({ queryKey: ["shared"] }, (summaries) =>
    summaries ? update(summaries) : summaries,
  );
}

export function mapSummaries(
  client: QueryClient,
  patch: (summary: ResearchTreeSummary) => ResearchTreeSummary,
): void {
  const apply = (summaries: ResearchTreeSummary[]) => {
    let changed = false;
    const next = summaries.map((summary) => {
      const patched = patch(summary);
      if (patched !== summary) changed = true;
      return patched;
    });
    return changed ? next : summaries;
  };
  eachTreeList(client, apply);
  eachSharedList(client, apply);
}

/** Drops a thread from the shared lists (it was left, removed or deleted). */
export function dropFromSharedLists(client: QueryClient, treeIds: ReadonlySet<string>): void {
  eachSharedList(client, (summaries) => {
    const next = summaries.filter((summary) => !treeIds.has(summary.id));
    return next.length === summaries.length ? summaries : next;
  });
}

/** The fields of a tree that are the reader's own (web only). The server
 * leaves them out of a tree event it sends to everyone but the person who
 * caused it (`research/access.ts:sharedTree`): a member's Archive and Trash
 * are per person, so another person's change says nothing about them.
 * `trashedBy` is handled apart because the server omits it whenever the
 * thread is out of the Trash; it is the reader's own only when `trashedAt`
 * is left out too. */
const PER_PERSON_TREE_FIELDS = [
  "role",
  "lastViewedAt",
  "followed",
  "archivedAt",
  "trashedAt",
] as const;

/** Whether a tree event left out the reader's own Archive and Trash state:
 * the change was someone else's, and what it means for the reader's copy has
 * to be read back from the server. */
export function treeEventOmitsOwnState(tree: ResearchTree): boolean {
  return !("archivedAt" in tree);
}

/**
 * A tree from an event, over the copy the cache holds: a per-person field the
 * event leaves out keeps its cached value instead of being dropped. Returns
 * `next` itself when it carries every one of them.
 */
export function mergeTreeEvent(
  previous: ResearchTree | null | undefined,
  next: ResearchTree,
): ResearchTree {
  if (!previous || previous.id !== next.id) return next;
  let merged: ResearchTree | null = null;
  const keep = (field: keyof ResearchTree) => {
    merged ??= { ...next };
    (merged as unknown as Record<string, unknown>)[field] = previous[field];
  };
  for (const field of PER_PERSON_TREE_FIELDS) {
    if (field in next || previous[field] === undefined) continue;
    keep(field);
  }
  if (!("trashedAt" in next) && !("trashedBy" in next) && previous.trashedBy !== undefined) {
    keep("trashedBy");
  }
  return merged ?? next;
}

/** `patchResearchSummaryTree` for a tree from an event: a summary keeps its
 * own `archivedAt` when the event leaves it out (`mergeTreeEvent`). */
export function patchSummaryFromTreeEvent(
  summary: ResearchTreeSummary,
  tree: ResearchTree,
): ResearchTreeSummary {
  if (summary.id !== tree.id) return summary;
  return patchResearchSummaryTree(
    summary,
    "archivedAt" in tree ? tree : { ...tree, archivedAt: summary.archivedAt ?? null },
  );
}

/** Whether the reader owns a thread. A tree without `role` (an event sent to
 * the rest of the audience) is the reader's only when its `ownerId` is the
 * signed-in account's; a tree with neither field is treated as the reader's. */
export function readerOwnsTree(client: QueryClient, tree: ResearchTree): boolean {
  if (tree.role !== undefined) return tree.role === "owner";
  if (tree.ownerId === undefined) return true;
  const me = client.getQueryData<{ id: string } | null>(queryKeys.me());
  return me?.id === tree.ownerId;
}

/** A detail's summary with the web-only fields the shared projection leaves
 * out (owner, visibility, the reader's role). */
export function summaryFromDetail(detail: ResearchTreeDetail): ResearchTreeSummary {
  const summary = researchSummaryFromDetail(detail);
  const { ownerId, visibility, role } = detail.tree;
  return {
    ...summary,
    ...(ownerId === undefined ? {} : { ownerId }),
    ...(visibility === undefined ? {} : { visibility }),
    ...(role === undefined ? {} : { role }),
  };
}

/**
 * Writes a thread's summary from its detail into the lists. A list that
 * holds the thread gets the new counts and title merged over its own copy,
 * which keeps what a detail cannot speak for (the list's workspace, the
 * Trash's `trashedAt`). A list that does not hold it gets it only when
 * `insert` is set and the list is one the server would put it in: the
 * reader's own thread, in that list's workspace, out of the Trash, and out of
 * the Archive unless the list includes archived threads. The shared lists
 * are only merged into; which of them lists a thread is the server's answer.
 * `keepExisting` leaves a row a list already holds as it is (a redelivered
 * `research.tree.created`, whose one-node detail is older than the row).
 */
export function writeDetailSummary(
  client: QueryClient,
  detail: ResearchTreeDetail,
  options: { insert: boolean; keepExisting?: boolean },
): void {
  const fresh = summaryFromDetail(detail);
  const replace = (summaries: ResearchTreeSummary[]): ResearchTreeSummary[] | null => {
    const index = summaries.findIndex((existing) => existing.id === fresh.id);
    if (index === -1) return null;
    if (options.keepExisting === true) return summaries;
    const existing = summaries[index] as ResearchTreeSummary;
    const next = [...summaries];
    next[index] = {
      ...existing,
      ...fresh,
      workspaceId: existing.workspaceId,
      ...(existing.trashedAt === undefined ? {} : { trashedAt: existing.trashedAt }),
    };
    return next;
  };
  const tree = detail.tree;
  const insertable =
    options.insert && readerOwnsTree(client, tree) && (tree.trashedAt ?? null) === null;
  for (const query of client.getQueryCache().findAll({ queryKey: ["trees"] })) {
    const summaries = query.state.data as ResearchTreeSummary[] | undefined;
    if (!summaries) continue;
    const replaced = replace(summaries);
    if (replaced) {
      client.setQueryData(query.queryKey, replaced);
      continue;
    }
    const scope = query.queryKey[1] as
      { workspaceId?: string; includeArchived?: boolean } | undefined;
    if (!insertable || scope?.workspaceId !== tree.workspaceId) continue;
    if ((tree.archivedAt ?? null) !== null && scope.includeArchived !== true) continue;
    client.setQueryData(query.queryKey, [fresh, ...summaries]);
  }
  eachSharedList(client, (summaries) => replace(summaries) ?? summaries);
}

/** Patches a tree detail already in the cache. A no-op when nothing is cached for it. */
export function patchDetail(
  client: QueryClient,
  treeId: string,
  patch: (detail: ResearchTreeDetail | null) => ResearchTreeDetail | null,
): void {
  const key = queryKeys.tree(treeId);
  const current = client.getQueryData<ResearchTreeDetail>(key);
  if (!current) return;
  const next = patch(current);
  if (next && next !== current) client.setQueryData(key, next);
}

/** Replaces one chain's follow-up queue in a cached detail; an empty list
 * removes the chain's entry. */
export function patchDetailQueue(
  client: QueryClient,
  treeId: string,
  headNodeId: string,
  items: ResearchFollowupQueueItem[],
): void {
  patchDetail(client, treeId, (detail) => {
    if (!detail) return detail;
    const queues = { ...detail.queues };
    if (items.length === 0) delete queues[headNodeId];
    else queues[headNodeId] = items;
    return { ...detail, queues };
  });
}

/** The node as the caches last saw it: from the tree detail if it is cached, else from the active-nodes list. `undefined` when neither cache holds it. */
export function cachedNode(
  client: QueryClient,
  treeId: string,
  nodeId: string,
): ResearchNode | undefined {
  const detail = client.getQueryData<ResearchTreeDetail>(queryKeys.tree(treeId));
  const fromDetail = detail?.nodes.find((node) => node.id === nodeId);
  if (fromDetail) return fromDetail;
  return client
    .getQueryData<ResearchNode[]>(queryKeys.activeNodes())
    ?.find((node) => node.id === nodeId);
}

/** The thread's summary in a cached list (Home's lists or Shared with me),
 * or `undefined`: what the thread page shows while its detail loads. */
export function cachedTreeSummary(
  client: QueryClient,
  treeId: string,
): ResearchTreeSummary | undefined {
  for (const prefix of ["trees", "shared"]) {
    for (const query of client.getQueryCache().findAll({ queryKey: [prefix] })) {
      const summaries = query.state.data as ResearchTreeSummary[] | undefined;
      const found = summaries?.find((summary) => summary.id === treeId);
      if (found) return found;
    }
  }
  return undefined;
}

/** The thread's title as the caches last saw it, or `undefined` when no cache
 * holds the thread. The detail is preferred: it is the copy a rename writes
 * first. */
export function cachedTreeTitle(client: QueryClient, treeId: string): string | undefined {
  const detail = client.getQueryData<ResearchTreeDetail>(queryKeys.tree(treeId));
  if (detail) return detail.tree.title;
  for (const query of client.getQueryCache().findAll({ queryKey: ["trees"] })) {
    const summaries = query.state.data as ResearchTreeSummary[] | undefined;
    const found = summaries?.find((summary) => summary.id === treeId);
    if (found) return found.title;
  }
  return undefined;
}

/**
 * The highlights feed includes the thread and node titles on every row
 * (`ResearchHighlightFeedItem`), and a rename does not say what the new label
 * of a document node is — that rule is the server's (`highlights.listFeed`).
 * So a renamed thread refetches the feed instead of being patched into it, and
 * only a rename does: the feed is otherwise event-patched and long-lived, and
 * would show the old name for the rest of the session.
 *
 * `undefined` for `previous` means no cache held the old label, which is not
 * the same as an empty one: there is nothing to compare, so nothing refetches.
 */
export function invalidateHighlightLabels(
  client: QueryClient,
  previous: string | null | undefined,
  next: string | null | undefined,
): void {
  if (previous === undefined) return;
  if (previous === (next ?? null)) return;
  invalidateKeys(client, ["highlightsFeed"]);
}

export function patchActiveNodes(client: QueryClient, node: ResearchNode): void {
  client.setQueryData<ResearchNode[]>(queryKeys.activeNodes(), (nodes) =>
    nodes ? upsertResearchActivity(nodes, node) : nodes,
  );
}

export function dropActiveNodes(
  client: QueryClient,
  predicate: (node: ResearchNode) => boolean,
): void {
  client.setQueryData<ResearchNode[]>(queryKeys.activeNodes(), (nodes) => {
    if (!nodes) return nodes;
    const next = nodes.filter((node) => !predicate(node));
    return next.length === nodes.length ? nodes : next;
  });
}

/** The tree a node belongs to, as far as the caches know. */
export function treeIdForNode(client: QueryClient, nodeId: string): string | null {
  const active = client
    .getQueryData<ResearchNode[]>(queryKeys.activeNodes())
    ?.find((node) => node.id === nodeId);
  if (active) return active.treeId;
  for (const query of client.getQueryCache().findAll({ queryKey: ["tree"] })) {
    const detail = query.state.data as ResearchTreeDetail | undefined;
    if (detail?.nodes.some((node) => node.id === nodeId)) return detail.tree.id;
  }
  return null;
}

/**
 * The Home feed includes a compact projection of a run, not the node row, so
 * the shared node reducers do not apply to it. The three fields a node event
 * is authoritative for in that projection are patched in place; anything
 * structural (a new question, a removed branch) invalidates instead, because
 * the feed is keyset-paginated and there is no correct place to splice a row.
 */
export function patchActivityFeedNode(
  client: QueryClient,
  node: ResearchNode,
  queryKey: readonly unknown[] = ["activity"],
): void {
  client.setQueriesData<InfiniteData<RecentActivityPage>>({ queryKey }, (data) => {
    if (!data) return data;
    let changed = false;
    const pages = data.pages.map((page) => {
      const items = page.items.map((item) => {
        if (item.kind !== "research-query") return item;
        const query = patchRecentQueryNode(item.query, node);
        if (query === item.query) return item;
        changed = true;
        return { ...item, query };
      });
      return items.some((item, index) => item !== page.items[index]) ? { ...page, items } : page;
    });
    return changed ? { ...data, pages } : data;
  });
  // The Home cards whose roots were loaded on their own read the same
  // projection.
  if (queryKey[0] === "activity") {
    client.setQueriesData<RecentResearchQuery | null>({ queryKey: ["feedRoot"] }, (query) =>
      query ? patchRecentQueryNode(query, node) : query,
    );
  }
}

/** A feed entry, or one of its children, with the fields a node event is
 * authoritative for (status, title, recap) taken from `node`. Returns the
 * entry itself when nothing changed. */
export function patchRecentQueryNode(
  query: RecentResearchQuery,
  node: ResearchNode,
): RecentResearchQuery {
  const children = query.children?.map((child) => patchRecentQueryNode(child, node));
  const childrenChanged =
    children !== undefined && children.some((child, index) => child !== query.children?.[index]);
  if (query.nodeId !== node.id) {
    return childrenChanged ? { ...query, children } : query;
  }
  const title = node.title ?? null;
  const recap = nodeRecap(node)?.text ?? null;
  const status = nodeStatus(node);
  if (
    query.status === status &&
    (query.title ?? null) === title &&
    (query.recap ?? null) === recap &&
    !childrenChanged
  ) {
    return query;
  }
  return {
    ...query,
    ...(children === undefined ? {} : { children }),
    status,
    title,
    recap,
  };
}

export function patchActivityFeedItem(
  client: QueryClient,
  queryKey: ReturnType<typeof queryKeys.activity>,
  item: RecentActivityItem,
): boolean {
  let found = false;
  const id = recentActivityItemId(item);
  client.setQueryData<InfiniteData<RecentActivityPage>>(queryKey, (data) => {
    if (!data) return data;
    let changed = false;
    const pages = data.pages.map((page) => {
      let pageChanged = false;
      const items = page.items.map((existing) => {
        if (recentActivityItemId(existing) !== id) return existing;
        found = true;
        changed = true;
        pageChanged = true;
        return item;
      });
      return pageChanged ? { ...page, items } : page;
    });
    return changed ? { ...data, pages } : data;
  });
  return found;
}

export function removeActivityFeedItem(
  client: QueryClient,
  queryKey: ReturnType<typeof queryKeys.activity>,
  id: string,
): void {
  client.setQueryData<InfiniteData<RecentActivityPage>>(queryKey, (data) => {
    if (!data) return data;
    let changed = false;
    const pages = data.pages.map((page) => {
      const items = page.items.filter((item) => recentActivityItemId(item) !== id);
      if (items.length === page.items.length) return page;
      changed = true;
      return { ...page, items };
    });
    return changed ? { ...data, pages } : data;
  });
}
