// Per-key merging of state that several tabs of the app keep in one
// localStorage key (thread page state, feed scroll anchors). Each tab holds
// the whole record in memory and writes it whole, so a plain write would
// replace what another tab wrote for keys this tab never touched. Before a
// write, and when another tab's write arrives (`storage` event), the record
// is merged key by key: the entry written last wins.

export interface Stamped {
  updatedAt?: number | undefined;
}

/** `ours` and `stored` merged key by key, the newer entry winning (ours on a
 * tie or when an entry has no time). A key this tab removed at time `t`
 * (`removed`) stays removed unless the stored entry was written after `t`. */
export function mergeByUpdatedAt<T extends Stamped>(
  ours: Readonly<Record<string, T>>,
  stored: Readonly<Record<string, T>>,
  removed: ReadonlyMap<string, number> = new Map(),
): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, entry] of Object.entries(stored)) {
    const removedAt = removed.get(key);
    if (removedAt !== undefined && (entry.updatedAt ?? 0) <= removedAt) continue;
    result[key] = entry;
  }
  for (const [key, entry] of Object.entries(ours)) {
    const other = result[key];
    if (!other || (entry.updatedAt ?? 0) >= (other.updatedAt ?? 0)) result[key] = entry;
  }
  return result;
}

/** Calls `onChange` with the new value when another tab writes `key`. */
export function onOtherTabWrite(key: string, onChange: (value: string | null) => void): void {
  if (typeof window === "undefined") return;
  window.addEventListener("storage", (event) => {
    if (event.key === key) onChange(event.newValue);
  });
}
