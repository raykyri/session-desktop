// How the spaces client writes times, counts, names and avatars: the
// mockup's helpers (`ago`, `fmt`, `fmtT`, `spName`, `initials`, `avatar`),
// with the server's clock as "now" (the sync client's estimate of it).

import type { SpaceRec } from "@session/mutators";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const timeOf = (x: string | number | null | undefined): number =>
  typeof x === "number" ? x : x ? Date.parse(x) : NaN;

/** Minutes from `at` to `now`; 0 for a time not set yet. */
export function ageMinutes(at: string | number | null | undefined, now: number): number {
  const t = timeOf(at);
  return Number.isNaN(t) ? 0 : Math.max(0, (now - t) / 60e3);
}

/** "now", "18m", "2h", "1d", "3w" (under 8 weeks), "2mo", "1y". */
export function ago(at: string | number | null | undefined, now: number, zero = "now"): string {
  const m = Math.floor(ageMinutes(at, now));
  if (m < 1) return zero;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 56) return `${Math.floor(d / 7)}w`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

/** "just now" or "18m ago". */
export const agoText = (at: string | number | null | undefined, now: number) =>
  ageMinutes(at, now) < 1 ? "just now" : `${ago(at, now)} ago`;

/** "Nov 16". */
export function dayOf(at: string | number, now: number): string {
  const t = timeOf(at);
  const d = new Date(Number.isNaN(t) ? now : t);
  return `${MON[d.getUTCMonth()] ?? ""} ${d.getUTCDate()}`;
}

/** 1290 → "1K", 2_400_000 → "2.4M". */
export function fmt(n: number): string {
  if (n >= 1e6)
    return `${(n / 1e6)
      .toFixed(n >= 1e7 ? 0 : 2)
      .replace(/\.(\d*?)0+$/, ".$1")
      .replace(/\.$/, "")}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

/** Tokens: "118k", "2.4m"... as the mock writes them ("118k tokens"). */
export const fmtT = (n: number) => fmt(n).replace(/[KM]$/, (c) => c.toLowerCase());

/** 1290 → "1,290". */
export const count = (n: number) => n.toLocaleString("en-US");

/** A space's domain is verified. */
export const isVerified = (s: Pick<SpaceRec, "dom"> | undefined | null) =>
  !!s?.dom && s.dom.state === "ok";

/** The space shows its title in place of "#name" (verified, with "Show as"). */
export const isPlain = (s: Pick<SpaceRec, "dom" | "plain"> | undefined | null) =>
  isVerified(s) && !!s?.plain;

export const isClosed = (s: Pick<SpaceRec, "vis"> | undefined | null) =>
  !!s && (s.vis === "listed" || s.vis === "unlisted");

/** "#name", or the title of a verified space shown by its title. */
export const spaceName = (s: Pick<SpaceRec, "name" | "title" | "dom" | "plain">) =>
  isPlain(s) ? s.title : `#${s.name}`;

export const sealText = (s: Pick<SpaceRec, "dom">) =>
  `Verified: the admins of this space control ${s.dom?.domain ?? ""}`;

export const visLabel = (s: Pick<SpaceRec, "vis">) =>
  s.vis === "unlisted" ? "Closed, unlisted" : "Closed";

/** "ines.v" → "IV". */
export const initials = (h: string) =>
  h
    .replace("@", "")
    .replace(/[._]/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** One of the six avatar colours, fixed for a handle. */
export function avatarColor(handle: string): number {
  let h = 2166136261;
  for (let i = 0; i < handle.length; i++) h = Math.imul(h ^ handle.charCodeAt(i), 16777619) >>> 0;
  return (h % 6) + 1;
}
