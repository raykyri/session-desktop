# Session

Session is a shared research workspace on the web. Members ask questions that
an agent researches and answers with sources, branch from any passage of an
answer, comment on branches, and post to channels. Membership is
invite-only.

## Repository

`web/` is an npm workspaces root:

- `packages/shared`: the spaces contract (`schemas/spaces.ts`), the model
  registry and the Markdown pipeline.
- `packages/replica-proto`: the phase 0 prototype server half and its
  acceptance suites.
- `packages/db`: Drizzle over SQLite.
- `packages/server`: Hono, tRPC, the sync routes and the agent run loop.
- `packages/client`: React, Vite, Tailwind.

`docs/mockups/session-web-members.html` is the product surface. The build
plan is [web/docs/15-implementation-plan](web/docs/15-implementation-plan),
starting with `00-overview.md`.

## Development

Requires Node.js 22.20 or later.

```sh
cd web
cp .env.example .env
npm install
npm run dev
```

That serves the API on `http://localhost:8787` and the client on
`http://localhost:1480`. `.env.example` documents every variable. No provider
credentials are needed for UI work: set `SESSION_FIXTURE_PROVIDERS=1` and every
model, and `web_fetch` with it, is answered from the recorded fixtures in
`packages/server/src/runs/fixtures/` instead of the network.

Check and test:

```sh
npm run check     # tsc -b, ESLint, Prettier, drizzle-kit check
npm test          # AVA in every package
npm run test:e2e  # Playwright (Chromium); builds the client and starts a server
```

## Deployment

One Fly app with one machine and a volume; SQLite is replicated with
Litestream. See [web/docs/13-deployment-fly.md](web/docs/13-deployment-fly.md)
and `web/docs/15-implementation-plan/05-delivery.md` §3.
