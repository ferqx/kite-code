# Shell 沙箱边界与并发审批队列优化方案（方案一）

状态：archived（SAQ-00～SAQ-10、本地全量与 GitHub Actions 已收敛）

日期：2026-08-25

优先级：P0

决策来源：用户直接指令、当前源码与测试、ADR-0133、ADR-0136、
`docs/active/authorization.md`、`docs/active/tool-gated-autonomy.md`、
`docs/active/plan-mode-implementation.md`。

> 本文件记录已实施并归档的方案一。当前行为以源码、测试、`docs/active/` 和 ADR-0137 为准；本文件保留
> Task 顺序、验收矩阵和回滚约束。最终本地与远程证据见完成记录。

> 2026-08-25 后续兼容决策：ADR-0138 部分替代本计划中“旧 Store 只读但不可进入会话”的 clean-cutover
> 结论。当前 writer 与授权契约仍保持 State 27/SAQ 单格式；已知历史会话只在选中后静默导入并剥离旧权限，
> 未知格式静默忽略，单会话损坏不影响其他会话。

## 1. 目标

建立一套以原生沙箱边界为执行依据、以 interaction mode 决定越界处理方式的 Shell 授权模型，并一次性解决
多 Subagent 并发审批时的排队、确认、恢复、取消和 TUI 投影问题。

本方案必须达到以下结果：

1. Workspace 内不因 `.git`、隐藏目录、`.env`、`.agents` 等名称触发额外拒绝；真正的能力边界由当前 phase、
   interaction mode、编译后的 sandbox profile 和不可覆盖 hard deny 共同决定。
2. Building 的 Workspace 基线内 Shell 不依赖 `git status`、`ls` 等命令白名单；调用留在基线沙箱内时直接运行，
   已知需要扩大文件系统、网络或进程能力时才进入审批路由。
3. 超出基线沙箱的 exact invocation 由 Runtime 保留并审批；批准后由 Runtime 使用批准后的 sealed scope 执行，
   不要求模型重新提交带“扩权字段”的第二次 Tool Call。
4. 用户审批只有 `approve_once`、`same_command` 和拒绝三种动作。`full_access` 不再是 approval grant；Full 仅是
   `interactionMode=full`。
5. 多个相同 Shell 同时等待时，首个 `same_command` 批准在同一持久化事务中登记 Session grant，并释放所有符合
   条件的匹配调用；未来同一 Session 的匹配调用也不再询问。
6. 多 Subagent 共享一个 durable approval queue。TUI 只投影权威状态，不能拥有、覆盖或丢失审批。
7. `phase=planning|building` 与 `interactionMode=accept_edits|auto|full` 是正交维度。特别是 Plan + Full 合法，
   Full 不会退出 Plan lifecycle，Plan 也不会把 Full 降级成只读权限。

## 2. 非目标

- 不建立 Shell 程序名、Git subcommand 或参数形态白名单。
- 不让模型声明 `requested_capabilities`，也不要求模型在 sandbox denial 后重放同一命令。
- 不把 `same_command` 变成跨 Session、跨 Workspace 或永久的用户级白名单。
- 不并发去重 Shell 执行；匹配调用各自执行，只共享授权结果。
- 不允许 approval、Auto reviewer 或 Full 覆盖空命令、明确关键系统递归删除等 hard deny。
- 不把当前平台无法精确兑现的 host 能力包装成“仅批准某个路径”；UI 必须展示实际可兑现的最小 scope。

## 3. 方案一：sandbox-first、单次调用审批

### 3.1 权威顺序

每个 Shell invocation 使用同一条决策链：

```text
Tool Call
  -> schema / binding / hard deny
  -> phase + interaction mode
  -> compile baseline sandbox and known required effects
      -> baseline 可承载：直接 dispatch
      -> 已知需要扩边界：Auto reviewer 或用户审批
      -> 无法证明但可安全约束：在 baseline sandbox 内 dispatch
  -> sealed execution scope
  -> scheduler admission
  -> native sandbox execution
  -> receipt / terminal event
```

Policy 可以使用解析器和 effects 推导“应使用哪个 sandbox scope”，但不得因为命令名命中固定集合就授予权限。
原生 sandbox 是最终执行 ceiling；Policy、reviewer 和 approval 只负责选择可兑现的 profile，runner 不得自行作第二次
授权判断。

