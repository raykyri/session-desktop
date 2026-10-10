import { useRef, type CSSProperties, type ReactNode } from "react";
import { Ellipsis, GripVertical, Star } from "lucide-react";
import type { ResearchFeedChild } from "../../lib/researchFolders";
import type { ResearchCardDragStart } from "../../hooks/useResearchCardDrag";

export type ResearchFeedPostStatus = "running" | "failed";

const STATUS_LABELS: Record<ResearchFeedPostStatus, string> = {
  running: "Running",
  failed: "Failed",
};

interface ResearchFeedPostProps {
  /** Tree id, or draft id for a draft card. */
  cardId: string;
  dragKind?: "tree" | "draft";
  /** The place the card is listed in, for drag and drop. */
  place: string;
  /** The thread title, shown above the question when it differs from it. */
  title?: string | null;
  /** Renders the question or note body. The body passes its prompt text
   * through `asQuestion`, which sets it as the card's question; the question
   * and anything rendered outside it (link cards, embeds) show in full. */
  renderBody: (asQuestion: (content: ReactNode) => ReactNode) => ReactNode;
  /** The accessible name of the card's open button. */
  label: string;
  /** The open button's tooltip (an archived card's archive time). */
  tooltip?: string;
  status?: ResearchFeedPostStatus | null;
  /** Replaces the status's name, such as "Failed since last viewed". */
  statusLabel?: string;
  selected?: boolean;
  /** The thread changed since it was last viewed. */
  unread?: boolean;
  /** Starred follow-ups and branches listed under the question. */
  childRows?: ResearchFeedChild[];
  /** Child rows shown selected: the open branches' heads and the message
   * selected in the root pair. */
  selectedChildNodeIds?: readonly string[];
  menuOpen?: boolean;
  /** The child row whose … menu is open. */
  childMenuNodeId?: string | null;
  /** The … button's name: "Bookmark, follow or move" by default. */
  menuLabel?: string;
  onOpen: () => void;
  onOpenChild?: (child: ResearchFeedChild) => void;
  /** Opens the card's … menu below `anchor`. */
  onMenu?: (anchor: HTMLElement) => void;
  /** Opens a child row's … menu below `anchor`. */
  onChildMenu?: (child: ResearchFeedChild, anchor: HTMLElement) => void;
  onContextMenu?: (clientX: number, clientY: number) => void;
  onDragStart?: ResearchCardDragStart;
}

const cardSelector = (cardId: string) =>
  `.research-feed-card[data-research-card="${CSS.escape(cardId)}"]`;

/** A listed card's open button, or its … button; null when the card isn't
 * listed (a collapsed tray, another view). */
export function researchFeedCardControl(
  cardId: string,
  control: "open" | "menu" = "open",
): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `${cardSelector(cardId)} ${control === "open" ? ".research-feed-card-hit" : ".research-feed-card-menu"}`,
  );
}

/** The next step for focus waiting on a moved card's old … button
 * (`anchor`): wait while that button is still listed and focused; once it is
 * gone with focus left on the page body, focus the card in its new place;
 * drop it once focus went anywhere else. */
/** A row's controls: the drag handle and the … button in one pill in the
 * row's top-right corner, where the status dot sits. The pill shows on hover
 * or focus and hides the dot. The handle is decoration: a press anywhere on
 * the row starts a drag, except on the … button. */
