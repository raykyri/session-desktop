// The account that the unsent text kept in this browser belongs to: the
// composer drafts (`stores/drafts.ts`) and the thread pages' unsent branches
// (`features/thread/persistence.ts`). localStorage is shared by every tab, so
// the account is recorded there (`session.local-owner.v1`); each tab also
// remembers the account it rendered for. A tab whose account no longer
// matches the recorded one (another tab signed out or signed in as someone
// else) stops writing that state. `stores/localAccount.ts` does the claiming
// and clearing.

export const LOCAL_OWNER_KEY = "session.local-owner.v1";

/** A user id, or null for a signed-out tab. */
export type LocalOwner = string | null;

/** The account this tab rendered for; undefined until the session is known. */
let tabOwner: LocalOwner | undefined;

/** The recorded account in a stored value; undefined when nothing readable
 * is recorded. */
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
    // Storage unavailable: nothing else persists either.
  }
}

export function localStateOwner(): LocalOwner | undefined {
  return tabOwner;
}

export function setLocalStateOwner(owner: LocalOwner | undefined): void {
  tabOwner = owner;
}

/**
 * Whether this tab may write the per-account state it holds: false once the
 * recorded account differs from the one this tab rendered for. True before
 * the tab knows its account, when nothing is recorded and when storage is
 * unreadable, as there is then no other account to protect.
 */
export function ownsLocalState(): boolean {
  if (tabOwner === undefined) return true;
  const stored = storedLocalOwner();
  return stored === undefined || stored === tabOwner;
}
