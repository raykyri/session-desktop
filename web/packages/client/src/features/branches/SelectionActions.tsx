// Look up and Branch here over a selection in a thread card's answer
// (02 §4.4; the mock's `#sellook`, `#selbranch`): a selection of 3 or more
// characters inside the finished answer, for a writer, shows Branch here,
// and Look up above it when the selection is 1-4 whole words. They sit 8 px
// below the selection, of equal width, right-aligned to a one-line
// selection and left-aligned otherwise, kept 8 px inside the viewport, and
// go on scroll. Keyboard selections count (`selectionchange`, 120 ms).
// Escape removes them and keeps the selection (02 §10.2).

import type { RefObject } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { OVERLAY_PRIORITY, useOverlaysStore } from "../../stores/overlays.js";
import { ReplyArrowIcon, SearchIcon } from "../feed/icons.js";

import { lookPhrase, rangeEdges } from "./lookPhrase.js";

export interface SelectionChoice {
  text: string;
  /** The passage the selection starts in. */
  b: number | null;
}

interface Shown extends SelectionChoice {
  look: string | null;
  x: number;
  y: number;
  multiline: boolean;
  left: number;
  right: number;
  /** The card's corner, which the actions are placed against. */
  origin: { left: number; top: number };
}

/** The selection's text without citation numbers and count buttons. */
function selectedText(range: Range): string {
  const fragment = range.cloneContents();
  fragment.querySelectorAll(".anc, .cite").forEach((x) => x.remove());
  return (fragment.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function SelectionActions({
  proseRef,
  enabled,
  onLookUp,
  onBranch,
}: {
  proseRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  onLookUp: (choice: SelectionChoice & { look: string }) => void;
  onBranch: (choice: SelectionChoice) => void;
}) {
  const [shown, setShown] = useState<Shown | null>(null);
  const buttons = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (keyboard: boolean) => {
      const prose = proseRef.current;
      const selection = document.getSelection();
      // Focus moving elsewhere (a field, a menu) moves the selection there;
      // the actions stay until a pointer, a scroll or Escape removes them. A
      // selection change inside an answer (a keyboard deselect, or a
      // selection in another answer) removes them.
      const hide = () => {
        if (keyboard) {
          const node = selection?.anchorNode;
          const at = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
          if (!at?.closest(".answer")) return;
        }
        setShown(null);
      };
      if (!prose || !selection || selection.rangeCount === 0 || selection.isCollapsed)
        return hide();
      const raw = selection.toString().replace(/\s+/g, " ").trim();
      if (raw.length < 3) return hide();
      if (!selection.anchorNode || !selection.focusNode) return hide();
      if (!prose.contains(selection.anchorNode) || !prose.contains(selection.focusNode))
        return hide();
      const range = selection.getRangeAt(0);
      const text = selectedText(range) || raw;
      const rect = range.getBoundingClientRect();
      const card = prose.closest<HTMLElement>(".tcard")?.getBoundingClientRect();
      const lines = new Set(
        Array.from(range.getClientRects())
          .filter((r) => r.width > 1)
          .map((r) => Math.round(r.top / 4)),
      );
      const start =
        range.startContainer.nodeType === 1
          ? (range.startContainer as Element)
          : range.startContainer.parentElement;
      const unit = start?.closest("[data-passage]");
      const b = unit ? Number(unit.getAttribute("data-passage")) : null;
      setShown({
        text,
        b: Number.isFinite(b) ? b : null,
        look: lookPhrase(text, rangeEdges(range)),
        x: 0,
        y: rect.bottom + 8,
        multiline: lines.size > 1,
        left: rect.left,
        right: rect.right,
        origin: { left: card?.left ?? 0, top: card?.top ?? 0 },
      });
    };
    const onUp = () => setTimeout(() => read(false));
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => read(true), 120);
    };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("selectionchange", onChange);
    // The feed's scroll removes them (the mock's scroll handler on `#k-mg`).
    // A focus change fires a scroll event without moving; that one does not.
    const scroller: HTMLElement | Window =
      proseRef.current?.closest<HTMLElement>("[data-shell-scroll]") ?? window;
    const top = () => ("scrollTop" in scroller ? scroller.scrollTop : scroller.scrollY);
    let last = top();
    const onScroll = () => {
      const now = top();
      if (Math.abs(now - last) > 1) setShown(null);
      last = now;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("selectionchange", onChange);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [enabled, proseRef]);

  // Escape removes the actions and keeps the selection.
  const register = useOverlaysStore((state) => state.register);
  const unregister = useOverlaysStore((state) => state.unregister);
  const id = `selection:${useId()}`;
  useEffect(() => {
    if (!shown) return;
    register(id, OVERLAY_PRIORITY.selection, () => setShown(null));
    return () => unregister(id);
  }, [shown, id, register, unregister]);

  useLayoutEffect(() => {
    if (!buttons.current) return;
    const w = Math.max(
      ...Array.from(buttons.current.children, (el) => (el as HTMLElement).offsetWidth),
    );
    if (w !== width) setWidth(w);
  }, [shown, width]);

  if (!shown || !enabled) return null;
  // Positioned against the card that holds the answer (the actions follow
  // the answer in the DOM, so Tab from the answer reaches them).
  const origin = shown.origin;
  const w = width || 110;
  const x0 = shown.multiline ? shown.left : shown.right - w;
  const x = Math.max(8, Math.min(x0, window.innerWidth - w - 8));
  const style = (row: number) => ({
    top: shown.y + row * 34 - origin.top,
    left: x - origin.left,
    minWidth: width || undefined,
  });
  return (
    <div
      ref={buttons}
      className="selwrap"
      data-selection-actions=""
      role="group"
      aria-label="Selection"
    >
      {shown.look !== null ? (
        <button
          type="button"
          className="selact"
          style={style(0)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const look = shown.look;
            setShown(null);
            document.getSelection()?.removeAllRanges();
            if (look !== null) onLookUp({ text: shown.text, b: shown.b, look });
          }}
        >
          <SearchIcon />
          Look up
        </button>
      ) : null}
      <button
        type="button"
        className="selact"
        style={style(shown.look !== null ? 1 : 0)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setShown(null);
          document.getSelection()?.removeAllRanges();
          onBranch({ text: shown.text, b: shown.b });
        }}
      >
        <ReplyArrowIcon />
        Branch here
      </button>
    </div>
  );
}
