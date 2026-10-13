import { useId, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { researchItemCount } from "../../lib/researchGroups";
import {
  researchRowGlyph,
  type ResearchRowKind,
  type ResearchRowState,
} from "../../lib/researchRowGlyph";
import type { ResearchCardDragStart } from "../../hooks/useResearchCardDrag";
import ResearchRowGlyph from "./ResearchRowGlyph";
import ResearchRowRail from "./ResearchRowRail";
import { researchUnitMenuProps, type ResearchUnitMenuPlacement } from "./researchUnitMenu";
import { researchNoteDoubleClickProps } from "./researchNoteDoubleClick";

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
  menuOpen?: boolean;
  /** The … button's name: "Thread actions" by default. */
  menuLabel?: string;
  onOpen: () => void;
  /** Edits the card's note on a double-click of the card; absent when the
   * card is not an editable note. */
  onEdit?: () => void;
  /** Opens the card's menu below its … button (`anchor`). */
  onMenu?: (anchor: HTMLElement) => void;
  /** Opens the card's menu, the one its … button opens, at `placement`: a
   * right-click on the card, or Shift+F10 or the ContextMenu key with focus
   * on it. `control` is the card's open button. */
  onContextMenu?: (placement: ResearchUnitMenuPlacement, control: HTMLElement) => void;
  onDragStart?: ResearchCardDragStart;
  /** A card of a virtualized list, which may not render its neighbors. */
  virtual?: boolean;
  /** A question, document or post: while another tree is dragged, the
   * card's nest port takes drops that make it a child. */
  holdsChildren?: boolean;
  /** For a child card: its parent's tree id. */
  parentId?: string;
  /** For a parent with children: the toggle line in the card, and the child
   * cards (`nested`) listed after it when expanded. */
  group?: ResearchFeedGroup;
  nested?: ReactNode;
}

/** A parent card's group: `count` children, which the toggle line shows and
 * hides. */
interface ResearchFeedGroup {
  count: number;
  collapsed: boolean;
  /** Collapsed: the children's running, failed and updated counts. */
  summary: { running: number; failed: number; updated: number };
  /** The toggle's accessible name. */
  label: string;
  /** `all`: Alt+click, every group in Home. */
  onToggle: (all: boolean) => void;
}

/** The status counts on a collapsed group's toggle line. */
function GroupSummary({ summary }: { summary: ResearchFeedGroup["summary"] }) {
  const parts = [
    { key: "running", count: summary.running, state: "running" as const, unread: false, name: "running" },
    { key: "failed", count: summary.failed, state: "failed" as const, unread: false, name: "failed" },
    { key: "updated", count: summary.updated, state: "answered" as const, unread: true, name: "updated" },
  ].filter((part) => part.count > 0);
  if (parts.length === 0) return null;
  return (
    <span className="research-feed-group-summary" aria-hidden="true">
      {parts.map((part) => (
        <span key={part.key} className={`is-${part.key}`} title={`${part.count} ${part.name}`}>
          <ResearchRowGlyph kind="exchange" state={part.state} unread={part.unread} />
          {part.count}
        </span>
      ))}
    </span>
  );
}

/** The … button of a feed card, for placing its context menu when a key
 * opens it. */
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

/** Determine whether to wait for the old menu button to unmount, focus the
 * moved card, or cancel because focus moved elsewhere. */
export function researchCardRefocus(
  anchor: { isConnected: boolean },
  active: unknown,
  body: unknown,
): "wait" | "focus" | "drop" {
  if (anchor.isConnected) return active === anchor ? "wait" : "drop";
  return active === null || active === body ? "focus" : "drop";
}

/** Feed card for a thread rooted in a question, post, or document. It shows
 * the title when distinct, the root content, a type/status glyph, and controls
 * on hover or focus. The card opens the thread while nested links and embeds
 * remain separate targets. A parent card has a toggle line; its child cards
 * follow it, beside a guide, while it is expanded. */
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
  menuOpen = false,
  menuLabel = "Thread actions",
  onOpen,
  onEdit,
  onMenu,
  onContextMenu,
  onDragStart,
  virtual = false,
  holdsChildren = false,
  parentId,
  group,
  nested,
}: ResearchFeedCardProps) {
  const glyphId = useId();
  // The glyph's state name describes the open button.
  const glyphNamed = researchRowGlyph({ kind, state, unread }).label !== null;
  const glyph = (
    <ResearchRowGlyph kind={kind} state={state} unread={unread} label={statusLabel} id={glyphId} />
  );
  return (
    <>
      <div
        className={`research-feed-card${selected ? " is-selected" : ""}${
          menuOpen ? " has-open-menu" : ""
        }${parentId ? " is-child" : ""}`}
        data-research-card={cardId}
        data-research-card-kind={dragKind}
        data-research-place={place}
        data-research-card-virtual={virtual ? "" : undefined}
        data-research-holds-children={holdsChildren ? "" : undefined}
        data-research-parent={parentId}
        data-research-children={group ? group.count : undefined}
        data-research-group-collapsed={group?.collapsed ? "" : undefined}
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
          onClick={(event) => {
            // The second click of a double-click that edits the note does
            // not open the thread again; the first click opened it.
            if (onEdit && event.detail > 1) return;
            onOpen();
          }}
          {...researchNoteDoubleClickProps(onEdit)}
        />
        <div className={`research-feed-card-layout${title ? " has-title" : ""}`}>
          {glyph}
          <div className="research-feed-card-content">
            {title ? <span className="research-feed-card-title">{title}</span> : null}
            {renderBody((content) => (
              <div className="research-feed-card-question">{content}</div>
            ))}
            {group ? (
              <button
                type="button"
                className="research-feed-group-toggle"
                aria-expanded={!group.collapsed}
                aria-label={group.label}
                data-research-no-drag
                onClick={(event) => group.onToggle(event.altKey)}
              >
                <ChevronRight className="research-feed-group-chevron" size={13} aria-hidden="true" />
                <span>{researchItemCount(group.count)}</span>
                {group.collapsed ? <GroupSummary summary={group.summary} /> : null}
              </button>
            ) : null}
          </div>
        </div>
        <ResearchRowRail
          grip={Boolean(onDragStart)}
          menuLabel={menuLabel}
          menuOpen={menuOpen}
          onMenu={onMenu}
        />
        {holdsChildren && onDragStart ? (
          // Shown by CSS only during a drag of an item the card can take.
          <span className="research-feed-nest-port" aria-hidden="true">
            Nest here
          </span>
        ) : null}
      </div>
      {group && !group.collapsed ? (
        <>
          <div className="research-feed-group">{nested}</div>
          {onDragStart ? (
            // Shown by CSS only while one of the group's children is dragged.
            <div className="research-feed-group-exit" data-research-group-exit={cardId} aria-hidden="true">
              Move out of group
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}
