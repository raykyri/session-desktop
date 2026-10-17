// A Home card (the desktop's `ResearchFeedCard.tsx`): a thread rooted in a
// question, note, link or document, or a saved draft. It shows the title when
// it differs from the question, the root's text, a kind and status glyph, and
// a drag handle and … button on hover or focus. The whole card is one open
// button placed behind its content, so links inside stay separate targets. A
// parent card's rail starts with a chevron that shows and hides its children;
// the child cards follow it, indented, while it is expanded.

import { researchNoteDoubleClickEdits } from "@session/shared/lib/researchNoteEdit";
import {
  researchRowGlyph,
  type ResearchRowKind,
  type ResearchRowState,
} from "@session/shared/lib/researchRowGlyph";
import { ChevronRight, Ellipsis, GripVertical } from "lucide-react";
import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from "react";

import { cn } from "../../lib/cn.js";
import { RowGlyph } from "../../ui/RowGlyph.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

import type { CardDragStart } from "./useCardDrag.js";

/** Where a context menu opens: at the pointer, or for a key, below the
 * card's … button. */
export interface CardMenuPlacement {
  x: number;
  y: number;
}

/** A parent card's group: `count` children, which the rail's chevron shows
 * and hides. */
export interface FeedCardGroup {
  count: number;
  collapsed: boolean;
  /** Collapsed: the children's running, failed and updated counts. */
  summary: { running: number; failed: number; updated: number };
  /** The toggle's accessible name. */
  label: string;
  /** `all`: Alt+click, every group in Home. */
  onToggle: (all: boolean) => void;
}

export interface FeedCardProps {
  /** Tree id, or draft id for a draft card. */
  cardId: string;
  dragKind?: "tree" | "draft";
  /** The place the card is listed in, for drag and drop. */
  place: string;
  /** The thread title, shown above the question when it differs from it. */
  title?: string | null | undefined;
  /** The question or post body. */
  body: ReactNode;
  /** The accessible name of the card's open button. */
  label: string;
  /** The open button's tooltip (an archived card's archive time). */
  tooltip?: string | undefined;
  kind?: ResearchRowKind;
  state?: ResearchRowState;
  /** Replaces the state's name, such as "Failed since last viewed". */
  statusLabel?: string | undefined;
  selected?: boolean;
  /** The thread changed since it was last viewed. */
  unread?: boolean;
  menuOpen?: boolean;
  /** The … button's name: "Thread actions" by default. */
  menuLabel?: string;
  onOpen: () => void;
  /** Called when the pointer enters or focus reaches the open button: a
   * thread card starts loading the thread page's chunk
   * (`routes/chunks.ts`). */
  onIntent?: (() => void) | undefined;
  /** Edits the card's note on a double-click; absent when the card is not an
   * editable note. */
  onEdit?: (() => void) | undefined;
  /** Opens the card's menu below its … button. */
  onMenu?: ((anchor: HTMLElement) => void) | undefined;
  /** Opens the same menu at the pointer (right-click) or below the … button
   * (Shift+F10, the ContextMenu key). */
  onContextMenu?:
    ((placement: CardMenuPlacement | HTMLElement, control: HTMLElement) => void) | undefined;
  onDragStart?: CardDragStart | undefined;
  /** A card of a virtualized list, which may not render its neighbors. */
  virtual?: boolean;
  /** A question, document or post: a tree dropped on the middle of the card
   * becomes its child. */
  holdsChildren?: boolean;
  /** For a child card: its parent's tree id. */
  parentId?: string | undefined;
  group?: FeedCardGroup | undefined;
  nested?: ReactNode;
}

/** The status counts under a collapsed group's card. */
function GroupSummary({ summary }: { summary: FeedCardGroup["summary"] }) {
  const parts = [
    {
      key: "running",
      count: summary.running,
      state: "running" as const,
      unread: false,
      className: "text-status-active",
    },
    {
      key: "failed",
      count: summary.failed,
      state: "failed" as const,
      unread: false,
      className: "text-status-failed",
    },
    {
      key: "updated",
      count: summary.updated,
      state: "answered" as const,
      unread: true,
      className: "text-fg-secondary",
    },
  ].filter((part) => part.count > 0);
  if (parts.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums" aria-hidden="true">
      {parts.map((part) => (
        <span
          key={part.key}
          className={cn("inline-flex items-center gap-0.5", part.className)}
          title={`${part.count} ${part.key}`}
        >
          <RowGlyph kind="exchange" state={part.state} unread={part.unread} size={12} />
          {part.count}
        </span>
      ))}
    </span>
  );
}

const cardSelector = (cardId: string) => `[data-research-card="${CSS.escape(cardId)}"]`;

/** A listed card's open button, or its … button; null when the card isn't
 * listed (a collapsed tray, another view). */
