// Zod schemas for the Spaces API: the contract of the HTML mockup's mock
// backend (`docs/mockups/session-web-spaces-mock-api.js`, sections 3 to 6a).
// Spaces are shared topic spaces with threads, answers, follow-ups, ask trees,
// sources, pages, skills and moderation; space roles (owner, admin,
// moderator, member) replace the real app's thread roles, and spaces replace
// workspaces. The real app does not serve this API yet.
//
// These schemas are the reference for the mock's hand-written validator
// (`S.*` in the mock's section 3), which stays in the mockup so the page needs
// no build step. `test/spacesMock.test.ts` loads the mock in Node and checks
// its fixtures, responses, procedure answers, errors and events against the
// schemas here, and that every row of the mock's API table has an entry in
// `spacesApi` below.
//
// Names: a record that stands in for one of the real app's wire types has
// that type's name (`researchTreeSummarySchema`, `threadMemberSchema`,
// `inboxNotificationSchema`, …: the wire names in the mock's API table); its
// comment says how the two differ. The real types with those names are other
// shapes, so these never go to the package root by name: `../schemas/index.ts`
// exports this module as the namespace `spaces`, and the package root
// exports its types (`../types/spaces.ts`) as the type namespace `Spaces`.
// Records without a wire type keep descriptive names.
//
// Conventions:
// - The wire is JSON. A Set travels as `{ $set: [...] }` (the mock's codec),
//   and the schemas validate that form (`wireSetSchema`).
// - Record schemas are the response shape: what GET and a procedure's
//   `changes` return. Derived fields (a thread's `r`, `likes`, `liked` and
//   `mine`; a space's `members`) are in them and never in input schemas.
//   Write-only fields (an API key's `raw`) are in input schemas only. The
//   `stored*` schemas are the server's stored shape (the fixtures), which has
//   the hidden and write-only fields and no derived ones; they are not sent.
// - Ids: the server assigns ULIDs (`spaceUlidSchema`) to the threads, ask
//   nodes, sources, API keys, notifications, invite links and reports it
//   creates. Thread ids are always ULIDs, fixture threads included. The other
//   fixture records keep their own ids (`k1`, `rp1`, …), which
//   `spaceRecordIdSchema` allows. Space ids are slugs (`public`,
//   `sp-<name>`), not ULIDs.
// - Cursors are opaque strings, as in `InboxNotificationPage`.
// - TODO(limits): API keys, token usage and who pays for an ask are stubs
//   (owner decision: no backend limit tracking); their schemas describe the
//   stub as it is.

import { z } from "zod";

import { sessionEventSchema as sessionEventEnvelopeSchema } from "./events.js";
import { researchNodeStatusSchema } from "./research.js";
import { turnSchema } from "./turn.js";

// ---- primitives ----

/** A ULID, as the server assigns it (Crockford base32, 26 characters). */
export const spaceUlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

/** A record id: a ULID from the server, or a fixture's own id (`k1`,
 * `rp1`, …). */
export const spaceRecordIdSchema = z.string().min(1);

/** A thread's id: always a ULID, fixture threads included. */
export const spaceThreadIdSchema = spaceUlidSchema;

/** A space's id: a slug (`public`, `ml`, `sp-<name>` for a new space). */
export const spaceIdSchema = z.string().min(1);

/** A person's handle (`ines.v`). */
export const spaceHandleSchema = z.string().min(1);

/** An ISO instant with seconds, in UTC (`2026-11-16T10:00:00Z`). */
export const spaceIsoTimeSchema = z.iso.datetime();

const count = z.number().int().nonnegative();

/** The wire form of a Set: `{ $set: [...] }`. */
export const wireSetSchema = <Item extends z.ZodType>(item: Item) =>
  z.object({ $set: z.array(item) });

/** A node of a thread's ask tree, `"<thread>:<node>"` (node `r`: the thread's
 * ask): a run's key, a saved ask. */
export const askNodeKeySchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}:.+$/);

/** An item of a thread that can be reported or moderated:
 * `"<kind>:<thread>[:…]"` (`a:` an answer, `r:` a reply, …). */
export const moderationKeySchema = z.string().regex(/^[a-z]+:[0-9A-HJKMNP-TV-Z]{26}(:.*)?$/);

/** A reply, `"<thread>:<path>"`: the indexes of the reply in the thread's
 * replies, joined with ".". */
export const replyKeySchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}:\d+(\.\d+)*$/);

/** A page document's key, `"<space>/<page slug>"`. */
export const pageKeySchema = z.string().regex(/^[^/]+\/.+$/);

// ---- roles and memberships ----

/** The caller's role in a space (`/api/me/roles`). */
export const spaceRoleSchema = z.enum(["Owner", "Admin", "Moderator", "Member"]);

/** A role in a space's member list. Replaces the real app's `MemberRole`
 * (`commenter`, `viewer`) and `ThreadMember.role`. */
export const spaceMemberRoleSchema = z.enum(["member", "mod", "admin", "owner"]);

/** The caller's relation to a closed space (`/api/me/closed-spaces`). */
export const closedSpaceStateSchema = z.enum(["none", "pending", "member", "mod", "denied"]);

/** wire: `ThreadMember`, which the mock replaces: a handle and a space role
 * instead of a user id, login, name, avatar and thread role; `joinedAt` is an
 * ISO time, not milliseconds. */
export const threadMemberSchema = z.object({
  u: spaceHandleSchema,
  role: spaceMemberRoleSchema,
  joinedAt: spaceIsoTimeSchema.optional(),
});

export const joinRequestSchema = z.object({
  /** The applicant; the record's id. */
  u: spaceHandleSchema,
  /** The space; absent: `replication` (the fixtures' one closed space with a
   * member list of its own). */
  sp: spaceIdSchema.optional(),
  st: z.enum(["open", "approved", "declined"]),
  createdAt: spaceIsoTimeSchema.optional(),
  updatedAt: spaceIsoTimeSchema.optional(),
  /** When the applicant joined Session. */
  userCreatedAt: spaceIsoTimeSchema.optional(),
  th: z.number().optional(),
  common: z.array(z.string()).optional(),
  bio: z.string().optional(),
  /** The answers to the space's request questions, in order. */
  a: z.array(z.string()).optional(),
  /** A moderator's note to a declined applicant. */
  why: z.string().optional(),
  fresh: z.boolean().optional(),
});

export const banSchema = z.object({
  id: spaceRecordIdSchema,
  sp: spaceIdSchema,
  u: spaceHandleSchema,
  createdAt: spaceIsoTimeSchema.optional(),
  updatedAt: spaceIsoTimeSchema.optional(),
});

/** wire: `ThreadInvite`, which the mock replaces: a one-use link to a space
 * with a short code, made by a moderator (or a member, where the space allows
 * it). Times are ISO, and `expiresAt` is null for a link that does not
 * expire. A revoked link is never returned (`storedThreadInviteSchema`). */
export const threadInviteSchema = z.object({
  id: spaceRecordIdSchema,
  code: z.string(),
  by: spaceHandleSchema,
  sp: spaceIdSchema,
  createdAt: spaceIsoTimeSchema.optional(),
  updatedAt: spaceIsoTimeSchema.optional(),
  expiresAt: spaceIsoTimeSchema.nullable().optional(),
  /** Why the link no longer works (`Used`). */
  dead: z.string().optional(),
  usedBy: spaceHandleSchema.optional(),
});

/** The stored invite link: a revoked one stays on the server for
 * `invites.restore`. Not sent. */
export const storedThreadInviteSchema = threadInviteSchema.extend({
  revokedAt: spaceIsoTimeSchema.optional(),
});

// ---- spaces ----

export const spaceVisibilitySchema = z.enum(["open", "listed", "unlisted"]);

export const spaceDomainSchema = z.object({
  domain: z.string(),
  method: z.literal("dns").optional(),
  state: z.enum(["checking", "ok", "failed"]).optional(),
  verifiedAt: spaceIsoTimeSchema.optional(),
});

export const spaceRequestQuestionSchema = z.object({
  q: z.string(),
  req: z.boolean().optional(),
});

/** A space as GET returns it. Replaces the real app's `Workspace`. A closed
 * space (`vis` listed or unlisted) is public as a landing (name, description,
 * rules, member count, request questions); its content is for its members. */
