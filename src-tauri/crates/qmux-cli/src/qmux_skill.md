---
name: qmux
description: "Use Session's compatibility CLI from a Session-managed research agent. Requires QMUX_ENV=1."
---

# Session compatibility CLI

Session retains the `qmux` executable name, environment variables, socket protocol,
and command identifiers for compatibility. These are internal identifiers; the
desktop product is Session and its user interface is dedicated to research.

Before issuing a control command, verify that the caller is running in a
Session-managed agent process:

```bash
test "${QMUX_ENV:-}" = 1
```

If that fails, stop. Do not attempt to control another Session window or search the
environment for credentials.

Use the installed binary as the authority for syntax:

```bash
qmux --help
qmux context
qmux agent --help
qmux artifact --help
```

Responses use a versioned JSON envelope. Successful responses have `ok: true`,
`apiVersion`, and `result`; failures have `ok: false` and an `error` object. Read
opaque IDs from responses rather than deriving them from names or sidebar order.

Research agents may inspect their own context, coordinate explicitly related agent
runs, and open artifacts already recorded by Session:

```bash
qmux context
qmux agent get <agent-id>
qmux agent wait <agent-id> --until settled --timeout 2m
qmux agent read <agent-id> --source transcript --turns 6
qmux agent prompt <agent-id> "Continue with the strongest source."
qmux artifact list
qmux artifact open <artifact-id>
```

Agent credentials are intentionally narrower than interactive user credentials.
Never expose `QMUX_TOKEN` or `QMUX_USER_TOKEN`, search for a stronger token, infer a
target from UI position, or mutate an unrelated run. Inspect a record before
prompting or releasing it. A timeout may leave work running, so read the latest
state before retrying.
