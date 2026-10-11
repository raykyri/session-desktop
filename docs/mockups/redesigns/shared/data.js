/*
 * Session redesign mocks: shared sample content.
 * Load with <script src="../shared/data.js"></script>; read window.SessionMocks.data.
 * Plain JS, no imports. Sample content only ("Kestrel" is a fictional JS engine repo).
 *
 * DATA SHAPE
 * now          ISO string. The mock's current time.
 * user         {name, initials}
 * providers    [{id: "claude"|"codex"|"grok", label, models: [string], efforts: [string]}]
 * statuses     {queued|running|done|failed|needs-review: {label, tone: "plain"|"run"|"ok"|"error"|"attention"}}
 *              App mapping: done = "complete". "needs-review" is a proposed state (the run finished
 *              and asks the user something or wants a decision); the app has no such state today.
 * workspaces   [{id, name, dir}]
 * folders      [{id, workspaceId, name}]. System places (not listed): Unfiled = folderId null (Home),
 *              Drafts = drafts[], Archive = thread.archivedAt != null.
 * threads      [Thread], newest activity first.
 *   Thread  {id, workspaceId, folderId|null, kind: "exchange"|"post"|"document", source?: "imported",
 *            title, provider, model, effort|null, status, createdAt, updatedAt, lastViewedAt|null,
 *            unread: bool, bookmarked: bool, followed: bool, archivedAt: ISO|null,
 *            recap: string|null, tags: [string], links: [threadId], rootTurnId, turns: [Turn]}
 *            Four or more threads (t1-t5) have full trees; the rest have one or two turns.
 *   Turn    {id, parentId|null, relation: "root"|"followup"|"branch",
 *            anchor: null | {turnId, paragraph (0-based index into the parent's answer[]), quote},
 *            question (Markdown), title, provider, model, effort|null, status,
 *            createdAt, completedAt|null, durationSec|null, starred: bool, recap: string|null,
 *            answer: [string]  (Markdown paragraphs; [] when queued or no answer yet),
 *            error: string|null, clarification?: string, post?: {format: "link", url, linkTitle, domain, author},
 *            sources: [Source], activity: [Step], highlights: [Highlight]}
 *            "followup" = inline continuation in the same messages column (app: inline: true).
 *            "branch" = new column pair to the right (app: inline: false, passage anchor).
 *   Source     {url, title, domain}
 *   Step       {kind: "think"|"read"|"grep"|"search"|"fetch"|"run"|"edit", label, detail?, ms, status: "ok"|"error"|"running"}
 *   Highlight  {id, paragraph, quote, color: "amber"|"blue"|"green"|"pink", note|null, createdAt}
 *              The app has one colour (amber) and no notes; color/note are proposals.
 * notes        [{id, workspaceId, title, updatedAt, tags, outline: [Outline]}]
 *   Outline    {text, ref?: {threadId, turnId?}, children?: [Outline]}
 * drafts       [{id, workspaceId, prompt, provider, model, createdAt, updatedAt}]
 * bookmarks    [{threadId, createdAt}]
 * inbox        [{id, kind: "unread"|"failed"|"clarify"|"running"|"queued", threadId, turnId, title, detail, createdAt}]
 *
 * DERIVED AT LOAD (computed at the bottom; do not edit by hand)
 * highlights   flat [{...Highlight, threadId, turnId, threadTitle, turnTitle, workspaceId}], newest first
 * sources      flat deduped [{...Source, refs: [{threadId, turnId}]}]
 * graph        {nodes: [{id, type: "thread"|"note", label, workspaceId, tags}], edges: [{from, to, type: "link"|"note-ref"}]}
 * byId         {threads: {id: Thread}, turns: {id: Turn & {threadId}}, notes: {id: Note}}
 */
