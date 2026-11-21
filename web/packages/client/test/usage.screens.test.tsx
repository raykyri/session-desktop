// Usage and API keys (02 W8.1), the Site Admin settings (02 W8.2) and the
// composer's start on the site defaults (02 §5; 03 K4-K7, K12, K15), over a
// recording tRPC stub.

import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import test from "ava";

import { useComposerChoice } from "../src/features/feed/FeedContext.js";
import { currentToast } from "../src/features/shell/Toast.js";
import { runCharge, runQuestion, usageSentence } from "../src/features/usage/usageText.js";
import { configureReplica } from "../src/replica/ReplicaProvider.js";
import { fixtureReplicaConfig } from "../src/replica/fixtureReplica.js";

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

test.afterEach.always(() => {
  cleanup();
  resetDocumentRoot();
  configureReplica(null);
  useComposerChoice.setState({ model: null, effort: null });
});

/** The radio or text field `element` is. */
function input(element: HTMLElement | undefined): HTMLInputElement {
  if (!(element instanceof HTMLInputElement)) throw new Error("not an input");
  return element;
}

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const keyRow = (provider: string) =>
  within(document.querySelector<HTMLElement>(`[data-key="${provider}"]`) as HTMLElement);

// ------------------------------------------------------------ text

test("the usage sentence, the run charge and a run without its question", (t) => {
  const now = Date.UTC(2026, 10, 24, 19);
  t.deepEqual(
    usageSentence(
      { used: 500_000, allowance: 2_000_000, resetAt: Date.UTC(2026, 10, 27) },
      now,
      "UTC",
    ),
    { percent: 75, weekday: "Fri", resetIn: "2d 5h" },
  );
  t.is(runCharge({ bill: "included", share: 0.004 }), "<1%");
  // the cut-off is 0.5 %, which itself rounds to 1 % (03 K5)
  t.is(runCharge({ bill: "included", share: 0.004_99 }), "<1%");
  t.is(runCharge({ bill: "included", share: 0.005 }), "1%");
  t.is(runCharge({ bill: "included", share: 0.123 }), "12%");
  t.is(runCharge({ bill: "key:anthropic", share: 0 }), "Anthropic key");
  t.is(runCharge({ bill: "key:openai", share: 0 }), "OpenAI key");
  t.is(runCharge({ bill: "included+key:anthropic", share: 0.01 }), "Included + Anthropic key");
  t.deepEqual(runQuestion({ question: null, missing: "removed" }), { text: "Removed", gone: true });
  t.deepEqual(runQuestion({ question: null, missing: "unavailable" }), {
    text: "No longer available",
    gone: true,
  });
});

// ------------------------------------------------------------ Usage page

test.serial("the usage line and bar in the ring's tones, and the recent runs", async (t) => {
  await renderApp("/usage", {
    responses: {
      "usage.get": testWeeklyUsage({ used: 1_700_000 }),
      "usage.listRuns": {
        runs: [
          {
            runId: "r1",
            question: "How do bloom filters trade memory for false positives?",
            missing: null,
            tokens: 40_000,
            share: 0.02,
            bill: "included",
            at: Date.UTC(2026, 10, 23, 12),
          },
          {
            runId: "r2",
            question: null,
            missing: "removed",
            tokens: 900,
            share: 0,
            bill: "key:anthropic",
            at: Date.UTC(2026, 10, 22, 12),
          },
        ],
        nextCursor: null,
      },
    },
  });
  const bar = await screen.findByRole("img", { name: "15% left" });
  t.true(bar.classList.contains("warn"));
  // the bar's fill is what is left, not what was used
  // (the page writes "15.0%"; the style reads it back as "15%")
  t.is(bar.querySelector("span")?.style.width, "15%");
  t.regex(document.querySelector(".usent")?.textContent ?? "", /^You have 15% of usage left/);
  const runs = within(screen.getByRole("region", { name: "Recent runs" }));
  t.truthy(await runs.findByText("How do bloom filters trade memory for false positives?"));
  t.truthy(runs.getByText("2% · Nov 23"));
  t.truthy(runs.getByText("Removed"));
  t.truthy(runs.getByText("Anthropic key · Nov 22"));
});

