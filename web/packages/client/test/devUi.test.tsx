import { cleanup, render, screen } from "@testing-library/react";
import test from "ava";

import { DevUiPage } from "../src/routes/devUi.js";
import { closeDiagramLightbox, closeImageLightbox } from "../src/stores/lightboxes.js";
import { useOverlaysStore } from "../src/stores/overlays.js";

test.afterEach(() => {
  cleanup();
  closeImageLightbox();
  closeDiagramLightbox();
  useOverlaysStore.getState().clear();
});

// The kitchen sink is a visual check, but mounting it here catches the failure
// mode a screenshot would not explain: a primitive that throws on render in one
// theme × appearance combination and silently drops a whole panel.
test.serial("the kitchen sink mounts every primitive in all four combinations", (t) => {
  render(<DevUiPage />);

  for (const label of ["Cool · Dark", "Cool · Light", "Warm · Dark", "Warm · Light"]) {
    t.truthy(screen.getByRole("heading", { name: label }));
  }

  const panels = document.querySelectorAll("[data-color-theme][data-appearance]");
  t.is(panels.length, 4);
  t.is(panels[0]?.getAttribute("data-color-theme"), "green-blob");
  t.is(panels[3]?.getAttribute("data-appearance"), "light");

  // One assertion per section, so a primitive removed from the sink is noticed.
  t.is(screen.getAllByRole("button", { name: "Control" }).length, 4);
  t.is(screen.getAllByLabelText("Workspace name").length, 4);
  t.is(screen.getAllByRole("combobox", { name: "Model" }).length, 4);
  // The launcher trigger names itself with the value it is showing, so the
  // label is a prefix rather than the whole name.
  t.is(screen.getAllByRole("button", { name: /^Launch model: / }).length, 4);
  t.is(screen.getAllByRole("switch", { name: "Reduce motion" }).length, 4);
  t.is(screen.getAllByRole("tab", { name: "General" }).length, 4);
  // One per panel: the second find bar in the sink is a `DomSearchBar`,
  // which renders nothing until Cmd-F opens it.
  t.is(screen.getAllByRole("textbox", { name: "Find in document" }).length, 4);
  t.is(screen.getAllByText("A passage").length, 4);
  t.is(screen.getAllByRole("status").length, 12, "three visible toasts per panel");
});
