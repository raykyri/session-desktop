/** Row-based scroll anchor for the virtualized Home activity feed. */
export interface ActivityFeedScrollAnchor {
  key: string;
  offset: number;
}

export interface ActivityFeedState {
  scroll: ActivityFeedScrollAnchor | null;
}

// Keep the existing session key so the Home feed preserves its scroll position.
const ACTIVITY_FEED_STATE_KEY = "session.research-browser.state.v1";
type FeedStorage = Pick<Storage, "getItem" | "setItem">;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readSnapshot(storage: Pick<Storage, "getItem"> | undefined) {
  try {
    return record(JSON.parse(storage?.getItem(ACTIVITY_FEED_STATE_KEY) ?? "null"));
  } catch {
    return {};
  }
}

export function readActivityFeedState(storage?: Pick<Storage, "getItem">): ActivityFeedState {
  try {
    const values = record(readSnapshot(storage ?? globalThis.sessionStorage).values);
    // Ignore legacy numeric scroll offsets.
    const anchor = record(values.activityScroll);
    return {
      scroll:
        typeof anchor.key === "string" &&
        anchor.key !== "" &&
        typeof anchor.offset === "number" &&
        Number.isFinite(anchor.offset)
          ? { key: anchor.key, offset: anchor.offset }
          : null,
    };
  } catch {
    return { scroll: null };
  }
}

export function saveActivityFeedState(state: ActivityFeedState, storage?: FeedStorage) {
  try {
    const target = storage ?? globalThis.sessionStorage;
    if (!target) return;
    const snapshot = readSnapshot(target);
    const { activityDraft: _removedDraft, ...retainedValues } = record(snapshot.values);
    target.setItem(ACTIVITY_FEED_STATE_KEY, JSON.stringify({
      ...snapshot,
      values: {
        ...retainedValues,
        activityScroll: state.scroll,
      },
    }));
  } catch {
    // The App-owned ref still preserves state across navigation when WebKit
    // denies storage or the session storage quota has been reached.
  }
}
