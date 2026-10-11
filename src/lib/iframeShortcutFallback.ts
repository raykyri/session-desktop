// Keys typed into a framed document never reach the app document's window
// handlers, so app shortcuts go dead while a frame has focus. The native key
// monitor claims ⌘ chords for Session while told a frame holds focus. Several
// frames can claim that (the browser overlay, answer widgets); this registry
// samples which element has focus and reports one combined value, so one
// frame's blur cannot clear another's claim.
//
// Focus crossing into an iframe blurs the host window and leaves activeElement
// on the frame element; the framed document never forwards focusin/focusout,
// so the sampler runs on window focus transitions, one animation frame later,
// once activeElement has settled.

import { setNativeIframeShortcutFallback } from "./api";

interface ShortcutFallbackEnvironment {
  activeElement: () => unknown;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  listen: (type: "blur" | "focus" | "focusin", listener: () => void) => void;
  unlisten: (type: "blur" | "focus" | "focusin", listener: () => void) => void;
  report: (active: boolean) => void;
}

export function createShortcutFallbackRegistry(environment: ShortcutFallbackEnvironment) {
  const frames = new Set<unknown>();
  let reported = false;
  let pending: number | null = null;
  const report = (active: boolean) => {
    if (active !== reported) {
      reported = active;
      environment.report(active);
    }
  };
  const sample = () => {
    pending = null;
    report(frames.has(environment.activeElement()));
  };
  const schedule = () => {
    if (pending === null) {
      pending = environment.requestFrame(sample);
    }
  };
  const events = ["blur", "focus", "focusin"] as const;
  return {
    /** Claims the fallback while `frame` holds focus; returns the release. */
    register(frame: unknown): () => void {
      if (frames.size === 0) {
        for (const type of events) environment.listen(type, schedule);
      }
      frames.add(frame);
      schedule();
      return () => {
        if (!frames.delete(frame)) {
          return;
        }
        if (frames.size === 0) {
          for (const type of events) environment.unlisten(type, schedule);
          if (pending !== null) {
            environment.cancelFrame(pending);
            pending = null;
          }
          // WebKit fires no focus event for a removed element; release the
          // claim explicitly instead of leaving it wedged on.
          report(false);
        } else {
          schedule();
        }
      };
    },
  };
}

const browserRegistry =
  typeof window === "undefined"
    ? null
    : createShortcutFallbackRegistry({
        activeElement: () => document.activeElement,
        requestFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (handle) => cancelAnimationFrame(handle),
        listen: (type, listener) => window.addEventListener(type, listener),
        unlisten: (type, listener) => window.removeEventListener(type, listener),
        report: (active) => void setNativeIframeShortcutFallback(active).catch(() => undefined),
      });

/** Claims the native shortcut fallback while `frame` has focus. */
export function registerShortcutFallbackFrame(frame: HTMLIFrameElement): () => void {
  return browserRegistry ? browserRegistry.register(frame) : () => undefined;
}
