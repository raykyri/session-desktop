import { Folder } from "lucide-react";
import type { ResearchTrashEntry } from "@session/shared/lib/researchTrash";
import { researchThreadKind } from "@session/shared/lib/researchRowGlyph";
import { shortWhen } from "../../lib/shortTime";
import ResearchRowGlyph from "./ResearchRowGlyph";

function trashedTooltip(trashedAt: number): string {
  return `Moved to the Trash ${new Date(trashedAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })}`;
}

/** The rows of the Trash, in its Home tray and in its own view, most recently
 * trashed first. Rows don't open; each has Restore and Delete now. */
export default function ResearchTrashList({
  entries,
  now = Date.now(),
  onRestore,
  onDeleteNow,
}: {
  entries: readonly ResearchTrashEntry[];
  now?: number;
  onRestore: (entry: ResearchTrashEntry) => void;
  /** `trigger` is the row's Delete now button, where focus returns. */
  onDeleteNow: (entry: ResearchTrashEntry, trigger: HTMLElement) => void;
}) {
  if (entries.length === 0) {
    return <div className="research-feed-empty">The Trash is empty.</div>;
  }
  return (
    <ul className="research-trash-list" aria-label="Items in the Trash">
      {entries.map((entry) => (
        <li key={`${entry.kind}:${entry.id}`} className="research-trash-row" data-research-trash={entry.id}>
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
          <span className="research-trash-actions">
            <button
              type="button"
              className="research-feed-button"
              aria-label={`Restore ${entry.title}`}
              onClick={() => onRestore(entry)}
            >
              Restore
            </button>
            <button
              type="button"
              className="research-feed-button is-ghost"
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
