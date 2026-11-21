// Members' own Anthropic and OpenAI keys
// (`15-implementation-plan/03-agents-and-research.md` K4, K7; ADR-23).
//
// `apiKeys.set` checks the key's format, then lists the provider's models
// during the request (a call that spends no tokens) with a 10 s timeout. A
// key the provider rejects is refused, and so is a timeout or a network
// error; nothing is saved in either case and nothing is queued to check
// later. An accepted key is sealed under `SESSION_SECRET_KEY`, bound to its
// owner and provider (`secretBox.ts`), and saved `valid`. It is opened only
// for the duration of a provider call (`openValid`, read by the run loop
// through `Allowances`), never logged and never returned: reads return the
// provider, the last four characters and the status.
//
// A key a provider rejects during a run becomes `invalid` (`keyRejected`,
// called by the run loop, `03` E5). Removing the Anthropic key, or its
// becoming invalid, sets the member's billing to `pause` (K7).

import type { SessionDatabase } from "@session/db";
import { apiKeys as keyRepo, billing as billingRepo } from "@session/db";
import type { ApiKeyProvider, ApiKeyStatus } from "@session/shared";
import {
  apiKeyFormatError,
  apiKeyRejectedMessage,
  apiKeyUnreachableMessage,
} from "@session/shared";
import { TRPCError } from "@trpc/server";

import type { Logger } from "../logger.js";
import type { MemberKey } from "../runs/allowance.js";
import type { SecretBox } from "../secretBox.js";

/** How long `apiKeys.set` waits for the provider (`03` K4). */
export const KEY_CHECK_TIMEOUT_MS = 10_000;

/** The model list each provider answers for a key: no tokens are spent. */
export const PROVIDER_MODELS_URL: Readonly<Record<ApiKeyProvider, string>> = {
  anthropic: "https://api.anthropic.com/v1/models",
  openai: "https://api.openai.com/v1/models",
};

/** The Messages API version header Anthropic requires on every request. */
const ANTHROPIC_VERSION = "2023-06-01";

export type KeyCheck = "accepted" | "rejected" | "unreachable";

function checkRequest(provider: ApiKeyProvider, raw: string): RequestInit {
  return provider === "anthropic"
    ? { headers: { "x-api-key": raw, "anthropic-version": ANTHROPIC_VERSION } }
    : { headers: { authorization: `Bearer ${raw}` } };
}

/**
 * Lists `provider`'s models with `raw`: `accepted` on a 2xx, `rejected` on
 * 401 or 403 (the providers' answers to an unknown, revoked or
 * unauthorised key; at save a 403 also refuses, `03` K4), `unreachable` on
 * a timeout, a network error, a redirect (never followed: the key would go
 * with it) or any other status (a 429 or a 5xx says nothing about the key).
 */
export async function checkWithProvider(
  provider: ApiKeyProvider,
  raw: string,
  options: { fetch: typeof globalThis.fetch; timeoutMs?: number },
): Promise<KeyCheck> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? KEY_CHECK_TIMEOUT_MS);
  let response: Response;
  try {
    response = await options.fetch(PROVIDER_MODELS_URL[provider], {
      ...checkRequest(provider, raw),
      method: "GET",
      redirect: "error",
      signal,
    });
  } catch {
    return "unreachable";
  }
  // The body is not read: the status is the answer.
  void response.body?.cancel().catch(() => undefined);
  if (response.ok) return "accepted";
  if (response.status === 401 || response.status === 403) return "rejected";
  return "unreachable";
}

/** A stored key as every read returns it. */
export interface ApiKeyView {
  provider: ApiKeyProvider;
  last4: string;
  status: ApiKeyStatus;
  addedAt: number;
}

/** A key opened for one provider call. `sealed` identifies the stored value,
 * so a rejection marks this key and not one the member saved since. */
export type OpenedKey = MemberKey;

export interface ApiKeysDeps {
  db: SessionDatabase;
  box: SecretBox;
  fetch: typeof globalThis.fetch;
  logger: Logger;
  /** `KEY_CHECK_TIMEOUT_MS` outside tests. */
  timeoutMs?: number;
  now?: () => number;
}

/** What the sealed value is bound to: its owner and provider. */
export function keyContext(userId: string, provider: ApiKeyProvider): string {
  return `api-key:${userId}:${provider}`;
}

/** Whether a stored row opens under the configured secret key and its
 * owner's context. */
function opens(deps: Pick<ApiKeysDeps, "box">, row: keyRepo.StoredApiKey): boolean {
  try {
    deps.box.open(row.sealed, keyContext(row.userId, row.provider));
    return true;
  } catch {
    return false;
  }
}

/** A row as reads return it. A `valid` row that no longer opens (the secret
 * key changed) reads `invalid`: it cannot pay for anything. */
