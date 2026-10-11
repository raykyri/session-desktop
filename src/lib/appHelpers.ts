import { findAgentUiAdapter } from "../adapters";
import type {
  AgentInfo,
  PaneInfo,
  PaneSplitInfo,
  RuntimeConfig,
} from "../types";

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** Inset kept between a pointer-anchored context menu and the window edge. */
export const CONTEXT_MENU_VIEWPORT_MARGIN = 8;

/**
 * Keep a fixed-position context menu inside the window. `x`/`y` are the
 * preferred top-left (usually the pointer). When the menu would run off the
 * bottom or right edge, it shifts up/left; a menu taller than the window pins
 * to the top margin (CSS `max-height` then scrolls the rest).
 */
export function clampContextMenuToViewport(args: {
  x: number;
  y: number;
  width: number;
  height: number;
  margin?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}): { x: number; y: number } {
  const margin = args.margin ?? CONTEXT_MENU_VIEWPORT_MARGIN;
  const viewportWidth =
    args.viewportWidth ??
    (typeof window === "undefined" ? args.x + args.width + margin : window.innerWidth);
  const viewportHeight =
    args.viewportHeight ??
    (typeof window === "undefined" ? args.y + args.height + margin : window.innerHeight);
  return {
    x: clamp(args.x, margin, Math.max(margin, viewportWidth - margin - args.width)),
    y: clamp(args.y, margin, Math.max(margin, viewportHeight - margin - args.height)),
  };
}

const DEFAULT_SHELL_TITLE = "Shell";

/** The title a pane is created with ("Shell" or the adapter's label). A pane
 * whose stored title differs has been renamed or auto-titled; shared by the
 * sidebar and the quick launcher so both resolve tab names by the same rule. */
export function defaultPaneTitle(
  pane: PaneInfo,
  agent: AgentInfo | undefined,
  config: RuntimeConfig | null,
): string | null {
  if (pane.kind === "shell") {
    return DEFAULT_SHELL_TITLE;
  }
  if (!agent) {
    return null;
  }
  return (
    config?.adapters.find((adapter) => adapter.id === agent.adapter)?.label ??
    findAgentUiAdapter(agent.adapter)?.label ??
    null
  );
}

/** Fixed-position placement for a popover anchored to a control inside a pane. */
type PanePopoverPlacement = {
  left: number;
  top: number;
  maxHeight: number;
  maxWidth: number;
};

/**
 * Place a fixed popover next to a trigger, clamped inside the viewport.
 * Horizontal `align: "start"` left-aligns to the trigger and
 * grows right (toward center for left-edge controls); `"end"` right-aligns and
 * grows left (toward center for right-edge controls). Vertical preference flips
 * when the other side has more room.
 */
export function placePanePopover(args: {
  triggerRect: DOMRect;
  popoverSize: { width: number; height: number };
  align: "start" | "end";
  prefer: "above" | "below";
  margin?: number;
  gap?: number;
}): PanePopoverPlacement {
  const margin = args.margin ?? 8;
  const gap = args.gap ?? 6;
  const boundLeft = margin;
  const boundRight = window.innerWidth - margin;
  const boundTop = margin;
  const boundBottom = window.innerHeight - margin;
  const maxWidth = Math.max(0, boundRight - boundLeft);
  const width = Math.min(args.popoverSize.width, maxWidth);

  let left =
    args.align === "end" ? args.triggerRect.right - width : args.triggerRect.left;
  // When the popover is wider than the bounds, pin to the inward edge so it
  // grows toward the center rather than spilling off the outer edge.
  if (width >= maxWidth) {
    left = boundLeft;
  } else {
    left = Math.max(boundLeft, Math.min(left, boundRight - width));
  }

  const availableAbove = Math.max(0, args.triggerRect.top - gap - boundTop);
  const availableBelow = Math.max(0, boundBottom - (args.triggerRect.bottom + gap));

  let prefer = args.prefer;
  if (
    prefer === "below" &&
    args.popoverSize.height > availableBelow &&
    availableAbove > availableBelow
  ) {
    prefer = "above";
  } else if (
    prefer === "above" &&
    args.popoverSize.height > availableAbove &&
    availableBelow > availableAbove
  ) {
    prefer = "below";
  }

  const maxHeight = prefer === "above" ? availableAbove : availableBelow;
  const height = Math.min(args.popoverSize.height, maxHeight);
  const top =
    prefer === "above"
      ? args.triggerRect.top - gap - height
      : args.triggerRect.bottom + gap;

  return {
    left,
    top: clamp(top, boundTop, Math.max(boundTop, boundBottom - height)),
    maxHeight,
    maxWidth,
  };
}

