// A sync client over HTTP for the server tests: register, write envelopes
// with seqs, snapshot, pull, online calls and the event stream, signed in
// with a session cookie or a device's bearer token.

import { ulid } from "@session/mutators";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@session/sync";

import type { Harness } from "./helpers.js";

export type Body = Record<string, unknown> & {
  ok?: boolean;
  error?: { code: string; message: string; expectedSeq?: number };
  result?: unknown;
  serverTime?: number;
  seq?: number;
  replayed?: boolean;
};

let n = 0;
const random = () => {
  n = (n * 9301 + 49297) % 233280;
  return n / 233280;
};

export class HttpClient {
  clientId = "";
  seq = 0;

  constructor(
    readonly h: Harness,
    readonly auth: { cookie: string } | { bearer: string } | null,
  ) {}

  private headers(): Record<string, string> {
    const out: Record<string, string> = {
      "Content-Type": "application/json",
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    };
    if (this.auth && "bearer" in this.auth) out["Authorization"] = `Bearer ${this.auth.bearer}`;
    return out;
  }

  async post(path: string, body: unknown, extra: Record<string, string> = {}) {
    const bearer = this.auth !== null && "bearer" in this.auth;
    const res = await this.h.app.request(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        ...(bearer ? { Origin: "tauri://localhost" } : { Origin: "http://localhost:8787" }),
        ...(bearer ? {} : { "X-Requested-With": "session" }),
        ...(this.auth && "cookie" in this.auth ? { Cookie: `session=${this.auth.cookie}` } : {}),
        ...this.headers(),
        ...extra,
      },
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Body, res };
  }

  async register() {
    const r = await this.post("/api/sync/register", {});
    if (r.body.ok) this.clientId = r.body["clientId"] as string;
    return r;
  }

  id(at = this.h.deps.sync.clockNow()) {
    return ulid(at, random);
  }

  envelope(name: string, input: unknown, extra: Record<string, unknown> = {}) {
    const now = this.h.deps.sync.clockNow();
    return {
      clientId: this.clientId,
      seq: this.seq + 1,
      mutationId: this.id(),
      name,
      input,
      protocolVersion: PROTOCOL_VERSION,
      clientTime: now,
      queuedAt: now,
      replaces: [],
      ...extra,
    };
  }

  /** Send a write; a recorded answer moves the client's seq. */
  async send(envelope: Record<string, unknown>) {
    const r = await this.post("/api/sync/write", envelope);
    if (typeof r.body.seq === "number") this.seq = r.body.seq;
    return r;
  }

  async write(name: string, input: unknown) {
    if (!this.clientId) await this.register();
    return this.send(this.envelope(name, input));
  }

  snapshot(log: string, options: Record<string, unknown> = {}) {
    return this.post("/api/sync/snapshot", { log, clientId: this.clientId, ...options });
  }

  pull(log: string, cursor: string) {
    return this.post("/api/sync/pull", { log, cursor, clientId: this.clientId });
  }

  call(name: string, input: unknown) {
    return this.post(`/api/rpc/${name}`, input);
  }

  /** Open the event stream with `cursors`; `read()` answers the text so
   * far, `close()` ends it. */
  async events(cursors: Record<string, string>) {
    const ac = new AbortController();
    const bearer = this.auth !== null && "bearer" in this.auth;
    const res = await this.h.app.request("/api/sync/events", {
      method: "GET",
      signal: ac.signal,
      headers: {
        ...this.headers(),
        ...(bearer ? { Origin: "tauri://localhost" } : {}),
        ...(this.auth && "cookie" in this.auth ? { Cookie: `session=${this.auth.cookie}` } : {}),
        Accept: "text/event-stream",
        "Last-Event-ID": JSON.stringify(cursors),
      },
    });
    let text = "";
    let done = false;
    const pump = (async () => {
      if (!res.body) return;
      const reader = res.body.getReader();
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          text += new TextDecoder().decode(r.value as Uint8Array);
        }
      } catch {
        // aborted
      }
      done = true;
    })();
    return {
      status: res.status,
      read: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return text;
      },
      ended: () => done,
      /** Wait (at most 2 s) until the text matches, or the stream ended. */
      until: async (re: RegExp | null) => {
        for (let k = 0; k < 100 && !(re ? re.test(text) : done); k++)
          await new Promise((r) => setTimeout(r, 20));
        return text;
      },
      close: async () => {
        ac.abort();
        await pump;
      },
    };
  }
}

/** A device of `u`'s signed in through the browser approval: its token. */
export async function signInDevice(h: Harness, browser: HttpClient) {
  const anon = new HttpClient(h, null);
  const a = await anon.call("devices.authorize", { name: "Mel's Mac", kind: "mac" });
  const request = (a.body.result as { request: string }).request;
  const ap = await browser.call("devices.approve", { request });
  const t = await anon.call("devices.token", { request });
  const r = t.body.result as { token: string; device: string };
  return { approve: ap, token: r.token, device: r.device };
}
