// A run's states on a thread card (02 §3.3, W3.3) on the fixture replica:
// each status, both stop notes of a completed run, Stop and Run again only
// for the asker, an interrupted run keeping its partial text with Run
// again; and an ask refused for a full queue keeping its text in the
// composer (03 L1).

import type { RunRec } from "@session/mutators";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import test, { type ExecutionContext } from "ava";
import { useRef, useState } from "react";

import { ModelPicker } from "../src/features/composer/NewThreadComposer.js";
import { currentToast } from "../src/features/shell/Toast.js";
import { configureReplica } from "../src/replica/ReplicaProvider.js";
import {
  fixtureReplicaConfig,
  runControl,
  type FixtureReplica,
} from "../src/replica/fixtureReplica.js";
import type { Effort, ModelOption } from "../src/replica/online.js";
import type { WriteOutcome } from "../src/replica/source.js";
import { QUEUE_FULL_MESSAGE } from "../src/replica/writes.js";
import { useDraftsStore } from "../src/stores/drafts.js";

import { renderApp, renderInRouter, waitUntil } from "./helpers.js";

/** @ines.v's ask in #public; the fixture member reads as @ines.v. */
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
const firstCard = () => document.getElementById(`card-${FIRST}`);
const rootRun = () => {
  const run = replica()
    .rawAll("run")
    .find((r) => r.th === FIRST && r.node === "r");
  if (!run) throw new Error("no root run");
  return run;
};

/** The root's run as `change` makes it, without its answer unless it is
 * complete; with one committed turn of partial text. */
function setRun(change: Partial<RunRec>, partial: string | null = null) {
  const run = { ...rootRun(), ...change };
  const { rev: _rev, ...draft } = run;
  void _rev;
  const thread = replica().raw(`thread:${FIRST}`);
  const records = [draft as never];
  if (thread?.kind === "thread") {
    const { rev: _r, ...t } = thread;
    void _r;
    records.push({ ...t, running: run.status === "queued" || run.status === "running" } as never);
  }
  if (partial !== null)
    records.push({
      kind: "turn",
      run: run.id,
      attempt: run.attempt,
      n: 0,
      th: FIRST,
      s: run.s,
      role: "assistant",
      blocks: [{ type: "text", text: partial }],
      createdAt: run.createdAt,
    } as never);
  replica().write(records, run.status === "complete" ? [] : [`answer:${FIRST}`]);
}

async function open(t: ExecutionContext) {
  await renderApp("/");
  await waitUntil(t, () => firstCard() !== null, "the first thread renders");
  return () => within(firstCard() as HTMLElement);
}

test.serial("queued: Queued and Stop for the asker; Stop cancels the run", async (t) => {
  const card = await open(t);
  // the fixture's executor starts a queued run unless held there
  runControl.hold = "queued";
  setRun({ status: "queued", step: 0 });
  await waitUntil(t, () => card().queryByText("Queued") !== null, "Queued");
  const calls: [string, unknown][] = [];
  const mutate = replica().mutate.bind(replica());
  replica().mutate = (name, input) => {
    calls.push([name, input]);
    return mutate(name, input);
  };
  fireEvent.click(card().getByRole("button", { name: "Stop" }));
  t.deepEqual(calls, [["research.cancelNode", { thread: FIRST, node: "r" }]]);
});

test.serial("running: the step and the text written so far", async (t) => {
  const card = await open(t);
  setRun({ status: "running", step: 1 }, "Consistent hashing places keys on a ring.");
  await waitUntil(
    t,
    () => card().queryByText("Researching · Step 2 of 4") !== null,
    "the step line",
  );
  t.truthy(card().getByText("Consistent hashing places keys on a ring."));
  t.truthy(card().getByRole("button", { name: "Stop" }));
  t.is(card().queryByRole("button", { name: "Run again" }), null);
});

test.serial("complete: the answer, then each stop note", async (t) => {
  const card = await open(t);
  for (const note of [
    "Stopped: reached token limit for a single run.",
    "Stopped: out of tokens.",
  ]) {
    setRun({ status: "complete", step: 3, note });
    await waitUntil(t, () => card().queryByText(note) !== null, note);
    t.is(card().queryByRole("button", { name: "Run again" }), null);
  }
  setRun({ status: "complete", step: 3, note: null });
  await waitUntil(t, () => firstCard()?.querySelector(".runnote") === null, "no note");
});

test.serial("failed: the reason for each fail.why, and Run again", async (t) => {
  const card = await open(t);
  const reasons: [RunRec["fail"], string][] = [
    [
      { why: "tokens", at: null, cls: null },
      // the fixture member has tokens left now (`FIXTURE_USAGE`)
      "This ask did not run: included tokens had run out. Run again to start it.",
    ],
    [
      { why: "key", at: null, cls: null },
      "The API key for this run was rejected or removed. Check your keys in Usage.",
    ],
    [
      { why: "rate", at: 0, cls: null },
      "The model provider is rate limiting this deployment. Try again in a minute.",
    ],
    [
      { why: "access", at: null, cls: null },
      "You can no longer read this channel, so the ask did not run.",
    ],
    [{ why: "error", at: null, cls: "timeout" }, "Stopped: exceeded maximum duration."],
  ];
  for (const [fail, text] of reasons) {
    setRun({ status: "failed", fail });
    await waitUntil(t, () => card().queryByText(text) !== null, text);
    t.truthy(card().getByRole("button", { name: "Run again" }));
  }
});

