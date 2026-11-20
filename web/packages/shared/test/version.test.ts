import test from "ava";

import { appName, version } from "../src/index.js";

test("exposes the product name", (t) => {
  t.is(appName, "Session");
});

test("exposes a semver contract version", (t) => {
  t.regex(version, /^\d+\.\d+\.\d+$/);
});
