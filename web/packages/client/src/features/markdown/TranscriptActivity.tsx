// Tool-call, tool-result and thinking disclosures under an answer
// (`09-research-document-view.md` §7). Ported from the desktop
// `TranscriptActivity.tsx`; the CSS moves to utilities and the class names the
// selection code hit-tests against (`tool-block`, `thinking-block`,
// `activity-group-block`) are kept, because "This selector distinguishes model response prose from tool call activity rows.
// (`selection/dom.ts:NON_TEXT_ROW_SELECTOR`).

import { formatEstimatedTokenCount, thinkingProseText } from "@session/shared";
import type {
  ActivityGroupItem,
  ActivityItem,
  ActivityLeafItem,
  ThinkingItem,
  ToolEntry,
  TurnTimelineContextStatus,
  TurnTimelineStatus,
} from "@session/shared";
import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/cn.js";

import { ResearchMarkdown } from "./ResearchMarkdown.js";
import { ACTIVITY_PAYLOAD_CHAR_LIMIT, OVERSIZED_THINKING_MARKDOWN } from "./policy.js";

const DISCLOSURE =
  "group my-0.5 rounded-md text-fg-subtle text-sm [&>summary]:flex [&>summary]:cursor-pointer " +
  "[&>summary]:list-none [&>summary]:items-center [&>summary]:gap-1.5 [&>summary]:py-0.5 " +
  "[&>summary::-webkit-details-marker]:hidden";

const PAYLOAD_PRE =
  "my-1 max-h-80 overflow-auto rounded-md bg-surface-code p-2 font-mono text-xs whitespace-pre-wrap";

export function timelineStatusClass(status: TurnTimelineStatus | undefined): string {
  return status ? ` is-status-${status}` : "";
}

export function timelineContextStatusClass(status: TurnTimelineContextStatus | undefined): string {
  return status === "rolledBack" ? " is-context-rolled-back" : "";
}

export function serializeActivityValue(value: unknown, maxCharacters?: number): string {
  let serialized: string;
  try {
    serialized =
      typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    serialized = "(the payload could not be serialized)";
  }
  if (maxCharacters && serialized.length > maxCharacters) {
    return `${serialized.slice(0, maxCharacters)}\n… (truncated)`;
  }
  return serialized;
}

export function DisclosureChevron() {
  return (
    <ChevronRight
      className="text-fg-faint shrink-0 transition-transform group-open:rotate-90"
      size={12}
      aria-hidden="true"
    />
  );
}

const TOOL_SUMMARY_ARGUMENT_KEYS: Record<string, string> = {
  web_search: "query",
  web_fetch: "url",
  google_search: "query",
  read_document: "documentId",
};

const TOOL_ACTION_NAMES = {
  readFile: new Set(["read", "read_file", "read_document", "glob", "grep", "ls"]),
  search: new Set(["web_search", "websearch", "google_search", "search"]),
  fetch: new Set(["web_fetch", "webfetch", "fetch"]),
} as const;

type ToolActionKind = keyof typeof TOOL_ACTION_NAMES;

function normalizedToolName(name: string): string {
  const raw = name.trim();
  const dotted = raw.includes(".") ? (raw.split(".").pop() ?? raw) : raw;
  const namespaced = dotted.includes("__") ? (dotted.split("__").pop() ?? dotted) : dotted;
  return namespaced.replace(/[\s-]+/g, "_").toLowerCase();
}

function classifyToolAction(entry: ToolEntry): ToolActionKind | null {
  const name = normalizedToolName(entry.name);
  for (const [kind, names] of Object.entries(TOOL_ACTION_NAMES) as [
    ToolActionKind,
    ReadonlySet<string>,
  ][]) {
    if (names.has(name)) return kind;
  }
  return null;
}

