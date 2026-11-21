// A person's notifications (`01` C16): marking them read. They are user-log
// records, so a frozen space does not stop it (`04` B6).

import { canRead } from "./access.js";
import type { NotifRec } from "./records.js";
import { M, notFound, ulidS } from "./rules.js";
import { define } from "./tx.js";

export const NOTIFICATIONS = {
  "notifications.markRead": define({
    input: M["notifications.markRead"].input.extend({ id: ulidS }).strict(),
    who: "user",
    intent: "none",
    frozen: "allowed",
    // the person's own user-log record: a ban does not stop it
    ownLog: () => true,
    // the person's own notification, while they may read its space
    space: (tx, i) => {
      const n = tx.byKey(`notif:${i.id}`);
      if (n?.kind !== "notif" || n.to !== tx.me || !canRead(tx, n, tx.me)) throw notFound();
      return n.sp;
    },
    run: (tx, i) => {
      const n = tx.byKey(`notif:${i.id}`) as NotifRec;
      if (!n.read) tx.put({ ...n, read: true });
      return null;
    },
  }),

  // every unread notification the person may read now; the others are not
  // served to them, so they stay as they are
  "notifications.markAllRead": define({
    input: M["notifications.markAllRead"].input,
    who: "user",
    intent: "none",
    run: (tx) => {
      for (const n of tx.list("notif", { u: tx.me }))
        if (!n.read && canRead(tx, n, tx.me)) tx.put({ ...n, read: true });
      return null;
    },
  }),
};
