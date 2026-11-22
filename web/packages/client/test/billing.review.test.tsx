// The M5b client review's fixes (02 §2.2 item 4, §3.3, §5, W8.1, W8.2; 03
// K4, K6, K8, K14), in a viewer west of UTC: the reset is Friday 00:00 UTC,
// which is Thursday 16:00 here.
//
// - C1: a reading whose week has reset refuses nothing; a refusal and the
//   reset each fetch usage.get again;
// - C2, C3, CD6: a failed run's copy by reader (asker or not), by the
//   reading now, and by the key failure's `detail`;
// - C4: weekdays and dates in the viewer's zone;
// - C5: one ended run fetches usage.get once;
// - C6 to C9: the recent runs' error, the raw key out of the mutation cache,
//   the ring's labels, the error text of failed requests;
// - CD3: the K14 note in every state of a key row.

import type { RunRec } from "@session/mutators";
import { onlineManager } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import test, { type ExecutionContext } from "ava";

import {
  ACCESS_OTHER_TEXT,
  KEY_OTHER_TEXT,
  KEY_TEXT,
  TOKENS_OTHER_TEXT,
  TOKENS_PAST_TEXT,
  failedRunText,
} from "../src/features/branches/runFailureText.js";
import { currentToast } from "../src/features/shell/Toast.js";
import { UsageRing } from "../src/features/shell/UsageRing.js";
import {
  UNKNOWN_USAGE_LABEL,
  formatTokens,
  readTime,
  usageLabel,
} from "../src/features/shell/usage.js";
import { outOfTokensText, runDay, usageSentence } from "../src/features/usage/usageText.js";
import { UNREACHABLE_MESSAGE } from "../src/lib/toast.js";
import { configureReplica } from "../src/replica/ReplicaProvider.js";
import {
  fixtureReplicaConfig,
  runControl,
  type FixtureReplica,
} from "../src/replica/fixtureReplica.js";
import { outOfTokens, registryModels, type OnlineData } from "../src/replica/online.js";
import { useDraftsStore } from "../src/stores/drafts.js";

import {
  renderApp,
  renderInRouter,
  resetDocumentRoot,
  testUser,
  testWeeklyUsage,
  trpcRefusal,
  waitUntil,
} from "./helpers.js";

// The viewer's zone. Node applies a change of `TZ` at once; nothing above
// formats a date while it loads. (AVA runs each file in a process of its
// own, `workerThreads: false`.)
process.env.TZ = "America/Los_Angeles";

/** Friday 27 November 2026, 00:00 UTC: Thursday 26th, 16:00 in the viewer's
 * zone. `testWeeklyUsage`'s reset. */
const RESET = Date.UTC(2026, 10, 27);
const SPENT = 2_000_000;
const THURSDAY_TOAST =
  "Out of tokens until Thursday. You can still post, or add an API key in Usage.";
const KEY = "sk-ant-api03-a-whole-key-from-the-console-a1f9";

/** @ines.v's ask in #public; the fixture member reads as @ines.v. */
const FIRST = "01M7HWGZJGT7JTFFVSYPX055KV";

let made: FixtureReplica[] = [];
/** Feed tests read the fixture world; the Usage page tests do not need it. */
function configureFixtureWorld() {
  configureReplica({
    ...fixtureReplicaConfig({ runMs: null }),
    create: (viewer) => {
      const replica = fixtureReplicaConfig({ runMs: null }).create(viewer) as FixtureReplica;
      made.push(replica);
      return replica;
    },
  });
}
test.beforeEach(() => {
  made = [];
  useDraftsStore.setState({ byKey: {}, hidden: false });
});
test.afterEach.always(() => {
  cleanup();
  resetDocumentRoot();
  for (const r of made) r.dispose();
  configureReplica(null);
  runControl.hold = null;
  // back online for TanStack Query too: its `onlineManager` stopped
  // listening when the last query client went
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
  onlineManager.setOnline(true);
});

const replica = () => {
  const r = made.at(-1);
  if (!r) throw new Error("no replica");
  return r;
};
const firstCard = () => document.getElementById(`card-${FIRST}`);
const card = () => within(firstCard() as HTMLElement);
const rootRun = () => {
  const run = replica()
    .rawAll("run")
    .find((r) => r.th === FIRST && r.node === "r");
  if (!run) throw new Error("no root run");
  return run;
};

