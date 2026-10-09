import assert from "node:assert/strict";
import test from "node:test";
import { createResearchToastTimer } from "../src/hooks/useResearchToast";

function harness(t: test.TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const expired: number[] = [];
  const timer = createResearchToastTimer(
    (id) => expired.push(id),
    () => now,
  );
  const advance = (ms: number) => {
    now += ms;
    t.mock.timers.tick(ms);
  };
  return { timer, expired, advance };
}

test("a toast expires after its time", (t) => {
  const { timer, expired, advance } = harness(t);
  timer.start(1, 3500);
  advance(3499);
  assert.deepEqual(expired, []);
  advance(1);
  assert.deepEqual(expired, [1]);
});

test("pause and resume preserve the toast's remaining duration", (t) => {
  const { timer, expired, advance } = harness(t);
  timer.start(1, 6000);
  advance(2000);
  timer.pause();
  advance(60_000);
  assert.deepEqual(expired, [], "a paused toast stays");
  timer.resume();
  advance(3999);
  assert.deepEqual(expired, []);
  advance(1);
  assert.deepEqual(expired, [1]);
});

test("a resumed toast remains visible for at least 1500ms", (t) => {
  const { timer, expired, advance } = harness(t);
  timer.start(1, 3500);
  advance(3400);
  timer.pause();
  timer.resume();
  advance(1499);
  assert.deepEqual(expired, []);
  advance(1);
  assert.deepEqual(expired, [1]);
});

test("pause and resume repeat; extra calls do nothing", (t) => {
  const { timer, expired, advance } = harness(t);
  timer.start(1, 6000);
  advance(1000);
  timer.pause();
  timer.pause();
  advance(500);
  timer.resume();
  timer.resume();
  advance(2000);
  timer.pause();
  advance(10_000);
  timer.resume();
  advance(2999);
  assert.deepEqual(expired, []);
  advance(1);
  assert.deepEqual(expired, [1]);
});

test("a new toast replaces the running one, and stop cancels it", (t) => {
  const { timer, expired, advance } = harness(t);
  timer.start(1, 3500);
  advance(1000);
  timer.start(2, 3500);
  advance(3500);
  assert.deepEqual(expired, [2], "only the replacing toast expires");
  timer.start(3, 3500);
  timer.stop();
  timer.resume();
  advance(10_000);
  assert.deepEqual(expired, [2]);
});
