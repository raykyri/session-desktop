// Which window sends a thread's queued follow-ups. The queues are stored in
// localStorage (researchNavigation.ts) and every window with the thread open
// reads them, so without an election each window would send the same item.
// A window claims a per-tree lease (its window id and an expiry) while the
// thread is open and renews it; only the holder sends. A lease that is not
// renewed expires, so a closed or stalled window hands the queue over.
// localStorage has no compare-and-set: a window that writes a claim confirms
// it on its next evaluation, after the other window's write (if any) has
// arrived, and the last write wins.

export const RESEARCH_QUEUE_LEASE_KEY = "session.research-queue-dispatch.v1";
/** How long a lease lasts without renewal. */
export const RESEARCH_QUEUE_LEASE_MS = 10_000;
/** How often the holder renews (and a waiting window checks) the lease. */
export const RESEARCH_QUEUE_LEASE_RENEW_MS = 3_000;
/** How long after writing a claim a window checks that it stood. */
export const RESEARCH_QUEUE_CLAIM_CONFIRM_MS = 250;

interface ResearchQueueLease {
  windowId: string;
  expiresAt: number;
}

export type ResearchQueueLeases = Record<string, ResearchQueueLease>;

/** This page's id: a reload is a new window. */
const RESEARCH_WINDOW_ID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `window-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** The well-formed, unexpired leases in a stored value. */
export function parseResearchQueueLeases(raw: string | null, now: number): ResearchQueueLeases {
  try {
    const parsed = JSON.parse(raw ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([treeId, value]) => {
        const lease = value as Partial<ResearchQueueLease> | null;
        return lease &&
          typeof lease.windowId === "string" &&
          typeof lease.expiresAt === "number" &&
          lease.expiresAt > now
          ? [[treeId, { windowId: lease.windowId, expiresAt: lease.expiresAt }]]
          : [];
      }),
    );
  } catch {
    return {};
  }
}

/** One evaluation of `windowId`'s claim on `treeId`'s queue:
 * - another window holds an unexpired lease: do not send, write nothing;
 * - this window holds it: send, and write the renewed lease;
 * - nobody holds it: write a claim, but do not send until the next
 *   evaluation (`confirm`) finds the claim still standing. */
export function researchQueueLeaseStep(
  leases: ResearchQueueLeases,
  treeId: string,
  windowId: string,
  now: number,
): { dispatch: boolean; confirm: boolean; leases: ResearchQueueLeases | null } {
  const lease = leases[treeId];
  if (lease && lease.expiresAt > now && lease.windowId !== windowId) {
    return { dispatch: false, confirm: false, leases: null };
  }
  const held = lease !== undefined && lease.expiresAt > now;
  return {
    dispatch: held,
    confirm: !held,
    leases: { ...leases, [treeId]: { windowId, expiresAt: now + RESEARCH_QUEUE_LEASE_MS } },
  };
}

/** The leases without `windowId`'s lease on `treeId`, or null when it
 * holds none. */
export function releaseResearchQueueLease(
  leases: ResearchQueueLeases,
  treeId: string,
  windowId: string,
): ResearchQueueLeases | null {
  if (leases[treeId]?.windowId !== windowId) return null;
  const { [treeId]: _released, ...rest } = leases;
  return rest;
}

/** Evaluates this window's claim on `treeId` against storage; see
 * researchQueueLeaseStep. Without storage there is nothing to share and
 * the window sends on its own. */
export function claimResearchQueue(
  treeId: string,
  now = Date.now(),
): { dispatch: boolean; confirm: boolean } {
  try {
    const leases = parseResearchQueueLeases(localStorage.getItem(RESEARCH_QUEUE_LEASE_KEY), now);
    const step = researchQueueLeaseStep(leases, treeId, RESEARCH_WINDOW_ID, now);
    if (step.leases) localStorage.setItem(RESEARCH_QUEUE_LEASE_KEY, JSON.stringify(step.leases));
    return { dispatch: step.dispatch, confirm: step.confirm };
  } catch {
    return { dispatch: true, confirm: false };
  }
}

/** Gives up this window's lease on `treeId`, so another window with the
 * thread open takes over without waiting for the expiry. */
export function releaseResearchQueue(treeId: string, now = Date.now()): void {
  try {
    const leases = parseResearchQueueLeases(localStorage.getItem(RESEARCH_QUEUE_LEASE_KEY), now);
    const next = releaseResearchQueueLease(leases, treeId, RESEARCH_WINDOW_ID);
    if (next) localStorage.setItem(RESEARCH_QUEUE_LEASE_KEY, JSON.stringify(next));
  } catch {
    // The lease expires.
  }
}
