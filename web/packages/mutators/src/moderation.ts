// Moderation by the space's owner (`01` C12; `04` §6): hide, show, remove.
// There is no reporting.

import { refuse } from "./errors.js";
import { Notifier } from "./notify.js";
import { answerKey, threadKey } from "./records.js";
import { M, erase, itemOf, removed, stale } from "./rules.js";
import { define } from "./tx.js";

export const MODERATION = {
  "moderation.decide": define({
    input: M["moderation.decide"].input,
    who: "owner",
    intent: "base.rev when shown",
    // "shown" carries `base` (the input schema requires it)
    space: (tx, i) => itemOf(tx, i.item).s,
    run: (tx, i) => {
      const r = itemOf(tx, i.item);
      // "shown" acts on the item as the owner read it: its rev. The author
      // may still edit a hidden item, which bumps the rev, so a "shown" made
      // after reading one text never publishes another (review round 1,
      // R2). Saves and branches change the counts record, not the item.
      // "hidden" and "removed" apply to the item as it is now, whatever its
      // rev (review round 2, finding 2). Hiding needs the item shown, showing
      // needs it hidden, and a removed item stays removed.
      if (i.decision === "shown" && r.rev !== i.base?.rev) throw stale();
      if (r.mod === "removed") throw removed();
      if (i.decision === "hidden" && r.mod !== null)
        throw refuse("PRECONDITION_FAILED", "This item is already hidden.");
      if (i.decision === "shown" && r.mod !== "hidden")
        throw refuse("PRECONDITION_FAILED", "This item is not hidden.");
      if (i.decision !== "removed") {
        const mod = i.decision === "hidden" ? "hidden" : null;
        tx.put({ ...r, mod });
        // a hidden ask's answer is hidden with it
        const a = r.kind === "thread" || r.kind === "node" ? tx.byKey(answerKey(r.id)) : undefined;
        if (a?.kind === "answer") tx.put({ ...a, mod });
        return null;
      }
      const note = (i.note ?? "").trim() || null;
      erase(tx, r, note);
      // the moderation log names the item's kind, author and space, and
      // keeps no text of it
      tx.create({
        kind: "modlog",
        id: tx.id(1),
        sp: r.s,
        act: "remove",
        item: i.item,
        by: tx.me,
        author: r.u ?? "",
        note,
        createdAt: tx.now,
      });
      return null;
    },
    // a thread's removal notifies its author, with the reason and no text
    notify: (tx, i, _result, ctx) => {
      if (i.decision !== "removed") return undefined;
      const [k, th] = i.item.split(":");
      if ((k !== "a" && k !== "p") || !th) return undefined;
      const p = tx.byKey(threadKey(th));
      if (p?.kind !== "thread" || p.u === null) return undefined;
      new Notifier(tx, ctx).send(p.u, "removed", p.s, p.id, threadKey(p.id), p.modNote);
      return undefined;
    },
  }),
};
