// Out of included tokens with no usable payer (02 §5, 03 K8): every write
// that starts a run (Ask, follow-up, Continue, Branch, Branch here, Look up,
// Run again) is refused before it is sent with the out-of-tokens toast and
// its text stays in the composer, while posts, replies and comments send. A
// write the server refuses because the allowance ran out before it applied
// shows the server's message and keeps the composer's text.

import { OUT_OF_TOKENS_TEXT } from "@session/shared";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import test from "ava";

import { currentToast } from "../src/features/shell/Toast.js";
import { configureReplica } from "../src/replica/ReplicaProvider.js";
import {
  createFixtureReplica,
  fixtureReplicaConfig,
  runControl,
  type FixtureReplica,
} from "../src/replica/fixtureReplica.js";
import { outOfTokens, registryModels, type OnlineData } from "../src/replica/online.js";
import { channelByName } from "../src/replica/queries.js";
import type { WriteOutcome } from "../src/replica/source.js";
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

test("K8: the client's payer rule is the server's over usage.get", (t) => {
  t.false(outOfTokens(online({}), "claude-fable"), "tokens left");
  t.false(outOfTokens(online({ usage: null }), "claude-fable"), "unknown: the server decides");
  t.true(outOfTokens(online({ usage: SPENT }), "claude-fable"), "spent, billing pause");
  t.true(
    outOfTokens(online({ usage: SPENT, billing: "key" }), "claude-fable"),
    "billing key without a key",
  );
  t.false(
    outOfTokens(online({ usage: SPENT, billing: "key", keys: ["anthropic"] }), "claude-fable"),
    "the Anthropic key pays for an Anthropic model",
  );
  t.true(
    outOfTokens(online({ usage: SPENT, billing: "key", keys: ["anthropic"] }), "gemini-flash"),
    "but not for a model it cannot run",
  );
  t.false(
    outOfTokens(online({ usage: SPENT }), "no-such-model"),
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
    const writes = makeWrites(r, { outOfTokens: () => true });
    const model = { model: "claude-fable", effort: "medium" } as const;

    const refused = async (name: string, made_: Promise<unknown>) => {
      t.falsy(await made_, name);
      t.deepEqual(calls, [], `${name}: nothing sent`);
      t.is(currentToast(), OUT_OF_TOKENS_TEXT, name);
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
    await waitUntil(t, () => currentToast() === OUT_OF_TOKENS_TEXT, "the out-of-tokens toast");
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
  "K8: an ask the server refuses out_of_tokens shows the server's message and keeps its text",
  async (t) => {
    await renderApp("/");
    await waitUntil(t, () => document.getElementById(`card-${FIRST}`) !== null, "the feed");
    const message = "Out of tokens, as the server says.";
    replica().mutate = () =>
      Promise.resolve({
        ok: false,
        error: { code: "PRECONDITION_FAILED", reason: "out_of_tokens", message },
      } as WriteOutcome);
    const field = await screen.findByRole("textbox", { name: "Ask or post" });
    fireEvent.change(field, { target: { value: "Sent with tokens left" } });
    fireEvent.click(screen.getByRole("button", { name: /^Ask$/ }));
    await waitUntil(t, () => currentToast() === message, "the server's message");
    t.is(
      screen.getByRole("textbox", { name: "Ask or post" }),
      screen.getByDisplayValue("Sent with tokens left"),
      "the text stays in the composer",
    );
  },
);
