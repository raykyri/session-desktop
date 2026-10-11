/* Session redesign candidate "heptabase", round 1.
 * Whiteboards as the research space: a research tree is laid out as a whiteboard of
 * question, answer, highlight and source cards; workspaces are whiteboards with
 * sections (folders) holding nested research whiteboards. Plain browser JS. */
(() => {
"use strict";
var SC = "m-heptabase-r1";

/* ------------------------------------------------------------------ CSS */
var RAW = `
&{--bg:#f5f5f2;--canvas:#f3f3ef;--dot:#d6d6cf;--side:#fafaf8;--panel:#ffffff;--card:#ffffff;--card-2:#f8f8f5;--line:#e5e4de;--line-2:#eeede8;
--ink:#23231f;--ink-2:#55554e;--ink-3:#85857d;--accent:#3a67d6;--accent-2:#2f56b8;--accent-soft:#e9effc;--accent-ink:#fff;
--q:#f2f5fc;--q-line:#d6e0f6;--edge:#b3b2a9;--branch:#3a67d6;--amber:#d9a227;--amber-bg:#fbf1d4;--amber-mark:rgba(240,186,60,.32);
--green:#3a8f5a;--green-bg:#e3f2e8;--red:#c44536;--red-bg:#fbe8e4;--violet:#7356cc;--violet-bg:#efebfb;--run:#b9790d;--run-bg:#fbefd6;
--shadow:0 1px 2px rgba(40,40,30,.06),0 3px 10px rgba(40,40,30,.05);--shadow-2:0 2px 6px rgba(40,40,30,.08),0 14px 34px rgba(40,40,30,.12);
--hover:rgba(30,30,20,.05);--sel-bg:rgba(58,103,214,.09);
position:absolute;inset:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.45;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased;outline:none}
&[data-theme="dark"]{--bg:#19191b;--canvas:#1b1b1e;--dot:#303035;--side:#1f1f22;--panel:#222225;--card:#28282c;--card-2:#2c2c31;--line:#36363b;--line-2:#2f2f34;
--ink:#ebebe7;--ink-2:#b7b7b0;--ink-3:#8a8a84;--accent:#7f9ff0;--accent-2:#9db5f4;--accent-soft:#27304a;--accent-ink:#0f1424;
--q:#252b3a;--q-line:#36425f;--edge:#5d5d63;--branch:#7f9ff0;--amber:#e2b24c;--amber-bg:#3a321e;--amber-mark:rgba(226,178,76,.30);
--green:#6cc08a;--green-bg:#1f3428;--red:#ec7c6c;--red-bg:#3c2420;--violet:#a891f0;--violet-bg:#2e2944;--run:#e2ad4c;--run-bg:#3a301b;
--shadow:0 1px 2px rgba(0,0,0,.35),0 3px 10px rgba(0,0,0,.25);--shadow-2:0 2px 6px rgba(0,0,0,.4),0 16px 40px rgba(0,0,0,.45);
--hover:rgba(255,255,255,.05);--sel-bg:rgba(127,159,240,.14)}
& *{box-sizing:border-box}
& button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
& textarea,& input{font:inherit;color:inherit}
& code{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:.88em;background:var(--card-2);border:1px solid var(--line-2);border-radius:4px;padding:0 3px}
& .ic{display:inline-flex;width:16px;height:16px;flex:none;align-items:center;justify-content:center}
& .ic svg{width:100%;height:100%}
& .app{position:absolute;inset:0;display:flex}
/* sidebar */
& .side{width:228px;flex:none;background:var(--side);border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
& .side-top{height:40px;display:flex;align-items:center;padding:0 12px 0 14px;gap:8px;flex:none}
& .lights{display:flex;gap:8px}
& .lights i{width:12px;height:12px;border-radius:50%;background:#ec6a5e;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.15)}& .lights i:nth-child(2){background:#f4bf4f}
& .lights i:nth-child(3){background:#61c554}
& .side-top .sp{flex:1}
& .iconbtn{width:26px;height:26px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;color:var(--ink-3)}
& .iconbtn:hover{background:var(--hover);color:var(--ink)}
& .wsbtn{margin:2px 10px 6px;padding:6px 8px;border-radius:8px;display:flex;align-items:center;gap:9px;text-align:left;width:calc(100% - 20px)}
& .wsbtn:hover{background:var(--hover)}
& .mono{width:26px;height:26px;border-radius:7px;background:var(--accent);color:var(--accent-ink);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:12px;flex:none}
& .wsbtn b{display:block;font-weight:600;font-size:13px}
& .wsbtn small{display:block;color:var(--ink-3);font-size:11px;font-family:"JetBrains Mono",monospace}
& .wsbtn .ic{margin-left:auto;color:var(--ink-3);width:14px}
& .search{margin:0 10px 8px;height:30px;border:1px solid var(--line);background:var(--card);border-radius:7px;display:flex;align-items:center;gap:7px;padding:0 9px;color:var(--ink-3);width:calc(100% - 20px)}
& .search span.t{flex:1;text-align:left}
& .kbd{font-size:10.5px;color:var(--ink-3);border:1px solid var(--line);border-radius:4px;padding:0 4px;line-height:16px;font-family:Inter,sans-serif;background:var(--card)}
& .nav{padding:0 8px}
& .row{display:flex;align-items:center;gap:8px;height:28px;padding:0 8px;border-radius:6px;color:var(--ink-2);width:100%;text-align:left;white-space:nowrap}
& .row:hover{background:var(--hover);color:var(--ink)}
& .row.on{background:var(--sel-bg);color:var(--ink)}
& .row.on .ic{color:var(--accent)}
& .row .lbl{flex:1;overflow:hidden;text-overflow:ellipsis}
& .row .cnt{font-size:11px;color:var(--ink-3);font-variant-numeric:tabular-nums}
& .row .cnt.hot{background:var(--accent);color:var(--accent-ink);border-radius:9px;padding:0 6px;line-height:16px;font-weight:600}
& .side-h{display:flex;align-items:center;justify-content:space-between;padding:14px 10px 4px 16px;font-size:11px;font-weight:600;color:var(--ink-3);letter-spacing:.02em}
& .tree{flex:1;overflow:auto;padding:0 8px 8px;min-height:0}
& .tree .row{height:27px}
& .tree .grp{font-size:11px;color:var(--ink-3);height:24px;padding-left:28px;gap:6px;font-weight:500}
& .tree .grp .ic{width:12px}
& .tree .drop{outline:2px dashed var(--accent);outline-offset:-2px;background:var(--sel-bg)}
& .dot{width:7px;height:7px;border-radius:50%;flex:none}
& .dot.unread{background:var(--accent)}& .dot.run{background:var(--run);animation:hp-pulse 1.4s ease-in-out infinite}
& .dot.err{background:var(--red)}& .dot.att{background:var(--amber)}
@keyframes hp-pulse{0%,100%{opacity:1}50%{opacity:.35}}
& .side-foot{border-top:1px solid var(--line);padding:8px 10px;display:flex;align-items:center;gap:8px;flex:none}
& .avatar{width:24px;height:24px;border-radius:50%;background:var(--violet-bg);color:var(--violet);font-size:10.5px;font-weight:600;display:flex;align-items:center;justify-content:center}
& .agents-ok{display:flex;align-items:center;gap:6px;color:var(--ink-2);font-size:12px;flex:1;padding:4px 6px;border-radius:6px}
& .agents-ok:hover{background:var(--hover)}
& .agents-ok .dot{background:var(--green)}
/* rail (variant d) */
& .rail{width:52px;flex:none;background:var(--side);border-right:1px solid var(--line);display:flex;flex-direction:column;align-items:center;padding-top:44px;gap:4px}
& .rail .lights{position:absolute;top:14px;left:14px}
& .rail .rb{width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--ink-3)}
& .rail .rb:hover{background:var(--hover);color:var(--ink)}& .rail .rb.on{background:var(--sel-bg);color:var(--accent)}
& .rail .rb .ic{width:18px;height:18px}
& .rail .mono{margin-bottom:8px}
/* library pane */
& .libp{width:316px;flex:none;border-right:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;min-height:0}
& .libp-h{height:40px;display:flex;align-items:center;padding:0 14px;font-weight:600;font-size:13.5px;gap:8px;flex:none;padding-left:76px}
& .libp-h small{color:var(--ink-3);font-weight:400}
& .libsearch{margin:4px 12px 8px;height:30px;border:1px solid var(--line);border-radius:7px;display:flex;align-items:center;gap:6px;padding:0 8px;color:var(--ink-3);background:var(--card-2)}
& .libsearch input{border:0;outline:0;background:none;flex:1;min-width:0;color:var(--ink)}
& .chips{display:flex;gap:4px;flex-wrap:wrap;padding:0 12px 8px}
& .chip{font-size:11.5px;padding:2px 8px;border-radius:12px;border:1px solid var(--line);color:var(--ink-2);background:var(--card)}
& .chip.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
& .liblist{flex:1;overflow:auto;padding:0 8px 12px;min-height:0}
& .lrow{display:flex;gap:9px;padding:8px;border-radius:8px;cursor:grab;align-items:flex-start;user-select:none}
& .lrow:hover{background:var(--hover)}
& .lrow .ti{width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;flex:none;margin-top:1px}
& .lrow .ti .ic{width:13px;height:13px}
& .lrow b{display:block;font-weight:550;font-size:12.5px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
& .lrow p{margin:1px 0 0;color:var(--ink-3);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
& .lrow .m{font-size:11px;color:var(--ink-3);margin-top:2px}
& .lrow>div{min-width:0;flex:1}
& .ti.a{background:var(--card-2);color:var(--ink-2);border:1px solid var(--line)}& .ti.q{background:var(--q);color:var(--accent)}
& .ti.n{background:var(--green-bg);color:var(--green)}& .ti.h{background:var(--amber-bg);color:var(--amber)}& .ti.s{background:var(--card-2);color:var(--ink-3);border:1px solid var(--line)}
& .ti.b{background:var(--violet-bg);color:var(--violet)}
& .libnote{margin:0 12px 10px;font-size:11.5px;color:var(--ink-3);display:flex;gap:6px;align-items:center}
/* main */
& .main{flex:1;min-width:0;display:flex;flex-direction:column;position:relative}
& .tabs{height:40px;flex:none;display:flex;align-items:flex-end;gap:2px;padding:0 10px 0 8px;border-bottom:1px solid var(--line);background:var(--side)}
& .tab{flex:0 1 auto;min-width:64px;height:31px;display:flex;align-items:center;gap:7px;padding:0 8px 0 10px;border-radius:8px 8px 0 0;color:var(--ink-3);max-width:210px;font-size:12.5px;border:1px solid transparent;border-bottom:0;position:relative;top:1px}
& .tab:hover{color:var(--ink);background:var(--hover)}
& .tab.on{background:var(--canvas);color:var(--ink);border-color:var(--line)}
& .tab .tl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
& .tab .ic{width:14px;height:14px}
& .tab .x{width:16px;height:16px;border-radius:4px;opacity:.0;display:inline-flex}
& .tab:hover .x,& .tab.on .x{opacity:.6}& .tab .x:hover{opacity:1;background:var(--hover)}
& .tabs .sp{flex:1}
& .btn{height:28px;display:inline-flex;align-items:center;gap:6px;padding:0 10px;border-radius:7px;font-size:12.5px;font-weight:500;color:var(--ink-2);border:1px solid var(--line);background:var(--card)}
& .btn:hover{color:var(--ink);border-color:var(--edge)}
& .btn.pri{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
& .btn.pri:hover{background:var(--accent-2);border-color:var(--accent-2)}
& .btn .ic{width:14px;height:14px}
& .tabs .btn{margin-bottom:6px;flex:none}
& .tabs{overflow:hidden}
& .content{flex:1;position:relative;min-height:0;overflow:hidden;background:var(--canvas)}
/* canvas */
& .cv{position:absolute;inset:0;overflow:hidden;background-color:var(--canvas);background-image:radial-gradient(var(--dot) 1.1px,transparent 1.2px);cursor:default;touch-action:none}
& .cv.panning{cursor:grabbing}& .cv.hand{cursor:grab}
& .world{position:absolute;left:0;top:0;transform-origin:0 0;width:1px;height:1px}
& .world.anim{transition:transform .28s ease}
& .sec{position:absolute;border-radius:14px;border:1.5px solid rgba(var(--st),.30);background:rgba(var(--st),.045)}
& .sec .sl{position:absolute;left:14px;top:12px;font-weight:600;font-size:14px;color:rgb(var(--st));display:flex;align-items:center;gap:6px}
& .sec .sl small{font-weight:500;color:var(--ink-3);font-size:11.5px}
& .sec.t-blue{--st:58,103,214}& .sec.t-green{--st:58,143,90}& .sec.t-violet{--st:115,86,204}& .sec.t-amber{--st:185,121,13}& .sec.t-gray{--st:130,130,122}
&[data-theme="dark"] .sec{background:rgba(var(--st),.07)}
&[data-theme="dark"] .sec.t-blue{--st:127,159,240}&[data-theme="dark"] .sec.t-green{--st:108,192,138}&[data-theme="dark"] .sec.t-violet{--st:168,145,240}&[data-theme="dark"] .sec.t-amber{--st:226,173,76}&[data-theme="dark"] .sec.t-gray{--st:150,150,144}
& svg.edges{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none}
& svg.edges path{fill:none;stroke:var(--edge);stroke-width:1.6}
& svg.edges path.e-branch{stroke:var(--branch);stroke-width:1.8}
& svg.edges path.e-hl{stroke:var(--amber);stroke-dasharray:3 4;stroke-width:1.5}
& svg.edges path.e-related{stroke-dasharray:6 5}
& svg.edges path.e-ask{stroke:var(--accent);stroke-dasharray:5 5}
& svg.edges path.e-qa{stroke-width:1.4}
& .mk-g{fill:var(--edge)}& .mk-b{fill:var(--branch)}
& .elab{position:absolute;transform:translate(-50%,-50%);font-size:11px;font-weight:500;padding:1px 8px;border-radius:10px;background:var(--canvas);color:var(--ink-3);border:1px solid var(--line);white-space:nowrap;pointer-events:none;display:flex;gap:4px;align-items:center}
& .elab .ic{width:11px;height:11px}
& .elab.el-branch,& .elab.el-ask{color:var(--branch);border-color:var(--q-line);background:var(--q)}
/* cards */
& .card{position:absolute;background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);display:flex;flex-direction:column;overflow:hidden;cursor:default;user-select:none;transition:box-shadow .12s}
& .card:hover{box-shadow:var(--shadow-2)}
& .card.sel{outline:2px solid var(--accent);outline-offset:1px}
& .card.drag{box-shadow:var(--shadow-2);opacity:.92;pointer-events:none;transition:none;z-index:5}
& .card.flash{animation:hp-flash 1.1s ease}
@keyframes hp-flash{0%,60%{outline:3px solid var(--amber);outline-offset:3px}100%{outline:3px solid transparent}}
& .ch{display:flex;align-items:center;gap:6px;padding:9px 12px 0;font-size:11.5px;color:var(--ink-3);flex:none;white-space:nowrap}
& .ch .ic{width:13px;height:13px}
& .ch .sp{flex:1}
& .ct{padding:4px 12px 0;font-weight:600;font-size:14px;line-height:1.3;flex:none;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
& .cb{padding:5px 12px 0;font-size:12.5px;line-height:1.5;color:var(--ink-2);flex:1;min-height:0;overflow:hidden;-webkit-mask-image:linear-gradient(#000 calc(100% - 26px),transparent);mask-image:linear-gradient(#000 calc(100% - 26px),transparent)}
& .cb p{margin:0 0 6px}
& .card code{background:none;border:0;padding:0;font-size:.86em;color:var(--ink)}
& .cf{display:flex;align-items:center;gap:8px;padding:6px 12px 9px;font-size:11px;color:var(--ink-3);flex:none;white-space:nowrap}
& .cf .ic{width:12px;height:12px}
& .cf span{display:inline-flex;align-items:center;gap:3px}
& .cf .sp{flex:1}
& .reuse{color:var(--violet);font-weight:500}
& .agent{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--ink-2);white-space:nowrap}
& .pdot{width:7px;height:7px;border-radius:2px;flex:none}
& .pdot.claude{background:#d9a07d}& .pdot.codex{background:#5fae86}& .pdot.grok{background:#8a8aa0}
& .c-q{background:var(--q);border-color:var(--q-line)}
& .c-q .cb{color:var(--ink);font-size:13px;-webkit-mask-image:none;mask-image:none;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;padding-top:4px}
& .c-q.has-quote .cb{-webkit-line-clamp:2}
& .quote{margin:5px 12px 0;padding:1px 0 1px 8px;border-left:2px solid var(--branch);font-size:11.5px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:none}
& .pill{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:550;padding:0 7px;border-radius:9px;line-height:18px;white-space:nowrap}
& .pill.ok{background:var(--green-bg);color:var(--green)}& .pill.run{background:var(--run-bg);color:var(--run)}& .pill.error{background:var(--red-bg);color:var(--red)}
& .pill.attention{background:var(--amber-bg);color:var(--amber)}& .pill.plain{background:var(--card-2);color:var(--ink-3);border:1px solid var(--line)}& .pill.new{background:var(--accent-soft);color:var(--accent)}
& .pill.run::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;animation:hp-pulse 1.2s infinite}
& .c-a.running{border-top:2px solid var(--run)}
& .tick{position:absolute;right:-1px;width:6px;height:16px;border-radius:3px 0 0 3px;background:var(--branch)}
& .box{margin:6px 12px 0;padding:7px 9px;border-radius:7px;font-size:12px;line-height:1.45;flex:none}
& .box.err{background:var(--red-bg);color:var(--red)}
& .box.att{background:var(--amber-bg);color:var(--ink)}
& .box.att b{color:var(--amber)}
& .box.plain{background:var(--card-2);color:var(--ink-2);border:1px solid var(--line-2)}
& .box .acts{display:flex;gap:6px;margin-top:6px}
& .mini{height:22px;padding:0 8px;border-radius:6px;font-size:11.5px;font-weight:500;background:var(--card);border:1px solid var(--line);color:var(--ink)}
& .mini:hover{border-color:var(--edge)}
& .mini.pri{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
& .c-h{border-left:3px solid var(--amber)}
& .c-h.blue{border-left-color:var(--branch)}& .c-h.green{border-left-color:var(--green)}& .c-h.pink{border-left-color:#d4669a}
& .c-h .cb{color:var(--ink);font-size:12px;-webkit-mask-image:none;mask-image:none;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
& .c-h .cb mark{background:var(--amber-mark);color:inherit;border-radius:2px}
& .c-s .ct{font-size:12.5px;font-weight:550}
& .fav{width:16px;height:16px;border-radius:4px;background:var(--card-2);border:1px solid var(--line);font-size:9.5px;font-weight:700;color:var(--ink-2);display:inline-flex;align-items:center;justify-content:center;flex:none}
& .c-n .ch .ic{color:var(--green)}
& .c-n ul{margin:0;padding:0 0 0 14px}
& .c-n li{margin:0 0 3px}
& .c-n li li{color:var(--ink-3)}
& .c-r{background:var(--violet-bg);border-color:transparent}
& .c-r .ch{color:var(--violet)}
& .c-r .cb{color:var(--ink);-webkit-mask-image:none;mask-image:none}
& .c-b{overflow:visible;background:var(--card)}
& .c-b::before{content:"";position:absolute;left:6px;right:6px;bottom:-6px;height:12px;border-radius:0 0 10px 10px;background:var(--card-2);border:1px solid var(--line);border-top:0;z-index:-1}
& .c-b .ch .ic{color:var(--violet)}
& .thumb{margin:8px 12px 0;height:64px;border-radius:7px;background:var(--canvas);border:1px solid var(--line-2);flex:none;overflow:hidden}
& .thumb svg{width:100%;height:100%}
& .thumb .tq{fill:var(--q-line)}& .thumb .ta{fill:var(--card);stroke:var(--edge);stroke-width:.8}& .thumb .tl{stroke:var(--edge);stroke-width:1}& .thumb .tb{stroke:var(--branch);stroke-width:1}
& .c-d,& .c-ask{border:1.5px dashed var(--edge);background:var(--card-2);box-shadow:none}
& .c-ask{border-color:var(--accent);background:var(--card)}
& .c-ask textarea{flex:1;margin:6px 12px 0;border:0;outline:0;resize:none;background:none;font-size:13px;line-height:1.45;min-height:0}
& .c-ask .cf{padding-top:4px}
& .c-tip{background:transparent;border:0;box-shadow:none;overflow:visible}
& .c-tip:hover{box-shadow:none}
& .c-tip .num{width:20px;height:20px;border-radius:50%;background:var(--ink);color:var(--bg);font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex:none}
& .c-tip .tt{display:flex;gap:8px;align-items:center;font-weight:600;font-size:15px;color:var(--ink)}
& .c-tip p{margin:4px 0 0 28px;font-size:13.5px;color:var(--ink-2);line-height:1.45}
& .c-big .ct{font-size:20px;padding:12px 14px 0}
& .c-big .ch{font-size:13px;padding:4px 14px 0}
& .c-big textarea{font-size:16px;margin:8px 14px 0;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--card-2);flex:1;resize:none;outline:0}
& .c-big textarea:focus{border-color:var(--accent)}
& .c-big .cf{padding:8px 14px 12px}
& .setup-row{display:flex;align-items:center;gap:10px;padding:8px 14px;border-top:1px solid var(--line-2)}
& .setup-row:first-of-type{border-top:0}
& .setup-row b{font-weight:600;font-size:14px}
& .setup-row small{display:block;color:var(--ink-3);font-size:12.5px}
& .setup-row>div{flex:1;min-width:0}
& .setup-row code{font-size:11px}
/* canvas chrome */
& .cv-ui{position:absolute;z-index:10}
& .crumb{left:14px;top:12px;display:flex;align-items:center;gap:2px;background:var(--card);border:1px solid var(--line);border-radius:9px;box-shadow:var(--shadow);padding:3px;max-width:62%}
& .crumb button{flex:none;height:26px;padding:0 8px;border-radius:6px;color:var(--ink-3);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:6px;min-width:0}
& .crumb button:hover{background:var(--hover);color:var(--ink)}
& .crumb button.cur{color:var(--ink);font-weight:600;flex:0 1 auto}
& .crumb .sep{color:var(--ink-3);width:12px;height:12px;flex:none}
& .crumb .ic{width:14px;height:14px}
& .acts-tr{right:14px;top:12px;display:flex;gap:6px}
& .acts-tr .btn{box-shadow:var(--shadow)}
& .tools{left:50%;bottom:14px;transform:translateX(-50%);display:flex;gap:2px;background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);padding:4px}
& .tools button{width:32px;height:32px;border-radius:7px;display:flex;align-items:center;justify-content:center;color:var(--ink-2)}
& .tools button:hover{background:var(--hover);color:var(--ink)}
& .tools button.on{background:var(--sel-bg);color:var(--accent)}
& .tools .div{width:1px;background:var(--line);margin:4px 3px}
& .zoom{right:14px;bottom:14px;display:flex;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:9px;box-shadow:var(--shadow);padding:3px;gap:1px}
& .zoom button{height:26px;min-width:26px;border-radius:6px;display:flex;align-items:center;justify-content:center;color:var(--ink-2);font-size:12px;font-variant-numeric:tabular-nums;padding:0 4px}
& .zoom button:hover{background:var(--hover);color:var(--ink)}
& .zoom .ic{width:14px;height:14px}
& .mm{right:14px;bottom:50px;width:176px;height:112px;background:var(--card);border:1px solid var(--line);border-radius:9px;box-shadow:var(--shadow);overflow:hidden;cursor:pointer}
& .mm svg{width:100%;height:100%;display:block}
& .mm .r{fill:var(--line)}& .mm .r.q{fill:var(--q-line)}& .mm .r.s{fill:none;stroke:var(--edge);stroke-width:.8}& .mm .r.sel{fill:var(--accent)}
& .mm .vp{fill:var(--sel-bg);stroke:var(--accent);stroke-width:1.2}
& .legend{left:14px;top:54px;background:var(--card);border:1px solid var(--line);border-radius:9px;box-shadow:var(--shadow);padding:5px 6px 5px 12px;font-size:12px;color:var(--ink-2);display:flex;align-items:center;gap:14px;max-width:calc(100% - 28px);flex-wrap:wrap}
& .legend .lx{color:var(--ink-3);width:22px;height:22px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center}& .legend .lx:hover{background:var(--hover)}
& .legend .lg{display:flex;align-items:center;gap:6px;white-space:nowrap}
& .legend svg{width:26px;height:12px;flex:none}
& .legend .lgb{background:var(--card);border:1px solid var(--line);box-shadow:var(--shadow);border-radius:9px;height:30px;padding:0 10px;display:flex;align-items:center;gap:6px;color:var(--ink-2);font-size:12px}
& .legend.closed{padding:0;border:0;background:none;box-shadow:none;top:auto;bottom:14px}
& .fbar{display:flex;gap:2px;background:var(--ink);color:var(--bg);border-radius:9px;padding:3px;box-shadow:var(--shadow-2);transform:translate(-50%,-100%);white-space:nowrap}
& .fbar button{height:26px;padding:0 9px;border-radius:6px;display:flex;align-items:center;gap:5px;font-size:12px;font-weight:500;color:inherit}
& .fbar button:hover{background:rgba(127,127,127,.28)}
& .fbar .ic{width:13px;height:13px}
& .fbar .div{width:1px;background:rgba(127,127,127,.4);margin:4px 2px}
/* panel */
& .panel{width:356px;flex:none;border-left:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;min-height:0;position:relative}
& .pn-h{height:40px;display:flex;align-items:center;gap:6px;padding:0 8px 0 16px;border-bottom:1px solid var(--line-2);flex:none;font-size:12px;color:var(--ink-3)}
& .pn-h .ic{width:14px;height:14px}
& .pn-h .sp{flex:1}
& .pn-s{flex:1;overflow:auto;padding:16px 18px 20px;min-height:0}
& .ed-type{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--ink-3);margin-bottom:6px}
& .ed-type .ic{width:13px;height:13px}
& .ed-title{font-size:19px;font-weight:650;line-height:1.3;margin:0 0 12px;outline:0;letter-spacing:-.01em}
& .props{display:grid;grid-template-columns:92px 1fr;gap:5px 10px;font-size:12px;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--line-2)}
& .props dt{color:var(--ink-3);display:flex;align-items:center;gap:5px}
& .props dt .ic{width:12px;height:12px}
& .props dd{margin:0;color:var(--ink);min-width:0;display:flex;flex-wrap:wrap;gap:4px;align-items:center}
& .props dd.inl{display:block}
& .lnk{color:var(--accent);cursor:pointer;text-decoration:none}
& .lnk:hover{text-decoration:underline}
& .tagc{font-size:11px;padding:0 6px;border-radius:5px;background:var(--card-2);border:1px solid var(--line-2);color:var(--ink-2);line-height:18px;cursor:pointer}
& .tagc:hover{border-color:var(--edge)}
& .recap{background:var(--violet-bg);border-radius:8px;padding:9px 11px;font-size:12.5px;margin-bottom:14px;line-height:1.5}
& .recap b{display:block;font-size:11px;color:var(--violet);font-weight:600;margin-bottom:2px}
& .ed-body{font-size:13.5px;line-height:1.62;color:var(--ink);user-select:text}
& .ed-body p{margin:0 0 11px;position:relative}
& .ed-body mark{background:var(--amber-mark);color:inherit;border-radius:2px;padding:0 1px}
& .ed-body mark.blue{background:rgba(58,103,214,.18)}& .ed-body mark.green{background:rgba(58,143,90,.2)}
& .ed-body .anc{background:rgba(58,103,214,.10);border-bottom:1.5px solid var(--branch)}
& .bmark{display:flex;align-items:center;gap:5px;margin:-6px 0 11px;font-size:11.5px;color:var(--branch);cursor:pointer;font-weight:500}
& .bmark .ic{width:12px;height:12px}
& .bmark:hover{text-decoration:underline}
& .ed-q{font-size:14.5px;line-height:1.55;background:var(--q);border:1px solid var(--q-line);border-radius:9px;padding:10px 12px;margin-bottom:14px;user-select:text}
& .ed-sec{margin-top:16px}
& .ed-sec h5{margin:0 0 6px;font-size:11.5px;font-weight:600;color:var(--ink-3);display:flex;align-items:center;gap:6px}
& .ed-sec h5 button{display:flex;align-items:center;gap:4px;color:var(--ink-3)}
& .srow{display:flex;gap:8px;align-items:center;padding:5px 0;font-size:12.5px}
& .srow .fav{margin-top:1px}
& .srow div{min-width:0;flex:1}
& .srow b{font-weight:500;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
& .srow small{color:var(--ink-3);font-size:11px}
& .step{display:flex;gap:8px;font-size:12px;padding:3px 0;color:var(--ink-2)}
& .step .k{width:46px;flex:none;color:var(--ink-3);font-size:11px;text-transform:capitalize}
& .step .d{color:var(--ink-3)}
& .step.error{color:var(--red)}
& .ed-outline{margin:0;padding-left:16px;font-size:13.5px;line-height:1.6}
& .ed-outline ul{padding-left:16px;color:var(--ink-2)}
& .refc{font-size:10.5px;color:var(--accent);border:1px solid var(--q-line);background:var(--q);border-radius:4px;padding:0 4px;margin-left:5px;cursor:pointer;white-space:nowrap}
& .hlq{font-size:15px;line-height:1.55;border-left:3px solid var(--amber);padding:2px 0 2px 12px;margin-bottom:12px}
& .pn-empty{color:var(--ink-3);font-size:12.5px;line-height:1.55}
/* composer */
& .comp{border-top:1px solid var(--line);padding:10px 12px 12px;flex:none;background:var(--panel)}
& .comp-top{display:flex;align-items:center;gap:6px;margin-bottom:7px}
& .seg{display:inline-flex;background:var(--card-2);border:1px solid var(--line);border-radius:8px;padding:2px}
& .seg button{white-space:nowrap;height:24px;padding:0 9px;border-radius:6px;font-size:12px;font-weight:500;color:var(--ink-3);display:flex;align-items:center;gap:5px}
& .seg button .ic{width:13px;height:13px}
& .seg button.on{background:var(--card);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.08)}
& .comp-top .sp{flex:1}
& .agentbtn{white-space:nowrap;overflow:hidden;min-width:0;height:26px;display:inline-flex;align-items:center;gap:6px;padding:0 8px;border-radius:7px;font-size:12px;color:var(--ink-2);border:1px solid transparent}
& .agentbtn:hover{border-color:var(--line);background:var(--card)}
& .agentbtn.locked{cursor:default}& .agentbtn.locked:hover{border-color:transparent;background:none}
& .agentbtn .ic{width:12px;height:12px;color:var(--ink-3)}
& .comp-box{border:1px solid var(--line);border-radius:10px;background:var(--card);padding:8px 10px 6px}
& .comp-box:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--sel-bg)}
& .comp-box textarea{width:100%;border:0;outline:0;resize:none;background:none;font-size:13.5px;line-height:1.45;height:44px;display:block}
& .comp-box textarea::placeholder,& .c-ask textarea::placeholder,& .c-big textarea::placeholder{color:var(--ink-3)}
& .comp-row{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--ink-3)}
& .comp-row .sp{flex:1}
& .send{width:26px;height:26px;border-radius:7px;background:var(--accent);color:var(--accent-ink);display:flex;align-items:center;justify-content:center}
& .send .ic{width:14px;height:14px}
& .send[disabled]{opacity:.4;cursor:default}
& .qchip{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--ink-2);background:var(--q);border:1px solid var(--q-line);border-radius:7px;padding:3px 4px 3px 8px;margin-bottom:6px}
& .qchip>span:not(.ic){flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
& .qchip .ic{width:12px;height:12px;color:var(--branch)}
& .hint{font-size:11.5px;color:var(--ink-3);margin:7px 2px 0;line-height:1.4}
/* pages */
& .page{position:absolute;inset:0;overflow:auto;background:var(--canvas)}
& .page-in{max-width:760px;margin:0 auto;padding:36px 40px 60px}
& .page h1{font-size:24px;font-weight:650;margin:0 0 4px;letter-spacing:-.015em}
& .page .sub{color:var(--ink-3);margin:0 0 22px;font-size:13px}
& .page h3{font-size:12px;font-weight:600;color:var(--ink-3);margin:22px 0 8px;display:flex;align-items:center;gap:6px}
& .icard{display:flex;gap:12px;align-items:flex-start;background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);padding:12px 14px;margin-bottom:8px;cursor:pointer;width:100%;text-align:left}
& .icard:hover{border-color:var(--edge)}
& .icard>div{flex:1;min-width:0}
& .icard b{font-weight:600;display:block}
& .icard p{margin:2px 0 0;color:var(--ink-2);font-size:12.5px}
& .icard small{color:var(--ink-3);font-size:11.5px}
& .icard .ib{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex:none}
& .ib.err{background:var(--red-bg);color:var(--red)}& .ib.att{background:var(--amber-bg);color:var(--amber)}& .ib.new{background:var(--accent-soft);color:var(--accent)}& .ib.run{background:var(--run-bg);color:var(--run)}& .ib.plain{background:var(--card-2);color:var(--ink-3)}
& .tbl{width:100%;border-collapse:collapse;font-size:12.5px;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;box-shadow:var(--shadow)}
& .tbl th{text-align:left;font-weight:600;color:var(--ink-3);font-size:11.5px;padding:8px 10px;border-bottom:1px solid var(--line);background:var(--card-2);white-space:nowrap}
& .tbl td{padding:8px 10px;border-bottom:1px solid var(--line-2);vertical-align:top}
& .tbl tr:last-child td{border-bottom:0}
& .tbl tbody tr{cursor:pointer}& .tbl tbody tr:hover td{background:var(--hover)}
& .tbl td b{font-weight:550}
& .tagsplit{display:flex;gap:24px}
& .taglist{width:180px;flex:none}
& .taglist .row{height:26px}
& .jday{background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);padding:18px 22px;margin-bottom:16px}
& .jday h2{font-size:16px;margin:0 0 10px;font-weight:650}
& .jday p{margin:0 0 9px;line-height:1.6;font-size:13.5px}
& .jday .t{color:var(--ink-3);font-variant-numeric:tabular-nums;margin-right:8px;font-size:12px}
& .mention{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--line);background:var(--card-2);border-radius:6px;padding:0 6px;font-size:12.5px;cursor:pointer;line-height:20px;vertical-align:baseline}
& .mention:hover{border-color:var(--edge)}
& .mention .ic{width:12px;height:12px;color:var(--ink-3)}
& .jwrite{outline:0;color:var(--ink-3)}
& .jwrite:focus{color:var(--ink)}
& .hlrow{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin-bottom:8px;box-shadow:var(--shadow);cursor:pointer}
& .hlrow:hover{border-color:var(--edge)}
& .hlrow q{display:block;quotes:none;border-left:3px solid var(--amber);padding-left:10px;font-size:13.5px;line-height:1.5}
& .hlrow small{display:block;color:var(--ink-3);margin-top:6px;font-size:11.5px}
& .hlrow .nt{font-size:12.5px;color:var(--ink-2);margin-top:4px;padding-left:13px}
& .ptabs{display:flex;gap:4px;margin-bottom:14px}
/* overlays */
& .scrim{position:absolute;inset:0;background:rgba(20,20,16,.28);z-index:30;display:flex;align-items:flex-start;justify-content:center}
&[data-theme="dark"] .scrim{background:rgba(0,0,0,.5)}
& .ovl{margin-top:34px;width:640px;max-height:calc(100% - 68px);background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow-2);display:flex;flex-direction:column;overflow:hidden}
& .ovl .pn-s{padding:22px 34px 28px}
& .ovl .ed-title{font-size:23px}
& .pal{margin-top:80px;width:560px;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow-2);overflow:hidden}
& .pal input{width:100%;border:0;outline:0;background:none;padding:14px 16px;font-size:15px;border-bottom:1px solid var(--line)}
& .pal .res{max-height:360px;overflow:auto;padding:6px}
& .pal .lrow{cursor:pointer}& .pal .lrow.on{background:var(--sel-bg)}
& .menu{position:absolute;z-index:40;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow-2);padding:5px;min-width:220px}
& .menu .mh{font-size:11px;color:var(--ink-3);padding:6px 8px 3px;font-weight:600}
& .menu .mi{display:flex;align-items:center;gap:8px;height:28px;padding:0 8px;border-radius:6px;width:100%;text-align:left;font-size:12.5px}
& .menu .mi:hover{background:var(--hover)}
& .menu .mi .ic{width:14px;height:14px;color:var(--ink-3)}
& .menu .mi .ck{margin-left:auto;color:var(--accent)}
& .menu .mi small{color:var(--ink-3);margin-left:auto;font-family:"JetBrains Mono",monospace;font-size:10.5px}
& .menu .msep{height:1px;background:var(--line);margin:4px 2px}
& .toast{position:absolute;left:50%;bottom:24px;transform:translateX(-50%);z-index:50;background:var(--ink);color:var(--bg);padding:8px 14px;border-radius:9px;font-size:12.5px;box-shadow:var(--shadow-2);display:flex;gap:8px;align-items:center;white-space:nowrap}
& .ghost{position:absolute;z-index:60;pointer-events:none;background:var(--card);border:1px solid var(--accent);border-radius:9px;box-shadow:var(--shadow-2);padding:8px 10px;width:220px;font-size:12.5px;font-weight:550;transform:rotate(-1.5deg)}
& .ghost small{display:block;color:var(--ink-3);font-weight:400;font-size:11px}
& .selbar{position:absolute;z-index:45;transform:translate(-50%,-100%)}
`;
var CSS = RAW.replace(/&/g, "." + SC);

/* ---------------------------------------------------------------- icons */
var ICON = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  journal: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M9 7h7"/>',
  library: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  tag: '<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
  highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  board: '<rect x="3" y="3" width="18" height="18" rx="3"/><rect x="6.5" y="7" width="5" height="4" rx="1"/><rect x="12.5" y="13" width="5" height="4" rx="1"/><path d="M9 11v4h3.5"/>',
  chevR: '<path d="m9 18 6-6-6-6"/>', chevD: '<path d="m6 9 6 6 6-6"/>', chevUD: '<path d="m7 15 5 5 5-5M7 9l5-5 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>',
  fit: '<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/>',
  cursor: '<path d="m4 4 7 17 2.5-7.5L21 11z"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  note: '<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5z"/><path d="M15 3v6h6M7 13h8M7 17h5"/>',
  section: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M3 11v2M21 11v2M11 3h2M11 21h2"/>',
  connect: '<circle cx="5" cy="19" r="2"/><path d="M7 17 19 5"/><path d="M11 5h8v8"/>',
  ask: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  down: '<path d="M12 5v14M19 12l-7 7-7-7"/>', right: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  branch: '<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 7.2v9.6M18 10.2c0 4.5-6.5 3.3-11 6.6"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>', alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  open: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
  sidebar: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  trace: '<path d="M4 6h16M4 12h10M4 18h6"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  tidy: '<rect x="3" y="3" width="7" height="5" rx="1"/><rect x="14" y="10" width="7" height="5" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/><path d="M10 5.5h2v7h2M6.5 8v8"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
  draft: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  retry: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>',
  answer: '<path d="M4 5h16M4 10h16M4 15h10M4 20h6"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 4.9.8c0 1.7-2.4 2.2-2.4 3.7M12 17h.01"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>'
};

/* ------------------------------------------------------------- helpers */
function h(tag, p) {
  var n = document.createElement(tag);
  if (p) for (var k in p) {
    var v = p[k];
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
    else if (k.slice(0, 2) === "on" && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (var i = 2; i < arguments.length; i++) addKids(n, arguments[i]);
  return n;
}
function dv(c) { return h("div", { class: c }, [].slice.call(arguments, 1)); }
function sn(c) { return h("span", { class: c }, [].slice.call(arguments, 1)); }
function addKids(n, k) {
  if (k == null || k === false) return;
  if (Array.isArray(k)) { k.forEach((x) => { addKids(n, x); }); return; }
  n.append(k.nodeType ? k : document.createTextNode(String(k)));
}
function ic(name, cls) {
  var s = document.createElement("span");
  s.className = "ic" + (cls ? " " + cls : "");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (ICON[name] || "") + "</svg>";
  return s;
}
function clone(x) { return JSON.parse(JSON.stringify(x)); }
var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function pad(n) { return n < 10 ? "0" + n : "" + n; }
function fmtTime(iso, now) {
  if (!iso) return "";
  var d = new Date(iso);
  var t = pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
  if (now && d.getUTCDate() === now.getUTCDate() && d.getUTCMonth() === now.getUTCMonth()) return "Today " + t;
  return MON[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + t;
}
function fmtDur(s) {
  if (s == null) return "";
  if (s < 60) return s + "s";
  var m = Math.floor(s / 60), r = s % 60;
  return m >= 60 ? Math.floor(m / 60) + "h " + (m % 60) + "m" : m + "m" + (r ? " " + r + "s" : "");
}
function plain(md) { return String(md || "").replace(/^#+\s*/gm, "").replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); }
function md(text) {
  var out = [], re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g, last = 0, m;
  text = String(text || "").replace(/^#+\s*/gm, "");
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) out.push(h("code", null, m[1]));
    else if (m[2] != null) out.push(h("b", null, m[2]));
    else out.push(h("a", { class: "lnk", title: m[4] }, m[3]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function pill(status, statuses) {
  var s = statuses[status] || { label: status, tone: "plain" };
  return h("span", { class: "pill " + s.tone }, s.label);
}

/* ------------------------------------------------------------ layout k */
var QW = 264, QH = 104, AW = 264, GQA = 26, GF = 70, LANE = 140, HLW = 120, HLH = 88, PITCH = 444;
var BW = 264, BH = 168, SECW = 304, SECGAP = 116;
function aH(t) { return t.status === "queued" ? 132 : t.status === "failed" ? 176 : 212; }
function anchorOff(p, ah) { return Math.max(44, Math.min(ah - 30, 70 + (p || 0) * 34)); }

var CANNED = {
  "ws-compilers": [
    "Checked `src/jit/arm64/masm.rs` and the DataView tests in `tests/jit/dataview.rs` on the current checkout.",
    "Every big-endian 16-bit load now goes through `load16_be_signed`, so sign extension happens after the byte swap. The interpreter and the baseline JIT agree on all 300 sweep cases, including reads that end exactly at a page boundary.",
    "No other call site emits `ldrsh` before `rev16`: `rg ldrsh src/jit` returns only the fixed helper."
  ],
  "ws-ml": [
    "Read `allocator/paged.py` and the last benchmark logs in `bench/kv/`.",
    "With 16-token blocks, internal fragmentation drops from 6.1% to 3.2% of KV memory at batch 64. Block-table lookups add about 2% decode latency at 32k context.",
    "The change is local to `BlockAllocator.allocate`; prefix-cache hit rates are unchanged on the replay trace."
  ],
  "ws-reading": [
    "Compared the two sources cited in the parent answer.",
    "Both describe the same constraint: a configuration change must not let two disjoint majorities exist at the same time. The single-server method satisfies it only if a leader commits an entry in its own term before starting the next change.",
    "That rule is the fix Ongaro posted on raft-dev in 2015."
  ],
  "ws-new": [
    "Searched the workspace directory and read the files the question refers to.",
    "This answer is sample text produced by the mock. In the app, the agent CLI runs in this workspace's directory with your existing sign-in; its tool calls appear in the run trace while the answer streams into this card.",
    "Open the card to read sources and the trace, select a passage to branch from it, or ask a follow-up below."
  ]
};
var STEPS = {
  "ws-compilers": [["read", "Read src/jit/arm64/masm.rs"], ["grep", "Searched code: ldrsh"], ["run", "Ran cargo test -p kestrel-jit dataview"]],
  "ws-ml": [["read", "Read allocator/paged.py"], ["grep", "Searched code: block_size"], ["run", "Ran python bench/kv/fragmentation.py"]],
  "ws-reading": [["fetch", "Fetched raft.github.io/raft.pdf"], ["search", "Searched web: raft single server change bug"], ["think", "Compared both methods"]],
  "ws-new": [["read", "Listed ~/research/untitled"], ["search", "Searched web for the question"], ["think", "Drafted the answer"]]
};

  var REUSE = { t1: "a:t1q1", t2: "a:t2q1", t3: "a:t3q1" };
  var TIPS = [
    ["Question card", "What you asked and which agent and model answer it."],
    ["Answer card", "Streams in while the agent works. Click it to read the full answer, its sources and the run trace."],
    ["Follow-up ↓", "Continues the same conversation below the answer. The agent keeps the context of everything above."],
    ["Branch →", "Asks about one passage in a separate conversation to the right. The main line is not changed."],
    ["Cards are reusable", "Drag an answer, note or highlight onto another whiteboard in the sidebar. It is the same card, shown in both places."]
  ];
  var TYPEIC = { answer: ["answer", "a"], question: ["ask", "q"], note: ["note", "n"], highlight: ["highlight", "h"], source: ["globe", "s"], board: ["board", "b"] };

/* ------------------------------------------------------------ register */
window.SessionMocks.register({
  id: "heptabase", round: 1,
  name: "Research Whiteboards",
  reference: "Heptabase",
  summary: "Every research tree is a whiteboard laid out automatically: question cards lead to answer cards, follow-ups continue downward and branches grow to the right, connected by labelled arrows. Workspaces are whiteboards too, with folders as sections, so answers, notes, highlights and sources become cards you can arrange, link and reuse.",
  principles: [
    "Spatial tree: the whole research tree is always visible. Follow-up = arrow down in the same column; Branch = arrow to the right from the quoted paragraph (fixes the two-columns-per-level scroll, UX-03/UX-08/UX-09).",
    "Everything is a card: questions, answers, highlights, sources and your own notes. A card can sit on several whiteboards; every card shows 'in N whiteboards' (UX-11).",
    "Renamed for clarity: a research tree is a 'research whiteboard'; a folder is a 'section' on the workspace whiteboard. Filing a whiteboard moves it between sections; nothing disappears from Home (UX-04/UX-05).",
    "The card you select is the card you ask about: the right panel shows the card and an ask box with an explicit Follow-up / Branch switch and the agent and model always visible (UX-12/UX-17).",
    "One attention place: Inbox lists finished, failed, waiting-for-you and queued runs; whiteboard rows in the sidebar carry the same status dots (brief §6.8).",
    "Card Library and tag tables provide the knowledge-base view: search every card, filter by type, drag any card onto a whiteboard.",
    "Calm canvas: light dotted grid, soft shadows, minimap, zoom controls, ⌘/Ctrl+wheel zoom, drag to pan, arrow keys move between connected cards."
  ],
  chat: "Select any answer card and type in the panel's ask box (or the inline Ask card in variant B). Choose Follow-up to continue the conversation below the answer, or Branch to start a side conversation to the right; selecting a passage in the opened card and pressing Branch quotes it. The new question and answer appear as connected cards and the answer streams into its card while the run trace fills in. A follow-up sent while an answer is running is placed as a Queued card with the reason stated.",
  knowledge: "The workspace whiteboard is the map: sections (former folders) hold nested research whiteboards, notes and reused answer cards, with 'related' connections between threads. Highlights become amber cards next to their answer; sources collect in a Sources section; the Card Library lists every card with how many whiteboards use it, and each tag opens as a table of its cards.",
  firstRun: "A new workspace opens a 'Start here' whiteboard: a large Ask card, an agent setup card that states which CLIs are ready and the exact sign-in command, and a small sample tree annotated in place (question, answer, follow-up, branch, reuse). Asking the first question creates a research whiteboard and streams the answer into it. Reachable from the workspace menu (New workspace…) or the sidebar's Start here row.",
  changes: [],
  variants: [
    { id: "a", name: "Tree board + card panel", note: "Research whiteboard laid out as a tree; the selected card opens in a right-hand panel whose ask box sends follow-ups or branches." },
    { id: "b", name: "Inline Ask cards", note: "No side panel: you ask from a dashed Ask card placed on the board where the answer will appear, and cards open as a focused overlay." },
    { id: "c", name: "Workspace map", note: "Opens on the workspace whiteboard: folders as sections, nested research whiteboards with tree thumbnails, notes, and an answer card reused from a thread." },
    { id: "d", name: "Card Library first", note: "Sidebar collapses to a rail and the Card Library is the left pane; drag any card from it onto the whiteboard to reuse it." },
    { id: "e", name: "First run: Start here", note: "A new, empty workspace opens a sample whiteboard that explains question, answer, follow-up and branch in place, with agent setup and a large Ask card." }
  ],
  fonts: "family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500",
  css: CSS,
  mount: mount
});

/* ================================================================ mount */
function mount(root, ctx) {
var V = ctx.variant || "a";
var src = ctx.data;
var D = prep(src);
var NOW = new Date(src.now), T0 = Date.now();
function nowIso() { return new Date(NOW.getTime() + (Date.now() - T0)).toISOString(); }
var timers = [];
var offs = [];
function later(fn, ms) { var t = setTimeout(fn, ms); timers.push(t); return t; }
function on(el, ev, fn, opt) { el.addEventListener(ev, fn, opt); offs.push(() => { el.removeEventListener(ev, fn, opt); }); }

/* ---------------- boards */
var B = {};
D.threads.forEach((t) => { B["r:" + t.id] = buildResearch(t); });
D.workspaces.forEach((w) => { B["w:" + w.id] = buildWorkspace(w); });
B["welcome"] = buildWelcome();

var st = {
  ws: "ws-compilers", view: "board", boardId: "r:t1", sel: null, panel: true,
  overlay: null, tool: "select", legend: V === "b", tabs: [], lib: { q: "", type: "all" },
  tag: "jit", collapsed: { archive: true }, comp: { text: "", mode: "followup", quote: null },
  agent: { provider: "claude", model: "opus", effort: "high" }, ask: null, menu: null, palette: null, toast: null,
  hlTab: "highlights", newSeq: 0
};
if (V === "a") { st.sel = "a:t1q1"; }
if (V === "b") { st.panel = false; st.sel = "a:t1q2"; }
if (V === "c") { st.boardId = "w:ws-compilers"; st.sel = "a:t1q1"; st.panel = false; }
if (V === "d") { st.ws = "ws-ml"; st.boardId = "r:t3"; st.sel = null; st.panel = false; }
if (V === "e") { st.ws = "ws-new"; st.boardId = "welcome"; st.panel = false; st.sel = null; }
st.tabs = V === "e" ? ["welcome"] : V === "c" ? ["w:ws-compilers", "r:t1"] : V === "d" ? ["w:ws-ml", "r:t3"] : ["w:" + st.ws, st.boardId];
if (V === "b") {
  st.ask = { mode: "followup", parent: "t1q2", text: "" };
  placeAsk(B["r:t1"]);
}

root.setAttribute("tabindex", "-1");
var E = {};

/* ================================================ data prep */
function prep(s) {
  var d = {
    providers: s.providers, statuses: s.statuses, user: s.user,
    workspaces: clone(s.workspaces).concat([{ id: "ws-new", name: "New workspace", dir: "~/research/untitled", fresh: true }]),
    folders: clone(s.folders), threads: clone(s.threads), notes: clone(s.notes), drafts: clone(s.drafts), inbox: clone(s.inbox)
  };
  d.th = {}; d.tu = {}; d.hl = {}; d.src = {}; d.notesById = {};
  d.threads.forEach((t) => {
    d.th[t.id] = t;
    t.turns.forEach((u) => {
      u.threadId = t.id; d.tu[u.id] = u;
      u.highlights.forEach((x) => { x.turnId = u.id; x.threadId = t.id; d.hl[x.id] = x; });
      u.sources.forEach((x) => {
        var k = x.url; if (!d.src[k]) d.src[k] = { url: x.url, title: x.title, domain: x.domain, refs: [] };
        d.src[k].refs.push(u.id);
      });
    });
  });
  d.notes.forEach((n) => { d.notesById[n.id] = n; });
  return d;
}
function provLabel(id) { var p = D.providers.find((x) => x.id === id); return p ? p.label : id; }
function agentText(o, withEffort) { return provLabel(o.provider) + " · " + o.model + (withEffort !== false && o.effort ? " · " + o.effort : ""); }
function wsOf(id) { return D.workspaces.find((w) => w.id === id); }

/* ================================================ board builders */
function newBoard(id, kind, title, ws) { return { id: id, kind: kind, title: title, ws: ws, cards: [], sections: [], edges: [], view: null }; }
function addCard(b, id, x, y, w, hh) { var c = { id: id, x: x, y: y, w: w, h: hh }; b.cards.push(c); return c; }
function addEdge(b, from, to, kind, o) { var e = { from: from, to: to, kind: kind }; if (o) Object.assign(e, o); b.edges.push(e); return e; }
function find(b, id) { for (var i = 0; i < b.cards.length; i++) if (b.cards[i].id === id) return b.cards[i]; return null; }
function mainCardId(u) { return u.post ? "q:" + u.id : "a:" + u.id; }

function buildResearch(th) {
  var b = newBoard("r:" + th.id, "research", th.title, th.workspaceId);
  b.threadId = th.id;
  layoutResearch(b, th);
  return b;
}
function layoutResearch(b, th) {
  b.cards = []; b.edges = []; b.sections = [];
  var kids = {};
  th.turns.forEach((u) => { if (u.parentId) (kids[u.parentId] = kids[u.parentId] || []).push(u); });
  var colNext = {};
  if (th.recap) addCard(b, "recap:" + th.id, 0, -168, AW, 132);
  function place(u, col, y) {
    var x = col * PITCH;
    if (colNext[col] != null) y = Math.max(y, colNext[col]);
    var main, mh, my;
    if (u.post) {
      addCard(b, "q:" + u.id, x, y, QW, 150); main = "q:" + u.id; mh = 150; my = y;
    } else {
      addCard(b, "q:" + u.id, x, y, QW, QH);
      my = y + QH + GQA; mh = aH(u); main = "a:" + u.id;
      addCard(b, main, x, my, AW, mh);
      addEdge(b, "q:" + u.id, main, "qa");
    }
    u.highlights.slice(0, 2).forEach((hl, i) => {
      addCard(b, "h:" + hl.id, x - LANE, my + i * (HLH + 14), HLW, HLH);
      addEdge(b, "h:" + hl.id, main, "hl");
    });
    colNext[col] = my + mh + GF;
    var ch = kids[u.id] || [];
    ch.filter((c) => c.relation === "branch").forEach((c) => {
      var off = anchorOff(c.anchor && c.anchor.paragraph, mh);
      place(c, col + 1, my + off - QH / 2);
      addEdge(b, main, "q:" + c.id, "branch", { fy: off, label: "Branch" });
    });
    ch.filter((c) => c.relation !== "branch").forEach((c) => {
      place(c, col, colNext[col]);
      addEdge(b, main, "q:" + c.id, "followup", { label: "Follow-up" });
    });
  }
  place(D.tu[th.rootTurnId], 0, 0);
  // sources section
  var urls = [];
  th.turns.forEach((u) => { u.sources.forEach((s) => { if (urls.indexOf(s.url) < 0) urls.push(s.url); }); });
  if (urls.length) {
    var bb = bounds(b.cards), per = Math.min(4, urls.length), SW = 212, SH = 74;
    var sx = Math.min(bb.x, 0) , sy = bb.y + bb.h + 90;
    var rows = Math.ceil(urls.length / per);
    b.sections.push({ id: "sources", label: "Sources", count: urls.length, tone: "gray", x: sx - 20, y: sy - 48, w: per * SW + (per - 1) * 16 + 40, h: rows * SH + (rows - 1) * 16 + 68 });
    urls.forEach((u, i) => { addCard(b, "s:" + u, sx + (i % per) * (SW + 16), sy + Math.floor(i / per) * (SH + 16), SW, SH); });
  }
}
function noteH(n) { var c = 0; n.outline.forEach((o) => { c++; if (o.children) c += Math.min(o.children.length, 3); }); return Math.min(250, 70 + Math.min(c, 8) * 21); }

function buildWorkspace(w) {
  var b = newBoard("w:" + w.id, "workspace", w.name, w.id);
  layoutWorkspace(b, w);
  return b;
}
function layoutWorkspace(b, w) {
  b.cards = []; b.edges = []; b.sections = [];
  var ths = D.threads.filter((t) => t.workspaceId === w.id);
  var secs = D.folders.filter((f) => f.workspaceId === w.id).map((f) => {
    return { id: f.id, label: f.name, items: ths.filter((t) => t.folderId === f.id && !t.archivedAt) };
  });
  secs.push({ id: "unfiled", label: "Unfiled", items: ths.filter((t) => !t.folderId && !t.archivedAt) });
  var arch = ths.filter((t) => t.archivedAt);
  var notes = D.notes.filter((n) => n.workspaceId === w.id);
  var drafts = D.drafts.filter((d) => d.workspaceId === w.id);
  var tones = ["blue", "green", "violet", "amber"];
  var secOf = {};
  var x = 0, used = {};
  secs = secs.filter((s) => s.items.length || (s.id === "unfiled" && drafts.length));
  secs.forEach((s, si) => {
    var y = 52, prev = null, prevThread = null;
    s.items.forEach((t) => {
      var c = addCard(b, "b:" + t.id, x + 20, y, BW, BH); secOf[t.id] = si; y += BH + 60;
      prev = c; prevThread = t.id;
      if (REUSE[t.id]) {
        addCard(b, REUSE[t.id], x + 20, y, BW, 212);
        addEdge(b, c.id, REUSE[t.id], "ref", { label: "Root answer" });
        prev = find(b, REUSE[t.id]); y += 212 + 60;
      }
      notes.forEach((n) => {
        if (used[n.id]) return;
        var first = firstRefThread(n);
        if (first !== t.id) return;
        used[n.id] = 1;
        var nh = noteH(n);
        addCard(b, "n:" + n.id, x + 20, y, BW, nh);
        addEdge(b, prev.id, "n:" + n.id, "ref", { label: "Noted in" });
        prev = find(b, "n:" + n.id); y += nh + 60;
      });
    });
    if (s.id === "unfiled") drafts.forEach((d) => { addCard(b, "d:" + d.id, x + 20, y, BW, 136); y += 136 + 60; });
    b.sections.push({ id: s.id, label: s.label, count: s.items.length, tone: s.id === "unfiled" ? "gray" : tones[si % tones.length], x: x, y: 0, w: SECW, h: y - 60 + 22 });
    x += SECW + SECGAP;
  });
  notes.forEach((n) => {
    if (used[n.id]) return;
    var last = b.sections[b.sections.length - 1];
    var nh = noteH(n);
    addCard(b, "n:" + n.id, last.x + 20, last.y + last.h + 40, BW, nh);
    last.h += nh + 40 + 22;
  });
  if (arch.length) {
    var last = b.sections[b.sections.length - 1];
    var ay = last.y + last.h + 50;
    b.sections.push({ id: "archive", label: "Archive", count: arch.length, tone: "gray", x: last.x, y: ay, w: SECW, h: 52 + arch.length * (BH + 60) - 60 + 22 });
    arch.forEach((t, i) => { addCard(b, "b:" + t.id, last.x + 20, ay + 52 + i * (BH + 60), BW, BH); });
  }
  var seen = {};
  ths.forEach((t) => {
    t.links.forEach((l) => {
      var k = [t.id, l].sort().join("-");
      if (seen[k] || secOf[t.id] == null || secOf[l] == null) return;
      seen[k] = 1;
      if (Math.abs(secOf[t.id] - secOf[l]) !== 1) return;
      var a = secOf[t.id] < secOf[l] ? t.id : l, c = a === t.id ? l : t.id;
      addEdge(b, "b:" + a, "b:" + c, "related", { label: "Related" });
    });
  });
}
function firstRefThread(n) {
  var r = null;
  (function walk(list) { list.forEach((o) => { if (!r && o.ref) r = o.ref.threadId; if (o.children) walk(o.children); }); })(n.outline);
  return r;
}

function buildWelcome() {
  var b = newBoard("welcome", "welcome", "Start here", "ws-new");
  b.sections.push({ id: "w1", label: "1 · Ask your first question", tone: "blue", x: 0, y: 0, w: 600, h: 284 });
  addCard(b, "start:ask", 20, 50, 560, 214);
  b.sections.push({ id: "w2", label: "Agents on this Mac", tone: "green", x: 640, y: 0, w: 470, h: 284 });
  addCard(b, "start:setup", 660, 50, 430, 214);
  b.sections.push({ id: "w3", label: "2 · How a research whiteboard grows", sub: "Sample cards from another workspace", tone: "gray", x: 0, y: 324, w: 1110, h: 556 });
  addCard(b, "sq:t1q1", 40, 378, QW, QH);
  addCard(b, "sa:t1q1", 40, 508, AW, 180);
  addEdge(b, "sq:t1q1", "sa:t1q1", "qa");
  addCard(b, "sq:t1q2", 40, 758, QW, QH);
  addEdge(b, "sa:t1q1", "sq:t1q2", "followup", { label: "Follow-up" });
  addCard(b, "sq:t1q3", 600, 482, QW, QH);
  addEdge(b, "sa:t1q1", "sq:t1q3", "branch", { fy: 70, label: "Branch" });
  addCard(b, "sa:t1q3", 600, 612, AW, 150);
  addEdge(b, "sq:t1q3", "sa:t1q3", "qa");
  addCard(b, "tip:1", 336, 380, 220, 90);
  addCard(b, "tip:2", 336, 618, 220, 104);
  addCard(b, "tip:3", 336, 758, 220, 104);
  addCard(b, "tip:4", 600, 378, 260, 90);
  addCard(b, "tip:5", 896, 612, 196, 150);
  return b;
}
function bounds(cards, secs) {
  var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  (cards || []).concat(secs || []).forEach((c) => { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h); });
  if (x0 > x1) return { x: 0, y: 0, w: 100, h: 100 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* ================================================ card info */
function info(cid) {
  var i = cid.indexOf(":"), k = cid.slice(0, i), id = cid.slice(i + 1);
  switch (k) {
    case "q": case "sq": return { type: "question", turn: D.tu[id], sample: k === "sq" };
    case "a": case "sa": return { type: "answer", turn: D.tu[id], sample: k === "sa" };
    case "h": return { type: "highlight", hl: D.hl[id] };
    case "s": return { type: "source", src: D.src[id] };
    case "n": return { type: "note", note: D.notesById[id] };
    case "b": return { type: "board", thread: D.th[id] };
    case "recap": return { type: "recap", thread: D.th[id] };
    case "d": return { type: "draft", draft: D.drafts.find((x) => x.id === id) };
    case "ask": return { type: "ask" };
    case "tip": return { type: "tip", n: +id };
    case "start": return { type: id === "ask" ? "start" : "setup" };
  }
  return { type: "unknown" };
}
function cardTitle(cid) {
  var f = info(cid);
  switch (f.type) {
    case "question": return f.turn.post ? f.turn.post.linkTitle : plain(f.turn.question);
    case "answer": return f.turn.title;
    case "highlight": return f.hl.quote;
    case "source": return f.src.title;
    case "note": return f.note.title;
    case "board": return f.thread.title;
    case "recap": return "Recap: " + f.thread.title;
    case "draft": return f.draft.prompt;
  }
  return "";
}
function usedIn(cid) {
  var out = [];
  Object.keys(B).forEach((k) => { if (find(B[k], cid)) out.push(B[k]); });
  return out;
}
function homeBoardOf(cid) {
  var f = info(cid);
  if (f.turn) return "r:" + f.turn.threadId;
  if (f.hl) return "r:" + f.hl.threadId;
  if (f.src) return "r:" + D.tu[f.src.refs[0]].threadId;
  if (f.note) return "w:" + f.note.workspaceId;
  if (f.type === "board") return "w:" + f.thread.workspaceId;
  if (f.draft) return "w:" + f.draft.workspaceId;
  return st.boardId;
}

/* ================================================ render: card bodies */
function cardNode(b, pl) {
  var f = info(pl.id);
  var cls = "card", kids = [];
  var sel = st.sel === pl.id;
  if (f.type === "question") {
    var u = f.turn;
    cls += " c-q" + (u.anchor ? " has-quote" : "");
    if (u.post) {
      kids.push(dv("ch", ic("link"), "Saved link", sn("sp"), u.post.domain));
      kids.push(dv("ct", u.post.linkTitle));
      kids.push(dv("cb", "By " + u.post.author + ". Saved as a link card; ask about it below."));
    } else {
      var lab = u.relation === "branch" ? [ic("branch"), "Branch question"] : u.relation === "followup" ? [ic("down"), "Follow-up"] : D.th[u.threadId].kind === "document" ? [ic("file"), "Prompt for imported report"] : [ic("ask"), "Question"];
      kids.push(dv("ch", lab, sn("sp"), sn("agent", h("i", { class: "pdot " + u.provider }), u.model)));
      if (u.anchor) kids.push(dv("quote", "“" + plain(u.anchor.quote) + "”"));
      kids.push(dv("cb", md(u.question)));
    }
  } else if (f.type === "answer") {
    var t = f.turn;
    cls += " c-a" + (t.status === "running" ? " running" : "");
    var reuse = usedIn("a:" + t.id).length;
    var th = D.th[t.threadId];
    kids.push(dv("ch", th.kind === "document" && !t.parentId ? [ic("file"), "Imported report"] : [ic("answer"), "Answer"], sn("sp"),
      t.status !== "done" ? pill(t.status, D.statuses) : (th.unread && isNewTurn(t) ? sn("pill new", "New") : null)));
    kids.push(dv("ct", t.title));
    if (t.status === "failed") {
      kids.push(dv("box err", t.error || "The run failed.", dv("acts", h("button", { class: "mini", onclick: (e) => { e.stopPropagation(); retry(t); } }, "Retry"), h("button", { class: "mini", onclick: (e) => { e.stopPropagation(); select("a:" + t.id); openCard("a:" + t.id); } }, "Show trace"))));
      kids.push(dv("cb"));
    } else if (t.status === "queued") {
      var run = runningSibling(t);
      kids.push(dv("box plain", "Queued. Runs after “" + (run ? run.title : "the running answer") + "” finishes; a conversation runs one answer at a time."));
      kids.push(dv("cb"));
    } else {
      if (t.status === "needs-review" && t.clarification) {
        kids.push(dv("box att", h("b", null, provLabel(t.provider) + " asks: "), t.clarification,
          dv("acts", h("button", { class: "mini pri", onclick: (e) => { e.stopPropagation(); select("a:" + t.id); startAsk("followup", t.id); } }, "Reply"))));
      }
      var paras = t.answer.slice(0, t.status === "needs-review" ? 1 : 3);
      kids.push(dv("cb", paras.map((p) => h("p", null, md(p)))));
    }
    var foot = [];
    if (t.status === "running") {
      var last = t.activity[t.activity.length - 1];
      foot.push(h("span", { style: { color: "var(--run)" } }, ic("clock"), last ? last.label : "Starting"));
    } else {
      if (t.sources.length) foot.push(h("span", null, ic("globe"), t.sources.length));
      if (t.highlights.length) foot.push(h("span", null, ic("highlight"), t.highlights.length));
      if (t.durationSec) foot.push(h("span", null, fmtDur(t.durationSec)));
    }
    foot.push(h("i", { class: "sp" }));
    if (reuse > 1 && !f.sample) foot.push(h("span", { class: "reuse", title: "This card is on " + reuse + " whiteboards" }, ic("board"), "in " + reuse));
    kids.push(dv("cf", foot));
    b.edges.forEach((e) => {
      if (e.from === pl.id && e.kind === "branch" && e.fy != null) kids.push(h("i", { class: "tick", style: { top: (e.fy - 8) + "px" } }));
    });
  } else if (f.type === "highlight") {
    var hl = f.hl;
    cls += " c-h " + (hl.color || "amber");
    kids.push(dv("ch", ic("highlight"), "Highlight"));
    kids.push(dv("cb", h("mark", null, hl.quote)));
  } else if (f.type === "source") {
    cls += " c-s";
    kids.push(dv("ch", sn("fav", f.src.domain.charAt(0).toUpperCase()), f.src.domain, sn("sp"), f.src.refs.length > 1 ? "cited " + f.src.refs.length + "×" : null));
    kids.push(dv("ct", f.src.title));
  } else if (f.type === "note") {
    cls += " c-n";
    var n = f.note;
    kids.push(dv("ch", ic("note"), "Note", sn("sp"), fmtTime(n.updatedAt, NOW)));
    kids.push(dv("ct", n.title));
    kids.push(dv("cb", h("ul", null, n.outline.map((o) => {
      return h("li", null, o.text, o.children ? h("ul", null, o.children.slice(0, 3).map((c) => h("li", null, c.text))) : null);
    }))));
  } else if (f.type === "board") {
    cls += " c-b";
    var th2 = f.thread, rb = B["r:" + th2.id];
    var qs = th2.turns.length, brs = th2.turns.filter((x) => x.relation === "branch").length;
    kids.push(dv("ch", ic("board"), "Research whiteboard", sn("sp"), threadPill(th2)));
    kids.push(dv("ct", th2.title));
    var th3 = dv("thumb"); th3.innerHTML = thumbSvg(rb); kids.push(th3);
    kids.push(dv("cf", h("span", null, qs + (qs === 1 ? " question" : " questions")), brs ? h("span", null, ic("branch"), brs) : null, h("i", { class: "sp" }), h("span", null, fmtTime(th2.updatedAt, NOW))));
  } else if (f.type === "recap") {
    cls += " c-r";
    kids.push(dv("ch", ic("sparkle"), "Recap", sn("sp"), "generated · opus"));
    kids.push(dv("cb", f.thread.recap));
  } else if (f.type === "draft") {
    cls += " c-d";
    kids.push(dv("ch", ic("draft"), "Draft question · not sent"));
    kids.push(h("div", { class: "cb", style: { color: "var(--ink)" } }, f.draft.prompt));
    kids.push(dv("cf", sn("agent", h("i", { class: "pdot " + f.draft.provider }), agentText(f.draft, false)), h("i", { class: "sp" }),
      h("button", { class: "mini pri", onclick: (e) => { e.stopPropagation(); sendDraft(f.draft); } }, "Ask")));
  } else if (f.type === "ask") {
    cls += " c-ask";
    var a = st.ask, pt = D.tu[a.parent];
    kids.push(dv("ch", a.mode === "branch" ? [ic("branch"), "Branch from “" + pt.title + "”"] : [ic("down"), "Follow-up to “" + pt.title + "”"], sn("sp"),
      h("button", { class: "iconbtn", title: "Cancel (Esc)", style: { width: "20px", height: "20px" }, onclick: (e) => { e.stopPropagation(); cancelAsk(); } }, ic("x"))));
    if (a.quote) kids.push(dv("quote", "“" + a.quote.quote + "”"));
    var ta = h("textarea", { placeholder: a.mode === "branch" ? "Ask a side question; the main conversation stays as it is…" : "Ask a follow-up; it continues this conversation…", "aria-label": "Ask" });
    ta.value = a.text || "";
    ta.addEventListener("input", () => { a.text = ta.value; });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitAsk(); } if (e.key === "Escape") { e.stopPropagation(); cancelAsk(); } });
    kids.push(ta);
    var agentO = a.mode === "followup" ? pt : st.agent;
    kids.push(dv("cf", sn("agent", h("i", { class: "pdot " + agentO.provider }), agentText(agentO)), h("i", { class: "sp" }), h("span", null, "Enter to ask · Esc to cancel")));
  } else if (f.type === "tip") {
    cls += " c-tip";
    var T = TIPS[f.n - 1];
    kids.push(dv("tt", sn("num", String(f.n)), T[0]), h("p", null, T[1]));
  } else if (f.type === "start") {
    cls += " c-big";
    var sta = h("textarea", { placeholder: "What do you want to find out? For example: why does getInt16 return 32769 on ARM64?", "aria-label": "Ask your first question" });
    sta.value = st.comp.text;
    sta.addEventListener("input", () => { st.comp.text = sta.value; });
    sta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (sta.value.trim()) startThread(sta.value.trim(), true); } });
    kids.push(dv("ct", "Ask a question"));
    kids.push(h("div", { class: "ch", style: { paddingTop: "2px", whiteSpace: "normal" } }, "The agent runs on this Mac with your existing sign-in, in ~/research/untitled. The answer becomes cards on a new research whiteboard."));
    kids.push(sta);
    kids.push(dv("cf", agentButton(st.agent, false), h("i", { class: "sp" }), h("span", null, "Enter to ask"),
      h("button", { class: "btn pri", onclick: (e) => { e.stopPropagation(); if (st.comp.text.trim()) startThread(st.comp.text.trim(), true); else { sta.focus(); } } }, "Ask", ic("send"))));
  } else if (f.type === "setup") {
    cls += " c-setup";
    kids.push(h("div", { class: "ch", style: { paddingBottom: "4px" } }, ic("terminal"), "Session runs these command-line agents. One ready agent is enough.", sn("sp")));
    kids.push(dv("setup-row", h("i", { class: "pdot claude" }), h("div", null, h("b", null, "Claude Code"), h("small", null, "Signed in · opus, sonnet, fable")), sn("pill ok", ic("check"), "Ready")));
    kids.push(dv("setup-row", h("i", { class: "pdot codex" }), h("div", null, h("b", null, "Codex"), h("small", null, "Installed, not signed in. Run ", h("code", null, "codex login"), "; status updates on its own.")),
      h("button", { class: "mini", onclick: (e) => { e.stopPropagation(); toast("Copied: codex login"); } }, "Copy")));
    kids.push(dv("setup-row", h("i", { class: "pdot grok" }), h("div", null, h("b", null, "Grok"), h("small", null, "Not installed. Optional.")), h("button", { class: "mini", onclick: (e) => { e.stopPropagation(); toast("Install command copied"); } }, "Install…")));
  }
  var el = h("div", { class: cls + (sel ? " sel" : ""), "data-cid": pl.id, style: { left: pl.x + "px", top: pl.y + "px", width: pl.w + "px", height: pl.h + "px" } }, kids);
  return el;
}
function isNewTurn(t) { var th = D.th[t.threadId]; return th.lastViewedAt && t.completedAt && t.completedAt > th.lastViewedAt; }
function runningSibling(t) {
  var p = D.tu[t.parentId];
  while (p) { if (p.status === "running") return p; p = D.tu[p.parentId]; }
  return null;
}
function threadPill(th) {
  if (th.archivedAt) return sn("pill plain", "Archived");
  if (th.turns.some((u) => u.status === "failed")) return pill("failed", D.statuses);
  if (th.turns.some((u) => u.status === "needs-review")) return pill("needs-review", D.statuses);
  if (th.turns.some((u) => u.status === "running")) return pill("running", D.statuses);
  if (th.status === "queued") return pill("queued", D.statuses);
  if (th.unread) return sn("pill new", "New");
  return null;
}
function threadDot(th) {
  if (th.archivedAt) return null;
  if (th.turns.some((u) => u.status === "failed")) return h("i", { class: "dot err", title: "Failed" });
  if (th.turns.some((u) => u.status === "needs-review")) return h("i", { class: "dot att", title: "Needs review" });
  if (th.turns.some((u) => u.status === "running")) return h("i", { class: "dot run", title: "Running" });
  if (th.unread) return h("i", { class: "dot unread", title: "New answer" });
  return null;
}
function thumbSvg(rb) {
  if (!rb) return "";
  var cs = rb.cards.filter((c) => /^[qa]:/.test(c.id));
  var bb = bounds(cs), W = 240, H = 64, padd = 6;
  var s = Math.min(0.075, (W - padd * 2) / bb.w, (H - padd * 2) / bb.h);
  var ox = (W - bb.w * s) / 2 - bb.x * s, oy = (H - bb.h * s) / 2 - bb.y * s;
  var out = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid meet">';
  rb.edges.forEach((e) => {
    if (e.kind !== "branch" && e.kind !== "followup") return;
    var a = find(rb, e.from), c = find(rb, e.to); if (!a || !c) return;
    out += '<line class="' + (e.kind === "branch" ? "tb" : "tl") + '" x1="' + (ox + (a.x + a.w / 2) * s).toFixed(1) + '" y1="' + (oy + (a.y + a.h / 2) * s).toFixed(1) + '" x2="' + (ox + (c.x + c.w / 2) * s).toFixed(1) + '" y2="' + (oy + (c.y + c.h / 2) * s).toFixed(1) + '"/>';
  });
  cs.forEach((c) => {
    out += '<rect class="' + (c.id[0] === "q" ? "tq" : "ta") + '" x="' + (ox + c.x * s).toFixed(1) + '" y="' + (oy + c.y * s).toFixed(1) + '" width="' + (c.w * s).toFixed(1) + '" height="' + (c.h * s).toFixed(1) + '" rx="1.5"/>';
  });
  return out + "</svg>";
}

/* ================================================ top-level render */
function curBoard() { return B[st.boardId]; }
function render() {
  closeSelBar();
  var app = dv("app");
  if (V === "d") { app.append(renderRail(), renderLibPane()); }
  else app.append(renderSidebar());
  var main = dv("main");
  main.append(renderTabs());
  var content = dv("content");
  E.content = content;
  main.append(content);
  app.append(main);
  if (st.panel && st.view === "board" && V !== "b") { E.panel = dv("panel"); app.append(E.panel); }
  else E.panel = null;
  root.replaceChildren(app);
  E.app = app;
  if (st.view === "board") renderBoard(); else renderPage();
  if (E.panel) renderPanel();
  renderOverlays();
}

/* ---------------- sidebar */
function renderSidebar() {
  var ws = wsOf(st.ws);
  var s = dv("side");
  s.append(dv("side-top", dv("lights", h("i"), h("i"), h("i")), sn("sp"),
    h("button", { class: "iconbtn", title: "Back" }, ic("chevR", "flip"))));
  s.lastChild.lastChild.firstChild.style.transform = "scaleX(-1)";
  s.append(h("button", { class: "wsbtn", title: "Switch workspace (⌘O)", onclick: (e) => { openMenu("ws", e.currentTarget); } },
    sn("mono", ws.name.charAt(0)), h("span", null, h("b", null, ws.name), h("small", null, ws.dir)), ic("chevUD")));
  s.append(h("button", { class: "search", onclick: () => { openPalette(); } }, ic("search"), sn("t", "Search cards"), sn("kbd", "⌘K")));
  var inboxN = D.inbox.filter((i) => { var t = D.th[i.threadId]; return t && t.workspaceId === st.ws; }).length;
  var nav = dv("nav",
    navRow("inbox", "inbox", "Inbox", inboxN ? sn("cnt hot", String(inboxN)) : null),
    navRow("journal", "journal", "Journal"),
    navRow("library", "library", "Card Library", sn("cnt", String(libraryItems(true).length))),
    navRow("tags", "tag", "Tags"),
    navRow("highlights", "highlight", "Highlights & sources"));
  s.append(nav);
  s.append(dv("side-h", "WHITEBOARDS", h("button", { class: "iconbtn", title: "New research whiteboard", style: { width: "20px", height: "20px" }, onclick: () => { newQuestion(); } }, ic("plus"))));
  var tree = dv("tree");
  if (ws.fresh) {
    tree.append(boardRow("welcome", ic("board"), "Start here", 0));
    D.threads.filter((t) => t.workspaceId === "ws-new").forEach((t) => { tree.append(boardRow("r:" + t.id, ic("board"), t.title, 1, threadDot(t))); });
  } else {
    var wb = B["w:" + ws.id];
    tree.append(boardRow(wb.id, ic("board"), ws.name, 0));
    wb.sections.forEach((sec) => {
      if (sec.id === "sources") return;
      var key = sec.id;
      var closed = st.collapsed[key];
      var ths = sec.id === "archive" ? D.threads.filter((t) => t.workspaceId === ws.id && t.archivedAt)
        : D.threads.filter((t) => t.workspaceId === ws.id && !t.archivedAt && ((sec.id === "unfiled" && !t.folderId) || t.folderId === sec.id));
      tree.append(h("button", { class: "row grp", "data-sec": sec.id, onclick: () => { st.collapsed[key] = !closed; render(); } },
        ic(closed ? "chevR" : "chevD"), sec.id === "archive" ? ic("archive") : ic("section"), sn("lbl", sec.label), sn("cnt", String(ths.length))));
      if (!closed) ths.forEach((t) => { tree.append(boardRow("r:" + t.id, ic("board"), t.title, 2, threadDot(t))); });
    });
    var dr = D.drafts.filter((d) => d.workspaceId === ws.id);
    if (dr.length) tree.append(h("button", { class: "row", style: { paddingLeft: "8px", marginTop: "6px" }, onclick: () => { goCard("d:" + dr[0].id); } }, ic("draft"), sn("lbl", "Drafts"), sn("cnt", String(dr.length))));
  }
  if (!ws.fresh) tree.append(h("button", { class: "row", style: { paddingLeft: "8px" }, onclick: () => { switchWs("ws-new"); } }, ic("help"), sn("lbl", "Start here")));
  s.append(tree);
  s.append(dv("side-foot", h("span", { class: "avatar", title: D.user.name }, D.user.initials),
    h("button", { class: "agents-ok", onclick: () => { switchWs("ws-new"); } }, h("i", { class: "dot" }), ws.fresh ? "1 of 3 agents ready" : "2 agents ready"),
    h("button", { class: "iconbtn", title: "Settings (⌘,)" }, ic("sliders"))));
  return s;
}
function navRow(view, icon, label, extra) {
  return h("button", { class: "row" + (st.view === view ? " on" : ""), onclick: () => { go(view); } }, ic(icon), sn("lbl", label), extra);
}
function boardRow(id, icon, label, depth, extra) {
  return h("button", { class: "row" + (st.view === "board" && st.boardId === id ? " on" : ""), "data-board": id, style: { paddingLeft: (8 + depth * 14) + "px" }, title: label, onclick: () => { go("board", id); } },
    icon, sn("lbl", label), extra);
}
function renderRail() {
  var ws = wsOf(st.ws);
  var r = dv("rail", dv("lights", h("i"), h("i"), h("i")));
  r.append(h("button", { class: "mono", title: ws.name + " — switch workspace", onclick: (e) => { openMenu("ws", e.currentTarget); } }, ws.name.charAt(0)));
  [["board", "board", "Whiteboards"], ["inbox", "inbox", "Inbox"], ["journal", "journal", "Journal"], ["tags", "tag", "Tags"], ["highlights", "highlight", "Highlights & sources"]].forEach((x) => {
    r.append(h("button", { class: "rb" + (st.view === x[0] ? " on" : ""), title: x[2], onclick: () => { if (x[0] === "board") go("board", "w:" + st.ws); else go(x[0]); } }, ic(x[1])));
  });
  r.append(h("div", { style: { flex: "1" } }));
  r.append(h("button", { class: "rb", title: "Search (⌘K)", onclick: openPalette }, ic("search")));
  r.append(h("button", { class: "rb", title: "Settings", style: { marginBottom: "10px" } }, ic("sliders")));
  return r;
}
function renderLibPane() {
  var p = dv("libp");
  var items = libraryItems(!st.lib.all);
  p.append(dv("libp-h", "Card Library", h("small", null, items.length + " cards")));
  var inp = h("input", { placeholder: "Search cards", value: st.lib.q, "aria-label": "Search cards" });
  inp.addEventListener("input", () => { st.lib.q = inp.value; fillLib(list); });
  p.append(dv("libsearch", ic("search"), inp));
  var types = [["all", "All"], ["answer", "Answers"], ["question", "Questions"], ["note", "Notes"], ["highlight", "Highlights"], ["source", "Sources"]];
  var chips = dv("chips");
  types.forEach((t) => { chips.append(h("button", { class: "chip" + (st.lib.type === t[0] ? " on" : ""), onclick: () => { st.lib.type = t[0]; render(); } }, t[1])); });
  p.append(chips);
  p.append(dv("libnote", ic("hand"), "Drag a card onto the whiteboard to place it there."));
  var list = dv("liblist");
  fillLib(list);
  p.append(list);
  return p;
}
function fillLib(list) {
  var q = st.lib.q.toLowerCase();
  var items = libraryItems(!st.lib.all).filter((it) => {
    return (st.lib.type === "all" || it.type === st.lib.type) && (!q || (it.title + " " + it.text).toLowerCase().indexOf(q) >= 0);
  });
  list.replaceChildren.apply(list, items.slice(0, 80).map((it) => libRow(it, true)));
  if (!items.length) list.append(h("div", { class: "pn-empty", style: { padding: "12px" } }, "No cards match “" + st.lib.q + "”."));
}
function libRow(it, draggable) {
  var n = usedIn(it.cid).length;
  var row = h("div", { class: "lrow", "data-lib": it.cid, title: draggable ? "Click to open, drag onto the whiteboard" : "" },
    h("span", { class: "ti " + TYPEIC[it.type][1] }, ic(TYPEIC[it.type][0])),
    h("div", null, h("b", null, it.title), it.text ? h("p", null, it.text) : null, dv("m", it.typeLabel + " · " + (n ? "in " + n + (n === 1 ? " whiteboard" : " whiteboards") : "not on a whiteboard") + (it.when ? " · " + fmtTime(it.when, NOW) : ""))));
  row.addEventListener("pointerdown", (e) => { if (draggable) startLibDrag(e, it); });
  row.addEventListener("click", () => { if (!drag || !drag.moved) goCard(it.cid); });
  return row;
}
function libraryItems(wsOnly) {
  var out = [];
  D.threads.forEach((t) => {
    if (wsOnly && t.workspaceId !== st.ws) return;
    t.turns.forEach((u) => {
      if (!u.post) out.push({ cid: "a:" + u.id, type: "answer", typeLabel: "Answer", title: u.title, text: plain(u.answer[0] || (u.status === "queued" ? "Queued" : u.error || "")), when: u.completedAt || u.createdAt });
      out.push({ cid: "q:" + u.id, type: "question", typeLabel: u.post ? "Saved link" : "Question", title: u.post ? u.post.linkTitle : plain(u.question), text: "", when: u.createdAt });
      u.highlights.forEach((x) => { out.push({ cid: "h:" + x.id, type: "highlight", typeLabel: "Highlight", title: x.quote, text: x.note || "", when: x.createdAt }); });
    });
  });
  D.notes.forEach((n) => { if (!wsOnly || n.workspaceId === st.ws) out.push({ cid: "n:" + n.id, type: "note", typeLabel: "Note", title: n.title, text: n.outline.map((o) => o.text).join(" · "), when: n.updatedAt }); });
  Object.keys(D.src).forEach((k) => {
    var s = D.src[k];
    if (wsOnly && D.th[D.tu[s.refs[0]].threadId].workspaceId !== st.ws) return;
    out.push({ cid: "s:" + k, type: "source", typeLabel: "Source", title: s.title, text: s.domain, when: null });
  });
  var order = { answer: 0, note: 1, highlight: 2, question: 3, source: 4 };
  return out.sort((a, b) => (order[a.type] - order[b.type]) || String(b.when || "").localeCompare(String(a.when || "")));
}

/* ---------------- tabs */
function tabLabel(id) {
  if (B[id]) return B[id].kind === "workspace" ? B[id].title : B[id].title;
  return { inbox: "Inbox", journal: "Journal", library: "Card Library", tags: "Tags", highlights: "Highlights & sources" }[id] || id;
}
function renderTabs() {
  var bar = dv("tabs");
  var active = st.view === "board" ? st.boardId : st.view;
  st.tabs.forEach((id) => {
    var icn = B[id] ? "board" : { inbox: "inbox", journal: "journal", library: "library", tags: "tag", highlights: "highlight" }[id];
    bar.append(h("div", { class: "tab" + (id === active ? " on" : ""), role: "tab", title: tabLabel(id), onclick: () => { if (B[id]) go("board", id); else go(id); } },
      ic(icn), sn("tl", tabLabel(id)),
      h("button", { class: "x", title: "Close tab", onclick: (e) => { e.stopPropagation(); closeTab(id); } }, ic("x"))));
  });
  bar.append(sn("sp"));
  bar.append(h("button", { class: "btn pri", title: "New question (⌘N)", onclick: () => { newQuestion(); } }, ic("plus"), "New question"));
  return bar;
}
function closeTab(id) {
  var i = st.tabs.indexOf(id);
  st.tabs.splice(i, 1);
  var active = st.view === "board" ? st.boardId : st.view;
  if (id === active) {
    var nx = st.tabs[Math.max(0, i - 1)];
    if (nx) { if (B[nx]) go("board", nx); else go(nx); return; }
    go("board", st.ws === "ws-new" ? "welcome" : "w:" + st.ws); return;
  }
  render();
}
function go(view, boardId) {
  if (view === "board") {
    st.view = "board"; st.boardId = boardId;
    if (B[boardId] && B[boardId].ws && B[boardId].ws !== st.ws) st.ws = B[boardId].ws;
    if (st.sel && !find(B[boardId], st.sel)) st.sel = null;
    if (st.tabs.indexOf(boardId) < 0) { st.tabs.push(boardId); if (st.tabs.length > 5) st.tabs.shift(); }
  } else {
    st.view = view;
    if (st.tabs.indexOf(view) < 0) { st.tabs.push(view); if (st.tabs.length > 5) st.tabs.shift(); }
  }
  st.overlay = null;
  render();
}
function switchWs(id) {
  st.ws = id; st.sel = null; st.menu = null;
  var target = id === "ws-new" ? "welcome" : "w:" + id;
  st.tabs = st.tabs.filter((t) => !B[t] || B[t].ws === id);
  go("board", target);
}

/* ---------------- board/canvas */
function renderBoard() {
  var b = curBoard();
  var cv = h("div", { class: "cv" + (st.tool === "hand" ? " hand" : "") });
  var world = dv("world");
  b.sections.forEach((s) => {
    world.append(h("div", { class: "sec t-" + s.tone, "data-sec": s.id, style: { left: s.x + "px", top: s.y + "px", width: s.w + "px", height: s.h + "px" } },
      dv("sl", s.id === "sources" ? ic("globe") : s.id === "archive" ? ic("archive") : null, s.label, s.count != null ? h("small", null, String(s.count)) : null, s.sub ? h("small", null, s.sub) : null)));
  });
  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "edges");
  world.append(svg);
  var labels = dv("labels");
  world.append(labels);
  b.cards.forEach((pl) => { world.append(cardNode(b, pl)); });
  cv.append(world);
  E.cv = cv; E.world = world; E.svg = svg; E.labels = labels;
  // chrome
  cv.append(renderCrumb(b));
  var tr = dv("cv-ui acts-tr");
  if (b.kind === "research") tr.append(h("button", { class: "btn", title: "Re-run the automatic tree layout", onclick: () => { tidy(); } }, ic("tidy"), "Tidy up"));
  if (V !== "b" && !st.panel) tr.append(h("button", { class: "btn", title: "Show card panel", onclick: () => { st.panel = true; render(); } }, ic("panel"), "Panel"));
  cv.append(tr);
  var tools = dv("cv-ui tools");
  [["select", "cursor", "Select (V)"], ["hand", "hand", "Pan (H or hold Space)"]].forEach((t) => {
    tools.append(h("button", { class: st.tool === t[0] ? "on" : "", title: t[2], onclick: () => { st.tool = t[0]; cv.classList.toggle("hand", t[0] === "hand"); tools.querySelectorAll("button").forEach((x, i) => { if (i < 2) x.classList.toggle("on", i === (t[0] === "select" ? 0 : 1)); }); } }, ic(t[1])));
  });
  tools.append(dv("div"));
  tools.append(h("button", { title: "New note card (N)", onclick: () => { addNote(); } }, ic("note")));
  tools.append(h("button", { title: "Section", onclick: () => { toast("Draw a section around cards to group them."); } }, ic("section")));
  tools.append(h("button", { title: "Connection", onclick: () => { toast("Drag from a card edge to another card to connect them."); } }, ic("connect")));
  tools.append(dv("div"));
  tools.append(h("button", { title: "Ask about the selected card (A)", onclick: () => { askFromSelection(); } }, ic("ask")));
  cv.append(tools);
  var mm = h("div", { class: "cv-ui mm", title: "Minimap: click to move the view" });
  E.mm = mm; cv.append(mm);
  var zb = dv("cv-ui zoom",
    h("button", { title: "Zoom out (−)", onclick: () => { zoomBy(1 / 1.2); } }, ic("minus")),
    E.zl = h("button", { title: "Reset to 100%", onclick: () => { zoomTo(1); } }, "100%"),
    h("button", { title: "Zoom in (+)", onclick: () => { zoomBy(1.2); } }, ic("plus")),
    h("button", { title: "Zoom to fit (⇧1)", onclick: () => { fit(true); } }, ic("fit")));
  cv.append(zb);
  if (b.kind === "research") cv.append(renderLegend());
  E.fbar = dv("cv-ui fbar-wrap");
  cv.append(E.fbar);
  if (V === "b" && st.overlay) cv.append(renderOverlayEditor());
  E.content.replaceChildren(cv);
  bindCanvas(cv);
  if (!b.view) b.view = initialView(b);
  applyView();
  drawEdges();
  drawMinimap();
  updateFbar();
}
function renderCrumb(b) {
  var c = dv("cv-ui crumb");
  var ws = wsOf(b.ws);
  if (b.kind === "research") {
    var th = D.th[b.threadId];
    c.append(h("button", { onclick: () => { go("board", "w:" + th.workspaceId); } }, ic("board"), ws.name));
    var f = D.folders.find((x) => x.id === th.folderId);
    c.append(ic("chevR", "sep"));
    c.append(h("button", { title: "Section on the workspace whiteboard", onclick: () => { go("board", "w:" + th.workspaceId); } }, th.archivedAt ? "Archive" : f ? f.name : "Unfiled"));
    c.append(ic("chevR", "sep"));
    c.append(h("button", { class: "cur", title: b.title }, h("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, b.title)));
  } else if (b.kind === "welcome") {
    c.append(h("button", null, ic("board"), ws.name), ic("chevR", "sep"), h("button", { class: "cur" }, "Start here"));
  } else {
    c.append(h("button", { class: "cur" }, ic("board"), b.title), h("button", { title: "Directory on disk" }, ws.dir));
  }
  return c;
}
function renderLegend() {
  if (!st.legend) return dv("cv-ui legend closed", h("button", { class: "lgb", onclick: () => { st.legend = true; renderBoard(); } }, ic("help"), "Reading this board"));
  function line(cls, dash) { return '<svg viewBox="0 0 34 12"><path d="M1 6h28" style="fill:none;stroke:var(' + cls + ');stroke-width:1.8' + (dash ? ";stroke-dasharray:3 3" : "") + '"/><path d="M27 2l5 4-5 4z" style="fill:var(' + cls + ')"/></svg>'; }
  function lg(svg, txt) { var s = h("span"); s.innerHTML = svg; return dv("lg", s.firstChild, h("span", null, txt)); }
  return dv("cv-ui legend",
    lg(line("--edge"), "Down: question → answer → follow-up, one conversation"),
    lg(line("--branch"), "Right: branch, a side conversation"),
    lg(line("--amber", true), "Highlight"),
    h("button", { class: "lx", title: "Hide legend", onclick: () => { st.legend = false; renderBoard(); } }, ic("x")));
}
function initialView(b) {
  var cw = E.cv.offsetWidth || 700, chh = E.cv.offsetHeight || 700;
  if (b.kind !== "research") return fitView(b, cw, chh, 1);
  var bb = bounds(b.cards), z = 0.8;
  var x0 = Math.min(bb.x, 0);
  var v = { z: z, tx: 18 - x0 * z, ty: 66 - bb.y * z };
  var focus = find(b, "ask:1") || (st.sel && find(b, st.sel));
  if (focus && (focus.y + focus.h) * z + v.ty > chh - 64) v.ty = chh - 64 - (focus.y + focus.h) * z;
  if (focus && (focus.x + focus.w) * z + v.tx > cw - 16) v.tx = cw - 16 - (focus.x + focus.w) * z;
  return v;
}
function fitView(b, cw, chh, maxZ) {
  var bb = bounds(b.cards, b.sections);
  var padL = 24, padR = 24, padT = 62, padB = 62;
  var z = Math.min(maxZ || 1, (cw - padL - padR) / bb.w, (chh - padT - padB) / bb.h);
  z = Math.max(0.2, z);
  return { tx: padL + ((cw - padL - padR) - bb.w * z) / 2 - bb.x * z, ty: padT + ((chh - padT - padB) - bb.h * z) / 2 - bb.y * z, z: z };
}
function fit(anim) { var b = curBoard(); b.view = fitView(b, E.cv.offsetWidth, E.cv.offsetHeight, 1); applyView(anim); }
function applyView(anim) {
  var v = curBoard().view;
  if (anim) { E.world.classList.add("anim"); later(() => { E.world && E.world.classList.remove("anim"); }, 320); }
  E.world.style.transform = "translate(" + v.tx + "px," + v.ty + "px) scale(" + v.z + ")";
  var g = 22 * v.z;
  E.cv.style.backgroundSize = g + "px " + g + "px";
  E.cv.style.backgroundPosition = v.tx + "px " + v.ty + "px";
  if (E.zl) E.zl.textContent = Math.round(v.z * 100) + "%";
  drawMinimap();
  updateFbar();
}
function zoomAt(f, sx, sy) {
  var v = curBoard().view;
  var nz = Math.max(0.2, Math.min(2, v.z * f));
  var k = nz / v.z;
  v.tx = sx - (sx - v.tx) * k; v.ty = sy - (sy - v.ty) * k; v.z = nz;
  applyView();
}
function zoomBy(f) { zoomAt(f, E.cv.offsetWidth / 2, E.cv.offsetHeight / 2); }
function zoomTo(z) { zoomAt(z / curBoard().view.z, E.cv.offsetWidth / 2, E.cv.offsetHeight / 2); }
function centerOn(pl, anim) {
  var v = curBoard().view, cw = E.cv.offsetWidth, chh = E.cv.offsetHeight;
  var sx = pl.x * v.z + v.tx, sy = pl.y * v.z + v.ty, sw = pl.w * v.z, sh = pl.h * v.z;
  if (sx < 60 || sx + sw > cw - 20 || sy < 56 || sy + sh > chh - 20) {
    v.tx = cw / 2 - (pl.x + pl.w / 2) * v.z;
    v.ty = Math.min(chh / 2 - (pl.y + pl.h / 2) * v.z, 70 - pl.y * v.z);
    applyView(anim);
  }
}

function geom(a, b, e) {
  var x1, y1, x2, y2, d, c1x, c1y, c2x, c2y;
  if (b.x >= a.x + a.w + 8) {
    x1 = a.x + a.w; y1 = a.y + (e.fy != null ? e.fy : Math.min(a.h / 2, 56)); x2 = b.x - 2; y2 = b.y + Math.min(b.h / 2, 52);
    var dx = Math.max(30, (x2 - x1) / 2); c1x = x1 + dx; c1y = y1; c2x = x2 - dx; c2y = y2;
  } else if (b.x + b.w <= a.x - 8) {
    x1 = a.x; y1 = a.y + Math.min(a.h / 2, 52); x2 = b.x + b.w + 2; y2 = b.y + Math.min(b.h / 2, 52);
    var dx2 = Math.max(30, (x1 - x2) / 2); c1x = x1 - dx2; c1y = y1; c2x = x2 + dx2; c2y = y2;
  } else if (b.y >= a.y + a.h) {
    x1 = a.x + a.w / 2; y1 = a.y + a.h; x2 = b.x + b.w / 2; y2 = b.y - 2;
    var dy = Math.max(12, (y2 - y1) / 2); c1x = x1; c1y = y1 + dy; c2x = x2; c2y = y2 - dy;
  } else {
    x1 = a.x + a.w / 2; y1 = a.y; x2 = b.x + b.w / 2; y2 = b.y + b.h + 2;
    var dy2 = Math.max(12, (y1 - y2) / 2); c1x = x1; c1y = y1 - dy2; c2x = x2; c2y = y2 + dy2;
  }
  d = "M" + x1.toFixed(1) + " " + y1.toFixed(1) + " C" + c1x.toFixed(1) + " " + c1y.toFixed(1) + " " + c2x.toFixed(1) + " " + c2y.toFixed(1) + " " + x2.toFixed(1) + " " + y2.toFixed(1);
  return { d: d, mx: (x1 + 3 * c1x + 3 * c2x + x2) / 8, my: (y1 + 3 * c1y + 3 * c2y + y2) / 8 };
}
function drawEdges() {
  var b = curBoard();
  var s = '<defs><marker id="hpm-g" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="mk-g" d="M0 1 L9 5 L0 9 z"/></marker>' +
    '<marker id="hpm-b" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="mk-b" d="M0 1 L9 5 L0 9 z"/></marker></defs>';
  var labs = [];
  b.edges.forEach((e) => {
    var a = find(b, e.from), c = find(b, e.to);
    if (!a || !c) return;
    var g = geom(a, c, e);
    var mk = e.kind === "hl" ? "" : ' marker-end="url(#' + (e.kind === "branch" || e.kind === "ask" ? "hpm-b" : "hpm-g") + ')"';
    s += '<path class="e-' + e.kind + '" d="' + g.d + '"' + mk + "/>";
    if (e.label) labs.push(h("div", { class: "elab el-" + e.kind, style: { left: g.mx + "px", top: g.my + "px" } }, e.kind === "branch" ? ic("branch") : e.kind === "followup" ? ic("down") : null, e.label));
  });
  E.svg.innerHTML = s;
  E.labels.replaceChildren.apply(E.labels, labs);
}
function drawMinimap() {
  if (!E.mm || !curBoard()) return;
  var b = curBoard(), v = b.view; if (!v) return;
  var bb = bounds(b.cards, b.sections);
  var W = 176, H = 112, p = 8;
  var cw = E.cv.offsetWidth, chh = E.cv.offsetHeight;
  var vx = -v.tx / v.z, vy = -v.ty / v.z, vw = cw / v.z, vh = chh / v.z;
  var x0 = Math.min(bb.x, vx), y0 = Math.min(bb.y, vy), x1 = Math.max(bb.x + bb.w, vx + vw), y1 = Math.max(bb.y + bb.h, vy + vh);
  var s = Math.min((W - 2 * p) / (x1 - x0), (H - 2 * p) / (y1 - y0));
  var ox = p + ((W - 2 * p) - (x1 - x0) * s) / 2 - x0 * s, oy = p + ((H - 2 * p) - (y1 - y0) * s) / 2 - y0 * s;
  E.mmT = { s: s, ox: ox, oy: oy };
  var out = '<svg viewBox="0 0 ' + W + " " + H + '">';
  b.sections.forEach((c) => { out += '<rect class="r s" x="' + (ox + c.x * s) + '" y="' + (oy + c.y * s) + '" width="' + c.w * s + '" height="' + c.h * s + '" rx="2"/>'; });
  b.cards.forEach((c) => {
    if (c.id.indexOf("tip:") === 0) return;
    out += '<rect class="r' + (c.id === st.sel ? " sel" : c.id[0] === "q" ? " q" : "") + '" x="' + (ox + c.x * s) + '" y="' + (oy + c.y * s) + '" width="' + Math.max(1, c.w * s) + '" height="' + Math.max(1, c.h * s) + '" rx="1"/>';
  });
  out += '<rect class="vp" x="' + (ox + vx * s) + '" y="' + (oy + vy * s) + '" width="' + vw * s + '" height="' + vh * s + '" rx="2"/></svg>';
  E.mm.innerHTML = out;
}

/* ---------------- floating action bar */
function updateFbar() {
  if (!E.fbar) return;
  E.fbar.replaceChildren();
  var b = curBoard();
  if (!st.sel || drag || (V !== "b" && st.panel)) return;
  var pl = find(b, st.sel); if (!pl) return;
  var f = info(st.sel);
  var v = b.view;
  var x = (pl.x + pl.w / 2) * v.z + v.tx, y = pl.y * v.z + v.ty - 8;
  if (y < 60) return;
  var bar = dv("fbar");
  var turn = f.type === "answer" ? f.turn : f.type === "question" ? f.turn : null;
  if (f.sample || f.type === "tip" || f.type === "start" || f.type === "setup" || f.type === "ask") return;
  if (st.ask && turn && st.ask.parent === turn.id) return;
  if (turn && turn.status !== "queued") {
    var t0 = turn;
    bar.append(h("button", { title: "Continue this conversation below", onclick: () => { startAsk("followup", t0.id); } }, ic("down"), "Follow-up"));
    bar.append(h("button", { title: "Start a side conversation to the right", onclick: () => { startAsk("branch", t0.id); } }, ic("branch"), "Branch"));
    bar.append(h("i", { class: "div" }));
  } else if (f.type === "note" || f.type === "highlight" || f.type === "source") {
    bar.append(h("button", { title: "Ask a new question with this card as context", onclick: () => { startAsk("about", null); } }, ic("ask"), "Ask about this"));
    bar.append(h("i", { class: "div" }));
  }
  if (f.type === "board") bar.append(h("button", { onclick: () => { go("board", "r:" + f.thread.id); } }, ic("open"), "Open whiteboard"));
  else bar.append(h("button", { title: "Open card (Enter)", onclick: () => { openCard(st.sel); } }, ic("expand"), "Open"));
  E.fbar.style.left = x + "px"; E.fbar.style.top = y + "px";
  E.fbar.append(bar);
}

/* ---------------- canvas interaction */
var drag = null, spaceDown = false;
function rootScale() { var r = root.getBoundingClientRect(); return r.width / (root.offsetWidth || 1280) || 1; }
function toLocal(e, el) { var r = el.getBoundingClientRect(), s = rootScale(); return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s }; }
function bindCanvas(cv) {
  cv.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.target.closest(".cv-ui") || e.target.closest(".scrim")) return;
    root.focus({ preventScroll: true });
    var c = e.target.closest(".card");
    var v = curBoard().view;
    if (c && st.tool !== "hand" && !spaceDown && e.button === 0) {
      if (e.target.closest("textarea,input,button,[contenteditable]")) return;
      var pl = find(curBoard(), c.getAttribute("data-cid"));
      drag = { kind: "card", el: c, pl: pl, sx: e.clientX, sy: e.clientY, ox: pl.x, oy: pl.y, moved: false };
    } else {
      drag = { kind: "pan", sx: e.clientX, sy: e.clientY, tx: v.tx, ty: v.ty, moved: false };
    }
    e.preventDefault();
  });
  cv.addEventListener("dblclick", (e) => {
    var c = e.target.closest(".card");
    if (!c || e.target.closest("textarea,button")) return;
    var cid = c.getAttribute("data-cid");
    var f = info(cid);
    if (f.type === "board") go("board", "r:" + f.thread.id); else openCard(cid);
  });
  cv.addEventListener("wheel", (e) => {
    if (e.target.closest(".scrim")) return;
    e.preventDefault();
    var p = toLocal(e, cv);
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), p.x, p.y);
    else { var v = curBoard().view; v.tx -= e.deltaX; v.ty -= e.deltaY; applyView(); }
  }, { passive: false });
  E.mm.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    var p = toLocal(e, E.mm), T = E.mmT, v = curBoard().view;
    var bx = (p.x - T.ox) / T.s, by = (p.y - T.oy) / T.s;
    v.tx = E.cv.offsetWidth / 2 - bx * v.z; v.ty = E.cv.offsetHeight / 2 - by * v.z;
    applyView(true);
  });
}
function onMove(e) {
  if (!drag) return;
  var s = rootScale();
  var dx = (e.clientX - drag.sx) / s, dy = (e.clientY - drag.sy) / s;
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
  if (!drag.moved) { drag.moved = true; if (drag.kind === "card") { drag.el.classList.add("drag"); E.fbar && E.fbar.replaceChildren(); } if (drag.kind === "pan") E.cv.classList.add("panning"); }
  if (drag.kind === "pan") { var v = curBoard().view; v.tx = drag.tx + dx; v.ty = drag.ty + dy; applyView(); }
  else if (drag.kind === "card") {
    var z = curBoard().view.z;
    drag.pl.x = Math.round(drag.ox + dx / z); drag.pl.y = Math.round(drag.oy + dy / z);
    drag.el.style.left = drag.pl.x + "px"; drag.el.style.top = drag.pl.y + "px";
    drawEdges();
    markDrop(e);
  } else if (drag.kind === "lib") {
    var p = toLocal(e, root);
    drag.ghost.style.left = (p.x + 8) + "px"; drag.ghost.style.top = (p.y + 8) + "px";
  }
}
function markDrop(e) {
  root.querySelectorAll(".drop").forEach((x) => { x.classList.remove("drop"); });
  var t = document.elementFromPoint(e.clientX, e.clientY);
  var row = t && t.closest && t.closest("[data-board]");
  if (row && row.getAttribute("data-board") !== st.boardId) { row.classList.add("drop"); return row.getAttribute("data-board"); }
  return null;
}
function onUp(e) {
  if (!drag) return;
  var d = drag; drag = null;
  if (d.kind === "pan") {
    E.cv && E.cv.classList.remove("panning");
    if (!d.moved) { if (st.ask && V === "b") { /* keep ask */ } select(null); }
  } else if (d.kind === "card") {
    d.el.classList.remove("drag");
    if (!d.moved) { select(d.pl.id); return; }
    var target = markDrop(e);
    root.querySelectorAll(".drop").forEach((x) => { x.classList.remove("drop"); });
    if (target) {
      d.pl.x = d.ox; d.pl.y = d.oy; d.el.style.left = d.ox + "px"; d.el.style.top = d.oy + "px"; drawEdges();
      reuseOn(target, d.pl.id);
    }
    drawMinimap(); updateFbar();
  } else if (d.kind === "lib") {
    d.ghost.remove();
    if (!d.moved) return;
    if (!E.cv) return;
    var r = E.cv.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    var p = toLocal(e, E.cv), v = curBoard().view;
    var b = curBoard();
    if (find(b, d.it.cid)) { var ex = find(b, d.it.cid); select(d.it.cid); centerOn(ex, true); flash(d.it.cid); toast("Already on this whiteboard."); return; }
    var sz = sizeFor(d.it.cid);
    addCard(b, d.it.cid, Math.round((p.x - v.tx) / v.z - sz[0] / 2), Math.round((p.y - v.ty) / v.z - 20), sz[0], sz[1]);
    st.sel = d.it.cid;
    render();
    flash(d.it.cid);
    toast("Placed on " + b.title + ". Same card, now in " + usedIn(d.it.cid).length + " whiteboards.");
  }
}
function sizeFor(cid) {
  var f = info(cid);
  if (f.type === "answer") return [AW, aH(f.turn)];
  if (f.type === "question") return [QW, QH];
  if (f.type === "highlight") return [HLW + 40, HLH];
  if (f.type === "source") return [212, 74];
  if (f.type === "note") return [BW, noteH(f.note)];
  if (f.type === "board") return [BW, BH];
  return [240, 120];
}
function reuseOn(boardId, cid) {
  var b = B[boardId];
  if (find(b, cid)) { toast("Already on " + b.title + "."); return; }
  var bb = bounds(b.cards, b.sections), sz = sizeFor(cid);
  addCard(b, cid, bb.x + bb.w + 80, bb.y + 40, sz[0], sz[1]);
  b.view = null;
  renderCanvasOnly();
  toast("Added to " + b.title + ". Same card, now in " + usedIn(cid).length + " whiteboards.");
}
function startLibDrag(e, it) {
  if (e.button !== 0) return;
  var ghost = dv("ghost", it.title, h("small", null, it.typeLabel));
  drag = { kind: "lib", it: it, sx: e.clientX, sy: e.clientY, moved: false, ghost: ghost };
  var p = toLocal(e, root);
  ghost.style.left = p.x + "px"; ghost.style.top = p.y + "px";
  on1(() => { E.app.append(ghost); });
  e.preventDefault();
}
function on1(fn) { fn(); }
function flash(cid) {
  var el = E.world && E.world.querySelector('[data-cid="' + cssEsc(cid) + '"]');
  if (el) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
}
function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }
function renderCanvasOnly() { if (st.view === "board") renderBoard(); }

