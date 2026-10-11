import { useRef } from "react";
import { Check, ChevronDown, Globe, LoaderCircle, Minus, Plus, X } from "lucide-react";
import ConfirmDialogActionButton from "../ConfirmDialogActionButton";
import { useConfirmDialogFocus } from "../../hooks/useConfirmDialogFocus";
import { remoteProbeKey, type RemoteSettingsState } from "../../hooks/useRemoteSettings";
import { agentResearchState, agentSetupStatusLabel } from "../../lib/agentSetup";
import { availableRemoteId, remoteIdFromLabel, remoteSettingsDraft } from "../../lib/remoteSettings";

function RemoteProbeStatus({ state, probeKey }: { state: RemoteSettingsState; probeKey: string }) {
  const probeResult = state.probeResults[probeKey];
  if (state.probeLoadingKey === probeKey) {
    return (
      <div className="settings-remote-probe-loading" role="status">
        <LoaderCircle size={14} className="is-spinning" aria-hidden="true" />
        Checking SSH, tmux, session-cli, and agent providers…
      </div>
    );
  }
  if (!probeResult) {
    return null;
  }
  const remoteAdapters = probeResult.adapters.filter((adapter) => adapter.supportsRemote);
  return (
    <div className="settings-remote-probe-result" aria-live="polite">
      <div className="settings-remote-checks">
        {probeResult.checks.map((check) => (
          <div className={`settings-remote-check is-${check.status}`} key={check.id}>
            {check.status === "passed" ? (
              <Check size={13} aria-hidden="true" />
            ) : check.status === "failed" ? (
              <X size={13} aria-hidden="true" />
            ) : (
              <Minus size={13} aria-hidden="true" />
            )}
            <span>
              <strong>{check.label}</strong>
              <small>{check.message}</small>
            </span>
          </div>
        ))}
      </div>
      {remoteAdapters.length > 0 ? (
        <div className="settings-remote-provider-results">
          <span>Remote agent providers</span>
          {remoteAdapters.map((adapter) => (
            <div key={adapter.instanceId}>
              <strong>{adapter.label}</strong>
              {/* Research readiness, as in Agent Setup: a remote CLI that
                  works but cannot run research reads "Research unavailable". */}
              <span
                className={`settings-agent-status is-${agentResearchState(adapter)}`}
                title={adapter.message ?? undefined}
              >
                {agentSetupStatusLabel(adapter)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The editable fields and actions of a saved or new remote. */
function RemoteSettingsForm({ state }: { state: RemoteSettingsState }) {
  const draft = state.draft;
  if (!draft) {
    return null;
  }
  const fieldPrefix = `settings-remote-${encodeURIComponent(draft.id || "new")}`;
  const probeKey = remoteProbeKey(draft.id);
  const probeLoading = state.probeLoadingKey === probeKey;
  return (
    <div className="settings-remote-detail">
      <div className="settings-remote-fields settings-remote-fields-id">
        <label htmlFor={`${fieldPrefix}-id`}>
          <span>ID</span>
          <input
            id={`${fieldPrefix}-id`}
            className="form-field"
            type="text"
            value={draft.id}
            disabled={!state.draftIsNew}
            spellCheck={false}
            onChange={(event) => {
              const id = remoteIdFromLabel(event.currentTarget.value);
              state.setIdManuallyEdited(true);
              state.changeDraft((current) => ({ ...current, id }));
            }}
          />
        </label>
      </div>
      <div className="settings-remote-fields">
        <label htmlFor={`${fieldPrefix}-label`}>
          <span>Name</span>
          <input
            id={`${fieldPrefix}-label`}
            className="form-field"
            type="text"
            autoFocus={state.draftIsNew}
            value={draft.label}
            placeholder="Build server"
            onChange={(event) => {
              const label = event.currentTarget.value;
              state.changeDraft((current) => {
                const nextSlug = remoteIdFromLabel(label);
                const id =
                  state.draftIsNew && !state.idManuallyEdited && nextSlug
                    ? availableRemoteId(nextSlug, state.remotes)
                    : current.id;
                return { ...current, label, id };
              });
            }}
          />
        </label>
        <label htmlFor={`${fieldPrefix}-host`}>
          <span>SSH host</span>
          <input
            id={`${fieldPrefix}-host`}
            className="form-field"
            type="text"
            value={draft.host}
            placeholder="devbox or user@host"
            list={state.sshAliases.length > 0 ? "settings-ssh-host-aliases" : undefined}
            spellCheck={false}
            onChange={(event) => {
              const host = event.currentTarget.value;
              state.changeDraft((current) => ({ ...current, host }));
            }}
          />
          {state.sshAliases.length > 0 ? (
            <small>{state.sshAliases.length} aliases available from ~/.ssh/config</small>
          ) : null}
        </label>
        <label htmlFor={`${fieldPrefix}-root`}>
          <span>Workspace root <small>optional</small></span>
          <input
            id={`${fieldPrefix}-root`}
            className="form-field"
            type="text"
            value={draft.workspaceRoot}
            placeholder="~/.session/workspaces"
            spellCheck={false}
            onChange={(event) => {
              const workspaceRoot = event.currentTarget.value;
              state.changeDraft((current) => ({ ...current, workspaceRoot }));
            }}
          />
        </label>
        <label htmlFor={`${fieldPrefix}-cli`}>
          <span>Session CLI <small>optional</small></span>
          <input
            id={`${fieldPrefix}-cli`}
            className="form-field"
            type="text"
            value={draft.sessionCli}
            placeholder="session-cli"
            spellCheck={false}
            onChange={(event) => {
              const sessionCli = event.currentTarget.value;
              state.changeDraft((current) => ({ ...current, sessionCli }));
            }}
          />
        </label>
        <datalist id="settings-ssh-host-aliases">
          {state.sshAliases.map((alias) => (
            <option value={alias} key={alias} />
          ))}
        </datalist>
      </div>
      {state.error ? (
        <p className="settings-agent-error" role="alert">{state.error}</p>
      ) : null}
      <RemoteProbeStatus state={state} probeKey={probeKey} />
      <div className="settings-remote-actions">
        <button
          type="button"
          className="control-button settings-remote-test"
          disabled={state.saving || probeLoading}
          onClick={() => void state.test(draft)}
        >
          {probeLoading ? "Testing…" : "Test connection"}
        </button>
        {!state.draftIsNew ? (
          <button
            type="button"
            className="control-button settings-remote-remove"
            disabled={state.saving}
            onClick={() => state.requestRemove(draft)}
          >
            Remove
          </button>
        ) : (
          <button
            type="button"
            className="control-button settings-remote-remove"
            disabled={state.saving}
            onClick={state.cancelNewDraft}
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          className="control-button settings-remote-save"
          disabled={state.saving}
          onClick={() => void state.save()}
        >
          {state.saving ? "Saving…" : state.draftIsNew ? "Add remote" : "Save"}
        </button>
      </div>
    </div>
  );
}

/** The Settings > Remotes tab panel. */
export function RemoteSettingsPanel({ state }: { state: RemoteSettingsState }) {
  return (
    <div className="settings-content settings-remotes" role="tabpanel">
      <div className="settings-agents-heading">
        <div>
          <h3>Remote machines</h3>
        </div>
        <div className="settings-remote-add-group" ref={state.addMenuRef}>
          <button
            type="button"
            className="control-button settings-remote-add settings-remote-add-main"
            disabled={state.saving || state.draftIsNew}
            onClick={() => {
              state.setAddMenuOpen(false);
              state.beginAdding();
            }}
          >
            <Plus size={13} aria-hidden="true" />
            Add
          </button>
          <button
            ref={state.addMenuButtonRef}
            type="button"
            className="control-button settings-remote-add settings-remote-add-menu-button"
            disabled={state.saving || state.draftIsNew}
            aria-label="Add remote options"
            aria-haspopup="menu"
            aria-expanded={state.addMenuOpen}
            aria-controls="settings-remote-add-menu"
            onClick={(event) => {
              // WebKit does not focus a clicked button; focus it so
              // a second click, which closes the menu (whose item
              // has focus), leaves focus here.
              event.currentTarget.focus({ preventScroll: true });
              const opening = !state.addMenuOpen;
              state.setAddMenuOpen(opening);
              if (opening && !state.sshAliasesLoading) {
                void state.refreshSshAliases();
              }
            }}
          >
            <ChevronDown size={13} aria-hidden="true" />
          </button>
          {state.addMenuOpen ? (
            <div
              id="settings-remote-add-menu"
              className="popover-surface popover-surface--context settings-remote-add-menu"
              role="menu"
              aria-label="Add remote options"
            >
              <div className="group-context-actions">
                <button
                  type="button"
                  role="menuitem"
                  className="control-button"
                  autoFocus
                  onClick={() => {
                    state.setAddMenuOpen(false);
                    state.beginAdding();
                  }}
                >
                  <Plus size={13} aria-hidden="true" />
                  <span>Add manually</span>
                </button>
                <div className="context-menu-divider" role="separator" />
                <div className="settings-remote-add-menu-label" role="presentation">
                  From SSH config
                </div>
                <div
                  className="settings-remote-add-menu-aliases"
                  role="group"
                  aria-label="From SSH config"
                >
                  {state.availableSshAliases.map((alias) => (
                    <button
                      type="button"
                      role="menuitem"
                      className="control-button"
                      key={alias}
                      onClick={() => {
                        state.setAddMenuOpen(false);
                        state.beginAddingFromSshAlias(alias);
                      }}
                    >
                      <Globe size={13} aria-hidden="true" />
                      <span title={alias}>{alias}</span>
                    </button>
                  ))}
                  {state.availableSshAliases.length === 0 ? (
                    <div
                      className="settings-remote-add-menu-empty"
                      role="menuitem"
                      aria-disabled="true"
                      aria-live="polite"
                      title={state.sshAliasesError ?? undefined}
                    >
                      {state.sshAliasesLoading
                        ? "Loading SSH hosts…"
                        : state.sshAliasesError
                          ? "Couldn’t load SSH config"
                          : state.sshAliases.length > 0
                            ? "All SSH hosts are already added"
                            : "No SSH hosts found"}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <div className="settings-agent-list settings-remote-list">
        {state.draftIsNew && state.draft ? (
          <section className="settings-agent-card settings-remote-card">
            <div className="settings-remote-new-heading">
              <Globe size={16} aria-hidden="true" />
              <strong>New remote</strong>
            </div>
            <RemoteSettingsForm state={state} />
          </section>
        ) : null}
        {state.remotes.map((remote) => {
          const isExpanded = state.expandedId === remote.id;
          const safeRemoteId = encodeURIComponent(remote.id);
          const summaryId = `settings-remote-summary-${safeRemoteId}`;
          const detailsId = `settings-remote-details-${safeRemoteId}`;
          return (
            <section className="settings-agent-card settings-remote-card" key={remote.id}>
              <button
                id={summaryId}
                type="button"
                className="settings-agent-summary settings-remote-summary"
                aria-expanded={isExpanded}
                aria-controls={detailsId}
                onClick={() => state.toggleRemote(remote)}
              >
                <Globe size={16} className="settings-remote-icon" aria-hidden="true" />
                <span className="settings-agent-identity">
                  <strong>{remote.label}</strong>
                  <span className="settings-agent-summary-meta">{remote.host}</span>
                </span>
                <span className="settings-remote-source">
                  {remote.source === "config" ? "Config file" : "Saved"}
                </span>
                <ChevronDown
                  size={13}
                  className={`settings-agent-chevron${isExpanded ? " is-open" : ""}`}
                  aria-hidden="true"
                />
              </button>
              {isExpanded ? (
                <div id={detailsId} role="region" aria-labelledby={summaryId}>
                  {remote.source === "preferences" ? (
                    <RemoteSettingsForm state={state} />
                  ) : (
                    <div className="settings-remote-detail settings-remote-readonly">
                      <dl className="settings-agent-details">
                        <div>
                          <dt>ID</dt>
                          <dd>{remote.id}</dd>
                        </div>
                        <div>
                          <dt>Multiplexer</dt>
                          <dd>{remote.multiplexer}</dd>
                        </div>
                        <div>
                          <dt>Workspace root</dt>
                          <dd>{remote.workspaceRoot ?? "Default"}</dd>
                        </div>
                        <div>
                          <dt>Session CLI</dt>
                          <dd>{remote.sessionCli ?? "session-cli"}</dd>
                        </div>
                      </dl>
                      {state.error ? (
                        <p className="settings-agent-error" role="alert">
                          {state.error}
                        </p>
                      ) : null}
                      <RemoteProbeStatus state={state} probeKey={remote.id} />
                      <div className="settings-remote-actions">
                        <button
                          type="button"
                          className="control-button settings-remote-test"
                          disabled={state.probeLoadingKey === remote.id}
                          onClick={() => void state.test(remoteSettingsDraft(remote))}
                        >
                          {state.probeLoadingKey === remote.id ? "Testing…" : "Test connection"}
                        </button>
                        <button
                          type="button"
                          className="control-button"
                          disabled={state.probeLoadingKey === remote.id}
                          onClick={() => state.beginCopying(remote)}
                        >
                          Copy to my remotes
                        </button>
                      </div>
                      <p className="settings-hint">
                        This remote is declared in <code>session.config.json</code>. Edit the
                        file to change it, or copy it into an editable saved remote.
                      </p>
                    </div>
                  )}
                </div>
              ) : null}
            </section>
          );
        })}
        {state.remotes.length === 0 && !state.draftIsNew ? (
          <div className="settings-remote-empty">
            <Globe size={22} aria-hidden="true" />
            <span>No remote machines saved yet.</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Confirms removing a saved remote. */
export function RemoteDeleteDialog({ state }: { state: RemoteSettingsState }) {
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  useConfirmDialogFocus(confirmButtonRef, state.deleteConfirm);
  const confirm = state.deleteConfirm;
  if (!confirm) {
    return null;
  }
  return (
    <div
      className="confirm-dialog-backdrop settings-remote-delete-dialog"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !state.saving) {
          state.cancelRemove();
        }
      }}
    >
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-delete-dialog-title"
        aria-busy={state.saving}
      >
        <h2 id="remote-delete-dialog-title">Remove {confirm.label}?</h2>
        <p>Existing groups stay connected to this machine.</p>
        {state.error ? (
          <p className="confirm-dialog-error" role="alert">
            {state.error}
          </p>
        ) : null}
        <div className="confirm-dialog-actions">
          <button
            className="control-button"
            type="button"
            disabled={state.saving}
            onClick={state.cancelRemove}
          >
            Cancel
          </button>
          <ConfirmDialogActionButton
            ref={confirmButtonRef}
            type="button"
            className="danger"
            autoFocus
            pending={state.saving}
            pendingLabel="Removing…"
            onClick={() => void state.remove(confirm.id)}
          >
            Remove remote
          </ConfirmDialogActionButton>
        </div>
      </div>
    </div>
  );
}
