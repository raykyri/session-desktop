//! Bounded JSONL subprocess transport shared by pane-less research runners.

use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::thread;
use std::time::{Duration, Instant};

const MAX_STDOUT_LINE_BYTES: usize = 1024 * 1024;
const MAX_STDERR_LOG_BYTES: usize = 4 * 1024 * 1024;
const MAX_PENDING_EVENTS: usize = 256;

pub fn reconcile_session_id(
    expected: &mut Option<String>,
    observed: Option<&str>,
    label: &str,
) -> Result<(), String> {
    let Some(observed) = observed else {
        return Ok(());
    };
    let observed = validate_session_id(observed, label)?;
    if expected
        .as_deref()
        .is_some_and(|expected| expected != observed)
    {
        return Err(format!(
            "{label} reported a different session id than session requested"
        ));
    }
    *expected = Some(observed);
    Ok(())
}

pub fn validate_session_id(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !value
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!("{label} reported an invalid session id"));
    }
    Ok(value.to_string())
}

pub enum JsonlReceive {
    Value(Value),
    Timeout,
    Eof,
}

/// Grace period for pipe readers to reach EOF after SIGKILL is sent to the
/// process group. After this duration, the reader is detached if an
/// un-signaled process outside the group continues to hold the pipe open.
pub(crate) const KILL_GRACE: Duration = Duration::from_millis(100);

/// Duration stdout may remain open after process exit before SIGKILL is sent
/// to the remaining process group. SIGTERM is sent immediately upon process exit.
const STDOUT_AFTER_EXIT_GRACE: Duration = Duration::from_secs(2);

/// A thread that drains one of a child's pipes. Its result is collected with
/// a deadline rather than an unbounded join, since child processes inheriting
/// the file descriptor can prevent EOF.
pub(crate) struct PipeReader<T> {
    handle: thread::JoinHandle<T>,
    // Disconnects when the reader's closure returns or unwinds.
    done: Receiver<()>,
}

impl<T: Send + 'static> PipeReader<T> {
    pub(crate) fn spawn(
        name: &str,
        read: impl FnOnce() -> T + Send + 'static,
    ) -> std::io::Result<Self> {
        let (finished, done) = mpsc::channel::<()>();
        let handle = thread::Builder::new()
            .name(name.to_string())
            .spawn(move || {
                let _finished = finished;
                read()
            })?;
        Ok(Self { handle, done })
    }
}

impl<T> PipeReader<T> {
    /// Waits until the reader finishes or `deadline` passes; true when it
    /// finished.
    fn wait_until(&self, deadline: Instant) -> bool {
        match self.done.try_recv() {
            Err(mpsc::TryRecvError::Disconnected) => return true,
            Ok(()) | Err(mpsc::TryRecvError::Empty) => {}
        }
        matches!(
            self.done
                .recv_timeout(deadline.saturating_duration_since(Instant::now())),
            Err(RecvTimeoutError::Disconnected)
        )
    }

    /// Returns the reader's result when finished. A blocked reader is
    /// detached: dropping the handle allows the thread to terminate when
    /// the pipe closes.
    fn finish(self) -> Option<T> {
        if self.wait_until(Instant::now()) {
            self.handle.join().ok()
        } else {
            None
        }
    }
}

/// Sends `signal` to every process in process group `pgid`. Children here are
/// spawned with `process_group(0)`, so the group id is the leader's pid.
pub(crate) fn signal_process_group(pgid: u32, signal: libc::c_int) {
    let Ok(pgid) = libc::pid_t::try_from(pgid) else {
        return;
    };
    if pgid > 0 {
        let _ = unsafe { libc::kill(-pgid, signal) };
    }
}

/// Collects pipe readers after the process leader has exited. Because other
/// processes in the process group may retain open file descriptors, SIGTERM
/// is sent first. If readers do not finish by `deadline`, SIGKILL is sent to
/// the process group and readers are given `KILL_GRACE` before being detached.
/// Returns each reader's result in order, or `None` if detached.
pub(crate) fn collect_group_readers<T>(
    pgid: u32,
    readers: Vec<PipeReader<T>>,
    deadline: Instant,
) -> Vec<Option<T>> {
    signal_process_group(pgid, libc::SIGTERM);
    if !readers.iter().all(|reader| reader.wait_until(deadline)) {
        signal_process_group(pgid, libc::SIGKILL);
        let grace = Instant::now() + KILL_GRACE;
        for reader in &readers {
            reader.wait_until(grace);
        }
    }
    readers.into_iter().map(PipeReader::finish).collect()
}

