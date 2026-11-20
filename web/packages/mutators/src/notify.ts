// Notifications (`01` C16), written by the `notify` stage of the write that
// causes them, in the same transaction: exactly once, because they commit
// with the write. Nobody is notified of their own action; `reply`, `branch`
// and `comment` coalesce into one unread notification per (recipient, type,
// thread) with a count `n`; a mention notifies a member of the space.

import { roleIn } from "./access.js";
import type { NotifRec } from "./records.js";
import type { Tx } from "./tx.js";
import { isHandle, mentionsIn } from "./validate.js";

/** The ordinal of the first id a notify stage derives: above any `run`'s. */
export const NOTIFY_ORDINAL = 1000;
/** Notification types that coalesce: one unread per (recipient, type, thread). */
const COALESCED: ReadonlySet<NotifRec["type"]> = new Set(["reply", "branch", "comment"]);

/** Writes a mutation's notifications, with ids derived from its mutation id. */
export class Notifier {
  private k = 0;
  constructor(private readonly tx: Tx) {}

  /** Notify `to` of the actor's write, unless `to` is the actor. Coalesced
   * types update the recipient's unread notification of that type and thread. */
  send(
    to: string,
    type: NotifRec["type"],
    sp: string,
    th: string,
    item: string,
    note: string | null = null,
  ): void {
    const tx = this.tx;
    if (to === tx.me) return;
    const actor = type === "removed" ? null : tx.me;
    if (COALESCED.has(type)) {
      const old = tx.list("notif", { th }).find((n) => n.to === to && n.type === type && !n.read);
      if (old) {
        tx.put({ ...old, item, actor, n: old.n + 1, createdAt: tx.now });
        return;
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
  }

  /** Notify the members of `sp` that `t` mentions. A person who is not a
   * member, or is the actor, is not notified. */
  mentions(t: string, sp: string, th: string, item: string): void {
    for (const h of mentionsIn(t))
      if (isHandle(h) && roleIn(this.tx, sp, h) !== null) this.send(h, "mention", sp, th, item);
  }
}
