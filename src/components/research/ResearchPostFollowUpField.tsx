import { useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, Ref } from "react";
import { ArrowRight, LoaderCircle, Sparkles } from "lucide-react";
import type { AgentAdapterMetadata, ResearchImageAttachment, ResearchNode } from "../../types";
import { RESEARCH_NOTE_IMAGE_ERROR, researchImageBlockReason } from "../../lib/researchImages";
import { ResearchImageStrip, useResearchImageInput } from "./ResearchImages";
import { ComposerSubmitShortcutGlyph, isComposerSubmitShortcut } from "../ComposerSubmitShortcut";
import { growComposerTextarea } from "../../lib/composerTextarea";
import { AskNoteSwitch, type AskMode } from "./AskNoteSwitch";
import { useComposerPopOpen } from "../../hooks/useComposerPopOpen";
import type { ResearchComposerHandle } from "./ResearchConversationComposer";
import { OptionIcon } from "../LauncherSelect";
import { ADAPTER_ICON_BY_ID, adapterIconClassName } from "../../lib/adapterIcons";
import { formatLauncherModelLabel, modelPresetsFor } from "../../lib/launcherModels";
import { formatResearchModelSummary } from "../../lib/researchModelSummary";
import { researchReadyAdaptersFirst } from "../../lib/adapterReadiness";
import { followUpAdapter, nodeAgent } from "../../lib/researchNodeTypes";
import { insideComposer, type ResearchLaunchChoice } from "./ResearchQueryComposer";
import {
  ResearchQuestionModelPicker,
  researchQuestionChoiceFrom,
  researchQuestionLaunch,
  type ResearchQuestionChoice,
} from "./ResearchQuestionModelPicker";

const NO_ADAPTERS: AgentAdapterMetadata[] = [];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stopForInteractive(event: MouseEvent) {
  event.stopPropagation();
}

/** The follow-up box's placeholder and send button name and tooltip for a
 * mode. `askPlaceholder` and `askLabel` ("Ask {model}") apply in Ask. */
export function postFollowUpCopy(
  asNote: boolean,
  askPlaceholder: string,
  askLabel: string,
): { placeholder: string; sendName: string; sendTitle: string } {
  return asNote
    ? { placeholder: "Add a note (not sent to the agent)", sendName: "Add note", sendTitle: "Add note" }
    : { placeholder: askPlaceholder, sendName: "Ask", sendTitle: askLabel };
}

/** The agent, model and effort a note's AI follow-up runs on unless the
 * box's model menu chooses another, as the backend picks it: the note's
 * follow-up agent with its model and effort when that agent supports
 * research, else the default ready research agent with its default model
 * (`followUpAdapter`). Null when no agent can take it. */
export function postFollowUpDefault(
  post: ResearchNode,
  adapters: readonly AgentAdapterMetadata[],
): ResearchLaunchChoice | null {
  const adapter = followUpAdapter(post, adapters);
  if (!adapter) return null;
  const own = nodeAgent(post);
  return own?.adapter === adapter
    ? { adapter, model: own.model ?? null, effort: own.effort ?? null }
    : { adapter, model: null, effort: null };
}

/** What a note's follow-up box asks with. `chosen` is the box's model menu
 * choice, if one was made; a choice whose agent is no longer listed or ready
 * falls back to `fallback` (postFollowUpDefault). `shown` is the agent the
 * Ask segment shows, `agent` what the follow-up is sent with (null: the
 * backend's own pick), and `choice` the menu's selection. */
export function postFollowUpAsk(
  adapters: AgentAdapterMetadata[],
  fallback: ResearchLaunchChoice | null,
  chosen: ResearchQuestionChoice | null,
): {
  shown: ResearchLaunchChoice | null;
  agent: ResearchLaunchChoice | null;
  choice: ResearchQuestionChoice | null;
} {
  const agent = chosen ? researchQuestionLaunch(adapters, chosen) : null;
  if (agent && chosen) return { shown: agent, agent, choice: chosen };
  return { shown: fallback, agent: null, choice: fallback ? researchQuestionChoiceFrom(fallback) : null };
}