若未知脚本在启动后才触发原生 sandbox denial，本次 invocation 以结构化 `sandbox_denied` 终结，不自动以更宽权限
重放。自动重放无法证明前一次没有产生部分副作用，也会造成重复执行。模型可以根据结果发起新的调用，但新调用必须重新
经过正常治理。

### 3.2 phase 与 interaction mode 矩阵

| Phase | Accept Edits | Auto | Full |
| --- | --- | --- | --- |
| Planning | Workspace 只读 sandbox 基线内直接执行；已知需要扩大 scope 时请求用户 | Workspace 只读 sandbox 基线内直接执行；已知越界先交 Auto reviewer，无法确认再询问用户 | 不使用受限 sandbox 或 Tool Approval，按 Full 能力执行；仍保持 Planning lifecycle 和 Plan UI |
| Building | Workspace 读写 sandbox 基线内直接执行；已知越界请求用户 | Workspace 读写 sandbox 基线内直接执行；已知越界先交 Auto reviewer，无法确认再询问用户 | 直接按 Full 能力执行，不产生 Tool Approval |

矩阵只改变 Shell 执行权限，不改变 Plan Artifact、plan review、progress 和 completion gate。Plan + Full 可以执行
Shell 或修改文件，但不会因此自动批准 Plan、切换到 Building 或跳过 Plan lifecycle。非 Full 的 Planning 仍以只读
sandbox 作为物理 ceiling；即使用户或 Auto 同意外部读取，也不能静默获得写能力，扩大写能力必须由审批卡明确展示。

### 3.3 Workspace 边界

- Workspace identity 使用启动时 canonical root，并在执行前重新验证 symlink、mount 和外部 `.git` pointer。
- canonical target 位于 Workspace root 内时，不按 basename 建立敏感目录 deny；`.git` 和隐藏目录与普通目录同路。
- Workspace 外路径、网络、系统敏感路径和无法证明 effects 的已知请求，不直接硬拒绝；Accept Edits 询问用户，Auto
  交 reviewer，Full 直接执行。只有不可覆盖 hard deny 仍拒绝。
- 当前 backend 若只能提供 `workspace_only` 或宽 host access，而不能兑现单一外部目录 scope，审批 UI 必须说明将授予
  的真实范围；不能显示虚假的精细路径授权。

## 4. 审批契约

### 4.1 唯一动作集合

用户可见动作固定为：

| 动作 | 语义 |
| --- | --- |
| `approve_once` | 仅批准当前 exact invocation；产生单次 sealed execution receipt |
| `same_command` | 在当前 Session 登记匹配 grant，原子释放当前所有匹配等待调用，并放行后续匹配调用 |
| `reject` | 拒绝当前 invocation；不是 grant，不产生授权状态 |

`ShellApprovalGrant` 只允许 `approve_once | same_command`。删除 approval contract、Runtime event、CLI/TUI 选项、
prepared request 和 replay codec 中的 `full_access` grant。Full 通过 `/permissions`、启动配置或 session mode 变更进入，
不能由审批卡临时升级。

Auto reviewer 的 V1 输出固定为 `approve_once | reject | ask_user`。`same_command` 会影响当前和未来多个调用，必须由
用户显式签名；Auto reviewer 不得生成它。

对于凭据写入、系统配置修改、递归 mutation 等高风险调用，Policy 可以不提供 `same_command` 按钮，只提供
`approve_once` 和拒绝；这不增加第三种 grant。

### 4.2 `same_command` 匹配身份

当前仅使用 Workspace、thread 和 `trim(command)` 不足以证明同一授权。V1 匹配键必须至少包含：

```text
sessionId / threadId
canonicalWorkspaceIdentity
canonicalCwd
exactCommandDigest
shellOrExecutorIdentity
executionEnvironmentDigest
effectiveSandboxScopeDigest
effectiveEffectsDigest
policyParserExecutorRevision
```