/** Writes the root's run as `change` makes it. */
function setRun(change: Partial<RunRec>) {
  const { rev: _rev, ...run } = { ...rootRun(), ...change };
  void _rev;
  const thread = replica().raw(`thread:${FIRST}`);
  const records = [run as never];
  if (thread?.kind === "thread") {
    const { rev: _r, ...rest } = thread;
    void _r;
    records.push({
      ...rest,
      running: run.status === "queued" || run.status === "running",
    } as never);
  }
  replica().write(records, run.status === "complete" ? [] : [`answer:${FIRST}`]);
}

async function openFeed(t: ExecutionContext, responses: Record<string, unknown> = {}) {
  configureFixtureWorld();
  const app = await renderApp("/", { user: testUser({ login: "ines.v" }), responses });
  await waitUntil(t, () => firstCard() !== null, "the first thread renders");
  return app;
}

/** Counts the writes the replica is handed, by mutator. */
function countWrites(r: FixtureReplica): string[] {
  const calls: string[] = [];
  const mutate = r.mutate.bind(r);
  r.mutate = (name: string, input: unknown) => {
    calls.push(name);
    return mutate(name as Parameters<typeof mutate>[0], input);
  };
  return calls;
}

const usageCalls = (app: { trpc: { calls: { path: string }[] } }) =>
  app.trpc.calls.filter((call) => call.path === "usage.get").length;

const ring = () => screen.getByRole("link", { name: /ncluded tokens left this week/ });

const online = (over: Partial<OnlineData>): OnlineData => ({
  models: registryModels(),
  defaultModel: "gemini-flash",
  defaultEffort: "medium",
  usage: { used: 0, allowance: 2_000_000, resetsAt: null },
  keys: [],
  billing: "pause",
  ...over,
});

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// ------------------------------------------------------------ C1

test("C1: a reading whose week has reset refuses nothing; one before it does", (t) => {
  const reading = { used: SPENT, allowance: SPENT, resetsAt: RESET };
  t.true(outOfTokens(online({ usage: reading }), "claude-fable", RESET - 1), "before the reset");
  t.false(outOfTokens(online({ usage: reading }), "claude-fable", RESET), "at the reset");
  t.false(outOfTokens(online({ usage: reading }), "claude-fable", RESET + 3_600_000), "after it");
});

test.serial(
  "C1: an ask with last week's spent reading in the cache is sent; the server decides",
  async (t) => {
    const app = await openFeed(t, {
      // the reading of a week that reset an hour ago (on the fixture clock)
      "usage.get": () => testWeeklyUsage({ used: SPENT, resetAt: replica().now() - 3_600_000 }),
    });
    await waitUntil(t, () => usageCalls(app) >= 1, "usage.get answered");
    await waitUntil(t, () => ring().getAttribute("aria-label") === UNKNOWN_USAGE_LABEL, "unknown");
    const calls = countWrites(replica());
    fireEvent.change(await screen.findByRole("textbox", { name: "Ask or post" }), {
      target: { value: "A question after the reset" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Ask$/ }));
    await waitUntil(t, () => calls.includes("threads.create"), "the ask is sent");
  },
);

test.serial(
  "C1: a refused ask fetches usage.get again, and the new week's reading lets it through",
  async (t) => {
    let week: "spent" | "new" = "spent";
    const app = await openFeed(t, {
      "usage.get": () =>
        week === "spent"
          ? testWeeklyUsage({ used: SPENT })
          : testWeeklyUsage({ used: 0, resetAt: RESET + 7 * 86_400_000 }),
    });
    await waitUntil(t, () => /^0 of 2M/.test(ring().getAttribute("aria-label") ?? ""), "spent");
    // the server's week has turned; the cached reading has not
    week = "new";
    const before = usageCalls(app);
    const calls = countWrites(replica());
    fireEvent.change(await screen.findByRole("textbox", { name: "Ask or post" }), {
      target: { value: "Refused once" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Ask$/ }));
    await waitUntil(t, () => currentToast() === THURSDAY_TOAST, "the toast names Thursday");
    t.deepEqual(calls, [], "nothing sent");
    await waitUntil(t, () => usageCalls(app) > before, "usage.get fetched again");
    await waitUntil(t, () => /^2M of 2M/.test(ring().getAttribute("aria-label") ?? ""), "new week");
    fireEvent.click(screen.getByRole("button", { name: /^Ask$/ }));
    await waitUntil(t, () => calls.includes("threads.create"), "the ask is sent");
  },
);

