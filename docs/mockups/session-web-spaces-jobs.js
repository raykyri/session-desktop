/* Session mock API: what a run writes (step 7). The answers, token counts and failure summaries of the mock
   agent, used by the jobs in session-web-spaces-mock-api.js (section 6a).

   Loaded with a plain <script src> after session-web-spaces-fixtures.js and before
   session-web-spaces-mock-api.js; defines one global, SessionJobs. Pure functions of the stored records: no
   page code, no DOM. The page reads STEP_TOK (tokens so far at each progress step) and SOURCES (the web
   sources each space's answers cite) from here.

   g(k) below is a collection of the database as the server stores it (tx.get in a transaction).

   TODO(limits): token usage is a stub (owner decision: no backend limit tracking). src, payer, keyName and
   stopSum are the page's token-model arithmetic (tmSrc, tmPayer, tmKeyName, tmStopSum) moved here, not
   redesigned: the included tokens pay first, then the default key. */
(function () {
  'use strict';

  /* ---- progress steps: a run has four, and these are the tokens it has used when each starts ---- */
  const STEP_TOK = [3e3, 9e3, 18e3, 31e3];
  const STEPS = STEP_TOK.length;
  /* what each step's committed turn records (research.turn.committed): the agent's tool call */
  const STEP_TOOLS = [
    ['plan', q => ({ question: q, searches: 4 })],
    ['web_search', (q, s) => ({ query: q, space: s })],
    ['read_sources', () => ({ count: 9 })],
  ];

  /* ---- text helpers (copies of the page's) ---- */
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clip = (t, n = 150) => t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + '…' : t;
  const htmlText = h => String(h || '').replace(/<sup[^>]*>.*?<\/sup>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const isVer = s => !!(s && s.dom && s.dom.state === 'ok');
  const spName = s => isVer(s) && s.plain ? esc(s.title) : '#' + s.name;

  /* ---- the web sources each space's answers cite ---- */
  const SOURCES = {
    public: ['wikipedia.org', 'archive.org', 'gov.uk'], scifi: ['isfdb.org', 'tor.com', 'sf-encyclopedia.com'], markets: ['bis.org', 'sec.gov', 'ssrn.com'],
    ml: ['arxiv.org', 'openreview.net', 'paperswithcode.com'], bio: ['ncbi.nlm.nih.gov', 'nature.com'], history: ['archive.org', 'jstor.org'],
    climate: ['iea.org', 'eurostat.ec.europa.eu'], urbanism: ['houstontx.gov', 'citylab.com'], math: ['arxiv.org', 'mathoverflow.net'],
    sablefield: ['docs.sablefield.dev', 'help.sablefield.dev', 'sablefield.dev'],
    replication: ['arxiv.org', 'osf.io', 'github.com'], northwind: ['postgresql.org', 'aws.amazon.com', 'cloud.google.com'], grants: ['osf.io', 'cos.io', 'ukri.org'], ward7: ['codelibrary.amlegal.com', 'hud.gov'],
  };
  /* the answer to a new sync-rule ask in #sablefield */
  const SF_HTML = `<p>Declare the rule with <code>scope: user</code> and filter on the owner column with <code>auth.user_id()</code>. Clients then receive only the rows where the filter matches the signed-in user. <sup class="cite">1</sup></p>
<pre><code>rule "my_notes" {
  scope: user
  query: select * from notes where owner_id = auth.user_id()
}</code></pre>
<p>Deploy with <code>sable rules deploy</code>. If the filter is missing, the deploy fails with <code>E_SYNC_SCOPE</code>. <sup class="cite">2</sup></p>`;
  /* answers to asks about answers (ask trees): one for a question about wording, one for an ask that compares
     two answers, and a sample for the others */
  const QT_CANNED = {
    wording: `<p>Only indirect evidence. Platforms that publish resolution histories report fewer disputes after they adopted templates for common question types, such as elections and economic releases. None has published a comparison with a control group, and disputes also fell as moderators gained experience, so the effect of wording alone is not measured.</p>`,
    both: `<p>The two branches answer different parts of the same problem. The worked example shows that a fixed void payout moves the price (0.58 instead of 0.6), and a trader who expects fewer voids earns about 2.6% before fees. The side-market branch shows a way to price the void directly, but such markets exist only on user-created platforms and are thinly traded. Together they suggest that on regulated venues, void risk stays mixed into the main price.</p>`,
    generic: `<p>Sample answer for this mock. The agent answers with the context shown in the composer, and lists its sources below the answer.</p>`,
  };

  /* ---- sources asked about: passage labels and citation markers ---- */
  const miRefs = p => !p.about ? [] : p.about.its ? p.about.its : [p.about.it];
  const mediaOf = (g, id) => g('media').find(m => m.id === id) || g('miAdded').find(m => m.id === id);
  const miTitle = m => { if (m.t) return m.t; const p = m.body[0].p || `Post by ${m.h}`, s1 = (p.match(/^.+?[.?!](?=\s|$)/) || [p])[0]; return s1.length <= 110 ? s1 : clip(p, 90); };
  function miLbl(m, i) {
    const b = m.body[i]; if (!b) return '';
    if (b.ts) return b.ts;
    const n = m.body.slice(0, i + 1).filter(x => !x.h).length;
    return m.kind === 'thread' ? `${n}/${m.body.length}` : '¶' + n;
  }
  const miLblLong = (m, i) => { const b = m.body[i]; return b.ts ? b.ts : m.kind === 'thread' ? `post ${miLbl(m, i).split('/')[0]}` : `paragraph ${miLbl(m, i).slice(1)}`; };
  const cite = (m, b) => `<sup class="cite mi-cite" data-miref="${m.id}:${b}" title="${esc(miTitle(m))}, ${miLblLong(m, b)}">${miLbl(m, b)}</sup>`;

  /* ---- the answer to a thread's ask: a plausible one from the question, the space's usual sources and, for
     asks about sources, their passages ---- */
  function answer(g, p) {
    const s = g('spaces').find(x => x.id === p.s);
    if (s.id === 'sablefield' && /sync|rule|scope|row/i.test(p.q)) return { rich: SF_HTML, srcd: [['Sync rules › Scopes', 'docs.sablefield.dev', 'Documentation'], ['Fixing sync rule deploy errors', 'help.sablefield.dev', 'Help center']], sum: 'Declare the rule with scope: user and filter on the owner column with auth.user_id().' };
    const doms = (SOURCES[p.s] || []).slice(0, 3), kw = clip(p.q.replace(/\?$/, ''), 56);
    const T = [`Background: ${kw}`, 'Primary document', 'Later commentary and corrections'], N = ['Overview and dates', 'Quoted where the wording matters', 'Notes one correction'];
    const srcd = doms.map((d, k) => [T[k], d, N[k]]);
    const c = k => k < srcd.length ? ` <sup class="cite">${k + 1}</sup>` : '';
    const its = miRefs(p).map(id => mediaOf(g, id)).filter(m => m && m.body && m.body.length);
    const mc = its.map((m, k) => cite(m, k === 0 && p.about && p.about.b != null && m.body[p.about.b] ? p.about.b : 0)).join(' ');
    const lead = its.length ? `<p>The ${its.length > 1 ? 'sources you asked about agree' : 'source you asked about agrees'} with the pages it cites on the main point and differs on the details. ${mc}</p>` : `<p>The sources below agree on the main point. Where they differ, the answer gives each view with its source.${c(0)}</p>`;
    const list = srcd.length > 1 ? `<h4>What the sources say</h4><ul>${['The first source gives the background and the dates.', 'The second source is the primary document. The answer quotes it where the wording matters.', 'The third source is later commentary. It notes one correction to the earlier accounts.'].slice(0, srcd.length).map((t, k) => `<li>${t}${c(k)}</li>`).join('')}</ul>` : '';
    return { rich: `${lead}${list}<h4>Limits</h4><p>The agent searched the web and ${spName(s)} threads. Sources older than five years were left out unless no newer source covered the point.</p>`, srcd, sum: its.length ? 'The source agrees with the pages it cites on the main point; the answer lists where they differ.' : `Answered from ${srcd.length || 'several'} sources, listed under Sources.` };
  }
  /* the tokens a thread's ask uses */
  const answerTok = p => Math.round((34e3 + (p.q.length * 997) % 14e3) / 1e3) * 1e3;
  /* the answer to an ask about an answer, and its tokens */
  function nodeAnswer(n) {
    const html = n.uses && n.uses.length > 1 ? QT_CANNED.both : /\bwording\b/i.test(n.q || '') ? QT_CANNED.wording : QT_CANNED.generic;
    return { html, tok: 9e3 + Math.round(htmlText(html).length / 4) * 20 };
  }

  /* ---- topics: in a space with the FAQ landing, the agent puts an ask without a topic in the topic whose asks
     share the most keywords with the question ---- */
  const KW_STOP = new Set('a an the i my me we our to of in on for and or is are do does did can could how what why when where with be it its this that you your from at by as which will would there should if im get use using any have has not no yes'.split(' '));
  const kwToks = (txt, s) => txt.toLowerCase().replace(/[^a-z0-9_ ]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !KW_STOP.has(w) && (!s || (w !== s.name && w !== s.title.toLowerCase()))).map(w => w.replace(/(ies|es|s)$/, ''));
  const askText = p => `${p.t || ''} ${p.q} ${p.kw || ''}`;
  const tokHit = (w, set) => set.has(w) || [...set].some(v => v.length > 3 && (v.startsWith(w) || w.startsWith(v)));
  function topic(g, s, q) {
    const asks = g('posts').filter(p => p.s === s.id && p.k === 'ask' && !p.running && !p.gone && !g('modSt')['a:' + p.id]);
    const qt = new Set(kwToks(q, s)); let best = null, top = 0;
    (s.topics || []).forEach(([k, l]) => { const words = new Set(kwToks(l + ' ' + asks.filter(p => p.topic === k).map(askText).join(' '), s)); const n = [...qt].filter(w => tokHit(w, words)).length; if (n > top) { top = n; best = k; } });
    return best;
  }

  /* ---- who pays (TODO(limits): a stub) ---- */
  const sum = o => Object.values(o || {}).reduce((a, b) => a + b, 0);
  const validKeys = g => g('userKeys').filter(k => k.valid);
  const defKey = g => { const v = validKeys(g), u = g('usage'); return v.find(k => k.id === u.def) || v[0] || null; };
  const TM_PROVNAME = { Google: 'Gemini' };
  const prov = k => k.provider || 'Anthropic';
  function keyName(g, k) {
    const p = prov(k), n = `${TM_PROVNAME[p] || p} API key`, lbl = k.label.trim();
    return lbl !== n && validKeys(g).some(x => x.id !== k.id && prov(x) === p) ? `${n} (${lbl})` : n;
  }
  /* one source of tokens: the included tokens or one of the person's keys, with what is left this month */
  function src(g, id) {
    if (!id) return null;
    const u = g('usage'), used = sum((u.by || {})[id]);
    if (id === 'session') return { kind: 'session', id, label: 'Included tokens', cap: u.cap, used, left: Math.max(0, u.cap - used) };
    const k = g('userKeys').find(x => x.id === id); if (!k) return null;
    const cap = k.cap || 0;
    return { kind: 'key', id, label: keyName(g, k), cap, used, left: !k.valid ? 0 : cap ? Math.max(0, cap - used) : Infinity };
  }
  /* the payer now: the first source in the order (included tokens, then the default key) that has tokens left */
  function payer(g) {
    const d = defKey(g), x = ['session', ...(d ? [d.id] : [])].map(id => src(g, id)).find(c => c && c.left > 0);
    return x ? { ok: true, ...x } : { ok: false };
  }
  /* the summary line of an answer that stopped for tokens */
  const stopSum = s => s ? `The answer stopped: ${s.kind === 'session' ? 'this month’s included tokens are used up' : `your ${esc(s.label)} reached its monthly limit`}.` : 'The answer stopped: nothing could pay for it.';
  /* the summary line of a stopped or failed answer */
  const FAIL_SUM = {
    stopped: () => 'Stopped. The agent wrote nothing.',
    tokens: () => stopSum(null),
    key: () => 'The answer failed: the provider rejected the API key.',
    rate: () => 'The answer failed: the provider is limiting requests.',
    access: () => 'The answer failed: the person who asked no longer had access when the run started.',
    interrupted: () => 'The answer failed: the server stopped while the agent worked.',
    too_large: () => 'The answer was not saved: it was larger than 200 KB.',
  };

  /* ---- checks that run as jobs ---- */
  /* the provider's answer to a key check: a key with "revoked" or "expired" in it is rejected; a seeded key keeps its reason */
  const keyVerdict = k => k.raw ? (/revoked/i.test(k.raw) ? 'it was revoked' : /expired/i.test(k.raw) ? 'it has expired' : null) : k.valid ? null : k.reason || 'it gave no reason';
  /* the DNS check of a domain: the mock finds no TXT record on a .test domain */
  const domainFails = dm => /\.test$/i.test((dm || '').trim());

  window.SessionJobs = { STEPS, STEP_TOK, STEP_TOOLS, SOURCES, QT_CANNED, answer, answerTok, nodeAnswer, topic, src, payer, stopSum, FAIL_SUM, keyVerdict, domainFails, htmlText };
})();
