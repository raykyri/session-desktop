// Content-addressed files on the volume (`src/uploads/storage.ts`). No route
// writes them since uploaded documents were removed; the module is kept for
// image attachments (phase 2.9), and these tests keep it exercised until then.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import test from "ava";

import {
  isInsideDocumentsDir,
  removeUserDocuments,
  sweepOrphanedDocuments,
  unlinkOrphans,
} from "../src/uploads/storage.js";

import { createHarness } from "./helpers.js";

function storeFile(root: string, userId: string, name: string): string {
  const directory = join(root, userId);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, "bytes");
  return path;
}

test("the sweep removes files outside the keep set and is idempotent", async (t) => {
  const harness = createHarness(t);
  const root = harness.config.documentsDir;
  const orphan = storeFile(root, "u1", "a".repeat(64));
  const kept = storeFile(root, "u1", "b".repeat(64));

  const keep = () => new Set([kept]);
  const swept = await sweepOrphanedDocuments(harness.deps, keep, harness.logger);
  t.is(swept.scanned, 2);
  t.is(swept.removed, 1);
  t.false(existsSync(orphan));
  t.true(existsSync(kept), "a file a row still points at is kept");

  t.is((await sweepOrphanedDocuments(harness.deps, keep, harness.logger)).removed, 0);
});

test("unlinking refuses a path outside the documents directory", async (t) => {
  const harness = createHarness(t);
  const root = harness.config.documentsDir;
  const outside = join(harness.config.dataDir, "outside.txt");
  writeFileSync(outside, "bytes");

  t.false(isInsideDocumentsDir(root, outside));
  t.is(await unlinkOrphans(root, [outside, join(root, "u1", "missing")], harness.logger), 0);
  t.true(existsSync(outside));
});

test("removing an account's files takes its directory with them", async (t) => {
  const harness = createHarness(t);
  const root = harness.config.documentsDir;
  const path = storeFile(root, "u2", "c".repeat(64));
  let removed = false;

  const unlinked = await removeUserDocuments(harness.deps, "u2", [path], harness.logger, () => {
    removed = true;
  });
  t.true(removed);
  t.is(unlinked, 1);
  t.false(existsSync(join(root, "u2")));
});
