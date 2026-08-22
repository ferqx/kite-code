# Runtime Authority Boundary 与 Threat Model

状态：active

读取时机：修改 Runtime authority、identity、Grant/Receipt、持久化真实性、子进程协议、Model/MCP transport、Credential broker、Mailbox receipt 或 RAV1 State/Store cutover 时。

验证：`bun test packages/runtime-spi/test/authority-threat-model.test.ts tests/reliability-harness/runtime-authority/rav1-00-authority-contract.test.ts`、`bun run --cwd packages/runtime-spi typecheck`、`bun run check:runtime-packages`、`bun run check:docs-impact`、`bun run check:docs`。

相关：accepted Runtime Modularization RFC、ADR-0123/0124/0125、`2026-08-20-kite-runtime-authority-format-v1-implementation.md`。

## 1. 冻结范围

RAV1-00 只冻结 authority sequence、可信域、attacker classes、真实 serialization/execution boundary、key custody 现状与后续真实性处置。它不签发 Grant、不验证 Receipt、不选择密码算法、不改变 production dispatch，也不提前创建 ProjectIdentity、State 26、Store 5 或新 epoch。

当前同进程可信域严格为 Agent Kernel、Runtime Host 与 Builtin Runtime。App 是唯一 composition root，但不是可自行扩大 authority 的可信签发者；Client input、持久化 bytes、子进程输出、远端 endpoint 与本机同用户可改写状态均按边界输入重新验证。

恶意的同进程 Kernel/Host/Builtin、已攻陷 OS/Kernel 与任意读取进程内存不属于 V1 attacker model。Package/export/WeakSet/HMAC 都不能对这些 attacker 提供隔离，文档和测试不得声称可以。

## 2. Authority sequence

唯一顺序为：

```text
Proposal
  -> Kernel Intent
  -> Required Authority
  -> Policy / approval decision
  -> durable Grant record
  -> exact execution materialization
  -> attempt acknowledgement
  -> external dispatch
  -> bounded Receipt
  -> validated Mailbox fact
  -> Kernel Receipt acceptance
```

Kernel 只拥有纯 Intent、RequiredAuthority、Policy/approval、Receipt acceptance 与后续 recovery/completion decision；Host 只持久化、精确物化、claim、监督、验证边界 Receipt 并投递 Mailbox fact；Builtin 只提供具体 operation 语义，不能自签或扩大 RequiredAuthority。Notification、日志、模型文字与 Provider success 都不是 Kernel fact。

## 3. 真实边界清单

机械事实源是 `tests/reliability-harness/runtime-authority/rav1-00-boundary-inventory.ts`；SPI contract 与纯 validator 位于 `packages/runtime-spi/src/authority-threat-model.ts`。

| Boundary | Carrier | 当前真实性根 | RAV1 裁决 |
| --- | --- | --- | --- |
| Client Command | 同进程 typed input | Contract schema、command/session/revision identity | 不加 HMAC；始终视为 proposal/input，不是 authority |
| Kernel/Host/Builtin typed authority | 同进程 typed object | exact identity、freeze、process-local single-use/CAS | 不加 HMAC；恶意同进程代码不在威胁模型 |
| Runtime Store records | 持久序列化 | State25 codec、marker、checksum、revision/lease/nonce CAS；不是密码学真实性 | RAV1-02 为持久 grant/receipt/effect 定义 authenticated envelope；target DDL 到 RAV1-05 |
| Private Artifact files | 持久序列化 | installation owner-only 32-byte key、domain-separated HMAC、no-follow、fsync、atomic publish | 保留单层 HMAC；RAV1-02 补 key id、domain vectors、rotation/key-loss 规则，不重复包裹 |
| POSIX sandbox control | 子进程 JSON line protocol | inherited lock、nonce/digest、PID/PGID/process-start identity；frame 无 authenticator | RAV1-02 必须选择可验证 OS peer/FD 根或 domain-separated frame authenticator |
| Windows sandbox runner | 子进程 length-prefixed JSON | exact shape、invocation/process/Job identity；frame 无 authenticator | 与 POSIX 同级处理，禁止仅凭结构合法接受 terminal receipt |
| Filesystem/process effect | 外部 OS resource | exact path/process identity、grant/evidence、no-follow、supervision | 不是消息 seal 问题；由 Intent/Grant/Observation/Receipt 约束 |
| MCP HTTP transport | 远端协议 | endpoint/boundary identity、TLS/OAuth、nonce/digest | 不对同进程 SDK DTO 加 HMAC；持久 authority receipt 必须认证，远端签名只在协议支持时采用 |
| MCP stdio transport | 子进程协议 | process/endpoint/revision identity；无统一 peer authenticator | RAV1-02 明确 peer/message 根，不复用 HTTP namespace |
| Model Provider transport | 远端协议 | route/surface identity、Provider TLS/auth；response Artifact 已 HMAC | 不对同进程 response DTO 重复 seal；持久 surface/response 沿用 Artifact 边界 |
| Credential vault | OS broker 持久边界 | OS keyring、opaque account digest、OAuth state/PKCE | secret 只留在 broker；RAV1-03 建 purpose-bound handle/receipt，不在 Grant/Event/日志携带 secret |
| Client Notification | 非权威同进程 projection | stream/session/revision continuity | 不是 authority，不加 HMAC，不能回流成 Receipt 或 Kernel fact |

