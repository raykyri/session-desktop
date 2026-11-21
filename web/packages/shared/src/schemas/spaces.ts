// Zod schemas for spaces: the contract of the server half, the shared
// mutators and the web client's replica. Users see "channels"; code and wire
// keep `space`.
//
// This is the first-draft mock's contract (`./spaces.deferred.ts`) revised
// by the implementation plan (`web/docs/15-implementation-plan/`, `01` C1 to
// C18, `03` §1, `04` §11). What the build does not serve stays in
// `./spaces.deferred.ts`, so the mock keeps validating.
//
// The wire is the sync protocol, not a REST API: a client reads records
// (snapshot and pull of a space log or its own user log) and writes by
// sending a mutator's name and input. The record schemas below are the
// stored shape: what mutators write and what snapshots and pulls carry.
// - Every record has `kind` and an integer `rev`, which the store sets on
//   each write.
// - Optional fields are `null` when absent, so two writes of the same state
//   produce equal records.
// - Counts (`members`, `posts`, `saves`, `r`) are stored fields that
//   mutators maintain. Per-viewer fields (`saved`, `mine`) are computed on
//   the client and never stored or served. There are no likes (C1).
// - A record's key is `<kind>:<id>` for kinds with an id, and is built from
//   the records it relates otherwise (`member:<space>:<user>`); see
//   `spaceRecordKeys`.
// - Ids are ULIDs. A client makes the first id of a write (in the input) and
//   the mutation id; later ids derive from the mutation id and an ordinal.
//   Space ids are ULIDs too (C14); URLs use the space's name.
//
// Package root: this module is exported as the namespace `spaces`
// (`../schemas/index.ts`), its types as the type namespace `Spaces`
// (`../types/spaces.ts`).

import { z } from "zod";

// ---- primitives ----

/** A ULID (Crockford base32, 26 characters). */
export const spaceUlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

/** A thread's id. */
export const spaceThreadIdSchema = spaceUlidSchema;

/** A space's id: a ULID (C14). */
export const spaceIdSchema = spaceUlidSchema;

/** A person's handle (`ines.v`). Account handles follow `04` §3.1; the
 * schema accepts any non-empty handle so that records of earlier accounts
 * still parse. */
export const spaceHandleSchema = z.string().min(1);

/** A space's name: lower case, `[a-z0-9-]`, unique across all spaces. The
 * creation rule (`04` B1) lives with the mutator; this is the stored form. */
export const spaceNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

/** An ISO instant with seconds, in UTC (`2026-11-16T10:00:00Z`). */
export const spaceIsoTimeSchema = z.iso.datetime();

const count = z.number().int().nonnegative();
const rev = count;

/** The node an ask, a run or a comment hangs under: `r` (the thread's root
 * ask) or a node's id. */
export const askNodeRefSchema = z.union([z.literal("r"), spaceUlidSchema]);

/** An item that can be moderated, `"<kind>:<thread>[:<item>]"`: `a:` an ask
 * thread, `p:` a post, `f:` an ask node, `r:` a reply, `c:` a comment (C4). */
export const moderationKeySchema = z
  .string()
  .regex(/^(?:[ap]:[0-9A-HJKMNP-TV-Z]{26}|[frc]:[0-9A-HJKMNP-TV-Z]{26}:[0-9A-HJKMNP-TV-Z]{26})$/);

/** A moderated record's state. */
export const moderationStateSchema = z.enum(["hidden", "removed"]);

// ---- bounds (`04` §10, `03` G1, G2) ----

export const SPACE_DESC_MAX = 300;
export const MODERATION_NOTE_MAX = 300;
export const ASK_TEXT_MAX = 8000;
export const QUOTE_MAX = 2000;
export const LOOKUP_PHRASE_MAX = 80;
/** A channel invite link lasts 1 to 30 days (`04` B4). */
export const INVITE_DAYS_MAX = 30;
/** Queued runs per person before `pre` refuses with `queue_full` (`03` L1). */
export const QUEUED_RUNS_PER_USER = 20;

// ---- roles and memberships (C18) ----

/** A role in a space: the owner (one per space, for its lifetime) or a
 * member. There are no admins or moderators. */
export const spaceMemberRoleSchema = z.enum(["member", "owner"]);

/** The caller's role in a space, as a label. */
export const spaceRoleSchema = z.enum(["Owner", "Member"]);

// ---- models and runs (`03` §1, K12) ----

/** A run's reasoning effort. Every new run carries one; it is never null on
 * a node or a run. The models' own lists (`ModelEntry.efforts`) decide which
 * a model accepts. */
export const spaceEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

/** A model registry id (`../models/registry.ts`). The registry check is the
 * mutator's `pre` stage. */
export const spaceModelSchema = z.string().min(1).max(100);

/** A run's state. `superseded` is server bookkeeping and never served. */
export const runStatusSchema = z.enum([
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
  "interrupted",
]);

/** The provider error class of a run that failed with `error`. */
export const runErrorClassSchema = z.enum([
  "auth",
  "content_filter",
  "context_too_long",
  "provider_unavailable",
  "network",
  "timeout",
  "unknown",
]);

