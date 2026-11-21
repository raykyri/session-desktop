// The fixture replica (02 §9.6): the members mockup's fixtures, converted to
// the stored shape (`fixtureData.ts`), in a `MemoryReplica` that applies
// writes with the real mutators, and a scripted run executor that answers
// asks the way the mock does (`newThread`, `addBranch`, `addLookup`): the
// run is running at once ("Researching · Step 1 of 4") and complete with a
// mock answer 2.6 s later.
//
// This module is loaded only by builds that ask for the fixtures
// (`VITE_SESSION_FIXTURES=1`, the development server, the unit tests and the
// end-to-end build): `replica/config.ts` imports it dynamically behind a
// build-time constant, so no fixture text reaches a production bundle.

// Sets `window.SessionFixtures`.
import "../../../../../docs/mockups/session-web-spaces-fixtures.js";

import { isoToMs, msToIso, nodeKey, threadKey, type RunRec, type Draft } from "@session/mutators";

import type { Viewer } from "../features/shell/viewer.js";

import type { ReplicaConfig } from "./ReplicaProvider.js";
import {
  FIXTURE_ACCOUNTS,
  FIXTURE_MEMBER,
  FIXTURE_USAGE,
  FIXTURE_WAITING,
  convertFixtures,
  type FixtureWorld,
  type SessionFixtures,
} from "./fixtureData.js";
import { MemoryReplica } from "./memory.js";
import type { OnlineData } from "./online.js";
import { channelByName } from "./queries.js";
import { newUlid } from "./ulid.js";

/** How long a mock run takes, as in the mock. */
export const MOCK_RUN_MS = 2600;

let world: FixtureWorld | null = null;

function fixtureWorld(): FixtureWorld {
  if (world) return world;
  const F = (window as unknown as { SessionFixtures?: SessionFixtures }).SessionFixtures;
  if (!F) throw new Error("the mockup fixtures did not load");
  world = convertFixtures(F, document);
  return world;
}

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1).replace(/[\s,;:.]+\S*$/, "")}…` : s;

/** The mock's answers to a new ask, branch and look-up. */
function mockAnswer(q: string, look: string | null, root: boolean): string {
  if (look !== null)
    return `**${look}**: mock description. In the app, the agent describes what “${look}” refers to in this answer, with a source, in two or three sentences.`;
  if (root)
    return `Mock answer to "${clip(q, 90)}". In the app, the agent's answer appears here when the run finishes, and you can branch from any passage of it.`;
  return `Mock answer. In the app, the agent's answer to "${clip(q, 80)}" is stored here when the run finishes, and the branch count on the thread goes up by one.`;
}

export interface FixtureReplica extends MemoryReplica {
  /** Completes every run that is still going (tests). */
  flushRuns(): void;
  /** Stops the executor's timers. */
  /** Makes it one of the replicas `flushFixtureRuns` and the fixture
   * controls act on (the provider calls it on mount). */
  activate(): void;
  dispose(): void;
}

export interface FixtureReplicaOptions {
  /** How long a run takes; `null` leaves runs running until `flushRuns`. */
  runMs?: number | null;
}

/** Holding runs (tests and the end-to-end build): while `hold` is set, a
 * new run stays `queued` or `running` until `flush`. */
export const runControl: { hold: "queued" | "running" | null } = { hold: null };
const live = new Set<FixtureReplica>();

/** Completes every held or running run of every live fixture replica. */
export function flushFixtureRuns(): void {
  for (const replica of live) replica.flushRuns();
}

/** Writes `count` posts to the channel `name` in every live replica, as
 * the viewer, through `threads.create`. */
async function seedPosts(name: string, count: number): Promise<void> {
  for (const replica of live) {
    const space = channelByName(replica, name);
    if (!space) continue;
    for (let i = 1; i <= count; i++)
      await replica.mutate("threads.create", {
        id: newUlid(replica.now()),
        space: space.id,
        kind: "post",
        q: `Seeded post ${i}`,
      });
  }
}

/** `window.__sessionFixtures` in a fixture build, for the end-to-end specs:
 * `hold("running")` keeps new runs at "Researching", `hold("queued")` keeps
 * them queued, `flush()` answers them, `seedPosts(name, n)` writes `n`
 * posts to a channel. */
