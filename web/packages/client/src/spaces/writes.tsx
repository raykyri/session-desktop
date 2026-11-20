// Writes from the screens (phase 2b, slice 2): a write goes through the sync
// client's outbox (predicted at once, then confirmed or refused). On the web
// (`persist: false`) a write that gets no answer (offline, a server error)
// ends at once: the screen that made it shows Try again on its item. A
// refusal (FORBIDDEN, NOT_FOUND, STALE, …) puts the prediction back and shows
// one toast whose text depends on the code (the mockup's API_ERR.write).
//
// In the Desktop app (`persist: true`, phase 3) the screen waits for a
// write only while it is being sent: once it waits in the outbox (offline,
// behind other writes, held for an update, or after a try without an
// answer) the screen goes on as if it applied, and Unsent changes and its
// toasts (`Outbox.tsx`) show what becomes of it.

import type { Answer, ApiError, OutboxEntry, SyncClient } from "@session/sync/client";
import { useState, useSyncExternalStore } from "react";

import { useSession } from "../sync/react.js";
import type { SpacesSession } from "../sync/session.js";

import { Svg } from "./Svg.js";
import { I } from "./icons.js";

export const WRITE_ERROR: Record<string, string> = {
  BAD_REQUEST: "The server rejected the change as not valid. Session undid it.",
  UNAUTHORIZED: "Your sign-in expired, so the server didn’t save the change. Sign in again.",
  FORBIDDEN: "You no longer have permission to do this. Session undid the change.",
  NOT_FOUND: "Someone deleted this item, so the server couldn’t save the change. Session undid it.",
  CONFLICT: "Someone else changed this item first. Session undid your change.",
  PRECONDITION_FAILED:
    "The item changed state, so the server didn’t save the change. Session undid it.",
  TOO_MANY_REQUESTS:
    "You made too many changes in a short time. Session undid the last one. Try again in a minute.",
  STALE:
    "This item changed after you opened it, so the server didn’t apply the change. Session undid it.",
  EXPIRED: "The change was made too long ago for the server to take it. Session undid it.",
  TOO_LARGE: "The change is too large for the server to take. Session undid it.",
  UPDATE_REQUIRED: "This version of Session can’t save changes. Reload to update it.",
  unavailable: "Couldn’t reach the server, so Session undid the change. Try again in a moment.",
};

// ---- toasts ----

interface ToastAction {
  label: string;
  run: () => void;
}

interface Toast {
  id: number;
  text: string;
  actions: ToastAction[];
}

let toasts: Toast[] = [];
let nextToast = 1;
const toastListeners = new Set<() => void>();
const emit = () => {
  for (const l of [...toastListeners]) l();
};

/** Show a toast (the mockup's `cs-toast`): one at a time, the newest. It goes
 * after 6 s (12 s with an action), on Dismiss, or on an action. */
export function toast(text: string, ...actions: ToastAction[]): void {
  const t: Toast = { id: nextToast++, text, actions };
  toasts = [t];
  emit();
  setTimeout(() => dismissToast(t.id), actions.length ? 12_000 : 6_000);
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((x) => x.id !== id);
  emit();
}

const subscribe = (l: () => void) => {
  toastListeners.add(l);
  return () => void toastListeners.delete(l);
};
const snapshot = () => toasts;

export function Toasts() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  const t = list[0];
  if (!t) return null;
  const buttons = t.actions.map((a) => (
    <button
      key={a.label}
      className="tlink"
      type="button"
      onClick={() => {
        dismissToast(t.id);
        a.run();
      }}
    >
      {a.label}
    </button>
  ));
  return (
    <div className={t.actions.length > 1 ? "cs-toast-wrap sx-toastw" : "cs-toast-wrap"}>
      <div className="cs-toast" role="status">
        <span>{t.text}</span>
        {t.actions.length > 1 ? <span className="sx-tacts">{buttons}</span> : buttons}
        <button
          className="iconbtn"
          type="button"
          aria-label="Dismiss"
          onClick={() => dismissToast(t.id)}
        >
          <Svg src={I.close} />
        </button>
      </div>
    </div>
  );
}

// ---- writes ----

/** How a write ended: applied, refused (with the server's error), or no
 * answer (the screen offers Try again). */
export type Outcome =
  | {
      ok: true;
      result: unknown;
      /** The Desktop app: the write waits in the outbox (offline, behind
       * other writes, or after a try without an answer); Unsent changes
       * shows it from here on, and its result is not known. */
      queued?: boolean;
      /** Send again: the input as it was sent (its ids can be new). */
      input?: unknown;
      /** Send again: an earlier envelope of it had applied (`earlier`). */
      earlier?: boolean;
    }
  | { ok: false; error: ApiError }
  | { ok: false; error: null; local: string };

/** The text of a refusal (the mockup's API_ERR.write). TOO_MANY_REQUESTS
 * without `retryAt` is the limit on a person's asks waiting or running, not
 * the write budget: waiting a minute does not lift it, so the server's
 * message, which names the limit, is shown (the mockup's API_ERR.write
 * `queued`; review round 2 of phase 2, finding 7). */
