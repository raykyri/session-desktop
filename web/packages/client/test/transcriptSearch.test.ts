import test from "ava";

import { collectSearchRanges } from "../src/lib/transcriptSearch.js";

test("hidden matches do not prevent finding visible document text", (t) => {
  const original = Range.prototype.getClientRects;
  Range.prototype.getClientRects = function () {
    const hidden = this.startContainer.parentElement?.closest("[hidden]");
    return Object.assign(hidden ? [] : [new DOMRect(0, 0, 10, 10)], {
      item: () => null,
    }) as DOMRectList;
  };
  t.teardown(() => {
    Range.prototype.getClientRects = original;
  });
  const root = document.createElement("div");
  root.innerHTML = `<div hidden>${"x".repeat(2_000)}</div><p>${"x".repeat(2_100)}</p>`;
  const ranges = collectSearchRanges(root, "x", { caseSensitive: false, regex: false });
  t.is(ranges.length, 2_000);
  t.is(ranges[0]?.startContainer, root.querySelector("p")?.firstChild);
});
