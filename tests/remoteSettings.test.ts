import assert from "node:assert/strict";
import test from "node:test";
import {
  availableRemoteId,
  copiedRemoteSettingsDraft,
  newRemoteSettingsDraft,
  remoteDraftFromSshAlias,
  remoteIdFromLabel,
  remoteSettingsDraft,
  remoteSettingsDraftError,
  savedRemoteFromSettingsDraft,
  unconfiguredSshAliases,
} from "../src/lib/remoteSettings";
import type { RemoteChoice } from "../src/types";

function remote(id: string): RemoteChoice {
  return {
    id,
    label: id,
    host: id,
    multiplexer: "tmux",
    source: "preferences",
    usable: true,
  };
}

test("remote ids are stable lowercase slugs", () => {
  assert.equal(remoteIdFromLabel("  Build Box / West  "), "build-box-west");
  assert.equal(remoteIdFromLabel("---"), "");
  assert.equal(remoteIdFromLabel("a".repeat(80)).length, 64);
});

test("copied remote ids avoid collisions without exceeding the backend limit", () => {
  assert.equal(
    availableRemoteId("devbox-copy", [remote("devbox-copy"), remote("devbox-copy-2")]),
    "devbox-copy-3",
  );
  const long = "a".repeat(64);
  const result = availableRemoteId(long, [remote(long)]);
  assert.equal(result, `${"a".repeat(62)}-2`);
  assert.equal(result.length, 64);
});

test("SSH aliases seed an unsaved remote with collision-safe defaults", () => {
  assert.deepEqual(remoteDraftFromSshAlias("Prod-West", [remote("prod-west")]), {
    id: "prod-west-2",
    label: "Prod-West",
    host: "Prod-West",
    workspaceRoot: "",
    sessionCli: "",
    multiplexer: "tmux",
  });
});

test("configured SSH aliases are omitted case-insensitively, including user overrides", () => {
  const remotes = [
    { ...remote("prod"), host: "Prod-West" },
    { ...remote("staging"), host: "deploy@staging" },
  ];
  assert.deepEqual(
    unconfiguredSshAliases(["devbox", "prod-west", "STAGING"], remotes),
    ["devbox"],
  );
});

test("listed remotes edit as drafts and save trimmed, with empty fields as null", () => {
  const listed: RemoteChoice = {
    ...remote("devbox"),
    label: "Dev box",
    host: "dev@devbox",
    workspaceRoot: "~/work",
    sessionCli: null,
  };
  const draft = remoteSettingsDraft(listed);
  assert.deepEqual(draft, {
    id: "devbox",
    label: "Dev box",
    host: "dev@devbox",
    workspaceRoot: "~/work",
    sessionCli: "",
    multiplexer: "tmux",
  });
  assert.deepEqual(
    savedRemoteFromSettingsDraft({ ...draft, label: "  ", host: " dev@devbox ", workspaceRoot: " " }),
    { host: "dev@devbox", label: null, multiplexer: "tmux", sessionCli: null, workspaceRoot: null },
  );
});

test("new and copied drafts take unused ids, and copies are driveable", () => {
  assert.equal(newRemoteSettingsDraft([remote("remote")]).id, "remote-2");
  const copy = copiedRemoteSettingsDraft(
    { ...remote("shared"), label: "Shared", multiplexer: "herdr", source: "config" },
    [remote("shared"), remote("shared-copy")],
  );
  assert.equal(copy.id, "shared-copy-2");
  assert.equal(copy.label, "Shared copy");
  assert.equal(copy.multiplexer, "tmux");
});

test("drafts need a name, id and host, and new drafts a free id", () => {
  const draft = remoteDraftFromSshAlias("devbox", []);
  assert.equal(remoteSettingsDraftError(draft, true, []), null);
  assert.equal(
    remoteSettingsDraftError({ ...draft, host: " " }, true, []),
    "Name, ID, and SSH host are required.",
  );
  assert.equal(
    remoteSettingsDraftError(draft, true, [remote("devbox")]),
    "A remote with the ID “devbox” already exists.",
  );
  assert.equal(remoteSettingsDraftError(draft, false, [remote("devbox")]), null);
});
