// Helpers the write path and the online calls share: the bound on an
// input's size and depth, and the writes of an answer landing on its item.

import type * as pkg from "@session/mutators";

import type { StoreTx } from "./store.js";

/** "ok", or the first bound a value passes: "large" (a lower bound of its
 * size as JSON over `maxBytes`: a byte per value and each string's length)
 * or "deep" (nested deeper than `maxDepth`). Walked with a stack. */
export function bounds(v: unknown, maxDepth: number, maxBytes: number): "ok" | "deep" | "large" {
  const stack: [unknown, number][] = [[v, 0]];
  let bytes = 0;
  let deep = false;
  for (let top = stack.pop(); top; top = stack.pop()) {
    const [x, level] = top;
    bytes += typeof x === "string" ? x.length + 2 : 1;
    if (bytes > maxBytes) return "large";
    if (x === null || typeof x !== "object") continue;
    // past the depth bound the walk goes on, for the size: size decides first
    if (level >= maxDepth) deep = true;
    for (const y of Object.values(x)) stack.push([y, level + 1]);
  }
  return deep ? "deep" : "ok";
}

/** The writes of an answer landing on its thread or follow-up: the item,
 * and, when the item is hidden, its hide record with one more edit, so a
 * "shown" decided on what the moderator read before the answer is STALE
 * (review round 2 of phase 1, W1). */
export function answerWrites(tx: StoreTx, item: pkg.ThreadRec | pkg.FollowUpRec): pkg.Write[] {
  const writes: pkg.Write[] = [[`${item.kind}:${item.id}`, item]];
  const h = tx.get(`hide:${item.kind}:${item.id}`);
  if (h?.kind === "hide") writes.push([`hide:${h.item}`, { ...h, ed: h.ed + 1 }]);
  return writes;
}
