// The storage problem (review round 1 of phase 3, finding 7): the person's
// replica could not be opened, so the client's screens are closed and this
// shows instead.
// - Another copy of the app holds the file (LOCKED): quit it, then Try
//   again.
// - SQLite failed: Try again, or Reset, which deletes the replica (and the
//   writes in it) and reads the person's spaces again from the server. The
//   unsent writes that can still be read are listed first, each with Copy
//   text, and Reset asks once more when it deletes any.
// The mockup has no such screen: the copy here is the app's own.

import {
  SXI,
  Svg,
  Toasts,
  describeStoredWrite,
  toast,
  writeClipboardText,
} from "@session/client/shell";
import type { OutboxEntry } from "@session/sync/client";
import { useEffect, useState } from "react";

import type { Desktop } from "./platform.js";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function StorageProblem({ desktop }: { desktop: Desktop }) {
  const problem = desktop.problem();
  const locked = problem?.code === "LOCKED";
  /** The unsent writes as far as they can be read; null: they cannot be;
   * undefined: not read yet. */
  const [writes, setWrites] = useState<OutboxEntry[] | null | undefined>(undefined);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (locked) return;
    let live = true;
    void desktop.unsentWrites().then((w) => {
      if (live) setWrites(w);
    });
    return () => {
      live = false;
    };
  }, [desktop, locked]);
  const host = desktop.origin.replace(/^https?:\/\//, "");
  const now = Date.now();
  const rows = (writes ?? []).map((e) => describeStoredWrite(e, now));
  const unsent = writes === null ? null : rows.length;

  const reset = async () => {
    setBusy(true);
    try {
      await desktop.resetReplica();
    } catch (e) {
      toast(`Session couldn’t reset its data (${e instanceof Error ? e.message : String(e)}).`);
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (locked)
    body = (
      <>
        <h2>Another copy of Session is open</h2>
        <p className="muted">
          It is using this Mac’s copy of your spaces. Quit the other copy of Session, then try
          again.
        </p>
        <div className="cs-na-b">
          <button className="btn primary" type="button" onClick={() => desktop.retryStorage()}>
            Try again
          </button>
        </div>
      </>
    );
  else
    body = (
      <>
        <h2>Session can’t open its data on this Mac</h2>
        <p className="muted">{problem?.message}</p>
        <p className="muted">
          Try again, or reset: Session deletes its copy of your spaces on this Mac and downloads
          them again from {host}.
        </p>
        {unsent === null ? (
          <p className="muted">
            Session can’t read the unsent changes on this Mac. Resetting deletes them.
          </p>
        ) : unsent > 0 ? (
          <>
            <p className="muted">
              {plural(unsent, "unsent change", "unsent changes")} would be deleted with it. Copy the
              text you want to keep first.
            </p>
            <ul className="sx-list" aria-label="Unsent changes">
              {rows.map((r) => (
                <li key={r.local} className="sx-row">
                  <span className="sx-rt">{r.title}</span>
                  {r.text ? <span className="sx-rx">{r.text}</span> : null}
                  {r.text ? (
                    <button
                      className="btn"
                      type="button"
                      onClick={() =>
                        void writeClipboardText(r.text)
                          .catch(() => undefined)
                          .then(() => toast("Text copied."))
                      }
                    >
                      Copy text
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {confirm ? (
          <>
            <p className="muted" role="alert">
              {unsent === null
                ? "Reset deletes this Mac’s copy of your spaces and every unsent change on it."
                : `Reset deletes this Mac’s copy of your spaces${
                    unsent > 0 ? ` and ${plural(unsent, "unsent change", "unsent changes")}` : ""
                  }.`}
            </p>
            <div className="cs-na-b">
              <button
                className="btn danger"
                type="button"
                disabled={busy}
                onClick={() => void reset()}
              >
                Reset
              </button>
              <button className="btn" type="button" onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className="cs-na-b">
            <button className="btn primary" type="button" onClick={() => desktop.retryStorage()}>
              Try again
            </button>
            <button
              className="btn"
              type="button"
              disabled={writes === undefined || busy}
              onClick={() => (unsent === 0 ? void reset() : setConfirm(true))}
            >
              Reset…
            </button>
          </div>
        )}
      </>
    );
  return (
    <div id="app" className="app">
      <div className="A C Af H sx-sign">
        <div className="cs-napage">
          <div className="cs-na">
            <span className="cs-na-ic">
              <Svg src={SXI.mac} />
            </span>
            {body}
          </div>
        </div>
      </div>
      <Toasts />
    </div>
  );
}