- command 只去除首尾空白后做 exact digest；不对 quote、管道、alias、环境变量或 shell 语义做“等价”归并。
- `description` 和 `timeout_ms` 不参与授权匹配；它们不改变命令权限。
- 不绑定 Subagent ID，使同一 Session 内不同 sibling 可以复用；role ceiling、environment 和 scope 差异会通过 digest
  阻止错误匹配。
- grant 命中后仍重新执行 schema、hard deny、phase、binding freshness 和 policy revision 校验。
- Session 结束、Workspace canonical identity 变化、policy/parser/executor revision 变化、scope/effects/environment
  变化或用户显式清除时，grant 失效。

### 4.3 原子批量释放

`same_command` 的提交必须是一个 Runtime Store 原子事务：

1. 校验 focused approval 的 interaction ID、approval binding digest、session revision 和用户签名。
2. 持久化 Session command grant。
3. 从当前 revision 快照匹配 `awaiting_user`、`queued_user`、`auto_reviewing`、`queued_auto` 和尚未 dispatch 的
   deferred 调用。
4. 为每个匹配 invocation 生成独立的单次 execution authorization/receipt identity，并转为
   `authorized_queued` 或可立即 dispatch 状态。
5. 取消尚未开始的匹配 Auto review；已返回的迟到 reviewer 结果因 generation/revision 不匹配而成为 no-op。
6. 一次提交并发布 projection events，随后由 scheduler 按并发上限启动。

已 running、terminal、cancelled、rejected、expired 或 binding 已 stale 的调用不得复活。若释放 8 个调用而 Shell
并发上限为 3，结果应是 3 个 running、5 个 `authorized_queued`；“直接执行”表示不再审批，不表示绕过资源调度。

## 5. Durable approval queue

### 5.1 权威状态

单一 `interactions` 槽位改为持久化集合与显式焦点：

```text
pendingApprovals: Map<interactionId, PendingApproval>
activeApprovalId: interactionId | null
sessionCommandGrants: Map<grantKey, SessionCommandGrant>
```

每个记录至少保存 invocation、parent/child identity、route、binding digest、risk/effects、queue sequence、generation、
createdAt 和 status。允许的状态转换为：

```text
queued_auto -> auto_reviewing -> authorized_queued | queued_user | rejected
queued_user -> awaiting_user -> approving -> authorized_queued | rejected
authorized_queued -> running -> succeeded | failed | cancelled
```

焦点选择、提交审批、切换下一个焦点必须由 Kernel/Runtime Store 原子转换完成。TUI 不得通过“当前没有 Overlay”推断
可以接受新的审批，也不得直接修改 child 状态。

### 5.2 多 Subagent 路由

- 所有 parent 和 child invocation 进入同一个 session queue；Subagent 不拥有独立模态审批器。
- 只有并发多 Agent 探索中的 `explore` child 在非 Full 父模式下派生 Auto 路由；其他 `plan`、`code`、`review`
  child 不自动切为 Auto，继续遵守 parent phase/mode 和 role ceiling。Full 始终保持 Full，不降级为 Auto。
- Auto reviewer 结果需要用户时转入 `queued_user`；多个请求按稳定 queue sequence 展示，不能互相覆盖。
- 某些 sibling 已完成不影响剩余审批；一个 child 被拒绝只终结该 invocation/child，除非任务依赖图明确要求 parent
  fail-fast。
- approval 确认后立即发布 child `approved/authorized_queued/running` 投影，不等待下一次 progress tick。

### 5.3 键盘和取消语义

- `Enter` 只提交当前 focused approval 一次；按键去抖和 Runtime idempotency 共同防止重复提交。
- `Esc` 等价于拒绝当前 focused invocation，随后焦点移动到队列下一个请求；不默认终止无关 sibling。
- `Ctrl+C` 取消整个当前 turn，包括所有 queued/awaiting/authorized/running child，并关闭 Approval Overlay。
- stale interaction ID、已经终结的请求和迟到按键都返回幂等 no-op，不改变其他请求。

## 6. Full、权限持久化与 session identity

1. `interactionMode=full` 是唯一 Full 权威；删除并行存在的 `authorization.mode=full_access` 和由 approval 写入 Full
   的路径。内部 sandbox profile 可以表示 host-unrestricted，但它不是用户 approval grant。