pub struct JsonlProcess {
    child: Child,
    events: Option<Receiver<Result<Value, String>>>,
    stdout_reader: Option<PipeReader<()>>,
    stderr_reader: Option<PipeReader<()>>,
    // Timestamp when leader exit was detected with stdout still open, and
    // whether SIGKILL has been sent to the process group.
    leader_exited_at: Option<Instant>,
    group_killed: bool,
}

impl JsonlProcess {
    pub fn spawn(
        binary: &str,
        args: &[String],
        cwd: &Path,
        stderr_log: &Path,
        label: &str,
    ) -> Result<Self, String> {
        Self::spawn_with_stdin(binary, args, cwd, stderr_log, label, None)
    }

    /// Uses file-backed stdin to avoid OS argument length limits for large prompts.
    pub fn spawn_with_stdin(
        binary: &str,
        args: &[String],
        cwd: &Path,
        stderr_log: &Path,
        label: &str,
        input: Option<&Path>,
    ) -> Result<Self, String> {
        let stdin = match input {
            Some(path) => Stdio::from(
                std::fs::File::open(path)
                    .map_err(|err| format!("failed to open research input: {err}"))?,
            ),
            None => Stdio::null(),
        };
        if let Some(parent) = stderr_log.parent() {
            fs::create_dir_all(parent).map_err(|err| {
                format!(
                    "failed to create research log dir {}: {err}",
                    parent.display()
                )
            })?;
        }
        let mut log = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(stderr_log)
            .map_err(|err| {
                format!(
                    "failed to open research log {}: {err}",
                    stderr_log.display()
                )
            })?;
        let _ = writeln!(
            log,
            "session: {label} research spawn binary={binary} cwd={}",
            cwd.display()
        );

        let mut child = Command::new(binary)
            .args(args)
            .current_dir(cwd)
            .stdin(stdin)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .map_err(|err| format!("failed to spawn {label} research process: {err}"))?;
        let stdout = child.stdout.take().ok_or_else(|| {
            terminate_after_setup_failure(&mut child);
            format!("{label} research stdout was not piped")
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            terminate_after_setup_failure(&mut child);
            format!("{label} research stderr was not piped")
        })?;
        let (tx, events) = mpsc::sync_channel(MAX_PENDING_EVENTS);
        let stdout_label = label.to_string();
        let readers = PipeReader::spawn("session-jsonl-stdout", move || {
            read_jsonl(stdout, tx, &stdout_label)
        })
        .and_then(|stdout_reader| {
            let stderr_reader =
                PipeReader::spawn("session-jsonl-stderr", move || copy_bounded(stderr, log))?;
            Ok((stdout_reader, stderr_reader))
        });
        let (stdout_reader, stderr_reader) = readers.map_err(|err| {
            terminate_after_setup_failure(&mut child);
            format!("failed to start {label} research output readers: {err}")
        })?;
        Ok(Self {
            child,
            events: Some(events),
            stdout_reader: Some(stdout_reader),
            stderr_reader: Some(stderr_reader),
            leader_exited_at: None,
            group_killed: false,
        })
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn recv_timeout(&mut self, timeout: Duration) -> Result<JsonlReceive, String> {
        let Some(events) = self.events.as_ref() else {
            return Ok(JsonlReceive::Eof);
        };
        match events.recv_timeout(timeout) {
            Ok(Ok(value)) => Ok(JsonlReceive::Value(value)),
            Ok(Err(err)) => Err(err),
            Err(RecvTimeoutError::Timeout) if self.stdout_held_after_exit() => {
                // Lines already read were delivered before this timeout.
                self.events.take();
                Ok(JsonlReceive::Eof)
            }
            Err(RecvTimeoutError::Timeout) => Ok(JsonlReceive::Timeout),
            Err(RecvTimeoutError::Disconnected) => Ok(JsonlReceive::Eof),
        }
    }

    /// Determines whether stdout should be treated as closed when EOF has not
    /// been reached after the leader process exited and descendant processes
    /// did not terminate following SIGTERM and SIGKILL signals. Invoked on
    /// each receive timeout to signal the process group.
    fn stdout_held_after_exit(&mut self) -> bool {
        let exited_at = match self.leader_exited_at {
            Some(exited_at) => exited_at,
            None => {
                if !matches!(self.child.try_wait(), Ok(Some(_))) {
                    return false;
                }
                signal_process_group(self.child.id(), libc::SIGTERM);
                *self.leader_exited_at.insert(Instant::now())
            }
        };
        let waited = exited_at.elapsed();
        if waited >= STDOUT_AFTER_EXIT_GRACE && !self.group_killed {
            signal_process_group(self.child.id(), libc::SIGKILL);
            self.group_killed = true;
        }
        waited >= STDOUT_AFTER_EXIT_GRACE + KILL_GRACE
    }

    pub fn finish(&mut self, timeout: Duration) -> Result<ExitStatus, String> {
        let deadline = Instant::now() + timeout;
        let status = loop {
            match self.child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() >= deadline => {
                    self.kill();
                    return Err(
                        "headless research process did not exit after closing stdout".into(),
                    );
                }
                Ok(None) => thread::sleep(Duration::from_millis(25)),
                Err(err) => {
                    self.kill();
                    return Err(format!(
                        "failed to wait for headless research process: {err}"
                    ));
                }
            }
        };
        self.collect_readers(deadline);
        Ok(status)
    }

