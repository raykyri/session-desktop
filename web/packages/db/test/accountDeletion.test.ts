// The account-deletion job as the operator runs it (`db:admin -- --delete`,
// plan `04` B6, §8): with the server stopped, the spaces step writes through a
// sync core over the job's own connection.

import { MUTATORS } from "@session/mutators";
import { SyncServer } from "@session/sync/server";
import test from "ava";

import { SqliteStore, accounts } from "../src/index.js";

import { addActiveUser, createFixture } from "./helpers.js";

test("the job over its own connection freezes the owner's channels and erases their records", (t) => {
  const { db } = createFixture(t);
  const olga = addActiveUser(db, "olga");
  addActiveUser(db, "mona");
  // the records the server would have written
  const server = new SyncServer({
    store: new SqliteStore(db),
    clock: { now: Date.now },
    mutators: MUTATORS,
  });
  const lounge = "01KAAAAAAAAAAAAAAAAAAAAAAA";
  const write = (me: string, name: string, input: unknown) => {
    const def = MUTATORS[name];
    if (!def) throw new Error(name);
    const done = server.serverApply({ me }, (tx) => def.run(tx, def.input.parse(input), {}));
    if (!done.ok) throw new Error(`${name}: ${done.error.code}`);
  };
  write("olga", "spaces.create", { id: lounge, name: "lounge" });
  write("mona", "spaces.join", { space: lounge });
  write("olga", "prefs.set", { layout: "wide" });

  const deleted = accounts.deleteAccount(db, olga.id);
  t.deepEqual(deleted.spaces, { items: 0, records: 2, frozen: ["lounge"] });
  // a store opened afterwards, as the restarted server's is
  const after = new SqliteStore(db);
  t.like(after.byKey(`space:${lounge}`), { frozen: true, owner: "olga", members: 1 });
  t.is(after.byKey(`member:${lounge}:olga`), undefined);
  t.is(after.byKey("prefs:olga"), undefined);
  t.like(after.byKey(`member:${lounge}:mona`), { role: "member" });
});
