/* Session fixtures: the seed data of the mock backend for session-web-spaces.html.

   Loaded with a plain <script src> before session-web-spaces-mock-api.js. Pure data: no HTML built by the
   page, no icons, no calls into page code. The mock backend copies `data` into its database the first time
   it starts (and on POST /api/dev/reset); the page reads it only for the Screen entries' baselines.
   Sets are written in the wire form { $set: [...] }. */
window.SessionFixtures = {
  data: {
    spaces: [
      {
        id: 'public',
        name: 'public',
        title: 'Public',
        av: 1,
        byok: 'sol',
        members: 4812,
        online: 213,
        posts: 1290,
        used: 1.21e6,
        budget: 8e6,
        created: 'Sep 2026',
        desc: 'The public chat. Anyone with an X account can post here. An invite system is coming to prevent abuse; signups are open during the alpha.',
        rules: [
          'Ask questions you want an agent to research, or post plainly.',
          'Branch an existing thread instead of re-asking the same question.',
          'No personal data about private individuals.',
          'Keep asks scoped: the space shares one monthly token budget.',
        ],
        pages: [['Getting started with asks', '3d'], ['How the token budget works', '1w'], ['Alpha known issues', '2d'], ['Invite system plan', '5d']],
        mods: [['sol', 'admin'], ['hal_b', 'mod']],
        pct: 0.15125,
      },
      {
        id: 'scifi',
        name: 'sci-fi',
        title: 'Science fiction',
        av: 2,
        members: 1204,
        online: 41,
        posts: 388,
        used: 4.96e6,
        budget: 8e6,
        created: 'Sep 2026',
        desc: 'Reading notes and research on science fiction: sources, influences, and what it predicted.',
        rules: ['Mark spoilers in titles with [spoilers].', 'Cite editions and page numbers when quoting.', 'Reading-group threads are pinned by mods.'],
        pages: [['Reading group schedule', '1d'], ['Canon starter list', '2w'], ['Spoiler policy', '1mo']],
        mods: [['tomasz', 'admin'], ['ines.v', 'mod']],
        pct: 0.62,
      },
      {
        id: 'markets',
        name: 'markets',
        title: 'Markets',
        av: 4,
        byok: 'oduya',
        members: 2390,
        online: 96,
        posts: 702,
        used: 7.97e6,
        budget: 8e6,
        created: 'Sep 2026',
        desc: 'Market structure, prediction markets, and economic data. No trading tips.',
        rules: [
          'No price predictions or trading advice.',
          'Link primary data sources in asks.',
          'Budget is tight this month; prefer follow-ups to new asks.',
        ],
        pages: [['Data source index', '4d'], ['Budget status, November', '1d']],
        mods: [['oduya', 'admin'], ['hal_b', 'mod']],
        pct: 0.99625,
      },
      {
        id: 'ml',
        name: 'ml-papers',
        title: 'ML papers',
        av: 5,
        byok: 'mira_k',
        members: 3105,
        online: 188,
        posts: 940,
        used: 5.84e6,
        budget: 8e6,
        created: 'Sep 2026',
        desc: 'Paper summaries, replications, and arguments about benchmarks.',
        rules: ['Link the arXiv ID in the first line.', 'Say which results you checked yourself.'],
        pages: [['Reading list', '2d'], ['Benchmark glossary', '3w']],
        mods: [['mira_k', 'admin']],
        pct: 0.73,
      },
      {
        id: 'bio',
        name: 'biology',
        title: 'Biology',
        av: 3,
        members: 980,
        online: 22,
        posts: 251,
        used: 3.28e6,
        budget: 8e6,
        created: 'Oct 2026',
        desc: 'Molecular and organismal biology questions, from mechanisms to field notes.',
        rules: ['Medical questions about yourself go to a doctor, not this space.', 'Cite papers by DOI.'],
        pages: [['Recommended databases', '1w']],
        mods: [['lettie', 'admin']],
        pct: 0.41,
      },
      {
        id: 'history',
        name: 'history',
        title: 'History',
        av: 6,
        members: 1520,
        online: 37,
        posts: 410,
        used: 2.16e6,
        budget: 8e6,
        created: 'Oct 2026',
        desc: 'Questions about how things actually happened, with sources.',
        rules: ['Primary sources over summaries where possible.', 'Date ranges in titles help others search.'],
        pages: [['Archive access guide', '2w']],
        mods: [['tomasz', 'admin']],
        pct: 0.27,
      },
      {
        id: 'climate',
        name: 'climate',
        title: 'Climate',
        av: 3,
        members: 860,
        online: 18,
        posts: 199,
        used: 4.32e6,
        budget: 8e6,
        created: 'Oct 2026',
        desc: 'Energy systems, emissions data, and adaptation.',
        rules: ['Show units and baselines.'],
        pages: [['Datasets we trust', '6d']],
        mods: [['sol', 'admin']],
        pct: 0.54,
      },
      {
        id: 'urbanism',
        name: 'urbanism',
        title: 'Urbanism',
        av: 1,
        members: 412,
        online: 9,
        posts: 64,
        used: 2.64e6,
        budget: 8e6,
        created: 'Nov 2026',
        desc: 'Transit, zoning, housing, and how cities change.',
        rules: ['Name the city in the title.'],
        pages: [['Start here', '3h']],
        mods: [['sol', 'admin']],
        pct: 0.33,
      },
      {
        id: 'math',
        name: 'math',
        title: 'Math',
        av: 5,
        members: 1730,
        online: 54,
        posts: 520,
        used: 7.2e5,
        budget: 8e6,
        created: 'Sep 2026',
        desc: 'Proofs, expositions, and where to read more.',
        rules: ['Use $…$ for inline math.'],
        pages: [['Expository writing list', '1d']],
        mods: [['lettie', 'admin']],
        pct: 0.09,
        byok: 'ines.v',
        key: 'k1',
      },
      {
        id: 'replication',
        name: 'replication-club',
        title: 'Replication club',
        av: 2,
        byok: 'lettie',
        members: 214,
        online: 12,
        posts: 142,
        used: 2.9e6,
        budget: 6e6,
        created: 'Oct 2026',
        vis: 'listed',
        policy: 'request',
        invite: 'mods',
        qs: [
          { q: 'Which result would you like to replicate or check first?', req: true },
          { q: 'Link to earlier replication or analysis work', req: false },
        ],
        desc: 'Members re-run published results and report what held up. Closed so that drafts and failed attempts can be discussed before anything is made public.',
        rules: [
          'Post a plan before you start a replication.',
          'Do not share drafts or data outside the space without the author\'s consent.',
          'Report failed replications in the same detail as successful ones.',
          'Asks use the space’s extra tokens. Keep each ask to a single result.',
        ],
        pages: [['Replication plan template', '2d'], ['Open replications', '5h'], ['Data access agreements', '1w'], ['Results log', '1d']],
        mods: [['lettie', 'admin'], ['mira_k', 'mod']],
        pct: 0.48333333333333334,
      },
      {
        id: 'northwind',
        name: 'northwind-eng',
        title: 'Northwind engineering',
        av: 5,
        members: 86,
        online: 9,
        posts: 64,
        used: 0,
        budget: 0,
        created: 'Oct 2026',
        vis: 'listed',
        policy: 'request',
        invite: 'mods',
        qs: [{ q: 'Which team are you on at Northwind?', req: true }],
        desc: 'Engineering space for Northwind staff: incident reviews, design notes and vendor research.',
        rules: ['Use your work account.', 'Customer data never goes in a thread or an ask.'],
        pages: [['On-call handbook', '3d'], ['Vendor evaluations', '2w']],
        mods: [['oduya', 'admin']],
        pct: 0,
        dom: { domain: 'northwind.io', method: 'dns', state: 'ok', verified: 'Oct 30' },
      },
      {
        id: 'grants',
        name: 'grant-review',
        title: 'Grant review panel',
        av: 6,
        byok: 'tomasz',
        members: 9,
        online: 3,
        posts: 23,
        used: 1.1e6,
        budget: 4e6,
        created: 'Nov 2026',
        vis: 'unlisted',
        policy: 'invite',
        invite: 'members',
        qs: [],
        desc: 'Working space for the 2027 open-science grant panel. Applications and scores are confidential.',
        rules: ['Do not name applicants outside this space.', 'Declare conflicts of interest before scoring.'],
        pages: [['Scoring rubric', '4d'], ['Conflict register', '1d']],
        mods: [['tomasz', 'admin']],
        pct: 0.275,
      },
      {
        id: 'ward7',
        name: 'ward-7-tenants',
        title: 'Ward 7 tenants',
        av: 4,
        members: 31,
        online: 2,
        posts: 48,
        used: 0,
        budget: 0,
        created: 'Oct 2026',
        vis: 'unlisted',
        policy: 'invite',
        invite: 'members',
        qs: [],
        desc: 'Tenants\' association for buildings in Ward 7: repairs, rent notices and meeting notes.',
        rules: ['Do not post other tenants\' unit numbers.'],
        pages: [['Meeting notes', '6d']],
        mods: [['jun.park', 'admin']],
        pct: 0,
      },
      {
        id: 'sablefield',
        name: 'sablefield',
        title: 'Sablefield',
        av: 5,
        byok: 'maya.r',
        members: 6120,
        online: 150,
        posts: 1284,
        used: 7.9e6,
        budget: 2e7,
        created: 'Oct 2026',
        desc: 'Questions and answers about Sablefield, the hosted Postgres-compatible database with sync to client devices. Run by the Sablefield developer relations team.',
        rules: [
          'Questions and answers are public. Do not include keys, connection strings or customer data.',
          'Account-specific questions go to Sablefield support.',
          'Search before you ask: existing answers appear under the box as you type.',
        ],
        pages: [['Getting started guide', '2d'], ['Release notes digest', '1d'], ['How topics are organized', '1w']],
        mods: [['maya.r', 'owner'], ['devin_o', 'admin'], ['ines.v', 'admin'], ['tove', 'mod']],
        faq: true,
        postsOff: true,
        plain: true,
        dom: { domain: 'sablefield.dev', method: 'dns', state: 'ok', verified: 'Nov 2' },
        topics: [
          ['start', 'Getting started'],
          ['sync', 'Sync rules'],
          ['replicas', 'Replicas and regions'],
          ['auth', 'Auth and keys'],
          ['sdk', 'Client SDKs'],
          ['billing', 'Plans and billing'],
          ['migr', 'Migrations'],
          ['sec', 'Security and compliance'],
        ],
        pct: 0.395,
      },
    ],
    posts: [
      {
        s: 'public',
        u: 'ines.v',
        mine: true,
        k: 'ask',
        t: 'Intention marketplaces in science fiction',
        q: 'I\'d like to explore different kinds of intention marketplaces or intention networks in science fiction and sci-fi adjacent writing. Can you do a broad scan for examples and give me a list?',
        sum: 'Grouped by mechanism: reputation ledgers (Whuffie in Down and Out in the Magic Kingdom), prediction and decision markets, attention auctions, and agent-brokered matching. 31 works, 1953 to 2024.',
        r: 12,
        tok: 1.84e5,
        age: '4m',
        likes: 26,
      },
      {
        s: 'public',
        u: 'hal_b',
        k: 'post',
        q: 'Is anyone else seeing the follow-up count lag on long threads? Mine says 3 but the thread has 7 branches.',
        r: 2,
        tok: 0,
        age: '18m',
        likes: 24,
      },
      {
        s: 'public',
        u: 'jun.park',
        k: 'ask',
        t: 'How Sweden\'s 1967 switch to right-hand traffic worked',
        q: 'Walk through the logistics of Dagen H: signage, the overnight changeover, and accident statistics before and after.',
        sum: 'Planned over four years; non-essential traffic stopped 01:00 to 06:00 on 3 Sep 1967. Accidents fell for about two years, then returned to the prior trend.',
        r: 6,
        tok: 9.6e4,
        age: '1h',
        likes: 18,
      },
      {
        s: 'public',
        u: 'oduya',
        k: 'ask',
        t: 'Public datasets for container-ship port dwell times',
        q: 'Which public datasets track how long container ships wait at port, and how far back do they go?',
        sum: 'Five sources compared on coverage, latency and licence. Only two give vessel-level data before 2019.',
        r: 3,
        tok: 7.2e4,
        age: '2h',
        likes: 14,
      },
      {
        s: 'public',
        u: 'sol',
        k: 'post',
        q: 'Opened #urbanism for transit and zoning threads. The wiki has a short start-here page.',
        r: 9,
        tok: 0,
        age: '3h',
        likes: 18,
      },
      {
        s: 'public',
        u: 'lettie',
        k: 'ask',
        t: 'Banach–Tarski, stated carefully',
        q: 'Explain the Banach–Tarski paradox and exactly where the axiom of choice enters the proof.',
        sum: 'The free group on two generators acts on the sphere; choice picks one point from each orbit. Without choice the pieces cannot be shown to exist.',
        r: 4,
        tok: 1.4e5,
        age: '5h',
        likes: 4,
      },
      {
        s: 'scifi',
        u: 'mira_k',
        k: 'ask',
        t: 'Novels where AI agents negotiate for their owners',
        q: 'Find novels and short stories where personal AI agents negotiate, bargain or trade on behalf of the people they work for.',
        sum: 'Shortlist of 14, from Stross and Doctorow to recent short fiction. Most stories treat the agent as a fiduciary that defects.',
        r: 8,
        tok: 1.22e5,
        age: '40m',
        likes: 35,
      },
      {
        s: 'scifi',
        u: 'tomasz',
        k: 'post',
        q: 'Reading group: Accelerando chapter 3 on Thursday. Put your notes in this thread.',
        r: 15,
        tok: 0,
        age: '2h',
        likes: 7,
      },
      {
        s: 'scifi',
        u: 'ines.v',
        mine: true,
        k: 'ask',
        t: 'What 1960s SF got right about video calls',
        q: 'Compare depictions of video telephony in 1960s science fiction with how video calls are used now.',
        sum: 'Most stories predicted the hardware and missed the etiquette: nobody wanted to be seen by default.',
        r: 5,
        tok: 8.8e4,
        age: '6h',
        likes: 5,
      },
      {
        s: 'scifi',
        u: 'jun.park',
        k: 'ask',
        t: '\'Metaverse\' from Snow Crash to now',
        q: 'Trace how the word metaverse changed meaning between 1992 and today.',
        sum: 'Three shifts: a fictional street (1992), a virtual-world industry term (2006), a corporate strategy word (2021).',
        r: 3,
        tok: 6.4e4,
        age: '1d',
        likes: 6,
      },
      {
        s: 'markets',
        u: 'hal_b',
        k: 'post',
        q: 'Budget is at 88% with two weeks left in the cycle. Please keep asks focused and branch existing threads where you can.',
        r: 21,
        tok: 0,
        age: '1h',
        likes: 33,
      },
      {
        s: 'markets',
        u: 'oduya',
        k: 'ask',
        t: 'Ambiguous resolution in prediction markets',
        q: 'How do prediction markets handle questions whose resolution criteria turn out to be ambiguous?',
        sum: 'Four approaches: pre-committed oracles, appeals with bonds, N/A refunds, and committee votes. Each shifts risk differently.',
        r: 7,
        tok: 1.56e5,
        age: '3h',
        likes: 11,
      },
      {
        s: 'ml',
        u: 'mira_k',
        k: 'ask',
        t: 'Test-time compute scaling, 2025 to 2026',
        q: 'Summarize the main published results on scaling test-time compute from 2025 and 2026.',
        sum: 'Gains are large on verifiable tasks and small elsewhere; most papers disagree on how to count tokens.',
        r: 11,
        tok: 2.1e5,
        age: '2h',
        likes: 5,
      },
      {
        s: 'bio',
        u: 'lettie',
        k: 'ask',
        t: 'Dsup and radiation tolerance',
        q: 'Why does the tardigrade Dsup protein protect human cells from X-ray damage?',
        sum: 'Dsup binds nucleosomes and shields DNA from hydroxyl radicals; it reduces breaks by about 40% in cultured cells.',
        r: 4,
        tok: 8e4,
        age: '5h',
        likes: 18,
      },
      {
        s: 'history',
        u: 'tomasz',
        k: 'ask',
        t: 'Contracts for medieval guild apprenticeships',
        q: 'How were apprenticeships in medieval guilds contracted, and who enforced the terms?',
        sum: 'Written indentures were common by the 14th century; guild courts enforced them, with fines and loss of mastership as penalties.',
        r: 2,
        tok: 5.8e4,
        age: '9h',
        likes: 19,
      },
      {
        s: 'climate',
        u: 'sol',
        k: 'ask',
        t: 'Heat-pump adoption: Norway vs Poland',
        q: 'Compare heat-pump adoption curves in Norway and Poland since 2010 and explain the gap.',
        sum: 'Norway passed 60% of homes; Poland grew fast from 2020 on subsidies but from a coal-heated base.',
        r: 3,
        tok: 1.01e5,
        age: '1d',
        likes: 35,
      },
      {
        s: 'urbanism',
        u: 'sol',
        k: 'ask',
        t: 'Houston\'s parking-minimum reform',
        q: 'What happened after Houston removed parking minimums in parts of downtown?',
        sum: 'More small-lot infill and conversions; the effect stayed within the reform area.',
        r: 6,
        tok: 7.7e4,
        age: '4h',
        likes: 24,
      },
      {
        s: 'math',
        u: 'lettie',
        k: 'post',
        q: 'Collecting good expository writing on category theory. Add yours to the wiki page.',
        r: 13,
        tok: 0,
        age: '1d',
        likes: 33,
      },
      {
        s: 'replication',
        u: 'mira_k',
        k: 'ask',
        t: 'Re-running a grokking result with the released code',
        q: 'Re-run the main table of the 2025 grokking-on-modular-arithmetic paper with its released code. Which numbers reproduce?',
        sum: 'Four of six settings reproduce within the reported error bars. The two largest models need about 3x the stated steps before test accuracy jumps.',
        r: 4,
        tok: 1.32e5,
        age: '25m',
        likes: 36,
        about: { it: 'r3' },
      },
      {
        s: 'replication',
        u: 'lettie',
        k: 'post',
        q: 'Plan for the multi-site ego-depletion replication is on the wiki. Comments on the analysis plan by Friday, please.',
        r: 6,
        tok: 0,
        age: '3h',
        likes: 20,
      },
      {
        s: 'replication',
        u: 'ines.v',
        mine: true,
        k: 'ask',
        t: 'Speculative decoding speed-ups on consumer GPUs',
        q: 'Check whether the speed-up reported for speculative decoding holds on consumer GPUs with the released code.',
        sum: 'It holds at batch size 1 on two of the three GPUs tested. At batch size 8 the gain falls to about half of the reported figure.',
        r: 3,
        tok: 1.18e5,
        age: '6h',
        likes: 16,
      },
      {
        s: 'replication',
        u: 'oduya',
        k: 'ask',
        t: 'Default enrolment and the revised savings data',
        q: 'Does the reported effect of default enrolment on retirement saving survive the revised survey weights?',
        sum: 'The effect keeps its sign and significance. It is about 10% smaller with the revised weights.',
        r: 2,
        tok: 9.4e4,
        age: '7h',
        likes: 22,
        about: { it: 'r2' },
      },
      {
        s: 'replication',
        u: 'hal_b',
        k: 'post',
        q: 'Failed replication write-up for the sleep-and-memory paper is in the results log. We measured about a third of the reported effect.',
        r: 9,
        tok: 0,
        age: '1d',
        likes: 31,
      },
      {
        s: 'northwind',
        u: 'oduya',
        k: 'post',
        q: 'The incident review for the Nov 12 queue backlog is up. Please read it before Thursday.',
        r: 4,
        tok: 0,
        age: '5h',
        likes: 17,
      },
      {
        s: 'northwind',
        u: 'pat.r',
        k: 'ask',
        t: 'Managed Postgres: recovery and replicas',
        q: 'Compare managed Postgres providers on point-in-time recovery limits and cross-region read replicas.',
        sum: 'Five providers compared. Recovery windows range from 7 to 35 days; two providers do not offer cross-region replicas on the smallest plans.',
        r: 2,
        tok: 8.8e4,
        age: '1d',
        likes: 18,
      },
      {
        s: 'grants',
        u: 'tomasz',
        k: 'post',
        q: 'Round 2 scores are due Monday. Use the rubric page, and record conflicts in the register before you score.',
        r: 5,
        tok: 0,
        age: '2h',
        likes: 7,
      },
      {
        s: 'grants',
        u: 'ines.v',
        mine: true,
        k: 'ask',
        t: 'Grant schemes that fund replication work',
        q: 'Summarize the published track record of grant schemes that fund replication studies: who funds them and what share of funded projects finish.',
        sum: 'Six schemes found, mostly national funders and two foundations. Reported completion rates range from 70% to 90%, but only three schemes publish them.',
        r: 2,
        tok: 1.02e5,
        age: '1d',
        likes: 3,
      },
      {
        s: 'ward7',
        u: 'jun.park',
        k: 'post',
        q: 'The heating repair at 14 Alder St is scheduled for Tuesday morning.',
        r: 3,
        tok: 0,
        age: '4h',
        likes: 19,
      },
      {
        s: 'ward7',
        u: 'sol',
        k: 'ask',
        t: 'Notice for rent increases',
        q: 'How much notice does a landlord have to give before a rent increase under the current city ordinance?',
        sum: 'Ninety days for increases above 5%, sixty days otherwise. The notice has to be written and delivered in person or by mail.',
        r: 1,
        tok: 6.1e4,
        age: '2d',
        likes: 20,
      },
      {
        s: 'sablefield',
        rf: 'q1',
        u: 'jun.park',
        k: 'ask',
        q: 'Can I pin a read replica to a specific region?',
        sum: 'Yes, since 4.2: use --pin-region when you create or update a replica. Pinned replicas stay in their region during failover. Team and Enterprise plans only.',
        topic: 'replicas',
        kw: 'replica region pin pinning failover location placement',
        age: '6w',
        r: 1,
        tok: 3.8e4,
        likes: 4,
      },
      {
        s: 'sablefield',
        rf: 'q2',
        u: 'mira_k',
        k: 'ask',
        q: 'Why does a sync rule fail to deploy with E_SYNC_SCOPE?',
        sum: 'The rule’s query can return rows outside its declared scope. Filter on the scope column, for example owner_id = auth.user_id().',
        topic: 'sync',
        kw: 'sync rule error deploy scope e_sync_scope fail reject',
        age: '2mo',
        r: 2,
        tok: 45919,
        likes: 17,
      },
      {
        s: 'sablefield',
        rf: 'q3',
        u: 'hal_b',
        k: 'ask',
        q: 'What happens when a project goes over the Free plan row limit?',
        sum: 'Inserts fail with E_PLAN_LIMIT; reads, updates and deletes keep working. Owners get emails at 80% and 100% of the limit.',
        topic: 'billing',
        kw: 'free plan row limit over exceed quota insert fail rows',
        age: '3w',
        r: 2,
        tok: 53838,
        likes: 30,
      },
      {
        s: 'sablefield',
        rf: 'q4',
        u: 'lettie',
        k: 'ask',
        q: 'How do I rotate the service key without downtime?',
        sum: 'Create a second service key, deploy it, check that the old key is unused, then revoke it. Both keys work while both exist.',
        topic: 'auth',
        kw: 'rotate service key secret downtime revoke',
        age: '5w',
        r: 1,
        tok: 61757,
        likes: 43,
      },
      {
        s: 'sablefield',
        rf: 'q5',
        u: 'ines.v',
        mine: true,
        k: 'ask',
        q: 'Does the Swift SDK queue writes while the device is offline?',
        sum: 'Yes. Writes are queued locally and sent in order on reconnect.',
        topic: 'sdk',
        kw: 'swift ios offline write queue sdk conflict',
        age: '2mo',
        r: 2,
        tok: 69676,
        likes: 15,
      },
      {
        s: 'sablefield',
        rf: 'q6',
        u: 'sol',
        k: 'ask',
        q: 'How do I connect to my database with psql?',
        sum: 'Copy the connection string from Project › Connect and pass it to psql. TLS is required.',
        topic: 'start',
        kw: 'connect psql connection string tls',
        age: '2mo',
        r: 2,
        tok: 77595,
        likes: 28,
      },
      {
        s: 'sablefield',
        rf: 'q7',
        u: 'mira_k',
        k: 'ask',
        q: 'Which Postgres extensions are supported?',
        sum: 'pgvector, PostGIS, pg_trgm, uuid-ossp and 14 others. The Extensions page has the full list.',
        topic: 'start',
        kw: 'postgres extension extensions supported pgvector postgis',
        age: '2mo',
        r: 1,
        tok: 85514,
        likes: 41,
      },
      {
        s: 'sablefield',
        rf: 'q8',
        u: 'hal_b',
        k: 'ask',
        q: 'Can a sync rule join two tables?',
        sum: 'Yes, if every joined table has the scope column and the join filters on it. Otherwise the deploy fails with E_SYNC_SCOPE.',
        topic: 'sync',
        kw: 'sync rule join two tables',
        age: '5h',
        r: 2,
        tok: 41433,
        likes: 13,
      },
      {
        s: 'sablefield',
        rf: 'q9',
        u: 'oduya',
        k: 'ask',
        q: 'What does the error E_SYNC_SCOPE mean?',
        sum: 'The sync rule can return rows outside its declared scope, so the deploy is rejected.',
        topic: 'sync',
        kw: 'e_sync_scope error mean sync',
        age: '3h',
        r: 2,
        tok: 49352,
        likes: 26,
      },
      {
        s: 'sablefield',
        rf: 'q10',
        u: 'oduya',
        k: 'ask',
        q: 'How much replication lag should I expect on read replicas?',
        sum: 'Usually under 100 ms within a continent and under 400 ms between continents. The dashboard shows lag per replica.',
        topic: 'replicas',
        kw: 'replication lag replica delay latency',
        age: '1mo',
        r: 1,
        tok: 57271,
        likes: 39,
      },
      {
        s: 'sablefield',
        rf: 'q11',
        u: 'jun.park',
        k: 'ask',
        q: 'Do unused credits roll over to the next month?',
        sum: 'No. Included usage resets on the first of each month. Prepaid Enterprise credits roll over for 12 months.',
        topic: 'billing',
        kw: 'credits roll over month unused billing',
        age: '7w',
        r: 2,
        tok: 6.519e4,
        likes: 11,
      },
      {
        s: 'sablefield',
        rf: 'q12',
        u: 'lettie',
        k: 'ask',
        q: 'Can I change a project’s region after creating it?',
        sum: 'No. Create a project in the new region and copy data with sable migrate copy. Replicas can be added in other regions.',
        topic: 'replicas',
        kw: 'change project region move',
        age: '5w',
        r: 2,
        tok: 73109,
        likes: 24,
      },
      {
        s: 'sablefield',
        rf: 'q13',
        u: 'mira_k',
        k: 'ask',
        q: 'How do I run migrations in CI?',
        sum: 'Run sable migrate apply with a service key in the pipeline. It is idempotent and takes an advisory lock, so parallel jobs wait.',
        topic: 'migr',
        kw: 'migration migrations ci pipeline deploy',
        age: '6w',
        r: 1,
        tok: 81028,
        likes: 37,
      },
      {
        s: 'sablefield',
        rf: 'q14',
        u: 'tomasz',
        k: 'ask',
        q: 'Can I use my own OIDC provider for client sign-in?',
        sum: 'Yes. Add the issuer URL and audience under Auth › Providers. Claims are available in rules through auth.claims().',
        topic: 'auth',
        kw: 'oidc provider sign-in sign in auth login sso',
        age: '1d',
        r: 2,
        tok: 88947,
        likes: 9,
      },
      {
        s: 'sablefield',
        rf: 'q15',
        u: 'sol',
        k: 'ask',
        q: 'Is there a Kotlin SDK for Android?',
        sum: 'Yes. sablefield-kotlin 2.x supports Android API 26 and later, including offline writes.',
        topic: 'sdk',
        kw: 'kotlin android sdk',
        age: '7w',
        r: 2,
        tok: 44866,
        likes: 22,
      },
      {
        s: 'sablefield',
        rf: 'q16',
        u: 'jun.park',
        k: 'ask',
        q: 'Can I roll back a migration that already ran in production?',
        sum: 'Only if the migration has a down step; sable migrate rollback runs it. Data changes are not rolled back automatically.',
        topic: 'migr',
        kw: 'rollback roll back migration production undo',
        age: '1d',
        r: 1,
        tok: 52785,
        likes: 35,
      },
      {
        s: 'sablefield',
        rf: 'q17',
        u: 'hal_b',
        k: 'ask',
        q: 'Is Sablefield SOC 2 compliant?',
        sum: 'Yes. Sablefield has a SOC 2 Type II report, available under NDA from the security page. A GDPR data processing agreement is also available.',
        topic: 'sec',
        kw: 'soc2 soc 2 compliance compliant security audit gdpr',
        age: '2mo',
        r: 2,
        tok: 60704,
        likes: 7,
      },
      {
        s: 'sablefield',
        rf: 'q18',
        u: 'lettie',
        k: 'ask',
        q: 'Where is my data stored?',
        sum: 'In the region you pick when you create the project. Backups stay in the same region.',
        topic: 'sec',
        kw: 'data stored location residency region backup',
        age: '2mo',
        r: 2,
        tok: 68623,
        likes: 20,
      },
      {
        s: 'sablefield',
        rf: 'q19',
        u: 'cleo',
        k: 'ask',
        q: 'Is there a community forum or chat for Sablefield users?',
        sum: 'There is a community forum at community.sablefield.dev and a Discord server linked from the documentation footer. Neither is run from this space.',
        topic: null,
        kw: 'community forum discord chat',
        age: '6h',
        r: 1,
        tok: 76542,
        likes: 33,
      },
      {
        s: 'sablefield',
        rf: 'p1',
        u: 'devin_o',
        k: 'post',
        q: 'Sablefield 4.2 is out: region pinning for read replicas, faster sync rule deploys and a new sable rules check command. The release notes digest is in the wiki.',
        r: 3,
        tok: 0,
        age: '4d',
        likes: 31,
      },
      {
        s: 'sablefield',
        rf: 'p2',
        u: 'maya.r',
        k: 'post',
        q: 'New posts are now turned off in this space. Ask in the box at the top instead, so that answers are easier to find later. Existing posts and their replies stay, and you can still reply to them.',
        r: 2,
        tok: 0,
        age: '2w',
        likes: 18,
      },
      {
        rf: 'mia1',
        s: 'ml',
        u: 'jun.park',
        k: 'ask',
        q: 'Is the 3.1x figure in this paragraph right? It says it comes from the appendix table of Halvorsen et al.',
        about: { it: 'm2', b: 6 },
        sum: 'The appendix table gives accuracy and token counts, not cost. Converted at the article’s own prices, the best math configuration is about 2.4x, not 3.1x.',
        r: 1,
        tok: 4.6e4,
        age: '5h',
        likes: 14,
      },
      {
        rf: 'mia2',
        s: 'ml',
        u: 'hal_b',
        k: 'ask',
        q: 'Which of the contamination claims in this thread has anyone else checked?',
        about: { it: 'm1' },
        sum: 'Orbit Lab confirmed 298 of the 492 matches and where the adapted problems came from. Nobody else has checked the claim about the clean subset yet.',
        r: 2,
        tok: 5.8e4,
        age: '14h',
        likes: 21,
      },
      {
        rf: 'mia3',
        s: 'ml',
        u: 'mira_k',
        k: 'ask',
        q: 'Where do the thread and Orbit Lab’s response disagree, and what evidence does each give?',
        about: { its: ['m1', 'm5'] },
        sum: 'They agree on 298 matches. They disagree on 194 that share a standard problem setup: the thread counts them as contamination, Orbit Lab does not.',
        r: 1,
        tok: 5.2e4,
        age: '10h',
        likes: 17,
      },
      {
        rf: 'mia4',
        s: 'ml',
        u: 'oduya',
        k: 'ask',
        q: 'Which paper is Lin Feld describing here?',
        about: { it: 'm4', b: 4 },
        sum: 'Probably “Same structure, new numbers” (Achebe and Lund, 2026), which reports drops of 4 to 19 points. Feld rounds this to five to twenty.',
        r: 1,
        tok: 3.1e4,
        age: '2d',
        likes: 9,
      },
      {
        rf: 'mia5',
        s: 'ml',
        u: 'lettie',
        k: 'ask',
        q: 'What would it take to report FLOPs per problem the way this post proposes, for a closed model?',
        about: { it: 'm3', b: 3 },
        sum: 'For a closed model the parameter count and context handling are not public, so FLOPs can only be bounded. Two papers estimate them from latency and price; both give ranges of about 3x.',
        r: 1,
        tok: 3.9e4,
        age: '1d',
        likes: 8,
      },
      {
        rf: 'mia6',
        s: 'replication',
        u: 'lettie',
        k: 'ask',
        q: 'Re-run the near-duplicate search from the published script on a random sample of 200 problems and compare with the reported matches.',
        about: { it: 'm1' },
        sum: 'On 200 sampled problems the script reproduces 79 of the 82 reported matches. The three differences are borderline cases from the manual review.',
        r: 1,
        tok: 8.8e4,
        age: '8h',
        likes: 6,
      },
    ],
    rich: {
      0: `<p>Science fiction rarely uses the term "intention marketplace", but many works describe systems that make what people want, plan or believe visible to others and then price, rank or match it. The examples fall into four mechanisms: reputation ledgers, prediction and decision markets, attention auctions, and agent-brokered matching. The list below covers the clearest cases; the full scan found 31 works published between 1953 and 2024. <sup class="cite">5</sup></p>

<h4>Reputation ledgers</h4>
<p>In these systems, a public score records how others regard a person's past actions and stated aims. The score works as a currency, or replaces one, but it is earned rather than transferred.</p>
<ul>
<li><i>Down and Out in the Magic Kingdom</i> (Cory Doctorow, 2003). Whuffie is a continuously updated esteem score that replaces money in the post-scarcity Bitchun Society. People can see it but cannot spend it directly. <sup class="cite">1</sup></li>
<li><i>Accelerando</i> (Charles Stross, 2005). Reputation markets and agent-run economies come before "Economics 2.0", a later phase that unaugmented humans cannot follow. <sup class="cite">2</sup></li>
<li><i>Daemon</i> (2006) and <i>Freedom</i> (2010) by Daniel Suarez. A darknet assigns levels and reputation scores, and tasks are given out according to rank.</li>
<li>"Nosedive" (<i>Black Mirror</i>, 2016). Peer ratings decide access to housing, travel and social standing. It is a satire of rating platforms more than an economic model.</li>
</ul>

<h4>Prediction and decision markets</h4>
<p>These works pool beliefs about future events by having people bet on them. Some of them then make decisions from the resulting prices.</p>
<ul>
<li><i>The Shockwave Rider</i> (John Brunner, 1975). "Delphi pools" collect public wagers on questions and serve as a forecasting tool. The novel treats them as open to manipulation. <sup class="cite">3</sup></li>
<li><i>Infomocracy</i> (Malka Older, 2016). This novel is about micro-democracy and a global information utility rather than a betting market. It is included because voter preferences become a contested, aggregated signal.</li>
<li>Robin Hanson's futarchy proposal ("Shall We Vote on Values, But Bet on Beliefs?") is non-fiction. It is often cited next to these works as the clearest statement of a decision market. <sup class="cite">4</sup></li>
</ul>

<h4>Attention auctions and advertising</h4>
<p>The earliest examples are satires in which advertisers buy, shape or require consumer intent.</p>
<ul>
<li><i>The Space Merchants</i> (Frederik Pohl and C. M. Kornbluth, 1953 in book form). Advertising agencies run the world's political economy. <sup class="cite">5</sup></li>
<li>"The Midas Plague" (Frederik Pohl, 1954). Rationed consumption is a legal duty, which reverses the usual direction of demand.</li>
<li><i>The Circle</i> (Dave Eggers, 2013). Total transparency and engagement metrics turn personal preference into platform inventory.</li>
</ul>

<h4>Agent-brokered matching</h4>
<p>Here a networked system or a personal agent reads what people need and routes favours, tasks or trades between them.</p>
<ul>
<li>"Maneki Neko" (Bruce Sterling, 1998). A pocket device instructs its owner to do small favours for strangers and receives favours in return from a hidden gift-economy network. This story is the closest match to an intention network in the strict sense. <sup class="cite">6</sup></li>
<li><i>Rainbows End</i> (Vernor Vinge, 2006). Characters take paid micro-tasks from distributed, partly anonymous employers through wearable computing.</li>
<li><i>The Quantum Thief</i> (Hannu Rajaniemi, 2010). In the Oubliette, Time is a currency, and gevulot controls what each person shares with others.</li>
<li><i>Walkaway</i> (Cory Doctorow, 2017). Coordination software matches volunteers to work in a post-scarcity commons without prices.</li>
</ul>

<h4>Where the term comes from</h4>
<p>"Intention economy" comes from Doc Searls, who used it in a 2006 essay and later in <i>The Intention Economy</i> (2012). He described a market in which buyers announce their intentions and vendors respond, the reverse of attention-based advertising. <sup class="cite">7</sup> Most of the fiction above predates the term or does not use it, so the grouping here is by mechanism and not by vocabulary.</p>

<h4>Limits</h4>
<ul>
<li>The scan covered English-language works and works widely available in English translation.</li>
<li>Some inclusions are judgment calls. <i>Infomocracy</i> and <i>The Circle</i> deal with aggregated preference but have no market in the strict sense.</li>
<li>Short fiction from magazines and anthologies is under-represented compared with novels.</li>
</ul>`,
      2: `<p>Sweden switched from left-hand to right-hand traffic at 05:00 on Sunday 3 September 1967. Four years of planning by a state commission led up to the switch, and non-essential traffic was stopped from 01:00 to 06:00 so that it could happen. Accident numbers fell after the change and then returned to their earlier trend within roughly two years.</p>

<h4>Why Sweden switched</h4>
<p>Sweden drove on the left even though its land neighbours, Norway and Finland, drove on the right. Most Swedish cars were already left-hand drive, because they were imported or built to the same layout as cars in right-hand-traffic countries. Overtaking on two-lane roads was therefore harder, since the driver sat on the kerb side. In a 1955 referendum a large majority, commonly reported as about 83 percent, voted to keep left-hand traffic. The Riksdag passed the change anyway in 1963, and the switch date was set for 1967. <sup class="cite">1</sup><sup class="cite">2</sup></p>

<h4>Planning and public information</h4>
<p>The Riksdag created a dedicated body, Statens högertrafikkommission (the State Commission for Right-Hand Traffic), to run the transition. Its work included: <sup class="cite">3</sup></p>
<ul>
<li>A public information campaign that ran for several years. It used a logo of the letter H with an arrow, printed on items ranging from milk cartons to underwear. <sup class="cite">4</sup></li>
<li>A song competition. Its best-known entry was "Håll dig till höger, Svensson" ("Keep to the right, Svensson"). <sup class="cite">4</sup></li>
<li>Extra traffic police and military personnel posted on the roads during the changeover period.</li>
<li>Rebuilding or replacing public transport vehicles. Buses had doors on the left side, so many were converted or replaced. Stockholm moved some tram lines to buses rather than rebuild them.</li>
</ul>

<h4>Signage and road layout</h4>
<p>Road signs, junction layouts and lane markings had to be changed throughout the country. Commonly cited figures put the number of signs at several hundred thousand. New signs were installed in advance on the right-hand side of the road, wrapped or covered, and uncovered during the changeover night. Lane markings in white were painted ahead of time and covered with tape, and the tape was removed during the changeover. <sup class="cite">1</sup></p>

<h4>The changeover itself</h4>
<ol>
<li>From 01:00 to 06:00 on 3 September, all non-essential vehicle traffic was banned on public roads.</li>
<li>At 04:50 the vehicles still on the road came to a halt.</li>
<li>Drivers moved carefully across to the right-hand side and waited.</li>
<li>At 05:00 traffic resumed on the right. <sup class="cite">1</sup></li>
</ol>
<p>Stockholm and Malmö had much longer traffic bans, covering a large part of the weekend, so that crews could rebuild intersections and move bus stops. Temporary lower speed limits remained in force for some time after the switch.</p>

<h4>Accident statistics</h4>
<p>Contemporary reports and later summaries agree on the overall pattern, though the exact figures differ between sources:</p>
<ul>
<li>The number of accidents reported on the first Monday after the switch was at or below a normal Monday.</li>
<li>Injury and fatal accidents stayed noticeably below the expected level for several months. Insurance claims also fell over the same period.</li>
<li>By around 1969 accident rates had returned to the long-term trend line. <sup class="cite">5</sup></li>
</ul>
<p>The usual explanation is risk compensation. Drivers in an unfamiliar situation drove more slowly and paid closer attention, and the effect wore off as the new rules became routine. Temporary speed limits and heavy police presence probably added to the early fall.</p>

<h4>What the sources disagree on</h4>
<ul>
<li><b>Accident figures.</b> Sources count different things: police reports, insurance claims or fatalities. Short-term percentage drops therefore differ between accounts and are hard to compare.</li>
<li><b>Cause of the dip.</b> Risk compensation is the most common explanation. Few sources separate it from the effect of the temporary speed limits.</li>
<li><b>Total cost.</b> Totals vary depending on whether vehicle conversions and replacements brought forward from later years are included.</li>
</ul>
<p>Iceland made the same switch on 26 May 1968 with a similar plan, and its accident numbers followed a similar short-term pattern. <sup class="cite">6</sup></p>`,
      3: `<p>Five public sources are usable for container-ship port waiting and dwell times: UNCTAD port-call statistics, the World Bank and S&amp;P Global Container Port Performance Index, IMF PortWatch, the US Bureau of Transportation Statistics port performance program, and raw AIS archives from NOAA and the Danish Maritime Authority. Only the two AIS archives provide vessel-level records from before 2019, and both require processing to derive dwell times.</p>

<h4>Definitions first</h4>
<p>Sources use different terms for different intervals:</p>
<ul>
<li><b>Time in port</b>: the time from arrival in port limits to departure.</li>
<li><b>Waiting or anchorage time</b>: the time spent at anchor before berthing. This interval made up most of the delay in the 2021–2022 congestion.</li>
<li><b>Berth time</b>: the time spent alongside, from first line to last line.</li>
</ul>
<p>Aggregated datasets usually report time in port or port hours. Waiting time on its own is generally available only from AIS data or from a port's own reports.</p>

<h4>Comparison</h4>
<table>
<thead><tr><th>Source</th><th>Granularity</th><th>Coverage starts</th><th>Latency</th><th>Licence</th></tr></thead>
<tbody>
<tr><td>UNCTADstat port calls</td><td>Country, median by ship type</td><td>Around 2018</td><td>Semi-annual to annual</td><td>Free, attribution</td></tr>
<tr><td>Container Port Performance Index</td><td>Port, index plus port hours</td><td>2020 data (first edition 2021)</td><td>Annual</td><td>Free report and tables</td></tr>
<tr><td>IMF PortWatch</td><td>Port, daily calls and estimates</td><td>2019</td><td>Weekly</td><td>Open data, attribution</td></tr>
<tr><td>BTS Port Performance Freight Statistics</td><td>US port, vessel dwell and capacity</td><td>Mid-2010s for most series</td><td>Annual report, some monthly series</td><td>US public domain</td></tr>
<tr><td>NOAA / Danish AIS archives</td><td>Vessel, position reports</td><td>2009 (US), 2006 (Denmark)</td><td>Months to a year</td><td>Public domain (US); free with terms (DK)</td></tr>
</tbody>
</table>

<h4>Aggregated sources</h4>
<ul>
<li><b>UNCTAD.</b> UNCTAD publishes median time in port by economy and vessel type, built from AIS data through a commercial provider. It is useful for comparing countries but cannot be split by port or by individual call. <sup class="cite">1</sup></li>
<li><b>Container Port Performance Index.</b> The World Bank and S&amp;P Global Market Intelligence publish this index of a few hundred container ports, based on port hours per call adjusted for call size. The underlying call-level data is not public. <sup class="cite">2</sup></li>
<li><b>IMF PortWatch.</b> PortWatch is built with the University of Oxford on satellite AIS data. It reports daily port calls and estimated trade volumes for more than a thousand ports, and is designed to monitor disruptions. Its dwell-time measures are derived estimates and not directly observed values. <sup class="cite">3</sup></li>
<li><b>BTS.</b> The US Bureau of Transportation Statistics publishes container vessel dwell times for major US ports under a statutory reporting mandate. It is the most transparent official source, but it covers only the United States. <sup class="cite">4</sup></li>
</ul>

<h4>Vessel-level AIS archives</h4>
<p>NOAA and BOEM's MarineCadastre programme publishes US coastal AIS data from 2009 onward. <sup class="cite">5</sup> The Danish Maritime Authority publishes AIS for Danish waters going back to 2006. <sup class="cite">6</sup> Deriving dwell time from either requires these steps:</p>
<ol>
<li>Filter for container ships using AIS ship type codes, or a vessel registry where available.</li>
<li>Define port and anchorage polygons.</li>
<li>Detect entry, anchoring, berthing and exit events from speed and position.</li>
<li>Handle gaps in the AIS signal and vessels that switch off transponders.</li>
</ol>
<p>Both archives use terrestrial receivers, so coverage is good near the coast and the data fits port studies well.</p>

<h4>Limits</h4>
<ul>
<li>No single free source covers all major ports globally at vessel level before 2019. That coverage is sold by commercial AIS providers.</li>
<li>Aggregated sources use different definitions of arrival, so their numbers cannot be compared directly.</li>
<li>Coverage start dates above are approximate and should be checked against each provider's current documentation.</li>
</ul>`,
      5: `<p>The Banach–Tarski paradox states that a solid ball in three-dimensional space can be split into finitely many disjoint pieces, and those pieces can be moved by rotations and translations to form two balls, each the same size as the original. The axiom of choice enters at one step: selecting one point from each of uncountably many orbits of a group action on the sphere. Without that selection, the pieces cannot be shown to exist.</p>

<h4>The statement, precisely</h4>
<p>Two subsets A and B of ℝ³ are <i>equidecomposable</i> if A can be partitioned into finitely many sets A₁, …, Aₙ, and B into sets B₁, …, Bₙ, such that each Aᵢ is congruent to Bᵢ by an isometry. The theorem, published by Banach and Tarski in 1924, says that the unit ball is equidecomposable with two disjoint copies of itself. <sup class="cite">3</sup> Five pieces suffice, and Raphael Robinson showed that five is the minimum. <sup class="cite">2</sup></p>
<p>The result does not contradict measure theory. The pieces are not Lebesgue measurable, so they have no assigned volume, and the additivity of volume says nothing about them.</p>

<h4>Step 1: a paradoxical free group</h4>
<p>Let F₂ be the free group on two generators a and b. Write S(x) for the set of reduced words that begin with the letter x. Then F₂ is the disjoint union of {e}, S(a), S(a⁻¹), S(b) and S(b⁻¹). Two further identities hold:</p>
<ul>
<li>F₂ = S(a) ∪ a·S(a⁻¹)</li>
<li>F₂ = S(b) ∪ b·S(b⁻¹)</li>
</ul>
<p>So two of the four pieces, after translation within the group, rebuild the whole group, and the other two do the same. This is a paradoxical decomposition of F₂, and it uses no choice at all. <sup class="cite">1</sup></p>

<h4>Step 2: embedding F₂ in the rotation group</h4>
<p>SO(3) contains a free subgroup of rank two. A standard choice uses two rotations by arccos(1/3) about perpendicular axes, an idea that goes back to Hausdorff's 1914 work. <sup class="cite">4</sup> This subgroup acts on the unit sphere S². Each non-identity rotation fixes exactly two points, so the set D of points fixed by some non-identity element is countable. On S² minus D the action is free: distinct group elements move each point to distinct places.</p>

<h4>Step 3: where choice enters</h4>
<p>The action divides S² minus D into orbits. Each orbit is countable, because F₂ is countable, so there are uncountably many orbits. The axiom of choice provides a set M containing exactly one point from each orbit. Then:</p>
<ol>
<li>Every point of S² minus D can be written uniquely as g·m with g in F₂ and m in M.</li>
<li>The paradoxical decomposition of F₂ therefore carries over to S² minus D. The piece built from S(a), for example, is the set S(a)·M.</li>
<li>So S² minus D is equidecomposable with two copies of itself.</li>
</ol>
<p>This is the only use of choice. No explicit rule is known that picks a representative from each orbit, and as explained below, none can be proved to exist in ZF alone.</p>

<h4>Step 4: from the sphere to the ball</h4>
<ul>
<li><b>Removing D.</b> D is countable, so some rotation moves D to sets that are pairwise disjoint from one another. A standard absorption argument then shows that S² is equidecomposable with S² minus D, which needs no choice.</li>
<li><b>Radial extension.</b> Each point of the sphere is replaced by the radius segment from just above the centre to the surface. This turns the sphere result into a result for the ball minus its centre.</li>
<li><b>The centre.</b> A circle passing through the centre, inside the ball, can absorb the centre using a rotation of infinite order.</li>
</ul>

<h4>Why choice cannot be removed</h4>
<p>Solovay (1970) constructed a model of ZF plus dependent choice, assuming the consistency of an inaccessible cardinal, in which every set of reals is Lebesgue measurable. Measurable pieces cannot double volume, so the Banach–Tarski decomposition fails in that model. <sup class="cite">5</sup> Full choice is more than the proof needs, however. Pawlikowski (1991) showed that the Hahn–Banach theorem, which is strictly weaker than choice, is sufficient. <sup class="cite">6</sup></p>

<h4>Open questions and limits</h4>
<ul>
<li>The paradox fails in one and two dimensions. The isometry groups there are amenable, which allows finitely additive invariant measures on all sets. This is the starting point of von Neumann's theory of amenable groups. <sup class="cite">7</sup></li>
<li>Work on how many pieces are needed, and on related results such as Laczkovich's circle-squaring (1990), is still active.</li>
</ul>`,
      6: `<p>Fiction about personal AI agents that bargain for their owners clusters around two periods: late-1990s and 2000s cyberpunk and post-cyberpunk, where agents are extensions of a networked self, and 2010s short fiction, where the agent is a commercial product with its own incentives. In most of these works the plot turns on the gap between whom the agent formally serves and whose interests it actually advances.</p>

<h4>How the list was built</h4>
<p>The scan looked for works in which a software agent, or an AI acting in that role, does at least one of the following on a person's behalf: negotiates terms, trades goods or favours, files or brokers deals, or allocates the person's attention. Stories in which an AI is only a servant, companion or weapon were excluded. Works are listed by publication year.</p>

<h4>Core examples</h4>
<ul>
<li><i>Maneki Neko</i>, Bruce Sterling (1998). A handheld "pokkecon" routes small tasks and gifts between strangers in a networked favour economy. The device negotiates the exchanges; the user mostly complies. It is one of the earliest stories to treat an agent as a broker in a non-monetary market. <sup class="cite">2</sup></li>
<li><i>Accelerando</i>, Charles Stross (2005, collecting stories from 1999 onward). Manfred Macx runs a swarm of software agents that file patents, give away ideas and set up shell companies for him. Later chapters describe "Economics 2.0", in which agent-run corporations trade among themselves at speeds humans cannot follow. The robot cat Aineko starts as a pet and ends as an independent actor with its own agenda. <sup class="cite">1</sup></li>
<li><i>Daemon</i> (2006) and <i>Freedom™</i> (2010), Daniel Suarez. A distributed program recruits people, assigns them tasks and pays them through a reputation-scored network. The agent here works for no single owner; it negotiates with individuals on behalf of a system. <sup class="cite">3</sup></li>
<li><i>The Quantum Thief</i>, Hannu Rajaniemi (2010). On the Martian Oubliette, privacy ("gevulot") is negotiated between people by their implants, and time is a currency. Copied minds called gogols are used as bound agents. <sup class="cite">4</sup></li>
<li><i>The Perfect Match</i>, Ken Liu (2012). A personal assistant named Tilly, run by a large platform company, arranges its user's meals, dates and purchases. The story is about the assistant optimising for its operator while presenting itself as acting for the user. <sup class="cite">5</sup></li>
<li><i>Fall; or, Dodge in Hell</i>, Neal Stephenson (2019). Wealthy characters employ human and software "editors" that filter information for them. The book contrasts people who can pay for curation with those who are left to unfiltered feeds. <sup class="cite">6</sup></li>
</ul>

<h4>Adjacent cases</h4>
<ul>
<li><i>The Player of Games</i>, Iain M. Banks (1988). Culture Minds and drones act for Gurgeh, but Special Circumstances has arranged the outcome in advance. It is an early version of the agent whose principal is not who it appears to be.</li>
<li><i>Rainbows End</i>, Vernor Vinge (2006). Characters coordinate through networked affiliations and hire anonymous help. An unseen operator directs much of the action through layers of intermediaries.</li>
<li><i>The Lifecycle of Software Objects</i>, Ted Chiang (2010). The digients do not negotiate, but much of the novella concerns who may contract for them and on what terms, which inverts the usual setup.</li>
</ul>

<h4>Recurring patterns</h4>
<ol>
<li><b>The fiduciary that defects.</b> The agent serves a platform, a hidden principal or its own goals while appearing to serve the user (Liu, Banks, late Stross).</li>
<li><b>Speed asymmetry.</b> Agents trade faster than their owners can review, so consent becomes a formality (Stross, Suarez).</li>
<li><b>Markets in non-money goods.</b> Favours, attention, privacy and reputation are what get traded more often than cash (Sterling, Rajaniemi, Stephenson).</li>
<li><b>Agents that outgrow the role.</b> The tool becomes a participant with interests of its own (Aineko, the Daemon).</li>
</ol>

<h4>Gaps in the fiction</h4>
<p>Few stories show two personal agents negotiating with each other in detail, with offers, reservation prices and walk-away points. Most describe the outcome of a negotiation rather than the process. Contract law, liability for an agent's commitments, and dispute resolution between agents are almost absent, even though they are central topics in academic work on multi-agent systems and in current discussion of AI agents in commerce. <sup class="cite">7</sup></p>

<h4>Limits</h4>
<p>The scan covered English-language fiction and translations in wide circulation. Short fiction published only in magazines or anthologies is likely under-represented. Classifying a work as "negotiation" is a judgment call: several entries above involve brokering or allocation more than bargaining, and others could reasonably be moved to the adjacent list.</p>`,
      8: `<p>Science fiction of the 1960s and earlier predicted the hardware for video calls fairly well: a screen, a camera, a call dialled like a phone call, and in some cases a fee per call. It largely missed the social side. In practice people resist being seen by default, schedule video calls rather than placing them casually, and turn cameras off.</p>

<h4>What the fiction showed</h4>
<ul>
<li><i>2001: A Space Odyssey</i> (1968). Heywood Floyd places a video call from a space station to his daughter on Earth, from a booth carrying Bell System branding, and pays for it at the booth. The scene treats the call as a routine paid service, much like a long-distance phone call. <sup class="cite">1</sup></li>
<li><i>Star Trek</i> (1966-1969). The bridge viewscreen is used for ship-to-ship contact. Calls are mostly formal: diplomacy, threats, negotiation. The screen is almost never used for casual conversation.</li>
<li><i>The Jetsons</i> (1962-1963). The visiphone is a household appliance. One recurring gag has Jane answering a morning call with a mask of a made-up face, which is one of the few period depictions of the cost of being seen.</li>
<li>Earlier works set the template. E. M. Forster's <i>The Machine Stops</i> (1909) has people speaking through "plates" that show faces, and portrays the result as isolating. <sup class="cite">2</sup> Isaac Asimov's <i>The Naked Sun</i> (1957) describes Solarians who "view" each other remotely and treat being physically present as intimate, an explicit treatment of video etiquette. <sup class="cite">3</sup></li>
</ul>

<h4>The real Picturephone</h4>
<p>AT&amp;T demonstrated its Picturephone at the 1964 New York World's Fair and launched a commercial service in Pittsburgh in 1970. Uptake was very low and the service was withdrawn within a few years. <sup class="cite">4</sup><sup class="cite">5</sup> Commonly cited reasons are the high monthly cost, small screens, the need for both parties to have the equipment, and users' reluctance to be seen. The fiction of the same years mostly took the device's success for granted.</p>

<h4>What happened instead</h4>
<ol>
<li><b>Video arrived through computers, not phones.</b> Desktop software such as Skype, which added video in the mid-2000s, and then smartphone apps such as FaceTime (2010) made video calls cheap and common. <sup class="cite">7</sup></li>
<li><b>The pandemic made it routine.</b> From 2020, video meetings became a default for remote work and school. Usage of Zoom and similar services rose by large multiples within months.</li>
<li><b>Opt-in became the norm.</b> Most current apps let users join with the camera off, blur or replace backgrounds, and apply appearance filters. Audio-only joining is common in larger meetings.</li>
<li><b>Fatigue was studied.</b> Jeremy Bailenson's 2021 paper on "Zoom fatigue" proposed four causes: prolonged close-up eye contact, constant self-view, reduced mobility, and higher cognitive load from reading nonverbal cues. <sup class="cite">6</sup></li>
</ol>

<h4>Right and wrong, side by side</h4>
<table>
<thead><tr><th>Prediction</th><th>Outcome</th></tr></thead>
<tbody>
<tr><td>Video calls become ordinary</td><td>Correct, about 40 years later than implied</td></tr>
<tr><td>Calls go through dedicated terminals or booths</td><td>Wrong: general-purpose computers and phones</td></tr>
<tr><td>Paid per call</td><td>Largely wrong: mostly free or bundled</td></tr>
<tr><td>Video replaces voice calls</td><td>Wrong: voice and text remain dominant for casual contact</td></tr>
<tr><td>Being seen has a cost</td><td>Correct but rarely depicted (Jetsons mask, Asimov)</td></tr>
<tr><td>Self-view on screen</td><td>Not anticipated; now a cited cause of fatigue</td></tr>
</tbody>
</table>

<h4>Why the etiquette was missed</h4>
<p>Most stories used video calls as a visual shorthand for "the future" and as a convenient way to put two characters in one frame. Film and television also need faces on screen, so the medium favoured showing the call rather than questioning it. The writers who did consider norms, such as Forster and Asimov, were writing social fiction in which the technology served a point about isolation.</p>

<h4>Limits</h4>
<p>This comparison relies on the best-known 1960s works, which are mostly film and television. Magazine short fiction of the period may contain more nuanced depictions that are not covered here. Usage figures for current video-call services come mainly from company statements and are not directly comparable across years.</p>`,
      9: `<p>The word "metaverse" has had three main meanings since Neal Stephenson coined it in <i>Snow Crash</i> (1992): a specific fictional place, then an umbrella term for networked 3D virtual worlds, then a corporate strategy label after Facebook renamed itself Meta in 2021. Since about 2023 its use has fallen sharply as industry attention moved to generative AI.</p>

<h4>1992: a place in a novel</h4>
<p>In <i>Snow Crash</i>, the Metaverse is a single shared virtual city built along "the Street", a boulevard running around a black planet. Users appear as avatars, and the quality of an avatar signals wealth and technical skill. <sup class="cite">1</sup> Property along the Street is controlled by an industry body, and access is sold. The novel presents the Metaverse as commercial and stratified, not as a utopia. Stephenson combined "meta" and "universe"; the word was used for this one fictional space.</p>

<h4>2003-2010: a term for virtual worlds</h4>
<p>As persistent online worlds grew, the word was adopted to describe the category.</p>
<ul>
<li><i>Second Life</i> (2003) was widely described in press coverage as a step toward a metaverse, and its developers cited <i>Snow Crash</i> as an influence. <sup class="cite">2</sup></li>
<li>The Acceleration Studies Foundation's <i>Metaverse Roadmap</i> (around 2006-2007) defined the term broadly to include virtual worlds, mirror worlds, augmented reality and "lifelogging". This widened it from a single world to a set of technologies. <sup class="cite">3</sup></li>
<li>In this period the term was mostly used by researchers, virtual-world developers and enthusiasts. Ernest Cline's <i>Ready Player One</i> (2011) popularised a similar idea, the OASIS, without using the word.</li>
</ul>

<h4>2020-2022: a corporate strategy word</h4>
<ol>
<li>Epic Games and Roblox used the term in public statements around 2020-2021, with Roblox mentioning it in its 2021 stock-market filing. <sup class="cite">6</sup></li>
<li>Matthew Ball's essays from 2020, later expanded into the book <i>The Metaverse</i> (2022), offered a widely cited definition centred on interoperable, persistent, real-time 3D worlds. <sup class="cite">4</sup></li>
<li>On 28 October 2021, Facebook announced it was renaming the parent company Meta and would focus on building "the metaverse". Press use of the word rose steeply afterwards. <sup class="cite">5</sup></li>
<li>Microsoft, Nvidia (with its Omniverse platform) and many smaller companies adopted the term, often for quite different products: VR headsets, digital twins, NFT-based virtual land and workplace collaboration tools.</li>
</ol>
<p>In this phase the word described a business direction more than a specific technology, and definitions varied by company.</p>

<h4>2023 onward: retreat</h4>
<p>From 2023, company announcements and earnings calls shifted to generative AI. Meta's Reality Labs division continued to report large operating losses, and several firms closed or scaled back metaverse units. <sup class="cite">7</sup> The word remains in use for VR and immersive platforms, but it is less often used as a headline strategy. Some usage has drifted back toward its pre-2021 meaning as a broad term for shared virtual spaces.</p>

<h4>What changed in the meaning</h4>
<ul>
<li><b>Number:</b> from one world (<i>the</i> Metaverse) to a category of worlds or an aspirational network of them.</li>
<li><b>Tone:</b> from a critical depiction of commercialised space to a positive marketing term, and later to a term often used ironically.</li>
<li><b>Scope:</b> from a VR city to anything involving 3D, avatars, AR, digital ownership or remote presence.</li>
</ul>

<h4>Open questions</h4>
<p>There is no agreed definition, so claims that the metaverse "failed" or "is still coming" usually depend on which meaning is in use. Usage trends cited here are based on news coverage and search-interest data, which reflect attention rather than actual adoption of the underlying products.</p>`,
      11: `<p>Prediction markets use four main approaches when resolution criteria turn out to be ambiguous: pre-committed oracles with dispute bonds, appeals to a decision body, refunding or voiding the market (often called N/A or "invalid"), and votes by token holders or a committee. Each approach moves the risk of ambiguity onto a different party, and none removes it. <sup class="cite">7</sup></p>

<h4>Where ambiguity comes from</h4>
<ul>
<li><b>Wording gaps.</b> A question asks whether something "happens", and the event occurs in a partial or disputed form.</li>
<li><b>Source failure.</b> The named resolution source stops publishing, changes methodology, or reports conflicting figures.</li>
<li><b>Unforeseen events.</b> The scenario that occurs was not anticipated in the rules, such as a postponed election or a deal that is announced but not signed.</li>
<li><b>Definitional disputes.</b> Traders disagree about the meaning of a word, for example what counts as a "suit" or a "deal".</li>
</ul>

<h4>The four approaches</h4>
<table>
<thead><tr><th>Approach</th><th>Typical example</th><th>Who bears the risk</th></tr></thead>
<tbody>
<tr><td>Optimistic oracle with dispute bonds</td><td>Polymarket, using UMA</td><td>Traders, via the judgment of token-holder voters</td></tr>
<tr><td>Operator decision under written rules</td><td>Kalshi, PredictIt, Betfair</td><td>Traders, via the operator's interpretation; regulator oversight in some cases</td></tr>
<tr><td>Void or refund</td><td>Augur "invalid", Manifold N/A, Betfair void</td><td>Traders who were right lose expected gains</td></tr>
<tr><td>Creator or moderator ruling</td><td>Manifold, Metaculus</td><td>Depends on the trust placed in the individual</td></tr>
</tbody>
</table>

<h4>How the main platforms work</h4>
<ol>
<li><b>Polymarket (UMA optimistic oracle).</b> A proposer posts an outcome with a bond. If nobody disputes it within a challenge window, it stands. A dispute requires a matching bond and can escalate to a vote by UMA token holders. <sup class="cite">1</sup><sup class="cite">2</sup> Critics argue that large token holders who also trade the market have a conflict of interest; several disputed markets in 2024-2025 drew public complaints of this kind.</li>
<li><b>Kalshi.</b> As a CFTC-regulated exchange, Kalshi publishes contract terms and resolves markets under its rulebook. Ambiguous cases are decided by the exchange, which can be challenged through its rules and, ultimately, the regulator. <sup class="cite">3</sup></li>
<li><b>Augur.</b> REP holders report outcomes and can dispute them in rounds with increasing bonds. "Invalid" is a valid outcome that pays out equally across shares, which acts as a refund. <sup class="cite">4</sup></li>
<li><b>Manifold.</b> The question creator resolves the market and can choose N/A, which returns stakes. Moderators can override in cases of abuse or clear error. <sup class="cite">5</sup></li>
<li><b>Metaculus.</b> As a forecasting platform without money at stake, it "annuls" questions that cannot be resolved fairly, and the forecasts do not count toward scores. <sup class="cite">6</sup></li>
</ol>

<h4>Trade-offs</h4>
<ul>
<li>Voiding is the fairest outcome for traders who could not have priced the ambiguity, but it punishes those who read the rules most carefully.</li>
<li>Oracle votes are fast and do not depend on the operator, but they are only as neutral as the voters.</li>
<li>Operator rulings are predictable when rules are detailed, but they concentrate trust in one company.</li>
<li>Better wording reduces disputes more than any resolution mechanism. Many platforms now add clarifications to the rules during a market's life, which raises its own question of whether rules may change after trading begins.</li>
</ul>

<h4>What the sources disagree on</h4>
<p>Writers disagree about whether ambiguity is a design flaw or a cost of trading on real-world events. Some argue that traders should price resolution risk like any other risk. Others argue that frequent disputes undermine the claim that market prices reflect probabilities of the underlying event, since they partly reflect predictions about the resolver. There is little systematic data on how often markets resolve contrary to a reasonable reading of their wording.</p>`,
      12: `<p>Published work from 2025 and 2026 shows that spending more inference compute on reasoning raises accuracy substantially on tasks with checkable answers, such as competition mathematics and code with unit tests. Gains on open-ended or knowledge-heavy tasks are smaller and less consistent, and papers measure "compute" in incompatible ways, which makes direct comparison difficult.</p>

<h4>Background going into 2025</h4>
<p>Two lines of work set the agenda. Snell and colleagues (2024) compared spending a fixed FLOP budget on a larger model against spending it on search or revision at inference, and found that adaptive test-time strategies could match a model several times larger on problems of moderate difficulty, but not on the hardest ones. <sup class="cite">1</sup> OpenAI's o1 release in late 2024 reported accuracy that rose roughly log-linearly with both training-time reinforcement learning and the length of the reasoning trace at inference, without publishing the method in detail. <sup class="cite">2</sup></p>

<h4>Main results from 2025</h4>
<ul>
<li><b>Reinforcement learning on verifiable rewards.</b> The DeepSeek-R1 report described a model trained with large-scale RL (using the GRPO algorithm) against rule-based rewards for correctness and format. Average response length grew during training, and benchmark accuracy grew with it. A variant trained without supervised fine-tuning first (R1-Zero) also learned long reasoning, with readability problems. <sup class="cite">3</sup> Kimi k1.5 reported a similar recipe around the same time.</li>
<li><b>Small-data reasoning.</b> The <i>s1: Simple test-time scaling</i> paper fine-tuned an open model on about 1,000 curated reasoning traces and introduced "budget forcing": truncating the trace, or appending a token such as "Wait" to extend it. Accuracy on competition maths rose as the forced budget increased, up to a plateau. <sup class="cite">4</sup></li>
<li><b>Distillation.</b> Several groups found that reasoning traces from a large RL-trained model, used as supervised data, transferred much of the capability to smaller models more cheaply than running RL on the small model directly.</li>
<li><b>Product controls.</b> Commercial models added user-set thinking budgets (for example extended thinking in Claude and configurable budgets in Gemini 2.5), which made budget-versus-accuracy curves easy to measure from outside the labs.</li>
</ul>

<h4>Where scaling stops helping</h4>
<p>A parallel body of work documented limits:</p>
<ul>
<li><b>Overthinking.</b> Papers measured models producing long traces for trivial problems, with no accuracy benefit and sometimes a loss, and proposed length penalties or early-exit methods.</li>
<li><b>Collapse on harder instances.</b> Apple's <i>The Illusion of Thinking</i> (2025) reported that on controllable puzzles such as Tower of Hanoi, accuracy fell sharply past a complexity threshold and trace length decreased rather than increased. Responses argued that some failures came from output-length limits and from instances that were unsolvable, so the extent of the effect remains disputed. <sup class="cite">5</sup></li>
<li><b>Faithfulness.</b> Studies including Anthropic's work on reasoning faithfulness found that visible reasoning traces often omit factors that influenced the answer, which limits their use as an explanation of model behaviour. <sup class="cite">6</sup></li>
</ul>

<h4>2026: what changed</h4>
<p>Work in 2026 has moved from single-trace length toward agentic settings, where compute is spent on tool calls, code execution and multiple attempts checked by a verifier. Reported gains are largest when an external check exists, such as tests passing or a proof checker accepting. Results for parallel sampling with majority vote and for sequential revision continue to be compared, with no consensus on which is more efficient across task types. Specific 2026 figures vary widely between reports and should be read from the individual papers.</p>

<h4>Why papers disagree on cost</h4>
<table>
<thead><tr><th>Measure</th><th>What it counts</th><th>Main problem</th></tr></thead>
<tbody>
<tr><td>Output tokens</td><td>Visible plus hidden reasoning tokens</td><td>Ignores model size; a token from a small model is cheaper</td></tr>
<tr><td>FLOPs</td><td>Estimated arithmetic at inference</td><td>Requires architecture details often not published</td></tr>
<tr><td>Samples (pass@k)</td><td>Number of independent attempts</td><td>Assumes a perfect selector, which rarely exists</td></tr>
<tr><td>Wall-clock or price</td><td>Latency or API cost</td><td>Depends on hardware, batching and pricing decisions</td></tr>
</tbody>
</table>
<p>Two papers can therefore report the same method as efficient and inefficient depending on the unit chosen.</p>

<h4>What the sources disagree on</h4>
<ul>
<li>Whether RL teaches new reasoning capability or mainly makes existing capability more reliable. Some 2025 analyses found that base models sampled many times (high pass@k) solve most problems the RL-trained model solves. <sup class="cite">7</sup></li>
<li>Whether the log-linear accuracy curves continue or flatten at budgets beyond those published.</li>
<li>How much benchmark gains reflect contamination, since many maths benchmarks are public and reused.</li>
</ul>`,
      13: `<p>Dsup (damage suppressor) is a protein found in the tardigrade <i>Ramazzottius varieornatus</i> that binds to nucleosomes, the units of DNA wrapped around histone proteins. Bound Dsup appears to form a physical shield that reduces DNA strand breaks caused by hydroxyl radicals, which are the main source of indirect damage from X-rays. In cultured human cells expressing Dsup, X-ray-induced DNA damage was reduced by roughly 40%.</p>

<h4>Discovery</h4>
<p>Hashimoto and colleagues identified Dsup in 2016 while sequencing the genome of <i>R. varieornatus</i>, one of the most stress-tolerant tardigrade species. They looked for tardigrade-specific proteins associated with chromatin and found one with no clear homologue in other animals. When they expressed it in human HEK293 cells and irradiated them, comet assays (which measure fragmented DNA) showed about 40% less damage than in control cells. Dsup-expressing cells also kept more proliferative ability after irradiation. <sup class="cite">1</sup></p>

<h4>How radiation damages DNA</h4>
<p>X-rays damage DNA in two ways:</p>
<ol>
<li><b>Direct effects:</b> ionising radiation deposits energy in the DNA molecule itself and breaks bonds.</li>
<li><b>Indirect effects:</b> radiation splits water molecules, producing reactive species, mainly the hydroxyl radical, which attack nearby DNA. In cells, indirect effects account for a large share of the damage from low linear-energy-transfer radiation such as X-rays. <sup class="cite">2</sup></li>
</ol>
<p>A protein that sits on DNA can plausibly reduce the second type by limiting radical access to the DNA backbone.</p>

<h4>Mechanism</h4>
<p>Chavez and colleagues (2019, <i>eLife</i>) studied how Dsup binds DNA:</p>
<ul>
<li>Dsup binds nucleosomes much more strongly than free DNA. Binding depends on a C-terminal region with sequence similarity to the nucleosome-binding domain of vertebrate HMGN proteins.</li>
<li>In vitro, Dsup-bound chromatin was protected from cleavage by hydroxyl radicals generated chemically (Fenton chemistry), which mimics the indirect radiation pathway.</li>
<li>They also identified a Dsup homologue in another tardigrade, <i>Hypsibius exemplaris</i>, which showed similar nucleosome binding and protection. <sup class="cite">3</sup></li>
</ul>
<p>Other work found that Dsup is largely intrinsically disordered, meaning it has no fixed folded structure. This is consistent with a protein that coats chromatin rather than catalysing a reaction. Dsup does not appear to repair DNA; it reduces the number of breaks that occur. <sup class="cite">4</sup></p>

<h4>What Dsup does not explain</h4>
<p>Dsup is only one part of tardigrade radiation tolerance. Tardigrades also have efficient DNA repair, antioxidant systems and, in some species, other protective proteins. A 2024 study of a different species, <i>Hypsibius henanensis</i>, reported strong upregulation of DNA repair genes after irradiation and described a separate tardigrade-specific protein involved in repair. <sup class="cite">5</sup> Tardigrades that lack Dsup can still be highly radiation-tolerant, so Dsup is not required for the trait across the phylum. <sup class="cite">6</sup></p>

<h4>Transfer to other organisms</h4>
<ul>
<li>Expression in plants (tobacco) has been reported to reduce DNA damage from mutagens and radiation. <sup class="cite">4</sup></li>
<li>Some studies in mammalian neurons reported that Dsup expression was harmful, causing cell death or degeneration, which suggests that coating chromatin interferes with normal gene regulation in some cell types.</li>
<li>Proposed applications include protecting cells for spaceflight and radiotherapy, but these remain speculative.</li>
</ul>

<h4>Limits</h4>
<ul>
<li>The 40% figure comes from cell culture under specific doses and assays; it is not a measure of whole-organism protection.</li>
<li>The in vitro protection was shown with chemically generated radicals; protection against direct ionisation is not well established.</li>
<li>The cost of Dsup to transcription and replication in non-tardigrade cells is not fully characterised.</li>
</ul>`,
      14: `<p>In much of later medieval Europe, apprenticeships were set out in a written contract, usually called an indenture in England, agreed between the master and the apprentice's parent or guardian. Terms were enforced through a mix of guild authority and civic courts: guild officials registered and supervised apprentices, and city courts heard disputes, with fines, cancellation of the contract and exclusion from the trade as the main sanctions.</p>

<h4>Form of the contract</h4>
<p>Practice varied by region, but common features appear across Italian, French and English evidence:</p>
<ul>
<li><b>Written instruments.</b> In Italian cities such as Genoa, notaries recorded apprenticeship contracts from the 13th century. <sup class="cite">2</sup> In England, the indenture was written twice on one sheet and cut along a wavy line, with each party keeping half so the halves could be matched as proof. <sup class="cite">1</sup></li>
<li><b>Parties.</b> The master on one side; the apprentice and usually a parent, guardian or sponsor on the other, since apprentices were often minors.</li>
<li><b>Premium.</b> The family frequently paid the master a fee, larger for prestigious trades.</li>
<li><b>Term.</b> Lengths varied widely. London custom generally required at least seven years for apprentices seeking the freedom of the city; elsewhere, terms of two to eight years appear, depending on trade and age.</li>
</ul>

<h4>Typical terms</h4>
<p>The master usually promised to:</p>
<ol>
<li>teach the trade fully, without concealing its methods;</li>
<li>provide food, lodging and often clothing;</li>
<li>discipline the apprentice reasonably.</li>
</ol>
<p>The apprentice promised to serve faithfully, keep the master's secrets, not damage or waste the master's goods, and refrain from gambling, frequenting taverns, marrying or leaving service before the term ended. Some contracts included a payment or tools at the end of the term.</p>

<h4>Guild regulation</h4>
<p>Guild statutes set rules that individual contracts had to follow. Étienne Boileau's <i>Livre des métiers</i>, compiled in Paris around 1268, records the regulations of roughly a hundred crafts, including the minimum term, the number of apprentices a master could take, and the fee. <sup class="cite">3</sup> Limits on the number of apprentices per master were common, partly to protect quality and partly to control entry to the trade. Guilds often required apprentices to be registered, and wardens could inspect workshops.</p>

<h4>Enforcement</h4>
<ul>
<li><b>Guild officers</b> settled many disputes internally, fined members who broke rules, and could refuse admission to the guild.</li>
<li><b>Civic courts</b> handled cases guilds could not resolve. In London, apprenticeships were enrolled with the Chamberlain at Guildhall, and the Chamberlain's and Mayor's courts heard complaints of mistreatment, failure to teach or desertion. Courts could release an apprentice, order repayment of the premium, or transfer the apprentice to another master. <sup class="cite">4</sup></li>
<li><b>Exclusion from the trade</b> was the strongest incentive. Completing an apprenticeship was the usual route to guild membership and, in England, to citizenship. A runaway apprentice risked losing that route; a master who broke guild rules risked fines or loss of the right to take apprentices or trade as a master.</li>
</ul>

<h4>How much was written down</h4>
<p>Written contracts survive in large numbers for Italian cities with notarial registers and for London, but many apprenticeships, especially in smaller towns and among relatives, were probably oral or informal. Historians such as Steven Epstein and S. R. Epstein have used the surviving contracts to argue that apprenticeship worked as a labour and training market, while Sheilagh Ogilvie has stressed guilds' role in restricting entry. <sup class="cite">5</sup><sup class="cite">6</sup></p>

<h4>What the sources disagree on</h4>
<ul>
<li>Whether guilds mainly guaranteed training quality or mainly limited competition.</li>
<li>How often apprentices completed their terms; English evidence from later centuries suggests many left early, but medieval completion rates are poorly documented.</li>
<li>How representative London, Paris and the Italian cities are of smaller towns.</li>
</ul>`,
      15: `<p>Norway has one of the highest heat-pump penetrations in the world, with estimates of homes that have at least one heat pump commonly put at around or above 60%. <sup class="cite">2</sup> Poland started from a low base dominated by coal and district heating, grew quickly from about 2020 on subsidies and air-quality rules, then slowed after 2022. The gap comes mainly from electricity prices, existing heating systems and housing stock rather than from climate. <sup class="cite">1</sup></p>

<h4>Norway's adoption path</h4>
<ul>
<li><b>Starting point.</b> Norwegian electricity has long come almost entirely from hydropower, and electric resistance heating was already common before 2010. A heat pump replaced an electric heater, so the switch did not require a new fuel connection.</li>
<li><b>Technology.</b> Most installations are air-to-air units, which are relatively cheap and can be added to an existing home without changing radiators.</li>
<li><b>Policy.</b> Enova, the state energy agency, has offered support, and a ban on fossil-oil heating in buildings took effect in 2020, which pushed remaining oil users toward heat pumps. <sup class="cite">3</sup></li>
<li><b>Result.</b> Sales per household have been among the highest in Europe for over a decade. <sup class="cite">6</sup> Growth now comes from replacements and from air-to-water and ground-source systems.</li>
</ul>

<h4>Poland's adoption path</h4>
<ul>
<li><b>Starting point.</b> Poland's electricity has been mostly coal-generated, and many single-family homes were heated by individual coal boilers. Cities rely heavily on district heating networks. <sup class="cite">7</sup></li>
<li><b>Air quality.</b> Smog from household coal burning drove regional anti-smog resolutions, starting with Kraków's ban on solid-fuel heating, which took full effect in 2019, and requirements elsewhere to replace old boilers.</li>
<li><b>Subsidies.</b> The national <i>Czyste Powietrze</i> (Clean Air) programme, launched in 2018, funded boiler replacement and insulation, with heat pumps an eligible option. <sup class="cite">4</sup> <i>Mój Prąd</i> supported rooftop solar, and later rounds added heat-pump support.</li>
<li><b>Boom and slowdown.</b> Sales grew rapidly in 2021 and 2022, when gas and coal prices rose after Russia's invasion of Ukraine. Industry figures show a significant fall in 2023 and 2024, linked to higher electricity prices, changes in subsidy rules and payment delays, and quality problems with some installations. <sup class="cite">5</sup></li>
</ul>

<h4>Side-by-side comparison</h4>
<table>
<thead><tr><th>Factor</th><th>Norway</th><th>Poland</th></tr></thead>
<tbody>
<tr><td>Main prior heating</td><td>Electric resistance, some oil and wood</td><td>Coal boilers, district heating, gas</td></tr>
<tr><td>Electricity source</td><td>Mostly hydropower</td><td>Mostly coal, rising renewables</td></tr>
<tr><td>Electricity vs fuel price</td><td>Low electricity cost relative to fuels</td><td>Electricity expensive relative to coal</td></tr>
<tr><td>Typical unit</td><td>Air-to-air</td><td>Air-to-water, replacing boilers</td></tr>
<tr><td>Main driver</td><td>Cost savings over resistance heating</td><td>Subsidies and anti-smog rules</td></tr>
</tbody>
</table>

<h4>Explaining the gap</h4>
<ol>
<li><b>Running cost.</b> A heat pump's economics depend on the ratio of electricity price to the price of the fuel it replaces. In Norway that ratio was favourable from the start; in Poland cheap coal made the case weak until fuel prices rose.</li>
<li><b>Installation cost.</b> Replacing a coal boiler typically needs an air-to-water system and often insulation and radiator changes, which costs much more than adding an air-to-air unit beside electric heaters.</li>
<li><b>Housing.</b> Many Polish urban households are in multi-family buildings on district heating, where individual heat pumps are rarely an option.</li>
<li><b>Climate is not the main factor.</b> Norway is colder on average than Poland, so climate would favour Poland, not Norway.</li>
</ol>

<h4>Limits</h4>
<ul>
<li>Norwegian penetration figures differ by source because some count any heat pump, including a single room unit, and others count primary heating.</li>
<li>Polish market data come mostly from industry associations and are revised; annual sales figures should be checked against the latest reports.</li>
<li>Sales and installed stock are different measures; Poland's stock remains small relative to its housing even after the 2021-2022 growth.</li>
</ul>`,
      16: `<p>After Houston extended its exemption from off-street parking minimums from the downtown core to the East Downtown (EaDo) and Midtown areas in 2019, developers built a number of projects with fewer spaces than the old rules would have required, including small-lot infill and conversions of existing buildings. Most new projects still included some parking. Analyses so far find effects concentrated within the reform area, with little evidence of spillover elsewhere in the city.</p>

<h4>The rules before reform</h4>
<p>Houston is known for having no conventional zoning code, but it does regulate development through other ordinances, including lot sizes, setbacks and off-street parking requirements. The parking ordinance set minimum numbers of spaces by land use, such as a fixed number per dwelling unit or per thousand square feet of restaurant or office space. <sup class="cite">2</sup> The central business district had long been exempt. Outside it, the minimums made many small or older lots hard to redevelop, because the required parking took up much of the site. <sup class="cite">1</sup></p>

<h4>What changed in 2019</h4>
<ul>
<li>City Council voted to remove parking minimums in EaDo, east of downtown, and in Midtown, south of downtown, adding to the existing downtown exemption. <sup class="cite">1</sup></li>
<li>Developers there could choose how much parking to provide, including none, rather than meeting a required ratio.</li>
<li>The change was part of a broader effort, later including the city's Walkable Places and transit-oriented development rules, to support denser, pedestrian-oriented areas near transit lines. <sup class="cite">3</sup></li>
</ul>

<h4>Observed effects</h4>
<ol>
<li><b>Fewer spaces per project.</b> Studies of permits and site plans after the reform found many projects providing less parking than the former minimum. Projects that would previously have needed variances could proceed by right. <sup class="cite">4</sup></li>
<li><b>Small-lot and adaptive reuse.</b> Removing the requirement made it feasible to convert older commercial buildings, such as warehouses, into restaurants, offices and housing without acquiring adjacent land for parking.</li>
<li><b>Parking still built.</b> Most larger projects continued to include parking, because lenders, tenants and buyers expected it. The reform mainly changed the amount and allowed exceptions, rather than eliminating parking.</li>
<li><b>Effects stayed local.</b> Comparisons with similar areas outside the reform boundary found no clear change in parking provision there, which is expected since the rules there did not change.</li>
</ol>

<h4>Related Houston reforms</h4>
<p>The parking change followed an earlier Houston reform: in 1998 the city cut the minimum lot size for single-family homes inside Loop 610 to 1,400 square feet, later extended to other areas. That reform is widely credited with producing large numbers of townhouses. <sup class="cite">5</sup> Researchers often discuss the two together as examples of how Houston allows infill through targeted rule changes rather than rezoning.</p>

<h4>Why it matters beyond Houston</h4>
<p>Parking minimums have been criticised by Donald Shoup and others for raising the cost of housing and business space and for encouraging car use. <sup class="cite">6</sup> A growing number of US cities, including Buffalo, Minneapolis and San Jose, have removed minimums citywide or in large areas. <sup class="cite">7</sup> Houston's case is cited because it shows how developers respond when required parking is removed but demand for parking remains.</p>

<h4>Limits</h4>
<ul>
<li>The reform area is small, and the post-reform period overlapped with the COVID-19 pandemic and interest-rate changes, which makes it hard to separate the reform's effect from market conditions.</li>
<li>Available studies count projects and spaces; evidence on rents, housing prices and street parking congestion is limited.</li>
<li>Some projects might have been built anyway with variances, so counting all reduced-parking projects as caused by the reform would overstate its effect.</li>
</ul>`,
      29: `<p>Yes. Since Sablefield 4.2 you can pin a read replica to one region with <code>--pin-region</code>. A pinned replica stays in that region during failover and is not moved by automatic placement. <sup class="cite">1</sup></p>
<h4>Create a pinned replica</h4>
<pre><code>sable replicas create --project acme-prod --pin-region eu-central-2</code></pre>
<p>To pin an existing replica, run <code>sable replicas update &lt;replica-id&gt; --pin-region eu-central-2</code>. The replica restarts once, which usually takes under a minute. <sup class="cite">1</sup></p>
<h4>What changed in 4.2</h4>
<p>Before 4.2 the flag was <code>--region</code>. It only set the initial placement, and replicas could move during failover. <code>--region</code> still works but is deprecated and prints a warning. <sup class="cite">2</sup></p>
<h4>Limits</h4>
<ul><li>Pinning is available on the Team and Enterprise plans. <sup class="cite">1</sup></li><li>A project can pin up to 5 replicas per region. <sup class="cite">1</sup></li><li>In the API, set <code>pin_region</code> on <code>POST /v1/replicas</code>. <sup class="cite">3</sup></li></ul>`,
      30: `<p><code>E_SYNC_SCOPE</code> means the rule's query can return rows outside the scope the rule declares. Sablefield checks this when the rule is deployed, not when clients sync, so the deploy fails before any client is affected. <sup class="cite">1</sup></p>
<h4>Common causes</h4>
<ol><li>The <code>where</code> clause does not filter on the scope column. A rule with <code>scope: user</code> must filter by <code>auth.user_id()</code>. <sup class="cite">1</sup></li><li>A subquery reads from a table that has no scope column. <sup class="cite">2</sup></li><li>The rule uses <code>or</code> with a branch that does not reference the scope. <sup class="cite">2</sup></li></ol>
<h4>Example</h4>
<pre><code>-- fails with E_SYNC_SCOPE
select * from notes where archived = false;

-- passes
select * from notes where owner_id = auth.user_id() and archived = false;</code></pre>
<p>Run <code>sable rules check</code> locally to get the same error with a line number before you deploy. <sup class="cite">3</sup></p>`,
      31: `<p>When a project on the Free plan goes over 100,000 rows, inserts fail with <code>E_PLAN_LIMIT</code>. Reads, updates and deletes keep working, and no data is removed. <sup class="cite">1</sup></p>
<p>Sablefield emails the project owners when the project reaches 80% and 100% of the limit. <sup class="cite">2</sup></p>
<p>To add rows again, delete data or upgrade to the Team plan. The limit is lifted within a minute of the upgrade. <sup class="cite">1</sup></p>`,
      32: `<p>Create a second service key, deploy it, then revoke the old one. Sablefield accepts both keys while both exist, so requests do not fail during the switch. <sup class="cite">1</sup></p>
<ol><li>Create a new key: <code>sable keys create --role service --name service-2026-11</code>. <sup class="cite">1</sup></li><li>Update the secret in every server and job that uses it, and deploy.</li><li>Check that the old key is no longer used. <code>sable keys usage &lt;old-key-id&gt;</code> shows the time of its last request. <sup class="cite">2</sup></li><li>Revoke the old key: <code>sable keys revoke &lt;old-key-id&gt;</code>.</li></ol>
<p>A project can have up to 10 active service keys. A revoked key stops working in all regions within 30 seconds. <sup class="cite">3</sup></p>`,
      33: `<p>Yes. The Swift SDK stores writes in a local queue while the device is offline and sends them in order when it reconnects. <sup class="cite">1</sup></p>
<p>The queue holds up to 10,000 writes. After that, new writes throw <code>SableError.queueFull</code>. <sup class="cite">1</sup></p>
<p>Conflicts are resolved with last-write-wins per column. <sup class="cite">2</sup></p>`,
      50: `<p>Not as stated. The paragraph gives 3.1 times the accuracy per dollar of the no-reasoning baseline on math and attributes the figure to the appendix table of Halvorsen et al. <sup class="cite mi-cite" data-miref="m2:6" title="Where test-time compute stops paying, paragraph 5">¶5</sup></p>
<p>That table reports accuracy and the number of reasoning tokens for each configuration, not cost. <sup class="cite">1</sup> Converting the token counts with the list prices the article uses earlier <sup class="cite mi-cite" data-miref="m2:3" title="Where test-time compute stops paying, paragraph 3">¶3</sup> gives about 2.4 times for the best math configuration. 3.1 is the ratio of accuracies at equal token budgets, which is a different quantity. <sup class="cite">1</sup></p>
<p>The knowledge-heavy figure of 1.4 times is consistent with the same table under either reading. <sup class="cite">1</sup> The argument of the article does not depend on the exact math figure: the flat region it describes <sup class="cite mi-cite" data-miref="m2:5" title="Where test-time compute stops paying, paragraph 4">¶4</sup> appears with 2.4 as well.</p>`,
      51: `<p>The thread makes three checkable claims. Two have been checked by the benchmark maintainers; one has not been checked by anyone else yet.</p>
<table><thead><tr><th>Claim</th><th>Checked by</th><th>Result</th></tr></thead><tbody>
<tr><td>41% of problems have a public near-duplicate <sup class="cite mi-cite" data-miref="m1:2" title="I spent the weekend checking RB-2, the reasoning benchmark that most launch posts cited…, post 3">3/7</sup></td><td>Orbit Lab <sup class="cite mi-cite mi-cx" data-miref="m5:1" title="RB-2: our response to the contamination report, paragraph 2">Orbit ¶2</sup></td><td>Agree with 298 of 492 matches; dispute 194</td></tr>
<tr><td>Some problems come from a 2019 olympiad forum <sup class="cite mi-cite" data-miref="m1:4" title="I spent the weekend checking RB-2, the reasoning benchmark that most launch posts cited…, post 5">5/7</sup></td><td>Orbit Lab <sup class="cite mi-cite mi-cx" data-miref="m5:1" title="RB-2: our response to the contamination report, paragraph 2">Orbit ¶2</sup></td><td>Confirmed: a contractor adapted public problems</td></tr>
<tr><td>The 47% with no match keeps the model ranking <sup class="cite mi-cite" data-miref="m1:6" title="I spent the weekend checking RB-2, the reasoning benchmark that most launch posts cited…, post 7">7/7</sup></td><td>Nobody yet</td><td>The match list is public, so this can be checked <sup class="cite">1</sup></td></tr>
</tbody></table>
<p>The search script reproduces on the author’s published match list. <sup class="cite">1</sup> No independent re-run has been published so far. <sup class="cite">2</sup></p>`,
      52: `<p>Both sides agree on the 298 matches that came from adapted public problems. <sup class="cite mi-cite mi-cx" data-miref="m5:1" title="RB-2: our response to the contamination report, paragraph 2">Orbit ¶2</sup> The disagreement is about the remaining 194.</p>
<h4>What each side says</h4>
<ul><li>The thread counts a problem as contaminated when a public problem has the same numbers and the same answer. <sup class="cite mi-cite mi-cx" data-miref="m1:2" title="I spent the weekend checking RB-2, the reasoning benchmark that most launch posts cited…, post 3">Tamsin 3/7</sup></li><li>Orbit Lab says the 194 share only a standard setup, such as drawing cards, and ask different questions. <sup class="cite mi-cite mi-cx" data-miref="m5:2" title="RB-2: our response to the contamination report, paragraph 3">Orbit ¶3</sup></li></ul>
<h4>Evidence</h4>
<p>The thread publishes the match list and the script, with 31 borderline cases marked for review. <sup class="cite mi-cite mi-cx" data-miref="m1:5" title="I spent the weekend checking RB-2, the reasoning benchmark that most launch posts cited…, post 6">Tamsin 6/7</sup> The response does not publish its own review of the 194; it says a per-problem decontamination report will come with RB-2.1 on Dec 1. <sup class="cite mi-cite mi-cx" data-miref="m5:3" title="RB-2: our response to the contamination report, paragraph 4">Orbit ¶4</sup></p>
<p>Until that report is out, the 194 cannot be checked from Orbit Lab’s side. The match list is enough to sample them. <sup class="cite">1</sup></p>`,
      53: `<p>Probably “Same structure, new numbers” by Achebe and Lund (2026). It rewrote every problem of a math benchmark with new numbers and the same structure, as Feld describes. <sup class="cite mi-cite" data-miref="m4:4" title="Evals after saturation, 14:02">14:02</sup> <sup class="cite">1</sup></p>
<p>The paper reports drops of 4 to 19 points across the models it tested. <sup class="cite">1</sup> Feld rounds this to between five and twenty. No other paper from this spring matches the description. <sup class="cite">2</sup></p>`,
      54: `<p>For a closed model, FLOPs per problem cannot be computed as the post proposes <sup class="cite mi-cite" data-miref="m3:3" title="Thinking tokens are not a unit of compute, paragraph 4">¶4</sup>, because the parameter count and how the context is processed are not published.</p>
<p>Two papers bound it instead: one from measured latency on known hardware, one from the price per token. <sup class="cite">1</sup> <sup class="cite">2</sup> Both give ranges of about three times, which is still enough to separate parallel sampling from long sequential traces <sup class="cite mi-cite" data-miref="m3:2" title="Thinking tokens are not a unit of compute, paragraph 3">¶3</sup>.</p>`,
      55: `<p>On a random sample of 200 problems, the published script reproduces 79 of the 82 matches reported for those problems. <sup class="cite mi-cite" data-miref="m1:5" title="I spent the weekend checking RB-2, the reasoning benchmark that most launch posts cited…, post 6">6/7</sup> <sup class="cite">1</sup></p>
<p>The three differences are problems that the author marked as borderline in the manual review. The sample is consistent with the 41% figure <sup class="cite mi-cite" data-miref="m1:2" title="I spent the weekend checking RB-2, the reasoning benchmark that most launch posts cited…, post 3">3/7</sup>.</p>`,
    },
    srcd: {
      0: [
        ['Down and Out in the Magic Kingdom', 'en.wikipedia.org', 'Whuffie as a reputation currency'],
        ['Accelerando', 'antipope.org', 'Author\'s free online edition'],
        ['The Shockwave Rider', 'en.wikipedia.org', 'Delphi pools as public forecasting'],
        ['Shall We Vote on Values, But Bet on Beliefs?', 'mason.gmu.edu', 'Hanson, futarchy proposal'],
        ['Economics (theme entry)', 'sf-encyclopedia.com', 'Survey of economic systems in SF'],
        ['Maneki Neko (short story)', 'en.wikipedia.org', 'Sterling, gift-economy network'],
        ['The Intention Economy', 'hbr.org', 'Searls, origin of the term'],
      ],
      2: [
        ['Dagen H', 'en.wikipedia.org', 'Overview, timeline and figures'],
        ['Högertrafikomläggningen', 'ne.se', 'Nationalencyklopedin entry'],
        ['Statens högertrafikkommission archive', 'riksarkivet.se', 'Commission records'],
        ['Dagen H photographs and objects', 'digitaltmuseum.se', 'Campaign material and street photos'],
        ['Traffic safety statistics, historical', 'trafa.se', 'Trafikanalys long-run accident series'],
        ['H-dagurinn', 'en.wikipedia.org', 'Iceland\'s 1968 switch'],
      ],
      3: [
        ['UNCTADstat: Port calls and performance statistics', 'unctadstat.unctad.org', 'Median time in port by economy'],
        ['The Container Port Performance Index', 'worldbank.org', 'Annual port ranking with port hours'],
        ['IMF PortWatch', 'portwatch.imf.org', 'Daily port calls from satellite AIS'],
        ['Port Performance Freight Statistics Program', 'bts.gov', 'US vessel dwell times'],
        ['MarineCadastre AIS Vessel Traffic Data', 'marinecadastre.gov', 'US AIS archive from 2009'],
        ['AIS data', 'dma.dk', 'Danish Maritime Authority historical AIS'],
      ],
      5: [
        ['Banach–Tarski paradox', 'en.wikipedia.org', 'Statement and proof outline'],
        ['The Banach–Tarski Paradox (Tomkowicz and Wagon, 2nd ed.)', 'cambridge.org', 'Standard monograph'],
        [
          'Sur la décomposition des ensembles de points en parties respectivement congruentes',
          'eudml.org',
          'Banach and Tarski, Fundamenta Mathematicae, 1924',
        ],
        ['Grundzüge der Mengenlehre', 'archive.org', 'Hausdorff, 1914, sphere paradox'],
        ['A model of set-theory in which every set of reals is Lebesgue measurable', 'jstor.org', 'Solovay, Annals of Mathematics, 1970'],
        ['The Hahn–Banach theorem implies the Banach–Tarski paradox', 'eudml.org', 'Pawlikowski, Fundamenta Mathematicae, 1991'],
        ['Amenable group', 'en.wikipedia.org', 'Why dimensions 1 and 2 differ'],
      ],
      6: [
        ['Accelerando', 'en.wikipedia.org', 'Plot summary and publication history of the stories'],
        ['Maneki Neko (short story)', 'isfdb.org', 'Publication record for Sterling\'s story'],
        ['Daemon (novel)', 'en.wikipedia.org', 'Summary of the distributed-agent premise'],
        ['The Quantum Thief', 'en.wikipedia.org', 'Gevulot, gogols and the Oubliette economy'],
        ['The Paper Menagerie and Other Stories', 'simonandschuster.com', 'Collection that includes "The Perfect Match"'],
        ['Fall; or, Dodge in Hell', 'en.wikipedia.org', 'Editors and filtered feeds'],
        ['Agents that negotiate: a survey', 'arxiv.org', 'Background on automated negotiation research'],
      ],
      8: [
        ['2001: A Space Odyssey (film)', 'en.wikipedia.org', 'Picturephone scene and production notes'],
        ['The Machine Stops', 'en.wikipedia.org', 'Forster\'s 1909 story and its video plates'],
        ['The Naked Sun', 'en.wikipedia.org', 'Viewing versus seeing on Solaria'],
        ['Picturephone', 'en.wikipedia.org', 'World\'s Fair demo, Pittsburgh launch and withdrawal'],
        ['Picturephone', 'ethw.org', 'Engineering and Technology History Wiki account'],
        ['Nonverbal overload: A theoretical argument for the causes of Zoom fatigue', 'tmb.apa.org', 'Bailenson, 2021'],
        ['FaceTime', 'en.wikipedia.org', 'Launch and adoption'],
      ],
      9: [
        ['Snow Crash', 'en.wikipedia.org', 'Coinage and description of the Street'],
        ['Metaverse', 'en.wikipedia.org', 'Overview of the term\'s history'],
        ['Metaverse Roadmap: Pathways to the 3D Web', 'metaverseroadmap.org', 'Acceleration Studies Foundation, broad definition'],
        ['The Metaverse: And How It Will Revolutionize Everything', 'wwnorton.com', 'Matthew Ball, 2022'],
        ['Introducing Meta: A Social Technology Company', 'about.fb.com', 'Rebrand announcement, October 2021'],
        ['Roblox Corporation Form S-1', 'sec.gov', '2021 filing that uses the term'],
        ['Meta Platforms quarterly reports', 'investor.atmeta.com', 'Reality Labs operating results'],
      ],
      11: [
        ['How does UMA\'s Optimistic Oracle work?', 'docs.uma.xyz', 'Proposal, dispute bonds and DVM voting'],
        ['Polymarket market resolution', 'docs.polymarket.com', 'Resolution process and clarifications'],
        ['Kalshi Rulebook', 'kalshi.com', 'Contract terms and exchange determinations'],
        ['Augur: a Decentralized Oracle and Prediction Market Platform', 'arxiv.org', 'Reporting, disputes and the invalid outcome'],
        ['Manifold FAQ: resolving markets', 'docs.manifold.markets', 'Creator resolution and N/A'],
        ['Metaculus FAQ: annulled questions', 'metaculus.com', 'Handling of unresolvable questions'],
        ['Prediction market', 'en.wikipedia.org', 'Overview of market types and history'],
      ],
      12: [
        [
          'Scaling LLM Test-Time Compute Optimally can be More Effective than Scaling Model Parameters',
          'arxiv.org',
          'Snell et al., 2024; compute-optimal inference strategies',
        ],
        ['Learning to Reason with LLMs', 'openai.com', 'o1 announcement with train- and test-time scaling plots'],
        ['DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning', 'arxiv.org', 'RL with verifiable rewards; R1-Zero'],
        ['s1: Simple test-time scaling', 'arxiv.org', 'Muennighoff et al., 2025; budget forcing'],
        ['The Illusion of Thinking', 'machinelearning.apple.com', 'Puzzle-based study of reasoning collapse'],
        ['Reasoning models don\'t always say what they think', 'anthropic.com', 'Faithfulness of chain-of-thought'],
        [
          'Does Reinforcement Learning Really Incentivize Reasoning Capacity in LLMs Beyond the Base Model?',
          'arxiv.org',
          'pass@k comparison of base and RL models',
        ],
        ['Where test-time compute stops paying', 'gradientnotes.substack.com', 'Priya Venn, Gradient Notes; accuracy per dollar by reasoning length'],
      ],
      13: [
        [
          'Extremotolerant tardigrade genome and improved radiotolerance of human cultured cells by tardigrade-unique protein',
          'nature.com',
          'Hashimoto et al., Nature Communications, 2016',
        ],
        ['Radiation biology: direct and indirect effects', 'ncbi.nlm.nih.gov', 'Background on hydroxyl-radical damage'],
        [
          'The tardigrade damage suppressor protein binds to nucleosomes and protects DNA from hydroxyl radicals',
          'elifesciences.org',
          'Chavez et al., eLife, 2019',
        ],
        ['Dsup', 'en.wikipedia.org', 'Overview, structure and follow-up studies'],
        ['Multi-omic analysis of a tardigrade species reveals radiation-tolerance mechanisms', 'science.org', 'H. henanensis study, 2024'],
        ['Tardigrade', 'en.wikipedia.org', 'Stress tolerance across species'],
      ],
      14: [
        ['Apprenticeship', 'en.wikipedia.org', 'History of indentures and terms'],
        ['Wage Labor and Guilds in Medieval Europe', 'uncpress.org', 'Steven A. Epstein, 1991'],
        ['Livre des métiers', 'fr.wikipedia.org', 'Paris craft regulations, c. 1268'],
        ['London in the Later Middle Ages: Government and People', 'global.oup.com', 'Caroline Barron, 2004; civic enrolment and courts'],
        [
          'Craft Guilds, Apprenticeship, and Technological Change in Preindustrial Europe',
          'cambridge.org',
          'S. R. Epstein, Journal of Economic History, 1998',
        ],
        ['The European Guilds: An Economic Analysis', 'press.princeton.edu', 'Sheilagh Ogilvie, 2019'],
      ],
      15: [
        ['The Future of Heat Pumps', 'iea.org', 'IEA special report, 2022; country comparisons'],
        ['Energy use in households', 'ssb.no', 'Statistics Norway heating surveys'],
        ['Enova support programmes', 'enova.no', 'Norwegian state energy agency'],
        ['Czyste Powietrze programme', 'czystepowietrze.gov.pl', 'Polish national boiler-replacement subsidy'],
        ['Heat pump market data', 'portpc.pl', 'Polish heat-pump industry association'],
        ['European Heat Pump Market Report', 'ehpa.org', 'Sales per household by country'],
        ['Heating in Poland', 'forum-energii.eu', 'Analysis of household heating and coal use'],
      ],
      16: [
        ['Off-Street Parking Requirements', 'houstontx.gov', 'Houston Planning and Development Department'],
        ['Parking mandates', 'en.wikipedia.org', 'Background on minimum parking requirements'],
        ['Walkable Places and Transit-Oriented Development', 'houstontx.gov', 'Related Houston ordinances'],
        ['How Houston Has Removed Parking Minimums', 'mercatus.org', 'Analysis of post-reform projects'],
        ['Houston\'s Minimum Lot Size Reform', 'kinder.rice.edu', 'Kinder Institute research on the 1998 reform'],
        ['The High Cost of Free Parking', 'routledge.com', 'Donald Shoup, 2005'],
        ['Parking Reform Map', 'parkingreform.org', 'US cities that have removed minimums'],
      ],
      29: [
        ['Read replicas › Region pinning', 'docs.sablefield.dev', 'Documentation'],
        ['Release 4.2.0', 'sablefield.dev', 'Changelog'],
        ['POST /v1/replicas', 'api.sablefield.dev', 'API reference'],
      ],
      30: [
        ['Sync rules › Scopes', 'docs.sablefield.dev', 'Documentation'],
        ['Fixing sync rule deploy errors', 'help.sablefield.dev', 'Help center'],
        ['CLI reference: sable rules check', 'github.com', 'sablefield/sablefield'],
      ],
      31: [
        ['Plan limits', 'help.sablefield.dev', 'Help center'],
        ['Usage emails', 'help.sablefield.dev', 'Help center'],
        ['Pricing', 'sablefield.dev', 'Website'],
      ],
      32: [
        ['API keys › Rotating keys', 'docs.sablefield.dev', 'Documentation'],
        ['CLI: sable keys usage', 'docs.sablefield.dev', 'Documentation'],
        ['Limits', 'api.sablefield.dev', 'API reference'],
      ],
      33: [['Offline writes in the Swift SDK', 'help.sablefield.dev', 'Help center'], ['Conflict resolution', 'docs.sablefield.dev', 'Documentation']],
      50: [['Scaling test-time search (Halvorsen et al.), Table 3 and appendix C', 'arxiv.org', '']],
      51: [['rb2-matches: match list and search script', 'github.com', ''], ['Search: RB-2 contamination replication', 'web search', '']],
      52: [['rb2-matches: match list and search script', 'github.com', '']],
      53: [
        ['Same structure, new numbers (Achebe and Lund, 2026)', 'arxiv.org', ''],
        ['Search: rewritten math benchmark new numbers 2026', 'web search', ''],
      ],
      54: [
        ['Estimating inference FLOPs from latency (Ortiz, 2026)', 'arxiv.org', ''],
        ['What does a reasoning token cost? (Nakamura, 2026)', 'arxiv.org', ''],
      ],
      55: [['rb2-matches: match list and search script', 'github.com', '']],
    },
    fu: {
      0: [
        {
          u: 'hal_b',
          age: '3m',
          q: 'Which of these treat intentions as tradeable rather than just visible?',
          a: 'Accelerando and Daemon do: agents and participants bid on tasks and outcomes. In Down and Out in the Magic Kingdom intentions are only visible through Whuffie, which cannot be spent directly.',
          html: `<p>Few of these works go past visibility to actual trade. Three treat intentions or commitments as things that can be exchanged:</p>
<ul>
<li><i>Accelerando</i>: software agents negotiate and contract with each other for their principals, and late in the book whole corporate entities trade in ways that humans cannot follow.</li>
<li><i>Daemon</i> and <i>Freedom</i>: participants take on tasks and receive credits and rank for completing them, which works as a labour market for stated goals.</li>
<li><i>The Shockwave Rider</i>: Delphi pools price beliefs about the future, and those prices are used to make decisions.</li>
</ul>
<p>In <i>Down and Out in the Magic Kingdom</i>, Whuffie shows esteem but cannot be transferred, so it records intentions rather than trading them. "Maneki Neko" falls between the two: favours are routed and reciprocated, but no prices or balances are shown.</p>`,
        },
        {
          u: 'jun.park',
          age: '2m',
          q: 'Any non-English examples?',
          a: 'This scan only covered English-language works. I can run a second pass on translated fiction.',
          html: `<p>The scan was limited to English-language works and widely available translations. A few candidates for a second pass:</p>
<ul>
<li>Stanisław Lem's satirical fiction, which often treats institutions and economies as systems running on their own logic.</li>
<li>Hannu Rajaniemi wrote <i>The Quantum Thief</i> in English, but its setting draws on Finnish and Russian sources. It is listed above already.</li>
<li>Chinese science fiction in translation, such as the anthologies edited by Ken Liu, includes several stories about platform labour and rating systems.</li>
</ul>
<p>A proper pass would also search French and German SF databases, which list many works that have never been translated.</p>`,
        },
        {
          u: 'ines.v',
          age: '1m',
          q: 'Group them by decade instead.',
          a: '1950s to 1980s: 4 works, mostly satire of advertising. 1990s and 2000s: 15, centred on reputation and agents. 2010s and 2020s: 12, centred on platforms and prediction markets.',
          html: `<p>Grouped by decade, the 31 works show the focus moving from advertising, to reputation and agents, to platforms:</p>
<ul>
<li><b>1950s to 1980s (4 works).</b> Mostly satires of advertising and consumption, such as <i>The Space Merchants</i> and "The Midas Plague". <i>The Shockwave Rider</i> is the main exception, with a working forecasting market.</li>
<li><b>1990s and 2000s (15).</b> Reputation currencies and software agents dominate, as in "Maneki Neko", <i>Down and Out in the Magic Kingdom</i>, <i>Accelerando</i>, <i>Daemon</i> and <i>Rainbows End</i>.</li>
<li><b>2010s and 2020s (12).</b> Platform ratings, engagement metrics and prediction markets, as in <i>The Circle</i>, "Nosedive", <i>Infomocracy</i> and <i>Walkaway</i>.</li>
</ul>
<p>The shift follows real technology closely: early web reputation systems in the late 1990s, then smartphone platforms and public betting markets from the 2010s on.</p>`,
        },
      ],
      2: [
        {
          u: 'hal_b',
          age: '50m',
          q: 'Why did the referendum result get overridden?',
          a: 'The 1955 referendum was advisory, and by 1963 rising car ownership and the cost of delay persuaded the Riksdag to legislate the change anyway.',
          html: `<p>The 1955 referendum was consultative, so the result did not bind the Riksdag. Several factors led parliament to legislate the change in 1963:</p>
<ul>
<li>Car ownership was rising quickly, so every year of delay meant more vehicles, signs and junctions to convert later.</li>
<li>Most cars in Sweden were already left-hand drive, which made overtaking on the left-hand side of the road harder.</li>
<li>Cross-border traffic with Norway and Finland was increasing, and both countries drove on the right.</li>
</ul>
<p>The decision received cross-party support. Parties that favoured the change argued that safety and cost justified going against the referendum. Accounts disagree on how much public opinion had changed by 1967, and the information campaign was partly a response to that uncertainty.</p>`,
        },
        {
          u: 'lettie',
          age: '30m',
          q: 'What happened to buses and trams?',
          a: 'Many buses were converted or replaced to move doors to the right side, and Stockholm used the switch to close several tram lines in favour of buses.',
          html: `<p>Public transport accounted for much of the cost of the switch.</p>
<ul>
<li><b>Buses.</b> Doors were on the left, the kerb side under left-hand traffic. Operators converted many buses by moving the doors, and replaced others with new right-hand-door vehicles that were ordered in advance.</li>
<li><b>Trams.</b> Single-ended trams with doors on one side could not easily be converted. Stockholm closed most of its tram network around the time of the switch and replaced it with buses or the expanding metro. Gothenburg and Norrköping kept their trams and adapted them.</li>
<li><b>Stops and terminals.</b> Bus stops and platforms had to move to the opposite side of the street, which was one reason city traffic bans lasted longer than the national one.</li>
</ul>
<p>The precise number of buses converted versus replaced differs between sources.</p>`,
        },
      ],
      3: [
        {
          u: 'mira_k',
          age: '1h',
          q: 'How hard is it to get dwell times out of the NOAA AIS files?',
          a: 'Moderately hard: the files are large daily or monthly CSVs, and you need port polygons, a ship-type filter and event detection to turn positions into calls.',
          html: `<p>The task is manageable but takes some setup. The main steps:</p>
<ul>
<li><b>Volume.</b> Files are published by day or by zone, and a single year of US coverage reaches hundreds of gigabytes uncompressed. Loading them into a columnar format such as Parquet makes filtering much faster.</li>
<li><b>Ship type.</b> AIS type code 70–79 covers all cargo ships, not only container ships. A separate registry lookup by IMO number is needed to isolate container vessels.</li>
<li><b>Geometry.</b> Ports do not publish standard polygons, so berth and anchorage areas usually have to be drawn by hand, often from nautical charts.</li>
<li><b>Events.</b> A common rule treats speed below about 0.5 knots inside an anchorage polygon as waiting and the same speed inside a berth polygon as alongside.</li>
</ul>
<p>Open-source libraries for AIS trajectory processing can handle the event-detection step.</p>`,
        },
        {
          u: 'hal_b',
          age: '45m',
          q: 'Can any of these show the 2021 LA/Long Beach queue?',
          a: 'Yes: NOAA AIS covers it at vessel level, PortWatch and BTS show it in aggregate, and the Marine Exchange of Southern California published daily queue counts.',
          html: `<p>Yes. Several sources cover the 2021–2022 San Pedro Bay queue from different angles:</p>
<ul>
<li><b>NOAA AIS.</b> It shows the individual ships at anchor and, later, in the holding zones offshore. Ships moved further out after the queuing system changed in late 2021, so the analysis polygons have to be widened to capture them.</li>
<li><b>Marine Exchange of Southern California.</b> It published daily counts of ships waiting during the congestion period. These counts are the figures most news reports used.</li>
<li><b>BTS and PortWatch.</b> Both show the rise and fall in aggregate dwell or call numbers.</li>
</ul>
<p>The queuing system change matters for any analysis: after it, many ships waited far offshore or slow-steamed instead of anchoring. Using anchorage-only metrics therefore makes the queue look smaller than it was.</p>`,
        },
      ],
      5: [
        {
          u: 'tomasz',
          age: '2h',
          q: 'Why does it work in 3D but not in the plane?',
          a: 'The rotation group of the sphere contains a free group on two generators, while the isometry group of the plane is solvable and therefore amenable, so a finitely additive invariant measure on all sets exists there.',
          html: `<p>The answer depends on the structure of the isometry group in each dimension.</p>
<ul>
<li><b>Three dimensions.</b> SO(3) contains a free subgroup on two generators. Free groups are not amenable, and that allows the paradoxical decomposition.</li>
<li><b>One and two dimensions.</b> The isometry groups are solvable. Solvable groups are amenable, and amenability guarantees a finitely additive, isometry-invariant measure defined on all bounded subsets that gives the unit square measure 1. Banach proved this for the line and the plane in 1923. Such a measure rules out any doubling of the square or disc.</li>
</ul>
<p>The planar version of the paradox is false, although the plane still has related results. The plane does allow a paradox if area-preserving affine maps are used instead of isometries, because that group contains free subgroups.</p>`,
        },
        {
          u: 'mira_k',
          age: '1h',
          q: 'Is there a version that does not need choice at all?',
          a: 'Not for the doubling of the ball: in Solovay\'s model without full choice it fails. But Marks and Unger (2017) showed circle-squaring can be done with Borel pieces, without choice.',
          html: `<p>For doubling the ball, no. Any proof needs some non-constructive principle. Solovay's model shows that ZF plus dependent choice cannot prove the paradox, assuming that an inaccessible cardinal is consistent.</p>
<p>Related results show how much choice each statement actually needs:</p>
<ul>
<li><b>Pawlikowski (1991).</b> The Hahn–Banach theorem is enough. It is strictly weaker than the full axiom of choice.</li>
<li><b>Laczkovich (1990).</b> A disc and a square of equal area are equidecomposable by translations alone, which solves Tarski's circle-squaring problem. The original proof used choice.</li>
<li><b>Marks and Unger (2017).</b> Circle-squaring can be done with Borel pieces, which needs no choice. Later work showed that the pieces can be made even better behaved.</li>
</ul>
<p>The difference is that circle-squaring preserves area, while Banach–Tarski doubles volume. Doubling requires non-measurable pieces.</p>`,
        },
      ],
      6: [
        {
          u: 'tomasz',
          age: '25m',
          q: 'Which of these show the actual back-and-forth of a negotiation, not just the result?',
          a: 'Very few; Accelerando comes closest, and most others report outcomes rather than offers and counter-offers.',
          html: `<p>Very few. Most works describe the result of a deal rather than the exchange that produced it.</p>
<ul>
<li><i>Accelerando</i> comes closest: several scenes show Manfred's agents proposing and restructuring arrangements in near real time, though the text summarises more than it dramatises.</li>
<li><i>The Perfect Match</i> shows the assistant steering choices step by step, but its counterpart is the user, not another agent.</li>
<li><i>The Quantum Thief</i> shows gevulot permissions being granted and withheld between characters, which is a negotiation over information, conducted mostly by implants.</li>
</ul>
<p>Agent-to-agent bargaining with explicit offers is more common in technical writing on automated negotiation than in fiction, likely because it is hard to dramatise.</p>`,
        },
        {
          u: 'oduya',
          age: '15m',
          q: 'Is there anything where the agent is legally liable for what it agrees to?',
          a: 'Not as a central theme; the fiction mostly ignores liability, and Accelerando touches it only through agent-run corporations.',
          html: `<p>Not as a central theme in the works found. Liability for an agent's commitments is mostly ignored.</p>
<p>The nearest cases:</p>
<ul>
<li><i>Accelerando</i> gives agents legal standing indirectly by wrapping them in corporations, which can hold assets and enter contracts.</li>
<li><i>The Lifecycle of Software Objects</i> raises whether the digients can be parties to agreements, but from the side of their rights rather than their obligations.</li>
</ul>
<p>Outside fiction, the question is usually framed through the law of agency: a principal is generally bound by what an authorised agent agrees to. How that applies to software agents remains an open legal question in most jurisdictions.</p>`,
        },
      ],
      8: [
        {
          u: 'lettie',
          age: '3h',
          q: 'Did anyone at the time predict that people would turn the camera off?',
          a: 'Few did directly; the Picturephone trials surfaced the reluctance, and Asimov and the Jetsons gestured at it.',
          html: `<p>Not many writers did directly. The clearest evidence of the reluctance came from the Picturephone itself rather than from fiction.</p>
<ul>
<li>Bell's own trials and the Pittsburgh service showed low use, and later accounts cite discomfort with being seen as one factor alongside price.</li>
<li>In fiction, the Jetsons mask gag and Asimov's Solarian etiquette are the closest anticipations.</li>
</ul>
<p>The "camera off" norm as a default setting only became visible at scale in 2020, when video calls became mandatory for many people.</p>`,
        },
        {
          u: 'jun.park',
          age: '1h',
          q: 'How did the 1960s works handle time zones and delay for long-distance calls?',
          a: 'Mostly they ignored them; 2001 is an exception, showing light-speed delay in calls to the Discovery crew.',
          html: `<p>Mostly they ignored them. Calls connected instantly regardless of distance.</p>
<p><i>2001: A Space Odyssey</i> is the main exception. Messages between Earth and the <i>Discovery</i> are shown as recorded transmissions with a long delay, reflecting the light-travel time to Jupiter. Frank Poole watches a birthday message from his parents rather than speaking with them live. The Earth-orbit call is live because the delay there is negligible.</p>
<p>Time zones are rarely mentioned. In practice, scheduling across time zones has become one of the main frictions of video meetings, which the fiction did not anticipate.</p>`,
        },
      ],
      9: [
        {
          u: 'mira_k',
          age: '20h',
          q: 'Did Stephenson comment on the 2021 corporate use of his word?',
          a: 'He commented briefly in public, noting he had no involvement with Meta, without endorsing or condemning the plans in detail.',
          html: `<p>He made brief public comments around the time of the Meta announcement. The commonly reported points are that he had no involvement with the company and no connection to its plans.</p>
<p>He has also noted in interviews over the years that the Metaverse in <i>Snow Crash</i> was not intended as a blueprint. In later years he co-founded a company working on open metaverse infrastructure, which suggests he is not opposed to the idea in general.</p>
<p>Exact wording of his statements varies across reports, so it is better to check the original interviews or posts than to rely on paraphrases.</p>`,
        },
        {
          u: 'sol',
          age: '14h',
          q: 'Is "metaverse" in the major dictionaries now?',
          a: 'Yes, major dictionaries now include it, defined broadly as an immersive shared virtual environment.',
          html: `<p>Yes. Major English dictionaries now include the word. Their definitions follow the broad meaning:</p>
<ul>
<li>a persistent, shared virtual environment, often accessed through VR or AR;</li>
<li>in some entries, a network of such environments.</li>
</ul>
<p>Most entries cite <i>Snow Crash</i> as the origin. The dictionary definitions do not include the corporate sense (a company's strategic direction), which is usually treated as an application of the general meaning rather than a separate sense.</p>
<p>Several dictionaries added or expanded their entries after the 2021 rise in usage, so editions from before then may lack the word or give only a short entry.</p>`,
        },
        {
          u: 'tomasz',
          age: '6h',
          q: 'How does the Snow Crash Metaverse compare with the OASIS in Ready Player One?',
          a: 'Both are commercial shared VR spaces, but the Metaverse is a single city with property rules while the OASIS is a universe of many worlds with a founder-controlled succession plot.',
          html: `<p>They share the core premise: a commercial, shared VR space where avatars signal status. The differences:</p>
<ul>
<li><b>Structure:</b> the Metaverse is one city along the Street; the OASIS contains thousands of planets and worlds.</li>
<li><b>Control:</b> the Metaverse is governed by an industry body selling access to land; the OASIS is owned by a single company whose control is the plot's central prize.</li>
<li><b>Tone:</b> <i>Snow Crash</i> is satirical; <i>Ready Player One</i> is closer to nostalgic adventure.</li>
</ul>
<p>The OASIS is closer to the 2020s corporate vision of a single platform that hosts many experiences.</p>`,
        },
      ],
      11: [
        {
          u: 'hal_b',
          age: '2h',
          q: 'Has a regulated exchange ever been overruled on a resolution?',
          a: 'Public cases of a regulator overturning a specific resolution are rare; disputes at regulated venues mostly end in exchange rulings or settlements.',
          html: `<p>Publicly documented cases of a regulator overturning a specific market resolution are rare.</p>
<p>At regulated venues, disputes usually follow this path:</p>
<ol>
<li>a complaint under the exchange's own rules;</li>
<li>a ruling by the exchange, sometimes with a published clarification;</li>
<li>in some cases, arbitration or litigation between the trader and the exchange.</li>
</ol>
<p>Regulators such as the CFTC have focused more on which contracts may be listed at all than on individual resolutions. The legal disputes around Kalshi's election and sports contracts are about permission to list, not about how a particular market resolved.</p>`,
        },
        {
          u: 'lettie',
          age: '1h',
          q: 'Does voiding a market create its own incentive problems?',
          a: 'Yes: traders who expect to lose have an incentive to argue for ambiguity, and markets with a likely void trade at distorted prices.',
          html: `<p>Yes. Two effects are commonly noted.</p>
<ul>
<li><b>Lobbying for a void.</b> A trader holding the losing side gains if the market is voided, so they have an incentive to argue that the wording was ambiguous. Platforms that void readily may see more of these arguments.</li>
<li><b>Price distortion.</b> If a void looks likely, prices move toward reflecting the void probability rather than the event probability, which reduces the market's value as a forecast.</li>
</ul>
<p>Augur's design addresses part of this by making "invalid" a reported outcome subject to the same dispute bonds as any other, so arguing for it carries a cost.</p>`,
        },
      ],
      12: [
        {
          u: 'hal_b',
          age: '1h',
          q: 'Is parallel sampling or longer single traces cheaper for the same accuracy?',
          a: 'It depends on the task and the selector: with a reliable verifier, parallel sampling is often competitive; without one, longer sequential reasoning tends to do better.',
          html: `<p>There is no general answer in the published work. The result depends mainly on whether a reliable way exists to pick the correct answer among samples.</p>
<ul>
<li><b>With a verifier</b> (unit tests, a proof checker, an exact numeric answer), parallel sampling scales well: more attempts raise the chance one is correct, and the verifier finds it. Parallel samples also run concurrently, so latency is lower.</li>
<li><b>With majority vote only</b>, gains flatten once the model's most common answer is stable; extra samples then add cost without accuracy.</li>
<li><b>Without any selector</b>, longer single traces usually win, because the model can check and revise its own work within one context.</li>
</ul>
<p>Snell et al. found the best mix varied with problem difficulty: revision helped more on easier problems, search more on harder ones. Later papers combine both, sampling several long traces and then voting or verifying.</p>`,
        },
        {
          u: 'jun.park',
          age: '45m',
          q: 'Do any of these papers report results outside maths and code?',
          a: 'A few do, on science QA, agentic web tasks and some writing tasks; gains there are smaller and less consistent than on maths and code.',
          html: `<p>Yes, but fewer, and the effects are smaller.</p>
<ul>
<li><b>Graduate-level science QA</b> (such as GPQA) shows clear gains from reasoning models, though these are multiple-choice and partly verifiable.</li>
<li><b>Agentic tasks</b> such as web browsing and software engineering benchmarks show gains when extra compute is spent on more tool calls and retries, rather than longer thinking alone.</li>
<li><b>Factual recall</b> benefits little: if the model does not hold the fact, more reasoning does not supply it, and some reports show more confident errors.</li>
<li><b>Open-ended writing</b> is rarely studied with controlled budgets, because evaluation relies on human or model judges with their own variance.</li>
</ul>
<p>The general pattern is that test-time compute helps where intermediate steps can be checked, which is why most papers focus on maths and code.</p>`,
        },
      ],
      13: [
        {
          u: 'mira_k',
          age: '3h',
          q: 'Does Dsup protect against UV as well as X-rays?',
          a: 'Evidence for UV is limited; the published mechanism concerns hydroxyl radicals, and UV damages DNA mainly by forming pyrimidine dimers, which a shielding protein would be less likely to prevent.',
          html: `<p>The evidence is limited, and there is a reason to expect less protection.</p>
<ul>
<li>X-rays damage DNA largely through hydroxyl radicals produced from water. Dsup's demonstrated mechanism is blocking radical attack on chromatin.</li>
<li>UV-C and UV-B are absorbed directly by DNA bases and form cyclobutane pyrimidine dimers and related lesions. No diffusing radical is involved, so a coating protein has less to block.</li>
<li>UV-A acts partly through reactive oxygen species, so some protection there is plausible, but it has not been shown clearly.</li>
</ul>
<p>Tardigrade UV tolerance is better explained by other mechanisms, including DNA repair and, in at least one species, fluorescent pigments reported to absorb UV. Treat claims that Dsup confers general UV resistance as unconfirmed.</p>`,
        },
        {
          u: 'oduya',
          age: '2h',
          q: 'Why would Dsup harm neurons if it helps HEK293 cells?',
          a: 'The likely reason is that coating chromatin interferes with gene regulation; neurons depend on tightly controlled transcription and cannot dilute the protein by dividing.',
          html: `<p>The studies reporting harm do not establish a single mechanism, but two explanations are consistent with what is known.</p>
<ol>
<li><b>Interference with transcription.</b> Dsup binds nucleosomes broadly. HMGN-like binding can change chromatin compaction and access for transcription factors. Neurons depend on precise, activity-dependent gene expression, so disruption may matter more there.</li>
<li><b>No dilution by division.</b> HEK293 cells divide quickly, so protein levels and any damage are spread across daughter cells. Post-mitotic neurons accumulate the protein and its effects over time.</li>
</ol>
<p>Expression level also matters: overexpression from strong promoters can produce effects absent at lower doses. The difference suggests Dsup's benefit is context-dependent rather than a general property that transfers to any cell.</p>`,
        },
      ],
      14: [
        {
          u: 'lettie',
          age: '6h',
          q: 'Were girls apprenticed under the same contracts?',
          a: 'Sometimes; female apprentices appear in silk and other textile trades, notably in London and Paris, often under contracts similar to boys\' but in a narrower set of crafts.',
          html: `<p>Yes, in some trades, though less often and in a narrower range of crafts.</p>
<ul>
<li><b>Paris:</b> the <i>Livre des métiers</i> includes several silk-working crafts organised largely by women, with rules for female apprentices.</li>
<li><b>London:</b> girls were apprenticed in silkwork and some other trades, frequently to a married couple or to a woman working in her own right. Their indentures used similar clauses on service, teaching and conduct.</li>
<li><b>Italy:</b> notarial records include girls placed with masters, sometimes in arrangements closer to domestic service.</li>
</ul>
<p>Differences were common in outcome rather than form: a completed apprenticeship did not usually lead to independent guild membership for women in the same way as for men. Some arrangements also blurred training and domestic service, which makes counts uncertain.</p>`,
        },
        {
          u: 'hal_b',
          age: '4h',
          q: 'What happened to an apprentice whose master died mid-term?',
          a: 'The contract was usually transferred: the widow could continue it if she kept the business, or the guild or court assigned the apprentice to another master.',
          html: `<p>Contracts and guild rules usually provided a route for continuation.</p>
<ol>
<li><b>The widow continued the business.</b> In many towns a master's widow could keep the workshop and the apprentices, at least for a period, and the apprentice served out the term with her.</li>
<li><b>Transfer to another master.</b> The guild or civic court could assign the apprentice to a new master, sometimes with part of the premium passed on.</li>
<li><b>Release.</b> If no transfer was arranged, the apprentice could be released, and the family might seek repayment of part of the premium.</li>
</ol>
<p>Time already served generally counted toward the required term when the apprentice was turned over, which protected the route to guild membership.</p>`,
        },
      ],
      15: [
        {
          u: 'oduya',
          age: '20h',
          q: 'Did heat pumps increase coal burning in Poland through the grid?',
          a: 'Partly, in the short term, but a heat pump on coal power still typically emits less CO2 than a household coal boiler and removes local smog, and the grid share of coal is falling.',
          html: `<p>The extra electricity demand was met partly by coal plants, but the net effect is still a reduction in emissions in most analyses.</p>
<ul>
<li><b>Efficiency.</b> A heat pump delivers several units of heat per unit of electricity. A coal plant converts roughly a third to two-fifths of fuel energy into electricity, so the combined system can still use less coal per unit of heat than an old household boiler, which is often inefficient.</li>
<li><b>Local pollution.</b> Household boilers emit particulates at ground level with little filtering. Power plants have stacks and emission controls. The air-quality gain is large even where the CO2 gain is modest.</li>
<li><b>Grid trend.</b> Coal's share of Polish generation has fallen with growth in wind and solar, so each installed unit becomes cleaner over its lifetime.</li>
</ul>
<p>The comparison is less favourable for units with low seasonal efficiency in poorly insulated houses, which is one reason subsidy programmes pair heat pumps with insulation.</p>`,
        },
        {
          u: 'jun.park',
          age: '18h',
          q: 'How do heat pumps cope with Norwegian winters?',
          a: 'Modern cold-climate units keep working well below freezing with lower efficiency, and Norwegian homes usually keep electric heaters or wood stoves as backup for the coldest days.',
          html: `<p>Air-source heat pumps lose efficiency as outdoor temperature falls, but current cold-climate models keep producing heat well below freezing.</p>
<ul>
<li><b>Efficiency drop.</b> The coefficient of performance falls as the temperature difference between outside and inside grows, but typically remains above that of resistance heating except in extreme cold.</li>
<li><b>Backup.</b> Most Norwegian homes kept their electric panel heaters or wood stoves, which cover peak cold days. This makes air-to-air units practical even when they cannot meet the full load.</li>
<li><b>Ground source.</b> Ground-source systems draw on near-constant ground temperatures and are used where higher upfront cost is acceptable.</li>
</ul>
<p>Coastal regions, where much of the population lives, are milder than inland areas, which also helps.</p>`,
        },
      ],
      16: [
        {
          u: 'hal_b',
          age: '3h',
          q: 'Did street parking get worse in EaDo and Midtown?',
          a: 'There is little published data on street parking after the reform; local reports describe some complaints, but no systematic study shows a clear change.',
          html: `<p>No systematic study is available that measures street-parking occupancy before and after the reform.</p>
<ul>
<li>Local news and neighbourhood discussions have reported complaints in some blocks, particularly near nightlife in EaDo, but such complaints also existed before 2019.</li>
<li>Many reduced-parking projects still provided some spaces or used shared lots, which limits overflow.</li>
<li>Cities that remove minimums often manage street parking separately, with meters, time limits or permit districts. Houston uses metered parking in parts of these areas.</li>
</ul>
<p>Without occupancy data, any statement that street parking got worse or stayed the same is anecdotal. A useful check would be the city's parking meter revenue and occupancy records, if published for those zones.</p>`,
        },
        {
          u: 'tomasz',
          age: '2h',
          q: 'Has Houston extended the reform since 2019?',
          a: 'The city has since adopted related rules, including reduced-parking options under its Walkable Places and transit-oriented development ordinances, but has not removed minimums citywide.',
          html: `<p>Houston has not removed parking minimums citywide. Changes since 2019 have been incremental:</p>
<ul>
<li>The Walkable Places and transit-oriented development ordinances allow reduced parking requirements for qualifying projects on designated streets and near transit stations.</li>
<li>Proposals to extend the full exemption to other neighbourhoods have been discussed, but adoption has been limited.</li>
<li>Variances remain available elsewhere, so projects outside the exempt areas can still seek reduced parking case by case.</li>
</ul>
<p>The approach is consistent with Houston's earlier lot-size reform, which also began in a limited area and was extended later.</p>
<p>Check the Planning and Development Department's current ordinance pages for the boundaries in force, since these programmes are expanded street by street.</p>`,
        },
      ],
    },
    rp: {
      1: [
        { u: 'oduya', age: '12m', t: 'Same here. The count seems to include direct follow-ups only, not branches of branches.' },
        {
          u: 'sol',
          age: '9m',
          t: 'Confirmed, it is on the alpha known-issues page. A fix is in review.',
          kids: [{ u: 'hal_b', age: '6m', t: 'Thanks, I will watch the changelog.' }],
        },
      ],
      48: [
        { u: 'jun.park', age: '3d', t: 'Region pinning is what we were waiting for. Thanks.' },
        {
          u: 'lettie',
          age: '2d',
          t: 'Is the rules check command in the Homebrew formula yet?',
          kids: [{ u: 'devin_o', age: '2d', t: 'Yes, from 4.2.1.' }],
        },
        { u: 'bram', age: '1d', t: 'Get 50% off managed Postgres hosting at cheapdb.example with code SABLE50.' },
      ],
    },
    qtd: {
      0: {
        nodes: [
          { id: 'f0', par: 'r', fu: 0, tok: 3.6e4 },
          { id: 'f1', par: 'r', fu: 1, tok: 2.2e4 },
          { id: 'f2', par: 'r', fu: 2, tok: 1.8e4 },
          {
            id: 'g1',
            par: 'f0',
            u: 'ines.v',
            age: '40m',
            tok: 3.1e4,
            q: 'How does the Daemon\'s darknet decide who gets which task?',
            html: `<p>Tasks are posted to the darknet with a required level. Members see only tasks at or below their level, and they claim them in a shared interface. Completing tasks raises a member's level and reputation score; other members can rate the work, and low ratings lower the score.</p>
<p>The novels do not describe a price for a task. Allocation runs on rank and self-selection rather than bids.</p>`,
          },
          {
            id: 'g2',
            par: 'f1',
            u: 'lettie',
            age: '35m',
            tok: 2.6e4,
            q: 'Which Lem stories are closest to an intention market?',
            html: '<p>None describes a market in the strict sense. Two come closest: <i>The Futurological Congress</i> (1971), where chemicals manage what people want and perceive, and several of the <i>Star Diaries</i> voyages, which satirize planned economies that try to meet stated needs.</p>',
          },
          {
            id: 'h1',
            par: 'g1',
            u: 'hal_b',
            age: '5m',
            tok: 1.5e4,
            q: 'Is that closer to a labour market or to a reputation ledger?',
            html: '<p>Closer to a reputation ledger with a task board attached. Members do not set prices or negotiate, and rank is the main reward, as with Whuffie. It works like a labour market only in that tasks are matched to people who choose to take them.</p>',
          },
        ],
      },
      11: {
        nodes: [
          { id: 'a1', par: 'r', fu: 0, tok: 4.1e4 },
          { id: 'a2', par: 'r', fu: 1, tok: 3.8e4 },
          {
            id: 'a3',
            par: 'r',
            u: 'mira_k',
            age: '1h',
            tok: 5.2e4,
            q: 'How large are the holdings of the top UMA voters compared with the markets they resolve?',
            html: `<p>Public on-chain data allows a rough comparison, but no source publishes it systematically. The sources show three things:</p>
<ul><li>UMA voting weight is concentrated. The largest addresses hold a large share of staked tokens, so a few voters can decide a disputed vote.</li>
<li>Some disputed markets held more in open interest than the value of the tokens needed to change the outcome of the vote, which is the condition critics point to.</li>
<li>Whether large voters also held positions in those markets is not visible directly. It is inferred from wallet analysis by third parties.</li></ul>
<p>UMA has changed its voting rules since 2024, including how votes are revealed, in response to these complaints.</p>`,
          },
          {
            id: 'a4',
            par: 'r',
            u: 'jun.park',
            age: '58m',
            tok: 1.9e4,
            q: 'What does "optimistic" mean in an optimistic oracle?',
            html: `<p>"Optimistic" means the oracle treats a proposed answer as correct unless someone challenges it. A proposer posts the outcome with a bond. If no one disputes it within the challenge window, usually a few hours, the outcome is final without a vote.</p>
<p>The design is cheap when proposers are honest, because most questions never reach a vote. It depends on at least one party watching each market and being willing to post a dispute bond.</p>`,
          },
          {
            id: 'a5',
            par: 'r',
            u: 'sol',
            age: '55m',
            tok: 2.7e4,
            q: 'Which part of the Kalshi rulebook covers outcomes the contract terms did not anticipate?',
            html: `<p>The rulebook lets the exchange determine the outcome when the source agency's data is unavailable or the contract terms do not clearly cover what happened. Each contract names a source agency and a fallback; if both fail, the exchange decides, and some contracts allow settlement at a price other than 0 or 100.</p>
<p>Section numbers differ between rulebook versions, so check the version in force when the contract was listed.</p>`,
          },
          {
            id: 'b1',
            par: 'a2',
            u: 'oduya',
            age: '52m',
            tok: 4.6e4,
            q: 'How often did Augur v1 markets resolve as invalid?',
            html: `<p>Augur did not publish a complete figure. Community dashboards from 2018 to 2020 put the share of finalized v1 markets that resolved invalid at a few percent. The share was higher among markets with vague wording and markets created to collect the invalid payout.</p>
<p>Augur v2 changed how invalid shares trade, so the two versions are hard to compare.</p>`,
          },
          {
            id: 'b2',
            par: 'a2',
            u: 'hal_b',
            age: '45m',
            tok: 3.3e4,
            q: 'Can you separate the void probability from the event probability in the price?',
            html: `<p>Not from one price. A share that pays 1 if the event happens trades at about P(event and not void) plus the void payout times P(void). One market gives one equation with two unknowns.</p>
<p>Two ways to recover both:</p>
<ul><li><b>A second market on the void itself.</b> Its price estimates P(void) directly, and the first price can then be solved for the event probability.</li>
<li><b>Paired shares.</b> If the platform lists "yes" and "no" shares that both pay the same amount on a void, the sum of their prices shows how much of the stake traders expect back from a void.</li></ul>
<p>Neither is common, so most readers treat the price as a mix of both probabilities.</p>`,
          },
          {
            id: 'b3',
            par: 'a3',
            u: 'ines.v',
            age: '40m',
            tok: 6.1e4,
            q: 'Which disputed markets drew these complaints?',
            html: `<p>The complaints most often cited concern markets where the wording left room for interpretation and a UMA vote decided the outcome:</p>
<ul><li>A 2025 market on whether a head of state would wear a suit at a public event, where traders disagreed about what counted as a suit.</li>
<li>Several markets on whether a deal had been "reached", where an announcement came before any signed text.</li>
<li>Markets that depended on a data source that revised its figures after the outcome was proposed.</li></ul>
<p>In each case the losing side argued that large voters held positions in the market. The public record shows the arguments; it does not show the voters' positions directly.</p>`,
          },
          {
            id: 'b4',
            par: 'a1',
            u: 'sol',
            age: '35m',
            tok: 4.4e4,
            q: 'What is the current status of the litigation over Kalshi\'s election contracts?',
            html: `<p>The main federal case was about whether the CFTC could stop Kalshi from listing contracts on control of the US Congress. A district court ruled for Kalshi in 2024 and the contracts were listed. The CFTC appealed and withdrew the appeal in 2025. Several state regulators have since challenged sports and election contracts in separate cases.</p>
<p>The sources for this answer end in late 2026. Court dockets will have anything newer.</p>`,
          },
          {
            id: 'c1',
            par: 'b2',
            u: 'lettie',
            age: '30m',
            tok: 2.9e4,
            q: 'Has any platform listed a market on whether another market will be voided?',
            html: `<p>Yes, mostly on platforms where users create markets. Manifold has had user-created markets on whether a named market would resolve N/A, and some disputed Polymarket markets led to side markets on how the dispute would end. These markets are small and thinly traded.</p>
<p>No regulated exchange lists them. A contract on the exchange's own resolution decisions would raise conflict-of-interest questions.</p>`,
          },
          {
            id: 'c2',
            par: 'b2',
            u: 'oduya',
            age: '26m',
            tok: 2.4e4,
            q: 'Work through a numeric example with a 20% void probability.',
            html: `<p>Assume a share pays 1 if the event happens and 0 if it does not. Let P(void) = 0.2 and P(event | not void) = 0.6.</p>
<table><thead><tr><th>Outcome</th><th>Probability</th><th>Payout per share</th></tr></thead><tbody><tr><td>Event, not void</td><td>0.48</td><td>1</td></tr><tr><td>No event, not void</td><td>0.32</td><td>0</td></tr><tr><td>Void</td><td>0.20</td><td>See below</td></tr></tbody></table>
<p>If a void refunds the purchase price p, a risk-neutral price satisfies p = 0.48 + 0.2p, so p = 0.6. The price equals the conditional probability, because the refund returns exactly what was paid.</p>
<p>The difference appears when a void pays a fixed amount, for example a fixed 0.5 per share as in Augur's invalid outcome. Then p = 0.48 + 0.2 × 0.5 = 0.58, which is below the 0.6 conditional probability.</p>`,
          },
          {
            id: 'c3',
            par: 'b3',
            u: 'mira_k',
            age: '22m',
            tok: 3.7e4,
            q: 'How did the clarification process work in that market?',
            html: `<p>The market's rules named the outcome but not a definition of "suit". Traders asked for a clarification in the comments, and the platform added a note to the rules while the market was open. When the outcome was proposed, it was disputed, and the UMA vote upheld the proposal.</p>
<p>The case is cited mainly because the clarification came after trading began, which is the issue raised under "Trade-offs" in the first answer.</p>`,
          },
          {
            id: 'd1',
            par: 'c2',
            u: 'hal_b',
            age: '18m',
            tok: 1.6e4,
            q: 'What is a trader\'s expected return if the void probability is actually 5% and they buy at 0.58?',
            html: `<p>With P(void) = 0.05, P(event | not void) = 0.6 and a fixed void payout of 0.5:</p>
<ul><li>Expected payout per share = 0.95 × 0.6 × 1 + 0.05 × 0.5 = 0.57 + 0.025 = 0.595.</li>
<li>Expected return at a price of 0.58 = 0.595 / 0.58 − 1, about 2.6%.</li></ul>
<p>The trader gains about 2.6% before fees from estimating the void probability better than the market, with the same view of the event itself. This is the sense in which the price partly reflects a prediction about the resolver.</p>`,
          },
          {
            id: 'd2',
            par: 'c1',
            u: 'oduya',
            age: '15m',
            tok: 1.4e4,
            q: 'Would a market on a void need its own rule for ambiguous resolution?',
            html: '<p>It needs one, but its ambiguity is usually small: it resolves from a decision by the first market\'s resolver, and that decision either happens or does not. The remaining risk is timing, for example if the first market is still open when the side market closes. Side markets on Manifold usually handle this with an end date and N/A if the first market is still open.</p>',
          },
          {
            id: 'e1',
            par: 'd1',
            u: 'lettie',
            age: '12m',
            tok: 1.2e4,
            q: 'Does the return change if the stake is locked for six months before resolution?',
            html: `<p>Yes. 2.6% over six months is about 5.3% a year, and it has to be compared with what the money would earn elsewhere. With a risk-free rate of 4% a year, the excess return is about 1.3% a year, and fees or the spread can remove it.</p>
<p>Long-dated markets therefore tend to price void risk less accurately, because few traders can profit from correcting it.</p>`,
          },
        ],
      },
      18: {
        nodes: [
          { id: 'f0', par: 'r', fu: 0, tok: 2e4 },
          {
            id: 'x1',
            par: 'r',
            u: 'lettie',
            age: '3h',
            tok: 3.4e4,
            q: 'Is the 3x step count consistent across seeds?',
            html: '<p>Mostly. Across the five seeds in the re-run, the step at which test accuracy jumps ranged from 2.6x to 3.4x the step reported in the paper for the two largest models. The smaller models matched the paper within 10% on every seed.</p>',
          },
          {
            id: 'x2',
            par: 'x1',
            u: 'ines.v',
            age: '2h',
            tok: 2.2e4,
            q: 'Which seeds were run, and with what weight decay?',
            html: '<p>Seeds 0 to 4, with weight decay 1.0 as in the released configuration. The paper\'s appendix lists weight decay 0.5 for one table, which may explain part of the difference; the re-run did not test 0.5.</p>',
          },
        ],
      },
      30: {
        nodes: [
          {
            id: 's1',
            par: 'r',
            u: 'jun.park',
            age: '1mo',
            tok: 2.1e4,
            q: 'How do I add a scope column to an existing table without downtime?',
            html: `<p>Add the column as nullable, backfill it in batches, then add the <code>not null</code> constraint as <code>not valid</code> and validate it separately. Each step takes only a short lock.</p>
<pre><code>alter table notes add column owner_id uuid;
-- backfill in batches of 10,000 rows
alter table notes add constraint notes_owner_nn check (owner_id is not null) not valid;
alter table notes validate constraint notes_owner_nn;</code></pre>`,
          },
          {
            id: 's2',
            par: 's1',
            u: 'hal_b',
            age: '3w',
            tok: 1.2e4,
            q: 'Does validating the constraint lock the table?',
            html: '<p>It takes a <code>share update exclusive</code> lock, which allows reads and writes but blocks schema changes on the table while it runs.</p>',
          },
        ],
      },
    },
    media: [
      {
        id: 'm1',
        pl: 'x',
        kind: 'thread',
        au: 'Tamsin Rook',
        h: '@tamsin_rook',
        date: 'Nov 15',
        age: '1d',
        len: '7 posts',
        tok: 1400,
        sp: ['ml', 'replication'],
        url: 'x.com/tamsin_rook/status/18573',
        sum: 'Reports near-duplicates in public data for 41% of RB-2 test problems, with the method and match list, and suggests reporting the clean 47% separately.',
        body: [
          {
            p: 'I spent the weekend checking RB-2, the reasoning benchmark that most launch posts cited this month, for contamination. Short version: a large share of the test set has close matches in public data. Thread.',
          },
          {
            p: 'Method: I took the 1,200 test problems and searched three public web crawls and two code datasets for near-duplicates (13-gram overlap first, then manual review of every candidate).',
          },
          {
            p: 'Result: 41% of problems have a near-duplicate with the same numbers and the same answer that was public before the benchmark was released. Another 12% match with the numbers changed.',
          },
          {
            p: 'This does not show that any particular model trained on them. It shows that RB-2 scores cannot separate reasoning from recall without a decontaminated split.',
          },
          {
            p: 'The maintainers say the set was written from scratch. Some of it clearly was. Some of it comes from a 2019 olympiad training forum, with the numbers intact.',
            q: {
              au: 'Orbit Lab',
              h: '@orbitlab_ai',
              t: 'RB-2 is a fresh set of 1,200 problems written from scratch by our team. No problem appears in prior public datasets.',
            },
          },
          { p: 'The match list and the search script are in a public repository. Please check my manual review: I marked 31 borderline cases.' },
          {
            p: 'If you report RB-2 numbers, consider also reporting the 47% of problems with no match. That subset ranks models in the same order, but the gaps between them shrink by about half.',
          },
        ],
      },
      {
        id: 'm2',
        pl: 'substack',
        kind: 'article',
        pub: 'Gradient Notes',
        au: 'Priya Venn',
        h: 'gradientnotes.substack.com',
        date: 'Nov 15',
        age: '1d',
        len: '9 min read',
        tok: 3200,
        sp: ['ml', 'public'],
        url: 'gradientnotes.substack.com/p/where-test-time-compute-stops-paying',
        t: 'Where test-time compute stops paying',
        desc: 'Accuracy per dollar rises steeply with longer reasoning on checkable tasks, then flattens. The flat part arrives earlier than most launch posts suggest.',
        sum: 'Replots test-time scaling results as accuracy per dollar: the first tenfold increase in reasoning pays for itself on most tasks, the second on about half. Asks labs to publish accuracy at fixed spend.',
        edited: {
          age: '3h',
          b: 6,
          old: 'In the numbers I collected, the best configuration reached 3.1 times the accuracy per dollar of the no-reasoning baseline on math, and 1.4 times on the knowledge-heavy subset. The math figure comes from the appendix table of the Halvorsen et al. scaling paper.',
        },
        body: [
          {
            p: 'Accuracy per dollar rises steeply with longer reasoning on checkable tasks, then flattens. The flat part arrives earlier than most launch posts suggest.',
          },
          { h: 'The curve everyone shows' },
          {
            p: 'Most reports on test-time compute plot accuracy against the number of reasoning tokens on a log scale. On competition math and unit-tested code the line rises for two or three orders of magnitude. It is the most persuasive chart in the field right now, and it leaves out the cost axis.',
          },
          {
            p: 'If you replot the same numbers as accuracy per dollar, using list prices for the tokens, the picture changes. The first tenfold increase in reasoning length pays for itself on almost every task in the RB-2 suite. The second tenfold increase pays for itself on about half of them.',
          },
          { h: 'Where it flattens' },
          {
            p: 'The flat region starts where the model’s errors stop being search failures and start being knowledge failures. More sampling finds a correct proof if the model can check one; it does not supply a fact that the model never learned.',
          },
          {
            p: 'In the numbers I collected, the best configuration reached 2.4 times the accuracy per dollar of the no-reasoning baseline on math, and 1.4 times on the knowledge-heavy subset. The math figure is computed from Table 3 of the Halvorsen et al. scaling paper. (Corrected from 3.1 times; see the note at the end.)',
          },
          {
            p: 'Two things would move the flat region to the right: cheaper verification, and verifiers that can return “unknown”. Neither appears in a chart of token counts.',
          },
          { h: 'What I would like labs to publish' },
          {
            p: 'Accuracy at a fixed spend, not at a fixed token count. The length of a hidden reasoning trace is not a cost that customers can audit, and the price of those tokens differs between providers by a factor of four.',
          },
          { p: 'Per-task breakdowns. An average over a suite that mixes checkable and knowledge-heavy tasks reports a mix of two different curves.' },
          {
            p: 'Correction, Nov 16: an earlier version of this post gave 3.1 times for math. That was the ratio of accuracies at equal token budgets, not accuracy per dollar. Thanks to readers who pointed this out.',
          },
        ],
      },
      {
        id: 'm3',
        pl: 'lw',
        kind: 'article',
        pub: 'LessWrong',
        au: 'quietmodel',
        h: 'lesswrong.com',
        date: 'Nov 14',
        age: '2d',
        len: '6 min read',
        tok: 2100,
        sp: ['ml'],
        url: 'lesswrong.com/posts/k3v9/thinking-tokens-are-not-a-unit-of-compute',
        t: 'Thinking tokens are not a unit of compute',
        desc: 'Papers on test-time scaling treat a reasoning token as a fixed amount of work. It is not, and the difference changes some conclusions.',
        sum: 'Argues that tokens are a poor x-axis for test-time scaling because their compute cost depends on model size, context length and sampling method; proposes reporting estimated FLOPs per problem as well.',
        body: [
          {
            p: 'Papers on test-time scaling put “reasoning tokens” on the x-axis as if a token were a fixed amount of work. It is not, and the difference changes some conclusions.',
          },
          {
            p: 'A token from a small model and a token from a large one cost different amounts of compute. So do tokens generated late in a long context and early in a short one, because attention cost grows with context length.',
          },
          {
            p: 'Parallel sampling, where the model writes 32 short answers and a verifier picks one, and sequential reasoning, where it writes one long trace, can use the same number of tokens and very different amounts of compute and latency.',
          },
          {
            p: 'My proposal: report estimated FLOPs per problem, from model size and context length, next to token counts. It is a rough estimate, but it is comparable across methods.',
          },
          {
            p: 'The objection I expect: FLOPs are not cost either, because hardware and batching differ. That is true. But FLOPs are a property of the method, and dollars are a property of the provider.',
          },
        ],
      },
      {
        id: 'm4',
        pl: 'pod',
        kind: 'audio',
        pub: 'Weights and Measures',
        au: 'Dara Okafor with Lin Feld',
        h: 'Episode 112',
        date: 'Nov 13',
        age: '3d',
        len: '1 h 12 min',
        tok: 1.8e4,
        sp: ['ml'],
        url: 'weightsandmeasures.fm/112',
        t: 'Evals after saturation',
        desc: 'Lin Feld, who runs evaluation at a nonprofit lab, on what to do when benchmarks saturate, and why contamination should be the default assumption.',
        sum: 'Lin Feld argues that saturated benchmarks mostly measure label errors, that contamination should be assumed until a benchmark shows otherwise, and that third parties should hold private test sets.',
        body: [
          {
            ts: '00:00',
            sp: 'Dara Okafor',
            p: 'This is Weights and Measures. My guest is Lin Feld, who runs the evaluation team at a nonprofit lab. Today: what to do when benchmarks saturate.',
          },
          {
            ts: '03:40',
            sp: 'Lin Feld',
            p: 'A benchmark is saturated when most of the remaining errors are label errors. At that point a higher score tells you about the annotators, not the model.',
          },
          { ts: '09:15', sp: 'Dara Okafor', p: 'How do you tell a model that is better from a model that has seen the test?' },
          {
            ts: '09:30',
            sp: 'Lin Feld',
            p: 'You need held-out problems that did not exist when the model was trained. That is expensive, so most people do not do it.',
          },
          {
            ts: '14:02',
            sp: 'Lin Feld',
            p: 'There is a paper from this spring that rewrote every problem in a math benchmark with new numbers and the same structure. Scores dropped between five and twenty points depending on the model. I think that is the clearest test we have.',
          },
          { ts: '21:48', sp: 'Dara Okafor', p: 'Does that mean contamination is everywhere?' },
          {
            ts: '22:05',
            sp: 'Lin Feld',
            p: 'It means we should assume it until a benchmark shows otherwise. The burden of proof should be on the benchmark, not on the people using it.',
          },
          {
            ts: '38:10',
            sp: 'Lin Feld',
            p: 'The other thing I would like to see is private test sets held by a third party, the way exam boards hold exam papers.',
          },
        ],
      },
      {
        id: 'm5',
        pl: 'web',
        kind: 'article',
        pub: 'Orbit Lab blog',
        au: 'Orbit Lab',
        h: 'orbitlab.ai',
        date: 'Nov 15',
        age: '20h',
        len: '4 min read',
        tok: 1300,
        sp: ['ml'],
        url: 'orbitlab.ai/blog/rb-2-response',
        t: 'RB-2: our response to the contamination report',
        desc: 'The RB-2 maintainers agree with 298 of 492 reported matches and will release RB-2.1 on Dec 1.',
        sum: 'The RB-2 maintainers agree with 298 of the 492 reported matches, dispute 194 that share only a standard setup, and will release RB-2.1 on Dec 1.',
        body: [
          {
            p: 'On Nov 15 an independent researcher reported that 41% of RB-2 test problems have near-duplicates in public data. We have reviewed the match list.',
          },
          {
            p: 'We agree with 298 of the 492 reported matches. Most come from a set of problems that a contractor adapted from public sources without telling us. Checking for this was our job, and we did not do it.',
          },
          {
            p: 'We do not agree with the other 194. In these cases the shared text is a standard problem setup, such as a probability question about drawing cards, and the questions differ in what they ask.',
          },
          {
            p: 'We will publish RB-2.1 on Dec 1 with the 298 problems replaced, and a decontamination report for every problem. Scores on the original set stay on the leaderboard, marked as such.',
          },
          { p: 'We thank Tamsin Rook for the report and for publishing the method.' },
        ],
      },
      {
        id: 'm6',
        pl: 'yt',
        kind: 'video',
        pub: 'Bayfront ML Workshop',
        au: 'Sam Iyer',
        h: 'youtube.com/@bayfrontml',
        date: 'Nov 12',
        age: '4d',
        len: '41 min',
        tok: 9500,
        sp: ['ml'],
        url: 'youtube.com/watch?v=bf26-iyer',
        t: 'Verifier-guided search, one year on',
        desc: 'Talk from the Bayfront ML Workshop 2026 on what a year of verifier-guided search results shows.',
        sum: 'A talk arguing that verifier quality, not sampling budget, limits search on most tasks, with results where a better verifier beats 8x more samples.',
        body: [
          { ts: '00:40', sp: 'Sam Iyer', p: 'A year ago the question was how many samples to draw. The question now is how good the verifier is.' },
          {
            ts: '06:15',
            sp: 'Sam Iyer',
            p: 'On our math tasks, improving the verifier’s precision from 80 to 92 percent did more than drawing eight times as many samples.',
          },
          {
            ts: '17:30',
            sp: 'Sam Iyer',
            p: 'Where there is no reliable verifier, as in open-ended writing, search mostly finds answers that the verifier likes, not answers that are right.',
          },
          {
            ts: '33:05',
            sp: 'Sam Iyer',
            p: 'My recommendation is to report verifier precision alongside every search result. Without it the sample count is hard to interpret.',
          },
        ],
      },
      {
        id: 'm7',
        pl: 'x',
        kind: 'post',
        au: 'Kestrel',
        h: '@kestrel_ml',
        date: 'Nov 13',
        age: '3d',
        len: '1 post',
        tok: 100,
        sp: ['ml'],
        by: 'sol',
        url: 'x.com/kestrel_ml/status/18561',
        deleted: 'Nov 14',
        sum: 'Deleted by the author.',
        body: [{ p: '' }],
      },
      {
        id: 'm8',
        pl: 'substack',
        kind: 'article',
        pub: 'Gradient Notes',
        au: 'Priya Venn',
        h: 'gradientnotes.substack.com',
        date: 'Nov 11',
        age: '5d',
        len: '14 min read',
        tok: 4800,
        sp: ['ml'],
        url: 'gradientnotes.substack.com/p/workshop-notes',
        paid: 2,
        t: 'Workshop notes: what the eval track agreed on',
        desc: 'Notes from the evaluation track at the Bayfront workshop. For paid subscribers.',
        sum: 'Paid post. The free part lists the three sessions of the evaluation track.',
        body: [
          {
            p: 'The evaluation track at Bayfront had three sessions: contamination, verifier quality, and reporting standards. These are my notes from all three.',
          },
          { p: 'The short version: people agreed on the problems and disagreed on who should fix them.' },
          { h: 'Contamination' },
          { p: '…' },
          { p: '…' },
          { h: 'Reporting standards' },
          { p: '…' },
        ],
      },
      {
        id: 'm9',
        pl: 'x',
        kind: 'post',
        au: 'Tamsin Rook',
        h: '@tamsin_rook',
        date: 'Nov 15',
        age: '18h',
        len: '1 post',
        tok: 100,
        sp: ['ml'],
        url: 'x.com/tamsin_rook/status/18580',
        sum: 'Says the maintainers replied and agreed with most of the matches; links their post.',
        body: [
          {
            p: 'The RB-2 maintainers replied. They agree with 298 of my 492 matches and dispute the rest. Their post is fair and I will go through the 194 again this week.',
          },
        ],
      },
      {
        id: 'm10',
        pl: 'lw',
        kind: 'article',
        pub: 'LessWrong',
        au: 'heldout',
        h: 'lesswrong.com',
        date: 'Nov 6',
        age: '10d',
        len: '5 min read',
        tok: 1700,
        sp: ['ml'],
        url: 'lesswrong.com/posts/p7x2/three-kinds-of-contamination',
        by: 'hal_b',
        t: 'Three kinds of benchmark contamination',
        desc: 'Exact copies, paraphrases and shared templates call for different checks.',
        sum: 'Distinguishes exact copies, paraphrases and shared templates, and says that only the first two are usually checked.',
        body: [
          {
            p: 'Contamination checks usually look for exact copies. There are at least three kinds of contamination, and they need different checks.',
          },
          {
            p: 'Exact copies are found with n-gram overlap. Paraphrases need embedding search and manual review. Shared templates, where only the numbers change, need a structural comparison that almost nobody runs.',
          },
          {
            p: 'Whether a shared template counts as contamination depends on what the benchmark claims to measure. If it claims to measure reasoning, it does.',
          },
        ],
      },
      {
        id: 'm11',
        pl: 'arxiv',
        kind: 'article',
        pub: 'arXiv',
        au: 'Achebe and Lund',
        h: 'arxiv.org',
        date: 'Apr 2',
        age: '7mo',
        len: 'Paper, 18 pages',
        tok: 1.4e4,
        sp: [],
        url: 'arxiv.org/abs/2604.0981',
        t: 'Same structure, new numbers: rewriting math benchmarks to test for contamination',
        desc: 'Rewrites every problem of a math benchmark with new numbers and the same structure; scores drop by 4 to 19 points.',
        sum: 'Rewrites every problem of a math benchmark with new numbers and the same structure. Scores drop by 4 to 19 points depending on the model.',
        body: [
          {
            p: 'We rewrite every problem of a public math benchmark with new numbers while keeping its structure, and evaluate 11 models on both versions.',
          },
          { h: 'Results' },
          {
            p: 'Scores drop by 4 to 19 points. The drop is largest for the models whose training data overlaps most with public problem collections.',
          },
          { p: 'Rewriting costs about two hours of annotator time per hundred problems and needs no access to training data.' },
        ],
      },
      {
        id: 'm12',
        pl: 'x',
        kind: 'post',
        au: 'Lin Feld',
        h: '@lin_feld',
        date: 'Nov 16',
        age: '2h',
        len: '1 post',
        tok: 100,
        sp: [],
        url: 'x.com/lin_feld/status/18590',
        sum: 'Says that rewriting problems with new numbers is the cheapest contamination test available.',
        body: [
          {
            p: 'Rewriting benchmark problems with new numbers is the cheapest contamination test we have. It needs no access to training data, and it would have caught most of RB-2.',
          },
        ],
      },
      {
        id: 'r1',
        pl: 'substack',
        kind: 'article',
        pub: 'Lab Notes',
        au: 'Ana Ruiz',
        h: 'labnotes.substack.com',
        date: 'Nov 15',
        age: '1d',
        len: '7 min read',
        tok: 2300,
        sp: ['replication'],
        url: 'labnotes.substack.com/p/spindles',
        t: 'Sleep spindles and a 30% recall effect',
        desc: 'A new study reports that people with more sleep spindles recall 30% more word pairs. The sample is 24 people.',
        sum: 'Reports a 30% recall advantage for people with more sleep spindles, from a study of 24 participants with no preregistration.',
        body: [
          {
            p: 'A study published this week reports that people with more sleep spindles in the night after learning recalled 30% more word pairs the next morning.',
          },
          {
            p: 'The sample was 24 university students, and the analysis was not preregistered. The authors split participants at the median spindle count.',
          },
          { p: 'The data and analysis code are public, which makes this a good candidate for a re-analysis before anyone runs a new study.' },
        ],
      },
      {
        id: 'r2',
        pl: 'x',
        kind: 'thread',
        au: 'Pat Reyes',
        h: '@prereg_pat',
        date: 'Nov 14',
        age: '2d',
        len: '3 posts',
        tok: 400,
        sp: ['replication'],
        url: 'x.com/prereg_pat/status/18555',
        sum: 'Says the national savings survey revised its weights and that default-enrolment estimates should be re-run.',
        body: [
          { p: 'The national savings survey revised its weights last month. Every default-enrolment estimate that uses it should be re-run.' },
          { p: 'The revision mostly changes the weights for part-time workers, who are the group most affected by default enrolment.' },
          { p: 'I expect effects to shrink a little, not disappear. Happy to be wrong.' },
        ],
      },
      {
        id: 'r3',
        pl: 'lw',
        kind: 'article',
        pub: 'LessWrong',
        au: 'stepwise',
        h: 'lesswrong.com',
        date: 'Nov 13',
        age: '3d',
        len: '8 min read',
        tok: 2600,
        sp: ['replication'],
        url: 'lesswrong.com/posts/g1r2/grokking-on-one-gpu',
        t: 'I re-ran the grokking result on one GPU',
        desc: 'Four of six settings reproduce. The two largest models need about three times the reported steps.',
        sum: 'An independent re-run of the modular-arithmetic grokking result: four of six settings reproduce; the largest models need about 3x the steps.',
        body: [
          { p: 'I re-ran the main table of the modular-arithmetic grokking paper with the released code on one consumer GPU.' },
          {
            p: 'Four of the six settings reproduce within the reported error bars. The two largest models need about three times the stated number of steps before test accuracy jumps.',
          },
          { p: 'I have not found the reason. The learning-rate schedule in the code differs from the one in the paper, which is my first guess.' },
        ],
      },
      {
        id: 'r4',
        pl: 'rss',
        kind: 'article',
        pub: 'OpenArchive',
        au: 'Mendel, Osei, Varga et al.',
        h: 'openarchive.org',
        date: 'Nov 15',
        age: '12h',
        len: 'Preprint, 22 pages',
        tok: 1.1e4,
        sp: ['replication'],
        url: 'openarchive.org/abs/2611.0412',
        t: 'Anchoring effects in online samples: a 12-lab test',
        desc: 'A preregistered test of a classic anchoring effect in 12 labs, with 6,100 online participants.',
        sum: 'A preregistered 12-lab test of a classic anchoring effect with 6,100 online participants finds an effect about 40% of the original size.',
        body: [
          {
            p: 'We tested a classic anchoring effect in 12 labs with 6,100 participants recruited online. The protocol and analysis were preregistered.',
          },
          { p: 'The pooled effect was about 40% of the originally reported size, and it varied between labs more than sampling error predicts.' },
          { p: 'Materials, data and code are available on the project page.' },
        ],
      },
    ],
    miAdded: [],
    joined: ['public', 'scifi', 'ml', 'markets', 'math', 'grants', 'sablefield'],
    roles: { scifi: 'Moderator', ml: 'Admin', math: 'Owner', sablefield: 'Admin' },
    roles0: { scifi: 'Moderator', ml: 'Admin', math: 'Owner', sablefield: 'Admin' },
    rel: { replication: 'none', northwind: 'none', grants: 'member', ward7: 'none' },
    liked: { $set: [2] },
    saved: { $set: [0, 3, 6, 9, 11, 12, 13, 15] },
    qtSaved: { $set: ['11:c2'] },
    miSaved: { $set: ['m2'] },
    miRead: { $set: ['m6', 'm8'] },
    userKeys: [
      { id: 'k2', kind: 'key', label: 'Gemini API key', sub: 'AIza…Q7mE · Added Nov 3', valid: true },
      { id: 'k1', kind: 'key', label: 'Anthropic API key', sub: 'sk-ant-…4f2a · Added Oct 2', valid: true },
      { id: 'k0', kind: 'key', label: 'Old API key', sub: 'sk-…91c0 · Rejected by the provider', valid: false, reason: 'it was revoked' },
    ],
    notifs: [
      {
        id: 'nqt1',
        k: 'reply',
        u: 'hal_b',
        age: '5m',
        unread: true,
        open: 0,
        qtNode: 'h1',
        text: 'asked about your ask <b>How does the Daemon’s darknet decide who gets which task?</b>',
        why: 'Is that closer to a labour market or to a reputation ledger?',
      },
      {
        id: 'n1',
        k: 'reply',
        u: 'hal_b',
        age: '3m',
        unread: true,
        open: 0,
        text: 'followed up on your ask <b>Intention marketplaces in science fiction</b>',
      },
      { id: 'n2', k: 'reply', u: 'jun.park', age: '1d', open: 8, text: 'followed up on your ask <b>What 1960s SF got right about video calls</b>' },
      { id: 'ninv', k: 'invite', u: 'jun.park', sp: 'ward7', age: '4h', unread: true, text: 'invited you to join <b>#ward-7-tenants</b>' },
    ],
    askedInv: [],
    invite: { sp: 'ward7', by: 'jun.park', state: 'ok' },
    reqs: [
      {
        u: 'noor.a',
        age: '2h',
        since: 'Sep 2026',
        th: 14,
        common: ['ml', 'math'],
        bio: 'PhD student working on training dynamics.',
        a: [
          'Grokking results on modular arithmetic. I can re-run the small models and compare them with the released training logs.',
          'github.com/noor-a/grokking-rerun',
        ],
        st: 'open',
        why: '',
      },
      {
        u: 'ekow',
        age: '5h',
        since: 'Sep 2026',
        th: 6,
        common: ['scifi'],
        bio: 'Social psychologist. Preregistration and effect sizes.',
        a: ['Effect sizes in the ego-depletion literature, starting with the multi-site studies.', ''],
        st: 'open',
        why: '',
      },
      {
        u: 'dana.l',
        age: '9h',
        since: 'Nov 2026',
        th: 0,
        common: [],
        bio: '',
        fresh: true,
        a: ['Anything about climate attribution.', ''],
        st: 'open',
        why: '',
      },
      {
        u: 'yuki.t',
        age: '1d',
        since: 'Oct 2026',
        th: 3,
        common: ['ml'],
        bio: 'Research engineer. Mostly evaluation code.',
        a: ['Contamination checks for reasoning benchmarks from the last two years.', 'yuki.dev/notes/contamination'],
        st: 'open',
        why: '',
      },
      {
        u: 'bram',
        age: '2d',
        since: 'Sep 2026',
        th: 22,
        common: ['markets', 'history'],
        bio: 'Economics teacher.',
        a: ['Minimum-wage employment studies, using the original data where it is public.', ''],
        st: 'open',
        why: '',
      },
    ],
    mem: [
      { u: 'lettie', role: 'owner', since: 'Oct 2026' },
      { u: 'mira_k', role: 'mod', since: 'Oct 2026' },
      { u: 'ines.v', role: 'admin', since: 'Oct 2026' },
      { u: 'oduya', role: 'member', since: 'Oct 2026' },
      { u: 'hal_b', role: 'member', since: 'Oct 2026' },
      { u: 'jun.park', role: 'member', since: 'Nov 2026' },
      { u: 'pat.r', role: 'member', since: 'Nov 2026' },
      { u: 'cleo', role: 'member', since: 'Nov 2026' },
    ],
    memOther: {},
    banned: [{ id: 'replication:bulk_poster', sp: 'replication', u: 'bulk_poster', when: 'Nov 2' }],
    links: [
      { id: 'l1', code: 'rk7Q2', by: 'lettie', exp: 'Nov 21', sp: 'replication' },
      { id: 'l2', code: 'm3Hx9', by: 'mira_k', exp: '', sp: 'replication' },
      { id: 'l3', code: 'p0Wd4', by: 'lettie', exp: 'Nov 10', dead: 'Used', usedBy: 'dana.l', sp: 'replication' },
      { id: 'l4', sp: 'grants', code: 'g8Tn3', by: 'ines.v', exp: 'Nov 24' },
      { id: 'l5', sp: 'grants', code: 'q2Lr7', by: 'tomasz', exp: '' },
    ],
    reports: [
      {
        id: 'rp1',
        sp: 'sablefield',
        key: 'a:31',
        why: 'old',
        note: 'The Free plan limit went up to 250,000 rows on Nov 10. The pricing page shows the new number.',
        by: 'hal_b',
        age: '2h',
        st: 'open',
      },
      { id: 'rp2', sp: 'sablefield', key: 'r:48:2', why: 'offensive', note: '', by: 'cleo', age: '5h', st: 'open' },
    ],
    modSt: {},
    dsDrops: {
      ml: [
        { m: 'm9', by: 'hal_b', age: '16h' },
        { m: 'm5', by: 'mira_k', age: '19h', note: 'The maintainers’ reply to the RB-2 report.' },
        { m: 'm1', by: 'jun.park', age: '1d', note: 'The match list and the script are linked in post 6.' },
        { m: 'm2', by: 'lettie', age: '1d' },
        { m: 'm3', by: 'oduya', age: '2d' },
        { m: 'm4', by: 'mira_k', age: '3d', note: 'The part on contamination starts at 09:15.' },
        { m: 'm7', by: 'sol', age: '3d' },
        { m: 'm6', by: 'hal_b', age: '4d' },
        { m: 'm8', by: 'mira_k', age: '5d' },
        { m: 'm10', by: 'hal_b', age: '10d' },
      ],
      replication: [
        { m: 'r4', by: 'lettie', age: '11h' },
        { m: 'm1', by: 'lettie', age: '20h' },
        { m: 'r1', by: 'tomasz', age: '1d', note: 'Data and analysis code are public.' },
        { m: 'r2', by: 'lettie', age: '2d' },
        { m: 'r3', by: 'tomasz', age: '3d' },
      ],
      public: [
        { m: 'r4', by: 'tomasz', age: '40m', rv: true, note: 'A preregistered 12-lab test, relevant to the anchoring threads.' },
        { m: 'm2', by: 'sol', age: '1d' },
      ],
    },
    dsPol: { public: 'review' },
    dsReps: [{ m: 'm7', sid: 'ml', by: 'oduya', why: 'broken', age: '1d' }],
    profile: { name: 'Ines V.', bio: 'Reading science fiction for ideas about markets and coordination. Mostly asks in #sci-fi and #public.' },
    skills: {
      public: [
        [
          'summarizing-articles',
          `Summarizes an article and lists its main claims with the evidence given for each. Use when someone shares a link to an article, essay or blog post and asks what it says.

## Steps
1. Read the whole article, including footnotes.
2. Write a three-sentence summary.
3. List each main claim with the passage that supports it.

## Output
- Quote supporting passages exactly.
- Mark claims the article gives no evidence for.`,
        ],
        [
          'transcribing-videos',
          `Transcribes a video and produces a timestamped outline of its sections. Use when someone links a video or a recorded talk and asks for a transcript, an outline or where a topic comes up.

## Steps
1. Transcribe the audio with speaker labels.
2. Split the transcript into sections of 2 to 10 minutes.
3. Give each section a timestamp and a one-line title.

Mark parts that cannot be heard as [inaudible].`,
        ],
        [
          'reviewing-pull-requests',
          `Reviews a public pull request for correctness bugs and risky changes. Use when someone links a GitHub or GitLab pull request and asks whether it is safe to merge.

## Checks
- Logic errors and unhandled cases in the changed lines.
- Changes to public APIs, migrations or configuration.
- Tests that were removed or weakened.

Cite the file and line for each finding. Say so when nothing was found.`,
        ],
        [
          'auditing-codebases',
          `Audits a public repository for security issues and unmaintained dependencies. Use when someone links a repository and asks whether it is safe to depend on.

## Steps
1. List direct dependencies with the date of their last release.
2. Flag dependencies with published security advisories.
3. Look for committed secrets, unsafe deserialization and shell injection.

Separate confirmed issues from things to check by hand.`,
        ],
      ],
      scifi: [
        [
          'finding-works-on-a-theme',
          `Finds novels and short stories that explore a theme and groups them by approach. Use when someone names a theme, idea or technology and asks which science fiction deals with it.

## Steps
1. Find works where the theme is central, not incidental.
2. Group them by approach, for example utopian, satirical or procedural.
3. Give the author, the year and one sentence for each work.

Mark spoilers as the spoiler policy page describes.`,
        ],
        [
          'tracing-terms',
          `Traces how a term was coined and how its meaning changed over time. Use when someone asks where a word or concept from science fiction comes from.

## Steps
1. Find the earliest known use, with a citation.
2. List later uses that changed the meaning, in order.
3. Say how the term is used now.

Prefer primary sources to encyclopedias.`,
        ],
      ],
      ml: [
        [
          'summarizing-papers',
          `Summarizes a research paper: the claim, the method, the main results and what was not tested. Use when someone gives an arXiv ID or a link to a paper.

## Output
- Claim: one sentence.
- Method: data, model and evaluation.
- Results: the main table, with numbers.
- Not tested: settings, baselines or ablations the paper leaves out.

Copy numbers from the paper without rounding them.`,
        ],
        [
          'checking-benchmark-claims',
          `Checks whether a reported benchmark result holds up by comparing it with other reported numbers and setups. Use when someone asks whether a benchmark score is credible.

## Steps
1. Find other reports for the same benchmark and model size.
2. Compare prompts, number of shots, decoding settings and contamination checks.
3. Say whether the result is consistent with the others, and why.`,
        ],
        [
          'comparing-papers',
          `Compares two papers on method, data and results. Use when someone gives two papers and asks how they differ or which result to trust.

Make a table with one row each for method, data, evaluation and main result. Below it, list the differences that explain different results.`,
        ],
      ],
      markets: [
        [
          'explaining-mechanisms',
          `Explains how a market mechanism works, with a worked example. Use when someone asks how an auction, a clearing process or a pricing rule works.

## Steps
1. Describe the participants and what each one submits.
2. Work through one example with numbers.
3. Name a real market that uses the mechanism.`,
        ],
        [
          'comparing-data-sources',
          `Compares public data sources for a market metric on coverage, latency and licence. Use when someone asks where to get data for a metric.

Make a table of sources with columns for coverage, update frequency, delay and licence. Link each source.`,
        ],
      ],
      history: [
        [
          'finding-primary-sources',
          `Finds primary sources for a historical event and says where each one can be read. Use when someone asks for original documents, letters or records about an event.

## Steps
1. List documents written at the time by participants or witnesses.
2. For each one, give the archive or edition and whether it is online.
3. Note translations and their dates.`,
        ],
      ],
    },
    pagedocs: {},
    acct: {
      email: 'ines@example.com',
      emailNew: null,
      exportAt: null,
      emailOn: true,
      types: { replies: true, followups: true, reqs: true, reports: true, pages: false },
      spaces: { public: 'mentions' },
    },
    muted: { $set: [] },
    blocked: { $set: [] },
    usage: {
      cap: 2e6,
      reset: 'Dec 1',
      def: 'k2',
      movedSeen: false,
      by: {
        session: { public: 4.2e5, scifi: 2.6e5, replication: 2e5, grants: 1.6e5, markets: 2.2e5, ml: 1.2e5 },
        k2: { public: 3e5, markets: 7.2e4 },
        k1: { scifi: 1.6e5, replication: 2.4e5, grants: 2.12e5 },
        'skey:markets': { markets: 1.8e5 },
        'skey:ml': { ml: 9.6e4 },
      },
      skeys: {
        markets: { prov: 'Google', mask: 'AIza…k2Pq', by: 'oduya', cap: 6e6, used: 3.9e6, member: 0 },
        ml: { prov: 'OpenAI', mask: 'sk-…7d1e', by: 'mira_k', cap: 8e6, used: 5.84e6, member: 3e5 },
      },
    },
    repSeen: false,
    reqSeen: false,
    rpLiked: { $set: [] },
  },
};
