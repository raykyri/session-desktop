/*
 * Session redesign candidate "ulysses", round 1.
 * Reference: Ulysses (Mac). Library -> sheet list -> editor, with an attachments pane.
 * A research thread is a sheet: each question is a heading, each answer is prose under it.
 * Plain browser JS, no dependencies. Registers with window.SessionMocks.
 */
(function () {
  "use strict";
  var SCOPE = "m-ulysses-r1";

  /* ------------------------------------------------------------------ icons */
  var ICONS = {
    sidebar: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6 3v10"/>',
    list: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5 6h6M5 8.5h6M5 11h4"/>',
    search: '<circle cx="7" cy="7" r="4.25"/><path d="m10.25 10.25 3.25 3.25"/>',
    outline: '<path d="M3 4h10M5.5 8h7.5M8 12h5"/><circle cx="3" cy="8" r=".6" fill="currentColor"/><circle cx="5.5" cy="12" r=".6" fill="currentColor"/>',
    clip: '<path d="M10.5 5 6.2 9.3a1.3 1.3 0 0 0 1.85 1.85l4.6-4.6a2.6 2.6 0 0 0-3.7-3.7L4.3 7.5a3.9 3.9 0 0 0 5.5 5.5l3.2-3.2"/>',
    share: '<path d="M8 2.5v8M5.2 5.2 8 2.5l2.8 2.7M5 7.5H3.5v6h9v-6H11"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    compose: '<path d="M11.2 2.6 13.4 4.8 7.6 10.6H5.4V8.4z"/><path d="M8 3.5H3.5v9h9V8"/>',
    funnel: '<path d="M2.5 3.5h11L9 8.6v4.2l-2-1V8.6z"/>',
    inbox: '<path d="M2.5 9.5 4.2 3.5h7.6l1.7 6v3h-11z"/><path d="M2.5 9.5H6l.8 1.5h2.4l.8-1.5h3.5"/>',
    star: '<path d="m8 2.4 1.7 3.6 3.9.5-2.9 2.7.8 3.9L8 11.2l-3.5 1.9.8-3.9-2.9-2.7 3.9-.5z"/>',
    clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2.2 1.4"/>',
    stack: '<path d="M8 2.5 13.5 5 8 7.5 2.5 5z"/><path d="m2.5 8 5.5 2.5L13.5 8M2.5 11l5.5 2.5 5.5-2.5"/>',
    group: '<path d="M4.5 2.5h7a1 1 0 0 1 1 1v7.5h-9V3.5a1 1 0 0 1 1-1z"/><path d="M2.5 5v8.5h8"/>',
    pen: '<path d="m10.6 2.8 2.6 2.6-7.4 7.4-3.3.7.7-3.3z"/><path d="m9.3 4.1 2.6 2.6"/>',
    archive: '<rect x="2.5" y="3" width="11" height="3" rx=".8"/><path d="M3.5 6v6.5h9V6M6.5 8.5h3"/>',
    book: '<path d="M2.5 3.5h4A1.5 1.5 0 0 1 8 5v8.5a1.2 1.2 0 0 0-1.2-1.2H2.5zM13.5 3.5h-4A1.5 1.5 0 0 0 8 5v8.5a1.2 1.2 0 0 1 1.2-1.2h4.3z"/>',
    note: '<path d="M6 4.5h7.5M6 8h7.5M6 11.5h5"/><circle cx="3.2" cy="4.5" r=".9" fill="currentColor" stroke="none"/><circle cx="3.2" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="3.2" cy="11.5" r=".9" fill="currentColor" stroke="none"/>',
    doc: '<path d="M4 2.5h5.5L12.5 5.5v8h-8.5z"/><path d="M9.5 2.5v3h3M6 8.5h4.5M6 11h3"/>',
    link: '<path d="M6.8 9.2a2.5 2.5 0 0 0 3.5 0l2.2-2.2a2.5 2.5 0 0 0-3.5-3.5l-.7.7"/><path d="M9.2 6.8a2.5 2.5 0 0 0-3.5 0L3.5 9a2.5 2.5 0 0 0 3.5 3.5l.7-.7"/>',
    chevR: '<path d="m6.5 4.5 3.5 3.5-3.5 3.5"/>',
    chevD: '<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>',
    gear: '<circle cx="8" cy="8" r="2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6 5 5M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4"/>',
    alert: '<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.2v.1"/>',
    question: '<circle cx="8" cy="8" r="5.5"/><path d="M6.4 6.4a1.7 1.7 0 1 1 2.2 1.6c-.4.2-.6.5-.6 1v.4M8 11.2v.1"/>',
    branch: '<circle cx="4.5" cy="3.8" r="1.3"/><circle cx="4.5" cy="12.2" r="1.3"/><circle cx="11.5" cy="5.5" r="1.3"/><path d="M4.5 5.1v5.8M11.5 6.8c0 2.8-7 2-7 4.1"/>',
    mark: '<path d="m9.5 3.5 3 3-5.5 5.5H4v-3z"/><path d="M2.5 14h11"/>',
    copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5A1 1 0 0 0 9.5 2.5h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
    x: '<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>',
    check: '<path d="m3.5 8.5 3 3 6-7"/>',
    stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.2"/>',
    retry: '<path d="M12.8 8a4.8 4.8 0 1 1-1.4-3.4"/><path d="M12 2.8v2.6H9.4"/>',
    type: '<path d="M3.5 4.5V3h9v1.5M8 3v10M6 13h4"/>',
    glue: '<rect x="3" y="2.5" width="10" height="4.5" rx="1"/><rect x="3" y="9" width="10" height="4.5" rx="1"/><path d="M6 7v2M10 7v2"/>',
    drive: '<rect x="2.5" y="4" width="11" height="8" rx="1.5"/><path d="M2.5 9.5h11"/><circle cx="11" cy="10.9" r=".5" fill="currentColor"/>',
    send: '<path d="M8 13V3.5M4 7.5l4-4 4 4"/>',
    more: '<circle cx="4" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="12" cy="8" r=".9" fill="currentColor" stroke="none"/>',
    sort: '<path d="M4.5 3v10M2.5 11l2 2 2-2M8.5 4.5h5M8.5 8h4M8.5 11.5h3"/>',
    think: '<path d="M8 2.5a4 4 0 0 0-2.5 7.1V11h5V9.6A4 4 0 0 0 8 2.5zM6 13h4"/>',
    read: '<path d="M4 2.5h5.5L12.5 5.5v8h-8.5z"/><path d="M9.5 2.5v3h3"/>',
    grep: '<circle cx="6.5" cy="6.5" r="3.5"/><path d="m9 9 4 4"/>',
    web: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.6 1.5 2.4 3.4 2.4 5.5S9.6 12 8 13.5C6.4 12 5.6 10.1 5.6 8S6.4 4 8 2.5z"/>',
    run: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="m5 6.5 2 1.5-2 1.5M8.5 10H11"/>',
    edit: '<path d="m10.6 2.8 2.6 2.6-7.4 7.4-3.3.7.7-3.3z"/>',
    activity: '<path d="M2 8.5h2.5l1.8-4 3 8 1.8-4H14"/>',
    folder: '<path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.3 1.5h4.7a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>'
  };
  var STEP_ICON = { think: "think", read: "read", grep: "grep", search: "web", fetch: "web", run: "run", edit: "edit" };

  /* -------------------------------------------------------------------- css */
  var CSS = String.raw`
$S {
  --ui: -apple-system, BlinkMacSystemFont, "Inter", "Helvetica Neue", Arial, sans-serif;
  --serif: "Source Serif 4", "Iowan Old Style", Charter, Georgia, serif;
  --mono: "IBM Plex Mono", "SF Mono", Menlo, "DejaVu Sans Mono", monospace;
  --lib: #ecebe8; --list: #f8f7f5; --ed: #ffffff; --att: #f4f3f0; --pop: #ffffff; --card: #ffffff;
  --ink: #2b2926; --ink2: #5d5954; --ink3: #827d77; --ph: #77726c; --mk: #bdb7af;
  --line: #dfdcd7; --line2: #ebe9e5; --hover: rgba(0,0,0,.05); --sellib: rgba(0,0,0,.085);
  --sellist: #f7ecc8; --sellist-line: #e9d692;
  --acc: #e0a100; --acc-ink: #8c6400; --acc-soft: #fbf0cf;
  --chip: #ebe9e4; --chip-ink: #57534d; --comment: #f3f1ed; --codebg: #f6f4f0; --code-ink: #9a3f5c;
  --blue: #2f6fd6; --blue-line: #9dbbec; --blue-soft: rgba(47,111,214,.09); --menu: #2f6fd6;
  --red: #c4433a; --red-soft: #fbeeec; --red-line: #efc6c2;
  --green: #3c8a4f; --amber-soft: #fdf5dd; --amber-line: #efd88e;
  --hl-amber: rgba(246,196,48,.42); --hl-green: rgba(108,190,110,.34); --hl-blue: rgba(96,150,236,.26); --hl-pink: rgba(232,104,160,.26);
  --shadow: 0 12px 40px rgba(0,0,0,.18), 0 0 0 .5px rgba(0,0,0,.14);
  --c-claude: #d08a5c; --c-codex: #4f9c74; --c-grok: #6b6f78;
  position: absolute; inset: 0; display: flex; overflow: hidden;
  font-family: var(--ui); font-size: 13px; line-height: 1.4; color: var(--ink); background: var(--ed);
  -webkit-font-smoothing: antialiased;
}
$S[data-theme="dark"] {
  --lib: #262524; --list: #1f1e1d; --ed: #1a1a19; --att: #212020; --pop: #2c2b2a; --card: #262524;
  --ink: #e6e3de; --ink2: #b4afa8; --ink3: #8b867f; --ph: #8f8a83; --mk: #5d5953;
  --line: #353331; --line2: #2b2a28; --hover: rgba(255,255,255,.06); --sellib: rgba(255,255,255,.09);
  --sellist: rgba(240,190,60,.13); --sellist-line: rgba(240,190,60,.32);
  --acc: #f0bd3c; --acc-ink: #f2c95e; --acc-soft: rgba(240,189,60,.14);
  --chip: #33312f; --chip-ink: #c4bfb8; --comment: #242322; --codebg: #222120; --code-ink: #e594ae;
  --blue: #7aa7f0; --blue-line: #3f5f93; --blue-soft: rgba(122,167,240,.12); --menu: #3b74d6;
  --red: #ec8a80; --red-soft: rgba(236,138,128,.1); --red-line: rgba(236,138,128,.32);
  --green: #84c693; --amber-soft: rgba(240,189,60,.1); --amber-line: rgba(240,189,60,.35);
  --hl-amber: rgba(240,189,60,.3); --hl-green: rgba(120,200,120,.24); --hl-blue: rgba(110,160,240,.26); --hl-pink: rgba(232,104,160,.26);
  --shadow: 0 14px 44px rgba(0,0,0,.55), 0 0 0 .5px rgba(255,255,255,.12);
}
$S button { font: inherit; color: inherit; background: none; border: 0; padding: 0; margin: 0; cursor: default; text-align: inherit; }
$S button:focus-visible, $S [tabindex]:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
$S .ic { display: inline-grid; place-items: center; width: 16px; height: 16px; flex: none; }
$S .ic svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.35; stroke-linecap: round; stroke-linejoin: round; }
$S .ic.sm, $S .ic.sm svg { width: 13px; height: 13px; }

/* panes */
$S .pane { height: 100%; display: flex; flex-direction: column; min-width: 0; position: relative; }
$S .lib { width: 224px; flex: none; background: var(--lib); border-right: 1px solid var(--line); }
$S .list { width: 300px; flex: none; background: var(--list); border-right: 1px solid var(--line); }
$S .ed { flex: 1; background: var(--ed); }
$S .att { width: 300px; flex: none; background: var(--att); border-left: 1px solid var(--line); }
$S .tb { height: 52px; flex: none; display: flex; align-items: center; gap: 4px; padding: 0 12px; }
$S .lights { display: flex; gap: 8px; padding: 0 14px 0 6px; flex: none; }
$S .lights i { width: 12px; height: 12px; border-radius: 50%; box-shadow: inset 0 0 0 .5px rgba(0,0,0,.18); }
$S .lights i:nth-child(1) { background: #ff5f57; } $S .lights i:nth-child(2) { background: #febc2e; } $S .lights i:nth-child(3) { background: #28c840; }
$S .tbtn { width: 30px; height: 26px; border-radius: 6px; display: inline-grid; place-items: center; color: var(--ink2); flex: none; }
$S .tbtn:hover { background: var(--hover); }
$S .tbtn.on { color: var(--acc-ink); background: var(--acc-soft); }
$S .tsep { width: 1px; height: 16px; background: var(--line); margin: 0 4px; }
$S .grow { flex: 1; }

/* library */
$S .lib-scroll { flex: 1; overflow: auto; padding: 0 10px 12px; }
$S .lrow { display: flex; align-items: center; gap: 8px; width: 100%; height: 26px; padding: 0 8px; border-radius: 6px; font-size: 13px; color: var(--ink); white-space: nowrap; }
$S .lrow > .ic { color: var(--ink3); }
$S .lrow:hover { background: var(--hover); }
$S .lrow.on { background: var(--sellib); }
$S .lrow.on > .ic { color: var(--acc-ink); }
$S .lrow .lbl { overflow: hidden; text-overflow: ellipsis; }
$S .lrow .ct { margin-left: auto; color: var(--ink3); font-size: 11.5px; font-variant-numeric: tabular-nums; }
$S .lrow .badge { margin-left: auto; font-size: 11px; font-weight: 600; color: #5a4300; background: var(--acc); border-radius: 8px; padding: 0 6px; line-height: 16px; }
$S[data-theme="dark"] .lrow .badge { color: #2a2000; }
$S .lrow.sub { padding-left: 22px; }
$S .lsec { display: flex; align-items: center; gap: 4px; width: 100%; padding: 14px 8px 4px; font-size: 11.5px; font-weight: 600; color: var(--ink3); }
$S .lsec .tw { width: 12px; height: 12px; opacity: 0; } $S .lsec:hover .tw { opacity: 1; }
$S .lsec .tw svg { width: 12px; height: 12px; }
$S .lsec .dir { margin-left: auto; font-weight: 400; font-family: var(--mono); font-size: 10px; opacity: 0; }
$S .lsec:hover .dir { opacity: 1; }
$S .lsec.on { color: var(--ink); }
$S .lhint { font-size: 12px; color: var(--ink3); padding: 3px 8px 3px 30px; }
$S .lfoot { height: 40px; flex: none; display: flex; align-items: center; gap: 2px; padding: 0 8px; border-top: 1px solid var(--line); }
$S .agents { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink2); padding: 3px 8px; border-radius: 6px; margin-left: auto; }
$S .agents:hover { background: var(--hover); }
$S .agents i { width: 7px; height: 7px; border-radius: 50%; background: var(--green); }
$S .agents.warn i { background: var(--acc); }

/* sheet list */
$S .lhead { display: flex; flex-direction: column; min-width: 0; flex: 1; }
$S .lhead b { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
$S .lhead span { font-size: 11px; color: var(--ink3); }
$S .query { margin: 0 12px 8px; padding: 6px 9px; border-radius: 7px; background: var(--chip); color: var(--chip-ink); font-size: 11.5px; line-height: 1.4; display: flex; gap: 6px; align-items: flex-start; }
$S .query .ic { margin-top: 1px; }
$S .rows { flex: 1; overflow: auto; position: relative; border-top: 1px solid var(--line2); }
$S .row { position: relative; padding: 12px 16px 12px 22px; border-bottom: 1px solid var(--line2); cursor: default; }
$S .row:hover { background: var(--hover); }
$S .row.on { background: var(--sellist); border-bottom-color: var(--sellist-line); }
$S .row .t { display: flex; align-items: flex-start; gap: 6px; font-weight: 600; font-size: 13.5px; line-height: 1.3; }
$S .row .t .tt { flex: 1; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
$S .row .t .ic { color: var(--ink3); margin-top: 1px; }
$S .row .x { color: var(--ink2); font-size: 12.5px; line-height: 1.42; margin-top: 3px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
$S .row .m { display: flex; align-items: center; gap: 5px; margin-top: 7px; font-size: 11px; color: var(--ink3); flex-wrap: nowrap; overflow: hidden; }
$S .row .m .d { flex: none; margin-right: 3px; }
$S .row .ud { position: absolute; left: 8px; top: 16px; width: 7px; height: 7px; border-radius: 50%; background: var(--blue); }
$S .row .gl { position: absolute; left: 0; top: 0; bottom: -1px; width: 3px; background: var(--acc); }
$S .row .draftlbl { color: var(--acc-ink); font-weight: 600; font-size: 11px; margin-right: 4px; }
$S .kw { display: inline-block; padding: 0 7px; border-radius: 9px; background: var(--chip); color: var(--chip-ink); font-size: 10.5px; line-height: 17px; white-space: nowrap; }
$S button.kw:hover { background: var(--acc-soft); color: var(--acc-ink); }
$S .lfootbar { flex: none; border-top: 1px solid var(--line); padding: 8px 12px; font-size: 11.5px; color: var(--ink2); display: flex; align-items: center; gap: 8px; }
$S .empty { padding: 48px 28px; text-align: center; color: var(--ink2); font-size: 12.5px; line-height: 1.5; }
$S .empty b { display: block; color: var(--ink); font-size: 14px; margin-bottom: 6px; }
$S .btn { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 6px; font-size: 12.5px; border: 1px solid var(--line); background: var(--card); color: var(--ink); white-space: nowrap; }
$S .btn:hover { background: var(--hover); }
$S .btn.pri { background: var(--acc); border-color: transparent; color: #3b2b00; font-weight: 600; }
$S .btn.sm { height: 22px; padding: 0 8px; font-size: 11.5px; }
$S .hlrow .q { font-family: var(--serif); font-size: 14px; line-height: 1.45; }
$S .hlrow .q span { padding: 0 1px; border-radius: 2px; }
$S .hlrow .n { font-size: 12px; color: var(--ink2); margin-top: 5px; font-style: italic; }

/* status */
$S .pill { display: inline-flex; align-items: center; gap: 5px; font-family: var(--ui); font-size: 11px; font-weight: 600; padding: 0 7px; line-height: 18px; border-radius: 9px; white-space: nowrap; }
$S .pill.run { color: var(--acc-ink); background: var(--acc-soft); }
$S .pill.plain { color: var(--ink2); background: var(--chip); }
$S .pill.error { color: var(--red); background: var(--red-soft); }
$S .pill.attention { color: var(--acc-ink); background: var(--amber-soft); box-shadow: inset 0 0 0 1px var(--amber-line); }
$S .pill.ok { color: var(--green); background: transparent; padding: 0; }
$S .spin { width: 10px; height: 10px; border-radius: 50%; border: 1.6px solid currentColor; border-right-color: transparent; animation: ulr1-spin .9s linear infinite; flex: none; }
$S .sglyph { flex: none; margin-top: 2px; }
$S .sglyph.run { color: var(--acc-ink); } $S .sglyph.error { color: var(--red); } $S .sglyph.attention { color: var(--acc-ink); } $S .sglyph.plain { color: var(--ink3); }
@keyframes ulr1-spin { to { transform: rotate(360deg); } }
@keyframes ulr1-blink { 50% { opacity: 0; } }
@keyframes ulr1-flash { 0% { box-shadow: 0 0 0 6px var(--acc-soft); } 100% { box-shadow: 0 0 0 0 transparent; } }

/* editor */
$S .ed .tb { gap: 2px; }
$S .loc { font-size: 12px; color: var(--ink3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 10px; }
$S .ed-scroll { flex: 1; overflow: auto; position: relative; }
$S .doc { max-width: 720px; margin: 0 auto; padding: 18px 76px 220px; font-family: var(--serif); font-size: 16.5px; line-height: 1.62; color: var(--ink); }
$S .hang { position: absolute; right: 100%; margin-right: 12px; top: .28em; color: var(--mk); font-family: var(--mono); font-weight: 400; font-size: 12.5px; line-height: 1.3; white-space: nowrap; letter-spacing: -.02em; }
$S .h1 { position: relative; font-size: 28px; line-height: 1.24; font-weight: 600; margin: 10px 0 8px; letter-spacing: -.008em; }
$S .h1 .hang { top: .5em; }
$S .h1.ph { color: var(--ph); font-weight: 400; }
$S .sub { font-family: var(--ui); font-size: 12px; color: var(--ink3); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 0 0 22px; line-height: 18px; }
$S .sub .sep { color: var(--mk); }
$S .comment { position: relative; font-family: var(--ui); font-size: 13px; line-height: 1.5; color: var(--ink2); background: var(--comment); border-radius: 8px; padding: 9px 12px 10px; margin: 0 0 28px; }
$S .comment .lab { display: block; font-size: 11px; font-weight: 600; color: var(--ink3); margin-bottom: 2px; }
$S .comment .hang { top: 10px; font-size: 12px; }
$S .sec { position: relative; margin: 0 0 30px; border-radius: 4px; }
$S .sec.flash { animation: ulr1-flash 1.2s ease-out; }
$S .hrow { position: relative; cursor: default; }
$S .q { font-weight: 600; font-size: 18.5px; line-height: 1.38; margin: 0 0 5px; padding-right: 76px; }
$S .q.l3 { font-size: 17.5px; } $S .q .cd { font-weight: 500; } $S .q.l4, $S .q.l5 { font-size: 16.5px; }
$S .sec.sel > .hrow .hang { color: var(--acc); }
$S .sec.sel > .hrow::before { content: ""; position: absolute; left: -58px; top: 4px; bottom: 4px; width: 3px; border-radius: 2px; background: var(--acc); }
$S .hacts { position: absolute; right: 0; top: 2px; display: flex; gap: 0; opacity: 0; transition: opacity .12s; }
$S .hrow:hover .hacts, $S .sec.sel > .hrow .hacts { opacity: 1; }
$S .hacts .tbtn { width: 24px; height: 24px; color: var(--ink3); }
$S .hacts .tbtn.on { color: var(--acc-ink); background: none; }
$S .meta { font-family: var(--ui); font-size: 11.5px; color: var(--ink3); margin: 0 0 12px; display: flex; gap: 7px; flex-wrap: wrap; align-items: center; line-height: 18px; }
$S .meta .ag { display: inline-flex; align-items: center; gap: 5px; color: var(--ink2); }
$S .agdot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: none; }
$S .meta .sep { color: var(--mk); }
$S .meta .ic { color: var(--acc); }
$S .ap { margin: 0 0 14px; }
$S .ap.stream { color: var(--ink); }
$S .caret { display: inline-block; width: 2px; height: 1.05em; margin-left: 1px; background: var(--acc); vertical-align: -.16em; animation: ulr1-blink 1s steps(2) infinite; }
$S .cd { font-family: var(--mono); font-size: .82em; color: var(--code-ink); word-break: break-word; }
$S .cd .bt { color: var(--mk); }
$S .pre { position: relative; font-family: var(--mono); font-size: 12.5px; line-height: 1.6; background: var(--codebg); border-radius: 8px; padding: 10px 14px; margin: 0 0 14px; white-space: pre; overflow: auto; color: var(--ink); }
$S .pre .fence { color: var(--mk); }
$S .sh { position: relative; font-weight: 600; font-size: 17px; margin: 18px 0 6px; }
$S .hl { border-radius: 2px; padding: 1px 0; box-decoration-break: clone; -webkit-box-decoration-break: clone; cursor: default; }
$S .hl-amber { background: var(--hl-amber); } $S .hl-green { background: var(--hl-green); } $S .hl-blue { background: var(--hl-blue); } $S .hl-pink { background: var(--hl-pink); }
$S .hl.note { border-bottom: 1.5px dotted var(--ink3); }
$S .anc { text-decoration: underline; text-decoration-color: var(--blue); text-decoration-thickness: 1.5px; text-underline-offset: 3px; }
$S .lnk { color: var(--blue); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
$S .branch { font-family: var(--ui); margin: -4px 0 18px; border-left: 2px solid var(--blue-line); padding: 2px 0 2px 14px; }
$S .bhead { display: flex; align-items: center; gap: 7px; width: 100%; font-size: 12.5px; color: var(--ink2); padding: 3px 0; border-radius: 5px; }
$S .bhead .tw { color: var(--ink3); width: 13px; height: 13px; } $S .bhead .tw svg { width: 13px; height: 13px; }
$S .bhead .bi { color: var(--blue); }
$S .bhead b { color: var(--ink); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
$S .bhead .bn { color: var(--ink3); white-space: nowrap; }
$S .bhead .st { color: var(--acc); }
$S .bq { font-family: var(--serif); font-size: 14.5px; color: var(--ink2); line-height: 1.45; padding: 0 0 2px 20px; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
$S .bbody { font-family: var(--serif); padding-top: 10px; }
$S .bbody .sec { margin-bottom: 22px; }
$S .bbody .sec.sel > .hrow::before { left: -74px; }
$S .srcline { font-family: var(--ui); font-size: 11.5px; color: var(--ink3); display: flex; gap: 5px; flex-wrap: wrap; align-items: center; margin: 0 0 4px; }
$S .src { display: inline-flex; gap: 4px; align-items: center; padding: 0 7px; border-radius: 5px; border: 1px solid var(--line); color: var(--ink2); line-height: 18px; }
$S .src sup { font-size: 9px; color: var(--ink3); }
$S .runline { font-family: var(--ui); font-size: 12px; color: var(--ink2); display: flex; gap: 8px; align-items: center; padding: 7px 10px; border-radius: 8px; background: var(--amber-soft); margin: 0 0 12px; }
$S .runline .spin { color: var(--acc-ink); }
$S .runline .lab { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
$S .qline { font-family: var(--ui); font-size: 12.5px; color: var(--ink2); padding: 8px 10px; border-radius: 8px; background: var(--comment); margin: 0 0 12px; display: flex; gap: 8px; align-items: center; }
$S .err { font-family: var(--ui); font-size: 12.5px; border: 1px solid var(--red-line); background: var(--red-soft); border-radius: 8px; padding: 10px 12px; margin: 0 0 12px; }
$S .err .e { font-family: var(--mono); font-size: 11.5px; color: var(--red); margin: 4px 0 8px; line-height: 1.5; }
$S .err .acts, $S .clar .acts { display: flex; gap: 6px; }
$S .clar { font-family: var(--ui); font-size: 13px; border: 1px solid var(--amber-line); background: var(--amber-soft); border-radius: 8px; padding: 10px 12px; margin: 0 0 12px; }
$S .clar .lab { display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; color: var(--acc-ink); margin-bottom: 3px; }
$S .clar p { margin: 0 0 8px; font-family: var(--serif); font-size: 15px; line-height: 1.5; color: var(--ink); }
$S .linkcard { font-family: var(--ui); display: flex; gap: 12px; border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin: 0 0 26px; background: var(--card); }
$S .linkcard .fav { width: 34px; height: 34px; border-radius: 8px; background: var(--chip); display: grid; place-items: center; font-weight: 700; color: var(--ink2); flex: none; }
$S .linkcard b { display: block; font-size: 14px; line-height: 1.35; }
$S .linkcard span { font-size: 12px; color: var(--ink3); }
$S .olist { list-style: none; margin: 0 0 6px; padding: 0; }
$S .olist .olist { padding-left: 24px; margin: 2px 0 0; }
$S .oli { position: relative; margin: 0 0 6px; }
$S .oli > .ot { display: flex; gap: 8px; align-items: baseline; }
$S .oli .bul { position: absolute; left: -22px; top: .1em; width: 16px; height: 16px; display: grid; place-items: center; color: var(--mk); font-family: var(--mono); font-size: 13px; }
$S .oli .bul.has { color: var(--ink3); }
$S .oli .bul.has svg { width: 12px; height: 12px; }
$S .ref { font-family: var(--ui); font-size: 11.5px; color: var(--blue); white-space: nowrap; border-radius: 4px; padding: 0 4px; background: var(--blue-soft); line-height: 18px; }
$S .ref:hover { text-decoration: underline; }
$S .seam { display: flex; align-items: center; gap: 10px; margin: 36px 0 28px; font-family: var(--ui); font-size: 11px; color: var(--ink3); }
$S .seam::before, $S .seam::after { content: ""; flex: 1; border-top: 1px dashed var(--line); }
$S .gluebar { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 8px; margin: 0 -76px 14px; padding: 8px 12px; background: var(--ed); border-bottom: 1px solid var(--line2); font-family: var(--ui); font-size: 12px; color: var(--ink2); }
$S .gluebar .ic { color: var(--acc-ink); }
$S .gluebar b { color: var(--ink); }
$S .doc.tw .h1, $S .doc.tw .sub, $S .doc.tw .comment, $S .doc.tw .sec:not(.sel):not(:has(.sec.sel)), $S .doc.tw .branch:not(:has(.sec.sel)) { opacity: .3; transition: opacity .2s; }
$S .doc.tw .sec.sel .branch { opacity: .3; }
$S .doc.tw { padding-top: 120px; }
$S .gs p { margin: 0 0 14px; }
$S .gs h2 { position: relative; font-size: 19.5px; font-weight: 600; margin: 28px 0 8px; line-height: 1.35; }
$S .gs ul { margin: 0 0 14px; padding-left: 22px; }
$S .gs li { margin: 0 0 6px; }
$S .gs .diag { font-family: var(--mono); font-size: 12.5px; line-height: 1.75; background: var(--codebg); border-radius: 8px; padding: 10px 14px; margin: 0 0 14px; white-space: pre; color: var(--ink2); }
$S .gs .next { font-family: var(--ui); font-size: 13px; color: var(--blue); }
$S .agt { font-family: var(--ui); border: 1px solid var(--line); border-radius: 10px; margin: 4px 0 8px; background: var(--card); overflow: hidden; }
$S .arow { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-top: 1px solid var(--line2); font-size: 13px; }
$S .arow:first-child { border-top: 0; }
$S .arow i { width: 8px; height: 8px; }
$S .arow b { font-weight: 600; min-width: 96px; }
$S .arow .s { color: var(--ink2); flex: 1; }
$S .arow .s.ok { color: var(--green); }
$S .arow code { font-family: var(--mono); font-size: 11.5px; background: var(--chip); padding: 1px 6px; border-radius: 4px; }
$S .small { font-family: var(--ui); font-size: 12px; color: var(--ink3); }

/* composer */
$S .comp { position: relative; margin-top: 40px; }
$S .comp .crow { position: relative; }
$S .cta { display: block; width: 100%; resize: none; border: 0; outline: 0; background: transparent; padding: 0; margin: 0; font-family: var(--serif); font-weight: 600; font-size: 19.5px; line-height: 1.38; color: var(--ink); min-height: 27px; overflow: hidden; }
$S .cta::placeholder { color: var(--ph); font-weight: 400; }
$S .comp .crow .hang { color: var(--acc); }
$S .cquote { position: relative; font-family: var(--serif); font-size: 15px; color: var(--ink2); border-left: 2px solid var(--blue-line); padding: 0 28px 0 12px; margin: 0 0 12px; line-height: 1.5; }
$S .cquote .x { position: absolute; right: 0; top: 0; }
$S .cbar { font-family: var(--ui); display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 12px; color: var(--ink2); flex-wrap: nowrap; }
$S .chelp { font-family: var(--ui); font-size: 11.5px; color: var(--ink3); margin-top: 8px; line-height: 1.45; }
$S .seg { display: inline-flex; background: var(--chip); border-radius: 7px; padding: 2px; flex: none; }
$S .seg button { padding: 0 9px; line-height: 20px; border-radius: 5px; font-size: 12px; color: var(--ink2); white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; }
$S .seg button.on { background: var(--ed); color: var(--ink); box-shadow: 0 0 0 .5px rgba(0,0,0,.14), 0 1px 2px rgba(0,0,0,.08); }
$S[data-theme="dark"] .seg button.on { background: #45423f; box-shadow: none; }
$S .mbtn { display: inline-flex; gap: 6px; align-items: center; height: 24px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--line); white-space: nowrap; color: var(--ink); flex: none; }
$S .mbtn:hover { background: var(--hover); }
$S .mbtn .ic { color: var(--ink3); width: 12px; } $S .mbtn .ic svg { width: 12px; }
$S .tgt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink3); min-width: 0; }
$S .kbd { font-size: 11px; color: var(--ink3); white-space: nowrap; flex: none; }
$S .sendb { width: 26px; height: 26px; border-radius: 50%; background: var(--acc); color: #3b2b00; display: grid; place-items: center; flex: none; }
$S .sendb[disabled] { background: var(--chip); color: var(--ink3); }
$S .dock { flex: none; padding: 10px 20px 14px; border-top: 1px solid var(--line2); background: var(--ed); }
$S .dock .dbox { max-width: 680px; margin: 0 auto; border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px 8px; background: var(--card); box-shadow: 0 1px 3px rgba(0,0,0,.05); }
$S .dock .cta { font-weight: 400; font-size: 15.5px; line-height: 1.45; min-height: 22px; }
$S .dock .cbar { margin-top: 8px; }
$S .dock .cquote { margin-bottom: 8px; }

/* attachments pane */
$S .att .tb { justify-content: center; }
$S .att-scroll { flex: 1; overflow: auto; padding: 0 16px 24px; }
$S .ah { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; color: var(--ink3); margin: 18px 0 8px; }
$S .ah .grow { flex: 1; }
$S .ah button { text-transform: none; letter-spacing: 0; font-weight: 500; color: var(--blue); font-size: 11.5px; }
$S .ah:first-child { margin-top: 6px; }
$S .orow { display: flex; align-items: center; gap: 4px; width: 100%; min-height: 25px; padding: 2px 6px 2px 0; border-radius: 5px; font-size: 12.5px; color: var(--ink); }
$S .orow:hover { background: var(--hover); }
$S .orow.on { background: var(--sellib); }
$S .orow .tw { width: 14px; height: 14px; color: var(--ink3); } $S .orow .tw svg { width: 12px; height: 12px; }
$S .orow .tws { width: 14px; flex: none; }
$S .orow .lv { font-family: var(--mono); font-size: 10.5px; color: var(--mk); flex: none; min-width: 20px; }
$S .orow .ot { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
$S .orow .wc { color: var(--ink3); font-size: 11px; font-variant-numeric: tabular-nums; flex: none; }
$S .orow.h1r .ot { font-weight: 600; }
$S .orow .sglyph { margin-top: 0; }
$S .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--line2); border: 1px solid var(--line2); border-radius: 9px; overflow: hidden; }
$S .stats div { background: var(--card); padding: 8px 10px; }
$S .stats b { display: block; font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
$S .stats span { font-size: 11px; color: var(--ink3); }
$S .goal { background: var(--card); border: 1px solid var(--line2); border-radius: 9px; padding: 10px 12px; display: flex; gap: 12px; align-items: center; }
$S .goal svg { width: 34px; height: 34px; flex: none; }
$S .goal b { display: block; font-size: 12.5px; }
$S .goal span { font-size: 11.5px; color: var(--ink3); }
$S .chips { display: flex; flex-wrap: wrap; gap: 5px; }
$S .chips input { font: inherit; font-size: 11.5px; border: 1px solid var(--blue); border-radius: 9px; padding: 0 8px; height: 19px; width: 110px; outline: 0; background: var(--card); color: var(--ink); }
$S .lrow2 { display: flex; gap: 8px; align-items: flex-start; width: 100%; padding: 6px 6px; border-radius: 6px; font-size: 12.5px; line-height: 1.35; }
$S .lrow2:hover { background: var(--hover); }
$S .lrow2 .ic { color: var(--ink3); margin-top: 1px; }
$S .lrow2 small { display: block; color: var(--ink3); font-size: 11px; margin-top: 1px; }
$S .acard { background: var(--card); border: 1px solid var(--line2); border-radius: 9px; padding: 9px 11px; margin-bottom: 6px; font-size: 12.5px; line-height: 1.45; width: 100%; display: block; }
$S button.acard:hover { border-color: var(--line); }
$S .acard .qq { font-family: var(--serif); font-size: 13.5px; }
$S .acard .qq span { border-radius: 2px; padding: 0 1px; }
$S .acard small { display: block; color: var(--ink3); font-size: 11px; margin-top: 4px; }
$S .acard .nn { color: var(--ink2); font-style: italic; margin-top: 4px; }
$S .acard .fv { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 4px; background: var(--chip); font-size: 9.5px; font-weight: 700; color: var(--ink2); margin-right: 6px; vertical-align: -3px; }
$S .kv { display: grid; grid-template-columns: 78px 1fr; gap: 6px 10px; font-size: 12.5px; align-items: center; }
$S .kv dt { color: var(--ink3); } $S .kv dd { margin: 0; min-width: 0; }
$S .runhead { font-family: var(--serif); font-size: 15px; font-weight: 600; line-height: 1.35; margin: 4px 0 8px; }
$S .step { display: grid; grid-template-columns: 18px 1fr auto; gap: 2px 8px; padding: 7px 0; border-bottom: 1px solid var(--line2); font-size: 12px; line-height: 1.35; }
$S .step .ic { color: var(--ink3); width: 14px; height: 14px; margin-top: 1px; } $S .step .ic svg { width: 14px; height: 14px; }
$S .step .dt { grid-column: 2 / 4; font-family: var(--mono); font-size: 10.5px; color: var(--ink3); word-break: break-all; }
$S .step .ms { font-size: 11px; color: var(--ink3); font-variant-numeric: tabular-nums; }
$S .step.error .ic, $S .step.error .dt { color: var(--red); }
$S .step.running .ic { color: var(--acc-ink); }
$S .acts2 { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
$S .ainfo { font-size: 12px; color: var(--ink2); line-height: 1.45; background: var(--comment); border-radius: 8px; padding: 8px 10px; margin-top: 10px; }

/* overlays and menus */
$S .layer { position: absolute; inset: 0; z-index: 40; pointer-events: none; }
$S .layer > * { pointer-events: auto; }
$S .scrim { position: absolute; inset: 0; background: rgba(0,0,0,.16); }
$S[data-theme="dark"] .scrim { background: rgba(0,0,0,.4); }
$S .pop { position: absolute; z-index: 45; background: var(--pop); border-radius: 9px; box-shadow: var(--shadow); padding: 5px; font-size: 13px; min-width: 190px; }
$S .mi { display: flex; align-items: center; gap: 8px; width: 100%; height: 25px; padding: 0 9px; border-radius: 5px; white-space: nowrap; }
$S .mi:hover { background: var(--menu); color: #fff; }
$S .mi:hover .ic, $S .mi:hover .k { color: #fff; }
$S .mi .ic { color: var(--ink3); width: 14px; } $S .mi .chk { width: 14px; color: var(--ink); }
$S .mi .k { margin-left: auto; color: var(--ink3); font-size: 12px; padding-left: 16px; }
$S .msep { height: 1px; background: var(--line); margin: 5px 6px; }
$S .mh { font-size: 11px; font-weight: 600; color: var(--ink3); padding: 6px 9px 3px; }
$S .modelpop { display: grid; grid-template-columns: 150px 150px 110px; min-width: 0; padding: 6px; gap: 0 4px; }
$S .modelpop .col { border-left: 1px solid var(--line2); padding-left: 4px; } $S .modelpop .col:first-child { border: 0; padding: 0; }
$S .qo { position: absolute; top: 96px; left: 50%; transform: translateX(-50%); width: 580px; background: var(--pop); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; }
$S .qo input { width: 100%; border: 0; outline: 0; background: transparent; font: 400 19px/1.3 var(--ui); color: var(--ink); padding: 16px 18px 14px 46px; border-bottom: 1px solid var(--line); }
$S .qo .qi { position: absolute; left: 16px; top: 18px; color: var(--ink3); }
$S .qo .res { max-height: 360px; overflow: auto; padding: 6px; }
$S .qr { display: flex; gap: 10px; align-items: center; width: 100%; padding: 7px 10px; border-radius: 7px; font-size: 13px; }
$S .qr.on { background: var(--menu); color: #fff; } $S .qr.on small, $S .qr.on .ic { color: #fff; }
$S .qr .ic { color: var(--ink3); }
$S .qr span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
$S .qr small { color: var(--ink3); font-size: 11.5px; white-space: nowrap; }
$S .qo .qfoot { border-top: 1px solid var(--line); padding: 7px 14px; font-size: 11.5px; color: var(--ink3); display: flex; gap: 14px; }
$S .xp { position: absolute; top: 60px; left: 50%; transform: translateX(-50%); width: 860px; height: 620px; background: var(--pop); border-radius: 12px; box-shadow: var(--shadow); display: grid; grid-template-columns: 250px 1fr; overflow: hidden; }
$S .xp .side { padding: 16px; border-right: 1px solid var(--line); display: flex; flex-direction: column; gap: 4px; background: var(--att); }
$S .xp .side h3 { margin: 0 0 8px; font-size: 14px; }
$S .xp .fmt { display: flex; gap: 10px; align-items: center; width: 100%; padding: 7px 9px; border-radius: 7px; font-size: 13px; }
$S .xp .fmt.on { background: var(--sellib); font-weight: 600; }
$S .xp .fmt small { margin-left: auto; color: var(--ink3); font-weight: 400; font-size: 11px; }
$S .xp label { display: flex; gap: 8px; align-items: center; font-size: 12.5px; padding: 4px 2px; color: var(--ink2); }
$S .xp .prev { background: var(--chip); padding: 24px; overflow: auto; position: relative; }
$S .xp .page { background: #fff; color: #222; width: 420px; min-height: 560px; margin: 0 auto; padding: 44px 46px; box-shadow: 0 2px 10px rgba(0,0,0,.18); font-family: var(--serif); font-size: 8.5px; line-height: 1.55; }
$S .xp .page h1 { font-size: 16px; margin: 0 0 4px; line-height: 1.25; }
$S .xp .page h2 { font-size: 10.5px; margin: 12px 0 4px; line-height: 1.3; }
$S .xp .page p { margin: 0 0 6px; }
$S .xp .page .pm { font-family: var(--ui); font-size: 7px; color: #888; margin-bottom: 10px; }
$S .xp .page .fn { font-size: 7px; color: #666; border-top: 1px solid #ddd; padding-top: 6px; margin-top: 12px; }
$S .xp .bar { position: absolute; right: 16px; bottom: 14px; display: flex; gap: 8px; }
$S .selbar { position: absolute; z-index: 44; display: flex; gap: 1px; padding: 3px; border-radius: 8px; background: #2d2b29; box-shadow: 0 6px 20px rgba(0,0,0,.25); transform: translateX(-50%); }
$S .selbar button { color: #f2efe9; font-size: 12px; padding: 4px 9px; border-radius: 5px; display: inline-flex; gap: 5px; align-items: center; white-space: nowrap; }
$S .selbar button:hover { background: rgba(255,255,255,.12); }
$S .selbar .ic { color: #f3c64a; width: 13px; } $S .selbar .ic svg { width: 13px; }
$S .selbar .dis { color: #b9b4ad; font-size: 12px; padding: 4px 9px; }
$S .toast { position: absolute; z-index: 46; left: 50%; bottom: 24px; transform: translateX(-50%); background: #2d2b29; color: #f3f0ea; font-size: 12.5px; padding: 8px 14px; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.25); white-space: nowrap; }
$S .sheetpop { width: 320px; max-height: 520px; overflow: auto; padding: 0; }
$S .sheetpop .row { padding: 10px 14px 10px 20px; }
$S .sheetpop .row .m { display: none; }
$S .sheetpop .ph { padding: 10px 14px 6px; font-size: 11.5px; color: var(--ink3); font-weight: 600; border-bottom: 1px solid var(--line2); display: flex; }
`;
  CSS = CSS.replace(/\$S/g, "." + SCOPE);

  /* ---------------------------------------------------------------- helpers */
  function add(el, kids) {
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k == null || k === false) continue;
      if (Array.isArray(k)) add(el, k);
      else el.appendChild(typeof k === "object" ? k : document.createTextNode(String(k)));
    }
  }
  function h(tag, a) {
    var parts = tag.split(".");
    var el = document.createElement(parts[0] || "div");
    if (parts.length > 1) el.className = parts.slice(1).join(" ");
    if (a) for (var k in a) {
      var v = a[k];
      if (v == null || v === false) continue;
      if (k === "class") el.className = (el.className ? el.className + " " : "") + v;
      else if (k === "text") el.textContent = v;
      else if (k === "style") el.style.cssText = v;
      else if (k === "value") el.value = v;
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    add(el, [].slice.call(arguments, 2));
    return el;
  }
  function ic(name, cls) {
    var s = h("span.ic" + (cls ? "." + cls : ""));
    s.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">' + (ICONS[name] || "") + "</svg>";
    return s;
  }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function strip(s) { return String(s || "").replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim(); }
  function words(s) { var m = strip(s).match(/\S+/g); return m ? m.length : 0; }
  function fmtN(n) { return n.toLocaleString("en-US"); }
  function fmtDur(s) {
    if (s == null) return null;
    if (s < 60) return s + " s";
    var m = Math.floor(s / 60), r = s % 60;
    if (m >= 60) return Math.floor(m / 60) + " h " + (m % 60) + " min";
    return m + " min" + (r ? " " + r + " s" : "");
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); }

  /* -------------------------------------------------------------- guide data */
  var GUIDE = [
    { id: "g1", title: "Welcome to Session", excerpt: "What Session does, agent status, and your first question.", blocks: [
      { p: "Session runs the agent CLIs already installed on this Mac (Claude Code, Codex and Grok) with your existing sign-in. Each conversation is saved as a sheet: your questions become headings, the answers become the text under them, and the run trace and sources are kept in the Attachments pane." },
      { h2: "1. Check your agents" },
      { agents: true },
      { small: "Status refreshes on its own every few seconds after you sign in. One ready agent is enough to start." },
      { h2: "2. Ask your first question" },
      { p: "Type below and press Return. The answer streams into a new sheet in Inbox. You can file it into a group later." },
      { composer: true },
      { next: "g2" }
    ] },
    { id: "g2", title: "Follow-ups and branches", excerpt: "Continue a conversation, or start a side line of questioning from a passage.", blocks: [
      { p: "A follow-up continues the conversation. It is added after the last answer, and the agent sees every section above it. One answer runs at a time in a conversation; a follow-up sent while an answer is running waits in a queue and starts when that answer finishes." },
      { p: "A branch starts a separate line of questioning from a passage or from a whole answer. Select text in an answer and choose Branch. The branch is folded under that paragraph, its passage is underlined, and the Dashboard outline shows it as a sub-section. The main conversation is unchanged." },
      { diag: "## Find the getInt16 codegen bug\n   ↳ ### Unaligned halfword loads on ARM64      branch\n        ↳ #### Regression sweep test             branch\n## Check the x86-64 path                          follow-up" },
      { next: "g3" }
    ] },
    { id: "g3", title: "Favorites, marks, keywords and links", excerpt: "Three ways to keep what matters, each with one scope.", blocks: [
      { p: "Each way of keeping something applies to one thing:" },
      { li: ["Favorite: a whole sheet. Listed under Favorites.", "Mark: a passage in an answer, with an optional note and colour. Listed under the Marked passages filter.", "Keyword: a label on a sheet. Click a keyword to list every sheet that has it."] },
      { p: "Links between sheets and notes are listed in the Attachments pane, together with every sheet that links back." },
      { next: "g4" }
    ] },
    { id: "g4", title: "Workspaces, groups and filters", excerpt: "Where sheets live, and saved searches across them.", blocks: [
      { li: ["A workspace is a directory on disk. Each workspace is a section of the library, and agents run in that directory.", "A group holds sheets inside a workspace. A sheet is in one group, or in Inbox until you file it. All always lists every sheet.", "A filter is a saved search. Needs attention lists unread answers, failed runs and runs waiting for your reply. Running & queued lists active runs."] },
      { next: "g5" }
    ] },
    { id: "g5", title: "Glue sheets into a synthesis", excerpt: "Read several sheets as one document, then save or export it.", blocks: [
      { p: "⌘-click several sheets in the list to read them as one document. The Dashboard outline spans all of them. Save the result as a note that links back to every section, or export it as Markdown, PDF or HTML." }
    ] }
  ];
  var GUIDE_BY = {};
  GUIDE.forEach(function (g) { GUIDE_BY[g.id] = g; });

  /* simulated continuations for runs already in progress in data.js */
  var CONTINUE = {
    t3q3: { steps: [{ kind: "think", label: "Computed KV budget with FP8 weights", detail: "quantization: fp8 in llama3-70b.yaml" }],
      paras: ["The config serves FP8 weights (`quantization: fp8`), about 71 GB across both GPUs. That leaves roughly 79 GB for the KV cache after about 10 GB of activations and CUDA graphs. At 320 KiB per token that is about 240k tokens, or 29 concurrent 8k-token sequences."] },
    t3q4: { steps: [{ kind: "think", label: "Planned: halve per-token KV size, keep weights and overhead" }],
      paras: ["An e4m3 KV cache stores 160 KiB per token, so the same 79 GB holds about 480k tokens, or 58 concurrent 8k-token sequences. Expect a small accuracy cost on long-context retrieval; the draft \"Compare FP8 (e4m3) vs fp16 KV cache accuracy\" in Drafts measures it."] },
    t2q3: { steps: [{ kind: "run", label: "Ran ./scripts/test262.sh built-ins/Math", detail: "327 of 327 files passed" }],
      paras: ["`built-ins/Math` finished: 327 of 327 files pass, including the 4 `hypot` files that failed before the patch. No other Math builtin changed results."] }
  };

  /* ---------------------------------------------------------------- variants */
  var VARIANTS = {
    a: { lib: true, list: true, att: false, tab: "dashboard", place: "all", sel: ["t1"], section: "t1q2", composer: "inline" },
    b: { lib: false, list: true, att: true, tab: "run", place: "ws:ws-ml", sel: ["t3"], section: "t3q3", composer: "dock", scrollTo: "t3q3" },
    c: { lib: false, list: true, att: true, tab: "dashboard", place: "ws:ws-compilers", sel: ["n1", "t1", "t2", "t6"], composer: "inline", listW: 290 },
    d: { lib: false, list: false, att: false, typewriter: true, place: "g:f-papers", sel: ["t5"], section: "t5q1", composer: "inline", scrollTo: "t5q1", focusComposer: true },
    e: { lib: true, list: true, att: false, tab: "dashboard", place: "guide", sel: ["g1"], composer: "inline", firstRun: true }
  };

  /* ------------------------------------------------------------------- data */
  function prep(src, firstRun) {
    var D = {
      now: Date.parse(src.now), providers: src.providers, statuses: src.statuses,
      workspaces: clone(src.workspaces), folders: clone(src.folders), threads: clone(src.threads),
      notes: clone(src.notes), drafts: clone(src.drafts),
      agents: [
        { id: "claude", label: "Claude Code", ok: true, detail: "Ready" },
        { id: "codex", label: "Codex", ok: true, detail: "Ready" },
        { id: "grok", label: "Grok", ok: true, detail: "Ready" }
      ]
    };
    if (firstRun) {
      D.workspaces = [{ id: "ws-default", name: "Default workspace", dir: "~/Session" }];
      D.folders = []; D.threads = []; D.notes = []; D.drafts = [];
      D.agents[2] = { id: "grok", label: "Grok", ok: false, detail: "Not signed in", cmd: "grok login" };
    }
    reindex(D);
    return D;
  }
  function reindex(D) {
    D.T = {}; D.U = {}; D.N = {}; D.Dr = {};
    D.threads.forEach(function (t) { D.T[t.id] = t; t.turns.forEach(function (u) { u.threadId = t.id; D.U[u.id] = u; }); });
    D.notes.forEach(function (n) { D.N[n.id] = n; });
    D.drafts.forEach(function (d) { D.Dr[d.id] = d; });
  }

  /* ------------------------------------------------------------------ mount */
  function mount(root, ctx) {
    var cfg = VARIANTS[ctx.variant] || VARIANTS.a;
    var D = prep(ctx.data, cfg.firstRun);
    var NOW = D.now;
    var timers = [];
    var disposed = false;
    var uid = 0;
    function later(fn, ms) {
      var id = setTimeout(function () { var i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); if (!disposed) fn(); }, ms);
      timers.push(id);
      return id;
    }
    function nowISO() { return new Date(NOW + (Date.now() - t0)).toISOString(); }
    var t0 = Date.now();

    var st = {
      lib: cfg.lib, list: cfg.list, att: cfg.att, tab: cfg.tab,
      place: cfg.place, sel: cfg.sel.slice(), section: cfg.section || null,
      open: {}, ocollapsed: {}, wsCollapsed: {}, typewriter: !!cfg.typewriter,
      comp: { text: "", mode: "followup", anchor: null, provider: "claude", model: "opus", effort: "high" },
      newSheet: null, pop: null, overlay: null, toast: null, addingKw: false
    };

    /* ----- sheets and places */
    function sheet(id) {
      var t = D.T[id];
      if (t) return { id: id, type: "thread", o: t, title: t.title, updated: t.updatedAt, tags: t.tags, ws: t.workspaceId };
      var n = D.N[id];
      if (n) return { id: id, type: "note", o: n, title: n.title, updated: n.updatedAt, tags: n.tags, ws: n.workspaceId };
      var d = D.Dr[id];
      if (d) return { id: id, type: "draft", o: d, title: strip(d.prompt), updated: d.updatedAt, tags: [], ws: d.workspaceId };
      var g = GUIDE_BY[id];
      if (g) return { id: id, type: "guide", o: g, title: g.title, updated: null, tags: [], ws: null };
      if (st.newSheet && st.newSheet.id === id) return { id: id, type: "new", o: st.newSheet, title: "New question", updated: nowISO(), tags: [], ws: st.newSheet.ws };
      return null;
    }
    function live() { return D.threads.filter(function (t) { return !t.archivedAt; }); }
    function ids(arr) { return arr.map(function (x) { return x.id; }); }
    function byUpdated(list) {
      return list.slice().sort(function (a, b) { var A = sheet(a), B = sheet(b); return (A.updated || "") < (B.updated || "") ? 1 : -1; });
    }
    function threadFlag(t) {
      var s = { running: false, queued: false, failed: false, review: false };
      t.turns.forEach(function (u) {
        if (u.status === "running") s.running = true;
        if (u.status === "queued") s.queued = true;
        if (u.status === "failed") s.failed = true;
        if (u.status === "needs-review") s.review = true;
      });
      return s;
    }
    function needsAttention(t) { var f = threadFlag(t); return t.unread || f.failed || f.review; }
    function placeSheets(p) {
      var L, k = p.split(":")[0], arg = p.slice(k.length + 1);
      if (k === "guide") return ids(GUIDE);
      if (k === "marks") return [];
      if (k === "all") L = ids(live()).concat(ids(D.notes), ids(D.drafts));
      else if (k === "recent") L = ids(live().filter(function (t) { return NOW - Date.parse(t.updatedAt) < 7 * 864e5; })).concat(ids(D.notes.filter(function (n) { return NOW - Date.parse(n.updatedAt) < 7 * 864e5; })));
      else if (k === "inbox") L = ids(live().filter(function (t) { return !t.folderId; }));
      else if (k === "drafts") L = ids(D.drafts);
      else if (k === "fav") L = ids(live().filter(function (t) { return t.bookmarked; }));
      else if (k === "attention") L = ids(live().filter(needsAttention));
      else if (k === "running") L = ids(live().filter(function (t) { var f = threadFlag(t); return f.running || f.queued; }));
      else if (k === "archive") L = ids(D.threads.filter(function (t) { return t.archivedAt; }));
      else if (k === "ws") L = ids(live().filter(function (t) { return t.workspaceId === arg; })).concat(ids(D.notes.filter(function (n) { return n.workspaceId === arg; })), ids(D.drafts.filter(function (d) { return d.workspaceId === arg; })));
      else if (k === "g") L = ids(live().filter(function (t) { return t.folderId === arg; }));
      else if (k === "notes") L = ids(D.notes.filter(function (n) { return n.workspaceId === arg; }));
      else if (k === "kw") L = ids(live().filter(function (t) { return t.tags.indexOf(arg) >= 0; })).concat(ids(D.notes.filter(function (n) { return n.tags.indexOf(arg) >= 0; })));
      else L = [];
      L = byUpdated(L);
      if (st.newSheet && st.newSheet.place === p) L.unshift(st.newSheet.id);
      return L;
    }
    function wsName(id) { var w = D.workspaces.find(function (x) { return x.id === id; }); return w ? w.name : ""; }
    function folderName(id) { var f = D.folders.find(function (x) { return x.id === id; }); return f ? f.name : ""; }
    function placeInfo(p) {
      var k = p.split(":")[0], arg = p.slice(k.length + 1);
      var map = {
        all: { title: "All", sub: "Every sheet in every workspace" },
        recent: { title: "Last 7 Days", sub: "Changed since Oct 4" },
        inbox: { title: "Inbox", sub: "Sheets not filed into a group" },
        drafts: { title: "Drafts", sub: "Questions you have not sent" },
        fav: { title: "Favorites", sub: "Sheets you marked as favorite" },
        attention: { title: "Needs attention", sub: "Filter", query: "Answer is unread, or a run failed, or an agent asked a question" },
        running: { title: "Running & queued", sub: "Filter", query: "A run in the sheet is running or waiting in a queue" },
        marks: { title: "Marked passages", sub: "Filter", query: "Every marked passage, newest first" },
        archive: { title: "Archive", sub: "Read-only. Unarchive to ask again." },
        guide: { title: "Getting Started", sub: "5 sheets" }
      };
      if (map[k]) return map[k];
      if (k === "ws") return { title: wsName(arg), sub: "Workspace" };
      if (k === "g") { var f = D.folders.find(function (x) { return x.id === arg; }); return { title: f ? f.name : "Group", sub: f ? wsName(f.workspaceId) : "" }; }
      if (k === "notes") return { title: "Notes", sub: wsName(arg) };
      if (k === "kw") return { title: "Keyword: " + arg, sub: "Filter", query: "Keyword is “" + arg + "”" };
      return { title: p, sub: "" };
    }
    function provider(id) { return D.providers.find(function (p) { return p.id === id; }) || { id: id, label: id, models: [], efforts: [] }; }

    /* ----- thread structure */
    function rootOf(t) { return D.U[t.rootTurnId] || t.turns[0]; }
    function followOf(t, u) { return t.turns.find(function (x) { return x.parentId === u.id && x.relation === "followup"; }); }
    function branchesOf(t, u) { return t.turns.filter(function (x) { return x.parentId === u.id && x.relation === "branch"; }); }
    function chainEnd(t, u) { var f; while ((f = followOf(t, u))) u = f; return u; }
    function chainHead(u) { while (u && u.relation === "followup") u = D.U[u.parentId]; return u; }
    function countSections(t, head) {
      var n = 0;
      for (var u = head; u; u = followOf(t, u)) { n++; branchesOf(t, u).forEach(function (b) { n += countSections(t, b); }); }
      return n;
    }
    function subtreeStatus(t, head) {
      var s = null;
      (function walk(h0) {
        for (var u = h0; u; u = followOf(t, u)) {
          if (u.status === "running") s = "running"; else if (u.status === "failed" && s !== "running") s = "failed";
          else if (u.status === "needs-review" && !s) s = "needs-review"; else if (u.status === "queued" && !s) s = "queued";
          branchesOf(t, u).forEach(walk);
        }
      })(head);
      return s;
    }
    function openAncestors(u) {
      var x = u;
      while (x) {
        var hd = chainHead(x);
        if (!hd) break;
        if (hd.relation === "branch") st.open[hd.id] = true;
        x = D.U[hd.parentId];
      }
    }
    function defaultSection(t) { return chainEnd(t, rootOf(t)).id; }
    function threadWords(t) { var n = 0; t.turns.forEach(function (u) { n += words(u.question); u.answer.forEach(function (p) { n += words(p); }); }); return n; }

    /* ----- status presentation */
    function tone(status) { return (D.statuses[status] || { tone: "plain" }).tone; }
    function pill(status) {
      if (!status || status === "done") return null;
      var s = D.statuses[status] || { label: status, tone: "plain" };
      return h("span.pill." + s.tone, null, status === "running" ? h("span.spin") : null, s.label);
    }
    function glyph(status) {
      if (!status || status === "done") return null;
      var t = tone(status), title = (D.statuses[status] || {}).label;
      if (status === "running") return h("span.sglyph.run", { title: title }, h("span.spin", { style: "display:block;margin:2px" }));
      if (status === "queued") return h("span.sglyph.plain", { title: title }, ic("clock", "sm"));
      if (status === "failed") return h("span.sglyph.error", { title: title }, ic("alert", "sm"));
      if (status === "needs-review") return h("span.sglyph.attention", { title: title }, ic("question", "sm"));
      return h("span.sglyph." + t);
    }
    function threadStatus(t) { var f = threadFlag(t); return f.running ? "running" : f.review ? "needs-review" : f.failed ? "failed" : f.queued ? "queued" : "done"; }
    function fmtDate(iso) {
      if (!iso) return "";
      var d = new Date(iso), dd = Math.floor(NOW / 864e5) - Math.floor(d.getTime() / 864e5);
      var hm = pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
      if (dd <= 0) return "Today, " + hm;
      if (dd === 1) return "Yesterday, " + hm;
      return MON[d.getUTCMonth()] + " " + d.getUTCDate();
    }
    function fmtLong(iso) { var d = new Date(iso); return MON[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()); }

    /* ----- inline markdown with marks */
    function tokens(s) {
      var out = [], re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g, last = 0, m;
      while ((m = re.exec(s))) {
        if (m.index > last) out.push({ k: "t", s: s.slice(last, m.index) });
        if (m[1] != null) out.push({ k: "c", s: m[1] });
        else if (m[2] != null) out.push({ k: "b", s: m[2] });
        else out.push({ k: "a", s: m[3] });
        last = re.lastIndex;
      }
      if (last < s.length) out.push({ k: "t", s: s.slice(last) });
      return out;
    }
    function inline(s, marks) {
      var toks = tokens(String(s || "")), plain = toks.map(function (t) { return t.s; }).join("");
      var ranges = [];
      (marks || []).forEach(function (m) {
        var q = m.quote.replace(/`/g, "").trim(), i = plain.indexOf(q);
        if (q && i >= 0) ranges.push({ a: i, b: i + q.length, m: m });
      });
      var frag = document.createDocumentFragment(), pos = 0;
      toks.forEach(function (t) {
        var a = pos, b = pos + t.s.length;
        pos = b;
        var cuts = [a, b];
        ranges.forEach(function (r) { if (r.a > a && r.a < b) cuts.push(r.a); if (r.b > a && r.b < b) cuts.push(r.b); });
        cuts = cuts.filter(function (v, i, arr) { return arr.indexOf(v) === i; }).sort(function (x, y) { return x - y; });
        var holder = t.k === "c" ? h("code.cd") : t.k === "b" ? h("strong") : t.k === "a" ? h("span.lnk") : frag;
        if (t.k === "c") holder.appendChild(h("span.bt", { text: "`" }));
        for (var i = 0; i < cuts.length - 1; i++) {
          var x = cuts[i], y = cuts[i + 1], txt = t.s.slice(x - a, y - a);
          var cov = ranges.filter(function (r) { return r.a <= x && r.b >= y; });
          if (cov.length) {
            var sp = h("span", { class: cov.map(function (r) { return r.m.cls; }).join(" ") }, txt);
            cov.forEach(function (r) { if (r.m.id) sp.setAttribute("data-mark", r.m.id); if (r.m.note) sp.title = r.m.note; });
            holder.appendChild(sp);
          } else holder.appendChild(document.createTextNode(txt));
        }
        if (t.k === "c") holder.appendChild(h("span.bt", { text: "`" }));
        if (holder !== frag) frag.appendChild(holder);
      });
      return frag;
    }
    function blocks(para, marks, pi, turnId) {
      if (/^```/.test(para)) {
        var lines = para.split("\n");
        var pre = h("div.pre");
        pre.appendChild(h("span.fence", { text: lines[0] + "\n" }));
        pre.appendChild(document.createTextNode(lines.slice(1, -1).join("\n") + "\n"));
        pre.appendChild(h("span.fence", { text: lines[lines.length - 1] }));
        return [pre];
      }
      var out = [], lines2 = para.split("\n"), body = [];
      lines2.forEach(function (ln) {
        var m = /^(#{2,4})\s+(.*)$/.exec(ln);
        if (m) out.push(h("div.sh", null, h("span.hang", { text: m[1] }), m[2]));
        else body.push(ln);
      });
      if (body.length) out.push(h("p.ap", { "data-p": pi, "data-turn": turnId }, inline(body.join(" "), marks)));
      return out;
    }

    /* ----- DOM skeleton */
    root.tabIndex = -1;
    var libEl = h("div.pane.lib"), listEl = h("div.pane.list"), edEl = h("div.pane.ed"), attEl = h("div.pane.att"), layer = h("div.layer");
    root.replaceChildren(libEl, listEl, edEl, attEl, layer);
    if (cfg.listW) listEl.style.width = cfg.listW + "px";

    function lights() { return h("div.lights", { "aria-hidden": "true" }, h("i"), h("i"), h("i")); }
    function firstPane() { return st.lib ? "lib" : st.list ? "list" : "ed"; }
    function scale() { var r = root.getBoundingClientRect(); return r.width / 1280 || 1; }
    function relRect(el) {
      var r = el.getBoundingClientRect(), R = root.getBoundingClientRect(), s = scale();
      return { left: (r.left - R.left) / s, top: (r.top - R.top) / s, right: (r.right - R.left) / s, bottom: (r.bottom - R.top) / s, width: r.width / s, height: r.height / s };
    }

    /* ================================================================ library */
    function libRow(place, icon, label, opts) {
      opts = opts || {};
      var n = opts.count != null ? opts.count : (place === "marks" ? allMarks().length : placeSheets(place).length);
      return h("button.lrow" + (opts.sub ? ".sub" : ""), {
        class: st.place === place ? "on" : null, title: opts.title || null,
        onclick: function () { go(place); }
      }, ic(icon), h("span.lbl", { text: label }),
        opts.badge ? (n ? h("span.badge", { text: n }) : null) : (n ? h("span.ct", { text: n }) : null));
    }
    function renderLib() {
      libEl.style.display = st.lib ? "" : "none";
      if (!st.lib) return;
      var sc = h("div.lib-scroll");
      sc.append(
        libRow("all", "stack", "All"),
        libRow("recent", "clock", "Last 7 Days"),
        libRow("inbox", "inbox", "Inbox", { title: "Sheets not filed into a group" }),
        libRow("drafts", "pen", "Drafts"),
        libRow("fav", "star", "Favorites"),
        h("div.lsec", null, h("span", { text: "Filters" })),
        libRow("attention", "funnel", "Needs attention", { badge: true }),
        libRow("running", "funnel", "Running & queued"),
        libRow("marks", "funnel", "Marked passages")
      );
      D.workspaces.forEach(function (w) {
        var collapsed = st.wsCollapsed[w.id];
        sc.append(h("button.lsec", {
          class: st.place === "ws:" + w.id ? "on" : null, title: w.dir,
          onclick: function () { go("ws:" + w.id); }
        }, h("span.tw", { onclick: function (e) { e.stopPropagation(); st.wsCollapsed[w.id] = !collapsed; renderLib(); } }, ic(collapsed ? "chevR" : "chevD")),
          h("span", { text: w.name }), h("span.dir", { text: w.dir })));
        if (collapsed) return;
        var fs = D.folders.filter(function (f) { return f.workspaceId === w.id; });
        fs.forEach(function (f) { sc.append(libRow("g:" + f.id, "group", f.name)); });
        if (D.notes.some(function (n) { return n.workspaceId === w.id; })) sc.append(libRow("notes:" + w.id, "note", "Notes"));
        if (!fs.length && !D.notes.some(function (n) { return n.workspaceId === w.id; })) {
          sc.append(h("div.lhint", { text: "No groups yet" }));
        }
      });
      sc.append(h("div.lsec", null, h("span", { text: "Session" })),
        libRow("guide", "book", "Getting Started", { count: GUIDE.length }),
        libRow("archive", "archive", "Archive"));
      var ready = D.agents.filter(function (a) { return a.ok; }).length;
      var foot = h("div.lfoot", null,
        h("button.tbtn", { title: "New group or workspace", onclick: function (e) { openNewMenu(e.currentTarget); } }, ic("plus")),
        h("button.tbtn", { title: "New filter", onclick: function () { toast("Filters are saved searches. Click a keyword to try one."); } }, ic("funnel")),
        h("button.agents" + (ready < D.agents.length ? ".warn" : ""), { title: "Agent status", onclick: function () { go("guide", ["g1"]); } },
          h("i"), ready === D.agents.length ? "Agents ready" : ready + " of " + D.agents.length + " agents"),
        h("button.tbtn", { title: "Settings (⌘,)", onclick: function () { toast("Settings: appearance, editor font, text size and agents."); } }, ic("gear")));
      libEl.replaceChildren(h("div.tb", null, lights()), sc, foot);
    }
    function openNewMenu(anchor) {
      var r = relRect(anchor);
      showPop(h("div.pop", { style: "left:" + r.left + "px;bottom:" + (800 - r.top + 4) + "px" },
        mi("group", "New group", "⌥⌘N", function () { newGroup(); }),
        mi("drive", "New workspace…", null, function () { newWorkspace(); }),
        h("div.msep"),
        mi("compose", "New question", "⌘N", function () { newSheet(); }),
        mi("doc", "Import .md report…", null, function () { toast("Choose a .md file, then enter the prompt that generated it."); })));
    }
    function newGroup() {
      var ws = currentWs() || D.workspaces[0].id;
      var f = { id: "f-new" + (++uid), workspaceId: ws, name: "Untitled group" };
      D.folders.push(f);
      go("g:" + f.id);
      toast("Group created in " + wsName(ws) + ". Drag sheets onto it, or ask from it.");
    }
    function newWorkspace() {
      var w = { id: "ws-new" + (++uid), name: "Untitled workspace", dir: "~/research/untitled" };
      D.workspaces.push(w);
      st.lib = true;
      go("ws:" + w.id);
    }
    function currentWs() {
      var p = st.place, k = p.split(":")[0], arg = p.slice(k.length + 1);
      if (k === "ws" || k === "notes") return arg;
      if (k === "g") { var f = D.folders.find(function (x) { return x.id === arg; }); return f && f.workspaceId; }
      var s = sheet(st.sel[0]);
      return (s && s.ws) || (D.workspaces[0] && D.workspaces[0].id);
    }

    /* ============================================================== sheet list */
    function sheetRow(id, glued, compact) {
      var s = sheet(id);
      if (!s) return null;
      var on = st.sel.indexOf(id) >= 0;
      var t = s.type === "thread" ? s.o : null;
      var title = s.type === "draft" ? strip(s.o.prompt) : s.title;
      var excerpt;
      if (t) excerpt = t.recap || strip(rootOf(t).question);
      else if (s.type === "note") excerpt = s.o.outline.map(function (o) { return o.text; }).join(" · ");
      else if (s.type === "guide") excerpt = s.o.excerpt;
      else if (s.type === "new") excerpt = "Type a question in the editor and press Return.";
      var icon = s.type === "note" ? "note" : s.type === "guide" ? "book" : t && t.kind === "post" ? "link" : t && t.kind === "document" ? "doc" : null;
      var status = t ? threadStatus(t) : null;
      var row = h("div.row", {
        class: on ? "on" : null, tabindex: compact ? null : "0", "data-sheet": id,
        onclick: function (e) { pickSheet(id, e.metaKey || e.ctrlKey || e.shiftKey); }
      },
        t && t.unread ? h("span.ud", { title: "Unread answer" }) : null,
        glued && on ? h("span.gl") : null,
        h("div.t", null, icon ? ic(icon, "sm") : null,
          s.type === "draft" ? h("span.tt", null, h("span.draftlbl", { text: "Draft" }), title) : h("span.tt", { text: title }),
          glyph(status)),
        s.type === "draft" ? null : excerpt ? h("div.x", { text: excerpt }) : null,
        compact ? null : h("div.m", null,
          s.updated ? h("span.d", { text: fmtDate(s.updated) }) : null,
          s.type === "draft" ? h("span.d", { text: provider(s.o.provider).label + " · " + s.o.model }) : null,
          (s.tags || []).slice(0, 3).map(function (k) { return h("span.kw", { text: k }); }),
          s.tags && s.tags.length > 3 ? h("span", { text: "+" + (s.tags.length - 3) }) : null));
      return row;
    }
    function allMarks() {
      var out = [];
      D.threads.forEach(function (t) {
        t.turns.forEach(function (u) { u.highlights.forEach(function (hl) { out.push({ hl: hl, t: t, u: u }); }); });
      });
      return out.sort(function (a, b) { return a.hl.createdAt < b.hl.createdAt ? 1 : -1; });
    }
    function renderList() {
      listEl.style.display = st.list ? "" : "none";
      if (!st.list) return;
      var prev = listEl.querySelector(".rows");
      var keep = prev ? prev.scrollTop : 0;
      var info = placeInfo(st.place);
      var count = st.place === "marks" ? allMarks().length : placeSheets(st.place).length;
      var tb = h("div.tb", null,
        firstPane() === "list" ? lights() : null,
        h("div.lhead", null, h("b", { text: info.title }), h("span", { text: count ? plural(count, st.place === "marks" ? "passage" : "sheet") : info.sub })),
        h("button.tbtn", { title: "Sort by date changed", onclick: function () { toast("Sorted by date changed. Drag to sort by hand."); } }, ic("sort")),
        h("button.tbtn", { title: "New question (⌘N)", onclick: function () { newSheet(); } }, ic("compose")));
      var rows = h("div.rows");
      if (st.place === "marks") {
        allMarks().forEach(function (m) {
          rows.append(h("div.row.hlrow", { onclick: function () { openMark(m.t.id, m.u.id, m.hl.id); } },
            h("div.q", null, h("span", { class: "hl-" + m.hl.color, text: m.hl.quote.replace(/`/g, "") })),
            m.hl.note ? h("div.n", { text: m.hl.note }) : null,
            h("div.m", null, h("span.d", { text: fmtDate(m.hl.createdAt) }), h("span", { text: m.t.title, style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }))));
        });
      } else {
        var L = placeSheets(st.place);
        var glued = st.sel.length > 1;
        L.forEach(function (id) { rows.append(sheetRow(id, glued)); });
        if (!L.length) rows.append(emptyList());
      }
      var kids = [tb];
      if (info.query) kids.push(h("div.query", null, ic("funnel", "sm"), h("span", { text: info.query })));
      kids.push(rows);
      if (st.sel.length > 1) kids.push(h("div.lfootbar", null, ic("glue", "sm"), h("span.grow", { text: st.sel.length + " sheets shown glued" }),
        h("button.btn.sm", { onclick: function () { st.sel = st.sel.slice(0, 1); renderAll(); } }, "Unglue")));
      listEl.replaceChildren.apply(listEl, kids);
      rows.scrollTop = keep;
      revealRow(rows);
    }
    function revealRow(rows) {
      rows = rows || listEl.querySelector(".rows");
      var on = rows && rows.querySelector(".row.on");
      if (!on) return;
      if (on.offsetTop + on.offsetHeight > rows.scrollTop + rows.clientHeight || on.offsetTop < rows.scrollTop) rows.scrollTop = Math.max(0, on.offsetTop - 80);
    }
    function emptyList() {
      var k = st.place.split(":")[0];
      var msg = {
        fav: "Mark a sheet as a favorite with the star in its heading row.",
        drafts: "Questions you save without sending appear here.",
        archive: "Archived sheets are read-only and appear here.",
        attention: "Nothing needs you. Unread answers, failed runs and agent questions appear here.",
        running: "No runs are active."
      }[k] || "Ask a question to start a sheet here.";
      return h("div.empty", null, h("b", { text: "No sheets" }), msg,
        (k === "ws" || k === "g" || k === "inbox" || k === "notes") ? h("div", { style: "margin-top:14px;display:flex;gap:8px;justify-content:center" },
          h("button.btn.pri", { onclick: function () { newSheet(); } }, ic("compose", "sm"), "New question"),
          h("button.btn", { onclick: function () { toast("Choose a .md file, then enter the prompt that generated it."); } }, "Import .md…")) : null);
    }
    function pickSheet(id, multi) {
      if (multi && sheet(id) && sheet(id).type !== "new") {
        var i = st.sel.indexOf(id);
        if (i >= 0) { if (st.sel.length > 1) st.sel.splice(i, 1); }
        else st.sel.push(id);
      } else {
        if (st.sel.length === 1 && st.sel[0] === id) return;
        st.sel = [id];
        resetComposer();
      }
      var s = sheet(st.sel[0]);
      st.section = s && s.type === "thread" ? defaultSection(s.o) : null;
      if (s && s.type === "thread" && s.o.unread && st.sel.length === 1) s.o.unread = false;
      closePop();
      renderAll(true);
    }
    function resetComposer() {
      st.comp.mode = "followup"; st.comp.anchor = null; st.comp.text = "";
      var s = sheet(st.sel[0]);
      if (s && s.type === "thread") {
        var last = chainEnd(s.o, rootOf(s.o));
        st.comp.provider = last.provider; st.comp.model = last.model; st.comp.effort = last.effort;
      } else if (s && s.type === "draft") {
        st.comp.provider = s.o.provider; st.comp.model = s.o.model; st.comp.text = s.o.prompt;
        st.comp.effort = provider(s.o.provider).efforts.length ? "high" : null;
      }
    }
    function go(place, sel) {
      st.place = place;
      var L = placeSheets(place);
      if (sel) st.sel = sel;
      else if (place === "marks") { /* keep editor */ }
      else if (L.length && L.indexOf(st.sel[0]) < 0) st.sel = [L[0]];
      else if (!L.length) st.sel = [];
      var s = sheet(st.sel[0]);
      st.section = s && s.type === "thread" ? defaultSection(s.o) : null;
      resetComposer();
      closePop();
      renderAll(true);
    }

    /* ================================================================== editor */
    function tbtn(icon, title, onclick, on) { return h("button.tbtn", { class: on ? "on" : null, title: title, "aria-label": title, onclick: onclick }, ic(icon)); }
    function renderEditor(resetScroll) {
      var oldScroll = edEl.querySelector(".ed-scroll");
      var keep = oldScroll && !resetScroll ? oldScroll.scrollTop : 0;
      var active = document.activeElement;
      var hadFocus = active && active.classList && active.classList.contains("cta") && root.contains(active);
      var s = sheet(st.sel[0]);
      var loc = "";
      if (st.sel.length > 1) loc = st.sel.length + " sheets glued";
      else if (s && s.type === "thread") loc = wsName(s.o.workspaceId) + " › " + (s.o.folderId ? folderName(s.o.folderId) : "Inbox");
      else if (s && s.type === "note") loc = wsName(s.o.workspaceId) + " › Notes";
      else if (s && s.type === "guide") loc = "Getting Started";
      else if (s && s.type === "draft") loc = wsName(s.o.workspaceId) + " › Drafts";
      var tb = h("div.tb", null,
        firstPane() === "ed" ? lights() : null,
        tbtn("sidebar", st.lib ? "Hide library (⌘2)" : "Show library (⌘1)", function () { setPanes(st.lib ? (st.list ? 2 : 3) : 1); }, false),
        !st.list ? tbtn("list", "Sheets in " + placeInfo(st.place).title, function (e) { openSheetPop(e.currentTarget); }, false) : null,
        h("div.loc.grow", { text: loc }),
        tbtn("type", "Typewriter mode", function () { st.typewriter = !st.typewriter; renderEditor(); if (st.typewriter) centerSelected(); }, st.typewriter),
        tbtn("search", "Quick open (⌘O)", function () { openQuick(); }),
        h("span.tsep"),
        tbtn("outline", "Dashboard: outline and statistics", function () { togglePane("dashboard"); }, st.att && st.tab === "dashboard"),
        tbtn("clip", "Attachments: keywords, links, marks, sources", function () { togglePane("attachments"); }, st.att && st.tab === "attachments"),
        tbtn("activity", "Run: agent, model and trace", function () { togglePane("run"); }, st.att && st.tab === "run"),
        tbtn("share", "Export preview", function () { openExport(); }));
      var scroll = h("div.ed-scroll");
      var doc = h("div.doc", { class: st.typewriter ? "tw" : null });
      scroll.appendChild(doc);
      scroll.addEventListener("mouseup", onSelectText);
      scroll.addEventListener("scroll", function () { if (st.pop && st.pop.kind === "sel") closePop(); });
      if (st.sel.length > 1) docGlued(doc);
      else if (!s) docEmpty(doc);
      else if (s.type === "thread") docThread(doc, s.o, cfg.composer === "inline");
      else if (s.type === "note") docNote(doc, s.o);
      else if (s.type === "guide") docGuide(doc, s.o);
      else if (s.type === "draft" || s.type === "new") docNew(doc, s);
      var kids = [tb, scroll];
      if (cfg.composer === "dock" && s && s.type === "thread" && st.sel.length === 1 && !s.o.archivedAt) kids.push(h("div.dock", null, h("div.dbox", null, composerBody(s.o, true))));
      edEl.replaceChildren.apply(edEl, kids);
      scroll.scrollTop = keep;
      if (hadFocus) focusComposer();
    }
    function setPanes(n) {
      st.lib = n === 1; st.list = n <= 2;
      renderAll();
    }
    function togglePane(tab) {
      if (st.att && st.tab === tab) st.att = false;
      else { st.att = true; st.tab = tab; }
      renderEditor(); renderAttach();
    }
    function docEmpty(doc) {
      var info = placeInfo(st.place);
      doc.append(h("div.h1", null, h("span.hang", { text: "#" }), "Nothing in “" + info.title + "” yet"),
        h("div.sub", null, h("span", { text: info.sub })),
        h("div.gs", null,
          h("p", { text: "Ask a question to start a sheet here. The answer streams into the sheet; follow-ups and branches are added to it as sections." })),
        composerInline(null));
    }
    function subLine(t) {
      var bits = [];
      bits.push(h("span", { text: wsName(t.workspaceId) + " › " + (t.folderId ? folderName(t.folderId) : "Inbox") }));
      bits.push(h("span.sep", { text: "·" }));
      var n = t.turns.length, br = t.turns.filter(function (u) { return u.relation === "branch"; }).length;
      bits.push(h("span", { text: plural(n, "section") + (br ? ", " + plural(br, "branch", "branches") : "") }));
      bits.push(h("span.sep", { text: "·" }));
      bits.push(h("span", { text: "Updated " + fmtDate(t.updatedAt) }));
      if (t.tags.length) bits.push(h("span.sep", { text: "·" }));
      t.tags.forEach(function (k) { bits.push(h("button.kw", { title: "Show all sheets with this keyword", onclick: function () { go("kw:" + k); } }, k)); });
      return h("div.sub", null, bits);
    }
    function docThread(doc, t, withComposer) {
      doc.append(h("div.h1", null, h("span.hang", { text: "#" }), t.title), subLine(t));
      if (t.recap) doc.append(h("div.comment", null, h("span.lab", { text: "Recap" }), t.recap));
      renderChain(doc, t, rootOf(t), 2);
      if (t.archivedAt) doc.append(h("div.qline", null, ic("archive", "sm"), "Archived " + fmtDate(t.archivedAt) + ". Unarchive to ask follow-ups or branch.",
        h("button.btn.sm", { style: "margin-left:auto", onclick: function () { t.archivedAt = null; go("all", [t.id]); toast("Unarchived."); } }, "Unarchive")));
      else if (withComposer) doc.append(composerInline(t));
    }
    function renderChain(container, t, head, level) {
      for (var u = head; u; u = followOf(t, u)) container.appendChild(renderSection(t, u, level));
    }
    function agentDot(pid) { return h("i.agdot", { style: "background:var(--c-" + pid + ")" }); }
    function metaLine(u) {
      var p = provider(u.provider);
      var bits = [h("span.ag", null, agentDot(u.provider), p.label + " · " + u.model + (u.effort ? " · " + u.effort : ""))];
      if (u.durationSec != null) bits.push(h("span.sep", { text: "·" }), h("span", { text: fmtDur(u.durationSec) }));
      bits.push(h("span.sep", { text: "·" }), h("span", { text: fmtLong(u.completedAt || u.createdAt) }));
      if (u.relation === "followup") bits.push(h("span.sep", { text: "·" }), h("span", { text: "Follow-up" }));
      if (u.starred) bits.push(ic("star", "sm"));
      var p2 = pill(u.status);
      if (p2) bits.push(p2);
      return h("div.meta", null, bits);
    }
    function renderSection(t, u, level) {
      var sec = h("section.sec", { "data-turn": u.id, class: st.section === u.id ? "sel" : null });
      var isDocRoot = t.kind === "document" && u.relation === "root";
      if (u.post) {
        sec.append(h("div.linkcard", null, h("div.fav", { text: u.post.domain.charAt(0).toUpperCase() }),
          h("div", null, h("b", { text: u.post.linkTitle }), h("span", { text: u.post.author + " · " + u.post.domain + " · saved " + fmtDate(u.createdAt) }))));
      } else if (isDocRoot) {
        sec.append(h("div.comment", null, h("span.lab", { text: "Imported report · prompt that generated it" }), strip(u.question)));
      } else {
        var hr = h("div.hrow", { onclick: function (e) { if (e.target.closest(".hacts")) return; selectSection(u.id); } },
          h("span.hang", { text: "#".repeat(level) }),
          h("div.q.l" + level, null, inline(u.question)),
          h("div.hacts", null,
            h("button.tbtn", { class: u.starred ? "on" : null, title: u.starred ? "Remove star" : "Star this section", onclick: function () { u.starred = !u.starred; renderEditor(); renderAttach(); } }, ic("star", "sm")),
            h("button.tbtn", { title: "Branch from the whole answer", onclick: function () { startBranch(u, null); } }, ic("branch", "sm")),
            h("button.tbtn", { title: "More", onclick: function (e) { openSectionMenu(e.currentTarget, t, u); } }, ic("more", "sm"))));
        sec.append(hr, metaLine(u));
      }
      var marks = u.highlights.map(function (hl) { return { quote: hl.quote, cls: "hl hl-" + hl.color + (hl.note ? " note" : ""), id: hl.id, note: hl.note, p: hl.paragraph }; });
      var brs = branchesOf(t, u);
      if (st.comp.mode === "branch" && st.comp.anchor && st.comp.anchor.turnId === u.id) marks.push({ quote: st.comp.anchor.quote, cls: "anc", p: st.comp.anchor.paragraph });
      var paras = u._stream != null ? u.answer.slice(0, u._base || 0) : u.answer;
      paras.forEach(function (para, i) {
        var ms = marks.filter(function (m) { return m.p === i; });
        brs.forEach(function (b) { if (b.anchor && b.anchor.paragraph === i) ms.push({ quote: b.anchor.quote, cls: "anc", id: null }); });
        blocks(para, ms, i, u.id).forEach(function (n) { sec.appendChild(n); });
        brs.forEach(function (b) { if (b.anchor && b.anchor.paragraph === i) sec.appendChild(branchFold(t, b, level)); });
      });
      if (u.status === "running") {
        var lastPs = sec.querySelectorAll(":scope > p.ap");
        if (u._stream == null && lastPs.length) lastPs[lastPs.length - 1].appendChild(h("span.caret"));
        else sec.appendChild(h("p.ap.stream", { "data-stream": u.id }, u._stream || "", h("span.caret")));
        var last = u.activity[u.activity.length - 1];
        sec.appendChild(h("div.runline", null, h("span.spin"), h("span.lab", { "data-runlab": u.id, text: "Running · " + (last ? last.label : "starting") }),
          h("span", { "data-elapsed": u.id, text: elapsed(u) }),
          h("button.btn.sm", { onclick: function () { stopRun(t, u); } }, ic("stop", "sm"), "Stop")));
      } else if (u.status === "queued") {
        var prevU = D.U[u.parentId];
        sec.appendChild(h("div.qline", null, ic("clock", "sm"), h("span", { text: "Queued. Starts when “" + (prevU ? prevU.title : "the answer above") + "” finishes; a conversation runs one answer at a time." }),
          h("button.btn.sm", { style: "margin-left:auto", onclick: function () { t.turns.splice(t.turns.indexOf(u), 1); delete D.U[u.id]; st.section = defaultSection(t); renderAll(); toast("Removed from the queue."); } }, "Remove")));
      } else if (u.status === "failed") {
        sec.appendChild(h("div.err", null, h("b", { text: "Run failed after " + fmtDur(u.durationSec) }), h("div.e", { text: u.error }),
          h("div.acts", null, h("button.btn.sm", { onclick: function () { retry(t, u); } }, ic("retry", "sm"), "Retry"),
            h("button.btn.sm", { onclick: function () { st.section = u.id; st.att = true; st.tab = "run"; renderAll(); } }, "Show trace"))));
      } else if (u.status === "needs-review" && u.clarification) {
        sec.appendChild(h("div.clar", null, h("div.lab", null, ic("question", "sm"), provider(u.provider).label + " is waiting for your answer"),
          h("p", { text: u.clarification }),
          h("div.acts", null, h("button.btn.sm.pri", { onclick: function () { st.section = u.id; st.comp.mode = "followup"; renderEditor(); focusComposer(); } }, "Reply below"))));
      }
      brs.forEach(function (b) { if (!b.anchor || b.anchor.paragraph == null || b.anchor.paragraph >= paras.length) sec.appendChild(branchFold(t, b, level)); });
      if (u.sources.length) {
        sec.appendChild(h("div.srcline", null, h("span", { text: "Sources" }),
          u.sources.map(function (sr, i) { return h("span.src", { title: sr.title + "\n" + sr.url }, h("sup", { text: i + 1 }), sr.domain); })));
      }
      return sec;
    }
    function elapsed(u) {
      var start = Date.parse(u.createdAt), ms = NOW + (Date.now() - t0) - start;
      var s = Math.max(0, Math.round(ms / 1000));
      return Math.floor(s / 60) + ":" + pad(s % 60);
    }
    function branchFold(t, b, level) {
      var open = !!st.open[b.id];
      var n = countSections(t, b), ss = subtreeStatus(t, b);
      var wrap = h("div.branch", { "data-branch": b.id });
      wrap.appendChild(h("button.bhead", { "aria-expanded": String(open), onclick: function () { st.open[b.id] = !open; renderEditor(); renderAttach(); } },
        ic(open ? "chevD" : "chevR", "tw"), ic("branch", "sm bi"), h("span", { text: "Branch" }), h("b", { text: b.title }),
        h("span.bn", { text: "· " + plural(n, "section") }), b.starred ? ic("star", "sm st") : null, ss ? pill(ss) : null));
      if (!open) wrap.appendChild(h("div.bq", { text: strip(b.question) }));
      else { var body = h("div.bbody"); renderChain(body, t, b, level + 1); wrap.appendChild(body); }
      return wrap;
    }
    function selectSection(id) {
      st.section = id;
      if (st.comp.mode === "branch" && !st.comp.anchor) { /* branch from the whole answer follows selection */ }
      renderEditor(); renderAttach();
      if (st.typewriter) centerSelected();
    }
    function scrollToEl(el, center) {
      var sc = edEl.querySelector(".ed-scroll");
      if (!sc || !el) return;
      var r = relRect(el), R = relRect(sc);
      sc.scrollTop += center ? (r.top - R.top) - (R.height / 2 - 60) : (r.top - R.top) - 28;
    }
    function scrollToTurn(id, flash) {
      var el = edEl.querySelector('[data-turn="' + id + '"].sec');
      scrollToEl(el, false);
      if (flash && el) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
    }
    function centerSelected() {
      var el = edEl.querySelector(".sec.sel") || edEl.querySelector(".comp");
      if (el) scrollToEl(el, true);
    }
    function openSectionMenu(anchor, t, u) {
      var r = relRect(anchor);
      showPop(h("div.pop", { style: "left:" + (r.right - 220) + "px;top:" + (r.bottom + 4) + "px;width:220px" },
        mi("branch", "Branch from the whole answer", "⇧⌘↵", function () { startBranch(u, null); }),
        mi("copy", "Copy section as Markdown", null, function () { toast("Copied section as Markdown."); }),
        mi("activity", "Show run trace", null, function () { st.section = u.id; st.att = true; st.tab = "run"; renderAll(); }),
        mi("retry", "Run again", null, function () { retry(t, u); }),
        h("div.msep"),
        mi("star", u.starred ? "Remove star" : "Star this section", null, function () { u.starred = !u.starred; renderAll(); })));
    }

    /* ----- note documents */
    function docNote(doc, n, embedded) {
      doc.append(h("div.h1", null, h("span.hang", { text: "#" }), n.title),
        h("div.sub", null, h("span", { text: wsName(n.workspaceId) + " › Notes" }), h("span.sep", { text: "·" }), h("span", { text: "Updated " + fmtDate(n.updatedAt) }),
          h("span.sep", { text: "·" }), n.tags.map(function (k) { return h("button.kw", { onclick: function () { go("kw:" + k); } }, k); })));
      doc.append(outlineList(n.outline, n.id + ":"));
      if (!embedded) {
        var ta = h("textarea.cta", { rows: 1, placeholder: "Add an item", style: "font-weight:400;font-size:16.5px", "aria-label": "Add an item to this note",
          onkeydown: function (e) {
            if (e.key === "Enter" && !e.shiftKey && ta.value.trim()) { e.preventDefault(); n.outline.push({ text: ta.value.trim() }); n.updatedAt = nowISO(); renderEditor(); renderList(); var c = edEl.querySelector(".cta"); if (c) c.focus(); }
          } });
        doc.append(h("div.comp", { style: "margin-top:10px" }, h("div.crow", { style: "padding-left:0" }, h("span.hang", { text: "-", style: "top:.1em" }), ta),
          h("div.chelp", { text: "Return adds an item. Items can link to any section of any sheet; drag a section heading from the Dashboard to link it." })));
      }
    }
    function outlineList(items, keyPrefix) {
      var ul = h("ul.olist");
      items.forEach(function (it, i) {
        var key = keyPrefix + i, hasKids = it.children && it.children.length, collapsed = st.ocollapsed[key];
        var li = h("li.oli");
        li.appendChild(h("button.bul" + (hasKids ? ".has" : ""), { "aria-label": hasKids ? (collapsed ? "Expand" : "Collapse") : null, onclick: hasKids ? function () { st.ocollapsed[key] = !collapsed; renderEditor(); } : null },
          hasKids ? ic(collapsed ? "chevR" : "chevD") : "-"));
        var ref = it.ref ? refChip(it.ref) : null;
        li.appendChild(h("div.ot", null, h("span", null, inline(it.text)), ref));
        if (hasKids && !collapsed) li.appendChild(outlineList(it.children, key + "."));
        ul.appendChild(li);
      });
      return ul;
    }
    function refChip(ref) {
      var t = D.T[ref.threadId];
      if (!t) return null;
      var u = ref.turnId ? D.U[ref.turnId] : null;
      return h("button.ref", { title: t.title + (u ? " › " + u.title : ""), onclick: function () { openRef(ref.threadId, ref.turnId); } },
        "→ " + (u ? u.title : t.title.length > 28 ? t.title.slice(0, 26) + "…" : t.title));
    }
    function openRef(threadId, turnId) {
      var t = D.T[threadId];
      if (!t) return;
      st.sel = [threadId];
      resetComposer();
      st.section = turnId || defaultSection(t);
      if (turnId) openAncestors(D.U[turnId]);
      if (placeSheets(st.place).indexOf(threadId) < 0) st.place = t.archivedAt ? "archive" : "all";
      renderAll(true);
      if (turnId) scrollToTurn(turnId, true);
    }
    function openMark(threadId, turnId, markId) {
      openRef(threadId, turnId);
      var el = edEl.querySelector('[data-mark="' + markId + '"]');
      if (el) { scrollToEl(el, true); var sec = el.closest(".sec"); if (sec) { sec.classList.add("flash"); } }
    }

    /* ----- guide and new sheets */
    function docGuide(doc, g) {
      doc.append(h("div.h1", null, h("span.hang", { text: "#" }), g.title), h("div.sub", null, h("span", { text: "Getting Started · " + (GUIDE.indexOf(g) + 1) + " of " + GUIDE.length })));
      var gs = h("div.gs");
      g.blocks.forEach(function (b) {
        if (b.p) gs.append(h("p", null, inline(b.p)));
        else if (b.h2) gs.append(h("h2", null, h("span.hang", { text: "##" }), b.h2));
        else if (b.li) gs.append(h("ul", null, b.li.map(function (x) { return h("li", null, inline(x)); })));
        else if (b.diag) gs.append(h("div.diag", { text: b.diag }));
        else if (b.small) gs.append(h("p.small", { text: b.small }));
        else if (b.next) gs.append(h("p", null, h("button.next", { onclick: function () { pickSheet(b.next); } }, "Next: " + GUIDE_BY[b.next].title + " →")));
        else if (b.agents) gs.append(agentTable());
        else if (b.composer) gs.append(composerInline(null, true));
      });
      doc.append(gs);
    }
    function agentTable() {
      return h("div.agt", null, D.agents.map(function (a) {
        return h("div.arow", null, agentDot(a.id), h("b", { text: a.label }),
          h("span.s" + (a.ok ? ".ok" : ""), null, a.ok ? "✓ " + a.detail : a.detail),
          a.cmd ? h("code", { text: a.cmd }) : null,
          a.cmd ? h("button.btn.sm", { onclick: function () { a.ok = true; a.detail = "Ready"; delete a.cmd; renderEditor(); renderLib(); toast("Grok is ready."); } }, "Copy and check") : null);
      }));
    }
    function docNew(doc, s) {
      var isDraft = s.type === "draft";
      doc.append(h("div.h1.ph", null, h("span.hang", { text: "#" }), isDraft ? "Draft" : "New question"),
        h("div.sub", null, h("span", { text: (wsName(s.ws) || "Inbox") + (isDraft ? " › Drafts · saved " + fmtDate(s.updated) : " › " + placeInfo(st.place).title) })),
        composerInline(null));
    }

    /* ----- glued view */
    function docGlued(doc) {
      var total = 0;
      st.sel.forEach(function (id) { var s = sheet(id); if (s && s.type === "thread") total += threadWords(s.o); else if (s && s.type === "note") total += noteWords(s.o); });
      doc.append(h("div.gluebar", null, ic("glue"), h("b", { text: st.sel.length + " sheets glued" }), h("span", { text: "· " + fmtN(total) + " words" }), h("span.grow"),
        h("button.btn.sm", { onclick: saveSynthesis }, "Save as note"),
        h("button.btn.sm", { onclick: openExport }, ic("share", "sm"), "Export…")));
      st.sel.forEach(function (id, i) {
        var s = sheet(id);
        if (!s) return;
        if (i > 0) doc.append(h("div.seam", { text: "glued" }));
        var part = h("div", { "data-glued": id });
        if (s.type === "thread") docThread(part, s.o, false);
        else if (s.type === "note") docNote(part, s.o, true);
        else if (s.type === "guide") docGuide(part, s.o);
        doc.append(part);
      });
    }
    function noteWords(n) { var c = 0; (function w(items) { items.forEach(function (it) { c += words(it.text); if (it.children) w(it.children); }); })(n.outline); return c; }
    function saveSynthesis() {
      var items = [];
      st.sel.forEach(function (id) {
        var s = sheet(id);
        if (!s || s.type !== "thread") return;
        var kids = [];
        s.o.turns.forEach(function (u) { if (u.status === "done" && !u.post) kids.push({ text: u.title, ref: { threadId: s.o.id, turnId: u.id } }); });
        items.push({ text: s.o.title, ref: { threadId: s.o.id }, children: kids });
      });
      var ws = sheet(st.sel[0]).ws || currentWs();
      var n = { id: "n-new" + (++uid), workspaceId: ws, title: "Synthesis: " + items.map(function (i) { return i.text.split(" ")[0]; }).join(", "), updatedAt: nowISO(), tags: ["synthesis"], outline: items };
      D.notes.push(n); D.N[n.id] = n;
      st.place = "notes:" + ws; st.sel = [n.id];
      renderAll(true);
      toast("Saved as a note with links to " + plural(items.length, "sheet") + ".");
    }

    /* ================================================================ composer */
    function composerTargetTurn(t) {
      var u = D.U[st.section];
      if (!u || u.threadId !== t.id) u = rootOf(t);
      return u;
    }
    function composerInline(t, firstRun) {
      var wrap = h("div.comp", { style: firstRun ? "margin-top:8px" : null });
      add(wrap, [composerBody(t, false, firstRun)]);
      return wrap;
    }
    function composerBody(t, docked, firstRun) {
      var c = st.comp;
      var kids = [];
      var target = t ? composerTargetTurn(t) : null;
      var review = target && chainEnd(t, chainHead(target) || target).status === "needs-review";
      if (t && c.mode === "branch") {
        kids.push(h("div.cquote", null, c.anchor ? h("span", null, inline(c.anchor.quote)) : h("span", { text: "Whole answer of “" + target.title + "”" }),
          h("button.tbtn.x", { title: "Cancel branch", onclick: function () { c.mode = "followup"; c.anchor = null; renderEditor(); focusComposer(); } }, ic("x", "sm"))));
      }
      var ph = !t ? (firstRun ? "Ask a question about your code, a paper or a bug" : "Ask a question")
        : c.mode === "branch" ? "Ask in a new branch"
          : review ? "Reply to the question above" : "Ask a follow-up";
      var ta = h("textarea.cta", { rows: 1, placeholder: ph, "aria-label": ph, value: c.text,
        oninput: function () { c.text = ta.value; autosize(ta); syncSend(); },
        onkeydown: function (e) {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); }
          else if (e.key === "Escape") { ta.blur(); }
        } });
      kids.push(h("div.crow", null, docked ? null : h("span.hang", { text: t ? "#".repeat(Math.min(5, levelFor(t, target, c.mode))) : "##" }), ta));
      var bar = h("div.cbar");
      if (t) {
        bar.append(h("div.seg", { role: "group", "aria-label": "Question type" },
          h("button", { class: c.mode === "followup" ? "on" : null, title: "Continue the conversation; the agent sees every section above.", onclick: function () { c.mode = "followup"; c.anchor = null; renderEditor(); focusComposer(); } }, "Follow-up"),
          h("button", { class: c.mode === "branch" ? "on" : null, title: "Start a side line of questioning; the main conversation is unchanged.", onclick: function () { c.mode = "branch"; renderEditor(); focusComposer(); } }, ic("branch", "sm"), "Branch")));
        var end = c.mode === "branch" ? (c.anchor ? D.U[c.anchor.turnId] : target) : chainEnd(t, target);
        bar.append(h("span.tgt", { text: (c.mode === "branch" ? "from “" : "after “") + end.title + "”" }));
      } else {
        bar.append(h("span.tgt", { text: "New sheet in " + (st.place.indexOf("g:") === 0 ? placeInfo(st.place).title : "Inbox") }));
      }
      var p = provider(c.provider);
      add(bar, [h("span.grow"),
        h("button.mbtn", { title: "Agent, model and effort (⌃Tab)", onclick: function (e) { openModelMenu(e.currentTarget); } },
          agentDot(c.provider), p.label + " · " + c.model + (c.effort ? " · " + c.effort : ""), ic("chevD")),
        docked ? null : h("span.kbd", { text: "↵ Ask" }),
        h("button.sendb", { title: "Ask (↵)", "aria-label": "Ask", disabled: c.text.trim() ? null : true, onclick: ask }, ic("send", "sm"))]);
      kids.push(bar);
      var help = !t ? "The answer streams into a new sheet. Shift-Return adds a line."
        : c.mode === "branch" ? "A branch is folded under its passage and runs right away, next to the main conversation."
          : busy(t, chainEnd(t, target)) ? "An answer is running in this conversation. This question will wait in the queue and start when it finishes."
            : "A follow-up continues this conversation. Select text in an answer to branch from it instead.";
      if (!docked) kids.push(h("div.chelp", { text: help }));
      later(function () { autosize(ta); }, 0);
      return kids;
    }
    function levelFor(t, target, mode) {
      var lvl = 2, x = mode === "branch" ? target : chainHead(chainEnd(t, target));
      if (mode === "branch") lvl++;
      while (x && x.relation !== "root") { var hd = chainHead(x); if (hd && hd.relation === "branch") lvl++; x = hd ? D.U[hd.parentId] : null; }
      return lvl;
    }
    function busy(t, end) { return end.status === "running" || end.status === "queued"; }
    function autosize(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }
    function syncSend() { edEl.querySelectorAll(".sendb").forEach(function (b) { if (st.comp.text.trim()) b.removeAttribute("disabled"); else b.setAttribute("disabled", ""); }); }
    function focusComposer() {
      var ta = edEl.querySelector(".cta");
      if (ta) { ta.focus({ preventScroll: cfg.composer === "dock" }); var n = ta.value.length; ta.setSelectionRange(n, n); }
    }
    function startBranch(u, anchor) {
      st.section = u.id;
      st.comp.mode = "branch";
      st.comp.anchor = anchor;
      closePop();
      renderEditor(); renderAttach();
      focusComposer();
      var c = edEl.querySelector(".comp, .dock");
      if (c && cfg.composer !== "dock") scrollToEl(c, true);
    }
    function openModelMenu(anchor) {
      var r = relRect(anchor), c = st.comp, p = provider(c.provider);
      var col = function (title, items) { return h("div.col", null, h("div.mh", { text: title }), items); };
      var pop = h("div.pop.modelpop", { style: "left:" + Math.min(r.left, 1280 - 430) + "px;" + (r.top > 400 ? "bottom:" + (800 - r.top + 6) + "px" : "top:" + (r.bottom + 6) + "px") },
        col("Agent", D.providers.map(function (pp) {
          var a = D.agents.find(function (x) { return x.id === pp.id; });
          return mi(null, pp.label, a && !a.ok ? "sign in" : null, function () { c.provider = pp.id; c.model = pp.models[0]; c.effort = pp.efforts.length ? (pp.efforts.indexOf("high") >= 0 ? "high" : pp.efforts[0]) : null; reopen(); }, pp.id === c.provider);
        })),
        col("Model", p.models.map(function (m) { return mi(null, m, null, function () { c.model = m; reopen(); }, m === c.model); })),
        col("Effort", p.efforts.length ? p.efforts.map(function (ef) { return mi(null, ef, null, function () { c.effort = ef; reopen(); }, ef === c.effort); }) : [h("div.mh", { text: "Not offered", style: "font-weight:400" })]));
      function reopen() { renderEditor(); var b = edEl.querySelector(".mbtn"); if (b) openModelMenu(b); }
      showPop(pop);
    }

    /* ----- asking and runs */
    function ask() {
      var text = st.comp.text.trim();
      if (!text) return;
      var s = sheet(st.sel[0]);
      var c = st.comp;
      if (!s || s.type !== "thread" || st.sel.length > 1) {
        var ws = (s && s.ws) || currentWs() || D.workspaces[0].id;
        var folder = st.place.indexOf("g:") === 0 ? st.place.slice(2) : null;
        var id = "tn" + (++uid), tid = id + "q1";
        var t = {
          id: id, workspaceId: ws, folderId: folder, kind: "exchange", title: titleFrom(text), provider: c.provider, model: c.model, effort: c.effort,
          status: "running", createdAt: nowISO(), updatedAt: nowISO(), lastViewedAt: null, unread: false, bookmarked: false, followed: false, archivedAt: null,
          recap: null, tags: [], links: [], rootTurnId: tid, turns: []
        };
        var u0 = newTurn(tid, null, "root", text, c);
        t.turns.push(u0);
        D.threads.unshift(t); D.T[id] = t; u0.threadId = id; D.U[tid] = u0;
        if (s && s.type === "draft") { D.drafts.splice(D.drafts.indexOf(s.o), 1); delete D.Dr[s.id]; }
        st.newSheet = null;
        var keepPlace = folder || st.place === "inbox" || st.place === "all" || st.place === "ws:" + ws;
        if (!keepPlace) st.place = "inbox";
        st.sel = [id]; st.section = tid;
        c.text = "";
        renderAll(true);
        simulate(t, u0);
        focusComposer();
        return;
      }
      var th = s.o, target = composerTargetTurn(th), parent, rel = "followup", anchor = null;
      if (c.mode === "branch") { parent = c.anchor ? D.U[c.anchor.turnId] : target; rel = "branch"; anchor = c.anchor ? { turnId: c.anchor.turnId, paragraph: c.anchor.paragraph, quote: c.anchor.quote } : null; }
      else parent = chainEnd(th, target);
      var nid = th.id + "x" + (++uid);
      var u = newTurn(nid, parent.id, rel, text, c);
      u.anchor = anchor;
      u.threadId = th.id;
      var queued = rel === "followup" && (parent.status === "running" || parent.status === "queued");
      u.status = queued ? "queued" : "running";
      th.turns.push(u); D.U[nid] = u;
      th.updatedAt = nowISO();
      if (rel === "branch") { st.open[nid] = true; openAncestors(u); }
      st.section = nid;
      c.text = ""; c.mode = "followup"; c.anchor = null;
      renderAll();
      scrollToTurn(nid, true);
      if (!queued) simulate(th, u);
      else toast("Queued. It starts when the running answer finishes.");
      focusComposer();
    }
    function titleFrom(text) {
      var w = strip(text).replace(/[?.!]+$/, "").split(" ");
      var s = w.slice(0, 7).join(" ");
      return (w.length > 7 ? s + "…" : s).replace(/^./, function (ch) { return ch.toUpperCase(); });
    }
    function newTurn(id, parentId, rel, text, c) {
      return {
        id: id, parentId: parentId, relation: rel, anchor: null, question: text, title: titleFrom(text),
        provider: c.provider, model: c.model, effort: c.effort, status: "running", createdAt: nowISO(), completedAt: null, durationSec: null,
        starred: false, recap: null, answer: [], error: null, sources: [], activity: [], highlights: []
      };
    }
    function genericScript(t, u) {
      var p = provider(u.provider).label;
      var prior = t.turns.filter(function (x) { return x.status === "done" && x !== u; }).length;
      return {
        steps: [
          { kind: "think", label: "Planned: answer from this sheet's sections, then check the workspace" },
          { kind: "grep", label: "Searched code: " + (strip(u.question).split(" ").filter(function (w) { return w.length > 5; })[0] || "query").toLowerCase(), detail: wsDir(t) + "  (3 matches)" },
          { kind: "read", label: "Read " + (prior ? prior + " earlier sections in this sheet" : "workspace README.md") }
        ],
        paras: [
          "This is a simulated answer in the design mock. In Session, " + p + " runs in the workspace directory (" + wsDir(t) + ") with " + u.model + (u.effort ? " at " + u.effort + " effort" : "") + ", and its text streams into this section as it is produced.",
          (u.relation === "branch" ? "Because this is a branch, the agent started from the context up to the passage you selected; the main conversation is unchanged. " : prior ? "The agent had the " + plural(prior, "earlier section") + " of this conversation as context. " : "") +
          "Tool calls, files read and commands run are listed in the Run tab of the attachments pane, and any web pages it cites appear under Sources."
        ]
      };
    }
    function wsDir(t) { var w = D.workspaces.find(function (x) { return x.id === t.workspaceId; }); return w ? w.dir : "~"; }
    function simulate(t, u, script) {
      script = script || CONTINUE[u.id] || genericScript(t, u);
      if (u.status === "queued" || !u.createdAt) u.createdAt = nowISO();
      u.status = "running";
      u._base = u.answer.length;
      u._stream = "";
      if (!u._started) u._started = Date.now();
      var delay = 0;
      script.steps.forEach(function (sp) {
        delay += 650;
        later(function () {
          u.activity.forEach(function (a) { if (a.status === "running") { a.status = "ok"; a.ms = a.ms || 900; } });
          u.activity.push({ kind: sp.kind, label: sp.label, detail: sp.detail, ms: 0, status: "running" });
          refreshRun(t, u);
        }, delay);
      });
      var text = script.paras.join("\n\n"), parts = text.split(/(\s+)/), i = 0;
      later(function tick() {
        if (u.status !== "running") return;
        i = Math.min(parts.length, i + 4);
        u._stream = parts.slice(0, i).join("");
        var el = edEl.querySelector('[data-stream="' + u.id + '"]');
        if (!el && sheet(st.sel[0]) && st.sel.indexOf(t.id) >= 0) { renderEditor(); el = edEl.querySelector('[data-stream="' + u.id + '"]'); }
        if (el) { el.textContent = u._stream; el.appendChild(h("span.caret")); }
        var ee = edEl.querySelector('[data-elapsed="' + u.id + '"]');
        if (ee) ee.textContent = elapsed(u);
        if (i < parts.length) later(tick, 45);
        else later(function () { finish(t, u, script.paras); }, 300);
      }, delay + 400);
      refreshRun(t, u);
    }
    function refreshRun(t, u) {
      var lab = edEl.querySelector('[data-runlab="' + u.id + '"]');
      var last = u.activity[u.activity.length - 1];
      if (lab && last) lab.textContent = "Running · " + last.label;
      if (st.att && st.tab === "run" && st.section === u.id) renderAttach();
    }
    function finish(t, u, paras) {
      u.activity.forEach(function (a) { if (a.status === "running") { a.status = "ok"; a.ms = a.ms || 1200; } });
      u.answer = u.answer.slice(0, u._base).concat(paras);
      delete u._stream; delete u._base;
      u.status = "done";
      u.completedAt = nowISO();
      u.durationSec = Math.max(1, Math.round((Date.parse(u.completedAt) - Date.parse(u.createdAt)) / 1000));
      t.updatedAt = u.completedAt;
      var focus = edEl.querySelector(".cta") === document.activeElement;
      renderAll();
      if (focus) focusComposer();
      var next = t.turns.find(function (x) { return x.parentId === u.id && x.status === "queued"; });
      if (next) later(function () { simulate(t, next); renderAll(); }, 700);
    }
    function stopRun(t, u) {
      u.status = "failed";
      u.error = "Stopped by you after " + elapsed(u) + ". The partial answer was kept.";
      if (u._stream) u.answer = u.answer.slice(0, u._base || 0).concat([u._stream]);
      delete u._stream;
      u.durationSec = Math.max(1, Math.round((Date.now() - (u._started || Date.now())) / 1000)) || 1;
      u.activity.forEach(function (a) { if (a.status === "running") a.status = "error"; });
      renderAll();
    }
    function retry(t, u) {
      u.error = null; u.answer = []; u.activity = []; u.createdAt = nowISO(); u.completedAt = null; u.durationSec = null; u._started = Date.now();
      closePop();
      simulate(t, u);
      renderAll();
    }

    /* ======================================================= attachments pane */
    function renderAttach() {
      attEl.style.display = st.att ? "" : "none";
      if (!st.att) return;
      var old = attEl.querySelector(".att-scroll"), keep = old ? old.scrollTop : 0;
      var tabs = [["dashboard", "Dashboard"], ["attachments", "Attachments"], ["run", "Run"]];
      var tb = h("div.tb", null, h("div.seg", { role: "tablist" }, tabs.map(function (tt) {
        return h("button", { role: "tab", "aria-selected": String(st.tab === tt[0]), class: st.tab === tt[0] ? "on" : null, onclick: function () { st.tab = tt[0]; renderAttach(); renderEditor(); } }, tt[1]);
      })));
      var sc = h("div.att-scroll");
      var s = sheet(st.sel[0]);
      if (st.tab === "dashboard") attDashboard(sc, s);
      else if (st.tab === "attachments") attAttachments(sc, s);
      else attRun(sc, s);
      attEl.replaceChildren(tb, sc);
      sc.scrollTop = keep;
    }
    function attDashboard(sc, s) {
      sc.append(h("div.ah", null, h("span", { text: "Outline" })));
      var rows = h("div");
      if (st.sel.length > 1) {
        st.sel.forEach(function (id) { var x = sheet(id); if (x) outlineSheet(rows, x, true); });
      } else if (s) outlineSheet(rows, s, false);
      sc.append(rows);
      var w = 0, secs = 0, br = 0, srcs = 0, mk = 0, runs = 0;
      st.sel.forEach(function (id) {
        var x = sheet(id);
        if (!x) return;
        if (x.type === "thread") {
          w += threadWords(x.o);
          x.o.turns.forEach(function (u) { secs++; if (u.relation === "branch") br++; srcs += u.sources.length; mk += u.highlights.length; runs += u.durationSec || 0; });
        } else if (x.type === "note") w += noteWords(x.o);
      });
      sc.append(h("div.ah", null, h("span", { text: "Statistics" })),
        h("div.stats", null,
          h("div", null, h("b", { text: fmtN(w) }), h("span", { text: "words" })),
          h("div", null, h("b", { text: secs }), h("span", { text: "sections" })),
          h("div", null, h("b", { text: br }), h("span", { text: "branches" })),
          h("div", null, h("b", { text: srcs }), h("span", { text: "sources" })),
          h("div", null, h("b", { text: mk }), h("span", { text: "marks" })),
          h("div", null, h("b", { text: Math.round(Math.max(w / 230, 1)) + " min" }), h("span", { text: "to read" }))));
      if (st.sel.length > 1 || (s && s.type === "note")) {
        var goal = 2500, pct = Math.min(1, w / goal);
        var ring = '<svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" fill="none" stroke="var(--line)" stroke-width="3.5"/><circle cx="18" cy="18" r="15" fill="none" stroke="var(--acc)" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="' + (94.25 * pct).toFixed(1) + ' 94.25" transform="rotate(-90 18 18)"/></svg>';
        var g = h("div.goal");
        g.innerHTML = ring;
        g.append(h("div", null, h("b", { text: "Goal: at most " + fmtN(goal) + " words" }), h("span", { text: fmtN(w) + " so far · " + Math.round(pct * 100) + "%" + (w > goal ? " · over by " + fmtN(w - goal) : "") })));
        sc.append(h("div.ah", null, h("span", { text: "Goal" })), g);
      } else if (s && s.type === "thread") {
        var f = threadFlag(s.o), lines = [];
        s.o.turns.forEach(function (u) { if (u.status !== "done") lines.push(u); });
        if (lines.length) {
          sc.append(h("div.ah", null, h("span", { text: "Needs you or running" })));
          lines.forEach(function (u) {
            sc.append(h("button.lrow2", { onclick: function () { openRef(s.o.id, u.id); } }, glyph(u.status), h("div", null, u.title, h("small", { text: (D.statuses[u.status] || {}).label + " · " + provider(u.provider).label + " " + u.model }))));
          });
        }
        void f;
      }
    }
    function outlineSheet(rows, s, glued) {
      var key = "o:" + s.id;
      if (s.type === "thread") {
        var t = s.o, collapsed = glued && st.ocollapsed[key];
        rows.append(h("button.orow.h1r", { onclick: function () { if (glued) { var el = edEl.querySelector('[data-glued="' + s.id + '"]'); scrollToEl(el, false); } else edEl.querySelector(".ed-scroll").scrollTop = 0; } },
          glued ? h("span.tw", { onclick: function (e) { e.stopPropagation(); st.ocollapsed[key] = !collapsed; renderAttach(); } }, ic(collapsed ? "chevR" : "chevD")) : h("span.tws"),
          h("span.lv", { text: "#" }), h("span.ot", { text: t.title }), h("span.wc", { text: fmtN(threadWords(t)) })));
        if (!collapsed) outlineChain(rows, t, rootOf(t), 2, 1);
      } else if (s.type === "note") {
        rows.append(h("button.orow.h1r", { onclick: function () { if (glued) scrollToEl(edEl.querySelector('[data-glued="' + s.id + '"]'), false); } }, h("span.tws"), h("span.lv", { text: "#" }), h("span.ot", { text: s.title }), h("span.wc", { text: fmtN(noteWords(s.o)) })));
        s.o.outline.forEach(function (it) { rows.append(h("div.orow", { style: "padding-left:16px" }, h("span.tws"), h("span.lv", { text: "-" }), h("span.ot", { text: strip(it.text) }))); });
      } else if (s.type === "guide") {
        rows.append(h("div.orow.h1r", null, h("span.tws"), h("span.lv", { text: "#" }), h("span.ot", { text: s.title })));
        s.o.blocks.forEach(function (b) { if (b.h2) rows.append(h("div.orow", { style: "padding-left:16px" }, h("span.tws"), h("span.lv", { text: "##" }), h("span.ot", { text: b.h2 }))); });
      } else rows.append(h("div.orow", null, h("span.tws"), h("span.ot", { text: "The outline fills in as you ask." })));
    }
    function outlineChain(rows, t, head, level, depth) {
      for (var u = head; u; u = followOf(t, u)) {
        (function (u) {
          var brs = branchesOf(t, u);
          var key = "b:" + u.id, collapsed = st.ocollapsed[key];
          var wc = words(u.question) + u.answer.reduce(function (a, p) { return a + words(p); }, 0);
          rows.append(h("button.orow", { class: st.section === u.id ? "on" : null, style: "padding-left:" + (depth * 12) + "px", title: strip(u.question),
            onclick: function () { st.section = u.id; openAncestors(u); renderEditor(); renderAttach(); scrollToTurn(u.id, true); } },
            brs.length ? h("span.tw", { role: "button", "aria-label": collapsed ? "Expand branches" : "Collapse branches", onclick: function (e) { e.stopPropagation(); st.ocollapsed[key] = !collapsed; renderAttach(); } }, ic(collapsed ? "chevR" : "chevD")) : h("span.tws"),
            h("span.lv", { text: "#".repeat(level) }), h("span.ot", { text: u.post ? "Saved link" : u.title }),
            u.status !== "done" ? glyph(u.status) : null,
            u.starred ? h("span", { style: "color:var(--acc);display:inline-flex" }, ic("star", "sm")) : null,
            h("span.wc", { text: wc ? fmtN(wc) : "" })));
          if (!collapsed) brs.forEach(function (b) { outlineChain(rows, t, b, level + 1, depth + 1); });
        })(u);
      }
    }
    function backlinks(id) {
      var out = [];
      D.threads.forEach(function (t) { if (t.id !== id && t.links.indexOf(id) >= 0) out.push({ kind: "thread", id: t.id, title: t.title }); });
      D.notes.forEach(function (n) {
        var hit = false;
        (function w(items) { items.forEach(function (it) { if (it.ref && it.ref.threadId === id) hit = true; if (it.children) w(it.children); }); })(n.outline);
        if (hit) out.push({ kind: "note", id: n.id, title: n.title });
      });
      return out;
    }
    function attAttachments(sc, s) {
      if (!s || (s.type !== "thread" && s.type !== "note")) { sc.append(h("div.empty", null, h("b", { text: "No attachments" }), "Keywords, links, marks and sources of a sheet appear here.")); return; }
      if (st.sel.length > 1) sc.append(h("div.ainfo", { text: "Showing attachments of “" + s.title + "”, the first of " + st.sel.length + " glued sheets." }));
      var tags = s.o.tags;
      var chips = h("div.chips", null, tags.map(function (k) { return h("button.kw", { title: "Show all sheets with this keyword", onclick: function () { go("kw:" + k); } }, k); }));
      if (st.addingKw) {
        var inp = h("input", { placeholder: "keyword", "aria-label": "New keyword", onkeydown: function (e) {
          if (e.key === "Enter" && inp.value.trim()) { tags.push(inp.value.trim().toLowerCase()); st.addingKw = false; renderAll(); }
          if (e.key === "Escape") { st.addingKw = false; renderAttach(); }
        } });
        chips.append(inp);
        later(function () { inp.focus(); }, 0);
      }
      sc.append(h("div.ah", null, h("span", { text: "Keywords" }), h("span.grow"), h("button", { onclick: function () { st.addingKw = true; renderAttach(); } }, "Add")), chips);
      if (s.type === "thread") {
        var t = s.o;
        if (t.recap) sc.append(h("div.ah", null, h("span", { text: "Recap" }), h("span.grow"), h("button", { onclick: function () { toast("Generating a new recap with " + provider(t.provider).label + "…"); } }, "Regenerate")),
          h("div.acard", null, t.recap, h("small", { text: provider(t.provider).label + " · " + t.model })));
        var outl = t.links.map(function (id) { return D.T[id]; }).filter(Boolean);
        var back = backlinks(t.id);
        sc.append(h("div.ah", null, h("span", { text: "Links" }), h("span.grow"), h("button", { onclick: function () { openQuick("link"); } }, "Add")));
        outl.forEach(function (x) { sc.append(h("button.lrow2", { onclick: function () { openRef(x.id); } }, ic("link", "sm"), h("div", null, x.title, h("small", { text: "Links to · " + wsName(x.workspaceId) })))); });
        back.forEach(function (x) { sc.append(h("button.lrow2", { onclick: function () { if (x.kind === "note") { st.sel = [x.id]; renderAll(true); } else openRef(x.id); } }, ic(x.kind === "note" ? "note" : "link", "sm"), h("div", null, x.title, h("small", { text: "Links here · " + (x.kind === "note" ? "note" : "sheet") })))); });
        var marks = [];
        t.turns.forEach(function (u) { u.highlights.forEach(function (hl) { marks.push({ hl: hl, u: u }); }); });
        sc.append(h("div.ah", null, h("span", { text: "Marks" }), h("span.grow"), h("span", { text: marks.length ? String(marks.length) : "", style: "text-transform:none;font-weight:400" })));
        if (!marks.length) sc.append(h("div.small", { text: "Select text in an answer and choose Mark." }));
        marks.forEach(function (m) {
          sc.append(h("button.acard", { onclick: function () { openMark(t.id, m.u.id, m.hl.id); } },
            h("div.qq", null, h("span", { class: "hl-" + m.hl.color, text: m.hl.quote.replace(/`/g, "") })),
            m.hl.note ? h("div.nn", { text: m.hl.note }) : null,
            h("small", { text: "§ " + m.u.title })));
        });
        var srcs = [];
        t.turns.forEach(function (u) { u.sources.forEach(function (x) { if (!srcs.some(function (y) { return y.s.url === x.url; })) srcs.push({ s: x, u: u }); }); });
        sc.append(h("div.ah", null, h("span", { text: "Sources" })));
        if (!srcs.length) sc.append(h("div.small", { text: "No web sources cited." }));
        srcs.forEach(function (x) {
          sc.append(h("div.acard", null, h("span.fv", { text: x.s.domain.charAt(0).toUpperCase() }), x.s.title, h("small", { text: x.s.domain + " · § " + x.u.title })));
        });
      } else {
        var refs = [];
        (function w(items) { items.forEach(function (it) { if (it.ref && refs.indexOf(it.ref.threadId) < 0) refs.push(it.ref.threadId); if (it.children) w(it.children); }); })(s.o.outline);
        sc.append(h("div.ah", null, h("span", { text: "Links" })));
        refs.forEach(function (id) { var x = D.T[id]; if (x) sc.append(h("button.lrow2", { onclick: function () { openRef(id); } }, ic("link", "sm"), h("div", null, x.title, h("small", { text: "Links to · " + wsName(x.workspaceId) })))); });
      }
    }
    function attRun(sc, s) {
      if (!s || s.type !== "thread") {
        sc.append(h("div.empty", null, h("b", { text: "No run selected" }), s && s.type === "note" ? "Notes are written by you and have no runs." : "Open a sheet and click a section heading to see its run."));
        if (s && s.type === "guide") sc.append(h("div.ah", null, h("span", { text: "Agents" })), agentTable());
        return;
      }
      var t = s.o, u = D.U[st.section];
      if (!u || u.threadId !== t.id) u = D.U[defaultSection(t)];
      sc.append(h("div.ah", null, h("span", { text: "Section" })), h("div.runhead", { text: u.title }));
      var p = provider(u.provider);
      sc.append(h("dl.kv", null,
        h("dt", { text: "Status" }), h("dd", null, pill(u.status) || h("span", { style: "color:var(--green)", text: "Done" })),
        h("dt", { text: "Agent" }), h("dd", null, h("span", { style: "display:inline-flex;gap:6px;align-items:center" }, agentDot(u.provider), p.label)),
        h("dt", { text: "Model" }), h("dd", { text: u.model }),
        h("dt", { text: "Effort" }), h("dd", { text: u.effort || "Not offered" }),
        h("dt", { text: "Type" }), h("dd", { text: u.relation === "root" ? "First question" : u.relation === "followup" ? "Follow-up" : "Branch" }),
        h("dt", { text: "Started" }), h("dd", { text: fmtLong(u.createdAt) }),
        h("dt", { text: "Duration" }), h("dd", { text: u.status === "running" ? elapsed(u) + " so far" : fmtDur(u.durationSec) || "—" })));
      var acts = h("div.acts2");
      if (u.status === "running") acts.append(h("button.btn.sm", { onclick: function () { stopRun(t, u); } }, ic("stop", "sm"), "Stop"));
      if (u.status === "failed" || u.status === "done") acts.append(h("button.btn.sm", { onclick: function () { retry(t, u); } }, ic("retry", "sm"), "Run again"));
      if (u.status === "done") acts.append(h("button.btn.sm", { onclick: function () { startBranch(u, null); } }, ic("branch", "sm"), "Branch"));
      sc.append(acts);
      if (u.status === "queued") sc.append(h("div.ainfo", { text: "Waiting for “" + (D.U[u.parentId] || {}).title + "” to finish. A conversation runs one answer at a time so each follow-up sees the answer before it. Branches run right away." }));
      if (u.status === "failed" && u.error) sc.append(h("div.err", { style: "margin-top:10px" }, h("div.e", { text: u.error, style: "margin:0" })));
      sc.append(h("div.ah", null, h("span", { text: "Trace" }), h("span.grow"), h("span", { style: "text-transform:none;font-weight:400", text: plural(u.activity.length, "step") })));
      if (!u.activity.length) sc.append(h("div.small", { text: u.status === "queued" ? "No steps yet." : "No tool calls recorded." }));
      u.activity.forEach(function (a) {
        sc.append(h("div.step." + a.status, null,
          a.status === "running" ? h("span.ic", null, h("span.spin")) : ic(STEP_ICON[a.kind] || "run"),
          h("span", { text: a.label }),
          h("span.ms", { text: a.status === "running" ? "now" : a.ms >= 1000 ? (a.ms / 1000).toFixed(a.ms >= 10000 ? 0 : 1) + " s" : a.ms + " ms" }),
          a.detail ? h("span.dt", { text: a.detail }) : null));
      });
    }

    /* ============================================================ overlays */
    function mi(icon, label, key, fn, checked) {
      return h("button.mi", { onclick: function () { closePop(); fn(); } },
        checked != null ? h("span.chk", null, checked ? ic("check", "sm") : null) : icon ? ic(icon) : null,
        h("span", { text: label }), key ? h("span.k", { text: key }) : null);
    }
    function showPop(el, kind) { closePop(); st.pop = { el: el, kind: kind || "menu" }; layer.appendChild(el); }
    function closePop() { if (st.pop) { st.pop.el.remove(); st.pop = null; } }
    function closeOverlay() { if (st.overlay) { st.overlay.remove(); st.overlay = null; if (!root.contains(document.activeElement)) refocus(); } }
    function toast(msg) {
      if (st.toast) st.toast.remove();
      var el = h("div.toast", { role: "status", text: msg });
      layer.appendChild(el);
      st.toast = el;
      later(function () { if (st.toast === el) { el.remove(); st.toast = null; } }, 2600);
    }
    function openSheetPop(anchor) {
      var r = relRect(anchor);
      var L = placeSheets(st.place);
      var pop = h("div.pop.sheetpop", { style: "left:" + r.left + "px;top:" + (r.bottom + 6) + "px" },
        h("div.ph", null, h("span.grow", { text: placeInfo(st.place).title }), h("button", { style: "color:var(--blue);font-weight:500", onclick: function () { closePop(); setPanes(2); } }, "Show list ⌘2")),
        L.map(function (id) { var row = sheetRow(id, false, true); return row; }));
      showPop(pop);
    }
    function openQuick(mode) {
      closePop(); closeOverlay();
      var sel = 0, results = [];
      var inp = h("input", { placeholder: mode === "link" ? "Link to a sheet…" : "Open a sheet, section or group", "aria-label": "Quick open" });
      var res = h("div.res");
      function search() {
        var q = inp.value.trim().toLowerCase();
        results = [];
        D.threads.forEach(function (t) {
          if (!q || t.title.toLowerCase().indexOf(q) >= 0 || t.tags.join(" ").indexOf(q) >= 0) results.push({ icon: t.kind === "post" ? "link" : t.kind === "document" ? "doc" : "doc", label: t.title, sub: wsName(t.workspaceId), go: function () { openRef(t.id); } });
          if (q) t.turns.forEach(function (u) { if (u.title.toLowerCase().indexOf(q) >= 0 && u.relation !== "root") results.push({ icon: "outline", label: u.title, sub: "§ in " + (t.title.length > 30 ? t.title.slice(0, 28) + "…" : t.title), go: function () { openRef(t.id, u.id); } }); });
        });
        D.notes.forEach(function (n) { if (!q || n.title.toLowerCase().indexOf(q) >= 0) results.push({ icon: "note", label: n.title, sub: "Note · " + wsName(n.workspaceId), go: function () { st.place = "notes:" + n.workspaceId; st.sel = [n.id]; renderAll(true); } }); });
        if (q) D.folders.forEach(function (f) { if (f.name.toLowerCase().indexOf(q) >= 0) results.push({ icon: "group", label: f.name, sub: "Group · " + wsName(f.workspaceId), go: function () { go("g:" + f.id); } }); });
        if (mode === "link") {
          var cur = sheet(st.sel[0]);
          results = results.filter(function (r) { return r.icon !== "group"; }).map(function (r) {
            return Object.assign({}, r, { go: function () {
              var tid = D.threads.find(function (t) { return t.title === r.label; });
              if (cur && cur.type === "thread" && tid && cur.o.links.indexOf(tid.id) < 0 && tid.id !== cur.id) { cur.o.links.push(tid.id); renderAll(); toast("Linked to “" + tid.title + "”."); }
            } });
          });
        }
        results = results.slice(0, 9);
        sel = Math.min(sel, Math.max(0, results.length - 1));
        res.replaceChildren.apply(res, results.length ? results.map(function (r, i) {
          return h("button.qr", { class: i === sel ? "on" : null, onmouseenter: function () { sel = i; paint(); }, onclick: function () { closeOverlay(); r.go(); } }, ic(r.icon), h("span", { text: r.label }), h("small", { text: r.sub }));
        }) : [h("div.empty", { style: "padding:20px", text: "No matches" })]);
      }
      function paint() { [].forEach.call(res.children, function (c, i) { c.classList.toggle("on", i === sel); }); }
      inp.addEventListener("input", function () { sel = 0; search(); });
      inp.addEventListener("keydown", function (e) {
        if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); paint(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
        else if (e.key === "Enter" && results[sel]) { e.preventDefault(); var r = results[sel]; closeOverlay(); r.go(); }
        else if (e.key === "Escape") { e.stopPropagation(); closeOverlay(); }
      });
      var ov = h("div", { style: "position:absolute;inset:0" }, h("div.scrim", { onclick: closeOverlay }),
        h("div.qo", { role: "dialog", "aria-label": "Quick open" }, h("span.qi", null, ic("search")), inp, res,
          h("div.qfoot", null, h("span", { text: "↑↓ to move" }), h("span", { text: "↵ to open" }), h("span", { text: "esc to close" }))));
      st.overlay = ov;
      layer.appendChild(ov);
      search();
      inp.focus();
    }
    function openExport() {
      closePop(); closeOverlay();
      var fmt = "md";
      var opts = { meta: false, sources: true, marks: true };
      var ids0 = st.sel.slice();
      var title = ids0.length > 1 ? "Synthesis of " + ids0.length + " sheets" : (sheet(ids0[0]) || { title: "Untitled" }).title;
      var prev = h("div.prev");
      function page() {
        var pg = h("div.page");
        pg.append(h("h1", { text: title }));
        var fn = [];
        ids0.forEach(function (id) {
          var s = sheet(id);
          if (!s) return;
          if (ids0.length > 1) pg.append(h("h2", { text: s.title, style: "font-size:12px;margin-top:16px" }));
          if (s.type === "thread") {
            s.o.turns.forEach(function (u) {
              if (u.post) return;
              pg.append(h("h2", { text: strip(u.question) }));
              if (opts.meta) pg.append(h("div.pm", { text: provider(u.provider).label + " · " + u.model + " · " + fmtLong(u.createdAt) }));
              u.answer.slice(0, 2).forEach(function (p) {
                var el = h("p", null, opts.marks ? inline(p, u.highlights.map(function (hl) { return { quote: hl.quote, cls: "hl hl-" + hl.color }; })) : strip(p));
                pg.append(el);
              });
              if (opts.sources) u.sources.forEach(function (x) { fn.push(x.title + " — " + x.url); });
            });
          } else if (s.type === "note") s.o.outline.forEach(function (it) { pg.append(h("p", { text: "• " + strip(it.text) })); });
        });
        if (fn.length) pg.append(h("div.fn", null, fn.slice(0, 8).map(function (x, i) { return h("div", { text: (i + 1) + ". " + x }); })));
        prev.replaceChildren(pg);
      }
      var fmts = [["md", "Markdown", ".md"], ["pdf", "PDF", ".pdf"], ["html", "HTML", ".html"], ["docx", "Word", ".docx"]];
      var side = h("div.side");
      function paintSide() {
        side.replaceChildren(h("h3", { text: "Export preview" }),
          fmts.map(function (f) { return h("button.fmt", { class: fmt === f[0] ? "on" : null, onclick: function () { fmt = f[0]; paintSide(); } }, ic(f[0] === "md" ? "doc" : "share", "sm"), f[1], h("small", { text: f[2] })); }),
          h("div.ah", { style: "margin-top:14px" }, h("span", { text: "Include" })),
          check("Run details (agent, model, time)", "meta"), check("Sources as footnotes", "sources"), check("Marks as highlights", "marks"),
          h("div.small", { style: "margin-top:auto;line-height:1.45", text: "Questions export as headings and answers as body text. Branches export as sub-sections under their passage." }));
      }
      function check(label, key) {
        var cb = h("input", { type: "checkbox", onchange: function () { opts[key] = cb.checked; page(); } });
        cb.checked = opts[key];
        return h("label", null, cb, label);
      }
      paintSide(); page();
      var ov = h("div", { style: "position:absolute;inset:0" }, h("div.scrim", { onclick: closeOverlay }),
        h("div.xp", { role: "dialog", "aria-label": "Export preview" }, side, prev,
          h("div.bar", null, h("button.btn", { onclick: closeOverlay }, "Cancel"),
            h("button.btn.pri", { onclick: function () { closeOverlay(); toast("Exported “" + title + "” as " + fmts.find(function (f) { return f[0] === fmt; })[1] + "."); } }, "Export…"))));
      st.overlay = ov;
      layer.appendChild(ov);
    }

    /* ----- text selection: mark, branch, copy */
    function onSelectText() {
      later(function () {
        var sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return;
        var txt = sel.toString().replace(/\s+/g, " ").trim();
        if (txt.length < 3) return;
        var node = sel.anchorNode, elx = node && (node.nodeType === 3 ? node.parentElement : node);
        var p = elx && elx.closest && elx.closest("[data-p]");
        if (!p || !root.contains(p)) return;
        var turnId = p.getAttribute("data-turn"), pi = Number(p.getAttribute("data-p")), u = D.U[turnId], t = D.T[u.threadId];
        var r = relRect(sel.getRangeAt(0));
        var bar = h("div.selbar", { style: "left:" + (r.left + r.width / 2) + "px;top:" + Math.max(56, r.top - 40) + "px" },
          u.status === "running" ? h("span.dis", { text: "Wait for the answer to finish" }) : [
            h("button", { onclick: function () { addMark(u, pi, txt); } }, ic("mark"), "Mark"),
            h("button", { onclick: function () { closePop(); sel.removeAllRanges(); startBranch(u, { turnId: u.id, paragraph: pi, quote: txt }); } }, ic("branch"), "Branch"),
            h("button", { onclick: function () { closePop(); try { navigator.clipboard.writeText(txt).catch(function () {}); } catch (e) { /* no clipboard */ } toast("Copied."); } }, ic("copy"), "Copy")
          ]);
        void t;
        showPop(bar, "sel");
      }, 0);
    }
    function addMark(u, pi, txt) {
      closePop();
      u.highlights.push({ id: "hm" + (++uid), paragraph: pi, quote: txt, color: "amber", note: null, createdAt: nowISO() });
      window.getSelection().removeAllRanges();
      renderEditor(); renderAttach(); renderLib();
      toast("Marked. Listed under Marked passages and in Attachments.");
    }

    /* ----- new sheet */
    function newSheet() {
      var ws = currentWs() || (D.workspaces[0] && D.workspaces[0].id);
      st.newSheet = { id: "new", ws: ws, place: st.place === "marks" || st.place === "guide" || st.place === "archive" ? "inbox" : st.place };
      st.place = st.newSheet.place;
      st.sel = ["new"];
      resetComposer();
      st.comp.provider = "claude"; st.comp.model = "opus"; st.comp.effort = "high";
      renderAll(true);
      focusComposer();
    }

    /* ================================================================ render */
    function renderAll(resetScroll) {
      var had = root.contains(document.activeElement);
      if (st.newSheet && st.sel[0] !== "new") st.newSheet = null;
      renderLib(); renderList(); renderEditor(resetScroll); renderAttach();
      var ae = document.activeElement;
      if (had && (!root.contains(ae) || (ae !== root && !ae.offsetParent))) refocus();
    }
    function refocus() {
      var row = st.list && listEl.querySelector(".row.on");
      (row || root).focus({ preventScroll: true });
    }

    /* keyboard */
    function onKey(e) {
      var mod = e.metaKey || e.ctrlKey;
      var tag = e.target && e.target.tagName;
      var typing = tag === "TEXTAREA" || tag === "INPUT";
      if (mod && (e.key === "1" || e.key === "2" || e.key === "3")) { e.preventDefault(); setPanes(Number(e.key)); return; }
      if (mod && (e.key === "o" || e.key === "k")) { e.preventDefault(); openQuick(); return; }
      if (mod && e.key === "n") { e.preventDefault(); newSheet(); return; }
      if (e.key === "Escape") { if (st.overlay) closeOverlay(); else if (st.pop) closePop(); else if (st.typewriter) { st.typewriter = false; renderEditor(); } return; }
      if (typing) return;
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && st.list && st.place !== "marks") {
        var L = placeSheets(st.place), i = L.indexOf(st.sel[0]);
        var j = Math.max(0, Math.min(L.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
        if (L[j] && j !== i) { e.preventDefault(); pickSheet(L[j]); var row = listEl.querySelector('[data-sheet="' + L[j] + '"]'); if (row) { row.focus({ preventScroll: true }); row.scrollIntoView({ block: "nearest" }); } }
      }
    }
    function onDown(e) {
      if (st.pop && !st.pop.el.contains(e.target)) {
        if (st.pop.kind === "sel" && e.target.closest && e.target.closest(".ed-scroll")) { closePop(); return; }
        closePop();
      }
    }
    root.addEventListener("keydown", onKey);
    root.addEventListener("mousedown", onDown);

    /* initial state */
    var s0 = sheet(st.sel[0]);
    if (s0 && s0.type === "thread" && !st.section) st.section = defaultSection(s0.o);
    resetComposer();
    if (st.section) openAncestors(D.U[st.section]);
    renderAll(true);
    function initialScroll() {
      var sc = edEl.querySelector(".ed-scroll");
      if (cfg.scrollTo && sc && sc.scrollTop === 0) { if (st.typewriter) scrollToEl(edEl.querySelector(".comp"), true); else scrollToTurn(cfg.scrollTo); }
      revealRow();
    }
    [30, 250, 500].forEach(function (ms) { later(initialScroll, ms); });
    if (cfg.focusComposer) later(function () { var ta = edEl.querySelector(".cta"); if (ta) ta.focus({ preventScroll: true }); }, 40);
    /* runs already in progress keep going */
    if (!cfg.firstRun) {
      later(function () { var u = D.U.t3q3; if (u && u.status === "running") simulate(D.T.t3, u); }, 2500);
      later(function () { var u = D.U.t2q3; if (u && u.status === "running") simulate(D.T.t2, u); }, 6000);
    }

    return function cleanup() {
      disposed = true;
      timers.forEach(clearTimeout);
      timers = [];
      root.removeEventListener("keydown", onKey);
      root.removeEventListener("mousedown", onDown);
      root.replaceChildren();
    };
  }

  window.SessionMocks.register({
    id: "ulysses", round: 1,
    name: "Sheets & Groups",
    reference: "Ulysses",
    summary: "Session as a writing library: every research thread is a sheet that reads as one continuous document, where each question is a heading and the answer is the prose under it. Library, sheet list and editor collapse progressively; an attachments pane holds the outline, keywords, marks, sources and run trace.",
    principles: [
      "Three panes that collapse with ⌘1/⌘2/⌘3: Library (workspaces as sections, folders as groups, Inbox, Filters), sheet list (title, first lines, date, keyword chips, status glyph), editor.",
      "A conversation is a document. Questions are headings (## follow-up, ### branch) with markup shown lightly in the margin; answers are prose with a generous measure. This replaces the messages column plus answer column.",
      "Branches are folded under the paragraph they came from, with the passage underlined; follow-ups continue the main text. The Dashboard outline shows the whole tree and its sections can be collapsed.",
      "One name per object: sheet (thread, note or draft), group (folder), workspace (directory on disk). Five “keep” actions become three with one scope each: Favorite (sheet), Mark (passage, with note), Keyword (label). Follow and the network Post mode are dropped.",
      "Attachments pane, as in Ulysses: Dashboard (outline, statistics, goal), Attachments (keywords, links and backlinks, marks, sources, recap), Run (agent, model, effort, status, trace).",
      "Filters are saved searches: Needs attention (unread, failed, waiting for your reply) and Running & queued give the attention inbox the app lacks; a keyword chip opens its own filter.",
      "Glue: ⌘-click sheets to read them as one document, then save the result as a linked note or open the export preview."
    ],
    chat: "You ask at the end of the document: the composer is the next heading, with the agent, model and effort visible on it and a Follow-up / Branch switch that states what each does. Return sends; the answer streams into a new section, and a follow-up sent while an answer runs is queued with an explanation. Selecting text offers Mark, Branch and Copy. Variant B docks the composer as a bar and opens the Run tab so the trace streams beside the answer.",
    knowledge: "Sheets live in groups inside workspaces; keywords, filters and links cut across them. The Dashboard outline is the tree of every sheet, notes are outlines whose items link to specific sections, and Attachments lists links and backlinks between sheets. Gluing several sheets gives one readable document with a combined outline, which can be saved as a synthesis note or exported.",
    firstRun: "The library opens on a Getting Started group of five short sheets, as Ulysses ships its own. The first sheet explains Session in two sentences, shows agent status with the one missing sign-in command, and ends with the composer, so the first question is asked in the main stage and becomes a new sheet in Inbox. Empty groups and workspaces show the same composer in the editor.",
    changes: [],
    variants: [
      { id: "a", name: "Three panes", note: "Library, sheet list and editor; the composer is the last heading of the document." },
      { id: "b", name: "Docked composer + Run", note: "Library hidden (⌘2), composer as a bar under the editor, attachments pane on the Run tab for watching a streaming answer and its queue." },
      { id: "c", name: "Glued synthesis", note: "Four sheets glued into one document with a combined Dashboard outline, word goal and export preview." },
      { id: "d", name: "Editor only, typewriter", note: "⌘3 with typewriter focus on a run that is waiting for a reply; sheets open from a toolbar popover instead of a pane." },
      { id: "e", name: "Getting Started", note: "First run: empty library plus a pre-filled Getting Started group; agent status and the first question live in the editor." }
    ],
    fonts: "family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&family=IBM+Plex+Mono:wght@400;500",
    css: CSS,
    mount: mount
  });
})();