function select(cid) {
  st.sel = cid;
  if (E.world) E.world.querySelectorAll(".card").forEach((el) => { el.classList.toggle("sel", el.getAttribute("data-cid") === cid); });
  if (E.panel) renderPanel();
  drawMinimap(); updateFbar();
}
function openCard(cid) {
  if (!cid) return;
  st.sel = cid;
  if (V === "b") { st.overlay = cid; renderBoard(); return; }
  if (!st.panel) { st.panel = true; render(); return; }
  select(cid);
}

/* ---------------- panel / editor */
function renderPanel() {
  if (!E.panel) return;
  var keepScroll = E.pscroll && E.pscroll.dataset.for === String(st.sel) ? E.pscroll.scrollTop : 0;
  var hadFocus = E.panel.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA";
  var f = st.sel ? info(st.sel) : null;
  var head = dv("pn-h", ic(st.sel ? "panel" : "board"), st.sel ? "Card" : "Whiteboard", sn("sp"),
    st.sel ? h("button", { class: "iconbtn", title: "Show on its research whiteboard", onclick: () => { goCard(st.sel); } }, ic("open")) : null,
    h("button", { class: "iconbtn", title: "Close panel", onclick: () => { st.panel = false; render(); } }, ic("x")));
  var sc = dv("pn-s");
  sc.dataset.for = String(st.sel);
  editorInto(sc, st.sel, "panel");
  E.pscroll = sc;
  E.panel.replaceChildren(head, sc, renderComposer(f));
  sc.scrollTop = keepScroll;
  if (hadFocus && E.ta) E.ta.focus();
}
function refreshPanelBody() {
  if (!E.pscroll) return;
  var top = E.pscroll.scrollTop;
  E.pscroll.replaceChildren();
  editorInto(E.pscroll, st.sel, "panel");
  E.pscroll.scrollTop = top;
}
function renderOverlayEditor() {
  var sc = dv("pn-s");
  editorInto(sc, st.overlay, "overlay");
  var f = info(st.overlay);
  var head = dv("pn-h", ic("expand"), "Card", sn("sp"),
    f.turn && f.turn.status !== "queued" ? h("button", { class: "btn", onclick: () => { var t = f.turn; st.overlay = null; startAsk("followup", t.id); } }, ic("down"), "Follow-up") : null,
    f.turn && f.turn.status !== "queued" ? h("button", { class: "btn", style: { marginLeft: "6px" }, onclick: () => { var t = f.turn; st.overlay = null; startAsk("branch", t.id); } }, ic("branch"), "Branch") : null,
    h("button", { class: "iconbtn", style: { marginLeft: "6px" }, title: "Close (Esc)", onclick: () => { st.overlay = null; renderBoard(); } }, ic("x")));
  var scrim = h("div", { class: "scrim", onclick: (e) => { if (e.target === scrim) { st.overlay = null; renderBoard(); } } }, dv("ovl", head, sc));
  E.pscroll = sc;
  return scrim;
}
function editorInto(sc, cid, mode) {
  if (!cid) { boardSummary(sc); return; }
  var f = info(cid);
  var wbs = usedIn(cid);
  function whiteboards() {
    return wbs.map((b, i) => { return [i ? ", " : null, h("span", { class: "lnk", onclick: () => { go("board", b.id); } }, b.title)]; });
  }
  if (f.type === "answer" || f.type === "question") {
    var t = f.turn, th = D.th[t.threadId];
    var isQ = f.type === "question";
    sc.append(dv("ed-type", ic(isQ ? "ask" : "answer"), isQ ? (t.relation === "branch" ? "Branch question" : t.relation === "followup" ? "Follow-up question" : "Question") : "Answer card", f.sample ? " · sample" : null));
    sc.append(h("div", { class: "ed-title", contenteditable: f.sample ? null : "true", spellcheck: "false" }, isQ ? (t.post ? t.post.linkTitle : t.title) : t.title));
    var props = h("dl", { class: "props" });
    function prop(icn, k, v) { props.append(h("dt", null, ic(icn), k), h("dd", null, v)); }
    if (!isQ) prop("ask", "Question", h("span", { class: "lnk", onclick: () => { selOrGo("q:" + t.id); } }, plain(t.question).slice(0, 80) + (plain(t.question).length > 80 ? "…" : "")));
    if (isQ && !t.post) prop("answer", "Answer", h("span", { class: "lnk", onclick: () => { selOrGo("a:" + t.id); } }, t.title));
    if (t.parentId) prop(t.relation === "branch" ? "branch" : "down", t.relation === "branch" ? "Branched from" : "Follows", h("span", { class: "lnk", onclick: () => { selOrGo(mainCardId(D.tu[t.parentId])); } }, D.tu[t.parentId].title));
    prop("terminal", "Agent", h("span", { class: "agent", style: { fontSize: "12px" } }, h("i", { class: "pdot " + t.provider }), agentText(t)));
    prop("clock", "Status", [pill(t.status, D.statuses), h("span", { style: { color: "var(--ink-3)" } }, (t.durationSec ? fmtDur(t.durationSec) + " · " : "") + fmtTime(t.completedAt || t.createdAt, NOW))]);
    if (!f.sample) { prop("board", "Whiteboards", whiteboards()); props.lastChild.className = "inl"; }
    prop("tag", "Tags", th.tags.map((g) => { return h("span", { class: "tagc", onclick: () => { st.tag = g; go("tags"); } }, "#" + g); }));
    sc.append(props);
    if (isQ) {
      if (t.anchor) sc.append(h("div", { class: "quote", style: { margin: "0 0 10px", fontSize: "12.5px", whiteSpace: "normal" } }, "Branched from: “" + plain(t.anchor.quote) + "”"));
      sc.append(dv("ed-q", t.post ? [h("b", null, t.post.linkTitle), h("div", { style: { color: "var(--ink-3)", fontSize: "12px", marginTop: "4px" } }, t.post.domain + " · " + t.post.author)] : md(t.question)));
      return;
    }
    if (t.recap) sc.append(dv("recap", h("b", null, "Recap"), t.recap));
    if (t.status === "failed") sc.append(h("div", { class: "box err", style: { margin: "0 0 12px" } }, t.error, dv("acts", h("button", { class: "mini", onclick: () => { retry(t); } }, "Retry run"))));
    if (t.status === "needs-review" && t.clarification) sc.append(h("div", { class: "box att", style: { margin: "0 0 12px" } }, h("b", null, provLabel(t.provider) + " asks: "), t.clarification, h("div", { class: "hint", style: { margin: "4px 0 0" } }, "Reply with a follow-up below; the run continues with your answer.")));
    if (t.status === "queued") sc.append(h("div", { class: "box plain", style: { margin: "0 0 12px" } }, "Queued. It runs after the running answer in this conversation finishes; a conversation runs one answer at a time. Branches run immediately."));
    var body = h("div", { class: "ed-body", "data-turn": t.id });
    var kids = D.th[t.threadId].turns.filter((c) => c.parentId === t.id && c.relation === "branch" && c.anchor);
    t.answer.forEach((p, i) => {
      var marks = [];
      t.highlights.forEach((x) => { if (x.paragraph === i) marks.push({ q: x.quote, cls: "hl " + (x.color || "amber") }); });
      kids.forEach((c) => { if (c.anchor.paragraph === i) marks.push({ q: c.anchor.quote, cls: "anc" }); });
      body.append(h("p", { "data-p": String(i) }, markPara(p, marks)));
      kids.forEach((c) => {
        if (c.anchor.paragraph === i) body.append(h("div", { class: "bmark", onclick: () => { selOrGo("q:" + c.id); } }, ic("branch"), "Branch: " + c.title));
      });
    });
    if (t.status === "running") body.append(h("p", { style: { color: "var(--run)", fontSize: "12.5px" } }, "Running · " + (t.activity.length ? t.activity[t.activity.length - 1].label : "starting")));
    if (!t.answer.length && t.status !== "running") body.append(h("p", { class: "pn-empty" }, "No answer yet."));
    sc.append(body);
    if (t.sources.length) {
      var ss = dv("ed-sec", h("h5", null, ic("globe"), "Sources · " + t.sources.length));
      t.sources.forEach((s) => { ss.append(dv("srow", sn("fav", s.domain.charAt(0).toUpperCase()), h("div", null, h("b", null, s.title), h("small", null, s.domain)))); });
      sc.append(ss);
    }
    if (t.activity.length) {
      var open = st.traceOpen === t.id;
      var tr = dv("ed-sec", h("h5", null, h("button", { onclick: () => { st.traceOpen = open ? null : t.id; refreshPanelBody(); } }, ic(open ? "chevD" : "chevR"), "Run trace · " + t.activity.length + " steps")));
      if (open) t.activity.forEach((a) => { tr.append(h("div", { class: "step " + a.status }, sn("k", a.kind), h("span", null, a.label, a.detail ? sn("d", " · " + a.detail) : null))); });
      sc.append(tr);
    }
    return;
  }
  if (f.type === "highlight") {
    var hl = f.hl, ht = D.tu[hl.turnId];
    sc.append(dv("ed-type", ic("highlight"), "Highlight card"));
    sc.append(dv("hlq", hl.quote));
    var pr = h("dl", { class: "props" });
    pr.append(h("dt", null, ic("answer"), "From"), h("dd", null, h("span", { class: "lnk", onclick: () => { selOrGo("a:" + ht.id); } }, ht.title + " · ¶" + (hl.paragraph + 1))));
    pr.append(h("dt", null, ic("board"), "Whiteboards"), h("dd", null, whiteboards()));
    pr.append(h("dt", null, ic("clock"), "Saved"), h("dd", null, fmtTime(hl.createdAt, NOW)));
    sc.append(pr);
    sc.append(dv("ed-sec", h("h5", null, "Note"), h("div", { class: "ed-body", contenteditable: "true", style: { outline: "0", minHeight: "40px" } }, hl.note || "")));
    return;
  }
  if (f.type === "source") {
    sc.append(dv("ed-type", ic("globe"), "Source card"));
    sc.append(dv("ed-title", f.src.title));
    var ps = h("dl", { class: "props" });
    ps.append(h("dt", null, ic("link"), "URL"), h("dd", null, h("span", { class: "lnk", style: { wordBreak: "break-all" } }, f.src.url)));
    ps.append(h("dt", null, ic("answer"), "Cited by"), h("dd", null, f.src.refs.map((r, i) => { return [i ? ", " : null, h("span", { class: "lnk", onclick: () => { selOrGo("a:" + r); } }, D.tu[r].title)]; })));
    ps.append(h("dt", null, ic("board"), "Whiteboards"), h("dd", null, whiteboards()));
    sc.append(ps);
    return;
  }
  if (f.type === "note") {
    var n = f.note;
    sc.append(dv("ed-type", ic("note"), "Note card · written by you"));
    sc.append(h("div", { class: "ed-title", contenteditable: "true" }, n.title));
    var pn = h("dl", { class: "props" });
    pn.append(h("dt", null, ic("board"), "Whiteboards"), h("dd", null, whiteboards()));
    pn.append(h("dt", null, ic("tag"), "Tags"), h("dd", null, n.tags.map((g) => { return h("span", { class: "tagc", onclick: () => { st.tag = g; go("tags"); } }, "#" + g); })));
    sc.append(pn);
    function ol(list) {
      return h("ul", { class: "ed-outline" }, list.map((o) => {
        return h("li", null, h("span", { contenteditable: "true" }, o.text), o.ref ? h("span", { class: "refc", title: "Open the referenced card", onclick: () => { goCard(o.ref.turnId ? "a:" + o.ref.turnId : "b:" + o.ref.threadId); } }, o.ref.turnId ? D.tu[o.ref.turnId].title : "whiteboard") : null, o.children ? ol(o.children) : null);
      }));
    }
    sc.append(ol(n.outline));
    return;
  }
  if (f.type === "board") {
    var th2 = f.thread;
    sc.append(dv("ed-type", ic("board"), "Research whiteboard"));
    sc.append(dv("ed-title", th2.title));
    if (th2.recap) sc.append(dv("recap", h("b", null, "Recap"), th2.recap));
    sc.append(h("button", { class: "btn pri", onclick: () => { go("board", "r:" + th2.id); } }, ic("open"), "Open whiteboard"));
    return;
  }
  if (f.type === "recap") {
    sc.append(dv("ed-type", ic("sparkle"), "Recap card · generated"));
    sc.append(dv("ed-title", f.thread.title));
    sc.append(dv("ed-body", h("p", null, f.thread.recap)));
    sc.append(h("button", { class: "btn", onclick: () => { toast("Recap regenerated with opus."); } }, ic("retry"), "Regenerate recap"));
    return;
  }
  if (f.type === "draft") {
    sc.append(dv("ed-type", ic("draft"), "Draft question · not sent"));
    sc.append(h("div", { class: "ed-q", contenteditable: "true" }, f.draft.prompt));
    sc.append(h("button", { class: "btn pri", onclick: () => { sendDraft(f.draft); } }, "Ask with " + agentText(f.draft, false)));
    return;
  }
  sc.append(dv("pn-empty", "Select a card on the whiteboard to see it here."));
}
function boardSummary(sc) {
  var b = curBoard();
  sc.append(dv("ed-type", ic("board"), b.kind === "research" ? "Research whiteboard" : "Workspace whiteboard"));
  sc.append(dv("ed-title", b.title));
  if (b.kind === "research") {
    var th = D.th[b.threadId];
    if (th.recap) sc.append(dv("recap", h("b", null, "Recap"), th.recap));
    var q = th.turns.length, br = th.turns.filter((x) => x.relation === "branch").length;
    sc.append(h("p", { class: "pn-empty" }, q + " questions, " + br + " branches. Select an answer card to read it and ask a follow-up or a branch from it. The ask box below starts a new research whiteboard."));
  } else {
    sc.append(h("p", { class: "pn-empty" }, "Sections group research whiteboards, notes and cards. Drag a whiteboard card into another section to file it; it stays visible here."));
  }
}
function markPara(p, marks) {
  var text = p, ranges = [];
  var raw = text;
  marks.forEach((m) => {
    var i = raw.indexOf(m.q);
    if (i < 0) return;
    if (ranges.some((r) => i < r.e && i + m.q.length > r.s)) return;
    ranges.push({ s: i, e: i + m.q.length, cls: m.cls });
  });
  ranges.sort((a, b) => a.s - b.s);
  var out = [], last = 0;
  ranges.forEach((r) => {
    if (r.s > last) out.push(md(raw.slice(last, r.s)));
    var mk = r.cls.indexOf("hl") === 0 ? h("mark", { class: r.cls.replace("hl ", "") }, md(raw.slice(r.s, r.e))) : sn(r.cls, md(raw.slice(r.s, r.e)));
    out.push(mk);
    last = r.e;
  });
  if (last < raw.length) out.push(md(raw.slice(last)));
  return out;
}
function selOrGo(cid) {
  if (find(curBoard(), cid)) { select(cid); centerOn(find(curBoard(), cid), true); flash(cid); }
  else goCard(cid);
}
function goCard(cid) {
  var bid = homeBoardOf(cid);
  if (!B[bid] || !find(B[bid], cid)) { var ub = usedIn(cid); if (ub.length) bid = ub[0].id; }
  st.sel = cid;
  st.palette = null;
  if (V === "a" || V === "c" || V === "d") st.panel = true;
  go("board", bid);
  var pl = find(curBoard(), cid);
  if (pl) { centerOn(pl, false); flash(cid); }
}