export const spaceSchema = z.object({
  id: spaceIdSchema,
  name: z.string(),
  title: z.string(),
  createdAt: spaceIsoTimeSchema.optional(),
  updatedAt: spaceIsoTimeSchema.optional(),
  av: z.number().optional(),
  /** The space has an uploaded icon instead of the colour `av`. */
  img: z.boolean().optional(),
  online: z.number().optional(),
  posts: z.number().optional(),
  desc: z.string().optional(),
  /** Derived: members outside the fixtures plus the space's member list. */
  members: count,
  rules: z.array(z.string()).optional(),
  /** The rules before the last change ("See changes"). */
  rulesPrev: z.array(z.string()).optional(),
  /** The rules' version (step 9, edit conflicts). */
  rulesAt: spaceIsoTimeSchema.optional(),
  rulesBy: spaceHandleSchema.optional(),
  /** [title, edited at]. */
  pages: z.array(z.tuple([z.string(), spaceIsoTimeSchema])).optional(),
  /** The owner, admins and moderators: [handle, role]. */
  mods: z.array(z.tuple([spaceHandleSchema, spaceMemberRoleSchema])).optional(),
  /** The FAQ landing's topics: [key, label]. */
  topics: z.array(z.tuple([z.string(), z.string()])).optional(),
  /** Absent: open. */
  vis: spaceVisibilitySchema.optional(),
  /** A closed space: people request to join, or need an invite. */
  policy: z.enum(["request", "invite"]).optional(),
  /** Who makes invite links in a closed space. */
  invite: z.enum(["mods", "members"]).optional(),
  qs: z.array(spaceRequestQuestionSchema).optional(),
  faq: z.boolean().optional(),
  postsOff: z.boolean().optional(),
  /** Show the title instead of #name (a verified space). */
  plain: z.boolean().optional(),
  /** Who edits pages. */
  pageEdit: z.enum(["mods", "members"]).optional(),
  dom: spaceDomainSchema.nullable().optional(),
  archived: z.object({ by: spaceHandleSchema, on: z.string() }).optional(),
  /** The owner deleted the space (the mock marks it deleted). */
  deleted: z.boolean().optional(),
});

/** The stored space: `membersBase` counts members outside the fixtures; the
 * server adds the member list's length to it on read. Not sent. */
export const storedSpaceSchema = spaceSchema.omit({ members: true }).extend({
  membersBase: count.optional(),
});

// ---- threads, answers, follow-ups, ask trees, replies ----

/** Why an answer ended without one: stopped (`research.cancelNode`), tokens
 * (nothing could pay), key (the provider rejected the key), rate (the
 * provider limits requests; `at`: when Retry works again, ms), access (the
 * person who asked could no longer read what the ask needs when the run
 * started), interrupted (the server could not resume the run). */
export const runFailureSchema = z.object({
  why: z.enum(["stopped", "tokens", "key", "rate", "access", "interrupted"]),
  at: z.number().optional(),
});

/** TODO(limits): who pays for an ask, stored as sent: `session` (the included
 * tokens) or one of the person's API key ids; null: the server picks. */
export const spacePayerSchema = z.string().nullable();

/** The sources an ask is about: one (`it`) or several (`its`); `b`: the
 * passage it quotes; `quote`: the quoted text, as the page sent it. */
export const askAboutSchema = z.object({
  it: z.string().optional(),
  its: z.array(z.string()).optional(),
  b: z.number().optional(),
  quote: z.string().optional(),
});

/** A thread as GET returns it: an ask (answered by the agent) or a post.
 * wire: `ResearchTreeSummary` (`research.listTrees`) and `ResearchTreeDetail`
 * (`research.getTree`), which the mock replaces with one flat record; its
 * answer, sources, follow-ups, replies and ask tree are separate collections
 * keyed by the thread's id. The record is a list row with derived counts, as
 * `ResearchTreeSummary` is; `researchTreeDetailSchema` is the same schema. */
export const researchTreeSummarySchema = z.object({
  id: spaceThreadIdSchema,
  /** The space. */
  s: spaceIdSchema,
  /** The author. */
  u: spaceHandleSchema,
  k: z.enum(["ask", "post"]),
  /** The question or the post's text; empty once deleted. */
  q: z.string(),
  createdAt: spaceIsoTimeSchema.optional(),
  updatedAt: spaceIsoTimeSchema.optional(),
  /** The title; null: the page shows the question. */
  t: z.string().nullable().optional(),
  /** The answer's summary line. */
  sum: z.string().nullable().optional(),
  /** Tokens the answer used. */
  tok: z.number().optional(),
  /** Derived: first-level follow-ups of an ask, or replies to a post. */
  r: count,
  /** Derived: likes from people outside the fixtures plus the caller's. */
  likes: count,
  /** Derived: the caller liked it. */
  liked: z.boolean(),
  /** Derived: the caller wrote it. */
  mine: z.boolean(),
  about: askAboutSchema.optional(),
  /** A fixture's reference name (`q11`), for the Screen entries. */
  rf: z.string().optional(),
  /** The text the search reads. */
  kw: z.string().optional(),
  /** A topic key of the space's FAQ landing; null: Other. */
  topic: z.string().nullable().optional(),
  topicBy: z.enum(["asker", "mod", "agent"]).nullable().optional(),
  running: z.boolean().optional(),
  pay: spacePayerSchema.optional(),
  model: z.string().optional(),
  fail: runFailureSchema.optional(),
  edited: z.boolean().optional(),
  /** The author deleted it; it keeps its place for its follow-ups or replies. */
  del: z.boolean().optional(),
  /** Deleted without follow-ups or replies: lists leave it out. */
  gone: z.boolean().optional(),
  /** The skill the ask used. */
  skill: z.string().nullable().optional(),
  /** The number of the latest run (attempt) of its ask. */
  att: count.optional(),
  /** The thread and ask node it was started from; `lv`: the node's depth. */
  from: z.object({ th: spaceThreadIdSchema, node: z.string(), lv: count.optional() }).optional(),
});

/** One thread (`GET /api/threads/:id`). wire: `ResearchTreeDetail`, which
 * holds the tree and its nodes; the mock sends the thread's record, as in the
 * list. */
export const researchTreeDetailSchema = researchTreeSummarySchema;

/** The stored thread: `likesBase` counts likes from people outside the
 * fixtures. Not sent. */
export const storedResearchTreeSummarySchema = researchTreeSummarySchema
  .omit({ r: true, likes: true, liked: true, mine: true })
  .extend({ likesBase: count.optional() });

/** An answer's HTML (`/api/answers`). wire: `ResearchNodeContent`, which
 * holds turns and a snapshot instead. */
export const researchNodeContentSchema = z.string();

/** A page an answer cites: [title, host, note] (`/api/answer-sources`). */
export const citedPageSchema = z.tuple([z.string(), z.string(), z.string()]);

/** A follow-up ask on an ask thread (the flat list, without ask trees).
 * wire: `ResearchExchangeNode` (`followups.ask`), which the mock replaces: a
 * question and its answer, without ids, a tree or a run state. */
export const researchExchangeNodeSchema = z.object({
  u: spaceHandleSchema,
  createdAt: spaceIsoTimeSchema.optional(),
  q: z.string(),
  /** The answer as text (`Researching…` while it runs). */
  a: z.string().optional(),
  html: z.string().optional(),
  del: z.boolean().optional(),
  edited: z.boolean().optional(),
});

/** A reply to a post; replies have one level of nesting. wire:
 * `ResearchPostNode` (`research.createPostFollowUp`), which the mock replaces:
 * the text with its author and likes, nested under the reply it answers. */
export interface ResearchPostNode {
  u: string;
  createdAt?: string | undefined;
  t: string;
  likes?: number | undefined;
  kids?: ResearchPostNode[] | undefined;
  del?: boolean | undefined;
  edited?: boolean | undefined;
}

export const researchPostNodeSchema: z.ZodType<ResearchPostNode> = z.object({
  u: spaceHandleSchema,
  createdAt: spaceIsoTimeSchema.optional(),
  t: z.string(),
  likes: count.optional(),
  get kids() {
    return z.array(researchPostNodeSchema).optional();
  },
  del: z.boolean().optional(),
  edited: z.boolean().optional(),
});

/** A node of a thread's ask tree: an ask about an answer. wire:
 * `ResearchNode` (an exchange node), which the mock replaces. `par`: `r` (the
 * thread's ask) or a node id. A node with `fu` stands for the flat follow-up
 * at that index and takes its text from it. */
export const researchNodeSchema = z.object({
  id: z.string().min(1),
  par: z.string().min(1),
  u: spaceHandleSchema.optional(),
  createdAt: spaceIsoTimeSchema.optional(),
  tok: z.number().optional(),
  q: z.string().optional(),
  html: z.string().optional(),
  fu: count.optional(),
  del: z.boolean().optional(),
  edited: z.boolean().optional(),
  running: z.boolean().optional(),
  fail: runFailureSchema.optional(),
  pay: spacePayerSchema.optional(),
  model: z.string().optional(),
  att: count.optional(),
  /** The answers the ask compares (ids of nodes), or null. */
  uses: z.array(z.string()).nullable().optional(),
  /** The thread this branch became (`threads.create` with `from`). */
  promoted: spaceThreadIdSchema.optional(),
  /** The thread's author collapsed the branch. */
  col: z.boolean().optional(),
});