/** Why a run ended without an answer: stopped (cancelled or deleted), tokens
 * (nothing could pay), key (the provider rejected the key), rate (the
 * provider limits requests; `at`: when Run again works, ms), access (the
 * asker could no longer read the thread when the run started), interrupted
 * (the server could not resume it), error (a provider error, `cls`). */
export const runFailureSchema = z.object({
  why: z.enum(["stopped", "tokens", "key", "rate", "access", "interrupted", "error"]),
  at: z.number().nullable(),
  cls: runErrorClassSchema.nullable(),
});

/** Who paid for a run (`03` K9). */
export const runBillSchema = z.enum([
  "included",
  "key:anthropic",
  "key:openai",
  "included+key:anthropic",
]);

// ---- records: the stored shape ----

export const spaceVisibilitySchema = z.enum(["open", "private"]);

/** A space (`space:<id>`). Public: its name, About, owner and member count
 * are readable by anyone with its id, a private space's included (C9). Its
 * activity is the `stats` record, read with its content. `frozen`: the
 * owner's account was deleted; the space is readable and closed to writes
 * other than deleting one's own items and leaving (`04` B6). */
export const spaceRecordSchema = z.object({
  kind: z.literal("space"),
  id: spaceIdSchema,
  name: spaceNameSchema,
  /** About, at most 300 characters; "" for none. */
  desc: z.string().max(SPACE_DESC_MAX),
  vis: spaceVisibilitySchema,
  members: count,
  owner: spaceHandleSchema,
  frozen: z.boolean(),
  createdAt: spaceIsoTimeSchema,
  rev,
});

/** A space's activity (`stats:<space>`), read with its content. */
export const statsRecordSchema = z.object({
  kind: z.literal("stats"),
  sp: spaceIdSchema,
  posts: count,
  /** The time of the last thread, or the space's creation. */
  updatedAt: spaceIsoTimeSchema,
  rev,
});

/** A membership (`member:<space>:<user>`), in the space log and the
 * person's user log. `adm`: the admission id, derived from the write that
 * let the person in; `members.remove` compares it (stale intent). */
export const memberRecordSchema = z.object({
  kind: z.literal("member"),
  sp: spaceIdSchema,
  u: spaceHandleSchema,
  role: spaceMemberRoleSchema,
  adm: z.string().min(1),
  joinedAt: spaceIsoTimeSchema,
  rev,
});

/** A thread (`thread:<id>`): an ask, answered by a run, or a post. An ask's
 * root is the thread itself (`r` in node references); its answer is
 * `answer:<thread>`.
 *
 * Removal (C12) erases the text (`q`, `t`, `sum`) and keeps `id`, `s`, `k`,
 * `u`, `createdAt`, `mod`, `modBy` and `modNote`. `u` is served to the
 * author only once the thread is removed: every other reader, the owner
 * included, gets `u: null`. Hidden text is served to the author and the
 * owner; everyone else gets the text fields blank. */
export const threadRecordSchema = z.object({
  kind: z.literal("thread"),
  id: spaceThreadIdSchema,
  s: spaceIdSchema,
  u: spaceHandleSchema.nullable(),
  k: z.enum(["ask", "post"]),
  /** The question or the post's text; "" once deleted or removed. */
  q: z.string(),
  /** The title; null: the client shows the question. */
  t: z.string().nullable(),
  /** The root answer's summary line. */
  sum: z.string().nullable(),
  /** Tokens the root answer used, and the number of pages it cites. */
  tok: count,
  src: count,
  /** The root ask's model and effort (null for a post). Stored, shown
   * nowhere in the UI. */
  model: spaceModelSchema.nullable(),
  effort: spaceEffortSchema.nullable(),
  /** The root ask's run is queued or running. */
  running: z.boolean(),
  edited: z.boolean(),
  /** The author deleted it; it keeps its place as an empty shell while it
   * has asks or replies under it. */
  del: z.boolean(),
  /** Deleted with nothing under it: lists leave it out. */
  gone: z.boolean(),
  mod: moderationStateSchema.nullable(),
  /** Who removed it, and the reason shown with the placeholder (C12). */
  modBy: spaceHandleSchema.nullable(),
  modNote: z.string().max(MODERATION_NOTE_MAX).nullable(),
  /** The thread and node it was opened from (`03` G5), or null. */
  from: z.object({ th: spaceThreadIdSchema, node: spaceUlidSchema }).nullable(),
  createdAt: spaceIsoTimeSchema,
  updatedAt: spaceIsoTimeSchema,
  rev,
});

/** A removed thread as stored (C12; `04` §6.2): the placeholder keeps its
 * id, space, kind, author, times, `mod`, `modBy` and `modNote`, and nothing
 * else of the removed content: no text, title, summary, token or source
 * count, model, effort or source node. Readers other than the author get it
 * with `u: null`. */
export const removedThreadRecordSchema = threadRecordSchema.extend({
  q: z.literal(""),
  t: z.null(),
  sum: z.null(),
  tok: z.literal(0),
  src: z.literal(0),
  model: z.null(),
  effort: z.null(),
  running: z.literal(false),
  edited: z.literal(false),
  mod: z.literal("removed"),
  from: z.null(),
});

/** A thread's counts (`counts:<thread>`), read with the thread, so a save or
 * a branch does not change the thread's rev (C1, C5).
 * - `saves`: the number of people who saved it. In a private space a count
 *   below 3 is served and stored here as 0; the true count is a server-only
 *   value outside the change log (S6), which reads as unknown on a client.
 * - `r`: every ask node under the root (asks and look-ups, not comments)
 *   for an ask; every reply at every depth for a post. */
