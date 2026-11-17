/* Session mock API: the in-page backend for session-web-spaces.html.

   Loaded with a plain <script src> before the page's main script; it is opened from file:// and also
   published as a multi-file page, so it is a classic script that defines one global, SessionMockApi.

   Owner decisions for the backend work (they apply to this file and to the later steps):
   - The mock backend and its fixtures may move out of the HTML into separate .js files. This file holds
     the backend; the fixtures stay in the HTML until step 6 and are passed in as the seed.
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

   Contents
   1. The wire codec (JSON; Sets travel as { $set: [...] }). The page uses this copy.
   2. Error codes: tRPC codes, their HTTP status, and a default user-facing message.
   3. Record schemas and a small validator (no library).
   4. Collections: how the server stores each one.
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
  const t = {
    str: { t: 'string' }, num: { t: 'number' }, bool: { t: 'boolean' }, any: { t: 'any' }, null: { t: 'null' },
    int: { t: 'integer' },
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
      case 'object': return `{ ${Object.entries(s.fields).map(([k, x]) => `${k}: ${describe(x)}`).join(', ')} }`;
      default: return s.t;
    }
  }

  const { str, num, bool, int, nul, arr, tup, set, rec, obj, one, named } = t;
  const SPACE_ROLE = one('Owner', 'Admin', 'Moderator', 'Member');
  const S = {};
  S.Space = obj({
    id: str, name: str, title: str,
    'av?': num, 'members?': num, 'online?': num, 'posts?': num, 'created?': str, 'desc?': str,
    'rules?': arr(str), 'rulesPrev?': arr(str), 'rulesAt?': str, 'rulesBy?': str,
    'pages?': arr(tup(str, str)), 'mods?': arr(tup(str, str)), 'topics?': arr(tup(str, str)),
    'vis?': str, 'policy?': str, 'invite?': str, 'qs?': arr(obj({ q: str, 'req?': bool })),
    'faq?': bool, 'postsOff?': bool, 'plain?': bool, 'pageEdit?': str,
    /* TODO(limits): stub fields, stored as sent and not checked. The space token budget and the paying
       key stay as the mockup has them; the backend does no token accounting (owner decision). */
    'budget?': t.any, 'used?': t.any, 'pct?': t.any, 'byok?': t.any, 'key?': t.any,
  }, 'Space');
  S.Thread = obj({
    s: str, u: str, k: one('ask', 'post'), q: str,
    'mine?': bool, 't?': nul(str), 'sum?': nul(str), 'r?': num, 'tok?': num, 'age?': str, 'likes?': num,
    'about?': t.obj({ 'it?': str, 'its?': arr(str), 'b?': num }), 'rf?': str, 'kw?': str,
    'topic?': nul(str), 'topicBy?': nul(str), 'running?': bool,
    'pay?': t.any,   /* TODO(limits): who pays for the ask (a key or a space budget), stored as sent */
    'fail?': obj({ why: str, 'at?': num }), 'edited?': bool, 'del?': bool, 'gone?': bool, 'skill?': nul(str),
    'from?': obj({ th: num, node: str }),
  }, 'Thread');
  S.Reply = t.named('Reply', t.lazy(() => obj({ u: str, age: str, t: str, 'kids?': arr(S.Reply), 'del?': bool, 'edited?': bool })));
  S.FollowUp = obj({ u: str, age: str, q: str, 'a?': str, 'html?': str, 'del?': bool, 'edited?': bool }, 'FollowUp');
  S.AskNode = obj({ id: str, par: str, 'u?': str, 'age?': str, 'tok?': num, 'q?': str, 'html?': str, 'fu?': num, 'del?': bool, 'edited?': bool }, 'AskNode');
  S.AskTree = obj({ nodes: arr(S.AskNode) }, 'AskTree');
  S.Source = obj({
    id: str, pl: str, kind: str,
    'au?': str, 'h?': str, 'date?': str, 'age?': str, 'len?': str, 'tok?': num, 'sp?': arr(str), 'url?': str,
    'sum?': str, 'body?': arr(t.obj({})), 'pub?': str, 't?': str, 'desc?': str, 'by?': str, 'deleted?': str, 'paid?': num,
  }, 'Source');
  /* TODO(limits): API keys are a stub (owner decision): stored as written, not encrypted, no usage accounting. */
  S.ApiKey = obj({
    id: str, kind: str, label: str,
    'sub?': str, 'valid?': bool, 'reason?': str, 'raw?': str, 'provider?': str, 'added?': str, 'last?': str,
    'used?': num, 'cap?': num, 'check?': str,
  }, 'ApiKey');
  S.Notification = obj({
    id: str, k: str,
    /* open: a thread's position, or "item:<source>:<n>" / "thread:<id>" for source notifications */
    'u?': str, 'age?': str, 'unread?': bool, 'open?': t.or(num, str), 'qtNode?': str, 'text?': str, 'why?': str, 'sp?': str,
    'done?': str, 'ic?': str, 'page?': num,
  }, 'Notification');
  S.JoinRequest = obj({
    u: str, st: one('open', 'approved', 'declined'),
    'age?': str, 'since?': str, 'th?': num, 'common?': arr(str), 'bio?': str, 'a?': arr(str), 'why?': str, 'fresh?': bool, 'sp?': str,
  }, 'JoinRequest');
  S.Member = obj({ u: str, role: str, 'since?': str }, 'Member');
  S.Ban = obj({ id: str, sp: str, u: str, 'when?': str }, 'Ban');
  S.InviteLink = obj({ id: str, code: str, by: str, sp: str, 'exp?': str, 'dead?': str, 'usedBy?': str }, 'InviteLink');
  S.Report = obj({ id: str, sp: str, key: str, by: str, st: one('open', 'dismissed', 'hidden', 'removed'), 'why?': str, 'note?': str, 'age?': str }, 'Report');
  S.SpaceSource = obj({ m: str, by: str, age: str, 'note?': str, 'rv?': bool }, 'SpaceSource');
  S.SourceReport = obj({ m: str, sid: str, by: str, 'why?': str, 'age?': str }, 'SourceReport');
  S.Skill = named('Skill', tup(str, str));
  S.PageDoc = obj({ t: str, text: arr(str), 'by?': str, 'ed?': str, revs: arr(obj({ by: str, age: str, note: str })) }, 'PageDoc');
  S.Profile = obj({ name: str, bio: str }, 'Profile');
  S.Invite = named('Invite', nul(obj({ sp: str, by: str, state: str })));
  /* TODO(limits): token usage is simulated in the page for the Token model variants (owner decision:
     no server-side limit tracking yet). Stored as sent. */
  S.Usage = obj({ cap: num, reset: str, def: nul(str), movedSeen: bool, by: rec(rec(num)),
    skeys: rec(obj({ prov: str, mask: str, by: str, cap: num, used: num, member: num })) }, 'Usage');
  S.Settings = obj({ email: str, emailNew: nul(str), exportAt: nul(str), emailOn: bool, types: rec(bool), spaces: rec(str) }, 'Settings');
  S.ClosedSpaceState = one('none', 'pending', 'member', 'mod', 'denied');

  /* ---- 4. collections ----
     kind: 'list' (records with an id field), 'index' (records addressed by position), 'map' (values by key),
     'value' (one value, replaced whole). `item` is the schema of one record (list, index, map) or of the
     value. `key` checks a map key: 'thread' (a thread's position) or 'space' (a space id); for pages,
     the part before the "/" is a space id. */
  const C = {
    spaces:   { path: '/api/spaces', kind: 'list', id: 'id', item: S.Space },
    posts:    { path: '/api/threads', kind: 'index', item: S.Thread },
    rich:     { path: '/api/answers', kind: 'map', key: 'thread', item: named('AnswerHtml', str) },
    srcd:     { path: '/api/answer-sources', kind: 'map', key: 'thread', item: named('CitedPage[]', arr(arr(str))) },
    fu:       { path: '/api/follow-ups', kind: 'map', key: 'thread', item: named('FollowUp[]', arr(S.FollowUp)) },
    rp:       { path: '/api/replies', kind: 'map', key: 'thread', item: named('Reply[]', arr(S.Reply)) },
    qtd:      { path: '/api/ask-trees', kind: 'map', key: 'thread', item: S.AskTree },
    media:    { path: '/api/sources', kind: 'list', id: 'id', item: S.Source },
    miAdded:  { path: '/api/sources/new', kind: 'list', id: 'id', item: S.Source },
    joined:   { path: '/api/me/memberships', kind: 'value', item: named('SpaceId[]', arr(str)) },
    roles:    { path: '/api/me/roles', kind: 'value', item: named('Record<SpaceId, SpaceRole>', rec(SPACE_ROLE)) },
    roles0:   { path: '/api/me/roles/granted', kind: 'value', item: named('Record<SpaceId, SpaceRole>', rec(SPACE_ROLE)) },
    rel:      { path: '/api/me/closed-spaces', kind: 'map', key: 'space', item: S.ClosedSpaceState },
    liked:    { path: '/api/me/likes', kind: 'value', item: named('Set<ThreadIndex>', set(int)) },
    saved:    { path: '/api/me/saved', kind: 'value', item: named('Set<ThreadIndex>', set(int)) },
    qtSaved:  { path: '/api/me/saved-asks', kind: 'value', item: named('Set<AskNodeKey>', set(str)) },
    miSaved:  { path: '/api/me/saved-sources', kind: 'value', item: named('Set<SourceId>', set(str)) },
    miRead:   { path: '/api/me/read-sources', kind: 'value', item: named('Set<SourceId>', set(str)) },
    userKeys: { path: '/api/me/api-keys', kind: 'list', id: 'id', item: S.ApiKey },
    notifs:   { path: '/api/me/notifications', kind: 'list', id: 'id', item: S.Notification },
    askedInv: { path: '/api/me/invite-requests', kind: 'value', item: named('SpaceId[]', arr(str)) },
    invite:   { path: '/api/me/invite', kind: 'value', item: S.Invite },
    reqs:     { path: '/api/join-requests', kind: 'list', id: 'u', item: S.JoinRequest },
    mem:      { path: '/api/members', kind: 'value', item: named('Member[]', arr(S.Member)) },
    memOther: { path: '/api/members/other-spaces', kind: 'map', key: 'space', item: named('Member[]', arr(S.Member)) },
    banned:   { path: '/api/bans', kind: 'list', id: 'id', item: S.Ban },
    links:    { path: '/api/invite-links', kind: 'list', id: 'id', item: S.InviteLink },
    reports:  { path: '/api/reports', kind: 'list', id: 'id', item: S.Report },
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
    const many = c.kind === 'list' || c.kind === 'index' ? `${one}[]` : c.kind === 'map' ? `Record<string, ${one}>` : one;
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

    /* threads: the mock addresses a thread by its position in the list */
    row('posts', 'list', 'guest', 'research.listTrees', { wire: 'ResearchTreeSummary[]' }),
    row('posts', 'get', 'guest', 'research.getTree', { wire: 'ResearchTreeDetail' }),
    row('posts', 'replace', 'moderator', 'threads.moveToTopic', { note: 'a moderator moves several threads at once (deleted topics)' }),
    row('posts', 'put', 'author', ['research.createTree', 'research.createPost', 'research.updatePost'], { wire: 'ResearchTree', note: 'PUT at the next position creates a thread; otherwise it updates one (the author edits; moderators move or remove; the run sets the answer state)' }),

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

    /* TODO(limits): API keys are a stub: stored as sent (no encryption, no usage accounting) */
    row('userKeys', 'list', 'user', 'apiKeys.list', { stub: true }),
    row('userKeys', 'replace', 'user', 'apiKeys.replaceAll', { stub: true }),
    row('userKeys', 'create', 'user', 'apiKeys.add', { stub: true }),
    row('userKeys', 'put', 'user', ['apiKeys.rename', 'apiKeys.replace', 'apiKeys.setCap', 'apiKeys.check'], { stub: true }),
    row('userKeys', 'delete', 'user', 'apiKeys.revoke', { stub: true }),

    row('notifs', 'list', 'user', 'notifications.list', { wire: 'InboxNotificationPage' }),
    row('notifs', 'replace', 'user', 'notifications.markAllRead'),
    row('notifs', 'create', 'server', null, { wire: 'InboxNotification', note: 'the real server creates notifications (notification.requested)' }),
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
    row('profile', 'list', 'user', 'auth.me', { wire: 'User' }),
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

    /* development only: not part of the product API */
    { method: 'POST', path: '/api/dev/reset', coll: null, op: 'dev-reset', input: null, output: null, who: 'guest', trpc: null, wire: null, errors: [], dev: true, note: 'back to the seed data' },
    { method: 'GET', path: '/api/dev/config', coll: null, op: 'dev-config', input: null, output: 'DevConfig', who: 'guest', trpc: null, wire: null, errors: [], dev: true },
    { method: 'PUT', path: '/api/dev/config', coll: null, op: 'dev-config', input: 'Partial<DevConfig>', output: 'DevConfig', who: 'guest', trpc: null, wire: null, errors: ['BAD_REQUEST'], dev: true,
      note: 'DevConfig: { latency, failWrites, failReads, failCode, failOn: { code, paths: string[], methods?: string[], times? } | null }' },
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
     createBackend({ seed, storageKey, latency, dev }):
     - seed(): the seed data (the page's fixtures), keyed by collection; read when the database is first used.
     - storageKey: the localStorage key. The stored database is kept while the seed's hash is the same.
     - latency: each request waits this long (ms).
     - dev: report contract mismatches (console.error, and an uncaught error so test harnesses fail).
     Returns { cfg, wipe, restore, checkClient }. */
  function createBackend({ seed, storageKey = 'session-mock-db-v3', latency = 120, dev = false }) {
    const cfg = { base: latency, latency, failWrites: false, failReads: false, failCode: 'SERVICE_UNAVAILABLE', failOn: null };
    const log = window.__mockApiLog = [];
    const LOG_MAX = 400;   /* the newest requests; `seq` counts every request, so a test can take the ones after a mark */
    let seq = 0;
    let data = null, ver = null;
    const fail = msg => { console.error('[mock api] ' + msg); if (dev) setTimeout(() => { throw new Error('[mock api] ' + msg); }); };
    const seedData = () => { const s = seed(), o = {}; for (const k of Object.keys(C)) if (k in s) o[k] = s[k]; return dec(enc(o)); };
    const version = () => { if (ver) return ver; const t = enc(seedData()); let x = 2166136261; for (let i = 0; i < t.length; i++) { x ^= t.charCodeAt(i); x = Math.imul(x, 16777619); } return (ver = (x >>> 0).toString(36) + ':' + t.length); };
    const db0 = () => {
      if (data) return data;
      try { const s = localStorage.getItem(storageKey); if (s) { const o = dec(s); if (o && o.v === version()) return (data = o.data); } } catch (e) {}
      data = seedData();
      if (dev) checkSeed(data);
      return data;
    };
    const save = () => { try { localStorage.setItem(storageKey, enc({ v: version(), data })); } catch (e) {} };
    const out = (status, body) => new Response(body === undefined ? null : enc(body), { status, headers: { 'Content-Type': 'application/json' } });
    const err = (code, message, extra) => { const r = out(STATUS[code], Object.assign({ code, message: message || CODES[code][1] }, extra)); r.code = code; r.issues = extra && extra.issues; return r; };
    const bad = issues => err('BAD_REQUEST', undefined, { issues: issues.slice(0, 5).map(i => `${i.path}: expected ${i.expected}`) });

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
      if (c.key === 'thread') { if (!/^\d+$/.test(key)) return ['a thread position']; if (mode === 'NOT_FOUND' && +key >= (d.posts || []).length) return ['NOT_FOUND']; }
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
        if (r.op === 'dev-reset') { data = seedData(); save(); return { res: out(204) }; }
        if (method === 'PUT') {
          if (!body || typeof body !== 'object') return { res: err('BAD_REQUEST') };
          if (body.failCode && !CODES[body.failCode]) return { res: err('BAD_REQUEST', undefined, { issues: ['failCode: expected one of ' + Object.keys(CODES).join(', ')] }) };
          if (body.failOn && !CODES[body.failOn.code]) return { res: err('BAD_REQUEST', undefined, { issues: ['failOn.code: expected one of ' + Object.keys(CODES).join(', ')] }) };
          Object.assign(cfg, body);
        }
        return { res: out(200, cfg) };
      }
      const f = forced(method, path);
      if (f) return { res: err(f), forced: true };
      const d = db0(), k = r.coll, c = C[k];
      const pos = cur => c.kind === 'index' ? (/^\d+$/.test(id) ? +id : -1) : cur.findIndex(x => String(x[c.id]) === id);
      switch (r.op) {
        case 'list': return { res: out(200, d[k]) };
        case 'get': {
          const cur = d[k], v = c.kind === 'map' ? cur[id] : cur[pos(cur)];
          return { res: v === undefined ? err('NOT_FOUND') : out(200, v) };
        }
        case 'replace': {
          const issues = checkWhole(k, body, d);
          if (issues.length) return { res: bad(issues) };
          d[k] = body; save(); return { res: out(200, body) };
        }
        case 'create': {
          const issues = check(c.item, body, k);
          if (issues.length) return { res: bad(issues) };
          if (d[k].some(x => String(x[c.id]) === String(body[c.id]))) return { res: err('CONFLICT', 'An item with this id already exists.') };
          d[k] = qs === 'at=start' ? [body, ...d[k]] : [...d[k], body]; save(); return { res: out(201, body) };
        }
        case 'put': {
          const cur = d[k];
          if (c.kind === 'map') {
            const kb = checkKey(k, id, d, 'BAD_REQUEST'); if (kb.length) return { res: bad(kb.map(m => ({ path: `${k} key "${id}"`, expected: m }))) };
            const issues = check(c.item, body, `${k}.${id}`); if (issues.length) return { res: bad(issues) };
            if (checkKey(k, id, d, 'NOT_FOUND').length) return { res: err('NOT_FOUND') };
            cur[id] = body; save(); return { res: out(200, body) };
          }
          if (c.kind === 'index' && !/^\d+$/.test(id)) return { res: bad([{ path: `${k} position "${id}"`, expected: 'a position' }]) };
          const issues = check(c.item, body, `${k}[${id}]`); if (issues.length) return { res: bad(issues) };
          if (c.kind === 'list' && String(body[c.id]) !== id) return { res: bad([{ path: `${k}[${id}].${c.id}`, expected: `"${id}" (the id in the address)` }]) };
          const i = pos(cur);
          if (i >= 0 && i < cur.length) cur[i] = body; else if (c.kind === 'index' && i === cur.length) cur.push(body); else return { res: err('NOT_FOUND') };
          save(); return { res: out(200, body) };
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
      wipe: () => { data = null; try { localStorage.removeItem(storageKey); } catch (e) {} },
      restore: () => { window.fetch = realFetch; },
    };
  }

  window.SessionMockApi = { enc, dec, CODES, STATUS, API, COLLECTIONS: C, SCHEMAS: S, check, describe, createBackend };
})();
