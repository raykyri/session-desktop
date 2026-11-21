// The Usage page's text (02 W8.1, 03 K5; the mock's `usageTop`,
// `usageRunsSection`, `resetShort`, `day`).

/** "2d 5h", "7h": the time until the reset, short (`resetShort`). */
export function resetShort(ms: number): string {
  const hours = Math.max(0, Math.round(ms / 3_600_000));
  const days = Math.floor(hours / 24);
  return days ? `${days}d ${hours % 24}h` : `${hours}h`;
}

/** The share of the allowance left, as a whole percent (`usageTop`). */
export function percentLeft(used: number, allowance: number): number {
  const share = allowance > 0 ? Math.min(1, Math.max(0, used / allowance)) : 1;
  return Math.round((1 - share) * 100);
}

// Weekdays and dates are written in the viewer's own time zone (03 K8; 02
// §3.3, §5): the reset is Friday 00:00 UTC, which is Thursday afternoon or
// evening west of UTC. `timeZone` is for tests; absent, the viewer's zone
// applies.

/** The weekday of `at` in the viewer's zone: "Friday", or "Fri" short. */
export function weekdayOf(at: number, short = false, timeZone?: string): string {
  return new Date(at).toLocaleDateString("en-US", {
    weekday: short ? "short" : "long",
    ...(timeZone === undefined ? {} : { timeZone }),
  });
}

/** "You have N% of usage left this week. Next reset on Fri, in 2d 5h." */
export function usageSentence(
  reading: { used: number; allowance: number; resetAt: number },
  now: number,
  timeZone?: string,
): { percent: number; weekday: string; resetIn: string } {
  return {
    percent: percentLeft(reading.used, reading.allowance),
    weekday: weekdayOf(reading.resetAt, true, timeZone),
    resetIn: resetShort(reading.resetAt - now),
  };
}

/** A run's date in the viewer's zone, "Nov 21" (`day`). */
export function runDay(at: number, timeZone?: string): string {
  return new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(timeZone === undefined ? {} : { timeZone }),
  });
}

/** The out-of-tokens toast (03 K8; 02 §5, `OUT_MSG`) with the weekday of the
 * reset in the viewer's zone; with no reset known it names the weekly reset
 * instead. */
export function outOfTokensText(resetAt: number | null, timeZone?: string): string {
  const until = resetAt === null ? "the weekly reset" : weekdayOf(resetAt, false, timeZone);
  return `You're out of tokens until ${until}. You can still post, or add an API key in Usage.`;
}

export type RunBill = "included" | "key:anthropic" | "key:openai" | "included+key:anthropic";

const BILL_LABEL: Record<Exclude<RunBill, "included">, string> = {
  "key:anthropic": "Anthropic key",
  "key:openai": "OpenAI key",
  "included+key:anthropic": "Included + Anthropic key",
};

/** What a run row shows before its date: the share of the weekly allowance
 * ("<1%" below 0.5 %) for an included run, else who paid (03 K5). */
export function runCharge(run: { bill: RunBill; share: number }): string {
  if (run.bill !== "included") return BILL_LABEL[run.bill];
  return run.share < 0.005 ? "<1%" : `${Math.round(run.share * 100)}%`;
}

/** A run's question, or why it has none (03 K5; 02 W8.1). */
export function runQuestion(run: {
  question: string | null;
  missing: "removed" | "unavailable" | null;
}): { text: string; gone: boolean } {
  if (run.question !== null) return { text: run.question, gone: false };
  return { text: run.missing === "removed" ? "Removed" : "No longer available", gone: true };
}
