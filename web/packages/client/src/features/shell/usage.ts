// The usage ring's numbers (02 §2.2 item 4, 03 K6): tone and accessible
// label, from the weekly allowance and what has been used of it.

export type UsageTone = "ok" | "warn" | "bad";

/** `ok` below 80 % used, `warn` from 80 %, `bad` from 95 %. */
export function usageTone(used: number, allowance: number): UsageTone {
  const share = allowance > 0 ? used / allowance : 1;
  if (share >= 0.95) return "bad";
  if (share >= 0.8) return "warn";
  return "ok";
}

/** The share used, clamped to 0..1: the arc's length. */
export function usedShare(used: number, allowance: number): number {
  if (allowance <= 0) return 1;
  return Math.min(1, Math.max(0, used / allowance));
}

/** Token counts as the mock prints them (`fmtTok`): 2M, 1.25M, 340k, 900. */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    if (count % 1_000_000 === 0) return `${count / 1_000_000}M`;
    return `${(count / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (count >= 1000) return `${Math.round(count / 1000)}k`;
  return String(count);
}

/** Time until the reset as the mock prints it (`resetIn`): "2 days 5 h",
 * "1 day 0 h", "7 h". */
export function formatResetIn(ms: number): string {
  const hours = Math.max(0, Math.round(ms / 3_600_000));
  const days = Math.floor(hours / 24);
  if (days === 0) return `${hours} h`;
  return `${days} day${days === 1 ? "" : "s"} ${hours % 24} h`;
}

export interface UsageReading {
  /** Included tokens used this week. */
  used: number;
  /** Included tokens per week (2,000,000, 03 K3). */
  allowance: number;
  /** When the week resets, in ms since the epoch; null when unknown. */
  resetsAt: number | null;
  /** When this reading was taken; shown while offline (02 §2.2 item 4). */
  readAt?: number | undefined;
}

/** "N of M included tokens left this week; resets in 2 days 5 h". */
export function usageLabel(reading: UsageReading, now: number = Date.now()): string {
  const left = Math.max(0, reading.allowance - reading.used);
  const base = `${formatTokens(left)} of ${formatTokens(reading.allowance)} included tokens left this week`;
  return reading.resetsAt === null
    ? base
    : `${base}; resets in ${formatResetIn(reading.resetsAt - now)}`;
}
