import type { ReactNode } from "react";
import { Ellipsis, GripVertical } from "lucide-react";

/** A row's controls: the drag handle and the … button in one pill in the
 * row's top-right corner. Used by feed rows and by a thread's message rows,
 * over the end of the row's text. The pill shows on hover, while focus is
 * inside the pill, and while the row has the `has-open-menu` class.
 * Selecting the row focuses its open button and does not show the pill.
 * The handle is decoration: a press anywhere on the row starts a drag, except
 * on the … button. `leading` sits left of the handle (a group's chevron). */
export default function ResearchRowRail({
  grip,
  leading,
  menuLabel,
  menuTitle = menuLabel,
  menuOpen,
  menuTabIndex,
  onMenu,
}: {
  grip: boolean;
  /** A control before the drag handle. */
  leading?: ReactNode;
  /** The … button's accessible name. */
  menuLabel: string;
  /** The … button's tooltip; the accessible name by default. */
  menuTitle?: string;
  menuOpen: boolean;
  /** The … button's tab index, for rows whose tab stops the list manages. */
  menuTabIndex?: number;
  onMenu?: (anchor: HTMLButtonElement) => void;
}) {
  if (!grip && !onMenu && !leading) return null;
  return (
    <span className="research-feed-rail">
      {leading}
      {grip ? (
        <span className="research-feed-card-grip" aria-hidden="true">
          <GripVertical size={14} />
        </span>
      ) : null}
      {onMenu ? (
        <button
          type="button"
          className="research-feed-icon-button research-feed-card-menu"
          title={menuTitle}
          aria-label={menuLabel}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          tabIndex={menuTabIndex}
          data-research-no-drag
          onClick={(event) => onMenu(event.currentTarget)}
        >
          <Ellipsis size={14} aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}
