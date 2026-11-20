// Mutation runs for the suite: each mutation changes one place in `src/` of a
// copy of the package, then the type check and the whole suite run in that
// copy, and the run lists the tests that failed. A mutation no test kills is
// a gap in the suite. The package itself is never changed.
//
// Run from the package directory: `npm run mutate [-- <name prefix> ...]`,
// or `npm run mutate -- --check` to check only that every pattern matches
// once. `--slots <n>` sets how many copies run at once (default 4).
// `--since <git ref>` runs only the mutations whose file (where the run makes
// them: in the package with `--package`) changed since that ref, the working
// tree included.
//
// `--package` runs the suite with the switch on (REPLICA_PROTO_MUTATORS=
// package): the server runs `@session/mutators`. A mutation of the
// prototype's mutators or read rules is then made at the same place in the
// package (`IN_PACKAGE`), in a copy of the package beside the copy of this
// one; the other mutations are made where they are.
//
// X1 to X31 are review round 1's mutations and the ones round 1's fixes
// added, N1 to N34 review round 2's, R2-1 on cover round 2's fixes. Each
// pattern is moved with the code; the fault stays the same, or, where the
// code it named is gone, is the same fault in the code that replaced it (the
// comment says so).

import { execFileSync, spawn } from "node:child_process";
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

/** A mutation as `--package` makes it: in `file` of `@session/mutators`
 * (relative to the package directory), the same fault as the prototype's. */
interface PackageEdit {
  file: string;
  from: string;
  to: string;
}

