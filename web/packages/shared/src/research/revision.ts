// The response revision: the identity of a node's answer.
//
// Ported from `response_revision` in `src-tauri/src/research.rs`, which is
// `sha256(serde_json::to_vec(turns))` as lowercase hex. The desktop could rely
// on serde's field order because the same binary wrote and read every
// snapshot; on the web the revision is a contract between the server that
// commits a snapshot and the client that anchors highlights against it
// (`02-domain-model-and-database.md` §5.2), and `JSON.stringify` key order
// follows property insertion order, which depends on how a `Turn` was built.
// So the canonical form is defined here rather than inherited from a
// serializer:
//
//   - object keys are emitted in ascending UTF-16 code-unit order;
//   - `undefined` properties are omitted, `null` is kept (the wire types use
//     `nullish`, so a field may arrive either way and both spellings must not
//     be allowed to change the hash — see the caveat below);
//   - arrays keep their order, with holes and non-JSON entries as `null`;
//   - numbers and strings use `JSON.stringify`, so escaping matches JSON.
//
// The one thing the caller must keep stable is `null` versus absent: they are
// distinct inputs and hash differently, exactly as they do in serde. Turns
// come from the run mapper, which is consistent about this, and from the
// database, which round-trips whatever was committed.
//
// The hash is asynchronous because `util/sha256.ts` uses WebCrypto
// (`crypto.subtle.digest`) so the module runs unchanged in the server process
// and in the browser; there is no synchronous digest available under that
// constraint.

import type { Turn } from "../types/turn.js";
import { sha256Hex } from "../util/sha256.js";

/** A revision as `responseRevision` emits it: 64 lowercase hex digits. */
const RESPONSE_REVISION_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Whether `value` has the shape of a response revision. Used by the highlight
 * anchor validator, which must reject an anchor carrying anything else before
 * it reaches a snapshot lookup.
 */
export function isResponseRevision(value: string): boolean {
  return RESPONSE_REVISION_PATTERN.test(value);
}

function canonicalArray(values: readonly unknown[]): string {
  // Indexed rather than `map`, which preserves holes: `[1, , 3].map(…)` leaves
  // the gap and `join` would write it as nothing, producing invalid JSON. A
  // hole reads as `undefined`, so it encodes as `null` like every other entry
  // JSON has no representation for.
  const entries: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    entries.push(canonicalValue(values[index]) ?? "null");
  }
  return `[${entries.join(",")}]`;
}

/** The canonical encoding of one value, or `undefined` when JSON has no
 * representation for it (an object property carrying one is dropped; an array
 * entry becomes `null`, as in `JSON.stringify`). */
function canonicalValue(value: unknown): string | undefined {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      return undefined;
    case "boolean":
      return value ? "true" : "false";
    case "number":
      // `JSON.stringify` writes non-finite numbers as `null`; matching that
      // keeps the encoding total rather than throwing on a mapper bug.
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "string":
      return JSON.stringify(value);
    default:
      break;
  }
  if (Array.isArray(value)) {
    return canonicalArray(value);
  }
  const record = value as Record<string, unknown>;
  const fields: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const encoded = canonicalValue(record[key]);
    if (encoded !== undefined) {
      fields.push(`${JSON.stringify(key)}:${encoded}`);
    }
  }
  return `{${fields.join(",")}}`;
}

/**
 * The exact text hashed by {@link responseRevision}. Exported so a caller that
 * needs to compare two turn lists, or to debug a revision mismatch, can see
 * the bytes the hash was taken over.
 */
export function canonicalTurnsJson(turns: readonly Turn[]): string {
  return canonicalArray(turns);
}

/** Lowercase hex sha256 of {@link canonicalTurnsJson}. */
export async function responseRevision(turns: readonly Turn[]): Promise<string> {
  return sha256Hex(canonicalTurnsJson(turns));
}
