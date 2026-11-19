// The server's job runner (phase 2a): `@session/sync`'s effect worker hands
// it the jobs the mutators queued (`JobRunner.start`), and it runs them.
// - `run`: a run of an ask with the included tokens (an owned agent loop; a
//   device run is its device's, never a server job). It goes to `run_queue`
//   and starts when the caps allow: per user, per provider, the daily limits
//   when enforced. The payer is chosen when it starts (`payerFor`: the ask's
//   payer, else the included tokens, then the asker's default API key), and
//   a user's key is decrypted for the provider call it pays. A 429 requeues
//   with backoff (MAX_RATE_LIMIT_REQUEUES), then ends the run `rate`.
// - `key`: an API key check with its provider (`keyChecked`).
// - `domain`: a space's DNS check (`domainChecked`).
// Boot recovery: a run running when the process stopped (claimed in
// `run_queue`) is resumed, at most MAX_RESUMES times, else ended
// `interrupted`. The effect worker and housekeeping run on timers here too.

import { resolveTxt } from "node:dns/promises";

import type { KeyCipher, SessionDatabase } from "@session/db";
import {
  apiKeys,
  nextUtcMidnight,
  preferences,
  runs as runsRepo,
  usage as usageRepo,
  users as usersRepo,
} from "@session/db";
import type { JobKind } from "@session/mutators";
import { DEFAULT_MODEL_ID, findModel } from "@session/shared";
import type { JobRunner, SyncServer } from "@session/sync/server";

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { payerFor } from "../sync/account.js";

import { backoffFor, MAX_RATE_LIMIT_REQUEUES } from "./errors.js";
import { runAttempt, type AttemptResult, type LoopDeps } from "./loop.js";
import type { Providers } from "./providers.js";
import { createProviders } from "./providers.js";
import { createToolCaches } from "./tools/context.js";
import type { RunToolContext } from "./tools/context.js";

/** Automatic resumes of one run after restarts, before it ends. */
export const MAX_RESUMES = 2;
/** How often the queue is looked at with nothing else waking it. */
export const TICK_MS = 250;
/** How often the effect worker runs on a timer. */
export const WORK_MS = 500;

export interface RunsService extends JobRunner {
  cancel(run: string): void;
  /** Look at the queue now. */
  tick(): void;
  /** Boot: resume or end the runs that were running when the process
   * stopped. */
  recover(): void;
  /** Start the timers: the effect worker, housekeeping and the queue. */
  startTimers(): void;
  /** SIGTERM: stop admitting, stop the timers, let open attempts end
   * `interrupted` (resumed by the next process). */
  drain(): Promise<void>;
  /** Tests: resolves when no attempt or check is running. */
  idle(): Promise<void>;
}

export interface RunsServiceDeps {
  config: Config;
  db: SessionDatabase;
  sync: SyncServer;
  /** The API keys' encryption, to decrypt a key that pays. */
  keys: KeyCipher;
  logger: Logger;
  fetch?: typeof globalThis.fetch;
  providers?: Providers;
  toolOverrides?: Pick<RunToolContext, "lookup" | "allowHosts">;
  /** Tests: no timers and no automatic ticks. */
  autoStart?: boolean;
  /** A key check (default: the provider's, or by the fixture rule). */
  checkKey?: (provider: string, raw: string) => Promise<string | null>;
  /** A domain check (default: a DNS TXT lookup, or by the fixture rule). */
  checkDomain?: (domain: string, space: string) => Promise<boolean>;
}

/** The fixture rule for key checks (the mock's `keyVerdict`): a key with
 * "revoked" or "expired" in it is rejected. */
export const fixtureKeyVerdict = (raw: string): string | null =>
  /revoked/i.test(raw) ? "it was revoked" : /expired/i.test(raw) ? "it has expired" : null;

