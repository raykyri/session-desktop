import assert from "node:assert/strict";
import test from "node:test";
import { formatElapsedClock, formatRunDuration, shortWhen } from "../src/lib/shortTime";

const NOW = new Date(2026, 9, 9, 12, 0, 0).getTime();
const MINUTE = 60_000;

test("short relative times read as just now, minutes, hours, then days", () => {
  assert.equal(shortWhen(NOW - 20_000, NOW), "just now");
  assert.equal(shortWhen(NOW + 5 * MINUTE, NOW), "just now");
  assert.equal(shortWhen(NOW - 31 * MINUTE, NOW), "31 min");
  assert.equal(shortWhen(NOW - 2 * 60 * MINUTE, NOW), "2h");
  assert.equal(shortWhen(NOW - 2 * 24 * 60 * MINUTE, NOW), "2d");
  assert.equal(shortWhen(NOW - 29 * 24 * 60 * MINUTE, NOW), "29d");
});

test("older times fall back to a short date, with the year outside the current one", () => {
  assert.equal(shortWhen(new Date(2026, 1, 3).getTime(), NOW), "Feb 3");
  assert.equal(shortWhen(new Date(2025, 8, 12).getTime(), NOW), "Sep 12, 2025");
  assert.equal(shortWhen(Number.NaN, NOW), "");
});

test("elapsed clocks use m:ss and add hours past an hour", () => {
  assert.equal(formatElapsedClock(0), "0:00");
  assert.equal(formatElapsedClock(62_400), "1:02");
  assert.equal(formatElapsedClock(3_725_000), "1:02:05");
  assert.equal(formatElapsedClock(-5), "0:00");
});

test("run durations read as seconds, then minutes with padded seconds, then hours", () => {
  assert.equal(formatRunDuration(42_900), "42s");
  assert.equal(formatRunDuration(62_400), "1m 02s");
  assert.equal(formatRunDuration(3_725_000), "1h 02m");
  assert.equal(formatRunDuration(-5), "0s");
});
