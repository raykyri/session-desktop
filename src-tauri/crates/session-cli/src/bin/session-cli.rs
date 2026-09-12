//! Standalone `session-cli` binary. Locally the Session app binary doubles as the
//! CLI, so this exists for hosts that get the CLI without the app — it is what
//! a remote launch target ships and points its hooks and shell wrappers at.

fn main() {
    match session_cli::run_cli_if_requested() {
        Ok(true) => {}
        Ok(false) => {
            eprintln!(
                "usage: session-cli [--version|send|ping|notify|pane-write|cwd|agent-exec|agent-detach|claude|codex|grok|devin|muse-notify|cursor-notify|mcp|fork|open]"
            );
            std::process::exit(2);
        }
        Err(err) => {
            let (message, exit_code) = session_cli::error_report(&err);
            eprintln!("session-cli: {message}");
            std::process::exit(exit_code);
        }
    }
}
