// The stored shape: what mutators write and what replicas hold. It is
// replica-proto's `records.ts` (the reference, phase 0), extended with the
// record kinds the rest of the mock's procedures need. The rules carried over
// from phase 0:
//
// - Every record has `kind` and an integer `rev` that the store sets on each
//   write. A record written again at a deleted key continues from the key's
//   last rev. Counts (`likes`, `r`, `members`, `posts`) are stored fields that
//   mutators maintain; nothing is derived on read, and per-viewer fields
//   (`liked`, `mine`) are computed on the client (`viewer.ts`).
// - A thread's like and follow-up counts are a separate `counts` record, so a
//   like or a follow-up does not change the thread's rev.
// - Optional fields are `null` (or `false`, `[]`) when absent, so two writes
//   of the same state produce equal records.
// - The mock's per-person collections become records keyed by person: a
//   membership, a like, a save, a mute, a read source.
// - A removal is the moderated record's `mod` field ("removed"): its text is
//   erased, so the removal is a change of the item. Hiding is a separate
//   `hide` record keyed by the item (phase 1b, Part 0 item 3), so hiding and
//   showing never change the item's rev: an author's edit made before a hide
//   is not STALE. "Shown" compares the hide record's rev, which an author's
//   edit of the hidden item also moves (review round 1, R2).
// - Space ids are ULIDs; a space's rules version is the integer `rulesRev`.
// - A space's activity is a separate `stats` record, read with its content;
//   the space record is public and changes only when its settings, members
//   or staff change.
// - A removed record's text is erased from storage; a hidden one keeps it.
//
// Added for the procedures phase 0 did not port (the mock's collection in
// brackets):
// - `pages` [a space's `pages`] and `page` [`pagedocs`]: a space's page list
//   and its page documents, read with the space's content. The list is not
//   on the public space record, for the same reason as `stats`. A page has an
//   id (phase 1a.2, decision 3): writes name it, and its document is keyed by
//   it, so a new title does not move the document.
// - `skill` [`skills`]: one skill of a space, read with its content, with its
//   own id in `ID_KINDS` (phase 1b, Part 0 item 5). `skills` [`skillsRev`]:
//   the space's order of its skills; its rev is the base of a reorder, and
//   only adding, removing or reordering a skill changes it.
// - `source` [`media`]: Session's catalog of sources, public: its own log,
//   `catalog` (decision 4). `spacesrc` [`dsDrops`, `miAdded`]: a source added
//   to a space, with a copy of the source's metadata, read with the space's
//   content; while it waits for review, its fields are redacted for readers
//   other than the person who added it and the space's moderators (decision
//   5). `srcrep` [`dsReps`]: a report of a source in a space.
// - `apikey` [`userKeys`]: an API key's id, name, provider and status, never
//   its raw value, in its person's user log (decision 2). The server's
//   online-only `apiKeys.*` calls write it; a write paid by a key checks it
//   in `can`.
// - `device` [`devices`]: a signed-in device of its person (id, name, kind,
//   last seen), never its token, in their user log (phase 1b, Part 0 item
//   2). The server's online-only `devices.*` calls write it; a device run
//   checks it in `can`.
// - Per person: `rlike` [`rpLiked`], `asksave` [`qtSaved`], `srcsave`
//   [`miSaved`], `srcread` [`miRead`], `mute` [`muted`], `block` [`blocked`],
//   `invask` [`askedInv`], `seen` [`repSeen`, `reqSeen`], `profile`
//   [`profile`].
// - A follow-up is a node of its thread's ask tree [`fu` and `qtd`]: `par` is
//   the follow-up it asks about, or null for the thread's own ask.

import type { Spaces } from "@session/shared";

/** A change log: one per space, one per user, and Session's catalog of
 * sources (`catalog`, public). */
export type LogId = `space:${string}` | `user:${string}` | "catalog";

