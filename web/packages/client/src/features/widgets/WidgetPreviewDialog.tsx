// The expanded widget view: the desktop's `SessionWidgetPreview` in the
// thread's browser overlay, here in a dialog. It shows the widget's current
// page ("Open expanded view") or a stored revision's static page (a row of
// the revision list), with the same containment and saved inputs as the
// inline frame. A stop for taking focus is shared with the inline copies.

import type { ResearchArtifactRef } from "@session/shared";
import { useRef, useState, useSyncExternalStore } from "react";

import { Dialog } from "../../ui/Dialog.js";

import { useArtifactState } from "./artifactState.js";
import { useWidgetGuards, useWidgetMessages } from "./useWidgetGuards.js";
import {
  readWidgetExecution,
  rememberWidgetExecution,
  subscribeWidgetExecution,
} from "./widgetExecution.js";

export interface WidgetPreviewTarget {
  url: string;
  /** The widget's HTML, which keys its execution choice. */
  html: string;
  /** Whether `url` is the static page (no widget scripts). */
  staticPage: boolean;
  reference: ResearchArtifactRef | null;
  title: string;
}

function PreviewFrame({ target }: { target: WidgetPreviewTarget }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [loads, setLoads] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const [generation, setGeneration] = useState(0);
  const programmaticFocusUntilRef = useRef(0);
  const execution = useSyncExternalStore(
    subscribeWidgetExecution,
    () => readWidgetExecution(target.html),
    () => null,
  );
  const stopped = execution === "focus" && !target.staticPage;
  const blocked = navigated || loads > 1 || stopped;
  const state = useArtifactState(
    target.reference,
    frameRef,
    blocked ? null : target.url,
    !blocked && loads >= 1,
  );
  const guard = useWidgetGuards({
    frameRef,
    frameUrl: blocked ? null : target.url,
    generation,
    pageLoaded: !blocked && loads >= 1,
    running: !blocked && !target.staticPage,
    programmaticFocusUntilRef,
    onNavigate: () => setNavigated(true),
    onStop: () => rememberWidgetExecution(target.html, "focus"),
  });
  useWidgetMessages(frameRef, (message) => {
    guard(message);
    state.onMessage(message);
  });
  if (blocked) {
    return (
      <div className="text-fg-muted flex flex-col items-start gap-2 text-sm" role="status">
        <p className="m-0">
          {stopped
            ? "Widget scripts stopped because they repeatedly took keyboard focus."
            : "The widget navigated away from its page."}
        </p>
        {stopped ? (
          <button
            type="button"
            className="session-widget-run"
            onClick={() => {
              setLoads(0);
              setNavigated(false);
              setGeneration((value) => value + 1);
              rememberWidgetExecution(target.html, "running");
            }}
          >
            Run widget scripts again
          </button>
        ) : (
          <p className="m-0">Close and open it again to reload the widget.</p>
        )}
      </div>
    );
  }
  return (
    <iframe
      key={generation}
      ref={frameRef}
      className="session-widget-frame h-[70vh] rounded-md"
      src={target.url}
      title="Expanded answer widget"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={() => setLoads((value) => value + 1)}
    />
  );
}

export function WidgetPreviewDialog({
  target,
  onClose,
}: {
  target: WidgetPreviewTarget | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={target?.title ?? "Widget"}
      className="w-[min(1100px,calc(100vw-2rem))] max-w-none"
    >
      {target ? <PreviewFrame key={target.url} target={target} /> : null}
    </Dialog>
  );
}
