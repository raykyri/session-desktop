// The server's mutation set (`05` M3, decision E4): each mutation changes one
// place in a copy of the server half (`@session/server`, `@session/sync`,
// `@session/db`, and the `@session/mutators` the server runs), then the type
// check and the tests expected to catch it run in that copy (the acceptance
// suite over HTTP, `test/conformance/`, among them). A mutation its expected
// tests do not kill (`SURVIVED`) is a gap. The packages themselves are never
// changed.
//
// Run from the package directory: `npm run mutate [-- <id> ...]`, `-- --check`
// to check only that every pattern matches once, `--slots <n>` copies at once
// (default 2), `--sequences <n>` convergence sequences per run (default 20;
// 200 is the acceptance suite's full set), `--list` to print the set and the
// faults that do not apply, `--no-baseline` to skip the first run of the
// suite on the unchanged copy.
//
// The set is replica-proto's runner's X, N and R faults that apply to
// server-half code (`replica-proto/test/mutations/mutate.ts`), with the same
// patterns where the code is shared (`@session/sync`'s server half and wire,
// `@session/mutators`), and re-expressed where the code is new on the
// server: the in-memory store's faults (X19, N15, N20, N29) against
// `SqliteStore`, and the in-memory target's (N9, R2-22) against the test
// routes the HTTP target reads, and N34 against the configured cursor key.
// M3-1 to M3-16 cover the code M3 adds (the routes, the event stream, the
// store, the ledger, boot); M3-17 on each undo one fix of the M3 and M4
// reviews, so that each fix's test is shown to fail without it. M5a-1 on
// cover the owned runs of M5a (the run store and its fence, the loop's
// limits and endings, the ledger, `/live`, and the mutators' run rules);
// M5b-1 on cover the payer, the allowance and the overdraft of M5b (the
// pre stage's payer, the claim's re-check, the reset, the crossing, the
// key-only model, a member's own allowance).
// M6-8 on undo one fix of the M6 server review each (the deletion job, the
// privacy check, the pre-stage limits, the invite notification), named by
// the review's row, so that each fix's test is shown to fail without it.
// M6-55 on cover the M6 tail: `members.remove`'s result (C12) and the
// banned person's read of their own ban record (C18).
//
// A mutation is killed only when one of its expected tests fails
// (`EXPECTED`): the runner runs those tests alone, with AVA's `--match`, in
// the test files whose source holds their titles, in the server's suite or
// in the package named by `in` (the restore check, the store's own faults,
// the mutators' turn erasure, rev rules and other rules of their own).
// A type error or a failure of any other test does not count. `--check`
// refuses a mutation without expected tests, and a title no test file holds.

import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  readdirSync,
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
  also?: { from: string; to: string }[];
}

const edits = (m: Mutation) => [{ from: m.from, to: m.to }, ...(m.also ?? [])];

/** Faults of replica-proto's runner that do not apply to the server, and why. */
const NOT_APPLICABLE: [string, string][] = [
  ...[
    "X28",
    "X31",
    "N26",
    "N27",
    "N28",
    "R2-6",
    "R2-8",
    "R2-10",
    "R2-11",
    "R2-12",
    "R2-13",
    "R2-14",
    "R2-23",
  ].map((id): [string, string] => [
    id,
    "the client half's outbox and registration (`@session/sync/client`): no server code; killed by replica-proto's runner",
  ]),
  ...["X16", "X22", "N23", "R2-2"].map((id): [string, string] => [
    id,
    "the prototype's join-request mutators (`replica-proto/src/join-requests.ts`): not part of the server build (`01` C10)",
  ]),
  [
    "X25",
    "a tombstone that keeps the whole record: SqliteStore writes a tombstone's key, kind and audience columns only, so the extra fields of the in-memory fault have nowhere to go (an equivalent mutant on SQLite; the erasure scans of the file and WAL, D4, cover the table)",
  ],
  [
    "N1",
    "left out of replica-proto's set as well: with the version sealed in the token it changes nothing a reader gets",
  ],
  ...["U6-*", "M1a-*", "M1b-*"].map((id): [string, string] => [
    id,
    "not X, N or R faults: the contract and mutator checks of M1a and M1b, run by replica-proto's runner",
  ]),
];