export type SpaceRole = Spaces.SpaceMemberRole;
/** The moderation state an item record holds itself: a removal, which
 * erases its text. A hidden item has a `hide` record instead. */
export type ModState = "removed";
export type Visibility = "open" | "listed" | "unlisted";

export interface SpaceDomain {
  domain: string;
  method: "dns";
  state: "checking" | "ok" | "failed";
  verifiedAt: string | null;
}

export interface SpaceRec {
  kind: "space";
  id: string;
  name: string;
  title: string;
  desc: string;
  rules: string[];
  /** The rules' version: counts the saves that changed them. */
  rulesRev: number;
  /** The rules before the last change, and who changed them ("See changes"). */
  rulesPrev: string[];
  rulesBy: string | null;
  vis: Visibility;
  policy: "request" | "invite" | null;
  invite: "mods" | "members" | null;
  qs: { q: string; req: boolean }[];
  postsOff: boolean;
  /** The avatar's style and whether it has an image. */
  av: number;
  img: boolean;
  /** The FAQ landing and its topics, `[id, title]`. */
  faq: boolean;
  topics: [string, string][];
  /** Show the title without "#" (a verified space). */
  plain: boolean;
  /** Who edits pages: moderators (null, the default) or members. */
  pageEdit: "mods" | "members" | null;
  /** Who adds sources (the mock's `dsPol`). */
  srcPolicy: "members" | "review" | "mods";
  /** A domain check: written "checking" by `spaces.verifyDomain`, then by the
   * check job. */
  dom: SpaceDomain | null;
  archived: { by: string; at: string } | null;
  deleted: boolean;
  /** Stored count of member records. */
  members: number;
  /** The owner, admins and moderators (the staff list), by rank then handle. */
  mods: [string, SpaceRole][];
  createdAt: string;
  rev: number;
}

/** A space's activity, keyed `stats:<space>`. */
export interface StatsRec {
  kind: "stats";
  sp: string;
  posts: number;
  updatedAt: string;
  rev: number;
}

export interface MemberRec {
  kind: "member";
  sp: string;
  u: string;
  role: SpaceRole;
  /** The admission id, derived from the write that let the person in. A role
   * change keeps it; a removal names it (stale intent). */
  adm: string;
  joinedAt: string;
  rev: number;
}

/** What an ask is about, stored as sent (the mock's `about`). */
export interface AskAbout {
  it?: string | undefined;
  its?: string[] | undefined;
  b?: number | undefined;
  quote?: string | undefined;
}

export interface ThreadRec {
  kind: "thread";
  id: string;
  s: string;
  u: string;
  k: "ask" | "post";
  q: string;
  t: string | null;
  sum: string | null;
  tok: number;
  running: boolean;
  edited: boolean;
  del: boolean;
  gone: boolean;
  mod: ModState | null;
  /** A topic of the space's FAQ landing, and who put it there. */
  topic: string | null;
  topicBy: "asker" | "mod" | null;
  /** TODO(limits): who pays, stored as sent ("session" or a key id). */
  pay: string | null;
  model: string | null;
  about: AskAbout | null;
  skill: string | null;
  /** The number of the latest run of its ask (0 for a post). */
  att: number;
  /** The thread and follow-up it was started from, and that follow-up's depth. */
  from: { th: string; node: string; lv: number } | null;
  createdAt: string;
  updatedAt: string;
  rev: number;
}

/** A thread's counts, keyed `counts:<thread>`. */
export interface CountsRec {
  kind: "counts";
  th: string;
  s: string;
  likes: number;
  /** First-level follow-ups (an ask) or top-level replies (a post). */
  r: number;
  /** The likes of each of its replies that has any, by reply id (decision
   * 10): a reply like changes this record, not the reply. */
  rlikes: Record<string, number>;
  rev: number;
}

