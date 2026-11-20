//! The replicas: one SQLite file per person (`replica-<handle>.sqlite`)
//! under the app's data directory, which `@session/sync`'s `SqliteStorage`
//! keeps the person's replica and outbox in (`web/desktop/src/tauri.ts`).
//!
//! The page names a replica by the person's handle, never by a path: the
//! commands reach these files and nothing else (review round 1 of phase 3,
//! finding 6).
//!
//! - `replica_open` opens the file on one connection and takes an exclusive
//!   lock on it (`locking_mode = EXCLUSIVE`), held until `replica_close`,
//!   `replica_delete` or the end of the process. A second process on the
//!   same file is refused (`LOCKED`), so two instances never write one
//!   outbox (finding 4).
//! - `replica_select` runs one query; `replica_batch` runs statements in
//!   order in one transaction, every one or none (`SqliteDriver.batch`).
//! - A statement is one statement that starts with SELECT, INSERT, UPDATE,
//!   DELETE, REPLACE, CREATE, DROP or `PRAGMA user_version`; the
//!   connection's authorizer also refuses ATTACH, DETACH and every other
//!   pragma, and nothing else names a file. Transaction control (BEGIN,
//!   COMMIT, END, ROLLBACK, SAVEPOINT, RELEASE) and VACUUM are refused, so a
//!   batch cannot end its own transaction (finding 11).
//! - `replica_delete` closes the file and deletes it with its journal: a
//!   sign-out leaves none of the person's text on the Mac (finding 5).
//!
//! The commands are async and run SQLite on the blocking pool, never on
//! the main thread.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, OpenFlags, ToSql};
use serde::Serialize;
use serde_json::{Map, Value as JsonValue};

/// A command's refusal, as the page reads it (`code`: `LOCKED` when another
/// process holds the file, `REFUSED` for a handle or statement the commands
/// do not take, `NOT_OPEN` before `replica_open`, `FAILED` for SQLite's
/// own errors).
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ReplicaError {
    pub code: &'static str,
    pub message: String,
}

impl ReplicaError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<rusqlite::Error> for ReplicaError {
    fn from(e: rusqlite::Error) -> Self {
        Self::new("FAILED", e.to_string())
    }
}

type Result<T> = std::result::Result<T, ReplicaError>;

/// One statement with its `?` parameters (JSON values).
pub type Statement = (String, Vec<JsonValue>);

/// The replica's file name for a handle (`replica-<handle>.sqlite`), or a
/// refusal for anything but a handle (`^[a-z0-9][a-z0-9._-]{0,63}$`, as
/// `@session/mutators`'s `handleS`): no path reaches the commands.
pub fn file_name(handle: &str) -> Result<String> {
    let mut chars = handle.chars();
    let first_ok = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest_ok = chars
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-');
    if !first_ok || !rest_ok || handle.len() > 64 {
        return Err(ReplicaError::new("REFUSED", "not a handle"));
    }
    Ok(format!("replica-{handle}.sqlite"))
}

/// The SQL text after leading whitespace and comments.
fn skip_space(sql: &str) -> &str {
    let mut s = sql;
    loop {
        let t = s.trim_start();
        if let Some(r) = t.strip_prefix("--") {
            s = r.find('\n').map_or("", |k| &r[k + 1..]);
        } else if let Some(r) = t.strip_prefix("/*") {
            s = r.find("*/").map_or("", |k| &r[k + 2..]);
        } else {
            return t;
        }
    }
}

/// Whether `sql` holds more than one statement: a ";" outside quotes and
/// comments followed by anything but whitespace, comments and ";".
fn has_tail(sql: &str) -> bool {
    let b = sql.as_bytes();
    let mut k = 0;
    while k < b.len() {
        match b[k] {
            q @ (b'\'' | b'"' | b'`') => {
                k += 1;
                while k < b.len() && b[k] != q {
                    k += 1;
                }
            }
            b'[' => {
                while k < b.len() && b[k] != b']' {
                    k += 1;
                }
            }
            b'-' if b.get(k + 1) == Some(&b'-') => {
                while k < b.len() && b[k] != b'\n' {
                    k += 1;
                }
            }
            b'/' if b.get(k + 1) == Some(&b'*') => {
                k += 2;
                while k + 1 < b.len() && !(b[k] == b'*' && b[k + 1] == b'/') {
                    k += 1;
                }
                k += 1;
            }
            b';' => {
                return !skip_space(&sql[k + 1..])
                    .trim_start_matches(';')
                    .trim()
                    .is_empty();
            }
            _ => {}
        }
        k += 1;
    }
    false
}

