# Kite Runtime Authority & Format V1 实施方案

状态：active

日期：2026-08-20

优先级：P0

父 RFC：[`Kite Runtime Modularization V1 RFC`](../../design/2026-08-19-kite-runtime-modularization-v1-rfc.md)

分期决策：[`ADR-0124`](../../adr/0124-runtime-modularization-staged-delivery.md)

RFC 修订：[`ADR-0125`](../../adr/0125-accepted-rfc-staged-revision.md)

前置计划：[`Kite Runtime Modularization V1`](2026-08-19-kite-runtime-modularization-v1-implementation.md)

Implementation baseline：`e5a64c212a3e6a5207b00ed6e7f220c899cd7663`

RMV1 完成证据：[`2026-08-22-rmv1-16-static-domain-reducers-legacy-closure.md`](../execution/completed/2026-08-22-rmv1-16-static-domain-reducers-legacy-closure.md)

RAV1-00 完成证据：[`2026-08-22-rav1-00-authority-threat-model.md`](../execution/completed/2026-08-22-rav1-00-authority-threat-model.md)

目标 Runtime State schema：`26`

目标 Runtime Store schema：`5`

目标 epoch：`kite-runtime-modularization-v1-2026-08-19`

> RMV1 已完成，Legacy owner 已清零，State 25/Store 4/当前 epoch 的稳定模块化 Runtime 已由上列 final SHA 与完成记录固定；本计划前置依赖已解除。它升级 authority、identity、cross-Host coordination 与持久格式，不重新拆 package、不恢复中央 executor。

## 1. 目标与边界

RAV1 在稳定的 Contract/Host/Kernel/SPI/Storage/Builtin 边界上实施：

1. ProjectIdentityStore 与 Host-issued ProjectHandle；
2. 分层的 Session/Environment/Provider/Credential/Artifact identity；
3. execution boundary 上的 Grant/Receipt authenticity、single-use 与 revocation；
4. DataOrigin、Egress 与 Credential authority；
5. Project-scoped cross-Host resource fencing；
6. approval前execution environment projection与无post-approval handler fallback；
7. State 26、Store 5 与新 epoch；
8. 旧 Session fail-closed cutover 与正式 reliability qualification。

### 1.1 非目标

- 不重新安排 RMV1 package ownership；
- 不建设公开 Plugin ABI、Runtime Server、多租户或在线 Session migration；
- 不让 Runtime Host重新拥有 Prompt/Skill/Model Context领域语义；
- 不用单一全局 composition digest绑定所有无关 operation；
- 不用进程内 HMAC声称隔离可信 builtin恶意代码；
- 不以人工 reviewer签署作为Gate。

## 2. 前置准入

RAV1-00 启动前必须机械确认：

- RMV1 状态为 `completed`，completion record绑定 final SHA；
- 六包与 `apps/kite` graph闭合，LegacyRuntimeAccess/LegacyRuntimeModule/central executor不可达；
- State 25、Store 4、当前epoch和旧Session restore仍为production truth；
- Host只拥有通用机制，Context/Prompt等领域语义在builtin-runtime；
- operation owner/delete manifest无 `legacy-owned`；
- 产品 journey、State 25 restore/Event replay、fault、CI soak、docs gates通过。

任一条件不满足，RAV1保持blocked。

## 3. Authority trust model

### 3.1 可信与非可信边界

```text
trusted in-process:
  Kernel / Host / builtin-runtime

authenticated execution boundary:
  persisted command/effect record
  child process / sandbox worker
  MCP/network endpoint
  future out-of-process worker（若在RAV1范围内明确启用）
```

内部 builtin调用继续使用类型严格的 `AuthorizedEffect`。Cryptographic seal只用于真实序列化/持久化/进程外边界，不能把package export包装成虚假的进程内安全隔离。

RAV1-00 必须先冻结 threat model、attacker、key custody、serialization boundary与真实性根；没有真实边界的对象不得为“形式统一”增加HMAC。

### 3.2 Authority sequence

```text
Proposal
  -> Kernel Intent / RequiredAuthority
  -> Policy / approval decision
  -> Host durable grant record
  -> exact execution-boundary materialization
  -> attempt/fence acknowledgement
  -> external dispatch
  -> authenticated/bounded receipt
  -> Mailbox
  -> Kernel receipt acceptance / evidence / recovery / completion
```