    pub fn kill(&mut self) {
        crate::claude_sdk::terminate_process_tree(self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.collect_readers(Instant::now() + KILL_GRACE);
    }

    /// Collects the output readers once the leader has exited, within
    /// `deadline` (see `collect_group_readers`).
    fn collect_readers(&mut self, deadline: Instant) {
        // Dropping the receiver also releases a stdout reader blocked on the
        // bounded queue when a run is cancelled or its owner is dropped.
        self.events.take();
        let readers = [self.stdout_reader.take(), self.stderr_reader.take()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        if !readers.is_empty() {
            collect_group_readers(self.child.id(), readers, deadline);
        }
    }
}

impl Drop for JsonlProcess {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            self.kill();
        } else {
            self.collect_readers(Instant::now() + KILL_GRACE);
        }
    }
}

fn read_jsonl(stdout: impl Read, tx: SyncSender<Result<Value, String>>, label: &str) {
    let mut reader = BufReader::new(stdout);
    loop {
        let mut buf = Vec::new();
        match reader
            .by_ref()
            .take((MAX_STDOUT_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut buf)
        {
            Ok(0) => break,
            Ok(_) if buf.len() > MAX_STDOUT_LINE_BYTES => {
                let _ = tx.send(Err(format!("{label} stdout line exceeded 1 MB")));
                break;
            }
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let parsed = serde_json::from_str(line)
                    .map_err(|err| format!("invalid {label} research JSON: {err}"));
                if tx.send(parsed).is_err() {
                    break;
                }
            }
            Err(err) => {
                let _ = tx.send(Err(format!(
                    "failed to read {label} research stdout: {err}"
                )));
                break;
            }
        }
    }
}

fn copy_bounded(mut source: impl Read, mut target: impl Write) {
    let mut written = 0usize;
    let mut marker_written = false;
    let mut buf = [0u8; 8192];
    loop {
        let read = match source.read(&mut buf) {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => break,
        };
        let mut overflowed = written >= MAX_STDERR_LOG_BYTES;
        if written < MAX_STDERR_LOG_BYTES {
            let keep = read.min(MAX_STDERR_LOG_BYTES - written);
            let _ = target.write_all(&buf[..keep]);
            written += keep;
            overflowed = keep < read;
        }
        if overflowed && !marker_written {
            let _ = target.write_all(b"\nsession: stderr log truncated at 4 MB\n");
            marker_written = true;
        }
    }
    let _ = target.flush();
}

fn terminate_after_setup_failure(child: &mut Child) {
    crate::claude_sdk::terminate_process_tree(child.id());
    let _ = child.kill();
    let _ = child.wait();
}

/// Walks a process's live descendants from a single `ps` snapshot: one
/// subprocess regardless of tree size, rather than one `pgrep -P` per node.
pub(crate) fn descendant_process_ids(pid: u32) -> Vec<u32> {
    descendants_from_parent_pairs(pid, &process_parent_snapshot())
}

/// Every live process's (pid, ppid), from one `ps` invocation.
fn process_parent_snapshot() -> Vec<(u32, u32)> {
    let Ok(output) = Command::new("/bin/ps")
        .arg("-axo")
        .arg("pid=,ppid=")
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse::<u32>().ok()?;
            let ppid = parts.next()?.parse::<u32>().ok()?;
            Some((pid, ppid))
        })
        .collect()
}

