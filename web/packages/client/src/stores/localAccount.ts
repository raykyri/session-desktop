// Binds this tab's account-scoped local state to the signed-in account
// (02 §9.4). Today that state is the composer drafts; the sync client's
// stored `{clientId, userId}` and `threadUi` join it with the replica (§9.2).
//
// - A route guard calls `claimLocalAccountState` with the session's user id
//   before the first render: another account's drafts are dropped.
// - Without a session the drafts stay stored but unreadable, so signing in
//   again as the same account restores them.
// - Sign-out clears them.

import { claimDrafts, hideDrafts, resetDrafts } from "./drafts.js";

/** Binds local state to `userId`, or hides it when there is no session. */
export function claimLocalAccountState(userId: string | null): void {
  if (userId === null) {
    hideDrafts();
    return;
  }
  claimDrafts(userId);
}

/** Clears all local state of the account on sign-out. */
export function clearLocalAccountState(): void {
  resetDrafts(null);
}
