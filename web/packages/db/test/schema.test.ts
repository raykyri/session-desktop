import test from "ava";

import { schemaVersion } from "../src/index.js";

test("starts before the first migration", (t) => {
  t.is(schemaVersion, 0);
});