export const countsRecordSchema = z.object({
  kind: z.literal("counts"),
  th: spaceThreadIdSchema,
  s: spaceIdSchema,
  saves: count,
  r: count,
  rev,
});

/** The ask-node kinds (C3): an ask (Continue, Branch, Branch here) or a
 * look-up of a 1-4 word phrase. */
export const askNodeKindSchema = z.enum(["ask", "lookup"]);

/** An ask node under a thread's root (`node:<id>`, C3; `03` §1). Its answer
 * is `answer:<id>`. `q` holds the prompt; for a look-up the mutator builds it
 * from a versioned template (`tpl`) and the client shows `look` instead.
 * `quote` is the passage of the parent's answer it was started from, `b` the
 * index of the passage that holds the quote: a top-level block, or an item
 * of a top-level list (the mockup's `blocksOf`: a top-level paragraph, list
 * item of a top-level list, heading or table). `promoted`: the thread it was
 * opened as (`03` G5). */
export const nodeRecordSchema = z
  .object({
    kind: z.literal("node"),
    id: spaceUlidSchema,
    th: spaceThreadIdSchema,
    s: spaceIdSchema,
    par: askNodeRefSchema,
    k: askNodeKindSchema,
    u: spaceHandleSchema,
    q: z.string(),
    look: z.string().max(LOOKUP_PHRASE_MAX).nullable(),
    quote: z.string().max(QUOTE_MAX).nullable(),
    b: count.nullable(),
    tpl: count.nullable(),
    model: spaceModelSchema,
    effort: spaceEffortSchema,
    /** The node's current run. */
    run: spaceUlidSchema,
    promoted: spaceThreadIdSchema.nullable(),
    mod: moderationStateSchema.nullable(),
    del: z.boolean(),
    createdAt: spaceIsoTimeSchema,
    rev,
  })
  .refine(
    // an ask has no phrase or template; a look-up has its template version, and
    // its phrase until it is removed, deleted or redacted
    (n) => (n.k === "ask" ? n.look === null && n.tpl === null : n.tpl !== null),
    { message: "look and tpl are null for an ask; a look-up has tpl" },
  );

/** A run of an ask (`run:<id>`, C17; `03` §1). A run record with status
 * `queued` is the run queue: the dispatcher claims it with a compare-and-set
 * (`03` E2). `node`: `r` for the thread's root ask. `note`: the stop note of
 * a run that ended `complete` before the model finished ("Stopped: this
 * week's included tokens ran out."). In-flight text is not in the record:
 * it travels as `run.delta` events (`spaceRunDeltaSchema`). */
export const runRecordSchema = z.object({
  kind: z.literal("run"),
  id: spaceUlidSchema,
  th: spaceThreadIdSchema,
  s: spaceIdSchema,
  node: askNodeRefSchema,
  /** The asker, who pays. */
  u: spaceHandleSchema,
  model: spaceModelSchema,
  effort: spaceEffortSchema,
  status: runStatusSchema,
  attempt: z.number().int().positive(),
  /** Progress, 0 to 3 (planning, searching, reading, writing). */
  step: z.number().int().min(0).max(3),
  fail: runFailureSchema.nullable(),
  tok: count.nullable(),
  bill: runBillSchema.nullable(),
  note: z.string().nullable(),
  createdAt: spaceIsoTimeSchema,
  startedAt: spaceIsoTimeSchema.nullable(),
  finishedAt: spaceIsoTimeSchema.nullable(),
  rev,
});

/** A committed turn of a run (`turn:<run>:<attempt>:<n>`). Blocks are text
 * (Markdown), tool uses, tool results and citations. */
export const turnRecordSchema = z.object({
  kind: z.literal("turn"),
  run: spaceUlidSchema,
  attempt: z.number().int().positive(),
  n: count,
  th: spaceThreadIdSchema,
  s: spaceIdSchema,
  role: z.enum(["user", "assistant", "tool"]),
  blocks: z.array(z.object({ type: z.string() }).loose()),
  createdAt: spaceIsoTimeSchema,
  rev,
});

/** A page an answer cites: [title, host, note]. */
export const citedPageSchema = z.tuple([z.string(), z.string(), z.string()]);

/** An answer (`answer:<node>`; the root ask's is `answer:<thread>`, with
 * `node: "r"`, as runs and comments name the root): the final answer as
 * Markdown. The server stores no HTML (C3). `u` is the
 * asker; `mod` follows its node's (or root thread's) moderation state, so a
 * hidden ask's answer is served to the asker and the owner only. */
export const answerRecordSchema = z.object({
  kind: z.literal("answer"),
  node: askNodeRefSchema,
  th: spaceThreadIdSchema,
  s: spaceIdSchema,
  u: spaceHandleSchema,
  md: z.string(),
  pages: z.array(citedPageSchema),
  tok: count,
  run: spaceUlidSchema,
  attempt: z.number().int().positive(),
  mod: moderationStateSchema.nullable(),
  rev,
});

/** A reply to a post (`reply:<id>`), nested to any depth (the client caps
 * the indent): `parent` is a reply of the same post, or null. */