export function refusalText(error: ApiError): string {
  if (error.code === "TOO_MANY_REQUESTS" && !error.retryAt && error.message) return error.message;
  return WRITE_ERROR[error.code] ?? WRITE_ERROR["unavailable"] ?? "";
}

/** The toast of a refusal. */
export function refusalToast(error: ApiError): void {
  toast(refusalText(error));
}

/** Wait for a write's outcome; a refusal shows its toast unless `quiet`. */
/** A write the server's write budget refused (TOO_MANY_REQUESTS with
 * `retryAt`, unrecorded: phase 2 review round 1, reviewer A's F6). The sync
 * client ends it as failed on the web; it never applied unless an earlier
 * send of it went without an answer (`uncertain`), so it reads as refused. */
function limited(session: SpacesSession, local: string): ApiError | null {
  const e = session.client?.outbox().find((x) => x.local === local);
  return e && e.state === "failed" && !e.uncertain && e.error?.code === "TOO_MANY_REQUESTS"
    ? e.error
    : null;
}

/** The writes a screen waits on (the Desktop app): their refusal is the
 * screen's to show; once a write waits in the outbox, Unsent changes and
 * its toasts show what happens to it (`Outbox.tsx`). */
const awaited = new Set<string>();
export const isAwaited = (local: string) => awaited.has(local);

/** A write that waits in the outbox rather than for an answer now: held
 * for an update, or tried without an answer and waiting for its next try.
 * (A write that ended, refused or shown, is its answer's.) */
function waits(c: SyncClient, e: OutboxEntry): boolean {
  if (e.state === "held") return true;
  return e.state === "queued" && (e.tries > 0 || e.uncertain || e.next > c.now());
}

/** The Desktop app (`persist: true`): a write is the screen's until it is
 * answered or it waits in the outbox; then the screen goes on as if it
 * applied (`queued`), and the outbox owns it. */
async function settleKept(
  session: SpacesSession,
  c: SyncClient,
  w: { local: string; answer: Promise<Answer | null> },
  quiet: boolean,
): Promise<Outcome> {
  awaited.add(w.local);
  try {
    return await new Promise<Outcome>((resolve) => {
      let done = false;
      const finish = (o: Outcome) => {
        if (done) return;
        done = true;
        stop();
        resolve(o);
      };
      const check = () => {
        const list = c.outbox();
        const k = list.findIndex((x) => x.local === w.local);
        const e = list[k];
        // an online-only call is not in the outbox: its answer decides
        if (!e || e.state === "answered") return;
        const behind = list.slice(0, k).some((x) => x.state === "queued" || x.state === "held");
        if (behind || waits(c, e) || c.updateRequired || !session.status().online)
          finish({ ok: true, result: null, queued: true });
      };
      const stop = c.onChange(check);
      check();
      void w.answer.then((a) => {
        if (done) return;
        if (a === null) {
          const error = limited(session, w.local);
          if (!error) return finish({ ok: true, result: null, queued: true });
          if (!quiet) refusalToast(error);
          c.discard(w.local);
          return finish({ ok: false, error });
        }
        if (a.ok) return finish({ ok: true, result: a.result });
        if (!quiet) refusalToast(a.error);
        c.discard(w.local);
        finish({ ok: false, error: a.error });
      });
    });
  } finally {
    awaited.delete(w.local);
  }
}

async function settle(
  session: SpacesSession,
  w: { local: string; answer: Promise<Answer | null> },
  quiet: boolean,
): Promise<Outcome> {
  if (session.persistent && session.client) return settleKept(session, session.client, w, quiet);
  const a = await w.answer;
  if (a === null) {
    const error = limited(session, w.local);
    if (!error) return { ok: false, error: null, local: w.local };
    if (!quiet) refusalToast(error);
    session.client?.discard(w.local);
    return { ok: false, error };
  }
  if (a.ok) return { ok: true, result: a.result };
  if (!quiet) refusalToast(a.error);
  // a refused write is shown once (here); the outbox forgets it
  session.client?.discard(w.local);
  return { ok: false, error: a.error };
}

export interface Writer {
  /** Make a write and wait for its outcome. */
  (name: string, input: unknown, o?: { quiet?: boolean }): Promise<Outcome>;
  /** Send a write that got no answer again, keeping its ids; `input`
   * changes its input (it must make the same ids). */
  retry(local: string, o?: { input?: unknown }): Promise<Outcome>;
}

