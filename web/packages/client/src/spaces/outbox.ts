// The outbox as the person sees it in the Desktop app (phase 3; the
// mockup's sync states, `sxStatus`, `sxRow`, `sxListBody`): each write the
// sync client holds (`SyncClient.outbox()`), described from its input and
// the records (what it is, where, its text), and its state with the
// mockup's copy and actions. The web keeps no outbox (`persist: false`) and
// shows none of this.

import * as pkg from "@session/mutators";
import type { ApiError, OutboxEntry } from "@session/sync/client";

import type { Reader } from "../sync/reader.js";

import { refusalText } from "./writes.js";

/** What a write is (the icon of its row and the noun of its toast). */
export type ObKind =
  | "reply"
  | "fu"
  | "post"
  | "ask"
  | "like"
  | "save"
  | "page"
  | "show"
  | "hide"
  | "approve"
  | "edit"
  | "delete"
  | "other";

/** Where a write stands: waiting, or shown to the person ("bad"). */
export type ObState =
  | "wait"
  | "retry"
  | "update"
  | "failed"
  | "expired"
  | "dropped"
  | "forbidden"
  | "conflict"
  | "stale"
  | "refused";

export type ObAct = "retry" | "retryNow" | "again" | "copy" | "discard" | "editor";

export interface ObItem {
  local: string;
  name: string;
  kind: ObKind;
  /** The toast's noun ("your reply in …"). */
  noun: string;
  /** The row's title ("Reply in Sablefield"). */
  title: string;
  /** The person's text, for Copy text ("" when it has none). */
  text: string;
  state: ObState;
  tries: number;
  /** Seconds to the next try (`retry`). */
  next: number;
  /** When it was made (its mutation id's time), and when it was queued. */
  made: number;
  queuedAt: number;
  space: string | null;
  spaceLabel: string | null;
  thread: string | null;
  /** The ids its input makes (a reply's id: the record it shows as). */
  minted: readonly string[];
  error: ApiError | null;
  /** CONFLICT on a page edit: who saved the page since. */
  by: string | null;
  /** A page edit: the page's id. */
  page: string | null;
}

/** The writes a moderator queues (FORBIDDEN after a role change). */
const MODERATION: ReadonlySet<string> = new Set([
  "moderation.decide",
  "joinRequests.decide",
  "members.remove",
  "members.ban",
  "members.unban",
  "members.setRole",
  "reports.decide",
  "invites.revoke",
]);

export const isModeration = (o: Pick<ObItem, "name">) => MODERATION.has(o.name);

/** The server's short name for a transient failure (the mockup's SX_ERRT). */
const ERR_TEXT: Record<string, string> = {
  SERVICE_UNAVAILABLE: "server unavailable",
  INTERNAL_SERVER_ERROR: "internal error",
  TOO_MANY_REQUESTS: "too many requests",
};

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** An entry's state as the list shows it. `held`: the client is held for
 * an update (UPDATE_REQUIRED), so a queued write is not sent either. */
export function stateOf(e: OutboxEntry, held = false): ObState {
  switch (e.state) {
    case "queued":
      return held ? "update" : e.tries > 0 ? "retry" : "wait";
    case "held":
      return "update";
    case "failed":
    case "expired":
    case "dropped":
      return e.state;
    default:
      return e.error?.code === "STALE"
        ? "stale"
        : e.error?.code === "FORBIDDEN"
          ? "forbidden"
          : e.error?.code === "CONFLICT"
            ? "conflict"
            : "refused";
  }
}

