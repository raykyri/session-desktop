// Out of included tokens with no usable payer (02 §5, 03 K8): every write
// that starts a run (Ask, follow-up, Continue, Branch, Branch here, Look up,
// Run again) is refused before it is sent with the out-of-tokens toast and
// its text stays in the composer, while posts, replies and comments send. A
// write the server applies after the allowance ran out is kept, with its run
// failed tokens, shown with the run-status copy; its composer is cleared.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import test from "ava";

import { TOKENS_PAST_TEXT } from "../src/features/branches/runFailureText.js";
import { clearToast, currentToast } from "../src/features/shell/Toast.js";
import { outOfTokensText } from "../src/features/usage/usageText.js";
import { configureReplica } from "../src/replica/ReplicaProvider.js";
import {
  createFixtureReplica,
  fixtureReplicaConfig,
  runControl,
  type FixtureReplica,
} from "../src/replica/fixtureReplica.js";
import { outOfTokens, registryModels, type OnlineData } from "../src/replica/online.js";
import { channelByName } from "../src/replica/queries.js";
import { makeWrites } from "../src/replica/writes.js";
import { useDraftsStore } from "../src/stores/drafts.js";

import { renderApp, testWeeklyUsage, waitUntil } from "./helpers.js";

/** @ines.v's ask in #public, answered; the fixture member reads as @ines.v. */
const FIRST = "01M7HWGZJGT7JTFFVSYPX055KV";

let made: FixtureReplica[] = [];
test.beforeEach(() => {
  made = [];
  configureReplica({
    ...fixtureReplicaConfig({ runMs: null }),
    create: (viewer) => {
      const replica = fixtureReplicaConfig({ runMs: null }).create(viewer) as FixtureReplica;
      made.push(replica);
      return replica;
    },
  });
  useDraftsStore.setState({ byKey: {}, hidden: false });
});
test.afterEach.always(() => {
  cleanup();
  for (const r of made) r.dispose();
  configureReplica(null);
  runControl.hold = null;
});

const replica = () => {
  const r = made.at(-1);
  if (!r) throw new Error("no replica");
  return r;
};

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

const online = (over: Partial<OnlineData>): OnlineData => ({
  models: registryModels(),
  defaultModel: "gemini-flash",
  defaultEffort: "medium",
  usage: { used: 0, allowance: 2_000_000, resetsAt: null },
  keys: [],
  billing: "pause",
  ...over,
});
const SPENT = { used: 2_000_000, allowance: 2_000_000, resetsAt: null };
/** The server's clock in these checks. */
const NOW = Date.UTC(2026, 10, 25, 12);
/** The reset `testWeeklyUsage` names, and its toast in the machine's zone
 * (the zones themselves are `billing.review.test.tsx`'s). */
const OUT_TEXT = outOfTokensText(Date.UTC(2026, 10, 27));

test("K8: the client's payer rule is the server's over usage.get", (t) => {
  t.false(outOfTokens(online({}), "claude-fable", NOW), "tokens left");
  t.false(outOfTokens(online({ usage: null }), "claude-fable", NOW), "unknown: the server decides");
  t.true(outOfTokens(online({ usage: SPENT }), "claude-fable", NOW), "spent, billing pause");
  t.true(
    outOfTokens(online({ usage: SPENT, billing: "key" }), "claude-fable", NOW),
    "billing key without a key",
  );
  t.false(
    outOfTokens(online({ usage: SPENT, billing: "key", keys: ["anthropic"] }), "claude-fable", NOW),
    "the Anthropic key pays for an Anthropic model",
  );
  t.true(
    outOfTokens(online({ usage: SPENT, billing: "key", keys: ["anthropic"] }), "gemini-flash", NOW),
    "but not for a model it cannot run",
  );
  t.false(
    outOfTokens(online({ usage: SPENT }), "no-such-model", NOW),
    "unknown model: the server decides",
  );
});

