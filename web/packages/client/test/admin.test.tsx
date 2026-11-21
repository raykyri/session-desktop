// The Site Admin page (02 W8.2): the heading, the line under it and exactly
// two boxes, the default model and the default effort; nothing else.

import { cleanup, screen } from "@testing-library/react";
import test from "ava";

import { renderApp, resetDocumentRoot, testUser } from "./helpers.js";

test.afterEach.always(() => {
  cleanup();
  resetDocumentRoot();
});

test.serial("Site Admin has exactly two boxes: default model and default effort", async (t) => {
  await renderApp("/admin", { user: testUser({ isAdmin: true }) });
  t.truthy(await screen.findByRole("heading", { name: "Site Admin", level: 2 }));
  t.truthy(screen.getByText("Settings for everyone on Session."));
  await screen.findByRole("radiogroup", { name: "Default model" });
  const boxes = [...document.querySelectorAll(".page-inner section")];
  t.deepEqual(
    boxes.map((box) => box.querySelector("h3")?.textContent),
    ["Default model", "Default effort"],
  );
  t.true(boxes.every((box) => box.classList.contains("box")));
  // No account table, limits, sign-up codes, prices or availability.
  t.is(document.querySelector(".page-inner table"), null);
  t.is(screen.queryByText(/Sign-up codes|Accounts|Daily|\$/), null);
});
