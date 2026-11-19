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
// - a stream sends a run's text only to a reader who may read the run, and
//   every turn's text to a reader of the open space;
// - a stream pokes for a log only when what its reader may read of it
//   changed, apart from one poke for a token that does not open (after which
//   the log leaves the stream).
// It runs where the server under test has online calls (`TestServer.online`,
// the `@session/sync` server half); the prototype has none.

import test from "ava";

import type { LogId, StoredRecord, StreamEvent } from "../src/index.js";

import { DAY, cast, ok, rng, type World } from "./harness.js";
import { expected, mayRead, mayRun, readableTexts } from "./oracle.js";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-assignment -- call results are read as `any` */
type Any = any;

const LEASE = 90_000;
const SEEDS = Number(process.env["ONLINE_SEEDS"] ?? 12);
const STEPS = 90;

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

const viewOf = (w: World, reader: string | null, log: LogId) =>
  JSON.stringify([...expected(w.server.dump(), reader, log)].sort(([a], [b]) => (a < b ? -1 : 1)));

for (let s0 = 1; s0 <= SEEDS; s0 += 4)
  test(`online calls and the stream match the read oracle: seeds ${s0} to ${Math.min(SEEDS, s0 + 3)}`, async (t) => {
    const stats = new Map<string, number>();
    for (let seed = s0; seed <= Math.min(SEEDS, s0 + 3); seed++) {
      const { w, open, closed } = await cast(t, seed);
      const on = w.server.online;
      if (!on) return t.pass("the server under test has no online calls");
      const rand = rng(seed * 7919);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
      const fail = (step: number, what: string, detail: string) =>
        t.fail(`seed ${seed}, step ${step} (${what}): ${detail}`);

      // devices for mel and otto, signed in from the browser
      const devices = new Map<string, string>();
      for (const u of ["mel", "otto"]) {
        const a = (await on.call(null, "devices.authorize", { name: `${u}'s mac` })) as Any;
        await on.call({ u }, "devices.approve", { request: a.result.request });
        const c = (await on.call(null, "devices.token", { request: a.result.request })) as Any;
        if (!c.ok) return t.fail(`seed ${seed}: device sign-in: ${JSON.stringify(c)}`);
        devices.set(u, c.result.device);
      }
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
      const openStream = async (reader: string | null, tokens: [LogId, string, boolean][]) => {
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
      const honest = async (reader: string | null, log: LogId): Promise<[LogId, string, boolean]> => [
        log,
        (await w.server.snapshot(reader === null ? null : { u: reader }, log)).cursor,
        true,
      ];
      const ottoUser = (await w.server.snapshot({ u: "otto" }, "user:otto")).cursor;
      await openStream(null, [await honest(null, `space:${open}`), [`space:${closed}`, "x", false]]);
      await openStream("otto", [
        await honest("otto", `space:${open}`),
        await honest("otto", `space:${closed}`),
        ["user:mel", ottoUser, false],
      ]);
      await openStream("mel", [
        await honest("mel", `space:${open}`),
        await honest("mel", `space:${closed}`),
        await honest("mel", "user:mel"),
      ]);
      await openStream("eve", [
        [`space:${closed}`, "garbage", false],
        ["user:mel", "garbage", false],
      ]);
      await openStream(null, [["user:otto", "garbage", false]]);
      // the connect pokes
      for (const st of streams) await drain(st, -1, "connect");

      const runs: Run[] = [];
      let n = 0;
      const turnTexts: { text: string; run: string; sp: string }[] = [];

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
            if (!r || !mayRead(dump, r, st.reader))
              fail(step, what, `${st.reader ?? "anon"} got the text of run ${e.run}, which it may not read`);
            continue;
          }
          for (const log of e.logs) {
            const opens = st.logs.get(log);
            if (opens === undefined) {
              fail(step, what, `${st.reader ?? "anon"} poked for ${log}, which its stream does not list`);
              continue;
            }
            const k = (st.pokes.get(log) ?? 0) + 1;
            st.pokes.set(log, k);
            const now = viewOf(w, st.reader, log);
            if (!opens) {
              if (k > 1)
                fail(step, what, `${st.reader ?? "anon"} poked again for ${log}, whose token does not open`);
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
          "claim",
          "claim",
          "beat",
          "turn",
          "turn",
          "finish",
          "finish",
          "wait",
          "wait",
          "hide",
          "ban",
          "remove",
          "rerun",
          "tick",
        ] as const);
        let what: string = kind;
        // a device run call, checked against the oracle
        const act = async (r: Run, name: string, extra: object) => {
          what = `${r.u}: ${name} ${r.id}`;
          const rec = before.get(`run:${r.id}`);
          const allowed = rec !== undefined && mayRun(before, rec, r.u);
          const running = (rec as Any)?.status === "running" && (rec as Any)?.attempt === r.attempt;
          const leased = r.until !== null && now() < r.until;
          const a = (await on.call({ u: r.u, device: r.device }, name, {
            run: r.id,
            device: r.device,
            ...extra,
          })) as Any;
          const tag = `${name} ${a.ok ? "ok" : a.error.code}`;
          stats.set(tag, (stats.get(tag) ?? 0) + 1);
          if (a.ok && !allowed)
            fail(step, what, `ok, though ${r.u} may not act on the run now: ${JSON.stringify(a)}`);
          if (a.ok && name !== "runs.claim" && !leased)
            fail(step, what, `ok after the lease ended at ${r.until} (now ${now()})`);
          if (name === "runs.turn" && allowed && running && leased && !a.ok)
            fail(step, what, `a turn on a run that holds its lease: ${JSON.stringify(a)}`);
          return a;
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
        } else if (kind === "claim" && mine.length) {
          const r = pick(mine);
          const a = await act(r, "runs.claim", {});
          if (a.ok) {
            r.until = now() + LEASE;
            const allowedTexts = readableTexts(before, r.th, r.u);
            for (const turn of a.result.turns as { q: string; a: string }[])
              for (const x of [turn.q, turn.a])
                if (x && !allowedTexts.has(x))
                  fail(step, what, `served "${x}", which ${r.u} may not read`);
          }
        } else if (kind === "beat" && mine.length) {
          const r = pick(held());
          const a = await act(r, "runs.heartbeat", { attempt: r.attempt });
          if (a.ok) r.until = now() + LEASE;
        } else if (kind === "turn" && mine.length) {
          const r = pick(held());
          const text = `TURN-${n++}`;
          const a = await act(r, "runs.turn", { attempt: r.attempt, turn: text });
          if (a.ok) turnTexts.push({ text, run: r.id, sp: (before.get(`run:${r.id}`) as Any).s });
        } else if (kind === "finish" && mine.length) {
          const r = pick(held());
          const text = `ANS-${n++}`;
          const nodeKey = r.node === "r" ? `thread:${r.th}` : `followup:${r.node}`;
          const node = before.get(nodeKey) as Any;
          const a = await act(r, "runs.finish", { attempt: r.attempt, answer: text });
          const after = w.server.dump().get(nodeKey) as Any;
          const wrote = after && (after.a === text || after.sum === text);
          if (wrote && node?.att !== r.attempt)
            fail(step, what, `the answer of attempt ${r.attempt} landed on attempt ${node?.att}`);
          if (wrote && !a.ok) fail(step, what, "a refused finish wrote its answer");
        } else if (kind === "wait") {
          const ms = Math.floor(rand() < 0.8 ? rand() * 40_000 : 100_000 + rand() * 100_000);
          what = `wait ${ms} ms`;
          w.clock.advance(ms);
        } else if (kind === "hide") {
          const th = pick(threads);
          const hidden = before.has(`hide:thread:${th.id}`);
          const mod = th.s === open ? "mona" : "mona";
          what = `${mod}: ${hidden ? "show" : "hide"} ${th.id}`;
          await w.as(mod, "moderation.decide", {
            item: `a:${th.id}`,
            decision: hidden ? "shown" : "hidden",
            base: w.item(`a:${th.id}`),
          });
        } else if (kind === "ban") {
          const banned = before.has(`ban:${open}:mel`);
          what = `mona: ${banned ? "unban" : "ban"} mel in the open space`;
          await w.as("mona", banned ? "members.unban" : "members.ban", { space: open, user: "mel" });
          if (banned) await w.as("mel", "spaces.join", { space: open });
        } else if (kind === "remove") {
          const member = before.has(`member:${closed}:otto`);
          what = member ? "olga removes otto from the closed space" : "otto is let into the closed space";
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
        } else if (kind === "rerun") {
          // the person runs their follow-up again: a new run of the same ask
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
              if (a.ok)
                runs.push({
                  ...r,
                  id: (a.result as Any).run,
                  attempt: f.att + 1,
                  until: null,
                  device: r.device,
                });
            }
          }
        } else if (kind === "tick") {
          what = "housekeeping on its timer";
          on.tick();
        }
        for (const st of streams) await drain(st, step, what);
        // the anonymous reader of the open space gets each turn's text there
        const anon = streams[0] as Stream;
        const got = new Set(
          (await anon.handle.events()).flatMap((e) => (e.type === "run" ? [e.text] : [])),
        );
        for (const x of turnTexts.splice(0))
          if (x.sp === open && !got.has(x.text))
            fail(step, what, `the open space's reader missed the turn ${x.text}`);
        void (before as ReadonlyMap<string, StoredRecord>);
      }
      for (const st of streams) await st.handle.close();
      w.clock.advance(DAY);
    }
    // the history reached the calls it checks, ok and refused
    t.log([...stats].sort().map(([k, v]) => `${k}: ${v}`).join(", "));
    for (const k of ["runs.claim ok", "runs.heartbeat ok", "runs.turn ok", "runs.finish ok"])
      t.true((stats.get(k) ?? 0) > 0, k);
    t.true(
      [...stats].some(([k, v]) => k.startsWith("runs.finish ") && !k.endsWith(" ok") && v > 0),
      "a refused finish",
    );
  });
