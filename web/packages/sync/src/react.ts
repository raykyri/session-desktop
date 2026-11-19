// `useQuery`: a client query in a React or React Native component, over
// `useSyncExternalStore`, so a render reads a stable value and a change of
// the result renders again.

import { useSyncExternalStore } from "react";

import type { Query } from "./client/query.js";

export function useQuery<T>(q: Query<T>): T {
  return useSyncExternalStore(
    (l) => q.subscribe(l),
    () => q.get(),
    () => q.get(),
  );
}
