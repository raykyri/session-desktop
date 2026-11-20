// A frozen copy (the Desktop app; the mockup's sx-ax-frozen, Variants
// "Greyed, notice"): a closed space the person was removed from, as this
// device kept it. The server serves them nothing of it; the copy is
// read-only and greyed, with one short notice in place of the composer and
// the reply box, and "Not a member" in place of the membership control. The
// person can still delete their own threads there (sx-ax-frozen-del).

import { useEffect } from "react";

import { spaceName } from "../data/format.js";
import type { Space } from "../data/spaces.js";
import { platform } from "../platform.js";

import { Svg } from "./Svg.js";
import { SVG, SXI } from "./icons.js";

export function FrozenStrip({ s }: { s: Space }) {
  return (
    <div className="cs-strip sx-mtop sx-frstrip" role="status">
      <Svg src={SVG.LOCK} />
      <span className="grow">
        You’re no longer a member of {spaceName(s)}. This copy on {platform().here ?? "this device"}{" "}
        is read-only and isn’t updated.
      </span>
    </div>
  );
}

export function NotAMember() {
  return (
    <span className="sx-frz">
      <Svg src={SXI.lock} />
      Not a member
    </span>
  );
}

/** Likes, saves and replies off while a frozen copy is on screen. */
export function useReadOnly(on: boolean): void {
  useEffect(() => {
    const app = document.getElementById("app");
    if (!on || !app) return;
    app.classList.add("sx-ro");
    return () => app.classList.remove("sx-ro");
  }, [on]);
}
