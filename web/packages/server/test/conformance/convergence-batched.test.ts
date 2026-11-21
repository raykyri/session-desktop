// replica-proto's `test/convergence.test.ts`, unchanged, against the batched
// HTTP target (`target.ts`): each envelope travels in a batch after the
// client's recent applied ones, under the default body and batch limits, so
// the transport's batch handling is exercised (`01` A1, A3, Y4). It runs
// `SESSION_CONFORMANCE_BATCHED_SEQUENCES` sequences (30 by default); the
// unbatched file runs the full set.

import "./setup-batched.js";
import "@session/replica-proto/test/convergence.test";
