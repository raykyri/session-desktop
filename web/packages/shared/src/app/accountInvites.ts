// Account invite counts and their copy (plan `04` I2). Each member gets a
// lifetime number of invites (`SESSION_INVITES_PER_MEMBER` plus what site
// admins gave them); the server refuses a link at 0 left with
// `inviteLimitMessage`, and the Invites page and Site Admin show the same
// strings.

/** Most invites one grant gives (`admin.invites.grant`, `db:admin --
 * --grant-invites`). */
export const INVITE_GRANT_MAX = 100;

/** "1 invite", "3 invites". */
export function invitesCount(count: number): string {
  return `${count} ${count === 1 ? "invite" : "invites"}`;
}

/** The refusal of `accountInvites.create` at 0 left, and the line the
 * Invites page shows in place of the create button. */
export function inviteLimitMessage(total: number): string {
  return `You have used your ${invitesCount(total)}. An admin can give you more.`;
}

/** A member's invites as Site Admin shows them after a lookup:
 * "@mira_k: 2 of 3 invites left (1 used)". */
export function inviteAllowanceLine(input: {
  handle: string;
  total: number;
  used: number;
  left: number;
}): string {
  const noun = input.total === 1 ? "invite" : "invites";
  return `@${input.handle}: ${input.left} of ${input.total} ${noun} left (${input.used} used)`;
}

/** The toast after a grant: "Gave @mira_k 2 more invites." */
export function inviteGrantToast(handle: string, count: number): string {
  return `Gave @${handle} ${count} more ${count === 1 ? "invite" : "invites"}.`;
}
