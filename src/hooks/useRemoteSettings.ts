import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deleteRemote, listSshConfigAliases, probeRemote, upsertRemote } from "../lib/api";
import {
  copiedRemoteSettingsDraft,
  newRemoteSettingsDraft,
  remoteDraftFromSshAlias,
  remoteSettingsDraft,
  remoteSettingsDraftError,
  savedRemoteFromSettingsDraft,
  unconfiguredSshAliases,
  type RemoteSettingsDraft,
} from "../lib/remoteSettings";
import type { RemoteChoice, RemoteProbeResult } from "../types";

interface RemoteSettingsOptions {
  /** Whether Settings is open on its Remotes tab. */
  active: boolean;
  remotes: RemoteChoice[];
  onRemotesChange: (remotes: RemoteChoice[]) => void;
  onToast: (message: string) => void;
}

/** The expanded row id of the draft for a remote that is not saved yet. */
const NEW_REMOTE_ROW_ID = "__new__";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Probe results are keyed by remote id; a draft without an id uses the new-row key. */
export function remoteProbeKey(id: string | null | undefined) {
  const trimmed = id?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : NEW_REMOTE_ROW_ID;
}

/**
 * State of the Settings > Remotes tab: the remote being edited or added,
 * connection probes, the SSH config aliases offered by the Add menu, and the
 * removal confirmation. It lives with the Settings panel, so an expanded row
 * and its draft survive switching tabs and closing Settings.
 */