export function exposeFixtureControls(): void {
  (window as unknown as { __sessionFixtures?: unknown }).__sessionFixtures = {
    hold: (state: "queued" | "running" | null) => {
      runControl.hold = state;
    },
    flush: flushFixtureRuns,
    seedPosts,
  };
}

/** A fresh replica of the fixture world for `me` (null signed out). */
export function createFixtureReplica(
  me: string | null,
  options: FixtureReplicaOptions = {},
): FixtureReplica {
  const w = fixtureWorld();
  const loadedAt = Date.now();
  const replica = new MemoryReplica({
    me,
    clock: () => w.clock + (Date.now() - loadedAt),
    accounts: FIXTURE_ACCOUNTS,
  }) as FixtureReplica;
  replica.write(w.records);

  const runMs = options.runMs === undefined ? MOCK_RUN_MS : options.runMs;
  const timers = new Map<string, ReturnType<typeof setTimeout> | null>();
  const nowIso = () => msToIso(replica.now());

  const finish = (id: string) => {
    timers.delete(id);
    const run = replica.raw(`run:${id}`);
    if (run?.kind !== "run" || run.status !== "running") return;
    const thread = replica.raw(threadKey(run.th));
    if (thread?.kind !== "thread") return;
    const node = run.node === "r" ? null : replica.raw(nodeKey(run.node));
    if (run.node !== "r" && node?.kind !== "node") return;
    const tok = run.node === "r" ? 41_000 : 18_000;
    const q = node?.kind === "node" ? node.q : thread.q;
    const look = node?.kind === "node" ? node.look : null;
    const at = nowIso();
    const writes: Draft[] = [
      { ...run, status: "complete", step: 3, tok, bill: "included", finishedAt: at },
      {
        kind: "answer",
        node: run.node,
        th: run.th,
        s: run.s,
        u: run.u,
        md: mockAnswer(q, look, run.node === "r"),
        pages: [],
        tok,
        run: run.id,
        attempt: run.attempt,
        mod: null,
      },
    ];
    if (run.node === "r") writes.push({ ...thread, running: false, tok, updatedAt: at });
    replica.write(writes);
  };

  const start = (run: RunRec) => {
    const held = runControl.hold !== null || runMs === null;
    timers.set(run.id, held ? null : setTimeout(() => finish(run.id), runMs));
    if (runControl.hold === "queued") return;
    replica.write([{ ...run, status: "running", step: 0, startedAt: nowIso() }]);
  };

  replica.onCommit((keys) => {
    for (const key of keys) {
      if (!key.startsWith("run:")) continue;
      const run = replica.raw(key);
      if (run?.kind === "run" && run.status === "queued" && !timers.has(run.id)) start(run);
    }
  });

  replica.flushRuns = () => {
    for (const [id, timer] of [...timers]) {
      if (timer !== null) clearTimeout(timer);
      const run = replica.raw(`run:${id}`);
      if (run?.kind === "run" && run.status === "queued")
        replica.write([{ ...run, status: "running", step: 0, startedAt: nowIso() }]);
      finish(id);
    }
  };
  replica.activate = () => {
    live.add(replica);
  };
  replica.dispose = () => {
    live.delete(replica);
    for (const timer of timers.values()) if (timer !== null) clearTimeout(timer);
    timers.clear();
  };
  return replica;
}

/** The handle an account reads the fixtures as: a member as the mock's
 * default persona (@ines.v), an account without an invite as its waiting
 * one (@kofi.a); signed out, nobody. */
export function fixtureHandle(viewer: Viewer): string | null {
  if (viewer.kind === "signedOut") return null;
  return viewer.kind === "waiting" ? FIXTURE_WAITING : FIXTURE_MEMBER;
}

export function fixtureReplicaConfig(options: FixtureReplicaOptions = {}): ReplicaConfig {
  return {
    create: (viewer) => createFixtureReplica(fixtureHandle(viewer), options),
    online: fixtureOnlineData(),
  };
}

/** The online-only data the fixture build reads instead of the server's
 * `usage.get` and `models.list` (02 §9.1): the mock's usage of @ines.v, and
 * the registry with the mock's site defaults. */
export function fixtureOnlineData(): Partial<OnlineData> {
  return {
    usage: {
      used: FIXTURE_USAGE.used,
      allowance: FIXTURE_USAGE.allowance,
      resetsAt: isoToMs(FIXTURE_USAGE.resetsAt),
    },
    defaultModel: "claude-fable",
    defaultEffort: "high",
  };
}