2. `/permissions` 同时更新当前 Session 的持久化 `interaction_mode.changed` 事件和用户级默认设置。退出并重新进入 TUI
   后，新 Session 使用用户默认；恢复旧 Session 使用该 Session 最新 mode。显式启动参数只覆盖本次启动，除非用户
   再通过 `/permissions` 保存。
3. 切换到 Full 时，Runtime 在同一 revision 下重新评估尚未 running 的 queued/awaiting 调用；它们可转入
   `authorized_queued`，但不得伪造 `approval.granted(full_access)`。已经 running 的调用保留启动时 sealed scope。
4. 从 Full 切换到受限模式时，所有尚未 running 的 prepared authorization 失效并按新模式重新 prepare；已经 running
   的调用不在中途改变 OS token/sandbox。
5. `interactionMode` 是可变、带 revision 的 Session state，不是启动后永不变化的 coordinator identity。稳定 identity
   与 live mode 分开校验，避免合法的 `/permissions`、Plan review 或 child route 变化触发
   `Runtime session identity drifted`。
6. `same_command` grant 与 queue 状态持久化在 Session 内；重启 TUI 后恢复同一 Session 可以继续使用，新建 Session
   不继承。`/permissions` 提供查看和清空 Session command grants 的入口。

## 7. TUI 投影

审批卡固定显示：来源 Agent/role/task、exact command、cwd、已知 effects/risk、实际 sandbox expansion、审批 route 和
当前匹配等待数量。按钮文案为“允许一次”“允许相同命令”“拒绝”。

选择 `same_command` 前显示：

> 当前 Session 后续相同命令不再询问；当前有 N 个匹配等待 Shell 将立即获批。

提交后立即显示批次结果，例如“已释放 4 个：2 个执行中，2 个已授权排队”。状态展示必须区分：

- 自动审查排队中 / 自动审查中；
- 人工审批排队中 / 等待你的批准；
- 正在批准 / 已批准排队 / 执行中；
- 已拒绝 / 已取消 / 执行失败。

Overlay 的关闭、焦点切换和 child tree 状态都由 Runtime events 投影。审批后不能临时退化为普通输入框、丢失
Delegating 树或等待数秒才更新；live 和 replay 必须得到相同结果。

## 8. 持久化、恢复与 exactly-once

- grant 写入、匹配集合快照和调用状态迁移必须在同一个 Store batch 中提交；任何一步失败都不释放调用。
- 每个 invocation 的 authorization receipt、attempt ID 和 dispatch ack 独立。`same_command` 共享的是 eligibility，
  不是 attempt ID。
- crash 发生在 grant commit 后、dispatch 前时，恢复为 `authorized_queued`；发生在 dispatch ack 后时，按现有
  attempt recovery 规则处理，不能再次启动同一 invocation。
- late Auto review、late user input、旧 approval hash、旧 session revision 和旧 prepared request 均 fail closed/no-op。
- mode、grant 或 policy revision 改变后，所有未 dispatch prepared request 必须重算，不能依赖旧 identity 继续执行。

## 9. 实施顺序

### SAQ-00：追加架构决策并冻结新契约

新增 ADR-0137，明确方案一、Plan/Full 正交、两类 grant、拒绝动作、durable queue 和 clean cutover；替代 ADR-0136
中“Building 每个 Shell 都 ask”和“Planning 禁止全部 Shell”的相关决定，但保留无命令白名单和 hard deny 结论。
先写 contract/codec 迁移测试，禁止新生产事件产生 `full_access` approval grant。

### SAQ-01：实现 phase/mode/sandbox 决策矩阵

调整 Shell policy compiler 和 sandbox preparation：Building Workspace baseline 直接执行；Planning 非 Full 使用只读
baseline；已知扩边界按 interaction mode 路由；Full 直接形成 unrestricted execution authority。删除命令名 direct
allow 和“所有 Shell 一律 ask”两种正向授权捷径。

### SAQ-02：建立 durable approval queue

在 Kernel state/events/reducer 和 SQLite Store 中引入 `pendingApprovals`、`activeApprovalId`、queue sequence 与
generation。迁移 Scheduler/CompletionGuard 使用集合查询，保证焦点分配和 acknowledgment 原子化。

