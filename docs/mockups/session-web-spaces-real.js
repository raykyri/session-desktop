/* The mockup on the real server (phase 2a): with ?sync=1&server=<origin>, the page's sync client sends its
   writes to the real Session server at <origin> (web/packages/server) instead of the mock backend.

   Loaded with a plain <script src> after the sync bundle, only when the query names a server. It defines one
   global, SessionReal, that the page's ?sync=1 driver uses:
   - load(get, now, login): before a screen's writes are sent, the server's clock is set to the mock's
     (POST /api/test/clock), a device token for the signed-in person is taken (POST /api/test/device), and
     the screen's data is loaded into the server's store as @session/mutators records (POST /api/test/records,
     the test-only scenario endpoint): spaces, their stats, page lists and pages, memberships (the person's,
     the staff lists, the member lists), threads and their counts, replies and join requests, converted from
     what the mock backend serves the page (GET /api/...). Ids the mock's fixtures make up ("public",
     "pg-public-1", "rp1") are re-keyed with ULIDs (report-1b finding 9) at this boundary: a fixed map from each
     fixture id to a ULID, applied to the records and to every write's input; ids that are ULIDs already
     (threads) stay.
   - transport(post, onChanges, offline): a transport for the sync client (@session/sync's `Transport`)
     whose register and writes go to the real server with the device's bearer token. A write the server
     applies is also run on the mock backend as its procedure (POST /api/rpc/<name>), so the page's collections
     show it as before; the server's answer is the client's answer.
   - failNext(code, times): the next writes answer `code` (POST /api/test/fail), as DevConfig failOn does on
     the mock; a screen's load sends the failures its set-up asked for, or none.
   - config({ minProtocol }): the lowest protocol version the server takes (POST /api/test/config), as
     DevConfig minProtocol does on the mock.
   The page is opened from file://, so its origin is "null": the test server admits it for bearer requests
   (SESSION_DESKTOP_ORIGINS=null), as the desktop app's origin is admitted. */