const MUTATIONS: Mutation[] = [
  // ---- review round 1 ----
  {
    name: "X1 a ban keeps the membership",
    file: "src/mutators.ts",
    from: "      if (tx.get(memberKey(i.space, i.user))) tx.del(memberKey(i.space, i.user));\n      if (!tx.get(banKey",
    to: "      if (!tx.get(banKey",
  },
  {
    name: "X2 opening a space admits banned requesters",
    file: "src/mutators.ts",
    from: 'if (!bannedFrom(tx, s0.id, r.u)) addMember(tx, s0.id, r.u, "member", tx.id(k));',
    to: 'addMember(tx, s0.id, r.u, "member", tx.id(k));',
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
    from: 'return { ...r, q: "", t: null, sum: null } satisfies ThreadRec;',
    to: 'return { ...r, q: "" } satisfies ThreadRec;',
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
    to: "    pre: (ctx, i) => {\n      if (i.id) return { code: i.id.slice(-10).toLowerCase() };\n      const B32",
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
    name: "X9 an ownership transfer keeps the old owner",
    file: "src/mutators.ts",
    from: 'if (me?.kind === "member") tx.put({ ...me, role: "admin" });',
    to: "",
  },
  {
    name: "X10 a del sent for tombstones the reader may not read",
    file: "src/server.ts",
    from: "return t && readsAudience(this.store, t, u) ? true : null;",
    to: "return t ? true : null;",
  },
  {
    name: "X11 report notifications go to every member",
    file: "src/server.ts",
    from: '    const staff = spaceRec(this.store, effect.sp)?.mods ?? [];\n    for (const [to, role] of staff) {\n      if (role === "member") continue;',
    to: '    const staff = [...this.store.records.values()].flatMap((r) =>\n      r.kind === "member" && r.sp === effect.sp ? [[r.u, "x"] as const] : [],\n    );\n    for (const [to, role] of staff) {\n      if (role === "member") continue;',
  },
  {
    name: "X12 idempotency kept 5 days",
    file: "src/server.ts",
    from: "export const DEDUP_TTL = 7 * DAY;",
    to: "export const DEDUP_TTL = 5 * DAY;",
  },
  {
    // the count moved to the counts record (decision 4 of round 1)
    name: "X13 a like counts twice",
    file: "src/mutators.ts",
    from: "likes: Math.max(0, c.likes + (i.on ? 1 : -1))",
    to: "likes: Math.max(0, c.likes + (i.on ? 2 : -1))",
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
    name: "X18 a hidden follow-up keeps its answer",
    file: "src/access.ts",
    from: 'return { ...r, q: "", a: null } satisfies FollowUpRec;',
    to: 'return { ...r, q: "" } satisfies FollowUpRec;',
  },
  {
    name: "X19 follow-up tombstones are never pruned",
    file: "src/server.ts",
    from: "      if (t.at >= cutoff) break;\n      this.tombs.delete(key);",
    to: '      if (t.at >= cutoff) break;\n      if (t.kind !== "followup") this.tombs.delete(key);',
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
    from: '      if (i.decision === "shown" && r.rev !== i.base.rev) throw stale();\n',
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
    name: "X26 likes and saves ignore access to their space",
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
    name: "N11 a failed effect is dropped",
    file: "src/server.ts",
    from: "        if (q.attempts >= EFFECT_MAX_ATTEMPTS) {\n          this.effectQueue.splice(k, 1);\n          this.deadLetters.push({ ...q, failedAt: now });\n        } else {",
    to: "        if (q.attempts >= 1) {\n          this.effectQueue.splice(k, 1);\n        } else {",
  },
  {
    name: "N12 an invite link ignores its expiry",
    file: "src/mutators.ts",
    from: "        (link.expiresAt === null || Date.parse(link.expiresAt) > Date.parse(tx.now)) &&\n",
    to: "",
  },
  {
    name: "N13 a link's maker reads it after leaving the space",
    file: "src/access.ts",
    from: "(isModOf(g, sp, u) || (u !== null && a.by === u && roleIn(g, sp, u) !== null))",
    to: "(isModOf(g, sp, u) || (u !== null && a.by === u))",
  },
  {
    name: "N14 any settings save lets every member make invite links",
    file: "src/mutators.ts",
    from: 'invite: closed ? (set.invite ?? s0.invite ?? "mods") : null,',
    to: 'invite: closed ? "members" : null,',
  },
  {
    name: "N15 answers under (client, seq) are never expired",
    file: "src/server.ts",
    from: "      if (a.at > now - DEDUP_TTL) break;\n      this.seqAnswers.delete(k);",
    to: "      if (a.at > now - DEDUP_TTL * 1000) break;\n      this.seqAnswers.delete(k);",
  },
  {
    name: "N16 a job effect is lost",
    file: "src/server.ts",
    from: "      this.jobList.push({ kind: effect.kind, id: effect.id });\n      return;",
    to: "      return;",
  },
  {
    name: "N17 an effect that failed once runs twice",
    file: "src/server.ts",
    from: "        this.runEffect(q.effect, now);\n        this.effectQueue.splice(k, 1);\n        ran++;",
    to: "        this.runEffect(q.effect, now);\n        if (q.attempts === 1) this.effectQueue.splice(k, 1);\n        else {\n          q.attempts = 0;\n          k++;\n        }\n        ran++;",
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
    name: "N21 a like or save tombstone is served to its person whatever their access",
    file: "src/server.ts",
    from: "    return t && readsAudience(this.store, t, u) ? true : null;",
    to: '    return t &&\n      (readsAudience(this.store, t, u) ||\n        ((t.kind === "like" || t.kind === "save") && t.person === u))\n      ? true\n      : null;',
  },
  {
    name: "N22 control: spaces.update needs only a moderator",
    file: "src/mutators.ts",
    from: '    who: "admin",\n    space: (_tx, i) => i.id,',
    to: '    who: "moderator",\n    space: (_tx, i) => i.id,',
  },
  {
    name: "N23 a decline reason survives the person asking again",
    file: "src/mutators.ts",
    from: "        a,\n        why: null,\n        retryAt: null,\n        createdAt: old",
    to: '        a,\n        why: old?.kind === "request" ? old.why : null,\n        retryAt: null,\n        createdAt: old',
  },
  {
    name: "N24 control: one report in 32 notifies nobody",
    file: "src/server.ts",
    from: "    this.store.commit(staged, now);\n  }\n\n  /** Expire",
    to: "    if (effect.report.endsWith('0')) staged.clear();\n    this.store.commit(staged, now);\n  }\n\n  /** Expire",
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
  // ---- round 2's fixes ----
  {
    name: "R2-1 a hide or a removal is STALE after the item changed",
    file: "src/mutators.ts",
    from: '      if (i.decision === "shown" && r.rev !== i.base.rev) throw stale();',
    to: "      if (r.rev !== i.base.rev) throw stale();",
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
    name: "R2-4 a like changes the thread record",
    file: "src/mutators.ts",
    from: '      if (c?.kind === "counts") tx.put({ ...c, likes: Math.max(0, c.likes + (i.on ? 1 : -1)) });',
    to: '      if (c?.kind === "counts") tx.put({ ...c, likes: Math.max(0, c.likes + (i.on ? 1 : -1)) });\n      const th = tx.get(threadKey(i.thread));\n      if (th?.kind === "thread") tx.put({ ...th, tok: th.tok + 1 });',
  },
  {
    name: "R2-5 report notifications are served to people who are not staff",
    file: "src/access.ts",
    from: "      return own && sp !== null && readsSpace(g, sp, u) && isModOf(g, sp, u);",
    to: "      return own && sp !== null && readsSpace(g, sp, u);",
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
    name: "R2-15 a request runs the queued effects",
    file: "src/server.ts",
    from: "      setLast(this.dedup, dk, { result: out.result, digest: payload, at: now });\n      client.last = m.seq;\n    }",
    to: "      setLast(this.dedup, dk, { result: out.result, digest: payload, at: now });\n      client.last = m.seq;\n      this.work();\n    }",
  },
  {
    name: "R2-16 a failing effect never ends in the dead letters",
    file: "src/server.ts",
    from: "        if (q.attempts >= EFFECT_MAX_ATTEMPTS) {",
    to: "        if (q.attempts >= EFFECT_MAX_ATTEMPTS * 1000) {",
  },
  {
    name: "R2-17 a failing effect is tried again with no backoff",
    file: "src/server.ts",
    from: "          q.next = now + Math.min(EFFECT_BACKOFF_MAX, EFFECT_BACKOFF_MIN * 2 ** (q.attempts - 1));",
    to: "          q.next = now;",
  },
  {
    name: "R2-18 an input's depth is not bounded",
    file: "src/server.ts",
    from: "    const bounds = withinBounds(envelope, MAX_INPUT_DEPTH + 1, MAX_ENVELOPE_BYTES);",
    to: "    const bounds = withinBounds(envelope, 1e9, 1e9);",
  },
  {
    name: "R2-19 an envelope's size is not bounded",
    file: "src/server.ts",
    from: '    if (Buffer.byteLength(JSON.stringify(envelope) ?? "") > MAX_ENVELOPE_BYTES) return tooLarge();',
    to: '    if (Buffer.byteLength(JSON.stringify(envelope) ?? "") > MAX_ENVELOPE_BYTES * 1000) return tooLarge();',
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
];

/** The prototype's mutations of code that the switch replaces (its
 * mutators, its read rules and the server's online-only check), made at the
 * same place in `@session/mutators`, by the mutation's name up to the first
 * space. */
const IN_PACKAGE: Record<string, PackageEdit> = {
  // the membership ends through endMembership since review round 1 of phase 1
  X1: {
    file: "src/defs/members.ts",
    from: '      endMembership(tx, i.space, i.user, "removed");\n      if (!tx.get("ban"',
    to: '      if (!tx.get("ban"',
  },
  X2: {
    file: "src/defs/spaces.ts",
    from: 'if (!bannedFrom(tx, s0.id, r.u)) addMember(tx, s0.id, r.u, "member", tx.id(k));',
    to: 'addMember(tx, s0.id, r.u, "member", tx.id(k));',
  },
  X3: {
    file: "src/defs/threads.ts",
    from: '        q: "",\n        t: null,\n        edited: false,',
    to: "        edited: false,",
  },
  // moved with the redaction of model and skill (review round 2 of phase 1)
  X4: {
    file: "src/access.ts",
    from: '        q: "",\n        t: null,\n        sum: null,\n        about: null,\n        model: null,\n        skill: null,\n      } satisfies ThreadRec;',
    to: '        q: "",\n        about: null,\n        model: null,\n        skill: null,\n      } satisfies ThreadRec;',
  },
  X6: {
    file: "src/defs/members.ts",
    from: "    pre: (ctx) => {\n      for (;;) {",
    to: "    pre: (ctx, i) => {\n      if (i.id) return { code: i.id.slice(-10).toLowerCase() };\n      for (;;) {",
  },
  X7: {
    file: "src/defs/spaces.ts",
    from: 'if (link) tx.put({ ...link, dead: "Used", usedBy: tx.me });',
    to: "",
  },
  X9: {
    file: "src/defs/members.ts",
    from: 'if (me) tx.put({ ...me, role: "admin" });',
    to: "",
  },
  X13: {
    file: "src/defs/threads.ts",
    from: "likes: Math.max(0, c.likes + (i.on ? 1 : -1))",
    to: "likes: Math.max(0, c.likes + (i.on ? 2 : -1))",
  },
  X14: {
    file: "src/rules.ts",
    from: '        q: "",\n        t: null,\n        sum: null,\n        about: null,\n        model: null,\n        skill: null,\n        running: false,',
    to: '        q: "",\n        about: null,\n        model: null,\n        skill: null,\n        running: false,',
  },
  X16: {
    file: "src/defs/members.ts",
    from: '          if (bannedFrom(tx, i.space, u))\n            throw refuse("PRECONDITION_FAILED", "This person is banned from the space.");\n',
    to: "",
  },
  X18: {
    file: "src/access.ts",
    from: 'return { ...r, q: "", a: null, model: null } satisfies FollowUpRec;',
    to: 'return { ...r, q: "", model: null } satisfies FollowUpRec;',
  },
  X20: {
    file: "src/defs/threads.ts",
    from: "      const kept = counts.r > 0;\n",
    to: "      const kept = counts.r > 1;\n",
  },
  X22: {
    file: "src/defs/members.ts",
    from: '        if (i.decision !== "decline" && r.rev !== i.base?.[u]) throw stale(tx, tx.me, r);\n',
    to: "",
  },
  // the rev compared is the hide record's since phase 1b (Part 0 item 3)
  X23: {
    file: "src/defs/moderation.ts",
    from: '      if (i.decision === "shown" && (h?.rev ?? 0) !== i.base?.rev)\n        throw stale(tx, tx.me, r, [`hide:${itemKey(r)}`]);\n',
    to: "",
  },
  X24: {
    file: "src/defs/members.ts",
    from: "      if (m.adm !== i.base.adm) throw stale(tx, tx.me, m);\n",
    to: "",
  },
  X26: {
    file: "src/access.ts",
    from: "      return own && (sp === null || readsSpace(g, sp, u));",
    to: "      return own;",
  },
  X29: {
    file: "src/engine.ts",
    from: "    if (def.online && envelope.clientTime - ulidTime(envelope.mutationId) > ONLINE_MAX_AGE)",
    to: "    if (def.online && envelope.clientTime - ulidTime(envelope.mutationId) > 1000 * ONLINE_MAX_AGE)",
  },
  N12: {
    file: "src/defs/spaces.ts",
    from: "    (link.expiresAt === null || msOf(link.expiresAt) > tx.nowMs) &&\n",
    to: "",
  },
  N13: {
    file: "src/access.ts",
    from: "(isModOf(g, sp, u) || (u !== null && a.by === u && roleIn(g, sp, u) !== null))",
    to: "(isModOf(g, sp, u) || (u !== null && a.by === u))",
  },
  N14: {
    file: "src/defs/spaces.ts",
    from: 'invite: closed ? (set.invite ?? s1.invite ?? "mods") : null,',
    to: 'invite: closed ? "members" : null,',
  },
  N22: {
    file: "src/defs/spaces.ts",
    from: '    can: (tx, i) => inSpace(tx, i.id, "admin"),\n    run: (tx, i) => {\n      const s0',
    to: '    can: (tx, i) => inSpace(tx, i.id, "moderator"),\n    run: (tx, i) => {\n      const s0',
  },
  N23: {
    file: "src/defs/members.ts",
    from: "        a,\n        why: null,\n        retryAt: null,\n        createdAt: old",
    to: "        a,\n        why: old ? old.why : null,\n        retryAt: null,\n        createdAt: old",
  },
  // a restricting decision compares the rev too: the hide record's since
  // phase 1b (Part 0 item 3)
  "R2-1": {
    file: "src/defs/moderation.ts",
    from: '      if (i.decision === "shown" && (h?.rev ?? 0) !== i.base?.rev)',
    to: "      if ((h?.rev ?? 0) !== i.base?.rev)",
  },
  "R2-2": {
    file: "src/defs/members.ts",
    from: '        if (i.decision !== "decline" && r.rev !== i.base?.[u]) throw stale(tx, tx.me, r);',
    to: "        if (r.rev !== i.base?.[u]) throw stale(tx, tx.me, r);",
  },
  "R2-3": {
    file: "src/defs/spaces.ts",
    from: '      addMember(tx, s.id, tx.me, "member", tx.id(1));',
    to: '      addMember(tx, s.id, tx.me, "member", `${s.id}:${tx.me}`);',
  },
  "R2-4": {
    file: "src/defs/threads.ts",
    from: "      if (c) tx.put({ ...c, likes: Math.max(0, c.likes + (i.on ? 1 : -1)) });",
    to: '      if (c) tx.put({ ...c, likes: Math.max(0, c.likes + (i.on ? 1 : -1)) });\n      const th = tx.get("thread", i.thread);\n      if (th) tx.put({ ...th, tok: th.tok + 1 });',
  },
  // the package's rule for report notifications is its own line
  "R2-5": {
    file: "src/access.ts",
    from: '      return a.type !== "report" || isModOf(g, sp, u);',
    to: "      return true;",
  },
  "R2-24": {
    file: "src/rules.ts",
    from: '    .replace(/[^a-z0-9-]+/g, "-")\n    .replace(/^-+/, "")',
    to: '    .replace(/[^a-z0-9-]+/g, "-")',
  },
};

/** A mutation as `--sync` makes it: in `file` of `@session/sync` (relative
 * to its package directory), the same fault as the prototype server's. */
interface SyncEdit {
  file: string;
  from: string;
  to: string;
  also?: { from: string; to: string }[];
}

/** `--sync` runs the suite against `@session/sync`'s server half
 * (REPLICA_PROTO_SERVER=sync-memory, with the package's mutators). Each
 * mutation of the prototype's `src/server.ts` or `src/contract.ts` is made at
 * the same place in a copy of `@session/sync` instead; the mutators' and
 * read rules' are made in `@session/mutators` (`IN_PACKAGE`), and the
 * prototype client's where they are (the suite's clients are the
 * prototype's). */
const IN_SYNC: Record<string, SyncEdit> = {
  X5: {
    file: "src/server/server.ts",
    from: "    if (!c || c.u !== u || c.seen <= now - CLIENT_IDLE_TTL) return null;",
    to: "    if (!c || c.seen <= now - CLIENT_IDLE_TTL) return null;",
  },
  X8: {
    file: "src/server/server.ts",
    from: "        return x < y ? -1 : x > y ? 1 : born(a.key) - born(b.key);",
    to: "        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;",
  },
  X10: {
    file: "src/server/server.ts",
    from: "    return t && pkg.readsAudience(g, t, u) ? true : null;",
    to: "    return t ? true : null;",
  },
  X11: {
    file: "src/server/server.ts",
    from: '    for (const [to, role] of s?.kind === "space" ? s.mods : []) {\n      if (role === "member") continue;',
    to: '    for (const [to, role] of tx.scan("member", "sp", effect.sp).map((m) => [(m as pkg.MemberRec).u, "x"] as const)) {\n      if (role === "member") continue;',
  },
  X12: {
    file: "src/protocol.ts",
    from: "export const ANSWER_TTL = 7 * DAY;",
    to: "export const ANSWER_TTL = 5 * DAY;",
  },
  X19: {
    file: "src/server/server.ts",
    from: "    for (const t of tx.tombsBefore(cutoff, limit)) {\n      tx.tombDelete(t.key);",
    to: '    for (const t of tx.tombsBefore(cutoff, limit)) {\n      if (t.kind !== "followup") tx.tombDelete(t.key);',
  },
  X21: {
    file: "src/server/tokens.ts",
    from: '    const body = Buffer.concat([cipher.update(plain), cipher.final()]);\n    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");',
    to: '    void cipher;\n    return Buffer.concat([iv, plain, Buffer.alloc(TAG)]).toString("base64url");',
    also: [
      {
        from: "        d.setAuthTag(raw.subarray(raw.length - TAG));\n        plain = Buffer.concat([d.update(raw.subarray(IV, raw.length - TAG)), d.final()]);",
        to: "        void d;\n        plain = raw.subarray(IV, raw.length - TAG);",
      },
    ],
  },
  X25: {
    file: "src/server/server.ts",
    from: "        const tomb: Tombstone = { key, ...pkg.audience(g, old), at };",
    to: "        const tomb = { ...old, key, ...pkg.audience(g, old), at } as Tombstone;",
  },
  X27: {
    file: "src/protocol.ts",
    from: '  "INTERNAL_SERVER_ERROR",\n  "TOO_LARGE",\n]);',
    to: '  "TOO_LARGE",\n]);',
  },
  // X30 and N2 to N5 moved with the cursor checks into `openCursor`, which
  // `pull` and the streams' read share since review round 2 of phase 2: the
  // same faults, now in both reads
  X30: {
    file: "src/server/server.ts",
    from: "      c.at < now - TOMBSTONE_TTL ||\n",
    to: "      false ||\n",
  },
  N2: { file: "src/server/server.ts", from: "      c.u !== u ||\n", to: "" },
  N3: { file: "src/server/server.ts", from: "      c.log !== log ||\n", to: "" },
  N4: { file: "src/server/server.ts", from: "      c.n !== tx.epoch(log).n ||\n", to: "" },
  N5: {
    file: "src/server/server.ts",
    from: "    const c = this.tokens.open(cursor, now);\n",
    // tokens carry the database's instance id since review round 1 of
    // phase 1: the made-up state has this database's
    to: "    const c = this.tokens.open(cursor, now) ?? { log, u, n: tx.epoch(log).n, v: 0, h: 0, at: now, i: this.instance(tx) };\n",
  },
  // moved with the epochs read once (review round 2 of phase 1): the same fault
  N6: {
    file: "src/server/server.ts",
    from: "      if (a && a.sp !== null && moved.has(`space:${a.sp}`)) return true;",
    to: "      if (a && a.sp !== null && moved.has(`space:${a.sp}`) && false) return true;",
  },
  N7: {
    file: "src/server/server.ts",
    from: '    for (const row of tx.logAfter(log, version)) if (row.key.startsWith("member:")) return true;\n',
    to: "",
  },
  N8: {
    file: "src/server/server.ts",
    from: "      const rev = (prev?.rev ?? tx.registryGet(reg) ?? 0) + 1;",
    to: "      const rev = (prev?.rev ?? 0) + 1;",
  },
  N9: {
    file: "src/server/server.ts",
    from: '      if (!r || !("mod" in r) || r.mod === "removed") return false;',
    to: '      if (!r || !("mod" in r)) return false;',
  },
  N10: {
    file: "src/protocol.ts",
    from: '  "CLOCK_SKEW",\n  "TOO_MANY_REQUESTS",\n  "SERVICE_UNAVAILABLE",\n',
    to: '  "CLOCK_SKEW",\n',
  },
  N11: {
    file: "src/server/server.ts",
    // (moved with the dead letter's end of its run, review round 2 of phase 1)
    from: "          if (attempts >= EFFECT_MAX_ATTEMPTS) {\n            tx.effectDelete(q.id);\n            tx.deadLetterAdd({ effect: q.effect, at: q.at, attempts, failedAt: now });\n",
    to: "          if (attempts >= 1) {\n            tx.effectDelete(q.id);\n",
  },
  N15: {
    file: "src/server/memory.ts",
    from: "    for (const m of [this.t.answers, this.t.seqAnswers] as Map<string, StoredAnswer>[]) {",
    to: "    for (const m of [this.t.answers] as Map<string, StoredAnswer>[]) {",
  },
  // a job starts after the worker's transaction since review round 1 of
  // phase 1: the same faults where the worker now starts and deletes it
  N16: {
    file: "src/server/server.ts",
    from: "          this.jobRunner.start(job);\n",
    to: "",
  },
  N17: {
    file: "src/server/server.ts",
    from: "          if (!start) tx.effectDelete(q.id);",
    to: "          if (!start && attempts === 1) tx.effectDelete(q.id);\n          else if (!start) tx.effectUpdate(q.id, 0, now);",
  },
  N20: {
    file: "src/server/server.ts",
    from: "    tx.clientsPrune(now - CLIENT_IDLE_TTL + 1, limit);",
    to: "    tx.clientsPrune(now - CLIENT_IDLE_TTL * 1000, limit);",
  },
  N21: {
    file: "src/server/server.ts",
    from: "    return t && pkg.readsAudience(g, t, u) ? true : null;",
    to: '    return t &&\n      (pkg.readsAudience(g, t, u) || ((t.kind === "like" || t.kind === "save") && t.person === u))\n      ? true\n      : null;',
  },
  N24: {
    file: "src/server/server.ts",
    from: '      if (seen?.kind === "seen" && seen.reps) staged.push([`seen:${to}`, { ...seen, reps: false }]);\n    }\n    this.commit(tx, staged, now);',
    to: '      if (seen?.kind === "seen" && seen.reps) staged.push([`seen:${to}`, { ...seen, reps: false }]);\n    }\n    if (effect.report.endsWith("0")) staged.length = 0;\n    this.commit(tx, staged, now);',
  },
  N25: {
    file: "src/server/server.ts",
    from: "        tx.del(key);\n        tx.tombPut(tomb);",
    to: "        tx.del(key);\n        tx.registrySet(pkg.registryKey(old), 0);\n        tx.tombPut(tomb);",
  },
  N29: {
    file: "src/server/server.ts",
    from: "        tx.del(key);\n        tx.tombPut(tomb);",
    to: "        tx.del(key);\n        const freed = pkg.idOf(old);\n        if (freed !== null) tx.registrySet(freed, -1);\n        tx.tombPut(tomb);",
    also: [
      {
        from: "    return this.tx.registryGet(id) !== undefined;",
        to: "    return (this.tx.registryGet(id) ?? -1) >= 0;",
      },
    ],
  },
  N30: {
    // (moved into `openCursor` with X30)
    file: "src/server/server.ts",
    from: "      c.n !== tx.epoch(log).n ||\n",
    to: "      (c.v > 0 && c.n !== tx.epoch(log).n) ||\n",
  },
  N31: {
    file: "src/server/tokens.ts",
    from: "        d.setAuthTag(raw.subarray(raw.length - TAG));\n        plain = Buffer.concat([d.update(raw.subarray(IV, raw.length - TAG)), d.final()]);",
    to: "        plain = d.update(raw.subarray(IV, raw.length - TAG));",
  },
  N33: {
    file: "src/server/server.ts",
    // (moved with the pull's answer, now one field a line)
    from: "        changes,\n        cursor: this.serve(tx, log, u, to, now),\n        lastSeq,",
    to: "        changes,\n        cursor: this.serve(tx, log, u, to, changes.length ? now : c.at),\n        lastSeq,",
  },
  // the key is configured here, not made per process: the fault is that
  // the configured key is not used (every server seals with the same key)
  // Since review round 1 of phase 1 a token carries its database's
  // instance id, so a token of another server answers resync whatever its
  // key: this suite, whose servers each have their own store, no longer
  // tells a constant key apart (it survives here). `@session/sync`'s own
  // test of key rotation over one store kills it, since review round 2 of
  // phase 2: its check that a key never configured opens nothing ran after
  // the clock had passed the token's age, which resynced it whatever the
  // key, and now runs before.
  N34: {
    file: "src/server/tokens.ts",
    from: '    const cipher = createCipheriv("aes-256-gcm", this.keys.current, iv);',
    to: '    const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32), iv);',
    also: [
      { from: "    const keys = [this.keys.current];", to: "    const keys = [Buffer.alloc(32)];" },
    ],
  },
  "R2-7": {
    file: "src/server/server.ts",
    from: '      if (!timeOk(pkg.ulidTime(m.mutationId), m.clientTime)) return expired("mutationId");\n',
    to: "",
  },
  "R2-9": {
    file: "src/server/server.ts",
    from: "        if (tx.registrations(actor.u, now - DAY + 1) >= REGISTRATIONS_PER_DAY)",
    to: "        if (tx.registrations(actor.u, now - DAY + 1) >= REGISTRATIONS_PER_DAY * 1000)",
  },
  "R2-15": {
    file: "src/server/server.ts",
    from: "      return this.applyEnvelope(actor, envelope, size);\n    } catch {",
    to: "      const a = this.applyEnvelope(actor, envelope, size);\n      this.work();\n      return a;\n    } catch {",
  },
  "R2-16": {
    file: "src/server/server.ts",
    from: "          if (attempts >= EFFECT_MAX_ATTEMPTS) {",
    to: "          if (attempts >= EFFECT_MAX_ATTEMPTS * 1000) {",
  },
  "R2-17": {
    file: "src/server/server.ts",
    from: "              now + Math.min(EFFECT_BACKOFF_MAX, EFFECT_BACKOFF_MIN * 2 ** (attempts - 1)),",
    to: "              now,",
  },
  "R2-18": {
    file: "src/server/server.ts",
    from: "    const b = bounds(envelope, MAX_INPUT_DEPTH + 1, MAX_ENVELOPE_BYTES);",
    to: "    const b = bounds(envelope, 1e9, 1e9);",
  },
  "R2-19": {
    file: "src/server/server.ts",
    from: '    if (Buffer.byteLength(JSON.stringify(envelope) ?? "") > MAX_ENVELOPE_BYTES) return large();',
    to: '    if (Buffer.byteLength(JSON.stringify(envelope) ?? "") > MAX_ENVELOPE_BYTES * 1000) return large();',
  },
  "R2-20": {
    file: "src/server/server.ts",
    from: "      return this.applyEnvelope(actor, envelope, size);\n    } catch {",
    to: "      return this.applyEnvelope(actor, envelope, size);\n    } catch (e) {\n      if (e) throw e;",
  },
  "R2-21": {
    file: "src/server/server.ts",
    from: "      if (Math.abs(m.clientTime - now) > CLOCK_MAX_SKEW)",
    to: "      if (Math.abs(m.clientTime - now) > 1e15)",
  },
  // the storage scan is the store's dump here
  "R2-22": {
    file: "src/server/memory.ts",
    from: "      clients: [...t.clients].map(([clientId, c]) => ({ clientId, ...c })),",
    to: "      clients: [],",
  },
};

/** The prototype's files whose code the switch replaces: every mutation of
 * them needs an `IN_PACKAGE` entry. */
const REPLACED = new Set(["src/mutators.ts", "src/access.ts"]);
/** The prototype's files whose code `@session/sync` replaces with `--sync`:
 * every mutation of them needs an `IN_SYNC` (or `IN_PACKAGE`) entry. */
const SERVER_FILES = new Set(["src/server.ts", "src/contract.ts"]);
const idOfMutation = (m: Mutation) => m.name.split(" ")[0] ?? m.name;

type Where = "proto" | "mutators" | "sync";

/** Where `--package` and `--sync` make a mutation: in `@session/mutators`,
 * in `@session/sync`, or where it is. */
function target(m: Mutation): {
  where: Where;
  file: string;
  edits: { from: string; to: string }[];
} {
  const p = IN_PACKAGE[idOfMutation(m)];
  if (PACKAGE && p) return { where: "mutators", file: p.file, edits: [{ from: p.from, to: p.to }] };
  if (PACKAGE && REPLACED.has(m.file))
    throw new Error(`${m.name}: no place in @session/mutators (IN_PACKAGE)`);
  const q = IN_SYNC[idOfMutation(m)];
  if (SYNC && q)
    return { where: "sync", file: q.file, edits: [{ from: q.from, to: q.to }, ...(q.also ?? [])] };
  if (SYNC && SERVER_FILES.has(m.file))
    throw new Error(`${m.name}: no place in @session/sync (IN_SYNC)`);
  return { where: "proto", file: m.file, edits: edits(m) };
}

/** The directory of a package, in the workspace or in a slot. */
const baseOf = (where: Where) =>
  where === "mutators" ? MUTATORS_PKG : where === "sync" ? SYNC_PKG : PKG;

interface Outcome {
  typecheck: string;
  passed: number;
  failed: number;
  tests: string[];
}

const PKG = process.cwd();
const WEB = resolve(PKG, "../..");
const MUTATORS_PKG = join(WEB, "packages", "mutators");
const SYNC_PKG = join(WEB, "packages", "sync");
const SYNC = process.argv.includes("--sync");
const PACKAGE = process.argv.includes("--package") || SYNC;

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
  // a copy of @session/mutators, which the copy of this package resolves
  // before the workspace's (its own node_modules comes first)
  cpSync(MUTATORS_PKG, join(web, "packages", "mutators"), {
    recursive: true,
    filter: (src) => !/[/\\](node_modules|dist)$/.test(src),
  });
  mkdirSync(join(dir, "node_modules", "@session"), { recursive: true });
  symlinkSync(join(web, "packages", "mutators"), join(dir, "node_modules", "@session", "mutators"));
  // a copy of @session/sync, over the copy of @session/mutators
  const sync = join(web, "packages", "sync");
  cpSync(SYNC_PKG, sync, {
    recursive: true,
    filter: (src) => !/[/\\](node_modules|dist)$/.test(src),
  });
  mkdirSync(join(sync, "node_modules", "@session"), { recursive: true });
  symlinkSync(
    join(web, "packages", "mutators"),
    join(sync, "node_modules", "@session", "mutators"),
  );
  symlinkSync(sync, join(dir, "node_modules", "@session", "sync"));
  return dir;
}

function sh(
  cmd: string,
  args: string[],
  cwd: string,
  pkg = false,
): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    let out = "";
    const env: Record<string, string | undefined> = {
      ...process.env,
      FORCE_COLOR: "0",
      REPLICA_PROTO_MUTATORS: pkg ? "package" : "",
    };
    if (SYNC) env["REPLICA_PROTO_SERVER"] = "sync-memory";
    else delete env["REPLICA_PROTO_SERVER"];
    const p = spawn(cmd, args, { cwd, env });
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (out += d.toString()));
    p.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

