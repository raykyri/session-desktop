// The thread page's loading placeholder. The route renders it while the
// page's chunk loads (`app/router.tsx`, `pendingComponent`), and the page
// renders the same placeholder while the thread's detail loads, so opening a
// thread shows one loading state, not a blank stage followed by another.
//
// This module is in the main chunk; it imports only the column chrome, not
// the page.

import type { ResearchTreeDetail } from "@session/shared";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";

import { cachedTreeSummary, queryKeys } from "../../api/cache.js";

import { ThreadPlaceholder } from "./ColumnChrome.js";
import { Columns } from "./Columns.js";
import { useHistoryButtons } from "./useThreadHistory.js";

/** The placeholder's header title: "Note" for a note, else the thread's
 * title as a cache last saw it (the desktop's placeholder), else "Loading
 * research…". */
export function threadPlaceholderTitle(
  client: QueryClient,
  treeId: string,
  detail: ResearchTreeDetail | undefined = client.getQueryData<ResearchTreeDetail>(
    queryKeys.tree(treeId),
  ),
): string {
  const cached = detail ? undefined : cachedTreeSummary(client, treeId);
  const rootType = detail
    ? detail.nodes.find((node) => node.id === detail.tree.rootNodeId)?.type
    : cached?.type;
  if (rootType === "post") return "Note";
  return detail?.tree.title ?? cached?.title ?? "Loading research…";
}

/** The spinner and label under the placeholder's header. */
export function ThreadLoadingBody() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <LoaderCircle className="session-spin text-fg-muted" size={24} aria-hidden="true" />
      <h1 className="text-fg-muted m-0 text-base font-normal">Loading research…</h1>
    </div>
  );
}

/** The route's pending component. */
export function ThreadPending() {
  const { treeId = "" } = useParams({ strict: false });
  const client = useQueryClient();
  const history = useHistoryButtons();
  return (
    <Columns>
      <ThreadPlaceholder
        title={threadPlaceholderTitle(client, treeId)}
        history={{
          canGoBack: history.canGoBack,
          canGoForward: history.canGoForward,
          onBack: history.goBack,
          onForward: history.goForward,
        }}
      >
        <ThreadLoadingBody />
      </ThreadPlaceholder>
    </Columns>
  );
}
