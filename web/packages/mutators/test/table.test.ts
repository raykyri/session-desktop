// `01` U5: every mutator with who may call it, its stale-intent rule, whether
// it is online only and whether it is allowed in a frozen space (`04` B6),
// and agreement with the contract (`spaces.spaceMutators`).

import { spaces } from "@session/shared";
import test from "ava";

import { MUTATORS, type Intent, type Who } from "../src/index.js";

type Row = [Who, Intent, "online" | "queued", "frozen ok" | ""];

const TABLE: Record<string, Row> = {
  "spaces.create": ["user", "none", "online", ""],
  "spaces.update": ["owner", "none", "queued", ""],
  "spaces.join": ["user", "none", "queued", ""],
  "spaces.leave": ["member", "none", "queued", "frozen ok"],
  "members.remove": ["owner", "base.adm", "queued", ""],
  "members.ban": ["owner", "as is", "queued", ""],
  "members.unban": ["owner", "as is", "queued", ""],
  "threads.create": ["member", "none", "queued", ""],
  "threads.update": ["author", "base.rev", "queued", ""],
  "threads.delete": ["author", "as is", "queued", "frozen ok"],
  "saved.set": ["user", "none", "queued", "frozen ok"],
  "research.forkNode": ["member", "none", "queued", ""],
  "followups.update": ["author", "base.rev", "queued", ""],
  "followups.delete": ["author", "as is", "queued", "frozen ok"],
  "research.cancelNode": ["author", "as is", "queued", ""],
  "research.retryNode": ["author", "base.attempt", "queued", ""],
  "research.createPostFollowUp": ["member", "none", "queued", ""],
  "replies.update": ["author", "base.rev", "queued", ""],
  "replies.delete": ["author", "as is", "queued", "frozen ok"],
  "comments.create": ["member", "none", "queued", ""],
  "comments.update": ["author", "base.rev", "queued", ""],
  "comments.delete": ["author", "as is", "queued", "frozen ok"],
  "invites.create": ["owner", "none", "queued", ""],
  "invites.revoke": ["owner", "as is", "queued", ""],
  "invites.restore": ["owner", "as is", "queued", ""],
  "moderation.decide": ["owner", "base.rev when shown", "queued", ""],
  "notifications.markRead": ["user", "none", "queued", "frozen ok"],
  "notifications.markAllRead": ["user", "none", "queued", ""],
  "prefs.set": ["user", "none", "queued", ""],
};

test("the table lists every mutator with its who, stale-intent rule, online and frozen rule", (t) => {
  const got = Object.fromEntries(
    Object.entries(MUTATORS).map(([name, d]) => [
      name,
      [d.who, d.intent, d.online ? "online" : "queued", d.frozen === "allowed" ? "frozen ok" : ""],
    ]),
  );
  t.deepEqual(got, TABLE);
});

test("the mutators are the contract's procedures, with its who and online", (t) => {
  t.deepEqual(Object.keys(MUTATORS).sort(), Object.keys(spaces.spaceMutators).sort());
  for (const [name, c] of Object.entries(spaces.spaceMutators)) {
    const d = MUTATORS[name];
    t.is(d?.who, c.who, name);
    t.is(d?.online ?? false, c.online, name);
  }
  // space creation is online only (AGENTS.md)
  t.deepEqual(
    Object.entries(MUTATORS)
      .filter(([, d]) => d.online)
      .map(([n]) => n),
    ["spaces.create"],
  );
});

test("there are no likes, reports, roles or join requests", (t) => {
  for (const gone of [
    "likes.set",
    "reports.create",
    "reports.resolve",
    "members.setRole",
    "joinRequests.create",
    "joinRequests.decide",
    "followups.ask",
    "saved.toggle",
  ])
    t.false(Object.hasOwn(MUTATORS, gone), gone);
});
