// Home (`10-home-feed-journal.md` §1): for a signed-in account, the
// workspace's Home as on the desktop — the ask box, Unfiled, the trays, and
// "+ New folder" (`features/home/FeedView.tsx`). The header's feed menu also
// offers the web's All Users and My Workspaces feeds; a guest sees All Users.

import { ChevronDown } from "lucide-react";
import { useRef } from "react";

import { useSignedIn } from "../api/queries.js";
import { ResearchQueryComposer } from "../features/composer/ResearchQueryComposer.js";
import { ActivityFeed } from "../features/home/ActivityFeed.js";
import { FeedView } from "../features/home/FeedView.js";
import { useFeedScope } from "../features/home/feedScope.js";
import { ReportImport } from "../features/import/ReportImport.js";
import { useWorkspaceScope } from "../features/sidebar/scope.js";
import type { FeedMode } from "../stores/navigation.js";
import { ControlButton } from "../ui/Button.js";
import { Menu, MenuItem } from "../ui/Menu.js";

const FEED_TITLES: Record<FeedMode, string> = {
  workspace: "Home",
  workspaces: "My Workspaces",
  all: "All Users",
};

/** The header menu that switches between Home and the web's two feeds. */
function FeedModeMenu({ mode, onChange }: { mode: FeedMode; onChange: (mode: FeedMode) => void }) {
  return (
    <Menu
      align="end"
      size="sm"
      label="Feed"
      trigger={
        <ControlButton
          size="sm"
          className="max-w-52 gap-1.5"
          aria-label={`Feed: ${FEED_TITLES[mode]}`}
        >
          <span className="truncate">{FEED_TITLES[mode]}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </ControlButton>
      }
    >
      {(["workspace", "workspaces", "all"] as const).map((candidate) => (
        <MenuItem key={candidate} selected={mode === candidate} onClick={() => onChange(candidate)}>
          {FEED_TITLES[candidate]}
        </MenuItem>
      ))}
    </Menu>
  );
}

export function HomePage() {
  const { workspaceId } = useWorkspaceScope();
  const signedIn = useSignedIn();
  const feed = useFeedScope(workspaceId, signedIn);
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
          composer={<ResearchQueryComposer workspaceId={workspaceId} />}
          headerActions={
            <>
              <ReportImport workspaceId={workspaceId} dropTarget={columnRef} />
              <FeedModeMenu mode={feed.mode} onChange={feed.setMode} />
            </>
          }
        />
      </div>
    );
  }

  return (
    <ActivityFeed
      key={feed.scope === "workspace" ? `ws:${workspaceId}` : feed.scope}
      workspaceId={workspaceId}
      scope={feed.scope}
      title={FEED_TITLES[feed.mode]}
      scopeSwitcher={
        signedIn ? { mode: feed.mode, workspaceTitle: "Home", onChange: feed.setMode } : undefined
      }
    />
  );
}
