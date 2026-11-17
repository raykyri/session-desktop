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
   - Limit tracking is out of scope for the backend. API keys and token usage stay as they are: their
     endpoints and fields are marked `stub` with TODO comments. The backend does no token accounting.
   - Token model: included tokens pay for asks first, then the person's default API key. Spaces have no
     token budget.
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
   - Ids: a record created on a collection marked `serverId` gets a ULID when it has none (time from the
     mock clock, then a counter, so runs are deterministic; the counter is not reset by a scenario). The
     answer carries it; the page puts it in place of its temporary id. Fixture ids (k1, rp1, …) stay as
     they are.
   - Derived fields: the server computes them on every read and does not store them (see DERIVED below):
     a thread's r, likes, liked and mine; a space's members. GET /api/me says who is signed in.
   - Write-only fields: an API key's raw value is stored but never returned.

   Thread ids (step 2)
   - A thread (posts) is a list record with a ULID in `id`, also in thread URLs (/s/<space>/t/<id>). The
     fixture threads have fixed ULIDs: the time part is their createdAt.
   - threads.create (POST /api/rpc/threads.create) creates a thread; the server assigns its id. A person
     deletes a thread by marking it deleted (threads.delete). PUT /api/threads/:id is left for the ask
     pipeline (the answer's state, until step 7).
   - Everything that points at a thread uses its id: the keys of /api/answers, /api/answer-sources,
     /api/follow-ups, /api/replies and /api/ask-trees; the members of likes and saves; "<thread>:<node>" in
     saved asks; "<kind>:<thread>[:…]" in report and moderation keys; a notification's thread; a thread's
     from.th.

   Mutations by intent (step 3)
   - A person's action is one procedure: POST /api/rpc/<name> (tRPC-style names, as in the real app's
     routers), answered with { result, changes }. The server validates the input, checks that the records
     exist, computes the new state (ids, counts, member lists, notifications it sends, memberships, roles),
     writes every collection it changes at once (all or none) and returns the changed records. See 5b.
   - The collection write rows stay only for the page's ask pipeline (scope 'run', until step 7) and the
     token-usage stub (scope 'stub').

   Scenarios (step 10)
   - The Screen entries set up their data with POST /api/dev/scenario { name, args? }: the server goes back
     to the seed and runs a named scenario (session-web-spaces-scenarios.js, SessionScenarios) in one
     transaction, and answers { changes } as a procedure does. See createBackend (section 6).

   Contents
   1. The wire codec (JSON; Sets travel as { $set: [...] }). The page uses this copy.
   2. Error codes: tRPC codes, their HTTP status, and a default user-facing message.
   3. Record schemas and a small validator (no library).
   4. Collections: how the server stores each one; derived fields; createdAt stamps.
   5. API: the contract table, one row per endpoint. The router serves only these rows.
      5b. Procedures: the mutations, their transaction helper, and their rows in the table.
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
    'pay?': t.any,   /* TODO(limits): who pays for the ask ('session' for the included tokens, or a key id), stored as sent */
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
  /* TODO(limits): token usage is simulated in the page (owner decision: no server-side limit tracking yet).
     Stored as sent. by: tokens this month per source ('session' or a key id) and space; cap: the included
     tokens a month; def: the default key, which pays after the included tokens run out. */
  S.Usage = obj({ cap: num, resetAt: iso, def: nul(str), movedSeen: bool, 'fresh?': bool, by: rec(rec(num)) }, 'Usage');
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
      base: (b, stored) => ({ likesBase: typeof b.likesBase === 'number' ? b.likesBase : typeof b.likes === 'number' ? Math.max(0, b.likes - (b.liked ? 1 : 0)) : stored ? stored.likesBase || 0 : 0 }),
    },
    spaces: {
      fields: ['members'], hidden: ['membersBase'],
      view: (s, d) => ({ ...s, members: (s.membersBase || 0) + roster(d, s.id).length }),
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
     or several change at once (never for threads); the real app sends one mutation per change instead.
     stub: TODO(limits) rows: API keys and token usage, kept as they are, without accounting.
     scope (steps 3 and 10): who writes through a row. A person's actions are procedures (section 5b, scope
     'user'); the Screen entries and the Variants bar's Reset use the scenario endpoint (dev, step 10). The
     collection write rows remain only for:
       'run'       the ask pipeline in the page (answers, their sources, charges, run notifications, key
                   and domain checks), which writes what the server will write itself in step 7;
       'stub'      the token-usage stub (TODO(limits)), which the ask pipeline also writes (its charges).
     The page sends X-Session-Origin (run, stub; user would be a bug) with each collection write; the
     request log records it, and in dev a write from another origin is an error. */
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
    row('spaces', 'list', 'guest', 'spaces.list', { note: 'listed and joined spaces; a guest gets the listed ones' }),
    row('spaces', 'put', 'server', null, { note: 'a domain check’s result (the page’s server job until step 7); admins change settings with spaces.update' }),

    /* threads: addressed by id (a ULID). r, likes, liked and mine are derived on read. */
    row('posts', 'list', 'guest', 'research.listTrees', { wire: 'ResearchTreeSummary[]' }),
    row('posts', 'get', 'guest', 'research.getTree', { wire: 'ResearchTreeDetail' }),
    row('posts', 'put', 'server', null, { wire: 'ResearchTree', note: 'the run sets the answer state (running, stopped, failed); people change threads with procedures' }),

    row('rich', 'list', 'guest', 'research.getNodeContent', { wire: 'ResearchNodeContent' }),
    row('rich', 'get', 'guest', 'research.getNodeContent', { wire: 'ResearchNodeContent' }),
    row('rich', 'put', 'server', null, { note: 'written by the run; the real app sends research.node.* events' }),
    row('rich', 'delete', 'server', null, { note: 'cleared when an ask runs again (research.rerunNode)' }),
    row('srcd', 'list', 'guest', 'research.getNodeContent', { wire: 'ResearchNodeContent' }),
    row('srcd', 'put', 'server', null, { note: 'written by the run' }),
    row('srcd', 'delete', 'server', null),
    row('fu', 'list', 'guest', 'followups.list'),
    row('fu', 'put', 'server', null, { wire: 'ResearchExchangeNode', note: 'the run writes a follow-up’s answer (the thread’s follow-ups, replaced whole)' }),
    row('rp', 'list', 'guest', 'research.getTree'),
    row('qtd', 'list', 'guest', 'research.getTree', { wire: 'ResearchTreeDetail' }),
    row('qtd', 'put', 'server', null, { wire: 'ResearchNode', note: 'the run writes an ask’s answer in the tree' }),

    row('media', 'list', 'guest', 'sources.list'),
    row('miAdded', 'list', 'user', 'sources.listNew'),

    row('joined', 'list', 'user', 'spaces.listJoined'),
    row('roles', 'list', 'user', 'spaces.myRoles'),
    row('roles0', 'list', 'user', 'spaces.myRoles'),
    row('rel', 'list', 'user', 'spaces.myClosedSpaces'),
    row('liked', 'list', 'user', 'likes.list'),
    row('saved', 'list', 'user', 'saves.list'),
    row('qtSaved', 'list', 'user', 'saves.list'),
    row('miSaved', 'list', 'user', 'saves.list'),
    row('miRead', 'list', 'user', 'sources.listRead'),

    /* TODO(limits): API keys are a stub: stored as sent (no encryption, no usage accounting). raw is write-only. */
    row('userKeys', 'list', 'user', 'apiKeys.list', { stub: true, note: 'masked keys only: raw is never returned' }),
    row('userKeys', 'put', 'server', null, { stub: true, note: 'a key check’s result, and the run’s last-used time' }),

    row('notifs', 'list', 'user', 'notifications.list', { wire: 'InboxNotificationPage' }),
    row('notifs', 'create', 'server', null, { wire: 'InboxNotification', note: 'the real server creates notifications (notification.requested); the page still posts the ones that follow an ask run or a resolved report, as structured records, and the server assigns the id' }),
    row('askedInv', 'list', 'user', 'invites.listRequested'),

    row('reqs', 'list', 'moderator', 'joinRequests.list'),
    row('mem', 'list', 'member', 'sharing.listMembers', { wire: 'ThreadMember[]', note: 'space roles replace commenter and viewer' }),
    row('memOther', 'list', 'member', 'sharing.listMembers', { wire: 'ThreadMember[]' }),
    row('banned', 'list', 'moderator', 'bans.list'),
    row('links', 'list', 'moderator', 'invites.list', { wire: 'ThreadInvite[]' }),
    row('reports', 'list', 'moderator', 'reports.list'),
    row('modSt', 'list', 'moderator', 'moderation.list'),

    row('dsDrops', 'list', 'guest', 'spaceSources.list'),
    row('dsPol', 'list', 'guest', 'spaceSources.policies'),
    row('dsReps', 'list', 'moderator', 'sourceReports.list'),
    row('profile', 'list', 'user', 'profile.get', { wire: 'User' }),
    row('skills', 'list', 'guest', 'skills.list'),
    row('pagedocs', 'list', 'guest', 'pages.list'),
    row('acct', 'list', 'user', 'settings.get', { wire: 'UserSettings' }),
    row('usage', 'list', 'user', 'usage.get', { stub: true, note: 'TODO(limits): token usage by source and space, the included tokens and the default key' }),
    row('usage', 'replace', 'user', 'usage.setDefaultKey', { stub: true, note: 'TODO(limits): the page computes usage; the server stores it as sent' }),
    row('muted', 'list', 'user', 'mutes.list'),
    row('blocked', 'list', 'user', 'blocks.list'),
    row('repSeen', 'list', 'moderator', 'notifications.unreadCount'),
    row('reqSeen', 'list', 'moderator', 'notifications.unreadCount'),
    row('rpLiked', 'list', 'user', 'likes.list'),

    { method: 'GET', path: '/api/me', coll: null, op: 'me', input: null, output: 'Me', who: 'user', trpc: 'auth.me', wire: 'User', errors: ['UNAUTHORIZED'],
      note: 'the signed-in person; the server uses it for mine and liked' },

    /* development only: not part of the product API */
    { method: 'POST', path: '/api/dev/reset', coll: null, op: 'dev-reset', input: null, output: null, who: 'guest', trpc: null, wire: null, errors: [], dev: true, note: 'back to the seed data' },
    { method: 'POST', path: '/api/dev/scenario', coll: null, op: 'dev-scenario', input: '{ name: string, args?: object }', output: '{ changes }', who: 'guest', trpc: null, wire: null, errors: ['BAD_REQUEST', 'INTERNAL_SERVER_ERROR'], dev: true,
      note: 'a Screen entry’s data (step 10): back to the seed, then the named scenario (session-web-spaces-scenarios.js) in one transaction; changes: every record that differs from the database before the call' },
    { method: 'GET', path: '/api/dev/config', coll: null, op: 'dev-config', input: null, output: 'DevConfig', who: 'guest', trpc: null, wire: null, errors: [], dev: true },
    { method: 'PUT', path: '/api/dev/config', coll: null, op: 'dev-config', input: 'Partial<DevConfig>', output: 'DevConfig', who: 'guest', trpc: null, wire: null, errors: ['BAD_REQUEST'], dev: true,
      note: 'DevConfig: { now (the mock clock, an ISO time), latency, failWrites, failReads, failCode, failOn: { code, paths: string[], methods?: string[], times? } | null }' },
  ];
  /* scopes of the collection write rows (see `scope` above): every one left is the ask pipeline's, and the
     usage stub's (which the pipeline also charges asks to). A person's actions are procedures, and the
     Screen entries use scenarios (step 10). */
  for (const a of API) if (!a.dev && a.method !== 'GET') a.scope = C[a.coll].stub ? ['stub', 'run'] : ['run'];

  /* ---- 5b. procedures (step 3): mutations by intent ----
     A person's action is one procedure, POST /api/rpc/<name> with the input as the body, named as in the
     real app's tRPC routers. The server validates the input (BAD_REQUEST), checks that the records it names
     exist (NOT_FOUND), computes the new state, writes every collection it changes at once (all or none) and
     answers { result, changes }:
       changes: per collection, the records it wrote, as GET returns them (derived fields included):
         list:  { put: [record], del: [id], at: { [id]: index } }   (at: where a new record went)
         map:   { put: { [key]: value }, del: [key] }
         value: { value }
     A change to likes, follow-ups, replies or ask trees also returns the threads whose derived fields
     changed; a change to member lists returns the spaces. The page puts these records in place of the
     ones it changed optimistically.
     proc(name, def): def.input (schema), def.output (a type name), def.who (documentation only; enforced
     in step 5), def.errors, def.wire, def.note, def.run(tx, input) → result. run throws rpcError(code) to
     fail; nothing it wrote is kept. tx (createBackend, transaction) reads and writes the collections:
       tx.me, tx.now, tx.id()          the signed-in person, the mock clock, a new ULID
       tx.get(k), tx.value(k)          a collection (read only), or a copy of a value collection
       tx.find(k, id), tx.need(k, id)  a list record, or a copy of it (need: NOT_FOUND when missing)
       tx.put(k, rec, 'start'?)        create or replace a list record; tx.edit(k, id, fn); tx.remove(k, id)
       tx.mapGet(k, key), tx.mapPut(k, key, v), tx.mapDel(k, key)
       tx.setValue(k, v) */
  const rpcError = (code, message, issues) => Object.assign(new Error(message || CODES[code][1]), { rpcCode: code, issues });
  const PROCS = {};
  const proc = (name, def) => { PROCS[name] = def; };
  const ID = str;   /* a record id */

  /* -- personal toggles: likes, saves, mutes, blocks, read sources -- */
  const flip = (tx, k, v, on) => { const s = tx.value(k); if (on) s.add(v); else s.delete(v); tx.setValue(k, s); return { on }; };
  const ON = { 'on?': bool };
  const want = (tx, k, v, on) => on === undefined ? !tx.get(k).has(v) : on;
  proc('likes.toggle', { input: obj({ thread: ID, ...ON }), output: '{ on: boolean }', who: 'user', errors: ['NOT_FOUND'], writes: ['liked', 'posts'],
    note: 'like or unlike a thread; on: the wanted state (omitted: the opposite of the current one). Returns the thread with its new likes.',
    run: (tx, i) => { tx.need('posts', i.thread, 'thread'); return flip(tx, 'liked', i.thread, want(tx, 'liked', i.thread, i.on)); } });
  proc('likes.toggleReply', { input: obj({ reply: str, ...ON }), output: '{ on: boolean }', who: 'user', errors: ['NOT_FOUND'], writes: ['rpLiked'],
    note: 'reply: "<thread>:<path>", the path of a reply in the thread’s replies (indexes joined with ".")',
    run: (tx, i) => {
      const [th, path] = i.reply.split(':');
      tx.need('posts', th, 'thread');
      if (!/^\d+(\.\d+)*$/.test(path || '')) throw rpcError('BAD_REQUEST', undefined, ['input.reply: expected "<thread>:<path>"']);
      return flip(tx, 'rpLiked', i.reply, want(tx, 'rpLiked', i.reply, i.on));
    } });
  const SAVE_KIND = { thread: 'saved', ask: 'qtSaved', source: 'miSaved' };
  proc('saved.toggle', { input: obj({ kind: one('thread', 'ask', 'source'), id: str, ...ON }), output: '{ on: boolean }', who: 'user', errors: ['NOT_FOUND'], writes: ['saved', 'qtSaved', 'miSaved'],
    note: 'save or unsave a thread (id: its id), an ask (id: "<thread>:<node>") or a source (id: its id)',
    run: (tx, i) => {
      const k = SAVE_KIND[i.kind], on = want(tx, k, i.id, i.on);
      /* a thread or source someone deleted can still be removed from Saved */
      if (on) {
        if (i.kind === 'source') { if (!tx.find('media', i.id) && !tx.find('miAdded', i.id)) throw rpcError('NOT_FOUND'); }
        else tx.need('posts', i.kind === 'ask' ? i.id.split(':')[0] : i.id, 'thread');
      }
      return flip(tx, k, i.id, on);
    } });
  proc('mutes.set', { input: obj({ handle: str, on: bool }), output: '{ on: boolean }', who: 'user', writes: ['muted'],
    note: 'mute or unmute a person: Home leaves out their threads', run: (tx, i) => flip(tx, 'muted', i.handle, i.on) });
  proc('blocks.set', { input: obj({ handle: str, on: bool }), output: '{ on: boolean }', who: 'user', writes: ['blocked'],
    note: 'block or unblock a person: they can’t reply to you or see your profile', run: (tx, i) => flip(tx, 'blocked', i.handle, i.on) });
  proc('sources.markRead', { input: obj({ id: ID }), output: 'null', who: 'user', errors: ['NOT_FOUND'], writes: ['miRead'],
    run: (tx, i) => { if (!tx.find('media', i.id) && !tx.find('miAdded', i.id)) throw rpcError('NOT_FOUND'); flip(tx, 'miRead', i.id, true); } });

  /* -- threads, follow-ups and replies -- */
  const bad1 = (path, expected) => rpcError('BAD_REQUEST', undefined, [`input.${path}: expected ${expected}`]);
  const text = (v, path) => { if (!String(v).trim()) throw bad1(path, 'some text'); return String(v).trim(); };
  const htmlText = h => String(h || '').replace(/<sup[^>]*>.*?<\/sup>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const clipText = (s, n) => s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s;
  const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /* a space people can write in */
  const writable = (tx, sid) => {
    const s = tx.need('spaces', sid, 'space');
    if (s.deleted) throw rpcError('NOT_FOUND', 'The server has no record of this space. Someone may have deleted it.');
    if (s.archived) throw rpcError('PRECONDITION_FAILED', 'This space is archived: nobody can ask, post or reply in it.');
    return s;
  };
  /* a thread's asks about asks: the stored tree, or its flat follow-ups as level-1 asks (as the page shows them) */
  const askTree = (tx, th) => tx.mapGet('qtd', th) || { nodes: (tx.mapGet('fu', th) || []).map((f, k) => ({ id: 'f' + k, par: 'r', fu: k, tok: 18e3 + k * 7e3 })) };
  /* the tree's nodes with the text of the follow-ups they stand for */
  const askNodes = (tx, th) => {
    const fus = tx.mapGet('fu', th) || [];
    return askTree(tx, th).nodes.map(n => { const f = n.fu != null ? fus[n.fu] || {} : null; return f ? { ...n, u: f.u, createdAt: f.createdAt, q: f.q, html: f.html || `<p>${escHtml(f.a || '')}</p>` } : n; });
  };
  const nodeOf = (nodes, id) => { const n = nodes.find(x => x.id === id); if (!n) throw rpcError('NOT_FOUND', 'The server has no record of this follow-up. Someone may have deleted it.'); return n; };
  const replyAt = (list, path) => { let r = null, l = list; for (const k of path) { r = (l || [])[k]; if (!r) return null; l = r.kids; } return r; };
  const pathOf = s => { if (!/^\d+(\.\d+)*$/.test(s)) throw bad1('path', '"<index>[.<index>]"'); return s.split('.').map(Number); };
  const THREAD_IN = {
    space: ID, kind: one('ask', 'post'), q: str, 'title?': nul(str), 'topic?': nul(str),
    'pay?': nul(str), 'model?': str, 'about?': t.obj({ 'it?': str, 'its?': arr(str), 'b?': num, 'quote?': str }), 'skill?': nul(str),
    'from?': obj({ th: ID, node: str }), 'branch?': one('all', 'one'),
  };
  proc('threads.create', { input: obj(THREAD_IN, 'CreateThreadInput'), output: '{ id: ThreadId }', who: 'member', errors: ['NOT_FOUND', 'PRECONDITION_FAILED'], wire: 'ResearchTree', writes: ['posts', 'rich', 'fu', 'qtd'],
    note: 'an ask or a post; the server assigns the id (a ULID). An ask starts running (the run is the page’s ask pipeline until step 7). from: start the thread from a branch of another thread’s ask tree (branch: "all" copies the asks below it); the source node links to the new thread. topic: kept only in a space with the FAQ landing that has the topic. pay: TODO(limits), stored as sent.',
    run: (tx, i) => {
      const s = writable(tx, i.space);
      if (i.kind === 'post' && s.postsOff) throw rpcError('PRECONDITION_FAILED', 'Posts are turned off in this space.');
      const topic = i.topic && s.faq && (s.topics || []).some(x => x[0] === i.topic) ? i.topic : null;
      const id = tx.id();
      if (i.from) {
        /* a thread from a branch: the node's ask, its answer and (branch "all") the asks below it */
        const src = tx.need('posts', i.from.th, 'thread'), nodes = askNodes(tx, src.id), n = nodeOf(nodes, i.from.node);
        if (n.id === 'r') throw bad1('from.node', 'a follow-up, not the thread’s first ask');
        const byId = Object.fromEntries(nodes.map(x => [x.id, x])), path = x => { const out = []; for (let y = x; y; y = byId[y.par]) out.unshift(y); return out; };
        const rec = { id, s: s.id, u: n.u, k: 'ask', t: (i.title || n.q).trim(), q: n.q, sum: clipText(htmlText(n.html), 170), tok: n.tok || 0, kw: n.q, from: { th: src.id, node: n.id, lv: path(n).length } };
        if (topic) rec.topic = topic;
        tx.put('posts', rec);
        tx.mapPut('rich', id, n.html || '');
        tx.mapPut('fu', id, []);
        const desc = i.branch === 'all' ? nodes.filter(x => x.id !== n.id && path(x).some(y => y.id === n.id)) : [];
        tx.mapPut('qtd', id, { nodes: desc.map(x => ({ id: x.id, par: x.par === n.id ? 'r' : x.par, u: x.u, createdAt: x.createdAt, q: x.q, html: x.html, tok: x.tok })) });
        const tree = askTree(tx, src.id);
        tx.mapPut('qtd', src.id, { ...tree, nodes: tree.nodes.map(x => x.id === n.id ? { ...x, promoted: id } : x) });
        return { id };
      }
      const q = text(i.q, 'q');
      const rec = { id, s: s.id, u: tx.me.u, k: i.kind, t: i.title || null, q, sum: null, tok: 0, running: i.kind === 'ask', kw: q, topic, topicBy: topic ? 'asker' : null };
      for (const f of ['pay', 'model', 'about', 'skill']) if (i[f] != null) rec[f] = i[f];
      tx.put('posts', rec);
      return { id };
    } });
  proc('threads.update', { input: obj({ id: ID, q: str, 'run?': bool, 'pay?': nul(str) }, 'UpdateThreadInput'), output: 'null', who: 'author', errors: ['NOT_FOUND'], wire: 'ResearchTree', writes: ['posts'],
    note: 'the author edits the question; run: the ask runs again with payer pay (TODO(limits): stored as sent)',
    run: (tx, i) => {
      const q = text(i.q, 'q');
      tx.edit('posts', i.id, x => {
        if (x.del || x.gone) throw rpcError('PRECONDITION_FAILED', 'This thread was deleted.');
        const changed = x.q !== q; x.q = q; x.kw = q;
        if (changed) { x.edited = true; x.t = null; }
        if (i.run) { x.running = true; x.sum = null; x.tok = 0; x.pay = i.pay == null ? null : i.pay; delete x.fail; }
      }, 'thread');
    } });
  proc('threads.delete', { input: obj({ id: ID }), output: '{ kept: boolean }', who: 'author', errors: ['NOT_FOUND'], writes: ['posts', 'saved', 'liked'],
    note: 'the author deletes a thread: one with follow-ups or replies keeps its place ("You deleted this ask"), one without is gone; it leaves Saved and likes',
    run: (tx, i) => {
      const p = tx.need('posts', i.id, 'thread');
      const kids = p.k === 'ask' ? askTree(tx, p.id).nodes.length : (tx.mapGet('rp', p.id) || []).length, keep = kids > 0;
      tx.edit('posts', p.id, x => {
        x.del = true; x.q = ''; x.kw = ''; x.t = null; delete x.edited;
        if (!keep) { x.gone = true; x.sum = null; x.running = false; }
      });
      if (!keep) for (const k of ['saved', 'liked']) if (tx.get(k).has(p.id)) { const s = tx.value(k); s.delete(p.id); tx.setValue(k, s); }
      return { kept: keep };
    } });
  proc('threads.move', { input: obj({ id: ID, topic: nul(str) }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['posts'],
    note: 'a moderator moves a thread to a topic of its space (null: Other)',
    run: (tx, i) => {
      const p = tx.need('posts', i.id, 'thread'), s = tx.need('spaces', p.s, 'space');
      if (i.topic != null && !(s.topics || []).some(x => x[0] === i.topic)) throw rpcError('NOT_FOUND', 'The space has no topic like this.');
      tx.edit('posts', p.id, x => { x.topic = i.topic; x.topicBy = 'mod'; });
    } });
  proc('followups.ask', { input: obj({ thread: ID, q: str }), output: 'null', who: 'member', errors: ['NOT_FOUND', 'PRECONDITION_FAILED'], wire: 'ResearchExchangeNode', writes: ['fu', 'posts'],
    note: 'a follow-up ask on an ask thread (without ask trees: the flat list)',
    run: (tx, i) => {
      const p = tx.need('posts', i.thread, 'thread'); writable(tx, p.s);
      if (p.k !== 'ask') throw bad1('thread', 'an ask thread');
      tx.mapPut('fu', p.id, [...(tx.mapGet('fu', p.id) || []), { u: tx.me.u, q: text(i.q, 'q'), a: 'Researching…' }]);
    } });
  proc('research.createPostFollowUp', { input: obj({ thread: ID, t: str, 'parent?': int }), output: 'null', who: 'member', errors: ['NOT_FOUND', 'PRECONDITION_FAILED'], wire: 'ResearchPostNode', writes: ['rp', 'posts'],
    note: 'a reply to a post; parent: the index of the reply it answers (replies have one level of nesting)',
    run: (tx, i) => {
      const p = tx.need('posts', i.thread, 'thread'); writable(tx, p.s);
      const l = tx.mapGet('rp', p.id) || [], r = { u: tx.me.u, t: text(i.t, 't') };
      if (i.parent == null) l.push(r);
      else { const top = l[i.parent]; if (!top) throw rpcError('NOT_FOUND', 'The server has no record of this reply. Someone may have deleted it.'); top.kids = [...(top.kids || []), r]; }
      tx.mapPut('rp', p.id, l);
    } });
  proc('research.forkNode', { input: obj({ thread: ID, parent: str, q: str, 'uses?': nul(arr(str)), 'pay?': nul(str), 'model?': str }, 'ForkNodeInput'), output: '{ id: NodeId }', who: 'member', errors: ['NOT_FOUND', 'PRECONDITION_FAILED'], wire: 'ResearchNode', writes: ['qtd', 'posts'],
    note: 'an ask about an answer in a thread’s ask tree (parent: "r" for the thread’s ask, or a node id); the server assigns the node id. It starts running (the page’s pipeline writes the answer until step 7). pay: TODO(limits), stored as sent.',
    run: (tx, i) => {
      const p = tx.need('posts', i.thread, 'thread'); writable(tx, p.s);
      const tree = askTree(tx, p.id);
      if (i.parent !== 'r') nodeOf(tree.nodes, i.parent);
      const n = { id: tx.id(), par: i.parent, u: tx.me.u, q: text(i.q, 'q'), tok: 0, running: true, uses: i.uses || null, pay: i.pay == null ? null : i.pay };
      if (i.model) n.model = i.model;
      tx.mapPut('qtd', p.id, { ...tree, nodes: [...tree.nodes, n] });
      return { id: n.id };
    } });
  proc('replies.update', { input: obj({ thread: ID, path: str, t: str }), output: 'null', who: 'author', errors: ['NOT_FOUND'], writes: ['rp'],
    note: 'the author edits a reply (path: indexes in the thread’s replies, joined with ".")',
    run: (tx, i) => {
      const p = tx.need('posts', i.thread, 'thread'), l = tx.mapGet('rp', p.id) || [], r = replyAt(l, pathOf(i.path));
      if (!r) throw rpcError('NOT_FOUND', 'The server has no record of this reply. Someone may have deleted it.');
      const t2 = text(i.t, 't'); if (r.t !== t2) r.edited = true; r.t = t2;
      tx.mapPut('rp', p.id, l);
    } });
  proc('replies.delete', { input: obj({ thread: ID, path: str }), output: '{ kept: boolean }', who: 'author', errors: ['NOT_FOUND'], wire: 'ResearchBranchRemoval', writes: ['rp', 'posts'],
    note: 'the author deletes a reply: one with replies keeps its place ("You deleted this reply"), one without is removed',
    run: (tx, i) => {
      const p = tx.need('posts', i.thread, 'thread'), l = tx.mapGet('rp', p.id) || [], path = pathOf(i.path), r = replyAt(l, path);
      if (!r) throw rpcError('NOT_FOUND', 'The server has no record of this reply. Someone may have deleted it.');
      const keep = (r.kids || []).length > 0;
      if (keep) { r.del = true; r.t = ''; delete r.edited; }
      else { const par = path.length > 1 ? replyAt(l, path.slice(0, -1)).kids : l; par.splice(path[path.length - 1], 1); }
      tx.mapPut('rp', p.id, l);
      return { kept: keep };
    } });
  proc('followups.update', { input: obj({ thread: ID, node: str, q: str, 'run?': bool }), output: 'null', who: 'author', errors: ['NOT_FOUND'], wire: 'ResearchNode', writes: ['qtd', 'fu', 'posts'],
    note: 'the author edits a follow-up ask; run: it runs again (the page’s pipeline writes the answer until step 7)',
    run: (tx, i) => {
      const p = tx.need('posts', i.thread, 'thread'), q = text(i.q, 'q'), n = nodeOf(askNodes(tx, p.id), i.node), changed = n.q !== q;
      if (n.fu != null) { const fu = tx.mapGet('fu', p.id) || []; if (fu[n.fu]) { fu[n.fu].q = q; tx.mapPut('fu', p.id, fu); } }
      const tree = askTree(tx, p.id);
      tx.mapPut('qtd', p.id, { ...tree, nodes: tree.nodes.map(x => { if (x.id !== n.id) return x; const y = { ...x }; if (y.fu == null) y.q = q; if (changed) y.edited = true; if (i.run) { y.running = true; y.tok = 0; } return y; }) });
    } });
  proc('followups.delete', { input: obj({ thread: ID, node: str }), output: '{ kept: boolean }', who: 'author', errors: ['NOT_FOUND'], wire: 'ResearchBranchRemoval', writes: ['qtd', 'fu', 'posts'],
    note: 'the author deletes a follow-up ask and its answer: one with asks below it keeps its place, one without is removed',
    run: (tx, i) => {
      const p = tx.need('posts', i.thread, 'thread'), n = nodeOf(askNodes(tx, p.id), i.node), tree = askTree(tx, p.id);
      const keep = tree.nodes.some(x => x.par === n.id);
      if (n.fu != null) { const fu = tx.mapGet('fu', p.id) || []; if (fu[n.fu]) { Object.assign(fu[n.fu], { del: true, q: '', a: '' }); delete fu[n.fu].html; tx.mapPut('fu', p.id, fu); } }
      tx.mapPut('qtd', p.id, { ...tree, nodes: keep ? tree.nodes.map(x => { if (x.id !== n.id) return x; const y = { ...x, del: true, q: '', html: '' }; delete y.edited; return y; }) : tree.nodes.filter(x => x.id !== n.id) });
      return { kept: keep };
    } });

  /* -- memberships, join requests and roles -- */
  const closedSpace = s => s.vis === 'listed' || s.vis === 'unlisted';
  const rosterOf = (tx, sid) => (sid === C.mem.space ? tx.value('mem') : tx.mapGet('memOther', sid)) || [];
  const setRoster = (tx, sid, list) => { if (sid === C.mem.space) tx.setValue('mem', list); else tx.mapPut('memOther', sid, list); };
  const setJoined = (tx, sid, on) => { const j = tx.value('joined'); if (on && !j.includes(sid)) tx.setValue('joined', [...j, sid]); if (!on && j.includes(sid)) tx.setValue('joined', j.filter(x => x !== sid)); };
  /* your relation to a closed space (none, pending, member, mod, denied), with what follows from it: the
     joined list, your place among the space's moderators, and your role */
  function setRelation(tx, sid, r) {
    tx.mapPut('rel', sid, r);
    setJoined(tx, sid, r === 'member' || r === 'mod');
    const g0 = tx.get('roles0')[sid];
    tx.edit('spaces', sid, s => { s.mods = (s.mods || []).filter(m => m[0] !== tx.me.u); if (r === 'mod') s.mods.push([tx.me.u, g0 ? g0.toLowerCase() : 'admin']); });
    const roles = tx.value('roles');
    if (r === 'mod') { if (!roles[sid]) tx.setValue('roles', { ...roles, [sid]: 'Admin' }); }
    else if (roles[sid] && !g0) { delete roles[sid]; tx.setValue('roles', roles); }
  }
  const reqSpace = r => r.sp || C.mem.space;
  const markNote = (tx, id, fn) => { if (id != null) tx.edit('notifs', id, n => { n.read = true; fn(n); }, 'notification'); };
  proc('spaces.join', { input: obj({ space: ID, 'notification?': ID }), output: 'null', who: 'user', errors: ['NOT_FOUND', 'FORBIDDEN'], writes: ['joined', 'rel', 'spaces', 'roles', 'notifs'],
    note: 'join an open space, or a closed one you were invited to (notification: the invite, marked accepted)',
    run: (tx, i) => {
      const s = tx.need('spaces', i.space, 'space');
      if (s.deleted) throw rpcError('NOT_FOUND');
      markNote(tx, i.notification, n => { n.response = 'accepted'; });
      if (closedSpace(s) || i.notification != null) setRelation(tx, s.id, 'member'); else setJoined(tx, s.id, true);
    } });
  proc('spaces.leave', { input: obj({ space: ID }), output: 'null', who: 'member', errors: ['NOT_FOUND'], writes: ['joined', 'rel', 'spaces', 'roles'],
    run: (tx, i) => { const s = tx.need('spaces', i.space, 'space'); if (closedSpace(s)) setRelation(tx, s.id, 'none'); setJoined(tx, s.id, false); } });
  proc('onboarding.finish', { input: obj({ spaces: arr(ID) }), output: 'null', who: 'user', errors: ['NOT_FOUND'], writes: ['joined'],
    note: 'a new account’s first spaces (the open spaces picked on the welcome page)',
    run: (tx, i) => { i.spaces.forEach(id => tx.need('spaces', id, 'space')); tx.setValue('joined', [...new Set(i.spaces)]); } });
  proc('invites.decline', { input: obj({ notification: ID }), output: 'null', who: 'user', errors: ['NOT_FOUND'], writes: ['notifs'],
    note: 'decline an invite to a closed space; the person who invited you is not notified', run: (tx, i) => markNote(tx, i.notification, n => { n.response = 'declined'; }) });
  proc('invites.request', { input: obj({ space: ID }), output: 'null', who: 'user', errors: ['NOT_FOUND'], writes: ['askedInv'],
    note: 'ask the members of an invite-only space for an invite',
    run: (tx, i) => { tx.need('spaces', i.space, 'space'); const l = tx.value('askedInv'); if (!l.includes(i.space)) tx.setValue('askedInv', [...l, i.space]); } });
  proc('joinRequests.create', { input: obj({ space: ID, 'answers?': arr(str) }), output: 'null', who: 'user', errors: ['NOT_FOUND', 'PRECONDITION_FAILED'], writes: ['rel', 'reqs', 'joined', 'spaces', 'roles'],
    note: 'request to join a closed space; the request joins the space’s review queue',
    run: (tx, i) => {
      const s = tx.need('spaces', i.space, 'space');
      if (!closedSpace(s)) throw rpcError('PRECONDITION_FAILED', 'This space is open: join it instead.');
      setRelation(tx, s.id, 'pending');
      tx.put('reqs', { u: tx.me.u, sp: s.id, st: 'open', a: i.answers || [], userCreatedAt: tx.me.createdAt });
    } });
  proc('joinRequests.withdraw', { input: obj({ space: ID }), output: 'null', who: 'author', errors: ['NOT_FOUND'], writes: ['rel', 'reqs', 'joined', 'spaces', 'roles'],
    run: (tx, i) => {
      tx.need('spaces', i.space, 'space'); setRelation(tx, i.space, 'none');
      const r = tx.find('reqs', tx.me.u); if (r && reqSpace(r) === i.space) tx.remove('reqs', tx.me.u);
    } });
  proc('joinRequests.decide', { input: obj({ space: ID, users: arr(str), decision: one('approve', 'decline', 'reopen'), 'why?': str }, 'DecideRequestsInput'), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['reqs', 'mem', 'memOther', 'spaces'],
    note: 'approve (the applicants become members), decline (why: the note they see) or reopen a declined request (Undo)',
    run: (tx, i) => {
      tx.need('spaces', i.space, 'space');
      const add = [];
      for (const u of i.users) {
        const r = tx.need('reqs', u, 'request'); if (reqSpace(r) !== i.space) throw rpcError('NOT_FOUND', 'The server has no record of this request. Someone may have deleted it.');
        if (i.decision === 'approve') { r.st = 'approved'; add.push(u); }
        if (i.decision === 'decline') { r.st = 'declined'; r.why = (i.why || '').trim(); }
        if (i.decision === 'reopen') { if (r.st !== 'declined') continue; r.st = 'open'; }
        tx.put('reqs', r);
      }
      const list = rosterOf(tx, i.space), fresh = add.filter(u => !list.some(m => m.u === u));
      if (fresh.length) setRoster(tx, i.space, [...list, ...fresh.map(u => ({ u, role: 'member' }))]);
    } });
  const MEMBER_ROLE = one('member', 'mod', 'admin', 'owner');
  proc('members.setRole', { input: obj({ space: ID, user: str, role: MEMBER_ROLE }), output: 'null', who: 'admin', errors: ['NOT_FOUND'], wire: 'ThreadMember', writes: ['mem', 'memOther', 'spaces', 'roles', 'roles0'],
    note: 'change a member’s role; role "owner" transfers ownership: you become an admin',
    run: (tx, i) => {
      tx.need('spaces', i.space, 'space');
      const list = rosterOf(tx, i.space);
      if (!list.some(m => m.u === i.user)) throw rpcError('NOT_FOUND', 'This person is not a member of the space.');
      if (i.role !== 'owner') { setRoster(tx, i.space, list.map(m => m.u === i.user ? { ...m, role: i.role } : m)); return; }
      setRoster(tx, i.space, list.map(m => m.u === i.user ? { ...m, role: 'owner' } : m.u === tx.me.u ? { ...m, role: 'admin' } : m));
      tx.setValue('roles', { ...tx.value('roles'), [i.space]: 'Admin' });
      const g0 = tx.value('roles0'); if (g0[i.space] === 'Owner') tx.setValue('roles0', { ...g0, [i.space]: 'Admin' });
      tx.edit('spaces', i.space, s => { s.mods = [[i.user, 'owner'], ...(s.mods || []).filter(m => m[0] !== i.user && m[0] !== tx.me.u), [tx.me.u, 'admin']]; });
    } });
  const removeMember = (tx, sid, u) => { const list = rosterOf(tx, sid); if (list.some(m => m.u === u)) setRoster(tx, sid, list.filter(m => m.u !== u)); };
  proc('members.remove', { input: obj({ space: ID, user: str }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], wire: 'ThreadMember[]', writes: ['mem', 'memOther', 'spaces'],
    run: (tx, i) => { tx.need('spaces', i.space, 'space'); removeMember(tx, i.space, i.user); } });
  proc('members.ban', { input: obj({ space: ID, user: str }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['mem', 'memOther', 'spaces', 'banned'],
    note: 'remove a member (if they are one) and ban them: they can’t request to join or use invite links',
    run: (tx, i) => {
      tx.need('spaces', i.space, 'space'); removeMember(tx, i.space, i.user);
      if (!tx.get('banned').some(b => b.u === i.user && (b.sp || C.mem.space) === i.space)) tx.put('banned', { id: `${i.space}:${i.user}`, sp: i.space, u: i.user }, 'start');
    } });
  proc('members.unban', { input: obj({ space: ID, user: str }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['banned'],
    run: (tx, i) => {
      const l = tx.get('banned').filter(b => b.u === i.user && (b.sp || C.mem.space) === i.space);
      if (!l.length) throw rpcError('NOT_FOUND', 'This person is not banned from the space.');
      l.forEach(b => tx.remove('banned', b.id));
    } });

  /* -- reports and moderation -- */
  const itemSpace = (tx, key) => { const th = String(key).split(':')[1], p = th && tx.find('posts', th); if (!p) throw rpcError('NOT_FOUND', 'The server has no record of this item. Someone may have deleted it.'); return p.s; };
  const reportNote = n => n.type === 'report_resolved';
  proc('reports.create', { input: obj({ item: str, why: str, 'note?': str }), output: '{ id: ReportId }', who: 'member', errors: ['NOT_FOUND'], writes: ['reports'],
    note: 'report an item (item: "<kind>:<thread>[:…]") to the space’s moderators; they get a notification',
    run: (tx, i) => {
      const id = tx.id();
      tx.put('reports', { id, sp: itemSpace(tx, i.item), key: i.item, why: i.why, note: (i.note || '').trim(), by: tx.me.u, st: 'open' }, 'start');
      tx.setValue('repSeen', false);
      return { id };
    } });
  proc('reports.resolve', { input: obj({ report: ID, outcome: one('dismissed', 'hidden', 'removed', 'open') }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['reports', 'modSt', 'notifs'],
    note: 'dismiss a report, or hide or remove the item (which resolves every open report on it); "open" reopens it (Undo, Restore). The person who reported it gets a report_resolved notification.',
    run: (tx, i) => {
      const r = tx.need('reports', i.report, 'report'), all = tx.get('reports'), ms = tx.get('modSt');
      const dropNotes = id => tx.get('notifs').filter(n => reportNote(n) && n.report === id).forEach(n => tx.remove('notifs', n.id));
      if (i.outcome === 'open') {
        const was = r.st; tx.edit('reports', r.id, x => { x.st = 'open'; });
        if (was !== 'dismissed' && !tx.get('reports').some(x => x.key === r.key && x.st !== 'open') && r.key in ms) tx.mapDel('modSt', r.key);
        dropNotes(r.id);
        return;
      }
      const same = all.filter(x => x.key === r.key && x.st === 'open');
      if (i.outcome !== 'dismissed') tx.mapPut('modSt', r.key, i.outcome); else if (same.length === 1) tx.mapDel('modSt', r.key);
      (i.outcome === 'dismissed' ? [r] : same).forEach(x => {
        tx.edit('reports', x.id, y => { y.st = i.outcome; });
        /* the server notifies the person who reported it (the mock keeps only your notifications) */
        if (x.by === tx.me.u) { dropNotes(x.id); tx.put('notifs', { id: tx.id(), type: 'report_resolved', report: x.id, item: x.key, outcome: i.outcome, read: false }, 'start'); }
      });
    } });
  proc('moderation.decide', { input: obj({ item: str, decision: one('hidden', 'removed', 'shown') }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['modSt'],
    note: 'hide or remove an item without a report, or show a hidden item again',
    run: (tx, i) => { itemSpace(tx, i.item); if (i.decision === 'shown') tx.mapDel('modSt', i.item); else tx.mapPut('modSt', i.item, i.decision); } });

  /* -- notifications -- */
  proc('notifications.markRead', { input: obj({ id: ID }), output: 'null', who: 'user', errors: ['NOT_FOUND'], wire: 'InboxNotification', writes: ['notifs'],
    run: (tx, i) => { tx.edit('notifs', i.id, n => { n.read = true; }, 'notification'); } });
  proc('notifications.markAllRead', { input: obj({}), output: 'null', who: 'user', writes: ['notifs', 'repSeen', 'reqSeen'],
    run: tx => { tx.get('notifs').filter(n => !n.read).forEach(n => tx.edit('notifs', n.id, x => { x.read = true; })); tx.setValue('reqSeen', true); tx.setValue('repSeen', true); } });
  proc('notifications.markSeen', { input: obj({ kind: one('requests', 'reports') }), output: 'null', who: 'moderator', writes: ['repSeen', 'reqSeen'],
    note: 'the join-requests or reports notification for moderators was read', run: (tx, i) => tx.setValue(i.kind === 'requests' ? 'reqSeen' : 'repSeen', true) });

  /* -- invite links -- */
  proc('invites.create', { input: obj({ space: ID, 'days?': nul(int), 'code?': str }), output: '{ id: InviteId, code: string }', who: 'moderator', errors: ['NOT_FOUND', 'CONFLICT'], wire: 'CreatedInvite', writes: ['links'],
    note: 'a one-use invite link; days: when it expires (null: never). code: the code of a link revoked a moment ago (Undo); otherwise the server makes one.',
    run: (tx, i) => {
      tx.need('spaces', i.space, 'space');
      const id = tx.id(), code = i.code || id.slice(-5).toLowerCase();
      if (tx.get('links').some(l => l.code === code)) throw rpcError('CONFLICT', 'An invite link with this code exists.');
      tx.put('links', { id, code, by: tx.me.u, expiresAt: i.days ? new Date(Date.parse(tx.now) + i.days * 864e5).toISOString().replace(/\.\d{3}Z$/, 'Z') : null, sp: i.space }, 'start');
      return { id, code };
    } });
  proc('invites.revoke', { input: obj({ id: ID }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], wire: 'ThreadInvite', writes: ['links'],
    note: 'people who already joined with the link stay members', run: (tx, i) => { tx.need('links', i.id, 'invite link'); tx.remove('links', i.id); } });

  /* -- spaces -- */
  /* the settings a space's admins change (spaces.update) */
  const SPACE_SETTINGS = ['name', 'title', 'av', 'img', 'desc', 'rules', 'vis', 'policy', 'qs', 'invite', 'faq', 'topics', 'postsOff', 'plain', 'pageEdit', 'pages', 'dom'];
  const settingsSchema = obj(Object.fromEntries(SPACE_SETTINGS.map(k => [k + '?', k === 'img' ? bool : (S.Space.fields[k + '?'] || t.any)])), 'SpaceSettings');
  proc('spaces.create', { input: obj({ name: str, 'desc?': str, 'rules?': arr(str), 'vis?': one('open', 'listed', 'unlisted'), 'policy?': str, 'qs?': arr(obj({ q: str, 'req?': bool })), 'invite?': str, 'faq?': bool }, 'CreateSpaceInput'),
    output: '{ id: SpaceId }', who: 'user', errors: ['CONFLICT'], writes: ['spaces', 'roles', 'roles0', 'rel', 'joined', 'memOther'],
    note: 'a new space: you are its owner and only member.',
    run: (tx, i) => {
      const name = i.name.toLowerCase().replace(/^#/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 32);
      if (!name) throw bad1('name', 'a name');
      if (tx.get('spaces').some(s => s.name === name)) throw rpcError('CONFLICT', `#${name} already exists.`);
      const id = 'sp-' + name, rules = (i.rules || []).map(x => x.trim()).filter(Boolean);
      const s = { id, name, title: name, av: 3, online: 1, posts: 0, desc: (i.desc || '').trim() || 'No description yet.', rules: rules.length ? rules : ['Be specific in asks.'], pages: [], mods: [] };
      if (i.vis && i.vis !== 'open') Object.assign(s, { vis: i.vis, policy: i.policy, qs: (i.qs || []).filter(q => q.q.trim()), invite: i.invite });
      s.faq = !!i.faq; s.topics = [];
      tx.put('spaces', s);
      tx.setValue('roles', { ...tx.value('roles'), [id]: 'Owner' }); tx.setValue('roles0', { ...tx.value('roles0'), [id]: 'Owner' });
      setRelation(tx, id, 'mod');
      setRoster(tx, id, [{ u: tx.me.u, role: 'owner' }]);
      return { id };
    } });
  proc('spaces.update', { input: obj({ id: ID, 'set?': settingsSchema, 'unset?': arr(one(...SPACE_SETTINGS)) }, 'UpdateSpaceInput'), output: 'null', who: 'admin', errors: ['NOT_FOUND', 'CONFLICT'], writes: ['spaces', 'posts', 'rel', 'reqs', 'mem', 'memOther'],
    note: 'change a space’s settings. The server keeps the previous rules for “See changes”, moves threads in deleted topics to Other, approves the open join requests when the space becomes open, and records your membership of a space that becomes closed.',
    run: (tx, i) => {
      const s0 = tx.need('spaces', i.id, 'space'), set = i.set || {};
      if (set.name != null && set.name !== s0.name && tx.get('spaces').some(x => x.id !== s0.id && x.name === set.name)) throw rpcError('CONFLICT', `#${set.name} already exists.`);
      const s = tx.edit('spaces', s0.id, x => {
        for (const k of i.unset || []) delete x[k];
        for (const [k, v] of Object.entries(set)) if (k !== 'rules') x[k] = v;
        if (set.rules) { const rules = set.rules.map(r => r.trim()).filter(Boolean); if (rules.join('\n') !== (x.rules || []).join('\n')) { x.rulesPrev = (x.rules || []).slice(); x.rules = rules; x.rulesAt = tx.now; x.rulesBy = tx.me.u; } }
      });
      /* threads in topics that no longer exist move to Other */
      if (set.topics) tx.get('posts').filter(p => p.s === s.id && p.topic && !set.topics.some(t => t[0] === p.topic)).forEach(p => tx.edit('posts', p.id, x => { x.topic = null; }));
      /* a closed space that becomes open: the open requests are approved */
      if (closedSpace(s0) && !closedSpace(s)) {
        const open = tx.get('reqs').filter(r => r.st === 'open' && reqSpace(r) === s.id);
        open.forEach(r => tx.edit('reqs', r.u, x => { x.st = 'approved'; }));
        const list = rosterOf(tx, s.id), fresh = open.map(r => r.u).filter(u => !list.some(m => m.u === u));
        if (fresh.length) setRoster(tx, s.id, [...list, ...fresh.map(u => ({ u, role: 'member' }))]);
      }
      /* the admin who makes a space closed is one of its moderators */
      if (!closedSpace(s0) && closedSpace(s)) setRelation(tx, s.id, 'mod');
      else if (closedSpace(s) && tx.get('joined').includes(s.id) && !tx.get('rel')[s.id]) tx.mapPut('rel', s.id, tx.get('roles')[s.id] ? 'mod' : 'member');
    } });
  proc('spaces.archive', { input: obj({ id: ID, archived: bool }), output: 'null', who: 'owner', errors: ['NOT_FOUND'], writes: ['spaces'],
    note: 'archive (read-only, hidden from browse and search) or unarchive a space',
    run: (tx, i) => { tx.edit('spaces', i.id, x => { if (i.archived) x.archived = { by: tx.me.u, on: new Date(tx.now).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) }; else delete x.archived; }, 'space'); } });
  proc('spaces.delete', { input: obj({ id: ID }), output: 'null', who: 'owner', errors: ['NOT_FOUND'], writes: ['spaces', 'joined', 'rel'],
    note: 'delete a space for everyone, with its threads, pages and sources (the mock marks it deleted)',
    run: (tx, i) => { tx.edit('spaces', i.id, x => { x.deleted = true; delete x.archived; }, 'space'); setJoined(tx, i.id, false); tx.mapDel('rel', i.id); } });

  /* -- skills and pages -- */
  const skillsOf = (tx, sid) => { tx.need('spaces', sid, 'space'); return tx.mapGet('skills', sid) || []; };
  const SKILL_IN = { space: ID, name: str, prompt: str };
  proc('skills.create', { input: obj(SKILL_IN), output: 'null', who: 'moderator', errors: ['NOT_FOUND', 'CONFLICT'], writes: ['skills'],
    run: (tx, i) => { const l = skillsOf(tx, i.space); if (l.some(x => x[0] === i.name)) throw rpcError('CONFLICT', `The space has a skill named ${i.name}.`); tx.mapPut('skills', i.space, [...l, [i.name, i.prompt]]); } });
  proc('skills.update', { input: obj({ ...SKILL_IN, index: int }), output: 'null', who: 'moderator', errors: ['NOT_FOUND', 'CONFLICT'], writes: ['skills'],
    run: (tx, i) => { const l = skillsOf(tx, i.space); if (!l[i.index]) throw rpcError('NOT_FOUND', 'The server has no record of this skill.'); if (l.some((x, k) => k !== i.index && x[0] === i.name)) throw rpcError('CONFLICT', `The space has a skill named ${i.name}.`); l[i.index] = [i.name, i.prompt]; tx.mapPut('skills', i.space, l); } });
  proc('skills.remove', { input: obj({ space: ID, index: int }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['skills'],
    run: (tx, i) => { const l = skillsOf(tx, i.space); if (!l[i.index]) throw rpcError('NOT_FOUND', 'The server has no record of this skill.'); tx.mapPut('skills', i.space, l.filter((_, k) => k !== i.index)); } });
  proc('skills.reorder', { input: obj({ space: ID, from: int, to: int }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['skills'],
    run: (tx, i) => { const l = skillsOf(tx, i.space); if (!l[i.from] || !l[i.to]) throw rpcError('NOT_FOUND', 'The server has no record of this skill.'); const [x] = l.splice(i.from, 1); l.splice(i.to, 0, x); tx.mapPut('skills', i.space, l); } });
  const pageSlug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  /* TODO(fixtures): the fixtures have no page documents; the page shows a generated stand-in (abDoc). Until
     they do, the page sends the stand-in's author and history as `base`, used when the server has no document. */
  const BASE_DOC = obj({ 'by?': str, 'ed?': str, 'revs?': arr(obj({ by: str, 'createdAt?': iso, note: str })) }, 'PageBase');
  const pageAt = (tx, sid, index) => { const s = tx.need('spaces', sid, 'space'), pg = (s.pages || [])[index]; if (!pg) throw rpcError('NOT_FOUND', 'The server has no record of this page. Someone may have deleted it.'); return [s, pg]; };
  const docOf = (tx, sid, title, base) => tx.mapGet('pagedocs', `${sid}/${pageSlug(title)}`) || { t: title, text: [''], by: (base && base.by) || tx.me.u, ed: base && base.ed, revs: (base && base.revs) || [] };
  proc('pages.update', { input: obj({ space: ID, 'page?': nul(int), title: str, text: arr(str), 'base?': BASE_DOC }, 'UpdatePageInput'), output: 'null', who: 'member', errors: ['NOT_FOUND', 'CONFLICT'], writes: ['pagedocs', 'spaces'],
    note: 'add a page (page: null) or edit one (page: its index in the space’s pages); members get a notification. Who may edit follows the space’s pageEdit setting (step 5); CONFLICT when the page changed since it was opened (step 9).',
    run: (tx, i) => {
      const title = text(i.title, 'title'), body = i.text.length ? i.text : [''];
      if (i.page == null) {
        tx.edit('spaces', i.space, x => { x.pages = [...(x.pages || []), [title, tx.now]]; }, 'space');
        tx.mapPut('pagedocs', `${i.space}/${pageSlug(title)}`, { t: title, text: body, by: tx.me.u, ed: tx.me.u, revs: [{ by: tx.me.u, note: 'Created the page' }] });
        return;
      }
      const [, pg] = pageAt(tx, i.space, i.page), doc = docOf(tx, i.space, pg[0], i.base);
      tx.edit('spaces', i.space, x => { x.pages = x.pages.map((p, k) => k === i.page ? [title, tx.now] : p); });
      if (pageSlug(pg[0]) !== pageSlug(title)) tx.mapDel('pagedocs', `${i.space}/${pageSlug(pg[0])}`);
      tx.mapPut('pagedocs', `${i.space}/${pageSlug(title)}`, { t: title, text: body, by: doc.by, ed: tx.me.u, revs: [{ by: tx.me.u, note: 'Edited the page' }, ...doc.revs] });
    } });
  proc('pages.restore', { input: obj({ space: ID, page: int, rev: int, note: str, 'base?': BASE_DOC }), output: 'null', who: 'member', errors: ['NOT_FOUND', 'CONFLICT'], writes: ['pagedocs'],
    note: 'restore an earlier version; the history keeps both (note: the history line, written by the page)',
    run: (tx, i) => {
      const [, pg] = pageAt(tx, i.space, i.page), doc = docOf(tx, i.space, pg[0], i.base);
      if (!doc.revs[i.rev]) throw rpcError('NOT_FOUND', 'The server has no record of this version.');
      tx.mapPut('pagedocs', `${i.space}/${pageSlug(pg[0])}`, { ...doc, ed: tx.me.u, revs: [{ by: tx.me.u, note: i.note }, ...doc.revs] });
    } });
  proc('pages.remove', { input: obj({ space: ID, page: int }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['pagedocs', 'spaces'],
    run: (tx, i) => { const [, pg] = pageAt(tx, i.space, i.page); tx.edit('spaces', i.space, x => { x.pages = x.pages.filter((_, k) => k !== i.page); }); tx.mapDel('pagedocs', `${i.space}/${pageSlug(pg[0])}`); } });
  proc('pages.move', { input: obj({ space: ID, from: int, to: int }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['spaces'],
    note: 'swap a page with the one above or below it in About',
    run: (tx, i) => { pageAt(tx, i.space, i.from); pageAt(tx, i.space, i.to); tx.edit('spaces', i.space, x => { const p = x.pages.slice(); [p[i.from], p[i.to]] = [p[i.to], p[i.from]]; x.pages = p; }); } });

  /* -- API keys: TODO(limits) stubs. Not encrypted (owner decision), no usage accounting; the key check is
     simulated by the page (acCheckKey) and its result written as a server job until the backend checks keys. */
  const keyProvider = v => v.startsWith('AIza') ? 'Google' : v.startsWith('sk-ant-') ? 'Anthropic' : v.startsWith('sk-or-') ? 'OpenRouter' : 'OpenAI';
  const keyMask = v => `${v.slice(0, v.startsWith('sk-ant-') ? 7 : v.startsWith('AIza') ? 4 : 3)}…${v.slice(-4)}`;
  const rawKey = (tx, raw, except) => { if (raw.trim().length < 8) throw bad1('raw', 'an API key'); if (tx.get('userKeys').some(k => k.raw === raw && k.id !== except)) throw rpcError('CONFLICT', 'This key has already been added.'); return raw.trim(); };
  proc('apiKeys.create', { input: obj({ raw: str, label: str, 'cap?': num, 'check?': bool }), output: '{ id: KeyId }', who: 'user', errors: ['CONFLICT'], stub: true, writes: ['userKeys'],
    note: 'TODO(limits) stub. check: the key is checked with its provider (state "checking"); without it the key counts as valid. raw is write-only.',
    run: (tx, i) => {
      const raw = rawKey(tx, i.raw), id = tx.id(), k = { id, kind: 'key', raw, label: i.label.trim() || `API key ${tx.get('userKeys').length + 1}`, mask: keyMask(raw), provider: keyProvider(raw) };
      if (i.check) Object.assign(k, { valid: false, lastUsedAt: null, used: 0, cap: i.cap || 0, check: 'checking' }); else k.valid = true;
      tx.put('userKeys', k);
      return { id };
    } });
  proc('apiKeys.replace', { input: obj({ id: ID, raw: str }), output: 'null', who: 'user', errors: ['NOT_FOUND', 'CONFLICT'], stub: true, writes: ['userKeys'],
    note: 'TODO(limits) stub: a new raw key under the same name; it is checked again',
    run: (tx, i) => { const raw = rawKey(tx, i.raw, i.id); tx.edit('userKeys', i.id, k => { Object.assign(k, { raw, mask: keyMask(raw), provider: keyProvider(raw), createdAt: tx.now, lastUsedAt: null, used: 0, check: 'checking', valid: false }); delete k.reason; }, 'key'); } });
  proc('apiKeys.check', { input: obj({ id: ID }), output: 'null', who: 'user', errors: ['NOT_FOUND'], stub: true, writes: ['userKeys'],
    note: 'TODO(limits) stub: check the key with its provider again', run: (tx, i) => { tx.edit('userKeys', i.id, k => { k.check = 'checking'; k.valid = false; delete k.reason; }, 'key'); } });
  proc('apiKeys.rename', { input: obj({ id: ID, label: str }), output: 'null', who: 'user', errors: ['NOT_FOUND'], stub: true, writes: ['userKeys'],
    run: (tx, i) => { const label = text(i.label, 'label'); tx.edit('userKeys', i.id, k => { k.label = label; }, 'key'); } });
  proc('apiKeys.setCap', { input: obj({ id: ID, cap: num }), output: 'null', who: 'user', errors: ['NOT_FOUND'], stub: true, writes: ['userKeys'],
    note: 'TODO(limits) stub: a monthly token limit for the key (0: none), stored and not enforced', run: (tx, i) => { tx.edit('userKeys', i.id, k => { k.cap = i.cap; }, 'key'); } });
  proc('apiKeys.revoke', { input: obj({ id: ID }), output: 'null', who: 'user', errors: ['NOT_FOUND'], stub: true, writes: ['userKeys', 'usage'],
    note: 'TODO(limits) stub. When the key was the default key (usage.def, or the first valid key when none is set), the next valid key becomes the default, or none; the answer returns the usage record.',
    run: (tx, i) => {
      tx.need('userKeys', i.id, 'key');
      const valid = tx.get('userKeys').filter(k => k.valid), u = tx.value('usage');
      const def = valid.find(k => k.id === u.def) || valid[0];
      tx.remove('userKeys', i.id);
      if (def && def.id === i.id) { const next = valid.find(k => k.id !== i.id); tx.setValue('usage', { ...u, def: next ? next.id : null }); }
    } });

  /* -- profile and settings -- */
  proc('profile.update', { input: S.Profile, output: 'null', who: 'user', wire: 'User', writes: ['profile'],
    run: (tx, i) => tx.setValue('profile', { name: text(i.name, 'name'), bio: i.bio.trim() }) });
  proc('settings.update', { input: obj({ 'emailOn?': bool, 'types?': rec(bool), 'emailNew?': nul(str), 'export?': bool, 'spaces?': rec(str) }, 'UpdateSettingsInput'), output: 'null', who: 'user', wire: 'UserSettings', writes: ['acct'],
    note: 'notification settings (types and spaces are merged), a new email address waiting for confirmation (null cancels it), and a data export (export: true; the server records when)',
    run: (tx, i) => {
      const a = tx.value('acct');
      if (i.emailNew && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.emailNew)) throw bad1('emailNew', 'an email address');
      if (i.emailOn !== undefined) a.emailOn = i.emailOn;
      if (i.types) Object.assign(a.types, i.types);
      if (i.spaces) Object.assign(a.spaces, i.spaces);
      if (i.emailNew !== undefined) a.emailNew = i.emailNew;
      if (i.export) a.exportAt = tx.now;
      tx.setValue('acct', a);
    } });

  /* -- sources added to spaces -- */
  /* a new source record for a URL or file: what the server reads from it (dsMake in the page did this) */
  function sourceFor(u, file, id) {
    u = (u || '').trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '');
    const host = (u.split('/')[0] || u).toLowerCase();
    const pl = file || /\.pdf$/i.test(u) ? 'pdf' : /^(x|twitter)\.com/.test(host) ? 'x' : /youtube|youtu\.be/.test(host) ? 'yt' : /arxiv/.test(host) ? 'arxiv' : /substack/.test(host) ? 'substack' : /lesswrong/.test(host) ? 'lw' : 'web';
    const kind = pl === 'x' ? 'post' : pl === 'yt' ? 'video' : 'article';
    const raw = (file || u.split('/').slice(1).filter(Boolean).pop() || host).replace(/\.(pdf|html?)$/i, '').replace(/[-_]+/g, ' ').trim();
    const m = { id, pl, kind, au: pl === 'x' ? '@' + (u.split('/')[1] || 'x') : file ? 'Uploaded file' : host, h: host, len: pl === 'pdf' || pl === 'arxiv' ? 'PDF, 12 pages' : kind === 'video' ? '24 min' : kind === 'post' ? '1 post' : '6 min read', tok: pl === 'pdf' ? 9e3 : 2e3, sp: [], url: file ? 'session.app/files/' + encodeURIComponent(file) : u, desc: '', sum: '', body: [{ p: kind === 'post' ? `Post by ${pl === 'x' ? '@' + (u.split('/')[1] || 'x') : host}.` : 'Reader copy of the page.' }] };
    if (kind !== 'post') m.t = raw ? raw[0].toUpperCase() + raw.slice(1) : host;
    return m;
  }
  const normUrl = u => (u || '').trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
  const srcColl = (tx, id) => tx.find('media', id) ? 'media' : tx.find('miAdded', id) ? 'miAdded' : null;
  proc('spaceSources.add', { input: obj({ space: ID, 'source?': ID, 'url?': str, 'file?': str, 'note?': str, 'policy?': str }, 'AddSpaceSourceInput'), output: '{ id: SourceId, review: boolean }', who: 'member', errors: ['NOT_FOUND', 'PRECONDITION_FAILED'], writes: ['dsDrops', 'media', 'miAdded', 'miRead'],
    note: 'add a source to a space: one Session has (source), or a URL or file it reads now (a new source record, id from the server). In a space whose policy is "review", a member’s source waits for a moderator.',
    run: (tx, i) => {
      const s = writable(tx, i.space);
      let id = i.source;
      if (id != null) { if (!srcColl(tx, id)) throw rpcError('NOT_FOUND'); }
      else {
        if (!i.url && !i.file) throw bad1('url', 'a URL or a file');
        const known = !i.file && [...tx.get('media'), ...tx.get('miAdded')].find(m => m.url && normUrl(m.url) === normUrl(i.url));
        if (known) id = known.id; else { id = tx.id(); tx.put('miAdded', sourceFor(i.url, i.file, id)); }
      }
      const drops = tx.mapGet('dsDrops', s.id) || [];
      if (drops.some(d => d.m === id && !d.rm)) throw rpcError('PRECONDITION_FAILED', 'The space already has this source.');
      const mod = tx.get('rel')[s.id] === 'mod' || (tx.get('joined').includes(s.id) && !!tx.get('roles')[s.id]), rv = (tx.get('dsPol')[s.id] || 'members') === 'review' && !mod;
      tx.mapPut('dsDrops', s.id, [{ m: id, by: tx.me.u, note: (i.note || '').trim(), rv }, ...drops]);
      const k = srcColl(tx, id), m = tx.find(k, id);
      if (!m.sp.includes(s.id)) tx.edit(k, id, x => { x.sp = [...x.sp, s.id]; });
      if (!tx.get('miRead').has(id)) flip(tx, 'miRead', id, true);
      return { id, review: rv };
    } });
  proc('spaceSources.review', { input: obj({ space: ID, source: ID, decision: one('approve', 'reject', 'remove', 'restore', 'keep') }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['dsDrops', 'dsReps'],
    note: 'approve or reject a source waiting for review, remove one from the space or restore it (Undo), or keep a reported one. Reject and keep resolve its reports.',
    run: (tx, i) => {
      const l = tx.mapGet('dsDrops', i.space) || [], want = i.decision === 'restore' ? x => x.rm : x => !x.rm;
      const j = l.findIndex(x => x.m === i.source && want(x));
      if (j >= 0) { const x = l[j]; if (i.decision === 'approve') x.rv = false; if (i.decision === 'reject' || i.decision === 'remove') x.rm = true; if (i.decision === 'restore') x.rm = false; tx.mapPut('dsDrops', i.space, l); }
      else if (i.decision !== 'keep') throw rpcError('NOT_FOUND', 'The space has no record of this source.');
      if (i.decision === 'keep' || i.decision === 'reject') { const r = tx.value('dsReps'), r2 = r.filter(x => !(x.sid === i.space && x.m === i.source)); if (r2.length !== r.length) tx.setValue('dsReps', r2); }
    } });
  proc('spaceSources.setPolicy', { input: obj({ space: ID, policy: str }), output: 'null', who: 'admin', errors: ['NOT_FOUND'], writes: ['dsPol'],
    note: 'who can add sources: members, members with review, or moderators', run: (tx, i) => { tx.need('spaces', i.space, 'space'); tx.mapPut('dsPol', i.space, i.policy); } });
  proc('sourceReports.create', { input: obj({ space: ID, source: ID, why: str }), output: 'null', who: 'member', errors: ['NOT_FOUND'], writes: ['dsReps'],
    run: (tx, i) => { tx.need('spaces', i.space, 'space'); if (!srcColl(tx, i.source)) throw rpcError('NOT_FOUND'); tx.setValue('dsReps', [...tx.value('dsReps'), { m: i.source, sid: i.space, by: tx.me.u, why: i.why }]); } });

  /* the procedures' rows in the contract table */
  for (const [name, P] of Object.entries(PROCS)) {
    const who = P.who || 'user';
    const errors = [...new Set(['BAD_REQUEST', ...(P.errors || []), ...(ROLE_RANK[who] >= ROLE_RANK.user ? ['UNAUTHORIZED'] : []), ...(ROLE_RANK[who] >= ROLE_RANK.author ? ['FORBIDDEN'] : [])])];
    API.push({ method: 'POST', path: '/api/rpc/' + name, coll: null, op: 'rpc', input: describe(P.input, true), output: P.output || 'null', who, trpc: name, wire: P.wire || null, errors, writes: P.writes || [], bulk: false, scope: ['user'], ...(P.stub ? { stub: true } : {}), ...(P.note ? { note: P.note } : {}) });
  }

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
     createBackend({ fixtures, seed, scenarios, storageKey, latency, dev }):
     - fixtures: SessionFixtures ({ clock, me, data }): the seed data, the mock clock's start and the signed-in
       person. seed() can give the data instead (then the clock starts at the real time).
     - storageKey: the localStorage key. The stored database is kept while the seed's hash is the same.
     - latency: each request waits this long (ms).
     - scenarios: SessionScenarios (session-web-spaces-scenarios.js), for POST /api/dev/scenario.
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
  function createBackend({ fixtures, seed, scenarios, storageKey = 'session-mock-db-v5', latency = 120, dev = false }) {
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

    /* ---- mutations: one transaction per procedure call ----
       Writes go to staged copies of the collections; commit() puts them in the database and saves it, and
       returns the changed records; abort() keeps nothing (the id counter goes back too). */
    function transaction(d) {
      const staged = {}, touched = {}, ids0 = ids;
      const copy = v => v === undefined ? undefined : dec(enc(v));
      const cur = k => (k in staged ? staged[k] : d[k]);
      const own = k => { if (!(k in staged)) { const v = d[k]; staged[k] = v instanceof Set ? new Set(v) : Array.isArray(v) ? v.slice() : v && typeof v === 'object' ? { ...v } : v; } return staged[k]; };
      const mark = (k, x) => (touched[k] = touched[k] || new Set()).add(String(x));
      const idOf = (k, x) => String(x[C[k].id]);
      const tx = {
        me, now: cfg.now,
        id: () => newId(),
        get: k => cur(k),
        value: k => copy(cur(k)),
        find: (k, id) => cur(k).find(x => idOf(k, x) === String(id)),
        need: (k, id, what) => { const x = tx.find(k, id); if (!x) throw rpcError('NOT_FOUND', what ? `The server has no record of this ${what}. Someone may have deleted it.` : undefined); return copy(x); },
        put: (k, rec, at) => {
          const l = own(k), id = idOf(k, rec), i = l.findIndex(x => idOf(k, x) === id);
          const s = storeRecord(k, rec, i >= 0 ? l[i] : undefined);
          if (i >= 0) l[i] = s; else if (at === 'start') l.unshift(s); else l.push(s);
          mark(k, id); return copy(s);
        },
        edit: (k, id, fn, what) => { const x = tx.need(k, id, what), r = fn(x); return tx.put(k, r === undefined ? x : r); },
        remove: (k, id) => { const l = own(k), i = l.findIndex(x => idOf(k, x) === String(id)); if (i >= 0) { l.splice(i, 1); mark(k, id); } },
        mapGet: (k, key) => copy(cur(k)[key]),
        mapPut: (k, key, v) => { own(k)[key] = stampValue(k, copy(v)); mark(k, key); },
        mapDel: (k, key) => { if (key in cur(k)) { delete own(k)[key]; mark(k, key); } },
        setValue: (k, v) => { staged[k] = stampValue(k, v instanceof Set ? new Set(v) : copy(v)); mark(k, '*'); },
        abort: () => { ids = ids0; },
      };
      tx.commit = () => {
        /* every staged collection must still pass its schema: a failed check is a bug in a procedure */
        for (const k of Object.keys(staged)) { const issues = checkWhole(k, staged[k], { ...d, ...staged }, true); if (issues.length) { fail(`a procedure wrote ${k} that fails its schema: ${issues.slice(0, 3).map(i => `${i.path}: expected ${i.expected}`).join('; ')}`); throw rpcError('INTERNAL_SERVER_ERROR'); } }
        /* records whose derived fields depend on what changed */
        const dep = { posts: new Set(), spaces: new Set() };
        if (touched.liked) { const a = d.liked, b = staged.liked; new Set([...a, ...b]).forEach(x => { if (a.has(x) !== b.has(x)) dep.posts.add(x); }); }
        ['fu', 'rp', 'qtd'].forEach(k => (touched[k] || []).forEach(x => dep.posts.add(x)));
        if (touched.mem) dep.spaces.add(C.mem.space);
        (touched.memOther || []).forEach(x => dep.spaces.add(x));
        const before = {};
        for (const k of Object.keys(staged)) if (C[k].kind === 'list') before[k] = new Set(d[k].map(x => idOf(k, x)));
        Object.assign(d, staged); save();
        for (const [k, s] of Object.entries(dep)) s.forEach(x => { if (d[k].some(y => idOf(k, y) === x)) mark(k, x); });
        const changes = {};
        for (const [k, keys] of Object.entries(touched)) {
          const c = C[k];
          if (c.kind === 'value') { changes[k] = { value: d[k] }; continue; }
          if (c.kind === 'map') { const put = {}, del = []; keys.forEach(x => { if (x in d[k]) put[x] = d[k][x]; else del.push(x); }); changes[k] = { put, del }; continue; }
          const put = [], del = [], at = {};
          keys.forEach(x => { const i = d[k].findIndex(y => idOf(k, y) === x); if (i < 0) { del.push(x); return; } put.push(viewOne(k, d[k][i], d)); if (!(before[k] || new Set()).has(x)) at[x] = i; });
          changes[k] = Object.keys(at).length ? { put, del, at } : { put, del };
        }
        return changes;
      };
      return tx;
    }

    /* the dev check of the seed: every record must pass its collection's schema */
    function checkSeed(d) {
      for (const [k, c] of Object.entries(C)) {
        if (!(k in d)) { fail(`no seed data for ${k} (${c.path})`); continue; }
        const issues = checkWhole(k, d[k], d, true);
        if (issues.length) fail(`seed data for ${k} fails its schema: ${issues.slice(0, 3).map(i => `${i.path}: expected ${i.expected}`).join('; ')}`);
      }
    }
    /* the schema of a whole collection, with id and key checks; unique: list ids must be unique (the seed, and
       what a transaction wrote) */
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

    /* ---- scenarios (step 10): the Screen entries' data, set up on the server ----
       POST /api/dev/scenario { name, args? }. The database goes back to the seed (one deep copy of it per
       call); then the scenario writes to it in one transaction (scenarios: SessionScenarios, from
       session-web-spaces-scenarios.js; the transaction's schema checks apply). The answer is
       { changes }, in the shape of a procedure's changes: every record that differs from the database
       before the call, as GET returns it. A list whose order changed also carries `order`: its ids, in order.
       The id counter is not reset, so ids stay unique across scenarios (the page may still hold old ones, in
       its history entries and its map of temporary ids). A scenario writes as the server: no permission
       checks (step 5 must keep it that way). */
    const SC = (scenarios && scenarios.list) || {};
    /* every collection as GET returns it, each record encoded once, for the comparison */
    function snapshot(d) {
      const o = {};
      for (const [k, c] of Object.entries(C)) {
        if (!(k in d)) continue;
        if (c.kind === 'list') { const views = d[k].map(x => viewOne(k, x, d)); o[k] = { ids: views.map(x => String(x[c.id])), views, codes: new Map(views.map(x => [String(x[c.id]), enc(x)])) }; }
        else if (c.kind === 'map') o[k] = new Map(Object.entries(d[k]).map(([key, v]) => [key, enc(v)]));
        else o[k] = enc(d[k]);
      }
      return o;
    }
    function changesBetween(a, b, d) {
      const changes = {};
      for (const [k, c] of Object.entries(C)) {
        if (!(k in b)) continue;
        const x = a[k], y = b[k];
        if (c.kind === 'value') { if (x !== y) changes[k] = { value: d[k] }; continue; }
        if (c.kind === 'map') {
          const put = {}, del = [];
          y.forEach((v, key) => { if (!x || x.get(key) !== v) put[key] = d[k][key]; });
          if (x) x.forEach((v, key) => { if (!y.has(key)) del.push(key); });
          if (Object.keys(put).length || del.length) changes[k] = { put, del };
          continue;
        }
        const put = y.views.filter(v => !x || x.codes.get(String(v[c.id])) !== y.codes.get(String(v[c.id])));
        const del = x ? x.ids.filter(id => !y.codes.has(id)) : [];
        /* the order the page gets by keeping its records in place and adding new ones at the end */
        const kept = x ? x.ids.filter(id => y.codes.has(id)) : [], fresh = y.ids.filter(id => !x || !x.codes.has(id));
        const ch = { put, del };
        if ([...kept, ...fresh].join('\n') !== y.ids.join('\n')) ch.order = y.ids;
        if (put.length || del.length || ch.order) changes[k] = ch;
      }
      return changes;
    }
    /* what a scenario can use besides tx: the server's own rules for memberships and ask trees, the
       procedures (their run, without permission checks), and times relative to the mock clock */
    const AGO_MIN = { m: 1, h: 60, d: 1440, w: 10080 };
    const isoOf = ms => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const helpers = tx => ({
      /* an ISO time this long before the clock ("3h", "2d", "1mo"), as the page's isoAgo */
      ago: a => { const m = /^(\d+)(mo|m|h|d|w)$/.exec(a), n = +m[1]; const [lo, hi] = m[2] === 'mo' ? [Math.max(30 * n, 56) * 1440, (30 * n + 30) * 1440] : [n * AGO_MIN[m[2]], (n + 1) * AGO_MIN[m[2]]]; return isoOf(Date.parse(cfg.now) - (lo + hi) / 2 * 60e3); },
      rel: (sid, r) => setRelation(tx, sid, r),
      tree: th => askTree(tx, th),
      proc: (name, input) => {
        const P = PROCS[name]; if (!P) throw new Error(`no procedure ${name}`);
        const issues = check(P.input, input, 'input'); if (issues.length) throw new Error(`${name}: ${issues.map(i => `${i.path}: expected ${i.expected}`).join('; ')}`);
        return P.run(tx, input);
      },
    });
    function scenario(body) {
      const sc = body && typeof body === 'object' && SC[body.name];
      if (!sc) return err('BAD_REQUEST', undefined, { issues: [`name: expected one of ${Object.keys(SC).join(', ')}`] });
      if (body.args !== undefined && check(t.rec(t.any), body.args).length) return err('BAD_REQUEST', undefined, { issues: ['args: expected an object'] });
      const before = snapshot(db0());
      /* the id counter keeps counting: an id the server gave out before is not given to another record */
      data = seedData();
      const tx = transaction(data), h = helpers(tx), args = body.args || {};
      try {
        if (sc.run) sc.run(tx, args, h);
        tx.commit();
      } catch (e) {
        tx.abort(); save();
        fail(`scenario ${body.name} failed: ${e && e.message}`);
        return err('INTERNAL_SERVER_ERROR', `The scenario ${body.name} failed: ${e && e.message}`);
      }
      return out(200, { changes: changesBetween(before, snapshot(data), data) });
    }

    function handle(method, url, body, origin) {
      const [path, qs] = url.split('?');
      const hits = matchPath(path);
      if (!hits.length) { fail(`no API entry for ${method} ${path}`); return { res: err('NOT_FOUND', 'The server has no address like this.') }; }
      const hit = hits.find(h => h.r.method === method);
      if (!hit) {
        /* a collection write without a row: only the ask pipeline and the usage stub write collections */
        if (method !== 'GET' && hits.some(h => h.r.coll)) fail(`no collection write ${method} ${path}${origin ? ` (from ${origin})` : ''}: a person's action is a procedure, and a Screen entry's data a scenario`);
        return { res: err('METHOD_NOT_SUPPORTED') };
      }
      const { r, id } = hit;
      if (r.coll && r.scope && !r.scope.includes(origin)) fail(`${method} ${path} from ${origin || 'an unknown origin'}: this collection write is for ${r.scope.join(', ')} only`);
      if (r.dev) {
        if (r.op === 'dev-reset') { data = seedData(); ids = 0; save(); return { res: out(204) }; }
        if (r.op === 'dev-scenario') return { res: scenario(body) };
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
      if (r.op === 'rpc') {
        const P = PROCS[r.trpc], input = body === undefined ? {} : body;
        const issues = check(P.input, input, 'input');
        if (issues.length) return { res: bad(issues) };
        const tx = transaction(d);
        try {
          const result = P.run(tx, input);
          const changes = tx.commit();
          return { res: out(200, { result: result === undefined ? null : result, changes }) };
        } catch (e) {
          tx.abort();
          if (e && e.rpcCode) return { res: err(e.rpcCode, e.message, e.issues ? { issues: e.issues } : undefined) };
          throw e;
        }
      }
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
        /* who sent a collection write (the page's X-Session-Origin): run (the ask pipeline), stub, or user (a bug) */
        const h = init.headers || {}, origin = typeof h.get === 'function' ? h.get('X-Session-Origin') : h['X-Session-Origin'];
        try { const body = init.body ? dec(init.body) : undefined; ({ res, forced: forcedErr } = handle(method, url, body, origin)); }
        catch (e) { console.error('[mock api]', e); res = err('INTERNAL_SERVER_ERROR'); }
        const entry = { seq: ++seq, method, path: url.split('?')[0], status: res.status, code: null };
        if (origin) entry.origin = origin;
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
      /* the seed data as GET returns it (derived fields included), without touching the database: the page
         reads it while it starts */
      seedView: () => { const d = seedData(); return dec(enc(Object.fromEntries(Object.keys(d).map(k => [k, viewAll(k, d)])))); },
    };
  }

  window.SessionMockApi = { enc, dec, CODES, STATUS, API, PROCEDURES: PROCS, COLLECTIONS: C, SCHEMAS: S, NOTIFICATION_TYPES, check, describe, ulid, createBackend };
})();
