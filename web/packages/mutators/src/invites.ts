// Channel invite links (`04` §5): one use, made by the space's owner, read
// by the owner only. Revoke and its Undo (restore).

import { refuse } from "./errors.js";
import { M, readable, ulidS } from "./rules.js";
import { addDays } from "./time.js";
import { define, UnknownRead } from "./tx.js";

const linkOf = (id: string) => `invite:${id}`;

export const INVITES = {
  // `days` is bounded in the schema: an input that passes the schema never
  // makes `run` throw (review round 1, R8, where 1e15 days made an invalid
  // date). A mutator turns an input it cannot apply into a refusal; any other
  // exception is a server fault (INTERNAL_SERVER_ERROR, not recorded).
  "invites.create": define({
    input: M["invites.create"].input.extend({ id: ulidS, space: ulidS }).strict(),
    who: "owner",
    intent: "none",
    space: (_tx, i) => i.space,
    ids: (i) => [i.id],
    // The code is made here, on the server, from its random source. The mock
    // takes it from the id (`id.slice(-5)`), which the client now chooses, so
    // the client would choose the code. 26 characters: 130 bits (`04` B4).
    pre: (ctx) => {
      const B32 = "0123456789abcdefghjkmnpqrstvwxyz";
      for (;;) {
        let code = "";
        for (let k = 0; k < 26; k++) code += B32.charAt(Math.floor(ctx.random() * 32) % 32);
        if (!ctx.inviteCodeTaken(code)) return { code };
      }
    },
    run: (tx, i, v) => {
      const code = v["code"];
      // a client predicting this mutation has no code: the value is unknown
      if (code === undefined) throw new UnknownRead("the invite code");
      tx.create({
        kind: "invite",
        id: i.id,
        code,
        by: tx.me,
        sp: i.space,
        expiresAt: addDays(tx.now, i.days),
        dead: null,
        usedBy: null,
        createdAt: tx.now,
      });
      return { id: i.id, code };
    },
  }),

  // A used link stays used; revoking a revoked one changes nothing.
  "invites.revoke": define({
    input: M["invites.revoke"].input.extend({ id: ulidS }).strict(),
    who: "owner",
    intent: "as is",
    space: (tx, i) => readable(tx, linkOf(i.id), "invite").sp,
    run: (tx, i) => {
      const l = readable(tx, linkOf(i.id), "invite");
      if (l.dead === "Used") throw refuse("PRECONDITION_FAILED", "This link was already used.");
      if (l.dead === null) tx.put({ ...l, dead: "Revoked" });
      return null;
    },
  }),

  // Undo of a revoke: the link works again until it expires.
  "invites.restore": define({
    input: M["invites.restore"].input.extend({ id: ulidS }).strict(),
    who: "owner",
    intent: "as is",
    space: (tx, i) => readable(tx, linkOf(i.id), "invite").sp,
    run: (tx, i) => {
      const l = readable(tx, linkOf(i.id), "invite");
      if (l.dead === "Used") throw refuse("PRECONDITION_FAILED", "This link was already used.");
      if (l.dead === "Revoked") tx.put({ ...l, dead: null });
      return null;
    },
  }),
};
