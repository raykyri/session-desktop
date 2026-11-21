// Installs the batched HTTP target (`target.ts`) for
// `convergence-batched.test.ts`, with its own sequence count: each test
// file runs in its own process, so the variable is this file's alone.

import { useTarget } from "@session/replica-proto/test/harness";

import { createBatchedHttpTestServer } from "./target.js";

process.env["REPLICA_PROTO_SEQUENCES"] =
  process.env["SESSION_CONFORMANCE_BATCHED_SEQUENCES"] ?? "30";
useTarget(createBatchedHttpTestServer);
