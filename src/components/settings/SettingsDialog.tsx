import { useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { Eye, EyeOff, LoaderCircle, MessageSquareText, X } from "lucide-react";
import { RemoteDeleteDialog, RemoteSettingsPanel } from "./RemoteSettingsPanel";
import { useRemoteSettings } from "../../hooks/useRemoteSettings";
import { useShowHideShortcut } from "../../hooks/useShowHideShortcut";
import { openRouterChatCompletion } from "../../lib/api";
import {
  firstMessageTitleConfig,
  firstMessageTitleSource,
  summarizeFirstMessageTitle,
  tabTitleProviderLabel,
  TITLE_GENERATION_TEST_MESSAGE,
} from "../../lib/openRouterTitles";
import {
  APPEARANCE_OPTIONS,
  clampResearchLaunchInstruction,
  COLOR_THEME_OPTIONS,
  DEFAULT_RESEARCH_LAUNCH_INSTRUCTION,
  TAB_TITLE_PROVIDER_OPTIONS,
  type AppSettings,
  type BodyFontOption,
} from "../../lib/settings";
import type { RemoteChoice } from "../../types";

type TitleGenerationTestState =
  | { status: "running"; providerLabel: string }
  | { status: "success"; providerLabel: string; title: string }
  | { status: "error"; providerLabel: string; message: string };

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
  /** Installed body fonts; null while detection runs. */
  availableBodyFonts: BodyFontOption[] | null;
  remotes: RemoteChoice[];
  onRemotesChange: (remotes: RemoteChoice[]) => void;
  onToast: (message: string, tone?: "normal" | "warning") => void;
  /** Set to a handler the app's Escape dispatcher calls first; it returns
   * whether an open Remotes menu or confirmation consumed the key. */
  escapeHandlerRef: MutableRefObject<(() => boolean) | null>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The Settings panel (Basic and Remotes tabs). Stays mounted while closed so
 * the selected tab, the remote being edited and the show/hide shortcut state
 * persist between openings.
 */
export default function SettingsDialog({
  open,
  onClose,
  settings,
  setSettings,
  availableBodyFonts,
  remotes,
  onRemotesChange,
  onToast,
  escapeHandlerRef,
}: SettingsDialogProps) {
  const [tab, setTab] = useState<"basic" | "remotes">("basic");
  const [openRouterKeyVisible, setOpenRouterKeyVisible] = useState(false);
  const [titleTest, setTitleTest] = useState<TitleGenerationTestState | null>(null);
  const titleTestSeqRef = useRef(0);
  const shortcut = useShowHideShortcut(open);
  const remote = useRemoteSettings({
    active: open && tab === "remotes",
    remotes,
    onRemotesChange,
    onToast,
  });
  escapeHandlerRef.current = remote.handleEscape;

  // Closing hides the key again; the tab is kept so reopening returns to it.
  useEffect(() => {
    if (!open) {
      setOpenRouterKeyVisible(false);
    }
  }, [open]);

  // A provider, key or model change invalidates the last test result.
  useEffect(() => {
    titleTestSeqRef.current += 1;
    setTitleTest(null);
  }, [settings.tabTitleProvider, settings.openRouterKey, settings.openRouterModel]);

  async function testTitleGeneration() {
    const titleConfig = firstMessageTitleConfig(settings);
    const providerLabel = titleConfig ? "OpenRouter" : tabTitleProviderLabel(settings.tabTitleProvider);
    const requestSeq = titleTestSeqRef.current + 1;
    titleTestSeqRef.current = requestSeq;

    if (!titleConfig) {
      const message =
        settings.tabTitleProvider === "openRouter"
          ? "Add an OpenRouter key and model before testing."
          : "Choose a title generation provider before testing.";
      setTitleTest({ status: "error", providerLabel, message });
      return;
    }

    const sourceMessage = firstMessageTitleSource(TITLE_GENERATION_TEST_MESSAGE);
    if (!sourceMessage) {
      setTitleTest({ status: "error", providerLabel, message: "Test message could not be prepared." });
      return;
    }

    setTitleTest({ status: "running", providerLabel });
    try {
      const title = await summarizeFirstMessageTitle(
        sourceMessage,
        titleConfig,
        openRouterChatCompletion,
      );
      if (!title) {
        throw new Error(`${providerLabel} returned no title.`);
      }
      if (titleTestSeqRef.current !== requestSeq) {
        return;
      }
      setTitleTest({ status: "success", providerLabel, title });
      onToast(`${providerLabel} title test: ${title}`);
    } catch (err) {
      if (titleTestSeqRef.current !== requestSeq) {
        return;
      }
      const message = errorMessage(err);
      setTitleTest({ status: "error", providerLabel, message });
      onToast(`${providerLabel} title test failed: ${message}`, "warning");
    }
  }

  const titleTestVisible = settings.tabTitleProvider === "openRouter";
  const titleTestRunning = titleTest?.status === "running";

  return (
    <>
      {open ? (
        <div
          className="settings-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              onClose();
            }
          }}
        >
          <div
            className="settings-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="settings-header">
              <h2 id="settings-title">Settings</h2>
              <button
                type="button"
                className="control-button settings-close"
                aria-label="Close settings"
                onClick={onClose}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <div
              className="settings-tabs"
              role="tablist"
              aria-label="Settings sections"
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab === "basic"}
                className={`control-button${tab === "basic" ? " is-active" : ""}`}
                onClick={() => setTab("basic")}
              >
                Basic
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "remotes"}
                className={`control-button${tab === "remotes" ? " is-active" : ""}`}
                onClick={() => setTab("remotes")}
              >
                Remotes
              </button>
            </div>

            {tab === "remotes" ? (
              <RemoteSettingsPanel state={remote} />
            ) : (
              <div className="settings-content" role="tabpanel">
                <label className="settings-row settings-toggle">
                  <span className="settings-label">Require ⌘↵ to send</span>
                  <input
                    type="checkbox"
                    className="settings-checkbox"
                    checked={settings.requireCmdEnterToSend}
                    onChange={(event) => {
                      const requireCmdEnterToSend = event.currentTarget.checked;
                      setSettings((current) => ({ ...current, requireCmdEnterToSend }));
                    }}
                  />
                </label>

                <div className="settings-row settings-research-instructions-row">
                  <div className="settings-label-stack">
                    <label htmlFor="settings-research-instructions" className="settings-label">
                      Research instructions
                    </label>
                    <p className="settings-hint settings-hint-weak">
                      Sent with every research launch
                    </p>
                  </div>
                  <textarea
                    id="settings-research-instructions"
                    className="form-field settings-input settings-textarea"
                    rows={1}
                    placeholder={DEFAULT_RESEARCH_LAUNCH_INSTRUCTION}
                    value={settings.researchLaunchInstruction}
                    onChange={(event) => {
                      const researchLaunchInstruction = clampResearchLaunchInstruction(
                        event.currentTarget.value,
                      );
                      setSettings((current) => ({ ...current, researchLaunchInstruction }));
                    }}
                  />
                </div>

                <div className="settings-row settings-shortcut-row">
                  <div className="settings-label">
                    <label htmlFor="settings-show-hide-shortcut">Show/hide app shortcut</label>
                    {shortcut.value ? (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="settings-link-button settings-inline-link-button"
                          disabled={shortcut.saving}
                          onClick={shortcut.clear}
                        >
                          Clear
                        </button>
                      </>
                    ) : null}
                  </div>
                  <input
                    id="settings-show-hide-shortcut"
                    className="form-field settings-input settings-shortcut-input"
                    data-shortcut-capture="show-hide"
                    value={shortcut.value}
                    placeholder="e.g. Option+Space"
                    readOnly
                    aria-invalid={shortcut.message ? true : undefined}
                    aria-describedby={
                      shortcut.message ? "settings-show-hide-shortcut-message" : undefined
                    }
                    onPointerDown={() => shortcut.setCapturing(true)}
                    onFocus={() => shortcut.setCapturing(true)}
                    onBlur={() => shortcut.setCapturing(false)}
                    onKeyDown={shortcut.capture}
                  />
                </div>
                {shortcut.message || shortcut.saving ? (
                  <p
                    id="settings-show-hide-shortcut-message"
                    className={`settings-hint settings-shortcut-message${
                      shortcut.message ? " is-error" : ""
                    }`}
                  >
                    {shortcut.saving ? "Saving shortcut..." : shortcut.message}
                  </p>
                ) : null}
                {shortcut.conflictLabel ? (
                  <p className="settings-hint settings-shortcut-message">
                    {`Session also uses this shortcut to ${shortcut.conflictLabel}; while registered system-wide, it will show/hide the app instead.`}
                  </p>
                ) : null}

                <label className="settings-row settings-toggle">
                  <span className="settings-label">Keep awake while agents run (&gt;10% battery)</span>
                  <input
                    type="checkbox"
                    className="settings-checkbox"
                    checked={settings.preventSleep}
                    onChange={(event) => {
                      // Capture before the updater, which runs after currentTarget
                      // has been nulled out.
                      const preventSleep = event.currentTarget.checked;
                      setSettings((current) => ({ ...current, preventSleep }));
                    }}
                  />
                </label>

                <label className="settings-row settings-toggle">
                  <span className="settings-label">Use login shell</span>
                  <input
                    type="checkbox"
                    className="settings-checkbox"
                    checked={settings.useLoginShell}
                    onChange={(event) => {
                      const useLoginShell = event.currentTarget.checked;
                      setSettings((current) => ({ ...current, useLoginShell }));
                    }}
                  />
                </label>

                <div className="settings-divider" role="separator" />

                <div className="settings-row">
                  <label htmlFor="settings-appearance" className="settings-label">
                    Appearance
                  </label>
                  <select
                    id="settings-appearance"
                    className="settings-select"
                    value={settings.appearance}
                    onChange={(event) => {
                      const appearance = event.currentTarget.value as AppSettings["appearance"];
                      setSettings((current) => ({ ...current, appearance }));
                    }}
                  >
                    {APPEARANCE_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="settings-row">
                  <label htmlFor="settings-color-theme" className="settings-label">
                    Color theme
                  </label>
                  <select
                    id="settings-color-theme"
                    className="settings-select"
                    value={settings.colorTheme}
                    onChange={(event) => {
                      const colorTheme = event.currentTarget.value as AppSettings["colorTheme"];
                      setSettings((current) => ({ ...current, colorTheme }));
                    }}
                  >
                    {COLOR_THEME_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="settings-row">
                  <label htmlFor="settings-body-font" className="settings-label">
                    Body font
                  </label>
                  <select
                    id="settings-body-font"
                    className="settings-select"
                    value={availableBodyFonts === null ? "" : settings.bodyFontId}
                    disabled={availableBodyFonts === null}
                    onChange={(event) => {
                      const bodyFontId = event.currentTarget.value;
                      setSettings((current) => ({ ...current, bodyFontId }));
                    }}
                  >
                    {availableBodyFonts === null ? (
                      <option value="">Detecting installed fonts…</option>
                    ) : (
                      availableBodyFonts.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))
                    )}
                  </select>
                </div>

                <label className="settings-row settings-toggle">
                  <span className="settings-label">Show keyboard shortcut hints</span>
                  <input
                    type="checkbox"
                    className="settings-checkbox"
                    checked={settings.showShortcutHints}
                    onChange={(event) => {
                      const showShortcutHints = event.currentTarget.checked;
                      setSettings((current) => ({ ...current, showShortcutHints }));
                    }}
                  />
                </label>

                <label className="settings-row settings-toggle">
                  <span className="settings-label">Reduce motion</span>
                  <input
                    type="checkbox"
                    className="settings-checkbox"
                    checked={settings.reduceMotion}
                    onChange={(event) => {
                      const reduceMotion = event.currentTarget.checked;
                      setSettings((current) => ({ ...current, reduceMotion }));
                    }}
                  />
                </label>

                <div className="settings-divider" role="separator" />

                <div className="settings-row">
                  <label htmlFor="settings-tab-title-provider" className="settings-label">
                    Generate tab titles
                  </label>
                  <select
                    id="settings-tab-title-provider"
                    className="settings-select"
                    value={settings.tabTitleProvider}
                    onChange={(event) => {
                      const tabTitleProvider =
                        event.currentTarget.value as AppSettings["tabTitleProvider"];
                      setSettings((current) => ({ ...current, tabTitleProvider }));
                    }}
                  >
                    {TAB_TITLE_PROVIDER_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                {settings.tabTitleProvider === "openRouter" ? (
                  <>
                    <p className="settings-hint">
                      Sends the first message of each new tab to OpenRouter to summarize a title.
                    </p>

                    <div className="settings-row">
                      <label htmlFor="settings-openrouter-key" className="settings-label">
                        OpenRouter key
                      </label>
                      <div className="settings-secret-input">
                        <input
                          id="settings-openrouter-key"
                          className="form-field settings-input"
                          type={openRouterKeyVisible ? "text" : "password"}
                          value={settings.openRouterKey}
                          placeholder="sk-or-v1-..."
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(event) => {
                            const openRouterKey = event.currentTarget.value;
                            setSettings((current) => ({ ...current, openRouterKey }));
                          }}
                        />
                        <button
                          type="button"
                          className="control-button settings-secret-toggle"
                          aria-label={
                            openRouterKeyVisible ? "Hide OpenRouter key" : "Show OpenRouter key"
                          }
                          aria-pressed={openRouterKeyVisible}
                          onClick={() => setOpenRouterKeyVisible((visible) => !visible)}
                        >
                          {openRouterKeyVisible ? (
                            <EyeOff size={14} aria-hidden="true" />
                          ) : (
                            <Eye size={14} aria-hidden="true" />
                          )}
                        </button>
                      </div>
                    </div>

                    <div className="settings-row">
                      <label htmlFor="settings-openrouter-model" className="settings-label">
                        OpenRouter model
                      </label>
                      <input
                        id="settings-openrouter-model"
                        className="form-field settings-input"
                        type="text"
                        value={settings.openRouterModel}
                        placeholder="google/gemma-4-31b-it:free"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => {
                          const openRouterModel = event.currentTarget.value;
                          setSettings((current) => ({ ...current, openRouterModel }));
                        }}
                      />
                    </div>
                  </>
                ) : null}
                {titleTestVisible ? (
                  <div className="settings-title-test">
                    <div className="settings-row">
                      <span className="settings-label">Test title generation</span>
                      <button
                        type="button"
                        className="control-button settings-test-button"
                        disabled={titleTestRunning}
                        aria-describedby={titleTest ? "settings-title-test-message" : undefined}
                        onClick={() => void testTitleGeneration()}
                      >
                        {titleTestRunning ? (
                          <LoaderCircle
                            className="settings-test-spinner"
                            size={14}
                            aria-hidden="true"
                          />
                        ) : (
                          <MessageSquareText size={14} aria-hidden="true" />
                        )}
                        {titleTestRunning ? "Testing..." : "Test title"}
                      </button>
                    </div>
                    {titleTest ? (
                      <p
                        id="settings-title-test-message"
                        className={`settings-hint settings-title-test-message is-${titleTest.status}`}
                      >
                        {titleTest.status === "running"
                          ? `${titleTest.providerLabel} is generating a title...`
                          : titleTest.status === "success"
                            ? `${titleTest.providerLabel}: "${titleTest.title}"`
                            : `${titleTest.providerLabel}: ${titleTest.message}`}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : null}
      <RemoteDeleteDialog state={remote} />
    </>
  );
}
