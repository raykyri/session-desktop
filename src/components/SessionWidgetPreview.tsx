import { useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { useSessionWidgetGuards } from "../hooks/useSessionWidgetGuards";
import { isStaticWidgetPage, readWidgetExecution, rememberWidgetExecution, subscribeWidgetExecution } from "../lib/sessionWidgetExecution";

/** Expanded widget surface. Its parent keys it by URL/reload, while execution
 * revocation is shared with inline instances and survives closing the panel. */
export default function SessionWidgetPreview({ url, frameRef, onLoad }: {
  url: string;
  frameRef: RefObject<HTMLIFrameElement | null>;
  onLoad: () => void;
}) {
  const [loads, setLoads] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const [generation, setGeneration] = useState(0);
  const programmaticFocusUntilRef = useRef(0);
  const execution = useSyncExternalStore(subscribeWidgetExecution, () => readWidgetExecution(url), () => null);
  const staticPage = isStaticWidgetPage(url);
  const stopped = execution === "focus" && !staticPage;
  const blocked = navigated || loads > 1 || stopped;
  useSessionWidgetGuards({
    frameRef, frameUrl: blocked ? null : url, generation,
    pageLoaded: !blocked && loads >= 1,
    running: !blocked && !staticPage, programmaticFocusUntilRef,
    onNavigate: () => setNavigated(true),
    onStop: () => rememberWidgetExecution(url, "focus"),
  });
  if (blocked) {
    return (
      <div className="browser-overlay-empty" role="status">
        <p>{stopped ? "Widget scripts stopped because they repeatedly took keyboard focus." : "The widget navigated away from its page."}</p>
        {stopped ? (
          <button type="button" className="control-button" onClick={() => {
            setLoads(0);
            setNavigated(false);
            setGeneration((value) => value + 1);
            rememberWidgetExecution(url, "running");
          }}>Run widget scripts again</button>
        ) : <p>Refresh to reload the widget.</p>}
      </div>
    );
  }
  return (
    <iframe
      key={generation}
      ref={frameRef}
      className="browser-overlay-frame is-file-content"
      src={url}
      title="Expanded answer widget"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={() => {
        setLoads((value) => value + 1);
        onLoad();
      }}
    />
  );
}
