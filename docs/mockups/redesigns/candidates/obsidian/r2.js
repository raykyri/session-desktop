/*
 * Session redesign candidate "obsidian", round 2.
 * Reference: Obsidian. The research library is a vault of Markdown notes: each thread is a note
 * whose body is the conversation, branches are linked notes, highlights are block references,
 * and the graph, canvas, backlinks and outline panes are views over the same files.
 *
 * Round 2: docked ask bar with Follow-up / Branch, Start here note, graph preview pane,
 * unified note menu, editable highlights, search operators. See `changes` below.
 */
(() => {
"use strict";
var P = ".m-obsidian-r2";

/* ------------------------------------------------------------------ icons (Lucide-style paths) */
var IC = {
	folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
	files: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4"],
	file: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M10 9H8", "M16 13H8", "M16 17H8"],
	search: ["c:11,11,8", "m21 21-4.3-4.3"],
	bookmark: ["m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"],
	activity: ["M22 12h-4l-3 9L9 3l-3 9H2"],
	graph: ["c:12,18,3", "c:6,6,3", "c:18,6,3", "M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9", "M12 12v3"],
	canvas: ["r:3,3,7,9,1", "r:14,3,7,5,1", "r:14,12,7,9,1", "r:3,16,7,5,1"],
	terminal: ["m4 17 6-6-6-6", "M12 19h8"],
	plus: ["M5 12h14", "M12 5v14"],
	minus: ["M5 12h14"],
	edit: ["M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7", "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"],
	chevR: ["m9 18 6-6-6-6"],
	chevD: ["m6 9 6 6 6-6"],
	chevUD: ["m7 15 5 5 5-5", "m7 9 5-5 5 5"],
	x: ["M18 6 6 18", "m6 6 12 12"],
	more: ["c:12,12,1", "c:19,12,1", "c:5,12,1"],
	link: ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"],
	list: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
	tag: ["M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z", "c:7.5,7.5,.5"],
	book: ["M12 7v14", "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"],
	settings: ["c:12,12,3", "c:12,12,7.5", "M12 2v2.5", "M12 19.5V22", "M2 12h2.5", "M19.5 12H22", "m4.9 4.9 1.8 1.8", "m17.3 17.3 1.8 1.8", "m4.9 19.1 1.8-1.8", "m17.3 6.7 1.8-1.8"],
	help: ["c:12,12,10", "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3", "M12 17h.01"],
	reading: ["M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z", "c:12,12,3"],
	arrowL: ["m12 19-7-7 7-7", "M19 12H5"],
	arrowR: ["M5 12h14", "m12 5 7 7-7 7"],
	arrowUp: ["m5 12 7-7 7 7", "M12 19V5"],
	sideL: ["r:3,3,18,18,2", "M9 3v18"],
	sideR: ["r:3,3,18,18,2", "M15 3v18"],
	chat: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
	stop: ["r:6,6,12,12,1"],
	branch: ["M6 3v12", "c:18,6,3", "c:6,18,3", "M18 9a9 9 0 0 1-9 9"],
	external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
	check: ["M20 6 9 17l-5-5"],
	alert: ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"],
	xcircle: ["c:12,12,10", "m15 9-6 6", "m9 9 6 6"],
	loader: ["M21 12a9 9 0 1 1-6.219-8.56"],
	copy: ["r:8,8,14,14,2", "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"],
	extract: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M12 18v-6", "m9 15 3 3 3-3"],
	refresh: ["M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5"],
	vault: ["M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z", "m3.3 7 8.7 5 8.7-5", "M12 22V12"],
	highlight: ["m9 11-6 6v3h9l3-3", "m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"],
	quote: ["M17 6H3", "M21 12H8", "M21 18H8", "M3 12v6"],
	list2: ["M3 12h18", "M3 6h18", "M3 18h12"],
	calendar: ["r:3,4,18,18,2", "M16 2v4", "M8 2v4", "M3 10h18"],
	cloud: ["M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"],
	fit: ["M8 3H5a2 2 0 0 0-2 2v3", "M21 8V5a2 2 0 0 0-2-2h-3", "M3 16v3a2 2 0 0 0 2 2h3", "M16 21h3a2 2 0 0 0 2-2v-3"],
	archive: ["r:2,3,20,5,1", "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8", "M10 12h4"],
	sort: ["m3 16 4 4 4-4", "M7 20V4", "M11 4h10", "M11 8h7", "M11 12h4"],
	collapse: ["m7 20 5-5 5 5", "m7 4 5 5 5-5"],
	folderPlus: ["M12 10v6", "M9 13h6", "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
	globe: ["c:12,12,10", "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", "M2 12h20"],
	split: ["r:3,3,18,18,2", "M12 3v18"],
	think: ["M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5", "M9 18h6", "M10 22h4"],
	run: ["m4 17 6-6-6-6", "M12 19h8"],
	pen: ["M12 20h9", "M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"]
};
var STEP_ICON = { think: "think", read: "file", grep: "search", search: "globe", fetch: "globe", run: "run", edit: "pen" };

function svgNode(tag, attrs) {
	var n = document.createElementNS("http://www.w3.org/2000/svg", tag);
	for (var k in attrs) n.setAttribute(k, attrs[k]);
	return n;
}
function icon(name, size, cls) {
	size = size || 16;
	var s = svgNode("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.9", "stroke-linecap": "round", "stroke-linejoin": "round", "class": "o-ic" + (cls ? " " + cls : ""), "aria-hidden": "true" });
	(IC[name] || IC.file).forEach(d => {
		if (d.indexOf("c:") === 0) { var c = d.slice(2).split(","); s.append(svgNode("circle", { cx: c[0], cy: c[1], r: c[2] })); }
		else if (d.indexOf("r:") === 0) { var r = d.slice(2).split(","); s.append(svgNode("rect", { x: r[0], y: r[1], width: r[2], height: r[3], rx: r[4] || 0 })); }
		else s.append(svgNode("path", { d: d }));
	});
	return s;
}

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
	addKids(el, Array.prototype.slice.call(arguments, 2));
	return el;
}
function div(cls, ...kids) { return h("div", cls == null ? null : { class: cls }, kids); }
function span(cls, ...kids) { return h("span", cls == null ? null : { class: cls }, kids); }
function ib(ic, title, fn, size, cls) { return h("button", { class: "o-ib" + (cls ? " " + cls : ""), title, "aria-label": title, onclick: fn }, icon(ic, size || 16)); }
function muted(...kids) { return h("span", { style: "color:var(--tx2)" }, kids); }
function addKids(el, kids) {
	kids.forEach(k => {
		if (k == null || k === false) return;
		if (Array.isArray(k)) return addKids(el, k);
		el.append(k.nodeType ? k : document.createTextNode(String(k)));
	});
}

/* ------------------------------------------------------------------ text helpers */
var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function fmtDate(iso) { if (!iso) return ""; var d = new Date(iso); return MON[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()); }
function fmtDur(sec) { if (sec == null) return ""; sec = Math.round(sec); if (sec < 60) return sec + "s"; var m = Math.floor(sec / 60), s = sec % 60; if (m < 60) return m + "m" + (s ? " " + s + "s" : ""); return Math.floor(m / 60) + "h " + (m % 60) + "m"; }
function trunc(s, n) { return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; }
function plain(s) { return String(s || "").replace(/```[\s\S]*?```/g, " ").replace(/[`*#]/g, "").replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1"); }
function words(s) { var m = plain(s).match(/\S+/g); return m ? m.length : 0; }
function num(n) { return n.toLocaleString("en-US"); }

/* Inline Markdown: code spans, bold, wikilinks, links. Returns nodes. */
function inl(s, ctx) {
	var out = [], re = /`([^`]+)`|\*\*([^*]+)\*\*|\[\[([^\]]+)\]\]|\[([^\]]+)\]\((https?:[^)\s]+)\)/g, last = 0, m;
	while ((m = re.exec(s))) {
		if (m.index > last) out.push(document.createTextNode(s.slice(last, m.index)));
		if (m[1] != null) out.push(h("code", { class: "o-code" }, m[1]));
		else if (m[2] != null) out.push(h("strong", null, m[2]));
		else if (m[3] != null) {
			var parts = m[3].split("|");
			out.push(ctx && ctx.wiki ? ctx.wiki(parts[0], parts[1]) : span("o-wl", parts[1] || parts[0]));
		} else out.push(h("a", { class: "o-ext", href: "#", title: m[5], onclick: e => { e.preventDefault(); } }, m[4]));
		last = re.lastIndex;
	}
	if (last < s.length) out.push(document.createTextNode(s.slice(last)));
	return out;
}

/* ------------------------------------------------------------------ CSS */
var CSS = `
&{--bg:#ffffff;--bg2:#f6f6f6;--bg3:#ededed;--bgh:rgba(0,0,0,.05);--bga:rgba(0,0,0,.075);--bd:#e3e3e3;--bd2:#ececec;--guide:#e3e3e3;
--tx:#222222;--tx2:#5c5c5c;--tx3:#8a8a8a;--tx4:#b0b0b0;--acc:#7b56e8;--acc2:#6a45d8;--accbg:rgba(123,86,232,.1);--link:#6b47dc;
--code:#f3f2f5;--codetx:#3f3a4a;--modal:#ffffff;--shadow:0 6px 24px rgba(0,0,0,.12),0 1px 3px rgba(0,0,0,.08);
--c-q:236,117,0;--c-blue:8,109,221;--c-cyan:0,160,170;--c-green:8,155,70;--c-red:226,48,68;--c-purple:123,86,232;--c-gray:120,120,120;--c-orange:220,120,10;
--hl-amber:rgba(255,200,40,.42);--hl-green:rgba(60,200,110,.28);--hl-blue:rgba(70,150,255,.24);--hl-pink:rgba(255,90,170,.22);--brq:rgba(8,109,221,.09);
--g-comp:#8a63f0;--g-ml:#1ea896;--g-read:#de9418;--g-tag:#a8a8a8;--g-src:#5a9be6;--g-edge:#d2d2d2;--g-lbl:#555;--canvasdot:#d9d9d9;
font-family:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;line-height:1.4;color:var(--tx);background:var(--bg2);
-webkit-font-smoothing:antialiased;}
&[data-theme="dark"]{--bg:#1e1e1e;--bg2:#262626;--bg3:#2e2e2e;--bgh:rgba(255,255,255,.055);--bga:rgba(255,255,255,.085);--bd:#363636;--bd2:#2f2f2f;--guide:#3a3a3a;
--tx:#dadada;--tx2:#a8a8a8;--tx3:#7c7c7c;--tx4:#595959;--acc:#8f74f2;--acc2:#a28bf5;--accbg:rgba(143,116,242,.14);--link:#a790f7;
--code:#2a2a2a;--codetx:#d8cfe9;--modal:#262626;--shadow:0 10px 32px rgba(0,0,0,.5),0 1px 3px rgba(0,0,0,.4);
--c-q:236,140,40;--c-blue:70,150,240;--c-cyan:40,190,190;--c-green:60,190,110;--c-red:240,90,100;--c-purple:150,125,245;--c-gray:150,150,150;--c-orange:236,150,50;
--hl-amber:rgba(250,190,40,.3);--hl-green:rgba(70,200,120,.24);--hl-blue:rgba(80,150,255,.26);--hl-pink:rgba(255,100,180,.24);--brq:rgba(70,150,240,.13);
--g-comp:#9b7cf5;--g-ml:#35c2ad;--g-read:#e6a53a;--g-tag:#6f6f6f;--g-src:#5b8fd1;--g-edge:#3d3d3d;--g-lbl:#b5b5b5;--canvasdot:#353535;color-scheme:dark;}
& .o-app{%abs;inset:0;display:flex;overflow:hidden}
& button{font:inherit;color:inherit;background:none;border:0;padding:0;%ptr}
& .o-ic{flex:none;display:block}
& .o-tl{%abs;left:14px;top:14px;display:flex;gap:8px;z-index:5}
& .o-tl i{width:12px;height:12px;border-radius:50%;background:#ff5f57;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.15)}
& .o-tl i:nth-child(2){background:#febc2e}& .o-tl i:nth-child(3){background:#28c840}
& .o-ib{width:28px;height:28px;border-radius:5px;%ifc;justify-content:center;%c3;flex:none}
& .o-ib:hover{%hov;color:var(--tx)}
& .o-ib.on{color:var(--tx);background:var(--bga)}
& .o-ib.sm{width:24px;height:24px}
/* ribbon */
& .o-ribbon{width:44px;flex:none;background:var(--bg2);border-right:1px solid var(--bd);%col;align-items:center;padding:44px 0 10px;gap:4px}
& .o-ribbon .o-rb{width:32px;height:32px;border-radius:6px;%fc;justify-content:center;%c3;gap:9px}
& .o-ribbon .o-rb:hover{%hov;color:var(--tx)}
& .o-ribbon .o-rb.on{color:var(--acc)}
& .o-ribbon .o-rb span{display:none}
& .o-ribbon .o-sp{flex:1}
& .o-beginner .o-ribbon{width:160px;align-items:stretch;padding:48px 8px 10px}
& .o-beginner .o-ribbon .o-rb{width:auto;justify-content:flex-start;padding:0 9px;height:31px;font-size:12.5px;%c2;white-space:nowrap;text-align:left}
& .o-beginner .o-ribbon .o-rb span{display:inline}
& .o-rbsec{font-size:10.5px;color:var(--tx4);text-transform:uppercase;letter-spacing:.06em;padding:10px 10px 4px;display:none}
& .o-beginner .o-rbsec{display:block}
/* left sidebar */
& .o-ls{width:252px;flex:none;background:var(--bg2);border-right:1px solid var(--bd);%col;min-height:0}
& .o-beginner .o-ls{width:220px}
& .o-sbhead{height:40px;flex:none;%fc;gap:2px;padding:0 8px;border-bottom:1px solid var(--bd2)}
& .o-ls .o-sbhead{padding-left:32px}
& .o-beginner .o-ls .o-sbhead{padding-left:8px}
& .o-sbhead .o-gap{flex:1}
& .o-navbar{display:flex;justify-content:center;gap:2px;padding:6px 8px 4px;flex:none}
& .o-sbscroll{flex:1;overflow:auto;padding:2px 8px 16px;min-height:0}
& .o-ti{position:relative;%fc;gap:6px;height:27px;border-radius:5px;padding-right:6px;%c2;%ptr;white-space:nowrap;font-size:13px}
& .o-ti:hover{%hov;color:var(--tx)}
& .o-ti.act{background:var(--bga);color:var(--tx)}
& .o-ti .o-tt{overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
& .o-ti .o-chev{%abs;color:var(--tx4);width:14px;height:14px}
& .o-ti.fold .o-chev{transform:rotate(-90deg)}
& .o-ti.o-fd{%c2;font-weight:500}
& .o-kids{position:relative}
& .o-kids::before{content:"";%abs;left:var(--gx);top:0;bottom:2px;border-left:1px solid var(--guide)}
& .o-badge{font-size:9.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:1px 5px;border-radius:4px;background:var(--bga);%c3;flex:none}
& .o-badge.run{background:rgba(var(--c-blue),.14);color:rgb(var(--c-blue))}
& .o-badge.fail{background:rgba(var(--c-red),.14);color:rgb(var(--c-red))}
& .o-badge.rev{background:rgba(var(--c-orange),.16);color:rgb(var(--c-orange))}
& .o-badge.q{background:var(--bga);%c3}
& .o-udot{width:6px;height:6px;border-radius:50%;background:var(--acc);flex:none}
& .r2-spin{animation:r2-spin 1s linear infinite}
@keyframes r2-spin{to{transform:rotate(360deg)}}
& .o-vault{flex:none;%fc;gap:4px;padding:8px 8px 10px;border-top:1px solid var(--bd2)}
& .o-vbtn{%fc;gap:6px;padding:5px 8px;border-radius:5px;font-weight:600;font-size:13px;color:var(--tx);flex:1;min-width:0}
& .o-vbtn:hover{%hov}
& .o-vbtn span{white-space:nowrap}
& .o-vbtn small{font-weight:400;%c3;font-size:11.5px;%ell}
& .o-paneh{font-size:11.5px;%c3;padding:10px 6px 4px;%fc;gap:6px;font-weight:500}
& .o-paneh b{font-weight:600;%c2}
& .o-paneh .o-gap{flex:1}
& .o-cnt{font-size:11px;%c3;background:var(--bga);border-radius:8px;padding:0 6px;line-height:16px;font-weight:500}
& .o-input{width:100%;height:30px;border-radius:6px;%bd;background:var(--bg);color:var(--tx);padding:0 8px 0 28px;font:inherit;outline:none}
& .o-input:focus{border-color:var(--acc);box-shadow:0 0 0 2px var(--accbg)}
& .o-inwrap{position:relative;margin:4px 0 6px}
& .o-inwrap .o-ic{%abs;left:8px;top:8px;%c3}
& .o-res{border-radius:5px;padding:5px 6px;%ptr;margin-bottom:2px}
& .o-res:hover{%hov}
& .o-res .o-rt{font-size:12.5px;color:var(--tx);font-weight:500;display:flex;gap:6px;align-items:center}
& .o-res .o-rt span{%ell;flex:1}
& .o-res .o-rs{font-size:12px;%c2;margin-top:2px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
& .o-res mark{background:var(--hl-amber);color:inherit;border-radius:2px}
& .o-hint{font-size:12px;%c3;padding:4px 6px;line-height:1.5}
& .o-hint code{%mono;font-size:11px;%c2}
& .o-opt{display:flex;gap:8px;padding:4px 6px;font-size:12px;%c2;border-radius:4px;%ptr}
& .o-opt:hover{%hov}
& .o-opt code{%mono;font-size:11.5px;color:var(--acc2)}
/* main */
& .o-main{flex:1;min-width:0;display:flex;background:var(--bg)}
& .o-group{flex:1;min-width:0;%col;border-left:1px solid var(--bd)}
& .o-group:first-child{border-left:0}
& .o-tabbar{height:40px;flex:none;display:flex;align-items:flex-end;gap:1px;padding:0 6px 0 8px;background:var(--bg2);border-bottom:1px solid var(--bd);position:relative}
& .o-tab{position:relative;height:32px;%fc;gap:6px;padding:0 6px 0 11px;border-radius:7px 7px 0 0;%c3;font-size:12.5px;min-width:0;max-width:200px;flex:0 1 200px;%ptr}
& .o-tab:hover{%hov;%c2}
& .o-tab.act{background:var(--bg);color:var(--tx);box-shadow:0 0 0 1px var(--bd);clip-path:inset(-1px -1px 0 -1px)}
& .o-group.focus .o-tab.act{color:var(--tx)}
& .o-tab .o-tt{%ell;flex:1;min-width:0}
& .o-tab .o-ib{width:20px;height:20px;opacity:0}
& .o-tab:hover .o-ib,& .o-tab.act .o-ib{opacity:1}
& .o-tab .o-tabic{%c3}
& .o-tabbar .o-gap{flex:1}
& .o-tabbar .o-ib{margin-bottom:4px}
& .o-vh{height:38px;flex:none;%fc;gap:2px;padding:0 8px;background:var(--bg)}
& .o-vh .o-crumb{flex:1;min-width:0;text-align:center;font-size:12.5px;%c3;%ell;padding:0 8px}
& .o-vh .o-crumb b{color:var(--tx);font-weight:500}
& .o-vh .o-mode{font-size:11.5px;%c3;margin-right:2px}
& .o-body{flex:1;min-height:0;position:relative;%col}
& .o-scroll{flex:1;overflow:auto;min-height:0}
& .o-doc:has(+ .o-dock){padding-bottom:12px}
& .o-doc{max-width:720px;margin:0 auto;padding:18px 44px 90px;font-size:15px;line-height:1.62;color:var(--tx)}
& .o-narrow .o-doc{padding:14px 26px 90px}
& .o-ititle{font-size:27px;line-height:1.22;font-weight:700;letter-spacing:-.015em;margin:6px 0 14px;color:var(--tx)}
& .o-narrow .o-ititle{font-size:23px}
& .o-narrow .o-prow{grid-template-columns:118px 1fr}
& .o-doc p{margin:0 0 12px}
& .o-code{%mono;font-size:.84em;background:var(--code);color:var(--codetx);padding:1.5px 4px;border-radius:4px}
& .o-pre{%mono;font-size:12.5px;line-height:1.55;background:var(--code);color:var(--codetx);padding:12px 14px;border-radius:6px;margin:0 0 12px;white-space:pre;overflow-x:auto}
& .o-wl{color:var(--link);%ptr;text-decoration:none}
& .o-wl:hover{text-decoration:underline}
& .o-ext{color:var(--link);text-decoration:underline;text-decoration-color:rgba(127,100,230,.35)}
& .o-h3{font-size:16px;font-weight:650;margin:8px 0 6px}
& .o-doc ul{margin:0 0 12px;padding-left:22px}
/* properties */
& .o-props{margin:0 0 20px;font-size:13.5px;line-height:1.3}
& .o-propsh{%fc;gap:4px;%c2;font-weight:600;font-size:13.5px;margin-bottom:4px;%ptr;width:max-content}
& .o-propsh .o-ic{%c3}
& .o-propsh.fold .o-ic{transform:rotate(-90deg)}
& .o-prow{display:grid;grid-template-columns:150px 1fr;align-items:center;min-height:30px;border-radius:5px}
& .o-prow:hover{%hov}
& .o-pk{%fc;gap:7px;%c2;padding:0 6px;font-size:13px}
& .o-pk .o-ic{%c3}
& .o-pv{display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:3px 6px;min-width:0;color:var(--tx)}
& .o-pill{%ifc;gap:4px;height:22px;padding:0 8px;border-radius:11px;background:var(--bga);font-size:12.5px;color:var(--tx);max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
& .o-pill.link{color:var(--link);background:var(--accbg);%ptr}
& .o-pill.chip{%ptr}
& .o-pill.chip:hover{background:var(--bg3)}
& .o-pill .o-ic{%c3}
& .o-tag{%ifc;height:22px;padding:0 9px;border-radius:11px;background:var(--accbg);color:var(--acc2);font-size:12.5px;%ptr}
& .o-tag:hover{filter:brightness(1.08)}
& .o-status{%ifc;gap:5px;height:22px;padding:0 8px;border-radius:11px;font-size:12px;font-weight:550;background:rgba(var(--c),.13);color:rgb(var(--c))}
& .o-status i{width:6px;height:6px;border-radius:50%;background:currentColor}
/* callouts */
& .o-co{--c:var(--c-blue);background:rgba(var(--c),.075);border-radius:6px;padding:10px 14px 10px 14px;margin:10px 0 12px;border-left:0}
& .o-coh{%fc;gap:7px;color:rgb(var(--c));font-weight:600;font-size:14px;line-height:1.35}
& .o-coh .o-ic{flex:none}
& .o-coh .o-gap{flex:1}
& .o-coh .o-meta{font-weight:400;font-size:12px;%c3;white-space:nowrap}
& .o-coh.click{%ptr}
& .o-coh .o-fold{color:rgb(var(--c));opacity:.8}
& .o-coh.fold .o-fold{transform:rotate(-90deg)}
& .o-cob{margin-top:5px;font-size:14.5px;line-height:1.58;color:var(--tx)}
& .o-cob p:last-child{margin-bottom:0}
& .o-co.q{--c:var(--c-q)}& .o-co.abs{--c:var(--c-cyan)}& .o-co.trace{--c:var(--c-gray)}& .o-co.fail{--c:var(--c-red)}
& .o-co.warn{--c:var(--c-orange)}& .o-co.ask{--c:var(--c-purple)}& .o-co.quote{--c:var(--c-gray)}& .o-co.ok{--c:var(--c-green)}& .o-co.info{--c:var(--c-blue)}
& .o-co.trace{padding:7px 12px}
& .o-co.trace .o-coh{font-size:13px;font-weight:550}
& .o-steps{margin:6px 0 2px;%col;gap:1px}
& .o-step{display:grid;grid-template-columns:18px 1fr auto;gap:6px;align-items:baseline;font-size:12.5px;line-height:1.5;%c2;padding:1px 0}
& .o-step .o-ic{%c3;transform:translateY(2px)}
& .o-step small{%c3;%mono;font-size:11px}
& .o-step em{font-style:normal;%c3;margin-left:6px}
& .o-step.err{color:rgb(var(--c-red))}
& .o-step.err .o-ic{color:rgb(var(--c-red))}
& .o-step.running{color:var(--tx)}
/* turns */
& .o-turn{position:relative}
& .o-h2{position:relative;font-size:20px;line-height:1.3;font-weight:680;letter-spacing:-.01em;margin:30px 0 8px;%fc;gap:8px}
& .o-h2 .o-hf{%abs;left:-24px;top:4px;width:18px;height:18px;%c3;opacity:0;border-radius:4px;%fc;justify-content:center}
& .o-h2:hover .o-hf,& .o-h2.fold .o-hf{opacity:1}
& .o-h2.fold .o-hf .o-ic{transform:rotate(-90deg)}
& .o-h2 .o-hact{margin-left:auto;display:flex;gap:2px;opacity:0}
& .o-h2:hover .o-hact{opacity:1}
& .o-h2 .o-hact .on{opacity:1;color:var(--acc)}
& .o-h2 .o-starred{color:var(--acc);opacity:1}
& .o-h2.fold::after{content:"\\2026";font-weight:400;%c3;font-size:15px;margin-left:2px}
& .o-first .o-h2{margin-top:6px}
& .o-para{position:relative}
& .o-bid{%mono;font-size:11px;color:var(--tx4);margin-left:6px;white-space:nowrap}
& .o-reading .o-bid{display:none}
& .o-mk{border-radius:3px;padding:1px 0;color:inherit;cursor:help}
& .o-mk.amber{background:var(--hl-amber)}& .o-mk.green{background:var(--hl-green)}& .o-mk.blue{background:var(--hl-blue)}& .o-mk.pink{background:var(--hl-pink)}
& .o-mk .o-noteic{display:inline-block;vertical-align:-1px;margin-left:3px;%c3}
& .o-mk .o-code,& .o-brq .o-code{background:transparent;padding:0}
& .o-brq{background:var(--brq);box-shadow:inset 0 -1.5px 0 rgba(var(--c-blue),.55);border-radius:2px}
& .o-brl{%fc;gap:6px;margin:-6px 0 12px;font-size:13px;%c3;padding-left:2px}
& .o-brl .o-ic{color:rgb(var(--c-blue))}
& .o-srcs{margin:4px 0 8px;padding-top:8px;border-top:1px solid var(--bd2);font-size:12.5px;%c2}
& .o-srcs ol{margin:0;padding-left:20px}
& .o-srcs li{margin:2px 0}
& .o-srcs li span{%c3;margin-left:6px}
& .o-runl{%fc;gap:8px;font-size:13px;color:rgb(var(--c-blue));margin:4px 0 10px}
& .o-runl .o-gap{flex:1}
& .o-caret{display:inline-block;width:7px;height:15px;background:var(--acc);vertical-align:-2px;margin-left:2px;animation:r2-blink 1s steps(2) infinite}
@keyframes r2-blink{50%{opacity:0}}
& .o-btn{%ifc;gap:6px;height:26px;padding:0 10px;border-radius:5px;background:var(--bg);%bd;color:var(--tx);font-size:12.5px;font-weight:500;box-shadow:0 1px 1px rgba(0,0,0,.03)}
& .o-btn:hover{background:var(--bg3)}
& .o-btn.pri{background:var(--acc);border-color:var(--acc);color:#fff}
& .o-btn.pri:hover{background:var(--acc2)}
& .o-btn.ghost{background:transparent;border-color:transparent;%c2}
& .o-btn.ghost:hover{%hov}
& .o-row{%fc;gap:6px;flex-wrap:wrap}
& .o-linkcard{display:flex;gap:12px;%bd;border-radius:8px;padding:12px 14px;margin:0 0 14px;background:var(--bg)}
& .o-linkcard .o-lci{width:38px;height:38px;border-radius:8px;background:var(--accbg);color:var(--acc);%fc;justify-content:center;flex:none}
& .o-linkcard b{display:block;font-size:14.5px;line-height:1.35}
& .o-linkcard small{%c3;font-size:12.5px}
/* ask callout */
& .o-dock{position:sticky;bottom:0;max-width:720px;margin:0 auto;padding:18px 44px 34px;background:linear-gradient(transparent,var(--bg) 18px);z-index:2}
& .o-narrow .o-dock{padding:14px 20px 34px}
& .o-narrow .o-dock .o-meta,& .o-narrow .o-dock kbd{display:none}
& .o-coh .o-meta{%ell;min-width:0}
& .o-dock .o-co{margin:0;box-shadow:0 0 0 1px rgba(var(--c-purple),.18),0 4px 14px rgba(0,0,0,.06);background:color-mix(in srgb,var(--bg) 88%,rgb(var(--c-purple)))}
& .o-dock textarea{min-height:24px;transition:min-height .12s}
& .o-dock textarea:focus,& .o-dock .o-cob:has(textarea:not(:placeholder-shown)) textarea{min-height:52px}
& .o-seg{display:inline-flex;gap:2px;padding:2px;border-radius:7px;background:var(--bga)}
& .o-seg button{%fc;gap:5px;white-space:nowrap;height:24px;padding:0 9px;border-radius:5px;font-size:12.5px;font-weight:550;%c2}
& .o-seg button.on{background:var(--bg);color:rgb(var(--c-purple));box-shadow:0 1px 2px rgba(0,0,0,.12)}
& .o-up{%fc;gap:6px;font-size:13px;%c3;margin:4px 0 -6px}
& .o-up .o-ic{color:rgb(var(--c-blue))}
& .o-co.ask textarea,& .o-chat-comp textarea{width:100%;border:0;outline:none;resize:none;background:transparent;color:var(--tx);font:inherit;font-size:14.5px;line-height:1.5;padding:4px 0;min-height:46px}
& .o-co.ask textarea::placeholder,& .o-chat-comp textarea::placeholder,& .o-card.comp textarea::placeholder{%c3}
& .o-askbar{%fc;gap:6px;margin-top:4px}
& .o-askbar .o-gap{flex:1}
& .o-askbar kbd,& .o-kbd{font:11px "Inter",sans-serif;%c3}
& .o-send{width:28px;height:28px;border-radius:50%;background:var(--acc);color:#fff;%fc;justify-content:center}
& .o-send:hover{background:var(--acc2)}
& .o-send.q{width:auto;border-radius:14px;padding:0 10px;font-size:12px;font-weight:600;gap:4px}
& .o-asknote{font-size:12px;%c3;margin-top:7px;line-height:1.45}
& .o-agent{%ifc;gap:4px;height:24px;padding:0 8px;border-radius:12px;font-size:12px;%c2;background:var(--bg);%bd}
& .o-agent:hover{color:var(--tx);background:var(--bg3)}
& .o-agent .o-ic{%c3}
& .o-dotp{width:7px;height:7px;border-radius:50%;flex:none}
/* status bar */
& .o-statusbar{%abs;right:0;bottom:0;%fc;gap:2px;padding:3px 6px;background:var(--bg2);border-top:1px solid var(--bd);border-left:1px solid var(--bd);border-top-left-radius:8px;font-size:11.5px;%c2;z-index:6}
& .o-sbi{%fc;gap:5px;padding:2px 7px;border-radius:4px;white-space:nowrap}
& .o-sbi.click{%ptr}
& .o-sbi.click:hover{%hov;color:var(--tx)}
& .o-sbi.runs{color:rgb(var(--c-blue))}
/* right sidebar */
& .o-rs{width:276px;flex:none;background:var(--bg2);border-left:1px solid var(--bd);%col;min-height:0}
& .o-rstack{flex:1;min-height:0;%col}
& .o-rstack + .o-rstack{border-top:1px solid var(--bd)}
& .o-rstack .o-sbhead{height:36px}
& .o-rs > .o-rstack:first-child .o-sbhead{height:40px}
& .o-rscroll{flex:1;overflow:auto;padding:4px 10px 40px;min-height:0}
& .o-bl{border-radius:6px;padding:6px 8px;margin:2px 0 4px;%ptr;background:var(--bg)}
& .o-bl:hover{box-shadow:0 0 0 1px var(--bd)}
& .o-bl .o-blt{font-size:12.5px;font-weight:600;color:var(--tx);display:flex;gap:6px;align-items:center}
& .o-bl .o-blt span{%ell}
& .o-bl .o-bls{font-size:12px;%c2;margin-top:3px;line-height:1.45}
& .o-bl .o-bls .o-wl{font-weight:500}
& .o-secth{%fc;gap:4px;font-size:12px;font-weight:600;%c2;padding:8px 2px 4px;%ptr}
& .o-secth.fold .o-ic{transform:rotate(-90deg)}
& .o-secth .o-cnt{margin-left:auto}
& .o-ol{%fc;gap:6px;padding:3px 6px;border-radius:4px;font-size:12.5px;%c2;%ptr;line-height:1.35}
& .o-ol:hover{%hov;color:var(--tx)}
& .o-ol .o-tt{%ell;flex:1}
& .o-ol .o-ic{%c3}
& .o-ol.cur{color:var(--tx);font-weight:550}
& .o-tagrow{%fc;justify-content:space-between;padding:3px 6px;border-radius:4px;font-size:12.5px;%c2;%ptr}
& .o-tagrow:hover{%hov}
& .o-tagrow span:first-child{color:var(--acc2)}
& .o-pvt{font-size:17px;font-weight:650;line-height:1.3;margin:6px 2px 6px}
& .o-pvt .o-wl{color:var(--tx)}
& .o-rscroll .o-row{margin:0 0 8px}
& .o-rscroll .o-co{font-size:13px;margin:6px 0 10px;padding:8px 10px}
& .o-rscroll .o-cob{font-size:13px;line-height:1.5}
& .o-pvq{%fc;gap:6px;font-weight:600;font-size:13px;color:rgb(var(--c-q));margin:8px 0 4px}
& .o-pva{font-size:13px;line-height:1.55;%c2;max-height:120px;overflow:hidden;-webkit-mask-image:linear-gradient(#000 75%,transparent)}
& .o-pva p{margin:0 0 8px}
& .o-pvl{margin:6px 0;padding-left:18px;font-size:13px;line-height:1.55;%c2}
& .o-rscroll .o-co.ask textarea{font-size:13px;min-height:40px}
& .o-rscroll .o-askbar{flex-wrap:wrap}
& .o-lg{height:100%;min-height:0;position:relative}
& .o-lg > svg{display:block;width:100%;height:100%}
/* graph */
& .o-graph{%abs;inset:0;overflow:hidden;background:var(--bg);cursor:grab}
& .o-graph > svg{display:block;width:100%;height:100%}
& .o-graph line,& .o-lg line{stroke:var(--g-edge);stroke-width:1}
& .o-gn circle{stroke:var(--bg);stroke-width:1.5;%ptr;transition:opacity .12s}
& .o-gn text{fill:var(--g-lbl);font:10.5px "Inter",sans-serif;text-anchor:middle;pointer-events:none;transition:opacity .12s}
& .o-gn.tag text,& .o-gn.src text{opacity:0;font-size:9.5px}
& .o-lg .o-gn.tag text{opacity:.75}

& .o-gn.sel circle{stroke:var(--tx);stroke-width:2.5}
& svg.zoomed .o-gn.tag text,& svg.zoomed .o-gn.src text{opacity:.75}
& .o-gn.cur circle{stroke:var(--acc);stroke-width:2.5}
& svg.hov .o-gn{opacity:.18}& svg.hov line{opacity:.12}
& svg.hov .o-gn.on{opacity:1}& svg.hov line.on{opacity:1;stroke:var(--acc)}
& svg.hov .o-gn.on text{opacity:1;fill:var(--tx)}
& .o-gpanel{%abs;top:10px;right:10px;width:244px;background:var(--bg2);%bd;border-radius:8px;box-shadow:var(--shadow);font-size:12.5px;%c2;z-index:3;max-height:calc(100% - 20px);overflow:auto}
& .o-gpanel .o-gph{%fc;gap:6px;padding:8px 10px;font-weight:600;color:var(--tx);%ptr;border-top:1px solid var(--bd2)}
& .o-gpanel .o-gph:first-child{border-top:0}
& .o-gpanel .o-gph.fold .o-ic{transform:rotate(-90deg)}
& .o-gpanel .o-gpb{padding:2px 12px 10px}
& .o-tog{%fc;justify-content:space-between;padding:4px 0}
& .o-switch{width:30px;height:17px;border-radius:9px;background:var(--bd);position:relative;flex:none}
& .o-switch::after{content:"";%abs;left:2px;top:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:left .12s;box-shadow:0 1px 2px rgba(0,0,0,.25)}
& .o-switch.on{background:var(--acc)}& .o-switch.on::after{left:15px}
& .o-grp{%fc;gap:8px;padding:3px 0}
& .o-grp i{width:12px;height:12px;border-radius:50%;flex:none}
& .o-grp code{%mono;font-size:11px;%c2}
& .o-range{width:100%;accent-color:var(--acc)}
& .o-gcard{%abs;left:12px;bottom:12px;width:290px;
background:var(--bg2);%bd;border-radius:8px;padding:10px 12px;box-shadow:var(--shadow);font-size:12.5px;%c2;z-index:3}
& .o-gcard b{display:block;color:var(--tx);font-size:13.5px;margin-bottom:3px;line-height:1.3}
& .o-gtools{%abs;left:12px;top:10px;display:flex;gap:6px;z-index:3}
& .o-gtools .o-pill{background:var(--bg2);%bd}
/* canvas */
& .o-canvas{%abs;inset:0;overflow:hidden;background-color:var(--bg);background-image:radial-gradient(var(--canvasdot) 1px,transparent 1.2px);background-size:20px 20px;cursor:grab}
& .o-world{%abs;left:0;top:0;transform-origin:0 0}
& .o-world > svg{%abs;left:0;top:0;overflow:visible;pointer-events:none}
& .o-world path.e{fill:none;stroke:var(--tx3);stroke-width:1.6}
& .o-world path.e.br{stroke:rgb(var(--c-blue))}
& .o-world path.e.ref{stroke-dasharray:5 5;stroke:var(--tx4)}
& .o-elbl{%abs;font-size:11.5px;%c2;background:var(--bg);padding:1px 6px;border-radius:4px;%bd;white-space:nowrap;transform:translate(-50%,-50%);max-width:200px;overflow:hidden;text-overflow:ellipsis}
& .o-card{%abs;background:var(--bg);border:1.5px solid var(--bd);border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.06);%col;overflow:hidden;%ptr}
& .o-card:hover{border-color:var(--tx4)}
& .o-card.sel{border-color:var(--acc);box-shadow:0 0 0 2px var(--accbg)}
& .o-card.st-running{border-color:rgba(var(--c-blue),.7)}
& .o-card.st-failed{border-color:rgba(var(--c-red),.7)}
& .o-card.st-needs-review{border-color:rgba(var(--c-orange),.8)}
& .o-cardh{padding:9px 12px 0;font-weight:650;font-size:13.5px;line-height:1.3;display:flex;gap:8px;align-items:flex-start}
& .o-cardh > span:first-child{flex:1}
& .o-cardq{margin:7px 12px 0;padding:6px 9px;border-radius:6px;background:rgba(var(--c-q),.08);font-size:12px;line-height:1.45;color:var(--tx)}
& .o-cardq span,& .o-cardb{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
& .o-cardb{margin:7px 12px 0;font-size:12.5px;line-height:1.5;%c2;-webkit-line-clamp:4;flex:none}
& .o-cardf{margin-top:auto;padding:7px 12px 9px;font-size:11.5px;%c3;display:flex;gap:8px;align-items:center}
& .o-card.note .o-cardh{color:var(--tx)}
& .o-card.note ul{margin:6px 12px 0;padding-left:16px;font-size:12.5px;%c2;line-height:1.5}
& .o-card.src{flex-direction:row;align-items:center;gap:10px;padding:10px 12px}
& .o-card.src b{font-size:12.5px;display:block;line-height:1.3}
& .o-card.src small{%c3;font-size:11.5px}
& .o-card.comp{border-style:dashed;border-color:var(--acc);cursor:default;padding:10px 12px}
& .o-card.comp textarea{width:100%;flex:1;border:0;outline:none;resize:none;background:transparent;color:var(--tx);font:inherit;font-size:13.5px;line-height:1.45}
& .o-cgroup{%abs;border:1.5px solid var(--bd);border-radius:14px;background:rgba(var(--c-purple),.035)}
& .o-cgroup span{%abs;top:-26px;left:0;font-size:13px;font-weight:600;%c2;background:var(--bga);padding:2px 10px;border-radius:6px}
& .o-cmenu{%abs;display:flex;gap:2px;padding:3px;background:var(--bg2);%bd;border-radius:8px;box-shadow:var(--shadow);transform:translate(-50%,-100%);z-index:4}
& .o-cmenu button{%fc;gap:5px;height:26px;padding:0 8px;border-radius:5px;font-size:12px;%c2}
& .o-cmenu button:hover{%hov;color:var(--tx)}
& .o-cctl{%abs;right:12px;top:12px;%col;background:var(--bg2);%bd;border-radius:8px;padding:3px;gap:2px;z-index:3;box-shadow:var(--shadow)}
& .o-cadd{%abs;left:50%;bottom:44px;transform:translateX(-50%);display:flex;gap:2px;background:var(--bg2);%bd;border-radius:10px;padding:4px;box-shadow:var(--shadow);z-index:3}
& .o-cadd button{%col;align-items:center;gap:2px;font-size:11px;%c2;padding:5px 10px;border-radius:6px;min-width:62px}
& .o-cadd button:hover{%hov;color:var(--tx)}
/* chat view */
& .o-chat{%col;height:100%;min-height:0}
& .o-chat-scroll{flex:1;overflow:auto;padding:14px 22px 20px;min-height:0}

& .o-msgu{margin:16px 0 8px auto;max-width:86%;background:var(--bg2);border:1px solid var(--bd2);border-radius:12px 12px 4px 12px;padding:9px 12px;font-size:14px;line-height:1.5;width:fit-content}
& .o-msgu .o-msgm{font-size:11.5px;%c3;margin-top:4px}
& .o-msga{font-size:14.5px;line-height:1.6;margin-bottom:6px}
& .o-msga p{margin:0 0 10px}
& .o-msgah{%fc;gap:7px;font-size:12px;%c3;margin-bottom:5px}
& .o-msgah b{%c2;font-weight:600}
& .o-macts{display:flex;flex-wrap:wrap;gap:2px;margin:2px 0 10px -6px}
& .o-macts button{%fc;gap:5px;height:24px;padding:0 7px;border-radius:5px;font-size:12px;%c3;white-space:nowrap}
& .o-macts button:hover{%hov;color:var(--tx)}
& .o-chat-comp{flex:none;margin:0 14px 30px;%bd;border-radius:10px;padding:8px 10px 8px 12px;background:var(--bg);box-shadow:0 1px 4px rgba(0,0,0,.05)}
& .o-chat-comp:focus-within{border-color:var(--acc)}
& .o-embed{border-left:2px solid var(--acc);padding:4px 0 4px 14px;margin:6px 0 12px;font-size:14px;line-height:1.55}
& .o-embed .o-emh{%fc;gap:6px;font-size:12px;%c3;margin-bottom:2px}
& .o-embed.new{animation:r2-flash 1.6s ease-out}
@keyframes r2-flash{0%{background:var(--accbg)}100%{background:transparent}}
/* bullets */
& .o-ul{list-style:none;margin:0;padding:0}
& .o-li{position:relative;padding-left:22px;margin:3px 0}
& .o-li::before{content:"";%abs;left:8px;top:11px;width:5px;height:5px;border-radius:50%;background:var(--tx3)}
& .o-li.has.fold::before{box-shadow:0 0 0 3px var(--bga)}
& .o-li > .o-lf{%abs;left:-14px;top:4px;width:16px;height:16px;%c3;opacity:0;%fc;justify-content:center}
& .o-li:hover > .o-lf,& .o-li.fold > .o-lf{opacity:1}
& .o-li.fold > .o-lf .o-ic{transform:rotate(-90deg)}
& .o-li > .o-ul{border-left:1px solid var(--guide);margin-left:10px;padding-left:2px}
& .o-li .o-lref{font-size:12.5px;margin-left:8px;color:var(--link);%ptr;text-decoration:none;opacity:.9}
& .o-li .o-lref .o-ic{display:inline-block;vertical-align:-1px;margin-right:3px}

& .o-li .o-lref:hover{text-decoration:underline}
/* source mode */
& .o-src{%mono;font-size:12.5px;line-height:1.7;white-space:pre-wrap;color:var(--tx);padding:18px 40px 120px;max-width:780px;margin:0 auto;word-break:break-word}
& .o-src .y{%c3}& .o-src .k{color:rgb(var(--c-q))}& .o-src .hd{color:var(--tx);font-weight:700}& .o-src .co{color:rgb(var(--c-purple))}& .o-src .bi{color:var(--tx4)}
/* empty + welcome */
& .o-empty{%col;align-items:center;justify-content:center;height:100%;gap:6px;%c2}
& .o-empty h3{font-size:19px;color:var(--tx);margin:0 0 10px;font-weight:650}
& .o-empty button{color:var(--link);font-size:14px;padding:3px 6px}
& .o-empty button:hover{text-decoration:underline}
& .o-agentrow{display:grid;grid-template-columns:28px 1fr auto;gap:10px;align-items:center;padding:9px 12px;%bd;border-radius:8px;margin-bottom:6px;background:var(--bg)}
& .o-agentrow b{font-size:14px;display:block;line-height:1.3}
& .o-agentrow small{font-size:12.5px;%c3;line-height:1.4;display:block}
& .o-agentrow .o-av{width:28px;height:28px;border-radius:7px;%fc;justify-content:center;font-weight:700;font-size:12px;color:#fff}
& .o-cmd{%ifc;gap:6px;%mono;font-size:12px;background:var(--code);color:var(--codetx);padding:3px 4px 3px 8px;border-radius:5px}
& .o-cmd button{%c3;display:flex}
& .o-cmd button:hover{color:var(--tx)}
& .o-ex{%col;gap:6px;margin:8px 0 2px}
& .o-ex button{text-align:left;font-size:13.5px;%c2;padding:7px 11px;%bd;border-radius:7px;background:var(--bg);line-height:1.4}
& .o-ex button:hover{border-color:var(--acc);color:var(--tx)}
& .o-steps3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:6px 0 14px}
& .o-steps3 div{%bd;border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.45;%c2;background:var(--bg)}
& .o-steps3 b{%fc;gap:6px;color:var(--tx);font-size:13.5px;margin-bottom:4px}
& .o-steps3 .o-ic{color:var(--acc)}
/* overlays */
& .o-scrim{%abs;inset:0;background:rgba(0,0,0,.28);z-index:20}
& .o-pal{%abs;left:50%;top:84px;width:620px;transform:translateX(-50%);background:var(--modal);%bd;border-radius:10px;box-shadow:var(--shadow);z-index:21;overflow:hidden}
& .o-pal input{width:100%;height:46px;border:0;border-bottom:1px solid var(--bd);background:transparent;color:var(--tx);font:inherit;font-size:15px;padding:0 16px;outline:none}
& .o-pal .o-pl{max-height:340px;overflow:auto;padding:6px}
& .o-pi{%fc;gap:10px;padding:7px 10px;border-radius:6px;font-size:13.5px;color:var(--tx);%ptr}
& .o-pi.sel{background:var(--bga)}
& .o-pi small{%c3;font-size:12px;margin-left:auto;white-space:nowrap}
& .o-pi .o-pp{%c3}
& .o-pi .o-tt{%ell;min-width:0}
& .o-pi kbd{font:11px "Inter",sans-serif;%c2;background:var(--bga);border-radius:4px;padding:1px 6px;margin-left:auto}
& .o-pal .o-pf{display:flex;gap:16px;padding:8px 14px;border-top:1px solid var(--bd);font-size:11.5px;%c3}
& .o-pal .o-pf b{%c2;font-weight:600}
& .o-menu{%abs;min-width:200px;%float;padding:4px;z-index:25;font-size:13px}
& .o-mi{%fc;gap:8px;padding:5px 9px;border-radius:5px;color:var(--tx);%ptr;white-space:nowrap}
& .o-mi:hover{background:var(--bga)}
& .o-mi .o-ic{%c3}
& .o-mi small{margin-left:auto;%c3;font-size:11.5px;padding-left:14px}
& .o-mi.dis{color:var(--tx4);cursor:default}& .o-mi.dis:hover{background:none}
& .o-sw{width:12px;height:12px;border-radius:3px;flex:none;margin-left:-2px}
& .o-msep{height:1px;background:var(--bd);margin:4px 2px}
& .o-mlab{font-size:11px;%c3;padding:5px 9px 3px;text-transform:uppercase;letter-spacing:.05em}
& .o-selbar{%abs;display:flex;gap:1px;padding:3px;%float;z-index:24;transform:translate(-50%,-100%)}
& .o-selbar button{%fc;gap:5px;height:27px;padding:0 9px;border-radius:5px;font-size:12.5px;color:var(--tx)}
& .o-selbar button:hover{background:var(--bga)}
& .o-selbar button .o-ic{%c3}
& .o-selbar .o-dis{%c3;font-size:12px;padding:0 8px;%fc}
& .o-pop{%abs;width:380px;max-height:300px;overflow:hidden;%float;z-index:23;padding:12px 16px;font-size:13px;line-height:1.5;pointer-events:none}
& .o-pop b{display:block;font-size:16px;margin-bottom:6px;line-height:1.3}
& .o-pop .o-props{margin-bottom:8px;font-size:12px}
& .o-runspop{%abs;right:8px;bottom:30px;width:400px;max-height:500px;overflow:auto;background:var(--modal);%bd;border-radius:10px;box-shadow:var(--shadow);z-index:22;padding:6px 6px 8px}
& .o-rpf{%fc;gap:8px;padding:2px 6px;font-size:13.5px}
& .o-runspop h4{margin:0;padding:8px 10px 4px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;%c3;font-weight:600}
& .o-notices{%abs;right:14px;top:50px;%col;gap:6px;z-index:30}
& .o-notice{background:var(--modal);%bd;box-shadow:var(--shadow);border-radius:7px;padding:9px 14px;font-size:13px;max-width:340px}
& .o-runitem{display:grid;grid-template-columns:18px 1fr;gap:6px;padding:6px 6px;border-radius:5px;%ptr}
& .o-runitem:hover{%hov}
& .o-runitem b{display:block;font-size:12.5px;font-weight:550;color:var(--tx);line-height:1.35;%ell}
& .o-runitem small{display:block;font-size:11.5px;%c2;line-height:1.4;margin-top:1px;%ell}
& .o-runitem small.o-rth{%c3}
& .o-runitem .o-ic{margin-top:2px}
& .o-runitem.fail .o-ic{color:rgb(var(--c-red))}& .o-runitem.rev .o-ic{color:rgb(var(--c-orange))}& .o-runitem.run .o-ic{color:rgb(var(--c-blue))}& .o-runitem.unread .o-ic{color:var(--acc)}& .o-runitem.q .o-ic{%c3}
`;

/* CSS shorthands: "&" is the scope class; %name expands to a repeated declaration group. */
var CSS_MACROS = { "%float": "background:var(--modal);border:1px solid var(--bd);border-radius:8px;box-shadow:var(--shadow)", "%ell": "overflow:hidden;text-overflow:ellipsis;white-space:nowrap", "%mono": 'font-family:"JetBrains Mono",ui-monospace,monospace', "%ifc": "display:inline-flex;align-items:center", "%fc": "display:flex;align-items:center", "%abs": "position:absolute",
	"%col": "display:flex;flex-direction:column", "%bd": "border:1px solid var(--bd)", "%c3": "color:var(--tx3)", "%c2": "color:var(--tx2)", "%ptr": "cursor:pointer", "%hov": "background:var(--bgh)" };
function expandCss(css) { return css.replace(/%(float|ell|mono|ifc|fc|abs|col|bd|c3|c2|ptr|hov)\b/g, m => CSS_MACROS[m]).replace(/&/g, P); }

/* ------------------------------------------------------------------ registration */
window.SessionMocks.register({
	id: "obsidian",
	round: 2,
	name: "Vault & Graph",
	reference: "Obsidian",
	summary: "Session as a vault of plain Markdown notes. Each thread is a note whose body is the conversation, with an ask bar docked at the bottom. Branches are linked notes and highlights are block references. Backlinks, outline, graph and canvas are views over the same files.",
	principles: [
		"One vault (~/research) holds everything. Workspaces are its top-level folders and folders nest inside them, so the only container is a folder, plus the vault on disk. This replaces the separate Workspace and Folder vocabulary.",
		"A thread is a note: properties (status, provider, model, effort, tags, links, sources), then each question as an H2 with a question callout, the answer as Markdown and the run trace as a folded callout.",
		"The ask bar is docked to the bottom of every thread note and has a Follow-up / Branch switch. A follow-up appends to the note; a branch becomes a linked note, from the last answer or from a selected passage.",
		"Bookmarks cover notes, headings (formerly Star) and blocks. A block is a highlight with a colour and an editable note. Follow and Post-to-network are dropped because nothing delivers them.",
		"Every note has one menu, shared by the explorer's right-click, the view header's ⋯ button and canvas cards.",
		"Run state is never only a dot: file-explorer badges (RUN, FAIL, REVIEW, QUEUED), a Runs pane, and a status-bar item that streams the current step and opens the trace.",
		"Search, the command palette (⌘P), the quick switcher (⌘O) and Source mode (the Markdown file on disk) work as in Obsidian; search supports tag:, path:, status:, model: and provider:."
	],
	chat: "Each thread note ends in a docked ask bar that shows the provider, model and effort inherited from the last answer. Enter appends an H2 question; the trace and answer stream in, and the status bar shows the current tool step. A send during a run is queued as its own heading, with Stop and Retry beside the run. Switch to Branch to start a linked note instead. B moves the conversation into a Chat view bound to the note; C asks from the graph's preview pane.",
	knowledge: "Answers become knowledge through links. Select a passage to Branch, Highlight (colour plus a note) or Extract (a new atomic note that embeds the block). Notes like 'JIT correctness checklist' are foldable outlines whose bullets link to threads and headings. Backlinks, unlinked mentions, outline, local graph, a force-directed global graph (click to preview, again to open) and a canvas of the research tree all read the same links.",
	firstRun: "A new vault opens on a Welcome note with a labelled ribbon. It covers connecting an agent (status updates after sign-in), asking a first question or picking an example, and a three-step model of follow-up, branch and extract. The sample vault has the same note as 'Start here', opened from the ribbon's help button.",
	changes: [
		"The ask callout is now docked at the bottom of each thread note with a Follow-up / Branch switch. In r1 it sat after the last answer, and branching was only possible by selecting text.",
		"The sample vault has a 'Start here' note (agents, ask, how notes connect, example links) behind the ribbon's help button. In r1, variants A–D gave no orientation.",
		"Variant C's graph is now a working surface: clicking a node previews it in the right sidebar (recap, latest answer, ask box) and a second click opens it. In r1 the graph view had no chat.",
		"The explorer's right-click and the ⋯ button now open the same note menu, closing UX-07. Highlights can be recoloured, annotated and removed (UX-11). Search implements tag:, path:, status:, model: and provider: (UX-10).",
		"Polish: the outline drops 'H2' prefixes, backlinks no longer repeat the note title, Runs items are two lines, outline links in notes flow inline, the canvas groups sources under the main conversation, the graph's dead Display section is gone and tag labels appear only when zoomed.",
		"First run: shorter ribbon labels without clipped shortcuts, and no made-up Grok install command (it links to the install guide). Chat (B) drops the duplicate 'Saved in' bar.",
		"Size: CSS shorthands, shared helpers (askBox, ib, noteMenu, foldSec, runItems, toMarkdown) and tab indentation cover the added features; the file is 182 KB (r1: 184 KB), still above the 170 KB target."
	],
	variants: [
		{ id: "a", name: "Note is the thread", note: "Dense default: the conversation is the note body with the ask bar docked at the bottom; the right sidebar stacks Backlinks over Outline / Local graph." },
		{ id: "b", name: "Chat pane + note", note: "Split workspace: a Chat view bound to the thread beside a knowledge note that receives 'Extract to note' embeds; traces open from the status bar." },
		{ id: "c", name: "Graph as workspace", note: "The global graph is the main tab; clicking a node previews it in the right sidebar with an ask box, and the Runs pane is the left-sidebar inbox." },
		{ id: "d", name: "Canvas research tree", note: "The thread as a canvas: question cards, follow-up and branch arrows, a linked note and a sources group; asking from a card adds a connected card." },
		{ id: "e", name: "First run", note: "Empty vault with a labelled ribbon and a Welcome note: agent setup, the ask callout, example prompts, and how follow-up, branch and extract differ." }
	],
	fonts: "family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500",
	css: expandCss(CSS),
	mount: mount
});

/* ------------------------------------------------------------------ mount */
function mount(root, ctx) {
	var V = ctx.variant || "a";
	var timers = new Set();
	function later(fn, ms) { var t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; }

	/* ---------------- model */
	var D = JSON.parse(JSON.stringify({
		now: ctx.data.now, user: ctx.data.user, providers: ctx.data.providers, statuses: ctx.data.statuses,
		workspaces: ctx.data.workspaces, folders: ctx.data.folders, threads: ctx.data.threads, notes: ctx.data.notes,
		drafts: ctx.data.drafts, inbox: ctx.data.inbox, bookmarks: ctx.data.bookmarks
	}));
	var FRESH = V === "e";
	if (FRESH) {
		D.threads = []; D.notes = []; D.drafts = []; D.inbox = []; D.bookmarks = []; D.folders = [];
		D.workspaces = [{ id: "ws-inbox", name: "Inbox", dir: "~/Session/Inbox" }];
	}
	var VAULT = FRESH ? { name: "My research", dir: "~/Session" } : { name: "research", dir: "~/research" };
	var PROV = {}; D.providers.forEach(p => { PROV[p.id] = p; });
	var PCOL = { claude: "#d9906b", codex: "#3fa77a", grok: "#6b7280" };

	function thread(id) { for (var i = 0; i < D.threads.length; i++) if (D.threads[i].id === id) return D.threads[i]; return null; }
	function turnById(id) {
		for (var i = 0; i < D.threads.length; i++) for (var j = 0; j < D.threads[i].turns.length; j++) {
			var u = D.threads[i].turns[j]; if (u.id === id) { u.threadId = D.threads[i].id; return u; }
		}
		return null;
	}
	function kids(t, turnId, rel) { return t.turns.filter(u => u.parentId === turnId && (!rel || u.relation === rel)).sort((a, b) => a.createdAt < b.createdAt ? -1 : 1); }
	function noteOfTurn(t, u) {
		while (u && u.relation === "followup") u = t.turns.find(x => x.id === u.parentId);
		if (!u) return null;
		return u.relation === "branch" ? "br:" + u.id : "th:" + t.id;
	}
	function chainFrom(t, start) {
		var out = [];
		(function walk(u) { out.push(u); kids(t, u.id, "followup").forEach(walk); })(start);
		return out;
	}
	function wsName(id) { var w = D.workspaces.find(x => x.id === id); return w ? w.name : ""; }
	function folderName(id) { var f = D.folders.find(x => x.id === id); return f ? f.name : ""; }
	function threadPath(t) {
		if (t.archivedAt) return ["Archive"];
		var p = [wsName(t.workspaceId)];
		if (t.folderId) p.push(folderName(t.folderId));
		return p;
	}
	function threadStatus(t) {
		var st = t.turns.map(u => u.status);
		if (st.indexOf("needs-review") >= 0) return "needs-review";
		if (st.indexOf("running") >= 0) return "running";
		if (st.indexOf("failed") >= 0) return "failed";
		if (st.indexOf("queued") >= 0 && st.every(s => s === "queued")) return "queued";
		return t.status === "queued" ? "queued" : (st.indexOf("queued") >= 0 ? "running" : "done");
	}

	/* Files: everything that can open in a tab and appear in the explorer. */
	function fileInfo(fid) {
		var k = fid.split(":")[0], id = fid.slice(k.length + 1), t, u;
		if (k === "th") { t = thread(id); if (!t) return null; return { fid, kind: "thread", t, title: t.title, path: threadPath(t), start: t.turns.find(x => x.id === t.rootTurnId) || t.turns.find(x => x.relation === "root") }; }
		if (k === "br") { u = turnById(id); if (!u) return null; t = thread(u.threadId); return { fid, kind: "branch", t, u, title: u.title, path: threadPath(t), start: u, parentFid: noteOfTurn(t, t.turns.find(x => x.id === u.parentId)) }; }
		if (k === "n") { var n = D.notes.find(x => x.id === id); if (!n) return null; return { fid, kind: "note", n, title: n.title, path: [wsName(n.workspaceId)] }; }
		if (k === "x") { var x = S.extracted.find(e => e.id === id); if (!x) return null; return { fid, kind: "extract", x, title: x.title, path: x.path }; }
		if (k === "d") { var d = D.drafts.find(e => e.id === id); if (!d) return null; return { fid, kind: "draft", d, title: trunc(d.prompt, 48), path: ["Drafts"] }; }
		if (k === "pb") { var pb = S.pending[id]; if (!pb) return null; return { fid, kind: "pbranch", pb, title: "New branch", path: threadPath(thread(pb.threadId)) }; }
		if (k === "nq") { return { fid, kind: "newq", title: "New question", path: [FRESH ? "Inbox" : wsName(S.newWs)] }; }
		if (k === "w") return { fid, kind: "welcome", title: FRESH ? "Welcome" : "Start here", path: [] };
		return null;
	}
	function allFiles() {
		var out = [];
		out.push("w:welcome");
		D.threads.forEach(t => {
			out.push("th:" + t.id);
			t.turns.forEach(u => { if (u.relation === "branch") out.push("br:" + u.id); });
		});
		D.notes.forEach(n => { out.push("n:" + n.id); });
		S.extracted.forEach(x => { out.push("x:" + x.id); });
		D.drafts.forEach(d => { out.push("d:" + d.id); });
		return out;
	}

	/* ---------------- state */
	var S = {
		left: { open: true, tab: V === "c" ? "runs" : "files" },
		right: { open: V === "a" || V === "c", stacks: V === "c" ? [{ tabs: ["preview", "tags", "backlinks"], a: 0 }] : [{ tabs: ["backlinks", "outgoing", "tags"], a: 0 }, { tabs: ["outline", "localgraph"], a: 0 }] },
		groups: [], fg: 0,
		expanded: new Set(["Compilers", "Compilers/JIT", "th:t1", "Inbox", "ML infra", "ML infra/Serving"]),
		foldTurns: new Set(), openTrace: new Set(), foldBullets: new Set(), foldSecs: new Set(["unlinked"]), propsFold: new Set(),
		search: "", palette: null, menu: null, pop: null, sel: null, runsPop: null, notices: [],
		agent: { provider: "claude", model: "opus", effort: "high" },
		compose: {}, runs: {}, extracted: [], pending: {}, appends: {}, uid: 0, newWs: "ws-compilers",
		graph: { tags: true, sources: false, orphans: true, open: { filters: true, groups: false, forces: false }, panel: V === "c", repel: 1, dist: 1, hover: null, q: "", sel: V === "c" ? "th:t3" : null },
		gpos: {}, lpos: {}, gview: { k: 1, x: 0, y: 0 },
		canvas: { sel: "t1q4", view: null, tid: "t1" },
		agents: FRESH ? { claude: "ready", codex: "signed-out", grok: "missing" } : { claude: "ready", codex: "ready", grok: "signed-out" },
		vaultMenu: false, cannedN: {}, pick: {}, askMode: {}

	};
	function tabFile(fid, mode) { return { kind: "file", fid, mode: mode || "live", hist: [fid], hi: 0 }; }
	if (V === "a") S.groups = [{ tabs: [tabFile("th:t1"), tabFile("n:n1"), { kind: "graph" }], a: 0 }];
	if (V === "b") { S.groups = [{ tabs: [{ kind: "chat", fid: "th:t1" }], a: 0 }, { tabs: [tabFile("n:n1"), tabFile("th:t1", "read")], a: 0 }]; }
	if (V === "c") { S.groups = [{ tabs: [{ kind: "graph" }, tabFile("th:t3")], a: 0 }]; S.expanded.add("ML infra/Serving"); }
	if (V === "d") S.groups = [{ tabs: [{ kind: "canvas", tid: "t1" }, tabFile("th:t1")], a: 0 }];
	if (V === "e") S.groups = [{ tabs: [tabFile("w:welcome", "read")], a: 0 }];

	function curTab(gi) { var g = S.groups[gi == null ? S.fg : gi]; return g ? g.tabs[g.a] : null; }
	function curFid() {
		var t = curTab(); if (!t) return null;
		if (t.kind === "file" || t.kind === "chat") return t.fid;
		if (t.kind === "canvas") return "th:" + t.tid;
		return null;
	}
	function uid(p) { S.uid += 1; return p + S.uid; }

	/* ---------------- scaling-aware positioning */
	function scale() { var r = root.getBoundingClientRect(); return r.width / 1280 || 1; }
	function relRect(el) {
		var rr = root.getBoundingClientRect(), r = el.getBoundingClientRect(), s = scale();
		return { x: (r.left - rr.left) / s, y: (r.top - rr.top) / s, w: r.width / s, h: r.height / s };
	}

	/* ---------------- render with scroll and focus preservation */
	var rendering = false;
	function render() {
		if (rendering) return; rendering = true;
		var sk = {}; root.querySelectorAll("[data-sk]").forEach(el => { sk[el.getAttribute("data-sk")] = [el.scrollTop, el.scrollLeft]; });
		var ae = document.activeElement, fk = null, hadFocus = root.contains(ae);
		if (ae && root.contains(ae) && ae.getAttribute("data-fk")) fk = { k: ae.getAttribute("data-fk"), s: ae.selectionStart, e: ae.selectionEnd };
		root.replaceChildren(app());
		root.querySelectorAll("[data-sk]").forEach(el => { var v = sk[el.getAttribute("data-sk")]; if (v) { el.scrollTop = v[0]; el.scrollLeft = v[1]; } });
		if (fk) { var n = root.querySelector('[data-fk="' + fk.k + '"]'); if (n) { n.focus({ preventScroll: true }); try { n.setSelectionRange(fk.s, fk.e); } catch (e) { /* not a text field */ } } }
		var pf = root.querySelector("[data-autofocus]"); if (pf && !fk) { pf.focus({ preventScroll: true }); if (pf.hasAttribute("data-select")) pf.select(); }
		if (hadFocus && !root.contains(document.activeElement)) root.focus({ preventScroll: true });

		rendering = false;
		afterRender.forEach(f => { f(); }); afterRender = [];
	}
	var afterRender = [];

	function notice(msg) {
		var n = { id: uid("nt"), msg: msg }; S.notices.push(n); render();
		later(() => { S.notices = S.notices.filter(x => x !== n); render(); }, 2600);
	}

	/* ---------------- navigation */
	function openFile(fid, opts) {
		opts = opts || {};
		S.sel = null; S.pop = null;
		if (fid.indexOf("th:") === 0) { var t = thread(fid.slice(3)); if (t) t.unread = false; }
		revealInTree(fid);
		if (opts.split) {
			if (S.right.open && S.groups.length < 2) S.right.open = false;
			if (S.groups.length < 2) S.groups.push({ tabs: [tabFile(fid)], a: 0 });
			else { var g2 = S.groups[1]; var ix = g2.tabs.findIndex(x => x.fid === fid && x.kind === "file"); if (ix >= 0) g2.a = ix; else { g2.tabs.push(tabFile(fid)); g2.a = g2.tabs.length - 1; } }
			S.fg = 1; render(); return;
		}
		for (var gi = 0; gi < S.groups.length; gi++) {
			var gg = S.groups[gi], i = gg.tabs.findIndex(x => x.kind === "file" && x.fid === fid);
			if (i >= 0) { gg.a = i; S.fg = gi; if (opts.turn) scrollToTurn(opts.turn); render(); return; }
		}
		var g = S.groups[S.fg], tab = g.tabs[g.a];
		if (!opts.newTab && tab && (tab.kind === "file" || tab.kind === "empty")) {
			if (tab.kind === "empty") { g.tabs[g.a] = tabFile(fid); }
			else { tab.hist = tab.hist.slice(0, tab.hi + 1); tab.hist.push(fid); tab.hi = tab.hist.length - 1; tab.fid = fid; }
		} else { g.tabs.splice(g.a + 1, 0, tabFile(fid)); g.a += 1; }
		if (opts.turn) scrollToTurn(opts.turn);
		render();
	}
	function scrollToTurn(turnId) {
		afterRender.push(() => {
			var el = root.querySelector('.o-group.focus [data-turn="' + turnId + '"]') || root.querySelector('[data-turn="' + turnId + '"]');
			if (!el) return;
			var sc = el.closest(".o-scroll, .o-chat-scroll"); if (!sc) return;
			sc.scrollTop = el.offsetTop - 12;
		});
	}
	function revealInTree(fid) {
		var f = fileInfo(fid); if (!f) return;
		var acc = []; f.path.forEach(p => { acc.push(p); S.expanded.add(acc.join("/")); });
		if (f.kind === "branch" && f.parentFid) { S.expanded.add(f.parentFid); var pf = fileInfo(f.parentFid); if (pf && pf.kind === "branch") S.expanded.add(pf.parentFid); }
	}
	function openView(kind, extra) {
		var g = S.groups[S.fg];
		var ix = g.tabs.findIndex(x => x.kind === kind && (!extra || x.tid === extra.tid));
		if (ix >= 0) g.a = ix; else { g.tabs.splice(g.a + 1, 0, Object.assign({ kind: kind }, extra || {})); g.a += 1; }
		render();
	}
	function closeTab(gi, ti) {
		var g = S.groups[gi]; g.tabs.splice(ti, 1);
		if (!g.tabs.length) { if (S.groups.length > 1) { S.groups.splice(gi, 1); S.fg = 0; } else g.tabs.push({ kind: "empty" }); }
		g.a = Math.max(0, Math.min(g.a, g.tabs.length - 1)); render();
	}
	function navHist(dir) {
		var t = curTab(); if (!t || t.kind !== "file") return;
		var ni = t.hi + dir; if (ni < 0 || ni >= t.hist.length) return;
		t.hi = ni; t.fid = t.hist[ni]; render();
	}

	/* ================================================================ APP */
	function app() {
		var shell = h("div", { class: "o-app" + (V === "e" ? " o-beginner" : "") },
			div("o-tl", h("i"), h("i"), h("i")),
			ribbon(),
			S.left.open ? leftSidebar() : null,
			mainArea(),
			S.right.open ? rightSidebar() : null,
			statusBar(),
			overlays());
		return shell;
	}

	/* ---------------- ribbon */
	function ribbon() {
		function rb(ic, label, fn, on, kbd) {
			return h("button", { class: "o-rb" + (on ? " on" : ""), title: label + (kbd ? " (" + kbd + ")" : ""), "aria-label": label, onclick: fn }, icon(ic, 18), span(null, label));
		}
		var tab = curTab() || {};
		return h("nav", { class: "o-ribbon", "aria-label": "Ribbon" },
			div("o-rbsec", "Ask"),
			rb("edit", "New question", newQuestion, false, "⌘N"),
			rb("search", "Quick switcher", () => openPalette("files"), false, "⌘O"),
			div("o-rbsec", "Views"),
			rb("graph", "Graph view", () => openView("graph"), tab.kind === "graph", "⌘G"),
			rb("canvas", "Research canvas", () => openCanvas(), tab.kind === "canvas"),
			rb("activity", "Runs", () => { S.left.open = true; S.left.tab = "runs"; render(); }, S.left.open && S.left.tab === "runs"),
			rb("terminal", "Command palette", () => openPalette("cmd"), false, "⌘P"),
			div("o-sp"),
			V === "e" ? rb("vault", "Open sample vault", () => ctx.setVariant("a")) : null,
			rb("help", FRESH ? "Welcome" : "Start here", () => openFile("w:welcome"))
		);
	}
	function openCanvas(tid) {
		var f = fileInfo(curFid() || "th:t1");
		tid = typeof tid === "string" ? tid : f && f.t ? f.t.id : (D.threads[0] && D.threads[0].id);
		if (!tid) { notice("Open a thread note first."); return; }
		S.canvas.tid = tid; S.canvas.view = null; S.canvas.sel = null;
		openView("canvas", { tid: tid });
	}

	/* ---------------- left sidebar */
	function leftSidebar() {
		var tabs = [["files", "folder", "Files"], ["search", "search", "Search"], ["bookmarks", "bookmark", "Bookmarks"], ["runs", "activity", "Runs"]];
		var body;
		if (S.left.tab === "files") body = filesPane();
		else if (S.left.tab === "search") body = searchPane();
		else if (S.left.tab === "bookmarks") body = bookmarksPane();
		else body = runsPane();
		return h("aside", { class: "o-ls", "aria-label": "Left sidebar" },
			div("o-sbhead",
				V === "e" ? null : ib("sideL", "Collapse left sidebar", () => { S.left.open = false; render(); }, 17),
				V === "e" ? null : h("span", { style: "width:6px" }),
				tabs.map(t => {
					var cnt = t[0] === "runs" ? attention().length : 0;
					return h("button", { class: "o-ib" + (S.left.tab === t[0] ? " on" : ""), title: t[2], "aria-label": t[2], style: "position:relative", onclick: () => { S.left.tab = t[0]; render(); } }, icon(t[1], 16),
						cnt ? h("span", { style: "position:absolute;right:3px;top:3px;width:6px;height:6px;border-radius:50%;background:rgb(var(--c-orange))" }) : null);
				}),
				span("o-gap")),
			body,
			vaultRow());
	}
	function vaultRow() {
		return div("o-vault",
			h("button", { class: "o-vbtn", title: "Switch vault", onclick: e => { showMenu(e.currentTarget, vaultMenuItems(), { up: true }); } },
				icon("chevUD", 14), span(null, VAULT.name), h("small", null, VAULT.dir)),
			ib("help", "Help", () => openPalette("cmd"), 15, "sm"),
			ib("settings", "Settings", () => notice("Settings: theme, fonts, agents and the vault location."), 15, "sm"));
	}
	function vaultMenuItems() {
		return [
			{ lab: "Vaults" },
			{ label: "research", sub: "~/research", icon: FRESH ? "vault" : "check", action: () => { if (FRESH) ctx.setVariant("a"); } },
			FRESH ? { label: "My research", sub: "~/Session", icon: "check" } : null,
			{ sep: true },
			{ label: "Create new vault…", icon: "plus", action: () => ctx.setVariant("e") },
			{ label: "Open folder as vault…", icon: "folder", action: () => notice("Choose a folder on disk to open as a vault.") },
			{ label: "Reveal vault in Finder", icon: "external", action: () => notice("Opened " + VAULT.dir + " in Finder.") }
		].filter(Boolean);
	}

	/* File explorer */
	function buildTree() {
		var rootN = { name: "", path: "", folders: [], files: [] };
		function folderAt(path) {
			var n = rootN, acc = [];
			path.forEach(p => {
				acc.push(p);
				var f = n.folders.find(x => x.name === p);
				if (!f) { f = { name: p, path: acc.join("/"), folders: [], files: [] }; n.folders.push(f); }
				n = f;
			});
			return n;
		}
		D.workspaces.forEach(w => { folderAt([w.name]); });
		D.folders.forEach(f => { folderAt([wsName(f.workspaceId), f.name]); });
		if (!FRESH) { folderAt(["Drafts"]); folderAt(["Archive"]); }
		allFiles().forEach(fid => {
			var f = fileInfo(fid); if (!f || f.kind === "branch") return;
			folderAt(f.path).files.push(f);
		});
		Object.keys(S.pending).forEach(k => { if (S.pending[k].temp) return; });
		var order = D.workspaces.map(w => w.name).concat(["Drafts", "Archive"]);
		rootN.folders.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
		(function sortRec(n) {
			n.folders.forEach(sortRec);
			if (n !== rootN) n.folders.sort((a, b) => a.name.localeCompare(b.name));
			n.files.sort((a, b) => a.title.localeCompare(b.title));
		})(rootN);
		return rootN;
	}
	function fileBadge(f) {
		if (f.kind === "draft") return span("o-badge", "draft");
		if (!f.t) return null;
		var st = f.kind === "thread" ? threadStatus(f.t) : chainFrom(f.t, f.start).reduce((a, u) => u.status === "running" || u.status === "failed" || u.status === "needs-review" ? u.status : a, f.start.status);
		if (st === "running") return h("span", { class: "o-badge run", title: "Running" }, "run");
		if (st === "failed") return h("span", { class: "o-badge fail", title: "A run failed" }, "fail");
		if (st === "needs-review") return h("span", { class: "o-badge rev", title: "Needs review" }, "review");
		if (st === "queued") return h("span", { class: "o-badge q", title: "Queued" }, "queued");
		if (f.kind === "thread" && f.t.kind === "post") return span("o-badge", "link");
		if (f.kind === "thread" && f.t.source === "imported") return span("o-badge", "import");
		return null;
	}
	function filesPane() {
		var tree = buildTree(), cur = curFid(), rows = [];
		function fileRow(f, depth) {
			var branches = [];
			if (f.kind === "thread" || f.kind === "branch") {
				chainFrom(f.t, f.start).forEach(u => { kids(f.t, u.id, "branch").forEach(b => { branches.push(fileInfo("br:" + b.id)); }); });
			}
			var open = S.expanded.has(f.fid);
			var row = h("div", {
				class: "o-ti" + (cur === f.fid ? " act" : "") + (branches.length && !open ? " fold" : ""), style: "padding-left:" + (22 + depth * 16) + "px",
				title: f.title, onclick: () => openFile(f.fid), oncontextmenu: e => { e.preventDefault(); showMenu(e.currentTarget, noteMenu(f.fid), { at: e }); }
			},
			branches.length ? h("span", { class: "o-chev", style: "left:" + (5 + depth * 16) + "px", onclick: e => { e.stopPropagation(); toggleSet(S.expanded, f.fid); } }, icon("chevD", 14)) : null,
			f.kind === "branch" ? h("span", { style: "color:rgb(var(--c-blue));display:flex" }, icon("branch", 13)) : null,
			span("o-tt", f.title),
			f.t && f.t.unread && f.kind === "thread" ? h("span", { class: "o-udot", title: "Unread answer" }) : null,
			fileBadge(f));
			rows.push(row);
			if (branches.length && open) {
				var box = h("div", { class: "o-kids", style: "--gx:" + (12 + depth * 16) + "px" });
				var save = rows; rows = [];
				branches.forEach(b => { fileRow(b, depth + 1); });
				addKids(box, rows); rows = save; rows.push(box);
			}
		}
		function folderRow(n, depth) {
			var open = S.expanded.has(n.path);
			var count = countFiles(n);
			rows.push(h("div", { class: "o-ti o-fd" + (open ? "" : " fold"), style: "padding-left:" + (22 + depth * 16) + "px", onclick: () => toggleSet(S.expanded, n.path) },
				h("span", { class: "o-chev", style: "left:" + (5 + depth * 16) + "px" }, icon("chevD", 14)),
				span("o-tt", n.name),
				!open && count ? span("o-kbd", String(count)) : null));
			if (open) {
				var box = h("div", { class: "o-kids", style: "--gx:" + (12 + depth * 16) + "px" });
				var save = rows; rows = [];
				n.folders.forEach(c => { folderRow(c, depth + 1); });
				n.files.forEach(f => { fileRow(f, depth + 1); });
				if (!n.folders.length && !n.files.length) rows.push(h("div", { class: "o-ti", style: "padding-left:" + (38 + depth * 16) + "px;color:var(--tx4);cursor:default" }, "Empty"));
				addKids(box, rows); rows = save; rows.push(box);
			}
		}
		tree.folders.forEach(n => { folderRow(n, 0); });
		tree.files.forEach(f => { fileRow(f, 0); });
		return [
			div("o-navbar",
				h("button", { class: "o-ib", title: "New question (⌘N)", onclick: newQuestion }, icon("edit", 16)),
				ib("folderPlus", "New folder", () => { notice("New folder created in " + (FRESH ? "My research" : "Compilers") + "."); }),
				h("button", { class: "o-ib", title: "Change sort order" }, icon("sort", 16)),
				ib("collapse", "Collapse all", () => { S.expanded.clear(); render(); })),
			h("div", { class: "o-sbscroll", "data-sk": "files" }, rows)
		];
	}
	function countFiles(n) { return n.files.length + n.folders.reduce((a, c) => a + countFiles(c), 0); }
	function toggleSet(set, k) { if (set.has(k)) set.delete(k); else set.add(k); render(); }
	/* One menu for a note, used by the explorer's context menu, the view header's ⋯ button and canvas cards. */
	function noteMenu(fid, tab) {
		var f = fileInfo(fid); if (!f) return [];
		var items = [
			tab ? { label: tab.mode === "source" ? "Live Preview" : "Source mode", icon: "terminal", action: () => { tab.mode = tab.mode === "source" ? "live" : "source"; render(); } } : { label: "Open in new tab", icon: "plus", action: () => openFile(fid, { newTab: true }) },
			tab ? { label: tab.mode === "read" ? "Edit" : "Reading view", icon: "book", hint: "⌘E", action: () => { tab.mode = tab.mode === "read" ? "live" : "read"; render(); } } : null,
			{ label: "Open to the right", icon: "split", action: () => openFile(fid, { split: true }) },
			f.t ? { label: "Open as canvas", icon: "canvas", action: () => openCanvas(f.t.id) } : null,
			f.t ? { label: "Open chat for this note", icon: "chat", action: () => openChat(fid) } : null,
			{ sep: true }];
		if (f.kind === "thread") items.push(
			{ label: "Generate recap", icon: "list2", action: () => notice("Recap regenerated with " + PROV[f.t.provider].label + " " + f.t.model + ".") },
			{ label: isBookmarked(f.t.id) ? "Remove bookmark" : "Bookmark", icon: "bookmark", action: () => toggleBookmark(f.t.id) },
			{ label: "Move to folder…", icon: "folder", action: () => openPalette("move", fid) },
			{ label: f.t.archivedAt ? "Unarchive" : "Archive", icon: "archive", action: () => { f.t.archivedAt = f.t.archivedAt ? null : D.now; render(); notice(f.t.archivedAt ? "Archived: moved to Archive; follow-ups and branches are off." : "Unarchived."); } },
			{ label: "Copy as Markdown", icon: "copy", action: () => notice("Copied " + f.title + ".md") },
			{ sep: true });
		items.push({ label: "Delete…", icon: "x", action: () => notice("Delete asks for confirmation in the app.") });
		return items.filter(Boolean);
	}

	/* Search */
	function searchIndex() {
		var out = [];
		allFiles().forEach(fid => {
			var f = fileInfo(fid); if (!f) return;
			var lines = [f.title];
			if (f.t && (f.kind === "thread" || f.kind === "branch")) chainFrom(f.t, f.start).forEach(u => { lines.push(u.question); u.answer.forEach(p => { lines.push(p); }); });
			if (f.n) (function walk(arr) { arr.forEach(o => { lines.push(o.text); if (o.children) walk(o.children); }); })(f.n.outline);
			if (f.d) lines.push(f.d.prompt);
			var tags = f.t ? f.t.tags : f.n ? f.n.tags : [];
			out.push({ f, lines: lines.map(plain), tags: tags });
		});
		return out;
	}
	/* Search: free text plus tag:, path:, status:, model: and provider: operators; all must match. */
	function searchPane() {
		var q = S.search.trim(), results = [], ops = [], text = [];
		q.split(/\s+/).filter(Boolean).forEach(w => { var m = w.match(/^(tag|path|status|model|provider):(.+)$/i); if (m) ops.push([m[1].toLowerCase(), m[2].toLowerCase().replace(/^#/, "")]); else if (w[0] === "#") ops.push(["tag", w.slice(1).toLowerCase()]); else text.push(w); });
		var tq = text.join(" ").toLowerCase();
		if (q) searchIndex().forEach(it => {
			var f = it.f, u = f.u || f.start, st = f.kind === "thread" ? threadStatus(f.t) : u ? u.status : "";
			var ok = ops.every(o => o[0] === "tag" ? it.tags.some(t => t.toLowerCase().indexOf(o[1]) === 0) : o[0] === "path" ? f.path.join("/").toLowerCase().indexOf(o[1]) >= 0
				: !u ? false : o[0] === "status" ? st.indexOf(o[1]) === 0 : o[0] === "model" ? u.model.toLowerCase().indexOf(o[1]) === 0 : (u.provider + " " + PROV[u.provider].label).toLowerCase().indexOf(o[1]) >= 0);
			if (!ok) return;
			var snips = [];
			if (tq) it.lines.forEach(l => { var i = l.toLowerCase().indexOf(tq); if (i >= 0 && snips.length < 2) snips.push(l.slice(Math.max(0, i - 40), i + 90)); });
			else snips.push((it.tags.length ? "#" + it.tags.slice(0, 3).join(" #") : f.path.join(" / ")) + (u ? " · " + st + " · " + u.model : ""));
			if (snips.length) results.push({ f, snips });
		});
		q = tq;
		function mark(s) {
			if (!q) return s;
			var i = s.toLowerCase().indexOf(q.toLowerCase()); if (i < 0) return s;
			return [s.slice(0, i), h("mark", null, s.slice(i, i + q.length)), s.slice(i + q.length)];
		}
		return [
			h("div", { style: "padding:8px 10px 0" },
				div("o-inwrap", icon("search", 14), h("input", { class: "o-input", placeholder: "Search notes, answers and tags…", value: S.search, "data-fk": "search", "data-autofocus": "", oninput: e => { S.search = e.target.value; render(); } }))),
			h("div", { class: "o-sbscroll", "data-sk": "search" },
				S.search.trim() ? div("o-paneh", h("b", null, results.length + (results.length === 1 ? " file" : " files")), span("o-gap")) : null,
				S.search.trim() ? results.map(r => {
					return h("div", { class: "o-res", onclick: () => openFile(r.f.fid) },
						div("o-rt", icon(r.f.kind === "note" ? "list2" : r.f.kind === "branch" ? "branch" : "file", 13), span(null, r.f.title)),
						r.snips.map(s => { return div("o-rs", mark(s)); }));
				}) : [
					div("o-paneh", h("b", null, "Search options")),
					[["path:", "match the folder path"], ["tag:", "#tag or tag:#tag"], ["status:", "running, failed, review"], ["model:", "opus, gpt-5.6-sol…"], ["provider:", "claude, codex, grok"]].map(o => h("div", { class: "o-opt", onclick: () => { S.search = (S.search ? S.search + " " : "") + o[0]; render(); } }, h("code", null, o[0]), span(null, o[1]))),
					h("div", { class: "o-paneh", style: "margin-top:8px" }, h("b", null, "Recent searches")),
					["status:failed", "tag:kv-cache model:opus", "path:Reading status:review"].map(s => { return h("div", { class: "o-res", onclick: () => { S.search = s; render(); } }, div("o-rt", icon("search", 13), span(null, s))); })
				])
		];
	}

	/* Bookmarks: notes, headings (stars), blocks (highlights) */
	function isBookmarked(tid) { return D.bookmarks.some(b => b.threadId === tid); }
	function toggleBookmark(tid) {
		if (isBookmarked(tid)) D.bookmarks = D.bookmarks.filter(b => b.threadId !== tid);
		else D.bookmarks.unshift({ threadId: tid, createdAt: D.now });
		render();
	}
	function bookmarksPane() {
		var heads = [], blocks = [];
		D.threads.forEach(t => { t.turns.forEach(u => { if (u.starred) heads.push({ t, u: u }); u.highlights.forEach(hl => { blocks.push({ t, u, hl: hl }); }); }); });
		var sec = foldSec;
		return h("div", { class: "o-sbscroll", "data-sk": "bm", style: "padding-top:8px" },
			D.bookmarks.length + heads.length + blocks.length === 0 ? div("o-hint", "Nothing bookmarked yet. Bookmark a note from its ⋯ menu, a heading from its hover bar, or a passage with Highlight.") : null,
			sec("bm-notes", "Notes", D.bookmarks.length, D.bookmarks.map(b => {
				var t = thread(b.threadId); if (!t) return null;
				return h("div", { class: "o-ol", onclick: () => openFile("th:" + t.id) }, icon("file", 14), span("o-tt", t.title));
			})),
			sec("bm-heads", "Headings", heads.length, heads.map(x => {
				return h("div", { class: "o-ol", onclick: () => { openFile(noteOfTurn(x.t, x.u), { turn: x.u.id }); } }, icon("bookmark", 13), span("o-tt", x.u.title));
			})),
			sec("bm-blocks", "Highlights", blocks.length, blocks.map(x => {
				return h("div", { class: "o-res", onclick: () => { openFile(noteOfTurn(x.t, x.u), { turn: x.u.id }); } },
					h("div", { class: "o-rs", style: "-webkit-line-clamp:3;color:var(--tx)" }, h("span", { class: "o-mk " + x.hl.color }, plain(x.hl.quote))),
					x.hl.note ? h("div", { class: "o-rs", style: "font-style:italic" }, x.hl.note) : null,
					h("div", { class: "o-rs", style: "color:var(--tx3);font-size:11.5px" }, trunc(x.t.title, 40)));
			})));
	}

	/* Runs: what needs attention, what is running, what is queued. */
	function attention() {
		var out = [];
		D.threads.forEach(t => {
			t.turns.forEach(u => {
				if (u.status === "needs-review") out.push({ k: "rev", t, u, title: u.title, detail: PROV[u.provider].label + " is asking: " + (u.clarification || "") });
				if (u.status === "failed") out.push({ k: "fail", t, u, title: u.title, detail: u.error || "Run failed" });
			});
		});
		return out;
	}
	function runsList() {
		var running = [], queued = [], unread = [];
		D.threads.forEach(t => {
			t.turns.forEach(u => {
				if (u.status === "running") running.push({ k: "run", t, u, title: u.title, detail: (S.runs[u.id] ? curStep(u) : lastStep(u)) + " · " + elapsed(u) });
				if (u.status === "queued") queued.push({ k: "q", t, u, title: u.title, detail: queuedNote(t, u) });
			});
		});
		D.inbox.forEach(i => { if (i.kind === "unread") { var t = thread(i.threadId), u = turnById(i.turnId); if (t && u && t.unread) unread.push({ k: "unread", t, u, title: i.title, detail: i.detail }); } });
		return { attention: attention(), running, queued, unread: unread };
	}
	function lastStep(u) { var a = u.activity[u.activity.length - 1]; return a ? a.label : "Starting"; }
	function curStep(u) { return lastStep(u); }
	function elapsed(u) { var s = (new Date(S.runs[u.id] ? new Date().toISOString() : D.now) - new Date(S.runs[u.id] ? S.runs[u.id].started : u.createdAt)) / 1000; if (S.runs[u.id]) s = (Date.now() - S.runs[u.id].t0) / 1000; return fmtDur(Math.max(1, s)); }
	function queuedNote(t, u) { var p = t.turns.find(x => x.id === u.parentId); return "Runs after “" + (p ? p.title : "the running answer") + "” finishes"; }
	/* A foldable sidebar section with a count. */
	function foldSec(key, label, n, items) {
		var fold = S.foldSecs.has(key);
		return [h("div", { class: "o-secth" + (fold ? " fold" : ""), onclick: () => toggleSet(S.foldSecs, key) }, icon("chevD", 13), label, span("o-cnt", String(n))), fold ? null : items];
	}
	var RUN_IC = { rev: "alert", fail: "xcircle", q: "list", unread: "check" };
	function runItems(list, onPick) {
		return list.map(it => h("div", { class: "o-runitem " + it.k, onclick: () => onPick(it) },
			it.k === "run" ? icon("loader", 14, "r2-spin") : icon(RUN_IC[it.k], 14),
			h("div", { style: "min-width:0" }, h("b", null, it.title), h("small", null, it.detail), h("small", { class: "o-rth" }, it.t.title))));
	}
	/* Runs pane: the attention inbox */
	function runsPane() {
		var r = runsList(), pick = it => openFile(noteOfTurn(it.t, it.u), { turn: it.u.id });
		var sec = (key, label, list) => list.length ? foldSec(key, label, list.length, runItems(list, pick)) : null;
		return h("div", { class: "o-sbscroll", "data-sk": "runs", style: "padding-top:6px" },
			h("div", { class: "o-hint", style: "padding-bottom:2px" }, "Runs that need you come first. A note runs one answer at a time; later questions queue."),
			sec("r-att", "Needs you", r.attention), sec("r-run", "Running", r.running), sec("r-q", "Queued", r.queued), sec("r-unread", "Unread answers", r.unread),
			!r.attention.length && !r.running.length && !r.queued.length && !r.unread.length ? div("o-hint", "No runs yet. Questions you ask appear here while they run.") : null);
	}

	/* ---------------- main area */
	function mainArea() {
		return h("main", { class: "o-main" }, S.groups.map((g, gi) => group(g, gi)));
	}
	function tabTitle(t) {
		if (t.kind === "graph") return "Graph view";
		if (t.kind === "canvas") { var th = thread(t.tid); return (th ? trunc(th.title, 30) : "Research") + ".canvas"; }
		if (t.kind === "chat") { var f0 = fileInfo(t.fid); return "Chat: " + (f0 ? f0.title : ""); }
		if (t.kind === "empty") return "New tab";
		var f = fileInfo(t.fid); return f ? f.title : "Missing file";
	}
	function tabIcon(t) { return t.kind === "graph" ? "graph" : t.kind === "canvas" ? "canvas" : t.kind === "chat" ? "chat" : null; }
	function group(g, gi) {
		var tab = g.tabs[g.a];
		var isFirst = gi === 0, isLast = gi === S.groups.length - 1;
		var bar = h("div", { class: "o-tabbar", style: isFirst && !S.left.open ? "padding-left:" + (V === "e" ? 10 : 34) + "px" : null },
			isFirst && !S.left.open ? ib("sideL", "Expand left sidebar", () => { S.left.open = true; render(); }, 17) : null,
			g.tabs.map((t, ti) => {
				var ic = tabIcon(t);
				return h("div", { class: "o-tab" + (ti === g.a ? " act" : ""), title: tabTitle(t), onclick: () => { g.a = ti; S.fg = gi; render(); }, onauxclick: e => { if (e.button === 1) closeTab(gi, ti); } },
					ic ? span("o-tabic", icon(ic, 13)) : null,
					span("o-tt", tabTitle(t)),
					ib("x", "Close", e => { e.stopPropagation(); closeTab(gi, ti); }, 13));
			}),
			ib("plus", "New tab", () => { g.tabs.push({ kind: "empty" }); g.a = g.tabs.length - 1; S.fg = gi; render(); }, 15, "sm"),
			span("o-gap"),
			isLast ? h("button", { class: "o-ib sm", title: "Tab list", onclick: e => { showMenu(e.currentTarget, g.tabs.map((t, ti) => { return { label: tabTitle(t), icon: ti === g.a ? "check" : (tabIcon(t) || "file"), action: () => { g.a = ti; render(); } }; })); } }, icon("chevD", 15)) : null,
			isLast ? h("button", { class: "o-ib", title: S.right.open ? "Collapse right sidebar" : "Expand right sidebar", onclick: () => { S.right.open = !S.right.open; render(); } }, icon("sideR", 17)) : null);
		var narrow = S.groups.length > 1 || (S.left.open && S.right.open && V === "b");
		return h("section", { class: "o-group" + (gi === S.fg ? " focus" : "") + (narrow ? " o-narrow" : ""), onmousedown: () => { if (S.fg !== gi) { S.fg = gi; } } },
			bar, viewHeader(tab, gi), div("o-body", viewBody(tab, gi)));
	}
	function viewHeader(tab, gi) {
		if (!tab) return null;
		var crumb, acts = [];
		if (tab.kind === "file") {
			var f = fileInfo(tab.fid);
			crumb = f ? [f.path.length ? f.path.join(" / ") + " / " : "", h("b", null, f.title)] : "";
			if (f && f.t) acts.push(ib("chat", "Open chat for this note", () => openChat(tab.fid)));
			if (f && f.t) acts.push(ib("canvas", "Open as canvas", () => openCanvas(f.t.id)));
			acts.push(span("o-mode", tab.mode === "read" ? "Reading" : tab.mode === "source" ? "Source" : "Live Preview"));
			acts.push(h("button", { class: "o-ib", title: tab.mode === "read" ? "Edit (⌘E)" : "Reading view (⌘E)", onclick: () => { tab.mode = tab.mode === "read" ? "live" : "read"; render(); } }, icon(tab.mode === "read" ? "pen" : "book", 16)));
			acts.push(ib("more", "More options", e => { showMenu(e.currentTarget, noteMenu(tab.fid, tab)); }));
		} else if (tab.kind === "graph") {
			crumb = h("b", null, "Graph view");
			acts.push(h("button", { class: "o-ib" + (S.graph.panel ? " on" : ""), title: "Graph settings", onclick: () => { S.graph.panel = !S.graph.panel; render(); } }, icon("settings", 16)));
		} else if (tab.kind === "canvas") {
			var th = thread(tab.tid);
			crumb = [th ? threadPath(th).join(" / ") + " / " : "", h("b", null, tabTitle(tab))];
			acts.push(ib("file", "Open note", () => { openFile("th:" + tab.tid, { newTab: true }); }));
		} else if (tab.kind === "chat") {
			var cf = fileInfo(tab.fid);
			crumb = [span(null, "Chat · "), h("b", null, cf ? cf.title : "")];
			acts.push(h("button", { class: "o-ib", title: "Linked to the note: following it", style: "color:var(--acc)" }, icon("link", 15)));
			acts.push(ib("file", "Open the note to the right", () => { openFile(tab.fid, { split: true }); }));
		} else crumb = "";
		var nav = tab.kind === "file";
		return div("o-vh",
			h("button", { class: "o-ib", title: "Navigate back", style: nav && tab.hi > 0 ? null : "opacity:.4", onclick: () => navHist(-1) }, icon("arrowL", 16)),
			h("button", { class: "o-ib", title: "Navigate forward", style: nav && tab.hi < tab.hist.length - 1 ? null : "opacity:.4", onclick: () => navHist(1) }, icon("arrowR", 16)),
			div("o-crumb", crumb), acts);
	}
	function viewBody(tab, gi) {
		if (!tab) return null;
		if (tab.kind === "graph") return graphView(false);
		if (tab.kind === "canvas") return canvasView(tab);
		if (tab.kind === "chat") return chatView(tab, gi);
		if (tab.kind === "empty") return div("o-empty",
			h("h3", null, "No file is open"),
			h("button", { onclick: newQuestion }, "Ask a new question (⌘N)"),
			h("button", { onclick: () => openPalette("files") }, "Go to file (⌘O)"),
			h("button", { onclick: () => openView("graph") }, "Open graph view (⌘G)"),
			h("button", { onclick: () => closeTab(gi, S.groups[gi].a) }, "Close"));
		if (tab.mode === "source") return h("div", { class: "o-scroll", "data-sk": "src:" + tab.fid + gi }, sourceView(tab.fid));
		return h("div", { class: "o-scroll", "data-sk": "doc:" + tab.fid + gi }, docView(tab, gi));
	}

	/* ---------------- documents */
	function wiki(fidOrTitle, alias) {
		var fid = typeof fidOrTitle === "string" && fidOrTitle.indexOf(":") > 0 ? fidOrTitle : titleToFid(fidOrTitle);
		var f = fid ? fileInfo(fid) : null;
		return h("a", {
			class: "o-wl", href: "#", onclick: e => { e.preventDefault(); if (fid) openFile(fid, { newTab: e.metaKey || e.ctrlKey }); },
			onmouseenter: e => { if (fid) hoverPreview(e.currentTarget, fid); }, onmouseleave: () => { if (S.pop) { S.pop = null; renderPop(); } }
		}, alias || (f ? f.title : fidOrTitle));
	}
	function titleToFid(title) {
		var fids = allFiles();
		for (var i = 0; i < fids.length; i++) { var f = fileInfo(fids[i]); if (f && f.title === title) return fids[i]; }
		return null;
	}
	var MD = { wiki: (t, a) => wiki(t, a) };

	function block(text) {
		if (/^```/.test(text)) return h("pre", { class: "o-pre" }, text.replace(/^```\w*\n?/, "").replace(/\n?```$/, ""));
		var lines = text.split("\n"), out = [], para = [], list = null;
		function flush() { if (para.length) { out.push(h("p", null, inl(para.join(" "), MD))); para = []; } if (list) { out.push(list); list = null; } }
		lines.forEach(l => {
			if (/^#{2,4} /.test(l)) { flush(); out.push(div("o-h3", l.replace(/^#+ /, ""))); }
			else if (/^\s*[-*] /.test(l) || /^\s*\d+\. /.test(l)) { if (para.length) { out.push(h("p", null, inl(para.join(" "), MD))); para = []; } list = list || h("ul"); list.append(h("li", null, inl(l.replace(/^\s*([-*]|\d+\.) /, ""), MD))); }
			else { if (list) { out.push(list); list = null; } para.push(l); }
		});
		flush();
		return out;
	}
	/* A paragraph with highlight and branch-anchor marks applied on the raw Markdown. */
	/* Widen [i, i+len) so it never splits a `code span` of the raw Markdown. */
	function snapSpan(text, i, len) {
		if (i < 0) return { i: -1, j: -1 };
		var j = i + len, ticks = s => (s.match(/`/g) || []).length;
		if (ticks(text.slice(0, i)) % 2) i = text.lastIndexOf("`", i - 1);
		if (ticks(text.slice(0, j)) % 2) { var k = text.indexOf("`", j); j = k < 0 ? text.length : k + 1; }
		return { i, j };
	}
	/* Highlight = a block bookmark with a colour and an optional note. */
	function hlMenu(u, hl) {
		return [{ lab: "Highlight" }].concat(["amber", "green", "blue", "pink"].map(c => ({ label: c[0].toUpperCase() + c.slice(1), sw: c, icon: hl.color === c ? "check" : null, action: () => { hl.color = c; render(); } })),
			[{ sep: true }, { label: hl.note ? "Edit note…" : "Add note…", icon: "pen", action: () => { S.palette = { kind: "hlnote", q: hl.note || "", sel: 0, arg: hl }; render(); } },
				{ label: "Remove highlight", icon: "x", action: () => { u.highlights = u.highlights.filter(x => x !== hl); render(); } }]);
	}
	function paraWithMarks(text, marks, extra) {
		if (/^```|\n/.test(text) || !marks.length) { var b = block(text); if (extra && b.length && b[b.length - 1].tagName === "P") addKids(b[b.length - 1], [extra]); return b; }
		var segs = [], pos = 0;
		marks.map(m => Object.assign({}, m, snapSpan(text, text.indexOf(m.quote), m.quote.length))).filter(m => m.i >= 0)
			.sort((a, b) => a.i - b.i).forEach(m => {
				if (m.i < pos) return;
				if (m.i > pos) segs.push(inl(text.slice(pos, m.i), MD));
				var inner = inl(text.slice(m.i, m.j), MD);
				if (m.kind === "hl") segs.push(h("mark", { class: "o-mk " + (m.color || "amber"), title: (m.note || "Highlight") + " (click to edit)", onclick: e => showMenu(e.currentTarget, hlMenu(m.u, m.hl)) }, inner, m.note ? icon("chat", 11, "o-noteic") : null));
				else segs.push(h("span", { class: "o-brq", title: "Branched: " + m.title }, inner));
				pos = m.j;
			});
		if (pos < text.length) segs.push(inl(text.slice(pos), MD));
		return [h("p", null, segs, extra || null)];
	}

	function docView(tab, gi) {
		var f = fileInfo(tab.fid);
		if (!f) return div("o-doc", h("p", null, "This file no longer exists."));
		var read = tab.mode === "read";
		var doc = h("div", { class: "o-doc" + (read ? " o-reading" : "") });
		if (f.kind === "welcome") addKids(doc, welcomeDoc());
		else if (f.kind === "note") addKids(doc, noteDoc(f));
		else if (f.kind === "extract") addKids(doc, extractDoc(f));
		else if (f.kind === "draft") addKids(doc, draftDoc(f));
		else if (f.kind === "pbranch") addKids(doc, pendingBranchDoc(f));
		else if (f.kind === "newq") addKids(doc, newQuestionDoc(f));
		else {
			addKids(doc, threadDoc(f, tab, gi));
			var turns = chainFrom(f.t, f.start), box = askCallout(f, f.t, turns[turns.length - 1]);
			return [doc, box ? div("o-dock", box) : null];
		}
		return doc;
	}

	function props(key, rows) {
		var fold = S.propsFold.has(key);
		return div("o-props",
			h("div", { class: "o-propsh" + (fold ? " fold" : ""), onclick: () => toggleSet(S.propsFold, key) }, icon("chevD", 14), "Properties"),
			fold ? null : rows.filter(Boolean).map(r => {
				return div("o-prow", div("o-pk", icon(r[0], 15), r[1]), div("o-pv", r[2]));
			}));
	}
	function statusPill(st) {
		var map = { done: ["Done", "--c-green"], running: ["Running", "--c-blue"], failed: ["Failed", "--c-red"], "needs-review": ["Needs review", "--c-orange"], queued: ["Queued", "--c-gray"], cancelled: ["Stopped", "--c-gray"] };
		var m = map[st] || map.done;
		return h("span", { class: "o-status", style: "--c:var(" + m[1] + ")" }, h("i"), m[0]);
	}
	function tagPills(tags) { return tags.map(t => { return h("span", { class: "o-tag", onclick: () => searchTag(t) }, "#" + t); }); }
	function searchTag(t) { S.left.open = true; S.left.tab = "search"; S.search = "tag:#" + t; render(); }
	function agentChips(src, compact) {
		var p = PROV[src.provider] || { label: src.provider };
		return [
			h("span", { class: "o-pill chip", title: "Provider" }, h("span", { class: "o-dotp", style: "background:" + PCOL[src.provider] }), p.label),
			h("span", { class: "o-pill chip", title: "Model" }, src.model),
			src.effort ? h("span", { class: "o-pill chip", title: "Effort" }, src.effort) : (compact ? null : h("span", { class: "o-pill", style: "color:var(--tx3)" }, "no effort setting"))
		];
	}

	function threadDoc(f, tab, gi) {
		var t = f.t, out = [], read = tab.mode === "read";
		var turns = chainFrom(t, f.start);
		if (f.kind === "branch") out.push(div("o-up", icon("branch", 13), "Branch of", wiki(f.parentFid)));
		out.push(div("o-ititle", f.title));
		var srcCount = turns.reduce((a, u) => a + u.sources.length, 0);
		var domains = [];
		turns.forEach(u => { u.sources.forEach(s => { if (domains.indexOf(s.domain) < 0) domains.push(s.domain); }); });
		if (f.kind === "thread") {
			out.push(props(f.fid, [
				["list", "type", span(null, t.kind === "post" ? "link" : t.kind === "document" ? "document (imported)" : "thread")],
				["activity", "status", statusPill(threadStatus(t))],
				["terminal", "agent", agentChips(t)],
				["tag", "tags", tagPills(t.tags)],
				t.links.length ? ["link", "related", t.links.map(l => { var lt = thread(l); return lt ? h("span", { class: "o-pill link", onclick: () => openFile("th:" + l) }, trunc(lt.title, 34)) : null; })] : null,
				srcCount ? ["globe", "sources", [span("o-pill", srcCount + " sources"), domains.slice(0, 2).map(d => { return h("span", { class: "o-pill", style: "color:var(--tx2)" }, d); })]] : null,
				["calendar", "created", muted(fmtDate(t.createdAt))]
			]));
			if (t.recap) out.push(callout("abs", "list2", "Recap", span("o-meta", PROV[t.provider].label + " · " + t.model), [h("p", null, inl(t.recap, MD))]));
			if (t.archivedAt) out.push(callout("quote", "archive", "Archived " + fmtDate(t.archivedAt), null, [h("p", null, "Read-only: follow-ups and branches are disabled. Unarchive from the ⋯ menu to continue.")]));
		} else {
			var pu = t.turns.find(x => x.id === f.u.parentId);
			out.push(props(f.fid, [
				["list", "type", "branch"],
				["branch", "branched from", h("span", { class: "o-pill link", onclick: () => { openFile(f.parentFid, { turn: pu.id }); } }, fileInfo(f.parentFid).title + " › " + pu.title)],
				["activity", "status", statusPill(turns.reduce((a, u) => u.status !== "done" ? u.status : a, "done"))],
				["terminal", "agent", agentChips(f.u)],
				["calendar", "created", muted(fmtDate(f.u.createdAt))]
			]));
			if (f.u.anchor) out.push(callout("quote", "quote", span(null, "Passage", span("o-bid", "^p" + f.u.anchor.paragraph)), null, [h("p", null, inl(f.u.anchor.quote, MD))]));
		}
		turns.forEach((u, i) => { out.push(turnView(t, u, i, f, read)); });
		return out;
	}

	function callout(kind, ic, title, meta, body, opts) {
		opts = opts || {};
		var fold = opts.fold;
		return h("div", { class: "o-co " + kind, "data-co": opts.key || null },
			h("div", { class: "o-coh" + (opts.onToggle ? " click" : "") + (fold ? " fold" : ""), onclick: opts.onToggle || null }, icon(ic, 16), span(null, title), opts.onToggle ? span("o-fold", icon("chevD", 14)) : null, span("o-gap"), meta),
			fold ? null : div("o-cob", body));
	}

	function turnView(t, u, idx, f, read) {
		var folded = S.foldTurns.has(u.id);
		var branches = kids(t, u.id, "branch");
		var running = u.status === "running", live = !!S.runs[u.id];
		var wrap = h("div", { class: "o-turn" + (idx === 0 && f.kind === "thread" && !t.recap ? " o-first" : ""), "data-turn": u.id });
		var meta = span("o-meta", PROV[u.provider].label + " · " + u.model + (u.effort ? " · " + u.effort : "") + " · " + fmtDate(u.createdAt));
		if (idx === 0 && u.title === f.title) wrap.classList.add("o-notitle");
		if (!wrap.classList.contains("o-notitle")) wrap.append(h("div", { class: "o-h2" + (folded ? " fold" : "") },
			h("button", { class: "o-hf", title: folded ? "Expand" : "Fold", onclick: () => toggleSet(S.foldTurns, u.id) }, icon("chevD", 14)),
			span(null, u.title),
			u.status !== "done" ? statusPill(u.status) : null,
			span("o-hact",
				h("button", { class: "o-ib sm" + (u.starred ? " o-starred" : ""), title: u.starred ? "Remove heading bookmark" : "Bookmark heading", onclick: () => { u.starred = !u.starred; render(); } }, icon("bookmark", 14)),
				ib("more", "Heading menu", e => { showMenu(e.currentTarget, turnMenu(t, u)); }, 14, "sm"))));
		if (folded) return wrap;
		if (t.kind === "post" && u.relation === "root" && u.post) {
			wrap.append(div("o-linkcard", div("o-lci", icon("link", 18)),
				h("div", { style: "min-width:0" }, h("b", null, u.post.linkTitle), h("small", null, u.post.author + " · " + u.post.domain + " · saved " + fmtDate(u.createdAt)))));
			return wrap;
		}
		var isDoc = t.kind === "document" && u.relation === "root";
		wrap.append(callout(isDoc ? "info" : "q", isDoc ? "file" : "help", isDoc ? "Prompt that generated this report" : "Question", isDoc ? span("o-meta", "Imported " + fmtDate(u.createdAt)) : meta, block(u.question)));
		if (u.clarification && u.status === "needs-review") wrap.append(clarifyCallout(t, u));
		// answer
		var ans = h("div", { class: "o-ans", "data-live-ans": u.id });
		fillAnswer(ans, t, u, branches, read);
		// trace
		if (u.activity.length || running) {
			var open = S.openTrace.has(u.id) || (running && !S.openTrace.has("closed:" + u.id));
			var tr = traceCallout(u, open, () => { if (open) { S.openTrace.delete(u.id); S.openTrace.add("closed:" + u.id); } else { S.openTrace.add(u.id); S.openTrace.delete("closed:" + u.id); } render(); });
			wrap.append(tr);
		}
		wrap.append(ans);
		if (running) wrap.append(runLine(t, u));
		if (u.status === "failed") wrap.append(callout("fail", "xcircle", "Run failed", span("o-meta", fmtDur(u.durationSec)), [
			h("p", { style: "font-family:JetBrains Mono,monospace;font-size:12.5px" }, u.error || "The agent exited with an error."),
			div("o-row", h("button", { class: "o-btn", onclick: () => retry(t, u) }, icon("refresh", 13), "Retry"), h("button", { class: "o-btn ghost", onclick: () => { S.openTrace.add(u.id); render(); } }, "Show trace"))]));
		if (u.status === "queued") wrap.append(callout("quote", "list", "Queued", null, [h("p", null, queuedNote(t, u) + ". A note runs one answer at a time."),
			div("o-row", h("button", { class: "o-btn", onclick: () => { S.compose[f.fid] = u.question; removeTurn(t, u); } }, "Edit question"), h("button", { class: "o-btn ghost", onclick: () => removeTurn(t, u) }, "Remove"))]));
		if (u.sources.length) wrap.append(div("o-srcs", h("ol", null, u.sources.map(s => { return h("li", null, h("a", { class: "o-ext", href: "#", title: s.url, onclick: e => { e.preventDefault(); notice("Opens " + s.domain + " in the browser pane."); } }, s.title), span(null, s.domain)); }))));
		return wrap;
	}
	function fillAnswer(ans, t, u, branches, read) {
		ans.replaceChildren();
		branches = branches || kids(t, u.id, "branch");
		u.answer.forEach((p, i) => {
			var marks = [];
			u.highlights.forEach(hl => { if (hl.paragraph === i) marks.push({ kind: "hl", quote: hl.quote, color: hl.color, note: hl.note, hl, u }); });
			var brs = branches.filter(b => b.anchor && b.anchor.paragraph === i);
			brs.forEach(b => { marks.push({ kind: "br", quote: b.anchor.quote, title: b.title }); });
			var referenced = brs.length || S.extracted.some(x => x.turnId === u.id && x.para === i);
			var bid = referenced && !read ? span("o-bid", "^p" + i) : null;
			var el = h("div", { class: "o-para", "data-para": i, "data-turnid": u.id }, paraWithMarks(p, marks, bid));
			ans.append(el);
			brs.forEach(b => {
				var n = chainFrom(t, b).length;
				ans.append(div("o-brl", icon("branch", 13), "Branch", wiki("br:" + b.id), n > 1 ? span(null, "· " + n + " questions") : null, b.status !== "done" ? statusPill(b.status) : null));
			});
		});
		var whole = branches.filter(b => !b.anchor);
		whole.forEach(b => { ans.append(div("o-brl", icon("branch", 13), "Branch from the whole answer", wiki("br:" + b.id))); });
		if (u.status === "running" && S.runs[u.id] && S.runs[u.id].phase === "answer") { var last = ans.lastElementChild; var c = span("o-caret"); if (last && last.querySelector("p")) last.querySelector("p:last-of-type").append(c); else ans.append(c); }
	}
	function traceCallout(u, open, toggle) {
		var steps = u.activity, total = steps.reduce((a, s) => a + (s.ms || 0), 0);
		var meta = h("span", { class: "o-meta", "data-live-tmeta": u.id }, u.status === "running" ? "running" : (u.durationSec ? fmtDur(u.durationSec) : fmtDur(total / 1000)));
		return callout("trace", "activity", "Run · " + steps.length + " step" + (steps.length === 1 ? "" : "s"), meta, [h("div", { class: "o-steps", "data-live-steps": u.id }, stepRows(steps))], { fold: !open, onToggle: toggle, key: "trace:" + u.id });
	}
	function stepRows(steps) {
		return steps.map(s => {
			return h("div", { class: "o-step" + (s.status === "error" ? " err" : s.status === "running" ? " running" : "") },
				s.status === "running" ? icon("loader", 13, "r2-spin") : icon(s.status === "error" ? "xcircle" : (STEP_ICON[s.kind] || "file"), 13),
				span(null, s.label, s.detail ? h("em", null, s.detail) : null),
				h("small", null, s.status === "running" ? "…" : s.ms >= 1000 ? (s.ms / 1000).toFixed(1) + "s" : s.ms + "ms"));
		});
	}
	function runLine(t, u) {
		return h("div", { class: "o-runl", "data-live-run": u.id }, icon("loader", 14, "r2-spin"), h("span", { "data-live-runtxt": u.id }, "Running · " + curStep(u) + " · " + elapsed(u)), span("o-gap"),
			h("button", { class: "o-btn", onclick: () => stopRun(t, u) }, icon("stop", 12), "Stop"));
	}
	function clarifyCallout(t, u) {
		var key = "clar:" + u.id;
		return callout("warn", "alert", PROV[u.provider].label + " is asking", span("o-meta", "needs review"), [
			h("p", null, u.clarification),
			h("div", { class: "o-row", style: "gap:8px" },
				h("input", { class: "o-input", style: "padding-left:10px;flex:1;min-width:200px", placeholder: "Reply to continue the run…", value: S.compose[key] || "", "data-fk": key, oninput: e => { S.compose[key] = e.target.value; }, onkeydown: e => { if (e.key === "Enter" && e.target.value.trim()) { u.status = "done"; var txt = e.target.value.trim(); S.compose[key] = ""; ask(t, u, txt, "followup"); } } }),
				h("button", { class: "o-btn", onclick: () => { var txt = (S.compose[key] || "").trim() || "No. Only one voter changes at a time."; S.compose[key] = ""; u.status = "done"; ask(t, u, txt, "followup"); } }, "Reply"))]);
	}
	function turnMenu(t, u) {
		return [
			{ label: "Branch from the whole answer", icon: "branch", action: () => startBranch(t, u, null, null) },
			{ label: "Extract answer to new note", icon: "extract", action: () => { extract(t, u, 0, u.recap || plain(u.answer[0] || "")); } },
			{ label: u.starred ? "Remove heading bookmark" : "Bookmark heading", icon: "bookmark", action: () => { u.starred = !u.starred; render(); } },
			{ sep: true },
			{ label: "Copy link to heading", icon: "link", action: () => notice("Copied [[" + t.title + "#" + u.title + "]]") },
			{ label: "Copy answer as Markdown", icon: "copy", action: () => notice("Copied answer.") },
			{ label: "Retry run", icon: "refresh", action: () => retry(t, u) }
		];
	}

	/* The ask callout: one composer used by notes, drafts, branches, new questions and the welcome note. */
	function askBox(o) {
		var key = o.key;
		var send = () => { var q = (S.compose[key] || "").trim(); if (!q) return; S.compose[key] = ""; S.agent = Object.assign({}, pickFor(key, o.agent)); o.onSend(q); };
		var head = o.modes ? div("o-seg", o.modes.map(m => h("button", { class: m[0] === o.mode ? "on" : null, title: m[2], onclick: () => { S.askMode[key] = m[0]; render(); } }, icon(m[0] === "branch" ? "branch" : "chat", 13), m[1])))
			: [icon(o.icon || "chat", 16), span(null, o.title)];
		return h("div", { class: "o-co ask" + (o.cls ? " " + o.cls : "") },
			div("o-coh", head, span("o-gap"), span("o-meta", o.meta)),
			div("o-cob",
				h("textarea", {
					rows: o.rows || "2", "data-fk": key, "data-autofocus": o.autofocus ? "" : null, placeholder: o.placeholder, value: S.compose[key] || "",
					oninput: e => { S.compose[key] = e.target.value; },
					onkeydown: e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }
				}),
				div("o-askbar", agentPicker(key, o.agent), span("o-gap"), h("kbd", null, o.queue ? "↵ queue" : "↵ send · ⇧↵ new line"),
					h("button", { class: "o-send" + (o.queue ? " q" : ""), title: o.queue ? "Queue" : "Send", onclick: send }, o.queue ? "Queue" : icon("arrowUp", 15))),
				o.note ? div("o-asknote", o.note) : null));
	}
	/* Docked at the bottom of every thread note: Follow-up appends here, Branch starts a linked note. */
	function askCallout(f, t, lastTurn) {
		if (t.archivedAt) return null;
		var queue = chainFrom(t, f.start).some(u => u.status === "running"), mode = S.askMode[f.fid] || "followup", br = mode === "branch";
		return askBox({ key: f.fid, cls: "o-ask", rows: "1", mode, queue: queue && !br, agent: { provider: lastTurn.provider, model: lastTurn.model, effort: lastTurn.effort },
			modes: [["followup", "Follow-up", "Continue this note"], ["branch", "Branch", "Ask about the last answer in a new linked note"]],
			meta: br ? "new note linked to \u201c" + trunc(lastTurn.title, 28) + "\u201d" : queue ? "queues after the running answer" : "appends to this note · select text to branch from a passage",
			placeholder: br ? "Ask about the last answer in a separate note…" : queue ? "Type the next question; it runs when the current answer finishes" : "Ask a follow-up…",
			onSend: q => { if (!br) return ask(t, lastTurn, q, "followup"); var nu = ask(t, lastTurn, q, "branch"); S.askMode[f.fid] = "followup"; openFile("br:" + nu.id, { split: true }); } });
	}
	/* Each composer keeps its own agent choice; a note's composer starts from the agent of its last answer. */
	function pickFor(key, def) { return S.pick[key] || (S.pick[key] = Object.assign({}, def || S.agent)); }
	function agentPicker(key, def) {
		var a = pickFor(key || "default", def), p = PROV[a.provider];
		return [
			h("button", { class: "o-agent", title: "Provider (⌃⇧Tab)", onclick: e => { showMenu(e.currentTarget, D.providers.map(pp => { return { label: pp.label, icon: pp.id === a.provider ? "check" : "terminal", sub: S.agents[pp.id] === "ready" || !FRESH ? "" : "not set up", action: () => { a.provider = pp.id; a.model = pp.models[0] === "fable" ? "opus" : pp.models[0]; a.effort = pp.efforts.length ? (pp.efforts.indexOf("high") >= 0 ? "high" : pp.efforts[0]) : null; render(); } }; })); } },
				h("span", { class: "o-dotp", style: "background:" + PCOL[a.provider] }), p.label, icon("chevD", 12)),
			h("button", { class: "o-agent", title: "Model (⌃Tab)", onclick: e => { showMenu(e.currentTarget, p.models.map(m => { return { label: m, icon: m === a.model ? "check" : null, action: () => { a.model = m; render(); } }; })); } }, a.model, icon("chevD", 12)),
			p.efforts.length ? h("button", { class: "o-agent", title: "Effort", onclick: e => { showMenu(e.currentTarget, p.efforts.map(m => { return { label: m, icon: m === a.effort ? "check" : null, action: () => { a.effort = m; render(); } }; })); } }, a.effort || "effort", icon("chevD", 12)) : null
		];
	}

	/* Notes (outlines) */
	function noteDoc(f) {
		var n = f.n, out = [];
		out.push(div("o-ititle", n.title));
		out.push(props(f.fid, [["list", "type", "note"], ["tag", "tags", tagPills(n.tags)], ["calendar", "updated", muted(fmtDate(n.updatedAt))]]));
		function items(arr, path) {
			return h("ul", { class: "o-ul" }, arr.map((o, i) => {
				var key = n.id + ":" + path + i, has = o.children && o.children.length, fold = S.foldBullets.has(key);
				var ref = null;
				if (o.ref) {
					var t = thread(o.ref.threadId), u = o.ref.turnId ? turnById(o.ref.turnId) : null;
					if (t) {
						var fid = u ? noteOfTurn(t, u) : "th:" + t.id;
						ref = h("a", { class: "o-lref", href: "#", onclick: e => { e.preventDefault(); openFile(fid, { turn: u ? u.id : null }); }, onmouseenter: e => { hoverPreview(e.currentTarget, fid); }, onmouseleave: () => { S.pop = null; renderPop(); } },
							icon("link", 11), u && u.relation !== "root" ? trunc(u.title, 34) : trunc(t.title, 34));
					}
				}
				return h("li", { class: "o-li" + (has ? " has" : "") + (fold ? " fold" : "") },
					has ? h("button", { class: "o-lf", onclick: () => toggleSet(S.foldBullets, key) }, icon("chevD", 13)) : null,
					span(null, inl(o.text, MD)), ref,
					has && !fold ? items(o.children, path + i + ".") : null);
			}));
		}
		out.push(items(n.outline, ""));
		var app = S.appends[f.fid] || [];
		if (app.length) {
			out.push(h("div", { class: "o-h3", style: "margin-top:22px" }, "Extracted"));
			app.forEach(x => { out.push(embed(x)); });
		}
		out.push(h("p", { style: "color:var(--tx4);margin-top:18px;font-size:14px" }, "Type [[ to link a thread, or use Extract on a passage to add it here."));
		return out;
	}
	function embed(x) {
		var t = thread(x.threadId), u = turnById(x.turnId);
		return h("div", { class: "o-embed" + (x.isNew ? " new" : "") },
			div("o-emh", icon("link", 12), wiki(noteOfTurn(t, u), trunc(t.title, 34) + " › " + u.title), h("span", { class: "o-bid", style: "display:inline" }, "^p" + x.para)),
			div(null, inl(x.text, MD)));
	}
	function extractDoc(f) {
		var x = f.x;
		return [div("o-ititle", x.title),
			props(f.fid, [["list", "type", "note"], ["link", "source", h("span", { class: "o-pill link", onclick: () => { openFile(noteOfTurn(thread(x.threadId), turnById(x.turnId)), { turn: x.turnId }); } }, trunc(thread(x.threadId).title, 40))], ["calendar", "created", muted("just now")]]),
			embed(x),
			h("p", { style: "color:var(--tx3);font-size:14px" }, "Write your own words below the embed. The block stays linked to the answer it came from; backlinks show this note under the thread.")];
	}
	function draftDoc(f) {
		var d = f.d;
		if (S.compose[f.fid] == null) S.compose[f.fid] = d.prompt;
		return [div("o-ititle", "Draft"),
			props(f.fid, [["list", "type", "draft"], ["terminal", "agent", agentChips(d, true)], ["folder", "workspace", wsName(d.workspaceId)], ["calendar", "updated", muted(fmtDate(d.updatedAt))]]),
			askBox({ key: f.fid, title: "Unsent question", meta: "saved as a draft", rows: "3", onSend: () => sendDraft(d) })];
	}
	function sendDraft(d) {
		var q = (S.compose["d:" + d.id] || d.prompt).trim(); S.compose["d:" + d.id] = "";
		D.drafts = D.drafts.filter(x => x !== d);
		var t = newThread(q, d.workspaceId, null);
		replaceFid("d:" + d.id, "th:" + t.id);
	}
	function newQuestionDoc(f) {
		return [h("div", { class: "o-ititle", style: "color:var(--tx3)" }, "New question"),
			h("p", { style: "color:var(--tx2)" }, "The question, answer, tool trace and sources are saved as a note in ", h("b", null, FRESH ? "Inbox" : wsName(S.newWs)), "; the title is generated from the answer."),
			askBox({ key: "nq", title: "Ask", meta: "creates a thread note", rows: "3", autofocus: true, placeholder: "What do you want to find out?",
				onSend: q => { var t = newThread(q, FRESH ? "ws-inbox" : S.newWs, null); replaceFid(f.fid, "th:" + t.id); } })];
	}
	function pendingBranchDoc(f) {
		var pb = f.pb, t = thread(pb.threadId), u = turnById(pb.turnId);
		return [h("div", { class: "o-ititle", style: "color:var(--tx3)" }, "New branch"),
			props(f.fid, [["list", "type", "branch"], ["branch", "branched from", span("o-pill link", trunc(t.title, 30) + " › " + u.title)]]),
			callout("quote", "quote", pb.quote ? span(null, "Passage", span("o-bid", "^p" + pb.para)) : "Whole answer", null, [h("p", null, inl(pb.quote || trunc(plain(u.answer[0] || ""), 220), MD))]),
			askBox({ key: f.fid, icon: "branch", title: "Ask about this passage", meta: "starts a linked note", autofocus: true, placeholder: "What do you want to know about this passage?",
				onSend: q => { var nu = ask(t, u, q, "branch", pb.quote ? { turnId: u.id, paragraph: pb.para, quote: pb.quote } : null); delete S.pending[pb.id]; replaceFid(f.fid, "br:" + nu.id); },
				note: "A branch is a separate note linked to the passage. The original note shows a link under the paragraph." })];
	}
	function replaceFid(oldFid, newFid) {
		S.groups.forEach(g => { g.tabs.forEach(t => { if (t.fid === oldFid) { t.fid = newFid; if (t.hist) { t.hist[t.hi] = newFid; } } }); });
		revealInTree(newFid); render();
	}

	/* Welcome (first run) */
	function welcomeDoc() {
		var agents = [
			{ id: "claude", name: "Claude Code", av: "#d9906b", cmd: "claude auth login" },
			{ id: "codex", name: "Codex", av: "#3fa77a", cmd: "codex login" },
			{ id: "grok", name: "Grok", av: "#6b7280", cmd: "grok login" }
		];
		var stTxt = { ready: "Ready · signed in", "signed-out": "Installed · not signed in", missing: "Not installed · see the Grok CLI install guide", checking: "Checking…" };
		var key = "welcome";
		var send = q => { var t = newThread(q, FRESH ? "ws-inbox" : "ws-compilers", null); openFile("th:" + t.id, { newTab: true }); };
		return [
			div("o-ititle", FRESH ? "Welcome to Session" : "Start here"),
			h("p", null, "Session sends research questions to coding-agent CLIs on this Mac (Claude Code, Codex, Grok) using your existing sign-in. Each question, its answer, the tool trace and the sources are saved as a Markdown note in this vault, ", h("code", { class: "o-code" }, VAULT.dir), "."),
			h("div", { class: "o-h3", style: "font-size:19px;margin-top:22px" }, "1. Connect an agent"),
			h("p", { style: "color:var(--tx2);font-size:14px;margin-bottom:8px" }, "One ready agent is enough. Status updates on its own after you sign in."),
			agents.map(a => {
				var st = S.agents[a.id];
				return div("o-agentrow",
					h("div", { class: "o-av", style: "background:" + a.av }, a.name[0]),
					div(null, h("b", null, a.name), h("small", null, stTxt[st])),
					st === "ready" ? h("span", { class: "o-status", style: "--c:var(--c-green)" }, h("i"), "Ready") : st === "checking" ? h("span", { class: "o-status", style: "--c:var(--c-blue)" }, icon("loader", 11, "r2-spin"), "Checking") : st === "missing" ? h("button", { class: "o-btn", onclick: () => { S.agents[a.id] = "signed-out"; render(); notice("Grok CLI detected. Next: grok login"); } }, icon("external", 13), "Install guide")
						: span("o-cmd", a.cmd, h("button", { title: "Copy command", onclick: () => { notice("Copied: " + a.cmd); S.agents[a.id] = "checking"; render(); later(() => { S.agents[a.id] = "ready"; render(); notice(a.name + " signed in. Ready."); }, 1800); } }, icon("copy", 13))));
			}),
			h("div", { class: "o-h3", style: "font-size:19px;margin-top:22px" }, "2. Ask your first question"),
			askBox({ key, title: "Ask", meta: "creates a note in " + (FRESH ? "Inbox" : "Compilers"), placeholder: "What do you want to find out?", onSend: send }),
			div("o-ex",
				["Why does our CI build take 40% longer on the ARM runners than on x86?", "Summarize what changed in SQLite WAL mode between 3.37 and 3.46.", "Find every place this repo parses dates without a time zone."].map(q => {
					return h("button", { onclick: () => { S.compose[key] = q; render(); } }, q);
				})),
			h("div", { class: "o-h3", style: "font-size:19px;margin-top:26px" }, "3. How notes connect"),
			div("o-steps3",
				div(null, h("b", null, icon("chat", 15), "Follow-up"), "Type in the ask box at the end of a note. The question and answer append to the same note."),
				div(null, h("b", null, icon("branch", 15), "Branch"), "Select a passage in an answer and choose Branch. It becomes a linked note, so the original stays readable."),
				div(null, h("b", null, icon("extract", 15), "Extract"), "Turn a passage into its own note. Link notes with [[ ]]; the graph (⌘G) shows how they connect.")),
			FRESH ? h("p", { style: "color:var(--tx2);font-size:14px" }, "Want to look around first? ", h("a", { class: "o-wl", href: "#", onclick: e => { e.preventDefault(); ctx.setVariant("a"); } }, "Open the sample vault"), " with eleven research threads.")
				: h("p", { style: "color:var(--tx2);font-size:14px" }, "Examples in this vault: ", wiki("th:t1"), " (a thread with two branches), ", wiki("n:n1"), " (a note that links answers), and the ", h("a", { class: "o-wl", href: "#", onclick: e => { e.preventDefault(); openView("graph"); } }, "graph view"), ".")
		];
	}

	/* Source mode: the actual Markdown file */
	/* Source mode: the Markdown file as saved on disk, coloured by line type. */
	function toMarkdown(f) {
		var o = [], d = x => x.replace("T", " ").slice(0, 16), title = x => (x || {}).title;
		if (f.t && (f.kind === "thread" || f.kind === "branch")) {
			var t = f.t;
			o.push("---", "type: " + f.kind, "status: " + (f.kind === "thread" ? threadStatus(t) : f.u.status), "provider: " + t.provider, "model: " + t.model, t.effort ? "effort: " + t.effort : null, "tags: [" + t.tags.join(", ") + "]");
			if (f.kind === "thread" && t.links.length) o.push("related: [" + t.links.map(l => '"[[' + title(thread(l)) + ']]"').join(", ") + "]");
			if (f.kind === "branch") o.push('branched-from: "[[' + fileInfo(f.parentFid).title + (f.u.anchor ? "#^p" + f.u.anchor.paragraph : "") + ']]"');
			o.push("created: " + d(t.createdAt), "---");
			if (f.kind === "thread" && t.recap) o.push("> [!abstract] Recap", "> " + t.recap);
			chainFrom(t, f.start).forEach(u => {
				o.push("", "## " + u.title, "> [!question] " + PROV[u.provider].label + " · " + u.model + (u.effort ? " · " + u.effort : "") + " · " + d(u.createdAt));
				u.question.split("\n").forEach(q => o.push("> " + q));
				o.push("");
				var brs = kids(t, u.id, "branch");
				u.answer.forEach((p, i) => {
					var b = brs.filter(x => x.anchor && x.anchor.paragraph === i);
					u.highlights.forEach(hl => { if (hl.paragraph === i) p = p.replace(hl.quote, "==" + hl.quote + "=="); });
					o.push(p + (b.length ? " ^p" + i : ""));
					b.forEach(x => o.push("↳ branch: [[" + x.title + "]]"));
					o.push("");
				});
				if (u.activity.length) o.push("> [!trace]- Run · " + u.activity.length + " steps · " + fmtDur(u.durationSec)), u.activity.forEach(x => o.push("> - " + x.kind + ": " + x.label + (x.detail ? " (" + x.detail + ")" : "")));
				u.sources.forEach((x, i) => o.push("[^" + (i + 1) + "]: [" + x.title + "](" + x.url + ")"));
			});
		} else if (f.n) {
			o.push("---", "tags: [" + f.n.tags.join(", ") + "]", "updated: " + d(f.n.updatedAt), "---", "");
			(function walk(arr, dp) { arr.forEach(x => { o.push("    ".repeat(dp) + "- " + x.text + (x.ref ? " [[" + title(thread(x.ref.threadId)) + (x.ref.turnId ? "#" + title(turnById(x.ref.turnId)) : "") + "]]" : "")); if (x.children) walk(x.children, dp + 1); }); })(f.n.outline, 0);
		} else o.push("(This file has no Markdown body yet.)");
		return o.filter(x => x != null);
	}
	function sourceView(fid) {
		var f = fileInfo(fid), fm = 0;
		return div("o-src", f ? toMarkdown(f).map(l => {
			if (l === "---") fm++;
			if (fm === 1 && /^[\w-]+:/.test(l)) { var k = l.indexOf(":") + 1; return [span("k", l.slice(0, k)), l.slice(k), "\n"]; }
			var cls = l === "---" || /^> - |^↳/.test(l) ? "y" : /^> \[!/.test(l) ? "co" : /^## /.test(l) ? "hd" : null;
			return [cls ? span(cls, l) : l.replace(/ \^p\d+$/, ""), / \^p\d+$/.test(l) ? span("bi", l.match(/ \^p\d+$/)[0]) : null, "\n"];
		}) : "");
	}

	/* ---------------- chat view (variant B, or "Open chat" from any thread note) */
	function openChat(fid) {
		if (S.groups.length < 2) { S.groups.unshift({ tabs: [{ kind: "chat", fid: fid }], a: 0 }); S.fg = 0; }
		else { var g = S.groups[0]; var ix = g.tabs.findIndex(x => x.kind === "chat" && x.fid === fid); if (ix >= 0) g.a = ix; else { g.tabs.push({ kind: "chat", fid: fid }); g.a = g.tabs.length - 1; } S.fg = 0; }
		render();
	}
	function chatView(tab, gi) {
		var f = fileInfo(tab.fid); if (!f) return null;
		var t = f.t, turns = chainFrom(t, f.start), key = "chat:" + tab.fid;
		var last = turns[turns.length - 1];
		var runningHere = turns.some(u => u.status === "running");
		var send = () => { var q = (S.compose[key] || "").trim(); if (!q) return; S.compose[key] = ""; S.agent = Object.assign({}, pickFor(key)); ask(t, last, q, "followup"); };
		var target = noteTargetForExtract();
		var msgs = [];
		if (f.kind === "branch" && f.u.anchor) msgs.push(callout("quote", "quote", span(null, "Branch of ", wiki(f.parentFid)), null, [h("p", null, inl(f.u.anchor.quote, MD))]));
		turns.forEach(u => {
			msgs.push(h("div", { class: "o-msgu", "data-turn": u.id }, inl(plain(u.question).length > 600 ? trunc(u.question, 600) : u.question, MD), div("o-msgm", fmtDate(u.createdAt))));
			var ans = h("div", { class: "o-msga o-ans", "data-live-ans": u.id });
			fillAnswer(ans, t, u, null, true);
			msgs.push(div("o-msgah", h("span", { class: "o-dotp", style: "background:" + PCOL[u.provider] }), h("b", null, PROV[u.provider].label), u.model + (u.effort ? " · " + u.effort : ""), u.status !== "done" ? statusPill(u.status) : span(null, "· " + fmtDur(u.durationSec))));
			if (u.clarification && u.status === "needs-review") msgs.push(clarifyCallout(t, u));
			msgs.push(ans);
			if (u.status === "running") msgs.push(runLine(t, u));
			if (u.status === "failed") msgs.push(callout("fail", "xcircle", "Run failed", null, [h("p", { style: "font-family:JetBrains Mono,monospace;font-size:12.5px" }, u.error), h("button", { class: "o-btn", onclick: () => retry(t, u) }, icon("refresh", 13), "Retry")]));
			if (u.status === "queued") msgs.push(callout("quote", "list", "Queued", null, [h("p", null, queuedNote(t, u) + ".")]));
			if (u.answer.length && u.status !== "running") msgs.push(div("o-macts",
				h("button", { title: target ? "Add this answer's summary to " + target.title : "Extract to new note", onclick: () => { extract(t, u, 0, u.recap || plain(u.answer[0])); } }, icon("extract", 14), target ? "Extract to note" : "Extract"),
				h("button", { onclick: () => startBranch(t, u, null, null) }, icon("branch", 14), "Branch"),
				h("button", { onclick: () => notice("Copied answer as Markdown.") }, icon("copy", 14), "Copy"),
				u.activity.length ? h("button", { onclick: () => { S.runsPop = { focus: u.id }; render(); } }, icon("activity", 14), u.activity.length + " steps") : null,
				u.sources.length ? h("button", { onclick: () => { S.runsPop = { focus: u.id }; render(); } }, icon("globe", 14), u.sources.length + " sources") : null));
		});
		return div("o-chat",
			h("div", { class: "o-chat-scroll", "data-sk": "chat:" + tab.fid },
				msgs),
			div("o-chat-comp",
				h("textarea", { rows: "2", "data-fk": key, placeholder: runningHere ? "Next question (queues until the answer finishes)" : "Ask a follow-up…", value: S.compose[key] || "", oninput: e => { S.compose[key] = e.target.value; }, onkeydown: e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } } }),
				div("o-askbar", agentPicker(key, { provider: last.provider, model: last.model, effort: last.effort }), span("o-gap"), h("kbd", null, "↵"), h("button", { class: "o-send" + (runningHere ? " q" : ""), onclick: send }, runningHere ? "Queue" : icon("arrowUp", 15)))));
	}
	function noteTargetForExtract() {
		for (var gi = 0; gi < S.groups.length; gi++) { var t = curTab(gi); if (t && t.kind === "file" && t.fid.indexOf("n:") === 0) return fileInfo(t.fid); }
		return null;
	}

	/* ---------------- right sidebar */
	function rightSidebar() {
		var labels = { preview: ["reading", "Selected note"], backlinks: ["link", "Backlinks"], outgoing: ["arrowR", "Outgoing links"], tags: ["tag", "Tags"], outline: ["list", "Outline"], localgraph: ["graph", "Local graph"] };
		return h("aside", { class: "o-rs", "aria-label": "Right sidebar" }, S.right.stacks.map((st, si) => {
			var cur = st.tabs[st.a];
			return div("o-rstack",
				div("o-sbhead", st.tabs.map((k, i) => { return h("button", { class: "o-ib" + (i === st.a ? " on" : ""), title: labels[k][1], onclick: () => { st.a = i; render(); } }, icon(labels[k][0], 16)); }),
					span("o-gap"), h("span", { style: "font-size:12px;color:var(--tx3);padding-right:6px" }, labels[cur][1])),
				cur === "localgraph" ? div("o-lg", graphView(true)) : h("div", { class: "o-rscroll", "data-sk": "rs" + si + cur }, rightPane(cur)));
		}));
	}
	function rightPane(kind) {
		var fid = curFid(), f = fid ? fileInfo(fid) : null;
		if (kind === "tags") return tagsPane();
		if (kind === "preview") return previewPane();
		if (!f) return h("div", { class: "o-hint", style: "padding-top:10px" }, "Open a note to see its " + (kind === "outline" ? "outline" : "links") + ".");
		if (kind === "backlinks") return backlinksPane(f);
		if (kind === "outgoing") return outgoingPane(f);
		if (kind === "outline") return outlinePane(f);
		return null;
	}
	function backlinks(f) {
		var linked = [];
		if (f.t && f.kind === "thread") {
			D.threads.forEach(t => { if (t.id !== f.t.id && t.links.indexOf(f.t.id) >= 0) linked.push({ fid: "th:" + t.id, snip: ["Lists this note under ", h("code", { class: "o-code" }, "related")] }); });
			D.notes.forEach(n => {
				(function walk(arr) { arr.forEach(o => { if (o.ref && o.ref.threadId === f.t.id && (!o.ref.turnId || noteOfTurn(f.t, turnById(o.ref.turnId)) === f.fid)) linked.push({ fid: "n:" + n.id, snip: [o.text + " ", span("o-wl", "→ " + (o.ref.turnId ? turnById(o.ref.turnId).title : "whole note"))] }); if (o.children) walk(o.children); }); })(n.outline);
			});
		}
		if (f.t) {
			chainFrom(f.t, f.start).forEach(u => { kids(f.t, u.id, "branch").forEach(b => { linked.push({ fid: "br:" + b.id, snip: ["branched-from: ", span("o-wl", "#^p" + (b.anchor ? b.anchor.paragraph : "")), " ", b.anchor ? "“" + trunc(plain(b.anchor.quote), 70) + "”" : "whole answer"] }); }); });
		}
		if (f.kind === "note") D.threads.forEach(() => { });
		S.extracted.forEach(x => { if (f.t && x.threadId === f.t.id) linked.push({ fid: "x:" + x.id, snip: ["![[", span("o-wl", "^p" + x.para), "]] " + trunc(x.text, 60)] }); });
		// collapse duplicate notes
		var seen = {}, out = [];
		linked.forEach(l => { if (seen[l.fid]) { seen[l.fid].snips.push(l.snip); } else { seen[l.fid] = { fid: l.fid, snips: [l.snip] }; out.push(seen[l.fid]); } });
		return out;
	}
	function unlinked(f) {
		if (!f.t) return [];
		var word = (f.title.match(/[A-Z][\w.]+|\w{6,}/) || [""])[0].split(".")[0];
		if (!word) return [];
		var out = [];
		D.threads.forEach(t => {
			if (t.id === f.t.id || t.links.indexOf(f.t.id) >= 0) return;
			t.turns.forEach(u => { u.answer.forEach(p => { var s = plain(p), i = s.indexOf(word); if (i >= 0 && out.length < 3 && !out.some(o => o.fid === "th:" + t.id)) out.push({ fid: "th:" + t.id, snip: s.slice(Math.max(0, i - 50), i + 70), word: word }); }); });
		});
		return out;
	}
	function backlinksPane(f) {
		var bl = backlinks(f), ul = unlinked(f), foldU = S.foldSecs.has("unlinked"), foldL = S.foldSecs.has("linked");
		return [
			h("div", { class: "o-secth" + (foldL ? " fold" : ""), onclick: () => toggleSet(S.foldSecs, "linked") }, icon("chevD", 13), "Linked mentions", span("o-cnt", String(bl.length))),
			foldL ? null : (bl.length ? bl.map(b => {
				var bf = fileInfo(b.fid); if (!bf) return null;
				return h("div", { class: "o-bl", onclick: () => openFile(b.fid) }, div("o-blt", icon(bf.kind === "note" ? "list2" : bf.kind === "branch" ? "branch" : "file", 13), span(null, bf.title)),
					b.snips.slice(0, 3).map(s => { return div("o-bls", s); }));
			}) : div("o-hint", "No notes link here yet.")),
			h("div", { class: "o-secth" + (foldU ? " fold" : ""), onclick: () => toggleSet(S.foldSecs, "unlinked") }, icon("chevD", 13), "Unlinked mentions", span("o-cnt", String(ul.length))),
			foldU ? null : ul.map(u => {
				var bf = fileInfo(u.fid), i = u.snip.indexOf(u.word);
				return h("div", { class: "o-bl", onclick: () => openFile(u.fid) }, div("o-blt", icon("file", 13), span(null, bf.title)),
					div("o-bls", u.snip.slice(0, i), h("mark", { class: "o-mk amber" }, u.word), u.snip.slice(i + u.word.length)),
					h("div", { style: "margin-top:5px" }, h("button", { class: "o-btn", style: "height:22px;font-size:11.5px", onclick: e => { e.stopPropagation(); var t = thread(u.fid.slice(3)); t.links.push(f.t.id); render(); notice("Linked: added [[" + f.title + "]] to " + t.title); } }, "Link")));
			})
		];
	}
	function outgoingPane(f) {
		var links = [], srcs = [];
		if (f.t) {
			if (f.kind === "thread") f.t.links.forEach(l => { links.push("th:" + l); });
			if (f.kind === "branch") links.push(f.parentFid);
			chainFrom(f.t, f.start).forEach(u => { kids(f.t, u.id, "branch").forEach(b => { links.push("br:" + b.id); }); u.sources.forEach(s => { srcs.push(s); }); });
		}
		if (f.n) (function walk(arr) { arr.forEach(o => { if (o.ref) { var t = thread(o.ref.threadId); var u = o.ref.turnId ? turnById(o.ref.turnId) : null; var fid = u ? noteOfTurn(t, u) : "th:" + t.id; if (links.indexOf(fid) < 0) links.push(fid); } if (o.children) walk(o.children); }); })(f.n.outline);
		return [
			div("o-secth", icon("chevD", 13), "Links", span("o-cnt", String(links.length))),
			links.map(l => { var lf = fileInfo(l); return lf ? h("div", { class: "o-ol", onclick: () => openFile(l) }, icon(lf.kind === "branch" ? "branch" : "file", 13), span("o-tt", lf.title)) : null; }),
			srcs.length ? [div("o-secth", icon("chevD", 13), "Sources", span("o-cnt", String(srcs.length))),
				srcs.map(s => { return h("div", { class: "o-ol", title: s.url, onclick: () => notice("Opens " + s.domain + " in the browser pane.") }, icon("external", 13), span("o-tt", s.title)); })] : null
		];
	}
	function outlinePane(f) {
		if (f.n) return div(null, f.n.outline.map(o => { return div("o-ol", icon("chevR", 12), span("o-tt", o.text)); }));
		if (!f.t) return div("o-hint", "No headings.");
		var cur = null;
		function tree(fid, depth) {
			var fi = fileInfo(fid), rows = [];
			chainFrom(fi.t, fi.start).forEach(u => {
				rows.push(h("div", { class: "o-ol" + (fid === f.fid ? " cur" : ""), style: "padding-left:" + (6 + depth * 14) + "px", onclick: () => { openFile(fid, { turn: u.id }); } },
					span("o-tt", u.title), u.status !== "done" ? h("span", { class: "o-udot", style: "background:rgb(var(" + (u.status === "failed" ? "--c-red" : u.status === "running" ? "--c-blue" : u.status === "queued" ? "--c-gray" : "--c-orange") + "))" }) : null));
				kids(fi.t, u.id, "branch").forEach(b => {
					rows.push(h("div", { class: "o-ol", style: "padding-left:" + (20 + depth * 14) + "px;color:rgb(var(--c-blue))", onclick: () => openFile("br:" + b.id) }, icon("branch", 12), span("o-tt", b.title)));
					rows = rows.concat(tree("br:" + b.id, depth + 2).slice(1));
				});
			});
			return rows;
		}
		var top = f.kind === "thread" ? f.fid : (function up(x) { var fi = fileInfo(x); return fi.kind === "branch" ? up(fi.parentFid) : x; })(f.fid);
		return [h("div", { class: "o-hint", style: "padding:6px 6px 4px" }, "Headings in ", h("b", null, "this note"), "; branches are linked notes (blue)."), tree(top, 0)];
	}
	function tagsPane() {
		var counts = {};
		D.threads.forEach(t => { t.tags.forEach(g => { counts[g] = (counts[g] || 0) + 1; }); });
		D.notes.forEach(n => { n.tags.forEach(g => { counts[g] = (counts[g] || 0) + 1; }); });
		var keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
		if (!keys.length) return h("div", { class: "o-hint", style: "padding-top:10px" }, "No tags yet. Agents add tags to thread notes; type # in a note to add your own.");
		return [div("o-paneh", h("b", null, keys.length + " tags"), span("o-gap"), "by count"), keys.map(k => { return h("div", { class: "o-tagrow", onclick: () => searchTag(k) }, span(null, "#" + k), span("o-cnt", String(counts[k]))); })];
	}

	/* ---------------- graph */
	/* Clicking a graph node selects it: the right sidebar previews it and can ask a follow-up without leaving the graph. */
	function selectNode(id) {
		if (S.graph.sel === id) return openFile(id, { newTab: true });
		S.graph.sel = id; S.right.open = true;
		var st = S.right.stacks[0]; if (st.tabs.indexOf("preview") < 0) st.tabs.unshift("preview"); st.a = st.tabs.indexOf("preview");
		render();
	}
	function previewPane() {
		var fid = S.graph.sel, f = fid && fileInfo(fid);
		if (!f) return div("o-hint", "Click a node in the graph to preview it here. Click it again to open it.");
		var out = [h("div", { class: "o-pvt" }, wiki(fid)),
			div("o-row", ib("file", "Open note", () => openFile(fid, { newTab: true }), 15, "sm"), f.t ? ib("canvas", "Open as canvas", () => openCanvas(f.t.id), 15, "sm") : null, f.t ? ib("chat", "Open chat", () => openChat(fid), 15, "sm") : null, span("o-kbd", f.path.join(" / ")))];
		if (f.n) return out.concat(h("ul", { class: "o-pvl" }, f.n.outline.map(o => h("li", null, o.text))));
		if (!f.t) return out;
		var turns = chainFrom(f.t, f.start), end = turns[turns.length - 1], last = turns.filter(u => u.answer.length || u.status === "running").pop() || end;
		out.push(div("o-row", statusPill(f.kind === "thread" ? threadStatus(f.t) : last.status), muted(PROV[last.provider].label + " · " + last.model)));
		var rec = f.kind === "thread" ? f.t.recap : f.u.recap;
		if (rec) out.push(callout("abs", "list2", "Recap", null, [h("p", null, inl(rec, MD))]));
		out.push(div("o-pvq", icon("help", 13), span(null, last.title)));
		var ans = h("div", { class: "o-pva o-ans", "data-live-ans": last.id }); fillAnswer(ans, f.t, last, null, true);
		out.push(ans);
		if (last.status === "running") out.push(runLine(f.t, last));
		if (end !== last) out.push(div("o-pvq", icon("list", 13), span(null, "Queued: " + end.title)));
		if (!f.t.archivedAt) out.push(askBox({ key: "pv:" + fid, title: "Ask a follow-up", meta: turns.length + " in note", agent: { provider: last.provider, model: last.model, effort: last.effort }, placeholder: "Appends to this note…", onSend: q => ask(f.t, end, q, "followup") }));
		return out;
	}
	var GROUPS = [["Compilers", "--g-comp"], ["ML infra", "--g-ml"], ["Reading", "--g-read"], ["Inbox", "--g-comp"], ["Archive", "--g-tag"]];
	function graphModel(localFid) {
		var nodes = [], edges = [], idx = {};
		function node(id, label, type, group) { if (idx[id]) return idx[id]; var n = { id, label, type, group, deg: 0 }; idx[id] = n; nodes.push(n); return n; }
		function edge(a, b) { if (!idx[a] || !idx[b] || a === b) return; var k = a < b ? a + "|" + b : b + "|" + a; if (edges.some(e => e.k === k)) return; edges.push({ k, a, b: b }); idx[a].deg++; idx[b].deg++; }
		var q = S.graph.q.toLowerCase();
		D.threads.forEach(t => {
			var g = threadPath(t)[0];
			if (q && t.title.toLowerCase().indexOf(q) < 0 && !t.tags.some(x => x.indexOf(q) >= 0)) return;
			node("th:" + t.id, t.title, "thread", g);
			t.turns.forEach(u => { if (u.relation === "branch") node("br:" + u.id, u.title, "branch", g); });
		});
		D.notes.forEach(n => { node("n:" + n.id, n.title, "note", wsName(n.workspaceId)); });
		S.extracted.forEach(x => { node("x:" + x.id, x.title, "note", x.path[0]); });
		D.threads.forEach(t => {
			t.links.forEach(l => { edge("th:" + t.id, "th:" + l); });
			t.turns.forEach(u => { if (u.relation === "branch") edge("br:" + u.id, noteOfTurn(t, t.turns.find(x => x.id === u.parentId))); });
		});
		D.notes.forEach(n => { (function walk(arr) { arr.forEach(o => { if (o.ref) { var t = thread(o.ref.threadId), u = o.ref.turnId ? turnById(o.ref.turnId) : null; if (t) edge("n:" + n.id, u ? noteOfTurn(t, u) : "th:" + t.id); } if (o.children) walk(o.children); }); })(n.outline); });
		S.extracted.forEach(x => { edge("x:" + x.id, noteOfTurn(thread(x.threadId), turnById(x.turnId))); });
		if (S.graph.tags || localFid) {
			D.threads.forEach(t => { if (!idx["th:" + t.id]) return; t.tags.forEach(g => { node("tag:" + g, "#" + g, "tag", "tag"); edge("th:" + t.id, "tag:" + g); }); });
		}
		if (S.graph.sources && !localFid) {
			D.threads.forEach(t => { if (!idx["th:" + t.id]) return; t.turns.forEach(u => { u.sources.forEach(s => { node("src:" + s.domain, s.domain, "src", "src"); edge(noteOfTurn(t, u), "src:" + s.domain); }); }); });
		}
		if (localFid) {
			var keep = {}; keep[localFid] = 1;
			edges.forEach(e => { if (e.a === localFid) keep[e.b] = 1; if (e.b === localFid) keep[e.a] = 1; });
			// second hop, non-tag only
			var hop1 = Object.keys(keep);
			edges.forEach(e => { if (hop1.indexOf(e.a) >= 0 && e.b.indexOf("tag:") !== 0 && e.a.indexOf("tag:") !== 0) keep[e.b] = 1; if (hop1.indexOf(e.b) >= 0 && e.a.indexOf("tag:") !== 0 && e.b.indexOf("tag:") !== 0) keep[e.a] = 1; });
			nodes = nodes.filter(n => keep[n.id]);
			edges = edges.filter(e => keep[e.a] && keep[e.b]);
		} else if (!S.graph.orphans) {
			nodes = nodes.filter(n => n.deg > 0);
		}
		return { nodes, edges: edges };
	}
	function hash(s) { var x = 2166136261; for (var i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0) / 4294967296; }
	function simulate(m, W, H, pos, iters, opts) {
		opts = opts || {};
		var nodes = m.nodes, byId = {};
		nodes.forEach((n, i) => {
			var p = pos[n.id];
			if (!p) { var a = hash(n.id) * Math.PI * 2, r = 60 + hash(n.id + "r") * Math.min(W, H) * 0.35; p = pos[n.id] = { x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r, vx: 0, vy: 0 }; }
			n.p = p; n.w = n.type === "tag" || n.type === "src" ? 0.75 : 1 + Math.min(n.deg, 8) * 0.12; byId[n.id] = n;
		});
		var rep = (opts.rep || 1) * (opts.local ? 900 : 4200), len = (opts.dist || 1) * (opts.local ? 46 : 70);
		for (var it = 0; it < iters; it++) {
			var alpha = 1 - it / iters * 0.85;
			for (var i = 0; i < nodes.length; i++) for (var j = i + 1; j < nodes.length; j++) {
				var A = nodes[i].p, B = nodes[j].p, dx = A.x - B.x, dy = A.y - B.y, d2 = dx * dx + dy * dy + 30, f = rep * nodes[i].w * nodes[j].w / d2 * alpha, d = Math.sqrt(d2);
				A.vx += dx / d * f; A.vy += dy / d * f; B.vx -= dx / d * f; B.vy -= dy / d * f;
			}
			m.edges.forEach(e => {
				var A = byId[e.a].p, B = byId[e.b].p, dx = B.x - A.x, dy = B.y - A.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01;
				var L = (e.a.indexOf("tag:") === 0 || e.b.indexOf("tag:") === 0 || e.b.indexOf("src:") === 0) ? len * 0.7 : len;
				var f = (d - L) * 0.06 * alpha; A.vx += dx / d * f; A.vy += dy / d * f; B.vx -= dx / d * f; B.vy -= dy / d * f;
			});
			nodes.forEach(n => {
				var p = n.p; if (p.fixed) { p.vx = p.vy = 0; return; }
				p.vx += ((opts.cx || W / 2) - p.x) * (opts.local ? 0.01 : 0.004) * alpha; p.vy += (H / 2 - 16 - p.y) * (opts.local ? 0.014 : 0.012) * alpha;
				p.vx *= 0.55; p.vy *= 0.55;
				var sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy); if (sp > 20) { p.vx *= 20 / sp; p.vy *= 20 / sp; }
				p.x += p.vx; p.y += p.vy;
				p.x = Math.max(opts.local ? 30 : 70, Math.min(W - (opts.local ? 30 : 70), p.x)); p.y = Math.max(24, Math.min(H - (opts.local ? 24 : 70), p.y));
			});
		}
	}
	function nodeColor(n) {
		if (n.type === "tag") return "var(--g-tag)";
		if (n.type === "src") return "var(--g-src)";
		var g = GROUPS.find(x => x[0] === n.group);
		return g ? "var(" + g[1] + ")" : "var(--g-tag)";
	}
	var graphSig = { main: null, local: null };
	function graphView(local) {
		var cur = curFid();
		if (local && !cur) return h("div", { class: "o-hint", style: "padding:12px" }, "Open a note to see its local graph.");
		var m = graphModel(local ? cur : null);
		var mainW = 1280 - (V === "e" ? 160 : 44) - (S.left.open ? (V === "e" ? 220 : 252) : 0) - (S.right.open ? 276 : 0);
		var W = local ? 276 : Math.round(mainW / S.groups.length), H = local ? 300 : 722;
		var posMap = local ? S.lpos : S.gpos;
		var sig = m.nodes.map(n => n.id).join(",") + "|" + m.edges.length + "|" + S.graph.repel + "|" + S.graph.dist + "|" + W + "|" + S.graph.panel + (local ? "|" + cur : "");
		if (graphSig[local ? "local" : "main"] !== sig) {
			if (local) { for (var k in S.lpos) delete S.lpos[k]; }
			simulate(m, W, H, posMap, local ? 220 : 320, { local, rep: S.graph.repel, dist: S.graph.dist, cx: !local && S.graph.panel ? (W - 250) / 2 + 10 : 0 });
			graphSig[local ? "local" : "main"] = sig;
		} else m.nodes.forEach(n => { n.p = posMap[n.id]; });
		var byId = {}; m.nodes.forEach(n => { byId[n.id] = n; });
		var svg = svgNode("svg", { viewBox: "0 0 " + W + " " + H, preserveAspectRatio: "xMidYMid meet" });
		var gWorld = svgNode("g", { transform: local ? "" : "translate(" + S.gview.x + "," + S.gview.y + ") scale(" + S.gview.k + ")" });
		svg.append(gWorld);
		var lines = m.edges.map(e => {
			var A = byId[e.a].p, B = byId[e.b].p;
			var l = svgNode("line", { x1: A.x, y1: A.y, x2: B.x, y2: B.y }); l._e = e; gWorld.append(l); return l;
		});
		var gs = m.nodes.map(n => {
			var r = n.type === "tag" ? 3.2 : n.type === "src" ? 3 : n.type === "branch" ? 4 : 4.5 + Math.sqrt(n.deg) * 1.6;
			if (local) r *= 0.95;
			var g = svgNode("g", { "class": "o-gn " + n.type + (n.id === cur ? " cur" : "") + (!local && n.id === S.graph.sel ? " sel" : ""), transform: "translate(" + n.p.x + "," + n.p.y + ")" });
			var c = svgNode("circle", { r: r }); c.style.fill = nodeColor(n);
			if (n.type === "note") { c.setAttribute("stroke-width", "2"); }
			g.append(c);
			var showLabel = local ? (n.type !== "tag" || true) : true;
			if (showLabel) { var tx = svgNode("text", { y: r + 11 }); tx.textContent = trunc(n.label, local ? 22 : 30); g.append(tx); }
			g._n = n; gWorld.append(g);
			g.addEventListener("mouseenter", () => hoverNode(n));
			g.addEventListener("mouseleave", () => hoverNode(null));
			g.addEventListener("pointerdown", ev => { startDrag(ev, n, g); });
			return g;
		});
		function hoverNode(n) {
			if (!n) { svg.classList.remove("hov"); gs.forEach(g => { g.classList.remove("on"); }); lines.forEach(l => { l.classList.remove("on"); }); if (!local) { S.graph.hover = null; updCard(); } return; }
			svg.classList.add("hov");
			var nb = {}; nb[n.id] = 1;
			lines.forEach(l => { var on = l._e.a === n.id || l._e.b === n.id; l.classList.toggle("on", on); if (on) { nb[l._e.a] = 1; nb[l._e.b] = 1; } });
			gs.forEach(g => { g.classList.toggle("on", !!nb[g._n.id]); });
			if (!local) { S.graph.hover = n; updCard(); }
		}
		var dragging = null;
		function startDrag(ev, n, g) {
			ev.stopPropagation();
			var pt = svg.createSVGPoint(), moved = false, ctm = gWorld.getScreenCTM();
			dragging = n; n.p.fixed = true;
			function mv(e) {
				pt.x = e.clientX; pt.y = e.clientY; var p = pt.matrixTransform(ctm.inverse());
				if (Math.abs(p.x - n.p.x) + Math.abs(p.y - n.p.y) > 2) moved = true;
				if (!moved) return;
				n.p.x = p.x; n.p.y = p.y; relax(18);
			}
			function up() {
				window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
				n.p.fixed = false; dragging = null;
				if (!moved) {
					if (n.type === "tag") searchTag(n.label.slice(1));
					else if (n.type === "src") notice("Source: " + n.label);
					else if (local) openFile(n.id); else selectNode(n.id);
				} else relax(40);
			}
			window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
		}
		function relax(iters) {
			simulate(m, W, H, posMap, iters, { local, rep: S.graph.repel, dist: S.graph.dist });
			gs.forEach(g => { g.setAttribute("transform", "translate(" + g._n.p.x + "," + g._n.p.y + ")"); });
			lines.forEach(l => { var A = byId[l._e.a].p, B = byId[l._e.b].p; l.setAttribute("x1", A.x); l.setAttribute("y1", A.y); l.setAttribute("x2", B.x); l.setAttribute("y2", B.y); });
		}
		if (local) {
			return div("o-lg", svg,
				h("div", { style: "position:absolute;left:10px;bottom:8px;font-size:11px;color:var(--tx3)" }, m.nodes.length + " notes · depth 2"));
		}
		// pan + zoom
		var wrap = div("o-graph");
		wrap.addEventListener("pointerdown", ev => {
			if (ev.target.closest(".o-gpanel, .o-gtools, .o-gcard")) return;
			var sx = ev.clientX, sy = ev.clientY, ox = S.gview.x, oy = S.gview.y, sc = scale() * (svg.getBoundingClientRect().width / W / scale());
			function mv(e) { S.gview.x = ox + (e.clientX - sx) / sc; S.gview.y = oy + (e.clientY - sy) / sc; gWorld.setAttribute("transform", "translate(" + S.gview.x + "," + S.gview.y + ") scale(" + S.gview.k + ")"); }
			function up() { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); }
			window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
		});
		wrap.addEventListener("wheel", ev => {
			ev.preventDefault();
			var k0 = S.gview.k, k = Math.max(0.4, Math.min(3, k0 * (ev.deltaY < 0 ? 1.1 : 0.9)));
			S.gview.x = W / 2 - (W / 2 - S.gview.x) * k / k0; S.gview.y = H / 2 - (H / 2 - S.gview.y) * k / k0; S.gview.k = k;
			gWorld.setAttribute("transform", "translate(" + S.gview.x + "," + S.gview.y + ") scale(" + k + ")"); svg.classList.toggle("zoomed", k > 1.35);
		}, { passive: false });
		var card = div("o-gcard");
		function updCard() {
			var n = S.graph.hover;
			card.replaceChildren();
			if (!n) {
				card.append(h("b", null, m.nodes.filter(x => x.type !== "tag" && x.type !== "src").length + " notes · " + m.edges.length + " links"), div(null, "Hover to highlight links · click to preview, again to open · drag to move"));
				return;
			}
			var f = fileInfo(n.id);
			card.append(h("b", null, n.label));
			if (f && f.t) {
				var u = f.kind === "branch" ? f.u : f.start;
				card.append(h("div", { class: "o-row", style: "margin:4px 0 6px" }, statusPill(f.kind === "thread" ? threadStatus(f.t) : f.u.status), span(null, PROV[u.provider].label + " · " + u.model)));
				var rec = f.kind === "thread" ? f.t.recap : u.recap;
				if (rec) card.append(h("div", { style: "line-height:1.45" }, trunc(plain(rec), 180)));
			} else if (f && f.n) card.append(div(null, "Note · " + f.n.outline.length + " top-level items · #" + f.n.tags.join(" #")));
			else if (n.type === "tag") card.append(div(null, "Tag · " + n.deg + " notes. Click to search."));
			else card.append(div(null, "Source domain · cited by " + n.deg + " notes"));
		}
		updCard();
		function sw(label, key) { return div("o-tog", span(null, label), h("button", { class: "o-switch" + (S.graph[key] ? " on" : ""), "aria-pressed": String(!!S.graph[key]), onclick: () => { S.graph[key] = !S.graph[key]; render(); } })); }
		function sec(key, label, body) {
			var open = S.graph.open[key];
			return [h("div", { class: "o-gph" + (open ? "" : " fold"), onclick: () => { S.graph.open[key] = !open; render(); } }, icon("chevD", 13), label), open ? div("o-gpb", body) : null];
		}
		var panel = S.graph.panel ? div("o-gpanel",
			sec("filters", "Filters", [
				div("o-inwrap", icon("search", 13), h("input", { class: "o-input", style: "height:27px", placeholder: "Search files…", value: S.graph.q, "data-fk": "gq", oninput: e => { S.graph.q = e.target.value; render(); } })),
				sw("Tags", "tags"), sw("Sources", "sources"), sw("Orphans", "orphans")]),
			sec("groups", "Groups", [
				[["path:Compilers", "--g-comp"], ["path:\"ML infra\"", "--g-ml"], ["path:Reading", "--g-read"], ["tag nodes", "--g-tag"], ["sources", "--g-src"]].map(g => { return div("o-grp", h("i", { style: "background:var(" + g[1] + ")" }), h("code", null, g[0])); })]),
			sec("forces", "Forces", [
				div("o-tog", span(null, "Repel force")), h("input", { type: "range", class: "o-range", min: "0.4", max: "2", step: "0.1", value: String(S.graph.repel), onchange: e => { S.graph.repel = Number(e.target.value); render(); } }),
				div("o-tog", span(null, "Link distance")), h("input", { type: "range", class: "o-range", min: "0.5", max: "2", step: "0.1", value: String(S.graph.dist), onchange: e => { S.graph.dist = Number(e.target.value); render(); } })])) : null;
		wrap.append(svg, panel || h("span"), card,
			div("o-gtools",
				span("o-pill", icon("graph", 13), "Global graph"),
				h("button", { class: "o-pill chip", onclick: () => { S.gview = { k: 1, x: 0, y: 0 }; render(); } }, icon("fit", 13), "Reset view")));
		return wrap;
	}

	/* ---------------- canvas */
	function canvasLayout(t) {
		var CW = 264, CH = 222, GX = 96, GY = 60;
		var cells = {}, items = [], edges = [];
		function place(col, row) { while (cells[col + ":" + row]) row++; cells[col + ":" + row] = 1; return row; }
		function lay(u, col, row) {
			var r = place(col, row);
			items.push({ type: "turn", u, col, row: r });
			var fu = kids(t, u.id, "followup"), br = kids(t, u.id, "branch");
			br.forEach(b => { edges.push({ a: u.id, b: b.id, kind: "br", label: b.anchor ? "branch ¶" + (b.anchor.paragraph + 1) : "branch" }); lay(b, col + 1, r); });
			fu.forEach(f => { edges.push({ a: u.id, b: f.id, kind: "fu", label: "follow-up" }); lay(f, col, r + 1); });
		}
		var rootU = t.turns.find(x => x.id === t.rootTurnId);
		lay(rootU, 0, 0);
		var sel = S.canvas.sel ? items.find(i => i.u.id === S.canvas.sel) : null;
		if (sel && !t.archivedAt) { var r2 = place(sel.col, sel.row + 1); items.push({ type: "comp", col: sel.col, row: r2, parent: sel.u }); edges.push({ a: sel.u.id, b: "comp", kind: "fu dash", label: "new follow-up" }); }
		var note = D.notes.find(n => { var hit = false; (function walk(a) { a.forEach(o => { if (o.ref && o.ref.threadId === t.id) hit = true; if (o.children) walk(o.children); }); })(n.outline); return hit; });
		var maxCol = items.reduce((a, i) => Math.max(a, i.col), 0);
		if (note) { var nr = place(1, 1); items.push({ type: "note", n: note, col: 1, row: nr }); }
		var srcs = [];
		t.turns.forEach(u => { u.sources.forEach(s => { if (srcs.length < 2 && !srcs.some(x => x.s.domain === s.domain)) srcs.push({ s, u: u }); }); });
		var sc = 0, srow = place(0, 0);
		srcs.forEach((x, i) => { items.push({ type: "src", s: x.s, u: x.u, col: sc, row: srow, sub: i }); });
		items.forEach(it => {
			it.x = 40 + it.col * (CW + GX); it.y = 50 + it.row * (CH + GY); it.w = CW; it.h = CH;
			if (it.type === "src") { it.h = 62; it.y += it.sub * 78; it.id = "src" + it.sub; }
			else if (it.type === "comp") { it.h = 150; it.id = "comp"; }
			else if (it.type === "note") { it.id = "note"; }
			else it.id = it.u.id;
		});
		return { items, edges: edges };
	}
	function canvasView(tab) {
		var t = thread(tab.tid); if (!t) return div("o-empty", "Thread not found.");
		var L = canvasLayout(t), byId = {}; L.items.forEach(i => { byId[i.id] = i; });
		var maxX = 0, maxY = 0; L.items.forEach(i => { maxX = Math.max(maxX, i.x + i.w); maxY = Math.max(maxY, i.y + i.h); });
		if (!S.canvas.view) { var availW = (S.right.open ? 1280 - 44 - 252 - 276 : 1280 - 44 - (S.left.open ? 252 : 0)) - 20, availH = 800 - 80 - 40; var k = Math.min(1, availW / (maxX + 40), availH / (maxY + 40)); S.canvas.view = { k, x: Math.max(0, (availW - (maxX + 40) * k) / 2), y: 4 }; }
		var vw = S.canvas.view;
		var world = h("div", { class: "o-world", style: "transform:translate(" + vw.x + "px," + vw.y + "px) scale(" + vw.k + ");width:" + (maxX + 40) + "px;height:" + (maxY + 40) + "px" });
		var svg = svgNode("svg", { width: maxX + 40, height: maxY + 40 });
		var defs = svgNode("defs", {}), mk = svgNode("marker", { id: "o-arr", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
		var mp = svgNode("path", { d: "M0 0 L10 5 L0 10 z" }); mp.style.fill = "var(--tx3)"; mk.append(mp); defs.append(mk); svg.append(defs);
		// group box around the root conversation
		var rootCol = L.items.filter(i => i.type === "turn" && i.col === 0);
		if (rootCol.length) {
			var gy0 = Math.min.apply(null, rootCol.map(i => i.y)), gy1 = Math.max.apply(null, rootCol.map(i => i.y + i.h));
			world.append(h("div", { class: "o-cgroup", style: "left:" + (rootCol[0].x - 16) + "px;top:" + (gy0 - 16) + "px;width:" + (rootCol[0].w + 32) + "px;height:" + (gy1 - gy0 + 32) + "px" }, span(null, "Main conversation")));
		}
		var srcIt = L.items.filter(i => i.type === "src");
		if (srcIt.length) {
			var sy1 = Math.max.apply(null, srcIt.map(i => i.y + i.h));
			world.append(h("div", { class: "o-cgroup", style: "left:" + (srcIt[0].x - 12) + "px;top:" + (srcIt[0].y - 12) + "px;width:" + (srcIt[0].w + 24) + "px;height:" + (sy1 - srcIt[0].y + 24) + "px;background:rgba(var(--c-blue),.04)" }, span(null, "Sources")));
		}
		world.append(svg);

		L.edges.forEach(e => {
			var A = byId[e.a], B = byId[e.b]; if (!A || !B) return;
			var x1, y1, x2, y2, d;
			if (e.kind.indexOf("fu") === 0 || (e.kind === "ref" && Math.abs(A.x - B.x) < 5)) { x1 = A.x + A.w / 2; y1 = A.y + A.h; x2 = B.x + B.w / 2; y2 = B.y; d = "M" + x1 + " " + y1 + " C" + x1 + " " + (y1 + 30) + " " + x2 + " " + (y2 - 30) + " " + x2 + " " + y2; }
			else if (e.kind === "ref") { x1 = A.x; y1 = A.y + A.h / 2; x2 = B.x + B.w; y2 = B.y + B.h / 2; if (B.x > A.x) { x1 = A.x + A.w; x2 = B.x; } d = "M" + x1 + " " + y1 + " C" + (x1 + (x2 - x1) / 2) + " " + y1 + " " + (x1 + (x2 - x1) / 2) + " " + y2 + " " + x2 + " " + y2; }
			else { x1 = A.x + A.w; y1 = A.y + 70; x2 = B.x; y2 = B.y + 40; d = "M" + x1 + " " + y1 + " C" + (x1 + 34) + " " + y1 + " " + (x2 - 34) + " " + y2 + " " + x2 + " " + y2; }
			var p = svgNode("path", { d, "class": "e " + (e.kind === "br" ? "br" : e.kind === "ref" ? "ref" : ""), "marker-end": e.kind === "ref" ? "" : "url(#o-arr)" });
			if (e.kind.indexOf("dash") >= 0) p.setAttribute("stroke-dasharray", "4 4");
			svg.append(p);
			if (e.label) world.append(h("div", { class: "o-elbl", style: "left:" + ((x1 + x2) / 2) + "px;top:" + ((y1 + y2) / 2) + "px;" + (e.kind === "br" ? "color:rgb(var(--c-blue))" : "") }, e.label));
		});
		L.items.forEach(it => {
			var st = "left:" + it.x + "px;top:" + it.y + "px;width:" + it.w + "px;height:" + it.h + "px";
			if (it.type === "turn") {
				var u = it.u;
				world.append(h("div", { class: "o-card st-" + u.status + (S.canvas.sel === u.id ? " sel" : ""), style: st, "data-turn": u.id,
					onclick: e => { e.stopPropagation(); S.canvas.sel = u.id; render(); }, ondblclick: () => { openFile(noteOfTurn(t, u), { newTab: true, turn: u.id }); } },
					div("o-cardh", span(null, u.title), u.relation === "branch" ? h("span", { style: "color:rgb(var(--c-blue))" }, icon("branch", 14)) : null),
					div("o-cardq", span(null, plain(u.question))),
					h("div", { class: "o-cardb", "data-live-cans": u.id }, u.answer.length ? plain(u.answer[0]) : u.status === "queued" ? queuedNote(t, u) + "." : u.status === "failed" ? (u.error || "Run failed") : S.runs[u.id] ? curStep(u) : "Waiting for the agent…"),
					div("o-cardf", h("span", { class: "o-dotp", style: "background:" + PCOL[u.provider] }), u.model, u.status === "done" ? span(null, "· " + fmtDur(u.durationSec)) : statusPill(u.status), h("span", { style: "margin-left:auto", "data-live-csteps": u.id }, u.activity.length + " steps"))));
			} else if (it.type === "note") {
				world.append(h("div", { class: "o-card note", style: st, onclick: () => { openFile("n:" + it.n.id, { newTab: true }); } },
					div("o-cardh", icon("list2", 14), span(null, it.n.title)),
					h("ul", null, it.n.outline.slice(0, 4).map(o => h("li", null, trunc(o.text, 46)))),
					h("div", { class: "o-cardf", style: "margin-top:auto" }, "Note · links " + countRefs(it.n, t.id) + " headings in this thread")));
			} else if (it.type === "src") {
				world.append(h("div", { class: "o-card src", style: st, title: it.s.url, onclick: () => notice("Opens " + it.s.domain + " in the browser pane.") },
					h("div", { class: "o-lci", style: "width:30px;height:30px;border-radius:7px;background:rgba(var(--c-blue),.12);color:rgb(var(--c-blue));display:flex;align-items:center;justify-content:center;flex:none" }, icon("globe", 15)),
					h("div", { style: "min-width:0" }, h("b", null, trunc(it.s.title, 36)), h("small", null, it.s.domain))));
			} else if (it.type === "comp") {
				var key = "canvas:" + t.id;
				var send = () => { var q = (S.compose[key] || "").trim(); if (!q) return; S.compose[key] = ""; var nu = ask(t, it.parent, q, "followup"); S.canvas.sel = nu.id; render(); };
				world.append(h("div", { class: "o-card comp", style: st },
					h("div", { style: "font-size:12px;color:var(--acc2);font-weight:600;margin-bottom:4px;display:flex;gap:6px;align-items:center" }, icon("chat", 13), "Follow-up to “" + trunc(it.parent.title, 24) + "”"),
					h("textarea", { "data-fk": key, placeholder: "Ask a follow-up… (↵ to send)", value: S.compose[key] || "", oninput: e => { S.compose[key] = e.target.value; }, onkeydown: e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }, onclick: e => { e.stopPropagation(); } }),
					div("o-askbar", span("o-agent", h("span", { class: "o-dotp", style: "background:" + PCOL[S.agent.provider] }), S.agent.model), span("o-gap"), h("button", { class: "o-send", onclick: send }, icon("arrowUp", 14)))));
			}
		});
		var selIt = S.canvas.sel && byId[S.canvas.sel];
		if (selIt && selIt.type === "turn") {
			var su = selIt.u;
			world.append(h("div", { class: "o-cmenu", style: "left:" + (selIt.x + selIt.w / 2) + "px;top:" + (selIt.y - 8) + "px" },
				h("button", { onclick: () => { openFile(noteOfTurn(t, su), { newTab: true, turn: su.id }); } }, icon("file", 13), "Open"),
				h("button", { onclick: () => startBranch(t, su, null, null) }, icon("branch", 13), "Branch"),
				h("button", { onclick: () => { extract(t, su, 0, su.recap || plain(su.answer[0] || "")); } }, icon("extract", 13), "Extract")));
		}
		var cv = h("div", { class: "o-canvas", onclick: e => { if (e.target === cv) { S.canvas.sel = null; render(); } } }, world,
			div("o-cctl",
				ib("plus", "Zoom in", () => { vw.k = Math.min(2, vw.k * 1.15); render(); }, 14, "sm"),
				ib("minus", "Zoom out", () => { vw.k = Math.max(0.3, vw.k / 1.15); render(); }, 14, "sm"),
				ib("fit", "Zoom to fit", () => { S.canvas.view = null; render(); }, 14, "sm")),
			div("o-cadd",
				h("button", { onclick: () => { S.canvas.sel = S.canvas.sel || t.turns[t.turns.length - 1].id; render(); } }, icon("chat", 16), "Ask"),
				h("button", { onclick: () => notice("Drag a note from the file explorer onto the canvas.") }, icon("file", 16), "Note"),
				h("button", { onclick: () => notice("Paste a URL to add a link card.") }, icon("link", 16), "Link")));
		cv.addEventListener("pointerdown", ev => {
			if (ev.target !== cv && ev.target !== world) return;
			var sx = ev.clientX, sy = ev.clientY, ox = vw.x, oy = vw.y, s = scale();
			function mv(e) { vw.x = ox + (e.clientX - sx) / s; vw.y = oy + (e.clientY - sy) / s; world.style.transform = "translate(" + vw.x + "px," + vw.y + "px) scale(" + vw.k + ")"; }
			function up() { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); }
			window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
		});
		return cv;
	}
	function countRefs(n, tid) { var c = 0; (function walk(a) { a.forEach(o => { if (o.ref && o.ref.threadId === tid) c++; if (o.children) walk(o.children); }); })(n.outline); return c; }

	/* ---------------- status bar */
	function statusBar() {
		var running = [], fid = curFid(), f = fid ? fileInfo(fid) : null;
		D.threads.forEach(t => { t.turns.forEach(u => { if (u.status === "running") running.push({ t, u: u }); }); });
		var mine = running.filter(r => S.runs[r.u.id]);
		var items = [];
		if (running.length) {
			var lead = mine[0] || null;
			items.push(h("div", { class: "o-sbi click runs", "data-sb-run": "1", title: "Show runs", onclick: () => { S.runsPop = S.runsPop ? null : { focus: lead ? lead.u.id : null }; render(); } },
				icon("loader", 12, "r2-spin"),
				lead ? h("span", { "data-sb-runtxt": "1" }, trunc(lead.u.title, 26) + " · " + trunc(curStep(lead.u), 34) + " · " + elapsed(lead.u)) : span(null, running.length + " running"),
				lead && running.length > 1 ? h("span", { style: "color:var(--tx3)" }, "+" + (running.length - 1)) : null));
		} else items.push(h("div", { class: "o-sbi click", onclick: () => { S.runsPop = S.runsPop ? null : {}; render(); } }, icon("check", 12), "No runs"));
		var att = attention().length;
		if (att) items.push(h("div", { class: "o-sbi click", style: "color:rgb(var(--c-orange))", onclick: () => { S.left.open = true; S.left.tab = "runs"; render(); } }, icon("alert", 12), att + " need you"));
		if (f && (f.t || f.n)) {
			var bl = backlinks(f).length;
			items.push(h("div", { class: "o-sbi click", onclick: () => { S.right.open = true; S.right.stacks[0].a = Math.max(0, S.right.stacks[0].tabs.indexOf("backlinks")); render(); } }, bl + " backlink" + (bl === 1 ? "" : "s")));
			var txt = "";
			if (f.t) chainFrom(f.t, f.start).forEach(u => { txt += " " + u.question + " " + u.answer.join(" "); });
			if (f.n) (function walk(a) { a.forEach(o => { txt += " " + o.text; if (o.children) walk(o.children); }); })(f.n.outline);
			items.push(div("o-sbi", num(words(txt)) + " words"), div("o-sbi", num(plain(txt).length) + " characters"));
		}
		var tab = curTab();
		if (tab && tab.kind === "graph") { var m = graphModel(null); items.push(div("o-sbi", m.nodes.length + " nodes · " + m.edges.length + " links")); }
		items.push(h("div", { class: "o-sbi", title: "All notes are saved as Markdown files in " + VAULT.dir }, icon("cloud", 13), "Saved"));
		return div("o-statusbar", items);
	}

	/* ---------------- overlays: palette, menus, popovers */
	function overlays() {
		var out = [];
		if (S.palette) out.push(h("div", { class: "o-scrim", onclick: () => { S.palette = null; render(); } }), paletteEl());
		if (S.runsPop) out.push(runsPopEl());
		if (S.sel) out.push(selBarEl());
		out.push(div("o-menu-host"));
		out.push(div("o-pop-host"));
		if (S.notices.length) out.push(div("o-notices", S.notices.map(n => { return div("o-notice", n.msg); })));
		afterRender.push(() => { renderMenu(); renderPop(); });
		return out;
	}
	function showMenu(anchor, items, opts) {
		opts = opts || {};
		var r = relRect(anchor), x = r.x, y = r.y + r.h + 4;
		if (opts.at) { var rr = root.getBoundingClientRect(), s = scale(); x = (opts.at.clientX - rr.left) / s; y = (opts.at.clientY - rr.top) / s; }
		S.menu = { x, y, items, up: opts.up, ay: r.y };
		renderMenu();
	}
	function renderMenu() {
		var host = root.querySelector(".o-menu-host"); if (!host) return;
		host.replaceChildren();
		if (!S.menu) return;
		var m = S.menu;
		var el = h("div", { class: "o-menu", role: "menu" }, m.items.map(it => {
			if (it.sep) return div("o-msep");
			if (it.lab) return div("o-mlab", it.lab);
			return h("div", { class: "o-mi" + (it.dis ? " dis" : ""), role: "menuitem", onclick: () => { if (it.dis) return; S.menu = null; renderMenu(); if (it.action) it.action(); } },
				it.icon ? icon(it.icon, 14) : h("span", { style: "width:14px" }), it.sw ? h("i", { class: "o-sw o-mk " + it.sw }) : null, span(null, it.label), it.sub ? h("small", null, it.sub) : it.hint ? h("small", null, it.hint) : null);
		}));
		host.append(el);
		var w = el.offsetWidth, hh = el.offsetHeight;
		var x = Math.min(m.x, 1280 - w - 8), y = m.up ? m.ay - hh - 4 : Math.min(m.y, 800 - hh - 8);
		el.style.left = x + "px"; el.style.top = Math.max(8, y) + "px";
	}
	function hoverPreview(anchor, fid) {
		var f = fileInfo(fid); if (!f) return;
		var r = relRect(anchor);
		S.pop = { fid, x: r.x, y: r.y + r.h + 6 };
		clearTimeout(hoverPreview._t);
		hoverPreview._t = later(() => { if (S.pop && S.pop.fid === fid) renderPop(); }, 350);
	}
	function renderPop() {
		var host = root.querySelector(".o-pop-host"); if (!host) return;
		host.replaceChildren();
		if (!S.pop) return;
		var f = fileInfo(S.pop.fid); if (!f) return;
		var body = [h("b", null, f.title)];
		if (f.t) {
			var u = f.kind === "branch" ? f.u : f.start;
			body.push(h("div", { class: "o-row", style: "margin-bottom:8px" }, statusPill(f.kind === "thread" ? threadStatus(f.t) : u.status), h("span", { style: "color:var(--tx3);font-size:12px" }, PROV[u.provider].label + " · " + u.model + " · " + fmtDate(u.createdAt))));
			var rec = f.kind === "thread" ? f.t.recap : (u.recap || plain(u.answer[0] || ""));
			if (rec) body.push(h("div", { style: "color:var(--tx2)" }, trunc(plain(rec), 260)));
		} else if (f.n) body.push(h("ul", { style: "margin:0;padding-left:18px;color:var(--tx2)" }, f.n.outline.slice(0, 4).map(o => h("li", null, o.text))));
		var el = div("o-pop", body);
		host.append(el);
		var x = Math.min(S.pop.x, 1280 - 390), y = S.pop.y; if (y + el.offsetHeight > 790) y = S.pop.y - el.offsetHeight - 30;
		el.style.left = x + "px"; el.style.top = y + "px";
	}
	/* Status-bar popover: the focused run's trace, then everything running or waiting. */
	function runsPopEl() {
		var r = runsList(), u = S.runsPop.focus ? turnById(S.runsPop.focus) : null, el = h("div", { class: "o-runspop", onmousedown: e => e.stopPropagation() });
		if (u) {
			var t = thread(u.threadId);
			el.append(h("h4", null, "Trace"), div("o-rpf", h("b", null, u.title), statusPill(u.status)),
				div("o-hint", PROV[u.provider].label + " · " + u.model + (u.effort ? " · " + u.effort : "") + (u.durationSec ? " · " + fmtDur(u.durationSec) : "") + " · " + trunc(t.title, 40)),
				h("div", { class: "o-steps", "data-live-steps": u.id, style: "margin:4px 6px" }, stepRows(u.activity)),
				u.sources.length ? div("o-hint", "Sources: " + u.sources.map(x => x.domain).join(", ")) : null,
				u.status === "running" ? h("button", { class: "o-btn", style: "margin:4px 6px", onclick: () => stopRun(t, u) }, icon("stop", 12), "Stop") : null);
		}
		[["Needs you", r.attention], ["Running", r.running], ["Queued", r.queued]].forEach(x => { if (x[1].length) el.append(h("h4", null, x[0] + " · " + x[1].length), runItems(x[1], it => { S.runsPop = { focus: it.u.id }; openFile(noteOfTurn(it.t, it.u), { turn: it.u.id }); })); });
		return el;
	}

	/* Selection bar over answer text: Branch, Highlight, Extract, Copy link */
	function onSelect() {
		var sel = window.getSelection();
		if (!sel || sel.isCollapsed || !sel.rangeCount) { if (S.sel) { S.sel = null; renderSel(); } return; }
		var rng = sel.getRangeAt(0);
		var a = rng.startContainer.parentElement && rng.startContainer.parentElement.closest(".o-para"), b = rng.endContainer.parentElement && rng.endContainer.parentElement.closest(".o-para");
		if (!a || a !== b || !root.contains(a)) { if (S.sel) { S.sel = null; renderSel(); } return; }
		var text = sel.toString().trim(); if (text.length < 3) return;
		var u = turnById(a.getAttribute("data-turnid")), para = Number(a.getAttribute("data-para"));
		var raw = u.answer[para], quote = text, at = raw.indexOf(text);
		if (at < 0) { // rendered text lacks the backticks: find it in the raw Markdown with them stripped
			var map = [], bare = "";
			for (var ri = 0; ri < raw.length; ri++) if (raw[ri] !== "`") { map.push(ri); bare += raw[ri]; }
			var si = bare.indexOf(text);
			if (si >= 0) { at = map[si]; quote = raw.slice(at, map[si + text.length - 1] + 1); }
		}
		if (at >= 0) { var sp = snapSpan(raw, at, quote.length); quote = raw.slice(sp.i, sp.j); }
		var r = rng.getBoundingClientRect(), rr = root.getBoundingClientRect(), s = scale();
		S.sel = { turnId: u.id, para, quote, x: (r.left + r.width / 2 - rr.left) / s, y: (r.top - rr.top) / s - 6 };
		renderSel();
	}
	function renderSel() {
		var old = root.querySelector(".o-selbar"); if (old) old.remove();
		if (S.sel) root.querySelector(".o-app").append(selBarEl());
	}
	function selBarEl() {
		var s = S.sel, u = turnById(s.turnId), t = thread(u.threadId);
		var busy = u.status === "running";
		return h("div", { class: "o-selbar", style: "left:" + s.x + "px;top:" + s.y + "px", onmousedown: e => { e.preventDefault(); } },
			busy ? span("o-dis", "Wait for the answer to finish") : [
				h("button", { onclick: () => { S.sel = null; startBranch(t, u, s.para, s.quote); } }, icon("branch", 14), "Branch"),
				h("button", { onclick: () => { u.highlights.push({ id: uid("h"), paragraph: s.para, quote: s.quote, color: "amber", note: null, createdAt: D.now }); S.sel = null; window.getSelection().removeAllRanges(); render(); notice("Highlighted. Listed under Bookmarks › Highlights."); } }, icon("highlight", 14), "Highlight"),
				h("button", { onclick: () => { S.sel = null; extract(t, u, s.para, s.quote); } }, icon("extract", 14), "Extract"),
				h("button", { onclick: () => { S.sel = null; renderSel(); notice("Copied [[" + t.title + "#^p" + s.para + "]]"); } }, icon("link", 14), "Copy link")]);
	}

	/* ---------------- actions */
	function startBranch(t, u, para, quote) {
		if (t.archivedAt) { notice("Archived threads cannot branch. Unarchive first."); return; }
		var id = uid("pb");
		S.pending[id] = { id, threadId: t.id, turnId: u.id, para, quote: quote };
		openFile("pb:" + id, { split: true });
	}
	function extract(t, u, para, text) {
		var target = noteTargetForExtract();
		var x = { id: uid("x"), threadId: t.id, turnId: u.id, para: para || 0, text, title: trunc(plain(text).replace(/[.:,;]$/, ""), 52), path: threadPath(t).slice(0, 1), isNew: true };
		if (V === "b" && target) {
			S.appends[target.fid] = S.appends[target.fid] || []; S.appends[target.fid].push(x);
			S.extracted.push(Object.assign({}, x, { hidden: true }));
			S.extracted = S.extracted.filter(e => !e.hidden);
			afterRender.push(() => { var sc = root.querySelector('[data-sk^="doc:' + target.fid + '"]'); if (sc) sc.scrollTop = sc.scrollHeight; });
			render(); notice("Extracted into " + target.title + " as an embedded block.");
			later(() => { x.isNew = false; }, 1700);
			return;
		}
		S.extracted.push(x);
		openFile("x:" + x.id, { split: true });
		notice("Extracted to a new note. The answer keeps a ^p" + x.para + " block ID.");
		later(() => { x.isNew = false; }, 1700);
	}
	function removeTurn(t, u) { t.turns = t.turns.filter(x => x !== u); render(); }
	function newQuestion() {
		var fid = "nq:" + uid("q");
		var cur = curFid(), f = cur ? fileInfo(cur) : null;
		if (f && f.t) S.newWs = f.t.workspaceId; else if (f && f.n) S.newWs = f.n.workspaceId;
		var g = S.groups[S.fg]; g.tabs.splice(g.a + 1, 0, tabFile(fid)); g.a += 1; render();
	}
	function titleFrom(q) {
		var s = plain(q).replace(/\s+/g, " ").trim().replace(/[.?!]+$/, "");
		if (s.length <= 72) return s;
		return s.slice(0, 64).replace(/\s+\S*$/, "") + "\u2026";
	}
	function newThread(q, wsId, folderId) {
		var id = uid("ut"), now = new Date().toISOString();
		var t = { id, workspaceId: wsId, folderId, kind: "exchange", title: titleFrom(q), provider: S.agent.provider, model: S.agent.model, effort: S.agent.effort, status: "running", createdAt: now, updatedAt: now, lastViewedAt: now, unread: false, bookmarked: false, followed: false, archivedAt: null, recap: null, tags: [], links: [], rootTurnId: null, turns: [] };
		D.threads.unshift(t);
		var u = ask(t, null, q, "root");
		t.rootTurnId = u.id;
		revealInTree("th:" + t.id);
		return t;
	}
	function ask(t, parent, q, relation, anchor) {
		var now = new Date().toISOString();
		var busy = t.turns.some(x => x.status === "running" && S.runs[x.id] && noteOfTurn(t, x) === (parent ? noteOfTurn(t, parent) : null)) && relation === "followup";
		var u = { id: uid("u"), parentId: parent ? parent.id : null, relation, anchor: anchor || null, question: q, title: titleFrom(q), provider: S.agent.provider, model: S.agent.model, effort: S.agent.effort, status: busy ? "queued" : "running", createdAt: now, completedAt: null, durationSec: null, starred: false, recap: null, answer: [], error: null, sources: [], activity: [], highlights: [], threadId: t.id };
		if (busy) {
			// queue after the last turn in this note
			var chainLast = chainFrom(t, t.turns.find(x => x.id === noteStart(t, parent))).slice(-1)[0];
			u.parentId = chainLast.id;
		}
		t.turns.push(u);
		t.updatedAt = now;
		if (!busy) startRun(t, u);
		render();
		var nf = noteOfTurn(t, u);
		scrollToTurn(u.id); render();
		if (nf) { /* keep the view on the new question */ }
		return u;
	}
	function noteStart(t, u) { while (u && u.relation === "followup") { var pid = u.parentId; u = t.turns.find(x => x.id === pid); } return u ? u.id : t.rootTurnId; }
	var CANNED = {
		t1: [{ steps: [["think", "Planned: check the bounds check against the swap"], ["grep", "Searched code: load16_be_signed", "src/jit/** (2 matches)"], ["read", "Read src/jit/arm64/masm.rs", "lines 1180-1262"], ["run", "Ran cargo test -p kestrel-jit dataview_sweep", "300 passed"]],
			answer: ["Yes. `emit_dataview_load` checks `offset + 2 <= byteLength` before `load16_be_signed` runs, so a read that ends exactly at the buffer end never touches the next page. The swap and the sign extension then operate on a value already in a register.", "The sweep test covers it: offset 14 on a 16-byte buffer is the last valid halfword, and offset 15 throws `RangeError` before any load is emitted. No code change is needed."],
			sources: [{ url: "https://tc39.es/ecma262/#sec-getviewvalue", title: "ECMA-262: GetViewValue", domain: "tc39.es" }] },
			{ steps: [["read", "Read tests/dataview_int16_sweep.rs"], ["edit", "Edited tests/dataview_int16_sweep.rs", "+6"], ["run", "Ran cargo test -p kestrel-jit dataview_sweep", "301 passed"]],
			answer: ["Added `offset_15_throws_range_error` to `tests/dataview_int16_sweep.rs`. It creates a 16-byte buffer, calls `getInt16(15)` for both endiannesses and asserts a `RangeError` in the interpreter and the baseline JIT.", "The sweep now has 301 cases; all pass on the fixed commit, and the new case also passes on the parent commit, since the bounds check was never wrong."], sources: [] }],
		generic: [{ steps: [["think", "Planned: read the earlier answers in this note"], ["search", "Searched notes in this vault", "3 matches"], ["read", "Read the files cited in the note"], ["think", "Drafted the answer"]],
			answer: ["This is a simulated answer in the design mock. In the app, the agent's Markdown answer streams here, below the question, while the trace above lists each tool call as it happens.", "When the run finishes, the note is saved, the file explorer badge clears, and the answer can be highlighted, branched or extracted like any other passage."], sources: [] }]
	};
	function startRun(t, u) {
		var list = CANNED[t.id] || CANNED.generic;
		S.cannedN[t.id] = (S.cannedN[t.id] || 0) + 1;
		var c = list[(S.cannedN[t.id] - 1) % list.length];
		var run = { t0: Date.now(), phase: "tools", i: 0, words: (c.answer.join("\n\n")).split(/(\s+)/), w: 0, c: c };
		S.runs[u.id] = run;
		u.status = "running";
		function tick() {
			if (!S.runs[u.id] || u.status !== "running") return;
			if (run.phase === "tools") {
				if (run.i > 0) u.activity[run.i - 1].status = "ok";
				if (run.i < c.steps.length) { var st = c.steps[run.i]; u.activity.push({ kind: st[0], label: st[1], detail: st[2], ms: 300 + Math.round(hash(st[1]) * 2400), status: "running" }); run.i++; live(t, u); later(tick, 520); return; }
				run.phase = "answer"; live(t, u); later(tick, 120); return;
			}
			if (run.phase === "answer") {
				run.w = Math.min(run.words.length, run.w + 4);
				u.answer = run.words.slice(0, run.w).join("").split(/\n\n/);
				if (run.w >= run.words.length) { finishRun(t, u); return; }
				live(t, u); later(tick, 45);
			}
		}
		later(tick, 300);
	}
	function finishRun(t, u) {
		var run = S.runs[u.id];
		u.status = "done"; u.completedAt = new Date().toISOString(); u.durationSec = Math.round((Date.now() - run.t0) / 1000) || 1;
		u.sources = run.c.sources.slice(); u.answer = run.c.answer.slice();
		u.recap = trunc(plain(u.answer[0]), 140);
		delete S.runs[u.id];
		if (!t.recap) t.recap = u.recap;
		// start the next queued question in this note
		var q = t.turns.find(x => x.status === "queued" && x.parentId === u.id);
		if (q) startRun(t, q);
		render();
	}
	function stopRun(t, u) { delete S.runs[u.id]; u.status = "cancelled"; u.activity.forEach(s => { if (s.status === "running") s.status = "ok"; }); render(); notice("Stopped. The partial answer is kept."); }
	function retry(t, u) { u.status = "running"; u.error = null; u.answer = []; u.activity = []; startRun(t, u); render(); }
	/* Partial update of the streaming turn so typing and scroll are not disturbed. */
	function live(t, u) {
		root.querySelectorAll('[data-live-ans="' + u.id + '"]').forEach(el => { fillAnswer(el, t, u, null, el.classList.contains("o-msga")); });
		root.querySelectorAll('[data-live-steps="' + u.id + '"]').forEach(el => { el.replaceChildren.apply(el, stepRows(u.activity)); });
		root.querySelectorAll('[data-live-runtxt="' + u.id + '"]').forEach(el => { el.textContent = "Running · " + curStep(u) + " · " + elapsed(u); });
		root.querySelectorAll('[data-live-cans="' + u.id + '"]').forEach(el => { el.textContent = u.answer.length ? plain(u.answer.join(" ")) : curStep(u); });
		root.querySelectorAll('[data-live-csteps="' + u.id + '"]').forEach(el => { el.textContent = u.activity.length + " steps"; });
		var sb = root.querySelector("[data-sb-runtxt]");
 if (sb) sb.textContent = trunc(u.title, 26) + " · " + trunc(curStep(u), 34) + " · " + elapsed(u);
		var co = root.querySelector('[data-co="trace:' + u.id + '"] .o-coh > span'); if (co) co.textContent = "Run · " + u.activity.length + " steps";
		if (!root.querySelector('[data-live-ans="' + u.id + '"]') && !sb) render();
	}

	/* ---------------- palette + quick switcher */
	function commands() {
		var tab = curTab() || {};
		return [
			{ label: "Session: Ask a new question", hint: "⌘N", run: newQuestion },
			{ label: "Quick switcher: Open quick switcher", hint: "⌘O", run: () => openPalette("files") },
			{ label: "Graph view: Open graph view", hint: "⌘G", run: () => openView("graph") },
			{ label: "Graph view: Open local graph", run: () => { S.right.open = true; var st = S.right.stacks[S.right.stacks.length - 1]; if (st.tabs.indexOf("localgraph") < 0) st.tabs.push("localgraph"); st.a = st.tabs.indexOf("localgraph"); render(); } },
			{ label: "Canvas: Open this thread as a canvas", run: openCanvas },
			{ label: "Chat: Open chat bound to this note", run: () => { var f = curFid(); if (f && fileInfo(f).t) openChat(f); else notice("Open a thread note first."); } },
			{ label: "Editor: Toggle reading view", hint: "⌘E", run: () => { if (tab.kind === "file") { tab.mode = tab.mode === "read" ? "live" : "read"; render(); } } },
			{ label: "Editor: Toggle source mode", run: () => { if (tab.kind === "file") { tab.mode = tab.mode === "source" ? "live" : "source"; render(); } } },
			{ label: "Runs: Show runs that need attention", run: () => { S.left.open = true; S.left.tab = "runs"; render(); } },
			{ label: "Search: Search in all files", hint: "⇧⌘F", run: () => { S.left.open = true; S.left.tab = "search"; render(); } },
			{ label: "Bookmarks: Bookmark current note", run: () => { var f = curFid(); if (f && fileInfo(f).t) toggleBookmark(fileInfo(f).t.id); } },
			{ label: "Thread: Generate recap", run: () => notice("Recap regenerated.") },
			{ label: "Workspace: Split right", run: () => { var f = curFid(); if (f) openFile(f, { split: true }); } },
			{ label: "Vault: Create new vault", run: () => ctx.setVariant("e") },
			{ label: "Vault: Open sample vault", run: () => ctx.setVariant("a") }
		];
	}
	function openPalette(kind, arg) { S.palette = { kind, q: "", sel: 0, arg: arg }; S.menu = null; render(); }
	function paletteItems() {
		var p = S.palette, q = p.q.toLowerCase();
		function fuzzy(s) { s = s.toLowerCase(); var i = 0; for (var k = 0; k < s.length && i < q.length; k++) if (s[k] === q[i]) i++; return i === q.length; }
		function rank(list, key) { return !q ? list : list.filter(x => x[key].toLowerCase().indexOf(q) >= 0).concat(list.filter(x => x[key].toLowerCase().indexOf(q) < 0 && fuzzy(x[key]))); }
		if (p.kind === "cmd") return rank(commands(), "label");
		if (p.kind === "hlnote") return [];
		if (p.kind === "move") {
			var f = fileInfo(p.arg), t = f.t;
			var dests = [{ label: wsName(t.workspaceId) + " (no folder)", run: () => { t.folderId = null; t.archivedAt = null; render(); } }].concat(D.folders.filter(x => x.workspaceId === t.workspaceId).map(x => { return { label: wsName(x.workspaceId) + " / " + x.name, run: () => { t.folderId = x.id; t.archivedAt = null; revealInTree("th:" + t.id); render(); notice("Moved to " + x.name + "."); } }; }));
			return rank(dests, "label");

		}
		return rank(allFiles().map(fileInfo).filter(Boolean), "title").slice(0, 40).map(f => {
			return { label: f.title, path: f.path.join(" / "), icon: f.kind === "note" ? "list2" : f.kind === "branch" ? "branch" : "file", run: () => openFile(f.fid) };
		});
	}
	function paletteEl() {
		var p = S.palette, items = paletteItems();
		p.sel = Math.max(0, Math.min(p.sel, items.length - 1));
		var ph = p.kind === "cmd" ? "Type a command…" : p.kind === "move" ? "Move to folder…" : p.kind === "hlnote" ? "Note for this highlight (↵ to save)" : "Find or create a note…";
		return h("div", { class: "o-pal", role: "dialog", "aria-label": ph },
			h("input", { placeholder: ph, value: p.q, "data-fk": "pal", "data-autofocus": "", "data-select": p.kind === "hlnote" ? "" : null, oninput: e => { p.q = e.target.value; p.sel = 0; render(); },
				onkeydown: e => {
					if (e.key === "ArrowDown") { e.preventDefault(); p.sel++; render(); }
					else if (e.key === "ArrowUp") { e.preventDefault(); p.sel = Math.max(0, p.sel - 1); render(); }
					else if (e.key === "Enter") { e.preventDefault(); var it = items[p.sel]; S.palette = null; if (p.kind === "hlnote") { p.arg.note = p.q.trim() || null; render(); notice("Highlight note saved."); } else if (it) it.run(); else if (p.kind === "files" && p.q) { S.compose.nq = p.q; newQuestion(); } else render(); }
					else if (e.key === "Escape") { S.palette = null; render(); }
				} }),
			div("o-pl", items.length ? items.map((it, i) => {
				return h("div", { class: "o-pi" + (i === p.sel ? " sel" : ""), onmouseenter: () => { if (p.sel !== i) { p.sel = i; root.querySelectorAll(".o-pi").forEach((el, j) => { el.classList.toggle("sel", j === i); }); } }, onclick: () => { S.palette = null; it.run(); } },
					it.icon ? icon(it.icon, 15) : null,
					span("o-tt", it.label), it.path ? h("small", null, it.path) : null, it.hint ? h("kbd", null, it.hint) : null);
			}) : h("div", { class: "o-pi", style: "color:var(--tx3)" }, p.kind === "hlnote" ? "The note is shown when you hover the highlight and under Bookmarks › Highlights." : p.kind === "files" ? "No note matches. Press ↵ to ask this as a new question." : "No matching command.")),
			div("o-pf", span(null, h("b", null, "↑↓"), " to navigate"), span(null, h("b", null, "↵"), " to use"), span(null, h("b", null, "esc"), " to dismiss")));
	}

	/* ---------------- root listeners */
	function onKey(e) {
		var mod = e.metaKey || e.ctrlKey;
		if (e.key === "Escape") { if (S.palette || S.menu || S.runsPop || S.sel) { S.palette = null; S.menu = null; S.runsPop = null; S.sel = null; render(); } return; }
		if (!mod) return;
		var k = e.key.toLowerCase();
		if (k === "p") { e.preventDefault(); openPalette("cmd"); }
		else if (k === "o") { e.preventDefault(); openPalette("files"); }
		else if (k === "g") { e.preventDefault(); openView("graph"); }
		else if (k === "n") { e.preventDefault(); newQuestion(); }
		else if (k === "e") { e.preventDefault(); var t = curTab(); if (t && t.kind === "file") { t.mode = t.mode === "read" ? "live" : "read"; render(); } }
		else if (k === "f" && e.shiftKey) { e.preventDefault(); S.left.open = true; S.left.tab = "search"; render(); }
	}
	function onDown(e) {
		if (S.menu && !e.target.closest(".o-menu")) { S.menu = null; renderMenu(); }
		if (S.runsPop && !e.target.closest(".o-runspop, .o-statusbar, .o-macts")) { S.runsPop = null; render(); }
		if (S.sel && !e.target.closest(".o-selbar")) { S.sel = null; renderSel(); }
	}
	function onUp(e) { if (e.target.closest && e.target.closest(".o-ans")) setTimeout(onSelect, 0); }
	root.addEventListener("keydown", onKey);
	root.addEventListener("mousedown", onDown);
	root.addEventListener("mouseup", onUp);
	root.tabIndex = -1;

	render();
	try { root.focus({ preventScroll: true }); } catch (e) { /* ignore */ }

	return function cleanup() {
		timers.forEach(clearTimeout); timers.clear();
		root.removeEventListener("keydown", onKey);
		root.removeEventListener("mousedown", onDown);
		root.removeEventListener("mouseup", onUp);
		root.replaceChildren();
	};
}
})();
