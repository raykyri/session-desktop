// Notifications (`01` C16), written by the `notify` stage of the write that
// causes them, in the same transaction: exactly once, because they commit
// with the write. Nobody is notified of their own action, and nobody who may
// not read the space when the write commits; `reply`, `branch` and `comment`
// coalesce into one unread notification per (recipient, type, thread) with a
// count `n`. A mention notifies any Session account that may read the item:
// in an open space every account, joined or not; in a private one its
// members.

import { readsSpace } from "./access.js";
import type { NotifRec } from "./records.js";
import type { NotifyCtx, Tx } from "./tx.js";
import { isHandle, mentionsIn } from "./validate.js";

/** The mentions of a write, for its answer (02 N16). */
export interface Mentioned {
  notified: string[];
  notMembers: string[];
}

/** The ordinal of the first id a notify stage derives: above any `run`'s. */
export const NOTIFY_ORDINAL = 1000;
/** Notification types that coalesce: one unread per (recipient, type, thread). */
const COALESCED: ReadonlySet<NotifRec["type"]> = new Set(["reply", "branch", "comment"]);

/** Writes a mutation's notifications, with ids derived from its mutation id. */
export class Notifier {
  private k = 0;
  constructor(
    private readonly tx: Tx,
    private readonly ctx: NotifyCtx,
  ) {}

  /** Notify `to` of the actor's write, unless `to` is the actor or may not
   * read the space now. Coalesced types update the recipient's unread
   * notification of that type and thread. Whether `to` was notified. */
  send(
    to: string,
    type: NotifRec["type"],
    sp: string,
    th: string,
    item: string,
    note: string | null = null,
  ): boolean {
    const tx = this.tx;
    if (to === tx.me) return false;
    if (!readsSpace(tx, sp, to)) return false;
    const actor = type === "removed" ? null : tx.me;
    if (COALESCED.has(type)) {
      const old = tx.list("notif", { th }).find((n) => n.to === to && n.type === type && !n.read);
      if (old) {
        tx.put({ ...old, item, actor, n: old.n + 1, createdAt: tx.now });
        return true;
      }
    }
    tx.create({
      kind: "notif",
      id: tx.id(NOTIFY_ORDINAL + ++this.k),
      to,
      type,
      sp,
      th,
      item,
      actor,
      n: 1,
      note,
      read: false,
      createdAt: tx.now,
    });
    return true;
  }

  /** Notify the accounts `t` mentions that may read `sp`, the actor aside.
   * Returns who was notified and which handles are not accounts. */
  mentions(t: string, sp: string, th: string, item: string): Mentioned {
    const out: Mentioned = { notified: [], notMembers: [] };
    for (const h of mentionsIn(t)) {
      if (!isHandle(h) || !this.ctx.isAccount(h)) out.notMembers.push(h);
      else if (this.send(h, "mention", sp, th, item)) out.notified.push(h);
    }
    return out;
  }
}