/** The Ask segment's name and tooltip: "Ask" and the agent and model, as
 * "Ask Claude Fable", a custom or Codex model by its id, or "Ask Claude" for
 * the agent's default model; "Ask AI" with no agent. */
export function postFollowUpAskLabel(launch: ResearchLaunchChoice | null): string {
  if (!launch) return "Ask AI";
  const agent = formatResearchModelSummary(launch.adapter) || launch.adapter;
  const model = launch.model
    ? modelPresetsFor(launch.adapter).includes(launch.model)
      ? formatLauncherModelLabel(launch.adapter, launch.model)
      : launch.model
    : "";
  return ["Ask", agent, model].filter(Boolean).join(" ");
}

/** Why the box's images cannot be sent, or null: notes can't include images,
 * and an AI follow-up's are checked against the agent it runs on (`adapter`, the one
 * the Ask segment shows). */
export function postFollowUpImageBlock(
  asNote: boolean,
  adapter: string | null,
  adapters: readonly AgentAdapterMetadata[],
  images: readonly ResearchImageAttachment[],
): string | null {
  if (images.length === 0) return null;
  if (asNote) return RESEARCH_NOTE_IMAGE_ERROR;
  return researchImageBlockReason(adapter, adapters.find((candidate) => candidate.id === adapter)?.label, images);
}

/** Follow-up composer at the top of a note's follow-ups column. Like the
 * Home ask box it is one line until focused or filled; then the Ask/Note
 * switch and Send appear on a row under the text. It starts in Ask, marked
 * with the icon of the agent the follow-up runs on: the note's follow-up
 * agent, or the agent, model and effort chosen for this box in the model
 * menu, which a press on the selected Ask segment opens. Each AI follow-up
 * of a note is a fresh run with the note as context, so any ready research
 * agent can take it. "Add a note" adds a follow-up note instead. The send
 * shortcut follows the "Require ⌘↵ to send" setting. Images pasted or
 * dropped on the box go with an AI follow-up; notes can't include images. */