test.serial("no runs this week, and the bar at 95 % used", async (t) => {
  await renderApp("/usage", { responses: { "usage.get": testWeeklyUsage({ used: 1_900_000 }) } });
  t.true((await screen.findByRole("img", { name: "5% left" })).classList.contains("bad"));
  await screen.findByText("No runs yet this week.");
  t.pass();
});

test.serial(
  "the key radio is disabled without a valid Anthropic key, with its reason",
  async (t) => {
    const app = await renderApp("/usage");
    const keyRadio = await screen.findByRole("radio", { name: /Continue on my Anthropic key/ });
    t.true(input(keyRadio).disabled);
    t.truthy(screen.getByText("Add a key below to turn this on."));
    app.unmount();

    await renderApp("/usage", {
      responses: {
        "usage.get": testWeeklyUsage({
          keys: [{ provider: "openai", last4: "77c2", status: "valid", addedAt: 1 }],
        }),
      },
    });
    t.true(
      input(await screen.findByRole("radio", { name: /Continue on my Anthropic key/ })).disabled,
    );
    t.truthy(screen.getByText(/^Needs an Anthropic key\./));
  },
);

test.serial("billing: the two settings with their toasts", async (t) => {
  let billing = "pause";
  const app = await renderApp("/usage", {
    responses: {
      "usage.get": () =>
        testWeeklyUsage({
          billing,
          keys: [{ provider: "anthropic", last4: "a1f9", status: "valid", addedAt: 1 }],
        }),
      "usage.setBilling": (input: { mode: string }) => {
        billing = input.mode;
        return { billing };
      },
    },
  });
  const keyRadio = await screen.findByRole("radio", { name: /Continue on my Anthropic key/ });
  t.false(input(keyRadio).disabled);
  t.truthy(screen.getByText("Asks bill to your Anthropic key until the reset."));
  fireEvent.click(keyRadio);
  await waitUntil(t, () => currentToast() === "Asks will continue on your API key.", "key toast");
  t.deepEqual(app.trpc.calls.find((call) => call.path === "usage.setBilling")?.input, {
    mode: "key",
  });
  await waitUntil(t, () => input(keyRadio).checked, "the key setting is checked");
  fireEvent.click(screen.getByRole("radio", { name: /Pause my asks until the reset/ }));
  await waitUntil(t, () => currentToast() === "Asks will pause until the reset.", "pause toast");
});

test.serial(
  "adding a key: Checking… while the provider checks it, then Valid and the toast",
  async (t) => {
    const check = deferred<unknown>();
    let keys: unknown[] = [];
    const app = await renderApp("/usage", {
      responses: {
        "usage.get": () => testWeeklyUsage({ keys }),
        "apiKeys.set": () =>
          check.promise.then(() => {
            keys = [{ provider: "anthropic", last4: "a1f9", status: "valid", addedAt: 1 }];
            return keys[0];
          }),
      },
    });
    await screen.findByRole("region", { name: "API keys" });
    t.truthy(keyRow("openai").getByText("Not set"));
    fireEvent.click(keyRow("anthropic").getByRole("button", { name: "Add key" }));
    const field = await screen.findByLabelText("Anthropic API key");
    t.is(field.getAttribute("type"), "password");
    t.is(field.getAttribute("placeholder"), "Paste key (sk-ant-...)");
    fireEvent.change(field, { target: { value: `  ${KEY} ` } });
    fireEvent.click(keyRow("anthropic").getByRole("button", { name: "Save" }));

    await waitUntil(
      t,
      () => keyRow("anthropic").queryByText("Checking…") !== null,
      "Checking… while the request runs",
    );
    t.truthy(keyRow("anthropic").getByText("sk-ant-••••a1f9"));
    t.deepEqual(app.trpc.calls.find((call) => call.path === "apiKeys.set")?.input, {
      provider: "anthropic",
      raw: KEY,
    });
    check.resolve(null);
    await waitUntil(t, () => currentToast() === "Anthropic key works.", "the toast");
    await waitUntil(t, () => keyRow("anthropic").queryByText("Valid") !== null, "the Valid chip");
    t.truthy(keyRow("anthropic").getByText("sk-ant-••••a1f9"));
    t.truthy(keyRow("anthropic").getByText(/fall under your own agreement with/));
  },
);