/* ---------------- composer */
function composerTarget(f) {
  if (f && (f.type === "answer" || f.type === "question") && !f.sample) return { turn: f.turn };
  if (f && (f.type === "note" || f.type === "highlight" || f.type === "source")) return { about: st.sel };
  return null;
}
function renderComposer(f) {
  var tgt = composerTarget(f);
  var c = dv("comp");
  var mode = tgt && tgt.turn ? (st.comp.mode === "branch" ? "branch" : "followup") : tgt && tgt.about ? "about" : "new";
  var top = dv("comp-top");
  if (tgt && tgt.turn) {
    top.append(h("div", { class: "seg", role: "group", "aria-label": "Ask mode" },
      h("button", { class: mode === "followup" ? "on" : "", "aria-pressed": String(mode === "followup"), onclick: () => { st.comp.mode = "followup"; st.comp.quote = null; renderPanel(); E.ta && E.ta.focus(); } }, ic("down"), "Follow-up"),
      h("button", { class: mode === "branch" ? "on" : "", "aria-pressed": String(mode === "branch"), onclick: () => { st.comp.mode = "branch"; renderPanel(); E.ta && E.ta.focus(); } }, ic("branch"), "Branch")));
  } else {
    top.append(h("span", { style: { fontSize: "12px", fontWeight: "600", color: "var(--ink-2)", display: "flex", alignItems: "center", gap: "6px" } }, ic(mode === "about" ? "ask" : "plus"), mode === "about" ? "Ask about this card" : "New question"));
  }
  top.append(sn("sp"));
  var agentO = mode === "followup" ? tgt.turn : st.agent;
  top.append(agentButton(agentO, mode === "followup"));
  c.append(top);
  if (mode === "branch" && st.comp.quote && st.comp.quote.turnId === (tgt.turn && tgt.turn.id)) {
    c.append(dv("qchip", ic("branch"), h("span", null, "“" + st.comp.quote.quote + "”"), h("button", { class: "iconbtn", style: { width: "18px", height: "18px" }, title: "Branch from the whole answer instead", onclick: () => { st.comp.quote = null; renderPanel(); } }, ic("x"))));
  }
  var ph = mode === "followup" ? "Ask a follow-up to “" + tgt.turn.title + "”" : mode === "branch" ? "Ask a side question about “" + tgt.turn.title + "”" : mode === "about" ? "Ask a question about this card" : "Ask a question to start a research whiteboard";
  var ta = h("textarea", { placeholder: ph, "aria-label": ph });
  ta.value = st.comp.text;
  var send = h("button", { class: "send", title: "Ask (Enter)", disabled: st.comp.text.trim() ? null : true, onclick: () => { submitComposer(mode, tgt); } }, ic("send"));
  ta.addEventListener("input", () => { st.comp.text = ta.value; if (ta.value.trim()) send.removeAttribute("disabled"); else send.setAttribute("disabled", ""); });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitComposer(mode, tgt); } });
  E.ta = ta;
  var running = tgt && tgt.turn && mode === "followup" && (tgt.turn.status === "running" || runningSibling(tgt.turn));
  var hint = mode === "followup" ? (running ? "An answer in this conversation is running. A follow-up is queued and runs after it; a branch runs now." : "Continues this conversation below the answer, with the same agent and context.")
    : mode === "branch" ? (st.comp.quote ? "Starts a side conversation from this passage, to the right. The main line is unchanged." : "Starts a side conversation to the right. Select a passage above to branch from it.")
    : mode === "about" ? "Creates a question and answer next to this card, connected to it." : "Creates a new research whiteboard in this workspace.";
  c.append(dv("comp-box", ta, dv("comp-row", h("span", null, "Enter to ask · ⇧Enter new line"), sn("sp"), send)));
  c.append(dv("hint", hint));
  return c;
}
function agentButton(o, locked) {
  return h("button", { class: "agentbtn" + (locked ? " locked" : ""), title: (locked ? "Follow-ups use the conversation's agent: " : "Choose agent, model and effort. Now: ") + agentText(o), onclick: (e) => { if (!locked) { e.stopPropagation(); openMenu("agent", e.currentTarget); } } },
    h("i", { class: "pdot " + o.provider }), provLabel(o.provider).split(" ")[0] + " · " + o.model + (o.effort ? " · " + o.effort : ""), locked ? null : ic("chevD"));
}
function submitComposer(mode, tgt) {
  var text = st.comp.text.trim();
  if (!text) return;
  st.comp.text = "";
  if (mode === "new") { startThread(text, true); return; }
  if (mode === "about") { askAbout(tgt.about, text); return; }
  var q = mode === "branch" && st.comp.quote && st.comp.quote.turnId === tgt.turn.id ? st.comp.quote : null;
  st.comp.quote = null;
  sendTurn(tgt.turn.id, mode, text, q);
}

