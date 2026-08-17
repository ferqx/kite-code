# Private immutable Artifact storage

状态：active

读取时机：修改 `PrivateImmutableArtifactStorageV1`、`ModelArtifactStoreV1`、`CapabilityArtifactStore`、
`FilesystemPreimageArtifactStoreV1`、`SandboxPreparationArtifactStoreV1`、Subagent task request/task/
continuation/lifecycle Artifact、模型或工具 evidence Artifact 的路径、权限、完整性 key、并发发布、retention 或 GC 时。

验证：`bun test tests/private-immutable-artifacts.test.ts tests/model-artifacts.test.ts tests/model-artifact-key.test.ts tests/model-invocation-gateway.test.ts tests/model-invocation-recovery.test.ts tests/model-surface.test.ts tests/runtime/capability-artifacts.test.ts tests/execution/workspace-filesystem-provider.test.ts tests/execution/sandbox-execution-provider.test.ts`、
`bun test tests/subagent-artifacts.test.ts tests/subagent-provider.test.ts tests/runtime/model-controller-failures.test.ts tests/runtime/tool-controller.test.ts`、
`bun run typecheck`、`bun run check:core-boundary`。

相关：ADR-0056、ADR-0109、ADR-0110、`model-provider-boundary.md`、
`docs/space/plans/2026-08-16-trustworthy-runtime-convergence.md`。

## 当前边界

`src/core/persistence/private-immutable-artifacts.ts` 是私有、不可变、内容寻址 Artifact 的共享安全原语；
`ModelArtifactStoreV1` 已由 production `ModelInvocationGatewayV1` composition 使用。Model store
使用独立的 `~/.kite-code/model-artifacts/` root 与三个内容 schema 分区：

```text
model-artifacts/
  surfaces/<opaqueArtifactId>.json
  responses/<opaqueArtifactId>.json
  provider-options/<opaqueArtifactId>.json
```

`ModelSurfaceV1`、`ModelResponseRecordV1` 与大尺寸 canonical Provider options 在写入和读取时都重新
验证严格 canonical JSON 与对应 schema。单个 Model Artifact 当前上限为 16 MiB。store 不接受或持久化
credential；Provider options 仍先经过 Model Surface canonicalizer 的 secret/endpoint exclusion。

TP-03 已让 `CapabilityArtifactStore` 复用同一个 private immutable storage primitive，但保持独立的
`~/.kite-code/capability-artifacts/results/` namespace、`capability_result` schema、ref 类型和访问策略。
新写入正文为严格 canonical 的 Artifact format v2，公开引用只使用 keyed opaque ID 与 keyed integrity
identifier；Capability store 不进入 Model 分区，也不能把 Model ref 当作 Capability receipt。当前 epoch
只为既有 format v1 Capability Artifact 保留受限的 read-only reader；新写入、dispatch receipt 与 Runtime
Event 永远只产生 v2 private ref，不存在向 legacy writer 或无 Artifact success 的 fallback。

PS-01 新增独立 `~/.kite-code/filesystem-preimages/preimages/` namespace。它复用同一 private immutable
storage primitive 与 installation integrity key，但使用独立 `filesystem_preimage` kind/domain、严格
canonical format v1 payload 和 opaque `FilesystemPreimageArtifactRefV1`。payload 绑定 invocation、operation
digest、target identity digest 与完整 preimage；ref 仍只有 keyed opaque ID、kind、keyed integrity identifier
和 byte length，不暴露路径或 raw digest。该 store 不进入 Model/Capability 分区，也不复用 Session Logger。

Tool Pipeline 只有在 `prepareMutation` 零写入返回后才发布 preimage Artifact；Artifact publish 失败、key
不可用、正文不规范或 `capability.filesystem_mutation_ready` durable ack 不精确匹配时，不签发 commit grant。
旧 Runtime file checkpoint 可作为 rewind 的 best-effort 次级投影，但其成功或失败都不授权 commit。
preimage 正文、filesystem grant 与 filesystem intent/ready 的原始路径永不进入 Runtime Event、Session
Logger 或 remote observability；Runtime 在 ready 中只保存 opaque ref 和 digest identity。既有 Tool Call
arguments/result metadata 可保留模型已见路径，但不授权 Artifact 读取或 Provider commit。该加法不改变
Runtime format epoch。

PS-02 新增独立 `~/.kite-code/sandbox-preparations/plans/` namespace、`sandbox_preparation` kind 与
`SandboxPreparationArtifactRefV1`。allocating Local sandbox prepare 返回后，Pipeline 先把 data-first plan、
backend evidence 和 cleanup recovery payload 写成严格 canonical private Artifact，再以
`capability.sandbox_preparation_ready` durable event 绑定 opaque ref、plan/cleanup/command/preparation digest；
ready ack 前禁止 process spawn。Runtime Event、Session Logger 与 remote observability 不导出 argv、env、
runner request、runtime path 或 cleanup payload。restore 只有在 ref/integrity/canonical shape 和全部 digest
交叉验证成功后，才用该 Artifact 调度有独立 disposal intent/receipt 的 reconciliation；不能读取时 fail closed，
不会调用 host/旧 runner fallback。intent ack 后、Artifact/ready publication 前的 allocation 不依赖 Artifact：
Runtime 只保存 digest identity，restore 以确定性 runtime-directory identity 执行带 abandonment intent/receipt 的
回收；该事件同样不导出 runtime path。

