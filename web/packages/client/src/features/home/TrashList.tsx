// The rows of the Trash (the desktop's `ResearchTrashList.tsx`), in its Home
// tray and in its own view, most recently trashed first. Rows don't open;
// each has Restore and Delete now (for a thread shared with the reader, web
// only, Delete now leaves it).

import { researchThreadKind } from "@session/shared/lib/researchRowGlyph";
import type { ResearchTrashEntry } from "@session/shared/lib/researchTrash";
import { shortWhen } from "@session/shared/lib/shortTime";
import { Folder } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/cn.js";
import { RowGlyph } from "../../ui/RowGlyph.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

import { FeedEmpty } from "./FeedTray.js";

function trashedTooltip(trashedAt: number): string {
  return `Moved to the Trash ${new Date(trashedAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })}`;
}

/** The small bordered button of the feed's headers and rows. */
export const FEED_BUTTON =
  "inline-flex h-[26px] shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md " +
  "border border-border-strong bg-surface-feed-field px-2.5 text-[length:calc(var(--fs-sm)+0.5px)] " +
  "font-medium text-fg-primary hover:not-disabled:bg-surface-fill-medium " +
  "disabled:cursor-not-allowed disabled:opacity-45 " +
  FOCUS_RING;

/** The borderless variant (Delete now in a Trash row). */
export const FEED_GHOST_BUTTON = cn(
  FEED_BUTTON,
  "border-transparent bg-transparent text-fg-secondary hover:not-disabled:bg-surface-fill-hover hover:not-disabled:text-fg-primary",
);

export function TrashList({
  entries,
  now,
  onRestore,
  onDeleteNow,
}: {
  entries: readonly ResearchTrashEntry[];
  /** The time the rows' ages are measured from; the first render's by
   * default. */
  now?: number;
  onRestore: (entry: ResearchTrashEntry) => void;
  /** `trigger` is the row's Delete now button, where focus returns. */
  onDeleteNow: (entry: ResearchTrashEntry, trigger: HTMLElement) => void;
}) {
  const [renderedAt] = useState(() => Date.now());
  const reference = now ?? renderedAt;
  if (entries.length === 0) return <FeedEmpty>The Trash is empty.</FeedEmpty>;
  return (
    <ul className="m-0 list-none px-2 pt-0 pb-1" aria-label="Items in the Trash">
      {entries.map((entry) => (
        <li
          key={`${entry.kind}:${entry.id}`}
          className="flex min-h-10 items-center gap-2.5 rounded-lg py-1.5 pr-1 pl-3"
          data-research-trash={entry.id}
        >
          <span className="text-fg-muted inline-flex shrink-0">
            {entry.kind === "folder" ? (
              <Folder size={14} aria-hidden="true" />
            ) : (
              <RowGlyph kind={researchThreadKind(entry.tree, undefined)} />
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="text-fg-primary text-base leading-[1.35] [overflow-wrap:anywhere]">
              {entry.title}
            </span>
            <span className="text-fg-faint text-xs" title={trashedTooltip(entry.trashedAt)}>
              {entry.kind === "folder"
                ? "Folder · "
                : entry.tree.role !== undefined && entry.tree.role !== "owner"
                  ? "Shared with you · "
                  : ""}
              {shortWhen(entry.trashedAt, reference)}
            </span>
          </span>
          <span className="flex shrink-0 gap-1">
            <button
              type="button"
              className={FEED_BUTTON}
              aria-label={`Restore ${entry.title}`}
              onClick={() => onRestore(entry)}
            >
              Restore
            </button>
            <button
              type="button"
              className={FEED_GHOST_BUTTON}
              aria-label={`Delete ${entry.title} now`}
              onClick={(event) => onDeleteNow(entry, event.currentTarget)}
            >
              Delete now
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}
