#[path = "../src/process.rs"]
mod process;

use process::ServiceProcess;
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use tokio::time::timeout;

async fn request(process: &ServiceProcess, id: &str, method: &str, params: Value) -> Value {
    process
        .send(json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}).to_string())
        .await
        .unwrap();
    loop {
        let line = timeout(Duration::from_secs(20), process.receive())
            .await
            .unwrap()
            .unwrap();
        let value: Value = serde_json::from_str(&line).unwrap();
        if value["id"] == id {
            assert!(value.get("error").is_none(), "RPC failed: {value}");
            return value["result"].clone();
        }
    }
}

#[tokio::test]
#[ignore = "Run with the isolated local model fixture using test:desktop:native"]
async fn paired_service_stream_and_eof() {
    let home =
        PathBuf::from(std::env::var("KITE_DESKTOP_SMOKE_HOME").expect("isolated home required"));
    assert!(home.starts_with(std::env::temp_dir().canonicalize().unwrap()));
    let workspace = home.join("workspace");
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("service");
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(root.join("desktop.json")).unwrap()).unwrap();
    let build_id = manifest["buildId"].as_str().unwrap();
    let environment_keys: Vec<String> =
        serde_json::from_value(manifest["environmentKeys"].clone()).unwrap();
    let process = ServiceProcess::spawn(
        &root.join("kite-service"),
        &workspace,
        &home,
        &home.join(".kite-code"),
        build_id,
        &environment_keys,
    )
    .unwrap();
    let initialized = request(&process, "init", "initialize", json!({"protocolVersion":2,"clientInfo":{"name":"desktop-smoke","version":"1","instanceId":"desktop-smoke"}})).await;
    assert_eq!(
        initialized["serverInfo"]["version"],
        manifest["expectedServerVersion"]
    );
    let trust = request(&process, "trust-query", "app/workspace_trust/query", json!({"request":{"schema":"kite.app.workspace-trust.query-request.v1","workspace":workspace}})).await["response"].clone();
    let trusted = request(&process, "trust", "app/workspace_trust/decide", json!({"request":{
        "schema":"kite.app.workspace-trust.decision-request.v1", "workspace":trust["workspace"], "observedStatus":trust["status"],
        "expectedRevision":trust["revision"], "decision":"trust", "externalReadScopeDigest":trust["externalReadScope"]["digest"]
    }})).await;
    assert_eq!(trusted["response"]["status"], "trusted");
    let created = request(&process, "create", "runtime/command", json!({"command":{"schema":"kite.runtime-command.v1","commandId":"smoke-create","type":"create_session","bootstrapSessionId":"desktop-smoke-session"}})).await;
    assert_eq!(created["status"], "applied");
    request(&process, "subscribe", "runtime/subscribe", json!({"subscription":{"scope":"session","sessionId":"desktop-smoke-session","includeEphemeral":true}})).await;
    let started = request(&process, "turn", "runtime/command", json!({"command":{"schema":"kite.runtime-command.v1","commandId":"smoke-start","type":"start_turn","sessionId":"desktop-smoke-session","expectedRevision":created["revision"],"input":"Reply with desktop smoke complete.","phase":"building"}})).await;
    assert_eq!(started["status"], "applied");
    let mut streamed = false;
    timeout(Duration::from_secs(30), async {
        loop {
            let frame = process.receive().await.unwrap();
            if frame.contains("model.text_delta") && frame.contains("desktop smoke") {
                streamed = true;
            }
            let value: Value = serde_json::from_str(&frame).unwrap();
            if frame.contains("run.terminal") || frame.contains("turn.completed") {
                assert!(
                    streamed,
                    "durable terminal arrived without streaming evidence: {value}"
                );
                break;
            }
        }
    })
    .await
    .expect("no terminal event");
    let history = request(
        &process,
        "history",
        "history/load_session",
        json!({"sessionId":"desktop-smoke-session"}),
    )
    .await;
    assert!(history.to_string().contains("desktop smoke complete"));
    // Start another model invocation, then EOF must settle and release it.
    let mut attempt = 0;
    timeout(Duration::from_secs(10), async {
        loop {
            let projection = request(&process, "projection", "runtime/query", json!({"query":{"schema":"kite.runtime-query.v1","type":"get_session_projection","sessionId":"desktop-smoke-session"}})).await;
            let second = request(&process, "turn2", "runtime/command", json!({"command":{"schema":"kite.runtime-command.v1","commandId":format!("smoke-second-{attempt}"),"type":"start_turn","sessionId":"desktop-smoke-session","expectedRevision":projection["session"]["revision"],"input":"wait","phase":"building"}})).await;
            if second["status"] == "applied" { break; }
            assert_eq!(second["code"], "runtime_busy", "second receipt: {second}");
            attempt += 1;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }).await.expect("previous run never released execution admission");
    tokio::time::sleep(Duration::from_millis(500)).await;
    timeout(Duration::from_secs(20), process.close())
        .await
        .unwrap()
        .unwrap();
    assert!(home.join(".kite-code/kite-session.sqlite").is_file());
    assert!(!home.join(".kite-code/service.sock").exists());
    let successor = ServiceProcess::spawn(
        &root.join("kite-service"),
        &workspace,
        &home,
        &home.join(".kite-code"),
        build_id,
        &environment_keys,
    )
    .unwrap();
    request(&successor, "init2", "initialize", json!({"protocolVersion":2,"clientInfo":{"name":"desktop-smoke","version":"1","instanceId":"desktop-smoke-successor"}})).await;
    let restored = request(
        &successor,
        "history2",
        "history/load_session",
        json!({"sessionId":"desktop-smoke-session"}),
    )
    .await;
    assert!(restored.to_string().contains("desktop smoke complete"));
    successor.close().await.unwrap();
}