/// The statements the page may run: one statement whose first word is
/// SELECT, INSERT, UPDATE, DELETE, REPLACE, CREATE or DROP, or `PRAGMA
/// user_version` (the replica's schema version).
pub fn check_statement(sql: &str) -> Result<()> {
    if has_tail(sql) {
        return Err(ReplicaError::new("REFUSED", "one statement at a time"));
    }
    let s = skip_space(sql);
    let word: String = s
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_uppercase();
    let ok = match word.as_str() {
        "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "REPLACE" | "CREATE" | "DROP" => true,
        "PRAGMA" => {
            let rest = skip_space(&s[word.len()..]);
            let name: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            name.eq_ignore_ascii_case("user_version")
        }
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(ReplicaError::new(
            "REFUSED",
            format!("the replica's commands do not run {word:?} statements"),
        ))
    }
}

/// The connection's authorizer: no other database file (ATTACH, DETACH) and
/// no pragma but `user_version`, whatever the statement's text.
fn authorize(ctx: AuthContext<'_>) -> Authorization {
    match ctx.action {
        AuthAction::Attach { .. } | AuthAction::Detach { .. } => Authorization::Deny,
        AuthAction::Pragma { pragma_name, .. }
            if !pragma_name.eq_ignore_ascii_case("user_version") =>
        {
            Authorization::Deny
        }
        _ => Authorization::Allow,
    }
}

/// A JSON parameter as SQLite takes it: null, text, an integer or a real, a
/// boolean as 0 or 1, and anything else as its JSON text.
fn param(v: &JsonValue) -> Value {
    match v {
        JsonValue::Null => Value::Null,
        JsonValue::String(s) => Value::Text(s.clone()),
        JsonValue::Number(n) => match n.as_i64() {
            Some(i) => Value::Integer(i),
            None => Value::Real(n.as_f64().unwrap_or_default()),
        },
        JsonValue::Bool(b) => Value::Integer(i64::from(*b)),
        other => Value::Text(other.to_string()),
    }
}

fn json_of(v: ValueRef<'_>) -> JsonValue {
    match v {
        ValueRef::Null => JsonValue::Null,
        ValueRef::Integer(i) => JsonValue::from(i),
        ValueRef::Real(r) => JsonValue::from(r),
        ValueRef::Text(t) => JsonValue::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => JsonValue::Array(b.iter().map(|x| JsonValue::from(*x)).collect()),
    }
}

/// One open replica: its connection, or none once closed.
type Open = Arc<Mutex<Option<Connection>>>;

/// The replicas of this process: the data directory and the files open.
pub struct Replicas {
    dir: PathBuf,
    open: Mutex<HashMap<String, Open>>,
}

fn poisoned<T>(_: T) -> ReplicaError {
    ReplicaError::new("FAILED", "a replica's lock was poisoned")
}

/// Opens `path` on one connection that holds an exclusive lock on it.
fn connect(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    // another process on the file: refused at once, not after a wait
    conn.busy_timeout(std::time::Duration::ZERO)?;
    conn.execute_batch("PRAGMA locking_mode = EXCLUSIVE; PRAGMA secure_delete = ON;")?;
    // the first write takes the exclusive lock, which the connection keeps
    match conn.execute_batch("BEGIN EXCLUSIVE; COMMIT;") {
        Ok(()) => {}
        Err(rusqlite::Error::SqliteFailure(e, _))
            if matches!(
                e.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) =>
        {
            return Err(ReplicaError::new(
                "LOCKED",
                "another copy of Session is using this replica",
            ));
        }
        Err(e) => return Err(e.into()),
    }
    conn.authorizer(Some(authorize));
    Ok(conn)
}