Sandbox preparation codec 对 envelope、prepared plan、attempt、全部 argv string、cwd/env/stdin、transport、
backend/capabilities/enforcement、resource semantics、expiry 与 cleanup/recovery payload 使用 exact key set；未知
nested field、非 canonical JSON、missing/tampered ref 都返回 typed Artifact error。restore 还要把 ready 中的
backend/enforcement/semantics/capability/cleanup evidence 与外层 invocation 的 toolCallId、capability revision、
effective-effects/admission、Workspace、attempt 及全部 plan digest 交叉绑定；`cwd` 必须与 canonical Workspace
完全相同，不能只相信 HMAC-valid Artifact 内部自洽。

Sandbox preparation Artifact 当前随 Runtime ready/disposal evidence 保留；在 retained session/fork 的完整
reachability union 尚未接入该 namespace 前，不进入通用 GC 删除候选。该保守 retention 避免提前删除 crash
recovery handle，但会累积已完成 plan Artifact；后续 GC 接线必须先补全 all-fork reachability 与最小 retention，
不得依据 disposal completed 单个状态直接 unlink。本加法复用 installation integrity key 的独立 domain，未改变
Runtime schema v24 或 format epoch。

## 身份、key 与公开引用

共享原语内部使用 SHA-256 识别内容，但不会把 raw content digest 暴露到 ref、Runtime Event、Session
Logger 或遥测。调用方必须注入至少 32 bytes 的 canonical-private integrity key；原语不生成、不记录、
不回退加载该 key。key 缺失、长度不足或使用错误 key 读取既有 Artifact 都 fail closed。

production composition 从 owner-only `~/.kite-code/model-artifacts.key` 加载 32-byte installation key；Model
与 Capability namespace 使用同一 installation integrity key，但各自的 namespace/domain separation 产生不同
opaque identity。
共享 `~/.kite-code` anchor 只有在确认当前用户拥有、非 link、canonical 且收紧期间 identity 不变后，才可
把 POSIX mode 收紧为 `0700`；Model store root/partition 与 key file 的现有权限异常仍直接拒绝。只有
`model-artifacts/` 尚不存在或为空时才可原子创建新 key；已有 evidence namespace 但 key 缺失、损坏、
非单链接 regular file、权限过宽或路径 identity 不安全时返回 `key_unavailable`/storage boundary failure。
不得覆盖历史 key、生成替代 identity 或回退为无 Artifact 的 live dispatch。

`PrivateArtifactRefV1` 对外只包含：

- keyed opaque `artifactId`；
- 封闭 `kind`；
- 独立 domain 的 keyed `integrityIdentifier`；
- UTF-8 byte length。

ref 不包含绝对/相对路径或 raw content digest。相同 namespace、kind、key 和 canonical bytes 得到相同 ref；
不同正文不能复用既有 opaque identity。完整性校验失败不得修复、覆盖或降级读取 Artifact。

## 文件系统发布边界

受管 root 必须以 namespace 命名并位于一个 owner-only anchor 下。root、分区与操作期间捕获的 ancestry
都固定 dev/inode 与 canonical realpath；symlink/reparse point、祖先替换、非当前 OS owner 或非目录
节点全部拒绝。POSIX 目录固定 `0700`、文件固定 `0600`；Windows 对对应路径应用 owner-only、禁继承
ACL。已存在但权限更宽的 POSIX 目录不会被静默接管。

写入使用同目录 `O_EXCL`/no-follow temporary file，验证 regular file、`nlink=1` 与 owner，写入后执行
file fsync，再用 atomic rename 发布，重新读取并按 keyed identity 校验，最后 fsync 分区、root 与 anchor
目录。同内容并发发布者收敛为同一 ref；发布后、目录 fsync 前失败会留下可由同 key 幂等读取的完整
Artifact，调用方本次仍收到 typed failure。发布前失败不产生可读取 Artifact。读取始终固定 no-follow
descriptor 并在前后重验文件与目录 identity；symlink、hardlink、权限漂移、大小漂移和正文损坏都 fail
closed。

Artifact 正文永不进入 Session Logger。Gateway 只把 opaque Surface/Response ref、keyed integrity
identifier、route fingerprint 与低信息量 admission/resource facts 写入 Runtime Event/State；每次 Provider
attempt 及成功 response consumption 都以这些 evidence 的 durable ack 为前置。五类模型调用现已接线，
Capability dispatch 已在 TP-03 迁移：每次 adapter attempt 先 durable ack，成功或已知失败都必须写入
Capability Artifact 并把 receipt 与 Tool terminal 原子提交；Artifact publish 失败按 dispatch certainty
收敛为 unknown。Capability Artifact 正文和 locator 不进入 Session Logger 或 remote observability。
Tool receipt writer 与 Verification reader 由同一个 installation composition 注入；验证路径没有模块级默认
store。reader、integrity key、opaque ref 或正文校验不可用时 reviewer 在模型 dispatch 前 fail closed 为
`inconclusive`，不会换用另一实例或只交付缺 Artifact 的 receipt。
Runtime schema 保持 v24，format epoch 未改变；只有 CUT-01 可切换 epoch。