/// Pre-order walk (each process before its own descendants) so callers can
/// reverse the list for bottom-up termination. The `seen` set prevents
/// infinite loops if PID recycling during `ps` creates cycles.
fn descendants_from_parent_pairs(root: u32, parent_pairs: &[(u32, u32)]) -> Vec<u32> {
    let mut children_by_parent: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, ppid) in parent_pairs {
        children_by_parent.entry(*ppid).or_default().push(*pid);
    }
    let mut descendants = Vec::new();
    let mut seen = HashSet::from([root]);
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        let Some(children) = children_by_parent.get(&pid) else {
            continue;
        };
        for child_pid in children {
            if seen.insert(*child_pid) {
                descendants.push(*child_pid);
                stack.push(*child_pid);
            }
        }
    }
    descendants
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descendant_walk_follows_parent_pairs_and_handles_cycles() {
        // 1 → {2, 3}, 2 → {4}, plus an unrelated 9→10 subtree and a cycle
        // (4 → 1) that could result from PID reuse during snapshotting.
        let pairs = vec![(2, 1), (3, 1), (4, 2), (10, 9), (1, 4)];
        let mut descendants = descendants_from_parent_pairs(1, &pairs);
        // Each process must appear before its own descendants so a reversed
        // walk terminates bottom-up; sibling order is unspecified.
        let position = |pid: u32| {
            descendants
                .iter()
                .position(|candidate| *candidate == pid)
                .unwrap_or_else(|| panic!("pid {pid} missing from walk"))
        };
        assert!(position(2) < position(4));
        descendants.sort_unstable();
        assert_eq!(descendants, vec![2, 3, 4]);

        assert_eq!(descendants_from_parent_pairs(9, &pairs), vec![10]);
        assert!(descendants_from_parent_pairs(42, &pairs).is_empty());
    }

    #[test]
    fn process_parent_snapshot_includes_this_process() {
        let pid = std::process::id();
        assert!(
            process_parent_snapshot()
                .iter()
                .any(|(candidate, _)| *candidate == pid),
            "ps snapshot did not include the test process"
        );
    }

    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn session_ids_must_be_safe_and_consistent() {
        let mut session_id = Some("requested-1".to_string());
        reconcile_session_id(&mut session_id, Some("requested-1"), "test").unwrap();
        assert_eq!(session_id.as_deref(), Some("requested-1"));

        let mismatch = reconcile_session_id(&mut session_id, Some("different-1"), "test")
            .expect_err("a CLI must not redirect session to a different session");
        assert!(mismatch.contains("different session id"));

        let mut empty = None;
        assert!(reconcile_session_id(&mut empty, Some("../../unsafe"), "test").is_err());
        assert!(validate_session_id("--dangerously-bypass-approvals", "test").is_err());
    }

    #[test]
    fn streams_json_lines_and_captures_stderr() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("session-jsonl-{}-{unique}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-jsonl");
        fs::write(
            &script,
            "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"ok\"}'\nprintf '%s\\n' warning >&2\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script, permissions).unwrap();
        let log = dir.join("stderr.log");
        let mut process =
            JsonlProcess::spawn(script.to_str().unwrap(), &[], &dir, &log, "test").unwrap();
        assert!(matches!(
            process.recv_timeout(Duration::from_secs(1)).unwrap(),
            JsonlReceive::Value(value) if value["type"] == "ok"
        ));
        loop {
            if matches!(
                process.recv_timeout(Duration::from_secs(1)).unwrap(),
                JsonlReceive::Eof
            ) {
                break;
            }
        }
        assert!(process.finish(Duration::from_secs(1)).unwrap().success());
        assert!(fs::read_to_string(log).unwrap().contains("warning"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn stderr_truncation_continues_draining_the_pipe() {
        let bytes = vec![b'x'; MAX_STDERR_LOG_BYTES + 8192];
        let mut source = std::io::Cursor::new(bytes);
        let mut target = Vec::new();

        copy_bounded(&mut source, &mut target);

        assert_eq!(source.position(), (MAX_STDERR_LOG_BYTES + 8192) as u64);
        assert!(target.len() < MAX_STDERR_LOG_BYTES + 128);
        assert!(target.ends_with(b"session: stderr log truncated at 4 MB\n"));
    }

    fn test_dir(label: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "session-jsonl-{label}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_script(dir: &Path, body: &str) -> String {
        let script = dir.join("fake-jsonl");
        fs::write(&script, body).unwrap();
        let mut permissions = fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script, permissions).unwrap();
        script.display().to_string()
    }

    fn receive_until_eof(process: &mut JsonlProcess, within: Duration) -> Vec<Value> {
        let deadline = Instant::now() + within;
        let mut values = Vec::new();
        while Instant::now() < deadline {
            match process.recv_timeout(Duration::from_millis(50)).unwrap() {
                JsonlReceive::Value(value) => values.push(value),
                JsonlReceive::Timeout => {}
                JsonlReceive::Eof => return values,
            }
        }
        panic!("stdout did not reach end of file within {within:?}");
    }

    /// Allowance over a cleanup timeout for the final SIGKILL grace and
    /// scheduling delay.
    const CLEANUP_MARGIN: Duration = Duration::from_millis(600);

    #[test]
    fn finish_does_not_block_on_background_child_retaining_stderr() {
        let dir = test_dir("stderr-holder");
        let script = write_script(
            &dir,
            "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"ok\"}'\nprintf '%s\\n' warning >&2\nsleep 30 >/dev/null &\nexit 0\n",
        );
        let log = dir.join("stderr.log");
        let mut process = JsonlProcess::spawn(&script, &[], &dir, &log, "test").unwrap();
        let values = receive_until_eof(&mut process, Duration::from_secs(5));
        assert_eq!(values.len(), 1);

        let timeout = Duration::from_secs(1);
        let started = Instant::now();
        assert!(process.finish(timeout).unwrap().success());
        let elapsed = started.elapsed();
        assert!(
            elapsed < timeout + CLEANUP_MARGIN,
            "finish took {elapsed:?}"
        );
        assert!(fs::read_to_string(log).unwrap().contains("warning"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn finish_terminates_background_child_ignoring_sigterm_at_deadline() {
        let dir = test_dir("stderr-holder-term");
        let script = write_script(
            &dir,
            "#!/bin/sh\nprintf '%s\\n' warning >&2\n(trap '' TERM; exec sleep 30) >/dev/null &\nexit 0\n",
        );
        let log = dir.join("stderr.log");
        let mut process = JsonlProcess::spawn(&script, &[], &dir, &log, "test").unwrap();
        receive_until_eof(&mut process, Duration::from_secs(5));

        let timeout = Duration::from_secs(1);
        let started = Instant::now();
        assert!(process.finish(timeout).unwrap().success());
        let elapsed = started.elapsed();
        assert!(
            elapsed < timeout + CLEANUP_MARGIN,
            "finish took {elapsed:?}"
        );
        assert!(fs::read_to_string(log).unwrap().contains("warning"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn finish_detaches_a_reader_held_open_outside_the_process_group() {
        let dir = test_dir("stderr-holder-escaped");
        let pid_file = dir.join("escaped.pid");
        let script = write_script(
            &dir,
            &format!(
                "#!/bin/sh\nperl -e 'setpgrp(0, 0); exec \"sleep\", \"30\"' >/dev/null &\necho $! > '{}'\nexit 0\n",
                pid_file.display()
            ),
        );
        let log = dir.join("stderr.log");
        let mut process = JsonlProcess::spawn(&script, &[], &dir, &log, "test").unwrap();
        receive_until_eof(&mut process, Duration::from_secs(5));

        let timeout = Duration::from_secs(1);
        let started = Instant::now();
        let status = process.finish(timeout);
        let elapsed = started.elapsed();
        if let Some(pid) = fs::read_to_string(&pid_file)
            .ok()
            .and_then(|pid| pid.trim().parse::<libc::pid_t>().ok())
        {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        assert!(status.unwrap().success());
        assert!(
            elapsed < timeout + CLEANUP_MARGIN,
            "finish took {elapsed:?}"
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn stdout_closes_after_leader_exits_despite_descendant_retaining_pipe() {
        let dir = test_dir("stdout-holder");
        let script = write_script(
            &dir,
            "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"ok\"}'\nsleep 30 &\nexit 0\n",
        );
        let log = dir.join("stderr.log");
        let mut process = JsonlProcess::spawn(&script, &[], &dir, &log, "test").unwrap();
        let values = receive_until_eof(&mut process, Duration::from_secs(2));
        assert_eq!(values.len(), 1);
        assert!(process.finish(Duration::from_secs(1)).unwrap().success());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn cancellation_releases_a_full_event_queue() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "session-jsonl-cancel-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-jsonl-flood");
        fs::write(
            &script,
            "#!/bin/sh\ni=0\nwhile [ $i -lt 1000 ]; do\n  printf '%s\\n' '{\"type\":\"event\"}'\n  i=$((i + 1))\ndone\nsleep 5\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script, permissions).unwrap();
        let log = dir.join("stderr.log");
        let mut process =
            JsonlProcess::spawn(script.to_str().unwrap(), &[], &dir, &log, "test").unwrap();
        thread::sleep(Duration::from_millis(100));

        let started = Instant::now();
        process.kill();

        assert!(started.elapsed() < Duration::from_secs(2));
        fs::remove_dir_all(dir).ok();
    }
}
