import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { ArrowRight, FilePen, LoaderCircle, MoreHorizontal } from "lucide-react";
import type { AgentAdapterMetadata, ResearchImageAttachment } from "../../types";
import { LauncherSelect, OptionIcon, type LauncherSelectOption } from "../LauncherSelect";
import { isComposerSubmitShortcut } from "../ComposerSubmitShortcut";
import { ResearchMenu, ResearchMenuItem } from "./ResearchMenu";
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
import { postFormatOf } from "../../lib/researchNodeTypes";
import { AskNoteSwitch, type AskMode } from "./AskNoteSwitch";
import { ResearchModelNameDialog } from "./ResearchModelNameDialog";
import { useComposerPopOpen } from "../../hooks/useComposerPopOpen";
import { RESEARCH_NOTE_IMAGE_ERROR, researchImageBlockReason } from "../../lib/researchImages";
import { ResearchImageStrip, useResearchImageInput } from "./ResearchImages";

const CLAUDE_RESEARCH_EFFORT_OPTIONS = CLAUDE_EFFORT_OPTIONS.map((option) => ({
  ...option,
  label: option.label.replace(/ effort$/i, ""),
}));

// The reasoning/effort levels an adapter's models support, or null for
// adapters without a reasoning-effort launch option. Every Claude model
// (Fable, Opus, Sonnet) shares one range, as does every Codex preset.
export function researchEffortOptionsFor(adapter: string): LauncherSelectOption[] | null {
  if (adapter === CLAUDE_ADAPTER_ID) {
    return CLAUDE_RESEARCH_EFFORT_OPTIONS;
  }
  if (adapter === CODEX_ADAPTER_ID) {
    // Every Codex preset offers the full range; for a custom model the CLI
    // rejects a level the model does not support.
    return CODEX_REASONING_OPTIONS;
  }
  return null;
}

export function askModeShowsAiControls(askMode: AskMode) {
  return askMode === "ai";
}

/** The Home ask box's placeholder and send button name for a mode. In Note
 * mode a body that is a single URL is saved as a link. */
export function askBoxCopy(
  askMode: AskMode,
  prompt: string,
  submitting: boolean,
  askPlaceholder: string,
): { placeholder: string; submitLabel: string } {
  if (askMode === "note") {
    return {
      placeholder: "Write a note, or paste a link to save",
      submitLabel: submitting ? "Saving…" : postFormatOf(prompt) === "link" ? "Save link" : "Save note",
    };
  }
  return {
    placeholder: askPlaceholder,
    submitLabel: submitting ? "Starting research…" : "Start research",
  };
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
  /** Opens Agent Setup on an agent instance (the selected agent's), or on
   * the first incomplete one when null. */
  onOpenAgentSettings: (instanceId: string | null) => void;
  /** A request to select an agent (when `adapterId` names a research-ready
   * one) and focus the question field, sent when Agent Setup returns here.
   * The text and other choices are kept, and nothing is submitted. */
  focusRequest?: ComposerFocusRequest | null;
  /** Called once a focus request has been applied. */
  onFocusRequestHandled?: (seq: number) => void;
  onCreate: (input: {
    prompt: string;
    adapter: string;
    model: string | null;
    effort: string | null;
    workspaceId: string | null;
    images: ResearchImageAttachment[];
  }) => Promise<void>;
  /** Note mode: saves a note (a post node). The selected agent and model are
   * stored as the default for the note's AI follow-ups. */
  onPost: (input: {
    body: string;
    adapter: string;
    model: string | null;
    effort: string | null;
    workspaceId: string | null;
  }) => Promise<void>;
  /** Save draft: keeps the question and its images in Drafts and clears
   * them; the agent, model, and effort choice stays. */
  onSaveDraft?: (prompt: string, images: ResearchImageAttachment[]) => Promise<void>;
  placeholder?: string;
  /** Filled with an accessor for the selected agent, model, and effort, so a draft
   * sent from Drafts launches with the composer's current choice. */
  launchChoiceRef?: MutableRefObject<(() => ResearchLaunchChoice | null) | null>;
}

