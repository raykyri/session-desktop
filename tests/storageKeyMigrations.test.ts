import assert from "node:assert/strict";
import test from "node:test";
import {
  RENAMED_STORAGE_KEYS,
  migrateRenamedStorageKeys,
  migrateStorageKey,
} from "../src/lib/storageKeyMigrations";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

test("the saved feed-open flag moves from the journal key to the feed key", () => {
  const storage = memoryStorage({ "session.journal-open.v1": "true", other: "kept" });
  migrateRenamedStorageKeys(storage);
  assert.deepEqual(Object.fromEntries(storage.values), {
    "session.feed-open.v1": "true",
    other: "kept",
  });
});

test("a value already under the new key wins and the old key is removed", () => {
  const storage = memoryStorage({ "old.key": "old", "new.key": "new" });
  assert.equal(migrateStorageKey(storage, "old.key", "new.key"), true);
  assert.deepEqual(Object.fromEntries(storage.values), { "new.key": "new" });
});

test("migration without an old key changes nothing and can run again", () => {
  const storage = memoryStorage({ "session.feed-open.v1": "false" });
  migrateRenamedStorageKeys(storage);
  migrateRenamedStorageKeys(storage);
  assert.deepEqual(Object.fromEntries(storage.values), { "session.feed-open.v1": "false" });
  assert.equal(migrateStorageKey(storage, "missing", "session.feed-open.v1"), false);
});

test("throwing storage leaves the app to read the keys as unset", () => {
  const throwing = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  assert.doesNotThrow(() => migrateRenamedStorageKeys(throwing));
});

test("no rename targets another rename's source", () => {
  const sources = new Set(RENAMED_STORAGE_KEYS.map(([from]) => from));
  for (const [, to] of RENAMED_STORAGE_KEYS) {
    assert.equal(sources.has(to), false);
  }
});
