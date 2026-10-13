import { useId, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { ChevronDown, StickyNote } from "lucide-react";

/** What the text in an ask box becomes: a question for an agent ("ai"), or
 * a note ("note"), which is saved without running anything; a body that is a
 * single URL is saved as a link. The Ask/Note switch sets it. */
export type AskMode = "note" | "ai";

/** The mode a key on the Ask/Note switch selects, or null for any other key:
 * ← and → move to the other segment, Home to Ask, End to Note. */
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

interface AskNoteSwitchProps {
  askMode: AskMode;
  /** The Ask segment's icon: the icon of the agent the question goes to. */
  askIcon: ReactNode;
  /** "Ask with {agent} {model}": the Ask segment's name and tooltip. */
  askLabel: string;
  /** The Note segment's name and tooltip: "Save as note" in the Home ask
   * box, "Add a note" in a note's follow-up box. */
  noteLabel: string;
  /** Whether the model menu is open. Omit with onMenuOpenChange for a
   * switch with no model menu (a box with no research agent to choose). */
  menuOpen?: boolean;
  askRef?: RefObject<HTMLButtonElement | null>;
  onModeChange: (mode: AskMode) => void;
  onMenuOpenChange?: (open: boolean) => void;
}

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
}: AskNoteSwitchProps) {
  const hintId = useId();
  const ownAskRef = useRef<HTMLButtonElement | null>(null);
  const askRef = askRefProp ?? ownAskRef;
  const noteRef = useRef<HTMLButtonElement | null>(null);
  const ask = askMode === "ai";
  const hasMenu = Boolean(onMenuOpenChange);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, segment: AskMode) => {
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
      className="new-research-switch"
      role="radiogroup"
      aria-label={`Ask or ${noteLabel.charAt(0).toLowerCase()}${noteLabel.slice(1)}`}
    >
      <button
        ref={askRef}
        type="button"
        role="radio"
        aria-checked={ask}
        tabIndex={ask ? 0 : -1}
        className="new-research-switch-option"
        aria-label={askLabel}
        aria-describedby={ask && hasMenu ? hintId : undefined}
        title={askLabel}
        onClick={(event) => {
          // WebKit does not focus a clicked button; focus it so the arrow
          // keys work from here and the menu has a place to return focus to.
          event.currentTarget.focus();
          if (ask) onMenuOpenChange?.(!menuOpen);
          else onModeChange("ai");
        }}
        onKeyDown={(event) => onKeyDown(event, "ai")}
      >
        {askIcon}
        {ask && hasMenu ? (
          <ChevronDown size={9} className="new-research-switch-chevron" aria-hidden="true" />
        ) : null}
      </button>
      <button
        ref={noteRef}
        type="button"
        role="radio"
        aria-checked={!ask}
        tabIndex={ask ? -1 : 0}
        className="new-research-switch-option"
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