function FeedRowRail({
  grip,
  menuLabel,
  menuOpen,
  onMenu,
}: {
  grip: boolean;
  menuLabel: string;
  menuOpen: boolean;
  onMenu?: (anchor: HTMLElement) => void;
}) {
  if (!grip && !onMenu) return null;
  return (
    <span className="research-feed-rail">
      {grip ? (
        <span className="research-feed-card-grip" aria-hidden="true">
          <GripVertical size={14} />
        </span>
      ) : null}
      {onMenu ? (
        <button
          type="button"
          className="research-feed-icon-button research-feed-card-menu"
          title={menuLabel}
          aria-label={menuLabel}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-research-no-drag
          onClick={(event) => onMenu(event.currentTarget)}
        >
          <Ellipsis size={14} aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

export function researchCardRefocus(
  anchor: { isConnected: boolean },
  active: unknown,
  body: unknown,
): "wait" | "focus" | "drop" {
  if (anchor.isConnected) return active === anchor ? "wait" : "drop";
  return active === null || active === body ? "focus" : "drop";
}

/** One question in the feed: the thread title (when it differs) and the
 * question, with no metadata row. Rows are bubbles: no fill at rest, an inset
 * rounded fill on hover and selection, and a faint ring on the focused row.
 * Running and failed threads show a status dot in the top-right corner,
 * which the drag handle and … button replace on hover and focus. The whole
 * card opens the thread; links and embeds inside it stay their own targets.
 * Starred children follow as indented rows of their own, each with the same
 * margin controls; dragging one drags its question. */
export default function ResearchFeedPost({
  cardId,
  dragKind = "tree",
  place,
  title,
  renderBody,
  label,
  tooltip,
  status = null,
  statusLabel: statusLabelOverride,
  selected = false,
  unread = false,
  childRows = [],
  selectedChildNodeIds = [],
  menuOpen = false,
  childMenuNodeId = null,
  menuLabel = "Bookmark, follow or move",
  onOpen,
  onOpenChild,
  onMenu,
  onChildMenu,
  onContextMenu,
  onDragStart,
}: ResearchFeedPostProps) {
  const statusLabel = status ? (statusLabelOverride ?? STATUS_LABELS[status]) : null;
  const cardRef = useRef<HTMLDivElement | null>(null);
  return (
    <>
      <div
        ref={cardRef}
        className={`research-feed-card${selected ? " is-selected" : ""}${
          menuOpen ? " has-open-menu" : ""
        }${childRows.length > 0 ? " has-children" : ""}`}
        data-research-card={cardId}
        data-research-card-kind={dragKind}
        onPointerDown={onDragStart ? (event) => onDragStart(event, { kind: dragKind, id: cardId, place }) : undefined}
        onContextMenu={
          onContextMenu
            ? (event) => {
                if (event.defaultPrevented) return;
                event.preventDefault();
                event.stopPropagation();
                onContextMenu(event.clientX, event.clientY);
              }
            : undefined
        }
      >
        <button
          type="button"
          className="research-feed-card-hit"
          aria-label={statusLabel ? `${label}, ${statusLabel}` : label}
          aria-current={selected ? "true" : undefined}
          title={tooltip}
          onClick={onOpen}
        />
        {unread ? (
          <span className="research-feed-card-unread" role="img" aria-label="Updated" />
        ) : null}
        <div className="research-feed-card-content">
          {title ? <span className="research-feed-card-title">{title}</span> : null}
          {renderBody((content) => (
            <div className="research-feed-card-question">{content}</div>
          ))}
        </div>
        {status ? (
          <span
            className={`research-feed-status is-${status}`}
            title={statusLabel ?? undefined}
            aria-hidden="true"
          />
        ) : null}
        <FeedRowRail
          grip={Boolean(onDragStart)}
          menuLabel={menuLabel}
          menuOpen={menuOpen}
          onMenu={onMenu}
        />
      </div>
      {childRows.map((child, index) => {
        const childSelected = selectedChildNodeIds.includes(child.nodeId);
        const childMenuOpen = child.nodeId === childMenuNodeId;
        return (
          <div
            key={child.nodeId}
            className={`research-feed-child${index === 0 ? " is-group-start" : ""}${
              index === childRows.length - 1 ? " is-group-end" : ""
            }${childSelected ? " is-selected" : ""}${childMenuOpen ? " has-open-menu" : ""}`}
            style={{ "--research-child-level": child.level } as CSSProperties}
            onPointerDown={
              onDragStart
                ? (event) => onDragStart(event, { kind: dragKind, id: cardId, place }, cardRef.current)
                : undefined
            }
          >
            <button
              type="button"
              className="research-feed-child-open"
              aria-current={childSelected ? "true" : undefined}
              onClick={() => onOpenChild?.(child)}
            >
              {child.branch ? (
                <>
                  <Star
                    className="research-feed-child-icon"
                    size={13}
                    fill="currentColor"
                    aria-hidden="true"
                  />
                  <span className="research-visually-hidden">Starred branch: </span>
                </>
              ) : null}
              <span className="research-feed-child-text">{child.label}</span>
              {child.running ? <span className="research-visually-hidden">, Running</span> : null}
            </button>
            {child.running ? (
              <span className="research-feed-status is-running" title="Running" aria-hidden="true" />
            ) : null}
            <FeedRowRail
              grip={Boolean(onDragStart)}
              menuLabel="Remove the star, bookmark, follow or move"
              menuOpen={childMenuOpen}
              onMenu={onChildMenu ? (anchor) => onChildMenu(child, anchor) : undefined}
            />
          </div>
        );
      })}
    </>
  );
}