test.serial(
  "a refused key saves nothing and reopens the form with the text and the message",
  async (t) => {
    const answers = [
      "That key was rejected by Anthropic.",
      "Couldn't reach Anthropic to check the key. Try again.",
    ];
    for (const message of answers) {
      const app = await renderApp("/usage", {
        responses: {
          "apiKeys.set": () => {
            throw trpcRefusal(message);
          },
        },
      });
      await screen.findByRole("region", { name: "API keys" });
      fireEvent.click(keyRow("anthropic").getByRole("button", { name: "Add key" }));
      fireEvent.change(await screen.findByLabelText("Anthropic API key"), {
        target: { value: KEY },
      });
      fireEvent.click(keyRow("anthropic").getByRole("button", { name: "Save" }));
      await waitUntil(
        t,
        () => screen.queryAllByRole("alert").some((node) => node.textContent === message),
        message,
      );
      t.is(input(screen.getByLabelText("Anthropic API key")).value, KEY);
      t.is(keyRow("anthropic").queryByText("Valid"), null);
      app.unmount();
    }
  },
);

test.serial("each format error, before anything is sent", async (t) => {
  const app = await renderApp("/usage");
  await screen.findByRole("region", { name: "API keys" });
  const cases: [string, string, string][] = [
    ["anthropic", "", "Paste a key."],
    ["openai", KEY, "That looks like an Anthropic key. Add it under Anthropic."],
    [
      "openai",
      "sk-short",
      "OpenAI keys start with sk- and are longer than this. Copy the whole key from your OpenAI account.",
    ],
    [
      "anthropic",
      "sk-proj-an-openai-key-pasted-here-0000",
      "Anthropic keys start with sk-ant- and are longer than this. Copy the whole key from your Anthropic account.",
    ],
  ];
  for (const [provider, value, message] of cases) {
    const row = keyRow(provider);
    const add = row.queryByRole("button", { name: "Add key" });
    if (add) fireEvent.click(add);
    const name = provider === "openai" ? "OpenAI API key" : "Anthropic API key";
    fireEvent.change(await screen.findByLabelText(name), { target: { value } });
    fireEvent.click(row.getByRole("button", { name: "Save" }));
    await waitUntil(
      t,
      () => row.queryAllByRole("alert").some((node) => node.textContent === message),
      message,
    );
  }
  t.is(app.trpc.calls.filter((call) => call.path === "apiKeys.set").length, 0, "no key was sent");
});