test.serial("C1: usage.get is fetched again once the reading's week resets", async (t) => {
  // The Usage page over the empty replica, whose clock is `Date.now()`: it
  // renders in far less than the 2 s to the reset, so a refetch scheduled
  // too early lands before it.
  let resetAt = 0;
  const fetchedAt: number[] = [];
  const app = await renderApp("/usage", {
    responses: {
      "usage.get": () => {
        const now = Date.now();
        fetchedAt.push(now);
        if (fetchedAt.length === 1) {
          resetAt = now + 2_000;
          return testWeeklyUsage({ used: SPENT, resetAt });
        }
        return testWeeklyUsage({ used: 0, resetAt: now + 7 * 86_400_000 });
      },
    },
  });
  await waitUntil(t, () => usageCalls(app) >= 1, "the first reading");
  // the refetch comes 1 s after the reset, past `waitFor`'s default wait
  await waitFor(
    () => {
      if (!/^2M of 2M/.test(ring().getAttribute("aria-label") ?? ""))
        throw new Error("the new week's reading");
    },
    { timeout: 10_000 },
  );
  const refetch = fetchedAt[1] ?? 0;
  t.true(refetch >= resetAt, `fetched again ${refetch - resetAt} ms after the reset, not before`);
});

// ------------------------------------------------------------ C2, C3, CD6

const view = (over: Partial<Parameters<typeof failedRunText>[1]> = {}) => ({
  asker: true,
  outOfTokens: false,
  resetAt: RESET,
  ...over,
});
const failed = (fail: Partial<NonNullable<RunRec["fail"]>>, pay: RunRec["pay"] = "included") => ({
  pay,
  bill: null,
  fail: { why: "key" as const, at: null, cls: null, ...fail },
});

test("C2: another reader reads the author's failure, not the asker's", (t) => {
  const other = view({ asker: false });
  t.is(failedRunText(failed({ why: "tokens" }), other), TOKENS_OTHER_TEXT);
  t.is(failedRunText(failed({ why: "key", detail: "key_rejected" }), other), KEY_OTHER_TEXT);
  t.is(failedRunText(failed({ why: "access" }), other), ACCESS_OTHER_TEXT);
  t.is(
    failedRunText(failed({ why: "rate", at: 0 }), other),
    "Stopped: Rate limited by model provider.",
  );
  t.is(
    failedRunText(failed({ why: "error", cls: "timeout" }), other),
    "Stopped: Exceeded maximum duration.",
    "a provider error reads the same for everyone",
  );
});

test("C3, C4: the asker's tokens copy: out now names the reset's weekday here; else past tense", (t) => {
  const tokens = failed({ why: "tokens" });
  t.is(failedRunText(tokens, view({ outOfTokens: true })), THURSDAY_TOAST);
  t.is(failedRunText(tokens, view({ outOfTokens: false })), TOKENS_PAST_TEXT);
  t.is(
    failedRunText(tokens, view({ outOfTokens: true, resetAt: null })),
    "Out of tokens until the weekly reset. You can still post, or add an API key in Usage.",
  );
});

test("CD6: the asker's key copy for each detail, with the key's provider", (t) => {
  const asker = view();
  const text = (detail: NonNullable<RunRec["fail"]>["detail"], pay: RunRec["pay"]) =>
    failedRunText(failed({ why: "key", detail }, pay), asker);
  t.is(text("key_only", null), "This model requires your own API key. Add one in Usage.");
  t.is(
    text("key_unset", "key:openai"),
    "No valid OpenAI key was set when this run started. Add a key in Usage.",
  );
  t.is(
    text("key_changed", "key:anthropic"),
    "Your Anthropic key was removed, replaced or marked invalid during this run. See Usage for more details.",
  );
  t.is(
    text("key_rejected", "key:anthropic"),
    "Anthropic rejected your API key. Add a new key in Usage.",
  );
  t.is(
    text("key_forbidden", "key:openai"),
    "OpenAI rejected this request with a permission error.",
  );
  t.is(text(undefined, "key:anthropic"), KEY_TEXT, "a record written before `detail`");
  t.is(
    failedRunText(
      {
        pay: "included",
        bill: "included+key:anthropic",
        fail: failed({ detail: "key_rejected" }).fail,
      },
      asker,
    ),
    "Anthropic rejected your API key. Add a new key in Usage.",
    "a run that moved to the key reads its provider from its bill",
  );
});