export function feedCardControl(
  cardId: string,
  control: "open" | "menu" = "open",
): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `${cardSelector(cardId)} ${control === "open" ? "[data-research-card-hit]" : "[data-research-card-menu]"}`,
  );
}

/** Whether a double-click on a note's card edits the note: the primary
 * button without modifiers (`researchNoteDoubleClickEdits`). */
function doubleClickEdits(event: MouseEvent<HTMLElement>): boolean {
  return researchNoteDoubleClickEdits({
    button: event.button,
    modifier: event.metaKey || event.ctrlKey || event.altKey || event.shiftKey,
    interactive: event.defaultPrevented,
  });
}

/** How long a click on an editable note's card waits for a second click
 * before it opens the thread. Home is its own route on the web, so opening
 * on the first click would replace the card before a double-click could
 * reach it. */
const NOTE_OPEN_DELAY_MS = 250;

/** The middle of a card's … button, where a menu opened by a key goes. */
function menuButtonOf(card: HTMLElement): HTMLElement | null {
  return card.querySelector<HTMLElement>("[data-research-card-menu]");
}

export function FeedCard({
  cardId,
  dragKind = "tree",
  place,
  title,
  body,
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
  onIntent,
  onEdit,
  onMenu,
  onContextMenu,
  onDragStart,
  virtual = false,
  holdsChildren = false,
  parentId,
  group,
  nested,
}: FeedCardProps) {
  const glyphId = useId();
  const openTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    },
    [],
  );
  // The glyph's state name describes the open button.
  const glyphNamed = researchRowGlyph({ kind, state, unread }).label !== null;
  const child = parentId !== undefined;
  const openContextMenu = (
    event: MouseEvent<HTMLElement> | null,
    card: HTMLElement,
    keyboard: boolean,
  ) => {
    if (!onContextMenu) return;
    const control = card.querySelector<HTMLElement>("[data-research-card-hit]") ?? card;
    if (keyboard || !event) {
      onContextMenu(menuButtonOf(card) ?? control, control);
      return;
    }
    onContextMenu({ x: event.clientX, y: event.clientY }, control);
  };
  return (
    <>
      {/* The open button inside is the card's keyboard target; the card
          itself takes the pointer for drags and the context menu, and
          Shift+F10 or the ContextMenu key from the button. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        className={cn(
          "group/card relative cursor-pointer rounded-[10px] select-none",
          child
            ? "mr-(--research-row-inset) ml-[calc(var(--research-row-inset)+24px)]"
            : "mx-(--research-row-inset)",
          "py-2.5 pr-3 pl-[calc(var(--research-row-text)-var(--research-row-inset))]",
          "[--research-row-inset:8px] [--research-row-text:20px]",
          "in-[[data-research-tray-body]]:rounded-lg in-[[data-research-tray-body]]:py-2 in-[[data-research-tray-body]]:[--research-row-inset:6px] in-[[data-research-tray-body]]:[--research-row-text:14px]",
          "[&+&]:mt-0.5",
          selected
            ? "bg-surface-card-selected [--research-row-glyph-color:var(--text-muted)]"
            : "hover:bg-[color-mix(in_srgb,var(--research-card-selected-bg)_55%,transparent)]",
          "has-[>[data-research-card-hit]:focus]:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent-color)_35%,transparent)]",
          menuOpen && "has-open-menu",
        )}
        data-research-card={cardId}
        data-research-card-kind={dragKind}
        data-research-place={place}
        data-research-card-virtual={virtual ? "" : undefined}
        data-research-holds-children={holdsChildren ? "" : undefined}
        data-research-parent={parentId}
        data-research-children={group ? group.count : undefined}
        data-research-group-collapsed={group?.collapsed ? "" : undefined}
        aria-current={selected ? "true" : undefined}
        onPointerDown={
          onDragStart
            ? (event) => onDragStart(event, { kind: dragKind, id: cardId, place })
            : undefined
        }
        onContextMenu={
          onContextMenu
            ? (event) => {
                event.preventDefault();
                openContextMenu(event, event.currentTarget, false);
              }
            : undefined
        }
        onKeyDown={
          onContextMenu
            ? (event) => {
                if (
                  event.key === "ContextMenu" ||
                  (event.key === "F10" && event.shiftKey && !event.metaKey && !event.ctrlKey)
                ) {
                  event.preventDefault();
                  openContextMenu(null, event.currentTarget, true);
                }
              }
            : undefined
        }
      >
        <button
          type="button"
          className={cn(
            "absolute inset-0 z-0 w-full cursor-pointer rounded-[inherit] border-0 bg-transparent p-0 outline-none",
          )}
          data-research-card-hit=""
          aria-label={label}
          aria-describedby={glyphNamed ? glyphId : undefined}
          aria-current={selected ? "true" : undefined}
          title={tooltip}
          onPointerEnter={onIntent}
          onFocus={onIntent}
          onClick={(event) => {
            // A pointer click on an editable note waits to see whether it is
            // the first of a double-click (NOTE_OPEN_DELAY_MS); a key press
            // (detail 0) opens at once.
            if (onEdit && event.detail > 1) return;
            if (onEdit && event.detail === 1) {
              if (openTimer.current !== null) window.clearTimeout(openTimer.current);
              openTimer.current = window.setTimeout(() => {
                openTimer.current = null;
                onOpen();
              }, NOTE_OPEN_DELAY_MS);
              return;
            }
            onOpen();
          }}
          // The second press of a double-click is kept from selecting a word.
          onMouseDown={
            onEdit
              ? (event) => {
                  if (event.detail >= 2 && doubleClickEdits(event)) event.preventDefault();
                }
              : undefined
          }
          onDoubleClick={
            onEdit
              ? (event) => {
                  if (!doubleClickEdits(event)) return;
                  event.preventDefault();
                  if (openTimer.current !== null) window.clearTimeout(openTimer.current);
                  openTimer.current = null;
                  onEdit();
                }
              : undefined
          }
        />
        <div
          className={cn(
            "pointer-events-none flex items-start gap-1.5",
            title
              ? "text-[length:calc(var(--fs-base)+0.5px)] leading-[1.4]"
              : "text-[length:calc(var(--research-compact-font-size)+1px)] leading-(--research-compact-line-height)",
          )}
        >
          <RowGlyph
            kind={kind}
            state={state}
            unread={unread}
            label={statusLabel}
            id={glyphId}
            className="mt-[calc((1lh-14px)/2)] w-3.5"
          />
          <div className="relative z-1 min-w-0 flex-1 [&_a]:pointer-events-auto [&_button]:pointer-events-auto [&>*+*]:mt-0.5">
            {title ? (
              <span
                className="text-fg-heading block text-[length:calc(var(--fs-base)+0.5px)] leading-[1.4] font-semibold [overflow-wrap:anywhere]"
                data-research-card-title=""
              >
                {title}
              </span>
            ) : null}
            {body}
            {group?.collapsed ? <GroupSummary summary={group.summary} /> : null}
          </div>
        </div>
        {onDragStart || onMenu || group ? (
          <span
            className={cn(
              "border-border-strong bg-surface-feed-popover absolute top-[5px] right-[5px] z-2 flex h-6 items-center gap-px rounded-[7px] border px-0.5 opacity-0",
              "pointer-events-none shadow-[0_2px_8px_color-mix(in_srgb,var(--text-heading)_8%,transparent)]",
              "group-focus-within/card:opacity-85 group-hover/card:opacity-85 group-[.has-open-menu]/card:opacity-85",
            )}
          >
            {group ? (
              <button
                type="button"
                className={cn(
                  "text-fg-muted hover:bg-surface-fill-hover hover:text-fg-primary pointer-events-auto grid size-5 place-items-center rounded-[5px] border-0 bg-transparent p-0",
                  FOCUS_RING,
                )}
                aria-expanded={!group.collapsed}
                aria-label={group.label}
                title={group.label}
                data-research-no-drag=""
                onClick={(event) => {
                  event.stopPropagation();
                  group.onToggle(event.altKey);
                }}
              >
                <ChevronRight
                  size={14}
                  aria-hidden="true"
                  className={cn(
                    "transition-transform duration-120",
                    !group.collapsed && "rotate-90",
                  )}
                />
              </button>
            ) : null}
            {onDragStart ? (
              <span
                className="text-fg-faint pointer-events-auto grid size-5 cursor-grab place-items-center"
                aria-hidden="true"
              >
                <GripVertical size={14} />
              </span>
            ) : null}
            {onMenu ? (
              <button
                type="button"
                className={cn(
                  "text-fg-muted hover:bg-surface-fill-hover hover:text-fg-primary pointer-events-auto grid h-5 w-[22px] place-items-center rounded-[5px] border-0 bg-transparent p-0",
                  FOCUS_RING,
                )}
                title={menuLabel}
                aria-label={menuLabel}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                data-research-no-drag=""
                data-research-card-menu=""
                onClick={(event) => {
                  event.stopPropagation();
                  onMenu(event.currentTarget);
                }}
              >
                <Ellipsis size={14} aria-hidden="true" />
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      {group && !group.collapsed ? (
        <>
          <div
            className="pb-1"
            data-research-group={cardId}
          >
            {nested}
          </div>
          {onDragStart ? (
            // Shown by feed.css only while one of the group's children is
            // dragged.
            <div
              className="text-fg-faint mx-2 mt-0.5 mb-1 hidden h-7 items-center justify-center rounded-[7px] border-[1.5px] border-dotted border-[color-mix(in_srgb,var(--text-faint)_55%,transparent)] text-xs in-[[data-research-tray-body]]:mx-1.5"
              data-research-group-exit={cardId}
              aria-hidden="true"
            >
              Move out of group
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}