Host不能扩大RequiredAuthority，Builtin不能自签授权，Receipt不能直接制造Kernel fact。

## 4. 分层 Identity

RAV1 不采用一个包含所有配置的 monolithic composition digest。

### 4.1 SessionCompositionIdentity

只包含会改变整个Session决策语义的事实：

```text
runtime format epoch
state/store schema
kernel revision
policy revision
project identity
capability catalog revision
```

### 4.2 ExecutionEnvironmentIdentity

```text
platform qualification
sandbox/backend/profile
network policy
protected-path revision
canonical workspace/worktree
```

### 4.3 ProviderBindingIdentity

```text
provider/executor/capability revision
endpoint or model route
request/schema digest
transport boundary
```

### 4.4 CredentialGrantIdentity

```text
project/provider/server/profile
purpose
expiry/revocation
credential handle identity
```

### 4.5 ArtifactNamespaceIdentity

```text
key id
namespace/schema
owner project/session/work/invocation
retention policy
```

每个Effect只绑定实际相关identity。MCP配置变化不能无条件作废纯本地Filesystem read；Model route变化不能作废Sandbox cleanup；Artifact key rotation按Artifact policy处理。Session-wide mismatch、effect-local mismatch与recoverable revision change必须分别定义。

## 5. Project Identity

ProjectIdentityStore是安装级、owner-only authority，根据canonical Workspace生成opaque project identity。Client不能提交任意projectId。

ProjectHandle至少绑定：installation identity、project identity/revision、canonical Workspace digest、bootstrap identity、issued/expiry、nonce和authenticator。Handle只用于CreateSession identity resolution，不代表execution authorization。

必须定义：atomic resolve-or-create、two-process race、Workspace move、revoke、corruption、key loss、installation reset和stale handle。Store/handle exact schema与canonical vectors在RAV1-01冻结，不在RMV1预生成。

## 6. Grant、Receipt 与 authenticity

RAV1-02 根据RAV1-00 threat model区分：

- in-process `AuthorizedEffect`：typed schema、identity equality、single-use CAS、expiry/revoke；
- persisted grant/receipt：canonical codec、unknown-field rejection、integrity/authenticity evidence；
- out-of-process request/receipt：issuer/verifier、domain separation、replay protection和bounded payload。

如使用RFC 8785/HMAC，必须定义key issuer/custody/rotation、domain、canonical test vectors、duplicate-key parser策略和failure mode；不能对已经是typed object的同进程调用重复JSON序列化只为制造seal。

Grant consumption、attempt ack、fence validation和dispatch顺序固定；receipt identity/authenticity mismatch不能进入Kernel。

Execution environment必须在approval前进入RequiredAuthority。选择`native`后发生unavailable时返回typed failure，不在approval后自动切`host_shell`；`host_shell`只有作为独立展示、独立ceiling、独立grant的预选environment才可执行。

## 7. DataOrigin、Egress 与 Credential

DataOrigin必须从Observation Receipt贯穿Artifact、Context Fragment、Model/MCP payload和egress receipt。summary/truncation/compaction使用deny-wins join，不能降低classification或丢失parent owner。

Egress authority由Kernel决定，ContextCompiler只选择payload，Host只materialize。Model provider与remote MCP是独立destination/nonce namespace；当前仓库不存在 evaluator destination，后续评测若重建必须另立计划、identity 与授权边界，不能复用任一现有 namespace。

Credential authority与network/filesystem分离。Provider只获得purpose-bound handle，通过受控broker使用；secret不能进入Grant/Receipt/Event/Notification/log。

RAV1-03 必须先保持现有MCP/Model/Sandbox行为，再逐operation切换，禁止一次替换全部egress path。

## 8. Project Resource Fence

RAV1-04 先验证真实需求：多个Host/process/checkpoint是否可以对同一Project/Workspace并发dispatch。若产品仍严格single-Host，必须把single-Host invariant写入bootstrap和Gate，不为假想并发引入双数据库协议。

启用multi-Host时，使用安装级ProjectResourceFenceStore：

- key绑定project/workspace/resource scope；
- monotonic fencing token、owner process-start identity、lease、dispatch/cleanup certainty；
- Session attempt ack记录同一token；
- dispatch前revalidate；
- unknown cleanup保持global hard block；
- Fork/Rewind/successor和另一Host必须查询同一authority。