export function selectPaneAfterClose(
  panes: PaneInfo[],
  closedPaneId: string,
  paneSplits: PaneSplitInfo[] = [],
  options?: {
    isPaneInCollapsedGroup?: (pane: PaneInfo) => boolean;
  },
): string | null {
  const selectPreferredPane = (candidates: PaneInfo[]) => {
    if (candidates.length === 0) {
      return null;
    }
    const isPaneInCollapsedGroup = options?.isPaneInCollapsedGroup;
    if (!isPaneInCollapsedGroup) {
      return candidates[0].id;
    }
    return candidates.find((pane) => !isPaneInCollapsedGroup(pane))?.id ?? candidates[0].id;
  };

  const closedIndex = panes.findIndex((pane) => pane.id === closedPaneId);
  if (closedIndex === -1) {
    return selectPreferredPane(panes);
  }

  const availablePaneIds = new Set(panes.map((pane) => pane.id));
  availablePaneIds.delete(closedPaneId);
  const paneById = new Map(panes.map((pane) => [pane.id, pane]));
  const candidates: PaneInfo[] = [];
  const candidateIds = new Set<string>();
  const addCandidate = (paneId?: string) => {
    if (!paneId || paneId === closedPaneId || candidateIds.has(paneId)) {
      return;
    }
    if (!availablePaneIds.has(paneId)) {
      return;
    }
    const pane = paneById.get(paneId);
    if (!pane) {
      return;
    }
    candidateIds.add(paneId);
    candidates.push(pane);
  };

  const split = paneSplits.find((candidate) => candidate.paneIds.includes(closedPaneId));
  const splitIndex = split?.paneIds.indexOf(closedPaneId) ?? -1;
  if (split && splitIndex >= 0) {
    for (let index = splitIndex - 1; index >= 0; index -= 1) {
      addCandidate(split.paneIds[index]);
    }
    for (let index = splitIndex + 1; index < split.paneIds.length; index += 1) {
      addCandidate(split.paneIds[index]);
    }
  }

  const closedGroupId = panes[closedIndex].groupId;
  for (let offset = 1; offset < panes.length; offset += 1) {
    const previous = panes[closedIndex - offset];
    const next = panes[closedIndex + offset];
    addCandidate(previous?.groupId === closedGroupId ? previous.id : undefined);
    addCandidate(next?.groupId === closedGroupId ? next.id : undefined);
  }

  for (let offset = 1; offset < panes.length; offset += 1) {
    addCandidate(panes[closedIndex - offset]?.id);
    addCandidate(panes[closedIndex + offset]?.id);
  }

  return selectPreferredPane(candidates);
}

// Validates an agent payload arriving on an event before it is applied to local
// state, mirroring isTurn. Status events now carry the updated agent so the UI can
// apply changes surgically instead of refetching the whole list every time.
export function isAgentInfo(value: unknown): value is AgentInfo {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const agent = value as Record<string, unknown>;
  return (
    typeof agent.id === "string" &&
    typeof agent.adapter === "string" &&
    typeof agent.status === "string"
  );
}

// Applies a single updated agent to the list: replaces it in place when present,
// otherwise appends it (e.g. a freshly spawned agent), preserving order.
//
// Returns the previous array itself when the incoming agent is content-equal to
// the stored one. A busy agent's hook stream (PreToolUse/PostToolUse per tool
// call) mostly re-delivers a byte-identical agent, and handing out a fresh
// array for every event committed a full-app render and invalidated every
// agents-keyed memo (turn-info cache, tray snapshot, home cascades) each time.
// Agents are small flat payloads, so one JSON comparison per event is far
// cheaper than the render it avoids.
export function upsertAgent(agents: AgentInfo[], updated: AgentInfo): AgentInfo[] {
  let unchanged = false;
  let replaced = false;
  const next = agents.map((agent) => {
    if (agent.id === updated.id) {
      replaced = true;
      if (JSON.stringify(agent) === JSON.stringify(updated)) {
        unchanged = true;
        return agent;
      }
      return updated;
    }
    return agent;
  });
  if (!replaced) {
    return [...next, updated];
  }
  return unchanged ? agents : next;
}

