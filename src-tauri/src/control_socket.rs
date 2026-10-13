use crate::connection_limit::ConnectionLimiter;
use crate::events::SessionEvent;
use crate::state::{AppState, canonical_loopback_artifact_url};
use serde_json::{Value, json};
use session_proto::{ControlRequest, ControlResponse};
use std::fs;
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const CONTROL_SOCKET_READ_TIMEOUT: Duration = Duration::from_secs(5);
/// The streamed upload body is not part of this line. Keep request metadata
/// bounded before authentication so a peer cannot grow a handler without limit.
const MAX_CONTROL_HEADER_BYTES: u64 = 16 * 1024 * 1024;
/// Cap on concurrent client-handler threads. Connections are mostly one-shot
/// (hook notifies, CLI invocations); remote file uploads may remain active for
/// up to 60 seconds. This covers simultaneous in-flight requests, not panes,
/// while keeping a connection-spamming process from exhausting threads/FDs. At
/// the cap the supervisor leaves excess connections in the kernel listen backlog
/// and keeps polling so health checks still run.
const MAX_CONCURRENT_CLIENTS: usize = 64;
/// Backoff after a failed accept. Persistent accept errors (e.g. EMFILE under
/// FD exhaustion) would otherwise spin this loop hot.
const ACCEPT_ERROR_BACKOFF: Duration = Duration::from_millis(100);
#[cfg(not(test))]
const HEALTH_POLL_TIMEOUT: Duration = Duration::from_millis(500);
#[cfg(test)]
const HEALTH_POLL_TIMEOUT: Duration = Duration::from_millis(50);
#[cfg(not(test))]
const RECOVERY_BACKOFF: Duration = Duration::from_millis(100);
#[cfg(test)]
const RECOVERY_BACKOFF: Duration = Duration::from_millis(20);
const RECOVERY_BACKOFF_MAX: Duration = Duration::from_secs(2);
const REPEATED_RECOVERY_FAILURES_BEFORE_WARN: u32 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SocketWatchState {
    Healthy,
    Missing,
    Recovering,
    Conflict,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PathCheck {
    Healthy,
    Missing,
    Conflict,
    Unknown,
}

enum GenerationEnd {
    Stopped,
    Missing,
    Conflict,
}

struct SupervisorShared {
    stop: AtomicBool,
    generation: AtomicU64,
    #[cfg(test)]
    panic_next: AtomicBool,
    #[cfg(test)]
    transitions: Mutex<Vec<String>>,
}

/// Manages the control-socket supervisor thread. Shutdown must stop and join this
/// before removing the socket file; otherwise the watchdog can recreate the
/// path while the process is exiting.
pub struct ControlSocketRuntime {
    shared: Arc<SupervisorShared>,
    wakeup: Mutex<Option<UnixStream>>,
    thread: Mutex<Option<JoinHandle<()>>>,
    state: AppState,
}

impl ControlSocketRuntime {
    /// Stop the supervisor, join it, then remove the pathname only if this
    /// process still owns the inode currently at the configured path.
    pub fn shutdown(&self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        if let Ok(guard) = self.wakeup.lock()
            && let Some(wakeup) = guard.as_ref()
        {
            let _ = (&*wakeup).write_all(&[1]);
        }
        if let Ok(mut slot) = self.thread.lock()
            && let Some(handle) = slot.take()
            && handle.thread().id() != thread::current().id()
        {
            let _ = handle.join();
        }
        if self.state.owns_control_socket() {
            let _ = fs::remove_file(&self.state.config().socket_path);
        }
        self.state.clear_control_socket_identity();
    }

    #[cfg(test)]
    fn inject_panic(&self) {
        self.shared.panic_next.store(true, Ordering::SeqCst);
        if let Ok(guard) = self.wakeup.lock()
            && let Some(wakeup) = guard.as_ref()
        {
            let _ = (&*wakeup).write_all(&[1]);
        }
    }

    #[cfg(test)]
    fn transitions(&self) -> Vec<String> {
        self.shared
            .transitions
            .lock()
            .map(|events| events.clone())
            .unwrap_or_default()
    }
}

impl Drop for ControlSocketRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn start_control_socket(state: AppState) -> Result<ControlSocketRuntime, String> {
    crate::shell_jobs::start_shell_job_monitor(state.clone());
    start_control_socket_runtime(state, MAX_CONCURRENT_CLIENTS)
}

fn start_control_socket_runtime(
    state: AppState,
    max_clients: usize,
) -> Result<ControlSocketRuntime, String> {
    let socket_path = state.config().socket_path.clone();
    remove_stale_socket(&socket_path)?;
    let (listener, identity) = bind_control_socket(&socket_path)?;
    state.set_control_socket_identity(identity.0, identity.1);

    let (wakeup_reader, wakeup_writer) = UnixStream::pair()
        .map_err(|err| format!("failed to create control socket wakeup pipe: {err}"))?;
    wakeup_reader
        .set_nonblocking(true)
        .map_err(|err| format!("failed to configure control socket wakeup pipe: {err}"))?;
    wakeup_writer
        .set_nonblocking(true)
        .map_err(|err| format!("failed to configure control socket wakeup pipe: {err}"))?;

    let shared = Arc::new(SupervisorShared {
        stop: AtomicBool::new(false),
        generation: AtomicU64::new(1),
        #[cfg(test)]
        panic_next: AtomicBool::new(false),
        #[cfg(test)]
        transitions: Mutex::new(Vec::new()),
    });
    let thread_shared = Arc::clone(&shared);
    let thread_state = state.clone();
    let thread_path = socket_path.clone();
    let handle = thread::Builder::new()
        .name("session-control-socket".to_string())
        .spawn(move || {
            supervise_control_socket(
                thread_state,
                thread_path,
                listener,
                identity,
                wakeup_reader,
                thread_shared,
                max_clients,
            );
        })
        .map_err(|err| {
            if state.owns_control_socket() {
                let _ = fs::remove_file(&socket_path);
            }
            state.clear_control_socket_identity();
            format!("failed to start control socket supervisor: {err}")
        })?;

    Ok(ControlSocketRuntime {
        shared,
        wakeup: Mutex::new(Some(wakeup_writer)),
        thread: Mutex::new(Some(handle)),
        state,
    })
}

fn remove_stale_socket(socket_path: &Path) -> Result<(), String> {
    // Remove any stale socket unconditionally; a missing path is not an error.
    // Probing with exists() first would open a time-of-check/time-of-use window.
    match fs::remove_file(socket_path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!(
            "failed to remove stale socket {}: {err}",
            socket_path.display()
        )),
    }
}

