/*
 * Session redesign candidate "tana", round 2.
 * Reference: Tana (outliner family: Roam, Logseq, Workflowy).
 * Everything is a node: threads are pages, each ask is a #question node, its answer
 * paragraphs are child nodes, follow-ups are next siblings, branches nest under the
 * paragraph they came from. Fields, live searches, views and references on top.
 */
(() => {
"use strict";
var SC = "m-tana-r2";
var S = "." + SC;

/* -- icons */
var ICONS = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  today: '<rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  inbox: '<path d="M4 13l2.5-7.5h11L20 13v5.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/><path d="M4 13h4.5l1.5 2.5h4l1.5-2.5H20"/>',
  run: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  hash: '<path d="M9.5 4L8 20M16 4l-1.5 16M4.5 9h15M4 15h15"/>',
  chev: '<path d="M9.5 6l6 6-6 6"/>',
  down: '<path d="M6 9.5l6 6 6-6"/>',
  left: '<path d="M15 5l-7 7 7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>',
  cards: '<rect x="3.5" y="4.5" width="7.5" height="7" rx="1.5"/><rect x="13" y="4.5" width="7.5" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7.5" height="6" rx="1.5"/><rect x="13" y="13.5" width="7.5" height="6" rx="1.5"/>',
  outline: '<path d="M10 6h10M13 12h7M13 18h7"/><circle cx="5.5" cy="6" r="1.3"/><circle cx="8.5" cy="12" r="1.3"/><circle cx="8.5" cy="18" r="1.3"/>',
  field: '<path d="M5 7h14M5 12h9M5 17h11"/>',
  box: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>',
  globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
  branch: '<circle cx="7" cy="5.5" r="2"/><circle cx="7" cy="18.5" r="2"/><circle cx="17" cy="8" r="2"/><path d="M7 7.5v9M17 10c0 4-5 3.5-9.2 7"/>',
  reply: '<path d="M10 8L5 12l5 4"/><path d="M5 12h9a5 5 0 0 1 5 5v1"/>',
  sum: '<path d="M17 5H7l5 7-5 7h10"/>',
  pin: '<path d="M9 4h6l-1 5 3 3H7l3-3z"/><path d="M12 12v8"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  more: '<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>',
  book: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z"/>',
  hl: '<path d="M5 20h6M14.5 5.5l4 4L10 18H6v-4z"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  trace: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  note: '<path d="M6 4h9l4 4v12H6z"/><path d="M14 4v5h5"/>',
  retry: '<path d="M5 12a7 7 0 1 0 2.1-5"/><path d="M5 4v4h4"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/>',
  refadd: '<path d="M7 17L17 7M9 7h8v8"/>',
  think: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z"/>',
  read: '<path d="M6 4h9l4 4v12H6z"/><path d="M9 12h7M9 16h5"/>',
  grep: '<circle cx="10" cy="10" r="5.5"/><path d="M14 14l5.5 5.5M8 10h4"/>',
  fetch: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  term: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M7.5 10l3 2.5-3 2.5M12.5 15.5h4"/>',
  edit: '<path d="M14.5 5.5l4 4L9 19H5v-4z"/>',
  archive: '<rect x="3.5" y="5" width="17" height="4.5" rx="1"/><path d="M5 9.5V19h14V9.5M10 13h4"/>',
  draft: '<path d="M5 19h14M7 15l9.5-9.5 2.5 2.5L9.5 17.5H7z"/>',
  x: '<path d="M7 7l10 10M17 7L7 17"/>',
  graph: '<circle cx="6" cy="7" r="2.3"/><circle cx="18" cy="6" r="2.3"/><circle cx="11" cy="18" r="2.3"/><path d="M8.3 6.8l7.4-.6M7.2 9l2.7 6.8M16.8 8l-4.6 8"/>',
};
function ic(name, size) {
  var s = size || 16;
  return '<svg class="ic" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || "") + "</svg>";
}

/* -- css */
/* "@" stands for the scope class; expanded in register() so every selector starts with .m-tana-r2 */
var CSS = `
${S}{--bg:#ffffff;--side:#f7f7f5;--side-h:#ededea;--side-sel:#e7e7e3;--tx:#1d1d20;--tx2:#46464d;--mu:#86868f;--mu2:#b0b0b7;--ln:#e9e9e6;--gd:#e7e7e4;--hv:#f5f5f3;--sel:#eff0fd;--selb:#cfd2f7;--acc:#5b5bd6;--acc-tx:#ffffff;--code:#f1f0ed;--codetx:#36363d;--halo:#e3e3e0;--bul:#4c4c53;--pop:#ffffff;--shadow:0 12px 32px rgba(20,20,30,.16),0 0 0 1px rgba(20,20,30,.07);
--c-question:#7556e6;--c-thread:#2d7bd8;--c-source:#0f8f7d;--c-note:#c27b06;--c-highlight:#b88a00;--c-day:#d1453c;--c-folder:#6b6f7a;--c-workspace:#6b6f7a;--c-guide:#d1453c;--c-summary:#2d7bd8;--c-search:#6b6f7a;--c-step:#2e9a58;
--s-run:#c4860c;--s-ok:#2b9a57;--s-err:#cf4039;--s-att:#7556e6;--s-plain:#8b8b93;
--hl-amber:rgba(247,192,60,.36);--hl-green:rgba(64,190,110,.26);--hl-blue:rgba(70,140,240,.22);--hl-pink:rgba(240,90,150,.22);
--claude:#cc7c52;--codex:#3f9e6e;--grok:#5a5a66;
font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;line-height:24px;color:var(--tx);background:var(--bg);-webkit-font-smoothing:antialiased;font-feature-settings:"cv11","ss03";}
@[data-theme="dark"]{--bg:#1a1a1d;--side:#212124;--side-h:#2b2b2f;--side-sel:#313136;--tx:#e9e9ec;--tx2:#c3c3c9;--mu:#8e8e97;--mu2:#64646c;--ln:#2d2d31;--gd:#323237;--hv:#232327;--sel:#272944;--selb:#41458a;--acc:#8487f0;--acc-tx:#16161a;--code:#2a2a2f;--codetx:#dadade;--halo:#3a3a40;--bul:#bdbdc4;--pop:#28282c;--shadow:0 14px 36px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08);
--c-question:#a48eff;--c-thread:#6aa9f4;--c-source:#3cc3ad;--c-note:#e7a93d;--c-highlight:#e3bd47;--c-day:#f07b72;--c-folder:#9d9da7;--c-workspace:#9d9da7;--c-guide:#f07b72;--c-summary:#6aa9f4;--c-search:#9d9da7;--c-step:#5cc488;
--s-run:#e5ae40;--s-ok:#5cc488;--s-err:#f2746d;--s-att:#a48eff;--s-plain:#8e8e97;
--hl-amber:rgba(236,178,52,.30);--hl-green:rgba(80,200,120,.24);--hl-blue:rgba(90,150,245,.26);--hl-pink:rgba(240,100,160,.26);
--claude:#e09a74;--codex:#6cc496;--grok:#a3a3ae;}
@ .app{position:absolute;inset:0;display:grid;grid-template-columns:240px minmax(0,1fr);background:var(--bg);outline:none;overflow:hidden}
@ .app.with-panel{grid-template-columns:240px minmax(0,1fr) 308px}
@ button{font-family:inherit}
@ .ic{flex:none;display:block}

/* sidebar */
@ .side{background:var(--side);border-right:1px solid var(--ln);display:flex;flex-direction:column;min-height:0;min-width:0}
@ .tl{height:40px;display:flex;align-items:center;gap:8px;padding:0 15px;flex:none}
@ .tl i{width:12px;height:12px;border-radius:50%;display:block;background:#ff5f57;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.15)}
@ .tl i:nth-child(2){background:#febc2e}@ .tl i:nth-child(3){background:#28c840}
@ .wsw{margin:0 8px 4px;display:flex;align-items:center;gap:9px;padding:5px 8px;border-radius:7px;cursor:pointer;border:0;background:transparent;color:var(--tx);width:calc(100% - 16px);text-align:left;font:inherit}
@ .wsw:hover{background:var(--side-h)}
@ .wsi{width:22px;height:22px;border-radius:6px;background:var(--acc);color:var(--acc-tx);font-size:11.5px;font-weight:600;display:grid;place-items:center;flex:none;line-height:1}
@ .wsw b{font-weight:600;font-size:13.5px;line-height:17px;display:block}
@ .wsw small{display:block;color:var(--mu);font-size:11.5px;line-height:14px;font-family:"JetBrains Mono",ui-monospace,monospace;letter-spacing:-.02em}
@ .wsw .ic{color:var(--mu);margin-left:auto}
@ .side-scroll{flex:1;overflow:auto;padding:2px 8px 12px;min-height:0}
@ .si{display:flex;align-items:center;gap:8px;height:28px;padding:0 8px;border-radius:6px;color:var(--tx2);font-size:13.5px;cursor:pointer;white-space:nowrap;border:0;background:none;width:100%;text-align:left;position:relative}
@ .si:hover{background:var(--side-h)}
@ .si.on{background:var(--side-sel);color:var(--tx);font-weight:500}
@ .si.drop{box-shadow:inset 0 0 0 1.5px var(--acc);background:var(--sel)}
@ .si > .ic{color:var(--mu)}
@ .si .lbl{flex:1;overflow:hidden;text-overflow:ellipsis;min-width:0}
@ .si .cnt{font-size:12px;color:var(--mu);font-variant-numeric:tabular-nums}
@ .si .cnt.att{color:#fff;background:var(--s-err);border-radius:9px;padding:0 6px;line-height:17px;font-weight:600;font-size:11px}
@ .si .stog{width:14px;height:14px;display:grid;place-items:center;color:var(--mu2);margin-left:-4px;margin-right:-4px;border-radius:3px}
@ .si .stog .ic{transition:transform .12s}
@ .si .stog.open .ic{transform:rotate(90deg)}
@ .si .sb{width:16px;height:16px;display:grid;place-items:center;flex:none}
@ .si .sb::after{content:"";width:5px;height:5px;border-radius:50%;background:var(--tc,var(--mu))}
@ .si .sb.ring::after{width:7px;height:7px;background:transparent;box-shadow:inset 0 0 0 1.5px var(--tc,var(--mu))}
@ .sh{font-size:11.5px;font-weight:600;color:var(--mu);padding:14px 8px 3px;letter-spacing:.02em;display:flex;align-items:center;gap:6px}
@ .sh button{margin-left:auto;border:0;background:none;color:var(--mu);width:20px;height:20px;border-radius:5px;display:grid;place-items:center;cursor:pointer}
@ .sh button:hover{background:var(--side-h);color:var(--tx)}
@ .s-empty{font-size:12.5px;color:var(--mu);padding:2px 8px 2px 32px;line-height:20px}
@ .side-foot{border-top:1px solid var(--ln);padding:6px 8px;display:flex;align-items:center;gap:8px}
@ .avatar{width:22px;height:22px;border-radius:50%;background:var(--side-sel);color:var(--tx2);font-size:10.5px;font-weight:600;display:grid;place-items:center;flex:none}
@ .side-foot .who{font-size:13px;color:var(--tx2);flex:1}

/* main */
@ .main{display:flex;flex-direction:column;min-width:0;min-height:0;position:relative}
@ .bar{height:40px;display:flex;align-items:center;gap:2px;padding:0 10px 0 8px;flex:none;border-bottom:1px solid var(--ln)}
@ .ib{width:28px;height:28px;border-radius:6px;border:0;background:none;color:var(--mu);display:grid;place-items:center;cursor:pointer;flex:none}
@ .ib:hover{background:var(--hv);color:var(--tx)}
@ .ib:disabled{opacity:.35;cursor:default;background:none}
@ .ib.on{color:var(--acc);background:var(--sel)}
@ .crumbs{display:flex;align-items:center;gap:0;min-width:0;flex:1;font-size:13px;color:var(--mu);overflow:hidden;white-space:nowrap;margin-left:6px}
@ .crumbs button{border:0;background:none;color:inherit;font:inherit;padding:2px 6px;border-radius:5px;cursor:pointer;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@ .crumbs button:hover{background:var(--hv);color:var(--tx)}
@ .crumbs .cur{color:var(--tx);font-weight:500}
@ .crumbs .sep{color:var(--mu2);font-size:12px}
@ .kbtn{display:flex;align-items:center;gap:8px;height:28px;padding:0 6px 0 9px;border-radius:7px;border:1px solid var(--ln);background:var(--bg);color:var(--mu);font-size:12.5px;cursor:pointer;width:208px;margin-right:8px;white-space:nowrap}
@ .kbtn:hover{border-color:var(--mu2);color:var(--tx2)}
@ kbd{font-family:inherit;font-size:11px;color:var(--mu);border:1px solid var(--ln);border-radius:4px;padding:0 4px;line-height:16px;margin-left:auto;background:var(--bg)}
@ .scroll{flex:1;overflow:auto;min-height:0}
@ .page.wide{max-width:1000px}
@ .page{max-width:840px;padding:26px 48px 140px 64px;margin:0 auto}

/* page header */
@ .ph{margin-bottom:12px}
@ .ph-t{display:flex;align-items:baseline;gap:4px;flex-wrap:wrap}
@ .ph h1{font-size:27px;line-height:35px;font-weight:650;letter-spacing:-.018em;margin:0;outline:none;color:var(--tx)}
@ .ph h1.mid{font-size:20px;line-height:29px;font-weight:600;letter-spacing:-.01em}
@ .ph h1.small{font-size:17px;line-height:26px;font-weight:500;letter-spacing:0}
@ .ph h1 code{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:.82em;background:var(--code);padding:1px 5px;border-radius:5px;font-weight:500}
@ .ph-meta{font-size:12.5px;color:var(--mu);margin-top:3px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;line-height:20px}
@ .ph-meta .dot{width:3px;height:3px;border-radius:50%;background:var(--mu2)}
@ .ph-meta button.lnk{border:0;background:none;padding:0;color:var(--tx2);font:inherit;cursor:pointer;text-decoration:underline;text-decoration-color:var(--mu2);text-underline-offset:2px}
@ .ph .flds{padding-left:0;margin-top:10px}
@ .ph-top{display:flex;align-items:flex-start;gap:16px}
@ .ph-top > .ph-t{flex:1;min-width:0}
@ .ph-acts{margin-left:auto;display:flex;gap:2px;margin-top:4px;flex:none}
@ .views{display:flex;gap:2px;margin:14px 0 8px;border-bottom:1px solid var(--ln);padding-bottom:6px}
@ .vt{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:6px;border:0;background:none;color:var(--mu);font-size:12.5px;cursor:pointer}
@ .vt:hover{background:var(--hv);color:var(--tx)}
@ .vt.on{background:var(--side-sel);color:var(--tx);font-weight:500}
@ .views .vinfo{margin-left:auto;font-size:12px;color:var(--mu);align-self:center}

/* outline rows */
@ .row{position:relative}
@ .line{display:grid;grid-template-columns:18px minmax(0,1fr);column-gap:6px;align-items:start;min-height:26px;padding:1px 6px 1px 0;border-radius:6px;position:relative}
@ .line:hover{background:var(--hv)}
@ .row.sel > .line{background:var(--sel);box-shadow:inset 0 0 0 1px var(--selb)}
@ .row.flash > .line{animation:tr2-flash 1.6s ease-out}
@ .row.drop > .line{box-shadow:inset 0 -2px 0 var(--acc)}
@ .tog{position:absolute;left:-21px;top:5px;width:17px;height:17px;border:0;background:none;color:var(--mu);display:grid;place-items:center;opacity:0;cursor:pointer;border-radius:4px;padding:0}
@ .tog .ic{transition:transform .12s}
@ .tog.open .ic{transform:rotate(90deg)}
@ .tog:hover{background:var(--side-h);color:var(--tx)}
@ .line:hover > .tog{opacity:1}
@ .bul{width:18px;height:24px;display:grid;place-items:center;cursor:pointer;position:relative}
@ .bul::before{content:"";width:16px;height:16px;border-radius:50%;position:absolute;left:1px;top:4px;background:transparent;transition:background .12s}
@ .bul.halo::before,@ .bul:hover::before{background:var(--halo)}
@ .bul::after{content:"";width:6px;height:6px;border-radius:50%;background:var(--bul);position:relative}
@ .bul.tagged::after{background:var(--tc);width:7px;height:7px}
@ .bul.para::after{width:5px;height:5px;background:var(--mu)}
@ .bul.ref::before{box-shadow:inset 0 0 0 1px var(--mu2);border-radius:50%}
@ .bul.ref.halo::before{box-shadow:none}
@ .bul.ico::after{display:none}
@ .bul.ico svg{position:relative;color:var(--tc,var(--mu))}
@ .bul.chk::after{display:none}
@ .bul.chk span{width:14px;height:14px;border-radius:4px;box-shadow:inset 0 0 0 1.5px var(--mu2);position:relative;display:grid;place-items:center;color:#fff}
@ .bul.chk.done span{background:var(--c-step);box-shadow:none}
@ .bul.new::after{background:transparent;box-shadow:inset 0 0 0 1.5px var(--c-question);width:8px;height:8px}
@ .nm{min-width:0;padding:1px 0;overflow-wrap:anywhere;outline:none}
@ .nm.q{font-weight:500}
@ .nm.dim{color:var(--mu)}
@ .nm.ed:empty::before{content:attr(data-ph);color:var(--mu2)}
@ .nm.done{color:var(--mu);text-decoration:line-through;text-decoration-color:var(--mu2)}
@ .nm code,@ .para code,@ .fv code,@ .pnl code,@ .crd code,@ .cmd code{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12.3px;background:var(--code);color:var(--codetx);padding:1px 4px;border-radius:4px}
@ .sub{display:block;font-size:12.5px;line-height:18px;color:var(--mu);margin-top:1px;font-weight:400}
@ .sub .dot{display:inline-block;width:3px;height:3px;border-radius:50%;background:var(--mu2);vertical-align:3px;margin:0 6px}
@ .tag{display:inline-flex;align-items:center;height:19px;padding:0 6px;border-radius:4px;font-size:12px;font-weight:500;color:var(--tc);background:color-mix(in srgb,var(--tc) 12%,transparent);margin-left:7px;vertical-align:1px;white-space:nowrap;cursor:pointer;line-height:19px;border:0;font-family:inherit;letter-spacing:0}
@ .tag:hover{background:color-mix(in srgb,var(--tc) 20%,transparent)}
@ .topic{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:10px;font-size:12px;color:var(--tx2);background:var(--side);border:1px solid var(--ln);margin:0 4px 2px 0;line-height:18px}
@ .st{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:500;color:var(--sc);margin-left:8px;white-space:nowrap;vertical-align:1px;line-height:18px}
@ .st::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--sc)}
@ .st.run::before{animation:tr2-pulse 1.3s ease-in-out infinite}
@ .unread{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--acc);margin-left:7px;vertical-align:1px}
@ .kids{margin-left:8px;padding-left:16px;border-left:1px solid var(--gd)}
@ .kids.top{margin-left:0;padding-left:0;border-left:0}
@ .rpill{display:inline-flex;align-items:center;gap:4px;max-width:300px;height:20px;padding:0 7px 0 5px;border-radius:5px;background:color-mix(in srgb,var(--tc,var(--c-thread)) 10%,transparent);color:var(--tc,var(--c-thread));font-size:12.5px;margin-left:6px;vertical-align:1px;cursor:pointer;line-height:20px;border:0;font-family:inherit}
@ .rpill span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@ .rpill:hover{background:color-mix(in srgb,var(--tc,var(--c-thread)) 18%,transparent)}
@ .acts{position:absolute;right:4px;top:2px;display:flex;gap:1px;opacity:0;pointer-events:none;background:var(--hv);padding-left:8px;box-shadow:-10px 0 10px -2px var(--hv);border-radius:6px}
@ .line:hover > .acts{opacity:1;pointer-events:auto}
@ .row.sel > .line > .acts{background:var(--sel);box-shadow:-10px 0 10px -2px var(--sel)}
@ .ab{height:22px;padding:0 7px;border-radius:5px;border:0;background:none;color:var(--mu);font-size:12px;display:inline-flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap}
@ .ab:hover{background:var(--side-h);color:var(--tx)}
@ .ab.pri{color:var(--acc)}

/* fields */
@ .flds{padding-left:24px;margin:0 0 3px}
@ .fld{display:grid;grid-template-columns:110px minmax(0,1fr);column-gap:10px;font-size:13px;line-height:21px;min-height:23px;padding:1px 0}
@ .fk{display:flex;align-items:center;gap:6px;color:var(--mu);height:21px;white-space:nowrap}
@ .fk .ic{color:var(--mu2)}
@ .fv{color:var(--tx2);min-width:0;overflow-wrap:anywhere}
@ .fv .muted{color:var(--mu)}
@ .fv > .st:first-child{margin-left:0;margin-right:6px}
@ .fv .err{color:var(--s-err);font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;line-height:18px;display:block;margin:1px 0 4px}
@ .fv .ask-agent{display:block;border-left:2px solid var(--s-att);padding:2px 0 2px 10px;margin:1px 0 6px;color:var(--tx);font-size:13.5px}
@ .fbtn{height:22px;padding:0 8px;border-radius:5px;border:1px solid var(--ln);background:var(--bg);color:var(--tx2);font-size:12px;display:inline-flex;align-items:center;gap:5px;cursor:pointer;vertical-align:middle;margin-left:6px}
@ .fbtn:hover{border-color:var(--mu2);color:var(--tx)}
@ .agent-dot{display:inline-block;width:7px;height:7px;border-radius:2px;background:var(--pc);margin-right:6px;vertical-align:0}
@ .src{display:inline-flex;align-items:center;gap:5px;max-width:250px;height:21px;padding:0 7px 0 5px;border-radius:5px;background:color-mix(in srgb,var(--c-source) 9%,transparent);color:var(--tx2);font-size:12.5px;margin:0 4px 2px 0;cursor:pointer;vertical-align:top;border:0}
@ .src .ic{color:var(--c-source)}
@ .src span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@ .src:hover{background:color-mix(in srgb,var(--c-source) 17%,transparent)}
@ .trtog{border:0;background:none;color:var(--tx2);font:inherit;font-size:13px;padding:0;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
@ .trtog .ic{color:var(--mu);transition:transform .12s}
@ .trtog.open .ic{transform:rotate(90deg)}
@ .steps{margin:2px 0 6px;border-left:1px solid var(--gd);padding-left:10px}
@ .step{display:grid;grid-template-columns:16px minmax(0,1fr) auto;gap:8px;font-size:12.5px;line-height:20px;color:var(--tx2)}
@ .step .ic{color:var(--mu);margin-top:2px}
@ .step .d{color:var(--mu)}
@ .step .ms{color:var(--mu);font-variant-numeric:tabular-nums;font-size:12px}
@ .step.running .ic{color:var(--s-run)}
@ .step.error .ic,@ .step.error{color:var(--s-err)}

/* answer paragraphs */
@ .para{color:var(--tx);line-height:23px;padding:1.5px 0}
@ .para a,@ .lnk{color:var(--c-thread);text-decoration:none;cursor:pointer}
@ mark.hl{color:inherit;border-radius:3px;padding:1px 1px}
@ mark.hl-amber{background:var(--hl-amber)}@ mark.hl-green{background:var(--hl-green)}@ mark.hl-blue{background:var(--hl-blue)}@ mark.hl-pink{background:var(--hl-pink)}
@ .anc{background:color-mix(in srgb,var(--c-thread) 9%,transparent);border-bottom:1.5px solid var(--c-thread);padding:0 1px}
@ .caret{display:inline-block;width:7px;height:14px;background:var(--acc);vertical-align:-2px;margin-left:3px;border-radius:1px;animation:tr2-blink 1s steps(2) infinite}
@ .bul.hln::after{background:var(--c-note);width:6px;height:6px;border-radius:2px}
@ .nm.hln{color:var(--tx2);font-style:italic}

/* answer block (variant c) */
@ .ablock{margin:4px 0 6px 24px;border:1px solid var(--ln);border-radius:10px;background:var(--bg);overflow:hidden}
@ .ablock-h{display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--side);border-bottom:1px solid var(--ln);font-size:12.5px;color:var(--mu);line-height:20px;flex-wrap:wrap}
@ .ablock-h b{color:var(--tx2);font-weight:500}
@ .ablock-h .sp{flex:1}
@ .ablock-b{padding:8px 14px 10px}
@ .ablock .ap{position:relative;padding:3px 0 3px 0;border-radius:5px}
@ .ablock .ap + .ap{margin-top:6px}
@ .ablock .ap:hover{background:var(--hv);box-shadow:-8px 0 0 var(--hv),8px 0 0 var(--hv)}
@ .ablock .ap .acts{top:0}
@ .ablock .bmark{position:absolute;left:-12px;top:7px;width:4px;height:14px;border-radius:2px;background:var(--c-thread)}
@ .ablock .ablock-tr{padding:6px 14px;border-top:1px solid var(--ln);background:var(--side)}
@ .ablock .ablock-tr .steps{border-left:0;padding-left:0;margin:0}
@ .anchor-line{font-size:12.5px;color:var(--mu);line-height:18px;padding:0 0 1px 24px;display:flex;gap:6px;align-items:baseline}
@ .anchor-line q{color:var(--tx2);font-style:normal;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:520px;display:inline-block;vertical-align:bottom}
@ .anchor-line .ic{color:var(--c-thread);align-self:center}

/* composer */
@ .row.comp > .line:hover{background:transparent}
@ .ask{border:1px solid var(--ln);border-radius:10px;background:var(--bg);padding:7px 8px 6px 11px;margin:1px 0 4px;transition:border-color .12s, box-shadow .12s}
@ .ask:focus-within{border-color:var(--selb);box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 13%,transparent)}
@ .ask textarea{width:100%;border:0;outline:0;resize:none;background:transparent;color:var(--tx);font:inherit;font-size:14px;line-height:22px;padding:0;margin:0;display:block;min-height:22px;overflow:hidden}
@ .ask textarea::placeholder{color:var(--mu)}
@ .ask-bar{display:flex;align-items:center;gap:6px;margin-top:5px}
@ .ask-bar .tag{margin-left:0}
@ .agent{display:inline-flex;align-items:center;height:24px;border-radius:6px;border:1px solid var(--ln);background:var(--bg);padding:0 7px 0 8px;font-size:12px;color:var(--tx2);cursor:pointer;gap:4px}
@ .agent:hover{border-color:var(--mu2);color:var(--tx)}
@ .agent .agent-dot{margin-right:2px}
@ .agent .ic{color:var(--mu)}
@ .ask-hint{font-size:11.5px;color:var(--mu);margin-left:auto;white-space:nowrap}
@ .ask-go{height:26px;padding:0 10px 0 8px;border-radius:7px;border:0;background:var(--acc);color:var(--acc-tx);font-size:12.5px;font-weight:600;display:inline-flex;gap:5px;align-items:center;cursor:pointer}
@ .ask-go:hover{filter:brightness(1.08)}
@ .ask-x{border:0;background:none;color:var(--mu);font-size:12px;cursor:pointer;padding:0 4px}
@ .comp-quote{font-size:12.5px;color:var(--mu);line-height:18px;margin:0 0 4px;border-left:2px solid var(--c-thread);padding-left:8px}
@ .addnode{display:flex;align-items:center;gap:6px;color:var(--mu2);font-size:13px;height:26px;cursor:text;padding-left:0}
@ .addnode .bul::after{background:var(--mu2)}
@ .addnode:hover{color:var(--mu)}

/* query bar for searches */
@ .qb{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:12.5px;color:var(--mu);background:var(--side);border:1px solid var(--ln);border-radius:9px;padding:6px 10px;margin:10px 0 2px;line-height:22px}
@ .qb .ic{color:var(--mu)}
@ .qb .kw{color:var(--mu)}
@ .qc{display:inline-flex;align-items:center;gap:4px;height:22px;border-radius:5px;background:var(--bg);border:1px solid var(--ln);padding:0 4px 0 7px;color:var(--tx2);font-size:12.5px}
@ .qc button{border:0;background:none;color:var(--mu);padding:0;width:16px;height:16px;display:grid;place-items:center;cursor:pointer;border-radius:3px}
@ .qc button:hover{background:var(--side-h);color:var(--tx)}
@ .qadd{border:1px dashed var(--mu2);background:none;color:var(--mu);height:22px;border-radius:5px;padding:0 7px;font-size:12px;cursor:pointer}
@ .qadd:hover{color:var(--tx);border-color:var(--mu)}
@ .res-meta{font-size:12px;color:var(--mu);margin:6px 0 4px}
@ .reason{font-size:11.5px;color:var(--mu);margin-left:8px;white-space:nowrap}
@ .row .search-sum{font-size:12px;color:var(--mu);margin-left:8px;font-weight:400}

/* table */
@ .tbl{border:1px solid var(--ln);border-radius:9px;overflow:hidden;font-size:13px}
@ .tr{display:grid;grid-template-columns:minmax(0,1fr) 176px 112px 116px 48px 76px;align-items:center;min-height:34px;border-top:1px solid var(--ln);cursor:pointer}
@ .tr:first-child{border-top:0}
@ .tr:hover{background:var(--hv)}
@ .tr.th{min-height:30px;background:var(--side);color:var(--mu);font-size:12px;font-weight:500;cursor:default}
@ .tr.th:hover{background:var(--side)}
@ .td{padding:5px 10px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-left:1px solid var(--ln);color:var(--tx2);line-height:20px}
@ .td:first-child{border-left:0;color:var(--tx);display:flex;align-items:center;gap:6px}
@ .td:first-child span{overflow:hidden;text-overflow:ellipsis}
@ .td .st{margin-left:0}
@ .td.num{text-align:right;font-variant-numeric:tabular-nums}
@ .td .tdot{width:7px;height:7px;border-radius:50%;background:var(--c-question);flex:none}
@ .td .ind{display:inline-block;width:12px;flex:none;color:var(--mu2);font-size:11px}
@ .tgroup{padding:7px 10px 5px;font-size:12px;font-weight:600;color:var(--tx2);border-top:1px solid var(--ln);background:var(--bg);display:flex;align-items:center;gap:6px;cursor:pointer}
@ .tgroup:first-child{border-top:0}
@ .tgroup .tag{margin-left:2px}

/* cards */
@ .crds{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
@ .crd{border:1px solid var(--ln);border-radius:10px;padding:12px 14px 10px;cursor:pointer;background:var(--bg);display:flex;flex-direction:column;gap:6px;min-height:150px}
@ .crd:hover{border-color:var(--mu2);box-shadow:0 2px 8px rgba(0,0,0,.05)}
@ .crd h3{margin:0;font-size:14px;line-height:20px;font-weight:600;color:var(--tx)}
@ .crd p{margin:0;font-size:13px;line-height:19px;color:var(--tx2);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
@ .crd .cf{margin-top:auto;font-size:12px;color:var(--mu);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
@ .crd .ct{display:flex;align-items:center;gap:0;flex-wrap:wrap}
@ .crd .ct .tag{margin-left:0;margin-right:6px}
@ .crd .ct .st{margin-left:0}

/* referenced by */
@ .refby{margin-top:34px;border-top:1px solid var(--ln);padding-top:12px}
@ .refby h4{margin:0 0 6px;font-size:12px;font-weight:600;color:var(--mu);letter-spacing:.02em;display:flex;gap:8px}
@ .refby h4 span{font-weight:400}
@ .refby .grp{font-size:12.5px;color:var(--mu);margin:8px 0 1px;display:flex;align-items:center;gap:6px}
@ .refby .grp .tag{margin-left:0}
@ .refby .none{font-size:13px;color:var(--mu);line-height:20px}

/* side panel */
@ .pnl{border-left:1px solid var(--ln);background:var(--bg);display:flex;flex-direction:column;min-height:0;min-width:0}
@ .pnl-h{height:40px;display:flex;align-items:center;gap:6px;padding:0 8px 0 14px;border-bottom:1px solid var(--ln);font-size:12.5px;color:var(--mu);flex:none}
@ .pnl-h b{color:var(--tx2);font-weight:500}
@ .pnl-b{flex:1;overflow:auto;padding:14px 16px 40px;min-height:0}
@ .pnl-t{font-size:15px;line-height:22px;font-weight:600;margin:6px 0 2px;color:var(--tx);overflow-wrap:anywhere}
@ .pnl-t.para{font-weight:400;font-size:13.5px;line-height:21px}
@ .pnl-s{font-size:11.5px;font-weight:600;color:var(--mu);margin:18px 0 6px;letter-spacing:.03em;text-transform:uppercase;display:flex;justify-content:space-between}
@ .pnl .fld{grid-template-columns:84px minmax(0,1fr)}
@ .pnl .tag{margin-left:0}
@ .pnl .steps{border-left:0;padding-left:0}
@ .pnl .plist{display:flex;flex-direction:column;gap:2px}
@ .pnl .pi{font-size:13px;line-height:19px;color:var(--tx2);padding:5px 8px;border-radius:6px;cursor:pointer;display:flex;gap:8px;align-items:flex-start}
@ .pnl .pi:hover{background:var(--hv)}
@ .pnl .pi .ic{color:var(--mu);margin-top:2px}
@ .pnl .pi small{display:block;color:var(--mu);font-size:12px}
@ .pnl .hint{font-size:13px;color:var(--mu);line-height:20px}
@ .pnl .hq{border-left:3px solid var(--hlc);padding:1px 0 1px 9px;font-size:13px;line-height:19px;color:var(--tx2);margin:4px 0}
@ .pnl .hq small{display:block;color:var(--mu);font-style:italic}

/* menus, command line, toast */
@ .menu{position:absolute;z-index:30;min-width:220px;max-width:320px;background:var(--pop);border-radius:9px;box-shadow:var(--shadow);padding:5px;font-size:13px}
@ .mi{display:flex;align-items:center;gap:8px;height:28px;padding:0 8px;border-radius:5px;cursor:pointer;color:var(--tx);white-space:nowrap;border:0;background:none;width:100%;text-align:left;font-size:13px}
@ .mi:hover{background:var(--sel)}
@ .mi .ic{color:var(--mu)}
@ .mi .mh{margin-left:auto;color:var(--mu);font-size:12px;padding-left:12px}
@ .mi.chk::after{content:"";margin-left:auto;width:6px;height:6px;border-radius:50%;background:var(--acc)}
@ .mhd{font-size:11.5px;color:var(--mu);font-weight:600;padding:6px 8px 2px}
@ .msep{height:1px;background:var(--ln);margin:4px 2px}
@ .cmd-wrap{position:absolute;inset:0;z-index:40;background:rgba(10,10,20,.18);display:flex;justify-content:center;align-items:flex-start;padding-top:84px}
@[data-theme="dark"] .cmd-wrap{background:rgba(0,0,0,.4)}
@ .cmd{width:620px;background:var(--pop);border-radius:12px;box-shadow:var(--shadow);overflow:hidden}
@ .cmd-in{display:flex;align-items:center;gap:10px;padding:0 14px;height:48px;border-bottom:1px solid var(--ln)}
@ .cmd-in .ic{color:var(--mu)}
@ .cmd-in input{flex:1;border:0;outline:0;background:transparent;color:var(--tx);font:inherit;font-size:15px}
@ .cmd-in input::placeholder{color:var(--mu)}
@ .cmd-list{max-height:430px;overflow:auto;padding:6px}
@ .cmd-sec{font-size:11.5px;color:var(--mu);font-weight:600;padding:8px 10px 3px}
@ .ci{display:flex;align-items:flex-start;gap:10px;padding:6px 10px;border-radius:7px;cursor:pointer;font-size:13.5px;line-height:20px;color:var(--tx)}
@ .ci.on{background:var(--sel)}
@ .ci .ic{color:var(--mu);margin-top:2px}
@ .ci .cbody{flex:1;min-width:0}
@ .ci .cbody > span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@ .ci small{display:block;font-size:12px;color:var(--mu);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@ .ci .tag{margin-left:0;flex:none;margin-top:1px}
@ .ci b{font-weight:600;background:color-mix(in srgb,var(--acc) 16%,transparent);border-radius:2px}
@ .ci .mh{color:var(--mu);font-size:12px}
@ .cmd-foot{display:flex;gap:14px;padding:7px 14px;border-top:1px solid var(--ln);font-size:11.5px;color:var(--mu)}
@ .cmd-foot kbd{margin-left:0;margin-right:4px}
@ .toast{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);z-index:50;background:var(--tx);color:var(--bg);font-size:13px;padding:7px 14px;border-radius:8px;box-shadow:var(--shadow);white-space:nowrap}

/* welcome */
@ .lead{font-size:14.5px;line-height:23px;color:var(--tx2);margin:6px 0 16px;max-width:640px}
@ .agrow{display:grid;grid-template-columns:110px 120px minmax(0,1fr);column-gap:10px;font-size:13px;line-height:21px;min-height:26px;align-items:center}
@ .agrow .muted{color:var(--mu)}
@ .agrow code{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;background:var(--code);padding:1px 5px;border-radius:4px;color:var(--codetx)}
@ .sugg{display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 6px}
@ .sugg button{border:1px solid var(--ln);background:var(--bg);color:var(--tx2);border-radius:14px;height:26px;padding:0 10px;font-size:12.5px;cursor:pointer}
@ .sugg button:hover{border-color:var(--mu2);color:var(--tx)}
@ .wfoot{margin-top:26px;display:flex;gap:10px;align-items:center;font-size:13px;color:var(--mu)}
@ .btn{height:30px;padding:0 12px;border-radius:7px;border:1px solid var(--ln);background:var(--bg);color:var(--tx);font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
@ .btn:hover{border-color:var(--mu2)}
@ .empty{border:1px dashed var(--ln);border-radius:10px;padding:16px 18px;color:var(--mu);font-size:13px;line-height:20px;margin-top:8px}
/* r2 additions */
@ .ph-t{gap:2px 10px;align-items:center}
@ .ph-chips{display:inline-flex;align-items:center}
@ .ph-chips > :first-child{margin-left:0}
@ .anc code{box-shadow:0 1.5px 0 var(--c-thread)}
@ .rel{font-size:12px;color:var(--mu);margin-left:8px;white-space:nowrap;font-weight:400}
@ .rel.br{color:var(--c-thread)}
@ .fstrip-wrap{padding-left:24px;margin:0 0 4px}
@ .fstrip{display:flex;flex-wrap:wrap;align-items:center;gap:2px 14px;font-size:12.5px;line-height:20px;color:var(--tx2);min-height:22px}
@ .fs{display:inline-flex;align-items:center;gap:5px;border:0;background:none;padding:0;font:inherit;color:inherit;white-space:nowrap}
@ .fs.btn{cursor:pointer;border-radius:4px}
@ .fs.btn:hover{color:var(--tx)}
@ .fsk{color:var(--mu);font-size:11.5px}
@ .fs .st{margin-left:0}
@ .fs .agent-dot{margin-right:0}
@ .fs .car{color:var(--mu);transition:transform .12s;display:inline-flex}
@ .fs.open .car{transform:rotate(90deg)}
@ .fs .work{color:var(--s-run);max-width:230px;overflow:hidden;text-overflow:ellipsis}
@ .fstrip .fbtn{margin-left:0;height:20px}
@ .fbtn.stop{color:var(--s-err)}
@ .fstrip-wrap .steps{margin:4px 0 4px 2px}
@ .srcs{margin:4px 0 2px}
@ .fnote{font-size:12.5px;color:var(--mu);line-height:19px;margin:2px 0}
@ .fnote b{color:var(--tx2);font-weight:500}
@ .sub.det{color:var(--tx2);font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11.5px}
@ .pref{border-left:2px solid var(--c-question);padding-left:10px;color:var(--tx2)}
@ .pref .clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
@ .selbar{position:absolute;z-index:35;display:flex;gap:1px;padding:3px;background:var(--pop);border-radius:8px;box-shadow:var(--shadow)}
@ .selbar .ab{color:var(--tx2);height:26px}
@ .tip{display:flex;align-items:center;gap:12px;border:1px solid var(--ln);background:var(--side);border-radius:10px;padding:10px 10px 10px 14px;font-size:13px;line-height:19px;color:var(--tx2);margin:2px 0 14px}
@ .tip b{color:var(--tx);font-weight:600}
@ .tip-i{color:var(--acc)}
@ .tip .btn{flex:none;height:28px}
@ .graph{border:1px solid var(--ln);border-radius:10px;background:var(--side);overflow:hidden}
@ .graph svg{display:block}
@ .graph .ge{stroke:var(--mu2);stroke-width:1.3}
@ .graph .ge.ref{stroke-dasharray:4 3}
@ .graph .gn{cursor:pointer}
@ .graph .gn text{font-size:12px;fill:var(--tx2);font-family:Inter,ui-sans-serif,system-ui,sans-serif}
@ .graph .gn text.gws{font-size:10.5px;fill:var(--mu)}
@ .graph .gn.ext{opacity:.6}
@ .graph .gcl{font-size:10.5px;font-weight:600;letter-spacing:.06em;fill:var(--mu);font-family:Inter,ui-sans-serif,system-ui,sans-serif}
@ .graph .gring{fill:none;stroke-width:2}
@ .graph .gn:hover text{fill:var(--tx)}
@ .graph.focus .gn,@ .graph.focus .ge{opacity:.25;transition:opacity .12s}
@ .graph.focus .gn.on,@ .graph.focus .ge.on{opacity:1}
@ .graph.focus .ge.on{stroke:var(--acc);stroke-width:2}
@ .glegend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:12px;color:var(--mu);margin-top:10px}
@ .glegend span{display:inline-flex;align-items:center;gap:6px}
@ .glegend i{display:inline-block;width:10px;height:10px;border-radius:50%}
@ .glegend .lg-t{background:var(--c-thread)}@ .glegend .lg-n{background:var(--c-note);border-radius:3px}
@ .glegend .lg-l{width:18px;height:0;border-top:1.5px solid var(--mu2);border-radius:0}
@ .glegend .lg-r{width:18px;height:0;border-top:1.5px dashed var(--mu2);border-radius:0}
@ .glegend .lg-s{box-shadow:inset 0 0 0 2px var(--s-run)}
@keyframes tr2-pulse{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes tr2-blink{0%{opacity:1}100%{opacity:0}}
@keyframes tr2-flash{0%{background:color-mix(in srgb,var(--acc) 22%,transparent)}100%{background:transparent}}
`;

/* -- helpers */
/* h("div.cls names", attrs, ...children) */
function h(tag, a) {
  var dot = tag.indexOf(".");
  var e = document.createElement(dot < 0 ? tag : tag.slice(0, dot));
  if (dot >= 0) e.className = tag.slice(dot + 1);
  var start = 2;
  if (a != null && (typeof a !== "object" || a.nodeType || Array.isArray(a))) { start = 1; a = null; }
  if (a) for (var k in a) {
    var v = a[k];
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k === "text") e.textContent = v;
    else if (k === "style") e.style.cssText = v;
    else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (var i = start; i < arguments.length; i++) app_(e, arguments[i]);
  return e;
}
function app_(e, c) {
  if (c == null || c === false) return;
  if (Array.isArray(c)) { c.forEach((x) => { app_(e, x); }); return; }
  e.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function md(s) {
  return String(s || "").split(/(`[^`]+`)/).map((p) => {
    if (/^`[^`]+`$/.test(p)) return "<code>" + esc(p.slice(1, -1)) + "</code>";
    return esc(p).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="lnk">$1</a>');
  }).join("");
}
function plain(s) { return String(s || "").replace(/`/g, "").replace(/\*\*/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); }
function clip(s, n) { s = plain(s); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s; }

var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var MONL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
var DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/* -- mount */
function mount(root, ctx) {
  var D = ctx.data;
  var V = ctx.variant || "a";
  var CFG = {
    a: { home: "day", fields: "inline", answers: "nodes", panel: false },
    b: { home: "t:t1", fields: "panel", answers: "nodes", panel: true, sel: "q:t1q1" },
    c: { home: "t:t3", fields: "inline", answers: "block", panel: false },
    f: { home: "graph", fields: "inline", answers: "nodes", panel: false, graphScope: "all" },
    e: { home: "welcome", fields: "inline", answers: "nodes", panel: false, firstRun: true },
  }[V] || { home: "day", fields: "inline", answers: "nodes" };

  var NOW = Date.parse(D.now);
  var TODAY = D.now.slice(0, 10);
  var timers = [];
  var gone = false;
  function later(fn, ms) { var t = setTimeout(() => { if (!gone) fn(); }, ms); timers.push(t); return t; }

  var STAT = Object.assign({}, D.statuses, { stopped: { label: "Stopped", tone: "plain" } });
  var INBOX = {};
  D.inbox.forEach((i) => { INBOX[i.turnId] = i; });
  var PROV = {};
  D.providers.forEach((p) => { PROV[p.id] = p; });

  /* -- node graph */
  var N = {};
  var seq = 0;
  function uid(p) { return p + ":" + (++seq); }
  function add(n) { n.children = n.children || []; N[n.id] = n; return n; }
  function push(pid, id) { N[pid].children.push(id); N[id].parent = pid; }

  add({ id: "root", kind: "root", name: "Session" });
  add({ id: "journal", kind: "journal", name: "Journal", parent: "root" });
  add({ id: "tag:question", kind: "search", name: "All #question", parent: "root", q: { tag: "question", status: [] }, view: "table" });
  add({ id: "tag:source", kind: "search", name: "All #source", parent: "root", q: { tag: "source" } });
  add({ id: "tag:note", kind: "search", name: "All #note", parent: "root", q: { tag: "note" } });
  add({ id: "tag:highlight", kind: "search", name: "All #highlight", parent: "root", q: { tag: "highlight" } });
  add({ id: "sq:needs", kind: "search", name: "Needs you", parent: "root", q: { tag: "question", status: ["failed", "needs-review"], unread: true } });
  add({ id: "sq:running", kind: "search", name: "Running and queued", parent: "root", q: { tag: "question", status: ["running", "queued"] } });
  add({ id: "graph", kind: "graph", name: "Graph", parent: "root" });
  add({ id: "welcome", kind: "tutorial", name: "Welcome to Session", parent: "root", tag: "guide" });

  function addWorkspace(w) {
    add({ id: "ws:" + w.id, kind: "workspace", name: w.name, dir: w.dir, ws: w.id, tag: "workspace", parent: "root" });
    add({ id: "drafts:" + w.id, kind: "system", sys: "drafts", name: "Drafts", ws: w.id, parent: "ws:" + w.id });
    add({ id: "archive:" + w.id, kind: "system", sys: "archive", name: "Archive", ws: w.id, parent: "ws:" + w.id });
  }
  D.workspaces.forEach(addWorkspace);
  D.folders.forEach((f) => {
    add({ id: "f:" + f.id, kind: "folder", name: f.name, ws: f.workspaceId, tag: "folder", own: true });
    push("ws:" + f.workspaceId, "f:" + f.id);
  });

  var srcByUrl = {};
  D.sources.forEach((s, i) => {
    var id = "s:" + i;
    srcByUrl[s.url] = id;
    add({ id: id, kind: "source", tag: "source", name: s.title, url: s.url, domain: s.domain, parent: "tag:source", refs: s.refs });
  });

  var unreadTurns = {};
  D.inbox.forEach((i) => { if (i.kind === "unread") unreadTurns[i.turnId] = true; });

  function addPara(u, i, qid, ws) {
    var pid = "p:" + u.id + ":" + i;
    add({ id: pid, kind: "para", text: u.answer[i], turn: u, idx: i, ws: ws });
    push(qid, pid);
    (u.highlights || []).forEach((hl) => {
      if (hl.paragraph === i && hl.note) {
        add({ id: "hn:" + hl.id, kind: "hlnote", name: hl.note, hl: hl, own: true, ws: ws });
        push(pid, "hn:" + hl.id);
      }
    });
    return pid;
  }
  function addTurn(t, u, tn) {
    var qid = "q:" + u.id;
    add({ id: qid, kind: "question", tag: "question", turn: u, thread: t, ws: t.workspaceId, unread: !!unreadTurns[u.id] });
    u.answer.forEach((_, i) => { addPara(u, i, qid, t.workspaceId); });
    var cont;
    if (u.relation === "root" || !u.parentId) cont = tn;
    else if (u.relation === "followup") cont = N["q:" + u.parentId].parent;
    else {
      var a = u.anchor;
      var pid = "p:" + ((a && a.turnId) || u.parentId) + ":" + (a ? a.paragraph : 0);
      cont = N[pid] ? pid : "q:" + u.parentId;
    }
    push(cont, qid);
    return qid;
  }
  D.threads.forEach((t) => {
    var parent = t.archivedAt ? "archive:" + t.workspaceId : t.folderId ? "f:" + t.folderId : "ws:" + t.workspaceId;
    var tid = "t:" + t.id;
    add({ id: tid, kind: "thread", tag: "thread", name: t.title, thread: t, ws: t.workspaceId, pinned: t.bookmarked, notify: t.followed });
    push(parent, tid);
    t.turns.slice().sort((a, b) => { return Date.parse(a.createdAt) - Date.parse(b.createdAt); }).forEach((u) => { addTurn(t, u, tid); });
  });
  D.highlights.forEach((hl) => {
    add({ id: "h:" + hl.id, kind: "highlight", tag: "highlight", hl: hl, para: "p:" + hl.turnId + ":" + hl.paragraph, ws: hl.workspaceId, parent: "tag:highlight" });
  });
  function buildItems(list, pid, ws) {
    (list || []).forEach((o) => {
      var id = uid("i");
      add({ id: id, kind: "item", name: o.text, own: true, ws: ws, ref: o.ref ? (o.ref.turnId ? "q:" + o.ref.turnId : "t:" + o.ref.threadId) : null });
      push(pid, id);
      buildItems(o.children, id, ws);
    });
  }
  D.notes.forEach((n) => {
    var id = "n:" + n.id;
    add({ id: id, kind: "note", tag: "note", name: n.title, ws: n.workspaceId, own: true, note: n, pinned: n.id === "n1", updatedAt: n.updatedAt });
    push("ws:" + n.workspaceId, id);
    buildItems(n.outline, id, n.workspaceId);
  });
  D.drafts.forEach((d) => {
    var id = "d:" + d.id;
    add({ id: id, kind: "draft", tag: "question", name: d.prompt, draft: d, ws: d.workspaceId });
    push("drafts:" + d.workspaceId, id);
  });
  function sortWs(wsid) {
    var w = N["ws:" + wsid];
    var order = { folder: 0, thread: 1, note: 2, ref: 1, system: 3 };
    w.children.sort((a, b) => {
      var oa = order[N[a].kind], ob = order[N[b].kind];
      if (oa !== ob) return oa - ob;
      if (N[a].kind === "system") return N[a].sys === "drafts" ? -1 : 1;
      return 0;
    });
  }
  D.workspaces.forEach((w) => {
    push("ws:" + w.id, "drafts:" + w.id);
    push("ws:" + w.id, "archive:" + w.id);
    sortWs(w.id);
  });

  /* journal */
  var days = {};
  Object.keys(N).forEach((k) => { var n = N[k]; if (n.kind === "question") days[n.turn.createdAt.slice(0, 10)] = 1; });
  days[TODAY] = 1;
  Object.keys(days).sort().reverse().slice(0, 5).forEach((dk) => {
    var id = "day:" + dk;
    add({ id: id, kind: "day", tag: "day", name: dayName(dk, true), date: dk, own: true });
    push("journal", id);
    add({ id: "sq:" + dk, kind: "search", name: dk === TODAY ? "Asked today" : "Asked on this day", q: { tag: "question", day: dk } });
  });
  var DAY = "day:" + TODAY;
  function ref(pid, target, opts) {
    var id = uid("r");
    add({ id: id, kind: "ref", target: target, own: true });
    push(pid, id);
    if (opts && opts.open) st0.collapsed[id] = false;
    return id;
  }
  function item(pid, text, r) {
    var id = uid("i");
    add({ id: id, kind: "item", name: text, own: true, ref: r || null });
    push(pid, id);
    return id;
  }
  var st0 = { collapsed: {} };
  if (!CFG.firstRun) {
    ref(DAY, "sq:needs", { open: true });
    var k1 = item(DAY, "Kestrel: land the hypot fix once the Math sweep finishes");
    ref(k1, "q:t2q3");
    item(k1, "Then re-run built-ins/Math on the ARM64 runner");
    var k2 = item(DAY, "Serving capacity plan for Q4", "n:n2");
    ref(k2, "q:t3q3");
    ref(k2, "q:t7q1");
    item(k2, "Draft the FP8 vs fp16 accuracy question", "d:d2");
    item(DAY, "Raft: we only ever replace one voter at a time; answer the clarification", "q:t5q1");
  }
  Object.keys(days).forEach((dk) => { if (N["day:" + dk]) push("day:" + dk, "sq:" + dk); });
  st0.collapsed["sq:" + TODAY] = false;

  /* first-run workspace */
  var SAMPLE_WS = D.workspaces.map((w) => { return w.id; });
  function newWorkspace(name) {
    var w = { id: "ws-new" + (++seq), name: name, dir: "~/Session/" + name.toLowerCase().replace(/\s+/g, "-") };
    addWorkspace(w);
    push("ws:" + w.id, "drafts:" + w.id);
    push("ws:" + w.id, "archive:" + w.id);
    return w.id;
  }

  /* -- state */
  var st = {
    ws: "ws-compilers",
    firstRun: !!CFG.firstRun,
    page: CFG.home === "day" ? DAY : CFG.home,
    back: [], fwd: [],
    sel: CFG.sel || null,
    collapsed: st0.collapsed,
    views: {},
    traceOpen: {},
    sideOpen: {},
    panel: !!CFG.panel,
    cmd: null, menu: null, toast: null,
    composers: {},
    bquote: {},
    srcOpen: {},
    codex: "signed-out",
    tip: true,
    graphScope: CFG.graphScope || "ws",
    text: {},
    agent: { provider: "claude", model: "opus", effort: "high" },
    tasks: { ask: false, branch: false, ref: false },
    drag: null,
    focusKey: null,
    scrollTo: null,
    flash: null,
  };
  if (CFG.wsView) st.views["ws:ws-compilers"] = CFG.wsView;
  if (st.firstRun) { st.ws = newWorkspace("Research"); }
  else if (N[st.page] && N[st.page].ws && N["ws:" + N[st.page].ws]) st.ws = N[st.page].ws;

  /* -- derived */
  function visibleWs(ws) { return !st.firstRun || SAMPLE_WS.indexOf(ws) < 0; }
  function threadStatus(tn) {
    var qs = descendants(tn.id).filter((id) => { return N[id].kind === "question"; }).map((id) => { return N[id].turn.status; });
    var order = ["running", "needs-review", "failed", "queued", "done"];
    for (var i = 0; i < order.length; i++) if (qs.indexOf(order[i]) >= 0) return order[i];
    return "done";
  }
  function descendants(id) {
    var out = [];
    (function walk(x) { N[x].children.forEach((c) => { out.push(c); walk(c); }); })(id);
    return out;
  }
  function threadOf(id) { var n = N[id]; while (n && n.kind !== "thread") n = N[n.parent]; return n || null; }
  function ancestors(id) { var out = []; var n = N[id]; while (n && n.parent && n.parent !== "root") { out.unshift(n.parent); n = N[n.parent]; } return out; }
  function allQuestions() {
    return Object.keys(N).map((k) => { return N[k]; }).filter((n) => {
      if (n.kind !== "question" || !visibleWs(n.ws)) return false;
      var t = threadOf(n.id);
      return !(t && t.thread && t.thread.archivedAt);
    }).sort((a, b) => { return Date.parse(b.turn.createdAt) - Date.parse(a.turn.createdAt); });
  }
  function results(n) {
    var q = n.q;
    if (q.tag === "question") {
      return allQuestions().filter((x) => {
        if (q.day) return x.turn.createdAt.slice(0, 10) === q.day;
        if (q.ws && x.ws !== q.ws) return false;
        var hasS = q.status && q.status.length;
        if (!hasS && !q.unread) return true;
        return (hasS && q.status.indexOf(x.turn.status) >= 0) || (q.unread && x.unread);
      }).map((x) => { return x.id; });
    }
    var kind = q.tag;
    return Object.keys(N).filter((k) => {
      var x = N[k];
      if (x.kind !== kind) return false;
      if (kind === "source") return (x.refs || []).some((r) => { var t = D.byId.threads[r.threadId]; return t && visibleWs(t.workspaceId); });
      return visibleWs(x.ws);
    });
  }
  function reasonFor(qn) {
    var s = qn.turn.status;
    if (s === "failed") return "Run failed";
    if (s === "needs-review") return "Agent asks a question";
    if (qn.unread) return "New answer";
    return "";
  }
  function questionsIn(id) {
    return descendants(id).filter((k) => { return N[k].kind === "question"; });
  }
  function threadsIn(id) {
    return descendants(id).filter((k) => { return N[k].kind === "thread"; });
  }
  function countKind(id, kind) { return descendants(id).filter((k) => { return N[k].kind === kind; }).length; }

  function dayName(dk, long) {
    var d = new Date(dk + "T12:00:00Z");
    return long ? DOW[d.getUTCDay()] + ", " + MONL[d.getUTCMonth()] + " " + d.getUTCDate() : DOW[d.getUTCDay()].slice(0, 3) + ", " + MON[d.getUTCMonth()] + " " + d.getUTCDate();
  }
  function rel(iso) {
    if (!iso) return "";
    var m = Math.round((NOW - Date.parse(iso)) / 60000);
    if (m < 1) return "now";
    if (m < 60) return m + "m ago";
    if (m < 60 * 24) return Math.round(m / 60) + "h ago";
    var d = new Date(iso);
    return MON[d.getUTCMonth()] + " " + d.getUTCDate();
  }
  function dur(sec) {
    if (sec == null) return "";
    if (sec < 60) return sec + "s";
    var m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + "m " + (s ? s + "s" : "");
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }
  function elapsed(u) {
    if (u._t0) return dur(Math.max(1, Math.round((Date.now() - u._t0) / 1000)));
    return dur(Math.round((NOW - Date.parse(u.createdAt)) / 1000));
  }
  function agentLabel(u) {
    var p = PROV[u.provider];
    return (p ? p.label : u.provider) + " · " + u.model + (u.effort ? " · " + u.effort : "");
  }

  function shortName(id) {
    var n = N[id];
    if (!n) return "";
    switch (n.kind) {
      case "question": return n.turn.title;
      case "para": return "¶" + (n.idx + 1);
      case "day": return dayName(n.date, false);
      case "ref": return shortName(n.target);
      case "highlight": return clip(n.hl.quote, 40);
      case "draft": return clip(n.name, 40);
      case "item": case "hlnote": return clip(n.name, 40);
      default: return n.name;
    }
  }
  function displayName(id) {
    var n = N[id];
    if (n.kind === "para") return plain(n.text);
    if (n.kind === "question") return plain(n.turn.question);
    return plain(n.name || shortName(id));
  }

  function tagChip(tag, onclick) {
    var map = { question: "tag:question", source: "tag:source", note: "tag:note", highlight: "tag:highlight" };
    return h("button", {
      class: "tag", style: "--tc:var(--c-" + tag + ")", title: map[tag] ? "Open All #" + tag : null,
      onclick: (e) => { e.stopPropagation(); if (onclick) onclick(); else if (map[tag]) go(map[tag]); },
    }, "#" + tag);
  }
  function statusChip(s, extra) {
    var meta = STAT[s] || { label: s === "draft" ? "Draft" : s, tone: "plain" };
    var tone = { run: "s-run", ok: "s-ok", error: "s-err", attention: "s-att", plain: "s-plain" }[meta.tone];
    return h("span", { class: "st" + (meta.tone === "run" ? " run" : ""), style: "--sc:var(--" + tone + ")" }, meta.label + (extra ? " · " + extra : ""));
  }

  /* -- navigation */
  function go(id, opts) {
    if (!N[id]) return;
    if (id !== st.page) { st.back.push(st.page); st.fwd = []; }
    st.page = id;
    if (N[id].ws && visibleWs(N[id].ws) && N["ws:" + N[id].ws]) st.ws = N[id].ws;
    st.sel = (opts && opts.sel) || null;
    st.menu = null; st.cmd = null;
    markRead(id);
    if (!(opts && opts.keepScroll)) st._resetScroll = true;
    render();
  }
  function back() { if (!st.back.length) return; st.fwd.push(st.page); st.page = st.back.pop(); st._resetScroll = true; render(); }
  function fwd() { if (!st.fwd.length) return; st.back.push(st.page); st.page = st.fwd.pop(); st._resetScroll = true; render(); }
  function markRead(id) {
    var n = N[id];
    if (!n) return;
    var ids = n.kind === "thread" ? questionsIn(id) : [id];
    ids.forEach((q) => { if (N[q] && N[q].unread) N[q].unread = false; });
  }
  function pageFor(id) {
    var n = N[id];
    var chain = ancestors(id).concat([id]);
    for (var i = 0; i < chain.length; i++) {
      var k = N[chain[i]].kind;
      if (k === "thread" || k === "note" || k === "day" || k === "tutorial") return chain[i];
    }
    return n.parent && n.parent !== "root" ? n.parent : id;
  }
  function reveal(id) {
    var n = N[id];
    if (!n) return;
    if (n.kind === "ref") id = n.target;
    if (N[id].kind === "highlight") id = N[id].para;
    if (["thread", "note", "day", "workspace", "folder", "search", "source", "system", "tutorial", "journal"].indexOf(N[id].kind) >= 0) { go(id); return; }
    var pg = pageFor(id);
    ancestors(id).forEach((a) => { st.collapsed[a] = false; });
    markRead(id);
    st.scrollTo = id; st.flash = id;
    go(pg, { sel: id });
  }

  /* -- runs */
  function canned(q) {
    var m = q.match(/`([^`]+)`/);
    var subj = m ? "`" + m[1] + "`" : "the code path named in the question";
    return [
      "Short answer: the behaviour comes from " + subj + " and the order in which its inputs are checked. Both call sites listed in the trace reach the same helper, so one change covers them.",
      "Evidence: the existing tests cover the common case but not the boundary values. Running the focused test target reproduces the difference on the first boundary input and nowhere else.",
      "Next step: add a test that pins the expected output at each boundary, then apply the smallest change that makes it pass. Branch from this paragraph to draft that test.",
    ];
  }
  function newTurn(text, rel_, parentTurn, anchor) {
    var a = parentTurn ? { provider: parentTurn.provider, model: parentTurn.model, effort: parentTurn.effort } : st.agent;
    return {
      id: "u" + (++seq), parentId: parentTurn ? parentTurn.id : null, relation: rel_, anchor: anchor || null,
      question: text, title: clip(text, 46), provider: a.provider, model: a.model, effort: a.effort,
      status: "running", createdAt: D.now, completedAt: null, durationSec: null, starred: false, recap: null,
      answer: [], error: null, sources: [], activity: [], highlights: [], _t0: Date.now(),
    };
  }
  function startRun(qid) {
    var q = N[qid], u = q.turn;
    u.status = "running"; u._t0 = Date.now(); u.activity = []; u.answer = []; u.error = null;
    var tok = u._run = (u._run || 0) + 1;
    function live() { return u._run === tok && u.status === "running"; }
    q.children = q.children.filter((c) => { return N[c].kind !== "para"; });
    var m = u.question.match(/`([^`]+)`/);
    var word = m ? m[1].split(/[\s(.]/)[0] : (u.question.split(/\s+/).filter((w) => { return w.length > 5; })[0] || "handler").replace(/[^\w-]/g, "");
    var steps = [
      { kind: "think", label: "Planned: locate where " + word + " is handled", ms: 900 },
      { kind: "grep", label: "Searched code: " + word, detail: "src/**  (3 matches)", ms: 310 },
      { kind: "read", label: "Read src/" + word.toLowerCase().slice(0, 14) + ".rs", ms: 140 },
      { kind: "run", label: "Ran the focused test target", detail: "41 passed; 1 failed", ms: 6400 },
    ];
    var paras = canned(u.question);
    var i = 0;
    function step() {
      if (!live()) return;
      if (i < steps.length) {
        if (u.activity.length) u.activity[u.activity.length - 1].status = "ok";
        u.activity.push(Object.assign({ status: "running" }, steps[i++]));
        render();
        later(step, 420);
      } else {
        u.activity[u.activity.length - 1].status = "ok";
        streamPara(0);
      }
    }
    function streamPara(pi) {
      if (!live()) return;
      if (pi >= paras.length) {
        u.status = "done"; u.completedAt = D.now; u.durationSec = Math.max(3, Math.round((Date.now() - u._t0) / 1000));
        u._t0 = null;
        render();
        releaseQueue(qid);
        return;
      }
      var words = paras[pi].split(" ");
      u.answer.push("");
      var pid = addPara(u, pi, qid, q.ws);
      var w = 0;
      render();
      (function tick() {
        if (!live()) return;
        w = Math.min(words.length, w + 3);
        var txt = words.slice(0, w).join(" ");
        N[pid].text = txt; u.answer[pi] = txt;
        var el = app.querySelector('[data-para="' + pid + '"]');
        if (el) el.innerHTML = paraHtml(N[pid]);
        if (w < words.length) later(tick, 40);
        else later(() => { streamPara(pi + 1); }, 140);
      })();
    }
    later(step, 250);
  }
  function releaseQueue(qid) {
    Object.keys(N).forEach((k) => { var x = N[k]; if (x.kind === "question" && x.turn.status === "queued" && x.waitFor === qid) later(() => { startRun(k); }, 400); });
  }
  function stopRun(qid) {
    var u = N[qid].turn;
    u._run = (u._run || 0) + 1;
    u.status = "stopped";
    u.durationSec = u._t0 ? Math.max(1, Math.round((Date.now() - u._t0) / 1000)) : Math.round((NOW - Date.parse(u.createdAt)) / 1000);
    u._t0 = null;
    var last = u.activity[u.activity.length - 1];
    if (last && last.status === "running") last.status = "ok";
    u.activity.push({ kind: "think", label: "Stopped by you; the partial answer is kept", ms: 0, status: "error" });
    releaseQueue(qid);
    toast("Run stopped. Retry restarts it with the same agent and model.");
  }
  function compareWith(qid, prov, model) {
    var q = N[qid], cont = N[q.parent];
    var u = newTurn(q.turn.question, "compare", q.turn, null);
    var P = PROV[prov];
    u.provider = prov; u.model = model; u.effort = P.efforts.length ? (P.efforts.indexOf(q.turn.effort) >= 0 ? q.turn.effort : "high") : null;
    u.title = q.turn.title;
    var nid = "q:" + u.id;
    add({ id: nid, kind: "question", tag: "question", turn: u, thread: q.thread, ws: q.ws, compareOf: qid });
    cont.children.splice(cont.children.indexOf(qid) + 1, 0, nid);
    N[nid].parent = cont.id;
    startRun(nid);
    st.flash = nid;
    render();
  }
  function compareMenu(anchor, qid) {
    var u = N[qid].turn, items = [{ header: "Ask the same question with…" }];
    D.providers.forEach((p) => {
      p.models.slice(0, 3).forEach((m) => {
        if (p.id === u.provider && m === u.model) return;
        items.push({ label: p.label + " · " + m, run: () => { compareWith(qid, p.id, m); } });
      });
    });
    openMenu(anchor, items);
  }
  function runningIn(cont) {
    var r = null;
    N[cont].children.forEach((c) => { var x = N[c]; if (x.kind === "question" && (x.turn.status === "running" || x.turn.status === "queued")) r = c; });
    return r;
  }
  function submit(cid, text) {
    text = (text || "").trim();
    if (!text) return;
    var key = "comp:" + cid;
    st.text[key] = "";
    var c = N[cid];
    var qid;
    if (c.kind === "draft") {
      var dn = c;
      cid = DAY;
      c = N[cid];
      N[dn.parent].children = N[dn.parent].children.filter((x) => { return x !== dn.id; });
    }
    if (c.kind === "thread" || c.kind === "para" || (c.kind === "question" && c.turn)) {
      var tn = threadOf(cid);
      var cont = c.kind === "question" ? c.parent : cid;
      var lastQ = null;
      N[cont].children.forEach((x) => { if (N[x].kind === "question") lastQ = N[x]; });
      var parentTurn = c.kind === "para" ? c.turn : c.kind === "question" ? c.turn : lastQ ? lastQ.turn : null;
      var relation = c.kind === "para" ? "branch" : "followup";
      var u = newTurn(text, relation, parentTurn, c.kind === "para" ? { turnId: c.turn.id, paragraph: c.idx, quote: st.bquote[cid] || clip(c.text, 80) } : null);
      delete st.bquote[cid];
      qid = "q:" + u.id;
      add({ id: qid, kind: "question", tag: "question", turn: u, thread: tn.thread, ws: tn.ws });
      push(cont, qid);
      var busy = c.kind === "para" ? null : runningIn(cont);
      if (busy && busy !== qid) { u.status = "queued"; N[qid].waitFor = busy; }
      if (c.kind === "para") { delete st.composers[cid]; st.tasks.branch = true; st.collapsed[cid] = false; }
      else st.tasks.branch = st.tasks.branch || relation === "followup" && st.firstRun;
      if (u.status === "running") startRun(qid);
    } else {
      // new thread: lives in the workspace (Unfiled), referenced where it was typed
      var t = {
        id: "tn" + (++seq), workspaceId: st.ws, folderId: null, kind: "exchange", title: clip(text, 60), status: "running",
        createdAt: D.now, updatedAt: D.now, unread: false, bookmarked: false, followed: false, archivedAt: null, recap: null, tags: [], links: [], turns: [],
      };
      var tid = "t:" + t.id;
      add({ id: tid, kind: "thread", tag: "thread", name: t.title, thread: t, ws: st.ws });
      var wsn = N["ws:" + st.ws];
      wsn.children.splice(wsn.children.filter((k) => { return N[k].kind === "folder"; }).length, 0, tid);
      N[tid].parent = wsn.id;
      var u2 = newTurn(text, "root", null, null);
      t.turns.push(u2);
      qid = "q:" + u2.id;
      add({ id: qid, kind: "question", tag: "question", turn: u2, thread: t, ws: st.ws });
      push(tid, qid);
      var rid = ref(cid, qid, { open: true });
      if (c.kind === "day") { c.children.pop(); c.children.unshift(rid); }
      st.scrollTo = qid;
      st.tasks.ask = true;
      startRun(qid);
    }
    st.focusKey = null;
    render();
  }

  function summarize(id) {
    var n = N[id];
    var tn = n.kind === "thread" ? n : n.kind === "question" ? n : null;
    var text;
    if (n.kind === "thread") text = n.thread.recap || "Three questions asked; the root answer identified the cause and a follow-up confirmed the fix.";
    else if (n.kind === "question") text = n.turn.recap || clip(n.turn.answer[0] || "No answer yet.", 160);
    else {
      var kids = descendants(id);
      var refs = kids.filter((k) => { return N[k].kind === "ref" || N[k].ref; }).length;
      text = "Summary: " + kids.length + " nodes, " + refs + " of them reference answers. Open items: " + kids.filter((k) => { var x = N[k]; return x.kind === "ref" && N[x.target] && N[x.target].turn && N[x.target].turn.status !== "done"; }).length + " runs still in progress.";
    }
    if (tn) {
      tn.recapStream = "";
      st.collapsed[id] = false;
      var words = text.split(" "), w = 0;
      (function tick() {
        w = Math.min(words.length, w + 2);
        tn.recapStream = words.slice(0, w).join(" ");
        render();
        if (w < words.length) later(tick, 50); else { tn.recapStream = null; tn.recapDone = text; render(); }
      })();
    } else {
      var sid = uid("i");
      add({ id: sid, kind: "item", name: "", own: true, tag: "summary" });
      N[id].children.unshift(sid); N[sid].parent = id;
      st.collapsed[id] = false;
      var words2 = text.split(" "), w2 = 0;
      (function tick2() {
        w2 = Math.min(words2.length, w2 + 2);
        N[sid].name = words2.slice(0, w2).join(" ");
        render();
        if (w2 < words2.length) later(tick2, 50);
      })();
    }
    toast("Summarize children: running on " + shortName(id));
  }

  /* -- outline editing */
  function canEdit(id) { return N[id] && N[id].own && N[id].kind !== "ref" ? true : false; }
  function movable(id) { var n = N[id]; return n && n.own && n.parent && N[n.parent] && (N[n.parent].own || N[n.parent].kind === "workspace"); }
  function indent(id) {
    if (!movable(id)) { toast("Answers and questions keep their place. Drag a paragraph into a note to reference it."); return false; }
    var n = N[id], p = N[n.parent], i = p.children.indexOf(id);
    if (i <= 0) return false;
    var prev = N[p.children[i - 1]];
    if (!prev.own) return false;
    p.children.splice(i, 1);
    prev.children.push(id); n.parent = prev.id;
    st.collapsed[prev.id] = false;
    return true;
  }
  function outdent(id) {
    if (!movable(id)) { toast("Answers and questions keep their place. Drag a paragraph into a note to reference it."); return false; }
    var n = N[id], p = N[n.parent];
    if (p.id === st.page || !p.parent || !N[p.parent].own) return false;
    var g = N[p.parent];
    p.children.splice(p.children.indexOf(id), 1);
    g.children.splice(g.children.indexOf(p.id) + 1, 0, id);
    n.parent = g.id;
    return true;
  }
  function newSibling(id) {
    var n = N[id], p = N[n.parent];
    var nid = uid("i");
    add({ id: nid, kind: "item", name: "", own: true });
    p.children.splice(p.children.indexOf(id) + 1, 0, nid);
    N[nid].parent = p.id;
    return nid;
  }
  function removeNode(id) {
    var n = N[id], p = N[n.parent];
    p.children.splice(p.children.indexOf(id), 1);
    delete N[id];
  }
  function addRefTo(targetPid, srcId) {
    var src = N[srcId];
    if (!src || !N[targetPid]) return;
    if (src.own && src.kind !== "note" && N[src.parent] && N[src.parent].own && src.kind !== "day") {
      N[src.parent].children.splice(N[src.parent].children.indexOf(srcId), 1);
      push(targetPid, srcId);
      toast("Moved to " + shortName(targetPid));
    } else {
      var tgt = src.kind === "ref" ? src.target : srcId;
      ref(targetPid, tgt);
      st.tasks.ref = true;
      toast("Reference added to " + shortName(targetPid));
    }
    render();
  }
  function moveThread(tid, folderPid) {
    var n = N[tid];
    N[n.parent].children.splice(N[n.parent].children.indexOf(tid), 1);
    if (N[folderPid].kind === "workspace") {
      N[folderPid].children.splice(N[folderPid].children.filter((k) => { return N[k].kind === "folder"; }).length, 0, tid);
      n.parent = folderPid;
    } else push(folderPid, tid);
    n.thread.folderId = N[folderPid].kind === "folder" ? folderPid.slice(2) : null;
    toast("Moved to " + N[folderPid].name);
    render();
  }

  /* -- toast / menu */
  function toast(msg) {
    st.toast = msg;
    var mine = msg;
    later(() => { if (st.toast === mine) { st.toast = null; render(); } }, 2600);
    render();
  }
  function openMenu(anchor, items) {
    var ar = app.getBoundingClientRect();
    var scale = ar.width / app.offsetWidth || 1;
    var r = anchor.getBoundingClientRect();
    var x = (r.left - ar.left) / scale, y = (r.bottom - ar.top) / scale + 4;
    if (x > 1280 - 330) x = (r.right - ar.left) / scale - 320;
    if (y > 800 - 260) y = Math.max(40, (r.top - ar.top) / scale - 4 - Math.min(items.length * 28 + 12, 380));
    st.menu = { x: x, y: y, items: items };
    menuFresh = !!(window.event && window.event.type === "click");
    render();
  }
  function agentMenu(anchor) {
    var items = [];
    D.providers.forEach((p) => {
      items.push({ header: p.label });
      p.models.forEach((m) => {
        items.push({
          label: m, chk: st.agent.provider === p.id && st.agent.model === m,
          run: () => { st.agent = { provider: p.id, model: m, effort: p.efforts.length ? (p.efforts.indexOf(st.agent.effort) >= 0 ? st.agent.effort : "high") : null }; },
        });
      });
    });
    var ef = PROV[st.agent.provider].efforts;
    if (ef.length) {
      items.push({ sep: true }, { header: "Effort" });
      ef.forEach((e) => { items.push({ label: e, chk: st.agent.effort === e, run: () => { st.agent.effort = e; } }); });
    }
    openMenu(anchor, items);
  }
  function addToMenu(anchor, srcId) {
    var items = [{ header: "Add a reference to…" }, { label: "Today", icon: "today", run: () => { addRefTo(DAY, srcId); } }];
    Object.keys(N).forEach((k) => {
      var n = N[k];
      if (n.kind === "note" && n.ws === st.ws) items.push({ label: n.name, icon: "note", run: () => { addRefTo(k, srcId); } });
    });
    items.push({ sep: true }, { label: "New note…", icon: "plus", run: () => { var nid = createNote(); addRefTo(nid, srcId); } });
    openMenu(anchor, items);
  }
  /* one menu per node: the same items for the "…" button and right-click (UX-07) */
  function nodeMenu(anchor, id) {
    var n = N[id];
    if (!n) return;
    var items = [];
    function it(label, icon, run, hint) { items.push({ label: label, icon: icon, run: run, hint: hint }); }
    if (n.kind === "question") {
      var u = n.turn;
      it("Follow up", "reply", () => { followUp(id); });
      it("Ask again with another model…", "box", () => { later(() => { compareMenu(anchor, id); }, 0); });
      if (u.status === "running") it("Stop run", "x", () => { stopRun(id); });
      if (u.status === "failed" || u.status === "stopped") it("Retry run", "retry", () => { startRun(id); });
      it("Add to…", "refadd", () => { later(() => { addToMenu(anchor, id); }, 0); });
    }
    if (n.kind === "para") {
      it("Branch from this paragraph", "branch", () => { openBranch(n, null); });
      it("Highlight", "hl", () => { highlightPara(n); });
      it("Add to…", "refadd", () => { later(() => { addToMenu(anchor, id); }, 0); });
    }
    if (n.kind === "thread" || n.kind === "note") it(n.pinned ? "Unpin" : "Pin to sidebar", "pin", () => { n.pinned = !n.pinned; });
    if (n.kind === "thread") {
      it(n.notify ? "Notify on replies: on" : "Notify on replies: off", "inbox", () => { n.notify = !n.notify; toast(n.notify ? "You will be notified when runs in this thread finish." : "Notifications off for this thread."); });
      items.push({ sep: true }, { header: "Move to" });
      it("Unfiled (" + N["ws:" + n.ws].name + ")", "box", () => { moveThread(id, "ws:" + n.ws); });
      Object.keys(N).forEach((k) => { if (N[k].kind === "folder" && N[k].ws === n.ws && k !== n.parent) it(N[k].name, "hash", () => { moveThread(id, k); }); });
      items.push({ sep: true });
      it("Archive", "archive", () => { moveThread(id, "archive:" + n.ws); n.thread.archivedAt = D.now; });
    }
    if (items.length) items.push({ sep: true });
    if (n.kind !== "para") it("Summarize children", "sum", () => { summarize(id); });
    it("Copy reference", "copy", () => { toast("Reference to “" + shortName(id) + "” copied"); }, "⌥R");
    if (n.own && n.kind === "item") it("Delete node", "x", () => { removeNode(id); });
    openMenu(anchor, items);
  }
  function pointAnchor(x, y) { return { getBoundingClientRect: () => { return { left: x, right: x, top: y, bottom: y }; } }; }
  function openBranch(p, quote) {
    st.composers[p.id] = true; st.collapsed[p.id] = false; st.focusKey = "comp:" + p.id;
    if (quote) st.bquote[p.id] = quote; else delete st.bquote[p.id];
    render();
  }
  function createNote() {
    var id = uid("n");
    add({ id: id, kind: "note", tag: "note", name: "Untitled note", ws: st.ws, own: true, updatedAt: D.now });
    var w = N["ws:" + st.ws];
    var at = w.children.filter((k) => { var kk = N[k].kind; return kk === "folder" || kk === "thread"; }).length;
    w.children.splice(at, 0, id); N[id].parent = w.id;
    return id;
  }
  function wsMenu(anchor) {
    var items = [{ header: "Workspaces" }];
    Object.keys(N).forEach((k) => {
      var n = N[k];
      if (n.kind === "workspace" && visibleWs(n.ws)) items.push({ label: n.name, hint: n.dir, chk: n.ws === st.ws, run: () => { st.ws = n.ws; go("ws:" + n.ws); } });
    });
    items.push({ sep: true });
    if (st.firstRun) items.push({ label: "Open the sample workspaces", icon: "box", run: openSamples });
    items.push({ label: "New workspace…", icon: "plus", hint: "creates a folder", run: () => { st.ws = newWorkspace("Untitled"); st.firstRun = true; st.tasks = { ask: false, branch: false, ref: false }; go("welcome"); } });
    items.push({ label: "Show in Finder", icon: "box", run: () => { toast(N["ws:" + st.ws].dir + " opened in Finder"); } });
    openMenu(anchor, items);
  }
  function openSamples() { st.firstRun = false; st.ws = "ws-compilers"; go("ws:ws-compilers"); }

  /* -- rendering: paragraphs */
  function paraHtml(n) {
    var html = md(n.text);
    (n.turn.highlights || []).forEach((hl) => {
      if (hl.paragraph !== n.idx) return;
      var q = md(hl.quote);
      var i = html.indexOf(q);
      if (i >= 0) html = html.slice(0, i) + '<mark class="hl hl-' + (hl.color || "amber") + '" title="' + esc(hl.note || "Highlight") + '">' + q + "</mark>" + html.slice(i + q.length);
    });
    n.children.forEach((c) => {
      var x = N[c];
      if (x && x.kind === "question" && x.turn.anchor && x.turn.anchor.quote) {
        var q = md(x.turn.anchor.quote);
        var i = html.indexOf(q);
        if (i >= 0) html = html.slice(0, i) + '<span class="anc" title="Branch: ' + esc(x.turn.title) + '">' + q + "</span>" + html.slice(i + q.length);
      }
    });
    var u = n.turn;
    if (u.status === "running" && n.idx === u.answer.length - 1) html += '<span class="caret"></span>';
    return html;
  }

  /* -- rendering: fields */
  function fld(name, value, icon) {
    return h("div.fld", h("div.fk", { html: ic(icon || "field", 13) + esc(name) }), h("div.fv", value));
  }
  function stepIcon(k) { return { think: "think", read: "read", grep: "grep", search: "search", fetch: "fetch", run: "term", edit: "edit" }[k] || "trace"; }
  function stepsEl(acts) {
    return h("div.steps", acts.map((s) => {
      return h("div", { class: "step " + (s.status || "ok") },
        h("span", { html: ic(stepIcon(s.kind), 14) }),
        h("span", null, s.label, s.detail ? h("span.d", "  " + s.detail) : null),
        h("span.ms", s.status === "running" ? "…" : s.ms >= 1000 ? (s.ms / 1000).toFixed(1) + " s" : s.ms + " ms"));
    }));
  }
  function sourceChips(u, max) {
    var list = u.sources || [];
    var out = list.slice(0, max || 3).map((s) => {
      return h("button.src", { title: s.title, onclick: (e) => { e.stopPropagation(); go(srcByUrl[s.url]); } }, h("span", { html: ic("globe", 13) }), h("span", null, s.domain + " · " + s.title));
    });
    if (list.length > (max || 3)) out.push(h("span.muted", "+" + (list.length - (max || 3))));
    return out;
  }
  function agentValue(u) {
    return [h("span.agent-dot", { style: "--pc:var(--" + u.provider + ")" }), agentLabel(u)];
  }
  function statusValue(qn) {
    var u = qn.turn;
    if (u.status === "running") return [statusChip("running"), h("span.muted", "  " + elapsed(u) + " elapsed")];
    if (u.status === "queued") {
      var w = qn.waitFor && N[qn.waitFor] ? N[qn.waitFor].turn.title : prevRunning(qn);
      return [statusChip("queued"), h("span.muted", "  Runs after “" + (w || "the running question") + "” finishes; a thread runs one answer at a time.")];
    }
    if (u.status === "done") return [statusChip("done"), h("span.muted", "  " + dur(u.durationSec) + " · " + rel(u.completedAt || u.createdAt))];
    if (u.status === "failed") return [statusChip("failed"), h("span.muted", "  " + rel(u.createdAt))];
    if (u.status === "stopped") return [statusChip("stopped"), h("span.muted", "  after " + dur(u.durationSec) + "; partial answer kept")];
    return [statusChip(u.status)];
  }
  function prevRunning(qn) {
    var p = N[qn.parent];
    var r = null;
    p.children.forEach((c) => { if (N[c].kind === "question" && N[c].turn.status === "running") r = N[c].turn.title; });
    return r;
  }
  /* compact inline fields for questions inside an outline; full rows when zoomed in */
  function relLabel(qn) {
    var u = qn.turn;
    if (u.relation === "compare" && qn.compareOf && N[qn.compareOf]) return "same question, compared with " + N[qn.compareOf].turn.model;
    if (u.relation === "branch") return "branch from ¶" + ((u.anchor && u.anchor.paragraph) + 1);
    if (u.relation === "followup") return "follow-up";
    return null;
  }
  function fieldStrip(qn) {
    var u = qn.turn, out = h("div.fstrip-wrap");
    var strip = h("div.fstrip");
    function fs(k, v, fn, open, title) {
      var el = h(fn ? "button" : "span", { class: "fs" + (open ? " open" : "") + (fn ? " btn" : ""), title: title || null, onclick: fn ? (e) => { e.stopPropagation(); fn(e); } : null }, h("span.fsk", k), v);
      strip.append(el);
    }
    fs("Agent", agentValue(u));
    var sv = u.status === "done" ? [statusChip("done"), " " + dur(u.durationSec)] : u.status === "running" ? [statusChip("running"), " " + elapsed(u)] : u.status === "stopped" ? [statusChip("stopped"), " after " + dur(u.durationSec)] : [statusChip(u.status)];
    fs("Status", sv);
    if (u.status === "running") strip.append(h("button.fbtn stop", { onclick: (e) => { e.stopPropagation(); stopRun(qn.id); } }, h("span", { html: ic("x", 12) }), "Stop"));
    var acts = u.activity || [];
    if (acts.length) {
      var total = acts.reduce((a, x) => { return a + (x.ms || 0); }, 0);
      var last = acts[acts.length - 1];
      fs("Trace", [u.status === "running" ? h("span.work", last.label) : acts.length + " steps · " + (total / 1000).toFixed(1) + " s", h("span.car", { html: ic("chev", 11) })],
        () => { st.traceOpen[qn.id] = !st.traceOpen[qn.id]; render(); }, st.traceOpen[qn.id], "Show tool calls");
    }
    if (u.sources.length) fs("Sources", [String(u.sources.length), h("span.car", { html: ic("chev", 11) })], () => { st.srcOpen[qn.id] = !st.srcOpen[qn.id]; render(); }, st.srcOpen[qn.id], "Show sources");
    if (u.status === "failed" || u.status === "stopped") strip.append(h("button.fbtn", { onclick: (e) => { e.stopPropagation(); startRun(qn.id); render(); } }, h("span", { html: ic("retry", 12) }), "Retry"));
    out.append(strip);
    if (st.traceOpen[qn.id] && acts.length) out.append(stepsEl(acts));
    if (st.srcOpen[qn.id] && u.sources.length) out.append(h("div.srcs", sourceChips(u, 9)));
    if (u.status === "queued") out.append(h("div.fnote", statusValue(qn)[1].textContent.trim()));
    if (u.status === "failed" && u.error) out.append(h("div.fv", h("span.err", u.error)));
    if (u.status === "needs-review" && u.clarification) out.append(h("div.fv", h("span.ask-agent", h("b", null, PROV[u.provider].label + " asks: "), u.clarification), replyBox(qn)));
    if (qn.recapStream != null || qn.recapDone) out.append(h("div.fnote", h("b", null, "Recap  "), qn.recapStream != null ? qn.recapStream : qn.recapDone));
    return out;
  }
  function replyBox(qn) {
    var key = "reply:" + qn.id;
    var ta = h("textarea", { rows: 1, "data-key": key, placeholder: "Answer the agent… (↵ sends it as a follow-up)" });
    ta.value = st.text[key] || "";
    ta.addEventListener("input", () => { st.text[key] = ta.value; });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault(); e.stopPropagation();
        qn.turn.status = "done";
        st.text[key] = "";
        submit(qn.id, ta.value);
      }
    });
    return h("div.ask", { style: "margin-top:2px" }, ta);
  }

  /* -- rendering: composer */
  function agentChip() {
    var a = st.agent;
    return h("button.agent", { title: "Agent, model and effort for this question", onclick: (e) => { e.stopPropagation(); agentMenu(e.currentTarget); } },
      h("span.agent-dot", { style: "--pc:var(--" + a.provider + ")" }), PROV[a.provider].label + " · " + a.model + (a.effort ? " · " + a.effort : ""), h("span", { html: ic("down", 12) }));
  }
  function composerRow(cid, ph, opts) {
    opts = opts || {};
    var key = "comp:" + cid;
    var ta = h("textarea", { rows: 1, "data-key": key, "data-cid": cid, placeholder: ph, "aria-label": ph });
    ta.value = st.text[key] || "";
    ta.addEventListener("input", () => { st.text[key] = ta.value; grow(ta); });
    var inherit = opts.inherit;
    var bar = h("div.ask-bar",
      tagChip("question"),
      inherit ? h("span.agent", { style: "cursor:default", title: "Follow-ups and branches use the same agent and model" }, h("span.agent-dot", { style: "--pc:var(--" + inherit.provider + ")" }), agentLabel(inherit)) : agentChip(),
      h("span.ask-hint", "↵ ask · ⇧↵ new line"),
      opts.cancel ? h("button.ask-x", { onclick: (e) => { e.stopPropagation(); opts.cancel(); } }, "Cancel") : null,
      h("button.ask-go", { onclick: (e) => { e.stopPropagation(); submit(cid, ta.value); } }, h("span", { html: ic("send", 14) }), "Ask"));
    return h("div.row comp", { "data-comp": cid },
      h("div.line", h("span.bul new"),
        h("div.ask", opts.quote ? h("div.comp-quote", opts.quote) : null, ta, bar)));
  }
  function grow(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }

  /* -- rendering: rows */
  function kidsOf(n) {
    if (n.kind === "search") return results(n).map((r) => { return { virt: n.id + ">" + r, target: r }; });
    return n.children.map((c) => { return { id: c }; });
  }
  function hasFields(n) { return n.kind === "question" && CFG.fields === "inline"; }
  function defaultCollapsed(key, n, isRef, depth) {
    if (isRef) return true;
    if (n.kind === "thread" || n.kind === "note" || n.kind === "system" || n.kind === "day") return true;
    if (n.kind === "folder") return depth > 0;
    if (n.kind === "search") return depth > 0;
    return false;
  }
  function isCollapsed(key, n, isRef, depth) {
    if (key in st.collapsed) return st.collapsed[key];
    return defaultCollapsed(key, n, isRef, depth);
  }
  function renderList(entries, depth, top) {
    var box = h("div", { class: "kids" + (top ? " top" : "") });
    entries.forEach((e) => {
      var r = e.virt ? renderRow(e.virt, depth, e.target) : renderRow(e.id, depth);
      if (r) box.appendChild(r);
    });
    return box;
  }
  function bullet(n, key, isRef, halo) {
    var tagged = n.tag && ["question", "thread", "note", "source", "highlight", "day", "summary"].indexOf(n.tag) >= 0;
    var cls = "bul" + (halo ? " halo" : "") + (isRef ? " ref" : "") + (tagged ? " tagged" : "") + (n.kind === "para" ? " para" : "") + (n.kind === "hlnote" ? " hln" : "");
    var html = "";
    var tc = tagged ? "var(--c-" + n.tag + ")" : null;
    if (n.kind === "search") { cls += " ico"; html = ic("search", 13); tc = "var(--c-search)"; }
    if (n.kind === "folder") { cls += " ico"; html = ic("hash", 13); tc = "var(--c-folder)"; }
    if (n.kind === "system") { cls += " ico"; html = ic(n.sys === "drafts" ? "draft" : "archive", 13); tc = "var(--c-folder)"; }
    return h("span", {
      class: cls, html: html, style: tc ? "--tc:" + tc : null, draggable: "true", "data-drag": n.id,
      title: "Zoom in · drag to reference",
      onclick: (e) => { e.stopPropagation(); go(n.id); },
    });
  }
  function rowActions(n, key) {
    var a = [];
    function ab(label, icon, fn, pri, title) { a.push(h("button", { class: "ab" + (pri ? " pri" : ""), title: title || null, "aria-label": label || title, onclick: (e) => { e.stopPropagation(); fn(e); } }, h("span", { html: ic(icon, 13) }), label)); }
    var more = (e) => { nodeMenu(e.currentTarget, n.id); };
    if (n.kind === "question") {
      ab("Follow up", "reply", () => { followUp(n.id); });
      ab("Compare", "box", (e) => { compareMenu(e.currentTarget, n.id); }, false, "Ask the same question with another model");
    } else if (n.kind === "para" && n.turn.status !== "running") {
      ab("Branch", "branch", () => { openBranch(n, null); }, true);
      ab("Highlight", "hl", () => { highlightPara(n); });
      ab("Add to…", "refadd", (e) => { addToMenu(e.currentTarget, n.id); });
    } else if (n.kind === "thread") {
      ab("Summarize", "sum", () => { summarize(n.id); });
    } else if (n.kind === "note" || n.kind === "item" || n.kind === "day") {
      if (n.children.length) ab("Summarize", "sum", () => { summarize(n.id); });
    } else return null;
    if (n.kind !== "day") ab("", "more", more, false, "More actions (also on right-click)");
    return h("div.acts", a);
  }
  function followUp(qid) {
    var tn = threadOf(qid);
    if (!tn) return;
    var q = N[qid];
    var cont = q.parent;
    if (N[cont].kind === "thread") {
      st.focusKey = "comp:" + cont;
      if (st.page !== tn.id) go(tn.id); else render();
      later(() => { var el = app.querySelector('[data-comp="' + cont + '"]'); if (el) el.scrollIntoView({ block: "center" }); }, 30);
    } else {
      st.composers[qid] = true;
      st.focusKey = "comp:" + qid;
      if (st.page !== tn.id && pageFor(qid) !== st.page) reveal(qid); else render();
    }
  }
  /* map a plain-text selection back to the paragraph's Markdown, widening to whole code spans */
  function rawQuote(n, sel) {
    var raw = n.text, map = [], pl = "";
    for (var i = 0; i < raw.length; i++) if (raw[i] !== "`") { map.push(i); pl += raw[i]; }
    var at = pl.indexOf(sel);
    if (at < 0 || !sel) return null;
    var a = map[at], b = map[at + sel.length - 1] + 1;
    if ((raw.slice(0, a).split("`").length - 1) % 2) a = raw.lastIndexOf("`", a);
    if ((raw.slice(0, b).split("`").length - 1) % 2) b = raw.indexOf("`", b) + 1;
    return raw.slice(a, b).trim();
  }
  function highlightPara(n, quote) {
    quote = quote || (n.text.split(/(?<=\.)\s/)[0] || n.text).replace(/\.$/, "");
    var hl = { id: "hx" + (++seq), paragraph: n.idx, quote: quote, color: "amber", note: null, createdAt: D.now };
    n.turn.highlights.push(hl);
    var tn = threadOf(n.id);
    add({ id: "h:" + hl.id, kind: "highlight", tag: "highlight", hl: Object.assign({ threadId: tn.thread.id, turnId: n.turn.id, threadTitle: tn.name, turnTitle: n.turn.title }, hl), para: n.id, ws: n.ws, parent: "tag:highlight" });
    toast("Highlighted. Listed under #highlight.");
  }

  function nodeBody(n, key, isRef, depth, col) {
    var b = h("div.nm");
    switch (n.kind) {
      case "question":
        if (isRef && col) {
          b.classList.add("q");
          b.append(n.turn.title, statusChip(n.turn.status));
          if (n.unread) b.append(h("span.unread", { title: "New answer" }));
          var tn = threadOf(n.id);
          var tname = tn && plain(n.turn.question).indexOf(tn.name.replace(/…$/, "")) !== 0 ? tn.name : null;
          if (tname || reasonFor(n)) b.append(h("span.sub", tname, tname && reasonFor(n) ? h("span.dot") : null, reasonFor(n)));
          var ib = INBOX[n.turn.id];
          if (ib && reasonFor(n) && st.page.indexOf("sq:") === 0) b.append(h("span.sub det", ib.detail));
        } else {
          b.classList.add("q");
          b.innerHTML = md(n.turn.question);
          b.append(tagChip("question"));
          if (CFG.fields !== "inline" || col) b.append(statusChip(n.turn.status, n.turn.status === "done" ? dur(n.turn.durationSec) : null));
          if (n.unread) b.append(h("span.unread", { title: "New answer" }));
          if (relLabel(n)) b.append(h("span", { class: "rel" + (n.turn.relation === "branch" ? " br" : "") }, relLabel(n)));
        }
        break;
      case "para":
        b = h("div", { class: "nm para" + (isRef ? " pref" : ""), "data-para": isRef ? null : n.id });
        b.append(h("span", { class: isRef && col ? "clamp" : null, html: paraHtml(n) }));
        if (isRef) b.append(h("span.sub", "¶" + (n.idx + 1) + " of “" + n.turn.title + "” · " + agentLabel(n.turn)));
        break;
      case "thread":
        b.append(n.name, tagChip("thread"), statusChip(threadStatus(n)));
        if (n.pinned) b.append(h("span.search-sum", { html: ic("pin", 12) }));
        b.append(h("span.search-sum", questionsIn(n.id).length + " questions · " + rel(n.thread.updatedAt)));
        break;
      case "folder":
        b.append(n.name, h("span.search-sum", threadsIn(n.id).length + " threads"));
        break;
      case "workspace":
        b.append(n.name, tagChip("workspace"), h("span.search-sum", n.dir));
        break;
      case "system":
        b.append(n.name, h("span.search-sum", String(n.children.length)));
        break;
      case "note":
        b.append(n.name, tagChip("note"), h("span.search-sum", n.children.length + " nodes · " + rel(n.updatedAt)));
        break;
      case "draft":
        b.innerHTML = md(n.name);
        b.append(tagChip("question"), statusChip("draft"));
        break;
      case "source":
        b.append(n.name, tagChip("source"), h("span.search-sum", n.domain));
        break;
      case "search":
        b.append(n.name, h("span.search-sum", querySummary(n) + " · " + results(n).length));
        break;
      case "highlight":
        b.append(h("mark", { class: "hl hl-" + (n.hl.color || "amber") }, plain(n.hl.quote)));
        b.append(h("span.sub", n.hl.threadTitle + " · ¶" + (n.hl.paragraph + 1)));
        if (n.hl.note) b.append(h("span.sub", { style: "font-style:italic;color:var(--tx2)" }, n.hl.note));
        break;
      case "day":
        b.append(n.name, tagChip("day"));
        break;
      case "item": case "hlnote":
        if (isRef) { b.textContent = n.name; break; }
        var ed = h("span", { class: "nm ed" + (n.kind === "hlnote" ? " hln" : ""), contenteditable: "true", spellcheck: "false", "data-key": "ed:" + n.id, "data-ph": "Type here", "data-edit": n.id });
        ed.textContent = n.name;
        ed.addEventListener("input", () => { n.name = ed.textContent; });
        b = h("div.nm", ed);
        if (n.tag === "summary") b.append(tagChip("summary"));
        if (n.ref && N[n.ref]) { b.append(refPill(n.ref)); if (N[n.ref].kind === "question" && N[n.ref].turn.status !== "done") b.append(statusChip(N[n.ref].turn.status)); }
        if (n.kind === "hlnote") b.append(h("span.search-sum", "note on highlight"));
        break;
      default:
        b.append(n.name || "");
    }
    return b;
  }
  function refPill(id) {
    var t = N[id];
    var tc = t.kind === "draft" ? "var(--s-plain)" : t.tag ? "var(--c-" + t.tag + ")" : null;
    return h("button.rpill", { style: tc ? "--tc:" + tc : null, title: "Go to " + shortName(id), onclick: (e) => { e.stopPropagation(); reveal(id); } },
      h("span", { html: ic("refadd", 12) }), h("span", null, shortName(id)));
  }

  function renderRow(key, depth, refTarget) {
    var self = N[key];
    var isRef = !!refTarget || (self && self.kind === "ref");
    var n = isRef ? N[refTarget || self.target] : self;
    if (!n) return null;
    var kids = kidsOf(n);
    var blockMode = CFG.answers === "block" && n.kind === "question" && !isRef;
    var withFields = hasFields(n) && !blockMode;
    var hasMore = kids.length > 0 || withFields || blockMode;
    var col = hasMore && isCollapsed(key, n, isRef, depth);
    var row = h("div", {
      class: "row k-" + n.kind + (st.sel === key || (st.sel === n.id && !isRef) ? " sel" : "") + (st.flash === n.id && !isRef ? " flash" : ""),
      "data-id": key, "data-node": n.id,
    });
    var line = h("div.line");
    if (hasMore) line.appendChild(h("button", { class: "tog" + (col ? "" : " open"), title: col ? "Expand (⌘↓)" : "Collapse (⌘↑)", html: ic("chev", 12), onclick: (e) => { e.stopPropagation(); st.collapsed[key] = !col; render(); } }));
    line.appendChild(bullet(n, key, isRef, col));
    line.appendChild(nodeBody(n, key, isRef, depth, col));
    var acts = rowActions(n, key);
    if (acts) line.appendChild(acts);
    row.appendChild(line);
    if (!col) {
      if (withFields) row.appendChild(fieldStrip(n));
      if (blockMode) { row.appendChild(answerBlock(n)); }
      else if (kids.length || st.composers[n.id]) {
        var list = renderList(kids, depth + 1);
        if (st.composers[n.id] && n.kind === "para") list.appendChild(composerRow(n.id, "Ask about this passage…", { inherit: n.turn, quote: st.bquote[n.id] ? "“" + plain(st.bquote[n.id]) + "”" : null, cancel: () => { delete st.composers[n.id]; render(); } }));
        row.appendChild(list);
      }
    }
    if (n.kind === "question" && st.composers[n.id] && !isRef) {
      var q = N[n.id];
      row.appendChild(composerRow(n.id, "Follow up on this question…", { inherit: q.turn, cancel: () => { delete st.composers[n.id]; render(); } }));
    }
    return row;
  }

  /* variant c: answers grouped in a block under the question */
  function answerBlock(qn) {
    var u = qn.turn;
    var paras = qn.children.filter((c) => { return N[c].kind === "para"; });
    var branches = [];
    var wrap = h("div");
    var head = h("div.ablock-h",
      h("span.agent-dot", { style: "--pc:var(--" + u.provider + ")" }), h("b", null, agentLabel(u)),
      statusChip(u.status, u.status === "done" ? dur(u.durationSec) : u.status === "running" ? elapsed(u) : null),
      u.status === "running" ? h("button.fbtn stop", { onclick: (e) => { e.stopPropagation(); stopRun(qn.id); } }, h("span", { html: ic("x", 12) }), "Stop") : null,
      u.status === "stopped" ? h("button.fbtn", { onclick: (e) => { e.stopPropagation(); startRun(qn.id); render(); } }, h("span", { html: ic("retry", 12) }), "Retry") : null);
    var acts = u.activity || [];
    var open = !!st.traceOpen[qn.id];
    if (acts.length) head.append(h("button", { class: "trtog" + (open ? " open" : ""), style: "font-size:12.5px;color:var(--mu)", onclick: (e) => { e.stopPropagation(); st.traceOpen[qn.id] = !open; render(); } }, h("span", { html: ic("chev", 12) }), u.status === "running" ? "Working · " + acts[acts.length - 1].label : "Trace · " + acts.length + " steps"));
    head.append(h("span.sp"));
    if (u.sources.length) head.append(h("span", null, u.sources.length + (u.sources.length === 1 ? " source" : " sources")));
    var block = h("div.ablock", head);
    if (open) block.append(h("div.ablock-tr", stepsEl(acts)));
    var body = h("div.ablock-b");
    if (u.status === "needs-review" && u.clarification) body.append(h("div.fv", h("span.ask-agent", u.clarification), replyBox(qn)));
    if (u.status === "failed") body.append(h("div.fv", h("span.err", u.error || "Run failed"), h("button.fbtn", { style: "margin-left:0", onclick: (e) => { e.stopPropagation(); startRun(qn.id); render(); } }, h("span", { html: ic("retry", 13) }), "Retry run")));
    if (u.status === "queued") body.append(h("div.fv muted", statusValue(qn)[1].textContent.trim()));
    paras.forEach((pid) => {
      var p = N[pid];
      var br = p.children.filter((c) => { return N[c].kind === "question"; });
      var notes = p.children.filter((c) => { return N[c].kind === "hlnote"; });
      var pe = h("div", { class: "ap row" + (st.sel === pid ? " sel" : ""), "data-id": pid, "data-node": pid },
        br.length ? h("span.bmark", { title: br.length + " branch" + (br.length > 1 ? "es" : "") }) : null,
        h("div.line", { style: "display:block;padding:0" }, h("div.para", { "data-para": pid, html: paraHtml(p) }), rowActions(p, pid)));
      if (notes.length) pe.append(h("div", { style: "margin-top:2px" }, notes.map((nid) => { return renderRow(nid, 1); })));
      if (st.composers[pid]) pe.append(composerRow(pid, "Ask about this passage…", { inherit: u, quote: st.bquote[pid] ? "“" + plain(st.bquote[pid]) + "”" : null, cancel: () => { delete st.composers[pid]; render(); } }));
      body.append(pe);
      br.forEach((b) => { branches.push({ id: b, p: p }); });
    });
    if (!paras.length && u.status !== "needs-review" && u.status !== "failed" && u.status !== "queued") body.append(h("div.fv muted", "Waiting for the first paragraph…"));
    if (u.sources.length) body.append(h("div", { style: "margin-top:8px" }, sourceChips(u, 3)));
    block.append(body);
    wrap.append(block);
    if (qn.recapStream != null || qn.recapDone) wrap.append(h("div.flds", fld("Recap", qn.recapStream != null ? qn.recapStream : qn.recapDone, "sum")));
    if (branches.length) {
      var kids = h("div.kids", { style: "margin-left:32px" });
      branches.forEach((b) => {
        kids.append(h("div.anchor-line", h("span", { html: ic("branch", 12) }), "Branch from ¶" + (b.p.idx + 1), N[b.id].turn.anchor && N[b.id].turn.anchor.quote ? h("q", null, plain(N[b.id].turn.anchor.quote)) : null));
        kids.append(renderRow(b.id, 2));
      });
      wrap.append(kids);
    }
    return wrap;
  }

  /* -- rendering: views */
  function viewOf(id) {
    if (st.views[id]) return st.views[id];
    return (N[id] && N[id].view) || "outline";
  }
  function viewTabs(id, info, tabs) {
    var cur = viewOf(id);
    tabs = tabs || [["outline", "Outline", "outline"], ["table", "Table", "table"], ["cards", "Cards", "cards"]];
    return h("div.views", { role: "tablist" }, tabs.map((t) => {
      return h("button", { class: "vt" + (cur === t[0] ? " on" : ""), role: "tab", "aria-selected": String(cur === t[0]), onclick: () => { st.views[id] = t[0]; render(); } }, h("span", { html: ic(t[2], 14) }), t[1]);
    }), info ? h("span.vinfo", info) : null);
  }
  function qTable(qids, grouped) {
    var t = h("div.tbl");
    t.append(h("div.tr th", ["Question", grouped ? "Relation" : "Thread", "Status", "Model", "Src", "Asked"].map((c, i) => { return h("div", { class: "td" + (i === 4 ? " num" : "") }, c); })));
    var lastT = null;
    qids.forEach((id) => {
      var tn0 = threadOf(id);
      if (grouped && tn0 && tn0 !== lastT) {
        lastT = tn0;
        t.append(h("div.tgroup", { onclick: () => { go(tn0.id); } }, h("span.bul tagged", { style: "--tc:var(--c-thread);height:18px;width:14px" }), tn0.name, tagChip("thread"), statusChip(threadStatus(tn0))));
      }
      var q = N[id], u = q.turn, tn = threadOf(id);
      var depth = 0, a = N[q.parent];
      while (a && a.kind !== "thread") { if (a.kind === "para") depth++; a = N[a.parent]; }
      t.append(h("div.tr", { "data-id": "tbl>" + id, onclick: () => { reveal(id); } },
        h("div.td", { title: plain(u.question) }, depth ? h("span.ind", { html: ic("branch", 11) }) : u.relation === "followup" ? h("span.ind", { html: ic("reply", 11) }) : null, h("span.tdot"), h("span", null, u.title), q.unread ? h("span.unread") : null),
        h("div.td", grouped ? (u.relation === "root" ? "First question" : u.relation === "branch" ? "Branch from ¶" + ((u.anchor && u.anchor.paragraph) + 1) : "Follow-up") : tn ? tn.name : ""),
        h("div.td", statusChip(u.status)),
        h("div.td", { title: agentLabel(u) }, h("span.agent-dot", { style: "--pc:var(--" + u.provider + ")" }), u.model),
        h("div.td num", String(u.sources.length || "–")),
        h("div.td", rel(u.createdAt))));
    });
    if (!qids.length) t.append(h("div.tr", { style: "cursor:default" }, h("div.td", { style: "color:var(--mu)" }, "No questions match.")));
    return t;
  }
  function threadCards(tids) {
    return h("div.crds", tids.map((id) => {
      var tn = N[id], t = tn.thread;
      var qs = questionsIn(id);
      var srcs = 0, hls = 0;
      qs.forEach((q) => { srcs += N[q].turn.sources.length; hls += N[q].turn.highlights.length; });
      var first = N[qs[0]];
      return h("div.crd", { onclick: () => { go(id); } },
        h("div.ct", tagChip("thread"), statusChip(threadStatus(tn))),
        h("h3", null, tn.name),
        h("p", { html: md(t.recap || (first && first.turn.answer[0]) || (first ? first.turn.question : "")) }),
        h("div.cf", h("span", null, qs.length + " questions"), h("span", null, srcs + " sources"), hls ? h("span", null, hls + " highlights") : null, h("span", { style: "margin-left:auto" }, rel(t.updatedAt))));
    }));
  }
  function questionCards(qids) {
    return h("div.crds", qids.map((id) => {
      var q = N[id], u = q.turn, tn = threadOf(id);
      return h("div.crd", { onclick: () => { reveal(id); } },
        h("div.ct", tagChip("question"), statusChip(u.status), q.unread ? h("span.unread") : null),
        h("h3", null, u.title),
        h("p", { html: md(u.answer[0] || u.error || u.clarification || u.question) }),
        h("div.cf", h("span", null, tn ? tn.name : ""), h("span", { style: "margin-left:auto" }, rel(u.createdAt))));
    }));
  }

  function querySummary(n) {
    var q = n.q;
    if (q.day) return "#question asked on " + dayName(q.day, false);
    var parts = ["#" + q.tag];
    var conds = [];
    if (q.status && q.status.length) conds.push("Status is " + q.status.map((s) => { return STAT[s].label; }).join(" or "));
    if (q.unread) conds.push("unread");
    return parts.concat(conds.length ? ["where " + conds.join(", or ")] : []).join(" ");
  }
  function queryBar(n) {
    var q = n.q;
    var bar = h("div.qb", h("span", { html: ic("search", 14) }), tagChip(q.tag));
    if (q.day) { bar.append(h("span.kw", "where"), h("span.qc", "Asked on " + dayName(q.day, false))); return bar; }
    if (q.tag !== "question") { bar.append(h("span.kw", "in"), h("span.qc", st.firstRun ? N["ws:" + st.ws].name : "All workspaces")); return bar; }
    bar.append(h("span.kw", "where Status is"));
    (q.status || []).forEach((s) => {
      bar.append(h("span.qc", STAT[s].label, h("button", { title: "Remove", html: ic("x", 11), onclick: () => { q.status = q.status.filter((x) => { return x !== s; }); render(); } })));
    });
    if (!(q.status || []).length) bar.append(h("span.qc", "any"));
    bar.append(h("button", {
      class: "qadd", onclick: (e) => {
        openMenu(e.currentTarget, Object.keys(STAT).filter((s) => { return (q.status || []).indexOf(s) < 0; }).map((s) => {
          return { label: STAT[s].label, run: () => { q.status = (q.status || []).concat([s]); } };
        }));
      },
    }, "+ value"));
    if (q.unread != null) bar.append(h("span.kw", "or"), h("button.qc", { style: "cursor:pointer", onclick: () => { q.unread = !q.unread; render(); } }, q.unread ? "Unread is yes" : "Unread: ignored"));
    bar.append(h("span.kw", "· in"), h("span.qc", st.firstRun ? N["ws:" + st.ws].name : "All workspaces"));
    return bar;
  }

  /* -- referenced by */
  function refsTo(ids) {
    var set = {};
    ids.forEach((i) => { set[i] = 1; });
    var out = [];
    Object.keys(N).forEach((k) => {
      var x = N[k];
      if (!x) return;
      if ((x.kind === "ref" && set[x.target]) || (x.kind === "item" && x.ref && set[x.ref])) {
        var owner = ancestors(k).map((a) => { return N[a]; }).filter((a) => { return a.kind === "note" || a.kind === "day"; })[0];
        if (owner && !visibleWs(owner.ws || st.ws)) return;
        out.push({ id: k, owner: owner, target: x.kind === "ref" ? x.target : x.ref });
      }
    });
    return out;
  }
  function referencedBy(id) {
    var n = N[id];
    var ids = [id].concat(descendants(id));
    var refs = refsTo(ids);
    var box = h("div.refby");
    var linked = n.kind === "thread" ? (n.thread.links || []).filter((l) => { return N["t:" + l]; }) : [];
    box.append(h("h4", null, "Referenced by", h("span", null, String(refs.length))));
    if (!refs.length) box.append(h("div.none", "No notes reference this yet. Drag any paragraph onto a note in the sidebar, or use Add to… on a paragraph."));
    var groups = {};
    refs.forEach((r) => { var k = r.owner ? r.owner.id : "other"; (groups[k] = groups[k] || []).push(r); });
    Object.keys(groups).forEach((g) => {
      var owner = N[g];
      box.append(h("div.grp", owner ? tagChip(owner.tag) : null, owner ? h("button.lnk", { style: "border:0;background:none;padding:0;font:inherit;color:var(--tx2);cursor:pointer", onclick: () => { go(owner.id); } }, owner.name) : "Elsewhere"));
      var list = h("div.kids top");
      groups[g].forEach((r) => {
        var x = N[r.id];
        var row = h("div.row", { "data-id": "rb>" + r.id },
          h("div.line",
            h("span.bul ref", { onclick: () => { reveal(r.id); } }),
            h("div.nm", { style: "cursor:pointer", onclick: () => { reveal(r.id); } },
              x.kind === "item" ? x.name : displayName(r.target).slice(0, 140),
              h("span.sub", "→ " + (N[r.target].kind === "para" ? "¶" + (N[r.target].idx + 1) + " of " + N[r.target].turn.title : shortName(r.target))))));
        list.append(row);
      });
      box.append(list);
    });
    if (linked.length) {
      box.append(h("h4", { style: "margin-top:16px" }, "Linked threads", h("span", null, String(linked.length))));
      var l2 = h("div.kids top");
      linked.forEach((l) => { l2.append(renderRow("lk>" + l, 0, "t:" + l)); });
      box.append(l2);
    }
    return box;
  }

  /* -- rendering: pages */
  function pageHeader(n, opts) {
    opts = opts || {};
    var ph = h("div.ph");
    var title;
    var editable = n.own && (n.kind === "note" || n.kind === "item");
    if (n.kind === "question") title = h("h1.mid", { html: md(n.turn.question) });
    else if (n.kind === "para") title = h("h1.small", { html: paraHtml(n) });
    else if (n.kind === "highlight") title = h("h1.mid", plain(n.hl.quote));
    else if (n.kind === "draft") title = h("h1.mid", { html: md(n.name) });
    else {
      title = h("h1", { class: (n.name || "").length > 44 ? "mid" : "" }, n.name || shortName(n.id));
      if (editable) { title.setAttribute("contenteditable", "true"); title.setAttribute("data-key", "ed:" + n.id); title.setAttribute("spellcheck", "false"); title.addEventListener("input", () => { n.name = title.textContent; }); }
    }
    var tr = h("div.ph-t", title);
    var chips = h("span.ph-chips");
    if (n.tag && n.tag !== "workspace" && n.tag !== "folder") chips.append(tagChip(n.tag));
    if (n.kind === "folder") chips.append(tagChip("folder"));
    if (n.kind === "workspace") chips.append(tagChip("workspace"));
    if (n.kind === "thread") chips.append(statusChip(threadStatus(n)));
    if (n.kind === "question") chips.append(statusChip(n.turn.status));
    if (n.kind === "search") chips.append(h("span.tag", { style: "--tc:var(--c-search)" }, "live search"));
    tr.append(chips);
    var top = h("div.ph-top", tr);
    if (n.kind === "thread" || n.kind === "note" || n.kind === "question") {
      top.append(h("div.ph-acts",
        h("button", { class: "ib" + (n.pinned ? " on" : ""), title: n.pinned ? "Unpin" : "Pin to sidebar", html: ic("pin", 15), onclick: () => { n.pinned = !n.pinned; render(); } }),
        h("button.ib", { title: "Summarize children", html: ic("sum", 15), onclick: () => { summarize(n.id); } }),
        h("button.ib", { title: "More", html: ic("more", 16), onclick: (e) => { nodeMenu(e.currentTarget, n.id); } })));
    }
    ph.append(top);
    if (opts.meta) ph.append(h("div.ph-meta", opts.meta));
    if (opts.fields) ph.append(opts.fields);
    return ph;
  }
  function metaJoin(parts) {
    var out = [];
    parts.filter(Boolean).forEach((p, i) => { if (i) out.push(h("span.dot")); out.push(p); });
    return out;
  }
  function crumbLink(id) {
    return h("button.lnk", { onclick: () => { go(id); } }, shortName(id));
  }

  function renderPage() {
    var n = N[st.page];
    var page = h("div.page");
    if (!n) { st.page = DAY; n = N[DAY]; }
    switch (n.kind) {
      case "thread": return threadPage(n, page);
      case "workspace": case "folder": return containerPage(n, page);
      case "search": return searchPage(n, page);
      case "tutorial": return welcomePage(n, page);
      case "graph": return graphPage(n, page);
      case "day": return dayPage(n, page);
      case "journal":
        page.append(pageHeader(n, { meta: metaJoin(["Daily pages", "questions are listed on the day they were asked"]) }));
        page.append(renderList(n.children.map((c) => { return { id: c }; }), 0, true));
        return page;
      default: return genericPage(n, page);
    }
  }
  function threadPage(n, page) {
    var t = n.thread;
    var qs = questionsIn(n.id);
    var branches = qs.filter((q) => { return N[q].turn.relation === "branch"; }).length;
    var wsn = N["ws:" + n.ws];
    var folder = N[n.parent];
    var flds = [];
    if (n.recapStream != null || n.recapDone || t.recap) flds.push(fld("Recap", n.recapStream != null ? n.recapStream : (n.recapDone || t.recap), "sum"));
    flds.push(fld("Folder", folder.kind === "folder" ? h("button.rpill", { style: "--tc:var(--c-folder)", onclick: (e) => { nodeMenu(e.currentTarget, n.id); } }, h("span", { html: ic("hash", 12) }), h("span", null, folder.name)) : h("span.muted", folder.kind === "system" ? folder.name : "Unfiled"), "hash"));
    if (t.tags && t.tags.length) flds.push(fld("Topics", t.tags.map((g) => { return h("span.topic", g); }), "hash"));
    page.append(pageHeader(n, {
      meta: metaJoin([h("span", null, wsn ? wsn.name : ""), qs.length + " questions", branches ? branches + (branches === 1 ? " branch" : " branches") : null, "started " + rel(t.createdAt), n.notify ? "notifies on replies" : null]),
      fields: h("div.flds", { style: "padding-left:0;margin-top:10px" }, flds),
    }));
    var tv = st.views[n.id] || "outline";
    page.append(viewTabs(n.id, tv === "questions" ? "follow-ups stay on one level; branches nest under the question they came from" : qs.length + " questions · " + countKind(n.id, "para") + " answer paragraphs", [["outline", "Outline", "outline"], ["questions", "Questions only", "branch"]]));
    if (tv === "questions") { page.append(qTreeList(n.id, 0)); page.append(referencedBy(n.id)); return page; }
    var list = renderList(n.children.map((c) => { return { id: c }; }), 0, true);
    var last = null;
    n.children.forEach((c) => { if (N[c].kind === "question") last = N[c]; });
    list.append(composerRow(n.id, t.archivedAt ? "Archived threads are read-only. Unarchive to ask." : "Ask a follow-up in this thread…", { inherit: last ? last.turn : null }));
    page.append(list);
    page.append(referencedBy(n.id));
    return page;
  }
  /* "Questions only": the thread's tree shape at a glance */
  function qTreeList(contId, depth) {
    var box = h("div", { class: depth ? "kids" : "kids top" });
    N[contId].children.forEach((c) => { if (N[c].kind === "question") box.append(qTreeRow(c)); });
    return box;
  }
  function qTreeRow(qid) {
    var q = N[qid], u = q.turn;
    var open = () => { st.views[threadOf(qid).id] = "outline"; reveal(qid); };
    var row = h("div.row k-question", { "data-id": "qt>" + qid, "data-node": qid },
      h("div.line", h("span.bul tagged", { style: "--tc:var(--c-question)", title: "Zoom in", onclick: (e) => { e.stopPropagation(); go(qid); } }),
        h("div.nm q", { style: "cursor:pointer", onclick: open }, u.title, statusChip(u.status), relLabel(q) ? h("span", { class: "rel" + (u.relation === "branch" ? " br" : "") }, relLabel(q)) : null,
          h("span.search-sum", u.model + " · " + u.answer.length + " ¶" + (u.highlights.length ? " · " + u.highlights.length + (u.highlights.length === 1 ? " highlight" : " highlights") : "")))));
    var kids = h("div.kids");
    q.children.forEach((pid) => { if (N[pid].kind === "para") N[pid].children.forEach((c) => { if (N[c].kind === "question") kids.append(qTreeRow(c)); }); });
    if (kids.childNodes.length) row.append(kids);
    return row;
  }

  /* graph: threads and notes; lines are thread links and note references */
  function graphData(scope) {
    var nodes = [], idx = {}, edges = [], seen = {};
    function addN(id, ext) { if (idx[id] == null) { idx[id] = nodes.length; nodes.push({ id: id, ext: ext }); } }
    function addE(a, b, type) { var k = [a, b].sort().join("|"); if (a !== b && !seen[k]) { seen[k] = 1; edges.push({ a: a, b: b, type: type }); } }
    function okT(t) { return t && t.kind === "thread" && !t.thread.archivedAt && visibleWs(t.ws); }
    var base = Object.keys(N).filter((k) => { var x = N[k]; return (okT(x) || (x.kind === "note" && visibleWs(x.ws))) && (scope === "all" || x.ws === st.ws); });
    base.forEach((k) => { addN(k, false); });
    base.forEach((k) => {
      var x = N[k];
      if (x.kind === "thread") (x.thread.links || []).forEach((l) => { var t = N["t:" + l]; if (!okT(t)) return; addN(t.id, true); addE(k, t.id, "link"); });
      if (x.kind === "note") descendants(k).forEach((d) => {
        var y = N[d], tg = y.kind === "ref" ? y.target : y.ref;
        if (!tg || !N[tg]) return;
        var th = N[tg].kind === "thread" ? N[tg] : threadOf(tg);
        if (!okT(th)) return;
        addN(th.id, true); addE(k, th.id, "ref");
      });
    });
    return { nodes: nodes, edges: edges, idx: idx };
  }
  function layout(g, W, H) {
    var ns = g.nodes, n = ns.length, wsIds = [];
    ns.forEach(function (p) { var w = N[p.id].ws; if (wsIds.indexOf(w) < 0) wsIds.push(w); });
    var cx = function (p) { var k = wsIds.indexOf(N[p.id].ws); return wsIds.length < 2 ? W * 0.42 : 90 + (W - 330) * (k / (wsIds.length - 1)); };
    ns.forEach(function (p, i) { p.ax = cx(p); p.x = p.ax + Math.cos(i * 2.4) * 60; p.y = H / 2 + Math.sin(i * 2.4) * 120; });
    for (var it = 0; it < 500; it++) {
      var cool = 1 - it / 500;
      ns.forEach(function (p) { p.fx = (p.ax - p.x) * 0.014; p.fy = (H / 2 + 10 - p.y) * 0.005; });
      for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
        var dx = ns[i].x - ns[j].x, dy = ns[i].y - ns[j].y, ex = dx * 0.6, d2 = Math.max(ex * ex + dy * dy, 36), d = Math.sqrt(d2), f = 2600 / d2;
        ns[i].fx += ex / d * f; ns[i].fy += dy / d * f * 1.4; ns[j].fx -= ex / d * f; ns[j].fy -= dy / d * f * 1.4;
      }
      g.edges.forEach(function (e) {
        var a = ns[g.idx[e.a]], b = ns[g.idx[e.b]], dx = b.x - a.x, dy = b.y - a.y, d = Math.max(1, Math.sqrt(dx * dx + dy * dy)), f = (d - 120) * 0.004;
        a.fx += dx / d * f; a.fy += dy / d * f; b.fx -= dx / d * f; b.fy -= dy / d * f;
      });
      ns.forEach(function (p) {
        p.x = Math.max(40, Math.min(W - 200, p.x + Math.max(-14, Math.min(14, p.fx)) * (0.3 + cool)));
        p.y = Math.max(28, Math.min(H - 34, p.y + Math.max(-14, Math.min(14, p.fy)) * (0.3 + cool)));
      });
    }
  }
  function graphView(scope) {
    var W = 880, H = 480, g = graphData(scope);
    layout(g, W, H);
    var ring = { running: "s-run", failed: "s-err", "needs-review": "s-att", queued: "s-plain" };
    var svg = '<svg viewBox="0 0 ' + W + " " + H + '" width="100%" role="img" aria-label="Graph of threads and notes">';
    if (scope === "all") {
      var cl = {};
      g.nodes.forEach(function (p) { var w = N[p.id].ws; cl[w] = cl[w] || { x: 1e9, n: 0 }; cl[w].x = Math.min(cl[w].x, p.x); cl[w].n++; });
      Object.keys(cl).forEach(function (w) { svg += '<text class="gcl" x="' + (cl[w].x - 10).toFixed(0) + '" y="22">' + esc(N["ws:" + w].name.toUpperCase()) + "</text>"; });
    }
    g.edges.forEach((e) => {
      var a = g.nodes[g.idx[e.a]], b = g.nodes[g.idx[e.b]];
      svg += '<line class="ge ' + e.type + '" data-a="' + esc(e.a) + '" data-b="' + esc(e.b) + '" x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '"/>';
    });
    g.nodes.forEach((p) => {
      var x = N[p.id], isT = x.kind === "thread";
      var r = isT ? 6 + Math.min(5, questionsIn(p.id).length) : 7;
      var stt = isT ? threadStatus(x) : null;
      var lab = clip(x.name, 30);
      svg += '<g class="gn' + (p.ext ? " ext" : "") + '" data-gid="' + esc(p.id) + '" transform="translate(' + p.x.toFixed(1) + "," + p.y.toFixed(1) + ')">' +
        (ring[stt] ? '<circle r="' + (r + 4) + '" class="gring" style="stroke:var(--' + ring[stt] + ')"/>' : "") +
        (isT ? '<circle r="' + r + '" style="fill:var(--c-thread)"/>' : '<rect x="-7" y="-7" width="14" height="14" rx="3" style="fill:var(--c-note)"/>') +
        '<text x="' + (r + 7) + '" y="4">' + esc(lab) + "</text>" +
        (p.ext && scope !== "all" ? '<text class="gws" x="' + (r + 7) + '" y="18">' + esc(N["ws:" + x.ws].name) + "</text>" : "") + "</g>";
    });
    svg += "</svg>";
    var box = h("div.graph", { html: svg });
    box.addEventListener("click", (e) => { var gn = e.target.closest("[data-gid]"); if (gn) go(gn.getAttribute("data-gid")); });
    box.addEventListener("mouseover", (e) => {
      var gn = e.target.closest("[data-gid]");
      box.classList.toggle("focus", !!gn);
      box.querySelectorAll(".on").forEach((x) => { x.classList.remove("on"); });
      if (!gn) return;
      var id = gn.getAttribute("data-gid");
      gn.classList.add("on");
      box.querySelectorAll("line").forEach((l) => {
        var a = l.getAttribute("data-a"), b = l.getAttribute("data-b");
        if (a === id || b === id) { l.classList.add("on"); var o = box.querySelector('[data-gid="' + cssEsc(a === id ? b : a) + '"]'); if (o) o.classList.add("on"); }
      });
    });
    box.addEventListener("mouseleave", () => { box.classList.remove("focus"); });
    var legend = h("div.glegend",
      h("span", null, h("i.lg-t"), "#thread (size = questions)"), h("span", null, h("i.lg-n"), "#note"),
      h("span", null, h("i.lg-l"), "linked threads"), h("span", null, h("i.lg-r"), "note references a thread"),
      h("span", null, h("i.lg-s"), "ring = running, failed or needs review"));
    return h("div", null, box, legend);
  }
  function graphPage(n, page) {
    page.classList.add("wide");
    page.append(pageHeader(n, { meta: metaJoin(["Every #thread and #note as a point", "click one to open it", "hover to see its links"]) }));
    var scope = st.graphScope;
    page.append(viewTabs("graph-scope", null, []));
    var tabs = page.lastChild;
    [["ws", "This workspace (" + N["ws:" + st.ws].name + ")"], ["all", "All workspaces"]].forEach((t) => {
      tabs.insertBefore(h("button", { class: "vt" + (scope === t[0] ? " on" : ""), onclick: () => { st.graphScope = t[0]; render(); } }, t[1]), tabs.lastChild);
    });
    page.append(graphView(scope));
    return page;
  }
  function containerPage(n, page) {
    var isWs = n.kind === "workspace";
    var tids = threadsIn(n.id).filter((k) => { return !N[k].thread.archivedAt; });
    var qids = [];
    tids.forEach((tid) => { qids = qids.concat(questionsIn(tid)); });
    var meta = isWs
      ? metaJoin([h("span", { style: "font-family:JetBrains Mono,ui-monospace,monospace;font-size:12px" }, n.dir), n.children.filter((c) => { return N[c].kind === "folder"; }).length + " folders", tids.length + " threads", countKind(n.id, "note") + (countKind(n.id, "note") === 1 ? " note" : " notes")])
      : metaJoin(["Folder in " + N["ws:" + n.ws].name, tids.length + " threads", qids.length + " questions"]);
    page.append(pageHeader(n, { meta: meta }));
    if (isWs) {
      var cl = renderList([], 0, true);
      cl.append(composerRow("ws:" + n.ws === n.id ? DAY : DAY, "Ask a new question in " + n.name + "…", {}));
      page.append(cl);
    }
    var v = viewOf(n.id);
    if (v !== "outline") page.classList.add("wide");
    var tabs = [["outline", "Outline", "outline"], ["table", "Table", "table"], ["cards", "Cards", "cards"]];
    if (isWs) tabs.push(["graph", "Graph", "graph"]);
    page.append(viewTabs(n.id, v === "table" ? qids.length + " #question nodes" : v === "cards" ? tids.length + " #thread nodes" : v === "graph" ? "threads and notes in " + n.name + ", plus linked nodes elsewhere" : n.children.length + " nodes", tabs));
    if (v === "graph") { page.append(graphView("ws")); return page; }
    if (v === "table") {
      var ord = tids.slice().sort((a, b) => { return Date.parse(N[b].thread.updatedAt) - Date.parse(N[a].thread.updatedAt); });
      var gq = [];
      ord.forEach((tid) => { gq = gq.concat(questionsIn(tid).sort((a, b) => { return Date.parse(N[a].turn.createdAt) - Date.parse(N[b].turn.createdAt); })); });
      page.append(qTable(gq, true));
      var others = n.children.filter((c) => { return N[c].kind === "note" || (N[c].kind === "system" && N[c].children.length); });
      if (others.length) { page.append(h("div.res-meta", { style: "margin-top:18px" }, "Notes, drafts and archive")); page.append(renderList(others.map((c) => { return { id: c }; }), 0, true)); }
    }
    else if (v === "cards") page.append(tids.length ? threadCards(tids) : h("div.empty", "No threads yet."));
    else {
      if (!n.children.length || (isWs && tids.length === 0 && countKind(n.id, "note") === 0)) page.append(h("div.empty", "Nothing here yet. Questions you ask from this workspace appear here as #thread nodes; folders and notes are parent nodes you create."));
      page.append(renderList(n.children.map((c) => { return { id: c }; }), 0, true));
    }
    return page;
  }
  function searchPage(n, page) {
    var res = results(n);
    page.append(pageHeader(n, { meta: metaJoin(["Live search", "updates as runs change", res.length + " results"]) }));
    page.append(queryBar(n));
    var isQ = n.q.tag === "question";
    if (isQ) {
      var v = viewOf(n.id);
      if (v !== "outline") page.classList.add("wide");
      page.append(viewTabs(n.id, res.length + " results"));
      if (v === "table") page.append(qTable(res));
      else if (v === "cards") page.append(questionCards(res));
      else page.append(renderList(res.map((r) => { return { virt: n.id + ">" + r, target: r }; }), 0, true));
    } else {
      page.append(h("div.res-meta", res.length + " results"));
      if (n.q.tag === "highlight") page.append(renderList(res.map((r) => { return { virt: n.id + ">" + r, target: r }; }), 0, true));
      else page.append(renderList(res.map((r) => { return { id: r }; }), 0, true));
    }
    if (!res.length) page.append(h("div.empty", "No nodes match this search right now. It updates by itself when a run starts, finishes or fails."));
    else if (isQ) page.append(h("div.empty", { style: "margin-top:18px" }, n.id === "sq:needs" ? "A live search is a node like any other: its children are computed from the query above. Opening a result marks it read, so it leaves this list. Drag the search into Today or a note to embed it there." : "A live search is a node: its children are computed from the query above and update as runs start and finish. Edit the query, switch the view, or drag it into a note to embed it."));
    return page;
  }
  function dayPage(n, page) {
    var isToday = n.date === TODAY;
    page.append(pageHeader(n, { meta: metaJoin([crumbLink("journal"), isToday ? "Today" : null, "Type anywhere below; questions you ask here are filed in " + N["ws:" + st.ws].name]) }));
    if (isToday && st.tip && !st.firstRun) page.append(h("div.tip",
      h("span.tip-i", { html: ic("book", 16) }),
      h("div", null, h("b", null, "Session runs the coding-agent CLIs on this Mac. "), "Each question you ask becomes a #question node; its answer streams in as child nodes that you can branch from, highlight, or reference in your notes."),
      h("button.btn", { onclick: () => { go("welcome"); } }, "Open the guide"),
      h("button.ib", { title: "Dismiss", html: ic("x", 14), onclick: () => { st.tip = false; render(); } })));
    if (isToday) { var cl = renderList([], 0, true); cl.append(composerRow(n.id, "Ask a new question…", {})); page.append(cl); }
    var list = renderList(n.children.map((c) => { return { id: c }; }), 0, true);
    list.append(h("div", {
      class: "addnode", onclick: () => {
        var nid = uid("i"); add({ id: nid, kind: "item", name: "", own: true });
        var at = n.children.length;
        for (var i = 0; i < n.children.length; i++) if (N[n.children[i]].kind === "search" && n.children[i].indexOf("sq:2") === 0) { at = i; break; }
        n.children.splice(at, 0, nid); N[nid].parent = n.id; st.focusKey = "ed:" + nid; render();
      },
    }, h("span.bul"), "Add a node"));
    page.append(list);
    return page;
  }
  function genericPage(n, page) {
    var meta = [];
    var fieldsEl = null;
    if (n.kind === "question") {
      var tn = threadOf(n.id);
      meta = metaJoin([tn ? crumbLink(tn.id) : null, n.turn.relation === "branch" ? "branch" : n.turn.relation === "followup" ? "follow-up" : "first question", "asked " + rel(n.turn.createdAt)]);
      if (CFG.fields === "inline") { fieldsEl = fieldStrip(n); fieldsEl.style.marginTop = "8px"; }
    } else if (n.kind === "para") {
      meta = metaJoin(["Answer paragraph ¶" + (n.idx + 1), crumbLink("q:" + n.turn.id)]);
    } else if (n.kind === "note") {
      meta = metaJoin([N["ws:" + n.ws].name, "note", "edited " + rel(n.updatedAt), "Tab / ⇧Tab to indent"]);
    } else if (n.kind === "source") {
      meta = metaJoin([h("span", null, n.domain), h("span", { style: "font-family:JetBrains Mono,ui-monospace,monospace;font-size:11.5px" }, clip(n.url, 64))]);
    } else if (n.kind === "draft") {
      meta = metaJoin(["Draft in " + N["ws:" + n.ws].name, "saved " + rel(n.draft.updatedAt)]);
    } else if (n.kind === "system") {
      meta = metaJoin([N["ws:" + n.ws].name, n.children.length + " nodes"]);
    }
    if (fieldsEl) fieldsEl.style.paddingLeft = "0";
    page.append(pageHeader(n, { meta: meta, fields: fieldsEl }));
    if (n.kind === "draft") {
      st.text["comp:" + n.id] = st.text["comp:" + n.id] != null && st.text["comp:" + n.id] !== "" ? st.text["comp:" + n.id] : n.name;
      var dl = renderList([], 0, true);
      dl.append(composerRow(n.id, "Edit the question…", {}));
      page.append(dl);
      return page;
    }
    if (n.kind === "question" && CFG.answers === "block") page.append(answerBlock(n));
    else {
      var list = renderList(n.children.map((c) => { return { id: c }; }), 0, true);
      if (n.kind === "para" && st.composers[n.id]) list.append(composerRow(n.id, "Ask about this paragraph…", { inherit: n.turn, cancel: () => { delete st.composers[n.id]; render(); } }));
      page.append(list);
    }
    if (n.own && n.kind !== "system") {
      page.append(h("div", {
        class: "addnode", onclick: () => {
          var nid = uid("i"); add({ id: nid, kind: "item", name: "", own: true }); push(n.id, nid); st.focusKey = "ed:" + nid; render();
        },
      }, h("span.bul"), "Add a node"));
    }
    if (n.kind === "para") {
      page.append(h("div", { style: "margin-top:10px;display:flex;gap:6px" },
        h("button.btn", { onclick: () => { st.composers[n.id] = true; st.focusKey = "comp:" + n.id; render(); } }, h("span", { html: ic("branch", 14) }), "Branch from this paragraph"),
        h("button.btn", { onclick: (e) => { addToMenu(e.currentTarget, n.id); } }, h("span", { html: ic("refadd", 14) }), "Add to…")));
    }
    if (n.kind === "source") {
      var cites = (n.refs || []).map((r) => { return r.turnId ? "q:" + r.turnId : "t:" + r.threadId; }).filter((k) => { return N[k]; });
      var box = h("div.refby", h("h4", null, "Cited by", h("span", null, String(cites.length))));
      box.append(renderList(cites.map((c) => { return { virt: "cite>" + c, target: c }; }), 0, true));
      page.append(box);
    } else if (["question", "para", "note", "highlight"].indexOf(n.kind) >= 0) page.append(referencedBy(n.id));
    return page;
  }

  /* first-run page */
  function welcomePage(n, page) {
    var wsn = N["ws:" + st.ws];
    page.append(pageHeader(n, { meta: metaJoin(["Getting started", "workspace " + wsn.name, h("span", { style: "font-family:JetBrains Mono,ui-monospace,monospace;font-size:12px" }, wsn.dir)]) }));
    page.append(h("p.lead", "Session runs the coding-agent CLIs already installed on this Mac and keeps each question, its answer, the tool trace and the sources as nodes in one outline. Each step below checks itself off when you do it."));
    var list = h("div.kids top");
    function step(id, title, done, kids, open) {
      var key = "step:" + id;
      var col = key in st.collapsed ? st.collapsed[key] : !open;
      var row = h("div.row", { "data-id": key },
        h("div.line",
          h("button", { class: "tog" + (col ? "" : " open"), html: ic("chev", 12), onclick: () => { st.collapsed[key] = !col; render(); } }),
          h("span", { class: "bul chk" + (done ? " done" : ""), html: "<span>" + (done ? ic("check", 11) : "") + "</span>" }),
          h("div", { class: "nm" + (done ? " done" : ""), style: "font-weight:500" }, title)));
      if (!col) row.append(h("div.kids", kids));
      list.append(row);
    }
    function txt(s, dim) { return h("div.row", h("div.line", h("span.bul para"), h("div", { class: "nm" + (dim ? " dim" : ""), html: s }))); }
    var ready = 1;
    step("agent", "Connect an agent", ready > 0, [
      h("div.flds", { style: "padding-left:0;margin:2px 0 4px" },
        h("div.agrow", h("span", null, h("span.agent-dot", { style: "--pc:var(--claude)" }), "Claude Code"), h("span.st", { style: "--sc:var(--s-ok);margin-left:0" }, "Ready"), h("span.muted", "Signed in. Models: fable, opus, sonnet.")),
        h("div.agrow", h("span", null, h("span.agent-dot", { style: "--pc:var(--codex)" }), "Codex"),
          st.codex === "ready" ? h("span.st", { style: "--sc:var(--s-ok);margin-left:0" }, "Ready") : st.codex === "waiting" ? h("span.st run", { style: "--sc:var(--s-run);margin-left:0" }, "Waiting for sign-in") : h("span.st", { style: "--sc:var(--s-run);margin-left:0" }, "Not signed in"),
          st.codex === "ready" ? h("span.muted", "Sign-in detected; no refresh needed. Models: gpt-6-astra, gpt-5.6-*.")
            : h("span", null, "Run ", h("code", null, "codex login"), " in Terminal", st.codex === "waiting" ? h("span.muted", " · checking every 2 s") : h("button", {
              class: "fbtn", onclick: () => {
                st.codex = "waiting"; toast("Copied: codex login. Session notices the sign-in by itself.");
                later(() => { st.codex = "ready"; toast("Codex is ready"); }, 3500);
              },
            }, h("span", { html: ic("copy", 12) }), "Copy"))),
        h("div.agrow", h("span", null, h("span.agent-dot", { style: "--pc:var(--grok)" }), "Grok"), h("span.st", { style: "--sc:var(--s-plain);margin-left:0" }, "Not installed"), h("span.muted", "Optional. Install the Grok CLI, then run ", h("code", null, "grok login"), "."))),
      txt("Status refreshes by itself every few seconds; you only need one agent to start.", true),
    ], true);
    var askKids = [txt("Type a question about the code in " + esc(wsn.dir) + ". Press ↵ to run it. The answer streams in as child nodes, with Status, Trace and Sources as fields.", true)];
    var asked = (N["task:ask"] && N["task:ask"].children) || [];
    if (!N["task:ask"]) add({ id: "task:ask", kind: "item", name: "Ask", own: true, parent: "welcome" });
    asked = N["task:ask"].children;
    if (!asked.length) askKids.push(h("div.sugg", ["Which files in this directory define the public API?", "Why does `npm test` take 40 seconds here?", "Summarize the open TODOs under `src/`"].map((s) => {
      return h("button", { onclick: () => { st.text["comp:task:ask"] = plain(s); st.focusKey = "comp:task:ask"; render(); } }, plain(s));
    })));
    askKids.push(renderList(asked.map((c) => { return { id: c }; }), 1, true));
    askKids.push(composerRow("task:ask", asked.length ? "Ask another question…" : "Ask a question…", {}));
    step("ask", "Ask your first question", st.tasks.ask, askKids, true);
    step("branch", "Follow up, or branch from a paragraph", st.tasks.branch, [
      txt("<b>Follow up</b> continues the same conversation: the new #question appears below the previous one, as its next sibling."),
      txt("<b>Branch</b> asks about one paragraph: hover a paragraph and choose Branch. The new #question nests under that paragraph, so the outline shows where every question came from."),
    ], st.tasks.ask);
    step("ref", "Keep what matters in a note", st.tasks.ref, [
      txt("Drag a paragraph by its bullet onto a note or Today in the sidebar, or use <b>Add to…</b>. The note gets a reference; the answer lists the note under Referenced by."),
      txt("Notes are plain outlines: ↵ adds a node, Tab and ⇧Tab indent and outdent, ⌘K searches every question, answer and note.", true),
    ], st.tasks.ask);
    page.append(list);
    if (st.firstRun) page.append(h("div.wfoot",
      h("button.btn", { onclick: openSamples }, h("span", { html: ic("box", 14) }), "Open the sample workspaces"),
      h("span", null, "Three example workspaces with finished, running and failed research.")));
    return page;
  }

  /* -- sidebar */
  function renderSide() {
    var side = h("div.side");
    side.append(h("div.tl", h("i"), h("i"), h("i")));
    var wsn = N["ws:" + st.ws];
    side.append(h("button.wsw", { title: "Switch workspace (⌘O)", onclick: (e) => { wsMenu(e.currentTarget); } },
      h("span.wsi", wsn.name.slice(0, 1)), h("span", { style: "min-width:0" }, h("b", null, wsn.name), h("small", null, wsn.dir)), h("span", { html: ic("down", 14) })));
    var sc = h("div.side-scroll");
    function si(id, label, icon, opts) {
      opts = opts || {};
      var on = st.page === id;
      var b = h("button", { class: "si" + (on ? " on" : ""), "data-side": id, onclick: () => { if (opts.run) opts.run(); else go(id); } });
      if (opts.depth) b.style.paddingLeft = (8 + opts.depth * 14) + "px";
      if (opts.tog) b.append(opts.tog);
      if (icon) b.insertAdjacentHTML("beforeend", ic(icon, 15));
      if (opts.bullet) b.append(opts.bullet);
      b.append(h("span.lbl", label));
      if (opts.count != null && opts.count !== 0) b.append(h("span", { class: "cnt" + (opts.att ? " att" : "") }, String(opts.count)));
      if (opts.drop) b.setAttribute("data-drop", id);
      return b;
    }
    sc.append(si("cmd", "Search", "search", { run: openCmd }));
    var sk = sc.lastChild; sk.append(h("kbd", null, "⌘K"));
    sc.append(si(DAY, "Today", "today", { drop: true }));
    if (st.firstRun) sc.append(si("welcome", "Welcome", "book"));
    sc.append(si("sq:needs", "Needs you", "inbox", { count: results(N["sq:needs"]).length, att: true }));
    sc.append(si("sq:running", "Running", "run", { count: results(N["sq:running"]).length }));
    sc.append(si("graph", "Graph", "graph"));
    var pins = Object.keys(N).filter((k) => { return N[k].pinned && N[k].ws === st.ws && visibleWs(N[k].ws); });
    if (pins.length) {
      sc.append(h("div.sh", "Pinned"));
      pins.forEach((k) => { sc.append(si(k, shortName(k), null, { bullet: h("span.sb", { style: "--tc:var(--c-" + N[k].tag + ")" }), drop: N[k].kind === "note" })); });
    }
    sc.append(h("div.sh", h("span", { style: "cursor:pointer", onclick: () => { go("ws:" + st.ws); } }, wsn.name), h("button", { title: "New note", html: ic("plus", 14), onclick: () => { var id = createNote(); st.focusKey = "ed:" + id; go(id); } })));
    var kids = wsn.children.filter((k) => { return N[k].kind !== "system" || N[k].children.length; });
    if (!kids.length) sc.append(h("div.s-empty", "No threads yet"));
    (function walk(list, depth) {
      list.forEach((k) => {
        var n = N[k];
        if (!n) return;
        if (n.kind === "ref") return;
        var expandable = n.kind === "folder" || n.kind === "system";
        var open = expandable && (k in st.sideOpen ? st.sideOpen[k] : n.kind === "folder");
        var tog = expandable ? h("span", { class: "stog" + (open ? " open" : ""), html: ic("chev", 11), onclick: (e) => { e.stopPropagation(); st.sideOpen[k] = !open; render(); } }) : h("span.stog");
        var bul = n.kind === "folder" || n.kind === "system" ? null : h("span", { class: "sb" + (n.kind === "thread" ? " ring" : ""), style: "--tc:var(--c-" + (n.tag || "folder") + ")" });
        var icon = n.kind === "folder" ? "hash" : n.kind === "system" ? (n.sys === "drafts" ? "draft" : "archive") : null;
        var cnt = n.kind === "folder" ? n.children.length : n.kind === "system" ? n.children.length : null;
        var tstatus = n.kind === "thread" ? threadStatus(n) : null;
        var el = si(k, n.kind === "draft" ? clip(n.name, 34) : shortName(k), icon, { depth: depth, tog: tog, bullet: bul, count: cnt, drop: n.kind === "note" || n.kind === "folder" });
        if (tstatus && tstatus !== "done") el.append(h("span", { class: "st" + (tstatus === "running" ? " run" : ""), style: "margin-left:0;--sc:var(--" + { running: "s-run", failed: "s-err", "needs-review": "s-att", queued: "s-plain" }[tstatus] + ")", title: STAT[tstatus].label }));
        sc.append(el);
        if (open) walk(n.children, depth + 1);
      });
    })(kids, 0);
    sc.append(h("div.sh", "Supertags"));
    [["question", "tag:question"], ["source", "tag:source"], ["note", "tag:note"], ["highlight", "tag:highlight"]].forEach((p) => {
      sc.append(si(p[1], "#" + p[0], null, { bullet: h("span.sb", { style: "--tc:var(--c-" + p[0] + ")" }), count: results(N[p[1]]).length }));
    });
    if (!st.firstRun) sc.append(h("div", { style: "height:6px" }), si("welcome", "Getting started", "book"));
    side.append(sc);
    side.append(h("div.side-foot", h("span.avatar", D.user.initials), h("span.who", D.user.name),
      h("button.ib", { title: "Settings (⌘,)", html: ic("gear", 15), onclick: () => { toast("Settings open in a separate window (⌘,)"); } })));
    return side;
  }

  /* -- top bar */
  function renderBar() {
    var bar = h("div.bar");
    bar.append(h("button.ib", { title: "Back (⌘[)", html: ic("left", 16), disabled: !st.back.length, onclick: back }));
    bar.append(h("button.ib", { title: "Forward (⌘])", html: ic("right", 16), disabled: !st.fwd.length, onclick: fwd }));
    var cr = h("div.crumbs", { "aria-label": "Breadcrumbs" });
    var chain = ancestors(st.page).filter((a) => { return N[a].kind !== "root"; });
    if (N[st.page].kind === "thread" || N[st.page].kind === "folder") chain = chain.filter(Boolean);
    chain.forEach((a) => {
      cr.append(h("button", { onclick: () => { go(a); } }, shortName(a)), h("span.sep", "›"));
    });
    cr.append(h("button.cur", shortName(st.page)));
    bar.append(cr);
    bar.append(h("button.kbtn", { onclick: openCmd }, h("span", { html: ic("search", 14) }), "Search or run a command", h("kbd", null, "⌘K")));
    bar.append(h("button", { class: "ib" + (st.panel ? " on" : ""), title: "Node panel", html: ic("panel", 16), onclick: () => { st.panel = !st.panel; render(); } }));
    return bar;
  }

  /* -- side panel */
  function selNodeId() {
    var key = st.sel;
    if (!key) return st.page;
    var el = app.querySelector('[data-id="' + cssEsc(key) + '"]');
    if (el && el.getAttribute("data-node")) return el.getAttribute("data-node");
    if (N[key]) return N[key].kind === "ref" ? N[key].target : key;
    var p = key.split(">");
    return N[p[p.length - 1]] ? p[p.length - 1] : st.page;
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }
  function renderPanel() {
    var id = st._panelId || selNodeId();
    var n = N[id] || N[st.page];
    var p = h("div.pnl");
    p.append(h("div.pnl-h", h("span", { html: ic("panel", 14) }), h("b", null, "Node"), h("span", { style: "flex:1" }),
      h("button.ib", { title: "Zoom in", html: ic("refadd", 14), onclick: () => { reveal(n.id); } }),
      h("button.ib", { title: "Close panel", html: ic("x", 14), onclick: () => { st.panel = false; render(); } })));
    var b = h("div.pnl-b");
    var tagName = n.tag || (n.kind === "para" ? null : null);
    if (tagName) b.append(tagChip(tagName));
    if (n.kind === "para") {
      b.append(h("div.pnl-s", { style: "margin-top:0" }, "Answer paragraph ¶" + (n.idx + 1)));
      b.append(h("div.pnl-t para", { html: paraHtml(n) }));
      b.append(h("div.pnl-s", "From"));
      b.append(panelItem("q:" + n.turn.id, "question"));
      var hls = n.turn.highlights.filter((x) => { return x.paragraph === n.idx; });
      if (hls.length) {
        b.append(h("div.pnl-s", "Highlights"));
        hls.forEach((x) => { b.append(h("div.hq", { style: "--hlc:var(--c-highlight)" }, plain(x.quote), x.note ? h("small", null, x.note) : null)); });
      }
      var br = n.children.filter((c) => { return N[c].kind === "question"; });
      b.append(h("div.pnl-s", "Branches", h("span", null, String(br.length))));
      if (br.length) br.forEach((c) => { b.append(panelItem(c, "branch")); });
      else b.append(h("div.hint", "None. Hover the paragraph and choose Branch."));
    } else if (n.kind === "question") {
      var u = n.turn;
      b.append(h("div.pnl-t", u.title));
      b.append(h("div.hint", { style: "margin-bottom:4px", html: md(u.question) }));
      b.append(h("div.pnl-s", "Fields"));
      b.append(fld("Agent", agentValue(u), "box"));
      b.append(fld("Status", statusChip(u.status), "run"));
      b.append(fld("Asked", rel(u.createdAt), "today"));
      if (u.durationSec) b.append(fld("Duration", dur(u.durationSec), "run"));
      b.append(fld("Relation", u.relation === "root" ? "First question" : u.relation === "branch" ? "Branch from ¶" + ((u.anchor && u.anchor.paragraph) + 1) : "Follow-up", "branch"));
      if (u.clarification && u.status === "needs-review") { b.append(h("div.pnl-s", "Agent asks")); b.append(h("div.fv", h("span.ask-agent", u.clarification), replyBox(n))); }
      if (u.error) { b.append(h("div.pnl-s", "Error")); b.append(h("div.fv", h("span.err", u.error))); }
      b.append(h("div.pnl-s", "Trace", h("span", null, u.activity.length + " steps")));
      b.append(u.activity.length ? stepsEl(u.activity) : h("div.hint", "No tool calls yet."));
      b.append(h("div.pnl-s", "Sources", h("span", null, String(u.sources.length))));
      if (u.sources.length) b.append(h("div.plist", u.sources.map((s) => { return h("div.pi", { onclick: () => { go(srcByUrl[s.url]); } }, h("span", { html: ic("globe", 14) }), h("span", null, s.title, h("small", null, s.domain))); })));
      else b.append(h("div.hint", "No sources cited."));
      if (u.highlights.length) {
        b.append(h("div.pnl-s", "Highlights", h("span", null, String(u.highlights.length))));
        u.highlights.forEach((x) => { b.append(h("div.hq", { style: "--hlc:var(--c-highlight)" }, plain(x.quote), x.note ? h("small", null, x.note) : null)); });
      }
      panelRefs(b, n.id);
    } else if (n.kind === "thread") {
      b.append(h("div.pnl-t", n.name));
      b.append(h("div.pnl-s", "Fields"));
      b.append(fld("Status", statusChip(threadStatus(n)), "run"));
      b.append(fld("Questions", String(questionsIn(n.id).length), "outline"));
      b.append(fld("Pinned", n.pinned ? "Yes" : "No", "pin"));
      b.append(fld("Notify", n.notify ? "On replies" : "Off", "inbox"));
      if (n.thread.recap) { b.append(h("div.pnl-s", "Recap")); b.append(h("div.hint", { style: "color:var(--tx2)" }, n.thread.recap)); }
      panelRefs(b, n.id);
    } else {
      b.append(h("div.pnl-t", shortName(n.id)));
      b.append(h("div.hint", { style: "margin-top:8px" }, "Select a #question or an answer paragraph to see its fields, trace, sources and references here."));
    }
    p.append(b);
    return p;
  }
  function panelItem(id, kind) {
    var n = N[id];
    return h("div.plist", h("div.pi", { onclick: () => { reveal(id); } }, h("span", { html: ic(kind === "branch" ? "branch" : "reply", 14) }), h("span", null, n.turn.title, h("small", null, STAT[n.turn.status] ? STAT[n.turn.status].label : n.turn.status))));
  }
  function panelRefs(b, id) {
    var refs = refsTo([id].concat(descendants(id)));
    b.append(h("div.pnl-s", "Referenced by", h("span", null, String(refs.length))));
    if (!refs.length) b.append(h("div.hint", "Not referenced yet."));
    else b.append(h("div.plist", refs.map((r) => {
      var x = N[r.id];
      return h("div.pi", { onclick: () => { reveal(r.id); } }, h("span", { html: ic("note", 14) }), h("span", null, x.kind === "item" ? x.name : clip(displayName(r.target), 70), h("small", null, r.owner ? r.owner.name : "")));
    })));
  }

  /* -- menu / command line */
  function renderMenu() {
    var m = h("div.menu", { style: "left:" + st.menu.x + "px;top:" + st.menu.y + "px", role: "menu" });
    st.menu.items.forEach((it) => {
      if (it.sep) { m.append(h("div.msep")); return; }
      if (it.header) { m.append(h("div.mhd", it.header)); return; }
      m.append(h("button", {
        class: "mi" + (it.chk ? " chk" : ""), role: "menuitem",
        onclick: (e) => { e.stopPropagation(); st.menu = null; it.run && it.run(); render(); },
      }, it.icon ? h("span", { html: ic(it.icon, 14) }) : null, h("span", null, it.label), it.hint ? h("span.mh", it.hint) : null));
    });
    return m;
  }
  function openCmd() { st.cmd = { q: "", i: 0 }; st.menu = null; st.focusKey = "cmd"; render(); }
  function cmdItems(q) {
    var ql = q.trim().toLowerCase();
    var pg = N[st.page];
    var cmds = [
      { label: "Ask a new question", hint: "Today", icon: "plus", run: () => { st.focusKey = "comp:" + DAY; go(DAY); } },
      { label: "Go to Today", icon: "today", run: () => { go(DAY); } },
      { label: "Open Needs you", icon: "inbox", run: () => { go("sq:needs"); } },
      { label: "Open Running", icon: "run", run: () => { go("sq:running"); } },
      { label: "All #question as a table", icon: "table", run: () => { st.views["tag:question"] = "table"; go("tag:question"); } },
      { label: "New note", icon: "note", run: () => { var id = createNote(); st.focusKey = "ed:" + id; go(id); } },
      { label: "Toggle node panel", icon: "panel", run: () => { st.panel = !st.panel; } },
      { label: "New workspace…", icon: "box", run: () => { st.ws = newWorkspace("Untitled"); st.firstRun = true; go("welcome"); } },
    ];
    if (pg && pg.kind !== "search") cmds.splice(1, 0, { label: "Summarize children of “" + clip(shortName(pg.id), 40) + "”", icon: "sum", run: () => { summarize(pg.id); } });
    var c = cmds.filter((x) => { return !ql || x.label.toLowerCase().indexOf(ql) >= 0; });
    var nodes = [];
    if (ql) {
      var words = ql.split(/\s+/).filter(Boolean);
      Object.keys(N).forEach((k) => {
        var n = N[k];
        if (["thread", "question", "para", "note", "item", "source", "draft", "hlnote", "folder"].indexOf(n.kind) < 0) return;
        if (n.ws && !visibleWs(n.ws)) return;
        var text = n.kind === "question" ? n.turn.title + " " + plain(n.turn.question) : n.kind === "para" ? plain(n.text) : n.kind === "source" ? n.name + " " + n.domain : plain(n.name || "");
        var tl = text.toLowerCase();
        if (!words.every((w) => { return tl.indexOf(w) >= 0; })) return;
        var score = { thread: 0, note: 1, question: 2, folder: 2, draft: 3, source: 4, item: 5, hlnote: 5, para: 6 }[n.kind];
        nodes.push({ id: k, text: text, score: score, at: tl.indexOf(words[0]) });
      });
      nodes.sort((a, b) => { return a.score - b.score; });
    }
    return { cmds: c.slice(0, ql ? 3 : 9), nodes: nodes.slice(0, 8), words: ql.split(/\s+/).filter(Boolean) };
  }
  function hiText(text, words, at) {
    var start = Math.max(0, at - 40);
    var s = (start ? "…" : "") + text.slice(start, start + 140);
    var html = esc(s);
    words.forEach((w) => { if (w.length > 1) html = html.replace(new RegExp("(" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig"), "<b>$1</b>"); });
    return html;
  }
  function renderCmdList() {
    var r = cmdItems(st.cmd.q);
    var list = h("div.cmd-list");
    var flat = [];
    if (r.cmds.length) {
      list.append(h("div.cmd-sec", "Commands"));
      r.cmds.forEach((c) => { flat.push(c); });
    }
    var idx = 0;
    r.cmds.forEach((c) => {
      var i = idx++;
      list.append(h("div", { class: "ci" + (st.cmd.i === i ? " on" : ""), onclick: () => { runCmd(c); }, onmousemove: () => { if (st.cmd.i !== i) { st.cmd.i = i; refreshCmd(); } } },
        h("span", { html: ic(c.icon || "chev", 15) }), h("div.cbody", h("span", null, c.label)), c.hint ? h("span.mh", c.hint) : null));
    });
    if (r.nodes.length) list.append(h("div.cmd-sec", "Nodes"));
    r.nodes.forEach((nd) => {
      var i = idx++;
      var n = N[nd.id];
      var c = { run: () => { reveal(nd.id); } };
      flat.push(c);
      var crumbs = ancestors(nd.id).filter((a) => { return ["workspace", "folder", "thread", "note", "day"].indexOf(N[a].kind) >= 0; }).map(shortName).join(" › ");
      var tag = n.kind === "para" ? null : n.kind === "item" || n.kind === "hlnote" ? null : n.kind === "draft" ? "question" : n.tag;
      list.append(h("div", { class: "ci" + (st.cmd.i === i ? " on" : ""), onclick: () => { runCmd(c); }, onmousemove: () => { if (st.cmd.i !== i) { st.cmd.i = i; refreshCmd(); } } },
        tag ? tagChip(tag) : h("span", { html: ic(n.kind === "para" ? "outline" : "chev", 15) }),
        h("div.cbody", h("span", { html: hiText(nd.text, r.words, nd.at) }), h("small", null, (n.kind === "para" ? "Answer ¶" + (n.idx + 1) + " · " : "") + crumbs))));
    });
    if (!flat.length) list.append(h("div.cmd-sec", { style: "font-weight:400" }, "No nodes or commands match “" + st.cmd.q + "”."));
    st.cmd.flat = flat;
    return list;
  }
  function refreshCmd() { var l = app.querySelector(".cmd-list"); if (l) l.replaceWith(renderCmdList()); }
  function runCmd(c) { st.cmd = null; c.run(); render(); }
  function renderCmd() {
    var input = h("input", { "data-key": "cmd", placeholder: "Search questions, answers, notes and sources, or run a command", "aria-label": "Command line" });
    input.value = st.cmd.q;
    input.addEventListener("input", () => { st.cmd.q = input.value; st.cmd.i = 0; refreshCmd(); });
    input.addEventListener("keydown", (e) => {
      var n = (st.cmd.flat || []).length;
      if (e.key === "ArrowDown") { e.preventDefault(); st.cmd.i = Math.min(n - 1, st.cmd.i + 1); refreshCmd(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); st.cmd.i = Math.max(0, st.cmd.i - 1); refreshCmd(); }
      else if (e.key === "Enter") { e.preventDefault(); var c = st.cmd.flat[st.cmd.i]; if (c) runCmd(c); }
      else if (e.key === "Escape") { e.preventDefault(); st.cmd = null; render(); }
    });
    var box = h("div.cmd", { role: "dialog", "aria-label": "Command line", onclick: (e) => { e.stopPropagation(); } },
      h("div.cmd-in", h("span", { html: ic("search", 17) }), input, h("kbd", null, "esc")),
      renderCmdList(),
      h("div.cmd-foot", h("span", null, h("kbd", null, "↑↓"), "move"), h("span", null, h("kbd", null, "↵"), "open"), h("span", null, h("kbd", null, "⌘K"), "toggle"), h("span", { style: "margin-left:auto" }, "Searches every workspace's text, not only titles")));
    return h("div.cmd-wrap", { onclick: () => { st.cmd = null; render(); } }, box);
  }

  /* -- render root */
  var app = h("div.app", { tabindex: "-1" });
  root.appendChild(app);

  function captureFocus() {
    var a = document.activeElement;
    if (!a || !app.contains(a)) return null;
    var key = a.getAttribute && a.getAttribute("data-key");
    if (!key) return { app: a === app };
    var off = null;
    if (a.tagName === "TEXTAREA" || a.tagName === "INPUT") off = [a.selectionStart, a.selectionEnd];
    else {
      var s = window.getSelection();
      if (s && s.rangeCount && a.contains(s.anchorNode)) off = s.anchorOffset;
    }
    return { key: key, off: off };
  }
  function placeCaret(el, off) {
    el.focus({ preventScroll: true });
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      var L = el.value.length;
      if (Array.isArray(off)) el.setSelectionRange(Math.min(off[0], L), Math.min(off[1], L)); else el.setSelectionRange(L, L);
      return;
    }
    var r = document.createRange();
    var t = el.firstChild;
    if (t && t.nodeType === 3 && typeof off === "number") { r.setStart(t, Math.min(off, t.length)); r.collapse(true); }
    else { r.selectNodeContents(el); r.collapse(false); }
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function render() {
    if (gone) return;
    var foc = captureFocus();
    var sc = app.querySelector(".scroll");
    var top = sc && !st._resetScroll ? sc.scrollTop : 0;
    var ss = app.querySelector(".side-scroll");
    var stop = ss ? ss.scrollTop : 0;
    st._panelId = null;
    app.replaceChildren();
    app.className = "app" + (st.panel ? " with-panel" : "");
    var main = h("div.main", renderBar(), h("div.scroll", renderPage()));
    app.append(renderSide(), main);
    if (st.panel) app.append(renderPanel());
    if (st.menu) app.append(renderMenu());
    if (st.cmd) app.append(renderCmd());
    if (st.toast) app.append(h("div.toast", { role: "status" }, st.toast));
    var sc2 = app.querySelector(".scroll"); if (sc2) sc2.scrollTop = top;
    var ss2 = app.querySelector(".side-scroll"); if (ss2) ss2.scrollTop = stop;
    st._resetScroll = false;
    app.querySelectorAll("textarea").forEach(grow);
    var fk = st.focusKey;
    if (fk) {
      st.focusKey = null;
      var el = app.querySelector('[data-key="' + cssEsc(fk) + '"]');
      if (el) { placeCaret(el, null); if (!st.cmd) el.scrollIntoView({ block: "nearest" }); }
    } else if (foc && foc.key) {
      var el2 = app.querySelector('[data-key="' + cssEsc(foc.key) + '"]');
      if (el2) placeCaret(el2, foc.off);
    } else if (foc && foc.app) app.focus({ preventScroll: true });
    if (st.scrollTo) {
      var t = app.querySelector('.page [data-node="' + cssEsc(st.scrollTo) + '"]');
      if (t) t.scrollIntoView({ block: "center" });
      st.scrollTo = null;
    }
    if (st.flash) { var f = st.flash; later(() => { if (st.flash === f) st.flash = null; }, 1700); }
  }

  /* -- events */
  function setSel(key) {
    st.sel = key;
    app.querySelectorAll(".row.sel").forEach((r) => { r.classList.remove("sel"); });
    if (key) {
      var el = app.querySelector('.page [data-id="' + cssEsc(key) + '"]');
      if (el) el.classList.add("sel");
    }
    if (st.panel) { var p = app.querySelector(".pnl"); if (p) p.replaceWith(renderPanel()); }
  }
  function visibleRows() { return Array.prototype.slice.call(app.querySelectorAll(".page .row[data-id]")).filter((r) => { return !r.classList.contains("comp"); }); }
  function moveSel(d) {
    var rows = visibleRows();
    var i = rows.findIndex((r) => { return r.getAttribute("data-id") === st.sel; });
    var j = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + d));
    if (rows[j]) { setSel(rows[j].getAttribute("data-id")); rows[j].scrollIntoView({ block: "nearest" }); }
  }
  function selCollapse(v) {
    if (!st.sel) return;
    var el = app.querySelector('.page [data-id="' + cssEsc(st.sel) + '"] > .line > .tog');
    if (!el) return;
    st.collapsed[st.sel] = v;
    render();
  }
  function onClick(e) {
    var t = e.target;
    if (menuFresh) { menuFresh = false; return; }
    if (st.menu && !t.closest(".menu")) { st.menu = null; render(); return; }
    var row = t.closest(".page .row[data-id]");
    if (row && !t.closest("button, textarea, input, a, .tag, .rpill, .src")) {
      var key = row.getAttribute("data-id");
      if (st.sel !== key) setSel(key);
      if (!t.isContentEditable) app.focus({ preventScroll: true });
    }
  }
  /* selection bar: select words inside an answer paragraph */
  function removeSelBar() { var b = app.querySelector(".selbar"); if (b) b.remove(); }
  function onMouseUp(e) {
    if (e.target.closest && e.target.closest(".selbar")) return;
    removeSelBar();
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    function host(x) { x = x && (x.nodeType === 3 ? x.parentElement : x); return x && x.closest ? x.closest("[data-para]") : null; }
    var pe = host(sel.anchorNode);
    if (!pe || pe !== host(sel.focusNode) || !app.contains(pe)) return;
    var pid = pe.getAttribute("data-para"), n = N[pid];
    if (!n || n.turn.status === "running") return;
    var text = String(sel).replace(/\s+/g, " ").trim();
    var quote = text.length > 2 ? rawQuote(n, text) : null;
    if (!quote) return;
    var r = sel.getRangeAt(0).getBoundingClientRect(), ar = app.getBoundingClientRect();
    var k = ar.width / app.offsetWidth || 1;
    var x = Math.min(1280 - 330, Math.max(250, (r.left + r.width / 2 - ar.left) / k - 150)), y = (r.top - ar.top) / k - 42;
    function b(label, icon, fn) {
      return h("button.ab", { onmousedown: (e) => { e.preventDefault(); }, onclick: (e) => { e.stopPropagation(); fn(e); removeSelBar(); } }, h("span", { html: ic(icon, 13) }), label);
    }
    app.append(h("div.selbar", { role: "toolbar", "aria-label": "Selection", style: "left:" + x + "px;top:" + Math.max(46, y) + "px" },
      b("Branch", "branch", () => { openBranch(n, quote); }),
      b("Highlight", "hl", () => { highlightPara(n, quote); window.getSelection().removeAllRanges(); render(); }),
      b("Add to…", "refadd", (e) => { addToMenu(e.currentTarget, pid); }),
      b("Copy", "copy", () => { toast("Copied " + clip(text, 40)); })));
  }
  function onCtx(e) {
    var row = e.target.closest && e.target.closest(".page .row[data-node]");
    if (!row || e.target.closest("textarea, [contenteditable]")) return;
    e.preventDefault();
    setSel(row.getAttribute("data-id"));
    nodeMenu(pointAnchor(e.clientX, e.clientY), row.getAttribute("data-node"));
  }
  function onKey(e) {
    var meta = e.metaKey || e.ctrlKey;
    var t = e.target;
    if (meta && (e.key === "k" || e.key === "K")) { e.preventDefault(); if (st.cmd) { st.cmd = null; render(); } else openCmd(); return; }
    if (st.cmd) return;
    if (e.key === "Escape") {
      if (st.menu) { st.menu = null; render(); return; }
      if (t.isContentEditable || t.tagName === "TEXTAREA") { t.blur(); app.focus({ preventScroll: true }); return; }
      if (st.sel) { setSel(null); return; }
      return;
    }
    if (t.tagName === "TEXTAREA") {
      if (e.key === "Enter" && !e.shiftKey && t.getAttribute("data-cid")) { e.preventDefault(); submit(t.getAttribute("data-cid"), t.value); }
      return;
    }
    if (t.tagName === "INPUT") return;
    if (t.isContentEditable) { editKey(e, t); return; }
    if (meta && e.key === "[") { e.preventDefault(); back(); return; }
    if (meta && e.key === "]") { e.preventDefault(); fwd(); return; }
    if (!st.sel) { if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); } return; }
    if (e.key === "ArrowDown" && !meta) { e.preventDefault(); moveSel(1); }
    else if (e.key === "ArrowUp" && !meta) { e.preventDefault(); moveSel(-1); }
    else if ((e.key === "ArrowDown" && meta) || e.key === "ArrowRight") { e.preventDefault(); selCollapse(false); }
    else if ((e.key === "ArrowUp" && meta) || e.key === "ArrowLeft") { e.preventDefault(); selCollapse(true); }
    else if (e.key === "Enter") {
      e.preventDefault();
      var id = st.sel;
      if (N[id] && canEdit(id)) { st.focusKey = "ed:" + id; render(); }
      else { var el = app.querySelector('.page [data-id="' + cssEsc(id) + '"]'); var nid = el && el.getAttribute("data-node"); if (nid) go(nid); }
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (N[st.sel] && (e.shiftKey ? outdent(st.sel) : indent(st.sel))) render();
    }
  }
  function editKey(e, t) {
    var id = t.getAttribute("data-edit");
    if (!id) { if (e.key === "Enter") { e.preventDefault(); t.blur(); } return; }
    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey ? outdent(id) : indent(id)) { st.focusKey = null; render(); }
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      var nid = newSibling(id);
      st.focusKey = "ed:" + nid; render();
    } else if (e.key === "Backspace" && !t.textContent) {
      e.preventDefault();
      var eds = Array.prototype.slice.call(app.querySelectorAll(".page [data-edit]"));
      var i = eds.indexOf(t);
      var prev = eds[i - 1];
      removeNode(id);
      st.focusKey = prev ? prev.getAttribute("data-key") : null;
      render();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      var all = Array.prototype.slice.call(app.querySelectorAll(".page [data-edit]"));
      var j = all.indexOf(t) + (e.key === "ArrowUp" ? -1 : 1);
      if (all[j]) { e.preventDefault(); placeCaret(all[j], null); }
    }
  }
  /* drag and drop: drag any bullet onto a note/Today (sidebar) or an outline row in your own notes */
  function dropTarget(t) {
    var si = t.closest && t.closest(".si[data-drop]");
    if (si) return { side: si.getAttribute("data-drop"), el: si };
    var row = t.closest && t.closest(".page .row[data-id]");
    if (row) {
      var nid = row.getAttribute("data-id");
      if (N[nid] && N[nid].own && N[nid].kind !== "hlnote") return { row: nid, el: row };
    }
    return null;
  }
  function onDragStart(e) {
    var b = e.target.closest && e.target.closest("[data-drag]");
    if (!b) return;
    st.drag = b.getAttribute("data-drag");
    try { e.dataTransfer.setData("text/plain", st.drag); e.dataTransfer.effectAllowed = "copyMove"; } catch (x) { /* ignore */ }
  }
  var lastDrop = null;
  var menuFresh = false;
  function clearDrop() { if (lastDrop) lastDrop.classList.remove("drop"); lastDrop = null; }
  function onDragOver(e) {
    if (!st.drag) return;
    var d = dropTarget(e.target);
    if (!d || d.row === st.drag) { clearDrop(); return; }
    e.preventDefault();
    if (lastDrop !== d.el) { clearDrop(); d.el.classList.add("drop"); lastDrop = d.el; }
  }
  function onDrop(e) {
    var d = dropTarget(e.target);
    clearDrop();
    var src = st.drag;
    st.drag = null;
    if (!d || !src || !N[src]) return;
    e.preventDefault();
    if (d.side) {
      var tgt = N[d.side];
      if (tgt.kind === "folder" && N[src].kind === "thread") { moveThread(src, d.side); return; }
      if (tgt.kind === "folder") { toast("Folders hold threads. Drop paragraphs on a note or Today."); return; }
      addRefTo(d.side, src);
    } else if (d.row) {
      var row = N[d.row], p = N[row.parent];
      var s = N[src];
      if (s.own && s.kind === "item" && N[s.parent] && N[s.parent].own) {
        N[s.parent].children.splice(N[s.parent].children.indexOf(src), 1);
        p.children.splice(p.children.indexOf(d.row) + 1, 0, src); s.parent = p.id;
      } else {
        var rid = uid("r");
        add({ id: rid, kind: "ref", target: s.kind === "ref" ? s.target : src, own: true });
        p.children.splice(p.children.indexOf(d.row) + 1, 0, rid); N[rid].parent = p.id;
        st.tasks.ref = true;
        toast("Reference added");
      }
      render();
    }
  }
  function onDragEnd() { st.drag = null; clearDrop(); }

  app.addEventListener("click", onClick);
  app.addEventListener("keydown", onKey);
  app.addEventListener("dragstart", onDragStart);
  app.addEventListener("dragover", onDragOver);
  app.addEventListener("drop", onDrop);
  app.addEventListener("dragend", onDragEnd);
  app.addEventListener("mouseup", onMouseUp);
  app.addEventListener("contextmenu", onCtx);

  if (V === "b") st.collapsed["p:t1q1:2"] = false;
  render();

  return function cleanup() {
    gone = true;
    timers.forEach(clearTimeout);
    app.removeEventListener("click", onClick);
    app.removeEventListener("keydown", onKey);
    app.removeEventListener("dragstart", onDragStart);
    app.removeEventListener("dragover", onDragOver);
    app.removeEventListener("drop", onDrop);
    app.removeEventListener("dragend", onDragEnd);
    app.removeEventListener("mouseup", onMouseUp);
    app.removeEventListener("contextmenu", onCtx);
    if (app.parentNode) app.parentNode.removeChild(app);
  };
}

