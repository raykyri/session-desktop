/* Session mock API: scenarios, the data of the Screen entries in session-web-spaces.html (step 10).

   Loaded with a plain <script src> after session-web-spaces-mock-api.js; defines one global,
   SessionScenarios = { list }, which the page passes to createBackend({ scenarios }).

   A Screen entry is a mock-only tool that puts the app into a state to review. Its data is a scenario that
   the server sets up: POST /api/dev/scenario { name, args? } puts the database back to the seed (one deep
   copy per call), runs the scenario in one transaction and answers with every record that changed. The
   entry's screen (st, nst: what is open, a modal, a draft) stays in the page (SCREEN_DATA there names each
   entry's scenario). Because every scenario starts from the seed, an entry does not depend on the entries
   opened before it.

   scenario(name, { note, run?(tx, args, h) }): run gets the scenario's args ({} when there are none).
     tx  the procedures' transaction (session-web-spaces-mock-api.js, section 5b): tx.get, tx.value, tx.find,
         tx.need, tx.put(k, rec, 'start'?), tx.edit, tx.remove, tx.mapGet, tx.mapPut, tx.mapDel, tx.setValue;
         tx.me is the signed-in person and tx.now the mock clock.
     h   h.rel(space, relation): your relation to a closed space (none, pending, member, mod, denied), with
         the joined list, the space's moderators and your role, as the server's procedures set it;
         h.tree(thread): a thread's asks about asks (stored, or its follow-ups as level-1 asks);
         h.proc(name, input): a procedure's change, without its permission checks;
         h.ago('3h'): an ISO time this long before the mock clock (as the page's isoAgo);
         h.run(thread, node, step): a run in progress on the node's ask (node r: the thread's ask), held at that
         progress step (paused: its job does not move it on), as the job writes it (step 7).
     h.savePage(space, page, { by, text, title?, base? }), h.saveSkill(space, index, { prompt, name? }),
     h.saveRules(space, rules, by): another member's save of a page, a skill or the rules, as the procedure
         writes it: the version goes up by one (step 9, edit conflicts).
   A scenario writes as the server does, so it is not subject to the permission checks of step 5. */
