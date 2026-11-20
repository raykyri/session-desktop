// Content-addressed files on the volume (`src/uploads/storage.ts`), which
// hold image attachments. The image sweep built on these is covered in
// `images.test.ts`.

import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import test from "ava";

import { writeFileOnce } from "../src/uploads/images.js";
import {
  ORPHAN_GRACE_MS,
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
  const options = { graceMs: 0, at: Date.now() + 1000 };
  const swept = await sweepOrphanedDocuments(harness.deps, keep, harness.logger, options);
  t.is(swept.scanned, 2);
  t.is(swept.removed, 1);
  t.false(existsSync(orphan));
  t.true(existsSync(kept), "a file a row still points at is kept");

  t.is((await sweepOrphanedDocuments(harness.deps, keep, harness.logger, options)).removed, 0);
});

test("the sweep keeps a file written within the grace period", async (t) => {
  const harness = createHarness(t);
  const root = harness.config.documentsDir;
  // An upload wrote the file and has not inserted its row yet.
  const fresh = storeFile(root, "u3", "d".repeat(64));
  const swept = await sweepOrphanedDocuments(harness.deps, () => new Set(), harness.logger);
  t.is(swept.removed, 0);
  t.true(existsSync(fresh));
  // Past the grace period it is an orphan.
  const later = await sweepOrphanedDocuments(harness.deps, () => new Set(), harness.logger, {
    at: Date.now() + ORPHAN_GRACE_MS + 1000,
  });
  t.is(later.removed, 1);
  t.false(existsSync(fresh));
});

test("storing a file that is already there makes it recent again", async (t) => {
  const harness = createHarness(t);
  const root = harness.config.documentsDir;
  const path = storeFile(root, "u4", "e".repeat(64));
  const old = new Date(Date.now() - 2 * ORPHAN_GRACE_MS);
  utimesSync(path, old, old);
  await writeFileOnce(path, new Uint8Array([1, 2, 3]));
  t.true(statSync(path).mtimeMs > Date.now() - ORPHAN_GRACE_MS);
  t.is(readFileSync(path, "utf8"), "bytes", "the stored bytes are not rewritten");
  const swept = await sweepOrphanedDocuments(harness.deps, () => new Set(), harness.logger);
  t.is(swept.removed, 0);
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
