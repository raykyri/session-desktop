// Mutation runs for the suite: each mutation changes one place in `src/` of a
// copy of the package, then the type check and the whole suite run in that
// copy, and the run lists the tests that failed. A mutation no test kills is
// a gap in the suite. The package itself is never changed.
//
// Run from the package directory: `npm run mutate [-- <name prefix> ...]`,
// or `npm run mutate -- --check` to check only that every pattern matches
// once. `--slots <n>` sets how many copies run at once (default 4).
//
// X1 to X31 are review round 1's mutations and the ones round 1's fixes
// added, N1 to N34 review round 2's, R2-1 on cover round 2's fixes, U6-1 on
// the build's contract (`01` U6). Each pattern is moved with the code; the
// fault stays the same, or, where the code it named is gone, is the same
// fault in the code that replaced it (the comment says so). Removed with the
// code they named (`01` U6): X2 (opening a space; visibility no longer
// changes), X9 (ownership transfer), X11, N24's report form and R2-5
// (reporting), N13 and N14 (members making invite links), N11, N17, R2-15,
// R2-16 and R2-17 (the effect queue).
//
// The mutators, the stored shape and the read rules moved to
// `@session/mutators` in M1b: their patterns name `../mutators/src/<file>`,
// with the faults kept. In M2 the suite moved to `@session/sync`'s server and
// client halves, and the patterns that named `src/server.ts`, `src/client.ts`
// and `src/contract.ts` name `../sync/src/<file>` (or `src/sync-target.ts`
// for the test access), with the faults kept: the store's expiry loops are
// `MemoryStore`'s, the token code is `tokens.ts`'s. Each slot holds a copy of that package too, which the
// copy of this one imports; a mutation in it is type-checked there and runs
// that package's suite as well as this one. M1b-1 on cover the checks M1b
// added (the model registry, the run queue limit, frozen spaces, a parent
// whose run has not ended, look-up phrases, promotion, cancel and retry).
// Z4 to Z28 are the M2 build's own mutations that the suite did not kill
// then, and M2-1 on cover the M2 review's fixes (the window's live threads,
// rev-merged promotions, serialized reads, applied writes, in-flight drops,
// the clock, replays, client ids, prediction fullness, savepoints, hidden
// copies).
//
// M6-C1 on are the M6 review's faults in the web client: a slot holds a copy
// of `@session/client` as well (linked to the copies of the two packages
// above), and a client mutation runs the client test files it names
// (`files`), not this package's suite, which does not import the client.
// M6-C48 on cover the M6 tail: the removal toast of C12 (`removed`), the
// ban toast of C18 (the person's own ban record) and the invite tree's
// deleted accounts.
//
// Before the mutations, the suites run in an unmutated slot: a failure there
// stops the run (a mutation is not killed by a test that fails anyway). A
// mutation's type check does not decide whether it is killed: the suites
// run on the sources as they are, and the run lists the mutations whose copy
// does not type-check separately.

import { spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface Mutation {
  name: string;
  file: string;
  from: string;
  to: string;
  /** Further places in the same file, for a fault that two checks guard. */
  also?: { from: string; to: string }[];
  /** A fault in a copied package that the acceptance suite cannot reach (a
   * client-only path, a package's own helper): killed by that package's
   * suite. Every other mutation must fail this package's suite. */
  packageOnly?: boolean;
  /** For a fault in `@session/client` (always `packageOnly`): the client
   * test files that hold the tests meant to kill it. Only these run, not
   * this package's suite, which does not import the client. */
  files?: string[];
}

const edits = (m: Mutation) => [{ from: m.from, to: m.to }, ...(m.also ?? [])];

const MUTATIONS: Mutation[] = [
  // ---- review round 1 ----
  {
    name: "X1 a ban keeps the membership",
    file: "../mutators/src/members.ts",
    from: "      if (member) tx.del(memberKey(i.space, i.user));\n      if (!tx.byKey(banKey",
    to: "      if (!tx.byKey(banKey",
  },
  {
    name: "X3 an author's delete keeps the text",
    file: "../mutators/src/threads.ts",
    from: '        q: "",\n        t: null,\n        edited: false,',
    to: "        edited: false,",
  },
  {
    name: "X4 a hidden thread keeps its title and summary",
    file: "../mutators/src/access.ts",
    from: "        t: null,\n        sum: null,\n        u: r.mod",
    to: "        u: r.mod",
  },
  {
    name: "X5 lastSeq of anyone's client",
    file: "../sync/src/server/server.ts",
    from: "    if (!c || c.u !== u || c.seen <= now - this.clientIdleTtl) return null;\n    this.store.putClient({ ...c, seen: now });",
    to: "    if (!c || c.seen <= now - this.clientIdleTtl) return null;\n    this.store.putClient({ ...c, seen: now });",
  },
  {
    name: "X6 the invite code is taken from the client's id",
    file: "../mutators/src/invites.ts",
    from: '      within(ctx, "invites.create");\n      const B32',
    to: '      within(ctx, "invites.create");\n      if (i.id) return { code: i.id.toLowerCase() };\n      const B32',
    also: [
      {
        from: "    pre: (ctx) => {\n      // 20 links",
        to: "    pre: (ctx, i) => {\n      // 20 links",
      },
    ],
  },
  {
    name: "X7 an invite link is not used up",
    file: "../mutators/src/spaces.ts",
    from: 'if (link) tx.put({ ...link, dead: "Used", usedBy: tx.me });',
    to: "",
  },
  {
    name: "X8 a snapshot sorted by key only",
    file: "../sync/src/server/server.ts",
    from: "      return x < y ? -1 : x > y ? 1 : born(a.key) - born(b.key);",
    to: "      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;",
  },
  {
    name: "X10 a del sent for tombstones the reader may not read",
    file: "../sync/src/server/server.ts",
    from: "return t && readsAudience(this.store, t, u) ? true : null;",
    to: "return t ? true : null;",
  },
  {
    name: "X12 idempotency kept 5 days",
    file: "../sync/src/server/server.ts",
    from: "export const DEDUP_TTL = 7 * DAY;",
    to: "export const DEDUP_TTL = 5 * DAY;",
  },
  {
    // likes are gone (`01` C1); the count is the saves' now
    name: "X13 a save counts twice",
    file: "../mutators/src/rules.ts",
    from: 'const n = tx.count("save", { th });',
    to: 'const n = 2 * tx.count("save", { th });',
  },
  {
    name: "X14 a removal keeps the title and summary",
    file: "../mutators/src/rules.ts",
    from: '        q: "",\n        t: null,\n        sum: null,\n        tok: 0,',
    to: '        q: "",\n        tok: 0,',
  },
  {
    name: "X16 an approval ignores the ban",
    file: "src/join-requests.ts",
    from: '          if (bannedFrom(tx, i.space, u))\n            throw refuse("PRECONDITION_FAILED", "This person is banned from the space.");\n',
    to: "",
  },
  {
    // a follow-up's answer is the node's `answer` record now (`01` C3)
    name: "X18 a hidden node's answer keeps its text",
    file: "../mutators/src/access.ts",
    from: 'return { ...r, md: "", pages: [] } satisfies AnswerRec;',
    to: "return r;",
  },
  {
    // follow-ups are nodes now (`01` U6)
    name: "X19 node tombstones are never pruned",
    file: "../sync/src/server/memory.ts",
    from: "      if (t.at >= at) break;\n      this.remove(this.tombs, key);",
    to: '      if (t.at >= at) break;\n      if (t.kind !== "node") this.remove(this.tombs, key);',
  },
  {
    name: "X20 threads.delete gets kept wrong",
    file: "../mutators/src/threads.ts",
    from: '      const kept = counts.r > 0 || tx.count("comment", { th: p.id }) > 0;\n',
    to: '      const kept = counts.r > 1 || tx.count("comment", { th: p.id }) > 0;\n',
  },
  {
    // round 1's fault was a version that showed the server's head. Versions
    // are sealed in tokens now; the same leak is a token in the clear.
    name: "X21 a cursor token is not encrypted",
    file: "../sync/src/server/tokens.ts",
    from: '    const body = Buffer.concat([cipher.update(plain), cipher.final()]);\n    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");',
    to: '    void cipher;\n    return Buffer.concat([iv, plain, Buffer.alloc(TOKEN_TAG)]).toString("base64url");',
    also: [
      {
        from: '      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, TOKEN_IV));\n      decipher.setAAD(TOKEN_AAD);\n      decipher.setAuthTag(raw.subarray(raw.length - TOKEN_TAG));\n      plain = Buffer.concat([\n        decipher.update(raw.subarray(TOKEN_IV, raw.length - TOKEN_TAG)),\n        decipher.final(),\n      ]);',
        to: "      void createDecipheriv;\n      void key;\n      void TOKEN_AAD;\n      plain = raw.subarray(TOKEN_IV, raw.length - TOKEN_TAG);",
      },
    ],
  },
  {
    name: "X22 an approval ignores the request's rev",
    file: "src/join-requests.ts",
    from: '        if (i.decision !== "decline" && r.rev !== i.base[u]) throw stale();\n',
    to: "",
  },
  {
    name: "X23 a 'shown' ignores the item's rev",
    file: "../mutators/src/moderation.ts",
    from: '      if (i.decision === "shown" && r.rev !== i.base?.rev) throw stale();\n',
    to: "",
  },
  {
    // the member record's rev became the admission id (round 2, decision 2)
    name: "X24 a removal ignores the admission id",
    file: "../mutators/src/members.ts",
    from: "      if (m.adm !== i.base.adm) throw stale();\n",
    to: "",
  },
  {
    name: "X25 a tombstone keeps the whole record",
    file: "../sync/src/server/server.ts",
    from: "const tomb: Tombstone = { key, ...audience(store, old), at };",
    to: "const tomb = { ...old, key, ...audience(store, old), at } as Tombstone;",
  },
  {
    // likes are gone; saves and notifications share the rule
    name: "X26 saves and notifications ignore access to their space",
    file: "../mutators/src/access.ts",
    from: "      return own && (sp === null || readsSpace(g, sp, u));",
    to: "      return own;",
  },
  {
    name: "X27 INTERNAL_SERVER_ERROR is recorded",
    file: "../sync/src/wire.ts",
    from: '  "INTERNAL_SERVER_ERROR",\n  "TOO_LARGE",\n]);',
    to: '  "TOO_LARGE",\n]);',
  },
  {
    name: "X28 the client does not follow OUT_OF_ORDER's expected seq",
    file: "../sync/src/client/client.ts",
    from: 'code === "OUT_OF_ORDER" && expectedSeq !== undefined',
    to: 'code === "OUT_OF_ORDER" && expectedSeq === -1',
  },
  {
    // an online-only write that waited was a recorded refusal in round 1's
    // fault; it is one now (EXPIRED), so the fault is that it is applied
    name: "X29 an online-only write that waited in an outbox is applied",
    file: "../sync/src/server/server.ts",
    from: "      if (def.online && m.clientTime - ulidTime(m.mutationId) > ONLINE_MAX_AGE)",
    to: "      if (def.online && m.clientTime - ulidTime(m.mutationId) > 1000 * ONLINE_MAX_AGE)",
  },
  {
    name: "X30 a cursor's age is not checked",
    file: "../sync/src/server/server.ts",
    from: "      c.at < now - TOMBSTONE_TTL\n",
    to: "      false\n",
  },
  {
    name: "X31 the client drops a write after a transient answer",
    file: "../sync/src/client/client.ts",
    from: "          p.notBefore =\n            now +\n            Math.min(\n              RETRY_MAX,\n              Math.max(RETRY_MIN * 2 ** (p.attempts - 1), res.error.retryAfterMs ?? 0),\n            );\n          break;",
    to: "          this.outbox.shift();\n          break;",
  },
  // ---- review round 2 ----
  // N1 (a pull moves its version past rows the reader may not read) is not a
  // fault any more: the version is sealed in the token, and a row the reader
  // may not read becomes readable only by a change of scope (a resync) or by
  // being written again (a new version). It is left out.
  {
    name: "N2 a token is accepted from another reader",
    file: "../sync/src/server/server.ts",
    from: "      c.u !== u ||\n",
    to: "",
  },
  {
    name: "N3 a token is accepted for another log",
    file: "../sync/src/server/server.ts",
    from: "      c.log !== log ||\n",
    to: "",
  },
  {
    name: "N4 a token is accepted after the log's history was replaced",
    file: "../sync/src/server/server.ts",
    from: "      c.n !== this.store.epoch(log).n ||\n",
    to: "",
  },
  {
    // round 2: a version-0 cursor's made-up epoch was accepted. The analog:
    // a token that does not open is read as one at version 0
    name: "N5 a token that does not open counts as version 0",
    file: "../sync/src/server/server.ts",
    from: "    const c = this.tokens.open(cursor, now);\n",
    to: "    const c = this.tokens.open(cursor, now) ?? { log, u, n: this.store.epoch(log).n, v: 0, h: 0, at: now, hid: this.store.history() };\n",
  },
  {
    // visibility no longer changes (`01` C11): the space log whose history is
    // replaced is the restored one (`replaceHistory`)
    name: "N6 user log: a space log's history being replaced is not noticed",
    file: "../sync/src/server/server.ts",
    from: "      if (start > head) return true;",
    to: "      if (start > head + 1e9) return true;",
  },
  {
    name: "N7 user log: a membership change is not noticed",
    file: "../sync/src/server/server.ts",
    from: '      if (row.key.startsWith("member:") && row.version > version) return true;\n',
    to: "",
  },
  {
    // the rev rule moved to `StagedTx` (M1b review 2): the same fault there
    name: "N8 a record written again at a deleted key restarts at rev 1",
    file: "../mutators/src/staged.ts",
    from: "const rev = (committed?.rev ?? this.source.lastRev?.(registryKey(r)) ?? 0) + 1;",
    to: "void registryKey;\n    const rev = (committed?.rev ?? 0) + 1;",
  },
  {
    name: "N9 a finished run writes text to a removed item",
    file: "src/sync-target.ts",
    from: 'if (!r || !("mod" in r) || r.mod === "removed") return false;',
    to: 'if (!r || !("mod" in r)) return false;',
  },
  {
    name: "N10 TOO_MANY_REQUESTS and SERVICE_UNAVAILABLE are recorded",
    file: "../sync/src/wire.ts",
    from: '  "TOO_MANY_REQUESTS",\n  "SERVICE_UNAVAILABLE",\n',
    to: "",
  },
  {
    name: "N12 an invite link ignores its expiry",
    file: "../mutators/src/spaces.ts",
    from: "        link.dead === null &&\n        isoToMs(link.expiresAt) > isoToMs(tx.now);",
    to: "        link.dead === null;",
  },
  {
    name: "N15 answers under (client, seq) are never expired",
    file: "../sync/src/server/memory.ts",
    from: "      if (a.at > at) break;\n      this.remove(this.seqAnswers, k);",
    to: "      if (a.at > at - 1e15) break;\n      this.remove(this.seqAnswers, k);",
  },
  {
    // the job effect is gone: the run record with status `queued` is the
    // run queue (`01` U6), so the same fault is that record not written
    name: "N16 an ask's queued run is not written",
    file: "../mutators/src/threads.ts",
    from: '      queueRun(tx, run, root, "r", i.model, i.effort, pay);',
    to: "      void queueRun;",
  },
  {
    // the served-cursor table is gone (decision 1); the table that grows
    // with callers now is the client records
    name: "N20 client records are never expired",
    file: "../sync/src/server/memory.ts",
    from: "      if (c.seen > at) break;\n      this.remove(this.clients, id);",
    to: "      if (c.seen > at - 1e15) break;\n      this.remove(this.clients, id);",
  },
  {
    // likes are gone; notifications follow the same rule as saves
    name: "N21 a save or notification tombstone is served to its person whatever their access",
    file: "../sync/src/server/server.ts",
    from: "    return t && readsAudience(this.store, t, u) ? true : null;",
    to: '    return t &&\n      (readsAudience(this.store, t, u) ||\n        ((t.kind === "save" || t.kind === "notif") && t.person === u))\n      ? true\n      : null;',
  },
  {
    // admins are gone (`01` C18): About is the owner's
    name: "N22 control: spaces.update needs only a member",
    file: "../mutators/src/spaces.ts",
    from: '    who: "owner",\n    intent: "none",\n    space: (_tx, i) => i.id,',
    to: '    who: "member",\n    intent: "none",\n    space: (_tx, i) => i.id,',
  },
  {
    name: "N23 a decline reason survives the person asking again",
    file: "src/join-requests.ts",
    from: "        why: null,\n        createdAt: old",
    to: '        why: old?.kind === "request" ? old.why : null,\n        createdAt: old',
  },
  {
    // reports are gone; the same control on a notification the notify stage
    // writes (`01` U6)
    name: "N24 control: one notification in 32 is not written",
    file: "../mutators/src/notify.ts",
    from: '    tx.create({\n      kind: "notif",',
    to: '    if (tx.id(NOTIFY_ORDINAL + this.k + 1).endsWith("0")) return;\n    tx.create({\n      kind: "notif",',
  },
  {
    // tombstones no longer hold the rev; the registry does
    name: "N25 a deleted key's rev is forgotten",
    file: "../sync/src/server/server.ts",
    from: "        store.deleteRecord(key);\n",
    to: "        store.deleteRecord(key);\n        store.setLastRev(registryKey(old), 0);\n",
  },
  {
    name: "N26 the client keeps an expired write in the outbox",
    file: "../sync/src/client/client.ts",
    from: 'for (const p of [...this.outbox]) if (p.queuedAt < now - OUTBOX_TTL) this.giveUp(p, "DROPPED");',
    to: "void now;",
  },
  {
    name: "N27 the client does not remap later writes after new ids",
    file: "../sync/src/client/client.ts",
    from: "for (const x of this.outbox) if (!x.sent) x.input = remap(x.input, map);",
    to: "for (const x of this.outbox) if (x === this.outbox[0]) x.input = remap(x.input, map);",
  },
  {
    name: "N28 the client's seq does not follow a read's lastSeq",
    file: "../sync/src/client/client.ts",
    from: "    if (lastSeq !== null) this.acked = lastSeq;",
    to: "",
  },
  {
    name: "N29 a deleted record's id may be used again",
    file: "../sync/src/server/memory.ts",
    from: "    this.records.delete(key);\n    this.index(prev, key, false);\n    this.born.delete(key);",
    to: '    this.records.delete(key);\n    this.index(prev, key, false);\n    this.born.delete(key);\n    if ("id" in prev) this.registry.delete(prev.id);',
  },
  {
    name: "N30 a version-0 token's history is not checked",
    file: "../sync/src/server/server.ts",
    from: "      c.n !== this.store.epoch(log).n ||\n",
    to: "      (c.v > 0 && c.n !== this.store.epoch(log).n) ||\n",
  },
  {
    // tokens are sealed, not counted; the same weakness is a token that does
    // not need the key to make
    name: "N31 a token opens without the key's authentication",
    file: "../sync/src/server/tokens.ts",
    from: "      decipher.setAuthTag(raw.subarray(raw.length - TOKEN_TAG));\n      plain = Buffer.concat([\n        decipher.update(raw.subarray(TOKEN_IV, raw.length - TOKEN_TAG)),\n        decipher.final(),\n      ]);",
    to: "      plain = decipher.update(raw.subarray(TOKEN_IV, raw.length - TOKEN_TAG));",
  },
  {
    name: "N33 an empty pull does not renew the token's serve time",
    file: "../sync/src/server/server.ts",
    from: "    return { changes, cursor: this.serve(log, u, to, now), lastSeq, serverTime: now };",
    to: "    return { changes, cursor: this.serve(log, u, to, changes.length ? now : c.at), lastSeq, serverTime: now };",
  },
  {
    name: "N34 the token key is a constant",
    file: "../sync/src/server/tokens.ts",
    from: "    this.key = keys?.current ?? randomBytes(32);",
    to: "    this.key = keys?.current ?? Buffer.alloc(32);",
  },
  {
    name: "R2-1 a hide or a removal is STALE after the item changed",
    file: "../mutators/src/moderation.ts",
    from: '      if (i.decision === "shown" && r.rev !== i.base?.rev) throw stale();',
    to: "      if (r.rev !== i.base?.rev) throw stale();",
  },
  {
    name: "R2-2 a decline is STALE after the request changed",
    file: "src/join-requests.ts",
    from: '        if (i.decision !== "decline" && r.rev !== i.base[u]) throw stale();',
    to: "        if (r.rev !== i.base[u]) throw stale();",
  },
  {
    name: "R2-3 joining an open space again keeps the admission id",
    file: "../mutators/src/spaces.ts",
    from: '      addMember(tx, s.id, tx.me, "member", tx.id(1));',
    to: '      addMember(tx, s.id, tx.me, "member", `${s.id}:${tx.me}`);',
  },
  {
    // likes are gone; a save is the write that changes the counts
    name: "R2-4 a save changes the thread record",
    file: "../mutators/src/rules.ts",
    from: "  tx.put({ ...c, saves });\n}",
    to: '  tx.put({ ...c, saves });\n  const p = tx.byKey(threadKey(th));\n  if (p?.kind === "thread") tx.put({ ...p, tok: p.tok + 1 });\n}',
  },
  {
    name: "R2-6 the client gives a sent write new ids",
    file: "../sync/src/client/client.ts",
    from: "    for (const p of this.outbox) {\n      if (p.sent) continue;",
    to: "    for (const p of this.outbox) {",
  },
  {
    name: "R2-7 the server does not check a mutation id's age",
    file: "../sync/src/server/server.ts",
    from: '    if (!ageOk(m.mutationId, m.clientTime)) return expired("mutationId");\n',
    to: "",
  },
  {
    name: "R2-8 the learned clock offset is not saved",
    file: "../sync/src/client/client.ts",
    from: "      offset: this.offset,\n",
    to: "      offset: 0,\n",
  },
  {
    name: "R2-9 registrations are not limited",
    file: "../sync/src/server/server.ts",
    from: "        if (store.registrationsSince(u, now - DAY + 1) >= this.registrationsPerDay)",
    to: "        if (store.registrationsSince(u, now - DAY + 1) >= this.registrationsPerDay * 1000)",
  },
  {
    name: "R2-10 the client does not register again on WRONG_CLIENT",
    file: "../sync/src/client/client.ts",
    from: 'if (code === "WRONG_CLIENT" && this.ownOutbox() && fresh++ < 1) {',
    to: 'if (code === "WRONG_CLIENT" && this.ownOutbox() && fresh++ < 0) {',
  },
  {
    name: "R2-11 the client registers for another person's outbox",
    file: "../sync/src/client/client.ts",
    from: "    if (!this.ownOutbox())\n",
    to: "    if ((false as boolean) && !this.ownOutbox())\n",
    also: [
      {
        from: 'if (code === "WRONG_CLIENT" && this.ownOutbox() && fresh++ < 1) {',
        to: 'if (code === "WRONG_CLIENT" && fresh++ < 1) {',
      },
    ],
  },
  {
    name: "R2-12 the client does not back off",
    file: "../sync/src/client/client.ts",
    from: "      if (p.notBefore > now && p.notBefore - now <= RETRY_MAX) break;",
    to: "      if (p.notBefore > now && p.notBefore - now < 0) break;",
  },
  {
    name: "R2-13 a write that keeps failing is never given up",
    file: "../sync/src/client/client.ts",
    from: "          if (p.errors >= MAX_SERVER_ERRORS) {",
    to: "          if (p.errors >= MAX_SERVER_ERRORS * 1000) {",
  },
  {
    name: "R2-14 a write dropped at 3 days is not shown",
    file: "../sync/src/client/client.ts",
    from: 'if (p.queuedAt < now - OUTBOX_TTL) this.giveUp(p, "DROPPED");',
    to: "if (p.queuedAt < now - OUTBOX_TTL) this.outbox.splice(this.outbox.indexOf(p), 1);",
  },
  {
    name: "R2-18 an input's depth is not bounded",
    file: "../sync/src/server/server.ts",
    from: "    const bounds = outOfBounds(envelope, MAX_INPUT_DEPTH + 1, MAX_ENVELOPE_BYTES);",
    to: "    const bounds = outOfBounds(envelope, 1e9, MAX_ENVELOPE_BYTES);",
  },
  {
    name: "R2-19 an envelope's size is not bounded",
    file: "../sync/src/server/server.ts",
    from: '      Buffer.byteLength(JSON.stringify(envelope) ?? "") > MAX_ENVELOPE_BYTES\n',
    to: '      Buffer.byteLength(JSON.stringify(envelope) ?? "") > MAX_ENVELOPE_BYTES * 1000\n',
    also: [
      {
        from: "    const bounds = outOfBounds(envelope, MAX_INPUT_DEPTH + 1, MAX_ENVELOPE_BYTES);",
        to: "    const bounds = outOfBounds(envelope, MAX_INPUT_DEPTH + 1, 1e9);",
      },
    ],
  },
  {
    name: "R2-20 an exception outside the mutator stages is thrown",
    file: "../sync/src/server/server.ts",
    from: "      return this.applyEnvelope(actor, envelope);\n    } catch {",
    to: "      return this.applyEnvelope(actor, envelope);\n    } catch (e) {\n      if (e) throw e;",
  },
  {
    name: "R2-21 the device's clock is not checked against the server's",
    file: "../sync/src/server/server.ts",
    from: "    if (Math.abs(m.clientTime - now) > CLOCK_MAX_SKEW)",
    to: "    if (Math.abs(m.clientTime - now) > 1e15)",
  },
  {
    name: "R2-22 scanStorage leaves out the client records",
    file: "src/sync-target.ts",
    from: "      clients: [...s.clients.values()].map((c) => ({\n        clientId: c.clientId,\n        u: c.u,\n        last: c.last,\n        seen: c.seen,\n      })),",
    to: "      clients: [],",
  },
  {
    // the effect model's name rule is written apart from this one now
    // the mock's slug became the channel name rule (`04` B1): the same fault
    // is a name with a leading "-" accepted
    name: "R2-24 a space name keeps a leading '-'",
    file: "../mutators/src/validate.ts",
    from: "export const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,29}$/;",
    to: "export const CHANNEL_NAME_RE = /^[a-z0-9-][a-z0-9-]{1,29}$/;",
  },
  {
    name: "R2-23 the client gives up on a write after a lost answer",
    file: "../sync/src/client/client.ts",
    from: "      } catch {\n        res = noAnswer(this.now());\n        answered = false;",
    to: '      } catch {\n        res = { ok: false, error: { code: "NOT_FOUND", message: "", serverTime: 0 } };\n        answered = false;',
  },
  // ---- the build's contract (`01` U6): saves, notifications, removal,
  // owner-only writes, look-ups, counts and protocol version 4 ----
  {
    name: "U6-1 a private space serves a save count below 3",
    file: "../mutators/src/rules.ts",
    from: "  const saves = closed && n < PRIVATE_SAVES_MIN ? 0 : n;",
    to: "  const saves = closed ? n : n;",
  },
  {
    name: "U6-2 a removal keeps the saves of the thread",
    file: "../mutators/src/rules.ts",
    from: '      for (const x of userLogRecords(tx, "save", r.id)) drop(saveKey(x.u, x.th));\n',
    to: "",
  },
  {
    name: "U6-3 a removal keeps the mention notifications about the thread",
    file: "../mutators/src/rules.ts",
    from: '      for (const x of userLogRecords(tx, "notif", r.id).filter((y) => y.type === "mention"))\n        drop(`notif:${x.id}`);\n',
    to: "",
  },
  {
    name: "U6-4 a removed thread's author is served to every reader",
    file: "../mutators/src/access.ts",
    from: '        u: r.mod === "removed" && !author ? null : r.u,',
    to: "        u: r.u,",
  },
  {
    name: "U6-5 a person is notified of their own action",
    file: "../mutators/src/notify.ts",
    from: "    if (to === tx.me) return false;\n",
    to: "",
  },
  {
    name: "U6-6 reply, branch and comment notifications do not coalesce",
    file: "../mutators/src/notify.ts",
    from: "    if (COALESCED.has(type)) {",
    to: "    if (COALESCED.has(type) && type.length < 0) {",
  },
  {
    // mentions notify every account that may read the item (M1a review
    // 11): the same fault is a mention of a person who may not read it
    name: "U6-7 a mention notifies a person who is not a member",
    file: "../mutators/src/notify.ts",
    from: "    if (!readsSpace(tx, sp, to)) return false;",
    to: '    if (!readsSpace(tx, sp, to) && type !== "mention") return false;',
  },
  {
    name: "U6-8 a removal writes no moderation log entry",
    file: "../mutators/src/moderation.ts",
    from: "      // keeps no text of it\n      tx.create({",
    to: "      // keeps no text of it\n      void ({",
  },
  {
    name: "U6-9 a reminted envelope's answer is not stored under the ids it replaces",
    file: "../sync/src/server/server.ts",
    from: "if (id !== m.mutationId && !(old && old.at > now - DEDUP_TTL))",
    to: "if (id !== m.mutationId && !(old && old.at > now - DEDUP_TTL) && id.length < 0)",
  },
  {
    name: "U6-10 an envelope's queuedAt is not checked",
    file: "../sync/src/server/server.ts",
    from: '    if (!timeOk(m.queuedAt, m.clientTime)) return expired("queuedAt");\n',
    to: "",
  },
  {
    name: "U6-11 an oversized envelope answers BAD_REQUEST",
    file: "../sync/src/server/server.ts",
    from: '        refuse("TOO_LARGE", undefined, [',
    to: '        refuse("BAD_REQUEST", undefined, [',
  },
  {
    name: "U6-12 the owner may leave their space",
    file: "../mutators/src/spaces.ts",
    from: '      if (isOwnerOf(tx, i.space, tx.me))\n        throw refuse("PRECONDITION_FAILED", "You own this channel: the owner can’t leave it.");\n',
    to: "",
  },
  {
    name: "U6-13 the owner may ban or remove themselves",
    file: "../mutators/src/rules.ts",
    from: '  if (u === tx.me) throw refuse("FORBIDDEN", "You can’t change your own membership here.");\n',
    to: "",
  },
  {
    name: "U6-14 hiding a node leaves its answer shown",
    file: "../mutators/src/moderation.ts",
    from: '        if (a?.kind === "answer") tx.put({ ...a, mod });\n',
    to: "",
  },
  {
    name: "U6-15 a look-up stores the phrase as its prompt",
    file: "../mutators/src/nodes.ts",
    from: "        q = LOOKUP_PROMPT_V1(look);",
    to: "        q = look;",
  },
  {
    name: "U6-16 a reply to a reply does not count",
    file: "../mutators/src/rules.ts",
    from: 'tx.count("reply", { th: th.id });',
    to: 'tx.list("reply", { th: th.id }).filter((x) => x.parent === null).length;',
  },
  {
    name: "U6-17 a member makes channel invite links",
    file: "../mutators/src/invites.ts",
    from: '    input: M["invites.create"].input.extend({ id: ulidS, space: ulidS }).strict(),\n    who: "owner",',
    to: '    input: M["invites.create"].input.extend({ id: ulidS, space: ulidS }).strict(),\n    who: "member",',
  },
  {
    name: "U6-18 a removal's reason is not kept on the placeholder",
    file: "../mutators/src/rules.ts",
    from: "        modNote: note,",
    to: "        modNote: null,",
  },
  // ---- the M1a review's fixes ----
  {
    name: "M1a-10 a reminted write is applied again after its original was",
    file: "../sync/src/server/server.ts",
    from: "    if (wellFormed && !hit)\n      for (const id of m.replaces ?? []) {",
    to: "    if (wellFormed && !hit && m.seq < 0)\n      for (const id of m.replaces ?? []) {",
  },
  {
    name: "M1a-14 CLOCK_SKEW keeps the queue times read from the wrong clock",
    file: "../sync/src/client/client.ts",
    from: "            if (!x.sent && !x.known && raw >= x.rawAt) x.queuedAt += offset - this.offset;",
    to: "            if (!x.sent && !x.known && raw >= x.rawAt) x.queuedAt = Math.min(x.queuedAt, offset + raw);",
  },
  {
    name: "M1a-15 a reminted write names every earlier id",
    file: "../sync/src/client/client.ts",
    from: "      if (p.replaces.length > MAX_REPLACES) p.replaces.splice(0, p.replaces.length - MAX_REPLACES);\n",
    to: "",
  },
  {
    name: "M1a-11 a mention of a handle that is no account is not reported",
    file: "../mutators/src/notify.ts",
    from: "      if (!isHandle(h) || !this.ctx.isAccount(h)) out.notMembers.push(h);",
    to: "      if (!isHandle(h) || !this.ctx.isAccount(h)) continue;",
  },
  {
    name: "M1a-16 a reply, branch, comment or removal notifies a person who may not read the space",
    file: "../mutators/src/notify.ts",
    from: "    if (!readsSpace(tx, sp, to)) return false;",
    to: '    if (!readsSpace(tx, sp, to) && type === "mention") return false;',
  },
  {
    name: "M1a-12 an ask deleted with only comments under it is gone, its comments kept",
    file: "../mutators/src/threads.ts",
    from: '      const kept = counts.r > 0 || tx.count("comment", { th: p.id }) > 0;\n',
    to: "      const kept = counts.r > 0;\n",
  },
  {
    name: "M1a-13a removing a node keeps the nodes under it",
    file: "../mutators/src/rules.ts",
    from: "      for (const x of nodes) if (x.id !== r.id && under.has(x.id)) drop(nodeKey(x.id));\n",
    to: "",
  },
  {
    name: "M1a-13b removing a node leaves its run queued",
    file: "../mutators/src/rules.ts",
    from: "      for (const x of runs) drop(`run:${x.id}`);\n",
    to: "",
  },
  {
    name: "M1a-17 removing a reply, comment or node keeps the mentions of it",
    file: "../mutators/src/rules.ts",
    from: "    tx.del(`notif:${x.id}`);",
    to: "    void x;",
  },
  {
    name: "M1a-18a a branch notifies the thread's author, not the parent's",
    file: "../mutators/src/nodes.ts",
    from: 'send(authorOf(parent), "branch"',
    to: 'send(authorOf(p), "branch"',
  },
  {
    name: "M1a-18b a comment notifies the thread's author, not the node's",
    file: "../mutators/src/comments.ts",
    from: 'n.send(authorOf(node), "comment"',
    to: 'n.send(authorOf(p), "comment"',
  },
  {
    name: "M1a-18c anyone marks a notification read",
    file: "../mutators/src/notifications.ts",
    from: '      if (n?.kind !== "notif" || n.to !== tx.me || !canRead(tx, n, tx.me)) throw notFound();',
    to: '      if (n?.kind !== "notif") throw notFound();\n      void canRead;',
  },
  // ---- M1b: `@session/mutators` ----
  {
    name: "M1b-1 the run queue limit is not checked",
    file: "../mutators/src/rules.ts",
    from: "  if (ctx.queuedRuns() >= QUEUED_RUNS_MAX)",
    to: "  if (ctx.queuedRuns() >= QUEUED_RUNS_MAX * 1000)",
  },
  {
    name: "M1b-2 a model outside the registry is accepted",
    file: "../mutators/src/rules.ts",
    from: '  if (!entry) throw bad("model", "a model of the registry");\n  if (!entry.efforts',
    to: "  if (!entry) return;\n  if (!entry.efforts",
  },
  {
    name: "M1b-3 an effort the model does not accept is accepted",
    file: "../mutators/src/rules.ts",
    from: "  if (!entry.efforts.includes(effort as ReasoningEffort))",
    to: "  if (!entry.efforts.includes(effort as ReasoningEffort) && effort.length < 0)",
  },
  {
    name: "M1b-4 a frozen space takes every write",
    file: "../mutators/src/tx.ts",
    from: 'if (s.frozen && def.frozen !== "allowed")',
    to: 'if (s.frozen && def.frozen !== "allowed" && s.name === "")',
  },
  {
    name: "M1b-5 an author cannot delete their thread in a frozen space",
    file: "../mutators/src/threads.ts",
    from: '    intent: "as is",\n    frozen: "allowed",\n    // the author may delete',
    to: '    intent: "as is",\n    // the author may delete',
  },
  {
    name: "M1b-6 an ask is forked under a parent whose run is queued",
    file: "../mutators/src/rules.ts",
    from: '  r !== undefined && (r.status === "queued" || r.status === "running");',
    to: '  r !== undefined && r.status === "running";',
  },
  {
    name: "M1b-7 a look-up phrase need not be whole words of its quote",
    file: "../mutators/src/nodes.ts",
    from: "        if (!onWordBoundaries(look, i.quote))",
    to: '        if (!onWordBoundaries(look, i.quote) && look === "")',
  },
  {
    name: "M1b-8 a hidden branch is opened as its own thread",
    file: "../mutators/src/threads.ts",
    from: '  if (n.mod !== null) throw refuse("PRECONDITION_FAILED", "This branch is hidden.");\n',
    to: "",
  },
  {
    name: "M1b-9 a thread opened from a branch is the opener's",
    file: "../mutators/src/threads.ts",
    from: "    id,\n    u: n.u,",
    to: "    id,\n    u: tx.me,",
  },
  {
    name: "M1b-10 a complete run is run again",
    file: "../mutators/src/nodes.ts",
    from: '      if (run.status !== "failed" && run.status !== "cancelled" && run.status !== "interrupted")',
    to: '      if (run.status === "queued" || run.status === "running")',
  },
  {
    // a kept node's run is cancelled; a deleted one's run records go (M1b review 12)
    name: "M1b-11 deleting a node leaves its run going",
    file: "../mutators/src/nodes.ts",
    from: "        cancel(tx, runOf(tx, n));\n",
    to: "",
  },
  {
    name: "M1b-12 a node with nodes under it is erased by its author's delete",
    file: "../mutators/src/nodes.ts",
    from: "        nodes.some((x) => x.id !== n.id && under.has(x.id) && x.u !== tx.me) ||",
    to: "        nodes.some((x) => x.id !== n.id && under.has(x.id) && x.u !== tx.me && x.del) ||",
  },
  {
    name: "M1b-13 anyone cancels a run",
    file: "../mutators/src/nodes.ts",
    from: "    can: (tx, i) => {\n      if (authorAt(tx, i.thread, i.node) !== tx.me) throw notAuthor();\n    },\n    run: (tx, i) => {\n      const p = readableThread(tx, i.thread);\n      const n = nodeOf(tx, p, i.node);\n      const run = runOf(tx, n);\n      if (!active(run)) return null;",
    to: "    run: (tx, i) => {\n      const p = readableThread(tx, i.thread);\n      const n = nodeOf(tx, p, i.node);\n      const run = runOf(tx, n);\n      if (!active(run)) return null;",
  },
  {
    name: "M1b-14 a reply's edit ignores its rev",
    file: "../mutators/src/replies.ts",
    from: "      if (r.rev !== i.base.rev) throw stale();\n",
    to: "",
  },
  {
    name: "M1b-15 a used invite link is revoked and restored",
    file: "../mutators/src/invites.ts",
    from: '      if (l.dead === "Used") throw refuse("PRECONDITION_FAILED", "This link was already used.");\n      if (l.dead !== "Revoked") return null;',
    to: '      if (l.dead !== "Used" && l.dead !== "Revoked") return null;',
  },
  {
    name: "M1b-16 the queue-full refusal carries no reason",
    file: "../mutators/src/rules.ts",
    from: '      undefined,\n      "queue_full",\n',
    to: "      undefined,\n      undefined,\n",
  },
  // ---- M1b review fixes ----
  {
    name: "M1b-17 a retry ignores the attempt it was made for",
    file: "../mutators/src/nodes.ts",
    from: "      if (run.attempt !== i.base.attempt) throw stale();\n",
    to: "",
  },
  {
    name: "M1b-18 the ban check runs on clients only",
    file: "../mutators/src/tx.ts",
    from: "    if (tx.server && !def.ownLog?.(input) && bannedFrom(tx, sp, tx.me))",
    to: "    if (!tx.server && !def.ownLog?.(input) && bannedFrom(tx, sp, tx.me))",
  },
  {
    name: "M1b-19 a ban stops a person's own user-log writes",
    file: "../mutators/src/tx.ts",
    from: "    if (tx.server && !def.ownLog?.(input) && bannedFrom(tx, sp, tx.me))",
    to: "    if (tx.server && bannedFrom(tx, sp, tx.me))",
  },
  {
    name: "M1b-20 a gone thread takes new writes",
    file: "../mutators/src/rules.ts",
    from: "  if (p.gone) throw threadDeleted();",
    to: '  if (p.gone && p.q === "never") throw threadDeleted();',
  },
  {
    name: "M1b-21 a reply with only its author's replies under it stays as a shell",
    file: "../mutators/src/replies.ts",
    from: "      const kept = under.some((x) => x.u !== tx.me);",
    to: "      const kept = under.length > 0;",
  },
  {
    name: "M1b-22 a deleted node's run records stay",
    file: "../mutators/src/nodes.ts",
    from: "        for (const x of runs) tx.del(`run:${x.id}`);\n",
    to: "",
  },
  {
    name: "M1b-23 a removed node's copies keep their text",
    file: "../mutators/src/rules.ts",
    from: '  if (p?.kind === "thread" && p.mod !== "removed") erase(tx, p, note);',
    to: "  void p;",
  },
  {
    name: "M1b-24 a correction moves a write queued on a clock known to be right",
    file: "../sync/src/client/client.ts",
    from: "            if (!x.sent && !x.known && raw >= x.rawAt) x.queuedAt += offset - this.offset;",
    to: "            if (!x.sent && raw >= x.rawAt) x.queuedAt += offset - this.offset;",
  },
  {
    name: "M1b-25 a correction moves a write queued before the clock went back",
    file: "../sync/src/client/client.ts",
    from: "            if (!x.sent && !x.known && raw >= x.rawAt) x.queuedAt += offset - this.offset;",
    to: "            if (!x.sent && !x.known) x.queuedAt += offset - this.offset;",
  },
  {
    name: "M1b-26 a correction moves a sent write",
    file: "../sync/src/client/client.ts",
    from: "            if (!x.sent && !x.known && raw >= x.rawAt) x.queuedAt += offset - this.offset;",
    to: "            if (!x.known && raw >= x.rawAt) x.queuedAt += offset - this.offset;",
  },
  // ---- M1a review fixes 1, 2, 4, 7, 8, 9 (M1b review 19) ----
  {
    name: "M1a-1 a promoted thread does not name its source",
    file: "../mutators/src/threads.ts",
    from: "    from: { th: p.id, node: n.id },",
    to: "    from: null,",
  },
  {
    name: "M1a-2 a removed thread's placeholder keeps its model and effort",
    file: "../mutators/src/rules.ts",
    from: "        model: null,\n        effort: null,\n        running: false,",
    to: "        running: false,",
  },
  {
    name: "M1a-4 an applied answer carries no server time",
    file: "../sync/src/server/server.ts",
    from: "      ? { ...a, serverTime }",
    to: "      ? { ...a, serverTime: 0 }",
  },
  {
    name: "M1a-7 an ask node has a look-up's template",
    file: "../mutators/src/nodes.ts",
    from: '        tpl: i.kind === "lookup" ? 1 : null,',
    to: "        tpl: 1,",
  },
  {
    name: "M1a-8 a copied answer keeps its node's id",
    file: "../mutators/src/threads.ts",
    from: '  tx.put({ ...a, node: "r", th: id, mod: null });',
    to: "  tx.put({ ...a, th: id, mod: null });",
  },
  {
    name: "M1a-9a a comment shell is edited",
    file: "../mutators/src/comments.ts",
    from: "      if (c.del) throw deleted();\n",
    to: "",
  },
  {
    name: "M1a-9b a reply shell is edited",
    file: "../mutators/src/replies.ts",
    from: "      if (r.del) throw deleted();\n",
    to: "",
  },
  // ---- M1b review 17 ----
  {
    name: "M1b-27 the server counts no queued runs",
    file: "../sync/src/server/server.ts",
    from: "          ).length,\n      };",
    to: "          ).length * 0,\n      };",
  },
  // ---- replies and comments to any depth ----
  {
    name: "M1b-28 a removal keeps the replies below its children",
    file: "../mutators/src/rules.ts",
    from: '      for (const x of itemsUnder(tx.list("reply", { th: r.th }), r.id)) drop(`reply:${x.id}`);',
    to: '      for (const x of tx.list("reply", { th: r.th }).filter((y) => y.parent === r.id))\n        drop(`reply:${x.id}`);',
  },
  {
    name: "M1b-29 a delete ignores another's reply below its children",
    file: "../mutators/src/replies.ts",
    from: '      const under = itemsUnder(tx.list("reply", { th: r.th }), r.id);',
    to: '      const under = tx.list("reply", { th: r.th }).filter((x) => x.parent === r.id);',
  },
  // ---- M2: the sync server and client (Z: the M2 build's own runs; M2-: the M2 review's fixes) ----
  {
    name: "Z4 a re-attach counts against the daily limit",
    file: "../sync/src/server/server.ts",
    from: "          store.putClient({ ...c, seen: now });\n          return { ok: true, clientId: c.clientId",
    to: "          { const reg = (store as unknown as { registrations: Map<string, number[]> }).registrations; reg.set(u, [...(reg.get(u) ?? []), now]); }\n          store.putClient({ ...c, seen: now });\n          return { ok: true, clientId: c.clientId",
  },
  {
    name: "Z6 a dependent write keeps its prediction after the write before it is refused",
    file: "../sync/src/client/client.ts",
    from: "    this.overlay = new Map();\n    this.predictions.clear();",
    to: "    const old = this.overlay;\n    const was = new Map(this.predictions);\n    this.overlay = new Map();\n    this.predictions.clear();",
    also: [
      {
        from: '      if (state !== "applied") continue;\n',
        to: '      if (state !== "applied") {\n        if (was.get(p.local) === "applied") for (const [k, r] of old) if (!this.overlay.has(k)) this.overlay.set(k, r);\n        continue;\n      }\n',
      },
    ],
  },
  {
    name: "Z7 a refused write's prediction is not rolled back",
    file: "../sync/src/client/client.ts",
    from: '        this.pendingChanged();\n        this.emit({\n          type: "refused",',
    to: '        this.emit({\n          type: "refused",',
  },
  {
    name: "Z8 a duplicated tab keeps the stored client id",
    file: "../sync/src/client/clientIds.ts",
    from: "    const release = await tryLock(o.locks, stored.clientId);",
    to: "    const release = (await tryLock(o.locks, stored.clientId)) ?? (() => {});",
  },
  {
    name: "Z9 the window is not capped",
    file: "../sync/src/server/window.ts",
    from: "Math.min(settings.cap, Math.max(recent, settings.threads))",
    to: "Math.max(recent, settings.threads)",
  },
  {
    name: "Z10 the window ignores the newest-N rule",
    file: "../sync/src/server/window.ts",
    from: "Math.min(settings.cap, Math.max(recent, settings.threads))",
    to: "Math.min(settings.cap, recent)",
  },
  {
    name: "Z11 summaries reach back 400 days",
    file: "../sync/src/server/window.ts",
    from: "export const SUMMARY_WINDOW = 730 * DAY;",
    to: "export const SUMMARY_WINDOW = 400 * DAY;",
  },
  {
    name: "Z12 own and saved threads are full for 61 days",
    file: "../sync/src/server/window.ts",
    from: "export const OWN_WINDOW = 90 * DAY;",
    to: "export const OWN_WINDOW = 61 * DAY;",
  },
  {
    name: "Z13 a window snapshot does not send the opened threads",
    file: "../sync/src/client/client.ts",
    from: '      ...(tier === "window" && this.opened.size ? { threads: [...this.opened] } : {}),\n',
    to: "",
  },
  {
    name: "Z15 a re-attach does not count as use of the id",
    file: "../sync/src/server/server.ts",
    from: "          store.putClient({ ...c, seen: now });\n          return { ok: true, clientId: c.clientId",
    to: "          return { ok: true, clientId: c.clientId",
  },
  {
    name: "Z16 PRECONDITION_FAILED is not recorded",
    file: "../sync/src/wire.ts",
    from: '  "TOO_LARGE",\n]);',
    to: '  "TOO_LARGE",\n  "PRECONDITION_FAILED",\n]);',
  },
  {
    name: "Z17 the client ignores a re-attached id's lastSeq",
    file: "../sync/src/client/client.ts",
    from: "restore?.acked ?? options.lastSeq ?? 0",
    to: "restore?.acked ?? 0",
  },
  {
    name: "Z18 the previous cursor key is accepted for ever",
    file: "../sync/src/server/tokens.ts",
    from: "if (this.previous && now < this.previous.rotatedAt + PREVIOUS_KEY_TTL)",
    to: "if (this.previous)",
  },
  {
    name: "Z19 the in-flight policy keeps a failed write queued",
    file: "../sync/src/client/client.ts",
    from: 'if (this.policy === "in-flight" && UNRECORDED.has(code)) {',
    to: "if ((false as boolean) && UNRECORDED.has(code)) {",
  },
  {
    name: "Z20 Discard does not roll back",
    file: "../sync/src/client/client.ts",
    from: '    if (p) this.emit({ type: "discarded", local: p.local, name: p.name, input: p.input });\n    this.pendingChanged();',
    to: '    if (p) this.emit({ type: "discarded", local: p.local, name: p.name, input: p.input });',
  },
  {
    name: "Z25 a thread that arrives by a pull is held as a summary",
    file: "../sync/src/client/replica.ts",
    from: '        if (r.kind === "thread" && !s.records.has(c.key)) s.full.add(r.id);\n',
    to: "",
  },
  {
    name: "Z28 a prediction reads the content index of a summary thread",
    file: "../sync/src/client/predict.ts",
    from: "      if (log && CONTENT_KINDS.has(kind) && !this.replica.isFull(log, index.th))",
    to: "      if (log && CONTENT_KINDS.has(kind) && !this.replica.isFull(log, index.th) && (false as boolean))",
  },
  {
    name: "M2-1 the window counts deleted and removed threads",
    file: "../sync/src/server/window.ts",
    from: 'const live = threads.filter((t) => !t.gone && t.mod !== "removed");',
    to: "const live = threads;",
  },
  // package only: the client's merge of a promotion with what it holds; no
  // server answer changes it, so the acceptance targets cannot differ on it
  // (@session/sync's suite kills it)
  {
    name: "M2-2 a promotion's snapshot overwrites a newer record",
    file: "../sync/src/client/replica.ts",
    from: "      if (held && held.rev > record.rev) continue;\n",
    to: "",
    packageOnly: true,
  },
  // package only: the client's merge of a pull with what it holds; no server
  // answer changes it, so the acceptance targets cannot differ on it
  // (@session/sync's suite kills it)
  {
    name: "M2-3 a pull overwrites a newer record a promotion brought",
    file: "../sync/src/client/replica.ts",
    from: "      if (held && held.rev > r.rev) continue;\n",
    to: "",
    packageOnly: true,
  },
  // package only: the order in which the client sends its own reads; no server
  // answer changes it, so the acceptance targets cannot differ on it
  // (@session/sync's suite kills it)
  {
    name: "M2-4 reads of one log are not serialized",
    file: "../sync/src/client/client.ts",
    from: "    return this.serial(log, () =>\n      this.dropsOf(log) === drops ? this.syncNow",
    to: "    return ((f: () => Promise<SyncOutcome>) => f())(() =>\n      this.dropsOf(log) === drops ? this.syncNow",
    packageOnly: true,
  },
  {
    name: "M2-5 an applied write's records are not overlaid until a read confirms them",
    file: "../sync/src/client/client.ts",
    from: "      for (const [k, r] of a.staged) if (!this.covered(a, k, r)) this.overlay.set(k, r);\n",
    to: "",
  },
  // package only: when the client stops laying an applied write over its
  // replica; no server answer changes it, so the acceptance targets cannot
  // differ on it (@session/sync's suite kills it)
  {
    name: "M2-6 an applied write's records stay overlaid after a read confirms them",
    file: "../sync/src/client/client.ts",
    from: "return logs.length === 0 || logs.some((log) => (this.replica.state(log)?.seq ?? -1) >= a.seq);",
    to: "return logs.length === 0;",
    packageOnly: true,
  },
  {
    name: "M2-7 drop takes out the write in flight",
    file: "../sync/src/client/client.ts",
    from: "if (!p || p === this.inFlight) return false;",
    to: "if (!p) return false;",
  },
  {
    name: "M2-8 no answer marks the clock known",
    file: "../sync/src/client/client.ts",
    from: "      if (answered) {\n        // an answer",
    to: "      if ((true as boolean) || answered) {\n        // an answer",
  },
  {
    name: "M2-9 a replay moves the acked seq",
    file: "../sync/src/client/client.ts",
    from: "if (!res.replay) this.acked = e.seq;",
    to: "this.acked = e.seq;",
  },
  // package only: claimClientId's lock handling in the tab; no server answer
  // changes it, so the acceptance targets cannot differ on it (@session/sync's
  // suite kills it)
  {
    name: "M2-10 a re-attach that throws keeps the lock",
    file: "../sync/src/client/clientIds.ts",
    from: "      } catch (e) {\n        release();\n        throw e;",
    to: "      } catch (e) {\n        throw e;",
    packageOnly: true,
  },
  {
    name: "M2-11 a prediction reads a window snapshot's threads as all of them",
    file: "../sync/src/client/predict.ts",
    from: "|| this.replica.fullLog(log);",
    to: "|| true;",
  },
  {
    name: "M2-12 open() answers full for a thread the replica does not hold",
    file: "../sync/src/client/client.ts",
    // since the M4 fixes a thread the replica does not hold is asked of the
    // held space logs (`openMany`): the fault is the same, a thread no log
    // served answers full
    from: "const found = served.has(th) || this.replica.logOfThread(th) !== undefined;",
    to: "const found = served.has(th) || true;",
  },
  // package only: the client's bookkeeping of applied writes across ids; no
  // server answer changes it, so the acceptance targets cannot differ on it
  // (@session/sync's suite kills it)
  {
    name: "M2-13 a new client id keeps the applied writes of the old one",
    file: "../sync/src/client/client.ts",
    from: "      this.appliedWrites = [];\n      this.replica.resetSeqs();",
    to: "      this.replica.resetSeqs();",
    packageOnly: true,
  },
  {
    name: "M2-14 a snapshot of an unknown tier is served",
    file: "../sync/src/server/server.ts",
    from: "    if (!TIERS.has(tier))\n",
    to: "    if ((false as boolean) && !TIERS.has(tier))\n",
  },
  {
    name: "M2-15 a nested transaction's throw takes back the outer writes too",
    file: "../sync/src/server/memory.ts",
    from: "for (const f of undo.splice(mark).reverse()) f();",
    to: "for (const f of undo.splice(0).reverse()) f();",
  },
  {
    name: "M2-16 hiding a node leaves the answer of the thread opened from it",
    file: "../mutators/src/moderation.ts",
    from: '          if (copy?.kind === "answer" && !keep) tx.put({ ...copy, mod });',
    to: "          void keep;",
  },
  {
    name: "M2-17 another person's client id re-attaches",
    file: "../sync/src/server/server.ts",
    from: '          if (!c || c.u !== u || c.seen <= now - this.clientIdleTtl)\n            return { ok: false, error: refuse("WRONG_CLIENT").toError() };\n          store.putClient',
    to: '          if (!c || c.seen <= now - this.clientIdleTtl)\n            return { ok: false, error: refuse("WRONG_CLIENT").toError() };\n          store.putClient',
  },
  // package only: the client's listener loop; no server answer changes it, so
  // the acceptance targets cannot differ on it (@session/sync's suite kills it)
  {
    name: "M2-18 a listener that throws stops the others",
    file: "../sync/src/client/client.ts",
    from: "      try {\n        f(changed, { structural });\n      } catch (x) {\n        report(x);\n      }",
    to: "      f(changed, { structural });",
    packageOnly: true,
  },
  // package only: send()'s bookkeeping in the client; no server answer changes
  // it, so the acceptance targets cannot differ on it (@session/sync's suite
  // kills it)
  {
    name: "M2-19 a write send() waits for becomes Not sent",
    file: "../sync/src/client/client.ts",
    from: "    if (!this.sending.has(p)) {\n      this.unsentWrites.push(p);",
    to: "    if ((true as boolean) || !this.sending.has(p)) {\n      this.unsentWrites.push(p);",
    packageOnly: true,
  },
  // package only: LiveQuery's equality check; no server answer changes it, so
  // the acceptance targets cannot differ on it (@session/sync's suite kills it)
  {
    name: "M2-20 a query tells its listeners of an equal value",
    file: "../sync/src/client/query.ts",
    from: "if (this.runs > 1 && shallowEqual(next, this.value)) return false;",
    to: "if ((false as boolean) && shallowEqual(next, this.value)) return false;",
    packageOnly: true,
  },
  // package only: the time the client stamps on its own prediction; no server
  // answer changes it, so the acceptance targets cannot differ on it
  // (@session/sync's suite kills it)
  {
    name: "M2-21 a prediction stamps its writes with the send time",
    file: "../sync/src/client/client.ts",
    from: 'new StagedTx(source, me, msToIso(p.queuedAt), p.mutationId, "client")',
    to: 'new StagedTx(source, me, msToIso(this.now()), p.mutationId, "client")',
    packageOnly: true,
  },
  // ---- M6: the pre-stage limits and the open-link cap of `04` Z1 ----
  // package only: the prototype's server applies no limits (its `PreCtx`
  // has no `allow`), so the acceptance suite cannot reach them;
  // @session/mutators' `limits.test.ts` and @session/sync's
  // `preLimits.test.ts` kill them
  {
    name: "M6-1 a used-up pre-stage limit does not refuse",
    file: "../mutators/src/rules.ts",
    from: '  if (left !== true) throw refuse("TOO_MANY_REQUESTS", left);',
    to: "  void left;",
    packageOnly: true,
  },
  {
    name: "M6-2 spaces.create uses no limit",
    file: "../mutators/src/spaces.ts",
    from: '    pre: (ctx) => (within(ctx, "spaces.create"), {}),',
    to: "    pre: () => ({}),",
    packageOnly: true,
  },
  {
    name: "M6-3 spaces.join uses no limit",
    file: "../mutators/src/spaces.ts",
    from: '    pre: (ctx) => (within(ctx, "spaces.join"), {}),',
    to: "    pre: () => ({}),",
    packageOnly: true,
  },
  {
    name: "M6-4 invites.create uses no limit",
    file: "../mutators/src/invites.ts",
    from: '      within(ctx, "invites.create");\n',
    to: "      void within;\n",
    packageOnly: true,
  },
  {
    name: "M6-5 a channel's 51st open link is allowed",
    file: "../mutators/src/invites.ts",
    from: "  if (open >= OPEN_LINKS_MAX)",
    to: "  if (open > OPEN_LINKS_MAX)",
    packageOnly: true,
  },
  {
    name: "M6-6 an expired link counts as open",
    file: "../mutators/src/invites.ts",
    from: "const isOpen = (tx: Tx, l: InviteRec) => l.dead === null && isoToMs(l.expiresAt) > isoToMs(tx.now);",
    to: "const isOpen = (tx: Tx, l: InviteRec) => l.dead === null && isoToMs(l.expiresAt) >= 0;",
    packageOnly: true,
  },
  {
    name: "M6-7 the server does not count its pre-stage limits",
    file: "../sync/src/server/server.ts",
    from: "          if (left === true) uses.push(limit);\n          return left;",
    to: "          if (left === true) uses.push(limit);\n          return true;",
    packageOnly: true,
  },
  // ---- M6 review, the client (`@session/client`) ----
  // package only: the screens of the web client, which the acceptance suite
  // does not import; each runs the client test files named in `files`.
  // M6-C1 to M6-C21 are the review's test-strength rows (J10 to M8), moved
  // with the M6 fixes where these changed the code; M6-C22 on take back each
  // fix of the review's findings (C1 to C19).
  {
    name: "M6-C1 (J10) a member's list shows the Banned section",
    file: "../client/src/features/channels/MembersDialog.tsx",
    from: "{channel.owned && bans !== UNKNOWN ? (",
    to: "{bans !== UNKNOWN ? (",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C2 (J11) Unban names the viewer",
    file: "../client/src/features/channels/MembersDialog.tsx",
    from: 'writes.send("members.unban", { space: channel.id, user: b.u });',
    to: 'writes.send("members.unban", { space: channel.id, user: me ?? b.u });',
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    // since the M6 fixes the ban runs from the confirmation
    name: "M6-C3 (J12) Ban names the viewer",
    file: "../client/src/features/channels/MembersDialog.tsx",
    from: 'asking.action === "ban" ? ban(asking.member.u) :',
    to: 'asking.action === "ban" ? ban(me ?? asking.member.u) :',
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C4 (J15) the channel link carries its code in the search",
    file: "../client/src/features/channels/InviteLinksDialog.tsx",
    from: "  return `${origin}/c/${name}#${code}`;",
    to: "  return `${origin}/c/${name}?invite=${code}`;",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C5 (J16) expired links are listed",
    file: "../client/src/features/channels/InviteLinksDialog.tsx",
    from: 'links.filter((l) => linkState(l, now) !== "expired")',
    to: "links",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C6 (J17) a used link reads as revoked",
    file: "../client/src/features/channels/InviteLinksDialog.tsx",
    from: '  if (link.dead === "Used") return "used";\n',
    to: "",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C7 (J19) a link join sends no code",
    file: "../client/src/features/channels/useChannelInvite.ts",
    from: 'source.mutate("spaces.join", { space: id, invite: invite.code })',
    to: 'source.mutate("spaces.join", { space: id })',
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C8 (J20) a sent link's code stays pending",
    file: "../client/src/features/channels/useChannelInvite.ts",
    from: "    clearPendingInvite();\n    if (joined) return;",
    to: "    if (joined) return;",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    // since the M6 fixes a FORBIDDEN is the link message by its message
    // (C7): the fault is the same, FORBIDDEN is not an unusable link
    name: "M6-C9 (J21) a FORBIDDEN link join is not the link message",
    file: "../client/src/features/channels/useChannelInvite.ts",
    from: '    error.code === "FORBIDDEN" &&\n',
    to: "    (false as boolean) &&\n",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C10 (J22) a link for another channel joins this one",
    file: "../client/src/features/channels/useChannelInvite.ts",
    from: '    if (invite?.kind !== "channel" || id === undefined || invite.channel !== name) return;',
    to: '    if (invite?.kind !== "channel" || id === undefined) return;',
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C11 (J27a) a frozen channel drops Delete on one's reply",
    file: "../client/src/features/replies/ReplyTree.tsx",
    from: "        {mine && active ? (",
    to: "        {mine && writer ? (",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C12 (J27b) a frozen channel drops Delete on one's branch",
    file: "../client/src/features/branches/BranchCard.tsx",
    from: "  if (active && mine) {",
    to: "  if (writer && mine) {",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C13 (J27c) a frozen channel drops Delete on one's thread",
    file: "../client/src/features/feed/ThreadRow.tsx",
    from: "  if (mine && !deleted && others !== null) {",
    to: "  if (writer && mine && !deleted && others !== null) {",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C14 (J28) a frozen channel disables Save",
    file: "../client/src/features/feed/ThreadRow.tsx",
    from: "    : active\n      ? { onClick: () => void writes.save(thread.id, !saved) }",
    to: "    : writer\n      ? { onClick: () => void writes.save(thread.id, !saved) }",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C15 (J30) a frozen open channel offers Join",
    file: "../client/src/features/channels/ChannelHeader.tsx",
    from: "    else if (!channel.frozen)\n",
    to: "    else\n",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C16 (J35a) the owner's own thread offers Remove… and Ban",
    file: "../client/src/features/feed/ThreadRow.tsx",
    from: "  if (writer && !mine && space?.owned && thread.u) {",
    to: "  if (writer && space?.owned && thread.u) {",
    packageOnly: true,
    files: ["test/feed.states.test.tsx"],
  },
  {
    name: "M6-C17 (J35b) a member's menu offers Remove… and Ban",
    file: "../client/src/features/feed/ThreadRow.tsx",
    from: "  if (writer && !mine && space?.owned && thread.u) {",
    to: "  if (writer && !mine && space && thread.u) {",
    packageOnly: true,
    files: ["test/feed.states.test.tsx"],
  },
  {
    name: "M6-C18 (K16) an invite_used row opens Home",
    file: "../client/src/features/notifications/NotificationsPage.tsx",
    from: 'if (target?.kind === "invites") void navigate({ to: "/invites" });',
    to: 'if (target?.kind === "invites") void navigate({ to: "/" });',
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C19 (L1) a citation's link drops rel tokens",
    file: "../client/src/features/feed/AnswerProse.tsx",
    from: '<a ref={link} href={href} target="_blank" rel="noopener noreferrer nofollow ugc">',
    to: '<a ref={link} href={href} target="_blank" rel="noopener">',
    packageOnly: true,
    files: ["test/untrustedText.test.tsx"],
  },
  {
    name: "M6-C20 (L4) an external image's link drops rel tokens",
    file: "../client/src/features/markdown/ResearchMarkdown.tsx",
    from: '      rel="noopener noreferrer nofollow ugc"\n    >\n      {alt ? `Open image: ${alt}`',
    to: '      rel="noopener"\n    >\n      {alt ? `Open image: ${alt}`',
    packageOnly: true,
    files: ["test/markdown.test.tsx"],
  },
  {
    name: "M6-C21 (M8) a reply's text is set as HTML",
    file: "../client/src/features/replies/ReplyText.tsx",
    from: "          <span key={i}>{part.text}</span>",
    to: "          <span key={i} dangerouslySetInnerHTML={{ __html: part.text }} />",
    packageOnly: true,
    files: ["test/untrustedText.test.tsx"],
  },
  {
    name: "M6-C22 (C1) the channel route keeps a link's fragment",
    file: "../client/src/app/router.tsx",
    from: '    if (location.hash === "") return;',
    to: '    if ((true as boolean) || location.hash === "") return;',
    packageOnly: true,
    files: ["test/router.test.tsx"],
  },
  {
    name: "M6-C23 (C1) the sign-in's return address keeps the fragment",
    file: "../client/src/features/auth/AuthDialog.tsx",
    from: "  const href = hash < 0 ? location : location.slice(0, hash);",
    to: "  const href = hash < 0 ? location : location;",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C24 (C2) the sign-in does not keep the channel link's code",
    file: "../client/src/features/auth/AuthDialog.tsx",
    from: "            keepChannelInviteForSignIn();\n",
    to: "",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C25 (C2) a kept channel link's code does not expire",
    file: "../client/src/lib/pendingInvite.ts",
    from: "    now - kept.at >= CHANNEL_INVITE_TTL_MS",
    to: "    (false as boolean)",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C26 (C2) the landing step does not name the channel",
    file: "../client/src/features/channels/useChannelInvite.ts",
    from: '{ step: "landing", channel: name }',
    to: '{ step: "landing" }',
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C27 (C3) a single write reads as others",
    file: "../client/src/features/notifications/notifications.ts",
    from: "      others: n.n > 1,",
    to: "      others: n.n > 0,",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C28 (C4) a missing title is not quoted",
    file: "../client/src/features/notifications/notifications.ts",
    from: "quote: titleOf(row), reason: false });",
    to: "quote: row.title ?? null, reason: false });",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C29 (C5) an unloaded comment does not fetch its thread",
    file: "../client/src/features/notifications/notifications.ts",
    from: "(source.get(threadKey(n.th)) === UNKNOWN || commentOf(source, n) === UNKNOWN)",
    to: "source.get(threadKey(n.th)) === UNKNOWN",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C30 (C6) a non-member's private member count is a button",
    file: "../client/src/features/channels/ChannelInfoDialog.tsx",
    from: "{channel.private && !channel.joined ? (",
    to: "{(false as boolean) ? (",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C31 (C7) a ban on a link join shows the link message",
    file: "../client/src/features/channels/useChannelInvite.ts",
    from: "(error.message === LINK_UNUSABLE || error.message === frozenMessage(channel))",
    to: "(true as boolean)",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C32 (C8) a refused copy shows nothing",
    file: "../client/src/features/channels/InviteLinksDialog.tsx",
    from: "      () => showToast(COPY_FAILED, { alert: true }),",
    to: "      () => undefined,",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C33 (C9) /notifications lets a waiting account in",
    file: "../client/src/app/router.tsx",
    from: '  path: "/notifications",\n  beforeLoad: requireMember,',
    to: '  path: "/notifications",\n  beforeLoad: requireSignedIn,',
    packageOnly: true,
    files: ["test/router.test.tsx"],
  },
  {
    name: "M6-C34 (C10) every link's buttons share one name",
    file: "../client/src/features/channels/InviteLinksDialog.tsx",
    from: "const which = `link ${i + 1}, expires ${expiryDate(l)}`;",
    to: 'const which = "link";',
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C35 (C11) Undo on a revoked link past its expiry",
    file: "../client/src/features/channels/InviteLinksDialog.tsx",
    from: 'state === "revoked" && isoToMs(l.expiresAt) > now ? (',
    to: 'state === "revoked" ? (',
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    // C14's code went with the server's change (an `invite_used` record
    // holds no code, `04` I1): M6-C36 is the deleted accounts that change
    // brought (`u: null`)
    name: "M6-C36 (u: null) a deleted account's content names nobody",
    file: "../client/src/features/feed/format.ts",
    from: "export const authorName = (u: string | null): string => u ?? DELETED_ACCOUNT;",
    to: 'export const authorName = (u: string | null): string => u ?? "";',
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C37 (C17) the member list bans without asking",
    file: "../client/src/features/channels/MembersDialog.tsx",
    from: '{ label, danger: true, onSelect: () => ask("ban", m) }',
    to: "{ label, danger: true, onSelect: () => void ban(m.u) }",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C38 (C17) a thread's menu bans without asking",
    file: "../client/src/features/feed/ThreadRow.tsx",
    from: "      onSelect: () => setBanning(true),",
    to: '      onSelect: () => ban(thread.u ?? "", space),',
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C39 (C17) the member list removes without asking",
    file: "../client/src/features/channels/MembersDialog.tsx",
    from: '{ label, danger: true, onSelect: () => ask("remove", m) }',
    to: "{ label, danger: true, onSelect: () => void remove(m) }",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    // since the M6 tail the client tells a ban when the person's own ban
    // record arrives (`checkOwnBans`), not from a lost membership
    name: "M6-C40 (C18) an arrived ban record is not told",
    file: "../client/src/replica/syncReplica.ts",
    from: "      this.options.onBanned?.(s.name);",
    to: "      void s;",
    packageOnly: true,
    files: ["test/replica.sync.test.ts"],
  },
  {
    // the lost-membership inference it named went with the M6 tail: M6-C41
    // is the bans the first read of the user log holds
    name: "M6-C41 (C18) a ban made before the page loaded is told",
    file: "../client/src/replica/syncReplica.ts",
    from: "    if (before === null) return;\n    for (const sp of now) if (!before.has(sp))",
    to: "    for (const sp of now) if (!before?.has(sp))",
    packageOnly: true,
    files: ["test/replica.sync.test.ts"],
  },
  {
    name: "M6-C42 (C19) the viewer's comment has no Delete",
    file: "../client/src/features/branches/BranchCard.tsx",
    from: "                        onSelect: () => setDeleting(c.id),",
    to: "                        onSelect: () => undefined,",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C43 (C19) a frozen channel drops Delete on one's comment",
    file: "../client/src/features/branches/BranchCard.tsx",
    from: "              {mine && active ? (",
    to: "              {mine && writer ? (",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C44 (C2) a channel link opens the code step over the profile step",
    file: "../client/src/features/channels/useChannelInvite.ts",
    from: "    if (holdsInvite) return;\n",
    to: "",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C45 (item 14) an address without its channel asks every held log",
    file: "../client/src/replica/syncReplica.ts",
    from: "    if (space === undefined && lookUp) {",
    to: "    if ((false as boolean) && space === undefined && lookUp) {",
    packageOnly: true,
    files: ["test/replica.sync.test.ts"],
  },
  {
    name: "M6-C46 (u: null) a deleted actor's notification names @someone",
    file: "../client/src/features/notifications/notifications.ts",
    from: "  const actor = row.actor === null ? DELETED_ACCOUNT : `@${row.actor}`;",
    to: '  const actor = row.actor === null ? "@someone" : `@${row.actor}`;',
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C47 (Z1 messages) a write a limit left unsent hides the server's message",
    file: "../client/src/features/shell/NotSent.tsx",
    from: "  return error?.message ? error.message : null;",
    to: "  return (false as boolean) && error?.message ? error.message : null;",
    packageOnly: true,
    files: ["test/outbox.screens.test.tsx"],
  },
  // ---- M5b review, the client (`@session/client`) ----
  // package only: each takes back one fix of the review's findings (C1 to
  // C10, CD3, CD6), named by its row, and runs the client test files that
  // hold that fix's tests.
  {
    name: "M5b-C1a (C1) a reading whose week has reset still refuses",
    file: "../client/src/replica/online.ts",
    from: "  const usage = currentReading(online.usage, now);",
    // a clock before every reset: no reading has reset
    to: "  const usage = currentReading(online.usage, now - Number.POSITIVE_INFINITY);",
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-C1b (C1) a refused write does not fetch usage.get again",
    file: "../client/src/replica/ReplicaProvider.tsx",
    from: "      if (member) void client?.invalidateQueries({ queryKey: queryKeys.weeklyUsage() });\n",
    to: "",
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-C1c (C1) no refetch at the reading's reset",
    file: "../client/src/replica/ReplicaProvider.tsx",
    from: "      Math.max(0, resetAt - source.now() + RESET_REFETCH_DELAY_MS),",
    to: "      MAX_TIMER_MS,",
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-C1d (C1) the refetch comes before the reset",
    file: "../client/src/replica/ReplicaProvider.tsx",
    from: "      Math.max(0, resetAt - source.now() + RESET_REFETCH_DELAY_MS),",
    to: "      Math.max(0, resetAt - source.now() - 2_000),",
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-C2a (C2) another reader reads the asker's tokens copy",
    file: "../client/src/features/branches/runFailureText.ts",
    from: "      if (!view.asker) return TOKENS_OTHER_TEXT;\n",
    to: "",
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-C2b (C2) another reader reads the asker's key copy",
    file: "../client/src/features/branches/runFailureText.ts",
    from: "      return view.asker ? keyFailureText(run) : KEY_OTHER_TEXT;",
    to: "      return keyFailureText(run);",
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-C2c (C2) another reader reads the asker's access copy",
    file: "../client/src/features/branches/runFailureText.ts",
    from: "      return view.asker ? runFailureText(fail) : ACCESS_OTHER_TEXT;",
    to: "      return runFailureText(fail);",
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-C2d (C2) every reader of a card counts as its asker",
    file: "../client/src/features/branches/RunStatus.tsx",
    from: "  const asker = run !== undefined && me !== null && run.u === me;",
    to: "  const asker = run !== undefined && me !== undefined;",
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-C3 (C3) a run failed tokens before the reset still reads out of tokens",
    file: "../client/src/features/branches/runFailureText.ts",
    from: "      return view.outOfTokens ? outOfTokensText(view.resetAt, view.timeZone) : TOKENS_PAST_TEXT;",
    to: "      return outOfTokensText(view.resetAt, view.timeZone);",
    packageOnly: true,
    files: ["test/billing.review.test.tsx", "test/runs.screens.test.tsx"],
  },
  {
    name: "M5b-C4a (C4) the reset's weekday is read in UTC",
    file: "../client/src/features/usage/usageText.ts",
    from: '    weekday: short ? "short" : "long",\n    ...(timeZone === undefined ? {} : { timeZone }),',
    to: '    weekday: short ? "short" : "long",\n    timeZone: timeZone ?? "UTC",',
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-C4b (C4) a run's date is read in UTC",
    file: "../client/src/features/usage/usageText.ts",
    from: '    day: "numeric",\n    ...(timeZone === undefined ? {} : { timeZone }),',
    to: '    day: "numeric",\n    timeZone: timeZone ?? "UTC",',
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-C4c (C4) the composer's toast names the UTC weekday",
    file: "../client/src/replica/ReplicaProvider.tsx",
    from: "      return outOfTokensText(data.usage?.resetsAt ?? null);",
    to: '      return outOfTokensText(data.usage?.resetsAt ?? null, "UTC");',
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    // the fault as it was: the invalidating effect in every reader of the
    // online data
    name: "M5b-C5 (C5) every reader of the online data refetches usage.get",
    file: "../client/src/replica/ReplicaProvider.tsx",
    from: "  const usage = useWeeklyUsage(member);\n  const usageData = usage.data;",
    to: "  const usage = useWeeklyUsage(member);\n  const ended = useReplicaQuery(endedRunsOf, []);\n  const client = useQueryClient();\n  const seen = useRef<number | null>(null);\n  useEffect(() => {\n    if (ended === UNKNOWN) return;\n    if (seen.current !== null && seen.current !== ended)\n      void client.invalidateQueries({ queryKey: queryKeys.weeklyUsage() });\n    seen.current = ended;\n  }, [ended, client]);\n  const usageData = usage.data;",
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-C6 (C6) failed recent runs read as no runs",
    file: "../client/src/features/usage/UsagePage.tsx",
    from: "      ) : runs.isError && !runs.data ? (",
    to: "      ) : (false as boolean) && runs.isError && !runs.data ? (",
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-C7a (C7) the key's mutation is kept for the default time",
    file: "../client/src/api/account.ts",
    from: "    mutationFn: setApiKey,\n    gcTime: 0,",
    to: "    mutationFn: setApiKey,",
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-C7b (C7) the key's mutation is not reset once answered",
    file: "../client/src/features/usage/UsagePage.tsx",
    from: "        onSettled: () => setKey.reset(),\n",
    to: "",
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-C8a (C8) 999,600 tokens read 1000k",
    file: "../client/src/features/shell/usage.ts",
    from: '    return thousands >= 1000 ? "1M" : `${thousands}k`;',
    to: "    return `${thousands}k`;",
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-C8b (C8) one token used reads the whole allowance left",
    file: "../client/src/features/shell/usage.ts",
    from: "formatTokens(left, true)",
    to: "formatTokens(left)",
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-C8c (C8) the ring reads a full allowance while the reading is unknown",
    file: "../client/src/features/shell/shellData.ts",
    from: "    usage: currentReading(online.usage, source.now()),",
    to: "    usage: currentReading(online.usage, source.now()) ?? {\n      used: 0,\n      allowance: 2_000_000,\n      resetsAt: null,\n    },",
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-C8d (C8) offline the label does not name the reading's time",
    file: "../client/src/features/shell/usage.ts",
    from: "  if (options.offline && reading.readAt !== undefined)",
    to: "  if ((false as boolean) && options.offline && reading.readAt !== undefined)",
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-C8e (C8) the app bar never says the ring is offline",
    file: "../client/src/features/shell/shellData.ts",
    from: "    usageOffline: !connected,",
    to: "    usageOffline: !connected && false,",
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-C9 (C9) a failed request shows the browser's text",
    file: "../client/src/lib/toast.ts",
    from: "  return trpcErrorCode(error) !== null && error instanceof Error && error.message",
    to: "  return error instanceof Error && error.message",
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-CD3a (CD3) the key note does not say the asks go to the provider directly",
    file: "../client/src/features/usage/UsagePage.tsx",
    from: '<p className="knote">Asks on this key go to {info.name} directly.</p>',
    to: '<p className="knote">Asks on this key go to {info.name}.</p>',
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-CD3b (CD3) the key note only beside a stored key",
    file: "../client/src/features/usage/UsagePage.tsx",
    from: "        {body}\n        {note}",
    to: "        {body}\n        {stored && checking === null ? note : null}",
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-CD6 (CD6) every key failure reads one sentence",
    file: "../client/src/features/branches/runFailureText.ts",
    from: "  switch (run.fail?.detail) {",
    to: '  switch (undefined as NonNullable<RunRec["fail"]>["detail"]) {',
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  // ---- the M6 tail: C12, C18 and the invite tree's deleted accounts ----
  {
    name: "M6-C48 (C12) a removal that changed nothing reads as Removed",
    file: "../client/src/features/channels/MembersDialog.tsx",
    from: "  return removed === false\n",
    to: "  return (false as boolean) && removed === false\n",
    packageOnly: true,
    files: ["test/membership.screens.test.tsx"],
  },
  {
    name: "M6-C49 (C18) a ban in a private channel is told as a lost membership",
    file: "../client/src/replica/syncReplica.ts",
    from: "    if (this.ownBans?.has(space)) {\n      if (this.bansUntold.delete(space))",
    to: "    if ((false as boolean) && this.ownBans?.has(space)) {\n      if (this.bansUntold.delete(space))",
    packageOnly: true,
    files: ["test/replica.sync.test.ts"],
  },
  {
    name: "M6-C50 (item 3) the invite tree draws a deleted account as ?",
    file: "../client/src/features/auth/InvitesPage.tsx",
    from: '          <Avatar handle={node.handle} size="sm" />',
    to: '          <Avatar handle={node.handle ?? "?"} size="sm" />',
    packageOnly: true,
    files: ["test/auth.test.tsx"],
  },
  {
    name: "M6-C51 (item 3) You invited names a deleted account by nothing",
    file: "../client/src/features/auth/InvitesPage.tsx",
    from: "                <b>{authorName(person.handle)}</b>",
    to: "                <b>{person.handle}</b>",
    packageOnly: true,
    files: ["test/auth.test.tsx"],
  },
  // ---- M5b test-strength review, the client ----
  // package only: the review's client rows (C4, C7, C8a, C13, C15b, C15d),
  // re-derived against the code after the M5b fixes.
  {
    name: "M5b-CT1 (C4) the ring's circumference is half a circle",
    file: "../client/src/features/shell/UsageRing.tsx",
    from: "const CIRCUMFERENCE = 2 * Math.PI * RADIUS;",
    to: "const CIRCUMFERENCE = Math.PI * RADIUS;",
    packageOnly: true,
    files: ["test/shell.test.tsx"],
  },
  {
    name: "M5b-CT2 (C7) the Usage bar fills with what was used",
    file: "../client/src/features/usage/UsagePage.tsx",
    from: "Math.max(0, 1 - reading.used / reading.allowance)",
    to: "Math.max(0, reading.used / reading.allowance)",
    packageOnly: true,
    files: ["test/usage.screens.test.tsx"],
  },
  {
    // the weekday hard-coded to UTC is M5b-C4a
    name: "M5b-CT3 (C8a) the reset's weekday ignores a given zone",
    file: "../client/src/features/usage/usageText.ts",
    from: '    weekday: short ? "short" : "long",\n    ...(timeZone === undefined ? {} : { timeZone }),',
    to: '    weekday: short ? "short" : "long",\n    ...((true as boolean) || timeZone === undefined ? {} : { timeZone }),',
    packageOnly: true,
    files: ["test/billing.review.test.tsx", "test/usage.screens.test.tsx"],
  },
  {
    name: "M5b-CT4 (C8a) a run's date ignores a given zone",
    file: "../client/src/features/usage/usageText.ts",
    from: '    day: "numeric",\n    ...(timeZone === undefined ? {} : { timeZone }),',
    to: '    day: "numeric",\n    ...((true as boolean) || timeZone === undefined ? {} : { timeZone }),',
    packageOnly: true,
    files: ["test/billing.review.test.tsx"],
  },
  {
    name: "M5b-CT5 (C13) an invalid key counts as a payer",
    file: "../client/src/replica/online.ts",
    from: '            .filter((key) => key.status === "valid")\n',
    to: "",
    packageOnly: true,
    files: ["test/payer.screens.test.tsx"],
  },
  {
    name: "M5b-CT6 (C15b) runs below 1 % read <1%",
    file: "../client/src/features/usage/usageText.ts",
    from: 'return run.share < 0.005 ? "<1%"',
    to: 'return run.share < 0.01 ? "<1%"',
    packageOnly: true,
    files: ["test/usage.screens.test.tsx"],
  },
  {
    name: "M5b-CT7 (C15d) a run of exactly 0.5 % reads <1%",
    file: "../client/src/features/usage/usageText.ts",
    from: 'return run.share < 0.005 ? "<1%"',
    to: 'return run.share <= 0.005 ? "<1%"',
    packageOnly: true,
    files: ["test/usage.screens.test.tsx"],
  },
];

/** What one suite said about a mutation. */
interface SuiteResult {
  passed: number;
  failed: number;
  tests: string[];
}

interface Outcome {
  typecheck: string;
  /** The acceptance suite (this package's). */
  suite: SuiteResult;
  /** The suite of the package the mutation is in, when it is not this one. */
  own?: SuiteResult;
}

const PKG = process.cwd();
const WEB = resolve(PKG, "../..");
/** The workspace packages a slot holds a copy of, besides this one: a
 * mutation in one of them is type-checked there and runs its suite too. */
const COPIED = ["mutators", "sync", "client"] as const;

/** The packages this package's suite imports: a mutation in any other
 * (the client) runs that package's suite only. */
const REACHED: ReadonlySet<string> = new Set(["mutators", "sync"]);

/** A copy of the package beside links to the workspace's modules, base
 * config and shared package, so it type-checks and runs as the package does.
 * The copies of `@session/mutators` and `@session/sync` are linked into the
 * copies that import them, so a mutation in either reaches this suite. */
function makeSlot(root: string, n: number): string {
  const web = join(root, `slot${n}`, "web");
  mkdirSync(join(web, "packages"), { recursive: true });
  symlinkSync(join(WEB, "node_modules"), join(web, "node_modules"));
  symlinkSync(join(WEB, "tsconfig.base.json"), join(web, "tsconfig.base.json"));
  symlinkSync(join(WEB, "packages", "shared"), join(web, "packages", "shared"));
  // the package's own copies of `@session/mutators`, `@session/sync` and
  // `@session/client`, with their declarations (the client without its build)
  for (const name of COPIED)
    cpSync(join(WEB, "packages", name), join(web, "packages", name), {
      recursive: true,
      filter: (src) =>
        !/[/\\]node_modules$/.test(src) && !(name === "client" && /[/\\]dist$/.test(src)),
    });
  const link = (from: string, name: string) => {
    mkdirSync(join(web, "packages", from, "node_modules", "@session"), { recursive: true });
    symlinkSync(
      join(web, "packages", name),
      join(web, "packages", from, "node_modules", "@session", name),
    );
  };
  link("sync", "mutators");
  // the client imports the copies; its own modules (versions its workspace
  // pins apart) are the workspace's, and its type check names the server's
  // and the database's projects
  link("client", "mutators");
  link("client", "sync");
  const own = join(WEB, "packages", "client", "node_modules");
  for (const entry of readdirSync(own))
    if (entry !== "@session")
      symlinkSync(join(own, entry), join(web, "packages", "client", "node_modules", entry));
  for (const name of ["server", "db"])
    symlinkSync(join(WEB, "packages", name), join(web, "packages", name));
  // the client's fixture replica reads the mockups' fixtures file
  symlinkSync(join(WEB, "..", "docs"), join(root, `slot${n}`, "docs"));
  const dir = join(web, "packages", "replica-proto");
  cpSync(PKG, dir, {
    recursive: true,
    filter: (src) => !/[/\\](node_modules|dist)$/.test(src),
  });
  link("replica-proto", "mutators");
  link("replica-proto", "sync");
  return dir;
}

function sh(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    let out = "";
    const p = spawn(cmd, args, { cwd, env: { ...process.env, FORCE_COLOR: "0" } });
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (out += d.toString()));
    p.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

/** The package a mutation's file is in: this one, or a copied one. */
const packageOf = (m: Mutation) => COPIED.find((name) => m.file.startsWith(`../${name}/`)) ?? null;

function results(out: string): SuiteResult {
  const tests = [
    ...new Set([...out.matchAll(/[✘×] \[fail\]: (.+?)(?:\s{2,}|$)/gm)].map((x) => x[1] ?? "")),
  ];
  return {
    passed: [...out.matchAll(/(\d+) tests? passed/g)].reduce((n, x) => n + Number(x[1]), 0),
    // a test file that throws before its tests run counts as a failure, so
    // a baseline whose file cannot load stops the run
    failed: [...out.matchAll(/(\d+) (?:tests? failed|uncaught exceptions?)/g)].reduce(
      (n, x) => n + Number(x[1]),
      0,
    ),
    tests: tests.map((x) => x.slice(0, 140)),
  };
}

async function run(m: Mutation, dir: string): Promise<Outcome> {
  const file = join(dir, m.file);
  const original = readFileSync(join(PKG, m.file), "utf8");
  let source = original;
  for (const e of edits(m)) {
    if (!source.includes(e.from)) throw new Error(`${m.name}: pattern not found in ${m.file}`);
    source = source.replace(e.from, e.to);
  }
  writeFileSync(file, source);
  try {
    // a mutation in a copied package is type-checked in that package, and
    // its suite runs as well as this one's
    const name = packageOf(m);
    const pkg = name === null ? dir : join(dir, "..", name);
    const tc = await sh("npx", ["tsc", "-p", "tsconfig.test.json", "--noEmit"], pkg);
    const own =
      name === null
        ? null
        : results((await sh("npx", ["ava", "--timeout=600s", ...(m.files ?? [])], pkg)).out);
    // a package this suite does not import: its own suite decides
    const suite =
      name === null || REACHED.has(name)
        ? results((await sh("npx", ["ava", "--timeout=600s"], dir)).out)
        : { passed: 0, failed: 0, tests: [] };
    return {
      typecheck: tc.code === 0 ? "ok" : (tc.out.split("\n")[0] ?? "failed"),
      suite,
      ...(own ? { own } : {}),
    };
  } finally {
    writeFileSync(file, original);
  }
}

/** The suites of an unmutated slot: this package's and each copied one's.
 * Returns what failed. */
async function baseline(dir: string): Promise<string[]> {
  const out: string[] = [];
  const tc = await sh("npx", ["tsc", "-p", "tsconfig.test.json", "--noEmit"], dir);
  if (tc.code !== 0) out.push(`type check: ${tc.out.split("\n")[0] ?? ""}`);
  const suites = [
    ["replica-proto", dir],
    ...COPIED.map((name) => [name, join(dir, "..", name)] as const),
  ] as const;
  for (const [name, at] of suites) {
    const r = results((await sh("npx", ["ava", "--timeout=600s"], at)).out);
    if (r.failed > 0 || r.passed === 0)
      out.push(`${name}: ${r.failed} failed, ${r.passed} passed ${JSON.stringify(r.tests)}`);
  }
  return out;
}

/** A mutation is killed when the acceptance suite fails; one marked
 * `packageOnly` (a fault the acceptance suite cannot reach) also when its
 * own package's suite fails. */
const killed = (m: Mutation, o: Outcome) =>
  o.suite.failed > 0 || (m.packageOnly === true && (o.own?.failed ?? 0) > 0);

/** The id of a mutation: the first word of its name (`X1`, `M1b-12`). An
 * argument selects the mutation with that id, or with a `*` at its end the
 * ones whose id starts with what precedes it (`M1b-*`). */
const idOf = (m: Mutation) => m.name.split(" ")[0] ?? "";
const selects = (arg: string, m: Mutation) =>
  arg.endsWith("*") ? idOf(m).startsWith(arg.slice(0, -1)) : idOf(m) === arg;

const args = process.argv.slice(2);
const ids = MUTATIONS.map(idOf);
const dup = ids.find((x, k) => ids.indexOf(x) !== k);
if (dup) throw new Error(`two mutations have the id ${dup}`);
if (args.includes("--check")) {
  for (const m of MUTATIONS)
    for (const e of edits(m)) {
      const n = readFileSync(m.file, "utf8").split(e.from).length - 1;
      if (n !== 1) throw new Error(`${m.name}: ${n} matches in ${m.file}`);
    }
  console.log(`${MUTATIONS.length} patterns found`);
  process.exit(0);
}
const k = args.indexOf("--slots");
const slots = k >= 0 ? Number(args[k + 1]) : 4;
const only = args.filter((a, i) => !a.startsWith("--") && (k < 0 || i !== k + 1));
const todo = MUTATIONS.filter((m) => !only.length || only.some((o) => selects(o, m)));
if (only.length && !todo.length) throw new Error(`no mutation has the ids ${only.join(" ")}`);
const root = mkdtempSync(join(tmpdir(), "replica-proto-mutate-"));
let survived = 0;
/** The mutations whose copy does not type-check (listed, not counted). */
const untyped: string[] = [];
try {
  const dirs = Array.from({ length: Math.min(slots, todo.length) }, (_, n) => makeSlot(root, n));
  const base = await baseline(dirs[0] ?? "");
  if (base.length)
    throw new Error(`the unmutated copy fails, so no mutation runs:\n${base.join("\n")}`);
  console.log("baseline: the unmutated copy passes every suite");
  const queue = [...todo];
  await Promise.all(
    dirs.map(async (dir) => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        const o = await run(m, dir);
        const ran = o.suite.passed + o.suite.failed > 0 ? o.suite : (o.own ?? o.suite);
        const broken = ran.passed + ran.failed === 0;
        const dead = killed(m, o);
        if (!dead) survived++;
        if (o.typecheck !== "ok") untyped.push(idOf(m));
        console.log(
          `${broken ? "BROKEN  " : dead ? "killed  " : "SURVIVED"} ${m.name}${m.packageOnly ? " (package only)" : ""}: ${JSON.stringify(o)}`,
        );
      }
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
if (untyped.length)
  console.log(
    `${untyped.length} mutations do not type-check (killed or not by the suites alone): ${untyped.join(" ")}`,
  );
console.log(survived ? `${survived} mutations survived` : "every mutation was killed");
process.exitCode = survived ? 1 : 0;
