// Channel ownership, removal, bans and channel invite links over the sync
// routes (plan `04` B2, B4, O2, O5): what the real server answers and serves
// to each reader.

import type { Change, Pull, Snapshot } from "@session/sync/server";
import test from "ava";

import type { Harness } from "./helpers.js";
import { createHarness } from "./helpers.js";
import { Person, channels, newId } from "./syncHttp.js";

async function pull(p: Person | Harness, log: string, cursor: string): Promise<Pull> {
  const path = `/api/sync/pull?log=${encodeURIComponent(log)}&cursor=${encodeURIComponent(cursor)}`;
  const res =
    p instanceof Person ? await p.h.request(path, { cookie: p.cookie }) : await p.request(path);
  return (await res.json()) as Pull;
}

async function signedOut(h: Harness, log: string): Promise<Snapshot> {
  const res = await h.request("/api/sync/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ log }),
  });
  return (await res.json()) as Snapshot;
}

const recordOf = (s: Snapshot, key: string) => s.records.find((r) => r.key === key)?.record;
const changeOf = (p: Pull, key: string) => {
  const c: Change | undefined = "changes" in p ? p.changes.find((x) => x.key === key) : undefined;
  return c?.op === "put" ? c : undefined;
};

test("B2: a member's ban, removal and invite link and the owner's ban of themselves are FORBIDDEN; the owner cannot leave", async (t) => {
  const h = createHarness(t);
  const { olga, mona, mel, open, closed } = await channels(h);
  t.like(await mona.write("members.ban", { space: open, user: "mel" }), {
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  t.like(await mel.write("members.remove", { space: closed, user: "olga", base: { adm: "x" } }), {
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  t.like(await mel.write("invites.create", { id: newId(), space: closed, days: 7 }), {
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  t.like(await olga.write("members.ban", { space: open, user: "olga" }), {
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  t.like(await olga.write("spaces.leave", { space: open }), {
    ok: false,
    error: { code: "PRECONDITION_FAILED" },
  });
});

test("O2: after a removal every reader but the author gets u: null, in snapshot and pull; only the owner gets the modlog entry, with the author", async (t) => {
  const h = createHarness(t);
  const { olga, mona, mel, open } = await channels(h);
  const th = newId();
  await mel.ok("threads.create", { id: th, space: open, kind: "post", q: "To be removed" });
  const log = `space:${open}`;
  const readers = { olga, mona, mel };
  const cursors: Record<string, string> = {};
  for (const [name, p] of Object.entries(readers)) cursors[name] = (await p.snapshot(log)).cursor;
  const outCursor = (await signedOut(h, log)).cursor;

  await olga.ok("moderation.decide", { item: `p:${th}`, decision: "removed", note: "Off topic" });

  for (const [name, p] of Object.entries(readers)) {
    const snap = recordOf(await p.snapshot(log), `thread:${th}`);
    const pulled = changeOf(await pull(p, log, cursors[name] ?? ""), `thread:${th}`);
    const expected = name === "mel" ? "mel" : null;
    t.like(snap, { mod: "removed", modBy: "olga", modNote: "Off topic", q: "", u: expected }, name);
    t.like(pulled?.record, { mod: "removed", u: expected }, name);
  }
  t.like(recordOf(await signedOut(h, log), `thread:${th}`), { u: null, q: "" });
  t.like(changeOf(await pull(h, log, outCursor), `thread:${th}`)?.record, { u: null });

  const modlog = (s: Snapshot) => s.records.filter((r) => r.record.kind === "modlog");
  const owner = modlog(await olga.snapshot(log));
  t.is(owner.length, 1);
  t.like(owner[0]?.record, { act: "remove", item: `p:${th}`, author: "mel", note: "Off topic" });
  t.deepEqual(modlog(await mona.snapshot(log)), []);
  t.deepEqual(modlog(await mel.snapshot(log)), []);
  t.deepEqual(modlog(await signedOut(h, log)), []);
  // the author's notification: the reason, no text of the thread
  const notes = (await mel.snapshot("user:mel")).records
    .map((r) => r.record)
    .filter((r) => r.kind === "notif" && r.type === "removed");
  t.is(notes.length, 1);
  t.false(JSON.stringify(notes).includes("To be removed"));
  t.like(notes[0], { th, note: "Off topic", actor: null });
});

test("B4: a link's expiry is 1 to 30 days; a plain member's snapshot and pull hold no link record", async (t) => {
  const h = createHarness(t);
  const { olga, mel, closed } = await channels(h);
  const log = `space:${closed}`;
  const before = await mel.snapshot(log);
  for (const days of [null, 0, 31])
    t.like(await olga.write("invites.create", { id: newId(), space: closed, days }), {
      ok: false,
      error: { code: "BAD_REQUEST" },
    });
  const made = (await olga.ok("invites.create", { id: newId(), space: closed, days: 30 })) as {
    id: string;
    code: string;
  };
  t.regex(made.code, /^[0-9a-z]{26}$/);
  t.true((await olga.snapshot(log)).records.some((r) => r.record.kind === "invite"));
  t.false((await mel.snapshot(log)).records.some((r) => r.record.kind === "invite"));
  const pulled = await pull(mel, log, before.cursor);
  t.true("changes" in pulled);
  t.false(JSON.stringify(pulled).includes(made.code));
  t.false(JSON.stringify(pulled).includes(`invite:${made.id}`));
});

test("B4: a used link admits nobody else; a banned person cannot join with a link", async (t) => {
  const h = createHarness(t);
  const { olga, closed } = await channels(h);
  const eve = new Person(h, h.addUser("eve"));
  const ann = new Person(h, h.addUser("ann"));
  const link = (await olga.ok("invites.create", { id: newId(), space: closed, days: 7 })) as {
    code: string;
  };
  await eve.ok("spaces.join", { space: closed, invite: link.code });
  t.like(await ann.write("spaces.join", { space: closed, invite: link.code }), {
    ok: false,
    error: { code: "FORBIDDEN", message: "This invite link has expired or was already used." },
  });
  await olga.ok("members.ban", { space: closed, user: "ann" });
  const fresh = (await olga.ok("invites.create", { id: newId(), space: closed, days: 7 })) as {
    code: string;
  };
  t.like(await ann.write("spaces.join", { space: closed, invite: fresh.code }), {
    ok: false,
    error: { code: "FORBIDDEN" },
  });
});

test("C12: members.remove answers removed: true when it removes the member, and removed: false for one who had already left", async (t) => {
  const h = createHarness(t);
  const { olga, mel, closed } = await channels(h);
  const adm = (h.sync.store.byKey(`member:${closed}:mel`) as { adm: string }).adm;
  await mel.ok("spaces.leave", { space: closed });
  t.deepEqual(await olga.ok("members.remove", { space: closed, user: "mel", base: { adm } }), {
    removed: false,
  });
  const ann = new Person(h, h.addUser("ann"));
  const link = (await olga.ok("invites.create", { id: newId(), space: closed, days: 7 })) as {
    code: string;
  };
  await ann.ok("spaces.join", { space: closed, invite: link.code });
  const annAdm = (h.sync.store.byKey(`member:${closed}:ann`) as { adm: string }).adm;
  t.deepEqual(
    await olga.ok("members.remove", { space: closed, user: "ann", base: { adm: annAdm } }),
    { removed: true },
  );
});

test("C18: a banned person's snapshot and pull of their user log hold their own ban and no other, naming nobody else", async (t) => {
  const h = createHarness(t);
  const { olga, mona, mel, open, closed } = await channels(h);
  const eve = new Person(h, h.addUser("eve"));
  const before = await eve.snapshot("user:eve");
  await olga.ok("members.ban", { space: closed, user: "eve" });
  await olga.ok("members.ban", { space: open, user: "eve" });
  await olga.ok("members.ban", { space: open, user: "mona" });
  await olga.ok("members.ban", { space: closed, user: "mel" });
  const bans = (s: Snapshot) => s.records.filter((r) => r.record.kind === "ban");
  const keys = (s: Snapshot) => bans(s).map((r) => r.key);
  const mine = [`ban:${closed}:eve`, `ban:${open}:eve`].sort();
  const snap = await eve.snapshot("user:eve");
  t.deepEqual(keys(snap).sort(), mine);
  for (const r of bans(snap))
    t.deepEqual(Object.keys(r.record).sort(), ["createdAt", "id", "kind", "rev", "sp", "u"]);
  t.false(JSON.stringify(snap.records).includes("olga"), "nothing names who banned her");
  const pulled = await pull(eve, "user:eve", before.cursor);
  t.deepEqual(("changes" in pulled ? pulled.changes : []).map((c) => c.key).sort(), mine);
  // the open channel's log, which she still reads: her own ban only
  t.deepEqual(keys(await eve.snapshot(`space:${open}`)), [`ban:${open}:eve`]);
  // a member who is not banned reads no ban; the owner reads all of them
  t.deepEqual(keys(await mel.snapshot(`space:${open}`)), []);
  t.deepEqual(keys(await mona.snapshot("user:mona")), [`ban:${open}:mona`]);
  t.deepEqual(
    keys(await olga.snapshot(`space:${open}`)).sort(),
    [`ban:${open}:eve`, `ban:${open}:mona`].sort(),
  );
});
