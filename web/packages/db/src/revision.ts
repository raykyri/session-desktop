// The response revision, computed synchronously.
//
// `@session/shared` exposes `responseRevision`, which is async because it
// digests through WebCrypto so the same module runs in a browser. Repository
// functions are synchronous — better-sqlite3 transactions are — so a snapshot
// commit cannot await a hash inside its transaction. This module hashes the
// same canonical text (`canonicalTurnsJson`, the shared definition of the
// bytes) with Node's synchronous digest, and `test/revision.test.ts` pins the
// two against each other so they cannot drift.

import { createHash } from "node:crypto";

import { canonicalTurnsJson } from "@session/shared";
import type { Turn } from "@session/shared";

/** Lowercase sha256 hex of the canonical JSON of `turns`. */
export function revisionOf(turns: readonly Turn[]): string {
  return createHash("sha256").update(canonicalTurnsJson(turns), "utf8").digest("hex");
}

/** UTF-8 byte length of the stored snapshot JSON, which the 64 MiB cap
 * measures. */
export function snapshotByteSize(turns: readonly Turn[]): number {
  return Buffer.byteLength(JSON.stringify(turns), "utf8");
}
