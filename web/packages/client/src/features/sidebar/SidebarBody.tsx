// Everything inside the sidebar frame (`10-home-feed-journal.md` §7): the
// workspace switcher and the places (`SidebarNav`). Split out of `AppShell`'s
// `Sidebar` so the narrow-layout drawer and the resizable column render the
// same thing; `SidebarRailBody` is the collapsed sidebar's icon rail.

import { workspaceResearchFolders } from "@session/shared/lib/researchFolders";
import { useMemo } from "react";

import { useFolders, useSignedIn } from "../../api/queries.js";
import { errorMessage } from "../../lib/toast.js";

import { SidebarNav } from "./SidebarNav.js";
import { SidebarRail } from "./SidebarRail.js";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import { useWorkspaceScope } from "./scope.js";

/** The scoped workspace's folders, for the sidebar and its rail. */
function useSidebarFolders() {
  const signedIn = useSignedIn();
  const { workspaceId, setScope } = useWorkspaceScope();
  const folderQuery = useFolders(signedIn ? workspaceId : "");
  const folders = useMemo(
    () => (folderQuery.data ? workspaceResearchFolders(folderQuery.data, workspaceId) : []),
    [folderQuery.data, workspaceId],
  );
  return { signedIn, workspaceId, setScope, folderQuery, folders };
}

/** The collapsed sidebar (`SidebarRail`). */
export function SidebarRailBody({ onExpand }: { onExpand: () => void }) {
  const { signedIn, workspaceId, folders } = useSidebarFolders();
  return (
    <SidebarRail
      workspaceId={workspaceId}
      folders={folders}
      signedIn={signedIn}
      onExpand={onExpand}
    />
  );
}

export function SidebarBody() {
  const { signedIn, workspaceId, setScope, folderQuery, folders } = useSidebarFolders();

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto pb-2">
      <WorkspaceSwitcher workspaceId={workspaceId} onSelect={setScope} />
      <SidebarNav
        workspaceId={workspaceId}
        folders={folders}
        signedIn={signedIn}
        foldersLoadError={folderQuery.isError ? errorMessage(folderQuery.error) : null}
        onRetryFoldersLoad={() => void folderQuery.refetch()}
      />
    </div>
  );
}
