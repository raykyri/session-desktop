// Join requests, members, bans and invite links.
//
// Stale intent (review round 2, finding 2). Approving or reopening a join
// request carries the request's rev as the moderator saw it, and a role
// change the member record's rev; both are STALE when it differs. A decline
// and a ban apply to the record as it is now (`base` is optional on a
// decline and not compared). A removal names the member's admission id
// (`MemberRec.adm`), so a removal decided before the person was let in again
// is STALE. With the rev matching, a decision the record's state does not
// allow is PRECONDITION_FAILED.

import { spaces } from "@session/shared";
import { z } from "zod";

import { RANK, bannedFrom, isClosed, isModOf, rankIn, roleIn } from "../access.js";
import { defineMutator, inSpace, personal } from "../engine.js";
import { bad, notFound, refuse, stale } from "../errors.js";
import { actsOn, addMember, mayInvite, needSpace, readable, refreshSpace } from "../rules.js";
import { baseS, count, handleS, ulidS } from "../schemas.js";
import { DAY, isoAt } from "../time.js";

/** The longest an invite link lasts, in days. */
export const INVITE_MAX_DAYS = 30;

/** Code characters: Crockford base32 in lower case, 10 of them (50 bits). */
const CODE_CHARS = "0123456789abcdefghjkmnpqrstvwxyz";

