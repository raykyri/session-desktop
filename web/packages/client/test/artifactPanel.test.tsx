// The document preview panel (`11-artifacts-and-browser.md` §3).
//
// The store's rules (one panel, toggle, reuse) are asserted directly; the
// bridge and the chip are asserted through a mounted panel, because what is
// worth checking about them is that a message from the wrong origin never
// reaches the store and that a click mints exactly one token.

import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import test from "ava";

import { queryKeys } from "../src/api/cache.js";
import { queryClientDefaults } from "../src/api/queries.js";
import { setTrpcClient } from "../src/api/trpc.js";
import { AppProviders } from "../src/app/providers.js";
import { ArtifactPanel } from "../src/features/artifacts/ArtifactPanel.js";
import { openArtifactDocument } from "../src/features/artifacts/openArtifact.js";
import { DocumentChips } from "../src/features/research/DocumentChips.js";
import { useArtifactPanelStore } from "../src/stores/artifactPanel.js";
import { OVERLAY_PRIORITY, useOverlaysStore } from "../src/stores/overlays.js";

import { testUser } from "./helpers.js";
import { createTrpcStub, type TrpcStub } from "./trpcStub.js";

const ARTIFACT_ORIGIN = "http://artifacts.localhost:8787";
const HOUR = 60 * 60 * 1000;

function url(token: string): string {
  return `${ARTIFACT_ORIGIN}/a/${token}`;
}

function panelDocument(
  overrides: Partial<{ documentId: string; name: string; token: string }> = {},
) {
  const documentId = overrides.documentId ?? "d1";
  return {
    documentId,
    name: overrides.name ?? "notes.md",
    url: url(overrides.token ?? "t1"),
    expiresAt: Date.now() + HOUR,
  };
}

test.beforeEach(() => {
  useArtifactPanelStore.getState().reset();
  useOverlaysStore.getState().clear();
});

test.afterEach.always(() => {
  try {
    cleanup();
  } finally {
    document.body.innerHTML = "";
  }
  useArtifactPanelStore.getState().reset();
  useOverlaysStore.getState().clear();
});

/* ------------------------------------------------------------------ store */

test.serial("opening, closing and toggling move one slot", (t) => {
  const store = useArtifactPanelStore.getState();
  t.is(store.current, null);

  store.open(panelDocument());
  t.is(useArtifactPanelStore.getState().current?.documentId, "d1");

  store.close();
  t.is(useArtifactPanelStore.getState().current, null);

  // Shift-Cmd-E on a closed panel reopens what it closed.
  t.true(useArtifactPanelStore.getState().toggle());
  t.is(useArtifactPanelStore.getState().current?.documentId, "d1");
  t.false(useArtifactPanelStore.getState().toggle());
  t.is(useArtifactPanelStore.getState().current, null);
});

test.serial("toggle command does nothing when no artifact has been opened", (t) => {
  t.false(useArtifactPanelStore.getState().toggle());
  t.is(useArtifactPanelStore.getState().current, null);
});

test.serial("a second document replaces the first rather than stacking", (t) => {
  const store = useArtifactPanelStore.getState();
  store.open(panelDocument({ documentId: "d1", name: "one.md", token: "t1" }));
  store.recordScroll({ x: 0, y: 420 });
  store.open(panelDocument({ documentId: "d2", name: "two.pdf", token: "t2" }));

  const state = useArtifactPanelStore.getState();
  t.is(state.current?.documentId, "d2");
  t.is(state.current?.url, url("t2"));
  // A different document starts at the top; the offset belonged to the other.
  t.deepEqual(state.scroll, { x: 0, y: 0 });
});

test.serial("reopening the same document keeps its offset and its token", async (t) => {
  const stub = createTrpcStub({
    "artifacts.mintToken": { url: url("fresh"), expiresAt: Date.now() + HOUR },
  });
  setTrpcClient(stub.client);

  useArtifactPanelStore.getState().open(panelDocument());
  useArtifactPanelStore.getState().recordScroll({ x: 0, y: 200 });
  useArtifactPanelStore.getState().close();

  await openArtifactDocument({ documentId: "d1", name: "notes.md" });

  const state = useArtifactPanelStore.getState();
  t.is(state.current?.url, url("t1"), "a live token is reused rather than re-minted");
  t.deepEqual(state.scroll, { x: 0, y: 200 });
  t.deepEqual(
    stub.calls.filter((call) => call.path === "artifacts.mintToken"),
    [],
  );
});

test.serial("an expiring token is re-minted rather than reused", async (t) => {
  const stub = createTrpcStub({
    "artifacts.mintToken": { url: url("fresh"), expiresAt: Date.now() + HOUR },
  });
  setTrpcClient(stub.client);

  useArtifactPanelStore.getState().open({ ...panelDocument(), expiresAt: Date.now() + 5_000 });
  useArtifactPanelStore.getState().close();

  await openArtifactDocument({ documentId: "d1", name: "notes.md" });

  t.is(useArtifactPanelStore.getState().current?.url, url("fresh"));
  t.is(stub.calls.filter((call) => call.path === "artifacts.mintToken").length, 1);
});