(function () {
  'use strict';
  const m = /[?&]server=([^&]+)/.exec(location.search);
  if (!m) return;
  const base = decodeURIComponent(m[1]).replace(/\/$/, '');
  const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
  const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  /* the ULIDs of re-keyed fixture ids: their time is the mock clock's day; the rest is a hash of the id */
  const ids = new Map();
  const EPOCH = Date.parse('2026-09-15T12:00:00Z');
  function toUlid(x) {
    if (typeof x !== 'string' || ULID_RE.test(x)) return x;
    let u = ids.get(x);
    if (u) return u;
    let t = '', ms = EPOCH;
    for (let i = 0; i < 10; i++, ms = Math.floor(ms / 32)) t = B32[ms % 32] + t;
    let h = 2166136261, r = '';
    for (let i = 0; i < 16; i++) {
      for (const c of x + ':' + i) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
      r += B32[h % 32];
    }
    u = t + r;
    ids.set(x, u);
    return u;
  }
  /* a write's input with every re-keyed fixture id replaced */
  const mapIds = v => typeof v === 'string' ? (ids.has(v) ? ids.get(v) : v)
    : Array.isArray(v) ? v.map(mapIds)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapIds(x)])) : v;

  let token = null;
  const call = async (path, body) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Protocol': '4', Authorization: 'Bearer ' + (token || 'test') },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const ROLE = { Owner: 'owner', Admin: 'admin', Moderator: 'mod', Member: 'member', owner: 'owner', admin: 'admin', mod: 'mod', member: 'member' };
  const RANK = { member: 1, mod: 2, admin: 3, owner: 4 };
  const pageSlug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const unset = s => (s && s.$set) || s || [];

  /* the screen's data, as @session/mutators records ({ key, record } without rev) */
  function convert(c, me, now) {
    const at = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const out = [];
    const put = (key, record) => out.push({ key, record });
    const members = new Map();
    const member = (sp, u, role, joinedAt) => {
      const k = sp + ':' + u, old = members.get(k);
      if (old && RANK[old.role] >= RANK[role]) return;
      members.set(k, { kind: 'member', sp, u, role, adm: toUlid('adm:' + k), joinedAt: joinedAt || at });
    };
    const joined = new Set(unset(c.joined));
    for (const s of c.spaces || []) {
      const sp = toUlid(s.id);
      const staff = (s.mods || []).map(([u, r]) => [u, ROLE[r] || 'mod']);
      const mine = joined.has(s.id) ? ROLE[(c.roles || {})[s.id]] || 'member' : null;
      if (mine && mine !== 'member' && !staff.some(([u]) => u === me)) staff.push([me, mine]);
      staff.sort((a, b) => RANK[b[1]] - RANK[a[1]] || (a[0] < b[0] ? -1 : 1));
      for (const [u, r] of staff) member(sp, u, r);
      if (mine) member(sp, me, mine);
      const roster = s.id === 'replication' ? c.mem : (c.memOther || {})[s.id];
      for (const x of roster || []) member(sp, x.u, ROLE[x.role] || 'member', x.joinedAt);
      put('space:' + sp, {
        kind: 'space', id: sp, name: s.name, title: s.title || s.name, desc: s.desc || '', rules: s.rules || [], rulesRev: 0,
        rulesPrev: s.rulesPrev || [], rulesBy: s.rulesBy || null, vis: s.vis || 'open', policy: s.policy || null, invite: s.invite || null,
        qs: (s.qs || []).map(q => ({ q: q.q, req: !!q.req })), postsOff: !!s.postsOff, av: s.av || 0, img: !!s.img, faq: !!s.faq,
        topics: s.topics || [], plain: !!s.plain, pageEdit: s.pageEdit || null, srcPolicy: 'members', dom: null,
        archived: s.archived || null, deleted: !!s.deleted, members: s.members || 0, mods: staff, createdAt: s.createdAt || at,
      });
      put('stats:' + sp, { kind: 'stats', sp, posts: s.posts || 0, updatedAt: s.updatedAt || s.createdAt || at });
      const list = (s.pages || []).map(([t, edited, id]) => ({ id: toUlid(id), t, at: edited }));
      put('pages:' + sp, { kind: 'pages', sp, list });
      for (const [t, edited, id] of s.pages || []) {
        const doc = Object.values(c.pagedocs || {}).find(d => d && d.id === id) || (c.pagedocs || {})[s.id + '/' + pageSlug(t)];
        const pid = toUlid(id);
        put('page:' + pid, {
          kind: 'page', id: pid, sp, slug: pageSlug(t), t, text: (doc && doc.text) || [], by: (doc && doc.by) || '',
          ed: (doc && doc.ed) || null, ver: (doc && doc.rev) || 0,
          revs: ((doc && doc.revs) || []).map(r => ({ by: r.by, note: r.note, createdAt: r.createdAt || edited })),
        });
      }
    }
    for (const x of members.values()) put('member:' + x.sp + ':' + x.u, x);
    for (const p of c.posts || []) {
      const s = toUlid(p.s), created = p.createdAt || at;
      put('thread:' + p.id, {
        kind: 'thread', id: p.id, s, u: p.u, k: p.k, q: p.q, t: p.t == null ? null : p.t, sum: p.sum == null ? null : p.sum, tok: p.tok || 0,
        running: !!p.running, edited: !!p.edited, del: !!p.del, gone: !!p.gone, mod: null, topic: p.topic || null, topicBy: p.topicBy || null,
        pay: p.pay == null ? null : p.pay, model: p.model || null, about: p.about || null, skill: p.skill || null,
        att: p.att || (p.k === 'ask' ? 1 : 0), from: p.from ? { th: p.from.th, node: p.from.node, lv: p.from.lv || 0 } : null,
        createdAt: created, updatedAt: p.updatedAt || created,
      });
      put('counts:' + p.id, { kind: 'counts', th: p.id, s, likes: p.likes || 0, r: p.r || 0, rlikes: {} });
      ((c.rp || {})[p.id] || []).forEach((r, k) => {
        const rid = toUlid(r.id || p.id + ':' + k);
        put('reply:' + rid, { kind: 'reply', id: rid, th: p.id, s, u: r.u, t: r.t, parent: null, edited: !!r.edited, del: !!r.del, mod: null, createdAt: r.createdAt || created });
        (r.kids || []).forEach((x, j) => {
          const xid = toUlid(x.id || p.id + ':' + k + ':' + j);
          put('reply:' + xid, { kind: 'reply', id: xid, th: p.id, s, u: x.u, t: x.t, parent: rid, edited: !!x.edited, del: !!x.del, mod: null, createdAt: x.createdAt || created });
        });
      });
    }
    /* hidden items: their hide records (the mock's moderation states) */
    for (const [key, state] of Object.entries(c.modSt || {})) {
      if (state !== 'hidden') continue;
      const [k, th, sub] = key.split(':');
      const p = (c.posts || []).find(x => x.id === th);
      if (!p) continue;
      const item = k === 'f' ? 'followup:' + toUlid(sub) : k === 'r' ? 'reply:' + toUlid(sub) : 'thread:' + th;
      put('hide:' + item, { kind: 'hide', item, s: toUlid(p.s), ed: 0, createdAt: at });
    }
    for (const r of c.reqs || []) {
      const sp = toUlid(r.sp || 'replication');
      put('request:' + sp + ':' + r.u, { kind: 'request', sp, u: r.u, st: r.st, a: r.a || [], why: r.why == null ? null : r.why, createdAt: r.createdAt || at, updatedAt: r.updatedAt || r.createdAt || at });
    }
    return out;
  }

  const ROWS = { spaces: '/api/spaces', posts: '/api/threads', rp: '/api/replies', joined: '/api/me/memberships', roles: '/api/me/roles',
    mem: '/api/members', memOther: '/api/members/other-spaces', reqs: '/api/join-requests', pagedocs: '/api/pages',
    modSt: '/api/moderation' };

  async function load(get, now, me) {
    if (!token) {
      const d = await call('/api/test/device', { login: me });
      token = d.body && d.body.token;
    }
    await call('/api/test/clock', { now });
    await call('/api/test/fail', pendingFail || {});
    pendingFail = null;
    const c = {};
    for (const [k, path] of Object.entries(ROWS)) {
      const r = await get('GET', path);
      c[k] = r.ok ? r.body : undefined;
    }
    await call('/api/test/records', { records: convert(c, me, now), fresh: true });
  }

  /* the mock makes a new record's id when a write has none; @session/mutators takes it in the input (the
     client's ULID): the write's mutation id, a ULID of the same age */
  const MAKES = new Set(['threads.create', 'research.createPostFollowUp', 'followups.ask', 'research.forkNode', 'reports.create', 'invites.create']);
  const withId = (name, input, mid) => MAKES.has(name) && input && typeof input === 'object' && input.id == null ? { ...input, id: mid } : input;

  const NO_RESPONSE = 'no-response';
  function transport(post, onChanges, offline) {
    return {
      async register() {
        if (offline()) throw new SessionSync.Offline('offline');
        let r;
        try {
          r = await call('/api/sync/register', {});
        } catch (x) {
          throw new SessionSync.Offline('no answer');
        }
        return r.body;
      },
      async push(envelopes) {
        const out = [];
        for (const e of envelopes) {
          if (offline()) { out.push(NO_RESPONSE); break; }
          let r;
          try {
            r = await call('/api/sync/write', { ...e, input: withId(e.name, mapIds(e.input), e.mutationId) });
          } catch (x) {
            out.push(NO_RESPONSE);
            break;
          }
          const a = r.body && typeof r.body.ok === 'boolean' ? r.body : null;
          /* the page's collections: the mock runs the write the server applied */
          if (a && a.ok && !a.replayed) {
            const m = await post('/api/rpc/' + e.name, e.input).catch(() => null);
            if (m && m.body && m.body.changes) onChanges(m.body.changes);
          }
          out.push(a);
          if (a === null) break;
        }
        return out;
      },
      pull(log) { throw new Error('the mockup reads no change log (' + log + ')'); },
      snapshot(log) { throw new Error('the mockup reads no change log (' + log + ')'); },
      listen() { return Promise.resolve(); },
      async call(name, input) {
        const r = await call('/api/rpc/' + name, mapIds(input));
        return r.body;
      },
    };
  }

  let pendingFail = null;
  const failNext = (code, times) => { pendingFail = { code, times }; return call('/api/test/fail', { code, times }); };
  const config = c => call('/api/test/config', c);

  window.SessionReal = { base, load, transport, failNext, config, toUlid, convert };
})();
