use crate::process::{ServiceProcess, MAX_FRAME_BYTES};
use serde_json::{json, Value};
use std::collections::HashSet;
use tokio::sync::{watch, Mutex};

/// One protocol peer belongs to the native service lifetime. A renderer may
/// replace its view of that peer without closing stdin or replaying a command.
pub struct RendererConnection {
    service: ServiceProcess,
    pub server_version: String,
    state: Mutex<Attachment>,
    changed: watch::Sender<u64>,
}

#[derive(Default)]
struct Attachment {
    generation: u64,
    initialized: Option<Value>,
    initializing: bool,
    initialize_waiter: Option<(u64, Value)>,
    reply: Option<String>,
    subscriptions: HashSet<String>,
}

const INITIALIZE_ID: &str = "desktop-native-initialize";
const UNSUBSCRIBE_ID: &str = "desktop-native-unsubscribe";

impl RendererConnection {
    pub fn new(service: ServiceProcess, server_version: String) -> Self {
        Self {
            service,
            server_version,
            state: Mutex::new(Attachment::default()),
            changed: watch::channel(0).0,
        }
    }

    pub async fn attach(&self, generation: u64) -> Result<(), String> {
        let subscriptions = {
            let mut state = self.state.lock().await;
            state.generation = generation;
            state.reply = None;
            state.initialize_waiter = None;
            let subscriptions = state.subscriptions.drain().collect::<Vec<_>>();
            self.changed.send_modify(|version| *version += 1);
            subscriptions
        };
        // A prior IPC receive can outlive its WebView. Wake it and wait for its
        // cancellation before the new renderer becomes the stdout consumer.
        self.service.wait_for_receiver().await;
        for subscription in subscriptions {
            self.unsubscribe(subscription).await?;
        }
        Ok(())
    }

    pub async fn send(&self, generation: u64, frame: String) -> Result<(), String> {
        if frame.len() > MAX_FRAME_BYTES {
            return Err("消息超过大小限制。".into());
        }
        let mut message: Value = serde_json::from_str(&frame).map_err(|_| "无效的协议消息。")?;
        let mut state = self.state.lock().await;
        state.check(generation)?;
        let id = message.get("id").cloned().ok_or("协议请求缺少身份。")?;
        if message["method"] == "initialize" {
            if let Some(result) = &state.initialized {
                if message["params"]["protocolVersion"] != result["protocolVersion"] {
                    return Err("页面与运行中的服务协议版本不一致。".into());
                }
                state.reply = Some(json!({"jsonrpc":"2.0", "id":id, "result":result}).to_string());
                self.changed.send_modify(|version| *version += 1);
                return Ok(());
            }
            state.initialize_waiter = Some((generation, id));
            if state.initializing {
                return Ok(());
            }
            state.initializing = true;
            message["id"] = json!(INITIALIZE_ID);
        } else {
            if message["method"] == "runtime/unsubscribe" {
                if let Some(subscription) = message["params"]["subscriptionId"].as_str() {
                    state.subscriptions.remove(subscription);
                }
            }
            // RuntimeClient request counters restart after a reload. Carry the
            // renderer generation on the wire so an old reply cannot match it.
            message["id"] = json!(json!([generation, id]).to_string());
        }
        drop(state);
        self.service.send(message.to_string()).await
    }

    pub async fn receive(&self, generation: u64) -> Result<String, String> {
        let mut changed = self.changed.subscribe();
        loop {
            {
                let mut state = self.state.lock().await;
                state.check(generation)?;
                if let Some(reply) = state.reply.take() {
                    return Ok(reply);
                }
            }
            let frame = tokio::select! {
                biased;
                _ = changed.changed() => continue,
                frame = self.service.receive() => frame?,
            };
            let mut message: Value =
                serde_json::from_str(&frame).map_err(|_| "无效的服务消息。")?;
            let mut state = self.state.lock().await;
            // Always account for a consumed reply, even if the page changed
            // between stdout delivery and this lock (notably initialization).
            if message["id"] == INITIALIZE_ID {
                state.initializing = false;
                if let Some(result) = message.get("result") {
                    state.initialized = Some(result.clone());
                }
                if let Some((owner, id)) = state.initialize_waiter.take() {
                    if owner == state.generation {
                        message["id"] = id;
                        state.reply = Some(message.to_string());
                        self.changed.send_modify(|version| *version += 1);
                    }
                }
                continue;
            }
            if let Some(wire_id) = message.get("id").and_then(Value::as_str) {
                let identity = serde_json::from_str::<(u64, Value)>(wire_id).ok();
                let subscription = message["result"]["subscriptionId"]
                    .as_str()
                    .map(str::to_owned);
                if let Some(subscription) = subscription {
                    if identity
                        .as_ref()
                        .is_some_and(|(owner, _)| *owner == state.generation)
                    {
                        state.subscriptions.insert(subscription);
                    } else {
                        drop(state);
                        self.unsubscribe(subscription).await?;
                        continue;
                    }
                }
                let Some((owner, id)) = identity else {
                    continue;
                };
                if owner != state.generation {
                    continue;
                }
                message["id"] = id;
            } else if message["method"] == "runtime/subscription" {
                let subscription = message["params"]["subscriptionId"]
                    .as_str()
                    .unwrap_or_default();
                if !state.subscriptions.contains(subscription) {
                    continue;
                }
            }
            if state.generation != generation {
                // The successor must receive its own response if attachment
                // changed after the old receiver consumed a frame.
                state.reply = Some(message.to_string());
                self.changed.send_modify(|version| *version += 1);
                return Err("页面连接已被替换。".into());
            }
            return Ok(message.to_string());
        }
    }

    async fn unsubscribe(&self, subscription_id: String) -> Result<(), String> {
        self.service
            .send(
                json!({
                    "jsonrpc":"2.0", "id":UNSUBSCRIBE_ID, "method":"runtime/unsubscribe",
                    "params":{"subscriptionId":subscription_id}
                })
                .to_string(),
            )
            .await
    }

    pub async fn close(&self) -> Result<(), String> {
        self.service.close().await
    }

    pub fn finished(&self) -> bool {
        self.service.finished()
    }
}

impl Attachment {
    fn check(&self, generation: u64) -> Result<(), String> {
        if self.generation == generation {
            Ok(())
        } else {
            Err("页面连接已被替换。".into())
        }
    }
}
