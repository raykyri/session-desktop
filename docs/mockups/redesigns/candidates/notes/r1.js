/*
 * Session redesign candidate "notes", round 1.
 * Reference: Apple Notes (macOS). Everything is a note: a research thread is a note in which
 * questions are written as body text and answers appear inline beneath them in a quiet block.
 */
(function () {
  "use strict";
  const SC = "m-notes-r1";
  const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Helvetica Neue", Arial, sans-serif';
  const MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';

  /* ------------------------------------------------------------------ CSS */
  const CSS = `
.S{--side:#e9e9e8;--side-ink:#262626;--side-sel:rgba(0,0,0,.085);--list:#fff;--paper:#fff;--bar:#fff;
--ink:#1d1d1f;--ink2:#6e6e73;--ink3:#a1a1a6;--hair:rgba(0,0,0,.085);--hair2:rgba(0,0,0,.14);
--acc:#e3ad00;--acc-ink:#9a7100;--acc-soft:rgba(227,173,0,.14);--sel:#fde59a;--sel-ink:#1d1d1f;
--ans-rule:#efcd55;--ans-ink:#3a3a3d;--code:rgba(0,0,0,.055);--chip:rgba(0,0,0,.05);--chip-h:rgba(0,0,0,.09);
--pop:#f8f8f7;--pop-sh:0 12px 32px rgba(0,0,0,.16),0 0 0 .5px rgba(0,0,0,.2);--field:rgba(0,0,0,.055);
--err:#c9252d;--err-bg:rgba(201,37,45,.06);--warn:#b65a00;--warn-bg:rgba(230,126,0,.08);--ok:#25883c;--run:#9a7100;
--hl-amber:rgba(255,204,0,.42);--hl-green:rgba(52,199,89,.26);--hl-blue:rgba(10,132,255,.18);--hl-pink:rgba(255,55,95,.18);
--card:#fff;--thumb:#f4f4f3;--shadow-card:0 0 0 .5px rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.07);
position:relative;width:100%;height:100%;overflow:hidden;font:13px/1.4 ${FONT};color:var(--ink);background:var(--paper);
-webkit-font-smoothing:antialiased;letter-spacing:-.003em;outline:none}
.S[data-theme="dark"]{--side:#2b2a28;--side-ink:#e7e5e1;--side-sel:rgba(255,255,255,.1);--list:#1f1e1c;--paper:#1c1b1a;--bar:#1f1e1c;
--ink:#ecebe7;--ink2:#a3a09a;--ink3:#6f6c67;--hair:rgba(255,255,255,.075);--hair2:rgba(255,255,255,.13);
--acc:#f5c518;--acc-ink:#f0c33a;--acc-soft:rgba(245,197,24,.13);--sel:#5e4b16;--sel-ink:#f6f2e6;
--ans-rule:#7d6520;--ans-ink:#d4d1cb;--code:rgba(255,255,255,.075);--chip:rgba(255,255,255,.07);--chip-h:rgba(255,255,255,.12);
--pop:#2c2b29;--pop-sh:0 14px 36px rgba(0,0,0,.5),0 0 0 .5px rgba(255,255,255,.16);--field:rgba(255,255,255,.08);
--err:#ff7b72;--err-bg:rgba(255,123,114,.08);--warn:#f0a050;--warn-bg:rgba(240,160,80,.09);--ok:#5fd07a;--run:#f0c33a;
--hl-amber:rgba(245,197,24,.33);--hl-green:rgba(80,200,110,.26);--hl-blue:rgba(80,160,255,.25);--hl-pink:rgba(255,90,130,.24);
--card:#262523;--thumb:#2a2927;--shadow-card:0 0 0 .5px rgba(255,255,255,.12)}
.S *{scrollbar-width:thin;scrollbar-color:var(--hair2) transparent}
.S .win{position:absolute;inset:0;display:flex}
.S .ic{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.45;stroke-linecap:round;stroke-linejoin:round}
.S .ic.sm{width:14px;height:14px}.S .ic.xs{width:12px;height:12px}
.S button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:default}
.S .lights{position:absolute;left:18px;top:19px;display:flex;gap:8px;z-index:5}
.S .lights i{width:12px;height:12px;border-radius:50%;background:#ff5f57;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.18)}
.S .lights i:nth-child(2){background:#febc2e}.S .lights i:nth-child(3){background:#28c840}
.S .tb{width:30px;height:28px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;color:var(--ink2);flex:none}
.S .tb:hover{background:var(--chip)}.S .tb.on{background:var(--chip-h);color:var(--ink)}
.S .bar{height:52px;flex:none;display:flex;align-items:center;gap:4px;padding:0 12px;border-bottom:1px solid var(--hair);background:var(--bar)}
.S .sp{flex:1}
/* sidebar */
.S .side{width:214px;flex:none;background:var(--side);display:flex;flex-direction:column;color:var(--side-ink);border-right:1px solid var(--hair)}
.S .side .bar{background:transparent;border:0;justify-content:flex-end}
.S .sbody{flex:1;overflow:auto;padding:2px 10px 10px}
.S .sh{display:flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:var(--ink2);padding:14px 8px 4px;letter-spacing:.01em}
.S .sh .ic{width:11px;height:11px;opacity:0;transition:opacity .12s}.S .sh:hover .ic{opacity:1}
.S .sh>span:first-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:none;max-width:150px}.S .sh .dir{margin-left:auto;font-weight:400;color:var(--ink3);font-size:10.5px;display:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.S .sh:hover .dir{display:block}
.S .sr{display:flex;align-items:center;gap:7px;height:28px;padding:0 8px;border-radius:6px;font-size:13px;white-space:nowrap}
.S .sr .ic{color:var(--acc);width:17px;height:17px}
.S .sr .lb{flex:1;overflow:hidden;text-overflow:ellipsis}
.S .sr .ct{color:var(--ink2);font-size:12px;font-variant-numeric:tabular-nums}
.S .sr.on{background:var(--side-sel)}
.S .sr.drop{box-shadow:inset 0 0 0 2px var(--acc)}
.S .tags{display:flex;flex-wrap:wrap;gap:5px;padding:4px 6px 0}
.S .tchip{font-size:11.5px;padding:2px 8px;border-radius:11px;background:var(--chip);color:var(--side-ink);line-height:16px}
.S .tchip:hover{background:var(--chip-h)}.S .tchip.on{background:var(--acc);color:#1d1d1f}
.S .sfoot{height:40px;flex:none;display:flex;align-items:center;gap:6px;padding:0 16px;color:var(--ink2);font-size:13px}
.S .sfoot button{display:flex;align-items:center;gap:6px}.S .sfoot button:hover{color:var(--ink)}
/* list */
.S .list{width:296px;flex:none;display:flex;flex-direction:column;background:var(--list);border-right:1px solid var(--hair);min-width:0}
.S .list.wide{flex:1;width:auto;border-right:0}
.S .lt{display:flex;flex-direction:column;min-width:0;line-height:1.2;padding-left:4px}
.S .lt b{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.S .lt small{font-size:11px;color:var(--ink2)}
.S .seg{display:inline-flex;border-radius:6px;padding:0;gap:0;background:transparent}
.S .lbody{flex:1;overflow:auto;padding:4px 0 16px;outline:none}
.S .gh{font-size:13px;font-weight:700;padding:14px 20px 6px;color:var(--ink)}
.S .row{position:relative;margin:0 10px;padding:9px 12px 10px 14px;border-radius:7px;display:flex;gap:10px}
.S .row:not(.on)+.row:not(.on)::before{content:"";position:absolute;left:14px;right:12px;top:0;border-top:1px solid var(--hair)}
.S .row.on{background:var(--sel);color:var(--sel-ink)}
.S .row .rc{flex:1;min-width:0}
.S .rt{font-size:13px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:5px}
.S .rt span{overflow:hidden;text-overflow:ellipsis}
.S .dot{width:7px;height:7px;border-radius:50%;background:var(--acc);flex:none;margin-left:-11px}
.S .rl{font-size:12px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.S .row.on .rl,.S .row.on .rf{color:color-mix(in srgb,var(--sel-ink) 62%,transparent)}
.S .rl .dt{color:var(--ink);font-weight:500;margin-right:6px}.S .row.on .rl .dt{color:var(--sel-ink)}
.S .rf{font-size:11.5px;color:var(--ink2);margin-top:3px;display:flex;align-items:center;gap:4px}
.S .rf .ic{width:12px;height:12px}
.S .st{font-weight:600;margin-right:6px}.S .st.run{color:var(--run)}.S .st.error{color:var(--err)}.S .st.attention{color:var(--warn)}.S .st.plain{color:var(--ink2)}
.S .row.on .st{color:inherit}
.S .thumb{width:42px;height:42px;border-radius:6px;flex:none;align-self:center;background:var(--thumb);box-shadow:0 0 0 .5px var(--hair2);overflow:hidden;position:relative}
.S .thumb.link{display:flex;align-items:flex-end;padding:4px;font-size:8px;line-height:1.1;color:#fff;font-weight:600;background:linear-gradient(160deg,#4d6e8f,#2f4459)}
.S .thumb.doc{background:var(--card);padding:6px 6px}.S .thumb.doc i{display:block;height:2px;border-radius:1px;background:var(--ink3);opacity:.6;margin-bottom:3px}
.S .thumb.doc i:first-child{width:70%;background:var(--ink2)}
.S .thumb.hlq{background:var(--hl-amber);box-shadow:none;display:flex;align-items:center;justify-content:center;color:var(--ink)}
.S .empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--ink3);font-size:17px;font-weight:600;gap:6px;text-align:center;padding:24px}
.S .empty small{font-size:12px;font-weight:400;color:var(--ink2);max-width:240px}
/* gallery */
.S .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:20px 18px;padding:2px 24px 10px}
.S .gcard{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0}
.S .gthumb{width:100%;height:150px;border-radius:10px;background:var(--card);box-shadow:var(--shadow-card);padding:12px 12px;overflow:hidden;position:relative;font-size:9px;line-height:1.35;color:var(--ink2)}
.S .gcard.on .gthumb{box-shadow:0 0 0 3px var(--acc)}
.S .gthumb b{display:block;font-size:10.5px;color:var(--ink);margin-bottom:4px;line-height:1.25}
.S .gthumb .ga{border-left:2px solid var(--ans-rule);padding-left:6px;margin:4px 0;color:var(--ans-ink)}
.S .gthumb .gbadge{position:absolute;left:8px;bottom:7px;z-index:1;font-size:9.5px;font-weight:600;padding:1px 6px;border-radius:8px;background:var(--paper);box-shadow:0 0 0 .5px var(--hair2)}
.S .gthumb::after{content:"";position:absolute;left:0;right:0;bottom:0;height:30px;background:linear-gradient(transparent,var(--card))}
.S .gtt{font-size:12px;font-weight:650;text-align:center;max-width:100%;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.3;margin-top:4px}
.S .gdd{font-size:11px;color:var(--ink2)}
.S .gh.g{padding:16px 26px 10px}
/* editor */
.S .ed{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--paper);position:relative}
.S .ebody{flex:1;overflow:auto;position:relative}
.S .page{max-width:680px;margin:0 auto;padding:14px 44px 120px}
.S .edate{text-align:center;font-size:12px;color:var(--ink3);margin:2px 0 14px}
.S .ttl{font-size:26px;line-height:1.2;font-weight:700;letter-spacing:-.018em;margin:0 0 10px;outline:none;color:var(--ink)}
.S .recap{font-size:13.5px;color:var(--ink2);margin:0 0 16px;line-height:1.5}
.S .recap b{color:var(--ink);font-weight:600}
.S .q{font-size:14.5px;line-height:1.55;margin:18px 0 6px;font-weight:500;color:var(--ink);white-space:pre-wrap}
.S .ans{position:relative;margin:4px 0 14px;padding:1px 0 1px 15px;border-left:2px solid var(--ans-rule);color:var(--ans-ink);font-size:14px;line-height:1.58}
.S .ans.fail{border-left-color:var(--err)}.S .ans.review{border-left-color:var(--warn)}.S .ans.queued{border-left:2px dashed var(--hair2)}
.S .ap{margin:0 0 9px}
.S .ah{font-weight:700;color:var(--ink);margin:6px 0 4px;font-size:14px}
.S .ali{margin:0 0 4px;padding-left:14px;position:relative}.S .ali::before{content:"•";position:absolute;left:2px;color:var(--ink2)}
.S .pre{font:12.5px/1.5 ${MONO};background:var(--code);border-radius:6px;padding:9px 11px;margin:0 0 10px;white-space:pre;overflow:auto;color:var(--ink)}
.S .cd{font:0.89em ${MONO};background:var(--code);border-radius:4px;padding:1px 4px;color:var(--ink)}
.S .lnk{color:var(--acc-ink);text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:1px}
.S .tagt{color:var(--acc-ink);font-weight:500}
.S .hl{border-radius:2px;padding:1px 0;color:var(--ink)}
.S .hl.amber{background:var(--hl-amber)}.S .hl.green{background:var(--hl-green)}.S .hl.blue{background:var(--hl-blue)}.S .hl.pink{background:var(--hl-pink)}
.S .hl.noted{border-bottom:1.5px dotted var(--ink2)}
.S .hl.flash{animation:S-flash 1.4s ease-out}
@keyframes S-flash{0%{box-shadow:0 0 0 4px var(--acc)}100%{box-shadow:0 0 0 0 transparent}}
.S .anch{text-decoration:underline dotted var(--acc);text-decoration-thickness:2px;text-underline-offset:3px;cursor:pointer}
.S .bmark{position:absolute;left:-36px;width:20px;height:20px;border-radius:5px;display:flex;align-items:center;justify-content:center;color:var(--acc-ink);font-size:10px;font-weight:700;gap:1px}
.S .bmark:hover{background:var(--acc-soft)}
.S .meta{display:flex;flex-wrap:wrap;align-items:center;gap:2px;font-size:11.5px;color:var(--ink3);margin:2px 0 4px -6px}
.S .mc{padding:2px 6px;border-radius:5px;display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.S button.mc{color:var(--ink2)}.S button.mc:hover{background:var(--chip);color:var(--ink)}
.S .mc .ic{width:12px;height:12px}
.S .meta .sepd{color:var(--ink3);padding:0 1px}
.S .runl{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--run);margin:3px 0 8px;font-weight:500}
.S .runl .lab{color:var(--ink2);font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:330px}
.S .runl .el{color:var(--ink3);font-variant-numeric:tabular-nums;font-weight:400}
.S .runl button{color:var(--ink2);font-size:11.5px;padding:2px 7px;border-radius:5px;background:var(--chip);display:inline-flex;gap:4px;align-items:center}
.S .runl button:hover{background:var(--chip-h);color:var(--ink)}
.S .spin{width:11px;height:11px;border-radius:50%;border:1.6px solid currentColor;border-right-color:transparent;animation:S-spin .9s linear infinite;flex:none}
@keyframes S-spin{to{transform:rotate(360deg)}}
.S .caret{display:inline-block;width:7px;height:14px;background:var(--acc);vertical-align:-2px;margin-left:2px;border-radius:1px;animation:S-blink 1s steps(2) infinite}
@keyframes S-blink{50%{opacity:0}}
.S .qline{font-size:12.5px;color:var(--ink2);display:flex;align-items:center;gap:6px;padding:3px 0}
.S .qline button,.S .errbox button,.S .btn{font-size:12px;padding:3px 9px;border-radius:6px;background:var(--chip);color:var(--ink)}
.S .qline button:hover,.S .errbox button:hover,.S .btn:hover{background:var(--chip-h)}
.S .btn.pri{background:var(--acc);color:#1d1d1f;font-weight:600}
.S .errbox{background:var(--err-bg);border-radius:8px;padding:9px 11px;margin:2px 0 6px;font-size:13px;color:var(--ink)}
.S .errbox .et{color:var(--err);font-weight:600;display:flex;gap:6px;align-items:center;margin-bottom:4px}
.S .errbox code{display:block;font:12px/1.45 ${MONO};color:var(--ink2);margin-bottom:8px;white-space:pre-wrap}
.S .clar{background:var(--warn-bg);border-radius:8px;padding:9px 11px;margin:6px 0 6px;color:var(--ink)}
.S .clar .ct{font-size:12px;color:var(--warn);font-weight:600;margin-bottom:3px}
.S .clar textarea{margin-top:8px;background:var(--paper);width:100%;border-radius:6px;padding:4px 8px;height:31px;box-shadow:0 0 0 .5px var(--hair2)}
/* sections */
.S .sec{margin:22px 0 4px;position:relative}
.S .sech{display:flex;align-items:baseline;gap:6px;position:relative;cursor:pointer;user-select:none}
.S .sech .fold{position:absolute;left:-24px;top:3px;width:18px;height:18px;border-radius:4px;display:flex;align-items:center;justify-content:center;color:var(--acc-ink);transition:transform .15s}
.S .sech .fold .ic{width:13px;height:13px;stroke-width:2}
.S .sec.folded>.sech .fold{transform:rotate(-90deg)}
.S .sech h2{font-size:19px;font-weight:700;margin:0;letter-spacing:-.01em;color:var(--ink)}
.S .sech h3{font-size:16px;font-weight:650;margin:0;color:var(--ink)}
.S .sech .cnt{font-size:12px;color:var(--ink3);font-weight:400;white-space:nowrap}
.S .sec.folded>.secb{display:none}
.S .from{font-size:12.5px;color:var(--ink2);margin:6px 0 0;display:flex;gap:6px;align-items:baseline}
.S .from .ic{width:13px;height:13px;align-self:center;color:var(--acc-ink)}
.S .from q{font-style:italic;quotes:"\\201C" "\\201D";color:var(--ink);cursor:pointer}
.S .from q:hover{text-decoration:underline}
.S .secb .sec{margin-top:16px}
/* ask line */
.S .askl{position:relative;margin:16px 0 0;display:flex;align-items:flex-start;gap:8px}
.S .askl textarea,.S .clar textarea,.S .qn textarea{flex:1;resize:none;border:0;outline:none;background:transparent;font:14.5px/1.55 ${FONT};color:var(--ink);padding:0;min-height:23px;height:23px;overflow:hidden}
.S .askl textarea::placeholder,.S .clar textarea::placeholder,.S .qn textarea::placeholder,.S .dask textarea::placeholder{color:var(--ink3)}
.S .askl.big textarea{font-size:26px;font-weight:700;line-height:1.25;height:34px;min-height:34px;letter-spacing:-.018em}
.S .askl.sub textarea{font-size:13.5px}
.S .askl.hero{background:var(--field);border-radius:10px;padding:11px 14px;margin-top:10px}.S .askl.hero::before{display:none}
.S .askl.hero:focus-within{box-shadow:0 0 0 2px var(--acc)}
.S .askh{display:none;align-items:center;gap:6px;font-size:11.5px;color:var(--ink2);white-space:nowrap;padding-top:2px}
.S .askl.has .askh{display:flex}
.S .kbd{font-size:11px;padding:1px 6px;border-radius:5px;background:var(--acc);color:#1d1d1f;font-weight:600}
.S .askl:not(.has):not(.big)::before{content:"";position:absolute;left:-14px;top:5px;bottom:5px;width:2px;border-radius:1px;background:var(--hair2)}
.S .askl:focus-within::before{background:var(--acc)!important}
.S .notice{font-size:12.5px;color:var(--ink2);background:var(--chip);border-radius:8px;padding:8px 11px;margin:8px 0;display:flex;gap:8px;align-items:center}
/* footer: tags + links */
.S .foot{margin-top:30px;padding-top:12px;border-top:1px solid var(--hair);font-size:13px}
.S .foot .fl{display:flex;flex-wrap:wrap;gap:4px 12px;margin-bottom:8px;align-items:baseline}
.S .foot .fk{font-size:11.5px;color:var(--ink3);width:84px;flex:none}
.S .nlink{color:var(--acc-ink);text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:1px;cursor:pointer}
.S .nlink::before{content:">>";display:inline-block;margin-right:5px;text-decoration:none;color:var(--ink3);font-size:11.5px}
.S .tagt.big{font-size:13px;cursor:pointer}
/* page notes */
.S .ol{margin:4px 0 6px;padding:0;list-style:none;font-size:14.5px;line-height:1.55}
.S .ol li{position:relative;padding-left:22px;margin:3px 0}
.S .ol li::before{content:"•";position:absolute;left:7px;color:var(--ink2)}
.S .gthumb .ol li::before{left:1px}
.S .ol.chk li{padding-left:28px;margin:6px 0}
.S .ol.chk li::before{content:"";left:1px;top:3px;width:17px;height:17px;border-radius:50%;box-shadow:inset 0 0 0 1.4px var(--ink3)}
.S .ol.chk li.done::before{background:var(--acc);box-shadow:none}
.S .ol.chk li.done::after{content:"";position:absolute;left:7px;top:7px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
.S .ol.chk li.done{color:var(--ink2)}
.S .ol ul{padding:0;list-style:none;margin:2px 0}
/* link card + doc */
.S .lcard{display:flex;gap:12px;align-items:center;border-radius:10px;background:var(--chip);padding:10px;margin:10px 0 6px}
.S .lcard .lim{width:64px;height:64px;border-radius:7px;flex:none;background:linear-gradient(160deg,#4d6e8f,#2f4459);color:#fff;display:flex;align-items:flex-end;padding:6px;font-size:10px;font-weight:700}
.S .lcard b{display:block;font-size:13.5px;line-height:1.3;margin-bottom:3px}
.S .lcard small{font-size:12px;color:var(--ink2)}
.S .att{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink2);background:var(--chip);border-radius:6px;padding:4px 9px;margin:2px 0 12px}
.S .docbody{font-size:14.5px;line-height:1.6}
.S .docbody .ap{margin-bottom:11px}
/* table */
.S .tbl{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0 6px}
.S .tbl td,.S .tbl th{border:1px solid var(--hair2);padding:7px 10px;text-align:left;vertical-align:middle}
.S .tbl th{font-weight:600;font-size:12px;color:var(--ink2)}
.S .pill{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600}
.S .pill.ok{color:var(--ok)}.S .pill.err{color:var(--err)}.S .pill.warn{color:var(--warn)}.S .pill.plain{color:var(--ink2)}
/* toolbar fields */
.S .search{display:flex;align-items:center;gap:5px;height:28px;width:170px;border-radius:7px;background:var(--field);padding:0 8px;color:var(--ink2);flex:none}
.S[data-variant="d"] .search{width:118px}
.S .search input{flex:1;min-width:0;border:0;outline:0;background:transparent;font:13px ${FONT};color:var(--ink)}
.S .search input::placeholder{color:var(--ink3)}
.S .mchip{height:28px;display:inline-flex;align-items:center;gap:5px;padding:0 9px 0 7px;border-radius:7px;color:var(--ink);font-size:12.5px;flex:none}
.S .mchip:hover,.S .mchip.on{background:var(--chip)}
.S .mchip .ic{color:var(--acc-ink)}
.S .mchip .pv{color:var(--ink2)}
.S .vsep{width:1px;height:18px;background:var(--hair2);margin:0 6px;flex:none}
/* popovers */
.S .pop{position:absolute;z-index:40;background:var(--pop);border-radius:10px;box-shadow:var(--pop-sh);padding:6px;min-width:200px;max-width:380px;font-size:13px;color:var(--ink)}
.S .pop h4{margin:4px 8px 6px;font-size:11.5px;color:var(--ink2);font-weight:600}
.S .mi{display:flex;align-items:center;gap:8px;height:26px;padding:0 9px;border-radius:5px;width:100%;text-align:left;white-space:nowrap}
.S .mi:hover{background:var(--acc);color:#1d1d1f}
.S .mi .ic{width:15px;height:15px}
.S .mi .k{margin-left:auto;color:var(--ink3);font-size:12px}.S .mi:hover .k{color:inherit}
.S .msep{height:1px;background:var(--hair2);margin:5px 6px}
.S .pr{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px}
.S .pr.sel{background:var(--chip)}
.S .pr .pn{font-weight:600;flex:1}
.S .mods{display:flex;flex-wrap:wrap;gap:4px;padding:2px 8px 8px}
.S .opt{font-size:12px;padding:3px 8px;border-radius:6px;background:var(--chip);color:var(--ink)}
.S .opt:hover{background:var(--chip-h)}.S .opt.on{background:var(--acc);color:#1d1d1f;font-weight:600}
.S .pnote{font-size:11.5px;color:var(--ink2);padding:6px 8px 4px;line-height:1.4}
.S .srcr{display:flex;gap:9px;padding:6px 8px;border-radius:6px;align-items:center}
.S .srcr:hover{background:var(--chip)}
.S .fav{width:22px;height:22px;border-radius:5px;background:var(--chip-h);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--ink2);flex:none}
.S .srcr b{display:block;font-weight:500;font-size:12.5px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px}
.S .srcr small{font-size:11.5px;color:var(--ink2)}
.S .stp{display:flex;gap:8px;padding:5px 8px;align-items:flex-start;font-size:12.5px}
.S .stp .ic{width:14px;height:14px;color:var(--ink2);margin-top:1px}
.S .stp .sl{flex:1;min-width:0}.S .stp .sd{display:block;font:11.5px ${MONO};color:var(--ink2)}
.S .stp .ms{color:var(--ink3);font-size:11.5px;font-variant-numeric:tabular-nums}
.S .stp.error .sl{color:var(--err)}
.S .pcmd{font:12px ${MONO};background:var(--code);padding:2px 6px;border-radius:4px}
/* selection bar */
.S .selbar{position:absolute;z-index:35;display:flex;gap:1px;background:var(--pop);border-radius:8px;box-shadow:var(--pop-sh);padding:3px}
.S .selbar button{display:flex;align-items:center;gap:5px;font-size:12.5px;padding:4px 9px;border-radius:5px}
.S .selbar button:hover{background:var(--chip-h)}
.S .selbar .dis{font-size:12px;color:var(--ink2);padding:4px 9px}
.S .toast{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);background:var(--pop);box-shadow:var(--pop-sh);border-radius:8px;padding:7px 14px;font-size:12.5px;z-index:50}
/* status line (variant b) */
.S .sline{height:30px;flex:none;border-top:1px solid var(--hair);display:flex;align-items:center;gap:4px;padding:0 10px;font-size:12px;color:var(--ink2);background:var(--bar)}
.S .sline .mchip{height:22px;font-size:12px}
/* drawer (variant d) */
.S .drawer{width:316px;flex:none;border-left:1px solid var(--hair);display:flex;flex-direction:column;background:var(--list)}
.S .dbody{flex:1;overflow:auto;padding:8px 12px 12px}
.S .dc{padding:9px 11px;border-radius:9px;margin-bottom:6px;cursor:pointer}
.S .dc:hover{background:var(--chip)}.S .dc.on{background:var(--acc-soft)}
.S .dc .dq{font-size:13px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.S .dc .dm{font-size:11.5px;color:var(--ink2);margin-top:4px;display:flex;gap:6px;align-items:center}
.S .dc.br{margin-left:16px;position:relative}
.S .dc.br::before{content:"";position:absolute;left:-9px;top:6px;bottom:6px;width:2px;border-radius:1px;background:var(--ans-rule)}
.S .dc .dfrom{font-size:11.5px;color:var(--acc-ink);margin-bottom:2px;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.S .dask{border-top:1px solid var(--hair);padding:10px 12px 12px}
.S .dask .dbox{border-radius:10px;background:var(--field);padding:8px 10px}
.S .dask textarea{width:100%;resize:none;border:0;outline:0;background:transparent;font:13.5px/1.45 ${FONT};color:var(--ink);height:40px}
.S .dask .drow{display:flex;align-items:center;gap:6px;margin-top:4px}
.S .send{width:24px;height:24px;border-radius:50%;background:var(--acc);color:#1d1d1f;display:flex;align-items:center;justify-content:center}
.S .send .ic{width:14px;height:14px;stroke-width:2}
.S .dbr{font-size:11.5px;color:var(--acc-ink);display:flex;gap:6px;align-items:center;margin-bottom:6px}
.S .docsec .docp{font-size:14.5px;line-height:1.6;color:var(--ink)}
.S .docsec .meta{margin-top:-2px}
/* quick note */
.S .qn{position:absolute;right:22px;bottom:22px;width:380px;z-index:30;background:var(--paper);border-radius:12px;box-shadow:var(--pop-sh);overflow:hidden}
.S .qn .qh{height:34px;display:flex;align-items:center;padding:0 12px;gap:8px;border-bottom:1px solid var(--hair);font-size:12px;color:var(--ink2);font-weight:600}
.S .qn .qh .lights{position:static;gap:6px}.S .qn .qh .lights i{width:10px;height:10px}
.S .qn .qb{padding:12px 14px}
.S .qn textarea{width:100%;height:60px}
`;

  /* ------------------------------------------------------------------ icons */
  const ICONS = {
    sidebar: '<rect x="2.75" y="4.25" width="14.5" height="11.5" rx="2.5"/><path d="M7.5 4.5v11"/>',
    list: '<path d="M7.5 6h9M7.5 10h9M7.5 14h9"/><circle cx="4" cy="6" r=".6" fill="currentColor"/><circle cx="4" cy="10" r=".6" fill="currentColor"/><circle cx="4" cy="14" r=".6" fill="currentColor"/>',
    grid: '<rect x="3.25" y="3.25" width="5.75" height="5.75" rx="1.4"/><rect x="11" y="3.25" width="5.75" height="5.75" rx="1.4"/><rect x="3.25" y="11" width="5.75" height="5.75" rx="1.4"/><rect x="11" y="11" width="5.75" height="5.75" rx="1.4"/>',
    trash: '<path d="M4 6h12M8 6V4.25h4V6M5.6 6l.75 10.25h7.3L14.4 6M8.5 9v4.5M11.5 9v4.5"/>',
    compose: '<path d="M9.5 4H5.5A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5v-4"/><path d="M14.6 3.4l2 2-6.4 6.4-2.7.7.7-2.7z"/>',
    aa: '<text x="1.6" y="14.6" font-size="11.5" font-weight="600" fill="currentColor" stroke="none" font-family="-apple-system,Inter,Helvetica,Arial">Aa</text>',
    check: '<circle cx="5" cy="6" r="2.1"/><path d="M4.1 6l.7.7 1.2-1.3"/><circle cx="5" cy="14" r="2.1"/><path d="M9.25 6h7.5M9.25 14h7.5"/>',
    table: '<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 8.25h14M3 12.25h14M7.75 8.25V16M12.25 8.25V16"/>',
    clip: '<path d="M14.6 9.4l-5.3 5.3a3.2 3.2 0 0 1-4.5-4.5l6.1-6.1a2.1 2.1 0 0 1 3 3l-6 6a1.05 1.05 0 0 1-1.5-1.5l5.3-5.3"/>',
    search: '<circle cx="8.6" cy="8.6" r="4.9"/><path d="M12.3 12.3l4 4"/>',
    folder: '<path d="M2.75 6.1a1.6 1.6 0 0 1 1.6-1.6h3.2l1.7 1.75h6.4a1.6 1.6 0 0 1 1.6 1.6v6.5a1.6 1.6 0 0 1-1.6 1.6H4.35a1.6 1.6 0 0 1-1.6-1.6z"/>',
    smart: '<path d="M2.75 6.1a1.6 1.6 0 0 1 1.6-1.6h3.2l1.7 1.75h6.4a1.6 1.6 0 0 1 1.6 1.6v6.5a1.6 1.6 0 0 1-1.6 1.6H4.35a1.6 1.6 0 0 1-1.6-1.6z"/><circle cx="10" cy="11.2" r="1.5"/><path d="M10 8.4v.7M10 13.3v.7M7.2 11.2h.7M12.1 11.2h.7"/>',
    tray: '<path d="M3 11.2l2.1-6h9.8l2.1 6v3.6a1.2 1.2 0 0 1-1.2 1.2H4.2A1.2 1.2 0 0 1 3 14.8z"/><path d="M3 11.2h4.2l.9 1.8h3.8l.9-1.8H17"/>',
    archive: '<rect x="3" y="4" width="14" height="4" rx="1"/><path d="M4.5 8v7a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V8M8.5 11h3"/>',
    plusc: '<circle cx="10" cy="10" r="7"/><path d="M10 7v6M7 10h6"/>',
    chevr: '<path d="M8 5l5 5-5 5"/>',
    chevd: '<path d="M5 8l5 5 5-5"/>',
    back: '<path d="M12.5 4.5L7 10l5.5 5.5"/>',
    pin: '<path d="M7.6 3.5h4.8l-.6 4.3 2.7 2.7H5.5l2.7-2.7z"/><path d="M10 10.5v6"/>',
    sparkle: '<path d="M10 2.8l1.7 4.6 4.6 1.7-4.6 1.7L10 15.4l-1.7-4.6-4.6-1.7 4.6-1.7z"/>',
    info: '<circle cx="10" cy="10" r="7"/><path d="M10 9v4.8M10 6.4v.1"/>',
    branch: '<circle cx="6" cy="4.8" r="1.8"/><circle cx="6" cy="15.2" r="1.8"/><circle cx="14" cy="7" r="1.8"/><path d="M6 6.6v6.8M14 8.8c0 3.2-8 1.9-8 4.6"/>',
    x: '<path d="M6 6l8 8M14 6l-8 8"/>',
    ok: '<path d="M5 10.5l3.2 3L15 6.5"/>',
    clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.6 1.6"/>',
    warn: '<path d="M10 3.5L17.2 16H2.8z"/><path d="M10 8.5v3.4M10 14v.1"/>',
    alert: '<circle cx="10" cy="10" r="7"/><path d="M10 6.5v4.3M10 13.4v.1"/>',
    run: '<circle cx="10" cy="10" r="7"/><path d="M8.6 7.4l4 2.6-4 2.6z" fill="currentColor"/>',
    marker: '<path d="M5.5 14.5l1.3-3.3 6.9-6.9 2 2-6.9 6.9z"/><path d="M3.5 17h9"/>',
    link: '<path d="M8.6 11.4l2.8-2.8M9.2 6.6l1.1-1.1a3 3 0 0 1 4.2 4.2l-1.1 1.1M10.8 13.4l-1.1 1.1a3 3 0 0 1-4.2-4.2l1.1-1.1"/>',
    share: '<path d="M10 3v9.5M6.6 6.4L10 3l3.4 3.4M6.2 9H5v8h10V9h-1.2"/>',
    stop: '<rect x="6.5" y="6.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none"/>',
    up: '<path d="M10 15.5V4.5M5.5 9L10 4.5 14.5 9"/>',
    doc: '<path d="M5 3h7l3 3v11H5z"/><path d="M12 3v3h3M7.5 10h5M7.5 13h5"/>',
    globe: '<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c2.4 2.4 2.4 11.6 0 14M10 3c-2.4 2.4-2.4 11.6 0 14"/>',
    fetch: '<path d="M10 3.5v9.5M5.8 9L10 13.2 14.2 9M4 16.5h12"/>',
    term: '<rect x="2.75" y="4" width="14.5" height="12" rx="2"/><path d="M6 8l2.5 2L6 12M10.5 12.5h3.5"/>',
    pencil: '<path d="M13.4 4l2.6 2.6-8 8-3.2.6.6-3.2z"/>',
    quick: '<rect x="3" y="3" width="14" height="14" rx="3.5"/><path d="M7.5 12.5l5-5M9 7.5h3.5V11"/>',
    copy: '<rect x="6.5" y="6.5" width="10" height="10" rx="2"/><path d="M13.5 6.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v7A1.5 1.5 0 0 0 5 13.5h1.5"/>',
    hash: '<path d="M7.5 3.5l-1.5 13M14 3.5l-1.5 13M4 7.5h12.5M3.5 12.5H16"/>',
    lock: '<rect x="4.5" y="8.5" width="11" height="8" rx="2"/><path d="M7 8.5V6.5a3 3 0 0 1 6 0v2"/>'
  };
  const STEP_ICON = { think: "sparkle", read: "doc", grep: "search", search: "globe", fetch: "fetch", run: "term", edit: "pencil" };
  const PROV = { claude: "Claude Code", codex: "Codex", grok: "Grok" };

  /* ------------------------------------------------------------------ helpers */
  function h(tag, a, ...kids) {
    const e = document.createElement(tag);
    if (a) for (const k in a) {
      const v = a[k];
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "style") e.style.cssText = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  }
  function ic(name, cls) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 20 20");
    s.setAttribute("class", "ic" + (cls ? " " + cls : ""));
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = ICONS[name] || "";
    return s;
  }
  function plain(s) {
    return String(s || "").replace(/```[\s\S]*?```/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*]/g, "").replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim();
  }
  function inl(s) {
    const out = [];
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|((?<=^|\s)#[a-z][\w-]*)/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      const t = m[0];
      if (m[1]) out.push(h("code", { class: "cd" }, t.slice(1, -1)));
      else if (m[2]) out.push(h("b", null, t.slice(2, -2)));
      else if (m[3]) { const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t); out.push(h("span", { class: "lnk", title: mm[2] }, mm[1])); }
      else out.push(h("span", { class: "tagt", "data-tag": t.slice(1) }, t));
      last = m.index + t.length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  }
  function blocks(p) {
    if (p.startsWith("```")) return [h("pre", { class: "pre" }, p.replace(/^```\w*\n?/, "").replace(/\n?```\s*$/, ""))];
    const out = [];
    let buf = [];
    const flush = () => { if (buf.length) { out.push(h("p", { class: "ap" }, inl(buf.join(" ")))); buf = []; } };
    for (const ln of p.split("\n")) {
      if (/^#{1,4}\s/.test(ln)) { flush(); out.push(h("div", { class: "ah" }, ln.replace(/^#+\s/, ""))); }
      else if (/^[-*]\s/.test(ln)) { flush(); out.push(h("div", { class: "ali" }, inl(ln.slice(2)))); }
      else buf.push(ln);
    }
    flush();
    return out;
  }
  function wrapQuote(el, quote, mk) {
    const q = plain(quote);
    if (!q) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let pos = 0, n;
    while ((n = walker.nextNode())) { nodes.push([n, pos]); pos += n.data.length; }
    const full = nodes.map((x) => x[0].data).join("");
    const s = full.indexOf(q);
    if (s < 0) return null;
    const e = s + q.length;
    let first = null;
    for (const [node, start] of nodes) {
      const end = start + node.data.length;
      if (end <= s || start >= e) continue;
      const a = Math.max(s, start) - start, b = Math.min(e, end) - start;
      let target = node;
      if (a > 0) target = target.splitText(a);
      if (b - a < target.data.length) target.splitText(b - a);
      const w = mk();
      target.parentNode.insertBefore(w, target);
      w.appendChild(target);
      first = first || w;
    }
    return first;
  }
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const pad = (n) => String(n).padStart(2, "0");
  function hm(d) { return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()); }
  function dayIndex(ms) { return Math.floor(ms / 86400000); }
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + "s";
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + "m " + pad(s) + "s";
    return Math.floor(m / 60) + "h " + pad(m % 60) + "m";
  }
  function short(s, n) { s = plain(s); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s; }

  /* ------------------------------------------------------------------ mount */
  function mount(root, ctx) {
    const D = ctx.data, V = ctx.variant;
    const NOW = Date.parse(D.now), T0 = Date.now();
    const nowMs = () => NOW + (Date.now() - T0);
    const nowISO = () => new Date(nowMs()).toISOString();
    const timers = new Set();
    const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
    const cancel = (id) => { clearTimeout(id); timers.delete(id); };

    /* ---------- model (mutable copies) */
    let threads = JSON.parse(JSON.stringify(D.threads));
    let pages = JSON.parse(JSON.stringify(D.notes));
    let drafts = JSON.parse(JSON.stringify(D.drafts));
    let workspaces = D.workspaces.map((w) => Object.assign({}, w));
    let folders = D.folders.map((f) => Object.assign({}, f));
    const welcomes = [];
    const agents = { claude: "ready", codex: "ready", grok: "ready" };
    let seq = 0;
    const uid = (p) => p + "-" + (++seq);
    const TH = () => Object.fromEntries(threads.map((t) => [t.id, t]));
    function turnById(id) { for (const t of threads) for (const u of t.turns) if (u.id === id) return [t, u]; for (const w of welcomes) for (const u of w.t.turns) if (u.id === id) return [w.t, u]; return [null, null]; }
    function threadById(id) { return threads.find((t) => t.id === id) || (welcomes.find((w) => w.t.id === id) || {}).t; }

    function makeWelcome(wsId) {
      const t = { id: "welcome-" + wsId, workspaceId: wsId, folderId: null, kind: "exchange", title: "Welcome to Session", provider: "claude", model: "opus", effort: "high",
        status: "done", createdAt: nowISO(), updatedAt: nowISO(), unread: false, bookmarked: true, followed: false, archivedAt: null, recap: null, tags: [], links: [], turns: [], welcome: true };
      welcomes.push({ id: t.id, ws: wsId, t });
      return t;
    }

    const st = {
      sel: "smart:all", noteId: "t1", search: "", collapsed: new Set(["prompt-t10"]), sidebar: V !== "d",
      view: V === "c" ? "gallery" : "list", galOpen: false, pop: null, wsFold: new Set(),
      compose: {}, focus: null, scrollTo: null, flash: null, modelFor: {}, pending: null, quick: false, toast: null,
      wel: { asked: false, followed: false, branched: false, tagged: false }
    };
    if (V === "e") {
      threads = []; pages = []; drafts = []; folders = [];
      workspaces = [{ id: "ws-first", name: "My Research", dir: "~/Session/My Research" }];
      agents.codex = "signin"; agents.grok = "missing";
      makeWelcome("ws-first");
      st.sel = "ws:ws-first"; st.noteId = "welcome-ws-first";
    }

    /* ---------- derived */
    function chainOf(t, start) {
      const out = [start];
      let cur = start;
      for (;;) { const nx = t.turns.find((u) => u.parentId === cur.id && u.relation === "followup"); if (!nx) break; out.push(nx); cur = nx; }
      return out;
    }
    function branchesOf(t, u) { return t.turns.filter((x) => x.parentId === u.id && x.relation === "branch"); }
    function rootOf(t) { return t.turns.find((u) => u.relation === "root"); }
    function subtree(t, u) { const out = []; const walk = (x) => { out.push(x); t.turns.filter((y) => y.parentId === x.id).forEach(walk); }; walk(u); return out; }
    function statusOf(turns, fallback) {
      const s = turns.map((u) => u.status);
      if (s.includes("running")) return "running";
      if (s.includes("needs-review")) return "needs-review";
      if (s.includes("failed")) return "failed";
      if (s.includes("queued")) return "queued";
      return fallback || "done";
    }
    function threadStatus(t) { return t.turns.length ? statusOf(t.turns) : "draft"; }
    function branchNoteOf(t, u) { // variant b: the branch note containing turn u
      let cur = u;
      while (cur && cur.relation !== "branch" && cur.parentId) cur = t.turns.find((x) => x.id === cur.parentId);
      return cur && cur.relation === "branch" ? cur : null;
    }
    function previewOf(t) {
      if (t.kind === "post") { const p = rootOf(t).post; return p.domain + " · " + p.author; }
      const r = rootOf(t);
      if (!r) return "No additional text";
      if (t.kind === "document") return plain(r.answer[0] || "").replace(/^Summary\s*/, "");
      return plain(r.question);
    }
    function textOf(t) { return (t.title + " " + t.turns.map((u) => u.question + " " + u.answer.join(" ")).join(" ")).toLowerCase(); }

    function items() {
      const out = [];
      for (const t of threads) {
        out.push({ id: t.id, kind: "thread", t, title: t.title || "New Note", date: t.updatedAt, ws: t.workspaceId, folderId: t.folderId, pinned: t.bookmarked,
          archived: !!t.archivedAt, tags: t.tags, status: threadStatus(t), unread: t.unread, preview: previewOf(t), thumb: t.kind === "post" ? "link" : t.kind === "document" ? "doc" : null });
        if (V === "b") for (const u of t.turns) if (u.relation === "branch") {
          const sub = subtree(t, u).filter((x) => x === u || branchNoteOf(t, x) === u);
          out.push({ id: u.id, kind: "branch", t, u, title: u.title, date: sub.map((x) => x.completedAt || x.createdAt).sort().pop(), ws: t.workspaceId, folderId: t.folderId,
            pinned: false, archived: !!t.archivedAt, tags: [], status: statusOf(sub), unread: false, preview: "Branch of " + t.title, thumb: null });
        }
      }
      for (const n of pages) out.push({ id: n.id, kind: "page", n, title: n.title, date: n.updatedAt, ws: n.workspaceId, folderId: n.folderId || null, pinned: !!n.pinned, archived: false, tags: n.tags,
        status: null, unread: false, preview: n.outline.map((o) => o.text).join(" · "), thumb: null });
      for (const d of drafts) out.push({ id: d.id, kind: "draft", d, title: short(d.prompt, 64), date: d.updatedAt, ws: d.workspaceId, folderId: null, pinned: false, archived: false, tags: [],
        status: "draft", unread: false, preview: PROV[d.provider] + " " + d.model, thumb: null });
      for (const w of welcomes) out.push({ id: w.id, kind: "welcome", t: w.t, title: "Welcome to Session", date: w.t.updatedAt, ws: w.ws, folderId: null, pinned: true, archived: false,
        tags: w.t.tags, status: w.t.turns.length ? threadStatus(w.t) : null, unread: false, preview: "Check your agents, then ask a first question at the end of this note.", thumb: null });
      return out;
    }
    function matchSel(it, sel) {
      const [k, v] = [sel.slice(0, sel.indexOf(":")), sel.slice(sel.indexOf(":") + 1)];
      if (k === "smart") {
        if (v === "all") return !it.archived;
        if (v === "attention") return !it.archived && (it.unread || it.status === "failed" || it.status === "needs-review");
        if (v === "running") return !it.archived && (it.status === "running" || it.status === "queued");
        if (v.startsWith("q:")) return !it.archived && it.tags.includes(v.slice(2));
        return false;
      }
      if (k === "ws") return !it.archived && it.ws === v;
      if (k === "folder") return !it.archived && it.folderId === v;
      if (k === "archive") return it.archived && it.ws === v;
      if (k === "tag") return !it.archived && it.tags.includes(v);
      return false;
    }
    function visible() {
      const q = st.search.trim().toLowerCase();
      let list = items().filter((it) => matchSel(it, st.sel));
      if (q) list = list.filter((it) => (it.title + " " + it.preview).toLowerCase().includes(q) || (it.t && textOf(it.t).includes(q)) || it.tags.some((g) => g.includes(q)));
      list.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      return list;
    }
    function groupName(iso) {
      const d = dayIndex(nowMs()) - dayIndex(Date.parse(iso));
      if (d <= 0) return "Today";
      if (d === 1) return "Yesterday";
      if (d <= 7) return "Previous 7 Days";
      if (d <= 30) return "Previous 30 Days";
      const dt = new Date(iso); return MONTHS[dt.getUTCMonth()] + " " + dt.getUTCFullYear();
    }
    function grouped(list) {
      const gs = [];
      const pinned = list.filter((i) => i.pinned);
      if (pinned.length) gs.push(["Pinned", pinned]);
      for (const it of list.filter((i) => !i.pinned)) {
        const g = groupName(it.date);
        const last = gs[gs.length - 1];
        if (last && last[0] === g) last[1].push(it); else gs.push([g, [it]]);
      }
      return gs;
    }
    function listDate(iso) {
      const d = new Date(iso), diff = dayIndex(nowMs()) - dayIndex(d.getTime());
      if (diff <= 0) return hm(d);
      if (diff === 1) return "Yesterday";
      if (diff < 7) return DAYS[d.getUTCDay()];
      return pad(d.getUTCDate()) + "/" + pad(d.getUTCMonth() + 1) + "/" + d.getUTCFullYear();
    }
    function longDate(iso) { const d = new Date(iso); return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear() + " at " + hm(d); }
    function selName(sel) {
      const v = sel.slice(sel.indexOf(":") + 1);
      if (sel === "smart:all") return "All Notes";
      if (sel === "smart:attention") return "Needs Attention";
      if (sel === "smart:running") return "Running";
      if (sel === "smart:hl") return "Highlights";
      if (sel.startsWith("smart:q:")) return "#" + v.slice(2);
      if (sel.startsWith("ws:")) return "Notes";
      if (sel.startsWith("folder:")) return (folders.find((f) => f.id === v) || {}).name || "Folder";
      if (sel.startsWith("archive:")) return "Archive";
      if (sel.startsWith("tag:")) return "#" + v;
      return "";
    }
    function selWs() {
      const v = st.sel.slice(st.sel.indexOf(":") + 1);
      if (st.sel.startsWith("ws:") || st.sel.startsWith("archive:")) return v;
      if (st.sel.startsWith("folder:")) return (folders.find((f) => f.id === v) || {}).workspaceId;
      const it = items().find((i) => i.id === st.noteId);
      return it ? it.ws : workspaces[0].id;
    }
    function allHighlights() {
      const out = [];
      for (const t of threads) for (const u of t.turns) for (const hl of u.highlights) out.push(Object.assign({ t, u }, hl));
      return out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    }
    function modelFor(noteId) {
      if (st.modelFor[noteId]) return st.modelFor[noteId];
      const it = items().find((i) => i.id === noteId);
      let src = { provider: "claude", model: "opus", effort: "high" };
      if (it && it.t && it.t.turns.length) { const u = it.u ? chainOf(it.t, it.u).pop() : chainOf(it.t, rootOf(it.t)).pop(); src = u; }
      else if (it && it.d) src = it.d;
      return { provider: src.provider, model: src.model, effort: src.effort || null };
    }
    const mLabel = (m) => m.model + (m.effort ? " · " + m.effort : "");

    /* ---------- DOM skeleton */
    root.tabIndex = -1;
    const win = h("div", { class: "win" });
    const lights = h("div", { class: "lights" }, h("i"), h("i"), h("i"));
    root.replaceChildren(win, lights);
    let $side, $list, $ed, $drawer, $pop = null, $selbar = null, $toast = null, $qn = null;

    function render() {
      closeSelbar();
      const eb = win.querySelector(".ebody"), lb = win.querySelector(".lbody");
      const keep = { note: $ed && $ed.dataset.note, ed: eb ? eb.scrollTop : 0, list: lb ? lb.scrollTop : 0, sel: st.sel, view: st.view };
      win.replaceChildren();
      const galleryFull = st.view === "gallery";
      if (st.sidebar) win.append($side = renderSidebar());
      if (!galleryFull || !st.galOpen) win.append($list = renderList());
      if (!galleryFull || st.galOpen) win.append($ed = renderEditor());
      if (V === "d" && (!galleryFull || st.galOpen)) win.append($drawer = renderDrawer());
      if (st.quick) win.append(renderQuick());
      const eb2 = win.querySelector(".ebody"), lb2 = win.querySelector(".lbody");
      if (eb2 && keep.note === st.noteId) eb2.scrollTop = keep.ed;
      if (lb2 && keep.sel === st.sel && keep.view === st.view) lb2.scrollTop = keep.list;
      afterRender();
    }
    function afterRender() {
      if (st.focus) {
        const el = root.querySelector('[data-focus="' + st.focus + '"]');
        if (el) { el.focus({ preventScroll: true }); if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length); }
        st.focus = null;
      }
      if (st.scrollTo) {
        const el = root.querySelector(st.scrollTo);
        if (el) { el.scrollIntoView({ block: "center" }); }
        st.scrollTo = null;
      }
      if (st.flash) {
        const el = root.querySelector(st.flash);
        if (el) { el.scrollIntoView({ block: "center" }); el.classList.add("flash"); }
        st.flash = null;
      }
    }

    /* ---------- sidebar */
    function sRow(sel, icon, label, count) {
      return h("div", { class: "sr" + (st.sel === sel ? " on" : ""), "data-sel": sel, onclick: () => pickSel(sel),
        ondragover: (e) => { if (sel.startsWith("folder:") || sel.startsWith("ws:")) { e.preventDefault(); e.currentTarget.classList.add("drop"); } },
        ondragleave: (e) => e.currentTarget.classList.remove("drop"),
        ondrop: (e) => { e.preventDefault(); moveTo(e.dataTransfer.getData("text/plain"), sel); } },
      ic(icon), h("span", { class: "lb" }, label), count != null ? h("span", { class: "ct" }, String(count)) : null);
    }
    function renderSidebar() {
      const all = items();
      const cnt = (sel) => all.filter((i) => matchSel(i, sel)).length;
      const body = h("div", { class: "sbody" });
      if (V !== "e" && workspaces.length > 1) {
        body.append(
          sRow("smart:all", "tray", "All Notes", cnt("smart:all")),
          sRow("smart:attention", "smart", "Needs Attention", cnt("smart:attention")),
          sRow("smart:running", "smart", "Running", cnt("smart:running")),
          sRow("smart:hl", "marker", "Highlights", allHighlights().length));
      }
      for (const w of workspaces) {
        const folded = st.wsFold.has(w.id);
        body.append(h("div", { class: "sh", title: w.dir, onclick: () => { folded ? st.wsFold.delete(w.id) : st.wsFold.add(w.id); render(); } },
          h("span", null, w.name), ic(folded ? "chevr" : "chevd"), h("span", { class: "dir" }, w.dir)));
        if (folded) continue;
        body.append(sRow("ws:" + w.id, "folder", "Notes", cnt("ws:" + w.id)));
        for (const f of folders.filter((f) => f.workspaceId === w.id)) body.append(sRow("folder:" + f.id, "folder", f.name, cnt("folder:" + f.id)));
        if (w.id === "ws-ml") body.append(sRow("smart:q:kv-cache", "smart", "#kv-cache", cnt("smart:q:kv-cache")));
        const ac = cnt("archive:" + w.id);
        if (ac) body.append(sRow("archive:" + w.id, "archive", "Archive", ac));
      }
      const tagCounts = {};
      all.filter((i) => !i.archived).forEach((i) => i.tags.forEach((g) => (tagCounts[g] = (tagCounts[g] || 0) + 1)));
      const tagList = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a] || a.localeCompare(b)).slice(0, 14);
      if (tagList.length) {
        body.append(h("div", { class: "sh" }, h("span", null, "Tags")),
          h("div", { class: "tags" }, tagList.map((g) => h("button", { class: "tchip" + (st.sel === "tag:" + g ? " on" : ""), onclick: () => pickSel("tag:" + g) }, "#" + g))));
      }
      return h("aside", { class: "side" },
        h("div", { class: "bar" }, h("button", { class: "tb", title: "Hide sidebar (⌥⌘S)", onclick: () => { st.sidebar = false; render(); } }, ic("sidebar"))),
        body,
        h("div", { class: "sfoot" }, h("button", { onclick: (e) => openPop("new", e.currentTarget) }, ic("plusc", "sm"), "New Folder")));
    }
    function pickSel(sel) {
      st.sel = sel; st.search = ""; st.galOpen = false;
      if (sel === "smart:hl") { const hl = allHighlights()[0]; st.hlSel = hl && hl.id; if (hl) st.noteId = noteIdForTurn(hl.t, hl.u); }
      else { const v = visible(); if (!v.find((i) => i.id === st.noteId)) st.noteId = v[0] ? v[0].id : null; }
      render();
    }

    /* ---------- list / gallery */
    function renderList() {
      const gallery = st.view === "gallery";
      const v = st.sel === "smart:hl" ? null : visible();
      const n = v ? v.length : allHighlights().length;
      const lead = !st.sidebar ? [h("div", { style: "width:66px;flex:none" }), h("button", { class: "tb", title: "Show sidebar (⌥⌘S)", onclick: () => { st.sidebar = true; render(); } }, ic("sidebar"))] : [];
      const searchBox = gallery ? searchField() : null;
      const bar = h("div", { class: "bar" }, lead,
        h("div", { class: "lt" }, h("b", null, st.search ? "Results" : selName(st.sel)), h("small", null, n + (st.sel === "smart:hl" ? " highlight" : " note") + (n === 1 ? "" : "s"))),
        h("div", { class: "sp" }),
        h("div", { class: "seg" },
          h("button", { class: "tb" + (!gallery ? " on" : ""), title: "View as List (⌘1)", onclick: () => setView("list") }, ic("list")),
          h("button", { class: "tb" + (gallery ? " on" : ""), title: "View as Gallery (⌘2)", onclick: () => setView("gallery") }, ic("grid"))),
        h("button", { class: "tb", title: "Archive note", onclick: () => archiveNote(st.noteId) }, ic("trash")),
        gallery ? [h("button", { class: "tb", title: "New note (⌘N)", onclick: newNote }, ic("compose")), h("div", { class: "vsep" }), searchBox] : null);
      const body = h("div", { class: "lbody", tabindex: "0" });
      fillList(body, v);
      return h("section", { class: "list" + (gallery ? " wide" : "") + (st.sidebar ? "" : " nos") }, bar, body);
    }
    function fillList(body, v) {
      body.replaceChildren();
      const gallery = st.view === "gallery";
      if (st.sel === "smart:hl") {
        const hls = allHighlights();
        body.append(h("div", { class: "gh" }, "Recent"));
        for (const x of hls) {
          body.append(h("div", { class: "row" + (st.hlSel === x.id ? " on" : ""), onclick: () => { st.hlSel = x.id; st.noteId = noteIdForTurn(x.t, x.u); st.flash = '[data-hl="' + x.id + '"]'; render(); } },
            h("div", { class: "rc" },
              h("div", { class: "rt", style: "white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical" }, "“" + plain(x.quote) + "”"),
              h("div", { class: "rl" }, h("span", { class: "dt" }, listDate(x.createdAt)), x.note || x.t.title),
              h("div", { class: "rf" }, ic("doc"), short(x.t.title, 40))),
            h("div", { class: "thumb hlq", style: "background:var(--hl-" + x.color + ")" }, ic("marker"))));
        }
        return;
      }
      if (!v.length) { body.append(h("div", { class: "empty" }, "No Notes", h("small", null, st.search ? "Nothing matches “" + st.search + "”." : "Press ⌘N to start a note here."))); return; }
      const multi = !(st.sel.startsWith("folder:"));
      for (const [g, list] of grouped(v)) {
        body.append(h("div", { class: "gh" + (gallery ? " g" : "") }, g));
        if (gallery) { body.append(h("div", { class: "grid" }, list.map(galleryCard))); continue; }
        for (const it of list) body.append(listRow(it, multi));
      }
    }
    function statusTag(s) {
      if (!s || s === "done") return null;
      if (s === "draft") return h("span", { class: "st plain" }, "Draft");
      const m = D.statuses[s];
      return h("span", { class: "st " + m.tone }, m.label);
    }
    function listRow(it, multi) {
      const f = it.folderId && folders.find((x) => x.id === it.folderId);
      const ws = workspaces.find((w) => w.id === it.ws);
      return h("div", { class: "row" + (st.noteId === it.id ? " on" : ""), "data-id": it.id, draggable: "true",
        ondragstart: (e) => e.dataTransfer.setData("text/plain", it.id),
        onclick: () => openNote(it.id), oncontextmenu: (e) => { e.preventDefault(); openNote(it.id); openPop("row", e, it.id); } },
      h("div", { class: "rc" },
        h("div", { class: "rt" }, it.unread ? h("i", { class: "dot", title: "Unread answer" }) : null, it.kind === "branch" ? ic("branch", "xs") : null, h("span", { class: "rtt" }, it.title)),
        h("div", { class: "rl" }, h("span", { class: "dt" }, listDate(it.date)), statusTag(it.status), it.preview),
        multi ? h("div", { class: "rf" }, ic("folder"), (f ? f.name : "Notes") + (st.sel.startsWith("ws:") || !ws ? "" : " · " + ws.name)) : null),
      it.thumb === "link" ? h("div", { class: "thumb link" }, rootOf(it.t).post.domain.split(".").slice(-2, -1)[0]) : it.thumb === "doc" ? h("div", { class: "thumb doc" }, h("i"), h("i"), h("i"), h("i"), h("i"), h("i")) : null);
    }
    function galleryCard(it) {
      const th = h("div", { class: "gthumb" }, h("b", null, it.title));
      if (it.t && it.kind !== "draft") {
        const r = it.u || rootOf(it.t);
        if (r) {
          if (it.t.kind === "post") th.append(h("div", { class: "lcard", style: "padding:6px;gap:6px;margin:4px 0" }, h("div", { class: "lim", style: "width:30px;height:30px;font-size:7px;padding:3px" }, "link"), h("small", { style: "font-size:9px" }, r.post.domain)));
          else th.append(h("div", null, short(r.question, 140)));
          if (r.answer.length) th.append(h("div", { class: "ga" }, short(r.answer[0], 220)));
        } else th.append(h("div", null, "No additional text"));
      } else if (it.n) th.append(h("ul", { class: "ol", style: "font-size:9px;line-height:1.4;margin:0" }, it.n.outline.map((o) => h("li", { style: "padding-left:9px;margin:1px 0" }, o.text, o.children ? h("ul", { class: "ol", style: "font-size:9px;margin:0 0 0 2px" }, o.children.map((c) => h("li", { style: "padding-left:9px;margin:1px 0" }, c.text))) : null))));
      else th.append(h("div", null, it.kind === "draft" ? it.d.prompt : it.preview));
      const s = statusTag(it.status);
      if (s) th.append(h("span", { class: "gbadge" }, s));
      return h("div", { class: "gcard" + (st.noteId === it.id ? " on" : ""), "data-id": it.id, onclick: () => { st.noteId = it.id; st.galOpen = true; markRead(it); render(); } },
        th, h("div", { class: "gtt" }, it.unread ? h("i", { class: "dot", style: "display:inline-block;margin:0 5px 1px 0" }) : null, it.title), h("div", { class: "gdd" }, it.pinned ? h("span", { style: "display:inline-flex;vertical-align:-2px;margin-right:3px" }, ic("pin", "xs")) : null, listDate(it.date)));
    }
    function setView(v) { st.view = v; st.galOpen = false; render(); }
    function openNote(id) {
      st.noteId = id;
      const it = items().find((i) => i.id === id);
      if (it) markRead(it);
      if (st.view === "gallery") st.galOpen = true;
      render();
    }
    function markRead(it) { if (it.t && it.t.unread) it.t.unread = false; }
    function noteIdForTurn(t, u) {
      if (V === "b" && u) { const b = branchNoteOf(t, u); if (b) return b.id; }
      return t.welcome ? t.id : t.id;
    }

    /* ---------- toolbar + editor */
    function searchField() {
      const inp = h("input", { placeholder: "Search", value: st.search, "data-focus": "search",
        oninput: (e) => { st.search = e.target.value; const body = root.querySelector(".lbody"); if (body) { if (st.sel === "smart:hl") st.sel = "smart:all"; fillList(body, visible()); const lt = root.querySelector(".lt"); if (lt) { lt.firstChild.textContent = st.search ? "Results" : selName(st.sel); lt.lastChild.textContent = visible().length + " notes"; } } } });
      return h("label", { class: "search" }, ic("search", "sm"), inp);
    }
    function edToolbar(it) {
      const m = it ? modelFor(it.id) : null;
      const showModel = V !== "b" && it && it.kind !== "page";
      const lead = [];
      if (st.view === "gallery") lead.push(!st.sidebar ? h("div", { style: "width:66px;flex:none" }) : null,
        h("button", { class: "tb", title: "Back to gallery", onclick: () => { st.galOpen = false; render(); } }, ic("back")),
        h("div", { class: "lt", style: "margin-right:10px" }, h("b", null, selName(st.sel)), h("small", null, "Gallery")));
      return h("div", { class: "bar" }, lead,
        h("button", { class: "tb", title: "New note (⌘N)", onclick: newNote }, ic("compose")),
        h("div", { class: "vsep" }),
        h("button", { class: "tb", title: "Text styles", onclick: (e) => openPop("format", e.currentTarget) }, ic("aa")),
        h("button", { class: "tb", title: "Checklist", onclick: () => toast("Checklists are available in notes you write.") }, ic("check")),
        h("button", { class: "tb", title: "Table", onclick: () => toast("Tables: Format → Table") }, ic("table")),
        h("button", { class: "tb", title: "Attach file or link", onclick: () => toast("Drop a .md report or a link into the note to attach it.") }, ic("clip")),
        h("div", { class: "sp" }),
        showModel ? h("button", { class: "mchip", title: "Model for the next question", onclick: (e) => openPop("model", e.currentTarget, it.id) },
          ic("sparkle", "sm"), h("span", null, PROV[m.provider]), h("span", { class: "pv" }, mLabel(m)), ic("chevd", "xs")) : null,
        V !== "b" && it && it.t && it.t.turns.length ? h("button", { class: "tb", title: "Sources and runs for this note", onclick: (e) => openPop("info", e.currentTarget, it.id) }, ic("info")) : null,
        h("button", { class: "tb", title: "Quick Note (⌘⇧N)", onclick: () => { st.quick = true; st.focus = "quick"; render(); } }, ic("quick")),
        h("button", { class: "tb", title: "Copy note as Markdown", onclick: () => toast("Copied note as Markdown") }, ic("share")),
        st.view === "gallery" ? null : searchField());
    }
    function renderEditor() {
      const it = items().find((i) => i.id === st.noteId);
      const body = h("div", { class: "ebody", onmouseup: onSelect });
      const ed = h("section", { class: "ed", "data-note": st.noteId || "" }, edToolbar(it), body);
      if (!it) body.append(h("div", { class: "empty" }, "No Note Selected"));
      else body.append(renderNote(it));
      if (V === "b" && it && it.t && it.t.turns.length) ed.append(statusLine(it));
      return ed;
    }
    function renderNote(it) {
      const page = h("div", { class: "page" }, h("div", { class: "edate" }, longDate(it.kind === "page" || it.kind === "draft" ? it.date : it.kind === "branch" ? it.u.createdAt : (it.t.createdAt || it.date))));
      if (it.kind === "page") return renderPage(page, it.n);
      if (it.kind === "draft") return renderDraft(page, it.d);
      if (it.kind === "branch") return renderBranchNote(page, it.t, it.u);
      if (V === "d" && it.t.turns.length) return renderDocNote(page, it);
      return renderThread(page, it);
    }
    function titleEl(t) {
      return h("div", { class: "ttl", contenteditable: t.archivedAt ? null : "plaintext-only", spellcheck: "false",
        oninput: (e) => { t.title = e.target.textContent; const r = root.querySelector('.row[data-id="' + t.id + '"] .rtt'); if (r) r.textContent = t.title; },
        onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } } }, t.title);
    }

    /* thread note (variants a, c, e; b without inline branches) */
    function renderThread(page, it) {
      const t = it.t;
      if (it.kind === "welcome") renderWelcomeIntro(page, t);
      else if (!t.turns.length) {
        page.append(askLine({ t, parent: null, relation: "root" }, "Ask a question, or start writing", "big"));
        page.append(h("div", { class: "notice", style: "margin-top:18px" }, ic("info", "sm"),
          h("span", null, "The first line is the note's title. Press Return to ask ", h("b", null, PROV[modelFor(t.id).provider] + " " + modelFor(t.id).model), "; the answer appears under your question.")));
        return page;
      } else {
        page.append(titleEl(t));
        if (t.recap) page.append(h("p", { class: "recap" }, h("b", null, "Summary  "), t.recap));
      }
      if (t.archivedAt) page.append(h("div", { class: "notice" }, ic("archive", "sm"), h("span", { class: "sp" }, "Archived " + listDate(t.archivedAt) + ". Unarchive to ask follow-ups or branch."), h("button", { class: "btn", onclick: () => { t.archivedAt = null; render(); } }, "Unarchive")));
      const root0 = rootOf(t);
      if (root0) {
        const chain = chainOf(t, root0);
        chain.forEach((u, i) => page.append(turnEls(t, u, i === 0)));
        if (!t.archivedAt) page.append(askLine({ t, parent: chain[chain.length - 1], relation: "followup" }, it.kind === "welcome" && chain.length < 2 ? "Ask a follow-up: it continues this conversation" : "Ask a follow-up, or keep writing…"));
        if (V !== "b") {
          for (const u of chain) for (const b of branchesOf(t, u)) page.append(branchSection(t, b, 1));
          if (st.pending && st.pending.t === t) page.append(pendingSection(t));
        }
      } else if (it.kind === "welcome") {
        page.append(askLine({ t, parent: null, relation: "root" }, "Type a question here and press Return", "hero"));
      }
      if (it.kind === "welcome") renderWelcomeOutro(page, t);
      page.append(footer(t));
      return page;
    }
    function turnEls(t, u, isRoot) {
      const frag = document.createDocumentFragment();
      if (isRoot && t.kind === "post") {
        const p = u.post;
        frag.append(h("div", { class: "lcard" }, h("div", { class: "lim" }, p.domain.split(".").slice(-2, -1)[0]),
          h("div", null, h("b", null, p.linkTitle), h("small", null, p.domain + " · " + p.author))));
        return frag;
      }
      if (isRoot && t.kind === "document") {
        frag.append(h("div", { class: "att" }, ic("doc", "sm"), "Imported from a Markdown report · " + longDate(u.createdAt)));
        const dbody = h("div", { class: "docbody", "data-tb": u.id });
        u.answer.forEach((p, i) => dbody.append(paraEl(t, u, p, i)));
        frag.append(dbody);
        frag.append(section("prompt-" + t.id, h("h3", null, "Prompt that generated this report"), null, [h("p", { class: "q", style: "font-weight:400" }, inl(u.question))]));
        return frag;
      }
      if (!(t._titleIsQuestion && isRoot)) frag.append(h("div", { class: "q", "data-q": u.id }, inl(u.question)));
      else frag.append(h("div", { "data-q": u.id }));
      frag.append(answerBlock(t, u));
      if (V === "b") for (const b of branchesOf(t, u)) frag.append(branchLink(t, b));
      if (V === "b" && st.pending && st.pending.t === t && st.pending.u === u) frag.append(pendingSection(t));
      return frag;
    }
    function paraEl(t, u, p, i) {
      const w = h("div", { class: "pw", "data-p": String(i) }, blocks(p));
      for (const b of t.turns.filter((x) => x.relation === "branch" && x.anchor && x.anchor.turnId === u.id && x.anchor.paragraph === i)) {
        const a = wrapQuote(w, b.anchor.quote, () => h("span", { class: "anch", title: "Branch: " + b.title, onclick: () => goBranch(t, b) }));
        if (a) w.style.position = "relative";
      }
      for (const hl of u.highlights.filter((x) => x.paragraph === i)) {
        wrapQuote(w, hl.quote, () => h("span", { class: "hl " + (hl.color || "amber") + (hl.note ? " noted" : ""), "data-hl": hl.id, title: hl.note || "Highlight" }));
      }
      const nb = t.turns.filter((x) => x.relation === "branch" && x.anchor && x.anchor.turnId === u.id && x.anchor.paragraph === i);
      if (nb.length) w.prepend(h("button", { class: "bmark", title: nb.length + " branch" + (nb.length > 1 ? "es" : "") + " from this paragraph", onclick: () => goBranch(t, nb[0]) }, ic("branch", "xs")));
      return w;
    }
    function goBranch(t, b) {
      if (V === "b") { st.noteId = b.id; render(); return; }
      st.collapsed.delete("sec-" + b.id);
      if (V === "d") { st.scrollTo = '[data-sec="sec-' + b.id + '"]'; render(); return; }
      render();
      const el = root.querySelector('[data-sec="sec-' + b.id + '"]');
      if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    function answerBlock(t, u) {
      const cls = u.status === "failed" ? " fail" : u.status === "needs-review" ? " review" : u.status === "queued" ? " queued" : "";
      const el = h("div", { class: "ans" + cls, "data-tb": u.id });
      if (u.status === "queued") {
        el.append(h("div", { class: "qline" }, ic("clock", "sm"), h("span", { class: "sp" }, "Queued. It starts when the answer above finishes; one answer runs at a time in a conversation."),
          h("button", { onclick: () => { t.turns = t.turns.filter((x) => x !== u); render(); } }, "Remove")));
        return el;
      }
      if (u.status === "running") el.append(runLine(u));
      u.answer.forEach((p, i) => el.append(paraEl(t, u, p, i)));
      if (u._streaming && u.answer.length) { const ps = el.querySelectorAll(".ap"); const lastP = ps[ps.length - 1]; if (lastP) lastP.append(h("span", { class: "caret" })); }
      if (u.status === "failed") {
        el.append(h("div", { class: "errbox" }, h("div", { class: "et" }, ic("alert", "sm"), "Run failed after " + fmtDur(u.durationSec || 0)),
          h("code", null, u.error || "The agent exited with an error."),
          h("button", { onclick: () => { u.error = null; u.answer = []; startRun(t, u); } }, "Retry"), " ",
          h("button", { onclick: () => { const q = u.question; t.turns = t.turns.filter((x) => x !== u); st.compose[t.id + ":followup"] = q; st.focus = "ask-" + t.id + "-followup"; render(); } }, "Edit question"), " ",
          h("button", { class: "mc", style: "background:none", onclick: (e) => openPop("trace", e.currentTarget, u.id) }, "Show steps")));
      }
      if (u.status === "needs-review" && u.clarification) {
        const key = t.id + ":clar";
        const ta = h("textarea", { placeholder: "Reply, and the run continues…", rows: "1", "data-focus": "clar-" + t.id,
          oninput: (e) => { st.compose[key] = e.target.value; autoGrow(e.target); },
          onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const v = e.target.value.trim(); if (!v) return; st.compose[key] = ""; u.status = "done"; ask({ t, parent: chainOf(t, u).pop(), relation: "followup" }, v); } } });
        ta.value = st.compose[key] || "";
        el.append(h("div", { class: "clar" }, h("div", { class: "ct" }, PROV[u.provider] + " needs an answer before it continues"), h("div", null, u.clarification), ta));
      }
      if (u.status !== "running") el.append(metaLine(t, u));
      return el;
    }
    function runLine(u) {
      const step = u.activity[u.activity.length - 1];
      const since = Date.parse(u.createdAt);
      return h("div", { class: "runl" }, h("span", { class: "spin" }), "Running",
        h("span", { class: "lab" }, step ? "· " + step.label : ""),
        h("span", { class: "el", "data-since": String(since) }, fmtDur((nowMs() - since) / 1000)),
        h("button", { onclick: (e) => openPop("trace", e.currentTarget, u.id) }, u.activity.length + " steps"),
        h("button", { onclick: () => stopRun(u) }, ic("stop", "xs"), "Stop"));
    }
    function metaLine(t, u) {
      const parts = [];
      const add = (x) => { if (parts.length) parts.push(h("span", { class: "sepd" }, "·")); parts.push(x); };
      add(h("span", { class: "mc", title: "Model that wrote this answer" }, PROV[u.provider] + " " + u.model + (u.effort ? " · " + u.effort : "")));
      if (u.status === "cancelled") add(h("span", { class: "mc" }, "Stopped"));
      if (u.durationSec != null) add(h("span", { class: "mc" }, fmtDur(u.durationSec)));
      if (u.sources.length) add(h("button", { class: "mc", onclick: (e) => openPop("sources", e.currentTarget, u.id) }, ic("link"), u.sources.length + " source" + (u.sources.length > 1 ? "s" : "")));
      if (u.activity.length) add(h("button", { class: "mc", onclick: (e) => openPop("trace", e.currentTarget, u.id) }, ic("term"), u.activity.length + " steps"));
      if (u.answer.length && !t.archivedAt && V !== "d") add(h("button", { class: "mc", title: "Branch from the whole answer (⇧⌘↵)", onclick: () => beginBranch(t, u, null, null) }, ic("branch"), "Branch"));
      return h("div", { class: "meta" }, parts);
    }
    function section(key, head, cnt, kids, extra) {
      const el = h("div", Object.assign({ class: "sec" + (st.collapsed.has(key) ? " folded" : ""), "data-sec": key }, extra || {}),
        h("div", { class: "sech", onclick: (e) => { if (e.target.closest(".ttl")) return; const f = el.classList.toggle("folded"); f ? st.collapsed.add(key) : st.collapsed.delete(key); } },
          h("span", { class: "fold" }, ic("chevd")), head, cnt ? h("span", { class: "cnt" }, cnt) : null),
        h("div", { class: "secb" }, kids));
      return el;
    }
    function branchSection(t, b, depth) {
      const chain = chainOf(t, b);
      const kids = [h("div", { class: "from" }, ic("branch"), h("span", null, "Branch from"), h("q", { onclick: () => { st.flash = '[data-tb="' + b.anchor.turnId + '"] .anch'; render(); } }, short(b.anchor ? b.anchor.quote : "the whole answer", 90)))];
      chain.forEach((u) => kids.push(turnEls(t, u, false)));
      for (const u of chain) for (const bb of branchesOf(t, u)) kids.push(branchSection(t, bb, depth + 1));
      if (!t.archivedAt) kids.push(askLine({ t, parent: chain[chain.length - 1], relation: "followup", key: b.id }, "Follow up in this branch…", "sub"));
      const n = subtree(t, b).length;
      const s = statusOf(subtree(t, b));
      return section("sec-" + b.id, h(depth > 1 ? "h3" : "h2", null, b.title), (n > 1 ? n + " questions" : "1 question") + (s !== "done" ? " · " + D.statuses[s].label : ""), kids);
    }
    function pendingSection(t) {
      const p = st.pending;
      const kids = [h("div", { class: "from" }, ic("branch"), h("span", null, "Branch from"), h("q", null, p.quote ? short(p.quote, 90) : "the whole answer")),
        askLine({ t, parent: p.u, relation: "branch", anchor: p.quote ? { turnId: p.u.id, paragraph: p.paragraph, quote: p.quote } : null, key: "pending" }, "Ask a question about this passage. Esc cancels.")];
      if (V === "b") return h("div", { class: "sec", "data-sec": "pending" }, kids);
      return section("pending", h("h2", null, "New branch"), null, kids);
    }
    function branchLink(t, b) {
      const n = subtree(t, b).length;
      const s = statusOf(subtree(t, b));
      return h("div", { class: "from", style: "margin:-4px 0 12px 17px" }, ic("branch"),
        h("span", { class: "nlink", onclick: () => { st.noteId = b.id; render(); } }, b.title),
        h("span", { style: "color:var(--ink3)" }, n + (n > 1 ? " questions" : " question") + (s !== "done" ? " · " + D.statuses[s].label : "")));
    }
    function footer(t) {
      const th = TH();
      const linked = [...new Set([...(t.links || []), ...threads.filter((x) => (x.links || []).includes(t.id)).map((x) => x.id)])].filter((id) => th[id] && id !== t.id);
      const mentioned = pages.filter((n) => JSON.stringify(n.outline).includes('"threadId":"' + t.id + '"'));
      const tagsRow = t.tags.length ? h("div", { class: "fl" }, h("span", { class: "fk" }, "Tags"), t.tags.map((g) => h("span", { class: "tagt big", onclick: () => pickSel("tag:" + g) }, "#" + g))) : null;
      if (!tagsRow && !linked.length && !mentioned.length) return null;
      return h("div", { class: "foot" }, tagsRow,
        linked.length ? h("div", { class: "fl" }, h("span", { class: "fk" }, "Linked notes"), h("div", null, linked.map((id) => h("div", null, h("span", { class: "nlink", onclick: () => openNote(id) }, th[id].title))))) : null,
        mentioned.length ? h("div", { class: "fl" }, h("span", { class: "fk" }, "Mentioned in"), h("div", null, mentioned.map((n) => h("div", null, h("span", { class: "nlink", onclick: () => openNote(n.id) }, n.title))))) : null);
    }

    /* ask line */
    function autoGrow(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }
    function askLine(target, placeholder, size) {
      const t = target.t;
      const key = t.id + ":" + (target.key || target.relation);
      const fkey = "ask-" + t.id + "-" + (target.key || target.relation);
      const m = modelFor(t.id);
      const wrap = h("div", { class: "askl" + (size ? " " + size : "") });
      const ta = h("textarea", { rows: "1", placeholder, "data-focus": fkey, "data-ask": "1",
        oninput: (e) => {
          st.compose[key] = e.target.value; autoGrow(e.target); wrap.classList.toggle("has", !!e.target.value.trim());
          if (target.relation === "root" && !t.turns.length && !t.welcome) { t.title = e.target.value.split("\n")[0] || "New Note"; const r = root.querySelector('.row[data-id="' + t.id + '"] .rtt'); if (r) r.textContent = t.title; }
        },
        onkeydown: (e) => {
          if (e.key === "Escape" && target.key === "pending") { st.pending = null; render(); return; }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            const v = e.target.value.trim();
            if (!v) return;
            st.compose[key] = "";
            if (target.relation === "branch") st.pending = null;
            ask(target, v);
          }
        } });
      ta.value = st.compose[key] || "";
      if (ta.value.trim()) wrap.classList.add("has");
      wrap.append(ta, h("div", { class: "askh" }, h("span", null, PROV[m.provider] + " " + m.model), h("span", { class: "kbd" }, "Return ↵")));
      requestAnimationFrame(() => { if (ta.value) autoGrow(ta); });
      return wrap;
    }

    /* page note (outline notes) */
    function renderPage(page, n) {
      page.append(h("div", { class: "ttl", contenteditable: "plaintext-only" }, n.title));
      const checklist = n.tags.includes("checklist");
      const th = TH();
      const itemEl = (o) => {
        const done = checklist && !/^Open:|pending/i.test(o.text);
        const txt = o.ref ? h("span", { class: "nlink", style: "text-decoration-color:var(--acc)", title: "Open " + (th[o.ref.threadId] || {}).title,
          onclick: () => openRef(o.ref) }, o.text) : o.text;
        const li = h("li", { class: done ? "done" : "" }, txt);
        if (o.children) li.append(h("ul", { class: "ol" }, o.children.map(itemEl)));
        return li;
      };
      let loose = [];
      const flush = () => { if (loose.length) { page.append(h("ul", { class: "ol" + (checklist ? " chk" : "") }, loose.map(itemEl))); loose = []; } };
      n.outline.forEach((o, i) => {
        if (o.children) {
          flush();
          const head = h("h2", null, o.ref ? h("span", { class: "nlink", onclick: (e) => { e.stopPropagation(); openRef(o.ref); } }, o.text) : o.text);
          page.append(section("pg-" + n.id + "-" + i, head, null, [h("ul", { class: "ol" + (checklist ? " chk" : "") }, o.children.map(itemEl))]));
        } else loose.push(o);
      });
      flush();
      page.append(h("div", { class: "askl", style: "margin-top:18px" }, h("textarea", { rows: "1", placeholder: "Keep writing. Type >> to link a note, # to tag.", oninput: (e) => autoGrow(e.target) })));
      page.append(h("div", { class: "foot" }, h("div", { class: "fl" }, h("span", { class: "fk" }, "Tags"), n.tags.map((g) => h("span", { class: "tagt big", onclick: () => pickSel("tag:" + g) }, "#" + g)))));
      return page;
    }
    function openRef(ref) {
      const t = threads.find((x) => x.id === ref.threadId);
      if (!t) return;
      const u = ref.turnId && t.turns.find((x) => x.id === ref.turnId);
      st.noteId = noteIdForTurn(t, u);
      t.unread = false;
      if (u) {
        let cur = u;
        while (cur) { st.collapsed.delete("sec-" + cur.id); cur = t.turns.find((x) => x.id === cur.parentId); }
        st.flash = '[data-q="' + u.id + '"]';
      }
      if (!matchSel(items().find((i) => i.id === st.noteId), st.sel)) st.sel = "smart:all";
      if (st.view === "gallery") st.galOpen = true;
      render();
    }
    function renderDraft(page, d) {
      page.append(h("div", { class: "ttl" }, "Draft question"));
      page.append(h("div", { class: "notice" }, ic("pencil", "sm"), h("span", null, "Not sent yet. Edit the question and press Return to ask " + PROV[d.provider] + " " + d.model + ".")));
      const fake = { id: d.id, turns: [], welcome: false };
      const key = d.id + ":root";
      if (st.compose[key] == null) st.compose[key] = d.prompt;
      const al = askLine({ t: fake, parent: null, relation: "root" }, "Question");
      al.querySelector("textarea").onkeydown = (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const v = e.target.value.trim(); if (!v) return;
          drafts = drafts.filter((x) => x !== d);
          const t = newThread(d.workspaceId, null, short(v, 70));
          st.modelFor[t.id] = { provider: d.provider, model: d.model, effort: null };
          st.noteId = t.id;
          ask({ t, parent: null, relation: "root" }, v);
        }
      };
      page.append(al);
      return page;
    }
    function renderBranchNote(page, t, b) {
      page.append(titleEl(b));
      const parentNote = noteIdForTurn(t, t.turns.find((x) => x.id === b.parentId));
      const pt = parentNote === t.id ? t.title : (t.turns.find((x) => x.id === parentNote) || {}).title;
      page.append(h("div", { class: "from", style: "margin:0 0 4px" }, ic("branch"), h("span", null, "Branched from"), h("span", { class: "nlink", onclick: () => { st.noteId = parentNote; st.flash = '[data-tb="' + b.parentId + '"] .anch'; render(); } }, pt)));
      if (b.anchor) page.append(h("blockquote", { style: "margin:10px 0 4px;padding:2px 0 2px 14px;border-left:3px solid var(--hair2);color:var(--ink2);font-size:14px;line-height:1.5" }, inl(b.anchor.quote)));
      const chain = chainOf(t, b);
      chain.forEach((u) => page.append(turnEls(t, u, false)));
      if (!t.archivedAt) page.append(askLine({ t, parent: chain[chain.length - 1], relation: "followup", key: b.id }, "Ask a follow-up in this branch…"));
      page.append(footer(t));
      return page;
    }

    /* variant d: note is the document, questions are in the drawer */
    function renderDocNote(page, it) {
      const t = it.t;
      page.append(titleEl(t));
      if (t.recap) page.append(h("p", { class: "recap" }, h("b", null, "Summary  "), t.recap));
      const r = rootOf(t);
      if (t.kind === "post" || t.kind === "document") { chainOf(t, r).forEach((u, i) => page.append(turnEls(t, u, i === 0))); page.append(footer(t)); return page; }
      const walk = (u, depth) => {
        const kids = [];
        if (u.relation === "branch") kids.push(h("div", { class: "from", style: "margin-bottom:6px" }, ic("branch"), h("span", null, "Branch from"), h("q", null, short(u.anchor ? u.anchor.quote : "the whole answer", 80))));
        if (u.status === "queued") kids.push(h("div", { class: "qline" }, ic("clock", "sm"), "Queued: " + plain(u.question)));
        else {
          const blk = answerBlock(t, u);
          blk.classList.add("docp");
          blk.style.cssText = "border:0;padding:0;margin:6px 0 4px;color:var(--ink);font-size:14.5px";
          kids.push(blk);
        }
        page.append(section("sec-" + u.id, h(depth ? "h3" : "h2", null, u.title), u.relation === "branch" ? "branch" : null, kids, { "data-turn": u.id }));
      };
      const order = [];
      const visit = (u, depth) => { order.push([u, depth]); };
      const chain = chainOf(t, r);
      chain.forEach((u) => visit(u, 0));
      const addBranches = (u, depth) => { for (const b of branchesOf(t, u)) { const c = chainOf(t, b); c.forEach((x) => { visit(x, depth); }); c.forEach((x) => addBranches(x, depth + 1)); } };
      chain.forEach((u) => addBranches(u, 1));
      order.forEach(([u, d]) => walk(u, d));
      page.append(footer(t));
      return page;
    }
    function renderDrawer() {
      const it = items().find((i) => i.id === st.noteId);
      const t = it && it.t;
      const body = h("div", { class: "dbody" });
      const dr = h("aside", { class: "drawer" }, h("div", { class: "bar" }, h("div", { class: "lt" }, h("b", null, "Questions"), h("small", null, t ? t.turns.length + " in this note" : "")), h("div", { class: "sp" })), body);
      if (!t || it.kind === "page") { body.append(h("div", { class: "empty", style: "font-size:13px" }, "No questions", h("small", null, "Questions and their runs for the selected note are listed here."))); return dr; }
      const r = rootOf(t);
      const card = (u, br) => h("div", { class: "dc" + (br ? " br" : ""), "data-dc": u.id, onclick: () => { st.collapsed.delete("sec-" + u.id); st.flash = '[data-turn="' + u.id + '"]'; render(); } },
        br && u.relation === "branch" ? h("div", { class: "dfrom" }, "“" + short(u.anchor ? u.anchor.quote : "whole answer", 50) + "”") : null,
        h("div", { class: "dq" }, plain(u.question)),
        h("div", { class: "dm" }, u.status === "running" ? h("span", { class: "spin", style: "color:var(--run)" }) : null, statusTag(u.status) || h("span", null, fmtDur(u.durationSec || 0)), h("span", null, "· " + u.model)));
      if (r) {
        const chain = chainOf(t, r);
        const add = (u, br) => { body.append(card(u, br)); };
        const addB = (u) => { for (const b of branchesOf(t, u)) { chainOf(t, b).forEach((x) => { add(x, true); addB(x); }); } };
        chain.forEach((u) => add(u, false));
        chain.forEach((u) => addB(u));
      }
      const key = t.id + ":drawer";
      const m = modelFor(t.id);
      const ta = h("textarea", { placeholder: st.pending ? "Ask about the selected passage…" : r ? "Ask a follow-up" : "Ask a question", "data-focus": "drawer", "data-ask": "1",
        oninput: (e) => { st.compose[key] = e.target.value; },
        onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } if (e.key === "Escape") { st.pending = null; render(); } } });
      ta.value = st.compose[key] || "";
      const send = () => {
        const v = ta.value.trim(); if (!v) return;
        st.compose[key] = "";
        if (st.pending) { const p = st.pending; st.pending = null; ask({ t, parent: p.u, relation: "branch", anchor: p.quote ? { turnId: p.u.id, paragraph: p.paragraph, quote: p.quote } : null }, v); }
        else ask({ t, parent: r ? chainOf(t, r).pop() : null, relation: r ? "followup" : "root" }, v);
      };
      dr.append(h("div", { class: "dask" },
        st.pending ? h("div", { class: "dbr" }, ic("branch", "sm"), h("span", { class: "sp", style: "overflow:hidden;white-space:nowrap;text-overflow:ellipsis" }, "Branch from “" + short(st.pending.quote || "the whole answer", 40) + "”"), h("button", { class: "mc", onclick: () => { st.pending = null; render(); } }, "Cancel")) : null,
        h("div", { class: "dbox" }, ta, h("div", { class: "drow" },
          h("button", { class: "mchip", style: "height:24px;padding:0 6px", onclick: (e) => openPop("model", e.currentTarget, t.id) }, ic("sparkle", "sm"), h("span", { class: "pv" }, PROV[m.provider] + " " + mLabel(m))),
          h("div", { class: "sp" }), h("button", { class: "send", title: "Ask (Return)", onclick: send }, ic("up"))))));
      requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
      return dr;
    }

    /* variant b status line */
    function statusLine(it) {
      const t = it.t;
      const scope = it.u ? chainOf(t, it.u) : chainOf(t, rootOf(t));
      const last = scope[scope.length - 1];
      const m = modelFor(it.id);
      const s = last.status;
      const label = s === "running" ? [h("span", { class: "spin", style: "color:var(--run)" }), h("span", { style: "color:var(--run);font-weight:500" }, "Running"), h("span", { class: "lab" }, (last.activity.slice(-1)[0] || {}).label || ""), h("span", { class: "el", "data-since": Date.parse(last.createdAt) }, fmtDur((nowMs() - Date.parse(last.createdAt)) / 1000))]
        : s === "failed" ? [h("span", { style: "color:var(--err);font-weight:600" }, "Last run failed")] : s === "needs-review" ? [h("span", { style: "color:var(--warn);font-weight:600" }, "Waiting for your reply")]
          : s === "queued" ? [h("span", null, "Queued")] : [h("span", { style: "color:var(--ink2);font-weight:400" }, ic("ok", "xs"), " Last answer took " + fmtDur(last.durationSec || 0) + " · " + listDate(last.completedAt || last.createdAt))];
      return h("div", { class: "sline" },
        h("button", { class: "mchip", onclick: (e) => openPop("model", e.currentTarget, it.id) }, ic("sparkle", "sm"), PROV[m.provider], h("span", { class: "pv" }, mLabel(m)), ic("chevd", "xs")),
        h("div", { class: "vsep" }), h("div", { class: "runl", style: "margin:0;gap:6px" }, label), h("div", { class: "sp" }),
        last.sources.length ? h("button", { class: "mc", onclick: (e) => openPop("sources", e.currentTarget, last.id) }, ic("link"), last.sources.length + " sources") : null,
        last.activity.length ? h("button", { class: "mc", onclick: (e) => openPop("trace", e.currentTarget, last.id) }, ic("term"), last.activity.length + " steps") : null);
    }

    /* welcome note */
    function renderWelcomeIntro(page, t) {
      page.append(h("div", { class: "ttl" }, "Welcome to Session"));
      page.append(h("p", { class: "q", style: "font-weight:400;margin-top:4px" }, "Session sends your questions to the coding-agent command-line tools installed on this Mac and keeps each question and its answer in a note. You can edit, tag, link and file those notes like any others. Answers appear under the question, marked with a yellow rule."));
      const row = (id, name, cmd) => {
        const s = agents[id];
        const pill = s === "ready" ? h("span", { class: "pill ok" }, ic("ok", "sm"), "Ready") : s === "checking" ? h("span", { class: "pill plain" }, h("span", { class: "spin" }), "Checking…") : s === "signin" ? h("span", { class: "pill warn" }, ic("alert", "sm"), "Not signed in") : h("span", { class: "pill plain" }, "Not installed");
        const act = s === "ready" ? h("span", { style: "color:var(--ink2)" }, (D.providers.find((p) => p.id === id) || { models: [] }).models.slice(0, 3).join(", ")) :
          h("span", null, s === "signin" ? h("span", { class: "pcmd" }, cmd) : h("span", { style: "color:var(--ink2)" }, "Install the CLI, then sign in."), " ",
            h("button", { class: "btn", onclick: () => { agents[id] = "checking"; render(); later(() => { agents[id] = id === "codex" ? "ready" : "missing"; render(); if (id !== "codex") toast("Grok CLI not found on PATH"); }, 900); } }, "Check again"));
        return h("tr", null, h("td", null, h("b", null, name)), h("td", null, pill), h("td", null, act));
      };
      page.append(section("w-agents", h("h2", null, "Agents on this Mac"), null, [
        h("table", { class: "tbl" }, h("tr", null, h("th", { style: "width:120px" }, "Agent"), h("th", { style: "width:130px" }, "Status"), h("th", null, "Models or next step")),
          row("claude", "Claude Code", "claude auth login"), row("codex", "Codex", "codex login"), row("grok", "Grok", "grok login")),
        h("p", { class: "recap", style: "font-size:12.5px" }, "Session checks again when its window becomes active. Any one ready agent is enough to start.")]));
      const w = st.wel;
      w.asked = t.turns.length > 0;
      w.followed = t.turns.some((u) => u.relation === "followup");
      w.branched = t.turns.some((u) => u.relation === "branch");
      w.tagged = t.tags.length > 0;
      const ck = (done, a, b) => h("li", { class: done ? "done" : "" }, h("b", { style: "font-weight:600" }, a), " " + b);
      page.append(section("w-try", h("h2", null, "Try it"), [w.asked, w.followed, w.branched, w.tagged].filter(Boolean).length + " of 4 done", [h("ul", { class: "ol chk" },
        ck(w.asked, "Ask a question.", "Type it in the box below and press Return."),
        ck(w.followed, "Ask a follow-up.", "Type under the answer. It continues the same conversation."),
        ck(w.branched, "Branch.", "Select part of an answer and choose Branch. The branch becomes a section you can fold."),
        ck(w.tagged, "Tag it.", "Put a #tag in a question. Tags collect notes in the sidebar."))]));
      if (t.turns.length) page.append(h("h2", { style: "font-size:19px;margin:26px 0 0" }, "Your questions"));
    }
    function renderWelcomeOutro(page, t) {
      page.append(section("w-where", h("h2", null, "Where things go"), null, [h("ul", { class: "ol" },
        h("li", null, h("b", null, "Workspace: "), "a folder on disk (" + (workspaces.find((x) => x.id === t.workspaceId) || {}).dir + "). Each workspace is a section in the sidebar."),
        h("li", null, h("b", null, "Folders "), "group notes inside a workspace. “Notes” lists every note in the workspace, filed or not."),
        h("li", null, h("b", null, "Pin "), "keeps a note at the top of the list. ", h("b", null, "Highlight "), "keeps a passage; all highlights are listed under Highlights."),
        h("li", null, h("b", null, "Smart Folders "), "are saved searches, for example Running, Needs Attention or a tag."))]));
    }

    /* ---------- asking + simulated runs */
    function newThread(wsId, folderId, title) {
      const t = { id: uid("t-new"), workspaceId: wsId, folderId: folderId || null, kind: "exchange", title: title || "", provider: "claude", model: "opus", effort: "high", status: "done",
        createdAt: nowISO(), updatedAt: nowISO(), unread: false, bookmarked: false, followed: false, archivedAt: null, recap: null, tags: [], links: [], turns: [] };
      threads.unshift(t);
      return t;
    }
    function newNote() {
      const ws = selWs();
      const f = st.sel.startsWith("folder:") ? st.sel.slice(7) : null;
      if (!(st.sel.startsWith("ws:") || st.sel.startsWith("folder:") || st.sel === "smart:all")) st.sel = "ws:" + ws;
      const t = newThread(ws, f, "");
      st.noteId = t.id; st.search = "";
      if (st.view === "gallery") st.galOpen = true;
      st.focus = "ask-" + t.id + "-root";
      render();
    }
    function ask(target, text) {
      const t = target.t;
      const m = modelFor(t.id);
      const tagM = text.match(/(?:^|\s)#([a-z][\w-]*)/g);
      if (tagM) tagM.forEach((x) => { const g = x.trim().slice(1); if (!t.tags.includes(g)) t.tags.push(g); });
      const titleish = short(text.replace(/(?:^|\s)#[a-z][\w-]*/g, ""), 60);
      const u = { id: uid("q"), parentId: target.parent ? target.parent.id : null, relation: target.parent ? target.relation : "root", anchor: target.anchor || null, question: text,
        title: titleish, provider: m.provider, model: m.model, effort: m.effort, status: "queued", createdAt: nowISO(), completedAt: null, durationSec: null, starred: false, recap: null,
        answer: [], error: null, sources: [], activity: [], highlights: [], threadId: t.id, _local: true };
      if (!target.parent && !t.welcome) { t._titleIsQuestion = true; t.title = t.title || titleish; t.title = short(t.title, 80); }
      t.turns.push(u);
      t.updatedAt = nowISO();
      const busy = t.turns.some((x) => x !== u && (x.status === "running" && x._streaming));
      if (!busy) startRun(t, u);
      if (V === "b" && u.relation === "branch") st.noteId = u.id;
      st.focus = V === "d" ? "drawer" : "ask-" + t.id + "-" + (target.relation === "branch" ? u.id : (target.key && target.key !== "pending" ? target.key : u.relation === "root" && !t.welcome ? "followup" : "followup"));
      st.scrollTo = '[data-tb="' + u.id + '"]';
      if (st.sel !== "smart:all" && !matchSel(items().find((i) => i.id === st.noteId) || { tags: [], archived: false }, st.sel)) st.sel = "ws:" + t.workspaceId;
      render();
    }
    function canned(t, u) {
      const ws = t.workspaceId;
      const q = short(u.question, 70);
      if (ws === "ws-compilers") return [
        "Read `src/jit/arm64/masm.rs` and `src/jit/x64/masm.rs` for the code paths involved in “" + q + "”. Both architectures lower through `emit_dataview_load`, so a fix in the shared lowering covers every call site; no per-architecture patch is needed.",
        "`cargo test -p kestrel-jit dataview` passes (217 tests). I did not run test262; the relevant directory is `built-ins/DataView`, which takes about four minutes."];
      if (ws === "ws-ml") return [
        "For “" + q + "”: at 320 KiB per token (Llama-3-70B, fp16 KV), the estimate is dominated by KV memory, not weights. With TP=2 each GPU holds half of every block, so the per-GPU budget is the number to compare.",
        "Measured against `configs/serving/llama3-70b.yaml`: the free-block watermark (0.04) reserves about 3 GB per GPU. Lowering it further trades preemption latency for capacity; I would keep it."];
      if (ws === "ws-reading") return [
        "Short answer to “" + q + "”: the sources agree on the mechanism and differ on the cost. The Raft dissertation (section 4.3) and the 2015 errata cover the membership case; the Kreps essay covers the log abstraction.",
        "I linked the two notes in this workspace that already discuss this. Neither needs to change."];
      return [
        "This is a sample answer. " + PROV[u.provider] + " (" + u.model + ") runs in the workspace folder with this note's earlier questions and answers as context, and its answer streams here, under your question.",
        "Files it read, commands it ran and pages it fetched are listed under “steps”; links it cited are under “sources”. Select any part of this answer and choose Branch to ask about just that part."];
    }
    function startRun(t, u) {
      u.status = "running"; u._streaming = true; u.activity = []; u.answer = []; u.createdAt = nowISO();
      const plan = [
        { kind: "think", label: "Planned: read the earlier answers in this note", ms: 1800 },
        { kind: "grep", label: "Searched code: " + (short(u.question, 28) || "question"), detail: "4 matches", ms: 300 },
        { kind: "read", label: t.workspaceId === "ws-ml" ? "Read configs/serving/llama3-70b.yaml" : t.workspaceId === "ws-compilers" ? "Read src/jit/arm64/masm.rs" : "Read notes in this workspace", ms: 140 }];
      const paras = canned(t, u);
      let i = 0;
      const step = () => {
        if (u.activity.length) u.activity[u.activity.length - 1].status = "ok";
        if (i < plan.length) { u.activity.push(Object.assign({ status: "running" }, plan[i++])); refreshTurn(t, u); u._timer = later(step, 650); return; }
        words(0, 0);
      };
      const words = (pi, wi) => {
        if (pi >= paras.length) return finish();
        const ws = paras[pi].split(" ");
        u.answer[pi] = ws.slice(0, wi + 3).join(" ");
        refreshTurn(t, u);
        if (wi + 3 >= ws.length) u._timer = later(() => words(pi + 1, 0), 120);
        else u._timer = later(() => words(pi, wi + 3), 38);
      };
      const finish = () => {
        u._streaming = false; u.status = "done"; u.completedAt = nowISO(); u.durationSec = Math.max(3, Math.round((Date.now() - (u._t0 || Date.now())) / 1000));
        const srcs = D.sources.filter((s) => s.refs.some((r) => { const tt = D.byId.threads[r.threadId]; return tt && tt.workspaceId === t.workspaceId; })).slice(0, 2);
        u.sources = srcs.map((s) => ({ url: s.url, title: s.title, domain: s.domain }));
        t.updatedAt = nowISO();
        const next = t.turns.find((x) => x.status === "queued" && x.createdAt >= u.createdAt && x._local);
        render();
        if (next) startRun(t, next);
      };
      u._t0 = Date.now();
      u._timer = later(step, 250);
    }
    function stopRun(u) {
      if (u._timer) cancel(u._timer);
      u._streaming = false; u.status = "cancelled";
      u.durationSec = Math.round((nowMs() - Date.parse(u.createdAt)) / 1000);
      render();
    }
    function refreshTurn(t, u) {
      const old = root.querySelector('.ans[data-tb="' + u.id + '"]');
      if (old) {
        const nb = answerBlock(t, u);
        if (old.classList.contains("docp")) { nb.classList.add("docp"); nb.style.cssText = old.style.cssText; }
        old.replaceWith(nb);
      }
      const dc = root.querySelector('[data-dc="' + u.id + '"]');
      if (dc && $drawer) { const nd = renderDrawer(); $drawer.replaceWith(nd); $drawer = nd; }
      const sl = root.querySelector(".sline");
      if (sl && V === "b") { const it = items().find((i) => i.id === st.noteId); if (it && it.t === t) sl.replaceWith(statusLine(it)); }
    }

    /* ---------- selection → branch / highlight */
    function onSelect() {
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) { closeSelbar(); return; }
        const a = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
        const blk = a && a.closest("[data-tb]");
        const pw = a && a.closest("[data-p]");
        if (!blk || !pw || !root.contains(blk)) { closeSelbar(); return; }
        const quote = sel.toString().trim();
        if (quote.length < 3) { closeSelbar(); return; }
        const [t, u] = turnById(blk.getAttribute("data-tb"));
        if (!u) return;
        const r = sel.getRangeAt(0).getBoundingClientRect();
        const pos = rel(r);
        closeSelbar();
        const busy = u.status === "running";
        $selbar = h("div", { class: "selbar", style: "left:" + Math.max(8, pos.x + pos.w / 2 - 110) + "px;top:" + Math.max(56, pos.y - 42) + "px" },
          busy ? h("span", { class: "dis" }, "Branch and Highlight are available when the answer finishes") : [
            h("button", { onmousedown: (e) => e.preventDefault(), onclick: () => { closeSelbar(); beginBranch(t, u, Number(pw.getAttribute("data-p")), quote); } }, ic("branch", "sm"), "Branch"),
            h("button", { onmousedown: (e) => e.preventDefault(), onclick: () => { u.highlights.push({ id: uid("h"), paragraph: Number(pw.getAttribute("data-p")), quote, color: "amber", note: null, createdAt: nowISO() }); window.getSelection().removeAllRanges(); closeSelbar(); render(); toast("Highlighted. Listed under Highlights."); } }, ic("marker", "sm"), "Highlight"),
            h("button", { onmousedown: (e) => e.preventDefault(), onclick: () => { try { navigator.clipboard.writeText(quote); } catch (err) { /* clipboard unavailable */ } closeSelbar(); toast("Copied"); } }, ic("copy", "sm"), "Copy")]);
        root.append($selbar);
      }, 0);
    }
    function closeSelbar() { if ($selbar) { $selbar.remove(); $selbar = null; } }
    function beginBranch(t, u, paragraph, quote) {
      st.pending = { t, u, paragraph, quote };
      st.focus = V === "d" ? "drawer" : "ask-" + t.id + "-pending";
      st.scrollTo = V === "d" ? null : '[data-sec="pending"]';
      render();
    }

    /* ---------- popovers */
    function rel(r) {
      const rr = root.getBoundingClientRect();
      const s = rr.width / root.offsetWidth || 1;
      return { x: (r.left - rr.left) / s, y: (r.top - rr.top) / s, w: r.width / s, h: r.height / s };
    }
    function closePop() { if ($pop) { $pop.remove(); $pop = null; } }
    function openPop(type, anchor, arg) {
      closePop();
      const p = anchor.getBoundingClientRect ? rel(anchor.getBoundingClientRect()) : rel({ left: anchor.clientX, top: anchor.clientY, width: 0, height: 0 });
      const el = h("div", { class: "pop", onmousedown: (e) => e.stopPropagation() });
      const mi = (icon, label, fn, k) => h("button", { class: "mi", onclick: () => { closePop(); fn(); } }, icon ? ic(icon) : h("span", { style: "width:15px" }), label, k ? h("span", { class: "k" }, k) : null);
      if (type === "model") {
        const cur = modelFor(arg);
        const set = (patch) => { st.modelFor[arg] = Object.assign({}, cur, patch); render(); openPop("model", root.querySelector(V === "b" ? ".sline .mchip" : V === "d" ? ".dask .mchip" : ".ed .bar .mchip") || anchor, arg); };
        el.append(h("h4", null, "Model for the next question in this note"));
        for (const pv of D.providers) {
          const s = agents[pv.id];
          const on = cur.provider === pv.id;
          el.append(h("div", { class: "pr" + (on ? " sel" : ""), onclick: () => { if (s === "ready" && !on) set({ provider: pv.id, model: pv.models[0], effort: pv.efforts.length ? (pv.efforts.includes("high") ? "high" : pv.efforts[0]) : null }); } },
            h("span", { class: "pn" }, pv.label),
            s === "ready" ? h("span", { class: "pill ok", style: "font-weight:500" }, "Ready") : s === "signin" ? h("span", { class: "pill warn", style: "font-weight:500" }, "Run ", h("span", { class: "pcmd" }, pv.id + " login")) : h("span", { class: "pill plain", style: "font-weight:500" }, "Not installed")));
          if (on) {
            el.append(h("div", { class: "mods" }, pv.models.map((mm) => h("button", { class: "opt" + (cur.model === mm ? " on" : ""), onclick: () => set({ model: mm }) }, mm))));
            if (pv.efforts.length) el.append(h("div", { class: "mods" }, h("span", { style: "font-size:11.5px;color:var(--ink2);align-self:center;margin-right:4px" }, "Effort"), pv.efforts.map((ef) => h("button", { class: "opt" + (cur.effort === ef ? " on" : ""), onclick: () => set({ effort: ef }) }, ef))));
          }
        }
        el.append(h("div", { class: "msep" }), h("div", { class: "pnote" }, "Earlier answers keep the model they ran with; it is shown under each answer."));
        el.style.width = "330px";
      } else if (type === "sources" || type === "trace") {
        const [, u] = turnById(arg);
        if (type === "sources") {
          el.append(h("h4", null, u.sources.length + " sources cited in this answer"));
          u.sources.forEach((s) => el.append(h("div", { class: "srcr", title: s.url }, h("span", { class: "fav" }, s.domain[0].toUpperCase()), h("div", { style: "min-width:0" }, h("b", null, s.title), h("small", null, s.domain)))));
        } else {
          const tot = u.activity.reduce((a, s) => a + (s.ms || 0), 0);
          el.append(h("h4", null, u.activity.length + " steps · " + (tot / 1000).toFixed(1) + " s of tool time · " + PROV[u.provider] + " " + u.model));
          u.activity.forEach((s) => el.append(h("div", { class: "stp " + s.status }, s.status === "running" ? h("span", { class: "spin", style: "margin:2px 1px 0;color:var(--run)" }) : ic(s.status === "error" ? "alert" : STEP_ICON[s.kind] || "doc"),
            h("div", { class: "sl" }, s.label, s.detail ? h("span", { class: "sd" }, s.detail) : null), h("span", { class: "ms" }, s.status === "running" ? "now" : s.ms >= 1000 ? (s.ms / 1000).toFixed(1) + " s" : s.ms + " ms"))));
        }
        el.style.width = "360px";
      } else if (type === "info") {
        const it = items().find((i) => i.id === arg);
        const t = it.t;
        const srcs = [];
        t.turns.forEach((u) => u.sources.forEach((s) => { if (!srcs.find((x) => x.url === s.url)) srcs.push(s); }));
        el.append(h("h4", null, "Runs in this note"));
        t.turns.forEach((u) => el.append(h("button", { class: "mi", style: "height:auto;padding:5px 9px", onclick: (e) => { openPop("trace", anchor, u.id); } },
          u.status === "running" ? h("span", { class: "spin", style: "color:var(--run)" }) : ic(u.relation === "branch" ? "branch" : u.status === "failed" ? "alert" : "ok", "sm"),
          h("span", { style: "flex:1;overflow:hidden;text-overflow:ellipsis" }, u.title), h("span", { class: "k" }, u.model + " · " + (u.durationSec != null ? fmtDur(u.durationSec) : D.statuses[u.status] ? D.statuses[u.status].label : "")))));
        if (srcs.length) { el.append(h("div", { class: "msep" }), h("h4", null, srcs.length + " sources")); srcs.forEach((s) => el.append(h("div", { class: "srcr", title: s.url }, h("span", { class: "fav" }, s.domain[0].toUpperCase()), h("div", { style: "min-width:0" }, h("b", null, s.title), h("small", null, s.domain))))); }
        const ws = workspaces.find((w) => w.id === t.workspaceId);
        el.append(h("div", { class: "msep" }), h("div", { class: "pnote" }, "Runs in " + (ws ? ws.dir : "") + ". Created " + longDate(t.createdAt) + "."));
        el.style.width = "360px";
      } else if (type === "format") {
        [["Title", "font-size:17px;font-weight:700"], ["Heading", "font-size:15px;font-weight:700"], ["Subheading", "font-weight:600"], ["Body", ""], ["Monostyled", "font-family:" + MONO]].forEach(([l, s]) =>
          el.append(h("button", { class: "mi", style: s, onclick: closePop }, l)));
        el.append(h("div", { class: "msep" }));
        ["• Bulleted List", "– Dashed List", "1. Numbered List"].forEach((l) => el.append(h("button", { class: "mi", onclick: closePop }, l)));
      } else if (type === "new") {
        el.append(mi("folder", "New Folder", () => { const ws = selWs(); const f = { id: uid("f"), workspaceId: ws, name: "New Folder" }; folders.push(f); st.sel = "folder:" + f.id; st.noteId = null; render(); }),
          mi("smart", "New Smart Folder…", () => toast("Smart Folders filter by tag, status, model or date.")),
          h("div", { class: "msep" }),
          mi("plusc", "New Workspace…", () => {
            const id = uid("ws");
            workspaces.push({ id, name: "New Workspace", dir: "~/Session/New Workspace" });
            makeWelcome(id);
            st.sel = "ws:" + id; st.noteId = "welcome-" + id; st.view = "list"; st.galOpen = false;
            render();
          }));
      } else if (type === "row") {
        const it = items().find((i) => i.id === arg);
        const t = it.t;
        if (t && it.kind === "thread") {
          el.append(mi("pin", t.bookmarked ? "Unpin Note" : "Pin Note", () => { t.bookmarked = !t.bookmarked; render(); }));
          el.append(h("div", { class: "msep" }), h("h4", null, "Move to"));
          el.append(mi(null, "Notes (no folder)", () => moveTo(t.id, "ws:" + t.workspaceId)));
          folders.filter((f) => f.workspaceId === t.workspaceId).forEach((f) => el.append(mi(t.folderId === f.id ? "ok" : null, f.name, () => moveTo(t.id, "folder:" + f.id))));
          el.append(h("div", { class: "msep" }), mi("archive", t.archivedAt ? "Unarchive" : "Archive", () => archiveNote(t.id)), mi("trash", "Delete…", () => { threads = threads.filter((x) => x !== t); st.noteId = (visible()[0] || {}).id; render(); toast("Note deleted"); }));
        } else el.append(mi("pin", "Pin Note", () => { if (it.n) it.n.pinned = !it.n.pinned; render(); }));
      }
      root.append(el);
      $pop = el;
      const W = root.offsetWidth, H = root.offsetHeight;
      let x = p.x + (p.w || 0) / 2 - el.offsetWidth / 2, y = p.y + (p.h || 0) + 6;
      if (type === "row" || type === "new") { x = p.x; }
      if (type === "new") y = p.y - el.offsetHeight - 6;
      x = Math.max(8, Math.min(W - el.offsetWidth - 8, x));
      if (y + el.offsetHeight > H - 8) y = Math.max(8, p.y - el.offsetHeight - 6);
      el.style.left = x + "px"; el.style.top = y + "px";
    }
    function moveTo(id, sel) {
      const t = threads.find((x) => x.id === id);
      if (!t) return;
      if (sel.startsWith("folder:")) { const f = folders.find((x) => x.id === sel.slice(7)); if (f && f.workspaceId === t.workspaceId) { t.folderId = f.id; toast("Moved to " + f.name); } else { toast("Notes can move between folders of the same workspace."); return; } }
      else if (sel.startsWith("ws:")) { if (sel.slice(3) !== t.workspaceId) { toast("Moving a note to another workspace moves its run folder too. Use File → Move to Workspace…"); return; } t.folderId = null; toast("Moved to Notes"); }
      render();
    }
    function archiveNote(id) {
      const t = threads.find((x) => x.id === id);
      if (!t) return;
      t.archivedAt = t.archivedAt ? null : nowISO();
      if (t.archivedAt) { toast("Archived. Find it under Archive in " + workspaces.find((w) => w.id === t.workspaceId).name + "."); const v = visible(); st.noteId = v[0] ? v[0].id : null; }
      render();
    }
    function toast(msg) {
      if ($toast) $toast.remove();
      $toast = h("div", { class: "toast", role: "status" }, msg);
      root.append($toast);
      const el = $toast;
      later(() => { el.remove(); if ($toast === el) $toast = null; }, 2200);
    }

    /* quick note */
    function renderQuick() {
      const ta = h("textarea", { placeholder: "Ask a question. It is saved as a new note in " + (workspaces.find((w) => w.id === selWs()) || workspaces[0]).name + ".", "data-focus": "quick",
        onkeydown: (e) => {
          if (e.key === "Escape") { st.quick = false; render(); }
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const v = e.target.value.trim(); if (!v) return; st.quick = false; const t = newThread(selWs(), null, short(v, 70)); st.noteId = t.id; st.sel = "ws:" + t.workspaceId; ask({ t, parent: null, relation: "root" }, v); }
        } });
      return h("div", { class: "qn" }, h("div", { class: "qh" }, h("div", { class: "lights" }, h("i", { onclick: () => { st.quick = false; render(); } }), h("i"), h("i")), h("span", null, "Quick Note")),
        h("div", { class: "qb" }, ta, h("div", { class: "pnote", style: "padding:6px 0 0" }, "Return asks " + PROV[modelFor(st.noteId || "").provider] + " " + modelFor(st.noteId || "").model + " · Esc closes")));
    }

    /* ---------- events */
    function onKey(e) {
      const tgt = e.target;
      const typing = tgt && (tgt.tagName === "TEXTAREA" || tgt.tagName === "INPUT" || tgt.isContentEditable);
      if (e.key === "Escape") { closePop(); closeSelbar(); if (st.quick) { st.quick = false; render(); } return; }
      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); newNote(); return; }
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); st.quick = true; st.focus = "quick"; render(); return; }
      if (e.metaKey && e.altKey && e.key.toLowerCase() === "s") { e.preventDefault(); st.sidebar = !st.sidebar; render(); return; }
      if (e.metaKey && (e.key === "1" || e.key === "2")) { e.preventDefault(); setView(e.key === "1" ? "list" : "gallery"); return; }
      if (e.metaKey && e.key.toLowerCase() === "j") { e.preventDefault(); const a = [...root.querySelectorAll('textarea[data-ask]')].pop(); if (a) { a.focus(); a.scrollIntoView({ block: "center" }); } return; }
      if (e.metaKey && e.key.toLowerCase() === "f") { e.preventDefault(); const s = root.querySelector('[data-focus="search"]'); if (s) s.focus(); return; }
      if (typing) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (st.sel === "smart:hl") return;
        const v = visible();
        const order = grouped(v).flatMap((g) => g[1]);
        const i = order.findIndex((x) => x.id === st.noteId);
        const n = order[Math.max(0, Math.min(order.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
        if (n) { e.preventDefault(); st.noteId = n.id; markRead(n); render(); const r = root.querySelector('[data-id="' + n.id + '"]'); if (r) r.scrollIntoView({ block: "nearest" }); const lb = root.querySelector(".lbody"); if (lb) lb.focus({ preventScroll: true }); }
      }
    }
    function onDown(e) { if ($pop && !$pop.contains(e.target)) closePop(); if ($selbar && !$selbar.contains(e.target)) closeSelbar(); }
    root.addEventListener("keydown", onKey);
    root.addEventListener("mousedown", onDown);
    const tick = setInterval(() => {
      root.querySelectorAll("[data-since]").forEach((el) => { el.textContent = fmtDur((nowMs() - Number(el.getAttribute("data-since"))) / 1000); });
    }, 1000);

    if (V === "c") { st.noteId = "t1"; }
    if (V === "d") { st.noteId = "t1"; }
    render();
    try { root.focus({ preventScroll: true }); } catch (err) { /* ignore */ }

    return () => {
      timers.forEach((id) => clearTimeout(id));
      timers.clear();
      clearInterval(tick);
      root.removeEventListener("keydown", onKey);
      root.removeEventListener("mousedown", onDown);
      root.replaceChildren();
    };
  }

  window.SessionMocks.register({
    id: "notes",
    round: 1,
    name: "Notes & Answers",
    reference: "Apple Notes",
    summary: "Everything is a note. A research thread is a note in which you write a question and the answer appears beneath it in a quiet, rule-marked block; follow-ups continue down the page and branches fold away as sections.",
    principles: [
      "Three panes: workspaces as account-style sections with folders, a date-grouped note list (Pinned, Today, Yesterday, Previous 7 Days) and a calm editor. Gallery view is one toggle away.",
      "Just start typing: ⌘N opens an empty note whose first line is both the title and the first question; Return asks. The ask line is always the last line of the note.",
      "Answers are quiet blocks under the question (yellow rule, softer ink). The model, duration, sources and steps sit in one small line under each answer and open as popovers, so the page stays readable.",
      "Branches are collapsible headings (Notes' folding sections) with a link back to the passage they came from; the passage carries a dotted underline and a margin marker.",
      "One keep-mark per scope: Pin (replaces Bookmark and Star) keeps a note at the top; Highlight keeps a passage. Follow and Post are dropped because network delivery does not exist.",
      "Smart Folders are saved queries (Needs Attention, Running, #kv-cache); tags (#tag) and >> note links build the knowledge base, with 'Linked notes' and 'Mentioned in' at the foot of every note.",
      "Renamed for clarity: thread/research/question → note; Unfiled/Home → 'Notes' (every note in the workspace, filed or not); Bookmark → Pin."
    ],
    chat: "Type a question on the last line of a note and press Return; the answer streams in beneath it with a live status line (current step, elapsed time, Stop). Typing under the answer continues the conversation; selecting a passage offers Branch, which opens a new folding section with its own ask line. The model for the next question is chosen from a toolbar popover that also shows whether each agent CLI is ready; every answer names the model that wrote it.",
    knowledge: "Notes are filed into folders inside workspaces, tagged with #tags, and linked with >> links; outline notes (checklists, folding headings) link to specific answers, and each research note lists its linked notes and the notes that mention it. Smart Folders and the Tags browser are the saved views; Highlights collects marked passages across all notes.",
    firstRun: "A new workspace contains one pinned note, 'Welcome to Session'. It shows which agent CLIs are ready (with the sign-in command and Check again for the others), then a four-step checklist that ticks itself as you ask, follow up, branch and tag inside the same note. The workspace and folder model is explained in a folding section below.",
    changes: [],
    variants: [
      { id: "a", name: "Inline answers", note: "Answers inline under each question; branches fold as sections at the end of the note; model popover in the toolbar." },
      { id: "b", name: "Branches as linked notes", note: "Each branch is its own note in the list, joined to its parent by >> links; model and run status move to a slim status line." },
      { id: "c", name: "Gallery first", note: "Folders open as a gallery of note previews; a note opens full width with a back button, for browsing a knowledge base by sight." },
      { id: "d", name: "Conversation drawer", note: "The note holds only the answers, as an editable document with folding headings; questions, run status and the ask box live in a drawer on the right." },
      { id: "e", name: "First run", note: "A new workspace with a single interactive 'Welcome to Session' note that checks agents and teaches asking, following up, branching and tagging by doing." }
    ],
    fonts: "family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500",
    css: CSS.replace(/\.S\b/g, "." + SC).replace(/S-(flash|spin|blink)/g, SC + "-$1"),
    mount
  });
})();