/** A follow-up ask: a node of its thread's ask tree. */
export interface FollowUpRec {
  kind: "followup";
  id: string;
  th: string;
  s: string;
  /** The follow-up this one asks about, or null for the thread's ask. */
  par: string | null;
  u: string;
  q: string;
  a: string | null;
  /** The answers (follow-up ids, or "r") this ask compares. */
  uses: string[] | null;
  pay: string | null;
  model: string | null;
  att: number;
  edited: boolean;
  del: boolean;
  /** The thread this branch became (`threads.create` with `from`). */
  promoted: string | null;
  mod: ModState | null;
  createdAt: string;
  rev: number;
}

export interface ReplyRec {
  kind: "reply";
  id: string;
  th: string;
  s: string;
  u: string;
  t: string;
  /** The top-level reply this one answers (one level of nesting), or null. */
  parent: string | null;
  edited: boolean;
  del: boolean;
  mod: ModState | null;
  createdAt: string;
  rev: number;
}

/** Who runs an ask: null for the included tokens (a server job), or a CLI
 * on one of the asker's devices (`u`, the asker). */
export interface Executor {
  kind: "device";
  cli: "claude" | "codex";
  device: string;
  u: string;
}

/** Why a run ended without an answer. `interrupted`: a device run whose
 * lease ended (the device slept or lost its connection); `too_large`: a
 * device's answer over the server's cap. */
export type RunEnd = "stopped" | "tokens" | "key" | "rate" | "access" | "interrupted" | "too_large";

/** A run of an ask: the thread's (`node` "r") or a follow-up's (`node` its
 * id). A mutator writes it `queued`; from there the server's job, or for a
 * device run the online `runs.*` calls of the device that claimed it, write
 * its status, its lease and how it ended. */
export interface RunRec {
  kind: "run";
  id: string;
  th: string;
  s: string;
  u: string;
  node: string;
  status: "queued" | "running" | "complete" | "failed" | "cancelled";
  end: RunEnd | null;
  attempt: number;
  pay: string | null;
  model: string | null;
  executor: Executor | null;
  /** A device run's lease (server-written): when it ends unless the device
   * sends a heartbeat, and the device's last heartbeat. */
  lease: { until: string; beat: string } | null;
  createdAt: string;
  rev: number;
}

export interface ReportRec {
  kind: "report";
  id: string;
  sp: string;
  key: string;
  by: string;
  st: "open" | "dismissed" | "hidden" | "removed";
  why: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  rev: number;
}

export interface RequestRec {
  kind: "request";
  sp: string;
  u: string;
  st: "open" | "approved" | "declined";
  a: string[];
  why: string | null;
  createdAt: string;
  updatedAt: string;
  rev: number;
}

export interface BanRec {
  kind: "ban";
  id: string;
  sp: string;
  u: string;
  createdAt: string;
  rev: number;
}

export interface InviteRec {
  kind: "invite";
  id: string;
  /** Server-made in the pre-check stage; never from the client. */
  code: string;
  by: string;
  sp: string;
  expiresAt: string | null;
  dead: string | null;
  usedBy: string | null;
  /** A revoked link stays stored, for `invites.restore`. */
  revokedAt: string | null;
  createdAt: string;
  rev: number;
}

export interface LikeRec {
  kind: "like";
  u: string;
  th: string;
  createdAt: string;
  rev: number;
}

export interface SaveRec {
  kind: "save";
  u: string;
  th: string;
  createdAt: string;
  rev: number;
}

/** A like of a reply, keyed `rlike:<user>:<reply>`. */
export interface ReplyLikeRec {
  kind: "rlike";
  u: string;
  th: string;
  reply: string;
  createdAt: string;
  rev: number;
}

/** A saved ask: a thread's ask (`node` "r") or one of its follow-ups. */
export interface AskSaveRec {
  kind: "asksave";
  u: string;
  th: string;
  node: string;
  createdAt: string;
  rev: number;
}

export interface SourceSaveRec {
  kind: "srcsave";
  u: string;
  src: string;
  createdAt: string;
  rev: number;
}

