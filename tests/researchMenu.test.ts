import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ResearchMenuItem,
  researchMenuClosesOn,
  researchMenuKeyTarget,
  researchMenuPoint,
  researchMenuPosition,
  researchMenuShortcutKey,
} from "../src/components/research/ResearchMenu";
import {
  researchDialogTabTarget,
  researchFocusRestoreTarget,
} from "../src/components/research/researchFocus";

const viewport = { width: 1000, height: 800 };
const size = { width: 220, height: 200 };
const button = { left: 400, top: 100, right: 426, bottom: 126 };

test("an end-aligned menu opens below its button, right edges level", () => {
  assert.deepEqual(researchMenuPosition(button, size, viewport, "end"), {
    left: 426 - 220,
    top: 126 + 4,
  });
});

test("a start-aligned menu begins 4px left of its button", () => {
  assert.deepEqual(researchMenuPosition(button, size, viewport, "start"), {
    left: 396,
    top: 130,
  });
});

test("a menu near the bottom opens above its button", () => {
  const low = { left: 400, top: 700, right: 426, bottom: 726 };
  assert.deepEqual(researchMenuPosition(low, size, viewport, "end"), {
    left: 206,
    top: 700 - 4 - 200,
  });
});

test("a menu stays below when the space above is shorter, shifted up to fit", () => {
  const tall = { width: 220, height: 500 };
  const anchor = { left: 400, top: 300, right: 426, bottom: 326 };
  // 466px below, 292px above: it stays below and moves up into the window.
  assert.deepEqual(researchMenuPosition(anchor, tall, viewport, "end"), {
    left: 206,
    top: 800 - 8 - 500,
  });
});

test("a context menu opens at the pointer and above it near the bottom", () => {
  assert.deepEqual(researchMenuPosition(researchMenuPoint(300, 200), size, viewport, "point"), {
    left: 300,
    top: 200,
  });
  assert.deepEqual(researchMenuPosition(researchMenuPoint(300, 700), size, viewport, "point"), {
    left: 300,
    top: 500,
  });
});

test("menus are kept inside the window's margins", () => {
  assert.equal(researchMenuPosition(researchMenuPoint(950, 200), size, viewport, "point").left, 1000 - 8 - 220);
  assert.equal(researchMenuPosition({ left: 2, top: 10, right: 20, bottom: 30 }, size, viewport, "start").left, 8);
  assert.equal(researchMenuPosition({ left: 10, top: 10, right: 100, bottom: 30 }, size, viewport, "end").left, 8);
});

test("a side menu opens to the right of its anchor, bottom edges level", () => {
  const strip = { left: 8, top: 740, right: 52, bottom: 776 };
  assert.deepEqual(researchMenuPosition(strip, size, viewport, "side"), {
    left: 58,
    top: 776 - 200,
  });
  // Too close to the top: it moves down into the window.
  assert.equal(researchMenuPosition({ ...strip, top: 20, bottom: 56 }, size, viewport, "side").top, 8);
});

test("arrow keys wrap through the items; Home and End go to the ends", () => {
  assert.equal(researchMenuKeyTarget("ArrowDown", 0, 3), 1);
  assert.equal(researchMenuKeyTarget("ArrowDown", 2, 3), 0);
  assert.equal(researchMenuKeyTarget("ArrowUp", 0, 3), 2);
  assert.equal(researchMenuKeyTarget("ArrowUp", 2, 3), 1);
  assert.equal(researchMenuKeyTarget("Home", 2, 3), 0);
  assert.equal(researchMenuKeyTarget("End", 0, 3), 2);
});

test("arrow keys enter the items from outside them", () => {
  assert.equal(researchMenuKeyTarget("ArrowDown", -1, 3), 0);
  assert.equal(researchMenuKeyTarget("ArrowUp", -1, 3), 2);
});

test("unhandled keys and menus without enabled items do not change focus", () => {
  assert.equal(researchMenuKeyTarget("Tab", 0, 3), null);
  assert.equal(researchMenuKeyTarget("a", 0, 3), null);
  assert.equal(researchMenuKeyTarget("ArrowDown", -1, 0), null);
});

test("an item shortcut is a bare letter or digit", () => {
  const press = (key: string, modifiers: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "isComposing", boolean>> = {}) =>
    researchMenuShortcutKey({ key, metaKey: false, ctrlKey: false, altKey: false, ...modifiers });
  assert.equal(press("d"), "d");
  assert.equal(press("D"), "d");
  assert.equal(press("2"), "2");
  assert.equal(press("d", { metaKey: true }), null);
  assert.equal(press("d", { ctrlKey: true }), null);
  assert.equal(press("d", { altKey: true }), null);
  assert.equal(press("d", { isComposing: true }), null);
  assert.equal(press("Enter"), null);
  assert.equal(press("Escape"), null);
  assert.equal(press(" "), null);
});

