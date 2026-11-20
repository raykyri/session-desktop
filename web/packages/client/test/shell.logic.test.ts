// The app shell's pure parts (02 W2.2, W2.3, W2.7, §2.2 "Placement"): the
// bar's scroll reducer, its alignment to the feed columns, the usage ring's
// tone and label, the scope lists, the strip's fades, the route classes and
// the footer's address.

import test from "ava";

import { stripFades, emptyStripLine } from "../src/features/shell/ChannelStrip.js";
import { isFeedPath, channelOfPath, showsChannelStrip } from "../src/features/shell/screens.js";
import {
  channelsInScope,
  effectiveScope,
  scopesFor,
  type ShellChannel,
} from "../src/features/shell/shellData.js";
import {
  formatResetIn,
  formatTokens,
  usageLabel,
  usageTone,
  usedShare,
} from "../src/features/shell/usage.js";
import { barAlignment } from "../src/features/shell/useBarAlign.js";
import {
  barReducer,
  initialBarState,
  keepBar,
  takeKeepBar,
  type BarState,
} from "../src/features/shell/useBarAutoHide.js";
import { accountLine, viewerOf } from "../src/features/shell/viewer.js";
import { abuseAddress, PUBLIC_ORIGIN } from "../src/lib/publicOrigin.js";

import { testUser } from "./helpers.js";

// ------------------------------------------------------------ W2.3 reducer

/** Feeds scroll offsets through the reducer; `pinned` and `keepBar` per step. */
function run(
  offsets: (number | { y: number; pinned?: boolean; keepBar?: boolean })[],
  from: BarState = initialBarState,
): BarState[] {
  const states: BarState[] = [];
  let state = from;
  for (const step of offsets) {
    const {
      y,
      pinned = false,
      keepBar: keep = false,
    } = typeof step === "number" ? { y: step } : step;
    state = barReducer(state, { type: "scroll", y, pinned, keepBar: keep });
    states.push(state);
  }
  return states;
}

test("the bar shows within 48 px of the top, whatever the direction", (t) => {
  const states = run([20, 40, 47, 10]);
  t.deepEqual(
    states.map((state) => state.hidden),
    [false, false, false, false],
  );
});

test("past 48 px a step down over 4 px hides it and a step up over 4 px shows it", (t) => {
  const states = run([100, 300, 297, 292]);
  t.deepEqual(
    states.map((state) => state.hidden),
    [true, true, true, false],
    "300 to 297 is 3 px and keeps it hidden; 300 to 292 is 8 px up and shows it",
  );
});

test("steps of 4 px or less do not move the reference, so they add up", (t) => {
  const start: BarState = { hidden: false, lastY: 200 };
  const states = run([203, 206], start);
  t.false(states[0]?.hidden, "3 px is not a step");
  t.is(states[0]?.lastY, 200, "and the reference stays");
  t.true(states[1]?.hidden, "6 px from the reference is a step down");
  t.is(states[1]?.lastY, 206);
});

test("an up step of exactly 4 px does not show the bar; 5 px does", (t) => {
  const hidden: BarState = { hidden: true, lastY: 400 };
  t.true(run([396], hidden)[0]?.hidden);
  t.false(run([395], hidden)[0]?.hidden);
});

test("a pinned bar (menu open, focus inside) stays shown on a step down", (t) => {
  const states = run([{ y: 500, pinned: true }]);
  t.false(states[0]?.hidden);
  t.is(states[0]?.lastY, 500, "the reference moves with the step");
});

test("keepBar: the jump's scroll does not hide the bar and moves the reference", (t) => {
  const shown: BarState = { hidden: false, lastY: 0 };
  const [after] = run([{ y: 2400, keepBar: true }], shown);
  t.false(after?.hidden);
  t.is(after?.lastY, 2400);
  const [next] = run([2402], after);
  t.false(next?.hidden, "a 2 px step after the jump is measured from the new offset");
});

test("keepBar is consumed by the next scroll only", (t) => {
  keepBar();
  t.true(takeKeepBar());
  t.false(takeKeepBar());
});

