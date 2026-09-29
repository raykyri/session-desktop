import type { Appearance, ColorTheme } from "@session/shared";
import { Ellipsis, Link2 } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "../lib/cn.js";
import { formatChord } from "../lib/platform.js";
import { openDiagramLightbox, openImageLightbox } from "../stores/lightboxes.js";
import type { NotificationItem } from "../stores/notifications.js";
import { ControlButton, IconButton, LinkButton } from "../ui/Button.js";
import { CommandPalette } from "../ui/CommandPalette.js";
import { ComposerSubmitShortcutGlyph } from "../ui/ComposerSubmitShortcut.js";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "../ui/ContextMenu.js";
import { ConfirmDialog, Dialog } from "../ui/Dialog.js";
import { DomSearchBar } from "../ui/DomSearchBar.js";
import { Field, Input, ShortcutHint, Textarea } from "../ui/Field.js";
import { FindBar } from "../ui/FindBar.js";
import { HistoryNav } from "../ui/HistoryNav.js";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu.js";
import { NotificationStack } from "../ui/NotificationStack.js";
import { Popover } from "../ui/Popover.js";
import { LauncherSelect, Select } from "../ui/Select.js";
import { SidebarRestoreButton } from "../ui/SidebarRestoreButton.js";
import { TabPanel, Tabs } from "../ui/Tabs.js";
import { Checkbox, Switch } from "../ui/Toggle.js";
import { Tooltip } from "../ui/Tooltip.js";

const COMBINATIONS: { theme: ColorTheme; appearance: Appearance; label: string }[] = [
  { theme: "green-blob", appearance: "dark", label: "Cool · Dark" },
  { theme: "green-blob", appearance: "light", label: "Cool · Light" },
  { theme: "orange-blob", appearance: "dark", label: "Warm · Dark" },
  { theme: "orange-blob", appearance: "light", label: "Warm · Light" },
];

const SELECT_OPTIONS = [
  { value: "gemini-flash", label: "Gemini Flash" },
  { value: "deepseek-flash", label: "DeepSeek Flash", detail: "OpenRouter" },
  { value: "gpt-luna", label: "GPT Luna", detail: "OpenRouter" },
  { value: "claude-fable", label: "Claude Fable", dividerBefore: true, detail: "admin" },
];

const TOASTS: NotificationItem[] = [
  {
    id: "a",
    title: "Run finished",
    body: "Collective memory",
    tone: "success",
    timeoutMs: 30_000,
    createdAt: Date.now(),
  },
  {
    id: "b",
    title: "Rate limited",
    body: "Retrying in 12s",
    tone: "warning",
    timeoutMs: 30_000,
    createdAt: Date.now(),
  },
  {
    id: "c",
    title: "Run failed",
    body: "provider_unavailable",
    tone: "error",
    timeoutMs: 30_000,
    createdAt: Date.now(),
  },
];

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-fg-subtle m-0 text-xs tracking-wider uppercase">{title}</h3>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </section>
  );
}

/**
 * Every primitive at once, in all four theme × appearance combinations (08 §4).
 *
 * Each panel sets `data-color-theme` and `data-appearance` on its own wrapper
 * rather than on `<html>`, which is what makes the four combinations visible
 * side by side: tokens are declared on `:root` but inherit, so a subtree that
 * redeclares them re-resolves every `var()` beneath it. Portalled layers
 * (menus, dialogs, tooltips) escape to `document.body` and therefore follow the
 * app's real theme, not the panel's — that is the honest result, since that is
 * where they render in production too.
 *
 * Development only: the route is registered behind `import.meta.env.DEV` and
 * lazily imported, so this module is not in the production bundle.
 */
