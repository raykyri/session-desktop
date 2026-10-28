import assert from "node:assert/strict";
import test from "node:test";
import { deferResearchEditorLeave, registerResearchEditorLeaveGuard } from "../src/lib/researchEditorLeave";

test("editor navigation waits for confirmation and stops guarding after unmount", () => {
  let dirty = true;
  let pending: (() => void) | null = null;
  let visits = 0;
  const unregister = registerResearchEditorLeaveGuard((proceed) => {
    if (!dirty) return false;
    pending = proceed;
    return true;
  });
  const navigate = () => {
    if (deferResearchEditorLeave(navigate)) return;
    visits++;
  };
  navigate();
  assert.equal(visits, 0);
  // Keep editing cancels the deferred action without changing history.
  pending = null;
  assert.equal(visits, 0);
  navigate();
  dirty = false;
  (pending as (() => void) | null)?.();
  assert.equal(visits, 1);
  dirty = true;
  unregister();
  navigate();
  assert.equal(visits, 2);
});
