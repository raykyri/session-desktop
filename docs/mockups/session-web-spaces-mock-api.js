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
     deletes a thread by marking it deleted (threads.delete).
   - Everything that points at a thread uses its id: the keys of /api/answers, /api/answer-sources,
     /api/follow-ups, /api/replies and /api/ask-trees; the members of likes and saves; "<thread>:<node>" in
     saved asks; "<kind>:<thread>[:…]" in report and moderation keys; a notification's thread; a thread's
     from.th.

   Mutations by intent (step 3)
   - A person's action is one procedure: POST /api/rpc/<name> (tRPC-style names, as in the real app's
     routers), answered with { result, changes }. The server validates the input, checks that the records
     exist, computes the new state (ids, counts, member lists, notifications it sends, memberships, roles),
     writes every collection it changes at once (all or none) and returns the changed records. See 5b.
   - There are no collection write rows (step 7): the page reads collections and calls procedures.

   Scenarios (step 10)
   - The Screen entries set up their data with POST /api/dev/scenario { name, args? }: the server goes back
     to the seed and runs a named scenario (session-web-spaces-scenarios.js, SessionScenarios) in one
     transaction, and answers { changes } as a procedure does. See createBackend (section 6).

   Runs as server jobs (step 7)
   - An ask runs on the server: the procedure that starts it (threads.create, threads.update with run,
     research.forkNode, followups.ask, followups.update with run, research.retryNode) writes a run record
     (/api/runs, research.listActivity) and the backend's job takes it through its progress steps on a timer.
     The job writes the answer, the run state and failures, the follow-up and ask-tree nodes, the
     notifications, and the token charge (a TODO(limits) stub). Stop is research.cancelNode. Key checks and
     domain checks are jobs too. What the run writes is in session-web-spaces-jobs.js (SessionJobs).
   - Progress reaches the page as events: GET /api/rpc/events.subscribe, opened with EventSource (patched by
     the backend), carries SessionEvent objects (web/docs/03-api-and-events.md §3). See section 6a.
   - Runs survive a reload: the run records are stored with the database and the jobs resume when the
     backend starts. /api/dev/config pauses jobs, sets their length and forces the next run to fail.

   Permissions (step 5)
   - The server checks `who` (section 5a): the rpc dispatcher before a procedure runs, and the REST router
     for the GET rows. Procedures whose rule depends on their input declare can(tx, input) next to `who`.
     Scenarios (and their h.proc) and the other /api/dev/* rows write as the server, without checks.
   - A request with the header X-Session-Auth: out has no session (signed out); the page sends it with a
     procedure it calls while its screen is signed out. The page's loads and scenarios are always the
     signed-in person's: the mockup's signed-out screens show the loaded data under a signed-out UI.
   - Reads are scoped, not refused: GET leaves out what the caller may not read (READ_RULES).
     In a closed space they are not a member of, a person gets the threads, follow-ups and asks they wrote, and
     the space's owner, admins and moderators (owner decision after step 5); GET /api/users gives a profile's
     count of spaces, closed spaces included.

   Edit conflicts (step 9)
   - A page document (rev), a skill (rev) and a space's rules (rulesAt) carry a
     version. The editor sends the version it opened as `base`; when someone else saved since, the procedure
     answers CONFLICT with `current` and `changes` and keeps nothing; `force: true` saves anyway (Overwrite).
     See "versions and edit conflicts" in section 5b.

   Paged lists (step 8)
   - The lists that grow without bound are read a page at a time: tRPC-style queries, GET /api/rpc/<name>?input=…,
     { cursor?, limit? } → { items, nextCursor } (notifications.list's shape in web/docs/03-api-and-events.md).
     Newest first by time, then id; read scope applies before the slice; cursors are opaque. See section 5c.
     The page's "Show more" button reads the next page (owner decision: no infinite scroll).

   Contents
   1. The wire codec (JSON; Sets travel as { $set: [...] }). The page uses this copy.
   2. Error codes: tRPC codes, their HTTP status, and a default user-facing message.
   3. Record schemas and a small validator (no library).
   4. Collections: how the server stores each one; derived fields; createdAt stamps.
   5. API: the contract table, one row per endpoint. The router serves only these rows.
      5a. Permissions: the caller's role in a space, the `who` check, and what GET returns to whom.
      5b. Procedures: the mutations, their transaction helper, and their rows in the table.
      5c. Paged lists: the queries that read a list a page at a time (step 8).
   6. createBackend(): the in-memory database, persisted to localStorage, behind a fetch patch for /api/*.
      6a. Jobs and the event stream (step 7).

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
     The reference for these schemas is web/packages/shared/src/schemas/spaces.ts (zod). They stay hand-written
     here so the page needs no build step; web/packages/shared/test/spacesMock.test.ts checks that they agree:
     that each S.* lists the same fields as its zod schema, and that the fixtures, the GET rows, the paged
     queries, every procedure's answer, the error bodies and the events pass the zod schemas.
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
  /* why an answer ended without one: stopped (research.cancelNode), tokens (nothing could pay), key (the provider
     rejected the key), rate (the provider limits requests; at: when Retry works again, ms), access (when the
     run started, the person who asked could no longer read the space, a source the ask is about, or use the key
     that pays), interrupted (the server could not resume the run after a restart) */
  const S_FAIL = obj({ why: one('stopped', 'tokens', 'key', 'rate', 'access', 'interrupted'), 'at?': num }, 'RunFailure');
  S.Space = obj({
    id: str, name: str, title: str, 'createdAt?': iso, 'updatedAt?': iso,
    'av?': num, 'img?': bool, 'online?': num, 'posts?': num, 'desc?': str,
    'members?': int,       /* derived: membersBase + the space's member list */
    'membersBase?': int,   /* members outside the fixtures; not returned */
    'rules?': arr(str), 'rulesPrev?': arr(str), 'rulesAt?': iso, 'rulesBy?': str,
    'pages?': arr(tup(str, iso)),   /* [title, edited at] */
    'mods?': arr(tup(str, str)), 'topics?': arr(tup(str, str)),
    'vis?': str, 'policy?': str, 'invite?': str, 'qs?': arr(obj({ q: str, 'req?': bool })),
    'faq?': bool, 'postsOff?': bool, 'plain?': bool, 'pageEdit?': str,
    'dom?': nul(obj({ domain: str, 'method?': str, 'state?': str, 'verifiedAt?': iso })),
    'archived?': obj({ by: str, on: str }),   /* spaces.archive: who archived it, and the day as the page shows it */
    'deleted?': bool,                          /* spaces.delete: the mock marks a deleted space */
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
    'model?': str,
    'fail?': S_FAIL, 'edited?': bool, 'del?': bool, 'gone?': bool, 'skill?': nul(str),
    'att?': int,    /* the number of the latest run (attempt) of its ask */
    'from?': obj({ th: str, node: str, 'lv?': int }),   /* the thread and ask node it was started from; lv: the node's depth */
  }, 'Thread');
  S.Reply = t.named('Reply', t.lazy(() => obj({ u: str, 'createdAt?': iso, t: str, 'likes?': int, 'kids?': arr(S.Reply), 'del?': bool, 'edited?': bool })));
  S.FollowUp = obj({ u: str, 'createdAt?': iso, q: str, 'a?': str, 'html?': str, 'del?': bool, 'edited?': bool }, 'FollowUp');
  S.AskNode = obj({ id: str, par: str, 'u?': str, 'createdAt?': iso, 'tok?': num, 'q?': str, 'html?': str, 'fu?': num, 'del?': bool, 'edited?': bool,
    'running?': bool, 'fail?': S_FAIL, 'pay?': t.any, 'model?': str, 'att?': int,
    'uses?': nul(arr(str)),   /* the answers (node ids) an ask compares */
    'promoted?': str,         /* the thread this branch became (threads.create with from) */
    'col?': bool,             /* the thread's author collapsed the branch */
  }, 'AskNode');
  /* A run in progress (research.listActivity): the job's state. Keyed by the node it answers, "<thread>:<node>"
     (node r: the thread's ask), as in saved asks; the real app's node ids are ULIDs. status: queued until the
     job starts it, then running; a finished run's record is removed. step: the progress step it is on (0 to 3);
     seq: the number of the run's last event. paused: a dev-only hold (a Screen entry's scenario): the job does
     not move it on. TODO(limits): pay as stored on the ask. */
  S.Run = obj({ th: str, node: str, u: str, status: one('queued', 'running'), attempt: int, seq: int, step: int, 'model?': nul(str), 'pay?': t.any, 'createdAt?': iso, 'paused?': bool }, 'Run');
  /* space: sent with a tree scoped to the caller's own asks (a closed space they are not a member of, READ_RULES) */
  S.AskTree = obj({ nodes: arr(S.AskNode), 'space?': str }, 'AskTree');
  S.Source = obj({
    id: str, pl: str, kind: str,
    'au?': str, 'h?': str, 'createdAt?': iso,   /* when the author published it */
    'updatedAt?': iso, 'len?': str, 'tok?': num, 'sp?': arr(str), 'url?': str,
    /* body: the reader copy's passages: a paragraph, a heading, a timed line with its speaker, a quoted post */
    'sum?': str, 'body?': arr(obj({ 'p?': str, 'h?': str, 'ts?': str, 'sp?': str, 'q?': obj({ au: str, h: str, t: str }) })), 'pub?': str, 't?': str, 'desc?': str, 'by?': str, 'paid?': num,
    'edited?': obj({ at: iso, b: num, 'old?': str }), 'deletedAt?': iso,
  }, 'Source');
  /* TODO(limits): API keys are a stub (owner decision): stored as written, not encrypted, no usage accounting.
     raw is write-only: stored, never returned (GET returns the mask). */
  S.ApiKey = obj({
    id: str, kind: str, label: str, 'createdAt?': iso, 'updatedAt?': iso,
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
    id: str, type: one(...NOTIFICATION_TYPES), 'createdAt?': iso, 'updatedAt?': iso, read: bool,
    'actor?': str, 'space?': str, 'thread?': str, 'node?': str, 'page?': int, 'source?': str, 'block?': int,
    'report?': str, 'item?': str, 'outcome?': one('dismissed', 'hidden', 'removed'), 'response?': one('accepted', 'declined'),
  }, 'Notification');
  S.JoinRequest = obj({
    u: str, st: one('open', 'approved', 'declined'), 'createdAt?': iso, 'updatedAt?': iso,
    'userCreatedAt?': iso,   /* when the applicant joined Session */
    'th?': num, 'common?': arr(str), 'bio?': str, 'a?': arr(str), 'why?': str, 'fresh?': bool, 'sp?': str,
  }, 'JoinRequest');
  S.Member = obj({ u: str, role: str, 'joinedAt?': iso }, 'Member');
  S.Ban = obj({ id: str, sp: str, u: str, 'createdAt?': iso, 'updatedAt?': iso }, 'Ban');
  /* revokedAt: a revoked link stays on the server (invites.restore puts it back); GET leaves it out */
  S.InviteLink = obj({ id: str, code: str, by: str, sp: str, 'createdAt?': iso, 'updatedAt?': iso, 'expiresAt?': nul(iso), 'dead?': str, 'usedBy?': str, 'revokedAt?': iso }, 'InviteLink');
  S.Report = obj({ id: str, sp: str, key: str, by: str, st: one('open', 'dismissed', 'hidden', 'removed'), 'why?': str, 'note?': str, 'createdAt?': iso, 'updatedAt?': iso }, 'Report');
  /* rv: waiting for a moderator's review; rm: removed from the space (spaceSources.review restores it) */
  S.SpaceSource = obj({ m: str, by: str, 'createdAt?': iso, 'note?': str, 'rv?': bool, 'rm?': bool }, 'SpaceSource');
  S.SourceReport = obj({ m: str, sid: str, by: str, 'why?': str, 'createdAt?': iso }, 'SourceReport');
  /* rev: the skill's version (step 9), counts its saves; 0 for a skill never edited */
  S.Skill = obj({ name: str, prompt: str, rev: int }, 'Skill');
  /* rev: the document's version (step 9), counts its saves; a page without a stored document is version 0 */
  S.PageDoc = obj({ t: str, text: arr(str), 'by?': str, 'ed?': str, 'rev?': int, revs: arr(obj({ by: str, 'createdAt?': iso, note: str })) }, 'PageDoc');
  S.Profile = obj({ name: str, bio: str }, 'Profile');
  /* what a profile shows of another person: the number of spaces they wrote threads in, closed spaces included */
  S.PersonSummary = obj({ spaces: int }, 'PersonSummary');
  S.Me = obj({ u: str, name: str, bio: str, x: str, createdAt: iso }, 'Me');
  /* TODO(limits): token usage is a stub (owner decision: no server-side limit tracking yet). The jobs charge
     asks to it (section 6a, charge) with the page's former arithmetic; people set the default key with
     usage.setDefaultKey. by: tokens this month per source ('session' or a key id) and space; cap: the included
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
    runs:     { path: '/api/runs', kind: 'map', key: 'node', item: S.Run },   /* the runs in progress, by "<thread>:<node>" */
    /* computed on every read from the threads, never stored: per person who wrote a thread, by handle */
    people:   { path: '/api/users', kind: 'map', key: 'handle', item: S.PersonSummary, computed: d => { const by = {}; for (const p of d.posts || []) (by[p.u] = by[p.u] || new Set()).add(p.s); return Object.fromEntries(Object.entries(by).map(([u, x]) => [u, { spaces: x.size }])); } },
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

     who: 'guest' (anyone, also signed out), 'user' (any signed-in user; /api/me/* rows are scoped to the
     caller), 'author' (the record's author), 'member' | 'moderator' | 'admin' | 'owner' (a role in the
     record's space; a higher role includes the lower ones). Enforced (step 5): see 5a. On a GET row a role is a scope:
     the list holds only the records of the spaces where the caller has it (`reads` says what).
     errors: the codes the row can return. UNAUTHORIZED and FORBIDDEN follow from `who` (and a
     procedure's can): UNAUTHORIZED on every row that needs a signed-in caller, FORBIDDEN on the writes
     that check a role, an author or an input rule. In dev, /api/dev/config can force any code on any row.
     trpc: the procedure in web/docs/03-api-and-events.md where one exists, otherwise a new name in the
     same style. Rows marked `bulk` replace a whole collection: the page's diff sends one when records move
     or several change at once (never for threads); the real app sends one mutation per change instead.
     stub: TODO(limits) rows: API keys and token usage, kept as they are, without accounting.
     Collections are read only (GET). A person's actions are procedures (section 5b); the Screen entries and
     the Variants bar's Reset use the scenario endpoint (dev, step 10); what an ask's run writes, the server's
     jobs write (step 7, section 6a). A collection write has no row: the router answers METHOD_NOT_SUPPORTED,
     and in dev it is an error. */
  const OPS = {
    list:    { method: 'GET', sub: '', errors: [] },
    get:     { method: 'GET', sub: '/:id', errors: ['NOT_FOUND'] },
    replace: { method: 'PUT', sub: '', errors: ['BAD_REQUEST'], bulk: true },
    create:  { method: 'POST', sub: '', errors: ['BAD_REQUEST', 'CONFLICT'] },
    put:     { method: 'PUT', sub: '/:id', errors: ['BAD_REQUEST', 'NOT_FOUND'] },
    delete:  { method: 'DELETE', sub: '/:id', errors: ['NOT_FOUND'] },
  };
  /* the auth codes a row can return: UNAUTHORIZED unless anyone may call it (guest); FORBIDDEN on a write that
     checks a role or the author (GET rows are scoped instead) */
  const ROLE_WHO = ['author', 'member', 'moderator', 'admin', 'owner'];
  const authErrors = (who, method) => [...(who !== 'guest' ? ['UNAUTHORIZED'] : []), ...(method !== 'GET' && ROLE_WHO.includes(who) ? ['FORBIDDEN'] : [])];
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
    const errors = [...new Set([...o.errors, ...(extra.errors || []), ...authErrors(who, o.method)])];
    return Object.assign({ method: o.method, path: c.path + o.sub, coll, op, input, output, who, trpc, wire: null, bulk: !!o.bulk }, extra, { errors });
  };
  const API = [
    row('spaces', 'list', 'guest', 'spaces.list', { note: 'every space record, closed ones included: a closed space’s landing (name, description, rules, member count, request questions) is public; its content is scoped (READ_RULES)' }),

    /* threads: addressed by id (a ULID). r, likes, liked and mine are derived on read. */
    row('posts', 'list', 'guest', 'research.listTrees', { wire: 'ResearchTreeSummary[]', reads: 'threads in open spaces and in the closed spaces the caller is a member of, and the threads the caller wrote in other closed spaces' }),
    row('posts', 'get', 'guest', 'research.getTree', { wire: 'ResearchTreeDetail', reads: 'NOT_FOUND for a thread the caller may not read' }),

    row('rich', 'list', 'guest', 'research.getNodeContent', { wire: 'ResearchNodeContent', reads: 'the threads the caller may read' }),
    row('rich', 'get', 'guest', 'research.getNodeContent', { wire: 'ResearchNodeContent', reads: 'NOT_FOUND for a thread the caller may not read' }),
    row('srcd', 'list', 'guest', 'research.getNodeContent', { wire: 'ResearchNodeContent', reads: 'the threads the caller may read' }),
    row('fu', 'list', 'guest', 'followups.list', { reads: 'in a closed space the caller is not a member of, only the follow-ups they wrote' }),
    row('rp', 'list', 'guest', 'research.getTree', { reads: 'the threads the caller may read' }),
    row('qtd', 'list', 'guest', 'research.getTree', { wire: 'ResearchTreeDetail', reads: 'in a closed space the caller is not a member of, only the asks they wrote, with the tree’s space' }),
    row('runs', 'list', 'guest', 'research.listActivity', { wire: 'ResearchNode[]', reads: 'the runs the caller may read (readScope’s readsRun): in a closed space they are not a member of, the runs of their own asks', note: 'the runs in progress, with their progress step: the page’s starting point, which the event stream then updates' }),

    row('media', 'list', 'guest', 'sources.list', { reads: 'without the closed spaces the caller is not a member of: a source only they have is left out' }),
    row('miAdded', 'list', 'user', 'sources.listNew', { reads: 'as sources.list' }),

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

    row('notifs', 'list', 'user', 'notifications.list', { wire: 'InboxNotificationPage' }),
    row('askedInv', 'list', 'user', 'invites.listRequested'),

    row('reqs', 'list', 'user', 'joinRequests.list', { reads: 'the caller’s own requests, and the requests to the spaces they moderate' }),
    row('mem', 'list', 'guest', 'sharing.listMembers', { wire: 'ThreadMember[]', note: 'space roles replace commenter and viewer', reads: 'an open space’s list is public; a closed space’s goes whole to its members, and to others as its owner, admins and moderators' }),
    row('memOther', 'list', 'guest', 'sharing.listMembers', { wire: 'ThreadMember[]', reads: 'as /api/members' }),
    row('banned', 'list', 'moderator', 'bans.list', { reads: 'the bans of the spaces the caller moderates' }),
    row('links', 'list', 'user', 'invites.list', { wire: 'ThreadInvite[]', reads: 'the links of the spaces the caller moderates, and the links they created; never revoked ones' }),
    row('reports', 'list', 'user', 'reports.list', { reads: 'the caller’s own reports, and the reports in the spaces they moderate' }),
    row('modSt', 'list', 'guest', 'moderation.list', { note: 'every reader needs it: hidden and removed items show as such', reads: 'the items the caller may read' }),

    row('dsDrops', 'list', 'guest', 'spaceSources.list', { reads: 'the spaces the caller may read; a source waiting for review only for the person who added it and the space’s moderators' }),
    row('dsPol', 'list', 'guest', 'spaceSources.policies'),
    row('dsReps', 'list', 'user', 'sourceReports.list', { reads: 'the caller’s own source reports, and those in the spaces they moderate' }),
    row('profile', 'list', 'user', 'profile.get', { wire: 'User' }),
    row('skills', 'list', 'guest', 'skills.list'),
    row('pagedocs', 'list', 'guest', 'pages.list', { reads: 'the spaces the caller may read' }),
    row('acct', 'list', 'user', 'settings.get', { wire: 'UserSettings' }),
    row('usage', 'list', 'user', 'usage.get', { stub: true, note: 'TODO(limits): token usage by source and space, the included tokens and the default key' }),
    row('muted', 'list', 'user', 'mutes.list'),
    row('blocked', 'list', 'user', 'blocks.list'),
    row('repSeen', 'list', 'user', 'notifications.unreadCount'),
    row('reqSeen', 'list', 'user', 'notifications.unreadCount'),
    row('rpLiked', 'list', 'user', 'likes.list'),
    row('people', 'list', 'guest', 'users.get', { wire: 'User', note: 'computed from the threads on every read: a profile’s count of spaces, closed spaces included (READ_RULES closedMembers: the count, not the list)' }),

    { method: 'GET', path: '/api/me', coll: null, op: 'me', input: null, output: 'Me', who: 'user', trpc: 'auth.me', wire: 'User', errors: ['UNAUTHORIZED'],
      note: 'the signed-in person; the server uses it for mine and liked' },
    { method: 'GET', path: '/api/rpc/events.subscribe', coll: null, op: 'events', input: null, output: 'stream of SessionEvent', who: 'user', trpc: 'events.subscribe', wire: 'SessionEvent', errors: ['UNAUTHORIZED'],
      note: 'the event stream (step 7): open it with EventSource (the backend patches it); fetch answers BAD_REQUEST. The first event is connection.ready; then run, node, notification and space events for what the caller may read (section 6a)' },

    /* development only: not part of the product API */
    { method: 'POST', path: '/api/dev/reset', coll: null, op: 'dev-reset', input: null, output: null, who: 'guest', trpc: null, wire: null, errors: [], dev: true, note: 'back to the seed data' },
    { method: 'POST', path: '/api/dev/scenario', coll: null, op: 'dev-scenario', input: '{ name: string, args?: object }', output: '{ changes }', who: 'guest', trpc: null, wire: null, errors: ['BAD_REQUEST', 'INTERNAL_SERVER_ERROR'], dev: true,
      note: 'a Screen entry’s data (step 10): back to the seed, then the named scenario (session-web-spaces-scenarios.js) in one transaction; changes: every record that differs from the database before the call' },
    { method: 'GET', path: '/api/dev/config', coll: null, op: 'dev-config', input: null, output: 'DevConfig', who: 'guest', trpc: null, wire: null, errors: [], dev: true },
    { method: 'PUT', path: '/api/dev/config', coll: null, op: 'dev-config', input: 'Partial<DevConfig>', output: 'DevConfig', who: 'guest', trpc: null, wire: null, errors: ['BAD_REQUEST'], dev: true,
      note: 'DevConfig: { now (the mock clock, an ISO time), latency, failWrites, failReads, failCode, failOn: { code, paths: string[], methods?: string[], times? } | null, readRules: the parts of the read scoping that are on (READ_RULES; a partial object is merged), jobs: "run" | "paused" (paused: no job moves on until it is "run" again), jobMs (a run’s length, ms), checkMs (a key or domain check’s length, ms), failNextRun: null | "tokens" | "key" | "rate" (the next thread ask that finishes fails so), resumeJobs (false: after a reload, runs in progress fail as interrupted instead of resuming), pageSize (null, or the default limit of every paged query, 1 to 100: a dev override for the Screen entries, step 8) }' },
  ];
  /* collections are read only (step 7): every write is a procedure, a job or a scenario */
  for (const a of API) if (a.coll && a.method !== 'GET') throw new Error(`${a.method} ${a.path}: collections have no write rows`);

  /* ---- 5a. permissions (step 5) ----
     The caller is the signed-in person (SessionFixtures.me), or nobody: a request with the header
     X-Session-Auth: out has no session. The mock has one person, so the /api/me/* collections are the
     caller's, and their place in a space comes from them, as the page reads it (relOf, isModOf, cxMyRole):
       relation  rel[space] for a closed space (none, pending, member, mod, denied), else member when joined
       role      owner, admin or moderator when the relation is mod, or when joined with an entry in roles
                 (roles names it; Admin when it has none); member when the relation is member; else none
     The rpc dispatcher (authorize) checks a procedure's `who` before it runs, in its transaction:
       guest      anyone
       user       a signed-in person, else UNAUTHORIZED (every check below needs one)
       member     in a closed space, one of its members; an open space takes writes from anyone signed in
       moderator, admin, owner   that role or a higher one in the procedure's space (def.space(tx, input))
       author     the record's author, who can also read its space (def.can checks it)
     def.can(tx, input) holds the rules that depend on the input (the record's author, the target member's
     role, the space's settings, a key that pays). It returns true or an error code (or an rpcError, for
     its own message). Refusals are FORBIDDEN unless can says otherwise. Checks run only in the dispatcher:
     a scenario's h.proc calls run directly and writes as the server.
     The REST router answers UNAUTHORIZED to a signed-out caller on a GET row that is not 'guest', and
     scopes every list to what the caller may read (readScope). */
  const RANK = { member: 1, mod: 2, moderator: 2, admin: 3, owner: 4 };   /* roster roles say mod */
  const ROLE_OF = { Owner: 'owner', Admin: 'admin', Moderator: 'moderator' };
  const closedSpace = s => !!s && (s.vis === 'listed' || s.vis === 'unlisted');
  const reqSpace = r => r.sp || C.mem.space;
  const banSpace = b => b.sp || C.mem.space;
  /* g(k): a collection (tx.get in a transaction, the database for a read) */
  const relIn = (g, sid) => g('rel')[sid] || (g('joined').includes(sid) ? 'member' : 'none');
  function roleIn(g, sid) {
    const r = relIn(g, sid), roles = g('roles');
    if (r !== 'member' && r !== 'mod') return null;
    return r === 'mod' || (g('joined').includes(sid) && roles[sid]) ? ROLE_OF[roles[sid]] || 'admin' : 'member';
  }
  const rankIn = (g, sid) => RANK[roleIn(g, sid)] || 0;
  /* may the caller read a space's threads, answers, replies, sources and pages */
  const readsSpace = (g, signedIn, s) => !closedSpace(s) || (signedIn && !!roleIn(g, s.id));
  const deny = message => rpcError('FORBIDDEN', message);
  const ROLE_PL = { member: 'members', moderator: 'moderators', admin: 'admins', owner: 'the owner' };
  /* the `who` of a role row, in a space */
  function permitIn(tx, sid, who) {
    const s = tx.need('spaces', sid, 'space');
    const ok = who === 'member' ? !closedSpace(s) || !!roleIn(tx.get, sid) : rankIn(tx.get, sid) >= RANK[who];
    return ok || deny(`Only ${ROLE_PL[who]}${who === 'moderator' || who === 'admin' ? ' (or a higher role)' : ''} of #${s.name} can do this.`);
  }
  function authorize(tx, P, input) {
    const who = P.who || 'user';
    if (who === 'guest') return;
    if (!tx.signedIn) throw rpcError('UNAUTHORIZED');
    const verdict = r => { if (r === true) return; throw r instanceof Error ? r : rpcError(CODES[r] ? r : 'INTERNAL_SERVER_ERROR'); };
    if (RANK[who]) verdict(permitIn(tx, P.space(tx, input), who));
    if (P.can) verdict(P.can(tx, input));
  }
  /* rules the procedures share (each returns true or an error) */
  const all = (...rs) => rs.find(r => r !== true) || true;
  const readsThread = (tx, p) => readsSpace(tx.get, tx.signedIn, tx.need('spaces', p.s, 'space')) || deny('Only members of this space can see this thread.');
  const authorIs = (tx, u, what) => u === tx.me.u || deny(`Only the person who wrote this ${what} can change it.`);
  /* TODO(limits): who pays is stored as sent; the one check is that a key that pays is the caller's */
  const ownPayer = (tx, pay) => pay == null || pay === 'session' || !!tx.find('userKeys', pay) || deny('This API key isn’t one of yours.');
  const threadSpace = (tx, i) => tx.need('posts', i.thread, 'thread').s;

  /* ---- reads: what GET returns to whom ----
     READ_RULES are the parts of the scoping; all are on. /api/dev/config { readRules } can switch one off (a
     dev override: a rule that is off returns those records to everyone, as before step 5). "Hidden" below: a
     closed space the caller is not a member of (signed out: every closed space).
       closedThreads   a hidden space's thread records (title, question, author, tokens) go only to the person
                       who wrote them: Usage keeps listing your own asks in a closed space you left. A link to
                       another person's thread there opens the "This thread is in a closed space" note, which
                       the page works out from the link (the space and the thread id), without the record.
       closedFollowUps the same rule for a hidden space's follow-ups and ask-tree nodes: the caller gets the ones
                       they wrote. Such a tree carries `space` (its thread's space), as the caller may not have
                       the thread record; a follow-up node's fu index points into the follow-ups they get.
       closedContent   the answers, sources cited, replies, moderation states, pages and source lists of a
                       closed space are for its members.
       closedSources   a source that only closed spaces you are not a member of have is left out, and those
                       spaces are left out of a source's list of spaces.
       closedMembers   a hidden space's member list holds its owner, admins and moderators (the landing's
                       Moderators list), not its members. The member count (a space's `members`) and a
                       person's count of spaces (/api/users) still include closed spaces.
       ownOrModerated  join requests, reports and source reports: your own, and those of the spaces you
                       moderate. Bans: the spaces you moderate. Invite links: those you created, and those
                       of the spaces you moderate.
       pendingSources  a source waiting for review: for the person who added it and the space's moderators.
     Space records are public (a closed space's landing shows its name, description, rules, member count
     and request questions). Revoked invite links are never returned. */
  const READ_RULES = { closedThreads: true, closedFollowUps: true, closedContent: true, closedSources: true, closedMembers: true, ownOrModerated: true, pendingSources: true };
  /* readScope(d, signedIn, rules, me): per kind, a record as the caller may read it, or null / undefined.
     readsThread(p) answers "may the caller read this thread record"; readsRun(r) "this run" (a run goes with the
     ask it answers: in a hidden space, to the person who asked). GET of threads, follow-ups, ask trees and runs
     uses them, procedure changes are scoped the same way, and the event stream (section 6a) sends a run's
     events only when readsRun holds. */
  function readScope(d, signedIn, rules, me) {
    const g = k => d[k], R = { ...READ_RULES, ...rules };
    const hidden = new Set(d.spaces.filter(s => !readsSpace(g, signedIn, s)).map(s => s.id));
    const mods = new Set(signedIn ? d.spaces.filter(s => rankIn(g, s.id) >= RANK.moderator).map(s => s.id) : []);
    const spaceOf = new Map(d.posts.map(p => [p.id, p.s]));
    const hideSp = sid => R.closedContent && hidden.has(sid);
    const hideTh = id => spaceOf.has(id) && hideSp(spaceOf.get(id));
    const own = u => signedIn && u === me.u;
    /* a thread whose follow-ups and ask tree are scoped to the caller's own asks */
    const ownAsksOnly = th => R.closedFollowUps && spaceOf.has(th) && hidden.has(spaceOf.get(th));
    const readsThread = p => !(R.closedThreads && p && hidden.has(p.s)) || own(p.u);
    const readsRun = r => !(spaceOf.has(r.th) && hidden.has(spaceOf.get(r.th)) && (r.node === 'r' ? R.closedThreads : R.closedFollowUps)) || own(r.u);
    /* follow-ups: the caller's own; keep: the old index → the new one, for the ask tree's fu */
    const ownFus = l => { const keep = new Map(), out = []; (l || []).forEach((f, k) => { if (f && own(f.u)) { keep.set(k, out.length); out.push(f); } }); return { out, keep }; };
    const fuScoped = (key, v) => { if (!ownAsksOnly(key)) return v; const { out } = ownFus(v); return out.length ? out : undefined; };
    const qtdScoped = (key, v) => {
      if (!ownAsksOnly(key)) return v;
      const { keep } = ownFus(d.fu && d.fu[key]);
      const nodes = (v.nodes || []).filter(n => n.fu != null ? keep.has(n.fu) : own(n.u)).map(n => n.fu != null ? { ...n, fu: keep.get(n.fu) } : n);
      return nodes.length ? { ...v, nodes, space: spaceOf.get(key) } : undefined;
    };
    /* a hidden space's member list: its owner, admins and moderators */
    const staff = l => (l || []).filter(m => m.role !== 'member');
    const scoped = (sid, u) => !R.ownOrModerated || own(u) || mods.has(sid);
    /* a pending source in a space's list, for someone other than the person who added it and its moderators */
    const pendingHidden = (sid, x) => R.pendingSources && x.rv && !own(x.by) && !mods.has(sid);
    /* a source: the spaces that have it (its sp, and the source lists it is in where the caller sees it) */
    const listed = new Map();
    for (const [sid, l] of Object.entries(d.dsDrops)) for (const x of l) if (!x.rm && !pendingHidden(sid, x)) (listed.get(x.m) || listed.set(x.m, new Set()).get(x.m)).add(sid);
    const src = x => {
      if (!R.closedSources) return x;
      const sps = new Set([...(x.sp || []), ...(listed.get(x.id) || [])]);
      if (sps.size && [...sps].every(s => hidden.has(s))) return null;
      return (x.sp || []).some(s => hidden.has(s)) ? { ...x, sp: x.sp.filter(s => !hidden.has(s)) } : x;
    };
    const LIST = {
      posts: x => readsThread(x) ? x : null, media: src, miAdded: src,
      reqs: x => scoped(reqSpace(x), x.u) ? x : null,
      reports: x => scoped(x.sp, x.by) ? x : null,
      banned: x => !R.ownOrModerated || mods.has(banSpace(x)) ? x : null,
      links: x => x.revokedAt ? null : scoped(x.sp, x.by) ? x : null,
    };
    const byThread = (key, v) => hideTh(key) ? undefined : v;
    const MAP = {
      rich: byThread, srcd: byThread, rp: byThread, fu: fuScoped, qtd: qtdScoped,
      runs: (key, v) => readsRun(v) ? v : undefined,
      modSt: (key, v) => hideTh(String(key).split(':')[1]) ? undefined : v,
      pagedocs: (key, v) => hideSp(key.split('/')[0]) ? undefined : v,
      memOther: (key, v) => R.closedMembers && hidden.has(key) ? staff(v) : v,
      dsDrops: (key, v) => {
        if (hideSp(key)) return undefined;
        return v.some(x => pendingHidden(key, x)) ? v.filter(x => !pendingHidden(key, x)) : v;
      },
    };
    const VALUE = {
      mem: v => R.closedMembers && hidden.has(C.mem.space) ? staff(v) : v,
      dsReps: v => R.ownOrModerated && v.some(x => !scoped(x.sid, x.by)) ? v.filter(x => scoped(x.sid, x.by)) : v,
    };
    return {
      readsThread, readsRun,
      list: (k, x) => LIST[k] ? LIST[k](x) : x,
      map: (k, key, v) => MAP[k] ? MAP[k](key, v) : v,
      value: (k, v) => VALUE[k] ? VALUE[k](v) : v,
    };
  }
  /* the collections whose GET depends on who reads them (besides /api/me/*): a change of membership, role
     or a space's visibility changes what they return */
  const SCOPED = ['posts', 'rich', 'srcd', 'fu', 'rp', 'qtd', 'runs', 'media', 'miAdded', 'reqs', 'reports', 'banned', 'links', 'modSt', 'pagedocs', 'memOther', 'dsDrops', 'mem', 'dsReps'];
  const SCOPE_INPUTS = ['joined', 'rel', 'roles', 'spaces'];

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
     proc(name, def): def.input (schema), def.output (a type name), def.who and def.space(tx, input) (the
     space whose role `who` names), def.can(tx, input) (section 5a), def.errors, def.wire, def.note,
     def.run(tx, input) → result. run throws rpcError(code) to fail; nothing it wrote is kept. tx
     (createBackend, transaction) reads and writes the collections:
       tx.me, tx.now, tx.id()          the signed-in person, the mock clock, a new ULID
       tx.signedIn                     false when the request has no session (X-Session-Auth: out)
       tx.get(k), tx.value(k)          a collection (read only), or a copy of a value collection
       tx.find(k, id), tx.need(k, id)  a list record, or a copy of it (need: NOT_FOUND when missing)
       tx.put(k, rec, 'start'?)        create or replace a list record; tx.edit(k, id, fn); tx.remove(k, id)
       tx.mapGet(k, key), tx.mapPut(k, key, v), tx.mapDel(k, key)
       tx.setValue(k, v) */
  /* data: { current, reads } for a CONFLICT (step 9): the error answer adds `current` (the version and content the
     server has) and `changes` (the records named in reads, as the caller reads them now) */
  const rpcError = (code, message, issues, data) => Object.assign(new Error(message || CODES[code][1]), { rpcCode: code, issues, data });
  const PROCS = {};
  const proc = (name, def) => { PROCS[name] = def; };
  const ID = str;   /* a record id */

  /* -- personal toggles: likes, saves, mutes, blocks, read sources -- */
  const flip = (tx, k, v, on) => { const s = tx.value(k); if (on) s.add(v); else s.delete(v); tx.setValue(k, s); return { on }; };
  const ON = { 'on?': bool };
  const want = (tx, k, v, on) => on === undefined ? !tx.get(k).has(v) : on;
  /* liking or saving needs a thread the caller can read; taking a like or a save back does not */
  const readsToSave = (tx, k, key, th, on) => !want(tx, k, key, on) || readsThread(tx, tx.need('posts', th, 'thread'));
  proc('likes.toggle', { input: obj({ thread: ID, ...ON }), output: '{ on: boolean }', who: 'user', errors: ['NOT_FOUND', 'FORBIDDEN'], writes: ['liked', 'posts'],
    note: 'like or unlike a thread; on: the wanted state (omitted: the opposite of the current one). Returns the thread with its new likes.',
    can: (tx, i) => readsToSave(tx, 'liked', i.thread, i.thread, i.on),
    run: (tx, i) => { tx.need('posts', i.thread, 'thread'); return flip(tx, 'liked', i.thread, want(tx, 'liked', i.thread, i.on)); } });
  proc('likes.toggleReply', { input: obj({ reply: str, ...ON }), output: '{ on: boolean }', who: 'user', errors: ['NOT_FOUND', 'FORBIDDEN'], writes: ['rpLiked'],
    note: 'reply: "<thread>:<path>", the path of a reply in the thread’s replies (indexes joined with ".")',
    can: (tx, i) => readsToSave(tx, 'rpLiked', i.reply, i.reply.split(':')[0], i.on),
    run: (tx, i) => {
      const [th, path] = i.reply.split(':');
      tx.need('posts', th, 'thread');
      if (!/^\d+(\.\d+)*$/.test(path || '')) throw rpcError('BAD_REQUEST', undefined, ['input.reply: expected "<thread>:<path>"']);
      return flip(tx, 'rpLiked', i.reply, want(tx, 'rpLiked', i.reply, i.on));
    } });
  const SAVE_KIND = { thread: 'saved', ask: 'qtSaved', source: 'miSaved' };
  proc('saved.toggle', { input: obj({ kind: one('thread', 'ask', 'source'), id: str, ...ON }), output: '{ on: boolean }', who: 'user', errors: ['NOT_FOUND', 'FORBIDDEN'], writes: ['saved', 'qtSaved', 'miSaved'],
    note: 'save or unsave a thread (id: its id), an ask (id: "<thread>:<node>") or a source (id: its id)',
    can: (tx, i) => i.kind === 'source' || readsToSave(tx, SAVE_KIND[i.kind], i.id, i.id.split(':')[0], i.on),
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
  proc('threads.create', { input: obj(THREAD_IN, 'CreateThreadInput'), output: '{ id: ThreadId }', who: 'member', errors: ['NOT_FOUND', 'PRECONDITION_FAILED'], wire: 'ResearchTree', writes: ['posts', 'rich', 'fu', 'qtd', 'runs', 'usage'],
    note: 'an ask or a post; the server assigns the id (a ULID). An ask starts a run (a server job, section 6a). The first ask a key pays for after the included tokens run out marks the usage note about it seen (TODO(limits) stub). from: start the thread from a branch of another thread’s ask tree (branch: "all" copies the asks below it); the source node links to the new thread. A branch of a closed space’s thread stays in that space. topic: kept only in a space with the FAQ landing that has the topic. pay: TODO(limits), stored as sent; a key that pays must be yours.',
    space: (tx, i) => i.space,
    can: (tx, i) => {
      if (!i.from) return ownPayer(tx, i.pay);
      const src = tx.need('posts', i.from.th, 'thread'), r = readsThread(tx, src);
      if (r !== true) return r;
      return !closedSpace(tx.find('spaces', src.s)) || src.s === i.space || deny('A branch of a thread in a closed space can only become a thread in the same space.');
    },
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
      if (i.kind === 'ask') rec.att = 1;
      tx.put('posts', rec);
      if (i.kind === 'ask') {
        startRun(tx, id, 'r', rec);
        if (i.pay && tx.find('userKeys', i.pay) && !tx.get('usage').movedSeen) tx.setValue('usage', { ...tx.value('usage'), movedSeen: true });
      }
      return { id };
    } });
  /* the author of a thread, who can still read its space */
  const ownThread = (tx, id) => { const p = tx.need('posts', id, 'thread'); return all(readsThread(tx, p), authorIs(tx, p.u, p.k === 'ask' ? 'ask' : 'post')); };
  proc('threads.update', { input: obj({ id: ID, q: str, 'run?': bool, 'pay?': nul(str), 'model?': str }, 'UpdateThreadInput'), output: 'null', who: 'author', errors: ['NOT_FOUND'], wire: 'ResearchTree', writes: ['posts', 'runs'],
    note: 'the author edits the question; run: the ask runs again (a new run) with payer pay (TODO(limits): stored as sent; a key must be yours)',
    can: (tx, i) => all(ownThread(tx, i.id), ownPayer(tx, i.pay)),
    run: (tx, i) => {
      const q = text(i.q, 'q');
      tx.edit('posts', i.id, x => {
        if (x.del || x.gone) throw rpcError('PRECONDITION_FAILED', 'This thread was deleted.');
        const changed = x.q !== q; x.q = q; x.kw = q;
        if (changed) { x.edited = true; x.t = null; }
        if (i.run) { x.running = true; x.sum = null; x.tok = 0; x.pay = i.pay == null ? null : i.pay; if (i.model) x.model = i.model; x.att = (x.att || 0) + 1; delete x.fail; }
      }, 'thread');
      if (i.run) startRun(tx, i.id, 'r', tx.find('posts', i.id));
    } });
  proc('threads.delete', { input: obj({ id: ID }), output: '{ kept: boolean }', who: 'author', errors: ['NOT_FOUND'], writes: ['posts', 'saved', 'liked', 'runs'],
    note: 'the author deletes a thread: one with follow-ups or replies keeps its place ("You deleted this ask"), one without is gone; it leaves Saved and likes. A run of its ask in progress ends without writing. Moderators hide or remove items with moderation.decide.',
    can: (tx, i) => ownThread(tx, i.id),
    run: (tx, i) => {
      const p = tx.need('posts', i.id, 'thread');
      const kids = p.k === 'ask' ? askTree(tx, p.id).nodes.length : (tx.mapGet('rp', p.id) || []).length, keep = kids > 0;
      tx.edit('posts', p.id, x => {
        x.del = true; x.q = ''; x.kw = ''; x.t = null; delete x.edited; if (x.running) x.running = false;
        if (!keep) { x.gone = true; x.sum = null; x.running = false; }
      });
      tx.mapDel('runs', `${p.id}:r`);
      if (!keep) for (const k of ['saved', 'liked']) if (tx.get(k).has(p.id)) { const s = tx.value(k); s.delete(p.id); tx.setValue(k, s); }
      return { kept: keep };
    } });
  proc('threads.move', { input: obj({ id: ID, topic: nul(str) }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['posts'],
    note: 'a moderator moves a thread to a topic of its space (null: Other)',
    space: (tx, i) => tx.need('posts', i.id, 'thread').s,
    run: (tx, i) => {
      const p = tx.need('posts', i.id, 'thread'), s = tx.need('spaces', p.s, 'space');
      if (i.topic != null && !(s.topics || []).some(x => x[0] === i.topic)) throw rpcError('NOT_FOUND', 'The space has no topic like this.');
      tx.edit('posts', p.id, x => { x.topic = i.topic; x.topicBy = 'mod'; });
    } });
  proc('followups.ask', { input: obj({ thread: ID, q: str }), output: 'null', who: 'member', errors: ['NOT_FOUND', 'PRECONDITION_FAILED'], wire: 'ResearchExchangeNode', writes: ['fu', 'posts', 'runs'],
    note: 'a follow-up ask on an ask thread (without ask trees: the flat list); its run answers the ask f<index> of the thread’s tree', space: threadSpace,
    run: (tx, i) => {
      const p = tx.need('posts', i.thread, 'thread'); writable(tx, p.s);
      if (p.k !== 'ask') throw bad1('thread', 'an ask thread');
      const l = tx.mapGet('fu', p.id) || [];
      tx.mapPut('fu', p.id, [...l, { u: tx.me.u, q: text(i.q, 'q'), a: 'Researching…' }]);
      startRun(tx, p.id, 'f' + l.length, { u: tx.me.u });
    } });
  proc('research.createPostFollowUp', { input: obj({ thread: ID, t: str, 'parent?': int }), output: 'null', who: 'member', errors: ['NOT_FOUND', 'PRECONDITION_FAILED'], wire: 'ResearchPostNode', writes: ['rp', 'posts'],
    note: 'a reply to a post; parent: the index of the reply it answers (replies have one level of nesting)', space: threadSpace,
    run: (tx, i) => {
      const p = tx.need('posts', i.thread, 'thread'); writable(tx, p.s);
      const l = tx.mapGet('rp', p.id) || [], r = { u: tx.me.u, t: text(i.t, 't') };
      if (i.parent == null) l.push(r);
      else { const top = l[i.parent]; if (!top) throw rpcError('NOT_FOUND', 'The server has no record of this reply. Someone may have deleted it.'); top.kids = [...(top.kids || []), r]; }
      tx.mapPut('rp', p.id, l);
    } });
  proc('research.forkNode', { input: obj({ thread: ID, parent: str, q: str, 'uses?': nul(arr(str)), 'pay?': nul(str), 'model?': str }, 'ForkNodeInput'), output: '{ id: NodeId }', who: 'member', errors: ['NOT_FOUND', 'PRECONDITION_FAILED'], wire: 'ResearchNode', writes: ['qtd', 'posts', 'runs'],
    note: 'an ask about an answer in a thread’s ask tree (parent: "r" for the thread’s ask, or a node id); the server assigns the node id. It starts a run (a server job). pay: TODO(limits), stored as sent; a key that pays must be yours.',
    space: threadSpace, can: (tx, i) => ownPayer(tx, i.pay),
    run: (tx, i) => {
      const p = tx.need('posts', i.thread, 'thread'); writable(tx, p.s);
      const tree = askTree(tx, p.id);
      if (i.parent !== 'r') nodeOf(tree.nodes, i.parent);
      const n = { id: tx.id(), par: i.parent, u: tx.me.u, q: text(i.q, 'q'), tok: 0, running: true, uses: i.uses || null, pay: i.pay == null ? null : i.pay, att: 1 };
      if (i.model) n.model = i.model;
      tx.mapPut('qtd', p.id, { ...tree, nodes: [...tree.nodes, n] });
      startRun(tx, p.id, n.id, n);
      return { id: n.id };
    } });
  /* the author of a reply or a follow-up ask (a missing one is run's NOT_FOUND) */
  const ownReply = (tx, i) => {
    const p = tx.need('posts', i.thread, 'thread'), r = /^\d+(\.\d+)*$/.test(i.path) ? replyAt(tx.mapGet('rp', p.id) || [], pathOf(i.path)) : null;
    return all(readsThread(tx, p), r ? authorIs(tx, r.u, 'reply') : true);
  };
  const ownNode = (tx, i) => {
    const p = tx.need('posts', i.thread, 'thread'), n = askNodes(tx, p.id).find(x => x.id === i.node);
    return all(readsThread(tx, p), n ? authorIs(tx, n.u, 'follow-up') : true);
  };
  proc('replies.update', { input: obj({ thread: ID, path: str, t: str }), output: 'null', who: 'author', errors: ['NOT_FOUND'], writes: ['rp'],
    note: 'the author edits a reply (path: indexes in the thread’s replies, joined with ".")', can: (tx, i) => ownReply(tx, i),
    run: (tx, i) => {
      const p = tx.need('posts', i.thread, 'thread'), l = tx.mapGet('rp', p.id) || [], r = replyAt(l, pathOf(i.path));
      if (!r) throw rpcError('NOT_FOUND', 'The server has no record of this reply. Someone may have deleted it.');
      const t2 = text(i.t, 't'); if (r.t !== t2) r.edited = true; r.t = t2;
      tx.mapPut('rp', p.id, l);
    } });
  proc('replies.delete', { input: obj({ thread: ID, path: str }), output: '{ kept: boolean }', who: 'author', errors: ['NOT_FOUND'], wire: 'ResearchBranchRemoval', writes: ['rp', 'posts'],
    note: 'the author deletes a reply: one with replies keeps its place ("You deleted this reply"), one without is removed', can: (tx, i) => ownReply(tx, i),
    run: (tx, i) => {
      const p = tx.need('posts', i.thread, 'thread'), l = tx.mapGet('rp', p.id) || [], path = pathOf(i.path), r = replyAt(l, path);
      if (!r) throw rpcError('NOT_FOUND', 'The server has no record of this reply. Someone may have deleted it.');
      const keep = (r.kids || []).length > 0;
      if (keep) { r.del = true; r.t = ''; delete r.edited; }
      else { const par = path.length > 1 ? replyAt(l, path.slice(0, -1)).kids : l; par.splice(path[path.length - 1], 1); }
      tx.mapPut('rp', p.id, l);
      return { kept: keep };
    } });
  proc('followups.update', { input: obj({ thread: ID, node: str, q: str, 'run?': bool, 'pay?': nul(str) }), output: 'null', who: 'author', errors: ['NOT_FOUND'], wire: 'ResearchNode', writes: ['qtd', 'fu', 'posts', 'runs'],
    note: 'the author edits a follow-up ask; run: it runs again (a new run) with payer pay (TODO(limits): stored as sent; a key must be yours)', can: (tx, i) => all(ownNode(tx, i), ownPayer(tx, i.pay)),
    run: (tx, i) => {
      const p = tx.need('posts', i.thread, 'thread'), q = text(i.q, 'q'), n = nodeOf(askNodes(tx, p.id), i.node), changed = n.q !== q;
      if (n.fu != null) { const fu = tx.mapGet('fu', p.id) || []; if (fu[n.fu]) { fu[n.fu].q = q; tx.mapPut('fu', p.id, fu); } }
      const tree = askTree(tx, p.id);
      let ran = null;
      tx.mapPut('qtd', p.id, { ...tree, nodes: tree.nodes.map(x => { if (x.id !== n.id) return x; const y = { ...x }; if (y.fu == null) y.q = q; if (changed) y.edited = true; if (i.run) { y.running = true; y.tok = 0; y.pay = i.pay == null ? null : i.pay; y.att = (y.att || 0) + 1; delete y.fail; ran = y; } return y; }) });
      if (ran) startRun(tx, p.id, n.id, { ...ran, u: n.u });
    } });

  /* -- runs (step 7): an ask's run is a server job (section 6a); these start and stop runs -- */
  const runKey = (th, node) => `${th}:${node}`;
  /* the run record of a node's ask; the job takes it from queued to running and through its steps */
  function startRun(tx, th, node, x) {
    tx.mapPut('runs', runKey(th, node), { th, node, u: x.u || tx.me.u, status: 'queued', attempt: x.att || 1, seq: 0, step: 0, model: x.model || null, pay: x.pay == null ? null : x.pay, createdAt: tx.now });
  }
  /* TODO(limits): the server's charge, a stub: tokens to a source (the included tokens or a key), in the
     space they were used in, and the key's last use. The page's former tmCharge, moved. */
  function charge(tx, pay, tok, sid) {
    if (!pay || !tok) return;
    const u = tx.value('usage'), by = u.by[pay] || (u.by[pay] = {});
    by[sid] = (by[sid] || 0) + tok; tx.setValue('usage', u);
    if (tx.find('userKeys', pay)) tx.edit('userKeys', pay, k => { k.lastUsedAt = tx.now; });
  }
  /* change one ask of a thread's tree (fn) and the flat follow-up it stands for (fuFn); f<index> names a flat
     follow-up that the stored tree does not list */
  function editAsk(tx, th, id, fn, fuFn) {
    const tree = askTree(tx, th), n = tree.nodes.find(x => x.id === id);
    if (n) tx.mapPut('qtd', th, { ...tree, nodes: tree.nodes.map(x => { if (x.id !== id) return x; const y = { ...x }; fn(y); return y; }) });
    const k = n ? n.fu : /^f\d+$/.test(id) ? +id.slice(1) : null, fu = k != null && fuFn ? tx.mapGet('fu', th) : null;
    if (fu && fu[k]) { fuFn(fu[k]); tx.mapPut('fu', th, fu); }
  }
  /* the ask a run answers in a thread's tree (with the text of the follow-up it stands for), or null when it is gone */
  const askOf = (tx, th, id) => {
    const n = askNodes(tx, th).find(x => x.id === id); if (n) return n;
    const f = /^f\d+$/.test(id) ? (tx.mapGet('fu', th) || [])[+id.slice(1)] : null;
    return f ? { id, par: 'r', fu: +id.slice(1), ...f } : null;
  };
  /* the events of a run that ended (complete, failed, cancelled): to everyone who may read it (section 6a).
     node.updated carries the records the run wrote (changes, a mock addition: the real client fetches the
     node's snapshot once it has the terminal node.updated). */
  const runEnded = (tx, r, status, error) => {
    const nodeId = runKey(r.th, r.node), e = error ? { error } : {};
    tx.emit({ type: 'research.run.finished', run: r, payload: { nodeId, attempt: r.attempt, seq: r.seq + 1, status, ...e } });
    tx.emit({ type: 'research.node.updated', run: r, changes: true, payload: { node: { id: nodeId, treeId: r.th, status, ...e } } });
  };
  /* the author of the ask a run answers */
  const ownAsk = (tx, i) => i.node === 'r' ? ownThread(tx, i.thread) : ownNode(tx, i);
  const NODE_IN = { thread: ID, node: str };
  proc('research.cancelNode', { input: obj(NODE_IN), output: 'null', who: 'author', errors: ['NOT_FOUND', 'PRECONDITION_FAILED'], wire: 'ResearchNode', writes: ['posts', 'qtd', 'fu', 'runs', 'usage', 'userKeys'],
    note: 'Stop: the author stops the run of an ask (node "r": the thread’s ask; else an ask in its tree). The run ends as cancelled: the answer is stopped and is charged what the run used so far (TODO(limits) stub: the tokens of its progress step, at most what the payer has left). PRECONDITION_FAILED when it is not running.',
    can: (tx, i) => ownAsk(tx, i),
    run: (tx, i) => {
      const J = window.SessionJobs, p = tx.need('posts', i.thread, 'thread'), key = runKey(p.id, i.node), r = tx.mapGet('runs', key);
      const n = i.node === 'r' ? null : askOf(tx, p.id, i.node);
      if (i.node !== 'r' && !n) throw rpcError('NOT_FOUND', 'The server has no record of this follow-up. Someone may have deleted it.');
      if (!(i.node === 'r' ? p.running : n.running || r)) throw rpcError('PRECONDITION_FAILED', 'This answer isn’t running.');
      const pay = i.node === 'r' ? p.pay : n.pay, s = J.src(tx.get, pay), used = s ? Math.min(s.left, J.STEP_TOK[r ? r.step : 2]) : 0;
      charge(tx, pay, used, p.s);
      if (i.node === 'r') {
        if (!tx.mapGet('fu', p.id)) tx.mapPut('fu', p.id, []);
        tx.edit('posts', p.id, x => { x.running = false; x.tok = used; x.pay = pay || null; x.sum = J.FAIL_SUM.stopped(); x.fail = { why: 'stopped' }; });
      } else editAsk(tx, p.id, i.node, y => { y.running = false; y.tok = used; y.html = ''; y.fail = { why: 'stopped' }; }, f => { f.a = J.FAIL_SUM.stopped(); delete f.html; });
      tx.mapDel('runs', key);
      if (r) runEnded(tx, r, 'cancelled');
    } });
  proc('research.retryNode', { input: obj({ ...NODE_IN, 'pay?': nul(str), 'model?': str }), output: 'null', who: 'author', errors: ['NOT_FOUND', 'PRECONDITION_FAILED'], wire: 'ResearchTreeDetail', writes: ['posts', 'qtd', 'fu', 'runs'],
    note: 'Run again or Retry: the author runs an ask that stopped or failed again, as a new run (attempt). pay and model: the payer and model the page picked (TODO(limits): stored as sent; a key must be yours). PRECONDITION_FAILED while it runs.',
    can: (tx, i) => all(ownAsk(tx, i), ownPayer(tx, i.pay)),
    run: (tx, i) => {
      const p = tx.need('posts', i.thread, 'thread'); writable(tx, p.s);
      const pay = i.pay == null ? null : i.pay;
      if (p.k !== 'ask') throw bad1('thread', 'an ask thread');
      if (i.node === 'r') {
        if (p.running) throw rpcError('PRECONDITION_FAILED', 'This answer is running.');
        const x = tx.edit('posts', p.id, y => { y.running = true; y.sum = null; y.tok = 0; y.pay = pay; if (i.model) y.model = i.model; y.att = (y.att || 0) + 1; delete y.fail; });
        startRun(tx, p.id, 'r', x);
        return;
      }
      const n = askOf(tx, p.id, i.node);
      if (!n) throw rpcError('NOT_FOUND', 'The server has no record of this follow-up. Someone may have deleted it.');
      if (n.running || tx.mapGet('runs', runKey(p.id, i.node))) throw rpcError('PRECONDITION_FAILED', 'This answer is running.');
      let ran = null;
      editAsk(tx, p.id, i.node, y => { y.running = true; y.pay = pay; y.tok = 0; if (i.model) y.model = i.model; y.att = (y.att || 0) + 1; delete y.fail; ran = y; }, f => { f.a = 'Researching…'; delete f.html; });
      startRun(tx, p.id, i.node, { ...(ran || {}), u: n.u, pay });
    } });

  /* -- token usage: the stub's user procedures (TODO(limits)) -- */
  proc('usage.setDefaultKey', { input: obj({ id: nul(ID) }), output: 'null', who: 'user', errors: ['NOT_FOUND', 'PRECONDITION_FAILED'], stub: true, writes: ['usage'],
    note: 'TODO(limits) stub: the key that pays for asks after the included tokens run out (null: none); it must be one of your valid keys',
    run: (tx, i) => {
      if (i.id != null) { const k = tx.need('userKeys', i.id, 'key'); if (!k.valid) throw rpcError('PRECONDITION_FAILED', 'The provider rejected this key.'); }
      tx.setValue('usage', { ...tx.value('usage'), def: i.id });
    } });
  proc('usage.markMovedSeen', { input: obj({}), output: 'null', who: 'user', stub: true, writes: ['usage'],
    note: 'TODO(limits) stub: you dismissed the note that asks now use your API key',
    run: tx => { tx.setValue('usage', { ...tx.value('usage'), movedSeen: true }); } });
  proc('followups.delete', { input: obj({ thread: ID, node: str }), output: '{ kept: boolean }', who: 'author', errors: ['NOT_FOUND'], wire: 'ResearchBranchRemoval', writes: ['qtd', 'fu', 'posts', 'runs'],
    note: 'the author deletes a follow-up ask and its answer: one with asks below it keeps its place, one without is removed', can: (tx, i) => ownNode(tx, i),
    run: (tx, i) => {
      const p = tx.need('posts', i.thread, 'thread'), n = nodeOf(askNodes(tx, p.id), i.node), tree = askTree(tx, p.id);
      const keep = tree.nodes.some(x => x.par === n.id);
      if (n.fu != null) { const fu = tx.mapGet('fu', p.id) || []; if (fu[n.fu]) { Object.assign(fu[n.fu], { del: true, q: '', a: '' }); delete fu[n.fu].html; tx.mapPut('fu', p.id, fu); } }
      tx.mapPut('qtd', p.id, { ...tree, nodes: keep ? tree.nodes.map(x => { if (x.id !== n.id) return x; const y = { ...x, del: true, q: '', html: '' }; delete y.edited; return y; }) : tree.nodes.filter(x => x.id !== n.id) });
      tx.mapDel('runs', `${p.id}:${n.id}`);
      return { kept: keep };
    } });

  /* -- memberships, join requests and roles -- */
  const rosterOf = (tx, sid) => (sid === C.mem.space ? tx.value('mem') : tx.mapGet('memOther', sid)) || [];
  const setRoster = (tx, sid, list) => { if (sid === C.mem.space) tx.setValue('mem', list); else tx.mapPut('memOther', sid, list); };
  const setJoined = (tx, sid, on) => { const j = tx.value('joined'); if (on && !j.includes(sid)) tx.setValue('joined', [...j, sid]); if (!on && j.includes(sid)) tx.setValue('joined', j.filter(x => x !== sid)); };
  /* your relation to a closed space (none, pending, member, mod, denied), with what follows from it: the
     joined list, your place among the space's moderators, and your role */
  /* a granted role (roles0) as the space's moderators list names it: its roster role */
  const MODS_ROLE = { Owner: 'owner', Admin: 'admin', Moderator: 'mod' };
  function setRelation(tx, sid, r) {
    tx.mapPut('rel', sid, r);
    setJoined(tx, sid, r === 'member' || r === 'mod');
    const g0 = tx.get('roles0')[sid];
    tx.edit('spaces', sid, s => { s.mods = (s.mods || []).filter(m => m[0] !== tx.me.u); if (r === 'mod') s.mods.push([tx.me.u, g0 ? MODS_ROLE[g0] || 'admin' : 'admin']); });
    const roles = tx.value('roles');
    if (r === 'mod') { if (!roles[sid]) tx.setValue('roles', { ...roles, [sid]: 'Admin' }); }
    else if (roles[sid] && !g0) { delete roles[sid]; tx.setValue('roles', roles); }
  }
  const markNote = (tx, id, fn) => { if (id != null) tx.edit('notifs', id, n => { n.read = true; fn(n); }, 'notification'); };
  const bannedFrom = (tx, sid) => tx.get('banned').some(b => b.u === tx.me.u && banSpace(b) === sid);
  /* a live invite link: not used, revoked or expired */
  const liveLink = (tx, l) => !!l && !l.dead && !l.revokedAt && (!l.expiresAt || Date.parse(l.expiresAt) > Date.parse(tx.now));
  /* what lets the caller into a closed space: an invite notification to it that they haven't declined, a
     live invite link to it (invite: its code), or a request to it that a moderator approved */
  function admitted(tx, s, i) {
    if (i.invite != null) { const l = tx.get('links').find(x => x.code === i.invite); return l && l.sp === s.id && liveLink(tx, l) ? true : deny('This invite link has expired or was already used.'); }
    if (tx.get('notifs').some(n => n.type === 'invite' && n.space === s.id && n.response !== 'declined')) return true;
    if (tx.get('reqs').some(r => r.u === tx.me.u && reqSpace(r) === s.id && r.st === 'approved')) return true;
    return deny(`#${s.name} is closed: joining it needs an invite or a request a moderator approved.`);
  }
  proc('spaces.join', { input: obj({ space: ID, 'notification?': ID, 'invite?': str }), output: 'null', who: 'user', errors: ['NOT_FOUND', 'FORBIDDEN'], writes: ['joined', 'rel', 'spaces', 'roles', 'notifs', 'links'],
    note: 'join an open space, or a closed one you were invited to (notification: the invite, marked accepted; invite: an invite link’s code, which it uses up) or whose moderators approved your request. A person banned from a closed space can’t join it.',
    can: (tx, i) => {
      const s = tx.need('spaces', i.space, 'space');
      if (i.notification != null) { const n = tx.need('notifs', i.notification, 'notification'); if (n.type !== 'invite' || n.space !== s.id) return deny('This notification isn’t an invite to this space.'); }
      if (!closedSpace(s) || roleIn(tx.get, s.id)) return true;
      if (bannedFrom(tx, s.id)) return deny(`You are banned from #${s.name}.`);
      return admitted(tx, s, i);
    },
    run: (tx, i) => {
      const s = tx.need('spaces', i.space, 'space');
      if (s.deleted) throw rpcError('NOT_FOUND');
      markNote(tx, i.notification, n => { n.response = 'accepted'; });
      if (i.invite != null && closedSpace(s)) { const l = tx.get('links').find(x => x.code === i.invite); tx.edit('links', l.id, x => { x.dead = 'Used'; x.usedBy = tx.me.u; }); }
      if (closedSpace(s) || i.notification != null) setRelation(tx, s.id, 'member'); else setJoined(tx, s.id, true);
    } });
  /* the only owner of a space can't leave it: they transfer ownership first */
  const soleOwner = (tx, sid) => roleIn(tx.get, sid) === 'owner' && !rosterOf(tx, sid).some(m => m.role === 'owner' && m.u !== tx.me.u);
  proc('spaces.leave', { input: obj({ space: ID }), output: 'null', who: 'member', errors: ['NOT_FOUND', 'PRECONDITION_FAILED'], writes: ['joined', 'rel', 'spaces', 'roles'],
    note: 'leave a space; the only owner of a space transfers ownership first',
    space: (tx, i) => i.space, can: (tx, i) => !soleOwner(tx, i.space) || rpcError('PRECONDITION_FAILED', 'You are the only owner of this space. Transfer ownership before you leave.'),
    run: (tx, i) => { const s = tx.need('spaces', i.space, 'space'); if (closedSpace(s)) setRelation(tx, s.id, 'none'); setJoined(tx, s.id, false); } });
  proc('onboarding.finish', { input: obj({ spaces: arr(ID) }), output: 'null', who: 'user', errors: ['NOT_FOUND', 'FORBIDDEN'], writes: ['joined'],
    note: 'a new account’s first spaces (the open spaces picked on the welcome page)',
    can: (tx, i) => i.spaces.map(id => tx.need('spaces', id, 'space')).every(s => !closedSpace(s)) || deny('The welcome page joins open spaces only.'),
    run: (tx, i) => { i.spaces.forEach(id => tx.need('spaces', id, 'space')); tx.setValue('joined', [...new Set(i.spaces)]); } });
  proc('invites.decline', { input: obj({ notification: ID }), output: 'null', who: 'user', errors: ['NOT_FOUND'], writes: ['notifs'],
    note: 'decline an invite to a closed space (one of your notifications); the person who invited you is not notified', run: (tx, i) => markNote(tx, i.notification, n => { n.response = 'declined'; }) });
  proc('invites.request', { input: obj({ space: ID }), output: 'null', who: 'user', errors: ['NOT_FOUND'], writes: ['askedInv'],
    note: 'ask the members of an invite-only space for an invite',
    run: (tx, i) => { tx.need('spaces', i.space, 'space'); const l = tx.value('askedInv'); if (!l.includes(i.space)) tx.setValue('askedInv', [...l, i.space]); } });
  proc('joinRequests.create', { input: obj({ space: ID, 'answers?': arr(str), 'rulesAccepted?': bool }), output: 'null', who: 'user', errors: ['NOT_FOUND', 'PRECONDITION_FAILED', 'FORBIDDEN'], writes: ['rel', 'reqs', 'joined', 'spaces', 'roles'],
    note: 'request to join a closed space; the request joins the space’s review queue. answers: one per question of the space (qs), required where the question is; rulesAccepted: true, when the space has rules (BAD_REQUEST otherwise). A person banned from the space can’t request to join.',
    can: (tx, i) => { const s = tx.need('spaces', i.space, 'space'); return !bannedFrom(tx, s.id) || deny(`You are banned from #${s.name}.`); },
    run: (tx, i) => {
      const s = tx.need('spaces', i.space, 'space');
      if (!closedSpace(s)) throw rpcError('PRECONDITION_FAILED', 'This space is open: join it instead.');
      if (s.policy === 'invite') throw rpcError('PRECONDITION_FAILED', 'This space is invite only: ask for an invite instead.');
      const a = i.answers || [], issues = (s.qs || []).map((q, k) => q.req && !String(a[k] || '').trim() ? `input.answers[${k}]: expected an answer to “${q.q}” (required)` : null).filter(Boolean);
      if ((s.rules || []).length && i.rulesAccepted !== true) issues.push('input.rulesAccepted: expected true (the space’s rules accepted)');
      if (issues.length) throw rpcError('BAD_REQUEST', undefined, issues);
      setRelation(tx, s.id, 'pending');
      tx.put('reqs', { u: tx.me.u, sp: s.id, st: 'open', a, userCreatedAt: tx.me.createdAt });
    } });
  proc('joinRequests.withdraw', { input: obj({ space: ID }), output: 'null', who: 'user', errors: ['NOT_FOUND'], writes: ['rel', 'reqs', 'joined', 'spaces', 'roles'],
    note: 'withdraw your own request to join a space',
    run: (tx, i) => {
      tx.need('spaces', i.space, 'space'); setRelation(tx, i.space, 'none');
      const r = tx.find('reqs', tx.me.u); if (r && reqSpace(r) === i.space) tx.remove('reqs', tx.me.u);
    } });
  const spaceIn = (tx, i) => i.space;
  proc('joinRequests.decide', { input: obj({ space: ID, users: arr(str), decision: one('approve', 'decline', 'reopen'), 'why?': str }, 'DecideRequestsInput'), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['reqs', 'mem', 'memOther', 'spaces'],
    note: 'approve (the applicants become members), decline (why: the note they see) or reopen a declined request (Undo)',
    space: spaceIn,
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
  /* the page's cxCanAct: you act on members ranked below you; owners and admins also act on admins;
     nobody acts on the owner or, here, on themselves. Someone not in the list counts as a member. */
  function actsOn(tx, sid, u) {
    const m = rosterOf(tx, sid).find(x => x.u === u) || { u, role: 'member' }, mine = rankIn(tx.get, sid);
    if (u === tx.me.u) return deny('You can’t change your own membership here.');
    if (m.role === 'owner') return deny('Nobody can change the owner’s membership. The owner can transfer ownership.');
    return (m.role === 'admin' ? mine >= RANK.admin : mine > (RANK[m.role] || RANK.member)) || deny(`You can only act on members whose role is below yours (${u} is ${m.role === 'mod' ? 'a moderator' : m.role === 'admin' ? 'an admin' : 'a member'}).`);
  }
  const MEMBER_ROLE = one('member', 'mod', 'admin', 'owner');
  proc('members.setRole', { input: obj({ space: ID, user: str, role: MEMBER_ROLE }), output: 'null', who: 'admin', errors: ['NOT_FOUND'], wire: 'ThreadMember', writes: ['mem', 'memOther', 'spaces', 'roles', 'roles0'],
    note: 'change a member’s role, to one no higher than yours; role "owner" transfers ownership (the owner only): you become an admin',
    space: spaceIn,
    can: (tx, i) => {
      if (i.role === 'owner' && roleIn(tx.get, i.space) !== 'owner') return deny('Only the owner can transfer ownership.');
      return all(actsOn(tx, i.space, i.user), i.role === 'owner' || RANK[i.role] <= rankIn(tx.get, i.space) || deny('You can’t give a role higher than your own.'));
    },
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
    note: 'remove a member ranked below you (see members.setRole)', space: spaceIn, can: (tx, i) => actsOn(tx, i.space, i.user),
    run: (tx, i) => { tx.need('spaces', i.space, 'space'); removeMember(tx, i.space, i.user); } });
  proc('members.ban', { input: obj({ space: ID, user: str }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['mem', 'memOther', 'spaces', 'banned'],
    note: 'remove a member ranked below you (if they are one) and ban them: they can’t request to join or use invite links',
    space: spaceIn, can: (tx, i) => actsOn(tx, i.space, i.user),
    run: (tx, i) => {
      tx.need('spaces', i.space, 'space'); removeMember(tx, i.space, i.user);
      if (!tx.get('banned').some(b => b.u === i.user && banSpace(b) === i.space)) tx.put('banned', { id: `${i.space}:${i.user}`, sp: i.space, u: i.user }, 'start');
    } });
  proc('members.unban', { input: obj({ space: ID, user: str }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['banned'],
    space: spaceIn,
    run: (tx, i) => {
      const l = tx.get('banned').filter(b => b.u === i.user && banSpace(b) === i.space);
      if (!l.length) throw rpcError('NOT_FOUND', 'This person is not banned from the space.');
      l.forEach(b => tx.remove('banned', b.id));
    } });

  /* -- reports and moderation -- */
  const itemSpace = (tx, key) => { const th = String(key).split(':')[1], p = th && tx.find('posts', th); if (!p) throw rpcError('NOT_FOUND', 'The server has no record of this item. Someone may have deleted it.'); return p.s; };
  const reportNote = n => n.type === 'report_resolved';
  const itemIn = (tx, i) => itemSpace(tx, i.item);
  proc('reports.create', { input: obj({ item: str, why: str, 'note?': str }), output: '{ id: ReportId }', who: 'member', errors: ['NOT_FOUND'], writes: ['reports'],
    note: 'report an item (item: "<kind>:<thread>[:…]") to the space’s moderators; they get a notification',
    space: itemIn,
    run: (tx, i) => {
      const id = tx.id();
      tx.put('reports', { id, sp: itemSpace(tx, i.item), key: i.item, why: i.why, note: (i.note || '').trim(), by: tx.me.u, st: 'open' }, 'start');
      tx.setValue('repSeen', false);
      return { id };
    } });
  proc('reports.resolve', { input: obj({ report: ID, outcome: one('dismissed', 'hidden', 'removed', 'open') }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['reports', 'modSt', 'notifs'],
    note: 'dismiss a report, or hide or remove the item (which resolves every open report on it); "open" reopens it (Undo, Restore). The person who reported it gets a report_resolved notification.',
    space: (tx, i) => tx.need('reports', i.report, 'report').sp,
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
    note: 'hide or remove an item without a report, or show a hidden item again', space: itemIn,
    run: (tx, i) => { itemSpace(tx, i.item); if (i.decision === 'shown') tx.mapDel('modSt', i.item); else tx.mapPut('modSt', i.item, i.decision); } });

  /* -- notifications -- */
  proc('notifications.markRead', { input: obj({ id: ID }), output: 'null', who: 'user', errors: ['NOT_FOUND'], wire: 'InboxNotification', writes: ['notifs'],
    run: (tx, i) => { tx.edit('notifs', i.id, n => { n.read = true; }, 'notification'); } });
  proc('notifications.markAllRead', { input: obj({}), output: 'null', who: 'user', writes: ['notifs', 'repSeen', 'reqSeen'],
    run: tx => { tx.get('notifs').filter(n => !n.read).forEach(n => tx.edit('notifs', n.id, x => { x.read = true; })); tx.setValue('reqSeen', true); tx.setValue('repSeen', true); } });
  proc('notifications.markSeen', { input: obj({ kind: one('requests', 'reports') }), output: 'null', who: 'user', errors: ['FORBIDDEN'], writes: ['repSeen', 'reqSeen'],
    note: 'the join-requests or reports notification for moderators was read: the caller moderates a space (a closed one, for requests)',
    can: (tx, i) => tx.get('spaces').some(s => rankIn(tx.get, s.id) >= RANK.moderator && (i.kind === 'reports' || closedSpace(s))) || deny(`Only moderators get the ${i.kind === 'requests' ? 'join requests' : 'reports'} notification.`),
    run: (tx, i) => tx.setValue(i.kind === 'requests' ? 'reqSeen' : 'repSeen', true) });

  /* -- invite links -- */
  /* who makes invite links: moderators; in a closed space whose invite setting is "members", its members */
  const invites = (tx, sid) => { const s = tx.need('spaces', sid, 'space'); return rankIn(tx.get, sid) >= RANK.moderator || (closedSpace(s) && s.invite === 'members') || deny(`Only moderators of #${s.name} can make invite links.`); };
  /* a link the caller can revoke or restore: one they made, or one in a space they moderate */
  const linkOf = (tx, id) => { const l = tx.need('links', id, 'invite link'); return rankIn(tx.get, l.sp) >= RANK.moderator || l.by === tx.me.u || deny('Only the person who made this link and the space’s moderators can change it.'); };
  const linkIn = (tx, i) => tx.need('links', i.id, 'invite link').sp;
  proc('invites.create', { input: obj({ space: ID, 'days?': nul(int) }), output: '{ id: InviteId, code: string }', who: 'member', errors: ['NOT_FOUND', 'CONFLICT'], wire: 'CreatedInvite', writes: ['links'],
    note: 'a one-use invite link; days: when it expires (null: never). The server makes the code. Moderators make links; so do members, in a closed space whose invite setting is "members".',
    space: spaceIn, can: (tx, i) => invites(tx, i.space),
    run: (tx, i) => {
      tx.need('spaces', i.space, 'space');
      const id = tx.id(), code = id.slice(-5).toLowerCase();
      if (tx.get('links').some(l => l.code === code)) throw rpcError('CONFLICT', 'An invite link with this code exists.');
      tx.put('links', { id, code, by: tx.me.u, expiresAt: i.days ? new Date(Date.parse(tx.now) + i.days * 864e5).toISOString().replace(/\.\d{3}Z$/, 'Z') : null, sp: i.space }, 'start');
      return { id, code };
    } });
  proc('invites.revoke', { input: obj({ id: ID }), output: 'null', who: 'member', errors: ['NOT_FOUND'], wire: 'ThreadInvite', writes: ['links'],
    note: 'revoke a link you made, or one in a space you moderate. People who already joined with it stay members. The server keeps the revoked link for invites.restore; GET leaves it out.',
    space: linkIn, can: (tx, i) => linkOf(tx, i.id),
    run: (tx, i) => { const l = tx.need('links', i.id, 'invite link'); if (l.revokedAt) throw rpcError('NOT_FOUND', 'This invite link was already revoked.'); tx.edit('links', l.id, x => { x.revokedAt = tx.now; }); } });
  proc('invites.restore', { input: obj({ id: ID }), output: 'null', who: 'member', errors: ['NOT_FOUND'], wire: 'ThreadInvite', writes: ['links'],
    note: 'put back a link revoked a moment ago (Undo), with its id and code',
    space: linkIn, can: (tx, i) => linkOf(tx, i.id),
    run: (tx, i) => { const l = tx.need('links', i.id, 'invite link'); if (!l.revokedAt) throw rpcError('NOT_FOUND', 'This invite link is not revoked.'); tx.edit('links', l.id, x => { delete x.revokedAt; }); } });

  /* -- versions and edit conflicts (step 9) --
     A page document, a skill and a space's rules carry a version: a page's rev, a skill's rev and the space's
     rulesAt (not its updatedAt, which a domain check also changes). An editor records the version it opened
     and sends it as `base` when it saves; when it is not the current one, the server answers CONFLICT with
     `current` (the version and content it has) and `changes` (those records as the caller reads them), and
     keeps nothing. force: true saves over the other version (the page's Overwrite). A save without a base is
     not checked. The scenario helpers h.savePage, h.saveSkill and h.saveRules write another member's save, as
     these procedures do, and bump the version. */
  const stale = (base, cur, force) => !force && base !== undefined && base !== cur;
  const conflict = (current, reads) => rpcError('CONFLICT', undefined, undefined, { current, reads });
  const pageRev = doc => doc.rev || 0;
  /* a rules stamp that moves forward even when the mock clock does not, so it works as the rules' version */
  const rulesStamp = (now, prev) => { const t = Math.max(Date.parse(now), prev ? Date.parse(prev) + 1000 : 0); return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'); };
  const BASE_RULES = obj({ rulesAt: nul(iso) }, 'RulesBase');
  /* a space's rules, as spaces.update writes them: the previous rules stay for "See changes" */
  function writeRules(tx, sid, rules, by) {
    tx.edit('spaces', sid, x => { const r = rules.map(y => y.trim()).filter(Boolean); if (r.join('\n') !== (x.rules || []).join('\n')) { x.rulesPrev = (x.rules || []).slice(); x.rules = r; x.rulesAt = rulesStamp(tx.now, x.rulesAt); x.rulesBy = by; } }, 'space');
  }
  const rulesCurrent = s => ({ rulesAt: s.rulesAt || null, rules: s.rules || [], rulesBy: s.rulesBy || null });

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
  proc('spaces.update', { input: obj({ id: ID, 'set?': settingsSchema, 'unset?': arr(one(...SPACE_SETTINGS)), 'base?': BASE_RULES, 'force?': bool }, 'UpdateSpaceInput'), output: 'null', who: 'admin', errors: ['NOT_FOUND', 'CONFLICT'], writes: ['spaces', 'posts', 'rel', 'reqs', 'mem', 'memOther'],
    space: (tx, i) => i.id,
    note: 'change a space’s settings. The server keeps the previous rules for “See changes”, moves threads in deleted topics to Other, approves the open join requests when the space becomes open, and records your membership of a space that becomes closed. base.rulesAt: the rules’ version the editor opened; CONFLICT when the rules changed since (step 9).',
    run: (tx, i) => {
      const s0 = tx.need('spaces', i.id, 'space'), set = i.set || {};
      if (set.name != null && set.name !== s0.name && tx.get('spaces').some(x => x.id !== s0.id && x.name === set.name)) throw rpcError('CONFLICT', `#${set.name} already exists.`);
      const rulesChange = set.rules && set.rules.map(r => r.trim()).filter(Boolean).join('\n') !== (s0.rules || []).join('\n');
      if (rulesChange && stale(i.base && i.base.rulesAt, s0.rulesAt || null, i.force)) throw conflict(rulesCurrent(s0), [['spaces', s0.id]]);
      tx.edit('spaces', s0.id, x => {
        for (const k of i.unset || []) delete x[k];
        for (const [k, v] of Object.entries(set)) if (k !== 'rules') x[k] = v;
      });
      if (set.rules) writeRules(tx, s0.id, set.rules, tx.me.u);
      const s = tx.need('spaces', s0.id, 'space');
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
  proc('spaces.verifyDomain', { input: obj({ id: ID, domain: str, 'method?': one('dns') }), output: 'null', who: 'admin', errors: ['NOT_FOUND'], writes: ['spaces'],
    note: 'check that the space’s admins control a domain (a DNS TXT record): the space’s dom is "checking" until the check job writes "ok" (with verifiedAt) or "failed" (section 6a)',
    space: (tx, i) => i.id,
    run: (tx, i) => {
      const domain = i.domain.trim().toLowerCase();
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) throw bad1('domain', 'a domain such as example.com');
      tx.edit('spaces', i.id, x => { x.dom = { domain, method: i.method || 'dns', state: 'checking' }; }, 'space');
      tx.job('domain', i.id);
    } });
  proc('spaces.archive', { input: obj({ id: ID, archived: bool }), output: 'null', who: 'owner', errors: ['NOT_FOUND'], writes: ['spaces'],
    note: 'archive (read-only, hidden from browse and search) or unarchive a space', space: (tx, i) => i.id,
    run: (tx, i) => { tx.edit('spaces', i.id, x => { if (i.archived) x.archived = { by: tx.me.u, on: new Date(tx.now).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) }; else delete x.archived; }, 'space'); } });
  proc('spaces.delete', { input: obj({ id: ID }), output: 'null', who: 'owner', errors: ['NOT_FOUND'], writes: ['spaces', 'joined', 'rel'],
    note: 'delete a space for everyone, with its threads, pages and sources (the mock marks it deleted)', space: (tx, i) => i.id,
    run: (tx, i) => { tx.edit('spaces', i.id, x => { x.deleted = true; delete x.archived; }, 'space'); setJoined(tx, i.id, false); tx.mapDel('rel', i.id); } });

  /* -- skills and pages -- */
  const skillsOf = (tx, sid) => { tx.need('spaces', sid, 'space'); return tx.mapGet('skills', sid) || []; };
  const SKILL_IN = { space: ID, name: str, prompt: str };
  proc('skills.create', { space: spaceIn, input: obj(SKILL_IN), output: 'null', who: 'moderator', errors: ['NOT_FOUND', 'CONFLICT'], writes: ['skills'],
    run: (tx, i) => { const l = skillsOf(tx, i.space); if (l.some(x => x.name === i.name)) throw rpcError('CONFLICT', `The space has a skill named ${i.name}.`); tx.mapPut('skills', i.space, [...l, { name: i.name, prompt: i.prompt, rev: 0 }]); } });
  /* a skill's new text: its version goes up by one */
  function writeSkill(tx, sid, index, name, prompt) { const l = skillsOf(tx, sid); l[index] = { name, prompt, rev: l[index].rev + 1 }; tx.mapPut('skills', sid, l); }
  proc('skills.update', { space: spaceIn, input: obj({ ...SKILL_IN, index: int, 'base?': obj({ rev: int }, 'SkillBase'), 'force?': bool }), output: 'null', who: 'moderator', errors: ['NOT_FOUND', 'CONFLICT'], writes: ['skills'],
    note: 'base.rev: the skill’s version the editor opened; CONFLICT when someone else saved it since (step 9)',
    run: (tx, i) => {
      const l = skillsOf(tx, i.space), row = l[i.index];
      if (!row) throw rpcError('NOT_FOUND', 'The server has no record of this skill.');
      if (stale(i.base && i.base.rev, row.rev, i.force)) throw conflict({ rev: row.rev, name: row.name, prompt: row.prompt }, [['skills', i.space]]);
      if (l.some((x, k) => k !== i.index && x.name === i.name)) throw rpcError('CONFLICT', `The space has a skill named ${i.name}.`);
      writeSkill(tx, i.space, i.index, i.name, i.prompt);
    } });
  proc('skills.remove', { space: spaceIn, input: obj({ space: ID, index: int }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['skills'],
    run: (tx, i) => { const l = skillsOf(tx, i.space); if (!l[i.index]) throw rpcError('NOT_FOUND', 'The server has no record of this skill.'); tx.mapPut('skills', i.space, l.filter((_, k) => k !== i.index)); } });
  proc('skills.reorder', { space: spaceIn, input: obj({ space: ID, from: int, to: int }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['skills'],
    run: (tx, i) => { const l = skillsOf(tx, i.space); if (!l[i.from] || !l[i.to]) throw rpcError('NOT_FOUND', 'The server has no record of this skill.'); const [x] = l.splice(i.from, 1); l.splice(i.to, 0, x); tx.mapPut('skills', i.space, l); } });
  const pageSlug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  /* TODO(fixtures): the fixtures have no page documents; the page shows a generated stand-in (abDoc). Until
     they do, the page sends the stand-in's author and history as `base`, used when the server has no document. */
  /* base: the document as the editor opened it: its version (rev, step 9), and for a stand-in its author and history */
  const BASE_DOC = obj({ 'rev?': int, 'by?': str, 'ed?': str, 'revs?': arr(obj({ by: str, 'createdAt?': iso, note: str })) }, 'PageBase');
  const pageAt = (tx, sid, index) => { const s = tx.need('spaces', sid, 'space'), pg = (s.pages || [])[index]; if (!pg) throw rpcError('NOT_FOUND', 'The server has no record of this page. Someone may have deleted it.'); return [s, pg]; };
  const docOf = (tx, sid, title, base) => tx.mapGet('pagedocs', `${sid}/${pageSlug(title)}`) || { t: title, text: [''], by: (base && base.by) || tx.me.u, ed: base && base.ed, revs: (base && base.revs) || [] };
  /* the space's pageEdit setting (the page's abCanEdit): moderators edit pages; with "members", its members too */
  const pageEditor = (tx, sid) => { const s = tx.need('spaces', sid, 'space'); return rankIn(tx.get, sid) >= RANK.moderator || (s.pageEdit === 'members' && !!roleIn(tx.get, sid)) || deny(`In #${s.name}, ${s.pageEdit === 'members' ? 'members' : 'moderators'} edit pages.`); };
  /* the version and content of a page, for a CONFLICT; and the records the page reads again */
  const pageCurrent = doc => ({ rev: pageRev(doc), t: doc.t, text: doc.text, ed: doc.ed || null, at: (doc.revs[0] && doc.revs[0].createdAt) || null });
  const pageReads = (sid, title) => [['pagedocs', `${sid}/${pageSlug(title)}`], ['spaces', sid]];
  /* an edit of page `index` by `by`: the new title and text, one more version, a line in the history */
  function writePage(tx, sid, index, title, body, by, base) {
    const [, pg] = pageAt(tx, sid, index), doc = docOf(tx, sid, pg[0], base);
    tx.edit('spaces', sid, x => { x.pages = x.pages.map((p, k) => k === index ? [title, tx.now] : p); });
    if (pageSlug(pg[0]) !== pageSlug(title)) tx.mapDel('pagedocs', `${sid}/${pageSlug(pg[0])}`);
    tx.mapPut('pagedocs', `${sid}/${pageSlug(title)}`, { t: title, text: body, by: doc.by, ed: by, rev: pageRev(doc) + 1, revs: [{ by, note: 'Edited the page' }, ...doc.revs] });
  }
  proc('pages.update', { input: obj({ space: ID, 'page?': nul(int), title: str, text: arr(str), 'base?': BASE_DOC, 'force?': bool }, 'UpdatePageInput'), output: 'null', who: 'member', errors: ['NOT_FOUND', 'CONFLICT'], writes: ['pagedocs', 'spaces'],
    note: 'add a page (page: null) or edit one (page: its index in the space’s pages); members get a notification. Who may edit follows the space’s pageEdit setting: moderators, and its members when it is "members". CONFLICT when the page changed since it was opened (step 9).',
    space: spaceIn, can: (tx, i) => pageEditor(tx, i.space),
    run: (tx, i) => {
      const title = text(i.title, 'title'), body = i.text.length ? i.text : [''];
      if (i.page == null) {
        tx.edit('spaces', i.space, x => { x.pages = [...(x.pages || []), [title, tx.now]]; }, 'space');
        tx.mapPut('pagedocs', `${i.space}/${pageSlug(title)}`, { t: title, text: body, by: tx.me.u, ed: tx.me.u, rev: 1, revs: [{ by: tx.me.u, note: 'Created the page' }] });
        return;
      }
      const [, pg] = pageAt(tx, i.space, i.page), doc = docOf(tx, i.space, pg[0], i.base);
      if (stale(i.base && i.base.rev, pageRev(doc), i.force)) throw conflict(pageCurrent(doc), pageReads(i.space, pg[0]));
      writePage(tx, i.space, i.page, title, body, tx.me.u, i.base);
    } });
  proc('pages.restore', { input: obj({ space: ID, page: int, rev: int, note: str, 'base?': BASE_DOC, 'force?': bool }), output: 'null', who: 'member', errors: ['NOT_FOUND', 'CONFLICT'], writes: ['pagedocs'],
    note: 'restore an earlier version; the history keeps both (note: the history line, written by the page). rev: the index of the version in the history; base.rev: the document’s version when its history was opened (CONFLICT, step 9). Who may: as pages.update.',
    space: spaceIn, can: (tx, i) => pageEditor(tx, i.space),
    run: (tx, i) => {
      const [, pg] = pageAt(tx, i.space, i.page), doc = docOf(tx, i.space, pg[0], i.base);
      if (stale(i.base && i.base.rev, pageRev(doc), i.force)) throw conflict(pageCurrent(doc), pageReads(i.space, pg[0]));
      if (!doc.revs[i.rev]) throw rpcError('NOT_FOUND', 'The server has no record of this version.');
      tx.mapPut('pagedocs', `${i.space}/${pageSlug(pg[0])}`, { ...doc, ed: tx.me.u, rev: pageRev(doc) + 1, revs: [{ by: tx.me.u, note: i.note }, ...doc.revs] });
    } });
  proc('pages.remove', { space: spaceIn, input: obj({ space: ID, page: int }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['pagedocs', 'spaces'],
    run: (tx, i) => { const [, pg] = pageAt(tx, i.space, i.page); tx.edit('spaces', i.space, x => { x.pages = x.pages.filter((_, k) => k !== i.page); }); tx.mapDel('pagedocs', `${i.space}/${pageSlug(pg[0])}`); } });
  proc('pages.move', { space: spaceIn, input: obj({ space: ID, from: int, to: int }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['spaces'],
    note: 'swap a page with the one above or below it in About',
    run: (tx, i) => { pageAt(tx, i.space, i.from); pageAt(tx, i.space, i.to); tx.edit('spaces', i.space, x => { const p = x.pages.slice(); [p[i.from], p[i.to]] = [p[i.to], p[i.from]]; x.pages = p; }); } });

  /* -- API keys: TODO(limits) stubs. Not encrypted (owner decision), no usage accounting. A key check is a
     server job (section 6a): the key is "checking" until the job writes the provider's verdict. */
  const keyProvider = v => v.startsWith('AIza') ? 'Google' : v.startsWith('sk-ant-') ? 'Anthropic' : v.startsWith('sk-or-') ? 'OpenRouter' : 'OpenAI';
  const keyMask = v => `${v.slice(0, v.startsWith('sk-ant-') ? 7 : v.startsWith('AIza') ? 4 : 3)}…${v.slice(-4)}`;
  const rawKey = (tx, raw, except) => { if (raw.trim().length < 8) throw bad1('raw', 'an API key'); if (tx.get('userKeys').some(k => k.raw === raw && k.id !== except)) throw rpcError('CONFLICT', 'This key has already been added.'); return raw.trim(); };
  proc('apiKeys.create', { input: obj({ raw: str, label: str, 'cap?': num, 'check?': bool }), output: '{ id: KeyId }', who: 'user', errors: ['CONFLICT'], stub: true, writes: ['userKeys'],
    note: 'TODO(limits) stub. check: the key is checked with its provider (state "checking"); without it the key counts as valid. raw is write-only.',
    run: (tx, i) => {
      const raw = rawKey(tx, i.raw), id = tx.id(), k = { id, kind: 'key', raw, label: i.label.trim() || `API key ${tx.get('userKeys').length + 1}`, mask: keyMask(raw), provider: keyProvider(raw) };
      if (i.check) Object.assign(k, { valid: false, lastUsedAt: null, used: 0, cap: i.cap || 0, check: 'checking' }); else k.valid = true;
      tx.put('userKeys', k);
      if (i.check) tx.job('key', id, { why: window.SessionJobs.keyVerdict(k) });
      return { id };
    } });
  proc('apiKeys.replace', { input: obj({ id: ID, raw: str }), output: 'null', who: 'user', errors: ['NOT_FOUND', 'CONFLICT'], stub: true, writes: ['userKeys'],
    note: 'TODO(limits) stub: a new raw key under the same name; it is checked again',
    run: (tx, i) => { const raw = rawKey(tx, i.raw, i.id); tx.edit('userKeys', i.id, k => { Object.assign(k, { raw, mask: keyMask(raw), provider: keyProvider(raw), createdAt: tx.now, lastUsedAt: null, used: 0, check: 'checking', valid: false }); delete k.reason; }, 'key'); tx.job('key', i.id, { why: window.SessionJobs.keyVerdict({ raw }) }); } });
  proc('apiKeys.check', { input: obj({ id: ID }), output: 'null', who: 'user', errors: ['NOT_FOUND'], stub: true, writes: ['userKeys'],
    note: 'TODO(limits) stub: check the key with its provider again',
    run: (tx, i) => { const why = window.SessionJobs.keyVerdict(tx.need('userKeys', i.id, 'key')); tx.edit('userKeys', i.id, k => { k.check = 'checking'; k.valid = false; delete k.reason; }); tx.job('key', i.id, { why }); } });
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
  proc('spaceSources.add', { input: obj({ space: ID, 'source?': ID, 'url?': str, 'file?': str, 'note?': str }, 'AddSpaceSourceInput'), output: '{ id: SourceId, review: boolean }', who: 'member', errors: ['NOT_FOUND', 'PRECONDITION_FAILED'], writes: ['dsDrops', 'media', 'miAdded', 'miRead'],
    note: 'add a source to a space: one Session has (source), or a URL or file it reads now (a new source record, id from the server). The space’s policy (dsPol) decides, with the caller’s role: "members" adds it, "review" makes a member’s source wait for a moderator, "mods" lets only moderators add. The server computes review; the input can’t set it.',
    space: spaceIn,
    can: (tx, i) => (tx.get('dsPol')[i.space] || 'members') !== 'mods' || rankIn(tx.get, i.space) >= RANK.moderator || deny('Only moderators add sources to this space.'),
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
      const rv = (tx.get('dsPol')[s.id] || 'members') === 'review' && rankIn(tx.get, s.id) < RANK.moderator;
      tx.mapPut('dsDrops', s.id, [{ m: id, by: tx.me.u, note: (i.note || '').trim(), rv }, ...drops]);
      const k = srcColl(tx, id), m = tx.find(k, id);
      if (!m.sp.includes(s.id)) tx.edit(k, id, x => { x.sp = [...x.sp, s.id]; });
      if (!tx.get('miRead').has(id)) flip(tx, 'miRead', id, true);
      return { id, review: rv };
    } });
  proc('spaceSources.review', { input: obj({ space: ID, source: ID, decision: one('approve', 'reject', 'remove', 'restore', 'keep') }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['dsDrops', 'dsReps'],
    note: 'approve or reject a source waiting for review, remove one from the space or restore it (Undo), or keep a reported one. Reject and keep resolve its reports.', space: spaceIn,
    run: (tx, i) => {
      const l = tx.mapGet('dsDrops', i.space) || [], want = i.decision === 'restore' ? x => x.rm : x => !x.rm;
      const j = l.findIndex(x => x.m === i.source && want(x));
      if (j >= 0) { const x = l[j]; if (i.decision === 'approve') x.rv = false; if (i.decision === 'reject' || i.decision === 'remove') x.rm = true; if (i.decision === 'restore') x.rm = false; tx.mapPut('dsDrops', i.space, l); }
      else if (i.decision !== 'keep') throw rpcError('NOT_FOUND', 'The space has no record of this source.');
      if (i.decision === 'keep' || i.decision === 'reject') { const r = tx.value('dsReps'), r2 = r.filter(x => !(x.sid === i.space && x.m === i.source)); if (r2.length !== r.length) tx.setValue('dsReps', r2); }
    } });
  proc('spaceSources.setPolicy', { input: obj({ space: ID, policy: one('members', 'review', 'mods') }), output: 'null', who: 'moderator', errors: ['NOT_FOUND'], writes: ['dsPol'],
    note: 'who can add sources: members, members with review, or moderators. Manage › Sources offers it to moderators.', space: spaceIn, run: (tx, i) => { tx.need('spaces', i.space, 'space'); tx.mapPut('dsPol', i.space, i.policy); } });
  proc('sourceReports.create', { space: spaceIn, input: obj({ space: ID, source: ID, why: str }), output: 'null', who: 'member', errors: ['NOT_FOUND'], writes: ['dsReps'],
    run: (tx, i) => { tx.need('spaces', i.space, 'space'); if (!srcColl(tx, i.source)) throw rpcError('NOT_FOUND'); tx.setValue('dsReps', [...tx.value('dsReps'), { m: i.source, sid: i.space, by: tx.me.u, why: i.why }]); } });

  /* the procedures' rows in the contract table */
  for (const [name, P] of Object.entries(PROCS)) {
    const who = P.who || 'user';
    if (RANK[who] && !P.space) throw new Error(`${name}: who '${who}' needs def.space`);
    if (who === 'author' && !P.can) throw new Error(`${name}: who 'author' needs def.can`);
    const errors = [...new Set(['BAD_REQUEST', ...(P.errors || []), ...authErrors(who, 'POST')])];
    API.push({ method: 'POST', path: '/api/rpc/' + name, coll: null, op: 'rpc', input: describe(P.input, true), output: P.output || 'null', who, trpc: name, wire: P.wire || null, errors, writes: P.writes || [], bulk: false, scope: ['user'], ...(P.stub ? { stub: true } : {}), ...(P.note ? { note: P.note } : {}) });
  }

  /* ---- 5c. paged lists (step 8) ----
     The lists that grow without bound are read a page at a time with a query: GET /api/rpc/<name>?input=<JSON>
     (tRPC queries are GETs; the input is URL-encoded JSON, encoded with the wire codec). A paged query takes
     { cursor?, limit? } with its own fields and answers { items, nextCursor }, as notifications.list in
     web/docs/03-api-and-events.md (InboxNotificationPage, web/packages/shared/src/types/sharing.ts):
       order       newest first: by the record's time (createdAt; joinedAt for members), then by id, both
                   descending. A record without a time sorts as the newest.
       readScope   the rows are what GET returns to the caller (section 5a), filtered before the slice, so a page
                   is never short because records were left out after it.
       limit       1 to 100; the default is the query's (30 unless it says otherwise), or DevConfig pageSize when
                   it is set (a dev override, for the Screen entries).
       cursor      an opaque string: the time (ms) and id of the last record of the page, base64url-encoded.
                   The next page starts after that record, so records created between two page loads go on top
                   and do not shift the next page. nextCursor is null on the last page. A cursor that does not
                   decode is BAD_REQUEST.
     The counts the page shows stay totals: a space's members, a profile's threads (/api/users), the unread
     count (notifications.unreadCount) and the Usage totals (usage.get) do not depend on the pages loaded.
     defQuery(name, def): def.input (the fields besides cursor and limit), def.who ('guest' or 'user'; a list is
     scoped, not refused), def.rows(ctx, input) → the scoped records, def.key(record) → [time, id],
     def.limit, def.item (the item type's name), def.wire, def.note. def.run(ctx, input) instead of rows: a
     query that is not a page. ctx (createBackend): d, sc (readScope), me, signedIn, now, all(k) (a
     collection as GET returns it), reads(space) (may the caller read the space's threads). */
  const PAGE_LIMIT = 30, PAGE_MAX = 100;
  const QUERIES = {};
  const defQuery = (name, def) => { QUERIES[name] = def; };
  const PAGE_IN = { 'cursor?': nul(str), 'limit?': int };
  /* a record's place in the order: [time in ms (Infinity without one), id] */
  const keyOf = (t, id) => { const ms = t ? Date.parse(t) : NaN; return [isNaN(ms) ? Infinity : ms, String(id)]; };
  const cmpKey = (a, b) => (a[0] === b[0] ? 0 : a[0] < b[0] ? -1 : 1) || (a[1] === b[1] ? 0 : a[1] < b[1] ? -1 : 1);
  const b64u = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = s => atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const encodeCursor = k => b64u(encodeURIComponent(JSON.stringify([k[0] === Infinity ? null : k[0], k[1]])));
  function decodeCursor(c) {
    try { const k = JSON.parse(decodeURIComponent(unb64u(c))); if (Array.isArray(k) && k.length === 2 && (k[0] === null || typeof k[0] === 'number') && typeof k[1] === 'string') return [k[0] === null ? Infinity : k[0], k[1]]; } catch (e) {}
    return null;
  }
  /* one page of rows (newest first) after the cursor */
  function pageOf(rows, key, input, limit) {
    const keyed = rows.map(x => [key(x), x]).sort((a, b) => cmpKey(b[0], a[0]));
    let start = 0;
    if (input.cursor != null) {
      const c = decodeCursor(input.cursor);
      if (!c) throw rpcError('BAD_REQUEST', undefined, ['input.cursor: expected a cursor from an earlier page']);
      start = keyed.findIndex(([k]) => cmpKey(k, c) < 0); if (start < 0) start = keyed.length;
    }
    const slice = keyed.slice(start, start + limit), more = start + limit < keyed.length;
    return { items: slice.map(([, x]) => x), nextCursor: more ? encodeCursor(slice[slice.length - 1][0]) : null };
  }
  const notGone = p => !p.gone;
  const THREAD_KIND = { 'kind?': one('ask', 'post') };
  /* the search the page runs: a word's stem in a thread's title, question, summary or answer text */
  const searchStem = s => String(s || '').trim().toLowerCase().replace(/(ions|ion|s)$/, '');
  defQuery('threads.feed', { input: { 'scope?': one('joined', 'all', 'public'), ...THREAD_KIND }, who: 'guest', item: 'Thread',
    note: 'Home: threads in the caller’s spaces (scope joined, the default; without the threads of people they muted or blocked), in every space they can read (all), or in the listed open spaces (public); kind: asks or posts only',
    key: p => keyOf(p.createdAt, p.id),
    rows: (x, i) => {
      const scope = i.scope || 'joined', joined = new Set(x.d.joined), hide = scope === 'joined' ? new Set([...x.d.muted, ...x.d.blocked]) : new Set();
      const ok = new Set(x.d.spaces.filter(s => !s.deleted && x.reads(s) && (scope === 'joined' ? joined.has(s.id) : scope === 'public' ? !closedSpace(s) && !s.archived && s.vis !== 'unlisted' : true)).map(s => s.id));
      return x.all('posts').filter(p => ok.has(p.s) && notGone(p) && !hide.has(p.u) && (!i.kind || p.k === i.kind));
    } });
  defQuery('threads.list', { input: { space: ID, 'topic?': str, ...THREAD_KIND }, who: 'guest', item: 'Thread',
    note: 'a space’s threads (Latest, and the FAQ landing’s topic lists): topic, a topic key, or "other" for threads without one of the space’s topics',
    key: p => keyOf(p.createdAt, p.id),
    rows: (x, i) => {
      const s = x.d.spaces.find(y => y.id === i.space); if (!s) throw rpcError('NOT_FOUND', 'The server has no record of this space. Someone may have deleted it.');
      const topics = new Set((s.topics || []).map(t => t[0])), topicOf = p => p.topic && topics.has(p.topic) ? p.topic : 'other';
      return x.all('posts').filter(p => p.s === s.id && notGone(p) && (!i.kind || p.k === i.kind) && (i.topic == null || topicOf(p) === i.topic));
    } });
  defQuery('notifications.list', { input: {}, who: 'user', item: 'Notification', wire: 'InboxNotificationPage', note: 'the caller’s notifications, newest first. The page’s shape is InboxNotificationPage’s; its items are the mock’s Notification records, not InboxNotification',
    key: n => keyOf(n.createdAt, n.id), rows: x => x.all('notifs') });
  defQuery('notifications.unreadCount', { input: { 'after?': nul(str) }, who: 'user', output: '{ count: number }', note: 'the caller’s unread notifications; after: only those after a cursor (the ones not loaded yet)',
    run: (x, i) => {
      const c = i.after == null ? null : decodeCursor(i.after);
      if (i.after != null && !c) throw rpcError('BAD_REQUEST', undefined, ['input.after: expected a cursor from notifications.list']);
      return { count: x.all('notifs').filter(n => !n.read && (!c || cmpKey(keyOf(n.createdAt, n.id), c) < 0)).length };
    } });
  defQuery('users.listThreads', { input: { handle: str }, who: 'guest', item: 'Thread', note: 'a profile’s threads in the spaces the caller can read; the count on the profile is the whole list’s (the page holds every thread record)',
    key: p => keyOf(p.createdAt, p.id), rows: (x, i) => { const sps = new Map(x.d.spaces.map(s => [s.id, s])); return x.all('posts').filter(p => p.u === i.handle && notGone(p) && sps.has(p.s) && !sps.get(p.s).deleted && x.reads(sps.get(p.s))); } });
  defQuery('users.listFollowUps', { input: { handle: str }, who: 'guest', item: '{ id, thread, index } & FollowUp', note: 'a profile’s follow-ups on the threads the caller can read; id: "<thread>:<index>"',
    key: f => keyOf(f.createdAt, f.id),
    rows: (x, i) => { const th = new Set(x.all('posts').map(p => p.id)), fu = x.all('fu'); return Object.entries(fu).filter(([pid]) => th.has(pid)).flatMap(([pid, l]) => l.map((f, k) => ({ ...f, id: `${pid}:${k}`, thread: pid, index: k })).filter(f => f.u === i.handle && !f.del)); } });
  defQuery('saved.list', { input: { 'space?': ID, 'q?': str }, who: 'user', item: 'Thread', note: 'the caller’s saved threads (the threads they can read or wrote); space: one space’s; q: text in the title, question or summary',
    key: p => keyOf(p.createdAt, p.id),
    rows: (x, i) => { const by = new Map(x.all('posts').map(p => [p.id, p])), t = String(i.q || '').trim().toLowerCase(); return [...x.d.saved].map(id => by.get(id)).filter(p => p && (!i.space || p.s === i.space) && (!t || `${p.t || ''} ${p.q} ${p.sum || ''}`.toLowerCase().includes(t))); } });
  defQuery('search.threads', { input: { q: str, 'space?': ID }, who: 'guest', item: 'Thread', note: 'threads the caller can read whose title, question, summary or answer has the search word (its stem); space: one space’s. The Threads count on the page is the whole result’s.',
    key: p => keyOf(p.createdAt, p.id),
    rows: (x, i) => {
      const stem = searchStem(i.q); if (!stem) return [];
      const sps = new Map(x.d.spaces.map(s => [s.id, s])), rich = x.all('rich');
      const body = id => String(rich[id] || '').replace(/<sup[^>]*>.*?<\/sup>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
      return x.all('posts').filter(p => { const s = sps.get(p.s); return s && !s.deleted && x.reads(s) && notGone(p) && (!i.space || p.s === i.space) && `${p.t || ''} ${p.q} ${p.sum || ''} ${body(p.id)}`.toLowerCase().includes(stem); });
    } });
  defQuery('members.list', { input: { space: ID }, who: 'guest', item: 'Member', wire: 'ThreadMember[]', note: 'a space’s members, newest first by joinedAt (as /api/members: a closed space’s list goes whole to its members, and to others as its owner, admins and moderators). The count is the space’s members field.',
    key: m => keyOf(m.joinedAt, m.u), rows: (x, i) => i.space === C.mem.space ? x.all('mem') : (x.all('memOther')[i.space] || []) });
  defQuery('joinRequests.list', { input: { space: ID, 'state?': one('open', 'approved', 'declined') }, who: 'user', item: 'JoinRequest', note: 'Manage › Requests: a space’s join requests (the caller’s own, or every one in a space they moderate)',
    key: r => keyOf(r.createdAt, r.u), rows: (x, i) => x.all('reqs').filter(r => reqSpace(r) === i.space && (!i.state || r.st === i.state)) });
  defQuery('reports.list', { input: { space: ID, 'state?': one('open', 'dismissed', 'hidden', 'removed') }, who: 'user', item: 'Report', note: 'Manage › Reports: a space’s reports (the caller’s own, or every one in a space they moderate)',
    key: r => keyOf(r.createdAt, r.id), rows: (x, i) => x.all('reports').filter(r => r.sp === i.space && (!i.state || r.st === i.state)) });
  defQuery('spaceSources.list', { input: { space: ID }, who: 'guest', item: '{ id } & SpaceSource', note: 'a space’s sources list: the sources it has (not removed), newest first; id: the source’s id (m)',
    key: e => keyOf(e.createdAt, e.m),
    rows: (x, i) => { const srcs = new Set([...x.all('media'), ...x.all('miAdded')].map(m => m.id)); return (x.all('dsDrops')[i.space] || []).filter(e => !e.rm && srcs.has(e.m)).map(e => ({ ...e, id: e.m })); } });
  /* TODO(limits): token usage is a stub; the asks are read from the threads and ask trees, as the page did */
  defQuery('usage.listAsks', { input: {}, who: 'user', limit: 8, item: 'UsageAsk', stub: true,
    note: 'Usage › Recent asks: the caller’s asks and follow-ups that used tokens, newest first (for a new account, only the ones from the last minute). UsageAsk: { id: "<thread>:<node>", thread, node, space, t, u, tok, pay, del?, createdAt, readable } (readable: false for an ask in the tree of a closed space’s thread the caller cannot read). Default limit 8.',
    key: r => keyOf(r.createdAt, r.id),
    rows: x => {
      const out = [], me = x.me.u, posts = x.all('posts'), fu = x.all('fu'), qtd = x.all('qtd'), sps = new Set(x.d.spaces.map(s => s.id));
      const nodesOf = (th, tree) => { const fus = fu[th] || []; return tree.nodes.map(n => { const f = n.fu != null ? fus[n.fu] || {} : null; return f ? { ...n, u: f.u, createdAt: f.createdAt, q: f.q, del: f.del } : n; }); };
      const add = (p, n, space, readable) => out.push({ id: `${p}:${n.id}`, thread: p, node: n.id, space, t: n.t || n.q || '', u: n.u, tok: n.tok, pay: n.pay, createdAt: n.createdAt, readable, ...(n.del ? { del: true } : {}) });
      const seen = new Set();
      for (const p of posts) {
        if (p.k !== 'ask' || p.gone || !sps.has(p.s)) continue;
        seen.add(p.id);
        if (p.u === me && p.tok && !p.running) add(p.id, { ...p, id: 'r', del: undefined }, p.s, true);
        if (!qtd[p.id]) continue;
        nodesOf(p.id, qtd[p.id]).forEach(n => { if (n.u === me && n.tok && !n.running && !n.fail) add(p.id, n, p.s, true); });
      }
      /* your asks in the tree of a closed space’s thread you cannot read: the tree carries its space */
      Object.entries(qtd).forEach(([th, tree]) => { if (seen.has(th) || !tree.space || !sps.has(tree.space)) return; nodesOf(th, tree).forEach(n => { if (n.u === me && n.tok && !n.running && !n.fail && !n.del) add(th, n, tree.space, false); }); });
      const fresh = x.d.usage && x.d.usage.fresh, now = Date.parse(x.now);
      return fresh ? out.filter(r => now - Date.parse(r.createdAt || x.now) < 60e3) : out;
    } });
  /* the queries' rows in the contract table */
  for (const [name, Q] of Object.entries(QUERIES)) {
    Q.inputSchema = obj(Q.run ? Q.input : { ...Q.input, ...PAGE_IN }, name + 'Input');
    API.push({ method: 'GET', path: '/api/rpc/' + name, coll: null, op: 'query', input: describe(Q.inputSchema, true), output: Q.run ? Q.output : `{ items: ${Q.item}[], nextCursor: string | null }`,
      who: Q.who, trpc: name, wire: Q.wire || null, errors: ['BAD_REQUEST', ...authErrors(Q.who, 'GET')], bulk: false, paged: !Q.run, ...(Q.stub ? { stub: true } : {}), ...(Q.note ? { note: Q.note } : {}),
      ...(Q.run ? {} : { limit: Q.limit || PAGE_LIMIT }) });
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
  function createBackend({ fixtures, seed, scenarios, storageKey = 'session-mock-db-v6', latency = 120, dev = false, jobMs, checkMs }) {
    const fx = fixtures || { data: seed ? seed() : {} };
    const me = fx.me || { u: 'me', x: '@me', createdAt: new Date().toISOString() };
    const cfg = { now: fx.clock || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), base: latency, latency, failWrites: false, failReads: false, failCode: 'SERVICE_UNAVAILABLE', failOn: null, readRules: { ...READ_RULES },
      jobs: 'run', jobMs: jobMs == null ? (latency === 0 ? 40 : 2400) : jobMs, checkMs: checkMs == null ? 1400 : checkMs, failNextRun: null, resumeJobs: true, pageSize: null };
    const log = window.__mockApiLog = [];
    const LOG_MAX = 400;   /* the newest requests; `seq` counts every request, so a test can take the ones after a mark */
    let seq = 0;
    let data = null, ids = 0, ver = null;   /* ids: how many ids the server has made (the ULID counter) */
    let stored = false;                     /* the database came from localStorage (a reload) */
    const fail = msg => { console.error('[mock api] ' + msg); if (dev) setTimeout(() => { throw new Error('[mock api] ' + msg); }); };
    const seedData = () => { const s = fixtures ? fixtures.data : seed(), o = {}; for (const k of Object.keys(C)) if (k in s) o[k] = s[k]; return dec(enc(o)); };
    const version = () => { if (ver) return ver; const t = enc({ seed: seedData(), clock: fx.clock || null, me }); let x = 2166136261; for (let i = 0; i < t.length; i++) { x ^= t.charCodeAt(i); x = Math.imul(x, 16777619); } return (ver = (x >>> 0).toString(36) + ':' + t.length); };
    const db0 = () => {
      if (data) return data;
      try { const s = localStorage.getItem(storageKey); if (s) { const o = dec(s); if (o && o.v === version()) { ids = o.ids || 0; checks = Array.isArray(o.checks) ? o.checks : []; if (o.dev && o.dev.resumeJobs === false) cfg.resumeJobs = false; stored = true; return (data = o.data); } } } catch (e) {}
      data = seedData(); ids = 0;
      if (dev) checkSeed(data);
      return data;
    };
    const save = () => { try { localStorage.setItem(storageKey, enc({ v: version(), ids, data, checks, dev: { resumeJobs: cfg.resumeJobs } })); } catch (e) {} };
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
    /* the caller: the signed-in person, or nobody (signedIn false); what they may read (section 5a) */
    const ME = { signedIn: true }, GUEST = { signedIn: false };
    const scopeFor = (d, caller) => readScope(d, caller.signedIn, cfg.readRules, me);
    /* a collection as GET returns it to the caller (sc: their readScope) */
    function viewAll(k, d, sc) {
      const c = C[k];
      if (c.computed) return c.computed(d);
      if (c.kind === 'list') return d[k].map(x => sc.list(k, x)).filter(Boolean).map(x => viewOne(k, x, d));
      if (c.kind === 'map') { const o = {}; for (const [key, v] of Object.entries(d[k])) { const y = sc.map(k, key, v); if (y !== undefined) o[key] = y; } return o; }
      return sc.value(k, d[k]);
    }
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
    function transaction(d, caller = ME) {
      const staged = {}, touched = {}, ids0 = ids;
      const copy = v => v === undefined ? undefined : dec(enc(v));
      const cur = k => (k in staged ? staged[k] : d[k]);
      const own = k => { if (!(k in staged)) { const v = d[k]; staged[k] = v instanceof Set ? new Set(v) : Array.isArray(v) ? v.slice() : v && typeof v === 'object' ? { ...v } : v; } return staged[k]; };
      const mark = (k, x) => (touched[k] = touched[k] || new Set()).add(String(x));
      const idOf = (k, x) => String(x[C[k].id]);
      const tx = {
        me, now: cfg.now, signedIn: caller.signedIn,
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
        /* events to publish and checks to start once the transaction commits (section 6a) */
        events: [], jobs: [],
        emit: e => { tx.events.push(e); },
        job: (kind, id, o) => { tx.jobs.push([kind, id, o]); },
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
        /* the records as the caller may now read them: one they may not read goes out as deleted */
        const sc = scopeFor(d, caller), changes = {};
        for (const [k, keys] of Object.entries(touched)) {
          const c = C[k];
          if (c.kind === 'value') { changes[k] = { value: sc.value(k, d[k]) }; continue; }
          if (c.kind === 'map') { const put = {}, del = []; keys.forEach(x => { const v = x in d[k] ? sc.map(k, x, d[k][x]) : undefined; if (v !== undefined) put[x] = v; else del.push(x); }); changes[k] = { put, del }; continue; }
          const put = [], del = [], at = {};
          keys.forEach(x => { const i = d[k].findIndex(y => idOf(k, y) === x), r = i < 0 ? null : sc.list(k, d[k][i]); if (!r) { del.push(x); return; } put.push(viewOne(k, r, d)); if (!(before[k] || new Set()).has(x)) at[x] = i; });
          changes[k] = Object.keys(at).length ? { put, del, at } : { put, del };
        }
        /* computed collections: the people whose threads changed */
        if (touched.posts) { const all = C.people.computed(d), put = {}; touched.posts.forEach(x => { const p = d.posts.find(y => y.id === x); if (p && all[p.u]) put[p.u] = all[p.u]; }); if (Object.keys(put).length) changes.people = { put, del: [] }; }
        return changes;
      };
      return tx;
    }

    /* the dev check of the seed: every record must pass its collection's schema */
    function checkSeed(d) {
      for (const [k, c] of Object.entries(C)) {
        if (c.computed) continue;
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
      if (c.key === 'node') { const [th, n] = key.split(':'); if (!ULID_RE.test(th) || !n) return ['"<thread>:<node>"']; }
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
    function snapshot(d, caller = ME, keys = Object.keys(C)) {
      const o = { $views: {} }, sc = scopeFor(d, caller);
      for (const k of keys) {
        const c = C[k];
        if (!(k in d) && !c.computed) continue;
        const view = viewAll(k, d, sc); o.$views[k] = view;
        if (c.kind === 'list') o[k] = { ids: view.map(x => String(x[c.id])), views: view, codes: new Map(view.map(x => [String(x[c.id]), enc(x)])) };
        else if (c.kind === 'map') o[k] = new Map(Object.entries(view).map(([key, v]) => [key, enc(v)]));
        else o[k] = enc(view);
      }
      return o;
    }
    /* the changes from snapshot a to snapshot b (b's views are what the caller reads now) */
    function changesBetween(a, b) {
      const changes = {};
      for (const [k, c] of Object.entries(C)) {
        if (!(k in b)) continue;
        const x = a[k], y = b[k], now = b.$views[k];
        if (c.kind === 'value') { if (x !== y) changes[k] = { value: now }; continue; }
        if (c.kind === 'map') {
          const put = {}, del = [];
          y.forEach((v, key) => { if (!x || x.get(key) !== v) put[key] = now[key]; });
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
      /* a run held at a progress step: started (seq 1) and one committed turn per step before it */
      run: (th, node, step) => {
        const x = node === 'r' ? tx.find('posts', th) : askTree(tx, th).nodes.find(n => n.id === node);
        tx.mapPut('runs', runKey(th, node), { th, node, u: x.u || tx.me.u, status: 'running', attempt: x.att || 1, seq: 1 + step, step, model: x.model || null, pay: x.pay == null ? null : x.pay, createdAt: tx.now, paused: true });
      },
      /* another member's save (step 9): the version goes up by one, as when they save in the editor */
      /* base: a page without a stored document: its author and history as the page shows them (TODO(fixtures)) */
      savePage: (sid, index, { by, title, text, base }) => { const [, pg] = pageAt(tx, sid, index); writePage(tx, sid, index, title || pg[0], text, by, base); },
      saveSkill: (sid, index, { name, prompt }) => { const row = (tx.mapGet('skills', sid) || [])[index]; writeSkill(tx, sid, index, name || row.name, prompt); },
      saveRules: (sid, rules, by) => writeRules(tx, sid, rules, by),
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
      return out(200, { changes: changesBetween(before, snapshot(data)) });
    }

    /* a procedure that changes memberships, roles or a space's visibility also changes what the caller
       reads: its answer adds the records that came into view or went out of it (merged into its changes) */
    function mergeChanges(changes, more) {
      for (const [k, ch] of Object.entries(more)) {
        const c = C[k], mine = changes[k];
        if (!mine) { changes[k] = ch; continue; }
        if (c.kind === 'value') continue;
        if (c.kind === 'map') {
          for (const [key, v] of Object.entries(ch.put)) if (!(key in mine.put)) mine.put[key] = v;
          for (const key of ch.del) if (!(key in mine.put) && !mine.del.includes(key)) mine.del.push(key);
          continue;
        }
        const has = new Set(mine.put.map(x => String(x[c.id])));
        for (const x of ch.put) if (!has.has(String(x[c.id]))) mine.put.push(x);
        for (const x of ch.del) if (!has.has(x) && !mine.del.includes(x)) mine.del.push(x);
        if (ch.order) mine.order = ch.order;
      }
      return changes;
    }

    /* caller: ME, or GUEST for a request with X-Session-Auth: out */
    /* ---- 6a. jobs and the event stream (step 7) ----
       Runs. A procedure that starts an ask writes a run record (runs, "<thread>:<node>", status queued); after
       every commit reconcile() gives each run a timer. A queued run starts at once: the job checks again, under
       step 5's rules, that the person who asked can still read the space, that a key that pays is theirs and
       that the sources the ask is about are readable to them (else the run fails: access); then it is running
       (research.run.started). Every jobMs / 4 it moves to the next progress step and commits that step's turn
       (research.turn.committed, a tool call; no text is streamed); after the last step it finishes: it writes
       the answer (SessionJobs.answer), its sources, the topic, the run state or the failure, the follow-up or
       ask-tree node, the notification and the charge (TODO(limits) stub), removes the run record, and emits
       research.run.finished, research.node.updated (with the changed records) and notification.requested.
       Each job step is a server transaction (all or nothing); seq counts the run's events.
       A job checks its run record each time: a run that was stopped, retried (a new attempt) or whose thread is
       gone is not moved on. Run records are stored with the database, so runs resume after a reload; with
       resumeJobs false (dev config) they fail as interrupted instead. A thread or ask that is running without a
       run record fails as interrupted when the backend starts.
       Checks. A key check (apiKeys.create with check, apiKeys.replace, apiKeys.check) and a domain check
       (spaces.verifyDomain) finish after checkMs: the key gets the provider's verdict (TODO(limits) stub event
       apiKeys.updated, mock only: the real app has no API keys), the space's dom becomes ok or failed
       (workspace.updated: spaces replace workspaces).
       Dev: /api/dev/config { jobs: 'paused' } holds every job until { jobs: 'run' }; a run record with
       paused: true (a Screen entry's scenario) is held on its own; failNextRun makes the next thread ask that
       finishes fail (tokens, key or rate). A scenario or a reset ends the jobs in progress, as it replaces the data.
       Events. GET /api/rpc/events.subscribe, opened with EventSource (patched below), is one connection: it
       gets connection.ready { connectionId } first, then SessionEvent objects { type, payload, timestamp }
       (web/docs/03-api-and-events.md §3), each after the configured latency, in order. The mock has one
       person, so a connection is the signed-in person's (the page opens one only while signed in). Run events
       reach it only when they may read the node the run answers: readScope's readsRun (the thread for its ask,
       the ask tree for the others), the predicate GET uses; their changes are what they may read (as a
       procedure's). Notifications reach only their recipient. */
    const J = window.SessionJobs;
    const timers = new Map();         /* run key, or "check:<kind>:<id>" → { h, ver } */
    let checks = [];                  /* checks in progress: [kind, id, due (ms, real time), { why }] */
    const conns = new Set();          /* open event streams */
    let connIds = 0, outDue = 0, outPending = 0;
    const evLog = window.__mockEventLog = [];   /* the newest events emitted: { n (counts every event), type, nodeId, seq, conns (connections it went to), changes (the collections it carried) } */
    let evN = 0;
    const stepMs = () => Math.max(0, +cfg.jobMs || 0) / J.STEPS;
    /* a view of a transaction's data for readScope */
    const txData = tx => new Proxy({}, { get: (_, k) => typeof k === 'string' ? tx.get(k) : undefined });
    function reconcile() {
      const d = db0(), want = new Map();
      if (cfg.jobs !== 'paused') {
        for (const [k, r] of Object.entries(d.runs || {})) if (!r.paused) want.set(k, { ver: `${r.status}:${r.step}:${r.attempt}`, ms: r.status === 'queued' ? 0 : stepMs(), fn: () => tick(k) });
        for (const [kind, id, due] of checks) want.set(`check:${kind}:${id}`, { ver: String(due), ms: Math.max(0, due - Date.now()), fn: () => finishCheck(kind, id) });
      }
      for (const [k, x] of timers) { const w = want.get(k); if (!w || w.ver !== x.ver) { clearTimeout(x.h); timers.delete(k); } }
      for (const [k, w] of want) if (!timers.has(k)) timers.set(k, { ver: w.ver, h: setTimeout(() => { timers.delete(k); w.fn(); }, w.ms) });
    }
    const addChecks = list => { if (!list.length) return; list.forEach(([kind, id, o]) => { checks = checks.filter(c => !(c[0] === kind && c[1] === id)); checks.push([kind, id, Date.now() + (+cfg.checkMs || 0), o || {}]); }); save(); };
    /* a job's change: one server transaction; then its events and checks */
    function serverTx(fn) {
      const d = db0(), tx = transaction(d, ME);
      let changes;
      try { fn(tx); changes = tx.commit(); }
      catch (e) { tx.abort(); fail(`a job failed: ${e && e.stack || e}`); return null; }
      publish(tx.events, changes); addChecks(tx.jobs);
      return changes;
    }
    /* events a transaction queued (tx.emit), to the connections that may have them */
    function publish(list, changes) {
      if (!list.length) return;
      const sc = scopeFor(db0(), ME);
      for (const e of list) {
        if (e.run && !sc.readsRun(e.run)) continue;
        if (e.to && e.to !== me.u) continue;
        const payload = { ...e.payload };
        if (e.changes) payload.changes = Object.fromEntries(Object.entries(changes || {}).filter(([k]) => e.changes === 'notifs' ? k === 'notifs' : k !== 'notifs'));
        if (e.fill) e.fill(payload, changes || {});
        emit(e.type, payload);
      }
    }
    function emit(type, payload, only) {
      const ev = { type, payload, timestamp: Date.now() };
      evLog.push({ n: ++evN, type, nodeId: payload.nodeId || (payload.node && payload.node.id) || null, seq: payload.seq == null ? null : payload.seq, conns: only ? 1 : conns.size, changes: Object.keys(payload.changes || {}) });
      if (evLog.length > 400) evLog.splice(0, evLog.length - 400);
      for (const c of only ? [only] : conns) deliver(c, ev);
    }
    /* in order, after the latency */
    function deliver(c, ev) {
      const now = Date.now(); outDue = Math.max(outDue, now + cfg.latency); outPending++;
      setTimeout(() => { outPending--; if (c.readyState === 1) c._message(enc(ev)); }, outDue - now);
    }
    const nodeView = (r, status, extra) => ({ id: runKey(r.th, r.node), treeId: r.th, status, ...(extra || {}) });
    /* the thread (node r) or the ask a run answers; null when it is gone */
    const runTarget = (tx, r) => {
      const p = tx.find('posts', r.th); if (!p || p.gone || p.k !== 'ask') return null;
      if (r.node === 'r') return p.del ? null : p;
      const n = askOf(tx, p.id, r.node); return n && !n.del ? n : null;
    };
    /* the checks before a run starts (step 5's rules): null, or why it fails */
    function startChecks(tx, r, p) {
      const s = tx.find('spaces', p.s);
      if (!s || readsThread(tx, p) !== true) return 'access';
      if (ownPayer(tx, r.pay) !== true) return 'access';
      if (r.node === 'r' && p.about) {
        const sc = readScope(txData(tx), true, cfg.readRules, me);
        for (const id of p.about.its || [p.about.it]) { const m = tx.find('media', id) || tx.find('miAdded', id); if (m && !sc.list('media', m)) return 'access'; }
      }
      return null;
    }
    /* the notification of a finished ask, to the person who asked (the mock has one person: only theirs exist) */
    function notify(tx, p, type) {
      if (p.u !== me.u || readsThread(tx, p) !== true) return;
      const id = tx.id(), s = tx.find('spaces', p.s), ok = type === 'answer_ready';
      tx.put('notifs', { id, type, thread: p.id, read: false }, 'start');
      tx.emit({ type: 'notification.requested', to: p.u, changes: 'notifs', payload: { id, title: ok ? 'Your answer is ready' : 'Your answer failed', body: p.t || p.q, tone: ok ? 'success' : 'error', timeoutMs: 6000, createdAt: Date.parse(tx.now), href: `/s/${s.name}/t/${p.id}`, kind: 'runFinished', treeId: p.id } });
    }
    /* a run ends without an answer: why is a RunFailure reason; o: used (tokens charged), pay, sum */
    function endRun(tx, key, r, p, status, why, o = {}) {
      if (r.node === 'r') {
        const wait = why === 'rate' ? 20 : 0;
        if (!tx.mapGet('fu', p.id)) tx.mapPut('fu', p.id, []);
        tx.edit('posts', p.id, x => { x.running = false; x.tok = o.used || 0; x.pay = o.pay || p.pay || null; x.sum = o.sum || J.FAIL_SUM[why](); x.fail = { why, ...(wait ? { at: Date.now() + wait * 1e3 } : {}) }; });
      } else editAsk(tx, p.id, r.node, y => { y.running = false; y.html = ''; y.tok = o.used || 0; if (o.pay !== undefined) y.pay = o.pay; y.fail = { why }; }, f => { f.a = J.FAIL_SUM[why](); delete f.html; });
      tx.mapDel('runs', key);
      runEnded(tx, r, status, why);
      if (r.node === 'r' && why !== 'stopped') notify(tx, p, 'answer_failed');
    }
    /* one step of a run's job; the run record says which */
    function tick(key) {
      const r0 = (db0().runs || {})[key];
      if (!r0 || r0.paused || cfg.jobs === 'paused') return;
      serverTx(tx => {
        const r = tx.mapGet('runs', key), p = tx.find('posts', r.th), n = runTarget(tx, r);
        if (!n) { tx.mapDel('runs', key); return; }
        if (r.status === 'queued') {
          const why = startChecks(tx, r, p);
          if (why) return endRun(tx, key, r, p, 'failed', why);
          const r2 = { ...r, status: 'running', seq: r.seq + 1 };
          tx.mapPut('runs', key, r2);
          tx.emit({ type: 'research.run.started', run: r2, payload: { nodeId: key, attempt: r2.attempt, seq: r2.seq, model: r2.model || null } });
          tx.emit({ type: 'research.node.updated', run: r2, changes: true, payload: { node: nodeView(r2, 'running') } });
          return;
        }
        if (r.step < J.STEPS - 1) {
          const [name, input] = J.STEP_TOOLS[r.step], r2 = { ...r, step: r.step + 1, seq: r.seq + 1 };
          tx.mapPut('runs', key, r2);
          tx.emit({ type: 'research.turn.committed', run: r2, payload: { nodeId: key, seq: r2.seq, turn: { id: `${key}:${r.attempt}:${r.step}`, agentId: key, role: 'assistant', blocks: [{ type: 'toolUse', id: null, name, input: input(n.q, p.s) }], sourceIndex: r.step, timestamp: Date.now() } } });
          return;
        }
        finishRun(tx, key, r, p, n);
      });
      reconcile();
    }
    /* the last step: the answer, or a failure */
    function finishRun(tx, key, r, p, n) {
      const g = tx.get;
      if (r.node === 'r') {
        if (cfg.failNextRun) { const why = cfg.failNextRun; cfg.failNextRun = null; return endRun(tx, key, r, p, 'failed', why); }
        const tok = J.answerTok(p);
        let pay = p.pay; if (!J.src(g, pay)) { const x = J.payer(g); pay = x.ok ? x.id : null; }
        const s = J.src(g, pay);
        /* the payer ran out while the agent worked: stop, charge what was left, and say why */
        if (!s || s.left < tok) { const used = s ? Math.min(s.left, tok) : 0; charge(tx, pay, used, p.s); return endRun(tx, key, r, p, 'failed', 'tokens', { used, pay, sum: J.stopSum(s) }); }
        const a = J.answer(g, p), sp0 = tx.find('spaces', p.s);
        tx.mapPut('rich', p.id, a.rich); tx.mapPut('srcd', p.id, a.srcd);
        if (!tx.mapGet('fu', p.id)) tx.mapPut('fu', p.id, []);
        tx.edit('posts', p.id, x => {
          x.running = false; x.tok = tok; x.pay = pay; x.sum = a.sum; delete x.fail;
          if (sp0.faq && !x.topic) { x.topic = J.topic(g, sp0, x.q); x.topicBy = x.topic ? 'agent' : null; }
        });
        charge(tx, pay, tok, p.s);
      } else {
        const { html, tok } = J.nodeAnswer(n);
        let pay = n.pay; if (pay == null) { const x = J.payer(g); pay = x.ok ? x.id : null; }
        const s = J.src(g, pay);
        if (!s || s.left < tok) { const used = s ? Math.min(s.left, tok) : 0; charge(tx, pay, used, p.s); return endRun(tx, key, r, p, 'failed', 'tokens', { used, pay }); }
        editAsk(tx, p.id, r.node, y => { y.running = false; y.tok = tok; if (y.fu == null) y.html = html; y.pay = pay; delete y.fail; }, f => { f.html = html; f.a = J.htmlText(html); });
        charge(tx, pay, tok, p.s);
      }
      tx.mapDel('runs', key);
      runEnded(tx, r, 'complete');
      if (r.node === 'r') notify(tx, p, 'answer_ready');
    }
    function finishCheck(kind, id) {
      const c = checks.find(x => x[0] === kind && x[1] === id); if (!c) return;
      checks = checks.filter(x => x !== c); save();
      serverTx(tx => {
        if (kind === 'key') {
          const k = tx.find('userKeys', id); if (!k || k.check !== 'checking') return;
          const why = c[3].why;
          tx.edit('userKeys', id, x => { delete x.check; x.valid = !why; if (why) x.reason = why; else delete x.reason; });
          tx.emit({ type: 'apiKeys.updated', changes: true, payload: { keyId: id } });
          return;
        }
        const s = tx.find('spaces', id); if (!s || !s.dom || s.dom.state !== 'checking') return;
        const failed = J.domainFails(s.dom.domain);
        tx.edit('spaces', id, y => { y.dom = failed ? { ...y.dom, state: 'failed' } : { ...y.dom, state: 'ok', verifiedAt: tx.now }; });
        tx.emit({ type: 'workspace.updated', changes: true, payload: {}, fill: (pl, ch) => { pl.workspace = ((ch.spaces || {}).put || []).find(x => x.id === id) || null; } });
      });
      reconcile();
    }
    /* when the backend starts with a stored database: runs resume (or, with resumeJobs false, fail as
       interrupted); an ask that is running without a run record fails as interrupted */
    function recoverJobs() {
      const d = db0(), runs = d.runs || {};
      const orphan = [];
      d.posts.forEach(p => { if (p.k === 'ask' && p.running && !runs[runKey(p.id, 'r')]) orphan.push({ th: p.id, node: 'r', u: p.u, attempt: p.att || 1, seq: 0, step: 0 }); });
      Object.entries(d.qtd || {}).forEach(([th, t]) => (t.nodes || []).forEach(n => { if (n.running && !runs[runKey(th, n.id)]) orphan.push({ th, node: n.id, u: n.u, attempt: n.att || 1, seq: 0, step: 0 }); }));
      const stop = cfg.resumeJobs === false ? Object.values(runs).filter(r => !r.paused) : [];
      if (!orphan.length && !stop.length) return;
      serverTx(tx => {
        for (const r of [...orphan, ...stop]) {
          const p = tx.find('posts', r.th);
          if (!p || !runTarget(tx, r)) { tx.mapDel('runs', runKey(r.th, r.node)); continue; }
          endRun(tx, runKey(r.th, r.node), r, p, 'failed', 'interrupted');
        }
      });
    }

    /* the records [collection, key or id] as the caller reads them now, in the shape of a procedure's changes */
    function readsNow(d, caller, refs) {
      const sc = scopeFor(d, caller), changes = {};
      for (const [k, key] of refs) {
        const c = C[k];
        if (c.kind === 'map') { const ch = changes[k] = changes[k] || { put: {}, del: [] }, v = key in d[k] ? sc.map(k, key, d[k][key]) : undefined; if (v !== undefined) ch.put[key] = v; else ch.del.push(key); continue; }
        const ch = changes[k] = changes[k] || { put: [], del: [] }, x = d[k].find(y => String(y[c.id]) === String(key)), r = x && sc.list(k, x);
        if (r) ch.put.push(viewOne(k, r, d)); else ch.del.push(key);
      }
      return changes;
    }
    function handle(method, url, body, origin, caller = ME) {
      const [path, qs] = url.split('?');
      const hits = matchPath(path);
      if (!hits.length) { fail(`no API entry for ${method} ${path}`); return { res: err('NOT_FOUND', 'The server has no address like this.') }; }
      const hit = hits.find(h => h.r.method === method);
      if (!hit) {
        /* a collection write: collections have no write rows (step 7) */
        if (method !== 'GET' && hits.some(h => h.r.coll)) fail(`no collection write ${method} ${path}${origin ? ` (from ${origin})` : ''}: a person's action is a procedure, a run's result a job's, and a Screen entry's data a scenario`);
        return { res: err('METHOD_NOT_SUPPORTED') };
      }
      const { r, id } = hit;
      if (r.dev) {
        if (r.op === 'dev-reset') { data = seedData(); ids = 0; checks = []; save(); reconcile(); return { res: out(204) }; }
        if (r.op === 'dev-scenario') { checks = []; const res = scenario(body); reconcile(); return { res }; }
        if (method === 'PUT') {
          if (!body || typeof body !== 'object') return { res: err('BAD_REQUEST') };
          if (body.failCode && !CODES[body.failCode]) return { res: err('BAD_REQUEST', undefined, { issues: ['failCode: expected one of ' + Object.keys(CODES).join(', ')] }) };
          if (body.failOn && !CODES[body.failOn.code]) return { res: err('BAD_REQUEST', undefined, { issues: ['failOn.code: expected one of ' + Object.keys(CODES).join(', ')] }) };
          if (body.now !== undefined && check(t.iso, body.now).length) return { res: err('BAD_REQUEST', undefined, { issues: ['now: expected an ISO time such as 2026-11-16T10:00:00Z'] }) };
          if (body.readRules !== undefined && (!body.readRules || typeof body.readRules !== 'object' || Object.entries(body.readRules).some(([k, v]) => !(k in READ_RULES) || typeof v !== 'boolean'))) return { res: err('BAD_REQUEST', undefined, { issues: ['readRules: expected { ' + Object.keys(READ_RULES).map(k => k + '?: boolean').join(', ') + ' }'] }) };
          const jobIssues = [
            body.jobs !== undefined && !['run', 'paused'].includes(body.jobs) && 'jobs: expected "run" | "paused"',
            ...['jobMs', 'checkMs'].map(k => body[k] !== undefined && !(typeof body[k] === 'number' && body[k] >= 0) && `${k}: expected a number of ms`),
            body.failNextRun !== undefined && body.failNextRun !== null && !['tokens', 'key', 'rate'].includes(body.failNextRun) && 'failNextRun: expected null | "tokens" | "key" | "rate"',
            body.resumeJobs !== undefined && typeof body.resumeJobs !== 'boolean' && 'resumeJobs: expected boolean',
            body.pageSize !== undefined && body.pageSize !== null && !(Number.isInteger(body.pageSize) && body.pageSize >= 1 && body.pageSize <= PAGE_MAX) && `pageSize: expected null or 1 to ${PAGE_MAX}`,
          ].filter(Boolean);
          if (jobIssues.length) return { res: err('BAD_REQUEST', undefined, { issues: jobIssues }) };
          Object.assign(cfg, body, body.readRules ? { readRules: { ...cfg.readRules, ...body.readRules } } : {});
          if (body.resumeJobs !== undefined) save();
          reconcile();
        }
        return { res: out(200, cfg) };
      }
      const f = forced(method, path);
      if (f) return { res: err(f), forced: true };
      /* a signed-out caller: only the guest rows */
      if (!caller.signedIn && r.who !== 'guest') return { res: err('UNAUTHORIZED') };
      const d = db0();
      if (r.op === 'me') return { res: out(200, { u: me.u, name: d.profile.name, bio: d.profile.bio, x: me.x, createdAt: me.createdAt }) };
      if (r.op === 'events') return { res: err('BAD_REQUEST', 'Open the event stream with EventSource.') };
      if (r.op === 'query') {
        /* a paged list or another query (section 5c): the input is the query string's input, URL-encoded JSON */
        const Q = QUERIES[r.trpc]; let input = {};
        const raw = new URLSearchParams(qs || '').get('input');
        if (raw != null) { try { input = dec(raw); } catch (e) { return { res: bad([{ path: 'input', expected: 'JSON' }]) }; } }
        const issues = check(Q.inputSchema, input, 'input');
        if (input && input.limit !== undefined && Number.isInteger(input.limit) && (input.limit < 1 || input.limit > PAGE_MAX)) issues.push({ path: 'input.limit', expected: `1 to ${PAGE_MAX}` });
        if (issues.length) return { res: bad(issues) };
        const sc = scopeFor(d, caller), g = k => d[k];
        const ctx = { d, sc, me, signedIn: caller.signedIn, now: cfg.now, all: k => viewAll(k, d, sc), reads: s => readsSpace(g, caller.signedIn, s) };
        try {
          if (Q.run) return { res: out(200, Q.run(ctx, input)) };
          return { res: out(200, pageOf(Q.rows(ctx, input), Q.key, input, input.limit || cfg.pageSize || Q.limit || PAGE_LIMIT)) };
        } catch (e) {
          if (e && e.rpcCode) return { res: err(e.rpcCode, e.message, e.issues ? { issues: e.issues } : {}) };
          throw e;
        }
      }
      if (r.op === 'rpc') {
        const P = PROCS[r.trpc], input = body === undefined ? {} : body;
        const issues = check(P.input, input, 'input');
        if (issues.length) return { res: bad(issues) };
        const scoped = (P.writes || []).some(k => SCOPE_INPUTS.includes(k)), before = scoped ? snapshot(d, caller, SCOPED) : null;
        const tx = transaction(d, caller);
        try {
          authorize(tx, P, input);
          const result = P.run(tx, input);
          const changes = tx.commit();
          if (before) mergeChanges(changes, changesBetween(before, snapshot(d, caller, SCOPED)));
          /* the events the procedure queued, its checks, and the jobs of the runs it started or ended */
          publish(tx.events, changes); addChecks(tx.jobs); reconcile();
          return { res: out(200, { result: result === undefined ? null : result, changes }) };
        } catch (e) {
          tx.abort();
          if (e && e.rpcCode) return { res: err(e.rpcCode, e.message, Object.assign({}, e.issues ? { issues: e.issues } : {}, e.data ? { current: e.data.current, changes: readsNow(d, caller, e.data.reads || []) } : {})) };
          throw e;
        }
      }
      const k = r.coll, c = C[k], sc = scopeFor(d, caller);
      const pos = cur => cur.findIndex(x => String(x[c.id]) === id);
      switch (r.op) {
        case 'list': return { res: out(200, viewAll(k, d, sc)) };
        case 'get': {
          /* a record the caller may not read is NOT_FOUND, as a missing one */
          const cur = d[k];
          if (c.kind === 'map') { const v = cur[id] === undefined ? undefined : sc.map(k, id, cur[id]); return { res: v === undefined ? err('NOT_FOUND') : out(200, v) }; }
          const i = pos(cur), x = i < 0 ? null : sc.list(k, cur[i]);
          return { res: !x ? err('NOT_FOUND') : out(200, viewOne(k, x, d)) };
        }
        case 'replace': {
          const issues = checkWhole(k, body, d);
          if (issues.length) return { res: bad(issues) };
          if (c.kind === 'list') {
            const cur = d[k];
            d[k] = body.map(x => storeRecord(k, x, cur.find(y => String(y[c.id]) === String(x[c.id]))));
          } else if (c.kind === 'map') { Object.values(body).forEach(v => stampValue(k, v)); d[k] = body; }
          else d[k] = stampValue(k, body);
          save(); return { res: out(200, viewAll(k, d, scopeFor(d, caller))) };
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

    /* the event stream: EventSource on /api/* is a connection to this backend (section 6a) */
    const RealEventSource = window.EventSource;
    class MockEventSource extends EventTarget {
      constructor(url) {
        super();
        this.url = String(url); this.withCredentials = false; this.readyState = 0;
        this.onopen = this.onmessage = this.onerror = null;
        const path = this.url.split('?')[0];
        setTimeout(() => {
          if (this.readyState === 2) return;
          if (path !== '/api/rpc/events.subscribe') { fail(`no event stream at ${path}`); this.readyState = 2; this._fire('error', new Event('error')); return; }
          this.readyState = 1; conns.add(this);
          log.push({ seq: ++seq, method: 'GET', path, status: 200, code: null, stream: true });
          this._fire('open', new Event('open'));
          emit('connection.ready', { connectionId: 'c' + (++connIds) }, this);
        }, cfg.latency);
      }
      _fire(type, ev) { this.dispatchEvent(ev); const h = this['on' + type]; if (typeof h === 'function') h.call(this, ev); }
      _message(data) { this._fire('message', new MessageEvent('message', { data })); }
      close() { this.readyState = 2; conns.delete(this); }
    }
    Object.assign(MockEventSource, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
    window.EventSource = function (url, init) { return String(url).startsWith('/api/') ? new MockEventSource(url) : new RealEventSource(url, init); };
    Object.assign(window.EventSource, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });

    const realFetch = window.fetch;
    window.fetch = (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.startsWith('/api/')) return realFetch.call(window, input, init);
      const method = (init.method || 'GET').toUpperCase();
      return new Promise(resolve => setTimeout(() => {
        let res, forcedErr = false;
        /* X-Session-Origin: who sent a request, for the log (scenario: a Screen entry's set-up; user: a collection write from the page, which is a bug);
           X-Session-Auth: out, a request without a session (signed out) */
        const h = init.headers || {}, hd = n => typeof h.get === 'function' ? h.get(n) : h[n], origin = hd('X-Session-Origin'), caller = hd('X-Session-Auth') === 'out' ? GUEST : ME;
        try { const body = init.body ? dec(init.body) : undefined; ({ res, forced: forcedErr } = handle(method, url, body, origin, caller)); }
        catch (e) { console.error('[mock api]', e); res = err('INTERNAL_SERVER_ERROR'); }
        const entry = { seq: ++seq, method, path: url.split('?')[0], status: res.status, code: null };
        if (origin) entry.origin = origin;
        if (!caller.signedIn) entry.signedOut = true;
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
    /* the jobs of a stored database (a reload) resume */
    db0(); if (stored) recoverJobs(); reconcile();
    return {
      cfg,
      checkClient,
      wipe: () => { data = null; ids = 0; checks = []; timers.forEach(x => clearTimeout(x.h)); timers.clear(); try { localStorage.removeItem(storageKey); } catch (e) {} },
      restore: () => { window.fetch = realFetch; window.EventSource = RealEventSource; conns.forEach(c => c.close()); timers.forEach(x => clearTimeout(x.h)); timers.clear(); },
      /* events scheduled for delivery and not delivered yet (a test waits for 0, as for requests) */
      eventsPending: () => outPending,
      /* the seed data as GET returns it (derived fields included), without touching the database: the page
         reads it while it starts */
      seedView: () => { const d = seedData(), sc = scopeFor(d, ME); return dec(enc(Object.fromEntries(Object.keys(C).filter(k => k in d || C[k].computed).map(k => [k, viewAll(k, d, sc)])))); },
    };
  }

  window.SessionMockApi = { enc, dec, CODES, STATUS, API, PROCEDURES: PROCS, COLLECTIONS: C, SCHEMAS: S, NOTIFICATION_TYPES, READ_RULES, check, describe, ulid, createBackend };
})();
