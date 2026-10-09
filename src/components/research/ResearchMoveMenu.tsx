import { Bookmark, Check, House, Plus } from "lucide-react";
import type { ResearchFolder } from "../../types";
import {
  RESEARCH_ARCHIVE_FOLDER_ID,
  RESEARCH_DRAFTS_FOLDER_ID,
  RESEARCH_UNFILED_FOLDER_ID,
} from "../../lib/researchFolders";
import { ResearchPlaceIcon } from "./ResearchFeedChrome";
import {
  ResearchMenu,
  ResearchMenuItem,
  ResearchMenuSeparator,
  ResearchMenuTitle,
} from "./ResearchMenu";

const MENU_WIDTH = 220;

/** Every place a question can be moved to, in sidebar order. */
export function researchMoveTargets(folders: ResearchFolder[]) {
  return [
    { place: RESEARCH_UNFILED_FOLDER_ID, name: "Unfiled" },
    { place: RESEARCH_DRAFTS_FOLDER_ID, name: "Drafts" },
    ...folders.map((folder) => ({ place: folder.id, name: folder.name })),
    { place: RESEARCH_ARCHIVE_FOLDER_ID, name: "Archive" },
  ];
}

/** A card's or conversation header's menu: Bookmark at the top when given,
 * then Move to with every folder (the current one disabled and checked),
 * then New folder…, which creates a folder and moves the question into it. */
export default function ResearchMoveMenu({
  anchor,
  currentPlace,
  folders,
  bookmarked,
  onToggleBookmark,
  onMove,
  onNewFolder,
  onClose,
}: {
  anchor: HTMLElement;
  currentPlace: string;
  folders: ResearchFolder[];
  bookmarked?: boolean;
  onToggleBookmark?: () => void;
  onMove: (place: string) => void;
  onNewFolder: () => void;
  onClose: () => void;
}) {
  return (
    <ResearchMenu anchor={anchor} label="Bookmark or move" width={MENU_WIDTH} onClose={onClose}>
      {onToggleBookmark ? (
        <>
          <ResearchMenuItem
            icon={
              <Bookmark size={15} aria-hidden="true" fill={bookmarked ? "currentColor" : "none"} />
            }
            label={bookmarked ? "Remove bookmark" : "Bookmark"}
            onSelect={onToggleBookmark}
          />
          <ResearchMenuSeparator />
        </>
      ) : null}
      <ResearchMenuTitle>Move to</ResearchMenuTitle>
      <div role="group" aria-label="Move to">
        {researchMoveTargets(folders).map((target) => {
          const here = target.place === currentPlace;
          return (
            <ResearchMenuItem
              key={target.place}
              icon={
                target.place === RESEARCH_UNFILED_FOLDER_ID ? (
                  <House size={15} aria-hidden="true" />
                ) : (
                  <ResearchPlaceIcon place={target.place} size={15} />
                )
              }
              label={target.name}
              disabled={here}
              checked={here}
              trailing={
                here ? <Check className="research-menu-check" size={15} aria-hidden="true" /> : null
              }
              onSelect={() => onMove(target.place)}
            />
          );
        })}
      </div>
      <ResearchMenuSeparator />
      <ResearchMenuItem
        icon={<Plus size={15} aria-hidden="true" />}
        label="New folder…"
        onSelect={onNewFolder}
      />
    </ResearchMenu>
  );
}