export function PostFollowUpField({
  post,
  adapters: allAdapters = NO_ADAPTERS,
  placeholder = "Ask a follow-up",
  autoFocus = false,
  fullWidth = false,
  requireCmdEnter,
  composerRef,
  onSubmit,
}: {
  /** The note the follow-ups are asked about. */
  post: ResearchNode;
  /** The configured agents; the model menu lists those that support
   * research. */
  adapters?: AgentAdapterMetadata[];
  placeholder?: string;
  autoFocus?: boolean;
  fullWidth?: boolean;
  requireCmdEnter: boolean;
  /** Lets the document focus the field (⌘J). */
  composerRef?: Ref<ResearchComposerHandle>;
  onSubmit: (
    prompt: string,
    asNote: boolean,
    images: ResearchImageAttachment[],
    agent: ResearchLaunchChoice | null,
  ) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ResearchImageAttachment[]>([]);
  const [mode, setMode] = useState<AskMode>("ai");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ResearchQuestionChoice | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const askSegmentRef = useRef<HTMLButtonElement | null>(null);
  const imageInput = useResearchImageInput({
    images,
    onImagesChange: (update) => setImages((current) => update(current)),
    disabled: submitting,
    dropTarget: wrapRef,
  });
  const imageProblemId = useId();
  // The field stays expanded while focus is in its model menu (a portal).
  const { focused, collapseIfFocusLeft, rootProps } = useComposerPopOpen(wrapRef, insideComposer);
  const adapters = useMemo(
    () => researchReadyAdaptersFirst(allAdapters.filter((candidate) => candidate.supportsResearch)),
    [allAdapters],
  );
  const ask = postFollowUpAsk(adapters, postFollowUpDefault(post, adapters), chosen);
  const shownAdapter = ask.shown?.adapter ?? null;
  useImperativeHandle(
    composerRef,
    () => ({ focus: () => textareaRef.current?.focus(), element: () => wrapRef.current }),
    [],
  );
  useLayoutEffect(() => {
    if (textareaRef.current) {
      growComposerTextarea(textareaRef.current);
    }
  }, [draft]);
  const expanded = focused || Boolean(draft) || submitting || images.length > 0;
  const asNote = mode === "note";
  const askLabel = postFollowUpAskLabel(ask.shown);
  // The model menu belongs to the expanded row in Ask; it never reopens by
  // itself after a collapse or a switch to Note.
  useEffect(() => {
    if (!expanded || asNote) setMenuOpen(false);
  }, [asNote, expanded]);
  const askIcon = shownAdapter && ADAPTER_ICON_BY_ID[shownAdapter] ? (
    <OptionIcon
      option={{
        value: shownAdapter,
        label: shownAdapter,
        iconSrc: ADAPTER_ICON_BY_ID[shownAdapter],
        iconClassName: adapterIconClassName(shownAdapter),
      }}
    />
  ) : (
    <Sparkles size={14} aria-hidden="true" />
  );
  const imageBlock = postFollowUpImageBlock(asNote, shownAdapter, adapters, images);
  const imageProblem = imageInput.error ?? imageBlock;
  const ready = Boolean(draft.trim()) && !submitting && imageInput.saving === 0 && !imageBlock;
  const submit = () => {
    const prompt = draft.trim();
    if (!prompt || !ready) return;
    setSubmitting(true);
    setError(null);
    onSubmit(prompt, asNote, asNote ? [] : images, asNote ? null : ask.agent)
      .then(() => {
        setDraft("");
        setImages([]);
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => {
        setSubmitting(false);
        window.requestAnimationFrame(collapseIfFocusLeft);
      });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposerSubmitShortcut(event, requireCmdEnter)) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      // Esc leaves the field, which collapses again when it is empty.
      event.preventDefault();
      event.currentTarget.blur();
    }
  };
  const copy = postFollowUpCopy(asNote, placeholder, askLabel);
  const shortcut = requireCmdEnter ? "⌘↵" : "↵";

  return (
    <div
      ref={wrapRef}
      className={`research-composer-wrap post-composer${fullWidth ? " is-full-width" : ""}${
        expanded ? " is-expanded" : ""
      }`}
      onClick={stopForInteractive}
      {...rootProps}
      {...imageInput.fieldProps}
    >
      <ResearchImageStrip
        className="research-composer-images"
        images={images}
        saving={imageInput.saving}
        onRemove={
          submitting
            ? undefined
            : (id) => {
                imageInput.remove(id);
                // The removed × had focus.
                textareaRef.current?.focus();
              }
        }
      />
      <form
        className={`research-composer${ready ? " is-ready" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          autoFocus={autoFocus}
          disabled={submitting}
          placeholder={copy.placeholder}
          aria-label="Follow-up"
          aria-describedby={imageProblem ? imageProblemId : undefined}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            imageInput.clearError();
          }}
          onKeyDown={onKeyDown}
        />
        {expanded ? (
          <div className="post-composer-row">
            <AskNoteSwitch
              askMode={mode}
              askIcon={askIcon}
              askLabel={askLabel}
              noteLabel="Add a note"
              menuOpen={menuOpen}
              askRef={askSegmentRef}
              onModeChange={(next) => {
                setMode(next);
                setError(null);
              }}
              // No menu while no research agent is listed.
              onMenuOpenChange={ask.choice ? setMenuOpen : undefined}
            />
            {ask.choice ? (
              <ResearchQuestionModelPicker
                adapters={adapters}
                choice={ask.choice}
                disabled={submitting}
                anchor={{ ref: askSegmentRef, open: menuOpen && !asNote, onOpenChange: setMenuOpen }}
                onChange={(next) => {
                  setChosen(next);
                  setError(null);
                }}
              />
            ) : null}
            <button
              className="control-button research-composer-send"
              type="submit"
              disabled={!ready}
              aria-label={copy.sendName}
              title={`${copy.sendTitle} (${shortcut})`}
            >
              {submitting ? (
                <LoaderCircle className="research-spinner" size={15} aria-hidden="true" />
              ) : (
                <ArrowRight size={15} aria-hidden="true" />
              )}
              <ComposerSubmitShortcutGlyph
                requireCmdEnter={requireCmdEnter}
                className="research-composer-enter"
                ariaHidden
              />
            </button>
          </div>
        ) : null}
      </form>
      {imageProblem ? (
        <p id={imageProblemId} className="post-thread-error" role="alert">
          {imageProblem}
        </p>
      ) : null}
      {error ? (
        <p className="post-thread-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
