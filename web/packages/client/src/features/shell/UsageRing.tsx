// The usage ring (02 §2.2 item 4; `meter`): an 18 px ring at every width,
// an arc for the share used over a full-circle track, no visible text. Its
// tone is `ok` below 80 % used, `warn` from 80 %, `bad` from 95 %. It opens
// `/usage`.

import { Link } from "@tanstack/react-router";

import { cn } from "../../lib/cn.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

import { usageLabel, usageTone, usedShare, type UsageReading } from "./usage.js";

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const TONE_STROKE = {
  ok: "stroke-accent-strong",
  warn: "stroke-status-active",
  bad: "stroke-status-attention",
} as const;

/** `reading` null: no current reading (not loaded, failed, or past its
 * reset); the ring then draws its track alone and says so in its label.
 * `offline`: the label names when the reading was taken. */
export function UsageRing({
  reading,
  now,
  offline = false,
}: {
  reading: UsageReading | null;
  now?: number;
  offline?: boolean;
}) {
  const tone = reading ? usageTone(reading.used, reading.allowance) : undefined;
  const share = reading ? usedShare(reading.used, reading.allowance) : 0;
  return (
    <Link
      to="/usage"
      aria-label={usageLabel(reading, now, { offline })}
      data-tone={tone}
      className={cn(
        "text-fg-secondary hover:bg-surface-fill-hover relative inline-flex h-[30px] shrink-0 items-center rounded-[15px] px-2.5 narrow:px-1.5",
        FOCUS_RING,
      )}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 18 18"
        aria-hidden="true"
        focusable="false"
        className="block -rotate-90"
      >
        {/* The track is the mockup's `--border-strong`, the value `--tree-rail` holds. */}
        <circle cx="9" cy="9" r={RADIUS} fill="none" strokeWidth="3" className="stroke-tree-rail" />
        {tone ? (
          <circle
            cx="9"
            cy="9"
            r={RADIUS}
            fill="none"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${(CIRCUMFERENCE * share).toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`}
            className={TONE_STROKE[tone]}
          />
        ) : null}
      </svg>
    </Link>
  );
}
