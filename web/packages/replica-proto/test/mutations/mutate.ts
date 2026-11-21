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
    from: "    pre: (ctx) => {\n      const B32",
    to: "    pre: (ctx, i) => {\n      if (i.id) return { code: i.id.toLowerCase() };\n      const B32",
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
    to: "    const c = this.tokens.open(cursor, now) ?? { log, u, n: this.store.epoch(log).n, v: 0, h: 0, at: now };\n",
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
    from: '      queueRun(tx, run, tx.byKey(threadKey(i.id)) as ThreadRec, "r", i.model, i.effort);',
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
    from: '    space: (tx, i) => readable(tx, linkOf(i.id), "invite").sp,\n    run: (tx, i) => {\n      const l = readable(tx, linkOf(i.id), "invite");\n      if (l.dead === "Used") throw refuse("PRECONDITION_FAILED", "This link was already used.");\n      if (l.dead === "Revoked")',
    to: '    space: (tx, i) => readable(tx, linkOf(i.id), "invite").sp,\n    run: (tx, i) => {\n      const l = readable(tx, linkOf(i.id), "invite");\n      if (l.dead === "Used" || l.dead === "Revoked")',
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
const COPIED = ["mutators", "sync"] as const;

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
  // the package's own copies of `@session/mutators` and `@session/sync`, with
  // their declarations
  for (const name of COPIED)
    cpSync(join(WEB, "packages", name), join(web, "packages", name), {
      recursive: true,
      filter: (src) => !/[/\\]node_modules$/.test(src),
    });
  const link = (from: string, name: string) => {
    mkdirSync(join(web, "packages", from, "node_modules", "@session"), { recursive: true });
    symlinkSync(
      join(web, "packages", name),
      join(web, "packages", from, "node_modules", "@session", name),
    );
  };
  link("sync", "mutators");
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
    failed: [...out.matchAll(/(\d+) tests? failed/g)].reduce((n, x) => n + Number(x[1]), 0),
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
      name === null ? null : results((await sh("npx", ["ava", "--timeout=600s"], pkg)).out);
    const suite = results((await sh("npx", ["ava", "--timeout=600s"], dir)).out);
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
        const broken = o.suite.passed + o.suite.failed === 0;
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