async function run(m: Mutation, dir: string): Promise<Outcome> {
  const where = target(m);
  const base = baseOf(where.where);
  const file = join(where.where === "proto" ? dir : join(dir, "..", where.where), where.file);
  const original = readFileSync(join(base, where.file), "utf8");
  let source = original;
  for (const e of where.edits) {
    if (!source.includes(e.from)) throw new Error(`${m.name}: pattern not found in ${where.file}`);
    source = source.replace(e.from, e.to);
  }
  writeFileSync(file, source);
  try {
    const tc = await sh("npx", ["tsc", "-p", "tsconfig.test.json", "--noEmit"], dir);
    const ava = await sh("npx", ["ava", "--timeout=600s"], dir, PACKAGE);
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
  for (const m of MUTATIONS) {
    const where = target(m);
    const base = baseOf(where.where);
    for (const e of where.edits) {
      const n = readFileSync(join(base, where.file), "utf8").split(e.from).length - 1;
      if (n !== 1) throw new Error(`${m.name}: ${n} matches in ${where.file}`);
    }
  }
  console.log(
    `${MUTATIONS.length} patterns found${SYNC ? " (in @session/sync)" : PACKAGE ? " (with the switch on)" : ""}`,
  );
  process.exit(0);
}
const k = args.indexOf("--slots");
const slots = k >= 0 ? Number(args[k + 1]) : 4;
const s = args.indexOf("--since");
const since = s >= 0 ? args[s + 1] : undefined;
if (s >= 0 && !since) throw new Error("--since needs a git ref");
const only = args.filter(
  (a, i) => !a.startsWith("--") && (k < 0 || i !== k + 1) && (s < 0 || i !== s + 1),
);

/** The files changed since `ref` (absolute paths), the working tree included. */
function changedSince(ref: string): Set<string> {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: WEB, encoding: "utf8" });
  const top = git("rev-parse", "--show-toplevel").trim();
  return new Set(
    git("diff", "--name-only", ref, "--", ".")
      .split("\n")
      .filter(Boolean)
      .map((p) => resolve(top, p)),
  );
}
const changed = since === undefined ? null : changedSince(since);
const touched = (m: Mutation) => {
  if (!changed) return true;
  const where = target(m);
  return changed.has(join(baseOf(where.where), where.file));
};
const todo = MUTATIONS.filter(
  (m) => (!only.length || only.some((o) => m.name.startsWith(o))) && touched(m),
);
if (since !== undefined)
  console.log(
    `${todo.length} mutations of files changed since ${since}: ${todo.map(idOfMutation).join(" ")}`,
  );
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
