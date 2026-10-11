import { useRef } from "react";

/** Keeps the previous identity of a derived value while an equality check
 * says nothing changed. Chain ids are recomputed on every research event
 * (4×/s while any run streams); without this, each recomputation's fresh
 * identity would rerun every effect that depends on them. */
export function useStableValue<T>(next: T, isEqual: (previous: T, candidate: T) => boolean): T {
  const ref = useRef(next);
  if (ref.current !== next && !isEqual(ref.current, next)) {
    ref.current = next;
  }
  return ref.current;
}
