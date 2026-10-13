//! Standalone `session-cli` binary: the Session CLI without the app.

fn main() {
    match session_cli::run_cli_if_requested() {
        Ok(true) => {}
        Ok(false) => {
            eprintln!("usage: session-cli <send|ping|--version>");
            std::process::exit(2);
        }
        Err(err) => {
            let (message, exit_code) = session_cli::error_report(&err);
            eprintln!("session-cli: {message}");
            std::process::exit(exit_code);
        }
    }
}
