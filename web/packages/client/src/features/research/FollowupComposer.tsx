// The follow-up composer (`09-research-document-view.md` §2, §7).
//
// The thread composer appears after the answer column. A docked composer appears
// beside a selected passage and creates a branch attached to that text. Docked
// mode omits the mode picker.
//
// Mode is a property of the submission, so it lives on the control that
// submits rather than as a tab strip above the field: ⌘↵ sends in the selected
// mode (which is what the button says), ⇧⌘↵ always branches.
//
// This is deliberately *not* the Home composer (`ResearchQueryComposer`). The
// two share `@session/shared` helpers and the `ui/` primitives and nothing
// else: Home launches a new tree from an empty page, this one continues a
// thread whose targeting depends on which node is complete.

import { composerTextareaHeight, findModel, launcherTabAction } from "@session/shared";
import type { ModelInfo } from "@session/shared";
import { ChevronDown, LoaderCircle, X } from "lucide-react";
import { useLayoutEffect } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

import { cn } from "../../lib/cn.js";
import { formatChord } from "../../lib/platform.js";
import { ControlButton, IconButton } from "../../ui/Button.js";
import {
  ComposerSubmitShortcutGlyph,
  isComposerSubmitShortcut,
} from "../../ui/ComposerSubmitShortcut.js";
import { Menu, MenuItem } from "../../ui/Menu.js";
import { GHOST_TRIGGER } from "../../ui/surfaces.js";

import { quoteDisplayText } from "./selection/dom.js";

export type FollowupMode = "thread" | "branch";

/** The submit modes, in menu order. ⇧⌘↵ branches from whichever mode is
 * selected, so it is labelled on the branch row; ⌘↵ submits in the selected
 * mode and is labelled on the Send button. */
export const FOLLOWUP_MODE_OPTIONS: {
  mode: FollowupMode;
  label: string;
  shortcut: string | null;
}[] = [
  { mode: "thread", label: "Continue thread", shortcut: null },
  { mode: "branch", label: "Start side branch", shortcut: formatChord("mod+shift+enter") },
];

export interface FollowupComposerProps {
  /** True for the ask-mode copy docked beside a passage. */
  docked: boolean;
  /** The quoted passage, for the docked copy's header row. */
  quote?: string | undefined;
  /** Rail offset for the docked copy; null while its passage cannot be located
   * in the rendered projection, where it stays in the rail's flow instead of
   * pinning itself over the card stack. */
  dockedTop?: number | null;
  onDismissAsk?: (() => void) | undefined;

  value: string;
  onChange: (value: string) => void;
  mode: FollowupMode;
  onModeChange: (mode: FollowupMode) => void;

  /** Registry id the follow-up will launch on; defaults to the parent's. */
  model: string;
  onModelChange: (model: string) => void;
  /** The models this user may launch on, already filtered for admin gating. */
  models: readonly ModelInfo[];

  placeholder: string;
  submitLabel: string;
  disabled: boolean;
  canSubmit: boolean;
  submitting: boolean;
  hint: string | null;
  /** A settled inline tail the reader can relaunch in place. */
  retry?: { busy: boolean; onRetry: () => void } | null;

  textareaRef: RefObject<HTMLTextAreaElement | null>;
  composerRef: RefObject<HTMLDivElement | null>;
  onSubmit: (modeOverride?: FollowupMode) => void;
}

