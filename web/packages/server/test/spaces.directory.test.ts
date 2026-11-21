// `spaces.directory` (`01` C7, R5; `04` I5): open channels only, paged in id
// order, for a signed-out caller as for a member.

import type { Spaces } from "@session/shared";
import test from "ava";

import { createHarness } from "./helpers.js";

const space = (n: number, vis: "open" | "private" = "open"): Spaces.SpaceRecord =>
  ({
    kind: "space",
    id: `01M7YC40KD0CWWSYC3M6FT4G${String(n).padStart(2, "0")}`,
    name: `room-${n}`,
    desc: "",
    vis,
    owner: "olga",
    members: 1,
    frozen: false,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    rev: 1,
  }) as Spaces.SpaceRecord;

const spaces = [space(1), space(2, "private"), space(3), space(4), space(5)];

/** As the store answers: open channels after `after`, with their cursors. */
const directory = {
  openSpaces: (after: string | null, limit: number) =>
    spaces
      .filter((s) => s.vis === "open" && (after === null || s.id > after))
      .slice(0, limit)
      .map((space) => ({ space, cursor: space.id })),
  byName: (name: string) => spaces.find((s) => s.name === name) ?? null,
};

test("no private channel, for a signed-out caller or a member, and pages follow on", async (t) => {
  const h = createHarness(t, { deps: { directory } });
  const anonymous = await h.caller(null).spaces.directory({ limit: 2 });
  t.deepEqual(
    anonymous.spaces.map((s) => s.name),
    ["room-1", "room-3"],
  );
  t.truthy(anonymous.nextCursor);
  const member = h.caller(h.addUser("mona"));
  const next = await member.spaces.directory({ cursor: anonymous.nextCursor ?? "", limit: 2 });
  t.deepEqual(
    next.spaces.map((s) => s.name),
    ["room-4", "room-5"],
  );
  t.is(next.nextCursor, null, "the last page");
  const all = await h.caller(null).spaces.directory();
  t.is(all.spaces.length, 4);
  t.is(all.nextCursor, null);
});

test("a private channel the store returned is not served", async (t) => {
  const h = createHarness(t, {
    deps: {
      directory: {
        openSpaces: () => spaces.map((space) => ({ space, cursor: space.id })),
        byName: () => null,
      },
    },
  });
  const page = await h.caller(null).spaces.directory();
  t.false(page.spaces.some((s) => s.vis !== "open"));
});

test("byName answers a private channel's landing, and null for no channel", async (t) => {
  const h = createHarness(t, { deps: { directory } });
  t.is((await h.caller(null).spaces.byName({ name: "room-2" })).space?.vis, "private");
  t.is((await h.caller(null).spaces.byName({ name: "nowhere" })).space, null);
});
