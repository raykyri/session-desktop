// An invite link's landing page (`/i/<code>`, the mockup's layoutInvite):
// who invited, the space, and Accept invite; an expired link says so. The
// link is looked up with `GET /api/invites/<code>`; accepting joins with the
// code (`spaces.join`).

import type { SpaceRec } from "@session/mutators";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { HttpError, getJson } from "../api/http.js";
import { spaceName } from "../data/format.js";
import { toSpace } from "../data/spaces.js";

import { NotFound, Page } from "./Page.js";
import { Svg } from "./Svg.js";
import { Avatar, SpaceGlyph } from "./atoms.js";
import { CI, SVG } from "./icons.js";
import { useWorld } from "./world.js";
import { toast, useWrite } from "./writes.js";

interface InviteView {
  space: SpaceRec;
  by: string;
  expiresAt: string | null;
  state: "live" | "expired";
}

type Load =
  | { status: "loading" }
  | { status: "gone" }
  | { status: "error" }
  | { status: "ready"; v: InviteView };

export function InviteLanding({ code }: { code: string }) {
  const w = useWorld();
  const navigate = useNavigate();
  const write = useWrite();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    getJson<InviteView>(`/api/invites/${encodeURIComponent(code)}`).then(
      (v) => live && setLoad({ status: "ready", v }),
      (e: unknown) =>
        live && setLoad({ status: e instanceof HttpError && e.status === 404 ? "gone" : "error" }),
    );
    return () => {
      live = false;
    };
  }, [code]);
  if (load.status === "loading") return <Page place={{ kind: "other" }}>{null}</Page>;
  if (load.status !== "ready")
    return (
      <Page place={{ kind: "other" }}>
        <NotFound />
      </Page>
    );
  const { v } = load;
  const sp = w.byId.get(v.space.id) ?? toSpace(v.space, undefined);
  const name = spaceName(sp);
  const member = w.roles[v.space.id] !== undefined;
  const open = () => void navigate({ to: "/s/$space", params: { space: v.space.name } });
  const accept = async () => {
    setBusy(true);
    const o = await write("spaces.join", { space: v.space.id, invite: code });
    setBusy(false);
    if (o.ok) {
      toast(`You joined ${name}.`);
      open();
    }
  };
  const expires = v.expiresAt
    ? new Date(v.expiresAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
    : null;
  return (
    <Page place={{ kind: "other" }}>
      <div className="cs-napage">
        {v.state === "expired" ? (
          <div className="cs-na cs-invcard">
            <span className="cs-na-ic">
              <Svg src={CI.link} />
            </span>
            <h2>This invite link has expired</h2>
            <p className="muted">
              Links to {name} stop working after their expiry date or use limit. Ask <b>{v.by}</b>{" "}
              for a new link.
            </p>
            <div className="cs-na-b">
              <button className="btn" type="button" onClick={() => void navigate({ to: "/" })}>
                Go to Home
              </button>
            </div>
          </div>
        ) : (
          <div className="cs-na cs-invcard">
            <p className="cs-invby">
              <Avatar u={v.by} className="sm" />
              <span>
                <b>{v.by}</b> invited you to join
              </span>
            </p>
            <SpaceGlyph s={sp} className="xl" />
            <h2>{name}</h2>
            <p className="muted">{v.space.desc}</p>
            <ul className="cs-facts">
              {v.space.vis !== "open" ? (
                <li>
                  <Svg src={SVG.LOCK} />
                  <span>Threads are visible to members only.</span>
                </li>
              ) : null}
              <li>
                <Svg src={CI.link} />
                <span>
                  {expires
                    ? `This link expires on ${expires} and works once.`
                    : "This link works once."}
                </span>
              </li>
            </ul>
            <div className="cs-na-b">
              {member ? (
                <>
                  <span className="faint">You are already a member.</span>
                  <button className="btn primary" type="button" onClick={open}>
                    Open {name}
                  </button>
                </>
              ) : !w.me ? (
                <button
                  className="btn primary"
                  type="button"
                  onClick={() =>
                    void navigate({ to: "/login", search: { redirect: `/i/${code}` } })
                  }
                >
                  Log in with GitHub to accept
                </button>
              ) : (
                <>
                  <button
                    className="btn primary"
                    type="button"
                    disabled={busy}
                    onClick={() => void accept()}
                  >
                    Accept invite
                  </button>
                  <button className="btn" type="button" onClick={() => void navigate({ to: "/" })}>
                    Not now
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </Page>
  );
}