export const memberMutators = [
  defineMutator({
    name: "joinRequests.create",
    input: spaces.spaceProcedures["joinRequests.create"].input.extend({ space: ulidS }).strict(),
    can: (tx, i) => inSpace(tx, i.space, "user"),
    run: (tx, i) => {
      const s = needSpace(tx, i.space);
      if (!isClosed(s)) throw refuse("PRECONDITION_FAILED", "This space is open: join it instead.");
      if (s.policy === "invite")
        throw refuse(
          "PRECONDITION_FAILED",
          "This space is invite only: ask for an invite instead.",
        );
      if (roleIn(tx, s.id, tx.me))
        throw refuse("PRECONDITION_FAILED", "You are a member of this space.");
      const a = i.answers ?? [];
      const issues = s.qs.flatMap((q, k) =>
        q.req && !(a[k] ?? "").trim() ? [`input.answers[${k}]: expected an answer (required)`] : [],
      );
      if (s.rules.length && i.rulesAccepted !== true)
        issues.push("input.rulesAccepted: expected true");
      if (issues.length) throw refuse("BAD_REQUEST", undefined, issues);
      const old = tx.get("request", `${s.id}:${tx.me}`);
      tx.put({
        kind: "request",
        sp: s.id,
        u: tx.me,
        st: "open",
        a,
        why: null,
        createdAt: old ? old.createdAt : tx.now,
        updatedAt: tx.now,
      });
      return null;
    },
  }),

  // Withdraw your own request: it is deleted, whatever its state.
  defineMutator({
    name: "joinRequests.withdraw",
    input: z.strictObject({ space: ulidS }),
    can: (tx, i) => inSpace(tx, i.space, "user"),
    run: (tx, i) => {
      tx.del("request", `${i.space}:${tx.me}`);
      return null;
    },
  }),

  defineMutator({
    name: "joinRequests.decide",
    input: spaces.decideRequestsInputSchema
      .extend({
        space: ulidS,
        users: z.array(handleS).min(1),
        /** Each request's rev as the moderator saw it, by person: one entry
         * for every person in `users` and no other. Required for "approve"
         * and "reopen", which compare it; optional for "decline". */
        base: z.record(handleS, count).optional(),
      })
      .strict()
      .refine((i) => i.decision === "decline" || i.base !== undefined, {
        path: ["base"],
        message: "expected the requests' revs",
      })
      .refine(
        (i) =>
          i.base === undefined ||
          (Object.keys(i.base).length === new Set(i.users).size &&
            i.users.every((u) => Object.hasOwn(i.base ?? {}, u))),
        { path: ["base"], message: "expected one rev for each person in users" },
      ),
    can: (tx, i) => inSpace(tx, i.space, "moderator"),
    run: (tx, i) => {
      let k = 0;
      for (const u of [...new Set(i.users)]) {
        const r = tx.get("request", `${i.space}:${u}`);
        if (!r) throw notFound();
        k++;
        // an approval or a reopening acts on the request as the moderator
        // saw it: its rev, which every write of the request bumps. A decline
        // applies to the request as it is now. Approving or declining needs
        // the request open, reopening needs it declined.
        if (i.decision !== "decline" && r.rev !== i.base?.[u]) throw stale(tx, tx.me, r);
        if (r.st !== (i.decision === "reopen" ? "declined" : "open"))
          throw refuse("PRECONDITION_FAILED", "This request was already decided.");
        if (i.decision === "approve") {
          if (bannedFrom(tx, i.space, u))
            throw refuse("PRECONDITION_FAILED", "This person is banned from the space.");
          tx.put({ ...r, st: "approved", updatedAt: tx.now });
          addMember(tx, i.space, u, "member", tx.id(k));
        } else if (i.decision === "decline") {
          tx.put({ ...r, st: "declined", why: (i.why ?? "").trim(), updatedAt: tx.now });
        } else {
          tx.put({ ...r, st: "open", updatedAt: tx.now });
        }
      }
      refreshSpace(tx, i.space);
      return null;
    },
  }),

  defineMutator({
    name: "members.setRole",
    input: z.strictObject({
      space: ulidS,
      user: handleS,
      role: spaces.spaceMemberRoleSchema,
      /** The member record's rev as the actor saw it (0: no record). */
      base: baseS,
    }),
    can: (tx, i) => {
      const scope = inSpace(tx, i.space, "admin");
      if (i.role === "owner" && roleIn(tx, i.space, tx.me) !== "owner")
        throw refuse("FORBIDDEN", "Only the owner can transfer ownership.");
      actsOn(tx, i.space, i.user);
      if (i.role !== "owner" && RANK[i.role] > rankIn(tx, i.space, tx.me))
        throw refuse("FORBIDDEN", "You can’t give a role higher than your own.");
      return scope;
    },
    run: (tx, i) => {
      const m = tx.get("member", `${i.space}:${i.user}`);
      if ((m?.rev ?? 0) !== i.base.rev)
        throw stale(tx, tx.me, m ?? null, m ? [] : [`member:${i.space}:${i.user}`]);
      if (!m) throw refuse("NOT_FOUND", "This person is not a member of the space.");
      tx.put({ ...m, role: i.role });
      if (i.role === "owner") {
        const me = tx.get("member", `${i.space}:${tx.me}`);
        if (me) tx.put({ ...me, role: "admin" });
      }
      refreshSpace(tx, i.space);
      return null;
    },
  }),

  // `base.adm`: the member's admission id as the moderator saw it. A person
  // who is no longer a member: nothing to remove. Closed spaces only (phase
  // 1a.2): in an open space a removed person joins again at once, so
  // moderators ban there instead (BAD_REQUEST).
  defineMutator({
    name: "members.remove",
    input: z.strictObject({
      space: ulidS,
      user: handleS,
      base: z.strictObject({ adm: z.string().max(64) }),
    }),
    can: (tx, i) => {
      const scope = inSpace(tx, i.space, "moderator");
      if (!isClosed(needSpace(tx, i.space)))
        throw bad("space", "a closed space (in an open space, ban the person instead)");
      actsOn(tx, i.space, i.user);
      return scope;
    },
    run: (tx, i) => {
      const m = tx.get("member", `${i.space}:${i.user}`);
      if (!m) return null;
      if (m.adm !== i.base.adm) throw stale(tx, tx.me, m);
      tx.del("member", `${i.space}:${i.user}`);
      refreshSpace(tx, i.space);
      return null;
    },
  }),

  // A ban applies to the person as they are now, a member or not: it carries
  // no base. It has no duration: it lasts until members.unban.
  defineMutator({
    name: "members.ban",
    input: z.strictObject({ space: ulidS, user: handleS }),
    can: (tx, i) => {
      const scope = inSpace(tx, i.space, "moderator");
      actsOn(tx, i.space, i.user);
      return scope;
    },
    run: (tx, i) => {
      // the ban's id is the mock's (`<space>:<user>`): one ban per person and
      // space, outside the ULID id registry
      if (tx.get("member", `${i.space}:${i.user}`)) tx.del("member", `${i.space}:${i.user}`);
      if (!tx.get("ban", `${i.space}:${i.user}`))
        tx.put({
          kind: "ban",
          id: `${i.space}:${i.user}`,
          sp: i.space,
          u: i.user,
          createdAt: tx.now,
        });
      refreshSpace(tx, i.space);
      return null;
    },
  }),

  defineMutator({
    name: "members.unban",
    input: z.strictObject({ space: ulidS, user: handleS }),
    can: (tx, i) => inSpace(tx, i.space, "moderator"),
    run: (tx, i) => {
      if (!tx.get("ban", `${i.space}:${i.user}`))
        throw refuse("NOT_FOUND", "This person is not banned from the space.");
      tx.del("ban", `${i.space}:${i.user}`);
      return null;
    },
  }),

  // -- invite links
  // `days` is bounded in the schema: an input that passes the schema never
  // makes `run` throw (review round 1, R8). The code is made in `pre`, on the
  // server, from its random source; the mock takes it from the id, which the
  // client now chooses.
  defineMutator({
    name: "invites.create",
    input: z.strictObject({
      id: ulidS,
      space: ulidS,
      days: count.max(INVITE_MAX_DAYS).nullable().optional(),
    }),
    ids: (i) => [i.id],
    can: (tx, i) => {
      const scope = inSpace(tx, i.space, "member");
      if (!mayInvite(tx, needSpace(tx, i.space), tx.me)) throw refuse("FORBIDDEN");
      return scope;
    },
    pre: (ctx) => {
      for (;;) {
        let code = "";
        for (let k = 0; k < 10; k++) code += CODE_CHARS.charAt(Math.floor(ctx.random() * 32) % 32);
        if (!ctx.tx.scan("invite.code", code).length) return { code };
      }
    },
    run: (tx, i, v) => {
      const code = v["code"];
      if (code === undefined) throw refuse("INTERNAL_SERVER_ERROR");
      tx.create({
        kind: "invite",
        id: i.id,
        code,
        by: tx.me,
        sp: i.space,
        expiresAt: i.days ? isoAt(tx.nowMs + i.days * DAY) : null,
        dead: null,
        usedBy: null,
        revokedAt: null,
        createdAt: tx.now,
      });
      return { id: i.id, code };
    },
  }),

  // Revoke a link you made, or one in a space you moderate. People who joined
  // with it stay members. The link stays stored for invites.restore.
  defineMutator({
    name: "invites.revoke",
    input: z.strictObject({ id: ulidS }),
    can: (tx, i) => linkScope(tx, i.id),
    run: (tx, i) => {
      const l = readable(tx, "invite", i.id);
      if (l.revokedAt !== null) throw refuse("NOT_FOUND", "This invite link was already revoked.");
      tx.put({ ...l, revokedAt: tx.now });
      return null;
    },
  }),

  defineMutator({
    name: "invites.restore",
    input: z.strictObject({ id: ulidS }),
    can: (tx, i) => linkScope(tx, i.id),
    run: (tx, i) => {
      const l = readable(tx, "invite", i.id);
      if (l.revokedAt === null) throw refuse("NOT_FOUND", "This invite link is not revoked.");
      tx.put({ ...l, revokedAt: null });
      return null;
    },
  }),

  // Ask the members of an invite-only space for an invite.
  defineMutator({
    name: "invites.request",
    input: z.strictObject({ space: ulidS }),
    can: (tx, i) => inSpace(tx, i.space, "user"),
    run: (tx, i) => {
      if (!tx.get("invask", `${tx.me}:${i.space}`))
        tx.put({ kind: "invask", u: tx.me, sp: i.space, createdAt: tx.now });
      return null;
    },
  }),

  // Decline an invite (one of your notifications); its sender is not told.
  defineMutator({
    name: "invites.decline",
    input: z.strictObject({ notification: ulidS }),
    can: () => personal(),
    run: (tx, i) => {
      const n = readable(tx, "notif", i.notification);
      tx.put({ ...n, read: true, response: "declined" });
      return null;
    },
  }),
];

/** A link the actor may revoke or restore: one they made, or one in a space
 * they moderate. */
function linkScope(tx: Parameters<typeof inSpace>[0], id: string) {
  const l = readable(tx, "invite", id);
  const scope = inSpace(tx, l.sp, "member");
  if (!isModOf(tx, l.sp, tx.me) && l.by !== tx.me)
    throw refuse(
      "FORBIDDEN",
      "Only the person who made this link and the space’s moderators can change it.",
    );
  return scope;
}