fn bind_control_socket(socket_path: &Path) -> Result<(UnixListener, (u64, u64)), String> {
    // Restrict the socket's parent directory to the owning user *before* binding.
    // With the directory untraversable by other accounts, the socket is never
    // reachable by them even during the brief window between bind() and the
    // explicit chmod below, and no other user can pre-create the socket path.
    // Config attempts this at startup; enforce it strictly here to prevent
    // exposing the control plane through a world-traversable directory.
    if let Some(parent) = socket_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create socket dir {}: {err}", parent.display()))?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|err| format!("failed to restrict socket dir {}: {err}", parent.display()))?;
    }

    let listener = UnixListener::bind(socket_path)
        .map_err(|err| format!("failed to bind socket {}: {err}", socket_path.display()))?;

    // Restrict the socket to the owning user so the per-pane token is not the only thing
    // standing between other local accounts and the control plane.
    if let Err(err) = fs::set_permissions(socket_path, fs::Permissions::from_mode(0o600)) {
        drop(listener);
        let _ = fs::remove_file(socket_path);
        return Err(format!(
            "failed to restrict socket permissions {}: {err}",
            socket_path.display()
        ));
    }

    if let Err(err) = listener.set_nonblocking(true) {
        drop(listener);
        let _ = fs::remove_file(socket_path);
        return Err(format!(
            "failed to configure socket {} as nonblocking: {err}",
            socket_path.display()
        ));
    }

    let meta = match fs::symlink_metadata(socket_path) {
        Ok(meta) => meta,
        Err(err) => {
            drop(listener);
            let _ = fs::remove_file(socket_path);
            return Err(format!(
                "failed to stat bound socket {}: {err}",
                socket_path.display()
            ));
        }
    };
    Ok((listener, (meta.dev(), meta.ino())))
}

fn supervise_control_socket(
    state: AppState,
    socket_path: PathBuf,
    listener: UnixListener,
    mut identity: (u64, u64),
    wakeup: UnixStream,
    shared: Arc<SupervisorShared>,
    max_clients: usize,
) {
    let limiter = ConnectionLimiter::new(max_clients);
    let mut watch_state = SocketWatchState::Healthy;
    let mut recovery_failures = 0;
    let mut listener = Some(listener);

    loop {
        if shared.stop.load(Ordering::SeqCst) {
            break;
        }
        let Some(current) = listener.take() else {
            match recover_missing_socket(
                &state,
                &socket_path,
                &shared,
                &mut watch_state,
                &mut recovery_failures,
            ) {
                Recovered::Stopped => break,
                Recovered::Bound(next_listener, next_identity) => {
                    listener = Some(next_listener);
                    identity = next_identity;
                }
                Recovered::Conflict => {
                    if wait_for_conflict_to_clear(
                        &state,
                        &socket_path,
                        &wakeup,
                        &shared,
                        &mut watch_state,
                    )
                    .is_none()
                    {
                        break;
                    }
                }
            }
            continue;
        };

        let outcome = catch_unwind(AssertUnwindSafe(|| {
            run_listener_generation(
                &state,
                &socket_path,
                &current,
                identity,
                &wakeup,
                &shared,
                &limiter,
                &mut watch_state,
            )
        }));
        drop(current);

        match outcome {
            Ok(GenerationEnd::Stopped) => break,
            Ok(GenerationEnd::Missing) => {}
            Ok(GenerationEnd::Conflict) => {
                state.clear_control_socket_identity();
                if wait_for_conflict_to_clear(
                    &state,
                    &socket_path,
                    &wakeup,
                    &shared,
                    &mut watch_state,
                )
                .is_none()
                {
                    break;
                }
            }
            Err(_) => {
                reclaim_owned_socket(&state, &socket_path);
                enter_watch_state(
                    &state,
                    &socket_path,
                    &shared,
                    &mut watch_state,
                    SocketWatchState::Recovering,
                    Some("control socket listener panicked"),
                );
            }
        }
    }
}

enum Recovered {
    Stopped,
    Bound(UnixListener, (u64, u64)),
    Conflict,
}

fn recover_missing_socket(
    state: &AppState,
    socket_path: &Path,
    shared: &SupervisorShared,
    watch_state: &mut SocketWatchState,
    recovery_failures: &mut u32,
) -> Recovered {
    let mut backoff = RECOVERY_BACKOFF;
    loop {
        if shared.stop.load(Ordering::SeqCst) {
            return Recovered::Stopped;
        }
        match inspect_socket_path(socket_path, state.control_socket_identity()) {
            PathCheck::Conflict => {
                enter_watch_state(
                    state,
                    socket_path,
                    shared,
                    watch_state,
                    SocketWatchState::Conflict,
                    Some("control socket path is occupied by another listener"),
                );
                state.clear_control_socket_identity();
                return Recovered::Conflict;
            }
            PathCheck::Healthy | PathCheck::Missing | PathCheck::Unknown => {}
        }

        match bind_control_socket(socket_path) {
            Ok((listener, identity)) => {
                state.set_control_socket_identity(identity.0, identity.1);
                shared.generation.fetch_add(1, Ordering::SeqCst);
                *recovery_failures = 0;
                enter_watch_state(
                    state,
                    socket_path,
                    shared,
                    watch_state,
                    SocketWatchState::Healthy,
                    None,
                );
                return Recovered::Bound(listener, identity);
            }
            Err(err) => {
                if matches!(inspect_socket_path(socket_path, None), PathCheck::Conflict) {
                    enter_watch_state(
                        state,
                        socket_path,
                        shared,
                        watch_state,
                        SocketWatchState::Conflict,
                        Some(&err),
                    );
                    state.clear_control_socket_identity();
                    return Recovered::Conflict;
                }
                *recovery_failures = recovery_failures.saturating_add(1);
                enter_watch_state(
                    state,
                    socket_path,
                    shared,
                    watch_state,
                    SocketWatchState::Recovering,
                    Some(&err),
                );
                if *recovery_failures == REPEATED_RECOVERY_FAILURES_BEFORE_WARN {
                    warn_control_socket(
                        state,
                        &format!(
                            "session could not restore the control socket at {}: {err}. CLI commands will fail until it recovers.",
                            socket_path.display()
                        ),
                    );
                }
                if shared.stop.load(Ordering::SeqCst) {
                    return Recovered::Stopped;
                }
                thread::sleep(backoff);
                backoff = (backoff * 2).min(RECOVERY_BACKOFF_MAX);
            }
        }
    }
}

