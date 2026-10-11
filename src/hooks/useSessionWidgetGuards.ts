import { useEffect, useRef, type RefObject } from "react";
import { registerShortcutFallbackFrame } from "../lib/iframeShortcutFallback";
import {
  sessionWidgetFrameMessage,
  SESSION_WIDGET_PING_INTERVAL_MS,
  sessionWidgetPingTick,
  sessionWidgetRecordFocusTake,
  sessionWidgetTookFocus,
} from "../lib/sessionWidgets";

/** The same containment runs in answer frames and expanded widget previews. */
export function useSessionWidgetGuards({
  frameRef, frameUrl, generation, pageLoaded, running,
  programmaticFocusUntilRef, onNavigate, onStop, onHeight,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  frameUrl: string | null;
  generation: number;
  pageLoaded: boolean;
  running: boolean;
  programmaticFocusUntilRef: RefObject<number>;
  onNavigate: () => void;
  onStop: () => void;
  onHeight?: (height: number) => void;
}) {
  const callbacks = useRef({ onNavigate, onStop, onHeight });
  callbacks.current = { onNavigate, onStop, onHeight };
  const unansweredPingsRef = useRef(0);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = sessionWidgetFrameMessage(event, frameRef.current?.contentWindow);
      if (message?.type === "height") {
        callbacks.current.onHeight?.(message.height);
      } else if (message?.type === "pong") {
        unansweredPingsRef.current = 0;
      } else if (message?.type === "unload") {
        // The page guard detected that its document unloaded during navigation.
        // The new response may never complete or fire a load event.
        callbacks.current.onNavigate();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Once the widget page has loaded, ping it every second. A
  // document that replaced it (a navigation the page could not cancel, even
  // one whose response never completes and so never fires load) does not
  // answer, and the frame is removed.
  useEffect(() => {
    if (!pageLoaded) {
      return;
    }
    unansweredPingsRef.current = 0;
    let id = 0;
    const timer = window.setInterval(() => {
      const tick = sessionWidgetPingTick(unansweredPingsRef.current);
      unansweredPingsRef.current = tick.unanswered;
      if (tick.gone) {
        callbacks.current.onNavigate();
        return;
      }
      id += 1;
      frameRef.current?.contentWindow?.postMessage({ type: "session-widget-ping", id }, "*");
    }, SESSION_WIDGET_PING_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [pageLoaded, frameUrl, generation]);

  // While the frame has focus, the native layer handles app shortcuts (the same
  // fallback the browser overlay uses), since keys go to the framed document.
  useEffect(() => {
    const element = frameRef.current;
    return element && frameUrl ? registerShortcutFallbackFrame(element) : undefined;
  }, [frameUrl, generation]);

  // A running widget can call focus() on itself and take keyboard focus from
  // another app control. Focus that enters the frame
  // without a pointer or keyboard action returns to the previously focused
  // element. If a widget repeatedly takes focus, its scripts are stopped (it returns
  // to its static page with a notice), since it would otherwise capture the
  // user's typing and prevent app shortcuts.
  useEffect(() => {
    if (!running || !frameUrl) {
      return;
    }
    let lastAppInteraction = Number.NEGATIVE_INFINITY;
    let previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let takes: number[] = [];
    let pending: number | null = null;
    const onInteraction = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key === "Tab") {
        return;
      }
      lastAppInteraction = performance.now();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target !== frameRef.current) {
        previous = event.target;
      }
    };
    const check = () => {
      pending = null;
      const element = frameRef.current;
      if (!element || document.activeElement !== element) {
        return;
      }
      const now = performance.now();
      const took = sessionWidgetTookFocus({
        now,
        programmaticUntil: programmaticFocusUntilRef.current,
        lastAppInteraction,
        pointerOverFrame: element.matches(":hover"),
      });
      if (!took) {
        return;
      }
      previous?.focus({ preventScroll: true });
      const record = sessionWidgetRecordFocusTake(takes, now);
      takes = record.takes;
      if (record.stop) {
        callbacks.current.onStop();
      }
    };
    const onBlur = () => {
      if (pending === null) {
        pending = requestAnimationFrame(check);
      }
    };
    document.addEventListener("pointerdown", onInteraction, true);
    document.addEventListener("keydown", onInteraction, true);
    document.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onInteraction, true);
      document.removeEventListener("keydown", onInteraction, true);
      document.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("blur", onBlur);
      if (pending !== null) {
        cancelAnimationFrame(pending);
      }
    };
  }, [running, frameUrl, generation]);
}