test.serial(
  "C2, C3: on a card, the asker reads their own copy by the reading now; another reader the author's",
  async (t) => {
    await openFeed(t, { "usage.get": testWeeklyUsage({ used: SPENT }) });
    await waitUntil(t, () => /^0 of 2M/.test(ring().getAttribute("aria-label") ?? ""), "spent");
    setRun({ status: "failed", fail: { why: "tokens", at: null, cls: null }, pay: null });
    await waitUntil(t, () => card().queryByText(THURSDAY_TOAST) !== null, "asker, out now");
    t.truthy(card().getByRole("button", { name: "Run again" }));

    setRun({
      status: "failed",
      fail: { why: "key", at: null, cls: null, detail: "key_forbidden" },
      pay: "key:anthropic",
    });
    await waitUntil(
      t,
      () => card().queryByText(/^Anthropic rejected this request with a permission error/) !== null,
      "asker, the key's detail",
    );

    setRun({
      status: "failed",
      fail: { why: "tokens", at: null, cls: null },
      pay: null,
      u: "jun.park",
    });
    await waitUntil(t, () => card().queryByText(TOKENS_OTHER_TEXT) !== null, "another reader");
    t.is(card().queryByRole("button", { name: "Run again" }), null);
    setRun({
      status: "failed",
      fail: { why: "key", at: null, cls: null, detail: "key_rejected" },
      pay: "key:anthropic",
      u: "jun.park",
    });
    await waitUntil(t, () => card().queryByText(KEY_OTHER_TEXT) !== null, "another reader, key");
  },
);

test.serial("C3: after the reset the asker's tokens copy is in the past tense", async (t) => {
  await openFeed(t, { "usage.get": testWeeklyUsage({ used: 0 }) });
  await waitUntil(t, () => /^2M of 2M/.test(ring().getAttribute("aria-label") ?? ""), "new week");
  setRun({ status: "failed", fail: { why: "tokens", at: null, cls: null }, pay: null });
  await waitUntil(t, () => card().queryByText(TOKENS_PAST_TEXT) !== null, "past tense");
  t.is(card().queryByText(THURSDAY_TOAST), null);
  t.truthy(card().getByRole("button", { name: "Run again" }));
});

// ------------------------------------------------------------ C4

test("C4: the weekday and dates are the viewer's zone's", (t) => {
  t.is(usageSentence({ used: 0, allowance: SPENT, resetAt: RESET }, RESET - 1).weekday, "Thursday");
  t.is(
    usageSentence({ used: 0, allowance: SPENT, resetAt: RESET }, RESET - 1, "UTC").weekday,
    "Friday",
  );
  t.is(runDay(Date.UTC(2026, 10, 21, 3)), "Nov 20", "03:00 UTC is the evening before here");
  t.is(runDay(Date.UTC(2026, 10, 21, 3), "UTC"), "Nov 21");
  t.is(outOfTokensText(RESET), THURSDAY_TOAST);
  t.is(
    outOfTokensText(RESET, "UTC"),
    "Out of tokens until Friday. You can still post, or add an API key in Usage.",
  );
});

test.serial("C4: the Usage page names Thursday and dates its runs here", async (t) => {
  await renderApp("/usage", {
    responses: {
      "usage.get": testWeeklyUsage({ used: 500_000 }),
      "usage.listRuns": {
        runs: [
          {
            runId: "r1",
            question: "An ask late on Friday evening",
            missing: null,
            tokens: 40_000,
            share: 0.02,
            bill: "included",
            at: Date.UTC(2026, 10, 21, 3),
          },
        ],
        nextCursor: null,
      },
    },
  });
  await screen.findByRole("img", { name: "75% left" });
  t.regex(document.querySelector(".usent")?.textContent ?? "", /Next reset Thursday, in /);
  t.truthy(await screen.findByText("2% · Nov 20"));
});

// ------------------------------------------------------------ C5

test.serial("C5: one of the viewer's runs ending fetches usage.get once", async (t) => {
  const app = await openFeed(t);
  await waitUntil(t, () => usageCalls(app) >= 1, "the first reading");
  // the fixture's executor would finish the run
  runControl.hold = "running";
  setRun({ status: "running", step: 0, finishedAt: null });
  await waitUntil(t, () => card().queryByText("Researching · Step 1 of 4") !== null, "running");
  await sleep(300);
  const before = usageCalls(app);
  setRun({ status: "complete", step: 3, note: null, finishedAt: rootRun().createdAt });
  await waitUntil(t, () => usageCalls(app) > before, "usage.get fetched again");
  await sleep(300);
  t.is(usageCalls(app) - before, 1, "once, not once per reader");
});

