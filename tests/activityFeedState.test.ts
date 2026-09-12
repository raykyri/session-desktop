import assert from "node:assert/strict";
import test from "node:test";
import { readActivityFeedState, saveActivityFeedState } from "../src/lib/activityFeedState";

const key = "session.research-browser.state.v1";
function storage(initial: string | null = null) {
  const values = new Map<string, string>(initial === null ? [] : [[key, initial]]);
  return {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); },
  };
}

test("the Home feed restores the previous scroll position and ignores the removed note draft", () => {
  const saved = storage(JSON.stringify({
    routes: ["/activity", "/research/tree/node/branch"],
    index: 1,
    values: { activityDraft: "Unfinished note", activityScroll: 1372 },
  }));
  assert.deepEqual(readActivityFeedState(saved), { scrollTop: 1372 });
});

test("saving feed scroll preserves unrelated session values", () => {
  const saved = storage(JSON.stringify({ values: { activityDraft: "Old", "followup:tree:root": "Keep this" } }));
  saveActivityFeedState({ scrollTop: 490 }, saved);
  assert.deepEqual(readActivityFeedState(saved), { scrollTop: 490 });
  const values = JSON.parse(saved.getItem(key)!).values;
  assert.equal(values["followup:tree:root"], "Keep this");
  assert.equal("activityDraft" in values, false);
});

test("malformed or unavailable session storage falls back safely and can be repaired", () => {
  for (const value of ["broken", "null", "[]", '{"values":null}', '{"values":{"activityDraft":42,"activityScroll":"far"}}']) {
    const saved = storage(value);
    assert.deepEqual(readActivityFeedState(saved), { scrollTop: 0 });
    saveActivityFeedState({ scrollTop: 20 }, saved);
    assert.deepEqual(readActivityFeedState(saved), { scrollTop: 20 });
  }
  const unavailable = {
    getItem: () => { throw new Error("storage unavailable"); },
    setItem: () => { throw new Error("storage unavailable"); },
  };
  assert.deepEqual(readActivityFeedState(unavailable), { scrollTop: 0 });
  assert.doesNotThrow(() => saveActivityFeedState({ scrollTop: 12 }, unavailable));
});

test("invalid restored scroll offsets cannot corrupt the feed viewport", () => {
  assert.equal(readActivityFeedState(storage('{"values":{"activityScroll":-20}}')).scrollTop, 0);
  assert.equal(readActivityFeedState(storage('{"values":{"activityScroll":1e999}}')).scrollTop, 0);
});
