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

/** The mock's procedures that change state but are not mutators, and why.
 * Their state is not replicated: the server half serves them as online-only
 * calls. */
export const NOT_MUTATORS: Readonly<Record<string, string>> = {
  "apiKeys.create":
    "API keys are account state, online only: the raw key must never wait in an outbox or reach a replica, and the key check is a server job.",
  "apiKeys.replace": "API keys are account state, online only (see apiKeys.create).",
  "apiKeys.check": "API keys are account state, online only; the check is a server job.",
  "apiKeys.rename": "API keys are account state, online only (see apiKeys.create).",
  "apiKeys.setCap": "API keys are account state, online only (see apiKeys.create).",
  "apiKeys.revoke": "API keys are account state, online only (see apiKeys.create).",
  "usage.setDefaultKey":
    "Token usage is account state (a TODO(limits) stub), online only; it names an API key.",
  "usage.markMovedSeen": "Token usage is account state (a TODO(limits) stub), online only.",
  "settings.update":
    "Account settings, online only: a new email address waits for a confirmation the server sends, and an export is a server job.",
  "research.cancelNode":
    "A run control: it stops a server job and charges what the run used so far, which only the job's state knows.",
  "research.retryNode":
    "A run control: it starts a server job again, and whether it may (the run is not running) is the job's state, which no replica holds.",
};

/** Mutator names that replace a mock procedure of another name. */
export const RENAMED: Readonly<Record<string, string>> = {
  "likes.toggle": "likes.set",
  "likes.toggleReply": "likes.setReply",
  "saved.toggle": "saved.set",
};
