// Keeps the unsent text this browser holds with the account that wrote it
// (`lib/localOwner.ts`): the composer drafts and the thread pages' unsent
// branches, with the rest of the per-thread state stored beside them.
//
// - The route guards claim the state for the session they find, before
//   anything renders: another account's state, or state stored without an
//   account, is dropped, so neither a reload, a sign-in after an expired
//   session nor a guest finds it.
// - Sign-out and an expired session drop it.
// - When another tab records a different account, this tab drops what it
//   holds without writing it and reloads, because its requests now go out
//   with that tab's session.

import { dropThreadNavigation } from "../features/thread/persistence.js";
import {
  LOCAL_OWNER_KEY,
  localStateOwner,
  parseLocalOwner,
  setLocalStateOwner,
  storedLocalOwner,
  writeLocalOwner,
  type LocalOwner,
} from "../lib/localOwner.js";

import { claimDrafts, resetDrafts } from "./drafts.js";

/** The session is `userId`'s (null: signed out). */
export function claimLocalAccountState(userId: LocalOwner): void {
  setLocalStateOwner(userId);
  if (storedLocalOwner() !== userId) {
    dropThreadNavigation(true);
    writeLocalOwner(userId);
  }
  claimDrafts(userId);
}

/** Sign-out or an expired session: nothing of the account stays. */
export function clearLocalAccountState(): void {
  setLocalStateOwner(null);
  resetDrafts(null);
  dropThreadNavigation(true);
  writeLocalOwner(null);
}

/**
 * Another tab recorded `raw` as the account. When that is not this tab's, the
 * drafts and thread state this tab holds are dropped unwritten (the other tab
 * already dropped the shared copies) and the page reloads for the session it
 * now has.
 */
export function onLocalOwnerChanged(
  raw: string | null,
  reload: () => void = () => window.location.reload(),
): void {
  const owner = localStateOwner();
  const next = parseLocalOwner(raw);
  if (owner === undefined || next === undefined || next === owner) return;
  resetDrafts(owner);
  dropThreadNavigation(false);
  reload();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === LOCAL_OWNER_KEY) onLocalOwnerChanged(event.newValue);
  });
}
