// Home (`10-home-feed-journal.md` §1): for a signed-in account, the
// workspace's Home as on the desktop — the ask box, Unfiled, the trays, and
// "+ New folder" (`features/home/FeedView.tsx`), with Refresh Home and Import
// .md report in its header. `?feed=all` (the sidebar's All Users place) and a
// guest show the web's All Users feed of public threads.

import { useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { useRef } from "react";

import { invalidateKeys } from "../api/cache.js";
import { queryKeys, useSignedIn } from "../api/queries.js";
import { ResearchQueryComposer } from "../features/composer/ResearchQueryComposer.js";
import { ActivityFeed } from "../features/home/ActivityFeed.js";
import { FeedView } from "../features/home/FeedView.js";
import { useFeedScope } from "../features/home/feedScope.js";
import { ReportImport } from "../features/import/ReportImport.js";
import { useWorkspaceScope } from "../features/sidebar/scope.js";
import { IconButton } from "../ui/Button.js";

/** Refresh Home: reads the workspace's threads, folders, drafts and Trash
 * again, and every card's root (the desktop's `refreshResearchNavigation`). */
function RefreshHomeButton({ workspaceId }: { workspaceId: string }) {
  const client = useQueryClient();
  return (
    <IconButton
      label="Refresh Home"
      onClick={() =>
        invalidateKeys(
          client,
          ["trees"],
          ["shared"],
          ["feedRoot"],
          queryKeys.folders(workspaceId),
          queryKeys.drafts(workspaceId),
          queryKeys.trash(workspaceId),
        )
      }
    >
      <RotateCw size={14} aria-hidden="true" />
    </IconButton>
  );
}

export function HomePage() {
  const { workspaceId } = useWorkspaceScope();
  const signedIn = useSignedIn();
  const feed = useFeedScope(signedIn);
  // The report drop target is the whole column, so a report can be dropped
  // anywhere on the page (`10` §5).
  const columnRef = useRef<HTMLDivElement | null>(null);

  if (signedIn && feed.mode === "workspace") {
    return (
      <div ref={columnRef} className="h-full">
        <FeedView
          key={workspaceId}
          view={{ kind: "home" }}
          workspaceId={workspaceId}
          composer={<ResearchQueryComposer workspaceId={workspaceId} homeFocus />}
          headerActions={
            <>
              <RefreshHomeButton workspaceId={workspaceId} />
              <ReportImport workspaceId={workspaceId} dropTarget={columnRef} />
            </>
          }
        />
      </div>
    );
  }

  return (
    <ActivityFeed key={feed.scope} workspaceId={workspaceId} scope={feed.scope} title="All Users" />
  );
}