test.serial("removing a key asks first, then shows the toast", async (t) => {
  let keys: unknown[] = [{ provider: "openai", last4: "77c2", status: "valid", addedAt: 1 }];
  const app = await renderApp("/usage", {
    responses: {
      "usage.get": () => testWeeklyUsage({ keys }),
      "apiKeys.remove": () => {
        keys = [];
        return { removed: true };
      },
    },
  });
  await waitUntil(t, () => document.querySelector('[data-key="openai"] .chip') !== null, "row");
  t.truthy(keyRow("openai").getByText("sk-••••77c2"));
  fireEvent.click(keyRow("openai").getByRole("button", { name: "Remove" }));
  t.truthy(keyRow("openai").getByText("Remove the OpenAI key? Asks billed to it will stop."));
  fireEvent.click(keyRow("openai").getByRole("button", { name: "Keep" }));
  t.truthy(keyRow("openai").getByText("Valid"));
  fireEvent.click(keyRow("openai").getByRole("button", { name: "Remove" }));
  fireEvent.click(keyRow("openai").getByRole("button", { name: "Remove" }));
  await waitUntil(t, () => currentToast() === "OpenAI key removed.", "the toast");
  await waitUntil(t, () => keyRow("openai").queryByText("Not set") !== null, "Not set");
  t.deepEqual(app.trpc.calls.find((call) => call.path === "apiKeys.remove")?.input, {
    provider: "openai",
  });
});

test.serial("a key a run found rejected shows Invalid", async (t) => {
  await renderApp("/usage", {
    responses: {
      "usage.get": testWeeklyUsage({
        keys: [{ provider: "anthropic", last4: "a1f9", status: "invalid", addedAt: 1 }],
      }),
    },
  });
  await waitUntil(
    t,
    () => document.querySelector('[data-key="anthropic"] .chip')?.textContent === "Invalid",
    "Invalid",
  );
  t.true(
    input(await screen.findByRole("radio", { name: /Continue on my Anthropic key/ })).disabled,
  );
});

// ------------------------------------------------------------ the ring

test.serial("the app bar ring reads usage.get", async (t) => {
  await renderApp("/usage", { responses: { "usage.get": testWeeklyUsage({ used: 1_700_000 }) } });
  await waitUntil(
    t,
    () =>
      screen.queryByRole("link", { name: /^300k of 2M included tokens left this week/ }) !== null,
    "the ring's label",
  );
  t.is(
    screen.getByRole("link", { name: /included tokens left/ }).getAttribute("data-tone"),
    "warn",
  );
});

// ------------------------------------------------------------ Site Admin

