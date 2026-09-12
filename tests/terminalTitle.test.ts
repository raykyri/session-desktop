import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeTerminalTitle } from "../src/lib/terminalTitle";

test("retains existing Grok title normalization", () => {
  assert.equal(sanitizeTerminalTitle("Fix the build - GROK"), "Fix the build");
});
