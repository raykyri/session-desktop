// Device sign-in (AGENTS.md, "Sync-state UI": device sign-in is approved in
// the browser with one click): the app asks the server for a sign-in
// (`devices.authorize`, with the device and the app it is), opens the
// browser at `<server>/device?request=<id>` (the link never holds the
// code), shows the code for a browser on another computer, and asks for its
// token (`devices.token`) every 2 seconds until the browser approves or
// denies it, or it expires (10 minutes). Both calls are made without a
// token or a cookie: the server takes them from the app's origin
// (`server/src/middleware/cors.ts`).

import type { AppAbout } from "./bridge.js";

export interface SignInRequest {
  request: string;
  /** The code the app shows ("ABC-DEF"). */
  code: string;
}

/** What `devices.token` answers once the browser approved. */
export interface Taken {
  token: string;
  device: string;
  /** The person's handle. */
  u: string;
}

export type WaitResult = Taken | "denied" | "expired" | "cancelled";

/** How long a sign-in request lives on the server. */
export const SIGNIN_TTL_MS = 10 * 60_000;
export const POLL_MS = 2000;

/** The server could not be reached, or it answered with an error. */
export class SignInError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SignInError";
  }
}

type Fetch = typeof fetch;

async function call(
  f: Fetch,
  origin: string,
  name: string,
  input: unknown,
): Promise<{ ok: true; result: unknown } | { ok: false; code: string; message: string }> {
  let res: Response;
  try {
    res = await f(`${origin}/api/rpc/${name}`, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (e) {
    return { ok: false, code: "OFFLINE", message: e instanceof Error ? e.message : "offline" };
  }
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean;
    result?: unknown;
    error?: { code?: string; message?: string };
  } | null;
  if (data?.ok === true) return { ok: true, result: data.result };
  return {
    ok: false,
    code: data?.error?.code ?? `HTTP_${res.status}`,
    message: data?.error?.message ?? res.statusText,
  };
}

/** What the app does with a token it took: it is stored (the Keychain)
 * before the app says it is signed in; a token the app could not store is
 * revoked with itself, so no live token is left that nobody holds (review
 * round 1 of phase 3, finding 10). */
export async function keepToken(
  desktop: {
    signedIn(t: Taken): Promise<void>;
    revoke(t: { token: string; device: string }): Promise<void>;
  },
  taken: Taken,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await desktop.signedIn(taken);
    return { ok: true };
  } catch (e) {
    await desktop.revoke(taken);
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** The address the browser opens: the request only, never the code. */
export const approvalUrl = (origin: string, request: string) =>
  `${origin}/device?request=${encodeURIComponent(request)}`;

/** Ask the server for a sign-in. */
export async function authorize(
  origin: string,
  about: AppAbout,
  f: Fetch = (...a) => fetch(...a),
): Promise<SignInRequest> {
  const a = await call(f, origin, "devices.authorize", {
    name: about.name,
    kind: "mac",
    device: about.device,
    app: about.app,
  });
  if (!a.ok) throw new SignInError(a.code, a.message);
  const r = a.result as { request?: unknown; code?: unknown };
  if (typeof r.request !== "string" || typeof r.code !== "string")
    throw new SignInError("BAD_ANSWER", "The server's answer has no request.");
  return { request: r.request, code: r.code };
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** Ask for the token until the browser decides, the request expires, or
 * `signal` aborts. A request the server cannot be reached for is asked
 * again; PRECONDITION_FAILED is a sign-in still waiting. */
export async function waitForToken(
  origin: string,
  request: string,
  o: {
    signal: AbortSignal;
    fetch?: Fetch;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  },
): Promise<WaitResult> {
  const f = o.fetch ?? ((...a) => fetch(...a));
  const now = o.now ?? (() => Date.now());
  const sleep = o.sleep ?? wait;
  const until = now() + SIGNIN_TTL_MS;
  for (;;) {
    if (o.signal.aborted) return "cancelled";
    const a = await call(f, origin, "devices.token", { request });
    if (o.signal.aborted) return "cancelled";
    if (a.ok) {
      const r = a.result as Partial<Taken>;
      if (typeof r.token === "string" && typeof r.device === "string" && typeof r.u === "string")
        return { token: r.token, device: r.device, u: r.u };
      throw new SignInError("BAD_ANSWER", "The server's answer has no token.");
    }
    if (a.code === "FORBIDDEN") return "denied";
    if (a.code === "NOT_FOUND") return "expired";
    if (now() >= until) return "expired";
    await sleep(o.pollMs ?? POLL_MS, o.signal);
  }
}
