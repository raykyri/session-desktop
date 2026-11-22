// The Site Admin page (02 W8.2): the heading, the line under it and exactly
// three boxes, the default model, the default effort and Invites; nothing
// else. The Invites box looks up a member's invites by handle and gives them
// more (04 I2).

import { cleanup, fireEvent, screen } from "@testing-library/react";
import test from "ava";

import { clearToast, currentToast } from "../src/features/shell/Toast.js";

import { renderApp, resetDocumentRoot, testUser, trpcRefusal, waitUntil } from "./helpers.js";

test.afterEach.always(() => {
  cleanup();
  clearToast();
  resetDocumentRoot();
});

test.serial(
  "Site Admin has exactly three boxes: default model, default effort and Invites",
  async (t) => {
    await renderApp("/admin", { user: testUser({ isAdmin: true }) });
    t.truthy(await screen.findByRole("heading", { name: "Site Admin", level: 2 }));
    t.truthy(screen.getByText("Settings for everyone on Session."));
    await screen.findByRole("radiogroup", { name: "Default model" });
    const boxes = [...document.querySelectorAll(".page-inner section")];
    t.deepEqual(
      boxes.map((box) => box.querySelector("h3")?.textContent),
      ["Default model", "Default effort", "Invites"],
    );
    t.true(boxes.every((box) => box.classList.contains("box")));
    // No account table, limits, sign-up codes, prices or availability.
    t.is(document.querySelector(".page-inner table"), null);
    t.is(screen.queryByText(/Sign-up codes|Accounts|Daily|\$/), null);
  },
);

/** A lookup answer for @mira_k: 3 invites plus `extra`, `used` used and
 * `open` open. */
const mira = (extra: number, used: number, open: number) => ({
  handle: "mira_k",
  displayName: "Mira",
  total: 3 + extra,
  used,
  open,
  left: 3 + extra - used - open,
  extra,
});

async function openInvites(responses: Record<string, unknown>) {
  const app = await renderApp("/admin", { user: testUser({ isAdmin: true }), responses });
  await screen.findByRole("heading", { name: "Invites" });
  return app;
}

/** The error line under one of the Invites box's forms. */
const invitesError = () =>
  document.querySelector('section[aria-labelledby="adm-invites"] .ferr')?.textContent ?? null;

function lookUp(handle: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Handle" }), {
    target: { value: handle },
  });
  fireEvent.click(screen.getByRole("button", { name: "Look up" }));
}

test.serial(
  "Invites: a lookup shows the member's invites left of the total, extras included",
  async (t) => {
    const app = await openInvites({ "admin.invites.lookup": mira(1, 1, 1) });
    t.is(screen.queryByRole("button", { name: "Give invites" }), null);
    lookUp("@mira_k");
    t.truthy(await screen.findByText("@mira_k: 2 of 4 invites left (1 used)"));
    t.deepEqual(app.trpc.calls.find((call) => call.path === "admin.invites.lookup")?.input, {
      handle: "@mira_k",
    });
    const count = screen.getByRole("spinbutton", { name: "Number of invites" });
    t.is(count.getAttribute("min"), "1");
    t.is(count.getAttribute("max"), "100");
    t.truthy(screen.getByRole("button", { name: "Give invites" }));
  },
);

test.serial("Invites: a grant shows the toast and the new total", async (t) => {
  const app = await openInvites({
    "admin.invites.lookup": mira(0, 1, 2),
    "admin.invites.grant": mira(2, 1, 2),
  });
  lookUp("mira_k");
  t.truthy(await screen.findByText("@mira_k: 0 of 3 invites left (1 used)"));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Number of invites" }), {
    target: { value: "2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Give invites" }));
  await waitUntil(t, () => currentToast() === "Gave @mira_k 2 more invites.", "the toast");
  t.truthy(screen.getByText("@mira_k: 2 of 5 invites left (1 used)"));
  t.deepEqual(app.trpc.calls.find((call) => call.path === "admin.invites.grant")?.input, {
    handle: "mira_k",
    count: 2,
  });
});

test.serial(
  "Invites: an unknown handle shows the server's message and no grant form",
  async (t) => {
    await openInvites({
      "admin.invites.lookup": () => {
        throw trpcRefusal("No account with that handle.", "NOT_FOUND");
      },
    });
    lookUp("nobody.here");
    await waitUntil(t, () => invitesError() === "No account with that handle.", "the message");
    t.is(screen.queryByRole("button", { name: "Give invites" }), null);
  },
);

test.serial(
  "Invites: a count outside 1 to 100 is refused before the request; a refused grant shows the server's message",
  async (t) => {
    let refuse = true;
    const app = await openInvites({
      "admin.invites.lookup": mira(0, 0, 0),
      "admin.invites.grant": () => {
        if (refuse) throw trpcRefusal("this is an administrator action", "FORBIDDEN");
        return mira(1, 0, 0);
      },
    });
    lookUp("mira_k");
    await screen.findByText("@mira_k: 3 of 3 invites left (0 used)");
    const count = screen.getByRole("spinbutton", { name: "Number of invites" });
    for (const value of ["0", "101", "1.5", ""]) {
      fireEvent.change(count, { target: { value } });
      fireEvent.click(screen.getByRole("button", { name: "Give invites" }));
      await waitUntil(t, () => invitesError() === "Enter a whole number from 1 to 100.", value);
    }
    t.is(app.trpc.calls.filter((call) => call.path === "admin.invites.grant").length, 0);

    fireEvent.change(count, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Give invites" }));
    await waitUntil(t, () => invitesError() === "this is an administrator action", "the refusal");
    t.truthy(screen.getByText("@mira_k: 3 of 3 invites left (0 used)"));
    refuse = false;
    fireEvent.click(screen.getByRole("button", { name: "Give invites" }));
    await waitUntil(t, () => currentToast() === "Gave @mira_k 1 more invite.", "the toast");
    t.is(invitesError(), null);
    t.truthy(screen.getByText("@mira_k: 4 of 4 invites left (0 used)"));
  },
);
