// Checks of the spaces contract (`src/schemas/spaces.ts`) that do not need a
// server: mutator inputs are strict, look-ups carry no prompt, the removed
// first-draft surfaces are gone, and every record kind has a key form.
// `@session/replica-proto` parses every record its server stores with
// `storedRecordSchema`.

import test from "ava";

import { spaces } from "../src/index.js";

const ID = "01KA0000000000000000000000";
const ID2 = "01KA0000000000000000000001";

test("every mutator input refuses a field it does not list", (t) => {
  for (const [name, m] of Object.entries(spaces.spaceMutators)) {
    const r = m.input.safeParse({ forged: true });
    t.false(r.success, name);
  }
  const ask = { id: ID, space: ID2, kind: "ask", q: "Why?", model: "m", effort: "low" };
  t.true(spaces.spaceMutators["threads.create"].input.safeParse(ask).success);
  t.false(spaces.spaceMutators["threads.create"].input.safeParse({ ...ask, u: "olga" }).success);
});

test("an ask carries an explicit effort, and a look-up carries its phrase and no prompt", (t) => {
  const fork = spaces.spaceMutators["research.forkNode"].input;
  const base = { id: ID, thread: ID2, parent: "r", model: "m", effort: "high" };
  t.true(fork.safeParse({ ...base, kind: "ask", q: "More?" }).success);
  t.false(fork.safeParse({ ...base, kind: "ask", q: "More?", effort: undefined }).success);
  t.true(fork.safeParse({ ...base, kind: "lookup", look: "tide gauge" }).success);
  t.false(fork.safeParse({ ...base, kind: "lookup", look: "tide gauge", q: "hidden" }).success);
  const post = spaces.spaceMutators["threads.create"].input;
  t.false(post.safeParse({ id: ID, space: ID2, kind: "ask", q: "Why?", model: "m" }).success);
});

test("the contract has no likes, rules, reports, join requests or staff roles", (t) => {
  const names = Object.keys(spaces.spaceMutators);
  for (const gone of [
    "likes.toggle",
    "likes.set",
    "reports.create",
    "reports.resolve",
    "members.setRole",
    "joinRequests.create",
    "joinRequests.decide",
    "followups.ask",
    "saved.toggle",
  ])
    t.false(names.includes(gone), gone);
  t.deepEqual(spaces.spaceMemberRoleSchema.options, ["member", "owner"]);
  t.deepEqual(spaces.spaceVisibilitySchema.options, ["open", "private"]);
  t.false("rules" in spaces.spaceRecordSchema.shape);
  t.false("mods" in spaces.spaceRecordSchema.shape);
  t.false("likes" in spaces.countsRecordSchema.shape);
  t.deepEqual(spaces.notificationTypeSchema.options, [
    "mention",
    "reply",
    "branch",
    "comment",
    "removed",
    "invite_used",
  ]);
  t.deepEqual(spaces.userStatusSchema.options, ["waiting", "active"]);
});

test("every record kind has a key form, and the union covers it", (t) => {
  const kinds = spaces.storedRecordSchema.options.map((o) => o.shape.kind.value).sort();
  t.deepEqual(kinds, Object.keys(spaces.spaceRecordKeys).sort());
});

test("only the owner moderates, edits About, bans and makes channel links", (t) => {
  const owner = Object.entries(spaces.spaceMutators)
    .filter(([, m]) => m.who === "owner")
    .map(([n]) => n)
    .sort();
  t.deepEqual(owner, [
    "invites.create",
    "invites.restore",
    "invites.revoke",
    "members.ban",
    "members.remove",
    "members.unban",
    "moderation.decide",
    "spaces.update",
  ]);
  t.deepEqual(
    Object.entries(spaces.spaceMutators)
      .filter(([, m]) => m.online)
      .map(([n]) => n),
    ["spaces.create"],
  );
});

test("the sync codes are answer codes, and the unrecorded ones are listed", (t) => {
  for (const code of [
    "STALE",
    "CLOCK_SKEW",
    "EXPIRED",
    "OUT_OF_ORDER",
    "WRONG_CLIENT",
    "UPGRADE_REQUIRED",
    "TOO_LARGE",
  ] as const)
    t.true(spaces.spaceErrorCodeSchema.options.includes(code), code);
  t.false((spaces.unrecordedErrorCodes as readonly string[]).includes("PRECONDITION_FAILED"));
  const queueFull = {
    code: "PRECONDITION_FAILED",
    message: "You have 20 asks waiting to run.",
    reason: "queue_full",
  };
  t.true(spaces.spaceErrorSchema.safeParse(queueFull).success);
});

test("a moderation decision is discriminated: shown needs base, a reason goes with a removal only", (t) => {
  const d = spaces.spaceMutators["moderation.decide"].input;
  const item = `f:${ID}:${ID2}`;
  t.true(d.safeParse({ item, decision: "shown", base: { rev: 1 } }).success);
  t.false(d.safeParse({ item, decision: "shown" }).success);
  t.true(d.safeParse({ item, decision: "hidden" }).success);
  t.true(d.safeParse({ item, decision: "removed", note: "Spam" }).success);
  t.false(d.safeParse({ item, decision: "hidden", note: "Spam" }).success);
  for (const ok of [`a:${ID}`, `p:${ID}`, `f:${ID}:${ID2}`, `r:${ID}:${ID2}`, `c:${ID}:${ID2}`])
    t.true(spaces.moderationKeySchema.safeParse(ok).success, ok);
  for (const bad of [
    `a:${ID}:${ID2}`,
    `f:${ID}`,
    `f:${ID}:__proto__`,
    `x:${ID}`,
    `c:${ID}:${ID2}:x`,
  ])
    t.false(spaces.moderationKeySchema.safeParse(bad).success, bad);
});

test("questions, replies, comments and look-up phrases are not empty", (t) => {
  const m = spaces.spaceMutators;
  t.false(m["threads.create"].input.safeParse({ id: ID, space: ID2, kind: "post", q: "" }).success);
  t.false(m["research.createPostFollowUp"].input.safeParse({ id: ID, thread: ID2, t: "" }).success);
  t.false(m["comments.create"].input.safeParse({ id: ID, thread: ID2, node: "r", t: "" }).success);
  const look = {
    id: ID,
    thread: ID2,
    parent: "r",
    kind: "lookup",
    look: "",
    model: "m",
    effort: "low",
  };
  t.false(m["research.forkNode"].input.safeParse(look).success);
});

test("a node's look and tpl follow its kind", (t) => {
  const node = {
    kind: "node",
    id: ID,
    th: ID2,
    s: ID2,
    par: "r",
    k: "ask",
    u: "ada",
    q: "Why?",
    look: null,
    quote: null,
    b: null,
    tpl: null,
    model: "m",
    effort: "low",
    run: ID,
    promoted: null,
    mod: null,
    del: false,
    createdAt: "2026-11-16T10:00:00Z",
    rev: 1,
  };
  t.true(spaces.nodeRecordSchema.safeParse(node).success);
  t.false(spaces.nodeRecordSchema.safeParse({ ...node, look: "tide", tpl: 1 }).success);
  t.true(spaces.nodeRecordSchema.safeParse({ ...node, k: "lookup", look: "tide", tpl: 1 }).success);
  t.false(spaces.nodeRecordSchema.safeParse({ ...node, k: "lookup", look: "tide" }).success);
  // a removed look-up keeps its template version, not its phrase
  t.true(
    spaces.nodeRecordSchema.safeParse({ ...node, k: "lookup", tpl: 1, mod: "removed" }).success,
  );
});
