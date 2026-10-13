/** Keeps macOS smart dashes from rewriting Markdown lines made of hyphens.
 *
 * With System Settings > Keyboard > "Use smart quotes and dashes" on, WebKit
 * replaces "--" and "---" in an editable field with an em dash (U+2014), or
 * leaves a mix such as "—-". In prose that is wanted, but a line of hyphens
 * alone is Markdown syntax: a thematic break, a setext heading underline or a
 * front-matter fence. `attachMarkdownDashGuard` keeps the hyphens on such
 * lines and leaves every other substitution (autocorrect, smart quotes,
 * dashes inside prose) alone.
 *
 * Two layers:
 * 1. `beforeinput`: a replacement whose text is dashes, aimed at a line of
 *    hyphens, is cancelled (`hyphenLineSubstitutionBlocked`).
 * 2. `input`: if a substitution got through anyway (no `beforeinput`, or one
 *    whose target could not be determined), the hyphens are put back
 *    (`restoreHyphenLines`). */

const DASHES = /[–—]/;
/** A line of two or more hyphens, with optional whitespace around them. */
const HYPHEN_LINE = /^([ \t]*)(-{2,})([ \t]*)$/;
/** A line of dashes, at least one an en or em dash, with optional whitespace. */
const DASHED_LINE = /^([ \t]*)([-–—]+)([ \t]*)$/;
/** Replacement text that is only dashes, at least one an en or em dash. */
const DASH_REPLACEMENT = /^[-–—]*[–—][-–—]*$/;

function isHyphenLine(line: string): boolean {
  return HYPHEN_LINE.test(line);
}

function lineAt(value: string, index: number): { start: number; end: number; text: string } {
  const start = value.lastIndexOf("\n", index - 1) + 1;
  const newline = value.indexOf("\n", index);
  const end = newline === -1 ? value.length : newline;
  return { start, end, text: value.slice(start, end) };
}

interface DashInput {
  inputType: string;
  data: string | null;
  /** `KeyboardEvent.key` of the last keydown before this input, or null. A
   * dash typed by the user (⌥- or ⌥⇧- on a Mac keyboard) arrives as an
   * `insertText` whose data equals this key. */
  key: string | null;
}

function typedByUser(input: DashInput): boolean {
  return input.inputType === "insertText" && input.data !== null && input.data === input.key;
}

/** Whether a `beforeinput` replacement should be cancelled: its text is
 * dashes and it replaces hyphens on a line of hyphens alone.
 *
 * WebKit reports smart dashes in a textarea as `insertReplacementText` with
 * the replacement in `data`, and `getTargetRanges()` is empty there, so the
 * replaced range is inferred: the selection when one is set, else the
 * caret's line, or the line above when the caret is at the start of a line
 * (the substitution runs after Enter has moved the caret). An `insertText`
 * with a selection is checked the same way, in case a substitution is
 * reported as typing over the replaced range. */
export function hyphenLineSubstitutionBlocked(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  input: DashInput,
): boolean {
  const data = input.data ?? "";
  if (!DASH_REPLACEMENT.test(data)) return false;
  const collapsed = selectionStart === selectionEnd;
  if (input.inputType === "insertText") {
    if (collapsed || typedByUser(input)) return false;
  } else if (input.inputType !== "insertReplacementText") {
    return false;
  }
  if (!collapsed) {
    const line = lineAt(value, selectionStart);
    if (selectionEnd > line.end) return false;
    return /^-+$/.test(value.slice(selectionStart, selectionEnd)) && isHyphenLine(line.text);
  }
  const line = lineAt(value, selectionStart);
  const beforeCaret = value.slice(line.start, selectionStart);
  if (beforeCaret.trim() === "" && line.start > 0) {
    return isHyphenLine(lineAt(value, line.start - 1).text);
  }
  return isHyphenLine(line.text);
}

/** Input types that can carry a system substitution. Pastes, drops, deletions
 * and undo are left as they are. An empty type is an event without one. */
const SUBSTITUTION_TYPES = new Set(["insertReplacementText", "insertText", "insertLineBreak", "insertParagraph", ""]);

/** After an input event: the text with hyphen lines restored where the edit
 * turned a line of hyphens into dashes, and where the caret goes. Null when
 * nothing needs restoring.
 *
 * `before` is the text before the edit and `after` the text after it, with
 * the caret at `caret`. The changed span is found by the common prefix and
 * suffix, widened to whole lines; changed lines are paired from the top, so
 * a substitution and the newline from Enter in one event ("---" to "—\n")
 * are handled. A line is restored when it was a line of hyphens, is now
 * dashes with at least one en or em dash, and has fewer hyphens than before
 * (typing a dash after "---" adds one and removes none). The restored line
 * keeps its new leading and trailing whitespace and gets the old hyphens. */