/* ---------------- ask flows */
function startAsk(mode, turnId) {
  if (mode === "about") {
    if (V === "b") { toast("Type your question in the Ask card next to this card."); }
    st.panel = true; st.comp.mode = "followup";
    if (V !== "b") { render(); E.ta && E.ta.focus(); }
    return;
  }
  if (V === "b") {
    st.ask = { mode: mode, parent: turnId, text: "" };
    placeAsk(curBoard());
    renderBoard();
    var pl = find(curBoard(), "ask:1");
    if (pl) centerOn(pl, true);
    var ta = E.world.querySelector(".c-ask textarea"); if (ta) ta.focus();
    return;
  }
  st.comp.mode = mode;
  if (mode !== "branch") st.comp.quote = null;
  st.sel = find(curBoard(), "a:" + turnId) ? "a:" + turnId : st.sel;
  if (!st.panel) { st.panel = true; render(); } else { select(st.sel); }
  E.ta && E.ta.focus();
}
function askFromSelection() {
  var f = st.sel && info(st.sel);
  if (f && f.turn && !f.sample) startAsk("followup", f.turn.id);
  else if (V === "b") { toast("Select an answer card, then choose Follow-up or Branch."); }
  else { st.sel = null; st.panel = true; render(); E.ta && E.ta.focus(); }
}
function placeAsk(b) {
  b.cards = b.cards.filter((c) => c.id !== "ask:1");
  b.edges = b.edges.filter((e) => e.to !== "ask:1");
  var a = st.ask; if (!a) return;
  var pt = D.tu[a.parent], pa = find(b, mainCardId(pt));
  if (!pa) return;
  var pos = placement(b, pa, a.mode, a.quote ? a.quote.paragraph : null, 132);
  addCard(b, "ask:1", pos.x, pos.y, QW, 132);
  addEdge(b, pa.id, "ask:1", "ask", a.mode === "branch" ? { fy: pos.fy, label: "Branch" } : { label: "Follow-up" });
  relaxSources(b);
}
function cancelAsk() { if (!st.ask) return; st.ask = null; B[st.boardId].cards = curBoard().cards.filter((c) => c.id !== "ask:1"); curBoard().edges = curBoard().edges.filter((e) => e.to !== "ask:1"); renderBoard(); }
function submitAsk() {
  var a = st.ask; if (!a || !a.text.trim()) return;
  var b = curBoard(), pl = find(b, "ask:1");
  var at = pl ? { x: pl.x, y: pl.y } : null;
  st.ask = null;
  b.cards = b.cards.filter((c) => c.id !== "ask:1");
  b.edges = b.edges.filter((e) => e.to !== "ask:1");
  sendTurn(a.parent, a.mode, a.text.trim(), a.quote || null, at);
}
function placement(b, pa, mode, paragraph, hgt) {
  var research = b.kind === "research";
  if (mode === "branch") {
    var off = anchorOff(paragraph, pa.h);
    var x = pa.x + (research ? PITCH : pa.w + 150), y = pa.y + off - QH / 2;
    y = freeY(b, x, y, QW, (hgt || QH) + GQA + 212);
    return { x: x, y: y, fy: off };
  }
  var y2 = freeY(b, pa.x, pa.y + pa.h + GF, QW, (hgt || QH) + GQA + 212);
  return { x: pa.x, y: y2 };
}
function relaxSources(b) {
  var sec = b.sections.find((x) => x.id === "sources");
  if (!sec) return;
  var bottom = -1e9;
  b.cards.forEach((c) => { if (c.id.indexOf("s:") !== 0) bottom = Math.max(bottom, c.y + c.h); });
  var d = bottom + 42 - sec.y;
  if (d <= 0) return;
  sec.y += d;
  b.cards.forEach((c) => { if (c.id.indexOf("s:") === 0) c.y += d; });
}
function freeY(b, x, y, w, hh) {
  for (var guard = 0; guard < 40; guard++) {
    var hit = b.cards.find((c) => c.id !== "ask:1" && c.id.indexOf("s:") !== 0 && c.x < x + w + 20 && c.x + c.w + 20 > x && c.y < y + hh + 30 && c.y + c.h + 30 > y);
    if (!hit) return y;
    y = hit.y + hit.h + GF;
  }
  return y;
}
function newTurnFor(parent, mode, text, quote) {
  var th = D.th[parent.threadId];
  st.newSeq++;
  var id = th.id + "n" + st.newSeq;
  var running = mode === "followup" && (parent.status === "running" || runningSibling(parent));
  var o = mode === "followup" ? parent : st.agent;
  var u = {
    id: id, threadId: th.id, parentId: parent.id, relation: mode === "branch" ? "branch" : "followup",
    anchor: mode === "branch" ? (quote ? { turnId: parent.id, paragraph: quote.paragraph, quote: quote.quote } : { turnId: parent.id, paragraph: 0, quote: plain(parent.answer[0] || "").slice(0, 60) }) : null,
    question: text, title: titleFrom(text), provider: o.provider, model: o.model, effort: o.effort,
    status: running ? "queued" : "running", createdAt: nowIso(), completedAt: null, durationSec: null,
    starred: false, recap: null, answer: [], error: null, sources: [], activity: [], highlights: []
  };
  if (mode === "branch" && !quote) u.anchor = null;
  th.turns.push(u); D.tu[id] = u;
  return u;
}
function titleFrom(text) {
  var w = plain(text).replace(/[?.!]+$/, "").split(/\s+/);
  var s = w.slice(0, 6).join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1) + (w.length > 6 ? "…" : "");
}
function sendTurn(parentId, mode, text, quote, at) {
  var parent = D.tu[parentId];
  var u = newTurnFor(parent, mode, text, quote);
  var targets = [curBoard()];
  var rb = B["r:" + parent.threadId];
  if (rb && rb !== curBoard()) targets.push(rb);
  targets.forEach((b, idx) => {
    var pa = find(b, mainCardId(parent));
    if (!pa) return;
    var pos = idx === 0 && at ? { x: at.x, y: at.y, fy: anchorOff(quote ? quote.paragraph : null, pa.h) } : placement(b, pa, mode, quote ? quote.paragraph : null);
    if (mode === "branch") pos.fy = anchorOff(quote ? quote.paragraph : 0, pa.h);
    addCard(b, "q:" + u.id, pos.x, pos.y, QW, QH);
    addCard(b, "a:" + u.id, pos.x, pos.y + QH + GQA, AW, aH(u));
    addEdge(b, pa.id, "q:" + u.id, mode === "branch" ? "branch" : "followup", mode === "branch" ? { fy: pos.fy, label: "Branch" } : { label: "Follow-up" });
    addEdge(b, "q:" + u.id, "a:" + u.id, "qa");
    relaxSources(b);
  });
  st.sel = "a:" + u.id;
  if (V !== "b") st.panel = true;
  render();
  var pl = find(curBoard(), "a:" + u.id);
  if (pl) revealPair(u);
  if (u.status === "running") stream(u);
  else toast("Queued: runs after the running answer in this conversation finishes.");
}
function revealPair(u) {
  var b = curBoard(), q = find(b, "q:" + u.id), a = find(b, "a:" + u.id);
  if (!q || !a) return;
  centerOn({ x: q.x, y: q.y, w: q.w, h: a.y + a.h - q.y }, true);
}
function askAbout(cid, text) {
  var b = curBoard(), pl = find(b, cid);
  var th = makeThread(text);
  var u = D.tu[th.rootTurnId];
  var x = pl.x + pl.w + 150, y = freeY(b, x, pl.y, QW, QH + GQA + 212);
  addCard(b, "q:" + u.id, x, y, QW, QH);
  addCard(b, "a:" + u.id, x, y + QH + GQA, AW, 212);
  addEdge(b, cid, "q:" + u.id, "ref", { label: "Asked about" });
  addEdge(b, "q:" + u.id, "a:" + u.id, "qa");
  B["r:" + th.id] = buildResearch(th);
  st.sel = "a:" + u.id;
  render();
  revealPair(u);
  stream(u);
}
function makeThread(text) {
  st.newSeq++;
  var id = "tn" + st.newSeq;
  var u = { id: id + "q1", threadId: id, parentId: null, relation: "root", anchor: null, question: text, title: titleFrom(text), provider: st.agent.provider, model: st.agent.model, effort: st.agent.effort,
    status: "running", createdAt: nowIso(), completedAt: null, durationSec: null, starred: false, recap: null, answer: [], error: null, sources: [], activity: [], highlights: [] };
  var th = { id: id, workspaceId: st.ws, folderId: null, kind: "exchange", title: titleFrom(text), provider: u.provider, model: u.model, effort: u.effort, status: "running",
    createdAt: u.createdAt, updatedAt: u.createdAt, lastViewedAt: null, unread: false, bookmarked: false, followed: false, archivedAt: null, recap: null, tags: [], links: [], rootTurnId: u.id, turns: [u] };
  D.threads.unshift(th); D.th[id] = th; D.tu[u.id] = u;
  return th;
}
function startThread(text, navigate) {
  st.comp.text = "";
  var th = makeThread(text);
  var rb = buildResearch(th);
  B[rb.id] = rb;
  if (B["w:" + st.ws]) { layoutWorkspace(B["w:" + st.ws], wsOf(st.ws)); B["w:" + st.ws].view = null; }
  st.sel = "a:" + th.rootTurnId;
  if (V !== "b") st.panel = true;
  if (navigate) go("board", rb.id);
  stream(D.tu[th.rootTurnId]);
}
function sendDraft(d) {
  D.drafts = D.drafts.filter((x) => x !== d);
  var a = st.agent; st.agent = { provider: d.provider, model: d.model, effort: a.effort };
  startThread(d.prompt, true);
  st.agent = a;
}
function newQuestion() {
  if (st.ws === "ws-new") { go("board", "welcome"); var t = E.world && E.world.querySelector(".c-big textarea"); if (t) t.focus(); return; }
  if (V === "b") { openPalette("new"); return; }
  st.sel = null; st.panel = true;
  if (st.view !== "board") go("board", "w:" + st.ws); else render();
  E.ta && E.ta.focus();
}
function addNote() {
  var b = curBoard(), v = b.view;
  st.newSeq++;
  var n = { id: "nn" + st.newSeq, workspaceId: st.ws, title: "Untitled note", updatedAt: nowIso(), tags: [], outline: [{ text: "Write here" }] };
  D.notes.push(n); D.notesById[n.id] = n;
  var cx = (E.cv.offsetWidth / 2 - v.tx) / v.z - BW / 2, cy = (E.cv.offsetHeight / 2 - v.ty) / v.z - 60;
  addCard(b, "n:" + n.id, Math.round(cx), Math.round(cy), BW, 120);
  st.sel = "n:" + n.id;
  render();
  flash("n:" + n.id);
}
function retry(t) {
  t.status = "running"; t.error = null; t.answer = []; t.activity = [];
  var b = curBoard();
  [b, B["r:" + t.threadId]].forEach((bb) => { var pl = bb && find(bb, "a:" + t.id); if (pl) pl.h = 212; });
  render();
  stream(t);
}
function tidy() {
  var b = curBoard();
  if (b.kind !== "research") return;
  layoutResearch(b, D.th[b.threadId]);
  if (st.ask && V === "b") placeAsk(b);
  renderBoard();
  fit(true);
  toast("Tidied: questions and follow-ups in columns, branches to the right.");
}