cross-store crash window使用fail-closed顺序和double-Host fixture验证，不声称SQLite双库伪原子。

## 9. Store 5 与 State 26

RAV1-05才设计并实现target格式。

必须生成：

- State 25 -> State 26逐字段mapping；
- Event/Envelope codec mapping；
- Store 4 -> Store 5逐表/列/index/constraint manifest；
- Store 5 exact DDL与transaction ownership；
- old/new path derivation、permissions、no-follow、corruption/key-loss fixtures；
- Artifact namespace/reachability/GC与egress nonce/fence tables；
- schema/epoch/composition fail-closed preflight。

Target path与旧v4数据库独立。不双写、不在线migration、不读取旧Session。Store 5在cutover前只允许isolated conformance constructor；production bootstrap不可达。

## 10. 阶段拓扑

```text
RAV1-00 Authority contract / threat model
   |
RAV1-01 Project + layered identities
   |
RAV1-02 Grant/Receipt authenticity
   |
RAV1-03 DataOrigin/Egress/Credential
   |
RAV1-04 Project resource fencing
   |
RAV1-05 State 26 / Store 5
   |
RAV1-06 New epoch cutover
```

每阶段都是自动stop-and-report Gate。

## 11. Task Matrix

| Task | 状态 | dependsOn | 产出 | Gate |
| --- | --- | --- | --- | --- |
| RAV1-00 | completed | RMV1 completed | threat model、authority schema、real boundary inventory | [boundary/attacker/key custody fixtures passed](../execution/completed/2026-08-22-rav1-00-authority-threat-model.md) |
| RAV1-01 | completed | RAV1-00 | ProjectIdentityStore、Host-issued ProjectHandle、layered identity schemas | race/move/mismatch/canonical vectors passed；见 RAV1-01 completion record |
| RAV1-02 | pending | RAV1-01 | typed vs persisted vs out-of-process grant/receipt | consume/revoke/replay/authenticity/zero-call |
| RAV1-03 | pending | RAV1-02 | DataOrigin/Egress/Credential IR与逐operation迁移 | Model/MCP/secret/nonce negative matrix |
| RAV1-04 | pending | RAV1-03 | single-Host invariant或ProjectResourceFenceStore | double-Host/crash/fork/cleanup fixtures |
| RAV1-05 | pending | RAV1-04 | State 26、Store 5 isolated adapter、new path | DDL/state/event/storage conformance |
| RAV1-06 | pending | RAV1-05 | target epoch首次production、旧格式fail-closed | full journey/replay/fault/formal qualification/docs |

## 12. Cutover

RAV1-06 cutover顺序：

1. 停止接受新command并settle旧v4 active work；unknown cleanup/fence存在则停止；
2. 关闭v4 writer并生成owner-only source digest evidence；
3. target bootstrap首次允许创建State 26/Store 5/new epoch Session；
4. 旧Session返回typed `incompatible_runtime_format`，不rename/import/migrate；
5. 任意identity/schema/epoch mismatch在Kernel或external dispatch前失败；
6. 删除target constructor的conformance-only guard和所有authority compatibility adapter；
7. 更新全部相关active文档和completion evidence。

Required验证包括full tests、TUI/CLI journeys、State 26/Store 5产品 restore/replay、fault、CI soak以及受信GitHub Actions正式qualification。旧 evaluation 已移除，不得把其脚本或证据作为本阶段 Gate；`test:runtime:soak --profile=ci`不能替代7 case × 8 measured rerun与verifier。

回滚必须完全停止target binary后显式恢复RMV1 final binary和旧v4 DB；v5 Session不导回v4。

## 13. 完成定义

1. Project identity和layered identities精确、最小关联并通过negative fixtures；
2. Grant/Receipt authenticity只部署在真实边界，in-process trust model没有虚假密码学隔离声明；
3. DataOrigin/Egress/Credential逐operation迁移且无双owner；
4. single-Host invariant或ProjectResourceFenceStore有唯一、可验证authority；
5. State 26、Store 5和新epoch为唯一新Session格式，旧DB不被target binary修改；
6. full journey、State 26/Store 5产品 restore/replay、fault、formal qualification与docs gates通过；
7. RMV1 package/owner边界没有被RAV1反向侵蚀。
