import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bookmark, Check, House, Plus } from "lucide-react";
import type { ResearchFolder } from "../../types";
import {
  RESEARCH_ARCHIVE_FOLDER_ID,
  RESEARCH_DRAFTS_FOLDER_ID,
  RESEARCH_UNFILED_FOLDER_ID,
} from "../../lib/researchFolders";
import { ResearchPlaceIcon } from "./ResearchFeedChrome";

const MENU_WIDTH = 220;
const MENU_MARGIN = 8;
const ITEM_SELECTOR = ".research-feed-menu-item:not(:disabled)";

/** Every place a question can be moved to, in sidebar order. */
export function researchMoveTargets(folders: ResearchFolder[]) {
  return [
    { place: RESEARCH_UNFILED_FOLDER_ID, name: "Unfiled" },
    { place: RESEARCH_DRAFTS_FOLDER_ID, name: "Drafts" },
    ...folders.map((folder) => ({ place: folder.id, name: folder.name })),
    { place: RESEARCH_ARCHIVE_FOLDER_ID, name: "Archive" },
  ];
}

/** A feed menu's popover: below its button (or above it near the bottom of
 * the window), aligned to the button's end or start edge. The first item takes
 * focus once, when the menu opens; ↑ and ↓ move between items. Esc closes it
 * and returns focus to the button, and is stopped there, so it closes nothing
 * else (such as the branch drawer). A press outside, a scroll, or a resize
 * closes it without moving focus. */
function ResearchMenuSurface({
  anchor,
  label,
  width,
  align,
  onClose,
  children,
}: {
  anchor: HTMLElement;
  label: string;
  width: number;
  align: "start" | "end";
  onClose: (restoreFocus: boolean) => void;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [position, setPosition] = useState(() => {
    const rect = anchor.getBoundingClientRect();
    const left = align === "end" ? rect.right - width : rect.left;
    return {
      left: Math.max(MENU_MARGIN, Math.min(left, window.innerWidth - width - MENU_MARGIN)),
      top: rect.bottom + 4,
    };
  });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = anchor.getBoundingClientRect();
    const height = menu.getBoundingClientRect().height;
    if (rect.bottom + 4 + height > window.innerHeight - MENU_MARGIN) {
      setPosition((current) => ({
        ...current,
        top: Math.max(MENU_MARGIN, rect.top - 4 - height),
      }));
    }
    menu.querySelector<HTMLButtonElement>(ITEM_SELECTOR)?.focus();
  }, [anchor]);

  useEffect(() => {
    const close = (restoreFocus: boolean) => onCloseRef.current(restoreFocus);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !anchor.contains(target)) close(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    const onScroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) close(false);
    };
    const onResize = () => close(false);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>(ITEM_SELECTOR) ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  }

  return createPortal(
    <div
      ref={menuRef}
      className="research-feed-menu"
      role="menu"
      aria-label={label}
      style={{ left: position.left, top: position.top, width }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}

function MenuItem({
  icon,
  label,
  trailing,
  disabled,
  checked,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  disabled?: boolean;
  /** Set for a choice among places: the item becomes a menuitemradio. */
  checked?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      className="research-feed-menu-item"
      disabled={disabled}
      onClick={onSelect}
    >
      {icon}
      <span className="research-feed-menu-label">{label}</span>
      {trailing}
    </button>
  );
}

interface ResearchMenuAction {
  icon: ReactNode;
  label: string;
  onSelect: () => void;
}

/** A short menu of actions, such as a folder row's Rename and Delete, or a
 * draft card's Open and Delete. */
export function ResearchActionMenu({
  anchor,
  label,
  actions,
  align = "end",
  onClose,
}: {
  anchor: HTMLElement;
  label: string;
  actions: ResearchMenuAction[];
  align?: "start" | "end";
  onClose: (restoreFocus: boolean) => void;
}) {
  return (
    <ResearchMenuSurface anchor={anchor} label={label} width={180} align={align} onClose={onClose}>
      {actions.map((action) => (
        <MenuItem
          key={action.label}
          icon={action.icon}
          label={action.label}
          onSelect={action.onSelect}
        />
      ))}
    </ResearchMenuSurface>
  );
}

/** A card's or conversation header's menu: Bookmark at the top when given,
 * then Move to with every folder (the current one disabled and checked),
 * then New folder…, which creates a folder and moves the question into it. */
export default function ResearchMoveMenu({
  anchor,
  currentPlace,
  folders,
  bookmarked,
  onToggleBookmark,
  onMove,
  onNewFolder,
  onClose,
}: {
  anchor: HTMLElement;
  currentPlace: string;
  folders: ResearchFolder[];
  bookmarked?: boolean;
  onToggleBookmark?: () => void;
  onMove: (place: string) => void;
  onNewFolder: () => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  return (
    <ResearchMenuSurface
      anchor={anchor}
      label="Bookmark or move"
      width={MENU_WIDTH}
      align="end"
      onClose={onClose}
    >
      {onToggleBookmark ? (
        <>
          <MenuItem
            icon={
              <Bookmark size={15} aria-hidden="true" fill={bookmarked ? "currentColor" : "none"} />
            }
            label={bookmarked ? "Remove bookmark" : "Bookmark"}
            onSelect={onToggleBookmark}
          />
          <div className="research-feed-menu-divider" role="separator" />
        </>
      ) : null}
      <div className="research-feed-menu-heading" role="presentation">
        Move to
      </div>
      <div role="group" aria-label="Move to">
        {researchMoveTargets(folders).map((target) => {
          const here = target.place === currentPlace;
          return (
            <MenuItem
              key={target.place}
              icon={
                target.place === RESEARCH_UNFILED_FOLDER_ID ? (
                  <House size={15} aria-hidden="true" />
                ) : (
                  <ResearchPlaceIcon place={target.place} size={15} />
                )
              }
              label={target.name}
              disabled={here}
              checked={here}
              trailing={
                here ? (
                  <Check className="research-feed-menu-check" size={15} aria-hidden="true" />
                ) : null
              }
              onSelect={() => onMove(target.place)}
            />
          );
        })}
      </div>
      <div className="research-feed-menu-divider" role="separator" />
      <MenuItem
        icon={<Plus size={15} aria-hidden="true" />}
        label="New folder…"
        onSelect={onNewFolder}
      />
    </ResearchMenuSurface>
  );
}
