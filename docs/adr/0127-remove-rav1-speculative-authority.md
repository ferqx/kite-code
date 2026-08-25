# ADR-0127：删除 RAV1 推测性 authority 机制

**Status**: accepted
**Date**: 2026-08-23
**Decision makers**: 用户直接指令
**Supersedes**: ADR-0126，以及 ADR-0123/0125、RAV1 计划中关于 ProjectHandle、single-Host 全局锁、内部 HMAC、DataOrigin/EgressAuthority ledger 与固定 Provider 数据策略的实施部分

## Context

RAV1 的早期实现把未来可能存在的多 Host、恶意同用户本地 writer、跨进程身份签发和内容外发审批，提前实现成安装级 identity store、全局 Host lock、子进程密钥 bootstrap、Artifact HMAC、持久 authority ledger、Remote MCP permit 与 release-pinned Provider policy。

当前产品没有这些独立信任域：App、Host、Kernel 与 Builtin 在同一可信进程中；sandbox/MCP wrapper 由 Host 创建并通过专用 OS 管道通信；本地 Store 和 private Artifact 只要求当前格式、损坏检测、路径安全与严格 schema；远端 HTTP 的真实安全边界是 endpoint/TLS/OAuth；模型路由由用户配置。上述机制没有提供与其复杂度相称的安全保证，反而引入不可恢复启动错误、额外状态、跨平台协议风险和第二 authority owner。

用户明确裁决这些功能属于过度设计并要求全部移除。

## Decision

1. Project identity 仅为 canonical Workspace 的确定性标识。删除持久 `ProjectIdentityStore`、`ProjectHandle`、installation/revision/expiry/nonce 生命周期，以及 CreateSession 的 handle 输入。
2. 删除进程级 single-Host 全局锁。当前 composition 保持一个 App-owned Host/Store owner，但多个独立 Kite 进程可以各自打开不同 Workspace/Session；真实 SQLite writer 冲突由数据库事务与 revision/lease CAS 处理。
3. 删除所有为内部 Runtime 设计的 secret key、key file、key bootstrap、HMAC 与 authenticator。POSIX、Windows 和 MCP stdio 使用严格、长度有界的 `RuntimeControlFrameV1`，绑定 domain、peer、invocation 与单调 sequence；peer/process 真实性来自 Host 创建的专用管道、继承句柄和进程/Job supervision，而不是自制密码协议。
4. Private Artifact 使用 canonical bytes 的 SHA-256 内容寻址与完整性标识、owner-only 文件权限、no-follow、atomic publish 和严格回读；不创建或加载 installation Artifact key，不声称抵御能够重写文件并重算 digest 的同用户 attacker。
5. Store5 只保存 State26 的严格 Event、Snapshot、Session、named snapshot、preimage 与 effect lease 数据。事件使用 canonical JSON，snapshot 使用 checksum；删除 persisted authority codec、DataOrigin/EgressAuthority/receipt ledger 和 MCP egress nonce 表。目标 schema 固定为 7 tables / 2 indexes。
6. 删除通用 `DataOrigin`、`EgressAuthority`、Remote MCP egress permit/receipt 和相关 feature flag。Builtin MCP Manager 是一次 MCP operation 的唯一协议 owner；remote HTTP 调用只做边界/endpoint admission、JSON-safe bounded argument 检查和真实 credential materialization，不建立第二套内容外发协议。
7. 删除 release-pinned Provider allowlist 和 `providerDataPolicyV1`。五类模型调用统一经过 Gateway 的 configured-provider admission：composition 必须存在，credential-shaped content 必须拒绝，route/transport 仍由用户的 resolved configuration 与真实 Provider auth 决定。
8. OAuth/API token 等真实外部 credential 仍由共享 CredentialBroker/OS keyring 在使用点物化。它们是产品连接外部服务所必需的秘密，不属于被删除的内部 Runtime key 设计。
9. State26/Store5/new epoch、严格 codec、单写 owner、无旧格式 fallback、sandbox cleanup、attempt acknowledgement、revision/effect lease、credential redaction 等已兑现的不变量继续保留。

## Consequences

- TUI/CLI 启动不创建、读取或等待任何 Runtime/Artifact installation key，也不会因 key loss 或另一个 Kite 进程存在而出现不可恢复启动错误。
- Control frame 能发现格式、identity、peer、sequence、replay 和长度错误，但不声称提供密码学 authenticity。
- Store/Artifact checksum 能发现意外损坏与 identity mixup，但不是同用户攻击者的真实性证明。
- 文档、测试、manifest 和完成证据不得再把已删除的名称、表、flag、permit 或 key custody 描述为当前 production 行为。
- 如未来出现真实独立 Host、远端签名协议或受监管数据外发需求，必须基于可验证威胁模型新增 ADR；不得通过 compatibility path 恢复本决定删除的机制。

## Verification

- production source 中无 `runtime-authority.key`、installation key、ProjectHandle/ProjectIdentityStore、AuthorityKey/HMAC/authenticator、DataOrigin/EgressAuthority、RemoteMcpEgress 或 `providerDataPolicyV1` caller；仅允许负向测试证明这些文件/入口不会出现。
- `RuntimeControlFrameV1` 的 wrong peer/invocation、replay、unknown/truncated/oversized 与 pre-ready zero-dispatch fixtures通过。
- Store5 exact schema 为 7 tables / 2 indexes，State26/new epoch manifest 可重现，旧 Store4 path bytes 不被读取或修改。
- 全仓 default、完整 TUI system、fault/soak、跨平台 native 和最终 SHA qualification 全部通过。
