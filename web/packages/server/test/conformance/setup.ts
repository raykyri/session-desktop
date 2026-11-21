// Installs the HTTP target over SQLite (`target.ts`) as the server the
// acceptance suite runs against. Every file of this directory imports it
// before the replica-proto test file it runs.

import { useTarget } from "@session/replica-proto/test/harness";

import { createHttpTestServer } from "./target.js";

useTarget(createHttpTestServer);
