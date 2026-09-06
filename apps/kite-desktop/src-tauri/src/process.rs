use std::{path::Path, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, Command},
    sync::{mpsc, watch, Mutex},
    time::timeout,
};

pub const MAX_FRAME_BYTES: usize = 1_048_576;
const QUEUED_FRAMES: usize = 16;
const CLOSE_TIMEOUT: Duration = Duration::from_secs(15);

/// One owned child. Queue capacity bounds retained stdout to at most 16 MiB.
pub struct ServiceProcess {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    output: Mutex<mpsc::Receiver<Result<String, String>>>,
    stop: watch::Sender<bool>,
    done: watch::Receiver<Option<Result<(), String>>>,
}

impl ServiceProcess {
    pub fn spawn(
        executable: &Path,
        workspace: &Path,
        home: &Path,
        runtime_root: &Path,
        build_id: &str,
        environment_keys: &[String],
    ) -> Result<Self, String> {
        let profile = home.join(".kite-code");
        let mut command = Command::new(executable);
        command
            .args(["app-server", "run-stdio"])
            .current_dir(home)
            .env_clear()
            .env("HOME", home)
            .env("USERPROFILE", home)
            .env(
                "PATH",
                std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into()),
            )
            .env("NODE_ENV", "production")
            .env("KITE_CODE_HOME", runtime_root)
            .env("KITE_CODE_CONFIG_HOME", &profile)
            .env("KITE_APP_SERVER_WORKSPACE", workspace)
            .env("KITE_APP_SERVER_BUILD_ID", build_id)
            .env("KITE_STANDALONE_EXECUTABLE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for key in environment_keys {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut child = command
            .spawn()
            .map_err(|_| "无法启动配套服务，请检查安装与执行权限。")?;
        let stdin = Arc::new(Mutex::new(child.stdin.take()));
        let stdout = child.stdout.take().ok_or("服务 stdout 不可用。")?;
        let stderr = child.stderr.take().ok_or("服务 stderr 不可用。")?;
        let (output_tx, output) = mpsc::channel(QUEUED_FRAMES);
        let (stop, mut stop_rx) = watch::channel(false);
        let (done_tx, done) = watch::channel(None);
        let read_stop = stop.clone();
        let reader = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_frame(&mut reader).await {
                    Ok(Some(frame)) => {
                        if output_tx.send(Ok(frame)).await.is_err() {
                            break;
                        }
                    }
                    result => {
                        let error = result
                            .err()
                            .unwrap_or_else(|| "配套服务连接已关闭。".into());
                        let _ = output_tx.try_send(Err(error));
                        break;
                    }
                }
            }
            let _ = read_stop.send(true);
        });
        let diagnostics = tokio::spawn(async move {
            // Drain without forwarding child stderr, which can contain secrets.
            let _ = tokio::io::copy(&mut BufReader::new(stderr), &mut tokio::io::sink()).await;
        });
        let closing_stdin = stdin.clone();
        tokio::spawn(async move {
            let result = tokio::select! {
                status = child.wait() => status.map_err(|_| "无法确认服务退出。".to_string()).and_then(|s| {
                    if s.success() { Ok(()) } else { Err("配套服务异常退出。".into()) }
                }),
                _ = stop_rx.changed() => {
                    // EOF first: Service owns quiesce, cancellation and resource cleanup.
                    closing_stdin.lock().await.take();
                    match timeout(CLOSE_TIMEOUT, child.wait()).await {
                        Ok(Ok(status)) if status.success() => Ok(()),
                        Ok(_) => Err("配套服务异常退出，请检查任务结果。".into()),
                        Err(_) => {
                            let _ = child.kill().await;
                            Err("服务清理超时，已终止自有进程；任务副作用需要检查。".into())
                        }
                    }
                }
            };
            reader.abort();
            diagnostics.abort();
            closing_stdin.lock().await.take();
            let _ = done_tx.send(Some(result));
        });
        Ok(Self {
            stdin,
            output: Mutex::new(output),
            stop,
            done,
        })
    }

    pub async fn send(&self, frame: String) -> Result<(), String> {
        if frame.len() > MAX_FRAME_BYTES
            || frame.contains(['\n', '\r'])
            || self.done.borrow().is_some()
            || *self.stop.borrow()
        {
            return Err("消息无效或连接已关闭。".into());
        }
        // A single message object, never arbitrary bytes or a shell command.
        let value: serde_json::Value =
            serde_json::from_str(&frame).map_err(|_| "无效的协议消息。")?;
        if !value.is_object() {
            return Err("无效的协议消息。".into());
        }
        let write = async {
            let mut lock = self.stdin.lock().await;
            let pipe = lock.as_mut().ok_or_else(|| "连接已关闭。".to_string())?;
            pipe.write_all(frame.as_bytes())
                .await
                .map_err(|_| "发送结果未知，请检查会话。".to_string())?;
            pipe.write_all(b"\n")
                .await
                .map_err(|_| "发送结果未知，请检查会话。".to_string())?;
            pipe.flush()
                .await
                .map_err(|_| "发送结果未知，请检查会话。".to_string())
        };
        match timeout(Duration::from_secs(5), write).await {
            Ok(Ok(())) => Ok(()),
            other => {
                let _ = self.stop.send(true);
                Err(other
                    .ok()
                    .and_then(Result::err)
                    .unwrap_or_else(|| "发送超时，提交结果未知。".into()))
            }
        }
    }

    pub async fn receive(&self) -> Result<String, String> {
        let mut output = self
            .output
            .try_lock()
            .map_err(|_| "同一连接只能有一个消息消费者。")?;
        let frame = output
            .recv()
            .await
            .ok_or_else(|| "连接已关闭。".to_string())??;
        Ok(frame)
    }

    pub async fn close(&self) -> Result<(), String> {
        let _ = self.stop.send(true);
        let mut done = self.done.clone();
        loop {
            if let Some(result) = done.borrow().clone() {
                return result;
            }
            done.changed()
                .await
                .map_err(|_| "无法确认服务收尾。".to_string())?;
        }
    }
}

