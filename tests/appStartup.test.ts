import assert from "node:assert/strict";
import test from "node:test";
import { startAppStartup } from "../src/lib/appStartup";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

test("startup reveals after initial application without waiting for secondary reads", async () => {
  const secondary = deferred<string>();
  const calls: string[] = [];
  startAppStartup({
    loadInitial: async () => "initial",
    loadSecondary: () => secondary.promise,
    applyInitial: async (value) => {
      calls.push(value);
    },
    applySecondary: (value) => {
      calls.push(value);
    },
    onError: () => assert.fail("unexpected startup error"),
    reveal: async () => {
      calls.push("reveal");
    },
  });
  await settled();
  assert.deepEqual(calls, ["initial", "reveal"]);
  secondary.resolve("secondary");
  await settled();
  assert.deepEqual(calls, ["initial", "reveal", "secondary"]);
});

test("failed initial hydration reports its error and still reveals the window", async () => {
  const calls: unknown[] = [];
  const error = new Error("snapshot failed");
  startAppStartup({
    loadInitial: async () => {
      throw error;
    },
    loadSecondary: async () => assert.fail("secondary must not start"),
    applyInitial: async () => assert.fail("initial must not apply"),
    applySecondary: () => assert.fail("secondary must not apply"),
    onError: (error) => calls.push(error),
    reveal: async () => {
      calls.push("reveal");
    },
  });
  await settled();
  assert.deepEqual(calls, [error, "reveal"]);
});

test("cancelled initial reads cannot hydrate or reveal a later mount", async () => {
  const initial = deferred<string>();
  const cancel = startAppStartup({
    loadInitial: () => initial.promise,
    loadSecondary: async () => assert.fail("secondary must not start"),
    applyInitial: async () => assert.fail("cancelled state must not apply"),
    applySecondary: () => assert.fail("cancelled state must not apply"),
    onError: () => assert.fail("cancelled errors must not apply"),
    reveal: async () => assert.fail("cancelled run must not reveal"),
  });
  cancel();
  initial.resolve("old mount");
  await settled();
});

test("cancellation guards pending selection application and detached secondary errors", async () => {
  const selection = deferred<void>();
  const secondary = deferred<string>();
  let checkedCancellation = false;
  const cancel = startAppStartup({
    loadInitial: async () => "initial",
    loadSecondary: () => secondary.promise,
    applyInitial: async (_, isCancelled) => {
      await selection.promise;
      checkedCancellation = isCancelled();
    },
    applySecondary: () => assert.fail("cancelled secondary must not apply"),
    onError: () => assert.fail("cancelled error must not apply"),
    reveal: async () => assert.fail("cancelled run must not reveal"),
  });
  await settled();
  cancel();
  selection.resolve();
  secondary.reject(new Error("late read failure"));
  await settled();
  assert.equal(checkedCancellation, true);
});
