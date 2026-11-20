// The online calls and the SSE stream against the read oracle (review round 1
// of phase 1): a seeded history of device runs (claims, heartbeats, turns,
// answers), the clock, hides, bans, removals and reruns, with streams open
// for several readers and tokens, checked after every step:
// - a call on a run whose person may not act on it (`mayRun`) is refused;
// - a call after the run's lease ended (90 s after its claim or last
//   heartbeat) is refused;
// - a turn on a run that holds its lease answers ok, with streams open;
// - `runs.claim` serves only texts the run's person may read;
// - an answer lands only on the attempt its ask is at;
// - a stream sends a run's text only to a reader for whom the run's node
//   (its thread, or its follow-up) reads as it is stored (review round 2,
//   H1), numbered 1, 2, … within the attempt (round 1's W3), and every
//   turn's text to a reader of the open space who reads its node so;
// - a stream pokes for a log only when what its reader may read of it
//   changed, apart from one poke for a token that does not open (after which
//   the log leaves the stream).
// Review round 2 of phase 1 (G5) adds to the history: device runs on a
// thread's own ask, hidden follow-ups, `devices.revoke`, `spaces.leave`, an
// archived space (its run calls refused, its device runs ended), a browser
// session calling `runs.*` (refused), and calls at a lease's end just after
// housekeeping ran, so the lease check itself decides them.
// It runs where the server under test has online calls (`TestServer.online`,
// the `@session/sync` server half); the prototype has none.

import test from "ava";

import type { LogId, StoredRecord, StreamEvent } from "../src/index.js";

import { DAY, cast, ok, rng, type World } from "./harness.js";
import { expected, mayRead, mayRun, readableTexts, shown } from "./oracle.js";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument,
   @typescript-eslint/no-unsafe-return -- call results are read as `any` */
type Any = any;

const LEASE = 90_000;
const SEEDS = Number(process.env["ONLINE_SEEDS"] ?? 12);
const STEPS = 120;

interface Run {
  id: string;
  u: string;
  device: string;
  th: string;
  /** The node the run answers: "r" or a follow-up's id. */
  node: string;
  attempt: number;
  /** The lease's end, as the oracle keeps it (null: never claimed). */
  until: number | null;
}

interface Stream {
  reader: string | null;
  /** Per log: whether its token opens for this reader and log. */
  logs: Map<LogId, boolean>;
  /** Per log: the oracle's view at connect or at the last poke. */
  seen: Map<LogId, string>;
  /** Per log: pokes so far. */
  pokes: Map<LogId, number>;
  handle: { events(): Promise<StreamEvent[]>; close(): Promise<void> };
  read: number;
}

type Dump = ReadonlyMap<string, StoredRecord>;

const viewOf = (w: World, reader: string | null, log: LogId) =>
  JSON.stringify([...expected(w.server.dump(), reader, log)].sort(([a], [b]) => (a < b ? -1 : 1)));

const nodeKey = (r: { th: string; node: string }) =>
  r.node === "r" ? `thread:${r.th}` : `followup:${r.node}`;

/** Whether `reader` reads the node of run `run` as it is stored: who may
 * read the run's in-flight text (review round 2 of phase 1, H1). */
function readsText(dump: Dump, run: StoredRecord | undefined, reader: string | null): boolean {
  if (run?.kind !== "run" || !mayRead(dump, run, reader)) return false;
  const n = dump.get(nodeKey(run));
  return (
    n !== undefined &&
    (n as { mod?: unknown }).mod === null &&
    mayRead(dump, n, reader) &&
    shown(dump, n, reader) === n
  );
}

const archived = (dump: Dump, sp: string) => !!(dump.get(`space:${sp}`) as Any)?.archived;
const live = (r: Any) => r?.status === "queued" || r?.status === "running";