export function useRemoteSettings({ active, remotes, onRemotesChange, onToast }: RemoteSettingsOptions) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const addMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [draft, setDraft] = useState<RemoteSettingsDraft | null>(null);
  const [draftIsNew, setDraftIsNew] = useState(false);
  const [idManuallyEdited, setIdManuallyEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; label: string } | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, RemoteProbeResult>>({});
  const [probeLoadingKey, setProbeLoadingKey] = useState<string | null>(null);
  // Every probe takes a generation; a reset or newer probe for the same key
  // makes an in-flight probe's result stale.
  const probeRequestRef = useRef(0);
  const probeGenerationByKeyRef = useRef<Record<string, number>>({});
  const [sshAliases, setSshAliases] = useState<string[]>([]);
  const [sshAliasesLoading, setSshAliasesLoading] = useState(false);
  const [sshAliasesError, setSshAliasesError] = useState<string | null>(null);
  const sshAliasesRequestRef = useRef(0);
  const availableSshAliases = useMemo(
    () => unconfiguredSshAliases(sshAliases, remotes),
    [remotes, sshAliases],
  );

  const refreshSshAliases = useCallback(async () => {
    const request = sshAliasesRequestRef.current + 1;
    sshAliasesRequestRef.current = request;
    setSshAliasesLoading(true);
    setSshAliasesError(null);
    try {
      const aliases = await listSshConfigAliases();
      if (sshAliasesRequestRef.current === request) {
        setSshAliases(aliases);
      }
    } catch (err) {
      if (sshAliasesRequestRef.current === request) {
        setSshAliasesError(errorMessage(err));
      }
    } finally {
      if (sshAliasesRequestRef.current === request) {
        setSshAliasesLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (active) {
      void refreshSshAliases();
    }
  }, [active, refreshSshAliases]);

  // Leaving the tab closes its menu and confirmation and drops probe results.
  useEffect(() => {
    if (!active) {
      setAddMenuOpen(false);
      setDeleteConfirm(null);
      const generation = ++probeRequestRef.current;
      for (const key of Object.keys(probeGenerationByKeyRef.current)) {
        probeGenerationByKeyRef.current[key] = generation;
      }
      setProbeLoadingKey((current) => (current === null ? current : null));
      setProbeResults((current) => (Object.keys(current).length === 0 ? current : {}));
    }
  }, [active]);

  useEffect(() => {
    if (!addMenuOpen) {
      return;
    }
    const handleMouseDown = (event: MouseEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    const handleResize = () => setAddMenuOpen(false);
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("resize", handleResize);
    };
  }, [addMenuOpen]);

  function resetProbe(id: string) {
    const key = remoteProbeKey(id);
    probeGenerationByKeyRef.current[key] = ++probeRequestRef.current;
    setProbeResults((current) => {
      if (!(key in current)) {
        return current;
      }
      const next = { ...current };
      delete next[key];
      return next;
    });
    setProbeLoadingKey((current) => (current === key ? null : current));
  }

  function changeDraft(update: (current: RemoteSettingsDraft) => RemoteSettingsDraft) {
    if (draft) {
      resetProbe(draft.id);
    }
    setError(null);
    setDraft((current) => (current ? update(current) : current));
  }

  function beginNewDraft(next: RemoteSettingsDraft) {
    setExpandedId(NEW_REMOTE_ROW_ID);
    setDraft(next);
    setDraftIsNew(true);
    setIdManuallyEdited(false);
    setError(null);
    setDeleteConfirm(null);
  }

  function toggleRemote(remote: RemoteChoice) {
    if (expandedId === remote.id) {
      setExpandedId(null);
      setDraft(null);
      setError(null);
      setDeleteConfirm(null);
      return;
    }
    setExpandedId(remote.id);
    setDraft(remoteSettingsDraft(remote));
    setDraftIsNew(false);
    setIdManuallyEdited(true);
    setError(null);
    setDeleteConfirm(null);
  }

  function cancelNewDraft() {
    if (!draft) {
      return;
    }
    setExpandedId(null);
    setDraft(null);
    setDraftIsNew(false);
    setError(null);
    resetProbe(draft.id);
  }

  async function save() {
    if (!draft || saving) {
      return;
    }
    const validation = remoteSettingsDraftError(draft, draftIsNew, remotes);
    if (validation) {
      setError(validation);
      return;
    }
    const id = draft.id.trim();
    const label = draft.label.trim();
    const host = draft.host.trim();
    const remote = savedRemoteFromSettingsDraft({ ...draft, label, host });
    setSaving(true);
    setError(null);
    try {
      onRemotesChange(await upsertRemote(id, remote));
      setExpandedId(id);
      setDraft({ ...draft, id, label, host });
      setDraftIsNew(false);
      onToast(draftIsNew ? "Remote added" : "Remote updated");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function test(target: RemoteSettingsDraft) {
    if (!target.host.trim()) {
      setError("Enter an SSH host before testing.");
      return;
    }
    const key = remoteProbeKey(target.id);
    const generation = ++probeRequestRef.current;
    probeGenerationByKeyRef.current[key] = generation;
    setProbeLoadingKey(key);
    setProbeResults((current) => {
      if (!(key in current)) {
        return current;
      }
      const next = { ...current };
      delete next[key];
      return next;
    });
    setError(null);
    try {
      const result = await probeRemote(savedRemoteFromSettingsDraft(target));
      if (probeGenerationByKeyRef.current[key] !== generation) {
        return;
      }
      setProbeResults((current) => ({ ...current, [key]: result }));
    } catch (err) {
      if (probeGenerationByKeyRef.current[key] !== generation) {
        return;
      }
      setError(errorMessage(err));
    } finally {
      if (probeGenerationByKeyRef.current[key] === generation) {
        setProbeLoadingKey((current) => (current === key ? null : current));
      }
    }
  }

  async function remove(id: string) {
    if (saving) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onRemotesChange(await deleteRemote(id));
      setExpandedId(null);
      setDraft(null);
      setDeleteConfirm(null);
      resetProbe(id);
      onToast("Remote removed");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  /** Escape closes the Add menu, then the removal confirmation; returns
   * whether either consumed the key (Settings stays open). */
  function handleEscape(): boolean {
    if (addMenuOpen) {
      setAddMenuOpen(false);
      requestAnimationFrame(() => addMenuButtonRef.current?.focus());
      return true;
    }
    if (deleteConfirm) {
      if (!saving) {
        setDeleteConfirm(null);
      }
      return true;
    }
    return false;
  }

  return {
    remotes,
    expandedId,
    draft,
    draftIsNew,
    idManuallyEdited,
    saving,
    error,
    deleteConfirm,
    probeResults,
    probeLoadingKey,
    addMenuOpen,
    addMenuRef,
    addMenuButtonRef,
    sshAliases,
    sshAliasesLoading,
    sshAliasesError,
    availableSshAliases,
    setAddMenuOpen,
    refreshSshAliases,
    beginAdding: () => beginNewDraft(newRemoteSettingsDraft(remotes)),
    beginAddingFromSshAlias: (alias: string) => beginNewDraft(remoteDraftFromSshAlias(alias, remotes)),
    beginCopying: (remote: RemoteChoice) => beginNewDraft(copiedRemoteSettingsDraft(remote, remotes)),
    toggleRemote,
    cancelNewDraft,
    changeDraft,
    setIdManuallyEdited,
    save,
    test,
    requestRemove: (target: RemoteSettingsDraft) => {
      setError(null);
      setDeleteConfirm({ id: target.id, label: target.label.trim() || target.id });
    },
    cancelRemove: () => setDeleteConfirm(null),
    remove,
    handleEscape,
  };
}

export type RemoteSettingsState = ReturnType<typeof useRemoteSettings>;
