// The validators forms and mutators share (`04` B1, §3.1, §10; `03` G2) and
// the package's time arithmetic.

import test from "ava";

import {
  accountHandleOk,
  addDays,
  boundedText,
  channelName,
  isoToMs,
  lookPhrase,
  mentionsIn,
  msToIso,
  onWordBoundaries,
} from "../src/index.js";

import { World, ok, refused } from "./world.js";

/** The channel name table (`04` B1): what a person types, and the stored
 * name or null. The New channel dialog and `spaces.create` use the same
 * validator, so the mutator accepts exactly the names the table accepts. */
const NAMES: [string, string | null][] = [
  ["lounge", "lounge"],
  ["#Lounge", "lounge"],
  ["  #lab-2 ", "lab-2"],
  ["a1", "a1"],
  ["x".repeat(30), "x".repeat(30)],
  ["x".repeat(31), null],
  ["a", null],
  ["-lab", null],
  ["##lab", null],
  ["my channel", null],
  ["ünd", null],
  ["lab_2", null],
  ["", null],
];

test("a channel name is [a-z0-9][a-z0-9-]{1,29} after trimming, lowering and one leading #", (t) => {
  for (const [raw, want] of NAMES) t.is(channelName(raw), want, raw);
});

test("spaces.create accepts exactly the names the validator accepts", (t) => {
  for (const [raw, want] of NAMES) {
    const w = new World();
    const a = w.apply("eve", "spaces.create", { id: w.id(), name: raw });
    if (want === null) refused(t, a, "BAD_REQUEST");
    else {
      ok(t, a);
      t.is(w.all("space")[0]?.name, want);
    }
  }
});

test("an account handle is 3 to 20 of a-z, 0-9, . and _", (t) => {
  for (const h of ["ada", "ines.v", "a_b", "x".repeat(20)]) t.true(accountHandleOk(h), h);
  for (const h of ["ab", "x".repeat(21), "Ada", "a-b", "null", "a b"])
    t.false(accountHandleOk(h), h);
});

test("text is trimmed and bounded", (t) => {
  t.is(boundedText("  About  ", 300), "About");
  t.is(boundedText("   ", 300), null);
  t.is(boundedText("x".repeat(301), 300), null);
});

test("a look-up phrase is 1 to 4 whole words of its quote", (t) => {
  t.is(lookPhrase("“tide gauge”,"), "tide gauge");
  t.is(lookPhrase("one  two three four"), "one two three four");
  t.is(lookPhrase("one two three four five"), null);
  t.is(lookPhrase(" … "), null);
  const quote = "Each tide gauge\nrecords the (sea level).";
  t.true(onWordBoundaries("tide gauge", quote));
  t.true(onWordBoundaries("gauge records", quote));
  t.true(onWordBoundaries("sea level", quote));
  t.false(onWordBoundaries("ide gauge", quote));
  t.false(onWordBoundaries("tide gaug", quote));
  t.false(onWordBoundaries("ocean", quote));
});

test("mentions are handles after @, once each", (t) => {
  t.deepEqual(mentionsIn("@mona and @otto, @mona. mail@example.com @x."), ["mona", "otto", "x"]);
});

const msToIsoInverse = (iso: string) => isoToMs(msToIso(isoToMs(iso)));

test("stored times are computed without Date", (t) => {
  const cases: [string, number][] = [
    ["1970-01-01T00:00:00Z", 0],
    ["2000-02-29T12:34:56Z", 951_827_696_000],
    ["2026-11-16T10:00:00Z", 1_794_823_200_000],
    ["1969-12-31T23:59:59Z", -1000],
  ];
  for (const [iso, ms] of cases) {
    t.is(isoToMs(iso), ms, iso);
    t.is(msToIso(ms), iso, iso);
  }
  t.is(isoToMs("2026-11-16T10:00:00.250Z"), 1_794_823_200_250);
  t.is(msToIso(1_794_823_200_999), "2026-11-16T10:00:00Z");
  // an offset is read; a malformed or out-of-range time throws (M1b review 7)
  t.is(isoToMs("2026-11-16T11:30:00+01:30"), 1_794_823_200_000);
  t.is(isoToMs("2026-11-16T08:00:00-02:00"), 1_794_823_200_000);
  t.is(isoToMs("2026-11-16T10:00:00+00:00"), 1_794_823_200_000);
  for (const bad of [
    "not a time",
    "2026-13-01T00:00:00Z",
    "2026-02-29T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-00-10T00:00:00Z",
    "2026-11-00T00:00:00Z",
    "2026-11-16T24:00:00Z",
    "2026-11-16T10:60:00Z",
    "2026-11-16T10:00:60Z",
    "2026-11-16T10:00:00+24:00",
    "2026-11-16T10:00:00",
  ])
    t.throws(() => isoToMs(bad), { instanceOf: RangeError }, bad);
  t.is(isoToMs("2028-02-29T00:00:00Z"), msToIsoInverse("2028-02-29T00:00:00Z"));
  t.is(addDays("2028-02-28T23:00:00Z", 1), "2028-02-29T23:00:00Z");
  t.is(addDays("2026-12-31T08:00:00Z", 30), "2027-01-30T08:00:00Z");
});
