import assert from "node:assert/strict";
import test from "node:test";
import { windowFocusKeyboardOwner } from "../src/lib/windowFocus";

test("app reactivation restores the remembered web editor", () => {
  assert.equal(
    windowFocusKeyboardOwner({
      currentWebEditable: false,
      rememberedWebEditable: true,
      returningToApp: true,
    }),
    "remembered-web-editable",
  );
});

test("current web focus wins without requiring restoration", () => {
  assert.equal(
    windowFocusKeyboardOwner({
      currentWebEditable: true,
      rememberedWebEditable: false,
      returningToApp: false,
    }),
    "current-web-editable",
  );
});

test("internal WebKit focus churn does not revive an old editor", () => {
  assert.equal(
    windowFocusKeyboardOwner({
      currentWebEditable: false,
      rememberedWebEditable: true,
      returningToApp: false,
    }),
    "current-content",
  );
});
