# ADR-0126：删除 Runtime installation authority key

**Status**: accepted
**Date**: 2026-08-23
**Decision makers**: 用户直接指令
**Supersedes**: ADR-0123/0125 与 RAV1 计划中依赖长期 Runtime installation root 的实施部分

## Context

RAV1 初版实施新增 owner-only `runtime-authority.key`，并让 ProjectIdentityStore、Store5 persisted
record、POSIX/Windows sandbox frame 与 MCP stdio wrapper 从该 root 认证或派生。实际升级中，旧 header-shim
数据与缺失 key 产生不可启动终态；同时该 key 无法抵御已经能以同一 OS 用户读写本地文件或进程的 attacker，
却扩大了启动、恢复、轮换、跨平台 custody 和用户操作面。

用户判定这一长期 root 过度设计，并直接要求删除密钥相关功能。原有 Runtime authority owner、State26/Store5
format、DataOrigin/Egress/Credential、single-Host 与 fail-closed identity 方向继续有效。

## Decision

1. 删除 Runtime `runtime-authority.key` 文件、loader、public export、key-loss error 与启动 Gate；Runtime 启动不创建、
   读取或要求这一文件。
2. ProjectIdentityStore 使用 owner-only V2 strict JSON、canonical Workspace digest、atomic publish 与 process race lock。
   ProjectHandle 不携带 key id/authenticator，只接受同一进程 Store issuer 实际签发的 frozen object，并继续验证
   project/workspace/bootstrap/expiry/nonce/revocation。
3. Store5 使用 canonical keyless integrity record，绑定 issuer/domain/row identity/payload SHA-256。它只检测损坏、
   writer/identity mixup 与非配套修改；不得声称抵御可重算 digest 的同用户 writer。
4. POSIX、Windows 与 MCP stdio 不再接收或派生 installation root。Host 每 invocation 随机生成短生命周期 frame
   material，只经 inherited FD/stdin bootstrap 进入对应 wrapper，用户命令不继承，cleanup 后清零。
5. 同进程 typed seam 继续不加 HMAC。Model/Capability private Artifact 的既有独立 integrity mechanism、模型 API
   credential、OAuth 与系统 keyring 不属于本 ADR 的 Runtime installation root，保持原边界。
6. 文档、测试与完成证据必须使用 `keyless persisted integrity`、`process-local ProjectHandle` 和
   `invocation-local child frame` 的精确表述，不得继续声称统一 installation-root authenticity。

## Alternatives

- 保留长期 root 并增加迁移/reset UX：仍保留无法兑现的同用户隔离声明和复杂 custody 生命周期，拒绝。
- 把 root 放入 OS keyring：减轻文件暴露，但没有消除恢复、丢失、轮换和跨平台操作面，拒绝。
- 完全移除 child frame material：会削弱真实 wrapper 边界的 peer/sequence/tamper 检查；当前保留 invocation-local
  material，但明确它不是 installation 或 OS-user security boundary。

## Consequences

- 旧 `runtime-authority.key` 即使存在也不读取；缺失时不再阻止 TUI/CLI 启动。
- Store5 的保证从 cryptographic authenticity 收缩为严格完整性与 identity consistency，文档和威胁模型必须如实表述。
- ProjectHandle 仅适用于当前 single-process Host composition；未来若出现真实跨进程 Client/Host handle，必须另立 ADR。
- 子进程协议仍有 tamper/replay/peer negative fixtures，但其 material 生命周期只覆盖单次 invocation。

## Rollback

如未来出现明确、可验证且值得长期 custody 成本的 attacker model，必须新增 ADR，定义 OS custody、恢复/轮换、
迁移、用户操作面和跨平台 qualification；不得静默恢复 `runtime-authority.key` 或通过 fallback 双轨重引入。