test("reset and show events", (t) => {
  const hidden: BarState = { hidden: true, lastY: 900 };
  t.deepEqual(barReducer(hidden, { type: "reset", y: 30 }), { hidden: false, lastY: 30 });
  t.deepEqual(barReducer(hidden, { type: "show" }), { hidden: false, lastY: 900 });
  const shown: BarState = { hidden: false, lastY: 5 };
  t.is(barReducer(shown, { type: "show" }), shown, "no new state when nothing changes");
});

// ------------------------------------------------------- §2.2 placement

const shell = { left: 0, right: 1600 };
const main = { left: 400, right: 1000 };
const side = { left: 1021, right: 1351 };

test("above 1320 px in centred the bar takes the main column", (t) => {
  t.deepEqual(
    barAlignment({ layout: "centred", isFeed: true, viewportWidth: 1600, shell, main, side }),
    { left: 400, width: 600 },
  );
});

test("from 861 to 1320 px in centred the bar spans main and side columns", (t) => {
  const narrowShell = { left: 0, right: 1150 };
  const m = { left: 99, right: 699 };
  const s = { left: 720, right: 1050 };
  for (const width of [861, 1150, 1320]) {
    t.deepEqual(
      barAlignment({
        layout: "centred",
        isFeed: true,
        viewportWidth: width,
        shell: narrowShell,
        main: m,
        side: s,
      }),
      { left: 99, width: 951 },
      `at ${width}px`,
    );
  }
});

test("wide, 860 px and below, and non-feed screens get a full-width bar", (t) => {
  t.is(
    barAlignment({ layout: "wide", isFeed: true, viewportWidth: 1600, shell, main, side }),
    null,
  );
  t.is(
    barAlignment({ layout: "centred", isFeed: true, viewportWidth: 860, shell, main, side }),
    null,
  );
  t.is(
    barAlignment({ layout: "centred", isFeed: false, viewportWidth: 1600, shell, main, side }),
    null,
  );
  t.is(
    barAlignment({ layout: "centred", isFeed: true, viewportWidth: 1600, shell, main: null, side }),
    null,
    "no row measured yet",
  );
});

test("the alignment is relative to the shell's left edge", (t) => {
  t.deepEqual(
    barAlignment({
      layout: "centred",
      isFeed: true,
      viewportWidth: 1600,
      shell: { left: 16, right: 1600 },
      main,
      side,
    }),
    { left: 384, width: 600 },
  );
});

// ------------------------------------------------------------ usage ring

test("the ring's tone: ok below 80 %, warn from 80 %, bad from 95 %", (t) => {
  const allowance = 1000;
  t.is(usageTone(799, allowance), "ok");
  t.is(usageTone(800, allowance), "warn");
  t.is(usageTone(949, allowance), "warn");
  t.is(usageTone(950, allowance), "bad");
  // The plan's four points: 79.9, 80, 94.9 and 95 % used.
  t.is(usageTone(1_598_000, 2_000_000), "ok");
  t.is(usageTone(1_600_000, 2_000_000), "warn");
  t.is(usageTone(1_898_000, 2_000_000), "warn");
  t.is(usageTone(1_900_000, 2_000_000), "bad");
});

test("the arc is the share used, clamped", (t) => {
  t.is(usedShare(500, 1000), 0.5);
  t.is(usedShare(1500, 1000), 1);
  t.is(usedShare(-5, 1000), 0);
});

test("token and reset formatting follows the mock", (t) => {
  t.is(formatTokens(2_000_000), "2M");
  t.is(formatTokens(20_000_000), "20M");
  t.is(formatTokens(1_250_000), "1.25M");
  t.is(formatTokens(1_500_000), "1.5M");
  t.is(formatTokens(340_400), "340k");
  t.is(formatTokens(900), "900");
  t.is(formatResetIn(53 * 3_600_000), "2 days 5 h");
  t.is(formatResetIn(24 * 3_600_000), "1 day 0 h");
  t.is(formatResetIn(7 * 3_600_000), "7 h");
});

test("the ring's label", (t) => {
  const now = 1_700_000_000_000;
  t.is(
    usageLabel({ used: 660_000, allowance: 2_000_000, resetsAt: now + 53 * 3_600_000 }, now),
    "1.34M of 2M included tokens left this week; resets in 2 days 5 h",
  );
  t.is(
    usageLabel({ used: 0, allowance: 2_000_000, resetsAt: null }, now),
    "2M of 2M included tokens left this week",
  );
});

// ------------------------------------------------------ scopes and strip