/** `space`: sent with a tree scoped to the caller's own asks (a closed space
 * they are not a member of), as they may not have the thread record. */
export const askTreeSchema = z.object({
  nodes: z.array(researchNodeSchema),
  space: spaceIdSchema.optional(),
});

/** A run in progress (`/api/runs`, `research.listActivity`), keyed by
 * `"<thread>:<node>"`. wire: `ResearchNode[]` with their `RunState`, which
 * the mock replaces with the job's own record. A finished run's record is
 * removed. `paused`: a dev-only hold (a Screen entry's scenario). */
export const spaceRunSchema = z.object({
  th: spaceThreadIdSchema,
  node: z.string().min(1),
  u: spaceHandleSchema,
  status: z.enum(["queued", "running"]),
  attempt: count,
  /** The number of the run's last event. */
  seq: count,
  /** The progress step it is on (0 to 3). */
  step: count,
  model: z.string().nullable().optional(),
  pay: spacePayerSchema.optional(),
  createdAt: spaceIsoTimeSchema.optional(),
  paused: z.boolean().optional(),
});

// ---- sources ----

/** One passage of a source's reader copy: a paragraph, a heading, a timed
 * transcript line (with its speaker) or a quoted post. */
export const sourceBlockSchema = z.object({
  p: z.string().optional(),
  h: z.string().optional(),
  ts: z.string().optional(),
  sp: z.string().optional(),
  q: z.object({ au: z.string(), h: z.string(), t: z.string() }).optional(),
});

export const sourceSchema = z.object({
  id: spaceRecordIdSchema,
  /** The platform (`x`, `substack`, `arxiv`, `yt`, `pdf`, `web`, …). */
  pl: z.string(),
  /** `article`, `thread`, `post`, `video`, `audio`, … */
  kind: z.string(),
  au: z.string().optional(),
  h: z.string().optional(),
  /** When the author published it. */
  createdAt: spaceIsoTimeSchema.optional(),
  updatedAt: spaceIsoTimeSchema.optional(),
  len: z.string().optional(),
  tok: z.number().optional(),
  /** The spaces that have it (the caller's view: closed spaces they are not a
   * member of are left out). */
  sp: z.array(spaceIdSchema).optional(),
  url: z.string().optional(),
  sum: z.string().optional(),
  body: z.array(sourceBlockSchema).optional(),
  pub: z.string().optional(),
  t: z.string().optional(),
  desc: z.string().optional(),
  by: z.string().optional(),
  paid: z.number().optional(),
  /** The author edited it upstream: when, the passage, and its old text. */
  edited: z
    .object({ at: spaceIsoTimeSchema, b: z.number(), old: z.string().optional() })
    .optional(),
  deletedAt: spaceIsoTimeSchema.optional(),
});

/** A source in a space's sources list (`/api/space-sources`). `m`: the
 * source's id; `rv`: waiting for a moderator's review; `rm`: removed. */
export const spaceSourceSchema = z.object({
  m: spaceRecordIdSchema,
  by: spaceHandleSchema,
  createdAt: spaceIsoTimeSchema.optional(),
  note: z.string().optional(),
  rv: z.boolean().optional(),
  rm: z.boolean().optional(),
});

/** Who adds sources to a space: members, members with review, moderators. */
export const sourcePolicySchema = z.enum(["members", "review", "mods"]);

export const sourceReportSchema = z.object({
  m: spaceRecordIdSchema,
  sid: spaceIdSchema,
  by: spaceHandleSchema,
  why: z.string().optional(),
  createdAt: spaceIsoTimeSchema.optional(),
});

// ---- reports and moderation ----

export const reportSchema = z.object({
  id: spaceRecordIdSchema,
  sp: spaceIdSchema,
  key: moderationKeySchema,
  by: spaceHandleSchema,
  st: z.enum(["open", "dismissed", "hidden", "removed"]),
  why: z.string().optional(),
  note: z.string().optional(),
  createdAt: spaceIsoTimeSchema.optional(),
  updatedAt: spaceIsoTimeSchema.optional(),
});

/** A moderated item's state (`/api/moderation`, by moderation key). */
export const moderationStateSchema = z.enum(["hidden", "removed"]);

// ---- notifications ----

export const inboxNotificationTypeSchema = z.enum([
  "follow_up",
  "branch",
  "answer_ready",
  "answer_failed",
  "invite",
  "join_approved",
  "join_declined",
  "page_edited",
  "report_resolved",
  "source_edited",
  "source_asked",
]);

/** A stored notification. wire: `InboxNotification`, which the mock
 * replaces with a structured record: the page writes the text and picks the
 * icon from `type`, so there is no `title`, `body`, `tone` or `href`; `read`
 * replaces `readAt`, and `createdAt` is an ISO time. `page`: an index into the
 * space's pages; `block`: a passage of `source`; `item`: the moderation key a
 * report is about; `response`: the caller's answer to an invite. */
export const inboxNotificationSchema = z.object({
  id: spaceRecordIdSchema,
  type: inboxNotificationTypeSchema,
  createdAt: spaceIsoTimeSchema.optional(),
  updatedAt: spaceIsoTimeSchema.optional(),
  read: z.boolean(),
  actor: spaceHandleSchema.optional(),
  space: spaceIdSchema.optional(),
  thread: spaceThreadIdSchema.optional(),
  node: z.string().optional(),
  page: count.optional(),
  source: spaceRecordIdSchema.optional(),
  block: count.optional(),
  report: spaceRecordIdSchema.optional(),
  item: moderationKeySchema.optional(),
  outcome: z.enum(["dismissed", "hidden", "removed"]).optional(),
  response: z.enum(["accepted", "declined"]).optional(),
});

// ---- pages and skills ----

export const pageRevisionSchema = z.object({
  by: spaceHandleSchema,
  createdAt: spaceIsoTimeSchema.optional(),
  note: z.string(),
});

/** A space page's document (`/api/pages`, by `"<space>/<slug>"`). `rev`: its
 * version (step 9), the number of saves; absent: 0. `by`: who created it;
 * `ed`: who edited it last. */
export const pageDocSchema = z.object({
  t: z.string(),
  text: z.array(z.string()),
  by: spaceHandleSchema.optional(),
  ed: spaceHandleSchema.optional(),
  rev: count.optional(),
  revs: z.array(pageRevisionSchema),
});

/** A skill of a space (`/api/space-skills`, by space, in the order About
 * shows them). `prompt`: the description, a blank line, then the
 * instructions in Markdown (a SKILL.md file's parts). `rev`: its version
 * (step 9), the number of saves; 0 for a skill never edited. */
export const skillSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  rev: count,
});

// ---- people, profile, settings ----

/** The caller's profile (`/api/me/profile`), the part of `userSchema` they
 * edit. wire: `User`, which the mock replaces. */
export const spaceProfileSchema = z.object({ name: z.string(), bio: z.string() });

/** What a profile shows of another person (`/api/users`, by handle): the
 * number of spaces they wrote threads in, closed spaces included. wire:
 * `User`, which the mock replaces. */
export const personSummarySchema = z.object({ spaces: count });

/** The signed-in person (`GET /api/me`). wire: `User`, which the mock
 * replaces: a handle and an X handle instead of a GitHub login; `createdAt`
 * is an ISO time. Of the three rows with the wire type `User` (`/api/me`,
 * `/api/me/profile`, `/api/users`), this one has its name. */
export const userSchema = z.object({
  u: spaceHandleSchema,
  name: z.string(),
  bio: z.string(),
  x: z.string(),
  createdAt: spaceIsoTimeSchema,
});

/** The caller's account and notification settings (`/api/me/settings`).
 * wire: `UserSettings`, which holds the appearance settings instead; these
 * are the mock's own. `types`: notification types on or off; `spaces`: the
 * notification level per space. */
export const userSettingsSchema = z.object({
  email: z.string(),
  /** A new address waiting for confirmation. */
  emailNew: z.string().nullable(),
  /** When the person last requested a data export. */
  exportAt: spaceIsoTimeSchema.nullable(),
  emailOn: z.boolean(),
  types: z.record(z.string(), z.boolean()),
  spaces: z.record(spaceIdSchema, z.enum(["all", "mentions", "off"])),
});

// ---- API keys and usage: TODO(limits) stubs ----

