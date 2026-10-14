// The document a widget frame loads, and its response policy
// (`11-artifacts-and-browser.md` §3). Ported from the desktop's widget page
// (`src-tauri/src/file_server.rs`: `render_widget_page`, `widget_csp` and the
// `WIDGET_*` scripts), whose scripts the client's frame bridge expects.
//
// Two pages per widget:
//
// - the static page shows the widget's sanitized markup and CSS. Its CSP
//   admits only Session's navigation guard and height reporter, by hash, so
//   no widget script, event handler or `javascript:` URL runs.
// - the run page shows the widget's HTML as written and admits inline
//   scripts. It is served only while widget scripts are allowed
//   (`artifacts/site.ts`) and only after the reader asks for it.
//
// Both are sandboxed twice: the response CSP's `sandbox allow-scripts` and
// the client iframe's `sandbox="allow-scripts"`, neither with
// `allow-same-origin`, so the document's origin is opaque. It has no cookies
// or storage, cannot read the app's DOM, cannot navigate the top-level page,
// open windows or submit forms, and its network access is closed by
// `connect-src 'none'`, `form-action 'none'` and `default-src 'none'`.

import { createHash } from "node:crypto";

export type WidgetPageMode = "static" | "run";

/**
 * Reports the page's content height to the embedding answer, which sizes its
 * frame to fit (the desktop's `WIDGET_HEIGHT_SCRIPT`). Content sized from the
 * viewport stops growing at the frame height; reports are throttled to one
 * per 250 ms, and content whose height keeps reversing is followed only
 * upwards after three reversals within two seconds.
 */
const WIDGET_HEIGHT_SCRIPT = `(()=>{let h=-1,gap=-1,repeats=0,cap=Infinity,floor=0,dir=0,flips=[],last=0,timer=0;const send=()=>{timer=0;const b=document.body;if(!b)return;const vh=innerHeight;let n=Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height));if(n>vh&&vh===h&&n-vh===gap){if(++repeats>=2)cap=Math.min(cap,vh)}else{repeats=0}gap=n>vh?n-vh:-1;n=Math.max(Math.min(n,cap),floor);if(n===h)return;const d=n>h?1:-1,t=Date.now();if(h>=0&&dir&&d!==dir){flips=flips.filter((x)=>t-x<2000);flips.push(t);if(flips.length>=3){floor=Math.max(h,n);n=floor}}dir=d;if(n===h)return;h=n;last=t;parent.postMessage({type:'session-widget-height',height:n},'*')};const queue=()=>{if(!timer)timer=setTimeout(send,Math.max(0,250-(Date.now()-last)))};const start=()=>{new ResizeObserver(queue).observe(document.body);send()};if(document.body)start();else document.addEventListener('DOMContentLoaded',start);addEventListener('load',queue)})();`;

/**
 * Runs first on both pages (the desktop's `WIDGET_NAVIGATION_GUARD_SCRIPT`):
 * cancels link activations whose target is not a `#fragment`, answers the
 * embedding answer's liveness pings through the parent captured at startup,
 * and reports `pagehide`. A document that replaced the widget page does not
 * answer pings, and the answer then removes the frame.
 */
const WIDGET_NAVIGATION_GUARD_SCRIPT = `(()=>{const p=parent;addEventListener('pagehide',()=>p.postMessage({type:'session-widget-unload'},'*'));addEventListener('message',(e)=>{const d=e.data;if(e.source===p&&d&&d.type==='session-widget-ping')p.postMessage({type:'session-widget-pong',id:d.id},'*')});const local=(h)=>typeof h==='string'&&h.trim().startsWith('#');addEventListener('click',(e)=>{const t=e.target;const a=t&&t.closest?t.closest('a[href],a[*|href],area[href]'):null;if(a&&!local(a.getAttribute('href')))e.preventDefault()},true)})();`;

/** Run page only: `window.sessionWidgetState`, the saved-input bridge the
 * agent guidance documents (the desktop's `WIDGET_STATE_SCRIPT`). */
const WIDGET_STATE_SCRIPT = `(()=>{const p=parent;let restored=false,value=null;const listeners=new Set();Object.defineProperty(window,'sessionWidgetState',{value:Object.freeze({save:(value)=>p.postMessage({type:'session-widget-state-save',value},'*'),onRestore:(fn)=>{if(typeof fn!=='function')return()=>{};listeners.add(fn);if(restored)fn(value);return()=>listeners.delete(fn)}}),writable:false,configurable:false});addEventListener('message',(e)=>{if(e.source!==p||!e.data||e.data.type!=='session-widget-state-restore')return;value=e.data.value;restored=true;for(const fn of listeners)try{fn(value)}catch{}});p.postMessage({type:'session-widget-state-ready'},'*')})();`;

