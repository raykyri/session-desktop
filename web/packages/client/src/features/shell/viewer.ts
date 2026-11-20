// Who is looking at the shell (02 §2.2): signed out, signed in without an
// invite (a waiting account, 04 §3), or a member, who may also be a site
// admin. The app bar, the account menu and the route guards branch on this.
//
// The account's status comes from the user record of the user log once the
// replica lands (02 §9.1 `useMe`). Until then it is read from `auth.me`:
// an account the current server knows is active, unless the record says
// `status: "waiting"`.

import type { User } from "@session/shared";

export type Viewer =
  | { kind: "signedOut" }
  | { kind: "waiting"; user: User }
  | { kind: "member"; user: User; isAdmin: boolean };

export function viewerOf(user: User | null | undefined): Viewer {
  if (!user) return { kind: "signedOut" };
  const status = (user as User & { status?: unknown }).status;
  if (status === "waiting") return { kind: "waiting", user };
  return { kind: "member", user, isAdmin: user.isAdmin };
}

/** A member can write: ask, post, reply, join and make channels. */
export function canWrite(viewer: Viewer): viewer is Extract<Viewer, { kind: "member" }> {
  return viewer.kind === "member";
}

/** The account menu's header line under the name (`appbar`, the mock's
 * "@handle · Member"). */
export function accountLine(viewer: Exclude<Viewer, { kind: "signedOut" }>): string {
  const handle = `@${viewer.user.login}`;
  if (viewer.kind === "waiting") return `${handle} · No invite yet`;
  return `${handle} · ${viewer.isAdmin ? "Admin" : "Member"}`;
}
