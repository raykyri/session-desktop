/* Session redesign candidate "notion", round 1.
* Reference: Notion. Threads are pages in a per-workspace "Research" database;
* the conversation is a sequence of blocks; branches are toggles or sub-pages;
* chatting is an inline AI block or a page-bound AI panel.
* Plain browser JS, no imports. Registers with window.SessionMocks. */
(function () {
 "use strict";
 var S = "m-notion-r2";

 /* ------------------------------------------------------------------ CSS */
 var css = `
&{--font:-apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI",Inter,Helvetica,Arial,sans-serif;--serif:"Lyon-Text","Source Serif 4",Georgia,serif;--mono:"SFMono-Regular",Menlo,Consolas,"Liberation Mono",monospace;
--bg:#fff;--side:#f8f8f7;--text:#37352f;--text2:rgba(55,53,47,.65);--text3:rgba(55,53,47,.46);--line:rgba(55,53,47,.09);--line2:rgba(55,53,47,.16);--hover:rgba(55,53,47,.06);--hover2:rgba(55,53,47,.1);
--blue:#2383e2;--blueh:#0077d4;--bluebg:rgba(35,131,226,.08);--sel:rgba(35,131,226,.14);--menu:#fff;--callout:#f1f1ef;--qbg:#f7f6f3;--codebg:rgba(135,131,120,.15);--codetx:#eb5757;--shadow:rgba(15,15,15,.05) 0 0 0 1px,rgba(15,15,15,.1) 0 3px 6px,rgba(15,15,15,.2) 0 9px 24px;--shadow2:rgba(15,15,15,.04) 0 0 0 1px,rgba(15,15,15,.03) 0 3px 6px,rgba(15,15,15,.06) 0 9px 24px;--card:#fff;--cardline:rgba(55,53,47,.09);--toast:#2f2f2f;
--gray-bg:rgb(227,226,224);--brown-bg:rgb(238,224,218);--orange-bg:rgb(250,222,201);--yellow-bg:rgb(253,236,200);--green-bg:rgb(219,237,219);--blue-bg:rgb(211,229,239);--purple-bg:rgb(232,222,238);--pink-bg:rgb(245,224,233);--red-bg:rgb(255,226,221);--tagtx:rgb(50,48,44);
--gray:rgb(120,119,116);--brown:rgb(159,107,83);--orange:rgb(217,115,13);--yellow:rgb(203,145,47);--green:rgb(68,131,97);--blue2:rgb(51,126,169);--purple:rgb(144,101,176);--pink:rgb(193,76,138);--red:rgb(212,76,71);
--colmix:30%;--hl-amber:rgb(251,243,219);--hl-green:rgb(237,243,236);--hl-blue:rgb(231,243,248);--hl-pink:rgb(250,241,245);--anchor:rgba(35,131,226,.45);
position:absolute;inset:0;display:flex;overflow:hidden;font-family:var(--font);font-size:14px;line-height:1.5;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased;outline:none}
&[data-theme="dark"]{--bg:#191919;--side:#202020;--text:rgba(255,255,255,.81);--text2:rgba(255,255,255,.52);--text3:rgba(255,255,255,.34);--line:rgba(255,255,255,.094);--line2:rgba(255,255,255,.15);--hover:rgba(255,255,255,.055);--hover2:rgba(255,255,255,.09);
--blue:#2383e2;--blueh:#3a91e8;--bluebg:rgba(35,131,226,.14);--sel:rgba(35,131,226,.28);--menu:#252525;--callout:#252525;--qbg:#222;--codebg:rgba(135,131,120,.2);--codetx:#ff7369;--shadow:rgba(15,15,15,.1) 0 0 0 1px,rgba(15,15,15,.2) 0 3px 6px,rgba(15,15,15,.4) 0 9px 24px;--shadow2:rgba(255,255,255,.07) 0 0 0 1px,rgba(0,0,0,.2) 0 3px 8px;--card:#202020;--cardline:rgba(255,255,255,.08);--toast:#3a3a3a;
--gray-bg:rgb(90,90,90);--brown-bg:rgb(96,59,44);--orange-bg:rgb(133,76,29);--yellow-bg:rgb(137,99,42);--green-bg:rgb(43,89,63);--blue-bg:rgb(40,69,108);--purple-bg:rgb(73,47,100);--pink-bg:rgb(105,49,76);--red-bg:rgb(110,54,48);--tagtx:rgba(255,255,255,.86);
--gray:rgb(155,155,155);--brown:rgb(186,133,111);--orange:rgb(199,125,72);--yellow:rgb(202,152,73);--green:rgb(82,158,114);--blue2:rgb(94,135,201);--purple:rgb(157,104,211);--pink:rgb(209,87,150);--red:rgb(223,84,82);
--colmix:14%;--hl-amber:rgba(202,152,73,.24);--hl-green:rgba(82,158,114,.24);--hl-blue:rgba(94,135,201,.26);--hl-pink:rgba(209,87,150,.24);--anchor:rgba(94,155,230,.6)}
& *{scrollbar-width:thin;scrollbar-color:var(--line2) transparent}
& button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;text-align:left}
& svg{display:block;flex:none}
& .ic{display:inline-flex;align-items:center;justify-content:center;flex:none}
& .app{position:absolute;inset:0;display:flex}
/* sidebar */
& .side{width:240px;flex:none;background:var(--side);border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0;color:var(--text2);font-size:14px;position:relative}
& .side.hidden{width:0;border:0;overflow:hidden}
& .lights{height:38px;display:flex;align-items:center;gap:8px;padding:0 14px;flex:none}
& .lights i{width:12px;height:12px;border-radius:50%;background:#ff5f57;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.15)}
& .lights i:nth-child(2){background:#febc2e}& .lights i:nth-child(3){background:#28c840}
& .lights .sp{flex:1}
& .wsw{display:flex;align-items:center;gap:8px;height:32px;margin:0 8px 2px;padding:0 6px;border-radius:6px;color:var(--text);font-weight:500;cursor:pointer}
& .wsw:hover{background:var(--hover)}
& .wsw .wav{width:22px;height:22px;border-radius:5px;background:var(--text);color:var(--bg);font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center}
& .wsw .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14px}
& .sbtn{width:26px;height:26px;border-radius:5px;display:flex;align-items:center;justify-content:center;color:var(--text2)}
& .sbtn:hover{background:var(--hover2)}
& .sscroll{flex:1;overflow-y:auto;overflow-x:hidden;padding:0 8px 12px}
& .srow{display:flex;align-items:center;gap:6px;height:30px;padding:0 6px 0 calc(6px + var(--d,0)*14px);border-radius:6px;cursor:pointer;white-space:nowrap;position:relative;user-select:none}
& .srow:hover{background:var(--hover)}
& .srow.on{background:var(--hover2);color:var(--text);font-weight:500}
& .srow .lb{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
& .srow .cnt{font-size:12px;color:var(--text3)}
& .srow .badge{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#eb5757;color:#fff;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center}
& .srow .tw{width:20px;height:20px;border-radius:4px;display:flex;align-items:center;justify-content:center;color:var(--text3);flex:none}
& .srow .tw:hover{background:var(--hover2)}
& .srow .ac{display:none;gap:2px}
& .srow:hover .ac{display:flex}
& .srow .ac .sbtn{width:22px;height:22px}
& .shead{display:flex;align-items:center;height:30px;padding:0 6px;margin-top:14px;font-size:12px;font-weight:500;color:var(--text3);border-radius:6px}
& .shead:hover{background:var(--hover)}
& .shead .sp{flex:1}
& .sfoot{border-top:1px solid var(--line);padding:6px 8px 8px;flex:none}
& .empty-s{padding:2px 6px 2px 40px;font-size:13px;color:var(--text3);height:26px;line-height:26px}
/* main */
& .main{flex:1;min-width:0;display:flex;flex-direction:column;position:relative;background:var(--bg)}
& .top{height:45px;flex:none;display:flex;align-items:center;padding:0 12px 0 10px;gap:2px;position:relative;z-index:3;background:var(--bg)}
& .tbtn{height:28px;min-width:28px;padding:0 6px;border-radius:6px;display:flex;align-items:center;justify-content:center;gap:5px;color:var(--text2);font-size:14px;white-space:nowrap}
& .tbtn:hover{background:var(--hover)}
& .tbtn.on{background:var(--hover2);color:var(--text)}
& .tbtn.txt{color:var(--text)}
& .tbtn[disabled]{opacity:.35;cursor:default;background:none}
& .crumbs{display:flex;align-items:center;min-width:0;flex:1;gap:1px;margin-left:4px}
& .crumb{display:flex;align-items:center;gap:6px;height:26px;padding:0 6px;border-radius:5px;color:var(--text);white-space:nowrap;min-width:0;max-width:280px;font-size:14px}
& .crumb span{overflow:hidden;text-overflow:ellipsis}
& .crumb:hover{background:var(--hover)}
& .crumbsep{color:var(--text3);padding:0 1px}
& .edited{color:var(--text3);font-size:14px;margin-right:6px;white-space:nowrap}
& .body{flex:1;min-height:0;display:flex;position:relative}
& .scroll{flex:1;min-width:0;overflow-y:auto;overflow-x:hidden;position:relative}
/* page */
& .page{--pw:708px;--pf:16px;max-width:calc(var(--pw) + 192px);margin:0 auto;padding:0 96px 140px;font-size:var(--pf);position:relative}
& .page.wide{--pw:100%;max-width:none}
& .page.small{--pf:14px}
& .page.serif .ptitle,& .page.serif .blocks,& .page.serif .qtext{font-family:var(--serif)}
& .cover{height:200px;position:relative}
& .cover.g2{background:radial-gradient(circle at 20% 30%,#f6d6c9 0,transparent 45%),radial-gradient(circle at 80% 70%,#c9dcf6 0,transparent 50%),linear-gradient(135deg,#f3eee6,#e3ecf4)}
&[data-theme="dark"] .cover.g2{background:radial-gradient(circle at 20% 30%,#5a3a30 0,transparent 45%),radial-gradient(circle at 80% 70%,#2b4466 0,transparent 50%),linear-gradient(135deg,#2a2622,#1f262e)}
& .picon{width:78px;height:78px;border-radius:8px;display:flex;align-items:center;justify-content:center;margin-top:76px;position:relative}
& .hascover>.picon{margin-top:-40px}
& .pplain{height:56px}
& .ptitle{font-size:40px;line-height:1.2;font-weight:700;margin:6px 0 4px;color:var(--text);letter-spacing:-.01em;outline:none;word-wrap:break-word}
& .page.small .ptitle{font-size:32px}
& .lead{color:var(--text2);margin:2px 0 10px;font-size:15px}
& .pmeta{display:flex;gap:4px;margin:6px 0 4px;flex-wrap:wrap}
& .pmeta .tbtn{font-size:14px;color:var(--text3);padding:0 6px;margin-left:-6px}
/* properties */
& .props{margin:8px 0 6px;font-size:14px}
& .prow{display:flex;align-items:flex-start;min-height:34px}
& .pk{width:164px;flex:none;display:flex;align-items:center;gap:6px;height:34px;padding:0 6px;color:var(--text2);border-radius:5px;margin-left:-6px}
& .pk:hover{background:var(--hover)}
& .pv{flex:1;min-width:0;display:flex;flex-wrap:wrap;align-items:center;gap:5px;min-height:34px;padding:4px 8px;border-radius:5px;color:var(--text)}
& .pv:hover{background:var(--hover)}
& .pv .muted{color:var(--text3)}
& .addprop{color:var(--text3);font-size:14px;height:30px;display:flex;align-items:center;gap:6px;padding:0 6px;margin-left:-6px;border-radius:5px;width:max-content}
& .addprop:hover{background:var(--hover)}
& .hr{height:1px;background:var(--line);margin:10px 0}
/* tags & pills */
& .tag{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:3px;font-size:12.5px;line-height:20px;white-space:nowrap;color:var(--tagtx);background:var(--gray-bg);max-width:100%;overflow:hidden;text-overflow:ellipsis}
& .st{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px 0 7px;border-radius:10px;font-size:12.5px;white-space:nowrap;color:var(--tagtx);background:var(--gray-bg)}
& .st i{width:8px;height:8px;border-radius:50%;background:var(--gray);flex:none}
& .c-gray{background:var(--gray-bg)}& .c-brown{background:var(--brown-bg)}& .c-orange{background:var(--orange-bg)}& .c-yellow{background:var(--yellow-bg)}& .c-green{background:var(--green-bg)}& .c-blue{background:var(--blue-bg)}& .c-purple{background:var(--purple-bg)}& .c-pink{background:var(--pink-bg)}& .c-red{background:var(--red-bg)}
& .c-gray i{background:var(--gray)}& .c-orange i{background:var(--orange)}& .c-yellow i{background:var(--yellow)}& .c-green i{background:var(--green)}& .c-blue i{background:var(--blue2)}& .c-red i{background:var(--red)}& .c-purple i{background:var(--purple)}
& .st.run i{animation:${S}-pulse 1.2s ease-in-out infinite}
@keyframes ${S}-pulse{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes ${S}-spin{to{transform:rotate(360deg)}}
@keyframes ${S}-shimmer{0%{background-position:-200px 0}100%{background-position:200px 0}}
@keyframes ${S}-blink{50%{opacity:0}}
& .mention{display:inline;color:var(--text);cursor:pointer;border-radius:3px;padding:0 2px;white-space:normal}
& .mention:hover{background:var(--hover)}
& .mention .mni{display:inline-block;vertical-align:-2px;margin-right:3px;opacity:.85}
& .mention u{text-decoration:underline;text-decoration-color:var(--line2);text-decoration-thickness:1px;text-underline-offset:3px;font-weight:500}
& .mention>.ic{display:inline-flex;vertical-align:-2px;margin-right:3px}
/* blocks */
& .blocks{position:relative;margin-top:6px}
& .blk{position:relative;padding:3px 2px;margin:1px 0;border-radius:3px;line-height:1.5}
& .hdl{position:absolute;left:-50px;top:3px;display:flex;gap:1px;opacity:0;transition:opacity .12s}
& .blk:hover>.hdl{opacity:1}
& .hdl button{width:24px;height:24px;border-radius:4px;display:flex;align-items:center;justify-content:center;color:var(--text3)}
& .hdl button:hover{background:var(--hover2)}
& .blk p,& .p{margin:0;white-space:pre-wrap;word-wrap:break-word}
& code{font-family:var(--mono);font-size:85%;background:var(--codebg);color:var(--codetx);padding:.15em .35em;border-radius:4px}
& .blk a,& .lnk{color:inherit;text-decoration:underline;text-decoration-color:var(--line2);text-underline-offset:2px}
& .hl{border-radius:2px;padding:1px 0;cursor:pointer}
& .hl-amber{background:var(--hl-amber)}& .hl-green{background:var(--hl-green)}& .hl-blue{background:var(--hl-blue)}& .hl-pink{background:var(--hl-pink)}
& .anc{border-bottom:2px solid var(--anchor);cursor:pointer}
& .cmt{position:absolute;right:-40px;top:4px;display:flex;align-items:center;gap:2px;color:var(--text3);font-size:12px;height:22px;padding:0 4px;border-radius:4px}
& .cmt:hover{background:var(--hover);color:var(--text2)}
& .h1{font-size:1.875em;font-weight:600;line-height:1.3;margin-top:1.1em}
& .h2{font-size:1.5em;font-weight:600;line-height:1.3;margin-top:1em}
& .h3{font-size:1.25em;font-weight:600;line-height:1.3;margin-top:.8em}
& .callout{display:flex;gap:10px;padding:14px 16px 14px 12px;border-radius:6px;background:var(--callout);margin:6px 0}
& .callout.yellow{background:var(--hl-amber)}& .callout.red{background:var(--red-bg);background:color-mix(in srgb,var(--red-bg) 55%,transparent)}& .callout.blue{background:var(--hl-blue)}
& .callout .cbody{flex:1;min-width:0}
& .callout .ct{font-weight:600;font-size:.94em;margin-bottom:2px}
& .quote{border-left:3px solid currentColor;padding:2px 14px;margin:4px 0;font-size:1em}
& .divider{height:1px;background:var(--line2);margin:14px 0}
& .bul{display:flex;gap:4px}
& .bul>.dot{width:24px;flex:none;text-align:center;line-height:1.5}
& .bul>.dot::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;vertical-align:middle;margin-top:-2px}
& .bul.l1>.dot::before{background:none;border:1.5px solid currentColor;width:5px;height:5px}
& .bul>.bt{flex:1;min-width:0}
& .todo{display:flex;gap:6px;align-items:flex-start}
& .cb{width:16px;height:16px;border:1.5px solid var(--text2);border-radius:3px;margin-top:4px;flex:none;display:flex;align-items:center;justify-content:center;cursor:pointer}
& .cb.on{background:var(--blue);border-color:var(--blue);color:#fff}
& .todo.done .tt{color:var(--text3);text-decoration:line-through;text-decoration-color:var(--line2)}
& .tgl{display:flex;gap:2px;align-items:flex-start}
& .tgb{width:24px;height:24px;flex:none;border-radius:4px;display:flex;align-items:center;justify-content:center;color:var(--text);margin-top:0;transition:transform .12s}
& .tgb:hover{background:var(--hover2)}
& .tgb.open svg{transform:rotate(90deg)}
& .tgbody{padding-left:26px}
& [contenteditable]{outline:none;caret-color:var(--text)}
& [contenteditable]:empty::before{content:attr(data-ph);color:var(--text3)}
& .ed:focus:empty::before{content:"Type '/' for commands";color:var(--text3)}
/* conversation */
& .ex{position:relative;margin:18px 0 8px}
& .qb{display:flex;gap:10px;padding:10px 12px;border-radius:6px;background:var(--qbg);border:1px solid var(--line);position:relative}
& .av{width:24px;height:24px;border-radius:50%;background:#d9d3c7;color:#4a463e;font-size:10.5px;font-weight:600;display:flex;align-items:center;justify-content:center;flex:none;margin-top:1px}
&[data-theme="dark"] .av{background:#4b463e;color:#e8e2d6}
& .qtext{font-weight:500;line-height:1.5;flex:1;min-width:0}
& .qmeta{font-size:12.5px;color:var(--text3);margin-top:3px;font-weight:400;font-family:var(--font)}
& .ah{display:flex;align-items:center;gap:6px;margin:12px 0 4px;font-size:13px;color:var(--text2);height:24px;font-family:var(--font)}
& .ah .sp{flex:1}
& .ah .acts{display:flex;gap:1px;opacity:0;transition:opacity .12s}
& .ex:hover>.ah .acts,& .ah .acts.show{opacity:1}
& .ah .tbtn{height:24px;font-size:13px;padding:0 6px}
& .ab{position:relative}
& .ab .blk{margin:2px 0;padding:3px 2px}
& .caret{display:inline-block;width:7px;height:1.1em;background:var(--blue);vertical-align:text-bottom;margin-left:2px;animation:${S}-blink 1s step-end infinite;border-radius:1px}
& .runline{display:flex;align-items:center;gap:8px;font-size:13.5px;color:var(--text2);padding:6px 10px;border-radius:6px;background:var(--bluebg);margin:6px 0;font-family:var(--font)}
& .runline .shim{background:linear-gradient(90deg,var(--text2) 0,var(--text) 50%,var(--text2) 100%);background-size:400px 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:${S}-shimmer 1.8s linear infinite;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
& .spin{width:14px;height:14px;border-radius:50%;border:2px solid var(--line2);border-top-color:var(--blue);animation:${S}-spin .8s linear infinite;flex:none}
& .btn{height:28px;padding:0 10px;border-radius:6px;font-size:14px;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;box-shadow:inset 0 0 0 1px var(--line2);color:var(--text)}
& .btn:hover{background:var(--hover)}
& .btn.pri{background:var(--blue);color:#fff;box-shadow:none;font-weight:500}
& .btn.pri:hover{background:var(--blueh)}
& .btn.sm{height:24px;font-size:13px;padding:0 8px}
& .meta-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0 2px;font-family:var(--font)}
& .srcchip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px 0 6px;border-radius:13px;font-size:12.5px;color:var(--text2);box-shadow:inset 0 0 0 1px var(--line2);max-width:240px;white-space:nowrap;overflow:hidden}
& .srcchip:hover{background:var(--hover)}
& .srcchip b{width:16px;height:16px;border-radius:4px;background:var(--hover2);display:flex;align-items:center;justify-content:center;font-size:9.5px;font-weight:700;color:var(--text2);flex:none}
& .srcchip span{overflow:hidden;text-overflow:ellipsis}
& .steps{margin:4px 0 6px 26px;font-size:13px;font-family:var(--font)}
& .step{display:flex;align-items:center;gap:8px;min-height:26px;color:var(--text2)}
& .step .sl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
& .step .sd{color:var(--text3);font-family:var(--mono);font-size:11.5px;white-space:nowrap}
& .step.err{color:var(--red)}
& .tgl.small{font-size:13.5px;color:var(--text2);font-family:var(--font)}
& .tgl.small .tgb{width:22px;height:22px;color:var(--text3)}
& .tgl .tgh{display:flex;align-items:center;gap:6px;min-height:24px;flex-wrap:wrap;cursor:pointer;min-width:0}
& .brh{font-weight:500;color:var(--text)}
& .brmeta{color:var(--text3);font-size:13px;font-weight:400;font-family:var(--font)}
& .branchwrap{margin:4px 0 6px;border-radius:6px}
& .branchwrap.open{background:linear-gradient(var(--bluebg),var(--bluebg)) 11px 26px/2px calc(100% - 30px) no-repeat}
& .plink{display:flex;align-items:center;gap:6px;padding:3px 4px;border-radius:4px;cursor:pointer;margin:2px 0}
& .plink:hover{background:var(--hover)}
& .plink u{text-decoration:none;border-bottom:1px solid var(--line2);font-weight:500}
& .plink .brmeta{margin-left:4px}
/* composer */
& .comp{border-radius:10px;background:var(--bg);box-shadow:var(--shadow2);margin:22px 0 8px;position:relative;font-family:var(--font)}
& .comp.big{border-radius:12px;box-shadow:var(--shadow)}
& .comp .crow{display:flex;gap:8px;padding:10px 12px 4px;align-items:flex-start}
& .comp .crow .spk{margin-top:3px;color:var(--purple)}
& .comp textarea{flex:1;border:0;outline:none;resize:none;background:transparent;font:inherit;font-size:15px;line-height:1.5;color:var(--text);min-height:24px;max-height:180px;padding:0}
& .comp textarea::placeholder{color:var(--text3)}
& .comp .cbar{display:flex;align-items:center;gap:4px;padding:4px 8px 8px 8px}
& .comp .cbar .sp{flex:1}
& .chip{height:26px;padding:0 8px;border-radius:6px;display:inline-flex;align-items:center;gap:5px;font-size:13px;color:var(--text2);white-space:nowrap}
& .chip:hover{background:var(--hover)}
& .chip.on{color:var(--text);background:var(--hover)}
& .send{width:28px;height:28px;border-radius:50%;background:var(--blue);color:#fff;display:flex;align-items:center;justify-content:center}
& .send[disabled]{background:var(--hover2);color:var(--text3);cursor:default}
& .chint{font-size:12.5px;color:var(--text3);padding:0 14px 10px;margin-top:-2px}
& .quoted{margin:4px 12px 0;padding:6px 10px;border-left:3px solid var(--anchor);font-size:13.5px;color:var(--text2);background:var(--bluebg);border-radius:0 4px 4px 0}
/* database */
& .dbh{display:flex;align-items:center;gap:2px;border-bottom:1px solid var(--line);margin-top:8px;position:relative}
& .vt{height:34px;display:flex;align-items:center;gap:6px;padding:0 8px;color:var(--text2);font-size:14px;position:relative;border-radius:5px 5px 0 0;white-space:nowrap}
& .vt:hover{background:var(--hover)}
& .vt.on{color:var(--text);font-weight:500}
& .vt.on::after{content:"";position:absolute;left:4px;right:4px;bottom:-1px;height:2px;background:var(--text);border-radius:1px}
& .dbh .sp{flex:1}
& .dbh .tbtn{height:28px}
& .newbtn{display:flex;height:28px;border-radius:6px;overflow:hidden;background:var(--blue);color:#fff;font-weight:500;font-size:14px;margin-left:6px}
& .newbtn button{padding:0 9px;display:flex;align-items:center;gap:4px;color:#fff}
& .newbtn button:hover{background:var(--blueh)}
& .newbtn button+button{border-left:1px solid rgba(255,255,255,.25);padding:0 5px}
& .fchips{display:flex;gap:6px;padding:8px 0 4px;align-items:center;flex-wrap:wrap}
& .fchip{height:24px;padding:0 9px;border-radius:12px;font-size:13px;display:inline-flex;align-items:center;gap:5px;color:var(--blue);background:var(--bluebg)}
& .fchip.off{color:var(--text3);background:none;box-shadow:inset 0 0 0 1px var(--line2)}
& .tbl{overflow-x:auto;overflow-y:visible;margin:0 -2px;padding-bottom:6px}
& .tr{display:flex;border-bottom:1px solid var(--line);min-width:max-content;position:relative}
& .tr.head{color:var(--text2);font-size:13.5px}
& .td{flex:none;padding:0 8px;height:34px;display:flex;align-items:center;gap:5px;border-right:1px solid var(--line);overflow:hidden;white-space:nowrap;font-size:14px}
& .td:last-child{border-right:0}
& .tr.head .td{height:33px;gap:6px}
& .tr:not(.head):hover{background:var(--hover)}
& .tr .nm{font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
& .tr .open{display:none;margin-left:auto;height:22px;padding:0 6px;border-radius:4px;font-size:11.5px;font-weight:600;color:var(--text2);background:var(--bg);box-shadow:var(--shadow2);align-items:center;gap:4px;letter-spacing:.02em}
& .tr:hover .open{display:flex}
& .tr .td.num{justify-content:flex-end;color:var(--text2)}
& .tr.foot{border-bottom:0;color:var(--text3);font-size:13.5px}
& .tr.foot:hover{background:var(--hover)}
& .tr .td .muted{color:var(--text3)}
& .dot8{width:7px;height:7px;border-radius:50%;background:var(--blue);flex:none}
& .page.dense .td{height:30px;font-size:13.5px}
& .board{display:flex;gap:12px;overflow-x:auto;padding:10px 0 12px;align-items:flex-start}
& .bcol{width:272px;flex:none;border-radius:8px;padding:6px 6px 8px}
& .bcol .bh{display:flex;align-items:center;gap:6px;height:30px;padding:0 4px;font-size:14px}
& .bcol .bh .n{color:var(--text3)}
& .bcard{background:var(--card);border-radius:8px;box-shadow:var(--shadow2);padding:9px 10px 10px;margin-top:8px;cursor:pointer;display:flex;flex-direction:column;gap:6px}
& .bcard:hover{background:color-mix(in srgb,var(--card) 92%,var(--text))}
& .bcard .bt{font-weight:500;font-size:14px;line-height:1.35;display:flex;gap:6px}
& .bcard .bp{display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:12.5px;color:var(--text2)}
& .bnew{height:30px;display:flex;align-items:center;gap:6px;padding:0 6px;color:var(--text3);border-radius:6px;margin-top:6px;font-size:14px;width:100%}
& .bnew:hover{background:var(--hover)}
& .gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;padding:12px 0}
& .gcard{border-radius:8px;box-shadow:var(--shadow2);overflow:hidden;cursor:pointer;background:var(--card);display:flex;flex-direction:column}
& .gcard:hover{background:color-mix(in srgb,var(--card) 94%,var(--text))}
& .gprev{overflow-wrap:anywhere;height:118px;padding:12px 14px 0;background:var(--qbg);font-size:9.5px;line-height:1.5;color:var(--text2);overflow:hidden;border-bottom:1px solid var(--line);font-family:var(--serif)}
& .gprev b{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere;font-family:var(--font);font-size:10.5px;color:var(--text);margin-bottom:4px;font-weight:600}
& .gbody{padding:9px 12px 11px;display:flex;flex-direction:column;gap:6px}
& .gbody .bt{font-weight:500;font-size:14px;display:flex;gap:6px;line-height:1.35}
& .gbody .bp{display:flex;gap:4px;flex-wrap:wrap;align-items:center;font-size:12.5px;color:var(--text2)}
& .lrow{display:flex;align-items:center;gap:8px;height:38px;padding:0 4px;border-bottom:1px solid var(--line);cursor:pointer}
& .lrow:hover{background:var(--hover)}
& .lrow .lt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
& .lrow .lm{color:var(--text3);font-size:13px;white-space:nowrap}
& .tl{position:relative;overflow-x:auto;margin-top:8px;border-top:1px solid var(--line)}
& .tlin{position:relative;min-width:max-content}
& .tlhead{display:flex;height:32px;border-bottom:1px solid var(--line)}
& .tlday{flex:none;font-size:12.5px;color:var(--text2);display:flex;align-items:center;padding-left:8px;border-left:1px solid var(--line)}
& .tlday.today{color:var(--red);font-weight:600}
& .tlgrid{position:absolute;top:32px;bottom:0;width:1px;background:var(--line)}
& .tlnow{position:absolute;top:24px;bottom:0;width:2px;background:var(--red);opacity:.7}
& .tlbar{position:absolute;height:28px;border-radius:6px;display:flex;align-items:center;gap:6px;padding:0 8px;font-size:13px;font-weight:500;background:var(--card);box-shadow:var(--shadow2);white-space:nowrap;overflow:hidden;cursor:pointer;min-width:28px}
& .tlbar:hover{background:color-mix(in srgb,var(--card) 92%,var(--text))}
& .tlbar .st{flex:none}
/* home */
& .homesub{text-align:center;color:var(--text2);font-size:14px;max-width:600px;margin:-8px auto 22px;line-height:1.55}
& .dbpage .ptitle{font-size:32px}
& .dbpage .picon{width:46px;height:46px;margin-top:44px;justify-content:flex-start}
& .tgrp{display:flex;align-items:center;gap:8px;height:40px;border-bottom:1px solid var(--line);cursor:pointer;padding:0 2px;min-width:max-content;font-size:14px}
& .tgrp .tgb{width:20px;height:20px}
& .line .ed{display:inline}
& .line .ed:empty{display:inline-block;min-width:2px}
& .cover.short{height:120px}
& .pmap{position:absolute;right:14px;top:120px;z-index:2;display:flex;flex-direction:column;align-items:flex-end;gap:2px;padding:8px 4px;border-radius:10px;max-height:calc(100% - 140px);overflow-y:auto}
& .pmh,& .pmf,& .pmi .pmt,& .pmi .ic{display:none}
& .pmi{display:flex;align-items:center;gap:6px;height:12px;color:var(--text3);white-space:nowrap;flex:none;border-radius:5px;padding:0 4px}
& .pmi .pmd{display:block;height:2px;width:var(--lw);border-radius:1px;background:currentColor;opacity:.75;flex:none}
& .pmi.on{color:var(--text)}
& .pmap:hover,& .pmap.pin{align-items:stretch;width:250px;background:var(--menu);box-shadow:var(--shadow);gap:1px}
& .pmap:hover .pmh,& .pmap.pin .pmh{display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:600;color:var(--text3);padding:0 4px 4px 8px}
& .pmap:hover .pmh .tbtn,& .pmap.pin .pmh .tbtn{height:22px;min-width:22px}
& .pmap:hover .pmf,& .pmap.pin .pmf{display:block;font-size:12px;color:var(--text3);padding:6px 8px 2px;border-top:1px solid var(--line);margin-top:4px}
& .pmap:hover .pmi,& .pmap.pin .pmi{height:26px;font-size:13px;padding-left:calc(8px + var(--dp)*14px);color:var(--text2)}
& .pmap:hover .pmi:hover,& .pmap.pin .pmi:hover{background:var(--hover)}
& .pmap:hover .pmi.on,& .pmap.pin .pmi.on{color:var(--text);font-weight:500}
& .pmap:hover .pmi .pmt,& .pmap.pin .pmi .pmt{display:block;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
& .pmap:hover .pmi .ic,& .pmap.pin .pmi .ic{display:inline-flex}
& .pmap:hover .pmi .pmd,& .pmap.pin .pmi .pmd{width:8px}
& .pmap:hover .pmi .ic+.pmd,& .pmap.pin .pmi .ic+.pmd{display:none}
& .mapped>.scroll>.page{margin:0 270px 0 0}
& .mapped>.pmap.pin{top:20px}
& .codeblk{font-family:var(--mono);font-size:13px;line-height:1.55;background:var(--callout);color:var(--text);padding:14px 16px;border-radius:6px;margin:4px 0;overflow-x:auto;white-space:pre}
& .run{padding:9px 0;border-bottom:1px solid var(--line)}
& .run .rh{display:flex;align-items:center;gap:7px;cursor:pointer;min-height:22px}
& .run .rt{flex:1;min-width:0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
& .run .rm{font-size:12.5px;color:var(--text3);margin:1px 0 0 21px}
& .run .lnk{font-size:12.5px;color:var(--blue);margin-left:21px;cursor:pointer;text-decoration:none}
& .ell{overflow:hidden;text-overflow:ellipsis;min-width:0}
& .t2{color:var(--text2)}
& .t3{color:var(--text3)}
& .pu{color:var(--purple)}
& .home{max-width:900px;margin:0 auto;padding:0 64px 120px}
& .greet{font-size:30px;font-weight:700;text-align:center;margin:44px 0 20px;letter-spacing:-.01em}
& .sec{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:500;color:var(--text2);margin:30px 0 10px;height:24px}
& .sec .sp{flex:1}
& .recent{display:flex;gap:14px;overflow-x:auto;padding:4px 2px 8px}
& .rcard{width:144px;height:132px;flex:none;border-radius:12px;background:var(--card);box-shadow:var(--shadow2);overflow:hidden;position:relative;cursor:pointer;display:flex;flex-direction:column}
& .rcard:hover{background:color-mix(in srgb,var(--card) 94%,var(--text))}
& .rcard .rc{height:40px;background:var(--qbg)}
& .rcard .ri{position:absolute;left:14px;top:24px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:6px;background:var(--card)}
& .rcard .rt{padding:20px 14px 0;font-size:13.5px;font-weight:600;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
& .rcard .rd{white-space:nowrap;overflow:hidden;padding:4px 14px;font-size:12px;color:var(--text3);margin-top:auto;padding-bottom:10px;display:flex;align-items:center;gap:6px}
& .att{border-radius:10px;box-shadow:var(--shadow2);overflow:hidden;background:var(--card)}
& .kind{width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;flex:none}
& .kind.unread{background:var(--blue-bg);color:var(--blue2)}& .kind.failed{background:var(--red-bg);color:var(--red)}& .kind.clarify{background:var(--yellow-bg);color:var(--yellow)}& .kind.running{background:var(--blue-bg);color:var(--blue2)}& .kind.queued{background:var(--gray-bg);color:var(--gray)}
&[data-theme="dark"] .kind{color:var(--tagtx)}
/* AI panel / peek / inbox */
& .aip{width:372px;flex:none;border-left:1px solid var(--line);display:flex;flex-direction:column;background:var(--bg);min-height:0}
& .aiph{height:44px;display:flex;align-items:center;gap:6px;padding:0 10px 0 14px;flex:none;font-weight:600;font-size:14px}
& .aiph .sp{flex:1}
& .aipb{flex:1;overflow-y:auto;padding:4px 14px 12px;font-size:14px}
& .ctxchip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:12px;font-size:12.5px;background:var(--hover);color:var(--text2);max-width:100%;overflow:hidden;white-space:nowrap}
& .ctxchip span{overflow:hidden;text-overflow:ellipsis}
& .pa{margin:4px 0 10px;line-height:1.5}
& .pa .pam{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text3);margin-bottom:3px}
& .pa .pat{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;color:var(--text)}
& .pa .lnk{font-size:13px;color:var(--blue);cursor:pointer;text-decoration:none}
& .aipf{padding:0 12px 12px;flex:none}
& .aipf .comp{margin:0}
& .peek{position:absolute;top:0;right:0;bottom:0;width:640px;background:var(--bg);box-shadow:var(--shadow);z-index:5;display:flex;flex-direction:column}
& .peek .top{height:42px}
& .peek .page{padding:0 56px 100px;--pw:100%}
& .peek .picon{margin-top:28px}
& .inbox{position:absolute;top:0;bottom:0;left:240px;width:380px;background:var(--bg);box-shadow:var(--shadow);z-index:6;display:flex;flex-direction:column}
& .inbox .ih{height:46px;display:flex;align-items:center;padding:0 10px 0 16px;gap:4px;font-weight:600}
& .inbox .ih .sp{flex:1}
& .inbox .il{overflow-y:auto;flex:1}
& .iitem{display:flex;gap:10px;padding:12px 16px;cursor:pointer;border-bottom:1px solid var(--line);position:relative}
& .iitem:hover{background:var(--hover)}
& .att .iitem:last-child{border-bottom:0}
& .iitem .iw{flex:1;min-width:0}
& .iitem .it{font-size:14px;font-weight:500;line-height:1.35}
& .iitem .id{font-size:13px;color:var(--text2);margin-top:2px;line-height:1.4}
& .iitem .ip{font-size:12.5px;color:var(--text3);margin-top:5px;display:flex;align-items:center;gap:5px;overflow:hidden;white-space:nowrap}
& .iitem .udot{position:absolute;left:6px;top:20px;width:6px;height:6px;border-radius:50%;background:var(--blue)}
/* layer: menus, modals, toast */
& .layer{position:absolute;inset:0;pointer-events:none;z-index:20}
& .layer>*{pointer-events:auto}
& .scrim{position:absolute;inset:0;background:transparent}
& .scrim.dim{background:rgba(15,15,15,.32)}
& .menu{position:absolute;min-width:220px;max-width:340px;background:var(--menu);border-radius:10px;box-shadow:var(--shadow);padding:6px 0;font-size:14px;max-height:420px;overflow-y:auto}
& .mh{font-size:12px;font-weight:500;color:var(--text3);padding:8px 14px 4px}
& .mi{display:flex;align-items:center;gap:10px;min-height:30px;padding:0 10px;margin:0 4px;border-radius:6px;cursor:pointer}
& .mi.sel{background:var(--hover)}
& .mi .mic{width:22px;height:22px;display:flex;align-items:center;justify-content:center;color:var(--text2);flex:none;font-size:12.5px;font-weight:600}
& .mi .mic.box{border-radius:4px;box-shadow:inset 0 0 0 1px var(--line2);background:var(--bg)}
& .mi .ml{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
& .mi .ml small{display:block;font-size:12px;color:var(--text3);margin-top:-2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
& .mi .mk{color:var(--text3);font-size:12px;white-space:nowrap}
& .mi.dis{opacity:.45;cursor:default}
& .mi .chk{color:var(--text)}
& .msep{height:1px;background:var(--line);margin:5px 0}
& .mempty{padding:6px 14px;color:var(--text3)}
& .search{position:absolute;left:50%;top:84px;transform:translateX(-50%);width:640px;background:var(--menu);border-radius:12px;box-shadow:var(--shadow);overflow:hidden;display:flex;flex-direction:column;max-height:560px}
& .search .sin{display:flex;align-items:center;gap:10px;padding:0 16px;height:52px;border-bottom:1px solid var(--line)}
& .search input{flex:1;border:0;outline:none;background:transparent;font:inherit;font-size:17px;color:var(--text)}
& .search input::placeholder{color:var(--text3)}
& .search .sres{overflow-y:auto;padding:6px 0}
& .sr{display:flex;gap:10px;padding:7px 12px;margin:0 6px;border-radius:6px;cursor:pointer;align-items:flex-start}
& .sr.sel{background:var(--hover)}
& .sr .srw{flex:1;min-width:0}
& .sr .srt{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
& .sr .srs{font-size:13px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
& .sr .srs mark{background:var(--hl-amber);color:inherit;border-radius:2px}
& .sr .srp{font-size:12px;color:var(--text3);white-space:nowrap}
& .search .sfoot{border-top:1px solid var(--line);padding:8px 16px;font-size:12px;color:var(--text3);display:flex;gap:16px}
& .pop{position:absolute;width:300px;background:var(--menu);border-radius:10px;box-shadow:var(--shadow);padding:12px 14px;font-size:14px}
& .pop .pt{font-weight:600;margin-bottom:6px}
& .pop .pd{color:var(--text2);font-size:13px;line-height:1.45}
& .selbar{position:absolute;display:flex;background:var(--menu);border-radius:8px;box-shadow:var(--shadow);padding:3px;gap:1px;font-size:13.5px}
& .selbar button{height:28px;padding:0 8px;border-radius:5px;display:flex;align-items:center;gap:5px;white-space:nowrap}
& .selbar button:hover{background:var(--hover)}
& .selbar .sw{width:14px;height:14px;border-radius:3px;padding:0;margin:0 2px;box-shadow:inset 0 0 0 1px var(--line2)}
& .toast{position:absolute;left:50%;bottom:28px;transform:translateX(-50%);background:var(--toast);color:#fff;font-size:13.5px;padding:9px 14px;border-radius:8px;box-shadow:var(--shadow);white-space:nowrap}
/* getting started */
& .agt{border:1px solid var(--line);border-radius:8px;margin:8px 0 6px;overflow:hidden;font-family:var(--font);font-size:14px}
& .agr{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--line)}
& .agr:last-child{border-bottom:0}
& .agr .an{width:120px;font-weight:500;display:flex;align-items:center;gap:8px}
& .agr .as{width:150px}
& .agr .ax{flex:1;display:flex;align-items:center;gap:8px;justify-content:flex-end;color:var(--text2);font-size:13px}
& .pdot{width:10px;height:10px;border-radius:3px;flex:none}
& .tpls{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:10px 0}
& .tpl{border-radius:8px;box-shadow:var(--shadow2);padding:12px 14px;cursor:pointer;background:var(--card);font-family:var(--font)}
& .tpl:hover{background:color-mix(in srgb,var(--card) 94%,var(--text))}
& .tpl b{display:flex;gap:6px;align-items:center;font-weight:600;font-size:14px;margin-bottom:4px}
& .tpl span{font-size:13px;color:var(--text2);line-height:1.4;display:block}
& .sugg{display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 10px}
& .sugg button{font-size:13px;height:26px;padding:0 10px;border-radius:13px;box-shadow:inset 0 0 0 1px var(--line2);color:var(--text2)}
& .sugg button:hover{background:var(--hover)}
& .aiblk{border-radius:8px;box-shadow:inset 0 0 0 1px var(--line2);padding:10px 12px;margin:8px 0;font-family:var(--font)}
& .aiblk .aibh{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text3);margin-bottom:6px}
& .aiblk .comp{margin:0;box-shadow:none}
& .emptydb{padding:36px 0;text-align:center;color:var(--text3);font-size:14px}
& .emptydb b{display:block;color:var(--text2);font-weight:500;margin-bottom:4px}
`.replace(/&/g, "." + S);

 /* ---------------------------------------------------------------- icons */
 var P = {
  search: '<circle cx="9" cy="9" r="5.3"/><path d="M13 13l3.8 3.8"/>',
  home: '<path d="M3.6 9.2L10 3.8l6.4 5.4V16a1 1 0 0 1-1 1h-3.3v-4.4H7.9V17H4.6a1 1 0 0 1-1-1z"/>',
  inbox: '<path d="M3 11.2l2.1-6.6h9.8l2.1 6.6v4.3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3.2 11h3.9l1 2h3.8l1-2h3.9"/>',
  page: '<path d="M5.6 2.8h5.9l3.7 3.7V16.2a1 1 0 0 1-1 1H5.6a1 1 0 0 1-1-1V3.8a1 1 0 0 1 1-1z"/><path d="M11.2 2.9v3.9h3.9M7.4 10.4h5.2M7.4 13.4h5.2"/>',
  db: '<rect x="3" y="3.8" width="14" height="12.4" rx="1.6"/><path d="M3 8h14M3 12.1h14M8 8v8.2"/>',
  spark: '<path fill="currentColor" stroke="none" d="M9.2 2.6c.3 0 .5.2.6.5l.9 3a3 3 0 0 0 2 2l3 .9c.6.2.6 1 0 1.2l-3 .9a3 3 0 0 0-2 2l-.9 3c-.2.6-1 .6-1.2 0l-.9-3a3 3 0 0 0-2-2l-3-.9c-.6-.2-.6-1 0-1.2l3-.9a3 3 0 0 0 2-2l.9-3c.1-.3.3-.5.6-.5zM15.4 1.8c.1 0 .2.1.3.2l.3 1a1 1 0 0 0 .7.7l1 .3c.2.1.2.4 0 .5l-1 .3a1 1 0 0 0-.7.7l-.3 1c-.1.2-.4.2-.5 0l-.3-1a1 1 0 0 0-.7-.7l-1-.3c-.2-.1-.2-.4 0-.5l1-.3a1 1 0 0 0 .7-.7l.3-1c0-.1.1-.2.2-.2z"/>',
  plus: '<path d="M10 4.2v11.6M4.2 10h11.6"/>',
  chevR: '<path d="M7.8 5l5 5-5 5"/>', chevD: '<path d="M5 7.8l5 5 5-5"/>',
  tri: '<path fill="currentColor" stroke="none" d="M7.2 5.2c0-.6.7-1 1.2-.6l5.4 4.6c.4.4.4 1 0 1.4l-5.4 4.6c-.5.4-1.2 0-1.2-.6z"/>',
  drag: '<g fill="currentColor" stroke="none"><circle cx="7.5" cy="5" r="1.25"/><circle cx="12.5" cy="5" r="1.25"/><circle cx="7.5" cy="10" r="1.25"/><circle cx="12.5" cy="10" r="1.25"/><circle cx="7.5" cy="15" r="1.25"/><circle cx="12.5" cy="15" r="1.25"/></g>',
  more: '<g fill="currentColor" stroke="none"><circle cx="4.5" cy="10" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="15.5" cy="10" r="1.4"/></g>',
  star: '<path d="M10 3l2.1 4.4 4.8.6-3.5 3.3.9 4.7L10 13.8 5.7 16l.9-4.7L3.1 8l4.8-.6z"/>',
  starF: '<path fill="currentColor" d="M10 3l2.1 4.4 4.8.6-3.5 3.3.9 4.7L10 13.8 5.7 16l.9-4.7L3.1 8l4.8-.6z"/>',
  clock: '<circle cx="10" cy="10" r="6.8"/><path d="M10 6.2V10l2.6 1.8"/>',
  comment: '<path d="M4.2 4.2h11.6a1 1 0 0 1 1 1v7.2a1 1 0 0 1-1 1H9.4l-3.6 2.9v-2.9H4.2a1 1 0 0 1-1-1V5.2a1 1 0 0 1 1-1z"/>',
  branch: '<circle cx="6" cy="4.6" r="1.8"/><circle cx="6" cy="15.4" r="1.8"/><circle cx="14.2" cy="7" r="1.8"/><path d="M6 6.4v7.2M14.2 8.8c0 3.4-8.2 2-8.2 4.8"/>',
  filter: '<path d="M3.5 5.2h13M6 10h8M8.5 14.8h3"/>',
  sort: '<path d="M6.2 3.8v12.4M3.6 13.6l2.6 2.6 2.6-2.6M13.8 16.2V3.8M11.2 6.4l2.6-2.6 2.6 2.6"/>',
  board: '<rect x="3" y="3.8" width="4" height="12.4" rx="1"/><rect x="8.5" y="3.8" width="4" height="8.4" rx="1"/><rect x="14" y="3.8" width="3" height="10.4" rx="1"/>',
  gallery: '<rect x="3" y="3.8" width="6" height="5.4" rx="1"/><rect x="11" y="3.8" width="6" height="5.4" rx="1"/><rect x="3" y="10.8" width="6" height="5.4" rx="1"/><rect x="11" y="10.8" width="6" height="5.4" rx="1"/>',
  list: '<path d="M7.2 5.6h9.6M7.2 10h9.6M7.2 14.4h9.6"/><g fill="currentColor" stroke="none"><circle cx="4" cy="5.6" r="1"/><circle cx="4" cy="10" r="1"/><circle cx="4" cy="14.4" r="1"/></g>',
  timeline: '<path d="M3 3.5v13"/><rect x="5" y="4.6" width="8" height="2.8" rx="1"/><rect x="8.2" y="8.6" width="8.4" height="2.8" rx="1"/><rect x="6" y="12.6" width="6" height="2.8" rx="1"/>',
  tag: '<path d="M3.4 3.4h6.2l7 7-6.2 6.2-7-7z"/><circle cx="6.9" cy="6.9" r="1.1"/>',
  link: '<path d="M8.6 11.4l2.8-2.8M7.2 9.4l-1.9 1.9a2.6 2.6 0 0 0 3.7 3.7l1.9-1.9M12.8 10.6l1.9-1.9a2.6 2.6 0 0 0-3.7-3.7L9.1 6.9"/>',
  status: '<circle cx="10" cy="10" r="6.6"/><path fill="currentColor" stroke="none" d="M10 5.4a4.6 4.6 0 0 1 0 9.2z"/>',
  agent: '<rect x="5" y="5" width="10" height="10" rx="2"/><path d="M8 2.6V5M12 2.6V5M8 15v2.4M12 15v2.4M2.6 8H5M2.6 12H5M15 8h2.4M15 12h2.4"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h3.9l1.6 1.6H16a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  archive: '<rect x="3" y="3.8" width="14" height="3.6" rx=".8"/><path d="M4.4 7.4V15.2a1 1 0 0 0 1 1h9.2a1 1 0 0 0 1-1V7.4M8 10.6h4"/>',
  tpl: '<rect x="3.4" y="3.4" width="13.2" height="13.2" rx="1.6"/><path d="M3.4 8h13.2M8 8v8.6"/>',
  cont: '<path d="M4.6 3.6v5.2a3 3 0 0 0 3 3h8.2M12.4 8.4l3.4 3.4-3.4 3.4"/>',
  up: '<path d="M10 15.6V4.6M5.2 9.4L10 4.6l4.8 4.8"/>',
  stop: '<rect x="5.5" y="5.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none"/>',
  check: '<path d="M4.6 10.4l3.5 3.5 7.4-7.8"/>',
  x: '<path d="M5.4 5.4l9.2 9.2M14.6 5.4l-9.2 9.2"/>',
  back: '<path d="M12.2 4.4L6.6 10l5.6 5.6"/>', fwd: '<path d="M7.8 4.4l5.6 5.6-5.6 5.6"/>',
  marker: '<path d="M12.6 3.4l4 4-7.2 7.2H5.4v-4z"/><path d="M3.6 17.2h12.8"/>',
  flag: '<path d="M5 17.2V3.2M5 3.8h9.4l-2.2 3.6 2.2 3.6H5"/>',
  globe: '<circle cx="10" cy="10" r="6.8"/><path d="M3.2 10h13.6M10 3.2c2.2 2 2.2 11.6 0 13.6M10 3.2c-2.2 2-2.2 11.6 0 13.6"/>',
  term: '<path d="M4.2 6l4 4-4 4M10 14.4h5.8"/>',
  edit: '<path d="M12.8 3.6l3.6 3.6-8.8 8.8H4v-3.6z"/>',
  collapse: '<path d="M10.4 5l-5 5 5 5M15.6 5l-5 5 5 5"/>',
  newpage: '<path d="M10.6 3.4H5a1.2 1.2 0 0 0-1.2 1.2v10.8A1.2 1.2 0 0 0 5 16.6h10a1.2 1.2 0 0 0 1.2-1.2V9.6"/><path d="M14.4 2.6l3 3-6.8 6.8H7.6v-3z"/>',
  copy: '<rect x="7" y="7" width="9.6" height="9.6" rx="1.6"/><path d="M4.4 13V4.6a1.2 1.2 0 0 1 1.2-1.2H13"/>',
  bell: '<path d="M5 13.6V9a5 5 0 0 1 10 0v4.6l1.4 1.6H3.6z"/><path d="M8.4 17.2h3.2"/>',
  alert: '<circle cx="10" cy="10" r="6.8"/><path d="M10 6.2v4.4M10 13.4v.2"/>',
  q: '<circle cx="10" cy="10" r="6.8"/><path d="M8 8a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.3v.3M10 13.6v.2"/>',
  expand: '<path d="M11.4 3.6h5v5M16.4 3.6l-6 6M8.6 16.4h-5v-5M3.6 16.4l6-6"/>',
  cal: '<rect x="3.4" y="4.4" width="13.2" height="12.2" rx="1.6"/><path d="M3.4 8.4h13.2M7 2.8v3M13 2.8v3"/>',
  rel: '<path d="M7 13l6-6M8 7h5v5"/>',
  text: '<path d="M4.6 5.4h10.8M10 5.4v10"/>',
  side: '<rect x="3" y="3.8" width="14" height="12.4" rx="1.6"/><path d="M12 3.8v12.4"/>',
  trash: '<path d="M4 5.6h12M8 5.6V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.6M5.6 5.6l.8 10.4a1 1 0 0 0 1 .9h5.2a1 1 0 0 0 1-.9l.8-10.4"/>'
 };
 function svg(name, size, extra) {
  var s = size || 16;
  var sp = document.createElement("span");
  sp.className = "ic" + (extra ? " " + extra : "");
  sp.innerHTML = '<svg width="' + s + '" height="' + s + '" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + (P[name] || "") + "</svg>";
  return sp;
 }

 /* ------------------------------------------------------- tiny DOM helper */
 function h(tag, attrs) {
  var parts = tag.split(".");
  var n = document.createElement(parts[0] || "div");
  if (parts.length > 1) n.className = parts.slice(1).join(" ");
  if (attrs) for (var k in attrs) {
   var v = attrs[k];
   if (v == null || v === false) continue;
   if (k === "class") n.className = (n.className ? n.className + " " : "") + v;
   else if (k === "style") n.style.cssText = v;
   else if (k === "text") n.textContent = v;
   else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2).toLowerCase(), v);
   else n.setAttribute(k, v === true ? "" : v);
  }
  for (var i = 2; i < arguments.length; i++) add(n, arguments[i]);
  return n;
 }
 function add(n, kid) {
  if (kid == null || kid === false) return;
  if (Array.isArray(kid)) { kid.forEach(function (k) { add(n, k); }); return; }
  n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
 }

 /* inline markdown: `code`, **bold**, [text](url) */
 function md(str) {
  var out = [], re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g, last = 0, m;
  str = String(str || "");
  while ((m = re.exec(str))) {
   if (m.index > last) out.push(document.createTextNode(str.slice(last, m.index)));
   var t = m[0];
   if (m[1]) out.push(h("code", { text: t.slice(1, -1) }));
   else if (m[2]) out.push(h("b", { text: t.slice(2, -2) }));
   else { var mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(t); out.push(h("a", { text: mm[1], title: mm[2], href: "#", onclick: function (e) { e.preventDefault(); } })); }
   last = m.index + t.length;
  }
  if (last < str.length) out.push(document.createTextNode(str.slice(last)));
  return out;
 }
 function plain(str) { return String(str || "").replace(/`/g, "").replace(/\*\*/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); }

 /* -------------------------------------------------------------- variants */
 var VARIANTS = [
   { id: "a", name: "Table home, inline AI", note: "Home explains Session in one line and leads with an Ask box and a Research table; you chat in an inline AI block at the end of each page, and branches are toggles under their paragraph." },
   { id: "b", name: "Status board, branch sub-pages", note: "Opens on Research as a board grouped by Notion status groups (Needs you, In progress, Complete); branches become sub-pages that nest in the sidebar." },
   { id: "c", name: "AI panel as run console", note: "Pages stay clean documents; a page-bound AI panel holds the composer and lists every run in tree order with its model, steps and queue state, instead of repeating answer text." },
   { id: "d", name: "First run: Getting started", note: "An empty workspace opens on a Getting started page whose Ask block is above the fold, with agent status in one line, explanations as toggles, and templates." },
   { id: "e", name: "Grouped triage, side peek", note: "Dense full-width table grouped by status group (Needs you first); opening a row shows the page in a side peek so many runs can be triaged without leaving the list." }
 ];
 var VCONF = {
  a: { start: { k: "home" }, view: "table", homeView: "table", chat: "inline", branch: "toggle" },
  b: { start: { k: "db", ws: null }, view: "board", homeView: "board", chat: "inline", branch: "subpage" },
  c: { start: { k: "page", t: "t1" }, view: "gallery", homeView: "gallery", chat: "panel", branch: "toggle", serif: true },
  d: { start: { k: "gs" }, view: "table", homeView: "table", chat: "inline", branch: "toggle", firstRun: true },
  e: { start: { k: "db", ws: null }, view: "table", homeView: "list", chat: "inline", branch: "subpage", peek: true, wide: true, small: true, group: true }
 };

 /* ----------------------------------------------------------------- mount */
 function mount(root, ctx) {
  var V = VCONF[ctx.variant] || VCONF.a;
  var D = ctx.data;
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var NOW = new Date(D.now).getTime(), T0 = Date.now();
  var timers = [];
  function later(fn, ms) { var id = setTimeout(fn, ms); timers.push(id); return id; }
  function nowISO() { return new Date(NOW + (Date.now() - T0)).toISOString(); }

  var threads = JSON.parse(JSON.stringify(D.threads));
  var drafts = JSON.parse(JSON.stringify(D.drafts));
  var inbox = JSON.parse(JSON.stringify(D.inbox));
  var DEFWS = { id: "ws-default", name: "Default workspace", dir: "~/Session" };
  var PROV = { claude: { label: "Claude Code", c: "orange", hex: "#d9730d" }, codex: { label: "Codex", c: "green", hex: "#448361" }, grok: { label: "Grok", c: "purple", hex: "#9065b0" } };
  var STAT = { queued: { label: "Queued", c: "gray" }, running: { label: "Running", c: "blue" }, done: { label: "Done", c: "green" }, failed: { label: "Failed", c: "red" }, "needs-review": { label: "Needs review", c: "orange" } };
  var GROUPS = [{ id: "needs", label: "Needs you", st: ["needs-review", "failed"], c: "orange", hint: "failed, or waiting for your answer" }, { id: "prog", label: "In progress", st: ["running", "queued"], c: "blue", hint: "running or queued" }, { id: "done", label: "Complete", st: ["done"], c: "green", hint: "" }];
  var DOTC = { gray: "--gray", blue: "--blue2", orange: "--orange", red: "--red", green: "--green" };
  var FOLDC = { "f-jit": "blue", "f-test262": "purple", "f-serving": "green", "f-storage": "brown", "f-papers": "yellow", "f-links": "pink" };
  var WSC = { "ws-compilers": "#d9730d", "ws-ml": "#337ea9", "ws-reading": "#448361", "ws-default": "#787774" };
  var TAGC = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
  function tagColor(s) { var x = 0; for (var i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0; return TAGC[x % TAGC.length]; }

  /* notes -> block model */
  var bid = 0;
  function nb(type, text, extra) { var b = { id: "b" + (++bid), type: type, text: text || "", children: [] }; for (var k in extra || {}) b[k] = extra[k]; return b; }
  function fromOutline(items) { return (items || []).map(function (o) { var b = nb("bullet", o.text, { refs: o.ref ? [o.ref] : [] }); b.children = fromOutline(o.children); return b; }); }
  var notes = D.notes.map(function (n) {
   return { id: n.id, workspaceId: n.workspaceId, title: n.title, updatedAt: n.updatedAt, tags: n.tags.slice(), blocks: fromOutline(n.outline) };
  });

  var st = {
   route: V.start, hist: [V.start], hi: 0,
   view: V.view, folder: null, sideOpen: true,
   open: {}, sideX: { "ws:ws-compilers": true, "db:ws-compilers": false, "fav": true, "ws:ws-default": true },
   panel: V.chat === "panel", peek: null,
   firstRun: !!V.firstRun, agents: V.firstRun ? { claude: "ready", codex: "signin", grok: "missing" } : { claude: "ready", codex: "ready", grok: "ready" },
   checks: {}, agent: { provider: "claude", model: "opus", effort: "high" }, mode: "followup",
   text: {}, pendingBranch: null, showBacklinks: {}, serif: !!V.serif, small: !!V.small, wide: !!V.wide,
   layer: null, toast: null, created: 0, readInbox: {}
  };
  if (V.firstRun) st.sideX["ws:ws-compilers"] = false;
  if (ctx.variant === "b") { st.sideX["db:ws-compilers"] = true; st.sideX["fav:t1"] = true; }
  var runs = {};

  /* ------------------------------------------------------------ data helpers */
  function wsList() { if (st.firstRun) return [DEFWS]; var l = D.workspaces.slice(); if (threads.some(function (t) { return t.workspaceId === "ws-default"; })) l.push(DEFWS); return l; }
  function wsById(id) { return id === "ws-default" ? DEFWS : D.workspaces.find(function (w) { return w.id === id; }); }
  function folderById(id) { return D.folders.find(function (f) { return f.id === id; }); }
  function thr(id) { return threads.find(function (t) { return t.id === id; }); }
  function turnOf(t, id) { return t.turns.find(function (u) { return u.id === id; }); }
  function visible() { var ws = wsList().map(function (w) { return w.id; }); return threads.filter(function (t) { return ws.indexOf(t.workspaceId) >= 0; }); }
  function active(list) { return list.filter(function (t) { return !t.archivedAt; }); }
  function rootTurn(t) { return turnOf(t, t.rootTurnId) || t.turns[0]; }
  function followupOf(t, u) { return t.turns.find(function (x) { return x.parentId === u.id && x.relation === "followup"; }); }
  function chain(t, start) { var out = [], u = start; while (u) { out.push(u); u = followupOf(t, u); } return out; }
  function branchesOf(t, u) { return t.turns.filter(function (x) { return x.parentId === u.id && x.relation === "branch"; }); }
  function srcCount(t) { var s = {}; t.turns.forEach(function (u) { u.sources.forEach(function (x) { s[x.url] = 1; }); }); return Object.keys(s).length; }
  function hlCount(t) { return t.turns.reduce(function (a, u) { return a + u.highlights.length; }, 0); }
  function backlinks(t) {
   var out = [];
   notes.forEach(function (n) { if (JSON.stringify(n.blocks).indexOf('"threadId":"' + t.id + '"') >= 0) out.push({ kind: "note", id: n.id, title: n.title }); });
   threads.forEach(function (o) { if (o.id !== t.id && o.links.indexOf(t.id) >= 0) out.push({ kind: "page", id: o.id, title: o.title }); });
   return out;
  }
  function threadStatus(t) {
   var s = t.turns.map(function (u) { return u.status; });
   if (s.indexOf("running") >= 0) return "running";
   if (s.indexOf("needs-review") >= 0) return "needs-review";
   if (s.indexOf("queued") >= 0 && t.turns.length === 1) return "queued";
   var last = t.turns[t.turns.length - 1];
   return last.status === "failed" ? "failed" : (t.status === "failed" && s.indexOf("failed") >= 0 ? "failed" : "done");
  }
  function unreadCount() { return inbox.filter(function (i) { return !st.readInbox[i.id] && visible().some(function (t) { return t.id === i.threadId; }); }).length; }

  function rel(iso) {
   var d = (new Date(nowISO()).getTime() - new Date(iso).getTime()) / 60000;
   if (d < 1) return "Just now"; if (d < 60) return Math.round(d) + "m ago"; if (d < 1440) return Math.round(d / 60) + "h ago";
   var days = Math.round(d / 1440); if (days < 7) return days + "d ago"; return fmtDate(iso);
  }
  function fmtDate(iso) { var d = new Date(iso); return MONTHS[d.getUTCMonth()] + " " + d.getUTCDate(); }
  function fmtDT(iso) { var d = new Date(iso); return fmtDate(iso) + ", " + String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0"); }
  function dur(s) { s = Math.round(s); return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s"; }
  function elapsed(u) { if (runs[u.id]) return (Date.now() - runs[u.id].t0) / 1000; return (new Date(nowISO()).getTime() - new Date(u.createdAt).getTime()) / 1000; }

  /* ------------------------------------------------------------ components */
  function tag(text, c) { return h("span.tag.c-" + (c || tagColor(text)), { text: text }); }
  function stPill(s) { var m = STAT[s] || STAT.done; return h("span.st.c-" + m.c + (s === "running" ? " run" : ""), null, h("i"), m.label); }
  function provTag(p) { return tag(PROV[p] ? PROV[p].label : p, PROV[p] ? PROV[p].c : "gray"); }
  function folderTag(id) { var f = folderById(id); return f ? tag(f.name, FOLDC[id] || "gray") : null; }
  function threadIcon(t, size) {
   size = size || 18;
   var c = t.kind === "post" ? "#9b9a97" : t.kind === "document" ? "#787774" : (PROV[t.provider] || {}).hex || "#787774";
   var name = t.kind === "post" ? "link" : t.kind === "document" ? "page" : "spark";
   var s = svg(name, size); s.style.color = c; return s;
  }
  function pageIcon(kind, size, color) { var s = svg(kind, size || 18); if (color) s.style.color = color; return s; }
  function wsIcon(ws, size) {
   size = size || 20;
   return h("span.ic", { style: "width:" + size + "px;height:" + size + "px;border-radius:4px;background:" + (WSC[ws.id] || "#787774") + ";color:#fff;font-size:" + Math.round(size * 0.55) + "px;font-weight:600;line-height:1", text: ws.name[0] });
  }
  function mention(t, turn, onclick) {
   return h("span.mention", { onclick: function (e) { e.stopPropagation(); onclick ? onclick() : openThread(t.id, turn ? turn.id : null); } },
    h("span.mni", null, threadIcon(t, 14)), h("u", { text: turn && turn.id !== t.rootTurnId ? t.title.slice(0, 34) + (t.title.length > 34 ? "…" : "") + " › " + turn.title : t.title }));
  }

  /* ------------------------------------------------------------ navigation */
  function go(r, opts) {
   opts = opts || {};
   st.layer = null; st.peek = null;
   if (V.peek && r.k === "page" && !opts.full && (st.route.k === "db" || st.route.k === "home") && !opts.nopeek) { st.peek = r; render(); return; }
   if (!opts.replace) { st.hist = st.hist.slice(0, st.hi + 1); st.hist.push(r); st.hi = st.hist.length - 1; } else st.hist[st.hi] = r;
   st.route = r; st.pendingBranch = opts.keepPending ? st.pendingBranch : null;
   render(opts.keepScroll ? null : 0);
   if (opts.scrollTo) later(function () { scrollToTurn(opts.scrollTo); }, 0);
  }
  function nav(d) { var i = st.hi + d; if (i < 0 || i >= st.hist.length) return; st.hi = i; st.route = st.hist[i]; st.peek = null; render(0); }
  function openThread(tid, turnId) {
   var t = thr(tid); if (!t) return;
   var r = { k: "page", t: tid };
   if (turnId) {
    // find the branch the turn lives in
    var u = turnOf(t, turnId), b = null;
    while (u && u.parentId) { if (u.relation === "branch") { b = b || u; if (V.branch === "toggle") st.open["br:" + u.id] = true; } u = turnOf(t, u.parentId); }
    if (b && V.branch === "subpage") r.sub = lastSubpage(t, turnId);
   }
   go(r, { scrollTo: turnId });
  }
  function lastSubpage(t, turnId) { var u = turnOf(t, turnId); while (u && u.relation !== "branch" && u.parentId) u = turnOf(t, u.parentId); return u && u.relation === "branch" ? u.id : null; }
  function scrollToTurn(id) {
   var el = root.querySelector('[data-turn="' + id + '"]'); var sc = el && el.closest(".scroll");
   if (!el || !sc) return;
   var r1 = el.getBoundingClientRect(), r2 = sc.getBoundingClientRect(), k = scale();
   sc.scrollTop += (r1.top - r2.top) / k - 60;
  }
  function scale() { var r = root.getBoundingClientRect(); return r.width / (root.offsetWidth || 1280) || 1; }
  function relPos(rect) { var r = root.getBoundingClientRect(), k = scale(); return { x: (rect.left - r.left) / k, y: (rect.top - r.top) / k, w: rect.width / k, h: rect.height / k, b: (rect.bottom - r.top) / k, r: (rect.right - r.left) / k }; }

  /* ------------------------------------------------------------ render root */
  var appEl = h("div.app"), layerEl = h("div.layer");
  root.replaceChildren(appEl, layerEl);
  root.setAttribute("tabindex", "-1");

  function render(scrollTop) {
   var sc = appEl.querySelector(".main .scroll"), keep = sc ? sc.scrollTop : 0;
   var pk = appEl.querySelector(".peek .scroll"), keepPk = pk ? pk.scrollTop : 0;
   var foc = document.activeElement, fk = foc && root.contains(foc) ? foc.getAttribute("data-fk") : null;
   var selStart = fk && foc.selectionStart != null ? foc.selectionStart : null;
   appEl.replaceChildren(renderSidebar(), renderMain());
   var sc2 = appEl.querySelector(".main .scroll"); if (sc2) sc2.scrollTop = scrollTop === 0 ? 0 : keep;
   var pk2 = appEl.querySelector(".peek .scroll"); if (pk2) pk2.scrollTop = keepPk;
   if (fk) { var f = root.querySelector('[data-fk="' + fk + '"]'); if (f) { f.focus({ preventScroll: true }); if (selStart != null && f.setSelectionRange) try { f.setSelectionRange(selStart, selStart); } catch (e) { /* noop */ } } }
   renderLayer();
  }

  /* ------------------------------------------------------------ sidebar */
  function srow(opts) {
   var row = h("div.srow" + (opts.on ? ".on" : ""), { style: "--d:" + (opts.depth || 0), onclick: opts.onclick, "data-nav": opts.nav || null, title: opts.title || null });
   if (opts.toggle != null) {
    row.append(h("span.tw", { onclick: function (e) { e.stopPropagation(); st.sideX[opts.toggle] = !st.sideX[opts.toggle]; render(); } }, svg(st.sideX[opts.toggle] ? "chevD" : "chevR", 12)));
   }
   if (opts.icon) row.append(h("span.tw", { style: "color:inherit" }, opts.icon));
   row.append(h("span.lb", { text: opts.label }));
   if (opts.badge) row.append(h("span.badge", { text: opts.badge }));
   if (opts.count != null) row.append(h("span.cnt", { text: opts.count }));
   if (opts.actions) row.append(h("span.ac", null, opts.actions));
   if (opts.ctx) row.addEventListener("contextmenu", function (e) { ctxMenu(e, opts.ctx); });
   return row;
  }
  function isOn(r) { var c = st.route; if (r.k !== c.k) return false; if (r.k === "page") return r.t === c.t && (r.sub || null) === (c.sub || null); if (r.k === "note" || r.k === "draft") return r.id === c.id; if (r.k === "db" || r.k === "hl" || r.k === "src") return r.ws === c.ws && (r.folder || null) === (r.folder != null ? st.folder : null); return true; }
  function threadRows(t, depth, keyPrefix) {
   var rows = [];
   var subs = V.branch === "subpage" ? t.turns.filter(function (u) { return u.relation === "branch" && !hasBranchAncestor(t, u); }) : [];
   var key = keyPrefix + ":" + t.id;
   rows.push(srow({ depth: depth, toggle: subs.length ? key : null, icon: threadIcon(t, 16), label: t.title, on: isOn({ k: "page", t: t.id }), nav: "page:" + t.id, ctx: t, onclick: function () { go({ k: "page", t: t.id }, { full: true }); } }));
   if (subs.length && st.sideX[key]) subs.forEach(function (u) { rows = rows.concat(subRows(t, u, depth + 1, key)); });
   return rows;
  }
  function hasBranchAncestor(t, u) { var p = turnOf(t, u.parentId); while (p) { if (p.relation === "branch") return true; p = turnOf(t, p.parentId); } return false; }
  function subRows(t, u, depth, keyPrefix) {
   var inner = []; chain(t, u).forEach(function (c) { inner = inner.concat(branchesOf(t, c)); });
   var key = keyPrefix + ":" + u.id;
   var rows = [srow({ depth: depth, toggle: inner.length ? key : null, icon: pageIcon("branch", 15), label: u.title, on: isOn({ k: "page", t: t.id, sub: u.id }), onclick: function () { go({ k: "page", t: t.id, sub: u.id }, { full: true }); } })];
   if (inner.length && st.sideX[key]) inner.forEach(function (x) { rows = rows.concat(subRows(t, x, depth + 1, key)); });
   return rows;
  }
  function renderSidebar() {
   var side = h("nav.side" + (st.sideOpen ? "" : ".hidden"));
   side.append(h("div.lights", null, h("i"), h("i"), h("i"), h("span.sp"), h("button.sbtn", { title: "Close sidebar (⌘\\)", onclick: function () { st.sideOpen = false; render(); } }, svg("collapse", 16))));
   side.append(h("div.wsw", { onclick: function (e) { wsMenu(e.currentTarget); } }, h("span.wav", { text: "R" }), h("span.nm", { text: "Raymond's Session" }), svg("chevD", 12),
    h("button.sbtn", { title: "New page", onclick: function (e) { e.stopPropagation(); newQuestion(); } }, svg("newpage", 17))));
   var sc = h("div.sscroll");
   sc.append(srow({ icon: svg("search", 16), label: "Search", onclick: openSearch, nav: "search" }));
   sc.append(srow({ icon: svg("home", 16), label: "Home", on: st.route.k === "home", onclick: function () { go({ k: "home" }); }, nav: "home" }));
   var uc = unreadCount();
   sc.append(srow({ icon: svg("inbox", 16), label: "Inbox", badge: uc ? String(uc) : null, on: st.layer && st.layer.kind === "inbox", onclick: function () { st.layer = { kind: "inbox" }; renderLayer(); render(); }, nav: "inbox" }));

   var favs = active(visible()).filter(function (t) { return t.bookmarked; });
   if (favs.length) {
    sc.append(h("div.shead", { onclick: function () { st.sideX.fav = !st.sideX.fav; render(); } }, "Favorites"));
    if (st.sideX.fav) favs.forEach(function (t) { add(sc, threadRows(t, 0, "fav")); });
   }
   sc.append(h("div.shead", null, "Workspaces"));
   wsList().forEach(function (ws) {
    var key = "ws:" + ws.id;
    sc.append(srow({ toggle: key, icon: wsIcon(ws, 18), label: ws.name, onclick: function () { st.sideX[key] = !st.sideX[key]; render(); },
     actions: [h("button.sbtn", { title: "New question in " + ws.name, onclick: function (e) { e.stopPropagation(); newQuestion(ws.id); } }, svg("plus", 14))] }));
    if (!st.sideX[key]) return;
    if (st.firstRun || ws.id === "ws-default") sc.append(srow({ depth: 1, icon: pageIcon("flag", 16, "#d44c47"), label: "Getting started", on: st.route.k === "gs", onclick: function () { go({ k: "gs" }); } }));
    var dkey = "db:" + ws.id;
    var wsThreads = active(threads.filter(function (t) { return t.workspaceId === ws.id; }));
    sc.append(srow({ depth: 1, toggle: dkey, icon: pageIcon("db", 16), label: "Research", count: wsThreads.length ? String(wsThreads.length) : null, on: st.route.k === "db" && st.route.ws === ws.id && !st.folder, onclick: function () { st.folder = null; go({ k: "db", ws: ws.id }); }, nav: "db:" + ws.id }));
    if (st.sideX[dkey]) {
     var fs = D.folders.filter(function (f) { return f.workspaceId === ws.id; });
     if (V.branch === "subpage") {
      wsThreads.slice(0, 6).forEach(function (t) { add(sc, threadRows(t, 2, "db")); });
     } else {
      fs.forEach(function (f) { sc.append(srow({ depth: 2, icon: pageIcon("filter", 14), label: f.name, on: st.route.k === "db" && st.route.ws === ws.id && st.folder === f.id, onclick: function () { st.folder = f.id; go({ k: "db", ws: ws.id }); } })); });
      var dc = drafts.filter(function (d) { return d.workspaceId === ws.id; }).length;
      if (dc) sc.append(srow({ depth: 2, icon: pageIcon("edit", 14), label: "Drafts", count: String(dc), on: st.route.k === "db" && st.route.ws === ws.id && st.folder === "drafts", onclick: function () { st.folder = "drafts"; go({ k: "db", ws: ws.id }); } }));
     }
    }
    notes.filter(function (n) { return n.workspaceId === ws.id; }).forEach(function (n) {
     sc.append(srow({ depth: 1, icon: pageIcon("page", 16), label: n.title, on: st.route.k === "note" && st.route.id === n.id, onclick: function () { go({ k: "note", id: n.id }); }, nav: "note:" + n.id }));
    });
    if (!st.firstRun) {
     sc.append(srow({ depth: 1, icon: pageIcon("marker", 16), label: "Highlights", on: st.route.k === "hl" && st.route.ws === ws.id, onclick: function () { go({ k: "hl", ws: ws.id }); } }));
     sc.append(srow({ depth: 1, icon: pageIcon("globe", 16), label: "Sources", on: st.route.k === "src" && st.route.ws === ws.id, onclick: function () { go({ k: "src", ws: ws.id }); } }));
    }
   });
   sc.append(h("div.shead", null, "Private"));
   if (!st.firstRun) sc.append(srow({ icon: pageIcon("flag", 16, "#d44c47"), label: "Getting started", on: st.route.k === "gs", onclick: function () { go({ k: "gs" }); }, nav: "gs" }));
   else sc.append(h("div.empty-s", { text: "No pages inside" }));
   side.append(sc);
   side.append(h("div.sfoot", null,
    srow({ icon: svg("agent", 16), label: "Agents", on: st.route.k === "agents", onclick: function () { go({ k: "agents" }); }, nav: "agents" }),
    srow({ icon: svg("tpl", 16), label: "Templates", onclick: function (e) { templatesMenu(e.currentTarget); } }),
    srow({ icon: svg("archive", 16), label: "Archive", on: st.route.k === "archive", onclick: function () { go({ k: "archive" }); } })));
   return side;
  }

  /* ------------------------------------------------------------ main area */
  function routeInfo(r) {
   var ws = null, crumbs = [], title = "", edited = null, page = null;
   if (r.k === "home") { crumbs = [{ icon: svg("home", 16), label: "Home" }]; }
   else if (r.k === "db") { ws = r.ws ? wsById(r.ws) : null; crumbs = (ws ? [{ icon: wsIcon(ws, 18), label: ws.name }] : []).concat([{ icon: pageIcon("db", 16), label: ws ? "Research" : "Research · all workspaces" }]); }
   else if (r.k === "page") {
    var t = thr(r.t); ws = wsById(t.workspaceId); page = t;
    crumbs = [{ icon: wsIcon(ws, 18), label: ws.name, go: { k: "db", ws: ws.id } }, { icon: pageIcon("db", 16), label: "Research", go: { k: "db", ws: ws.id } }, { icon: threadIcon(t, 16), label: t.title, go: r.sub ? { k: "page", t: t.id } : null }];
    if (r.sub) { var path = []; var u = turnOf(t, r.sub); while (u && u.parentId) { if (u.relation === "branch") path.unshift(u); u = turnOf(t, u.parentId); } path.forEach(function (b) { crumbs.push({ icon: pageIcon("branch", 15), label: b.title, go: b.id === r.sub ? null : { k: "page", t: t.id, sub: b.id } }); }); }
    edited = t.updatedAt;
   } else if (r.k === "note") { var n = notes.find(function (x) { return x.id === r.id; }); ws = wsById(n.workspaceId); crumbs = [{ icon: wsIcon(ws, 18), label: ws.name }, { icon: pageIcon("page", 16), label: n.title }]; edited = n.updatedAt; }
   else if (r.k === "gs") crumbs = [{ icon: pageIcon("flag", 16, "#d44c47"), label: "Getting started" }];
   else if (r.k === "hl") { ws = wsById(r.ws); crumbs = [{ icon: wsIcon(ws, 18), label: ws.name }, { icon: pageIcon("marker", 16), label: "Highlights" }]; }
   else if (r.k === "src") { ws = wsById(r.ws); crumbs = [{ icon: wsIcon(ws, 18), label: ws.name }, { icon: pageIcon("globe", 16), label: "Sources" }]; }
   else if (r.k === "archive") crumbs = [{ icon: svg("archive", 16), label: "Archive" }];
   else if (r.k === "agents") crumbs = [{ icon: svg("agent", 16), label: "Agents" }];
   else if (r.k === "draft") crumbs = [{ icon: pageIcon("edit", 16), label: "Draft" }];
   return { crumbs: crumbs, edited: edited, page: page };
  }
  function topbar(r, inPeek) {
   var info = routeInfo(r);
   var bar = h("div.top");
   if (inPeek) {
    bar.append(h("button.tbtn", { title: "Close (Esc)", onclick: function () { st.peek = null; render(); } }, svg("collapse", 16)));
    bar.append(h("button.tbtn", { title: "Open as full page", onclick: function () { var p = st.peek; st.peek = null; go(p, { full: true }); } }, svg("expand", 15)));
   } else {
    if (!st.sideOpen) bar.append(h("button.tbtn", { title: "Open sidebar", onclick: function () { st.sideOpen = true; render(); } }, svg("side", 16)));
    bar.append(h("button.tbtn", { title: "Back (⌘[)", disabled: st.hi === 0, onclick: function () { nav(-1); }, "data-nav": "back" }, svg("back", 16)));
    bar.append(h("button.tbtn", { title: "Forward (⌘])", disabled: st.hi >= st.hist.length - 1, onclick: function () { nav(1); } }, svg("fwd", 16)));
   }
   var cr = h("div.crumbs");
   (inPeek ? info.crumbs.slice(-1) : info.crumbs).forEach(function (c, i) {
    if (i) cr.append(h("span.crumbsep", { text: "/" }));
    var iconOnly = !inPeek && info.crumbs.length > 3 && i < 2;
    cr.append(h("button.crumb", { title: c.label, onclick: c.go ? function () { go(c.go, { full: true }); } : null }, c.icon, iconOnly ? null : h("span", { text: c.label })));
   });
   bar.append(cr);
   if (info.edited) bar.append(h("span.edited", { text: "Edited " + rel(info.edited) }));
   if (info.page || r.k === "note") {
    bar.append(h("button.tbtn.txt", { onclick: function (e) { sharePop(e.currentTarget); } }, "Share"));
    bar.append(h("button.tbtn", { title: "Comments", onclick: function () { toast("Comments are listed in the page margin. Select text and choose Comment to add one."); } }, svg("comment", 17)));
    if (info.page) bar.append(h("button.tbtn", { title: "Updates", onclick: function (e) { updatesPop(e.currentTarget, info.page); } }, svg("clock", 17)));
    if (info.page) bar.append(h("button.tbtn", { title: info.page.bookmarked ? "Remove from Favorites" : "Add to Favorites", onclick: function () { info.page.bookmarked = !info.page.bookmarked; toast(info.page.bookmarked ? "Added to Favorites" : "Removed from Favorites"); render(); } }, svg(info.page.bookmarked ? "starF" : "star", 17)));
   }
   if (!inPeek) bar.append(h("button.tbtn" + (st.panel ? ".on" : ""), { title: "Ask AI (⌘J)", onclick: togglePanel, "data-nav": "ai" }, svg("spark", 16), h("span", { text: "Ask AI", style: "font-size:14px" })));
   bar.append(h("button.tbtn", { title: "Page options", onclick: function (e) { pageMenu(e.currentTarget, r); } }, svg("more", 17)));
   return bar;
  }
  function renderMain() {
   var r = st.route;
   var main = h("div.main");
   main.append(topbar(r));
   var body = h("div.body");
   var sc = h("div.scroll");
   sc.append(renderRoute(r, false));
   body.append(sc);
   if (r.k === "page" && !r.pending && !st.panel && !st.wide) { if (st.mapPin) body.classList.add("mapped"); body.append(pageMap(thr(r.t))); sc.addEventListener("scroll", updMap); later(updMap, 0); }
   if (st.panel) body.append(renderPanel());
   main.append(body);
   if (st.peek) {
    var pk = h("div.peek");
    pk.append(topbar(st.peek, true));
    var ps = h("div.scroll"); ps.append(renderRoute(st.peek, true)); pk.append(ps);
    main.append(pk);
   }
   return main;
  }
  function renderRoute(r, inPeek) { var pg = renderRoute0(r, inPeek); return pg._wrap || pg; }
  function renderRoute0(r, inPeek) {
   if (r.k === "home") return renderHome();
   if (r.k === "db") return renderDbPage(r);
   if (r.k === "page") return renderThreadPage(thr(r.t), r.sub, inPeek);
   if (r.k === "note") return renderNote(notes.find(function (n) { return n.id === r.id; }));
   if (r.k === "gs") return renderGettingStarted();
   if (r.k === "hl") return renderHighlights(r.ws);
   if (r.k === "src") return renderSources(r.ws);
   if (r.k === "archive") return renderArchive();
   if (r.k === "agents") return renderAgentsPage();
   if (r.k === "draft") return renderDraft(r.id);
   return h("div");
  }
  function pageShell(opts) {
   var cls = "div.page" + (st.wide || opts.wide ? ".wide" : "") + (st.small ? ".small" : "") + (st.serif && opts.doc ? ".serif" : "") + (opts.dense ? ".dense" : "");
   var pg = h(cls);
   if (opts.cover) { pg._wrap = h("div", null, h("div.cover." + opts.cover), pg); pg.classList.add("hascover"); }
   if (opts.icon) pg.append(h("div.picon", null, opts.icon)); else pg.append(h("div.pplain"));
   pg.append(h("div.ptitle", { text: opts.title }));
   return pg;
  }

  /* ------------------------------------------------------------ home */
  function greeting() { var hr = new Date(nowISO()).getUTCHours(); return hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening"; }
  function renderHome() {
   var w = h("div.home");
   w.append(h("div.greet", { text: greeting() + ", " + D.user.name.split(" ")[0] }));
   w.append(h("div.homesub", null, "Ask Claude Code, Codex or Grok on this Mac. Each question becomes a page in your workspace's Research database, where you can follow up, branch and link it from notes. ", h("a.lnk", { href: "#", onclick: function (e) { e.preventDefault(); go({ k: "gs" }); } }, "Getting started")));
   w.append(composer({ key: "home", big: true, placeholder: "Ask a question. It runs on this Mac and is saved as a page in Research.", ws: true,
    hint: "Enter to ask · Shift+Enter for a new line · ⌘K to search existing research", onSend: function (q) { createThread(q, st.wsPick || defaultWs()); } }));
   // recently visited
   var rec = active(visible()).slice().sort(function (a, b) { return (b.lastViewedAt || b.updatedAt) > (a.lastViewedAt || a.updatedAt) ? 1 : -1; }).slice(0, 6);
   w.append(h("div.sec", null, svg("clock", 14), "Recently visited"));
   var rr = h("div.recent");
   rec.forEach(function (t) {
    rr.append(h("div.rcard", { onclick: function () { go({ k: "page", t: t.id }); } }, h("div.rc"), h("div.ri", null, threadIcon(t, 20)), h("div.rt", { text: t.title }),
     h("div.rd", null, h("span.dot8", { style: "background:var(--" + ({ blue: "blue2" }[STAT[t.status].c] || STAT[t.status].c) + ")" }), STAT[t.status].label + " · " + rel(t.updatedAt))));
   });
   w.append(rr);
   // attention
   var items = inbox.filter(function (i) { return visible().some(function (t) { return t.id === i.threadId; }) && i.kind !== "queued"; }).slice(0, 4);
   if (items.length) {
    w.append(h("div.sec", null, svg("bell", 14), "Needs your attention", h("span.sp"), h("button.tbtn", { style: "font-size:12.5px;height:24px", onclick: function () { st.layer = { kind: "inbox" }; render(); } }, "Open Inbox")));
    var at = h("div.att");
    items.forEach(function (i) { at.append(inboxRow(i)); });
    w.append(at);
   }
   // research linked view
   w.append(h("div.sec", { style: "margin-bottom:0" }, pageIcon("db", 14), "Research · all workspaces"));
   w.append(dbView({ ws: null, view: st.homeView || V.homeView, setView: function (v) { st.homeView = v; render(); }, compact: true, limit: 8 }));
   return w;
  }
  function inboxRow(i) {
   var t = thr(i.threadId), u = turnOf(t, i.turnId), icon = { unread: "check", failed: "alert", clarify: "q", queued: "clock" }[i.kind];
   return h("div.iitem", { onclick: function () { st.readInbox[i.id] = true; st.layer = null; openThread(t.id, u.id); } }, !st.readInbox[i.id] ? h("span.udot") : null,
    h("span.kind." + i.kind, null, icon ? svg(icon, 16) : h("span.spin")), h("div.iw", null, h("div.it", { text: i.title }), h("div.id", { text: i.detail }), h("div.ip", null, threadIcon(t, 13), h("span", { text: t.title, class: "ell" }), "· " + rel(i.createdAt))));
  }

  /* ------------------------------------------------------------ database */
  var VIEWS = [{ id: "table", label: "Table", icon: "db" }, { id: "board", label: "Board", icon: "board" }, { id: "gallery", label: "Gallery", icon: "gallery" }, { id: "list", label: "List", icon: "list" }, { id: "timeline", label: "Timeline", icon: "timeline" }];
  function dbRows(ws, folder) {
   var list = active(ws ? threads.filter(function (t) { return t.workspaceId === ws; }) : visible());
   if (folder && folder !== "drafts") list = list.filter(function (t) { return t.folderId === folder; });
   return list;
  }
  function renderDbPage(r) {
   var ws = r.ws ? wsById(r.ws) : null;
   var pg = pageShell({ title: "Research", icon: pageIcon("db", 40, "var(--text2)"), wide: true, dense: V.wide });
   pg.classList.add("dbpage");
   pg.append(h("div.lead", { text: (ws ? ws.name + " · " + ws.dir + ". " : "All workspaces. ") + "Every question you ask is a page here; Status, Provider, Model and Sources are filled in by the run." }));
   pg.append(dbView({ ws: r.ws, view: st.view, setView: function (v) { st.view = v; render(); }, folder: st.folder, group: V.group }));
   return pg;
  }
  function dbView(o) {
   var w = h("div");
   var hd = h("div.dbh");
   VIEWS.forEach(function (v) { hd.append(h("button.vt" + (o.view === v.id ? ".on" : ""), { "data-view": v.id, onclick: function () { o.setView(v.id); } }, svg(v.icon, 15), v.label)); });
   hd.append(h("span.sp"));
   hd.append(h("button.tbtn", { title: "Filter", onclick: function (e) { folderMenu(e.currentTarget, o.ws); } }, svg("filter", 16)));
   hd.append(h("button.tbtn", { title: "Sort: last edited" }, svg("sort", 16)));
   hd.append(h("button.tbtn", { title: "Search", onclick: openSearch }, svg("search", 16)));
   hd.append(h("div.newbtn", null, h("button", { onclick: function () { newQuestion(o.ws); } }, "New"), h("button", { onclick: function (e) { templatesMenu(e.currentTarget); } }, svg("chevD", 12))));
   w.append(hd);
   var folder = o.folder;
   if (!o.compact) {
    var fc = h("div.fchips");
    var f = folder && folder !== "drafts" ? folderById(folder) : null;
    fc.append(h("button.fchip" + (folder ? "" : ".off"), { onclick: function (e) { folderMenu(e.currentTarget, o.ws); } }, svg("folder", 13), folder === "drafts" ? "Drafts" : f ? "Folder: " + f.name : "Folder", folder ? h("span", { onclick: function (e) { e.stopPropagation(); st.folder = null; render(); } }, svg("x", 12)) : svg("chevD", 11)));
    fc.append(h("button.fchip.off", { class: "t3" }, svg("plus", 12), "Add filter"));
    w.append(fc);
   }
   if (folder === "drafts") { w.append(draftList(o.ws)); return w; }
   var rows = dbRows(o.ws, folder);
   if (o.limit) rows = rows.slice(0, o.limit);
   if (!rows.length) { w.append(h("div.emptydb", null, h("b", { text: "No research pages yet" }), "Ask a question from Home or press New. Each answer becomes a row here.")); return w; }
   var fn = { table: tableView, board: boardView, gallery: galleryView, list: listView, timeline: timelineView }[o.view] || tableView;
   w.append(fn(rows, o));
   return w;
  }
  function openRow(t) { go({ k: "page", t: t.id }); }
  function tableView(rows, o) {
   var cols = [
    { k: "Name", w: o.compact ? 290 : 300, icon: "text" }, { k: "Status", w: 124, icon: "status" }, { k: "Provider", w: 116, icon: "agent" }, { k: "Model", w: 112, icon: "tag" },
    { k: "Folder", w: 150, icon: "folder" }, { k: "Tags", w: 190, icon: "tag" }, { k: "Sources", w: 84, icon: "rel" }, { k: "Edited", w: 104, icon: "clock" }
   ];
   if (o.compact) cols = cols.filter(function (c) { return ["Model", "Tags", "Sources"].indexOf(c.k) < 0; });
   if (o.group) cols = cols.filter(function (c) { return c.k !== "Tags"; });
   var tb = h("div.tbl");
   var head = h("div.tr.head");
   cols.forEach(function (c) { head.append(h("div.td", { style: "width:" + c.w + "px" }, svg(c.icon, 14), c.k)); });
   tb.append(head);
   function row(t) {
    var tr = h("div.tr", { "data-row": t.id, oncontextmenu: function (e) { ctxMenu(e, t); } });
    cols.forEach(function (c) {
     var td = h("div.td", { style: "width:" + c.w + "px" });
     if (c.k === "Name") add(td, [threadIcon(t, 16), h("span.nm", { text: t.title, onclick: function () { openRow(t); } }), t.unread ? h("span.dot8", { title: "Unread" }) : null, h("button.open", { onclick: function () { openRow(t); } }, svg("expand", 11), "OPEN")]);
     else if (c.k === "Status") td.append(stPill(t.status));
     else if (c.k === "Provider") td.append(provTag(t.provider));
     else if (c.k === "Model") td.append(h("span", { text: t.model }));
     else if (c.k === "Folder") add(td, folderTag(t.folderId));
     else if (c.k === "Tags") t.tags.slice(0, 3).forEach(function (g) { td.append(tag(g)); });
     else if (c.k === "Sources") { td.className += " num"; td.append(String(srcCount(t))); }
     else if (c.k === "Edited") td.append(h("span", { class: "t2", text: rel(t.updatedAt) }));
     tr.append(td);
    });
    return tr;
   }
   if (o.group) GROUPS.forEach(function (g) {
    var list = rows.filter(function (t) { return g.st.indexOf(t.status) >= 0; }), key = "grp:" + g.id, shut = st.open[key];
    tb.append(h("div.tgrp", { onclick: function () { st.open[key] = !shut; render(); } }, h("span.tgb" + (shut ? "" : ".open"), null, svg("tri", 11)), h("span.st.c-" + g.c, null, h("i"), g.label), h("span", { class: "t3", text: String(list.length) }), h("span", { style: "color:var(--text3);font-size:12.5px", text: g.hint })));
    if (!shut) list.forEach(function (t) { tb.append(row(t)); });
   });
   else rows.forEach(function (t) { tb.append(row(t)); });
   tb.append(h("div.tr.foot", { onclick: function () { newQuestion(o.ws); } }, h("div.td", { style: "width:300px;border:0;gap:6px" }, svg("plus", 14), "New")));
   return tb;
  }
  function boardView(rows) {
   var b = h("div.board");
   GROUPS.forEach(function (g) {
    var list = rows.filter(function (t) { return g.st.indexOf(t.status) >= 0; });
    var col = h("div.bcol", { style: "background:color-mix(in srgb,var(--" + g.c + "-bg) var(--colmix),transparent)" });
    col.append(h("div.bh", null, h("span.st.c-" + g.c, null, h("i"), g.label), h("span.n", { text: String(list.length) })));
    list.forEach(function (t) {
     col.append(h("div.bcard", { onclick: function () { openRow(t); }, oncontextmenu: function (e) { ctxMenu(e, t); } },
      h("div.bt", null, threadIcon(t, 16), h("span", { text: t.title })),
      h("div.bp", null, g.st.length > 1 ? stPill(t.status) : null, provTag(t.provider), h("span", { text: t.model })),
      h("div.bp", null, folderTag(t.folderId), h("span", { text: rel(t.updatedAt) }), t.unread ? h("span.dot8", { style: "margin-left:auto", title: "Unread" }) : null)));
    });
    col.append(h("button.bnew", { onclick: function () { newQuestion(); } }, svg("plus", 14), "New"));
    b.append(col);
   });
   return b;
  }
  function galleryView(rows) {
   var g = h("div.gal");
   rows.forEach(function (t) {
    var r0 = rootTurn(t), first = (r0.answer[0] || (r0.post ? r0.post.linkTitle : "") || r0.question);
    g.append(h("div.gcard", { onclick: function () { openRow(t); }, oncontextmenu: function (e) { ctxMenu(e, t); } },
     h("div.gprev", null, h("b", { text: plain(r0.question).slice(0, 90) }), plain(first).slice(0, 320)),
     h("div.gbody", null, h("div.bt", null, threadIcon(t, 16), h("span", { text: t.title })), h("div.bp", null, stPill(t.status), provTag(t.provider), h("span", { text: rel(t.updatedAt) })))));
   });
   return g;
  }
  function listView(rows) {
   var l = h("div", { style: "margin-top:4px" });
   rows.forEach(function (t) {
    l.append(h("div.lrow", { onclick: function () { openRow(t); }, oncontextmenu: function (e) { ctxMenu(e, t); } }, threadIcon(t, 16), h("span.lt", { text: t.title }), t.unread ? h("span.dot8") : null, folderTag(t.folderId), stPill(t.status), h("span.lm", { text: PROV[t.provider].label + " · " + t.model }), h("span.lm", { style: "width:64px;text-align:right", text: rel(t.updatedAt) })));
   });
   return l;
  }
  function timelineView(rows) {
   var start = new Date("2026-10-05T00:00:00Z").getTime(), DAY = 86400000, PX = 104, days = 8, W = days * PX;
   var w = h("div.tl"), inner = h("div.tlin", { style: "height:" + (44 + rows.length * 36 + 8) + "px;width:" + W + "px" });
   var hd = h("div.tlhead");
   var today = Math.floor((new Date(D.now).getTime() - start) / DAY);
   for (var i = 0; i < days; i++) {
    var d = new Date(start + i * DAY);
    hd.append(h("div.tlday" + (i === today ? ".today" : ""), { style: "width:" + PX + "px", text: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()] + " " + d.getUTCDate() }));
    inner.append(h("div.tlgrid", { style: "left:" + (i * PX) + "px" }));
   }
   inner.append(hd);
   inner.append(h("div.tlnow", { style: "left:" + ((new Date(D.now).getTime() - start) / DAY * PX) + "px" }));
   rows.forEach(function (t, i) {
    var a = Math.max(0, (new Date(t.createdAt).getTime() - start) / DAY * PX), b = Math.min(W - 2, (new Date(t.updatedAt).getTime() - start) / DAY * PX);
    var width = Math.max(14, b - a), top = 42 + i * 36;
    var c = STAT[t.status].c;
    inner.append(h("div.tlbar", { title: t.title, style: "left:" + a + "px;top:" + top + "px;width:" + width + "px;padding:0;background:var(--" + c + "-bg)", onclick: function () { openRow(t); } }));
    var right = a + width + 8, label = h("div.tlbar", { style: "top:" + top + "px;box-shadow:none;background:none;max-width:360px;padding:0 4px;" + (right + 260 > W ? "right:" + (W - a + 8) + "px" : "left:" + right + "px"), onclick: function () { openRow(t); } },
     threadIcon(t, 14), h("span", { text: t.title, class: "ell" }), stPill(t.status));
    inner.append(label);
   });
   w.append(inner);
   return w;
  }
  function draftList(ws) {
   var l = h("div", { style: "margin-top:4px" });
   var ds = drafts.filter(function (d) { return !ws || d.workspaceId === ws; });
   if (!ds.length) l.append(h("div.emptydb", null, h("b", { text: "No drafts" }), "Unsent questions are kept here."));
   ds.forEach(function (d) { l.append(h("div.lrow", { onclick: function () { go({ k: "draft", id: d.id }); } }, pageIcon("edit", 16, "var(--text3)"), h("span.lt", { text: d.prompt }), provTag(d.provider), h("span.lm", { text: "Draft · " + rel(d.updatedAt) }))); });
   return l;
  }

  /* ------------------------------------------------------------ thread page */
  function renderThreadPage(t, subId, inPeek) {
   var sub = subId ? turnOf(t, subId) : null;
   var pg = pageShell({ title: sub ? sub.title : t.title, icon: sub ? pageIcon("branch", 52, "var(--text2)") : threadIcon(t, 56), doc: true });
   if (inPeek) pg.querySelector(".picon").style.marginTop = "24px";
   var pv = function (label, icon, val) { return h("div.prow", null, h("div.pk", null, svg(icon, 15), label), h("div.pv", null, val)); };
   if (sub) {
    var parent = turnOf(t, sub.parentId);
    pg.append(h("div.props", null,
     pv("Branch of", "rel", mention(t, parent, function () { go(lastSubpage(t, parent.id) ? { k: "page", t: t.id, sub: lastSubpage(t, parent.id) } : { k: "page", t: t.id }, { full: true, scrollTo: parent.id }); })),
     pv("Status", "status", stPill(sub.status)),
     pv("Agent", "agent", [provTag(sub.provider), h("span", { text: sub.model + (sub.effort ? " · " + sub.effort : "") })]),
     pv("Created", "cal", h("span", { text: fmtDT(sub.createdAt) }))));
   } else {
    var bl = backlinks(t);
    var links = t.links.map(thr).filter(Boolean);
    var pkey = "props:" + t.id, more = !!st.open[pkey];
    var extra = [pv("Tags", "tag", t.tags.length ? t.tags.map(function (g) { return tag(g); }) : h("span.muted", { text: "Empty" })),
     pv("Sources", "rel", srcCount(t) ? h("span.mention", { onclick: function () { go({ k: "src", ws: t.workspaceId }); } }, svg("globe", 14), h("u", { text: srcCount(t) + " sources" })) : h("span.muted", { text: "None" })),
     pv("Related", "link", links.length ? links.map(function (o) { return mention(o); }) : h("span.muted", { text: "Empty" })),
     pv("Created", "cal", h("span", { text: fmtDT(t.createdAt) + " · " + t.turns.length + (t.turns.length === 1 ? " question" : " questions") }))];
    pg.append(h("div.props", null,
     pv("Status", "status", stPill(t.status)),
     pv("Agent", "agent", [provTag(t.provider), h("span", { text: t.model + (t.effort ? " · " + t.effort + " effort" : "") })]),
     pv("Folder", "folder", folderTag(t.folderId) || h("span.muted", { text: "Unfiled" })),
     more ? extra : null,
     h("button.addprop", { "data-more": t.id, onclick: function () { st.open[pkey] = !more; render(); } }, svg(more ? "chevD" : "chevR", 13), more ? "Hide properties" : extra.length + " more properties: Tags, Sources, Related, Created")));
    var meta = h("div.pmeta");
    meta.append(h("button.tbtn", { onclick: function () { st.showBacklinks[t.id] = !st.showBacklinks[t.id]; render(); } }, svg("rel", 14), bl.length + " backlink" + (bl.length === 1 ? "" : "s")));
    meta.append(h("button.tbtn", { onclick: function () { toast("Select text in an answer and choose Comment."); } }, svg("comment", 14), "Add comment"));
    if (t.turns.length > 1) meta.append(h("button.tbtn", { "data-pin": "1", title: "Show the page map", onclick: function () { st.mapPin = !st.mapPin; st.panel = false; render(); } }, svg("branch", 14), treeSummary(t)));
    pg.append(meta);
    if (st.showBacklinks[t.id]) pg.append(h("div", { style: "margin:0 0 6px 4px;display:flex;flex-direction:column;gap:2px;font-size:14px" }, bl.map(function (b) { return h("span.mention", { style: "width:max-content", onclick: function () { b.kind === "note" ? go({ k: "note", id: b.id }) : go({ k: "page", t: b.id }); } }, svg(b.kind === "note" ? "page" : "spark", 14), h("u", { text: b.title })); })));
   }
   pg.append(h("div.hr"));
   var blocks = h("div.blocks");
   if (!sub && t.recap) {
    blocks.append(h("div.callout", null, h("span", { style: "color:var(--purple);margin-top:2px" }, svg("spark", 18)), h("div.cbody", null, h("div.ct", { text: "Recap" }), h("div", { text: t.recap }),
     h("div", { style: "font-size:12.5px;color:var(--text3);margin-top:4px;font-family:var(--font)" }, "Generated by " + PROV[t.provider].label + " · " + t.model + " · ", h("a.lnk", { href: "#", onclick: function (e) { e.preventDefault(); toast("Recap regenerated (mock)."); } }, "Regenerate")))));
   }
   if (sub) {
    if (sub.anchor) blocks.append(h("div.quote", { style: "color:var(--anchor)" }, h("span", { class: "t2" }, md(sub.anchor.quote))));
    chain(t, sub).forEach(function (u) { blocks.append(exchange(t, u, 0)); });
   } else {
    chain(t, rootTurn(t)).forEach(function (u) { blocks.append(exchange(t, u, 0)); });
   }
   pg.append(blocks);
   if (V.chat === "inline" || inPeek) {
    var last = (sub ? chain(t, sub) : chain(t, rootTurn(t))).slice(-1)[0];
    pg.append(threadComposer(t, last, sub));
   } else {
    pg.append(h("div.addprop", { style: "margin-top:18px", onclick: function () { focusPanel(); } }, svg("spark", 14), "Ask a follow-up or branch in the AI panel  ⌘J"));
   }
   return pg;
  }
  function treeItems(t) {
   var items = [];
   (function walk(u, d) { chain(t, u).forEach(function (x) { items.push([x, d]); branchesOf(t, x).forEach(function (b) { walk(b, d + 1); }); }); })(rootTurn(t), 0);
   return items;
  }
  function treeSummary(t) {
   var b = t.turns.filter(function (x) { return x.relation === "branch"; }).length, f = t.turns.filter(function (x) { return x.relation === "followup"; }).length;
   return t.turns.length + (t.turns.length === 1 ? " question" : " questions") + " · " + f + (f === 1 ? " follow-up" : " follow-ups") + " · " + b + (b === 1 ? " branch" : " branches");
  }
  function pageMap(t) {
   var m = h("nav.pmap" + (st.mapPin ? ".pin" : ""), null, h("div.pmh", null, "On this page", h("button.tbtn", { title: st.mapPin ? "Unpin" : "Pin open", onclick: function () { st.mapPin = !st.mapPin; render(); } }, svg(st.mapPin ? "x" : "expand", 12))));
   treeItems(t).forEach(function (it) {
    var u = it[0], c = u.status !== "done" ? "color:var(" + DOTC[STAT[u.status].c] + ");" : "";
    m.append(h("button.pmi", { "data-mt": u.id, style: c + "--dp:" + it[1] + ";--lw:" + (18 - Math.min(it[1], 2) * 5) + "px", title: u.title + (c ? " · " + STAT[u.status].label : ""), onclick: function () { openThread(t.id, u.id); } },
     u.relation === "branch" ? svg("branch", 12) : null, h("i.pmd"), h("span.pmt", { text: u.title })));
   });
   m.append(h("div.pmf", { text: treeSummary(t) }));
   return m;
  }
  function updMap() {
   var sc = appEl.querySelector(".main > .body > .scroll"), map = appEl.querySelector(".pmap"); if (!sc || !map) return;
   var top = sc.getBoundingClientRect().top, k = scale(), cur = null;
   sc.querySelectorAll("[data-turn]").forEach(function (e) { if (!cur || (e.getBoundingClientRect().top - top) / k < 160) cur = e.getAttribute("data-turn"); });
   map.querySelectorAll(".pmi").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-mt") === cur); });
  }
  function threadComposer(t, last, sub) {
   var running = t.turns.some(function (u) { return u.status === "running"; });
   var mode = st.mode;
   return composer({
    key: "page:" + t.id + ":" + (sub ? sub.id : ""), placeholder: mode === "branch" ? "Ask in a new branch from the last answer…" : "Ask a follow-up…",
    modes: true, agentFrom: last,
    hint: (running ? "An answer is running in this thread. A follow-up sent now is queued and starts when it finishes. " : "") + (mode === "branch" ? "Branch: a new " + (V.branch === "toggle" ? "toggle" : "sub-page") + " with this conversation as context; this conversation is unchanged." : "Follow-up: continues this conversation below the last answer."),
    onSend: function (q) { if (st.mode === "branch") addBranch(t, last, null, q); else addFollowup(t, last, q); }
   });
  }
  function exchange(t, u, depth) {
   var el = h("div.ex", { "data-turn": u.id, "data-live": u.id });
   el._build = function () { return exchange(t, u, depth); };
   // question
   var qm = [fmtDT(u.createdAt)];
   if (u.relation === "followup") qm.push("Follow-up");
   el.append(h("div.qb", null, h("span.av", { text: D.user.initials }), h("div.qtext", null, u.post ? h("span", null, "Saved link: ", h("a.lnk", { href: "#", onclick: function (e) { e.preventDefault(); } }, u.post.linkTitle)) : md(u.question), h("div.qmeta", { text: qm.join(" · ") + (u.post ? " · " + u.post.domain + " · " + u.post.author : "") }))));
   if (u.post && !u.answer.length) return el;
   // answer header
   var acts = h("span.acts", null,
    h("button.tbtn", { title: "Copy answer as Markdown", onclick: function () { toast("Answer copied as Markdown"); } }, svg("copy", 14)),
    h("button.tbtn", { title: "Branch from the whole answer", disabled: u.status === "running", onclick: function () { startPendingBranch(t, u, null, null); } }, svg("branch", 14), "Branch"),
    h("button.tbtn", { title: "More", onclick: function (e) { answerMenu(e.currentTarget, t, u); } }, svg("more", 14)));
   el.append(h("div.ah", null, h("span", { class: "pu" }, svg("spark", 15)), h("span", { style: "color:var(--text);font-weight:500" }, PROV[u.provider].label), h("span", { text: u.model + (u.effort ? " · " + u.effort : "") }),
    u.status === "done" && u.durationSec ? h("span", { text: "· " + dur(u.durationSec) }) : null, u.status !== "done" ? stPill(u.status) : null, h("span.sp"), acts));
   // run state
   if (u.status === "running") {
    var lastStep = u.activity.slice(-1)[0];
    el.append(h("div.runline", null, h("span.spin"), h("span.shim", { text: lastStep ? lastStep.label + (lastStep.detail ? " · " + lastStep.detail : "") : "Starting " + PROV[u.provider].label + "…" }), h("span", { style: "font-family:var(--mono);font-size:12px", "data-el": t.id + "|" + u.id, text: dur(elapsed(u)) }),
     h("button.btn.sm", { onclick: function () { stopRun(t, u); } }, svg("stop", 12), "Stop")));
   }
   if (u.status === "queued") {
    el.append(h("div.callout", null, svg("clock", 18), h("div.cbody", null, h("div.ct", { text: "Queued" }), h("div", { style: "font-size:.94em", text: "Starts when the running answer in this conversation finishes. One answer runs at a time per conversation." }),
     h("div", { style: "display:flex;gap:6px;margin-top:8px" }, h("button.btn.sm", { onclick: function () { t.turns = t.turns.filter(function (x) { return x !== u; }); render(); } }, "Remove"), h("button.btn.sm", { onclick: function () { toast("Edit the queued question (mock)."); } }, "Edit question")))));
   }
   if (u.status === "failed") {
    el.append(h("div.callout.red", null, h("span", { style: "color:var(--red)" }, svg("alert", 18)), h("div.cbody", null, h("div.ct", { text: "Run failed" }), h("div", { style: "font-family:var(--mono);font-size:12.5px;word-break:break-word", text: u.error || "Unknown error" }),
     h("div", { style: "display:flex;gap:6px;margin-top:8px" }, h("button.btn.sm", { onclick: function () { retry(t, u); } }, "Retry"), h("button.btn.sm", { onclick: function () { st.open["log:" + u.id] = true; render(); } }, "Show run log")))));
   }
   // paragraphs
   var ab = h("div.ab");
   var anchored = {};
   branchesOf(t, u).forEach(function (b) { var p = b.anchor && b.anchor.turnId === u.id ? b.anchor.paragraph : -1; (anchored[p] = anchored[p] || []).push(b); });
   u.answer.forEach(function (para, i) {
    var blk = h("div.blk", { "data-p": i, "data-turnid": u.id });
    blk.append(h("div.hdl", null, h("button", { title: "Branch from this paragraph", onclick: function () { startPendingBranch(t, u, i, plain(para).slice(0, 140)); } }, svg("plus", 16)), h("button", { title: "Drag or click for options", onclick: function (e) { paraMenu(e.currentTarget, t, u, i); } }, svg("drag", 16))));
    blk.append(/^```/.test(para) ? h("pre.codeblk", { text: para.replace(/^```\w*\n?/, "").replace(/\n?```\s*$/, "") }) : h("p", null, markedPara(t, u, i, para)));
    var hls = u.highlights.filter(function (x) { return x.paragraph === i && x.note; });
    if (hls.length) blk.append(h("button.cmt", { title: "Comments", onclick: function (e) { commentPop(e.currentTarget, hls); } }, svg("comment", 14), String(hls.length)));
    if (u.status === "running" && i === u.answer.length - 1) add(blk.querySelector("p"), h("span.caret"));
    ab.append(blk);
    (anchored[i] || []).forEach(function (b) { ab.append(branchBlock(t, b, depth)); });
    if (st.pendingBranch && st.pendingBranch.turnId === u.id && st.pendingBranch.paragraph === i && V.branch === "toggle") ab.append(pendingToggle(t));
   });
   if (u.clarification) {
    ab.append(h("div.callout.yellow", null, h("span", { style: "color:var(--yellow)" }, svg("q", 18)), h("div.cbody", null, h("div.ct", { text: PROV[u.provider].label + " is waiting for your answer" }), h("div", { text: u.clarification }),
     composer({ key: "clar:" + u.id, placeholder: "Reply to continue the run…", compact: true, onSend: function (q) { u.clarification = null; u.status = "done"; t.status = threadStatus(t); addFollowup(t, chain(t, u).slice(-1)[0], q); } }))));
   }
   (anchored[-1] || []).concat(Object.keys(anchored).filter(function (k) { return +k >= u.answer.length; }).reduce(function (a, k) { return a.concat(anchored[k]); }, [])).forEach(function (b) { ab.append(branchBlock(t, b, depth)); });
   if (st.pendingBranch && st.pendingBranch.turnId === u.id && st.pendingBranch.paragraph == null && V.branch === "toggle") ab.append(pendingToggle(t));
   el.append(ab);
   // sources + run log
   if (u.sources.length || u.activity.length) {
    var mr = h("div.meta-row");
    u.sources.forEach(function (s) { mr.append(h("button.srcchip", { title: s.url, onclick: function () { toast("Opens " + s.domain + " in the browser pane"); } }, h("b", { text: s.domain[0].toUpperCase() }), h("span", { text: s.title }))); });
    el.append(mr);
   }
   if (u.activity.length) {
    var key = "log:" + u.id, open = !!st.open[key];
    var total = u.activity.reduce(function (a, s) { return a + s.ms; }, 0);
    var tg = h("div.tgl.small", null, h("button.tgb" + (open ? ".open" : ""), { onclick: function () { st.open[key] = !open; render(); } }, svg("tri", 12)),
     h("div", { style: "flex:1;min-width:0" }, h("div.tgh", { onclick: function () { st.open[key] = !open; render(); } }, "Run log · " + u.activity.length + " steps" + (u.status === "running" ? " · running" : " · " + dur(u.durationSec || total / 1000))),
      open ? h("div.steps", { style: "margin-left:0" }, u.activity.map(stepRow)) : null));
    el.append(tg);
   }
   return el;
  }
  function stepRow(s) {
   var ic = { think: "spark", read: "page", grep: "search", search: "search", fetch: "globe", run: "term", edit: "edit" }[s.kind] || "term";
   return h("div.step" + (s.status === "error" ? ".err" : ""), null, s.status === "running" ? h("span.spin") : svg(ic, 14), h("span.sl", { text: s.label }), s.detail ? h("span.sd", { text: s.detail }) : null, h("span.sd", { text: s.status === "running" ? "…" : s.ms >= 1000 ? (s.ms / 1000).toFixed(1) + "s" : s.ms + "ms" }));
  }
  function markedPara(t, u, i, para) {
   var marks = [];
   u.highlights.forEach(function (x) { if (x.paragraph !== i) return; var at = para.indexOf(x.quote); if (at >= 0) marks.push({ a: at, b: at + x.quote.length, cls: "hl hl-" + (x.color || "amber"), title: x.note || "Highlight", hl: x }); });
   branchesOf(t, u).forEach(function (b) { if (!b.anchor || b.anchor.paragraph !== i) return; var at = para.indexOf(b.anchor.quote); if (at >= 0) marks.push({ a: at, b: at + b.anchor.quote.length, cls: "anc", title: "Branch: " + b.title, br: b }); });
   marks.sort(function (x, y) { return x.a - y.a; });
   var out = [], pos = 0;
   marks.forEach(function (m) {
    if (m.a < pos) return;
    if (m.a > pos) out = out.concat(md(para.slice(pos, m.a)));
    var sp = h("span", { class: m.cls, title: m.title }, md(para.slice(m.a, m.b)));
    if (m.hl) sp.addEventListener("click", function () { if (!getSelection().isCollapsed) return; hlPop(sp, t, u, m.hl); });
    if (m.br) sp.addEventListener("click", function () { if (V.branch === "toggle") { st.open["br:" + m.br.id] = !st.open["br:" + m.br.id]; render(); } else go({ k: "page", t: t.id, sub: m.br.id }, { full: true }); });
    out.push(sp); pos = m.b;
   });
   if (pos < para.length) out = out.concat(md(para.slice(pos)));
   return out;
  }
  function branchCount(t, b) { return chain(t, b).length; }
  function branchBlock(t, b, depth) {
   var n = branchCount(t, b);
   var meta = (b.anchor ? "from ¶" + (b.anchor.paragraph + 1) : "from the whole answer") + " · " + n + " question" + (n === 1 ? "" : "s");
   if (V.branch === "subpage") {
    return h("div.plink", { "data-branch": b.id, onclick: function () { go({ k: "page", t: t.id, sub: b.id }, { full: true }); } }, pageIcon("branch", 17, "var(--text2)"), h("u", { text: b.title }), h("span.brmeta", { text: "Branch " + meta }), b.status !== "done" ? stPill(b.status) : null);
   }
   var key = "br:" + b.id, open = !!st.open[key];
   var w = h("div.branchwrap" + (open ? ".open" : ""), { "data-branch": b.id });
   w.append(h("div.tgl", null, h("button.tgb" + (open ? ".open" : ""), { onclick: function () { st.open[key] = !open; render(); } }, svg("tri", 12)),
    h("div.tgh", { onclick: function () { st.open[key] = !open; render(); } }, h("span", { style: "color:var(--blue2)" }, svg("branch", 15)), h("span.brh", { text: b.title }), h("span.brmeta", { text: "Branch " + meta }), b.status !== "done" ? stPill(b.status) : null)));
   if (open) {
    var body = h("div.tgbody");
    chain(t, b).forEach(function (u) { body.append(exchange(t, u, depth + 1)); });
    w.append(body);
   }
   return w;
  }
  function pendingToggle(t) {
   var pb = st.pendingBranch;
   var w = h("div.branchwrap.open");
   w.append(h("div.tgl", null, h("button.tgb.open", null, svg("tri", 12)), h("div.tgh", null, h("span", { style: "color:var(--blue2)" }, svg("branch", 15)), h("span.brh", { text: "New branch" }), h("span.brmeta", { text: pb.paragraph != null ? "from ¶" + (pb.paragraph + 1) : "from the whole answer" }))));
   w.append(h("div.tgbody", null, composer({ key: "pending", autofocus: true, quote: pb.quote, placeholder: "Ask about this passage. The main conversation is unchanged.", agentFrom: turnOf(t, pb.turnId),
    hint: "Esc to cancel", onSend: function (q) { var u = turnOf(t, pb.turnId); st.pendingBranch = null; addBranch(t, u, pb.paragraph != null ? { turnId: u.id, paragraph: pb.paragraph, quote: pb.quote } : null, q); }, onCancel: function () { st.pendingBranch = null; render(); } })));
   return w;
  }
  function startPendingBranch(t, u, i, quote) {
   if (u.status === "running") { toast("Wait for the answer to finish before branching from it."); return; }
   if (V.branch === "toggle" && V.chat === "inline") { st.pendingBranch = { t: t.id, turnId: u.id, paragraph: i, quote: quote }; render(); later(function () { var c = root.querySelector('[data-fk="pending"]'); if (c) c.focus(); }, 0); return; }
   st.pendingBranch = { t: t.id, turnId: u.id, paragraph: i, quote: quote };
   if (V.chat === "panel") { st.mode = "branch"; st.panel = true; render(); focusPanel(); return; }
   // sub-page variant: open an untitled sub-page with the composer
   go({ k: "page", t: t.id, sub: null, pending: true }, { keepPending: true });
  }

  /* ------------------------------------------------------------ composer */
  function composer(o) {
   var key = o.key;
   var agent = st.agentFor && st.agentFor[key] ? st.agentFor[key] : (o.agentFrom ? { provider: o.agentFrom.provider, model: o.agentFrom.model, effort: o.agentFrom.effort } : st.agent);
   var ready = Object.keys(st.agents).some(function (k) { return st.agents[k] === "ready"; });
   var c = h("div.comp" + (o.big ? ".big" : ""));
   if (o.quote) c.append(h("div.quoted", null, md(o.quote)));
   var ta = h("textarea", { rows: 1, placeholder: o.placeholder || "Ask AI anything…", "data-fk": key });
   ta.value = st.text[key] || "";
   var send = h("button.send", { title: "Ask (Enter)", disabled: !ta.value.trim() }, svg("up", 16));
   function grow() { ta.style.height = "auto"; ta.style.height = Math.min(180, ta.scrollHeight) + "px"; }
   ta.addEventListener("input", function () { st.text[key] = ta.value; send.disabled = !ta.value.trim(); grow(); });
   function doSend() {
    var q = ta.value.trim(); if (!q) return;
    if (!ready) { toast("Connect an agent first: open Agents in the sidebar."); return; }
    st.text[key] = ""; ta.value = "";
    st.agent = agent;
    o.onSend(q, agent);
   }
   ta.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); }
    else if (e.key === "Escape" && o.onCancel) { e.preventDefault(); o.onCancel(); }
   });
   send.addEventListener("click", doSend);
   c.append(h("div.crow", null, h("span.spk", null, svg("spark", 18)), ta));
   var bar = h("div.cbar");
   if (o.modes) {
    bar.append(h("button.chip" + (st.mode === "followup" ? ".on" : ""), { "data-mode": "followup", title: "Continue this conversation", onclick: function () { st.mode = "followup"; render(); } }, svg("cont", 14), "Follow-up"));
    bar.append(h("button.chip" + (st.mode === "branch" ? ".on" : ""), { "data-mode": "branch", title: "Start a branch with this conversation as context", onclick: function () { st.mode = "branch"; render(); } }, svg("branch", 13), "Branch"));
   }
   if (o.ws) {
    var ws = wsById(st.wsPick || defaultWs());
    bar.append(h("button.chip", { title: "Workspace for the new page", onclick: function (e) { wsPickMenu(e.currentTarget); } }, wsIcon(ws, 14), ws.name, svg("chevD", 11)));
   }
   bar.append(h("button.chip", { title: "Agent and model (follow-ups inherit this)", onclick: function (e) { agentMenu(e.currentTarget, key, agent); } }, h("span.pdot", { style: "background:" + PROV[agent.provider].hex }), (o.short ? "" : PROV[agent.provider].label + " · ") + agent.model + (agent.effort ? " · " + agent.effort : ""), svg("chevD", 11)));
   bar.append(h("span.sp"));
   bar.append(send);
   c.append(bar);
   if (o.hint) c.append(h("div.chint", { text: o.hint }));
   if (o.suggest) c.append(h("div.sugg", null, o.suggest.map(function (s) { return h("button", { onclick: function () { st.text[key] = s; ta.value = s; send.disabled = false; ta.focus(); } }, s); })));
   if (o.autofocus) later(function () { ta.focus({ preventScroll: true }); }, 0);
   later(grow, 0);
   return c;
  }
  function defaultWs() { if (st.firstRun) return "ws-default"; var r = st.route; if (r.k === "page") return thr(r.t).workspaceId; if (r.ws) return r.ws; if (r.k === "note") return notes.find(function (n) { return n.id === r.id; }).workspaceId; return "ws-compilers"; }

  /* ------------------------------------------------------------ runs (mock) */
  function mkTurn(t, parent, relation, q, agent, anchor) {
   var id = t.id + "x" + (++st.created);
   var title = plain(q).replace(/\s+/g, " ").slice(0, 52) + (q.length > 52 ? "…" : "");
   var u = { id: id, parentId: parent ? parent.id : null, relation: relation, anchor: anchor || null, question: q, title: title, provider: agent.provider, model: agent.model, effort: agent.effort,
    status: "queued", createdAt: nowISO(), completedAt: null, durationSec: null, starred: false, recap: null, answer: [], error: null, sources: [], activity: [], highlights: [], _mock: true };
   t.turns.push(u); t.updatedAt = nowISO();
   return u;
  }
  function busy(t) { return t.turns.some(function (u) { return u.status === "running"; }); }
  function addFollowup(t, last, q) {
   var u = mkTurn(t, last, "followup", q, agentFor("page:" + t.id + ":" + (st.route.sub || ""), last));
   if (!busy(t)) startRun(t, u); else toast("Queued. It starts when the running answer finishes.");
   render(); later(function () { scrollToTurn(u.id); }, 0);
  }
  function addBranch(t, parent, anchor, q) {
   var u = mkTurn(t, parent, "branch", q, agentFor("pending", parent), anchor);
   if (!busy(t)) startRun(t, u); else toast("Queued. It starts when the running answer finishes.");
   st.mode = "followup";
   if (V.branch === "toggle") { st.open["br:" + u.id] = true; render(); later(function () { scrollToTurn(u.id); }, 0); }
   else if (V.chat === "panel") render();
   else go({ k: "page", t: t.id, sub: u.id }, { full: true });
  }
  function agentFor(key, from) { return (st.agentFor && st.agentFor[key]) || (from ? { provider: from.provider, model: from.model, effort: from.effort } : st.agent); }
  function createThread(q, ws, opts) {
   opts = opts || {};
   var agent = opts.agent || st.agent;
   var id = "new" + (++st.created);
   var t = { id: id, workspaceId: ws, folderId: null, kind: "exchange", title: plain(q).replace(/\s+/g, " ").slice(0, 60) + (q.length > 60 ? "…" : ""), provider: agent.provider, model: agent.model, effort: agent.effort,
    status: "running", createdAt: nowISO(), updatedAt: nowISO(), lastViewedAt: nowISO(), unread: false, bookmarked: false, followed: false, archivedAt: null, recap: null, tags: [], links: [], rootTurnId: null, turns: [] };
   threads.unshift(t);
   var u = mkTurn(t, null, "root", q, agent, null); t.rootTurnId = u.id;
   startRun(t, u);
   st.checks.ask = true;
   if (!opts.stay) go({ k: "page", t: t.id }, { full: true }); else render();
   return t;
  }
  function mockSteps(t, u) {
   var ws = wsById(t.workspaceId);
   return [
    { kind: "think", label: "Planned: read the question and the earlier answers on this page", ms: 900, status: "ok" },
    { kind: "grep", label: "Searched code in " + ws.dir, detail: "6 matches", ms: 340, status: "ok" },
    { kind: "read", label: "Read the two files with the most matches", ms: 260, status: "ok" }
   ];
  }
  function mockAnswer(t, u) {
   var p = PROV[u.provider].label;
   return [
    "This is a simulated answer. In Session, " + p + " (" + u.model + ") runs on this Mac with the conversation above as context; its tool calls are recorded in the run log below and any links it cites are listed as sources.",
    u.relation === "branch" ? "Because this is a branch, the main conversation is unchanged. Follow-ups typed inside this branch stay here, and the branch is listed under the paragraph it started from." : "To keep part of this answer, select the text and choose Highlight; to ask about one detail without changing this conversation, use + next to a paragraph to start a branch."
   ];
  }
  function startRun(t, u) {
   u.status = "running"; u.activity = []; u.answer = []; t.status = "running"; t.updatedAt = nowISO();
   var steps = mockSteps(t, u), words = mockAnswer(t, u).map(function (p) { return p.split(" "); });
   var tick = 0, si = 0, pi = 0, wi = 0;
   var run = { t0: Date.now() };
   runs[u.id] = run;
   run.timer = setInterval(function () {
    tick++;
    if (si < steps.length) {
     if (tick % 6 === 1) { var s = Object.assign({}, steps[si]); u.activity.push(s); si++; refresh(u.id); }
     return;
    }
    if (pi < words.length) {
     if (wi === 0) u.answer.push("");
     var n = Math.min(words[pi].length, wi + 3);
     u.answer[pi] = words[pi].slice(0, n).join(" ");
     wi = n;
     if (wi >= words[pi].length) { pi++; wi = 0; }
     refresh(u.id);
     return;
    }
    finishRun(t, u);
   }, 55);
  }
  function finishRun(t, u, stopped) {
   var run = runs[u.id]; if (!run) return;
   clearInterval(run.timer); delete runs[u.id];
   u.status = stopped ? "failed" : "done"; if (stopped) u.error = "Stopped by you.";
   u.completedAt = nowISO(); u.durationSec = Math.max(1, Math.round((Date.now() - run.t0) / 1000));
   t.updatedAt = nowISO(); t.status = threadStatus(t);
   var next = t.turns.find(function (x) { return x.status === "queued" && x._mock; });
   if (next && !stopped) startRun(t, next);
   render();
  }
  function stopRun(t, u) { if (runs[u.id]) finishRun(t, u, true); else toast("This run belongs to the sample data and cannot be stopped in the mock."); }
  function retry(t, u) { u.error = null; startRun(t, u); render(); }
  function refresh(id) {
   root.querySelectorAll('[data-live="' + id + '"]').forEach(function (e) { if (e._build) e.replaceWith(e._build()); });
   var pb = root.querySelector(".aipb"); if (pb) pb.scrollTop = pb.scrollHeight;
  }

  /* ------------------------------------------------------------ AI panel */
  function togglePanel() { st.panel = !st.panel; render(); if (st.panel) focusPanel(); }
  function focusPanel() { later(function () { var ta = root.querySelector(".aip textarea"); if (ta) ta.focus(); }, 0); }
  function renderPanel() {
   var r = st.route, t = r.k === "page" ? thr(r.t) : null;
   var p = h("aside.aip");
   p.append(h("div.aiph", null, h("span", { class: "pu" }, svg("spark", 17)), "Session AI", h("span.sp"),
    h("button.tbtn", { title: "New page", onclick: function () { newQuestion(); } }, svg("newpage", 16)), h("button.tbtn", { title: "Close", onclick: togglePanel }, svg("x", 15))));
   var body = h("div.aipb");
   if (t) {
    var sub = r.sub ? turnOf(t, r.sub) : null;
    body.append(h("div", { style: "display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px" }, h("span.ctxchip", null, svg("page", 13), h("span", { text: sub ? sub.title : t.title }))));
    body.append(h("div.pmh", { style: "padding:8px 0 2px", text: "Runs on this page · " + treeSummary(t) }));
    treeItems(t).forEach(function (it) { body.append(panelEntry(t, it[0], it[1])); });
   } else {
    body.append(h("div", { style: "color:var(--text2);font-size:13.5px;margin:6px 0 12px;line-height:1.5" }, "Ask a new question. It runs with the selected agent and is saved as a page in Research; this panel shows its progress while you keep working here."));
    active(visible()).filter(function (x) { return x.status === "running"; }).forEach(function (x) {
     var u = x.turns.filter(function (y) { return y.status === "running"; })[0];
     body.append(h("div.pa", { "data-live": u.id }, h("div.pam", null, h("span.spin"), x.title), h("div.pat", { text: (u.activity.slice(-1)[0] || {}).label || "Starting…" }), h("a.lnk", { onclick: function () { go({ k: "page", t: x.id }); } }, "Open page")));
    });
   }
   p.append(body);
   var foot = h("div.aipf");
   if (t) {
    var sub2 = r.sub ? turnOf(t, r.sub) : null;
    var last = (sub2 ? chain(t, sub2) : chain(t, rootTurn(t))).slice(-1)[0];
    var pb = st.pendingBranch && st.pendingBranch.t === t.id ? st.pendingBranch : null;
    if (pb) st.mode = "branch";
    foot.append(composer({ key: "panel:" + t.id, modes: true, short: true, agentFrom: last, quote: pb && pb.quote, placeholder: st.mode === "branch" ? "Ask in a new branch…" : "Ask a follow-up about this page…",
     hint: st.mode === "branch" ? "Adds a branch " + (pb && pb.paragraph != null ? "under ¶" + (pb.paragraph + 1) : "after the last answer") + "; the main conversation is unchanged." : "The answer is written into the page; this panel shows the run.",
     onSend: function (q) {
      if (st.mode === "branch") { var pu = pb ? turnOf(t, pb.turnId) : last; var anc = pb && pb.paragraph != null ? { turnId: pu.id, paragraph: pb.paragraph, quote: pb.quote } : null; st.pendingBranch = null; addBranch(t, pu, anc, q); }
      else addFollowup(t, last, q);
     } }));
   } else {
    foot.append(composer({ key: "panel:new", ws: true, short: true, placeholder: "Ask a new question…", onSend: function (q) { createThread(q, st.wsPick || defaultWs(), { stay: true }); } }));
   }
   p.append(foot);
   later(function () { var r1 = body.querySelector(".run.live"); if (r1) body.scrollTop = r1.offsetTop - 60; }, 0);
   return p;
  }
  function panelEntry(t, u, d) {
   var key = "plog:" + u.id, open = st.open[key] != null ? st.open[key] : u.status === "running";
   var w = h("div.run" + (u.status === "running" ? ".live" : ""), { "data-live": u.id, style: "margin-left:" + (d || 0) * 14 + "px" });
   w._build = function () { return panelEntry(t, u, d); };
   var kind = u.relation === "root" ? "Question" : u.relation === "followup" ? "Follow-up" : "Branch" + (u.anchor ? " from ¶" + (u.anchor.paragraph + 1) : "");
   w.append(h("div.rh", { onclick: function () { st.open[key] = !open; refresh(u.id); } }, u.status === "running" ? h("span.spin") : svg(u.relation === "branch" ? "branch" : "spark", 14), h("span.rt", { text: u.title }), u.status !== "done" ? stPill(u.status) : h("span.rm", { style: "margin:0", text: u.durationSec ? dur(u.durationSec) : "" })));
   w.append(h("div.rm", { text: kind + " · " + PROV[u.provider].label + " · " + u.model + (u.effort ? " · " + u.effort : "") + (u.activity.length ? " · " + u.activity.length + " steps" : "") }));
   if (open && u.activity.length) w.append(h("div.steps", { style: "margin:4px 0 2px 21px" }, u.activity.map(stepRow)));
   if (u.error) w.append(h("div.rm", { style: "color:var(--red)", text: u.error }));
   if (u.status === "queued") w.append(h("div.rm", { text: "Starts when the running answer above finishes." }));
   w.append(h("a.lnk", { onclick: function () { openThread(t.id, u.id); } }, "Show in page"));
   return w;
  }

  /* ------------------------------------------------------------ notes (editable blocks) */
  function renderNote(n) {
   var pg = pageShell({ title: n.title, icon: pageIcon("page", 56, "var(--text2)"), doc: true });
   var refs = {}; JSON.stringify(n.blocks).replace(/"threadId":"(\w+)"/g, function (_, id) { refs[id] = 1; });
   pg.append(h("div.props", null,
    h("div.prow", null, h("div.pk", null, svg("tag", 15), "Tags"), h("div.pv", null, n.tags.map(function (g) { return tag(g); }))),
    h("div.prow", null, h("div.pk", null, svg("rel", 15), "Mentions"), h("div.pv", null, Object.keys(refs).map(thr).filter(Boolean).map(function (t) { return mention(t); }))),
    h("div.prow", null, h("div.pk", null, svg("clock", 15), "Last edited"), h("div.pv", null, h("span", { text: fmtDT(n.updatedAt) })))));
   pg.append(h("div.hr"));
   var blocks = h("div.blocks.note", { "data-note": n.id });
   if (!n.blocks.length) n.blocks.push(nb("text", ""));
   n.blocks.forEach(function (b) { blocks.append(noteBlock(n, b, 0)); });
   pg.append(blocks);
   pg.append(h("div", { style: "height:120px;cursor:text", onclick: function () { var lb = n.blocks[n.blocks.length - 1]; if (lb.text || lb.type !== "text") { lb = nb("text", ""); n.blocks.push(lb); render(); } focusBlock(lb.id); } }));
   return pg;
  }
  function noteBlock(n, b, depth) {
   var blk = h("div.blk", { "data-bid": b.id });
   blk.append(h("div.hdl", null, h("button", { title: "Click to add a block below", "data-plus": b.id, onclick: function (e) { plusBlock(n, b, e.currentTarget); } }, svg("plus", 16)), h("button", { title: "Options", onclick: function (e) { blockMenu(e.currentTarget, n, b); } }, svg("drag", 16))));
   var ed = function (cls, ph) {
    var e = h("div.ed" + (cls ? "." + cls : ""), { contenteditable: "true", "data-ph": ph || "", "data-fk": "nb:" + b.id, spellcheck: "false" });
    e.textContent = b.text;
    e.addEventListener("input", function () { b.text = e.textContent; n.updatedAt = nowISO(); if (st.layer && (st.layer.kind === "slash" || st.layer.kind === "mention")) slashInput(e); });
    e.addEventListener("keydown", function (ev) { noteKey(ev, n, b, e); });
    return e;
   };
   var refsEl = (b.refs || []).map(function (r) { var t = thr(r.threadId); return t ? [" ", mention(t, r.turnId ? turnOf(t, r.turnId) : null)] : null; });
   var line = function (e) { return h("div.line", { onclick: function (ev) { if (ev.target === ev.currentTarget) focusBlock(b.id); } }, e, refsEl); };
   var kids = function () { var c = h("div", { style: "padding-left:" + (b.type === "toggle" ? 0 : 26) + "px" }); (b.children || []).forEach(function (x) { c.append(noteBlock(n, x, depth + 1)); }); return c; };
   var e;
   if (b.type === "bullet") { e = ed(); blk.append(h("div.bul" + (depth % 2 ? ".l1" : ""), null, h("span.dot"), h("div.bt", null, line(e)))); if (b.children.length) blk.append(kids()); }
   else if (b.type === "todo") { e = ed("tt", "To-do"); blk.append(h("div.todo" + (b.checked ? ".done" : ""), null, h("span.cb" + (b.checked ? ".on" : ""), { onclick: function () { b.checked = !b.checked; render(); } }, b.checked ? svg("check", 12) : null), h("div", { style: "flex:1" }, line(e)))); }
   else if (b.type === "h1" || b.type === "h2" || b.type === "h3") { e = ed(b.type, "Heading " + b.type[1]); blk.append(e); }
   else if (b.type === "quote") { e = ed(null, "Quote"); blk.append(h("div.quote", null, e)); }
   else if (b.type === "callout") { e = ed(null, "Callout"); blk.append(h("div.callout", null, svg("alert", 18), h("div.cbody", null, e))); }
   else if (b.type === "toggle") { var k = "nt:" + b.id; e = ed(null, "Toggle"); blk.append(h("div.tgl", null, h("button.tgb" + (st.open[k] ? ".open" : ""), { onclick: function () { st.open[k] = !st.open[k]; render(); } }, svg("tri", 12)), h("div", { style: "flex:1" }, line(e), st.open[k] ? h("div", null, b.children.length ? kids() : h("div", { style: "color:var(--text3);padding:3px 0", text: "Empty toggle. Click + to add a block inside." })) : null))); }
   else if (b.type === "divider") blk.append(h("div.divider"));
   else if (b.type === "ai") blk.append(aiBlock(n, b));
   else if (b.type === "hlembed") { var x = D.highlights.find(function (y) { return y.id === b.hl; }); var t2 = thr(x.threadId); blk.append(h("div.callout", { style: "background:var(--hl-" + x.color + ")" }, svg("marker", 18), h("div.cbody", null, h("div", null, "“", md(x.quote), "”"), x.note ? h("div", { style: "font-size:.9em;color:var(--text2);margin-top:2px", text: x.note }) : null, h("div", { style: "font-size:13px;margin-top:4px" }, mention(t2, turnOf(t2, x.turnId)))))); }
   else if (b.type === "dbview") { blk.append(h("div", { style: "font-size:14px" }, h("div", { style: "font-weight:600;display:flex;gap:6px;align-items:center;margin-top:8px" }, pageIcon("db", 16), "Research"), dbView({ ws: n.workspaceId, view: "table", setView: function () { go({ k: "db", ws: n.workspaceId }); }, compact: true, limit: 4 }))); }
   else { e = ed(); blk.append(line(e)); }
   if (b.type !== "toggle" && b.type !== "bullet" && b.children && b.children.length) blk.append(kids());
   return blk;
  }
  function aiBlock(n, b) {
   var w = h("div.aiblk", { "data-live": b.turn || "" });
   w._build = function () { return aiBlock(n, b); };
   w.append(h("div.aibh", null, h("span", { class: "pu" }, svg("spark", 14)), "AI block", b.thread ? " · saved to Research" : " · the answer is saved as a page in Research and linked here"));
   if (!b.thread) {
    w.append(composer({ key: "ai:" + b.id, autofocus: true, placeholder: "Ask an agent…", onSend: function (q) {
     var t = createThread(q, n.workspaceId, { stay: true });
     b.thread = t.id; b.turn = t.rootTurnId; b.refs = [{ threadId: t.id }]; render();
    } }));
    return w;
   }
   var t = thr(b.thread), u = turnOf(t, b.turn);
   w.append(h("div", { style: "font-weight:500;margin-bottom:6px" }, md(u.question)));
   if (u.status === "running" && !u.answer.length) w.append(h("div.runline", null, h("span.spin"), h("span.shim", { text: (u.activity.slice(-1)[0] || {}).label || "Starting…" })));
   u.answer.forEach(function (p, i) { w.append(h("p.p", { style: "margin:4px 0" }, md(p), u.status === "running" && i === u.answer.length - 1 ? h("span.caret") : null)); });
   w.append(h("div", { style: "font-size:13px;color:var(--text3);margin-top:6px;display:flex;gap:6px;align-items:center" }, "Page:", mention(t)));
   return w;
  }
  function findParent(list, id) { for (var i = 0; i < list.length; i++) { if (list[i].id === id) return { list: list, i: i }; var r = findParent(list[i].children || [], id); if (r) { r.parent = r.parent || list[i]; r.parentList = r.parentList || list; return r; } } return null; }
  function focusBlock(id, atStart) {
   var e = root.querySelector('[data-fk="nb:' + id + '"]'); if (!e) return; e.focus({ preventScroll: true });
   var r = document.createRange(); r.selectNodeContents(e); r.collapse(!!atStart); var s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function caretOffset(e) { var s = getSelection(); if (!s.rangeCount) return 0; var r = s.getRangeAt(0).cloneRange(); r.selectNodeContents(e); r.setEnd(s.getRangeAt(0).endContainer, s.getRangeAt(0).endOffset); return r.toString().length; }
  function noteKey(ev, n, b, e) {
   var L = st.layer;
   if (L && (L.kind === "slash" || L.kind === "mention")) {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); var items = menuItems(L); L.sel = (L.sel + (ev.key === "ArrowDown" ? 1 : items.length - 1)) % Math.max(1, items.length); renderLayer(); return; }
    if (ev.key === "Enter") { ev.preventDefault(); var it = menuItems(L)[L.sel]; if (it) it.run(); return; }
    if (ev.key === "Escape") { ev.preventDefault(); st.layer = null; renderLayer(); return; }
   }
   if (ev.key === "/" || ev.key === "@") {
    var kind = ev.key === "/" ? "slash" : "mention";
    later(function () { var rc = getSelection().rangeCount ? getSelection().getRangeAt(0).getBoundingClientRect() : e.getBoundingClientRect(); if (!rc.height) rc = e.getBoundingClientRect(); var p = relPos(rc); st.layer = { kind: kind, x: p.x, y: p.b + 4, n: n, b: b, el: e, start: caretOffset(e), q: "", sel: 0, hasChar: true }; renderLayer(); }, 0);
    return;
   }
   if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    var off = caretOffset(e), rest = b.text.slice(off); b.text = b.text.slice(0, off); e.textContent = b.text;
    var loc = findParent(n.blocks, b.id);
    var type = (b.type === "bullet" || b.type === "todo") && (b.text || rest) ? b.type : "text";
    if ((b.type === "bullet" || b.type === "todo") && !b.text && !rest) { b.type = "text"; render(); focusBlock(b.id); return; }
    var nbk = nb(type, rest);
    loc.list.splice(loc.i + 1, 0, nbk); render(); focusBlock(nbk.id, true); return;
   }
   if (ev.key === "Backspace" && caretOffset(e) === 0 && getSelection().isCollapsed) {
    var loc2 = findParent(n.blocks, b.id);
    if (b.type !== "text") { ev.preventDefault(); b.type = "text"; render(); focusBlock(b.id, true); return; }
    if (!b.text && loc2 && (loc2.i > 0 || loc2.parent)) { ev.preventDefault(); var prev = loc2.i > 0 ? loc2.list[loc2.i - 1] : loc2.parent; loc2.list.splice(loc2.i, 1); render(); focusBlock(prev.id); return; }
   }
   if (ev.key === "Tab") {
    ev.preventDefault();
    var l3 = findParent(n.blocks, b.id);
    if (!ev.shiftKey && l3.i > 0) { var pv = l3.list[l3.i - 1]; l3.list.splice(l3.i, 1); pv.children = pv.children || []; pv.children.push(b); if (pv.type === "toggle") st.open["nt:" + pv.id] = true; }
    else if (ev.shiftKey && l3.parent) { var gp = findParent(n.blocks, l3.parent.id); l3.list.splice(l3.i, 1); gp.list.splice(gp.i + 1, 0, b); }
    render(); focusBlock(b.id); return;
   }
  }
  function slashInput(e) {
   var L = st.layer; var off = caretOffset(e);
   if (off < L.start) { st.layer = null; renderLayer(); return; }
   L.q = e.textContent.slice(L.start, off); L.sel = 0;
   if (/\s{2}/.test(L.q) || L.q.length > 24) { st.layer = null; }
   renderLayer();
  }
  function plusBlock(n, b, btn) {
   var loc = findParent(n.blocks, b.id);
   var target = b;
   if (b.text || b.type !== "text") { target = nb("text", ""); loc.list.splice(loc.i + 1, 0, target); render(); }
   later(function () {
    var e = root.querySelector('[data-fk="nb:' + target.id + '"]'); if (!e) return; e.focus();
    var p = relPos(e.getBoundingClientRect());
    st.layer = { kind: "slash", x: p.x, y: p.b + 4, n: n, b: target, el: e, start: 0, q: "", sel: 0, hasChar: false }; renderLayer();
   }, 0);
  }
  var SLASH = [
   { sec: "Basic blocks", label: "Text", t: "text", ic: "Aa", hint: "" }, { label: "Heading 1", t: "h1", ic: "H1", hint: "#" }, { label: "Heading 2", t: "h2", ic: "H2", hint: "##" }, { label: "Heading 3", t: "h3", ic: "H3", hint: "###" },
   { label: "Bulleted list", t: "bullet", ic: "•", hint: "-" }, { label: "To-do list", t: "todo", svg: "check", hint: "[]" }, { label: "Toggle list", t: "toggle", svg: "tri", hint: ">" }, { label: "Quote", t: "quote", ic: "“", hint: "\"" }, { label: "Callout", t: "callout", svg: "alert" }, { label: "Divider", t: "divider", ic: "—", hint: "---" },
   { sec: "Session", label: "Ask AI", t: "ai", svg: "spark", desc: "Run a question with an agent; saved to Research", hint: "⌘J" }, { label: "Mention a research page", t: "mention", ic: "@", desc: "Link a thread or a single answer", hint: "@" },
   { label: "Highlight", t: "hlembed", svg: "marker", desc: "Embed a saved passage" }, { label: "Linked view of Research", t: "dbview", svg: "db", desc: "Table of this workspace's research" }
  ];
  function menuItems(L) {
   var q = (L.q || "").toLowerCase();
   if (L.kind === "mention") {
    var out = [];
    active(visible()).forEach(function (t) { if (!q || t.title.toLowerCase().indexOf(q) >= 0) out.push({ label: t.title, iconEl: threadIcon(t, 16), desc: wsById(t.workspaceId).name + " · Research", run: function () { insertMention(L, t); } }); });
    return out.slice(0, 8);
   }
   if (L.kind === "hlpick") return D.highlights.filter(function (x) { return !q || x.quote.toLowerCase().indexOf(q) >= 0; }).map(function (x) { return { label: plain(x.quote), desc: x.threadTitle, iconEl: h("span", { style: "width:12px;height:12px;border-radius:3px;background:var(--hl-" + x.color + ")" }), run: function () { insertBlockAfter(L.n, L.b, nb("hlembed", "", { hl: x.id })); } }; });
   return SLASH.filter(function (s) { return !q || s.label.toLowerCase().indexOf(q) >= 0 || s.t.indexOf(q) === 0; }).map(function (s) { return { sec: q ? null : s.sec, label: s.label, desc: s.desc, ic: s.ic, svg: s.svg, hint: s.hint, run: function () { applySlash(L, s); } }; });
  }
  function stripTrigger(L) {
   var off = caretOffset(L.el); var from = L.hasChar ? L.start - 1 : L.start;
   L.b.text = L.b.text.slice(0, Math.max(0, from)) + L.b.text.slice(Math.max(off, L.start));
  }
  function applySlash(L, s) {
   stripTrigger(L); st.layer = null;
   var b = L.b, n = L.n;
   if (["text", "h1", "h2", "h3", "bullet", "todo", "toggle", "quote", "callout"].indexOf(s.t) >= 0) { b.type = s.t; render(); focusBlock(b.id); return; }
   if (s.t === "mention") { render(); later(function () { var e = root.querySelector('[data-fk="nb:' + b.id + '"]'); var p = relPos(e.getBoundingClientRect()); st.layer = { kind: "mention", x: p.x, y: p.b + 4, n: n, b: b, el: e, start: b.text.length, q: "", sel: 0, hasChar: false }; renderLayer(); e.focus(); }, 0); return; }
   if (s.t === "hlembed") { render(); later(function () { var e = root.querySelector('[data-fk="nb:' + b.id + '"]'); var p = relPos(e.getBoundingClientRect()); st.layer = { kind: "hlpick", x: p.x, y: p.b + 4, n: n, b: b, el: e, start: 0, q: "", sel: 0 }; renderLayer(); }, 0); return; }
   var nbk = nb(s.t, "");
   if (!b.text && b.type === "text") { var loc = findParent(n.blocks, b.id); loc.list.splice(loc.i, 1, nbk); } else insertBlockAfter(n, b, nbk, true);
   if (s.t === "divider") { var l2 = findParent(n.blocks, nbk.id); var tb = nb("text", ""); l2.list.splice(l2.i + 1, 0, tb); render(); focusBlock(tb.id); return; }
   render();
  }
  function insertBlockAfter(n, b, nbk, noRender) { var loc = findParent(n.blocks, b.id); loc.list.splice(loc.i + 1, 0, nbk); st.layer = null; if (!noRender) render(); }
  function insertMention(L, t) {
   stripTrigger(L); st.layer = null;
   L.b.refs = (L.b.refs || []).concat([{ threadId: t.id }]);
   render(); focusBlock(L.b.id);
  }

  /* ------------------------------------------------------------ other pages */
  function renderGettingStarted() {
   var pg = pageShell({ title: "Getting started", cover: "g2.short", icon: pageIcon("flag", 64, "#d44c47"), doc: true });
   pg.append(h("div.lead", { style: "font-size:16px;color:var(--text);margin-top:6px" }, "Session asks a coding-agent CLI on this Mac (Claude Code, Codex or Grok) with the sign-in you already have. Every question, answer, source and run log is saved as a page in a workspace's ", h("b", null, "Research"), " database."));
   var ready = Object.keys(st.agents).filter(function (k) { return st.agents[k] === "ready"; });
   var asked = st.checks.ask || threads.some(function (t) { return t.workspaceId === "ws-default"; }) || !st.firstRun;
   var blocks = h("div.blocks");
   var todo = function (done, title, desc) { return h("div.blk", null, h("div.todo" + (done ? ".done" : ""), null, h("span.cb" + (done ? ".on" : ""), null, done ? svg("check", 12) : null), h("div", { style: "flex:1" }, h("div.tt", { style: "font-weight:600", text: title }), desc ? h("div", { style: "color:var(--text2);font-size:.94em", text: desc }) : null))); };
   blocks.append(h("div.h2", { style: "margin-top:.3em" }, "1. Connect an agent"));
   blocks.append(todo(ready.length > 0, "At least one agent is ready", ready.length ? ready.map(function (k) { return PROV[k].label; }).join(", ") + " can answer questions. This list updates on its own after you sign in." : "Install one of the CLIs below and sign in from Terminal."));
   var ak = "gs:agents", aopen = st.open[ak] != null ? st.open[ak] : !ready.length;
   var AL = { ready: "ready", signin: "not signed in", missing: "not installed", checking: "checking…" };
   blocks.append(h("div.blk", null, h("div.tgl", null, h("button.tgb" + (aopen ? ".open" : ""), { "data-agents": "1", onclick: function () { st.open[ak] = !aopen; render(); } }, svg("tri", 12)),
    h("div", { style: "flex:1;min-width:0" }, h("div.tgh", { onclick: function () { st.open[ak] = !aopen; render(); }, class: "t2" }, ["claude", "codex", "grok"].map(function (k) { return PROV[k].label + " " + AL[st.agents[k]]; }).join(" · ")), aopen ? agentTable() : null))));
   blocks.append(h("div.h2", null, "2. Ask your first question"));
   blocks.append(todo(asked, "Ask a question about a repository or a topic", "Pick the workspace folder the agent should work in. The answer streams into a new page."));
   blocks.append(composer({ key: "gs", ws: true, placeholder: "Ask a question…", suggest: ["Explain how the build is configured in this repo", "Find where request timeouts are set and list them", "Summarize the open TODOs in src/"], onSend: function (q) { createThread(q, st.wsPick || defaultWs()); } }));
   blocks.append(h("div.h2", null, "3. Continue or branch"));
   blocks.append(todo(!st.firstRun, "Follow-up or branch", null));
   var tg = function (k, title, body) { var key = "gs:" + k, open = st.open[key]; return h("div.blk", null, h("div.tgl", null, h("button.tgb" + (open ? ".open" : ""), { onclick: function () { st.open[key] = !open; render(); } }, svg("tri", 12)), h("div", { style: "flex:1" }, h("div.tgh", { onclick: function () { st.open[key] = !open; render(); }, style: "font-weight:500" }, title), open ? h("div", { style: "color:var(--text2);padding:2px 0 6px" }, body) : null))); };
   blocks.append(tg("fu", "Follow-up: continue the same conversation", "Type in the Ask box at the end of a page. The agent keeps the earlier questions and answers as context, and the new answer appears below the last one."));
   blocks.append(tg("br", "Branch: ask about one passage without changing the conversation", "Hover a paragraph and click +, or select text and choose Branch. The branch keeps everything up to that paragraph as context and is shown " + (V.branch === "toggle" ? "as a toggle under the paragraph." : "as a sub-page linked under the paragraph.")));
   blocks.append(tg("q", "Queue: one answer runs at a time per conversation", "If you send a follow-up while an answer is running, it waits and starts automatically when the running answer finishes."));
   blocks.append(h("div.h2", null, "4. Keep what matters"));
   blocks.append(todo(!st.firstRun, "Highlight a passage and mention a page in a note", "Select text in an answer and choose Highlight. In any note, type @ to link a research page, or / for blocks such as Ask AI."));
   blocks.append(h("div.h2", null, "Start from a template"));
   var tp = h("div.tpls");
   [["Bug investigation", "Question, reproduction steps and a checklist for the fix.", "Investigate why "], ["Paper notes", "Summary, key claims, open questions; links the paper as a source.", "Summarize the paper at "], ["Compare providers", "Ask the same question with two agents and compare answers side by side.", ""]].forEach(function (x) {
    tp.append(h("div.tpl", { onclick: function () { st.text.gs = x[2]; render(); later(function () { var ta = root.querySelector('[data-fk="gs"]'); if (ta) ta.focus(); }, 0); } }, h("b", null, svg("tpl", 15), x[0]), h("span", { text: x[1] })));
   });
   blocks.append(tp);
   if (st.firstRun) blocks.append(h("div.callout.blue", { style: "margin-top:16px" }, svg("db", 18), h("div.cbody", null, h("div.ct", { text: "Want to look around first?" }), h("div", { text: "Open a sample with three workspaces (a JS engine, ML infrastructure, reading notes) and eleven research pages." }),
    h("button.btn.pri", { style: "margin-top:8px", "data-nav": "sample", onclick: function () { st.firstRun = false; st.sideX["ws:ws-compilers"] = true; go({ k: "home" }); } }, "Open sample workspace"))));
   pg.append(blocks);
   return pg;
  }
  function agentTable() {
   var t = h("div.agt");
   var info = { claude: { cmd: "claude auth login", inst: "npm i -g @anthropic-ai/claude-code" }, codex: { cmd: "codex login", inst: "npm i -g @openai/codex" }, grok: { cmd: "grok login", inst: "Install the Grok CLI" } };
   ["claude", "codex", "grok"].forEach(function (k) {
    var s = st.agents[k];
    var pill = s === "ready" ? h("span.st.c-green", null, h("i"), "Ready") : s === "signin" ? h("span.st.c-orange", null, h("i"), "Not signed in") : s === "checking" ? h("span.st.c-blue.run", null, h("i"), "Checking…") : h("span.st.c-gray", null, h("i"), "Not installed");
    var act = s === "ready" ? h("span", { text: "Models: " + D.providers.find(function (p) { return p.id === k; }).models.slice(0, 3).join(", ") }) :
     s === "signin" ? [h("code", { text: info[k].cmd }), h("button.btn.sm", { onclick: function () { toast("Copied “" + info[k].cmd + "”. Run it in Terminal; this row updates when sign-in completes."); st.agents[k] = "checking"; render(); later(function () { st.agents[k] = "ready"; render(); }, 2600); } }, svg("copy", 13), "Copy")] :
     s === "checking" ? h("span", { text: "Waiting for sign-in…" }) : [h("span", { text: "CLI not found on PATH" }), h("button.btn.sm", { onclick: function () { toast("Opens the Grok CLI install guide"); } }, "Install guide")];
    t.append(h("div.agr", null, h("span.an", null, h("span.pdot", { style: "background:" + PROV[k].hex }), PROV[k].label), h("span.as", null, pill), h("span.ax", null, act)));
   });
   return t;
  }
  function renderAgentsPage() {
   var pg = pageShell({ title: "Agents", icon: pageIcon("agent", 56, "var(--text2)") });
   pg.append(h("div.lead", { text: "Session runs these command-line agents with your existing sign-in. Status is checked automatically." }));
   pg.append(agentTable());
   pg.append(h("div.h3", { style: "font-size:18px" }, "Defaults for new questions"));
   pg.append(h("div.props", null, h("div.prow", null, h("div.pk", null, svg("agent", 15), "Agent"), h("div.pv", { onclick: function (e) { agentMenu(e.currentTarget, null, st.agent); } }, provTag(st.agent.provider), h("span", { text: st.agent.model + (st.agent.effort ? " · " + st.agent.effort : "") }))),
    h("div.prow", null, h("div.pk", null, svg("folder", 15), "Workspace root"), h("div.pv", null, h("code", { text: "~/research" })))));
   return pg;
  }
  function renderHighlights(ws) {
   var pg = pageShell({ title: "Highlights", icon: pageIcon("marker", 56, "var(--yellow)"), wide: true });
   pg.append(h("div.lead", { text: "Passages you highlighted in answers. Each row links back to the answer it came from; notes appear as comments in the page margin." }));
   var cols = [["Passage", 380], ["Note", 240], ["Page", 260], ["Color", 90], ["Created", 100]];
   var tb = h("div.tbl"), head = h("div.tr.head");
   cols.forEach(function (c) { head.append(h("div.td", { style: "width:" + c[1] + "px" }, c[0])); }); tb.append(head);
   threads.filter(function (t) { return t.workspaceId === ws; }).forEach(function (t) { t.turns.forEach(function (u) { u.highlights.forEach(function (x) {
    tb.append(h("div.tr", { onclick: function () { openThread(t.id, u.id); }, style: "cursor:pointer" },
     h("div.td", { style: "width:380px" }, h("span.hl.hl-" + x.color, { class: "ell" }, plain(x.quote))),
     h("div.td", { style: "width:240px;color:var(--text2)" }, x.note || ""), h("div.td", { style: "width:260px" }, mention(t, u)), h("div.td", { style: "width:90px" }, tag(x.color, x.color === "amber" ? "yellow" : x.color)), h("div.td", { style: "width:100px;color:var(--text2)" }, fmtDate(x.createdAt))));
   }); }); });
   pg.append(tb);
   return pg;
  }
  function renderSources(ws) {
   var pg = pageShell({ title: "Sources", icon: pageIcon("globe", 56, "var(--blue2)"), wide: true });
   pg.append(h("div.lead", { text: "Links cited by answers in this workspace, with the pages that cite them (a relation)." }));
   var tb = h("div.tbl"), head = h("div.tr.head");
   [["Title", 360], ["Domain", 180], ["Cited by", 420]].forEach(function (c) { head.append(h("div.td", { style: "width:" + c[1] + "px" }, c[0])); }); tb.append(head);
   var seen = {};
   threads.filter(function (t) { return t.workspaceId === ws; }).forEach(function (t) { t.turns.forEach(function (u) { u.sources.forEach(function (s) { (seen[s.url] = seen[s.url] || { s: s, refs: [] }).refs.push([t, u]); }); }); });
   Object.keys(seen).forEach(function (k) { var x = seen[k];
    tb.append(h("div.tr", null, h("div.td", { style: "width:360px;font-weight:500" }, svg("globe", 14), h("span", { text: x.s.title, class: "ell" })), h("div.td", { style: "width:180px;color:var(--text2)" }, x.s.domain), h("div.td", { style: "width:420px" }, x.refs.slice(0, 2).map(function (r) { return mention(r[0], r[1]); }))));
   });
   pg.append(tb);
   return pg;
  }
  function renderArchive() {
   var pg = pageShell({ title: "Archive", icon: pageIcon("archive", 56, "var(--text2)") });
   pg.append(h("div.lead", { text: "Archived pages are read-only: no follow-ups, branches or notifications. Restore a page to continue it." }));
   var l = h("div");
   visible().filter(function (t) { return t.archivedAt; }).forEach(function (t) { l.append(h("div.lrow", null, threadIcon(t, 16), h("span.lt", { text: t.title, onclick: function () { go({ k: "page", t: t.id }); } }), h("span.lm", { text: "Archived " + fmtDate(t.archivedAt) }), h("button.btn.sm", { onclick: function () { t.archivedAt = null; toast("Restored to Research"); render(); } }, "Restore"))); });
   pg.append(l);
   return pg;
  }
  function renderDraft(id) {
   var d = drafts.find(function (x) { return x.id === id; });
   var pg = pageShell({ title: "Untitled", icon: pageIcon("edit", 52, "var(--text3)") });
   pg.querySelector(".ptitle").style.color = "var(--text3)";
   pg.append(h("div.lead", { text: "Draft in " + wsById(d.workspaceId).name + ", saved " + rel(d.updatedAt) + ". Press Enter to run it; it then becomes a page in Research." }));
   if (st.text["draft:" + id] == null) st.text["draft:" + id] = d.prompt;
   st.agentFor = st.agentFor || {}; st.agentFor["draft:" + id] = st.agentFor["draft:" + id] || { provider: d.provider, model: d.model, effort: d.provider === "grok" ? null : "high" };
   pg.append(composer({ key: "draft:" + id, autofocus: true, placeholder: "Ask a question…", onSend: function (q, agent) { drafts = drafts.filter(function (x) { return x !== d; }); createThread(q, d.workspaceId, { agent: agent }); } }));
   return pg;
  }

  /* ------------------------------------------------------------ new question */
  function newQuestion(ws) {
   if (ws) st.wsPick = ws;
   if (V.chat === "panel" && st.route.k !== "home") { st.panel = true; go({ k: "home" }); }
   else go({ k: "home" });
   later(function () { var ta = root.querySelector('[data-fk="home"]'); if (ta) ta.focus(); }, 0);
  }

  /* ------------------------------------------------------------ menus & layer */
  function anchorPos(el, dx, dy) { var p = relPos(el.getBoundingClientRect()); return { x: p.x + (dx || 0), y: p.b + (dy == null ? 4 : dy) }; }
  function menu(el, items, opts) { var p = anchorPos(el); opts = opts || {}; if (opts.right) p.x = p.x + relPos(el.getBoundingClientRect()).w - (opts.w || 240); st.layer = { kind: "menu", x: p.x, y: p.y, items: items, sel: -1, w: opts.w }; renderLayer(); }
  function wsMenu(el) {
   menu(el, [{ sec: "raymond's session" }].concat(wsList().map(function (w) { return { label: w.name, desc: w.dir, iconEl: wsIcon(w, 18), run: function () { st.layer = null; go({ k: "db", ws: w.id }); } }; }), [{ sep: 1 },
    { label: "New workspace…", svg: "plus", desc: "Opens first-run setup in an empty workspace", run: function () { st.layer = null; st.firstRun = true; st.sideX["ws:ws-default"] = true; go({ k: "gs" }); } },
    { label: "Agents", svg: "agent", run: function () { st.layer = null; go({ k: "agents" }); } },
    { label: "Open workspace folder in Finder", svg: "folder", run: function () { st.layer = null; toast("Opens the workspace folder in Finder"); } }]), { w: 280 });
  }
  function wsPickMenu(el) { menu(el, wsList().map(function (w) { return { label: w.name, desc: w.dir, iconEl: wsIcon(w, 18), check: (st.wsPick || defaultWs()) === w.id, run: function () { st.wsPick = w.id; st.layer = null; render(); } }; }), { w: 260 }); }
  function agentMenu(el, key, cur) {
   var items = [];
   D.providers.forEach(function (p) {
    var ok = st.agents[p.id] === "ready";
    items.push({ sec: p.label + (ok ? "" : " · not ready") });
    p.models.slice(0, 4).forEach(function (m) { items.push({ label: m, iconEl: h("span.pdot", { style: "background:" + PROV[p.id].hex }), dis: !ok, check: cur.provider === p.id && cur.model === m, run: function () { var a = { provider: p.id, model: m, effort: p.efforts.length ? (cur.effort && p.efforts.indexOf(cur.effort) >= 0 ? cur.effort : "high") : null }; if (key) { st.agentFor = st.agentFor || {}; st.agentFor[key] = a; } st.agent = a; st.layer = null; render(); } }); });
   });
   var prov = D.providers.find(function (p) { return p.id === cur.provider; });
   if (prov.efforts.length) { items.push({ sec: "Effort" }); prov.efforts.forEach(function (e) { items.push({ label: e, check: cur.effort === e, run: function () { var a = Object.assign({}, cur, { effort: e }); if (key) { st.agentFor = st.agentFor || {}; st.agentFor[key] = a; } st.agent = a; st.layer = null; render(); } }); }); }
   var p = anchorPos(el); st.layer = { kind: "menu", x: p.x, y: p.y, items: items, sel: -1, w: 240, up: true, anchorTop: relPos(el.getBoundingClientRect()).y }; renderLayer();
  }
  function folderMenu(el, ws) {
   var fs = D.folders.filter(function (f) { return !ws || f.workspaceId === ws; });
   menu(el, [{ sec: "Filter by Folder" }, { label: "Any folder", check: !st.folder, run: function () { st.folder = null; st.layer = null; render(); } }].concat(fs.map(function (f) { return { label: f.name, iconEl: tag(f.name, FOLDC[f.id]), check: st.folder === f.id, run: function () { st.folder = f.id; st.layer = null; if (st.route.k !== "db") go({ k: "db", ws: f.workspaceId }); else render(); } }; }), [{ label: "Drafts", svg: "edit", check: st.folder === "drafts", run: function () { st.folder = "drafts"; st.layer = null; if (st.route.k !== "db") go({ k: "db", ws: ws }); else render(); } }]), { w: 250 });
  }
  function templatesMenu(el) {
   menu(el, [{ sec: "New page from template" }, { label: "Empty question", svg: "spark", run: function () { st.layer = null; newQuestion(); } }, { label: "Bug investigation", svg: "tpl", run: function () { st.layer = null; st.text.home = "Investigate why "; newQuestion(); } }, { label: "Paper notes", svg: "tpl", run: function () { st.layer = null; st.text.home = "Summarize the paper at "; newQuestion(); } }, { label: "Compare providers", svg: "tpl", desc: "Same question, two agents", run: function () { st.layer = null; newQuestion(); } }], { w: 260 });
  }
  function pageMenu(el, r) {
   var t = r.k === "page" ? thr(r.t) : null;
   var items = [{ sec: "Style" },
    { label: "Default", iconEl: h("span", { style: "font-weight:600", text: "Ag" }), check: !st.serif, run: function () { st.serif = false; st.layer = null; render(); } },
    { label: "Serif", iconEl: h("span", { style: "font-weight:600;font-family:var(--serif)", text: "Ag" }), check: st.serif, run: function () { st.serif = true; st.layer = null; render(); } },
    { sep: 1 }, { label: "Small text", check: st.small, run: function () { st.small = !st.small; st.layer = null; render(); } }, { label: "Full width", check: st.wide, run: function () { st.wide = !st.wide; st.layer = null; render(); } }];
   if (t) items = items.concat([{ sep: 1 }], threadActions(el, t));
   menu(el, items, { right: true, w: 250 });
  }
  function threadActions(el, t) {
   return [{ label: "Open", svg: "expand", run: function () { st.layer = null; go({ k: "page", t: t.id }, { full: true }); } },
    { label: t.bookmarked ? "Remove from Favorites" : "Add to Favorites", svg: "star", run: function () { t.bookmarked = !t.bookmarked; st.layer = null; render(); } },
    { label: "Move to folder…", svg: "folder", run: function () { folderMoveMenu(el, t); } },
    { label: "Copy page as Markdown", svg: "copy", run: function () { st.layer = null; toast("Page copied as Markdown"); } },
    { label: "Generate recap", svg: "spark", run: function () { st.layer = null; t.recap = t.recap || "Recap of " + t.turns.length + " questions (mock)."; render(); } },
    { label: "Archive", svg: "archive", desc: "Read-only; stops notifications", run: function () { t.archivedAt = nowISO(); st.layer = null; toast("Archived. Find it under Archive in the sidebar."); go({ k: "db", ws: t.workspaceId }); } }];
  }
  function ctxMenu(e, t) {
   e.preventDefault(); e.stopPropagation();
   var fake = { getBoundingClientRect: function () { return { left: e.clientX, top: e.clientY - 4, right: e.clientX, bottom: e.clientY - 4, width: 0, height: 0 }; } };
   menu(fake, [{ sec: t.title.length > 34 ? t.title.slice(0, 34) + "…" : t.title }].concat(threadActions(fake, t)), { w: 250 });
  }
  function hlPop(el, t, u, x) {
   var p = anchorPos(el);
   st.layer = { kind: "pop", x: p.x, y: p.y, title: x.note ? "Comment" : "Highlight", sub: D.user.name + " · " + fmtDT(x.createdAt), body: x.note ? x.note : "“" + plain(x.quote) + "”",
    actions: [["Add to note…", function () { addToNoteMenu(el, t, u, plain(x.quote).slice(0, 90)); }], ["Remove highlight", function () { u.highlights = u.highlights.filter(function (y) { return y !== x; }); render(); toast("Highlight removed"); }]] };
   renderLayer();
  }
  function folderMoveMenu(el, t) { menu(el, [{ sec: "Move to" }, { label: "Unfiled", check: !t.folderId, run: function () { t.folderId = null; st.layer = null; render(); } }].concat(D.folders.filter(function (f) { return f.workspaceId === t.workspaceId; }).map(function (f) { return { label: f.name, iconEl: tag(f.name, FOLDC[f.id]), check: t.folderId === f.id, run: function () { t.folderId = f.id; st.layer = null; toast("Moved to " + f.name + ". It stays in Research; Folder is a property."); render(); } }; })), { right: true, w: 250 }); }
  function answerMenu(el, t, u) {
   menu(el, [{ label: "Branch from the whole answer", svg: "branch", run: function () { st.layer = null; startPendingBranch(t, u, null, null); } }, { label: "Add answer to note…", svg: "page", run: function () { addToNoteMenu(el, t, u, plain(u.answer[0] || u.title).slice(0, 80)); } },
    { label: "Show run log", svg: "term", run: function () { st.open["log:" + u.id] = true; st.layer = null; render(); } }, { label: "Copy answer as Markdown", svg: "copy", run: function () { st.layer = null; toast("Answer copied"); } }, { label: "Retry run", svg: "clock", run: function () { st.layer = null; retry(t, u); } }], { right: true, w: 240 });
  }
  function paraMenu(el, t, u, i) {
   var para = u.answer[i];
   menu(el, [{ sec: "Paragraph " + (i + 1) }, { label: "Branch from this paragraph", svg: "branch", run: function () { st.layer = null; startPendingBranch(t, u, i, plain(para).slice(0, 140)); } },
    { label: "Highlight paragraph", svg: "marker", run: function () { u.highlights.push({ id: "hx" + (++st.created), paragraph: i, quote: para, color: "amber", note: null, createdAt: nowISO() }); st.layer = null; render(); toast("Highlighted. Listed under Highlights."); } },
    { label: "Copy link to block", svg: "link", run: function () { st.layer = null; toast("Link copied. Paste it in a note to mention this answer."); } },
    { label: "Add to note…", svg: "page", run: function () { addToNoteMenu(el, t, u, plain(para).slice(0, 80)); } }], { w: 250 });
  }
  function addToNoteMenu(el, t, u, text) {
   menu(el, [{ sec: "Add as a bullet in" }].concat(notes.filter(function (n) { return n.workspaceId === t.workspaceId; }).map(function (n) { return { label: n.title, svg: "page", run: function () { n.blocks.push(nb("bullet", text, { refs: [{ threadId: t.id, turnId: u.id }] })); st.layer = null; toast("Added to " + n.title + " with a link back to this answer."); render(); } }; })), { w: 260 });
  }
  function blockMenu(el, n, b) {
   menu(el, [{ sec: "Turn into" }].concat(["text", "h1", "h2", "bullet", "todo", "toggle", "quote", "callout"].map(function (k) { var s = SLASH.find(function (x) { return x.t === k; }); return { label: s.label, ic: s.ic, svg: s.svg, check: b.type === k, run: function () { b.type = k; st.layer = null; render(); } }; }),
    [{ sep: 1 }, { label: "Delete", svg: "trash", run: function () { var loc = findParent(n.blocks, b.id); loc.list.splice(loc.i, 1); st.layer = null; render(); } }]), { w: 220 });
  }
  function sharePop(el) { var p = anchorPos(el); st.layer = { kind: "pop", x: p.x - 260, y: p.y, title: "Share", body: "Pages are stored on this Mac in the workspace folder. Nothing is published. Use Copy page as Markdown or Export to send a page to someone.", actions: [["Copy as Markdown", function () { toast("Page copied as Markdown"); }], ["Export…", function () { toast("Exports Markdown and sources to a folder"); }]] }; renderLayer(); }
  function updatesPop(el, t) {
   var items = t.turns.slice().sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; }).slice(0, 6).map(function (u) { return { label: u.title, desc: STAT[u.status].label + " · " + fmtDT(u.completedAt || u.createdAt), iconEl: stPill(u.status).firstChild.cloneNode(), run: function () { st.layer = null; openThread(t.id, u.id); } }; });
   menu(el, [{ sec: "Updates" }].concat(items), { right: true, w: 300 });
  }
  function commentPop(el, hls) { var p = anchorPos(el); st.layer = { kind: "pop", x: p.x - 270, y: p.y, title: D.user.name, body: hls.map(function (x) { return "“" + plain(x.quote) + "” — " + x.note; }).join("\n\n"), sub: fmtDT(hls[0].createdAt) }; renderLayer(); }
  function openSearch() { st.layer = { kind: "search", q: "", sel: 0 }; renderLayer(); var i = layerEl.querySelector(".search input"); if (i) i.focus(); }
  function searchResults(q) {
   q = q.toLowerCase().trim();
   var out = [];
   active(visible()).forEach(function (t) {
    var snip = null, hit = !q || t.title.toLowerCase().indexOf(q) >= 0, tid = null;
    if (q) t.turns.some(function (u) { var txt = plain(u.question + " " + u.answer.join(" ")); var i = txt.toLowerCase().indexOf(q); if (i >= 0) { snip = [txt.slice(Math.max(0, i - 40), i), txt.slice(i, i + q.length), txt.slice(i + q.length, i + q.length + 70)]; tid = u.id; hit = true; return true; } return false; });
    if (hit) out.push({ t: t, snip: snip, turn: tid });
   });
   notes.forEach(function (n) { if (!q || n.title.toLowerCase().indexOf(q) >= 0 || JSON.stringify(n.blocks).toLowerCase().indexOf(q) >= 0) { if (wsList().some(function (w) { return w.id === n.workspaceId; })) out.push({ n: n }); } });
   return out.slice(0, 9);
  }
  function toast(msg) { st.toast = msg; renderLayer(); var my = msg; later(function () { if (st.toast === my) { st.toast = null; renderLayer(); } }, 2600); }

  function renderLayer() {
   var L = st.layer, kids = [];
   if (L) {
    if (L.kind === "inbox") {
     kids.push(h("div.scrim", { onclick: function () { st.layer = null; render(); } }));
     var box = h("div.inbox", null, h("div.ih", null, "Inbox", h("span.sp"), h("button.tbtn", { title: "Mark all as read", onclick: function () { inbox.forEach(function (i) { st.readInbox[i.id] = true; }); render(); } }, svg("check", 16)), h("button.tbtn", { onclick: function () { st.layer = null; render(); } }, svg("x", 15))));
     var il = h("div.il");
     var items = inbox.filter(function (i) { return visible().some(function (t) { return t.id === i.threadId; }); });
     if (!items.length) il.append(h("div.emptydb", null, h("b", { text: "You're up to date" }), "Finished runs, failures and agent questions appear here."));
     items.forEach(function (i) { il.append(inboxRow(i)); });
     box.append(il);
     kids.push(box);
    } else if (L.kind === "search") {
     kids.push(h("div.scrim.dim", { onclick: function () { st.layer = null; renderLayer(); } }));
     var res = searchResults(L.q);
     var inp = h("input", { placeholder: "Search pages, questions and answers…", value: L.q });
     var list = h("div.sres");
     var fill = function () {
      res = searchResults(L.q); list.replaceChildren();
      if (!res.length) list.append(h("div.mempty", { text: "No results" }));
      list.append(h("div.mh", { text: L.q ? "Best matches" : "Recent pages" }));
      res.forEach(function (r, i) {
       var open = function () { st.layer = null; if (r.n) go({ k: "note", id: r.n.id }); else openThread(r.t.id, r.turn); };
       list.append(h("div.sr" + (i === L.sel ? ".sel" : ""), { onclick: open, onmouseenter: function () { L.sel = i; } }, r.n ? pageIcon("page", 18) : threadIcon(r.t, 18),
        h("div.srw", null, h("div.srt", { text: r.n ? r.n.title : r.t.title }), r.snip ? h("div.srs", null, "…" + r.snip[0], h("mark", { text: r.snip[1] }), r.snip[2] + "…") : null),
        h("span.srp", { text: r.n ? wsById(r.n.workspaceId).name + " / Notes" : wsById(r.t.workspaceId).name + " / Research" })));
      });
     };
     inp.addEventListener("input", function () { L.q = inp.value; L.sel = 0; fill(); });
     inp.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); L.sel = Math.max(0, Math.min(res.length - 1, L.sel + (e.key === "ArrowDown" ? 1 : -1))); fill(); }
      else if (e.key === "Enter" && res[L.sel]) { e.preventDefault(); var r = res[L.sel]; st.layer = null; if (r.n) go({ k: "note", id: r.n.id }); else openThread(r.t.id, r.turn); }
      else if (e.key === "Escape") { st.layer = null; renderLayer(); }
     });
     fill();
     kids.push(h("div.search", null, h("div.sin", null, svg("search", 18), inp), list, h("div.sfoot", null, h("span", { text: "↑↓ Select" }), h("span", { text: "↵ Open" }), h("span", { text: "Searches titles, questions and answer text in all workspaces" }))));
    } else if (L.kind === "pop") {
     kids.push(h("div.scrim", { onclick: function () { st.layer = null; renderLayer(); } }));
     kids.push(h("div.pop", { style: "left:" + Math.max(8, L.x) + "px;top:" + L.y + "px" }, h("div.pt", { text: L.title }), L.sub ? h("div", { style: "font-size:12px;color:var(--text3);margin:-4px 0 6px", text: L.sub }) : null, h("div.pd", { style: "white-space:pre-wrap", text: L.body }),
      L.actions ? h("div", { style: "display:flex;gap:6px;margin-top:10px" }, L.actions.map(function (a) { return h("button.btn.sm", { onclick: function () { st.layer = null; a[1](); } }, a[0]); })) : null));
    } else if (L.kind === "menu" || L.kind === "slash" || L.kind === "mention" || L.kind === "hlpick") {
     var isEd = L.kind !== "menu";
     if (!isEd) kids.push(h("div.scrim", { onclick: function () { st.layer = null; renderLayer(); } }));
     var its = isEd ? menuItems(L) : L.items;
     var m = h("div.menu", { style: "width:" + (L.w || (isEd ? 320 : 240)) + "px", "data-menu": L.kind });
     if (isEd && L.kind === "slash" && L.q) m.append(h("div.mh", { text: "Results for “" + L.q + "”" }));
     if (isEd && L.kind === "mention") m.append(h("div.mh", { text: "Link to page" }));
     if (isEd && L.kind === "hlpick") m.append(h("div.mh", { text: "Highlights" }));
     if (!its.length) m.append(h("div.mempty", { text: "No results" }));
     var idx = 0;
     its.forEach(function (it) {
      if (it.sep) { m.append(h("div.msep")); return; }
      if (it.sec && !it.label) { m.append(h("div.mh", { text: it.sec })); return; }
      if (it.sec) m.append(h("div.mh", { text: it.sec }));
      var my = idx++;
      var icon = it.iconEl ? h("span.mic", null, it.iconEl) : it.svg ? h("span.mic" + (isEd ? ".box" : ""), null, svg(it.svg, 15)) : it.ic ? h("span.mic" + (isEd ? ".box" : ""), { text: it.ic }) : null;
      var row = h("div.mi" + (my === L.sel ? ".sel" : "") + (it.dis ? ".dis" : ""), { "data-item": it.label, onmousedown: function (e) { e.preventDefault(); }, onclick: function () { if (!it.dis) it.run(); }, onmouseenter: function () { if (isEd) { L.sel = my; m.querySelectorAll(".mi").forEach(function (x, j) { x.classList.toggle("sel", j === my); }); } } },
       icon, h("span.ml", null, it.label, it.desc ? h("small", { text: it.desc }) : null), it.hint ? h("span.mk", { text: it.hint }) : null, it.check ? h("span.chk", null, svg("check", 14)) : null);
      m.append(row);
     });
     var x = Math.min(L.x, 1280 - (L.w || 320) - 10), y = L.y;
     m.style.left = Math.max(8, x) + "px";
     kids.push(m);
     // place: flip up when near bottom
     later(function () { var mh = m.offsetHeight; if (L.up && L.anchorTop != null && y + mh > 790) m.style.top = Math.max(8, L.anchorTop - mh - 4) + "px"; else m.style.top = Math.max(8, Math.min(y, 792 - mh)) + "px"; }, 0);
     m.style.top = y + "px";
    } else if (L.kind === "selbar") {
     kids.push(L.el);
    }
   }
   if (st.toast) kids.push(h("div.toast", { text: st.toast }));
   layerEl.replaceChildren.apply(layerEl, kids);
  }

  /* selection toolbar on answers */
  function onMouseUp(e) {
   if (layerEl.contains(e.target)) return;
   later(function () {
    var s = getSelection(); if (!s.rangeCount || s.isCollapsed) { if (st.layer && st.layer.kind === "selbar") { st.layer = null; renderLayer(); } return; }
    var r = s.getRangeAt(0), node = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentNode;
    var blk = node.closest && node.closest(".ab .blk"); if (!blk || !root.contains(blk)) return;
    var exEl = blk.closest(".ex"), t = thr((st.peek || st.route).t), u = t && turnOf(t, exEl.getAttribute("data-turn")); if (!u) return;
    var i = +blk.getAttribute("data-p"), text = s.toString().trim(); if (!text) return;
    var p = relPos(r.getBoundingClientRect());
    var bar = h("div.selbar", { style: "left:" + Math.max(8, p.x + p.w / 2 - 170) + "px;top:" + Math.max(8, p.y - 42) + "px", onmousedown: function (ev) { ev.preventDefault(); } },
     h("button", { onclick: function () { st.layer = null; renderLayer(); startPendingBranch(t, u, i, text.slice(0, 160)); } }, h("span", { class: "pu" }, svg("spark", 14)), "Ask AI · Branch"),
     h("button", { onclick: function () { addHl(t, u, i, text, "amber", r); } }, svg("marker", 14), "Highlight"),
     ["green", "blue", "pink"].map(function (c) { return h("button.sw", { title: c, style: "background:var(--hl-" + c + ")", onclick: function () { addHl(t, u, i, text, c, r); } }); }),
     h("button", { onclick: function () { var note = "Comment on “" + text.slice(0, 40) + "”"; u.highlights.push({ id: "hx" + (++st.created), paragraph: i, quote: findRaw(u.answer[i], text), color: "blue", note: note, createdAt: nowISO() }); st.layer = null; render(); toast("Comment added in the margin"); } }, svg("comment", 14), "Comment"),
     h("button", { onclick: function () { st.layer = null; renderLayer(); toast("Copied"); } }, svg("copy", 14)));
    st.layer = { kind: "selbar", el: bar }; renderLayer();
   }, 0);
  }
  function findRaw(para, text) { if (para.indexOf(text) >= 0) return text; var words = text.split(/\s+/); var a = para.indexOf(words[0]); var lastW = words[words.length - 1]; var b = para.indexOf(lastW, a); return a >= 0 && b >= a ? para.slice(a, b + lastW.length) : text; }
  function addHl(t, u, i, text, color) {
   u.highlights.push({ id: "hx" + (++st.created), paragraph: i, quote: findRaw(u.answer[i], text), color: color, note: null, createdAt: nowISO() });
   getSelection().removeAllRanges(); st.layer = null; render(); toast("Highlighted. Listed under Highlights in the sidebar.");
  }

  /* keyboard */
  function onKey(e) {
   var mod = e.metaKey || e.ctrlKey;
   if (mod && (e.key === "k" || e.key === "p")) { e.preventDefault(); openSearch(); return; }
   if (mod && e.key === "j") { e.preventDefault(); if (V.chat === "panel" || st.route.k !== "page") { st.panel = true; render(); focusPanel(); } else { var ta = root.querySelector('.page [data-fk^="page:"]'); if (ta) { ta.focus(); ta.scrollIntoView({ block: "nearest" }); } } return; }
   if (mod && e.key === "\\") { e.preventDefault(); st.sideOpen = !st.sideOpen; render(); return; }
   if (mod && e.key === "[") { e.preventDefault(); nav(-1); return; }
   if (mod && e.key === "]") { e.preventDefault(); nav(1); return; }
   if (e.key === "Escape") {
    if (st.layer && st.layer.kind !== "slash") { st.layer = null; render(); return; }
    if (st.peek) { st.peek = null; render(); return; }
    if (st.pendingBranch) { st.pendingBranch = null; render(); }
   }
  }
  root.addEventListener("keydown", onKey);
  root.addEventListener("mouseup", onMouseUp);

  // pending sub-page: rendered as a page with only the composer
  var baseRenderThread = renderThreadPage;
  renderThreadPage = function (t, subId, inPeek) {
   if (st.route.pending && st.pendingBranch && !inPeek) {
    var pb = st.pendingBranch, u = turnOf(t, pb.turnId);
    var pg = pageShell({ title: "New branch", icon: pageIcon("branch", 52, "var(--text2)"), doc: true });
    pg.querySelector(".ptitle").style.color = "var(--text3)";
    pg.append(h("div.props", null, h("div.prow", null, h("div.pk", null, svg("rel", 15), "Branch of"), h("div.pv", null, mention(t, u))), h("div.prow", null, h("div.pk", null, svg("status", 15), "Status"), h("div.pv", null, h("span.muted", { text: "Not asked yet" })))));
    pg.append(h("div.hr"));
    if (pb.quote) pg.append(h("div.quote", { style: "color:var(--anchor)" }, h("span", { class: "t2" }, md(pb.quote))));
    pg.append(composer({ key: "pending", autofocus: true, placeholder: "Ask about this passage. The main conversation is unchanged.", agentFrom: u, hint: "This sub-page keeps the conversation up to " + (pb.paragraph != null ? "¶" + (pb.paragraph + 1) : "the answer") + " as context.",
     onSend: function (q) { st.pendingBranch = null; addBranch(t, u, pb.paragraph != null ? { turnId: u.id, paragraph: pb.paragraph, quote: pb.quote } : null, q); }, onCancel: function () { st.pendingBranch = null; nav(-1); } }));
    return pg;
   }
   return baseRenderThread(t, subId, inPeek);
  };

  // initial route tweaks
  if (V.peek && ctx.variant === "e") { /* open with a peek to show the idiom */ st.peek = { k: "page", t: "t2" }; }
  render(0);
  var tickId = setInterval(function () {
   root.querySelectorAll("[data-el]").forEach(function (e) { var a = e.getAttribute("data-el").split("|"), t = thr(a[0]), u = t && turnOf(t, a[1]); if (u && u.status === "running") e.textContent = dur(elapsed(u)); });
  }, 1000);

  return function cleanup() {
   timers.forEach(clearTimeout); clearInterval(tickId);
   Object.keys(runs).forEach(function (k) { clearInterval(runs[k].timer); });
   root.removeEventListener("keydown", onKey); root.removeEventListener("mouseup", onMouseUp);
   root.removeAttribute("tabindex");
   root.replaceChildren();
  };
 }

 window.SessionMocks.register({
  id: "notion", round: 2,
  name: "Pages & Research database",
  reference: "Notion",
  summary: "Every question is a page in a per-workspace Research database. The conversation is written into the page as blocks, branches are toggles or sub-pages, a floating page map shows the research tree, and notes link answers with @-mentions and backlinks.",
  principles: [
   "Notion sidebar: workspace switcher, Search, Home, Inbox, Favorites, a page tree per workspace, Private. Notion's 'Teamspaces' header is renamed 'Workspaces' so the app uses one word for the container (UX-04).",
   "A thread is a page in Research. Folder, Status, Provider, Model, Tags and Sources are properties, so filing never removes a page from the database (UX-05).",
   "The conversation reads top to bottom as blocks: question, answer header with provider, model and effort, paragraphs, sources, a collapsed run log. Follow-ups continue below; branches sit under the paragraph they came from.",
   "A floating 'On this page' map (Notion's table of contents) shows the research tree: questions, follow-ups and nested branches, with run state (UX-09).",
   "Three keep marks, all Notion's: Favorite (replaces Bookmark), Highlight in colours, Comment (a highlight with a note). Star is removed. Right-click and the … menu show the same actions (UX-06, UX-07).",
   "Database views (Table, Board, Gallery, List, Timeline) replace the feed; boards and grouped tables use Status groups: Needs you, In progress, Complete. Inbox collects finished, failed, queued and waiting runs.",
   "'Post to network' is removed; Share states that pages stay on this Mac. Notion keys: ⌘K search over answer text, ⌘J Ask AI, ⌘\\ sidebar, ⌘[ ⌘] history, / and @ in notes, + and ⋮⋮ handles."
  ],
  chat: "Ask from Home's Ask box, the AI block at the end of a page, or a note's /Ask AI block; Enter sends and the answer streams into the page with a live run line (step, ticking elapsed time, Stop). A Follow-up / Branch switch says what will happen; a follow-up sent during a run is queued with an explanation; failed runs offer Retry and a waiting run shows a reply box. Variant C moves the composer into a page-bound panel that acts as the run console.",
  knowledge: "Threads, notes, highlights and sources are linked pages and database rows: notes mention threads or single answers with @ inline, every page lists its backlinks, and Highlights and Sources are databases related to the answers they came from. Any paragraph or highlight can be added to a note with a link back; highlights can be recoloured, commented or removed. The page map shows each thread's tree, and the slash menu inserts Ask AI blocks, linked Research views and highlight embeds.",
  firstRun: "A new workspace opens on a Getting started page instead of an empty feed: one paragraph on what Session does, agent status in one line (expandable to copyable sign-in commands that update without a refresh button), and an Ask block with suggested questions, all above the fold; below are toggles on follow-up vs. branch vs. queue, templates and a sample workspace. Home also carries a one-line explanation with a Getting started link.",
  changes: [
   "Thread pages: properties collapse to Status, Agent and Folder plus 'N more properties', so the first question is visible without scrolling (was ~300px of properties).",
   "Added a floating 'On this page' map of the research tree (questions, follow-ups, nested branches, run-state dots) with scroll tracking; resolves UX-09, which r1 left open.",
   "Board and the grouped table use Notion status groups (Needs you / In progress / Complete): three columns fit at 1280px instead of five scrolling ones; variant E now opens on the grouped table.",
   "Variant C's panel is a run console (tree-ordered runs with model, steps, queue and errors) instead of repeating answer text that is already on the page.",
   "Getting started puts the Ask block above the fold: shorter cover, agent status collapsed to one line unless no agent is ready. Home gains a one-line explanation and a Getting started link.",
   "One menu for pages: right-click on rows, cards and sidebar pages shows the same actions as …; Star removed; highlights open a popover with Add to note and Remove.",
   "Polish: elapsed time ticks every second, note mentions flow inline, 'Workspaces' replaces 'Teamspaces', smaller full-page database header, unused CSS, icons and the bookmark block removed."
  ],
  variants: VARIANTS,
  fonts: "family=Inter:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700",
  css: css,
  mount: mount
 });
})();