fn wait_for_conflict_to_clear(
    state: &AppState,
    socket_path: &Path,
    wakeup: &UnixStream,
    shared: &SupervisorShared,
    watch_state: &mut SocketWatchState,
) -> Option<()> {
    enter_watch_state(
        state,
        socket_path,
        shared,
        watch_state,
        SocketWatchState::Conflict,
        Some("control socket path is occupied by another listener"),
    );
    warn_control_socket(
        state,
        &format!(
            "The Session control socket at {} was replaced by another process. CLI commands will not reach this instance until that socket is removed. session will not delete it automatically.",
            socket_path.display()
        ),
    );
    loop {
        if shared.stop.load(Ordering::SeqCst) {
            return None;
        }
        match inspect_socket_path(socket_path, None) {
            PathCheck::Missing => {
                enter_watch_state(
                    state,
                    socket_path,
                    shared,
                    watch_state,
                    SocketWatchState::Missing,
                    None,
                );
                return Some(());
            }
            PathCheck::Healthy | PathCheck::Conflict | PathCheck::Unknown => {}
        }
        if poll_wakeup_only(wakeup, HEALTH_POLL_TIMEOUT).is_err()
            && shared.stop.load(Ordering::SeqCst)
        {
            return None;
        }
        drain_wakeup(wakeup);
    }
}

fn run_listener_generation(
    state: &AppState,
    socket_path: &Path,
    listener: &UnixListener,
    identity: (u64, u64),
    wakeup: &UnixStream,
    shared: &SupervisorShared,
    limiter: &ConnectionLimiter,
    watch_state: &mut SocketWatchState,
) -> GenerationEnd {
    let mut accept_error: Option<String> = None;
    loop {
        if shared.stop.load(Ordering::SeqCst) {
            return GenerationEnd::Stopped;
        }
        #[cfg(test)]
        if shared.panic_next.swap(false, Ordering::SeqCst) {
            panic!("test-injected control socket panic");
        }

        match poll_listener_and_wakeup(listener, wakeup, HEALTH_POLL_TIMEOUT) {
            Ok(ready) => {
                if ready.wakeup {
                    drain_wakeup(wakeup);
                    if shared.stop.load(Ordering::SeqCst) {
                        return GenerationEnd::Stopped;
                    }
                }
                if ready.listener {
                    match limiter.try_acquire() {
                        None => thread::sleep(ACCEPT_ERROR_BACKOFF),
                        Some(slot) => match listener.accept() {
                            Ok((stream, _)) => {
                                accept_error = None;
                                if let Err(err) = stream.set_nonblocking(false) {
                                    eprintln!(
                                        "session: failed to configure control socket client as blocking: {err}"
                                    );
                                    continue;
                                }
                                let state = state.clone();
                                let _ = thread::Builder::new()
                                    .name("session-control-client".to_string())
                                    .spawn(move || {
                                        let _slot = slot;
                                        handle_client(state, stream);
                                    });
                            }
                            Err(err) if err.kind() == ErrorKind::WouldBlock => {}
                            Err(err) if err.kind() == ErrorKind::Interrupted => {}
                            Err(err) => {
                                let message = err.to_string();
                                if accept_error.as_deref() != Some(message.as_str()) {
                                    accept_error = Some(message.clone());
                                    enter_watch_state(
                                        state,
                                        socket_path,
                                        shared,
                                        watch_state,
                                        SocketWatchState::Recovering,
                                        Some(&message),
                                    );
                                }
                                thread::sleep(ACCEPT_ERROR_BACKOFF);
                            }
                        },
                    }
                }
            }
            Err(err) => {
                let message = err.to_string();
                enter_watch_state(
                    state,
                    socket_path,
                    shared,
                    watch_state,
                    SocketWatchState::Recovering,
                    Some(&message),
                );
                thread::sleep(ACCEPT_ERROR_BACKOFF);
            }
        }

        match inspect_socket_path(socket_path, Some(identity)) {
            PathCheck::Healthy => {
                if *watch_state != SocketWatchState::Healthy {
                    enter_watch_state(
                        state,
                        socket_path,
                        shared,
                        watch_state,
                        SocketWatchState::Healthy,
                        None,
                    );
                }
            }
            PathCheck::Missing => {
                enter_watch_state(
                    state,
                    socket_path,
                    shared,
                    watch_state,
                    SocketWatchState::Missing,
                    None,
                );
                return GenerationEnd::Missing;
            }
            PathCheck::Conflict => {
                enter_watch_state(
                    state,
                    socket_path,
                    shared,
                    watch_state,
                    SocketWatchState::Conflict,
                    Some("control socket path is occupied by another listener"),
                );
                return GenerationEnd::Conflict;
            }
            PathCheck::Unknown => {}
        }
    }
}

