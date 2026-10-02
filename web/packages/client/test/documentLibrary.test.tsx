import type { DocumentInfo } from "@session/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import test from "ava";

import { queryKeys } from "../src/api/cache.js";
import { setTrpcClient } from "../src/api/trpc.js";
import { AppProviders } from "../src/app/providers.js";
import { DocumentLibrary } from "../src/features/documents/DocumentLibrary.js";

import { waitUntil } from "./helpers.js";
import { testQueryClient } from "./phase6Fixtures.js";
import { createTrpcStub } from "./trpcStub.js";

const upload: DocumentInfo = {
  id: "d1",
  workspaceId: "w1",
  name: "discarded.txt",
  mime: "text/plain",
  byteSize: 42,
  sha256: "hash",
  extractionStatus: "ok",
  createdAt: 1,
};

test.afterEach.always(() => cleanup());

test.serial("deleting an unused upload refreshes document lists", async (t) => {
  let rows = [upload];
  const stub = createTrpcStub({
    "documents.list": () => rows,
    "documents.remove": () => {
      rows = [];
      return { ok: true };
    },
  });
  setTrpcClient(stub.client);
  const client = testQueryClient();
  client.setQueryData(queryKeys.documents("w1"), [upload]);
  t.teardown(() => client.clear());
  render(
    <AppProviders queryClient={client}>
      <DocumentLibrary />
    </AppProviders>,
  );
  await waitUntil(
    t,
    () => screen.queryByRole("button", { name: "Delete discarded.txt" }) !== null,
    "upload listed",
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete discarded.txt" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete document" }));
  await waitUntil(
    t,
    () => screen.queryByText("No uploaded documents.") !== null,
    "deleted upload removed",
  );
  t.deepEqual(stub.calls.find((call) => call.path === "documents.remove")?.input, {
    documentId: "d1",
  });
  t.true(client.getQueryState(queryKeys.documents("w1"))?.isInvalidated);
});

test.serial(
  "a referenced-document refusal stays visible without removing the upload",
  async (t) => {
    const message =
      "Cannot delete document: it is currently attached to one or more research threads.";
    setTrpcClient(
      createTrpcStub({
        "documents.list": [upload],
        "documents.remove": () => {
          throw new Error(message);
        },
      }).client,
    );
    const client = testQueryClient();
    t.teardown(() => client.clear());
    render(
      <AppProviders queryClient={client}>
        <DocumentLibrary />
      </AppProviders>,
    );
    await waitUntil(
      t,
      () => screen.queryByRole("button", { name: "Delete discarded.txt" }) !== null,
      "upload listed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete discarded.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete document" }));
    await waitUntil(t, () => screen.queryByText(message) !== null, "refusal shown");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitUntil(
      t,
      () => screen.queryByRole("button", { name: "Delete discarded.txt" }) !== null,
      "refused upload remains listed",
    );
  },
);
