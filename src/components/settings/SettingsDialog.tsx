import type { Dispatch, SetStateAction } from "react";
import { X } from "lucide-react";
import { useShowHideShortcut } from "../../hooks/useShowHideShortcut";
import {
  APPEARANCE_OPTIONS,
  clampResearchLaunchInstruction,
  COLOR_THEME_OPTIONS,
  DEFAULT_RESEARCH_LAUNCH_INSTRUCTION,
  type AppSettings,
  type BodyFontOption,
} from "../../lib/settings";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
  /** Installed body fonts; null while detection runs. */
  availableBodyFonts: BodyFontOption[] | null;
}

/**
 * The Settings panel. Stays mounted while closed so the show/hide shortcut
 * state persists between openings.
 */
export default function SettingsDialog({
  open,
  onClose,
  settings,
  setSettings,
  availableBodyFonts,
}: SettingsDialogProps) {
  const shortcut = useShowHideShortcut(open);

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

            <div className="settings-content">
              <label className="settings-row settings-toggle">
                <span className="settings-label-stack">
                  <span className="settings-label">Require ⌘↵ to send</span>
                  <span className="settings-hint settings-hint-weak">
                    A thread's question boxes always require ⌘↵. This setting controls the Home ask box, drafts and note follow-ups.
                  </span>
                </span>
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

              <label className="settings-row settings-toggle">
                <span className="settings-label-stack">
                  <span className="settings-label">Widgets in answers</span>
                  <span className="settings-hint settings-hint-weak">
                    Agents may add sandboxed HTML; its scripts run only when you start them
                  </span>
                </span>
                <input
                  type="checkbox"
                  className="settings-checkbox"
                  checked={settings.researchInlineWidgets}
                  onChange={(event) => {
                    const researchInlineWidgets = event.currentTarget.checked;
                    setSettings((current) => ({ ...current, researchInlineWidgets }));
                  }}
                />
              </label>

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
                  {shortcut.saving ? "Saving shortcut…" : shortcut.message}
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
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