/* ---------------- streaming */
function stream(u) {
  var ws = D.th[u.threadId].workspaceId;
  var steps = STEPS[ws] || STEPS["ws-new"], paras = CANNED[ws] || CANNED["ws-new"];
  u.status = "running"; u.answer = []; u.activity = [];
  var t0 = Date.now();
  patch(u);
  steps.forEach((s, i) => {
    later(() => { u.activity.push({ kind: s[0], label: s[1], ms: 600, status: "ok" }); patch(u); }, 250 + i * 450);
  });
  var words = [];
  paras.forEach((p, pi) => { p.split(" ").forEach((w) => { words.push([pi, w]); }); });
  var i = 0, start = 250 + steps.length * 450;
  function tick() {
    var n = Math.min(words.length, i + 4);
    for (; i < n; i++) {
      var pi = words[i][0];
      u.answer[pi] = (u.answer[pi] ? u.answer[pi] + " " : "") + words[i][1];
    }
    patch(u);
    if (i < words.length) later(tick, 45);
    else {
      u.status = "done"; u.completedAt = nowIso(); u.durationSec = Math.max(4, Math.round((Date.now() - t0) / 1000));
      u.sources = []; patch(u, true);
      var q = D.th[u.threadId].turns.find((x) => x.parentId === u.id && x.status === "queued");
      if (q) later(() => { stream(q); }, 400);
    }
  }
  later(tick, start);
}
function patch(u, done) {
  var cid = "a:" + u.id;
  if (E.world) {
    var el = E.world.querySelector('[data-cid="' + cssEsc(cid) + '"]');
    var b = curBoard(), pl = find(b, cid);
    if (el && pl) { var n = cardNode(b, pl); el.replaceWith(n); }
  }
  if (st.view === "board" && (st.sel === cid || st.sel === "q:" + u.id)) {
    if (E.panel) refreshPanelBody();
    if (V === "b" && st.overlay === cid && E.pscroll) { E.pscroll.replaceChildren(); editorInto(E.pscroll, cid, "overlay"); }
  }
  if (done) { renderSidebarOnly(); if (E.panel && st.sel === cid) renderPanel(); toast("Answer finished: " + u.title); }
}
function renderSidebarOnly() {
  var old = root.querySelector(".side");
  if (old) old.replaceWith(renderSidebar());
}

