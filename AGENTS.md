This is Session, a research workspace for long-running agent investigations.
Product copy, Rust packages, CLI commands, app-owned environment variables, and
internal event names use Session/session/SESSION_*. Preserve Apple bundle,
Keychain, signing, and native bridge identifiers. Existing qmux storage paths,
configuration filenames, persisted format markers, and hosted-service identifiers
remain compatibility contracts; see docs/session-cutover.md. Do not globally
replace qmux strings without checking that boundary.
For commit messages, include a short description followed by a
paragraph or bullet-point list of details about what was committed.
Use multiple -m arguments instead of \n to break lines in commits.
Don't ask to re-run 'cargo test' if there is a test that fails because
of your sandboxing permissions, unless your work involves that test.
