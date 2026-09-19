// The query key factory (07 §4.1) and the cache writers built on it.
//
// Centralized query keys keep component reads and event-bridge cache patches
// consistent. Optimistic mutations and server-event reducers share these
// writers so they produce identical summary objects.
//
// `queries.ts` re-exports `queryKeys`, which is the import path the rest of
// the client uses; the factory lives here so the writers can use it without a
// cycle through the hooks.

import type {
  RecentActivityItem,
  RecentActivityPage,
  RecentActivityScope,
  RecentResearchQuery,
  ResearchNode,
  ResearchTreeDetail,
  ResearchTreeSummary,
} from "@session/shared";
import { recentActivityItemId, upsertResearchActivity } from "@session/shared";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";

export interface ActivityQueryScope {
  scope: RecentActivityScope;
  workspaceId: string | null;
  bookmarkedOnly: boolean;
}

export const queryKeys = {
  me: () => ["me"] as const,
  settings: () => ["settings"] as const,
  runtimeConfig: () => ["runtimeConfig"] as const,
  usage: () => ["usage"] as const,
  workspaces: () => ["workspaces"] as const,
  documents: (workspaceId: string) => ["documents", workspaceId] as const,
  folders: (workspaceId: string) => ["folders", workspaceId] as const,
  trees: (scope: { workspaceId: string; includeArchived: boolean }) => ["trees", scope] as const,
  tree: (treeId: string) => ["tree", treeId] as const,
  nodeContent: (nodeId: string) => ["nodeContent", nodeId] as const,
  activity: (scope: ActivityQueryScope) => ["activity", scope] as const,
  highlightsFeed: (workspaceId: string) => ["highlightsFeed", workspaceId] as const,
  encyclopedia: (workspaceId: string) => ["encyclopedia", workspaceId] as const,
  encyclopediaPage: (workspaceId: string, slug: string) =>
    ["encyclopediaPage", workspaceId, slug] as const,
  activeNodes: () => ["activeNodes"] as const,
  adminUsers: () => ["adminUsers"] as const,
} as const;

/** The lists the bridge invalidates on reconnect: everything the server keeps
 * fresh through events rather than through refetching (07 §4.2). */
export const eventPatchedListKeys = [
  "trees",
  "tree",
  "activity",
  "highlightsFeed",
  "activeNodes",
  "encyclopedia",
  "workspaces",
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

export function mapSummaries(
  client: QueryClient,
  patch: (summary: ResearchTreeSummary) => ResearchTreeSummary,
): void {
  eachTreeList(client, (summaries) => {
    let changed = false;
    const next = summaries.map((summary) => {
      const patched = patch(summary);
      if (patched !== summary) changed = true;
      return patched;
    });
    return changed ? next : summaries;
  });
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
 * The highlights feed carries the thread and node titles on every row
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
 * The Home feed carries a compact projection of a run, not the node row, so
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
    const patchQuery = (query: RecentResearchQuery): RecentResearchQuery => {
      const children = query.children?.map(patchQuery);
      const childrenChanged =
        children !== undefined &&
        children.some((child, index) => child !== query.children?.[index]);
      if (query.nodeId !== node.id) {
        if (!childrenChanged) return query;
        changed = true;
        return { ...query, children };
      }
      const title = node.title ?? null;
      const recap = node.recap?.text ?? null;
      if (
        query.status === node.status &&
        (query.title ?? null) === title &&
        (query.recap ?? null) === recap &&
        !childrenChanged
      ) {
        return query;
      }
      changed = true;
      return {
        ...query,
        ...(children === undefined ? {} : { children }),
        status: node.status,
        title,
        recap,
      };
    };
    const pages = data.pages.map((page) => {
      const items = page.items.map((item) =>
        item.kind === "research-query" ? { ...item, query: patchQuery(item.query) } : item,
      );
      return items.some((item, index) => item !== page.items[index]) ? { ...page, items } : page;
    });
    return changed ? { ...data, pages } : data;
  });
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