export const replyRecordSchema = z.object({
  kind: z.literal("reply"),
  id: spaceUlidSchema,
  th: spaceThreadIdSchema,
  s: spaceIdSchema,
  u: spaceHandleSchema,
  t: z.string(),
  parent: spaceUlidSchema.nullable(),
  /** Changed by its author since it was written. */
  edited: z.boolean(),
  /** Deleted by its author while it had replies: an empty shell (`t: ""`). */
  del: z.boolean(),
  mod: moderationStateSchema.nullable(),
  createdAt: spaceIsoTimeSchema,
  rev,
});

/** A comment on an ask node (`comment:<id>`, C4): a discussion under a
 * branch without a run, nested like post replies to any depth: `parent` is
 * a comment on the same node, or null. `node`: `r` for the root.
 * Moderation key `c:<thread>:<comment>`. */
export const commentRecordSchema = z.object({
  kind: z.literal("comment"),
  id: spaceUlidSchema,
  th: spaceThreadIdSchema,
  s: spaceIdSchema,
  node: askNodeRefSchema,
  parent: spaceUlidSchema.nullable(),
  u: spaceHandleSchema,
  t: z.string(),
  /** Changed by its author since it was written. */
  edited: z.boolean(),
  /** Deleted by its author while it had comments: an empty shell (`t: ""`). */
  del: z.boolean(),
  mod: moderationStateSchema.nullable(),
  createdAt: spaceIsoTimeSchema,
  rev,
});

/** A ban (`ban:<space>:<user>`), read by the space's owner. Its id is
 * `<space>:<user>`, outside the ULID registry. */
export const banRecordSchema = z.object({
  kind: z.literal("ban"),
  id: z.string().min(1),
  sp: spaceIdSchema,
  u: spaceHandleSchema,
  createdAt: spaceIsoTimeSchema,
  rev,
});

/** A channel invite link (`invite:<id>`): one use, made by the space's
 * owner, read by the owner only. `code` is made by the server in `pre` (128
 * bits, base32); the link is `<origin>/c/<name>#<code>`. */
export const inviteRecordSchema = z.object({
  kind: z.literal("invite"),
  id: spaceUlidSchema,
  code: z.string().min(1),
  by: spaceHandleSchema,
  sp: spaceIdSchema,
  expiresAt: spaceIsoTimeSchema,
  /** Why the link no longer works (`Used`, `Revoked`), or null. */
  dead: z.string().nullable(),
  usedBy: spaceHandleSchema.nullable(),
  createdAt: spaceIsoTimeSchema,
  rev,
});

/** A saved thread (`save:<user>:<thread>`), in the person's user log, served
 * only while they may read the thread's space. Who saved a thread is not
 * served to anyone else; the count is in `counts`. */
export const saveRecordSchema = z.object({
  kind: z.literal("save"),
  u: spaceHandleSchema,
  th: spaceThreadIdSchema,
  createdAt: spaceIsoTimeSchema,
  rev,
});

/** The notification kinds (C16). */
export const notificationTypeSchema = z.enum([
  "mention",
  "reply",
  "branch",
  "comment",
  "removed",
  "invite_used",
]);

/** A notification (`notif:<id>`) in the recipient's user log, written in the
 * same transaction as the write that causes it (the mutator's `notify`
 * stage). It carries ids, no item text; a `removed` one carries the owner's
 * note in `note`, an `invite_used` one the code that was used, which admits
 * nobody any more. Served only while the recipient may read `sp`.
 * - `item`: the key of the record it is about (`reply:<id>`, `node:<id>`,
 *   `comment:<id>`, `thread:<id>`), null for `invite_used`.
 * - `actor`: who caused it (the new member for `invite_used`), null for
 *   `removed`.
 * - `n`: how many writes it stands for. `reply`, `branch` and `comment`
 *   coalesce: at most one unread notification per (recipient, type,
 *   thread); a later one updates it. */
export const notificationRecordSchema = z.object({
  kind: z.literal("notif"),
  id: spaceUlidSchema,
  to: spaceHandleSchema,
  type: notificationTypeSchema,
  sp: spaceIdSchema.nullable(),
  th: spaceThreadIdSchema.nullable(),
  item: z.string().nullable(),
  actor: spaceHandleSchema.nullable(),
  n: z.number().int().positive(),
  note: z.string().max(MODERATION_NOTE_MAX).nullable(),
  read: z.boolean(),
  createdAt: spaceIsoTimeSchema,
  rev,
});

/** A person's preferences (`prefs:<user>`, C13), in their user log. */
export const prefsRecordSchema = z.object({
  kind: z.literal("prefs"),
  u: spaceHandleSchema,
  layout: z.enum(["centred", "wide"]),
  rev,
});

/** A moderation log entry (`modlog:<id>`, C12), in the space log, read by
 * the owner only and deleted 180 days after `createdAt`. `act` is the plan's
 * `kind` (renamed: `kind` is the record kind). For a removal, `item` is the
 * moderation key and `author` the item's author; for a ban or an unban,
 * `item` is null and `author` the person. No text of a removed item. */