export interface SourceReadRec {
  kind: "srcread";
  u: string;
  src: string;
  createdAt: string;
  rev: number;
}

export interface MuteRec {
  kind: "mute";
  u: string;
  who: string;
  createdAt: string;
  rev: number;
}

export interface BlockRec {
  kind: "block";
  u: string;
  who: string;
  createdAt: string;
  rev: number;
}

/** A person asked an invite-only space's members for an invite. The space's
 * staff read it (decision 8), so it is in the space's log too. */
export interface InviteAskRec {
  kind: "invask";
  u: string;
  sp: string;
  createdAt: string;
  rev: number;
}

/** Whether a person read the moderators' join-request and report notices. */
export interface SeenRec {
  kind: "seen";
  u: string;
  reqs: boolean;
  reps: boolean;
  rev: number;
}

export interface ProfileRec {
  kind: "profile";
  u: string;
  name: string;
  bio: string;
  rev: number;
}

export type NotifType = "report" | Spaces.InboxNotificationType;

/** A notification. The server writes them after a commit (a post-commit
 * effect); mutators only mark them read or answered. */
export interface NotifRec {
  kind: "notif";
  id: string;
  to: string;
  type: NotifType;
  sp: string | null;
  report: string | null;
  item: string | null;
  outcome: "dismissed" | "hidden" | "removed" | null;
  response: "accepted" | "declined" | null;
  actor: string | null;
  thread: string | null;
  node: string | null;
  /** An invite notification's invite link (its id): joining from the
   * notification uses that link (phase 1b, Part 0 item 1). */
  invite: string | null;
  read: boolean;
  createdAt: string;
  rev: number;
}

/** A hidden item, keyed `hide:<item key>` (`hide:thread:<id>`,
 * `hide:followup:<id>`, `hide:reply:<id>`): its existence is the hidden
 * state; showing the item deletes it. Its rev is the base of "shown" (and of
 * a reopening that shows the item), and `ed` counts the author's edits of the
 * item while it is hidden, so a "shown" decided after reading one text never
 * publishes another. */
export interface HideRec {
  kind: "hide";
  /** The hidden record's key. */
  item: string;
  s: string;
  ed: number;
  createdAt: string;
  rev: number;
}

/** A page in a space's list: its id, title and when it was last edited. */
export interface PageEntry {
  id: string;
  t: string;
  at: string;
}

/** A space's page list, in order. */
export interface PagesRec {
  kind: "pages";
  sp: string;
  list: PageEntry[];
  rev: number;
}

export interface PageRevision {
  by: string;
  note: string;
  createdAt: string;
}

/** A page document, keyed `page:<id>`. `slug` (its title in lower case, for
 * its address) is unique in its space. `ver` is the document's version (the
 * mock's `rev`): it counts the saves. */
export interface PageRec {
  kind: "page";
  id: string;
  sp: string;
  slug: string;
  t: string;
  text: string[];
  by: string;
  ed: string | null;
  ver: number;
  revs: PageRevision[];
  rev: number;
}

/** A skill of a space, keyed `skill:<id>`. */
export interface SkillRec {
  kind: "skill";
  id: string;
  sp: string;
  name: string;
  prompt: string;
  /** The skill's version (the wire's `rev`): counts its saves, 0 for a skill
   * never edited; an editor's `base`. */
  ver: number;
  rev: number;
}

/** A space's order of its skills, keyed `skills:<space>`, by skill id. Its
 * rev is the base of `skills.reorder`. */
export interface SkillsRec {
  kind: "skills";
  sp: string;
  order: string[];
  rev: number;
}

export interface SourceBlock {
  p?: string;
  h?: string;
  ts?: string;
  sp?: string;
  q?: { au: string; h: string; t: string };
}

