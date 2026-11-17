/* Session mock API: the in-page backend for session-web-spaces.html.

   Loaded with a plain <script src> before the page's main script; it is opened from file:// and also
   published as a multi-file page, so it is a classic script that defines one global, SessionMockApi.

   Owner decisions for the backend work (they apply to this file and to the later steps):
   - The mock backend and its fixtures may move out of the HTML into separate .js files. This file holds
     the backend; the fixtures are in session-web-spaces-fixtures.js (SessionFixtures) and are passed in as
     the seed.
   - Shared spaces are the only way to organize threads; there are no per-user workspaces. Space roles
     (owner, admin, moderator, member) replace the real app's thread roles (`commenter`, `viewer`).
   - API keys are not encrypted for now.
   - Limit tracking is out of scope for the backend. API keys and space token budgets stay as they are:
     their endpoints and fields are marked `stub` with TODO comments. The backend does no token accounting.
   - Answers are not streamed; progress steps are enough.
   - There are no private threads: every thread belongs to a shared space and is visible to that space's
     members (and to anyone, in an open space).
   - Only threads in open spaces can be shared with a link; access to a closed space's threads comes
     from membership alone.
   - Ids are ULIDs, as in the real server (web/packages/db/src/ids.ts), including in thread URLs.

   Server-shaped records (step 6)
   - The mock clock: cfg.now, a fixed instant (SessionFixtures.clock), read and set through /api/dev/config.
     Records carry createdAt (an ISO instant); the server sets it on a new record that has none, and sets
     updatedAt when a list or thread record changes. The page formats both relative to the clock.
   - Ids: a record created with POST on a collection marked `serverId` gets a ULID when the body has none
     (time from the mock clock, then a counter, so runs are deterministic). The response carries it; the
     page puts it in place of its temporary id. Fixture ids (k1, rp1, …) stay as they are.
   - Derived fields: the server computes them on every read and does not store them (see DERIVED below):
     a thread's r, likes, liked and mine; a space's members and pct. GET /api/me says who is signed in.
   - Write-only fields: an API key's raw value is stored but never returned.

   Thread ids (step 2)
   - A thread (posts) is a list record with a ULID in `id`, also in thread URLs (/s/<space>/t/<id>). The
     fixture threads have fixed ULIDs: the time part is their createdAt.
   - POST /api/threads creates a thread; the server assigns its id. PUT /api/threads/:id updates one, and
     DELETE /api/threads/:id removes one (only the Screen entries' clean-up does this; a person deletes a
     thread by marking it deleted).
   - Everything that points at a thread uses its id: the keys of /api/answers, /api/answer-sources,
     /api/follow-ups, /api/replies and /api/ask-trees; the members of likes and saves; "<thread>:<node>" in
     saved asks; "<kind>:<thread>[:…]" in report and moderation keys; a notification's thread; a thread's
     from.th.

   Contents
   1. The wire codec (JSON; Sets travel as { $set: [...] }). The page uses this copy.
   2. Error codes: tRPC codes, their HTTP status, and a default user-facing message.
   3. Record schemas and a small validator (no library).
   4. Collections: how the server stores each one; derived fields; createdAt stamps.
   5. API: the contract table, one row per endpoint. The router serves only these rows.
   6. createBackend(): the in-memory database, persisted to localStorage, behind a fetch patch for /api/*.

   The real app's conventions: web/docs/03-api-and-events.md (procedures, error codes) and
   web/docs/01-architecture-decisions.md (ADR-3); wire types in web/packages/shared/src
   (wire/research.ts, types/sharing.ts, types/account.ts). */
