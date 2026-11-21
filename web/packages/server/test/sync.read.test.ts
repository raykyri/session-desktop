// `POST /api/sync/read` (`01` R5, `04` Z1): a reader of many channels reads
// their logs in one request, counted once against the snapshot limit, and
// each log is read under the caller's own scope.

import type { StoredRecord } from "@session/mutators";
import test from "ava";

import { createHarness } from "./helpers.js";
import { Person, newId } from "./syncHttp.js";

interface ReadAnswers {
  answers: (
    | { records: { key: string; record: StoredRecord }[]; cursor: string }
    | { changes: { key: string }[]; cursor: string }
    | { resync: true }
    | { error: { code: string } }
  )[];
}

const read = (h: ReturnType<typeof createHarness>, body: unknown, cookie?: string) =>
  h.request("/api/sync/read", {
    method: "POST",
    ...(cookie ? { cookie } : {}),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("forty open channels and a private one in one request, signed out, each filtered by its scope", async (t) => {
  const h = createHarness(t, { env: { SESSION_LIMIT_SNAPSHOTS_PER_MINUTE: "2" } });
  const olga = new Person(h, h.addUser("olga"));
  const open: string[] = [];
  for (let i = 0; i < 40; i++) {
    const id = newId();
    await olga.ok("spaces.create", { id, name: `room-${i}` });
    open.push(id);
  }
  const lab = newId();
  await olga.ok("spaces.create", { id: lab, name: "lab", vis: "private" });
  const secret = newId();
  await olga.ok("threads.create", { id: secret, space: lab, kind: "post", q: "Members only" });
  const shown = newId();
  await olga.ok("threads.create", { id: shown, space: open[0], kind: "post", q: "For anyone" });

  const reads = [...open, lab].map((sp) => ({ log: `space:${sp}`, tier: "summary" }));
  const res = await read(h, { reads });
  t.is(res.status, 200);
  const { answers } = (await res.json()) as ReadAnswers;
  t.is(answers.length, 41);
  const keys = (i: number) => {
    const a = answers[i];
    return a && "records" in a ? a.records.map((r) => r.key) : [];
  };
  t.true(keys(0).includes(`thread:${shown}`));
  // the private channel's landing only
  t.deepEqual(
    keys(40).filter((k) => !k.startsWith("space:") && !k.startsWith("stats:")),
    [],
  );
  t.false(keys(40).includes(`thread:${secret}`));

  // a pull with the cursor each snapshot gave, in the same kind of request
  const cursor = (answers[0] as { cursor: string }).cursor;
  const again = await read(h, { reads: [{ log: `space:${open[0]}`, cursor }] });
  t.is(again.status, 200);
  const pulled = ((await again.json()) as ReadAnswers).answers[0];
  t.true(pulled !== undefined && "changes" in pulled);

  // two requests within the limit of 2 a minute; the third is refused
  t.is((await read(h, { reads })).status, 429);
});

test("a read the server half refuses answers its error in its place", async (t) => {
  const h = createHarness(t);
  const res = await read(h, { reads: [{ log: "user:nobody" }, { log: 3 }] });
  t.is(res.status, 200);
  const { answers } = (await res.json()) as ReadAnswers;
  t.like(answers[1], { error: { code: "BAD_REQUEST" } });
  t.is((await read(h, { reads: [] })).status, 400);
  t.is(
    (await read(h, { reads: Array.from({ length: 101 }, () => ({ log: "user:a" })) })).status,
    400,
  );
});