export const modlogRecordSchema = z.object({
  kind: z.literal("modlog"),
  id: spaceUlidSchema,
  sp: spaceIdSchema,
  act: z.enum(["remove", "ban", "unban"]),
  item: moderationKeySchema.nullable(),
  by: spaceHandleSchema,
  author: spaceHandleSchema,
  note: z.string().max(MODERATION_NOTE_MAX).nullable(),
  createdAt: spaceIsoTimeSchema,
  rev,
});

/** A replicated record of any kind, by `kind`. */
export const storedRecordSchema = z.discriminatedUnion("kind", [
  spaceRecordSchema,
  statsRecordSchema,
  memberRecordSchema,
  threadRecordSchema,
  countsRecordSchema,
  nodeRecordSchema,
  runRecordSchema,
  turnRecordSchema,
  answerRecordSchema,
  replyRecordSchema,
  commentRecordSchema,
  banRecordSchema,
  inviteRecordSchema,
  saveRecordSchema,
  notificationRecordSchema,
  prefsRecordSchema,
  modlogRecordSchema,
]);

/** How each kind is keyed. */
export const spaceRecordKeys = {
  space: "space:<id>",
  stats: "stats:<space>",
  member: "member:<space>:<user>",
  thread: "thread:<id>",
  counts: "counts:<thread>",
  node: "node:<id>",
  run: "run:<id>",
  turn: "turn:<run>:<attempt>:<n>",
  answer: "answer:<node> (answer:<thread> for the root)",
  reply: "reply:<id>",
  comment: "comment:<id>",
  ban: "ban:<space>:<user>",
  invite: "invite:<id>",
  save: "save:<user>:<thread>",
  notif: "notif:<id>",
  prefs: "prefs:<user>",
  modlog: "modlog:<id>",
} as const satisfies Record<z.infer<typeof storedRecordSchema>["kind"], string>;

// ---- mutators: names, inputs and results ----

const ulid = spaceUlidSchema;
const nullResult = z.null();
/** `base` of a write that compares the target's rev (stale intent). */
const baseRev = z.strictObject({ rev: count });
const text = (max: number) => z.string().max(max);
/** Text a write must carry: a question, a post, a reply, a comment, a look-up
 * phrase (the mutator also refuses text that is only spaces). */
const words = (max: number) => z.string().min(1).max(max);

/** `threads.create` with `from` (`03` G5): a node opened as its own thread,
 * in the node's space. The server copies the node's question and answer and
 * the branch's author, so the input names only the new id and the node: no
 * `kind`, `q`, model or space. No run starts. */
export const promoteThreadInputSchema = z.strictObject({
  id: ulid,
  from: z.strictObject({ th: spaceThreadIdSchema, node: spaceUlidSchema }),
});

/** `threads.create`: an ask, which writes the thread and its root run
 * (`queued`), a post, or a node opened as its own thread (`from`). */
export const createThreadInputSchema = z.union([
  z.discriminatedUnion("kind", [
    z.strictObject({
      id: ulid,
      space: spaceIdSchema,
      kind: z.literal("ask"),
      q: words(ASK_TEXT_MAX),
      title: z.string().nullable().optional(),
      model: spaceModelSchema,
      effort: spaceEffortSchema,
    }),
    z.strictObject({
      id: ulid,
      space: spaceIdSchema,
      kind: z.literal("post"),
      q: words(ASK_TEXT_MAX),
      title: z.string().nullable().optional(),
    }),
  ]),
  promoteThreadInputSchema,
]);

/** `research.forkNode` (C3; `03` §2.1): Continue, Branch and Branch here
 * (`kind: "ask"`), and Look up (`kind: "lookup"`, which sends the phrase and
 * no `q`: the mutator builds the prompt). `parent`: `r` or a node of the
 * thread. Writes the node and its run (`queued`). */
export const forkNodeInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    id: ulid,
    thread: spaceThreadIdSchema,
    parent: askNodeRefSchema,
    kind: z.literal("ask"),
    q: words(ASK_TEXT_MAX),
    quote: text(QUOTE_MAX).optional(),
    b: count.optional(),
    model: spaceModelSchema,
    effort: spaceEffortSchema,
  }),
  z.strictObject({
    id: ulid,
    thread: spaceThreadIdSchema,
    parent: askNodeRefSchema,
    kind: z.literal("lookup"),
    look: words(LOOKUP_PHRASE_MAX),
    // the passage the phrase was selected in: required, so the whole-word
    // check always runs (M1b review 13)
    quote: words(QUOTE_MAX),
    b: count.optional(),
    model: spaceModelSchema,
    effort: spaceEffortSchema,
  }),
]);

const nodeInput = { thread: spaceThreadIdSchema, node: askNodeRefSchema };

/** The mentions a post, reply or comment made (02 N16): `notified`, the
 * handles that got a mention notification; `notMembers`, the mentioned
 * handles that are not Session accounts. Server values: a client's
 * prediction has both empty. */
const mentioned = {
  notified: z.array(spaceHandleSchema),
  notMembers: z.array(z.string()),
};

/** A delete's answer: `kept`, the item stays as an empty shell for what is
 * under it. Null for an author who may no longer read the item. */
export const deleteResultSchema = z.object({ kept: z.boolean() }).nullable();

/** Who may write: anyone signed in (`user`), a member (in an open space,
 * anyone signed in, who joins first in the client), the item's author, or
 * the space's owner. */
export const mutatorWhoSchema = z.enum(["user", "member", "author", "owner"]);

