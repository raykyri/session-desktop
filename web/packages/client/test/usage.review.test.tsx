// The Usage page, the ring, Site Admin and the composer's key-only models
// (02 W8.1, W8.2, §5, §10.1; 03 K4-K7, K11, K15): focus after each key
// action, the live region per key row, the cut-offs of the recent runs, the
// error displays, and the refetches.

import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import test from "ava";

import { useComposerChoice } from "../src/features/feed/FeedContext.js";
import { RECENT_RUNS } from "../src/features/usage/UsagePage.js";
import { configureReplica } from "../src/replica/ReplicaProvider.js";
import { fixtureReplicaConfig, type FixtureReplica } from "../src/replica/fixtureReplica.js";

import {
  renderApp,
  resetDocumentRoot,
  testModelListing,
  testUser,
  testWeeklyUsage,
  trpcRefusal,
  waitUntil,
} from "./helpers.js";

const KEY = "sk-ant-api03-a-whole-key-from-the-console-a1f9";
const OPENAI = { provider: "openai", last4: "77c2", status: "valid", addedAt: 1 };
const ANTHROPIC = { provider: "anthropic", last4: "a1f9", status: "valid", addedAt: 1 };

test.afterEach.always(() => {
  cleanup();
  resetDocumentRoot();
  configureReplica(null);
  useComposerChoice.setState({ model: null, effort: null });
});

/** Whether an alert on screen says `text` (other alerts may be shown). */
const hasAlert = (text: string) =>
  screen.queryAllByRole("alert").some((alert) => alert.textContent === text);

/** The radio `element` is. */
function input(element: HTMLElement): HTMLInputElement {
  if (!(element instanceof HTMLInputElement)) throw new Error("not an input");
  return element;
}

const keyRow = (provider: string) =>
  within(document.querySelector<HTMLElement>(`[data-key="${provider}"]`) as HTMLElement);
const liveText = (provider: string) =>
  document.querySelector(`[data-key="${provider}"] [aria-live="polite"]`)?.textContent ?? null;

/** The registry with a model that runs only on a member's OpenAI key: the
 * registry has none yet (03 K11), so the tests add one. */
const KEY_ONLY_LISTING = (() => {
  const listing = testModelListing({ defaultModel: "gpt-luna", defaultEffort: "medium" }) as {
    models: unknown[];
    defaultModel: string;
    defaultEffort: string;
  };
  return {
    ...listing,
    models: [
      ...listing.models,
      {
        id: "openai-key-only",
        label: "OpenAI Key Only",
        provider: "openai",
        payers: ["key:openai"],
        efforts: ["low", "medium", "high"],
      },
    ],
  };
})();

// ------------------------------------------------------------ focus and the live region

test.serial(
  "focus: Save → Remove, Keep → Remove, a removal → Add key, Cancel → Add key",
  async (t) => {
    let keys: unknown[] = [];
    await renderApp("/usage", {
      responses: {
        "usage.get": () => testWeeklyUsage({ keys }),
        "apiKeys.set": () => {
          keys = [ANTHROPIC];
          return ANTHROPIC;
        },
        "apiKeys.remove": () => {
          keys = [];
          return { removed: true };
        },
      },
    });
    await screen.findByRole("region", { name: "API keys" });
    t.is(liveText("anthropic"), "", "the live region is there before any status");

    fireEvent.click(keyRow("anthropic").getByRole("button", { name: "Add key" }));
    fireEvent.change(await screen.findByLabelText("Anthropic API key"), { target: { value: KEY } });
    fireEvent.click(keyRow("anthropic").getByRole("button", { name: "Save" }));
    await waitUntil(
      t,
      () =>
        document.activeElement === keyRow("anthropic").queryByRole("button", { name: "Remove" }),
      "after Save, the row's Remove",
    );
    t.is(liveText("anthropic"), "Anthropic key: Valid");

    fireEvent.click(keyRow("anthropic").getByRole("button", { name: "Remove" }));
    await waitUntil(
      t,
      () => document.activeElement === keyRow("anthropic").queryByRole("button", { name: "Keep" }),
      "the confirmation's Keep",
    );
    fireEvent.click(keyRow("anthropic").getByRole("button", { name: "Keep" }));
    await waitUntil(
      t,
      () =>
        document.activeElement === keyRow("anthropic").queryByRole("button", { name: "Remove" }),
      "after Keep, Remove",
    );

    fireEvent.click(keyRow("anthropic").getByRole("button", { name: "Remove" }));
    fireEvent.click(
      keyRow("anthropic").getAllByRole("button", { name: "Remove" }).at(-1) as HTMLElement,
    );
    await waitUntil(
      t,
      () =>
        document.activeElement === keyRow("anthropic").queryByRole("button", { name: "Add key" }),
      "after the removal, Add key",
    );
    t.is(liveText("anthropic"), "");

    fireEvent.click(keyRow("openai").getByRole("button", { name: "Add key" }));
    await screen.findByLabelText("OpenAI API key");
    fireEvent.click(keyRow("openai").getByRole("button", { name: "Cancel" }));
    await waitUntil(
      t,
      () => document.activeElement === keyRow("openai").queryByRole("button", { name: "Add key" }),
      "after Cancel, Add key",
    );
  },
);

