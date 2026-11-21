// The fixture replica's world (02 §9.6), for the specs that still read it:
// the branch spec, whose asks need the run loop (05 M5a), and the visual
// spec, whose baselines are rendered from these threads. A build made with
// `VITE_SESSION_FIXTURES=1` exposes `window.__sessionFixtures`; the suite's
// build reads the sync replica and does not.

import type { Page } from "@playwright/test";

/** The mockup's first thread: an ask by @ines.v in #public with three
 * passage trees. */
export const FIRST_ASK = "01M7HWGZJGT7JTFFVSYPX055KV";

interface FixtureControls {
  hold: (state: "queued" | "running" | null) => void;
  flush: () => void;
}

interface FixtureWindow {
  __sessionFixtures: FixtureControls;
}

/** Keeps new runs at "Researching" (or queued) until `flushRuns`. */
export const holdRuns = (page: Page, state: "queued" | "running" | null) =>
  page.evaluate((s) => (window as unknown as FixtureWindow).__sessionFixtures.hold(s), state);
/** Answers every held run. */
export const flushRuns = (page: Page) =>
  page.evaluate(() => (window as unknown as FixtureWindow).__sessionFixtures.flush());
