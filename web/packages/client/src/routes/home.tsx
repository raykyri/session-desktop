// Home (`10-home-feed-journal-encyclopedia.md` §1): the reading-surface column
// with the composer, the report import, and the activity feed.

import { useRef } from "react";

import { ResearchQueryComposer } from "../features/composer/ResearchQueryComposer.js";
import { ActivityFeed } from "../features/home/ActivityFeed.js";
import { ReportImport } from "../features/import/ReportImport.js";
import { useWorkspaceScope } from "../features/sidebar/scope.js";

export function HomePage() {
  const { workspaceId } = useWorkspaceScope();
  // The drop target is the whole column, so a report can be dropped anywhere on
  // the page rather than onto the button alone (`10` §5).
  const scrollRef = useRef<HTMLDivElement | null>(null);

  return (
    <ActivityFeed
      workspaceId={workspaceId}
      title="Home"
      scrollRef={scrollRef}
      header={
        <div className="flex flex-col gap-3 pb-6">
          <ResearchQueryComposer workspaceId={workspaceId} />
          <div className="flex justify-end">
            <ReportImport workspaceId={workspaceId} dropTarget={scrollRef} />
          </div>
        </div>
      }
    />
  );
}
