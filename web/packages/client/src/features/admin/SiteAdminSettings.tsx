// The Site Admin settings (02 W8.2; 03 K15, decision P11; the mock's
// `adminPage`): the default model and the default effort, on which every
// member's composer starts. The model group lists the registry models
// payable with included tokens; key-only models are not listed. The effort
// group is Low, Medium, High and Max, none disabled. No prices, no model
// descriptions, no availability switches and no per-member overrides.
//
// Online-only through TanStack Query (`models.list`,
// `admin.models.setDefault`, `admin.models.setDefaultEffort`). A change shows
// the choice at once; a refused write restores the previous choice and shows
// the error under its group. Either way `models.list` is refetched.

import { SITE_EFFORTS, type SiteEffort } from "@session/shared";
import { useState } from "react";

import { useModels, useSetDefaultEffort, useSetDefaultModel } from "../../api/account.js";
import { refusalMessage } from "../../lib/toast.js";
import { effortLabel } from "../../replica/online.js";
import { showToast } from "../shell/Toast.js";

const PROVIDER_NAME: Record<string, string> = {
  vertex: "Google",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
};

function ChoiceRow({
  name,
  value,
  label,
  sub,
  checked,
  onChoose,
}: {
  name: string;
  value: string;
  label: string;
  sub?: string;
  checked: boolean;
  onChoose: (value: string) => void;
}) {
  return (
    <label className={checked ? "amrow on" : "amrow"}>
      <span className="radio">
        <input
          type="radio"
          name={name}
          value={value}
          checked={checked}
          onChange={() => onChoose(value)}
        />{" "}
        <span>
          <b>
            {label}
            {sub ? (
              <>
                {" "}
                <small>{sub}</small>
              </>
            ) : null}
          </b>
        </span>
      </span>
    </label>
  );
}

export function SiteAdminSettings() {
  const models = useModels();
  const setModel = useSetDefaultModel();
  const setEffort = useSetDefaultEffort();
  // The choice being written, shown until `models.list` answers again.
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [pendingEffort, setPendingEffort] = useState<SiteEffort | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [effortError, setEffortError] = useState<string | null>(null);

  if (!models.data) {
    return models.isError ? (
      <p className="ferr" role="alert">
        Couldn&apos;t load the settings. Reload to try again.
      </p>
    ) : (
      <p className="page-empty" role="status" aria-label="Loading" aria-busy="true" />
    );
  }
  const listing = models.data;
  const included = listing.models.filter((m) => m.payers.includes("included"));
  const currentModel = pendingModel ?? listing.defaultModel;
  const currentEffort = pendingEffort ?? listing.defaultEffort;

  const chooseModel = (id: string) => {
    if (id === currentModel) return;
    const label = included.find((m) => m.id === id)?.label ?? id;
    setModelError(null);
    setPendingModel(id);
    setModel.mutate(id, {
      onSuccess: () => showToast(`Default model set to ${label}.`),
      onError: (error) => setModelError(refusalMessage(error)),
      onSettled: () => setPendingModel(null),
    });
  };

  const chooseEffort = (value: string) => {
    const effort = value as SiteEffort;
    if (effort === currentEffort) return;
    setEffortError(null);
    setPendingEffort(effort);
    setEffort.mutate(effort, {
      onSuccess: () => showToast(`Default effort set to ${effortLabel(effort)}.`),
      onError: (error) => setEffortError(refusalMessage(error)),
      onSettled: () => setPendingEffort(null),
    });
  };

  return (
    <>
      <section className="box adm" aria-labelledby="adm-model">
        <h3 id="adm-model">Default model</h3>
        <div className="amrows" role="radiogroup" aria-labelledby="adm-model">
          {included.map((m) => (
            <ChoiceRow
              key={m.id}
              name="default-model"
              value={m.id}
              label={m.label}
              sub={PROVIDER_NAME[m.provider] ?? m.provider}
              checked={m.id === currentModel}
              onChoose={chooseModel}
            />
          ))}
        </div>
        {modelError ? (
          <p className="ferr mt-2" role="alert">
            {modelError}
          </p>
        ) : null}
      </section>
      <section className="box adm" aria-labelledby="adm-effort">
        <h3 id="adm-effort">Default effort</h3>
        <div className="amrows" role="radiogroup" aria-labelledby="adm-effort">
          {SITE_EFFORTS.map((effort) => (
            <ChoiceRow
              key={effort}
              name="default-effort"
              value={effort}
              label={effortLabel(effort)}
              checked={effort === currentEffort}
              onChoose={chooseEffort}
            />
          ))}
        </div>
        {effortError ? (
          <p className="ferr mt-2" role="alert">
            {effortError}
          </p>
        ) : null}
      </section>
    </>
  );
}
