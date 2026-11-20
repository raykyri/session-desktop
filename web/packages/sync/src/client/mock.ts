// The client half against the mockup's mock backend
// (`docs/mockups/session-web-spaces-mock-api.js`): a transport that speaks
// its write envelope endpoints (`POST /api/sync/register`, `POST
// /api/sync/write`) and maps their answers to the protocol's. The mockup's
// `?sync=1` mode drives its outbox screens with a `SyncClient` over it
// (`npm run mockup:bundle` builds the page's bundle). The mock has no change
// logs, so reads are not served: the page keeps its own collections, and the
// collection changes an answer carries go to `onChanges`.

import type { LogId } from "@session/mutators";

import type { Answer, AnswerError, CallAnswer, Envelope, RegisterAnswer } from "../protocol.js";

import { NO_RESPONSE, Offline, type PushResult, type Transport } from "./transport.js";

/** A request to the mock: its answer's status and decoded body, or a throw
 * (no answer). */
export type MockPost = (
  path: string,
  body: unknown,
) => Promise<{ ok: boolean; status: number; body: Record<string, unknown> }>;

const num = (v: unknown, d = 0) => (typeof v === "number" ? v : d);

/** The mock's answer as the protocol's: `{ result, changes, seq,
 * serverTime, replayed, recordedAs }` or an error body `{ code, message,
 * issues, expectedSeq, retryAt, current, changes, seq, serverTime,
 * replayed, recordedAs }`. Its `changes`
 * are the page's collection changes, not log changes: they go to
 * `onChanges` and are left out of the answer. */
export function fromMock(
  r: { ok: boolean; body: Record<string, unknown> },
  onChanges: (changes: unknown) => void,
): Answer {
  const b = r.body;
  if (b["changes"] !== undefined) onChanges(b["changes"]);
  const serverTime = num(b["serverTime"]);
  const extra = {
    ...(typeof b["seq"] === "number" ? { seq: b["seq"] } : {}),
    ...(b["replayed"] === true ? { replayed: true as const } : {}),
    ...(typeof b["recordedAs"] === "string" ? { recordedAs: b["recordedAs"] } : {}),
  };
  if (r.ok) return { ok: true, result: b["result"] ?? null, serverTime, ...extra };
  const e: AnswerError = {
    code: (typeof b["code"] === "string"
      ? b["code"]
      : "SERVICE_UNAVAILABLE") as AnswerError["code"],
    message: typeof b["message"] === "string" ? b["message"] : "",
  };
  if (Array.isArray(b["issues"])) e.issues = (b["issues"] as unknown[]).map(String);
  if (typeof b["expectedSeq"] === "number") e.expectedSeq = b["expectedSeq"];
  if (typeof b["retryAt"] === "string") e.retryAt = b["retryAt"];
  if (b["current"] !== undefined) e.current = b["current"] as NonNullable<AnswerError["current"]>;
  return { ok: false, error: e, serverTime, ...extra };
}

export class MockTransport implements Transport {
  constructor(
    private readonly post: MockPost,
    private readonly onChanges: (changes: unknown) => void = () => {},
  ) {}

  async register(): Promise<RegisterAnswer> {
    let r;
    try {
      r = await this.post("/api/sync/register", {});
    } catch {
      throw new Offline("no answer");
    }
    const serverTime = num(r.body["serverTime"]);
    if (r.ok && typeof r.body["clientId"] === "string")
      return {
        ok: true,
        clientId: r.body["clientId"],
        serverTime,
        ...(typeof r.body["u"] === "string" ? { u: r.body["u"] } : {}),
      };
    const a = fromMock(r, () => {});
    return {
      ok: false,
      error: a.ok ? { code: "INTERNAL_SERVER_ERROR", message: "" } : a.error,
      serverTime,
    };
  }

  /** A request that throws got no response (the page is offline). */
  async push(envelopes: readonly Envelope[]): Promise<PushResult[]> {
    const out: PushResult[] = [];
    for (const e of envelopes) {
      try {
        out.push(fromMock(await this.post("/api/sync/write", e), this.onChanges));
      } catch {
        out.push(NO_RESPONSE);
        break;
      }
    }
    return out;
  }

  pull(log: LogId): never {
    throw new Error(`the mock serves no change log (${log})`);
  }

  snapshot(log: LogId): never {
    throw new Error(`the mock serves no change log (${log})`);
  }

  listen() {
    return Promise.resolve();
  }

  async call(name: string, input: unknown): Promise<CallAnswer> {
    const r = await this.post(`/api/rpc/${name}`, input ?? {});
    const a = fromMock(r, this.onChanges);
    return a.ok
      ? { ok: true, result: a.result, serverTime: a.serverTime }
      : { ok: false, error: a.error, serverTime: a.serverTime };
  }
}
