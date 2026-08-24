# ADR-0137：Sandbox-first Shell 与 durable approval queue

状态：accepted

日期：2026-08-25

决策者：用户直接指令

相关：ADR-0118、ADR-0119、ADR-0131、ADR-0133、ADR-0136、
`docs/active/authorization.md`、`docs/active/tool-gated-autonomy.md`、
`docs/active/plan-mode-implementation.md`、方案
[`2026-08-25-shell-sandbox-approval-queue-optimization.md`](../space/plans/2026-08-25-shell-sandbox-approval-queue-optimization.md)

## 背景

旧的 Shell 授权路径把 `interactions` 当作单一审批槽，把命令名/只读 grammar 与授权混在一起，并在
`authorization.mode`、approval grant、TUI 局部状态和 Subagent 私有 deferred slot 之间重复表达 Full 或等待状态。
这会覆盖并发 sibling 的审批请求，重启时丢失队列，令迟到 reviewer/input 误推进新调用，也使 sandbox scope、审批展示和
实际 backend 能力不一致。

## 决策

### 1. Phase、interaction mode 与 sandbox

`phase`（`planning|building`）和 `interactionMode`（`accept_edits|auto|full`）是正交维度：

| Phase | Accept Edits | Auto | Full |
| --- | --- | --- | --- |
| Planning | Workspace 只读 baseline 直接执行；已知扩 scope 请求用户 | 只读 baseline 直接执行；扩 scope 先交 reviewer，必要时升级用户 | 直接执行 Full scope，保留 Plan lifecycle |
| Building | Workspace 读写 baseline 直接执行；扩 scope 请求用户 | 读写 baseline 直接执行；扩 scope 先交 reviewer，必要时升级用户 | 直接执行 Full scope |

baseline 是编译后的 native sandbox，而不是命令名 allowlist。Workspace 内 `.git`、隐藏目录、`.env`、`.agents`
等名称不构成额外 deny。空命令、关键系统递归删除、提权和其他 hard deny 仍不可覆盖。已知越界 invocation 在
dispatch 前按当前 mode 路由；native sandbox 启动后 denial 只产生 `sandbox_denied`，不换 host backend 重放。

Full 只由 live `interactionMode=full` 表达。生产状态、approval payload、grant、reviewer response 和
Runtime interaction 不再把 `full_access` 当作第二个授权来源；历史字段只可作为不可执行的历史事实解码，不能恢复 live
权限。Full 不依赖受限 sandbox 的可用性，也不改变 Plan Artifact、plan review、progress 或 completion gate。

Backend scope vocabulary 不属于 approval authority：当前 sealed scope 仍使用
`filesystem=read_only|workspace_write|full_access`、`network=disabled|allow_all` 与
`kind=baseline|expanded|unrestricted`。其中 `full_access`/`allow_all` 只是 exact invocation 的可执行范围字段，不能单独签发
grant、切换 interaction mode 或恢复权限。

### 2. Approval contract

用户动作只有：

- `approve_once`：释放当前 exact invocation，生成独立 receipt/attempt；
- `same_command`：在当前 Session 登记 grant，并原子释放当前匹配等待调用；
- `reject`：拒绝当前 invocation，不产生 grant。

`ShellApprovalGrant` 只允许 `approve_once|same_command`。Auto reviewer 只允许
`approve_once|reject|ask_user`，不能签发 `same_command`。Policy 可针对高风险调用隐藏
`same_command`，但不会增加其他 grant 类型。

`same_command` 的匹配身份至少包括 Session/thread、canonical Workspace、canonical CWD、exact command digest、
executor/shell identity、execution environment、sealed sandbox scope、effects 以及 parser/executor revision。它不包括
description、timeout 或 subagent ID。命中后仍重新检查 schema、hard deny、phase、binding freshness 和 policy revision。

### 3. Durable queue 与原子 batch

State schema/epoch 的 clean cutover 使用 State 27 与 SAQ epoch。Kernel/Store 共同拥有：

```text
pendingApprovals: Map<interactionId, PendingApproval>
activeApprovalId: interactionId | null
approvalGeneration: number
nextQueueSequence: number
sessionCommandGrants: Map<grantKey, SessionCommandGrant>
approvalReceipts: Map<receiptId, Receipt>
```

