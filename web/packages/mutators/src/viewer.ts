// Per-viewer fields: computed on the client from the stored shape and the
// signed-in person, never stored (AGENTS.md). Each is a pure function of a
// `Reader` (the client's replica) and the viewer's handle. They are the
// mock's derived fields (`DERIVED`: a thread's `liked` and `mine`) and the
// values its per-person collections held (`saved`, `rel`, `roles`).

import { isClosed, roleIn, type Reader } from "./access.js";
import type { SpaceRole, ThreadRec } from "./records.js";

/** The viewer liked the thread. */
export const liked = (g: Reader, u: string | null, th: string) =>
  u !== null && g.get("like", `${u}:${th}`) !== undefined;

/** The viewer wrote the record. */
export const mine = (r: { u: string }, u: string | null) => u !== null && r.u === u;

/** The viewer saved the thread. */
export const saved = (g: Reader, u: string | null, th: string) =>
  u !== null && g.get("save", `${u}:${th}`) !== undefined;

/** The viewer liked the reply. */
export const replyLiked = (g: Reader, u: string | null, reply: string) =>
  u !== null && g.get("rlike", `${u}:${reply}`) !== undefined;

/** The viewer saved the ask (`node` "r": the thread's own). */
export const askSaved = (g: Reader, u: string | null, th: string, node: string) =>
  u !== null && g.get("asksave", `${u}:${th}:${node}`) !== undefined;

export const sourceSaved = (g: Reader, u: string | null, src: string) =>
  u !== null && g.get("srcsave", `${u}:${src}`) !== undefined;

export const sourceRead = (g: Reader, u: string | null, src: string) =>
  u !== null && g.get("srcread", `${u}:${src}`) !== undefined;

export const muted = (g: Reader, u: string | null, who: string) =>
  u !== null && g.get("mute", `${u}:${who}`) !== undefined;

export const blocked = (g: Reader, u: string | null, who: string) =>
  u !== null && g.get("block", `${u}:${who}`) !== undefined;

/** A thread as the mock's GET returned it: the stored record with its counts
 * and the viewer's fields (`r`, `likes`, `liked`, `mine`). */
export function threadView(g: Reader, p: ThreadRec, u: string | null) {
  const c = g.get("counts", p.id);
  return { ...p, r: c?.r ?? 0, likes: c?.likes ?? 0, liked: liked(g, u, p.id), mine: mine(p, u) };
}

/** The viewer's relation to a closed space (the mock's `rel`): `mod` for its
 * staff, `member`, `pending` (an open join request), `denied` (a declined
 * one), or `none`. Null for an open space or one the replica lacks. */
export function relation(
  g: Reader,
  sp: string,
  u: string | null,
): "none" | "pending" | "member" | "mod" | "denied" | null {
  const s = g.get("space", sp);
  if (!s || !isClosed(s)) return null;
  const role = roleIn(g, sp, u);
  if (role) return role === "member" ? "member" : "mod";
  const r = u === null ? undefined : g.get("request", `${sp}:${u}`);
  return r?.st === "open" ? "pending" : r?.st === "declined" ? "denied" : "none";
}

const ROLE_NAME: Readonly<Record<SpaceRole, "Owner" | "Admin" | "Moderator" | "Member">> = {
  owner: "Owner",
  admin: "Admin",
  mod: "Moderator",
  member: "Member",
};

/** The viewer's role in a space as the mock's `roles` names it, or null. */
export function roleName(g: Reader, sp: string, u: string | null) {
  const r = roleIn(g, sp, u);
  return r ? ROLE_NAME[r] : null;
}

/** Notifications the viewer has not read, among those given. */
export const unread = (ns: readonly { read: boolean }[]) => ns.filter((n) => !n.read).length;