/**
 * Run page only, before any widget script: removes the WebRTC constructors
 * from the widget's global object (the desktop's `WIDGET_PRELUDE_SCRIPT`).
 * Peer-connection traffic is outside every CSP directive. This does not
 * reach the globals of a child frame the widget creates; see
 * `11-artifacts-and-browser.md` §3 for that residual.
 */
const WIDGET_PRELUDE_SCRIPT = `(()=>{for(const n of["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCIceTransport","RTCSctpTransport","RTCDtlsTransport","RTCRtpSender","RTCRtpReceiver","RTCRtpTransceiver","RTCSessionDescription","RTCIceCandidate"])try{Object.defineProperty(window,n,{value:undefined,writable:false,configurable:false})}catch(e){}})();`;

/** Run page only: a generic notice when a widget script throws or a resource
 * fails to load (the desktop's `WIDGET_ERROR_SCRIPT`). */
const WIDGET_ERROR_SCRIPT = `(()=>{const reveal=(m)=>{let n=document.getElementById('session-visualization-error');if(!n){if(!document.body)return;n=document.createElement('div');n.id='session-visualization-error';n.className='session-visualization-error';n.setAttribute('role','alert');document.body.prepend(n)}n.textContent=m;n.hidden=false};addEventListener('error',(e)=>reveal(e.target===window?'This widget encountered an error.':'This widget could not load one of its resources.'),true);addEventListener('unhandledrejection',()=>reveal('This widget encountered an error.'))})();`;

/** The desktop's widget wrapper stylesheet (`CODEX_INLINE_VIS_CSS` with
 * `WIDGET_PAGE_CSS`): theme tokens for both schemes, the system font, and
 * the utility classes widgets may use. */
const WIDGET_PAGE_CSS = [
  ":root { color-scheme: light dark; --font-size-base: 14px; --background: #f7f8f7; --foreground: #1d2421; --card: #ffffff; --card-foreground: #1d2421; --popover: #ffffff; --popover-foreground: #1d2421; --primary: #26322d; --primary-foreground: #ffffff; --secondary: #e8eeeb; --secondary-foreground: #1d2421; --muted: #edf1ef; --muted-foreground: #5e6d66; --accent: #e1e9e5; --accent-foreground: #1d2421; --destructive: #a63d40; --border: #ccd6d1; --input: #aebcb5; --ring: #42554c; --viz-series-1: #187a54; --viz-series-2: #8a5d15; --viz-series-3: #496aa0; --viz-series-4: #8a4e86; --viz-series-5: #ad4e35; --viz-series-6: #4f7777; }",
  "@media (prefers-color-scheme: dark) { :root { --background: #111514; --foreground: #e5e9e7; --card: #181d1b; --card-foreground: #e5e9e7; --popover: #202624; --popover-foreground: #e5e9e7; --primary: #d7dfdb; --primary-foreground: #111514; --secondary: #29302d; --secondary-foreground: #e5e9e7; --muted: #242b28; --muted-foreground: #99a49f; --accent: #303936; --accent-foreground: #eef2f0; --destructive: #d06b6b; --border: #36403c; --input: #46514c; --ring: #a9b8b1; --viz-series-1: #8fd5b6; --viz-series-2: #d8b77a; --viz-series-3: #8eacd8; --viz-series-4: #c595c2; --viz-series-5: #df927d; --viz-series-6: #8eb8b8; } }",
  "* { box-sizing: border-box; }",
  "html, body { min-height: 0; }",
  "body { margin: 0; padding: 16px; overflow-wrap: anywhere; color: var(--foreground); background: var(--background); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: var(--font-size-base); font-variant-ligatures: no-common-ligatures; }",
  "button, input, select, textarea { font: inherit; }",
  "svg, canvas, img { max-width: 100%; }",
  ".card { border: 1px solid var(--border); border-radius: 10px; color: var(--card-foreground); background: var(--card); }",
  ".viz-row, .viz-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }",
  ".viz-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: 10px; }",
  ".viz-stat { padding: 12px; }",
  ".viz-stat-value { color: var(--foreground); font-size: 1.4em; font-weight: 500; }",
  ".viz-badge { display: inline-flex; align-items: center; min-height: 22px; padding: 2px 7px; border-radius: 999px; color: var(--accent-foreground); background: var(--accent); }",
  ".btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 30px; padding: 5px 10px; border: 1px solid var(--border); border-radius: 7px; color: var(--secondary-foreground); background: var(--secondary); cursor: pointer; }",
  ".btn:not(:disabled):hover { border-color: var(--input); background: var(--accent); }",
  ".btn-primary { border-color: var(--primary); color: var(--primary-foreground); background: var(--primary); }",
  ".btn-ghost { border-color: transparent; color: var(--muted-foreground); background: transparent; }",
  ".btn-block { width: 100%; }",
  ".btn:disabled { cursor: not-allowed; opacity: 0.4; }",
  ".viz-tile { width: 100%; min-height: 52px; }",
  ".form-label { display: block; margin-bottom: 6px; color: var(--foreground); }",
  ".form-control, .form-select { display: block; width: 100%; min-height: 30px; padding: 4px 8px; border: 1px solid var(--input); border-radius: 7px; color: var(--foreground); background: var(--secondary); }",
  ".form-check { display: flex; align-items: center; gap: 7px; }",
  ".table-responsive { width: 100%; overflow-x: auto; }",
  ".table { width: 100%; border-collapse: collapse; }",
  ".table th, .table td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; }",
  ".table-sm th, .table-sm td { padding: 5px 7px; }",
  ".text-small { font-size: max(11px, 0.85em); }",
  ".text-muted { color: var(--muted-foreground); }",
  ".text-destructive { color: var(--destructive); }",
  ".text-end { text-align: end !important; font-variant-numeric: tabular-nums; }",
  ".text-center { text-align: center !important; }",
  ".text-nowrap { white-space: nowrap; }",
  ".sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }",
  ".session-visualization-error { margin: 0 0 12px; padding: 9px 11px; border: 1px solid color-mix(in srgb, var(--destructive) 60%, var(--border)); border-radius: 7px; color: var(--foreground); background: color-mix(in srgb, var(--destructive) 12%, var(--background)); }",
  ".session-visualization-error[hidden] { display: none; }",
  "[data-lucide] { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; font-style: normal; }",
  "[data-lucide]:empty::before { content: '\\25c7'; font-size: 11px; }",
  ":focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }",
].join(" ");

