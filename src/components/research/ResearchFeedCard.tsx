import { useId, useRef, type CSSProperties, type ReactNode } from "react";
import type { ResearchFeedChild } from "../../lib/researchFolders";
import {
  researchRowGlyph,
  type ResearchRowKind,
  type ResearchRowState,
} from "../../lib/researchRowGlyph";
import type { ResearchCardDragStart } from "../../hooks/useResearchCardDrag";
import ResearchRowGlyph from "./ResearchRowGlyph";
import ResearchRowRail from "./ResearchRowRail";
import { researchUnitMenuProps, type ResearchUnitMenuPlacement } from "./researchUnitMenu";

interface ResearchFeedCardProps {
  /** Tree id, or draft id for a draft card. */
  cardId: string;
  dragKind?: "tree" | "draft";
  /** The place the card is listed in, for drag and drop. */
  place: string;
  /** The thread title, shown above the question when it differs from it. */
  title?: string | null;
  /** Renders the question or post body. The body passes its prompt text
   * through `asQuestion`, which sets it as the card's question; the question
   * and anything rendered outside it (link cards, embeds) show in full.
   * The card keeps its glyph in a separate column beside the entire body. */
  renderBody: (asQuestion: (content: ReactNode) => ReactNode) => ReactNode;
  /** The accessible name of the card's open button. */
  label: string;
  /** The open button's tooltip (an archived card's archive time). */
  tooltip?: string;
  /** The root's kind, which the glyph's shape shows. */
  kind?: ResearchRowKind;
  /** The thread's run state, which an exchange's glyph shows. */
  state?: ResearchRowState;
  /** Replaces the state's name, such as "Failed since last viewed". */
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
  /** The … button's name: "Thread actions" by default. */
  menuLabel?: string;
  onOpen: () => void;
  onOpenChild?: (child: ResearchFeedChild) => void;
  /** Opens the card's menu below its … button (`anchor`). */
  onMenu?: (anchor: HTMLElement) => void;
  /** Opens a child row's … menu below `anchor`. */
  onChildMenu?: (child: ResearchFeedChild, anchor: HTMLElement) => void;
  /** Opens the card's menu, the one its … button opens, at `placement`: a
   * right-click on the card, or Shift+F10 or the ContextMenu key with focus
   * on it. `control` is the card's open button. */
  onContextMenu?: (placement: ResearchUnitMenuPlacement, control: HTMLElement) => void;
  /** Opens a child row's context menu (its … menu) at `placement`. `control`
   * is the row's open button. */
  onChildContextMenu?: (
    child: ResearchFeedChild,
    placement: ResearchUnitMenuPlacement,
    control: HTMLElement,
  ) => void;
  onDragStart?: ResearchCardDragStart;
  /** A card of a virtualized list, which may not render its neighbors. */
  virtual?: boolean;
}

/** The … button of a feed row (a card or a child row), for placing its
 * context menu when a key opens it. */
const feedRowMenuButton = (row: HTMLElement) => ({
  element: row.querySelector<HTMLElement>(".research-feed-card-menu"),
  align: "end" as const,
});

const rowControl = (row: HTMLElement, selector: string) =>
  row.querySelector<HTMLElement>(selector) ?? row;

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
export function researchCardRefocus(
  anchor: { isConnected: boolean },
  active: unknown,
  body: unknown,
): "wait" | "focus" | "drop" {
  if (anchor.isConnected) return active === anchor ? "wait" : "drop";
  return active === null || active === body ? "focus" : "drop";
}

/** One thread in the feed, whatever its root is (a question, a post or a
 * document): the thread title (when it differs) and the root's message, with
 * no metadata row. Rows are bubbles: no fill at rest, an inset
 * rounded fill on hover and selection, and a faint ring on the focused row.
 * A separate column holds the row's glyph (ResearchRowGlyph): the root's
 * kind and the thread's state. The drag handle and … button show in a pill
 * in the top-right corner on hover and focus. The whole card opens the
 * thread; links and embeds inside it stay their own targets. Starred
 * children follow as indented rows of their own, each with a glyph for its
 * own state and the same margin controls; dragging one drags its
 * question. */
export default function ResearchFeedCard({
  cardId,
  dragKind = "tree",
  place,
  title,
  renderBody,
  label,
  tooltip,
  kind = "exchange",
  state = "answered",
  statusLabel,
  selected = false,
  unread = false,
  childRows = [],
  selectedChildNodeIds = [],
  menuOpen = false,
  childMenuNodeId = null,
  menuLabel = "Thread actions",
  onOpen,
  onOpenChild,
  onMenu,
  onChildMenu,
  onContextMenu,
  onChildContextMenu,
  onDragStart,
  virtual = false,
}: ResearchFeedCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const glyphId = useId();
  // The glyph's state name describes the open button.
  const glyphNamed = researchRowGlyph({ kind, state, unread }).label !== null;
  const glyph = (
    <ResearchRowGlyph kind={kind} state={state} unread={unread} label={statusLabel} id={glyphId} />
  );
  return (
    <>
      <div
        ref={cardRef}
        className={`research-feed-card${selected ? " is-selected" : ""}${
          menuOpen ? " has-open-menu" : ""
        }${childRows.length > 0 ? " has-children" : ""}`}
        data-research-card={cardId}
        data-research-card-kind={dragKind}
        data-research-place={place}
        data-research-card-virtual={virtual ? "" : undefined}
        onPointerDown={onDragStart ? (event) => onDragStart(event, { kind: dragKind, id: cardId, place }) : undefined}
        {...(onContextMenu
          ? researchUnitMenuProps(
              (placement, card) => onContextMenu(placement, rowControl(card, ".research-feed-card-hit")),
              feedRowMenuButton,
            )
          : null)}
      >
        <button
          type="button"
          className="research-feed-card-hit"
          aria-label={label}
          aria-describedby={glyphNamed ? glyphId : undefined}
          aria-current={selected ? "true" : undefined}
          title={tooltip}
          onClick={onOpen}
        />
        <div className={`research-feed-card-layout${title ? " has-title" : ""}`}>
          {glyph}
          <div className="research-feed-card-content">
            {title ? <span className="research-feed-card-title">{title}</span> : null}
            {renderBody((content) => (
              <div className="research-feed-card-question">{content}</div>
            ))}
          </div>
        </div>
        <ResearchRowRail
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
            style={{ "--research-child-indent": child.indent } as CSSProperties}
            data-research-child-of={cardId}
            onPointerDown={
              onDragStart
                ? (event) => onDragStart(event, { kind: dragKind, id: cardId, place }, cardRef.current)
                : undefined
            }
            {...(onChildContextMenu
              ? researchUnitMenuProps(
                  (placement, row) =>
                    onChildContextMenu(child, placement, rowControl(row, ".research-feed-child-open")),
                  feedRowMenuButton,
                )
              : null)}
          >
            <button
              type="button"
              className="research-feed-child-open"
              data-node-id={child.nodeId}
              aria-current={childSelected ? "true" : undefined}
              onClick={() => onOpenChild?.(child)}
            >
              {child.branch ? (
                <span className="research-visually-hidden">Starred branch: </span>
              ) : null}
              <ResearchRowGlyph kind={child.kind} state={child.state} />
              <span className="research-feed-child-text">
                <span className="research-feed-child-label">
                  {child.label}
                </span>
              </span>
            </button>
            <ResearchRowRail
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
