// Account invites, the profile step and the invite tree: online-only tRPC
// (plan `04` I2-I4, `01` C8, §6). None of it is replicated.
//
// - `auth.checkInvite` (public, a mutation so the code is in a POST body):
//   `open` with the inviter, or one `unusable` answer for used, revoked,
//   unknown and malformed codes, byte for byte the same.
// - `accountInvites.redeem` (waiting accounts): the same check, and an open
//   code is remembered for the profile step.
// - `account.checkHandle`, `account.create` (waiting accounts with a pending
//   invite): the profile step, which redeems the invite and activates the
//   account in one transaction.
// - `accountInvites.list | create | revoke`, `members.tree`: active accounts.
//
// Limits (04 Z1): the check, redeem and create calls share the `/auth/*`
// per-IP bucket and count failed checks per IP and per user; list and tree
// are 60 a minute per user; handle checks 30; creates 3 open and 10 a day.

import { accountInvites, users } from "@session/db";
import type { Inviter, InviteCheck, Me } from "@session/shared";
import { accountInviteLink, cleanDisplayName, isAccountHandle } from "@session/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { open, seal } from "../../auth/secretBox.js";
import { abuseBuckets } from "../../middleware/rateLimit.js";
import type { AppContext } from "../base.js";
import {
  limit,
  memberProcedure,
  protectedProcedure,
  publicProcedure,
  router,
  tooManyRequests,
} from "../base.js";

/** Additional data of a sealed code: the creator's id, so a value cannot be
 * moved to another account's row and decrypt. */
const codeContext = (userId: string) => `account-invite:${userId}`;

const codeInput = z.object({ code: z.string().max(512) });

/** The `auth.me` answer: the account and its pending invite. */
export function meOf(ctx: Pick<AppContext, "db" | "user">): Me | null {
  if (ctx.user === null) return null;
  return {
    ...ctx.user,
    pendingInvite:
      ctx.user.status === "waiting" ? accountInvites.pendingInviter(ctx.db, ctx.user.id) : null,
  };
}

/** Refuses before the check when this IP key or account has used up its
 * failed checks for the hour. */
function guardFailedChecks(ctx: AppContext): void {
  const spec = abuseBuckets(ctx.config.abuse).failedChecks;
  const keys = [`failedChecks:ip:${ctx.ipKey}`];
  if (ctx.user) keys.push(`failedChecks:user:${ctx.user.id}`);
  const spent = keys.find((key) => !ctx.limiter.has(key, spec));
  if (spent !== undefined) {
    // Taken from an empty bucket: refused, and counted for the metric.
    ctx.limiter.take(spent, spec);
    throw tooManyRequests();
  }
}

/** Counts a failed check against the IP key and the account. */
function countFailedCheck(ctx: AppContext): void {
  const spec = abuseBuckets(ctx.config.abuse).failedChecks;
  ctx.limiter.take(`failedChecks:ip:${ctx.ipKey}`, spec);
  if (ctx.user) ctx.limiter.take(`failedChecks:user:${ctx.user.id}`, spec);
}

/** The one answer for a code that does not work; a constant so every
 * failure serializes to the same bytes. */
const UNUSABLE: InviteCheck = Object.freeze({ status: "unusable" });

function answer(ctx: AppContext, check: InviteCheck): InviteCheck {
  if (check.status === "open") return check;
  countFailedCheck(ctx);
  return UNUSABLE;
}

/** Shared by the three calls of the `/auth/*` bucket. */
const authBucket = limit("auth", "ip");

export const checkInviteProcedure = publicProcedure
  .use(authBucket)
  .input(codeInput)
  .mutation(({ ctx, input }): InviteCheck => {
    guardFailedChecks(ctx);
    return answer(ctx, accountInvites.checkCode(ctx.db, input.code));
  });

const requireWaiting = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.status !== "waiting") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Your account is already active.",
    });
  }
  return next();
});

export interface InviteLinkView {
  id: string;
  state: "open" | "used" | "revoked";
  createdAt: number;
  usedAt: number | null;
  /** The code of an open link, for its creator only; null once used or
   * revoked, or if `SESSION_SECRET_KEY` changed since it was made. */
  code: string | null;
  link: string | null;
  usedBy: { handle: string | null; displayName: string | null } | null;
}

export interface InvitedMember {
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  joinedAt: number;
}

export interface InvitesView {
  links: InviteLinkView[];
  invited: InvitedMember[];
  openCount: number;
  /** Open links allowed at once; null for site admins, who are exempt. */
  openLimit: number | null;
}

export interface TreeMember {
  id: string;
  /** Null for a deleted account ("Deleted account"). */
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
  invitedBy: string | null;
  joinedAt: number;
  staff: "admin" | null;
}

