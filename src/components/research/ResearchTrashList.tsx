import { useState } from "react";
import { ArchiveRestore, Folder, Trash2 } from "lucide-react";
import type { ResearchTrashEntry } from "@session/shared/lib/researchTrash";
import { researchThreadKind } from "@session/shared/lib/researchRowGlyph";
import { shortWhen } from "@session/shared/lib/shortTime";
import { ResearchMenu, ResearchMenuItem } from "./ResearchMenu";
import ResearchRowGlyph from "./ResearchRowGlyph";
import ResearchRowRail from "./ResearchRowRail";

function trashedTooltip(trashedAt: number): string {
  return `Moved to the Trash ${new Date(trashedAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })}`;
}

function entryKey(entry: ResearchTrashEntry) {
  return `${entry.kind}:${entry.id}`;
}

/** The rows of the Trash, in its Home tray and in its own view, most recently
 * trashed first. Rows don't open. Restore and Delete now are in the row's
 * … menu, in the same corner pill as other rows. */
export default function ResearchTrashList({
  entries,
  now = Date.now(),
  onRestore,
  onDeleteNow,
}: {
  entries: readonly ResearchTrashEntry[];
  now?: number;
  onRestore: (entry: ResearchTrashEntry) => void;
  /** `trigger` is the row's … button, where focus returns. */
  onDeleteNow: (entry: ResearchTrashEntry, trigger: HTMLElement) => void;
}) {
  const [menu, setMenu] = useState<{ entry: ResearchTrashEntry; anchor: HTMLButtonElement } | null>(null);
  if (entries.length === 0) {
    return <div className="research-feed-empty">The Trash is empty.</div>;
  }
  return (
    <>
      <ul className="research-trash-list" aria-label="Items in the Trash">
        {entries.map((entry) => {
          const open = menu !== null && entryKey(menu.entry) === entryKey(entry);
          return (
            <li
              key={entryKey(entry)}
              className={`research-trash-row${open ? " has-open-menu" : ""}`}
              data-research-trash={entry.id}
            >
              <span className="research-trash-icon">
                {entry.kind === "folder" ? (
                  <Folder size={14} aria-hidden="true" />
                ) : (
                  <ResearchRowGlyph kind={researchThreadKind(entry.tree, undefined)} />
                )}
              </span>
              <span className="research-trash-text">
                <span className="research-trash-title">{entry.title}</span>
                <span className="research-trash-meta" title={trashedTooltip(entry.trashedAt)}>
                  {entry.kind === "folder" ? "Folder · " : ""}
                  {shortWhen(entry.trashedAt, now)}
                </span>
              </span>
              <ResearchRowRail
                grip={false}
                menuLabel={`Trash actions for ${entry.title}`}
                menuOpen={open}
                onMenu={(anchor) =>
                  setMenu((current) =>
                    current && current.anchor === anchor ? null : { entry, anchor },
                  )
                }
              />
            </li>
          );
        })}
      </ul>
      {menu ? (
        <ResearchMenu
          anchor={menu.anchor}
          align="end"
          label={`Actions for ${menu.entry.title}`}
          onClose={() => setMenu(null)}
        >
          <ResearchMenuItem
            icon={<ArchiveRestore size={15} aria-hidden="true" />}
            label="Restore"
            onSelect={() => {
              const entry = menu.entry;
              setMenu(null);
              onRestore(entry);
            }}
          />
          <ResearchMenuItem
            icon={<Trash2 size={15} aria-hidden="true" />}
            label="Delete now"
            shortcut="D"
            danger
            onSelect={() => {
              const { entry, anchor } = menu;
              setMenu(null);
              onDeleteNow(entry, anchor);
            }}
          />
        </ResearchMenu>
      ) : null}
    </>
  );
}