### SAQ-03：收敛审批 grant 与安全匹配键

移除 `full_access` approval grant 和重复 AuthorizationMode；实现完整 command grant key、expiry/invalidation、
`approve_once` 和 `same_command` reducer。历史 Store 数据只读解码时将旧 Full grant 视为不可执行历史事实，不得恢复
成 live Full 权限。

### SAQ-04：实现 `same_command` 原子批量释放

实现 grant-first、snapshot-match、independent receipt、cancel auto-review 和 batch event。接入 scheduler concurrency，
覆盖 terminal 不复活、不同 cwd/scope 不匹配和迟到 reviewer no-op。

### SAQ-05：统一 parent/child 审批路由

删除 Subagent 私有审批槽和 deferred serialization 假权威；所有 child 进入 session queue。只为并发 `explore` child
派生 Auto route；完成、失败、等待审批的 siblings 独立归约，并确保一个 approval acknowledgment 不会使其他 child
发生 `model_step_failed` 或 identity drift。

### SAQ-06：收敛执行交接与恢复

把 approval batch 到 prepared dispatch 的 ack/receipt/attempt 做成唯一链路，增加 crash-point recovery、scheduler
admission 和 stale prepared request 检查；禁止 sandbox denial 自动 host replay。

### SAQ-07：修复 Full、`/permissions` 和 identity

让 Full 只由 interaction mode 驱动；实现用户默认和 Session mode 的双层持久化、升降级重评估、Session grant
查看/清除，并拆开 immutable identity 与 live mode revision。

### SAQ-08：重做 Approval TUI 投影与输入

更新 ApprovalBlock、ConcurrentSubAgentBlock、run status、reducer 和本地化 catalog；实现 queued route、匹配数量、
批量释放结果、即时状态更新，以及 Enter/Esc/Ctrl+C 语义。

### SAQ-09：并发、恢复和平台验收

增加 Kernel property/unit、Runtime integration、SQLite recovery、Ink 和 PTY 场景；在 macOS Seatbelt、Linux bubblewrap
和 Windows restricted-token backend 验证 baseline/expanded scope 与 UI 描述一致。

### SAQ-10：文档和 clean cutover

同步 authorization、tool-gated autonomy、Plan mode、Shell platform/Windows sandbox、session logging、TUI E2E 与本地化
active 文档，更新 documentation map；删除旧 grant、旧单槽状态、旧 CLI 文案和 compatibility production path，运行
全量门禁并登记完成记录。

