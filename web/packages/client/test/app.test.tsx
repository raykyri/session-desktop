import { cleanup, render, screen } from "@testing-library/react";
import test from "ava";

import { App } from "../src/App.js";

test.afterEach(cleanup);

test("renders the product name", (t) => {
  render(<App />);
  t.truthy(screen.getByRole("heading", { name: "Session" }));
});
