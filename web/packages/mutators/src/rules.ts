// Rules the mutator definitions share: reading a target the actor may read,
// a space's member count and staff list, the moderation keys, and erasing a
// removed item. Ported from replica-proto's `mutators.ts`.

import { RANK, canRead, isClosed, isModOf, rankIn, roleIn, type Reader } from "./access.js";
import type { Tx } from "./engine.js";
import { bad, notFound, refuse } from "./errors.js";
import type {
  CountsRec,
  FollowUpRec,
  Kind,
  RecordOf,
  ReplyRec,
  SpaceRec,
  SpaceRole,
  ThreadRec,
} from "./records.js";

/** Trimmed text, or BAD_REQUEST for text that is only white space. */
export const text = (v: string, path: string) => {
  const s = v.trim();
  if (!s) throw bad(path, "some text");
  return s;
};

/** The mock's space name rule: lower case, `[a-z0-9-]`, at most 32 characters. */
export const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32);

export const removed = () => refuse("PRECONDITION_FAILED", "This item was removed.");

/** A record the actor may read, or NOT_FOUND. */
export function readable<K extends Kind>(tx: Tx, kind: K, id: string): RecordOf<K> {
  const r = tx.get(kind, id);
  if (!r || !canRead(tx, r, tx.me)) throw notFound();
  return r;
}

export const readableThread = (tx: Tx, id: string) => readable(tx, "thread", id);

/** A space that exists and was not deleted, or NOT_FOUND. */
export function needSpace(tx: Tx, sp: string): SpaceRec {
  const s = tx.get("space", sp);
  if (!s || s.deleted) throw notFound();
  return s;
}

/** A space people can write content in: PRECONDITION_FAILED when archived. */
export function writable(tx: Tx, sp: string): SpaceRec {
  const s = needSpace(tx, sp);
  if (s.archived)
    throw refuse(
      "PRECONDITION_FAILED",
      "This space is archived: nobody can ask, post or reply in it.",
    );
  return s;
}

/** The staff list (the space's `mods`) from its member records: by rank, then handle. */
function staffOf(tx: Tx, sp: string): [string, SpaceRole][] {
  return tx
    .scan("member.sp", sp)
    .filter((m) => m.role !== "member")
    .sort((a, b) => RANK[b.role] - RANK[a.role] || (a.u < b.u ? -1 : a.u > b.u ? 1 : 0))
    .map((m) => [m.u, m.role]);
}

/** Write a space's stored member count and staff list after its member records changed. */
export function refreshSpace(tx: Tx, sp: string): void {
  const s = tx.get("space", sp);
  if (!s) throw notFound();
  const members = tx.scan("member.sp", sp).length;
  tx.put({ ...s, members, mods: staffOf(tx, sp) });
}

/** Add `u` to a space, with `adm` as the admission id (a derived id of the
 * write that admits them). Nothing when they are a member. */
export function addMember(tx: Tx, sp: string, u: string, role: SpaceRole, adm: string): void {
  if (tx.get("member", `${sp}:${u}`)) return;
  tx.put({ kind: "member", sp, u, role, adm, joinedAt: tx.now });
}

/** A thread's counts record (written with the thread). */
export function countsOf(tx: Tx, th: ThreadRec): CountsRec {
  const c = tx.get("counts", th.id);
  if (!c) throw refuse("INTERNAL_SERVER_ERROR");
  return c;
}

/** The mock's cxCanAct: you act on members ranked below you; owners and
 * admins also act on admins; nobody acts on the owner or on themselves.
 * Someone without a member record counts as a member. */
export function actsOn(tx: Tx, sp: string, u: string): void {
  const role: SpaceRole = tx.get("member", `${sp}:${u}`)?.role ?? "member";
  const mine = rankIn(tx, sp, tx.me);
  if (u === tx.me) throw refuse("FORBIDDEN", "You can’t change your own membership here.");
  if (role === "owner") throw refuse("FORBIDDEN");
  const ok = role === "admin" ? mine >= RANK.admin : mine > RANK[role];
  if (!ok) throw refuse("FORBIDDEN");
}

/** Who makes invite links: moderators; in a closed space whose invite setting
 * is "members", its members (the mock's `invites`). */