/* ---------------- pages */
function renderPage() {
  var pg = dv("page"), inn = dv("page-in");
  pg.append(inn);
  var ws = wsOf(st.ws);
  if (st.view === "inbox") {
    inn.append(h("h1", null, "Inbox"), h("p", { class: "sub" }, "Runs that finished, failed, wait for you, or are still working in " + ws.name + "."));
    var items = D.inbox.filter((i) => { var t = D.th[i.threadId]; return t && t.workspaceId === st.ws; });
    var groups = [["Needs you", ["clarify", "failed"]], ["New answers", ["unread"]], ["In progress", ["running", "queued"]]];
    var any = false;
    groups.forEach((g) => {
      var list = items.filter((i) => g[1].indexOf(i.kind) >= 0);
      if (!list.length) return;
      any = true;
      inn.append(h("h3", null, g[0] + " · " + list.length));
      list.forEach((i) => {
        var k = { clarify: ["att", "help"], failed: ["err", "alert"], unread: ["new", "answer"], running: ["run", "clock"], queued: ["plain", "clock"] }[i.kind];
        inn.append(h("button", { class: "icard", onclick: () => { goCard("a:" + i.turnId); } }, h("span", { class: "ib " + k[0] }, ic(k[1])),
          h("div", null, h("b", null, i.title), h("p", null, i.detail), h("small", null, D.th[i.threadId].title + " · " + fmtTime(i.createdAt, NOW)))));
      });
    });
    if (!any) inn.append(h("p", { class: "pn-empty" }, "Nothing needs you in this workspace. Finished, failed and waiting runs appear here."));
  } else if (st.view === "journal") {
    inn.append(h("h1", null, "Journal"), h("p", { class: "sub" }, "One page per day. Type @ to mention a card; mentioned cards keep a link back to this day."));
    var day1 = dv("jday", h("h2", null, "Sunday, October 11"));
    function mention(cid, label) { return h("span", { class: "mention", onclick: () => { goCard(cid); } }, ic(info(cid).type === "note" ? "note" : "answer"), label); }
    if (st.ws === "ws-ml") {
      day1.append(h("p", null, sn("t", "17:06"), "Queued the FP8 estimate behind ", mention("a:t3q3", "Concurrency on 2xH100"), "."));
      day1.append(h("p", null, sn("t", "08:52"), "Litestream plot failed on S3 permissions; ask infra for s3:ListBucket. ", mention("a:t4q2", "Plot lag from S3 segment timestamps")));
    } else if (st.ws === "ws-reading") {
      day1.append(h("p", null, sn("t", "09:40"), "Still owe Claude an answer on voter replacement: ", mention("a:t5q1", "Which membership-change method?")));
    } else {
      day1.append(h("p", null, sn("t", "16:48"), "Sweep test landed: 300 cases pass with the fix. ", mention("a:t1q4", "Regression sweep test")));
      day1.append(h("p", null, sn("t", "16:55"), "Updated ", mention("n:n1", "JIT correctness checklist"), " with the sign-extension rule."));
      day1.append(h("p", null, sn("t", "17:18"), "test262 built-ins/Math run started; 212 of 327 files so far. ", mention("a:t2q3", "Patch and run test262 hypot")));
    }
    day1.append(h("p", { class: "jwrite", contenteditable: "true" }, "Write…"));
    inn.append(day1);
    var day2 = dv("jday", h("h2", null, "Saturday, October 10"));
    day2.append(h("p", null, sn("t", "14:09"), "Found the getInt16 bug: sign extension before the byte swap. ", mention("a:t1q1", "Find the getInt16 codegen bug")));
    inn.append(day2);
  } else if (st.view === "library") {
    inn.append(h("h1", null, "Card Library"), h("p", { class: "sub" }, "Every card in " + ws.name + ": answers, questions, your notes, highlights and sources. Drag cards from here onto any whiteboard in variant D."));
    var tb = h("div", { class: "chips", style: { padding: "0 0 12px" } });
    [["all", "All"], ["answer", "Answers"], ["note", "Notes"], ["highlight", "Highlights"], ["question", "Questions"], ["source", "Sources"]].forEach((t) => {
      tb.append(h("button", { class: "chip" + (st.lib.type === t[0] ? " on" : ""), onclick: () => { st.lib.type = t[0]; render(); } }, t[1]));
    });
    inn.append(tb);
    var rows = libraryItems(true).filter((it) => st.lib.type === "all" || it.type === st.lib.type);
    var tbl = h("table", { class: "tbl" }, h("thead", null, h("tr", null, h("th", null, "Card"), h("th", null, "Type"), h("th", null, "Whiteboards"), h("th", null, "Updated"))));
    var tbody = h("tbody");
    rows.slice(0, 60).forEach((it) => {
      var n = usedIn(it.cid).length;
      tbody.append(h("tr", { onclick: () => { goCard(it.cid); } }, h("td", null, h("b", null, it.title.length > 90 ? it.title.slice(0, 90) + "…" : it.title)), h("td", null, it.typeLabel), h("td", null, n ? (n > 1 ? sn("reuse", "in " + n) : "in 1") : "—"), h("td", { style: { whiteSpace: "nowrap", color: "var(--ink-3)" } }, it.when ? fmtTime(it.when, NOW) : "")));
    });
    tbl.append(tbody);
    inn.append(tbl);
  } else if (st.view === "tags") {
    inn.append(h("h1", null, "Tags"), h("p", { class: "sub" }, "Each tag is a table of the cards that carry it, with their properties."));
    var counts = {};
    D.threads.forEach((t) => { if (t.workspaceId === st.ws) t.tags.forEach((g) => { counts[g] = (counts[g] || 0) + 1; }); });
    D.notes.forEach((n) => { if (n.workspaceId === st.ws) n.tags.forEach((g) => { counts[g] = (counts[g] || 0) + 1; }); });
    var tags = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
    if (tags.indexOf(st.tag) < 0) st.tag = tags[0];
    var tl = dv("taglist");
    tags.forEach((g) => { tl.append(h("button", { class: "row" + (g === st.tag ? " on" : ""), onclick: () => { st.tag = g; render(); } }, ic("tag"), sn("lbl", g), sn("cnt", String(counts[g])))); });
    var t2 = h("table", { class: "tbl" }, h("thead", null, h("tr", null, h("th", null, "#" + (st.tag || "")), h("th", null, "Kind"), h("th", null, "Status"), h("th", null, "Agent"), h("th", null, "Updated"))));
    var tb2 = h("tbody");
    D.threads.filter((t) => t.workspaceId === st.ws && t.tags.indexOf(st.tag) >= 0).forEach((t) => {
      var r = D.tu[t.rootTurnId];
      tb2.append(h("tr", { onclick: () => { goCard("b:" + t.id); } }, h("td", null, h("b", null, t.title)), h("td", null, "Research whiteboard"), h("td", null, threadPill(t) || pill("done", D.statuses)), h("td", null, sn("agent", h("i", { class: "pdot " + r.provider }), r.model)), h("td", { style: { whiteSpace: "nowrap", color: "var(--ink-3)" } }, fmtTime(t.updatedAt, NOW))));
    });
    D.notes.filter((n) => n.workspaceId === st.ws && n.tags.indexOf(st.tag) >= 0).forEach((n) => {
      tb2.append(h("tr", { onclick: () => { goCard("n:" + n.id); } }, h("td", null, h("b", null, n.title)), h("td", null, "Note"), h("td", null, "—"), h("td", null, "—"), h("td", { style: { whiteSpace: "nowrap", color: "var(--ink-3)" } }, fmtTime(n.updatedAt, NOW))));
    });
    t2.append(tb2);
    inn.append(dv("tagsplit", tl, h("div", { style: { flex: "1", minWidth: "0" } }, t2)));
  } else if (st.view === "highlights") {
    inn.append(h("h1", null, "Highlights & sources"), h("p", { class: "sub" }, "Passages you highlighted in answers, and the pages agents cited. Each one is a card you can place on a whiteboard."));
    inn.append(dv("ptabs", dv("seg",
      h("button", { class: st.hlTab === "highlights" ? "on" : "", onclick: () => { st.hlTab = "highlights"; render(); } }, ic("highlight"), "Highlights"),
      h("button", { class: st.hlTab === "sources" ? "on" : "", onclick: () => { st.hlTab = "sources"; render(); } }, ic("globe"), "Sources"))));
    if (st.hlTab === "highlights") {
      Object.keys(D.hl).map((k) => D.hl[k]).filter((x) => D.th[x.threadId].workspaceId === st.ws).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).forEach((x) => {
        inn.append(h("div", { class: "hlrow", onclick: () => { goCard("h:" + x.id); } }, h("q", null, x.quote), x.note ? dv("nt", x.note) : null, h("small", null, D.tu[x.turnId].title + " · " + D.th[x.threadId].title + " · " + fmtTime(x.createdAt, NOW))));
      });
    } else {
      Object.keys(D.src).map((k) => D.src[k]).filter((s) => D.th[D.tu[s.refs[0]].threadId].workspaceId === st.ws).forEach((s) => {
        inn.append(h("button", { class: "icard", onclick: () => { goCard("s:" + s.url); } }, h("span", { class: "fav", style: { width: "24px", height: "24px", fontSize: "11px" } }, s.domain.charAt(0).toUpperCase()), h("div", null, h("b", null, s.title), h("small", null, s.domain + " · cited by " + s.refs.map((r) => D.tu[r].title).join(", ")))));
      });
    }
  }
  E.content.replaceChildren(pg);
  E.cv = null; E.world = null; E.fbar = null; E.mm = null;
}