/** What Session read from a source. */
export interface SourceMeta {
  pl: string;
  form: string;
  au: string;
  h: string;
  len: string;
  tok: number;
  url: string;
  t: string | null;
  desc: string;
  sum: string;
  body: SourceBlock[];
}

/** A source in Session's catalog (server-written). */
export interface SourceRec {
  kind: "source";
  id: string;
  meta: SourceMeta;
  /** The normalized URL, for finding a known source by its URL. */
  nurl: string | null;
  createdAt: string;
  rev: number;
}

/** A source added to a space, keyed `spacesrc:<space>:<source>`. */
export interface SpaceSourceRec {
  kind: "spacesrc";
  sp: string;
  src: string;
  by: string;
  note: string;
  /** Waiting for a moderator's review. */
  rv: boolean;
  /** Removed from the space (`spaceSources.review` restores it). */
  rm: boolean;
  meta: SourceMeta;
  nurl: string | null;
  createdAt: string;
  rev: number;
}

/** An API key as its person's replicas hold it (decision 2): never the raw
 * key. Written by the server's online-only `apiKeys.*` calls. */
export interface ApiKeyRec {
  kind: "apikey";
  id: string;
  u: string;
  name: string;
  provider: string;
  status: "checking" | "valid" | "invalid";
  rev: number;
}

/** A signed-in device as its person's replicas hold it (phase 1b, Part 0
 * item 2): never the device token, which only the server keeps. Written by
 * the server's online-only `devices.*` calls; `seen` at most once an hour. */
export interface DeviceRec {
  kind: "device";
  id: string;
  u: string;
  name: string;
  type: "mac" | "phone";
  plat: string;
  createdAt: string;
  seen: string | null;
  rev: number;
}

/** A report of a source in a space, keyed `srcrep:<space>:<source>:<by>`. */
export interface SourceReportRec {
  kind: "srcrep";
  sp: string;
  src: string;
  by: string;
  why: string;
  createdAt: string;
  rev: number;
}

export type StoredRecord =
  | SpaceRec
  | StatsRec
  | MemberRec
  | ThreadRec
  | CountsRec
  | FollowUpRec
  | ReplyRec
  | RunRec
  | ReportRec
  | RequestRec
  | BanRec
  | InviteRec
  | LikeRec
  | SaveRec
  | ReplyLikeRec
  | AskSaveRec
  | SourceSaveRec
  | SourceReadRec
  | MuteRec
  | BlockRec
  | InviteAskRec
  | SeenRec
  | ProfileRec
  | NotifRec
  | PagesRec
  | PageRec
  | SkillRec
  | SkillsRec
  | HideRec
  | DeviceRec
  | SourceRec
  | SpaceSourceRec
  | SourceReportRec
  | ApiKeyRec;

export type Kind = StoredRecord["kind"];
export type RecordOf<K extends Kind> = Extract<StoredRecord, { kind: K }>;
/** A record as a mutator writes it: the store sets `rev`. */
export type Draft<R extends StoredRecord = StoredRecord> = R extends unknown
  ? Omit<R, "rev">
  : never;

/** Kinds whose records carry an id that a client or the server chose. Ids are
 * unique across these kinds and never used twice. The other kinds are keyed
 * by the records they relate (`member:<space>:<user>`). */
export const ID_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  "space",
  "thread",
  "followup",
  "reply",
  "run",
  "report",
  "invite",
  "notif",
  "source",
  "page",
  "apikey",
  "skill",
  "device",
]);

