// The mutators this prototype runs: `@session/mutators`' set, plus join
// requests, which the build does not have (`01` C10). They stay here because
// their stale-intent rules (approve and reopen compare each request's rev,
// decline acts on the request as it is) are tested only in this suite (`01`
// U4). They run on the package's `Tx` and rules like every other mutator.

import {
  MUTATORS,
  addMember,
  bannedFrom,
  define,
  isClosed,
  needSpace,
  notFound,
  refreshSpace,
  refuse,
  requestKey,
  roleIn,
  stale,
  ulidS,
  handleS,
  type AnyMutator,
} from "@session/mutators";
import { spaces } from "@session/shared";
import { z } from "zod";

const count = z.number().int().nonnegative();

export const JOIN_REQUESTS = {
  "joinRequests.create": define({
    input: z.strictObject({ space: ulidS }),
    who: "user",
    intent: "none",
    space: (_tx, i) => i.space,
    run: (tx, i) => {
      const s = needSpace(tx, i.space);
      if (!isClosed(s)) throw refuse("PRECONDITION_FAILED", "This space is open: join it instead.");
      if (roleIn(tx, s.id, tx.me))
        throw refuse("PRECONDITION_FAILED", "You are a member of this space.");
      const old = tx.byKey(requestKey(s.id, tx.me));
      tx.put({
        kind: "request",
        sp: s.id,
        u: tx.me,
        st: "open",
        why: null,
        createdAt: old?.kind === "request" ? old.createdAt : tx.now,
        updatedAt: tx.now,
      });
      return null;
    },
  }),

  "joinRequests.decide": define({
    input: z
      .strictObject({
        space: ulidS,
        users: z.array(handleS).min(1),
        decision: z.enum(["approve", "decline", "reopen"]),
        why: z.string().max(spaces.MODERATION_NOTE_MAX).optional(),
        /** Each request's rev as the owner saw it, by person: one entry for
         * every person in `users` and no other. Compared for "approve" and
         * "reopen", not for "decline". */
        base: z.record(handleS, count),
      })
      .refine(
        (i) =>
          Object.keys(i.base).length === new Set(i.users).size &&
          i.users.every((u) => Object.hasOwn(i.base, u)),
        { path: ["base"], message: "expected one rev for each person in users" },
      ),
    who: "owner",
    intent: "base.rev",
    space: (_tx, i) => i.space,
    run: (tx, i) => {
      let k = 0;
      let added = 0;
      for (const u of [...new Set(i.users)]) {
        const r = tx.byKey(requestKey(i.space, u));
        if (r?.kind !== "request") throw notFound();
        k++;
        // an approval or a reopening acts on the request as the owner saw
        // it: its rev, which every write of the request bumps (a person who
        // asks again reopens it, and so bumps it). A decline applies to the
        // request as it is now. Approving or declining needs the request
        // open, reopening needs it declined.
        if (i.decision !== "decline" && r.rev !== i.base[u]) throw stale();
        if (r.st !== (i.decision === "reopen" ? "declined" : "open"))
          throw refuse("PRECONDITION_FAILED", "This request was already decided.");
        if (i.decision === "approve") {
          if (bannedFrom(tx, i.space, u))
            throw refuse("PRECONDITION_FAILED", "This person is banned from the space.");
          tx.put({ ...r, st: "approved", updatedAt: tx.now });
          addMember(tx, i.space, u, "member", tx.id(k));
          added++;
        } else if (i.decision === "decline") {
          tx.put({ ...r, st: "declined", why: (i.why ?? "").trim(), updatedAt: tx.now });
        } else {
          tx.put({ ...r, st: "open", updatedAt: tx.now });
        }
      }
      refreshSpace(tx, i.space, added);
      return null;
    },
  }),
};

/** The mutators the prototype server runs by default, and its client knows. */
export const PROTO_MUTATORS: Readonly<Record<string, AnyMutator>> = Object.freeze({
  ...MUTATORS,
  ...JOIN_REQUESTS,
});