/** Describe an entry from its input and the records. */
export function describe(
  e: OutboxEntry,
  r: Reader,
  label: (space: string) => string | null,
  now: number,
  held = false,
): ObItem {
  const i = (e.input ?? {}) as Record<string, unknown>;
  const thread = (id: string | null) => (id ? r.get("thread", id) : undefined);
  const itemKey = str(i["item"]);
  const keyParts = itemKey ? itemKey.split(":") : [];
  const th = thread(
    str(i["thread"]) ??
      (e.name.startsWith("threads.") ? str(i["id"]) : null) ??
      keyParts[1] ??
      null,
  );
  const space =
    str(i["space"]) ??
    th?.s ??
    (str(i["reply"]) ? (r.get("reply", str(i["reply"]) ?? "")?.s ?? null) : null);
  const where = space ? label(space) : null;
  const at = (s: string) => (where ? `${s} in ${where}` : s);
  const postNoun = (k: "ask" | "post" | undefined) => (k === "ask" ? "ask" : "post");
  let kind: ObKind = "other";
  let noun = "change";
  let title = at("Change");
  let text = "";
  let page: string | null = null;
  switch (e.name) {
    case "threads.create":
      kind = i["kind"] === "ask" ? "ask" : "post";
      noun = kind;
      title = at(kind === "ask" ? "Ask" : "Post");
      text = str(i["q"]) ?? "";
      break;
    case "research.createPostFollowUp":
      kind = "reply";
      noun = "reply";
      title = at("Reply");
      text = str(i["t"]) ?? "";
      break;
    case "followups.ask":
    case "research.forkNode":
      kind = "fu";
      noun = "follow-up";
      title = at("Follow-up");
      text = str(i["q"]) ?? "";
      break;
    case "likes.set":
      kind = "like";
      noun = "like";
      title = at(th ? `Like on ${th.u}’s ${postNoun(th.k)}` : "Like");
      if (i["on"] === false) title = at(th ? `Unlike of ${th.u}’s ${postNoun(th.k)}` : "Unlike");
      break;
    case "likes.setReply": {
      const rp = r.get("reply", str(i["reply"]) ?? "");
      kind = "like";
      noun = "like";
      title = at(rp ? `Like on ${rp.u}’s reply` : "Like");
      break;
    }
    case "saved.set":
      kind = "save";
      noun = "save";
      title = at(i["on"] === false ? "Unsave" : "Save");
      break;
    case "pages.update": {
      const pg = str(i["page"]);
      const t = str(i["title"]) ?? "";
      kind = "page";
      noun = pg ? "page edit" : "page";
      page = pg ?? str(i["id"]);
      title = at(pg ? `Edit of ${t}` : `New page ${t}`);
      text = Array.isArray(i["text"]) ? (i["text"] as unknown[]).map(String).join("\n") : "";
      break;
    }
    case "moderation.decide": {
      const [k, t1, t2] = keyParts;
      const target =
        k === "r"
          ? r.get("reply", t2 ?? "")
          : k === "f"
            ? r.get("followup", t2 ?? "")
            : thread(t1 ?? null);
      const n = k === "r" ? "reply" : k === "f" ? "follow-up" : "thread";
      const by = target && "u" in target ? target.u : null;
      const d = i["decision"];
      kind = d === "shown" ? "show" : "hide";
      noun = "moderation action";
      title = at(
        d === "shown"
          ? `Show ${by ? `${by}’s` : "a"} ${n}`
          : `${d === "removed" ? "Remove" : "Hide"} a ${n}${by ? ` by ${by}` : ""}`,
      );
      break;
    }
    case "joinRequests.decide": {
      const users = Array.isArray(i["users"]) ? (i["users"] as string[]) : [];
      const verb =
        i["decision"] === "decline" ? "Decline" : i["decision"] === "reopen" ? "Reopen" : "Approve";
      kind = "approve";
      noun = "moderation action";
      title = at(
        users.length === 1 ? `${verb} ${users[0]}’s request` : `${verb} ${users.length} requests`,
      );
      break;
    }
    case "threads.update":
      kind = "edit";
      noun = "edit";
      title = at(`Edit of your ${postNoun(th?.k)}`);
      text = str(i["q"]) ?? "";
      break;
    case "followups.update":
      kind = "edit";
      noun = "edit";
      title = at("Edit of your follow-up");
      text = str(i["q"]) ?? "";
      break;
    case "replies.update":
      kind = "edit";
      noun = "edit";
      title = at("Edit of your reply");
      text = str(i["t"]) ?? "";
      break;
    case "threads.delete":
    case "followups.delete":
    case "replies.delete":
      kind = "delete";
      noun = "deletion";
      title = at(
        e.name === "threads.delete"
          ? `Delete of your ${postNoun(th?.k)}`
          : e.name === "followups.delete"
            ? "Delete of your follow-up"
            : "Delete of your reply",
      );
      break;
    default:
      if (MODERATION.has(e.name)) {
        kind = "hide";
        noun = "moderation action";
        const u = str(i["user"]);
        title = at(
          e.name === "members.ban"
            ? `Ban ${u ?? "a member"}`
            : e.name === "members.remove"
              ? `Remove ${u ?? "a member"}`
              : "Moderation",
        );
      }
  }
  const current = (e.error?.current ?? null) as { ed?: unknown } | null;
  return {
    local: e.local,
    name: e.name,
    kind,
    noun,
    title,
    text,
    state: stateOf(e, held),
    tries: e.tries,
    next: Math.max(1, Math.ceil((e.next - now) / 1000)),
    made: pkg.ulidTime(e.mutationId),
    queuedAt: e.queuedAt,
    space,
    spaceLabel: where,
    thread: th?.id ?? null,
    minted: e.minted,
    error: e.error ?? null,
    by: str(current?.ed),
    page,
  };
}

export const BAD: ReadonlySet<ObState> = new Set([
  "failed",
  "expired",
  "dropped",
  "forbidden",
  "conflict",
  "stale",
  "refused",
]);
export const isBad = (o: Pick<ObItem, "state">) => BAD.has(o.state);