function view(deps: Pick<ApiKeysDeps, "box">, row: keyRepo.StoredApiKey): ApiKeyView {
  return {
    provider: row.provider,
    last4: row.last4,
    status: row.status === "valid" && opens(deps, row) ? "valid" : "invalid",
    addedAt: row.createdAt,
  };
}

export function listKeys(deps: Pick<ApiKeysDeps, "db" | "box">, userId: string): ApiKeyView[] {
  return keyRepo.list(deps.db, userId).map((row) => view(deps, row));
}

/** The sealed value of the member's `valid` key for `provider`, or null: a
 * status check that decrypts nothing (the run loop's per-step check and the
 * payer at start, `03` K4, K8). */
export function validSealed(
  deps: Pick<ApiKeysDeps, "db">,
  userId: string,
  provider: ApiKeyProvider,
): string | null {
  const row = keyRepo.find(deps.db, userId, provider);
  return row?.status === "valid" ? row.sealed : null;
}

/**
 * Checks and saves `raw` as the member's `provider` key (`apiKeys.set`).
 * Refusals, none of which saves anything: `BAD_REQUEST` with the format
 * message; `BAD_REQUEST` "That key was rejected by <Provider>."; and
 * `BAD_GATEWAY` "Couldn't reach <Provider> to check the key. Try again."
 */
export async function setKey(
  deps: ApiKeysDeps,
  userId: string,
  provider: ApiKeyProvider,
  given: string,
): Promise<ApiKeyView> {
  const raw = given.trim();
  const formatError = apiKeyFormatError(provider, raw);
  if (formatError !== null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: formatError });
  }
  const checked = await checkWithProvider(provider, raw, {
    fetch: deps.fetch,
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  });
  // Ids and outcomes only: never the key, nor any part of it.
  deps.logger.info({ userId, provider, checked }, "api key checked");
  if (checked === "rejected") {
    throw new TRPCError({ code: "BAD_REQUEST", message: apiKeyRejectedMessage(provider) });
  }
  if (checked === "unreachable") {
    throw new TRPCError({ code: "BAD_GATEWAY", message: apiKeyUnreachableMessage(provider) });
  }
  const sealed = deps.box.seal(raw, keyContext(userId, provider));
  const saved = keyRepo.save(
    deps.db,
    { userId, provider, sealed, last4: raw.slice(-4) },
    (deps.now ?? Date.now)(),
  );
  return view(deps, saved);
}

/** Deletes the member's key (`apiKeys.remove`). Without an Anthropic key
 * billing cannot be `key`, so removing it returns billing from `key` to
 * `pause` (`03` K7); removing the OpenAI key leaves billing as it is. A
 * running attempt paid by the removed key stops at its next step (the run
 * loop's per-step check). */
export function removeKey(
  deps: Pick<ApiKeysDeps, "db" | "logger">,
  userId: string,
  provider: ApiKeyProvider,
): boolean {
  const removed = keyRepo.remove(deps.db, userId, provider);
  if (provider === "anthropic" && billingRepo.get(deps.db, userId) === "key") {
    billingRepo.set(deps.db, userId, "pause");
  }
  if (removed) {
    deps.logger.info({ userId, provider }, "api key removed");
  }
  return removed;
}

/** The member's `valid` key for `provider`, opened for one call; null when
 * there is none, it is `invalid`, or it does not open (the secret key
 * changed). */
export function openValid(
  deps: Pick<ApiKeysDeps, "db" | "box" | "logger">,
  userId: string,
  provider: ApiKeyProvider,
): OpenedKey | null {
  const row = keyRepo.find(deps.db, userId, provider);
  if (row?.status !== "valid") return null;
  try {
    return { apiKey: deps.box.open(row.sealed, keyContext(userId, provider)), sealed: row.sealed };
  } catch {
    deps.logger.warn({ userId, provider }, "a stored api key does not open with the secret key");
    return null;
  }
}

/**
 * A provider rejected the member's key during a run (`03` K4, E5): the key
 * becomes `invalid`, unless the member has saved another since `opened` was
 * read. An invalid Anthropic key cannot pay, so billing returns to `pause`
 * (`03` K7). True when the stored key changed.
 */
export function keyRejected(
  deps: Pick<ApiKeysDeps, "db" | "logger" | "now">,
  userId: string,
  provider: ApiKeyProvider,
  opened: Pick<OpenedKey, "sealed">,
): boolean {
  const changed = keyRepo.markInvalid(
    deps.db,
    userId,
    provider,
    opened.sealed,
    (deps.now ?? Date.now)(),
  );
  if (changed) {
    if (provider === "anthropic" && billingRepo.get(deps.db, userId) === "key") {
      billingRepo.set(deps.db, userId, "pause");
    }
    deps.logger.info({ userId, provider }, "api key rejected during a run");
  }
  return changed;
}
