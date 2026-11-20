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
}

const edits = (m: Mutation) => [{ from: m.from, to: m.to }, ...(m.also ?? [])];

const MUTATIONS: Mutation[] = [
  // ---- review round 1 ----
  {
    name: "X1 a ban keeps the membership",
    file: "src/mutators.ts",
    from: "      if (tx.get(memberKey(i.space, i.user))) tx.del(memberKey(i.space, i.user));\n      if (!tx.get(banKey",
    to: "      if (!tx.get(banKey",
  },
  {
    name: "X3 an author's delete keeps the text",
    file: "src/mutators.ts",
    from: '        q: "",\n        t: null,\n        edited: false,',
    to: "        edited: false,",
  },
  {
    name: "X4 a hidden thread keeps its title and summary",
    file: "src/access.ts",
    from: "        t: null,\n        sum: null,\n        u: r.mod",
    to: "        u: r.mod",
  },
  {
    name: "X5 lastSeq of anyone's client",
    file: "src/server.ts",
    from: "    if (!c || c.u !== u) return null;\n    this.touch(clientId, c, now);",
    to: "    if (!c) return null;\n    this.touch(clientId, c, now);",
  },
  {
    name: "X6 the invite code is taken from the client's id",
    file: "src/mutators.ts",
    from: "    pre: (ctx) => {\n      const B32",
    to: "    pre: (ctx, i) => {\n      if (i.id) return { code: i.id.toLowerCase() };\n      const B32",
  },
  {
    name: "X7 an invite link is not used up",
    file: "src/mutators.ts",
    from: 'if (link) tx.put({ ...link, dead: "Used", usedBy: tx.me });',
    to: "",
  },
  {
    name: "X8 a snapshot sorted by key only",
    file: "src/server.ts",
    from: "      return x < y ? -1 : x > y ? 1 : born(a.key) - born(b.key);",
    to: "      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;",
  },
  {
    name: "X10 a del sent for tombstones the reader may not read",
    file: "src/server.ts",
    from: "return t && readsAudience(this.store, t, u) ? true : null;",
    to: "return t ? true : null;",
  },
  {
    name: "X12 idempotency kept 5 days",
    file: "src/server.ts",
    from: "export const DEDUP_TTL = 7 * DAY;",
    to: "export const DEDUP_TTL = 5 * DAY;",
  },
  {
    // likes are gone (`01` C1); the count is the saves' now
    name: "X13 a save counts twice",
    file: "src/mutators.ts",
    from: 'const n = tx.find("save", (x) => x.th === th).length;',
    to: 'const n = 2 * tx.find("save", (x) => x.th === th).length;',
  },
  {
    name: "X14 a removal keeps the title and summary",
    file: "src/mutators.ts",
    from: '        q: "",\n        t: null,\n        sum: null,\n        running: false,',
    to: '        q: "",\n        running: false,',
  },
  {
    name: "X16 an approval ignores the ban",
    file: "src/mutators.ts",
    from: '          if (bannedFrom(tx, i.space, u))\n            throw refuse("PRECONDITION_FAILED", "This person is banned from the space.");\n',
    to: "",
  },
  {
    // a follow-up's answer is the node's `answer` record now (`01` C3)
    name: "X18 a hidden node's answer keeps its text",
    file: "src/access.ts",
    from: 'return { ...r, md: "", pages: [] } satisfies AnswerRec;',
    to: "return r;",
  },
  {
    // follow-ups are nodes now (`01` U6)
    name: "X19 node tombstones are never pruned",
    file: "src/server.ts",
    from: "      if (t.at >= cutoff) break;\n      this.tombs.delete(key);",
    to: '      if (t.at >= cutoff) break;\n      if (t.kind !== "node") this.tombs.delete(key);',
  },
  {
    name: "X20 threads.delete gets kept wrong",
    file: "src/mutators.ts",
    from: "      const kept = counts.r > 0;\n",
    to: "      const kept = counts.r > 1;\n",
  },
  {
    // round 1's fault was a version that showed the server's head. Versions
    // are sealed in tokens now; the same leak is a token in the clear.
    name: "X21 a cursor token is not encrypted",
    file: "src/server.ts",
    from: '    const body = Buffer.concat([cipher.update(plain), cipher.final()]);\n    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");',
    to: '    void cipher;\n    return Buffer.concat([iv, plain, Buffer.alloc(TOKEN_TAG)]).toString("base64url");',
    also: [
      {
        from: '      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, TOKEN_IV));\n      decipher.setAuthTag(raw.subarray(raw.length - TOKEN_TAG));\n      plain = Buffer.concat([\n        decipher.update(raw.subarray(TOKEN_IV, raw.length - TOKEN_TAG)),\n        decipher.final(),\n      ]);',
        to: "      void createDecipheriv;\n      plain = raw.subarray(TOKEN_IV, raw.length - TOKEN_TAG);",
      },
    ],
  },
  {
    name: "X22 an approval ignores the request's rev",
    file: "src/mutators.ts",
    from: '        if (i.decision !== "decline" && r.rev !== i.base[u]) throw stale();\n',
    to: "",
  },
  {
    name: "X23 a 'shown' ignores the item's rev",
    file: "src/mutators.ts",
    from: '      if (i.decision === "shown" && r.rev !== i.base?.rev) throw stale();\n',
    to: "",
  },
  {
    // the member record's rev became the admission id (round 2, decision 2)
    name: "X24 a removal ignores the admission id",
    file: "src/mutators.ts",
    from: "      if (m.adm !== i.base.adm) throw stale();\n",
    to: "",
  },
  {
    name: "X25 a tombstone keeps the whole record",
    file: "src/server.ts",
    from: "const tomb: Tombstone = { key, ...audience(this, old), at };",
    to: "const tomb = { ...old, key, ...audience(this, old), at } as Tombstone;",
  },
  {
    // likes are gone; saves and notifications share the rule
    name: "X26 saves and notifications ignore access to their space",
    file: "src/access.ts",
    from: "      return own && (sp === null || readsSpace(g, sp, u));",
    to: "      return own;",
  },
  {
    name: "X27 INTERNAL_SERVER_ERROR is recorded",
    file: "src/contract.ts",
    from: '  "INTERNAL_SERVER_ERROR",\n  "TOO_LARGE",\n]);',
    to: '  "TOO_LARGE",\n]);',
  },
  {
    name: "X28 the client does not follow OUT_OF_ORDER's expected seq",
    file: "src/client.ts",
    from: 'code === "OUT_OF_ORDER" && expectedSeq !== undefined',
    to: 'code === "OUT_OF_ORDER" && expectedSeq === -1',
  },
  {
    // an online-only write that waited was a recorded refusal in round 1's
    // fault; it is one now (EXPIRED), so the fault is that it is applied
    name: "X29 an online-only write that waited in an outbox is applied",
    file: "src/server.ts",
    from: "      if (def.online && m.clientTime - ulidTime(m.mutationId) > ONLINE_MAX_AGE)",
    to: "      if (def.online && m.clientTime - ulidTime(m.mutationId) > 1000 * ONLINE_MAX_AGE)",
  },
  {
    name: "X30 a cursor's age is not checked",
    file: "src/server.ts",
    from: "      c.at < now - TOMBSTONE_TTL\n",
    to: "      false\n",
  },
  {
    name: "X31 the client drops a write after a transient answer",
    file: "src/client.ts",
    from: "          p.notBefore = now + Math.min(RETRY_MAX, RETRY_MIN * 2 ** (p.attempts - 1));\n          break;",
    to: "          this.outbox.shift();\n          break;",
  },
  // ---- review round 2 ----
  // N1 (a pull moves its version past rows the reader may not read) is not a
  // fault any more: the version is sealed in the token, and a row the reader
  // may not read becomes readable only by a change of scope (a resync) or by
  // being written again (a new version). It is left out.
  {
    name: "N2 a token is accepted from another reader",
    file: "src/server.ts",
    from: "      c.u !== u ||\n",
    to: "",
  },
  {
    name: "N3 a token is accepted for another log",
    file: "src/server.ts",
    from: "      c.log !== log ||\n",
    to: "",
  },
  {
    name: "N4 a token is accepted after the log's history was replaced",
    file: "src/server.ts",
    from: "      c.n !== this.store.epoch(log).n ||\n",
    to: "",
  },
  {
    // round 2: a version-0 cursor's made-up epoch was accepted. The analog:
    // a token that does not open is read as one at version 0
    name: "N5 a token that does not open counts as version 0",
    file: "src/server.ts",
    from: "    const c = this.tokens.open(cursor);\n",
    to: "    const c = this.tokens.open(cursor) ?? { log, u, n: this.store.epoch(log).n, v: 0, h: 0, at: now };\n",
  },
  {
    name: "N6 user log: a space opening or closing is not noticed",
    file: "src/server.ts",
    from: "      if (a && a.sp !== null && this.store.epoch(`space:${a.sp}`).start > head) return true;",
    to: "      if (a && a.sp !== null && this.store.epoch(`space:${a.sp}`).start > head + 1e9) return true;",
  },
  {
    name: "N7 user log: a membership change is not noticed",
    file: "src/server.ts",
    from: '      if (row.key.startsWith("member:") && row.version > version) return true;\n',
    to: "",
  },
  {
    name: "N8 a record written again at a deleted key restarts at rev 1",
    file: "src/server.ts",
    from: "const rev = (prev?.rev ?? this.registry.get(reg) ?? 0) + 1;",
    to: "const rev = (prev?.rev ?? 0) + 1;",
  },
  {
    name: "N9 a finished run writes text to a removed item",
    file: "src/server.ts",
    from: 'if (!r || !("mod" in r) || r.mod === "removed") return false;',
    to: 'if (!r || !("mod" in r)) return false;',
  },
  {
    name: "N10 TOO_MANY_REQUESTS and SERVICE_UNAVAILABLE are recorded",
    file: "src/contract.ts",
    from: '  "TOO_MANY_REQUESTS",\n  "SERVICE_UNAVAILABLE",\n',
    to: "",
  },
  {
    name: "N12 an invite link ignores its expiry",
    file: "src/mutators.ts",
    from: "        link.dead === null &&\n        Date.parse(link.expiresAt) > Date.parse(tx.now);",
    to: "        link.dead === null;",
  },
  {
    name: "N15 answers under (client, seq) are never expired",
    file: "src/server.ts",
    from: "      if (a.at > now - DEDUP_TTL) break;\n      this.seqAnswers.delete(k);",
    to: "      if (a.at > now - DEDUP_TTL * 1000) break;\n      this.seqAnswers.delete(k);",
  },
  {
    // the job effect is gone: the run record with status `queued` is the
    // run queue (`01` U6), so the same fault is that record not written
    name: "N16 an ask's queued run is not written",
    file: "src/mutators.ts",
    from: "(`03` E2)\n      const run = tx.id(1);\n      tx.create({",
    to: "(`03` E2)\n      const run = tx.id(1);\n      void ({",
  },
  {
    // the served-cursor table is gone (decision 1); the table that grows
    // with callers now is the client records
    name: "N20 client records are never expired",
    file: "src/server.ts",
    from: "      if (c.seen > now - CLIENT_IDLE_TTL) break;\n      this.clients.delete(id);",
    to: "      if (c.seen > now - CLIENT_IDLE_TTL * 1000) break;\n      this.clients.delete(id);",
  },
  {
    // likes are gone; notifications follow the same rule as saves
    name: "N21 a save or notification tombstone is served to its person whatever their access",
    file: "src/server.ts",
    from: "    return t && readsAudience(this.store, t, u) ? true : null;",
    to: '    return t &&\n      (readsAudience(this.store, t, u) ||\n        ((t.kind === "save" || t.kind === "notif") && t.person === u))\n      ? true\n      : null;',
  },
  {
    // admins are gone (`01` C18): About is the owner's
    name: "N22 control: spaces.update needs only a member",
    file: "src/mutators.ts",
    from: '    who: "owner",\n    space: (_tx, i) => i.id,',
    to: '    who: "member",\n    space: (_tx, i) => i.id,',
  },
  {
    name: "N23 a decline reason survives the person asking again",
    file: "src/mutators.ts",
    from: "        why: null,\n        createdAt: old",
    to: '        why: old?.kind === "request" ? old.why : null,\n        createdAt: old',
  },
  {
    // reports are gone; the same control on a notification the notify stage
    // writes (`01` U6)
    name: "N24 control: one notification in 32 is not written",
    file: "src/mutators.ts",
    from: '    tx.create({\n      kind: "notif",',
    to: '    if (tx.id(NOTIFY_ORDINAL + this.k + 1).endsWith("0")) return;\n    tx.create({\n      kind: "notif",',
  },
  {
    // tombstones no longer hold the rev; the registry does
    name: "N25 a deleted key's rev is forgotten",
    file: "src/server.ts",
    from: "        this.born.delete(key);\n",
    to: "        this.born.delete(key);\n        this.registry.set(registryKey(old), 0);\n",
  },
  {
    name: "N26 the client keeps an expired write in the outbox",
    file: "src/client.ts",
    from: 'for (const p of [...this.outbox]) if (p.queuedAt < now - OUTBOX_TTL) this.giveUp(p, "DROPPED");',
    to: "void now;",
  },
  {
    name: "N27 the client does not remap later writes after new ids",
    file: "src/client.ts",
    from: "for (const x of this.outbox) if (!x.sent) x.input = remap(x.input, map);",
    to: "for (const x of this.outbox) if (x === this.outbox[0]) x.input = remap(x.input, map);",
  },
  {
    name: "N28 the client's seq does not follow a read's lastSeq",
    file: "src/client.ts",
    from: "    if (lastSeq !== null) this.acked = lastSeq;",
    to: "",
  },
  {
    name: "N29 a deleted record's id may be used again",
    file: "src/server.ts",
    from: "        this.born.delete(key);\n",
    to: "        this.born.delete(key);\n        const freed = idOf(old);\n        if (freed !== null) this.registry.delete(freed);\n",
  },
  {
    name: "N30 a version-0 token's history is not checked",
    file: "src/server.ts",
    from: "      c.n !== this.store.epoch(log).n ||\n",
    to: "      (c.v > 0 && c.n !== this.store.epoch(log).n) ||\n",
  },
  {
    // tokens are sealed, not counted; the same weakness is a token that does
    // not need the key to make
    name: "N31 a token opens without the key's authentication",
    file: "src/server.ts",
    from: "      decipher.setAuthTag(raw.subarray(raw.length - TOKEN_TAG));\n      plain = Buffer.concat([\n        decipher.update(raw.subarray(TOKEN_IV, raw.length - TOKEN_TAG)),\n        decipher.final(),\n      ]);",
    to: "      plain = decipher.update(raw.subarray(TOKEN_IV, raw.length - TOKEN_TAG));",
  },
  {
    name: "N33 an empty pull does not renew the token's serve time",
    file: "src/server.ts",
    from: "    return { changes, cursor: this.serve(log, u, to, now), lastSeq };",
    to: "    return { changes, cursor: this.serve(log, u, to, changes.length ? now : c.at), lastSeq };",
  },
  {
    name: "N34 the token key is a constant",
    file: "src/server.ts",
    from: "  private readonly key = randomBytes(32);",
    to: "  private readonly key = Buffer.alloc(32);",
  },
  {
    name: "R2-1 a hide or a removal is STALE after the item changed",
    file: "src/mutators.ts",
    from: '      if (i.decision === "shown" && r.rev !== i.base?.rev) throw stale();',
    to: "      if (r.rev !== i.base?.rev) throw stale();",
  },
  {
    name: "R2-2 a decline is STALE after the request changed",
    file: "src/mutators.ts",
    from: '        if (i.decision !== "decline" && r.rev !== i.base[u]) throw stale();',
    to: "        if (r.rev !== i.base[u]) throw stale();",
  },
  {
    name: "R2-3 joining an open space again keeps the admission id",
    file: "src/mutators.ts",
    from: '      addMember(tx, s.id, tx.me, "member", tx.id(1));',
    to: '      addMember(tx, s.id, tx.me, "member", `${s.id}:${tx.me}`);',
  },
  {
    // likes are gone; a save is the write that changes the counts
    name: "R2-4 a save changes the thread record",
    file: "src/mutators.ts",
    from: "  tx.put({ ...c, saves });\n}",
    to: '  tx.put({ ...c, saves });\n  const p = tx.get(threadKey(th));\n  if (p?.kind === "thread") tx.put({ ...p, tok: p.tok + 1 });\n}',
  },
  {
    name: "R2-6 the client gives a sent write new ids",
    file: "src/client.ts",
    from: "    for (const p of this.outbox) {\n      if (p.sent) continue;",
    to: "    for (const p of this.outbox) {",
  },
  {
    name: "R2-7 the server does not check a mutation id's age",
    file: "src/server.ts",
    from: '    if (!ageOk(m.mutationId, m.clientTime)) return expired("mutationId");\n',
    to: "",
  },
  {
    name: "R2-8 the learned clock offset is not saved",
    file: "src/client.ts",
    from: "      offset: this.offset,\n",
    to: "      offset: 0,\n",
  },
  {
    name: "R2-9 registrations are not limited",
    file: "src/server.ts",
    from: "      if (times.length >= REGISTRATIONS_PER_DAY)",
    to: "      if (times.length >= REGISTRATIONS_PER_DAY * 1000)",
  },
  {
    name: "R2-10 the client does not register again on WRONG_CLIENT",
    file: "src/client.ts",
    from: 'if (code === "WRONG_CLIENT" && this.ownOutbox() && fresh++ < 1) {',
    to: 'if (code === "WRONG_CLIENT" && this.ownOutbox() && fresh++ < 0) {',
  },
  {
    name: "R2-11 the client registers for another person's outbox",
    file: "src/client.ts",
    from: "    if (this.clientIdValue === null && this.ownOutbox()) {",
    to: "    if (this.clientIdValue === null) {",
    also: [
      {
        from: 'if (code === "WRONG_CLIENT" && this.ownOutbox() && fresh++ < 1) {',
        to: 'if (code === "WRONG_CLIENT" && fresh++ < 1) {',
      },
    ],
  },
  {
    name: "R2-12 the client does not back off",
    file: "src/client.ts",
    from: "      if (p.notBefore > now && p.notBefore - now <= RETRY_MAX) break;",
    to: "      if (p.notBefore > now && p.notBefore - now < 0) break;",
  },
  {
    name: "R2-13 a write that keeps failing is never given up",
    file: "src/client.ts",
    from: "          if (p.errors >= MAX_SERVER_ERRORS) {",
    to: "          if (p.errors >= MAX_SERVER_ERRORS * 1000) {",
  },
  {
    name: "R2-14 a write dropped at 3 days is not shown",
    file: "src/client.ts",
    from: 'if (p.queuedAt < now - OUTBOX_TTL) this.giveUp(p, "DROPPED");',
    to: "if (p.queuedAt < now - OUTBOX_TTL) this.outbox.splice(this.outbox.indexOf(p), 1);",
  },
  {
    name: "R2-18 an input's depth is not bounded",
    file: "src/server.ts",
    from: "    const bounds = outOfBounds(envelope, MAX_INPUT_DEPTH + 1, MAX_ENVELOPE_BYTES);",
    to: "    const bounds = outOfBounds(envelope, 1e9, MAX_ENVELOPE_BYTES);",
  },
  {
    name: "R2-19 an envelope's size is not bounded",
    file: "src/server.ts",
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
    file: "src/server.ts",
    from: "      return this.applyEnvelope(actor, envelope);\n    } catch {",
    to: "      return this.applyEnvelope(actor, envelope);\n    } catch (e) {\n      if (e) throw e;",
  },
  {
    name: "R2-21 the device's clock is not checked against the server's",
    file: "src/server.ts",
    from: "    if (Math.abs(m.clientTime - now) > CLOCK_MAX_SKEW)",
    to: "    if (Math.abs(m.clientTime - now) > 1e15)",
  },
  {
    name: "R2-22 scanStorage leaves out the client records",
    file: "src/server.ts",
    from: "      clients: [...this.clients].map(([clientId, c]) => ({ clientId, ...c })),",
    to: "      clients: [],",
  },
  {
    // the effect model's name rule is written apart from this one now
    name: "R2-24 a space name keeps a leading '-'",
    file: "src/mutators.ts",
    from: '    .replace(/[^a-z0-9-]+/g, "-")\n    .replace(/^-+/, "")',
    to: '    .replace(/[^a-z0-9-]+/g, "-")',
  },
  {
    name: "R2-23 the client gives up on a write after a lost answer",
    file: "src/client.ts",
    from: "      } catch {\n        res = noAnswer();\n      }",
    to: '      } catch {\n        res = { ok: false, error: { code: "NOT_FOUND", message: "" } };\n      }',
  },
  // ---- the build's contract (`01` U6): saves, notifications, removal,
  // owner-only writes, look-ups, counts and protocol version 4 ----
  {
    name: "U6-1 a private space serves a save count below 3",
    file: "src/mutators.ts",
    from: "  const saves = s && isClosed(s) && n < PRIVATE_SAVES_MIN ? 0 : n;",
    to: "  const saves = s ? n : n;",
  },
  {
    name: "U6-2 a removal keeps the saves of the thread",
    file: "src/mutators.ts",
    from: '      for (const x of tx.find("save", (y) => y.th === r.id)) drop(saveKey(x.u, x.th));\n',
    to: "",
  },
  {
    name: "U6-3 a removal keeps the mention notifications about the thread",
    file: "src/mutators.ts",
    from: '      for (const x of tx.find("notif", (y) => y.type === "mention" && y.th === r.id))\n        drop(`notif:${x.id}`);\n',
    to: "",
  },
  {
    name: "U6-4 a removed thread's author is served to every reader",
    file: "src/access.ts",
    from: '        u: r.mod === "removed" && !author ? null : r.u,',
    to: "        u: r.u,",
  },
  {
    name: "U6-5 a person is notified of their own action",
    file: "src/mutators.ts",
    from: "    if (to === tx.me) return;\n",
    to: "",
  },
  {
    name: "U6-6 reply, branch and comment notifications do not coalesce",
    file: "src/mutators.ts",
    from: "    if (COALESCED.has(type)) {",
    to: "    if (COALESCED.has(type) && type.length < 0) {",
  },
  {
    name: "U6-7 a mention notifies a person who is not a member",
    file: "src/mutators.ts",
    from: "if (isHandle(h) && roleIn(this.tx, sp, h) !== null)",
    to: "if (isHandle(h))",
  },
  {
    name: "U6-8 a removal writes no moderation log entry",
    file: "src/mutators.ts",
    from: "      // keeps no text of it\n      tx.create({",
    to: "      // keeps no text of it\n      void ({",
  },
  {
    name: "U6-9 a reminted envelope's answer is not stored under the ids it replaces",
    file: "src/server.ts",
    from: "if (id !== m.mutationId && !this.dedup.has(rk))",
    to: "if (id !== m.mutationId && !this.dedup.has(rk) && id.length < 0)",
  },
  {
    name: "U6-10 an envelope's queuedAt is not checked",
    file: "src/server.ts",
    from: '    if (!timeOk(m.queuedAt, m.clientTime)) return expired("queuedAt");\n',
    to: "",
  },
  {
    name: "U6-11 an oversized envelope answers BAD_REQUEST",
    file: "src/server.ts",
    from: '        refuse("TOO_LARGE", undefined, [',
    to: '        refuse("BAD_REQUEST", undefined, [',
  },
  {
    name: "U6-12 the owner may leave their space",
    file: "src/mutators.ts",
    from: '      if (isOwnerOf(tx, i.space, tx.me))\n        throw refuse("PRECONDITION_FAILED", "You own this channel: the owner can’t leave it.");\n',
    to: "",
  },
  {
    name: "U6-13 the owner may ban or remove themselves",
    file: "src/mutators.ts",
    from: '  if (u === tx.me) throw refuse("FORBIDDEN", "You can’t change your own membership here.");\n',
    to: "",
  },
  {
    name: "U6-14 hiding a node leaves its answer shown",
    file: "src/mutators.ts",
    from: '        if (a?.kind === "answer") tx.put({ ...a, mod });\n',
    to: "",
  },
  {
    name: "U6-15 a look-up stores the phrase as its prompt",
    file: "src/mutators.ts",
    from: "        q = LOOKUP_PROMPT_V1(look);",
    to: "        q = look;",
  },
  {
    name: "U6-16 a reply to a reply does not count",
    file: "src/mutators.ts",
    from: '      : tx.find("reply", (x) => x.th === th.id).length;',
    to: '      : tx.find("reply", (x) => x.th === th.id && x.parent === null).length;',
  },
  {
    name: "U6-17 a member makes channel invite links",
    file: "src/mutators.ts",
    from: '    input: M["invites.create"].input.extend({ id: ulidS, space: ulidS }).strict(),\n    who: "owner",',
    to: '    input: M["invites.create"].input.extend({ id: ulidS, space: ulidS }).strict(),\n    who: "member",',
  },
  {
    name: "U6-18 a removal's reason is not kept on the placeholder",
    file: "src/mutators.ts",
    from: "        modNote: note,",
    to: "        modNote: null,",
  },
];

