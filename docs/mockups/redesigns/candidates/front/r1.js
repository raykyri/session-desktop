/*
 * Session redesign candidate "front", round 1.
 * Reference: Front and other shared-inbox / triage email apps (Superhuman, Missive, Help Scout, HEY).
 * Research runs are conversations that arrive in an Inbox when they finish, fail or ask a question.
 * Agents are teammates a question is assigned to; follow-ups are replies; branches are forked
 * conversations; your notes are internal comments; Done files a conversation into Knowledge.
 */
(function () {
"use strict";
var SCOPE = "m-front-r1";

/* ---- CSS. "&" is the scope class. Macros expanded at register time: FXC = flex row centered,
   IFC = inline-flex centered, UPC = uppercase label, BL1 = 1px border in --line. */
var css = `
&{--f: "Inter", system-ui, -apple-system, sans-serif;--mono: "JetBrains Mono", ui-monospace, Menlo, monospace;
--bg:#ffffff;--nav:#f2f3f6;--list:#ffffff;--pane:#f6f7f9;--card:#ffffff;--line:#e1e4e9;--line2:#eceef2;
--tx:#1b1f27;--tx2:#4f5764;--tx3:#868e9a;--acc:#3656d6;--acc2:#2945b8;--acc-bg:#e7ecfc;--acc-tx:#ffffff;
--sel:#e8edfc;--hover:#eef0f4;--rowsel:#eef2fd;
--cmt-bg:#fff6d8;--cmt-line:#ecd47a;--cmt-tx:#5b4708;
--ok:#23894f;--ok-bg:#e3f4ea;--err:#cf3d3d;--err-bg:#fde9e9;--warn:#b67800;--warn-bg:#fdf1d6;--run:#2f74c0;--run-bg:#e3effb;
--plain-bg:#eceef2;--hl-amber:rgba(245,180,40,.28);--hl-green:rgba(60,180,100,.22);--hl-blue:rgba(70,130,230,.20);--hl-pink:rgba(230,90,150,.20);
--branch:#3f6fd8;--shadow:0 10px 30px rgba(20,30,50,.16), 0 2px 6px rgba(20,30,50,.08);
--a-claude:#c9774f;--a-codex:#2f8f62;--a-grok:#6e5fd0;--a-me:#5a6372;--a-sys:#3656d6;
display:flex;flex-direction:column;font:13px/1.45 var(--f);color:var(--tx);background:var(--bg);
-webkit-font-smoothing:antialiased;outline:none;letter-spacing:-0.003em;}
&[data-theme="dark"]{--bg:#16181c;--nav:#111316;--list:#16181c;--pane:#1b1e23;--card:#22252b;--line:#2b2f36;--line2:#23272d;
--tx:#e6e8ec;--tx2:#a9afb9;--tx3:#757d89;--acc:#7f99ff;--acc2:#98adff;--acc-bg:#252e4f;--acc-tx:#0f1428;
--sel:#232a42;--hover:#1f2228;--rowsel:#1f2539;
--cmt-bg:#2f2a17;--cmt-line:#5e5022;--cmt-tx:#e9d68f;
--ok:#5cc58a;--ok-bg:#183326;--err:#f07d7d;--err-bg:#3a1e20;--warn:#e7b64c;--warn-bg:#382c13;--run:#6eaaf0;--run-bg:#172a40;
--plain-bg:#2a2e35;--hl-amber:rgba(240,178,70,.30);--hl-green:rgba(90,200,130,.24);--hl-blue:rgba(110,160,250,.26);--hl-pink:rgba(240,110,170,.24);
--branch:#7f9fff;--shadow:0 12px 34px rgba(0,0,0,.5), 0 2px 6px rgba(0,0,0,.4);
--a-claude:#c27a55;--a-codex:#3a9a6c;--a-grok:#7b6de0;--a-me:#5b6474;--a-sys:#5a74e0;}
& *,& *::before,& *::after{box-sizing:border-box;}
& button{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;text-align:left;line-height:inherit;}
& input,& textarea{font:inherit;color:inherit;margin:0;}
& code{font-family:var(--mono);font-size:.88em;background:var(--plain-bg);padding:1px 4px;border-radius:4px;}
& .ic{display:inline-flex;width:16px;height:16px;flex:none;align-items:center;justify-content:center;}
& .ic svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}
& .ic.s14{width:14px;height:14px;} & .ic.s12{width:12px;height:12px;} & .ic.s18{width:18px;height:18px;}
& .kbd{IFC;justify-content:center;min-width:17px;height:17px;padding:0 4px;BL1;border-bottom-width:2px;
border-radius:4px;font:500 10.5px/1 var(--mono);color:var(--tx2);background:var(--card);text-transform:uppercase;}
& .muted{color:var(--tx3);}
& .mut{color:var(--tx3);font-size:12.5px;}
& .grow{flex:1;min-width:0;}
& .ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
& .av{width:24px;height:24px;border-radius:50%;flex:none;IFC;justify-content:center;color:#fff;
font:600 9.5px/1 var(--f);letter-spacing:.02em;}
& .av.sm{width:18px;height:18px;font-size:8px;} & .av.lg{width:30px;height:30px;font-size:11px;}
& .av.claude{background:var(--a-claude);} & .av.codex{background:var(--a-codex);} & .av.grok{background:var(--a-grok);}
& .av.me{background:var(--a-me);} & .av.sys{background:var(--a-sys);border-radius:7px;}

/* title bar */
& .tb{height:40px;flex:none;FXC;gap:10px;padding:0 12px;background:var(--nav);border-bottom:1px solid var(--line);position:relative;}
& .lights{display:flex;gap:8px;width:68px;}
& .lights i{width:12px;height:12px;border-radius:50%;background:#ff5f57;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.15);}
& .lights i:nth-child(2){background:#febc2e;} & .lights i:nth-child(3){background:#28c840;}
& .tb-nav{display:flex;gap:2px;color:var(--tx3);}
& .ibtn{width:28px;height:28px;border-radius:6px;IFC;justify-content:center;color:var(--tx2);flex:none;}
& .ibtn:hover{background:var(--hover);color:var(--tx);}
& .ibtn.on{background:var(--sel);color:var(--acc);}
& .search{position:absolute;left:212px;width:440px;height:28px;FXC;gap:8px;padding:0 8px 0 10px;
border-radius:7px;background:var(--card);BL1;color:var(--tx3);}
& .search input{flex:1;border:0;outline:0;background:transparent;font-size:12.5px;color:var(--tx);min-width:0;}
& .search input::placeholder{color:var(--tx3);}
& .search:focus-within{border-color:var(--acc);box-shadow:0 0 0 3px var(--acc-bg);}
& .tb-right{margin-left:auto;FXC;gap:8px;}
& .btn{height:28px;padding:0 10px;border-radius:6px;IFC;gap:6px;font-weight:500;font-size:12.5px;
BL1;background:var(--card);color:var(--tx);white-space:nowrap;flex:none;}
& .btn:hover{background:var(--hover);}
& .btn.pri{background:var(--acc);border-color:var(--acc);color:#fff;}
&[data-theme="dark"] .btn.pri{color:#0f1428;}
& .btn.pri:hover{background:var(--acc2);}
& .btn.pri .kbd{background:rgba(255,255,255,.18);border-color:rgba(255,255,255,.3);color:inherit;}
& .btn.ok{color:var(--ok);}
& .btn.sm{height:24px;padding:0 8px;font-size:12px;}
& .btn[disabled]{opacity:.5;cursor:default;}

& .main{flex:1;display:flex;min-height:0;position:relative;}

/* nav */
& .nav{width:200px;flex:none;background:var(--nav);border-right:1px solid var(--line);overflow:auto;padding:8px 8px 12px;display:flex;flex-direction:column;}
& .nv-ws{FXC;gap:8px;padding:6px 8px;border-radius:7px;margin-bottom:6px;font-weight:600;}
& .nv-ws:hover{background:var(--hover);}
& .nv-ws .sq{width:22px;height:22px;border-radius:6px;background:var(--acc);color:#fff;FXC;justify-content:center;font-size:11px;font-weight:700;}
&[data-theme="dark"] .nv-ws .sq{color:#0f1428;}
& .nv-sec{FXC;gap:4px;padding:12px 8px 4px;font-size:11px;font-weight:600;color:var(--tx3);letter-spacing:.02em;text-transform:uppercase;}
& .nv-sec button{display:inline-flex;color:var(--tx3);}
& .nv-i{FXC;gap:9px;height:28px;padding:0 8px;border-radius:6px;color:var(--tx);width:100%;white-space:nowrap;}
& .nv-i .ic{color:var(--tx2);}
& .nv-i:hover{background:var(--hover);}
& .nv-i.on{background:var(--sel);color:var(--acc);font-weight:600;}
& .nv-i.on .ic{color:var(--acc);}
& .nv-i .lbl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;}
& .nv-i .ct{font-size:11.5px;color:var(--tx3);font-variant-numeric:tabular-nums;}
& .nv-i .ct.hot{color:var(--acc);font-weight:700;}
& .nv-i.sub{padding-left:28px;height:26px;font-size:12.5px;}
& .nv-i .dot{width:8px;height:8px;border-radius:3px;flex:none;margin:0 4px;}
& .nv-foot{margin-top:auto;padding-top:10px;}

/* list */
& .list{width:316px;flex:none;background:var(--list);border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0;}
& .lh{height:48px;flex:none;FXC;gap:8px;padding:0 10px 0 12px;border-bottom:1px solid var(--line);}
& .lh h2{margin:0;font-size:15px;font-weight:650;letter-spacing:-.01em;}
& .lh .ct{color:var(--tx3);font-weight:500;font-size:13px;}
& .chk{width:16px;height:16px;border-radius:4px;border:1.5px solid var(--tx3);flex:none;IFC;justify-content:center;color:#fff;opacity:.55;}
& .chk:hover{opacity:1;}
& .chk.on{background:var(--acc);border-color:var(--acc);opacity:1;}
& .chk.on .ic{width:11px;height:11px;} & .chk.on .ic svg{stroke-width:3;}
& .lscroll{flex:1;overflow:auto;min-height:0;}
& .lgrp{position:sticky;top:0;z-index:1;FXC;gap:6px;height:28px;padding:0 12px;background:var(--list);
font-size:11px;font-weight:650;color:var(--tx3);UPC;border-bottom:1px solid var(--line2);}
& .lgrp .n{font-weight:500;}
& .row{position:relative;display:grid;grid-template-columns:18px 26px 1fr;column-gap:8px;padding:10px 12px 10px 8px;border-bottom:1px solid var(--line2);cursor:default;width:100%;}
& .row:hover{background:var(--hover);}
& .row.sel{background:var(--rowsel);}
& .row.sel::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--acc);}
& .row .chk{margin-top:4px;opacity:0;}
& .row:hover .chk,& .row .chk.on,& .list.bulk .row .chk{opacity:.7;} & .row .chk.on{opacity:1;}
& .row .l1{FXC;gap:6px;font-size:12.5px;color:var(--tx2);min-width:0;}
& .row .snd{font-weight:500;color:var(--tx);}
& .row .mdl{color:var(--tx3);}
& .row .tm{margin-left:auto;font-size:11.5px;color:var(--tx3);font-variant-numeric:tabular-nums;flex:none;}
& .row .sub{font-size:13px;color:var(--tx);margin-top:1px;}
& .row .pv{FXC;gap:6px;margin-top:3px;font-size:12.5px;color:var(--tx3);min-width:0;}
& .row.unread .snd,& .row.unread .sub{font-weight:650;}
& .row.unread .tm{color:var(--acc);font-weight:600;}
& .row .udot{width:7px;height:7px;border-radius:50%;background:var(--acc);flex:none;}
& .row.done .sub{color:var(--tx2);}
& .lfoot{flex:none;height:32px;FXC;gap:10px;padding:0 12px;border-top:1px solid var(--line);color:var(--tx3);font-size:11.5px;white-space:nowrap;overflow:hidden;}
& .lfoot span{IFC;gap:4px;}
& .bulk-bar{height:48px;flex:none;FXC;gap:4px;padding:0 8px 0 12px;border-bottom:1px solid var(--line);background:var(--acc-bg);}
& .bulk-bar b{font-weight:600;margin:0 6px 0 4px;color:var(--acc);}
& .bulk-bar .btn{height:26px;padding:0 7px;}

/* pills & chips */
& .pill{IFC;gap:4px;height:18px;padding:0 6px;border-radius:9px;font-size:11px;font-weight:600;flex:none;white-space:nowrap;}
& .pill.plain{background:var(--plain-bg);color:var(--tx2);}
& .pill.run{background:var(--run-bg);color:var(--run);}
& .pill.ok{background:var(--ok-bg);color:var(--ok);}
& .pill.error{background:var(--err-bg);color:var(--err);}
& .pill.attention{background:var(--warn-bg);color:var(--warn);}
& .pill.snz{background:var(--plain-bg);color:var(--tx2);}
& .spin{width:8px;height:8px;border-radius:50%;border:1.6px solid currentColor;border-right-color:transparent;animation:frspin .9s linear infinite;flex:none;}
@keyframes frspin{to{transform:rotate(360deg);}}
& .chip{IFC;gap:5px;height:20px;padding:0 7px;border-radius:5px;font-size:11.5px;color:var(--tx2);background:var(--plain-bg);white-space:nowrap;flex:none;}
& button.chip:hover{color:var(--tx);}
& .chip .dot{width:7px;height:7px;border-radius:2px;}
& .tagc0{background:#d9534f;} & .tagc1{background:#e09a2c;} & .tagc2{background:#3c9a5f;} & .tagc3{background:#3b7dd8;} & .tagc4{background:#8a5bd6;} & .tagc5{background:#c2508c;} & .tagc6{background:#2b9aa0;}

/* conversation */
& .conv{flex:1;min-width:0;background:var(--pane);display:flex;flex-direction:column;min-height:0;position:relative;}
& .ctb{overflow:hidden;height:48px;flex:none;FXC;gap:2px;padding:0 10px 0 12px;border-bottom:1px solid var(--line);background:var(--list);}
& .asg{white-space:nowrap;flex:none;IFC;gap:7px;height:30px;padding:0 8px 0 4px;border-radius:15px;BL1;font-size:12.5px;font-weight:500;background:var(--card);}
& .asg:hover{background:var(--hover);}
& .ctb .sep{width:1px;height:18px;background:var(--line);margin:0 6px;flex:none;}
& .ctb > .pill{margin-left:6px;}
& .ctb .ibtn{width:26px;}
& .ctb .asg{padding-right:6px;}
& .chead{padding:14px 20px 10px;flex:none;border-bottom:1px solid var(--line2);background:var(--pane);}
& .chead h1{margin:0;font-size:16.5px;line-height:1.3;font-weight:650;letter-spacing:-.015em;}
& .chead .meta{FXC;flex-wrap:wrap;gap:6px;margin-top:7px;font-size:12px;color:var(--tx3);}
& .crumb{IFC;gap:4px;color:var(--tx2);}
& button.crumb:hover{color:var(--acc);}
& .tl{flex:1;overflow:auto;padding:14px 16px 24px;min-height:0;}
& .tl-in{max-width:720px;margin:0 auto;display:flex;flex-direction:column;gap:10px;}
& .msg{background:var(--card);BL1;border-radius:9px;}
& .msg.q{background:transparent;border-color:transparent;padding:0;}
& .mh{FXC;gap:8px;padding:10px 14px 0;font-size:12.5px;min-width:0;}
& .msg.q .mh{padding:0 2px;}
& .mh b{font-weight:600;color:var(--tx);}
& .mh .to{color:var(--tx3);white-space:nowrap;font-size:12px;}
& .mh .tm{margin-left:auto;color:var(--tx3);font-size:11.5px;white-space:nowrap;font-variant-numeric:tabular-nums;}
& .qbody{margin:6px 0 0 32px;padding:9px 12px;background:var(--card);BL1;border-radius:9px;font-size:13.5px;line-height:1.5;}
& .relc{IFC;gap:4px;font-size:11px;font-weight:600;color:var(--tx3);UPC;}
& .relc.branch{color:var(--branch);}
& .quote{margin:0 0 6px;padding:2px 0 2px 9px;border-left:2px solid var(--branch);color:var(--tx2);font-size:12.5px;}
& .mb{padding:6px 16px 12px 16px;font-size:13.5px;line-height:1.58;}
& .mb .recap{font-size:12.5px;color:var(--tx2);background:var(--plain-bg);border-radius:6px;padding:6px 9px;margin:2px 0 8px;}
& .mb .recap b{font-weight:600;color:var(--tx);margin-right:4px;}
& .para{position:relative;margin:0 0 9px;padding-right:4px;}
& .para:last-child{margin-bottom:0;}
& .para .pa{position:absolute;right:-6px;top:-22px;display:none;gap:2px;padding:2px;border-radius:7px;background:var(--card);BL1;box-shadow:var(--shadow);z-index:3;}
& .para:hover .pa{display:flex;}
& .para .pa button{height:22px;padding:0 7px;border-radius:5px;font-size:11.5px;IFC;gap:4px;color:var(--tx2);}
& .para .pa button:hover{background:var(--hover);color:var(--tx);}
& mark.hl{color:inherit;border-radius:2px;padding:0 1px;}
& mark.hl.amber{background:var(--hl-amber);} & mark.hl.green{background:var(--hl-green);} & mark.hl.blue{background:var(--hl-blue);} & mark.hl.pink{background:var(--hl-pink);}
& mark.br{background:transparent;color:inherit;border-bottom:1.5px solid var(--branch);cursor:pointer;}
& .bmark{display:inline-flex;vertical-align:-2px;margin-left:3px;color:var(--branch);cursor:pointer;}
& .mf{FXC;gap:6px;flex-wrap:wrap;padding:7px 10px 8px 16px;border-top:1px solid var(--line2);}
& .mf .lnk{IFC;gap:4px;font-size:12px;color:var(--tx2);height:24px;padding:0 7px;border-radius:5px;}
& .mf .lnk:hover{background:var(--hover);color:var(--tx);}
& .mf .src{margin-right:auto;display:flex;gap:4px;flex-wrap:wrap;}
& .msg.collapsed{cursor:pointer;}
& .msg.collapsed .mh{padding-bottom:10px;}
& .msg.collapsed .pvw{color:var(--tx3);font-size:12.5px;}
& .working{FXC;gap:7px;color:var(--run);font-size:12.5px;margin:2px 0 8px;}
& .working .el{color:var(--tx3);font-variant-numeric:tabular-nums;}
& .cursor{display:inline-block;width:7px;height:14px;background:var(--acc);vertical-align:-2px;margin-left:2px;animation:frblink 1s steps(1) infinite;}
@keyframes frblink{50%{opacity:0;}}
& .errbox{border:1px solid var(--err);background:var(--err-bg);color:var(--err);border-radius:7px;padding:8px 10px;font-size:12.5px;margin:2px 0 6px;}
& .errbox code{background:transparent;padding:0;color:inherit;}
& .clar{border:1px solid var(--cmt-line);background:var(--warn-bg);border-radius:8px;padding:10px 12px;margin-top:10px;}
& .clar .t{FXC;gap:6px;font-weight:600;color:var(--warn);font-size:12px;UPC;}
& .clar p{margin:4px 0 8px;}
& .queued{color:var(--tx2);font-size:12.5px;FXC;gap:8px;}
& .cmt{background:var(--cmt-bg);border:1px solid var(--cmt-line);border-radius:9px;padding:9px 12px 10px;margin-left:32px;}
& .cmt .mh{padding:0;color:var(--cmt-tx);}
& .cmt .lab{font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--cmt-tx);opacity:.8;}
& .cmt .cq{margin:5px 0 3px 26px;padding-left:8px;border-left:2px solid var(--cmt-line);color:var(--tx2);font-size:12.5px;font-style:italic;}
& .cmt .ct{margin:4px 0 0 26px;font-size:13px;color:var(--tx);}
& .evt{FXC;gap:8px;font-size:12px;color:var(--tx3);padding:2px 4px 2px 6px;}
& .evt .ln{flex:1;height:1px;background:var(--line);}
& .evt b{color:var(--tx2);font-weight:500;}
& .fork{FXC;gap:9px;margin-left:32px;padding:8px 12px;border:1px dashed var(--line);border-radius:9px;font-size:12.5px;background:transparent;width:calc(100% - 32px);}
& .fork:hover{border-color:var(--branch);background:var(--card);}
& .fork .ic{color:var(--branch);}
& .fork .t{font-weight:600;color:var(--tx);}
& .banner{FXC;gap:8px;padding:7px 10px;border-radius:8px;background:var(--acc-bg);color:var(--acc);font-size:12.5px;}
& .banner .grow{color:var(--tx2);}
& .banner b{color:var(--acc);font-weight:600;}

/* composer */
& .cmp{flex:none;margin:0 14px 12px;BL1;border-radius:10px;background:var(--card);box-shadow:0 1px 2px rgba(0,0,0,.04);}
& .cmp:focus-within{border-color:var(--acc);box-shadow:0 0 0 3px var(--acc-bg);}
& .cmp.note{background:var(--cmt-bg);border-color:var(--cmt-line);}
& .cmp.note:focus-within{box-shadow:0 0 0 3px rgba(236,212,122,.35);}
& .cmp-top{FXC;gap:2px;padding:6px 8px 0;}
& .seg{white-space:nowrap;flex:none;height:24px;padding:0 8px;border-radius:6px;font-size:12px;font-weight:500;color:var(--tx3);IFC;gap:5px;}
& .seg:hover{color:var(--tx);background:var(--hover);}
& .seg.on{color:var(--tx);background:var(--plain-bg);}
& .cmp.note .seg.on{background:var(--cmt-line);color:var(--cmt-tx);}
& .topick{white-space:nowrap;min-width:0;overflow:hidden;IFC;gap:6px;height:24px;padding:0 6px 0 3px;border-radius:12px;font-size:12px;color:var(--tx2);margin-left:auto;}
& button.topick:hover{background:var(--hover);color:var(--tx);}
& .cmp textarea{display:block;width:100%;border:0;outline:0;resize:none;background:transparent;padding:8px 12px 4px;font-size:13.5px;line-height:1.45;height:52px;color:var(--tx);}
& .cmp textarea::placeholder{color:var(--tx3);}
& .cmp-foot{FXC;gap:8px;padding:4px 8px 8px 12px;}
& .cmp-foot .hint{flex:1;min-width:0;font-size:11.5px;color:var(--tx3);}
& .cmp .anchor{margin:6px 12px 0;FXC;gap:6px;font-size:12px;color:var(--tx2);}
& .cmp .anchor .q{padding-left:7px;border-left:2px solid var(--branch);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;}
& .replybar{flex:none;display:flex;gap:8px;align-items:center;margin:0 14px 12px;padding:8px 10px;BL1;border-radius:10px;background:var(--card);}
& .replybar .btn{height:28px;}

/* context pane */
& .ctx{width:272px;flex:none;border-left:1px solid var(--line);background:var(--list);display:flex;flex-direction:column;min-height:0;}
& .tabs{height:48px;flex:none;display:flex;align-items:flex-end;gap:16px;padding:0 14px;border-bottom:1px solid var(--line);}
& .tab{height:36px;IFC;gap:5px;font-size:12.5px;font-weight:500;color:var(--tx3);border-bottom:2px solid transparent;margin-bottom:-1px;}
& .tab:hover{color:var(--tx);}
& .tab.on{color:var(--tx);border-bottom-color:var(--acc);}
& .tab .n{font-size:11px;color:var(--tx3);}
& .cscroll{flex:1;overflow:auto;min-height:0;padding:4px 0 16px;}
& .sec{padding:10px 14px 6px;}
& .sec + .sec{border-top:1px solid var(--line2);}
& .sec h4{margin:0 0 7px;FXC;gap:6px;font-size:11px;font-weight:650;color:var(--tx3);UPC;}
& .sec h4 .n{font-weight:500;}
& .sec h4 .act{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:500;color:var(--acc);font-size:11.5px;}
& .kv{display:grid;grid-template-columns:78px 1fr;row-gap:6px;column-gap:8px;font-size:12.5px;align-items:center;}
& .kv dt{color:var(--tx3);}
& .kv dd{margin:0;FXC;gap:6px;min-width:0;white-space:nowrap;overflow:hidden;}
& .li{display:flex;align-items:flex-start;gap:8px;padding:5px 6px;margin:0 -6px;border-radius:6px;font-size:12.5px;width:calc(100% + 12px);}
& button.li:hover{background:var(--hover);}
& .li .grow .t{color:var(--tx);line-height:1.35;}
& .li .grow .d{color:var(--tx3);font-size:11.5px;margin-top:1px;}
& .fav{width:18px;height:18px;border-radius:4px;background:var(--plain-bg);color:var(--tx2);font:700 9.5px/18px var(--f);text-align:center;flex:none;text-transform:uppercase;margin-top:1px;}
& .tree{font-size:12.5px;}
& .tn{FXC;gap:6px;height:26px;padding:0 6px;margin:0 -6px;border-radius:6px;width:calc(100% + 12px);color:var(--tx2);}
& .tn:hover{background:var(--hover);color:var(--tx);}
& .tn.on{color:var(--tx);font-weight:500;}
& .tn.cur{background:var(--sel);color:var(--acc);}
& .tn .ic{color:var(--tx3);} & .tn.br .ic{color:var(--branch);}
& .tn .sdot{width:6px;height:6px;border-radius:50%;flex:none;margin-left:auto;}
& .sdot{width:6px;height:6px;border-radius:50%;flex:none;display:inline-block;}
& .sdot.ok{background:var(--ok);} & .sdot.run{background:var(--run);} & .sdot.error{background:var(--err);} & .sdot.attention{background:var(--warn);} & .sdot.plain{background:var(--tx3);}
& .hlq{display:block;padding:4px 0 4px 9px;margin:0 0 8px;border-left:3px solid var(--hl-amber);font-size:12.5px;color:var(--tx);width:100%;}
& .hlq.green{border-left-color:var(--ok);} & .hlq.blue{border-left-color:var(--branch);} & .hlq.pink{border-left-color:#c2508c;} & .hlq.amber{border-left-color:#e0a530;}
& .hlq .nt{display:block;color:var(--tx3);font-size:11.5px;margin-top:2px;}
& .step{display:grid;grid-template-columns:18px 1fr auto;gap:8px;padding:5px 0;font-size:12.5px;align-items:start;border-bottom:1px solid var(--line2);}
& .step:last-child{border-bottom:0;}
& .step .ic{color:var(--tx3);margin-top:1px;}
& .step .d{color:var(--tx3);font-size:11.5px;font-family:var(--mono);}
& .step .ms{color:var(--tx3);font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap;}
& .step.error .ic,& .step.error .t{color:var(--err);}
& .step.running .ic{color:var(--run);}
& .stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:4px;}
& .stat{background:var(--pane);border:1px solid var(--line2);border-radius:7px;padding:6px 8px;}
& .stat b{display:block;font-size:14px;font-weight:650;font-variant-numeric:tabular-nums;}
& .stat span{font-size:11px;color:var(--tx3);}

/* outline */
& .ol{font-size:13px;}
& .ol .oi{display:flex;align-items:flex-start;gap:4px;padding:3px 0;}
& .ol .tw{width:16px;height:20px;IFC;justify-content:center;color:var(--tx3);flex:none;border-radius:4px;}
& .ol button.tw:hover{background:var(--hover);color:var(--tx);}
& .ol .bul{width:16px;height:20px;IFC;justify-content:center;flex:none;}
& .ol .bul::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--tx3);}
& .ol .tx{flex:1;min-width:0;line-height:20px;}
& .ol .kids{padding-left:20px;border-left:1px solid var(--line2);margin-left:8px;}
& .ol .ref{IFC;gap:3px;margin-left:6px;height:18px;padding:0 6px;border-radius:4px;font-size:11px;color:var(--acc);background:var(--acc-bg);vertical-align:1px;max-width:240px;white-space:nowrap;}
& .ol .ref span:last-child{overflow:hidden;text-overflow:ellipsis;}
& .ol .ref:hover{text-decoration:underline;}
& .ol .oi.here > .tx{background:var(--cmt-bg);border-radius:4px;padding:0 4px;margin-left:-4px;}
& .addi{FXC;gap:6px;margin-top:6px;padding:0 0 0 20px;}
& .addi input{flex:1;height:28px;BL1;border-radius:6px;background:var(--card);padding:0 8px;outline:0;font-size:12.5px;min-width:0;}
& .addi input:focus{border-color:var(--acc);}

/* knowledge */
& .kpage{flex:1;overflow:auto;min-height:0;padding:20px 28px 28px;}
& .kpage-in{max-width:760px;}
& .kpage h1{margin:0;font-size:21px;font-weight:700;letter-spacing:-.02em;FXC;gap:9px;}
& .kpage .meta{color:var(--tx3);font-size:12.5px;margin:5px 0 16px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
& .kpage h3{font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--tx3);font-weight:650;margin:20px 0 8px;FXC;gap:6px;}
& .kcard{display:block;width:100%;background:var(--card);BL1;border-radius:9px;padding:10px 12px;margin-bottom:8px;}
& .kcard:hover{border-color:var(--acc);}
& .kcard .t{FXC;gap:7px;font-weight:600;font-size:13.5px;}
& .kcard .r{color:var(--tx2);font-size:12.5px;margin-top:4px;line-height:1.5;}
& .kcard .m{display:flex;gap:6px;align-items:center;margin-top:7px;flex-wrap:wrap;font-size:11.5px;color:var(--tx3);}
& .nbox{background:var(--card);BL1;border-radius:9px;padding:10px 12px 10px 8px;margin-bottom:8px;}
& .nbox .nt{FXC;gap:6px;font-weight:600;padding:0 0 4px 6px;}
& .topic{FXC;gap:8px;width:100%;padding:8px 12px;border-bottom:1px solid var(--line2);font-size:13px;}
& .topic:hover{background:var(--hover);}
& .topic.sel{background:var(--rowsel);box-shadow:inset 3px 0 0 var(--acc);}
& .topic .ic{color:var(--tx3);}
& .topic .d{color:var(--tx3);font-size:11.5px;}

/* empty states */
& .empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:30px;color:var(--tx2);gap:6px;}
& .empty .big{width:52px;height:52px;border-radius:50%;background:var(--ok-bg);color:var(--ok);FXC;justify-content:center;margin-bottom:8px;}
& .empty .big .ic{width:26px;height:26px;}
& .empty h3{margin:0;font-size:15px;color:var(--tx);font-weight:650;}
& .empty p{margin:0;font-size:12.5px;max-width:300px;}
& .empty .acts{display:flex;gap:8px;margin-top:12px;}

/* compose page / floating */
& .cpage{flex:1;display:flex;flex-direction:column;min-height:0;padding:18px 24px;gap:10px;}
& .cfield{FXC;gap:10px;padding:6px 0;border-bottom:1px solid var(--line);font-size:13px;}
& .cfield > span:first-child{width:70px;color:var(--tx3);flex:none;}
& .cpage textarea,& .float textarea{flex:1;border:0;outline:0;resize:none;background:transparent;font-size:14px;line-height:1.5;padding:8px 0;color:var(--tx);min-height:0;}
& .chelp{font-size:12px;color:var(--tx3);background:var(--pane);border:1px solid var(--line2);border-radius:8px;padding:8px 10px;line-height:1.5;}
& .float{position:absolute;right:20px;bottom:16px;width:440px;height:380px;z-index:30;background:var(--card);BL1;border-radius:10px;box-shadow:var(--shadow);display:flex;flex-direction:column;overflow:hidden;}
& .float .fh{height:36px;flex:none;FXC;gap:8px;padding:0 6px 0 12px;background:var(--nav);border-bottom:1px solid var(--line);font-weight:600;font-size:12.5px;}
& .float .fb{flex:1;display:flex;flex-direction:column;padding:4px 14px 0;min-height:0;}
& .float .ff{flex:none;FXC;gap:8px;padding:8px 10px 10px 14px;border-top:1px solid var(--line2);}
& .float.note{background:var(--cmt-bg);} & .float.note .fh{background:var(--cmt-bg);border-color:var(--cmt-line);}

/* overlays */
& .menu{position:absolute;z-index:50;min-width:220px;max-width:300px;max-height:420px;overflow:auto;background:var(--card);BL1;border-radius:9px;box-shadow:var(--shadow);padding:5px;font-size:12.5px;}
& .menu .mt{padding:6px 8px 4px;font-size:11px;color:var(--tx3);font-weight:650;UPC;}
& .menu .mi{FXC;gap:8px;width:100%;height:28px;padding:0 8px;border-radius:6px;color:var(--tx);}
& .menu .mi:hover,& .menu .mi.act{background:var(--sel);}
& .menu .mi .r{margin-left:auto;color:var(--tx3);font-size:11.5px;}
& .menu .mi .ic{color:var(--tx2);}
& .menu .mi[disabled]{color:var(--tx3);cursor:default;} & .menu .mi[disabled]:hover{background:transparent;}
& .menu .msep{height:1px;background:var(--line2);margin:4px 0;}
& .menu .mnote{padding:6px 8px;color:var(--tx3);font-size:11.5px;line-height:1.4;}
& .menu input{width:100%;height:28px;BL1;border-radius:6px;padding:0 8px;background:var(--pane);outline:0;margin-bottom:4px;}
& .toast{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);z-index:60;background:#1f2430;color:#f1f3f7;border-radius:9px;padding:9px 12px 9px 14px;
FXC;gap:12px;font-size:12.5px;box-shadow:var(--shadow);white-space:nowrap;}
&[data-theme="dark"] .toast{background:#e9ecf2;color:#14171d;}
& .toast button{color:#9db2ff;font-weight:600;IFC;gap:5px;}
&[data-theme="dark"] .toast button{color:#2c49c4;}
& .toast .kbd{background:transparent;color:inherit;border-color:currentColor;opacity:.7;}
& .scrim{position:absolute;inset:0;z-index:40;background:rgba(15,20,30,.35);FXC;justify-content:center;}
& .sheet{width:560px;background:var(--card);BL1;border-radius:12px;box-shadow:var(--shadow);padding:18px 20px;}
& .sheet h3{margin:0 0 12px;font-size:15px;FXC;}
& .kgrid{display:grid;grid-template-columns:1fr 1fr;column-gap:28px;row-gap:2px;}
& .kgrid div{FXC;gap:8px;font-size:12.5px;height:26px;border-bottom:1px solid var(--line2);}
& .kgrid div span:first-child{flex:1;color:var(--tx2);}

/* welcome */
& .wcard{background:var(--card);BL1;border-radius:10px;padding:12px 14px;margin-left:32px;}
& .wcard h5{margin:0 0 8px;font-size:12px;font-weight:650;color:var(--tx3);UPC;FXC;gap:8px;}
& .wcard h5 .pill{text-transform:none;letter-spacing:0;}
& .agrow{display:grid;grid-template-columns:26px 1fr auto;gap:10px;align-items:center;padding:7px 0;border-top:1px solid var(--line2);}
& .agrow:first-of-type{border-top:0;}
& .agrow .t{font-weight:600;font-size:13px;}
& .agrow .d{font-size:12px;color:var(--tx3);FXC;gap:6px;flex-wrap:wrap;margin-top:1px;}
& .tut{display:grid;grid-template-columns:repeat(3, 1fr);gap:6px;}
& .tut div{FXC;gap:7px;padding:6px 8px;border:1px solid var(--line2);border-radius:7px;font-size:12px;color:var(--tx2);}
& .tut div.done{border-color:var(--ok);color:var(--ok);background:var(--ok-bg);}
& .tut div.done .kbd{border-color:var(--ok);color:var(--ok);}
& .exq{display:flex;flex-direction:column;gap:6px;}
& .exq button{text-align:left;padding:7px 10px;border:1px solid var(--line2);border-radius:7px;font-size:12.5px;color:var(--tx2);background:var(--pane);}
& .exq button:hover{border-color:var(--acc);color:var(--tx);}
& .gl dt{font-weight:600;font-size:12.5px;margin-top:8px;}
& .gl dd{margin:2px 0 0;font-size:12.5px;color:var(--tx2);line-height:1.45;}
& .prog{height:5px;border-radius:3px;background:var(--plain-bg);overflow:hidden;margin:2px 0 8px;}
& .prog i{display:block;height:100%;background:var(--ok);border-radius:3px;}

/* variant b: split inbox */
& .split{height:44px;flex:none;display:flex;align-items:flex-end;gap:2px;padding:0 16px;border-bottom:1px solid var(--line);background:var(--list);}
& .stab{height:44px;IFC;gap:7px;padding:0 12px;font-size:13px;font-weight:500;color:var(--tx3);border-bottom:2px solid transparent;margin-bottom:-1px;}
& .stab:hover{color:var(--tx);}
& .stab.on{color:var(--tx);border-bottom-color:var(--acc);font-weight:600;}
& .stab .n{font-size:11.5px;color:var(--tx3);font-weight:500;}
& .stab.on .n{color:var(--acc);}
& .wide{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--list);}
& .wrow{display:grid;grid-template-columns:18px 22px 190px 1fr auto 62px;align-items:center;column-gap:10px;height:44px;padding:0 20px 0 16px;border-bottom:1px solid var(--line2);width:100%;font-size:13px;position:relative;}
& .wrow:hover{background:var(--hover);}
& .wrow.sel{background:var(--rowsel);}
& .wrow.sel::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--acc);}
& .wrow .snd{color:var(--tx);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
& .wrow .snd .mdl{color:var(--tx3);}
& .wrow .sp{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tx3);}
& .wrow .sp b{color:var(--tx);font-weight:500;}
& .wrow.unread .snd,& .wrow.unread .sp b{font-weight:650;}
& .wrow.dim > *{opacity:.62;}
& .wrow .tm{text-align:right;color:var(--tx3);font-size:12px;font-variant-numeric:tabular-nums;}
& .wrow.unread .tm{color:var(--acc);font-weight:600;}
& .wrow .rt{display:flex;gap:6px;align-items:center;}
& .wrow .chk{opacity:0;} & .wrow:hover .chk,& .wrow .chk.on{opacity:.8;}
& .wgrp{height:30px;display:flex;align-items:flex-end;padding:0 20px 5px 56px;font-size:11px;font-weight:650;color:var(--tx3);UPC;border-bottom:1px solid var(--line2);}
& .ghost{padding:16px 14px;}
& .ghost .gh{font-size:11px;font-weight:650;color:var(--tx3);UPC;margin-bottom:6px;}
& .ghost .gr{display:grid;grid-template-columns:96px 1fr;align-items:center;gap:8px;padding:7px 0;border-bottom:1px dashed var(--line);font-size:12.5px;color:var(--tx2);}
& .ghost .gr .pill{justify-self:start;}
& .ghost p{font-size:12px;color:var(--tx3);margin:10px 0 0;line-height:1.5;}
& .caught{padding:22px 20px;text-align:center;color:var(--tx3);font-size:12.5px;FXC;justify-content:center;gap:8px;}
& .pager{IFC;gap:2px;color:var(--tx3);font-size:12px;}
`;

/* ---- icons */
var P = {
  inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  check: "M20 6 9 17l-5-5",
  done: "M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3",
  tag: "M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01",
  folder: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  plus: "M12 5v14M5 12h14",
  branch: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9",
  note: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  alert: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 8v4M12 16h.01",
  x: "M18 6 6 18M6 6l12 12",
  down: "m6 9 6 6 6-6",
  right: "m9 18 6-6-6-6",
  left: "m15 18-6-6 6-6",
  up: "m18 15-6-6-6 6",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15zM20 17v5H6.5A2.5 2.5 0 0 1 4 19.5",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5",
  loader: "M21 12a9 9 0 1 1-6.22-8.56",
  bookmark: "m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z",
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
  layers: "m12 2 10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5",
  pen: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z",
  more: "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  send: "m22 2-7 20-4-9-9-4zM22 2 11 13",
  stop: "M7 7h10v10H7z",
  reply: "M9 17 4 12l5-5M20 18v-2a4 4 0 0 0-4-4H4",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  retry: "M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M8 16H3v5",
  hash: "M4 9h16M4 15h16M10 3 8 21M16 3l-2 18",
  filter: "M22 3H2l8 9.46V19l4 2v-8.54z",
  help: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01",
  keyboard: "M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10",
  think: "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1",
  term: "m4 17 6-6-6-6M12 19h8",
  sidebar: "M3 4h18v16H3zM9 4v16",
  highlight: "m9 11-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4",
  copy: "M8 8h12v12H8zM16 8V4H4v12h4",
  archive: "M3 3h18v5H3zM5 8v13h14V8M10 12h4",
  sort: "M3 6h18M6 12h12M10 18h4",
  star: "m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z",
  arrowl: "M19 12H5M12 19l-7-7 7-7",
  arrowr: "M5 12h14M12 5l7 7-7 7",
};
var KIND_ICON = { think: "think", read: "file", grep: "search", search: "globe", fetch: "link", run: "term", edit: "pen" };

/* ---- helpers */
function h(tag, a) {
  var el = document.createElement(tag);
  if (a) for (var k in a) {
    var v = a[k];
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k === "text") el.textContent = v;
    else if (k === "value") el.value = v;
    else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
  return el;
}
function add(el, c) {
  if (c == null || c === false) return;
  if (Array.isArray(c)) { for (var i = 0; i < c.length; i++) add(el, c[i]); return; }
  el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
}
function icon(name, cls) {
  var s = h("span", { class: "ic" + (cls ? " " + cls : "") });
  s.innerHTML = '<svg viewBox="0 0 24 24"><path d="' + (P[name] || P.more) + '"/></svg>';
  return s;
}
function kbd(k) { return h("span", { class: "kbd" }, k); }
// Inline Markdown: `code`, **bold**, [text](url). Data strings are set via textContent.
function md(text) {
  var frag = document.createDocumentFragment();
  var re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g, last = 0, m;
  text = String(text || "");
  while ((m = re.exec(text))) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    var s = m[0];
    if (s[0] === "`") frag.appendChild(h("code", { text: s.slice(1, -1) }));
    else if (s[0] === "*") frag.appendChild(h("b", { text: s.slice(2, -2) }));
    else { var mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(s); frag.appendChild(h("a", { text: mm[1], title: mm[2], style: "color:var(--acc);text-decoration:none" })); }
    last = m.index + s.length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}
function plain(text) { return String(text || "").replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); }
function firstSentence(text, max) {
  var p = plain(text), m = /^(.{20,}?[.!?])\s/.exec(p);
  var s = m ? m[1] : p;
  max = max || 90;
  return s.length > max ? s.slice(0, max - 1).trim() + "…" : s;
}
function pad(n) { return (n < 10 ? "0" : "") + n; }
var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function hashc(s) { var x = 0; for (var i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0; return x % 7; }

/* ---- mount */
function mount(root, ctx) {
  var D = ctx.data, V = ctx.variant, FIRST = V === "e";
  var NOW = Date.parse(D.now), T0 = Date.now();
  var timers = [], intervals = [];
  var AG = {
    claude: { label: "Claude Code", short: "CC" },
    codex: { label: "Codex", short: "CX" },
    grok: { label: "Grok", short: "GK" },
  };
  function provider(id) { return D.providers.filter((p) => { return p.id === id; })[0]; }
  function av(p, cls) { return h("span", { class: "av " + (cls || "sm") + " " + p }, AG[p].short); }
  function tagChip(g) { return h("span", { class: "chip" }, h("span", { class: "dot tagc" + hashc(g) }), g); }
  function nowMs() { return NOW + (Date.now() - T0); }
  function nowIso() { return new Date(nowMs()).toISOString(); }
  function ftime(iso) {
    if (!iso) return "";
    var d = new Date(iso), n = new Date(nowMs());
    var hm = pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
    var dd = Math.floor(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) / 864e5) - Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 864e5);
    if (dd <= 0) return hm;
    if (dd === 1) return "Yesterday";
    if (dd < 6) return DOW[d.getUTCDay()];
    return MON[d.getUTCMonth()] + " " + d.getUTCDate();
  }
  function fdate(iso) { var d = new Date(iso); return MON[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()); }
  function fdur(s) {
    if (s == null) return "";
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return m + "m" + (r ? " " + r + "s" : "");
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }
  function pl(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
  function fms(ms) { return ms < 1000 ? ms + " ms" : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " s"; }

  /* ---- model */
  var clone = (x) => { return JSON.parse(JSON.stringify(x)); };
  var threads = FIRST ? [] : clone(D.threads);
  var drafts = FIRST ? [] : clone(D.drafts);
  var notes = FIRST ? [] : clone(D.notes);
  var byT = {};
  threads.forEach((t) => { byT[t.id] = t; });
  var M = {};
  function meta(t, unread) { M[t.id] = { box: t.archivedAt ? "done" : "open", attn: !!unread, unread: !!unread, comments: [], snooze: null, doneAt: t.archivedAt }; }
  threads.forEach((t) => { meta(t, t.unread); });
  if (M.t6) { M.t6.box = "snoozed"; M.t6.snooze = "Mon 09:00"; }
  if (M.t10) { M.t10.box = "done"; M.t10.doneAt = "2026-10-08T15:40:00Z"; }
  var seq = 1;

  var st = {
    view: V === "d" ? "knowledge" : "inbox",
    sel: FIRST ? "welcome" : (V === "d" ? null : "t1"),
    open: false,
    path: {},
    checked: [],
    tab: V === "b" ? "run" : V === "d" ? "notes" : "details",
    runTurn: null,
    mode: "followup",
    anchor: null,
    text: {},
    pick: {},
    compose: null,
    menu: null,
    toast: null,
    q: "",
    topic: "f-jit",
    note: null,
    exp: {},
    col: {},
    sheet: false,
    undo: null,
    tut: {},
    agents: { claude: "ready", codex: "login", grok: "missing" },
    noteDraft: "",
  };
  if (V === "c") { st.col["ws-ml"] = false; }
  if (M[st.sel]) M[st.sel].unread = false;

  /* ---- thread helpers */
  function turn(t, id) { for (var i = 0; i < t.turns.length; i++) if (t.turns[i].id === id) return t.turns[i]; return null; }
  function kids(t, id, rel) { return t.turns.filter((u) => { return u.parentId === id && (!rel || u.relation === rel); }); }
  function pathFor(t) {
    var leaf = turn(t, st.path[t.id] || t.rootTurnId) || t.turns[0], chain = [];
    for (var u = leaf; u; u = u.parentId ? turn(t, u.parentId) : null) chain.unshift(u);
    for (var last = chain[chain.length - 1]; ;) { var f = kids(t, last.id, "followup")[0]; if (!f) break; chain.push(f); last = f; }
    return chain;
  }
  function tone(s) { return (D.statuses[s] || { tone: "plain" }).tone; }
  function needsYou(t) { var m = M[t.id]; return m.box === "open" && (t.status === "failed" || t.status === "needs-review" || (m.attn && t.status === "done")); }
  function isActive(t) { return t.status === "running" || t.status === "queued"; }
  function wsName(id) { var w = D.workspaces.filter((x) => { return x.id === id; })[0]; return w ? w.name : ""; }
  function folder(id) { return D.folders.filter((f) => { return f.id === id; })[0]; }
  function folderName(id) { var f = folder(id); return f ? f.name : "Unfiled"; }
  function lastTurn(t) { var b = t.turns.slice().sort((a, c) => { return Date.parse(c.createdAt) - Date.parse(a.createdAt); }); return b[0]; }
  function inboxItem(t) { return D.inbox.filter((i) => { return i.threadId === t.id; })[0]; }
  function preview(t) {
    var u = lastTurn(t);
    if (t.status === "running") { var rt = t.turns.filter((x) => { return x.status === "running"; })[0] || u; var a = rt.activity[rt.activity.length - 1]; return a ? a.label : "Starting"; }
    if (t.status === "queued") return "Queued · starts when a slot is free";
    if (t.status === "failed") { var f = t.turns.filter((x) => { return x.status === "failed"; })[0]; return f.error || "Run failed"; }
    if (t.status === "needs-review") { var c = t.turns.filter((x) => { return x.clarification; })[0]; if (c) return "Question: " + c.clarification; }
    var it = !FIRST && inboxItem(t);
    if (it && M[t.id].attn) return it.detail;
    if (t.recap) return t.recap;
    return u.answer.length ? plain(u.answer[0]) : plain(u.question);
  }
  function allTags() {
    var c = {};
    threads.forEach((t) => { t.tags.forEach((g) => { c[g] = (c[g] || 0) + 1; }); });
    return Object.keys(c).sort((a, b) => { return c[b] - c[a] || (a < b ? -1 : 1); }).map((g) => { return { tag: g, n: c[g] }; });
  }
  function notesFor(t) { return notes.filter((n) => { return refsIn(n.outline).some((r) => { return r.threadId === t.id; }); }); }
  function refsIn(ol) { var out = []; (function walk(xs) { xs.forEach((x) => { if (x.ref) out.push(x.ref); if (x.children) walk(x.children); }); })(ol); return out; }
  function backlinks(t) { return threads.filter((x) => { return x.id !== t.id && x.links.indexOf(t.id) >= 0; }); }

  /* ---- views */
  function inView(t, v) {
    var m = M[t.id];
    if (v === "inbox") return m.box === "open";
    if (v === "assigned") return needsYou(t);
    if (v === "review") return m.box === "open" && t.status === "needs-review";
    if (v === "running") return m.box !== "done" && isActive(t);
    if (v === "snoozed") return m.box === "snoozed";
    if (v === "done") return m.box === "done";
    if (v === "bookmarked") return t.bookmarked;
    if (v === "failed") return t.turns.some((u) => { return u.status === "failed"; });
    if (v === "highlights") return t.turns.some((u) => { return u.highlights.length; });
    if (v.indexOf("agent:") === 0) return m.box !== "done" && isActive(t) && t.provider === v.slice(6);
    if (v.indexOf("tag:") === 0) return t.tags.indexOf(v.slice(4)) >= 0;
    if (v.indexOf("ws:") === 0) return t.workspaceId === v.slice(3) && m.box !== "done";
    if (v.indexOf("folder:") === 0) return t.folderId === v.slice(7);
    if (v === "search") return matches(t, st.q);
    return false;
  }
  function matches(t, q) {
    q = (q || "").toLowerCase().trim();
    if (!q) return false;
    var hay = [t.title, t.recap || "", t.tags.join(" ")].concat(t.turns.map((u) => { return u.question + " " + u.answer.join(" "); })).join(" ").toLowerCase();
    return hay.indexOf(q) >= 0;
  }
  function snippet(t, q) {
    q = q.toLowerCase();
    var texts = [t.title].concat(t.turns.map((u) => { return plain(u.answer.join(" ")); }), t.turns.map((u) => { return plain(u.question); }));
    for (var i = 0; i < texts.length; i++) {
      var s = texts[i], k = s.toLowerCase().indexOf(q);
      if (k >= 0) return (k > 30 ? "…" : "") + s.slice(Math.max(0, k - 30), k + 90);
    }
    return t.title;
  }
  var VIEW_NAMES = { inbox: "Inbox", assigned: "Assigned to me", review: "Needs review", running: "Running", snoozed: "Snoozed", done: "Done", bookmarked: "Bookmarked", failed: "Failed runs", highlights: "With highlights", drafts: "Drafts", search: "Search", knowledge: "Knowledge" };
  function viewName(v) {
    if (VIEW_NAMES[v]) return VIEW_NAMES[v];
    if (v.indexOf("agent:") === 0) return AG[v.slice(6)].label;
    if (v.indexOf("tag:") === 0) return "#" + v.slice(4);
    if (v.indexOf("ws:") === 0) return wsName(v.slice(3));
    if (v.indexOf("folder:") === 0) return folderName(v.slice(7));
    if (v.indexOf("note:") === 0) return "Note";
    return v;
  }
  function sortT(a, b) { return Date.parse(b.updatedAt) - Date.parse(a.updatedAt); }
  function count(v) { return threads.filter((t) => { return inView(t, v); }).length; }
  // Returns [{label, items:[{kind:'thread'|'draft'|'welcome', id}]}]
  function groups() {
    var v = st.view;
    if (v === "drafts") return [{ label: null, items: drafts.map((d) => { return { kind: "draft", id: d.id, d: d }; }) }];
    var ts = threads.filter((t) => { return inView(t, v); }).sort(sortT);
    var it = (t) => { return { kind: "thread", id: t.id, t: t }; };
    var out;
    if ((V === "a" || V === "d") && v === "inbox") {
      out = [
        { label: "Needs you", items: ts.filter(needsYou).map(it) },
        { label: "Running and queued", items: ts.filter(isActive).map(it) },
        { label: "Open", items: ts.filter((t) => { return !needsYou(t) && !isActive(t); }).map(it) },
      ];
    } else if (V === "c" && v !== "search") {
      out = D.workspaces.map((w) => { return { label: w.name, items: ts.filter((t) => { return t.workspaceId === w.id; }).map(it) }; });
    } else out = [{ label: null, items: ts.map(it) }];
    if (v === "inbox" && (FIRST || st.welcomeInInbox)) out.unshift({ label: null, items: [{ kind: "welcome", id: "welcome" }] });
    return out.filter((g) => { return g.items.length; });
  }
  function flat() { var a = []; groups().forEach((g) => { a = a.concat(g.items); }); return a; }

  /* ---- actions */
  function select(id, opts) {
    st.sel = id;
    st.anchor = null;
    if (st.mode === "branch") st.mode = "followup";
    st.runTurn = null;
    if (M[id]) M[id].unread = false;
    if (id === "welcome") st.tut.j = st.tut.j; // no-op, keeps shape
    if (opts && opts.open) st.open = true;
    st.scrollTl = "top";
  }
  function move(dir) {
    var f = flat(); if (!f.length) return;
    var i = f.map((x) => { return x.id; }).indexOf(st.sel);
    i = i < 0 ? 0 : Math.max(0, Math.min(f.length - 1, i + dir));
    var x = f[i];
    if (x.kind === "draft") openDraft(x.d); else select(x.id);
    render();
    var row = root.querySelector('[data-row="' + x.id + '"]');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
  }
  function targets() { return st.checked.length ? st.checked.slice() : (byT[st.sel] ? [st.sel] : []); }
  function markDone(ids) {
    ids = ids || targets();
    if (!ids.length) return;
    var f = flat().map((x) => { return x.id; });
    var prev = ids.map((id) => { return { id: id, box: M[id].box, attn: M[id].attn }; });
    var after = null;
    if (ids.indexOf(st.sel) >= 0) {
      var i = f.indexOf(st.sel);
      for (var k = i + 1; k < f.length; k++) if (ids.indexOf(f[k]) < 0) { after = f[k]; break; }
      if (!after) for (k = i - 1; k >= 0; k--) if (ids.indexOf(f[k]) < 0) { after = f[k]; break; }
    }
    ids.forEach((id) => { M[id].box = "done"; M[id].attn = false; M[id].doneAt = nowIso(); });
    st.checked = [];
    var t = byT[ids[0]];
    if (st.view !== "done" && st.view !== "bookmarked" && st.view.indexOf("tag:") && st.view.indexOf("folder:")) {
      if (after && after !== "welcome") select(after); else if (after) select(after); else { st.sel = null; st.open = false; }
    }
    toast(ids.length > 1 ? ids.length + " conversations marked done. Filed in Knowledge." : "Done. Filed in Knowledge › " + folderName(t.folderId) + ".", () => {
      prev.forEach((p) => { M[p.id].box = p.box; M[p.id].attn = p.attn; });
      st.sel = ids[0];
    });
    render();
  }
  function snooze(ids, label) {
    ids.forEach((id) => { M[id].box = "snoozed"; M[id].snooze = label; });
    st.checked = [];
    var f = flat(); if (ids.indexOf(st.sel) >= 0) st.sel = f.length ? f[0].id : null;
    toast((ids.length > 1 ? ids.length + " conversations" : "Snoozed") + " until " + label + ".", () => { ids.forEach((id) => { M[id].box = "open"; }); st.sel = ids[0]; });
    st.menu = null; render();
  }
  function toggleTag(ids, tag) {
    var on = ids.every((id) => { return byT[id].tags.indexOf(tag) >= 0; });
    ids.forEach((id) => { var t = byT[id], k = t.tags.indexOf(tag); if (on) t.tags.splice(k, 1); else if (k < 0) t.tags.push(tag); });
    render();
  }
  function moveTo(ids, ws, fid) {
    ids.forEach((id) => { byT[id].workspaceId = ws; byT[id].folderId = fid; });
    st.menu = null;
    toast("Moved to " + wsName(ws) + " › " + folderName(fid) + ".");
    render();
  }
  var toastTimer = null;
  function toast(text, undo) {
    st.toast = { text: text }; st.undo = undo || null;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { st.toast = null; st.undo = null; render(); }, 4200);
    timers.push(toastTimer);
  }
  function doUndo() { if (st.undo) { st.undo(); st.undo = null; st.toast = null; render(); } }
  function openDraft(d) {
    st.sel = d.id;
    st.compose = { draftId: d.id, text: d.prompt, provider: d.provider, model: d.model, effort: (provider(d.provider).efforts.indexOf("high") >= 0 ? "high" : null), ws: d.workspaceId, folder: null };
  }
  function newCompose() {
    var ws = st.view.indexOf("ws:") === 0 ? st.view.slice(3) : st.view.indexOf("folder:") === 0 ? folder(st.view.slice(7)).workspaceId : "ws-compilers";
    var fid = st.view.indexOf("folder:") === 0 ? st.view.slice(7) : null;
    st.compose = { text: "", provider: "claude", model: "opus", effort: "high", ws: ws, folder: fid };
    st.focus = "compose";
    st.tut.c = true;
    render();
  }

  /* ---- runs */
  function steps(t, u) {
    var ws = D.workspaces.filter((w) => { return w.id === t.workspaceId; })[0];
    return [
      { kind: "think", label: "Planned the investigation", ms: 2100 },
      { kind: "grep", label: "Searched code in " + (ws ? ws.dir : "the workspace"), detail: "6 matches", ms: 420 },
      { kind: "read", label: "Read 3 files from the matches", ms: 380 },
      { kind: "search", label: "Searched web: " + firstSentence(u.question, 40), ms: 2600 },
    ];
  }
  function mockAnswer(t, u) {
    var a = AG[u.provider].label + " " + u.model;
    return [
      "Simulated answer for this mock. In the app this text streams from " + a + " running in the " + (wsName(t.workspaceId) || "selected") + " workspace, after the tool calls listed in the Run tab.",
      "The question was: “" + firstSentence(u.question, 110) + "”. Reply to continue with the same agent context, or branch from a paragraph to try another approach without changing this line of the conversation.",
    ];
  }
  function recompute(t) {
    var s = t.turns.map((u) => { return u.status; });
    t.status = s.indexOf("running") >= 0 ? "running" : s.indexOf("needs-review") >= 0 ? "needs-review" : s.indexOf("queued") >= 0 ? "queued" : lastTurn(t).status;
  }
  function startRun(t, u) {
    u.status = "running"; u.activity = []; u.answer = []; u.startedMs = Date.now();
    recompute(t); t.updatedAt = nowIso();
    var plan = steps(t, u), full = mockAnswer(t, u), words = full.join(" ¶ ").split(" "), tick = 0, w = 0;
    var iv = setInterval(() => {
      tick++;
      var si = Math.floor(tick / 6);
      if (si < plan.length) {
        if (u.activity.length < si + 1) {
          if (u.activity.length) u.activity[u.activity.length - 1].status = "ok";
          u.activity.push({ kind: plan[si].kind, label: plan[si].label, detail: plan[si].detail, ms: plan[si].ms, status: "running" });
          render(true);
        }
        return;
      }
      if (u.activity.length && u.activity[u.activity.length - 1].status === "running") u.activity[u.activity.length - 1].status = "ok";
      w = Math.min(words.length, w + 3);
      u.answer = words.slice(0, w).join(" ").split(" ¶ ").map((x) => { return x.replace(/ ?¶ ?/g, ""); }).filter(Boolean);
      if (w >= words.length) {
        clearInterval(iv);
        u.answer = full; u.status = "done"; u.completedAt = nowIso(); u.durationSec = Math.round((Date.now() - u.startedMs) / 1000);
        u.sources = [{ url: "https://example.org/notes", title: "Sample source cited by the mock run", domain: "example.org" }];
        recompute(t); t.updatedAt = nowIso();
        var m = M[t.id];
        m.attn = true;
        if (st.sel !== t.id) m.unread = true;
        if (m.box === "done" && m.returnOnAnswer) { m.box = "open"; m.returnOnAnswer = false; toast("Answer arrived in “" + firstSentence(t.title, 40) + "”. Moved back to Inbox."); }
        var next = t.turns.filter((x) => { return x.status === "queued" && x.parentId === u.id; })[0];
        if (next) startRun(t, next);
      }
      render(true);
    }, 70);
    intervals.push(iv);
  }
  function send(andDone) {
    var t = byT[st.sel]; if (!t) return;
    var text = (st.text[t.id] || "").trim(); if (!text) return;
    var path = pathFor(t), last = path[path.length - 1];
    if (st.mode === "note") {
      M[t.id].comments.push({ turnId: last.id, text: text, quote: st.anchor ? st.anchor.quote : null, at: nowIso() });
      st.text[t.id] = ""; st.anchor = null; st.mode = "followup"; st.scrollTl = "bottom";
      if (st.compose && st.compose.reply) st.compose = null;
      toast("Note added. Notes are private and are not sent to agents.");
      render(); return;
    }
    var pk = st.pick[t.id] || { provider: last.provider, model: last.model, effort: last.effort };
    var isBranch = st.mode === "branch" || pk.provider !== t.provider;
    var parent = isBranch ? (st.anchor ? turn(t, st.anchor.turnId) : last) : last;
    var u = {
      id: t.id + "n" + (seq++), parentId: parent.id, relation: isBranch ? "branch" : "followup",
      anchor: isBranch && st.anchor ? { turnId: st.anchor.turnId, paragraph: st.anchor.paragraph, quote: st.anchor.quote } : null,
      question: text, title: firstSentence(text, 48), provider: pk.provider, model: pk.model, effort: pk.effort,
      status: "queued", createdAt: nowIso(), completedAt: null, durationSec: null, starred: false, recap: null,
      answer: [], error: null, sources: [], activity: [], highlights: [],
    };
    t.turns.push(u);
    st.text[t.id] = ""; st.anchor = null; st.mode = "followup";
    st.path[t.id] = u.id; st.scrollTl = "bottom"; st.tut.send = true;
    if (st.compose && st.compose.reply) st.compose = null;
    var busy = parent.status === "running" || parent.status === "queued";
    if (busy && !isBranch) { recompute(t); toast("Queued. It runs after the current answer in this conversation finishes."); }
    else startRun(t, u);
    if (andDone) { M[t.id].box = "done"; M[t.id].returnOnAnswer = true; markAdvance(t.id); toast("Sent and marked done. It returns to Inbox when the answer arrives."); }
    render();
  }
  function markAdvance(id) {
    var f = flat().map((x) => { return x.id; });
    st.sel = f.length ? f[0] : null;
  }
  function sendCompose(asDraft) {
    var c = st.compose; if (!c) return;
    var text = (c.text || "").trim(); if (!text) return;
    if (asDraft) {
      if (c.draftId) drafts.forEach((d) => { if (d.id === c.draftId) d.prompt = text; });
      else drafts.unshift({ id: "d" + (seq++) + "x", workspaceId: c.ws, prompt: text, provider: c.provider, model: c.model, createdAt: nowIso(), updatedAt: nowIso() });
      st.compose = null; toast("Saved to Drafts."); render(); return;
    }
    if (c.draftId) drafts = drafts.filter((d) => { return d.id !== c.draftId; });
    var id = "nt" + (seq++), rid = id + "q1";
    var t = {
      id: id, workspaceId: c.ws, folderId: c.folder, kind: "exchange", title: firstSentence(text, 70), provider: c.provider, model: c.model, effort: c.effort,
      status: "running", createdAt: nowIso(), updatedAt: nowIso(), lastViewedAt: null, unread: false, bookmarked: false, followed: false, archivedAt: null,
      recap: null, tags: [], links: [], rootTurnId: rid,
      turns: [{ id: rid, parentId: null, relation: "root", anchor: null, question: text, title: firstSentence(text, 48), provider: c.provider, model: c.model, effort: c.effort,
        status: "queued", createdAt: nowIso(), completedAt: null, durationSec: null, starred: false, recap: null, answer: [], error: null, sources: [], activity: [], highlights: [] }],
    };
    threads.unshift(t); byT[id] = t; meta(t, false);
    st.compose = null; st.tut.send = true;
    if (st.view !== "inbox" && st.view !== "running") st.view = "inbox";
    select(id);
    if (V === "b") st.open = true;
    startRun(t, t.turns[0]);
    toast("Sent to " + AG[c.provider].label + ". The conversation is in Inbox under Running.");
    render();
  }

  /* ---- menus */
  function openMenu(kind, ev, extra) {
    var r = root.getBoundingClientRect(), sc = r.width / 1280 || 1;
    var b = ev && ev.currentTarget ? ev.currentTarget.getBoundingClientRect() : null;
    var x = b ? (b.left - r.left) / sc : 500, y = b ? (b.bottom - r.top) / sc + 4 : 200;
    st.menu = Object.assign({ kind: kind, x: x, y: y, ids: targets(), f: "" }, extra || {});
    if (ev) ev.stopPropagation();
    render();
  }
  function keyMenu(kind) {
    var btn = root.querySelector('[data-mk="' + kind + '"]');
    if (btn) openMenu(kind, { currentTarget: btn, stopPropagation: () => {} });
    else openMenu(kind, null);
  }

  /* ==== RENDER */
  var pending = false, lastRender = 0;
  function render(fromTick) {
    if (fromTick && Date.now() - lastRender < 60) { if (!pending) { pending = true; var tm = setTimeout(() => { pending = false; render(); }, 60); timers.push(tm); } return; }
    lastRender = Date.now();
    // preserve scroll + focus
    var sc = {}; root.querySelectorAll("[data-sk]").forEach((e) => { sc[e.getAttribute("data-sk")] = { top: e.scrollTop, bottom: e.scrollHeight - e.scrollTop - e.clientHeight < 40 }; });
    var ae = document.activeElement, fk = null, s0 = 0, s1 = 0;
    if (ae && root.contains(ae) && ae.getAttribute("data-fk")) { fk = ae.getAttribute("data-fk"); s0 = ae.selectionStart; s1 = ae.selectionEnd; }
    var hadFocus = ae && (ae === root || root.contains(ae));
    root.replaceChildren.apply(root, [titlebar(), body()].concat(overlays().filter(Boolean)));
    root.querySelectorAll("[data-sk]").forEach((e) => {
      var k = e.getAttribute("data-sk"), p = sc[k];
      if (k === "tl" && st.scrollTl === "bottom") e.scrollTop = e.scrollHeight;
      else if (k === "tl" && st.scrollTl === "top") e.scrollTop = 0;
      else if (p) e.scrollTop = (k === "tl" && p.bottom && fromTick) ? e.scrollHeight : p.top;
    });
    st.scrollTl = null;
    var tgt = null;
    if (st.focus) { tgt = root.querySelector('[data-fk="' + st.focus + '"]'); st.focus = null; if (tgt) { tgt.focus(); var L = tgt.value ? tgt.value.length : 0; try { tgt.setSelectionRange(L, L); } catch (e) {} } }
    else if (fk) { tgt = root.querySelector('[data-fk="' + fk + '"]'); if (tgt) { tgt.focus(); try { tgt.setSelectionRange(s0, s1); } catch (e) {} } }
    if (!tgt && hadFocus) root.focus({ preventScroll: true });
  }

  function titlebar() {
    var ph = FIRST ? "Search conversations, notes and sources" : "Search 11 conversations, 4 notes, 25 sources";
    return h("div", { class: "tb" },
      h("div", { class: "lights" }, h("i"), h("i"), h("i")),
      h("div", { class: "tb-nav" },
        h("button", { class: "ibtn", title: "Back", onclick: () => { if (st.open) { st.open = false; render(); } } }, icon("left")),
        h("button", { class: "ibtn", title: "Forward" }, icon("right"))),
      h("label", { class: "search", style: V === "b" ? "left:120px;width:520px" : "" }, icon("search", "s14"),
        h("input", { "data-fk": "search", placeholder: ph, value: st.q, oninput: (e) => {
          st.q = e.target.value;
          if (st.q.trim()) { if (st.view !== "search") st.prevView = st.view; st.view = "search"; st.open = false; var fr = flat(); if (fr.length && fr.map((x) => { return x.id; }).indexOf(st.sel) < 0) select(fr[0].id); }
          else if (st.view === "search") st.view = st.prevView || "inbox";
          render();
        }, onkeydown: (e) => {
          if (e.key === "Escape") { st.q = ""; st.view = st.prevView || "inbox"; e.target.blur(); render(); root.focus(); }
          if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); root.focus(); var f = flat(); if (f.length) { select(f[0].id); render(); } }
        } }), kbd("/")),
      h("div", { class: "tb-right" },
        h("button", { class: "btn pri", "data-act": "new", onclick: newCompose }, icon("pen", "s14"), "New question", kbd("C")),
        h("button", { class: "ibtn", title: "Keyboard shortcuts (?)", onclick: () => { st.sheet = true; render(); } }, icon("keyboard")),
        h("span", { class: "av me", title: D.user.name }, D.user.initials)));
  }

  function body() {
    var cols = [];
    var know = st.view === "knowledge" || st.view.indexOf("note:") === 0;
    if (V === "b") {
      if (know) cols.push(topicsCol(), knowPage(), knowCtx());
      else if (st.open && st.sel) cols.push(h("div", { class: "wide", style: "flex-direction:row;background:var(--pane)" }, convCol(), ctxCol()));
      else cols.push(wideList());
      if (know) return h("div", { class: "main", style: "flex-direction:column" }, splitTabs(), h("div", { class: "main" }, cols));
      return h("div", { class: "main", style: "flex-direction:column" }, (st.open && st.sel) ? null : splitTabs(), h("div", { class: "main" }, cols));
    }
    cols.push(nav());
    if (know) cols.push(topicsCol(), knowPage(), knowCtx());
    else cols.push(listCol(), convCol(), ctxCol());
    return h("div", { class: "main" }, cols);
  }

  /* ---- nav */
  function navItem(v, ic, label, n, hot, extra) {
    return h("button", { class: "nv-i" + (st.view === v ? " on" : "") + (extra && extra.sub ? " sub" : ""), "data-nav": v, onclick: () => {
      st.view = v; st.q = ""; st.checked = []; st.open = false; st.compose = st.compose && st.compose.floating ? st.compose : null;
      if (v === "knowledge") { st.note = null; }
      else if (v.indexOf("note:") === 0) { st.note = v.slice(5); }
      else if (v !== "drafts") { var f = flat(); if (f.length && f.map((x) => { return x.id; }).indexOf(st.sel) < 0) select(f[0].id); else if (!f.length) st.sel = null; }
      else if (drafts.length) openDraft(drafts[0]);
      render();
    } }, extra && extra.dot ? h("span", { class: "dot " + extra.dot }) : icon(ic, "s14"), h("span", { class: "lbl" }, label), n != null && n !== 0 ? h("span", { class: "ct" + (hot ? " hot" : "") }, n) : null);
  }
  function sec(key, label, kids, act) {
    var closed = st.col[key] === false;
    return [h("div", { class: "nv-sec" }, h("button", { onclick: () => { st.col[key] = closed ? true : false; render(); } }, icon(closed ? "right" : "down", "s12")), label, act || null), closed ? null : kids];
  }
  function nav() {
    var unreadIn = threads.filter((t) => { return M[t.id].box === "open" && M[t.id].unread; }).length;
    var main = [
      navItem("inbox", "inbox", "Inbox", count("inbox") + (FIRST ? 1 : 0), unreadIn > 0 || FIRST),
      navItem("assigned", "user", "Assigned to me", count("assigned"), count("assigned") > 0),
      navItem("review", "eye", "Needs review", count("review")),
      navItem("drafts", "pen", "Drafts", drafts.length),
      navItem("snoozed", "clock", "Snoozed", count("snoozed")),
      navItem("done", "done", "Done", count("done")),
    ];
    var agents = D.providers.map((p) => {
      var n = count("agent:" + p.id);
      return h("button", { class: "nv-i" + (st.view === "agent:" + p.id ? " on" : ""), "data-nav": "agent:" + p.id, onclick: () => { st.view = "agent:" + p.id; var f = flat(); if (f.length) select(f[0].id); else st.sel = null; render(); } },
        av(p.id), h("span", { class: "lbl" }, p.label),
        n ? h("span", { class: "ct", style: "display:inline-flex;align-items:center;gap:4px;color:var(--run)" }, h("span", { class: "spin" }), n) : FIRST ? h("span", { class: "ct" }, st.agents[p.id] === "ready" ? "ready" : "set up") : null);
    });
    var know = [navItem("knowledge", "book", "Topics", null)].concat(notes.map((n) => { return navItem("note:" + n.id, "file", n.title, null, false, { sub: false }); }));
    var views = [
      navItem("bookmarked", "bookmark", "Bookmarked", count("bookmarked")),
      navItem("highlights", "highlight", "With highlights", count("highlights")),
      navItem("failed", "alert", "Failed runs", count("failed")),
    ];
    var tags = allTags().slice(0, 6).map((g) => { return navItem("tag:" + g.tag, "hash", g.tag, g.n, false, { dot: "tagc" + hashc(g.tag) }); });
    var wss = D.workspaces.map((w) => {
      var fs = D.folders.filter((f) => { return f.workspaceId === w.id; });
      var open = V === "c" ? st.col[w.id] !== false : st.col[w.id] === true;
      return [h("div", { style: "display:flex;align-items:center" },
        h("button", { class: "ibtn", style: "width:18px;height:28px;color:var(--tx3)", onclick: () => { st.col[w.id] = !open; render(); } }, icon(open ? "down" : "right", "s12")),
        navItem("ws:" + w.id, "layers", w.name, threads.filter((t) => { return t.workspaceId === w.id && M[t.id].box === "open"; }).length)),
      open ? fs.map((f) => { return navItem("folder:" + f.id, "folder", f.name, count("folder:" + f.id), false, { sub: true }); }) : null];
    });
    var wsSec = sec("wss", "Workspaces", wss);
    var out = [h("button", { class: "nv-ws" }, h("span", { class: "sq" }, "S"), h("span", { class: "grow ell" }, "All workspaces"), icon("down", "s12"))];
    if (V === "d") out.push(sec("know", "Knowledge", know));
    out.push(main);
    if (V === "c") out.push(wsSec);
    out.push(sec("agents", "Agents", agents));
    if (V !== "d") out.push(sec("know", "Knowledge", know));
    if (!FIRST) out.push(sec("views", "Views", views), sec("tags", "Tags", tags));
    if (V !== "c" && !FIRST) out.push(wsSec);
    out.push(h("div", { class: "nv-foot" }, h("button", { class: "nv-i", onclick: () => { st.view = "inbox"; st.welcomeInInbox = true; select("welcome"); st.compose = null; render(); } }, icon("help", "s14"), h("span", { class: "lbl" }, "Getting started"))));
    return h("nav", { class: "nav", "data-sk": "nav" }, out);
  }

  /* ---- list */
  function statusPill(t, short) {
    var s = t.status, m = M[t.id];
    if (m && m.box === "snoozed") return h("span", { class: "pill snz" }, icon("clock", "s12"), m.snooze);
    if (s === "done") return m && m.box === "done" ? h("span", { class: "pill ok" }, icon("check", "s12"), "Done") : null;
    if (s === "running") return h("span", { class: "pill run" }, h("span", { class: "spin" }), "Running");
    return h("span", { class: "pill " + tone(s) }, D.statuses[s].label);
  }
  function rowThread(t) {
    var m = M[t.id], chk = st.checked.indexOf(t.id) >= 0;
    var pv = st.view === "search" ? snippet(t, st.q) : preview(t);
    return h("div", { class: "row" + (st.sel === t.id ? " sel" : "") + (m.unread ? " unread" : "") + (m.box === "done" ? " done" : ""), "data-row": t.id, onclick: () => { select(t.id); st.compose = st.compose && st.compose.floating ? st.compose : null; render(); } },
      h("button", { class: "chk" + (chk ? " on" : ""), title: "Select (x)", onclick: (e) => { e.stopPropagation(); toggleCheck(t.id); } }, chk ? icon("check") : null),
      h("span", { class: "av " + t.provider, style: "margin-top:1px" }, AG[t.provider].short),
      h("div", { style: "min-width:0" },
        h("div", { class: "l1" }, h("span", { class: "snd ell" }, AG[t.provider].label), h("span", { class: "mdl ell" }, t.model), m.unread ? h("span", { class: "udot" }) : null, h("span", { class: "tm" }, ftime(t.updatedAt))),
        h("div", { class: "sub ell" }, t.title),
        h("div", { class: "pv" }, statusPill(t), h("span", { class: "ell grow" }, pv))));
  }
  function rowDraft(d) {
    return h("div", { class: "row" + (st.sel === d.id ? " sel" : ""), "data-row": d.id, onclick: () => { openDraft(d); render(); } },
      h("span"), h("span", { class: "av sm " + d.provider, style: "margin:3px 0 0 3px;opacity:.55" }, AG[d.provider].short),
      h("div", { style: "min-width:0" },
        h("div", { class: "l1" }, h("span", { class: "snd" }, "Draft"), h("span", { class: "mdl" }, "unassigned · " + wsName(d.workspaceId)), h("span", { class: "tm" }, ftime(d.updatedAt))),
        h("div", { class: "sub", style: "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden" }, d.prompt)));
  }
  function rowWelcome() {
    return h("div", { class: "row" + (st.sel === "welcome" ? " sel" : "") + (FIRST && !st.tut.opened ? " unread" : ""), "data-row": "welcome", onclick: () => { select("welcome"); st.compose = null; render(); } },
      h("span"), h("span", { class: "av sys" }, "S"),
      h("div", { style: "min-width:0" },
        h("div", { class: "l1" }, h("span", { class: "snd" }, "Session"), h("span", { class: "mdl" }, "getting started"), h("span", { class: "tm" }, "Now")),
        h("div", { class: "sub ell" }, "Welcome to Session: your research inbox"),
        h("div", { class: "pv" }, h("span", { class: "pill attention" }, "3 steps"), h("span", { class: "ell grow" }, "Connect an agent, ask a question, learn the triage keys."))));
  }
  function toggleCheck(id) { var k = st.checked.indexOf(id); if (k >= 0) st.checked.splice(k, 1); else st.checked.push(id); render(); }
  function bulkBar() {
    return h("div", { class: "bulk-bar" },
      h("button", { class: "chk on", onclick: () => { st.checked = []; render(); } }, icon("check")),
      h("b", null, st.checked.length + " selected"),
      h("button", { class: "btn", onclick: () => { markDone(); } }, icon("check", "s14"), "Done", kbd("E")),
      h("button", { class: "btn", "data-mk": "snooze", onclick: (e) => { openMenu("snooze", e); } }, icon("clock", "s14")),
      h("button", { class: "btn", "data-mk": "tag", onclick: (e) => { openMenu("tag", e); } }, icon("hash", "s14")),
      h("button", { class: "btn", "data-mk": "move", onclick: (e) => { openMenu("move", e); } }, icon("folder", "s14")));
  }
  function listEmpty() {
    var v = st.view, running = threads.filter(isActive).length;
    var txt = {
      inbox: ["Inbox zero", "Nothing needs you. " + (running ? running + " runs are still in progress; they arrive here when they finish." : "Ask a question to start a run.")],
      assigned: ["Nothing assigned to you", "Finished answers, failed runs and agent questions land here until you mark them done."],
      review: ["No questions from agents", "When an agent asks for a decision before it continues, the conversation appears here."],
      snoozed: ["Nothing snoozed", "Press H on a conversation to hide it until a time, or until its run finishes."],
      done: ["Nothing done yet", "Press E on a conversation to mark it done. Done conversations are filed into Knowledge."],
      drafts: ["No drafts", "Unsent questions are saved here."],
      search: ["No results", "Search covers titles, questions, answers and tags."],
    }[v] || ["Nothing here", "No conversations match this view."];
    return h("div", { class: "empty" },
      h("div", { class: "big" }, icon(v === "search" ? "search" : "check")),
      h("h3", null, txt[0]), h("p", null, txt[1]),
      h("div", { class: "acts" }, h("button", { class: "btn pri", onclick: newCompose }, "New question", kbd("C")), h("button", { class: "btn", onclick: () => { st.view = "knowledge"; render(); } }, icon("book", "s14"), "Knowledge")));
  }
  function listBody() {
    var gs = groups(), out = [];
    gs.forEach((g) => {
      if (g.label) out.push(h("div", { class: "lgrp" }, g.label, h("span", { class: "n" }, g.items.length)));
      g.items.forEach((x) => { out.push(x.kind === "thread" ? rowThread(x.t) : x.kind === "draft" ? rowDraft(x.d) : rowWelcome()); });
    });
    if (FIRST && st.view === "inbox" && !threads.length) out.push(h("div", { class: "ghost" }, h("div", { class: "gh" }, "What arrives in Inbox"),
      [["run", "Running", "A question you sent, while the agent works"], ["ok", "Answered", "A finished answer you have not read"], ["attention", "Needs review", "The agent asks you to decide something"], ["error", "Failed", "A run that stopped with an error"]].map((r) => { return h("div", { class: "gr" }, h("span", { class: "pill " + r[0] }, r[0] === "run" ? h("span", { class: "spin" }) : null, r[1]), h("span", null, r[2])); }),
      h("p", null, "Mark a conversation done with E when you have what you need. It leaves Inbox and is filed into Knowledge.")));
    if (st.view === "search") {
      var ns = notes.filter((n) => { return (n.title + " " + JSON.stringify(n.outline)).toLowerCase().indexOf(st.q.toLowerCase()) >= 0; });
      if (ns.length) { out.push(h("div", { class: "lgrp" }, "Notes", h("span", { class: "n" }, ns.length))); ns.forEach((n) => { out.push(h("button", { class: "topic", onclick: () => { st.view = "note:" + n.id; st.note = n.id; st.q = ""; render(); } }, icon("file", "s14"), h("span", { class: "grow ell" }, n.title), h("span", { class: "d" }, wsName(n.workspaceId)))); }); }
    }
    return out;
  }
  function listCol() {
    var items = listBody();
    var n = st.view === "drafts" ? drafts.length : count(st.view) + ((FIRST || st.welcomeInInbox) && st.view === "inbox" ? 1 : 0);
    var head = st.checked.length ? bulkBar() : h("div", { class: "lh" },
      h("button", { class: "chk", title: "Select all", onclick: () => { st.checked = flat().filter((x) => { return x.kind === "thread"; }).map((x) => { return x.id; }); render(); } }),
      h("h2", null, st.view === "search" ? "“" + st.q + "”" : viewName(st.view)), h("span", { class: "ct" }, n),
      h("span", { class: "grow" }),
      h("button", { class: "ibtn", title: "Filter" }, icon("filter", "s14")),
      h("button", { class: "btn sm", title: "Sort" }, icon("sort", "s14"), "Newest"));
    return h("section", { class: "list" + (st.checked.length ? " bulk" : "") }, head,
      items.length ? h("div", { class: "lscroll", "data-sk": "list" }, items) : listEmpty(),
      h("div", { class: "lfoot" }, h("span", null, kbd("J"), kbd("K"), "move"), h("span", null, kbd("E"), "done"), h("span", null, kbd("H"), "snooze"), h("span", null, kbd("#"), "tag"), h("span", null, kbd("?"), "all")));
  }

  /* ---- variant b: split inbox */
  function splitTabs() {
    var tabs = [["inbox", "Inbox", count("inbox")], ["assigned", "Needs you", count("assigned")], ["running", "Running", count("running")], ["drafts", "Drafts", drafts.length], ["snoozed", "Snoozed", count("snoozed")], ["done", "Done", count("done")], ["knowledge", "Knowledge", null]];
    return h("div", { class: "split" }, tabs.map((x) => {
      return h("button", { class: "stab" + (st.view === x[0] ? " on" : ""), "data-nav": x[0], onclick: () => {
        st.view = x[0]; st.open = false; st.checked = []; st.compose = null;
        if (x[0] === "drafts" && drafts.length) st.sel = drafts[0].id;
        else if (x[0] !== "knowledge") { var f = flat(); if (f.length && f.map((y) => { return y.id; }).indexOf(st.sel) < 0) st.sel = f[0].id; }
        render();
      } }, x[1], x[2] != null ? h("span", { class: "n" }, x[2]) : null);
    }), h("span", { class: "grow" }), h("span", { class: "lfoot", style: "border:0;height:44px;padding:0" }, h("span", null, kbd("J"), kbd("K"), "move"), h("span", null, kbd("↵"), "open"), h("span", null, kbd("E"), "done"), h("span", null, kbd("H"), "snooze"), h("span", null, kbd("?"), "all")));
  }
  function wrowT(t, dim) {
        var m = M[t.id], chk = st.checked.indexOf(t.id) >= 0;
        return h("div", { class: "wrow" + (st.sel === t.id ? " sel" : "") + (m.unread ? " unread" : "") + (dim ? " dim" : ""), "data-row": t.id, onclick: () => { select(t.id, { open: true }); render(); } },
          h("button", { class: "chk" + (chk ? " on" : ""), onclick: (e) => { e.stopPropagation(); toggleCheck(t.id); } }, chk ? icon("check") : null),
          av(t.provider),
          h("span", { class: "snd" }, AG[t.provider].label + " ", h("span", { class: "mdl" }, t.model)),
          h("span", { class: "sp" }, h("b", null, t.title), " — " + (st.view === "search" ? snippet(t, st.q) : preview(t))),
          h("span", { class: "rt" }, statusPill(t), t.tags.slice(0, 2).map((g) => { return tagChip(g); })),
          h("span", { class: "tm" }, ftime(t.updatedAt)));
  }
  function wideList() {
    if (st.compose) return h("div", { class: "wide", style: "background:var(--pane)" }, composePage());
    var gs = groups(), rows = [];
    if (V === "b" && st.view === "inbox") {
      var ts = flat();
      gs = [{ label: "Needs you", items: ts.filter((x) => { return x.t && needsYou(x.t); }) }, { label: "Running and queued", items: ts.filter((x) => { return x.t && isActive(x.t); }) }, { label: "Other", items: ts.filter((x) => { return !x.t || (!needsYou(x.t) && !isActive(x.t)); }) }].filter((g) => { return g.items.length; });
    }
    gs.forEach((g) => {
      if (g.label) rows.push(h("div", { class: "wgrp" }, g.label + " · " + g.items.length));
      g.items.forEach((x) => {
        if (x.kind === "draft") { var d = x.d; rows.push(h("div", { class: "wrow" + (st.sel === d.id ? " sel" : ""), "data-row": d.id, onclick: () => { openDraft(d); render(); } }, h("span"), av(d.provider), h("span", { class: "snd" }, "Draft ", h("span", { class: "mdl" }, wsName(d.workspaceId))), h("span", { class: "sp" }, h("b", null, d.prompt)), h("span"), h("span", { class: "tm" }, ftime(d.updatedAt)))); return; }
        if (x.kind === "welcome") return;
        rows.push(wrowT(x.t));
      });
    });
    if (rows.length && st.view === "inbox") {
      rows.push(h("div", { class: "caught" }, icon("check", "s14"), "That is everything open. Below: snoozed and recently done."));
      [["snoozed", "Snoozed"], ["done", "Done recently"]].forEach((g) => {
        var ts = threads.filter((t) => { return inView(t, g[0]); }).sort(sortT);
        if (!ts.length) return;
        rows.push(h("div", { class: "wgrp" }, g[1] + " · " + ts.length));
        ts.forEach((t) => { rows.push(wrowT(t, true)); });
      });
    }
    return h("div", { class: "wide" }, st.checked.length ? bulkBar() : null, rows.length ? h("div", { class: "lscroll", "data-sk": "list" }, rows) : listEmpty());
  }

  /* ---- conversation */
  function toolbar(t) {
    var pk = st.pick[t.id] || { provider: t.provider, model: t.model };
    var f = flat(), i = f.map((x) => { return x.id; }).indexOf(t.id);
    return h("div", { class: "ctb" },
      V === "b" ? [h("button", { class: "btn sm", onclick: () => { st.open = false; render(); } }, icon("arrowl", "s14"), viewName(st.view), kbd("Esc")), h("span", { class: "pager", style: "margin:0 6px" }, (i + 1) + " of " + f.length, h("button", { class: "ibtn", onclick: () => { move(-1); } }, icon("up", "s14")), h("button", { class: "ibtn", onclick: () => { move(1); } }, icon("down", "s14"))), h("span", { class: "sep" })] : null,
      h("button", { class: "asg", "data-mk": "assign", title: "Assign the next question to an agent (A)", onclick: (e) => { openMenu("assign", e, { ids: [t.id] }); } },
        av(pk.provider), AG[pk.provider].label, h("span", { class: "muted" }, pk.model), icon("down", "s12")),
      statusPill(t),
      h("span", { class: "grow" }),
      h("button", { class: "ibtn", "data-mk": "tag", title: "Tag (#)", onclick: (e) => { openMenu("tag", e, { ids: [t.id] }); } }, icon("hash")),
      h("button", { class: "ibtn", "data-mk": "move", title: "Move to folder (M)", onclick: (e) => { openMenu("move", e, { ids: [t.id] }); } }, icon("folder")),
      h("button", { class: "ibtn", "data-mk": "snooze", title: "Snooze (H)", onclick: (e) => { openMenu("snooze", e, { ids: [t.id] }); } }, icon("clock")),
      h("button", { class: "ibtn" + (t.bookmarked ? " on" : ""), title: "Bookmark", onclick: () => { t.bookmarked = !t.bookmarked; render(); } }, icon("bookmark")),
      h("span", { class: "sep" }),
      M[t.id].box === "done"
        ? h("button", { class: "btn", onclick: () => { M[t.id].box = "open"; toast("Moved back to Inbox."); render(); } }, icon("inbox", "s14"), "Reopen")
        : h("button", { class: "btn ok", "data-act": "done", onclick: () => { markDone([t.id]); } }, icon("check", "s14"), "Done", kbd("E")));
  }
  function convHead(t) {
    var nb = t.turns.filter((u) => { return u.relation === "branch"; }).length;
    return h("div", { class: "chead" },
      h("h1", null, t.title),
      h("div", { class: "meta" },
        h("button", { class: "crumb", "data-mk": "move2", onclick: (e) => { openMenu("move", e, { ids: [t.id] }); } }, icon("layers", "s12"), wsName(t.workspaceId), icon("right", "s12"), icon("folder", "s12"), folderName(t.folderId)),
        h("span", null, "·"), h("span", null, pl(t.turns.length, "question") + (nb ? ", " + nb + " branch" + (nb > 1 ? "es" : "") : "")),
        t.tags.map((g) => { return h("button", { class: "chip", onclick: () => { st.view = "tag:" + g; render(); } }, h("span", { class: "dot tagc" + hashc(g) }), g); }),
        h("button", { class: "chip", "data-mk": "tag2", onclick: (e) => { openMenu("tag", e, { ids: [t.id] }); } }, icon("plus", "s12"))));
  }
  function paraEl(t, u, i, text) {
    var ranges = [];
    u.highlights.filter((x) => { return x.paragraph === i; }).forEach((x) => { var k = text.indexOf(x.quote); if (k >= 0) ranges.push({ s: k, e: k + x.quote.length, hl: x }); });
    kids(t, u.id, "branch").filter((b) => { return b.anchor && b.anchor.paragraph === i; }).forEach((b) => {
      var k = text.indexOf(b.anchor.quote);
      if (k >= 0 && !ranges.some((r) => { return k < r.e && k + b.anchor.quote.length > r.s; })) ranges.push({ s: k, e: k + b.anchor.quote.length, br: b });
    });
    ranges.sort((a, b) => { return a.s - b.s; });
    var p = h("div", { class: "para" }), pos = 0;
    ranges.forEach((r) => {
      if (r.s < pos) return;
      p.appendChild(md(text.slice(pos, r.s)));
      if (r.hl) p.appendChild(h("mark", { class: "hl " + r.hl.color, title: r.hl.note || "Highlight" }, md(text.slice(r.s, r.e))));
      else p.appendChild(h("mark", { class: "br", title: "Branch: " + r.br.title, onclick: () => { st.path[t.id] = r.br.id; st.scrollTl = "top"; render(); } }, md(text.slice(r.s, r.e))));
      if (r.br) p.appendChild(h("span", { class: "bmark", title: "Open branch", onclick: () => { st.path[t.id] = r.br.id; render(); } }, icon("branch", "s12")));
      pos = r.e;
    });
    p.appendChild(md(text.slice(pos)));
    if (u.status !== "running") {
      var q = firstSentence(text, 80);
      p.appendChild(h("div", { class: "pa" },
        h("button", { title: "Ask a question in a new branch from this paragraph", onclick: () => { st.mode = "branch"; st.anchor = { turnId: u.id, paragraph: i, quote: q }; st.focus = "cmp"; render(); } }, icon("branch", "s12"), "Branch"),
        h("button", { onclick: () => { u.highlights.push({ id: "hx" + (seq++), paragraph: i, quote: plain(text).indexOf(q) === 0 ? text.slice(0, Math.min(text.length, 60)) : text.slice(0, 60), color: "amber", note: null, createdAt: nowIso() }); toast("Highlighted. Listed under Highlights in the context pane."); render(); } }, icon("highlight", "s12"), "Highlight"),
        h("button", { onclick: () => { st.mode = "note"; st.anchor = { turnId: u.id, paragraph: i, quote: q }; st.focus = "cmp"; render(); } }, icon("note", "s12"), "Note"),
        V === "d" ? h("button", { onclick: () => { addToNote(t, u, q); } }, icon("list", "s12"), "Add to note") : null));
    }
    return p;
  }
  function openThread(t, turnId) {
    var b = M[t.id].box;
    st.view = b === "done" ? "done" : b === "snoozed" ? "snoozed" : "inbox";
    select(t.id);
    if (turnId) st.path[t.id] = turnId;
    if (V === "b") st.open = true;
    render();
  }
  function addToNote(t, u, text) {
    var ns = notesFor(t), n = ns[0] || notes.filter((x) => { return x.workspaceId === t.workspaceId; })[0];
    if (!n) { n = { id: "nn" + (seq++), workspaceId: t.workspaceId, title: "Notes: " + firstSentence(t.title, 30), updatedAt: nowIso(), tags: [], outline: [] }; notes.push(n); }
    n.outline.push({ text: text, ref: { threadId: t.id, turnId: u.id }, fresh: true });
    n.updatedAt = nowIso();
    st.tab = "notes";
    toast("Added to “" + n.title + "”.");
    render();
  }
  function qMsg(t, u) {
    var anc = u.anchor && turn(t, u.anchor.turnId);
    return h("div", { class: "msg q" },
      h("div", { class: "mh" }, h("span", { class: "av me" }, D.user.initials), h("b", null, "You"),
        h("span", { class: "to ell" }, "to " + AG[u.provider].label + " · " + u.model + (u.effort ? " · " + u.effort : "")),
        u.relation !== "root" ? h("span", { class: "relc " + u.relation }, icon(u.relation === "branch" ? "branch" : "reply", "s12"), u.relation === "branch" ? "Branch" : "Follow-up") : null,
        h("span", { class: "tm" }, ftime(u.createdAt))),
      h("div", { class: "qbody" },
        anc && u.anchor.quote ? h("div", { class: "quote" }, "From ¶" + (u.anchor.paragraph + 1) + " of “" + anc.title + "”: ", md(u.anchor.quote)) : null,
        md(u.question)));
  }
  function aMsg(t, u, collapsed) {
    var head = h("div", { class: "mh" }, h("span", { class: "av " + u.provider }, AG[u.provider].short), h("b", null, AG[u.provider].label),
      h("span", { class: "to" }, u.model),
      u.status === "done" && u.durationSec ? h("span", { class: "to" }, "· " + fdur(u.durationSec)) : null,
      u.activity.length && u.status !== "running" ? h("button", { class: "to", style: "color:var(--acc)", title: "Show run trace", onclick: (e) => { e.stopPropagation(); st.tab = "run"; st.runTurn = u.id; render(); } }, "· " + u.activity.length + " steps") : null,
      h("span", { class: "tm" }, ftime(u.completedAt || u.createdAt)));
    if (collapsed) return h("div", { class: "msg collapsed", onclick: () => { st.exp[u.id] = true; render(); } }, head,
      h("div", { class: "mb", style: "padding-top:0;padding-bottom:10px" }, h("div", { class: "pvw ell" }, u.recap || (u.answer[0] ? plain(u.answer[0]) : ""))));
    var bodyKids = [];
    if (u.status === "queued") {
      return h("div", { class: "msg" }, head, h("div", { class: "mb" }, h("div", { class: "queued" }, h("span", { class: "pill plain" }, "Queued"), "Starts when the running answer above finishes. One answer runs at a time per conversation."),
        h("div", { style: "display:flex;gap:6px;margin-top:8px" }, h("button", { class: "btn sm", onclick: () => { st.text[t.id] = u.question; t.turns = t.turns.filter((x) => { return x !== u; }); st.path[t.id] = u.parentId; st.focus = "cmp"; recompute(t); render(); } }, icon("pen", "s12"), "Edit question"),
          h("button", { class: "btn sm", onclick: () => { t.turns = t.turns.filter((x) => { return x !== u; }); st.path[t.id] = u.parentId; recompute(t); render(); } }, icon("x", "s12"), "Remove"))));
    }
    if (u.recap && u.status === "done") bodyKids.push(h("div", { class: "recap" }, h("b", null, "Recap"), u.recap));
    if (u.status === "running") {
      var a = u.activity[u.activity.length - 1];
      var base = u.startedMs ? 0 : (NOW - Date.parse(u.createdAt)) / 1000;
      bodyKids.push(h("div", { class: "working" }, h("span", { class: "spin" }), h("span", { class: "ell grow" }, "Working · " + (a ? a.label : "starting")),
        h("span", { class: "el", "data-el": u.startedMs ? "s" + u.startedMs : "b" + base }, fdur(u.startedMs ? (Date.now() - u.startedMs) / 1000 : base + (Date.now() - T0) / 1000)),
        h("button", { class: "btn sm", onclick: () => { st.tab = "run"; st.runTurn = u.id; render(); } }, icon("activity", "s12"), "Trace"),
        h("button", { class: "btn sm", onclick: () => { u.status = "failed"; u.error = "Stopped by you."; recompute(t); render(); } }, icon("stop", "s12"), "Stop")));
    }
    if (u.status === "failed") bodyKids.push(h("div", { class: "errbox" }, h("b", null, "Run failed. "), md(u.error || "")),
      h("div", { style: "display:flex;gap:6px" }, h("button", { class: "btn sm", onclick: () => { u.error = null; startRun(t, u); render(); } }, icon("retry", "s12"), "Retry"), h("button", { class: "btn sm", onclick: () => { st.text[t.id] = u.question; st.focus = "cmp"; render(); } }, icon("pen", "s12"), "Edit question")));
    u.answer.forEach((p, i) => { bodyKids.push(paraEl(t, u, i, p)); });
    if (u.status === "running") bodyKids.push(h("span", { class: "cursor" }));
    if (u.clarification && u.status === "needs-review") bodyKids.push(h("div", { class: "clar" }, h("div", { class: "t" }, icon("help", "s14"), AG[u.provider].label + " needs a decision"), h("p", null, u.clarification),
      h("div", { style: "display:flex;gap:6px;flex-wrap:wrap" },
        ["Yes, several voters at once", "No, always one node at a time"].map((s) => { return h("button", { class: "btn sm", onclick: () => { st.text[t.id] = s + "."; st.mode = "followup"; st.focus = "cmp"; render(); } }, s); }),
        h("button", { class: "btn sm", onclick: () => { st.focus = "cmp"; render(); } }, icon("reply", "s12"), "Answer in reply"))));
    var foot = u.status === "done" || u.status === "needs-review" ? h("div", { class: "mf" },
      h("div", { class: "src" }, u.sources.slice(0, 3).map((s) => { return h("button", { class: "chip", title: s.title, onclick: () => { toast("Opens " + s.domain + " in the browser panel."); render(); } }, h("span", { class: "fav", style: "width:14px;height:14px;line-height:14px;font-size:8px;margin:0" }, s.domain[0]), s.domain); })),
      h("button", { class: "lnk", onclick: () => { st.mode = "followup"; st.path[t.id] = u.id; st.focus = "cmp"; render(); } }, icon("reply", "s14"), "Reply"),
      h("button", { class: "lnk", onclick: () => { st.mode = "branch"; st.anchor = { turnId: u.id, paragraph: null, quote: null }; st.focus = "cmp"; render(); } }, icon("branch", "s14"), "Branch"),
      h("button", { class: "lnk", onclick: () => { st.mode = "note"; st.anchor = null; st.focus = "cmp"; render(); } }, icon("note", "s14"), "Note")) : null;
    return h("div", { class: "msg", "data-turn": u.id }, head, h("div", { class: "mb" }, bodyKids), foot);
  }
  function comments(t, u) {
    var out = [];
    u.highlights.filter((x) => { return x.note; }).forEach((x) => { out.push(cmt(x.note, x.quote, x.createdAt, x.color)); });
    M[t.id].comments.filter((c) => { return c.turnId === u.id; }).forEach((c) => { out.push(cmt(c.text, c.quote, c.at)); });
    return out;
  }
  function cmt(text, quote, at) {
    return h("div", { class: "cmt" }, h("div", { class: "mh" }, h("span", { class: "av sm me" }, D.user.initials), h("b", null, "You"), h("span", { class: "lab" }, "Note · private"), h("span", { class: "tm" }, ftime(at))),
      quote ? h("div", { class: "cq" }, md(quote)) : null, h("div", { class: "ct" }, md(text)));
  }
  function timeline(t) {
    var path = pathFor(t), out = [];
    var lastBr = null; path.forEach((u) => { if (u.relation === "branch") lastBr = u; });
    if (lastBr) {
      var par = turn(t, lastBr.parentId);
      out.push(h("div", { class: "banner" }, icon("branch", "s14"), h("span", { class: "grow ell" }, h("b", null, "Branch: " + lastBr.title), " · forked from “" + par.title + "”"),
        h("button", { class: "btn sm", onclick: () => { st.path[t.id] = par.relation === "branch" ? par.id : t.rootTurnId; render(); } }, icon("arrowl", "s12"), par.relation === "branch" ? "Parent branch" : "Main line")));
    }
    out.push(h("div", { class: "evt" }, icon("inbox", "s12"), h("span", null, "Started ", h("b", null, fdate(t.createdAt)), " in " + wsName(t.workspaceId) + " › " + folderName(t.folderId)), h("span", { class: "ln" })));
    path.forEach((u, i) => {
      var col = i < path.length - 2 && !st.exp[u.id] && u.status === "done";
      out.push(qMsg(t, u));
      out.push(aMsg(t, u, col));
      if (!col) out = out.concat(comments(t, u));
      kids(t, u.id, "branch").filter((b) => { return path.indexOf(b) < 0; }).forEach((b) => {
        var n = 1; (function c(x) { kids(t, x.id).forEach((k) => { n++; c(k); }); })(b);
        out.push(h("button", { class: "fork", "data-fork": b.id, onclick: () => { st.path[t.id] = b.id; st.scrollTl = "top"; render(); } }, icon("branch"),
          h("span", { class: "grow", style: "min-width:0" }, h("span", { class: "t" }, b.title), h("span", { class: "muted" }, " · branch" + (b.anchor ? " from ¶" + (b.anchor.paragraph + 1) : "") + " · " + n + " question" + (n > 1 ? "s" : "") + " · " + AG[b.provider].label)),
          h("span", { class: "sdot " + tone(b.status) }), icon("right", "s14")));
      });
    });
    if (M[t.id].box === "done") out.push(h("div", { class: "evt" }, icon("check", "s12"), h("span", null, "Marked done · filed in ", h("b", null, "Knowledge › " + folderName(t.folderId))), h("span", { class: "ln" })));
    if (M[t.id].box === "snoozed") out.push(h("div", { class: "evt" }, icon("clock", "s12"), h("span", null, "Snoozed until ", h("b", null, M[t.id].snooze)), h("span", { class: "ln" })));
    return out;
  }
  function composer(t) {
    var path = pathFor(t), last = path[path.length - 1];
    var pk = st.pick[t.id] || { provider: last.provider, model: last.model, effort: last.effort };
    var diff = pk.provider !== t.provider;
    var mode = st.mode, busy = last.status === "running" || last.status === "queued";
    var ph = mode === "note" ? "Write a private note on this answer. Notes are never sent to an agent." : mode === "branch" ? "Ask in a new branch. This line of the conversation stays as it is." : diff ? "Ask " + AG[pk.provider].label + " the same thread as a branch, to compare answers" : "Reply with a follow-up. It continues this conversation with the agent's context.";
    if (V === "c") {
      return h("div", { class: "replybar" },
        h("button", { class: "btn pri", onclick: () => { st.mode = "followup"; st.compose = { floating: true, reply: t.id }; st.focus = "cmp"; render(); } }, icon("reply", "s14"), "Reply", kbd("R")),
        h("button", { class: "btn", onclick: () => { st.mode = "branch"; st.compose = { floating: true, reply: t.id }; st.focus = "cmp"; render(); } }, icon("branch", "s14"), "Branch"),
        h("button", { class: "btn", onclick: () => { st.mode = "note"; st.compose = { floating: true, reply: t.id }; st.focus = "cmp"; render(); } }, icon("note", "s14"), "Note", kbd("N")),
        h("span", { class: "grow" }), h("span", { class: "muted", style: "font-size:12px;white-space:nowrap" }, "to " + AG[pk.provider].label));
    }
    return h("div", { class: "cmp" + (mode === "note" ? " note" : "") }, composerInner(t, pk, ph, busy, diff));
  }
  function composerInner(t, pk, ph, busy, diff) {
    var mode = st.mode;
    var segs = [["followup", "reply", "Follow-up"], ["branch", "branch", "Branch"], ["note", "note", "Note"]];
    return [
      h("div", { class: "cmp-top" }, segs.map((s) => { return h("button", { class: "seg" + (mode === s[0] ? " on" : ""), "data-mode": s[0], onclick: () => { st.mode = s[0]; if (s[0] !== "branch" && s[0] !== "note") st.anchor = null; st.focus = "cmp"; render(); } }, icon(s[1], "s12"), s[2]); }),
        mode !== "note" ? h("button", { class: "topick", "data-mk": "assign2", onclick: (e) => { openMenu("assign", e, { ids: [t.id] }); } }, av(pk.provider), AG[pk.provider].label + " · " + pk.model + (pk.effort ? " · " + pk.effort : ""), icon("down", "s12")) : h("span", { class: "topick" }, icon("eye", "s12"), "Only you")),
      st.anchor && st.anchor.quote ? h("div", { class: "anchor" }, icon(mode === "note" ? "note" : "branch", "s12"), h("span", { class: "q" }, st.anchor.quote), h("button", { class: "ibtn", style: "width:20px;height:20px", onclick: () => { st.anchor = null; render(); } }, icon("x", "s12"))) : null,
      h("textarea", { "data-fk": "cmp", placeholder: ph, value: st.text[t.id] || "", oninput: (e) => { st.text[t.id] = e.target.value; },
        onkeydown: (e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(e.metaKey || e.ctrlKey); }
          else if (e.key === "Escape") { e.preventDefault(); e.target.blur(); root.focus(); }
        } }),
      h("div", { class: "cmp-foot" },
        h("span", { class: "hint ell" }, mode === "note" ? "Shown to you as a yellow note in the timeline and in Notes." : busy && mode === "followup" ? "An answer is running. This follow-up will queue after it." : diff ? "Different agent: sent as a branch so both answers stay side by side." : mode === "branch" ? "Branches appear in the timeline and the conversation map." : "⇧↵ new line"),
        mode === "note" ? h("button", { class: "btn pri", onclick: () => { send(false); } }, "Add note", kbd("↵")) : [
          h("button", { class: "btn", onclick: () => { send(true); } }, "Send & Done", kbd("⌘↵")),
          h("button", { class: "btn pri", "data-act": "send", onclick: () => { send(false); } }, icon("send", "s14"), busy && mode === "followup" ? "Queue" : "Send", kbd("↵"))]),
    ];
  }
  function convCol() {
    if (st.compose && !st.compose.floating && V !== "c" && V !== "b") return h("section", { class: "conv" }, composePage());
    if (st.sel === "welcome") return welcomeConv();
    var t = byT[st.sel];
    if (!t) {
      var any = flat().length;
      return h("section", { class: "conv" }, h("div", { class: "empty" }, h("div", { class: "big", style: "background:var(--acc-bg);color:var(--acc)" }, icon(any ? "inbox" : "check")),
        h("h3", null, any ? "No conversation selected" : "All caught up"),
        h("p", null, any ? "Press J to open the next conversation, or click one in the list." : "New answers, failed runs and agent questions arrive in Inbox."),
        h("div", { class: "acts" }, h("button", { class: "btn pri", onclick: newCompose }, icon("pen", "s14"), "New question", kbd("C")))));
    }
    var tlKids = timeline(t);
    return h("section", { class: "conv" }, toolbar(t), convHead(t),
      h("div", { class: "tl", "data-sk": "tl" }, h("div", { class: "tl-in" }, tlKids)),
      composer(t));
  }
  function composePage() {
    var c = st.compose;
    return h("div", { class: "cpage", style: V === "b" ? "max-width:820px;margin:0 auto;width:100%" : "" },
      h("div", { style: "display:flex;align-items:center;gap:8px" }, h("h2", { style: "margin:0;font-size:16px;font-weight:650" }, c.draftId ? "Draft" : "New question"), h("span", { class: "grow" }), h("button", { class: "ibtn", title: "Discard (Esc)", onclick: () => { st.compose = null; render(); } }, icon("x"))),
      composeFields(c),
      h("textarea", { "data-fk": "compose", placeholder: "Ask a research question. The agent runs on this Mac with your existing CLI sign-in and can read the workspace folder.", oninput: (e) => { c.text = e.target.value; },
        onkeydown: (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); sendCompose(false); } if (e.key === "Escape") { st.compose = null; render(); root.focus(); } } }, c.text || ""),
      h("div", { class: "chelp" }, "The question goes to the agent shown in ", h("b", null, "To"), ". While it runs, the conversation sits in Inbox under ", h("b", null, "Running"), "; when it finishes, fails or asks you something it moves to ", h("b", null, "Assigned to me"), ". Press E there to mark it done and file it into Knowledge."),
      h("div", { style: "display:flex;gap:8px;align-items:center" }, h("span", { class: "grow muted", style: "font-size:12px" }, "↵ send · ⇧↵ new line · Esc discard"),
        h("button", { class: "btn", onclick: () => { sendCompose(true); } }, "Save draft"),
        h("button", { class: "btn pri", "data-act": "send-new", onclick: () => { sendCompose(false); } }, icon("send", "s14"), "Send", kbd("↵"))));
  }
  function composeFields(c) {
    return [
      h("div", { class: "cfield" }, h("span", null, "To"), h("button", { class: "asg", "data-mk": "agentc", onclick: (e) => { openMenu("assign", e, { compose: true }); } }, av(c.provider), AG[c.provider].label, h("span", { class: "muted" }, c.model + (c.effort ? " · effort " + c.effort : "")), icon("down", "s12"))),
      h("div", { class: "cfield" }, h("span", null, "File in"), h("button", { class: "crumb", "data-mk": "wsc", onclick: (e) => { openMenu("move", e, { compose: true }); } }, icon("layers", "s12"), wsName(c.ws), icon("right", "s12"), icon("folder", "s12"), folderName(c.folder), icon("down", "s12"))),
    ];
  }
  function floatCompose() {
    var c = st.compose; if (!c || !(c.floating || V === "c")) return null;
    if (c.reply) {
      var t = byT[c.reply]; if (!t) return null;
      var path = pathFor(t), last = path[path.length - 1], pk = st.pick[t.id] || { provider: last.provider, model: last.model, effort: last.effort };
      var busy = last.status === "running" || last.status === "queued";
      return h("div", { class: "float" + (st.mode === "note" ? " note" : ""), style: "height:236px" },
        h("div", { class: "fh" }, icon(st.mode === "note" ? "note" : st.mode === "branch" ? "branch" : "reply", "s14"), h("span", { class: "grow ell" }, (st.mode === "note" ? "Note on " : st.mode === "branch" ? "Branch from " : "Re: ") + t.title), h("button", { class: "ibtn", onclick: () => { st.compose = null; render(); } }, icon("x", "s14"))),
        h("div", { class: "fb", style: "padding:0" }, h("div", { class: "cmp", style: "margin:0;border:0;border-radius:0;box-shadow:none;background:transparent;flex:1;display:flex;flex-direction:column" }, composerInner(t, pk, st.mode === "note" ? "Private note. Never sent to an agent." : "Write your " + (st.mode === "branch" ? "branch question" : "follow-up"), busy, pk.provider !== t.provider))));
    }
    return h("div", { class: "float" },
      h("div", { class: "fh" }, icon("pen", "s14"), h("span", { class: "grow" }, c.draftId ? "Draft" : "New question"), h("button", { class: "ibtn", onclick: () => { st.compose = null; render(); } }, icon("x", "s14"))),
      h("div", { class: "fb" }, composeFields(c),
        h("textarea", { "data-fk": "compose", placeholder: "Ask a research question", oninput: (e) => { c.text = e.target.value; }, onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendCompose(false); } if (e.key === "Escape") { st.compose = null; render(); root.focus(); } } }, c.text || "")),
      h("div", { class: "ff" }, h("span", { class: "grow muted", style: "font-size:11.5px" }, "Runs on this Mac with your CLI sign-in"), h("button", { class: "btn", onclick: () => { sendCompose(true); } }, "Save draft"), h("button", { class: "btn pri", "data-act": "send-new", onclick: () => { sendCompose(false); } }, icon("send", "s14"), "Send", kbd("↵"))));
  }

  /* ---- welcome conversation (first run) */
  function welcomeConv() {
    st.tut.opened = true;
    var ready = Object.keys(st.agents).filter((k) => { return st.agents[k] === "ready"; }).length;
    var keys = [["J", "j", "Next conversation"], ["K", "k", "Previous"], ["E", "e", "Mark done"], ["H", "h", "Snooze"], ["C", "c", "New question"], ["/", "/", "Search"]];
    var agRow = (id, cmd) => {
      var s = st.agents[id];
      return h("div", { class: "agrow" }, h("span", { class: "av " + id }, AG[id].short),
        h("div", { style: "min-width:0" }, h("div", { class: "t" }, AG[id].label),
          h("div", { class: "d" }, s === "ready" ? [h("span", { class: "pill ok" }, icon("check", "s12"), "Ready"), "Signed in. Models: " + provider(id).models.slice(0, 3).join(", ")] :
            s === "wait" ? [h("span", { class: "pill run" }, h("span", { class: "spin" }), "Waiting for sign-in"), "Session checks again automatically."] :
            s === "login" ? [h("span", { class: "pill attention" }, "Not signed in"), "Run ", h("code", null, cmd)] :
            [h("span", { class: "pill plain" }, "Not installed"), "Install the Grok CLI, then come back here."])),
        s === "login" ? h("button", { class: "btn sm", onclick: () => { st.agents[id] = "wait"; toast("Copied: " + cmd); render(); var tm = setTimeout(() => { st.agents[id] = "ready"; toast(AG[id].label + " sign-in detected. Ready."); render(); }, 2600); timers.push(tm); } }, icon("copy", "s12"), "Copy command") :
        s === "missing" ? h("button", { class: "btn sm" }, "Install guide") : h("span"));
    };
    var tl = [
      h("div", { class: "evt" }, icon("inbox", "s12"), h("span", null, "Delivered to ", h("b", null, "Inbox"), " on first launch"), h("span", { class: "ln" })),
      h("div", { class: "msg" }, h("div", { class: "mh" }, h("span", { class: "av sys" }, "S"), h("b", null, "Session"), h("span", { class: "tm" }, "Now")),
        h("div", { class: "mb" },
          h("div", { class: "para" }, "Session sends research questions to the coding-agent CLIs on this Mac (Claude Code, Codex, Grok) and keeps every question, answer, source and tool trace as a conversation."),
          h("div", { class: "para" }, "This is the ", h("b", null, "Inbox"), ". A conversation arrives here when its run finishes, fails, or the agent needs a decision from you. Reply to ask a follow-up, branch to explore an alternative, add private notes, then press ", kbd("E"), " to mark it ", h("b", null, "Done"), ". Done conversations are filed into ", h("b", null, "Knowledge"), ", organized by folder, with your notes and highlights."))),
      h("div", { class: "wcard", "data-step": "agents" }, h("h5", null, "1 · Connect an agent", h("span", { class: "pill " + (ready ? "ok" : "attention") }, ready + " of 3 ready")), agRow("claude"), agRow("codex", "codex login"), agRow("grok")),
      h("div", { class: "wcard" }, h("h5", null, "2 · Ask your first question", st.tut.send ? h("span", { class: "pill ok" }, icon("check", "s12"), "Sent") : null),
        h("div", { class: "muted", style: "font-size:12.5px;margin:-2px 0 8px" }, "Type in the box below and press ↵, or pick an example. The run appears in Inbox under Running."),
        h("div", { class: "exq" }, ["Why does `Array.prototype.sort` allocate on every call in our engine?", "Summarize how Litestream ships WAL frames to S3, with sources.", "Compare joint consensus and single-server membership changes in Raft."].map((q) => {
          return h("button", { onclick: () => { st.text.welcome = q.replace(/`/g, ""); st.focus = "cmp"; render(); } }, md(q));
        }))),
      h("div", { class: "wcard" }, h("h5", null, "3 · Learn the triage keys", h("span", { class: "pill " + (keys.every((k) => { return st.tut[k[1]]; }) ? "ok" : "plain") }, keys.filter((k) => { return st.tut[k[1]]; }).length + " of 6")),
        h("div", { class: "tut" }, keys.map((k) => { return h("div", { class: st.tut[k[1]] ? "done" : "" }, kbd(k[0]), k[2]); }))),
      cmt("Notes like this one are private: they stay in the timeline and in Knowledge, and are never sent to an agent. Press N in any conversation to write one.", null, nowIso()),
      h("div", { class: "evt" }, h("span", { class: "ln" }), h("span", null, "Want to look around first?"), h("button", { class: "btn sm", "data-act": "sample", onclick: () => { ctx.setVariant("a"); } }, icon("layers", "s12"), "Open the sample workspace"), h("span", { class: "ln" })),
    ];
    var wtext = st.text.welcome || "";
    return h("section", { class: "conv" },
      h("div", { class: "ctb" }, h("span", { class: "asg" }, h("span", { class: "av sm sys" }, "S"), "Session"), h("span", { class: "pill attention" }, "Getting started"), h("span", { class: "grow" }),
        h("button", { class: "btn ok", onclick: () => { st.tut.e = true; if (FIRST) { st.sel = null; toast("Welcome conversation marked done. Reopen it from Welcome and shortcuts."); } else { st.welcomeInInbox = false; st.sel = flat().length ? flat()[0].id : null; } render(); } }, icon("check", "s14"), "Done", kbd("E"))),
      h("div", { class: "chead" }, h("h1", null, "Welcome to Session: your research inbox"), h("div", { class: "meta" }, h("span", { class: "crumb" }, icon("layers", "s12"), "Default workspace"), h("span", null, "· 3 steps, about a minute"))),
      h("div", { class: "tl", "data-sk": "tl" }, h("div", { class: "tl-in" }, tl)),
      h("div", { class: "cmp" },
        h("div", { class: "cmp-top" }, h("span", { class: "seg on" }, icon("pen", "s12"), "New question"), h("button", { class: "topick", "data-mk": "agentw", onclick: (e) => { openMenu("assign", e, { welcome: true }); } }, h("span", { class: "av sm " + (st.wpk || "claude") }, AG[st.wpk || "claude"].short), AG[st.wpk || "claude"].label + " · " + (st.wpk === "codex" ? "gpt-5.6-sol" : st.wpk === "grok" ? "grok-build" : "opus"), icon("down", "s12"))),
        h("textarea", { "data-fk": "cmp", placeholder: "Ask a research question to start your first conversation", oninput: (e) => { st.text.welcome = e.target.value; }, onkeydown: (e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); var p = st.wpk || "claude"; st.compose = { text: st.text.welcome, provider: p, model: p === "codex" ? "gpt-5.6-sol" : p === "grok" ? "grok-build" : "opus", effort: p === "grok" ? null : "high", ws: FIRST ? "ws-compilers" : "ws-compilers", folder: null }; st.text.welcome = ""; sendCompose(false); }
          if (e.key === "Escape") { e.target.blur(); root.focus(); }
        } }, wtext),
        h("div", { class: "cmp-foot" }, h("span", { class: "hint" }, "Runs locally with your CLI sign-in. ↵ send"), h("button", { class: "btn pri", "data-act": "send", onclick: () => { var ta = root.querySelector('[data-fk="cmp"]'); ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); } }, icon("send", "s14"), "Send", kbd("↵")))));
  }

  /* ---- context pane */
  function ctxTabs(t, tabs) {
    return h("div", { class: "tabs" }, tabs.map((x) => { return h("button", { class: "tab" + (st.tab === x[0] ? " on" : ""), "data-tab": x[0], onclick: () => { st.tab = x[0]; render(); } }, x[1], x[2] != null ? h("span", { class: "n" }, x[2]) : null); }));
  }
  function ctxCol() {
    if (st.compose && !st.compose.floating && V !== "c" && V !== "b") return composeCtx();
    if (st.sel === "welcome") return welcomeCtx();
    var t = byT[st.sel];
    if (!t) return h("aside", { class: "ctx" }, h("div", { class: "tabs" }), inboxStats());
    var srcN = 0; t.turns.forEach((u) => { srcN += u.sources.length; });
    var body = st.tab === "run" ? runPane(t) : st.tab === "notes" ? notesPane(t) : detailsPane(t);
    return h("aside", { class: "ctx" }, ctxTabs(t, [["details", "Details", null], ["run", "Run", null], ["notes", "Notes", notesFor(t).length + M[t.id].comments.length + t.turns.reduce((a, u) => { return a + u.highlights.filter((x) => { return x.note; }).length; }, 0) || null]]),
      h("div", { class: "cscroll", "data-sk": "ctx" }, body));
  }
  function inboxStats() {
    var r = threads.filter(isActive);
    return h("div", { class: "cscroll" }, h("div", { class: "sec" }, h("h4", null, "Running now", h("span", { class: "n" }, r.length)),
      r.map((t) => { return h("button", { class: "li", onclick: () => { select(t.id); render(); } }, av(t.provider), h("div", { class: "grow" }, h("div", { class: "t ell" }, t.title), h("div", { class: "d" }, preview(t)))); })));
  }
  function treeView(t) {
    var path = pathFor(t), cur = path[path.length - 1];
    var rows = [];
    (function walk(u, d) {
      var on = path.indexOf(u) >= 0;
      rows.push(h("button", { class: "tn" + (on ? " on" : "") + (u === cur ? " cur" : "") + (u.relation === "branch" ? " br" : ""), style: "padding-left:" + (6 + d * 14) + "px", "data-tn": u.id, onclick: () => { st.path[t.id] = u.id; st.scrollTl = u.relation === "followup" ? "bottom" : "top"; render(); } },
        icon(u.relation === "branch" ? "branch" : u.relation === "followup" ? "reply" : "note", "s12"), h("span", { class: "ell grow" }, u.title), h("span", { class: "sdot " + tone(u.status) })));
      kids(t, u.id, "followup").forEach((k) => { walk(k, d); });
      kids(t, u.id, "branch").forEach((k) => { walk(k, d + 1); });
    })(turn(t, t.rootTurnId), 0);
    return rows;
  }
  function detailsPane(t) {
    var srcs = [], seen = {};
    t.turns.forEach((u) => { u.sources.forEach((s) => { if (!seen[s.url]) { seen[s.url] = 1; srcs.push(s); } }); });
    var hls = []; t.turns.forEach((u) => { u.highlights.forEach((x) => { hls.push(x); }); });
    var bl = backlinks(t), ns = notesFor(t);
    var p = provider(t.provider);
    return [
      h("div", { class: "sec" }, h("h4", null, "Conversation"),
        h("dl", { class: "kv", style: "margin:0" },
          h("dt", null, "Agent"), h("dd", null, av(t.provider), AG[t.provider].label + " · " + t.model),
          h("dt", null, "Effort"), h("dd", null, t.effort || "n/a"),
          h("dt", null, "Status"), h("dd", null, statusPill(t) || h("span", { class: "pill ok" }, "Answered"), M[t.id].unread ? h("span", { class: "muted" }, "unread") : null),
          h("dt", null, "Folder"), h("dd", null, h("button", { class: "crumb", "data-mk": "move3", onclick: (e) => { openMenu("move", e, { ids: [t.id] }); } }, wsName(t.workspaceId) + " › " + folderName(t.folderId))),
          h("dt", null, "Started"), h("dd", null, fdate(t.createdAt)),
          h("dt", null, "Kind"), h("dd", null, t.kind === "post" ? "Saved link" : t.source === "imported" ? "Imported report" : "Research"))),
      h("div", { class: "sec" }, h("h4", null, "Conversation map", h("span", { class: "n" }, t.turns.length)), h("div", { class: "tree" }, treeView(t))),
      srcs.length ? h("div", { class: "sec" }, h("h4", null, "Sources", h("span", { class: "n" }, srcs.length)),
        srcs.map((s) => { return h("button", { class: "li", title: s.url, onclick: () => { toast("Opens " + s.domain + " in the browser panel."); render(); } }, h("span", { class: "fav" }, s.domain[0]), h("div", { class: "grow", style: "min-width:0" }, h("div", { class: "t" }, s.title), h("div", { class: "d ell" }, s.domain))); })) : null,
      t.links.length || bl.length ? h("div", { class: "sec" }, h("h4", null, "Linked conversations", h("span", { class: "n" }, t.links.length + bl.filter((x) => { return t.links.indexOf(x.id) < 0; }).length)),
        t.links.map((id) => { return byT[id]; }).filter(Boolean).concat(bl.filter((x) => { return t.links.indexOf(x.id) < 0; })).map((x) => {
          return h("button", { class: "li", onclick: () => { select(x.id); render(); } }, h("span", { class: "av sm " + x.provider, style: "margin-top:1px" }, AG[x.provider].short), h("div", { class: "grow", style: "min-width:0" }, h("div", { class: "t" }, x.title), h("div", { class: "d" }, (x.links.indexOf(t.id) >= 0 && t.links.indexOf(x.id) >= 0 ? "Links both ways" : t.links.indexOf(x.id) >= 0 ? "Linked from here" : "Links here") + " · " + folderName(x.folderId))));
        })) : null,
      hls.length ? h("div", { class: "sec" }, h("h4", null, "Highlights", h("span", { class: "n" }, hls.length)), hls.map((x) => { return h("div", { class: "hlq " + x.color }, md(x.quote), x.note ? h("span", { class: "nt" }, x.note) : null); })) : null,
      ns.length ? h("div", { class: "sec" }, h("h4", null, "In notes", h("span", { class: "n" }, ns.length)), ns.map((n) => { return h("button", { class: "li", onclick: () => { st.view = "note:" + n.id; st.note = n.id; render(); } }, icon("file", "s14"), h("div", { class: "grow" }, h("div", { class: "t" }, n.title), h("div", { class: "d" }, refsIn(n.outline).filter((r) => { return r.threadId === t.id; }).length + " lines reference this conversation"))); })) : null,
    ];
  }
  function runPane(t) {
    var path = pathFor(t), u = (st.runTurn && turn(t, st.runTurn)) || path.filter((x) => { return x.status === "running"; })[0] || path[path.length - 1];
    if (!u.activity.length && u.status !== "running") {
      var withAct = path.filter((x) => { return x.activity.length; }); if (withAct.length && !st.runTurn) u = withAct[withAct.length - 1];
    }
    var tot = u.activity.reduce((a, s) => { return a + s.ms; }, 0);
    return [
      h("div", { class: "sec" }, h("h4", null, "Run", h("span", { class: "n" }, u.title)),
        h("div", { class: "stats" }, h("div", { class: "stat" }, h("b", null, u.activity.length), h("span", null, "steps")), h("div", { class: "stat" }, h("b", null, u.durationSec ? fdur(u.durationSec) : u.status === "running" ? "…" : "—"), h("span", null, "duration")), h("div", { class: "stat" }, h("b", null, u.sources.length), h("span", null, "sources"))),
        h("dl", { class: "kv", style: "margin:8px 0 0" }, h("dt", null, "Agent"), h("dd", null, AG[u.provider].label), h("dt", null, "Model"), h("dd", null, u.model + (u.effort ? " · effort " + u.effort : "")), h("dt", null, "Status"), h("dd", null, h("span", { class: "pill " + tone(u.status) }, u.status === "running" ? h("span", { class: "spin" }) : null, D.statuses[u.status].label)), h("dt", null, "Tool time"), h("dd", null, fms(tot)))),
      h("div", { class: "sec" }, h("h4", null, "Trace"), u.activity.length ? u.activity.map((s) => {
        return h("div", { class: "step " + s.status }, s.status === "running" ? h("span", { class: "spin", style: "margin:4px 0 0 4px;color:var(--run)" }) : icon(s.status === "error" ? "alert" : KIND_ICON[s.kind] || "more", "s14"), h("div", { style: "min-width:0" }, h("div", { class: "t" }, s.label), s.detail ? h("div", { class: "d" }, s.detail) : null), h("span", { class: "ms" }, s.status === "running" ? "now" : fms(s.ms)));
      }) : h("div", { class: "mut" }, u.status === "queued" ? "Not started. Queued behind the running answer." : "No tool calls recorded for this item.")),
      h("div", { class: "sec" }, h("h4", null, "Runs in this conversation"), t.turns.map((x) => {
        return h("button", { class: "li", onclick: () => { st.runTurn = x.id; st.path[t.id] = x.id; render(); } }, h("span", { class: "sdot " + tone(x.status), style: "margin-top:6px" }), h("div", { class: "grow", style: "min-width:0" }, h("div", { class: "t ell", style: x === u ? "font-weight:600" : "" }, x.title), h("div", { class: "d" }, AG[x.provider].label + " " + x.model + " · " + (x.durationSec ? fdur(x.durationSec) : D.statuses[x.status].label) + " · " + x.activity.length + " steps")));
      })),
    ];
  }
  function outline(items, keyp, hereT, depthN) {
    return items.map((x, i) => {
      var key = keyp + "." + i, has = x.children && x.children.length, closed = st.col[key] === false;
      var rt = x.ref && byT[x.ref.threadId], ru = rt && x.ref.turnId && turn(rt, x.ref.turnId);
      return h("div", null,
        h("div", { class: "oi" + (hereT && x.ref && x.ref.threadId === hereT ? " here" : "") },
          has ? h("button", { class: "tw", "data-ol": key, onclick: () => { st.col[key] = closed; st.col[key] = closed ? true : false; render(); } }, icon(closed ? "right" : "down", "s12")) : h("span", { class: "bul" }),
          h("span", { class: "tx" }, md(x.text), rt ? h("button", { class: "ref", title: rt.title, onclick: () => openThread(rt, ru && ru.id) }, icon("link", "s12"), h("span", null, ru ? ru.title : rt.title)) : null)),
        has && !closed ? h("div", { class: "kids" }, outline(x.children, key, hereT, (depthN || 0) + 1)) : null);
    });
  }
  function notesPane(t) {
    var ns = notesFor(t), out = [];
    var cm = [];
    t.turns.forEach((u) => { u.highlights.filter((x) => { return x.note; }).forEach((x) => { cm.push({ text: x.note, quote: x.quote, at: x.createdAt }); }); });
    M[t.id].comments.forEach((c) => { cm.push(c); });
    out.push(h("div", { class: "sec" }, h("h4", null, "Notes in this conversation", h("span", { class: "n" }, cm.length), h("button", { class: "act", onclick: () => { st.mode = "note"; st.focus = "cmp"; if (V === "c") st.compose = { floating: true, reply: t.id }; render(); } }, "+ Note")),
      cm.length ? cm.map((c) => { return h("div", { class: "hlq amber", style: "background:var(--cmt-bg);border-radius:0 6px 6px 0;padding:6px 8px 6px 9px" }, c.quote ? h("span", { class: "nt", style: "margin:0 0 3px;font-style:italic" }, plain(c.quote)) : null, md(c.text)); }) : h("div", { class: "mut" }, "No notes yet. Press N to write one.")));
    ns.forEach((n) => {
      out.push(h("div", { class: "sec" }, h("h4", null, icon("file", "s12"), h("span", { class: "ell", style: "text-transform:none;letter-spacing:0;font-size:12px;color:var(--tx)" }, n.title), h("button", { class: "act", onclick: () => { st.view = "note:" + n.id; st.note = n.id; render(); } }, "Open")),
        h("div", { class: "ol", style: "font-size:12.5px" }, outline(n.outline, "np-" + n.id, t.id)),
        addItem(n, t)));
    });
    if (!ns.length) out.push(h("div", { class: "sec" }, h("h4", null, "Linked notes"), h("div", { class: "muted", style: "font-size:12.5px;margin-bottom:6px" }, "No note references this conversation."), h("button", { class: "btn sm", onclick: () => { var u = pathFor(t).slice(-1)[0]; addToNote(t, u, t.recap || t.title); } }, icon("plus", "s12"), "Start a note from the recap")));
    return out;
  }
  function addItem(n, t) {
    return h("div", { class: "addi" }, h("input", { "data-fk": "add-" + n.id, placeholder: t ? "Add a finding, linked to this answer" : "Add an item", onkeydown: (e) => {
      if (e.key === "Enter" && e.target.value.trim()) { var u = t && pathFor(t).slice(-1)[0]; n.outline.push({ text: e.target.value.trim(), ref: t ? { threadId: t.id, turnId: u.id } : undefined }); n.updatedAt = nowIso(); e.target.value = ""; st.focus = "add-" + n.id; render(); }
      if (e.key === "Escape") { e.target.blur(); root.focus(); }
    } }));
  }
  function composeCtx() {
    return h("aside", { class: "ctx" }, h("div", { class: "tabs" }, h("span", { class: "tab on" }, "Before you send")),
      h("div", { class: "cscroll" }, h("div", { class: "sec" }, h("h4", null, "Agents"), D.providers.map((p) => {
        var s = FIRST ? st.agents[p.id] : "ready";
        return h("div", { class: "li" }, av(p.id), h("div", { class: "grow" }, h("div", { class: "t" }, p.label), h("div", { class: "d" }, s === "ready" ? "Ready · " + p.models.length + " models" : "Not ready")), s === "ready" ? h("span", { class: "sdot ok", style: "margin-top:6px" }) : h("span", { class: "sdot attention", style: "margin-top:6px" }));
      })),
        h("div", { class: "sec" }, h("h4", null, "Related in Knowledge"), notes.slice(0, 3).map((n) => { return h("div", { class: "li" }, icon("file", "s14"), h("div", { class: "grow" }, h("div", { class: "t" }, n.title), h("div", { class: "d" }, wsName(n.workspaceId)))); }), !notes.length ? h("div", { class: "mut" }, "Nothing filed yet.") : null)));
  }
  function welcomeCtx() {
    var done = (st.agents.claude === "ready" ? 1 : 0) + (st.tut.send ? 1 : 0) + (["j", "k", "e", "h", "c", "/"].every((k) => { return st.tut[k]; }) ? 1 : 0);
    return h("aside", { class: "ctx" }, h("div", { class: "tabs" }, h("span", { class: "tab on" }, "Getting started")),
      h("div", { class: "cscroll" },
        h("div", { class: "sec" }, h("h4", null, "Progress", h("span", { class: "n" }, done + " of 3")), h("div", { class: "prog" }, h("i", { style: "width:" + Math.round(done / 3 * 100) + "%" }))),
        h("div", { class: "sec" }, h("h4", null, "Where things go"),
          h("dl", { class: "gl", style: "margin:0" },
            h("dt", null, "Inbox"), h("dd", null, "Conversations that are open. Running ones are grouped separately."),
            h("dt", null, "Assigned to me"), h("dd", null, "Finished answers, failed runs and agent questions waiting for you."),
            h("dt", null, "Follow-up vs. branch"), h("dd", null, "A follow-up continues the same conversation. A branch forks a new line from an answer or one paragraph, so the original stays unchanged."),
            h("dt", null, "Note"), h("dd", null, "A private comment in the timeline. Never sent to an agent."),
            h("dt", null, "Done"), h("dd", null, "Removes the conversation from Inbox and files it into Knowledge."),
            h("dt", null, "Workspace and folder"), h("dd", null, "A workspace is a directory the agent can read. Folders group conversations inside one workspace."))),
        h("div", { class: "sec" }, h("h4", null, "Shortcuts"), h("button", { class: "btn sm", onclick: () => { st.sheet = true; render(); } }, icon("keyboard", "s12"), "Show all shortcuts", kbd("?")))));
  }

  /* ---- knowledge */
  function topicList() {
    return D.workspaces.map((w) => {
      var fs = D.folders.filter((f) => { return f.workspaceId === w.id; }).map((f) => { return { id: f.id, name: f.name, ws: w.id, ts: threads.filter((t) => { return t.folderId === f.id; }) }; });
      var unf = threads.filter((t) => { return t.workspaceId === w.id && !t.folderId; });
      if (unf.length) fs.push({ id: "unf:" + w.id, name: "Unfiled", ws: w.id, ts: unf });
      return { w: w, fs: fs };
    });
  }
  function topicById(id) { var r = null; topicList().forEach((g) => { g.fs.forEach((f) => { if (f.id === id) r = f; }); }); return r; }
  function topicsCol() {
    var tl = topicList(), rows = [];
    tl.forEach((g) => {
      rows.push(h("div", { class: "lgrp" }, icon("layers", "s12"), g.w.name, h("span", { class: "n" }, g.w.dir)));
      g.fs.forEach((f) => {
        var dn = f.ts.filter((t) => { return M[t.id].box === "done"; }).length, nn = notes.filter((n) => { return refsIn(n.outline).some((r) => { return f.ts.some((t) => { return t.id === r.threadId; }); }); }).length;
        rows.push(h("button", { class: "topic" + (st.view === "knowledge" && st.topic === f.id ? " sel" : ""), "data-topic": f.id, onclick: () => { st.view = "knowledge"; st.topic = f.id; render(); } },
          icon("folder", "s14"), h("span", { class: "grow ell" }, f.name), h("span", { class: "d" }, f.ts.length + " conv" + (dn ? " · " + dn + " done" : "") + (nn ? " · " + nn + " note" + (nn > 1 ? "s" : "") : ""))));
      });
    });
    rows.push(h("div", { class: "lgrp" }, icon("file", "s12"), "Notes", h("span", { class: "n" }, notes.length)));
    notes.forEach((n) => { rows.push(h("button", { class: "topic" + (st.view === "note:" + n.id ? " sel" : ""), "data-note": n.id, onclick: () => { st.view = "note:" + n.id; st.note = n.id; render(); } }, icon("file", "s14"), h("span", { class: "grow ell" }, n.title), h("span", { class: "d" }, ftime(n.updatedAt)))); });
    var empty = !threads.length && !notes.length;
    return h("section", { class: "list", style: V === "b" ? "width:300px" : "" },
      h("div", { class: "lh" }, h("h2", null, "Knowledge"), h("span", { class: "grow" }), h("button", { class: "btn sm", onclick: () => { var n = { id: "nn" + (seq++), workspaceId: "ws-compilers", title: "Untitled note", updatedAt: nowIso(), tags: [], outline: [] }; notes.unshift(n); st.view = "note:" + n.id; st.note = n.id; st.focus = "add-" + n.id; render(); } }, icon("plus", "s14"), "Note")),
      empty ? h("div", { class: "empty" }, h("div", { class: "big", style: "background:var(--acc-bg);color:var(--acc)" }, icon("book")), h("h3", null, "Nothing filed yet"), h("p", null, "Mark a finished conversation done with E and it is filed here by folder, with its recap, highlights and notes.")) :
        h("div", { class: "lscroll", "data-sk": "topics" }, rows));
  }
  function knowPage() {
    if (st.view.indexOf("note:") === 0) return notePage();
    var f = topicById(st.topic);
    if (!f) return h("section", { class: "conv" }, h("div", { class: "empty" }, h("h3", null, "Choose a folder"), h("p", null, "Each folder collects its conversations, the notes that reference them, and highlights.")));
    var ns = notes.filter((n) => { return refsIn(n.outline).some((r) => { return f.ts.some((t) => { return t.id === r.threadId; }); }); });
    var hls = []; f.ts.forEach((t) => { t.turns.forEach((u) => { u.highlights.forEach((x) => { hls.push({ x: x, t: t, u: u }); }); }); });
    var done = f.ts.filter((t) => { return M[t.id].box === "done"; }).length;
    var open = (t) => openThread(t);
    return h("section", { class: "conv" }, h("div", { class: "kpage", "data-sk": "kpage" }, h("div", { class: "kpage-in" },
      h("h1", null, icon("folder", "s18"), f.name),
      h("div", { class: "meta" }, h("span", null, wsName(f.ws)), h("span", null, "· " + pl(f.ts.length, "conversation") + ", " + done + " done"), h("span", null, "· " + pl(ns.length, "note")), h("span", null, "· " + pl(hls.length, "highlight"))),
      h("h3", null, icon("list", "s12"), "Key findings"),
      f.ts.filter((t) => { return t.recap; }).length ? h("div", { class: "nbox ol" }, outline(f.ts.filter((t) => { return t.recap; }).map((t) => {
        var ch = [{ text: t.recap }];
        t.turns.forEach((u) => {
          if (u.relation !== "root" && u.answer.length && u.status !== "running") ch.push({ text: (u.relation === "branch" ? "Branch: " : "Follow-up: ") + u.title + ". " + firstSentence(u.answer[0], 140), ref: { threadId: t.id, turnId: u.id } });
          u.highlights.filter((x) => { return x.note; }).forEach((x) => { ch.push({ text: "Note: " + x.note + " (on \u201c" + plain(x.quote) + "\u201d)", ref: { threadId: t.id, turnId: u.id } }); });
        });
        return { text: t.title, ref: { threadId: t.id }, children: ch };
      }), "kf-" + f.id)) : h("div", { class: "muted" }, "No recaps yet."),
      ns.length ? [h("h3", null, icon("file", "s12"), "Notes that reference this folder"), ns.map((n) => { return h("div", { class: "nbox" }, h("button", { class: "nt", onclick: () => { st.view = "note:" + n.id; st.note = n.id; render(); } }, icon("file", "s14"), n.title, h("span", { class: "muted", style: "font-weight:400;font-size:12px" }, "· " + ftime(n.updatedAt))), h("div", { class: "ol" }, outline(n.outline, "kn-" + n.id))); })] : null,
      h("h3", null, icon("inbox", "s12"), "Conversations"),
      f.ts.sort(sortT).map((t) => {
        return h("button", { class: "kcard", "data-kc": t.id, onclick: () => { open(t); } }, h("div", { class: "t" }, av(t.provider), h("span", { class: "grow ell" }, t.title), M[t.id].box === "done" ? h("span", { class: "pill ok" }, icon("check", "s12"), "Done") : statusPill(t) || h("span", { class: "pill plain" }, "In Inbox")),
          t.recap ? h("div", { class: "r" }, t.recap) : null,
          h("div", { class: "m" }, t.tags.map((g) => { return tagChip(g); }), h("span", null, t.turns.length + " questions · " + ftime(t.updatedAt))));
      }),
      hls.length ? [h("h3", null, icon("highlight", "s12"), "Highlights"), hls.map((o) => { return h("button", { class: "hlq " + o.x.color, style: "text-align:left", onclick: () => { st.path[o.t.id] = o.u.id; open(o.t); } }, md(o.x.quote), h("span", { class: "nt" }, (o.x.note ? o.x.note + " · " : "") + o.u.title)); })] : null)));
  }
  function notePage() {
    var n = notes.filter((x) => { return x.id === st.note; })[0];
    if (!n) return h("section", { class: "conv" });
    return h("section", { class: "conv" }, h("div", { class: "kpage", "data-sk": "kpage" }, h("div", { class: "kpage-in" },
      h("h1", null, icon("file", "s18"), n.title),
      h("div", { class: "meta" }, h("span", null, wsName(n.workspaceId)), h("span", null, "· updated " + ftime(n.updatedAt)), n.tags.map((g) => { return tagChip(g); })),
      h("div", { class: "nbox ol", style: "padding:12px 14px 12px 8px;font-size:13.5px" }, outline(n.outline, "nb-" + n.id), addItem(n, null)),
      h("div", { class: "muted", style: "font-size:12px;margin-top:6px" }, "Click ▸ to collapse an item. Linked items open the answer they came from; the conversation shows this note in its Notes tab."))));
  }
  function knowCtx() {
    var out = [];
    if (st.view.indexOf("note:") === 0) {
      var n = notes.filter((x) => { return x.id === st.note; })[0];
      var ids = {}; if (n) refsIn(n.outline).forEach((r) => { ids[r.threadId] = 1; });
      var ts = Object.keys(ids).map((id) => { return byT[id]; }).filter(Boolean);
      out.push(h("div", { class: "sec" }, h("h4", null, "Linked conversations", h("span", { class: "n" }, ts.length)), ts.map((t) => { return h("button", { class: "li", onclick: () => openThread(t) }, h("span", { class: "av sm " + t.provider, style: "margin-top:1px" }, AG[t.provider].short), h("div", { class: "grow" }, h("div", { class: "t" }, t.title), h("div", { class: "d" }, (statusPill(t) ? D.statuses[t.status].label : "Answered") + " · " + folderName(t.folderId)))); })));
      var others = notes.filter((x) => { return x !== n && refsIn(x.outline).some((r) => { return ids[r.threadId]; }); });
      out.push(h("div", { class: "sec" }, h("h4", null, "Backlinks", h("span", { class: "n" }, others.length)), others.length ? others.map((x) => { return h("button", { class: "li", onclick: () => { st.note = x.id; st.view = "note:" + x.id; render(); } }, icon("file", "s14"), h("div", { class: "grow" }, h("div", { class: "t" }, x.title), h("div", { class: "d" }, "Shares linked conversations"))); }) : h("div", { class: "mut" }, "No other note references the same conversations.")));
    } else {
      var f = topicById(st.topic);
      if (f) {
        var inT = {}; f.ts.forEach((t) => { inT[t.id] = 1; });
        var bl = threads.filter((t) => { return !inT[t.id] && t.links.some((l) => { return inT[l]; }); });
        var srcs = [], seen = {}; f.ts.forEach((t) => { t.turns.forEach((u) => { u.sources.forEach((s) => { if (!seen[s.url]) { seen[s.url] = 1; srcs.push(s); } }); }); });
        var rel = {}; bl.forEach((t) => { if (t.folderId) rel[t.folderId] = (rel[t.folderId] || 0) + 1; });
        out.push(h("div", { class: "sec" }, h("h4", null, "Backlinks", h("span", { class: "n" }, bl.length)), bl.length ? bl.map((t) => { return h("button", { class: "li", onclick: () => openThread(t) }, h("span", { class: "av sm " + t.provider, style: "margin-top:1px" }, AG[t.provider].short), h("div", { class: "grow" }, h("div", { class: "t" }, t.title), h("div", { class: "d" }, "From " + folderName(t.folderId)))); }) : h("div", { class: "mut" }, "No conversations outside this folder link here.")));
        out.push(h("div", { class: "sec" }, h("h4", null, "Related folders"), Object.keys(rel).length ? Object.keys(rel).map((fid) => { return h("button", { class: "li", onclick: () => { st.topic = fid; render(); } }, icon("folder", "s14"), h("div", { class: "grow" }, h("div", { class: "t" }, folderName(fid)), h("div", { class: "d" }, rel[fid] + " linking conversation" + (rel[fid] > 1 ? "s" : "")))); }) : h("div", { class: "mut" }, "None.")));
        out.push(h("div", { class: "sec" }, h("h4", null, "Sources", h("span", { class: "n" }, srcs.length)), srcs.map((s) => { return h("div", { class: "li" }, h("span", { class: "fav" }, s.domain[0]), h("div", { class: "grow", style: "min-width:0" }, h("div", { class: "t" }, s.title), h("div", { class: "d" }, s.domain))); })));
      }
    }
    return h("aside", { class: "ctx" }, h("div", { class: "tabs" }, h("span", { class: "tab on" }, "Links")), h("div", { class: "cscroll", "data-sk": "kctx" }, out));
  }

  /* ---- overlays */
  function overlays() {
    var out = [];
    out.push(floatCompose());
    if (st.menu) out.push(menuEl());
    if (st.toast) out.push(h("div", { class: "toast" }, h("span", null, st.toast.text), st.undo ? h("button", { onclick: doUndo }, "Undo", kbd("Z")) : null));
    if (st.sheet) out.push(h("div", { class: "scrim", onclick: () => { st.sheet = false; render(); } }, h("div", { class: "sheet", onclick: (e) => { e.stopPropagation(); } },
      h("h3", null, "Keyboard shortcuts", h("span", { class: "grow" }), h("button", { class: "ibtn", onclick: () => { st.sheet = false; render(); } }, icon("x"))),
      h("div", { class: "kgrid" }, [["Next / previous conversation", "J", "K"], ["Open (split inbox)", "↵"], ["Mark done, file into Knowledge", "E"], ["Snooze", "H"], ["Tag", "#"], ["Move to folder", "M"], ["Assign agent", "A"], ["Select for bulk action", "X"], ["New question", "C"], ["Reply (follow-up)", "R"], ["Branch", "B"], ["Private note", "N"], ["Search", "/"], ["Undo", "Z"], ["Send", "↵"], ["Send and mark done", "⌘↵"], ["Back / close", "Esc"], ["This sheet", "?"]].map((r) => { return h("div", null, h("span", null, r[0]), r.slice(1).map(kbd)); })))));
    return out;
  }
  function menuEl() {
    var m = st.menu, items = [];
    var mi = (ic, label, r, fn, act) => { return h("button", { class: "mi" + (act ? " act" : ""), onclick: (e) => { e.stopPropagation(); fn(); } }, ic ? (typeof ic === "string" ? icon(ic, "s14") : ic) : h("span", { class: "ic s14" }), h("span", { class: "grow ell" }, label), r ? h("span", { class: "r" }, r) : null); };
    if (m.kind === "snooze") {
      var t0 = byT[m.ids[0]];
      items.push(h("div", { class: "mt" }, "Snooze until"));
      [["Later today", "18:00"], ["Tomorrow", "09:00"], ["Monday", "09:00"], ["Next week", "Oct 19"]].forEach((o) => { items.push(mi("clock", o[0], o[1], () => { snooze(m.ids, o[0] === "Later today" ? "18:00" : o[0] + " " + o[1].replace("Oct 19", "")); })); });
      items.push(h("div", { class: "msep" }));
      items.push(mi("activity", "When the run finishes", t0 && isActive(t0) ? "" : "not running", () => { if (t0 && isActive(t0)) snooze(m.ids, "the run finishes"); }));
    } else if (m.kind === "tag") {
      var ids = m.ids, tags = allTags().map((g) => { return g.tag; });
      items.push(h("input", { "data-fk": "menu-f", placeholder: "Filter or create tag", value: m.f, oninput: (e) => { m.f = e.target.value; render(); }, onkeydown: (e) => { if (e.key === "Enter" && m.f.trim()) { toggleTag(ids, m.f.trim().replace(/^#/, "")); m.f = ""; } if (e.key === "Escape") { st.menu = null; render(); } }, onclick: (e) => { e.stopPropagation(); } }));
      tags.filter((g) => { return !m.f || g.indexOf(m.f) >= 0; }).slice(0, 12).forEach((g) => {
        var on = ids.length && ids.every((id) => { return byT[id].tags.indexOf(g) >= 0; });
        items.push(mi(h("span", { class: "chk" + (on ? " on" : ""), style: "opacity:1" }, on ? icon("check") : null), g, null, () => { toggleTag(ids, g); }));
      });
      if (m.f && tags.indexOf(m.f) < 0) items.push(mi("plus", "Create “" + m.f + "”", "↵", () => { toggleTag(ids, m.f); m.f = ""; }));
    } else if (m.kind === "move") {
      D.workspaces.forEach((w) => {
        items.push(h("div", { class: "mt" }, w.name));
        D.folders.filter((f) => { return f.workspaceId === w.id; }).concat([{ id: null, name: "Unfiled" }]).forEach((f) => {
          items.push(mi("folder", f.name, null, () => {
            if (m.compose) { st.compose.ws = w.id; st.compose.folder = f.id; st.menu = null; render(); }
            else moveTo(m.ids, w.id, f.id);
          }));
        });
      });
    } else if (m.kind === "assign") {
      var t = m.ids && byT[m.ids[0]];
      items.push(h("div", { class: "mt" }, m.compose || m.welcome ? "Send to" : "Next question goes to"));
      D.providers.forEach((p) => {
        var ready = !FIRST || st.agents[p.id] === "ready";
        p.models.slice(0, p.id === "codex" ? 3 : 3).forEach((mo, k) => {
          items.push(mi(k === 0 ? av(p.id) : null, (k === 0 ? p.label + " · " : "") + mo, !ready ? "set up first" : t && p.id !== t.provider && k === 0 ? "as branch" : "", () => {
            if (!ready) return;
            var pick = { provider: p.id, model: mo, effort: p.efforts.length ? "high" : null };
            if (m.compose) Object.assign(st.compose, pick);
            else if (m.welcome) st.wpk = p.id;
            else if (t) { st.pick[t.id] = pick; if (p.id !== t.provider) { st.mode = "branch"; st.anchor = null; } st.focus = "cmp"; }
            st.menu = null; render();
          }));
        });
      });
      items.push(h("div", { class: "mnote" }, "Follow-ups keep the agent and model of the conversation. Choosing a different agent sends the question as a branch, so you can compare answers."));
    }
    var x = Math.min(m.x, 1280 - 310), y = Math.min(m.y, 800 - 300);
    return h("div", { class: "menu", style: "left:" + x + "px;top:" + y + "px", onclick: (e) => { e.stopPropagation(); } }, items);
  }

  /* ---- keyboard */
  function onKey(e) {
    var tg = e.target, typing = tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA");
    if (typing) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key;
    if (FIRST || st.sel === "welcome") { if ("jkehc/".indexOf(k) >= 0 && k.length === 1) st.tut[k] = true; if (k === "#") st.tut["#"] = true; }
    if (k === "Escape") {
      if (st.menu) st.menu = null; else if (st.sheet) st.sheet = false; else if (st.compose) st.compose = null; else if (st.checked.length) st.checked = []; else if (st.open) st.open = false; else if (st.view === "search") { st.q = ""; st.view = st.prevView || "inbox"; }
      render(); return;
    }
    if (st.menu || st.sheet) { if (k === "?") { st.sheet = false; render(); } return; }
    var know = st.view === "knowledge" || st.view.indexOf("note:") === 0;
    var handled = true;
    if (k === "j" || k === "ArrowDown") { if (!know) move(1); else handled = false; }
    else if (k === "k" || k === "ArrowUp") { if (!know) move(-1); else handled = false; }
    else if (k === "e") { if (st.sel === "welcome") { st.tut.e = true; render(); } else markDone(); }
    else if (k === "Enter" || k === "o") { if (V === "b" && st.sel && byT[st.sel]) { st.open = true; render(); } else handled = false; }
    else if (k === "h") { if (targets().length) keyMenu("snooze"); else render(); }
    else if (k === "#") { if (targets().length) keyMenu("tag"); }
    else if (k === "m") { if (targets().length) keyMenu("move"); }
    else if (k === "a") { if (targets().length) keyMenu("assign"); }
    else if (k === "x") { if (byT[st.sel]) toggleCheck(st.sel); }
    else if (k === "c") { newCompose(); }
    else if (k === "/") { var s = root.querySelector('[data-fk="search"]'); if (s) s.focus(); render(); s = root.querySelector('[data-fk="search"]'); if (s) s.focus(); }
    else if (k === "r" || k === "b" || k === "n") { if (byT[st.sel]) { st.mode = k === "r" ? "followup" : k === "b" ? "branch" : "note"; if (k !== "n") st.anchor = null; if (V === "c") st.compose = { floating: true, reply: st.sel }; if (V === "b") st.open = true; st.focus = "cmp"; render(); } else handled = false; }
    else if (k === "z") { doUndo(); }
    else if (k === "?") { st.sheet = true; render(); }
    else handled = false;
    if (handled) e.preventDefault();
    if (FIRST || st.sel === "welcome") render();
  }
  function onDocClick() { if (st.menu) { st.menu = null; render(); } }

  /* ---- go */
  root.tabIndex = 0;
  root.addEventListener("keydown", onKey);
  root.addEventListener("click", onDocClick);
  // live elapsed counters for running answers
  intervals.push(setInterval(() => {
    root.querySelectorAll("[data-el]").forEach((e) => {
      var v = e.getAttribute("data-el");
      var s = v[0] === "s" ? (Date.now() - Number(v.slice(1))) / 1000 : Number(v.slice(1)) + (Date.now() - T0) / 1000;
      e.textContent = fdur(s);
    });
  }, 1000));
  render();
  try { root.focus({ preventScroll: true }); } catch (err) { /* ignore */ }

  return function cleanup() {
    root.removeEventListener("keydown", onKey);
    root.removeEventListener("click", onDocClick);
    timers.forEach(clearTimeout); intervals.forEach(clearInterval);
    clearTimeout(toastTimer);
    root.replaceChildren();
  };
}

window.SessionMocks.register({
  id: "front", round: 1,
  name: "Research Inbox",
  reference: "Front",
  summary: "Session as a triage inbox: every research run is a conversation that lands in Inbox when it finishes, fails or needs a decision. You reply, branch, annotate with private notes, then press E to mark it done, which files it into a Knowledge view organized by folder with notes, highlights and backlinks.",
  principles: [
    "Inbox is attention: open conversations grouped as Needs you, Running and queued, and Open. 'Assigned to me' lists finished answers, failed runs and agent questions until you mark them done (fixes the missing attention inbox).",
    "Agents are teammates. The assignee chip names the agent and model on every conversation and message; choosing another agent sends the question as a branch so answers can be compared.",
    "One conversation reads top to bottom as a timeline: question, answer, private notes (yellow, never sent), and branch events that open the forked line in place. A conversation map in the context pane shows the whole tree.",
    "Composer is a reply box with explicit modes: Follow-up, Branch, Note. Send and Send & Done, like Send and archive.",
    "Keyboard triage with visible hints: J/K, E done, H snooze (including 'when the run finishes'), # tag, M move, X select, C new question, / search, Z undo, ? sheet.",
    "Right context pane, like a CRM sidebar: Details (agent, folder, conversation map, sources, linked conversations, highlights, notes that cite it), Run (trace and timing), Notes (outline notes with an add-finding box).",
    "Renames: 'Archive' becomes Done; 'Star', 'Follow' and Post are dropped from this surface; Bookmark stays as a saved view. Workspaces and folders keep their names; Knowledge groups by folder.",
  ],
  chat: "Ask with C (or the welcome composer); the run sits in Inbox under Running with a live step line and elapsed time, then returns as unread in Assigned to me. Reply in the bottom composer to ask a follow-up; while an answer runs, the follow-up is queued and labeled so. Branch from a whole answer or one paragraph; the fork appears as a linked row in the timeline and opens with a banner back to the main line.",
  knowledge: "Done files a conversation into Knowledge, a view of folders per workspace. Each folder page has Key findings (an outline built from recaps), the notes that cite its conversations, the conversation cards, and highlights; the right pane lists backlinks, related folders and sources. Notes are outlines whose items link to the exact answer they came from, and each conversation shows the notes that cite it.",
  firstRun: "The inbox contains one Welcome conversation from Session: what the inbox is, an agent setup card that detects sign-in by itself, example questions, and a keyboard checklist that ticks as keys are pressed. The composer at the bottom asks the first question; a button opens a sample workspace instead.",
  variants: [
    { id: "a", name: "Three-pane triage", note: "Classic Front layout: nav, status-grouped list, conversation with bottom composer, Details context pane." },
    { id: "b", name: "Split inbox, full screen", note: "Superhuman-style: no sidebar, split tabs over a single-line list; Enter opens the conversation full width with the Run trace beside it; J/K move between conversations." },
    { id: "c", name: "Workspace inboxes", note: "Workspaces act as shared inboxes in the nav with folder counts; list grouped by workspace; replies, branches and notes compose in a floating window." },
    { id: "d", name: "Knowledge desk", note: "Opens on Knowledge; Notes is the default context tab and answers offer 'Add to note', so triage feeds an outline directly." },
    { id: "e", name: "First run", note: "Empty install: inbox holds a Welcome conversation with agent setup, example questions and a keyboard checklist." },
  ],
  fonts: "family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500",
  css: css.replace(/FXC;/g, "display:flex;align-items:center;").replace(/IFC;/g, "display:inline-flex;align-items:center;").replace(/UPC;/g, "text-transform:uppercase;letter-spacing:.03em;").replace(/BL1;/g, "border:1px solid var(--line);").replace(/&/g, "." + SCOPE),
  mount: mount,
});
})();
