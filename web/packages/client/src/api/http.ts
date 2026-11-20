// JSON over `fetch` for the shell's plain routes (phase 2b; ADR-19 as amended):
// on the web the session cookie rides along (same origin), and every request
// carries the CSRF header the server's guard asks a cookie write for; in the
// Desktop app a request goes to the server's origin with the device's bearer
// token and no cookie (`platform.ts`).

import { platform } from "../platform.js";

/** The headers of a request to the server: the platform's (the web's CSRF
 * header) and the bearer device token (the Desktop app). */
export function requestHeaders(): Record<string, string> {
  const p = platform();
  const token = p.token();
  return { ...p.headers(), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

/** A route's error answer: `{ error: { code, message } }`, the sync routes'
 * `{ ok: false, error }`, or a status without a body. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** The request could not be made (offline, or the connection failed). */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

type Fetch = typeof globalThis.fetch;
let fetchImpl: Fetch = (...a) => globalThis.fetch(...a);

/** Installs the `fetch` the account calls use (tests). */
export function setFetch(f: Fetch | null): void {
  fetchImpl = f ?? ((...a) => globalThis.fetch(...a));
}

export function currentFetch(): Fetch {
  return fetchImpl;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    const p = platform();
    res = await fetchImpl(`${p.origin}${path}`, {
      method,
      credentials: p.credentials,
      headers: {
        ...requestHeaders(),
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : "offline");
  }
  let data: unknown;
  const text = await res.text();
  try {
    data = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok || (isObject(data) && data["ok"] === false)) {
    const e = isObject(data) && isObject(data["error"]) ? data["error"] : {};
    const code = typeof e["code"] === "string" ? e["code"] : `HTTP_${res.status}`;
    const message = typeof e["message"] === "string" ? e["message"] : res.statusText || code;
    throw new HttpError(res.status, code, message);
  }
  return data as T;
}

export const getJson = <T>(path: string) => request<T>("GET", path);
export const postJson = <T>(path: string, body: unknown = {}) => request<T>("POST", path, body);
