import type { ReactNode } from "react";
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
  type ResearchMenuAlign,
  type ResearchMenuRect,
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
  /** Shows A on the available Archive target and enables it as a menu shortcut. */
  archiveShortcut?: boolean;
  /** Given with `onNewFolder`: adds Move to and New folder…. */
  onMove?: (place: string) => void;
  onNewFolder?: () => void;
}

/** The actions on a whole question: Bookmark and Follow when given, then
 * Move to with every folder (the current one disabled and checked), then New
 * folder…, which creates a folder and moves the question into it. A feed
 * card's menu follows them with the thread's own actions (Generate recap,
 * Rename, Archive, Delete); the root answer's menu adds them below its own
 * actions. */
export function ResearchTreeMenuItems({
  currentPlace,
  folders,
  bookmarked,
  onToggleBookmark,
  followed = false,
  followDisabledReason = null,
  onToggleFollow,
  archiveShortcut = false,
  onMove,
  onNewFolder,
}: ResearchTreeMenuProps) {
  const move = onMove && onNewFolder ? { onMove, onNewFolder } : null;
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
          {onToggleFollow || !move ? null : <ResearchMenuSeparator />}
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
          {move ? <ResearchMenuSeparator /> : null}
        </>
      ) : null}
      {move ? (
        <ResearchMoveItems
          currentPlace={currentPlace}
          folders={folders}
          archiveShortcut={archiveShortcut}
          {...move}
        />
      ) : null}
    </>
  );
}

function ResearchMoveItems({
  currentPlace,
  folders,
  archiveShortcut,
  onMove,
  onNewFolder,
}: {
  currentPlace: string;
  folders: ResearchFolder[];
  archiveShortcut: boolean;
  onMove: (place: string) => void;
  onNewFolder: () => void;
}) {
  return (
    <>
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
              shortcut={
                archiveShortcut && !here && target.place === RESEARCH_ARCHIVE_FOLDER_ID
                  ? "A"
                  : undefined
              }
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

interface ResearchFeedRowMenuItemsProps extends ResearchTreeMenuProps {
  /** Given for a starred child row: unstars the follow-up or branch. */
  onRemoveStar?: () => void;
  /** The thread's actions, after the question's. */
  children?: ReactNode;
}

/** A feed row's menu items. A card's menu holds its question's actions
 * (Bookmark, Follow, Move to), then after a separator the thread's actions
 * passed as `children` (Generate recap, Rename, Archive, Delete). A starred
 * child row's menu starts with Remove star, then its question's actions. */
export function ResearchFeedRowMenuItems({ onRemoveStar, children, ...items }: ResearchFeedRowMenuItemsProps) {
  return (
    <>
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
      {children ? (
        <>
          <ResearchMenuSeparator />
          {children}
        </>
      ) : null}
    </>
  );
}

/** A feed row's menu (see ResearchFeedRowMenuItems). The row's … button and
 * its context menu open this same menu. */
export default function ResearchFeedRowMenu({
  anchor,
  align,
  label,
  onClose,
  ...items
}: ResearchFeedRowMenuItemsProps & {
  /** The row's … button, or for a context menu the pointer or the button's
   * rectangle. */
  anchor: HTMLElement | ResearchMenuRect;
  align?: ResearchMenuAlign;
  label: string;
  onClose: () => void;
}) {
  return (
    <ResearchMenu anchor={anchor} align={align} label={label} width={MENU_WIDTH} onClose={onClose}>
      <ResearchFeedRowMenuItems {...items} />
    </ResearchMenu>
  );
}
