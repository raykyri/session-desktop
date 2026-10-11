import type { RemoteChoice, SavedRemote } from "../types";

export interface RemoteSettingsDraft {
  id: string;
  label: string;
  host: string;
  workspaceRoot: string;
  sessionCli: string;
  multiplexer: RemoteChoice["multiplexer"];
}

export function remoteIdFromLabel(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function availableRemoteId(seed: string, remotes: RemoteChoice[]): string {
  const taken = new Set(remotes.map((remote) => remote.id));
  const base = remoteIdFromLabel(seed) || "remote";
  if (!taken.has(base)) {
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const ending = `-${suffix}`;
    const candidate = `${base.slice(0, 64 - ending.length).replace(/-+$/g, "")}${ending}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

export function remoteDraftFromSshAlias(
  alias: string,
  remotes: RemoteChoice[],
): RemoteSettingsDraft {
  return {
    id: availableRemoteId(alias, remotes),
    label: alias,
    host: alias,
    workspaceRoot: "",
    sessionCli: "",
    multiplexer: "tmux",
  };
}

export function unconfiguredSshAliases(
  aliases: string[],
  remotes: RemoteChoice[],
): string[] {
  const configuredHosts = new Set<string>();
  for (const remote of remotes) {
    const host = remote.host.trim().toLowerCase();
    configuredHosts.add(host);
    const at = host.lastIndexOf("@");
    if (at >= 0) {
      configuredHosts.add(host.slice(at + 1));
    }
  }
  return aliases.filter((alias) => !configuredHosts.has(alias.trim().toLowerCase()));
}

/** The editable form of a listed remote. */
export function remoteSettingsDraft(remote: RemoteChoice): RemoteSettingsDraft {
  return {
    id: remote.id,
    label: remote.label,
    host: remote.host,
    workspaceRoot: remote.workspaceRoot ?? "",
    sessionCli: remote.sessionCli ?? "",
    multiplexer: remote.multiplexer,
  };
}

/** A draft for a new remote with an unused id. */
export function newRemoteSettingsDraft(remotes: RemoteChoice[]): RemoteSettingsDraft {
  return {
    id: availableRemoteId("remote", remotes),
    label: "",
    host: "",
    workspaceRoot: "",
    sessionCli: "",
    multiplexer: "tmux",
  };
}

/** A new draft copied from a remote. The UI only creates driveable remotes: a
 * config entry may retain the documented future-facing `herdr` multiplexer,
 * but its editable copy uses tmux so session can drive it. */
export function copiedRemoteSettingsDraft(
  remote: RemoteChoice,
  remotes: RemoteChoice[],
): RemoteSettingsDraft {
  return {
    ...remoteSettingsDraft(remote),
    id: availableRemoteId(`${remote.id}-copy`, remotes),
    label: `${remote.label} copy`,
    multiplexer: "tmux",
  };
}

/** The saved form of a draft: trimmed, with empty optional fields as null. */
export function savedRemoteFromSettingsDraft(draft: RemoteSettingsDraft): SavedRemote {
  return {
    host: draft.host.trim(),
    label: draft.label.trim() || null,
    multiplexer: draft.multiplexer,
    sessionCli: draft.sessionCli.trim() || null,
    workspaceRoot: draft.workspaceRoot.trim() || null,
  };
}

/** Why a draft cannot be saved, or null when it can. */
export function remoteSettingsDraftError(
  draft: RemoteSettingsDraft,
  isNew: boolean,
  remotes: RemoteChoice[],
): string | null {
  const id = draft.id.trim();
  if (!id || !draft.label.trim() || !draft.host.trim()) {
    return "Name, ID, and SSH host are required.";
  }
  if (isNew && remotes.some((remote) => remote.id === id)) {
    return `A remote with the ID “${id}” already exists.`;
  }
  return null;
}
