#[path = "../src/process.rs"]
mod process;
#[path = "../src/renderer.rs"]
mod renderer;

use process::ServiceProcess;
use renderer::RendererConnection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::time::timeout;

async fn request(
    process: &RendererConnection,
    generation: u64,
    id: &str,
    method: &str,
    params: Value,
) -> Value {
    process
        .send(
            generation,
            json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}).to_string(),
        )
        .await
        .unwrap();
    loop {
        let line = timeout(Duration::from_secs(20), process.receive(generation))
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
    let startup = Instant::now();
    let executable = std::fs::read(root.join("kite-service")).unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(&executable)),
        manifest["executableSha256"].as_str().unwrap()
    );
    let process = ServiceProcess::spawn(
        &root.join("kite-service"),
        &workspace,
        &home,
        &home.join(".kite-code"),
        build_id,
        &environment_keys,
    )
    .unwrap();
    let process = Arc::new(RendererConnection::new(
        process,
        manifest["expectedServerVersion"]
            .as_str()
            .unwrap()
            .to_owned(),
    ));
    process.attach(1).await.unwrap();
    process.send(1, json!({"jsonrpc":"2.0", "id":"abandoned-init", "method":"initialize", "params":{"protocolVersion":2,"clientInfo":{"name":"desktop-smoke","version":"1","instanceId":"native-peer"}}}).to_string()).await.unwrap();
    // A reload before initialize returns must still initialize the peer once.
    let mut generation = 2;
    process.attach(generation).await.unwrap();
    let initialized = request(&process, generation, "init", "initialize", json!({"protocolVersion":2,"clientInfo":{"name":"desktop-smoke","version":"1","instanceId":"desktop-smoke"}})).await;
    assert_eq!(
        initialized["serverInfo"]["version"],
        manifest["expectedServerVersion"]
    );
    assert_eq!(initialized["serverInfo"]["version"], process.server_version);
    let directory = request(
        &process,
        generation,
        "startup-directory",
        "history/list_sessions",
        json!({"request":{"limit":100}}),
    )
    .await;
    assert!(directory["entries"].is_array());
    println!(
        "Desktop verified service startup through initial directory: {}ms",
        startup.elapsed().as_millis()
    );
    let abandoned_receive = {
        let process = process.clone();
        tokio::spawn(async move { process.receive(2).await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    generation = 3;
    process.attach(generation).await.unwrap();
    assert!(abandoned_receive.await.unwrap().is_err());
    let reinitialized = request(&process, generation, "init", "initialize", json!({"protocolVersion":2,"clientInfo":{"name":"desktop-smoke","version":"1","instanceId":"new-renderer"}})).await;
    assert_eq!(reinitialized, initialized);
    let trust = request(&process, generation, "trust-query", "app/workspace_trust/query", json!({"request":{"schema":"kite.app.workspace-trust.query-request.v1","workspace":workspace}})).await["response"].clone();
    let trusted = request(&process, generation, "trust", "app/workspace_trust/decide", json!({"request":{
        "schema":"kite.app.workspace-trust.decision-request.v1", "workspace":trust["workspace"], "observedStatus":trust["status"],
        "expectedRevision":trust["revision"], "decision":"trust", "externalReadScopeDigest":trust["externalReadScope"]["digest"]
    }})).await;
    assert_eq!(trusted["response"]["status"], "trusted");
    let created = request(&process, generation, "create", "runtime/command", json!({"command":{"schema":"kite.runtime-command.v1","commandId":"smoke-create","type":"create_session","bootstrapSessionId":"desktop-smoke-session"}})).await;
    assert_eq!(created["status"], "applied");
    request(&process, generation, "subscribe", "runtime/subscribe", json!({"subscription":{"scope":"session","sessionId":"desktop-smoke-session","includeEphemeral":true}})).await;
    let started = request(&process, generation, "turn", "runtime/command", json!({"command":{"schema":"kite.runtime-command.v1","commandId":"smoke-start","type":"start_turn","sessionId":"desktop-smoke-session","expectedRevision":created["revision"],"input":"Reply with desktop smoke complete.","phase":"building"}})).await;
    assert_eq!(started["status"], "applied");
    let mut streamed = false;
    timeout(Duration::from_secs(30), async {
        loop {
            let frame = process.receive(generation).await.unwrap();
            if frame.contains("model.text_delta") && frame.contains("desktop smoke") {
                streamed = true;
                if generation == 3 {
                    // Leave an old reply on stdout, then restart the renderer's
                    // request counter while the same model turn keeps running.
                    process.send(generation, json!({"jsonrpc":"2.0","id":"reused-id","method":"runtime/query","params":{"query":{"schema":"kite.runtime-query.v1","type":"get_session_projection","sessionId":"desktop-smoke-session"}}}).to_string()).await.unwrap();
                    generation = 4;
                    // A transport failure detaches only the renderer; the model keeps running.
                    process.attach(0).await.unwrap();
                    assert!(!process.finished());
                    process.attach(generation).await.unwrap();
                    let resumed = request(&process, generation, "init", "initialize", json!({"protocolVersion":2,"clientInfo":{"name":"desktop-smoke","version":"1","instanceId":"stream-renderer"}})).await;
                    assert_eq!(resumed["serverInfo"]["instanceId"], initialized["serverInfo"]["instanceId"]);
                    let directory = request(&process, generation, "reused-id", "runtime/query", json!({"query":{"schema":"kite.runtime-query.v1","type":"list_sessions"}})).await;
                    assert!(directory["sessions"].is_array());
                    request(&process, generation, "resubscribe", "runtime/subscribe", json!({"subscription":{"scope":"session","sessionId":"desktop-smoke-session","includeEphemeral":true}})).await;
                }

            }
            let value: Value = serde_json::from_str(&frame).unwrap();
            if frame.contains("run.terminal") || frame.contains("turn.completed") || value.pointer("/params/message/projection/session/currentRun/status").and_then(Value::as_str) == Some("completed") {
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
    assert_eq!(
        generation, 4,
        "the renderer must be replaced during streaming"
    );
    let history = request(
        &process,
        generation,
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
            let projection = request(&process, generation, "projection", "runtime/query", json!({"query":{"schema":"kite.runtime-query.v1","type":"get_session_projection","sessionId":"desktop-smoke-session"}})).await;
            let second = request(&process, generation, "turn2", "runtime/command", json!({"command":{"schema":"kite.runtime-command.v1","commandId":format!("smoke-second-{attempt}"),"type":"start_turn","sessionId":"desktop-smoke-session","expectedRevision":projection["session"]["revision"],"input":"wait","phase":"building"}})).await;
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
    let successor = RendererConnection::new(
        successor,
        manifest["expectedServerVersion"]
            .as_str()
            .unwrap()
            .to_owned(),
    );
    successor.attach(1).await.unwrap();
    request(&successor, 1, "init2", "initialize", json!({"protocolVersion":2,"clientInfo":{"name":"desktop-smoke","version":"1","instanceId":"desktop-smoke-successor"}})).await;
    let restored = request(
        &successor,
        1,
        "history2",
        "history/load_session",
        json!({"sessionId":"desktop-smoke-session"}),
    )
    .await;
    assert!(restored.to_string().contains("desktop smoke complete"));
    successor.close().await.unwrap();
}
