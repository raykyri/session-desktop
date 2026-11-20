// The e2e suite's server (phase 2b): `@session/server/test-server` (the
// production assembly over a temp database, with test sign-in, the test
// routes `/api/test/*` and a settable sync clock) on the suite's port,
// serving the built client, with the fixture providers and the job
// runner's timers on. `playwright.config.ts` starts it.

import { fileURLToPath } from "node:url";

import { startTestServer } from "@session/server/test-server";

import { APP_ORIGIN, E2E_PORT } from "./constants.js";

const { ready } = startTestServer({
  port: E2E_PORT,
  publicOrigin: APP_ORIGIN,
  settableClock: true,
  timers: true,
  clientDistDirectory: fileURLToPath(new URL("../packages/client/dist/app", import.meta.url)),
  env: {
    SESSION_CURSOR_KEY: Buffer.alloc(32, 7).toString("base64"),
    SESSION_API_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    GOOGLE_APPLICATION_CREDENTIALS_JSON: '{"type":"service_account"}',
    GOOGLE_VERTEX_PROJECT: "session-e2e",
    OPENROUTER_API_KEY: "openrouter-key",
    ANTHROPIC_API_KEY: "anthropic-key",
  },
});

const server = await ready;
// keep the process alive: the test server unrefs its listener
setInterval(() => undefined, 1 << 30);
process.stdout.write(`e2e server at ${server.origin}\n`);
const stop = () => void server.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