test("menu items render their role, state, reason and shortcut", () => {
  const noop = () => {};
  const plain = renderToStaticMarkup(createElement(ResearchMenuItem, { label: "Rename", onSelect: noop }));
  assert.match(plain, /role="menuitem"/);
  assert.doesNotMatch(plain, /aria-checked/);

  const radio = renderToStaticMarkup(
    createElement(ResearchMenuItem, { label: "Drafts", checked: true, disabled: true, onSelect: noop }),
  );
  assert.match(radio, /role="menuitemradio"/);
  assert.match(radio, /aria-checked="true"/);
  assert.match(radio, /disabled=""/);

  const shortcut = renderToStaticMarkup(
    createElement(ResearchMenuItem, {
      label: "Delete",
      shortcut: "D",
      danger: true,
      disabled: true,
      title: "Research with active runs cannot be deleted",
      onSelect: noop,
    }),
  );
  assert.match(shortcut, /data-shortcut="d"/);
  assert.match(shortcut, /aria-keyshortcuts="D"/);
  assert.match(shortcut, /<kbd[^>]*>D<\/kbd>/);
  assert.match(shortcut, /title="Research with active runs cannot be deleted"/);
  assert.match(shortcut, /is-danger/);

  const detail = renderToStaticMarkup(
    createElement(ResearchMenuItem, { label: "Research", detail: "/Users/demo/Research", onSelect: noop }),
  );
  assert.match(detail, /research-menu-detail">\/Users\/demo\/Research</);
});

test("Escape and Tab close a menu; Escape during IME composition does not", () => {
  assert.equal(researchMenuClosesOn({ key: "Escape" }), true);
  assert.equal(researchMenuClosesOn({ key: "Escape", isComposing: true }), false);
  // Tab would move focus out of the portaled menu and leave it open.
  assert.equal(researchMenuClosesOn({ key: "Tab" }), true);
  assert.equal(researchMenuClosesOn({ key: "ArrowDown" }), false);
  assert.equal(researchMenuClosesOn({ key: "Enter" }), false);
});

function element(isConnected = true) {
  return { isConnected };
}

test("a closed menu returns focus to its trigger only when focus fell to the body", () => {
  const body = element();
  const trigger = element();
  // The chosen item was removed with the menu: focus is on the body.
  assert.equal(
    researchFocusRestoreTarget({ active: body, body, target: trigger, modalOpen: false }),
    trigger,
  );
  assert.equal(
    researchFocusRestoreTarget({ active: null, body, target: trigger, modalOpen: false }),
    trigger,
  );
  // Restore focus when the previously focused element has been removed.
  assert.equal(
    researchFocusRestoreTarget({ active: element(false), body, target: trigger, modalOpen: false }),
    trigger,
  );
  // Preserve focus when the action has focused another connected element.
  assert.equal(
    researchFocusRestoreTarget({ active: element(), body, target: trigger, modalOpen: false }),
    null,
  );
  // Do not restore focus while a modal dialog is open.
  assert.equal(
    researchFocusRestoreTarget({ active: body, body, target: trigger, modalOpen: true }),
    null,
  );
});

test("focus goes to the fallback when the trigger was removed too", () => {
  const body = element();
  const fallback = element();
  assert.equal(
    researchFocusRestoreTarget({
      active: body,
      body,
      target: element(false),
      fallback: () => fallback,
      modalOpen: false,
    }),
    fallback,
  );
  assert.equal(
    researchFocusRestoreTarget({ active: body, body, target: element(false), modalOpen: false }),
    null,
  );
  assert.equal(
    researchFocusRestoreTarget({
      active: body,
      body,
      target: null,
      fallback: () => element(false),
      modalOpen: false,
    }),
    null,
  );
});

test("Tab wraps inside a modal dialog and enters it from outside", () => {
  // Last control → first; ⇧Tab on the first → last.
  assert.equal(researchDialogTabTarget(2, 3, false), 0);
  assert.equal(researchDialogTabTarget(0, 3, true), 2);
  // The browser handles Tab between controls inside the dialog.
  assert.equal(researchDialogTabTarget(0, 3, false), null);
  assert.equal(researchDialogTabTarget(2, 3, true), null);
  // Focus outside the dialog (on the body) comes back in.
  assert.equal(researchDialogTabTarget(-1, 3, false), 0);
  assert.equal(researchDialogTabTarget(-1, 3, true), 2);
  assert.equal(researchDialogTabTarget(-1, 0, false), null);
});