// ------------------------------------------------------------ C6

test.serial("C6: recent runs that fail to load say so", async (t) => {
  await renderApp("/usage", {
    responses: {
      "usage.listRuns": () => {
        throw trpcRefusal("Internal server error", "INTERNAL_SERVER_ERROR");
      },
    },
  });
  const runs = within(await screen.findByRole("region", { name: "Recent runs" }));
  t.truthy(
    await runs.findByText("Couldn't load your runs. Reload to try again.", {}, { timeout: 5_000 }),
  );
  t.is(runs.queryByText("No runs yet this week."), null);
});

// ------------------------------------------------------------ C7

test.serial("C7: the raw key leaves the mutation cache once the check answers", async (t) => {
  for (const refuse of [false, true]) {
    const app = await renderApp("/usage", {
      responses: {
        "apiKeys.set": () => {
          if (refuse) throw trpcRefusal("That key was rejected by Anthropic.");
          return { provider: "anthropic", last4: "a1f9", status: "valid", addedAt: 1 };
        },
      },
    });
    await screen.findByRole("region", { name: "API keys" });
    const row = within(
      document.querySelector<HTMLElement>('[data-key="anthropic"]') as HTMLElement,
    );
    fireEvent.click(row.getByRole("button", { name: "Add key" }));
    fireEvent.change(await screen.findByLabelText("Anthropic API key"), {
      target: { value: KEY },
    });
    fireEvent.click(row.getByRole("button", { name: "Save" }));
    await waitUntil(
      t,
      () => app.trpc.calls.some((call) => call.path === "apiKeys.set"),
      "the key is sent",
    );
    const holdsKey = () =>
      app.queryClient
        .getMutationCache()
        .getAll()
        .some((m) => JSON.stringify(m.state.variables ?? null).includes(KEY));
    await waitUntil(t, () => !holdsKey(), refuse ? "gone after a refusal" : "gone after a save");
    cleanup();
  }
});

// ------------------------------------------------------------ C8

test("C8: token counts round to 1M; what is left rounds down", (t) => {
  t.is(formatTokens(999_600), "1M");
  t.is(formatTokens(999_400), "999k");
  t.is(formatTokens(999_999, true), "999k");
  t.is(formatTokens(1_999_999, true), "1.99M");
  t.is(
    usageLabel({ used: 1, allowance: SPENT, resetsAt: null }),
    "1.99M of 2M included tokens left this week",
  );
  t.is(
    usageLabel({ used: 0, allowance: SPENT, resetsAt: null }),
    "2M of 2M included tokens left this week",
  );
  t.is(usageLabel(null), UNKNOWN_USAGE_LABEL);
});

test("C8: offline, the label names when the reading was taken, in the viewer's zone", (t) => {
  const readAt = Date.UTC(2026, 10, 25, 23, 5); // 15:05 here
  const reading = { used: 1_000_000, allowance: SPENT, resetsAt: RESET, readAt };
  const now = readAt + 2 * 3_600_000;
  t.is(readTime(readAt, now), "3:05 PM");
  t.is(readTime(readAt, readAt + 30 * 3_600_000), "Nov 25, 3:05 PM", "another day");
  t.is(
    usageLabel(reading, now, { offline: true }),
    "1M of 2M included tokens left this week as of 3:05 PM; resets in 23 h",
  );
  t.is(
    usageLabel(reading, now),
    "1M of 2M included tokens left this week; resets in 23 h",
    "online it does not",
  );
});

test.serial("C8: the ring with no reading draws no arc and says it is unknown", async (t) => {
  await renderInRouter(<UsageRing reading={null} />);
  const link = ring();
  t.is(link.getAttribute("aria-label"), UNKNOWN_USAGE_LABEL);
  t.is(link.getAttribute("data-tone"), null);
  t.is(link.querySelectorAll("circle").length, 1, "the track alone");
});

test.serial("C8: before usage.get answers, and when it fails, the ring is unknown", async (t) => {
  let answer: (value: unknown) => void = () => undefined;
  await renderApp("/", {
    responses: { "usage.get": () => new Promise((resolve) => (answer = resolve)) },
  });
  t.is(ring().getAttribute("aria-label"), UNKNOWN_USAGE_LABEL, "not loaded yet");
  answer(testWeeklyUsage({ used: 1_000_000 }));
  await waitUntil(t, () => /^1M of 2M/.test(ring().getAttribute("aria-label") ?? ""), "loaded");
  cleanup();

  await renderApp("/", {
    responses: {
      "usage.get": () => {
        throw trpcRefusal("Internal server error", "INTERNAL_SERVER_ERROR");
      },
    },
  });
  await sleep(1_500);
  t.is(ring().getAttribute("aria-label"), UNKNOWN_USAGE_LABEL, "failed");
});

