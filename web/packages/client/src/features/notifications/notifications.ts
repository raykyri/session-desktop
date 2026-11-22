// The notifications page's data (02 W2.6; 01 C16): the notification records
// of the viewer's user log as rows, newest first, and the text of each row.
// A record carries ids and no item text; the thread's title is the
// replica's, clipped at 64 characters, in quotes (the mock's `titleOf`):
// “a deleted thread” when it has no text left, and a thread, unquoted, while
// it is not loaded. A removed thread has no text left, so a removal names no title; it
// names the thread's kind (ask or post) from the thread's record, and "your
// thread" while the replica holds no record of it.
//
// A row's thread may be in a channel whose log the replica does not read: an
// open channel the viewer is not a member of, or was banned from. The page
// reads those channels while it is open (`fetchNotificationThreads`), as a
// channel view does, so that their threads can be fetched.

import { spaceKey, threadKey, type NotifRec } from "@session/mutators";

import { NotLoaded, UNKNOWN, known, runQuery, type ReplicaSource } from "../../replica/source.js";
import { DELETED_ACCOUNT, clip } from "../feed/format.js";

export type NotifKind = NotifRec["type"];

/** Where opening a row goes: a thread in its channel's feed with the item
 * to select, or the Invites page. */
/** Where a row opens. `gone`: the replica knows the thread no longer exists
 * (erased, or deleted by its author before anyone replied: a `gone`
 * record), so the row opens nothing and says so. */
export type NotifTarget =
  | { kind: "thread"; channel: string; thread: string; sel?: string }
  | { kind: "invites" }
  | { kind: "gone" };

export interface NotifRow {
  id: string;
  type: NotifKind;
  read: boolean;
  createdAt: string;
  /** Who caused it: for a removal, the owner who removed the thread. */
  actor: string | null;
  /** A coalesced row that stands for more than one write (`n > 1`). `n`
   * counts writes, not people, so the row says "and others" without a
   * number. */
  others: boolean;
  /** The thread's title in the replica; `undefined` while the thread is not
   * loaded, null when it has no text (deleted or removed). */
  title: string | null | undefined;
  /** Where a mention is: a reply, a comment or the post itself. */
  where: "reply" | "comment" | "post";
  /** The thread's kind; null while the replica holds no record of the
   * thread (not loaded, or not served). */
  what: "ask" | "post" | null;
  /** The owner's reason for a removal. */
  reason: string | null;
  /** The channel's name; null for an invite. */
  channel: string | null;
  target: NotifTarget | null;
}

const newestFirst = (a: NotifRec, b: NotifRec) =>
  a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1;

/** The id after `kind:` in a record key, or undefined. */
function idOf(key: string | null, kind: string): string | undefined {
  return key?.startsWith(`${kind}:`) ? key.slice(kind.length + 1) : undefined;
}

/** A comment notification's comment record, by the key in its `item`:
 * `UNKNOWN` while the thread's records are not loaded. */
function commentOf(source: ReplicaSource, n: NotifRec) {
  if (!n.item?.startsWith("comment:")) return undefined;
  return source.get(n.item);
}

/** The viewer's notifications as rows, newest first. Records the viewer may
 * no longer read are not served, so they are not listed. */
export function notificationsOf(source: ReplicaSource): NotifRow[] {
  const me = source.me;
  if (me === null) return [];
  return [...known(source.list("notif", { u: me }))].sort(newestFirst).map((n) => {
    const t = n.th ? source.get(threadKey(n.th)) : undefined;
    const thread = t !== UNKNOWN && t?.kind === "thread" ? t : undefined;
    const s = n.sp ? source.get(spaceKey(n.sp)) : undefined;
    const space = s !== UNKNOWN && s?.kind === "space" ? s : undefined;
    const title =
      t === UNKNOWN
        ? undefined
        : thread && thread.q && !thread.del && thread.mod !== "removed"
          ? clip(thread.q, 64)
          : null;
    // the item to select: a reply, a new node, or the node a comment is on
    let sel = idOf(n.item, "reply") ?? idOf(n.item, "node");
    const c = commentOf(source, n);
    if (c !== UNKNOWN && c?.kind === "comment" && c.node !== "r") sel = c.node;
    const target: NotifTarget | null =
      n.type === "invite_used"
        ? { kind: "invites" }
        : n.th && (t === undefined || thread?.gone === true)
          ? { kind: "gone" }
          : space && n.th
            ? { kind: "thread", channel: space.name, thread: n.th, ...(sel ? { sel } : {}) }
            : null;
    return {
      id: n.id,
      type: n.type,
      read: n.read,
      createdAt: n.createdAt,
      actor: n.type === "removed" ? (thread?.modBy ?? space?.owner ?? null) : n.actor,
      others: n.n > 1,
      title,
      where: n.item?.startsWith("reply:")
        ? "reply"
        : n.item?.startsWith("comment:")
          ? "comment"
          : "post",
      what: thread ? thread.k : null,
      reason: n.type === "removed" ? n.note : null,
      channel: space?.name ?? null,
      target,
    };
  });
}

