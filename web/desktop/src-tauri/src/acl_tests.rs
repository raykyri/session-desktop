//! The app's access control as the page meets it (review round 1 of phase
//! 3, findings 2 and 6): the app's context (`tauri.conf.json`,
//! `capabilities/default.json` and the commands `build.rs` declares) on
//! Tauri's mock runtime, and IPC requests as the app's page or a remote
//! page sends them.

use std::sync::Arc;

use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewWindow};

use crate::keychain::{Keychain, Memory};
use crate::replica::Replicas;

const APP: &str = "tauri://localhost/";
const REMOTE: &str = "https://evil.example/";

fn app(name: &str) -> (tauri::App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let dir = std::env::temp_dir().join(format!("session-acl-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let mut app = crate::app(
        mock_builder()
            .manage(Keychain::new(Box::new(Memory::default())))
            .manage(Arc::new(Replicas::new(dir))),
    )
    .build(tauri::generate_context!())
    .expect("the app");
    // the app's setup (which makes the window) runs on the first iteration
    // (deprecated for a loop, which this is not)
    #[allow(deprecated)]
    app.run_iteration(|_, _| {});
    let w = app.get_webview_window("main").expect("the main window");
    (app, w)
}

fn call(
    w: &WebviewWindow<MockRuntime>,
    origin: &str,
    cmd: &str,
    body: Value,
) -> Result<Value, String> {
    let r = get_ipc_response(
        w,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: origin.parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    );
    match r {
        Ok(InvokeResponseBody::Json(s)) => Ok(serde_json::from_str(&s).unwrap_or(Value::Null)),
        Ok(InvokeResponseBody::Raw(_)) => Ok(Value::Null),
        Err(e) => Err(e.to_string()),
    }
}

/// Whether the opener plugin's scope refused the link (a launcher that
/// fails, as on a Linux machine without a desktop, means it was allowed).
fn refused(r: &Result<Value, String>) -> bool {
    matches!(r, Err(e) if e.contains("Not allowed to open url"))
}

#[test]
fn links_open_for_http_https_and_mailto_only() {
    let (_app, w) = app("links");
    for url in [
        "https://session.app/device?request=01REQ",
        "https://session.app/download",
        "http://127.0.0.1:8960/device?request=01REQ",
        "https://example.com/a-markdown-link",
        "mailto:someone@example.com",
    ] {
        let r = call(&w, APP, "plugin:opener|open_url", json!({ "url": url }));
        assert!(!refused(&r), "{url}: {r:?}");
    }
    for url in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "smb://host/share",
        "tauri://localhost/",
        "/Applications/Calculator.app",
    ] {
        let r = call(&w, APP, "plugin:opener|open_url", json!({ "url": url }));
        assert!(refused(&r), "{url}: {r:?}");
    }
    // a remote page in the window opens nothing
    let r = call(
        &w,
        REMOTE,
        "plugin:opener|open_url",
        json!({ "url": "https://session.app/" }),
    );
    assert!(r.is_err(), "{r:?}");
}

#[test]
fn the_apps_commands_answer_its_own_pages_and_no_remote_page() {
    let (_app, w) = app("commands");
    assert_eq!(
        call(&w, APP, "replica_open", json!({ "handle": "ana" })),
        Ok(Value::Null)
    );
    assert_eq!(
        call(
            &w,
            APP,
            "replica_batch",
            json!({ "handle": "ana", "statements": [["CREATE TABLE t (k TEXT)", []], ["INSERT INTO t VALUES (?)", ["a"]]] }),
        ),
        Ok(Value::Null)
    );
    assert_eq!(
        call(
            &w,
            APP,
            "replica_select",
            json!({ "handle": "ana", "sql": "SELECT k FROM t", "params": [] }),
        ),
        Ok(json!([{ "k": "a" }]))
    );
    // a batch that ends its own transaction is refused (finding 11)
    let r = call(
        &w,
        APP,
        "replica_batch",
        json!({ "handle": "ana", "statements": [["INSERT INTO t VALUES ('d')", []], ["COMMIT", []]] }),
    );
    assert!(matches!(&r, Err(e) if e.contains("REFUSED")), "{r:?}");
    // a path is not a handle
    let r = call(&w, APP, "replica_open", json!({ "handle": "../../x" }));
    assert!(matches!(&r, Err(e) if e.contains("REFUSED")), "{r:?}");
    assert_eq!(
        call(&w, APP, "keychain_set", json!({ "value": "{}" })),
        Ok(Value::Null)
    );
    assert_eq!(call(&w, APP, "keychain_get", json!({})), Ok(json!("{}")));
    let about = call(&w, APP, "app_about", json!({})).unwrap();
    assert!(
        about["app"]
            .as_str()
            .unwrap()
            .starts_with("Session for Mac ")
    );
    assert_eq!(
        call(&w, APP, "replica_delete", json!({ "handle": "ana" })),
        Ok(Value::Null)
    );

    // a remote page reaches none of them
    for (cmd, body) in [
        ("replica_open", json!({ "handle": "ana" })),
        (
            "replica_select",
            json!({ "handle": "ana", "sql": "SELECT 1", "params": [] }),
        ),
        (
            "replica_batch",
            json!({ "handle": "ana", "statements": [] }),
        ),
        ("replica_close", json!({ "handle": "ana" })),
        ("replica_delete", json!({ "handle": "ana" })),
        ("keychain_get", json!({})),
        ("keychain_set", json!({ "value": "x" })),
        ("keychain_delete", json!({})),
        ("app_about", json!({})),
    ] {
        let r = call(&w, REMOTE, cmd, body);
        assert!(
            matches!(&r, Err(e) if e.contains("not allowed")),
            "{cmd}: {r:?}"
        );
    }
}

#[test]
fn the_page_has_no_generic_sql() {
    let (_app, w) = app("nosql");
    for (cmd, body) in [
        (
            "plugin:sql|load",
            json!({ "db": "sqlite:/tmp/outside.sqlite" }),
        ),
        (
            "plugin:sql|execute",
            json!({ "db": "sqlite:x.sqlite", "query": "SELECT 1", "values": [] }),
        ),
        (
            "sql_batch",
            json!({ "db": "sqlite:x.sqlite", "statements": [] }),
        ),
    ] {
        let r = call(&w, APP, cmd, body);
        assert!(r.is_err(), "{cmd}: {r:?}");
    }
}