export interface ObStatus {
  tone: "wait" | "bad";
  head: string | null;
  text: string;
  /** Label, action, and whether it is the primary one. */
  acts: [string, ObAct, boolean][];
}

const days = (ms: number) => {
  const d = Math.max(1, Math.floor(ms / 86_400_000));
  return d === 1 ? "1 day" : `${d} days`;
};

/** The status of a write with the mockup's copy (`sxStatus`). `here`: "this
 * Mac". */
export function statusOf(o: ObItem, o2: { here: string; offline: boolean; now: number }): ObStatus {
  const copy: [string, ObAct, boolean][] = o.text ? [["Copy text", "copy", false]] : [];
  switch (o.state) {
    case "wait":
      return {
        tone: "wait",
        head: null,
        text: o2.offline
          ? `Not sent yet: offline. It is saved on ${o2.here} and sends when the connection is back.`
          : "Not sent yet: it sends after the changes before it.",
        acts: [],
      };
    case "retry":
      return {
        tone: "wait",
        head: null,
        text: `Not sent yet: the server didn’t answer. Next try in ${o.next} s (try ${o.tries} of 5).`,
        acts: [["Retry now", "retryNow", true]],
      };
    case "update":
      return {
        tone: "wait",
        head: null,
        text: "Not sent yet: this version of Session can’t sync. It sends after the update.",
        acts: [],
      };
    case "failed": {
      const code = o.error?.code ?? "INTERNAL_SERVER_ERROR";
      return {
        tone: "bad",
        head: "Couldn’t save",
        text: `The server failed 5 times (${ERR_TEXT[code] ?? code}). The changes after it were sent.`,
        acts: [["Retry", "retry", true], ...copy, ["Discard", "discard", false]],
      };
    }
    case "expired":
      return {
        tone: "bad",
        head: "Not saved",
        text: `The server takes a change up to 4 days after it was made, by ${o2.here}’s clock. This one was made ${days(o2.now - o.made)} ago.`,
        acts: [
          [o.kind === "post" ? "Post again" : "Send again", "again", true],
          ...copy,
          ["Discard", "discard", false],
        ],
      };
    case "dropped":
      return {
        tone: "bad",
        head: "Not sent",
        text: "It waited 3 days without reaching the server, so Session removed it from Unsent changes.",
        acts: [
          ...(o.text ? [["Copy text", "copy", true] as [string, ObAct, boolean]] : []),
          ["Dismiss", "discard", !o.text],
        ],
      };
    case "forbidden":
      return {
        tone: "bad",
        head: "Not applied",
        text: "The server refused it.",
        acts: [...copy, ["Dismiss", "discard", !o.text]],
      };
    case "conflict":
      return o.kind === "page" && o.page
        ? {
            tone: "bad",
            head: "Not saved",
            text: `${o.by ?? "Someone"} saved the page after you edited it on ${o2.here}.`,
            acts: [["Open the editor", "editor", true], ...copy],
          }
        : {
            tone: "bad",
            head: "Not saved",
            text: o.error ? refusalText(o.error) : "",
            acts: [...copy, ["Dismiss", "discard", !o.text]],
          };
    case "stale":
      return {
        tone: "bad",
        head: "Not saved",
        text: `It changed on the server after you made this change on ${o2.here}, so the server didn’t apply it.`,
        acts: [...copy, ["Dismiss", "discard", !o.text]],
      };
    case "refused":
      return {
        tone: "bad",
        head: "Not applied",
        text: o.error ? refusalText(o.error) : "The server refused it.",
        acts: [...copy, ["Dismiss", "discard", !o.text]],
      };
  }
}

/** The list's first line (`sxListBody`). */
export function listHead(o: { here: string; offline: boolean; update: boolean }): string {
  if (o.update)
    return `This version of Session can’t sync. These changes are saved on ${o.here} and are sent after the update.`;
  if (o.offline)
    return `Offline. These changes are saved on ${o.here} and are sent in this order when the connection is back.`;
  return `Changes made on ${o.here} are sent to the server in the order they were made.`;
}

/** STALE on a decision with no text: the toast says why (`sxStaleText`),
 * and the write leaves Unsent changes (nothing is applied again). */
export function staleText(o: ObItem): string {
  const cur = (o.error?.current ?? null) as { u?: unknown } | null;
  const who = str(cur?.u);
  if (o.name === "moderation.decide" && o.kind === "show")
    return `Show wasn’t applied because ${who ?? "the author"} edited the ${o.title.includes("follow-up") ? "follow-up" : o.title.includes("thread") ? "thread" : "reply"} after you chose Show.`;
  if (o.name === "joinRequests.decide" && /^Approve/.test(o.title))
    return `Approve wasn’t applied because ${who ?? "the person"} changed the request after you chose Approve.`;
  return refusalText(o.error ?? { code: "STALE", message: "" });
}
