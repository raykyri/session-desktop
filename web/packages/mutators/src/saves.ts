// Saves: a person's saved threads, counted (`01` C1, C2).

import { saveKey } from "./records.js";
import { M, countSaves, ownMarkSpace, readableThread, removed, ulidS } from "./rules.js";
import { define } from "./tx.js";

export const SAVES = {
  // The mock's saved.toggle, with a required `on`: the result depends on what
  // the client saw, not on the server's state, so two devices that save the
  // same thread do not cancel out. A save is counted (`01` C1). A save is a
  // user-log record, so a frozen space does not stop it (`04` B6).
  "saved.set": define({
    input: M["saved.set"].input.extend({ id: ulidS }).strict(),
    who: "user",
    intent: "none",
    frozen: "allowed",
    // taking a save back writes only the person's user log: a ban allows it
    ownLog: (i) => !i.on,
    space: (tx, i) =>
      i.on ? readableThread(tx, i.id).s : ownMarkSpace(tx, saveKey(tx.me, i.id), i.id),
    can: (tx, i) => {
      if (!i.on || tx.byKey(saveKey(tx.me, i.id))) return;
      if (readableThread(tx, i.id).mod === "removed") throw removed();
    },
    run: (tx, i) => {
      const key = saveKey(tx.me, i.id);
      const had = tx.byKey(key) !== undefined;
      if (i.on === had) return { on: i.on };
      if (i.on) tx.put({ kind: "save", u: tx.me, th: i.id, createdAt: tx.now });
      else tx.del(key);
      countSaves(tx, i.id, i.on ? 1 : -1);
      return { on: i.on };
    },
  }),
};
