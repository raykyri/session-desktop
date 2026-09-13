# Session

Session is a desktop research workspace for running long-form investigations with
coding agents. It keeps questions, follow-ups, sources, and generated answers
together in a durable research tree.

The application has completed its product, storage, and integration cutover to
**Session**. The desktop app uses the Session Apple identity; legacy hosted-service URLs remain documented in [the cutover guide](docs/session-cutover.md).

## Features

- Run research with supported Claude Code, Codex, and Grok installations.
- Branch from any answer while preserving the context that led to it.
- Organize research trees into local workspaces and sidebar folders.
- Browse recent research activity from Home.
- Inspect source links and local artifacts in the built-in browser.
- Save highlights, review full run activity, and publish answers or trees.
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

`npm run preflight` is shared with the release script. It checks frontend/server
TypeScript (including unused symbols), module reachability, Rust formatting, and
all unit, server integration, and Rust tests. For a faster frontend-only check, use
`npm run check:types` and `npm run test:unit`.

Use `npm run test:node -- tests/example.test.ts` for focused TypeScript tests.
This runner and `dev:site` share `tsconfig.runtime.json`, so JSX uses the same
automatic React transform as the builds. The module reachability check recognizes
the app entrypoint, the website server, and tests, including literal lazy imports
and type-only imports; it does not audit Rust command registration or unused exports
inside otherwise reachable modules.

The Tauri product name is `Session`; the executable is `session`, with standalone
`session-cli` and shared `session-proto` crates. Apple bundle/Keychain identity,
signing keys, native bridge symbols, and existing data paths remain unchanged.
See [docs/session-cutover.md](docs/session-cutover.md) for environment changes and
restart/deployment requirements.

## Publishing configuration

Research publishing uses a GitHub OAuth App with Device Flow and the `gist` scope.
Configure publishing through these app-owned environment variables:

```sh
SESSION_GITHUB_CLIENT_ID=<oauth-client-id> npm run dev:tauri
```

Published links default to `https://qmux.app/p/<gist-id>`. Use
`SESSION_SHARE_BASE_URL` to point development builds at another origin.

## Keyboard shortcuts

- `Cmd-N` or `Cmd-T`: open Home and its research-query composer.
- `Cmd-J`: focus the open document's follow-up composer.
- `Cmd-O`: open or close the research workspace menu.
- `Cmd/Ctrl-[` and `Cmd/Ctrl-]`, `Alt-Left` and `Alt-Right`: move through
  research history.
- `Cmd-1` through `Cmd-9`: focus the corresponding research item.
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
