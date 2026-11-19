// The mutators, and the mock's procedures that are not mutators.

import { contentMutators } from "./defs/content.js";
import { memberMutators } from "./defs/members.js";
import { moderationMutators } from "./defs/moderation.js";
import { personalMutators } from "./defs/personal.js";
import { spaceMutators } from "./defs/spaces.js";
import { threadMutators } from "./defs/threads.js";
import { createRegistry, type Registry } from "./engine.js";

/** Every mutator, by name. */
export const MUTATORS: Registry = createRegistry([
  ...spaceMutators,
  ...threadMutators,
  ...memberMutators,
  ...moderationMutators,
  ...personalMutators,
  ...contentMutators,
]);

const KEYS =
  "API keys are account state, online only: the raw key must never wait in an outbox or reach a replica, and a key check is a server job. The server writes the key's `apikey` record (id, name, provider and status, never the raw key) to its person's user log, so a write paid by the key is checked in `can`.";

const RUNS =
  "A device's run call: it acts on the run's lease, which only the server holds (who holds it, until when, and the attempt), and it is meaningful only while the lease is the device's, so it is sent online by the device that runs the CLI and never waits in an outbox. The server writes the run record (status, lease, how it ended) and the answer.";

const DEVICES =
  "A device sign-in is account state (device tokens, kept in the macOS Keychain), online only: the server makes the token and the code, and a browser approves it.";

/** The mock's procedures that change state but are not mutators, and why.
 * Their state is not replicated, or is replicated as records the server
 * writes: the server half serves them as online-only calls. */
export const NOT_MUTATORS: Readonly<Record<string, string>> = {
  "apiKeys.create": KEYS,
  "apiKeys.replace": KEYS,
  "apiKeys.check": KEYS,
  "apiKeys.rename": KEYS,
  "apiKeys.setCap": KEYS,
  "apiKeys.revoke": KEYS,
  "usage.setDefaultKey":
    "Token usage is account state (a TODO(limits) stub), online only; it names an API key.",
  "usage.markMovedSeen": "Token usage is account state (a TODO(limits) stub), online only.",
  "settings.update":
    "Account settings, online only: a new email address waits for a confirmation the server sends, and an export is a server job.",
  "research.cancelNode":
    "A run control: it stops a server job (or a device run's lease) and charges what the run used so far, which only the job's state knows.",
  "research.retryNode":
    "A run control: it starts a server job again, and whether it may (the run is not running) is the job's state, which no replica holds. Its `executor` input picks a device run, as threads.create's does.",
  "runs.claim": `${RUNS} It takes a queued device run of the caller's on the device that sends it, starts a lease and a new attempt, and answers the thread's stored turns (no CLI session resumes).`,
  "runs.heartbeat": `${RUNS} It extends the lease; it is separate from progress (AGENTS.md), so a long tool call does not end the lease.`,
  "runs.turn": `${RUNS} It commits one turn of the attempt it names (attempt): a turn of an attempt that lost its lease is refused.`,
  "runs.finish": `${RUNS} It writes the attempt's answer, capped at 200 KB: a larger one is not saved and the run ends as too_large. A device answer reports no usage.`,
  "devices.authorize": `${DEVICES} The Desktop app starts a sign-in: the server answers a code to show and a link for the browser.`,
  "devices.approve": `${DEVICES} The signed-in browser approves a device sign-in, with the code the app shows (or with one click).`,
  "devices.revoke": `${DEVICES} Revoking a device ends its token; its unsent writes are refused (WRONG_CLIENT).`,
};