export function restoreHyphenLines(
  before: string,
  after: string,
  caret: number,
  input: DashInput,
): { value: string; caret: number } | null {
  if (before === after || !SUBSTITUTION_TYPES.has(input.inputType) || typedByUser(input)) return null;
  let prefix = 0;
  const shorter = Math.min(before.length, after.length);
  while (prefix < shorter && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  if (!DASHES.test(after.slice(prefix, after.length - suffix))) return null;

  const start = before.lastIndexOf("\n", prefix - 1) + 1;
  const blockEnd = (text: string, from: number) => {
    const newline = text.indexOf("\n", from);
    return newline === -1 ? text.length : newline;
  };
  const oldLines = before.slice(start, blockEnd(before, before.length - suffix)).split("\n");
  const newEnd = blockEnd(after, after.length - suffix);
  const newLines = after.slice(start, newEnd).split("\n");

  let changed = false;
  let lineStart = start;
  let nextCaret = caret;
  const restored = newLines.map((line, index) => {
    const lineEnd = lineStart + line.length;
    const old = index < oldLines.length ? HYPHEN_LINE.exec(oldLines[index]) : null;
    const now = old ? DASHED_LINE.exec(line) : null;
    let result = line;
    if (old && now && DASHES.test(now[2]) && countHyphens(now[2]) < old[2].length) {
      result = now[1] + old[2] + now[3];
      changed = true;
      // Positions in `after`. A caret after the dash run moves by the change
      // in length; a caret inside it goes to the end of the hyphens.
      const runStart = lineStart + now[1].length;
      const runEnd = runStart + now[2].length;
      const delta = result.length - line.length;
      if (caret >= runEnd) nextCaret += delta;
      else if (caret > runStart) nextCaret += runEnd - caret + delta;
    }
    lineStart = lineEnd + 1;
    return result;
  });
  if (!changed) return null;
  const value = after.slice(0, start) + restored.join("\n") + after.slice(newEnd);
  return { value, caret: Math.max(0, Math.min(nextCaret, value.length)) };
}

function countHyphens(text: string): number {
  let count = 0;
  for (const character of text) if (character === "-") count += 1;
  return count;
}

/** Sets a textarea's text so React's change tracking sees it: through the
 * prototype's `value` setter, which bypasses the per-element setter React
 * installs, so the `input` event that follows still reports a change and the
 * component's own onChange stores the restored text. */
function setNativeValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")?.set;
  if (setter) setter.call(textarea, value);
  else textarea.value = value;
}

/** Attaches both layers to a textarea; returns a function that removes them.
 *
 * The listeners are on the element, so the `input` repair runs before React's
 * root listener dispatches onChange, and onChange reads the restored text.
 * The repair sets `value` directly, which is not an undoable edit: ⌘Z after
 * it may not step back as expected. Cancelling in `beforeinput` keeps the
 * undo stack intact, and is the layer expected to apply on macOS. */
export function attachMarkdownDashGuard(textarea: HTMLTextAreaElement): () => void {
  let before = textarea.value;
  let key: string | null = null;

  const remember = () => {
    before = textarea.value;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    key = event.key;
    remember();
  };
  const onBeforeInput = (event: InputEvent) => {
    remember();
    if (event.isComposing) return;
    const data = event.data ?? event.dataTransfer?.getData("text/plain") ?? null;
    const input = { inputType: event.inputType, data, key };
    if (hyphenLineSubstitutionBlocked(textarea.value, textarea.selectionStart, textarea.selectionEnd, input)) {
      event.preventDefault();
    }
  };
  const onInput = (event: Event) => {
    const inputEvent = event as InputEvent;
    const input = {
      inputType: typeof inputEvent.inputType === "string" ? inputEvent.inputType : "",
      data: inputEvent.data ?? null,
      key,
    };
    key = null;
    if (!inputEvent.isComposing) {
      const repair = restoreHyphenLines(before, textarea.value, textarea.selectionEnd, input);
      if (repair) {
        setNativeValue(textarea, repair.value);
        textarea.setSelectionRange(repair.caret, repair.caret);
      }
    }
    remember();
  };

  textarea.addEventListener("focus", remember);
  textarea.addEventListener("keydown", onKeyDown);
  textarea.addEventListener("beforeinput", onBeforeInput);
  textarea.addEventListener("input", onInput);
  return () => {
    textarea.removeEventListener("focus", remember);
    textarea.removeEventListener("keydown", onKeyDown);
    textarea.removeEventListener("beforeinput", onBeforeInput);
    textarea.removeEventListener("input", onInput);
  };
}
