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
import { useRef, useState } from "react";

import {
  useModels,
  useRemoveApiKey,
  useSetApiKey,
  useSetBilling,
  useUsageRuns,
  useWeeklyUsage,
} from "../../api/account.js";
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

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
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
  return (
    <section className="box">
      <p className={`usent ${tone}`}>
        You have <b>{percent}%</b> of usage left this week. Next reset on {weekday}, in {resetIn}.
      </p>
      <div className={`utrack ${tone}`} role="img" aria-label={`${percent}% left`}>
        <span style={{ width: `${percent}%` }} />
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
  const choose = (mode: "pause" | "key") => {
    setError(null);
    setBilling.mutate(mode, {
      onSuccess: () =>
        showToast(
          mode === "key"
            ? "Asks will continue on your API key."
            : "Asks will pause until the reset.",
        ),
      onError: (refusal) => setError(errorMessage(refusal)),
    });
  };
  const keyHint = anthropic
    ? "Asks bill to your Anthropic key until the reset."
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
            checked={billing === "pause"}
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
            checked={billing === "key"}
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
  const inputId = `in-key-${provider}`;
  const errorId = `${inputId}-error`;

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
          showToast(`${info.name} key works.`);
        },
        onError: (refusal) => {
          // Nothing was saved: the form comes back with the text kept.
          setChecking(null);
          setForm(true);
          setError(errorMessage(refusal));
          requestAnimationFrame(() => input.current?.focus());
        },
      },
    );
  };

  const remove = () => {
    removeKey.mutate(provider, {
      onSuccess: () => {
        setConfirming(false);
        showToast(`${info.name} key removed.`);
      },
      onError: (refusal) => {
        setConfirming(false);
        showToast(errorMessage(refusal), { alert: true });
      },
    });
  };

  const name = <b className="kname">{info.name}</b>;
  const note = (
    <p className="knote">
      Asks on this key go to {info.name} directly and fall under your own agreement with {info.name}
      .
    </p>
  );

  let body;
  if (checking !== null) {
    body = (
      <div className="kstate">
        {name}
        <span className="kmask">
          {info.prefix}••••{checking}
        </span>
        <span className="chip kchip" role="status">
          Checking…
        </span>
      </div>
    );
  } else if (stored && confirming) {
    body = (
      <div className="kconfirm">
        <span>Remove the {info.name} key? Asks billed to it will stop.</span>
        <span className="grow" />
        <button ref={keep} type="button" className="btn2 sm" onClick={() => setConfirming(false)}>
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
          <button
            type="button"
            className="btn2 sm"
            onClick={() => {
              setForm(false);
              setError(null);
              setDraft("");
            }}
          >
            Cancel
          </button>
        </form>
        {error ? (
          <p id={errorId} className="ferr" role="alert">
            {error}
          </p>
        ) : null}
        {note}
      </div>
    );
  } else if (stored) {
    body = (
      <>
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
        {note}
      </>
    );
  } else {
    body = (
      <div className="kstate">
        {name}
        <small>Not set</small>
        <span className="grow" />
        <button type="button" className="btn2 sm" onClick={openForm}>
          Add key
        </button>
      </div>
    );
  }

  return (
    <div className="krow" data-key={provider}>
      <div className="kb">{body}</div>
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
