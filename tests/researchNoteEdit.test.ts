import assert from "node:assert/strict";
import test from "node:test";
import { researchNoteDoubleClickEdits, researchNoteEditable } from "../src/lib/researchNoteEdit";

test("a text note or link post outside Archive can be edited", () => {
  assert.equal(researchNoteEditable({ type: "post" }, false), true);
  assert.equal(researchNoteEditable({ type: "post" }, true), false);
});

test("questions, documents and missing nodes are not notes to edit", () => {
  assert.equal(researchNoteEditable({ type: "exchange" }, false), false);
  assert.equal(researchNoteEditable({ type: "document" }, false), false);
  // A node without a type tag is an exchange.
  assert.equal(researchNoteEditable({}, false), false);
  assert.equal(researchNoteEditable(undefined, false), false);
  assert.equal(researchNoteEditable(null, false), false);
});

test("a plain primary double-click outside interactive children edits", () => {
  const press = { button: 0, modifier: false, interactive: false };
  assert.equal(researchNoteDoubleClickEdits(press), true);
  assert.equal(researchNoteDoubleClickEdits({ ...press, button: 2 }), false);
  assert.equal(researchNoteDoubleClickEdits({ ...press, modifier: true }), false);
  assert.equal(researchNoteDoubleClickEdits({ ...press, interactive: true }), false);
});
