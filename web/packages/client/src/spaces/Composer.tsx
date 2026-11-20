// The composer (the mockup's `composer`): closed, a field-like button that
// opens it; signed out, Log in. Asking and posting are phase 2b's second
// slice.

import { useNavigate } from "@tanstack/react-router";

import type { Space } from "../data/spaces.js";

import { useWorld } from "./world.js";

export function Composer({ space }: { space: Space | null }) {
  const w = useWorld();
  const navigate = useNavigate();
  const postsOff = space?.postsOff ?? false;
  if (!w.me)
    return (
      <button
        className="composer c2-closed"
        type="button"
        onClick={() =>
          void navigate({ to: "/login", search: { redirect: location.pathname + location.search } })
        }
      >
        <span className="ph">Log in to ask a question{postsOff ? "" : " or post"}</span>
      </button>
    );
  return (
    <button className="composer c2-closed" type="button">
      <span className="ph">{postsOff ? "Make a query…" : "Make a query, or write a post…"}</span>
    </button>
  );
}