interface Outcome {
  typecheck: string;
  passed: number;
  failed: number;
  tests: string[];
}

const PKG = process.cwd();
const WEB = resolve(PKG, "../..");

/** A copy of the package beside links to the workspace's modules, base
 * config and shared package, so it type-checks and runs as the package does. */
function makeSlot(root: string, n: number): string {
  const web = join(root, `slot${n}`, "web");
  mkdirSync(join(web, "packages"), { recursive: true });
  symlinkSync(join(WEB, "node_modules"), join(web, "node_modules"));
  symlinkSync(join(WEB, "tsconfig.base.json"), join(web, "tsconfig.base.json"));
  symlinkSync(join(WEB, "packages", "shared"), join(web, "packages", "shared"));
  const dir = join(web, "packages", "replica-proto");
  cpSync(PKG, dir, {
    recursive: true,
    filter: (src) => !/[/\\](node_modules|dist)$/.test(src),
  });
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
    const tc = await sh("npx", ["tsc", "-p", "tsconfig.test.json", "--noEmit"], dir);
    const ava = await sh("npx", ["ava", "--timeout=600s"], dir);
    const tests = [
      ...new Set(
        [...ava.out.matchAll(/[✘×] \[fail\]: (.+?)(?:\s{2,}|$)/gm)].map((x) => x[1] ?? ""),
      ),
    ];
    return {
      typecheck: tc.code === 0 ? "ok" : (tc.out.split("\n")[0] ?? "failed"),
      passed: Number(/(\d+) tests? passed/.exec(ava.out)?.[1] ?? 0),
      failed: Number(/(\d+) tests? failed/.exec(ava.out)?.[1] ?? 0),
      tests: tests.map((x) => x.slice(0, 140)),
    };
  } finally {
    writeFileSync(file, original);
  }
}

const args = process.argv.slice(2);
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
const todo = MUTATIONS.filter((m) => !only.length || only.some((o) => m.name.startsWith(o)));
const root = mkdtempSync(join(tmpdir(), "replica-proto-mutate-"));
let survived = 0;
try {
  const dirs = Array.from({ length: Math.min(slots, todo.length) }, (_, n) => makeSlot(root, n));
  const queue = [...todo];
  await Promise.all(
    dirs.map(async (dir) => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        const o = await run(m, dir);
        const broken = o.passed + o.failed === 0;
        if (o.failed === 0) survived++;
        console.log(
          `${broken ? "BROKEN  " : o.failed ? "killed  " : "SURVIVED"} ${m.name}: ${JSON.stringify(o)}`,
        );
      }
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(survived ? `${survived} mutations survived` : "every mutation was killed");
process.exitCode = survived ? 1 : 0;
