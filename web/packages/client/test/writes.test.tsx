// Phase 2b, slice 2: the toast a refused write shows (the mockup's
// API_ERR.write copy), with its actions; one toast at a time.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import test from "ava";

import { Toasts, WRITE_ERROR, refusalToast, toast } from "../src/spaces/writes.js";

test.afterEach(() => cleanup());

test.serial(
  "a refusal shows the code's text; an unknown code says the server was not reached",
  (t) => {
    render(<Toasts />);
    act(() => refusalToast({ code: "STALE", message: "" }));
    t.truthy(screen.getByText(WRITE_ERROR["STALE"] ?? "-"));
    act(() => refusalToast({ code: "NO_SUCH_CODE", message: "" } as never));
    t.truthy(screen.getByText(WRITE_ERROR["unavailable"] ?? "-"));
    // one toast at a time: the newest
    t.is(document.querySelectorAll(".cs-toast").length, 1);
  },
);

test.serial("a toast's action runs once and closes it; Dismiss closes it", (t) => {
  render(<Toasts />);
  let ran = 0;
  act(() => toast("Declined noor.a.", { label: "Undo", run: () => ran++ }));
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  t.is(ran, 1);
  t.is(document.querySelectorAll(".cs-toast").length, 0);
  act(() =>
    toast(
      "Approve wasn’t applied.",
      { label: "Reload and reapply", run: () => ran++ },
      { label: "Details", run: () => undefined },
    ),
  );
  // two actions sit in the mockup's sx-tacts group
  t.truthy(document.querySelector(".sx-toastw .sx-tacts"));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  t.is(ran, 1);
  t.is(document.querySelectorAll(".cs-toast").length, 0);
});
