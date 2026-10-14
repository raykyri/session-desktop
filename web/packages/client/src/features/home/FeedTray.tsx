// A Home tray (the desktop's `ResearchFeedTray.tsx`): one per folder, plus
// Drafts, Archive and Trash. The name opens the place's own view; the rest of
// the header collapses and expands the tray.

import {
  RESEARCH_ARCHIVE_FOLDER_ID,
  RESEARCH_DRAFTS_FOLDER_ID,
  RESEARCH_TRASH_FOLDER_ID,
  RESEARCH_UNFILED_FOLDER_ID,
} from "@session/shared/lib/researchFolders";
import { Archive, ChevronDown, FilePen, Folder, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

/** A place's icon: Drafts, Archive, Trash, or a folder. */
export function PlaceIcon({ place, size = 14 }: { place: string; size?: number }) {
  if (place === RESEARCH_DRAFTS_FOLDER_ID) return <FilePen size={size} aria-hidden="true" />;
  if (place === RESEARCH_ARCHIVE_FOLDER_ID) return <Archive size={size} aria-hidden="true" />;
  if (place === RESEARCH_TRASH_FOLDER_ID) return <Trash2 size={size} aria-hidden="true" />;
  return <Folder size={size} aria-hidden="true" />;
}

/** The message an empty place shows. */
export function placeEmptyText(place: string): string {
  if (place === RESEARCH_UNFILED_FOLDER_ID) return "Nothing unfiled. New questions appear here.";
  if (place === RESEARCH_ARCHIVE_FOLDER_ID) {
    return "Archive is empty. Archived questions stop sending follow-up notifications.";
  }
  if (place === RESEARCH_DRAFTS_FOLDER_ID) {
    return "No drafts. Use Save draft in the composer to keep a question for later.";
  }
  return "Empty folder. Drag or file questions here.";
}

/** The empty-place message, at the cards' inset. */
export function FeedEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="text-fg-muted px-4 pt-3 pb-3.5 text-[length:calc(var(--fs-sm)+0.5px)] leading-normal">
      {children}
    </div>
  );
}

export function FeedTray({
  place,
  name,
  count = 0,
  countNoun = ["question", "questions"],
  drop = true,
  collapsed,
  onToggle,
  onOpen,
  children,
}: {
  place: string;
  name: string;
  /** How many items the place holds; shown after its name. */
  count?: number;
  /** The singular and plural noun read after the count. */
  countNoun?: [string, string];
  /** Whether cards can be dropped on the tray (not the Trash). */
  drop?: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "border-border-divider bg-surface-tray mx-2.5 mb-2.5 rounded-[10px] border",
        "transition-[background-color,border-color] duration-(--transition-fast)",
        "[&.is-drop-target]:border-border-drop [&.is-drop-target]:bg-surface-drop",
        collapsed && "in-[.is-research-dragging]:border-dashed",
      )}
      aria-label={name}
      data-research-drop={drop ? place : undefined}
      data-research-tray-collapsed={collapsed ? "" : undefined}
    >
      {/* The header's own click toggles; its buttons are the keyboard path. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <header
        className="flex min-h-9 cursor-pointer items-center gap-0.5 pr-1.5"
        onClick={onToggle}
      >
        <div className="text-fg-secondary flex min-h-9 min-w-0 flex-1 items-center gap-[7px] py-[5px] pr-2 pl-3.5 leading-[1.35]">
          <PlaceIcon place={place} />
          <button
            type="button"
            className={cn(
              "text-fg-secondary hover:text-fg-heading min-w-0 cursor-pointer border-0 bg-transparent py-[3px] text-left text-base font-semibold [overflow-wrap:anywhere]",
              FOCUS_RING,
            )}
            title={`Open ${name}`}
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          >
            {name}
          </button>
          {count > 0 ? (
            <span className="text-fg-faint shrink-0 text-[length:calc(var(--fs-base)-1px)] font-normal">
              {count}
              <span className="sr-only"> {count === 1 ? countNoun[0] : countNoun[1]}</span>
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className={cn(
            "text-fg-muted hover:bg-surface-fill-hover hover:text-fg-primary grid size-[26px] shrink-0 place-items-center rounded-md border-0 bg-transparent",
            FOCUS_RING,
          )}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${name}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        >
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={cn("transition-transform duration-150", collapsed && "-rotate-90")}
          />
        </button>
      </header>
      {collapsed ? null : (
        <div className="pb-1.5 empty:pb-0" data-research-tray-body="">
          {children}
        </div>
      )}
    </section>
  );
}
