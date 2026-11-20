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

/** Markdown as plain text (a feed row's summary, a search snippet): links
 * and citation markers dropped, and emphasis, code, quote, heading and list
 * markers taken away where they are markup, so an underscore inside a word
 * (E_SYNC_SCOPE, pg_trgm) stays. */
export function plainText(md: string): string {
  return md
    .replace(/\[(\d{1,3})\]\([^)]*\)/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s{0,3}(?:#{1,6}|>)\s?/gm, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)([^]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- runs (phase 2 review round 1, findings 5 and 7) ----

/** A device run's CLI, as the mockup names it. */
export const cliName = (cli: "claude" | "codex") => (cli === "codex" ? "Codex" : "Claude Code");

/** The label of an answer a device wrote (the mockup's sxLabelText, its
 * default Variant: text in the meta line). */
export const deviceLabel = (d: { u: string; cli: "claude" | "codex" }) =>
  `Answered on ${d.u}’s desktop · ${cliName(d.cli)}`;

/** The next Monday 00:00 UTC after `now`: when the weekly included tokens
 * reset (AGENTS.md). */
export function weekResetAt(now: number): number {
  const d = new Date(now);
  const day = d.getUTCDay();
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return midnight + ((8 - day) % 7 || 7) * 864e5;
}

/** Why an answer stopped for tokens, naming who paid (the mockup's
 * tmStopWhy): the weekly included tokens with their reset day, or a key's
 * monthly limit. `key` is the reader's own key that paid, when it is one. */
export function tokensWhy(
  pay: string | null,
  tok: number,
  now: number,
  key: { name: string; cap: number } | null,
): string {
  const after = tok
    ? `The agent stopped after ${fmtT(tok)} tokens and wrote nothing.`
    : "The agent wrote nothing.";
  if (pay === null || pay === "session")
    return `You’ve used this week’s included tokens. ${after} They reset ${dayOf(weekResetAt(now), now)}.`;
  if (key) return `Your ${key.name} reached its monthly limit of ${fmtT(key.cap)} tokens. ${after}`;
  return `Nothing could pay for this ask. ${after}`;
}