export interface ComposerFocusRequest {
  seq: number;
  adapterId: string | null;
}

export interface ResearchLaunchChoice {
  adapter: string;
  model: string | null;
  effort: string | null;
}

/** The Home ask box's session draft: the question text, its images, and the
 * agent, model, and effort choice. `effortChoice` and `images` are absent in
 * drafts stored before they were kept. */
interface HomeComposerDraft {
  prompt: string;
  adapter: string;
  modelChoice: string | null;
  customModel: string;
  effortChoice?: string;
  images?: ResearchImageAttachment[];
}

/** The ask box after a focus request from Agent Setup: the requested agent
 * when it can launch research, and otherwise the draft unchanged. The
 * question text and the model, custom model and effort choices are kept;
 * a choice that does not apply to the new agent falls back to that agent's
 * default when the box resolves what to launch. */
export function applyComposerFocusRequest(
  draft: HomeComposerDraft,
  request: ComposerFocusRequest,
  adapters: readonly AgentAdapterMetadata[],
): HomeComposerDraft {
  if (!request.adapterId || request.adapterId === draft.adapter) return draft;
  const candidate = adapters.find((adapter) => adapter.id === request.adapterId);
  return candidate && adapterCanLaunchResearch(candidate)
    ? { ...draft, adapter: candidate.id }
    : draft;
}

/** The draft to store for the Home ask box, or null when it matches a fresh
 * box (no text, the default agent, and no model or effort choice). A send or
 * Save draft clears only the text, so a non-default choice stays stored and
 * the next ask, including one made after the box remounts, uses it. */
export function homeComposerDraftToStore(
  draft: HomeComposerDraft,
  defaultAdapter: string,
): HomeComposerDraft | null {
  const empty =
    !draft.prompt &&
    !draft.images?.length &&
    !draft.modelChoice &&
    !draft.customModel &&
    !draft.effortChoice &&
    draft.adapter === defaultAdapter;
  return empty ? null : draft;
}

/** The feed's composer: a one-line "Ask a question" field that grows when it
 * has focus or text and then shows a row under it with the Ask/Note switch
 * and the send button. Once there is text, a … button before Send opens a
 * menu with Save draft. */
