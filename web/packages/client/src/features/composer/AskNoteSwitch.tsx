// Ask and Note (the desktop's `AskNoteSwitch.tsx`): what the text in an ask
// box becomes — a question for a model ("ai"), or a note ("note"), saved
// without running anything; a note that is a single URL is saved as a link.

import { ChevronDown, StickyNote } from "lucide-react";
import { useId, useRef } from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";

import { cn } from "../../lib/cn.js";

export type AskMode = "note" | "ai";

/** The mode a key on the switch selects, or null for any other key: ← and →
 * move to the other segment, Home to Ask, End to Note. */
export function askSwitchKeyTarget(key: string, current: AskMode): AskMode | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowRight":
      return current === "ai" ? "note" : "ai";
    case "Home":
      return "ai";
    case "End":
      return "note";
    default:
      return null;
  }
}

const OPTION =
  "inline-flex h-6 min-w-[30px] cursor-pointer items-center justify-center gap-[5px] rounded-md " +
  "border border-transparent bg-transparent px-1.5 text-fg-muted hover:text-fg-primary " +
  "aria-checked:border-border-control aria-checked:bg-surface-switch-raised " +
  "aria-checked:text-fg-strong aria-checked:shadow-switch-raised " +
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

/** Ask and Note as two icon segments in a radiogroup with a roving tabindex.
 * A press on the selected Ask segment (or Enter, Space or ↓ on it) opens the
 * model menu; from Note, Ask only switches back, keeping the last model. A
 * radio cannot carry aria-haspopup, so the menu is announced through a
 * description instead. */
export function AskNoteSwitch({
  askMode,
  askIcon,
  askLabel,
  noteLabel,
  menuOpen = false,
  askRef: askRefProp,
  onModeChange,
  onMenuOpenChange,
}: {
  askMode: AskMode;
  askIcon: ReactNode;
  /** "Ask with {model}": the Ask segment's name and tooltip. */
  askLabel: string;
  /** "Save as note" in the Home ask box. */
  noteLabel: string;
  menuOpen?: boolean;
  askRef?: RefObject<HTMLButtonElement | null>;
  onModeChange: (mode: AskMode) => void;
  onMenuOpenChange?: (open: boolean) => void;
}) {
  const hintId = useId();
  const ownAskRef = useRef<HTMLButtonElement | null>(null);
  const askRef = askRefProp ?? ownAskRef;
  const noteRef = useRef<HTMLButtonElement | null>(null);
  const ask = askMode === "ai";
  const hasMenu = Boolean(onMenuOpenChange);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, segment: AskMode) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = askSwitchKeyTarget(event.key, segment);
    if (target) {
      event.preventDefault();
      onModeChange(target);
      (target === "ai" ? askRef : noteRef).current?.focus();
      return;
    }
    if (segment === "ai" && ask && event.key === "ArrowDown" && onMenuOpenChange) {
      event.preventDefault();
      onMenuOpenChange(true);
    }
  };

  return (
    <div
      className="bg-surface-fill-subtle inline-flex min-w-0 items-center gap-0.5 rounded-lg p-0.5"
      role="radiogroup"
      aria-label={`Ask or ${noteLabel.charAt(0).toLowerCase()}${noteLabel.slice(1)}`}
    >
      <button
        ref={askRef}
        type="button"
        role="radio"
        aria-checked={ask}
        tabIndex={ask ? 0 : -1}
        className={OPTION}
        aria-label={askLabel}
        aria-describedby={ask && hasMenu ? hintId : undefined}
        title={askLabel}
        onClick={(event) => {
          event.currentTarget.focus();
          if (ask) onMenuOpenChange?.(!menuOpen);
          else onModeChange("ai");
        }}
        onKeyDown={(event) => onKeyDown(event, "ai")}
      >
        {askIcon}
        {ask && hasMenu ? (
          <ChevronDown size={9} className={cn("-ml-0.5 shrink-0 opacity-65")} aria-hidden="true" />
        ) : null}
      </button>
      <button
        ref={noteRef}
        type="button"
        role="radio"
        aria-checked={!ask}
        tabIndex={ask ? -1 : 0}
        className={OPTION}
        aria-label={noteLabel}
        title={noteLabel}
        onClick={(event) => {
          event.currentTarget.focus();
          onModeChange("note");
        }}
        onKeyDown={(event) => onKeyDown(event, "note")}
      >
        <StickyNote size={14} aria-hidden="true" />
      </button>
      {hasMenu ? (
        <span id={hintId} hidden>
          Press Enter to choose a model
        </span>
      ) : null}
    </div>
  );
}
