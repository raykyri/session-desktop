// The mockup's shared atoms: the logo, a person's avatar and name button, a
// space's glyph, name, seal and lock markers.

import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import {
  avatarColor,
  initials,
  isClosed,
  isPlain,
  isVerified,
  sealText,
  spaceName,
  visLabel,
} from "../data/format.js";
import type { Space } from "../data/spaces.js";

import { Svg } from "./Svg.js";
import { I, SVG } from "./icons.js";

export function Logo({ text = "Session" }: { text?: string }) {
  return (
    <span className="logo">
      <Svg src={I.logo} />
      {text}
    </span>
  );
}

/** A person's initials on their colour. */
export function Avatar({ u, className = "" }: { u: string; className?: string }) {
  return (
    <span
      className={`av ${className}`}
      style={{ background: `var(--av${avatarColor(u)})` }}
      aria-hidden="true"
    >
      {initials(u)}
    </span>
  );
}

/** A person's handle, opening their profile. */
export function Author({ u, label }: { u: string; label?: string }) {
  const navigate = useNavigate();
  return (
    <button
      className="au"
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void navigate({ to: "/u/$handle", params: { handle: u } });
      }}
    >
      {label ?? u}
    </button>
  );
}

/** A space's square glyph: its first letter on its colour. */
export function Glyph({
  s,
  className = "",
}: {
  s: Pick<Space, "name" | "av" | "img">;
  className?: string;
}) {
  if (s.img) return <span className={`glyph cx-img ${className}`} aria-hidden="true" />;
  return (
    <span
      className={`glyph ${className}`}
      style={{ background: `var(--av${s.av || 1})` }}
      aria-hidden="true"
    >
      {s.name[0]?.toUpperCase()}
    </span>
  );
}

/** The glyph, with a lock for a closed space. */
export function SpaceGlyph({ s, className = "" }: { s: Space; className?: string }) {
  if (!isClosed(s)) return <Glyph s={s} className={className} />;
  return (
    <span className="cs-gw">
      <Glyph s={s} className={className} />
      <span className="cs-gl" title={visLabel(s)}>
        <Svg src={SVG.LOCK} />
      </span>
    </span>
  );
}

/** The verified-domain seal. */
export function Seal({ s, size }: { s: Pick<Space, "dom">; size?: "sm" | "lg" }) {
  if (!isVerified(s)) return null;
  const t = sealText(s);
  return (
    <span className={`sf-seal${size ? ` ${size}` : ""}`} title={t} aria-label={t}>
      <Svg src={SVG.SEAL} />
    </span>
  );
}

/** A lock marker. */
export function Lock({
  className = "cs-lk",
  title = "Closed space",
}: {
  className?: string;
  title?: string;
}) {
  return (
    <span className={className} title={title} aria-label={title}>
      <Svg src={SVG.LOCK} />
    </span>
  );
}

/** A space's name with its seal and, after it, its lock marker. */
export function SpaceLabel({ s, lock = true }: { s: Space; lock?: boolean }) {
  return (
    <>
      {spaceName(s)}
      <Seal s={s} size="sm" />
      {lock && isClosed(s) ? <Lock title={visLabel(s)} /> : null}
    </>
  );
}

/** A space's name as a feed row tags it: "#name", or a lock in place of "#"
 * for a closed space. */
export function SpaceTag({ s }: { s: Space }) {
  const closed = isClosed(s);
  if (isPlain(s))
    return (
      <>
        {closed ? <Lock className="cs-lk cs-lk-hash" title="Members only" /> : null}
        {s.title}
      </>
    );
  return (
    <>
      {closed ? <Lock className="cs-lk cs-lk-hash" title="Members only" /> : "#"}
      {s.name}
    </>
  );
}

export function Grow() {
  return <span className="grow" />;
}

export function Num({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <span className="num" {...(label ? { "aria-label": label } : {})}>
      {children}
    </span>
  );
}