/// Reads bytes incrementally; read_until alone would allocate an unbounded line.
async fn read_frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<String>, String> {
    let mut frame = Vec::new();
    loop {
        let bytes = reader.fill_buf().await.map_err(|_| "服务输出读取失败。")?;
        if bytes.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err("服务输出消息被截断。".into())
            };
        }
        let newline = bytes.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(bytes.len(), |position| position + 1);
        if frame.len() + count > MAX_FRAME_BYTES + 2 {
            return Err("服务输出超过协议大小限制。".into());
        }
        frame.extend_from_slice(&bytes[..count]);
        reader.consume(count);
        if newline.is_some() {
            frame.pop();
            if frame.last() == Some(&b'\r') {
                frame.pop();
            }
            if frame.len() > MAX_FRAME_BYTES {
                return Err("服务输出超过协议大小限制。".into());
            }
            return String::from_utf8(frame)
                .map(Some)
                .map_err(|_| "服务输出不是有效 UTF-8。".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn stalled_stdout_consumer_does_not_block_eof_cleanup() {
        use std::{
            fs,
            os::unix::fs::PermissionsExt,
            time::{SystemTime, UNIX_EPOCH},
        };
        let root = std::env::temp_dir().join(format!(
            "kite-stdio-pressure-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let executable = root.join("producer");
        fs::write(&executable, "#!/bin/sh\n/usr/bin/yes '{\"data\":\"pressure\"}' &\nwriter=$!\n/bin/cat >/dev/null\nkill \"$writer\" 2>/dev/null\nwait \"$writer\" 2>/dev/null\nexit 0\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let process =
            ServiceProcess::spawn(&executable, &root, &root, &root, "pressure-test", &[]).unwrap();
        // Do not receive anything: fill the bounded queue and the child's pipe.
        tokio::time::sleep(Duration::from_millis(200)).await;
        let closed = timeout(Duration::from_secs(3), process.close()).await;
        fs::remove_dir_all(root).unwrap();
        assert!(
            matches!(closed, Ok(Ok(()))),
            "stalled output must still close by EOF, without the force-kill deadline"
        );
    }

    #[tokio::test]
    async fn framing_retains_order_and_rejects_partial_or_oversized_lines() {
        let mut input = BufReader::with_capacity(2, &b"{\"a\":1}\r\n{\"b\":2}\n"[..]);
        assert_eq!(read_frame(&mut input).await.unwrap().unwrap(), "{\"a\":1}");
        assert_eq!(read_frame(&mut input).await.unwrap().unwrap(), "{\"b\":2}");
        assert_eq!(read_frame(&mut input).await.unwrap(), None);
        assert!(read_frame(&mut &b"partial"[..]).await.is_err());
        assert!(read_frame(&mut &b"\xff\n"[..]).await.is_err());
        assert!(read_frame(&mut vec![b'x'; MAX_FRAME_BYTES + 3].as_slice())
            .await
            .is_err());
    }
}