const MUTATIONS: Mutation[] = [
  // ---- replica-proto's X, N and R faults in shared code, same patterns ----
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
    // a follow-up's answer is the node's `answer` record now (`01` C3)
    name: "X18 a hidden node's answer keeps its text",
    file: "../mutators/src/access.ts",
    from: 'return { ...r, md: "", pages: [] } satisfies AnswerRec;',
    to: "return r;",
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
    // the job effect is gone: the run record with status `queued` is the
    // run queue (`01` U6), so the same fault is that record not written
    name: "N16 an ask's queued run is not written",
    file: "../mutators/src/threads.ts",
    from: '      queueRun(tx, run, root, "r", i.model, i.effort, pay);',
    to: "      void queueRun;",
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
    // re-expressed: the server always configures its key (`SESSION_CURSOR_KEY`,
    // `config.ts`), so `Tokens` never makes one; the same fault is every
    // server sealing with the one development key whatever is configured
    name: "N34 the token key is a constant",
    file: "src/config.ts",
    from: '  } else current = key("SESSION_CURSOR_KEY", value.SESSION_CURSOR_KEY);',
    to: '  } else key("SESSION_CURSOR_KEY", value.SESSION_CURSOR_KEY);',
  },
  {
    name: "R2-1 a hide or a removal is STALE after the item changed",
    file: "../mutators/src/moderation.ts",
    from: '      if (i.decision === "shown" && r.rev !== i.base?.rev) throw stale();',
    to: "      if (r.rev !== i.base?.rev) throw stale();",
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
    name: "R2-7 the server does not check a mutation id's age",
    file: "../sync/src/server/server.ts",
    from: '    if (!ageOk(m.mutationId, m.clientTime)) return expired("mutationId");\n',
    to: "",
  },
  {
    name: "R2-9 registrations are not limited",
    file: "../sync/src/server/server.ts",
    from: "        if (store.registrationsSince(u, now - DAY + 1) >= this.registrationsPerDay)",
    to: "        if (store.registrationsSince(u, now - DAY + 1) >= this.registrationsPerDay * 1000)",
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
    // the effect model's name rule is written apart from this one now
    // the mock's slug became the channel name rule (`04` B1): the same fault
    // is a name with a leading "-" accepted
    name: "R2-24 a space name keeps a leading '-'",
    file: "../mutators/src/validate.ts",
    from: "export const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,29}$/;",
    to: "export const CHANNEL_NAME_RE = /^[a-z0-9-][a-z0-9-]{1,29}$/;",
  },
  // ---- re-expressed: the in-memory store's faults, in SqliteStore ----
  {
    name: "X19 node tombstones are never pruned",
    file: "../db/src/sync/store.ts",
    from: '      pruneTombstones: c.prepare<[number]>("DELETE FROM tombstones WHERE deleted_at < ?"),',
    to: "      pruneTombstones: c.prepare<[number]>(\n        \"DELETE FROM tombstones WHERE deleted_at < ? AND kind <> 'node'\",\n      ),",
  },
  {
    name: "N15 answers under (client, seq) are never expired",
    file: "../db/src/sync/store.ts",
    from: '      pruneSeqAnswers: c.prepare<[number]>("DELETE FROM sync_seq_answers WHERE at <= ?"),',
    to: '      pruneSeqAnswers: c.prepare<[number]>("DELETE FROM sync_seq_answers WHERE at <= ? - 1e15"),',
  },
  {
    name: "N20 client records are never expired",
    file: "../db/src/sync/store.ts",
    from: '      pruneClients: c.prepare<[number]>("DELETE FROM sync_clients WHERE last_used_at <= ?"),',
    to: '      pruneClients: c.prepare<[number]>("DELETE FROM sync_clients WHERE last_used_at <= ? - 1e15"),',
  },
  {
    name: "N29 a deleted record's id may be used again",
    file: "../db/src/sync/store.ts",
    from: "    this.s.deleteRecord.run(key);\n",
    to: '    this.s.deleteRecord.run(key);\n    if ("id" in prev) this.sqlite.prepare("DELETE FROM registry WHERE name = ?").run(prev.id);\n',
  },
  // ---- re-expressed: the in-memory target's faults, in the test routes ----
  {
    name: "N9 a finished run writes text to a removed item",
    file: "src/sync/testRoutes.ts",
    from: 'if (!r || !("mod" in r) || r.mod === "removed") return c.json({ ok: false });',
    to: 'if (!r || !("mod" in r)) return c.json({ ok: false });',
  },
  {
    name: "R2-22 scanStorage leaves out the client records",
    file: "src/sync/testRoutes.ts",
    from: "      clients: clients.map((x) => ({\n        clientId: x.client_id,\n        u: x.u,\n        last: x.last_seq,\n        seen: x.last_used_at,\n      })),",
    to: "      clients: [],",
  },
  // ---- M3: the code this milestone adds ----
  {
    name: "M3-1 a request without Session-Protocol passes the check",
    file: "src/sync/protocol.ts",
    from: "  if (value === undefined || !/^\\d{1,6}$/.test(value.trim())) return false;",
    to: "  if (value === undefined) return true;\n  if (!/^\\d{1,6}$/.test(value.trim())) return false;",
  },
  {
    name: "M3-2 a batch counts as one write",
    file: "src/sync/routes.ts",
    from: "    while (admitted > 0 && !limiter.has(key, buckets.writes, admitted)) admitted -= 1;",
    to: "    while (admitted > 0 && !limiter.has(key, buckets.writes, 1)) admitted -= 1;",
    also: [
      {
        from: "    limiter.take(key, buckets.writes, admitted);",
        to: "    limiter.take(key, buckets.writes, 1);",
      },
    ],
  },
  {
    name: "M3-3 envelopes after the drain began are applied",
    file: "src/sync/routes.ts",
    from: '      if (sync.draining) {\n        answers.push(unrecorded("SERVICE_UNAVAILABLE"));\n        continue;\n      }\n',
    to: "",
  },
  {
    name: "M3-4 a stream pulls as a signed-out reader",
    file: "src/sync/hub.ts",
    from: "        p = this.#server.pull({ u: s.u }, log, cursor, { clientId: s.clientId });",
    to: "        p = this.#server.pull(null, log, cursor, { clientId: s.clientId });",
  },
  {
    name: "M3-5 a commit wakes no stream",
    file: "src/sync/service.ts",
    from: "        hub?.wake(logs);\n",
    to: "",
  },
  {
    name: "M3-6 a nested transaction is not a savepoint",
    file: "../db/src/sync/store.ts",
    from: "      out = outer ? tx.immediate() : tx();",
    to: "      out = outer ? tx.immediate() : fn();",
  },
  {
    name: "M3-7 the rows of one commit read back by key",
    file: "../db/src/sync/store.ts",
    from: "ORDER BY version, rowid",
    to: "ORDER BY version, key",
  },
  {
    name: "M3-8 a restored database keeps its history id",
    file: "../db/src/sync/restore.ts",
    from: "    const moved = current !== null && previous !== current;",
    to: "    const moved = current !== null && previous === null;",
  },
  {
    name: "M3-9 open usage rows stay open at boot",
    file: "src/runs/sqliteLedger.ts",
    from: "updated_at = ? WHERE state = 'open'`",
    to: "updated_at = ? WHERE state = 'never'`",
  },
  {
    name: "M3-10 the allowance counts every payer",
    file: "src/runs/sqliteLedger.ts",
    from: "WHERE user_id = ? AND week = ? AND payer = 'included' AND run_id IS NOT NULL`",
    to: "WHERE user_id = ? AND week = ? AND run_id IS NOT NULL`",
  },
  {
    name: "M3-11 a run's question is listed for a person who can no longer read its thread",
    file: "src/runs/recordRunTexts.ts",
    from: "      const seen = node ? view(deps.source, node, handle) : null;",
    to: "      const seen = node ?? null;",
  },
  {
    name: "M3-12 the true save count of a private thread is not kept",
    file: "../db/src/sync/store.ts",
    from: "    this.s.bumpSaves.run({ th, d: delta });\n",
    to: "",
  },
  {
    name: "M3-13 deleted rows are left in the file",
    file: "../db/src/connection.ts",
    from: '  client.pragma("secure_delete = ON");',
    to: '  client.pragma("secure_delete = OFF");',
  },
  {
    name: "M3-14 runs still running stay running at boot",
    file: "src/sync/service.ts",
    from: '        if (r?.kind !== "run" || r.status !== "running") continue;',
    to: '        if (r?.kind !== "run" || r.status !== "queued") continue;',
  },
  {
    name: "M3-15 a stream's event id names no cursor",
    file: "src/sync/hub.ts",
    from: '        event: "changes",\n        data: JSON.stringify({ batches }),\n        id: this.#seal(s, s.cursors),',
    to: '        event: "changes",\n        data: JSON.stringify({ batches }),\n        id: this.#seal(s, new Map()),',
  },
  {
    name: "M3-16 a person may open any number of streams",
    file: "src/sync/routes.ts",
    from: "    if (!replacing && sync.hub.streamsOf(u) >= limits.streamsPerUser)",
    to: "    if (!replacing && sync.hub.streamsOf(u) >= Number.POSITIVE_INFINITY)",
  },
  // ---- M5a: owned runs (the test review of 361361d0, and the review fixes) ----
  {
    name: "M5a-1 the fence ignores the attempt",
    file: "src/runs/recordStore.ts",
    from: '    if (run?.kind !== "run" || run.attempt !== request.attempt) return null;\n    const alive',
    to: '    if (run?.kind !== "run") return null;\n    const alive',
  },
  {
    name: "M5a-2 a claim ignores the status",
    file: "src/runs/recordStore.ts",
    from: '      if (run?.kind !== "run" || run.status !== "queued" || run.attempt !== queued.attempt)\n        return null;\n      const alive = this.#alive(tx, run);',
    to: '      if (run?.kind !== "run" || run.attempt !== queued.attempt)\n        return null;\n      const alive = this.#alive(tx, run);',
  },
  {
    name: "M5a-3 a claim ignores the asker's read access",
    file: "src/runs/recordStore.ts",
    from: "|| userId === null || !canRead(tx, alive.th, run.u)) {",
    to: "|| userId === null || (canRead(tx, alive.th, run.u), false)) {",
  },
  {
    name: "M5a-4 the fence ignores a deleted node",
    file: "src/runs/recordStore.ts",
    from: '    if (n?.kind !== "node" || n.mod === "removed" || n.del) return null;',
    to: '    if (n?.kind !== "node" || n.mod === "removed") return null;',
  },
  {
    name: "M5a-5 a stopped attempt keeps its checkpoint",
    file: "src/runs/recordStore.ts",
    from: "        if (!current) this.#dropLive(request);\n",
    to: "",
  },
  {
    name: "M5a-6 a finished attempt keeps its checkpoint",
    file: "src/runs/recordStore.ts",
    from: "    if (!interrupted) this.#dropLive(request);",
    to: "    if (false && !interrupted) this.#dropLive(request);",
  },
  {
    name: "M5a-7a /live serves a reader who may not read the run",
    file: "src/runs/recordStore.ts",
    from: '    if (run?.kind !== "run" || !this.#mayRead(runId, u)) return null;\n    const turns',
    to: '    if (run?.kind !== "run" || (this.#mayRead(runId, u), false)) return null;\n    const turns',
  },
  {
    name: "M5a-7b a redacted turn counts as readable",
    file: "src/runs/recordStore.ts",
    from: '    return seen?.kind === "turn" && seen.blocks.length > 0;',
    to: '    return seen?.kind === "turn";',
  },
  {
    name: "M5a-8 deltas reach every connection of the log",
    file: "src/sync/hub.ts",
    from: "      if (!audience(s.u)) continue;",
    to: "      if (false && !audience(s.u)) continue;",
  },
  {
    name: "M5a-9 the ledger is not checkpointed while a call streams",
    file: "src/runs/meter.ts",
    from: "    this.#meter.deps.ledger.checkpoint(this.#id, this.live(), at);\n",
    to: "",
  },
  {
    name: "M5a-10 a cancelled call closes at 0",
    file: "src/runs/meter.ts",
    from: "    this.deps.ledger.close(call.id, counts, ending, this.deps.now());",
    to: '    this.deps.ledger.close(call.id, ending === "cancel" ? ZERO_COUNTS : counts, ending, this.deps.now());',
  },
  {
    name: "M5a-11a a removed thread keeps its turns",
    file: "../mutators/src/rules.ts",
    from: '      for (const x of tx.list("turn", th)) drop(keyOf(x));',
    to: '      for (const x of tx.list("turn", th)) void keyOf(x);',
  },
  {
    name: "M5a-11b a removed node keeps its turns",
    file: "../mutators/src/rules.ts",
    from: "      for (const x of turnsOf(tx, r.th, runs)) drop(keyOf(x));",
    to: "      for (const x of turnsOf(tx, r.th, runs)) void keyOf(x);",
  },
  {
    name: "M5a-11c a deleted node keeps its turns",
    file: "../mutators/src/nodes.ts",
    from: "        for (const x of turnsOf(tx, n.th, runs)) tx.del(keyOf(x));",
    to: "        for (const x of turnsOf(tx, n.th, runs)) void keyOf(x);",
  },
  {
    name: "M5a-11d a deleted thread keeps its root's turns",
    file: "../mutators/src/threads.ts",
    from: "      for (const x of turnsOf(tx, p.id, roots)) tx.del(keyOf(x));",
    to: "      for (const x of turnsOf(tx, p.id, roots)) void keyOf(x);",
  },
  {
    name: "M5a-12a hiding an ask does not serve its turns again",
    file: "../mutators/src/moderation.ts",
    from: '          for (const x of turnsOf(tx, runs[0]?.th ?? "", runs)) tx.touch(keyOf(x));',
    to: '          for (const x of turnsOf(tx, runs[0]?.th ?? "", runs)) void keyOf(x);',
  },
  {
    name: "M5a-12b touch keeps the rev",
    file: "../mutators/src/staged.ts",
    from: "    this.staged.set(key, { ...r, rev: (committed?.rev ?? r.rev - 1) + 1 });",
    to: "    this.staged.set(key, { ...r, rev: committed?.rev ?? r.rev - 1 });",
  },
  {
    name: "M5a-13 a hidden ask's turns are served to every reader",
    file: "../mutators/src/access.ts",
    // `if (item.mod === "hidden") return r;` ahead of the reader check, in a
    // form the type check accepts
    from: '    if (item.mod === "hidden" && ((u !== null && item.u === u) || isOwnerOf(g, r.s, u))) return r;',
    to: '    if (item.mod === "hidden" && ((u !== null && item.u === u) || isOwnerOf(g, r.s, u) || r.n >= 0)) return r;',
  },
  {
    name: "M5a-14 queue_full is not recorded",
    file: "../sync/src/wire.ts",
    from: '  "TOO_MANY_REQUESTS",\n  "SERVICE_UNAVAILABLE",\n  "INTERNAL_SERVER_ERROR",\n  "TOO_LARGE",\n]);',
    to: '  "TOO_MANY_REQUESTS",\n  "SERVICE_UNAVAILABLE",\n  "INTERNAL_SERVER_ERROR",\n  "TOO_LARGE",\n  "PRECONDITION_FAILED",\n]);',
  },
  {
    name: "M5a-15 a 21st queued run is accepted",
    file: "../mutators/src/rules.ts",
    from: "  if (ctx.queuedRuns() >= QUEUED_RUNS_MAX)",
    to: "  if (ctx.queuedRuns() > QUEUED_RUNS_MAX)",
  },
  {
    name: "M5a-16a boot resumes an attempt three times",
    file: "src/runs/dispatcher.ts",
    from: "run.resumes < MAX_AUTO_RESUMES",
    to: "run.resumes <= MAX_AUTO_RESUMES",
  },
  {
    name: "M5a-16b a resume is not counted",
    file: "src/runs/recordStore.ts",
    from: "interrupted.resumes + 1",
    to: "interrupted.resumes",
  },
  {
    name: "M5a-17 a stop does not abort the attempt",
    file: "src/runs/recordStore.ts",
    from: "        watchers.stopped(runId);\n",
    to: "",
  },
  {
    name: "M5a-18 a step's tool results are a record of their own",
    file: "src/runs/recordStore.ts",
    from: '      if (role === "tool" && last?.role === "assistant" && answers(last, turn)) {',
    to: '      if (role === "tool" && last?.role === "assistant" && answers(last, turn) && turn.blocks.length < 0) {',
  },
  {
    name: "M5a-19 the run's tok is this attempt's raw counts",
    file: "src/runs/loop.ts",
    from: "        tok: ledger.runTokens(runId),",
    to: "        tok: totals.inputTokens + totals.outputTokens,",
  },
  {
    name: "M5a-20 cached input counts in full",
    file: "src/runs/ledger.ts",
    from: "  return entry.cachedInputRatio ?? 1;",
    to: "  return entry.cachedInputRatio === undefined ? 1 : 1;",
  },
  {
    name: "M5a-21a a look-up has three searches",
    file: "src/runs/loop.ts",
    from: "  maxSearches: 2,",
    to: "  maxSearches: 3,",
  },
  {
    name: "M5a-21b a look-up has five steps",
    file: "src/runs/loop.ts",
    from: "  maxSteps: 4,",
    to: "  maxSteps: 5,",
  },
  {
    name: "M5a-22 boot closes open rows as of time 0",
    file: "src/boot.ts",
    from: "deps.ledger.closeOpen(now())",
    to: "deps.ledger.closeOpen(0)",
  },
  {
    name: "M5a-23 a finished root run leaves the thread running",
    file: "src/runs/recordStore.ts",
    from: "          running: false,\n          ...(stored",
    to: "          ...(stored",
  },
  {
    name: "M5a-24 deltas carry no sequence",
    file: "src/runs/recordStore.ts",
    from: "    live.seq += 1;\n",
    to: "",
  },
  {
    name: "M5a-25a a claim with committed turns starts fresh",
    file: "src/runs/recordStore.ts",
    from: '      kind: committed > 0 ? "resume" : "fresh",',
    to: '      kind: "fresh",',
  },
  {
    name: "M5a-25b a resume replays no turn",
    file: "src/runs/recordStore.ts",
    from: "    return this.#turns(this.#store, run, request.attempt).flatMap(turnsOf);",
    to: "    return [] as ReturnType<typeof turnsOf>;",
  },
  {
    name: "M5a-26 a hidden ask's answer is stored unmoderated",
    file: "src/runs/recordStore.ts",
    from: "          mod: ask.mod,",
    to: "          mod: ask ? null : null,",
  },
  {
    name: "M5a-27 a run's new attempt starts beside the old one",
    file: "src/runs/dispatcher.ts",
    from: "      if (busy.has(run.runId) || !admit(run, at)) continue;",
    to: "      if ((busy.has(run.runId) && running.has(`${run.runId}:${run.attempt}`)) || !admit(run, at)) continue;",
  },
  {
    name: "M5a-28 the newest queued run is admitted first",
    file: "src/runs/recordStore.ts",
    from: "      .sort((a, b) => a.queuedAt - b.queuedAt);",
    to: "      .sort((a, b) => b.queuedAt - a.queuedAt);",
  },
  {
    name: "M5a-29 a committed turn leaves /live on its number and text",
    file: "src/runs/recordStore.ts",
    from: '    live.n += 1;\n    live.text = "";\n',
    to: "",
  },
  {
    name: "M5a-30 /live ignores the stored checkpoint",
    file: "src/runs/recordStore.ts",
    from: "      if (stored) live = { n: stored.n, text: stored.md, seq: stored.seq };",
    to: "      void stored;",
  },
  {
    name: "M5a-31 a resumed attempt continues the delta sequence",
    file: "src/runs/recordStore.ts",
    from: " + (resumed ? RESUME_SEQ_GAP : 0);",
    to: ";",
  },
  {
    name: "M5a-32a a boot interrupt leaves the thread running",
    file: "src/sync/service.ts",
    from: '        if (th?.kind === "thread" && th.running) tx.put({ ...th, running: false });',
    to: '        if (th?.kind === "thread" && th.running && !th.running) tx.put({ ...th, running: false });',
  },
  {
    name: "M5a-32b a claim refused leaves the thread running",
    file: "src/runs/recordStore.ts",
    from: "        this.#rootRunning(tx, run, false);\n        refused = true;",
    to: "        refused = true;",
  },
  {
    name: "M5a-32c a resume leaves the thread not running",
    file: "src/runs/recordStore.ts",
    from: "      this.#rootRunning(tx, run, true);\n",
    to: "",
  },
  {
    name: "M5a-33 an ancestor's answer replays its Markdown, not its turns",
    file: "src/runs/context.ts",
    from: "    turns.length > 0",
    to: "    false && turns.length > 0",
  },
  {
    name: "M5a-34 the ledger checkpoints every 20 s",
    file: "src/runs/ledger.ts",
    from: "export const LEDGER_CHECKPOINT_MS = 2_000;",
    to: "export const LEDGER_CHECKPOINT_MS = 20_000;",
  },
  {
    name: "M5a-35a a look-up has twenty fetches",
    file: "src/runs/loop.ts",
    from: "  maxFetches: 2,",
    to: "  maxFetches: 20,",
  },
  {
    name: "M5a-35b a look-up's calls have the model's output cap",
    file: "src/runs/loop.ts",
    from: "  maxOutputTokens: 1_000,",
    to: "  maxOutputTokens: 100_000,",
  },
  {
    name: "M5a-36 a summary holds turns",
    file: "../sync/src/server/server.ts",
    from: '  "run",\n  "turn",\n]);',
    to: '  "run",\n]);',
  },
  {
    name: "M5a-37 the fence ignores a removed or gone thread",
    file: "src/runs/recordStore.ts",
    from: '    if (th?.kind !== "thread" || th.mod === "removed" || th.gone) return null;',
    to: '    if (th?.kind !== "thread") return null;',
  },
  {
    name: "M5a-38 /live reads as a waiting account",
    file: "src/app.ts",
    from: 'user?.status === "active" ? user.handle : null',
    to: "user?.handle ?? null",
  },
  {
    name: "M5a-39 context gives the model text the asker may not read",
    file: "src/runs/context.ts",
    from: "  if (view(tx, r, u) !== r) throw new Redacted();",
    to: "  if (false && view(tx, r, u) !== r) throw new Redacted();",
  },
  {
    name: "M5a-40 a reader may fork a hidden ask",
    file: "../mutators/src/nodes.ts",
    from: '      if (parent.mod === "hidden" && parent.u !== tx.me && !isOwnerOf(tx, p.s, tx.me))',
    to: '      if (false && parent.mod === "hidden" && parent.u !== tx.me && !isOwnerOf(tx, p.s, tx.me))',
  },
  {
    name: "M5a-41 a ban leaves the member's runs running",
    file: "src/runs/recordStore.ts",
    from: "    if (bannedFrom(g, run.s, run.u)) return null;",
    to: "    if (false && bannedFrom(g, run.s, run.u)) return null;",
  },
  {
    name: "M5a-42 a shell's del fences every run under it",
    file: "src/runs/recordStore.ts",
    from: '    if (th?.kind !== "thread" || th.mod === "removed" || th.gone) return null;',
    to: '    if (th?.kind !== "thread" || th.mod === "removed" || th.gone || th.del) return null;',
  },
  {
    name: "M5a-43 an attempt the fence stopped leaves its run running",
    file: "src/runs/recordStore.ts",
    from: "        ...(running\n          ? {",
    to: "        ...(false && running\n          ? {",
  },
  {
    name: "M5a-44 an attempt the fence stopped writes no tok",
    file: "src/runs/recordStore.ts",
    from: "        ...this.#spent(run),\n        ...(running",
    to: "        ...(running",
  },
  {
    name: "M5a-45 a 429 re-queue writes no tok",
    file: "src/runs/recordStore.ts",
    from: 'tx.put({ ...f.run, ...this.#spent(f.run), status: "queued" });',
    to: 'tx.put({ ...f.run, status: "queued" });',
  },
  {
    name: "M5a-46 a boot interrupt writes no tok",
    file: "src/runs/recordStore.ts",
    from: '          ...this.#spent(run),\n          status: "interrupted",',
    to: '          status: "interrupted",',
  },
  {
    name: "M5a-47 a claim refused writes no tok",
    file: "src/runs/recordStore.ts",
    from: '          ...this.#spent(run),\n          status: "failed",\n          fail: { why: "access", at: null, cls: null },',
    to: '          status: "failed",\n          fail: { why: "access", at: null, cls: null },',
  },
  {
    name: "M5a-48 a deleted run record keeps its checkpoint",
    file: "src/runs/recordStore.ts",
    from: "        this.#live.delete(runId);\n        this.#tables.dropLive(runId);\n",
    to: "        this.#live.delete(runId);\n",
  },
  {
    name: "M5a-49 Run again keeps the old attempt's checkpoint",
    file: "src/runs/recordStore.ts",
    from: "        this.#tables.dropOtherAttempts(runId, r.attempt);\n",
    to: "",
  },
  {
    name: "M5a-50 a Stop during the backoff keeps the checkpoint",
    file: "src/runs/recordStore.ts",
    from: '        if (r.status === "cancelled") this.#tables.dropLive(runId, r.attempt);',
    to: '        if (r.status === "cancelled" && r.attempt < 0) this.#tables.dropLive(runId, r.attempt);',
  },
  {
    name: "M5a-51 a claim refused keeps the checkpoint",
    file: "src/runs/recordStore.ts",
    from: "    if (refused) this.#tables.dropLive(queued.runId, queued.attempt);",
    to: "    if (false && refused) this.#tables.dropLive(queued.runId, queued.attempt);",
  },
  {
    name: "M5a-52 a run settled at the payer re-check keeps the checkpoint",
    file: "src/runs/recordStore.ts",
    from: "    if (settled) this.#tables.dropLive(queued.runId, queued.attempt);",
    to: "    if (false && settled) this.#tables.dropLive(queued.runId, queued.attempt);",
  },
  {
    name: "M5a-53 boot sweeps no checkpoint",
    file: "src/runs/dispatcher.ts",
    from: "      const sweptLive = store.sweepLive?.() ?? 0;",
    to: "      const sweptLive = store.sweepLive ? 0 : 0;",
  },
  {
    name: "M5a-54 a drain commits a tool call without its result",
    file: "src/runs/mapper.ts",
    from: '      (b) => b.type !== "toolUse" || (typeof b.id === "string" && answered.has(b.id)),',
    to: '      (b) => b.type !== "toolUse" || typeof b.id === "string" || answered.size >= 0,',
  },
  {
    name: "M5a-55a a resume replays a call without its result",
    file: "src/runs/messages.ts",
    from: '        } else if (block.type === "toolUse" && block.id && results.has(block.id)) {',
    to: '        } else if (block.type === "toolUse" && block.id && (results.has(block.id) || true)) {',
  },
  {
    name: "M5a-55b a resume replays a result without its call",
    file: "src/runs/messages.ts",
    from: "      if (!calls.has(toolCallId)) {",
    to: '      if (toolCallId === "" && !calls.has(toolCallId)) {',
  },
  {
    name: "M5a-56 a resume starts the step limit again",
    file: "src/runs/loop.ts",
    from: "    const stepsLeft = limits.maxSteps - steps;",
    to: "    const stepsLeft = limits.maxSteps - 0 * steps;",
  },
  {
    name: "M5a-57 a resume starts the search budget again",
    file: "src/runs/loop.ts",
    from: "new ToolBudget(limits.maxSearches, limits.maxFetches, spent);",
    to: "new ToolBudget(limits.maxSearches, limits.maxFetches, { ...spent, searches: 0 });",
  },
  {
    name: "M5a-58 a resume starts the wall clock again",
    file: "src/runs/loop.ts",
    from: "  const elapsed = Math.max(0, deps.now() - (request.startedAt ?? deps.now()));",
    to: "  const elapsed = request.startedAt === undefined ? 0 : 0;",
  },
  {
    name: "M5a-59 a resume is counted after its record write commits",
    file: "src/runs/recordStore.ts",
    from: "      this.#tables.setResumes(interrupted.runId, interrupted.attempt, interrupted.resumes + 1);\n      return true;\n    });",
    to: "      return true;\n    }) && (this.#tables.setResumes(interrupted.runId, interrupted.attempt, interrupted.resumes + 1), true);",
  },
  {
    name: "M5a-60 a 429 re-queue loses the run's place",
    file: "src/runs/recordStore.ts",
    from: "    if (kept?.attempt === run.attempt) return kept.v;",
    to: "    if (kept?.attempt === run.attempt && kept.v < 0) return kept.v;",
  },
  {
    name: "M5a-61 Run again keeps the run's first place",
    file: "src/runs/recordStore.ts",
    from: "    return this.#store.logRow(`space:${run.s}`, `run:${run.id}`)?.version ?? 0;",
    to: "    return this.#store.createdVersion(`run:${run.id}`) ?? 0;",
  },
  {
    name: "M5a-62 a re-claim leaves the earlier claim's checkpoint",
    file: "src/runs/recordStore.ts",
    from: "    if (resumed)\n      this.#tables.putLive({",
    to: "    if (false && resumed)\n      this.#tables.putLive({",
  },
  {
    name: "M5a-63 /live answers a checkpoint while the run is queued",
    file: "src/runs/recordStore.ts",
    from: '    else if (run.status === "running") {',
    to: '    else if (run.status === "running" || run.status === "queued") {',
  },
  {
    name: "M5a-64 /live has no rate limit",
    file: "src/app.ts",
    from: 'rateLimitByUserOrIp(limiter, "runLive", RUN_LIVE_READS)',
    to: 'rateLimitByUserOrIp(limiter, "runLive", { ...RUN_LIVE_READS, limit: 1e9 })',
  },
  {
    name: "M5a-65 /live opens a transaction",
    file: "src/runs/recordStore.ts",
    from: "    const turns = this.#turns(this.#store, run, run.attempt).map((t) => ({",
    to: "    const turns = this.#apply((tx) => this.#turns(tx, run, run.attempt)).map((t) => ({",
  },
  {
    name: "M5a-66 a removal mid-call closes the row cancel",
    file: "src/runs/loop.ts",
    from: '    if (superseded || !store.isCurrent(request)) return "superseded";',
    to: '    if (superseded) return "superseded";',
  },
  {
    name: "M3-17 a chunked body is read whole before the size check",
    file: "src/sync/routes.ts",
    from: "      if (size > maxBytes) {",
    to: "      if (size > Number.POSITIVE_INFINITY) {",
  },
  {
    name: "M3-18 /apply reads the body before it checks the caller",
    file: "src/sync/routes.ts",
    from: '    const caller = callerOf(c);\n    if (caller.kind === "none") return refusal(c, 401, "UNAUTHORIZED", undefined, now());\n    if (caller.kind === "waiting") return refusal(c, 403, "FORBIDDEN", undefined, now());\n    const body = await objectBody(c, limits.applyBytes);',
    to: '    const caller = callerOf(c);\n    const body = await objectBody(c, limits.applyBytes);\n    if (caller.kind === "none") return refusal(c, 401, "UNAUTHORIZED", undefined, now());\n    if (caller.kind === "waiting") return refusal(c, 403, "FORBIDDEN", undefined, now());',
  },
  {
    name: "M3-19 a replaced stream stays in the hub",
    file: "src/sync/hub.ts",
    from: '      old.sink.close("replaced");\n      this.remove(old);',
    to: '      old.sink.close("replaced");',
  },
  {
    name: "M3-20 a closed stream's response is not aborted",
    file: "src/sync/routes.ts",
    from: "            end();\n            stream.abort();",
    to: "            end();",
  },
  {
    name: "M3-21 the queue is bounded in events only",
    file: "src/sync/hub.ts",
    from: "s.sink.queued() >= MAX_QUEUED_EVENTS || s.sink.queuedBytes() >= MAX_QUEUED_BYTES",
    to: "s.sink.queued() >= MAX_QUEUED_EVENTS",
  },
  {
    name: "M3-22 a resync event's id holds the cursors after the flush",
    file: "src/sync/hub.ts",
    from: 'kept.set(log, before.get(log) ?? "");',
    to: 'kept.set(log, s.cursors.get(log) ?? "");',
  },
  {
    name: "M3-23 the session check renews the session",
    file: "src/sync/service.ts",
    from: "sessionValid: (token) => auth.sessionIsLive(options.db, auth.hashSessionToken(token)),",
    to: "sessionValid: (token) => auth.readSession(options.db, token) !== null,",
  },
  {
    name: "M3-24 tRPC mutations have a bucket of their own",
    file: "src/trpc/base.ts",
    from: "ctx.limiter.take(writesKey(ctx.user.id), spec)",
    to: "ctx.limiter.take(`mutations:${ctx.user.id}`, spec)",
  },
  {
    name: "M3-25 pulls are not limited",
    file: "src/sync/routes.ts",
    from: '  app.get("/pull", (c) => {\n    const limited = snapshots(c);\n    if (limited) return limited;',
    to: '  app.get("/pull", (c) => {',
  },
  {
    name: "M3-26 a signed-out /register calls the server half",
    file: "src/sync/routes.ts",
    from: '    if (caller.kind === "none") return refusal(c, 401, "UNAUTHORIZED", undefined, now());\n    if (caller.kind === "waiting") return refusal(c, 403, "FORBIDDEN", undefined, now());\n    if (sync.draining) return refusal(c, 503, "SERVICE_UNAVAILABLE", undefined, now());',
    to: '    if (caller.kind === "none") return c.json(sync.server.register(null), 401);\n    if (caller.kind === "waiting") return refusal(c, 403, "FORBIDDEN", undefined, now());\n    if (sync.draining) return refusal(c, 503, "SERVICE_UNAVAILABLE", undefined, now());',
  },
  {
    name: "M3-27 opening a stream is not limited",
    file: "src/sync/routes.ts",
    from: '    const limited = take(c, `streamOpens:user:${c.get("user")?.id ?? ""}`, buckets.streamOpens);\n    if (limited) return limited;',
    to: "",
  },
  {
    name: "M3-28 spaces.directory is not limited",
    file: "src/trpc/routers/spaces.ts",
    from: "  directory: publicProcedure\n    .use(directoryBucket)",
    to: "  directory: publicProcedure",
  },
  {
    name: "M3-29 spaces.byName is not limited",
    file: "src/trpc/routers/spaces.ts",
    from: '    .use(limit("byName", "userOrIp"))',
    to: "",
  },
  {
    name: "M3-30 the CSRF guard reads the raw pathname",
    file: "src/middleware/csrf.ts",
    from: "    // the decoded path the router matches, not the raw pathname\n    const path = c.req.path;",
    to: "    const path = new URL(c.req.url).pathname;",
  },
  {
    name: "M3-31 a body that is not an object reaches the route",
    file: "src/sync/routes.ts",
    from: '  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))\n    throw new BadBody("The body is not a JSON object.");',
    to: "",
  },
  {
    name: "M3-32 a read's cursor may be any value",
    file: "src/sync/routes.ts",
    from: '      if (r.cursor !== undefined && typeof r.cursor !== "string")',
    to: "      if (r.cursor !== undefined && (false as boolean))",
  },
  {
    name: "M3-33 an event id opens for any reader",
    file: "src/sync/eventIds.ts",
    from: '      if (u !== scope.u || typeof h !== "string") return null;',
    to: '      if (typeof h !== "string") return null;',
  },
  {
    name: "M3-34 a stream may read more than 64 logs together",
    file: "src/sync/routes.ts",
    from: "    if (cursors.size > MAX_STREAM_LOGS)",
    to: "    if (cursors.size > Number.POSITIVE_INFINITY && MAX_STREAM_LOGS)",
  },
  {
    name: "M3-35 the rotation time is any date Date.parse reads",
    file: "src/config.ts",
    from: "    const rotatedAt = ISO_TIME.test(raw) ? Date.parse(raw) : Number.NaN;",
    to: '    const rotatedAt = ISO_TIME.test(raw) || raw !== "" ? Date.parse(raw) : Number.NaN;',
  },
  {
    name: "M3-36 a rotation time in the future is accepted",
    file: "src/config.ts",
    from: '    else if (rotatedAt > options.now)\n      issues.push("SESSION_CURSOR_KEY_ROTATED_AT: is in the future");\n',
    to: "",
  },
  {
    name: "M3-37 production accepts the development cursor key",
    file: "src/config.ts",
    from: "    if (sameBytes(current, DEVELOPMENT_CURSOR_KEY))",
    to: "    if (sameBytes(current, DEVELOPMENT_CURSOR_KEY) && !options.production)",
  },
  {
    name: "M3-38 a cursor key is any base64 of 32 bytes",
    file: "src/config.ts",
    from: "    if (!BASE64_32.test(raw)) {",
    to: '    if (Buffer.from(raw, "base64").length !== 32 && BASE64_32.source !== "") {',
  },
  {
    name: "M3-39 the window settings have no upper bound",
    file: "src/config.ts",
    from: "const MAX_WINDOW_THREADS = 10_000;",
    to: "const MAX_WINDOW_THREADS = Number.MAX_SAFE_INTEGER;",
  },
  {
    name: "M3-40 boot does not warn about the development cursor key",
    file: "src/main.ts",
    from: "  if (!config.cursorKeyIsDevelopment) return false;\n  logger.warn(",
    to: "  if (config.cursorKeyIsDevelopment || !config.cursorKeyIsDevelopment) return false;\n  logger.warn(",
  },
  {
    name: "M3-41 a test server mounts the test routes",
    file: "src/app.ts",
    from: "  if (deps.config.testRoutes) app.route",
    to: '  if (deps.config.env === "test") app.route',
  },
  {
    name: "M3-42 SESSION_TEST_ROUTES is accepted anywhere",
    file: "src/config.ts",
    from: '    value.SESSION_TEST_ROUTES &&\n    (value.NODE_ENV !== "test" || !isLoopbackOrigin(value.SESSION_PUBLIC_ORIGIN))',
    to: '    value.SESSION_TEST_ROUTES &&\n    value.NODE_ENV === "production" &&\n    !isLoopbackOrigin(value.SESSION_PUBLIC_ORIGIN)',
  },
  {
    name: "M3-43 an envelope's version is checked against the compiled minimum",
    file: "../sync/src/server/server.ts",
    from: "version < this.minProtocol)",
    to: "version < MIN_PROTOCOL_VERSION && this.minProtocol > 0)",
  },
  {
    name: "M3-44 a read request may name a log twice",
    file: "src/sync/routes.ts",
    from: "        if (logs.has(r.log))",
    to: "        if (logs.has(r.log) && (false as boolean))",
  },
  {
    name: "M3-45 a read request has no work budget",
    file: "src/sync/routes.ts",
    from: "      if (bytes >= budget.bytes || spent >= budget.ms) {",
    to: "      if ((bytes >= budget.bytes || spent >= budget.ms) && (false as boolean)) {",
  },
  {
    name: "M3-46 a read request costs one snapshot whatever it reads",
    file: "src/sync/routes.ts",
    from: "      : snapshots(c, 1 + Math.floor(others / READS_PER_SNAPSHOT));",
    to: "      : snapshots(c, 1 + 0 * Math.floor(others / READS_PER_SNAPSHOT));",
  },
  {
    name: "M3-47 a threads-only read takes from the snapshots bucket",
    file: "src/sync/routes.ts",
    from: "    const limited = threadsOnly\n      ? take(",
    to: "    const limited = !threadsOnly\n      ? take(",
  },
  {
    name: "M3-48 a read request does not yield between its reads",
    file: "src/sync/routes.ts",
    from: "      if (answers.length > 0) await new Promise<void>((resolve) => setImmediate(resolve));\n",
    to: "",
  },
  {
    name: "M3-49 a threads snapshot scans the whole log",
    file: "../sync/src/server/server.ts",
    from: '    for (const row of tier === "threads"\n      ? this.threadRows(log, threads)\n      : this.store.logRows(log, 0)) {',
    to: '    for (const row of tier === "threads"\n      ? this.threadRows(log, threads) && this.store.logRows(log, 0)\n      : this.store.logRows(log, 0)) {',
  },
  {
    name: "M3-50 a read that throws fails the whole request",
    file: "src/sync/routes.ts",
    from: '        c.get("logger").error({ err: e, log: r.log }, "sync read failed");\n        return readError("INTERNAL_SERVER_ERROR");',
    to: "        throw e;",
  },
  {
    name: "M3-51 byName takes the name as written",
    file: "src/sync/directory.ts",
    from: "      const name = channelName(raw);",
    to: "      const name: string | null = raw.length ? raw : channelName(raw);",
  },
  {
    name: "M3-52 the directory pages by key",
    file: "src/sync/directory.ts",
    from: "      ORDER BY created_v, key LIMIT ?`,",
    to: "      ORDER BY key LIMIT ?`,",
  },
  {
    name: "M3-53 the store directory ignores its cursor",
    file: "src/sync/directory.ts",
    from: "      return page.all(v, v, key, limit).flatMap((row) => {",
    to: '      return page.all(-1 + 0 * v, -1, key && "", limit).flatMap((row) => {',
  },
  {
    name: "M3-54 a pull does not compare the history id",
    file: "../sync/src/server/server.ts",
    from: "      c.hid !== this.store.history() ||\n",
    to: "",
  },
  {
    name: "M3-55 the operator's request is ignored",
    file: "../db/src/sync/restore.ts",
    from: "    const requested = metaValue(db, RESET_KEY) !== null;",
    to: '    const requested = metaValue(db, RESET_KEY) === "never";',
  },
  {
    name: "M3-56 an erasing commit does not checkpoint",
    file: "../db/src/sync/store.ts",
    from: "    if (outer && this.erased) {",
    to: "    if (outer && this.erased && (false as boolean)) {",
  },
  {
    name: "M3-57 a backfill reads the stored shape through the schema",
    file: "../db/src/backfills/records.ts",
    from: "      const old = JSON.parse(body) as StoredBody;",
    to: "      const old = (store.byKey(key) ?? JSON.parse(body)) as StoredBody;",
  },
  {
    name: "M3-58 the outermost transaction is deferred",
    file: "../db/src/sync/store.ts",
    from: "      out = outer ? tx.immediate() : tx();",
    to: "      out = outer ? tx.deferred() : tx();",
  },
  {
    name: "M3-59 a read-only connection caches records",
    file: "../db/src/sync/store.ts",
    from: "    this.cacheSize = this.sqlite.readonly ? 0 : (options.cacheSize ?? RECORD_CACHE_SIZE);",
    to: "    this.cacheSize = options.cacheSize ?? RECORD_CACHE_SIZE;",
  },
  {
    name: "M3-60 a commit is not a transaction",
    file: "../db/src/sync/store.ts",
    from: "      out = outer ? tx.immediate() : tx();",
    to: "      out = outer ? fn() : tx();",
  },
  {
    name: "M3-61 a new record without its commit is born at version 0",
    file: "../db/src/sync/store.ts",
    from: "    else throw new Error(`record ${key} is new: its creating commit is needed`);",
    to: "    else this.s.insertRecord.run({ ...row, createdV: 0, createdAt: 0 });",
  },
  {
    name: "M3-62 a tombstone forgets who deleted the record",
    file: "../db/src/sync/store.ts",
    from: "      person: t.person,\n      by: t.by,\n      at: t.at,",
    to: "      person: t.person,\n      by: null,\n      at: t.at,",
  },
  {
    name: "M3-63 a record's row is created at time 0",
    file: "../db/src/sync/store.ts",
    from: "createdV: created.version, createdAt: created.at",
    to: "createdV: created.version, createdAt: 0",
  },
  {
    name: "M3-64 the record cache is never trimmed",
    file: "../db/src/sync/store.ts",
    from: "    if (this.cache.size >= this.cacheSize) {",
    to: "    if (this.cache.size >= this.cacheSize && (false as boolean)) {",
  },
  {
    name: "M3-65 the summary horizon ignores SESSION_WEB_SUMMARY_DAYS",
    file: "../sync/src/server/window.ts",
    from: "  const horizon = settings.summaryDays === undefined ? SUMMARY_WINDOW : settings.summaryDays * DAY;",
    to: "  const horizon = settings.summaryDays === undefined ? SUMMARY_WINDOW : SUMMARY_WINDOW;",
  },
  {
    name: "M3-66 a threads read runs as the channel owner",
    file: "src/sync/routes.ts",
    from: "        return sync.server.snapshot(reader, r.log as LogId, {",
    to: '        return sync.server.snapshot(r.tier === "threads" ? { u: "olga" } : reader, r.log as LogId, {',
  },
  {
    name: "M3-67 a summary read is served as a window",
    file: "src/sync/routes.ts",
    from: "          ...(r.tier !== undefined ? { tier: r.tier as Tier } : {}),",
    to: '          ...(r.tier !== undefined ? { tier: (r.tier === "summary" ? "window" : r.tier) as Tier } : {}),',
  },
  {
    name: "M3-68 a pull in a read request drops the client id",
    file: "src/sync/routes.ts",
    from: "          return sync.server.pull(reader, r.log as LogId, r.cursor, {\n            ...(clientId ? { clientId } : {}),\n          });",
    to: "          return sync.server.pull(reader, r.log as LogId, r.cursor, {});",
  },
  {
    name: "M3-69 shutdown waits for every connection",
    file: "src/main.ts",
    from: '  if ("closeAllConnections" in server) server.closeAllConnections();',
    to: "",
  },
  {
    name: "M3-70 register is open during the drain",
    file: "src/sync/routes.ts",
    from: '    if (sync.draining) return refusal(c, 503, "SERVICE_UNAVAILABLE", undefined, now());\n    const limited = take(c, `register',
    to: "    const limited = take(c, `register",
  },
  {
    name: "M3-71 an idle client id opens a stream",
    file: "src/sync/routes.ts",
    from: '    if (!client || client.u !== u || client.seen <= now() - idleTtl)\n      return refusal(c, 409, "WRONG_CLIENT", undefined, now());\n    // one stream',
    to: '    if (!client || client.u !== u)\n      return refusal(c, 409, "WRONG_CLIENT", undefined, now());\n    // one stream',
  },
  {
    name: "M3-72 a resynced log stays subscribed",
    file: "src/sync/hub.ts",
    from: "        s.cursors.delete(log);\n        this.#unsubscribe(s, log);",
    to: "        s.cursors.delete(log);",
  },
  {
    name: "M3-73 the session check ends no stream",
    file: "src/sync/hub.ts",
    from: "      if (s.sessionToken === null || !valid(s.sessionToken)) {",
    to: "      if ((s.sessionToken === null || !valid(s.sessionToken)) && (false as boolean)) {",
  },
  {
    name: "M3-74 the hourly maintenance does not checkpoint",
    file: "src/sync/service.ts",
    from: "      const checkpoint = this.store.checkpoint();",
    to: "      const checkpoint = (null as unknown) as ReturnType<typeof this.store.checkpoint>;",
  },
  {
    name: "M3-75 register leaves out the person's handle",
    file: "src/sync/routes.ts",
    from: "    if (r.ok) return c.json({ ...r, user: caller.actor.u }, 200);",
    to: "    if (r.ok) return c.json(r, 200);",
  },
  {
    name: "M3-76 threadSpace answers a thread the caller may not read",
    file: "src/trpc/routers/spaces.ts",
    from: "      return { space: view(store, r, reader) === null ? null : r.s };",
    to: "      return { space: view(store, r, reader) === undefined ? null : r.s };",
  }, // ---- M5b: the payer, the allowance and the overdraft (03 K3, K8-K10) ----
  {
    name: "M5b-1 pre decides no payer: every run is paid by its model's first payer",
    file: "../mutators/src/rules.ts",
    from: "  return { pay: prePayer(ctx, model) ?? NO_PAYER };",
    to: "  return { pay: firstPayer(model) || NO_PAYER };",
  },
  {
    name: "M5b-2 a run nothing can pay for is queued on included tokens",
    file: "../mutators/src/rules.ts",
    from: "  return { pay: prePayer(ctx, model) ?? NO_PAYER };",
    to: '  return { pay: prePayer(ctx, model) ?? "included" };',
  },
  {
    name: "M5b-3 the Anthropic key pays whatever the billing setting",
    file: "../mutators/src/rules.ts",
    from: '    facts.billing === "key" &&\n',
    to: "    facts.billing !== undefined &&\n",
  },
  {
    name: "M5b-4 the sync server reads no payer facts",
    file: "../sync/src/server/server.ts",
    from: "      if (payer) pre.payerFacts = () => payer(u);",
    to: "      void payer;",
  },
  {
    name: "M5b-5 a member at the allowance still has included tokens left",
    file: "src/runs/allowance.ts",
    from: "    includedLeft: includedUsed(deps, userId) < deps.allowances.weekly(userId),",
    to: "    includedLeft: includedUsed(deps, userId) <= deps.allowances.weekly(userId),",
  },
  {
    name: "M5b-6 the payer facts ignore the billing setting",
    file: "src/runs/allowance.ts",
    from: "    billing: deps.allowances.billing(userId),",
    to: '    billing: "pause",',
  },
  {
    name: "M5b-7 the claim keeps the payer it was queued with",
    file: "src/runs/dispatcher.ts",
    from: "      const payer = entry ? payerAtStart(budgetDeps, run.userId, entry, ran) : run.payer;",
    to: "      const payer = run.payer as ReturnType<typeof payerAtStart>;\n      void budgetDeps;\n      void ran;",
  },
  {
    name: "M5b-8 the claim does not write the payer to the run record",
    file: "src/runs/recordStore.ts",
    from: "        pay: queued.payer,\n",
    to: "",
  },
  {
    name: "M5b-9 the week starts on Thursday",
    file: "src/runs/ledger.ts",
    from: "  const sinceFriday = (day.getUTCDay() + 2) % 7;",
    to: "  const sinceFriday = (day.getUTCDay() + 3) % 7;",
  },
  {
    name: "M5b-10 an included run never moves to the member's key",
    file: "src/runs/allowance.ts",
    from: "    if (!this.allowanceSpent()) {\n      return null;\n    }\n    return anthropicKeyFor",
    to: "    if (this.allowanceSpent() || !this.allowanceSpent()) {\n      return null;\n    }\n    return anthropicKeyFor",
  },
  {
    name: "M5b-11 the overdraft limit is ten times SESSION_OVERDRAFT_TOKENS",
    file: "src/runs/allowance.ts",
    from: "    const limit = this.#deps.allowances.weekly(this.#userId) + this.#deps.limits.overdraftTokens;",
    to: "    const limit = this.#deps.allowances.weekly(this.#userId) + this.#deps.limits.overdraftTokens * 10;",
  },
  {
    name: "M5b-12 a key-only model runs without its key",
    file: "../mutators/src/rules.ts",
    from: "      if (key !== null && facts.keys.includes(key)) return payer;",
    to: "      if (key !== null) return payer;",
  },
  {
    name: "M5b-13 the overdraft limit stops key-paid steps too",
    file: "src/runs/allowance.ts",
    from: '    if (payer !== "included") {\n      return null;\n    }\n',
    to: "    void payer;\n",
  },
  {
    name: "M5b-14 a member's allowance override is ignored",
    file: "src/keys/allowances.ts",
    from: "  return usageRepo.weeklyAllowance(deps.db, userId) ?? deps.config.limits.weeklyTokens;",
    to: "  return (usageRepo.weeklyAllowance(deps.db, userId) && null) ?? deps.config.limits.weeklyTokens;",
  },
  {
    name: "M5b-15 usage.get reads the deployment's allowance",
    file: "src/trpc/routers/keys.ts",
    from: "      allowance: ctx.allowances.weekly(ctx.user.id),",
    to: "      allowance: ctx.config.limits.weeklyTokens,",
  },
  // ---- M5b review fixes (S1-S6), named by the review's row ----
  {
    name: "M5b-16 S1: a re-claim of an attempt that ran is held to the first claim's rule",
    file: "src/runs/dispatcher.ts",
    from: "      const payer = entry ? payerAtStart(budgetDeps, run.userId, entry, ran) : run.payer;",
    to: "      const payer = entry ? payerAtStart(budgetDeps, run.userId, entry, false) : run.payer;\n      void ran;",
  },
  {
    name: "M5b-17 S1: an attempt with ledger rows of its own is not taken as one that ran",
    file: "src/runs/dispatcher.ts",
    from: "      const ran = run.ran === true || ledger.runTokens(run.runId, run.attempt) > 0;",
    to: "      const ran = run.ran === true;",
  },
  {
    name: "M5b-18 S1: a re-claim is admitted past the allowance plus overdraft",
    file: "src/runs/allowance.ts",
    from: '  if (decision === "out_of_tokens" && ran && withinOverdraft(deps, userId)) {',
    to: '  if (decision === "out_of_tokens" && ran) {',
  },
  {
    name: "M5b-19 S2: the title call is made past the allowance plus overdraft",
    file: "src/runs/loop.ts",
    from: "      const title = budget.includedExhausted()\n",
    to: "      const title = false\n",
  },
  {
    name: "M5b-20 S2: the summary line call is made past the allowance plus overdraft",
    file: "src/runs/loop.ts",
    from: "    if (request.finalSteps?.summary && owned() && !signal.aborted && !budget.includedExhausted()) {",
    to: "    if (request.finalSteps?.summary && owned() && !signal.aborted) {",
  },
  {
    name: "M5b-21 S2: the context summary call is made past the allowance plus overdraft",
    file: "src/runs/loop.ts",
    from: "          budget.includedExhausted()\n            ? Promise.resolve(null)\n",
    to: "          false\n            ? Promise.resolve(null)\n",
  },
  {
    name: "M5b-22 S2: the bill counts the title and summary calls",
    file: "src/runs/allowance.ts",
    from: "  return billLabel(ledger.runPayers(runId, BILLED_KIND)) ?? billLabel(ledger.runPayers(runId));",
    to: "  return billLabel(ledger.runPayers(runId)) ?? billLabel(ledger.runPayers(runId, BILLED_KIND));",
  },
  {
    name: "M5b-23 S3: the end of an attempt writes the summary's bill",
    file: "src/runs/recordStore.ts",
    from: "      const bill = spent.bill === undefined ? summary.bill : spent.bill;",
    to: "      const bill = summary.bill;",
  },
  {
    name: "M5b-24 S3: the bill names the latest attempt's payers only",
    file: "src/runs/sqliteLedger.ts",
    from: '        "SELECT DISTINCT payer FROM usage_events WHERE run_id = ? AND kind = ?",',
    to: '        "SELECT DISTINCT payer FROM usage_events e WHERE run_id = ? AND kind = ? AND attempt = (SELECT max(attempt) FROM usage_events m WHERE m.run_id = e.run_id)",',
  },
  {
    name: "M5b-25 S4: a run on the member's key never moves back to included tokens",
    file: "src/runs/loop.ts",
    from: "        stepNumber > 0 &&\n",
    to: "        stepNumber < 0 &&\n",
  },
  {
    name: "M5b-26 S5: the step boundary ignores the next request's input",
    file: "src/runs/loop.ts",
    from: "                nextInputEstimate(done.at(-1)?.content),",
    to: "                0 * nextInputEstimate(done.at(-1)?.content),",
  },
  {
    name: "M5b-27 S6: a stored valid key that does not open counts for the payer",
    file: "src/keys/apiKeys.ts",
    from: '  return row !== null && view(deps, row).status === "valid" ? row.sealed : null;',
    to: '  return row?.status === "valid" ? row.sealed : null;',
  },
  // ---- M6: membership, moderation and the deletion job (the M6 review fixes) ----
  {
    name: "M6-8 D1: the job leaves the person's comments",
    file: "../db/src/repos/accountSpaces.ts",
    from: '  ["comment", "comments.delete", (r) => ({ id: (r as { id: string }).id })],\n',
    to: "",
  },
  {
    name: "M6-9 D3: the job leaves the person's branches",
    file: "../db/src/repos/accountSpaces.ts",
    from: '  [\n    "node",\n    "followups.delete",\n    (r) => ({ thread: (r as { th: string }).th, node: (r as { id: string }).id }),\n  ],\n',
    to: "",
  },
  {
    name: "M6-10 D8: the job leaves the bans of the person",
    file: "../db/src/repos/accountSpaces.ts",
    from: 'const OWN_KINDS: readonly Kind[] = ["save", "notif", "prefs", "ban", "invite"];',
    to: 'const OWN_KINDS: readonly Kind[] = ["save", "notif", "prefs", "invite"];',
  },
  {
    name: "M6-11 D9: the job leaves the links the person made",
    file: "../db/src/repos/accountSpaces.ts",
    from: 'const OWN_KINDS: readonly Kind[] = ["save", "notif", "prefs", "ban", "invite"];',
    to: 'const OWN_KINDS: readonly Kind[] = ["save", "notif", "prefs", "ban"];',
  },
  {
    name: "M6-12 D13: the job deletes threads before what is under them",
    file: "../db/src/repos/accountSpaces.ts",
    from: "const DELETES: readonly [Kind, string, (r: StoredRecord) => unknown][] = [\n",
    to: 'const DELETES: readonly [Kind, string, (r: StoredRecord) => unknown][] = [\n  ["thread", "threads.delete", (r) => ({ id: (r as { id: string }).id })],\n',
    also: [
      {
        from: '  ["thread", "threads.delete", (r) => ({ id: (r as { id: string }).id })],\n];',
        to: "];",
      },
    ],
  },
  {
    name: "M6-13 D19: the job swallows a fault of a delete",
    file: "../db/src/repos/accountSpaces.ts",
    from: "      def.run(tx, i, {});\n      out.items += 1;",
    to: "      try {\n        def.run(tx, i, {});\n      } catch (e) {\n        if ((e as { code?: unknown }).code !== undefined) throw e;\n      }\n      out.items += 1;",
  },
  {
    name: "M6-14 E4c: 60 joins an hour is 61",
    file: "src/config.ts",
    from: "  SESSION_LIMIT_JOINS_PER_HOUR: positiveInteger(60, 1),",
    to: "  SESSION_LIMIT_JOINS_PER_HOUR: positiveInteger(61, 1),",
  },
  {
    name: "M6-15 E5a: channels made are counted per hour",
    file: "src/middleware/rateLimit.ts",
    from: "    spacesCreated: { limit: limits.spacesPerDay, windowMs: DAY },",
    to: "    spacesCreated: { limit: limits.spacesPerDay, windowMs: HOUR },",
  },
  {
    name: "M6-16 E5b: joins are counted per minute",
    file: "src/middleware/rateLimit.ts",
    from: "    joins: { limit: limits.joinsPerHour, windowMs: HOUR },",
    to: "    joins: { limit: limits.joinsPerHour, windowMs: MINUTE },",
  },
  {
    name: "M6-17 E5c: channel invite links are counted per hour",
    file: "src/middleware/rateLimit.ts",
    from: "    channelInvites: { limit: limits.channelInvitesPerDay, windowMs: DAY },",
    to: "    channelInvites: { limit: limits.channelInvitesPerDay, windowMs: HOUR },",
  },
  {
    name: "M6-18 F1: a link at its expiry time counts as open",
    file: "../mutators/src/invites.ts",
    from: "const isOpen = (tx: Tx, l: InviteRec) => l.dead === null && isoToMs(l.expiresAt) > isoToMs(tx.now);",
    to: "const isOpen = (tx: Tx, l: InviteRec) => l.dead === null && isoToMs(l.expiresAt) >= isoToMs(tx.now);",
  },
  {
    name: "M6-19 F7: a link admits at its expiry time",
    file: "../mutators/src/spaces.ts",
    from: "        isoToMs(link.expiresAt) > isoToMs(tx.now);",
    to: "        isoToMs(link.expiresAt) >= isoToMs(tx.now);",
  },
  {
    name: "M6-20 B8: the ban message names no channel",
    file: "../mutators/src/tx.ts",
    from: '      throw refuse("FORBIDDEN", `You are banned from #${s.name}.`);',
    to: '      throw refuse("FORBIDDEN", "You are banned from this space.");',
  },
  {
    name: "M6-21 G4: a failed invite_used write is ignored",
    file: "src/trpc/routers/membership.ts",
    from: "  if (!written.ok) throw new Error(`invite_used notification: ${written.error.code}`);",
    to: "  if (false) throw new Error(`invite_used notification: ${String(written.ok)}`);",
  },
  {
    name: "M6-22 G7: afterRedeem's error is swallowed",
    file: "../db/src/repos/accountInvites.ts",
    from: "      input.afterRedeem?.(tx, {\n",
    to: "      try {\n      input.afterRedeem?.(tx, {\n",
    also: [
      {
        from: "        inviteId: invite.id,\n      });\n      return {",
        to: "        inviteId: invite.id,\n      });\n      } catch {\n        // swallowed\n      }\n      return {",
      },
    ],
  },
  {
    name: "M6-23 H1: the check scans the file, not the WAL",
    file: "src/ops/privacyCheck.ts",
    from: "  const inWal = fileHolds(wal, input.text);",
    to: "  const inWal = fileHolds(input.path, input.text) && false;",
  },
  {
    name: "M6-24 H7: the pulls start at the removal",
    file: "src/ops/privacyCheck.ts",
    from: "        v: removedAt - 1,",
    to: "        v: removedAt,",
  },
  {
    name: "M6-25 H8: the snapshot text check always passes",
    file: "src/ops/privacyCheck.ts",
    from: "      check(`${who}'s snapshot holds no removed text`, !holdsText(snap, input.text));",
    to: "      check(`${who}'s snapshot holds no removed text`, true);",
  },
  {
    name: "M6-26 H9: the pull text check always passes",
    file: "src/ops/privacyCheck.ts",
    from: "        !resync && !holdsText(pulled, input.text),",
    to: "        true,",
  },
  {
    name: "M6-27 H10: the author's notification check always passes",
    file: "src/ops/privacyCheck.ts",
    from: '      check("the author has the removed notification", notes.length === 1);',
    to: '      check("the author has the removed notification", true);',
  },
  {
    name: "M6-28 H11: the notification text check always passes",
    file: "src/ops/privacyCheck.ts",
    from: '      check("the removed notification holds no removed text", !holdsText(notes, input.text));',
    to: '      check("the removed notification holds no removed text", true);',
  },
  {
    name: "M6-29 H12: the names-no-author check always passes",
    file: "src/ops/privacyCheck.ts",
    from: '          served === undefined || (served.kind === "thread" && served.u === null),',
    to: "          true,",
  },
  {
    name: "M6-30 H13: the script exits 0 always",
    file: "scripts/privacy-check.ts",
    from: "process.exitCode = report.ok ? 0 : 1;",
    to: "process.exitCode = 0;",
  },
  {
    name: "M6-31 H17: a hidden thread counts as removed",
    file: "src/ops/privacyCheck.ts",
    from: '    check("the thread is removed", thread.mod === "removed", `mod: ${String(thread.mod)}`);',
    to: '    check("the thread is removed", thread.mod !== null, `mod: ${String(thread.mod)}`);',
  },
  {
    name: "M6-32 I5: admin.models.setDefault is not limited",
    file: "src/trpc/routers/models.ts",
    from: "  setDefault: adminModelsProcedure",
    to: "  setDefault: adminProcedure",
  },
  {
    name: "M6-33 K2: a read notification is coalesced into",
    file: "../mutators/src/notify.ts",
    from: '      const old = tx.list("notif", { th }).find((n) => n.to === to && n.type === type && !n.read);',
    to: '      const old = tx.list("notif", { th }).find((n) => n.to === to && n.type === type);',
  },
  {
    name: "M6-34 K5: a coalesced notification keeps its first time",
    file: "../mutators/src/notify.ts",
    from: "        tx.put({ ...old, item, actor, n: old.n + 1, createdAt: tx.now });",
    to: "        tx.put({ ...old, item, actor, n: old.n + 1 });",
  },
  {
    name: "M6-35 Z1: pre-stage refusals are not counted for /metrics",
    file: "src/middleware/rateLimit.ts",
    from: "    this.#refusals.set(scope, (this.#refusals.get(scope) ?? 0) + 1);\n    const oldest",
    to: "    const oldest",
  },
  {
    name: "M6-36 S1a: a kept thread keeps its author",
    file: "../db/src/repos/accountSpaces.ts",
    from: '      if (r.kind === "thread") tx.put({ ...r, u: null, sum: null });',
    to: '      if (r.kind === "thread") tx.put({ ...r, sum: null });',
  },
  {
    name: "M6-37 S1b: kept branches and threads keep their answers",
    file: "../db/src/repos/accountSpaces.ts",
    from: '  for (const a of tx.list("answer", { u })) tx.del(keyOf(a));\n',
    to: "",
  },
  {
    name: "M6-38 S1c: a kept reply or comment keeps its author",
    file: "../db/src/repos/accountSpaces.ts",
    from: "      else tx.put({ ...r, u: null });",
    to: "      else tx.put({ ...r });",
  },
  {
    name: "M6-39 S1d: notifications keep the person as their actor",
    file: "../db/src/repos/accountSpaces.ts",
    from: '    if (r?.kind === "notif" && r.actor === u) tx.put({ ...r, actor: null });',
    to: '    if (r?.kind === "notif" && r.actor === u) continue;',
  },
  {
    name: "M6-40 S1e: a link keeps the person as its user",
    file: "../db/src/repos/accountSpaces.ts",
    from: '    else if (r?.kind === "invite" && r.usedBy === u) tx.put({ ...r, usedBy: null });',
    to: '    else if (r?.kind === "invite" && r.usedBy === u) continue;',
  },
  {
    name: "M6-41 S2: the files are searched for the raw text only",
    file: "src/ops/privacyCheck.ts",
    from: "  const escaped = JSON.stringify(text).slice(1, -1);",
    to: "  const escaped = text;",
  },
  {
    name: "M6-42 S3a: the job runs while a server's heartbeat is fresh",
    file: "../db/src/repos/accounts.ts",
    from: '  if (!options.server) assertServerStopped(db, now(), "The account-deletion job");\n',
    to: "",
  },
  {
    name: "M6-43 S3b: the server writes no heartbeat at boot",
    file: "src/sync/service.ts",
    from: "    beat();\n    this.#heartbeat",
    to: "    this.#heartbeat",
  },
  {
    name: "M6-44 S4: the job leaves the person's run checkpoints",
    file: "../db/src/repos/accountSpaces.ts",
    from: "    tx.delete(runLive).where(inArray(runLive.runId, runs)).run();\n",
    to: "",
  },
  {
    name: "M6-45 S5: the job leaves the account's API keys",
    file: "../db/src/repos/accounts.ts",
    from: "      tx.delete(apiKeys).where(eq(apiKeys.userId, userId)).run();\n",
    to: "",
  },
  {
    name: "M6-46 S6: a write that changes nothing takes a pre-stage use",
    file: "../sync/src/server/server.ts",
    from: "      if (out.staged && this.commit(out.staged, now) !== null) used.push(...(out.uses ?? []));",
    to: "      if (out.staged) {\n        this.commit(out.staged, now);\n        used.push(...(out.uses ?? []));\n      }",
  },
  {
    name: "M6-47 S7: a restored link is not counted",
    file: "../mutators/src/invites.ts",
    from: "      if (isOpen(tx, restored)) roomForLink(tx, l.sp);\n",
    to: "",
  },
  {
    name: "M6-48 S8: a deleted save stays in its thread's count",
    file: "../db/src/repos/accountSpaces.ts",
    from: '      if (r.kind === "save") countSaves(tx, r.th, -1);\n',
    to: "",
  },
  {
    name: "M6-49 S9: the job skips the person's old shells",
    file: "../db/src/repos/accountSpaces.ts",
    from: '      if (!now || (now.kind === "thread" && now.gone)) continue;',
    to: '      if (!now || ("del" in now && now.del) || (now.kind === "thread" && now.gone)) continue;',
  },
  {
    name: "M6-50 S10: the job swallows a refusal of a delete",
    file: "../db/src/repos/accountSpaces.ts",
    from: "      def.run(tx, i, {});\n      out.items += 1;",
    to: "      try {\n        def.run(tx, i, {});\n      } catch (e) {\n        if ((e as { code?: unknown }).code === undefined) throw e;\n      }\n      out.items += 1;",
  },
  {
    name: "M6-51 S11a: a resync passes the pull's check",
    file: "src/ops/privacyCheck.ts",
    from: "        !resync && !holdsText(pulled, input.text),",
    to: "        !holdsText(pulled, input.text),",
  },
  {
    name: "M6-52 S11b: Litestream's local state is not scanned",
    file: "src/ops/privacyCheck.ts",
    from: "  if (existsSync(shadow)) {",
    to: "  if (false && existsSync(shadow)) {",
  },
  {
    name: "M6-53 S12: a pre-stage refusal has the default message",
    file: "src/middleware/rateLimit.ts",
    from: "      return left.allowed ? true : preLimitMessage(limit, spec, left.retryAfter);",
    to: '      return left.allowed ? true : "Too many requests from your account. Try again in a minute.";',
  },
  {
    name: "M6-54 S1f: kept branches keep their runs and turns",
    file: "../db/src/repos/accountSpaces.ts",
    from: '  for (const r of tx.list("run", { u })) dropRuns(tx, r.th, [r]);\n',
    to: "",
  },
  // ---- M5b client review, CD6: the `detail` of a `key` failure ----
  {
    name: "M5b-CD6a a 403 is recorded as a rejected key",
    file: "src/runs/loop.ts",
    from: 'fail: { why: "key", detail: rejected ? "key_rejected" : "key_forbidden" },',
    to: 'fail: { why: "key", detail: "key_rejected" },',
  },
  {
    name: "M5b-CD6b the run record drops the key failure's detail",
    file: "src/runs/recordStore.ts",
    from: '    ...(fail.why === "key" ? { detail: fail.detail } : {}),\n',
    to: "",
  },
  // ---- the M6 tail: C12's removal result, C18's ban record ----
  {
    name: "M6-55 C12: a removal of a person who had left answers removed: true",
    file: "../mutators/src/members.ts",
    from: '      if (m?.kind !== "member") return { removed: false };',
    to: '      if (m?.kind !== "member") return { removed: true };',
  },
  {
    name: "M6-56 C12: a removal that acted answers null",
    file: "../mutators/src/members.ts",
    from: "      refreshSpace(tx, i.space, -1);\n      return { removed: true };",
    to: "      refreshSpace(tx, i.space, -1);\n      return null;",
  },
  {
    name: "M6-57 C18: a ban is not in the banned person's user log",
    file: "../mutators/src/records.ts",
    from: '    case "request":\n    case "ban":\n    case "save":',
    to: '    case "request":\n    case "save":',
  },
  {
    name: "M6-58 C18: the banned person may not read their ban",
    file: "../mutators/src/access.ts",
    from: '    case "request":\n    case "ban":\n      return own || (sp !== null && isOwnerOf(g, sp, u));\n    case "invite":',
    to: '    case "request":\n      return own || (sp !== null && isOwnerOf(g, sp, u));\n    case "ban":\n    case "invite":',
  },
  {
    name: "M6-59 C18: anyone who reads a space reads its bans",
    file: "../mutators/src/access.ts",
    from: '    case "request":\n    case "ban":\n      return own || (sp !== null && isOwnerOf(g, sp, u));',
    to: '    case "ban":\n      return own || (sp !== null && readsSpace(g, sp, u));\n    case "request":\n      return own || (sp !== null && isOwnerOf(g, sp, u));',
  },
];

