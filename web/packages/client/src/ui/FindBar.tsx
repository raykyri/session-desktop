import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

import { cn } from "../lib/cn.js";

import { IconButton } from "./Button.js";
import { CONTROL_BUTTON, FORM_FIELD } from "./surfaces.js";

export interface FindBarProps {
  inputRef?: RefObject<HTMLInputElement | null>;
  placeholder: string;
  term: string;
  onTermChange: (term: string) => void;
  /** Zero-based index of the active match, -1 when none is selected. */
  matchIndex: number;
  matchCount: number | null;
  caseSensitive: boolean;
  onCaseSensitiveChange: (value: boolean) => void;
  useRegex: boolean;
  onUseRegexChange: (value: boolean) => void;
  showOptions?: boolean;
  onFindNext: () => void;
  onFindPrevious: () => void;
  onClose: () => void;
  onFocusLeave?: () => void;
  className?: string;
}

/**
 * The find bar, ported from the desktop `PaneSearchBar.tsx` (08 §4 renames it
 * `FindBar`). It owns presentation and the Enter / Shift-Enter / Escape keys;
 * matching and focus stay with the host (`DomSearchBar`).
 */
export function FindBar({
  inputRef,
  placeholder,
  term,
  onTermChange,
  matchIndex,
  matchCount,
  caseSensitive,
  onCaseSensitiveChange,
  useRegex,
  onUseRegexChange,
  showOptions = true,
  onFindNext,
  onFindPrevious,
  onClose,
  onFocusLeave,
  className,
}: FindBarProps) {
  const matchLabel =
    term === "" || matchCount === null
      ? ""
      : matchCount === 0
        ? "No results"
        : `${matchIndex + 1}/${matchCount}`;
  const hasMatches = matchCount === null ? term.length > 0 : matchCount > 0;

  // WebKit does not focus a <button> on mousedown, so pressing one of the bar's
  // own buttons blurs the input with `relatedTarget: null` — the same shape as
  // focus genuinely leaving the bar. Reporting `onFocusLeave` right then can
  // unmount the bar before the button's click ever dispatches. Track pointer
  // presses that start inside the bar and hold the callback until the click has
  // run.
  const pointerDownInside = useRef(false);

  const handlePointerDownCapture = () => {
    pointerDownInside.current = true;
    const clear = () => {
      window.removeEventListener("pointerup", clear);
      window.removeEventListener("pointercancel", clear);
      // Let the click that follows this pointerup dispatch first.
      setTimeout(() => {
        pointerDownInside.current = false;
      }, 0);
    };
    window.addEventListener("pointerup", clear);
    window.addEventListener("pointercancel", clear);
  };

  // Keep the bar holding a live focus target after one of its buttons runs;
  // without this the click leaves focus on <body> and the next keystroke falls
  // through to whatever owns the keyboard.
  const refocusInput = () => inputRef?.current?.focus();

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) onFindPrevious();
      else onFindNext();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const toggleClass = (active: boolean) =>
    cn(
      CONTROL_BUTTON,
      "min-h-control-sm px-2 text-sm",
      active && "border-accent-strong bg-accent-active text-fg-strong",
    );

  return (
    <div
      role="search"
      className={cn(
        "border-border-divider flex items-center gap-1.5 rounded-lg border",
        "bg-surface-popover shadow-popover p-1.5",
        className,
      )}
      onPointerDownCapture={handlePointerDownCapture}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        if (pointerDownInside.current) return;
        onFocusLeave?.();
      }}
    >
      <input
        ref={inputRef}
        type="text"
        className={cn(FORM_FIELD, "min-h-control-sm w-48")}
        value={term}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        aria-label={placeholder}
        onChange={(event) => onTermChange(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
      />
      {matchCount === null ? null : (
        <span className="text-fg-muted min-w-14 shrink-0 text-center text-xs">{matchLabel}</span>
      )}
      {showOptions ? (
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={toggleClass(caseSensitive)}
            title="Match case"
            aria-pressed={caseSensitive}
            onClick={() => {
              onCaseSensitiveChange(!caseSensitive);
              refocusInput();
            }}
          >
            Aa
          </button>
          <button
            type="button"
            className={toggleClass(useRegex)}
            title="Use regular expression"
            aria-pressed={useRegex}
            onClick={() => {
              onUseRegexChange(!useRegex);
              refocusInput();
            }}
          >
            .*
          </button>
        </div>
      ) : null}
      <div className="flex items-center gap-0.5">
        <IconButton
          label="Previous match"
          title="Previous match (Shift+Enter)"
          disabled={!hasMatches}
          onClick={() => {
            onFindPrevious();
            refocusInput();
          }}
        >
          <ArrowUp size={14} aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Next match"
          title="Next match (Enter)"
          disabled={!hasMatches}
          onClick={() => {
            onFindNext();
            refocusInput();
          }}
        >
          <ArrowDown size={14} aria-hidden="true" />
        </IconButton>
        <IconButton label="Close search" title="Close (Esc)" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </IconButton>
      </div>
    </div>
  );
}
