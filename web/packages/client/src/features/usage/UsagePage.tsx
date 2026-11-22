// Usage and API keys (02 W8.1; 03 K4-K7, K14; the mock's `usagePage`): the
// share of the weekly allowance left with a bar, the recent runs, what
// happens when included tokens run out, and one row per provider key.
//
// Everything here is online-only (ADR-19) through TanStack Query: `usage.get`
// (the same query the app bar's ring reads), `usage.listRuns`,
// `usage.setBilling`, `apiKeys.set` and `apiKeys.remove`. `apiKeys.set`
// checks the key with the provider during the request; the row shows
// "Checking…" until it answers.

import {
  API_KEY_PROVIDERS,
  API_KEY_PROVIDER_INFO,
  apiKeyFormatError,
  type ApiKeyProvider,
} from "@session/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  useModels,
  useRemoveApiKey,
  useSetApiKey,
  useSetBilling,
  useUsageRuns,
  useWeeklyUsage,
} from "../../api/account.js";
import { refusalMessage } from "../../lib/toast.js";
import { OVERLAY_PRIORITY, useOverlaysStore } from "../../stores/overlays.js";
import { clip } from "../feed/format.js";
import { PageFrame } from "../shell/Frames.js";
import { showToast } from "../shell/Toast.js";
import { usageTone } from "../shell/usage.js";

import { runCharge, runDay, runQuestion, usageSentence } from "./usageText.js";

/** How many recent runs the page lists (03 K5). */
export const RECENT_RUNS = 6;

interface KeyView {
  provider: ApiKeyProvider;
  last4: string;
  status: "valid" | "invalid";
}

function CheckCircle() {
  return (
    <svg className="i kcc" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.4 8.2l1.8 1.8 3.4-3.8" />
    </svg>
  );
}

function UsageTop({
  reading,
  now,
}: {
  reading: { used: number; allowance: number; resetAt: number };
  now: number;
}) {
  const tone = usageTone(reading.used, reading.allowance);
  const { percent, weekday, resetIn } = usageSentence(reading, now);
  // The bar is drawn to one decimal; the sentence rounds to a whole percent.
  const left =
    reading.allowance > 0 ? Math.min(1, Math.max(0, 1 - reading.used / reading.allowance)) : 0;
  return (
    <section className="box">
      <p className={`usent ${tone}`}>
        <b>{percent}%</b> of usage left this week. Next reset {weekday}, in {resetIn}.
      </p>
      <div className={`utrack ${tone}`} role="img" aria-label={`${percent}% left`}>
        <span style={{ width: `${(left * 100).toFixed(1)}%` }} />
      </div>
    </section>
  );
}

