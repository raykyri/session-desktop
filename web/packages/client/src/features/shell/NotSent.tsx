// "Not sent" (02 §9.2): the web client's outbox holds a write only while its
// request is in flight. A write whose request failed keeps its prediction
// and is shown here until the person retries it (same mutation id) or
// discards it (rolled back, its text back in its composer):
// - a write that created an item (a thread, branch, reply or comment):
//   "Not sent · Retry · Discard" under that item (`NotSentLine`);
// - a write with no item (a save, a join, a layout change), and a write
//   whose item is not on screen with its line (a branch or a reply that is
//   not selected, a comment on such a branch): a persistent alert toast "Not
//   sent." with Retry and Discard; with several such writes it reads "N
//   changes not sent." and its buttons act on all of them in outbox order
//   (`OutboxToast`). Every "Not sent" write is shown in one of the two.
// A write left unsent by one of the server's limits (TOO_MANY_REQUESTS,
// 04 Z1) shows the server's message after "Not sent", which says which
// limit and when it frees.

import { useLayoutEffect, useSyncExternalStore } from "react";
import { create } from "zustand";

import { useReplica } from "../../replica/ReplicaProvider.js";
import type { ReplicaSource, UnsentWrite } from "../../replica/source.js";
import { refusalText } from "../../replica/writes.js";

import { showToast } from "./Toast.js";

const NONE: readonly UnsentWrite[] = [];

/** The viewer's "Not sent" writes, in outbox order. */
export function useUnsent(): readonly UnsentWrite[] {
  const source = useReplica();
  const read = () => source.unsent?.() ?? NONE;
  return useSyncExternalStore((listener) => source.subscribe(listener), read, read);
}

/** Retry writes in order; a refusal shows its toast. */
async function retryAll(source: ReplicaSource, writes: readonly UnsentWrite[]): Promise<void> {
  for (const w of writes) {
    const outcome = await source.retry?.(w.local);
    if (outcome && !outcome.ok) showToast(refusalText(outcome.error), { alert: true });
  }
}

/** The server's message when a limit left a write unsent ("You can create 5
 * channels a day. Try again in 22 hours.", 04 Z1), else null: a failed
 * request has no message worth showing. */
export function limitMessage(writes: readonly UnsentWrite[]): string | null {
  const error = writes.find((w) => w.error?.code === "TOO_MANY_REQUESTS")?.error;
  return error?.message ? error.message : null;
}

function discardAll(source: ReplicaSource, writes: readonly UnsentWrite[]): void {
  for (const w of writes) source.discard?.(w.local);
}

/** The items whose `NotSentLine` is mounted, with how many lines each has. */
const useLines = create<{ lines: Readonly<Record<string, number>> }>()(() => ({ lines: {} }));

function countLine(item: string, by: 1 | -1): void {
  useLines.setState(({ lines }) => {
    const n = (lines[item] ?? 0) + by;
    const next = { ...lines };
    if (n > 0) next[item] = n;
    else delete next[item];
    return { lines: next };
  });
}

/** "Not sent · Retry · Discard" under the item a write created. While it is
 * mounted, the outbox toast leaves that item's writes to it. */
export function NotSentLine({ item }: { item: string }) {
  // a layout effect: counted before the browser paints, so the toast does
  // not show the write for a frame
  useLayoutEffect(() => {
    countLine(item, 1);
    return () => countLine(item, -1);
  }, [item]);
  const source = useReplica();
  const unsent = useUnsent().filter((w) => w.item === item);
  if (unsent.length === 0) return null;
  const limit = limitMessage(unsent);
  return (
    <div className="notsent" data-not-sent="">
      <span>{limit ? `Not sent. ${limit}` : "Not sent"}</span>
      <span aria-hidden="true">·</span>
      <button type="button" className="tlink" onClick={() => void retryAll(source, unsent)}>
        Retry
      </button>
      <span aria-hidden="true">·</span>
      <button type="button" className="tlink" onClick={() => discardAll(source, unsent)}>
        Discard
      </button>
    </div>
  );
}

/** The persistent toast of the writes with no item or no line on screen. An
 * alert is announced when it is inserted, so nothing is mounted while every
 * write is sent or shown under its item. */
export function OutboxToast() {
  const source = useReplica();
  const lines = useLines((state) => state.lines);
  const unsent = useUnsent().filter((w) => w.item === null || !lines[w.item]);
  if (unsent.length === 0) return null;
  const limit = limitMessage(unsent);
  return (
    <div role="alert" className="feed-toast outbox-toast" data-outbox-toast="">
      <span>
        {unsent.length === 1 ? "Not sent." : `${unsent.length} changes not sent.`}
        {limit ? ` ${limit}` : ""}
      </span>
      <button type="button" onClick={() => void retryAll(source, unsent)}>
        Retry
      </button>
      <button type="button" onClick={() => discardAll(source, unsent)}>
        Discard
      </button>
    </div>
  );
}
