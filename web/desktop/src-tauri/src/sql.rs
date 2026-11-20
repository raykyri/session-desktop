//! `sql_batch`: statements run in order in one transaction on one connection
//! of the SQL plugin's pool for a database the page loaded
//! (`Database.load`). The plugin's own `execute` may run each call on
//! another pooled connection, so it cannot run BEGIN, the statements and
//! COMMIT as separate calls (`@session/sync`'s `SqliteDriver.batch`).

use serde_json::Value as JsonValue;
use sqlx::sqlite::{Sqlite, SqliteArguments};
use sqlx::{Pool, query::Query};
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};

/// One statement with its `?` parameters (JSON values).
pub type Statement = (String, Vec<JsonValue>);

/// Binds one JSON value: null, text, an integer or a real, a boolean as 0
/// or 1, and anything else as its JSON text.
fn bind<'q>(
    q: Query<'q, Sqlite, SqliteArguments<'q>>,
    v: JsonValue,
) -> Query<'q, Sqlite, SqliteArguments<'q>> {
    match v {
        JsonValue::Null => q.bind(None::<String>),
        JsonValue::String(s) => q.bind(s),
        JsonValue::Number(n) => match n.as_i64() {
            Some(i) => q.bind(i),
            None => q.bind(n.as_f64().unwrap_or_default()),
        },
        JsonValue::Bool(b) => q.bind(i64::from(b)),
        other => q.bind(other.to_string()),
    }
}

/// Runs the statements in one transaction: every one applies, or (on the
/// first error, which it answers) none does.
pub async fn run_batch(pool: &Pool<Sqlite>, statements: Vec<Statement>) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    for (sql, values) in &statements {
        let mut q = sqlx::query(sql);
        for v in values.iter().cloned() {
            q = bind(q, v);
        }
        q.execute(&mut *tx).await.map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sql_batch(
    instances: State<'_, DbInstances>,
    db: String,
    statements: Vec<Statement>,
) -> Result<(), String> {
    let pool = {
        let lock = instances.0.read().await;
        match lock.get(&db) {
            Some(DbPool::Sqlite(pool)) => pool.clone(),
            #[allow(unreachable_patterns)]
            _ => return Err(format!("the database {db} is not loaded")),
        }
    };
    run_batch(&pool, statements).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::Row;
    use sqlx::sqlite::SqlitePoolOptions;

    /// A pool of several connections over a new file, as the plugin's.
    async fn pool(name: &str) -> Pool<Sqlite> {
        let path = std::env::temp_dir().join(format!(
            "session-batch-{}-{name}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        SqlitePoolOptions::new()
            .max_connections(4)
            .connect(&format!("sqlite:{}?mode=rwc", path.display()))
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_batch_applies_in_order_with_its_parameters() {
        let p = pool("order").await;
        run_batch(
            &p,
            vec![
                (
                    "CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, n INTEGER, r REAL, b INTEGER, j TEXT)".into(),
                    vec![],
                ),
                (
                    "INSERT INTO t (k, n, r, b, j) VALUES (?, ?, ?, ?, ?)".into(),
                    vec![json!("a"), json!(3), json!(1.5), json!(true), json!({ "x": 1 })],
                ),
                ("INSERT INTO t (k, n) VALUES (?, ?)".into(), vec![json!("b"), JsonValue::Null]),
            ],
        )
        .await
        .unwrap();
        let rows = sqlx::query("SELECT k, n, r, b, j, typeof(n) AS tn FROM t ORDER BY k")
            .fetch_all(&p)
            .await
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get::<i64, _>("n"), 3);
        assert_eq!(rows[0].get::<String, _>("tn"), "integer");
        assert_eq!(rows[0].get::<f64, _>("r"), 1.5);
        assert_eq!(rows[0].get::<i64, _>("b"), 1);
        assert_eq!(rows[0].get::<String, _>("j"), r#"{"x":1}"#);
        assert_eq!(rows[1].get::<Option<i64>, _>("n"), None);
    }

    #[tokio::test]
    async fn a_failing_statement_rolls_the_whole_batch_back() {
        let p = pool("rollback").await;
        run_batch(
            &p,
            vec![(
                "CREATE TABLE IF NOT EXISTS u (k TEXT PRIMARY KEY)".into(),
                vec![],
            )],
        )
        .await
        .unwrap();
        let err = run_batch(
            &p,
            vec![
                ("INSERT INTO u (k) VALUES (?)".into(), vec![json!("one")]),
                ("INSERT INTO u (k) VALUES (?)".into(), vec![json!("one")]),
            ],
        )
        .await;
        assert!(err.is_err());
        let n: i64 = sqlx::query("SELECT count(*) AS n FROM u")
            .fetch_one(&p)
            .await
            .unwrap()
            .get("n");
        assert_eq!(n, 0);
    }
}