/* ---------------- overlays: menus, palette, toast, selection bar */
function renderOverlays() {
  if (st.menu) E.app.append(st.menu.el);
  if (st.palette) E.app.append(paletteEl());
}
function openMenu(kind, anchor) {
  closeMenu();
  var r = anchor.getBoundingClientRect(), rr = root.getBoundingClientRect(), s = rootScale();
  var x = (r.left - rr.left) / s, y = (r.bottom - rr.top) / s + 4;
  var m = dv("menu");
  if (kind === "ws") {
    m.append(dv("mh", "Workspaces · folders on disk"));
    D.workspaces.forEach((w) => {
      if (w.fresh) return;
      m.append(h("button", { class: "mi", onclick: () => { switchWs(w.id); } }, ic("board"), w.name, h("small", null, w.dir), w.id === st.ws ? ic("check", "ck") : null));
    });
    m.append(dv("msep"));
    m.append(h("button", { class: "mi", onclick: () => { switchWs("ws-new"); } }, ic("plus"), "New workspace…"));
    m.append(h("button", { class: "mi", onclick: () => { closeMenu(); toast("Opened in Finder"); } }, ic("open"), "Open in Finder"));
  } else if (kind === "agent") {
    D.providers.forEach((p) => {
      m.append(dv("mh", p.label + (p.id === "codex" ? " · sign-in needed" : "")));
      p.models.slice(0, 3).forEach((mo) => {
        m.append(h("button", { class: "mi", onclick: () => { st.agent = { provider: p.id, model: mo, effort: p.efforts.length ? (p.efforts.indexOf(st.agent.effort) >= 0 ? st.agent.effort : "high") : null }; closeMenu(); rerenderAgentSpots(); } },
          h("i", { class: "pdot " + p.id }), mo, st.agent.provider === p.id && st.agent.model === mo ? ic("check", "ck") : null));
      });
    });
    if (y > 500) { y = Math.max(8, (r.top - rr.top) / s - 380); }
    x = Math.min(x, 1280 - 236);
  }
  m.style.left = x + "px"; m.style.top = y + "px";
  st.menu = { el: m };
  E.app.append(m);
}
function closeMenu() { if (st.menu) { st.menu.el.remove(); st.menu = null; } }
function rerenderAgentSpots() { if (E.panel) renderPanel(); if (st.view === "board" && curBoard().kind === "welcome") renderBoard(); }
function openPalette(mode) { st.palette = { q: "", i: 0, mode: mode || "search" }; closeMenu(); var old = root.querySelector(".pal-scrim"); if (old) old.remove(); E.app.append(paletteEl()); }
function paletteEl() {
  var p = st.palette;
  var inp = h("input", { placeholder: p.mode === "new" ? "Ask a question to start a research whiteboard…" : "Search cards, whiteboards and notes", "aria-label": "Search" });
  inp.value = p.q;
  var res = dv("res");
  var scrim = h("div", { class: "scrim pal-scrim", onclick: (e) => { if (e.target === scrim) closePalette(); } }, dv("pal", inp, res));
  function fill() {
    res.replaceChildren();
    if (p.mode === "new") { res.append(h("div", { class: "pn-empty", style: { padding: "8px 10px" } }, "Enter creates a research whiteboard and asks " + agentText(st.agent) + ".")); return; }
    var q = p.q.toLowerCase();
    var items = libraryItems(false).concat(D.threads.map((t) => { return { cid: "b:" + t.id, type: "board", typeLabel: "Research whiteboard", title: t.title, text: t.tags.map((g) => "#" + g).join(" "), when: t.updatedAt }; }));
    items = items.filter((it) => !q || (it.title + " " + it.text).toLowerCase().indexOf(q) >= 0);
    if (!q) items = items.filter((it) => it.type === "board");
    p.list = items.slice(0, 8);
    p.list.forEach((it, i) => { var r = libRow(it, false); if (i === p.i) r.classList.add("on"); res.append(r); });
    if (!p.list.length) res.append(h("div", { class: "pn-empty", style: { padding: "8px 10px" } }, "No cards match."));
  }
  inp.addEventListener("input", () => { p.q = inp.value; p.i = 0; fill(); });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closePalette(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); p.i = Math.min((p.list || []).length - 1, p.i + 1); fill(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); p.i = Math.max(0, p.i - 1); fill(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (p.mode === "new") { if (p.q.trim()) { var t = p.q.trim(); closePalette(); startThread(t, true); } return; }
      var it = p.list && p.list[p.i]; if (it) { closePalette(); if (it.type === "board") go("board", "r:" + it.cid.slice(2)); else goCard(it.cid); }
    }
  });
  fill();
  later(() => { inp.focus(); }, 0);
  return scrim;
}
function closePalette() { st.palette = null; var s = root.querySelector(".pal-scrim"); if (s) s.remove(); }
var toastT = null;
function toast(msg) {
  var old = root.querySelector(".toast"); if (old) old.remove();
  var t = h("div", { class: "toast", role: "status" }, msg);
  (E.app || root).append(t);
  if (toastT) clearTimeout(toastT);
  toastT = later(() => { t.remove(); }, 2600);
}
var selBar = null;
function closeSelBar() { if (selBar) { selBar.remove(); selBar = null; } }
function onMouseUp(e) {
  var body = e.target.closest && e.target.closest(".ed-body[data-turn]");
  closeSelBar();
  if (!body) return;
  var sel = window.getSelection();
  var text = sel ? String(sel).trim() : "";
  if (!text || text.length < 3) return;
  var pEl = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement).closest("p[data-p]");
  if (!pEl) return;
  var turnId = body.getAttribute("data-turn"), para = +pEl.getAttribute("data-p");
  var rect = sel.getRangeAt(0).getBoundingClientRect(), rr = root.getBoundingClientRect(), s = rootScale();
  var quote = text.slice(0, 160);
  var t = D.tu[turnId];
  var busy = t.status === "running";
  selBar = h("div", { class: "selbar", style: { left: ((rect.left + rect.width / 2 - rr.left) / s) + "px", top: ((rect.top - rr.top) / s - 6) + "px" } },
    h("div", { class: "fbar", style: { transform: "none" } },
      h("button", { title: busy ? "Wait for the answer to finish" : "Branch from this passage", disabled: busy ? true : null, onmousedown: (ev) => { ev.preventDefault(); }, onclick: () => { closeSelBar(); branchFromQuote(turnId, para, quote); } }, ic("branch"), "Branch"),
      h("button", { title: "Save as a highlight card", onmousedown: (ev) => { ev.preventDefault(); }, onclick: () => { closeSelBar(); addHighlight(turnId, para, quote); } }, ic("highlight"), "Highlight"),
      h("button", { onmousedown: (ev) => { ev.preventDefault(); }, onclick: () => { closeSelBar(); toast("Copied"); } }, ic("copy"), "Copy")));
  selBar.style.transform = "translate(-50%,-100%)";
  E.app.append(selBar);
}
function branchFromQuote(turnId, para, quote) {
  if (V === "b") {
    st.overlay = null;
    st.ask = { mode: "branch", parent: turnId, text: "", quote: { turnId: turnId, paragraph: para, quote: quote } };
    placeAsk(curBoard()); renderBoard();
    var pl = find(curBoard(), "ask:1"); if (pl) centerOn(pl, true);
    var ta = E.world.querySelector(".c-ask textarea"); if (ta) ta.focus();
    return;
  }
  st.comp.mode = "branch"; st.comp.quote = { turnId: turnId, paragraph: para, quote: quote };
  renderPanel(); E.ta && E.ta.focus();
}
function addHighlight(turnId, para, quote) {
  var t = D.tu[turnId];
  st.newSeq++;
  var x = { id: "hn" + st.newSeq, paragraph: para, quote: quote, color: "amber", note: null, createdAt: nowIso(), turnId: turnId, threadId: t.threadId };
  t.highlights.push(x); D.hl[x.id] = x;
  var rb = B["r:" + t.threadId], pa = rb && find(rb, "a:" + t.id);
  if (pa) {
    var y = pa.y;
    while (rb.cards.some((c) => c.x === pa.x - LANE && Math.abs(c.y - y) < HLH)) y += HLH + 14;
    addCard(rb, "h:" + x.id, pa.x - LANE, y, HLW, HLH);
    addEdge(rb, "h:" + x.id, pa.id, "hl");
    relaxSources(rb);
  }
  if (V === "b") renderBoard(); else render();
  toast("Highlight saved as a card next to its answer.");
  flash("h:" + x.id);
}

