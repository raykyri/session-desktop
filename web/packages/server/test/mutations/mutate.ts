// The server's mutation set (`05` M3, decision E4): each mutation changes one
// place in a copy of the server half (`@session/server`, `@session/sync`,
// `@session/db`, and the `@session/mutators` the server runs), then the type
// check and the server's suite run in that copy, the acceptance suite over
// HTTP (`test/conformance/`) included. A mutation no test kills (`SURVIVED`)
// is a gap. The packages themselves are never changed.
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
// M3-1 on cover the code M3 adds (the routes,
// the event stream, the store, the ledger, boot).
//
// A suite runs with AVA's `--fail-fast`, so a killed mutation stops at its
// first failing test. A mutation whose fault the server's suite cannot reach
// (`packageOnly`: the restore check, the true save count, `secure_delete`)
// is killed by its own package's suite.

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
  packageOnly?: boolean;
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
        from: '      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, TOKEN_IV));\n      decipher.setAuthTag(raw.subarray(raw.length - TOKEN_TAG));\n      plain = Buffer.concat([\n        decipher.update(raw.subarray(TOKEN_IV, raw.length - TOKEN_TAG)),\n        decipher.final(),\n      ]);',
        to: "      void createDecipheriv;\n      void key;\n      plain = raw.subarray(TOKEN_IV, raw.length - TOKEN_TAG);",
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
    from: "      if (a && a.sp !== null && store.epoch(`space:${a.sp}`).start > head) return true;",
    to: "      if (a && a.sp !== null && store.epoch(`space:${a.sp}`).start > head + 1e9) return true;",
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
        from: "      admitted > 0\n        ? limiter.take(key, buckets.writes, admitted)",
        to: "      admitted > 0\n        ? limiter.take(key, buckets.writes, 1)",
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
    from: "      out = this.sqlite.transaction(fn)();",
    to: "      out = outer ? this.sqlite.transaction(fn)() : fn();",
  },
  {
    name: "M3-7 the rows of one commit read back by key",
    file: "../db/src/sync/store.ts",
    from: "ORDER BY version, rowid",
    to: "ORDER BY version, key",
  },
  {
    name: "M3-8 a restored database bumps no epoch",
    file: "../db/src/sync/restore.ts",
    from: "  if (current === null || previous === current) return { previous, current, bumped: 0 };",
    to: "  if (current === null || previous !== null) return { previous, current, bumped: 0 };",
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
    packageOnly: true,
  },
  {
    name: "M3-13 deleted rows are left in the file",
    file: "../db/src/connection.ts",
    from: '  client.pragma("secure_delete = ON");',
    to: '  client.pragma("secure_delete = OFF");',
    packageOnly: true,
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
    from: '        event: "changes",\n        data: JSON.stringify({ batches }),\n        id: this.#ids.seal(s.cursors),',
    to: '        event: "changes",\n        data: JSON.stringify({ batches }),\n        id: this.#ids.seal(new Map()),',
  },
  {
    name: "M3-16 a person may open any number of streams",
    file: "src/sync/routes.ts",
    from: "    if (!replacing && sync.hub.streamsOf(u) >= limits.streamsPerUser)",
    to: "    if (!replacing && sync.hub.streamsOf(u) >= Number.POSITIVE_INFINITY)",
  },
];

/** What one suite said about a mutation. */
interface SuiteResult {
  code: number;
  passed: number;
  failed: number;
  tests: string[];
}

interface Outcome {
  typecheck: string;
  /** The server's suite, the acceptance suite over HTTP included. */
  suite: SuiteResult;
  /** The suite of the package the mutation is in, when it is not this one. */
  own?: SuiteResult;
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
    const suite = results(
      await sh("npx", ["ava", "--fail-fast", "--concurrency", "2"], dir, {
        SESSION_CONFORMANCE: "1",
        REPLICA_PROTO_SEQUENCES: sequences,
      }),
    );
    const own =
      name !== "server" && suite.failed === 0
        ? results(await sh("npx", ["ava", "--fail-fast", "--timeout=600s"], pkg))
        : null;
    return {
      typecheck: tc.code === 0 ? "ok" : (tc.out.split("\n")[0] ?? "failed"),
      suite,
      ...(own ? { own } : {}),
    };
  } finally {
    writeFileSync(file, original);
  }
}

/** Killed: a test of the server's suite failed; for a `packageOnly` fault,
 * or one in another package, a test of that package's suite did. */
const killed = (o: Outcome) => o.suite.failed > 0 || (o.own?.failed ?? 0) > 0;

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
  for (const m of MUTATIONS)
    for (const e of edits(m)) {
      const n = readFileSync(m.file, "utf8").split(e.from).length - 1;
      if (n !== 1) throw new Error(`${m.name}: ${n} matches in ${m.file}`);
    }
  console.log(`${MUTATIONS.length} patterns found`);
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
