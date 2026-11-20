// Helpers the write path and the online calls share: the bound on an
// input's size and depth, the writes of an answer landing on its item, and
// the key a signed-out caller's address is counted under.

import { isIP } from "node:net";

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

/** The key a signed-out caller's network address is counted under (the
 * write budget, the open streams; review round 2 of phase 2): an IPv4
 * address as it is; an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) as its
 * IPv4 address; any other IPv6 address as its /64 (`2001:db8:1:2::/64`),
 * because one host on a /64 can use each of its 2^64 addresses. A zone
 * (`%eth0`) is dropped. A value that is no address is its own key. */
export function addressKey(ip: string): string {
  let a = ip.trim().toLowerCase();
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  const family = isIP(a);
  if (family !== 6) return a;
  // a dotted IPv4 tail is two groups
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (dotted) {
    const [b0, b1, b2, b3] = dotted.slice(1).map(Number) as [number, number, number, number];
    a = `${a.slice(0, dotted.index)}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const [left = "", right] = a.split("::");
  const head = left === "" ? [] : left.split(":");
  const tail = right === undefined || right === "" ? [] : right.split(":");
  const fill = Array<string>(8 - head.length - tail.length).fill("0");
  const g = [...head, ...fill, ...tail].map((x) => parseInt(x, 16));
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const [g6 = 0, g7 = 0] = g.slice(6);
    return `${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`;
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(":")}::/64`;
}