function RecentRuns() {
  const runs = useUsageRuns();
  const list = runs.data?.runs ?? [];
  return (
    <section className="box" aria-labelledby="usage-runs">
      <h3 id="usage-runs">Recent runs</h3>
      {runs.isPending ? (
        <p className="uempty" role="status" aria-label="Loading" aria-busy="true" />
      ) : runs.isError && !runs.data ? (
        <p className="ferr" role="alert">
          Couldn&apos;t load your runs. Reload to try again.
        </p>
      ) : list.length === 0 ? (
        <p className="uempty">No runs yet this week.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {list.slice(0, RECENT_RUNS).map((run) => {
            const question = runQuestion(run);
            return (
              <li key={run.runId} className="urun">
                <span className={question.gone ? "rq gone" : "rq"}>
                  {question.gone ? question.text : clip(question.text, 90)}
                </span>
                <span className="rpct">
                  {runCharge(run)} · {runDay(run.at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function BillingSection({ billing, keys }: { billing: "pause" | "key"; keys: KeyView[] }) {
  const setBilling = useSetBilling();
  const models = useModels();
  // The models only an OpenAI key runs (03 K11): the mock names its one.
  const openaiOnly = (models.data?.models ?? [])
    .filter((m) => m.payers.includes("key:openai") && !m.payers.includes("included"))
    .map((m) => m.label);
  const anthropic = keys.find((k) => k.provider === "anthropic" && k.status === "valid");
  const openai = keys.find((k) => k.provider === "openai" && k.status === "valid");
  const [error, setError] = useState<string | null>(null);
  // The choice being written shows at once; a refusal restores the stored one.
  const [pending, setPending] = useState<"pause" | "key" | null>(null);
  const current = pending ?? billing;
  const choose = (mode: "pause" | "key") => {
    setError(null);
    setPending(mode);
    setBilling.mutate(mode, {
      onSettled: () => setPending(null),
      onSuccess: () =>
        showToast(
          mode === "key"
            ? "Asks will continue on your API key."
            : "Asks will pause until the reset.",
        ),
      onError: (refusal) => setError(refusalMessage(refusal)),
    });
  };
  const keyHint = anthropic
    ? "Asks use your Anthropic key until the reset."
    : openai
      ? openaiOnly.length > 0
        ? `Needs an Anthropic key. Your OpenAI key only runs ${openaiOnly.join(", ")}.`
        : "Needs an Anthropic key."
      : "Add a key below to turn this on.";
  return (
    <section className="box" aria-labelledby="usage-billing">
      <h3 id="usage-billing">When included tokens run out</h3>
      <div role="radiogroup" aria-labelledby="usage-billing">
        <label className="radio">
          <input
            type="radio"
            name="billing"
            value="pause"
            checked={current === "pause"}
            onChange={() => choose("pause")}
          />{" "}
          <span>
            <b>Pause my asks until the reset</b>
            <small>You can still read, post and reply.</small>
          </span>
        </label>
        <label className={anthropic ? "radio" : "radio off"}>
          <input
            type="radio"
            name="billing"
            value="key"
            checked={current === "key"}
            disabled={!anthropic}
            onChange={() => choose("key")}
          />{" "}
          <span>
            <b>Continue on my Anthropic key</b>
            <small>{keyHint}</small>
          </span>
        </label>
      </div>
      {error ? (
        <p className="ferr" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function KeyRow({ provider, stored }: { provider: ApiKeyProvider; stored: KeyView | undefined }) {
  const info = API_KEY_PROVIDER_INFO[provider];
  const setKey = useSetApiKey();
  const removeKey = useRemoveApiKey();
  const [form, setForm] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  // Where focus goes once the row has rendered its next state (02 §10.1):
  // after a save the row's Remove, after a removal or Cancel its Add key,
  // after Keep its Remove.
  const [focusNext, setFocusNext] = useState<"remove" | "add" | null>(null);
  useEffect(() => {
    if (focusNext === null) return;
    const target = focusNext === "remove" ? removeButton.current : addButton.current;
    if (target) {
      target.focus();
      setFocusNext(null);
    }
    // The target appears with the row's next state: a stored key, the form
    // closing or the confirmation closing.
  }, [focusNext, stored, checking, confirming, form]);
  const inputId = `in-key-${provider}`;
  const errorId = `${inputId}-error`;

  // Both use only state setters, so they keep one identity across renders.
  const cancelForm = useCallback(() => {
    setForm(false);
    setError(null);
    setDraft("");
    setFocusNext("add");
  }, []);
  const keepKey = useCallback(() => {
    setConfirming(false);
    setFocusNext("remove");
  }, []);
  // Escape closes the open form (as Cancel) or the removal confirm (as
  // Keep), after every layer above them (02 §10.2). The layer is registered
  // while either is shown, wherever focus is.
  const layer = `key:${provider}:${useId()}`;
  const formShown = checking === null && !(stored && confirming) && form;
  const confirmShown = checking === null && Boolean(stored) && confirming;
  const register = useOverlaysStore((state) => state.register);
  const unregister = useOverlaysStore((state) => state.unregister);
  useEffect(() => {
    if (!formShown && !confirmShown) return;
    register(layer, OVERLAY_PRIORITY.keyForm, formShown ? cancelForm : keepKey);
    return () => unregister(layer);
  }, [formShown, confirmShown, layer, register, unregister, cancelForm, keepKey]);

  const openForm = () => {
    setForm(true);
    setError(null);
    requestAnimationFrame(() => input.current?.focus());
  };

  const save = () => {
    const raw = draft.trim();
    const formatError = apiKeyFormatError(provider, raw);
    if (formatError !== null) {
      setError(formatError);
      input.current?.focus();
      return;
    }
    setError(null);
    setForm(false);
    setChecking(raw.slice(-4));
    setKey.mutate(
      { provider, raw },
      {
        onSuccess: () => {
          setChecking(null);
          setDraft("");
          setFocusNext("remove");
          showToast(`${info.name} key works.`);
        },
        onError: (refusal) => {
          // Nothing was saved: the form comes back with the text kept.
          setChecking(null);
          setForm(true);
          setError(refusalMessage(refusal));
          requestAnimationFrame(() => input.current?.focus());
        },
        // The raw key is the mutation's input: once answered, the mutation
        // leaves the cache (`useSetApiKey` keeps it for no time).
        onSettled: () => setKey.reset(),
      },
    );
  };

  const remove = () => {
    removeKey.mutate(provider, {
      onSuccess: () => {
        setConfirming(false);
        setFocusNext("add");
        showToast(`${info.name} key removed.`);
      },
      onError: (refusal) => {
        setConfirming(false);
        showToast(refusalMessage(refusal), { alert: true });
      },
    });
  };

  const name = <b className="kname">{info.name}</b>;
  // 03 K14, shown in every state of the row.
  const note = <p className="knote">Asks on this key go to {info.name} directly.</p>;

  let body;
  if (checking !== null) {
    body = (
      <div className="kstate">
        {name}
        <span className="kmask">
          {info.prefix}••••{checking}
        </span>
        <span className="chip kchip">Checking…</span>
      </div>
    );
  } else if (stored && confirming) {
    body = (
      <div className="kconfirm">
        {/* no model bills to an OpenAI key, so no asks stop with it */}
        <span>
          {provider === "openai"
            ? "Remove the OpenAI key?"
            : `Remove the ${info.name} key? Asks billed to it will stop.`}
        </span>
        <span className="grow" />
        <button ref={keep} type="button" className="btn2 sm" onClick={keepKey}>
          Keep
        </button>
        <button
          type="button"
          className="btn1 sm danger"
          disabled={removeKey.isPending}
          onClick={remove}
        >
          Remove
        </button>
      </div>
    );
  } else if (form) {
    body = (
      <div className="kstack">
        {name}
        <form
          className="kform"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <input
            ref={input}
            id={inputId}
            type="password"
            placeholder={`Paste key (${info.placeholder})`}
            autoComplete="off"
            spellCheck={false}
            aria-label={`${info.name} API key`}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="btn1 sm" aria-busy={setKey.isPending || undefined}>
            Save
          </button>
          <button type="button" className="btn2 sm" onClick={cancelForm}>
            Cancel
          </button>
        </form>
        {error ? (
          <p id={errorId} className="ferr" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  } else if (stored) {
    body = (
      <div className="kstate">
        {name}
        <span className="kmask">
          {info.prefix}••••{stored.last4}
        </span>
        {stored.status === "valid" ? (
          <span className="chip kchip ok">
            <CheckCircle />
            Valid
          </span>
        ) : (
          <span className="chip kchip bad">Invalid</span>
        )}
        <span className="grow" />
        <button
          ref={removeButton}
          type="button"
          className="btn2 sm"
          onClick={() => {
            setConfirming(true);
            requestAnimationFrame(() => keep.current?.focus());
          }}
        >
          Remove
        </button>
      </div>
    );
  } else {
    body = (
      <div className="kstate">
        {name}
        <small>Not set</small>
        <span className="grow" />
        <button ref={addButton} type="button" className="btn2 sm" onClick={openForm}>
          Add key
        </button>
      </div>
    );
  }

  // One live region per row, always rendered, so a change of status is
  // announced once: Checking…, then Valid or Invalid (02 W8.1).
  const status =
    checking !== null
      ? "Checking…"
      : stored
        ? stored.status === "valid"
          ? "Valid"
          : "Invalid"
        : "";
  const announced = status === "" ? "" : `${info.name} key: ${status}`;

  return (
    <div className="krow" data-key={provider}>
      <span className="sr-only" aria-live="polite" data-key-status="">
        {announced}
      </span>
      <div className="kb">
        {body}
        {note}
      </div>
    </div>
  );
}

function KeysSection({ keys }: { keys: KeyView[] }) {
  return (
    <section className="box" aria-labelledby="usage-keys">
      <h3 id="usage-keys">API keys</h3>
      {API_KEY_PROVIDERS.map((provider) => (
        <KeyRow
          key={provider}
          provider={provider}
          stored={keys.find((k) => k.provider === provider)}
        />
      ))}
    </section>
  );
}

export function UsagePage({ now: given }: { now?: number } = {}) {
  const usage = useWeeklyUsage();
  // The time the reset is counted from: when the reading was taken.
  const now = given ?? (usage.dataUpdatedAt || 0);
  return (
    <PageFrame title="Usage and API keys" narrow>
      <div className="ustack">
        {usage.data ? (
          <>
            <UsageTop reading={usage.data} now={now} />
            <RecentRuns />
            <BillingSection billing={usage.data.billing} keys={usage.data.keys} />
            <KeysSection keys={usage.data.keys} />
          </>
        ) : usage.isError ? (
          <p className="ferr" role="alert">
            Couldn&apos;t load your usage. Reload to try again.
          </p>
        ) : (
          <p className="page-empty" role="status" aria-label="Loading" aria-busy="true" />
        )}
      </div>
    </PageFrame>
  );
}