/** The tests that must fail for a mutation to count as killed, by id: the
 * start of each test's title. The runner runs only these (AVA `--match`, in
 * the files whose source holds the title), in the server's suite or, with
 * `in`, in that package's own; a mutation is killed only when one of them
 * fails. A failure of another test does not count, and a mutation without
 * an entry is refused by `--check`. */
const EXPECTED: Record<string, { in?: "db" | "sync" | "mutators"; tests: string[] }> = {
  X1: {
    tests: [
      "a ban stops every write in its space",
      "writes match the write oracle and replicas the read oracle after every step",
    ],
  },
  X3: { tests: ["writes match the write oracle and replicas the read oracle after every step"] },
  X4: { tests: ["writes match the write oracle and replicas the read oracle after every step"] },
  X5: { tests: ["each client's last processed seq comes back with its own reads only"] },
  X6: { tests: ["invite codes are made by the server"] },
  X7: { tests: ["joining by invite needs the server's code"] },
  X8: { tests: ["lists come in the server's creation order"] },
  X10: { tests: ["writes match the write oracle and replicas the read oracle after every step"] },
  X12: { tests: ["a replay within 7 days answers the stored result"] },
  X13: {
    tests: [
      "a private space serves a save count of 3 or more only",
      "writes match the write oracle and replicas the read oracle after every step",
    ],
  },
  X14: { tests: ["hiding and removing redact every text field"] },
  X18: {
    tests: [
      "a hidden node hides the answer of the thread opened from it",
      "hidden nodes, answers, replies and comments lose their text",
    ],
  },
  X20: { tests: ["mutators read no clock"] },
  X21: {
    tests: [
      "a forged cursor resyncs",
      "a token of another reader, another log or another server resyncs",
    ],
  },
  X23: { tests: ["a queued show or edit acts only on the state it was made from"] },
  X24: { tests: ["R1b: a removal queued before a person was removed"] },
  X26: { tests: ["no client holds a record another person could read"] },
  X27: { tests: ["R8: a pre-check that fails because", "R8: a fault that is not a refusal"] },
  X29: {
    tests: [
      "the server refuses an online-only write that waited in an outbox",
      "writes match the write oracle and replicas the read oracle after every step",
    ],
  },
  X30: { tests: ["writes match the write oracle and replicas the read oracle after every step"] },
  N2: {
    tests: [
      "a token of another reader, another log or another server resyncs",
      "writes match the write oracle and replicas the read oracle after every step",
    ],
  },
  N3: {
    tests: [
      "a token of another reader, another log or another server resyncs",
      "writes match the write oracle and replicas the read oracle after every step",
    ],
  },
  N4: {
    tests: [
      "a log whose history was replaced resyncs every reader",
      "a cursor from before the log's history was replaced",
    ],
  },
  N5: {
    tests: [
      "a forged cursor resyncs",
      "writes match the write oracle and replicas the read oracle after every step",
    ],
  },
  N6: { tests: ["a log whose history was replaced resyncs every reader"] },
  N7: {
    tests: ["R4a: a removed member's user log", "R4c: notifications leave a member's user log"],
  },
  N8: { tests: ["R1: a record written again at a deleted key"] },
  N10: {
    tests: ["a failed request leaves the write Not sent", "a write in flight is not dropped"],
  },
  N12: { tests: ["an expired invite link is refused at apply time"] },
  N16: { tests: ["a queue_full refusal is recorded"] },
  N21: { tests: ["R4a: a removed member's user log"] },
  N22: {
    tests: [
      "a write the actor's role forbids is refused",
      "writes match the write oracle and replicas the read oracle after every step",
    ],
  },
  N24: { tests: ["E1: a write that notifies several people"] },
  N25: { tests: ["R1: a record written again at a deleted key"] },
  N30: { tests: ["a cursor from before the log's history was replaced"] },
  N31: { tests: ["a forged cursor resyncs"] },
  N33: { tests: ["R12: a snapshot and then pulls on a server quiet"] },
  N34: { tests: ["the cursor key is 32 bytes of base64"] },
  "R2-1": { tests: ["R2: a queued 'shown' does not publish text"] },
  "R2-3": {
    tests: ["writes match the write oracle and replicas the read oracle after every step"],
  },
  "R2-4": {
    tests: ["writes match the write oracle and replicas the read oracle after every step"],
  },
  "R2-7": {
    tests: ["writes match the write oracle and replicas the read oracle after every step"],
  },
  "R2-9": {
    tests: [
      "S2: reads keep no state",
      "writes match the write oracle and replicas the read oracle after every step",
    ],
  },
  "R2-18": {
    tests: ["writes match the write oracle and replicas the read oracle after every step"],
  },
  "R2-19": {
    tests: [
      "writes match the write oracle and replicas the read oracle after every step",
      "Q2: every exception in apply is answered",
    ],
  },
  "R2-21": {
    tests: ["writes match the write oracle and replicas the read oracle after every step"],
  },
  "R2-24": { tests: ["space ids are ULIDs and names are unique"] },
  "R2-20": { tests: ["Q2: every exception in apply is answered"] },
  X19: { tests: ["every tombstone is pruned after 30 days"] },
  N15: { tests: ["answers under (client, seq) expire after 7 days"] },
  N20: { tests: ["S2: reads keep no state"] },
  N29: { tests: ["N29: a deleted record's id is never used again"] },
  N9: { tests: ["R5: a removed thread's text is in no value at rest"] },
  "R2-22": { tests: ["S2: reads keep no state"] },
  "M3-1": { tests: ["S1: a request without Session-Protocol"] },
  "M3-2": { tests: ["A3: a batch of n envelopes counts n writes"] },
  "M3-3": { tests: ["S5: envelopes after SIGTERM's drain"] },
  "M3-4": { tests: ["Y7: two readers with different scopes"] },
  "M3-5": { tests: ["Y7: a reconnect with the last event id loses no change"] },
  "M3-6": {
    in: "db",
    tests: ["D2: a fault inside a nested serverApply", "sync review-m2 17 on SqliteStore"],
  },
  "M3-7": { tests: ["a read carries no version"] },
  "M3-8": { tests: ["boot: a restored database file"] },
  "M3-9": { tests: ["boot: the restore check, open usage rows"] },
  "M3-10": { tests: ["the SQLite ledger answers as the in-memory one"] },
  "M3-11": { tests: ["K5: usage.listRuns reads each run's question"] },
  "M3-12": { in: "db", tests: ["D3: no row of a server-only table"] },
  "M3-13": { in: "db", tests: ["D4: a removed thread's text is in neither"] },
  "M3-14": { tests: ["boot: the restore check, open usage rows"] },
  "M3-15": { tests: ["Y7: a reconnect with the last event id loses no change"] },
  "M3-16": { tests: ["A3: a person has at most SESSION_LIMIT_STREAMS_PER_USER streams"] },
  "M3-17": { tests: ["a chunked body past the limit"] },
  "M3-18": { tests: ["a chunked body past the limit"] },
  "M3-19": { tests: ["open() removes the client id's older stream at once"] },
  "M3-20": { tests: ["a stream whose client stops reading"] },
  "M3-21": { tests: ["the queue is bounded in bytes"] },
  "M3-22": { tests: ["a resync event's id holds the other logs' cursors"] },
  "M3-23": { tests: ["the session check ends a stream whose session expired"] },
  "M3-24": { tests: ["apply and tRPC mutations take from one writes bucket"] },
  "M3-25": { tests: ["signed-out pulls and snapshots share"] },
  "M3-26": { tests: ["S1: writing needs a session"] },
  "M3-27": { tests: ["opening a stream takes from a per-person bucket"] },
  "M3-28": { tests: ["spaces.directory and spaces.byName are limited"] },
  "M3-29": { tests: ["spaces.directory and spaces.byName are limited"] },
  "M3-30": { tests: ["the CSRF guard and the Authorization refusal read the decoded path"] },
  "M3-31": { tests: ["a body of null"] },
  "M3-32": { tests: ["a body of null"] },
  "M3-33": { tests: ["an event id opens for its reader only"] },
  "M3-34": { tests: ["a stream reads at most 64 logs"] },
  "M3-35": { tests: ["SESSION_CURSOR_KEY_ROTATED_AT is a strict ISO time"] },
  "M3-36": { tests: ["SESSION_CURSOR_KEY_ROTATED_AT is a strict ISO time"] },
  "M3-37": { tests: ["production refuses the development cursor key"] },
  "M3-38": { tests: ["a cursor key is strict base64"] },
  "M3-39": { tests: ["the window and size settings have upper bounds"] },
  "M3-40": { tests: ["boot warns when the development cursor key"] },
  "M3-41": { tests: ["the test routes are absent unless SESSION_TEST_ROUTES"] },
  "M3-42": { tests: ["SESSION_TEST_ROUTES needs NODE_ENV=test"] },
  "M3-43": { tests: ["an envelope's protocolVersion is checked against SESSION_MIN_PROTOCOL"] },
  "M3-44": { tests: ["a read request names each log once"] },
  "M3-45": { tests: ["a read request past its work budget"] },
  "M3-46": { tests: ["a threads-only read takes one token"] },
  "M3-47": { tests: ["a threads-only read takes one token"] },
  "M3-48": { tests: ["a read request yields to the event loop"] },
  "M3-49": { tests: ["a threads read reads the thread index"] },
  "M3-50": { tests: ["a read that fails answers INTERNAL_SERVER_ERROR"] },
  "M3-51": { tests: ["byName over the store"] },
  "M3-52": { tests: ["the directory over the store"] },
  "M3-53": { tests: ["the directory over the store"] },
  "M3-54": { in: "db", tests: ["D6: a restore resyncs a log with no rows"] },
  "M3-55": { in: "db", tests: ["D6: an operator's request"] },
  "M3-56": { in: "db", tests: ["D4: a removal's commit checkpoints the WAL itself"] },
  "M3-57": { in: "db", tests: ["D7: a backfill reads a stored shape the current schema refuses"] },
  "M3-58": { in: "db", tests: ["the outermost transaction takes the write lock"] },
  "M3-59": { in: "db", tests: ["a read-only connection's store reads"] },
  "M3-60": { tests: ["a server killed at a store write inside the commit"] },
  "M3-61": { in: "db", tests: ["a record put with no creation version"] },
  "M3-62": { in: "db", tests: ["a tombstone keeps who deleted the record"] },
  "M3-63": { in: "db", tests: ["Y8 on SqliteStore: moderation log entries"] },
  "M3-64": { in: "db", tests: ["the record cache holds cacheSize records"] },
  "M3-65": { tests: ["SESSION_WEB_SUMMARY_DAYS bounds"] },
  "M3-66": { tests: ["a private channel's thread reaches a member"] },
  "M3-67": { tests: ["a summary holds no replies"] },
  "M3-68": { tests: ["a pull in a read request carries the caller's client id"] },
  "M3-69": { tests: ["closeServer closes a connection that never ends"] },
  "M3-70": { tests: ["during the drain"] },
  "M3-71": { tests: ["a client id idle past its lifetime"] },
  "M3-72": { tests: ["after a resync a stream is unsubscribed"] },
  "M3-73": { tests: ["the session check ends a stream"] },
  "M3-74": { tests: ["boot: the restore check, open usage rows"] },
  "M3-75": { tests: ["Y3: a re-attach returns the stored lastSeq"] },
  "M3-76": { tests: ["spaces.threadSpace answers a thread's channel"] },
  "M5a-1": { tests: ["E4: Stop then Run again within one millisecond"] },
  "M5a-2": { tests: ["E2: two dispatchers racing for one queued run"] },
  "M5a-3": { tests: ["G8: an asker removed from a private channel while queued"] },
  "M5a-4": { tests: ["delete (G6): deleting a running node someone commented under"] },
  "M5a-5": { tests: ["a ban while the member's run streams"] },
  "M5a-6": { tests: ["E2: an ask is claimed, commits a turn per step"] },
  "M5a-7a": { tests: ["T2: a private channel's deltas reach its members only"] },
  "M5a-7b": { tests: ["T2: a hidden ask's deltas reach its author"] },
  "M5a-8": { tests: ["T2: a private channel's deltas reach its members only"] },
  "M5a-9": { tests: ["a crash leaves the run running and its row open"] },
  "M5a-10": { tests: ["cancel: Stop aborts the stream"] },
  "M5a-11a": { tests: ["E1: a thread removed in the second step of its run"] },
  "M5a-11b": { in: "mutators", tests: ["removing a thread or a node erases its turns"] },
  "M5a-11c": { in: "mutators", tests: ["removing a thread or a node erases its turns"] },
  "M5a-11d": { tests: ["a thread its author deletes while another member's branch runs"] },
  "M5a-12a": { in: "mutators", tests: ["a turn is read like its ask"] },
  "M5a-12b": { in: "mutators", tests: ["a turn is read like its ask"] },
  "M5a-13": { tests: ["T2: a hidden ask's deltas reach its author"] },
  "M5a-14": { tests: ["L1: the 21st queued ask is refused queue_full"] },
  "M5a-15": { tests: ["L1: the 21st queued ask is refused queue_full"] },
  "M5a-16a": { tests: ["boot resumes an interrupted attempt at most twice"] },
  "M5a-16b": { tests: ["boot resumes an interrupted attempt at most twice"] },
  "M5a-17": { tests: ["cancel: Stop aborts the stream"] },
  "M5a-18": { tests: ["E2: an ask is claimed, commits a turn per step"] },
  "M5a-19": { tests: ["E2: an ask is claimed, commits a turn per step"] },
  "M5a-20": { tests: ["K2: cached input counts at the model's ratio; the ledger keeps"] },
  "M5a-21a": { tests: ["L2: a look-up that keeps calling tools stops at 2 searches"] },
  "M5a-21b": { tests: ["L2: a look-up that keeps calling tools stops at 2 searches"] },
  "M5a-22": { tests: ["a crash leaves the run running and its row open"] },
  "M5a-23": { tests: ["E2: an ask is claimed, commits a turn per step"] },
  "M5a-24": { tests: ["T2: a private channel's deltas reach its members only"] },
  "M5a-25a": { tests: ["a drain ends the attempt interrupted"] },
  "M5a-25b": { tests: ["a drain ends the attempt interrupted"] },
  "M5a-26": { tests: ["T2: an ask hidden while its run streams keeps its answer hidden"] },
  "M5a-27": { tests: ["E4: a run's new attempt is not claimed while its older attempt"] },
  "M5a-28": { tests: ["E2: queued runs are admitted in the order they were queued"] },
  "M5a-29": { tests: ["T3: a committed step moves /live to the next turn"] },
  "M5a-30": { tests: ["T3: /live answers from the stored checkpoint"] },
  "M5a-31": { tests: ["T3: a claim of an attempt claimed before jumps its delta sequence"] },
  "M5a-32a": { tests: ["thread.running follows the root's run"] },
  "M5a-32b": { tests: ["thread.running follows the root's run"] },
  "M5a-32c": { tests: ["thread.running follows the root's run"] },
  "M5a-33": { tests: ["G7: the context of a Continue under a tool-using root"] },
  "M5a-34": { tests: ["K1: the ledger checkpoints a call's output every 2 s"] },
  "M5a-35a": { tests: ["L2: a look-up that keeps fetching stops at 2 fetches"] },
  "M5a-35b": { tests: ["L2: a look-up that keeps fetching stops at 2 fetches"] },
  "M5a-36": { tests: ["a summary snapshot holds no turn records"] },
  "M5a-37": { tests: ["E1: the fence fails for a thread written removed, gone or deleted"] },
  "M5a-38": { tests: ["T3: /live is a plain read, limited per reader"] },
  "M5a-39": { tests: ["G7: an ask hidden from the asker gives no context"] },
  "M5a-40": { tests: ["G7: an ask hidden from the asker gives no context"] },
  "M5a-41": {
    tests: [
      "thread.running follows the root's run",
      "a ban while the member's run is queued ends it failed access at its claim",
    ],
  },
  "M5a-42": { tests: ["a thread its author deletes while another member's branch runs"] },
  "M5a-43": { tests: ["a ban while the member's run streams"] },
  "M5a-44": { tests: ["delete (G6) kept as a shell"] },
  "M5a-45": { tests: ["429 after a billed step: the re-queue writes the run's tok"] },
  "M5a-46": { tests: ["the claim refused and a boot interrupt write the run's tok"] },
  "M5a-47": { tests: ["the claim refused and a boot interrupt write the run's tok"] },
  "M5a-48": { tests: ["D4: the checkpoint of a run no process is streaming"] },
  "M5a-49": { tests: ["D4: the checkpoint of a run no process is streaming"] },
  "M5a-50": { tests: ["429 after a billed step: the re-queue writes the run's tok"] },
  "M5a-51": { tests: ["D4: the checkpoint of a run no process is streaming"] },
  "M5a-52": { tests: ["D4: a re-queued run that ends at the payer re-check"] },
  "M5a-53": { tests: ["D4: boot deletes the checkpoints no run continues"] },
  "M5a-54": { tests: ["a drain while a tool call runs commits the step"] },
  "M5a-55a": { tests: ["a resume leaves out a tool call without its result"] },
  "M5a-55b": { tests: ["a resume leaves out a tool call without its result"] },
  "M5a-56": { tests: ["L2: a look-up re-queued after a 429 keeps what its earlier claim spent"] },
  "M5a-57": { tests: ["L2: a look-up re-queued after a 429 keeps what its earlier claim spent"] },
  "M5a-58": { tests: ["L1: the wall clock counts from the run's first claim"] },
  "M5a-59": { tests: ["a crash between a resume's record write and its count"] },
  "M5a-60": { tests: ["E2: queued runs are admitted in the order they were queued"] },
  "M5a-61": { tests: ["E2: queued runs are admitted in the order they were queued"] },
  "M5a-62": { tests: ["T3: a claim of an attempt claimed before jumps its delta sequence"] },
  "M5a-63": { tests: ["T3: a claim of an attempt claimed before jumps its delta sequence"] },
  "M5a-64": { tests: ["T3: /live is a plain read, limited per reader"] },
  "M5a-65": { tests: ["T3: /live is a plain read, limited per reader"] },
  "M5a-66": { tests: ["E1: a thread removed in the second step of its run"] },
  "M5b-1": {
    tests: [
      "K8: an ask while the allowance is spent is kept, its run failed tokens",
      "K8: once the allowance is spent, billing key and a valid Anthropic key pay",
    ],
  },
  "M5b-2": {
    tests: ["K8: an ask while the allowance is spent is kept, its run failed tokens"],
  },
  "M5b-3": {
    tests: ["K8: with billing pause a valid Anthropic key does not pay"],
  },
  "M5b-4": {
    in: "sync",
    tests: [
      "K8: an ask queued with tokens left and applied after they ran out is kept",
      "K8: an ask queued with tokens left and applied once the member's key pays",
    ],
  },
  "M5b-5": {
    tests: [
      "K8: an ask while the allowance is spent is kept, its run failed tokens",
      "K10: a run queued while tokens were left and claimed after they ran out ends tokens",
    ],
  },
  "M5b-6": {
    tests: [
      "K8: once the allowance is spent, billing key and a valid Anthropic key pay",
      "K10: the claim decides the payer again and writes it to the run record",
    ],
  },
  "M5b-7": {
    tests: [
      "K10: a run queued while tokens were left and claimed after they ran out ends tokens",
      "a queued run admitted after the allowance is spent ends tokens without a provider call",
    ],
  },
  "M5b-8": {
    tests: [
      "K10: the claim decides the payer again and writes it to the run record",
      "K3, K10: a run queued on the member's key before the reset is claimed on included tokens",
    ],
  },
  "M5b-9": {
    tests: [
      "K3: at the reset boundary the week's usage and its runs start again",
      "the week starts on Friday 00:00 UTC",
    ],
  },
  "M5b-10": {
    tests: ["an included run that crosses the allowance moves to the member's Anthropic key"],
  },
  "M5b-11": {
    tests: ["two concurrent runs of one member never exceed allowance plus overdraft"],
  },
  "M5b-12": {
    in: "mutators",
    tests: ["K8, K11: the payer rule for each kind of model"],
  },
  "M5b-13": {
    tests: ["K9: a key-paid run is not stopped by the overdraft limit"],
  },
  "M5b-14": {
    tests: ["K3: a member with an allowance override is metered against it"],
  },
  "M5b-15": {
    tests: ["K3: a member with an allowance override is metered against it"],
  },
  "M5b-16": {
    tests: [
      "K9, K10: an attempt re-queued by 429s after it crossed the allowance is claimed again on overdraft",
    ],
  },
  "M5b-17": {
    tests: ["K9, K10: a queued attempt with ledger rows of its own is claimed on overdraft"],
  },
  "M5b-18": {
    tests: [
      "K9, K10: a claim of an attempt that ran is admitted below the allowance plus overdraft",
    ],
  },
  "M5b-19": {
    tests: [
      "K2, K9: past the allowance plus overdraft, key-paid asks make no title or summary call",
    ],
  },
  "M5b-20": {
    tests: [
      "K2, K9: past the allowance plus overdraft, key-paid asks make no title or summary call",
    ],
  },
  "M5b-21": {
    tests: [
      "K2, K9: past the allowance plus overdraft a key-paid run makes no context summary call",
    ],
  },
  "M5b-22": {
    tests: ["K8: once the allowance is spent, billing key and a valid Anthropic key pay"],
  },
  "M5b-23": {
    tests: [
      "K1, K9: a run failed rate after a billed step has the tok and bill of its rows",
      "K1, K9: a run failed by a store write that threw has the tok and bill of its rows",
      "K1, K9: a re-claim on another payer keeps the first claim's payer in the bill",
      "K1, K9: after Run again on another payer, tok and bill cover both attempts",
    ],
  },
  "M5b-24": {
    tests: ["K1, K9: after Run again on another payer, tok and bill cover both attempts"],
  },
  "M5b-25": {
    tests: ["K8, K9: a run on the member's key moves back to included tokens at the next step"],
  },
  "M5b-26": {
    tests: ["K9: the step boundary counts the next request's input"],
  },
  "M5b-27": {
    tests: ["K4, K8: a stored key that does not open is no payer"],
  },
  "M6-8": { tests: ["P2: the job deletes comments, branches and bans of the person"] },
  "M6-9": { tests: ["P2: the job deletes comments, branches and bans of the person"] },
  "M6-10": { tests: ["P2: the job deletes comments, branches and bans of the person"] },
  "M6-11": { tests: ["B6: the frozen channels of a deleted owner"] },
  "M6-12": { tests: ["P2: the job deletes comments, branches and bans of the person"] },
  "M6-13": {
    in: "db",
    tests: ["a delete that throws an error makes the job throw and change nothing"],
  },
  "M6-14": { tests: ["limit: spaces.join, 60 an hour per user (pre)"] },
  "M6-15": { tests: ["limit: the pre-stage limits hold for their whole window"] },
  "M6-16": { tests: ["limit: the pre-stage limits hold for their whole window"] },
  "M6-17": { tests: ["limit: the pre-stage limits hold for their whole window"] },
  "M6-18": {
    in: "mutators",
    tests: ["a link no longer counts as open at its expiry time exactly"],
  },
  "M6-19": { in: "mutators", tests: ["a link stops admitting at its expiry time exactly"] },
  "M6-20": {
    in: "mutators",
    tests: ["a ban stops every write in its space, the author's own included"],
  },
  "M6-21": { tests: ["a notification that cannot be written rolls the redemption back"] },
  "M6-22": { in: "db", tests: ["an afterRedeem that throws makes activate rethrow"] },
  "M6-23": { tests: ["text left only in the WAL fails the WAL's check"] },
  "M6-24": { tests: ["after a removal the check passes for the file, the WAL and every reader"] },
  "M6-25": { tests: ["before the removal each reader's checks find the text"] },
  "M6-26": { tests: ["before the removal each reader's checks find the text"] },
  "M6-27": { tests: ["before the removal each reader's checks find the text"] },
  "M6-28": { tests: ["a removal note that quotes the text fails the notification's check"] },
  "M6-29": { tests: ["before the removal each reader's checks find the text"] },
  "M6-30": { tests: ["the script exits 1 when a check fails"] },
  "M6-31": { tests: ["a hidden thread is not removed"] },
  "M6-32": { tests: ["limit: admin.models.*, 60 a minute per site admin"] },
  "M6-33": {
    in: "mutators",
    tests: ["a reply after the recipient read the coalesced notification"],
  },
  "M6-34": {
    in: "mutators",
    tests: ["a coalesced notification carries the time of the latest write"],
  },
  "M6-35": { tests: ["the pre-stage and procedure refusals are counted per bucket"] },
  "M6-36": { tests: ["P2: no stored record and no served snapshot names the deleted person"] },
  "M6-37": { tests: ["P2: no stored record and no served snapshot names the deleted person"] },
  "M6-38": { tests: ["P2: no stored record and no served snapshot names the deleted person"] },
  "M6-39": { tests: ["P2: no stored record and no served snapshot names the deleted person"] },
  "M6-40": { tests: ["P2: no stored record and no served snapshot names the deleted person"] },
  "M6-41": { tests: ["text with quotes, a backslash and a line break is found"] },
  "M6-42": { in: "db", tests: ["the job refuses while a server's heartbeat is fresh"] },
  "M6-43": { tests: ["the job over its own connection refuses while the server runs"] },
  "M6-44": { in: "db", tests: ["the job deletes the checkpoints and resume counts"] },
  "M6-45": { in: "db", tests: ["the job deletes the account's keys"] },
  "M6-46": {
    tests: ["limit: a refused write and a write that changes nothing take no pre-stage use"],
  },
  "M6-47": { in: "mutators", tests: ["restoring a revoked link counts against the 50 open links"] },
  "M6-48": { in: "db", tests: ["a deleted save is taken off its thread's count"] },
  "M6-49": {
    in: "db",
    tests: ["a shell the person deleted earlier, with nothing left under it, goes"],
  },
  "M6-50": {
    in: "db",
    tests: ["a delete the mutator refuses makes the job throw and change nothing"],
  },
  "M6-51": { tests: ["a pull that answers resync fails its check"] },
  "M6-52": { tests: ["text in Litestream's local state beside the database fails its check"] },
  "M6-53": { tests: ["limit: the pre-stage limits hold for their whole window"] },
  "M6-54": { tests: ["P2: no stored record and no served snapshot names the deleted person"] },
  "M5b-CD6a": {
    tests: ["a 403 fails the run with the provider's message and leaves the key valid"],
  },
  "M5b-CD6b": {
    tests: ["person's key rejected mid-run: failed key, the key marked invalid, closed at 0"],
  },
  "M6-55": {
    tests: [
      "C12: members.remove answers removed: true when it removes the member, and removed: false",
    ],
  },
  "M6-56": {
    tests: [
      "C12: members.remove answers removed: true when it removes the member, and removed: false",
    ],
  },
  "M6-57": {
    tests: [
      "C18: a banned person's snapshot and pull of their user log hold their own ban",
      "a banned person's snapshots and pulls hold their own ban and no other",
    ],
  },
  "M6-58": {
    tests: [
      "C18: a banned person's snapshot and pull of their user log hold their own ban",
      "a banned person's snapshots and pulls hold their own ban and no other",
    ],
  },
  "M6-59": {
    tests: [
      "C18: a banned person's snapshot and pull of their user log hold their own ban",
      "a banned person's snapshots and pulls hold their own ban and no other",
    ],
  },
};