/** Every mutator: its input, its result, who may call it, and whether it is
 * online only (never queued; `spaces.create`). Mutator names are the
 * procedure names of the first-draft contract, with `saved.toggle` renamed
 * `saved.set` and `comments.*` and `prefs.set` added (`01` U5). Join
 * requests are not built (C9, C10). */
export const spaceMutators = {
  // -- spaces (C9, C11, C14, C18)
  "spaces.create": {
    who: "user",
    online: true,
    input: z.strictObject({
      id: ulid,
      name: z.string().min(1).max(64),
      desc: text(SPACE_DESC_MAX).optional(),
      vis: spaceVisibilitySchema.optional(),
    }),
    result: z.object({ id: spaceIdSchema }),
  },
  /** About only; the owner is the only editor, so there is no `base`. */
  "spaces.update": {
    who: "owner",
    online: false,
    input: z.strictObject({ id: spaceIdSchema, desc: text(SPACE_DESC_MAX) }),
    result: nullResult,
  },
  /** A private space needs a channel invite link's code. */
  "spaces.join": {
    who: "user",
    online: false,
    input: z.strictObject({ space: spaceIdSchema, invite: z.string().max(64).optional() }),
    result: nullResult,
  },
  /** The owner cannot leave (`PRECONDITION_FAILED`). */
  "spaces.leave": {
    who: "member",
    online: false,
    input: z.strictObject({ space: spaceIdSchema }),
    result: nullResult,
  },
  // -- threads
  "threads.create": {
    who: "member",
    online: false,
    input: createThreadInputSchema,
    result: z.object({
      id: spaceThreadIdSchema,
      run: spaceUlidSchema.nullable(),
      ...mentioned,
    }),
  },
  "threads.update": {
    who: "author",
    online: false,
    input: z.strictObject({ id: spaceThreadIdSchema, q: words(ASK_TEXT_MAX), base: baseRev }),
    result: nullResult,
  },
  /** A thread deleted while it has asks or replies under it stays as an
   * empty shell (C15); the server does not enforce the mockup's "only while
   * nobody else has responded". */
  "threads.delete": {
    who: "author",
    online: false,
    input: z.strictObject({ id: spaceThreadIdSchema }),
    result: deleteResultSchema,
  },
  /** `on` is required: two devices that save the same thread do not cancel
   * out. Threads only (C2). */
  "saved.set": {
    who: "user",
    online: false,
    input: z.strictObject({ kind: z.literal("thread"), id: spaceThreadIdSchema, on: z.boolean() }),
    result: z.object({ on: z.boolean() }),
  },
  // -- ask nodes and runs (`03` §2)
  "research.forkNode": {
    who: "member",
    online: false,
    input: forkNodeInputSchema,
    result: z.object({ id: spaceUlidSchema, run: spaceUlidSchema }),
  },
  "followups.update": {
    who: "author",
    online: false,
    input: z.strictObject({ ...nodeInput, q: words(ASK_TEXT_MAX), base: baseRev }),
    result: nullResult,
  },
  "followups.delete": {
    who: "author",
    online: false,
    input: z.strictObject(nodeInput),
    result: deleteResultSchema,
  },
  "research.cancelNode": {
    who: "author",
    online: false,
    input: z.strictObject(nodeInput),
    result: nullResult,
  },
  /** Run again: a new attempt with the model and effort the person picks.
   * `base.attempt`: the attempt of the run the person saw stop; STALE when
   * the run was retried since (a stale offline retry would otherwise start
   * another attempt with the old model and effort). */
  "research.retryNode": {
    who: "author",
    online: false,
    input: z.strictObject({
      ...nodeInput,
      model: spaceModelSchema,
      effort: spaceEffortSchema,
      base: z.strictObject({ attempt: count.min(1) }),
    }),
    result: nullResult,
  },
  // -- replies to posts
  "research.createPostFollowUp": {
    who: "member",
    online: false,
    input: z.strictObject({
      id: ulid,
      thread: spaceThreadIdSchema,
      t: words(ASK_TEXT_MAX),
      parent: ulid.optional(),
    }),
    result: z.object(mentioned),
  },
  "replies.update": {
    who: "author",
    online: false,
    input: z.strictObject({ id: ulid, t: words(ASK_TEXT_MAX), base: baseRev }),
    result: nullResult,
  },
  "replies.delete": {
    who: "author",
    online: false,
    input: z.strictObject({ id: ulid }),
    result: deleteResultSchema,
  },
  // -- comments (C4)
  "comments.create": {
    who: "member",
    online: false,
    input: z.strictObject({
      id: ulid,
      thread: spaceThreadIdSchema,
      node: askNodeRefSchema,
      t: words(ASK_TEXT_MAX),
      parent: ulid.optional(),
    }),
    result: z.object(mentioned),
  },
  "comments.update": {
    who: "author",
    online: false,
    input: z.strictObject({ id: ulid, t: words(ASK_TEXT_MAX), base: baseRev }),
    result: nullResult,
  },
  "comments.delete": {
    who: "author",
    online: false,
    input: z.strictObject({ id: ulid }),
    result: deleteResultSchema,
  },
  // -- members (C18): the owner acts on anyone but themselves
  /** `base.adm`: the member's admission id as the owner saw it; STALE when
   * the person was let in again since. */
  "members.remove": {
    who: "owner",
    online: false,
    input: z.strictObject({
      space: spaceIdSchema,
      user: spaceHandleSchema,
      base: z.strictObject({ adm: z.string().max(64) }),
    }),
    result: nullResult,
  },
  /** Applies to the person as they are now; no `base`. */
  "members.ban": {
    who: "owner",
    online: false,
    input: z.strictObject({ space: spaceIdSchema, user: spaceHandleSchema }),
    result: nullResult,
  },
  "members.unban": {
    who: "owner",
    online: false,
    input: z.strictObject({ space: spaceIdSchema, user: spaceHandleSchema }),
    result: nullResult,
  },
  // -- channel invite links (`04` §5)
  "invites.create": {
    who: "owner",
    online: false,
    input: z.strictObject({
      id: ulid,
      space: spaceIdSchema,
      days: z.number().int().min(1).max(INVITE_DAYS_MAX),
    }),
    result: z.object({ id: spaceUlidSchema, code: z.string() }),
  },
  "invites.revoke": {
    who: "owner",
    online: false,
    input: z.strictObject({ id: ulid }),
    result: nullResult,
  },
  "invites.restore": {
    who: "owner",
    online: false,
    input: z.strictObject({ id: ulid }),
    result: nullResult,
  },
  // -- moderation (C12): no reporting
  /** `shown` carries `base.rev` of the item and answers STALE when it
   * differs; `hidden` and `removed` apply to the item as it is. `note` is the
   * reason shown with a removal. */
  "moderation.decide": {
    who: "owner",
    online: false,
    input: z.discriminatedUnion("decision", [
      z.strictObject({
        item: moderationKeySchema,
        decision: z.literal("hidden"),
        base: baseRev.optional(),
      }),
      z.strictObject({
        item: moderationKeySchema,
        decision: z.literal("removed"),
        note: text(MODERATION_NOTE_MAX).optional(),
        base: baseRev.optional(),
      }),
      z.strictObject({ item: moderationKeySchema, decision: z.literal("shown"), base: baseRev }),
    ]),
    result: nullResult,
  },
  // -- notifications and preferences
  "notifications.markRead": {
    who: "user",
    online: false,
    input: z.strictObject({ id: ulid }),
    result: nullResult,
  },
  "notifications.markAllRead": {
    who: "user",
    online: false,
    input: z.strictObject({}),
    result: nullResult,
  },
  "prefs.set": {
    who: "user",
    online: false,
    input: z.strictObject({ layout: prefsRecordSchema.shape.layout }),
    result: nullResult,
  },
} satisfies Record<
  string,
  {
    who: z.infer<typeof mutatorWhoSchema>;
    online: boolean;
    input: z.ZodType;
    result: z.ZodType;
  }