/** Session's scripts on each page, in order. The guard comes first, before
 * any widget code can register a listener. */
const PAGE_SCRIPTS: Record<WidgetPageMode, readonly string[]> = {
  static: [WIDGET_NAVIGATION_GUARD_SCRIPT, WIDGET_HEIGHT_SCRIPT],
  run: [
    WIDGET_NAVIGATION_GUARD_SCRIPT,
    WIDGET_PRELUDE_SCRIPT,
    WIDGET_STATE_SCRIPT,
    WIDGET_ERROR_SCRIPT,
    WIDGET_HEIGHT_SCRIPT,
  ],
};

function scriptHashSource(script: string): string {
  return `'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`;
}

/**
 * A widget page: Session's stylesheet and scripts in `<head>`, ahead of the
 * widget's markup, which is the whole `<body>`. The static caller passes
 * sanitized markup; the run caller passes the widget's HTML with
 * `http-equiv` renamed. Written without whitespace between elements so the
 * static page is a parse/serialize fixed point (`renderStaticWidget`).
 */
export function widgetPage(body: string, mode: WidgetPageMode): string {
  const scripts = PAGE_SCRIPTS[mode].map((script) => `<script>${script}</script>`).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Widget</title><style>${WIDGET_PAGE_CSS}</style>${scripts}</head><body>${body}</body></html>`;
}

/**
 * The response CSP of a widget page. No network: `default-src 'none'` (which
 * also covers frames, workers and manifests), `connect-src 'none'`,
 * `form-action 'none'`, and passive resources from `data:`/`blob:` only. The
 * static page admits only Session's hashed scripts; the run page admits inline
 * scripts. `sandbox allow-scripts` keeps the document in an opaque origin even
 * if the page is ever loaded outside the app's sandboxed frame, and
 * `frame-ancestors` names the app as the only page that may frame it.
 */
export function widgetPagePolicy(mode: WidgetPageMode, appOrigin: string): string {
  const scripts =
    mode === "static" ? PAGE_SCRIPTS.static.map(scriptHashSource).join(" ") : "'unsafe-inline'";
  return [
    "default-src 'none'",
    `script-src ${scripts}`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${appOrigin}`,
    "sandbox allow-scripts",
  ].join("; ");
}

/** Browser features disabled for the widget page and anything it embeds (the
 * desktop's `WIDGET_PERMISSIONS_POLICY`). */
export const WIDGET_PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), payment=(), midi=(), clipboard-read=(), clipboard-write=(), fullscreen=(), screen-wake-lock=(), publickey-credentials-get=(), gyroscope=(), accelerometer=(), magnetometer=()";

/** Renames every `http-equiv` attribute to `data-http-equiv`, ASCII
 * case-insensitively (the desktop's `neutralize_http_equiv`), so a
 * `<meta http-equiv="refresh">` cannot navigate the run page and no other
 * pragma applies. */
export function neutralizeHttpEquiv(html: string): string {
  return html.replace(/http-equiv/giu, (match) => `data-${match}`);
}