impl Replicas {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            open: Mutex::new(HashMap::new()),
        }
    }

    fn path(&self, handle: &str) -> Result<PathBuf> {
        Ok(self.dir.join(file_name(handle)?))
    }

    /// Opens the person's replica (made when missing) and locks it; a
    /// replica open already is kept (the page was reloaded).
    pub fn open(&self, handle: &str) -> Result<()> {
        let path = self.path(handle)?;
        let mut open = self.open.lock().map_err(poisoned)?;
        if let Some(o) = open.get(handle)
            && o.lock().map_err(poisoned)?.is_some()
        {
            return Ok(());
        }
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| ReplicaError::new("FAILED", e.to_string()))?;
        let conn = connect(&path)?;
        open.insert(handle.to_owned(), Arc::new(Mutex::new(Some(conn))));
        Ok(())
    }

    fn with<T>(&self, handle: &str, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        file_name(handle)?;
        let o = self
            .open
            .lock()
            .map_err(poisoned)?
            .get(handle)
            .cloned()
            .ok_or_else(|| ReplicaError::new("NOT_OPEN", "the replica is not open"))?;
        let mut guard = o.lock().map_err(poisoned)?;
        let conn = guard
            .as_mut()
            .ok_or_else(|| ReplicaError::new("NOT_OPEN", "the replica is not open"))?;
        f(conn)
    }

    /// The rows of one query, each as an object of its columns.
    pub fn select(
        &self,
        handle: &str,
        sql: &str,
        params: &[JsonValue],
    ) -> Result<Vec<Map<String, JsonValue>>> {
        check_statement(sql)?;
        self.with(handle, |conn| {
            let mut stmt = conn.prepare(sql)?;
            let names: Vec<String> = stmt
                .column_names()
                .iter()
                .map(|s| (*s).to_owned())
                .collect();
            let values: Vec<Value> = params.iter().map(param).collect();
            let refs: Vec<&dyn ToSql> = values.iter().map(|v| v as &dyn ToSql).collect();
            let mut rows = stmt.query(refs.as_slice())?;
            let mut out = Vec::new();
            while let Some(row) = rows.next()? {
                let mut m = Map::new();
                for (k, name) in names.iter().enumerate() {
                    m.insert(name.clone(), json_of(row.get_ref(k)?));
                }
                out.push(m);
            }
            Ok(out)
        })
    }

    /// The statements in order in one transaction: every one applies, or
    /// (on the first error, which it answers) none does.
    pub fn batch(&self, handle: &str, statements: &[Statement]) -> Result<()> {
        for (sql, _) in statements {
            check_statement(sql)?;
        }
        self.with(handle, |conn| {
            let tx = conn.transaction()?;
            for (sql, values) in statements {
                let values: Vec<Value> = values.iter().map(param).collect();
                let refs: Vec<&dyn ToSql> = values.iter().map(|v| v as &dyn ToSql).collect();
                tx.prepare(sql)?.execute(refs.as_slice())?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    /// Closes the person's replica (its lock goes with it).
    pub fn close(&self, handle: &str) -> Result<()> {
        file_name(handle)?;
        let o = self.open.lock().map_err(poisoned)?.remove(handle);
        if let Some(o) = o {
            // a statement running now finishes first
            o.lock().map_err(poisoned)?.take();
        }
        Ok(())
    }

    /// Closes the person's replica and deletes its file and journal.
    pub fn delete(&self, handle: &str) -> Result<()> {
        let path = self.path(handle)?;
        self.close(handle)?;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        for suffix in ["", "-journal", "-wal", "-shm"] {
            match std::fs::remove_file(self.dir.join(format!("{name}{suffix}"))) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(ReplicaError::new("FAILED", e.to_string())),
            }
        }
        Ok(())
    }
}

/// Runs `f` on the blocking pool with the app's replicas.
async fn blocking<T: Send + 'static>(
    replicas: tauri::State<'_, Arc<Replicas>>,
    f: impl FnOnce(&Replicas) -> Result<T> + Send + 'static,
) -> Result<T> {
    let r = Arc::clone(&replicas);
    tauri::async_runtime::spawn_blocking(move || f(&r))
        .await
        .map_err(|e| ReplicaError::new("FAILED", e.to_string()))?
}

#[tauri::command]
pub async fn replica_open(replicas: tauri::State<'_, Arc<Replicas>>, handle: String) -> Result<()> {
    blocking(replicas, move |r| r.open(&handle)).await
}

#[tauri::command]
pub async fn replica_select(
    replicas: tauri::State<'_, Arc<Replicas>>,
    handle: String,
    sql: String,
    params: Vec<JsonValue>,
) -> Result<Vec<Map<String, JsonValue>>> {
    blocking(replicas, move |r| r.select(&handle, &sql, &params)).await
}

#[tauri::command]
pub async fn replica_batch(
    replicas: tauri::State<'_, Arc<Replicas>>,
    handle: String,
    statements: Vec<Statement>,
) -> Result<()> {
    blocking(replicas, move |r| r.batch(&handle, &statements)).await
}

#[tauri::command]
pub async fn replica_close(
    replicas: tauri::State<'_, Arc<Replicas>>,
    handle: String,
) -> Result<()> {
    blocking(replicas, move |r| r.close(&handle)).await
}

#[tauri::command]
pub async fn replica_delete(
    replicas: tauri::State<'_, Arc<Replicas>>,
    handle: String,
) -> Result<()> {
    blocking(replicas, move |r| r.delete(&handle)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A data directory of the test's own.
    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("session-replica-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn st(sql: &str, params: Vec<JsonValue>) -> Statement {
        (sql.to_owned(), params)
    }

    #[test]
    fn a_handle_names_a_file_in_the_directory_and_nothing_else() {
        assert_eq!(file_name("ines.v").unwrap(), "replica-ines.v.sqlite");
        assert_eq!(file_name("a-b_c9").unwrap(), "replica-a-b_c9.sqlite");
        for bad in [
            "",
            "../x",
            "/etc/passwd",
            "Ines",
            ".hidden",
            "a/b",
            "a\\b",
            "sqlite:x",
            &"a".repeat(65),
        ] {
            assert_eq!(file_name(bad).unwrap_err().code, "REFUSED", "{bad}");
        }
    }

    #[test]
    fn a_batch_applies_in_order_with_its_parameters() {
        let r = Replicas::new(dir("order"));
        r.open("ana").unwrap();
        r.batch(
            "ana",
            &[
                st(
                    "CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, n INTEGER, r REAL, b INTEGER, j TEXT)",
                    vec![],
                ),
                st(
                    "INSERT INTO t (k, n, r, b, j) VALUES (?, ?, ?, ?, ?)",
                    vec![json!("a"), json!(3), json!(1.5), json!(true), json!({ "x": 1 })],
                ),
                st("INSERT INTO t (k, n) VALUES (?, ?)", vec![json!("b"), JsonValue::Null]),
            ],
        )
        .unwrap();
        let rows = r
            .select(
                "ana",
                "SELECT k, n, r, b, j, typeof(n) AS tn FROM t ORDER BY k",
                &[],
            )
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["n"], json!(3));
        assert_eq!(rows[0]["tn"], json!("integer"));
        assert_eq!(rows[0]["r"], json!(1.5));
        assert_eq!(rows[0]["b"], json!(1));
        assert_eq!(rows[0]["j"], json!(r#"{"x":1}"#));
        assert_eq!(rows[1]["n"], JsonValue::Null);
        let one = r
            .select("ana", "SELECT k FROM t WHERE k = ?", &[json!("b")])
            .unwrap();
        assert_eq!(one, vec![json!({ "k": "b" }).as_object().unwrap().clone()]);
    }

    #[test]
    fn a_failing_statement_rolls_the_whole_batch_back() {
        let r = Replicas::new(dir("rollback"));
        r.open("ana").unwrap();
        r.batch("ana", &[st("CREATE TABLE u (k TEXT PRIMARY KEY)", vec![])])
            .unwrap();
        let err = r.batch(
            "ana",
            &[
                st("INSERT INTO u (k) VALUES (?)", vec![json!("one")]),
                st("INSERT INTO u (k) VALUES (?)", vec![json!("one")]),
            ],
        );
        assert_eq!(err.unwrap_err().code, "FAILED");
        let n = r.select("ana", "SELECT count(*) AS n FROM u", &[]).unwrap();
        assert_eq!(n[0]["n"], json!(0));
    }

    #[test]
    fn transaction_control_and_other_files_are_refused() {
        let d = dir("refused");
        let r = Replicas::new(d.clone());
        r.open("ana").unwrap();
        r.batch("ana", &[st("CREATE TABLE t (k TEXT PRIMARY KEY)", vec![])])
            .unwrap();
        // the reviewer's experiment: INSERT d; COMMIT; a failing INSERT kept d
        let err = r.batch(
            "ana",
            &[
                st("INSERT INTO t (k) VALUES ('d')", vec![]),
                st("COMMIT", vec![]),
                st("INSERT INTO t (k) VALUES ('d')", vec![]),
            ],
        );
        assert_eq!(err.unwrap_err().code, "REFUSED");
        let n = r.select("ana", "SELECT count(*) AS n FROM t", &[]).unwrap();
        assert_eq!(n[0]["n"], json!(0));
        let attached = d.join("attached.sqlite");
        for sql in [
            "BEGIN",
            "begin immediate",
            "COMMIT",
            "END",
            "ROLLBACK",
            "SAVEPOINT a",
            "RELEASE a",
            "VACUUM",
            &format!("VACUUM INTO '{}'", attached.display()),
            &format!("ATTACH DATABASE '{}' AS x", attached.display()),
            "DETACH x",
            "PRAGMA writable_schema = ON",
            "PRAGMA journal_mode = WAL",
            "pragma locking_mode = NORMAL",
            "/* x */ ANALYZE",
            "INSERT INTO t (k) VALUES ('e'); DROP TABLE t",
            "SELECT 1; ATTACH 'x' AS y",
            "REINDEX",
        ] {
            assert_eq!(
                r.batch("ana", &[st(sql, vec![])]).unwrap_err().code,
                "REFUSED",
                "{sql}"
            );
            assert_eq!(
                r.select("ana", sql, &[]).unwrap_err().code,
                "REFUSED",
                "{sql}"
            );
        }
        assert!(!attached.exists());
        // a ";" in a comment or a string is not a second statement
        assert!(
            r.select("ana", "SELECT 1 -- ; DROP TABLE t\n;", &[])
                .is_ok()
        );
        // what is allowed: one statement, comments, the schema version
        assert!(
            r.select("ana", "  -- the version\n PRAGMA user_version", &[])
                .is_ok()
        );
        r.batch("ana", &[st("PRAGMA user_version = 3", vec![])])
            .unwrap();
        assert_eq!(
            r.select("ana", "PRAGMA user_version", &[]).unwrap()[0]["user_version"],
            json!(3)
        );
        assert!(r.select("ana", "SELECT ';' AS s; ", &[]).is_ok());
        assert_eq!(
            r.select("ana", "SELECT ';' AS s", &[]).unwrap()[0]["s"],
            json!(";")
        );
    }

    #[test]
    fn the_authorizer_refuses_attach_and_pragmas_whatever_the_text() {
        let d = dir("authorizer");
        std::fs::create_dir_all(&d).unwrap();
        let conn = connect(&d.join("x.sqlite")).unwrap();
        let attached = d.join("attached.sqlite");
        assert!(
            conn.execute_batch(&format!("ATTACH DATABASE '{}' AS x", attached.display()))
                .is_err()
        );
        assert!(!attached.exists());
        assert!(conn.execute_batch("PRAGMA writable_schema = ON").is_err());
        assert!(conn.execute_batch("PRAGMA user_version = 2").is_ok());
    }

    #[test]
    fn a_second_process_on_the_file_is_refused_until_the_first_closes_it() {
        let d = dir("locked");
        let first = Replicas::new(d.clone());
        let second = Replicas::new(d.clone());
        first.open("ana").unwrap();
        first
            .batch("ana", &[st("CREATE TABLE t (k TEXT)", vec![])])
            .unwrap();
        assert_eq!(second.open("ana").unwrap_err().code, "LOCKED");
        // another person's replica is another file
        second.open("bo").unwrap();
        // opening again in the same process keeps the connection
        first.open("ana").unwrap();
        first.close("ana").unwrap();
        second.open("ana").unwrap();
        assert_eq!(
            second
                .select("ana", "SELECT count(*) AS n FROM t", &[])
                .unwrap()[0]["n"],
            json!(0)
        );
        assert_eq!(
            first.select("ana", "SELECT 1", &[]).unwrap_err().code,
            "NOT_OPEN"
        );
    }

    #[test]
    fn delete_closes_the_file_and_removes_it_with_its_journal() {
        let d = dir("delete");
        let r = Replicas::new(d.clone());
        r.open("ana").unwrap();
        r.batch(
            "ana",
            &[
                st("CREATE TABLE t (body TEXT)", vec![]),
                st("INSERT INTO t VALUES (?)", vec![json!("PRIVATE-DRAFT")]),
            ],
        )
        .unwrap();
        let file = d.join("replica-ana.sqlite");
        assert!(file.exists());
        std::fs::write(d.join("replica-ana.sqlite-journal"), b"j").unwrap();
        std::fs::write(d.join("replica-bo.sqlite"), b"other").unwrap();
        r.delete("ana").unwrap();
        assert!(!file.exists());
        assert!(!d.join("replica-ana.sqlite-journal").exists());
        // another person's file stays
        assert!(d.join("replica-bo.sqlite").exists());
        assert_eq!(
            r.select("ana", "SELECT 1", &[]).unwrap_err().code,
            "NOT_OPEN"
        );
        // deleting what is gone is not an error, and the next open starts empty
        r.delete("ana").unwrap();
        r.open("ana").unwrap();
        assert!(
            r.select("ana", "SELECT count(*) AS n FROM sqlite_master", &[])
                .unwrap()[0]["n"]
                == json!(0)
        );
        assert_eq!(r.delete("../x").unwrap_err().code, "REFUSED");
    }
}