fn inspect_socket_path(path: &Path, owned: Option<(u64, u64)>) -> PathCheck {
    match fs::symlink_metadata(path) {
        Ok(meta) => match owned {
            Some((device, inode)) if meta.dev() == device && meta.ino() == inode => {
                PathCheck::Healthy
            }
            Some(_) => PathCheck::Conflict,
            None => PathCheck::Conflict,
        },
        Err(err) if err.kind() == ErrorKind::NotFound => PathCheck::Missing,
        Err(_) => PathCheck::Unknown,
    }
}

fn reclaim_owned_socket(state: &AppState, socket_path: &Path) {
    if state.owns_control_socket() {
        let _ = fs::remove_file(socket_path);
    }
    state.clear_control_socket_identity();
}

fn enter_watch_state(
    state: &AppState,
    socket_path: &Path,
    shared: &SupervisorShared,
    current: &mut SocketWatchState,
    next: SocketWatchState,
    error: Option<&str>,
) {
    if *current == next {
        return;
    }
    *current = next;
    let event = match next {
        SocketWatchState::Healthy => "control_socket.recovered",
        SocketWatchState::Missing => "control_socket.missing",
        SocketWatchState::Recovering => "control_socket.error",
        SocketWatchState::Conflict => "control_socket.conflict",
    };
    if next == SocketWatchState::Healthy {
        eprintln!(
            "session: control socket recovered at {}",
            socket_path.display()
        );
    } else if let Some(error) = error {
        eprintln!("session: {event}: {error}");
    } else {
        eprintln!("session: {event} at {}", socket_path.display());
    }
    emit_watch_event(
        state,
        event,
        socket_path,
        shared.generation.load(Ordering::SeqCst),
        error,
    );
    #[cfg(test)]
    if let Ok(mut events) = shared.transitions.lock() {
        events.push(event.to_string());
    }
}

fn emit_watch_event(
    state: &AppState,
    event: &str,
    socket_path: &Path,
    generation: u64,
    error: Option<&str>,
) {
    let identity = |pair: Option<(u64, u64)>| {
        pair.map(|(device, inode)| json!({ "device": device, "inode": inode }))
    };
    state.emit(SessionEvent::new(
        event,
        None,
        None,
        json!({
            "path": socket_path.display().to_string(),
            "generation": generation,
            "currentInode": identity(state.control_socket_identity()),
            "error": error,
        }),
    ));
}

fn warn_control_socket(state: &AppState, message: &str) {
    eprintln!("session: {message}");
    if let Some(app) = state.app_handle() {
        use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
        app.dialog()
            .message(message)
            .title("Session")
            .kind(MessageDialogKind::Warning)
            .show(|_| {});
    }
}

struct PollReady {
    listener: bool,
    wakeup: bool,
}

fn poll_listener_and_wakeup(
    listener: &UnixListener,
    wakeup: &UnixStream,
    timeout: Duration,
) -> std::io::Result<PollReady> {
    let mut fds = [
        libc::pollfd {
            fd: listener.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        },
        libc::pollfd {
            fd: wakeup.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        },
    ];
    poll_fds(&mut fds, timeout)?;
    Ok(PollReady {
        listener: fds[0].revents & (libc::POLLIN | libc::POLLERR | libc::POLLHUP) != 0,
        wakeup: fds[1].revents & (libc::POLLIN | libc::POLLERR | libc::POLLHUP) != 0,
    })
}

fn poll_wakeup_only(wakeup: &UnixStream, timeout: Duration) -> std::io::Result<()> {
    let mut fds = [libc::pollfd {
        fd: wakeup.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    }];
    poll_fds(&mut fds, timeout).map(|_| ())
}

fn poll_fds(fds: &mut [libc::pollfd], timeout: Duration) -> std::io::Result<bool> {
    let timeout_ms = i32::try_from(timeout.as_millis()).unwrap_or(i32::MAX);
    loop {
        let n = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout_ms) };
        if n < 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == ErrorKind::Interrupted {
                continue;
            }
            return Err(err);
        }
        return Ok(n > 0);
    }
}