PS-03 复用同一 hardened primitive 与 installation key，但以独立 domain 建立四个 private namespace；它们
不属于 Model、Capability、Filesystem 或 Sandbox namespace，也不能互换 ref：

```text
subagent-tasks/requests/       queue 前的模型 Task request
subagent-tasks/tasks/          Provider/Driver 消费的最终 delegation task
subagent-continuations/continuations/ blocked child 的完整 continuation
subagent-lifecycles/handles/   sealed Provider recovery handle
```

公开 ref 只有 opaque keyed artifact ID、封闭 kind、keyed integrity identifier 与 Artifact wrapper byte length。
payload 内的 task byte length、task digest、owner、parent model/capability invocation、parent attempt/tool call、
child、role、continuation cursor/blocked identity 与 handle binding 分别使用 exact-key canonical schema 密封；
reader 必须从独立 live Runtime authority 取得 expected identity，不能让 Artifact 或 public suspended record 自证 owner。
Provider 在 prepare 时严格回读最终 task，Driver 在 activate 后再次比较同一 readback proof；request hydration、
continuation resume/auto-review 与 crash recovery 也都在任何 Provider、Driver、Gateway、reviewer 或 child tool I/O 前
完成 exact readback。wrong key、missing、tamper、unknown key、cross-attempt/child/invocation splice、length 或
digest drift 全部 fail closed。

所有新 Task 写入在 `model.responded`/`tool.queued` 持久化前先发布 request Artifact；公开 arguments identity 只基于
role 与 opaque ref，不含可离线字典验证的 task digest。当前 v24 对已持久化的 legacy raw Task queue/suspension
只保留受限 read-only reader；该 reader 只接受严格闭合的 raw `{subagent_type, task}`，不会把带有 `taskArtifact`
的混合形态按 raw task 读取。新写入只产生 private ref。Runtime Event/State、Session Logger、模型投影和 remote
observability 不保存 task 正文、child messages、完整 continuation、raw task/continuation digest 或完整 Provider
handle。审批所需的显式最小 command 投影仍属于既有受治理 approval authority，不授权读取 continuation Artifact，
也不得扩展到 Session Logger 或 remote telemetry。

四个 namespace 都加入 installation key-loss evidence-root union；只要任一受治理 namespace 已有 evidence，key
loader 就不能生成替代 key。当前保守 retention 与 Sandbox recovery Artifact 相同：在 retained session/fork 的
完整 reachability union 未纳入这些 ref 前不进入通用 GC。PS-03 仍为 `in_progress` 的唯一原因是受控 live
record→strict replay start/resume qualification 尚无本环境可用的批准录制 authority/credential/cassette；这不否定
本节已完成的 private storage、privacy 与 recovery 边界，也不得用自造 live record 补齐资格。

## Reachability 与 GC

GC 调用方必须提供 `complete=true` 的可达性快照，其 `reachable` 是所有 retained session 及其全部 fork
所引用 Model Artifact 的并集；重复 ref 表示共享不可变 Artifact，不会复制或提前删除。缺失/损坏的
reachable ref、错误 integrity key、不完整快照、未知目录条目、symlink/hardlink、身份漂移或超过 scan
entry budget 时，扫描在任何删除前 fail closed。

只有完整验证扫描完成后，GC 才按 `(mtime, path)` 稳定顺序删除早于调用方 minimum retention 的
unreachable Artifact。符合封闭命名的旧 temporary crash residue使用相同 retention；其他 residue
视为未知条目。默认 scan entry 上限为 10,000，调用方可以进一步收紧。每次 unlink 前重验文件和目录
identity，并在删除后 fsync 目录链。

Runtime invocation ref 已由 `model.invocation_*` event 持久化。restore/fork 对 completed invocation 严格
验证 Surface/Response；Artifact 缺失、损坏或 key unavailable 时保留已确认 transcript，但标记 evidence
unavailable 并禁止 strict replay。pending invocation 按是否存在 attempt ack 收敛为 undispatched/unknown，
且不自动重放。GC API 仍不得自行推断 Runtime reachability，也不能把 Artifact 存在或缺失直接解释为
Runtime 状态转换。RP-01 的 strict Evaluation catalog 是独立、受审查的 synthetic 数据域，只保存稳定
attempt outcome 与 Production Artifact 无关的匹配 digest；它不是 Model Artifact GC 的输入或输出。
Production Model Artifact 永不复制或提升为版本控制中的 Evaluation cassette；后者只接受 ADR-0112 与
`model-replay-evaluation-policy.md` 批准的 synthetic 内容和独立 revision/digest。
