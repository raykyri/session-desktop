import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import test from "ava";
import { useState } from "react";

import { formatChord } from "../src/lib/platform.js";
import {
  closeImageLightbox,
  getImageLightbox,
  openImageLightbox,
} from "../src/stores/lightboxes.js";
import type { NotificationItem } from "../src/stores/notifications.js";
import { useOverlaysStore } from "../src/stores/overlays.js";
import { ControlButton, IconButton, LinkButton } from "../src/ui/Button.js";
import { CommandPalette } from "../src/ui/CommandPalette.js";
import {
  ComposerSubmitShortcutGlyph,
  isComposerSubmitShortcut,
} from "../src/ui/ComposerSubmitShortcut.js";
import { ContextMenu, ContextMenuItem } from "../src/ui/ContextMenu.js";
import { ConfirmDialog, ConfirmDialogActionButton, Dialog } from "../src/ui/Dialog.js";
import { Field, Input, ShortcutHint, Textarea } from "../src/ui/Field.js";
import { FindBar } from "../src/ui/FindBar.js";
import { HistoryNav } from "../src/ui/HistoryNav.js";
import { ImageLightbox } from "../src/ui/Lightboxes.js";
import { Menu, MenuItem, MenuSeparator } from "../src/ui/Menu.js";
import { NotificationStack } from "../src/ui/NotificationStack.js";
import { Popover } from "../src/ui/Popover.js";
import { LauncherSelect, Select } from "../src/ui/Select.js";
import { SidebarRestoreButton } from "../src/ui/SidebarRestoreButton.js";
import { TabPanel, Tabs } from "../src/ui/Tabs.js";
import { Checkbox, Switch } from "../src/ui/Toggle.js";
import { Tooltip } from "../src/ui/Tooltip.js";

import { waitUntil } from "./helpers.js";

function LauncherHarness() {
  const [model, setModel] = useState("gemini-flash");
  const [effort, setEffort] = useState("medium");
  return (
    <>
      <LauncherSelect
        label="Launch model"
        value={model}
        options={MODELS}
        onChange={setModel}
        submenu={{
          label: "Reasoning",
          value: effort,
          onChange: setEffort,
          options: [
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ],
        }}
      />
      <output data-testid="model">{model}</output>
      <output data-testid="effort">{effort}</output>
    </>
  );
}

const MODELS = [
  { value: "gemini-flash", label: "Gemini Flash" },
  { value: "deepseek-flash", label: "DeepSeek Flash" },
  { value: "gpt-luna", label: "GPT Luna" },
];

test.afterEach(() => {
  cleanup();
  closeImageLightbox();
  useOverlaysStore.getState().clear();
});

function key(element: Element, value: string, init: Partial<KeyboardEventInit> = {}) {
  fireEvent.keyDown(element, { key: value, ...init });
}

test.serial("buttons render their label and honor `disabled`", (t) => {
  const clicks: string[] = [];
  render(
    <>
      <ControlButton onClick={() => clicks.push("control")}>Retry</ControlButton>
      <IconButton label="More" onClick={() => clicks.push("icon")}>
        <span aria-hidden="true">·</span>
      </IconButton>
      <LinkButton disabled onClick={() => clicks.push("link")}>
        Undo
      </LinkButton>
    </>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));

  t.deepEqual(clicks, ["control", "icon"], "a disabled button does not fire");
});

test.serial("a dialog opens and closes", async (t) => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <ControlButton onClick={() => setOpen(true)}>Open</ControlButton>
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title="Rename thread"
          description="Give this investigation a title."
          footer={<ControlButton onClick={() => setOpen(false)}>Done</ControlButton>}
        >
          <Input aria-label="Title" defaultValue="Collective memory" />
        </Dialog>
      </>
    );
  }
  render(<Harness />);

  t.is(screen.queryByRole("dialog"), null);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));

  const dialog = await screen.findByRole("dialog");
  t.regex(dialog.textContent ?? "", /Rename thread/);
  t.truthy(screen.getByLabelText("Title"));

  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitUntil(t, () => screen.queryByRole("dialog") === null, "the dialog closes");
});