test.serial("C8: offline, the ring names when its reading was taken", async (t) => {
  await renderApp("/", { responses: { "usage.get": testWeeklyUsage({ used: 1_000_000 }) } });
  await waitUntil(t, () => /^1M of 2M/.test(ring().getAttribute("aria-label") ?? ""), "loaded");
  t.notRegex(ring().getAttribute("aria-label") ?? "", / as of /);
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
  window.dispatchEvent(new Event("offline"));
  await waitUntil(
    t,
    () =>
      / left this week as of \d{1,2}:\d{2} [AP]M; /.test(ring().getAttribute("aria-label") ?? ""),
    "the reading's time",
  );
});

// ------------------------------------------------------------ C9

test.serial("C9: a request that fails without a refusal shows fixed copy", async (t) => {
  await renderApp("/usage", {
    responses: {
      "apiKeys.set": () => {
        throw new TypeError("Failed to fetch");
      },
    },
  });
  await screen.findByRole("region", { name: "API keys" });
  const row = within(document.querySelector<HTMLElement>('[data-key="anthropic"]') as HTMLElement);
  fireEvent.click(row.getByRole("button", { name: "Add key" }));
  fireEvent.change(await screen.findByLabelText("Anthropic API key"), { target: { value: KEY } });
  fireEvent.click(row.getByRole("button", { name: "Save" }));
  t.truthy(await row.findByText(UNREACHABLE_MESSAGE));
  t.is(screen.queryByText("Failed to fetch"), null);
  cleanup();

  await renderApp("/admin", {
    user: testUser({ isAdmin: true }),
    responses: {
      "admin.models.setDefaultEffort": () => {
        throw new TypeError("Failed to fetch");
      },
    },
  });
  const efforts = within(await screen.findByRole("radiogroup", { name: "Default effort" }));
  fireEvent.click(efforts.getByRole("radio", { name: "Low" }));
  t.truthy(await screen.findByText(UNREACHABLE_MESSAGE));
  t.is(screen.queryByText("Failed to fetch"), null);
});

// ------------------------------------------------------------ CD3

test.serial("CD3: the K14 note is beside each key in every state", async (t) => {
  const note = (provider: string) => `Asks on this key go to ${provider} directly.`;
  const saved = { provider: "anthropic", last4: "a1f9", status: "valid", addedAt: 1 };
  let keys: unknown[] = [];
  let release: () => void = () => undefined;
  await renderApp("/usage", {
    responses: {
      "usage.get": () => testWeeklyUsage({ keys }),
      "apiKeys.set": () =>
        new Promise((resolve) => {
          release = () => {
            keys = [saved];
            resolve(saved);
          };
        }),
    },
  });
  await screen.findByRole("region", { name: "API keys" });
  const rowOf = (provider: string) =>
    within(document.querySelector<HTMLElement>(`[data-key="${provider}"]`) as HTMLElement);
  const row = rowOf("anthropic");
  t.truthy(row.getByText("Not set"));
  t.truthy(row.getByText(note("Anthropic")), "Not set");
  t.truthy(rowOf("openai").getByText(note("OpenAI")), "Not set, OpenAI");
  fireEvent.click(row.getByRole("button", { name: "Add key" }));
  await screen.findByLabelText("Anthropic API key");
  t.truthy(row.getByText(note("Anthropic")), "the form");
  fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: KEY } });
  fireEvent.click(row.getByRole("button", { name: "Save" }));
  await row.findByText("Checking…");
  t.truthy(row.getByText(note("Anthropic")), "Checking…");
  release();
  await row.findByText("Valid");
  t.truthy(row.getByText(note("Anthropic")), "Valid");
  cleanup();
  await renderApp("/usage", {
    responses: {
      "usage.get": () => testWeeklyUsage({ keys: [{ ...saved, status: "invalid" }] }),
    },
  });
  const invalid = within((await screen.findByText("Invalid")).closest("[data-key]") as HTMLElement);
  t.truthy(invalid.getByText(note("Anthropic")), "Invalid");
});
