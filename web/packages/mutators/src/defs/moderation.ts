// Reports and moderation decisions.
//
// Stale intent (review round 2, finding 2): a decision that shows an item
// again acts on the item as the moderator read it, so it carries `base.rev`
// and is STALE when it differs: `moderation.decide` "shown". Hiding writes a
// separate hide record and leaves the item as it is (phase 1b, Part 0 item
// 3), so `base.rev` is the hide record's rev; the author's edits of a hidden
// item move it too (`editedWhileHidden`). A report reopened
// (`reports.resolve` "open") always carries `base` (phase 1a.2, decision 7):
// the report's rev, compared every time, and the hide record's
// (`base.item`), compared when the reopening shows a hidden item. Hiding and removing apply
// to the item as it is now (`base` optional and not compared). A removed item
// stays removed: its text was erased.

import { spaces } from "@session/shared";
import { z } from "zod";

import { defineMutator, inSpace } from "../engine.js";
import { refuse, stale } from "../errors.js";
import {
  erase,
  hide,
  hideOf,
  itemKey,
  itemOf,
  readable,
  removed,
  text,
  type Item,
} from "../rules.js";
import { baseS, count, ulidS } from "../schemas.js";

/** Hide or remove an item, as `moderation.decide` and `reports.resolve` do. */
function restrict(tx: Parameters<typeof erase>[0], r: Item, to: "hidden" | "removed") {
  if (to === "removed") erase(tx, r);
  else hide(tx, r);
}

export const moderationMutators = [
  defineMutator({
    name: "reports.create",
    input: z.strictObject({
      id: ulidS,
      item: spaces.moderationKeySchema,
      why: z.string(),
      note: z.string().optional(),
    }),
    ids: (i) => [i.id],
    can: (tx, i) => inSpace(tx, itemOf(tx, i.item).s, "member"),
    run: (tx, i) => {
      const item = itemOf(tx, i.item);
      const why = text(i.why, "why");
      tx.create({
        kind: "report",
        id: i.id,
        sp: item.s,
        key: i.item,
        by: tx.me,
        st: "open",
        why,
        note: (i.note ?? "").trim(),
        createdAt: tx.now,
        updatedAt: tx.now,
      });
      return { id: i.id, sp: item.s };
    },
    // the space's staff get a notification (server-made ids)
    effects: (i, result) => [
      { type: "notifyStaff", sp: result.sp, report: result.id, item: i.item },
    ],
  }),

  // Dismiss a report, or hide or remove its item (which resolves every open
  // report on it); "open" reopens it. The person who reported it is told
  // (a post-commit effect). Dismissing leaves the item's state as it is: a
  // moderator's earlier "hidden" stays, unlike the mock, which shows the item
  // when the last open report on it is dismissed.
  defineMutator({
    name: "reports.resolve",
    input: z
      .strictObject({
        report: ulidS,
        outcome: z.enum(["dismissed", "hidden", "removed", "open"]),
        /** Required for "open": the report's rev as the moderator saw it
         * (compared), and the item's (compared when reopening shows a hidden
         * item). Not compared for the other outcomes. */
        base: z.strictObject({ rev: count, item: count }).optional(),
      })
      .refine((i) => i.outcome !== "open" || i.base !== undefined, {
        path: ["base"],
        message: "expected the report's and the item's revs",
      }),
    can: (tx, i) => inSpace(tx, readable(tx, "report", i.report).sp, "moderator"),
    run: (tx, i) => {
      const r = readable(tx, "report", i.report);
      const resolved: string[] = [];
      if (i.outcome === "open") {
        if (r.rev !== i.base?.rev) throw stale(tx, tx.me, r);
        const was = r.st;
        tx.put({ ...r, st: "open", updatedAt: tx.now });
        resolved.push(r.id);
        const others = tx.scan("report.key", r.key).some((x) => x.id !== r.id && x.st !== "open");
        if (was !== "dismissed" && was !== "open" && !others) {
          const item = itemOf(tx, r.key);
          const h = hideOf(tx, item);
          if (h) {
            if (h.rev !== i.base?.item) throw stale(tx, tx.me, item, [`hide:${itemKey(item)}`]);
            tx.del("hide", itemKey(item));
          }
        }
        return { resolved, outcome: null };
      }
      if (i.outcome === "dismissed") {
        if (r.st !== "dismissed") tx.put({ ...r, st: "dismissed", updatedAt: tx.now });
        return { resolved: [r.id], outcome: "dismissed" as const };
      }
      const item = itemOf(tx, r.key);
      if (item.mod === "removed") throw removed();
      if (!hideOf(tx, item) || i.outcome === "removed") restrict(tx, item, i.outcome);
      for (const x of tx.scan("report.key", r.key)) {
        if (x.st !== "open" && x.id !== r.id) continue;
        tx.put({ ...x, st: i.outcome, updatedAt: tx.now });
        resolved.push(x.id);
      }
      return { resolved, outcome: i.outcome };
    },
    effects: (_i, result) =>
      result.resolved.map((report) => ({
        type: "reportResolved" as const,
        report,
        outcome: result.outcome,
      })),
  }),

  defineMutator({
    name: "moderation.decide",
    input: spaces.spaceProcedures["moderation.decide"].input
      .extend({ base: baseS.optional() })
      .strict()
      .refine((i) => i.decision !== "shown" || i.base !== undefined, {
        path: ["base"],
        message: "expected the hide record's rev",
      }),
    can: (tx, i) => inSpace(tx, itemOf(tx, i.item).s, "moderator"),
    run: (tx, i) => {
      const r = itemOf(tx, i.item);
      const h = hideOf(tx, r);
      // "shown" acts on the item as the moderator read it: the hide record's
      // rev. The author may still edit a hidden item, which moves that rev,
      // so a "shown" made after reading one text never publishes another
      // (review round 1, R2). Hiding and showing do not change the item, so
      // an author's edit made before a hide is not STALE. "hidden" and
      // "removed" apply to the item as it is now. Hiding needs the item
      // shown, showing needs it hidden, and a removed item stays removed.
      if (i.decision === "shown" && (h?.rev ?? 0) !== i.base?.rev)
        throw stale(tx, tx.me, r, [`hide:${itemKey(r)}`]);
      if (r.mod === "removed") throw removed();
      if (i.decision === "hidden" && h)
        throw refuse("PRECONDITION_FAILED", "This item is already hidden.");
      if (i.decision === "shown" && !h)
        throw refuse("PRECONDITION_FAILED", "This item is not hidden.");
      if (i.decision === "removed") erase(tx, r);
      else if (i.decision === "hidden") hide(tx, r);
      else tx.del("hide", itemKey(r));
      return null;
    },
  }),
];
