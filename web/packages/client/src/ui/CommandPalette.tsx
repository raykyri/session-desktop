import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { cn } from "../lib/cn.js";

import { DIALOG_BACKDROP, FORM_FIELD, MENU_ITEM } from "./surfaces.js";

/** One runnable entry. Commands are grouped by section in the order the
 * sections first appear in the array. */
export interface PaletteCommand {
  id: string;
  section: string;
  title: string;
  /** Right-aligned detail: a shortcut label, a folder name, a running count. */
  hint?: string;
  action: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: readonly PaletteCommand[];
}

/**
 * The ⌘K palette, ported from the desktop `CommandPalette.tsx` onto Base UI's
 * Dialog (08 §4). The list stays hand-rolled: a filtered, flat, index-selected
 * listbox that crosses section boundaries with one arrow key is not a menu, and
 * the commands are built only while the palette is open (`App.tsx:8098`).
 */
export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return [...commands];
    return commands.filter(
      (command) =>
        command.title.toLowerCase().includes(needle) ||
        command.section.toLowerCase().includes(needle) ||
        (command.hint ?? "").toLowerCase().includes(needle),
    );
  }, [commands, query]);

  // A fresh open or a narrowed list restarts the selection at the top, and
  // closing clears the filter. Both are adjustments to a change the component
  // can see while rendering, so they happen here rather than in an effect: an
  // effect would paint one frame with the previous selection first.
  const [lastOpen, setLastOpen] = useState(open);
  const [lastQuery, setLastQuery] = useState(query);
  if (lastOpen !== open) {
    setLastOpen(open);
    setSelectedIndex(0);
    if (!open) setQuery("");
  } else if (lastQuery !== query) {
    setLastQuery(query);
    setSelectedIndex(0);
  }

  // Keep the keyboard selection visible while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-palette-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, selectedIndex]);

  const run = (command: PaletteCommand) => {
    onClose();
    command.action();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setSelectedIndex((current) => (current + step + filtered.length) % filtered.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const command = filtered[selectedIndex];
      if (command) run(command);
    }
  };

  // Rows render flat so index-based selection stays simple, with a section
  // label injected above each row that starts a new section.
  let previousSection: string | null = null;

  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={DIALOG_BACKDROP} />
        <BaseDialog.Popup
          initialFocus={inputRef}
          aria-label="Command palette"
          onKeyDown={handleKeyDown}
          className={cn(
            "fixed top-[12vh] left-1/2 z-(--z-dialog) flex w-[min(560px,calc(100vw-32px))]",
            "border-border-dialog -translate-x-1/2 flex-col gap-2 rounded-lg border",
            "bg-surface-popover shadow-dialog p-2",
          )}
        >
          {/* Focus never leaves the filter, so the input is the combobox and
              the highlighted row is named through `aria-activedescendant`;
              without it the arrow keys move a purely visual selection. */}
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            {...(filtered[selectedIndex]
              ? { "aria-activedescendant": optionId(selectedIndex) }
              : {})}
            className={cn(FORM_FIELD, "min-h-control-lg text-input")}
            placeholder="Type a command or search…"
            aria-label="Command palette filter"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Commands"
            className="flex max-h-[50vh] flex-col overflow-y-auto"
          >
            {filtered.length === 0 ? (
              <div className="text-fg-muted px-2.5 py-3 text-base">No matching commands</div>
            ) : (
              filtered.map((command, index) => {
                const sectionLabel =
                  command.section === previousSection ? null : (
                    <div className="text-fg-subtle px-2.5 pt-2 pb-1 text-xs">{command.section}</div>
                  );
                previousSection = command.section;
                return (
                  // A wrapper element would sit between the listbox and its
                  // options as a `generic` node and break the ARIA ownership
                  // the roles promise, so the section label is a sibling.
                  <Fragment key={command.id}>
                    {sectionLabel}
                    <button
                      type="button"
                      role="option"
                      id={optionId(index)}
                      // Selection is driven from the filter input; a row in the
                      // tab order would let Tab desynchronize focus from it.
                      tabIndex={-1}
                      aria-selected={index === selectedIndex}
                      data-palette-index={index}
                      className={cn(
                        MENU_ITEM,
                        index === selectedIndex && "bg-surface-popover-item-hover",
                      )}
                      onMouseMove={() => setSelectedIndex(index)}
                      onClick={() => run(command)}
                    >
                      <span className="min-w-0 flex-1 truncate">{command.title}</span>
                      {command.hint ? (
                        <span className="text-fg-subtle shrink-0 text-xs">{command.hint}</span>
                      ) : null}
                    </button>
                  </Fragment>
                );
              })
            )}
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