// On macOS the find shortcut is Cmd-F; on other platforms it is Ctrl-F. (Ctrl-F
// is readline's forward-char, so on the Mac we leave it for the terminal.)
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

export function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

const TERMINAL_PANE_CLASS = "terminal-pane";

export function isTerminalTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && target.closest(`.${TERMINAL_PANE_CLASS}`) !== null;
}

export function agentStatusLabel(status: AgentInfo["status"]) {
  switch (status) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "awaitingInput":
      return "Awaiting input";
    case "awaitingPermission":
      return "Waiting on approval";
    case "done":
      return "Done";
    case "idle":
      return null;
    case "failed":
      return "Failed";
  }
}

/** Workspace metadata can arrive in a full AgentInfo payload, but it is not
 * evidence that the agent's execution lifecycle changed. */
export function agentEventAffectsThinkingState(eventType: string): boolean {
  return eventType !== "agent.workspace_changed";
}

const AGENT_STATUSES_AT_REST = new Set<AgentInfo["status"]>([
  "done",
  "idle",
  "failed",
]);

/** The live command cwd is display-only; lifecycle operations continue to use
 * AgentInfo.worktreeDir and AgentInfo.branch directly. */
export function agentDisplayDirectory(agent: AgentInfo | undefined, paneCwd: string): string {
  return agent?.activeWorkspace?.cwd ?? agent?.worktreeDir ?? paneCwd;
}

/** True when the observed command cwd is a different directory than the launch
 * worktree. macOS aliases `/tmp` as `/private/tmp` (and `/var` as
 * `/private/var`), so a raw string compare would always show a redundant
 * Launch directory row after canonicalize. */
export function agentShowsLaunchDirectory(agent: AgentInfo | undefined): boolean {
  const cwd = agent?.activeWorkspace?.cwd;
  if (!agent || !cwd) {
    return false;
  }
  return !displayPathsReferToSameDirectory(cwd, agent.worktreeDir);
}

export function displayPathsReferToSameDirectory(left: string, right: string): boolean {
  return normalizeDisplayPath(left) === normalizeDisplayPath(right);
}

function normalizeDisplayPath(value: string): string {
  const trimmed = value.replace(/\/+$/, "") || "/";
  return trimmed.replace(/^\/private\/(tmp|var)(?=\/|$)/, "/$1");
}

export function agentDisplayBranch(agent: AgentInfo | undefined): string | null {
  return agent?.activeWorkspace
    ? (agent.activeWorkspace.branch ?? null)
    : (agent?.branch ?? null);
}

export function agentDisplayWorktreeRoot(agent: AgentInfo | undefined): string | null {
  if (agent?.activeWorkspace) {
    return agent.activeWorkspace.kind === "linkedWorktree"
      ? (agent.activeWorkspace.gitRoot ?? null)
      : null;
  }
  return agent?.branch ? agent.worktreeDir : null;
}

export function agentDisplayCheckoutRoot(agent: AgentInfo | undefined): string | null {
  return agent?.activeWorkspace
    ? (agent.activeWorkspace.gitRoot ?? null)
    : agent?.branch
      ? agent.worktreeDir
      : null;
}

function paneDisplayCheckoutRoot(pane: PaneInfo, agent: AgentInfo | undefined): string | null {
  return agent
    ? agentDisplayCheckoutRoot(agent)
    : (pane.activeWorkspace?.gitRoot ?? null);
}

function paneDisplayDirectory(pane: PaneInfo, agent: AgentInfo | undefined): string {
  return agentDisplayDirectory(agent, pane.cwd);
}

/**
 * Names a tab's checkout when it differs from the group's. Recovered first
 * shells often reopen in an agent worktree; that tab must not become the
 * baseline or every main-checkout tab looks "outside" the group.
 */