## 4. Attacker classes

必须覆盖：不可信 Client input、本机同用户对持久文件的结构合法篡改、stale/replayed record、不可信 sandbox/MCP 子进程、不可信远端 endpoint、identity mixup 或可信代码错误、clock rollback，以及 cross-Host/process race。

所有 authority carrier 都固定 `secretMaterialAllowed=false`。Credential requirement、grant 与 receipt 只能携带 opaque handle、purpose、expiry、revocation 与无正文 evidence；secret 不得进入 State、Event、Receipt、Notification 或日志。

## 5. Key custody 与真实性处置

- 同进程 typed seam 的 key custody 固定为 `none`；对它加 HMAC 是虚假安全边界。
- Runtime Store persisted authority 与 POSIX/Windows/MCP-stdio process protocol 的具体 issuer、key/domain/canonical bytes/rotation/revocation由 RAV1-02 冻结，RAV1-00 只登记 `deferred_rav1_02`。
- Private Artifact 继续使用 installation owner-only key；缺 key且已有 evidence 时 fail closed，不能静默生成新 identity。
- Credential material 继续由 OS vault 保管；App 不复制 secret，provider 只经受控 broker 使用 purpose-bound handle。
- HTTP Model/MCP transport 依赖实际 transport/endpoint authentication；不能用本地 HMAC 假装认证远端未签名响应。

## 6. 后续 Gate

RAV1-01 已增加 ProjectIdentityStore、Host-issued ProjectHandle 与分层 identity schema。Project identity 按 canonical workspace digest 解析，安装级 store 使用原子临时文件发布与 lock directory 串行化 resolve-or-create；handle 绑定 installation、project/revision、workspace digest、bootstrap、时间窗、nonce 与 authenticator，但不代表 execution authorization。Workspace move、篡改/stale handle、两实例 race 均 fail closed 或收敛到同一 project identity。各层仍独立绑定，未引入 monolithic digest。

RAV1-02 已冻结并实现 persisted envelope 与 child-frame authenticity contract：envelope/frame 使用不同 domain-separated HMAC namespace，绑定 issuer/keyId、project-independent nonce/invocation identity、expiry 或 monotonic sequence；Host 提供 single-use nonce 与 revocation registry。unknown field、wrong domain/key/issuer、expiry/revoke/replay、tamper、cross-invocation fixtures 已通过。该阶段仍不对同进程 typed seam 加 HMAC。

RAV1-03 已增加 DataOrigin、deny-wins classification join、destination-specific EgressAuthority 与 opaque CredentialHandle contract。Builtin context fragments now carry observation-backed origins into compiled payloads；Model 与 MCP destination 使用独立 route/nonce namespace，CredentialHandle 不包含 secret。RAV1-04 才裁决 single-Host invariant 或真实 Project fence，RAV1-05/06 才建立并切换 State26/Store5/new epoch。

RAV1-04 已裁决当前产品不存在真实 multi-Host 同 Project 并发 dispatch authority；bootstrap 机械强制 single-Host invariant。Runtime Host 以 owner-only lock directory 作为唯一 lease，第二 Host、stale owner 与 owner mismatch 均 fail closed，不引入 ProjectResourceFenceStore 或假想 cross-store 原子协议。
