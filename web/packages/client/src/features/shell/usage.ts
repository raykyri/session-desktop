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

/**
 * Token counts as the mock prints them (`fmtTok`): 2M, 1.25M, 340k, 900.
 * Rounded to the nearest, a count that rounds to 1000k reads 1M. With
 * `down` the count is rounded down instead, so an allowance with anything
 * used never reads as the whole allowance ("1.99M of 2M", not "2M of 2M").
 */
export function formatTokens(count: number, down = false): string {
  if (count >= 1_000_000) {
    if (count % 1_000_000 === 0) return `${count / 1_000_000}M`;
    const millions = down
      ? (Math.floor(count / 10_000) / 100).toFixed(2)
      : (count / 1_000_000).toFixed(2);
    return `${millions.replace(/\.?0+$/, "")}M`;
  }
  if (count >= 1000) {
    const thousands = down ? Math.floor(count / 1000) : Math.round(count / 1000);
    return thousands >= 1000 ? "1M" : `${thousands}k`;
  }
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

/** The reading while it describes the current week: null when there is
 * none, or when its week has already reset (`resetsAt` at or before `now`),
 * since what it says was used no longer counts (03 K6, K8). */
export function currentReading(reading: UsageReading | null, now: number): UsageReading | null {
  if (reading === null) return null;
  return reading.resetsAt !== null && reading.resetsAt <= now ? null : reading;
}

/** The ring's label with no current reading (before `usage.get` answers,
 * when it fails, or after the reading's reset). */
export const UNKNOWN_USAGE_LABEL = "Included tokens left this week: unknown";

/** When a reading was taken, in the viewer's zone: "3:05 PM" on the day of
 * `now`, else "Nov 20, 3:05 PM". */
export function readTime(at: number, now: number, timeZone?: string): string {
  const zone = timeZone === undefined ? {} : { timeZone };
  const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", zone);
  const time = new Date(at).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...zone,
  });
  if (day(at) === day(now)) return time;
  const date = new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...zone,
  });
  return `${date}, ${time}`;
}

/**
 * "N of M included tokens left this week; resets in 2 days 5 h". Offline
 * (02 §2.2 item 4) it names when the reading was taken: "… left this week as
 * of 3:05 PM; resets in …". With no current reading it is
 * `UNKNOWN_USAGE_LABEL`.
 */
export function usageLabel(
  reading: UsageReading | null,
  now: number = Date.now(),
  options: { offline?: boolean; timeZone?: string } = {},
): string {
  if (reading === null) return UNKNOWN_USAGE_LABEL;
  const left = Math.max(0, reading.allowance - reading.used);
  let base = `${formatTokens(left, true)} of ${formatTokens(reading.allowance)} included tokens left this week`;
  if (options.offline && reading.readAt !== undefined)
    base += ` as of ${readTime(reading.readAt, now, options.timeZone)}`;
  return reading.resetsAt === null
    ? base
    : `${base}; resets in ${formatResetIn(reading.resetsAt - now)}`;
}