/** TODO(limits): an API key, a stub (owner decision): stored as written, not
 * encrypted, no usage accounting. The raw key is write-only: GET returns the
 * mask. `check`: the provider is checking it (a server job). */
export const apiKeySchema = z.object({
  id: spaceRecordIdSchema,
  kind: z.literal("key"),
  label: z.string(),
  createdAt: spaceIsoTimeSchema.optional(),
  updatedAt: spaceIsoTimeSchema.optional(),
  mask: z.string().optional(),
  provider: z.string().optional(),
  valid: z.boolean().optional(),
  /** Why the provider rejected it. */
  reason: z.string().optional(),
  check: z.literal("checking").optional(),
  lastUsedAt: spaceIsoTimeSchema.nullable().optional(),
  used: z.number().optional(),
  /** A monthly token limit (0: none), stored and not enforced. */
  cap: z.number().optional(),
});

/** TODO(limits): the stored key, with the raw value. Not sent. */
export const storedApiKeySchema = apiKeySchema.extend({ raw: z.string().optional() });

/** TODO(limits): token usage, a stub. `by`: tokens this month per source
 * (`session` or a key id) and space; `cap`: the included tokens a month;
 * `def`: the default key, which pays after the included tokens run out;
 * `fresh`: a new account. */
export const tokenUsageSchema = z.object({
  cap: z.number(),
  resetAt: spaceIsoTimeSchema,
  def: z.string().nullable(),
  movedSeen: z.boolean(),
  fresh: z.boolean().optional(),
  by: z.record(z.string(), z.record(spaceIdSchema, z.number())),
});

/** TODO(limits): Usage › Recent asks (`usage.listAsks`): an ask or follow-up
 * of the caller's that used tokens. `readable`: false for an ask in the tree
 * of a closed space's thread the caller cannot read. */
export const usageAskSchema = z.object({
  id: askNodeKeySchema,
  thread: spaceThreadIdSchema,
  node: z.string(),
  space: spaceIdSchema,
  t: z.string(),
  u: spaceHandleSchema,
  tok: z.number(),
  pay: spacePayerSchema.optional(),
  del: z.literal(true).optional(),
  createdAt: spaceIsoTimeSchema.optional(),
  readable: z.boolean(),
});

// ---- collections: what GET returns ----

/** Every collection the Spaces API serves, as GET returns it to the caller
 * (read scope applied). Keys are the collection names that `changes` uses. */
export const spaceCollectionSchemas = {
  /** GET /api/spaces */
  spaces: z.array(spaceSchema),
  /** GET /api/threads */
  posts: z.array(researchTreeSummarySchema),
  /** GET /api/answers */
  rich: z.record(spaceThreadIdSchema, researchNodeContentSchema),
  /** GET /api/answer-sources */
  srcd: z.record(spaceThreadIdSchema, z.array(citedPageSchema)),
  /** GET /api/follow-ups */
  fu: z.record(spaceThreadIdSchema, z.array(researchExchangeNodeSchema)),
  /** GET /api/replies */
  rp: z.record(spaceThreadIdSchema, z.array(researchPostNodeSchema)),
  /** GET /api/ask-trees */
  qtd: z.record(spaceThreadIdSchema, askTreeSchema),
  /** GET /api/sources */
  media: z.array(sourceSchema),
  /** GET /api/sources/new: the sources people added that Session did not have. */
  miAdded: z.array(sourceSchema),
  /** GET /api/me/memberships */
  joined: z.array(spaceIdSchema),
  /** GET /api/me/roles */
  roles: z.record(spaceIdSchema, spaceRoleSchema),
  /** GET /api/me/roles/granted: the roles others granted, before the caller's own changes. */
  roles0: z.record(spaceIdSchema, spaceRoleSchema),
  /** GET /api/me/closed-spaces */
  rel: z.record(spaceIdSchema, closedSpaceStateSchema),
  /** GET /api/me/likes */
  liked: wireSetSchema(spaceThreadIdSchema),
  /** GET /api/me/saved */
  saved: wireSetSchema(spaceThreadIdSchema),
  /** GET /api/me/saved-asks */
  qtSaved: wireSetSchema(askNodeKeySchema),
  /** GET /api/me/saved-sources */
  miSaved: wireSetSchema(spaceRecordIdSchema),
  /** GET /api/me/read-sources */
  miRead: wireSetSchema(spaceRecordIdSchema),
  /** GET /api/me/api-keys (TODO(limits)) */
  userKeys: z.array(apiKeySchema),
  /** GET /api/me/notifications */
  notifs: z.array(inboxNotificationSchema),
  /** GET /api/me/invite-requests */
  askedInv: z.array(spaceIdSchema),
  /** GET /api/join-requests */
  reqs: z.array(joinRequestSchema),
  /** GET /api/members: one closed space's members */
  mem: z.array(threadMemberSchema),
  /** GET /api/members/other-spaces */
  memOther: z.record(spaceIdSchema, z.array(threadMemberSchema)),
  /** GET /api/bans */
  banned: z.array(banSchema),
  /** GET /api/invite-links */
  links: z.array(threadInviteSchema),
  /** GET /api/reports */
  reports: z.array(reportSchema),
  /** GET /api/moderation */
  modSt: z.record(moderationKeySchema, moderationStateSchema),
  /** GET /api/space-sources */
  dsDrops: z.record(spaceIdSchema, z.array(spaceSourceSchema)),
  /** GET /api/space-source-policies */
  dsPol: z.record(spaceIdSchema, sourcePolicySchema),
  /** GET /api/source-reports */
  dsReps: z.array(sourceReportSchema),
  /** GET /api/me/profile */
  profile: spaceProfileSchema,
  /** GET /api/space-skills */
  skills: z.record(spaceIdSchema, z.array(skillSchema)),
  /** GET /api/pages */
  pagedocs: z.record(pageKeySchema, pageDocSchema),
  /** GET /api/me/settings */
  acct: userSettingsSchema,
  /** GET /api/me/muted */
  muted: wireSetSchema(spaceHandleSchema),
  /** GET /api/me/blocked */
  blocked: wireSetSchema(spaceHandleSchema),
  /** GET /api/me/usage (TODO(limits)) */
  usage: tokenUsageSchema,
  /** GET /api/me/reports-seen */
  repSeen: z.boolean(),
  /** GET /api/me/requests-seen */
  reqSeen: z.boolean(),
  /** GET /api/me/reply-likes */
  rpLiked: wireSetSchema(replyKeySchema),
  /** GET /api/runs */
  runs: z.record(askNodeKeySchema, spaceRunSchema),
  /** GET /api/users: computed from the threads on every read. */
  people: z.record(spaceHandleSchema, personSummarySchema),
};

export type SpaceCollection = keyof typeof spaceCollectionSchemas;

/** The stored shape of the collections whose stored records differ from
 * what GET returns: hidden fields, write-only fields, revoked links. The
 * fixtures are in this shape. */
export const storedSpaceCollectionSchemas = {
  ...spaceCollectionSchemas,
  spaces: z.array(storedSpaceSchema),
  posts: z.array(storedResearchTreeSummarySchema),
  userKeys: z.array(storedApiKeySchema),
  links: z.array(storedThreadInviteSchema),
};

// ---- changes: the records a write changed ----

/** A list collection's changes: the records written (as GET returns them),
 * the ids removed or no longer readable, where new records went (`at`) and,
 * from a scenario, the list's whole order when it changed (`order`). */
const listChanges = <Item extends z.ZodType>(item: Item) =>
  z.object({
    put: z.array(item),
    del: z.array(z.string()),
    at: z.record(z.string(), count).optional(),
    order: z.array(z.string()).optional(),
  });

/** A map collection's changes: the values written by key, and the keys
 * removed or no longer readable. */
const mapChanges = <Value extends z.ZodType>(key: z.ZodString, value: Value) =>
  z.object({ put: z.record(key, value), del: z.array(z.string()) });

/** A value collection's change: the new value. */
const valueChange = <Value extends z.ZodType>(value: Value) => z.object({ value });

/** `changes`: per collection, the records a procedure, a job or a scenario
 * wrote, as the caller reads them now; a record the caller may no longer read
 * goes out as removed. A change to likes, follow-ups, replies or ask trees
 * also returns the threads whose derived fields changed; a change to member
 * lists returns the spaces. */
