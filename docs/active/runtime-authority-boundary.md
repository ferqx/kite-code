# Runtime Authority Boundary 与 Threat Model

状态：active

读取时机：修改 Runtime authority、identity、Grant/Receipt、持久化、子进程协议、Model/MCP transport、Credential broker 或 State26/Store5 时。

验证：`bun test packages/runtime-host/test/control-frame.test.ts packages/runtime-host/test/mcp-stdio-process.test.ts tests/execution/posix-supervisor.test.ts tests/sandbox/windows-restricted-token.test.ts packages/runtime-storage-sqlite/test/store-conformance.test.ts apps/kite/test/keyless-runtime-cutover.test.ts`、`bun run typecheck`、`bun run check:runtime-packages`、`bun run check:docs-impact`、`bun run check:docs`。

相关：ADR-0123/0124/0125、ADR-0127。

## 当前可信域

Agent Kernel、Runtime Host、Builtin Runtime 与 App composition 位于同一可信进程。Package/export、对象 checksum 或 HMAC 不能隔离同一进程中的恶意代码，因此同进程 typed seam 不使用 secret-key authenticity。Client input、磁盘 bytes、子进程输出、远端 endpoint 和 OS resource identity仍在各自真实边界重新验证。

当前不建立持久 Project authority。Project identity 是 canonical Workspace 的确定性标识；Session 创建只接受 Workspace/Session facts。不存在 `ProjectIdentityStore`、`ProjectHandle`、installation revision/nonce/expiry，也不存在进程级 single-Host 全局锁。App 仍是唯一 composition root，Host/Store operation 仍各有一个 production owner。

## Authority sequence

```text
Proposal
  -> Kernel Intent
  -> Policy / user approval
  -> exact prepared operation
  -> durable attempt acknowledgement
  -> external dispatch
  -> bounded result / cleanup fact
  -> Kernel acceptance and recovery decision
```

Kernel 只拥有纯 Intent、Policy/approval、result acceptance 与 recovery/completion decision；Host 负责持久化、claim、supervision、transaction/revision fencing 和 Mailbox；Builtin 负责具体 Model/Tool/MCP/Sandbox 语义。Notification、日志、模型文字和 transport success 不能回流成 Kernel fact。

## 真实边界

| Boundary | 当前机制 | 明确不提供的保证 |
| --- | --- | --- |
| 同进程 command/grant/receipt | strict schema、exact identity、freeze、TTL、single-use、revision/CAS | 不使用 secret key；不抵御恶意同进程代码 |
| Store5 | State26 exact codec、Store5 marker、canonical event JSON、snapshot checksum、transaction/revision/effect lease | checksum 不是同用户 writer authenticity |
| Private Artifact | SHA-256 内容寻址、canonical schema、owner-only/no-follow、atomic publish、严格回读 | 不创建 installation key；digest 可被有写权限者重算 |
| POSIX/Windows sandbox | Host 创建的专用 pipe/handle、PID/PGID/Job/process identity、strict bounded control frame、peer/invocation/sequence | 不传 secret，不使用 HMAC，不声称消息层 OS-user isolation |
| MCP stdio | Host-owned wrapper/process port、固定 command/args/cwd、显式 env、bounded JSON-RPC、ready/terminal control frame | MCP initialize 不是 authority；Builtin 不直接 spawn |
| MCP HTTP | exact endpoint/boundary、TLS、OAuth/bearer credential、bounded argument inspection | 不增加本地 content-egress permit 或伪远端签名 |
| Model Provider | resolved route/surface identity、configured-provider admission、Provider TLS/auth、single-attempt transport | 不使用 release-pinned route allowlist 或 DataOrigin/EgressAuthority |
| Credential | shared CredentialBroker、OS keyring、purpose-bound opaque handle、使用点物化 | secret 不进入 Event/State/Receipt/Notification/log |
| Filesystem/process effect | exact path/process identity、no-follow、prepared operation、native sandbox、cleanup evidence | 不是消息 seal 问题 |

## Control frame

`RuntimeControlFrameV1` 是严格结构化的进程控制协议，不是密码学 envelope。它固定 schema、domain、peerId、invocationId、单调 sequence 与 exact payload；unknown field、wrong peer/invocation、replay、truncated/oversized/noncanonical payload 都 fail closed。POSIX 与 MCP stdio 通过继承 FD/专用 stdin 建立 wrapper channel；Windows 使用 runner control stdin/stdout 与 Job/process handles。实际用户命令不继承 Host control channel。

ready 只在 wrapper/runner 验证 control frame 且即将启动 exact child 前产生；Host 验证 ready，并完成 durable acknowledgement 后才进入 GO。pre-ready 失败必须保持 user process dispatch 为 0；terminal/cleanup unknown 不允许自动重放或切换另一 owner。

## Store5 与 Artifact

新 Session 只使用 State26、Store5、`.runtime-state26-store5.db` 和 epoch `kite-runtime-modularization-v1-2026-08-19`。Store5 当前 exact schema 是 7 tables / 2 indexes；没有 persisted authority codec、`authority_envelope`、DataOrigin/EgressAuthority/egress nonce ledger。Event 是 strict canonical JSON，Snapshot 以 SHA-256 checksum 检测损坏。打开数据库会只读预检所有可达 Session/Event/Snapshot；invalid/corrupt/old-format 不能作为 fresh。

旧 Store4 使用独立路径，只供显式测试 fixture 验证不迁移、不读取、不修改；production package 不导出旧 constructor/path。没有 try-new-catch-old、双写或 mixed-format normalization。

Private Artifact 以 canonical bytes 的 SHA-256 内容寻址并返回 path-free ref。文件权限、no-follow、atomic rename、fsync、schema readback 与 Runtime receipt identity 共同检测损坏和混淆；不存在 `model-artifacts.key`、key loss 终态或无 Artifact dispatch fallback。

## 删除的推测性机制

以下名称不属于 production contract：Runtime/Artifact installation key、AuthorityKey/bootstrap/HMAC/authenticator、ProjectHandle/ProjectIdentityStore、single-Host global lock、persisted authority envelope、DataOrigin、EgressAuthority、Remote MCP permit/receipt、`providerDataPolicyV1` 与固定 Provider route policy。负向测试可引用旧文件名以证明它不会被创建，但不得恢复实现或 public export。

真实 API key、OAuth token 和系统 keyring credential 不在删除范围内；它们只用于连接外部服务，并必须通过共享 CredentialBroker 在使用点短暂物化。
