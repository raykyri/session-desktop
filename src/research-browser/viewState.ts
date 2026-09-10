import type { ResearchBrowserSdk } from "./sdk";

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Trailing-debounced `viewState.save`. Scroll handlers fire per frame, and
 * every save round-trips into a parent snapshot, so saving eagerly floods the
 * bridge (and WebKit's history.replaceState rate limit, hit by the SDK's hash
 * sync). One write ~200ms after the last change is all restoration needs. */
export function saveViewStateSoon(
  sdk: ResearchBrowserSdk,
  key: string,
  value: unknown,
  onError?: (error: unknown) => void,
) {
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      if (value === sdk.getSnapshot().viewState[key]) return;
      void sdk.call("viewState.save", key, value).catch((error) => {
        onError?.(error);
      });
    }, 200),
  );
}