/** What one suite said about a mutation. */
interface SuiteResult {
  code: number;
  passed: number;
  failed: number;
  tests: string[];
}

interface Outcome {
  typecheck: string;
  /** The expected tests (`EXPECTED`), run in their suite. */
  suite: SuiteResult;
  /** Which of the failed tests are expected ones. */
  matched: string[];
}

const PKG = process.cwd();
const WEB = resolve(PKG, "../..");
/** The packages a slot copies: the server and what it imports from the
 * workspace (the server half, the store, the mutators, and the acceptance
 * suite the conformance target runs). */
const COPIED = ["mutators", "sync", "db", "replica-proto", "server"] as const;
/** Which copies each copy imports, linked in its own `node_modules`. */
const IMPORTS: Record<(typeof COPIED)[number], readonly (typeof COPIED)[number][]> = {
  mutators: [],
  sync: ["mutators"],
  db: ["mutators", "sync"],
  "replica-proto": ["mutators", "sync"],
  server: ["mutators", "sync", "db", "replica-proto"],
};

function makeSlot(root: string, n: number): string {
  const web = join(root, `slot${n}`, "web");
  mkdirSync(join(web, "packages"), { recursive: true });
  symlinkSync(join(WEB, "node_modules"), join(web, "node_modules"));
  symlinkSync(join(WEB, "tsconfig.base.json"), join(web, "tsconfig.base.json"));
  symlinkSync(join(WEB, "packages", "shared"), join(web, "packages", "shared"));
  // the scripts the server runs (the document backup) and the e2e config
  symlinkSync(join(WEB, "scripts"), join(web, "scripts"));
  for (const name of COPIED)
    cpSync(join(WEB, "packages", name), join(web, "packages", name), {
      recursive: true,
      filter: (src) => !/[/\\]node_modules$/.test(src),
    });
  for (const from of COPIED) {
    mkdirSync(join(web, "packages", from, "node_modules", "@session"), { recursive: true });
    // a package's own dependencies (a version the root does not hoist)
    const own = join(WEB, "packages", from, "node_modules");
    if (existsSync(own))
      for (const entry of readdirSync(own))
        if (entry !== "@session" && !entry.startsWith("."))
          symlinkSync(join(own, entry), join(web, "packages", from, "node_modules", entry));
    for (const name of IMPORTS[from])
      symlinkSync(
        join(web, "packages", name),
        join(web, "packages", from, "node_modules", "@session", name),
      );
  }
  return join(web, "packages", "server");
}

