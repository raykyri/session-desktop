import { findModel } from "@session/shared";

import { cn } from "../lib/cn.js";
import { formatRelativeTime } from "../lib/relativeTime.js";

import { formatResearchModelSummary } from "./ActivityMetadataLine.js";
import { Tooltip } from "./Tooltip.js";
import { FOCUS_RING } from "./surfaces.js";

/** Google Gemini's four-point sparkle (simple-icons / public-domain geometry). */
export function GeminiMark({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
    </svg>
  );
}

/** Model name as a Gemini mark with a hover tip. Imported threads stay text. */
export function ModelMeta({
  modelId,
  origin,
  at,
}: {
  modelId: string;
  origin?: string | null;
  at?: number | null;
}) {
  const imported = origin === "imported";
  const label = formatResearchModelSummary(modelId, origin) || findModel(modelId)?.label || modelId;
  const finite = at != null && Number.isFinite(at);

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {imported ? (
        <span>Imported</span>
      ) : (
        <Tooltip content={label}>
          <button
            type="button"
            aria-label={label}
            className={cn(
              "inline-flex shrink-0 rounded-sm border-0 bg-transparent p-0 text-inherit",
              FOCUS_RING,
            )}
          >
            <GeminiMark />
          </button>
        </Tooltip>
      )}
      {finite ? (
        <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
          {formatRelativeTime(at)}
        </time>
      ) : null}
    </span>
  );
}
