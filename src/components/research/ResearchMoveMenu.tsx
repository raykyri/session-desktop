import { Bell, Bookmark, Check, House, Plus, Star } from "lucide-react";
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

export interface ResearchTreeMenuProps {
  currentPlace: string;
  folders: ResearchFolder[];
  bookmarked?: boolean;
  onToggleBookmark?: () => void;
  followed?: boolean;
  /** Why Follow is unavailable (an archived question). */
  followDisabledReason?: string | null;
  onToggleFollow?: () => void;
  onMove: (place: string) => void;
  onNewFolder: () => void;
}

/** The actions on a whole question: Bookmark and Follow when given, then
 * Move to with every folder (the current one disabled and checked), then New
 * folder…, which creates a folder and moves the question into it. A feed
 * row's menu holds only these; the root answer's menu adds them below its
 * own actions. */
export function ResearchTreeMenuItems({
  currentPlace,
  folders,
  bookmarked,
  onToggleBookmark,
  followed = false,
  followDisabledReason = null,
  onToggleFollow,
  onMove,
  onNewFolder,
}: ResearchTreeMenuProps) {
  return (
    <>
      {onToggleBookmark ? (
        <>
          <ResearchMenuItem
            icon={
              <Bookmark size={15} aria-hidden="true" fill={bookmarked ? "currentColor" : "none"} />
            }
            label={bookmarked ? "Remove bookmark" : "Bookmark"}
            onSelect={onToggleBookmark}
          />
          {onToggleFollow ? null : <ResearchMenuSeparator />}
        </>
      ) : null}
      {onToggleFollow ? (
        <>
          <ResearchMenuItem
            icon={
              <Bell
                size={15}
                aria-hidden="true"
                fill={followed && !followDisabledReason ? "currentColor" : "none"}
              />
            }
            label={followed && !followDisabledReason ? "Unfollow" : "Follow"}
            disabled={followDisabledReason !== null}
            title={followDisabledReason ?? undefined}
            onSelect={onToggleFollow}
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
    </>
  );
}

/** A feed row's menu: the question's actions. A starred child row's menu
 * starts with Remove star, then its question's actions. */
export default function ResearchMoveMenu({
  anchor,
  onRemoveStar,
  onClose,
  ...items
}: ResearchTreeMenuProps & {
  anchor: HTMLElement;
  /** Given for a starred child row: unstars the follow-up or branch. */
  onRemoveStar?: () => void;
  onClose: () => void;
}) {
  return (
    <ResearchMenu
      anchor={anchor}
      label={onRemoveStar ? "Starred item actions" : "Bookmark, follow or move"}
      width={MENU_WIDTH}
      onClose={onClose}
    >
      {onRemoveStar ? (
        <>
          <ResearchMenuItem
            icon={<Star size={15} aria-hidden="true" />}
            label="Remove star"
            onSelect={onRemoveStar}
          />
          <ResearchMenuSeparator />
        </>
      ) : null}
      <ResearchTreeMenuItems {...items} />
    </ResearchMenu>
  );
}