fn drain_wakeup(wakeup: &UnixStream) {
    let mut buf = [0_u8; 32];
    loop {
        match (&*wakeup).read(&mut buf) {
            Ok(0) => break,
            Ok(_) => continue,
            Err(err) if matches!(err.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {
                break;
            }
            Err(_) => break,
        }
    }
}

fn handle_client(state: AppState, stream: UnixStream) {
    handle_client_with_timeout(state, stream, CONTROL_SOCKET_READ_TIMEOUT);
}

fn handle_client_with_timeout(state: AppState, mut stream: UnixStream, read_timeout: Duration) {
    let same_user_peer = peer_is_current_user(&stream);
    let reader_stream = match stream.try_clone() {
        Ok(stream) => stream,
        Err(err) => {
            let _ = write_response(&mut stream, Err(format!("failed to clone socket: {err}")));
            return;
        }
    };
    if let Err(err) = reader_stream.set_read_timeout(Some(read_timeout)) {
        let _ = write_response(
            &mut stream,
            Err(format!("failed to set socket read timeout: {err}")),
        );
        return;
    }
    let mut reader = BufReader::new(reader_stream);

    loop {
        let mut line = String::new();
        let read = match reader
            .by_ref()
            .take(MAX_CONTROL_HEADER_BYTES + 1)
            .read_line(&mut line)
        {
            Ok(0) => return,
            Ok(read) => read,
            Err(err) if matches!(err.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                return;
            }
            Err(err) => {
                let _ = write_response(
                    &mut stream,
                    Err(format!("failed to read socket request: {err}")),
                );
                return;
            }
        };
        if read as u64 > MAX_CONTROL_HEADER_BYTES {
            let _ = write_response(
                &mut stream,
                Err("control request header is too large".into()),
            );
            return;
        }
        let request = match serde_json::from_str::<ControlRequest>(line.trim_end()) {
            Ok(request) => request,
            Err(err) => {
                let _ = write_response(&mut stream, Err(format!("invalid control request: {err}")));
                return;
            }
        };
        let result = handle_request_with_peer(&state, request, same_user_peer);
        if write_response(&mut stream, result).is_err() {
            return;
        }
    }
}

#[cfg(test)]
fn handle_line(state: &AppState, line: &str) -> Result<Value, String> {
    handle_line_with_peer(state, line, false)
}

#[cfg(test)]
fn handle_line_with_peer(
    state: &AppState,
    line: &str,
    same_user_peer: bool,
) -> Result<Value, String> {
    let request: ControlRequest =
        serde_json::from_str(line).map_err(|err| format!("invalid control request: {err}"))?;
    handle_request_with_peer(state, request, same_user_peer)
}

/// The socket serves only token-free requests from a same-user peer: `ping`
/// and `notification.send` (`session ping` and `session send`). The socket and
/// its parent directory are also 0600/0700, but checking the peer prevents a
/// permissive-filesystem regression from widening access. Session no longer
/// creates terminal panes, so no pane token exists and any non-empty token is
/// rejected rather than falling through to peer authentication.
fn handle_request_with_peer(
    state: &AppState,
    request: ControlRequest,
    same_user_peer: bool,
) -> Result<Value, String> {
    if !request.token.is_empty() {
        return Err("invalid SESSION_TOKEN".to_string());
    }
    if !same_user_peer {
        return Err("control requests require a same-user local peer".to_string());
    }
    match request.command.as_str() {
        "ping" => Ok(json!({ "status": "ok" })),
        "notification.send" => {
            let payload = serde_json::from_value::<
                crate::user_notifications::SendNotificationRequest,
            >(request.payload)
            .map_err(|err| format!("invalid notification.send payload: {err}"))?;
            crate::user_notifications::dispatch(state, None, payload)
        }
        other => Err(format!("unknown control command '{other}'")),
    }
}

#[cfg(any(
    target_os = "macos",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "dragonfly"
))]
fn peer_is_current_user(stream: &UnixStream) -> bool {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    // SAFETY: both pointers are valid for writes and the fd belongs to a live
    // connected UnixStream for the duration of this call.
    let result = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    result == 0 && uid == unsafe { libc::geteuid() }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn peer_is_current_user(stream: &UnixStream) -> bool {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: credentials and length point at initialized writable storage of
    // the exact size requested by SO_PEERCRED.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    };
    result == 0
        && length as usize == std::mem::size_of::<libc::ucred>()
        && credentials.uid == unsafe { libc::geteuid() }
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "dragonfly",
    target_os = "linux",
    target_os = "android"
)))]
fn peer_is_current_user(_stream: &UnixStream) -> bool {
    false
}

/// A browser-overlay target resolved for one pane. `path` contains the canonical
/// filesystem path for file targets — the artifact tray persists that instead of
/// `url`, whose file-server token goes stale across runs — and is None for
/// loopback http(s) URLs.
#[derive(Debug)]
pub(crate) struct ResolvedBrowserTarget {
    pub url: String,
    pub sandbox: bool,
    pub path: Option<std::path::PathBuf>,
}

/// Resolve a browser-overlay target for `pane_id`: either a loopback http(s)
/// URL (returned as-is, unsandboxed) or a path under the pane's file roots
/// (minted into a token-bearing file-server URL and sandboxed). Shared by the
/// control-socket `browser.open` path and the trusted GUI command that opens
/// local file links from transcript markdown.
pub(crate) fn resolve_browser_target(
    state: &AppState,
    authed_pane: &str,
    target: &str,
    cwd: Option<&str>,
) -> Result<ResolvedBrowserTarget, String> {
    if target.is_empty() {
        return Err("nothing to open".to_string());
    }
    if target.starts_with("http://") || target.starts_with("https://") {
        let url = canonical_loopback_artifact_url(target).ok_or_else(|| {
            format!(
                "refusing to open '{target}': the browser overlay only loads http(s) URLs on localhost/127.0.0.1"
            )
        })?;
        return Ok(ResolvedBrowserTarget {
            url,
            sandbox: false,
            path: None,
        });
    }

    let requested = {
        let path = std::path::Path::new(target);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            let base = cwd.ok_or_else(|| {
                "cannot resolve a relative path without a working directory".to_string()
            })?;
            std::path::Path::new(base).join(path)
        }
    };

    let roots = state.pane_file_roots(authed_pane);
    let canonical = crate::file_server::resolve_under_roots(&requested, &roots)
        .ok_or_else(|| format!("'{target}' was not found"))?;
    let port = state
        .file_server_port()
        .ok_or_else(|| "the file server is not running".to_string())?;
    let token = if crate::file_server::is_executable_preview_path(&canonical) {
        state.exact_file_preview_token(authed_pane, &canonical)?
    } else {
        state.pane_file_token(authed_pane)?
    };
    Ok(ResolvedBrowserTarget {
        url: crate::file_server::file_url(port, &token, &canonical),
        sandbox: true,
        path: Some(canonical),
    })
}

