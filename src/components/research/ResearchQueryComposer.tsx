import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { ArrowUp, LoaderCircle, Users } from "lucide-react";
import type { AgentAdapterMetadata } from "../../types";
import { LauncherSelect, type LauncherSelectOption } from "../LauncherSelect";
import { isComposerSubmitShortcut } from "../ComposerSubmitShortcut";
import { ADAPTER_ICON_BY_ID, adapterIconClassName } from "../../lib/adapterIcons";
import { CLAUDE_ADAPTER_ID, CLAUDE_EFFORT_OPTIONS } from "../../adapters/claude";
import { CODEX_ADAPTER_ID, CODEX_REASONING_OPTIONS } from "../../adapters/codex";
import {
  clearSessionDraft,
  loadSessionDraftJson,
  readSessionDraftJson,
  saveSessionDraftJson,
  SESSION_DRAFT_KEYS,
} from "../../lib/sessionDrafts";
import {
  CUSTOM_MODEL,
  formatLauncherModelLabel,
  modelPresetsFor,
  nextModelPreset,
  selectedModelPreset,
} from "../../lib/launcherModels";
import { launcherTabAction } from "../../lib/launcherKeyboard";
import {
  adapterCanLaunchResearch,
  adapterReadinessMessage,
  preferredResearchAdapter,
  researchReadyAdaptersFirst,
  researchReadinessLabel,
} from "../../lib/adapterReadiness";
import { noteBodyIsSingleUrl } from "./ResearchNote";

// GPT-5.4 stops at extra high; every other Codex preset (and a custom model,
// whose ceiling is unknown here) offers the full range and lets the CLI
// reject a level the model does not support.
const GPT_5_4_REASONING_LEVELS = ["", "low", "medium", "high", "xhigh"];

const CLAUDE_RESEARCH_EFFORT_OPTIONS = CLAUDE_EFFORT_OPTIONS.map((option) => ({
  ...option,
  label: option.label.replace(/ effort$/i, ""),
}));

// The reasoning/effort levels the selected model supports, or null for
// adapters without a reasoning-effort launch option. Every Claude model
// (Fable, Opus, Sonnet) shares one range; Codex ranges vary by model.
export function researchEffortOptionsFor(
  adapter: string,
  model: string,
): LauncherSelectOption[] | null {
  if (adapter === CLAUDE_ADAPTER_ID) {
    return CLAUDE_RESEARCH_EFFORT_OPTIONS;
  }
  if (adapter === CODEX_ADAPTER_ID) {
    if (model === "gpt-5.4") {
      return CODEX_REASONING_OPTIONS.filter((option) =>
        GPT_5_4_REASONING_LEVELS.includes(option.value),
      );
    }
    return CODEX_REASONING_OPTIONS;
  }
  return null;
}

/** Who a question goes to: an agent ("ai"), or the network, which posts a
 * note to Home (network delivery itself is not built yet); a body that is a
 * single URL is saved as a link or post instead of asked. The recipient is
 * the last choice of the model picker. */
type AskMode = "network" | "ai";

const NETWORK_CHOICE = "network";

export function askModeShowsAiControls(askMode: AskMode) {
  return askMode === "ai";
}

/* The Ask picker lists every agent's models in one menu, so each option's
   value carries both. Adapter ids contain no ":", so the first one splits. */
export function researchModelChoiceValue(adapterId: string, preset: string) {
  return `${adapterId}:${preset}`;
}

export function parseResearchModelChoice(value: string) {
  const separator = value.indexOf(":");
  return separator === -1
    ? { adapter: value, preset: "" }
    : { adapter: value.slice(0, separator), preset: value.slice(separator + 1) };
}

/** One option per model preset of each research-ready agent, grouped by agent
 * and marked with its icon; an agent that cannot run research yet is a single
 * disabled row naming why. */
