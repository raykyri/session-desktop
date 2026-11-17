/* Session mock API: scenarios, the data of the Screen entries in session-web-spaces.html (step 10).

   Loaded with a plain <script src> after session-web-spaces-mock-api.js; defines one global,
   SessionScenarios = { list, bases }, which the page passes to createBackend({ scenarios }).

   A Screen entry is a mock-only tool that puts the app into a state to review. Its data is a scenario that
   the server sets up: POST /api/dev/scenario { name, args? } puts the database back to the seed (one deep copy
   per call), runs the scenario's base (if it names one) and the scenario in one transaction, and answers
   with every record that changed. The entry's screen (st, nst: what is open, a modal, a draft) stays in the
   page. Because every scenario starts from the seed, an entry does not depend on the entries opened before it.

   scenario(name, { note, base?, run(tx, args, h) }):
     tx  the procedures' transaction (session-web-spaces-mock-api.js, section 5b): tx.get, tx.value, tx.find,
         tx.need, tx.put(k, rec, 'start'?), tx.edit, tx.remove, tx.mapGet, tx.mapPut, tx.mapDel, tx.setValue;
         tx.me is the signed-in person and tx.now the mock clock.
     h   h.rel(space, relation): your relation to a closed space (none, pending, member, mod, denied), with
         the joined list, the space's moderators and your role, as the server's procedures set it;
         h.joined(space, on); h.roster(space) and h.setRoster(space, list): a space's member list;
         h.proc(name, input): a procedure's change, without its permission checks;
         h.ago('3h'): an ISO time this long before the mock clock; h.in(days): this many days after it.
   A scenario writes as the server does, so it is not subject to the permission checks of step 5. */
(function () {
  'use strict';
  const list = {}, bases = {};
  const scenario = (name, def) => { list[name] = def; };

  scenario('seed', { note: 'the seed data, unchanged; also the Variants bar’s Reset' });

  /* ---- accounts ---- */
  scenario('new account', { note: 'a new account (Sign up, or after deleting the account): no API keys, no usage yet, no default key',
    run: tx => { tx.get('userKeys').forEach(k => tx.remove('userKeys', k.id)); tx.setValue('usage', { ...tx.value('usage'), by: {}, def: null, movedSeen: false, fresh: true }); } });

  /* ---- closed spaces: #replication-club as seen by a visitor, an applicant, a member, a moderator ---- */
  scenario('replication: pending', { note: 'you asked to join #replication-club; the request waits for a moderator',
    run: (tx, a, h) => h.rel('replication', 'pending') });
  scenario('replication: member', { note: 'you are a member of #replication-club',
    run: (tx, a, h) => h.rel('replication', 'member') });
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
    run: (tx, a, h) => { h.rel('replication', 'mod'); h.proc('joinRequests.decide', { space: 'replication', users: ['noor.a'], decision: 'approve' }); } });

  /* ---- spaces you own: #math archived; a new closed space ---- */
  scenario('math: archived', { note: 'you archived #math, which you own',
    run: tx => tx.edit('spaces', 'math', x => { x.archived = { by: tx.me.u, on: 'Nov 17' }; }) });
  scenario('tide-gauges: a new closed space', { note: 'you created #tide-gauges, a closed listed space: you are its owner and only member',
    run: (tx, a, h) => { h.proc('spaces.create', { name: 'tide-gauges', desc: 'Readings and calibration notes from coastal tide gauges.', rules: [], vis: 'listed', faq: false, policy: 'request', qs: [{ q: 'What would you like to work on here?', req: true }], invite: 'mods' }); } });

  /* ---- reports in #sablefield (you are an admin there) ---- */
  const threadOf = (tx, rf) => { const p = tx.get('posts').find(x => x.rf === rf); if (!p) throw new Error(`no thread ${rf}`); return p.id; };
  scenario('sablefield: a removed post', { note: 'a moderator (you) removed the item of the first open report; the report is resolved',
    run: (tx, a, h) => { const r = tx.get('reports').find(x => x.st === 'open'); h.proc('reports.resolve', { report: r.id, outcome: 'removed' }); } });
  scenario('sablefield: your report dismissed', { note: 'you reported an answer in #sablefield an hour ago; a moderator dismissed the report, and you have the notification',
    run: (tx, a, h) => {
      tx.put('reports', { id: 'rpme', sp: 'sablefield', key: 'a:' + threadOf(tx, 'q11'), why: 'old', note: 'Enterprise credits now roll over for 24 months.', by: tx.me.u, createdAt: h.ago('1h'), st: 'open' }, 'start');
      h.proc('reports.resolve', { report: 'rpme', outcome: 'dismissed' });
    } });

  /* ---- sources ---- */
  scenario('sources: saved', { note: 'you saved three sources: the scaling-laws article, the podcast and the X thread',
    run: tx => tx.setValue('miSaved', new Set(['m2', 'm4', 'm1'])) });
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
  scenario('asks: a branch became a thread', { note: 'someone started a thread from the branch b3 of the prediction-markets thread, with the asks below it',
    run: (tx, a, h) => {
      const th = seedThread(tx, 11), tree = tx.mapGet('qtd', th), n = tree.nodes.find(x => x.id === 'b3'), p = tx.need('posts', th);
      h.proc('threads.create', { space: p.s, kind: 'ask', q: n.q, title: 'Disputed prediction markets decided by UMA votes', from: { th, node: 'b3' }, branch: tree.nodes.some(x => x.par === 'b3') ? 'all' : 'one' });
    } });
  scenario('asks: a collapsed branch', { note: 'the owner of the reading-group thread collapsed the branch g2',
    run: tx => { const th = seedThread(tx, 0), tree = tx.mapGet('qtd', th); tx.mapPut('qtd', th, { ...tree, nodes: tree.nodes.map(x => x.id === 'g2' ? { ...x, col: true } : x) }); } });

  /* ---- About: pages and rules in #sci-fi ---- */
  scenario('scifi: a page changed', { note: 'tomasz edited the page Canon starter list in #sci-fi five minutes ago: a notification',
    run: (tx, a, h) => tx.put('notifs', { id: 'npg', type: 'page_edited', actor: 'tomasz', space: 'scifi', page: 1, createdAt: h.ago('5m'), read: false }, 'start') });
  scenario('scifi: rules updated', { note: 'tomasz changed a rule of #sci-fi two days ago (See changes)',
    run: (tx, a, h) => tx.edit('spaces', 'scifi', x => {
      x.rulesPrev = ['Mark spoilers in titles with [spoilers].', 'Cite editions and page numbers when quoting.', 'Reading-group threads are pinned by mods.'];
      x.rules = ['Mark spoilers in titles with [spoilers].', 'Cite editions and page numbers when quoting.', 'Put plot details after a "Spoilers below" line.'];
      x.rulesAt = h.ago('2d'); x.rulesBy = 'tomasz';
    }) });

  window.SessionScenarios = { list, bases };
})();
