import test, { type ExecutionContext } from "ava";

import {
  MAX_HIGHLIGHT_CONTEXT_BYTES,
  MAX_HIGHLIGHT_EXACT_BYTES,
  MAX_RESEARCH_HIGHLIGHTS_PER_NODE,
  MAX_RESEARCH_HIGHLIGHT_BYTES_PER_NODE,
  MAX_RESEARCH_HIGHLIGHT_BYTES_TOTAL,
  MAX_RESPONSE_SNAPSHOT_BYTES,
  highlightCollectionStorageBytes,
  highlightStorageBytes,
  validateHighlightAnchor,
  validateHighlightBudget,
  validateHighlightCollection,
} from "../src/research/highlightAnchor.js";
import type { ResearchHighlight, ResearchHighlightAnchor } from "../src/types/research.js";

const REVISION = "a".repeat(64);

function anchor(overrides: Partial<ResearchHighlightAnchor> = {}): ResearchHighlightAnchor {
  return {
    version: 1,
    projection: "answer-v1",
    responseRevision: REVISION,
    start: 10,
    end: 24,
    exact: "Rayleigh light",
    prefix: "because of ",
    suffix: " scattering",
    ...overrides,
  };
}

function highlight(
  overrides: Partial<ResearchHighlightAnchor> = {},
  id = "hl-1",
): ResearchHighlight {
  return { id, anchor: anchor(overrides), createdAt: 1 };
}

/** The message of the error `run` throws; fails the test when it does not. */
function message(t: ExecutionContext, run: () => void): string {
  return t.throws(run)?.message ?? "";
}

test("a well-formed anchor is accepted", (t) => {
  t.notThrows(() => {
    validateHighlightAnchor(anchor());
  });
  // Astral characters are two UTF-16 code units, the unit the offsets use.
  t.notThrows(() => {
    validateHighlightAnchor(anchor({ start: 0, end: 4, exact: "🌊🌊" }));
  });
});

test("an unsupported version or projection is rejected", (t) => {
  t.is(
    message(t, () => {
      validateHighlightAnchor({ ...anchor(), version: 2 as 1 });
    }),
    "unsupported research highlight anchor",
  );
  t.is(
    message(t, () => {
      validateHighlightAnchor({ ...anchor(), projection: "answer-v2" as "answer-v1" });
    }),
    "unsupported research highlight anchor",
  );
});

test("an empty or inverted selection is rejected", (t) => {
  t.is(
    message(t, () => {
      validateHighlightAnchor(anchor({ start: 24, end: 24 }));
    }),
    "research highlight selection cannot be empty",
  );
  t.is(
    message(t, () => {
      validateHighlightAnchor(anchor({ start: 30, end: 24 }));
    }),
    "research highlight selection cannot be empty",
  );
  t.is(
    message(t, () => {
      validateHighlightAnchor(anchor({ start: 0, end: 3, exact: "   " }));
    }),
    "research highlight selection cannot be empty",
  );
});

test("offsets must match the selected text and stay inside a snapshot", (t) => {
  t.is(
    message(t, () => {
      validateHighlightAnchor(anchor({ end: 25 }));
    }),
    "research highlight has invalid selection offsets",
  );
  t.is(
    message(t, () => {
      validateHighlightAnchor(anchor({ start: 0, end: 1, exact: "🌊" }));
    }),
    "research highlight has invalid selection offsets",
  );
  t.is(
    message(t, () => {
      validateHighlightAnchor(
        anchor({ start: MAX_RESPONSE_SNAPSHOT_BYTES, end: MAX_RESPONSE_SNAPSHOT_BYTES + 14 }),
      );
    }),
    "research highlight has invalid selection offsets",
  );
});