export function researchModelOptions(adapters: AgentAdapterMetadata[]): LauncherSelectOption[] {
  return adapters.flatMap((candidate, adapterIndex) => {
    const icon = {
      iconSrc: ADAPTER_ICON_BY_ID[candidate.id],
      iconClassName: adapterIconClassName(candidate.id),
    };
    if (!adapterCanLaunchResearch(candidate)) {
      return [
        {
          value: researchModelChoiceValue(candidate.id, ""),
          label: candidate.label,
          ...icon,
          detail: researchReadinessLabel(candidate),
          disabled: true,
          dividerBefore: adapterIndex > 0,
        },
      ];
    }
    return modelPresetsFor(candidate.id).map((preset, presetIndex) => ({
      value: researchModelChoiceValue(candidate.id, preset),
      label: formatLauncherModelLabel(candidate.id, preset),
      ...icon,
      dividerBefore: adapterIndex > 0 && presetIndex === 0,
    }));
  });
}

interface ResearchQueryComposerProps {
  adapters: AgentAdapterMetadata[];
  requireCmdEnterToSend: boolean;
  workspaceId: string | null;
  onOpenAgentSettings: () => void;
  onCreate: (input: {
    prompt: string;
    adapter: string;
    model: string | null;
    effort: string | null;
    workspaceId: string | null;
  }) => Promise<void>;
  /** Post: creates a note. The selected agent and model are stored as
   * the default for the note's AI follow-ups. */
  onPost: (input: {
    body: string;
    adapter: string;
    model: string | null;
    effort: string | null;
    workspaceId: string | null;
    askNetwork: boolean;
  }) => Promise<void>;
  /** Save draft: keeps the question in Drafts and clears the field. */
  onSaveDraft?: (prompt: string) => Promise<void>;
  placeholder?: string;
  /** Filled with a reader of the selected agent, model, and effort, so a draft
   * sent from Drafts launches with the composer's current choice. */
  launchChoiceRef?: MutableRefObject<(() => ResearchLaunchChoice | null) | null>;
}

export interface ResearchLaunchChoice {
  adapter: string;
  model: string | null;
  effort: string | null;
}

/** The feed's composer: a one-line "Ask a question" field that grows when it
 * has focus or text and then shows the recipient and model controls, Save
 * draft, and the primary button. The ↵ glyph shows only while Enter (or ⌘↵)
 * would submit. */
