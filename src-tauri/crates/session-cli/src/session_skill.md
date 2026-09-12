---
name: session
description: "Use Session's CLI from a Session-managed research agent. Requires SESSION_ENV=1."
---

# Session CLI

Use `session` in an app-managed shell, or the binary named by `SESSION_CLI`.
Remote hosts use `session-cli`. The command API uses a versioned socket protocol.

Before issuing a control command, verify that the caller is running in a
Session-managed agent process:

```bash
test "${SESSION_ENV:-}" = 1
```

If that fails, stop. Do not attempt to control another Session window or search the
environment for credentials.

Use the installed binary as the authority for syntax:

```bash
session --help
session context
session agent --help
session artifact --help
```

Responses use a versioned JSON envelope. Successful responses have `ok: true`,
`apiVersion`, and `result`; failures have `ok: false` and an `error` object. Read
opaque IDs from responses rather than deriving them from names or sidebar order.

Research agents may inspect their own context, coordinate explicitly related agent
runs, and open artifacts already recorded by Session:

```bash
session context
session agent get <agent-id>
session agent wait <agent-id> --until settled --timeout 2m
session agent read <agent-id> --source transcript --turns 6
session agent prompt <agent-id> "Continue with the strongest source."
session artifact list
session artifact open <artifact-id>
```

Agent credentials are intentionally narrower than interactive user credentials.
Never expose `SESSION_TOKEN` or `SESSION_USER_TOKEN`, search for a stronger token, infer a
target from UI position, or mutate an unrelated run. Inspect a record before
prompting or releasing it. A timeout may leave work running, so read the latest
state before retrying.