>;

export type SpaceMutatorName = keyof typeof spaceMutators;

// ---- runs: streamed deltas (C17; `03` T2) ----

/** An ephemeral delta of a run's in-flight Markdown on the sync SSE stream:
 * no event id, not replayed, at most one per 50 ms per run. A client applies
 * it only when `seq` is the next for (`run`, `attempt`). */
export const spaceRunDeltaSchema = z.object({
  type: z.literal("run.delta"),
  run: spaceUlidSchema,
  attempt: z.number().int().positive(),
  seq: count,
  text: z.string(),
});

// ---- accounts and account invites (C8; `04` §3) ----

/** A Session account: `waiting` until it redeems an account invite (it then
 * reads open spaces and writes nothing), `active` after. There is no
 * suspended state. */
export const userStatusSchema = z.enum(["waiting", "active"]);

/** The sign-in provider an account was created with; one per account. */
export const userProviderSchema = z.enum(["github", "x"]);

/** An account invite code: 30 bits, `SESS-XXXX-XX` in Crockford base32. The
 * link carries it in the fragment (`/i#<code>`); the server stores a hash
 * and an encryption for the creator. */
export const accountInviteCodeSchema = z
  .string()
  .regex(/^SESS-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/);

/** An account invite as its creator lists it. `code` is shown while the link
 * is open, and null once it is used or revoked. */
export const accountInviteSchema = z.object({
  id: spaceUlidSchema,
  code: accountInviteCodeSchema.nullable(),
  createdAt: spaceIsoTimeSchema,
  usedBy: spaceHandleSchema.nullable(),
  usedAt: spaceIsoTimeSchema.nullable(),
  revokedAt: spaceIsoTimeSchema.nullable(),
});

/** A node of the invite tree (`members.tree`): who invited whom. A root
 * invite (printed by `npm run db:admin -- --invite`) has no inviter. */
export interface InviteTreeNode {
  u: string;
  kids: InviteTreeNode[];
}
export const inviteTreeNodeSchema: z.ZodType<InviteTreeNode> = z.object({
  u: spaceHandleSchema,
  get kids() {
    return z.array(inviteTreeNodeSchema);
  },
});

/** One page, newest first; `nextCursor` null on the last page. */
export const spacePageSchema = <Item extends z.ZodType>(item: Item) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

