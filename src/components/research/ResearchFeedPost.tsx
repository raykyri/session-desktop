import type { CSSProperties, ReactNode } from "react";
import { Ellipsis, GripVertical } from "lucide-react";
import { ResearchBranchIcon } from "./ResearchIcons";
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
   * through `clamp`, which limits it to four lines; anything rendered outside
   * it (link cards, embeds) shows in full. */
  renderBody: (clamp: (content: ReactNode) => ReactNode) => ReactNode;
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
  selectedChildNodeId?: string | null;
  menuOpen?: boolean;
  /** The … button's name: "Bookmark or move" by default. */
  menuLabel?: string;
  onOpen: () => void;
  onOpenChild?: (child: ResearchFeedChild) => void;
  /** Opens the card's … menu below `anchor`. */
  onMenu?: (anchor: HTMLElement) => void;
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

/** The card listed after `cardId`, or before it when it is the last: where
 * focus goes once the card is removed. */
export function researchFeedCardNeighbour(cardId: string): string | null {
  const cards = [...document.querySelectorAll<HTMLElement>(".research-feed-card[data-research-card]")];
  const index = cards.findIndex((card) => card.dataset.researchCard === cardId);
  if (index < 0) return null;
  return (cards[index + 1] ?? cards[index - 1])?.dataset.researchCard ?? null;
}

/** The next step for focus waiting on a moved card's old … button
 * (`anchor`): wait while that button is still listed and focused; once it is
 * gone with focus left on the page body, focus the card in its new place;
 * drop it once focus went anywhere else. */
export function researchCardRefocus(
  anchor: { isConnected: boolean },
  active: unknown,
  body: unknown,
): "wait" | "focus" | "drop" {
  if (anchor.isConnected) return active === anchor ? "wait" : "drop";
  return active === null || active === body ? "focus" : "drop";
}

/** Focuses a card's open button, or the feed's title when the card isn't
 * listed. */
export function focusResearchFeedCard(cardId: string | null) {
  const target =
    (cardId ? researchFeedCardControl(cardId) : null) ??
    document.querySelector<HTMLElement>(".research-feed-header-title");
  target?.focus({ preventScroll: true });
  target?.scrollIntoView({ block: "nearest" });
}

/** One question in the feed: the thread title (when it differs) and the
 * question, with no metadata row. Running and failed threads show a status
 * dot in the top-right corner, which the … menu replaces on hover. The whole
 * card opens the thread; links and embeds inside it stay their own targets.
 * Starred children follow as indented rows of their own. */
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
  selectedChildNodeId = null,
  menuOpen = false,
  menuLabel = "Bookmark or move",
  onOpen,
  onOpenChild,
  onMenu,
  onContextMenu,
  onDragStart,
}: ResearchFeedPostProps) {
  const statusLabel = status ? (statusLabelOverride ?? STATUS_LABELS[status]) : null;
  return (
    <>
      <div
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
        {onDragStart ? (
          <span className="research-feed-card-grip" aria-hidden="true">
            <GripVertical size={14} />
          </span>
        ) : null}
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
            <Ellipsis size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {childRows.map((child, index) => (
        <div
          key={child.nodeId}
          className={`research-feed-child${index === 0 ? " is-group-start" : ""}${
            index === childRows.length - 1 ? " is-group-end" : ""
          }${child.nodeId === selectedChildNodeId ? " is-selected" : ""}`}
          style={{ "--research-child-level": child.level } as CSSProperties}
        >
          <button
            type="button"
            className="research-feed-child-open"
            aria-current={child.nodeId === selectedChildNodeId ? "true" : undefined}
            onClick={() => onOpenChild?.(child)}
          >
            {child.branch ? (
              <>
                <ResearchBranchIcon className="research-feed-child-icon" size={13} />
                <span className="research-visually-hidden">Branch: </span>
              </>
            ) : null}
            <span className="research-feed-child-text">{child.label}</span>
          </button>
          {child.running ? (
            <span className="research-feed-status is-running" title="Running" aria-hidden="true" />
          ) : null}
        </div>
      ))}
    </>
  );
}