export const accountInvitesRouter = router({
  list: memberProcedure.use(limit("inviteReads", "user")).query(({ ctx }): InvitesView => {
    const links = accountInvites.listForCreator(ctx.db, ctx.user.id).map((link) => {
      const code =
        link.codeEnc === null
          ? null
          : open(ctx.config.secretKey, link.codeEnc, codeContext(ctx.user.id));
      return {
        id: link.id,
        state: link.state,
        createdAt: link.createdAt,
        usedAt: link.usedAt,
        code,
        link: code === null ? null : accountInviteLink(ctx.config.publicOrigin, code),
        usedBy: link.usedBy,
      };
    });
    return {
      links,
      invited: accountInvites.invitedBy(ctx.db, ctx.user.id).map(({ user, joinedAt }) => ({
        handle: user.handle,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl ?? null,
        joinedAt,
      })),
      openCount: links.filter((link) => link.state === "open").length,
      openLimit: ctx.user.isAdmin ? null : ctx.config.abuse.openInvites,
    };
  }),

  create: memberProcedure.mutation(({ ctx }) => {
    // 10 created a day (04 Z1): counted when a link is made, so a create
    // refused at 3 open does not use up the day.
    const daily = abuseBuckets(ctx.config.abuse).invitesCreated;
    const dailyKey = `invitesCreated:user:${ctx.user.id}`;
    // `take` on the refusal path records it for `session_rate_limited_total`.
    if (!ctx.limiter.has(dailyKey, daily) && !ctx.limiter.take(dailyKey, daily).allowed) {
      throw tooManyRequests();
    }
    const made = accountInvites.create(ctx.db, {
      createdBy: ctx.user.id,
      exempt: ctx.user.isAdmin,
      openLimit: ctx.config.abuse.openInvites,
      encrypt: (code) => seal(ctx.config.secretKey, code, codeContext(ctx.user.id)),
    });
    if (!made.ok) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `You have ${ctx.config.abuse.openInvites} open invites. One frees when it is used or revoked.`,
      });
    }
    ctx.limiter.take(dailyKey, daily);
    ctx.logger.info({ userId: ctx.user.id, inviteId: made.id }, "account invite created");
    return {
      id: made.id,
      code: made.code,
      link: accountInviteLink(ctx.config.publicOrigin, made.code),
    };
  }),

  revoke: memberProcedure.input(z.object({ id: z.string().max(64) })).mutation(({ ctx, input }) => {
    if (!accountInvites.revoke(ctx.db, ctx.user.id, input.id)) {
      throw new TRPCError({ code: "NOT_FOUND", message: "This invite link is not open." });
    }
    return { ok: true };
  }),

  /** A waiting account enters a code (the "Invite required" page). */
  redeem: requireWaiting
    .use(authBucket)
    .input(codeInput)
    .mutation(({ ctx, input }): InviteCheck => {
      guardFailedChecks(ctx);
      return answer(ctx, accountInvites.setPendingInvite(ctx.db, ctx.user.id, input.code));
    }),
});

export const accountRouter = router({
  /** Whether a handle can be taken at the profile step. */
  checkHandle: protectedProcedure
    .use(limit("handleChecks", "user"))
    .input(z.object({ handle: z.string().max(64) }))
    .query(({ ctx, input }) => ({
      valid: isAccountHandle(input.handle),
      available: users.handleAvailable(ctx.db, input.handle),
    })),

  /**
   * The profile step: redeems the pending invite and makes the account
   * active with its name and handle, in one transaction (04 I4).
   */
  create: requireWaiting
    .use(authBucket)
    .input(z.object({ name: z.string().max(200), handle: z.string().max(64) }))
    .mutation(({ ctx, input }): { me: Me; inviter: Inviter } => {
      if (cleanDisplayName(input.name) === "") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Enter a name." });
      }
      if (!isAccountHandle(input.handle)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Handles use 3 to 20 lowercase letters, numbers, dots or underscores.",
        });
      }
      const result = accountInvites.activate(ctx.db, {
        userId: ctx.user.id,
        handle: input.handle,
        displayName: input.name,
        // The `invite_used` notification (01 C16) is written here, in the
        // redemption's transaction, once the user log exists (M6
        // notifications; `@session/sync` server).
      });
      if (!result.ok) {
        if (result.reason === "taken") {
          throw new TRPCError({
            code: "CONFLICT",
            message: `@${input.handle} is taken. Try another.`,
          });
        }
        if (result.reason === "unusable") {
          countFailedCheck(ctx);
          throw new TRPCError({
            code: "CONFLICT",
            message: "This invite code doesn't work. Ask the person who invited you for a new one.",
          });
        }
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Your account is already active.",
        });
      }
      ctx.logger.info({ userId: result.user.id, inviteId: result.inviteId }, "account activated");
      return { me: { ...result.user, pendingInvite: null }, inviter: result.inviter };
    }),
});

export const membersRouter = router({
  /** The invite tree (04 I3): active members see it whole. */
  tree: memberProcedure.use(limit("inviteReads", "user")).query(({ ctx }): TreeMember[] =>
    accountInvites.tree(ctx.db).map((node) => ({
      id: node.id,
      handle: node.handle,
      displayName: node.displayName,
      avatar: node.avatarUrl,
      invitedBy: node.invitedBy,
      joinedAt: node.joinedAt,
      staff: node.staff,
    })),
  ),
});
