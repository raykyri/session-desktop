// The notifications page's data (02 W2.6; 01 C16): the notification records
// of the viewer's user log as rows, newest first, and the text of each row.
// A record carries ids and no item text; the thread's title is the
// replica's, clipped at 64 characters (the mock's `titleOf`). A removed
// thread has no text left, so a removal names no title.

import { spaceKey, threadKey, type NotifRec } from "@session/mutators";

import { NotLoaded, UNKNOWN, known, type ReplicaSource } from "../../replica/source.js";
import { clip } from "../feed/format.js";

export type NotifKind = NotifRec["type"];

/** Where opening a row goes: a thread in its channel's feed with the item
 * to select, or the Invites page. */
export type NotifTarget =
  { kind: "thread"; channel: string; thread: string; sel?: string } | { kind: "invites" };

export interface NotifRow {
  id: string;
  type: NotifKind;
  read: boolean;
  createdAt: string;
  /** Who caused it: for a removal, the owner who removed the thread. */
  actor: string | null;
  /** How many more people a coalesced row stands for (`n - 1`). */
  others: number;
  /** The thread's title in the replica; `undefined` while the thread is not
   * loaded, null when it has no text (deleted or removed). */
  title: string | null | undefined;
  /** Where a mention is: a reply, a comment or the post itself. */
  where: "reply" | "comment" | "post";
  /** The removed thread's kind. */
  what: "ask" | "post";
  /** The owner's reason for a removal. */
  reason: string | null;
  /** The code an invite was used with. */
  code: string | null;
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
    const comment = idOf(n.item, "comment");
    if (comment) {
      const c = source.get(`comment:${comment}`);
      if (c !== UNKNOWN && c?.kind === "comment" && c.node !== "r") sel = c.node;
    }
    const target: NotifTarget | null =
      n.type === "invite_used"
        ? { kind: "invites" }
        : space && n.th
          ? { kind: "thread", channel: space.name, thread: n.th, ...(sel ? { sel } : {}) }
          : null;
    return {
      id: n.id,
      type: n.type,
      read: n.read,
      createdAt: n.createdAt,
      actor: n.type === "removed" ? (thread?.modBy ?? space?.owner ?? null) : n.actor,
      others: Math.max(0, n.n - 1),
      title,
      where: n.item?.startsWith("reply:")
        ? "reply"
        : n.item?.startsWith("comment:")
          ? "comment"
          : "post",
      what: thread?.k === "post" ? "post" : "ask",
      reason: n.type === "removed" ? n.note : null,
      code: n.type === "invite_used" ? n.note : null,
      channel: space?.name ?? null,
      target,
    };
  });
}

/** The threads of rows whose title the replica has not loaded. */
export function unloadedThreads(source: ReplicaSource): { thread: string; space: string }[] {
  const me = source.me;
  if (me === null) return [];
  const list = source.list("notif", { u: me });
  if (list === UNKNOWN) throw new NotLoaded();
  return list
    .filter((n) => n.th !== null && n.sp !== null && source.get(threadKey(n.th)) === UNKNOWN)
    .map((n) => ({ thread: n.th as string, space: n.sp as string }));
}

/** A row's text in parts: who (bold), what they did, the quoted title or
 * reason, and the code of an invite. */
export interface NotifParts {
  who: string;
  text: string;
  quote: string | null;
  /** The quote is the removal's reason, not a title. */
  reason: boolean;
  code: string | null;
}

export function notifParts(row: NotifRow): NotifParts {
  const others = row.others ? ` and ${row.others} ${row.others === 1 ? "other" : "others"}` : "";
  const who = `@${row.actor ?? "someone"}${others}`;
  const title =
    row.title === undefined ? "a thread" : row.title === null ? "a deleted thread" : row.title;
  const quoted = row.title === undefined || row.title === null ? null : row.title;
  const on = (text: string) => ({
    who,
    text: quoted === null ? `${text} ${title}` : `${text} `,
    quote: quoted,
    reason: false,
    code: null,
  });
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
        text: ` removed your ${row.what}${row.reason ? ": " : ""}`,
        quote: row.reason,
        reason: true,
        code: null,
      };
    case "invite_used":
      return {
        who,
        text: ` joined Session with your invite${row.code ? " " : ""}`,
        quote: null,
        reason: false,
        code: row.code,
      };
  }
}

/** A row's whole text, as it reads. */
export function notifText(row: NotifRow): string {
  const p = notifParts(row);
  return `${p.who}${p.text}${p.quote === null ? "" : `“${p.quote}”`}${p.code ?? ""}`;
}

/** The summary line under the heading (W2.6). */
export function unreadLine(unread: number): string {
  return unread === 0
    ? "All caught up."
    : `${unread} unread ${unread === 1 ? "notification" : "notifications"}.`;
}
