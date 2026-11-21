// Binds this tab's account-scoped local state to the signed-in account
// (02 §9.4): the composer drafts, `threadUi` (selections and open
// composers) and the sync client's stored `{clientId, userId}` (§9.2,
// `replica/tabClient.ts`).
//
// - A route guard calls `claimLocalAccountState` with the session's user id
//   before the first render: another account's drafts are dropped.
// - Without a session the drafts stay stored but unreadable, so signing in
//   again as the same account restores them.
// - Sign-out clears them and the stored client id.

import { forgetTabClientId } from "../replica/tabClient.js";

import { claimDrafts, hideDrafts, resetDrafts } from "./drafts.js";
import { useThreadUiStore } from "./threadUi.js";

let claimed: string | null | undefined;

/** Binds local state to `userId`, or hides it when there is no session. A
 * change of account drops `threadUi`. */
export function claimLocalAccountState(userId: string | null): void {
  if (claimed !== undefined && claimed !== userId) useThreadUiStore.getState().reset();
  claimed = userId;
  if (userId === null) {
    hideDrafts();
    return;
  }
  claimDrafts(userId);
}

/** Clears all local state of the account on sign-out. */
export function clearLocalAccountState(): void {
  resetDrafts(null);
  forgetTabClientId();
  useThreadUiStore.getState().reset();
}
