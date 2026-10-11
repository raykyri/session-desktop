/*
 * Shell for the Session redesign compilation.
 *
 * Candidate files call window.SessionMocks.register(def) with:
 *   { id, round, name, reference, summary,
 *     principles: [string], chat: string, knowledge: string, firstRun: string,
 *     changes?: [string]            // round 2: what changed after self-review
 *     variants: [{ id, name, note }],  // 4-5 variants
 *     fonts?: "family=Foo:wght@400;600&family=Bar",  // Google Fonts css2 query
 *     css: string,                  // every selector prefixed with the scope class
 *     mount(root, ctx) -> optional cleanup function }
 * ctx = { variant, theme: "light" | "dark", data, scope, setVariant(id) }
 * The scope class is `m-${id}-r${round}` and is set on root, along with
 * data-variant and data-theme attributes.
 */
(function () {
  const SM = (window.SessionMocks = window.SessionMocks || {});
  SM.candidates = SM.candidates || [];
  SM.register = function (def) {
    if (!def || !def.id || !def.round) { console.error("register: missing id/round", def); return; }
    def.scope = `m-${def.id}-r${def.round}`;
    SM.candidates = SM.candidates.filter((c) => c.scope !== def.scope);
    SM.candidates.push(def);
    if (SM._started) SM._render();
  };

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem("sx." + k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem("sx." + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  const state = { view: "mock", id: null, round: 2, variant: null, theme: null, zoom: "fit", sev: "all", src: "all" };
  let cleanup = null;
  let mountedKey = null;
  const injectedCss = new Set();
  const injectedFonts = new Set();

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "html") n.innerHTML = v;
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  }

  function ids() {
    const order = SM.order || [];
    const seen = [...new Set(SM.candidates.map((c) => c.id))];
    return seen.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  }
  function get(id, round) { return SM.candidates.find((c) => c.id === id && c.round === round); }
  function rounds(id) { return SM.candidates.filter((c) => c.id === id).map((c) => c.round).sort(); }
  function current() { return get(state.id, state.round) || get(state.id, rounds(state.id).slice(-1)[0]); }

  function cloneData() {
    try { return structuredClone(SM.data); } catch { return SM.data; }
  }

  function effectiveTheme() {
    if (state.theme) return state.theme;
    return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function readHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (!h) return;
    if (h === "issues" || h === "overview") { state.view = h; return; }
    const [id, r, v] = h.split(".");
    if (id) { state.view = "mock"; state.id = id; }
    if (r && /^r\d$/.test(r)) state.round = Number(r.slice(1));
    if (v) state.variant = v;
  }
  function writeHash() {
    const h = state.view === "mock" ? `${state.id}.r${state.round}.${state.variant || ""}` : state.view;
    if (location.hash.slice(1) !== h) history.replaceState(null, "", "#" + h);
    store.set("state", { id: state.id, round: state.round, variant: state.variant, theme: state.theme, zoom: state.zoom, view: state.view });
  }

  function seg(items, value, onPick, label) {
    return el("div", { class: "sx-seg", role: "group", "aria-label": label },
      items.map((it) => el("button", {
        type: "button", "aria-pressed": String(it.value === value), disabled: it.disabled, title: it.title,
        onclick: () => onPick(it.value),
      }, it.label)));
  }

  function setTheme(t) {
    state.theme = t;
    if (t) document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
  }

  function renderTop() {
    const top = document.getElementById("sx-top");
    top.replaceChildren(
      el("div", { class: "sx-brand" }, el("h1", null, "Session Redesigns"), el("span", null, `${ids().length} candidates · ${SM.candidates.length} mocks`)),
      el("div", { class: "sx-spacer" }),
      el("div", { class: "sx-ctl" }, el("span", { class: "sx-label" }, "Theme"),
        seg([{ value: null, label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }], state.theme,
          (v) => { setTheme(v); remount(true); render(); }, "Theme")),
    );
  }

  function renderRail() {
    const rail = document.getElementById("sx-rail");
    const items = [
      el("h2", { class: "sx-label" }, "Compilation"),
      el("button", { class: "sx-rail-item", type: "button", "aria-current": String(state.view === "overview"), onclick: () => go({ view: "overview" }) },
        el("b", null, "Overview"), el("span"), el("small", null, "All candidates side by side")),
      el("button", { class: "sx-rail-item", type: "button", "aria-current": String(state.view === "issues"), onclick: () => go({ view: "issues" }) },
        el("b", null, "Review issues"), el("span", { class: "sx-count" }, String(issueList().length)), el("small", null, "Current app, prioritized")),
      el("h2", { class: "sx-label" }, "Candidates"),
    ];
    for (const id of ids()) {
      const c = get(id, rounds(id).slice(-1)[0]);
      const rs = rounds(id);
      items.push(el("button", {
        class: "sx-rail-item", type: "button", "aria-current": String(state.view === "mock" && state.id === id),
        onclick: () => go({ view: "mock", id, round: rs.includes(state.round) ? state.round : rs.slice(-1)[0], variant: null }),
      }, el("b", null, c.name), el("span", { class: "sx-rounds" }, [1, 2].map((r) => el("span", { class: "sx-pill" + (rs.includes(r) ? " on" : "") }, "R" + r))),
      el("small", null, "After " + c.reference)));
    }
    rail.replaceChildren(...items);
  }

  function go(patch) {
    Object.assign(state, patch);
    render();
  }

  function fitFrame() {
    const wrap = document.querySelector(".sx-frame-wrap");
    const scaler = document.querySelector(".sx-scaler");
    if (!wrap || !scaler) return;
    const pad = parseFloat(getComputedStyle(wrap).paddingLeft) * 2;
    const avail = wrap.clientWidth - pad;
    const s = state.zoom === "fit" ? Math.min(1, avail / 1280) : 1;
    scaler.style.transform = `scale(${s})`;
    scaler.style.width = 1280 + "px";
    scaler.style.height = 800 * s + "px";
  }

  function remount(force) {
    const c = current();
    const root = document.querySelector(".sx-window > .mock-root");
    if (!c || !root) return;
    const theme = effectiveTheme();
    const key = `${c.scope}|${state.variant}|${theme}`;
    if (!force && key === mountedKey) return;
    if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
    root.replaceChildren();
    root.className = `mock-root ${c.scope}`;
    root.setAttribute("data-variant", state.variant);
    root.setAttribute("data-theme", theme);
    if (c.css && !injectedCss.has(c.scope)) {
      document.head.append(el("style", { "data-scope": c.scope }, c.css));
      injectedCss.add(c.scope);
    }
    if (c.fonts && !injectedFonts.has(c.fonts)) {
      document.head.append(el("link", { rel: "stylesheet", href: `https://fonts.googleapis.com/css2?${c.fonts}&display=swap` }));
      injectedFonts.add(c.fonts);
    }
    try {
      const r = c.mount(root, {
        variant: state.variant, theme, data: cloneData(), scope: c.scope,
        setVariant: (v) => { state.variant = v; render(); },
      });
      cleanup = typeof r === "function" ? r : r && r.unmount ? () => r.unmount() : null;
    } catch (e) {
      console.error(e);
      root.replaceChildren(el("div", { class: "sx-error" }, `${c.scope} failed to mount:\n${e && e.stack || e}`));
    }
    mountedKey = key;
  }

  function renderMock(stage) {
    const c = current();
    if (!c) { stage.replaceChildren(el("p", null, "No candidates registered yet.")); return; }
    state.round = c.round;
    if (!c.variants.some((v) => v.id === state.variant)) state.variant = c.variants[0].id;
    const v = c.variants.find((x) => x.id === state.variant);
    const rs = rounds(c.id);

    const head = el("div", { class: "sx-head" },
      el("div", { class: "sx-head-title" },
        el("span", { class: "sx-label" }, `After ${c.reference} · Round ${c.round}`),
        el("h2", null, c.name),
        el("p", null, c.summary)),
      el("div", { class: "sx-controls" },
        el("div", { class: "sx-ctl" }, el("span", { class: "sx-label" }, "Round"),
          seg([1, 2].map((r) => ({ value: r, label: "R" + r, disabled: !rs.includes(r), title: rs.includes(r) ? "" : "Not produced yet" })), c.round,
            (r) => go({ round: r, variant: null }), "Round")),
        el("div", { class: "sx-ctl" }, el("span", { class: "sx-label" }, "Zoom"),
          seg([{ value: "fit", label: "Fit" }, { value: "100", label: "100%" }], state.zoom, (z) => { state.zoom = z; render(); }, "Zoom"))));

    const variantBar = el("div", { class: "sx-ctl", style: "flex-wrap:wrap" }, el("span", { class: "sx-label" }, "Variant"),
      seg(c.variants.map((x, i) => ({ value: x.id, label: `${String.fromCharCode(65 + i)} · ${x.name}` })), state.variant, (id) => go({ variant: id }), "Variant"),
      el("span", { class: "sx-hint" }, el("span", { class: "sx-kbd" }, "←"), " ", el("span", { class: "sx-kbd" }, "→"), " variants  ", el("span", { class: "sx-kbd" }, "["), " ", el("span", { class: "sx-kbd" }, "]"), " candidates"));
    const note = el("div", { class: "sx-variant-note" }, el("b", null, v.name + ". "), v.note || "");

    const existing = stage.querySelector(".sx-window > .mock-root");
    const frame = el("div", { class: "sx-frame-wrap" + (state.zoom === "100" ? " zoom-100" : "") },
      el("div", { class: "sx-scaler" }, el("div", { class: "sx-window" }, existing || el("div", { class: "mock-root" }))));

    const notes = el("div", { class: "sx-notes" },
      c.changes && c.changes.length ? el("section", { class: "sx-note" }, el("h3", null, "Changed in round " + c.round), el("ul", null, c.changes.map((x) => el("li", null, x)))) : null,
      el("section", { class: "sx-note" }, el("h3", null, "Principles"), el("ul", null, (c.principles || []).map((x) => el("li", null, x)))),
      el("section", { class: "sx-note" }, el("h3", null, "Chat with models"), el("p", null, c.chat || "")),
      el("section", { class: "sx-note" }, el("h3", null, "Outline and knowledge"), el("p", null, c.knowledge || "")),
      el("section", { class: "sx-note" }, el("h3", null, "First run"), el("p", null, c.firstRun || "")),
      el("section", { class: "sx-note" }, el("h3", null, "Variants"), el("ul", { class: "sx-vlist" }, c.variants.map((x, i) => el("li", null, el("span", null, String.fromCharCode(65 + i)), el("span", null, el("b", null, x.name + ". "), x.note || ""))))),
    );
    stage.replaceChildren(head, variantBar, note, frame, notes);
    fitFrame();
    remount(false);
  }

  function issueList() {
    const I = SM.issues || {};
    return [...(I.ux || []).map((x) => ({ ...x, src: "UX" })), ...(I.eng || []).map((x) => ({ ...x, src: "Engineering" }))];
  }

  function renderIssues(stage) {
    const all = issueList();
    const sevs = ["P0", "P1", "P2", "P3"];
    const list = all.filter((x) => (state.sev === "all" || x.severity === state.sev) && (state.src === "all" || x.src === state.src))
      .sort((a, b) => sevs.indexOf(a.severity) - sevs.indexOf(b.severity));
    const count = (s) => all.filter((x) => x.severity === s && (state.src === "all" || x.src === state.src)).length;
    const head = el("div", { class: "sx-head" }, el("div", { class: "sx-head-title" },
      el("span", { class: "sx-label" }, "Review of the current app"),
      el("h2", null, "Issues"),
      el("p", null, SM.issuesIntro || "Product and engineering findings from reading the current source, ranked by severity. P0 blocks or seriously confuses first use.")));
    const filters = el("div", { class: "sx-issues-filters" },
      el("div", { class: "sx-ctl" }, el("span", { class: "sx-label" }, "Severity"),
        seg([{ value: "all", label: "All" }, ...sevs.map((s) => ({ value: s, label: `${s} · ${count(s)}` }))], state.sev, (s) => go({ sev: s }), "Severity")),
      el("div", { class: "sx-ctl" }, el("span", { class: "sx-label" }, "Source"),
        seg(["all", "UX", "Engineering"].map((s) => ({ value: s, label: s === "all" ? "All" : s })), state.src, (s) => go({ src: s }), "Source")));
    const items = list.map((x) => el("article", { class: "sx-issue" },
      el("span", { class: "sx-sev " + x.severity }, x.severity),
      el("div", null, el("h4", null, x.title), el("div", { class: "sx-meta" }, `${x.src} · ${x.area || x.category || ""} · ${x.id}`)),
      el("details", null, el("summary", null, "Evidence and recommendation"),
        el("dl", null,
          el("dt", null, x.src === "UX" ? "Impact" : "Scenario"), el("dd", null, x.impact || x.scenario || ""),
          el("dt", null, "Evidence"), el("dd", null, (x.evidence || []).map((e) => el("div", null, el("code", null, `${e.file}${e.line ? ":" + e.line : ""}`), " ", e.note || ""))),
          el("dt", null, "Recommendation"), el("dd", null, x.recommendation || "")))));
    stage.replaceChildren(head, filters, el("div", { class: "sx-issues" }, items.length ? items : el("p", null, "No issues loaded.")));
  }

  function renderOverview(stage) {
    const head = el("div", { class: "sx-head" }, el("div", { class: "sx-head-title" },
      el("span", { class: "sx-label" }, "Compilation"),
      el("h2", null, "Redesign candidates"),
      el("p", null, SM.intro || "Each candidate redesigns Session after one reference application. Every candidate offers several variants. Round 2 is each candidate's revision after a self-review of round 1; each round 2 lists what changed. Use the R1 / R2 switch to compare.")));
    const cards = ids().map((id) => {
      const rs = rounds(id);
      const c = get(id, rs.slice(-1)[0]);
      return el("button", { class: "sx-card", type: "button", onclick: () => go({ view: "mock", id, round: rs.slice(-1)[0], variant: null }) },
        el("small", null, `After ${c.reference} · ${rs.map((r) => "R" + r).join(" ")} · ${c.variants.length} variants`),
        el("b", null, c.name), el("p", null, c.summary));
    });
    stage.replaceChildren(head, el("div", { class: "sx-overview" }, cards));
  }

  function render() {
    if (state.view === "mock" && !state.id) state.id = ids()[0];
    renderTop();
    renderRail();
    const stage = document.getElementById("sx-stage");
    if (state.view !== "mock") {
      if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
      mountedKey = null;
      stage.replaceChildren();
      state.view === "issues" ? renderIssues(stage) : renderOverview(stage);
    } else {
      if (mountedKey && !mountedKey.startsWith(current()?.scope + "|")) {
        const root = stage.querySelector(".sx-window > .mock-root");
        if (root && cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
      }
      renderMock(stage);
    }
    writeHash();
  }
  SM._render = render;

  function cycle(arr, cur, d) { const i = arr.indexOf(cur); return arr[(i + d + arr.length) % arr.length]; }

  SM.start = function () {
    const saved = store.get("state");
    if (saved) Object.assign(state, saved);
    readHash();
    setTheme(state.theme);
    SM._started = true;
    render();
    window.addEventListener("resize", fitFrame);
    window.addEventListener("hashchange", () => { readHash(); render(); });
    if (window.matchMedia) matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if (!state.theme) { remount(true); render(); } });
    document.addEventListener("keydown", (e) => {
      if (state.view !== "mock" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (t && t.closest && t.closest(".sx-window")) return;
      const c = current();
      if (!c) return;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); go({ variant: cycle(c.variants.map((v) => v.id), state.variant, e.key === "ArrowRight" ? 1 : -1) }); }
      if (e.key === "]" || e.key === "[") { e.preventDefault(); const id = cycle(ids(), state.id, e.key === "]" ? 1 : -1); const rs = rounds(id); go({ id, round: rs.includes(state.round) ? state.round : rs.slice(-1)[0], variant: null }); }
    });
  };
})();
