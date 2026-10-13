import type { AgentInfo } from "../types";

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
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

// On macOS the find shortcut is Cmd-F; on other platforms it is Ctrl-F. (On the
// Mac, Ctrl-F is the text system's forward-char.)
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

const AGENT_STATUSES_AT_REST = new Set<AgentInfo["status"]>([
  "done",
  "idle",
  "failed",
]);

export function displayPathsReferToSameDirectory(left: string, right: string): boolean {
  return normalizeDisplayPath(left) === normalizeDisplayPath(right);
}

function normalizeDisplayPath(value: string): string {
  const trimmed = value.replace(/\/+$/, "") || "/";
  return trimmed.replace(/^\/private\/(tmp|var)(?=\/|$)/, "/$1");
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

/** Resolves after the next frame has painted. */
export function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
