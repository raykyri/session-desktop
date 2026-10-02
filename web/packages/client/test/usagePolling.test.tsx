import { mock } from "node:test";

import { act, cleanup, render, screen } from "@testing-library/react";
import test from "ava";

import { useUsage, USAGE_STALE_MS } from "../src/api/queries.js";
import { setTrpcClient } from "../src/api/trpc.js";
import { AppProviders } from "../src/app/providers.js";

import { testUser, waitUntil } from "./helpers.js";
import { testQueryClient } from "./phase6Fixtures.js";
import { createTrpcStub } from "./trpcStub.js";

function UsageProbe() {
  const usage = useUsage();
  return <p>Runs: {usage.data?.runs ?? 0}</p>;
}

test.serial("mounted usage refreshes without a focus change or SSE event", async (t) => {
  let reads = 0;
  const stub = createTrpcStub({
    "auth.me": testUser(),
    "usage.summary": () => ({ runs: ++reads }),
  });
  setTrpcClient(stub.client);
  const client = testQueryClient();
  client.setQueryData(["me"], testUser());
  mock.timers.enable({ apis: ["setInterval"] });
  t.teardown(() => {
    cleanup();
    client.clear();
    mock.timers.reset();
  });
  render(
    <AppProviders queryClient={client}>
      <UsageProbe />
    </AppProviders>,
  );
  await waitUntil(t, () => screen.queryByText("Runs: 1") !== null, "initial usage loaded");
  await act(async () => {
    mock.timers.tick(USAGE_STALE_MS);
    await Promise.resolve();
  });
  await waitUntil(t, () => screen.queryByText("Runs: 2") !== null, "usage polled");
  t.true(
    stub.calls
      .filter((call) => call.path === "usage.summary")
      .every((call) => call.input === undefined),
  );
});