/** A record's id within its kind: its key without the `<kind>:` prefix. */
export function idOfRecord(r: Draft | StoredRecord): string {
  switch (r.kind) {
    case "stats":
    case "pages":
    case "skills":
      return r.sp;
    case "counts":
      return r.th;
    case "member":
    case "request":
    case "ban":
      return `${r.sp}:${r.u}`;
    case "like":
    case "save":
      return `${r.u}:${r.th}`;
    case "rlike":
      return `${r.u}:${r.reply}`;
    case "asksave":
      return `${r.u}:${r.th}:${r.node}`;
    case "srcsave":
    case "srcread":
      return `${r.u}:${r.src}`;
    case "mute":
    case "block":
      return `${r.u}:${r.who}`;
    case "invask":
      return `${r.u}:${r.sp}`;
    case "seen":
    case "profile":
      return r.u;
    case "spacesrc":
      return `${r.sp}:${r.src}`;
    case "srcrep":
      return `${r.sp}:${r.src}:${r.by}`;
    case "hide":
      return r.item;
    default:
      return r.id;
  }
}

export const keyFor = (kind: Kind, id: string) => `${kind}:${id}`;

export function keyOf(r: Draft | StoredRecord): string {
  return keyFor(r.kind, idOfRecord(r));
}

/** The kind and id of a key, or null for a string that names no kind. */
export function splitKey(key: string): [Kind, string] | null {
  const k = key.indexOf(":");
  if (k < 0) return null;
  const kind = key.slice(0, k);
  return KINDS.has(kind as Kind) ? [kind as Kind, key.slice(k + 1)] : null;
}

export const KINDS: ReadonlySet<Kind> = new Set<Kind>([
  "space",
  "stats",
  "member",
  "thread",
  "counts",
  "followup",
  "reply",
  "run",
  "report",
  "request",
  "ban",
  "invite",
  "like",
  "save",
  "rlike",
  "asksave",
  "srcsave",
  "srcread",
  "mute",
  "block",
  "invask",
  "seen",
  "profile",
  "notif",
  "pages",
  "page",
  "skills",
  "skill",
  "hide",
  "source",
  "spacesrc",
  "srcrep",
  "apikey",
  "device",
]);

export const spaceKey = (id: string) => `space:${id}`;
export const statsKey = (sp: string) => `stats:${sp}`;
export const memberKey = (sp: string, u: string) => `member:${sp}:${u}`;
export const threadKey = (id: string) => `thread:${id}`;
export const countsKey = (th: string) => `counts:${th}`;
export const requestKey = (sp: string, u: string) => `request:${sp}:${u}`;
export const banKey = (sp: string, u: string) => `ban:${sp}:${u}`;
export const likeKey = (u: string, th: string) => `like:${u}:${th}`;
export const saveKey = (u: string, th: string) => `save:${u}:${th}`;
export const hideKey = (item: string) => `hide:${item}`;

/** The id a record holds in the global id registry, if its kind has one. */
export function idOf(r: Draft | StoredRecord): string | null {
  return ID_KINDS.has(r.kind) && "id" in r ? r.id : null;
}

/** A record's entry in the server's registry: its id for a kind that has
 * one, else its key. */
export const registryKey = (r: Draft | StoredRecord): string => idOf(r) ?? keyOf(r);

/** The space whose log holds a record, or null for a person's own records. */
export function spaceOf(r: Draft | StoredRecord): string | null {
  switch (r.kind) {
    case "space":
      return r.id;
    case "thread":
    case "counts":
    case "followup":
    case "reply":
    case "run":
    case "hide":
      return r.s;
    case "stats":
    case "member":
    case "report":
    case "request":
    case "ban":
    case "invite":
    case "pages":
    case "page":
    case "skills":
    case "skill":
    case "spacesrc":
    case "srcrep":
    case "invask":
      return r.sp;
    default:
      return null;
  }
}

/** The kinds whose records no space's log holds: a person's own records,
 * which their user log holds, and Session's catalog of sources (the
 * `catalog` log). */
export const NO_SPACE_LOG: ReadonlySet<Kind> = new Set<Kind>(
  [...KINDS].filter(
    (k) => spaceOf({ kind: k, id: "", sp: "", s: "" } as unknown as Draft) === null,
  ),
);

