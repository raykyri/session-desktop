import test from "ava";

import { useOverlaysStore } from "../src/stores/overlays.js";

// The store is a priority stack; which band a given layer sits in is
// `OVERLAY_PRIORITY`'s business, so these use bare numbers.
const HIGH = 400;
const MID = 200;
const LOW = 100;

test.beforeEach(() => useOverlaysStore.getState().clear());

test.serial("nothing registered means Escape is not handled here", (t) => {
  t.false(useOverlaysStore.getState().dismissTop());
  t.is(useOverlaysStore.getState().top(), null);
});

test.serial("the highest priority wins regardless of registration order", (t) => {
  const dismissed: string[] = [];
  const { register, dismissTop } = useOverlaysStore.getState();

  register("selection", LOW, () => dismissed.push("selection"));
  register("lightbox", HIGH, () => dismissed.push("lightbox"));
  register("search", MID, () => dismissed.push("search"));

  t.is(useOverlaysStore.getState().top()?.id, "lightbox");
  t.true(dismissTop());
  t.deepEqual(dismissed, ["lightbox"]);
});

test.serial("equal priorities dismiss in reverse registration order", (t) => {
  const dismissed: string[] = [];
  const store = useOverlaysStore.getState();

  store.register("first", HIGH, () => dismissed.push("first"));
  store.register("second", HIGH, () => dismissed.push("second"));

  t.is(useOverlaysStore.getState().top()?.id, "second");

  useOverlaysStore.getState().dismissTop();
  useOverlaysStore.getState().unregister("second");
  useOverlaysStore.getState().dismissTop();

  t.deepEqual(dismissed, ["second", "first"]);
});

test.serial("re-registering an id swaps the callback without moving it up the stack", (t) => {
  const dismissed: string[] = [];
  const store = useOverlaysStore.getState();

  store.register("search", MID, () => dismissed.push("stale"));
  store.register("selection", MID, () => dismissed.push("selection"));
  // A re-render of the search bar with a fresh closure.
  store.register("search", MID, () => dismissed.push("fresh"));

  t.is(useOverlaysStore.getState().entries.length, 2);
  t.is(useOverlaysStore.getState().top()?.id, "selection");

  useOverlaysStore.getState().unregister("selection");
  useOverlaysStore.getState().dismissTop();
  t.deepEqual(dismissed, ["fresh"]);
});

test.serial("unregistering removes the layer from the stack", (t) => {
  const store = useOverlaysStore.getState();
  store.register("lightbox", HIGH, () => {});
  store.register("search", MID, () => {});

  useOverlaysStore.getState().unregister("lightbox");
  t.is(useOverlaysStore.getState().top()?.id, "search");

  useOverlaysStore.getState().unregister("search");
  t.is(useOverlaysStore.getState().top(), null);
});