export function mayInvite(g: Reader, s: SpaceRec, u: string): boolean {
  return (
    isModOf(g, s.id, u) || (isClosed(s) && s.invite === "members" && roleIn(g, s.id, u) !== null)
  );
}

export type Item = ThreadRec | FollowUpRec | ReplyRec;

/** An item's key, which its hide record is keyed by. */
export const itemKey = (r: Item) => `${r.kind}:${r.id}`;

/** An item's hide record, if it is hidden. */
export const hideOf = (tx: Tx, r: Item) => tx.get("hide", itemKey(r));

/** Hide an item: write its hide record. The item itself does not change. */
export function hide(tx: Tx, r: Item): void {
  tx.put({ kind: "hide", item: itemKey(r), s: r.s, ed: 0, createdAt: tx.now });
}

/** An author's edit of an item: when the item is hidden, its hide record
 * counts the edit, so a "shown" decided on the earlier text is STALE. */
export function editedWhileHidden(tx: Tx, r: Item): void {
  const h = hideOf(tx, r);
  if (h) tx.put({ ...h, ed: h.ed + 1 });
}

/** The record a moderation key names (`a:<thread>`, `p:<thread>`,
 * `f:<thread>:<follow-up>`, `r:<thread>:<reply>`), if the actor may read it.
 * The mock's reply keys use reply paths and its follow-up keys indexes; here
 * they use ids. */
export function itemOf(tx: Tx, key: string): Item {
  const [k, th, sub, ...rest] = key.split(":");
  if (!th || rest.length) throw notFound();
  if (k === "a" || k === "p") {
    if (sub !== undefined) throw notFound();
    const p = readableThread(tx, th);
    if ((k === "a") !== (p.k === "ask")) throw notFound();
    return p;
  }
  if ((k === "f" || k === "r") && sub) {
    const r = readable(tx, k === "f" ? "followup" : "reply", sub);
    if (r.th !== th) throw notFound();
    return r;
  }
  throw notFound();
}

/** Remove a moderated item for good: its text is erased from storage, and so
 * is everything under it (a thread's follow-ups, answers, runs, replies and
 * their likes; a follow-up's runs; a top-level reply's replies). The item
 * stays as a placeholder. */
export function erase(tx: Tx, r: Item): void {
  switch (r.kind) {
    case "thread":
      for (const x of tx.scan("followup.th", r.id)) {
        tx.del("hide", itemKey(x));
        tx.del("followup", x.id);
      }
      for (const x of tx.scan("reply.th", r.id)) {
        tx.del("hide", itemKey(x));
        tx.del("reply", x.id);
      }
      tx.del("hide", itemKey(r));
      for (const x of tx.scan("rlike.th", r.id)) tx.del("rlike", `${x.u}:${x.reply}`);
      for (const x of tx.scan("run.th", r.id)) tx.del("run", x.id);
      tx.put({ ...countsOf(tx, r), r: 0, rlikes: {} });
      tx.put({
        ...r,
        q: "",
        t: null,
        sum: null,
        running: false,
        mod: "removed",
        updatedAt: tx.now,
      });
      return;
    case "followup":
      for (const x of tx.scan("run.th", r.th)) if (x.node === r.id) tx.del("run", x.id);
      tx.del("hide", itemKey(r));
      tx.put({ ...r, q: "", a: null, mod: "removed" });
      return;
    case "reply":
      if (r.parent === null)
        for (const x of tx.scan("reply.parent", r.id)) {
          tx.del("hide", itemKey(x));
          tx.del("reply", x.id);
        }
      tx.del("hide", itemKey(r));
      tx.put({ ...r, t: "", mod: "removed" });
      return;
  }
}

/** The space of the thread a personal mark (a like, a save) names, for taking
 * one back: null when the person has none (nothing is written), so taking
 * back a mark needs no read access and answers the same whether or not the
 * thread exists. */
export function ownMarkSpace(tx: Tx, has: boolean, thread: string): string | null {
  if (!has) return null;
  return tx.get("thread", thread)?.s ?? null;
}

export const normQs = (qs: { q: string; req?: boolean | undefined }[]) =>
  qs.filter((q) => q.q.trim()).map((q) => ({ q: q.q.trim(), req: q.req === true }));

export const normRules = (rules: string[]) => rules.map((r) => r.trim()).filter(Boolean);