每条记录持久化 parent/child identity、原始 route、binding digest、sequence、generation、createdAt、effects/scope 和
状态。`queued_auto → auto_reviewing → authorized_queued|queued_user|rejected`，
`queued_user → awaiting_user → approving → authorized_queued|rejected`，之后独立进入
`running → terminal`。所有 sibling 使用同一 Session queue；Subagent 私有 serializer/deferred slot 不是权威。

`same_command` 必须以一个 Store transaction 完成 grant-first、snapshot-match、独立 receipt、取消尚未开始的匹配
review、发布 `approval.batch_released` 和焦点迁移。批量释放不复用 attempt ID，也不复活 terminal/cancelled/stale 调用；
scheduler 仍负责 concurrency admission。generation、Session revision、binding digest 和 receipt 使重复 Enter、并发
提交、重启 replay、迟到 reviewer/input 都成为幂等 no-op 或 fail closed。

### 4. Subagent、TUI 与取消

只有同一 model message/turn 中并发的多个 `explore` children，且 parent 非 Full 时，才派生 Auto route；single Explore、
plan/code/review 继承 parent mode，Full 不降级。原始 route、parent/child/runtime identity 和 approval facts 随
continuation 持久化，恢复不得 synthetic child request/grant 或错绑 parent。

TUI 只投影 canonical events：唯一 focused entry 是 `activeApprovalId` 对应且当前 surface 可见的人工请求；后台
`queued_auto|auto_reviewing` 不夺取 Footer。Enter 提交 exact `{interactionId,generation,grant}` 一次；Esc 提交 exact focused
reject 并推进焦点；Ctrl+C 提交当前 turn 的 durable cancel，覆盖 queued/awaiting/authorized/running siblings。Plan/Input
Esc 保留各自语义。Session grant 查看/清除经 `/permissions` 产生 canonical `session_grants_cleared`，UI/live/replay 共用
同一 event identity。

### 5. Recovery、platform 与 observability

grant commit 后、dispatch 前崩溃恢复为 `authorized_queued`；dispatch ack 后按既有 attempt recovery，绝不重复启动。
恢复顺序为 queue/grant/continuation → capability attempt → Tool terminal。owner Tool 在 capability receipt/reconciliation
完成前不得 terminal；reviewer terminal 不能终结外层 Tool。pre-GO denial 不调用 host，post-GO transport loss 只收敛为
unknown/non-retryable，cleanup failure 不触发 replay。

macOS Seatbelt、Linux bubblewrap 和 Windows restricted-token 各自输出真实 scope/capability evidence；backend unavailable 或
unsupported 必须 clean fail closed。TUI 审批卡展示的 scope 必须等于 backend 可兑现的 scope；Full 的 interaction authority
不能把 unsupported backend 伪装成可用，也不能退化成另一种 grant。生产 qualification 仍以绑定当前 commit 的三平台
GitHub Actions evidence 为准。

Approval wait、queue/execution/total timing 只从 durable event boundary 计算；Session Logger 记录封闭的 metadata，不落盘
命令、路径、grant key、binding digest 或正文。

## 与旧决策的关系

本 ADR **部分 supersede ADR-0136**：保留“raw Shell 不使用程序名、Git subcommand 或 read-only grammar 作为正向授权
白名单”和 hard deny 结论；替代其“Building 每个 Shell 都 ask”以及“Planning 禁止全部 Shell”的 phase 结论，采用本 ADR
的 baseline/scope 矩阵。它也为 ADR-0133 的 Full 路由、reviewer grant 形状和实际 scope 投影提供 clean-cutover 的更新
解释；ADR-0133 关于 sensitive effects、hard deny、native provider 不二次拒绝以及 Host-control 隔离的其他结论继续有效。

## 后果

- Workspace baseline 调用不再因命令名或隐藏 basename 被阻断；越界治理以 facts、sealed scope 和 native enforcement 为准。
- 并发审批、same-command、重启、迟到事件和 Session 切换共享一个可回放的 Kernel/Store 事实，不依赖 TUI 或私有 slot。
- Full/Plan 不再互相降级；旧 Full grant 不能在 restore/fork 中复活。
- 三平台无法证明的 capability 明确显示 unsupported/fail closed，避免 UI 授权文案超过实际执行边界。

## 回滚

回滚必须以新的追加 ADR 同时回退 State 27/SAQ epoch、events/codec、Store、TUI projection、Subagent continuation 和
active 文档。不得恢复旧单槽 approval、`authorization.mode` Full 双权威、`full_access` grant 或 native denial 后 replay。