function sh(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    let out = "";
    const p = spawn(cmd, args, { cwd, env: { ...process.env, FORCE_COLOR: "0", ...env } });
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (out += d.toString()));
    p.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

/** The package a mutation's file is in. */
const packageOf = (m: Mutation): (typeof COPIED)[number] =>
  COPIED.find((name) => m.file.startsWith(`../${name}/`)) ?? "server";

function results(r: { code: number; out: string }): SuiteResult {
  const tests = [
    ...new Set([...r.out.matchAll(/[✘×] \[fail\]: (.+?)(?:\s{2,}|$)/gm)].map((x) => x[1] ?? "")),
  ];
  return {
    code: r.code,
    passed: [...r.out.matchAll(/(\d+) tests? passed/g)].reduce((n, x) => n + Number(x[1]), 0),
    failed: [...r.out.matchAll(/(\d+) tests? failed/g)].reduce((n, x) => n + Number(x[1]), 0),
    tests: tests.map((x) => x.slice(0, 140)),
  };
}

let sequences = "20";

/** The packages whose suites a mutation's expected tests are in. */
const SUITE_DIRS = { server: ".", db: "../db", sync: "../sync", mutators: "../mutators" } as const;

/** The test files of a suite whose source holds one of `titles`; the server's
 * conformance wrappers stand for the replica-proto test file they import. */