test.serial("a dialog closes on Escape without the app's escape stack", async (t) => {
  function Harness() {
    const [open, setOpen] = useState(true);
    return <Dialog open={open} onOpenChange={setOpen} title="Delete branch?" />;
  }
  render(<Harness />);
  const dialog = await screen.findByRole("dialog");

  key(dialog, "Escape");

  await waitUntil(t, () => screen.queryByRole("dialog") === null, "Escape closes the dialog");
  t.is(useOverlaysStore.getState().entries.length, 0, "library layers do not register");
});

test.serial("a confirm dialog runs its action and shows a busy state", async (t) => {
  let confirmed = 0;
  render(
    <ConfirmDialog
      open
      onOpenChange={() => {}}
      title="Delete thread?"
      description="This removes every branch under it."
      confirmLabel="Delete"
      tone="danger"
      onConfirm={() => {
        confirmed += 1;
      }}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  t.is(confirmed, 1);

  cleanup();
  render(
    <ConfirmDialogActionButton pending pendingLabel="Deleting…">
      Delete
    </ConfirmDialogActionButton>,
  );
  const busy = screen.getByRole("button", { name: /Deleting/ });
  t.is(busy.getAttribute("aria-busy"), "true");
  t.true((busy as HTMLButtonElement).disabled, "a busy action cannot be pressed twice");
});

test.serial("a menu opens and is navigable from the keyboard", async (t) => {
  const chosen: string[] = [];
  render(
    <Menu trigger={<ControlButton>Actions</ControlButton>} label="Thread actions">
      <MenuItem onClick={() => chosen.push("rename")}>Rename</MenuItem>
      <MenuItem onClick={() => chosen.push("bookmark")}>Bookmark</MenuItem>
      <MenuSeparator />
      <MenuItem tone="danger" onClick={() => chosen.push("delete")}>
        Delete
      </MenuItem>
    </Menu>,
  );

  const trigger = screen.getByRole("button", { name: "Actions" });
  t.is(screen.queryByRole("menu"), null);

  // ArrowDown on the trigger opens the menu with the first item highlighted.
  key(trigger, "ArrowDown");
  const menu = await screen.findByRole("menu");
  t.is(screen.getAllByRole("menuitem").length, 3);

  key(menu, "ArrowDown");
  await waitUntil(
    t,
    () => document.activeElement?.textContent === "Bookmark",
    "focus walks the items",
  );

  key(document.activeElement ?? menu, "Enter");
  await waitUntil(t, () => chosen.join() === "bookmark", "Enter runs the highlighted item");
});

test.serial("a small menu uses compact type and padding on its rows", async (t) => {
  render(
    <Menu size="sm" trigger={<ControlButton size="sm">Model</ControlButton>} label="Model">
      <MenuItem selected>Gemini 3.8 Flash</MenuItem>
    </Menu>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  const menu = await screen.findByRole("menu");
  const item = screen.getByRole("menuitem", { name: "Gemini 3.8 Flash" });

  t.true(menu.className.includes("p-0.5"), "the popup uses the compact padding");
  t.true(menu.className.includes("rounded-md"), "the popup uses the compact radius");
  t.true(item.className.includes("text-sm"), "rows match a small trigger's type size");
  t.false(item.className.includes("text-base"));
});

function clientSources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...clientSources(path));
    else if (/\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

test("menu items do not display shortcut hints that are not bound to handlers", (t) => {
  // A `MenuItem` sits on a Base UI menu, whose only key behaviour is
  // typeahead: a row labelled "D" would move the highlight to "Delete"
  // rather than delete. So a `hint` may carry a chord the shell's table
  // resolves (`⌘,`), a value (a count, a checkmark) or a word — never a bare
  // letter, and never a keycap element.
  const offenders: string[] = [];
  for (const file of clientSources(join(import.meta.dirname, "..", "src"))) {
    const source = readFileSync(file, "utf8");
    if (source.includes("MenuKeycap")) offenders.push(`${file}: MenuKeycap`);
    for (const match of source.matchAll(/\bhint=(?:"([A-Za-z])"|\{"([A-Za-z])"\})/g)) {
      offenders.push(`${file}: hint=${match[1] ?? match[2]}`);
    }
    for (const match of source.matchAll(/\bhint=\{<[^>]*[Kk]eycap/g)) {
      offenders.push(`${file}: ${match[0]}`);
    }
  }
  t.deepEqual(offenders, [], "every single-letter menu keycap is gone");
});

test.serial("a context menu opens on right-click", async (t) => {
  render(
    <ContextMenu label="Link actions" items={<ContextMenuItem>Copy link</ContextMenuItem>}>
      <div data-testid="target">Right-click me</div>
    </ContextMenu>,
  );

  fireEvent.contextMenu(screen.getByTestId("target"));

  t.truthy(await screen.findByRole("menuitem", { name: "Copy link" }));
});

test.serial("a popover opens from its trigger", async (t) => {
  render(
    <Popover trigger={<ControlButton>Folders</ControlButton>} label="Folder switcher">
      <p>Choose a folder</p>
    </Popover>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Folders" }));

  t.truthy(await screen.findByText("Choose a folder"));
});

test.serial("a tooltip shows its content on hover", async (t) => {
  render(
    <Tooltip content="Toggle the sidebar" delay={0}>
      <ControlButton>Sidebar</ControlButton>
    </Tooltip>,
  );

  const trigger = screen.getByRole("button", { name: "Sidebar" });
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
  fireEvent.mouseEnter(trigger);

  t.truthy(await screen.findByText("Toggle the sidebar"));
});

test.serial("a select changes its value", async (t) => {
  function Harness() {
    const [value, setValue] = useState("gemini-flash");
    return (
      <>
        <Select label="Model" value={value} options={MODELS} onChange={setValue} />
        <output data-testid="value">{value}</output>
      </>
    );
  }
  render(<Harness />);

  t.is(screen.getByTestId("value").textContent, "gemini-flash");
  fireEvent.click(screen.getByRole("combobox", { name: "Model" }));

  const list = await screen.findByRole("listbox");
  t.is(screen.getAllByRole("option").length, 3);

  // Driven from the keyboard: jsdom dispatches no real pointer sequence, and
  // Base UI commits a selection on pointerup rather than on a synthetic click.
  key(list, "ArrowDown");
  key(list, "ArrowDown");
  key(document.activeElement ?? list, "Enter");

  await waitUntil(
    t,
    () => screen.getByTestId("value").textContent === "gpt-luna",
    "the select commits the highlighted option",
  );
});

test.serial("the launcher select offers its separated submenu row", async (t) => {
  render(<LauncherHarness />);

  // The trigger names the control *and* the value it is showing: a menu
  // trigger is a plain button, so its accessible name is all there is.
  const trigger = screen.getByRole("button", { name: "Launch model: Gemini Flash" });
  fireEvent.click(trigger);

  const options = await screen.findAllByRole("menuitemradio");
  t.is(options.length, 3, "the submenu row is not one of the primary options");
  t.truthy(screen.getByText("Reasoning"));

  fireEvent.click(screen.getByRole("menuitemradio", { name: /DeepSeek Flash/ }));
  await waitUntil(
    t,
    () => screen.getByTestId("model").textContent === "deepseek-flash",
    "the radio group reports the new value",
  );
  t.truthy(
    screen.getByRole("button", { name: "Launch model: DeepSeek Flash" }),
    "and the trigger re-announces it",
  );
});

test.serial("the launcher submenu opens with ArrowRight and reports its own value", async (t) => {
  render(<LauncherHarness />);
  fireEvent.click(screen.getByRole("button", { name: /^Launch model: / }));
  await screen.findAllByRole("menuitemradio");

  // Implemented using Base UI Menu to provide native arrow key expansion and collapse for submenus.
  const submenuTrigger = screen.getByRole("menuitem", { name: /Reasoning/ });
  key(submenuTrigger, "ArrowRight");

  await waitUntil(
    t,
    () => screen.queryByRole("menuitemradio", { name: /High/ }) !== null,
    "ArrowRight opens the submenu",
  );

  key(document.activeElement ?? submenuTrigger, "ArrowLeft");
  await waitUntil(
    t,
    () => screen.queryByRole("menuitemradio", { name: /High/ }) === null,
    "ArrowLeft closes it again",
  );

  key(screen.getByRole("menuitem", { name: /Reasoning/ }), "ArrowRight");
  const high = await screen.findByRole("menuitemradio", { name: /High/ });
  fireEvent.click(high);

  await waitUntil(
    t,
    () => screen.getByTestId("effort").textContent === "high",
    "the submenu reports its value through its own onChange",
  );
});

test.serial("a switch and a checkbox report their state", (t) => {
  function Harness() {
    const [on, setOn] = useState(false);
    const [checked, setChecked] = useState(true);
    return (
      <>
        <Switch label="Reduce motion" checked={on} onCheckedChange={setOn} />
        <Checkbox label="Include archived" checked={checked} onCheckedChange={setChecked} />
      </>
    );
  }
  render(<Harness />);

  const toggle = screen.getByRole("switch", { name: "Reduce motion" });
  t.is(toggle.getAttribute("aria-checked"), "false");
  fireEvent.click(toggle);
  t.is(toggle.getAttribute("aria-checked"), "true");

  const box = screen.getByRole("checkbox", { name: "Include archived" });
  t.is(box.getAttribute("aria-checked"), "true");
  fireEvent.click(box);
  t.is(box.getAttribute("aria-checked"), "false");
});

test.serial("tabs swap the visible panel", async (t) => {
  function Harness() {
    const [value, setValue] = useState("general");
    return (
      <Tabs
        value={value}
        onValueChange={setValue}
        label="Sections"
        tabs={[
          { value: "general", label: "General" },
          { value: "appearance", label: "Appearance" },
        ]}
      >
        <TabPanel value="general">General panel</TabPanel>
        <TabPanel value="appearance">Appearance panel</TabPanel>
      </Tabs>
    );
  }
  render(<Harness />);

  t.truthy(screen.getByText("General panel"));
  fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
  t.truthy(await screen.findByText("Appearance panel"));
});

test.serial("a field wires its label, control and message together", (t) => {
  render(
    <Field label="Instruction" error="Too long">
      {({ id, describedBy }) => (
        <Textarea id={id} aria-describedby={describedBy} defaultValue="Answer concisely." />
      )}
    </Field>,
  );

  const control = screen.getByLabelText("Instruction");
  const describedBy = control.getAttribute("aria-describedby");
  t.truthy(describedBy);
  t.is(document.getElementById(describedBy!)?.textContent, "Too long");
});

test.serial("the find bar reports matches and steps through them", (t) => {
  const steps: string[] = [];
  render(
    <FindBar
      placeholder="Find in document"
      term="passage"
      onTermChange={() => {}}
      matchIndex={1}
      matchCount={4}
      caseSensitive={false}
      onCaseSensitiveChange={() => {}}
      useRegex={false}
      onUseRegexChange={() => {}}
      onFindNext={() => steps.push("next")}
      onFindPrevious={() => steps.push("previous")}
      onClose={() => steps.push("close")}
    />,
  );

  t.truthy(screen.getByText("2/4"), "the label is one-based");

  fireEvent.click(screen.getByRole("button", { name: "Next match" }));
  fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
  key(screen.getByRole("textbox", { name: "Find in document" }), "Enter");
  key(screen.getByRole("textbox", { name: "Find in document" }), "Enter", { shiftKey: true });
  key(screen.getByRole("textbox", { name: "Find in document" }), "Escape");

  t.deepEqual(steps, ["next", "previous", "next", "previous", "close"]);
});

test.serial("the command palette filters and runs a command", async (t) => {
  const run: string[] = [];
  render(
    <CommandPalette
      open
      onClose={() => run.push("closed")}
      commands={[
        { id: "home", section: "Actions", title: "Home", action: () => run.push("home") },
        {
          id: "settings",
          section: "Actions",
          title: "Settings",
          action: () => run.push("settings"),
        },
        {
          id: "tree",
          section: "Research",
          title: "Collective memory",
          action: () => run.push("tree"),
        },
      ]}
    />,
  );

  const input = await screen.findByRole("combobox", { name: "Command palette filter" });
  t.is(screen.getAllByRole("option").length, 3);

  fireEvent.change(input, { target: { value: "coll" } });
  await waitUntil(
    t,
    () => screen.queryAllByRole("option").length === 1,
    "the filter narrows the list",
  );

  key(input, "Enter");
  t.deepEqual(run, ["closed", "tree"], "the palette closes before the command runs");
});

test.serial("the notification stack shows at most three toasts", async (t) => {
  const items: NotificationItem[] = Array.from({ length: 5 }, (_value, index) => ({
    id: `n${index}`,
    title: `Toast ${index}`,
    body: "body",
    tone: "info",
    timeoutMs: 30_000,
    createdAt: Date.now(),
  }));

  const dismissed: string[] = [];
  render(<NotificationStack notifications={items} onDismiss={(id) => dismissed.push(id)} />);

  t.is(screen.getAllByRole("status").length, 3);
  t.truthy(screen.getByText("Toast 0"));
  t.is(screen.queryByText("Toast 3"), null);

  fireEvent.click(screen.getAllByRole("button", { name: "Dismiss notification" })[0]!);
  // The card animates out before it reports, so the id arrives after EXIT_MS
  // rather than on the click.
  await waitUntil(
    t,
    () => dismissed.join() === "n0",
    "the close button reports the toast it belongs to",
  );
});

test.serial("the image lightbox opens from its module store and dismisses itself", async (t) => {
  render(<ImageLightbox />);
  t.is(screen.queryByRole("dialog"), null);

  act(() => openImageLightbox({ src: "data:image/png;base64,", alt: "A chart" }));

  const lightbox = await screen.findByRole("dialog", { name: "A chart" });
  t.truthy(lightbox);
  t.is(
    useOverlaysStore.getState().entries.length,
    0,
    "a Base UI layer owns its own dismissal and must not also sit on the escape stack",
  );

  key(lightbox, "Escape");

  await waitUntil(t, () => screen.queryByRole("dialog") === null, "Escape closes the lightbox");
  t.is(getImageLightbox(), null, "closing goes through the module store, not local state");
});

test.serial("history navigation controls disable unavailable travel directions", (t) => {
  const moves: string[] = [];
  render(
    <HistoryNav
      canGoBack
      canGoForward={false}
      onBack={() => moves.push("back")}
      onForward={() => moves.push("forward")}
    />,
  );

  const forward = screen.getByRole("button", { name: "Forward" });
  t.true((forward as HTMLButtonElement).disabled);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(forward);
  t.deepEqual(moves, ["back"]);
});

test.serial("the sidebar restore button includes its shortcut in the tooltip", (t) => {
  let restored = 0;
  render(<SidebarRestoreButton onRestore={() => (restored += 1)} />);
  const button = screen.getByRole("button", { name: "Show sidebar" });
  t.is(button.getAttribute("title"), `Show sidebar (${formatChord("mod+shift+g")})`);
  fireEvent.click(button);
  t.is(restored, 1);
});

test.serial("the composer submit glyph matches the shortcut it describes", (t) => {
  render(
    <>
      <ComposerSubmitShortcutGlyph />
      <ShortcutHint>⌘K</ShortcutHint>
    </>,
  );

  t.truthy(screen.getByLabelText(/^(Command|Control) Enter$/));
  t.truthy(screen.getByText("⌘K"));

  const enter = {
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    nativeEvent: { isComposing: false },
  };
  t.false(isComposerSubmitShortcut(enter as never, true), "a bare Enter inserts a newline");
  t.false(isComposerSubmitShortcut(enter as never, false));
  t.true(isComposerSubmitShortcut({ ...enter, metaKey: true } as never, true), "⌘↵ on Apple");
  t.false(isComposerSubmitShortcut({ ...enter, ctrlKey: true } as never, true));
  t.true(isComposerSubmitShortcut({ ...enter, ctrlKey: true } as never, false), "Ctrl↵ elsewhere");
  t.false(
    isComposerSubmitShortcut(
      { ...enter, metaKey: true, nativeEvent: { isComposing: true } } as never,
      true,
    ),
    "an IME confirmation is not a submit",
  );
});
