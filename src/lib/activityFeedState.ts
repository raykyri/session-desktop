export interface ActivityFeedState {
  draft: string;
  scrollTop: number;
}

// Keep the existing session key so replacing the iframe does not discard the
// note the user was writing or their position in the activity feed.
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
    return {
      draft: typeof values.activityDraft === "string" ? values.activityDraft : "",
      scrollTop: typeof values.activityScroll === "number" && Number.isFinite(values.activityScroll)
        ? Math.max(0, values.activityScroll)
        : 0,
    };
  } catch {
    return { draft: "", scrollTop: 0 };
  }
}

export function saveActivityFeedState(state: ActivityFeedState, storage?: FeedStorage) {
  try {
    const target = storage ?? globalThis.sessionStorage;
    if (!target) return;
    const snapshot = readSnapshot(target);
    target.setItem(ACTIVITY_FEED_STATE_KEY, JSON.stringify({
      ...snapshot,
      values: {
        ...record(snapshot.values),
        activityDraft: state.draft,
        activityScroll: state.scrollTop,
      },
    }));
  } catch {
    // The App-owned ref still preserves state across navigation when WebKit
    // denies storage or the session storage quota has been reached.
  }
}