/** A paged query's own input: an opaque cursor and a limit from 1 to 100. */
export const spacePageInput = {
  cursor: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

/** Online-only tRPC procedures: not replicated records, not mutators. At most
 * 3 open account invites per active member; `auth.checkInvite` has one
 * failure answer, `unusable`, for used, revoked and unknown codes. */
export const spaceOnlineProcedures = {
  "auth.checkInvite": {
    input: z.strictObject({ code: z.string().max(64) }),
    output: z.object({ status: z.enum(["open", "unusable"]) }),
  },
  "accountInvites.create": {
    input: z.strictObject({}),
    output: z.object({ id: spaceUlidSchema, code: accountInviteCodeSchema }),
  },
  "accountInvites.list": { input: z.strictObject({}), output: z.array(accountInviteSchema) },
  "accountInvites.revoke": { input: z.strictObject({ id: spaceUlidSchema }), output: nullResult },
  "accountInvites.redeem": {
    input: z.strictObject({ code: z.string().max(64) }),
    output: nullResult,
  },
  "members.tree": { input: z.strictObject({}), output: z.array(inviteTreeNodeSchema) },
  /** The All scope (C7): open spaces, the caller's or not. */
  "spaces.directory": {
    input: z.strictObject(spacePageInput),
    output: spacePageSchema(spaceRecordSchema),
  },
  /** A feed of threads for readers without a replica of the space (signed
   * out, waiting, or the All scope; `01` R5). */
  "threads.feed": {
    input: z.strictObject({
      scope: z.enum(["joined", "managed", "all"]).optional(),
      space: spaceIdSchema.optional(),
      ...spacePageInput,
    }),
    output: spacePageSchema(threadRecordSchema),
  },
} satisfies Record<string, { input: z.ZodType; output: z.ZodType }>;

// ---- errors (`01` Y2) ----

/** Every answer code. tRPC's codes (`03-api-and-events.md` §1) and the ones
 * the sync protocol adds:
 * - `STALE`: the record a decision acts on is not in the state the client
 *   saw (`base.rev`, an admission id).
 * - `CLOCK_SKEW`: the envelope's `clientTime` is more than a minute from the
 *   server's time. Carries `serverTime`; not recorded.
 * - `EXPIRED`: the write is too old to apply (its mutation id, `queuedAt` or a
 *   new id is more than 4 days old or a minute ahead on the device's clock,
 *   or an online-only write waited). Recorded.
 * - `OUT_OF_ORDER`: `seq` is not the client's next. Carries `expectedSeq`;
 *   not recorded.
 * - `WRONG_CLIENT`: the client id is unknown, expired or another user's. Not
 *   recorded.
 * - `UPGRADE_REQUIRED`: the protocol version is below the minimum; the
 *   client reloads. Not recorded.
 * - `TOO_LARGE`: the envelope is over 256 KB as JSON. Not recorded. */
export const spaceErrorCodeSchema = z.enum([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "METHOD_NOT_SUPPORTED",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "TOO_MANY_REQUESTS",
  "INTERNAL_SERVER_ERROR",
  "SERVICE_UNAVAILABLE",
  "STALE",
  "CLOCK_SKEW",
  "EXPIRED",
  "OUT_OF_ORDER",
  "WRONG_CLIENT",
  "UPGRADE_REQUIRED",
  "TOO_LARGE",
]);

/** The answers that record nothing: the seq is not used up and the client
 * may send the same envelope again. Every other answer, applied or refused,
 * is recorded with the write (a `BAD_REQUEST` for a malformed envelope is
 * not, and has no usable seq). */
export const unrecordedErrorCodes = [
  "UNAUTHORIZED",
  "TOO_MANY_REQUESTS",
  "SERVICE_UNAVAILABLE",
  "INTERNAL_SERVER_ERROR",
  "CLOCK_SKEW",
  "OUT_OF_ORDER",
  "WRONG_CLIENT",
  "UPGRADE_REQUIRED",
  "TOO_LARGE",
] as const satisfies readonly z.infer<typeof spaceErrorCodeSchema>[];

/** Why a `PRECONDITION_FAILED` was answered, where the client acts on it:
 * `queue_full`, the person has 20 queued runs (`03` L1; recorded, uses the
 * seq; the client restores the composer's text). */
export const spaceRefusalReasonSchema = z.enum(["queue_full"]);

/** An error answer. `message` is user-facing text; `issues`: the input paths
 * that failed validation (`BAD_REQUEST`); `reason`: see
 * `spaceRefusalReasonSchema`; `serverTime` (ms): the server's time, on every
 * answer (`01` Y2); `expectedSeq` with `OUT_OF_ORDER`. */
export const spaceErrorSchema = z.object({
  code: spaceErrorCodeSchema,
  message: z.string(),
  issues: z.array(z.string()).optional(),
  reason: spaceRefusalReasonSchema.optional(),
  serverTime: z.number(),
  expectedSeq: z.number().int().positive().optional(),
});

/** The answer to one write (`01` Y2): applied with its result, or refused.
 * Every answer carries `serverTime`, a refusal's in its error. `replay`: a
 * recorded answer given again without using the envelope's seq. */
export const spaceApplyAnswerSchema = z.union([
  z.object({
    ok: z.literal(true),
    result: z.unknown(),
    serverTime: z.number(),
    replay: z.literal(true).optional(),
  }),
  z.object({ ok: z.literal(false), error: spaceErrorSchema, replay: z.literal(true).optional() }),
]);