const CHANNELS: ShellChannel[] = [
  { id: "1", name: "ml", private: false, joined: true, owned: true },
  { id: "2", name: "history", private: false, joined: true, owned: false },
  { id: "3", name: "open-house", private: false, joined: false, owned: false },
  { id: "4", name: "secret", private: true, joined: false, owned: false },
  { id: "5", name: "club", private: true, joined: true, owned: false },
];

test("scopes per viewer: signed out only All, writers also Channels you manage", (t) => {
  t.deepEqual(scopesFor(viewerOf(null)), ["all"]);
  t.deepEqual(scopesFor(viewerOf(testUser())), ["joined", "yours", "all"]);
  t.deepEqual(scopesFor(viewerOf({ ...testUser(), status: "waiting" } as never)), [
    "joined",
    "all",
  ]);
  t.is(effectiveScope(viewerOf(null), "joined"), "all", "signed out, Joined would equal All");
});

test("each scope lists its channels", (t) => {
  const names = (scope: "joined" | "yours" | "all") =>
    channelsInScope(CHANNELS, scope).map((channel) => channel.name);
  t.deepEqual(names("joined"), ["ml", "history", "club"]);
  t.deepEqual(names("yours"), ["ml"]);
  t.deepEqual(
    names("all"),
    ["ml", "history", "open-house", "club"],
    "no private channel of others",
  );
});

test("the strip's two empty lines", (t) => {
  t.is(emptyStripLine("yours"), "You have not made a channel yet.");
  t.is(emptyStripLine("joined"), "Nothing here yet.");
  t.is(emptyStripLine("all"), "Nothing here yet.");
});

test("the strip fades an edge only while content is hidden past it", (t) => {
  t.deepEqual(stripFades({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 }), {
    left: "0px",
    right: "0px",
  });
  t.deepEqual(stripFades({ scrollLeft: 0, clientWidth: 300, scrollWidth: 600 }), {
    left: "0px",
    right: "40px",
  });
  t.deepEqual(stripFades({ scrollLeft: 300, clientWidth: 300, scrollWidth: 600 }), {
    left: "40px",
    right: "0px",
  });
  t.deepEqual(stripFades({ scrollLeft: 100, clientWidth: 300, scrollWidth: 600 }), {
    left: "40px",
    right: "40px",
  });
});

// ------------------------------------------------------------ route classes

test("feed routes, channel paths and the strip's routes", (t) => {
  for (const path of ["/", "/saved", "/c/ml", "/c/reading-group/"]) {
    t.true(isFeedPath(path), path);
    t.true(showsChannelStrip(path), path);
  }
  for (const path of ["/browse", "/invites", "/usage", "/notifications", "/admin"]) {
    t.false(isFeedPath(path), path);
    t.true(showsChannelStrip(path), path);
  }
  for (const path of ["/welcome", "/settings"]) t.false(showsChannelStrip(path), path);
  t.is(channelOfPath("/c/ml"), "ml");
  t.is(channelOfPath("/c/ML"), null, "names are lowercase");
  t.is(channelOfPath("/c/a"), null, "at least two characters");
  t.false(isFeedPath("/c/Not_A_Name"));
});

// ------------------------------------------------------------ viewer

test("the account menu's header line", (t) => {
  const member = viewerOf(testUser({ login: "ines.v" }));
  const admin = viewerOf(testUser({ login: "sol", isAdmin: true }));
  const waiting = viewerOf({ ...testUser({ login: "new.one" }), status: "waiting" } as never);
  if (member.kind === "signedOut" || admin.kind === "signedOut" || waiting.kind === "signedOut") {
    t.fail("signed in");
    return;
  }
  t.is(accountLine(member), "@ines.v · Member");
  t.is(accountLine(admin), "@sol · Admin");
  t.is(accountLine(waiting), "@new.one · No invite yet");
});

// ------------------------------------------------------------ W2.7

test("the footer's address follows the configured origin", (t) => {
  t.is(abuseAddress("https://session.dev"), "abuse@session.dev");
  t.is(abuseAddress("https://staging.session.dev"), "abuse@staging.session.dev");
  t.is(abuseAddress("http://localhost:1480"), "abuse@localhost");
  t.is(PUBLIC_ORIGIN, "https://session.dev", "outside a Vite build: the production origin");
});
