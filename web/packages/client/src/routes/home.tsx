// Home (`10-home-feed-journal-encyclopedia.md` §1): the reading-surface column
// with the composer (which carries the report import control) and the
// activity feed.

import { useRef } from "react";

import { ResearchQueryComposer } from "../features/composer/ResearchQueryComposer.js";
import { ActivityFeed } from "../features/home/ActivityFeed.js";
import { ReportImport } from "../features/import/ReportImport.js";
import { useWorkspaceScope } from "../features/sidebar/scope.js";

export function HomePage() {
  const { workspaceId } = useWorkspaceScope();
  // The drop target is the whole column, so a report can be dropped anywhere on
  // the page rather than onto the composer's import icon alone (`10` §5).
  const scrollRef = useRef<HTMLDivElement | null>(null);

  return (
    <ActivityFeed
      workspaceId={workspaceId}
      title="Home"
      scrollRef={scrollRef}
      header={
        <div className="pb-6">
          <ResearchQueryComposer
            workspaceId={workspaceId}
            tools={<ReportImport workspaceId={workspaceId} dropTarget={scrollRef} />}
          />
        </div>
      }
    />
  );
}
