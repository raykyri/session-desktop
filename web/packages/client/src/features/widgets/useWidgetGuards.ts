// Containment for a widget frame, inline or expanded (the desktop's
// `useSessionWidgetGuards`): one validated message listener per frame, the
// liveness ping that notices a page that navigated away, and the guard that
// stops a running widget which keeps taking keyboard focus from the app.

import {
  SESSION_WIDGET_PING_INTERVAL_MS,
  sessionWidgetPingTick,
  sessionWidgetRecordFocusTake,
  sessionWidgetTookFocus,
} from "@session/shared/lib/sessionWidgets";
import { useCallback, useEffect, useRef, type RefObject } from "react";

import { widgetFrameMessage, type WidgetFrameMessage } from "./widgetBridge.js";

/** The frame's bridge messages, validated (`widgetBridge.ts`), delivered to
 * `onMessage`. One listener per frame, so the frame's message budget counts
 * each message once. */
export function useWidgetMessages(
  frameRef: RefObject<HTMLIFrameElement | null>,
  onMessage: (message: WidgetFrameMessage) => void,
) {
  const handler = useRef(onMessage);
  useEffect(() => {
    handler.current = onMessage;
  });
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const message = widgetFrameMessage(event, frameRef.current?.contentWindow);
      if (message) handler.current(message);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [frameRef]);
}

export function useWidgetGuards({
  frameRef,
  frameUrl,
  generation,
  pageLoaded,
  running,
  programmaticFocusUntilRef,
  onNavigate,
  onStop,
  onHeight,
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
  useEffect(() => {
    callbacks.current = { onNavigate, onStop, onHeight };
  });
  const unansweredPingsRef = useRef(0);

  /** The guard's share of the frame's messages. */
  const onMessage = useCallback((message: WidgetFrameMessage) => {
    if (message.type === "height") callbacks.current.onHeight?.(message.height);
    else if (message.type === "pong") unansweredPingsRef.current = 0;
    // The page reported that its document unloaded during navigation. The
    // new response may never complete or fire a load event.
    else if (message.type === "unload") callbacks.current.onNavigate();
  }, []);

  // Once the widget page has loaded, ping it every second. A document that
  // replaced it (a navigation the page could not cancel, even one whose
  // response never completes and so never fires load) does not answer, and
  // the frame is removed.
  useEffect(() => {
    if (!pageLoaded) return;
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
  }, [pageLoaded, frameUrl, generation, frameRef]);

  // A running widget can call focus() on itself and take keyboard focus from
  // another app control. Focus that enters the frame without a pointer or
  // keyboard action returns to the previously focused element. If a widget
  // repeatedly takes focus, its scripts are stopped (it returns to its
  // static page with a notice), since it would otherwise capture the reader's
  // typing and the app's shortcuts.
  useEffect(() => {
    if (!running || !frameUrl) return;
    let lastAppInteraction = Number.NEGATIVE_INFINITY;
    let previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let takes: number[] = [];
    let pending: number | null = null;
    const onInteraction = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key === "Tab") return;
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
      if (!element || document.activeElement !== element) return;
      const now = performance.now();
      const took = sessionWidgetTookFocus({
        now,
        programmaticUntil: programmaticFocusUntilRef.current,
        lastAppInteraction,
        pointerOverFrame: element.matches(":hover"),
      });
      if (!took) return;
      previous?.focus({ preventScroll: true });
      const record = sessionWidgetRecordFocusTake(takes, now);
      takes = record.takes;
      if (record.stop) callbacks.current.onStop();
    };
    const onBlur = () => {
      if (pending === null) pending = requestAnimationFrame(check);
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
      if (pending !== null) cancelAnimationFrame(pending);
    };
  }, [running, frameUrl, generation, frameRef, programmaticFocusUntilRef]);

  return onMessage;
}