export const spaceChangesSchema = z
  .object({
    spaces: listChanges(spaceSchema),
    posts: listChanges(researchTreeSummarySchema),
    rich: mapChanges(spaceThreadIdSchema, researchNodeContentSchema),
    srcd: mapChanges(spaceThreadIdSchema, z.array(citedPageSchema)),
    fu: mapChanges(spaceThreadIdSchema, z.array(researchExchangeNodeSchema)),
    rp: mapChanges(spaceThreadIdSchema, z.array(researchPostNodeSchema)),
    qtd: mapChanges(spaceThreadIdSchema, askTreeSchema),
    media: listChanges(sourceSchema),
    miAdded: listChanges(sourceSchema),
    joined: valueChange(spaceCollectionSchemas.joined),
    roles: valueChange(spaceCollectionSchemas.roles),
    roles0: valueChange(spaceCollectionSchemas.roles0),
    rel: mapChanges(spaceIdSchema, closedSpaceStateSchema),
    liked: valueChange(spaceCollectionSchemas.liked),
    saved: valueChange(spaceCollectionSchemas.saved),
    qtSaved: valueChange(spaceCollectionSchemas.qtSaved),
    miSaved: valueChange(spaceCollectionSchemas.miSaved),
    miRead: valueChange(spaceCollectionSchemas.miRead),
    userKeys: listChanges(apiKeySchema),
    notifs: listChanges(inboxNotificationSchema),
    askedInv: valueChange(spaceCollectionSchemas.askedInv),
    reqs: listChanges(joinRequestSchema),
    mem: valueChange(spaceCollectionSchemas.mem),
    memOther: mapChanges(spaceIdSchema, z.array(threadMemberSchema)),
    banned: listChanges(banSchema),
    links: listChanges(threadInviteSchema),
    reports: listChanges(reportSchema),
    modSt: mapChanges(moderationKeySchema, moderationStateSchema),
    dsDrops: mapChanges(spaceIdSchema, z.array(spaceSourceSchema)),
    dsPol: mapChanges(spaceIdSchema, sourcePolicySchema),
    dsReps: valueChange(spaceCollectionSchemas.dsReps),
    profile: valueChange(spaceProfileSchema),
    skills: mapChanges(spaceIdSchema, z.array(skillSchema)),
    pagedocs: mapChanges(pageKeySchema, pageDocSchema),
    acct: valueChange(userSettingsSchema),
    muted: valueChange(spaceCollectionSchemas.muted),
    blocked: valueChange(spaceCollectionSchemas.blocked),
    usage: valueChange(tokenUsageSchema),
    repSeen: valueChange(z.boolean()),
    reqSeen: valueChange(z.boolean()),
    rpLiked: valueChange(spaceCollectionSchemas.rpLiked),
    runs: mapChanges(askNodeKeySchema, spaceRunSchema),
    people: mapChanges(spaceHandleSchema, personSummarySchema),
  })
  .partial();

// ---- errors ----

/** tRPC error codes (`03-api-and-events.md` §1), with the codes the mock adds
 * for its router (`METHOD_NOT_SUPPORTED`, `SERVICE_UNAVAILABLE`). */
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
]);

/** What the server has when an edit conflicts (step 9): a space's rules, a
 * skill, or a page document. */
export const editConflictCurrentSchema = z.union([
  z.object({
    rulesAt: spaceIsoTimeSchema.nullable(),
    rules: z.array(z.string()),
    rulesBy: spaceHandleSchema.nullable(),
  }),
  skillSchema,
  z.object({
    rev: count,
    t: z.string(),
    text: z.array(z.string()),
    ed: spaceHandleSchema.nullable(),
    at: spaceIsoTimeSchema.nullable(),
  }),
]);

/** An error response. `message` is user-facing text; `issues`: the input
 * paths that failed validation (`BAD_REQUEST`, `"<path>: expected <type>"`);
 * `current` and `changes`: a `CONFLICT` from an edit, with the version the
 * server has and those records as the caller reads them now. */
export const spaceErrorSchema = z.object({
  code: spaceErrorCodeSchema,
  message: z.string(),
  issues: z.array(z.string()).optional(),
  current: editConflictCurrentSchema.optional(),
  changes: spaceChangesSchema.optional(),
});

// ---- procedures: POST /api/rpc/<name> ----

/** A procedure's answer: its result and the records it changed. */
export const spaceProcedureResponseSchema = <Result extends z.ZodType>(result: Result) =>
  z.object({ result, changes: spaceChangesSchema });

/** `invites.create`'s result. wire: `CreatedInvite`, which the mock replaces
 * with the link's id and code (the link record is in `changes`). */
export const createdInviteSchema = z.object({ id: spaceUlidSchema, code: z.string() });

const onInput = { on: z.boolean().optional() };
const onResultSchema = z.object({ on: z.boolean() });
/** A delete's answer: `kept`, the item keeps its place (as deleted) for the
 * follow-ups or replies under it. wire: `ResearchBranchRemoval`, which the
 * mock replaces: the changed records are in `changes`. `threads.delete`
 * answers the same. */
export const researchBranchRemovalSchema = z.object({ kept: z.boolean() });
const nullResultSchema = z.null();

/** A path in a thread's replies: indexes joined with "." */
const replyPathSchema = z.string().regex(/^\d+(\.\d+)*$/);

/** A space's settings, as admins change them (`spaces.update`). */
export const spaceSettingsSchema = z
  .object({
    name: z.string(),
    title: z.string(),
    av: z.number(),
    img: z.boolean(),
    desc: z.string(),
    rules: z.array(z.string()),
    vis: spaceVisibilitySchema,
    policy: z.enum(["request", "invite"]),
    qs: z.array(spaceRequestQuestionSchema),
    invite: z.enum(["mods", "members"]),
    faq: z.boolean(),
    topics: z.array(z.tuple([z.string(), z.string()])),
    postsOff: z.boolean(),
    plain: z.boolean(),
    pageEdit: z.enum(["mods", "members"]),
    pages: z.array(z.tuple([z.string(), spaceIsoTimeSchema])),
    dom: spaceDomainSchema.nullable(),
  })
  .partial();

/** The base a page editor opened (step 9): its version, and for a page
 * without a stored document the stand-in's author and history
 * (TODO(fixtures)). */
export const pageBaseSchema = z.object({
  rev: count.optional(),
  by: spaceHandleSchema.optional(),
  ed: spaceHandleSchema.optional(),
  revs: z.array(pageRevisionSchema).optional(),
});

export const createThreadInputSchema = z.object({
  space: spaceIdSchema,
  kind: z.enum(["ask", "post"]),
  q: z.string(),
  title: z.string().nullable().optional(),
  topic: z.string().nullable().optional(),
  /** TODO(limits): stored as sent; a key that pays must be the caller's. */
  pay: spacePayerSchema.optional(),
  model: z.string().optional(),
  about: askAboutSchema.optional(),
  skill: z.string().nullable().optional(),
  /** Start the thread from a node of another thread's ask tree. */
  from: z.object({ th: spaceThreadIdSchema, node: z.string() }).optional(),
  /** `all`: copy the asks below the node too. */
  branch: z.enum(["all", "one"]).optional(),
});

export const updateThreadInputSchema = z.object({
  id: spaceThreadIdSchema,
  q: z.string(),
  run: z.boolean().optional(),
  pay: spacePayerSchema.optional(),
  model: z.string().optional(),
});

export const forkNodeInputSchema = z.object({
  thread: spaceThreadIdSchema,
  /** `r` (the thread's ask) or a node id. */
  parent: z.string(),
  q: z.string(),
  uses: z.array(z.string()).nullable().optional(),
  pay: spacePayerSchema.optional(),
  model: z.string().optional(),
});

const askNodeInputSchema = z.object({ thread: spaceThreadIdSchema, node: z.string() });

export const decideRequestsInputSchema = z.object({
  space: spaceIdSchema,
  users: z.array(spaceHandleSchema),
  decision: z.enum(["approve", "decline", "reopen"]),
  why: z.string().optional(),
});

export const createSpaceInputSchema = z.object({
  name: z.string(),
  desc: z.string().optional(),
  rules: z.array(z.string()).optional(),
  vis: spaceVisibilitySchema.optional(),
  policy: z.enum(["request", "invite"]).optional(),
  qs: z.array(spaceRequestQuestionSchema).optional(),
  invite: z.enum(["mods", "members"]).optional(),
  faq: z.boolean().optional(),
});

export const updateSpaceInputSchema = z.object({
  id: spaceIdSchema,
  set: spaceSettingsSchema.optional(),
  unset: z.array(spaceSettingsSchema.keyof()).optional(),
  /** The rules' version the editor opened (step 9). */
  base: z.object({ rulesAt: spaceIsoTimeSchema.nullable() }).optional(),
  force: z.boolean().optional(),
});

