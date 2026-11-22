// `admin.invites.*` (plan `04` I2; `02` W8.2): a site admin looks up a
// member's account invites by handle and gives them more. Online-only
// (ADR-19), in the same per-admin bucket as `admin.models.*` (`04` Z1).
// `db:admin -- --grant-invites <handle> <n>` is the operator's equivalent.

import { accountInvites, users } from "@session/db";
import { INVITE_GRANT_MAX, isAccountHandle } from "@session/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { AppContext } from "../base.js";
import { router } from "../base.js";

import { adminModelsProcedure } from "./models.js";

export interface InviteLookup {
  handle: string;
  displayName: string | null;
  /** `SESSION_INVITES_PER_MEMBER` plus `extra`. */
  total: number;
  used: number;
  open: number;
  left: number;
  /** Invites site admins gave the member (`user_limits.extra_invites`). */
  extra: number;
}

const NOT_FOUND = "No account with that handle.";

const handleInput = z.object({ handle: z.string().max(64) });

/** The active, not deleted account a typed handle names ("@mira_k" or
 * "mira_k"), or NOT_FOUND. */
function memberOf(ctx: AppContext, typed: string) {
  const handle = typed.trim().replace(/^@/, "").toLowerCase();
  const user = isAccountHandle(handle) ? users.findActiveByHandle(ctx.db, handle) : null;
  if (user === null || user.handle === null) {
    throw new TRPCError({ code: "NOT_FOUND", message: NOT_FOUND });
  }
  return { id: user.id, handle: user.handle, displayName: user.displayName };
}

function lookupOf(
  member: { handle: string; displayName: string | null },
  counts: accountInvites.InviteAllowance,
): InviteLookup {
  return { handle: member.handle, displayName: member.displayName, ...counts };
}

export const adminInvitesRouter = router({
  lookup: adminModelsProcedure.input(handleInput).query(({ ctx, input }): InviteLookup => {
    const member = memberOf(ctx, input.handle);
    return lookupOf(
      member,
      accountInvites.allowance(ctx.db, member.id, ctx.config.abuse.invitesPerMember),
    );
  }),

  /** Adds `count` (1 to 100) to the member's extra invites; answers the new
   * lookup. */
  grant: adminModelsProcedure
    .input(handleInput.extend({ count: z.number().int().min(1).max(INVITE_GRANT_MAX) }))
    .mutation(({ ctx, input }): InviteLookup => {
      const member = memberOf(ctx, input.handle);
      const counts = accountInvites.grant(
        ctx.db,
        member.id,
        input.count,
        ctx.config.abuse.invitesPerMember,
      );
      ctx.logger.info(
        { adminId: ctx.user.id, userId: member.id, count: input.count },
        "invites granted",
      );
      return lookupOf(member, counts);
    }),
});
