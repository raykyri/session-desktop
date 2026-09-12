import { findAgentUiAdapter } from "../adapters";
import type { ActivityEvent } from "../lib/activity";
import {
  CUSTOM_MODEL,
  formatLauncherModelLabel,
  modelPresetsFor,
} from "../lib/launcherModels";
import { formatRelativeTime } from "../lib/transcriptSessions";

function adapterDisplayLabel(adapter: string): string {
  if (!adapter) return "";
  return findAgentUiAdapter(adapter)?.label ?? formatLauncherModelLabel(adapter, adapter);
}

/** Preset names like Fable/Opus. Product ids (`gpt-5.6-sol`) and custom
 * slugs are omitted so the line can fall back to just the adapter. */
function humanReadableModelName(adapter: string, model?: string | null): string | null {
  if (!model || model === CUSTOM_MODEL) return null;
  if (!modelPresetsFor(adapter).includes(model)) return null;
  const label = formatLauncherModelLabel(adapter, model);
  if (/[\d._-]/.test(label)) return null;
  return label;
}

export function formatResearchAskedSummary(
  adapter: string,
  model?: string | null,
): string {
  const adapterLabel = adapterDisplayLabel(adapter);
  const modelName = humanReadableModelName(adapter, model);
  if (adapterLabel && modelName) return `You asked ${adapterLabel} ${modelName}`;
  if (adapterLabel) return `You asked ${adapterLabel}`;
  return "You asked";
}

/** One-line summary for activity contexts that choose to show it. */
export function formatActivityMetadataSummary(event: ActivityEvent): string {
  if (event.object.kind === "research-query") {
    if (event.relationship?.kind === "follow-up") {
      return `Follow-up in '${event.context?.label ?? "Research"}'`;
    }
    return formatResearchAskedSummary(
      event.execution?.adapter ?? "",
      event.execution?.model,
    );
  }
  return [event.actor.label, event.action.label, event.object.label].filter(Boolean).join(" ");
}

/** App-wide renderer for activity grammar slots. Metadata stays outside the
 * content surface because it describes the event, not the object payload. */
export default function ActivityMetadataLine({
  event,
  hideSummary = false,
}: {
  event: ActivityEvent;
  hideSummary?: boolean;
}) {
  const finiteTime = Number.isFinite(event.occurredAt);
  return (
    <div
      className={`activity-metadata${hideSummary ? " is-summary-hidden" : ""}`}
      title={finiteTime ? new Date(event.occurredAt).toLocaleString() : undefined}
    >
      {!hideSummary ? (
        <span className="activity-metadata-summary">{formatActivityMetadataSummary(event)}</span>
      ) : null}
      {finiteTime ? (
        <time dateTime={new Date(event.occurredAt).toISOString()}>
          {formatRelativeTime(event.occurredAt)}
        </time>
      ) : null}
    </div>
  );
}