export default function ResearchQueryComposer({
  adapters: allAdapters,
  requireCmdEnterToSend,
  workspaceId,
  onOpenAgentSettings,
  focusRequest = null,
  onFocusRequestHandled,
  onCreate,
  onPost,
  onSaveDraft,
  placeholder = "Ask a question",
  launchChoiceRef,
}: ResearchQueryComposerProps) {
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<ResearchImageAttachment[]>([]);
  // Recipient choice is not persisted with the rest of the draft; every new
  // composer opens on Ask.
  const [askMode, setAskMode] = useState<AskMode>("ai");
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The field stays expanded while focus is inside the composer or its model
  // menu (a portal), and collapses on a click elsewhere once it is empty.
  const { focused, collapseIfFocusLeft, rootProps } = useComposerPopOpen(rootRef, insideComposer);
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
  // The agent a focus request selected. The backend copy of the draft, which
  // can arrive after the request, keeps its text but not its agent.
  const requestedAdapterRef = useRef<string | null>(null);

  useEffect(() => {
    sessionDraftTouchedRef.current = false;
    const restored = readSessionDraftJson<HomeComposerDraft>(draftKey);
    setPrompt(restored?.prompt ?? "");
    setImages(restored?.images ?? []);
    setModelChoice(restored?.modelChoice ?? null);
    setCustomModel(restored?.customModel ?? "");
    setEffortChoice(restored?.effortChoice ?? "");
    setError(null);
    setAdapter(
      preferredResearchAdapter(adapters, restored?.adapter)?.id ??
        adapters.find((candidate) => candidate.default)?.id ??
        adapters[0]?.id ??
        "",
    );
    let disposed = false;
    void loadSessionDraftJson<HomeComposerDraft>(draftKey)
      .then((backendDraft) => {
        if (!disposed && backendDraft && !sessionDraftTouchedRef.current) {
          setPrompt(backendDraft.prompt);
          setImages(backendDraft.images ?? []);
          setAdapter(requestedAdapterRef.current ?? backendDraft.adapter);
          setModelChoice(backendDraft.modelChoice);
          setCustomModel(backendDraft.customModel);
          setEffortChoice(backendDraft.effortChoice ?? "");
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

  // Apply Agent Setup's selection after restoring the draft so it overrides
  // the stored agent. Clear the request through onFocusRequestHandled, then
  // wait one frame for the dialog to unmount before focusing the composer.
  const focusRequestSeq = focusRequest?.seq ?? null;
  useEffect(() => {
    if (!focusRequest) return;
    const next = applyComposerFocusRequest(
      { prompt, adapter, modelChoice, customModel, effortChoice, images },
      focusRequest,
      adapters,
    );
    if (next.adapter !== adapter) {
      requestedAdapterRef.current = next.adapter;
      setAdapter(next.adapter);
      setError(null);
    }
    // Starting research with an agent asks a question, not a note.
    if (focusRequest.adapterId) setAskMode("ai");
    onFocusRequestHandled?.(focusRequest.seq);
    window.requestAnimationFrame(() => promptRef.current?.focus());
    // Runs once per request.
  }, [focusRequestSeq]);

  const defaultAdapter = preferredResearchAdapter(adapters)?.id ?? "";
  // Runs from the effect below on each change, and directly after a send or
  // Save draft so the choice is stored even when the send unmounts the box
  // before the effect runs.
  function storeDraft(nextPrompt: string, nextImages: ResearchImageAttachment[]) {
    const draft = homeComposerDraftToStore(
      {
        prompt: nextPrompt,
        adapter,
        modelChoice,
        customModel,
        effortChoice,
        ...(nextImages.length > 0 ? { images: nextImages } : {}),
      },
      defaultAdapter,
    );
    if (draft) {
      saveSessionDraftJson(draftKey, draft);
    } else {
      clearSessionDraft(draftKey);
    }
  }
  useEffect(() => {
    if (sessionDraftReady) {
      storeDraft(prompt, images);
    }
    // storeDraft reads the same state listed here.
  }, [
    adapter,
    customModel,
    defaultAdapter,
    draftKey,
    effortChoice,
    images,
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
  const expanded = focused || Boolean(prompt) || images.length > 0;
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
  const effortOptions = researchEffortOptionsFor(adapter);
  const selectedEffort =
    effortOptions && effortOptions.some((option) => option.value === effortChoice)
      ? effortChoice
      : "";
  const resolvedEffort = selectedEffort || null;

  const imageInput = useResearchImageInput({
    images,
    onImagesChange: (update) => {
      sessionDraftTouchedRef.current = true;
      setImages((current) => update(current));
    },
    disabled: submitting,
    dropTarget: rootRef,
  });
  // A note keeps no images, and an agent that can't read them never gets
  // the question without them.
  const imageBlock =
    images.length === 0
      ? null
      : askMode === "note"
        ? RESEARCH_NOTE_IMAGE_ERROR
        : researchImageBlockReason(adapter, selectedAdapter?.label, images);
  const imageProblem = imageInput.error ?? imageBlock;
  const imageProblemId = useId();

  // A note never launches an agent, so saving one needs no ready adapter.
  const canSubmit =
    Boolean(prompt.trim()) &&
    !submitting &&
    imageInput.saving === 0 &&
    !imageBlock &&
    (askMode === "note" || (Boolean(adapter) && adapterReady));

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
      if (askMode === "note") {
        await onPost({
          body: prompt.trim(),
          adapter,
          model: resolvedModel,
          effort: resolvedEffort,
          workspaceId,
        });
      } else {
        await onCreate({
          prompt: prompt.trim(),
          adapter,
          model: resolvedModel,
          effort: resolvedEffort,
          workspaceId,
          images,
        });
      }
      // A successful launch opens its research page, and a note appears at the
      // top of the feed. Clear the text and images; the agent, model, and
      // effort stay selected for the next ask.
      setPrompt("");
      setImages([]);
      setError(null);
      storeDraft("", []);
    } catch (err) {
      // Surfaced here, where the user is looking, with every field intact for
      // the retry.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
    window.requestAnimationFrame(collapseIfFocusLeft);
  }

  const { placeholder: shownPlaceholder, submitLabel } = askBoxCopy(
    askMode,
    prompt,
    submitting,
    placeholder,
  );
  const sendShortcut = requireCmdEnterToSend ? "⌘↵" : "↵";

  // The selected agent's Custom option shows the model name it launches with.
  const customModelName = customModel.trim();
  const modelOptions = useMemo(
    () =>
      researchModelOptions(adapters).map((option) =>
        customModelName && option.value === researchModelChoiceValue(adapter, CUSTOM_MODEL)
          ? { ...option, detail: customModelName }
          : option,
      ),
    [adapter, adapters, customModelName],
  );
  // The agent whose Custom option was chosen, while its model name dialog is open.
  const [customModelAdapter, setCustomModelAdapter] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const askSegmentRef = useRef<HTMLButtonElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  // The model menu belongs to the expanded row in Ask; it never reopens by
  // itself after a collapse or a switch to Note.
  useEffect(() => {
    if (!expanded || askMode !== "ai") setMenuOpen(false);
  }, [askMode, expanded]);
  const askIcon = useMemo(
    () => ({
      value: adapter,
      label: selectedAdapter?.label ?? adapter,
      iconSrc: ADAPTER_ICON_BY_ID[adapter],
      iconClassName: adapterIconClassName(adapter),
    }),
    [adapter, selectedAdapter?.label],
  );
  const askModelName =
    selectedModel === CUSTOM_MODEL && customModel.trim()
      ? customModel.trim()
      : formatLauncherModelLabel(adapter, selectedModel);
  const askLabel = `Ask with ${selectedAdapter?.label ?? "an agent"} ${askModelName}`;

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

  const [savingDraft, setSavingDraft] = useState(false);
  // The … menu before Send (Save draft); it exists only while there is text.
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const canSaveDraft = Boolean(onSaveDraft) && Boolean(prompt.trim()) && imageInput.saving === 0;
  useEffect(() => {
    if (!canSaveDraft) setMoreAnchor(null);
  }, [canSaveDraft]);
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
      await onSaveDraft(text, images);
      setPrompt("");
      setImages([]);
      setError(null);
      storeDraft("", []);
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
      {...rootProps}
      {...imageInput.fieldProps}
    >
      <form
        className={`new-research-launcher${menuOpen ? " is-menu-open" : ""}`}
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
        onMouseDown={(event) => {
          // A press on the box's padding or the row's empty space puts the
          // caret in the field, as in any text box.
          if (event.target === event.currentTarget || event.target === rowRef.current) {
            event.preventDefault();
            promptRef.current?.focus();
          }
        }}
      >
        <ResearchImageStrip
          className="new-research-images"
          images={images}
          saving={imageInput.saving}
          onRemove={
            submitting
              ? undefined
              : (id) => {
                  imageInput.remove(id);
                  // The removed × had focus.
                  promptRef.current?.focus();
                }
          }
        />
        <textarea
          ref={promptRef}
          className="new-research-input"
          rows={1}
          value={prompt}
          placeholder={shownPlaceholder}
          aria-label="New question"
          aria-describedby={imageProblem ? imageProblemId : undefined}
          onChange={(event) => {
            sessionDraftTouchedRef.current = true;
            setPrompt(event.currentTarget.value);
            setError(null);
            imageInput.clearError();
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
        {expanded ? (
          <div ref={rowRef} className="new-research-row">
            {/* Ask (the agent's icon) and Note side by side; the selected Ask
                segment opens the model menu. Send ends the row. */}
            <AskNoteSwitch
              askMode={askMode}
              askIcon={<OptionIcon option={askIcon} />}
              askLabel={askLabel}
              noteLabel="Save as note"
              menuOpen={menuOpen}
              askRef={askSegmentRef}
              onModeChange={(mode) => {
                setAskMode(mode);
                setError(null);
              }}
              onMenuOpenChange={setMenuOpen}
            />
            <LauncherSelect
              anchorRef={askSegmentRef}
              open={menuOpen && askModeShowsAiControls(askMode)}
              onOpenChange={setMenuOpen}
              value={researchModelChoiceValue(adapter, selectedModel)}
              options={modelOptions}
              ariaLabel="Model"
              onChange={(choice) => {
                const next = parseResearchModelChoice(choice);
                // Custom asks for the model name first; Cancel keeps the
                // current choice.
                if (next.preset === CUSTOM_MODEL) {
                  setCustomModelAdapter(next.adapter);
                  return;
                }
                sessionDraftTouchedRef.current = true;
                setError(null);
                setAdapter(next.adapter);
                setModelChoice(next.preset || null);
              }}
              onReselect={(choice) => {
                const next = parseResearchModelChoice(choice);
                if (next.preset === CUSTOM_MODEL) setCustomModelAdapter(next.adapter);
              }}
              submenu={
                effortOptions
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
            {canSaveDraft ? (
              <button
                type="button"
                className="control-button new-research-more"
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={moreAnchor !== null}
                title="More actions"
                onClick={(event) => {
                  // WebKit does not focus a clicked button; focus it so the
                  // menu returns focus here.
                  const trigger = event.currentTarget;
                  trigger.focus();
                  setMoreAnchor((current) => (current ? null : trigger));
                }}
              >
                <MoreHorizontal size={15} aria-hidden="true" />
              </button>
            ) : null}
            {/* The send button, as in a conversation's ask box: an arrow with
                no label or shortcut text; the tooltip names the action. */}
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
                <ArrowRight size={15} aria-hidden="true" />
              )}
            </button>
          </div>
        ) : null}
        {setupNeeded || error || imageProblem ? (
          <div className="new-research-footer">
            {imageProblem ? (
              <p id={imageProblemId} className="new-research-error" role="alert">
                {imageProblem}
              </p>
            ) : null}
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
                onClick={() => onOpenAgentSettings(selectedAdapter?.instanceId ?? null)}
              >
                Review agents
              </button>
            ) : null}
          </div>
        ) : null}
      </form>
      {customModelAdapter ? (
        <ResearchModelNameDialog
          agentLabel={adapters.find((candidate) => candidate.id === customModelAdapter)?.label ?? customModelAdapter}
          initialName={customModel}
          onClose={() => setCustomModelAdapter(null)}
          onSubmit={(name) => {
            sessionDraftTouchedRef.current = true;
            setError(null);
            setAdapter(customModelAdapter);
            setModelChoice(CUSTOM_MODEL);
            setCustomModel(name);
            setCustomModelAdapter(null);
          }}
        />
      ) : null}
      {moreAnchor ? (
        <ResearchMenu anchor={moreAnchor} label="Question actions" onClose={() => setMoreAnchor(null)}>
          <ResearchMenuItem
            icon={<FilePen size={15} aria-hidden="true" />}
            label="Save draft"
            disabled={savingDraft}
            onSelect={() => {
              setMoreAnchor(null);
              void saveDraft();
            }}
          />
        </ResearchMenu>
      ) : null}
    </div>
  );
}

/** Focus inside the composer or one of its menus (rendered in portals). The
 * note follow-up box, which shares the model menu, uses it too. */
export function insideComposer(root: HTMLElement | null, target: EventTarget | null) {
  if (!(target instanceof Node)) return false;
  if (root?.contains(target)) return true;
  return target instanceof Element && Boolean(target.closest(".launcher-select-popover, .research-menu, .research-model-dialog"));
}
