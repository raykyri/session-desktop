# Session

Session is a desktop research workspace for running long-form investigations with
coding agents. It keeps questions, follow-ups, sources, and generated answers
together in a durable research tree.

The application has completed its product, storage, and integration cutover to
**Session**. The desktop app uses the Session Apple identity; legacy hosted-service URLs remain documented in [the cutover guide](docs/session-cutover.md).

## Features

- Run research with supported Claude Code, Codex, and Grok installations.
- Branch from any answer while preserving the context that led to it.
- Organize research trees into local workspaces.
- Browse recent research activity from Home.
- Inspect source links and local artifacts in the built-in browser.
- Save highlights and review full run activity.
- Recover research history, drafts, active runs, and navigation state after restart.

Session intentionally has no terminal surface, terminal tabs, transcript side pane,
terminal map, shell launcher, or terminal appearance settings. Research runtimes may
still use process and compatibility infrastructure inherited from session internally.

## Install

Session currently requires macOS 13 or later. Install and authenticate at least one
supported provider before opening **Settings → Agents**.

| Provider | Sign in | Research support |
| --- | --- | --- |
| Claude Code | `claude auth login` | Claude Code 2.1.0 or later |
| Codex | `codex login` | Supported |
| Grok | `grok login` | Supported |

Session uses existing provider credentials and does not copy or manage them.

## Development

Prerequisites:

- macOS 13 or later
- Swift 6 and a macOS SDK for the AppKit/WebKit support bridge
- Rust toolchain
- Node.js and npm
- One or more supported agent CLIs

Install dependencies and run the application:

```sh
npm install
npm run dev
```

Build and validate:

```sh
npm run preflight
npm run build
```

`npm run preflight` is shared with the release script. It checks frontend
TypeScript (including unused symbols), module reachability, Rust formatting, and
all unit and Rust tests. For a faster frontend-only check, use
`npm run check:types` and `npm run test:unit`.

Use `npm run test:node -- tests/example.test.ts` for focused TypeScript tests.
The runner uses `tsconfig.runtime.json`, so JSX uses the same automatic React
transform as the builds. The module reachability check recognizes the app
entrypoint and tests, including literal lazy imports and type-only imports; it
does not audit Rust command registration or unused exports inside otherwise
reachable modules.

The Tauri product name is `Session`; the executable is `session`, with standalone
`session-cli` and shared `session-proto` crates. Apple bundle/Keychain identity,
signing keys, native bridge symbols, and existing data paths remain unchanged.
See [docs/session-cutover.md](docs/session-cutover.md) for environment changes and
restart/deployment requirements.

## Web application

`web/` holds the Session web application at `https://session.dev`: an npm
workspaces root with `packages/shared` (domain types and pure logic),
`packages/db` (Drizzle over SQLite), `packages/server` (Hono, tRPC, SSE, the
agent loop), and `packages/client` (React, Vite, Tailwind). It is developed,
tested, and deployed independently of the desktop app, and shares no build with
it.

Run it locally:

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
`packages/server/src/runs/fixtures/` instead of the network. A prompt
containing `fixture:<scenario>` picks which one.

Check and test:

```sh
npm run check     # tsc -b, ESLint, Prettier, drizzle-kit check
npm test          # AVA in every package
npm run test:e2e  # Playwright (Chromium); builds the client and starts a server
```

Deploy (one Fly app, `session-dev`, one machine with a volume):

```sh
fly deploy web -c web/fly.toml
```

The positional `web` is the build context; without it flyctl would hand Docker
the repository root, where `package.json` is the desktop's. CI runs the same
command behind a manual approval environment.

Plans and specifications are in [web/docs](web/docs), starting with
[web/docs/00-plan.md](web/docs/00-plan.md); the operational documents are
[web/docs/12-testing-linting-ci.md](web/docs/12-testing-linting-ci.md) and
[web/docs/13-deployment-fly.md](web/docs/13-deployment-fly.md).

## Keyboard shortcuts

- `Cmd-N` or `Cmd-T`: open Home and its research-query composer.
- `Cmd-J`: focus the open document's follow-up composer.
- `Cmd-O`: open or close the research workspace menu.
- `Cmd/Ctrl-[` and `Cmd/Ctrl-]`, `Alt-Left` and `Alt-Right`: move through
  research history.
- `Cmd-Shift-G`: show or hide the sidebar.
- `Cmd-,`: open Settings.

## Architecture

The React frontend lives under `src/`. Research views, including the in-app
Home feed, are in `src/components/research/`. Durable research state
and execution are implemented by `src-tauri/src/research.rs`,
`research_runtime.rs`, and `state.rs`.

Research data is stored under the configured Session workspace root.
The development configuration in `session.config.json` uses `~/.session/workspaces` and
`~/.session/run/session.sock`. Shipping builds use the platform application-data location for
`dev.session.desktop`.

See [docs/home.md](docs/home.md) for the activity feed and
its navigation and journal actions.
Frontend styling conventions and stylesheet ownership are documented in
[docs/css-conventions.md](docs/css-conventions.md).
