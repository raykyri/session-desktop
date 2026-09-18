import { version } from "@session/shared";
import { Hono } from "hono";

/**
 * The Hono application. Routes are added here so tests can drive them through
 * `app.request()` without binding a port (ADR-2).
 */
export const app = new Hono();

app.get("/healthz", (c) => c.text("ok\n", 200, { "x-session-version": version }));
