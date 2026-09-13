import { renderToStaticMarkup } from "react-dom/server";

const GITHUB_URL = "https://github.com/aka-com/session";
const RELEASES_URL = `${GITHUB_URL}/releases/latest`;
const SITE_TITLE = "Session — Agent research workspace";
const SITE_DESCRIPTION =
  "Session is a focused macOS workspace for branching research with Claude Code, Codex, and Grok.";

const FEATURES = [
  ["Branch any answer", "Follow a promising lead without losing the question, sources, or reasoning that brought you there."],
  ["Keep durable research", "Organize conversations, documents, highlights, notes, and sources in one navigable tree."],
  ["Work with your agents", "Run focused research with Claude Code, Codex, or Grok while Session preserves the structure around it."],
  ["Keep sources close", "Open sources beside your work and collect the evidence that supports each branch."],
] as const;

const CSS = String.raw`
@font-face{font-family:"DM Sans";src:url("/fonts/DMSans-Variable-Latin.woff2") format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Valley Sans";src:url("/fonts/ValleySans-Variable.woff2") format("woff2");font-weight:100 900;font-display:swap}
:root{color-scheme:light dark;font-family:"DM Sans",system-ui,sans-serif;color:#17201d;background:#f3f1eb;font-synthesis:none}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;min-width:320px}a{color:inherit}
.skip-link{position:fixed;top:12px;left:12px;z-index:10;padding:9px 12px;border-radius:8px;background:#17201d;color:#fff;transform:translateY(-160%)}.skip-link:focus{transform:translateY(0)}
.page{min-height:100vh;background:radial-gradient(circle at 75% 10%,rgba(159,198,180,.38),transparent 30rem),linear-gradient(180deg,#f8f6f0 0%,#eeece5 100%)}
.site-header,.hero,.features,.agents,.site-footer{width:min(1120px,calc(100% - 48px));margin-inline:auto}
.site-header{display:flex;align-items:center;justify-content:space-between;padding:24px 0}.brand{display:inline-flex;align-items:center;gap:10px;font:650 20px/1 "Valley Sans","DM Sans",sans-serif;text-decoration:none}.brand img{border-radius:9px}
.site-nav{display:flex;align-items:center;gap:24px}.site-nav a{font-size:14px;text-decoration:none}.download-link{padding:9px 14px;border:1px solid rgba(23,32,29,.18);border-radius:999px;background:rgba(255,255,255,.45)}
.hero{display:grid;grid-template-columns:minmax(0,.9fr) minmax(440px,1.1fr);align-items:center;gap:72px;min-height:680px;padding:72px 0 112px}.eyebrow{margin:0 0 18px;color:#517063;font-size:12px;font-weight:750;letter-spacing:.14em;text-transform:uppercase}
h1{max-width:690px;margin:0;font:650 clamp(54px,7vw,88px)/.94 "Valley Sans","DM Sans",sans-serif;letter-spacing:-.05em}.hero-copy{max-width:590px;margin:28px 0 32px;color:#58615e;font-size:19px;line-height:1.55}.hero-actions{display:flex;flex-wrap:wrap;gap:12px}
.button{display:inline-flex;align-items:center;justify-content:center;min-height:45px;padding:0 18px;border:1px solid #17201d;border-radius:10px;font-size:14px;font-weight:650;text-decoration:none}.button.primary{background:#17201d;color:#fff}.button.secondary{background:rgba(255,255,255,.45)}
.research-card{position:relative;min-height:470px;overflow:hidden;border:1px solid rgba(23,32,29,.14);border-radius:22px;background:rgba(255,255,255,.72);box-shadow:0 28px 70px rgba(49,60,55,.13)}
.window-bar{display:flex;align-items:center;gap:7px;height:42px;padding:0 16px;border-bottom:1px solid rgba(23,32,29,.1)}.window-dot{width:9px;height:9px;border-radius:50%;background:#c8cdc9}.window-title{margin-left:8px;color:#727b77;font-size:12px}
.research-body{display:grid;grid-template-columns:170px 1fr;min-height:428px}.research-tree{padding:20px 14px;border-right:1px solid rgba(23,32,29,.1);background:rgba(239,241,237,.68)}.tree-label{margin:0 7px 13px;color:#89908d;font-size:10px;text-transform:uppercase;letter-spacing:.1em}.tree-item{margin:3px 0;padding:8px 9px;border-radius:7px;color:#66706c;font-size:11px}.tree-item.active{background:#dbe8e0;color:#234c3b;font-weight:650}.tree-item.child{margin-left:13px}
.document{padding:44px 42px}.document-kicker{color:#6d8c7f;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.document h2{margin:11px 0 24px;font:650 31px/1.1 "Valley Sans","DM Sans",sans-serif;letter-spacing:-.025em}.document p{margin:0 0 15px;color:#65706c;font-size:13px;line-height:1.55}.source{margin-top:24px;padding:14px 15px;border:1px solid rgba(46,88,70,.16);border-radius:10px;background:#eef5f0;color:#355a4a;font-size:11px}
.section-heading{max-width:700px;margin:0 0 50px}.section-heading h2{margin:0 0 14px;font:650 clamp(34px,5vw,54px)/1 "Valley Sans","DM Sans",sans-serif;letter-spacing:-.035em}.section-heading p{margin:0;color:#626c68;font-size:17px;line-height:1.5}
.features{padding:108px 0;border-top:1px solid rgba(23,32,29,.12)}.feature-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}.feature{min-height:190px;padding:28px;border:1px solid rgba(23,32,29,.11);border-radius:16px;background:rgba(255,255,255,.42)}.feature span{color:#87a096;font-size:12px;font-weight:700}.feature h3{margin:34px 0 9px;font-size:20px}.feature p{margin:0;color:#68716e;font-size:14px;line-height:1.55}
.agents{padding:96px 0;text-align:center}.agents h2{margin:0 0 12px;font:650 38px/1.1 "Valley Sans","DM Sans",sans-serif}.agents p{margin:0 auto 28px;color:#626c68}.agent-list{display:flex;justify-content:center;flex-wrap:wrap;gap:10px}.agent-list span{padding:10px 16px;border:1px solid rgba(23,32,29,.12);border-radius:999px;background:rgba(255,255,255,.5);font-size:14px}
.site-footer{display:flex;justify-content:space-between;padding:30px 0 38px;border-top:1px solid rgba(23,32,29,.12);color:#69726f;font-size:13px}.footer-links{display:flex;gap:20px}
@media(max-width:820px){.hero{grid-template-columns:1fr;gap:50px;padding-top:60px}.research-card{min-height:400px}.research-body{grid-template-columns:130px 1fr;min-height:358px}.document{padding:34px 26px}}
@media(max-width:560px){.site-header,.hero,.features,.agents,.site-footer{width:min(100% - 28px,1120px)}.site-nav a:first-child{display:none}.site-nav{gap:12px}.hero{min-height:auto;padding:70px 0 84px}h1{font-size:51px}.research-body{grid-template-columns:1fr}.research-tree{display:none}.feature-grid{grid-template-columns:1fr}.site-footer{flex-direction:column;gap:18px}}
@media(prefers-color-scheme:dark){:root{color:#e8ece9;background:#111512}.page{background:radial-gradient(circle at 75% 10%,rgba(52,90,73,.3),transparent 30rem),#151916}.hero-copy,.section-heading p,.feature p,.agents p,.site-footer{color:#a5ada9}.download-link,.button.secondary,.feature,.agent-list span{background:rgba(255,255,255,.035);border-color:rgba(255,255,255,.13)}.button{border-color:#e8ece9}.button.primary{background:#e8ece9;color:#17201d}.research-card{background:rgba(27,33,29,.94);border-color:rgba(255,255,255,.12)}.window-bar,.research-tree{border-color:rgba(255,255,255,.1)}.research-tree{background:rgba(17,22,19,.74)}.tree-item{color:#99a19d}.tree-item.active{background:#294438;color:#d8e7df}.document p{color:#a8b0ac}.source{background:#22352c;border-color:#355244;color:#b9d0c4}.features,.site-footer{border-color:rgba(255,255,255,.12)}}
`;

