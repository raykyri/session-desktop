// Stored times without `Date`: the package may not read a clock or format
// with `Date` or `Intl` (`01` U1), so the arithmetic `run` needs on stored
// ISO instants (`2026-11-16T10:00:00Z`, UTC, seconds) is done here, on the
// proleptic Gregorian calendar (days from 1970-01-01 by Howard Hinnant's
// `days_from_civil` and `civil_from_days`).

const SECOND = 1000;
const DAY_MS = 86_400_000;
const ISO =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y: number, m: number) =>
  m === 2 ? (isLeap(y) ? 29 : 28) : m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;

function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

function civilFromDays(z: number): [number, number, number] {
  const zz = z + 719_468;
  const era = Math.floor(zz / 146_097);
  const doe = zz - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

/** Milliseconds since the epoch of an ISO instant: `Z` or a `±HH:MM`
 * offset, fields in range (a month's days, hours below 24, minutes and
 * seconds below 60, an offset to ±23:59). Anything else throws: a stored time
 * a mutator cannot read is a fault, never a silent NaN (M1b review 7). */
export function isoToMs(iso: string): number {
  const m = ISO.exec(iso);
  if (!m) throw new RangeError(`not an ISO instant: ${iso}`);
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const oh = m[10] === undefined ? 0 : Number(m[10]);
  const om = m[11] === undefined ? 0 : Number(m[11]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || s > 59)
    throw new RangeError(`an ISO instant out of range: ${iso}`);
  if (oh > 23 || om > 59) throw new RangeError(`an ISO offset out of range: ${iso}`);
  const frac = m[7] ? Math.floor(Number(`0.${m[7]}`) * SECOND) : 0;
  const offset = (m[9] === "-" ? -1 : 1) * (oh * 60 + om) * 60 * SECOND;
  return daysFromCivil(y, mo, d) * DAY_MS + ((h * 60 + mi) * 60 + s) * SECOND + frac - offset;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** The ISO instant of a time, in UTC, to the second (the stored form). */
export function msToIso(ms: number): string {
  const sec = Math.floor(ms / SECOND);
  const days = Math.floor(sec / 86_400);
  const rest = sec - days * 86_400;
  const [y, m, d] = civilFromDays(days);
  const h = Math.floor(rest / 3600);
  const mi = Math.floor((rest % 3600) / 60);
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(rest % 60)}Z`;
}

/** A stored instant `days` later. */
export const addDays = (iso: string, days: number) => msToIso(isoToMs(iso) + days * DAY_MS);