/* ---------------- keyboard */
function onKey(e) {
  var tag = e.target && e.target.tagName;
  var typing = tag === "TEXTAREA" || tag === "INPUT" || (e.target && e.target.isContentEditable);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") { e.preventDefault(); newQuestion(); return; }
  if (typing) { if (e.key === "Escape") e.target.blur(); return; }
  if (e.key === "Escape") {
    if (st.menu) closeMenu();
    else if (st.palette) closePalette();
    else if (st.overlay) { st.overlay = null; renderBoard(); }
    else if (st.ask) cancelAsk();
    else select(null);
    return;
  }
  if (st.view !== "board") return;
  if (e.key === " ") { spaceDown = true; E.cv && E.cv.classList.add("hand"); e.preventDefault(); return; }
  if (e.key === "Enter" && st.sel) { e.preventDefault(); var f = info(st.sel); if (f.type === "board") go("board", "r:" + f.thread.id); else openCard(st.sel); return; }
  if (e.key === "=" || e.key === "+") { zoomBy(1.2); return; }
  if (e.key === "-") { zoomBy(1 / 1.2); return; }
  if (e.key === "!" || (e.shiftKey && e.key === "1")) { fit(true); return; }
  if (e.key === "0" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); zoomTo(1); return; }
  if (e.key === "v") { st.tool = "select"; renderBoard(); return; }
  if (e.key === "h") { st.tool = "hand"; renderBoard(); return; }
  if (e.key === "n") { addNote(); return; }
  if (e.key === "a") { askFromSelection(); return; }
  if (/^Arrow/.test(e.key)) { e.preventDefault(); spatial(e.key); }
}
function onKeyUp(e) { if (e.key === " ") { spaceDown = false; E.cv && st.tool !== "hand" && E.cv.classList.remove("hand"); } }
function spatial(key) {
  var b = curBoard();
  var cur = st.sel && find(b, st.sel);
  var cards = b.cards.filter((c) => !/^(tip|start):/.test(c.id));
  if (!cur) { var first = cards[0]; if (first) { select(first.id); centerOn(first, true); } return; }
  var cx = cur.x + cur.w / 2, cy = cur.y + cur.h / 2, best = null, bd = 1e9;
  cards.forEach((c) => {
    if (c === cur) return;
    var x = c.x + c.w / 2, y = c.y + c.h / 2, dx = x - cx, dy = y - cy;
    var ok = key === "ArrowRight" ? dx > 20 : key === "ArrowLeft" ? dx < -20 : key === "ArrowDown" ? dy > 20 : dy < -20;
    if (!ok) return;
    var main = key === "ArrowRight" || key === "ArrowLeft" ? Math.abs(dx) : Math.abs(dy);
    var side = key === "ArrowRight" || key === "ArrowLeft" ? Math.abs(dy) : Math.abs(dx);
    var d = main + side * 2.5;
    if (d < bd) { bd = d; best = c; }
  });
  if (best) { select(best.id); centerOn(best, true); }
}

/* ---------------- wire up */
on(root, "pointermove", onMove);
on(root, "pointerup", onUp);
on(root, "keydown", onKey);
on(root, "keyup", onKeyUp);
on(root, "mouseup", (e) => { later(() => { onMouseUp(e); }, 0); });
on(root, "pointerdown", (e) => {
  if (st.menu && !e.target.closest(".menu")) closeMenu();
  if (selBar && !e.target.closest(".selbar")) closeSelBar();
});
render();
if (V === "b") {
  later(() => { var pl = find(curBoard(), "ask:1"); if (pl && E.cv) { /* view already fits */ } }, 0);
}

return function cleanup() {
  timers.forEach(clearTimeout);
  offs.forEach((f) => { f(); });
  root.removeAttribute("tabindex");
  root.replaceChildren();
};
}
})();
