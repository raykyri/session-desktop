// Manages local account ownership for unpersisted user text in localStorage,
// specifically composer drafts (`stores/drafts.ts`) and unsent thread branches
// (`features/thread/persistence.ts`). Because localStorage is shared across browser tabs,
// the active account ID is recorded under `session.local-owner.v1`. Each tab tracks the
// user identity it rendered with. If a tab's user identity mismatches the stored identity
// (for example, following sign-out or account switching in another tab), the tab ceases writing
// local state to prevent data leakage. Account claiming and clearing are handled in
// `stores/localAccount.ts`.

export const LOCAL_OWNER_KEY = "session.local-owner.v1";

/** User ID of the local state owner, or null for unauthenticated sessions. */
export type LocalOwner = string | null;

/** Active account identity associated with this tab; undefined prior to session initialization. */
let tabOwner: LocalOwner | undefined;

/** Parses the owner user ID from serialized storage; returns undefined if unreadable or absent. */
export function parseLocalOwner(raw: string | null): LocalOwner | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as { userId?: unknown } | null;
    const userId = parsed?.userId;
    return typeof userId === "string" || userId === null ? userId : undefined;
  } catch {
    return undefined;
  }
}

export function storedLocalOwner(): LocalOwner | undefined {
  try {
    return parseLocalOwner(localStorage.getItem(LOCAL_OWNER_KEY));
  } catch {
    return undefined;
  }
}

export function writeLocalOwner(owner: LocalOwner): void {
  try {
    localStorage.setItem(LOCAL_OWNER_KEY, JSON.stringify({ userId: owner }));
  } catch {
    // Storage unavailable; local state persistence is disabled.
  }
}

export function localStateOwner(): LocalOwner | undefined {
  return tabOwner;
}

export function setLocalStateOwner(owner: LocalOwner | undefined): void {
  tabOwner = owner;
}

/**
 * Determines whether this tab may write account-scoped local state. Returns false if the
 * recorded account differs from this tab's rendered account. Returns true prior to session
 * resolution, when no owner is stored, or when localStorage is inaccessible.
 */
export function ownsLocalState(): boolean {
  if (tabOwner === undefined) return true;
  const stored = storedLocalOwner();
  return stored === undefined || stored === tabOwner;
}