function filesFor(suite: keyof typeof SUITE_DIRS, titles: readonly string[]): string[] {
  const dir = resolve(PKG, SUITE_DIRS[suite], "test");
  const out = new Set<string>();
  const holds = (file: string) => {
    const text = readFileSync(file, "utf8");
    return titles.some((t) => text.includes(t));
  };
  for (const name of readdirSync(dir))
    if (name.endsWith(".test.ts") && holds(join(dir, name))) out.add(`test/${name}`);
  if (suite === "server") {
    const proto = resolve(PKG, "../replica-proto/test");
    for (const name of readdirSync(join(dir, "conformance")))
      if (name.endsWith(".test.ts")) {
        const wrapper = readFileSync(join(dir, "conformance", name), "utf8");
        const imported = /replica-proto\/test\/([\w-]+\.test)"/.exec(wrapper)?.[1];
        // the batched convergence wrapper runs the same file again: one is enough
        if (imported && !name.includes("batched") && holds(join(proto, `${imported}.ts`)))
          out.add(`test/conformance/${name}`);
      }
  }
  return [...out].sort();
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
    const name = packageOf(m);
    const pkg = name === "server" ? dir : join(dir, "..", name);
    const tc = await sh("npx", ["tsc", "-p", "tsconfig.test.json", "--noEmit"], pkg);
    const expected = EXPECTED[idOf(m)] ?? { tests: [] };
    const suiteName = expected.in ?? "server";
    const files = filesFor(suiteName, expected.tests);
    const suiteDir = suiteName === "server" ? dir : join(dir, SUITE_DIRS[suiteName]);
    const suite = results(
      await sh(
        "npx",
        [
          "ava",
          "--fail-fast",
          "--timeout=600s",
          ...expected.tests.flatMap((t) => ["--match", `${t.replace(/\*/g, "\\*")}*`]),
          ...files,
        ],
        suiteDir,
        { SESSION_CONFORMANCE: "1", REPLICA_PROTO_SEQUENCES: sequences },
      ),
    );
    return {
      typecheck: tc.code === 0 ? "ok" : (tc.out.split("\n")[0] ?? "failed"),
      suite,
      matched: suite.tests.filter((t) => expected.tests.some((e) => t.includes(e))),
    };
  } finally {
    writeFileSync(file, original);
  }
}