window.SessionMocks = window.SessionMocks || {};
window.SessionMocks.data = (function () {
  var C = { provider: "claude", model: "opus", effort: "high" };
  var X = { provider: "codex", model: "gpt-5.6-sol", effort: "high" };
  var G = { provider: "grok", model: "grok-build", effort: null };
  function turn(agent, t) {
    t.provider = t.provider || agent.provider;
    t.model = t.model || agent.model;
    t.effort = t.effort === undefined ? agent.effort : t.effort;
    t.starred = !!t.starred;
    t.recap = t.recap || null;
    t.error = t.error || null;
    t.anchor = t.anchor || null;
    t.answer = t.answer || [];
    t.sources = t.sources || [];
    t.activity = t.activity || [];
    t.highlights = t.highlights || [];
    t.completedAt = t.completedAt || null;
    t.durationSec = t.durationSec == null ? null : t.durationSec;
    return t;
  }

  var data = {
    now: "2026-10-11T17:30:00Z",
    user: { name: "Raymond Aka", initials: "RA" },
    providers: [
      { id: "claude", label: "Claude Code", models: ["fable", "opus", "sonnet"], efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "codex", label: "Codex", models: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"], efforts: ["low", "medium", "high", "xhigh"] },
      { id: "grok", label: "Grok", models: ["grok-build"], efforts: [] }
    ],
    statuses: {
      queued: { label: "Queued", tone: "plain" },
      running: { label: "Running", tone: "run" },
      done: { label: "Done", tone: "ok" },
      failed: { label: "Failed", tone: "error" },
      "needs-review": { label: "Needs review", tone: "attention" }
    },
    workspaces: [
      { id: "ws-compilers", name: "Compilers", dir: "~/research/compilers" },
      { id: "ws-ml", name: "ML infra", dir: "~/research/ml-infra" },
      { id: "ws-reading", name: "Reading", dir: "~/research/reading" }
    ],
    folders: [
      { id: "f-jit", workspaceId: "ws-compilers", name: "JIT" },
      { id: "f-test262", workspaceId: "ws-compilers", name: "test262 conformance" },
      { id: "f-serving", workspaceId: "ws-ml", name: "Serving" },
      { id: "f-storage", workspaceId: "ws-ml", name: "Storage & replication" },
      { id: "f-papers", workspaceId: "ws-reading", name: "Papers" },
      { id: "f-links", workspaceId: "ws-reading", name: "Saved links" }
    ],
    threads: []
  };

  /* ---------- t1: DataView.getInt16 sign extension (full tree) ---------- */
  data.threads.push({
    id: "t1", workspaceId: "ws-compilers", folderId: "f-jit", kind: "exchange",
    title: "DataView.getInt16 returns 32769 on ARM64 baseline JIT",
    provider: "claude", model: "opus", effort: "high", status: "done",
    createdAt: "2026-10-10T14:02:00Z", updatedAt: "2026-10-11T16:48:00Z", lastViewedAt: "2026-10-11T09:15:00Z",
    unread: true, bookmarked: true, followed: false, archivedAt: null,
    recap: "ARM64 emitted ldrsh before rev16, so the sign came from the wrong byte. Fixed as ldrh + rev16 + sxth; x86-64 was already correct; sweep test added.",
    tags: ["jit", "arm64", "dataview", "sign-extension"], links: ["t2", "t6"],
    rootTurnId: "t1q1",
    turns: [
      turn(C, {
        id: "t1q1", parentId: null, relation: "root", title: "Find the getInt16 codegen bug", status: "done",
        question: "`DataView.prototype.getInt16(0)` on bytes `[0x80, 0x01]` returns `32769` in the ARM64 baseline JIT but `-32767` in the interpreter. Find the codegen bug in Kestrel.",
        createdAt: "2026-10-10T14:02:00Z", completedAt: "2026-10-10T14:09:40Z", durationSec: 460,
        recap: "Sign extension happened before the byte swap. Fix: ldrh, rev16, sxth.",
        answer: [
          "The interpreter is right. Bytes `80 01` read big-endian are `0x8001`, which as a signed 16-bit value is -32767. The baseline JIT returns 32769 (`0x00008001`), so the upper half was zero-filled instead of sign-filled. The fault is the order of the byte swap and the sign extension in `emit_dataview_load` for `Int16` with `littleEndian = false`.",
          "On ARM64 the current sequence is `ldrsh w0, [x1, x2]` followed by `rev16 w0, w0`. `ldrsh` sign-extends the little-endian halfword `0x0180`, which is positive, giving `0x00000180`. `rev16` then swaps the bytes within each halfword and produces `0x00008001`. The sign was taken from the wrong byte, and `rev16` never touches bits 16-31, so nothing repairs it.",
          "The fix is to load zero-extended, swap, then sign-extend: `ldrh w0, [x1, x2]`, `rev16 w0, w0`, `sxth w0, w0`. An equivalent form is `ldrh` + `rev w0, w0` + `asr w0, w0, #16`. I applied the first form in `src/jit/arm64/masm.rs` (`load16_be_signed`) because it mirrors the existing `Uint16` path, which already uses `ldrh` + `rev16`.",
          "`cargo test -p kestrel-jit dataview` passes after the change: 214 tests, of which 3 failed before (`get_int16_be_negative`, `get_int16_be_min`, `typed_array_roundtrip_be`)."
        ],
        sources: [
          { url: "https://developer.arm.com/documentation/ddi0602/latest/Base-Instructions/REV16--Reverse-bytes-in-16-bit-halfwords-", title: "REV16: Reverse bytes in 16-bit halfwords", domain: "developer.arm.com" },
          { url: "https://developer.arm.com/documentation/ddi0602/latest/Base-Instructions/SXTH--Signed-Extend-Halfword--an-alias-of-SBFM-", title: "SXTH: Signed Extend Halfword", domain: "developer.arm.com" },
          { url: "https://tc39.es/ecma262/#sec-getviewvalue", title: "ECMA-262: GetViewValue", domain: "tc39.es" }
        ],
        activity: [
          { kind: "think", label: "Planned: compare interpreter and JIT paths for Int16 big-endian", ms: 4200, status: "ok" },
          { kind: "grep", label: "Searched code: emit_dataview_load", detail: "src/jit/**  (4 matches)", ms: 310, status: "ok" },
          { kind: "read", label: "Read src/jit/lower_dataview.rs", ms: 120, status: "ok" },
          { kind: "read", label: "Read src/jit/arm64/masm.rs", detail: "lines 1180-1262", ms: 140, status: "ok" },
          { kind: "search", label: "Searched web: ARM64 rev16 sxth sign extension order", ms: 2900, status: "ok" },
          { kind: "fetch", label: "Fetched developer.arm.com/.../REV16", ms: 1800, status: "ok" },
          { kind: "edit", label: "Edited src/jit/arm64/masm.rs", detail: "+4 -2", ms: 260, status: "ok" },
          { kind: "run", label: "Ran cargo test -p kestrel-jit dataview", detail: "214 passed; 0 failed", ms: 48200, status: "ok" }
        ],
        highlights: [
          { id: "h1", paragraph: 1, quote: "The sign was taken from the wrong byte, and `rev16` never touches bits 16-31", color: "amber", note: "Root cause. Same shape as the 2024 Uint32 bug.", createdAt: "2026-10-10T14:20:00Z" },
          { id: "h2", paragraph: 2, quote: "load zero-extended, swap, then sign-extend", color: "green", note: null, createdAt: "2026-10-10T14:21:00Z" }
        ]
      }),
      turn(C, {
        id: "t1q2", parentId: "t1q1", relation: "followup", title: "Check the x86-64 path", status: "done",
        question: "Does the x86-64 path have the same ordering problem?",
        createdAt: "2026-10-10T14:12:00Z", completedAt: "2026-10-10T14:14:05Z", durationSec: 125,
        answer: [
          "No. x86-64 emits `movzx eax, word ptr [rsi+rdx]`, `rol ax, 8`, `movsx eax, ax`: zero-extend, swap within the low 16 bits, then sign-extend.",
          "The shared lowering in `lower_dataview.rs` passes `signed: true` to each backend, and only the ARM64 backend folded the sign into the load instruction. I added a `debug_assert!` there that a byte-swapped load is never emitted as a sign-extending load, so a future backend fails in debug builds instead of producing wrong values."
        ],
        activity: [
          { kind: "read", label: "Read src/jit/x64/masm.rs", detail: "lines 940-1010", ms: 130, status: "ok" },
          { kind: "edit", label: "Edited src/jit/lower_dataview.rs", detail: "+3", ms: 180, status: "ok" },
          { kind: "run", label: "Ran cargo test -p kestrel-jit --features debug-asserts dataview", detail: "214 passed", ms: 51000, status: "ok" }
        ]
      }),
      turn(C, {
        id: "t1q3", parentId: "t1q1", relation: "branch", title: "Unaligned halfword loads on ARM64", status: "done",
        anchor: { turnId: "t1q1", paragraph: 2, quote: "`ldrh w0, [x1, x2]`, `rev16 w0, w0`, `sxth w0, w0`" },
        question: "Is a halfword load safe at an unaligned offset here, or do we need the byte-by-byte fallback?",
        createdAt: "2026-10-10T14:31:00Z", completedAt: "2026-10-10T14:36:10Z", durationSec: 310, starred: true,
        answer: [
          "For normal (cacheable) memory, ARMv8-A permits unaligned `ldrh`, `ldrsh` and `ldr` while `SCTLR_EL1.A` is clear, which is the case for user space on Linux, macOS and Windows. DataView offsets are arbitrary, so unaligned accesses are routine and do not fault.",
          "The exceptions are exclusive and acquire/release loads (`ldxrh`, `ldarh`, `ldaxrh`), which require natural alignment. That matters only for `Atomics.*` on a `SharedArrayBuffer`, and the spec already restricts those to element-aligned indices of an `Int16Array`, so the JIT never sees an unaligned atomic halfword.",
          "An unaligned load that crosses a cache line costs a cycle or two on Apple M-series and Neoverse cores. One that crosses a page boundary can fault on the second page, as an aligned access to that page would. The byte-load fallback in `masm.rs` is only reachable on ARMv7, which Kestrel no longer targets; I'd delete it rather than fix its sign handling."
        ],
        sources: [
          { url: "https://developer.arm.com/documentation/den0024/a/An-Introduction-to-the-ARMv8-Instruction-Sets/The-ARMv8-instruction-sets/Alignment", title: "ARMv8-A Programmer's Guide: Alignment", domain: "developer.arm.com" },
          { url: "https://tc39.es/ecma262/#sec-validateatomicaccess", title: "ECMA-262: ValidateAtomicAccess", domain: "tc39.es" }
        ],
        activity: [
          { kind: "search", label: "Searched web: ARMv8 unaligned ldrh SCTLR_EL1.A user space", ms: 3100, status: "ok" },
          { kind: "fetch", label: "Fetched developer.arm.com/.../Alignment", ms: 1500, status: "ok" },
          { kind: "grep", label: "Searched code: byte_load_fallback", detail: "1 caller, cfg(target_arch = \"arm\")", ms: 220, status: "ok" }
        ],
        highlights: [
          { id: "h3", paragraph: 0, quote: "unaligned accesses are routine and do not fault", color: "blue", note: "Quote this in the PR description.", createdAt: "2026-10-10T14:40:00Z" }
        ]
      }),
      turn(C, {
        id: "t1q4", parentId: "t1q3", relation: "branch", title: "Regression sweep test", status: "done",
        anchor: { turnId: "t1q3", paragraph: 2, quote: "One that crosses a page boundary can fault on the second page" },
        question: "Write a regression test covering offsets 0-7 and both endiannesses, including a read that ends at the last byte of the buffer.",
        createdAt: "2026-10-11T16:30:00Z", completedAt: "2026-10-11T16:48:00Z", durationSec: 1080, starred: true,
        answer: [
          "Added `tests/dataview_int16_sweep.rs`. It allocates a 16-byte `ArrayBuffer`, writes each pattern at offsets 0-14 with `setUint16`, and compares the JIT result with the interpreter for `getInt16` and `getUint16`, little- and big-endian. Patterns: `0x8001`, `0x7fff`, `0x8000`, `0xffff`, `0x0080`. Offset 14 reads the last two bytes of the buffer.",
          "```js\nfor (const le of [false, true])\n  for (let off = 0; off <= 14; off++)\n    for (const v of [0x8001, 0x7fff, 0x8000, 0xffff, 0x0080]) {\n      dv.setUint16(off, v, le);\n      assertEq(dv.getInt16(off, le), (v << 16) >> 16);\n      assertEq(dv.getUint16(off, le), v);\n    }\n```",
          "The test runs with `--baseline-threshold=0` so the loop body executes JIT code from the first iteration. It fails on the parent commit (60 of 300 cases: big-endian `getInt16` for every pattern whose two bytes differ in their top bit, such as `0x8001` and `0x0080`) and passes with the fix. `0xffff` passed even before the fix because both bytes sign-extend the same way."
        ],
        activity: [
          { kind: "read", label: "Read tests/dataview_uint16.rs", ms: 90, status: "ok" },
          { kind: "edit", label: "Created tests/dataview_int16_sweep.rs", detail: "+58", ms: 400, status: "ok" },
          { kind: "run", label: "Ran git stash && cargo test -p kestrel-jit --test dataview_int16_sweep", detail: "60 failed (expected on parent)", ms: 39000, status: "error" },
          { kind: "run", label: "Ran git stash pop && cargo test -p kestrel-jit --test dataview_int16_sweep", detail: "300 passed", ms: 37000, status: "ok" }
        ]
      })
    ]
  });

  /* ---------- t2: Math.hypot coercion order (full tree, running) ---------- */
  data.threads.push({
    id: "t2", workspaceId: "ws-compilers", folderId: "f-test262", kind: "exchange",
    title: "Math.hypot skips valueOf after an Infinity argument",
    provider: "codex", model: "gpt-5.6-sol", effort: "high", status: "running",
    createdAt: "2026-10-11T15:10:00Z", updatedAt: "2026-10-11T17:24:00Z", lastViewedAt: "2026-10-11T17:20:00Z",
    unread: false, bookmarked: false, followed: false, archivedAt: null,
    recap: "Spec requires coercing every argument before checking for Infinity or NaN. Our loop returns early. Overflow for large inputs is a separate bug: scale by max |x|.",
    tags: ["test262", "builtins", "coercion", "floating-point"], links: ["t1", "t6"],
    rootTurnId: "t2q1",
    turns: [
      turn(X, {
        id: "t2q1", parentId: null, relation: "root", title: "What the spec requires for hypot", status: "done",
        question: "test262 `built-ins/Math/hypot` fails 2 tests on Kestrel: `valueOf` on later arguments isn't called when an earlier argument is `Infinity`. What does the spec require?",
        createdAt: "2026-10-11T15:10:00Z", completedAt: "2026-10-11T15:16:30Z", durationSec: 390,
        answer: [
          "Since ES2020, `Math.hypot ( ...args )` first converts every argument with `ToNumber`, in order, into a list, and only then inspects the values. The order of checks is: coerce all arguments; if any is +∞ or -∞, return +∞; if any is NaN, return NaN; if all are ±0, return +0; otherwise return an implementation-approximated square root of the sum of squares.",
          "Two consequences are observable. Every argument's `valueOf` or `Symbol.toPrimitive` runs exactly once, even after an infinite value has been seen, and an exception thrown while coercing a later argument propagates even if an earlier argument was `Infinity`. Infinity also takes precedence over NaN: `Math.hypot(NaN, Infinity)` is `Infinity`.",
          "Kestrel's `math_hypot` in `src/builtins/math.rs` returns as soon as it sees an infinite value inside the coercion loop. That skips the remaining coercions, and the two failing tests detect it by logging which `valueOf` calls happened.",
          "Fix: two passes. Coerce into a `SmallVec<[f64; 4]>`, then scan the list. The hypot microbenchmark changes by less than 1%."
        ],
        sources: [
          { url: "https://tc39.es/ecma262/#sec-math.hypot", title: "ECMA-262: Math.hypot", domain: "tc39.es" },
          { url: "https://github.com/tc39/test262/tree/main/test/built-ins/Math/hypot", title: "test262: built-ins/Math/hypot", domain: "github.com" }
        ],
        activity: [
          { kind: "fetch", label: "Fetched tc39.es/ecma262/#sec-math.hypot", ms: 2100, status: "ok" },
          { kind: "run", label: "Ran ls test262/test/built-ins/Math/hypot", ms: 40, status: "ok" },
          { kind: "read", label: "Read src/builtins/math.rs", detail: "fn math_hypot", ms: 110, status: "ok" },
          { kind: "run", label: "Ran ./scripts/test262.sh built-ins/Math/hypot", detail: "2 failed", ms: 8800, status: "error" }
        ],
        highlights: [
          { id: "h4", paragraph: 1, quote: "Infinity also takes precedence over NaN", color: "amber", note: "Check Math.max/min for the same early return.", createdAt: "2026-10-11T15:20:00Z" }
        ]
      }),
      turn(X, {
        id: "t2q2", parentId: "t2q1", relation: "branch", title: "hypot overflow for large inputs", status: "done",
        anchor: { turnId: "t2q1", paragraph: 0, quote: "an implementation-approximated square root of the sum of squares" },
        question: "Why does `Math.hypot(1e200, 1e200)` return `Infinity` in Kestrel?",
        createdAt: "2026-10-11T15:40:00Z", completedAt: "2026-10-11T15:44:20Z", durationSec: 260, starred: true,
        answer: [
          "Squaring `1e200` gives `1e400`, which exceeds the largest finite double (about `1.798e308`), so the naive sum overflows before the square root is taken. The correct result is about `1.4142e200`; engines are expected to avoid the intermediate overflow.",
          "The standard fix is to scale by the largest magnitude: let `m = max |xᵢ|`; if `m` is 0 return 0; otherwise return `m * sqrt(Σ (xᵢ / m)²)`. Every term is then at most 1. V8 also uses compensated (Kahan) summation for the squares to reduce rounding error.",
          "test262 has no case for this overflow, so add a local test that `Math.hypot(1e200, 1e200)` is within 1 ulp of `1.4142135623730951e200`, and that `Math.hypot(1e-200, 1e-200)` does not underflow to 0."
        ],
        sources: [
          { url: "https://github.com/v8/v8/blob/main/src/builtins/math.tq", title: "v8/src/builtins/math.tq", domain: "github.com" },
          { url: "https://en.wikipedia.org/wiki/Kahan_summation_algorithm", title: "Kahan summation algorithm", domain: "en.wikipedia.org" }
        ],
        activity: [
          { kind: "run", label: "Ran kestrel -e 'print(Math.hypot(1e200, 1e200))'", detail: "Infinity", ms: 300, status: "ok" },
          { kind: "fetch", label: "Fetched github.com/v8/v8/blob/main/src/builtins/math.tq", ms: 2600, status: "ok" }
        ]
      }),
      turn(X, {
        id: "t2q3", parentId: "t2q1", relation: "followup", title: "Patch and run test262 hypot", status: "running",
        question: "Patch it (both fixes) and run the full `built-ins/Math` directory of test262.",
        createdAt: "2026-10-11T17:18:00Z",
        answer: [
          "Applied the two-pass coercion and max-scaling to `math_hypot`. Running `built-ins/Math` now; `hypot` passes, and the rest of the directory is in progress."
        ],
        activity: [
          { kind: "edit", label: "Edited src/builtins/math.rs", detail: "+31 -12", ms: 520, status: "ok" },
          { kind: "run", label: "Ran cargo build --release -p kestrel-cli", ms: 71000, status: "ok" },
          { kind: "run", label: "Ran ./scripts/test262.sh built-ins/Math/hypot", detail: "all passed", ms: 9100, status: "ok" },
          { kind: "run", label: "Running ./scripts/test262.sh built-ins/Math", detail: "212 of 327 files", ms: 0, status: "running" }
        ]
      })
    ]
  });

  /* ---------- t3: KV-cache paging (full tree, follow-up running + queued) ---------- */
  data.threads.push({
    id: "t3", workspaceId: "ws-ml", folderId: "f-serving", kind: "exchange",
    title: "KV-cache block size vs fragmentation in the paged allocator",
    provider: "claude", model: "opus", effort: "max", status: "running",
    createdAt: "2026-10-09T18:05:00Z", updatedAt: "2026-10-11T17:12:00Z", lastViewedAt: "2026-10-11T17:05:00Z",
    unread: false, bookmarked: true, followed: true, archivedAt: null,
    recap: "Tail-block waste explains <1% of the 11% idle KV memory; the rest is the free-block watermark and resident preempted blocks. Keep 32-token blocks.",
    tags: ["inference", "kv-cache", "paged-attention", "memory"], links: ["t7", "t8"],
    rootTurnId: "t3q1",
    turns: [
      turn(C, {
        id: "t3q1", parentId: null, relation: "root", title: "Would 16-token blocks help?", status: "done", effort: "max",
        question: "Our paged KV allocator uses 32-token blocks. Profiling shows about 11% of KV memory unused at peak. Would 16-token blocks help, and what do we give up?",
        createdAt: "2026-10-09T18:05:00Z", completedAt: "2026-10-09T18:21:00Z", durationSec: 960,
        recap: "Keep 32. Lower the watermark and cap resident preempted blocks instead.",
        answer: [
          "With paging, internal fragmentation is limited to each sequence's last, partly filled block: at most `block_size - 1` slots per sequence, and about `block_size / 2` on average when lengths are not correlated with the block size. At 32-token blocks and 256 running sequences that is about 4,096 idle slots.",
          "For Llama-3-70B (80 layers, 8 KV heads with GQA, head dim 128, fp16), one token of KV cache is 2 x 80 x 8 x 128 x 2 B = 327,680 B, or 320 KiB. Tail-block waste alone would reach 11% only if the mean sequence were about 145 tokens. Your trace's median is 1,850 tokens, so tail blocks account for under 1%.",
          "The rest is the scheduler's free-block watermark (`watermark = 0.08`, which keeps 8% of blocks free to avoid immediate preemption) plus blocks still held by preempted sequences waiting to swap back in. Moving to 16-token blocks would recover about 0.4%. It also doubles the block-table length per sequence, and in our own sweep (`bench/paged_attn_sweep.py`) decode throughput at batch 256 was 4% lower.",
          "Recommendation: keep 32. Lower the watermark to 0.04 and cap resident preempted blocks at 2% of the pool. Replaying yesterday's trace with both changes recovers about 7 of the 11 points without extra preemptions."
        ],
        sources: [
          { url: "https://arxiv.org/abs/2309.06180", title: "Efficient Memory Management for LLM Serving with PagedAttention", domain: "arxiv.org" },
          { url: "https://huggingface.co/meta-llama/Meta-Llama-3-70B/blob/main/config.json", title: "Meta-Llama-3-70B config.json", domain: "huggingface.co" },
        ],
        activity: [
          { kind: "read", label: "Read server/kv/allocator.py", ms: 160, status: "ok" },
          { kind: "read", label: "Read server/scheduler/config.py", detail: "watermark = 0.08", ms: 90, status: "ok" },
          { kind: "run", label: "Ran python tools/trace_stats.py traces/2026-10-08.jsonl", detail: "median 1,850 tokens; p99 7,912", ms: 14200, status: "ok" },
          { kind: "fetch", label: "Fetched arxiv.org/abs/2309.06180", ms: 2400, status: "ok" },
          { kind: "run", label: "Ran python bench/paged_attn_sweep.py --block-sizes 16,32 --batch 256", detail: "16: 4,710 tok/s; 32: 4,905 tok/s", ms: 412000, status: "ok" },
          { kind: "run", label: "Ran python tools/replay.py --watermark 0.04 --preempt-cap 0.02", detail: "idle KV 11.2% -> 4.1%", ms: 188000, status: "ok" }
        ],
        highlights: [
          { id: "h5", paragraph: 1, quote: "one token of KV cache is 2 x 80 x 8 x 128 x 2 B = 327,680 B, or 320 KiB", color: "amber", note: "Per-token KV size for the capacity sheet.", createdAt: "2026-10-09T18:30:00Z" },
          { id: "h6", paragraph: 2, quote: "plus blocks still held by preempted sequences waiting to swap back in", color: "pink", note: "Ask Priya whether swap-in is FIFO.", createdAt: "2026-10-09T18:31:00Z" }
        ]
      }),
      turn(C, {
        id: "t3q2", parentId: "t3q1", relation: "branch", title: "Prefix caching and block size", status: "done", effort: "max",
        anchor: { turnId: "t3q1", paragraph: 2, quote: "It also doubles the block-table length per sequence" },
        question: "How does prefix caching interact with block size?",
        createdAt: "2026-10-10T10:12:00Z", completedAt: "2026-10-10T10:19:30Z", durationSec: 450, starred: true,
        answer: [
          "Prefix caching shares only full blocks. Each full block is keyed by a hash of its token ids together with the hash of the block before it, so two requests share block k only if their first (k + 1) x block_size tokens are identical.",
          "With a 1,000-token shared system prompt, 32-token blocks share 31 blocks (992 tokens) and recompute 8 tokens per request; 16-token blocks share 62 blocks, also 992 tokens. In general the unshared tail averages half a block: 16 tokens at block size 32, 8 at block size 16.",
          "Copy-on-write is also per block. When two sequences that share a partly filled last block both append, the allocator copies that block. Larger blocks make each copy larger, but copies are rare outside parallel sampling (`n > 1`) and beam search.",
          "For your traffic (one 1,236-token system prompt, mostly unique user turns), block size changes the prefix hit rate by under one percentage point. It is not a reason to change block size."
        ],
        sources: [{ url: "https://docs.vllm.ai/en/latest/design/prefix_caching.html", title: "vLLM: Automatic prefix caching", domain: "docs.vllm.ai" }],
        activity: [
          { kind: "read", label: "Read server/kv/prefix_cache.py", ms: 140, status: "ok" },
          { kind: "run", label: "Ran python tools/prefix_hits.py traces/2026-10-08.jsonl --block-sizes 16,32", detail: "hit rate 61.8% vs 62.4%", ms: 52000, status: "ok" }
        ],
        highlights: [
          { id: "h7", paragraph: 0, quote: "Prefix caching shares only full blocks.", color: "blue", note: null, createdAt: "2026-10-10T10:25:00Z" }
        ]
      }),
      turn(C, {
        id: "t3q3", parentId: "t3q1", relation: "followup", title: "Concurrency on 2xH100", status: "running", effort: "max",
        question: "Estimate max concurrent 8k-token sequences for Llama-3-70B on 2x H100 80GB with TP=2.",
        createdAt: "2026-10-11T17:02:00Z",
        answer: [
          "Weights in fp16 take about 141 GB (70.6B parameters x 2 B), which leaves roughly 19 GB across both GPUs before activations and CUDA graphs. At 320 KiB per token an 8k sequence needs 2.5 GiB, so fp16 weights allow about 6 sequences. Checking whether `configs/serving/llama3-70b.yaml` serves FP8 weights..."
        ],
        activity: [
          { kind: "think", label: "Planned: weights, activations, KV per sequence", ms: 3800, status: "ok" },
          { kind: "read", label: "Reading configs/serving/llama3-70b.yaml", ms: 0, status: "running" }
        ]
      }),
      turn(C, {
        id: "t3q4", parentId: "t3q3", relation: "followup", title: "Repeat with FP8 KV cache", status: "queued", effort: "max",
        question: "Then repeat the estimate with an FP8 (e4m3) KV cache.",
        createdAt: "2026-10-11T17:06:00Z"
      })
    ]
  });

  /* ---------- t4: Litestream replication lag (full tree, failed follow-up) ---------- */
  data.threads.push({
    id: "t4", workspaceId: "ws-ml", folderId: "f-storage", kind: "exchange",
    title: "Litestream replica lag spikes to 40s during batch imports",
    provider: "grok", model: "grok-build", effort: null, status: "failed",
    createdAt: "2026-10-08T21:40:00Z", updatedAt: "2026-10-11T08:52:00Z", lastViewedAt: "2026-10-10T19:00:00Z",
    unread: true, bookmarked: false, followed: false, archivedAt: null,
    recap: "Lag is upload time for large WAL bursts plus RESTART checkpoint stalls caused by a long-lived reader. Commit in smaller transactions; fix the analytics reader.",
    tags: ["sqlite", "litestream", "replication", "wal"], links: ["t9"],
    rootTurnId: "t4q1",
    turns: [
      turn(G, {
        id: "t4q1", parentId: null, relation: "root", title: "Why lag spikes during imports", status: "done",
        question: "Litestream replica lag on our SQLite primary goes from about 1s to 30-40s whenever the nightly batch import runs. Why, and what should we change?",
        createdAt: "2026-10-08T21:40:00Z", completedAt: "2026-10-08T21:52:00Z", durationSec: 720,
        answer: [
          "Litestream 0.3.x, which your `litestream.yml` targets, copies new WAL frames into its shadow WAL on each monitor tick and uploads them to the replica every `sync-interval` (default 1s). While the WAL grows slowly, lag stays near the sync interval.",
          "During the import the WAL grows by 1.2-1.8 GB in a few minutes, because the importer commits 50,000-row transactions. Each sync then uploads hundreds of MB of compressed segments to S3, and lag becomes upload time rather than sync interval. Your dashboard shows the 38s peak at the same minutes as the largest segments.",
          "A second contributor: Litestream keeps a read transaction open so SQLite cannot checkpoint away frames it has not copied, and runs checkpoints itself. While the analytics job holds an old snapshot, its PASSIVE checkpoints cannot complete, so the WAL keeps growing until `max-checkpoint-page-count` (default 10,000 pages) forces a RESTART checkpoint, which blocks writers until readers release the old snapshot. That is the 3-5s write stall in the importer's logs.",
          "Changes, in order of effect: commit the import in 5,000-row transactions so WAL growth per sync stays under about 50 MB; fix the analytics job's long read transaction; and if you need a recovery point under 5s during imports, write the import to a separate database file with its own replica and swap it in afterwards."
        ],
        sources: [
          { url: "https://litestream.io/how-it-works/", title: "Litestream: How it works", domain: "litestream.io" },
          { url: "https://litestream.io/reference/config/", title: "Litestream configuration reference", domain: "litestream.io" },
          { url: "https://www.sqlite.org/wal.html", title: "SQLite: Write-Ahead Logging", domain: "sqlite.org" }
        ],
        activity: [
          { kind: "read", label: "Read deploy/litestream.yml", ms: 70, status: "ok" },
          { kind: "read", label: "Read jobs/import/nightly.py", detail: "BATCH = 50_000", ms: 110, status: "ok" },
          { kind: "fetch", label: "Fetched litestream.io/how-it-works/", ms: 1900, status: "ok" },
          { kind: "fetch", label: "Fetched sqlite.org/wal.html", ms: 1300, status: "ok" },
          { kind: "run", label: "Ran grep -c 'database is locked' logs/import-2026-10-08.log", detail: "41", ms: 60, status: "ok" }
        ],
        highlights: [
          { id: "h8", paragraph: 2, quote: "forces a RESTART checkpoint, which blocks writers until readers release the old snapshot", color: "pink", note: "This is the 3-5s stall.", createdAt: "2026-10-08T22:05:00Z" }
        ]
      }),
      turn(G, {
        id: "t4q2", parentId: "t4q1", relation: "followup", title: "Plot lag from S3 segment timestamps", status: "failed",
        question: "Pull the replica's WAL segment timestamps from S3 for last night and plot lag over time.",
        createdAt: "2026-10-11T08:50:00Z", completedAt: "2026-10-11T08:52:00Z", durationSec: 118,
        error: "AccessDenied: s3:ListBucket on arn:aws:s3:::acme-litestream-prod (assumed role session-research-ro).",
        activity: [
          { kind: "run", label: "Ran aws sts get-caller-identity", detail: "session-research-ro", ms: 900, status: "ok" },
          { kind: "run", label: "Ran aws s3 ls s3://acme-litestream-prod/db/generations/ --recursive", detail: "AccessDenied", ms: 1200, status: "error" }
        ]
      }),
      turn(G, {
        id: "t4q3", parentId: "t4q1", relation: "branch", title: "Lower max-checkpoint-page-count?", status: "done",
        anchor: { turnId: "t4q1", paragraph: 2, quote: "`max-checkpoint-page-count` (default 10,000 pages)" },
        question: "Should we lower `max-checkpoint-page-count`, or is the RESTART stall unavoidable?",
        createdAt: "2026-10-09T09:15:00Z", completedAt: "2026-10-09T09:22:00Z", durationSec: 420,
        answer: [
          "A RESTART checkpoint waits for readers on older snapshots to finish and blocks new writers while it waits. The copy itself is proportional to the pages written back, so lowering the threshold to 4,000 pages makes each copy about 2.5x shorter and 2.5x more frequent.",
          "At 4,000 pages (16 MB with 4 KiB pages) the copy takes about 40 ms on the gp3 volume, against about 100 ms at 10,000 pages. The 3-5s stalls are not the copy; they are the wait for the analytics job, which keeps one read transaction open for several minutes.",
          "So lowering the threshold will not remove the stalls. Fix the reader: chunk its queries into short transactions, or point it at a copy restored with `litestream restore`. Then the default threshold is fine."
        ],
        activity: [
          { kind: "run", label: "Ran sqlite3 prod.db 'PRAGMA page_size'", detail: "4096", ms: 50, status: "ok" },
          { kind: "read", label: "Read jobs/analytics/rollup.py", ms: 100, status: "ok" }
        ]
      })
    ]
  });

  /* ---------- t5: Raft membership changes (full tree, needs review) ---------- */
  data.threads.push({
    id: "t5", workspaceId: "ws-reading", folderId: "f-papers", kind: "exchange",
    title: "Raft joint consensus vs single-server membership changes",
    provider: "claude", model: "opus", effort: "high", status: "needs-review",
    createdAt: "2026-10-10T20:10:00Z", updatedAt: "2026-10-11T11:30:00Z", lastViewedAt: "2026-10-10T20:40:00Z",
    unread: true, bookmarked: true, followed: false, archivedAt: null,
    recap: "Both are safe with the 2015 fix (commit a no-op in the new term first). The choice depends on whether several voters change at once; the agent asked which case applies.",
    tags: ["raft", "consensus", "distributed-systems"], links: ["t10"],
    rootTurnId: "t5q1",
    turns: [
      turn(C, {
        id: "t5q1", parentId: null, relation: "root", title: "Which membership-change method?", status: "needs-review",
        question: "Compare Raft joint consensus with single-server membership changes. Which one should our metadata service use?",
        createdAt: "2026-10-10T20:10:00Z", completedAt: "2026-10-10T20:18:00Z", durationSec: 480,
        clarification: "Does the metadata service ever need to replace several voters at once (for example, moving 3 of 5 voters to a new region in one step)?",
        answer: [
          "Joint consensus (Raft paper, section 6) moves from C_old to C_new through an intermediate configuration C_old,new in which every election and commit needs separate majorities of both. It allows arbitrary membership changes in one step, at the cost of two configuration entries and more complex quorum logic.",
          "Single-server changes (Ongaro's dissertation, section 4.1) add or remove one server at a time. Any majority of the old configuration overlaps any majority of the new one, so no intermediate configuration is needed. A server uses the newest configuration in its log as soon as it is appended, not when it is committed.",
          "The single-server method had a safety bug, reported by Ongaro on raft-dev in 2015: changes interleaved with leader changes could produce two disjoint majorities. The fix is that a new leader must commit an entry from its own term (normally a no-op) before it starts a configuration change. hashicorp/raft uses single-server changes with this rule; etcd/raft supports both, with joint consensus available through `ConfChangeV2`.",
          "Before I recommend one: does the metadata service ever need to replace several voters at once, for example moving 3 of 5 voters to a new region in one step? If so, joint consensus avoids a window with reduced fault tolerance. If changes are always one node at a time, single-server changes are simpler to implement and test."
        ],
        sources: [
          { url: "https://raft.github.io/raft.pdf", title: "In Search of an Understandable Consensus Algorithm (Extended Version)", domain: "raft.github.io" },
          { url: "https://github.com/ongardie/dissertation", title: "Consensus: Bridging Theory and Practice (dissertation)", domain: "github.com" },
          { url: "https://groups.google.com/g/raft-dev/c/t4xj6dJTP6E", title: "raft-dev: bug in single-server membership changes", domain: "groups.google.com" },
          { url: "https://pkg.go.dev/go.etcd.io/raft/v3/raftpb#ConfChangeV2", title: "etcd raftpb.ConfChangeV2", domain: "pkg.go.dev" }
        ],
        activity: [
          { kind: "fetch", label: "Fetched raft.github.io/raft.pdf", detail: "section 6", ms: 3300, status: "ok" },
          { kind: "search", label: "Searched web: raft single server membership change bug 2015 ongaro", ms: 2700, status: "ok" },
          { kind: "fetch", label: "Fetched groups.google.com/g/raft-dev/...", ms: 2100, status: "ok" },
          { kind: "grep", label: "Searched code: ConfChange", detail: "services/meta/** (0 matches)", ms: 180, status: "ok" }
        ],
        highlights: [
          { id: "h9", paragraph: 1, quote: "A server uses the newest configuration in its log as soon as it is appended, not when it is committed.", color: "amber", note: null, createdAt: "2026-10-10T20:30:00Z" }
        ]
      }),
      turn(C, {
        id: "t5q2", parentId: "t5q1", relation: "branch", title: "The 2015 bug, step by step", status: "done",
        anchor: { turnId: "t5q1", paragraph: 2, quote: "changes interleaved with leader changes could produce two disjoint majorities" },
        question: "Walk through the 2015 bug with a concrete four-server example.",
        createdAt: "2026-10-11T11:20:00Z", completedAt: "2026-10-11T11:30:00Z", durationSec: 600,
        answer: [
          "Start with C = {S1, S2, S3, S4}. S1 is leader in term 1 and appends C1 = {S1, S2, S3, S4, S5} to add S5. It replicates the entry only to S5 before losing leadership, so C1 is uncommitted.",
          "S2 wins term 2 with votes from S2, S3 and S4, a majority of C. It appends C2 = {S1, S2, S3} to remove S4, replicates it to S3, and commits it: S2 and S3 are a majority of C2.",
          "S1 then times out and campaigns in term 3 under C1, which needs 3 of 5 votes. S5 votes for it, and so does S4, which never received S2's term-2 entry and so sees S1's log as at least as up to date. S1 wins with {S1, S4, S5} and overwrites the committed C2 entry on S3. With the fix, S2 would have committed a term-2 no-op first, which would have prevented S1 from winning."
        ],
        activity: [
          { kind: "think", label: "Worked through vote counts for each configuration", ms: 9100, status: "ok" }
        ]
      })
    ]
  });

  /* ---------- Shorter threads ---------- */
  data.threads.push({
    id: "t6", workspaceId: "ws-compilers", folderId: null, kind: "exchange",
    title: "Float64Array stores canonicalize NaN payloads",
    provider: "claude", model: "sonnet", effort: "medium", status: "done",
    createdAt: "2026-10-09T11:00:00Z", updatedAt: "2026-10-09T11:06:00Z", lastViewedAt: "2026-10-09T11:10:00Z",
    unread: false, bookmarked: false, followed: false, archivedAt: null,
    recap: "Allowed by the spec either way. Kestrel canonicalizes on store; V8 canonicalizes when a NaN-boxed value is read.",
    tags: ["typed-arrays", "nan-boxing", "spec"], links: ["t1", "t2"], rootTurnId: "t6q1",
    turns: [
      turn({ provider: "claude", model: "sonnet", effort: "medium" }, {
        id: "t6q1", parentId: null, relation: "root", title: "NaN payloads in typed arrays", status: "done",
        question: "Why does storing a NaN with a custom payload into a `Float64Array` canonicalize it in Kestrel but preserve it in V8? Is either wrong?",
        createdAt: "2026-10-09T11:00:00Z", completedAt: "2026-10-09T11:06:00Z", durationSec: 360,
        answer: [
          "Neither is wrong. `SetValueInBuffer` says that when the value is NaN, the stored bytes may be any implementation-chosen NaN encoding, so canonicalizing on store and preserving the payload are both conforming.",
          "Kestrel canonicalizes on store because its NaN-boxing scheme treats some NaN bit patterns as tagged pointers. V8 does not NaN-box heap numbers, so it can store the bits unchanged; engines that do NaN-box must canonicalize at the latest when the value is read back into a boxed JS value."
        ],
        sources: [{ url: "https://tc39.es/ecma262/#sec-setvalueinbuffer", title: "ECMA-262: SetValueInBuffer", domain: "tc39.es" }],
        activity: [
          { kind: "fetch", label: "Fetched tc39.es/ecma262/#sec-setvalueinbuffer", ms: 1700, status: "ok" },
          { kind: "read", label: "Read src/vm/value.rs", detail: "NaN-boxing tags", ms: 120, status: "ok" }
        ]
      })
    ]
  });

  data.threads.push({
    id: "t7", workspaceId: "ws-ml", folderId: "f-serving", kind: "exchange",
    title: "Speculative decoding: acceptance rate vs draft model size",
    provider: "codex", model: "gpt-6-astra", effort: "xhigh", status: "running",
    createdAt: "2026-10-11T16:40:00Z", updatedAt: "2026-10-11T17:28:00Z", lastViewedAt: null,
    unread: false, bookmarked: false, followed: false, archivedAt: null, recap: null,
    tags: ["inference", "speculative-decoding", "latency"], links: ["t3"], rootTurnId: "t7q1",
    turns: [
      turn({ provider: "codex", model: "gpt-6-astra", effort: "xhigh" }, {
        id: "t7q1", parentId: null, relation: "root", title: "Draft model sizing", status: "running",
        question: "Measure token acceptance rate for 1B, 3B and 8B draft models against our 70B target on the support-chat eval set, and find the draft size that minimizes p50 latency at k = 4.",
        createdAt: "2026-10-11T16:40:00Z",
        answer: ["Acceptance so far (k = 4, 400 of 1,200 prompts): 1B 0.58, 3B 0.67. The 8B run is starting."],
        activity: [
          { kind: "read", label: "Read evals/support_chat/README.md", ms: 80, status: "ok" },
          { kind: "run", label: "Ran python bench/spec_decode.py --draft llama-3.2-1b --k 4", detail: "acceptance 0.58", ms: 640000, status: "ok" },
          { kind: "run", label: "Ran python bench/spec_decode.py --draft llama-3.2-3b --k 4", detail: "acceptance 0.67", ms: 910000, status: "ok" },
          { kind: "run", label: "Running python bench/spec_decode.py --draft llama-3.1-8b --k 4", ms: 0, status: "running" }
        ],
        sources: [{ url: "https://arxiv.org/abs/2211.17192", title: "Fast Inference from Transformers via Speculative Decoding", domain: "arxiv.org" }]
      })
    ]
  });

  data.threads.push({
    id: "t8", workspaceId: "ws-ml", folderId: null, kind: "exchange",
    title: "NCCL all-reduce hangs on mixed InfiniBand / RoCE nodes",
    provider: "claude", model: "opus", effort: "high", status: "queued",
    createdAt: "2026-10-11T17:26:00Z", updatedAt: "2026-10-11T17:26:00Z", lastViewedAt: null,
    unread: false, bookmarked: false, followed: false, archivedAt: null, recap: null,
    tags: ["nccl", "networking", "training"], links: ["t3"], rootTurnId: "t8q1",
    turns: [
      turn(C, {
        id: "t8q1", parentId: null, relation: "root", title: "NCCL hang on mixed fabric", status: "queued",
        question: "All-reduce hangs after about 20 minutes when a job spans the IB pod and the new RoCE nodes. `NCCL_DEBUG=INFO` logs are in `logs/nccl-2026-10-11/`. Find the cause.",
        createdAt: "2026-10-11T17:26:00Z"
      })
    ]
  });

  data.threads.push({
    id: "t9", workspaceId: "ws-reading", folderId: "f-links", kind: "post",
    title: "The Log: What every software engineer should know about real-time data's unifying abstraction",
    provider: "claude", model: "sonnet", effort: "medium", status: "done",
    createdAt: "2026-10-08T09:30:00Z", updatedAt: "2026-10-10T08:15:00Z", lastViewedAt: "2026-10-09T22:00:00Z",
    unread: true, bookmarked: false, followed: false, archivedAt: null,
    recap: "Saved link. Follow-up maps the log abstraction to Litestream's WAL shipping.",
    tags: ["logs", "streaming", "replication"], links: ["t4"], rootTurnId: "t9q1",
    turns: [
      turn({ provider: "claude", model: "sonnet", effort: "medium" }, {
        id: "t9q1", parentId: null, relation: "root", title: "Saved link", status: "done",
        question: "https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying",
        post: { format: "link", url: "https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying", linkTitle: "The Log: What every software engineer should know about real-time data's unifying abstraction", domain: "engineering.linkedin.com", author: "Jay Kreps" },
        createdAt: "2026-10-08T09:30:00Z", completedAt: "2026-10-08T09:30:00Z", durationSec: null
      }),
      turn({ provider: "claude", model: "sonnet", effort: "medium" }, {
        id: "t9q2", parentId: "t9q1", relation: "followup", title: "Map to Litestream", status: "done",
        question: "Summarize the argument and how it maps onto Litestream's WAL shipping.",
        createdAt: "2026-10-10T08:10:00Z", completedAt: "2026-10-10T08:15:00Z", durationSec: 300,
        answer: [
          "Kreps argues that an append-only, totally ordered log is the common abstraction behind database replication, data integration and stream processing: if every consumer applies the same log in the same order, every consumer reaches the same state.",
          "Litestream is a narrow case of this. The SQLite WAL is the log; Litestream ships WAL segments to object storage in order, and a restore replays a snapshot plus the segments after it. The lag in the Litestream thread is the distance between the primary's log head and the replica's last shipped position."
        ],
        sources: [{ url: "https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying", title: "The Log", domain: "engineering.linkedin.com" }]
      })
    ]
  });

  data.threads.push({
    id: "t10", workspaceId: "ws-reading", folderId: "f-papers", kind: "document", source: "imported",
    title: "CRDTs for collaborative text: RGA, YATA, Fugue",
    provider: "codex", model: "gpt-5.5", effort: "high", status: "done",
    createdAt: "2026-10-08T15:00:00Z", updatedAt: "2026-10-08T15:00:00Z", lastViewedAt: "2026-10-08T15:20:00Z",
    unread: false, bookmarked: true, followed: false, archivedAt: null,
    recap: "Imported report. Fugue minimizes interleaving of concurrent inserts; YATA (Yjs) and RGA can interleave.",
    tags: ["crdt", "collaborative-editing", "distributed-systems"], links: ["t5"], rootTurnId: "t10q1",
    turns: [
      turn({ provider: "codex", model: "gpt-5.5", effort: "high" }, {
        id: "t10q1", parentId: null, relation: "root", title: "Imported report", status: "done",
        question: "Survey sequence CRDTs used for collaborative text and compare their interleaving behaviour.",
        createdAt: "2026-10-08T15:00:00Z", completedAt: "2026-10-08T15:00:00Z", durationSec: null,
        answer: [
          "## Summary\nRGA (Roh et al., 2011) and YATA (Nicolaescu et al., 2016; the basis of Yjs) are both list CRDTs that give each inserted character a unique id and a reference to a neighbour. They converge, but concurrent insertions at the same position can interleave character by character.",
          "Kleppmann et al. (2019) described this interleaving anomaly. Fugue (Weidner and Kleppmann, 2023) orders concurrent inserts using both left and right origins, so text typed concurrently by two users stays in contiguous runs in the cases they identify as most common."
        ],
        sources: [
          { url: "https://arxiv.org/abs/2305.00583", title: "The Art of the Fugue: Minimizing Interleaving in Collaborative Text Editing", domain: "arxiv.org" },
          { url: "https://martin.kleppmann.com/papers/interleaving-papoc19.pdf", title: "Interleaving anomalies in collaborative text editors", domain: "martin.kleppmann.com" }
        ],
        highlights: [
          { id: "h10", paragraph: 1, quote: "orders concurrent inserts using both left and right origins", color: "green", note: "Compare with our OT server's tie-break.", createdAt: "2026-10-08T15:25:00Z" }
        ]
      })
    ]
  });

  data.threads.push({
    id: "t11", workspaceId: "ws-compilers", folderId: null, kind: "exchange",
    title: "regalloc2 spill weights for loop-carried values",
    provider: "codex", model: "gpt-5.4", effort: "medium", status: "done",
    createdAt: "2026-09-28T13:00:00Z", updatedAt: "2026-09-28T13:12:00Z", lastViewedAt: "2026-09-29T09:00:00Z",
    unread: false, bookmarked: false, followed: false, archivedAt: "2026-10-08T10:00:00Z",
    recap: "Uses inside loops are weighted by loop depth, so loop-carried values are rarely spilled inside the loop.",
    tags: ["regalloc", "cranelift"], links: ["t1"], rootTurnId: "t11q1",
    turns: [
      turn({ provider: "codex", model: "gpt-5.4", effort: "medium" }, {
        id: "t11q1", parentId: null, relation: "root", title: "Spill weights", status: "done",
        question: "How does regalloc2 decide which live range to spill when a loop-carried value competes with a temporary?",
        createdAt: "2026-09-28T13:00:00Z", completedAt: "2026-09-28T13:12:00Z", durationSec: 720,
        answer: [
          "regalloc2 assigns each live-range bundle a spill weight derived from its uses, with uses inside loops weighted more heavily by loop depth. When two bundles conflict, the one with the lower weight is evicted or split first.",
          "A loop-carried value has uses on every iteration, so its weight is usually higher than a short temporary's, and the allocator prefers to split the temporary."
        ],
        sources: [{ url: "https://github.com/bytecodealliance/regalloc2", title: "bytecodealliance/regalloc2", domain: "github.com" }],
        activity: [{ kind: "fetch", label: "Fetched github.com/bytecodealliance/regalloc2", ms: 2000, status: "ok" }]
      })
    ]
  });

  /* ---------- Notes, drafts, bookmarks, inbox ---------- */
  data.notes = [
    {
      id: "n1", workspaceId: "ws-compilers", title: "JIT correctness checklist", updatedAt: "2026-10-11T16:55:00Z", tags: ["jit", "checklist"],
      outline: [
        { text: "Byte-swapped loads", ref: { threadId: "t1" }, children: [
          { text: "Sign-extend after the swap, never before", ref: { threadId: "t1", turnId: "t1q1" } },
          { text: "x86-64 already correct: movzx, rol, movsx", ref: { threadId: "t1", turnId: "t1q2" } },
          { text: "Sweep test: offsets 0-14, both endiannesses", ref: { threadId: "t1", turnId: "t1q4" } }
        ] },
        { text: "Builtin argument coercion", children: [
          { text: "Coerce every argument before inspecting values (hypot; check max/min)", ref: { threadId: "t2", turnId: "t2q1" } },
          { text: "hypot overflow: scale by max |x|", ref: { threadId: "t2", turnId: "t2q2" } }
        ] },
        { text: "Typed-array NaN payloads are implementation-defined; don't test exact bits", ref: { threadId: "t6" } },
        { text: "Open: delete the ARMv7 byte-load fallback", ref: { threadId: "t1", turnId: "t1q3" } }
      ]
    },
    {
      id: "n2", workspaceId: "ws-ml", title: "Serving capacity plan, Q4", updatedAt: "2026-10-11T12:40:00Z", tags: ["capacity", "serving"],
      outline: [
        { text: "KV memory", children: [
          { text: "320 KiB per token for Llama-3-70B fp16", ref: { threadId: "t3", turnId: "t3q1" } },
          { text: "Watermark 0.08 -> 0.04; cap resident preempted blocks at 2%", ref: { threadId: "t3", turnId: "t3q1" } },
          { text: "Concurrency on 2xH100: pending", ref: { threadId: "t3", turnId: "t3q3" } }
        ] },
        { text: "Latency", children: [
          { text: "Speculative decoding draft size: results pending", ref: { threadId: "t7" } }
        ] },
        { text: "Blocker: NCCL hang on mixed fabric", ref: { threadId: "t8" } }
      ]
    },
    {
      id: "n3", workspaceId: "ws-ml", title: "Replication runbook notes", updatedAt: "2026-10-10T19:10:00Z", tags: ["sqlite", "runbook"],
      outline: [
        { text: "Import batches: 5,000 rows per transaction", ref: { threadId: "t4", turnId: "t4q1" } },
        { text: "Analytics reader holds snapshots for minutes; chunk it", ref: { threadId: "t4", turnId: "t4q3" } },
        { text: "Need s3:ListBucket for the research role", ref: { threadId: "t4", turnId: "t4q2" } },
        { text: "Background: the log as the unifying abstraction", ref: { threadId: "t9" } }
      ]
    },
    {
      id: "n4", workspaceId: "ws-reading", title: "Reading queue", updatedAt: "2026-10-11T11:35:00Z", tags: ["reading"],
      outline: [
        { text: "Consensus", children: [
          { text: "Raft membership changes: answer the clarification", ref: { threadId: "t5", turnId: "t5q1" } },
          { text: "2015 single-server bug walkthrough", ref: { threadId: "t5", turnId: "t5q2" } }
        ] },
        { text: "CRDT survey: read the Fugue paper in full", ref: { threadId: "t10" } },
        { text: "Kreps, The Log", ref: { threadId: "t9" } }
      ]
    }
  ];

  data.drafts = [
    { id: "d1", workspaceId: "ws-compilers", prompt: "Does the Int32 DataView path handle a read that crosses into a guard page when the buffer ends exactly at a page boundary?", provider: "claude", model: "opus", createdAt: "2026-10-11T16:58:00Z", updatedAt: "2026-10-11T16:58:00Z" },
    { id: "d2", workspaceId: "ws-ml", prompt: "Compare FP8 (e4m3) vs fp16 KV cache accuracy on our long-context retrieval eval.", provider: "codex", model: "gpt-5.6-sol", createdAt: "2026-10-10T18:20:00Z", updatedAt: "2026-10-11T09:02:00Z" },
    { id: "d3", workspaceId: "ws-reading", prompt: "Find the slides from Kreps's talk on the log and list what changed from the 2013 post.", provider: "grok", model: "grok-build", createdAt: "2026-10-09T22:05:00Z", updatedAt: "2026-10-09T22:05:00Z" }
  ];

  data.bookmarks = [
    { threadId: "t1", createdAt: "2026-10-10T14:25:00Z" },
    { threadId: "t3", createdAt: "2026-10-09T18:35:00Z" },
    { threadId: "t5", createdAt: "2026-10-10T20:45:00Z" },
    { threadId: "t10", createdAt: "2026-10-08T15:30:00Z" }
  ];

  data.inbox = [
    { id: "i1", kind: "unread", threadId: "t1", turnId: "t1q4", title: "Regression sweep test finished", detail: "300 cases pass with the fix; 60 fail on the parent commit.", createdAt: "2026-10-11T16:48:00Z" },
    { id: "i2", kind: "clarify", threadId: "t5", turnId: "t5q1", title: "Claude Code is asking a question", detail: "Does the metadata service ever replace several voters at once?", createdAt: "2026-10-10T20:18:00Z" },
    { id: "i3", kind: "failed", threadId: "t4", turnId: "t4q2", title: "Run failed: plot lag from S3", detail: "AccessDenied: s3:ListBucket on acme-litestream-prod.", createdAt: "2026-10-11T08:52:00Z" },
    { id: "i4", kind: "unread", threadId: "t9", turnId: "t9q2", title: "Follow-up answered: map to Litestream", detail: "Two paragraphs; links to the Litestream thread.", createdAt: "2026-10-10T08:15:00Z" },
    { id: "i5", kind: "running", threadId: "t2", turnId: "t2q3", title: "test262 built-ins/Math running", detail: "212 of 327 files, 12 min elapsed.", createdAt: "2026-10-11T17:18:00Z" },
    { id: "i6", kind: "queued", threadId: "t3", turnId: "t3q4", title: "Queued: repeat with FP8 KV cache", detail: "Starts when the running answer in this conversation finishes.", createdAt: "2026-10-11T17:06:00Z" }
  ];

  /* ---------- Derived indexes ---------- */
  var byId = { threads: {}, turns: {}, notes: {} };
  var highlights = [];
  var sourceMap = {};
  var sources = [];
  data.threads.forEach(function (th) {
    byId.threads[th.id] = th;
    th.turns.forEach(function (tu) {
      tu.threadId = th.id;
      byId.turns[tu.id] = tu;
      tu.highlights.forEach(function (h) {
        highlights.push(Object.assign({}, h, { threadId: th.id, turnId: tu.id, threadTitle: th.title, turnTitle: tu.title, workspaceId: th.workspaceId }));
      });
      tu.sources.forEach(function (s) {
        var entry = sourceMap[s.url];
        if (!entry) { entry = sourceMap[s.url] = Object.assign({}, s, { refs: [] }); sources.push(entry); }
        entry.refs.push({ threadId: th.id, turnId: tu.id });
      });
    });
  });
  data.notes.forEach(function (n) { byId.notes[n.id] = n; });
  highlights.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });

  var nodes = [];
  var edges = [];
  var seen = {};
  data.threads.forEach(function (th) {
    nodes.push({ id: th.id, type: "thread", label: th.title, workspaceId: th.workspaceId, tags: th.tags });
    th.links.forEach(function (to) {
      var key = [th.id, to].sort().join("|");
      if (!seen[key]) { seen[key] = true; edges.push({ from: th.id, to: to, type: "link" }); }
    });
  });
  data.notes.forEach(function (n) {
    nodes.push({ id: n.id, type: "note", label: n.title, workspaceId: n.workspaceId, tags: n.tags });
    var refs = {};
    (function walk(items) {
      items.forEach(function (it) {
        if (it.ref) refs[it.ref.threadId] = true;
        if (it.children) walk(it.children);
      });
    })(n.outline);
    Object.keys(refs).forEach(function (to) { edges.push({ from: n.id, to: to, type: "note-ref" }); });
  });

  data.highlights = highlights;
  data.sources = sources;
  data.graph = { nodes: nodes, edges: edges };
  data.byId = byId;
  return data;
})();