export function uniqueToolEntries(items: ActivityLeafItem[]): ToolEntry[] {
  const seen = new Set<string>();
  const entries: ToolEntry[] = [];
  for (const item of items) {
    if (item.type !== "tool") continue;
    const key = item.id ? `id:${item.id}` : `entry:${item.key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(item);
  }
  return entries;
}

function countLabel(verb: string, count: number): string | null {
  if (count === 0) return null;
  return count === 1 ? `${verb} once` : `${verb} ${count} times`;
}

export function toolActionGroupLabel(entries: ToolEntry[]): string | null {
  const counts: Record<ToolActionKind, number> = { readFile: 0, search: 0, fetch: 0 };
  let unknown = 0;
  for (const entry of entries) {
    const kind = classifyToolAction(entry);
    if (kind) counts[kind] += 1;
    else unknown += 1;
  }
  if (counts.readFile + counts.search + counts.fetch === 0) return null;
  const parts = [
    counts.search === 0
      ? null
      : counts.search === 1
        ? "searched the web"
        : `ran ${counts.search} searches`,
    countLabel("fetched a page", counts.fetch),
    countLabel("read a document", counts.readFile),
    unknown > 0 ? `called ${unknown} other tool${unknown === 1 ? "" : "s"}` : null,
  ].filter((part): part is string => Boolean(part));
  const label = parts.join(", ");
  return label.length > 0 ? `${label[0]!.toUpperCase()}${label.slice(1)}` : label;
}

export function activityGroupLabel(group: ActivityGroupItem): string {
  const entries = uniqueToolEntries(group.children);
  if (entries.length === 0) return "Reasoning process";
  return (
    toolActionGroupLabel(entries) ??
    `Called ${group.toolCallCount} tool${group.toolCallCount === 1 ? "" : "s"}`
  );
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolSummaryArgument(entry: ToolEntry): string | null {
  const key = TOOL_SUMMARY_ARGUMENT_KEYS[normalizedToolName(entry.name)];
  if (!key) return null;
  const input = objectValue(entry.input);
  const value = input?.[key];
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

// The "~N tok" label is visible without expanding, so it cannot be deferred —
// but serializing a large result costs O(result) and the timeline re-mounts
// whenever the page changes. Result objects are immutable and identity-stable
// across refetches, so the formatted estimate is cached per object.
const tokenEstimateByValue = new WeakMap<object, string>();

function serializedActivityTokenEstimate(value: unknown): string {
  if (typeof value === "string") return formatEstimatedTokenCount(value);
  if (typeof value === "object" && value !== null) {
    let estimate = tokenEstimateByValue.get(value);
    if (estimate === undefined) {
      estimate = formatEstimatedTokenCount(serializeActivityValue(value));
      tokenEstimateByValue.set(value, estimate);
    }
    return estimate;
  }
  return formatEstimatedTokenCount(serializeActivityValue(value));
}

function ToolEntryStatus({ entry, showTokenCount }: { entry: ToolEntry; showTokenCount: boolean }) {
  if (entry.result === undefined)
    return <span className="text-fg-faint ml-auto text-xs">running</span>;
  if (!showTokenCount) {
    return entry.isError ? <span className="text-status-failed ml-auto text-xs">error</span> : null;
  }
  const tokens = serializedActivityTokenEstimate(entry.result);
  return (
    <span className="text-fg-faint ml-auto text-xs">
      {entry.isError ? <span className="text-status-failed">error</span> : null}
      {entry.isError ? " · " : null}
      {tokens}
    </span>
  );
}

function ToolPayload({
  label,
  value,
  maxPayloadCharacters,
}: {
  label: string;
  value: unknown;
  maxPayloadCharacters?: number;
}) {
  return (
    <div className="pl-4">
      <div className="text-fg-faint text-xs">{label}</div>
      <pre className={PAYLOAD_PRE}>{serializeActivityValue(value, maxPayloadCharacters)}</pre>
    </div>
  );
}

function ToolEntryView({
  entry,
  className,
  showChevron,
  maxPayloadCharacters,
  showResultTokenCount,
}: {
  entry: ToolEntry;
  className?: string;
  showChevron: boolean;
  maxPayloadCharacters?: number;
  showResultTokenCount: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const argument = toolSummaryArgument(entry);
  const name = showChevron ? entry.name : `Called ${entry.name}`;
  const summary = argument ? `${name} ${argument}` : name;
  return (
    <details
      className={cn(
        "tool-block",
        DISCLOSURE,
        entry.isError && "text-status-failed",
        className,
        timelineStatusClass(entry.status).trim(),
      )}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        {showChevron ? <DisclosureChevron /> : null}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="min-w-0 truncate" title={summary}>
            <span>{name}</span>
            {argument ? <span className="text-fg-faint"> {argument}</span> : null}
          </span>
          <ToolEntryStatus entry={entry} showTokenCount={showChevron && showResultTokenCount} />
        </span>
      </summary>
      {expanded && entry.input !== undefined ? (
        <ToolPayload
          label="Input"
          value={entry.input}
          {...(maxPayloadCharacters === undefined ? {} : { maxPayloadCharacters })}
        />
      ) : null}
      {expanded && entry.result !== undefined ? (
        <ToolPayload
          label={entry.isError ? "Error" : "Result"}
          value={entry.result}
          {...(maxPayloadCharacters === undefined ? {} : { maxPayloadCharacters })}
        />
      ) : null}
    </details>
  );
}

function ThinkingView({
  item,
  className,
  showChevron,
  maxPayloadCharacters,
  deferPayloads,
}: {
  item: ThinkingItem;
  className?: string;
  showChevron: boolean;
  maxPayloadCharacters?: number;
  deferPayloads: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className={cn(
        "thinking-block",
        DISCLOSURE,
        className,
        timelineStatusClass(item.status).trim(),
      )}
      onToggle={deferPayloads ? (event) => setExpanded(event.currentTarget.open) : undefined}
    >
      <summary>
        {showChevron ? <DisclosureChevron /> : null}
        <span>Reasoning process</span>
      </summary>
      {!deferPayloads || expanded
        ? item.values.map((value, index) => {
            const key = `${item.key}-${index}`;
            // A recognized reasoning shape renders as prose, dropping the
            // opaque `signature` blob that would otherwise dominate a JSON
            // dump; anything unfamiliar still falls back to serialized JSON so
            // nothing is silently lost.
            const prose = thinkingProseText(value);
            if (prose !== null) {
              return (
                <div key={key} className="text-fg-muted pl-4">
                  <ResearchMarkdown
                    markdown={prose}
                    variant="compact"
                    oversized={OVERSIZED_THINKING_MARKDOWN}
                  />
                </div>
              );
            }
            return (
              <pre key={key} className={PAYLOAD_PRE}>
                {serializeActivityValue(value, maxPayloadCharacters)}
              </pre>
            );
          })
        : null}
    </details>
  );
}

function ActivityGroupView({
  group,
  className,
  showChevron,
  maxPayloadCharacters,
  deferPayloads,
  showResultTokenCount,
}: {
  group: ActivityGroupItem;
  className?: string;
  showChevron: boolean;
  maxPayloadCharacters?: number;
  deferPayloads: boolean;
  showResultTokenCount: boolean;
}) {
  return (
    <details
      className={cn(
        "activity-group-block",
        DISCLOSURE,
        className,
        timelineStatusClass(group.status).trim(),
      )}
    >
      <summary>
        {showChevron ? <DisclosureChevron /> : null}
        <span>{activityGroupLabel(group)}</span>
      </summary>
      <div className="border-border-faint ml-1.5 border-l pl-2.5">
        {group.children.map((child) => (
          <TranscriptActivityItem
            key={child.key}
            item={child}
            {...(maxPayloadCharacters === undefined ? {} : { maxPayloadCharacters })}
            deferPayloads={deferPayloads}
            showResultTokenCount={showResultTokenCount}
          />
        ))}
      </div>
    </details>
  );
}

export function TranscriptActivityItem({
  item,
  className,
  isRootActivity = false,
  maxPayloadCharacters,
  deferPayloads = false,
  showResultTokenCount = true,
}: {
  item: ActivityItem;
  className?: string;
  /** Whether this activity spans the full answer width without a chevron. */
  isRootActivity?: boolean;
  maxPayloadCharacters?: number;
  deferPayloads?: boolean;
  showResultTokenCount?: boolean;
}) {
  switch (item.type) {
    case "tool":
      return (
        <ToolEntryView
          entry={item}
          {...(className === undefined ? {} : { className })}
          showChevron={!isRootActivity}
          {...(maxPayloadCharacters === undefined ? {} : { maxPayloadCharacters })}
          showResultTokenCount={showResultTokenCount}
        />
      );
    case "thinking":
      return (
        <ThinkingView
          item={item}
          {...(className === undefined ? {} : { className })}
          showChevron={!isRootActivity}
          {...(maxPayloadCharacters === undefined ? {} : { maxPayloadCharacters })}
          deferPayloads={deferPayloads}
        />
      );
    case "activityGroup":
      return (
        <ActivityGroupView
          group={item}
          {...(className === undefined ? {} : { className })}
          showChevron={!isRootActivity}
          {...(maxPayloadCharacters === undefined ? {} : { maxPayloadCharacters })}
          deferPayloads={deferPayloads}
          showResultTokenCount={showResultTokenCount}
        />
      );
  }
}

/** The `raw` block escape hatch: a provider payload the timeline could not
 * classify, kept verbatim behind a disclosure so nothing is lost. */
export function RawTranscriptDisclosure({
  value,
  maxPayloadCharacters = ACTIVITY_PAYLOAD_CHAR_LIMIT,
  deferPayload = false,
  className,
}: {
  value: unknown;
  maxPayloadCharacters?: number;
  deferPayload?: boolean;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className={cn("tool-block", DISCLOSURE, className)}
      onToggle={deferPayload ? (event) => setExpanded(event.currentTarget.open) : undefined}
    >
      <summary>
        <DisclosureChevron />
        <span>Raw</span>
      </summary>
      {!deferPayload || expanded ? (
        <pre className={PAYLOAD_PRE}>{serializeActivityValue(value, maxPayloadCharacters)}</pre>
      ) : null}
    </details>
  );
}
