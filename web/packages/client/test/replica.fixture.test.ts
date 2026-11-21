// The fixture replica (02 §9.6, W9.1): the mockup's fixtures in the stored
// shape, read through the read rules, written through the real mutators.

import { spaces } from "@session/shared";
import test from "ava";

import { createFixtureReplica } from "../src/replica/fixtureReplica.js";
import {
  askTreeOf,
  channelByName,
  channelsOf,
  feedOf,
  savedCountOf,
  threadOf,
  unreadCountOf,
} from "../src/replica/queries.js";
import { makeWrites } from "../src/replica/writes.js";

const FIRST = "01M7HWGZJGT7JTFFVSYPX055KV";

test("every converted record parses with the contract's schema", (t) => {
  const replica = createFixtureReplica("ines.v", { runMs: null });
  const bad: string[] = [];
  for (const kind of [
    "space",
    "member",
    "thread",
    "counts",
    "node",
    "run",
    "answer",
    "reply",
    "comment",
    "save",
    "notif",
    "modlog",
    "ban",
    "stats",
    "prefs",
  ] as const) {
    for (const r of replica.rawAll(kind)) {
      const parsed = spaces.storedRecordSchema.safeParse(r);
      if (!parsed.success)
        bad.push(
          `${kind}: ${parsed.error.issues[0]?.message ?? ""} ${JSON.stringify(r).slice(0, 120)}`,
        );
    }
  }
  t.deepEqual(bad.slice(0, 5), []);
  replica.dispose();
});

test("channels: the strip's order, the viewer's relation, private ones hidden from readers outside", (t) => {
  const member = createFixtureReplica("ines.v", { runMs: null });
  const names = channelsOf(member).map((c) => c.name);
  t.deepEqual(names.slice(0, 4), ["public", "sci-fi", "markets", "ml-papers"]);
  t.true(names.includes("grant-review"), "a private channel she is in");
  t.false(names.includes("northwind-eng") && !channelByName(member, "northwind-eng"));
  const scifi = channelByName(member, "sci-fi");
  t.like(scifi, { owned: true, joined: true, private: false });
  const out = createFixtureReplica(null, { runMs: null });
  t.false(feedOf(out, { kind: "home" }).some((id) => threadOf(out, id)?.space?.private));
  member.dispose();
  out.dispose();
});

test("home is newest first from joined channels; saved lists the saved threads", (t) => {
  const replica = createFixtureReplica("ines.v", { runMs: null });
  const home = feedOf(replica, { kind: "home" });
  t.is(home[0], FIRST);
  const saved = feedOf(replica, { kind: "saved" });
  t.is(saved.length, savedCountOf(replica));
  t.true(saved.length > 0);
  t.is(unreadCountOf(replica), 3);
  replica.dispose();
});

test("the first ask's tree keeps the mock's nodes and passages", (t) => {
  const replica = createFixtureReplica("ines.v", { runMs: null });
  const tree = askTreeOf(replica, FIRST);
  t.is(tree.nodes.length, 6);
  const tops = tree.nodes.filter((n) => n.par === "r");
  t.is(tops.length, 3);
  t.true(tops.every((n) => typeof n.b === "number"));
  t.regex(tree.answers["r"]?.md ?? "", /\[\^5\]/);
  t.is(threadOf(replica, FIRST)?.counts?.r, 6);
  replica.dispose();
});

test("a save and an ask go through the mutators; the run answers", async (t) => {
  const replica = createFixtureReplica("ines.v", { runMs: null });
  const writes = makeWrites(replica);
  const before = threadOf(replica, FIRST)?.counts?.saves ?? 0;
  const wasSaved = threadOf(replica, FIRST)?.saved ?? false;
  t.true(await writes.save(FIRST, !wasSaved));
  t.is(threadOf(replica, FIRST)?.counts?.saves, before + (wasSaved ? -1 : 1));

  const scifi = channelByName(replica, "sci-fi");
  if (!scifi) throw new Error("no sci-fi");
  const id = await writes.ask(scifi.id, "what is a bloom filter", "gemini-flash", "high");
  t.truthy(id);
  if (!id) return;
  t.is(feedOf(replica, { kind: "home" })[0], id);
  t.is(askTreeOf(replica, id).runs["r"]?.status, "running");
  replica.flushRuns();
  t.is(askTreeOf(replica, id).runs["r"]?.status, "complete");
  t.regex(
    askTreeOf(replica, id).answers["r"]?.md ?? "",
    /^Mock answer to "what is a bloom filter"/,
  );
  replica.dispose();
});

test("a signed-out replica reads open channels and writes nothing", async (t) => {
  const replica = createFixtureReplica(null, { runMs: null });
  t.false(channelsOf(replica).some((c) => c.joined));
  const outcome = await replica.mutate("saved.set", { kind: "thread", id: FIRST, on: true });
  t.false(outcome.ok);
  replica.dispose();
});
