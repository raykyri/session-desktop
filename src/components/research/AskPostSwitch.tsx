import { useId, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { ChevronDown, Users } from "lucide-react";

/** Who a question goes to: an agent ("ai"), or the network, which posts a
 * note to Home (network delivery itself is not built yet); a body that is a
 * single URL is saved as a link or post instead of asked. The Ask/Post
 * switcher sets it. */
export type AskMode = "network" | "ai";

/** The mode a key on the Ask/Post switcher selects, or null for any other
 * key: ← and → move to the other segment, Home to Ask, End to Post. */
export function askSwitchKeyTarget(key: string, current: AskMode): AskMode | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowRight":
      return current === "ai" ? "network" : "ai";
    case "Home":
      return "ai";
    case "End":
      return "network";
    default:
      return null;
  }
}

interface AskPostSwitchProps {
  askMode: AskMode;
  /** The Ask segment's icon: the selected agent's in the Home ask box. */
  askIcon: ReactNode;
  /** "Ask with {agent} {model}": the Ask segment's name and tooltip. */
  askLabel: string;
  /** Whether the model menu is open. Omit with onMenuOpenChange for a
   * switch with no model menu, as in a post's follow-up box, whose AI
   * follow-up uses the post's model. */
  menuOpen?: boolean;
  askRef?: RefObject<HTMLButtonElement | null>;
  onModeChange: (mode: AskMode) => void;
  onMenuOpenChange?: (open: boolean) => void;
}

/** Ask and Post as two icon segments in a radiogroup with a roving tabindex.
 * A press on the selected Ask segment (or Enter, Space or ↓ on it) opens the
 * model menu; from Post, Ask only switches back, keeping the last model. A
 * radio cannot carry aria-haspopup, so the menu is announced through a
 * description instead. */
export function AskPostSwitch({
  askMode,
  askIcon,
  askLabel,
  menuOpen = false,
  askRef: askRefProp,
  onModeChange,
  onMenuOpenChange,
}: AskPostSwitchProps) {
  const hintId = useId();
  const ownAskRef = useRef<HTMLButtonElement | null>(null);
  const askRef = askRefProp ?? ownAskRef;
  const postRef = useRef<HTMLButtonElement | null>(null);
  const ask = askMode === "ai";
  const hasMenu = Boolean(onMenuOpenChange);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, segment: AskMode) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = askSwitchKeyTarget(event.key, segment);
    if (target) {
      event.preventDefault();
      onModeChange(target);
      (target === "ai" ? askRef : postRef).current?.focus();
      return;
    }
    if (segment === "ai" && ask && event.key === "ArrowDown" && onMenuOpenChange) {
      event.preventDefault();
      onMenuOpenChange(true);
    }
  };

  return (
    <div className="new-research-switch" role="radiogroup" aria-label="Send to">
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
        ref={postRef}
        type="button"
        role="radio"
        aria-checked={!ask}
        tabIndex={ask ? -1 : 0}
        className="new-research-switch-option"
        aria-label="Post to network"
        title="Post to network"
        onClick={(event) => {
          event.currentTarget.focus();
          onModeChange("network");
        }}
        onKeyDown={(event) => onKeyDown(event, "network")}
      >
        <Users size={14} aria-hidden="true" />
      </button>
      {hasMenu ? (
        <span id={hintId} hidden>
          Press Enter to choose a model
        </span>
      ) : null}
    </div>
  );
}
