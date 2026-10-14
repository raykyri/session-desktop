import assert from "node:assert/strict";
import test from "node:test";
import {
  RESEARCH_QUEUE_LEASE_MS,
  parseResearchQueueLeases,
  releaseResearchQueueLease,
  researchQueueLeaseStep,
  type ResearchQueueLeases,
} from "../src/lib/researchQueueDispatch";
import { syncResearchQueuedFollowups, type SavedResearchNavigation } from "../src/lib/researchNavigation";

/** Windows sharing one stored value, as localStorage is shared. */
function windows() {
  let stored: string | null = null;
  return {
    stored: () => stored,
    /** One evaluation by `windowId`; returns whether it may send. */
    evaluate(windowId: string, treeId: string, now: number) {
      const step = researchQueueLeaseStep(parseResearchQueueLeases(stored, now), treeId, windowId, now);
      if (step.leases) stored = JSON.stringify(step.leases);
      return step;
    },
    release(windowId: string, treeId: string, now: number) {
      const next = releaseResearchQueueLease(parseResearchQueueLeases(stored, now), treeId, windowId);
      if (next) stored = JSON.stringify(next);
    },
  };
}

test("one window sends a tree's queue: the first to claim it, after confirming", () => {
  const shared = windows();
  // A claims the free lease but sends only once a later evaluation finds the
  // claim standing.
  assert.deepEqual(
    { ...shared.evaluate("a", "tree", 0), leases: undefined },
    { dispatch: false, confirm: true, leases: undefined },
  );
  // B, with the same thread open, finds A's lease and does not send.
  assert.equal(shared.evaluate("b", "tree", 100).dispatch, false);
  assert.equal(shared.evaluate("a", "tree", 250).dispatch, true);
  assert.equal(shared.evaluate("b", "tree", 3_000).dispatch, false);
  // Another tree has its own lease.
  shared.evaluate("b", "other", 3_000);
  assert.equal(shared.evaluate("b", "other", 3_250).dispatch, true);
  assert.equal(shared.evaluate("a", "tree", 3_250).dispatch, true);
});

test("when two windows claim at once, the last write wins", () => {
  const shared = windows();
  assert.equal(shared.evaluate("a", "tree", 0).confirm, true);
  // B read the value before A's write arrived and claims too.
  const leases: ResearchQueueLeases = {};
  const b = researchQueueLeaseStep(leases, "tree", "b", 0);
  assert.equal(b.confirm, true);
  // B's write lands last.
  const stored = JSON.stringify(b.leases);
  const aConfirm = researchQueueLeaseStep(parseResearchQueueLeases(stored, 250), "tree", "a", 250);
  const bConfirm = researchQueueLeaseStep(parseResearchQueueLeases(stored, 250), "tree", "b", 250);
  assert.equal(aConfirm.dispatch, false);
  assert.equal(aConfirm.leases, null, "the losing window writes nothing");
  assert.equal(bConfirm.dispatch, true);
});

test("renewal keeps the lease; a released or expired lease passes to another window", () => {
  const shared = windows();
  shared.evaluate("a", "tree", 0);
  shared.evaluate("a", "tree", 250);
  // Renewed every few seconds, A keeps it past the first expiry.
  for (let now = 3_000; now <= 30_000; now += 3_000) {
    assert.equal(shared.evaluate("a", "tree", now).dispatch, true);
    assert.equal(shared.evaluate("b", "tree", now + 1).dispatch, false);
  }
  // A closes the thread and releases: B claims at once.
  shared.release("a", "tree", 31_000);
  assert.equal(shared.evaluate("b", "tree", 31_000).confirm, true);
  assert.equal(shared.evaluate("b", "tree", 31_250).dispatch, true);
  // B stops renewing (its window closed without releasing): once the lease
  // expires, A takes over.
  const expired = 31_250 + RESEARCH_QUEUE_LEASE_MS;
  assert.equal(shared.evaluate("a", "tree", expired - 1).dispatch, false);
  assert.equal(shared.evaluate("a", "tree", expired).confirm, true);
  assert.equal(shared.evaluate("a", "tree", expired + 250).dispatch, true);
  // Releasing a lease another window holds changes nothing.
  assert.equal(releaseResearchQueueLease(parseResearchQueueLeases(shared.stored(), expired), "tree", "b"), null);
});

test("malformed or expired stored leases are ignored", () => {
  assert.deepEqual(parseResearchQueueLeases("not json", 0), {});
  assert.deepEqual(parseResearchQueueLeases(null, 0), {});
  assert.deepEqual(
    parseResearchQueueLeases(
      JSON.stringify({
        live: { windowId: "a", expiresAt: 10 },
        expired: { windowId: "a", expiresAt: 5 },
        bad: { windowId: 3, expiresAt: 10 },
      }),
      5,
    ),
    { live: { windowId: "a", expiresAt: 10 } },
  );
});

test("another window's stored queues replace this window's, and nothing else", () => {
  const store: Record<string, SavedResearchNavigation> = {
    tree: {
      scrollByNode: {},
      followupDraft: { text: "this window's draft", updatedAt: 1 },
      queuedFollowups: { head: [{ id: "q1", prompt: "First", createdAt: 1 }] },
    },
    gone: { scrollByNode: {}, queuedFollowups: { head: [{ id: "q9", prompt: "Old", createdAt: 1 }] } },
  };
  const raw = JSON.stringify({
    tree: {
      scrollByNode: {},
      followupDraft: { text: "other window's draft", updatedAt: 2 },
      queuedFollowups: {
        head: [
          { id: "q1", prompt: "First", createdAt: 1, failed: "refused" },
          { id: "q2", prompt: "Second", createdAt: 2 },
        ],
      },
    },
    added: { scrollByNode: {}, queuedFollowups: { other: [{ id: "q3", prompt: "Third", createdAt: 3 }] } },
  });
  assert.deepEqual([...syncResearchQueuedFollowups(raw, store)].sort(), ["added", "gone", "tree"]);
  assert.deepEqual(store.tree.queuedFollowups, {
    head: [
      { id: "q1", prompt: "First", createdAt: 1, failed: "refused" },
      { id: "q2", prompt: "Second", createdAt: 2 },
    ],
  });
  assert.equal(store.tree.followupDraft?.text, "this window's draft");
  assert.equal(store.gone.queuedFollowups, undefined);
  assert.deepEqual(store.added.queuedFollowups, { other: [{ id: "q3", prompt: "Third", createdAt: 3 }] });
  // The same value again changes nothing.
  assert.equal(syncResearchQueuedFollowups(raw, store).size, 0);
});
