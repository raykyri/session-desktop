// Associates browser draft state with the authenticated account that authored it
// (`lib/localOwner.ts`), including composer drafts, unsubmitted branches, and
// per-thread local state.
//
// - Route guards associate state with the authenticated session before initial
//   render. State belonging to a different account or unauthenticated state is
//   cleared so it is not accessible across sessions or to guests.
// - Explicit sign-out clears local state. An unauthenticated tab (such as one
//   with an expired session or on the sign-in page) preserves storage under the
//   prior account key without rendering or writing it; re-authenticating as the
//   same account restores access, whereas authenticating as a different account
//   discards it.
// - When another tab switches accounts, the current tab discards in-memory state without
//   persisting and reloads to synchronize with the new session.

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

import { claimDrafts, hideDrafts, resetDrafts } from "./drafts.js";

/** Associates local account state with `userId` (null if signed out). */
export function claimLocalAccountState(userId: LocalOwner): void {
  if (userId === null) {
    hideLocalAccountState();
    return;
  }
  const previous = localStateOwner();
  setLocalStateOwner(userId);
  if (storedLocalOwner() !== userId) {
    dropThreadNavigation(true);
    writeLocalOwner(userId);
  } else if (previous === null) {
    // The session was unauthenticated with no active state in memory; reload the
    // account's stored state.
    dropThreadNavigation(false);
  }
  claimDrafts(userId);
}

/**
 * Handles unauthenticated state when no explicit sign-out occurred (for example,
 * an expired session or initial load with no session). Stored state remains
 * associated with its account; the current tab neither renders nor writes it
 * (`ownsLocalState` is false when unauthenticated while another account is recorded).
 */
export function hideLocalAccountState(): void {
  setLocalStateOwner(null);
  hideDrafts();
  dropThreadNavigation(false);
}

/** Clears all stored state associated with the local account on sign-out. */
export function clearLocalAccountState(): void {
  setLocalStateOwner(null);
  resetDrafts(null);
  dropThreadNavigation(true);
  writeLocalOwner(null);
}

/**
 * Handles account change notifications from another tab. When `raw` does not
 * match the current tab's active owner, local drafts and in-memory thread state
 * are discarded without writing to storage, and the page reloads using the updated session.
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
