import assert from "node:assert/strict";
import test from "node:test";
import { readActivityFeedState, saveActivityFeedState } from "../src/lib/activityFeedState";

const key = "qmux.research-browser.state.v1";
function storage(initial: string | null = null) {
  const values = new Map<string, string>(initial === null ? [] : [[key, initial]]);
  return {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); },
  };
}

test("the regular feed restores the previous browser's draft and scroll position", () => {
  const saved = storage(JSON.stringify({
    routes: ["/activity", "/research/tree/node/branch"],
    index: 1,
    values: { activityDraft: "Unfinished note", activityScroll: 1372 },
  }));
  assert.deepEqual(readActivityFeedState(saved), { draft: "Unfinished note", scrollTop: 1372 });
});

test("saving and clearing a feed draft does not resurrect it or discard other session values", () => {
  const saved = storage(JSON.stringify({ values: { activityDraft: "Old", "followup:tree:root": "Keep this" } }));
  saveActivityFeedState({ draft: "Changed", scrollTop: 490 }, saved);
  assert.deepEqual(readActivityFeedState(saved), { draft: "Changed", scrollTop: 490 });
  saveActivityFeedState({ draft: "", scrollTop: 0 }, saved);
  assert.deepEqual(readActivityFeedState(saved), { draft: "", scrollTop: 0 });
  assert.equal(JSON.parse(saved.getItem(key)!).values["followup:tree:root"], "Keep this");
});

test("malformed or unavailable session storage falls back safely and can be repaired", () => {
  for (const value of ["broken", "null", "[]", '{"values":null}', '{"values":{"activityDraft":42,"activityScroll":"far"}}']) {
    const saved = storage(value);
    assert.deepEqual(readActivityFeedState(saved), { draft: "", scrollTop: 0 });
    saveActivityFeedState({ draft: "Recovered", scrollTop: 20 }, saved);
    assert.deepEqual(readActivityFeedState(saved), { draft: "Recovered", scrollTop: 20 });
  }
  const unavailable = {
    getItem: () => { throw new Error("storage unavailable"); },
    setItem: () => { throw new Error("storage unavailable"); },
  };
  assert.deepEqual(readActivityFeedState(unavailable), { draft: "", scrollTop: 0 });
  assert.doesNotThrow(() => saveActivityFeedState({ draft: "In memory", scrollTop: 12 }, unavailable));
});

test("invalid restored scroll offsets cannot corrupt the feed viewport", () => {
  assert.equal(readActivityFeedState(storage('{"values":{"activityScroll":-20}}')).scrollTop, 0);
  assert.equal(readActivityFeedState(storage('{"values":{"activityScroll":1e999}}')).scrollTop, 0);
});
