import type { ResearchNodeType } from "../wire/index.js";

import { nodeType } from "./researchNodeTypes.js";

/** Whether a note can be edited: a post node (a text note or a link post,
 * the root note or a follow-up note) in a thread outside the Archive. The note
 * menu's "Edit note" item and double-clicking a note use this rule. */
export function researchNoteEditable(
  node: { type?: ResearchNodeType } | null | undefined,
  archived: boolean,
): boolean {
  return node != null && !archived && nodeType(node) === "post";
}

/** Targets inside a note's column that keep their own double-click: links
 * and link cards, buttons, form fields, media, embeds and widgets. */
export const NOTE_DOUBLE_CLICK_IGNORE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  "label",
  "img",
  "video",
  "audio",
  "iframe",
  "[role='button']",
  "[role='link']",
  "[contenteditable]:not([contenteditable='false'])",
  ".tweet-embed",
  ".session-widget",
  ".turn-diagram",
].join(", ");

/** Whether a press or double-click on an editable note starts editing it:
 * the primary button without modifiers, outside the note's interactive
 * children. */
export function researchNoteDoubleClickEdits({
  button,
  modifier,
  interactive,
}: {
  button: number;
  /** ⌘, Ctrl, ⌥ or Shift was held. */
  modifier: boolean;
  /** The target is inside an interactive child of the note. */
  interactive: boolean;
}): boolean {
  return button === 0 && !modifier && !interactive;
}
