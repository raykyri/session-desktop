// Review round 2 of phase 2, finding 7: Account › Your spaces › Edit header
// tabs orders and hides the header's spaces (`headerSpaces`), and the choice
// is kept in this browser (`stores/headerTabs.ts`).

import test from "ava";

import { headerSpaces, type Space } from "../src/data/spaces.js";
import { HEADER_TABS_KEY, headerTabs, setHeaderTabs } from "../src/stores/headerTabs.js";

const sp = (id: string, posts: number, vis = "open") =>
  ({ id, name: id, posts, members: 1, vis }) as unknown as Space;

const SPACES = [sp("a", 1), sp("b", 5), sp("c", 3), sp("closed", 9, "closed"), sp("d", 2)];
const ROLES = { c: "member" as const };
const names = (l: Space[]) => l.map((s) => s.id);

test("headerSpaces: joined first, then open spaces by activity; no closed space one is not in", (t) => {
  t.deepEqual(names(headerSpaces(SPACES, ROLES)), ["c", "b", "d", "a"]);
});

test("headerSpaces: the chosen order first, the rest in the default order, without hidden ones", (t) => {
  const tabs = { order: ["a", "d", "gone"], hidden: ["b"] };
  t.deepEqual(names(headerSpaces(SPACES, ROLES, tabs)), ["a", "d", "c"]);
  // a closed space one is not in stays out even when ordered
  t.deepEqual(names(headerSpaces(SPACES, ROLES, { order: ["closed"], hidden: [] })), [
    "c",
    "b",
    "d",
    "a",
  ]);
});

test.serial("header tabs are kept in localStorage and read back", (t) => {
  setHeaderTabs({ order: ["d", "a"], hidden: ["b"] });
  t.deepEqual(JSON.parse(localStorage.getItem(HEADER_TABS_KEY) ?? "null"), {
    order: ["d", "a"],
    hidden: ["b"],
  });
  t.deepEqual(headerTabs(), { order: ["d", "a"], hidden: ["b"] });
  setHeaderTabs({ order: [], hidden: [] });
});