export default function ResearchQueryComposer({
  adapters: allAdapters,
  requireCmdEnterToSend,
  workspaceId,
  onOpenAgentSettings,
  onCreate,
  onPost,
  onSaveDraft,
  placeholder = "Ask a question",
  launchChoiceRef,
}: ResearchQueryComposerProps) {
  const [prompt, setPrompt] = useState("");
  // Recipient choice is not persisted with the rest of the draft; every new
  // composer opens on Ask.
  const [askMode, setAskMode] = useState<AskMode>("ai");
  const [focused, setFocused] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [adapter, setAdapter] = useState("");
  const [modelChoice, setModelChoice] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState("");
  const [effortChoice, setEffortChoice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sessionDraftReady, setSessionDraftReady] = useState(false);
  const sessionDraftTouchedRef = useRef(false);
  const draftKey = SESSION_DRAFT_KEYS.newResearchInline;
  // Launch errors stay beside the Home composer so every field remains available
  // for a retry.
  const [error, setError] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  // General terminal-session fork support is intentionally wider than the
  // runtimes supported by research.
  const adapters = useMemo(
    () =>
      researchReadyAdaptersFirst(
        allAdapters.filter((candidate) => candidate.supportsResearch),
      ),
    [allAdapters],
  );
  const selectedAdapter = adapters.find((candidate) => candidate.id === adapter) ?? null;
  const adapterReady = adapterCanLaunchResearch(selectedAdapter);

  useEffect(() => {
    sessionDraftTouchedRef.current = false;
    const restored = readSessionDraftJson<{
      prompt: string;
      adapter: string;
      modelChoice: string | null;
      customModel: string;
    }>(draftKey);
    setPrompt(restored?.prompt ?? "");
    setModelChoice(restored?.modelChoice ?? null);
    setCustomModel(restored?.customModel ?? "");
    setEffortChoice("");
    setError(null);
    setAdapter(
      preferredResearchAdapter(adapters, restored?.adapter)?.id ??
        adapters.find((candidate) => candidate.default)?.id ??
        adapters[0]?.id ??
        "",
    );
    let disposed = false;
    void loadSessionDraftJson<{
      prompt: string;
      adapter: string;
      modelChoice: string | null;
      customModel: string;
    }>(draftKey)
      .then((backendDraft) => {
        if (!disposed && backendDraft && !sessionDraftTouchedRef.current) {
          setPrompt(backendDraft.prompt);
          setAdapter(backendDraft.adapter);
          setModelChoice(backendDraft.modelChoice);
          setCustomModel(backendDraft.customModel);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!disposed) {
          setSessionDraftReady(true);
        }
      });
    return () => {
      disposed = true;
    };
  }, [draftKey]);

  useEffect(() => {
    if (!sessionDraftReady) {
      return;
    }
    if (!prompt && !modelChoice && !customModel) {
      clearSessionDraft(draftKey);
      return;
    }
    saveSessionDraftJson(draftKey, { prompt, adapter, modelChoice, customModel });
  }, [
    adapter,
    customModel,
    draftKey,
    modelChoice,
    prompt,
    sessionDraftReady,
  ]);

  useEffect(() => {
    if (
      adapterCanLaunchResearch(adapters.find((candidate) => candidate.id === adapter))
    ) {
      return;
    }
    setAdapter(
      preferredResearchAdapter(adapters)?.id ??
        adapters[0]?.id ??
        "",
    );
  }, [adapter, adapters]);

  // Grow the textarea to fit the committed prompt value. Measuring directly in
  // onChange can catch WebKit between its native edit and React restoring the
  // controlled value, briefly sizing the field for a different wrap count.
  // useLayoutEffect keeps the value and height in the same pre-paint commit.
  // An empty field drops the measured height, so it returns to one line (or
  // the expanded minimum) after a send or Save draft.
  const expanded = focused || Boolean(prompt);
  useLayoutEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "";
    if (!prompt) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [expanded, prompt]);

  // A stale choice (left over from another adapter) silently falls back to the
  // adapter's first preset, so the trigger always shows what will launch.
  const selectedModel = selectedModelPreset(adapter, modelChoice);
  const resolvedModel =
    selectedModel === CUSTOM_MODEL ? customModel.trim() || null : selectedModel;
  // Same stale-choice contract as the model picker: a level left over from
  // another adapter or model silently falls back to the default, so the
  // trigger always shows what will launch.
  const effortOptions = researchEffortOptionsFor(adapter, selectedModel);
  const selectedEffort =
    effortOptions && effortOptions.some((option) => option.value === effortChoice)
      ? effortChoice
      : "";
  const resolvedEffort = selectedEffort || null;

  // A note never launches an agent, so posting one needs no ready adapter.
  const canSubmit =
    Boolean(prompt.trim()) &&
    !submitting &&
    (askMode === "network" || (Boolean(adapter) && adapterReady));

  async function submit() {
    if (!prompt.trim()) {
      promptRef.current?.focus();
      return;
    }
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (askMode === "network") {
        const body = prompt.trim();
        await onPost({
          body,
          adapter,
          model: resolvedModel,
          effort: resolvedEffort,
          workspaceId,
          askNetwork: !noteBodyIsSingleUrl(body),
        });
      } else {
        await onCreate({
          prompt: prompt.trim(),
          adapter,
          model: resolvedModel,
          effort: resolvedEffort,
          workspaceId,
        });
      }
      // A successful launch opens its research page, and a note appears at the
      // top of the feed. Clear the Home composer so the next draft starts fresh.
      setPrompt("");
      setModelChoice(null);
      setCustomModel("");
      setError(null);
      clearSessionDraft(draftKey);
    } catch (err) {
      // Surfaced here, where the user is looking, with every field intact for
      // the retry.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
    window.requestAnimationFrame(collapseIfFocusLeft);
  }

  const submitLabel =
    askMode === "network"
      ? submitting
        ? "Posting…"
        : noteBodyIsSingleUrl(prompt)
          ? "Save link"
          : "Post to network"
      : submitting
        ? "Starting research…"
        : "Start research";
  const sendShortcut = requireCmdEnterToSend ? "⌘↵" : "↵";

  const modelOptions = useMemo(
    () => [
      ...researchModelOptions(adapters),
      {
        value: NETWORK_CHOICE,
        label: "Post to network",
        icon: <Users size={14} />,
        dividerBefore: true,
      },
    ],
    [adapters],
  );

  function cycleAdapter() {
    const readyAdapters = adapters.filter(adapterCanLaunchResearch);
    if (readyAdapters.length === 0) {
      return;
    }
    const currentIndex = readyAdapters.findIndex((candidate) => candidate.id === adapter);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % readyAdapters.length;
    const nextAdapter = readyAdapters[nextIndex]?.id;
    if (nextAdapter && nextAdapter !== adapter) {
      sessionDraftTouchedRef.current = true;
      setAdapter(nextAdapter);
    }
    window.requestAnimationFrame(() => promptRef.current?.focus());
  }

  function cycleModel() {
    sessionDraftTouchedRef.current = true;
    setModelChoice(nextModelPreset(adapter, selectedModel));
    window.requestAnimationFrame(() => promptRef.current?.focus());
  }

  const launchReady = Boolean(adapter) && adapterReady;
  useEffect(() => {
    if (!launchChoiceRef) return;
    launchChoiceRef.current = () =>
      launchReady ? { adapter, model: resolvedModel, effort: resolvedEffort } : null;
    return () => {
      launchChoiceRef.current = null;
    };
  }, [adapter, launchChoiceRef, launchReady, resolvedEffort, resolvedModel]);

  // The field stays expanded while focus is inside the composer or its model
  // menu (a portal), and collapses on a click elsewhere once it is empty. A
  // collapse waits for the click to finish, so the list below doesn't move
  // between the press and the release that opens what was pressed.
  const pointerDownOutsideRef = useRef(false);
  // Set from a press inside the composer until it is released. WebKit does
  // not focus a clicked button, so pressing the model picker blurs the field
  // with no related target; collapsing then would remove the picker before
  // its click event fires. Such a blur keeps the composer open, and the next press
  // outside it collapses it.
  const pointerDownInsideRef = useRef(false);
  const collapse = () => {
    if (!pointerDownOutsideRef.current) {
      setFocused(false);
      return;
    }
    window.addEventListener(
      "pointerup",
      () => {
        pointerDownOutsideRef.current = false;
        window.setTimeout(() => setFocused(false), 0);
      },
      { once: true },
    );
  };
  // Ask and Save draft are disabled while they work, and a focused button
  // that becomes disabled loses focus without a blur event; once focus has
  // left the composer this way, it collapses as after a click elsewhere.
  const collapseIfFocusLeft = () => {
    if (!insideComposer(rootRef.current, document.activeElement)) setFocused(false);
  };
  useEffect(() => {
    if (!focused) return;
    const onPointerDown = (event: PointerEvent) => {
      if (insideComposer(rootRef.current, event.target)) return;
      pointerDownOutsideRef.current = true;
      collapse();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [focused]);

  const [savingDraft, setSavingDraft] = useState(false);
  async function saveDraft() {
    const text = prompt.trim();
    if (!onSaveDraft || savingDraft) return;
    if (!text) {
      setError("Write a question first.");
      promptRef.current?.focus();
      return;
    }
    setSavingDraft(true);
    try {
      await onSaveDraft(text);
      setPrompt("");
      setModelChoice(null);
      setCustomModel("");
      setError(null);
      clearSessionDraft(draftKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingDraft(false);
    }
    window.requestAnimationFrame(collapseIfFocusLeft);
  }

  const setupNeeded = !adapters.some(adapterCanLaunchResearch);

  return (
    <div
      ref={rootRef}
      className="new-research-composer"
      onFocus={() => setFocused(true)}
      onPointerDownCapture={() => {
        pointerDownInsideRef.current = true;
        const release = () => window.setTimeout(() => (pointerDownInsideRef.current = false), 0);
        window.addEventListener("pointerup", release, { once: true });
        window.addEventListener("pointercancel", release, { once: true });
      }}
      onBlur={(event) => {
        if (insideComposer(rootRef.current, event.relatedTarget)) return;
        if (pointerDownInsideRef.current && !event.relatedTarget) return;
        collapse();
      }}
    >
      <form
        className="new-research-launcher"
        aria-label="New research"
        onKeyDown={(event) => {
          // Plain Tab moves focus; ⌃Tab cycles the model and ⌃⇧Tab the agent.
          const aiControlsVisible = askModeShowsAiControls(askMode);
          const requestedTabAction = launcherTabAction(event, aiControlsVisible);
          const tabAction =
            !aiControlsVisible && requestedTabAction === "cycle-provider"
              ? "capture"
              : requestedTabAction;
          if (tabAction) {
            event.preventDefault();
            event.stopPropagation();
            if (tabAction === "cycle-provider") {
              cycleAdapter();
            } else if (tabAction === "cycle-model") {
              cycleModel();
            }
            return;
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="new-research-main">
          <textarea
            ref={promptRef}
            className="new-research-input"
            rows={1}
            value={prompt}
            placeholder={
              askMode === "network" ? "Ask your network, or paste a link to save" : placeholder
            }
            aria-label="New question"
            onChange={(event) => {
              sessionDraftTouchedRef.current = true;
              setPrompt(event.currentTarget.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              // Esc leaves the field, which collapses again when it is empty.
              if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.blur();
                return;
              }
              // Enter in an empty field does nothing; Shift+Enter adds a line.
              if (event.key === "Enter" && !event.shiftKey && !prompt.trim()) {
                event.preventDefault();
                return;
              }
              if (isComposerSubmitShortcut(event, requireCmdEnterToSend)) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          {/* The send button, as in a conversation's ask box: an arrow with no
              label or shortcut text; the tooltip names the action. */}
          <button
            type="submit"
            className="control-button research-composer-send"
            disabled={!canSubmit}
            aria-label={submitLabel}
            title={`${submitLabel} (${sendShortcut})`}
          >
            {submitting ? (
              <LoaderCircle className="research-spinner" size={15} aria-hidden="true" />
            ) : (
              <ArrowUp size={15} aria-hidden="true" />
            )}
          </button>
        </div>
        {expanded && askModeShowsAiControls(askMode) && selectedModel === CUSTOM_MODEL ? (
          <input
            className="new-research-custom-model"
            type="text"
            value={customModel}
            placeholder="Model name"
            aria-label="Custom model"
            onChange={(event) => {
              sessionDraftTouchedRef.current = true;
              setCustomModel(event.currentTarget.value);
            }}
          />
        ) : null}
        {expanded ? (
          <div className="new-research-row">
            {/* One picker for the recipient, agent, and model; the trigger shows
                only the agent's icon and names the model in its tooltip. The
                row stays one line at every feed width. */}
            <div className="new-research-model-controls">
              <LauncherSelect
                iconOnly
                value={
                  askMode === "network"
                    ? NETWORK_CHOICE
                    : researchModelChoiceValue(adapter, selectedModel)
                }
                options={modelOptions}
                ariaLabel="Recipient and model"
                onChange={(choice) => {
                  sessionDraftTouchedRef.current = true;
                  setError(null);
                  if (choice === NETWORK_CHOICE) {
                    setAskMode("network");
                    return;
                  }
                  const next = parseResearchModelChoice(choice);
                  setAskMode("ai");
                  setAdapter(next.adapter);
                  setModelChoice(next.preset || null);
                }}
                submenu={
                  effortOptions && askModeShowsAiControls(askMode)
                    ? {
                        label: "Effort",
                        ariaLabel: "Effort",
                        value: selectedEffort,
                        options: effortOptions,
                        onChange: setEffortChoice,
                      }
                    : undefined
                }
              />
            </div>
          </div>
        ) : null}
        {setupNeeded || error ? (
          <div className="new-research-footer">
            {setupNeeded ? (
              <p className="new-research-unavailable" role="alert">
                {selectedAdapter
                  ? adapterReadinessMessage(selectedAdapter)
                  : "No supported research agent is available."}
              </p>
            ) : null}
            {error ? (
              <p className="new-research-error" role="alert">
                {error}
              </p>
            ) : null}
            {setupNeeded ? (
              <button
                type="button"
                className="control-button new-research-setup-button"
                onClick={onOpenAgentSettings}
              >
                Review agents
              </button>
            ) : null}
          </div>
        ) : null}
      </form>
      {/* Save draft sits under the box once there is text to save. */}
      {onSaveDraft && prompt.trim() ? (
        <div className="new-research-after">
          <button
            type="button"
            className="research-feed-button is-ghost"
            disabled={savingDraft}
            onClick={() => void saveDraft()}
          >
            Save draft
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Focus inside the composer or its model menu (rendered in a portal). */
function insideComposer(root: HTMLElement | null, target: EventTarget | null) {
  if (!(target instanceof Node)) return false;
  if (root?.contains(target)) return true;
  return target instanceof Element && Boolean(target.closest(".launcher-select-popover"));
}