export function FollowupComposer({
  docked,
  quote,
  dockedTop = null,
  onDismissAsk,
  value,
  onChange,
  mode,
  onModeChange,
  model,
  onModelChange,
  models,
  placeholder,
  submitLabel,
  disabled,
  canSubmit,
  submitting,
  hint,
  retry = null,
  textareaRef,
  composerRef,
  onSubmit,
}: FollowupComposerProps) {
  // Fit the field to its contents up to the shared cap, then let it scroll.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${composerTextareaHeight(textarea.scrollHeight)}px`;
  }, [value, textareaRef]);

  const modelLabel = findModel(model)?.label ?? model;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposerSubmitShortcut(event)) {
      event.preventDefault();
      // A targeted ask is already a branch, so it ignores the shift.
      onSubmit(!docked && event.shiftKey ? "branch" : undefined);
      return;
    }
    if (models.length > 1 && launcherTabAction(event, true) === "cycle-model") {
      event.preventDefault();
      const index = models.findIndex((entry) => entry.id === model);
      const next = models[(index + 1 + models.length) % models.length];
      if (next) onModelChange(next.id);
    }
  };

  return (
    <div
      ref={composerRef}
      className={cn(
        "flex flex-col gap-2 transition-transform duration-[350ms]",
        "focus-within:border-focus-ring",
        docked
          ? "border-border-default bg-surface-panel z-[5] rounded-[10px] border px-3 py-2.5 shadow-md"
          : "border-border-default bg-surface-card relative rounded-[10px] border px-3 py-2.5",
        docked && dockedTop !== null && "absolute right-0.5 left-0 max-[900px]:static",
        disabled && "opacity-55",
      )}
      style={docked && dockedTop !== null ? { top: dockedTop } : undefined}
    >
      {docked ? (
        <div className="flex min-w-0 items-start gap-2">
          <span className="research-prompt-quote border-accent min-w-0 flex-1 border-l-2 pl-2 text-xs">
            {quoteDisplayText(quote ?? "")}
          </span>
          <IconButton label="Cancel question" title="Cancel (Esc)" onClick={onDismissAsk}>
            <X size={12} aria-hidden="true" />
          </IconButton>
        </div>
      ) : null}
      <textarea
        ref={textareaRef}
        className="research-composer-text text-fg-primary placeholder:text-fg-placeholder max-h-50 w-full resize-none border-0 bg-transparent p-0 outline-none"
        value={value}
        placeholder={placeholder}
        aria-label="Follow-up question"
        disabled={disabled}
        rows={2}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Menu
            label="Model"
            align="start"
            trigger={
              <button
                type="button"
                disabled={disabled || models.length === 0}
                title="Model for this follow-up"
                className={cn(GHOST_TRIGGER, "-ml-1.5 max-w-44")}
              >
                <span className="min-w-0 truncate">{modelLabel}</span>
                <ChevronDown size={13} aria-hidden="true" className="shrink-0" />
              </button>
            }
          >
            {models.map((entry) => (
              <MenuItem
                key={entry.id}
                onClick={() => onModelChange(entry.id)}
                disabled={!entry.available}
                selected={entry.id === model}
              >
                {entry.label}
              </MenuItem>
            ))}
          </Menu>
          {hint ? <small className="text-fg-faint min-w-0 truncate text-xs">{hint}</small> : null}
          {retry ? (
            <ControlButton size="sm" disabled={retry.busy} onClick={retry.onRetry}>
              {retry.busy ? (
                <>
                  <LoaderCircle className="session-spin" size={12} aria-hidden="true" />
                  <span>Retrying…</span>
                </>
              ) : (
                <span>Retry follow-up</span>
              )}
            </ControlButton>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ControlButton
            size="sm"
            className="gap-x-1.5 px-1.5"
            disabled={!canSubmit}
            onClick={() => onSubmit()}
          >
            <span>{submitLabel}</span>
            {submitting ? null : <ComposerSubmitShortcutGlyph className="text-fg-disabled" />}
          </ControlButton>
          {docked ? null : (
            <Menu
              label="Follow-up mode"
              align="end"
              side="top"
              trigger={
                <ControlButton
                  size="sm"
                  disabled={disabled}
                  aria-label="Follow-up mode"
                  title="Continue this thread or start a new branch"
                  className="px-1"
                >
                  <ChevronDown size={13} aria-hidden="true" />
                </ControlButton>
              }
            >
              {FOLLOWUP_MODE_OPTIONS.map((option) => (
                <MenuItem
                  key={option.mode}
                  onClick={() => {
                    onModeChange(option.mode);
                    textareaRef.current?.focus();
                  }}
                  hint={option.shortcut}
                  selected={mode === option.mode}
                >
                  {option.label}
                </MenuItem>
              ))}
            </Menu>
          )}
        </div>
      </div>
    </div>
  );
}
