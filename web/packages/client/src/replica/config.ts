// Which replica this build uses (02 §9.6). A build made with
// `VITE_SESSION_FIXTURES=1` (the development server's default, and the
// end-to-end build) loads the fixture replica as a separate chunk; in any
// other build `__SESSION_FIXTURES__` is `false` at build time, so the
// bundler drops the import and no fixture text is in the output. Until
// `@session/sync` lands such a build reads the empty replica.

import { configureReplica } from "./ReplicaProvider.js";

declare const __SESSION_FIXTURES__: boolean | undefined;

/** Outside a Vite build (Node tests) it is undefined; the tests configure
 * the replica themselves. */
export const fixturesEnabled = typeof __SESSION_FIXTURES__ === "boolean" && __SESSION_FIXTURES__;

export async function loadReplicaConfig(): Promise<void> {
  if (!fixturesEnabled) return;
  const fixtures = await import("./fixtureReplica.js");
  configureReplica(fixtures.fixtureReplicaConfig());
  fixtures.exposeFixtureControls();
}