export const updatePageInputSchema = z.object({
  space: spaceIdSchema,
  /** null: a new page; else its index in the space's pages. */
  page: count.nullable().optional(),
  title: z.string(),
  text: z.array(z.string()),
  base: pageBaseSchema.optional(),
  force: z.boolean().optional(),
});

export const addSpaceSourceInputSchema = z.object({
  space: spaceIdSchema,
  /** A source Session has; else `url` or `file`, which the server reads. */
  source: spaceRecordIdSchema.optional(),
  url: z.string().optional(),
  file: z.string().optional(),
  note: z.string().optional(),
});

export const updateSettingsInputSchema = z.object({
  emailOn: z.boolean().optional(),
  types: z.record(z.string(), z.boolean()).optional(),
  /** A new address to confirm; null cancels it. */
  emailNew: z.string().nullable().optional(),
  /** Request a data export. */
  export: z.boolean().optional(),
  spaces: z.record(spaceIdSchema, z.enum(["all", "mentions", "off"])).optional(),
});

const spaceInput = { space: spaceIdSchema };
const skillInput = { space: spaceIdSchema, name: z.string(), prompt: z.string() };
const memberInput = { space: spaceIdSchema, user: spaceHandleSchema };

/** Every procedure: its input and its result (`{ result, changes }` is the
 * response body). `wire` comments name the real app's type for the
 * procedure, where the API table gives one. */
export const spaceProcedures = {
  // -- personal toggles
  "likes.toggle": {
    input: z.object({ thread: spaceThreadIdSchema, ...onInput }),
    result: onResultSchema,
  },
  "likes.toggleReply": {
    input: z.object({ reply: replyKeySchema, ...onInput }),
    result: onResultSchema,
  },
  "saved.toggle": {
    input: z.object({ kind: z.enum(["thread", "ask", "source"]), id: z.string(), ...onInput }),
    result: onResultSchema,
  },
  "mutes.set": {
    input: z.object({ handle: spaceHandleSchema, on: z.boolean() }),
    result: onResultSchema,
  },
  "blocks.set": {
    input: z.object({ handle: spaceHandleSchema, on: z.boolean() }),
    result: onResultSchema,
  },
  "sources.markRead": { input: z.object({ id: spaceRecordIdSchema }), result: nullResultSchema },
  // -- threads, follow-ups and replies
  /** wire: `ResearchTree` */
  "threads.create": {
    input: createThreadInputSchema,
    result: z.object({ id: spaceThreadIdSchema }),
  },
  /** wire: `ResearchTree` */
  "threads.update": { input: updateThreadInputSchema, result: nullResultSchema },
  "threads.delete": {
    input: z.object({ id: spaceThreadIdSchema }),
    result: researchBranchRemovalSchema,
  },
  "threads.move": {
    input: z.object({ id: spaceThreadIdSchema, topic: z.string().nullable() }),
    result: nullResultSchema,
  },
  /** wire: `ResearchExchangeNode` */
  "followups.ask": {
    input: z.object({ thread: spaceThreadIdSchema, q: z.string() }),
    result: nullResultSchema,
  },
  /** wire: `ResearchPostNode` */
  "research.createPostFollowUp": {
    input: z.object({ thread: spaceThreadIdSchema, t: z.string(), parent: count.optional() }),
    result: nullResultSchema,
  },
  /** wire: `ResearchNode` */
  "research.forkNode": { input: forkNodeInputSchema, result: z.object({ id: spaceUlidSchema }) },
  "replies.update": {
    input: z.object({ thread: spaceThreadIdSchema, path: replyPathSchema, t: z.string() }),
    result: nullResultSchema,
  },
  /** wire: `ResearchBranchRemoval` */
  "replies.delete": {
    input: z.object({ thread: spaceThreadIdSchema, path: replyPathSchema }),
    result: researchBranchRemovalSchema,
  },
  /** wire: `ResearchNode` */
  "followups.update": {
    input: askNodeInputSchema.extend({
      q: z.string(),
      run: z.boolean().optional(),
      pay: spacePayerSchema.optional(),
    }),
    result: nullResultSchema,
  },
  /** wire: `ResearchBranchRemoval` */
  "followups.delete": { input: askNodeInputSchema, result: researchBranchRemovalSchema },
  // -- runs
  /** Stop. wire: `ResearchNode` */
  "research.cancelNode": { input: askNodeInputSchema, result: nullResultSchema },
  /** Run again or Retry. wire: `ResearchTreeDetail` */
  "research.retryNode": {
    input: askNodeInputSchema.extend({
      pay: spacePayerSchema.optional(),
      model: z.string().optional(),
    }),
    result: nullResultSchema,
  },
  // -- token usage (TODO(limits))
  "usage.setDefaultKey": {
    input: z.object({ id: spaceRecordIdSchema.nullable() }),
    result: nullResultSchema,
  },
  "usage.markMovedSeen": { input: z.object({}), result: nullResultSchema },
  // -- memberships, join requests and roles
  "spaces.join": {
    input: z.object({
      ...spaceInput,
      notification: spaceRecordIdSchema.optional(),
      invite: z.string().optional(),
    }),
    result: nullResultSchema,
  },
  "spaces.leave": { input: z.object(spaceInput), result: nullResultSchema },
  "onboarding.finish": {
    input: z.object({ spaces: z.array(spaceIdSchema) }),
    result: nullResultSchema,
  },
  "invites.decline": {
    input: z.object({ notification: spaceRecordIdSchema }),
    result: nullResultSchema,
  },
  "invites.request": { input: z.object(spaceInput), result: nullResultSchema },
  "joinRequests.create": {
    input: z.object({
      ...spaceInput,
      answers: z.array(z.string()).optional(),
      rulesAccepted: z.boolean().optional(),
    }),
    result: nullResultSchema,
  },
  "joinRequests.withdraw": { input: z.object(spaceInput), result: nullResultSchema },
  "joinRequests.decide": { input: decideRequestsInputSchema, result: nullResultSchema },
  /** wire: `ThreadMember` */
  "members.setRole": {
    input: z.object({ ...memberInput, role: spaceMemberRoleSchema }),
    result: nullResultSchema,
  },
  /** wire: `ThreadMember[]` */
  "members.remove": { input: z.object(memberInput), result: nullResultSchema },
  "members.ban": { input: z.object(memberInput), result: nullResultSchema },
  "members.unban": { input: z.object(memberInput), result: nullResultSchema },
  // -- reports and moderation
  "reports.create": {
    input: z.object({ item: moderationKeySchema, why: z.string(), note: z.string().optional() }),
    result: z.object({ id: spaceUlidSchema }),
  },
  "reports.resolve": {
    input: z.object({
      report: spaceRecordIdSchema,
      outcome: z.enum(["dismissed", "hidden", "removed", "open"]),
    }),
    result: nullResultSchema,
  },
  "moderation.decide": {
    input: z.object({
      item: moderationKeySchema,
      decision: z.enum(["hidden", "removed", "shown"]),
    }),
    result: nullResultSchema,
  },
  // -- notifications
  /** wire: `InboxNotification` */
  "notifications.markRead": {
    input: z.object({ id: spaceRecordIdSchema }),
    result: nullResultSchema,
  },
  "notifications.markAllRead": { input: z.object({}), result: nullResultSchema },
  "notifications.markSeen": {
    input: z.object({ kind: z.enum(["requests", "reports"]) }),
    result: nullResultSchema,
  },
  // -- invite links
  /** wire: `CreatedInvite` */
  "invites.create": {
    input: z.object({ ...spaceInput, days: count.nullable().optional() }),
    result: createdInviteSchema,
  },
  /** wire: `ThreadInvite` */
  "invites.revoke": { input: z.object({ id: spaceRecordIdSchema }), result: nullResultSchema },
  /** wire: `ThreadInvite` */
  "invites.restore": { input: z.object({ id: spaceRecordIdSchema }), result: nullResultSchema },
  // -- spaces
  "spaces.create": { input: createSpaceInputSchema, result: z.object({ id: spaceIdSchema }) },
  "spaces.update": { input: updateSpaceInputSchema, result: nullResultSchema },
  "spaces.verifyDomain": {
    input: z.object({ id: spaceIdSchema, domain: z.string(), method: z.literal("dns").optional() }),
    result: nullResultSchema,
  },
  "spaces.archive": {
    input: z.object({ id: spaceIdSchema, archived: z.boolean() }),
    result: nullResultSchema,
  },
  "spaces.delete": { input: z.object({ id: spaceIdSchema }), result: nullResultSchema },
  // -- skills and pages
  "skills.create": { input: z.object(skillInput), result: nullResultSchema },
  "skills.update": {
    input: z.object({
      ...skillInput,
      index: count,
      /** The skill's version the editor opened (step 9). */
      base: z.object({ rev: count }).optional(),
      force: z.boolean().optional(),
    }),
    result: nullResultSchema,
  },
  "skills.remove": { input: z.object({ ...spaceInput, index: count }), result: nullResultSchema },
  "skills.reorder": {
    input: z.object({ ...spaceInput, from: count, to: count }),
    result: nullResultSchema,
  },
  "pages.update": { input: updatePageInputSchema, result: nullResultSchema },
  "pages.restore": {
    input: z.object({
      ...spaceInput,
      page: count,
      rev: count,
      note: z.string(),
      base: pageBaseSchema.optional(),
      force: z.boolean().optional(),
    }),
    result: nullResultSchema,
  },
  "pages.remove": { input: z.object({ ...spaceInput, page: count }), result: nullResultSchema },
  "pages.move": {
    input: z.object({ ...spaceInput, from: count, to: count }),
    result: nullResultSchema,
  },
  // -- API keys (TODO(limits)); `raw` is write-only
  "apiKeys.create": {
    input: z.object({
      raw: z.string(),
      label: z.string(),
      cap: z.number().optional(),
      check: z.boolean().optional(),
    }),
    result: z.object({ id: spaceUlidSchema }),
  },
  "apiKeys.replace": {
    input: z.object({ id: spaceRecordIdSchema, raw: z.string() }),
    result: nullResultSchema,
  },
  "apiKeys.check": { input: z.object({ id: spaceRecordIdSchema }), result: nullResultSchema },
  "apiKeys.rename": {
    input: z.object({ id: spaceRecordIdSchema, label: z.string() }),
    result: nullResultSchema,
  },
  "apiKeys.setCap": {
    input: z.object({ id: spaceRecordIdSchema, cap: z.number() }),
    result: nullResultSchema,
  },
  "apiKeys.revoke": { input: z.object({ id: spaceRecordIdSchema }), result: nullResultSchema },
  // -- profile and settings
  /** wire: `User` */
  "profile.update": { input: spaceProfileSchema, result: nullResultSchema },
  /** wire: `UserSettings` */
  "settings.update": { input: updateSettingsInputSchema, result: nullResultSchema },
  // -- sources added to spaces
  "spaceSources.add": {
    input: addSpaceSourceInputSchema,
    result: z.object({ id: spaceRecordIdSchema, review: z.boolean() }),
  },
  "spaceSources.review": {
    input: z.object({
      ...spaceInput,
      source: spaceRecordIdSchema,
      decision: z.enum(["approve", "reject", "remove", "restore", "keep"]),
    }),
    result: nullResultSchema,
  },
  "spaceSources.setPolicy": {
    input: z.object({ ...spaceInput, policy: sourcePolicySchema }),
    result: nullResultSchema,
  },
  "sourceReports.create": {
    input: z.object({ ...spaceInput, source: spaceRecordIdSchema, why: z.string() }),
    result: nullResultSchema,
  },
} satisfies Record<string, { input: z.ZodType; result: z.ZodType }>;

