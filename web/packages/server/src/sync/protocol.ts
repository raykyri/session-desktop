// The protocol version check (`01` S1, `05` §3.4). Every sync, run and tRPC
// request of the web client carries `Session-Protocol`; the server accepts
// `[SESSION_MIN_PROTOCOL, current]`. A request without the header, or outside
// the range, answers `426 { code: "UPGRADE_REQUIRED" }`, and the web client
// reloads once. The sync routes answer their transport refusals in the same
// shape: `{ code, message, serverTime }`.

import { MESSAGES, type ErrorCode } from "@session/mutators";
import type { Context, MiddlewareHandler } from "hono";

import type { Config } from "../config.js";
import type { AppEnv } from "../deps.js";

export const PROTOCOL_HEADER = "Session-Protocol";

/** A transport refusal of a sync route: unrecorded, with the server's time. */
export function refusal(
  c: Context<AppEnv>,
  status: 400 | 401 | 403 | 409 | 413 | 426 | 429 | 500 | 503,
  code: ErrorCode,
  message: string | undefined,
  serverTime: number,
  retryAfter?: number,
): Response {
  if (retryAfter !== undefined) c.header("Retry-After", String(retryAfter));
  return c.json({ code, message: message ?? MESSAGES[code], serverTime }, status);
}

refusal.message = (code: ErrorCode): string => MESSAGES[code];

/** Whether a `Session-Protocol` value is in the accepted range. */
export function protocolAccepted(value: string | undefined, config: Pick<Config, "sync">): boolean {
  if (value === undefined || !/^\d{1,6}$/.test(value.trim())) return false;
  const v = Number(value.trim());
  return v >= config.sync.minProtocol && v <= config.sync.protocol;
}

/** 426 for a request below the minimum or without the header. */
export function protocolCheck(config: Pick<Config, "sync">): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!protocolAccepted(c.req.header(PROTOCOL_HEADER), config))
      return c.json(
        {
          code: "UPGRADE_REQUIRED",
          message: MESSAGES.UPGRADE_REQUIRED,
          minProtocol: config.sync.minProtocol,
          serverTime: Date.now(),
        },
        426,
      );
    return next();
  };
}