(function () {
  'use strict';
  const list = {};
  const scenario = (name, def) => { list[name] = def; };

  scenario('seed', { note: 'the seed data, unchanged; also the Variants bar’s Reset' });

  /* ---- accounts ---- */
  scenario('new account', { note: 'a new account (Sign up, or after deleting the account): no API keys, no usage yet, no default key',
    run: tx => { tx.get('userKeys').forEach(k => tx.remove('userKeys', k.id)); tx.setValue('usage', { ...tx.value('usage'), by: {}, def: null, movedSeen: false, fresh: true }); } });

  scenario('keys: a key being checked', { note: 'you added the Work key (Anthropic, 1M tokens a month); the provider is checking it',
    run: tx => tx.put('userKeys', { id: 'k3', kind: 'key', raw: 'sk-ant-api03-Xr7qL2mN8vB4kW9dT1fS6hJ3', label: 'Work key', mask: 'sk-ant-…6hJ3', valid: false, check: 'checking', provider: 'Anthropic', lastUsedAt: null, used: 0, cap: 1e6 }) });
  scenario('account: email change pending', { note: 'you asked to change your email to ines.v@work.example; the confirmation link is not opened yet',
    run: tx => { const a = tx.value('acct'); a.emailNew = 'ines.v@work.example'; tx.setValue('acct', a); } });
  scenario('account: export requested', { note: 'you requested an export of your data just now',
    run: tx => { const a = tx.value('acct'); a.exportAt = tx.now; tx.setValue('acct', a); } });
  scenario('profiles: hal_b muted', { note: 'you muted hal_b', run: tx => tx.setValue('muted', new Set(['hal_b'])) });
  scenario('profiles: hal_b blocked', { note: 'you blocked hal_b', run: tx => tx.setValue('blocked', new Set(['hal_b'])) });

  /* ---- closed spaces: #replication-club as seen by a visitor, an applicant, a member, a moderator ---- */
  scenario('replication: pending', { note: 'you asked to join #replication-club; the request waits for a moderator',
    run: (tx, a, h) => h.rel('replication', 'pending') });
  scenario('replication: member', { note: 'you are a member of #replication-club',
    run: (tx, a, h) => h.rel('replication', 'member') });
  scenario('replication: mira_k’s ask running', { note: 'mira_k asked again in #replication-club (her grokking ask); its run is in progress and moves on. args.member: you are a member. For the closed-space read rules: a non-member gets none of its events',
    run: (tx, a, h) => {
      if (a.member) h.rel('replication', 'member');
      const th = tx.get('posts').find(p => p.s === 'replication' && p.u === 'mira_k' && p.k === 'ask').id;
      tx.edit('posts', th, x => { x.running = true; x.att = (x.att || 1) + 1; delete x.fail; });
      h.run(th, 'r', 0);
      const key = th + ':r', r = tx.mapGet('runs', key); delete r.paused; tx.mapPut('runs', key, r);
    } });
  scenario('replication: moderator', { note: 'you moderate #replication-club (an admin there). args.seen: you have read the join-requests notification',
    run: (tx, a, h) => { h.rel('replication', 'mod'); if (a.seen) tx.setValue('reqSeen', true); } });
  scenario('replication: request approved', { note: 'a moderator approved your request to join #replication-club, and you have the notification',
    run: (tx, a, h) => { h.rel('replication', 'member'); tx.put('notifs', { id: 'napp', type: 'join_approved', actor: 'lettie', space: 'replication', read: false }, 'start'); } });
  scenario('replication: request declined', { note: 'a moderator declined your request to join #replication-club, and you have the notification',
    run: (tx, a, h) => { h.rel('replication', 'denied'); tx.put('notifs', { id: 'ndec', type: 'join_declined', space: 'replication', read: false }, 'start'); } });
  scenario('replication: verified domain', { note: 'you moderate #replication-club, and its domain replicationclub.org is verified',
    run: (tx, a, h) => { h.rel('replication', 'mod'); tx.edit('spaces', 'replication', x => { x.dom = { domain: 'replicationclub.org', method: 'dns', state: 'ok', verifiedAt: tx.now }; }); } });
  scenario('replication: denied', { note: 'a moderator declined your request to join #replication-club (the note and the waiting period are screen state)',
    run: (tx, a, h) => h.rel('replication', 'denied') });
  scenario('replication: noor.a approved', { note: 'you moderate #replication-club and approved noor.a’s request: they are a member',
    run: (tx, a, h) => { h.rel('replication', 'mod'); h.proc('joinRequests.decide', { space: 'replication', users: ['noor.a'], decision: 'approve', base: { 'noor.a': tx.find('reqs', 'noor.a').rev || 1 } }); } });

  scenario('replication: moderator, with notifications', { note: 'you moderate #replication-club, and jun.park invited you to #ward7 a minute ago',
    run: (tx, a, h) => {
      h.rel('replication', 'mod');
      const inv = tx.find('notifs', 'ninv'); tx.remove('notifs', 'ninv');
      tx.put('notifs', { ...inv, read: false, createdAt: h.ago('1m') }, 'start');
    } });

  /* ---- spaces you own: #math archived; a new closed space ---- */
  scenario('math: archived', { note: 'you archived #math, which you own',
    run: tx => tx.edit('spaces', 'math', x => { x.archived = { by: tx.me.u, at: '2026-11-17T09:00:00Z' }; }) });
  scenario('tide-gauges: a new closed space', { note: 'you created #tide-gauges, a closed listed space: you are its owner and only member',
    run: (tx, a, h) => { h.proc('spaces.create', { name: 'tide-gauges', desc: 'Readings and calibration notes from coastal tide gauges.', rules: [], vis: 'listed', faq: false, policy: 'request', qs: [{ q: 'What would you like to work on here?', req: true }], invite: 'mods' }); } });

  /* ---- reports in #sablefield (you are an admin there) ---- */
  const threadOf = (tx, rf) => { const p = tx.get('posts').find(x => x.rf === rf); if (!p) throw new Error(`no thread ${rf}`); return p.id; };
  scenario('sablefield: a removed post', { note: 'you (an admin of #sablefield) removed the item of the first open report, which resolves the report',
    run: (tx, a, h) => { const r = tx.get('reports').find(x => x.st === 'open'); h.proc('reports.resolve', { report: r.id, outcome: 'removed' }); } });
  scenario('sablefield: your report dismissed', { note: 'you reported an answer in #sablefield an hour ago; a moderator dismissed the report, and you have the notification',
    run: (tx, a, h) => {
      tx.put('reports', { id: 'rpme', sp: 'sablefield', key: 'a:' + threadOf(tx, 'q11'), why: 'old', note: 'Enterprise credits now roll over for 24 months.', by: tx.me.u, createdAt: h.ago('1h'), st: 'open' }, 'start');
      h.proc('reports.resolve', { report: 'rpme', outcome: 'dismissed' });
    } });

  /* ---- sources ---- */
  scenario('sources: saved', { note: 'the sources you saved; args.ids (default: the scaling-laws article, the podcast and the X thread)',
    run: (tx, a) => tx.setValue('miSaved', new Set(a.ids || ['m2', 'm4', 'm1'])) });
  scenario('saved: nothing', { note: 'you saved no threads, asks or sources',
    run: tx => { tx.setValue('saved', new Set()); tx.setValue('qtSaved', new Set()); tx.setValue('miSaved', new Set()); } });
  scenario('sources: a saved source changed', { note: 'a source you saved was edited upstream, and someone asked about it: two notifications',
    run: (tx, a, h) => {
      const saved = tx.value('miSaved'); saved.add('m2'); tx.setValue('miSaved', saved);
      tx.put('notifs', { id: 'mi-n-edit', type: 'source_edited', source: 'm2', block: 6, createdAt: h.ago('3h'), read: false }, 'start');
      tx.put('notifs', { id: 'mi-n-ask', type: 'source_asked', actor: 'jun.park', source: 'm2', thread: threadOf(tx, 'mia1'), createdAt: h.ago('5h'), read: false }, 'start');
    } });
  scenario('public: moderator', { note: 'you moderate #public (an admin there), where moderators review the sources members add',
    run: (tx, a, h) => h.rel('public', 'mod') });
  scenario('field-notes: a new space', { note: 'you created #field-notes, an open space with no sources yet: you are its owner and only member',
    run: (tx, a, h) => { h.proc('spaces.create', { name: 'field-notes', desc: 'Methods and sources for ecology field surveys.', rules: ['Say in a note why a source matters.'] }); } });

  /* ---- asks about asks (question trees) ---- */
  /* the fixture thread that is at position n of the seed (the page's TID(n)) */
  const seedThread = (tx, n) => tx.get('posts')[n].id;
  scenario('asks: a branch became a thread', { note: 'a new thread from the branch b3 of the prediction-markets thread, with the asks below it (the branch links to it)',
    run: (tx, a, h) => {
      const th = seedThread(tx, 11), tree = tx.mapGet('qtd', th), n = tree.nodes.find(x => x.id === 'b3'), p = tx.need('posts', th);
      h.proc('threads.create', { space: p.s, kind: 'ask', q: n.q, title: 'Disputed prediction markets decided by UMA votes', from: { th, node: 'b3' }, branch: tree.nodes.some(x => x.par === 'b3') ? 'all' : 'one' });
    } });
  scenario('asks: a collapsed branch', { note: 'the owner of the reading-group thread collapsed the branch g2',
    run: tx => { const th = seedThread(tx, 0), tree = tx.mapGet('qtd', th); tx.mapPut('qtd', th, { ...tree, nodes: tree.nodes.map(x => x.id === 'g2' ? { ...x, col: true } : x) }); } });

  /* ---- About: pages and rules in #sci-fi ---- */
  scenario('scifi: rules updated', { note: 'tomasz changed a rule of #sci-fi two days ago (See changes)',
    run: (tx, a, h) => tx.edit('spaces', 'scifi', x => {
      x.rulesPrev = ['Mark spoilers in titles with [spoilers].', 'Cite editions and page numbers when quoting.', 'Reading-group threads are pinned by mods.'];
      x.rules = ['Mark spoilers in titles with [spoilers].', 'Cite editions and page numbers when quoting.', 'Put plot details after a "Spoilers below" line.'];
      x.rulesAt = h.ago('2d'); x.rulesBy = 'tomasz';
    }) });

  /* ---- edit conflicts (step 9): another member saves while your editor is open ----
     The Screen entries open the editor on the seed, then run one of these: the version goes up, so the save
     that follows is a CONFLICT. */
  scenario('scifi: tomasz saved a page', { note: 'tomasz saved a new version of Canon starter list in #sci-fi (the page had no stored document: its history is the one the page shows)',
    run: (tx, a, h) => h.savePage('scifi', 1, {
      by: 'tomasz',
      text: ['A short list for people new to the genre: one book per subgenre, each with a sentence on why it is on the list.', '## Classics', '- The Left Hand of Darkness (Le Guin, 1969): gender and politics on a planet in an ice age.\n- Neuromancer (Gibson, 1984): the novel that named cyberspace.\n- Hyperion (Simmons, 1989): six stories told on one pilgrimage.', '## Recent', '- Ancillary Justice (Leckie, 2013): told by a soldier who used to be a starship.\n- The Fifth Season (Jemisin, 2015): geology as the centre of the worldbuilding.\n- Children of Time (Tchaikovsky, 2015): a spider civilization over thousands of years.', '## Adding a book', 'Reply in the canon thread with the title, the year and one sentence. Moderators update this page at the start of each month.'],
      base: { by: 'tomasz', ed: 'ines.v', revs: [{ by: 'ines.v', createdAt: '2026-10-29T22:00:00Z', note: 'Updated the page' }, { by: 'ines.v', createdAt: h.ago('3w'), note: 'Added a section' }, { by: 'tomasz', createdAt: h.ago('2mo'), note: 'Created the page' }] },
    }) });
  scenario('ml: mira_k saved a skill', { note: 'mira_k saved a new version of the skill summarizing-papers in #ml-papers',
    run: (tx, a, h) => { const { prompt } = tx.mapGet('skills', 'ml')[0]; h.saveSkill('ml', 0, { prompt: prompt.replace('- Not tested:', '- Code: whether the code and weights are public.\n- Not tested:') }); } });
  scenario('ml: mira_k changed the rules', { note: 'mira_k changed the rules of #ml-papers',
    run: (tx, a, h) => h.saveRules('ml', [...tx.find('spaces', 'ml').rules, 'Mark preprints that have not been peer reviewed.'], 'mira_k') });

  /* ---- your asks, and who pays for them (the token model; TODO(limits): usage is a stub) ---- */
  const SAMPLE_Q = 'What changed in public guidance on AI model evaluations this year?';
  const noKeys = tx => tx.get('userKeys').forEach(k => tx.remove('userKeys', k.id));
  /* your included tokens this month: `used` in all, the difference charged to #public */
  const sessionUsed = (tx, used) => {
    const u = tx.value('usage'), by = u.by.session || (u.by.session = {});
    by.public = (by.public || 0) + used - Object.values(by).reduce((a, b) => a + b, 0);
    tx.setValue('usage', u);
  };
  /* how an ask of yours ended: its payer, the tokens it used, its summary line and its failure */
  const ASK_ENDS = {
    running: { running: true, pay: 'session', att: 1 },
    stopped: { pay: 'session', tok: 18e3, sum: 'Stopped. The agent wrote nothing.', fail: { why: 'stopped' } },
    tokens: { pay: 'session', sum: 'The answer stopped: this month’s included tokens are used up.', fail: { why: 'tokens' } },
    key: { pay: 'k0', sum: 'The answer failed: the provider rejected the API key.', fail: { why: 'key' } },
    rate: { pay: 'k2', sum: 'The answer failed: the provider is limiting requests.', fail: { why: 'rate' } },
    /* the run's checks when it started failed (step 7), and the server could not resume a run after a restart */
    access: { pay: 'session', sum: window.SessionJobs.FAIL_SUM.access(), fail: { why: 'access' } },
    interrupted: { pay: 'session', sum: window.SessionJobs.FAIL_SUM.interrupted(), fail: { why: 'interrupted' } },
  };
  scenario('asks: your ask', { note: 'you asked a minute ago, the newest thread. args: space, end (running, stopped, tokens, key, rate, access, interrupted), q, tok. An ask stopped for tokens: your included tokens are used up. A running ask: its run is held at the third progress step (Reading 9 sources)',
    run: (tx, a, h) => {
      const q = a.q || SAMPLE_Q, end = JSON.parse(JSON.stringify(ASK_ENDS[a.end]));
      if (a.end === 'rate') end.fail.at = Date.now() + 20e3;   /* the provider's retry time, on the real clock as the page counts it */
      if (a.end === 'tokens') { sessionUsed(tx, 2e6); end.tok = a.tok; }
      const id = tx.id();
      tx.put('posts', { id, s: a.space, u: tx.me.u, k: 'ask', t: null, q, sum: null, tok: 0, createdAt: h.ago('1m'), running: false, kw: q, ...end });
      tx.mapPut('fu', id, []);
      if (a.end === 'running') h.run(id, 'r', 2);
    } });
  scenario('asks: a follow-up running', { note: 'you asked about the first answer of the prediction-markets thread just now; the run is held at the third progress step (Reading 9 sources)',
    run: (tx, a, h) => {
      const th = seedThread(tx, 11), tree = h.tree(th), id = tx.id();
      tx.mapPut('qtd', th, { ...tree, nodes: [...tree.nodes, { id, par: 'r', u: tx.me.u, q: 'Is there evidence that clearer wording reduces disputes?', tok: 0, running: true, uses: null, pay: 'session', model: 'argon', att: 1 }] });
      h.run(th, id, 2);
    } });
  scenario('asks: an answer is ready', { note: 'a notification: the answer to an ask in #public is ready',
    run: tx => {
      const p = tx.get('posts').find(x => x.s === 'public' && x.k === 'ask' && !x.running && !x.fail && !x.about);
      tx.put('notifs', { id: 'nask:demo', type: 'answer_ready', thread: p.id, read: false }, 'start');
    } });
  scenario('no joined spaces', { note: 'you joined no spaces. args.leaveGrants: you are not a member of the closed #grants either',
    run: (tx, a, h) => { if (a.leaveGrants) h.rel('grants', 'none'); tx.setValue('joined', []); } });
  scenario('usage: near the limit, no key', { note: 'you used 81% of this month’s included tokens and have no API key',
    run: tx => { noKeys(tx); sessionUsed(tx, 1.62e6); } });
  scenario('usage: included tokens used up', { note: 'this month’s included tokens are used up; asks move to your default key. args.noKey: you have no API key',
    run: (tx, a) => { if (a.noKey) noKeys(tx); sessionUsed(tx, 2e6); } });
  scenario('usage: a follow-up stopped for tokens', { note: 'your follow-up on your ask in #public stopped because this month’s included tokens are used up',
    run: (tx, a, h) => {
      sessionUsed(tx, 2e6);
      const rich = tx.get('rich'), p = tx.get('posts').find(x => x.u === tx.me.u && x.k === 'ask' && x.s === 'public' && rich[x.id]), tree = h.tree(p.id);
      tx.mapPut('qtd', p.id, { ...tree, nodes: [...tree.nodes, { id: 'tmf', par: 'r', u: tx.me.u, createdAt: h.ago('2m'), q: 'Which of these works describe a market that prices attention directly?', tok: 6e3, running: false, html: '', pay: 'session', fail: { why: 'tokens' } }] });
    } });

  /* ---- thread actions: your own items ---- */
  const TA_POST = 'Notes from Thursday’s reading group are on the wiki page. Next week: chapters 4 to 6.';
  scenario('threads: your post with replies', { note: 'your post in #public from two hours ago, with replies (one of them yours, one a reply to a reply). args.deleted: you deleted the post and your reply; the replies to them stay',
    run: (tx, a, h) => {
      const id = tx.id();
      tx.put('posts', { id, s: 'public', u: tx.me.u, k: 'post', t: null, q: a.deleted ? '' : TA_POST, sum: null, tok: 0, createdAt: h.ago('2h'), likes: 4, running: false, kw: a.deleted ? '' : TA_POST, ...(a.deleted ? { del: true } : {}) });
      const replies = [
        { u: 'jun.park', createdAt: h.ago('1h'), t: 'Is the group still meeting on Thursdays at six?', kids: [{ u: tx.me.u, createdAt: h.ago('50m'), t: 'Yes, same time. The room is now 2B.' }] },
        { u: tx.me.u, createdAt: h.ago('40m'), t: 'I added the discussion questions for chapter 4 to the page.' },
        { u: 'lettie', createdAt: h.ago('20m'), t: 'Linked this from the reading list.' },
      ];
      if (a.deleted) replies[1] = { ...replies[1], del: true, t: '', kids: [{ u: 'jun.park', createdAt: h.ago('30m'), t: 'Thanks, I found them.' }] };
      tx.mapPut('rp', id, replies);
    } });
  scenario('threads: your ask deleted', { note: 'you deleted your ask in #public (the reading-group thread); its follow-ups stay',
    run: tx => tx.edit('posts', seedThread(tx, 0), x => { x.del = true; x.q = ''; x.kw = ''; x.t = null; }) });
  scenario('threads: an answer that used a skill', { note: 'an answer in #ml-papers used the skill summarizing-papers',
    run: tx => { const rich = tx.get('rich'), p = tx.get('posts').find(x => x.s === 'ml' && x.k === 'ask' && rich[x.id] && !x.about); tx.edit('posts', p.id, x => { x.skill = 'summarizing-papers'; }); } });

  /* ---- permission checks (step 5): states for the server's checks that no Screen entry needs ---- */
  scenario('replication: banned', { note: 'a moderator of #replication-club banned you: you can’t request to join it or join with an invite link',
    run: tx => tx.put('banned', { id: 'replication:' + tx.me.u, sp: 'replication', u: tx.me.u, createdAt: tx.now }, 'start') });
  scenario('replication: request approved, not joined', { note: 'a moderator of #replication-club approved your request; you have not joined yet',
    run: (tx, a, h) => { h.rel('replication', 'pending'); tx.put('reqs', { u: tx.me.u, sp: 'replication', st: 'approved', a: ['Re-running the grokking table.', ''], userCreatedAt: tx.me.createdAt }); } });
  scenario('public: members edit pages', { note: 'the admins of #public let its members edit pages (pageEdit "members")',
    run: tx => tx.edit('spaces', 'public', x => { x.pageEdit = 'members'; }) });
  scenario('public: moderators add sources', { note: 'only moderators of #public can add sources (source policy "mods")',
    run: tx => tx.mapPut('dsPol', 'public', 'mods') });

  /* ---- sync states: the outbox, refused writes, access changes, device runs ----
     These scenarios set up what the server holds when each state appears; the page's Screen entries then send the
     writes (the write envelope, section 6b of session-web-spaces-mock-api.js) and show the server's answers. The
     device's own copy of a space and the writes waiting in its outbox are the client's (the page). */
  const sf42 = tx => tx.get('posts').find(p => p.s === 'sablefield' && p.k === 'post' && /4\.2 is out/.test(p.q)).id;
  scenario('outbox: replies arrived while you were offline', { note: 'while your device was offline, oduya and jun.park replied to the Sablefield 4.2 post. Your own reply is still in the device’s outbox (page state), so the server does not have it',
    run: (tx, a, h) => {
      const th = sf42(tx);
      tx.mapPut('rp', th, [...tx.mapGet('rp', th), { u: 'oduya', createdAt: h.ago('40m'), t: 'The rules check command caught two scope errors in our staging project.', likes: 1 }, { u: 'jun.park', createdAt: h.ago('25m'), t: 'Deploys of sync rules went from about a minute to a few seconds for us.', likes: 0 }]);
    } });
  scenario('sablefield: bram edited a hidden reply', { note: 'you (an admin of Sablefield) hid bram’s reply on the 4.2 post. Later, offline, you chose Show; before that write reached the server, bram edited the reply, so its version changed and the queued Show answers STALE',
    run: (tx, a, h) => {
      const th = sf42(tx), list = tx.mapGet('rp', th);
      tx.mapPut('rp', th, list.map(r => r.u === 'bram' ? { ...r, t: 'Edited: the discount code is gone. A comparison of managed Postgres hosts is at cheapdb.example/compare.', edited: true, rev: (r.rev || 1) + 1 } : r));
      tx.mapPut('modSt', `r:${th}:${list.findIndex(r => r.u === 'bram')}`, 'hidden');
    } });
  scenario('replication: a request changed after Approve', { note: 'you moderate #replication-club. After you chose Approve on noor.a’s request, noor.a changed the answers, so the queued Approve answers STALE',
    run: (tx, a, h) => {
      h.rel('replication', 'mod'); tx.setValue('reqSeen', true);
      tx.edit('reqs', 'noor.a', r => { r.a = ['Grokking on modular arithmetic and on sparse parity. I will re-run the small models with three seeds each and share the logs.', 'github.com/noor-a/grokking-rerun']; });
    } });
  scenario('replication: moderator role removed', { note: 'you were a moderator of #replication-club; an admin changed your role to member. The review queue, reports and their notifications are no longer served to you',
    run: (tx, a, h) => h.rel('replication', 'member') });
  scenario('replication: removed', { note: 'a moderator removed you from #replication-club: the server serves you nothing of it',
    run: (tx, a, h) => h.rel('replication', 'none') });
  scenario('replication: removed, a device keeps its copy', { note: 'a moderator removed you from #replication-club: the server serves you nothing of it. Your Desktop or Phone app keeps the copy it had (the page keeps the records it loaded as a member, and marks them frozen)',
    run: (tx, a, h) => h.rel('replication', 'none') });
  scenario('sablefield: an open space to moderate', { note: 'you are an admin of Sablefield, an open space: anyone can join, so a removed member could join again',
    run: (tx, a, h) => h.rel('sablefield', 'mod') });
  const scifiAsk = tx => tx.get('posts').find(p => p.s === 'scifi' && p.u === 'mira_k' && p.k === 'ask' && !p.about).id;
  /* mira_k's Mac: a device run's executor */
  const MIRA_MAC = { kind: 'device', cli: 'claude', device: 'dm1', u: 'mira_k' };
  scenario('device runs: mira_k’s ask running', { note: 'mira_k ran her #sci-fi ask again on her Mac (a device run: the run record and the thread carry its executor). Her Mac holds the run’s lease; the run is held after its first step',
    run: (tx, a, h) => { const th = scifiAsk(tx); tx.edit('posts', th, x => { x.running = true; x.att = (x.att || 1) + 1; delete x.fail; x.executor = MIRA_MAC; delete x.pay; }); h.run(th, 'r', 1, MIRA_MAC); } });
  scenario('device runs: mira_k’s run interrupted', { note: 'mira_k ran her #sci-fi ask again on her Mac; the Mac slept, the run’s lease ended and the run is interrupted',
    run: tx => { const th = scifiAsk(tx); tx.edit('posts', th, x => { x.running = false; x.att = (x.att || 1) + 1; x.fail = { why: 'interrupted' }; x.sum = window.SessionJobs.FAIL_SUM.interrupted(); x.executor = MIRA_MAC; delete x.pay; }); } });
  scenario('device runs: the hourly limit', { note: 'you started 100 device runs in the last hour: the next one answers TOO_MANY_REQUESTS with the time it can start',
    run: (tx, a, h) => h.deviceRuns(100) });
  scenario('device runs: your run on this Mac', { note: 'you ran your #public ask again on your MacBook Air (Claude Code); the Mac claimed the run and holds its lease. args.end: interrupted (the lease ended) or too_large (the answer was over 200 KB)',
    run: (tx, a, h) => {
      const th = tx.get('posts').find(p => p.s === 'public' && p.u === tx.me.u && p.k === 'ask' && !p.gone).id, ex = { kind: 'device', cli: 'claude', device: 'd1', u: tx.me.u };
      tx.edit('posts', th, x => { x.att = (x.att || 1) + 1; x.executor = ex; delete x.pay; if (a.end) { x.running = false; x.fail = { why: a.end }; x.sum = window.SessionJobs.FAIL_SUM[a.end](); } else { x.running = true; delete x.fail; } });
      if (!a.end) h.run(th, 'r', 1, ex);
    } });
  /* ---- end sync states ---- */

  window.SessionScenarios = { list };
})();
