// Times as the stored records hold them: ISO 8601 in UTC to the second
// (`2026-11-16T10:00:00Z`). Converted by arithmetic on the proleptic
// Gregorian calendar, so the mutators never call `Date` or `Intl` (AGENTS.md:
// `run` reads the time from `tx.now` only).

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** Days since 1970-01-01 of a civil date (Howard Hinnant's `days_from_civil`). */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The civil date of a count of days since 1970-01-01 (`civil_from_days`). */
function civilFromDays(z0: number): [number, number, number] {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return [y, m, d];
}

/** Milliseconds since the epoch as a stored time: UTC, to the second (the
 * milliseconds are dropped). Years 0 to 9999. */
export function isoAt(ms: number): string {
  const s = Math.floor(ms / SECOND);
  const days = Math.floor(s / 86_400);
  const rest = s - days * 86_400;
  const [y, m, d] = civilFromDays(days);
  const hh = Math.floor(rest / 3600);
  const mm = Math.floor((rest % 3600) / 60);
  const ss = rest % 60;
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}T${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}Z`;
}

const ISO = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,3}))?)?Z$/;

/** Milliseconds since the epoch of an ISO time in UTC (`…Z`), or NaN for
 * another string. */
export function msOf(iso: string): number {
  const m = ISO.exec(iso);
  if (!m) return NaN;
  const n = (k: number) => Number(m[k] ?? 0);
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0"));
  return daysFromCivil(n(1), n(2), n(3)) * DAY + n(4) * HOUR + n(5) * MINUTE + n(6) * SECOND + ms;
}
