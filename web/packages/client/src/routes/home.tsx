// Home (`10-home-feed-journal-encyclopedia.md` §1): the reading-surface column
// with the composer (which carries the report import control) and the
// activity feed.

import { useRef } from "react";

import { useSignedIn, useWorkspaces } from "../api/queries.js";
import { ResearchQueryComposer } from "../features/composer/ResearchQueryComposer.js";
import { ActivityFeed } from "../features/home/ActivityFeed.js";
import { useFeedScope } from "../features/home/feedScope.js";
import { ReportImport } from "../features/import/ReportImport.js";
import { useWorkspaceScope } from "../features/sidebar/scope.js";

export function HomePage() {
  const { workspaceId } = useWorkspaceScope();
  const signedIn = useSignedIn();
  const workspaces = useWorkspaces();
  const feed = useFeedScope(workspaceId, signedIn);
  const workspaceTitle =
    workspaces.data?.find((workspace) => workspace.id === workspaceId)?.name ?? workspaceId;
  const title =
    feed.mode === "all"
      ? "All Users"
      : feed.mode === "workspaces"
        ? "My Workspaces"
        : workspaceTitle;
  // The drop target is the whole column, so a report can be dropped anywhere on
  // the page rather than onto the composer's import icon alone (`10` §5).
  const scrollRef = useRef<HTMLDivElement | null>(null);

  return (
    <ActivityFeed
      key={feed.scope === "workspace" ? `ws:${workspaceId}` : feed.scope}
      workspaceId={workspaceId}
      scope={feed.scope}
      title={title}
      scrollRef={scrollRef}
      scopeSwitcher={
        signedIn ? { mode: feed.mode, workspaceTitle, onChange: feed.setMode } : undefined
      }
      header={
        signedIn ? (
          <div className="pb-6">
            <ResearchQueryComposer
              workspaceId={workspaceId}
              tools={<ReportImport workspaceId={workspaceId} dropTarget={scrollRef} />}
            />
          </div>
        ) : null
      }
    />
  );
}
