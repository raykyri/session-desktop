import assert from "node:assert/strict";
import test from "node:test";
import { hyphenLineSubstitutionBlocked, restoreHyphenLines } from "../src/lib/markdownDashes";

const replacement = (data: string) => ({ inputType: "insertReplacementText", data, key: "Enter" });

test("a line of hyphens turned into an em dash gets its hyphens back", () => {
  assert.deepEqual(restoreHyphenLines("Title\n---", "Title\n—", 7, replacement("—")), {
    value: "Title\n---",
    caret: 9,
  });
  // A partial substitution keeps the hyphen count the user typed.
  assert.deepEqual(restoreHyphenLines("---", "—-", 2, replacement("—")), { value: "---", caret: 3 });
  assert.deepEqual(restoreHyphenLines("---", "-—", 2, replacement("—")), { value: "---", caret: 3 });
  assert.deepEqual(restoreHyphenLines("---", "–-", 2, replacement("–")), { value: "---", caret: 3 });
  assert.deepEqual(restoreHyphenLines("--", "—", 1, replacement("—")), { value: "--", caret: 2 });
  // A caret on a later line moves by the change in length.
  assert.deepEqual(restoreHyphenLines("a\n---\nb", "a\n—\nb", 5, replacement("—")), {
    value: "a\n---\nb",
    caret: 7,
  });
});

test("the substitution and the newline from Enter in one event", () => {
  const enter = { inputType: "insertParagraph", data: null, key: "Enter" };
  assert.deepEqual(restoreHyphenLines("---", "—\n", 2, enter), { value: "---\n", caret: 4 });
  assert.deepEqual(restoreHyphenLines("# A\n---\nafter", "# A\n—\n\nafter", 6, enter), {
    value: "# A\n---\n\nafter",
    caret: 8,
  });
  // A substitution reported as typing, after the Enter key.
  assert.deepEqual(restoreHyphenLines("---\n", "—\n", 2, { inputType: "insertText", data: "—", key: null }), {
    value: "---\n",
    caret: 4,
  });
});

test("indented lines of hyphens keep their indentation", () => {
  assert.deepEqual(restoreHyphenLines("  ---", "  —", 3, replacement("—")), { value: "  ---", caret: 5 });
  assert.deepEqual(restoreHyphenLines("--- ", "— ", 2, replacement("—")), { value: "--- ", caret: 4 });
});

test("dashes in prose and dashes the user types are left alone", () => {
  assert.equal(restoreHyphenLines("a -- b", "a — b", 5, replacement("—")), null);
  assert.equal(restoreHyphenLines("a --", "a —", 3, replacement("—")), null);
  // ⌥⇧- after a line of hyphens adds a dash and removes no hyphen.
  assert.equal(restoreHyphenLines("---", "---—", 4, { inputType: "insertText", data: "—", key: "—" }), null);
  // Typing over a selected line of hyphens with ⌥⇧-.
  assert.equal(restoreHyphenLines("---", "—", 1, { inputType: "insertText", data: "—", key: "—" }), null);
  // Pastes and undo are not substitutions.
  assert.equal(restoreHyphenLines("---", "—", 1, { inputType: "insertFromPaste", data: null, key: "v" }), null);
  assert.equal(restoreHyphenLines("---", "—", 1, { inputType: "historyUndo", data: null, key: "z" }), null);
  // A single hyphen is a list marker, not a line this guards.
  assert.equal(restoreHyphenLines("-", "—", 1, replacement("—")), null);
});

test("table separators are not changed", () => {
  const table = "| a | b |\n|---|---|";
  assert.equal(restoreHyphenLines(table, "| a | b |\n|—|—|", 15, replacement("—")), null);
  assert.equal(restoreHyphenLines("x", `${table}\nx`, 21, { inputType: "insertText", data: "x", key: "x" }), null);
  assert.equal(
    hyphenLineSubstitutionBlocked(table, table.length, table.length, replacement("—")),
    false,
  );
});

test("beforeinput cancels a dash replacement aimed at a line of hyphens", () => {
  // Caret at the end of the line.
  assert.equal(hyphenLineSubstitutionBlocked("Title\n---", 9, 9, replacement("—")), true);
  assert.equal(hyphenLineSubstitutionBlocked("   --", 5, 5, replacement("—")), true);
  // Caret on the new line after Enter: the line above is the target.
  assert.equal(hyphenLineSubstitutionBlocked("---\n", 4, 4, replacement("—")), true);
  assert.equal(hyphenLineSubstitutionBlocked("---\n", 4, 4, { ...replacement("—-"), data: "—-" }), true);
  // The replaced range selected.
  assert.equal(hyphenLineSubstitutionBlocked("---\n", 0, 2, replacement("—")), true);
  assert.equal(
    hyphenLineSubstitutionBlocked("---\n", 0, 3, { inputType: "insertText", data: "—", key: "Enter" }),
    true,
  );
});

test("beforeinput lets other replacements through", () => {
  assert.equal(hyphenLineSubstitutionBlocked("a -- b", 5, 5, replacement("—")), false);
  assert.equal(hyphenLineSubstitutionBlocked("a --\n", 5, 5, replacement("—")), false);
  // Autocorrect on a word below a line of hyphens.
  assert.equal(hyphenLineSubstitutionBlocked("---\nteh", 7, 7, replacement("the")), false);
  // Smart quotes.
  assert.equal(hyphenLineSubstitutionBlocked("---", 3, 3, replacement("“")), false);
  // A dash the user types.
  assert.equal(hyphenLineSubstitutionBlocked("---", 3, 3, { inputType: "insertText", data: "—", key: "—" }), false);
  assert.equal(hyphenLineSubstitutionBlocked("---", 0, 3, { inputType: "insertText", data: "—", key: "—" }), false);
  assert.equal(hyphenLineSubstitutionBlocked("---", 3, 3, { inputType: "insertText", data: "—", key: null }), false);
  // Dashes in prose next to a hyphen-only line.
  assert.equal(hyphenLineSubstitutionBlocked("---\nword --", 11, 11, replacement("—")), false);
});