/* --------------------------------------------------------------- mounted */

interface MountOptions {
  responses?: Record<string, unknown>;
  chips?: boolean;
}

const RUNTIME_CONFIG = {
  version: "0.0.0",
  models: [],
  limits: {},
  features: { webSearch: false, artifactOrigin: ARTIFACT_ORIGIN },
};

function mount(options: MountOptions = {}): { stub: TrpcStub } {
  const stub = createTrpcStub({
    "auth.me": testUser(),
    "system.runtimeConfig": RUNTIME_CONFIG,
    "documents.list": [
      { id: "d1", name: "notes.md", mime: "text/markdown", extractionStatus: "done" },
    ],
    "artifacts.mintToken": { url: url("minted"), expiresAt: Date.now() + HOUR },
    ...options.responses,
  });
  setTrpcClient(stub.client);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { ...queryClientDefaults.queries, gcTime: Number.POSITIVE_INFINITY },
      mutations: { gcTime: Number.POSITIVE_INFINITY },
    },
  });
  // Seeded rather than awaited: auth and runtime config are prefetched before
  // the shell mounts, and the bridge is armed only once the origin is known.
  queryClient.setQueryData(queryKeys.me(), testUser());
  queryClient.setQueryData(queryKeys.runtimeConfig(), RUNTIME_CONFIG);
  render(
    <AppProviders queryClient={queryClient}>
      {options.chips ? <DocumentChips documentIds={["d1"]} workspaceId="w1" /> : null}
      <ArtifactPanel />
    </AppProviders>,
  );
  return { stub };
}

function frame(): HTMLIFrameElement {
  return screen.getByTestId("artifact-frame");
}

function postFromFrame(data: unknown, origin: string): void {
  act(() => {
    window.dispatchEvent(
      new window.MessageEvent("message", { data, origin, source: frame().contentWindow }),
    );
  });
}

test.serial(
  "registers an Escape handler while the panel is open and removes it on close",
  async (t) => {
    mount();
    act(() => useArtifactPanelStore.getState().open(panelDocument()));

    await waitFor(() => {
      if (!useOverlaysStore.getState().top()) throw new Error("not registered yet");
    });
    t.is(useOverlaysStore.getState().top()?.priority, OVERLAY_PRIORITY.artifactPanel);

    act(() => {
      useOverlaysStore.getState().dismissTop();
    });
    t.is(useArtifactPanelStore.getState().current, null);

    await waitFor(() => {
      if (useOverlaysStore.getState().top()) throw new Error("still registered");
    });
    t.is(useOverlaysStore.getState().top(), null);
  },
);

test.serial("the panel frames the minted URL in a sandboxed iframe", (t) => {
  mount();
  act(() => useArtifactPanelStore.getState().open(panelDocument()));

  const iframe = frame();
  t.is(iframe.getAttribute("src"), url("t1"));
  t.is(iframe.getAttribute("sandbox"), "allow-scripts allow-same-origin");
  t.is(iframe.getAttribute("referrerpolicy"), "no-referrer");
  // "Open in new tab" stays available from the panel itself.
  t.is(screen.getByLabelText("Open in new tab").getAttribute("href"), url("t1"));
  t.is(screen.getByLabelText("Open in new tab").getAttribute("rel"), "noopener noreferrer");
});

test.serial(
  "a scroll message is taken from the artifact origin and from nowhere else",
  async (t) => {
    mount();
    act(() => useArtifactPanelStore.getState().open(panelDocument()));
    await waitFor(() => {
      if (!screen.queryByTestId("artifact-frame")) throw new Error("no frame");
    });

    postFromFrame({ type: "session-preview-scroll", x: 0, y: 640 }, "https://evil.example");
    t.deepEqual(useArtifactPanelStore.getState().scroll, { x: 0, y: 0 }, "origin is checked");

    postFromFrame({ type: "session-preview-scroll", x: 0, y: 640 }, ARTIFACT_ORIGIN);
    t.deepEqual(useArtifactPanelStore.getState().scroll, { x: 0, y: 640 });

    // A message of the right type from the right origin still has to be shaped
    // like the bridge's.
    postFromFrame({ type: "session-preview-scroll", x: "0", y: "1" }, ARTIFACT_ORIGIN);
    t.deepEqual(useArtifactPanelStore.getState().scroll, { x: 0, y: 640 });
  },
);

