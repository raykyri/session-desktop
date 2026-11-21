// `01` Y12: `useQuery` re-renders a component once per confirming batch,
// not once per record, and only when what it read changed.

import globalJsdom from "global-jsdom";

globalJsdom(undefined, { url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { MUTATORS } = await import("@session/mutators");
const { act, render } = await import("@testing-library/react");
const { default: test } = await import("ava");
const { LiveQuery, SyncClient, useQuery } = await import("../src/client/index.js");
const { World, cast, ok, post } = await import("./world.js");

test("a component re-renders once per confirming batch, not once per record", async (t) => {
  const { w, open } = cast(t);
  const mona = new SyncClient(w.transport("mona"), {
    user: "mona",
    clock: w.clock,
    random: w.random,
    mutators: MUTATORS,
  });
  await mona.sync(`space:${open}`);
  let renders = 0;
  function Threads() {
    renders++;
    const titles = useQuery(mona, (q) => q.list("thread").map((x) => x.q));
    return (
      <ul>
        {titles.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    );
  }
  const view = render(<Threads />);
  const start = renders;
  // five threads in one batch: one pull, one render
  for (let k = 0; k < 5; k++) post(t, w, "mel", open, `t${k}`);
  await act(async () => {
    await mona.sync(`space:${open}`);
  });
  t.is(renders - start, 1);
  t.is(view.container.querySelectorAll("li").length, 5);
  // a batch that changes nothing it read: no render
  ok(t, w.as("olga", "spaces.update", { id: open, desc: "x" }));
  const before = renders;
  await act(async () => {
    await mona.sync(`space:${open}`);
  });
  t.is(renders, before, "the space record is not a thread");
  view.unmount();
});

test("a live query re-runs only when a key it read changes", async (t) => {
  const w = new World();
  const { open } = cast(t, w);
  const p = post(t, w, "mel", open);
  const q2 = post(t, w, "mel", open);
  const mona = new SyncClient(w.transport("mona"), {
    user: "mona",
    clock: w.clock,
    random: w.random,
    mutators: MUTATORS,
  });
  await mona.sync(`space:${open}`);
  const live = new LiveQuery(mona, (r) => r.get(`counts:${p}`));
  const stop = live.subscribe(() => {});
  const runs = live.runs;
  ok(t, w.as("otto", "research.createPostFollowUp", { id: w.id(), thread: q2, t: "x" }));
  await mona.sync(`space:${open}`);
  t.is(live.runs, runs, "another thread's counts");
  ok(t, w.as("otto", "research.createPostFollowUp", { id: w.id(), thread: p, t: "x" }));
  await mona.sync(`space:${open}`);
  t.is(live.runs, runs + 1);
  t.like(live.current(), { r: 1 });
  stop();
});