/** A key check against its provider: null when it is accepted, else why. */
async function providerKeyCheck(
  fetchImpl: typeof globalThis.fetch,
  provider: string,
  raw: string,
): Promise<string | null> {
  const req: Record<string, [string, Record<string, string>]> = {
    Anthropic: [
      "https://api.anthropic.com/v1/models",
      { "x-api-key": raw, "anthropic-version": "2023-06-01" },
    ],
    OpenRouter: ["https://openrouter.ai/api/v1/key", { Authorization: `Bearer ${raw}` }],
    OpenAI: ["https://api.openai.com/v1/models", { Authorization: `Bearer ${raw}` }],
    Google: [
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(raw)}`,
      {},
    ],
  };
  const r = req[provider];
  if (!r) return "the provider is not known";
  const res = await fetchImpl(r[0], { headers: r[1], signal: AbortSignal.timeout(15_000) });
  if (res.ok) return null;
  return res.status === 401 || res.status === 403
    ? "the provider rejected it"
    : `the provider answered ${res.status}`;
}

/** The provider whose user keys can pay for a model's calls. */
const KEY_PROVIDER: Record<string, string> = { anthropic: "Anthropic", openrouter: "OpenRouter" };

export function createRunsService(deps: RunsServiceDeps): RunsService {
  const { config, db, sync, logger } = deps;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const providers =
    deps.providers ?? createProviders(config, deps.fetch ? { fetch: deps.fetch } : {});
  const caches = createToolCaches();
  const loopDeps: LoopDeps = {
    config,
    db,
    sync,
    logger,
    caches,
    fetch: fetchImpl,
    ...(deps.toolOverrides ? { toolOverrides: deps.toolOverrides } : {}),
  };
  const active = new Map<string, AbortController>();
  const pending = new Set<Promise<unknown>>();
  const timers: ReturnType<typeof setInterval>[] = [];
  let stopHousekeeping: (() => void) | null = null;
  let draining = false;
  let tickQueued = false;

  const track = <T>(p: Promise<T>): Promise<T> => {
    pending.add(p);
    void p.finally(() => pending.delete(p));
    return p;
  };

  const soon = () => {
    if (deps.autoStart === false || tickQueued || draining) return;
    tickQueued = true;
    setImmediate(() => {
      tickQueued = false;
      service.tick();
    });
  };

  const checkKey =
    deps.checkKey ??
    ((provider: string, raw: string) =>
      providers.fixtures
        ? Promise.resolve(fixtureKeyVerdict(raw))
        : providerKeyCheck(fetchImpl, provider, raw));
  const checkDomain =
    deps.checkDomain ??
    (async (domain: string, space: string) => {
      if (providers.fixtures) return !/\.test$/i.test(domain);
      try {
        const records = await resolveTxt(`_session.${domain}`);
        return records.some((r) => r.join("") === `session-verify=${space}`);
      } catch {
        return false;
      }
    });

  const runKeyCheck = async (id: string) => {
    const row = apiKeys.get(db, id);
    if (!row) return;
    let reason: string | null;
    try {
      reason = await checkKey(row.provider, apiKeys.raw(db, deps.keys, id) ?? "");
    } catch (error) {
      logger.warn({ error, keyId: id }, "an API key check failed");
      reason = "the provider could not be reached";
    }
    if (sync.keyChecked(id, reason === null)) apiKeys.setReason(db, id, reason);
  };

  const runDomainCheck = async (space: string) => {
    const s = sync.viewOf(`space:${space}`, null);
    if (s?.kind !== "space" || s.dom?.state !== "checking") return;
    const domain = s.dom.domain;
    sync.domainChecked(space, domain, await checkDomain(domain, space));
  };

  /** One attempt of a claimed row. */
  const begin = async (runId: string, userId: string, resume: boolean) => {
    const run = sync.runJobs.get(runId);
    const user = usersRepo.findById(db, userId);
    if (!run || !user || run.executor !== null) {
      runsRepo.release(db, runId);
      return;
    }
    // the daily limits, when enforced: wait for the next UTC day
    if (config.limits.enforceDailyLimits && !resume) {
      const d = usageRepo.admissionCheck(db, userId, {
        isAdmin: user.isAdmin,
        defaults: { dailyTokens: config.limits.dailyTokens, dailyRuns: config.limits.dailyRuns },
      });
      if (!d.allowed) {
        runsRepo.requeue(db, runId, nextUtcMidnight(Date.now()));
        return;
      }
    }
    const modelId = run.model ?? DEFAULT_MODEL_ID;
    const entry = findModel(modelId);
    const payer = payerFor(db, sync, config, userId, user.handle, run.pay);
    const end = (why: "tokens" | "key" | "interrupted") => {
      if (sync.runJobs.start(runId).ok) sync.runJobs.fail(runId, run.attempt, why);
      runsRepo.release(db, runId);
    };
    if (!entry) return end("interrupted");
    if (!payer.ok) return end(payer.why);
    let key: { provider: string; raw: string } | undefined;
    if (payer.source.kind === "key") {
      const k = payer.source.key;
      if (!k || KEY_PROVIDER[entry.provider] !== k.provider) return end("key");
      const raw = apiKeys.raw(db, deps.keys, k.id);
      if (raw === null) return end("key");
      key = { provider: k.provider, raw };
      apiKeys.markUsed(db, k.id);
    }
    const resolved = providers.resolve(modelId, null, key);
    if (!resolved) return end(payer.source.kind === "key" ? "key" : "interrupted");
    const started = sync.runJobs.start(runId, payer.source.id);
    if (!started.ok) {
      runsRepo.release(db, runId);
      return;
    }
    const n = runsRepo.startAttempt(db, {
      runId,
      kind: resume || started.job.resumed ? "resume" : "fresh",
      model: modelId,
      payer: payer.source.id,
    });
    usageRepo.record(db, userId, {
      runId,
      spaceId: run.s,
      kind: "run",
      provider: entry.provider,
      model: modelId,
    });
    const controller = new AbortController();
    active.set(runId, controller);
    let result: AttemptResult;
    try {
      result = await runAttempt(loopDeps, {
        job: started.job,
        userId,
        resolved,
        payer: payer.source.id,
        paidByKey: payer.source.kind === "key",
        instruction: preferences.ensure(db, userId).researchLaunchInstruction,
        n,
        seqStart: runsRepo.get(db, runId)?.seq ?? 0,
        signal: controller.signal,
        isDraining: () => draining,
      });
    } catch (error) {
      logger.error({ error, runId }, "a run attempt threw");
      sync.runJobs.fail(runId, run.attempt, "interrupted");
      result = { outcome: "failed" };
    } finally {
      active.delete(runId);
    }
    if (result.outcome === "interrupted") return; // the next process resumes it
    if (result.outcome === "rate_limited") {
      const tries = runsRepo.attempts(db, runId).filter((a) => a.outcome === "rate_limited").length;
      const wait = tries <= MAX_RATE_LIMIT_REQUEUES ? backoffFor(tries - 1) : null;
      if (wait !== null) {
        runsRepo.requeue(db, runId, Date.now() + wait);
        return;
      }
      sync.runJobs.fail(runId, run.attempt, "rate");
    }
    runsRepo.release(db, runId);
  };

  const service: RunsService = {
    start(job: { kind: JobKind; id: string }) {
      if (draining) throw new Error("the server is draining");
      if (job.kind === "key") {
        void track(runKeyCheck(job.id));
        return;
      }
      if (job.kind === "domain") {
        void track(runDomainCheck(job.id));
        return;
      }
      const run = sync.runJobs.get(job.id);
      if (!run || run.executor !== null) return;
      if (run.status !== "queued" && run.status !== "running") return;
      const user = usersRepo.findByHandle(db, run.u);
      if (!user) {
        sync.runJobs.interrupt(job.id);
        return;
      }
      const entry = findModel(run.model ?? DEFAULT_MODEL_ID);
      runsRepo.enqueue(db, {
        runId: run.id,
        userId: user.id,
        provider: entry?.provider ?? "unknown",
      });
      soon();
    },

    cancel(runId: string) {
      active.get(runId)?.abort();
      if (!active.has(runId)) runsRepo.release(db, runId);
    },

    tick() {
      if (draining) return;
      const { byUser, byProvider } = runsRepo.runningCounts(db);
      const caps: Record<string, number> = {
        vertex: config.limits.vertex,
        openrouter: config.limits.openrouter,
        anthropic: config.limits.anthropic,
      };
      for (const row of runsRepo.waiting(db)) {
        if ((byUser.get(row.userId) ?? 0) >= config.limits.perUser) continue;
        if ((byProvider.get(row.provider) ?? 0) >= (caps[row.provider] ?? 8)) continue;
        if (!runsRepo.claim(db, row.runId)) continue;
        byUser.set(row.userId, (byUser.get(row.userId) ?? 0) + 1);
        byProvider.set(row.provider, (byProvider.get(row.provider) ?? 0) + 1);
        void track(begin(row.runId, row.userId, row.resumes > 0)).finally(soon);
      }
    },

    recover() {
      for (const row of runsRepo.claimed(db)) {
        const resumes = runsRepo.noteResume(db, row.runId);
        if (resumes > MAX_RESUMES) {
          sync.runJobs.interrupt(row.runId);
          runsRepo.release(db, row.runId);
          logger.warn({ runId: row.runId }, "ended a run that was interrupted too often");
        }
      }
      soon();
    },

    startTimers() {
      if (deps.autoStart === false) return;
      stopHousekeeping = sync.startHousekeeping();
      const work = setInterval(() => {
        try {
          sync.work();
        } catch (error) {
          logger.error({ error }, "the effect worker failed");
        }
      }, WORK_MS);
      const tick = setInterval(() => service.tick(), TICK_MS);
      work.unref();
      tick.unref();
      timers.push(work, tick);
    },

    async drain() {
      draining = true;
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      stopHousekeeping?.();
      stopHousekeeping = null;
      for (const c of active.values()) c.abort(new Error("draining"));
      await Promise.allSettled([...pending]);
    },

    async idle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
  return service;
}
