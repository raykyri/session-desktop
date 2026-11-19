// Mutation runs for the suite: each mutation changes one place in `src/` of a
// copy of the package, then the type check and the whole suite run in that
// copy, and the run lists the tests that failed. A mutation no test kills is
// a gap in the suite. The package itself is never changed.
//
// Run from the package directory: `npm run mutate [-- <name prefix> ...]`,
// or `npm run mutate -- --check` to check only that every pattern matches
// once. `--slots <n>` sets how many copies run at once (default 4).
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
    from: '  "INTERNAL_SERVER_ERROR",\n]);',
    to: "]);",
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
    from: "        a,\n        why: null,\n        createdAt: old",
    to: '        a,\n        why: old?.kind === "request" ? old.why : null,\n        createdAt: old',
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
    from: "      !withinBounds(envelope, MAX_INPUT_DEPTH + 1, MAX_ENVELOPE_BYTES) ||",
    to: "      !withinBounds(envelope, 1e9, 1e9) ||",
  },
  {
    name: "R2-19 an envelope's size is not bounded",
    file: "src/server.ts",
    from: '      Buffer.byteLength(JSON.stringify(envelope) ?? "") > MAX_ENVELOPE_BYTES',
    to: '      Buffer.byteLength(JSON.stringify(envelope) ?? "") > MAX_ENVELOPE_BYTES * 1000',
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
  X1: {
    file: "src/defs/members.ts",
    from: '      if (tx.get("member", `${i.space}:${i.user}`)) tx.del("member", `${i.space}:${i.user}`);\n      if (!tx.get("ban"',
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
  X4: {
    file: "src/access.ts",
    from: 'return { ...r, q: "", t: null, sum: null } satisfies ThreadRec;',
    to: 'return { ...r, q: "" } satisfies ThreadRec;',
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
    from: '        q: "",\n        t: null,\n        sum: null,\n        running: false,',
    to: '        q: "",\n        running: false,',
  },
  X16: {
    file: "src/defs/members.ts",
    from: '          if (bannedFrom(tx, i.space, u))\n            throw refuse("PRECONDITION_FAILED", "This person is banned from the space.");\n',
    to: "",
  },
  X18: {
    file: "src/access.ts",
    from: 'return { ...r, q: "", a: null } satisfies FollowUpRec;',
    to: 'return { ...r, q: "" } satisfies FollowUpRec;',
  },
  X20: {
    file: "src/defs/threads.ts",
    from: "      const kept = counts.r > 0;\n",
    to: "      const kept = counts.r > 1;\n",
  },
  X22: {
    file: "src/defs/members.ts",
    from: '        if (i.decision !== "decline" && r.rev !== i.base?.[u]) throw stale();\n',
    to: "",
  },
  X23: {
    file: "src/defs/moderation.ts",
    from: '      if (i.decision === "shown" && r.rev !== i.base?.rev) throw stale();\n',
    to: "",
  },
  X24: {
    file: "src/defs/members.ts",
    from: "      if (m.adm !== i.base.adm) throw stale();\n",
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
    from: "        (link.expiresAt === null || msOf(link.expiresAt) > tx.nowMs) &&\n",
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
    from: "        a,\n        why: null,\n        createdAt: old",
    to: "        a,\n        why: old ? old.why : null,\n        createdAt: old",
  },
  "R2-1": {
    file: "src/defs/moderation.ts",
    from: '      if (i.decision === "shown" && r.rev !== i.base?.rev) throw stale();',
    to: "      if (r.rev !== i.base?.rev) throw stale();",
  },
  "R2-2": {
    file: "src/defs/members.ts",
    from: '        if (i.decision !== "decline" && r.rev !== i.base?.[u]) throw stale();',
    to: "        if (r.rev !== i.base?.[u]) throw stale();",
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

/** The prototype's files whose code the switch replaces: every mutation of
 * them needs an `IN_PACKAGE` entry. */
const REPLACED = new Set(["src/mutators.ts", "src/access.ts"]);
const idOfMutation = (m: Mutation) => m.name.split(" ")[0] ?? m.name;

/** Where `--package` makes a mutation: in the package, or where it is. */
function target(m: Mutation): {
  pkg: boolean;
  file: string;
  edits: { from: string; to: string }[];
} {
  const p = IN_PACKAGE[idOfMutation(m)];
  if (PACKAGE && p) return { pkg: true, file: p.file, edits: [{ from: p.from, to: p.to }] };
  if (PACKAGE && REPLACED.has(m.file))
    throw new Error(`${m.name}: no place in @session/mutators (IN_PACKAGE)`);
  return { pkg: false, file: m.file, edits: edits(m) };
}

interface Outcome {
  typecheck: string;
  passed: number;
  failed: number;
  tests: string[];
}

const PKG = process.cwd();
const WEB = resolve(PKG, "../..");
const MUTATORS_PKG = join(WEB, "packages", "mutators");
const PACKAGE = process.argv.includes("--package");

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
    const env = { ...process.env, FORCE_COLOR: "0", REPLICA_PROTO_MUTATORS: pkg ? "package" : "" };
    const p = spawn(cmd, args, { cwd, env });
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (out += d.toString()));
    p.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

async function run(m: Mutation, dir: string): Promise<Outcome> {
  const where = target(m);
  const base = where.pkg ? MUTATORS_PKG : PKG;
  const file = join(where.pkg ? join(dir, "..", "mutators") : dir, where.file);
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
    const base = where.pkg ? MUTATORS_PKG : PKG;
    for (const e of where.edits) {
      const n = readFileSync(join(base, where.file), "utf8").split(e.from).length - 1;
      if (n !== 1) throw new Error(`${m.name}: ${n} matches in ${where.file}`);
    }
  }
  console.log(`${MUTATIONS.length} patterns found${PACKAGE ? " (with the switch on)" : ""}`);
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
