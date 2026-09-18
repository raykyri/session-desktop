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
 * the previous one's database, documents, or sessions. */
export const E2E_DATA_DIR = join(tmpdir(), "session-web-e2e");
