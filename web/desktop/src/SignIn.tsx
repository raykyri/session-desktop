// The app's sign-in window (the mockup's `sxSignPage`, Screen entry
// sx-si-app): "Sign in with the browser" starts a sign-in, opens the
// browser's approval page and waits for it, showing the code a browser on
// another computer asks for; a denied sign-in can be started again. Once
// the app has its token the client's screens open with "Signed in
// successfully." (sx-si-done).

import { CI, SXI, Svg, Toasts, toast } from "@session/client/shell";
import { useEffect, useRef, useState } from "react";

import type { Desktop } from "./platform.js";
import { SignInError, approvalUrl, authorize, waitForToken, type SignInRequest } from "./signin.js";

type State =
  { s: "start" } | { s: "starting" } | { s: "wait"; req: SignInRequest } | { s: "denied" };

export function SignIn({ desktop }: { desktop: Desktop }) {
  const [state, setState] = useState<State>({ s: "start" });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const host = desktop.origin.replace(/^https?:\/\//, "");

  const start = async () => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setState({ s: "starting" });
    let req: SignInRequest;
    try {
      req = await authorize(desktop.origin, await desktop.bridge.about());
    } catch (e) {
      setState({ s: "start" });
      toast(
        e instanceof SignInError && e.code !== "OFFLINE"
          ? e.message
          : `Couldn’t reach ${host}. Check the connection and try again.`,
      );
      return;
    }
    if (ac.signal.aborted) return;
    setState({ s: "wait", req });
    await desktop.bridge.openUrl(approvalUrl(desktop.origin, req.request)).catch(() => undefined);
    const r = await waitForToken(desktop.origin, req.request, { signal: ac.signal }).catch(
      () => "expired" as const,
    );
    if (ac.signal.aborted || r === "cancelled") return;
    if (r === "denied") return setState({ s: "denied" });
    if (r === "expired") {
      setState({ s: "start" });
      toast("The sign-in request expired. Start again.");
      return;
    }
    toast("Signed in successfully.");
    await desktop.signedIn(r);
  };

  const cancel = () => {
    abort.current?.abort();
    setState({ s: "start" });
  };

  const icon = (
    <span className="cs-na-ic">
      <Svg src={SXI.mac} />
    </span>
  );
  let body;
  if (state.s === "denied")
    body = (
      <>
        {icon}
        <h2>Sign-in was denied</h2>
        <p className="muted">The browser denied this Mac. Start again if that was a mistake.</p>
        <div className="cs-na-b">
          <button className="btn primary" type="button" onClick={() => void start()}>
            Start again
          </button>
        </div>
      </>
    );
  else if (state.s === "wait")
    body = (
      <>
        {icon}
        <h2>Approve this Mac in your browser</h2>
        <p className="muted">
          Session opened {host}/device in your browser. Approve this Mac there. The app then stores
          a device token in the macOS Keychain.
        </p>
        <p className="sx-code-l muted">If the browser asks for a code, enter</p>
        <p className="sx-code num" aria-label="Sign-in code">
          {state.req.code}
        </p>
        <span className="sx-wait">
          <span className="spin" aria-hidden="true" />
          Waiting for the browser…
        </span>
        <div className="cs-na-b">
          <button
            className="btn"
            type="button"
            onClick={() => {
              void desktop.bridge.openUrl(approvalUrl(desktop.origin, state.req.request));
              toast(`Opened ${host}/device in your browser.`);
            }}
          >
            Open the page again
          </button>
          <button className="btn" type="button" onClick={cancel}>
            Cancel
          </button>
        </div>
        <p className="cs-fine">
          <Svg src={CI.clock} />
          <span>The request expires in 10 minutes.</span>
        </p>
      </>
    );
  else
    body = (
      <>
        {icon}
        <h2>Sign in to Session</h2>
        <p className="muted">
          Session opens {host} in your browser. Approve this Mac there, and the app signs in.
        </p>
        <div className="cs-na-b">
          <button
            className="btn primary"
            type="button"
            disabled={state.s === "starting"}
            onClick={() => void start()}
          >
            Sign in with the browser
          </button>
        </div>
      </>
    );
  return (
    <div id="app" className="app">
      <div className="A C Af H sx-sign">
        <div className="cs-napage">
          <div className="cs-na">{body}</div>
        </div>
      </div>
      <Toasts />
    </div>
  );
}