function SiteHeader() {
  return <header className="site-header"><a className="brand" href="/" aria-label="Session home"><img src="/logo.png" alt="" width={32} height={32} decoding="async" /><span>Session</span></a><nav className="site-nav" aria-label="Main navigation"><a href="#features">Features</a><a href={GITHUB_URL}>GitHub</a><a className="download-link" href={RELEASES_URL}>Download</a></nav></header>;
}

function ResearchPreview() {
  return <div className="research-card" aria-label="Session research workspace preview"><div className="window-bar"><span className="window-dot" /><span className="window-dot" /><span className="window-dot" /><span className="window-title">Session · Research</span></div><div className="research-body"><aside className="research-tree"><p className="tree-label">Research</p><div className="tree-item active">Market landscape</div><div className="tree-item child">Primary sources</div><div className="tree-item child">Open questions</div><div className="tree-item">Architecture notes</div><div className="tree-item">Reading queue</div></aside><article className="document"><span className="document-kicker">Research document</span><h2>How is the market changing?</h2><p>The strongest signal appears in three independent sources. Each points to the same shift, but for a different reason.</p><p>Branch from this answer to test the competing explanations while the original evidence stays in place.</p><div className="source">3 sources · 2 highlights · Updated just now</div></article></div></div>;
}

export function LandingPage() {
  return <div className="page"><SiteHeader /><main id="main"><section className="hero"><div><p className="eyebrow">A focused workspace for agent research</p><h1>Research that keeps its context.</h1><p className="hero-copy">Session turns long conversations into durable, branching research. Ask, read, collect sources, and follow new directions without losing the path behind you.</p><div className="hero-actions"><a className="button primary" href={RELEASES_URL}>Download for macOS</a><a className="button secondary" href={GITHUB_URL}>View source</a></div></div><ResearchPreview /></section><section className="features" id="features" aria-labelledby="features-heading"><div className="section-heading"><h2 id="features-heading">A home for work that grows.</h2><p>Session keeps the question, the evidence, and every useful branch together as your research develops.</p></div><div className="feature-grid">{FEATURES.map(([title, copy], index) => <article className="feature" key={title}><span>0{index + 1}</span><h3>{title}</h3><p>{copy}</p></article>)}</div></section><section className="agents" aria-labelledby="agents-heading"><h2 id="agents-heading">Bring the agent you trust.</h2><p>Start research with the tools already installed on your Mac.</p><div className="agent-list" aria-label="Supported research agents"><span>Claude Code</span><span>Codex</span><span>Grok</span></div></section></main><footer className="site-footer"><span>&copy; 2026 Session</span><div className="footer-links"><a href={GITHUB_URL}>GitHub</a><a href={RELEASES_URL}>Download</a><span>MIT License</span></div></footer></div>;
}