/** The person whose user log holds a record, or null. */
export function personOf(r: Draft | StoredRecord): string | null {
  switch (r.kind) {
    case "member":
    case "request":
    case "like":
    case "save":
    case "rlike":
    case "asksave":
    case "srcsave":
    case "srcread":
    case "mute":
    case "block":
    case "invask":
    case "seen":
    case "profile":
    case "apikey":
    case "device":
      return r.u;
    case "report":
    case "srcrep":
      return r.by;
    case "notif":
      return r.to;
    default:
      return null;
  }
}

/** The logs a record is written to: its space's log and the user log of the
 * person it belongs to; a catalog source, the `catalog` log. */
export function logsOf(r: Draft | StoredRecord): LogId[] {
  if (r.kind === "source") return ["catalog"];
  const out: LogId[] = [];
  const sp = spaceOf(r);
  if (sp !== null) out.push(`space:${sp}`);
  const u = personOf(r);
  if (u !== null) out.push(`user:${u}`);
  return out;
}

/** The fields that decide who may read a record: its kind, space, person,
 * author, maker and (a notification's) type. A write never changes them
 * (the engine's `put` checks), so an edit never moves a record to another
 * audience. */
export function audienceOf(r: Draft | StoredRecord): string {
  return JSON.stringify([
    r.kind,
    spaceOf(r),
    personOf(r),
    "u" in r ? r.u : null,
    "by" in r ? r.by : null,
    r.kind === "notif" ? r.type : null,
  ]);
}

/** The server's creation time of a record (a member's `joinedAt`), or "". */
export function createdOf(r: StoredRecord): string {
  if ("createdAt" in r) return r.createdAt;
  if (r.kind === "member") return r.joinedAt;
  return "";
}

/** The indexed scans the mutators use: a name, the kind it lists and the
 * field it matches. A scan lists the records of the kind whose field equals
 * the value (strictly: a null field matches nothing), in key order. Over
 * SQLite each is a `WHERE kind = ? AND <field> = ?` on an index. */
export const INDEXES = {
  "space.name": ["space", "name"],
  "member.sp": ["member", "sp"],
  "member.u": ["member", "u"],
  "thread.s": ["thread", "s"],
  "counts.s": ["counts", "s"],
  "followup.th": ["followup", "th"],
  "followup.par": ["followup", "par"],
  "reply.th": ["reply", "th"],
  "reply.parent": ["reply", "parent"],
  "run.th": ["run", "th"],
  "run.u": ["run", "u"],
  "report.sp": ["report", "sp"],
  "report.key": ["report", "key"],
  "request.sp": ["request", "sp"],
  "ban.sp": ["ban", "sp"],
  "invite.sp": ["invite", "sp"],
  "invite.code": ["invite", "code"],
  "like.th": ["like", "th"],
  "save.th": ["save", "th"],
  "rlike.th": ["rlike", "th"],
  "rlike.reply": ["rlike", "reply"],
  "asksave.th": ["asksave", "th"],
  "notif.to": ["notif", "to"],
  "notif.sp": ["notif", "sp"],
  "invask.sp": ["invask", "sp"],
  "page.sp": ["page", "sp"],
  "skill.sp": ["skill", "sp"],
  "hide.s": ["hide", "s"],
  "source.nurl": ["source", "nurl"],
  "spacesrc.sp": ["spacesrc", "sp"],
  "spacesrc.src": ["spacesrc", "src"],
  "spacesrc.nurl": ["spacesrc", "nurl"],
  "srcrep.sp": ["srcrep", "sp"],
} as const satisfies Record<string, readonly [Kind, string]>;

export type IndexName = keyof typeof INDEXES;
export type IndexKind<N extends IndexName> = (typeof INDEXES)[N][0];

/** Whether a record is listed by an index under `value`. */
export function inIndex(r: StoredRecord | Draft, index: IndexName, value: string): boolean {
  const [kind, field] = INDEXES[index];
  return r.kind === kind && (r as unknown as Record<string, unknown>)[field] === value;
}