window.SessionMocks.register({
  id: "tana",
  round: 2,
  name: "Outline & Supertags",
  reference: "Tana",
  summary: "Session as one infinite outline. A thread is a page and each ask is a #question node. The answer's paragraphs are its child nodes, a follow-up is the next sibling, and a branch nests under the paragraph it came from. Compact fields, live searches, views, references and a graph turn the research into a knowledge base.",
  principles: [
    "Everything is a node with a bullet. Click a bullet to zoom in (breadcrumbs above), click the chevron to collapse, drag a bullet to reference the node elsewhere.",
    "Supertags give nodes typed fields. #question shows Agent, Status, Trace and Sources on one compact line, which expands in place. The model that answered is always visible.",
    "Tree shape is literal and labelled. A follow-up is the next sibling, a branch is a child of the paragraph it asks about (\"branch from ¶3\"), and a comparison is a sibling with another model. \"Questions only\" and Graph show the shape at a glance.",
    "Selection-driven commands, as in Tana. Select words in an answer to Branch from them, Highlight them or Add them to a note. Right-click and the … button open the same menu.",
    "Live search nodes replace trays: Needs you, Running, All #question. Each shows as Outline, Table or Cards.",
    "One keep-mark per scope. Pin replaces Bookmark and Star; a highlight is a reference to a passage, with an optional child note; Follow becomes the Notify field.",
    "Vocabulary: a workspace is a directory on disk, a folder is a parent node inside it, a thread is a page, a question is one #question node. Ask only, no Post.",
  ],
  chat: "Type in any Ask node (Today, a workspace, the bottom of a thread) and press ↵. A #question node appears; its field line shows the agent, Running with elapsed time, and the current tool call, and the answer streams in as child nodes. Running answers have Stop, and stopped or failed ones have Retry. Follow up asks below (queued, with the reason shown, while the thread is busy). Branch works from a paragraph or a text selection. Compare re-asks the same question with another model.",
  knowledge: "Answer paragraphs are ordinary nodes. Drag one into a note or onto Today, or use Add to…, and it appears there as a quoted reference while the answer lists the note under Referenced by. Notes are free outlines (↵, Tab, ⇧Tab). Live searches and Table/Cards views query #question, #source, #note and #highlight across workspaces. The Graph view draws threads and notes with their links and references.",
  firstRun: "A new, empty workspace opens on a Welcome outline of four steps that check themselves off. Step 1 shows each agent's status and detects a sign-in on its own. Step 2 is an inline Ask node with suggestions. Steps 3 and 4 explain follow-up versus branch and how to keep a paragraph in a note. Other variants open Today with a dismissible one-line explanation and a link to the guide.",
  changes: [
    "Fields under each question shrink from four stacked rows to one inline line (Agent · Status · Trace · Sources) that expands in place. Thread pages are about 40% shorter, and the full field rows remain when you zoom into a question or open the panel.",
    "Added run control. Running answers get Stop (new Stopped state, partial answer kept), stopped or failed answers get Retry, and Compare re-asks the same question with another model as a labelled sibling.",
    "Added a selection bar. Selecting words in an answer offers Branch, Highlight, Add to… and Copy, so branch anchors and highlights use the exact passage instead of the paragraph's first sentence.",
    "Follow-ups, branches and comparisons are now labelled in the outline, and threads gain a \"Questions only\" view that shows the tree shape (UX-08, UX-09).",
    "Replaced the weak variant d (Workspace table, which only changed the default view) with f, Graph home: a force-laid graph of threads and notes, also available as a Graph view on every workspace.",
    "Right-click and the … button open the same per-node menu on questions, paragraphs, threads, notes and items (UX-07).",
    "First-run fixes: Codex sign-in is detected without a refresh (UX-13), and Today in the other variants has a dismissible one-line explanation with a link to the guide (UX-01).",
    "Polish: paragraph references render as quotes, Needs-you results show the run's detail line (for example the AccessDenied error), the anchor underline shows across code spans, chips no longer indent when a title wraps, and the file is under 170 KB.",
  ],
  variants: [
    { id: "a", name: "Journal home", note: "Opens on Today: a daily page with an Ask node, the Needs-you live search, your own capture outline and the questions asked today." },
    { id: "b", name: "Node panel", note: "Fields, trace, sources and backlinks move to a right panel for the selected node; the outline shows only text, tags and status." },
    { id: "c", name: "Answer blocks", note: "Each answer renders as one framed block under its question, closer to a chat transcript; branches follow the block with their anchor quote." },
    { id: "e", name: "First run", note: "A new, empty workspace opens on the Welcome outline, a tutorial the user completes by asking, branching and referencing." },
    { id: "f", name: "Graph home", note: "Opens on the Graph: every thread and note across workspaces as a point, with links and note references. Click a point to open it." },
  ],
  fonts: "family=Inter:wght@400;500;600;650;700&family=JetBrains+Mono:wght@400;500",
  css: CSS.replace(/@(?=[ [])/g, S),
  mount: mount,
});
})();