## 10. Task 执行矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| `SAQ-00` | — | ADR-0137、contract/codec baseline、禁止 `full_access` approval grant 的测试 | `bun test packages/agent-kernel/test/authorization.test.ts tests/policies/authorization-elevation.test.ts` | 仅冻结新决策和测试；未切生产路径前可撤回 |
| `SAQ-01` | `SAQ-00` | Shell policy compiler、phase/mode 矩阵、sandbox preparation | `bun test packages/builtin-runtime/test/sandbox-authority.test.ts packages/builtin-runtime/test/role-shell-ceiling.test.ts tests/runtime/tool-pipeline-sandbox-lifecycle.test.ts` | 以单一 feature cutover commit 回退到旧 policy；不得长期双路径 |
| `SAQ-02` | `SAQ-00` | Kernel queue state/events/reducer、Store schema、Scheduler/CompletionGuard 集合查询 | Kernel reducer、SQLite replay、completion blocker 定向测试 | schema bump 后旧 snapshot 只读；回滚需同时回退 schema/epoch |
| `SAQ-03` | `SAQ-00`, `SAQ-02` | 两类 grant、匹配键、expiry、历史 codec、删除重复 Full authority | `bun test packages/agent-kernel/test/authorization.test.ts` 加 contract/replay cases | 旧 Full grant 不恢复成 live 权限；不保留写入兼容路径 |
| `SAQ-04` | `SAQ-02`, `SAQ-03` | same-command batch reducer、独立 receipts、Auto review cancellation、scheduler admission | 新增 same-command concurrency/recovery integration tests | batch 失败整体不提交；可关闭批量入口但保留安全 grant 数据 |
| `SAQ-05` | `SAQ-02`, `SAQ-04` | parent/child 中央路由、Explore-only Auto 派生、删除私有审批槽 | `bun test tests/subagent-runner.test.ts tests/subagent-prepared-dispatch.test.ts tests/subagent-continuation-codec.test.ts` | 回滚整个 child queue adapter，不恢复并发写单槽 |
| `SAQ-06` | `SAQ-01`, `SAQ-04`, `SAQ-05` | prepared dispatch/ack/receipt、crash recovery、no host replay | `bun test packages/runtime-host/test/sandbox-preparation-lifecycle.test.ts tests/runtime/concurrent-shell-cancel.test.ts tests/runtime/tool-pipeline-sandbox-lifecycle.test.ts` | 未 ack 恢复 queued，已 ack 按 attempt recovery；不降级为重复执行 |
| `SAQ-07` | `SAQ-02`, `SAQ-03` | Full mode 单权威、permissions 持久化、mode re-evaluation、identity revision | session manager、permissions、RuntimeSessionCoordinator 新增回归 | 用户默认与 Session event 可独立回滚；旧 Full grant 不复活 |
| `SAQ-08` | `SAQ-04`, `SAQ-05`, `SAQ-07` | ApprovalBlock/child tree/status/catalog、键盘和即时投影 | `bun test tests/tui-system/scenarios/approval-escape.test.ts tests/tui-system/scenarios/subagent-approval.test.ts` 加 Ink tests | TUI 只消费新事件；失败回滚展示层不修改 Runtime 事实 |
| `SAQ-09` | `SAQ-06`, `SAQ-08` | 并发/restart/property/PTY/三平台 sandbox 证据 | sandbox test suites、TUI system、`bun run typecheck` | 任一平台 scope 无法兑现即 fail closed 并标 unsupported |
| `SAQ-10` | `SAQ-09` | active docs、documentation map、旧路径删除、完成记录 | `bun run check:docs-impact`、`bun run check:docs`、`bun run test:all`、`git diff --check` | Gate 未通过不提交、不推送、不登记 completed |

## 11. 必须覆盖的验收场景

1. Building + Accept 在 Workspace 运行 `ls -la`、`git status --short`、`bun test`，无命令白名单、无审批。
2. Workspace 内访问 `.git`、隐藏目录和 `.agents` 不因名称被 sandbox 拒绝。
3. Building + Accept 的已知 Workspace 外写入进入用户审批；批准后 exact invocation 执行，不要求模型重提。
4. Building + Auto 的已知越界由 reviewer `approve_once/reject/ask_user` 决定。
5. Building + Full 和 Planning + Full 均不出现 Tool Approval；Planning lifecycle 保持不变。
6. Planning 非 Full 的 Workspace 只读命令直接运行；写能力不能因只读 baseline 被静默获得。
7. `approve_once` 只释放当前调用，三个相同 sibling 中其余两个仍等待。
8. `same_command` 释放三个当前匹配 sibling，保留一个不同 cwd/scope/command 的请求。
9. grant 后未来同 Session 匹配调用直接进入 `authorized_queued`；新 Session 不继承。
10. 释放数量超过并发上限时，剩余调用已授权排队，不重新审批。
11. matching auto reviews 被取消；迟到 reviewer 结果不覆盖用户决定。
12. terminal/cancelled/rejected 调用不因 batch release 复活。
13. 四个并发 child 同时请求审批时只出现一个 focused Overlay，其余状态明确为 Auto 或人工排队。
14. 一个 child 获批、两个已完成、一个仍排队时，child tree 与 queue 均立即显示真实状态。
15. 连续两次 Enter 只提交一次；Esc 只拒绝当前请求；Ctrl+C 终止整个 turn 和所有 siblings。
16. TUI restart 恢复同一 Session 的 mode、queue 和 command grant，不重复执行已 ack invocation。
17. `/permissions` 的选择对新 TUI 进程和恢复 Session 按第 6 节规则生效。
18. 受限模式切到 Full 释放未 running 请求但不产生 `approval.granted(full_access)`；Full 降级使未执行 grant stale。
19. 合法 mode/approval/child route 变化不再触发 `Runtime session identity drifted`。
20. macOS、Linux、Windows 审批卡展示的 scope 与 backend 实际兑现能力一致。