(function () {
  'use strict';

  /* ---- 1. wire codec ---- */
  const enc = v => JSON.stringify(v, (k, x) => x instanceof Set ? { $set: [...x] } : x);
  const dec = s => JSON.parse(s, (k, x) => x && typeof x === 'object' && !Array.isArray(x) && Array.isArray(x.$set) && Object.keys(x).length === 1 ? new Set(x.$set) : x);

  /* ---- 2. error codes ----
     Error responses are { code, message } (BAD_REQUEST adds `issues`: the paths that failed validation).
     `message` is plain user-facing text; the page picks its own copy by `code`. */
  const CODES = {
    BAD_REQUEST: [400, 'The server didn’t accept this change: some of its data is missing or not valid.'],
    UNAUTHORIZED: [401, 'Your sign-in expired. Sign in again.'],
    FORBIDDEN: [403, 'You don’t have permission to do this.'],
    NOT_FOUND: [404, 'The server has no record of this item. Someone may have deleted it.'],
    METHOD_NOT_SUPPORTED: [405, 'The server doesn’t support this request.'],
    CONFLICT: [409, 'Someone else changed this item first.'],
    PRECONDITION_FAILED: [412, 'This change isn’t possible in the item’s current state.'],
    TOO_MANY_REQUESTS: [429, 'Too many requests from your account. Try again in a minute.'],
    INTERNAL_SERVER_ERROR: [500, 'The server had an error and didn’t save the change.'],
    SERVICE_UNAVAILABLE: [503, 'The server is unavailable.'],
  };
  const STATUS = Object.fromEntries(Object.entries(CODES).map(([c, [s]]) => [c, s]));

  /* ---- 3. schemas ----
     A schema is a small object; check(schema, value) returns a list of issues ({ path, expected }).
     Object schemas list their fields; a key ending in "?" is optional (absent or undefined). Fields a
     schema does not list are accepted as they are (the mockup adds display fields freely); listed fields
     must have the listed type. */
  const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?Z$/;
  const t = {
    str: { t: 'string' }, num: { t: 'number' }, bool: { t: 'boolean' }, any: { t: 'any' }, null: { t: 'null' },
    int: { t: 'integer' }, iso: { t: 'iso' },
    or: (...of) => ({ t: 'or', of }),
    nul: s => ({ t: 'or', of: [s, { t: 'null' }] }),
    arr: of => ({ t: 'array', of }),
    tup: (...of) => ({ t: 'tuple', of }),
    set: of => ({ t: 'set', of }),
    rec: of => ({ t: 'record', of }),
    obj: (fields, name) => ({ t: 'object', fields, name }),
    one: (...vs) => ({ t: 'enum', vs }),
    lazy: f => ({ t: 'lazy', f }),
    named: (name, s) => Object.assign({}, s, { name }),
  };
  function check(s, v, path = '', out = []) {
    const bad = expected => { out.push({ path: path || '(body)', expected }); return out; };
    switch (s.t) {
      case 'any': return out;
      case 'string': return typeof v === 'string' ? out : bad('string');
      case 'number': return typeof v === 'number' && Number.isFinite(v) ? out : bad('number');
      case 'integer': return Number.isInteger(v) && v >= 0 ? out : bad('integer');
      case 'iso': return typeof v === 'string' && ISO_RE.test(v) && !isNaN(Date.parse(v)) ? out : bad('ISO time');
      case 'boolean': return typeof v === 'boolean' ? out : bad('boolean');
      case 'null': return v === null ? out : bad('null');
      case 'enum': return s.vs.includes(v) ? out : bad(s.vs.map(x => JSON.stringify(x)).join(' | '));
      case 'lazy': return check(s.f(), v, path, out);
      case 'or': return s.of.some(x => !check(x, v, path).length) ? out : bad(describe(s));
      case 'array': if (!Array.isArray(v)) return bad('array'); v.forEach((x, i) => check(s.of, x, `${path}[${i}]`, out)); return out;
      case 'tuple': if (!Array.isArray(v) || v.length < s.of.length) return bad(describe(s)); s.of.forEach((x, i) => check(x, v[i], `${path}[${i}]`, out)); return out;
      case 'set': if (!(v instanceof Set)) return bad('Set'); [...v].forEach((x, i) => check(s.of, x, `${path}{${i}}`, out)); return out;
      case 'record': if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Set) return bad('object'); Object.entries(v).forEach(([k, x]) => check(s.of, x, `${path}.${k}`, out)); return out;
      case 'object': {
        if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Set) return bad(s.name || 'object');
        for (const [k0, fs] of Object.entries(s.fields)) {
          const opt = k0.endsWith('?'), k = opt ? k0.slice(0, -1) : k0;
          if (v[k] === undefined) { if (!opt) out.push({ path: `${path}.${k}`, expected: `${describe(fs)} (required)` }); continue; }
          check(fs, v[k], `${path}.${k}`, out);
        }
        return out;
      }
    }
    return bad('known schema');
  }
  /* a short type string for a schema, for the contract table and error issues */
  function describe(s, deep) {
    if (typeof s === 'string') return s;
    if (s.name && !deep) return s.name;
    switch (s.t) {
      case 'enum': return s.vs.map(x => JSON.stringify(x)).join(' | ');
      case 'or': return s.of.map(x => describe(x)).join(' | ');
      case 'array': return `${describe(s.of)}[]`;
      case 'tuple': return `[${s.of.map(x => describe(x)).join(', ')}]`;
      case 'set': return `Set<${describe(s.of)}>`;
      case 'record': return `Record<string, ${describe(s.of)}>`;
      case 'lazy': return describe(s.f());
      case 'iso': return 'ISOTime';
      case 'object': return `{ ${Object.entries(s.fields).map(([k, x]) => `${k}: ${describe(x)}`).join(', ')} }`;
      default: return s.t;
    }
  }

  const { str, num, bool, int, iso, nul, arr, tup, set, rec, obj, one, named } = t;
  const SPACE_ROLE = one('Owner', 'Admin', 'Moderator', 'Member');
  /* Fields marked "derived" are computed by the server on every read (section 4, DERIVED) and not stored. */
  const S = {};
  S.Space = obj({
    id: str, name: str, title: str, 'createdAt?': iso,
    'av?': num, 'online?': num, 'posts?': num, 'desc?': str,
    'members?': int,       /* derived: membersBase + the space's member list */
    'membersBase?': int,   /* members outside the fixtures; not returned */
    'rules?': arr(str), 'rulesPrev?': arr(str), 'rulesAt?': iso, 'rulesBy?': str,
    'pages?': arr(tup(str, iso)),   /* [title, edited at] */
    'mods?': arr(tup(str, str)), 'topics?': arr(tup(str, str)),
    'vis?': str, 'policy?': str, 'invite?': str, 'qs?': arr(obj({ q: str, 'req?': bool })),
    'faq?': bool, 'postsOff?': bool, 'plain?': bool, 'pageEdit?': str,
    'dom?': nul(obj({ domain: str, 'method?': str, 'state?': str, 'verifiedAt?': iso })),
    /* TODO(limits): stub fields, stored as sent and not checked. The space token budget and the paying
       key stay as the mockup has them; the backend does no token accounting (owner decision). pct is
       derived (used / budget). */
    'budget?': t.any, 'used?': t.any, 'pct?': t.any, 'byok?': t.any, 'key?': t.any,
  }, 'Space');
  S.Thread = obj({
    id: str, s: str, u: str, k: one('ask', 'post'), q: str, 'createdAt?': iso, 'updatedAt?': iso,
    't?': nul(str), 'sum?': nul(str), 'tok?': num,
    'r?': int,              /* derived: first-level follow-ups of an ask, or replies to a post */
    'likes?': int,          /* derived: likesBase + your like */
    'liked?': bool,         /* derived: you liked it */
    'mine?': bool,          /* derived: u is you */
    'likesBase?': int,      /* likes from people outside the fixtures; not returned. A write sets it to likes − liked. */
    'about?': t.obj({ 'it?': str, 'its?': arr(str), 'b?': num }), 'rf?': str, 'kw?': str,
    'topic?': nul(str), 'topicBy?': nul(str), 'running?': bool,
    'pay?': t.any,   /* TODO(limits): who pays for the ask (a key or a space budget), stored as sent */
    'fail?': obj({ why: str, 'at?': num }), 'edited?': bool, 'del?': bool, 'gone?': bool, 'skill?': nul(str),
    'from?': obj({ th: str, node: str }),   /* the thread and ask node it was started from */
  }, 'Thread');
  S.Reply = t.named('Reply', t.lazy(() => obj({ u: str, 'createdAt?': iso, t: str, 'likes?': int, 'kids?': arr(S.Reply), 'del?': bool, 'edited?': bool })));
  S.FollowUp = obj({ u: str, 'createdAt?': iso, q: str, 'a?': str, 'html?': str, 'del?': bool, 'edited?': bool }, 'FollowUp');
  S.AskNode = obj({ id: str, par: str, 'u?': str, 'createdAt?': iso, 'tok?': num, 'q?': str, 'html?': str, 'fu?': num, 'del?': bool, 'edited?': bool }, 'AskNode');
  S.AskTree = obj({ nodes: arr(S.AskNode) }, 'AskTree');
  S.Source = obj({
    id: str, pl: str, kind: str,
    'au?': str, 'h?': str, 'createdAt?': iso,   /* when the author published it */
    'len?': str, 'tok?': num, 'sp?': arr(str), 'url?': str,
    'sum?': str, 'body?': arr(t.obj({})), 'pub?': str, 't?': str, 'desc?': str, 'by?': str, 'paid?': num,
    'edited?': obj({ at: iso, b: num, 'old?': str }), 'deletedAt?': iso,
  }, 'Source');
  /* TODO(limits): API keys are a stub (owner decision): stored as written, not encrypted, no usage accounting.
     raw is write-only: stored, never returned (GET returns the mask). */
  S.ApiKey = obj({
    id: str, kind: str, label: str, 'createdAt?': iso,
    'mask?': str, 'provider?': str, 'raw?': str, 'valid?': bool, 'reason?': str, 'check?': str,
    'lastUsedAt?': nul(iso), 'used?': num, 'cap?': num,
  }, 'ApiKey');
  /* Notifications are structured; the page writes their text and picks their icon from `type`.
     thread: a thread's id; node: a node of its ask tree; page: an index into the
     space's pages; source and block: a source and one of its passages; report and item: a report and the key of
     the item it is about; outcome: how the report was resolved; response: your answer to an invite. */
  const NOTIFICATION_TYPES = ['follow_up', 'branch', 'answer_ready', 'answer_failed', 'invite', 'join_approved', 'join_declined',
    'page_edited', 'report_resolved', 'source_edited', 'source_asked'];
  S.Notification = obj({
    id: str, type: one(...NOTIFICATION_TYPES), 'createdAt?': iso, read: bool,
    'actor?': str, 'space?': str, 'thread?': str, 'node?': str, 'page?': int, 'source?': str, 'block?': int,
    'report?': str, 'item?': str, 'outcome?': one('dismissed', 'hidden', 'removed'), 'response?': one('accepted', 'declined'),
  }, 'Notification');
  S.JoinRequest = obj({
    u: str, st: one('open', 'approved', 'declined'), 'createdAt?': iso,
    'userCreatedAt?': iso,   /* when the applicant joined Session */
    'th?': num, 'common?': arr(str), 'bio?': str, 'a?': arr(str), 'why?': str, 'fresh?': bool, 'sp?': str,
  }, 'JoinRequest');
  S.Member = obj({ u: str, role: str, 'joinedAt?': iso }, 'Member');
  S.Ban = obj({ id: str, sp: str, u: str, 'createdAt?': iso }, 'Ban');
  S.InviteLink = obj({ id: str, code: str, by: str, sp: str, 'createdAt?': iso, 'expiresAt?': nul(iso), 'dead?': str, 'usedBy?': str }, 'InviteLink');
  S.Report = obj({ id: str, sp: str, key: str, by: str, st: one('open', 'dismissed', 'hidden', 'removed'), 'why?': str, 'note?': str, 'createdAt?': iso }, 'Report');
  S.SpaceSource = obj({ m: str, by: str, 'createdAt?': iso, 'note?': str, 'rv?': bool }, 'SpaceSource');
  S.SourceReport = obj({ m: str, sid: str, by: str, 'why?': str, 'createdAt?': iso }, 'SourceReport');
  S.Skill = named('Skill', tup(str, str));
  S.PageDoc = obj({ t: str, text: arr(str), 'by?': str, 'ed?': str, revs: arr(obj({ by: str, 'createdAt?': iso, note: str })) }, 'PageDoc');
  S.Profile = obj({ name: str, bio: str }, 'Profile');
  S.Me = obj({ u: str, name: str, bio: str, x: str, createdAt: iso }, 'Me');
  S.Invite = named('Invite', nul(obj({ sp: str, by: str, state: str })));
  /* TODO(limits): token usage is simulated in the page for the Token model variants (owner decision:
     no server-side limit tracking yet). Stored as sent. */
  S.Usage = obj({ cap: num, resetAt: iso, def: nul(str), movedSeen: bool, by: rec(rec(num)),
    skeys: rec(obj({ prov: str, mask: str, by: str, cap: num, used: num, member: num })) }, 'Usage');
  S.Settings = obj({ email: str, emailNew: nul(str), exportAt: nul(iso), emailOn: bool, types: rec(bool), spaces: rec(str) }, 'Settings');
  S.ClosedSpaceState = one('none', 'pending', 'member', 'mod', 'denied');

  /* ---- 4. collections ----
     kind: 'list' (records with an id field), 'map' (values by key), 'value' (one value, replaced whole).
     `item` is the schema of one record (list, map) or of the value. `key` checks a map key: 'thread' (a
     thread's id) or 'space' (a space id); for pages, the part before the "/" is a space id. */
  const C = {
    spaces:   { path: '/api/spaces', kind: 'list', id: 'id', item: S.Space },
    posts:    { path: '/api/threads', kind: 'list', id: 'id', serverId: true, item: S.Thread },
    rich:     { path: '/api/answers', kind: 'map', key: 'thread', item: named('AnswerHtml', str) },
    srcd:     { path: '/api/answer-sources', kind: 'map', key: 'thread', item: named('CitedPage[]', arr(arr(str))) },
    fu:       { path: '/api/follow-ups', kind: 'map', key: 'thread', item: named('FollowUp[]', arr(S.FollowUp)) },
    rp:       { path: '/api/replies', kind: 'map', key: 'thread', item: named('Reply[]', arr(S.Reply)) },
    qtd:      { path: '/api/ask-trees', kind: 'map', key: 'thread', item: S.AskTree },
    media:    { path: '/api/sources', kind: 'list', id: 'id', serverId: true, item: S.Source },
    miAdded:  { path: '/api/sources/new', kind: 'list', id: 'id', serverId: true, item: S.Source },
    joined:   { path: '/api/me/memberships', kind: 'value', item: named('SpaceId[]', arr(str)) },
    roles:    { path: '/api/me/roles', kind: 'value', item: named('Record<SpaceId, SpaceRole>', rec(SPACE_ROLE)) },
    roles0:   { path: '/api/me/roles/granted', kind: 'value', item: named('Record<SpaceId, SpaceRole>', rec(SPACE_ROLE)) },
    rel:      { path: '/api/me/closed-spaces', kind: 'map', key: 'space', item: S.ClosedSpaceState },
    liked:    { path: '/api/me/likes', kind: 'value', item: named('Set<ThreadId>', set(str)) },
    saved:    { path: '/api/me/saved', kind: 'value', item: named('Set<ThreadId>', set(str)) },
    qtSaved:  { path: '/api/me/saved-asks', kind: 'value', item: named('Set<AskNodeKey>', set(str)) },
    miSaved:  { path: '/api/me/saved-sources', kind: 'value', item: named('Set<SourceId>', set(str)) },
    miRead:   { path: '/api/me/read-sources', kind: 'value', item: named('Set<SourceId>', set(str)) },
    userKeys: { path: '/api/me/api-keys', kind: 'list', id: 'id', serverId: true, writeOnly: ['raw'], item: S.ApiKey },
    notifs:   { path: '/api/me/notifications', kind: 'list', id: 'id', serverId: true, item: S.Notification },
    askedInv: { path: '/api/me/invite-requests', kind: 'value', item: named('SpaceId[]', arr(str)) },
    invite:   { path: '/api/me/invite', kind: 'value', item: S.Invite },
    reqs:     { path: '/api/join-requests', kind: 'list', id: 'u', item: S.JoinRequest },
    mem:      { path: '/api/members', kind: 'value', space: 'replication', item: named('Member[]', arr(S.Member)) },   /* one closed space's members */
    memOther: { path: '/api/members/other-spaces', kind: 'map', key: 'space', item: named('Member[]', arr(S.Member)) },
    banned:   { path: '/api/bans', kind: 'list', id: 'id', item: S.Ban },
    links:    { path: '/api/invite-links', kind: 'list', id: 'id', serverId: true, item: S.InviteLink },
    reports:  { path: '/api/reports', kind: 'list', id: 'id', serverId: true, item: S.Report },
    modSt:    { path: '/api/moderation', kind: 'map', item: named('ModerationState', str) },
    dsDrops:  { path: '/api/space-sources', kind: 'map', key: 'space', item: named('SpaceSource[]', arr(S.SpaceSource)) },
    dsPol:    { path: '/api/space-source-policies', kind: 'map', key: 'space', item: named('SourcePolicy', str) },
    dsReps:   { path: '/api/source-reports', kind: 'value', item: named('SourceReport[]', arr(S.SourceReport)) },
    profile:  { path: '/api/me/profile', kind: 'value', item: S.Profile },
    skills:   { path: '/api/space-skills', kind: 'map', key: 'space', item: named('Skill[]', arr(S.Skill)) },
    pagedocs: { path: '/api/pages', kind: 'map', key: 'page', item: S.PageDoc },
    acct:     { path: '/api/me/settings', kind: 'value', item: S.Settings },
    muted:    { path: '/api/me/muted', kind: 'value', item: named('Set<Handle>', set(str)) },
    blocked:  { path: '/api/me/blocked', kind: 'value', item: named('Set<Handle>', set(str)) },
    usage:    { path: '/api/me/usage', kind: 'value', item: S.Usage, stub: true },
    repSeen:  { path: '/api/me/reports-seen', kind: 'value', item: bool },
    reqSeen:  { path: '/api/me/requests-seen', kind: 'value', item: bool },
    rpLiked:  { path: '/api/me/reply-likes', kind: 'value', item: named('Set<ReplyKey>', set(str)) },
  };
  /* Records nested in a value that get a createdAt (joinedAt in member lists) from the server when a write
     brings them without one. Every record of a list collection gets one too. */
  const objs = l => (Array.isArray(l) ? l : []).filter(x => x && typeof x === 'object');
  function stampTargets(k, v) {
    switch (k) {
      case 'fu': case 'dsDrops': case 'dsReps': case 'mem': case 'memOther': return objs(v);
      case 'rp': { const out = []; (function walk(l) { objs(l).forEach(x => { out.push(x); walk(x.kids); }); })(v); return out; }
      case 'qtd': return objs(v && v.nodes).filter(n => n.u);   /* asks; nodes that point at a follow-up (fu) have no time of their own */
      case 'pagedocs': return objs(v && v.revs);
    }
    return [];
  }
  const stampField = k => k === 'mem' || k === 'memOther' ? 'joinedAt' : 'createdAt';

  /* Derived fields: computed on every read from the stored records and the signed-in person, never stored.
     view(record, d, me) gives the record as GET returns it; a write drops `fields` and keeps the base that
     base(body, stored) gives; `hidden` fields are stored but not returned. */
  const firstLevel = (d, id) => d.qtd && d.qtd[id] ? d.qtd[id].nodes.filter(n => n.par === 'r').length : ((d.fu && d.fu[id]) || []).length;
  const roster = (d, sid) => (sid === C.mem.space ? d.mem : (d.memOther || {})[sid]) || [];
  const DERIVED = {
    posts: {
      fields: ['r', 'likes', 'liked', 'mine'], hidden: ['likesBase'],
      view: (p, d, me) => {
        const liked = !!(d.liked && d.liked.has(p.id));
        return { ...p, r: p.k === 'ask' ? firstLevel(d, p.id) : ((d.rp && d.rp[p.id]) || []).length, likes: (p.likesBase || 0) + (liked ? 1 : 0), liked, mine: p.u === me.u };
      },
      /* the client sends the thread as it holds it: likes and liked from its last read, so likes − liked is the base */
      base: (b, stored) => ({ likesBase: typeof b.likes === 'number' ? Math.max(0, b.likes - (b.liked ? 1 : 0)) : stored ? stored.likesBase || 0 : 0 }),
    },
    spaces: {
      fields: ['members', 'pct'], hidden: ['membersBase'],
      view: (s, d) => ({ ...s, members: (s.membersBase || 0) + roster(d, s.id).length, pct: s.budget ? s.used / s.budget : 0 }),
      /* a new space starts with no members outside its member list */
      base: (b, stored) => ({ membersBase: stored ? stored.membersBase || 0 : 0 }),
    },
  };

  /* ---- 5. the API contract ----
     One row per endpoint: method, path pattern (":id" is one URL-encoded segment), the collection, the
     operation, input and output shape, the errors it can return, who may call it, the target tRPC
     procedure in the real app, and the wire type in web/packages/shared where one exists.

     who: 'guest' (signed out), 'user' (any signed-in user; /api/me/* rows are scoped to the caller),
     'author' (the record's author), 'member' | 'moderator' | 'admin' | 'owner' (a role in the record's
     space; a higher role includes the lower ones), 'server' (written by an agent run or by the server in
     the real app; the mockup's client writes it only because the mock has no runs). Documented now,
     enforced in step 5.
     errors: the codes the row can return. UNAUTHORIZED and FORBIDDEN follow from `who` and are enforced
     in step 5. In dev, /api/dev/config can force any code on any row.
     trpc: the procedure in web/docs/03-api-and-events.md where one exists, otherwise a new name in the
     same style. Rows marked `bulk` replace a whole collection: the page's diff sends one when records move
     or several change at once; the real app sends one mutation per change instead.
     stub: TODO(limits) rows: API keys and space token budgets, kept as they are, without accounting. */
  const OPS = {
    list:    { method: 'GET', sub: '', errors: [] },
    get:     { method: 'GET', sub: '/:id', errors: ['NOT_FOUND'] },
    replace: { method: 'PUT', sub: '', errors: ['BAD_REQUEST'], bulk: true },
    create:  { method: 'POST', sub: '', errors: ['BAD_REQUEST', 'CONFLICT'] },
    put:     { method: 'PUT', sub: '/:id', errors: ['BAD_REQUEST', 'NOT_FOUND'] },
    delete:  { method: 'DELETE', sub: '/:id', errors: ['NOT_FOUND'] },
  };
  const ROLE_RANK = { guest: 0, user: 1, author: 2, member: 2, moderator: 3, admin: 4, owner: 5, server: 6 };
  const shapeOf = (coll, op) => {
    const c = C[coll], one = describe(c.item);
    const many = c.kind === 'list' ? `${one}[]` : c.kind === 'map' ? `Record<string, ${one}>` : one;
    return {
      list: [null, many], get: [null, one], replace: [many, many], create: [one, one], put: [one, one],
      delete: [null, null],
    }[op];
  };
  /* row(coll, op, who, trpc, extra): one endpoint */
  const row = (coll, op, who, trpc, extra = {}) => {
    const o = OPS[op], c = C[coll], [input, output] = shapeOf(coll, op);
    const errors = [...new Set([...o.errors, ...(extra.errors || []),
      ...(ROLE_RANK[who] >= ROLE_RANK.user ? ['UNAUTHORIZED'] : []), ...(ROLE_RANK[who] >= ROLE_RANK.author ? ['FORBIDDEN'] : [])])];
    return Object.assign({ method: o.method, path: c.path + o.sub, coll, op, input, output, who, trpc, wire: null, bulk: !!o.bulk }, extra, { errors });
  };
  const API = [
    /* spaces: TODO(limits) budget, used, pct and byok on a space are stub fields (see S.Space) */
    row('spaces', 'list', 'guest', 'spaces.list', { note: 'listed and joined spaces; a guest gets the listed ones' }),
    row('spaces', 'replace', 'owner', 'spaces.reorder'),
    row('spaces', 'create', 'user', 'spaces.create'),
    row('spaces', 'put', 'admin', 'spaces.update', { stub: true, note: 'TODO(limits): the token budget fields are stored as sent' }),
    row('spaces', 'delete', 'owner', 'spaces.remove'),

    /* threads: addressed by id (a ULID). r, likes, liked and mine are derived on read. */
    row('posts', 'list', 'guest', 'research.listTrees', { wire: 'ResearchTreeSummary[]' }),
    row('posts', 'get', 'guest', 'research.getTree', { wire: 'ResearchTreeDetail' }),
    row('posts', 'replace', 'moderator', 'threads.moveToTopic', { note: 'a moderator moves several threads at once (deleted topics)' }),
    row('posts', 'create', 'member', ['research.createTree', 'research.createPost'], { wire: 'ResearchTree', note: 'the server assigns the id (a ULID)' }),
    row('posts', 'put', 'author', 'research.updatePost', { wire: 'ResearchTree', note: 'the author edits; moderators move or remove; the run sets the answer state' }),
    row('posts', 'delete', 'author', 'research.deleteTree', { note: 'only the Screen entries’ clean-up removes threads; a person deletes a thread by marking it deleted' }),

    row('rich', 'list', 'guest', 'research.getNodeContent', { wire: 'ResearchNodeContent' }),
    row('rich', 'get', 'guest', 'research.getNodeContent', { wire: 'ResearchNodeContent' }),
    row('rich', 'put', 'server', null, { note: 'written by the run; the real app sends research.node.* events' }),
    row('rich', 'delete', 'server', null, { note: 'cleared when an ask runs again (research.rerunNode)' }),
    row('srcd', 'list', 'guest', 'research.getNodeContent', { wire: 'ResearchNodeContent' }),
    row('srcd', 'put', 'server', null, { note: 'written by the run' }),
    row('srcd', 'delete', 'server', null),
    row('fu', 'list', 'guest', 'followups.list'),
    row('fu', 'put', 'member', 'followups.ask', { wire: 'ResearchExchangeNode', note: 'the thread’s follow-up asks, replaced whole' }),
    row('fu', 'delete', 'author', 'research.removeBranch', { wire: 'ResearchBranchRemoval' }),
    row('rp', 'list', 'guest', 'research.getTree'),
    row('rp', 'put', 'member', 'research.createPostFollowUp', { wire: 'ResearchPostNode', note: 'the thread’s replies, replied to, edited or deleted by their authors' }),
    row('rp', 'delete', 'author', 'research.removeBranch', { wire: 'ResearchBranchRemoval' }),
    row('qtd', 'list', 'guest', 'research.getTree', { wire: 'ResearchTreeDetail' }),
    row('qtd', 'replace', 'server', 'threads.resetAskTrees'),
    row('qtd', 'put', 'member', 'research.forkNode', { wire: 'ResearchNode' }),
    row('qtd', 'delete', 'author', 'research.removeBranch', { wire: 'ResearchBranchRemoval' }),

    row('media', 'list', 'guest', 'sources.list'),
    row('media', 'replace', 'moderator', 'sources.updateMany'),
    row('media', 'create', 'member', 'sources.create'),
    row('media', 'put', 'moderator', 'sources.update'),
    row('media', 'delete', 'moderator', 'sources.remove'),
    row('miAdded', 'list', 'user', 'sources.listNew'),
    row('miAdded', 'replace', 'user', 'sources.resetNew'),
    row('miAdded', 'create', 'member', 'sources.create'),
    row('miAdded', 'put', 'author', 'sources.update'),
    row('miAdded', 'delete', 'author', 'sources.remove'),

    row('joined', 'list', 'user', 'spaces.listJoined'),
    row('joined', 'replace', 'user', ['spaces.join', 'spaces.leave'], { errors: ['FORBIDDEN'] }),
    row('roles', 'list', 'user', 'spaces.myRoles'),
    row('roles', 'replace', 'admin', 'members.setRole'),
    row('roles0', 'list', 'user', 'spaces.myRoles'),
    row('roles0', 'replace', 'owner', 'members.setRole'),
    row('rel', 'list', 'user', 'spaces.myClosedSpaces'),
    row('rel', 'put', 'user', ['joinRequests.create', 'spaces.join'], { note: 'none, pending, member, mod or denied' }),
    row('rel', 'delete', 'user', 'spaces.leave'),
    row('liked', 'list', 'user', 'likes.list'),
    row('liked', 'replace', 'user', 'likes.set'),
    row('saved', 'list', 'user', 'saves.list'),
    row('saved', 'replace', 'user', 'saves.set'),
    row('qtSaved', 'list', 'user', 'saves.list'),
    row('qtSaved', 'replace', 'user', 'saves.set'),
    row('miSaved', 'list', 'user', 'saves.list'),
    row('miSaved', 'replace', 'user', 'saves.set'),
    row('miRead', 'list', 'user', 'sources.listRead'),
    row('miRead', 'replace', 'user', 'sources.markRead'),

    /* TODO(limits): API keys are a stub: stored as sent (no encryption, no usage accounting). raw is write-only. */
    row('userKeys', 'list', 'user', 'apiKeys.list', { stub: true, note: 'masked keys only: raw is never returned' }),
    row('userKeys', 'replace', 'user', 'apiKeys.replaceAll', { stub: true }),
    row('userKeys', 'create', 'user', 'apiKeys.add', { stub: true, note: 'the server assigns the id; CONFLICT when the same raw key exists' }),
    row('userKeys', 'put', 'user', ['apiKeys.rename', 'apiKeys.replace', 'apiKeys.setCap', 'apiKeys.check'], { stub: true }),
    row('userKeys', 'delete', 'user', 'apiKeys.revoke', { stub: true }),

    row('notifs', 'list', 'user', 'notifications.list', { wire: 'InboxNotificationPage' }),
    row('notifs', 'replace', 'user', 'notifications.markAllRead'),
    row('notifs', 'create', 'server', null, { wire: 'InboxNotification', note: 'the real server creates notifications (notification.requested); the page still posts the ones that follow an ask run or a resolved report, as structured records, and the server assigns the id' }),
    row('notifs', 'put', 'user', 'notifications.markRead', { wire: 'InboxNotification' }),
    row('notifs', 'delete', 'user', 'notifications.remove'),
    row('askedInv', 'list', 'user', 'invites.listRequested'),
    row('askedInv', 'replace', 'user', 'invites.request'),
    row('invite', 'list', 'user', 'invites.received', { wire: 'ReceivedInvite' }),
    row('invite', 'replace', 'user', 'invites.accept', { errors: ['NOT_FOUND'] }),

    row('reqs', 'list', 'moderator', 'joinRequests.list'),
    row('reqs', 'replace', 'moderator', 'joinRequests.decideMany'),
    row('reqs', 'create', 'user', 'joinRequests.create'),
    row('reqs', 'put', 'moderator', 'joinRequests.decide'),
    row('reqs', 'delete', 'author', 'joinRequests.withdraw'),
    row('mem', 'list', 'member', 'sharing.listMembers', { wire: 'ThreadMember[]', note: 'space roles replace commenter and viewer' }),
    row('mem', 'replace', 'admin', ['sharing.setRole', 'sharing.removeMember'], { wire: 'ThreadMember[]' }),
    row('memOther', 'list', 'member', 'sharing.listMembers', { wire: 'ThreadMember[]' }),
    row('memOther', 'put', 'admin', ['sharing.setRole', 'sharing.removeMember'], { wire: 'ThreadMember[]' }),
    row('memOther', 'delete', 'admin', 'sharing.removeMember'),
    row('banned', 'list', 'moderator', 'bans.list'),
    row('banned', 'replace', 'moderator', 'bans.removeMany'),
    row('banned', 'create', 'moderator', 'bans.create'),
    row('banned', 'put', 'moderator', 'bans.update'),
    row('banned', 'delete', 'moderator', 'bans.remove'),
    row('links', 'list', 'moderator', 'invites.list', { wire: 'ThreadInvite[]' }),
    row('links', 'replace', 'moderator', 'invites.revokeMany'),
    row('links', 'create', 'moderator', 'invites.create', { wire: 'CreatedInvite' }),
    row('links', 'put', 'moderator', 'invites.update', { wire: 'ThreadInvite' }),
    row('links', 'delete', 'moderator', 'invites.revoke', { wire: 'ThreadInvite' }),
    row('reports', 'list', 'moderator', 'reports.list'),
    row('reports', 'replace', 'moderator', 'reports.resetQueue'),
    row('reports', 'create', 'member', 'reports.create'),
    row('reports', 'put', 'moderator', 'reports.resolve'),
    row('reports', 'delete', 'moderator', 'reports.remove'),
    row('modSt', 'list', 'moderator', 'moderation.list'),
    row('modSt', 'put', 'moderator', 'moderation.decide', { note: 'removed, hidden or kept' }),
    row('modSt', 'delete', 'moderator', 'moderation.undo'),

    row('dsDrops', 'list', 'guest', 'spaceSources.list'),
    row('dsDrops', 'put', 'member', ['spaceSources.add', 'spaceSources.review'], { note: 'members add; moderators approve or remove' }),
    row('dsDrops', 'delete', 'moderator', 'spaceSources.clear'),
    row('dsPol', 'list', 'guest', 'spaceSources.policies'),
    row('dsPol', 'put', 'admin', 'spaceSources.setPolicy'),
    row('dsPol', 'delete', 'admin', 'spaceSources.setPolicy'),
    row('dsReps', 'list', 'moderator', 'sourceReports.list'),
    row('dsReps', 'replace', 'member', ['sourceReports.create', 'sourceReports.resolve']),
    row('profile', 'list', 'user', 'profile.get', { wire: 'User' }),
    row('profile', 'replace', 'user', 'profile.update'),
    row('skills', 'list', 'guest', 'skills.list'),
    row('skills', 'put', 'moderator', ['skills.create', 'skills.update', 'skills.remove', 'skills.reorder']),
    row('skills', 'delete', 'moderator', 'skills.removeAll'),
    row('pagedocs', 'list', 'guest', 'pages.list'),
    row('pagedocs', 'put', 'member', ['pages.create', 'pages.update', 'pages.restore'], { errors: ['CONFLICT'], note: 'who may edit follows the space’s pageEdit setting; CONFLICT when the page changed since it was opened (checked in step 5)' }),
    row('pagedocs', 'delete', 'moderator', 'pages.remove'),
    row('acct', 'list', 'user', 'settings.get', { wire: 'UserSettings' }),
    row('acct', 'replace', 'user', 'settings.update', { wire: 'UserSettings' }),
    row('usage', 'list', 'user', 'usage.get', { stub: true, note: 'TODO(limits): token usage by source and space; space keys (Token model variant D)' }),
    row('usage', 'replace', 'user', ['usage.setDefaultKey', 'spaceKeys.set'], { stub: true, note: 'TODO(limits): the page computes usage; the server stores it as sent' }),
    row('muted', 'list', 'user', 'mutes.list'),
    row('muted', 'replace', 'user', 'mutes.set'),
    row('blocked', 'list', 'user', 'blocks.list'),
    row('blocked', 'replace', 'user', 'blocks.set'),
    row('repSeen', 'list', 'moderator', 'notifications.unreadCount'),
    row('repSeen', 'replace', 'moderator', 'notifications.markRead'),
    row('reqSeen', 'list', 'moderator', 'notifications.unreadCount'),
    row('reqSeen', 'replace', 'moderator', 'notifications.markRead'),
    row('rpLiked', 'list', 'user', 'likes.list'),
    row('rpLiked', 'replace', 'user', 'likes.set'),

    { method: 'GET', path: '/api/me', coll: null, op: 'me', input: null, output: 'Me', who: 'user', trpc: 'auth.me', wire: 'User', errors: ['UNAUTHORIZED'],
      note: 'the signed-in person; the server uses it for mine and liked' },

    /* development only: not part of the product API */
    { method: 'POST', path: '/api/dev/reset', coll: null, op: 'dev-reset', input: null, output: null, who: 'guest', trpc: null, wire: null, errors: [], dev: true, note: 'back to the seed data' },
    { method: 'GET', path: '/api/dev/config', coll: null, op: 'dev-config', input: null, output: 'DevConfig', who: 'guest', trpc: null, wire: null, errors: [], dev: true },
    { method: 'PUT', path: '/api/dev/config', coll: null, op: 'dev-config', input: 'Partial<DevConfig>', output: 'DevConfig', who: 'guest', trpc: null, wire: null, errors: ['BAD_REQUEST'], dev: true,
      note: 'DevConfig: { now (the mock clock, an ISO time), latency, failWrites, failReads, failCode, failOn: { code, paths: string[], methods?: string[], times? } | null }' },
  ];
  /* match a request to a row: literal segments win over ":id" */
  const segs = p => p.split('/').filter(Boolean);
  const ROUTES = API.map(r => ({ r, s: segs(r.path) })).sort((a, b) => a.s.filter(x => x[0] === ':').length - b.s.filter(x => x[0] === ':').length);
  function matchPath(path) {
    const ps = segs(path), hits = [];
    for (const { r, s } of ROUTES) {
      if (s.length !== ps.length) continue;
      let id, ok = true;
      for (let i = 0; i < s.length && ok; i++) { if (s[i] === ':id') id = ps[i]; else ok = s[i] === ps[i]; }
      if (ok) hits.push({ r, id: id === undefined ? undefined : decodeURIComponent(id) });
    }
    return hits;
  }

  /* ---- 6. the backend ----
     createBackend({ fixtures, seed, storageKey, latency, dev }):
     - fixtures: SessionFixtures ({ clock, me, data }): the seed data, the mock clock's start and the signed-in
       person. seed() can give the data instead (then the clock starts at the real time).
     - storageKey: the localStorage key. The stored database is kept while the seed's hash is the same.
     - latency: each request waits this long (ms).
     - dev: report contract mismatches (console.error, and an uncaught error so test harnesses fail).
     Returns { cfg, wipe, restore, checkClient, seedView }. */
  const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
  const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   /* Crockford base32, as in ULIDs */
  /* a ULID: 10 characters of time (ms) and 16 of a counter instead of random bits, so runs are deterministic */
  function ulid(ms, n) {
    let t = '', r = '';
    for (let i = 0, x = ms; i < 10; i++, x = Math.floor(x / 32)) t = B32[x % 32] + t;
    for (let i = 0, x = n; i < 16; i++, x = Math.floor(x / 32)) r = B32[x % 32] + r;
    return t + r;
  }
  const omit = (o, ks) => { if (!ks || !ks.some(k => k in o)) return o; const x = { ...o }; ks.forEach(k => delete x[k]); return x; };
  function createBackend({ fixtures, seed, storageKey = 'session-mock-db-v5', latency = 120, dev = false }) {
    const fx = fixtures || { data: seed ? seed() : {} };
    const me = fx.me || { u: 'me', x: '@me', createdAt: new Date().toISOString() };
    const cfg = { now: fx.clock || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), base: latency, latency, failWrites: false, failReads: false, failCode: 'SERVICE_UNAVAILABLE', failOn: null };
    const log = window.__mockApiLog = [];
    const LOG_MAX = 400;   /* the newest requests; `seq` counts every request, so a test can take the ones after a mark */
    let seq = 0;
    let data = null, ids = 0, ver = null;   /* ids: how many ids the server has made (the ULID counter) */
    const fail = msg => { console.error('[mock api] ' + msg); if (dev) setTimeout(() => { throw new Error('[mock api] ' + msg); }); };
    const seedData = () => { const s = fixtures ? fixtures.data : seed(), o = {}; for (const k of Object.keys(C)) if (k in s) o[k] = s[k]; return dec(enc(o)); };
    const version = () => { if (ver) return ver; const t = enc({ seed: seedData(), clock: fx.clock || null, me }); let x = 2166136261; for (let i = 0; i < t.length; i++) { x ^= t.charCodeAt(i); x = Math.imul(x, 16777619); } return (ver = (x >>> 0).toString(36) + ':' + t.length); };
    const db0 = () => {
      if (data) return data;
      try { const s = localStorage.getItem(storageKey); if (s) { const o = dec(s); if (o && o.v === version()) { ids = o.ids || 0; return (data = o.data); } } } catch (e) {}
      data = seedData(); ids = 0;
      if (dev) checkSeed(data);
      return data;
    };
    const save = () => { try { localStorage.setItem(storageKey, enc({ v: version(), ids, data })); } catch (e) {} };
    const out = (status, body) => new Response(body === undefined ? null : enc(body), { status, headers: { 'Content-Type': 'application/json' } });
    const err = (code, message, extra) => { const r = out(STATUS[code], Object.assign({ code, message: message || CODES[code][1] }, extra)); r.code = code; r.issues = extra && extra.issues; return r; };
    const bad = issues => err('BAD_REQUEST', undefined, { issues: issues.slice(0, 5).map(i => `${i.path}: expected ${i.expected}`) });
    const newId = () => ulid(Date.parse(cfg.now), ++ids);

    /* ---- reads: the stored record with its derived fields, without its hidden and write-only fields ---- */
    function viewOne(k, x, d) {
      const V = DERIVED[k];
      if (V) x = omit(V.view(x, d, me), V.hidden);
      return omit(x, C[k].writeOnly);
    }
    const viewAll = (k, d) => C[k].kind === 'list' ? d[k].map(x => viewOne(k, x, d)) : d[k];
    /* ---- writes ---- */
    /* nested records without a time get the clock's (createdAt; joinedAt in member lists) */
    function stampValue(k, v) { const f = stampField(k); stampTargets(k, v).forEach(x => { if (x[f] === undefined) x[f] = cfg.now; }); return v; }
    /* a list record as the client sends it → as the server stores it */
    function storeRecord(k, body, stored) {
      let rec = { ...body };
      const V = DERIVED[k];
      if (V) { V.fields.forEach(f => delete rec[f]); Object.assign(rec, V.base(body, stored)); }
      for (const f of C[k].writeOnly || []) if (rec[f] === undefined && stored && stored[f] !== undefined) rec[f] = stored[f];
      if (rec.createdAt === undefined) rec.createdAt = (stored && stored.createdAt) || cfg.now;
      if (stored) {
        const { updatedAt: a, ...was } = stored, { updatedAt: b, ...next } = rec;
        if (enc(was) !== enc(next)) rec.updatedAt = cfg.now; else if (a !== undefined) rec.updatedAt = a; else delete rec.updatedAt;
      }
      return rec;
    }

    /* the dev check of the seed: every record must pass its collection's schema */
    function checkSeed(d) {
      for (const [k, c] of Object.entries(C)) {
        if (!(k in d)) { fail(`no seed data for ${k} (${c.path})`); continue; }
        const issues = checkWhole(k, d[k], d, true);
        if (issues.length) fail(`seed data for ${k} fails its schema: ${issues.slice(0, 3).map(i => `${i.path}: expected ${i.expected}`).join('; ')}`);
      }
    }
    /* the schema of a whole collection, with id and key checks. Unique ids are required of the seed only:
       the page sends whole notification lists that hold the same id twice (np-notifs, np-invite). */
    function checkWhole(k, v, d, unique) {
      const c = C[k];
      if (c.kind === 'value') return check(c.item, v, k);
      if (c.kind === 'map') {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return [{ path: k, expected: 'object' }];
        return Object.entries(v).flatMap(([key, x]) => [...checkKey(k, key, d, 'BAD_REQUEST').map(m => ({ path: `${k}.${key}`, expected: m })), ...check(c.item, x, `${k}.${key}`)]);
      }
      if (!Array.isArray(v)) return [{ path: k, expected: 'array' }];
      const issues = v.flatMap((x, i) => check(c.item, x, `${k}[${i}]`));
      if (c.kind === 'list' && unique) { const seen = new Set(); v.forEach((x, i) => { const id = x && x[c.id]; if (id != null && seen.has(String(id))) issues.push({ path: `${k}[${i}].${c.id}`, expected: 'an id not used by another record' }); seen.add(String(id)); }); }
      return issues;
    }
    /* a map key: returns [] when it is fine, or a list of messages */
    function checkKey(k, key, d, mode) {
      const c = C[k];
      if (!key) return ['a key'];
      if (c.key === 'thread') { if (!ULID_RE.test(key)) return ['a thread id (a ULID)']; if (mode === 'NOT_FOUND' && !(d.posts || []).some(p => p.id === key)) return ['NOT_FOUND']; }
      if (c.key === 'space' || c.key === 'page') {
        const sid = c.key === 'page' ? key.split('/')[0] : key;
        if (c.key === 'page' && !/^[^/]+\/./.test(key)) return ['"<space>/<page>"'];
        if (mode === 'NOT_FOUND' && !(d.spaces || []).some(s => s.id === sid)) return ['NOT_FOUND'];
      }
      return [];
    }
    function forced(method, path) {
      const f = cfg.failOn;
      if (f && f.code && (!f.methods || f.methods.includes(method)) && (f.paths || ['']).some(p => path.startsWith(p))) {
        if (typeof f.times === 'number') { f.times -= 1; if (f.times <= 0) cfg.failOn = null; }
        return f.code;
      }
      if (method === 'GET' ? cfg.failReads : cfg.failWrites) return cfg.failCode || 'SERVICE_UNAVAILABLE';
      return null;
    }

    function handle(method, url, body) {
      const [path, qs] = url.split('?');
      const hits = matchPath(path);
      if (!hits.length) { fail(`no API entry for ${method} ${path}`); return { res: err('NOT_FOUND', 'The server has no address like this.') }; }
      const hit = hits.find(h => h.r.method === method);
      if (!hit) return { res: err('METHOD_NOT_SUPPORTED') };
      const { r, id } = hit;
      if (r.dev) {
        if (r.op === 'dev-reset') { data = seedData(); ids = 0; save(); return { res: out(204) }; }
        if (method === 'PUT') {
          if (!body || typeof body !== 'object') return { res: err('BAD_REQUEST') };
          if (body.failCode && !CODES[body.failCode]) return { res: err('BAD_REQUEST', undefined, { issues: ['failCode: expected one of ' + Object.keys(CODES).join(', ')] }) };
          if (body.failOn && !CODES[body.failOn.code]) return { res: err('BAD_REQUEST', undefined, { issues: ['failOn.code: expected one of ' + Object.keys(CODES).join(', ')] }) };
          if (body.now !== undefined && check(t.iso, body.now).length) return { res: err('BAD_REQUEST', undefined, { issues: ['now: expected an ISO time such as 2026-11-16T10:00:00Z'] }) };
          Object.assign(cfg, body);
        }
        return { res: out(200, cfg) };
      }
      const f = forced(method, path);
      if (f) return { res: err(f), forced: true };
      const d = db0();
      if (r.op === 'me') return { res: out(200, { u: me.u, name: d.profile.name, bio: d.profile.bio, x: me.x, createdAt: me.createdAt }) };
      const k = r.coll, c = C[k];
      const pos = cur => cur.findIndex(x => String(x[c.id]) === id);
      switch (r.op) {
        case 'list': return { res: out(200, viewAll(k, d)) };
        case 'get': {
          const cur = d[k];
          if (c.kind === 'map') return { res: cur[id] === undefined ? err('NOT_FOUND') : out(200, cur[id]) };
          const i = pos(cur);
          return { res: cur[i] === undefined ? err('NOT_FOUND') : out(200, viewOne(k, cur[i], d)) };
        }
        case 'replace': {
          const issues = checkWhole(k, body, d);
          if (issues.length) return { res: bad(issues) };
          if (c.kind === 'list') {
            const cur = d[k];
            d[k] = body.map(x => storeRecord(k, x, cur.find(y => String(y[c.id]) === String(x[c.id]))));
          } else if (c.kind === 'map') { Object.values(body).forEach(v => stampValue(k, v)); d[k] = body; }
          else d[k] = stampValue(k, body);
          save(); return { res: out(200, viewAll(k, d)) };
        }
        case 'create': {
          /* a new record without an id gets a ULID */
          if (c.serverId && body && typeof body === 'object' && !Array.isArray(body) && body[c.id] == null) body = { [c.id]: newId(), ...body };
          const issues = check(c.item, body, k);
          if (issues.length) return { res: bad(issues) };
          if (d[k].some(x => String(x[c.id]) === String(body[c.id]))) return { res: err('CONFLICT', 'An item with this id already exists.') };
          if ((c.writeOnly || []).includes('raw') && body.raw && d[k].some(x => x.raw === body.raw)) return { res: err('CONFLICT', 'This key has already been added.') };
          const rec = storeRecord(k, body);
          d[k] = qs === 'at=start' ? [rec, ...d[k]] : [...d[k], rec]; save();
          return { res: out(201, viewOne(k, rec, d)) };
        }
        case 'put': {
          const cur = d[k];
          if (c.kind === 'map') {
            const kb = checkKey(k, id, d, 'BAD_REQUEST'); if (kb.length) return { res: bad(kb.map(m => ({ path: `${k} key "${id}"`, expected: m }))) };
            const issues = check(c.item, body, `${k}.${id}`); if (issues.length) return { res: bad(issues) };
            if (checkKey(k, id, d, 'NOT_FOUND').length) return { res: err('NOT_FOUND') };
            cur[id] = stampValue(k, body); save(); return { res: out(200, cur[id]) };
          }
          const issues = check(c.item, body, `${k}[${id}]`); if (issues.length) return { res: bad(issues) };
          if (String(body[c.id]) !== id) return { res: bad([{ path: `${k}[${id}].${c.id}`, expected: `"${id}" (the id in the address)` }]) };
          const i = pos(cur);
          if (i < 0) return { res: err('NOT_FOUND') };
          cur[i] = storeRecord(k, body, cur[i]);
          save(); return { res: out(200, viewOne(k, cur[i], d)) };
        }
        case 'delete': {
          const cur = d[k];
          if (c.kind === 'map') { if (!(id in cur)) return { res: err('NOT_FOUND') }; delete cur[id]; } else { const i = pos(cur); if (i < 0) return { res: err('NOT_FOUND') }; cur.splice(i, 1); }
          save(); return { res: out(204) };
        }
      }
      return { res: err('INTERNAL_SERVER_ERROR') };
    }

    const realFetch = window.fetch;
    window.fetch = (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.startsWith('/api/')) return realFetch.call(window, input, init);
      const method = (init.method || 'GET').toUpperCase();
      return new Promise(resolve => setTimeout(() => {
        let res, forcedErr = false;
        try { const body = init.body ? dec(init.body) : undefined; ({ res, forced: forcedErr } = handle(method, url, body)); }
        catch (e) { console.error('[mock api]', e); res = err('INTERNAL_SERVER_ERROR'); }
        const entry = { seq: ++seq, method, path: url.split('?')[0], status: res.status, code: null };
        if (!res.ok) { entry.code = res.code || null; if (forcedErr) entry.forced = true; }
        log.push(entry); if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
        if (dev && !res.ok && !forcedErr) console.error(`[mock api] ${method} ${entry.path}: ${res.status} ${entry.code}${res.issues ? ' (' + res.issues.join('; ') + ')' : ''}`);
        resolve(res);
      }, cfg.latency));
    };

    /* the page's resource table must match the contract: every collection it loads needs API rows with
       the same path, kind and id field */
    function checkClient(res) {
      for (const [k, r] of Object.entries(res)) {
        const c = C[k];
        if (!c || !API.some(a => a.coll === k)) { fail(`collection ${k} (${r.url}) has no entries in the API table`); continue; }
        if (c.path !== r.url || c.kind !== r.kind || (c.kind === 'list' && c.id !== r.id)) fail(`collection ${k}: the page declares ${r.url} (${r.kind}${r.id ? ', id ' + r.id : ''}); the API table has ${c.path} (${c.kind}${c.id ? ', id ' + c.id : ''})`);
      }
    }
    return {
      cfg,
      checkClient,
      wipe: () => { data = null; ids = 0; try { localStorage.removeItem(storageKey); } catch (e) {} },
      restore: () => { window.fetch = realFetch; },
      /* the seed data as GET returns it (derived fields included), without touching the database: the
         page's Screen entries restore these baselines */
      seedView: () => { const d = seedData(); return dec(enc(Object.fromEntries(Object.keys(d).map(k => [k, viewAll(k, d)])))); },
    };
  }

  window.SessionMockApi = { enc, dec, CODES, STATUS, API, COLLECTIONS: C, SCHEMAS: S, NOTIFICATION_TYPES, check, describe, ulid, createBackend };
})();