function Kitchen() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [model, setModel] = useState("gemini-flash");
  const [effort, setEffort] = useState("medium");
  const [switchOn, setSwitchOn] = useState(true);
  const [checked, setChecked] = useState(false);
  const [tab, setTab] = useState("one");
  const [term, setTerm] = useState("passage");
  const [toasts, setToasts] = useState(TOASTS);
  const proseRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <Row title="Buttons">
        <ControlButton>Control</ControlButton>
        <ControlButton size="sm">Small</ControlButton>
        <ControlButton size="lg">Large</ControlButton>
        <ControlButton tone="danger">Delete</ControlButton>
        <ControlButton disabled>Disabled</ControlButton>
        <IconButton label="More">
          <Ellipsis size={16} aria-hidden="true" />
        </IconButton>
        <LinkButton>Link button</LinkButton>
        <ShortcutHint>{formatChord("mod+shift+g")}</ShortcutHint>
        <ComposerSubmitShortcutGlyph />
        <HistoryNav canGoBack canGoForward={false} onBack={() => {}} onForward={() => {}} />
        <SidebarRestoreButton onRestore={() => {}} />
      </Row>

      <Row title="Fields">
        <Field label="Workspace name" hint="Shown in the sidebar.">
          {({ id, describedBy }) => (
            <Input id={id} aria-describedby={describedBy} defaultValue="Research" />
          )}
        </Field>
        <Field label="Instruction" error="Too long">
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              rows={2}
              defaultValue="Answer concisely."
            />
          )}
        </Field>
      </Row>

      <Row title="Selection">
        <Select
          label="Model"
          value={model}
          options={SELECT_OPTIONS}
          onChange={setModel}
          className="w-52"
        />
        <LauncherSelect
          label="Launch model"
          value={model}
          options={SELECT_OPTIONS}
          onChange={setModel}
          className="w-52"
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
        <Switch label="Example switch" checked={switchOn} onCheckedChange={setSwitchOn} />
        <Checkbox label="Include archived" checked={checked} onCheckedChange={setChecked} />
      </Row>

      <Row title="Layers">
        <Menu trigger={<ControlButton>Menu</ControlButton>} label="Example menu">
          <MenuItem hint={formatChord("mod+r")} onClick={() => {}}>
            Rename
          </MenuItem>
          <MenuItem hint={formatChord("mod+b")} onClick={() => {}}>
            Bookmark
          </MenuItem>
          <MenuSeparator />
          <MenuItem tone="danger" onClick={() => {}}>
            Delete
          </MenuItem>
        </Menu>
        <Menu
          size="sm"
          trigger={<ControlButton size="sm">Small menu</ControlButton>}
          label="Small example menu"
        >
          <MenuItem selected onClick={() => {}}>
            Gemini Flash
          </MenuItem>
          <MenuItem onClick={() => {}}>DeepSeek Flash</MenuItem>
        </Menu>
        <ContextMenu
          label="Link actions"
          items={
            <>
              <ContextMenuItem icon={<Link2 size={14} aria-hidden="true" />}>Open</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem>Copy link</ContextMenuItem>
            </>
          }
        >
          <span
            className={cn(
              "border-border-default rounded-md border border-dashed px-3 py-2 text-base",
            )}
          >
            Right-click me
          </span>
        </ContextMenu>
        <Popover trigger={<ControlButton>Popover</ControlButton>} label="Example popover">
          <p className="text-fg-secondary m-0 max-w-56 text-base">
            Anchored content that is not a menu.
          </p>
        </Popover>
        <Tooltip content="A tooltip" delay={0}>
          <ControlButton>Hover me</ControlButton>
        </Tooltip>
        <ControlButton onClick={() => setDialogOpen(true)}>Dialog</ControlButton>
        <ControlButton onClick={() => setConfirmOpen(true)}>Confirm</ControlButton>
        <ControlButton onClick={() => setPaletteOpen(true)}>Palette</ControlButton>
        <ControlButton
          onClick={() =>
            openImageLightbox({
              src:
                "data:image/svg+xml;utf8," +
                encodeURIComponent(
                  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"></svg>',
                ),
              alt: "Placeholder",
            })
          }
        >
          Image lightbox
        </ControlButton>
        <ControlButton
          onClick={() =>
            openDiagramLightbox({
              lang: "mermaid",
              label: "mermaid",
              svg: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"></svg>',
            })
          }
        >
          Diagram lightbox
        </ControlButton>
      </Row>

      <Row title="Tabs">
        <Tabs
          value={tab}
          onValueChange={setTab}
          label="Example tabs"
          className="w-full"
          tabs={[
            { value: "one", label: "General" },
            { value: "two", label: "Appearance" },
          ]}
        >
          <TabPanel value="one">
            <p className="text-fg-secondary m-0 text-base">First panel.</p>
          </TabPanel>
          <TabPanel value="two">
            <p className="text-fg-secondary m-0 text-base">Second panel.</p>
          </TabPanel>
        </Tabs>
      </Row>

      <Row title="Find">
        <FindBar
          placeholder="Find in document"
          term={term}
          onTermChange={setTerm}
          matchIndex={0}
          matchCount={3}
          caseSensitive={false}
          onCaseSensitiveChange={() => {}}
          useRegex={false}
          onUseRegexChange={() => {}}
          onFindNext={() => {}}
          onFindPrevious={() => {}}
          onClose={() => {}}
        />
        <DomSearchBar active placeholder="Find in document" rootRef={proseRef} />
      </Row>

      <Row title="Prose">
        <div ref={proseRef} className="research-reading-surface w-full">
          <div className="research-prose max-w-feed">
            <h2>A passage</h2>
            <p>
              Body copy with <strong>emphasis</strong>, <code>inline code</code>, a{" "}
              <a href="#top">link</a>.
            </p>
            <ul>
              <li>An unordered item</li>
              <li>Another item</li>
            </ul>
            <ol>
              <li>An ordered item</li>
              <li>A second step</li>
            </ol>
            <blockquote>A quoted line.</blockquote>
            <pre>
              <code>const answer = 42;</code>
            </pre>
            <p className="research-summary-text">A generated recap reads in this voice.</p>
          </div>
        </div>
      </Row>

      <Row title="Toasts">
        <ControlButton onClick={() => setToasts(TOASTS)}>Reset toasts</ControlButton>
        <NotificationStack
          notifications={toasts}
          onDismiss={(id) => setToasts((current) => current.filter((item) => item.id !== id))}
        />
      </Row>

      <Dialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title="Rename thread"
        description="Give this investigation a title."
        footer={<ControlButton onClick={() => setDialogOpen(false)}>Done</ControlButton>}
      >
        <Input defaultValue="Collective memory" aria-label="Title" className="w-full" />
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete thread?"
        description="This removes the thread and every branch under it."
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => setConfirmOpen(false)}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={[
          { id: "home", section: "Actions", title: "Home", action: () => {} },
          {
            id: "settings",
            section: "Actions",
            title: "Settings",
            hint: formatChord("mod+,"),
            action: () => {},
          },
          {
            id: "tree",
            section: "Research",
            title: "Collective memory",
            hint: "1 running",
            action: () => {},
          },
        ]}
      />
    </div>
  );
}

export function DevUiPage() {
  return (
    <div className="bg-surface-workspace h-full overflow-y-auto">
      {COMBINATIONS.map((combination) => (
        <div
          key={combination.label}
          data-color-theme={combination.theme}
          data-appearance={combination.appearance}
          className="border-border-divider bg-surface-workspace text-fg-primary border-b px-8 py-8"
        >
          <h2 className="text-reading text-fg-heading mt-0 mb-6 font-semibold">
            {combination.label}
          </h2>
          <Kitchen />
        </div>
      ))}
    </div>
  );
}
