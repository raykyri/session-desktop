// A ref that holds the latest value of `value` after each commit, for
// callbacks that run outside render (event handlers, timers, effects) and
// must read the current state without being recreated when it changes.

import { useLayoutEffect, useRef } from "react";

export function useLatest<T>(value: T): { current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
