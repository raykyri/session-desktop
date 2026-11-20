// The ⌘K palette's contents (`07-client-architecture.md` §5).

import test from "ava";

import { buildPaletteCommands, runningHint } from "../src/features/palette/commands.js";
import { formatChord } from "../src/lib/platform.js";

import { summary } from "./fixtures.js";

const noop = () => undefined;
const actions = { openTree: noop, openHome: noop, toggleSidebar: noop, openSettings: noop };

test("palette thread hints display the active run count only when runs are in progress", (t) => {
  t.is(runningHint(summary({ runningCount: 2 })), "2 running");
  t.is(runningHint(summary({ runningCount: 0 })), undefined);
});

test("the palette lists every thread, then the actions", (t) => {
  const commands = buildPaletteCommands(
    [
      summary({ id: "t1", title: "First", runningCount: 1 }),
      summary({ id: "t2", title: "Second", runningCount: 0 }),
    ],
    actions,
  );

  t.deepEqual(
    commands.map((command) => [command.section, command.title, command.hint]),
    [
      ["Research", "First", "1 running"],
      ["Research", "Second", undefined],
      ["Actions", "Home", formatChord("mod+shift+h")],
      ["Actions", "Toggle sidebar", formatChord("mod+shift+g")],
      ["Actions", "Settings", formatChord("mod+,")],
    ],
  );
});

test("a thread entry runs against its own id", (t) => {
  const opened: string[] = [];
  const commands = buildPaletteCommands([summary({ id: "t7" })], {
    ...actions,
    openTree: (treeId) => opened.push(treeId),
  });
  commands[0]?.action();
  t.deepEqual(opened, ["t7"]);
});

test("an account with no threads still has its actions", (t) => {
  const commands = buildPaletteCommands([], actions);
  t.deepEqual(
    commands.map((command) => command.id),
    ["home", "toggle-sidebar", "settings"],
  );
});
