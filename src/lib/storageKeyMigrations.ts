// Renamed localStorage keys. Each entry moves a value saved under an earlier
// key name to the current one, once, before the app reads any key.

type KeyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** [old key, current key] pairs, oldest rename first. */
export const RENAMED_STORAGE_KEYS: readonly (readonly [string, string])[] = [
  // Whether the feed page is forward; renamed with the journal → feed rename.
  ["session.journal-open.v1", "session.feed-open.v1"],
];

/** Moves the value at `from` to `to` and removes `from`. A value already
 * stored at `to` is newer than the old key's, so it is kept. Returns whether
 * the old key was removed. */
export function migrateStorageKey(storage: KeyStorage, from: string, to: string): boolean {
  const previous = storage.getItem(from);
  if (previous === null) return false;
  if (storage.getItem(to) === null) storage.setItem(to, previous);
  storage.removeItem(from);
  return true;
}

/** Applies every rename in RENAMED_STORAGE_KEYS. Storage that is unavailable
 * or throws leaves the keys as they are; the app then reads the current keys
 * as unset. */
export function migrateRenamedStorageKeys(storage?: KeyStorage): void {
  try {
    const target = storage ?? globalThis.localStorage;
    if (!target) return;
    for (const [from, to] of RENAMED_STORAGE_KEYS) migrateStorageKey(target, from, to);
  } catch {
    // Storage unavailable: nothing to migrate.
  }
}
