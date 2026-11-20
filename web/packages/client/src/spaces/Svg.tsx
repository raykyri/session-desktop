// An icon from the mockup's tables (`icons.ts`): the SVG markup as a real
// <svg> element, so the mockup's selectors that style `svg` children apply
// unchanged. The markup is the mockup's own (constant, never user text).

import { memo, type CSSProperties } from "react";

const ATTR: Record<string, string> = {
  class: "className",
  "stroke-width": "strokeWidth",
  "stroke-linecap": "strokeLinecap",
  "stroke-linejoin": "strokeLinejoin",
  "fill-rule": "fillRule",
  "clip-rule": "clipRule",
  "aria-hidden": "aria-hidden",
  "aria-label": "aria-label",
  viewBox: "viewBox",
};

interface Parsed {
  attrs: Record<string, string>;
  inner: string;
}

const cache = new Map<string, Parsed>();

function parse(src: string): Parsed {
  let p = cache.get(src);
  if (p) return p;
  const m = /^\s*<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/.exec(src);
  const attrs: Record<string, string> = {};
  if (m?.[1])
    for (const a of m[1].matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)) {
      const name = a[1] ?? "";
      if (name === "style") continue;
      attrs[ATTR[name] ?? name] = a[2] ?? "";
    }
  p = { attrs, inner: m?.[2] ?? "" };
  cache.set(src, p);
  return p;
}

export const Svg = memo(function Svg({
  src,
  className,
  style,
}: {
  src: string;
  className?: string;
  style?: CSSProperties;
}) {
  const { attrs, inner } = parse(src);
  const cls = [attrs["className"], className].filter(Boolean).join(" ");
  return (
    <svg
      {...attrs}
      {...(cls ? { className: cls } : {})}
      {...(style ? { style } : {})}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
});
