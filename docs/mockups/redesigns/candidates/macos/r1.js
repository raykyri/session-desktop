/* Session redesign candidate "macos", round 1.
 * Reference: macOS system apps (Mail, Finder, Xcode, Pages, Freeform, System Settings) and the Apple HIG.
 * Plain browser JS. Registers with window.SessionMocks.
 */
(() => {
	"use strict";
	var SC = "m-macos-r1";

	/* ------------------------------------------------------------------ icons (SF Symbols-like, 16pt grid) */
	var IC = {
		tray: '<path d="M2.5 9.5h3l1 2h3l1-2h3"/><path d="M2.5 9.5 4.1 4.3a1 1 0 0 1 1-.8h5.8a1 1 0 0 1 1 .8l1.6 5.2v3a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>',
		bubbles: '<path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H7.2L4.5 13v-2.6a2 2 0 0 1-2-1.9z"/>',
		bubble2: '<path d="M1.8 3.8a1.6 1.6 0 0 1 1.6-1.6h5.4a1.6 1.6 0 0 1 1.6 1.6v2.8a1.6 1.6 0 0 1-1.6 1.6H5.6L3.4 10V8.2a1.6 1.6 0 0 1-1.6-1.6z"/><path d="M12.2 6.2a1.6 1.6 0 0 1 2 1.5v2.6a1.6 1.6 0 0 1-1.6 1.6v1.7l-2.1-1.7H8.6a1.6 1.6 0 0 1-1.5-1"/>',
		bookmark: '<path d="M4.5 2.5h7v11l-3.5-2.6-3.5 2.6z"/>',
		bookmarkf: '<path d="M4.5 2.5h7v11l-3.5-2.6-3.5 2.6z" fill="currentColor"/>',
		draft: '<path d="M9.5 2.5h-5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-7z"/><path d="M9.5 2.5v3h3"/><path d="M5.8 9h4.4M5.8 11h2.6"/>',
		archive: '<rect x="2" y="3" width="12" height="3.2" rx=".8"/><path d="M3 6.2v6.3a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6.2"/><path d="M6.5 9h3"/>',
		highlighter: '<path d="m9.8 2.6 3.6 3.6-5.6 5.6H4.2V8.2z"/><path d="M2.5 14h5"/><path d="m7.6 4.8 3.6 3.6"/>',
		note: '<rect x="3.5" y="2.5" width="9" height="11" rx="1.5"/><path d="M5.8 5.8h4.4M5.8 8h4.4M5.8 10.2h2.6"/>',
		globe: '<circle cx="8" cy="8" r="5.6"/><path d="M2.4 8h11.2M8 2.4c-2.2 2.2-2.2 9 0 11.2M8 2.4c2.2 2.2 2.2 9 0 11.2"/>',
		map: '<circle cx="4" cy="4.5" r="1.8"/><circle cx="12" cy="5" r="1.8"/><circle cx="7" cy="12" r="1.8"/><path d="M5.8 4.6h4.4M4.8 6.2l1.4 4M11 6.6l-2.8 4"/>',
		folder: '<path d="M2 4.6a1 1 0 0 1 1-1h3.1l1.4 1.5H13a1 1 0 0 1 1 1v6.3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>',
		stack: '<rect x="1.8" y="4" width="12.4" height="8.4" rx="2"/><path d="M1.8 9.2h12.4"/><circle cx="11.4" cy="10.8" r=".55" fill="currentColor"/>',
		gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.9M8 12.3v1.9M1.8 8h1.9M12.3 8h1.9M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3"/>',
		search: '<circle cx="7" cy="7" r="4.3"/><path d="m10.2 10.2 3.3 3.3"/>',
		compose: '<path d="M12.5 8.6v3.9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h3.9"/><path d="m11.7 2.3 2 2-5.3 5.3-2.6.6.6-2.6z"/>',
		sidebarL: '<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M6 2.5v11M3.2 5h1.2M3.2 7h1.2"/>',
		sidebarR: '<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M10 2.5v11M11.6 5h1.2M11.6 7h1.2"/>',
		branch: '<path d="M4.5 13.5v-11"/><path d="M4.5 9.5c0-2.6 1.9-4 4.5-4h3.5"/><path d="m10.8 3.6 1.9 1.9-1.9 1.9"/>',
		followup: '<path d="M3.5 2.8v4.7a2 2 0 0 0 2 2h7"/><path d="m10 7 2.5 2.5L10 12"/>',
		question: '<circle cx="8" cy="8" r="5.6"/><path d="M6.4 6.4a1.7 1.7 0 1 1 2.4 1.5c-.5.3-.8.6-.8 1.2v.2"/><path d="M8 11.3v.1"/>',
		chevR: '<path d="M6 3.5 10.5 8 6 12.5"/>',
		chevD: '<path d="M3.5 6 8 10.5 12.5 6"/>',
		chevL: '<path d="M10 3.5 5.5 8 10 12.5"/>',
		updown: '<path d="M5.3 6 8 3.3 10.7 6M5.3 10 8 12.7 10.7 10"/>',
		info: '<circle cx="8" cy="8" r="5.6"/><path d="M8 7.3v3.9M8 5v.1"/>',
		cpu: '<rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M6.6 6.6h2.8v2.8H6.6zM6 1.8v2M10 1.8v2M6 12.2v2M10 12.2v2M1.8 6h2M1.8 10h2M12.2 6h2M12.2 10h2"/>',
		list: '<path d="M6 4h7.5M6 8h7.5M6 12h7.5"/><circle cx="3" cy="4" r=".5" fill="currentColor"/><circle cx="3" cy="8" r=".5" fill="currentColor"/><circle cx="3" cy="12" r=".5" fill="currentColor"/>',
		outline: '<path d="M2.5 3.5h11M5.5 6.5h8M5.5 9.5h8M8.5 12.5h5"/><path d="M2.8 6.5v6h3"/>',
		columns: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.6"/><path d="M5.8 2.5v11M10.2 2.5v11"/>',
		link: '<path d="M6.8 9.2a2.5 2.5 0 0 0 3.5 0l2.3-2.3a2.5 2.5 0 0 0-3.5-3.5l-.8.8"/><path d="M9.2 6.8a2.5 2.5 0 0 0-3.5 0L3.4 9.1a2.5 2.5 0 0 0 3.5 3.5l.8-.8"/>',
		plus: '<path d="M8 3v10M3 8h10"/>',
		minus: '<path d="M3 8h10"/>',
		x: '<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>',
		ellipsis: '<circle cx="4" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12" cy="8" r=".9" fill="currentColor"/>',
		ellipsisC: '<circle cx="8" cy="8" r="5.8"/><circle cx="5.4" cy="8" r=".6" fill="currentColor"/><circle cx="8" cy="8" r=".6" fill="currentColor"/><circle cx="10.6" cy="8" r=".6" fill="currentColor"/>',
		up: '<path d="M8 12.5v-9M4.2 7.2 8 3.4l3.8 3.8"/>',
		stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor"/>',
		clock: '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8l2.2 1.4"/>',
		warn: '<path d="M8 2.6 14 13H2z"/><path d="M8 6.5v3M8 11.2v.1"/>',
		check: '<path d="m3.5 8.5 3 3 6-7"/>',
		checkC: '<circle cx="8" cy="8" r="5.6"/><path d="m5.5 8.2 1.8 1.8 3.4-3.8"/>',
		xC: '<circle cx="8" cy="8" r="5.6"/><path d="m6 6 4 4M10 6l-4 4"/>',
		clarify: '<path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H7.2L4.5 13v-2.6a2 2 0 0 1-2-1.9z"/><path d="M6.8 5.2a1.3 1.3 0 1 1 1.8 1.2c-.4.2-.6.4-.6.8M8 8.6v.1"/>',
		tag: '<path d="M2.5 3.5v4l6 6 5-5-6-6h-4a1 1 0 0 0-1 1z"/><circle cx="5.3" cy="5.6" r=".9"/>',
		bulb: '<path d="M6 12.4h4M6.6 14h2.8"/><path d="M8 2a4 4 0 0 0-2.4 7.2c.5.4.8 1 .8 1.6v.2h3.2v-.2c0-.6.3-1.2.8-1.6A4 4 0 0 0 8 2z"/>',
		doc: '<path d="M9.5 2.5h-5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-7z"/><path d="M9.5 2.5v3h3"/>',
		docsearch: '<path d="M8 13.5H4.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h5l3 3v2.5"/><circle cx="10.5" cy="10.5" r="2"/><path d="m12 12 1.6 1.6"/>',
		download: '<path d="M8 2.5v7.5M5 7l3 3 3-3M3 13.5h10"/>',
		terminal: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.6"/><path d="m4.5 6 2 2-2 2M8 10.5h3.5"/>',
		pencil: '<path d="m10.8 2.6 2.6 2.6-7.5 7.5-3.2.6.6-3.2z"/>',
		copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.4"/><path d="M10.5 5.5V3.9a1.4 1.4 0 0 0-1.4-1.4H3.9a1.4 1.4 0 0 0-1.4 1.4v5.2a1.4 1.4 0 0 0 1.4 1.4h1.6"/>',
		bell: '<path d="M4 11.2V7.4a4 4 0 0 1 8 0v3.8l1.2 1.3H2.8z"/><path d="M6.6 13.8a1.5 1.5 0 0 0 2.8 0"/>',
		trash: '<path d="M3 4.5h10M6.2 4.5V3h3.6v1.5M4.3 4.5l.6 8.4a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.6-8.4"/>',
		quote: '<path d="M3 9.5c0-3 1.2-4.5 3.2-5M9.2 9.5c0-3 1.2-4.5 3.2-5"/><circle cx="4.6" cy="10.3" r="1.6"/><circle cx="10.8" cy="10.3" r="1.6"/>',
		sparkle: '<path d="M8 2.2c.4 2.7 1.1 3.4 3.8 3.8-2.7.4-3.4 1.1-3.8 3.8-.4-2.7-1.1-3.4-3.8-3.8 2.7-.4 3.4-1.1 3.8-3.8z"/><path d="M12 9.8c.2 1.3.6 1.7 1.8 1.8-1.2.2-1.6.6-1.8 1.8-.2-1.2-.6-1.6-1.8-1.8 1.2-.1 1.6-.5 1.8-1.8z"/>',
		arrowR: '<path d="M3 8h10M9 4l4 4-4 4"/>',
		back: '<path d="M10 3.5 5.5 8 10 12.5"/>',
		fwd: '<path d="M6 3.5 10.5 8 6 12.5"/>',
		play: '<path d="M5 3.5v9l7.5-4.5z"/>',
		zoomIn: '<circle cx="7" cy="7" r="4.3"/><path d="m10.2 10.2 3.3 3.3M5 7h4M7 5v4"/>',
		zoomOut: '<circle cx="7" cy="7" r="4.3"/><path d="m10.2 10.2 3.3 3.3M5 7h4"/>',
		retry: '<path d="M12.8 8a4.8 4.8 0 1 1-1.5-3.5"/><path d="M12.6 2.5v2.8H9.8"/>'
	};
	function svg(name, size) {
		var s = size || 16;
		return '<svg viewBox="0 0 16 16" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (IC[name] || "") + "</svg>";
	}

	/* ------------------------------------------------------------------ CSS */
	var CSS = `
§{--acc:#0a7aff;--acc-rgb:10,122,255;--onacc:#fff;--win:#ffffff;--side1:rgba(234,232,238,.97);--side2:rgba(226,225,232,.97);--tb:#ffffff;--pane:#f6f6f7;--pane2:#efeff1;
--lbl:rgba(0,0,0,.86);--lbl2:rgba(0,0,0,.55);--lbl3:rgba(0,0,0,.32);--sep:rgba(0,0,0,.1);--sep2:rgba(0,0,0,.06);--fill:rgba(0,0,0,.045);--fill2:rgba(0,0,0,.08);--fill3:rgba(0,0,0,.12);
--ctl:#ffffff;--ctl-b:rgba(0,0,0,.13);--ctl-sh:0 .5px 1.5px rgba(0,0,0,.14);--menu:rgba(244,244,246,.97);--menu-b:rgba(0,0,0,.14);--sheet:#f3f3f5;--card:#ffffff;
--red:#ff3b30;--orange:#ff9500;--yellow:#ffcc00;--green:#28b44e;--blue:#0a7aff;--purple:#af52de;--pink:#ff2d55;--gray:#8e8e93;--teal:#30b0c7;
--hl-amber:rgba(255,204,0,.36);--hl-green:rgba(52,199,89,.26);--hl-blue:rgba(10,122,255,.18);--hl-pink:rgba(255,45,85,.2);--anchor:rgba(10,122,255,.09);
--qbub:#0a7aff;--abub:#e9e9eb;--code:rgba(0,0,0,.055);--shadow:0 10px 36px rgba(0,0,0,.22),0 0 0 .5px rgba(0,0,0,.18);--dim:rgba(0,0,0,.18);
position:absolute;inset:0;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Inter','Helvetica Neue',sans-serif;font-size:13px;line-height:1.38;color:var(--lbl);-webkit-font-smoothing:antialiased;letter-spacing:-.003em;outline:none;background:var(--win);overflow:hidden}
§[data-theme=dark]{--acc:#0a84ff;--acc-rgb:10,132,255;--win:#1e1e1f;--side1:rgba(46,44,50,.97);--side2:rgba(40,39,44,.97);--tb:#232324;--pane:#262628;--pane2:#2c2c2e;
--lbl:rgba(255,255,255,.88);--lbl2:rgba(255,255,255,.55);--lbl3:rgba(255,255,255,.3);--sep:rgba(255,255,255,.1);--sep2:rgba(255,255,255,.06);--fill:rgba(255,255,255,.055);--fill2:rgba(255,255,255,.09);--fill3:rgba(255,255,255,.14);
--ctl:rgba(255,255,255,.1);--ctl-b:rgba(255,255,255,.08);--ctl-sh:0 .5px 1px rgba(0,0,0,.4);--menu:rgba(44,44,47,.97);--menu-b:rgba(255,255,255,.13);--sheet:#2a2a2c;--card:#2b2b2d;
--red:#ff453a;--orange:#ff9f0a;--yellow:#ffd60a;--green:#30d158;--blue:#0a84ff;--purple:#bf5af2;--pink:#ff375f;--gray:#98989d;--teal:#40c8e0;
--hl-amber:rgba(255,214,10,.27);--hl-green:rgba(48,209,88,.22);--hl-blue:rgba(10,132,255,.26);--hl-pink:rgba(255,55,95,.24);--anchor:rgba(10,132,255,.14);
--qbub:#0a84ff;--abub:#2f2f31;--code:rgba(255,255,255,.08);--shadow:0 12px 40px rgba(0,0,0,.55),0 0 0 .5px rgba(255,255,255,.14);--dim:rgba(0,0,0,.35)}
§ *{scrollbar-width:thin;scrollbar-color:var(--fill3) transparent}
§ .ic{display:inline-flex;align-items:center;justify-content:center;flex:none;line-height:0}
§ button{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:default}
§ input,§ textarea{font:inherit;color:inherit}
§ .win{position:absolute;inset:0;display:flex}
/* sidebar */
§ .side{flex:none;display:flex;flex-direction:column;background:linear-gradient(180deg,var(--side1),var(--side2));border-right:1px solid var(--sep);position:relative}
§ .side-top{height:52px;flex:none;display:flex;align-items:center;padding:0 10px 0 20px;gap:8px}
§ .tl{display:flex;gap:8px;align-items:center}
§ .tl i{width:12px;height:12px;border-radius:50%;display:block;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.18)}
§ .tl i:nth-child(1){background:#ff5f57}§ .tl i:nth-child(2){background:#febc2e}§ .tl i:nth-child(3){background:#28c840}
§ .side-scroll{flex:1;overflow:auto;padding:2px 10px 10px}
§ .sec{margin-top:10px}
§ .sec-h{display:flex;align-items:center;height:24px;padding:0 6px 0 8px;font-size:11px;font-weight:600;color:var(--lbl3);gap:4px;border-radius:5px}
§ .sec-h .grow{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
§ .sec-h .dis{opacity:0;color:var(--lbl2);transition:opacity .12s}
§ .sec-h:hover .dis,§ .sec-h .dis.on{opacity:1}
§ .sec-h .hbtn{width:18px;height:18px;border-radius:4px;color:var(--lbl2);opacity:0}
§ .sec-h:hover .hbtn{opacity:1}§ .sec-h .hbtn:hover{background:var(--fill2)}
§ .srow{display:flex;align-items:center;gap:7px;height:28px;padding:0 8px;border-radius:6px;color:var(--lbl);white-space:nowrap;position:relative}
§ .srow .ic{color:var(--acc)}
§ .srow .lbl{flex:1;overflow:hidden;text-overflow:ellipsis}
§ .srow .cnt{font-size:12px;color:var(--lbl2);font-variant-numeric:tabular-nums}
§ .srow .badge{font-size:11px;font-weight:600;color:var(--lbl2);background:var(--fill2);border-radius:9px;padding:0 6px;line-height:17px;font-variant-numeric:tabular-nums}
§ .srow .badge.acc{background:var(--acc);color:#fff}
§ .srow:hover{background:var(--fill)}
§ .srow.sel{background:var(--fill3)}
§ .srow.sel .cnt{color:var(--lbl)}
§ .srow .tw{width:12px;height:12px;color:var(--lbl3);margin-left:-4px;margin-right:-3px;transition:transform .12s}
§ .srow .tw.open{transform:rotate(90deg)}
§ .srow.thread .ic{color:var(--lbl2)}
§ .srow.thread{height:26px;font-size:12.5px}
§ .srow.br{height:24px;font-size:12px;color:var(--lbl2)}
§ .srow.br .ic{color:var(--lbl3)}
§ .side-foot{flex:none;border-top:1px solid var(--sep);padding:8px 10px;display:flex;align-items:center;gap:6px}
§ .agent-st{flex:1;display:flex;align-items:center;gap:7px;padding:4px 6px;border-radius:6px;min-width:0}
§ .agent-st:hover{background:var(--fill)}
§ .agent-st b{font-weight:500;display:block;font-size:12px}
§ .agent-st small{display:block;font-size:11px;color:var(--lbl2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
§ .dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block}
§ .ibtn{width:28px;height:28px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;color:var(--lbl2);flex:none}
§ .ibtn:hover{background:var(--fill2);color:var(--lbl)}
§ .ibtn.on{color:var(--acc)}
§ .ibtn[disabled]{opacity:.35}
/* main + toolbar */
§ .main{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--win)}
§ .tb{height:52px;flex:none;display:flex;align-items:center;border-bottom:1px solid var(--sep);background:var(--tb);padding-right:10px;gap:4px;position:relative}
§ .tb-title{flex:none;display:flex;flex-direction:column;justify-content:center;padding:0 12px 0 16px;min-width:0;overflow:hidden}
§ .tb-title b{font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:16px}
§ .tb-title small{font-size:11px;color:var(--lbl2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:14px}
§ .tb .grow{flex:1}
§ .tb .ibtn{width:32px;height:28px}
§ .tbsep{width:1px;height:18px;background:var(--sep);margin:0 4px}
§ .seg{display:inline-flex;background:var(--fill2);border-radius:7px;padding:2px;gap:0;flex:none}
§ .seg button{height:22px;min-width:30px;padding:0 9px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;gap:5px;color:var(--lbl2);font-size:12px;font-weight:500;position:relative}
§ .seg button+button:not(.on)::before{content:'';position:absolute;left:0;top:5px;bottom:5px;width:1px;background:var(--sep)}
§ .seg button.on+button::before{display:none}
§ .seg button.on{background:var(--ctl);color:var(--lbl);box-shadow:var(--ctl-sh)}
§[data-theme=dark] .seg button.on{background:rgba(255,255,255,.2)}
§ .seg.sm button{height:19px;font-size:11px;padding:0 8px}
§ .search{display:flex;align-items:center;gap:5px;height:28px;width:190px;border-radius:7px;background:var(--fill2);padding:0 8px;color:var(--lbl2);flex:none}
§ .search input{border:0;outline:0;background:none;flex:1;min-width:0;font-size:13px;color:var(--lbl)}
§ .search input::placeholder{color:var(--lbl2)}
§ .search:focus-within{box-shadow:0 0 0 3.5px rgba(var(--acc-rgb),.35);background:var(--ctl)}
§ .body{flex:1;min-height:0;display:flex}
/* content list */
§ .list{flex:none;width:280px;border-right:1px solid var(--sep);display:flex;flex-direction:column;background:var(--win);min-height:0}
§ .list-h{flex:none;height:32px;display:flex;align-items:center;gap:6px;padding:0 10px 0 14px;font-size:11.5px;color:var(--lbl2);border-bottom:1px solid var(--sep2)}
§ .list-h .grow{flex:1}
§ .list-s{flex:1;overflow:auto;padding:4px 8px 12px}
§ .lgrp{font-size:11px;font-weight:600;color:var(--lbl2);padding:12px 8px 4px;display:flex;gap:6px;align-items:center}
§ .lgrp .n{font-weight:400;color:var(--lbl3)}
§ .lrow{display:grid;grid-template-columns:14px 1fr auto;column-gap:6px;padding:8px 10px 9px 4px;border-radius:7px;position:relative}
§ .lrow+.lrow::after{content:'';position:absolute;left:24px;right:10px;top:0;height:1px;background:var(--sep2)}
§ .lrow.sel::after,§ .lrow.sel+.lrow::after{display:none}
§ .lrow .ud{width:8px;height:8px;border-radius:50%;background:var(--acc);margin:5px 0 0 3px}
§ .lrow .t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}
§ .lrow .tm{font-size:11.5px;color:var(--lbl2);white-space:nowrap;padding-top:1px}
§ .lrow .sn{grid-column:2/4;color:var(--lbl2);font-size:12px;line-height:1.36;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:1px}
§ .lrow .sn mark{background:var(--hl-amber);color:inherit;border-radius:2px}
§ .lrow .mt{grid-column:2/4;display:flex;align-items:center;gap:6px;margin-top:5px;font-size:11px;color:var(--lbl2);min-width:0;white-space:nowrap}
§ .lrow .mt .sp{flex:1}
§ .lrow .mt .fold{display:inline-flex;align-items:center;gap:3px;overflow:hidden;text-overflow:ellipsis}
§ .lrow .lic{margin-top:1px;color:var(--lbl2)}
§ .lrow.sel{background:var(--acc);color:#fff}
§ .lrow.sel .sn,§ .lrow.sel .tm,§ .lrow.sel .mt,§ .lrow.sel .lic{color:rgba(255,255,255,.82)}
§ .lrow.sel .ud{background:#fff}
§ .lrow.sel .st{background:rgba(255,255,255,.22);color:#fff}
§ .lrow.sel .pv{color:#fff}
§ .lrow.sel .tok{background:rgba(255,255,255,.2);color:#fff}
§ .lrow .hlbar{width:3px;border-radius:2px;margin:2px 0 2px 5px;align-self:stretch}
§ .scope{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--sep2);font-size:11.5px;color:var(--lbl2)}
/* status, tokens, provider */
§ .st{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:500;height:17px;padding:0 6px;border-radius:5px;white-space:nowrap}
§ .st.run{color:var(--acc);background:rgba(var(--acc-rgb),.12)}
§ .st.error{color:var(--red);background:color-mix(in srgb,var(--red) 13%,transparent)}
§ .st.attention{color:var(--orange);background:color-mix(in srgb,var(--orange) 15%,transparent)}
§ .st.plain{color:var(--lbl2);background:var(--fill2)}
§ .st.ok{color:var(--green);background:color-mix(in srgb,var(--green) 13%,transparent)}
§ .spin{width:10px;height:10px;border-radius:50%;border:1.6px solid currentColor;border-right-color:transparent;animation:mspin .8s linear infinite;flex:none;display:inline-block}
@keyframes mspin{to{transform:rotate(360deg)}}
§ .pv{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;color:var(--lbl2)}
§ .pv .g{width:12px;height:12px;border-radius:3.5px;display:inline-flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;color:#fff;flex:none}
§ .tok{display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 7px;border-radius:9px;background:rgba(var(--acc-rgb),.13);color:var(--acc);font-size:11px;font-weight:500;white-space:nowrap}
§ .tok.gray{background:var(--fill2);color:var(--lbl)}
§ .tok .x{opacity:.6;margin-right:-3px}
§ .tok .x:hover{opacity:1}
/* detail */
§ .detail{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--win);position:relative}
§ .jump{flex:none;height:30px;display:flex;align-items:center;gap:2px;padding:0 10px;border-bottom:1px solid var(--sep2);font-size:12px;color:var(--lbl2);white-space:nowrap;overflow:hidden}
§ .jump .js{display:inline-flex;align-items:center;gap:4px;padding:2px 5px;border-radius:4px;max-width:220px;min-width:28px;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto}
§ .jump .js.cur{flex:0 0 auto;max-width:300px}
§ .jump .sepc{flex:none}
§ .jump .js span{overflow:hidden;text-overflow:ellipsis}
§ .jump .js:hover{background:var(--fill2);color:var(--lbl)}
§ .jump .js.cur{color:var(--lbl);font-weight:500}
§ .jump .sepc{color:var(--lbl3)}
§ .jump .grow{flex:1}
§ .conv{flex:1;overflow:auto;user-select:text;padding:6px 0 28px}
§ .conv-in{max-width:640px;margin:0 auto;padding:0 26px 0 30px}
§ .ttl{padding:18px 0 6px}
§ .ttl h1{font-size:20px;font-weight:700;margin:0;letter-spacing:-.015em;line-height:1.25}
§ .ttl .sub{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:7px;font-size:12px;color:var(--lbl2)}
§ .recap{margin:10px 0 4px;padding:9px 12px;border-radius:8px;background:var(--fill);font-size:12.5px;line-height:1.45;color:var(--lbl)}
§ .recap b{font-size:11px;font-weight:600;color:var(--lbl2);display:block;margin-bottom:2px}
§ .turn{padding:18px 0 4px;position:relative}
§ .turn+.turn{border-top:1px solid var(--sep2)}
§ .turn.focus .qbox{box-shadow:inset 3px 0 0 var(--acc)}
§ .turn.flash{animation:mflash 1.4s ease}
@keyframes mflash{0%,30%{background:rgba(var(--acc-rgb),.08)}100%{background:transparent}}
§ .qhead{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--lbl2);margin-bottom:6px;font-weight:500}
§ .qhead .rel{display:inline-flex;align-items:center;gap:4px;text-transform:none;color:var(--lbl2)}
§ .qhead .grow{flex:1}
§ .qbox{font-size:14px;font-weight:600;line-height:1.45;padding:2px 0 2px 12px;border-left:3px solid var(--fill3);border-radius:0;color:var(--lbl)}
§ .qbox code{font-weight:500}
§ .ameta{display:flex;align-items:center;gap:8px;margin:12px 0 8px;font-size:11.5px;color:var(--lbl2);flex-wrap:wrap}
§ .ameta .grow{flex:1}
§ .ans{font-size:14px;line-height:1.58}
§ .para{margin:0 0 10px;position:relative}
§ .para.hasb::before{content:'';position:absolute;left:-16px;top:3px;bottom:3px;width:2px;border-radius:1px;background:var(--acc);opacity:.7}
§ .ans code,§ .qbox code,§ .bub code,§ .preview code{font-family:'SF Mono',ui-monospace,Menlo,'JetBrains Mono',monospace;font-size:.88em;background:var(--code);padding:.5px 4px;border-radius:4px}
§ .ans pre{font-family:'SF Mono',ui-monospace,Menlo,'JetBrains Mono',monospace;font-size:12px;line-height:1.5;background:var(--fill);border:1px solid var(--sep2);border-radius:8px;padding:10px 12px;overflow:auto;margin:0 0 10px;white-space:pre}
§ .ans h3{font-size:14px;margin:4px 0 4px;font-weight:700}
§ .ans a{color:var(--acc);text-decoration:none}
§ mark.hl{color:inherit;border-radius:2px;padding:1px 0;cursor:pointer}
§ mark.hl.amber{background:var(--hl-amber)}§ mark.hl.green{background:var(--hl-green)}§ mark.hl.blue{background:var(--hl-blue)}§ mark.hl.pink{background:var(--hl-pink)}
§ mark.anc{background:var(--anchor);color:inherit;border-bottom:1.5px dotted var(--acc);cursor:pointer}
§ mark.flashm{animation:mflash2 1.6s ease}
@keyframes mflash2{0%,40%{box-shadow:0 0 0 3px rgba(var(--acc-rgb),.45)}100%{box-shadow:none}}
§ .bchips{display:flex;flex-wrap:wrap;gap:6px;margin:-2px 0 12px}
§ .bchip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px 0 7px;border-radius:6px;border:1px solid var(--sep);background:var(--card);font-size:12px;color:var(--lbl);max-width:100%;box-shadow:0 .5px 1px rgba(0,0,0,.05)}
§ .bchip .ic{color:var(--acc)}
§ .bchip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
§ .bchip small{color:var(--lbl2);font-size:11px}
§ .bchip:hover{border-color:rgba(var(--acc-rgb),.5)}
§ .callout{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:9px;margin:8px 0 12px;font-size:12.5px;line-height:1.45}
§ .callout .ic{margin-top:1px}
§ .callout b{display:block;font-weight:600;margin-bottom:2px}
§ .callout .acts{display:flex;gap:6px;margin-top:8px}
§ .callout.error{background:color-mix(in srgb,var(--red) 9%,transparent);color:var(--lbl)}§ .callout.error .ic{color:var(--red)}
§ .callout.attention{background:color-mix(in srgb,var(--orange) 11%,transparent)}§ .callout.attention .ic{color:var(--orange)}
§ .callout.plain{background:var(--fill)}§ .callout.plain .ic{color:var(--lbl2)}
§ .callout.run{background:rgba(var(--acc-rgb),.07)}§ .callout.run .ic{color:var(--acc)}
§ .working{display:flex;align-items:center;gap:8px;color:var(--acc);font-size:12px;margin:2px 0 12px}
§ .working .lab{color:var(--lbl2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
§ .caret{display:inline-block;width:7px;height:15px;background:var(--acc);vertical-align:-2px;margin-left:2px;border-radius:1px;animation:mblink 1s steps(2) infinite}
@keyframes mblink{50%{opacity:0}}
§ .bctx{margin:16px 0 0;padding:10px 12px;border-radius:9px;background:var(--fill);font-size:12.5px}
§ .bctx .h{display:flex;align-items:center;gap:6px;color:var(--lbl2);font-size:11.5px;margin-bottom:5px}
§ .bctx blockquote{margin:0;padding-left:10px;border-left:2px solid var(--acc);color:var(--lbl);line-height:1.45}
§ .bctx .lnk{color:var(--acc);font-size:11.5px;margin-top:6px;display:inline-block}
/* bubbles */
§ .bubrow{display:flex;flex-direction:column;align-items:flex-end;margin:16px 0 4px}
§ .bub{max-width:82%;padding:8px 13px;border-radius:17px;font-size:13.5px;line-height:1.45}
§ .bub.q{background:var(--qbub);color:#fff;border-bottom-right-radius:5px}
§ .bub.q code{background:rgba(255,255,255,.2)}
§ .bubcap{font-size:11px;color:var(--lbl2);margin:4px 6px 0;display:flex;gap:6px;align-items:center}
§ .abubrow{display:flex;flex-direction:column;align-items:flex-start;margin:8px 0}
§ .bub.a{background:var(--abub);border-bottom-left-radius:5px;max-width:92%;padding:10px 14px}
§ .bub.a .para{margin-bottom:8px}§ .bub.a .para:last-child{margin-bottom:0}
§ .bub.a .ans{font-size:13.5px;line-height:1.5}
§ .bub.a .para.hasb::before{left:-10px}
§ .daysep{text-align:center;font-size:11px;color:var(--lbl2);margin:16px 0 0;font-weight:500}
/* composer */
§ .composer{flex:none;padding:10px 16px 12px;border-top:1px solid var(--sep2);background:var(--win)}
§ .cbox{max-width:640px;margin:0 auto;border:1px solid var(--ctl-b);border-radius:12px;background:var(--ctl);box-shadow:0 1px 3px rgba(0,0,0,.06)}
§[data-theme=dark] .cbox{background:#2a2a2c;border-color:rgba(255,255,255,.12)}
§ .cbox:focus-within{border-color:rgba(var(--acc-rgb),.6);box-shadow:0 0 0 3px rgba(var(--acc-rgb),.2)}
§ .cctx{display:flex;align-items:center;gap:6px;padding:8px 10px 0;font-size:11.5px;color:var(--lbl2)}
§ .cctx .tok{max-width:100%;overflow:hidden}
§ .cctx .tok span{overflow:hidden;text-overflow:ellipsis}
§ .cbox textarea{display:block;width:100%;border:0;outline:0;background:none;resize:none;padding:9px 12px 4px;font-size:13.5px;line-height:1.45;min-height:40px;max-height:140px}
§ .cbox textarea::placeholder{color:var(--lbl2)}
§ .cbar{display:flex;align-items:center;gap:6px;padding:4px 6px 6px 8px}
§ .cbar .grow{flex:1}
§ .send{width:26px;height:26px;border-radius:50%;background:var(--acc);color:#fff;display:inline-flex;align-items:center;justify-content:center;flex:none}
§ .send[disabled]{background:var(--fill3);color:var(--lbl3)}
§ .chelp{max-width:640px;margin:6px auto 0;font-size:11px;color:var(--lbl2);display:flex;gap:6px;align-items:center;padding:0 4px}
§ .chelp .grow{flex:1}
/* pop-up buttons and controls */
§ .pop{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 4px 0 8px;border-radius:5px;background:var(--ctl);box-shadow:var(--ctl-sh),0 0 0 .5px var(--ctl-b);font-size:12px;white-space:nowrap;max-width:100%;min-width:0}
§ .pop>span{white-space:nowrap}
§ .pop .ic{color:var(--lbl2)}
§ .pop.flat{background:none;box-shadow:none;padding:0 4px 0 6px;color:var(--lbl2)}
§ .pop.flat:hover{background:var(--fill2);color:var(--lbl)}
§ .pop.wide{width:100%;justify-content:space-between;height:24px}
§ .btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:24px;padding:0 11px;border-radius:6px;background:var(--ctl);box-shadow:var(--ctl-sh),0 0 0 .5px var(--ctl-b);font-size:12.5px;white-space:nowrap}
§ .btn:active{filter:brightness(.95)}
§ .btn.pri{background:var(--acc);color:#fff;box-shadow:0 .5px 1px rgba(0,0,0,.2)}
§ .btn.lg{height:30px;padding:0 16px;font-size:13px;border-radius:7px}
§ .btn.sm{height:20px;font-size:11.5px;padding:0 8px;border-radius:5px}
§ .btn[disabled]{opacity:.45}
§ .lnk{color:var(--acc);cursor:pointer}
§ .chk{display:flex;align-items:center;gap:7px;font-size:12.5px;padding:3px 0}
§ .chk .box{width:14px;height:14px;border-radius:4px;background:var(--ctl);box-shadow:var(--ctl-sh),0 0 0 .5px var(--ctl-b);display:inline-flex;align-items:center;justify-content:center;color:#fff;flex:none}
§ .chk.on .box{background:var(--acc);box-shadow:none}
§ .chk small{color:var(--lbl2);font-size:11px;display:block}
§ .field{border:0;outline:0;background:var(--ctl);box-shadow:var(--ctl-sh),0 0 0 .5px var(--ctl-b);border-radius:5px;height:22px;padding:0 7px;font-size:12px;width:100%;color:var(--lbl)}
§ .field:focus{box-shadow:0 0 0 3px rgba(var(--acc-rgb),.35)}
/* inspector */
§ .insp{flex:none;width:252px;border-left:1px solid var(--sep);background:var(--pane);display:flex;flex-direction:column;min-height:0}
§ .itabs{flex:none;height:30px;display:flex;align-items:center;justify-content:center;gap:2px;border-bottom:1px solid var(--sep)}
§ .itabs button{width:30px;height:24px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;color:var(--lbl2)}
§ .itabs button:hover{color:var(--lbl)}
§ .itabs button.on{color:var(--acc)}
§ .iscroll{flex:1;overflow:auto;padding:4px 0 16px}
§ .isec{padding:10px 14px 12px;border-bottom:1px solid var(--sep2)}
§ .isec:last-child{border-bottom:0}
§ .isec h4{margin:0 0 8px;font-size:11px;font-weight:700;color:var(--lbl);display:flex;align-items:center;gap:6px}
§ .isec h4 .grow{flex:1}
§ .isec h4 small{font-weight:400;color:var(--lbl2)}
§ .isec p{margin:0;font-size:12px;line-height:1.45;color:var(--lbl2)}
§ .form{display:grid;grid-template-columns:62px 1fr;gap:7px 8px;align-items:center;font-size:12px}
§ .form>label{text-align:right;color:var(--lbl2);font-size:11.5px}
§ .form .v{min-width:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
§ .form .ro{color:var(--lbl);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
§ .tokf{display:flex;flex-wrap:wrap;gap:4px;padding:3px;border-radius:5px;background:var(--ctl);box-shadow:var(--ctl-sh),0 0 0 .5px var(--ctl-b);min-height:24px;width:100%;align-items:center}
§ .tokf input{border:0;outline:0;background:none;font-size:11.5px;flex:1;min-width:40px;height:18px}
§ .step{display:grid;grid-template-columns:18px 1fr auto;gap:2px 6px;padding:5px 0;font-size:12px;align-items:start}
§ .step+.step{border-top:1px solid var(--sep2)}
§ .step .ic{color:var(--lbl2);margin-top:1px}
§ .step .d{grid-column:2/4;font-size:11px;color:var(--lbl2);font-family:'SF Mono',ui-monospace,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
§ .step .ms{font-size:11px;color:var(--lbl3);font-variant-numeric:tabular-nums}
§ .step.err .ic{color:var(--red)}§ .step.running .ic{color:var(--acc)}
§ .step .lb{overflow-wrap:anywhere}
§ .srcrow{display:grid;grid-template-columns:22px 1fr;gap:1px 8px;padding:6px 6px;border-radius:6px;font-size:12px;align-items:center}
§ .srcrow:hover{background:var(--fill)}
§ .fav{width:22px;height:22px;border-radius:5px;background:var(--fill2);display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--lbl2);grid-row:1/3}
§ .srcrow b{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
§ .srcrow small{font-size:11px;color:var(--lbl2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
§ .hlrow{padding:7px 8px;border-radius:6px;display:grid;grid-template-columns:4px 1fr;gap:4px 9px;font-size:12px}
§ .hlrow:hover{background:var(--fill)}
§ .hlrow .bar{border-radius:2px;grid-row:1/4}
§ .hlrow .qt{line-height:1.4}
§ .hlrow .nt{color:var(--lbl2);font-size:11.5px}
§ .hlrow textarea{width:100%;font-size:11.5px;border:0;border-radius:5px;background:var(--ctl);box-shadow:0 0 0 .5px var(--ctl-b);padding:4px 6px;resize:none;outline:0;height:40px}
§ .lkrow{display:flex;align-items:center;gap:7px;padding:5px 6px;border-radius:6px;font-size:12px}
§ .lkrow:hover{background:var(--fill)}
§ .lkrow>span:not(.ic):not(.spin){flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
§ .lkrow .ic{color:var(--lbl2)}
§ .lkrow small{color:var(--lbl3);font-size:11px}
§ .empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--lbl3);gap:6px;height:100%;padding:24px}
§ .empty b{font-size:20px;font-weight:600;color:var(--lbl3)}
§ .empty.sm b{font-size:13px}
§ .empty small{font-size:12px}
/* overlay, menu, popover, sheet */
§ .ov{position:absolute;inset:0;z-index:50}
§ .ov.dim{background:var(--dim)}
§ .menu{position:absolute;min-width:200px;max-width:300px;background:var(--menu);border-radius:9px;box-shadow:var(--shadow);padding:5px;backdrop-filter:blur(20px);font-size:13px;z-index:2}
§ .mi{display:flex;align-items:center;gap:8px;height:22px;padding:0 8px 0 6px;border-radius:5px;white-space:nowrap;color:var(--lbl)}
§ .mi .ck{width:12px;flex:none;color:inherit}
§ .mi .ic{color:var(--lbl2)}
§ .mi .l{flex:1;overflow:hidden;text-overflow:ellipsis}
§ .mi .sc{color:var(--lbl3);font-size:12px;margin-left:16px}
§ .mi:hover:not(.dis){background:var(--acc);color:#fff}
§ .mi:hover:not(.dis) .ic,§ .mi:hover:not(.dis) .sc{color:rgba(255,255,255,.85)}
§ .mi.dis{color:var(--lbl3)}
§ .mhead{font-size:11px;font-weight:600;color:var(--lbl2);padding:5px 8px 2px 26px}
§ .msep{height:1px;background:var(--sep);margin:5px 6px}
§ .hud{position:absolute;display:flex;gap:1px;background:var(--menu);border-radius:8px;box-shadow:var(--shadow);padding:3px;z-index:3}
§ .hud button{height:26px;padding:0 9px;border-radius:5px;display:inline-flex;align-items:center;gap:5px;font-size:12px}
§ .hud button:hover{background:var(--fill2)}
§ .hud .vs{width:1px;background:var(--sep);margin:5px 2px}
§ .sheet{position:absolute;left:50%;top:52px;transform:translateX(-50%);background:var(--sheet);border-radius:0 0 12px 12px;box-shadow:var(--shadow);overflow:hidden;display:flex;flex-direction:column;animation:msheet .22s ease-out}
@keyframes msheet{from{transform:translate(-50%,-14px);opacity:0}to{transform:translate(-50%,0);opacity:1}}
§ .sheet .sb{flex:1;overflow:auto;padding:26px 34px 10px}
§ .sheet .sf{flex:none;display:flex;align-items:center;gap:8px;padding:14px 20px;border-top:1px solid var(--sep2)}
§ .sheet .sf .grow{flex:1}
§ .sheet h2{font-size:22px;font-weight:700;margin:10px 0 6px;text-align:center;letter-spacing:-.015em}
§ .sheet .lead{text-align:center;color:var(--lbl2);font-size:13px;line-height:1.5;margin:0 auto 16px;max-width:470px}
§ .appicon{width:64px;height:64px;border-radius:15px;margin:0 auto;display:flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(160deg,#5aa8ff,#2a5bd7);box-shadow:0 3px 10px rgba(0,60,180,.3),inset 0 0 0 .5px rgba(255,255,255,.25)}
§ .pdots{display:flex;gap:6px}§ .pdots i{width:6px;height:6px;border-radius:50%;background:var(--fill3)}§ .pdots i.on{background:var(--lbl2)}
§ .defs{display:grid;grid-template-columns:28px 1fr;gap:10px 10px;margin:14px auto 0;max-width:500px;font-size:12.5px;line-height:1.45}
§ .defs .ic{width:28px;height:28px;border-radius:7px;background:rgba(var(--acc-rgb),.12);color:var(--acc)}
§ .defs b{display:block;font-size:13px}
§ .defs span{color:var(--lbl2)}
§ .agtbl{border-radius:10px;background:var(--card);box-shadow:0 0 0 .5px var(--sep);margin:6px 0 0}
§ .agrow{display:grid;grid-template-columns:30px 1fr auto;gap:2px 12px;align-items:center;padding:12px 14px}
§ .agrow+.agrow{border-top:1px solid var(--sep2)}
§ .agrow .g{width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;grid-row:1/3}
§ .agrow b{font-size:13px;font-weight:600}
§ .agrow small{color:var(--lbl2);font-size:11.5px;display:flex;gap:5px;align-items:center}
§ .agrow .cmd{grid-column:2/4;display:flex;align-items:center;gap:6px;margin-top:6px}
§ .agrow code{flex:1;font-family:'SF Mono',ui-monospace,Menlo,monospace;font-size:11.5px;background:var(--fill);border-radius:5px;padding:4px 8px}
§ .sample{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:10px 12px;border-radius:9px;background:var(--card);box-shadow:0 0 0 .5px var(--sep);margin-bottom:8px;font-size:12.5px;line-height:1.4}
§ .sample:hover{box-shadow:0 0 0 1.5px rgba(var(--acc-rgb),.6)}
§ .sample .ic{color:var(--acc)}
§ .sample small{display:block;color:var(--lbl2);font-size:11px;margin-top:2px}
§ .oq{position:absolute;left:50%;top:120px;transform:translateX(-50%);width:600px;background:var(--menu);border-radius:12px;box-shadow:var(--shadow);overflow:hidden;backdrop-filter:blur(24px)}
§ .oq-in{display:flex;align-items:center;gap:10px;padding:12px 16px;color:var(--lbl2)}
§ .oq-in input{flex:1;border:0;outline:0;background:none;font-size:20px;font-weight:300;color:var(--lbl)}
§ .oq-res{border-top:1px solid var(--sep);max-height:380px;overflow:auto;padding:6px}
§ .oq-g{font-size:11px;font-weight:600;color:var(--lbl2);padding:6px 10px 3px}
§ .oq-r{display:flex;align-items:center;gap:9px;padding:6px 10px;border-radius:6px;font-size:13px}
§ .oq-r .ic{color:var(--lbl2)}
§ .oq-r>span:not(.ic){flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
§ .oq-r small{color:var(--lbl2);font-size:11.5px;white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis}
§ .oq-r.on{background:var(--acc);color:#fff}§ .oq-r.on .ic,§ .oq-r.on small{color:rgba(255,255,255,.85)}
§ .oq-foot{border-top:1px solid var(--sep);padding:6px 14px;font-size:11px;color:var(--lbl2);display:flex;gap:14px}
/* columns browser */
§ .browser{flex:1;min-width:0;display:flex;overflow-x:auto;overflow-y:hidden;background:var(--win)}
§ .bcol{flex:none;width:186px;border-right:1px solid var(--sep);overflow:auto;padding:4px 5px}
§ .bcol.first{width:196px}
§ .bhead{font-size:11px;font-weight:600;color:var(--lbl2);padding:8px 8px 3px;display:flex;gap:5px;align-items:center}
§ .bhead>span:not(.ic){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
§ .bitem{display:flex;align-items:center;gap:6px;height:24px;padding:0 4px 0 7px;border-radius:5px;font-size:12.5px;white-space:nowrap}
§ .bitem .ic{color:var(--lbl2)}
§ .bitem>span:not(.ic):not(.spin):not(.dot):not(.n){flex:1;overflow:hidden;text-overflow:ellipsis}
§ .bitem>span.n{flex:none;font-size:11px;opacity:.7}
§ .bitem .chev{color:var(--lbl3)}
§ .bitem.sel{background:var(--acc);color:#fff}§ .bitem.sel .ic{color:#fff}
§ .bitem.path{background:var(--fill3)}
§ .preview{flex:1;min-width:316px;overflow:auto;padding:18px 24px;user-select:text}
§ .preview h2{font-size:16px;margin:4px 0 6px;font-weight:700}
§ .pvq{font-size:13px;font-weight:500;padding:8px 10px;border-radius:8px;background:var(--fill);margin:8px 0}
§ .preview .ans{font-size:13px;line-height:1.55}
/* outline (tree) table */
§ .otbl{flex:1;overflow:auto;font-size:12.5px}
§ .ohead{display:grid;grid-template-columns:1fr 112px 82px 54px;height:26px;align-items:center;border-bottom:1px solid var(--sep);padding:0 10px;font-size:11px;color:var(--lbl2);font-weight:500;position:sticky;top:0;background:var(--win);z-index:1}
§ .ohead span+span{border-left:1px solid var(--sep);padding-left:7px}
§ .orow{display:grid;grid-template-columns:1fr 112px 82px 54px;height:26px;align-items:center;padding:0 10px;white-space:nowrap}
§ .orow:nth-child(odd){background:var(--fill)}
§ .orow>span{overflow:hidden;text-overflow:ellipsis;padding-right:6px}
§ .orow>span+span{padding-left:8px;color:var(--lbl2)}
§ .orow .nm{display:flex;align-items:center;gap:5px}
§ .orow .tw{width:14px;height:14px;color:var(--lbl2);display:inline-flex;transition:transform .12s;flex:none}
§ .orow .tw.open{transform:rotate(90deg)}
§ .orow .tw.none{visibility:hidden}
§ .orow .nm .ic{color:var(--acc)}
§ .orow .nm span{overflow:hidden;text-overflow:ellipsis}
§ .orow.sel{background:var(--acc);color:#fff}§ .orow.sel>span{color:#fff}§ .orow.sel .ic,§ .orow.sel .tw{color:#fff}
§ .opv{flex:none;height:250px;border-top:1px solid var(--sep);overflow:auto;padding:12px 22px;user-select:text;background:var(--win)}
§ .opv .ans{font-size:13px;line-height:1.55}
/* notes outline */
§ .noted{flex:1;overflow:auto;padding:0 0 40px}
§ .noted-in{max-width:640px;margin:0 auto;padding:22px 30px}
§ .noted h1{font-size:22px;font-weight:700;margin:0 0 4px;outline:0;letter-spacing:-.015em}
§ .noted .meta{font-size:12px;color:var(--lbl2);display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
§ .nrow{display:flex;align-items:flex-start;gap:3px;padding:2px 0;font-size:14px;line-height:1.5}
§ .nrow .tw{width:16px;height:21px;color:var(--lbl3);display:inline-flex;align-items:center;justify-content:center;flex:none;transition:transform .12s}
§ .nrow .tw.open{transform:rotate(90deg)}
§ .nrow .tw.none{visibility:hidden}
§ .nrow .bul{width:14px;height:21px;display:inline-flex;align-items:center;justify-content:center;flex:none}
§ .nrow .bul i{width:5px;height:5px;border-radius:50%;background:var(--lbl2)}
§ .nrow .bul i.has{box-shadow:0 0 0 3px var(--fill3)}
§ .nrow .tx{flex:1;outline:0;min-width:0;user-select:text;padding:0 2px;border-radius:3px}
§ .nrow .tx:focus{background:rgba(var(--acc-rgb),.06)}
§ .nrow .ref{display:inline-flex;align-items:center;gap:4px;height:19px;padding:0 7px;margin:1px 0 0 6px;border-radius:5px;font-size:11.5px;background:var(--fill2);color:var(--lbl);white-space:nowrap;max-width:220px;flex:none}
§ .nrow .ref span{overflow:hidden;text-overflow:ellipsis}
§ .nrow .ref .ic{color:var(--acc)}
§ .nrow .ref:hover{background:rgba(var(--acc-rgb),.15)}
§ .nkids{margin-left:22px}
§ .nhint{margin-top:18px;font-size:11.5px;color:var(--lbl3)}
/* table (sources) */
§ .tbl{flex:1;overflow:auto;font-size:12.5px}
§ .thead{display:grid;grid-template-columns:1.6fr 1fr 1.4fr 50px;height:28px;align-items:center;border-bottom:1px solid var(--sep);padding:0 14px;font-size:11px;color:var(--lbl2);font-weight:500;position:sticky;top:0;background:var(--win);z-index:1}
§ .thead span{display:flex;align-items:center;gap:4px}
§ .thead span+span{border-left:1px solid var(--sep);padding-left:8px}
§ .trow{display:grid;grid-template-columns:1.6fr 1fr 1.4fr 50px;min-height:28px;align-items:center;padding:0 14px;white-space:nowrap}
§ .trow:nth-child(even){background:var(--fill)}
§ .trow>span{overflow:hidden;text-overflow:ellipsis;padding-right:8px;display:flex;align-items:center;gap:7px}
§ .trow>span+span{padding-left:8px;color:var(--lbl2)}
§ .trow .fav{width:18px;height:18px;font-size:9px;border-radius:4px}
§ .trow.sel{background:var(--acc);color:#fff}§ .trow.sel>span{color:#fff}§ .trow.sel .fav{background:rgba(255,255,255,.25);color:#fff}
/* map */
§ .mapw{flex:1;position:relative;overflow:auto;background-color:var(--win);background-image:radial-gradient(var(--fill3) 1px,transparent 1.2px);background-size:20px 20px}
§ .mapc{position:relative;width:800px;height:760px;transform-origin:0 0}
§ .mzone{position:absolute;border-radius:16px;background:var(--fill);border:1px solid var(--sep2)}
§ .mzone b{position:absolute;left:14px;top:10px;font-size:12px;font-weight:600;color:var(--lbl2);display:flex;gap:5px;align-items:center}
§ .medges{position:absolute;inset:0;pointer-events:none;overflow:visible}
§ .mnode{position:absolute;width:172px;min-height:52px;padding:7px 9px 8px;border-radius:10px;background:var(--card);box-shadow:0 1px 3px rgba(0,0,0,.12),0 0 0 .5px var(--sep);font-size:12px;line-height:1.3;cursor:grab;transition:opacity .15s}
§ .mnode.note{background:#fff6c7;box-shadow:0 1px 3px rgba(0,0,0,.12),0 0 0 .5px rgba(180,140,0,.25)}
§[data-theme=dark] .mnode.note{background:#4a4126}
§ .mnode .k{display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--lbl2);margin-bottom:3px;white-space:nowrap}
§ .mnode b{font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
§ .mnode.sel{box-shadow:0 0 0 2.5px var(--acc),0 4px 14px rgba(0,0,0,.15)}
§ .mnode.dimn{opacity:.5}
§ .mlegend{position:absolute;right:14px;bottom:14px;flex-direction:column;align-items:flex-start;gap:4px;display:flex;gap:12px;font-size:11px;color:var(--lbl2);background:var(--menu);padding:6px 10px;border-radius:8px;box-shadow:0 0 0 .5px var(--sep);z-index:2;align-items:center}
§ .mlegend span{display:block;text-align:left}
§ .mlegend i{display:inline-block;width:18px;height:0;border-top:1.5px solid var(--lbl3);vertical-align:middle;margin-right:4px}
§ .mlegend i.d{border-top:1.5px dashed var(--acc)}
/* new thread / empty workspace */
§ .newt{flex:1;overflow:auto;display:flex;flex-direction:column;align-items:center;padding:60px 30px}
§ .newt h2{font-size:22px;font-weight:700;margin:0 0 4px;letter-spacing:-.015em}
§ .newt .lead{color:var(--lbl2);font-size:13px;margin:0 0 20px;text-align:center;max-width:460px;line-height:1.5}
§ .newt .cbox{width:100%;max-width:560px}
§ .newt .cbox textarea{min-height:84px;font-size:14px}
§ .newt .samples{width:100%;max-width:560px;margin-top:22px}
§ .newt .samples h5{font-size:11px;font-weight:600;color:var(--lbl2);margin:0 0 8px}
§ .where{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--lbl2);width:100%;max-width:560px;margin-bottom:10px}
§ .diagram{display:block;margin:4px auto 0}
§ .diagram text{font-family:inherit}
`;
	CSS = CSS.replace(/§/g, "." + SC);

	/* ------------------------------------------------------------------ helpers */
	function h(tag, a) {
		var n = document.createElement(tag);
		if (typeof a === "string") n.className = a;
		else if (a) {
			for (var k in a) {
				var v = a[k];
				if (v == null || v === false) continue;
				if (k === "class") n.className = v;
				else if (k === "text") n.textContent = v;
				else if (k === "style") n.style.cssText = v;
				else if (k === "html") n.innerHTML = v;
				else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2).toLowerCase(), v);
				else n.setAttribute(k, v === true ? "" : v);
			}
		}
		for (var i = 2; i < arguments.length; i++) add(n, arguments[i]);
		return n;
	}
	// add(parent, ...children): skips null/false, flattens arrays, wraps strings in text nodes
	function add(n) {
		for (var i = 1; i < arguments.length; i++) {
			var c = arguments[i];
			if (c == null || c === false) continue;
			if (Array.isArray(c)) { for (var j = 0; j < c.length; j++) add(n, c[j]); continue; }
			n.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
		}
		return n;
	}
	function icon(name, size, cls) { return h("span", { class: "ic" + (cls ? " " + cls : ""), html: svg(name, size) }); }
	function copyText(t) { try { var p = navigator.clipboard && navigator.clipboard.writeText(t); if (p && p.catch) p.catch(() => { /* clipboard unavailable */ }); } catch (e) { /* clipboard unavailable */ } }
	function pl(n, w) { return n + " " + (n === 1 ? w : w === "branch" ? "branches" : w + "s"); }
	function clone(o) { return JSON.parse(JSON.stringify(o)); }
	function trunc(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; }

	var PCOL = { claude: "#d97a4a", codex: "#2f9e6e", grok: "#5b5f6b" };
	var PLAB = { claude: "Claude Code", codex: "Codex", grok: "Grok" };
	var HLC = { amber: "var(--yellow)", green: "var(--green)", blue: "var(--blue)", pink: "var(--pink)" };

	function mdTokens(s) {
		var out = [], re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g, i = 0, m;
		while ((m = re.exec(s))) {
			if (m.index > i) out.push({ t: s.slice(i, m.index) });
			if (m[1] != null) out.push({ t: m[1], code: 1 });
			else if (m[2] != null) out.push({ t: m[2], b: 1 });
			else out.push({ t: m[3], href: m[4] });
			i = re.lastIndex;
		}
		if (i < s.length) out.push({ t: s.slice(i) });
		return out;
	}
	function plain(s) { return mdTokens(String(s || "")).map(x => x.t).join(""); }
	// marks: [{q (plain text), cls, attrs}]
	function inline(s, marks) {
		var toks = mdTokens(String(s || ""));
		var full = toks.map(x => x.t).join("");
		var ranges = [];
		(marks || []).forEach(mk => {
			var q = plain(mk.q).trim();
			if (!q) return;
			var at = full.indexOf(q);
			if (at < 0) return;
			ranges.push({ a: at, b: at + q.length, mk: mk });
		});
		ranges.sort((x, y) => x.a - y.a);
		var out = [], pos = 0;
		toks.forEach(tk => {
			var a = pos, b = pos + tk.t.length;
			var cuts = [a, b];
			ranges.forEach(r => { if (r.a > a && r.a < b) cuts.push(r.a); if (r.b > a && r.b < b) cuts.push(r.b); });
			cuts = cuts.filter((v, i, arr) => arr.indexOf(v) === i).sort((x, y) => x - y);
			for (var i = 0; i < cuts.length - 1; i++) {
				var x = cuts[i], y = cuts[i + 1];
				var txt = tk.t.slice(x - a, y - a);
				var node = tk.code ? h("code", null, txt) : tk.b ? h("b", null, txt) : tk.href ? h("a", { href: "#", title: tk.href, onclick: e => { e.preventDefault(); } }, txt) : document.createTextNode(txt);
				var r = null;
				for (var j = 0; j < ranges.length; j++) if (ranges[j].a <= x && ranges[j].b >= y) { r = ranges[j]; break; }
				if (r) { var attrs = Object.assign({ class: r.mk.cls }, r.mk.attrs || {}); node = h("mark", attrs, node); }
				out.push(node);
			}
			pos = b;
		});
		return out;
	}

	/* ------------------------------------------------------------------ variants */
	var VARIANTS = [
		{ id: "a", name: "Mail layout", note: "Sidebar, thread list and conversation side by side with the Inspector open; answers read as document blocks." },
		{ id: "b", name: "Outline sidebar", note: "Two columns: threads and their branches are disclosure rows in the source list; answers as message bubbles; Inspector hidden (⌥⌘I)." },
		{ id: "c", name: "Column browser", note: "The research tree as Finder columns (thread › question line › branches) with a preview pane; tests branch navigation without a separate list." },
		{ id: "d", name: "Map board", note: "A Freeform-style board of threads and notes, clustered by workspace and joined by links; the Inspector edits the selection." },
		{ id: "e", name: "Welcome", note: "First launch: an empty workspace with the Welcome sheet (what a thread is, connect an agent, ask a first question)." }
	];
	var VCFG = {
		a: { layout: "three", insp: true, style: "doc", place: { kind: "all" }, thread: "t1", view: "conversation" },
		b: { layout: "two", insp: false, style: "bubble", place: { kind: "tree" }, thread: "t3", view: "conversation" },
		c: { layout: "three", insp: false, style: "doc", place: { kind: "ws", id: "ws-compilers" }, thread: "t1", view: "columns", colPath: ["t1q1", "t1q3", "t1q4"] },
		d: { layout: "three", insp: true, style: "doc", place: { kind: "map" }, thread: null, view: "conversation", mapSel: "t1" },
		e: { layout: "three", insp: false, style: "doc", place: { kind: "all" }, thread: null, view: "conversation", firstRun: true }
	};

	/* ================================================================== mount */
	function mount(root, ctx) {
		var cfg = VCFG[ctx.variant] || VCFG.a;
		var timers = [];
		var disposed = false;
		function later(fn, ms) { var id = setTimeout(() => { if (!disposed) fn(); }, ms); timers.push(id); return id; }
		var mountedAt = Date.now();
		var NOW = new Date(ctx.data.now).getTime();

		/* ---------- data */
		var D, TH, TU, NO;
		function loadData(empty) {
			var s = ctx.data;
			if (empty) {
				D = { threads: [], notes: [], drafts: [], inbox: [], workspaces: [{ id: "ws-new", name: "Research", dir: "~/Research" }], folders: [] };
			} else {
				D = { threads: clone(s.threads), notes: clone(s.notes), drafts: clone(s.drafts), inbox: clone(s.inbox), workspaces: clone(s.workspaces), folders: clone(s.folders) };
			}
			D.providers = s.providers;
			reindex();
		}
		function reindex() {
			TH = {}; TU = {}; NO = {};
			D.threads.forEach(t => { TH[t.id] = t; t.turns.forEach(u => { u.threadId = t.id; TU[u.id] = u; }); });
			D.notes.forEach(n => { NO[n.id] = n; });
		}
		loadData(!!cfg.firstRun);

		var agents = cfg.firstRun ? { claude: "ready", codex: "signin", grok: "missing" } : { claude: "ready", codex: "ready", grok: "missing" };

		/* ---------- state */
		var st = {
			layout: cfg.layout, insp: cfg.insp, side: true, style: cfg.style, place: cfg.place, threadId: cfg.thread,
			lineId: null, focusTurn: null, view: cfg.view, insTab: "thread", search: "", noteId: null, draftId: null, newThread: false,
			collapsed: {}, sideOpen: { "f-jit": true, "f-serving": true, t1: false, t3: true }, ocl: {}, colPath: cfg.colPath || null,
			composer: { text: "", mode: "followup", anchor: null }, next: null, mapSel: cfg.mapSel || null, mapPos: {}, mapZoom: 1,
			srcSort: "count", srcSel: null, listFilter: "all", firstRun: !!cfg.firstRun, outlineSel: null
		};
		if (st.threadId) openThread(st.threadId, null, true);
		if (cfg.colPath) { st.colPath = cfg.colPath.slice(); st.focusTurn = cfg.colPath[cfg.colPath.length - 1]; st.lineId = headOf(st.focusTurn); }
		if (cfg.firstRun) st.next = { provider: "claude", model: "opus", effort: "high" };

		/* ---------- model helpers */
		function wsName(id) { var w = D.workspaces.find(x => x.id === id); return w ? w.name : ""; }
		function folderName(id) { var f = D.folders.find(x => x.id === id); return f ? f.name : ""; }
		function kids(id) { var u = TU[id]; if (!u) return []; return TH[u.threadId].turns.filter(x => x.parentId === id); }
		function followOf(id) { return kids(id).find(x => x.relation === "followup"); }
		function branchesOf(id) { return kids(id).filter(x => x.relation === "branch"); }
		function lineOf(head) { var out = []; var u = TU[head]; while (u) { out.push(u); u = followOf(u.id); } return out; }
		function headOf(id) { var u = TU[id]; while (u && u.relation === "followup" && u.parentId) u = TU[u.parentId]; return u ? u.id : null; }
		function rootOf(t) { return TU[t.rootTurnId] || t.turns[0]; }
		function threadCounts(t) { var f = 0, b = 0; t.turns.forEach(u => { if (u.relation === "followup") f++; if (u.relation === "branch") b++; }); return { q: t.turns.length, f: f, b: b }; }
		function ago(iso) {
			if (!iso) return "";
			var d = new Date(iso), n = new Date(NOW);
			var same = d.toISOString().slice(0, 10) === n.toISOString().slice(0, 10);
			if (same) return d.toISOString().slice(11, 16);
			var diff = (n - d) / 86400000;
			if (diff < 2 && n.getUTCDate() - d.getUTCDate() === 1) return "Yesterday";
			return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
		}
		function dur(sec) { if (sec == null) return ""; sec = Math.round(sec); var m = Math.floor(sec / 60), s = sec % 60; return m ? m + "m " + (s < 10 ? "0" : "") + s + "s" : s + "s"; }
		function elapsed(u) {
			if (u._startMs) return (Date.now() - u._startMs) / 1000;
			return (NOW - new Date(u.createdAt).getTime()) / 1000 + (Date.now() - mountedAt) / 1000;
		}
		function statusOf(k) { return (ctx.data.statuses[k] || { label: k === "stopped" ? "Stopped" : k, tone: "plain" }); }
		function stBadge(k, small) {
			if (k === "done") return null;
			var s = statusOf(k);
			return h("span", { class: "st " + s.tone }, k === "running" ? h("span", "spin") : null, small ? s.label : s.label);
		}
		function pv(provider, model, effort, opts) {
			return h("span", { class: "pv", title: PLAB[provider] }, h("span", { class: "g", style: "background:" + PCOL[provider] }, (PLAB[provider] || "?")[0]),
				(opts && opts.short ? "" : PLAB[provider] + " · ") + model + (effort && !(opts && opts.noEffort) ? " · " + effort : ""));
		}
		function nextAgent() {
			if (st.next) return st.next;
			var t = TH[st.threadId];
			var u = st.focusTurn && TU[st.focusTurn];
			var src = u || (t && rootOf(t));
			return src ? { provider: src.provider, model: src.model, effort: src.effort } : { provider: "claude", model: "opus", effort: "high" };
		}
		function inboxCount() { return D.inbox.filter(i => i.kind !== "running" && i.kind !== "queued").length; }

		function placeThreads(p) {
			var all = D.threads.slice().sort((a, b) => a.updatedAt < b.updatedAt ? 1 : -1);
			var k = p.kind;
			if (k === "archive") return all.filter(t => t.archivedAt);
			all = all.filter(t => !t.archivedAt);
			if (k === "ws") return all.filter(t => t.workspaceId === p.id);
			if (k === "folder") return all.filter(t => t.folderId === p.id);
			if (k === "bookmarks") return all.filter(t => t.bookmarked);
			return all;
		}
		function isThreadPlace(p) { return ["all", "ws", "folder", "bookmarks", "archive"].indexOf(p.kind) >= 0; }
		function placeTitle(p) {
			return ({ all: "All Threads", inbox: "Inbox", bookmarks: "Bookmarks", drafts: "Drafts", archive: "Archive", highlights: "Highlights", notes: "Notes", sources: "Sources", map: "Map" })[p.kind] ||
				(p.kind === "ws" ? wsName(p.id) : p.kind === "folder" ? folderName(p.id) : p.kind === "tree" ? (TH[st.threadId] ? TH[st.threadId].title : "Thread") : "");
		}
		function curWs() {
			var p = st.place;
			if (p.kind === "ws") return p.id;
			if (p.kind === "folder") { var f = D.folders.find(x => x.id === p.id); if (f) return f.workspaceId; }
			if (st.threadId && TH[st.threadId]) return TH[st.threadId].workspaceId;
			return D.workspaces[0] && D.workspaces[0].id;
		}

		function searchHit(t, q) {
			q = q.toLowerCase();
			if (t.title.toLowerCase().indexOf(q) >= 0) return { where: "title", text: rootOf(t).question };
			if (t.tags.some(g => g.indexOf(q) >= 0)) return { where: "tag", text: rootOf(t).question };
			for (var i = 0; i < t.turns.length; i++) {
				var u = t.turns[i];
				var parts = [u.question].concat(u.answer);
				for (var j = 0; j < parts.length; j++) {
					var p = plain(parts[j]); var at = p.toLowerCase().indexOf(q);
					if (at >= 0) return { where: "text", text: (at > 40 ? "…" : "") + p.slice(Math.max(0, at - 40), at + 120), q: p.substr(at, q.length) };
				}
			}
			return null;
		}

		/* ---------- navigation */
		function openThread(id, turnId, silent) {
			var t = TH[id]; if (!t) return;
			st.threadId = id; st.newThread = false; st.draftId = null;
			var tid = turnId || (t.turns.find(u => u.status === "running" || u.status === "failed" || u.status === "needs-review") || {}).id || rootOf(t).id;
			if (!turnId) tid = rootOf(t).id;
			st.lineId = headOf(tid);
			st.focusTurn = turnId || null;
			st.composer = { text: st.composer && st.threadId === id ? st.composer.text : "", mode: "followup", anchor: null };
			st.next = null;
			if (st.view === "columns" || !st.colPath) st.colPath = pathTo(turnId || rootOf(t).id);
			if (t.unread) { t.unread = false; }
			if (!silent) render();
		}
		function pathTo(turnId) {
			// columns path: list of turn ids from the root line down through branches to turnId
			var chain = []; var u = TU[turnId];
			while (u) { chain.unshift(u.id); u = u.parentId ? TU[u.parentId] : null; }
			// keep only turns that start a column selection: for each branch head, its parent turn is selected in the previous column
			var out = [];
			chain.forEach(id => { var x = TU[id]; if (x.relation === "branch") out.push(x.parentId); });
			out.push(turnId);
			return out.filter((v, i, a) => a.indexOf(v) === i);
		}
		function goPlace(p) {
			st.place = p; st.search = "";
			if (p.kind === "notes") { var ns = notesIn(); st.noteId = ns[0] ? ns[0].id : null; }
			if (isThreadPlace(p)) {
				var list = placeThreads(p);
				if (st.view === "columns" || !list.some(t => t.id === st.threadId)) {
					if (list[0]) openThread(list[0].id, null, true); else { st.threadId = null; }
				}
			}
			if (p.kind === "drafts") { var dr = D.drafts.filter(d => true); if (dr[0]) openDraft(dr[0].id, true); }
			if (p.kind === "inbox" && D.inbox[0]) { openInbox(D.inbox[0], true); }
			if (p.kind === "highlights") { var hs = allHighlights(); if (hs[0]) { openThread(hs[0].threadId, hs[0].turnId, true); st.flashHl = null; } }
			render();
		}
		function openDraft(id, silent) {
			var d = D.drafts.find(x => x.id === id); if (!d) return;
			st.draftId = id; st.newThread = true; st.threadId = null;
			st.composer = { text: d.prompt, mode: "followup", anchor: null };
			st.next = { provider: d.provider, model: d.model, effort: d.provider === "grok" ? null : "high" };
			st.newWs = d.workspaceId; st.newFolder = null;
			if (!silent) render();
		}
		function openInbox(it, silent) {
			openThread(it.threadId, it.turnId, true);
			st.inboxSel = it.id;
			if (it.kind === "running" || it.kind === "failed") st.insTab = "run";
			if (it.kind === "unread") { TH[it.threadId].unread = false; }
			if (!silent) { render(); scrollToTurn(it.turnId); }
		}
		function newThread(prefill) {
			st.newThread = true; st.threadId = null; st.draftId = null;
			st.composer = { text: prefill || "", mode: "followup", anchor: null };
			st.next = st.next || { provider: "claude", model: "opus", effort: "high" };
			st.newWs = curWs(); st.newFolder = st.place.kind === "folder" ? st.place.id : null;
			if (st.view === "columns") st.view = "conversation";
			if (!isThreadPlace(st.place) && st.place.kind !== "tree" && st.place.kind !== "drafts") st.place = { kind: "all" };
			render();
			later(() => { var ta = root.querySelector(".newt textarea"); if (ta) ta.focus(); }, 30);
		}
		function scrollToTurn(id, hlId) {
			later(() => {
				var el = root.querySelector('[data-turn="' + id + '"]');
				if (!el) return;
				var sc = el.closest(".conv"); if (!sc) return;
				sc.scrollTop = el.offsetTop - 8;
				if (hlId) { var m = root.querySelector('mark[data-h="' + hlId + '"]'); if (m) { sc.scrollTop = Math.max(0, m.offsetTop - 120 + (m.offsetParent === sc.firstChild ? 0 : 0)); m.scrollIntoView({ block: "center" }); m.classList.add("flashm"); } }
				else { el.classList.add("flash"); }
			}, 20);
		}

		/* ---------- overlay: menus, popovers, sheets */
		var ovEl = null;
		function closeOv() { if (ovEl) { ovEl.remove(); ovEl = null; } st.sheet = st.sheet && st.sheet.keep ? st.sheet : null; }
		function rootRect() { return root.getBoundingClientRect(); }
		function scale() { var r = rootRect(); return r.width / 1280 || 1; }
		function relRect(el) {
			var r = el.getBoundingClientRect(), R = rootRect(), s = scale();
			return { x: (r.left - R.left) / s, y: (r.top - R.top) / s, w: r.width / s, h: r.height / s };
		}
		function menu(at, items, opts) {
			closeOv();
			var ov = h("div", { class: "ov", onmousedown: e => { if (e.target === ov) closeOv(); }, oncontextmenu: e => { e.preventDefault(); closeOv(); } });
			var m = h("div", { class: "menu", role: "menu" });
			items.forEach(it => {
				if (it === "-") { add(m, h("div", "msep")); return; }
				if (it.header) { add(m, h("div", "mhead", it.header)); return; }
				add(m, h("div", {
					class: "mi" + (it.disabled ? " dis" : ""), role: "menuitem",
					onclick: () => { if (it.disabled) return; closeOv(); if (it.run) it.run(); }
				}, h("span", "ck", it.checked ? icon("check", 12) : null), it.icon ? icon(it.icon, 14) : null, h("span", "l", it.label), it.sc ? h("span", "sc", it.sc) : null));
			});
			add(ov, m); add(root, ov); ovEl = ov;
			var w = m.offsetWidth, hh = m.offsetHeight;
			var x = Math.min(at.x, 1280 - w - 8), y = at.y;
			if (y + hh > 792) y = Math.max(8, at.y - hh - (at.h || 0) - 4);
			m.style.left = Math.max(6, x) + "px"; m.style.top = y + "px";
			if (opts && opts.minWidth) m.style.minWidth = opts.minWidth + "px";
		}
		function menuBelow(el, items, opts) { var r = relRect(el); menu({ x: r.x, y: r.y + r.h + 4, h: r.h }, items, opts); }
		function popup(label, options, value, onPick, cls) {
			var b = h("button", { class: "pop " + (cls || "") }, h("span", null, label), icon("updown", 11));
			b.addEventListener("click", e => {
				e.stopPropagation();
				menuBelow(b, options.map(o => {
					if (o === "-" || o.header) return o;
					return { label: o.label, checked: o.value === value, disabled: o.disabled, run: () => { onPick(o.value); } };
				}));
			});
			return b;
		}

		/* ---------- run simulation */
		var STREAM = [
			"Simulated answer from the prototype. In the app, {agent} runs on this Mac with your existing sign-in and receives the earlier questions and answers in this line as context.",
			"Tool calls made during the run are listed in the Inspector under Run, and pages the agent fetched appear under Sources. Select any passage to highlight it, add it to a note, or start a branch from it."
		];
		function startRun(u) {
			var t = TH[u.threadId];
			u.status = "running"; u._startMs = Date.now(); u.answer = []; u.activity = []; u.error = null;
			t.status = "running"; t.updatedAt = new Date(NOW + (Date.now() - mountedAt)).toISOString();
			var words = (u.question || "").replace(/[`*]/g, "").split(/\s+/).slice(0, 6).join(" ");
			var steps = [
				{ at: 250, s: { kind: "think", label: "Planned: " + trunc(words, 48), ms: 1100, status: "ok" } },
				{ at: 800, s: { kind: "read", label: "Read thread context (" + lineOf(headOf(u.id)).length + " answers)", ms: 90, status: "ok" } },
				{ at: 1300, s: { kind: "search", label: "Searched web: " + trunc(words, 36), ms: 1400, status: "ok" } }
			];
			steps.forEach(x => {
				later(() => {
					if (u.status !== "running") return;
					u.activity.forEach(a => { if (a.status === "running") a.status = "ok"; });
					u.activity.push(Object.assign({}, x.s));
					refreshRun(u);
				}, x.at);
			});
			var text = STREAM.map(p => { return p.replace("{agent}", PLAB[u.provider]); });
			var pi = 0, wi = 0, tok = text.map(p => p.split(" "));
			function tick() {
				if (u.status !== "running") return;
				if (pi >= tok.length) { finishRun(u); return; }
				if (wi === 0) u.answer.push("");
				var take = 3;
				u.answer[pi] = tok[pi].slice(0, wi + take).join(" ");
				wi += take;
				if (wi >= tok[pi].length) { pi++; wi = 0; }
				refreshRun(u, true);
				later(tick, 55);
			}
			later(tick, 1700);
		}
		function finishRun(u) {
			var t = TH[u.threadId];
			u.status = "done"; u.durationSec = Math.max(1, Math.round((Date.now() - u._startMs) / 1000));
			u.completedAt = new Date(NOW).toISOString();
			u.activity.forEach(a => { if (a.status === "running") a.status = "ok"; });
			if (!u.sources.length) u.sources = [];
			var q = t.turns.find(x => x.parentId === u.id && x.status === "queued");
			if (q) startRun(q);
			t.status = t.turns.some(x => x.status === "running") ? "running" : t.turns.some(x => x.status === "needs-review") ? "needs-review" : "done";
			render();
		}
		function stopRun(u) {
			u.status = "stopped"; u.activity.forEach(a => { if (a.status === "running") { a.status = "error"; a.label = a.label.replace(/^Reading/, "Stopped while reading"); } });
			u.completedAt = new Date(NOW).toISOString(); u.durationSec = Math.round(elapsed(u));
			var t = TH[u.threadId];
			D.inbox = D.inbox.filter(i => i.turnId !== u.id);
			var q = t.turns.find(x => x.parentId === u.id && x.status === "queued");
			if (q) { D.inbox = D.inbox.filter(i => i.turnId !== q.id); startRun(q); }
			t.status = t.turns.some(x => x.status === "running") ? "running" : "done";
			render();
		}
		function refreshRun(u, textOnly) {
			if (st.threadId === u.threadId) {
				var el = root.querySelector('[data-turn="' + u.id + '"]');
				var sc = root.querySelector(".conv");
				var atBottom = sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60;
				if (el) { var n = turnEl(u, lineIndex(u)); el.replaceWith(n); }
				else renderDetail();
				if (sc && atBottom) sc.scrollTop = sc.scrollHeight;
				if (!textOnly || st.insTab === "run") renderInsp();
				var pvw = root.querySelector(".preview,.opv"); if (pvw && (st.view !== "conversation")) renderDetail();
			}
			if (!textOnly) { renderList(); renderSide(); }
		}
		function lineIndex(u) { var l = lineOf(headOf(u.id)); return l.indexOf(u); }

		function send() {
			var text = (st.composer.text || "").trim();
			if (!text) return;
			var ag = nextAgent();
			if (st.newThread || !st.threadId) { createThread(text, ag); return; }
			var t = TH[st.threadId];
			var line = lineOf(st.lineId);
			var last = line[line.length - 1];
			var mode = st.composer.mode, anchor = st.composer.anchor;
			var parentId = mode === "branch" ? (anchor ? anchor.turnId : last.id) : last.id;
			var parent = TU[parentId];
			var nid = t.id + "n" + (t.turns.length + 1) + "_" + Math.floor(Math.random() * 1e4);
			var u = {
				id: nid, parentId: parentId, relation: mode === "branch" ? "branch" : "followup",
				anchor: mode === "branch" && anchor ? { turnId: anchor.turnId, paragraph: anchor.paragraph, quote: anchor.quote } : null,
				question: text, title: genTitle(text), provider: ag.provider, model: ag.model, effort: ag.effort,
				status: "queued", createdAt: new Date(NOW + (Date.now() - mountedAt)).toISOString(), completedAt: null, durationSec: null,
				starred: false, recap: null, answer: [], error: null, sources: [], activity: [], highlights: [], threadId: t.id
			};
			if (parent.status === "needs-review") { parent.status = "done"; D.inbox = D.inbox.filter(i => i.turnId !== parent.id); }
			t.turns.push(u); TU[u.id] = u;
			st.composer = { text: "", mode: "followup", anchor: null };
			if (u.relation === "branch") st.lineId = u.id;
			st.focusTurn = u.id;
			st.colPath = pathTo(u.id);
			if (parent.status === "running" || parent.status === "queued") {
				D.inbox.unshift({ id: "q" + nid, kind: "queued", threadId: t.id, turnId: u.id, title: "Queued: " + u.title, detail: "Starts when the running answer in this conversation finishes.", createdAt: u.createdAt });
			} else startRun(u);
			render();
			later(() => { var sc = root.querySelector(".conv"); if (sc) sc.scrollTop = sc.scrollHeight; var ta = root.querySelector(".composer textarea"); if (ta) ta.focus(); }, 20);
		}
		function genTitle(text) {
			var s = text.replace(/[`*]/g, "").split(/[?.:]/)[0].trim();
			if (s.length <= 56) return s;
			s = s.slice(0, 56); return s.slice(0, s.lastIndexOf(" ")).replace(/[,;]$/, "") + "\u2026";
		}
		function createThread(text, ag) {
			var ws = st.newWs || curWs() || (D.workspaces[0] && D.workspaces[0].id);
			var id = "tn" + Math.floor(Math.random() * 1e6);
			var title = genTitle(text);
			var u = {
				id: id + "q1", parentId: null, relation: "root", anchor: null, question: text, title: trunc(title, 44), provider: ag.provider, model: ag.model, effort: ag.effort,
				status: "queued", createdAt: new Date(NOW).toISOString(), completedAt: null, durationSec: null, starred: false, recap: null, answer: [], error: null, sources: [], activity: [], highlights: []
			};
			var t = {
				id: id, workspaceId: ws, folderId: st.newFolder || null, kind: "exchange", title: title, provider: ag.provider, model: ag.model, effort: ag.effort, status: "running",
				createdAt: u.createdAt, updatedAt: u.createdAt, lastViewedAt: null, unread: false, bookmarked: false, followed: false, archivedAt: null, recap: null, tags: [], links: [], rootTurnId: u.id, turns: [u]
			};
			D.threads.unshift(t); reindex();
			if (st.draftId) { D.drafts = D.drafts.filter(d => d.id !== st.draftId); st.draftId = null; }
			if (st.place.kind === "drafts" || st.place.kind === "inbox" || st.place.kind === "highlights" || st.place.kind === "notes") st.place = { kind: "all" };
			if (st.layout === "two") st.place = { kind: "tree" };
			st.newThread = false; st.next = null;
			openThread(id, null, true);
			st.focusTurn = u.id;
			startRun(u);
			render();
		}

		/* ---------- composer */
		function composerEl(opts) {
			opts = opts || {};
			var t = TH[st.threadId];
			var line = st.lineId ? lineOf(st.lineId) : [];
			var last = line[line.length - 1];
			var running = last && (last.status === "running" || last.status === "queued");
			var needs = last && last.status === "needs-review";
			var archived = t && t.archivedAt;
			var ag = nextAgent();
			var c = st.composer;
			var ta = h("textarea", {
				rows: opts.big ? 4 : 1, placeholder: opts.big ? "Ask a question. The agent can read files in this workspace and search the web." :
					needs ? "Reply to " + PLAB[last.provider] + "…" : c.mode === "branch" ? "Ask in a new branch…" : running ? "Ask a follow-up (queued until the current answer finishes)…" : "Ask a follow-up…",
				"aria-label": "Question"
			});
			ta.value = c.text || "";
			function grow() { ta.style.height = "auto"; ta.style.height = Math.min(opts.big ? 220 : 140, ta.scrollHeight) + "px"; }
			ta.addEventListener("input", () => { c.text = ta.value; grow(); sendBtn.disabled = !ta.value.trim(); });
			ta.addEventListener("keydown", e => {
				if (e.key === "Enter" && !e.shiftKey && !e.altKey) { e.preventDefault(); send(); }
			});
			later(grow, 0);
			var sendBtn = h("button", { class: "send", title: "Send (↩)", "aria-label": "Send", onclick: send, html: svg("up", 14) });
			sendBtn.disabled = !(c.text || "").trim();
			var prov = D.providers.find(p => p.id === ag.provider);
			function setAg(patch) {
				var n = Object.assign({}, ag, patch);
				if (patch.provider) { var pp = D.providers.find(p => p.id === patch.provider); n.model = pp.models[0]; n.effort = pp.efforts.length ? (pp.efforts.indexOf("high") >= 0 ? "high" : pp.efforts[0]) : null; if (agents[patch.provider] !== "ready") return openAgents(); }
				st.next = n; renderComposerOnly(); renderInsp();
			}
			var agentPop = popup(PLAB[ag.provider], D.providers.map(p => { return { label: PLAB[p.id] + (agents[p.id] === "ready" ? "" : agents[p.id] === "signin" ? " (not signed in)" : " (not installed)"), value: p.id }; }).concat(["-", { label: "Manage Agents…", value: "__m" }]), ag.provider, v => { if (v === "__m") openAgents(); else setAg({ provider: v }); }, "flat");
			var modelPop = popup(ag.model, prov.models.map(m => { return { label: m, value: m }; }), ag.model, v => { setAg({ model: v }); }, "flat");
			var effortPop = prov.efforts.length ? popup((ag.effort ? ag.effort[0].toUpperCase() + ag.effort.slice(1) : "Default") + " effort", prov.efforts.map(m => { return { label: m[0].toUpperCase() + m.slice(1), value: m }; }), ag.effort, v => { setAg({ effort: v }); }, "flat") : null;
			var seg = null;
			if (!opts.big && t) {
				var canBranch = !archived && last && last.status !== "running" && last.status !== "queued";
				seg = h("div", { class: "seg sm", role: "group", "aria-label": "Question type" },
					h("button", { class: c.mode !== "branch" ? "on" : "", title: "Continue this conversation", onclick: () => { c.mode = "followup"; c.anchor = null; renderComposerOnly(); } }, icon("followup", 12), "Follow-up"),
					h("button", { class: c.mode === "branch" ? "on" : "", disabled: canBranch ? null : true, title: canBranch ? "Start a separate line from this answer" : "Wait for the answer to finish", onclick: () => { if (!canBranch) return; c.mode = "branch"; renderComposerOnly(); } }, icon("branch", 12), "Branch"));
			}
			var ctxRow = null;
			if (c.mode === "branch" && t) {
				ctxRow = h("div", "cctx", icon("branch", 12), "Branch from",
					c.anchor ? h("span", "tok", icon("quote", 11), h("span", null, "“" + trunc(plain(c.anchor.quote), 60) + "”"), h("button", { class: "x", "aria-label": "Use whole answer", onclick: () => { c.anchor = null; renderComposerOnly(); }, html: svg("x", 10) }))
						: h("span", "tok gray", h("span", null, "the whole answer: " + trunc(last ? last.title : "", 40))));
			}
			var box = h("div", "cbox", ctxRow, ta,
				h("div", "cbar", seg, seg ? h("span", "tbsep") : null, agentPop, modelPop, effortPop, h("span", "grow"), sendBtn));
			var help = opts.big ? null : h("div", "chelp",
				h("span", null, needs ? "Your reply continues this conversation and resumes the run." :
					c.mode === "branch" ? "A branch is a separate line from this answer. The current line stays unchanged." :
						running ? "This line runs one answer at a time. Your follow-up starts when the current answer finishes." :
							"A follow-up continues this line; the agent keeps the earlier answers as context."),
				h("span", "grow"));
			if (archived && !opts.big) return h("div", "composer", h("div", { class: "chelp", style: "justify-content:center" }, icon("archive", 13), "Archived threads are read-only.", h("button", { class: "btn sm", onclick: () => { t.archivedAt = null; render(); } }, "Unarchive")));
			return opts.big ? box : h("div", "composer", box, help);
		}
		function renderComposerOnly() {
			var old = root.querySelector(".composer");
			var oldBig = root.querySelector(".newt .cbox");
			var focused = document.activeElement && document.activeElement.tagName === "TEXTAREA" && root.contains(document.activeElement);
			if (old) { old.replaceWith(composerEl()); }
			else if (oldBig) { oldBig.replaceWith(composerEl({ big: true })); }
			if (focused || true) { var ta = root.querySelector(".composer textarea, .newt textarea"); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
		}

		/* ---------- layout skeleton */
		var els = {};
		function render() {
			if (disposed) return;
			var keep = {};
			root.querySelectorAll("[data-sk]").forEach(n => { keep[n.getAttribute("data-sk")] = n.scrollTop; });
			var activeTa = document.activeElement && root.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA";
			if (!els.win) {
				els.win = h("div", "win");
				add(root, els.win);
			}
			els.win.replaceChildren();
			if (st.side) { els.side = h("div", { class: "side", style: "width:" + (st.layout === "two" ? 260 : 208) + "px" }); add(els.win, els.side); renderSide(); }
			els.main = h("div", "main");
			els.tb = h("div", "tb");
			els.body = h("div", "body");
			add(els.main, els.tb, els.body); add(els.win, els.main);
			var showList = listVisible();
			els.list = showList ? h("div", "list") : null;
			els.detail = h("div", "detail");
			els.insp = st.insp && st.view !== "columns" || (st.insp && st.view === "columns") ? h("div", "insp") : null;
			if (els.list) add(els.body, els.list);
			add(els.body, els.detail);
			if (els.insp) add(els.body, els.insp);
			renderToolbar(); renderList(); renderDetail(); renderInsp();
			root.querySelectorAll("[data-sk]").forEach(n => { var k = n.getAttribute("data-sk"); if (keep[k] != null) n.scrollTop = keep[k]; });
			if (activeTa) { var ta = root.querySelector(".composer textarea, .newt textarea"); if (ta) ta.focus(); }
			if (st.sheet && !ovEl) showSheet();
			// keep keyboard shortcuts working after a re-render removed the focused control
			if (document.activeElement === document.body) { try { root.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
		}
		function listVisible() {
			var k = st.place.kind;
			if (k === "sources" || k === "map" || k === "tree") return false;
			if (!D.threads.length && isThreadPlace(st.place)) return false;
			if (st.view === "columns" && isThreadPlace(st.place)) return false;
			return true;
		}

		/* ---------- sidebar */
		function srow(o) {
			var r = h("div", { class: "srow" + (o.sel ? " sel" : "") + (o.cls ? " " + o.cls : ""), role: "treeitem", style: o.indent ? "padding-left:" + (8 + o.indent * 14) + "px" : null, onclick: o.onclick, oncontextmenu: o.onctx, title: o.title || null },
				o.tw != null ? h("span", { class: "tw ic" + (o.tw ? " open" : ""), html: svg("chevR", 10), onclick: e => { e.stopPropagation(); o.ontw(); } }) : o.twSpace ? h("span", "tw ic") : null,
				o.icon ? (o.iconEl || icon(o.icon, 16)) : null, h("span", "lbl", o.label),
				o.badge ? h("span", { class: "badge" + (o.badgeAcc ? " acc" : "") }, String(o.badge)) : o.count != null ? h("span", "cnt", String(o.count)) : null);
			return r;
		}
		function samePlace(a, b) { return a.kind === b.kind && (a.id || null) === (b.id || null); }
		function section(id, title, rows, extra) {
			var col = !!st.collapsed[id];
			return h("div", "sec",
				h("div", { class: "sec-h", onclick: () => { st.collapsed[id] = !col; renderSide(); } },
					h("span", "grow", title), extra || null, h("span", { class: "dis" + (col ? " on" : ""), html: svg(col ? "chevR" : "chevD", 10) })),
				col ? null : rows);
		}
		function renderSide() {
			if (!els.side) return;
			var s = els.side; s.replaceChildren();
			add(s, h("div", "side-top", h("div", { class: "tl", "aria-hidden": "true" }, h("i"), h("i"), h("i")), h("span", { style: "flex:1" }),
				h("button", { class: "ibtn", title: "Hide Sidebar (⌃⌘S)", "aria-label": "Hide Sidebar", onclick: () => { st.side = false; render(); }, html: svg("sidebarL", 17) })));
			var sc = h("div", { class: "side-scroll", "data-sk": "side", role: "tree" });
			var P = st.place;
			var nIn = inboxCount();
			var fav = [
				srow({ icon: "tray", label: "Inbox", badge: nIn || null, sel: samePlace(P, { kind: "inbox" }), onclick: () => { goPlace({ kind: "inbox" }); } })
			];
			if (st.layout !== "two") fav.push(srow({ icon: "bubbles", label: "All Threads", count: placeThreads({ kind: "all" }).length || null, sel: samePlace(P, { kind: "all" }), onclick: () => { goPlace({ kind: "all" }); } }));
			fav.push(
				srow({ icon: "bookmark", label: "Bookmarks", count: placeThreads({ kind: "bookmarks" }).length || null, sel: samePlace(P, { kind: "bookmarks" }), onclick: () => { goPlace({ kind: "bookmarks" }); } }),
				srow({ icon: "draft", label: "Drafts", count: D.drafts.length || null, sel: samePlace(P, { kind: "drafts" }), onclick: () => { goPlace({ kind: "drafts" }); } }),
				srow({ icon: "archive", label: "Archive", count: placeThreads({ kind: "archive" }).length || null, sel: samePlace(P, { kind: "archive" }), onclick: () => { goPlace({ kind: "archive" }); } }));
			add(sc, h("div", { class: "sec", style: "margin-top:0" }, fav));
			add(sc, section("lib", "Library", [
				srow({ icon: "highlighter", label: "Highlights", count: allHighlights().length || null, sel: P.kind === "highlights", onclick: () => { goPlace({ kind: "highlights" }); } }),
				srow({ icon: "note", label: "Notes", count: D.notes.length || null, sel: P.kind === "notes", onclick: () => { goPlace({ kind: "notes" }); } }),
				srow({ icon: "globe", label: "Sources", count: allSources().length || null, sel: P.kind === "sources", onclick: () => { goPlace({ kind: "sources" }); } }),
				srow({ icon: "map", label: "Map", sel: P.kind === "map", onclick: () => { goPlace({ kind: "map" }); } })
			]));
			D.workspaces.forEach(w => {
				var rows = [];
				var fs = D.folders.filter(f => f.workspaceId === w.id);
				if (st.layout === "two") {
					fs.forEach(f => {
						var open = !!st.sideOpen[f.id];
						var ts = placeThreads({ kind: "folder", id: f.id });
						rows.push(srow({ icon: "folder", label: f.name, count: ts.length, tw: open, ontw: () => { st.sideOpen[f.id] = !open; renderSide(); }, onclick: () => { st.sideOpen[f.id] = !open; renderSide(); }, onctx: e => { e.preventDefault(); folderMenu(e, f); } }));
						if (open) ts.forEach(t => { treeRows(rows, t, 1); });
					});
					placeThreads({ kind: "ws", id: w.id }).filter(t => !t.folderId).forEach(t => { treeRows(rows, t, 0); });
				} else {
					fs.forEach(f => {
						rows.push(srow({ icon: "folder", label: f.name, count: placeThreads({ kind: "folder", id: f.id }).length || null, sel: samePlace(P, { kind: "folder", id: f.id }), onclick: () => { goPlace({ kind: "folder", id: f.id }); }, onctx: e => { e.preventDefault(); folderMenu(e, f); } }));
					});
					if (!fs.length) rows.push(h("div", { class: "srow", style: "color:var(--lbl3);font-size:12px;padding-left:31px" }, "No folders"));
				}
				var hdr = h("span", { style: "display:inline-flex;gap:5px;align-items:center;cursor:default", title: w.dir }, icon("stack", 12), w.name);
				var sec = section(w.id, hdr, rows, h("button", { class: "hbtn ic", title: "New Folder in " + w.name, html: svg("plus", 12), onclick: e => { e.stopPropagation(); newFolder(w.id); } }));
				var head = sec.querySelector(".sec-h");
				head.addEventListener("dblclick", () => { goPlace({ kind: "ws", id: w.id }); });
				if (st.layout !== "two") {
					var wrow = srow({ icon: "stack", label: "All in " + w.name, count: placeThreads({ kind: "ws", id: w.id }).length || null, sel: samePlace(P, { kind: "ws", id: w.id }), onclick: () => { goPlace({ kind: "ws", id: w.id }); } });
					if (!st.collapsed[w.id]) head.after(wrow);
				}
				add(sc, sec);
			});
			add(s, sc);
			var ready = Object.keys(agents).filter(k => agents[k] === "ready");
			add(s, h("div", "side-foot",
				h("button", { class: "agent-st", onclick: openAgents, title: "Agents" },
					h("span", { class: "dot", style: "background:" + (ready.length ? "var(--green)" : "var(--orange)") }),
					h("span", { style: "min-width:0;text-align:left" }, h("b", null, ready.length ? ready.length + (ready.length === 1 ? " agent ready" : " agents ready") : "No agent ready"), h("small", null, ready.length ? ready.map(k => PLAB[k]).join(", ") : "Connect an agent to ask questions"))),
				h("button", { class: "ibtn", title: "Add", "aria-label": "Add", html: svg("plus", 15), onclick: e => {
					menuBelow(e.currentTarget, [
						{ label: "New Thread", icon: "compose", sc: "⌘N", run: () => { newThread(); } },
						{ label: "New Note", icon: "note", run: newNote },
						{ label: "New Folder…", icon: "folder", sc: "⇧⌘N", run: () => { newFolder(curWs()); } },
						"-",
						{ label: "New Workspace…", icon: "stack", run: newWorkspace },
						{ label: "Import Markdown Report…", icon: "download", disabled: true },
						"-",
						{ label: "Welcome to Session", icon: "info", run: () => { openSheet({ kind: "welcome", page: 0 }); } }
					]);
				} }),
				h("button", { class: "ibtn", title: "Settings (⌘,)", "aria-label": "Settings", html: svg("gear", 15), onclick: openAgents })));
		}
		function treeRows(rows, t, depth) {
			var open = !!st.sideOpen[t.id];
			var brs = t.turns.filter(u => u.relation === "branch");
			var sel = st.place.kind === "tree" && st.threadId === t.id;
			var ic = t.status === "running" ? h("span", { class: "ic", style: "width:16px;color:var(--acc)" }, h("span", "spin")) :
				t.status === "failed" ? icon("warn", 15) : t.status === "needs-review" ? icon("clarify", 15) : icon("bubbles", 15);
			var r = srow({ cls: "thread", icon: "x", iconEl: ic, label: t.title, indent: depth, tw: brs.length ? open : null, twSpace: true, ontw: () => { st.sideOpen[t.id] = !open; renderSide(); },
				sel: sel && (st.lineId === t.rootTurnId), badge: t.unread ? "•" : null, title: t.title,
				onclick: () => { st.place = { kind: "tree" }; openThread(t.id); }, onctx: e => { e.preventDefault(); threadMenu(e, t); } });
			if (t.status === "failed") r.querySelector(".ic").style.color = "var(--red)";
			if (t.status === "needs-review") r.querySelector(".ic").style.color = "var(--orange)";
			if (t.unread) { var b = r.querySelector(".badge"); b.className = "dot"; b.textContent = ""; b.style.background = "var(--acc)"; b.style.width = "7px"; b.style.height = "7px"; }
			rows.push(r);
			if (open && brs.length) {
				brs.forEach(b => {
					var d = 1; var p = TU[b.parentId]; while (p && p.relation !== "root") { if (p.relation === "branch") d++; p = TU[p.parentId]; }
					rows.push(srow({ cls: "br", icon: "branch", label: b.title, indent: depth + d + 0.6, sel: st.place.kind === "tree" && st.lineId === b.id, onclick: () => { st.place = { kind: "tree" }; openThread(t.id, b.id); } }));
				});
			}
		}
		function folderMenu(e, f) {
			menu({ x: e.clientX ? relPoint(e).x : 0, y: relPoint(e).y }, [
				{ label: "Open", run: () => { goPlace({ kind: "folder", id: f.id }); } },
				{ label: "Rename…", run: () => { var n = f.name + " (renamed)"; f.name = n; render(); } },
				"-",
				{ label: "Delete Folder", run: () => { D.threads.forEach(t => { if (t.folderId === f.id) t.folderId = null; }); D.folders = D.folders.filter(x => x !== f); if (st.place.id === f.id) st.place = { kind: "all" }; render(); } },
				{ header: "Threads in a deleted folder stay in the workspace." }
			]);
		}
		function relPoint(e) { var R = rootRect(), s = scale(); return { x: (e.clientX - R.left) / s, y: (e.clientY - R.top) / s }; }
		function newFolder(wsId) {
			var n = D.folders.filter(f => f.workspaceId === wsId).length + 1;
			var f = { id: "fn" + Date.now(), workspaceId: wsId, name: "New Folder " + n };
			D.folders.push(f); st.collapsed[wsId] = false; goPlace({ kind: "folder", id: f.id });
		}
		function newWorkspace() {
			var w = { id: "wsn" + Date.now(), name: "Untitled Workspace", dir: "~/Research/Untitled Workspace" };
			D.workspaces.push(w);
			st.place = { kind: "ws", id: w.id }; st.threadId = null; st.newThread = false;
			render();
		}
		function newNote() {
			var n = { id: "nn" + Date.now(), workspaceId: curWs(), title: "Untitled Note", updatedAt: new Date(NOW).toISOString(), tags: [], outline: [{ text: "" }] };
			D.notes.unshift(n); NO[n.id] = n; st.place = { kind: "notes" }; st.noteId = n.id; render();
			later(() => { var t = root.querySelector(".noted h1"); if (t) { t.focus(); document.execCommand && document.getSelection().selectAllChildren(t); } }, 30);
		}

		/* ---------- toolbar */
		function renderToolbar() {
			var tb = els.tb; tb.replaceChildren();
			if (!st.side) add(tb, h("div", { class: "tl", style: "padding:0 6px 0 18px", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
				h("button", { class: "ibtn", title: "Show Sidebar (⌃⌘S)", style: "margin-left:8px", onclick: () => { st.side = true; render(); }, html: svg("sidebarL", 17) }));
			var t = TH[st.threadId];
			var P = st.place;
			var title, sub;
			if (P.kind === "tree" || (!listVisible() && isThreadPlace(P) && st.view !== "columns")) {
				title = t ? t.title : "Session"; sub = t ? [wsName(t.workspaceId), folderName(t.folderId)].filter(Boolean).join(" › ") : "";
			} else if (P.kind === "notes") { title = "Notes"; sub = pl(notesIn().length, "note"); }
			else if (P.kind === "map") { title = "Map"; sub = pl(mapNodes().length, "item") + " · " + pl(mapEdges().length, "link"); }
			else if (P.kind === "sources") { title = "Sources"; sub = allSources().length + " pages cited across threads"; }
			else if (P.kind === "inbox") { title = "Inbox"; sub = inboxCount() + " need attention · " + D.inbox.filter(i => i.kind === "running" || i.kind === "queued").length + " in progress"; }
			else if (P.kind === "highlights") { title = "Highlights"; sub = pl(allHighlights().length, "passage"); }
			else if (P.kind === "drafts") { title = "Drafts"; sub = D.drafts.length + " unsent questions"; }
			else { var ls = placeThreads(P); title = placeTitle(P); sub = pl(ls.length, "thread") + (ls.filter(x => x.unread).length ? ", " + ls.filter(x => x.unread).length + " unread" : ""); }
			var lw = listVisible() ? 280 : null;
			add(tb, h("div", { class: "tb-title", style: lw ? "width:" + lw + "px" : "max-width:420px" }, h("b", null, title), h("small", null, sub)));
			add(tb, h("button", { class: "ibtn", title: "New Thread (⌘N)", "aria-label": "New Thread", onclick: () => { newThread(); }, html: svg("compose", 17) }));
			var threadView = t && !st.newThread && (isThreadPlace(P) || P.kind === "tree" || P.kind === "inbox" || P.kind === "highlights");
			if (threadView || (isThreadPlace(P) && st.view === "columns")) {
				add(tb, h("span", "tbsep"));
				var modes = [["conversation", "bubbles", "Conversation (⌘1)"], ["outline", "outline", "Outline (⌘2)"], ["columns", "columns", "Columns (⌘3)"]];
				add(tb, h("div", { class: "seg", role: "group", "aria-label": "View" }, modes.map(m => {
					return h("button", { class: st.view === m[0] ? "on" : "", title: m[2], "aria-label": m[2], onclick: () => { setView(m[0]); }, html: svg(m[1], 15) });
				})));
			}
			add(tb, h("span", "grow"));
			if (t && threadView) {
				add(tb, h("button", { class: "ibtn" + (t.bookmarked ? " on" : ""), title: t.bookmarked ? "Remove Bookmark" : "Bookmark", "aria-pressed": String(!!t.bookmarked), onclick: () => { t.bookmarked = !t.bookmarked; render(); }, html: svg(t.bookmarked ? "bookmarkf" : "bookmark", 16) }));
				add(tb, h("button", { class: "ibtn", title: "Move to Folder", "aria-label": "Move to Folder", onclick: e => { menuBelow(e.currentTarget, moveItems(t)); }, html: svg("folder", 16) }));
				add(tb, h("button", { class: "ibtn", title: "More", "aria-label": "More", onclick: e => { var r = relRect(e.currentTarget); threadMenu({ at: { x: r.x, y: r.y + r.h + 4 } }, t); }, html: svg("ellipsisC", 17) }));
			}
			if (P.kind === "map") {
				add(tb, h("button", { class: "ibtn", title: "Zoom Out", onclick: () => { st.mapZoom = Math.max(.6, st.mapZoom - .1); renderDetail(); }, html: svg("zoomOut", 16) }));
				add(tb, h("button", { class: "ibtn", title: "Zoom In", onclick: () => { st.mapZoom = Math.min(1.4, st.mapZoom + .1); renderDetail(); }, html: svg("zoomIn", 16) }));
				add(tb, h("button", { class: "ibtn", title: "New Note", onclick: newNote, html: svg("note", 16) }));
			}
			var sinput = h("input", { type: "search", placeholder: "Search", "aria-label": "Search", value: st.search || "" });
			sinput.addEventListener("input", () => {
				st.search = sinput.value;
				if (!isThreadPlace(st.place) && st.place.kind !== "inbox") { st.place = { kind: "all" }; render(); var i = root.querySelector(".search input"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); return; }
				if (st.view === "columns") { st.view = "conversation"; render(); var j = root.querySelector(".search input"); j.focus(); return; }
				renderList(); renderToolbarSub();
			});
			sinput.addEventListener("keydown", e => { if (e.key === "Escape") { sinput.value = ""; st.search = ""; renderList(); sinput.blur(); } });
			add(tb, h("label", "search", icon("search", 14), sinput));
			add(tb, h("button", { class: "ibtn" + (st.insp ? " on" : ""), title: (st.insp ? "Hide" : "Show") + " Inspector (⌥⌘I)", "aria-label": "Inspector", "aria-pressed": String(st.insp), onclick: () => { st.insp = !st.insp; render(); }, html: svg("sidebarR", 17) }));
		}
		function renderToolbarSub() {
			var small = els.tb.querySelector(".tb-title small");
			if (small && st.search) { var n = placeThreads(st.place).filter(t => searchHit(t, st.search)).length; small.textContent = n + " results for “" + st.search + "”"; }
		}
		function setView(v) {
			st.view = v;
			if (v === "columns" && st.threadId) st.colPath = pathTo(st.focusTurn || st.lineId || rootOf(TH[st.threadId]).id);
			if (v === "outline") st.outlineSel = st.focusTurn || st.lineId;
			if (v !== "conversation" && !isThreadPlace(st.place) && st.place.kind !== "tree") { /* keep place */ }
			render();
		}
		function moveItems(t) {
			var items = [{ header: "Move to" }];
			D.workspaces.forEach(w => {
				items.push({ header: w.name });
				D.folders.filter(f => f.workspaceId === w.id).forEach(f => {
					items.push({ label: f.name, icon: "folder", checked: t.folderId === f.id, run: () => { t.folderId = f.id; t.workspaceId = w.id; render(); } });
				});
				items.push({ label: "No Folder", checked: t.workspaceId === w.id && !t.folderId, run: () => { t.folderId = null; t.workspaceId = w.id; render(); } });
			});
			items.push("-", { label: "New Folder…", run: () => { var f = { id: "fn" + Date.now(), workspaceId: t.workspaceId, name: "New Folder" }; D.folders.push(f); t.folderId = f.id; render(); } });
			return items;
		}
		function threadMenu(e, t) {
			var at = e.at || relPoint(e);
			menu(at, [
				{ label: "Open", run: () => { openThread(t.id); } },
				{ label: "Open Quickly…", sc: "⇧⌘O", run: openQuickly },
				"-",
				{ label: t.bookmarked ? "Remove Bookmark" : "Bookmark", icon: "bookmark", sc: "⌘D", run: () => { t.bookmarked = !t.bookmarked; render(); } },
				{ label: t.unread ? "Mark as Read" : "Mark as Unread", icon: "bubbles", sc: "⇧⌘U", run: () => { t.unread = !t.unread; render(); } },
				{ label: "Notify on Replies", icon: "bell", checked: !!t.followed, run: () => { t.followed = !t.followed; render(); } },
				"-",
				{ label: "Move to Folder…", icon: "folder", run: () => { menu(at, moveItems(t)); } },
				{ label: "Add Link to Thread…", icon: "link", run: () => { openQuickly({ linkFrom: t.id }); } },
				{ label: "Generate Recap…", icon: "sparkle", run: () => { st.insTab = "thread"; st.insp = true; t.recap = t.recap || "Recap: " + rootOf(t).title + ". " + threadCounts(t).q + " questions."; render(); } },
				"-",
				{ label: "Copy Thread as Markdown", icon: "copy", run: () => {} },
				{ label: "Rename…", icon: "pencil", run: () => { st.insTab = "thread"; st.insp = true; render(); later(() => { var f = root.querySelector(".insp .field"); if (f) { f.focus(); f.select(); } }, 30); } },
				{ label: t.archivedAt ? "Unarchive" : "Archive", icon: "archive", sc: "⌃⌘A", run: () => { t.archivedAt = t.archivedAt ? null : new Date(NOW).toISOString(); render(); } },
				{ label: "Move to Trash", icon: "trash", sc: "⌘⌫", run: () => { D.threads = D.threads.filter(x => x !== t); reindex(); if (st.threadId === t.id) st.threadId = null; render(); } }
			]);
		}

		/* ---------- content list */
		function renderList() {
			var L = els.list; if (!L) return;
			L.replaceChildren();
			var P = st.place;
			if (P.kind === "inbox") return listInbox(L);
			if (P.kind === "highlights") return listHighlights(L);
			if (P.kind === "notes") return listNotes(L);
			if (P.kind === "drafts") return listDrafts(L);
			var ts = placeThreads(P);
			var q = (st.search || "").trim();
			var hits = {};
			if (q) ts = ts.filter(t => { var x = searchHit(t, q); if (x) hits[t.id] = x; return !!x; });
			if (st.listFilter === "unread") ts = ts.filter(t => t.unread);
			if (st.listFilter === "active") ts = ts.filter(t => t.status !== "done");
			var head = h("div", "list-h",
				h("div", "seg sm", [["all", "All"], ["unread", "Unread"], ["active", "Needs Attention"]].map(f => {
					return h("button", { class: st.listFilter === f[0] ? "on" : "", onclick: () => { st.listFilter = f[0]; renderList(); } }, f[1]);
				})), h("span", "grow"), h("span", null, "Date"), icon("chevD", 9));
			add(L, head);
			if (q) add(L, h("div", "scope", "Search:", h("div", "seg sm", h("button", { class: "on" }, placeTitle(P)), h("button", { onclick: () => { st.place = { kind: "all" }; renderList(); renderToolbar(); } }, "All Workspaces")), h("span", "grow"), ts.length + " found"));
			var sc = h("div", { class: "list-s", "data-sk": "list", role: "listbox", "aria-label": placeTitle(P) });
			if (!ts.length) {
				var fresh = !D.threads.length;
				add(sc, h("div", { class: "empty sm", style: "height:auto;padding-top:80px" }, h("b", null, q ? "No Results" : fresh ? "No Threads Yet" : "No Threads"),
					h("small", null, q ? "Nothing in " + placeTitle(P) + " matches “" + q + "”." : fresh ? "Questions you ask appear here." : P.kind === "folder" ? "Drag threads here or use Move to Folder." : ""),
					!q ? h("button", { class: "btn", style: "margin-top:8px", onclick: () => { newThread(); } }, "New Thread") : null));
			}
			ts.forEach(t => { add(sc, threadRow(t, hits[t.id], q)); });
			add(L, sc);
		}
		function threadRow(t, hit, q) {
			var sel = t.id === st.threadId && !st.newThread;
			var r = rootOf(t);
			var c = threadCounts(t);
			var sn = hit && hit.where === "text" ? hitSnippet(hit.text, q) : (t.recap || plain(r.question));
			var row = h("div", {
				class: "lrow" + (sel ? " sel" : ""), role: "option", "aria-selected": String(sel), tabindex: "-1", "data-tid": t.id,
				onclick: () => { openThread(t.id); }, oncontextmenu: e => { e.preventDefault(); openThread(t.id, null, true); render(); threadMenu(e, t); }
			},
				t.unread ? h("span", { class: "ud", title: "Unread" }) : h("span"),
				h("span", "t", t.title), h("span", "tm", ago(t.updatedAt)),
				h("span"), h("span", "sn", sn),
				h("span"), h("span", "mt",
					stBadge(t.status),
					pv(t.provider, t.model, null, { short: true }),
					c.b ? h("span", { class: "pv", title: c.b + " branches" }, icon("branch", 11), String(c.b)) : null,
					t.bookmarked ? h("span", { class: "pv", title: "Bookmarked" }, icon("bookmarkf", 10)) : null,
					h("span", "sp"),
					st.place.kind !== "folder" ? h("span", "fold", t.folderId ? icon("folder", 11) : icon("stack", 11), t.folderId ? folderName(t.folderId) : wsName(t.workspaceId)) : null));
			return row;
		}
		function hitSnippet(text, q) {
			var at = text.toLowerCase().indexOf(q.toLowerCase());
			if (at < 0) return text;
			var s = h("span"); add(s, text.slice(0, at), h("mark", null, text.substr(at, q.length)), text.slice(at + q.length)); return s;
		}
		function listInbox(L) {
			add(L, h("div", "list-h", h("span", null, "Runs that finished, failed or are waiting for you"), h("span", "grow")));
			var sc = h("div", { class: "list-s", "data-sk": "inbox" });
			var groups = [["Needs You", ["clarify", "failed"]], ["New Answers", ["unread"]], ["In Progress", ["running", "queued"]]];
			var KI = { clarify: ["clarify", "var(--orange)"], failed: ["warn", "var(--red)"], unread: ["checkC", "var(--acc)"], running: [null, "var(--acc)"], queued: ["clock", "var(--lbl2)"] };
			groups.forEach(g => {
				var items = D.inbox.filter(i => g[1].indexOf(i.kind) >= 0);
				if (!items.length) return;
				add(sc, h("div", "lgrp", g[0], h("span", "n", String(items.length))));
				items.forEach(it => {
					var t = TH[it.threadId]; if (!t) return;
					var sel = st.inboxSel === it.id;
					var k = KI[it.kind];
					var ic = k[0] ? icon(k[0], 15, "lic") : h("span", { class: "ic lic", style: "width:15px" }, h("span", "spin"));
					if (!sel) ic.style.color = k[1];
					add(sc, h("div", { class: "lrow" + (sel ? " sel" : ""), role: "option", onclick: () => { openInbox(it); } },
						ic, h("span", { class: "t", style: "font-weight:" + (it.kind === "running" || it.kind === "queued" ? 500 : 600) }, it.title), h("span", "tm", ago(it.createdAt)),
						h("span"), h("span", "sn", it.detail),
						h("span"), h("span", "mt", icon("bubbles", 11), h("span", "fold", trunc(t.title, 46)))));
				});
			});
			if (!D.inbox.length) add(sc, h("div", { class: "empty sm", style: "height:auto;padding-top:80px" }, h("b", null, "Nothing Needs You"), h("small", null, "Finished runs, failures and agent questions appear here.")));
			add(L, sc);
		}
		function allHighlights() {
			var out = [];
			D.threads.forEach(t => { t.turns.forEach(u => { u.highlights.forEach(x => { out.push(Object.assign({}, x, { threadId: t.id, turnId: u.id, threadTitle: t.title, turnTitle: u.title, workspaceId: t.workspaceId, _ref: x })); }); }); });
			return out.sort((a, b) => a.createdAt < b.createdAt ? 1 : -1);
		}
		function listHighlights(L) {
			var hs = allHighlights();
			add(L, h("div", "list-h", h("span", null, "Grouped by thread"), h("span", "grow"),
				h("span", { style: "display:flex;gap:4px" }, ["amber", "green", "blue", "pink"].map(c => { return h("span", { class: "dot", style: "background:" + HLC[c] + ";width:9px;height:9px" }); }))));
			var sc = h("div", { class: "list-s", "data-sk": "hl" });
			var byT = {};
			hs.forEach(x => { (byT[x.threadId] = byT[x.threadId] || []).push(x); });
			Object.keys(byT).forEach(tid => {
				add(sc, h("div", "lgrp", icon("bubbles", 11), h("span", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, TH[tid].title)));
				byT[tid].forEach(x => {
					var sel = st.hlSel === x.id;
					add(sc, h("div", { class: "lrow" + (sel ? " sel" : ""), style: "grid-template-columns:14px 1fr auto", onclick: () => { st.hlSel = x.id; openThread(x.threadId, x.turnId, true); st.place = { kind: "highlights" }; render(); scrollToTurn(x.turnId, x.id); } },
						h("span", { class: "hlbar", style: "background:" + HLC[x.color] }),
						h("span", { class: "sn", style: "grid-column:2/3;color:inherit;font-size:12.5px;-webkit-line-clamp:3" }, "“" + plain(x.quote) + "”"), h("span", "tm", ago(x.createdAt)),
						h("span"), x.note ? h("span", { class: "mt", style: "white-space:normal" }, icon("note", 11), x.note) : h("span", "mt", x.turnTitle)));
				});
			});
			if (!hs.length) add(sc, h("div", { class: "empty sm", style: "height:auto;padding-top:80px" }, h("b", null, "No Highlights"), h("small", null, "Select text in an answer and choose Highlight.")));
			add(L, sc);
		}
		function notesIn() { return D.notes.slice().sort((a, b) => a.updatedAt < b.updatedAt ? 1 : -1); }
		function listNotes(L) {
			add(L, h("div", "list-h", h("span", null, "Outlines that link to threads"), h("span", "grow"), h("button", { class: "ibtn", style: "width:22px;height:22px", title: "New Note", onclick: newNote, html: svg("plus", 13) })));
			var sc = h("div", { class: "list-s", "data-sk": "notes" });
			notesIn().forEach(n => {
				var sel = n.id === st.noteId;
				var refs = noteRefs(n).length;
				add(sc, h("div", { class: "lrow" + (sel ? " sel" : ""), onclick: () => { st.noteId = n.id; render(); } },
					icon("note", 13, "lic"), h("span", "t", n.title), h("span", "tm", ago(n.updatedAt)),
					h("span"), h("span", "sn", (n.outline[0] && n.outline[0].text) || "Empty note"),
					h("span"), h("span", "mt", n.tags.slice(0, 3).map(g => h("span", "tok gray", g)), h("span", "sp"), refs ? h("span", "pv", icon("link", 11), pl(refs, "link")) : null)));
			});
			add(L, sc);
		}
		function listDrafts(L) {
			add(L, h("div", "list-h", h("span", null, "Unsent questions"), h("span", "grow")));
			var sc = h("div", { class: "list-s", "data-sk": "drafts" });
			D.drafts.forEach(d => {
				var sel = st.draftId === d.id;
				add(sc, h("div", { class: "lrow" + (sel ? " sel" : ""), onclick: () => { openDraft(d.id); } },
					icon("draft", 13, "lic"), h("span", "t", trunc(d.prompt, 60)), h("span", "tm", ago(d.updatedAt)),
					h("span"), h("span", "sn", d.prompt),
					h("span"), h("span", "mt", pv(d.provider, d.model, null), h("span", "sp"), h("span", "fold", icon("stack", 11), wsName(d.workspaceId)))));
			});
			if (!D.drafts.length) add(sc, h("div", { class: "empty sm", style: "height:auto;padding-top:80px" }, h("b", null, "No Drafts")));
			add(L, sc);
		}

		/* ---------- detail */
		function renderDetail() {
			var Dt = els.detail; if (!Dt) return;
			Dt.replaceChildren();
			var P = st.place;
			if (P.kind === "map") return detailMap(Dt);
			if (P.kind === "sources") return detailSources(Dt);
			if (P.kind === "notes") return detailNote(Dt);
			if (st.view === "columns" && isThreadPlace(P)) return detailColumns(Dt);
			if (st.newThread) return detailNew(Dt);
			var t = TH[st.threadId];
			if (!t) {
				var wsT = placeThreads(P.kind === "ws" ? P : { kind: "all" });
				if (!D.threads.length || (P.kind === "ws" && !wsT.length)) return detailEmptyWs(Dt);
				add(Dt, h("div", "empty", h("b", null, "No Thread Selected"), h("small", null, "⌘N New Thread · ⇧⌘O Open Quickly")));
				return;
			}
			if (st.view === "outline") return detailOutline(Dt, t);
			add(Dt, jumpBar(t));
			var conv = h("div", { class: "conv", "data-sk": "conv-" + t.id + "-" + st.lineId });
			conv.addEventListener("mouseup", onSelect);
			renderConvInto(conv, t);
			add(Dt, conv);
			add(Dt, composerEl());
		}
		function jumpBar(t) {
			var segs = [];
			segs.push(h("button", { class: "js", onclick: () => { goPlace({ kind: "ws", id: t.workspaceId }); } }, icon("stack", 12), h("span", null, wsName(t.workspaceId))));
			if (t.folderId) segs.push(h("span", { class: "sepc", html: svg("chevR", 9) }), h("button", { class: "js", onclick: () => { goPlace({ kind: "folder", id: t.folderId }); } }, icon("folder", 12), h("span", null, folderName(t.folderId))));
			var chain = []; var u = TU[st.lineId];
			while (u) { if (u.relation === "branch" || u.relation === "root") chain.unshift(u); u = u.parentId ? TU[u.parentId] : null; }
			chain.forEach((x, i) => {
				var cur = i === chain.length - 1;
				segs.push(h("span", { class: "sepc", html: svg("chevR", 9) }), h("button", { class: "js" + (cur ? " cur" : ""), title: x.relation === "root" ? t.title : "Branch: " + x.title, onclick: () => { st.lineId = x.id; st.focusTurn = null; st.composer.mode = "followup"; st.composer.anchor = null; render(); } },
					icon(x.relation === "root" ? "bubbles" : "branch", 12), h("span", null, x.relation === "root" ? trunc(t.title, 34) : x.title)));
			});
			return h("div", "jump", segs, h("span", "grow"));
		}
		function renderConvInto(conv, t) {
			var inn = h("div", "conv-in");
			var head = TU[st.lineId];
			var line = lineOf(st.lineId);
			if (head.relation === "root") {
				add(inn, h("div", "ttl", h("h1", null, t.title),
					h("div", "sub", t.tags.map(g => h("span", "tok gray", icon("tag", 10), g)),
						t.kind === "document" ? h("span", "tok", "Imported report") : null, t.kind === "post" ? h("span", "tok", "Saved link") : null)),
					t.recap ? h("div", "recap", h("b", null, "Recap"), t.recap) : null);
			} else {
				var par = TU[head.parentId];
				add(inn, h("div", "bctx",
					h("div", "h", icon("branch", 12), "Branch of ", h("b", { style: "color:var(--lbl);font-weight:600" }, par.title)),
					head.anchor ? h("blockquote", null, inline(head.anchor.quote)) : h("blockquote", { style: "color:var(--lbl2)" }, "Branched from the whole answer."),
					h("button", { class: "lnk", onclick: () => { st.lineId = headOf(par.id); render(); scrollToTurn(par.id); } }, "Show in parent line →")));
			}
			line.forEach((u, i) => { add(inn, turnEl(u, i)); });
			add(conv, inn);
		}
		function turnEl(u, i) {
			return st.style === "bubble" ? turnBubble(u, i) : turnDoc(u, i);
		}
		function relLabel(u, i) {
			if (u.relation === "root") return [icon("question", 12), "Question"];
			if (u.relation === "branch" && i === 0) return [icon("branch", 12), "Branch question"];
			return [icon("followup", 12), "Follow-up"];
		}
		function answerBlock(u) {
			var box = h("div", "ans");
			var brs = branchesOf(u.id);
			var marksByP = {};
			u.highlights.forEach(x => { (marksByP[x.paragraph] = marksByP[x.paragraph] || []).push({ q: x.quote, cls: "hl " + x.color, attrs: { "data-h": x.id, title: x.note || "Highlight" } }); });
			brs.forEach(b => { if (b.anchor) (marksByP[b.anchor.paragraph] = marksByP[b.anchor.paragraph] || []).push({ q: b.anchor.quote, cls: "anc", attrs: { "data-b": b.id, title: "Branch: " + b.title } }); });
			u.answer.forEach((p, pi) => {
				var hasB = brs.filter(b => b.anchor && b.anchor.paragraph === pi);
				var el;
				if (/^```/.test(p)) {
					var code = p.replace(/^```\w*\n?/, "").replace(/\n?```\s*$/, "");
					el = h("pre", { class: "para", "data-p": pi, "data-turn-p": u.id }, code);
				} else if (/^#{1,6} /.test(p)) {
					var nl = p.indexOf("\n");
					el = h("div", { class: "para", "data-p": pi, "data-turn-p": u.id }, h("h3", null, p.slice(0, nl < 0 ? undefined : nl).replace(/^#+ /, "")), nl >= 0 ? h("div", null, inline(p.slice(nl + 1), marksByP[pi])) : null);
				} else {
					el = h("p", { class: "para" + (hasB.length ? " hasb" : ""), "data-p": pi, "data-turn-p": u.id }, inline(p, marksByP[pi]));
				}
				if (u.status === "running" && pi === u.answer.length - 1) add(el, h("span", "caret"));
				add(box, el);
				if (hasB.length) add(box, h("div", "bchips", hasB.map(branchChip)));
			});
			box.addEventListener("click", e => {
				var m = e.target.closest("mark[data-b]");
				if (m) { st.lineId = m.getAttribute("data-b"); st.focusTurn = null; render(); return; }
				var hm = e.target.closest("mark[data-h]");
				if (hm) { st.insTab = "highlights"; st.insp = true; st.focusTurn = u.id; render(); }
			});
			return box;
		}
		function branchChip(b) {
			var n = lineOf(b.id).length;
			return h("button", { class: "bchip", title: "Open branch", onclick: () => { st.lineId = b.id; st.focusTurn = null; st.composer.mode = "followup"; render(); } },
				icon("branch", 12), h("span", null, b.title), h("small", null, n + (n === 1 ? " question" : " questions")), b.status === "running" ? h("span", { class: "spin", style: "color:var(--acc)" }) : null, icon("chevR", 10));
		}
		function statusBlock(u) {
			var out = [];
			if (u.status === "running") {
				var last = u.activity[u.activity.length - 1];
				out.push(h("div", "working", h("span", "spin"), h("span", "lab", "Working · " + (last ? last.label : "starting")),
					h("span", { "data-elapsed": u.id, style: "font-variant-numeric:tabular-nums;color:var(--lbl2)" }, dur(elapsed(u))),
					h("button", { class: "btn sm", onclick: () => { stopRun(u); } }, icon("stop", 10), "Stop")));
			}
			if (u.status === "queued") out.push(h("div", "callout plain", icon("clock", 15), h("div", null, h("b", null, "Queued"), "Runs after the current answer in this line finishes. A line runs one answer at a time.",
				h("div", "acts", h("button", { class: "btn sm", onclick: () => { st.composer.text = u.question; removeTurn(u); } }, "Edit Question"), h("button", { class: "btn sm", onclick: () => { removeTurn(u); } }, "Remove")))));
			if (u.status === "failed") out.push(h("div", "callout error", icon("warn", 15), h("div", null, h("b", null, "The run failed"), h("code", null, u.error || "Unknown error"),
				h("div", "acts", h("button", { class: "btn sm", onclick: () => { D.inbox = D.inbox.filter(x => x.turnId !== u.id); startRun(u); render(); } }, icon("retry", 11), "Retry"), h("button", { class: "btn sm", onclick: () => { st.insTab = "run"; st.insp = true; st.focusTurn = u.id; render(); } }, "Show Run")))));
			if (u.status === "needs-review") out.push(h("div", "callout attention", icon("clarify", 15), h("div", null, h("b", null, PLAB[u.provider] + " is asking a question"), u.clarification || "The run is waiting for a decision.",
				h("div", "acts", h("button", { class: "btn sm pri", onclick: () => { st.composer.mode = "followup"; renderComposerOnly(); } }, "Reply"), h("button", { class: "btn sm", onclick: () => { u.status = "done"; TH[u.threadId].status = "done"; D.inbox = D.inbox.filter(x => x.turnId !== u.id); render(); } }, "Mark as Resolved")))));
			if (u.status === "stopped") out.push(h("div", "callout plain", icon("stop", 13), h("div", null, h("b", null, "Stopped"), "The run was stopped after " + dur(u.durationSec) + ". The partial answer is kept.")));
			return out;
		}
		function removeTurn(u) {
			var t = TH[u.threadId]; t.turns = t.turns.filter(x => x !== u); delete TU[u.id];
			D.inbox = D.inbox.filter(x => x.turnId !== u.id);
			render();
		}
		function turnMenu(e, u) {
			var r = relRect(e.currentTarget);
			menu({ x: r.x - 160, y: r.y + r.h + 4 }, [
				{ label: "Branch from Whole Answer", icon: "branch", sc: "⇧⌘↩", disabled: u.status !== "done", run: () => { st.composer = { text: "", mode: "branch", anchor: null }; st.lineId = headOf(u.id); renderComposerOnly(); } },
				{ label: "Ask Again with Another Agent", icon: "cpu", disabled: u.status !== "done", run: () => { st.focusTurn = u.id; st.insTab = "model"; st.insp = true; render(); } },
				"-",
				{ label: "Show Run", icon: "list", run: () => { st.focusTurn = u.id; st.insTab = "run"; st.insp = true; render(); } },
				{ label: "Show Sources", icon: "globe", run: () => { st.focusTurn = u.id; st.insTab = "sources"; st.insp = true; render(); } },
				"-",
				{ label: "Copy Answer as Markdown", icon: "copy", run: () => {} },
				{ label: "Add Answer to Note…", icon: "note", run: () => { addToNote(u, null); } },
				{ label: "Retry Run", icon: "retry", disabled: u.status === "running", run: () => { startRun(u); render(); } }
			]);
		}
		function turnDoc(u, i) {
			var rl = relLabel(u, i);
			var foc = st.focusTurn === u.id;
			var wholeBr = branchesOf(u.id).filter(b => !b.anchor);
			return h("div", { class: "turn" + (foc ? " focus" : ""), "data-turn": u.id, onclick: e => { if (e.target.closest("button,mark,.bchip")) return; if (st.focusTurn !== u.id) { st.focusTurn = u.id; root.querySelectorAll(".turn.focus").forEach(n => { n.classList.remove("focus"); }); e.currentTarget.classList.add("focus"); renderInsp(); } } },
				h("div", "qhead", h("span", "rel", rl), h("span", null, "·"), h("span", null, ago(u.createdAt)), u.starred ? icon("bookmarkf", 10) : null, h("span", "grow")),
				h("div", "qbox", inline(u.question)),
				u.post ? h("div", { class: "callout plain", style: "margin-top:10px" }, icon("link", 15), h("div", null, h("b", null, u.post.linkTitle), u.post.author + " · " + u.post.domain)) : null,
				u.answer.length || u.status !== "queued" ? h("div", "ameta", pv(u.provider, u.model, u.effort), u.durationSec ? h("span", null, "· " + dur(u.durationSec)) : null,
					stBadge(u.status), u.activity.length ? h("button", { class: "lnk", style: "font-size:11.5px", onclick: () => { st.focusTurn = u.id; st.insTab = "run"; st.insp = true; render(); } }, pl(u.activity.length, "step")) : null,
					u.sources.length ? h("button", { class: "lnk", style: "font-size:11.5px", onclick: () => { st.focusTurn = u.id; st.insTab = "sources"; st.insp = true; render(); } }, pl(u.sources.length, "source")) : null,
					h("span", "grow"),
					h("button", { class: "ibtn", style: "width:24px;height:22px", title: "Answer actions", "aria-label": "Answer actions", onclick: e => { turnMenu(e, u); }, html: svg("ellipsisC", 15) })) : null,
				u.recap && !(u.relation === "root" && TH[u.threadId].recap) ? h("div", { class: "recap", style: "margin-top:0" }, h("b", null, "Recap"), u.recap) : null,
				statusBlock(u).slice(0, u.status === "running" ? 0 : 9),
				answerBlock(u),
				u.status === "running" ? statusBlock(u) : null,
				wholeBr.length ? h("div", "bchips", wholeBr.map(branchChip)) : null);
		}
		function turnBubble(u, i) {
			var rl = relLabel(u, i);
			var wholeBr = branchesOf(u.id).filter(b => !b.anchor);
			return h("div", { class: "turn", style: "border-top:0;padding-top:4px", "data-turn": u.id, onclick: e => { if (e.target.closest("button,mark")) return; st.focusTurn = u.id; renderInsp(); } },
				i === 0 || ago(u.createdAt) !== ago(lineOf(st.lineId)[i - 1].createdAt) ? h("div", "daysep", ago(u.createdAt).match(/:/) ? "Today " + ago(u.createdAt) : ago(u.createdAt)) : null,
				h("div", "bubrow", h("div", "bub q", inline(u.question)), h("div", "bubcap", rl)),
				u.answer.length || u.status === "running" ? h("div", "abubrow", h("div", "bub a", answerBlock(u)),
					h("div", "bubcap", pv(u.provider, u.model, u.effort), u.durationSec ? "· " + dur(u.durationSec) : null, stBadge(u.status),
						u.activity.length ? h("button", { class: "lnk", onclick: () => { st.focusTurn = u.id; st.insTab = "run"; st.insp = true; render(); } }, pl(u.activity.length, "step")) : null,
						u.sources.length ? h("button", { class: "lnk", onclick: () => { st.focusTurn = u.id; st.insTab = "sources"; st.insp = true; render(); } }, pl(u.sources.length, "source")) : null,
						h("button", { class: "ibtn", style: "width:22px;height:20px", title: "Answer actions", onclick: e => { turnMenu(e, u); }, html: svg("ellipsis", 14) }))) : null,
				statusBlock(u),
				wholeBr.length ? h("div", "bchips", wholeBr.map(branchChip)) : null);
		}

		/* selection HUD */
		function onSelect() {
			later(() => {
				var sel = window.getSelection();
				if (!sel || sel.isCollapsed) return;
				var txt = sel.toString().trim();
				if (txt.length < 3) return;
				var a = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
				var p = a && a.closest("[data-turn-p]");
				if (!p) return;
				var u = TU[p.getAttribute("data-turn-p")];
				var pi = Number(p.getAttribute("data-p"));
				var range = sel.getRangeAt(0);
				var R = range.getBoundingClientRect(), RR = rootRect(), s = scale();
				var x = (R.left - RR.left) / s + (R.width / s) / 2, y = (R.top - RR.top) / s;
				txt = txt.split("\n")[0];
				var running = u.status === "running";
				closeOv();
				var ov = h("div", { class: "ov", onmousedown: e => { if (e.target === ov) closeOv(); } });
				var hud = h("div", { class: "hud", role: "toolbar" },
					h("button", { disabled: running ? true : null, title: running ? "Wait for the answer to finish" : "Highlight", onclick: () => { u.highlights.push({ id: "hn" + Date.now(), paragraph: pi, quote: txt, color: "amber", note: null, createdAt: new Date(NOW).toISOString() }); closeOv(); render(); } }, h("span", { class: "dot", style: "background:var(--yellow)" }), "Highlight"),
					h("button", { disabled: running ? true : null, title: running ? "Wait for the answer to finish" : "Ask a question about this passage in a new branch", onclick: () => { closeOv(); st.lineId = headOf(u.id); st.composer = { text: "", mode: "branch", anchor: { turnId: u.id, paragraph: pi, quote: txt } }; render(); later(() => { var ta = root.querySelector(".composer textarea"); if (ta) ta.focus(); }, 20); } }, icon("branch", 13), "Branch"),
					h("button", { onclick: () => { closeOv(); addToNote(u, txt); } }, icon("note", 13), "Add to Note"),
					h("span", "vs"),
					h("button", { onclick: () => { copyText(txt); closeOv(); } }, icon("copy", 13), "Copy"));
				add(ov, hud); add(root, ov); ovEl = ov;
				hud.style.left = Math.max(8, Math.min(1280 - hud.offsetWidth - 8, x - hud.offsetWidth / 2)) + "px";
				hud.style.top = Math.max(8, y - 40) + "px";
			}, 10);
		}
		function addToNote(u, quote) {
			var t = TH[u.threadId];
			var n = D.notes.find(x => x.workspaceId === t.workspaceId);
			if (!n) { n = { id: "nn" + Date.now(), workspaceId: t.workspaceId, title: "Notes for " + wsName(t.workspaceId), updatedAt: new Date(NOW).toISOString(), tags: [], outline: [] }; D.notes.unshift(n); NO[n.id] = n; }
			n.outline.push({ text: quote ? "“" + plain(quote) + "”" : u.title, ref: { threadId: t.id, turnId: u.id }, _new: true });
			n.updatedAt = new Date(NOW).toISOString();
			st.place = { kind: "notes" }; st.noteId = n.id; st.view = "conversation";
			render();
			later(() => { var ns = root.querySelectorAll(".nrow"); var last = ns[ns.length - 1]; if (last) { last.scrollIntoView({ block: "center" }); last.classList.add("flash"); } }, 30);
		}

		/* new thread + empty workspace */
		function samples() {
			return [
				{ q: "In this repository, which functions allocate on the hot path of request handling? List them with file and line.", s: "Reads code in the workspace folder" },
				{ q: "Compare SQLite WAL mode and rollback journal for a write-heavy workload with one writer and many readers.", s: "Searches the web and cites sources" },
				{ q: "Summarize the Raft membership-change section of the Raft dissertation and list the known pitfalls.", s: "Good candidate for follow-ups and branches" }
			];
		}
		function detailNew(Dt) {
			var wsId = st.newWs || curWs();
			var wrap = h("div", "newt",
				h("h2", null, st.draftId ? "Draft" : "New Thread"),
				h("p", "lead", "Ask a question. Session starts the selected agent on this Mac with your sign-in and keeps the question, answer, run and sources as a thread you can continue or branch."),
				h("div", "where", "Save in", popup(wsName(wsId), D.workspaces.map(w => { return { label: w.name, value: w.id }; }), wsId, v => { st.newWs = v; st.newFolder = null; renderDetail(); }),
					popup(st.newFolder ? folderName(st.newFolder) : "No Folder", [{ label: "No Folder", value: null }].concat(D.folders.filter(f => f.workspaceId === wsId).map(f => { return { label: f.name, value: f.id }; })), st.newFolder, v => { st.newFolder = v; renderDetail(); }),
					h("span", { style: "flex:1" }), st.draftId ? null : h("button", { class: "btn sm", onclick: () => { if (!st.composer.text.trim()) return; D.drafts.unshift({ id: "dn" + Date.now(), workspaceId: wsId, prompt: st.composer.text, provider: nextAgent().provider, model: nextAgent().model, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() }); st.composer.text = ""; goPlace({ kind: "drafts" }); } }, "Save as Draft")),
				composerEl({ big: true }),
				h("div", "samples", h("h5", null, "Examples"), samples().map(x => {
					return h("button", { class: "sample", onclick: () => { st.composer.text = x.q; renderDetail(); } }, icon("question", 16), h("span", null, x.q, h("small", null, x.s)));
				})));
			add(Dt, wrap);
		}
		function detailEmptyWs(Dt) {
			var wsId = st.place.kind === "ws" ? st.place.id : D.workspaces[0].id;
			st.newWs = wsId;
			var ready = Object.keys(agents).filter(k => agents[k] === "ready");
			add(Dt, h("div", { class: "newt", style: "padding-top:90px" },
				h("div", { class: "appicon", style: "width:56px;height:56px;margin-bottom:14px", html: svg("branch", 30) }),
				h("h2", null, "Start a Thread in " + wsName(wsId)),
				h("p", "lead", "Ask a question. The answer stays here with its sources and run, and you can continue it with a follow-up or branch from any passage."),
				composerEl({ big: true }),
				h("div", { class: "where", style: "margin-top:10px" }, h("span", { class: "dot", style: "background:" + (ready.length ? "var(--green)" : "var(--orange)") }), ready.length ? ready.map(k => PLAB[k]).join(", ") + " ready" : "No agent ready", h("button", { class: "lnk", onclick: openAgents }, "Manage Agents…"), h("span", { style: "flex:1" }), h("button", { class: "lnk", onclick: () => { openSheet({ kind: "welcome", page: 0 }); } }, "How threads work")),
				h("div", "samples", h("h5", null, "Try one of these"), samples().map(x => {
					return h("button", { class: "sample", onclick: () => { st.composer.text = x.q; st.next = st.next || { provider: "claude", model: "opus", effort: "high" }; createThread(x.q, nextAgent()); } }, icon("question", 16), h("span", null, x.q, h("small", null, x.s)));
				}))));
		}

		/* outline (research tree) */
		function detailOutline(Dt, t) {
			add(Dt, jumpBar(t));
			var rows = [];
			function walk(u, depth) {
				var ch = kids(u.id);
				rows.push({ u: u, depth: depth, has: ch.length > 0 });
				if (ch.length && !st.ocl[u.id]) ch.sort((a, b) => a.relation === b.relation ? (a.createdAt < b.createdAt ? -1 : 1) : a.relation === "followup" ? -1 : 1).forEach(c => { walk(c, depth + 1); });
			}
			walk(rootOf(t), 0);
			var sel = st.outlineSel || rootOf(t).id;
			var tbl = h("div", { class: "otbl", role: "treegrid", "data-sk": "otbl" },
				h("div", "ohead", h("span", null, "Question"), h("span", null, "Agent"), h("span", null, "Status"), h("span", null, "Time")),
				rows.map(r => {
					var u = r.u;
					var ic = u.relation === "root" ? "question" : u.relation === "branch" ? "branch" : "followup";
					return h("div", { class: "orow" + (sel === u.id ? " sel" : ""), role: "row", "aria-level": String(r.depth + 1), onclick: () => { st.outlineSel = u.id; st.focusTurn = u.id; renderDetail(); renderInsp(); },
						ondblclick: () => { st.lineId = headOf(u.id); st.focusTurn = u.id; st.view = "conversation"; render(); scrollToTurn(u.id); } },
						h("span", { class: "nm", style: "padding-left:" + r.depth * 16 + "px" },
							h("span", { class: "tw" + (r.has ? (st.ocl[u.id] ? "" : " open") : " none"), html: svg("chevR", 10), onclick: e => { e.stopPropagation(); st.ocl[u.id] = !st.ocl[u.id]; renderDetail(); } }),
							icon(ic, 13), h("span", null, u.title)),
						h("span", null, PLAB[u.provider] + " · " + u.model), h("span", null, statusOf(u.status).label), h("span", null, u.durationSec ? dur(u.durationSec) : u.status === "running" ? dur(elapsed(u)) : "—"));
				}));
			var su = TU[sel];
			var pvw = h("div", "opv",
				h("div", { style: "display:flex;gap:8px;align-items:center;margin-bottom:6px" }, h("b", { style: "font-size:13px" }, su.title), h("span", { style: "flex:1" }),
					h("button", { class: "btn sm", onclick: () => { st.lineId = headOf(su.id); st.focusTurn = su.id; st.view = "conversation"; render(); scrollToTurn(su.id); } }, "Open in Conversation")),
				su.anchor ? h("div", { class: "bctx", style: "margin:0 0 8px" }, h("blockquote", null, inline(su.anchor.quote))) : null,
				h("div", "pvq", inline(su.question)), answerBlock(su));
			add(Dt, tbl, pvw, h("div", { class: "chelp", style: "padding:6px 14px;margin:0;max-width:none;border-top:1px solid var(--sep2)" }, icon("followup", 11), "Follow-up", icon("branch", 11), "Branch", h("span", "grow"), "Double-click a row to read it in the conversation."));
		}

		/* columns browser */
		function detailColumns(Dt) {
			var br = h("div", { class: "browser", "data-sk": "browser" });
			var ts = placeThreads(st.place);
			var c0 = h("div", "bcol first", h("div", "bhead", h("span", null, placeTitle(st.place))));
			ts.forEach(t => {
				add(c0, h("div", { class: "bitem" + (t.id === st.threadId ? (st.colPath && st.colPath.length ? " path" : " sel") : ""), onclick: () => { openThread(t.id, null, true); st.colPath = [rootOf(t).id]; render(); } },
					t.status === "running" ? h("span", { class: "spin", style: "color:var(--acc)" }) : icon("bubbles", 13), h("span", null, t.title), icon("chevR", 9, "chev")));
			});
			add(br, c0);
			var t = TH[st.threadId];
			var sel = null;
			if (t) {
				var path = st.colPath && st.colPath.length ? st.colPath : [rootOf(t).id];
				var line = lineOf(rootOf(t).id);
				var cols = [{ title: "Main line", groups: [{ head: null, items: line }] }];
				for (var k = 0; k < path.length; k++) {
					var pid = path[k];
					var bs = branchesOf(pid);
					if (!bs.length || k === path.length - 1 && false) break;
					if (k + 1 > path.length - 1) { cols.push({ title: "Branches of " + TU[pid].title, groups: bs.map(b => { return { head: b, items: lineOf(b.id) }; }), hint: true }); break; }
					cols.push({ title: "Branches of " + TU[pid].title, groups: bs.map(b => { return { head: b, items: lineOf(b.id) }; }) });
				}
				cols.forEach((col, ci) => {
					var c = h("div", "bcol", h("div", "bhead", h("span", null, col.title)));
					col.groups.forEach(g => {
						if (g.head) add(c, h("div", { class: "bhead", style: "padding-top:10px;font-weight:500" }, icon("branch", 11), h("span", null, g.head.anchor ? "“" + trunc(plain(g.head.anchor.quote), 30) + "”" : "Whole answer")));
						g.items.forEach(u => {
							var isSel = path[ci] === u.id;
							var last = isSel && ci === path.length - 1;
							var nb = branchesOf(u.id).length;
							add(c, h("div", { class: "bitem" + (last ? " sel" : isSel ? " path" : ""), title: u.title, onclick: () => { st.colPath = path.slice(0, ci).concat([u.id]); st.focusTurn = u.id; st.lineId = headOf(u.id); renderDetail(); renderInsp(); } },
								icon(u.relation === "followup" ? "followup" : u.relation === "branch" ? "branch" : "question", 13), h("span", null, u.title),
								u.status === "running" ? h("span", { class: "spin", style: "color:" + (last ? "#fff" : "var(--acc)") }) : u.status !== "done" ? h("span", { class: "dot", style: "background:" + (u.status === "failed" ? "var(--red)" : u.status === "needs-review" ? "var(--orange)" : "var(--gray)") }) : null,
								nb ? h("span", "n", String(nb)) : null, nb ? icon("chevR", 9, "chev") : null));
						});
					});
					add(br, c);
				});
				sel = TU[path[path.length - 1]];
			}
			var pv2 = h("div", { class: "preview", "data-sk": "preview" });
			if (sel) {
				add(pv2, h("div", "qhead", h("span", "rel", relLabel(sel, sel.relation === "branch" ? 0 : 1)), h("span", null, "· " + ago(sel.createdAt))),
					h("h2", null, sel.title),
					sel.anchor ? h("div", { class: "bctx", style: "margin:6px 0" }, h("div", "h", icon("branch", 11), "From ", TU[sel.anchor.turnId].title), h("blockquote", null, inline(sel.anchor.quote))) : null,
					h("div", "pvq", inline(sel.question)),
					h("div", "ameta", pv(sel.provider, sel.model, sel.effort), sel.durationSec ? "· " + dur(sel.durationSec) : null, stBadge(sel.status), h("span", "grow"),
						h("button", { class: "btn sm", onclick: () => { st.lineId = headOf(sel.id); st.focusTurn = sel.id; st.view = "conversation"; render(); scrollToTurn(sel.id); } }, "Open in Conversation")),
					statusBlock(sel), answerBlock(sel));
				pv2.addEventListener("mouseup", onSelect);
			} else add(pv2, h("div", "empty sm", h("b", null, "No Selection")));
			add(br, pv2);
			add(Dt, br);
			later(() => { br.scrollLeft = br.scrollWidth; }, 0);
		}

		/* notes */
		function noteRefs(n) { var out = []; (function w(items) { items.forEach(it => { if (it.ref) out.push(it.ref); if (it.children) w(it.children); }); })(n.outline); return out; }
		function detailNote(Dt) {
			var n = NO[st.noteId];
			if (!n) { add(Dt, h("div", "empty", h("b", null, "No Note Selected"))); return; }
			var ed = h("div", { class: "noted", "data-sk": "note-" + n.id });
			var inn = h("div", "noted-in");
			var title = h("h1", { contenteditable: "true", spellcheck: "false" }, n.title);
			title.addEventListener("input", () => { n.title = title.textContent; var li = els.list && els.list.querySelector(".lrow.sel .t"); if (li) li.textContent = n.title; });
			add(inn, title, h("div", "meta", icon("stack", 12), h("span", null, wsName(n.workspaceId)), h("span", null, "· Edited " + ago(n.updatedAt)), n.tags.map(g => h("span", "tok gray", icon("tag", 10), g))));
			function rowsFor(items, parent) {
				var box = h("div");
				items.forEach((it, idx) => {
					var has = it.children && it.children.length;
					var open = !it._closed;
					var tx = h("div", { class: "tx", contenteditable: "true", spellcheck: "false" }, it.text);
					tx.addEventListener("input", () => { it.text = tx.textContent; });
					tx.addEventListener("keydown", e => {
						if (e.key === "Enter") { e.preventDefault(); var ni = { text: "" }; items.splice(idx + 1, 0, ni); renderDetail(); focusItem(ni); }
						else if (e.key === "Tab" && !e.shiftKey && idx > 0) { e.preventDefault(); items.splice(idx, 1); var prev = items[idx - 1]; prev.children = prev.children || []; prev.children.push(it); prev._closed = false; renderDetail(); focusItem(it); }
						else if (e.key === "Tab" && e.shiftKey && parent) { e.preventDefault(); items.splice(idx, 1); var pl = parent.list, pi = pl.indexOf(parent.item); pl.splice(pi + 1, 0, it); renderDetail(); focusItem(it); }
						else if (e.key === "Backspace" && !it.text && !has) { e.preventDefault(); items.splice(idx, 1); renderDetail(); }
					});
					it._el = tx;
					var ref = it.ref && TH[it.ref.threadId] ? h("button", { class: "ref", title: "Open in thread", onclick: () => { openRef(it.ref); } }, icon(it.ref.turnId && TU[it.ref.turnId] && TU[it.ref.turnId].relation === "branch" ? "branch" : "bubbles", 11), h("span", null, it.ref.turnId && TU[it.ref.turnId] ? TU[it.ref.turnId].title : TH[it.ref.threadId].title)) : null;
					add(box, h("div", { class: "nrow" + (it._new ? " flash" : "") },
						h("span", { class: "tw" + (has ? (open ? " open" : "") : " none"), html: svg("chevR", 10), onclick: () => { it._closed = open; renderDetail(); } }),
						h("span", "bul", h("i", { class: has && !open ? "has" : "" })), tx, ref));
					delete it._new;
					if (has && open) { var k = rowsFor(it.children, { list: items, item: it }); k.className = "nkids"; add(box, k); }
				});
				return box;
			}
			add(inn, rowsFor(n.outline, null));
			add(inn, h("div", "nhint", "↩ new row · ⇥ indent · ⇧⇥ outdent · Add rows from any answer with Add to Note; each row keeps a link back to its thread."));
			add(ed, inn);
			add(Dt, ed);
		}
		function focusItem(it) { later(() => { if (it._el) { it._el.focus(); var r = document.createRange(); r.selectNodeContents(it._el); r.collapse(false); var s = getSelection(); s.removeAllRanges(); s.addRange(r); } }, 10); }
		function openRef(ref) {
			st.place = st.layout === "two" ? { kind: "tree" } : { kind: "all" };
			st.view = "conversation";
			openThread(ref.threadId, ref.turnId || null, true); render(); if (ref.turnId) scrollToTurn(ref.turnId);
		}

		/* sources */
		function allSources() {
			var map = {};
			D.threads.forEach(t => { t.turns.forEach(u => { u.sources.forEach(s => { var k = s.url; if (!map[k]) map[k] = Object.assign({ refs: [] }, s); map[k].refs.push({ threadId: t.id, turnId: u.id }); }); }); });
			return Object.keys(map).map(k => map[k]);
		}
		function detailSources(Dt) {
			var ss = allSources();
			var key = st.srcSort;
			ss.sort((a, b) => key === "title" ? a.title.localeCompare(b.title) : key === "domain" ? a.domain.localeCompare(b.domain) : b.refs.length - a.refs.length || a.title.localeCompare(b.title));
			function th(lbl, k) { return h("span", { onclick: () => { st.srcSort = k; renderDetail(); }, style: "cursor:default;" + (key === k ? "color:var(--lbl);font-weight:600" : "") }, lbl, key === k ? icon("chevD", 8) : null); }
			var tbl = h("div", { class: "tbl", "data-sk": "src", role: "grid" }, h("div", "thead", th("Title", "title"), th("Domain", "domain"), h("span", null, "Cited In"), th("Uses", "count")));
			ss.forEach(s => {
				var sel = st.srcSel === s.url;
				add(tbl, h("div", { class: "trow" + (sel ? " sel" : ""), role: "row", onclick: () => { st.srcSel = s.url; renderDetail(); renderInsp(); }, ondblclick: () => { openRef(s.refs[0]); } },
					h("span", null, h("span", "fav", s.domain.replace(/^www\./, "")[0].toUpperCase()), h("span", { style: "overflow:hidden;text-overflow:ellipsis" }, s.title)),
					h("span", null, s.domain), h("span", null, s.refs.map(r => TH[r.threadId].title).filter((v, i, a) => a.indexOf(v) === i).join(", ")), h("span", null, String(s.refs.length))));
			});
			add(Dt, tbl);
		}

		/* map */
		var MAPPOS = {
			t1: [36, 64], t2: [236, 150], t6: [36, 236], n1: [236, 290],
			t3: [442, 64], t7: [612, 150], t8: [442, 236], t4: [612, 330], n2: [442, 330], n3: [612, 430],
			t5: [36, 470], t10: [236, 556], t9: [36, 640], n4: [236, 650]
		};
		var ZONES = { "ws-compilers": [16, 20, 404, 370], "ws-ml": [422, 20, 368, 530], "ws-reading": [16, 410, 404, 330] };
		function mapNodes() {
			var out = [];
			D.threads.filter(t => !t.archivedAt).forEach(t => { out.push({ id: t.id, type: "thread", t: t }); });
			D.notes.forEach(n => { out.push({ id: n.id, type: "note", n: n }); });
			return out;
		}
		function mapEdges() {
			var e = [], seen = {};
			D.threads.forEach(t => { if (t.archivedAt) return; t.links.forEach(l => { if (!TH[l] || TH[l].archivedAt) return; var k = [t.id, l].sort().join("|"); if (seen[k]) return; seen[k] = 1; e.push({ from: t.id, to: l, type: "link" }); }); });
			D.notes.forEach(n => { noteRefs(n).forEach(r => { var k = n.id + "|" + r.threadId; if (seen[k] || !TH[r.threadId]) return; seen[k] = 1; e.push({ from: n.id, to: r.threadId, type: "note-ref" }); }); });
			return e;
		}
		function posOf(id, i) {
			if (st.mapPos[id]) return st.mapPos[id];
			if (MAPPOS[id]) return MAPPOS[id];
			return [440 + (i % 2) * 170, 600 + Math.floor(i / 2) * 70];
		}
		function detailMap(Dt) {
			var wrap = h("div", { class: "mapw", "data-sk": "map" });
			var cv = h("div", { class: "mapc", style: "transform:scale(" + st.mapZoom + ")" });
			D.workspaces.forEach(w => { var z = ZONES[w.id]; if (!z) return; add(cv, h("div", { class: "mzone", style: "left:" + z[0] + "px;top:" + z[1] + "px;width:" + z[2] + "px;height:" + z[3] + "px" }, h("b", null, icon("stack", 12), w.name))); });
			var nodes = mapNodes(), edges = mapEdges();
			var sel = st.mapSel;
			var nb = {}; if (sel) { nb[sel] = 1; edges.forEach(e => { if (e.from === sel) nb[e.to] = 1; if (e.to === sel) nb[e.from] = 1; }); }
			var NS = "http://www.w3.org/2000/svg";
			var sv = document.createElementNS(NS, "svg"); sv.setAttribute("class", "medges"); sv.setAttribute("width", "800"); sv.setAttribute("height", "760");
			var P = {}; nodes.forEach((n, i) => { P[n.id] = posOf(n.id, i); });
			edges.forEach(e => {
				var a = P[e.from], b = P[e.to]; if (!a || !b) return;
				var x1 = a[0] + 86, y1 = a[1] + 28, x2 = b[0] + 86, y2 = b[1] + 28;
				var mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1;
				var cx = mx - dy * 0.12, cy = my + dx * 0.12;
				var p = document.createElementNS(NS, "path");
				p.setAttribute("d", "M" + x1 + " " + y1 + " Q" + cx + " " + cy + " " + x2 + " " + y2);
				var on = sel && (e.from === sel || e.to === sel);
				p.setAttribute("fill", "none");
				p.setAttribute("stroke", e.type === "note-ref" ? "var(--acc)" : "var(--lbl3)");
				p.setAttribute("stroke-width", on ? "2.2" : "1.4");
				if (e.type === "note-ref") p.setAttribute("stroke-dasharray", "4 4");
				p.setAttribute("opacity", sel && !on ? ".25" : "1");
				add(sv, p);
			});
			add(cv, sv);
			nodes.forEach((n, i) => {
				var p = P[n.id];
				var isT = n.type === "thread";
				var title = isT ? n.t.title : n.n.title;
				var el = h("div", { class: "mnode" + (isT ? "" : " note") + (sel === n.id ? " sel" : "") + (sel && !nb[n.id] ? " dimn" : ""), style: "left:" + p[0] + "px;top:" + p[1] + "px", "data-id": n.id, title: title },
					h("div", "k", isT ? (n.t.status === "running" ? h("span", { class: "spin", style: "color:var(--acc);width:9px;height:9px" }) : icon(n.t.kind === "post" ? "link" : n.t.kind === "document" ? "doc" : "bubbles", 11)) : icon("note", 11),
						isT ? (n.t.kind === "post" ? "Saved link" : n.t.kind === "document" ? "Imported report" : threadCounts(n.t).q + (threadCounts(n.t).q === 1 ? " question" : " questions")) : "Note · " + pl(noteRefs(n.n).length, "link"),
						isT && n.t.status !== "done" ? stBadge(n.t.status) : null),
					h("b", null, title));
				el.addEventListener("pointerdown", ev => {
					ev.preventDefault();
					var sx = ev.clientX, sy = ev.clientY, ox = p[0], oy = p[1], moved = false, s = scale() * st.mapZoom;
					function mv(e2) { var dx = (e2.clientX - sx) / s, dy = (e2.clientY - sy) / s; if (Math.abs(dx) + Math.abs(dy) > 3) moved = true; if (moved) { st.mapPos[n.id] = [Math.max(0, ox + dx), Math.max(0, oy + dy)]; el.style.left = st.mapPos[n.id][0] + "px"; el.style.top = st.mapPos[n.id][1] + "px"; } }
					function up() { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); if (moved) renderDetail(); else { st.mapSel = n.id; renderDetail(); renderInsp(); } }
					window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
				});
				el.addEventListener("dblclick", () => { if (isT) { st.place = st.layout === "two" ? { kind: "tree" } : { kind: "all" }; openThread(n.id); } else { st.place = { kind: "notes" }; st.noteId = n.id; render(); } });
				add(cv, el);
			});
			add(wrap, cv);
			wrap.addEventListener("pointerdown", e => { if (e.target === wrap || e.target === cv || e.target.classList.contains("mzone")) { st.mapSel = null; renderDetail(); renderInsp(); } });
			add(Dt, wrap,
				h("div", "mlegend", h("span", null, h("i"), "Linked threads"), h("span", null, h("i", "d"), "Note references"), h("span", { style: "color:var(--lbl3)" }, "Drag to arrange · double-click to open")));
		}

		/* ---------- inspector */
		var TABS = [["thread", "info", "Thread"], ["model", "cpu", "Model"], ["run", "list", "Run"], ["sources", "globe", "Sources"], ["highlights", "highlighter", "Highlights"], ["links", "link", "Links"]];
		function renderInsp() {
			var I = els.insp; if (!I) return;
			I.replaceChildren();
			var P = st.place;
			if (P.kind === "map") return inspMap(I);
			if (P.kind === "notes") return inspNote(I);
			if (P.kind === "sources") return inspSource(I);
			var t = TH[st.threadId];
			if (!t || st.newThread) { add(I, h("div", "empty sm", h("b", null, "No Selection"), h("small", null, "Select a thread to see its model, run, sources and links."))); return; }
			add(I, h("div", { class: "itabs", role: "tablist" }, TABS.map(x => {
				return h("button", { role: "tab", "aria-selected": String(st.insTab === x[0]), class: st.insTab === x[0] ? "on" : "", title: x[2] + " Inspector", "aria-label": x[2], onclick: () => { st.insTab = x[0]; renderInsp(); }, html: svg(x[1], 15) });
			})));
			var sc = h("div", { class: "iscroll", "data-sk": "insp-" + st.insTab });
			var u = (st.focusTurn && TU[st.focusTurn]) || lineOf(st.lineId).slice(-1)[0];
			({ thread: inspThread, model: inspModel, run: inspRun, sources: inspSources, highlights: inspHighlights, links: inspLinks })[st.insTab](sc, t, u);
			add(I, sc);
		}
		function sec(title, body, extra) { return h("div", "isec", h("h4", null, h("span", "grow", title), extra || null), body); }
		function inspThread(sc, t) {
			var c = threadCounts(t);
			var name = h("input", { class: "field", value: t.title, "aria-label": "Title" });
			name.addEventListener("change", () => { t.title = name.value; render(); });
			var tokf = h("div", "tokf", t.tags.map(g => { return h("span", "tok", g, h("button", { class: "x", "aria-label": "Remove tag " + g, onclick: () => { t.tags = t.tags.filter(x => x !== g); renderInsp(); }, html: svg("x", 9) })); }));
			var ti = h("input", { placeholder: "Add tag", "aria-label": "Add tag" });
			ti.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === ",") && ti.value.trim()) { e.preventDefault(); t.tags.push(ti.value.trim().toLowerCase()); renderInsp(); var n = root.querySelector(".tokf input"); if (n) n.focus(); } });
			add(tokf, ti);
			var folders = [{ label: "No Folder", value: null }].concat(D.folders.filter(f => f.workspaceId === t.workspaceId).map(f => { return { label: f.name, value: f.id }; }));
			add(sc, sec("Thread", h("div", "form",
				h("label", null, "Title"), h("div", "v", name),
				h("label", null, "Workspace"), h("div", "v", h("span", { class: "ro", title: (D.workspaces.find(w => w.id === t.workspaceId) || {}).dir }, wsName(t.workspaceId))),
				h("label", null, "Folder"), h("div", "v", popup(t.folderId ? folderName(t.folderId) : "No Folder", folders, t.folderId, v => { t.folderId = v; render(); }, "wide")),
				h("label", null, "Tags"), h("div", "v", tokf),
				h("label", null, "Contains"), h("div", "v", h("span", "ro", pl(c.q, "question") + ": " + pl(c.f, "follow-up") + ", " + pl(c.b, "branch"))),
				h("label", null, "Created"), h("div", "v", h("span", "ro", ago(t.createdAt) + " · updated " + ago(t.updatedAt))))));
			function chk(on, label, sub, fn) { return h("button", { class: "chk" + (on ? " on" : ""), style: "text-align:left", onclick: fn }, h("span", { class: "box", html: on ? svg("check", 10) : "" }), h("span", null, label, h("small", null, sub))); }
			add(sc, sec("Keep", h("div", null,
				chk(t.bookmarked, "Bookmark", "Listed under Bookmarks in the sidebar.", () => { t.bookmarked = !t.bookmarked; render(); }),
				chk(t.followed, "Notify on new answers", "Send a notification when a run in this thread finishes.", () => { t.followed = !t.followed; renderInsp(); }),
				h("p", { style: "margin-top:6px" }, "To keep a passage, select it and choose Highlight."))));
			add(sc, sec("Recap", t.recap ? h("p", { style: "color:var(--lbl)" }, t.recap) : h("p", null, "No recap yet. A recap summarizes the whole thread above the first answer."),
				h("button", { class: "btn sm", onclick: () => { t.recap = t.recap || ("Covers " + c.q + " questions. Main finding: " + trunc(plain((rootOf(t).answer[0] || "")), 140)); render(); } }, t.recap ? "Regenerate…" : "Generate…")));
			add(sc, sec("", h("div", { style: "display:flex;gap:6px" }, h("button", { class: "btn sm", onclick: () => { t.archivedAt = t.archivedAt ? null : new Date(NOW).toISOString(); render(); } }, icon("archive", 12), t.archivedAt ? "Unarchive" : "Archive"))));
		}
		function inspModel(sc, t, u) {
			var ag = nextAgent();
			var prov = D.providers.find(p => p.id === ag.provider);
			function set(patch) {
				var n = Object.assign({}, ag, patch);
				if (patch.provider) { var pp = D.providers.find(p => p.id === patch.provider); n.model = pp.models[0]; n.effort = pp.efforts.length ? "high" : null; if (agents[patch.provider] !== "ready") { openAgents(); return; } }
				st.next = n; renderInsp(); renderComposerOnly();
			}
			add(sc, sec("Next Question", h("div", null, h("div", "form",
				h("label", null, "Agent"), h("div", "v", popup(PLAB[ag.provider], D.providers.map(p => { return { label: PLAB[p.id] + (agents[p.id] === "ready" ? "" : " (not ready)"), value: p.id }; }), ag.provider, v => { set({ provider: v }); }, "wide")),
				h("label", null, "Model"), h("div", "v", popup(ag.model, prov.models.map(m => { return { label: m, value: m }; }), ag.model, v => { set({ model: v }); }, "wide")),
				h("label", null, "Effort"), h("div", "v", prov.efforts.length ? h("div", { class: "seg sm", style: "width:100%" }, prov.efforts.slice(0, 5).map(e => { return h("button", { style: "flex:1;padding:0 2px", class: ag.effort === e ? "on" : "", onclick: () => { set({ effort: e }); } }, e === "medium" ? "med" : e); })) : h("span", { class: "ro", style: "color:var(--lbl2)" }, "Not configurable"))),
				h("p", { style: "margin-top:10px" }, "Follow-ups and branches start with the settings of the answer they continue. Changing them here applies to the next question only."))));
			if (u) {
				var others = D.providers.filter(p => p.id !== u.provider && agents[p.id] === "ready");
				add(sc, sec("Selected Answer", h("div", null, h("div", "form",
					h("label", null, "Question"), h("div", "v", h("span", "ro", u.title)),
					h("label", null, "Agent"), h("div", "v", pv(u.provider, u.model, u.effort)),
					h("label", null, "Duration"), h("div", "v", h("span", "ro", u.durationSec ? dur(u.durationSec) : u.status === "running" ? "Running" : "—")),
					h("label", null, "Status"), h("div", "v", stBadge(u.status) || h("span", "st ok", "Done"))),
					others.length && u.status === "done" ? h("div", { style: "margin-top:12px" }, h("p", { style: "margin-bottom:6px" }, "Compare agents: ask the same question again as a branch."),
						others.map(p => { return h("button", { class: "btn sm", style: "margin-right:6px", onclick: () => { askAgain(u, p.id); } }, icon("branch", 11), "Ask " + PLAB[p.id]); })) : null)));
			}
		}
		function askAgain(u, provider) {
			var pp = D.providers.find(p => p.id === provider);
			st.lineId = headOf(u.id);
			st.next = { provider: provider, model: pp.models[0], effort: pp.efforts.length ? "high" : null };
			st.composer = { text: u.question, mode: "branch", anchor: null };
			var t = TH[u.threadId];
			var line = lineOf(st.lineId);
			// branch from the parent of u (same context), or from u itself when it is the root
			var parentId = u.parentId || u.id;
			st.composer.anchor = null;
			var nid = t.id + "c" + Date.now();
			var nu = { id: nid, parentId: parentId, relation: "branch", anchor: null, question: u.question, title: u.title + " (" + PLAB[provider] + ")", provider: provider, model: st.next.model, effort: st.next.effort,
				status: "queued", createdAt: new Date(NOW).toISOString(), completedAt: null, durationSec: null, starred: false, recap: null, answer: [], error: null, sources: [], activity: [], highlights: [], threadId: t.id };
			t.turns.push(nu); TU[nid] = nu; st.lineId = nid; st.focusTurn = nid; st.composer = { text: "", mode: "followup", anchor: null }; st.next = null;
			startRun(nu); render();
		}
		function kindIcon(k) { return ({ think: "bulb", read: "doc", grep: "docsearch", search: "search", fetch: "globe", run: "terminal", edit: "pencil" })[k] || "list"; }
		function inspRun(sc, t, u) {
			if (!u) return;
			var head = h("div", "form",
				h("label", null, "Answer"), h("div", "v", h("span", "ro", u.title)),
				h("label", null, "Agent"), h("div", "v", pv(u.provider, u.model, u.effort)),
				h("label", null, "Status"), h("div", "v", stBadge(u.status) || h("span", "st ok", "Done"), u.status === "running" ? h("span", { "data-elapsed": u.id, style: "font-size:11.5px;color:var(--lbl2);font-variant-numeric:tabular-nums" }, dur(elapsed(u))) : u.durationSec ? h("span", { style: "font-size:11.5px;color:var(--lbl2)" }, dur(u.durationSec)) : null),
				u.status === "running" ? h("label") : null, u.status === "running" ? h("div", "v", h("button", { class: "btn sm", onclick: () => { stopRun(u); } }, icon("stop", 10), "Stop Run")) : null);
			add(sc, sec("Run", head));
			var steps = h("div");
			if (!u.activity.length) add(steps, h("p", null, u.status === "queued" ? "Not started. Queued behind the running answer." : "No tool calls recorded."));
			u.activity.forEach(a => {
				add(steps, h("div", { class: "step" + (a.status === "error" ? " err" : a.status === "running" ? " running" : "") },
					a.status === "running" ? h("span", { class: "ic", style: "width:14px;color:var(--acc)" }, h("span", "spin")) : icon(a.status === "error" ? "warn" : kindIcon(a.kind), 14),
					h("span", "lb", a.label), h("span", "ms", a.status === "running" ? "" : a.ms >= 1000 ? (a.ms / 1000).toFixed(1) + "s" : a.ms + "ms"),
					a.detail ? h("span", { class: "d", title: a.detail }, a.detail) : null));
			});
			add(sc, sec("Steps", steps, h("small", null, pl(u.activity.length, "tool call"))));
			if (u.error) add(sc, sec("Error", h("p", { style: "color:var(--red);font-family:'SF Mono',ui-monospace,Menlo,monospace;font-size:11px" }, u.error)));
		}
		function inspSources(sc, t, u) {
			var mode = st.srcScope || "answer";
			var list = [];
			if (mode === "answer" && u) list = u.sources.map(s => { return { s: s, u: u }; });
			else t.turns.forEach(x => { x.sources.forEach(s => { list.push({ s: s, u: x }); }); });
			add(sc, h("div", { style: "padding:10px 14px 0;display:flex" }, h("div", { class: "seg sm", style: "flex:1" },
				h("button", { style: "flex:1", class: mode === "answer" ? "on" : "", onclick: () => { st.srcScope = "answer"; renderInsp(); } }, "This Answer"),
				h("button", { style: "flex:1", class: mode === "thread" ? "on" : "", onclick: () => { st.srcScope = "thread"; renderInsp(); } }, "Whole Thread"))));
			var box = h("div");
			list.forEach(x => {
				add(box, h("div", { class: "srcrow", title: x.s.url }, h("span", "fav", x.s.domain.replace(/^www\./, "")[0].toUpperCase()), h("b", null, x.s.title), h("small", null, x.s.domain + (mode === "thread" ? " · " + x.u.title : ""))));
			});
			if (!list.length) add(box, h("p", null, mode === "answer" ? "This answer cites no pages." : "No pages cited in this thread."));
			add(sc, sec(mode === "answer" && u ? "Cited in “" + trunc(u.title, 26) + "”" : "Cited in this thread", box, h("small", null, String(list.length))));
		}
		function inspHighlights(sc, t) {
			var box = h("div");
			var any = false;
			t.turns.forEach(u => {
				u.highlights.forEach(x => {
					any = true;
					var ta = h("textarea", { placeholder: "Add a note", "aria-label": "Note" }); ta.value = x.note || "";
					ta.addEventListener("change", () => { x.note = ta.value || null; });
					add(box, h("div", "hlrow", h("span", { class: "bar", style: "background:" + HLC[x.color] }),
						h("div", { class: "qt", onclick: () => { st.lineId = headOf(u.id); render(); scrollToTurn(u.id, x.id); } }, "“" + plain(x.quote) + "”"),
						h("div", "nt", u.title + " · ", h("span", { style: "display:inline-flex;gap:4px;vertical-align:middle" }, ["amber", "green", "blue", "pink"].map(c => {
							return h("button", { "aria-label": c, class: "dot", style: "background:" + HLC[c] + ";width:10px;height:10px;" + (x.color === c ? "box-shadow:0 0 0 1.5px var(--pane),0 0 0 3px " + HLC[c] : ""), onclick: () => { x.color = c; render(); } });
						}))), ta));
				});
			});
			if (!any) add(box, h("p", null, "Select text in an answer and choose Highlight. Highlights can carry a colour and a note, and are collected under Highlights in the sidebar."));
			add(sc, sec("Highlights in This Thread", box));
		}
		function inspLinks(sc, t) {
			function lrow(id, sub) {
				var x = TH[id]; if (!x) return null;
				return h("div", { class: "lkrow", onclick: () => { openThread(id); } }, icon("bubbles", 13), h("span", null, x.title), sub ? h("small", null, sub) : null);
			}
			var out = t.links.map(l => lrow(l));
			add(sc, sec("Links", h("div", null, out.length ? out : h("p", null, "No links."), h("button", { class: "btn sm", style: "margin-top:6px", onclick: () => { openQuickly({ linkFrom: t.id }); } }, icon("plus", 10), "Add Link…"))));
			var back = D.threads.filter(x => x.id !== t.id && x.links.indexOf(t.id) >= 0).map(x => lrow(x.id));
			var nb = D.notes.filter(n => { return noteRefs(n).some(r => r.threadId === t.id); }).map(n => {
				return h("div", { class: "lkrow", onclick: () => { st.place = { kind: "notes" }; st.noteId = n.id; render(); } }, icon("note", 13), h("span", null, n.title), h("small", null, "note"));
			});
			add(sc, sec("Backlinks", h("div", null, back.concat(nb).length ? back.concat(nb) : h("p", null, "Nothing links here yet."))));
			var rel = D.threads.filter(x => { return x.id !== t.id && !x.archivedAt && x.tags.some(g => t.tags.indexOf(g) >= 0); });
			add(sc, sec("Shares a Tag", h("div", null, rel.length ? rel.map(x => { return lrow(x.id, x.tags.filter(g => t.tags.indexOf(g) >= 0)[0]); }) : h("p", null, "No other thread shares a tag."))));
		}
		function inspMap(I) {
			var sc = h("div", "iscroll");
			add(I, h("div", "itabs", h("span", { style: "font-size:11px;font-weight:600;color:var(--lbl2)" }, "Selection")));
			var id = st.mapSel;
			if (!id) { add(sc, h("div", "empty sm", h("b", null, "No Selection"), h("small", null, "Click a card to see its links. Double-click to open it."))); add(I, sc); return; }
			var t = TH[id], n = NO[id];
			var edges = mapEdges().filter(e => e.from === id || e.to === id);
			var conn = edges.map(e => {
				var o = e.from === id ? e.to : e.from;
				var lbl = TH[o] ? TH[o].title : NO[o] ? NO[o].title : o;
				return h("div", { class: "lkrow", onclick: () => { st.mapSel = o; renderDetail(); renderInsp(); } }, icon(NO[o] ? "note" : "bubbles", 13), h("span", null, lbl), h("small", null, e.type === "link" ? "link" : "note"));
			});
			if (t) {
				add(sc, sec(t.kind === "post" ? "Saved Link" : t.kind === "document" ? "Imported Report" : "Thread", h("div", null,
					h("div", { style: "font-weight:600;font-size:13px;margin-bottom:6px" }, t.title),
					h("div", "form",
						h("label", null, "Workspace"), h("div", "v", h("span", "ro", wsName(t.workspaceId) + (t.folderId ? " › " + folderName(t.folderId) : ""))),
						h("label", null, "Agent"), h("div", "v", pv(t.provider, t.model, null, { noEffort: true })),
						h("label", null, "Status"), h("div", "v", stBadge(t.status) || h("span", "st ok", "Done")),
						h("label", null, "Tags"), h("div", "v", t.tags.map(g => h("span", "tok", g)))),
					h("div", { style: "margin-top:10px;display:flex;gap:6px" }, h("button", { class: "btn sm pri", onclick: () => { st.place = { kind: "all" }; openThread(t.id); } }, "Open Thread"), h("button", { class: "btn sm", onclick: () => { openQuickly({ linkFrom: t.id }); } }, "Add Link…")))));
				if (t.recap) add(sc, sec("Recap", h("p", { style: "color:var(--lbl)" }, t.recap)));
			} else if (n) {
				add(sc, sec("Note", h("div", null, h("div", { style: "font-weight:600;font-size:13px;margin-bottom:6px" }, n.title),
					h("p", null, n.outline.map(o => o.text).slice(0, 3).join(" · ")),
					h("div", { style: "margin-top:10px" }, h("button", { class: "btn sm pri", onclick: () => { st.place = { kind: "notes" }; st.noteId = n.id; render(); } }, "Open Note")))));
			}
			add(sc, sec("Connected", h("div", null, conn.length ? conn : h("p", null, "No connections.")), h("small", null, String(conn.length))));
			add(I, sc);
		}
		function inspNote(I) {
			var n = NO[st.noteId];
			add(I, h("div", "itabs", h("span", { style: "font-size:11px;font-weight:600;color:var(--lbl2)" }, "Note")));
			var sc = h("div", "iscroll");
			if (!n) { add(I, sc); return; }
			var tokf = h("div", "tokf", n.tags.map(g => { return h("span", "tok", g, h("button", { class: "x", onclick: () => { n.tags = n.tags.filter(x => x !== g); render(); }, html: svg("x", 9) })); }));
			var ti = h("input", { placeholder: "Add tag" });
			ti.addEventListener("keydown", e => { if (e.key === "Enter" && ti.value.trim()) { n.tags.push(ti.value.trim()); render(); } });
			add(tokf, ti);
			add(sc, sec("Note", h("div", "form", h("label", null, "Workspace"), h("div", "v", h("span", "ro", wsName(n.workspaceId))), h("label", null, "Tags"), h("div", "v", tokf), h("label", null, "Edited"), h("div", "v", h("span", "ro", ago(n.updatedAt))))));
			var refs = noteRefs(n);
			var tids = refs.map(r => r.threadId).filter((v, i, a) => a.indexOf(v) === i);
			add(sc, sec("Links to Threads", h("div", null, tids.map(id => {
				var cnt = refs.filter(r => r.threadId === id).length;
				return TH[id] ? h("div", { class: "lkrow", onclick: () => { openRef({ threadId: id }); } }, icon("bubbles", 13), h("span", null, TH[id].title), h("small", null, cnt + "×")) : null;
			})), h("small", null, String(tids.length))));
			add(I, sc);
		}
		function inspSource(I) {
			add(I, h("div", "itabs", h("span", { style: "font-size:11px;font-weight:600;color:var(--lbl2)" }, "Source")));
			var sc = h("div", "iscroll");
			var s = allSources().find(x => x.url === st.srcSel);
			if (!s) { add(sc, h("div", "empty sm", h("b", null, "No Selection"), h("small", null, "Select a page to see where it is cited."))); add(I, sc); return; }
			add(sc, sec("Page", h("div", null, h("div", { style: "font-weight:600;margin-bottom:4px" }, s.title), h("p", { style: "word-break:break-all" }, s.url))));
			add(sc, sec("Cited In", h("div", null, s.refs.map(r => { return h("div", { class: "lkrow", onclick: () => { openRef(r); } }, icon("bubbles", 13), h("span", null, TU[r.turnId].title), h("small", null, trunc(TH[r.threadId].title, 18))); }))));
			add(I, sc);
		}

		/* ---------- open quickly */
		function openQuickly(opts) {
			opts = opts || {};
			closeOv();
			var ov = h("div", { class: "ov", onmousedown: e => { if (e.target === ov) closeOv(); } });
			var input = h("input", { placeholder: opts.linkFrom ? "Link to thread…" : "Open Quickly: threads, questions, notes, highlights", "aria-label": "Open Quickly" });
			var res = h("div", { class: "oq-res", role: "listbox" });
			var box = h("div", { class: "oq", role: "dialog", "aria-label": "Open Quickly" }, h("div", "oq-in", icon("search", 20), input), res,
				h("div", "oq-foot", h("span", null, "↑↓ Select"), h("span", null, "↩ Open"), h("span", null, "esc Close"), h("span", { style: "flex:1" }), h("span", null, "Searches titles, questions, answers, notes and highlights")));
			var items = [], idx = 0;
			function build() {
				var q = input.value.trim().toLowerCase();
				items = [];
				D.threads.forEach(t => {
					if (opts.linkFrom && t.id === opts.linkFrom) return;
					if (!q || t.title.toLowerCase().indexOf(q) >= 0 || t.tags.join(" ").indexOf(q) >= 0) items.push({ g: "Threads", icon: "bubbles", label: t.title, sub: wsName(t.workspaceId), go: () => { if (opts.linkFrom) { TH[opts.linkFrom].links.push(t.id); t.links.push(opts.linkFrom); st.insTab = "links"; render(); } else { if (!isThreadPlace(st.place) && st.place.kind !== "tree") st.place = st.layout === "two" ? { kind: "tree" } : { kind: "all" }; openThread(t.id); } } });
				});
				if (!opts.linkFrom && q) {
					D.threads.forEach(t => { t.turns.forEach(u => { if (u.relation === "root") return; var text = (u.title + " " + plain(u.question) + " " + u.answer.map(plain).join(" ")).toLowerCase(); if (text.indexOf(q) >= 0) items.push({ g: "Questions and Answers", icon: u.relation === "branch" ? "branch" : "followup", label: u.title, sub: trunc(t.title, 34), go: () => { openRef({ threadId: t.id, turnId: u.id }); } }); }); });
					D.notes.forEach(n => { var text = (n.title + " " + JSON.stringify(n.outline)).toLowerCase(); if (text.indexOf(q) >= 0) items.push({ g: "Notes", icon: "note", label: n.title, sub: wsName(n.workspaceId), go: () => { st.place = { kind: "notes" }; st.noteId = n.id; render(); } }); });
					allHighlights().forEach(x => { if ((plain(x.quote) + " " + (x.note || "")).toLowerCase().indexOf(q) >= 0) items.push({ g: "Highlights", icon: "highlighter", label: plain(x.quote), sub: trunc(x.threadTitle, 30), go: () => { openRef({ threadId: x.threadId, turnId: x.turnId }); } }); });
				}
				items = items.slice(0, 40);
				idx = Math.min(idx, Math.max(0, items.length - 1));
				res.replaceChildren();
				var lastG = null;
				items.forEach((it, i) => {
					if (it.g !== lastG) { add(res, h("div", "oq-g", it.g)); lastG = it.g; }
					add(res, h("div", { class: "oq-r" + (i === idx ? " on" : ""), role: "option", onmousemove: () => { if (idx !== i) { idx = i; build(); } }, onclick: () => { closeOv(); it.go(); } }, icon(it.icon, 15), h("span", null, it.label), h("small", null, it.sub)));
				});
				if (!items.length) add(res, h("div", { class: "oq-g", style: "padding:14px" }, "No matches"));
			}
			input.addEventListener("input", () => { idx = 0; build(); });
			input.addEventListener("keydown", e => {
				if (e.key === "ArrowDown") { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); build(); }
				else if (e.key === "ArrowUp") { e.preventDefault(); idx = Math.max(0, idx - 1); build(); }
				else if (e.key === "Enter") { e.preventDefault(); var it = items[idx]; if (it) { closeOv(); it.go(); } }
				else if (e.key === "Escape") { e.preventDefault(); closeOv(); }
				e.stopPropagation();
			});
			add(ov, box); add(root, ov); ovEl = ov;
			build(); input.focus();
		}

		/* ---------- sheets: welcome + agents */
		function openSheet(s) { st.sheet = s; closeOvOnly(); showSheet(); }
		function closeOvOnly() { if (ovEl) { ovEl.remove(); ovEl = null; } }
		function openAgents() { openSheet({ kind: "agents" }); }
		function showSheet() {
			closeOvOnly();
			if (!st.sheet) return;
			var s = st.sheet;
			var ov = h("div", "ov dim");
			var sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true", style: "width:" + (s.kind === "agents" ? 560 : 640) + "px;max-height:" + (s.kind === "agents" ? 520 : 680) + "px" });
			function done() { st.sheet = null; closeOvOnly(); render(); }
			if (s.kind === "agents") {
				add(sheet, h("div", "sb", h("h2", { style: "text-align:left;font-size:17px;margin:0 0 4px" }, "Agents"),
					h("p", { class: "lead", style: "text-align:left;margin:0 0 10px" }, "Session runs agent command-line tools installed on this Mac, using the sign-in you already have. Status updates on its own when a sign-in completes."),
					agentTable()), h("div", "sf", h("span", "grow"), h("button", { class: "btn pri lg", onclick: done }, "Done")));
			} else {
				var pg = s.page || 0;
				var pages = [welcomePage0, welcomePage1, welcomePage2];
				add(sheet, h("div", "sb", pages[pg]()),
					h("div", "sf",
						h("button", { class: "btn lg", onclick: () => { if (st.firstRun && !D.threads.length) { done(); } else done(); } }, pg === 2 ? "Close" : "Skip"),
						h("span", "grow"), h("div", "pdots", [0, 1, 2].map(i => { return h("i", { class: i === pg ? "on" : "" }); })), h("span", "grow"),
						pg > 0 ? h("button", { class: "btn lg", onclick: () => { st.sheet.page = pg - 1; showSheet(); } }, "Back") : null,
						pg < 2 ? h("button", { class: "btn pri lg", onclick: () => { st.sheet.page = pg + 1; showSheet(); } }, "Continue") : null));
			}
			add(ov, sheet); add(root, ov); ovEl = ov;
			var f = sheet.querySelector(".btn.pri"); if (f) f.focus({ preventScroll: true });
		}
		function welcomePage0() {
			return h("div", null,
				h("div", { class: "appicon", html: svg("branch", 34) }),
				h("h2", null, "Welcome to Session"),
				h("p", "lead", "Ask a coding agent on this Mac a question. Session keeps each question, answer, run and source as a thread, and lets you grow it into a tree."),
				diagram(),
				h("div", "defs",
					icon("question", 16), h("div", null, h("b", null, "Question"), h("span", null, "Starts a thread. The agent runs with your existing sign-in and can read the workspace folder.")),
					icon("followup", 16), h("div", null, h("b", null, "Follow-up"), h("span", null, "Continues the same line. The agent keeps the earlier answers as context.")),
					icon("branch", 16), h("div", null, h("b", null, "Branch"), h("span", null, "Starts a separate line from a passage or a whole answer. The original line stays unchanged."))));
		}
		function diagram() {
			var W = 520, H = 150;
			var s = '<svg class="diagram" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '" fill="none" font-size="11">' +
				'<rect x="20" y="10" width="200" height="30" rx="8" fill="var(--acc)"/><text x="34" y="29" fill="#fff" font-weight="600">Question</text>' +
				'<rect x="20" y="48" width="200" height="40" rx="8" fill="var(--card)" stroke="var(--sep)"/><text x="34" y="64" fill="var(--lbl2)">Answer</text>' +
				'<rect x="34" y="70" width="120" height="10" rx="2" fill="var(--anchor)" stroke="var(--acc)" stroke-dasharray="2 2"/>' +
				'<path d="M120 88v14" stroke="var(--lbl3)" stroke-width="1.5"/><path d="m116 98 4 5 4-5" stroke="var(--lbl3)" stroke-width="1.5"/>' +
				'<rect x="20" y="106" width="200" height="30" rx="8" fill="var(--fill2)"/><text x="34" y="125" fill="var(--lbl)" font-weight="600">Follow-up</text><text x="98" y="125" fill="var(--lbl2)">same line</text>' +
				'<path d="M154 75 C 230 75, 250 60, 300 60" stroke="var(--acc)" stroke-width="1.5"/><path d="m295 55 6 5-6 5" stroke="var(--acc)" stroke-width="1.5"/>' +
				'<rect x="304" y="44" width="196" height="32" rx="8" fill="var(--card)" stroke="var(--acc)"/><text x="318" y="64" fill="var(--acc)" font-weight="600">Branch</text><text x="366" y="64" fill="var(--lbl2)">from the passage</text>' +
				'<text x="304" y="96" fill="var(--lbl2)">a separate line; the original</text><text x="304" y="110" fill="var(--lbl2)">answer is not changed</text>' +
				"</svg>";
			return h("div", { html: s });
		}
		function welcomePage1() {
			return h("div", null, h("h2", null, "Connect an Agent"),
				h("p", "lead", "You need at least one agent command-line tool installed and signed in. Session detects sign-ins automatically; there is nothing to refresh."),
				agentTable());
		}
		function agentTable() {
			var rows = [
				{ id: "claude", cmd: "claude auth login", ver: "Signed in" },
				{ id: "codex", cmd: "codex login", ver: "Signed in" },
				{ id: "grok", cmd: "grok login", ver: "Signed in" }
			];
			return h("div", "agtbl", rows.map(r => {
				var s = agents[r.id];
				var stEl = s === "ready" ? h("small", null, h("span", { class: "dot", style: "background:var(--green)" }), "Ready · " + r.ver) :
					s === "waiting" ? h("small", null, h("span", { class: "spin", style: "color:var(--acc)" }), "Waiting for sign-in in Terminal…") :
						s === "signin" ? h("small", null, h("span", { class: "dot", style: "background:var(--orange)" }), "Installed, not signed in") :
							h("small", null, h("span", { class: "dot", style: "background:var(--gray)" }), "Not installed");
				return h("div", "agrow", h("span", { class: "g", style: "background:" + PCOL[r.id] }, PLAB[r.id][0]), h("b", null, PLAB[r.id]),
					s === "ready" ? icon("checkC", 18) : h("span"),
					stEl,
					s === "ready" ? h("span") : null,
					s === "signin" || s === "waiting" ? h("div", "cmd", h("code", null, r.cmd), h("button", { class: "btn sm", onclick: () => { copyText(r.cmd); agents[r.id] = "waiting"; showSheet(); later(() => { agents[r.id] = "ready"; if (st.sheet) showSheet(); renderSide(); }, 2400); } }, "Copy Command")) : null,
					s === "missing" ? h("div", "cmd", h("span", { style: "flex:1;font-size:11.5px;color:var(--lbl2)" }, "Install the Grok CLI, then run ", h("code", { style: "flex:none" }, r.cmd), "."), h("button", { class: "btn sm", disabled: true }, "Install Guide")) : null);
			}));
		}
		function welcomePage2() {
			var wsId = D.workspaces[0].id;
			return h("div", null, h("h2", null, "Ask Your First Question"),
				h("p", "lead", "Threads are saved in the workspace " + wsName(wsId) + " (" + D.workspaces[0].dir + "). Pick an example or close this sheet and type your own."),
				samples().map(x => {
					return h("button", { class: "sample", onclick: () => { st.sheet = null; closeOvOnly(); st.next = { provider: "claude", model: "opus", effort: "high" }; st.newWs = wsId; createThread(x.q, st.next); } }, icon("question", 16), h("span", null, x.q, h("small", null, x.s)));
				}),
				st.firstRun ? h("div", { style: "text-align:center;margin-top:12px;font-size:12px;color:var(--lbl2)" }, "Prefer to look around first? ",
					h("button", { class: "lnk", onclick: () => { loadData(false); agents.codex = "ready"; st.firstRun = false; st.sheet = null; closeOvOnly(); st.place = { kind: "all" }; openThread("t1", null, true); render(); } }, "Open the sample library")) : null);
		}

		/* ---------- keyboard */
		function onKey(e) {
			var mod = e.metaKey || e.ctrlKey;
			var inField = e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable);
			if (e.key === "Escape") { if (ovEl) { e.preventDefault(); if (st.sheet) { st.sheet = null; } closeOvOnly(); render(); return; } }
			if (mod && e.shiftKey && (e.key === "o" || e.key === "O")) { e.preventDefault(); openQuickly(); return; }
			if (mod && !e.shiftKey && (e.key === "n" || e.key === "N")) { e.preventDefault(); newThread(); return; }
			if (mod && !e.shiftKey && (e.key === "f" || e.key === "F")) { e.preventDefault(); var s = root.querySelector(".search input"); if (s) s.focus(); return; }
			if (mod && e.altKey && (e.key === "i" || e.key === "I" || e.code === "KeyI")) { e.preventDefault(); st.insp = !st.insp; render(); return; }
			if (e.ctrlKey && e.metaKey && (e.key === "s" || e.key === "S")) { e.preventDefault(); st.side = !st.side; render(); return; }
			if (mod && ["1", "2", "3"].indexOf(e.key) >= 0 && st.threadId) { e.preventDefault(); setView(["conversation", "outline", "columns"][Number(e.key) - 1]); return; }
			if (inField || ovEl) return;
			if ((e.key === "ArrowDown" || e.key === "ArrowUp") && els.list && isThreadPlace(st.place) && st.view !== "columns") {
				var ts = placeThreads(st.place); var i = ts.findIndex(t => t.id === st.threadId);
				var n = ts[Math.max(0, Math.min(ts.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
				if (n) { e.preventDefault(); openThread(n.id); var r = root.querySelector('.lrow[data-tid="' + n.id + '"]'); if (r) r.scrollIntoView({ block: "nearest" }); }
			}
		}
		root.setAttribute("tabindex", "-1");
		root.addEventListener("keydown", onKey);

		/* elapsed ticker */
		var tick = setInterval(() => {
			root.querySelectorAll("[data-elapsed]").forEach(n => { var u = TU[n.getAttribute("data-elapsed")]; if (u && u.status === "running") n.textContent = dur(elapsed(u)); });
		}, 1000);

		render();
		if (cfg.firstRun) { st.sheet = { kind: "welcome", page: 0 }; showSheet(); }
		try { root.focus({ preventScroll: true }); } catch (e) { /* ignore */ }

		return function cleanup() {
			disposed = true;
			timers.forEach(clearTimeout);
			clearInterval(tick);
			root.removeEventListener("keydown", onKey);
			root.removeAttribute("tabindex");
			root.replaceChildren();
		};
	}

	window.SessionMocks.register({
		id: "macos", round: 1,
		name: "Source List & Inspector",
		reference: "macOS system apps (Apple HIG)",
		summary: "Session as a native Mac app: a translucent source list of places and workspaces, a Mail-style thread list, a conversation that reads top to bottom, and an Xcode-style Inspector for model, run, sources, highlights and links.",
		principles: [
			"NavigationSplitView: source list (sections with disclosure, monochrome symbols, counts) › content list › detail › trailing Inspector with icon tabs, as in Mail and Xcode.",
			"Unified toolbar with title and subtitle, a Conversation / Outline / Columns segmented control (Finder view modes), a search field and the Inspector toggle.",
			"One name per object: Thread (the tree), Question, Follow-up, Branch. Workspaces use a stack symbol and are section headers; Folders use the folder symbol and live inside them.",
			"Folders are filters, not exile: All Threads lists everything, so filing a thread never hides it. Inbox collects what needs you (questions from agents, failures, new answers, runs).",
			"Two ways to keep things: Bookmark for a thread and Highlight (with colour and note) for a passage. Follow becomes “Notify on new answers” in the Inspector; Star and Post are removed from primary UI.",
			"Standard controls only: pop-up buttons for agent/model/effort, segmented controls, token fields for tags, sheets for Welcome and Agents, a Spotlight-style Open Quickly (⇧⌘O), context menus with the same items as the … button.",
			"Keyboard first: ⌘N new thread, ⌘F search, ⇧⌘O open quickly, ⌘1/2/3 view modes, ⌥⌘I Inspector, ⌃⌘S sidebar, ↑↓ in lists, ↩ to send."
		],
		chat: "The detail pane reads one line of the tree top to bottom: question, model and duration, answer, then follow-ups. The composer at the bottom has a Follow-up / Branch segmented control with a one-line explanation, and pop-up buttons that always show the agent, model and effort for the next question. A running line queues new follow-ups with a visible reason; branches open as their own line with a breadcrumb in the jump bar, and “Ask Codex” in the Inspector re-asks the same question as a branch to compare agents.",
		knowledge: "The research tree is viewable as an outline (NSOutlineView with disclosure rows, columns for agent/status/time) or as Finder-style columns. Notes are outlines whose rows link back to a question; any selected passage can be highlighted, branched, or added to a note. Links, backlinks and shared tags sit in the Inspector, and Map shows threads and notes as a Freeform-style board grouped by workspace.",
		firstRun: "A Welcome sheet explains question, follow-up and branch with one diagram, shows agent status with a copyable sign-in command that updates on its own, and offers example questions. Behind it, the empty workspace puts the composer in the middle of the window, not in a side column.",
		variants: VARIANTS,
		fonts: "family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400",
		css: CSS,
		mount: mount
	});
})();