export type SpaceProcedureName = keyof typeof spaceProcedures;

// ---- paged queries: GET /api/rpc/<name>?input=<JSON> ----

/** A paged query's own input: an opaque cursor from the previous page, and a
 * limit from 1 to 100 (the query's default otherwise). */
export const spacePageInput = {
  cursor: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

/** One page, newest first: `InboxNotificationPage`'s shape (`nextCursor`
 * null on the last page) with the query's items. */
export const spacePageSchema = <Item extends z.ZodType>(item: Item) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

/** A page of the caller's notifications (`notifications.list`). wire:
 * `InboxNotificationPage`: the same page shape; the items are the mock's
 * notifications (`inboxNotificationSchema`). */
export const inboxNotificationPageSchema = spacePageSchema(inboxNotificationSchema);

/** A profile's follow-up (`users.listFollowUps`): `id` is
 * `"<thread>:<index>"`. */
export const userFollowUpSchema = researchExchangeNodeSchema.extend({
  id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}:\d+$/),
  thread: spaceThreadIdSchema,
  index: count,
});

/** A space's sources list entry (`spaceSources.list`): `id` is the source's
 * id (`m`). */
export const spaceSourceEntrySchema = spaceSourceSchema.extend({ id: spaceRecordIdSchema });

const threadKind = { kind: z.enum(["ask", "post"]).optional() };

/** Every query: its input and its output (a page, or `{ count }`). */
export const spaceQueries = {
  "threads.feed": {
    input: z.object({
      scope: z.enum(["joined", "all", "public"]).optional(),
      ...threadKind,
      ...spacePageInput,
    }),
    output: spacePageSchema(researchTreeSummarySchema),
  },
  "threads.list": {
    input: z.object({
      space: spaceIdSchema,
      topic: z.string().optional(),
      ...threadKind,
      ...spacePageInput,
    }),
    output: spacePageSchema(researchTreeSummarySchema),
  },
  /** wire: `InboxNotificationPage` */
  "notifications.list": {
    input: z.object(spacePageInput),
    output: inboxNotificationPageSchema,
  },
  /** after: only the unread notifications after a cursor (the ones not loaded
   * yet). Not a page. */
  "notifications.unreadCount": {
    input: z.object({ after: z.string().nullable().optional() }),
    output: z.object({ count }),
  },
  "users.listThreads": {
    input: z.object({ handle: spaceHandleSchema, ...spacePageInput }),
    output: spacePageSchema(researchTreeSummarySchema),
  },
  "users.listFollowUps": {
    input: z.object({ handle: spaceHandleSchema, ...spacePageInput }),
    output: spacePageSchema(userFollowUpSchema),
  },
  "saved.list": {
    input: z.object({
      space: spaceIdSchema.optional(),
      q: z.string().optional(),
      ...spacePageInput,
    }),
    output: spacePageSchema(researchTreeSummarySchema),
  },
  "search.threads": {
    input: z.object({ q: z.string(), space: spaceIdSchema.optional(), ...spacePageInput }),
    output: spacePageSchema(researchTreeSummarySchema),
  },
  /** wire: `ThreadMember[]` */
  "members.list": {
    input: z.object({ space: spaceIdSchema, ...spacePageInput }),
    output: spacePageSchema(threadMemberSchema),
  },
  "joinRequests.list": {
    input: z.object({
      space: spaceIdSchema,
      state: z.enum(["open", "approved", "declined"]).optional(),
      ...spacePageInput,
    }),
    output: spacePageSchema(joinRequestSchema),
  },
  "reports.list": {
    input: z.object({
      space: spaceIdSchema,
      state: z.enum(["open", "dismissed", "hidden", "removed"]).optional(),
      ...spacePageInput,
    }),
    output: spacePageSchema(reportSchema),
  },
  "spaceSources.list": {
    input: z.object({ space: spaceIdSchema, ...spacePageInput }),
    output: spacePageSchema(spaceSourceEntrySchema),
  },
  /** TODO(limits) stub; default limit 8. */
  "usage.listAsks": {
    input: z.object(spacePageInput),
    output: spacePageSchema(usageAskSchema),
  },
} satisfies Record<string, { input: z.ZodType; output: z.ZodType }>;

export type SpaceQueryName = keyof typeof spaceQueries;

// ---- events: GET /api/rpc/events.subscribe (EventSource) ----

/** wire: `NotificationPayload` (`types/sharing.ts`), which has no schema of
 * its own; `test/spacesMock.test.ts` checks that this one matches it. */
export const notificationPayloadSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  tone: z.enum(["info", "success", "warning", "error"]),
  timeoutMs: z.number(),
  createdAt: z.number(),
  href: z.string().optional(),
  kind: z.enum(["runFinished", "followUp", "branch", "invite"]).optional(),
  treeId: z.string().optional(),
});

/** An event of the type `type` with `payload`, in the `SessionEvent`
 * envelope (`{ type, payload, timestamp }`). */
const spaceEvent = <Type extends string, Payload extends z.ZodType>(type: Type, payload: Payload) =>
  sessionEventEnvelopeSchema.extend({ type: z.literal(type), payload });

/** The events the mock sends. wire: `SessionEvent`, the envelope
 * (`{ type, payload, timestamp }`, `./events.ts`) with these types and
 * payloads. Run events follow `03-api-and-events.md` §3;
 * `nodeId` is the run's key, `"<thread>:<node>"`. Differences from the real
 * events, all from the mock:
 * - `research.run.started`: `model` is null when the ask named no model (the
 *   real event's is a string).
 * - `research.node.updated`: `node` is `{ id, treeId, status, error? }`, not a
 *   whole `ResearchNode`, and the payload adds `changes`, the records the
 *   run wrote (the real client fetches the node's content instead).
 * - `notification.requested`: `NotificationPayload` plus `changes` (the
 *   stored notification).
 * - `workspace.updated`: `workspace` is a space (spaces replace workspaces),
 *   with `changes`.
 * - `apiKeys.updated`: mock only (TODO(limits)): a key check finished.
 * The mock sends no `research.run.thinking` or `research.turn.delta` (owner
 * decision: no streamed answer text). */