test.serial(
  "K8: out of tokens, every write that starts a run is refused before it is sent; posts, replies and comments send",
  async (t) => {
    const r = createFixtureReplica("ines.v", { runMs: null });
    made.push(r);
    const space = channelByName(r, "public");
    if (!space) throw new Error("no #public");
    const calls = countWrites(r);
    const writes = makeWrites(r, { outOfTokensToast: () => OUT_TEXT });
    const model = { model: "claude-fable", effort: "medium" } as const;

    const refused = async (name: string, made_: Promise<unknown>) => {
      t.falsy(await made_, name);
      t.deepEqual(calls, [], `${name}: nothing sent`);
      t.is(currentToast(), OUT_TEXT, name);
    };
    await refused("Ask", writes.ask(space.id, "An ask", model.model, model.effort));
    await refused(
      "follow-up and Continue",
      writes.fork({ thread: FIRST, parent: "r", q: "And then?", ...model }),
    );
    await refused(
      "Branch here",
      writes.fork({
        thread: FIRST,
        parent: "r",
        q: "Why this?",
        quote: "A passage.",
        b: 0,
        ...model,
      }),
    );
    await refused(
      "Look up",
      writes.lookUp({ thread: FIRST, look: "passage", quote: "A passage.", b: 0, ...model }),
    );
    await refused("Run again", writes.retry({ thread: FIRST, node: "r", attempt: 1, ...model }));

    t.truthy(await writes.post(space.id, "A post still sends"));
    t.deepEqual(calls, ["threads.create"]);
    t.truthy(await writes.comment(FIRST, "r", "A comment still sends"));
    t.deepEqual(calls, ["threads.create", "comments.create"]);
  },
);

test.serial(
  "K8: the composer refuses an ask out of tokens and keeps its text; a post sends",
  async (t) => {
    await renderApp("/", { responses: { "usage.get": testWeeklyUsage({ used: 2_000_000 }) } });
    await waitUntil(
      t,
      () => screen.queryByRole("link", { name: /^0 of 2M included tokens left/ }) !== null,
      "the ring reads the spent allowance",
    );
    const calls = countWrites(replica());
    const field = await screen.findByRole("textbox", { name: "Ask or post" });
    fireEvent.change(field, { target: { value: "One more question" } });
    fireEvent.click(screen.getByRole("button", { name: /^Ask$/ }));
    await waitUntil(t, () => currentToast() === OUT_TEXT, "the out-of-tokens toast");
    t.deepEqual(calls, [], "nothing sent");
    t.is(
      screen.getByRole("textbox", { name: "Ask or post" }),
      screen.getByDisplayValue("One more question"),
      "the text stays in the composer",
    );

    fireEvent.click(screen.getByRole("button", { name: "Ask or post" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Post/ }));
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    await waitUntil(t, () => calls.length === 1, "the post is sent");
    t.deepEqual(calls, ["threads.create"]);
  },
);

test.serial(
  "K8: an ask the server applies with nothing to pay shows its run failed tokens; the composer is cleared",
  async (t) => {
    await renderApp("/");
    await waitUntil(t, () => document.getElementById(`card-${FIRST}`) !== null, "the feed");
    // the fixture's executor would start the queued run
    runControl.hold = "queued";
    const r = replica();
    const mutate = r.mutate.bind(r);
    // the server applies the ask after the allowance ran out: its run is
    // written failed tokens with no payer (`03` K8)
    r.mutate = async (name: string, input: unknown) => {
      const outcome = await mutate(name as Parameters<typeof mutate>[0], input);
      const id = (input as { id: string }).id;
      const run = r.rawAll("run").find((x) => x.th === id);
      const thread = r.raw(`thread:${id}`);
      if (run && thread?.kind === "thread") {
        const { rev: _run, ...failed } = run;
        const { rev: _thread, ...kept } = thread;
        void _run;
        void _thread;
        r.write([
          {
            ...failed,
            pay: null,
            status: "failed",
            fail: { why: "tokens", at: null, cls: null },
            finishedAt: failed.createdAt,
          } as never,
          { ...kept, running: false },
        ]);
      }
      return outcome;
    };
    clearToast();
    const field = await screen.findByRole("textbox", { name: "Ask or post" });
    fireEvent.change(field, { target: { value: "Sent with tokens left" } });
    fireEvent.click(screen.getByRole("button", { name: /^Ask$/ }));
    await waitUntil(
      t,
      () => screen.queryByText(TOKENS_PAST_TEXT) !== null,
      "the run's failed tokens copy",
    );
    t.truthy(screen.getByText("Sent with tokens left"), "the ask is kept");
    t.is(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Ask or post" }).value, "");
    t.not(currentToast(), OUT_TEXT, "no refusal toast: the write applied");
  },
);