function LandingDocument({ origin }: { origin: string }) {
  const canonical = `${origin}/`;
  return <html lang="en"><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="theme-color" media="(prefers-color-scheme: light)" content="#f3f1eb" /><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#111512" /><title>{SITE_TITLE}</title><meta name="description" content={SITE_DESCRIPTION} /><link rel="canonical" href={canonical} /><meta property="og:type" content="website" /><meta property="og:site_name" content="Session" /><meta property="og:title" content={SITE_TITLE} /><meta property="og:description" content={SITE_DESCRIPTION} /><meta property="og:url" content={canonical} /><meta property="og:image" content={`${origin}/logo.png`} /><meta name="twitter:card" content="summary" /><link rel="icon" type="image/png" href="/logo.png" /><link rel="preload" href="/fonts/ValleySans-Variable.woff2" as="font" type="font/woff2" crossOrigin="anonymous" /><link rel="preload" href="/fonts/DMSans-Variable-Latin.woff2" as="font" type="font/woff2" crossOrigin="anonymous" /><style>{CSS}</style></head><body><a className="skip-link" href="#main">Skip to content</a><LandingPage /></body></html>;
}

let cached: { origin: string; html: string } | null = null;

export function renderLandingPage(origin: string) {
  if (cached?.origin === origin) return cached.html;
  const html = `<!doctype html>${renderToStaticMarkup(<LandingDocument origin={origin} />)}`;
  cached = { origin, html };
  return html;
}