export const sessionEventSchema = z.discriminatedUnion("type", [
  spaceEvent("connection.ready", z.object({ connectionId: z.string() })),
  spaceEvent(
    "research.run.started",
    z.object({
      nodeId: askNodeKeySchema,
      attempt: count,
      seq: count,
      model: z.string().nullable(),
    }),
  ),
  spaceEvent(
    "research.turn.committed",
    z.object({ nodeId: askNodeKeySchema, seq: count, turn: turnSchema }),
  ),
  spaceEvent(
    "research.run.finished",
    z.object({
      nodeId: askNodeKeySchema,
      attempt: count,
      seq: count,
      status: researchNodeStatusSchema,
      error: z.string().optional(),
    }),
  ),
  spaceEvent(
    "research.node.updated",
    z.object({
      node: z.object({
        id: askNodeKeySchema,
        treeId: spaceThreadIdSchema,
        status: researchNodeStatusSchema,
        error: z.string().optional(),
      }),
      changes: spaceChangesSchema,
    }),
  ),
  spaceEvent(
    "notification.requested",
    notificationPayloadSchema.extend({ changes: spaceChangesSchema }),
  ),
  spaceEvent(
    "workspace.updated",
    z.object({ workspace: spaceSchema.nullable(), changes: spaceChangesSchema }),
  ),
  spaceEvent(
    "apiKeys.updated",
    z.object({ keyId: spaceRecordIdSchema, changes: spaceChangesSchema }),
  ),
]);

// ---- development rows (/api/dev/*): not part of the product API ----

/** The read rules a dev override can switch off (the mock's READ_RULES). */
export const spaceReadRulesSchema = z.object({
  closedThreads: z.boolean(),
  closedFollowUps: z.boolean(),
  closedContent: z.boolean(),
  closedSources: z.boolean(),
  closedMembers: z.boolean(),
  ownOrModerated: z.boolean(),
  pendingSources: z.boolean(),
});

export const spaceDevConfigSchema = z.object({
  /** The mock clock. */
  now: spaceIsoTimeSchema,
  base: z.number(),
  latency: z.number(),
  failWrites: z.boolean(),
  failReads: z.boolean(),
  failCode: spaceErrorCodeSchema,
  failOn: z
    .object({
      code: spaceErrorCodeSchema,
      paths: z.array(z.string()).optional(),
      methods: z.array(z.string()).optional(),
      times: z.number().optional(),
    })
    .nullable(),
  readRules: spaceReadRulesSchema,
  jobs: z.enum(["run", "paused"]),
  jobMs: z.number().nonnegative(),
  checkMs: z.number().nonnegative(),
  failNextRun: z.enum(["tokens", "key", "rate"]).nullable(),
  resumeJobs: z.boolean(),
  pageSize: z.number().int().min(1).max(100).nullable(),
});

export const spaceDevConfigInputSchema = spaceDevConfigSchema
  .extend({ readRules: spaceReadRulesSchema.partial() })
  .partial();

// ---- the API table: one entry per row of the mock's API ----

const rpcRows = Object.fromEntries(
  Object.entries(spaceProcedures).map(([name, p]) => [
    `POST /api/rpc/${name}`,
    { input: p.input, output: spaceProcedureResponseSchema(p.result) },
  ]),
);

const queryRows = Object.fromEntries(
  Object.entries(spaceQueries).map(([name, q]) => [
    `GET /api/rpc/${name}`,
    { input: q.input, output: q.output },
  ]),
);

const c = spaceCollectionSchemas;

/** Every row of the mock's API table, by `"<METHOD> <path>"`: the schema of
 * its input (null: none) and of its response body (null: none). A
 * procedure's body is `{ result, changes }`; the event stream's output is one
 * event. `test/spacesMock.test.ts` fails when the mock has a row this table
 * lacks. */
export const spacesApi: Record<string, { input: z.ZodType | null; output: z.ZodType | null }> = {
  "GET /api/spaces": { input: null, output: c.spaces },
  /** wire: `ResearchTreeSummary[]` */
  "GET /api/threads": { input: null, output: c.posts },
  /** wire: `ResearchTreeDetail` */
  "GET /api/threads/:id": { input: null, output: researchTreeDetailSchema },
  /** wire: `ResearchNodeContent` */
  "GET /api/answers": { input: null, output: c.rich },
  /** wire: `ResearchNodeContent` */
  "GET /api/answers/:id": { input: null, output: researchNodeContentSchema },
  /** wire: `ResearchNodeContent` */
  "GET /api/answer-sources": { input: null, output: c.srcd },
  "GET /api/follow-ups": { input: null, output: c.fu },
  "GET /api/replies": { input: null, output: c.rp },
  /** wire: `ResearchTreeDetail` */
  "GET /api/ask-trees": { input: null, output: c.qtd },
  /** wire: `ResearchNode[]` */
  "GET /api/runs": { input: null, output: c.runs },
  "GET /api/sources": { input: null, output: c.media },
  "GET /api/sources/new": { input: null, output: c.miAdded },
  "GET /api/me/memberships": { input: null, output: c.joined },
  "GET /api/me/roles": { input: null, output: c.roles },
  "GET /api/me/roles/granted": { input: null, output: c.roles0 },
  "GET /api/me/closed-spaces": { input: null, output: c.rel },
  "GET /api/me/likes": { input: null, output: c.liked },
  "GET /api/me/saved": { input: null, output: c.saved },
  "GET /api/me/saved-asks": { input: null, output: c.qtSaved },
  "GET /api/me/saved-sources": { input: null, output: c.miSaved },
  "GET /api/me/read-sources": { input: null, output: c.miRead },
  /** TODO(limits) */
  "GET /api/me/api-keys": { input: null, output: c.userKeys },
  /** wire: `InboxNotificationPage` (the paged query is notifications.list) */
  "GET /api/me/notifications": { input: null, output: c.notifs },
  "GET /api/me/invite-requests": { input: null, output: c.askedInv },
  "GET /api/join-requests": { input: null, output: c.reqs },
  /** wire: `ThreadMember[]` */
  "GET /api/members": { input: null, output: c.mem },
  /** wire: `ThreadMember[]` */
  "GET /api/members/other-spaces": { input: null, output: c.memOther },
  "GET /api/bans": { input: null, output: c.banned },
  /** wire: `ThreadInvite[]` */
  "GET /api/invite-links": { input: null, output: c.links },
  "GET /api/reports": { input: null, output: c.reports },
  "GET /api/moderation": { input: null, output: c.modSt },
  "GET /api/space-sources": { input: null, output: c.dsDrops },
  "GET /api/space-source-policies": { input: null, output: c.dsPol },
  "GET /api/source-reports": { input: null, output: c.dsReps },
  /** wire: `User` */
  "GET /api/me/profile": { input: null, output: c.profile },
  "GET /api/space-skills": { input: null, output: c.skills },
  "GET /api/pages": { input: null, output: c.pagedocs },
  /** wire: `UserSettings` */
  "GET /api/me/settings": { input: null, output: c.acct },
  /** TODO(limits) */
  "GET /api/me/usage": { input: null, output: c.usage },
  "GET /api/me/muted": { input: null, output: c.muted },
  "GET /api/me/blocked": { input: null, output: c.blocked },
  "GET /api/me/reports-seen": { input: null, output: c.repSeen },
  "GET /api/me/requests-seen": { input: null, output: c.reqSeen },
  "GET /api/me/reply-likes": { input: null, output: c.rpLiked },
  /** wire: `User` */
  "GET /api/users": { input: null, output: c.people },
  /** wire: `User` */
  "GET /api/me": { input: null, output: userSchema },
  /** wire: `SessionEvent` */
  "GET /api/rpc/events.subscribe": { input: null, output: sessionEventSchema },
  "POST /api/dev/reset": { input: null, output: null },
  "POST /api/dev/scenario": {
    input: z.object({ name: z.string(), args: z.record(z.string(), z.unknown()).optional() }),
    output: z.object({ changes: spaceChangesSchema }),
  },
  "GET /api/dev/config": { input: null, output: spaceDevConfigSchema },
  "PUT /api/dev/config": { input: spaceDevConfigInputSchema, output: spaceDevConfigSchema },
  ...rpcRows,
  ...queryRows,
};