test("the selection and its context are size-capped in utf-8 bytes", (t) => {
  // Under the cap in code units, over it in bytes: the caps count bytes.
  const wide = "é".repeat(MAX_HIGHLIGHT_EXACT_BYTES / 2 + 1);
  t.is(
    message(t, () => {
      validateHighlightAnchor(anchor({ start: 0, end: wide.length, exact: wide }));
    }),
    "research highlight selection is too large",
  );
  t.is(
    message(t, () => {
      validateHighlightAnchor(anchor({ prefix: "é".repeat(MAX_HIGHLIGHT_CONTEXT_BYTES / 2 + 1) }));
    }),
    "research highlight selection is too large",
  );
  t.is(
    message(t, () => {
      validateHighlightAnchor(anchor({ suffix: "x".repeat(MAX_HIGHLIGHT_CONTEXT_BYTES + 1) }));
    }),
    "research highlight selection is too large",
  );
  t.notThrows(() => {
    validateHighlightAnchor(anchor({ suffix: "é".repeat(MAX_HIGHLIGHT_CONTEXT_BYTES / 2) }));
  });
});

test("the response revision must be 64 lowercase hex digits", (t) => {
  for (const revision of [
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    `${"a".repeat(63)}z`,
  ]) {
    t.is(
      message(t, () => {
        validateHighlightAnchor(anchor({ responseRevision: revision }));
      }),
      "research highlight has an invalid response revision",
      revision.slice(0, 8),
    );
  }
});

test("storage bytes follow the published formula", (t) => {
  const one = highlight();
  t.is(
    highlightStorageBytes(one),
    160 +
      "hl-1".length +
      "answer-v1".length +
      64 +
      6 * ("Rayleigh light".length + "because of ".length + " scattering".length),
  );
  // Multi-byte characters are charged by their utf-8 length.
  t.is(
    highlightStorageBytes(highlight({ start: 0, end: 1, exact: "é" })) -
      highlightStorageBytes(highlight({ start: 0, end: 1, exact: "e" })),
    6,
  );
  t.is(highlightCollectionStorageBytes([]), 0);
  t.is(highlightCollectionStorageBytes([one, one]), 2 * highlightStorageBytes(one));
});

test("a node's highlight set is bounded by count, ids, anchors, and bytes", (t) => {
  const many = Array.from({ length: MAX_RESEARCH_HIGHLIGHTS_PER_NODE + 1 }, (_value, index) =>
    highlight({}, `hl-${index}`),
  );
  t.is(
    message(t, () => {
      validateHighlightCollection(many);
    }),
    "a research answer can have at most 500 highlights",
  );
  t.is(
    message(t, () => {
      validateHighlightCollection([highlight(), highlight()]);
    }),
    "research highlights must have unique non-empty ids",
  );
  t.is(
    message(t, () => {
      validateHighlightCollection([highlight({}, "")]);
    }),
    "research highlights must have unique non-empty ids",
  );
  t.is(
    message(t, () => {
      validateHighlightCollection([highlight({ end: 25 })]);
    }),
    "research highlight has invalid selection offsets",
  );
  // The flat overhead makes the byte cap bind before the count cap: 500 of
  // these fit the count but not the 512 KiB budget.
  const big = "x".repeat(1_000);
  const heavy = Array.from({ length: MAX_RESEARCH_HIGHLIGHTS_PER_NODE }, (_value, index) =>
    highlight({ start: 0, end: big.length, exact: big }, `hl-${index}`),
  );
  t.true(highlightCollectionStorageBytes(heavy) > MAX_RESEARCH_HIGHLIGHT_BYTES_PER_NODE);
  t.is(
    message(t, () => {
      validateHighlightCollection(heavy);
    }),
    "a research answer contains too much highlight data",
  );
  t.notThrows(() => {
    validateHighlightCollection(heavy.slice(0, 60));
  });
});

test("the per-user budget is checked before an insertion", (t) => {
  const added = highlight();
  t.notThrows(() => {
    validateHighlightBudget(0, added);
  });
  t.is(
    message(t, () => {
      validateHighlightBudget(MAX_RESEARCH_HIGHLIGHT_BYTES_TOTAL, added);
    }),
    "your account contains too much saved research highlight data",
  );
});