export function useWrite(): Writer {
  const session = useSession();
  const make = async (
    name: string,
    input: unknown,
    o: { quiet?: boolean } = {},
  ): Promise<Outcome> => {
    if (!session) return { ok: false, error: { code: "UNAUTHORIZED", message: "Sign in." } };
    const w = session.write(name, input);
    if (!w) return { ok: false, error: { code: "UNAUTHORIZED", message: "Sign in." } };
    return settle(session, w, o.quiet === true);
  };
  const retry = async (local: string, o: { input?: unknown } = {}): Promise<Outcome> => {
    const c = session?.client;
    if (!session || !c || !c.sendAgain(local, o))
      return { ok: false, error: { code: "NOT_FOUND", message: "Gone." } };
    // the entry's state is the outcome: answered, or shown again
    return new Promise<Outcome>((resolve) => {
      const check = () => {
        const e = c.outbox().find((x) => x.local === local);
        if (!e) return false;
        if (e.state === "answered")
          resolve({ ok: true, result: e.result, input: e.input, earlier: e.earlier === true });
        else if (e.state === "refused" || e.state === "expired") {
          const error = e.error ?? { code: "BAD_REQUEST", message: "" };
          refusalToast(error);
          c.discard(local);
          resolve({ ok: false, error });
        } else if (e.state === "failed" && limited(session, local)) {
          const error = limited(session, local) ?? { code: "TOO_MANY_REQUESTS", message: "" };
          refusalToast(error);
          c.discard(local);
          resolve({ ok: false, error });
        } else if (e.state === "failed" || e.state === "dropped")
          resolve({ ok: false, error: null, local });
        else return false;
        return true;
      };
      if (check()) return;
      const stop = c.onChange(() => {
        if (check()) stop();
      });
    });
  };
  return Object.assign(make, { retry });
}

/** Make a write whose outcome only a toast reports (a like, a save). */
export function useQuickWrite() {
  const write = useWrite();
  return (name: string, input: unknown) =>
    void write(name, input).then((o) => {
      if (!o.ok && o.error === null) toast(WRITE_ERROR["unavailable"] ?? "");
    });
}

// ---- creates ----

/** How a create ended: an `Outcome`, the id of the record it made, and
 * (applied) whether an earlier send had applied while the input sent last
 * differs from an input sent before it (`lostEdits`): the record holds an
 * earlier input, so the later edits were not saved. */
export type CreateOutcome = Outcome & { id: string; lostEdits: boolean };

/** A create: a write whose input names the id of the record it makes
 * (`threads.create`, a follow-up, a reply, a page, a skill). A create that
 * got no answer may have applied (phase 2 review round 1, finding 2), so no
 * second create is made while it has none: the next send first reads the
 * logs (`checking`); a read that holds its record means it applied, and
 * otherwise it is sent again with the same id, the current input, and its
 * earlier mutation ids in `replaces`, so the server answers from an earlier
 * envelope that applied rather than making a second record. An earlier
 * envelope that applied made the record from its own input, so the whole
 * input (`make(id)`: the text, the space, the kind, who pays, the model, the
 * parent) is compared with every input sent before it (review round 2 of
 * phase 2, finding 2); a difference is reported as lost edits. */
export function useCreate() {
  const session = useSession();
  const write = useWrite();
  const [lost, setLost] = useState<{ local: string; id: string; sent: string[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const send = async (
    name: string,
    make: (id: string) => Record<string, unknown>,
    o: { quiet?: boolean } = {},
  ): Promise<CreateOutcome> => {
    const c = session?.client;
    if (!session || !c)
      return {
        ok: false,
        error: { code: "UNAUTHORIZED", message: "Sign in." },
        id: "",
        lostEdits: false,
      };
    let id: string;
    // the inputs sent before this one, as JSON
    let before: string[];
    let input: Record<string, unknown>;
    let out: Outcome;
    if (lost) {
      id = lost.id;
      before = lost.sent;
      input = make(id);
      setChecking(true);
      try {
        await c.sync().catch(() => false);
        const e = c.outbox().find((x) => x.local === lost.local);
        // a read that holds its record answered it (or the entry is gone
        // after it was answered)
        out =
          !e || e.state === "answered"
            ? { ok: true, result: e?.result ?? null, earlier: true }
            : await write.retry(lost.local, { input });
      } finally {
        setChecking(false);
      }
    } else {
      id = session.newId();
      before = [];
      input = make(id);
      out = await write(name, input, o);
    }
    const now = JSON.stringify(input);
    if (out.ok) {
      setLost(null);
      const sent = (out.input as { id?: unknown } | undefined)?.id;
      return {
        ...out,
        id: typeof sent === "string" ? sent : id,
        lostEdits: out.earlier === true && before.some((j) => j !== now),
      };
    }
    if (out.error === null)
      setLost({ local: out.local, id, sent: before.includes(now) ? before : [...before, now] });
    else setLost(null);
    return { ...out, id, lostEdits: false };
  };
  /** The draft was discarded: its create that got no answer is forgotten. */
  const forget = () => {
    if (lost) session?.client?.discard(lost.local);
    setLost(null);
  };
  return { send, forget, checking, lost: lost !== null, lostId: lost?.id ?? null };
}

/** The toast of a create that had applied before the person's later edits
 * (the mockup's AS_LOST, with Copy your edits). */
export function lostEditsToast(noun: string, draft: string): void {
  toast(
    `Your ${noun} went through before the error, so Session didn’t post it again. Your later edits weren’t saved.`,
    {
      label: "Copy your edits",
      run: () =>
        void Promise.resolve(navigator.clipboard?.writeText(draft))
          .catch(() => undefined)
          .then(() => toast("Copied your edits.")),
    },
  );
}