fn write_response(stream: &mut UnixStream, result: Result<Value, String>) -> std::io::Result<()> {
    let response = match result {
        Ok(data) => ControlResponse {
            ok: true,
            data,
            error: None,
        },
        Err(error) => ControlResponse {
            ok: false,
            data: Value::Null,
            error: Some(error),
        },
    };
    serde_json::to_writer(&mut *stream, &response)?;
    stream.write_all(b"\n")?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AdapterConfigs, ClaudeAdapterConfig, CodexAdapterConfig, GrokAdapterConfig, SessionConfig,
    };

    use std::io::Read;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn test_state() -> AppState {
        runtime_state(temp_dir(), PathBuf::from("/tmp/session-control-test.sock")).0
    }

    fn runtime_fixture() -> (AppState, PathBuf) {
        let dir = temp_dir();
        let socket_path = dir.join("session.sock");
        runtime_state(dir, socket_path)
    }

    fn runtime_state(workspace_root: PathBuf, socket_path: PathBuf) -> (AppState, PathBuf) {
        let state = AppState::new(SessionConfig {
            remotes: Default::default(),
            workspace_root,
            socket_path: socket_path.clone(),
            adapters: AdapterConfigs {
                claude: ClaudeAdapterConfig {
                    binary: Some("claude".to_string()),
                },
                codex: CodexAdapterConfig {
                    binary: Some("codex".to_string()),
                },
                grok: GrokAdapterConfig {
                    binary: Some("grok".to_string()),
                },
            },
            legacy_claude_binary: None,
            claude_plugin_dir: std::path::PathBuf::new(),
        });
        (state, socket_path)
    }

    fn ping_control_socket(path: &Path, token: &str) -> Result<ControlResponse, String> {
        let mut client = UnixStream::connect(path)
            .map_err(|err| format!("connect {}: {err}", path.display()))?;
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(|err| err.to_string())?;
        client
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|err| err.to_string())?;
        let request = json!({ "token": token, "command": "ping", "payload": Value::Null });
        serde_json::to_writer(&mut client, &request).map_err(|err| err.to_string())?;
        client.write_all(b"\n").map_err(|err| err.to_string())?;
        client.flush().map_err(|err| err.to_string())?;
        let mut response = String::new();
        BufReader::new(client)
            .read_line(&mut response)
            .map_err(|err| err.to_string())?;
        serde_json::from_str::<ControlResponse>(&response).map_err(|err| err.to_string())
    }

    fn wait_for_ping(path: &Path, token: &str, timeout: Duration) -> ControlResponse {
        let started = std::time::Instant::now();
        let mut last = "no attempt".to_string();
        while started.elapsed() < timeout {
            match ping_control_socket(path, token) {
                Ok(response) if response.ok => return response,
                Ok(response) => last = format!("{:?}", response.error),
                Err(err) => last = err,
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!(
            "control socket did not accept ping at {} within {timeout:?}: {last}",
            path.display()
        );
    }

    fn wait_until(timeout: Duration, mut pred: impl FnMut() -> bool, message: &str) {
        let started = std::time::Instant::now();
        while started.elapsed() < timeout {
            if pred() {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("{message}");
    }

    fn fd_count() -> usize {
        std::fs::read_dir("/dev/fd")
            .map(|entries| entries.count())
            .unwrap_or(0)
    }

    fn temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("session-control-{nanos}-{seq}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn request_line(token: &str, command: &str, payload: Value) -> String {
        json!({ "token": token, "command": command, "payload": payload }).to_string()
    }

    #[test]
    fn browser_target_accepts_complete_loopback_urls_and_rejects_fragments() {
        assert_eq!(
            canonical_loopback_artifact_url("http://localhost:3000/app").as_deref(),
            Some("http://localhost:3000/app")
        );
        assert!(canonical_loopback_artifact_url("http://127.0.0.1:8080").is_some());
        assert!(canonical_loopback_artifact_url("http://[::1]:3000/").is_some());

        for invalid in [
            "http://example.com/",
            "http://127.0.0.1.evil.com/",
            "http://127.0.0.1@evil.com/",
            "http://evil.com\\@127.0.0.1/",
            "http://l",
            "http://lo",
            "http://localhos",
            "http://127.0.0",
            "http://localhost:5555|",
            "http://localhost:5556|localhost:5555|",
            "http://localhost:5557/\\",
        ] {
            assert!(
                canonical_loopback_artifact_url(invalid).is_none(),
                "accepted malformed loopback URL: {invalid}"
            );
        }
    }

    #[test]
    fn browser_target_rejects_absolute_paths_outside_the_pane_roots() {
        let state = test_state();
        // No pane has been inserted, so roots are empty and any absolute path
        // is refused rather than minting a token URL that would 403 later.
        let err = resolve_browser_target(
            &state,
            "missing-pane",
            "/Users/raymond/Code/multitool/dev/menubar-design-variants.html",
            None,
        )
        .unwrap_err();
        assert_eq!(
            err,
            "'/Users/raymond/Code/multitool/dev/menubar-design-variants.html' was not found"
        );
    }

    #[test]
    fn browser_target_rejects_relative_paths_without_a_cwd() {
        let state = test_state();
        let err = resolve_browser_target(&state, "pane-1", "report.html", None).unwrap_err();
        assert!(err.contains("working directory"), "unexpected error: {err}");
    }

    #[test]
    fn handle_line_rejects_an_unknown_token() {
        let state = test_state();
        let err = handle_line(&state, &request_line("nope", "ping", Value::Null)).unwrap_err();
        assert!(
            err.contains("invalid SESSION_TOKEN"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn tokenless_ping_requires_a_same_user_peer() {
        let state = test_state();
        let ping = request_line("", "ping", Value::Null);
        let data = handle_line_with_peer(&state, &ping, true).unwrap();
        assert_eq!(data, json!({ "status": "ok" }));
        let err = handle_line(&state, &ping).unwrap_err();
        assert!(
            err.contains("same-user local peer"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn external_notification_requires_a_same_user_peer() {
        let state = test_state();
        let notification = request_line(
            "",
            "notification.send",
            json!({
                "body": "Build finished",
                "mode": "overlay",
                "tone": "success",
                "timeoutMs": 5000,
            }),
        );
        let data = handle_line_with_peer(&state, &notification, true).unwrap();
        assert_eq!(data["accepted"], true);
        assert_eq!(data["delivery"], "overlay");

        let err = handle_line_with_peer(&state, &notification, false).unwrap_err();
        assert!(err.contains("same-user local peer"));
    }

    #[test]
    fn invalid_nonempty_notification_token_does_not_fall_back_to_peer_auth() {
        let state = test_state();
        let err = handle_line_with_peer(
            &state,
            &request_line(
                "guessed-token",
                "notification.send",
                json!({ "body": "hello", "mode": "overlay" }),
            ),
            true,
        )
        .unwrap_err();
        assert!(err.contains("invalid SESSION_TOKEN"));
    }

    #[test]
    fn external_notification_rejects_unrecognized_payload_fields() {
        let state = test_state();
        let err = handle_line_with_peer(
            &state,
            &request_line(
                "",
                "notification.send",
                json!({ "body": "hello", "paneId": "pane-forged" }),
            ),
            true,
        )
        .unwrap_err();
        assert!(err.contains("unknown field"));
    }

    #[test]
    fn connected_unix_socket_reports_the_current_user() {
        let (client, _server) = UnixStream::pair().unwrap();
        assert!(peer_is_current_user(&client));
    }

    #[test]
    fn handle_line_rejects_an_unknown_command() {
        let state = test_state();
        // The commands of the removed pane-token surface are unknown now.
        for command in [
            "bogus",
            "pane.write",
            "hook.notify",
            "cli.call",
            "browser.open",
        ] {
            let err = handle_line_with_peer(&state, &request_line("", command, Value::Null), true)
                .unwrap_err();
            assert!(
                err.contains("unknown control command"),
                "unexpected error: {err}"
            );
        }
    }

    #[test]
    fn handle_line_rejects_any_token() {
        let state = test_state();
        // Pane tokens no longer exist; a stale one from an old pane's
        // environment is refused rather than treated as tokenless.
        let request = request_line("stale-pane-token", "ping", Value::Null);
        let err = handle_line_with_peer(&state, &request, true).unwrap_err();
        assert!(
            err.contains("invalid SESSION_TOKEN"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn partial_request_times_out_server_reader() {
        let state = test_state();
        let (mut client, server) = UnixStream::pair().unwrap();
        let (done_tx, done_rx) = mpsc::channel();

        thread::spawn(move || {
            handle_client_with_timeout(state, server, Duration::from_millis(50));
            done_tx.send(()).unwrap();
        });

        client.write_all(b"{").unwrap();
        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("server reader should exit after the read timeout");

        let mut buf = [0_u8; 1];
        assert_eq!(client.read(&mut buf).unwrap(), 0);
    }

    #[test]
    fn complete_request_still_receives_response() {
        let state = test_state();
        let token = String::new();
        let (mut client, server) = UnixStream::pair().unwrap();
        let (done_tx, done_rx) = mpsc::channel();

        thread::spawn(move || {
            handle_client_with_timeout(state, server, Duration::from_secs(1));
            done_tx.send(()).unwrap();
        });

        let request = json!({
            "token": token,
            "command": "ping",
            "payload": Value::Null,
        });
        serde_json::to_writer(&mut client, &request).unwrap();
        client.write_all(b"\n").unwrap();
        client.flush().unwrap();

        let mut response = String::new();
        BufReader::new(client.try_clone().unwrap())
            .read_line(&mut response)
            .unwrap();
        let response = serde_json::from_str::<ControlResponse>(&response).unwrap();
        assert!(response.ok);
        assert_eq!(response.data, json!({ "status": "ok" }));

        drop(client);
        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("server reader should exit after the client closes");
    }

    #[test]
    fn inspect_socket_path_classifies_missing_owned_and_replaced_inodes() {
        let dir = temp_dir();
        let path = dir.join("session.sock");
        assert_eq!(inspect_socket_path(&path, None), PathCheck::Missing);

        let _listener = UnixListener::bind(&path).unwrap();
        let meta = std::fs::symlink_metadata(&path).unwrap();
        let owned = (meta.dev(), meta.ino());
        assert_eq!(inspect_socket_path(&path, Some(owned)), PathCheck::Healthy);

        let replacement = dir.join("other.sock");
        let _other = UnixListener::bind(&replacement).unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        assert_eq!(inspect_socket_path(&path, Some(owned)), PathCheck::Conflict);
        assert_eq!(inspect_socket_path(&path, None), PathCheck::Conflict);
    }

    #[test]
    fn rebind_after_unlink_does_not_remove_a_replacement_socket() {
        let dir = temp_dir();
        let path = dir.join("session.sock");
        let _original = UnixListener::bind(&path).unwrap();
        std::fs::remove_file(&path).unwrap();

        let replacement = dir.join("other.sock");
        let _other = UnixListener::bind(&replacement).unwrap();
        let replacement_meta = std::fs::symlink_metadata(&replacement).unwrap();
        std::fs::rename(&replacement, &path).unwrap();

        assert!(bind_control_socket(&path).is_err());
        let current = std::fs::symlink_metadata(&path).unwrap();
        assert_eq!(current.dev(), replacement_meta.dev());
        assert_eq!(current.ino(), replacement_meta.ino());
    }

    #[test]
    fn supervisor_rebinds_after_the_socket_file_is_unlinked() {
        let (state, socket_path) = runtime_fixture();
        let token = String::new();
        let runtime = start_control_socket_runtime(state, MAX_CONCURRENT_CLIENTS).unwrap();
        wait_for_ping(&socket_path, &token, Duration::from_secs(1));

        std::fs::remove_file(&socket_path).unwrap();
        let response = wait_for_ping(&socket_path, &token, Duration::from_secs(1));
        assert_eq!(response.data, json!({ "status": "ok" }));

        let events = runtime.transitions();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.as_str() == "control_socket.missing")
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event.as_str() == "control_socket.recovered")
                .count(),
            1
        );
        runtime.shutdown();
    }

    #[test]
    fn supervisor_repeated_unlink_recovery_does_not_grow_fds() {
        // Descriptor counts belong to the whole process. Other parallel tests
        // open files and sockets, so run the leak assertion in its own harness
        // process instead of widening the allowance or serializing the suite.
        const CHILD_ENV: &str = "SESSION_CONTROL_SOCKET_FD_TEST_CHILD";
        if std::env::var_os(CHILD_ENV).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "control_socket::tests::supervisor_repeated_unlink_recovery_does_not_grow_fds",
                    "--nocapture",
                ])
                .env(CHILD_ENV, "1")
                .output()
                .expect("run isolated descriptor-leak test");
            assert!(
                output.status.success(),
                "isolated descriptor-leak test failed:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
            return;
        }

        let (state, socket_path) = runtime_fixture();
        let token = String::new();
        let runtime = start_control_socket_runtime(state, MAX_CONCURRENT_CLIENTS).unwrap();
        wait_for_ping(&socket_path, &token, Duration::from_secs(1));
        let before = fd_count();

        for _ in 0..8 {
            std::fs::remove_file(&socket_path).unwrap();
            wait_for_ping(&socket_path, &token, Duration::from_secs(1));
        }

        let after = fd_count();
        assert!(
            after <= before + 4,
            "fd count grew from {before} to {after} after repeated recovery"
        );
        runtime.shutdown();
    }

    #[test]
    fn supervisor_reports_conflict_and_does_not_delete_a_replacement() {
        let (state, socket_path) = runtime_fixture();
        let token = String::new();
        let runtime = start_control_socket_runtime(state.clone(), MAX_CONCURRENT_CLIENTS).unwrap();
        wait_for_ping(&socket_path, &token, Duration::from_secs(1));

        let replacement_path = socket_path.with_file_name("other.sock");
        let replacement = UnixListener::bind(&replacement_path).unwrap();
        let replacement_meta = std::fs::symlink_metadata(&replacement_path).unwrap();
        std::fs::rename(&replacement_path, &socket_path).unwrap();

        wait_until(
            Duration::from_secs(1),
            || {
                runtime
                    .transitions()
                    .iter()
                    .any(|event| event == "control_socket.conflict")
            },
            "expected a control_socket.conflict transition",
        );
        let current = std::fs::symlink_metadata(&socket_path).unwrap();
        assert_eq!(current.dev(), replacement_meta.dev());
        assert_eq!(current.ino(), replacement_meta.ino());
        assert!(!state.owns_control_socket());

        thread::sleep(HEALTH_POLL_TIMEOUT.saturating_mul(3));
        let current = std::fs::symlink_metadata(&socket_path).unwrap();
        assert_eq!(current.ino(), replacement_meta.ino());
        assert_eq!(
            runtime
                .transitions()
                .iter()
                .filter(|event| event.as_str() == "control_socket.conflict")
                .count(),
            1
        );

        drop(replacement);
        let _ = std::fs::remove_file(&socket_path);
        wait_for_ping(&socket_path, &token, Duration::from_secs(1));
        runtime.shutdown();
    }

    #[test]
    fn supervisor_restarts_after_a_listener_panic() {
        let (state, socket_path) = runtime_fixture();
        let token = String::new();
        let runtime = start_control_socket_runtime(state, MAX_CONCURRENT_CLIENTS).unwrap();
        wait_for_ping(&socket_path, &token, Duration::from_secs(1));

        runtime.inject_panic();
        wait_until(
            Duration::from_secs(1),
            || {
                runtime
                    .transitions()
                    .iter()
                    .any(|event| event == "control_socket.error")
            },
            "expected a control_socket.error transition after the injected panic",
        );
        wait_for_ping(&socket_path, &token, Duration::from_secs(1));
        runtime.shutdown();
    }

    #[test]
    fn supervisor_does_not_recreate_the_socket_after_shutdown() {
        let (state, socket_path) = runtime_fixture();
        let token = String::new();
        let runtime = start_control_socket_runtime(state, MAX_CONCURRENT_CLIENTS).unwrap();
        wait_for_ping(&socket_path, &token, Duration::from_secs(1));

        std::fs::remove_file(&socket_path).unwrap();
        runtime.shutdown();
        thread::sleep(HEALTH_POLL_TIMEOUT.saturating_mul(4));
        assert!(
            !socket_path.exists(),
            "watchdog recreated {} after shutdown",
            socket_path.display()
        );
    }

    #[test]
    fn accepted_connections_survive_a_listener_rebind() {
        let (state, socket_path) = runtime_fixture();
        let token = String::new();
        let runtime = start_control_socket_runtime(state, MAX_CONCURRENT_CLIENTS).unwrap();
        wait_for_ping(&socket_path, &token, Duration::from_secs(1));

        let mut held = UnixStream::connect(&socket_path).unwrap();
        // connect() can complete while the connection is still in the listen
        // backlog; wait long enough for accept() so dropping the old listener
        // does not discard this client.
        thread::sleep(Duration::from_millis(80));
        std::fs::remove_file(&socket_path).unwrap();
        wait_for_ping(&socket_path, &token, Duration::from_secs(1));

        let request = json!({ "token": token, "command": "ping", "payload": Value::Null });
        serde_json::to_writer(&mut held, &request).unwrap();
        held.write_all(b"\n").unwrap();
        held.flush().unwrap();
        let mut response = String::new();
        BufReader::new(held.try_clone().unwrap())
            .read_line(&mut response)
            .unwrap();
        let response = serde_json::from_str::<ControlResponse>(&response).unwrap();
        assert!(response.ok);
        assert_eq!(response.data, json!({ "status": "ok" }));
        runtime.shutdown();
    }

    #[test]
    fn supervisor_still_recovers_while_the_client_cap_is_held() {
        let (state, socket_path) = runtime_fixture();
        let token = String::new();
        let runtime = start_control_socket_runtime(state, 2).unwrap();
        wait_for_ping(&socket_path, &token, Duration::from_secs(1));

        let _held_a = UnixStream::connect(&socket_path).unwrap();
        let _held_b = UnixStream::connect(&socket_path).unwrap();
        thread::sleep(Duration::from_millis(80));

        std::fs::remove_file(&socket_path).unwrap();
        wait_until(
            Duration::from_secs(1),
            || socket_path.exists(),
            "socket path should return while client slots are held",
        );
        drop(_held_a);
        drop(_held_b);
        wait_for_ping(&socket_path, &token, Duration::from_secs(1));
        runtime.shutdown();
    }
}
