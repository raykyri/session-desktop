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
// reviews, so that each fix's test is shown to fail without it.
//
// A mutation is killed only when one of its expected tests fails
// (`EXPECTED`): the runner runs those tests alone, with AVA's `--match`, in
// the test files whose source holds their titles, in the server's suite or
// in the package named by `in` (the restore check, the store's own faults).
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
    from: '      queueRun(tx, run, tx.byKey(threadKey(i.id)) as ThreadRec, "r", i.model, i.effort);',
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
    from: '    .use(limit("directory", "userOrIp"))',
    to: "",
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
  },
];

/** The tests that must fail for a mutation to count as killed, by id: the
 * start of each test's title. The runner runs only these (AVA `--match`, in
 * the files whose source holds the title), in the server's suite or, with
 * `in`, in that package's own; a mutation is killed only when one of them
 * fails. A failure of another test does not count, and a mutation without
 * an entry is refused by `--check`. */
const EXPECTED: Record<string, { in?: "db" | "sync"; tests: string[] }> = {
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
  N29: {
    tests: [
      "timeout: the stream is aborted and the row closes",
      "R1: a record written again at a deleted key",
    ],
  },
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
  "M3-19": { tests: ["a client id's replaced stream leaves the hub"] },
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
const SUITE_DIRS = { server: ".", db: "../db", sync: "../sync" } as const;

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