/** Killed: one of the mutation's expected tests failed. */
const killed = (o: Outcome) => o.matched.length > 0;

const idOf = (m: Mutation) => m.name.split(" ")[0] ?? "";
const selects = (arg: string, m: Mutation) =>
  arg.endsWith("*") ? idOf(m).startsWith(arg.slice(0, -1)) : idOf(m) === arg;

const args = process.argv.slice(2);
const ids = MUTATIONS.map(idOf);
const dup = ids.find((x, k) => ids.indexOf(x) !== k);
if (dup) throw new Error(`two mutations have the id ${dup}`);
if (args.includes("--list")) {
  for (const m of MUTATIONS) console.log(`${m.name}  (${m.file})`);
  console.log("\nnot applicable:");
  for (const [id, why] of NOT_APPLICABLE) console.log(`${id}: ${why}`);
  process.exit(0);
}
if (args.includes("--check")) {
  const problems: string[] = [];
  for (const m of MUTATIONS) {
    for (const e of edits(m)) {
      const n = readFileSync(m.file, "utf8").split(e.from).length - 1;
      if (n !== 1) problems.push(`${m.name}: ${n} matches in ${m.file}`);
    }
    const expected = EXPECTED[idOf(m)];
    if (!expected?.tests.length) problems.push(`${m.name}: no expected test`);
    else
      for (const t of expected.tests)
        if (!filesFor(expected.in ?? "server", [t]).length)
          problems.push(`${m.name}: no test file holds "${t}"`);
  }
  for (const id of Object.keys(EXPECTED))
    if (!MUTATIONS.some((m) => idOf(m) === id))
      problems.push(`${id}: expected tests of no mutation`);
  if (problems.length) throw new Error(problems.join("\n"));
  console.log(`${MUTATIONS.length} patterns found, each with its expected tests`);
  process.exit(0);
}
const option = (flag: string) => {
  const k = args.indexOf(flag);
  return k >= 0 ? args[k + 1] : undefined;
};
const slots = Number(option("--slots") ?? 2);
sequences = option("--sequences") ?? sequences;
const only = args.filter(
  (a, i) => !a.startsWith("--") && !["--slots", "--sequences"].includes(args[i - 1] ?? ""),
);
const todo = MUTATIONS.filter((m) => !only.length || only.some((o) => selects(o, m)));
if (only.length && !todo.length) throw new Error(`no mutation has the ids ${only.join(" ")}`);
const root = mkdtempSync(join(tmpdir(), "server-mutate-"));
let survived = 0;
try {
  const dirs = Array.from({ length: Math.min(slots, todo.length) }, (_, n) => makeSlot(root, n));
  // the suite passes on the unchanged copy, or no mutation can be judged
  if (!args.includes("--no-baseline")) {
    const run = await sh("npx", ["ava", "--fail-fast", "--concurrency", "2"], dirs[0] ?? "", {
      SESSION_CONFORMANCE: "1",
      REPLICA_PROTO_SEQUENCES: sequences,
    });
    const base = results(run);
    if (base.failed > 0 || base.passed === 0)
      throw new Error(
        `the unchanged copy fails its suite: ${JSON.stringify(base)}\n${run.out.slice(-3000)}`,
      );
    console.log(`baseline: ${base.passed} tests passed`);
  }
  const queue = [...todo];
  await Promise.all(
    dirs.map(async (dir) => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        const started = Date.now();
        const o = await run(m, dir);
        // no expected test ran: the set names a test that is not there
        const broken = o.suite.passed + o.suite.failed === 0;
        const dead = killed(o);
        if (!dead) survived++;
        console.log(
          `${broken ? "BROKEN  " : dead ? "killed  " : "SURVIVED"} ${m.name} (${Math.round((Date.now() - started) / 1000)} s): ${JSON.stringify(o)}`,
        );
      }
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(survived ? `${survived} mutations survived` : "every mutation was killed");
process.exitCode = survived ? 1 : 0;
