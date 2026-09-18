# Session Web — design documents

These documents describe how to port the Session desktop application (Tauri +
Rust backend, React frontend under `src/`) to a hosted web application at
`https://session.dev`, living in `web/`, built with npm, Vite, React,
TypeScript, Tailwind CSS, Drizzle ORM over SQLite, an agent loop on the
Vercel AI SDK, and deployed to Fly.io as the single app `session-dev`.

This is a hard cutover. The web app does not import desktop data, does not
run agent CLIs, and only preserves desktop file formats, identifiers, or wire names where doing so simplifies the migration.

Read them in order. `00-plan.md` is the master document; its §8 is the
parity checklist, walked and marked at the end of Phase 9.

For running, testing, and deploying the app, start from the repository's
[README](../../README.md#web-application), then
`12-testing-linting-ci.md` and `13-deployment-fly.md`.

| Doc | Scope |
| --- | --- |
| [00-plan.md](00-plan.md) | Goals, non-goals, phase plan, risks, parity checklist, open questions |
| [01-architecture-decisions.md](01-architecture-decisions.md) | Every upfront decision with alternatives (ADR-1 … ADR-18) |
| [02-domain-model-and-database.md](02-domain-model-and-database.md) | Domain model, SQLite schema, Drizzle layout, migrations, invariants |
| [03-api-and-events.md](03-api-and-events.md) | tRPC procedure inventory, event stream, HTTP routes |
| [04-agent-runtime.md](04-agent-runtime.md) | Models, the AI SDK agent loop, owned tools, canonical messages, documents as context, metadata runs, usage |
| [05-run-lifecycle-and-streaming.md](05-run-lifecycle-and-streaming.md) | Run state machine, durability, restorable streaming, interruption and auto-resume, admission |
| [06-auth-and-users.md](06-auth-and-users.md) | GitHub OAuth, sessions, admin flag, settings storage |
| [07-client-architecture.md](07-client-architecture.md) | Client layout, routing, state management, API client, event bridge |
| [08-design-system-and-styling.md](08-design-system-and-styling.md) | Tailwind v4 over the token system, Base UI, reusable components |
| [09-research-document-view.md](09-research-document-view.md) | Porting `ResearchDocument.tsx`: timeline, highlights, follow-ups, recap, branches |
| [10-home-feed-journal-encyclopedia.md](10-home-feed-journal-encyclopedia.md) | Home feed, composer with documents, journal/X posts, encyclopedia, sidebar |
| [11-artifacts-and-browser.md](11-artifacts-and-browser.md) | Document preview replacing the native browser overlay |
| [12-testing-linting-ci.md](12-testing-linting-ci.md) | AVA, Playwright, fixture providers, ESLint, Prettier, CI |
| [13-deployment-fly.md](13-deployment-fly.md) | Fly app, Dockerfile, volume, secrets, backups, operations |
| [14-legacy-inventory.md](14-legacy-inventory.md) | What is dropped and every reference to the old `web/` landing site |
| [runbooks/](runbooks) | Operator procedures; `restore.md` is the backup-restore rehearsal |

Conventions:

- File references like `src-tauri/src/state.rs:5244` point at the desktop
  codebase as of commit `46f7e66` and are the source of truth for behavior
  the port preserves.
- Wire-format names from `src/types.ts` are kept by default and renamed
  where misleading.
