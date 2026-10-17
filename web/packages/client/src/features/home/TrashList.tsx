// The rows of the Trash (the desktop's `ResearchTrashList.tsx`), in its Home
// tray and in its own view, most recently trashed first. Rows don't open.
// Restore and Delete now are in the row's … menu (for a thread shared with
// the reader, web only, Delete now leaves it).

import { researchThreadKind } from "@session/shared/lib/researchRowGlyph";
import type { ResearchTrashEntry } from "@session/shared/lib/researchTrash";
import { shortWhen } from "@session/shared/lib/shortTime";
import { ArchiveRestore, Ellipsis, Folder, Trash2 } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/cn.js";
import { AnchoredMenu } from "../../ui/AnchoredMenu.js";
import { RowGlyph } from "../../ui/RowGlyph.js";
import { FOCUS_RING } from "../../ui/surfaces.js";
import { IconMenuItem } from "../sidebar/menuRows.js";

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

function entryKey(entry: ResearchTrashEntry) {
  return `${entry.kind}:${entry.id}`;
}

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
  /** `trigger` is the row's … button, where focus returns. */
  onDeleteNow: (entry: ResearchTrashEntry, trigger: HTMLElement) => void;
}) {
  const [renderedAt] = useState(() => Date.now());
  const [menu, setMenu] = useState<{ entry: ResearchTrashEntry; anchor: HTMLButtonElement } | null>(
    null,
  );
  const reference = now ?? renderedAt;
  if (entries.length === 0) return <FeedEmpty>The Trash is empty.</FeedEmpty>;
  return (
    <>
      <ul className="m-0 list-none px-2 pt-0 pb-1" aria-label="Items in the Trash">
        {entries.map((entry) => {
          const open = menu !== null && entryKey(menu.entry) === entryKey(entry);
          return (
            <li
              key={entryKey(entry)}
              className={cn(
                "group/trash relative flex min-h-10 items-center gap-2.5 rounded-lg py-1.5 pr-1 pl-3",
                open && "has-open-menu",
              )}
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
              <span
                className={cn(
                  "border-border-strong bg-surface-feed-popover absolute top-[5px] right-[5px] z-2 flex h-6 items-center gap-px rounded-[7px] border px-0.5 opacity-0",
                  "pointer-events-none shadow-[0_2px_8px_color-mix(in_srgb,var(--text-heading)_8%,transparent)]",
                  "group-focus-within/trash:opacity-85 group-hover/trash:opacity-85 group-[.has-open-menu]/trash:opacity-85",
                )}
              >
                <button
                  type="button"
                  className={cn(
                    "text-fg-muted hover:bg-surface-fill-hover hover:text-fg-primary pointer-events-auto grid h-5 w-[22px] place-items-center rounded-[5px] border-0 bg-transparent p-0",
                    FOCUS_RING,
                  )}
                  title={`Trash actions for ${entry.title}`}
                  aria-label={`Trash actions for ${entry.title}`}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  onClick={(event) => {
                    const anchor = event.currentTarget;
                    setMenu((current) =>
                      current && current.anchor === anchor ? null : { entry, anchor },
                    );
                  }}
                >
                  <Ellipsis size={14} aria-hidden="true" />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {menu ? (
        <AnchoredMenu
          anchor={menu.anchor}
          label={`Actions for ${menu.entry.title}`}
          align="end"
          onClose={() => setMenu(null)}
        >
          <IconMenuItem
            icon={<ArchiveRestore size={15} aria-hidden="true" />}
            onClick={() => {
              const entry = menu.entry;
              setMenu(null);
              onRestore(entry);
            }}
          >
            Restore
          </IconMenuItem>
          <IconMenuItem
            icon={<Trash2 size={15} aria-hidden="true" />}
            tone="danger"
            shortcut="D"
            onClick={() => {
              const { entry, anchor } = menu;
              setMenu(null);
              onDeleteNow(entry, anchor);
            }}
          >
            Delete now
          </IconMenuItem>
        </AnchoredMenu>
      ) : null}
    </>
  );
}
