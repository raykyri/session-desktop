// Phase 2b, slice 2: the toast a refused write shows (the mockup's
// API_ERR.write copy), with its actions; one toast at a time.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import test from "ava";

import { Toasts, WRITE_ERROR, refusalText, refusalToast, toast } from "../src/spaces/writes.js";

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

test.serial(
  "TOO_MANY_REQUESTS without retryAt (the queued-runs limit) shows the server's message; with retryAt, the write budget's copy",
  (t) => {
    render(<Toasts />);
    const queued = "You have 3 asks waiting or running. Ask again once one of them finishes.";
    t.is(refusalText({ code: "TOO_MANY_REQUESTS", message: queued }), queued);
    act(() => refusalToast({ code: "TOO_MANY_REQUESTS", message: queued }));
    t.truthy(screen.getByText(queued));
    t.is(
      refusalText({
        code: "TOO_MANY_REQUESTS",
        message: "Too many changes.",
        retryAt: "2026-11-16T10:00:10Z",
      }),
      WRITE_ERROR["TOO_MANY_REQUESTS"] ?? "-",
    );
    // no message: the mockup's copy
    t.is(
      refusalText({ code: "TOO_MANY_REQUESTS", message: "" }),
      WRITE_ERROR["TOO_MANY_REQUESTS"] ?? "-",
    );
    // other codes keep their copy, not the server's message
    t.is(refusalText({ code: "STALE", message: "x" }), WRITE_ERROR["STALE"] ?? "-");
  },
);
