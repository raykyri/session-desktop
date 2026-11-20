// Values shared by `playwright.config.ts` and the specs. Kept side-effect free:
// Playwright loads the config in the runner *and* in every worker, so anything
// that touches the filesystem here would run once per process.

import { tmpdir } from "node:os";
import { join } from "node:path";

export const E2E_PORT = Number(process.env["SESSION_E2E_PORT"] ?? 8788);

/**
 * Two hostnames for one listener, which is what the artifact origin needs
 * (`11-artifacts-and-browser.md` §2): the session cookie is set host-only on
 * `127.0.0.1` and is therefore never sent to `localhost`. Both resolve to the
 * loopback in every browser and on every CI image, which a made-up name like
 * `artifacts.localhost` does not.
 */
export const APP_ORIGIN = `http://127.0.0.1:${E2E_PORT}`;
export const ARTIFACT_ORIGIN = `http://localhost:${E2E_PORT}`;

/** Wiped by the web server command before each run, so a suite never inherits
 * the previous one's database, documents, or sessions. One per port, so two
 * suites on different ports never share a database. */
export const E2E_DATA_DIR = join(tmpdir(), `session-web-e2e-${E2E_PORT}`);

/** Whether the suite may run against a server already listening on the port
 * (`SESSION_E2E_REUSE_SERVER=1`): for iterating locally against a server one
 * started oneself. Off by default, so a port another run holds fails the
 * suite instead of mixing its data into this one. */
export const E2E_REUSE_SERVER = process.env["SESSION_E2E_REUSE_SERVER"] === "1";

/** The environment variable that carries the run's id from the runner to its
 * workers (`playwright.config.ts` sets it once). */
export const E2E_RUN_ID_VARIABLE = "SESSION_E2E_RUN_ID";

/**
 * The address the suite's server binds (`SESSION_E2E_HOST`): `::` by default,
 * which serves both `127.0.0.1` and `localhost` wherever IPv6 is available.
 * A machine or container without IPv6 sets `127.0.0.1`; Chromium tries
 * `127.0.0.1` for `localhost` when `::1` refuses, so the artifact origin still
 * reaches the server.
 */
export const E2E_HOST = process.env["SESSION_E2E_HOST"] ?? "::";