test.serial(
  "the live region says Checking…, then Invalid; the field names its error",
  async (t) => {
    let answer: () => void = () => undefined;
    await renderApp("/usage", {
      responses: {
        "usage.get": testWeeklyUsage({ keys: [{ ...ANTHROPIC, status: "invalid" }] }),
        "apiKeys.set": () =>
          new Promise((_resolve, reject) => {
            answer = () => reject(trpcRefusal("That key was rejected by OpenAI."));
          }),
      },
    });
    await waitUntil(t, () => liveText("anthropic") === "Anthropic key: Invalid", "Invalid");
    fireEvent.click(keyRow("openai").getByRole("button", { name: "Add key" }));
    fireEvent.change(await screen.findByLabelText("OpenAI API key"), {
      target: { value: "sk-proj-a-whole-openai-key-0000077c2" },
    });
    fireEvent.click(keyRow("openai").getByRole("button", { name: "Save" }));
    await waitUntil(t, () => liveText("openai") === "OpenAI key: Checking…", "Checking…");
    answer();
    await waitUntil(
      t,
      () =>
        keyRow("openai").queryByRole("alert")?.textContent === "That key was rejected by OpenAI.",
      "the refusal",
    );
    const field = screen.getByLabelText("OpenAI API key");
    const described = field.getAttribute("aria-describedby");
    t.truthy(described);
    t.is(document.getElementById(described ?? "")?.textContent, "That key was rejected by OpenAI.");
    t.is(field.getAttribute("aria-invalid"), "true");
  },
);

// ------------------------------------------------------------ recent runs and billing

const run = (index: number, question: string) => ({
  runId: `r${index}`,
  question,
  missing: null,
  tokens: 1000,
  share: 0.01,
  bill: "included",
  at: Date.UTC(2026, 10, 23) - index * 3_600_000,
});

test.serial("recent runs: at most six, each question clipped at 90 characters", async (t) => {
  const long =
    "How do the replication studies of the last decade weigh against the original priming results when the samples differ";
  t.true(long.length > 90);
  await renderApp("/usage", {
    responses: {
      "usage.listRuns": {
        runs: [
          run(0, long),
          ...Array.from({ length: 7 }, (_, i) => run(i + 1, `Question ${i + 1}`)),
        ],
        nextCursor: "x",
      },
    },
  });
  const region = within(await screen.findByRole("region", { name: "Recent runs" }));
  await region.findByText("Question 1");
  t.is(RECENT_RUNS, 6);
  t.is(region.getAllByRole("listitem").length, 6);
  const first = document.querySelector(".urun .rq")?.textContent ?? "";
  t.true(first.length <= 90, `${first.length} characters`);
  t.true(first.endsWith("…"));
  t.true(long.startsWith(first.slice(0, -1)));
  t.is(region.queryByText("Question 6"), null);
});

test.serial(
  "billing: a radiogroup; with only an OpenAI key the hint names its models",
  async (t) => {
    await renderApp("/usage", {
      responses: {
        "usage.get": testWeeklyUsage({ keys: [OPENAI] }),
        "models.list": KEY_ONLY_LISTING,
      },
    });
    const group = await screen.findByRole("radiogroup", { name: "When included tokens run out" });
    t.is(within(group).getAllByRole("radio").length, 2);
    await waitUntil(
      t,
      () =>
        screen.queryByText("Needs an Anthropic key. Your OpenAI key only runs OpenAI Key Only.") !==
        null,
      "the mockup's second sentence, from the key-only models listed",
    );
  },
);

test.serial("billing: a refused change shows its error and keeps the stored choice", async (t) => {
  await renderApp("/usage", {
    responses: {
      "usage.get": testWeeklyUsage({ keys: [ANTHROPIC] }),
      "usage.setBilling": () => {
        throw trpcRefusal("Add a working Anthropic key to continue on it.");
      },
    },
  });
  const keyRadio = await screen.findByRole("radio", { name: /Continue on my Anthropic key/ });
  fireEvent.click(keyRadio);
  await waitUntil(t, () => hasAlert("Add a working Anthropic key to continue on it."), "the error");
  t.true(input(screen.getByRole("radio", { name: /Pause my asks/ })).checked);
});

// ------------------------------------------------------------ the ring

test.serial("the ring: ok tone at nothing used", async (t) => {
  await renderApp("/usage", { responses: { "usage.get": testWeeklyUsage({ used: 0 }) } });
  await waitUntil(
    t,
    () => screen.queryByRole("link", { name: /^2M of 2M included tokens left/ }) !== null,
    "the reading",
  );
  t.is(screen.getByRole("link", { name: /included tokens left/ }).getAttribute("data-tone"), "ok");
});

