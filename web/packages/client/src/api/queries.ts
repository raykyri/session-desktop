// The query key factory (07 §4.1). Keys are built here and nowhere else so a
// cache patch in the event bridge and a read in a component cannot disagree
// about the shape of a key.
//
// The hooks that call these keys arrive with the transport in the second half
// of Phase 5; the factory itself is pure and already the single source.

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
  activity: (scope: { workspaceId: string; bookmarkedOnly: boolean }) =>
    ["activity", scope] as const,
  highlightsFeed: (workspaceId: string) => ["highlightsFeed", workspaceId] as const,
  encyclopedia: (workspaceId: string) => ["encyclopedia", workspaceId] as const,
  encyclopediaPage: (workspaceId: string, slug: string) =>
    ["encyclopediaPage", workspaceId, slug] as const,
  activeNodes: () => ["activeNodes"] as const,
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
] as const;

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