const KEY_ONLY_LISTING = (() => {
  const listing = testModelListing({ defaultModel: "gemini-flash", defaultEffort: "medium" }) as {
    defaultModel: string;
    defaultEffort: string;
    models: { id: string; label: string; provider: string; payers: string[]; efforts: string[] }[];
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

test.serial("Site Admin: the two groups, no key-only model, every effort enabled", async (t) => {
  await renderApp("/admin", {
    user: testUser({ isAdmin: true }),
    responses: { "models.list": KEY_ONLY_LISTING },
  });
  t.truthy(await screen.findByText("Settings for everyone on Session."));
  const models = within(await screen.findByRole("radiogroup", { name: "Default model" }));
  t.deepEqual(
    models.getAllByRole("radio").map((radio) => input(radio).value),
    ["gemini-flash", "deepseek-flash", "gpt-luna", "claude-fable"],
  );
  t.is(models.queryByText("OpenAI Key Only"), null);
  t.true(input(models.getByRole("radio", { name: /Gemini 3.8 Flash/ })).checked);
  const efforts = within(screen.getByRole("radiogroup", { name: "Default effort" }));
  const radios = efforts.getAllByRole("radio").map(input);
  t.deepEqual(
    radios.map((radio) => radio.value),
    ["low", "medium", "high", "max"],
  );
  t.true(radios.every((radio) => !radio.disabled));
  t.true(radios[1]?.checked);
});

test.serial("Site Admin: each change shows its toast and refetches models.list", async (t) => {
  let listing = KEY_ONLY_LISTING;
  const app = await renderApp("/admin", {
    user: testUser({ isAdmin: true }),
    responses: {
      "models.list": () => listing,
      "admin.models.setDefault": (input: { model: string }) => {
        listing = { ...listing, defaultModel: input.model };
        return { defaultModel: input.model };
      },
      "admin.models.setDefaultEffort": (input: { effort: string }) => {
        listing = { ...listing, defaultEffort: input.effort };
        return { defaultEffort: input.effort };
      },
    },
  });
  const listCalls = () => app.trpc.calls.filter((call) => call.path === "models.list").length;
  const models = within(await screen.findByRole("radiogroup", { name: "Default model" }));
  const before = listCalls();
  fireEvent.click(models.getByRole("radio", { name: /Claude Fable 5\.1/ }));
  await waitUntil(t, () => currentToast() === "Default model set to Claude Fable 5.1.", "toast");
  await waitUntil(t, () => listCalls() > before, "models.list refetched");
  t.true(input(models.getByRole("radio", { name: /Claude Fable 5\.1/ })).checked);

  const efforts = within(screen.getByRole("radiogroup", { name: "Default effort" }));
  fireEvent.click(efforts.getByRole("radio", { name: "High" }));
  await waitUntil(t, () => currentToast() === "Default effort set to High.", "effort toast");
  t.true(input(efforts.getByRole("radio", { name: "High" })).checked);
});

test.serial("Site Admin: a refused change restores the choice and shows the error", async (t) => {
  await renderApp("/admin", {
    user: testUser({ isAdmin: true }),
    responses: {
      "models.list": KEY_ONLY_LISTING,
      "admin.models.setDefault": () => {
        throw trpcRefusal("That model is not available.");
      },
    },
  });
  const models = within(await screen.findByRole("radiogroup", { name: "Default model" }));
  fireEvent.click(models.getByRole("radio", { name: /DeepSeek/ }));
  await waitUntil(
    t,
    () =>
      screen
        .queryAllByRole("alert")
        .some((node) => node.textContent === "That model is not available."),
    "the error",
  );
  t.true(input(models.getByRole("radio", { name: /Gemini 3.8 Flash/ })).checked);
});

test.serial("a member who is not a site admin gets the not-found page at /admin", async (t) => {
  await renderApp("/admin", { user: testUser({ isAdmin: false }) });
  await waitUntil(
    t,
    () => screen.queryAllByRole("alert").some((node) => node.textContent?.includes("Not found")),
    "not found",
  );
  t.is(screen.queryByRole("radiogroup", { name: "Default model" }), null);
});

// ------------------------------------------------------------ the composer

/** The composer's model button and, from its menu, the current effort. */
async function composerChoice(): Promise<{ model: string; effort: string; checked: string }> {
  const button = await screen.findByTitle("Model and effort");
  fireEvent.click(button);
  const items = await screen.findAllByRole("menuitemradio");
  const checked = items.find((item) => item.getAttribute("aria-checked") === "true");
  const effort = document.querySelector("[role='menu'] .mi-v")?.textContent ?? "";
  fireEvent.keyDown(items[0] as HTMLElement, { key: "Escape" });
  return { model: button.textContent, effort, checked: checked?.textContent ?? "" };
}

test.serial("the composer starts on the site default model and effort", async (t) => {
  configureReplica(fixtureReplicaConfig({ runMs: null }));
  await renderApp("/", {
    responses: {
      "models.list": testModelListing({ defaultModel: "gpt-luna", defaultEffort: "low" }),
    },
  });
  await waitUntil(
    t,
    () => screen.queryByTitle("Model and effort")?.textContent === "Luna",
    "the default model",
  );
  t.deepEqual(await composerChoice(), { model: "Luna", effort: "Low", checked: "GPT-5.6 Luna" });
});

test.serial("a default effort the default model does not accept steps down", async (t) => {
  configureReplica(fixtureReplicaConfig({ runMs: null }));
  await renderApp("/", {
    responses: {
      "models.list": testModelListing({ defaultModel: "gemini-flash", defaultEffort: "max" }),
    },
  });
  await waitUntil(
    t,
    () => screen.queryByTitle("Model and effort")?.textContent === "Gemini",
    "the default model",
  );
  t.like(await composerChoice(), { model: "Gemini", effort: "High" });
});