/** The threads of rows whose records the replica has not loaded: a title,
 * or a comment's node to select (so the row opens its branch). */
export function unloadedThreads(source: ReplicaSource): { thread: string; space: string }[] {
  const me = source.me;
  if (me === null) return [];
  const list = source.list("notif", { u: me });
  if (list === UNKNOWN) throw new NotLoaded();
  return list
    .filter(
      (n) =>
        n.th !== null &&
        n.sp !== null &&
        (source.get(threadKey(n.th)) === UNKNOWN || commentOf(source, n) === UNKNOWN),
    )
    .map((n) => ({ thread: n.th as string, space: n.sp as string }));
}

/** Fetch the threads of rows the replica has not loaded, while the page is
 * open; the returned function ends it. A thread is fetched from its
 * channel's log (`open`), and the replica fetches it only once it reads
 * that log. It reads the logs of the viewer's channels, but not the log of
 * an open channel the viewer is not a member of (never joined, left, or
 * banned from, which ends the membership): that log is read here
 * (`watch`), as a channel view reads it, until the page closes. A thread
 * whose fetch failed is retried by the replica, not on every change here. */
export function fetchNotificationThreads(source: ReplicaSource): () => void {
  const watching = new Map<string, (() => void) | undefined>();
  const update = () => {
    if (!source.ready()) return;
    const unloaded = runQuery(() => unloadedThreads(source));
    if (unloaded === UNKNOWN) return;
    for (const u of unloaded) {
      if (!watching.has(u.space)) watching.set(u.space, source.watch?.(u.space));
      if (!source.unavailable?.(u.thread)) source.open?.(u.thread, u.space);
    }
  };
  const unsubscribe = source.subscribe(update);
  update();
  return () => {
    unsubscribe();
    for (const end of watching.values()) end?.();
    watching.clear();
  };
}

/** A row's text in parts: who (bold), what they did, and the quoted title
 * or reason. An `invite_used` row names no code: the record holds none
 * (`04` I1). */
export interface NotifParts {
  who: string;
  text: string;
  quote: string | null;
  /** The quote is the removal's reason, not a title. */
  reason: boolean;
}

/** The quoted title: the thread's, or what stands for it. */
export function titleOf(row: Pick<NotifRow, "title">): string {
  return row.title === undefined ? "a thread" : row.title === null ? "a deleted thread" : row.title;
}

export function notifParts(row: NotifRow): NotifParts {
  // an actor whose account was deleted is null (`04` P2)
  const actor = row.actor === null ? DELETED_ACCOUNT : `@${row.actor}`;
  const who = `${actor}${row.others ? " and others" : ""}`;
  // a thread not loaded yet has no title to quote
  const on = (text: string) =>
    row.title === undefined
      ? { who, text: `${text} a thread`, quote: null, reason: false }
      : { who, text: `${text} `, quote: titleOf(row), reason: false };
  switch (row.type) {
    case "mention":
      return on(` mentioned you in a ${row.where} on`);
    case "reply":
      return on(" replied to your post");
    case "branch":
      return on(" branched from your ask");
    case "comment":
      return on(" commented on your ask");
    case "removed":
      return {
        who,
        // without the thread's record the kind is not known, and the row
        // does not guess it
        text: ` removed your ${row.what ?? "thread"}${row.reason ? ": " : ""}`,
        quote: row.reason,
        reason: true,
      };
    case "invite_used":
      return { who, text: " joined Session with your invite", quote: null, reason: false };
  }
}

/** A row's whole text, as it reads. */
export function notifText(row: NotifRow): string {
  const p = notifParts(row);
  return `${p.who}${p.text}${p.quote === null ? "" : `“${p.quote}”`}`;
}