test.serial(
  "the ring and the recent runs refetch when one of the member's runs ends",
  async (t) => {
    let replica: FixtureReplica | null = null;
    const config = fixtureReplicaConfig({ runMs: null });
    configureReplica({
      ...config,
      create: (viewer) => {
        replica = config.create(viewer) as FixtureReplica;
        return replica;
      },
    });
    // The recent runs as the Usage page left them in the cache.
    const app = await renderApp("/", {
      seed: (client) => client.setQueryData(["usage", "runs"], { runs: [], nextCursor: null }),
    });
    const field = await screen.findByRole("textbox", { name: "Ask or post" });
    const calls = (path: string) => app.trpc.calls.filter((call) => call.path === path).length;
    await waitUntil(t, () => calls("usage.get") >= 1, "the first reading");
    fireEvent.change(field, { target: { value: "What changed in the replication crisis?" } });
    fireEvent.click(screen.getByRole("button", { name: /^Ask$/ }));
    await waitUntil(
      t,
      () => (replica?.all("run") ?? []).some((r) => r.u === replica?.me && r.status === "running"),
      "the ask is running",
    );
    const before = calls("usage.get");
    act(() => replica?.flushRuns());
    await waitUntil(t, () => calls("usage.get") > before, "usage.get refetched");
    t.true(
      app.queryClient.getQueryState(["usage", "runs"])?.isInvalidated,
      "the recent runs are stale",
    );
  },
);

// ------------------------------------------------------------ Site Admin

test.serial(
  "Site Admin: a refused effort shows its error; an effort change refetches",
  async (t) => {
    let refuse = true;
    const app = await renderApp("/admin", {
      user: testUser({ isAdmin: true }),
      responses: {
        "models.list": KEY_ONLY_LISTING,
        "admin.models.setDefaultEffort": (input: { effort: string }) => {
          if (refuse) throw trpcRefusal("The default effort is low, medium, high or max.");
          return { defaultEffort: input.effort };
        },
      },
    });
    const efforts = within(await screen.findByRole("radiogroup", { name: "Default effort" }));
    fireEvent.click(efforts.getByRole("radio", { name: "High" }));
    await waitUntil(
      t,
      () => hasAlert("The default effort is low, medium, high or max."),
      "the error",
    );
    t.true(input(efforts.getByRole("radio", { name: "Medium" })).checked);
    refuse = false;
    const listCalls = () => app.trpc.calls.filter((call) => call.path === "models.list").length;
    const before = listCalls();
    fireEvent.click(efforts.getByRole("radio", { name: "Low" }));
    await waitUntil(t, () => listCalls() > before, "models.list refetched after the effort");
  },
);

// ------------------------------------------------------------ key-only models in the composer

async function openModelMenu() {
  fireEvent.click(await screen.findByTitle("Model and effort"));
  return screen.findAllByRole("menuitemradio");
}

test.serial("a key-only model without its key: Add a key, opening Usage", async (t) => {
  configureReplica(fixtureReplicaConfig({ runMs: null }));
  const app = await renderApp("/", {
    responses: { "models.list": KEY_ONLY_LISTING, "usage.get": testWeeklyUsage({ keys: [] }) },
  });
  await waitUntil(t, () => screen.queryByTitle("Model and effort")?.textContent === "Luna", "Luna");
  const radios = await openModelMenu();
  t.false(radios.some((item) => item.textContent?.includes("OpenAI Key Only")));
  const add = screen.getByRole("menuitem", { name: /OpenAI Key Only\s*Add a key/ });
  fireEvent.click(add);
  await waitUntil(t, () => app.router.state.location.pathname === "/usage", "Usage opens");
});

test.serial(
  "with its key the model is chosen; removing the key falls back to the site default",
  async (t) => {
    configureReplica(fixtureReplicaConfig({ runMs: null }));
    let keys: unknown[] = [OPENAI];
    const app = await renderApp("/", {
      responses: { "models.list": KEY_ONLY_LISTING, "usage.get": () => testWeeklyUsage({ keys }) },
    });
    await waitUntil(
      t,
      () => screen.queryByTitle("Model and effort")?.textContent === "Luna",
      "Luna",
    );
    const radios = await openModelMenu();
    const keyOnly = radios.find((item) => item.textContent?.includes("OpenAI Key Only"));
    t.regex(keyOnly?.textContent ?? "", /your OpenAI key/);
    fireEvent.click(keyOnly as HTMLElement);
    await waitUntil(
      t,
      () => screen.queryByTitle("Model and effort")?.textContent === "OpenAI",
      "the key-only model is chosen",
    );
    keys = [];
    await act(() => app.queryClient.invalidateQueries({ queryKey: ["usage", "week"] }));
    await waitUntil(
      t,
      () => screen.queryByTitle("Model and effort")?.textContent === "Luna",
      "back on the site default model",
    );
  },
);