export function paneBranchLocationLabel(
  pane: PaneInfo,
  agent: AgentInfo | undefined,
  firstPane: PaneInfo | undefined,
  firstAgent: AgentInfo | undefined,
  groupDir?: string,
): string | null {
  const branch = agent
    ? agentDisplayBranch(agent)
    : (pane.activeWorkspace?.branch ?? null);
  const checkoutRoot = paneDisplayCheckoutRoot(pane, agent);
  if (!branch || !checkoutRoot) {
    return null;
  }

  const firstCheckoutRoot = firstPane
    ? paneDisplayCheckoutRoot(firstPane, firstAgent)
    : null;
  const firstLocation = firstPane
    ? paneDisplayDirectory(firstPane, firstAgent)
    : groupDir;
  const baseline =
    groupCheckoutBaseline(groupDir, firstCheckoutRoot) ??
    groupDir ??
    firstLocation;
  if (!baseline) {
    return null;
  }
  if (displayPathsReferToSameDirectory(checkoutRoot, baseline)) {
    return null;
  }
  // The group's directory (or a just-spawned first tab's cwd) still proves
  // this tab is the group's checkout when git metadata has not landed yet.
  const normalizedRoot = normalizeDisplayPath(checkoutRoot);
  const normalizedBaseline = normalizeDisplayPath(baseline);
  const rootPrefix = normalizedRoot === "/" ? "/" : `${normalizedRoot}/`;
  if (normalizedBaseline.startsWith(rootPrefix)) {
    return null;
  }

  const name = checkoutRoot.split("/").filter(Boolean).pop();
  return name || checkoutRoot;
}

function groupCheckoutBaseline(
  groupDir: string | undefined,
  firstCheckoutRoot: string | null,
): string | null {
  if (!firstCheckoutRoot) {
    return null;
  }
  if (!groupDir) {
    return firstCheckoutRoot;
  }
  const normalizedGroup = normalizeDisplayPath(groupDir);
  const normalizedRoot = normalizeDisplayPath(firstCheckoutRoot);
  const rootPrefix = normalizedRoot === "/" ? "/" : `${normalizedRoot}/`;
  // A worktree under the group folder is a different git root. Only treat the
  // first tab as the group checkout when its root *is* the group directory or
  // the group directory lives inside that checkout.
  if (
    displayPathsReferToSameDirectory(normalizedRoot, normalizedGroup) ||
    normalizedGroup.startsWith(rootPrefix)
  ) {
    return firstCheckoutRoot;
  }
  return null;
}

/** Whether an agent may still be doing work and should keep the machine awake.
 * Permission and user-feedback waits remain inside an unfinished turn, so they
 * keep the wake lock. Using a resting-state denylist also makes an unexpected
 * future status fail safe by retaining the lock. */
export function agentStatusKeepsMachineAwake(status: AgentInfo["status"]): boolean {
  return !AGENT_STATUSES_AT_REST.has(status);
}

/** The frontend must not release a backend-owned wake lock until its agent
 * snapshot is authoritative. During a WebContent reload, React initially has
 * an empty agent list while `listAgents()` is still in flight; treating that
 * placeholder as "no busy agents" creates a brief assertion gap in which macOS
 * can commit to idle sleep. `null` means leave the backend's current state
 * untouched until hydration succeeds. */
export function desiredPreventSleepState(
  agentsHydrated: boolean,
  settingEnabled: boolean,
  anyAgentBusy: boolean,
): boolean | null {
  if (!agentsHydrated) {
    return null;
  }
  return settingEnabled && anyAgentBusy;
}

type AgentStatusTone = "active" | "pending" | "attention" | "done" | "error" | "idle";

// Maps an agent status onto the status-dot tones used by the pane detail popover.
export function agentStatusTone(status: AgentInfo["status"]): AgentStatusTone {
  switch (status) {
    case "running":
      return "active";
    case "starting":
      return "pending";
    case "awaitingInput":
    case "awaitingPermission":
      return "attention";
    case "done":
      return "done";
    case "failed":
      return "error";
    case "idle":
    default:
      return "idle";
  }
}

/** Resolves after the next frame has painted. */
export function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
