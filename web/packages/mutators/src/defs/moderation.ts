// Reports and moderation decisions.
//
// Stale intent (review round 2, finding 2): a decision that shows an item
// again acts on the item as the moderator read it, so it carries the item's
// `base.rev` and is STALE when it differs: `moderation.decide` "shown", and a
// report reopened (`reports.resolve` "open") when that shows a hidden item.
// Hiding and removing apply to the item as it is now (`base` optional and
// not compared). A removed item stays removed: its text was erased.

import { spaces } from "@session/shared";
import { z } from "zod";

import { defineMutator, inSpace } from "../engine.js";
import { refuse, stale } from "../errors.js";
import { erase, itemOf, readable, removed, text, type Item } from "../rules.js";
import { baseS, ulidS } from "../schemas.js";

/** Hide or remove an item, as `moderation.decide` and `reports.resolve` do. */
function restrict(tx: Parameters<typeof erase>[0], r: Item, to: "hidden" | "removed") {
  if (to === "removed") erase(tx, r);
  else tx.put({ ...r, mod: "hidden" });
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
    input: z.strictObject({
      report: ulidS,
      outcome: z.enum(["dismissed", "hidden", "removed", "open"]),
      /** The item's rev as the moderator saw it: compared when reopening
       * shows a hidden item. */
      base: baseS.optional(),
    }),
    can: (tx, i) => inSpace(tx, readable(tx, "report", i.report).sp, "moderator"),
    run: (tx, i) => {
      const r = readable(tx, "report", i.report);
      const resolved: string[] = [];
      if (i.outcome === "open") {
        const was = r.st;
        tx.put({ ...r, st: "open", updatedAt: tx.now });
        resolved.push(r.id);
        const others = tx.scan("report.key", r.key).some((x) => x.id !== r.id && x.st !== "open");
        if (was !== "dismissed" && was !== "open" && !others) {
          const item = itemOf(tx, r.key);
          if (item.mod === "hidden") {
            if (i.base === undefined || item.rev !== i.base.rev) throw stale();
            tx.put({ ...item, mod: null });
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
      if (item.mod === null || i.outcome === "removed") restrict(tx, item, i.outcome);
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
        message: "expected the item's rev",
      }),
    can: (tx, i) => inSpace(tx, itemOf(tx, i.item).s, "moderator"),
    run: (tx, i) => {
      const r = itemOf(tx, i.item);
      // "shown" acts on the item as the moderator read it: its rev. The
      // author may still edit a hidden item, which bumps the rev, so a
      // "shown" made after reading one text never publishes another (review
      // round 1, R2). Likes and follow-ups change the counts record, not
      // the item. "hidden" and "removed" apply to the item as it is now.
      // Hiding needs the item shown, showing needs it hidden, and a removed
      // item stays removed.
      if (i.decision === "shown" && r.rev !== i.base?.rev) throw stale();
      if (r.mod === "removed") throw removed();
      if (i.decision === "hidden" && r.mod !== null)
        throw refuse("PRECONDITION_FAILED", "This item is already hidden.");
      if (i.decision === "shown" && r.mod !== "hidden")
        throw refuse("PRECONDITION_FAILED", "This item is not hidden.");
      if (i.decision === "removed") erase(tx, r);
      else tx.put({ ...r, mod: i.decision === "hidden" ? "hidden" : null });
      return null;
    },
  }),
];
