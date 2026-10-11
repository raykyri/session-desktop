import assert from "node:assert/strict";
import test from "node:test";
import { defaultGroupName, displayGroupName, formatGroupDir } from "../src/lib/groupNames";
import type { GroupInfo, PaneInfo } from "../src/types";

function group(overrides: Partial<GroupInfo> = {}): GroupInfo {
  return {
    id: "g",
    name: "",
    dir: "/Users/me/work/project",
    managedDir: "/Users/me/.session/g",
    createdAt: 0,
    collapsed: false,
    scope: "research",
    agents: [],
    ...overrides,
  };
}

function pane(overrides: Partial<PaneInfo> = {}): PaneInfo {
  return {
    id: "p",
    title: "shell",
    kind: "shell",
    groupId: "g",
    cwd: "/Users/me/elsewhere",
    cols: 80,
    rows: 24,
    status: "running",
    ...overrides,
  };
}

const roots = { workspaceRoot: "/Users/me/Session", homeDir: "/Users/me" };

test("directories are shown relative to the workspace root, then home", () => {
  assert.equal(formatGroupDir("/Users/me/Session/group-1/agent-1", roots), "group-1/agent-1");
  assert.equal(formatGroupDir("/Users/me", roots), "~");
  assert.equal(formatGroupDir("/Users/me/notes", roots), "~/notes");
  assert.equal(formatGroupDir("/opt/a/b/c", roots), "…/b/c");
  assert.equal(formatGroupDir("/opt/a", roots), "/opt/a");
  assert.equal(formatGroupDir("/opt/a/b/c", {}), "…/b/c");
});

test("a workspace root that is home anchors relative paths with ~/", () => {
  assert.equal(
    formatGroupDir("/Users/me/project", { workspaceRoot: "/Users/me", homeDir: "/Users/me" }),
    "~/project",
  );
});

test("a group is named by its first shell pane's directory, else its own", () => {
  const agentPane = pane({ id: "a", kind: "agent", cwd: "/tmp/worktree" });
  assert.equal(defaultGroupName(group(), [agentPane], roots), "project");
  assert.equal(defaultGroupName(group(), [agentPane, pane()], roots), "elsewhere");
  assert.equal(defaultGroupName(group(), [pane({ groupId: "other" })], roots), "project");
  assert.equal(defaultGroupName(group({ dir: "/" }), [], roots), "/");
});

test("a name override wins unless it is blank", () => {
  assert.equal(displayGroupName(group({ nameOverride: " Notes " }), [], roots), "Notes");
  assert.equal(displayGroupName(group({ nameOverride: "  " }), [], roots), "project");
  assert.equal(displayGroupName(group({ nameOverride: null }), [], roots), "project");
});