## 12. 风险与处置

| 风险 | 处置 |
| --- | --- |
| Workspace baseline direct 使用户误以为 Shell 只能访问 cwd | 明确展示 sandbox scope；canonical Workspace + native sandbox 才是 ceiling，cwd 只参与匹配身份 |
| 平台无法在进程中途暂停并扩权 | 不承诺动态暂停；启动前已知越界审批，运行期 denial 终结且不自动 replay |
| `same_command` 误匹配扩大授权 | 使用 cwd/environment/scope/effects/revision 完整 digest，命中后重新执行 hard deny 和 freshness 校验 |
| 批量释放绕过 scheduler | 所有调用进入 `authorized_queued`，仍受 concurrency、budget、cancellation 和 process limits 管理 |
| 并发审批确认覆盖其他 child | durable Map + 原子 active ID；TUI 不能写权威状态 |
| Full 与 approval 双权威继续漂移 | 删除 `full_access` grant 和 AuthorizationMode 生产路径，Full 只读 live interaction mode |
| crash 后重复执行 | grant batch 与 dispatch ack 分界持久化，每个 invocation 独立 attempt/receipt |
| Plan + Full 被误描述为只读 | active 文档和 TUI 同时展示 `Planning` 与 `Full`；测试验证二者正交 |

## 13. Rollback

本方案采用发布前 clean cutover，不保留长期 feature flag 或双写。每个 Task 可以在进入下一依赖 Task 前按 commit
整体回滚；一旦 Store schema/format epoch 切换，回滚必须同时回退代码、schema 和测试 fixture，不能让新 queue 数据
由旧单槽 reducer 读取。

若 native backend 无法兑现某个 expanded scope，只关闭该平台的对应 capability 并 fail closed，不回退成“用户批准后
绕过 sandbox”。若 `same_command` batch 出现安全问题，可以临时从 UI 移除该按钮并拒绝创建新 Session grant，但仍要
安全读取和清除已持久数据；不得把旧 grant 降级解释为 `approve_once`。

## 14. 最终验证

```bash
bun test packages/agent-kernel/test/authorization.test.ts \
  packages/builtin-runtime/test/sandbox-authority.test.ts \
  packages/runtime-host/test/sandbox-preparation-lifecycle.test.ts \
  tests/policies/authorization-elevation.test.ts \
  tests/runtime/concurrent-shell-cancel.test.ts \
  tests/runtime/tool-pipeline-sandbox-lifecycle.test.ts \
  tests/subagent-runner.test.ts \
  tests/subagent-prepared-dispatch.test.ts \
  tests/subagent-continuation-codec.test.ts
bun test tests/tui-system/scenarios/approval-escape.test.ts \
  tests/tui-system/scenarios/subagent-approval.test.ts \
  tests/tui-system/scenarios/plan-mode-policy.test.ts \
  tests/tui-system/scenarios/sandbox-mode.test.ts
bun run typecheck
bun run test:all
bun run check:docs-impact
bun run check:docs
git diff --check
```

## 15. SAQ-10 文档收敛

已新增 ADR-0137，并同步 `authorization.md`、`tool-gated-autonomy.md`、`cancel-resume-cleanup.md`、
`plan-mode-implementation.md`、`execution-platform-support.md`、`shell-platform-compatibility.md`、
`windows-shell-sandbox.md`、`session-logging-policy.md`、TUI E2E 与本地化 active 规则，以及
`docs/documentation-map.json`、Plans 注册表和完成记录。实现采用 State 27/SAQ epoch、durable approval queue、
`approve_once|same_command|reject`、interactionMode-only Full、Explore-only Auto、atomic batch receipts、
generation/revision stale no-op、三平台 scope projection/fail-closed 和 live/replay parity。

文档完成记录列出 SAQ-00～SAQ-10 与 20 个验收场景的具名测试入口。主 Agent 已实际运行本地全量门禁，并观察
[Required](https://github.com/ferqx/kite-code/actions/runs/32794845123)、
[Platform Capability Probe](https://github.com/ferqx/kite-code/actions/runs/32794845103) 与其余 PR workflows 全部通过；
具体 job、测试数字和 fault/soak digest 见完成记录。
