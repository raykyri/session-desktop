import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import {
  RESEARCH_ARCHIVE_FOLDER_ID,
  RESEARCH_DRAFTS_FOLDER_ID,
  RESEARCH_UNFILED_FOLDER_ID,
} from "../../lib/researchFolders";
import { ResearchPlaceIcon } from "./ResearchFeedChrome";

/** Message shown when a research location is empty. */
export function researchPlaceEmptyText(place: string): string {
  if (place === RESEARCH_UNFILED_FOLDER_ID) return "Nothing unfiled. New questions appear here.";
  if (place === RESEARCH_ARCHIVE_FOLDER_ID) {
    return "Archive is empty. Archived questions stop sending follow-up notifications.";
  }
  if (place === RESEARCH_DRAFTS_FOLDER_ID) {
    return "No drafts. Use Save draft in the composer to keep a question for later.";
  }
  return "Empty folder. Drag or file questions here.";
}

/** Home folder tray. The name opens the folder, while the remaining header
 * toggles the tray. The tray accepts drops and expands during drag hover. */
export default function ResearchFeedTray({
  place,
  name,
  count = 0,
  collapsed,
  onToggle,
  onOpen,
  children,
}: {
  place: string;
  name: string;
  /** How many questions the folder holds; shown after its name. */
  count?: number;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <section
      className={`research-feed-tray${collapsed ? " is-collapsed" : ""}`}
      aria-label={name}
      data-research-drop={place}
      data-research-tray-collapsed={collapsed ? "" : undefined}
    >
      <header className="research-feed-tray-header" onClick={onToggle}>
        <div className="research-feed-tray-title">
          <ResearchPlaceIcon place={place} />
          <button
            type="button"
            className="research-feed-tray-name"
            title={`Open ${name}`}
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          >
            {name}
          </button>
          {count > 0 ? (
            <span className="research-feed-tray-count">
              {count}
              <span className="research-visually-hidden"> {count === 1 ? "question" : "questions"}</span>
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="research-feed-icon-button research-feed-tray-chevron"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${name}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </header>
      {collapsed ? null : <div className="research-feed-tray-body">{children}</div>}
    </section>
  );
}
