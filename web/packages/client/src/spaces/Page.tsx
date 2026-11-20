// A screen's frame (the mockup's `<div class="A C Af …">`): the header, the
// offline bar, then the screen. And the system states: loading (skeleton
// rows), a load that failed, page not found, Update Session.

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, type ReactNode } from "react";

import { useSession, useStatus } from "../sync/react.js";

import { Header, type Place } from "./Header.js";
import { Svg } from "./Svg.js";
import { I, NVI, SVG } from "./icons.js";
import { focusFirst, useOverlay } from "./overlay.js";

export function OfflineBar() {
  const status = useStatus();
  const session = useSession();
  if (status.online) return null;
  return (
    <div className="nv-off" role="status">
      <Svg src={NVI.off ?? SVG.LOCK} />
      <span className="grow">
        You’re offline. Session shows what it already loaded and can’t send changes until the
        connection is back.
      </span>
      <button className="btn sm" type="button" onClick={() => void session?.retry()}>
        Try again
      </button>
    </div>
  );
}

/** A screen: its root classes, the header (where it is), and its body. */
export function Page({
  cls = "H",
  place,
  children,
}: {
  cls?: string;
  place: Place;
  children: ReactNode;
}) {
  return (
    <div className={`A C Af${cls ? ` ${cls}` : ""}`}>
      <Header place={place} />
      <OfflineBar />
      {children}
    </div>
  );
}

/** The first load: skeleton rows under a skeleton header. */
export function Skeleton() {
  const row = (w: string, k: number) => (
    <div className="nv-sk-row" key={k}>
      <span className="nv-sk nv-sk-ic" />
      <span className="nv-sk-tx">
        <span className="nv-sk" style={{ width: w }} />
        <span className="nv-sk nv-sk-s" />
        <span className="nv-sk nv-sk-m" />
      </span>
    </div>
  );
  return (
    <div className="nv-skel" role="status">
      <span className="nv-vh">Loading…</span>
      <div className="nv-sk-hdr" aria-hidden="true">
        <span className="nv-sk nv-sk-logo" />
        <span className="nv-sk nv-sk-tab" />
        <span className="nv-sk nv-sk-tab" />
        <span className="nv-sk nv-sk-tab" />
        <span className="grow" />
        <span className="nv-sk nv-sk-av" />
      </div>
      <div className="nv-sk-body" aria-hidden="true">
        <span className="nv-sk nv-sk-h" />
        {["78%", "62%", "86%", "56%", "72%", "66%"].map(row)}
      </div>
    </div>
  );
}

/** A first load that failed, with Retry (`de-load-auth`). */
export function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="data-wait" role="alert">
      <p>{message}</p>
      <button className="btn" type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/** Page not found: an unknown address, or a space that does not exist. */
export function NotFound({ space }: { space?: string }) {
  const navigate = useNavigate();
  const addr = `${location.host}${location.pathname}`;
  return (
    <div className="cs-napage nv-nf">
      <div className="cs-na">
        <span className="cs-na-ic">
          <Svg src={NVI.map} />
        </span>
        <h2>{space !== undefined ? `No space named #${space}` : "Page not found"}</h2>
        <p className="muted">
          {space !== undefined ? (
            "Session has no space at this address. Check the name, or search for the space. If its moderators renamed it, links to the old name stop working."
          ) : (
            <>
              Session has no page at <b>{addr}</b>. Check the address, or search for what you were
              looking for.
            </>
          )}
        </p>
        <div className="cs-na-b">
          <button className="btn primary" type="button" onClick={() => void navigate({ to: "/" })}>
            Go to Home
          </button>
          <button className="btn" type="button" onClick={() => void navigate({ to: "/search" })}>
            Search
          </button>
        </div>
      </div>
    </div>
  );
}

/** A modal dialog in the mockup's markup: Escape and the scrim close it,
 * focus moves in and goes back to its opener. */
export function Modal({
  title,
  onClose,
  children,
  footer,
  className = "cs-m",
  role = "dialog",
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  role?: "dialog" | "alertdialog";
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(true, onClose, { back: true });
  useEffect(() => focusFirst(ref.current), []);
  const id = "cs-dt";
  return (
    // a press outside the dialog closes it; Escape does from the keyboard
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${className}`}
        role={role}
        aria-modal="true"
        aria-labelledby={id}
      >
        <div className="modal-h">
          <h3 id={id}>{title}</h3>
          <button className="iconbtn" type="button" aria-label="Close" onClick={onClose}>
            <Svg src={I.close} />
          </button>
        </div>
        {children}
        {footer ? <div className="modal-f">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Update Session: the server takes this client's writes no more until the
 * page is reloaded. Later closes it; it comes back on the next refused
 * write. */
export function UpdateDialog({ onLater }: { onLater: () => void }) {
  return (
    <Modal
      title="Update Session"
      onClose={onLater}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button className="btn" type="button" onClick={onLater}>
            Later
          </button>
          <button className="btn primary" type="button" onClick={() => location.reload()}>
            Reload
          </button>
        </>
      }
    >
      <p className="muted">Session has been updated. Reload the page to keep saving changes.</p>
    </Modal>
  );
}