test.serial(
  "cancelled and interrupted keep the partial text; Run again starts a new attempt",
  async (t) => {
    const card = await open(t);
    setRun({ status: "cancelled", fail: { why: "stopped", at: null, cls: null } }, "A partial.");
    await waitUntil(t, () => card().queryByText("Stopped") !== null, "Stopped");
    t.truthy(card().getByText("A partial."));
    setRun(
      { status: "interrupted", fail: { why: "interrupted", at: null, cls: null } },
      "Partial text that stays.",
    );
    await waitUntil(t, () => card().queryByText("Interrupted") !== null, "Interrupted");
    t.truthy(card().getByText("Partial text that stays."));
    const calls: [string, unknown][] = [];
    const mutate = replica().mutate.bind(replica());
    replica().mutate = (name, input) => {
      calls.push([name, input]);
      return mutate(name, input);
    };
    const attempt = rootRun().attempt;
    fireEvent.click(card().getByRole("button", { name: "Run again" }));
    t.is(calls[0]?.[0], "research.retryNode");
    t.like(calls[0]?.[1], { thread: FIRST, node: "r", base: { attempt } });
  },
);

test.serial("Stop and Run again are the asker's only", async (t) => {
  const card = await open(t);
  setRun({ status: "running", step: 0, u: "jun.park" });
  await waitUntil(t, () => card().queryByText("Researching · Step 1 of 4") !== null, "running");
  t.is(card().queryByRole("button", { name: "Stop" }), null);
  setRun({
    status: "interrupted",
    fail: { why: "interrupted", at: null, cls: null },
    u: "jun.park",
  });
  await waitUntil(t, () => card().queryByText("Interrupted") !== null, "Interrupted");
  t.is(card().queryByRole("button", { name: "Run again" }), null);
});

test.serial("L1: an ask refused for a full queue keeps its text in the composer", async (t) => {
  await renderApp("/");
  await waitUntil(t, () => firstCard() !== null, "the feed renders");
  replica().mutate = () =>
    Promise.resolve({
      ok: false,
      error: {
        code: "PRECONDITION_FAILED",
        reason: "queue_full",
        message: "You have 20 asks waiting to run.",
      },
    } as WriteOutcome);
  const field = await screen.findByRole("textbox", { name: "Ask or post" });
  fireEvent.change(field, { target: { value: "one ask too many" } });
  fireEvent.click(screen.getByRole("button", { name: /^Ask$/ }));
  await waitUntil(t, () => currentToast() === QUEUE_FULL_MESSAGE, "the queue toast");
  t.is(
    screen.getByRole("textbox", { name: "Ask or post" }),
    screen.getByDisplayValue("one ask too many"),
    "the text stays in the composer",
  );
});

const FABLE: ModelOption = {
  id: "claude-fable",
  label: "Claude Fable 5.1",
  short: "Fable",
  efforts: ["low", "medium", "high", "xhigh", "max"],
  payers: ["included", "key:anthropic"],
  provider: "anthropic",
};
const FLASH: ModelOption = {
  id: "gemini-flash",
  label: "Gemini 3.8 Flash",
  short: "Flash",
  efforts: ["low", "medium", "high"],
  payers: ["included"],
  provider: "vertex",
};

function Picker({ start }: { start: { model: ModelOption; effort: Effort } }) {
  const [choice, setChoice] = useState(start);
  const field = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <ModelPicker
        models={[FABLE, FLASH]}
        model={choice.model}
        effort={choice.effort}
        field={field}
        onChange={({ model, effort }) =>
          setChoice({ model: model === FABLE.id ? FABLE : FLASH, effort })
        }
      />
      <span data-testid="choice">{`${choice.model.id} ${choice.effort}`}</span>
      <textarea ref={field} aria-label="field" />
    </>
  );
}

/** Opens the picker and its Effort submenu; the efforts it lists. */
async function effortMenu(t: ExecutionContext): Promise<string[]> {
  fireEvent.click(screen.getByTitle("Model and effort"));
  await screen.findAllByRole("menuitemradio");
  fireEvent.keyDown(screen.getByRole("menuitem", { name: /Effort/ }), { key: "ArrowRight" });
  await waitUntil(t, () => screen.queryAllByRole("menuitemradio").length > 2, "the submenu opens");
  return screen
    .getAllByRole("menuitemradio")
    .map((e) => e.textContent?.trim() ?? "")
    .filter((label) => label !== FABLE.label && label !== FLASH.label);
}

test.serial(
  "K12: the Effort submenu lists the chosen model's efforts, with no Default item; switching from max on Fable to Flash selects high",
  async (t) => {
    await renderInRouter(<Picker start={{ model: FABLE, effort: "max" }} />);
    const fable = await effortMenu(t);
    t.is(fable.length, 5);
    t.false(fable.some((e) => /default/i.test(e)));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Gemini 3.8 Flash/ }));
    await waitUntil(
      t,
      () => screen.getByTestId("choice").textContent === "gemini-flash high",
      "high",
    );
  },
);

test.serial(
  "K12: a model that accepts the current effort keeps it; its submenu lists its own efforts",
  async (t) => {
    await renderInRouter(<Picker start={{ model: FLASH, effort: "medium" }} />);
    t.is((await effortMenu(t)).length, 3);
    cleanup();
    await renderInRouter(<Picker start={{ model: FLASH, effort: "medium" }} />);
    fireEvent.click(screen.getByTitle("Model and effort"));
    await screen.findAllByRole("menuitemradio");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Claude Fable 5.1/ }));
    await waitUntil(
      t,
      () => screen.getByTestId("choice").textContent === "claude-fable medium",
      "medium kept",
    );
  },
);