for (let s0 = 1; s0 <= SEEDS; s0 += 4)
  test(`online calls and the stream match the read oracle: seeds ${s0} to ${Math.min(SEEDS, s0 + 3)}`, async (t) => {
    const stats = new Map<string, number>();
    const count = (k: string) => stats.set(k, (stats.get(k) ?? 0) + 1);
    // every failure; the first of each kind is reported
    const failures: string[] = [];
    for (let seed = s0; seed <= Math.min(SEEDS, s0 + 3); seed++) {
      const { w, open, closed } = await cast(t, seed);
      const on = w.server.online;
      if (!on) return t.pass("the server under test has no online calls");
      const rand = rng(seed * 7919);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
      const fail = (step: number, what: string, detail: string) =>
        failures.push(`seed ${seed}, step ${step} (${what}): ${detail}`);

      // devices for mel and otto, signed in from the browser
      const devices = new Map<string, string>();
      const revoked = new Set<string>();
      const signIn = async (u: string) => {
        const a = (await on.call(null, "devices.authorize", { name: `${u}'s mac` })) as Any;
        await on.call({ u }, "devices.approve", { request: a.result.request, code: a.result.code });
        const c = (await on.call(null, "devices.token", { request: a.result.request })) as Any;
        if (!c.ok) throw new Error(`seed ${seed}: device sign-in: ${JSON.stringify(c)}`);
        devices.set(u, c.result.device);
      };
      for (const u of ["mel", "otto"]) await signIn(u);
      const threads: { id: string; s: string; u: string }[] = [];
      for (const [u, sp] of [
        ["olga", open],
        ["otto", open],
        ["olga", closed],
        ["mel", closed],
      ] as const) {
        const id = w.id();
        await ok(t, w.as(u, "threads.create", { id, space: sp, kind: "ask", q: `Q-${u}-${id}` }));
        await w.server.finishJob(`thread:${id}`, `SUM-${id}`);
        threads.push({ id, s: sp, u });
      }

      // streams: honest tokens, made-up ones and another reader's
      const streams: Stream[] = [];
      const openStream = (reader: string | null, tokens: [LogId, string, boolean][]) => {
        const cursors: Record<string, string> = {};
        const st: Stream = {
          reader,
          logs: new Map(),
          seen: new Map(),
          pokes: new Map(),
          handle: null as never,
          read: 0,
        };
        for (const [log, token, opens] of tokens) {
          cursors[log] = token;
          st.logs.set(log, opens);
          st.seen.set(log, viewOf(w, reader, log));
          st.pokes.set(log, 0);
        }
        st.handle = on.stream(reader === null ? null : { u: reader }, cursors);
        streams.push(st);
      };
      const honest = async (
        reader: string | null,
        log: LogId,
      ): Promise<[LogId, string, boolean]> => [
        log,
        (await w.server.snapshot(reader === null ? null : { u: reader }, log)).cursor,
        true,
      ];
      const ottoUser = (await w.server.snapshot({ u: "otto" }, "user:otto")).cursor;
      openStream(null, [await honest(null, `space:${open}`), [`space:${closed}`, "x", false]]);
      openStream("otto", [
        await honest("otto", `space:${open}`),
        await honest("otto", `space:${closed}`),
        ["user:mel", ottoUser, false],
      ]);
      openStream("mel", [
        await honest("mel", `space:${open}`),
        await honest("mel", `space:${closed}`),
        await honest("mel", "user:mel"),
      ]);
      openStream("mona", [await honest("mona", `space:${open}`)]);
      openStream("eve", [
        [`space:${closed}`, "garbage", false],
        ["user:mel", "garbage", false],
      ]);
      openStream(null, [["user:otto", "garbage", false]]);
      // the connect pokes
      for (const st of streams) await drain(st, -1, "connect");

      const runs: Run[] = [];
      let n = 0;
      const turnTexts: { text: string; run: string; sp: string }[] = [];
      /** Each ok turn's text, with the seq its event must carry: the count
       * of ok turns of its attempt so far (W3). */
      const seqOf = new Map<string, { seq: number; attempt: number }>();
      const turnsOk = new Map<string, number>();

      async function drain(st: Stream, step: number, what: string) {
        const evs = await st.handle.events();
        const fresh = evs.slice(st.read);
        st.read = evs.length;
        const dump = w.server.dump();
        // a step may commit more than once: its pokes of one log are checked
        // against the view before the step
        const checked = new Set<LogId>();
        for (const e of fresh) {
          if (e.type === "run") {
            const r = dump.get(`run:${e.run}`);
            if (!readsText(dump, r, st.reader))
              fail(
                step,
                what,
                `${st.reader ?? "anon"} got the text of run ${e.run}, whose node it may not read as stored`,
              );
            const want = seqOf.get(e.text);
            if (!want || want.seq !== e.seq || want.attempt !== e.attempt)
              fail(
                step,
                what,
                `the event of ${e.text} carries attempt ${e.attempt}, seq ${e.seq}; expected ${JSON.stringify(want)}`,
              );
            continue;
          }
          for (const log of e.logs) {
            const opens = st.logs.get(log);
            if (opens === undefined) {
              fail(
                step,
                what,
                `${st.reader ?? "anon"} poked for ${log}, which its stream does not list`,
              );
              continue;
            }
            const k = (st.pokes.get(log) ?? 0) + 1;
            st.pokes.set(log, k);
            const now = viewOf(w, st.reader, log);
            if (!opens) {
              if (k > 1)
                fail(
                  step,
                  what,
                  `${st.reader ?? "anon"} poked again for ${log}, whose token does not open`,
                );
            } else if (step >= 0 && !checked.has(log) && now === st.seen.get(log))
              fail(
                step,
                what,
                `${st.reader ?? "anon"} poked for ${log}, though what it may read did not change`,
              );
            checked.add(log);
          }
        }
        // the next step's pokes compare with what each reader may read now
        for (const log of st.logs.keys()) st.seen.set(log, viewOf(w, st.reader, log));
        return fresh;
      }

      for (let step = 0; step < STEPS; step++) {
        const before = w.server.dump();
        const now = () => w.clock.now();
        const kind = pick([
          "fork",
          "fork",
          "ask",
          "claim",
          "claim",
          "beat",
          "beat",
          "turn",
          "turn",
          "finish",
          "finish",
          "wait",
          "wait",
          "edge",
          "hide",
          "hidefu",
          "ban",
          "remove",
          "leave",
          "rerun",
          "revoke",
          "archive",
          "tick",
        ] as const);
        let what: string = kind;
        // a device run call, checked against the oracle; now and then from
        // a browser session of the run's person, which drives no device run
        const act = async (r: Run, name: string, extra: object) => {
          const browser = rand() < 0.1;
          what = `${r.u}${browser ? " (browser)" : ""}: ${name} ${r.id}`;
          const rec = before.get(`run:${r.id}`);
          const allowed =
            rec !== undefined &&
            mayRun(before, rec, r.u) &&
            !archived(before, (rec as Any).s) &&
            !revoked.has(r.device) &&
            !browser;
          const running = (rec as Any)?.status === "running" && (rec as Any)?.attempt === r.attempt;
          const leased = r.until !== null && now() < r.until;
          const a = (await on.call(browser ? { u: r.u } : { u: r.u, device: r.device }, name, {
            run: r.id,
            device: r.device,
            ...extra,
          })) as Any;
          const tag = `${name}${browser ? " (browser)" : ""} ${a.ok ? "ok" : a.error.code}`;
          count(tag);
          if (a.ok && !allowed)
            fail(step, what, `ok, though ${r.u} may not act on the run now: ${JSON.stringify(a)}`);
          if (a.ok && name !== "runs.claim" && !leased)
            fail(step, what, `ok after the lease ended at ${r.until} (now ${now()})`);
          if (name === "runs.turn" && allowed && running && leased && !a.ok)
            fail(step, what, `a turn on a run that holds its lease: ${JSON.stringify(a)}`);
          return a;
        };
        const turn = async (r: Run) => {
          const text = `TURN-${n++}`;
          const a = await act(r, "runs.turn", { attempt: r.attempt, turn: text });
          if (a.ok) {
            const k = `${r.id}:${r.attempt}`;
            const seq = (turnsOk.get(k) ?? 0) + 1;
            turnsOk.set(k, seq);
            seqOf.set(text, { seq, attempt: r.attempt });
            turnTexts.push({ text, run: r.id, sp: (before.get(`run:${r.id}`) as Any).s });
          }
        };
        const finish = async (r: Run) => {
          const text = `ANS-${n++}`;
          const node = before.get(nodeKey(r)) as Any;
          const a = await act(r, "runs.finish", { attempt: r.attempt, answer: text });
          const after = w.server.dump().get(nodeKey(r)) as Any;
          const wrote = after && (after.a === text || after.sum === text);
          if (wrote && node?.att !== r.attempt)
            fail(step, what, `the answer of attempt ${r.attempt} landed on attempt ${node?.att}`);
          if (wrote && !a.ok) fail(step, what, "a refused finish wrote its answer");
        };
        const mine = runs;
        // mostly a run that was claimed, as a device would call
        const held = () => {
          const c = runs.filter((r) => (before.get(`run:${r.id}`) as Any)?.status === "running");
          return c.length && rand() < 0.8 ? c : runs;
        };
        if (kind === "fork") {
          const u = pick(["mel", "otto"]);
          const th = pick(threads);
          const id = w.id();
          const a = await w.as(u, "research.forkNode", {
            id,
            thread: th.id,
            parent: "r",
            q: `F-${u}-${id}`,
            executor: { kind: "device", cli: "claude", device: devices.get(u) },
          });
          what = `${u}: research.forkNode on ${th.id}`;
          if (a.ok)
            runs.push({
              id: (a.result as Any).run,
              u,
              device: devices.get(u) as string,
              th: th.id,
              node: id,
              attempt: 1,
              until: null,
            });
        } else if (kind === "ask") {
          // a device run on a thread's own ask (node "r")
          const u = pick(["mel", "otto"]);
          const sp = u === "mel" && rand() < 0.5 ? closed : open;
          const id = w.id();
          what = `${u}: threads.create with a device in ${sp === open ? "the open" : "the closed"} space`;
          const a = await w.as(u, "threads.create", {
            id,
            space: sp,
            kind: "ask",
            q: `A-${u}-${id}`,
            executor: { kind: "device", cli: "claude", device: devices.get(u) },
          });
          if (a.ok) {
            count("step ask");
            threads.push({ id, s: sp, u });
            runs.push({
              id: (a.result as Any).run,
              u,
              device: devices.get(u) as string,
              th: id,
              node: "r",
              attempt: 1,
              until: null,
            });
          }
        } else if (kind === "claim" && mine.length) {
          // mostly a queued run, as a device would claim
          const queued = runs.filter(
            (x) => (before.get(`run:${x.id}`) as Any)?.status === "queued",
          );
          const r = pick(queued.length && rand() < 0.8 ? queued : mine);
          const a = await act(r, "runs.claim", {});
          if (a.ok) {
            r.until = now() + LEASE;
            const allowedTexts = readableTexts(before, r.th, r.u);
            for (const tn of a.result.turns as { q: string; a: string }[])
              for (const x of [tn.q, tn.a])
                if (x && !allowedTexts.has(x))
                  fail(step, what, `served "${x}", which ${r.u} may not read`);
          }
        } else if (kind === "beat" && mine.length) {
          const r = pick(held());
          const a = await act(r, "runs.heartbeat", { attempt: r.attempt });
          if (a.ok) r.until = now() + LEASE;
        } else if (kind === "turn" && mine.length) {
          await turn(pick(held()));
        } else if (kind === "finish" && mine.length) {
          await finish(pick(held()));
        } else if (kind === "wait") {
          const ms = Math.floor(rand() < 0.8 ? rand() * 40_000 : 100_000 + rand() * 100_000);
          what = `wait ${ms} ms`;
          w.clock.advance(ms);
        } else if (kind === "edge") {
          // a call at the lease's end, just after housekeeping ran (within
          // its 1 s): the lease check alone refuses it (review round 2, G2)
          const c = runs.filter(
            (r) =>
              r.until !== null &&
              r.until > now() + 1 &&
              (before.get(`run:${r.id}`) as Any)?.status === "running",
          );
          if (c.length) {
            const r = pick(c);
            w.clock.advance((r.until as number) - 1 - now());
            await w.server.snapshot(null, `space:${open}`);
            w.clock.advance(1 + Math.floor(rand() * 900));
            count("step edge");
            const which = pick(["beat", "turn", "finish"] as const);
            if (which === "beat") await act(r, "runs.heartbeat", { attempt: r.attempt });
            else if (which === "turn") await turn(r);
            else await finish(r);
          }
        } else if (kind === "hide") {
          const th = pick(threads);
          const hidden = before.has(`hide:thread:${th.id}`);
          what = `mona: ${hidden ? "show" : "hide"} ${th.id}`;
          await w.as("mona", "moderation.decide", {
            item: `a:${th.id}`,
            decision: hidden ? "shown" : "hidden",
            base: w.item(`a:${th.id}`),
          });
        } else if (kind === "hidefu") {
          // a follow-up of a run, hidden or shown again (G1)
          const fus = runs.filter((r) => r.node !== "r" && before.has(`followup:${r.node}`));
          if (fus.length) {
            const r = pick(fus);
            const hidden = before.has(`hide:followup:${r.node}`);
            const item = `f:${r.th}:${r.node}`;
            what = `mona: ${hidden ? "show" : "hide"} the follow-up ${r.node}`;
            const a = await w.as("mona", "moderation.decide", {
              item,
              decision: hidden ? "shown" : "hidden",
              base: w.item(item),
            });
            if (a.ok) count(`step ${hidden ? "show" : "hide"} a follow-up`);
            // the other person asks under the same thread: a run whose claim
            // must leave the hidden follow-up out (G1)
            if (a.ok && !hidden) {
              const u = r.u === "mel" ? "otto" : "mel";
              const id = w.id();
              const b = await w.as(u, "research.forkNode", {
                id,
                thread: r.th,
                parent: "r",
                q: `F-${u}-${id}`,
                executor: { kind: "device", cli: "claude", device: devices.get(u) },
              });
              if (b.ok)
                runs.push({
                  id: (b.result as Any).run,
                  u,
                  device: devices.get(u) as string,
                  th: r.th,
                  node: id,
                  attempt: 1,
                  until: null,
                });
            }
          }
        } else if (kind === "ban") {
          const banned = before.has(`ban:${open}:mel`);
          what = `mona: ${banned ? "unban" : "ban"} mel in the open space`;
          await w.as("mona", banned ? "members.unban" : "members.ban", {
            space: open,
            user: "mel",
          });
          if (banned) await w.as("mel", "spaces.join", { space: open });
          // a ban, of a member or of a person who left, ends mel's device
          // runs there in its commit (G3)
          else
            for (const r of w.server.dump().values())
              if (
                r.kind === "run" &&
                (r as Any).s === open &&
                (r as Any).u === "mel" &&
                (r as Any).executor &&
                live(r)
              )
                fail(step, what, `mel's device run ${(r as Any).id} is still live after the ban`);
        } else if (kind === "remove") {
          const member = before.has(`member:${closed}:otto`);
          what = member
            ? "olga removes otto from the closed space"
            : "otto is let into the closed space";
          if (member)
            await w.as("olga", "members.remove", {
              space: closed,
              user: "otto",
              base: w.admission(closed, "otto"),
            });
          else {
            await w.as("otto", "joinRequests.create", { space: closed, rulesAccepted: true });
            await w.as("olga", "joinRequests.decide", {
              space: closed,
              users: ["otto"],
              decision: "approve",
              base: w.requests(closed, ["otto"]),
            });
          }
        } else if (kind === "leave") {
          // otto leaves the closed space (the remove step lets him in
          // again), or mel the open space, where he may still ask and a ban
          // finds him no member
          if (before.has(`member:${closed}:otto`) && rand() < 0.6) {
            what = "otto leaves the closed space";
            const a = await w.as("otto", "spaces.leave", { space: closed });
            if (a.ok) count("step leave");
          } else if (before.has(`member:${open}:mel`)) {
            what = "mel leaves the open space";
            const a = await w.as("mel", "spaces.leave", { space: open });
            if (a.ok) count("step leave");
          } else if (!before.has(`ban:${open}:mel`)) {
            what = "mel joins the open space again";
            await w.as("mel", "spaces.join", { space: open });
          }
        } else if (kind === "rerun") {
          // the person runs their ask again: a new run of the same ask (of a
          // thread's own ask, a server job)
          const r = runs.length ? pick(runs) : null;
          if (r && r.node !== "r") {
            const f = before.get(`followup:${r.node}`) as Any;
            what = `${r.u}: followups.update with run on ${r.node}`;
            if (f) {
              const a = await w.as(r.u, "followups.update", {
                thread: r.th,
                node: r.node,
                q: `${f.q}+`,
                run: true,
                base: { rev: f.rev },
              });
              // (the new run is a server job; the device's run is cancelled)
              void a;
            }
          } else if (r) {
            const p = before.get(`thread:${r.th}`) as Any;
            what = `${r.u}: threads.update with run on ${r.th}`;
            if (p)
              await w.as(r.u, "threads.update", {
                id: r.th,
                q: `${p.q}+`,
                run: true,
                base: { rev: p.rev },
              });
          }
        } else if (kind === "revoke" && rand() < 0.25) {
          // a person signs a device out and another in
          const u = pick(["mel", "otto"]);
          const d = devices.get(u) as string;
          what = `${u}: devices.revoke ${d}`;
          const a = (await on.call({ u }, "devices.revoke", { id: d })) as Any;
          if (!a.ok) fail(step, what, JSON.stringify(a));
          revoked.add(d);
          await signIn(u);
          count("step revoke");
          for (const r of w.server.dump().values())
            if (r.kind === "run" && (r as Any).executor?.device === d && live(r))
              fail(step, what, `the run ${(r as Any).id} of the revoked device is still live`);
        } else if (kind === "archive" && rand() < 0.3) {
          const was = archived(before, open);
          what = `olga: ${was ? "unarchive" : "archive"} the open space`;
          const a = await w.as("olga", "spaces.archive", { id: open, archived: !was });
          if (a.ok) count(`step ${was ? "unarchive" : "archive"}`);
          if (a.ok && !was)
            for (const r of w.server.dump().values())
              if (r.kind === "run" && (r as Any).s === open && (r as Any).executor && live(r))
                fail(step, what, `the device run ${(r as Any).id} is still live`);
        } else if (kind === "tick") {
          what = "housekeeping on its timer";
          on.tick();
        }
        for (const st of streams) await drain(st, step, what);
        // the anonymous reader of the open space gets each turn's text there
        // when it reads the turn's node as stored
        const anon = streams[0] as Stream;
        const got = new Set(
          (await anon.handle.events()).flatMap((e) => (e.type === "run" ? [e.text] : [])),
        );
        const dump = w.server.dump();
        for (const x of turnTexts.splice(0))
          if (x.sp === open && readsText(dump, dump.get(`run:${x.run}`), null) && !got.has(x.text))
            fail(step, what, `the open space's reader missed the turn ${x.text}`);
      }
      for (const st of streams) await st.handle.close();
      w.clock.advance(DAY);
    }
    const kinds = new Map<string, string>();
    for (const f of failures) {
      const k = f
        .replace(/^seed \d+, step -?\d+ \([^)]*\): /, "")
        .replace(/[0-9A-Z]{26}|TURN-\d+|ANS-\d+|\d+/g, "#");
      if (!kinds.has(k)) kinds.set(k, f);
    }
    t.deepEqual([...kinds.values()], [], `${failures.length} failures`);
    // the history reached the calls it checks, ok and refused
    t.log(
      [...stats]
        .sort()
        .map(([k, v]) => `${k}: ${v}`)
        .join(", "),
    );
    for (const k of [
      "runs.claim ok",
      "runs.heartbeat ok",
      "runs.turn ok",
      "runs.finish ok",
      "step ask",
      "step edge",
      "step hide a follow-up",
      "step leave",
      "step revoke",
      "step archive",
    ])
      t.true((stats.get(k) ?? 0) > 0, k);
    t.true(
      [...stats].some(([k, v]) => k.startsWith("runs.finish ") && !k.endsWith(" ok") && v > 0),
      "a refused finish",
    );
    t.true(
      [...stats].some(([k, v]) => k.includes("(browser) FORBIDDEN") && v > 0),
      "a browser session refused",
    );
  });
