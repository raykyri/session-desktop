// Width queries for the layout's breakpoints, read from script where CSS
// alone cannot change what renders (the composer's menus, the app bar's
// scope menu). The queries are inclusive, as the stylesheets' `max-width`
// rules and the `phone:` and `narrow:` variants (`app.css`).

import { useEffect, useState } from "react";

/** The phone breakpoint: 520 px and below. */
export const PHONE_QUERY = "(max-width: 520px)";

/** Whether `query` matches, kept current as the window resizes. `matchMedia`
 * is optional because jsdom does not implement it; without it the answer is
 * false. */
export function useMediaQuery(query: string): boolean {
  const get = () => typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const on = () => setMatches(list.matches);
    on();
    list.addEventListener("change", on);
    return () => list.removeEventListener("change", on);
  }, [query]);
  return matches;
}