test.serial("reload remounts the frame and the restore message carries the offset", (t) => {
  mount();
  act(() => useArtifactPanelStore.getState().open(panelDocument()));
  postFromFrame({ type: "session-preview-scroll", x: 0, y: 300 }, ARTIFACT_ORIGIN);

  const first = frame();
  const before = useArtifactPanelStore.getState().reloadNonce;
  fireEvent.click(screen.getByLabelText("Reload"));
  t.is(useArtifactPanelStore.getState().reloadNonce, before + 1);
  // The frame is keyed on the nonce, so a reload is a new element rather than
  // a `src` assignment the browser would ignore.
  t.not(frame(), first);

  const posted: unknown[] = [];
  Object.defineProperty(frame(), "contentWindow", {
    configurable: true,
    value: { postMessage: (data: unknown) => posted.push(data) },
  });
  fireEvent.load(frame());
  t.deepEqual(posted, [{ type: "session-preview-scroll-restore", x: 0, y: 300 }]);
});

test.serial("a 410 from the framed page re-mints the token", async (t) => {
  const { stub } = mount();
  act(() => useArtifactPanelStore.getState().open(panelDocument()));
  await waitFor(() => {
    if (!screen.queryByTestId("artifact-frame")) throw new Error("no frame");
  });

  postFromFrame({ type: "session-preview-error", status: 410 }, ARTIFACT_ORIGIN);
  await waitFor(() => {
    if (useArtifactPanelStore.getState().current?.url !== url("minted")) {
      throw new Error("not re-minted");
    }
  });

  t.is(stub.calls.filter((call) => call.path === "artifacts.mintToken").length, 1);
  t.is(useArtifactPanelStore.getState().current?.url, url("minted"));
});

test.serial("Shift-Cmd-E toggles the mounted panel", (t) => {
  mount();
  act(() => useArtifactPanelStore.getState().open(panelDocument()));
  t.truthy(screen.queryByTestId("artifact-panel"));

  act(() => {
    window.dispatchEvent(
      new window.CustomEvent("session:shortcut", { detail: { type: "toggleArtifactPanel" } }),
    );
  });
  t.is(screen.queryByTestId("artifact-panel"), null);

  act(() => {
    window.dispatchEvent(
      new window.CustomEvent("session:shortcut", { detail: { type: "toggleArtifactPanel" } }),
    );
  });
  t.truthy(screen.queryByTestId("artifact-panel"));
});

test.serial("full width drops the panel's own size", (t) => {
  mount();
  act(() => useArtifactPanelStore.getState().open(panelDocument()));

  fireEvent.click(screen.getByText("Full width"));
  t.true(useArtifactPanelStore.getState().fullWidth);
  t.is(screen.queryByTestId("artifact-resize-edge"), null, "a full-width panel is not resizable");

  fireEvent.click(screen.getByText("Shrink"));
  t.false(useArtifactPanelStore.getState().fullWidth);
  t.truthy(screen.queryByTestId("artifact-resize-edge"));
});

test.serial("the left edge grows the panel as it is dragged left", (t) => {
  mount();
  act(() => useArtifactPanelStore.getState().open(panelDocument()));
  const before = useArtifactPanelStore.getState().width;

  const edge = screen.getByTestId("artifact-resize-edge");
  fireEvent.pointerDown(edge, { pointerId: 1, clientX: 500, clientY: 300 });
  fireEvent.pointerMove(edge, { pointerId: 1, clientX: 440, clientY: 300 });
  fireEvent.pointerUp(edge, { pointerId: 1, clientX: 440, clientY: 300 });

  t.is(useArtifactPanelStore.getState().width, before + 60);

  // Past the minimum the panel stops shrinking rather than inverting.
  const corner = screen.getByTestId("artifact-resize-corner");
  fireEvent.pointerDown(corner, { pointerId: 2, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(corner, { pointerId: 2, clientX: 5000, clientY: -5000 });
  fireEvent.pointerUp(corner, { pointerId: 2, clientX: 5000, clientY: -5000 });
  t.is(useArtifactPanelStore.getState().width, 320);
  t.is(useArtifactPanelStore.getState().height, 200);
});

test.serial("a chip opens the panel on the minted URL instead of a new tab", async (t) => {
  const { stub } = mount({ chips: true });

  const chip = await screen.findByRole("button", { name: /notes\.md/ });
  fireEvent.click(chip);

  await waitFor(() => {
    if (!useArtifactPanelStore.getState().current) throw new Error("panel did not open");
  });
  t.deepEqual(
    stub.calls.filter((call) => call.path === "artifacts.mintToken"),
    [{ path: "artifacts.mintToken", kind: "mutate", input: { documentId: "d1" } }],
  );
  t.is(useArtifactPanelStore.getState().current?.url, url("minted"));
  t.is(useArtifactPanelStore.getState().current?.name, "notes.md");
  t.is(frame().getAttribute("src"), url("minted"));
});

test.serial(
  "shows an error on the document chip and keeps the panel closed when token minting fails",
  async (t) => {
    mount({
      chips: true,
      responses: {
        "artifacts.mintToken": () => {
          throw new Error("gone");
        },
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: /notes\.md/ }));

    await waitFor(() => {
      if (!screen.queryByRole("alert")) throw new Error("no notice yet");
    });
    t.regex(screen.getByRole("alert").textContent ?? "", /Failed to open document/);
    t.is(useArtifactPanelStore.getState().current, null);
  },
);
