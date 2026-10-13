import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { attachMarkdownDashGuard } from "../lib/markdownDashes";

/** Keeps lines of hyphens in a Markdown textarea from becoming em dashes
 * through macOS smart dashes (`attachMarkdownDashGuard`). Checks after every
 * render whether `ref` points at another element, so a field that is
 * replaced or rendered conditionally is still covered. */
export function useMarkdownDashGuard(ref: RefObject<HTMLTextAreaElement | null>) {
  const attached = useRef<{ element: HTMLTextAreaElement; detach: () => void } | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (attached.current?.element === element) return;
    attached.current?.detach();
    attached.current = element ? { element, detach: attachMarkdownDashGuard(element) } : null;
  });
  useEffect(
    () => () => {
      attached.current?.detach();
      attached.current = null;
    },
    [],
  );
}
