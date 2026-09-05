# Server Run 与 TUI 展示生命周期收敛方案

状态：completed（2026-09-05；LFC-00～LFC-08全部完成）

日期：2026-09-04

优先级：P0

依赖：当前 Runtime Kernel、Run-resource-enabled App Server Store、Runtime Contract/Protocol V1、App Server Session
projection、Provider Action continuation、TUI live/history reducer 与真实 PTY 验证。

相关：ADR-0150、ADR-0167、ADR-0168、ADR-0169、ADR-0170、ADR-0171、ADR-0172、ADR-0173；当前行为仍以源码、测试、
workspace README 与 `docs/active/` 为准。本计划不改写任何已接受 ADR 的历史结论。

## 1. 背景与结论

当前底层 State/Event/Revision/Transaction、Host Run Store、command receipt、interaction queue、effect cleanup 与恢复机制
总体健康。结构性问题集中在两个上层生命周期：

1. Agent Server 的 Task、Turn、Runtime Run resource、Resource Budget scope 与 Client `activeWork` 没有完全区分；
2. TUI 将 Server Run 影子状态、本地命令、请求/Thought 组装、Timeline 不可变性与 Ink Static owner 压入同一组标量和
   布尔字段。

最核心的不变量是：

> Server facts 可以推进 TUI presentation；TUI presentation 不能反向证明 Server terminal。

本计划不推倒 Runtime，不新增 Work 领域实体，不立即拆分 `runId` 与 `turnId`，不建立 production dual lifecycle。目标是先明确
唯一权威，再通过兼容 projection 分阶段迁移，保持现有 Run Store、receipt、Plan、Approval、Subagent、replay、multi-session、
TUI Static 与退出语义。

## 2. 范围

### 2.1 纳入范围

- Kernel Task/Turn completion 与旧 `run.completed` 语义；
- Host/Store `RuntimeStoredRun` 的 queued/running/waiting/terminal 生命周期；
- Resource Budget 与 Runtime Run identity 的语义隔离；持久字段改名与 scope terminal 另立后续计划；
- Service `RuntimeWorkProjection`、`activeWork`、本地 operation/admission 状态与 terminal projection；
- Runtime Contract/Protocol 的 Run identity、Session projection、event/snapshot fencing；
- Native TUI client 的 prompt reservation、accepted Run、completion waiter、cancel 与 reconnect；
- React TUI 的 per-Session Run view、本地 command、prompt join、Request/Thought/Tool projection；
- Timeline `LiveItem | SealedItem` 与 Render epoch/Static ownership；
- live/history 等价、fork/rewind/recovery、shutdown/exit 与真实 PTY 回归。

### 2.2 不纳入范围

- 不为 Provider Action continuation Turn 自动创建新 Runtime Run；同一 accepted Run 可以包含一个初始 Turn 与后续 continuation Turn；
- 不为 Work 新增 Store、event、reducer 或 ID；
- 不新增 remote/LAN、多租户、第二 Runtime、第二 Store 或 alternate execution backend；
- 不重做 Tool/Approval/Interaction 的已验证 durable transaction；
- 不以生命周期重构为由改变 TUI 布局、文案、主题或快捷键；
- 不在没有真实 trace 证据时新增 `model.presentation_sealed` wire event；
- 不在没有 PTY 证据时替换 zero-height Static、synchronized output 或当前 scrollback 策略；
- 不自动迁移或重写现有 SQLite event history。
- 不在本计划内改变 Resource Budget 的 State/event 持久字段或引入 `resource_budget.closed`。

## 3. 当前真实模型

| 概念 | 当前实际含义 | 当前权威 | 主要问题 |
| --- | --- | --- | --- |
| Task | 可跨多个 Turn 的用户目标 | Kernel State | `task.completed` 与 `run.completed` 都能结束 Task |
| Turn | 一次用户输入/Agent loop 边界 | Kernel State | Client 有时把 Turn terminal 当整个 Work terminal |
| RuntimeStoredRun | accepted `start_turn` 的可查询执行资源 | Host + Run Store | 初始 runId 来自首个 turnId，但 Provider continuation 可建立新 Turn；当前稳定 Run identity 会丢失 |
| `run.completed` | completion guard 接受后的完成事实 | Kernel completion reducer | 名称像 Run terminal，行为实际完成 Task |
| ResourceBudget `runId` | 父 Agent/Subagent 共享预算作用域 | Kernel/Host budget ledger | 与 Store Run 不是同一 identity 却使用同名 |
| RuntimeWorkProjection | Task + 当前 Turn + Interaction 的 Client DTO | Service projector | `workId=taskId`，status 可由 Task/Turn/Run 任一 terminal 修改 |
| Native `agentLoopActive` | reservation、Server active、completion waiter 混合状态 | Native client | 本地提交与 Server Run 事实未分开 |
| React `running` | Footer、输入、Session snapshot、Static 分界混合状态 | TUI reducer | 多个 action/event 都可改写，没有 runId/revision fence |
| Thought/text flags | Request/Thought/ownership/Static 混合状态 | TUI reducer + renderer | `active/responsePending/result/awaiting_terminal` 存在非法组合 |

当前至少存在四种不同的 Run 语义：

```text
Store Run ID             = accepted start_turn 对应的稳定执行资源；V1 创建时等于 initial Turn ID
Kernel run.completed     = 实际完成 Task
ResourceBudget runId     = 独立累计预算 scope
Client run.terminal      = completion waiter 使用的客户端终态
```

## 4. 目标架构

```text
Agent Server
┌───────────────────────────────────────────────────────────────┐
│ Session                                                       │
│ └─ Task                         跨 Run 用户目标               │
│    ├─ RuntimeRun 1              accepted start command scope │
│    │  ├─ initial Turn 1                                       │
│    │  └─ continuation Turn 2  Provider Action恢复             │
│    ├─ RuntimeRun 2              successor start command       │
│    │  └─ Turn 3                                              │
│    └─ Task terminal                                          │
│                                                               │
│ BudgetScope                     与 RuntimeRun 正交             │
│ SessionOperation                command/admission/cleanup owner│
└───────────────────────────────────────────────────────────────┘
                              │
                authoritative receipt/event/snapshot
                              ▼
TUI Client
┌───────────────────────────────────────────────────────────────┐
│ ServerProjection               TaskView / RunView / queue     │
│ LocalCommandLifecycle          prompt / start / cancel        │
│ PresentationProjection         request / thought / timeline   │
│ RenderLifecycle                sealed / static / epoch        │
└───────────────────────────────────────────────────────────────┘
```

### 4.1 唯一权威矩阵

| 实体 | 开始事实 | 终态事实 | 不得替代它的信号 |
| --- | --- | --- | --- |
| Task | `task.started` | canonical Task completion/cancellation | Turn/Run/UI terminal |
| Turn | `turn.started` | `turn.completed/turn.aborted` | Task terminal、Footer、Tool terminal |
| RuntimeRun | applied receipt + 原子 Run insert | Host/Store Run transition | `model.responded`、Task terminal、Promise/Ink flush |
| BudgetScope alias | `resource_budget.configured` | 维持当前持久语义，本计划只隔离名称和禁止跨域 correlation | RuntimeRun identity/terminal |
| Interaction | authoritative queue/request | settlement event + queue replacement | 组件 unmount、本地 Enter/Esc |
| Tool/Subagent | Server queued/started | Server terminal + cleanup facts | TUI 卡片停止动画 |
| Request presentation | accepted stream facts | Service barrier + model terminal 分类 | Run terminal |
| Thought | TUI presentation boundary | TUI deterministic seal | Server Run terminal 单独出现 |
| Timeline item | TUI projector 创建 | `SealedItem` | Ink Static |
| Static owner | render commit planner | render epoch remount/dispose | Server terminal |

## 5. Agent Server 生命周期

### 5.1 Task

目标状态：

```text
active ── task.completed ──► completed
   └──── task.cancelled ───► cancelled
```

规则：

1. Task 可跨多个 Turn；`plan_draft_pending` 关闭当前 Turn/Run，但保留 Task；
2. 只有 Task completion authority 可以修改 `activeTaskId` 与 Task terminal；
3. Turn/Run terminal 不得隐式完成 Task；
4. 旧 `run.completed` 在迁移期被明确标记为 legacy Task-completion acceptance fact；它现有的 `output`、
   `completionGuardVersion`、`planIdentity` 与 `outcome` 均不得丢失；
5. 本计划保持当前持久 writer 的完整 `run.completed` payload 与 format 不变；State/history normalizer 将其解释成内部
   `CanonicalTaskCompletionFact(taskId, runId, turnId, output, guard, planIdentity?, outcome)`，不让 raw 名称继续决定领域语义；
6. 现有轻量 `task.completed` 仅在明确的 legacy/compatibility 输入中归一化，current production writer 不新增第二条 Task completion；
7. 对外 final answer、recovery entry 与 outcome 保持等价。raw event 改名、payload V2 与新 format epoch 另立后续计划，
   不属于本计划完成条件。

Canonical live 数据流固定为：

```text
completion guard accepted
  → writer 保持 run.completed(turnId, output, guard, planIdentity?, outcome)
  → normalization 生成 CanonicalTaskCompletionFact，并由唯一 Task completion reducer
    写 terminalOutcome、完成 Task、清 activeTaskId
  → 同 transaction 写 turn.completed + State snapshot + Host stable Run transition
  → transaction commit 后 Service projector 发布 task.terminal 与 run.terminal(real runId, outcome)
  → History adapter 经同一 canonical facts 产生等价 client events
```

当前 `task.completed` legacy public-stream filter 可以保留；Client Task terminal 来自 canonical completion projection，而不是要求 raw
writer 双发另一事件。`run.terminal` 由 Host committed Run transition 产生，不能继续从 final `event.turnId` 猜 stable runId。
Provider continuation + restart + live/history replay 的 terminal identity golden 是 LFC-04 硬门禁。

### 5.2 Turn

目标状态：

```text
active ── turn.completed ──► completed
   └──── turn.aborted ─────► aborted(user | error)
```

规则：

1. 一个 accepted `start_turn` 创建一个 RuntimeRun 和 initial Turn；Provider Action 恢复可以在同一 Run 内创建 continuation Turn；
2. Model/Tool retry、普通 Approval/Input waiting 不创建新 Turn；只有当前已存在的 Provider Action continuation 路径按现有语义创建新 Turn；
3. current format 不给 Turn event 增加新字段；Host 通过同 Session 唯一 active Run row、transaction revision 与当前 Turn 联合维护
   stable Run identity，continuation 不创建新 Run；
4. Approval reject 在同一 durable transaction 内拒绝 target、取消 siblings、写 `turn.aborted`；
5. 所有 early return、provider/sandbox recovery failure、deadline 与 unexpected runner return 都必须关闭当前 Turn；deadline
   短期继续使用 `cause=error`，由 terminal outcome/reason code 表达 deadline，不在本计划内扩展 Kernel abort cause；
6. Bridge `finally` 只能释放进程内资源，不能补造 durable terminal。

### 5.3 Runtime Run resource

V1 保留：

```ts
interface RuntimeExecutionHandle {
  readonly sessionId: string;
  readonly taskId?: string;
  readonly runId: string;
  readonly initialTurnId: string;
  readonly activeTurnId: string;
  readonly startCommandId: string;
}

// V1 creation compatibility; continuation 后不再要求 runId === activeTurnId
runId === initialTurnId;
```

稳定 Run identity 必须可持久恢复，不能只存在于内存 handle。迁移分两步：

1. 在旧 format 兼容阶段，以同 Session 唯一 active Run row 作为 Run authority；Provider continuation transaction 必须验证并推进该
   Run 的 `lastRevision/status`，terminal 也从该 row 取得 stable runId，禁止再用 final `turnId` 查找 Run；
2. Provider continuation transaction 必须在同一 revision 下推进唯一 active Run row 的 `lastRevision/status`；terminal closure 使用
   `runs.getActive(sessionId)` 取得 stable runId，不再使用 current/final turnId 查 Run。recovery 由 State snapshot、Run row、revision 和
   single-active-Run invariant 共同校验。旧 history 只有在 pre-event State、Provider continuation facts 与 Run index 能唯一证明映射时
   才归一化，否则进入 recovery_required，不猜测。

由此，Provider continuation 已提交后即使 Host/Bridge 重启，也能从唯一 active Run row 与 committed revision 找回原 Run；
fork/rewind/replay 必须验证这一映射随 State/Run transaction 一起前进。若 trace 证明仅凭这些当前持久事实不能唯一恢复，本阶段停止并
另立显式 format/migration 方案，不能在本计划内偷偷增加 fallback reader。

生命周期：

```text
applied receipt + Run insert
             ↓
           queued
             ↓ attempt_start transaction
           running
             ↕ interaction queue / Provider continuation Turn
           waiting
             ↓ Turn/Host terminal closure
completed | failed | cancelled
             │
             └── recovery_required / outcome_unknown（阻塞态，非 precise terminal）
```

必须满足：

```text
每个 applied start receipt 对应一个且仅一个 Run row
每个 Run row 最多一个 precise terminal
同一 Run 的 continuation Turn 仍使用原 canonical runId
每个 nonterminal Run 在 recovery 后只能继续、取消、精确终结或进入 recovery_required
每个 client Run terminal 使用 receipt 的 canonical runId
```

不立即新增 `run.started`。applied receipt、State/event/snapshot 与 queued Run insert 已经构成权威开始事实。LFC-00 必须先以
Provider Action trace 固定 Run/initial Turn/continuation Turn 的映射；在该 trace 通过前不得添加 `runId===activeTurnId` assertion。

路径边界：Run-resource-enabled current App Server/Workspace execution path 使用上述权威；仍可能
`supportsRunStorage()===false` 的 `createKiteCliRuntimeAccess`、legacy/in-process 或 test composition 不得伪装拥有 Run row，只能通过
显式 compatibility adapter 投影 Turn-based completion。LFC-00 必须列出这些入口和真实 production consumer；LFC-04 前要么迁入 Run
resource，要么从 production/release qualification 排除。完成定义中的“每个 applied receipt 对应 Run row”只在 Run-resource-enabled
current production path 生效，不能用它让 legacy fixture 虚构 Store authority。

### 5.4 Work projection

`Work` 不成为领域实体。迁移期内部先形成：

```ts
interface ServerTaskView {
  readonly taskId: string;
  readonly phase: 'planning' | 'building';
  readonly status: 'active' | 'completed' | 'cancelled';
}

interface ServerRunView {
  readonly runId: string;
  readonly initialTurnId: string;
  readonly activeTurnId?: string;
  readonly taskId?: string;
  readonly status:
    | 'queued'
    | 'running'
    | 'waiting'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'recovery_required';
  readonly revision: number;
  readonly activeInteractionId?: string;
  readonly outcome?: RunTerminalOutcome;
}
```

旧 `RuntimeWorkProjection` 只由纯 compatibility projector 生成。禁止 `terminalizeActiveWork()` 一次修改 Task、Turn、Run 三种语义。

长期 Session projection：

```ts
interface RuntimeSessionProjection {
  readonly sessionId: string;
  readonly revision: number;
  readonly lifecycle: 'open' | 'closed' | 'unavailable';
  readonly activeTask?: {
    readonly taskId: string;
    readonly phase: 'planning' | 'building';
  };
  /** Current or most recently settled execution resource; retained through terminal projection. */
  readonly currentRun?: {
    readonly runId: string;
    readonly initialTurnId: string;
    readonly activeTurnId?: string;
    readonly taskId?: string;
    readonly status:
      | 'queued'
      | 'running'
      | 'waiting'
      | 'completed'
      | 'failed'
      | 'cancelled'
      | 'recovery_required';
    readonly activeInteractionId?: string;
    readonly outcome?: RunTerminalOutcome;
  };
  readonly interactionQueue: RuntimeInteractionQueueProjection;
}
```

`activeInteractionId` 只引用 canonical queue，不复制第二份 interaction payload。保留 terminal `currentRun` 是为了让旧
`activeWork`、Agent API status、Host session registry、notification projector 与 completion query 在迁移期仍能得到确定的终态来源；
新 Run accepted 后再由新 identity 替换它。

### 5.5 Terminal closure

Runtime turn 外层建立唯一 terminal closure：

```text
normal
  completion guard
  → optional canonical Task completion fact（从现有完整 run.completed payload规范化）
  → Turn completed
  → Run completed

user cancel / approval reject
  Tool/Subagent/Capability cleanup
  → Turn aborted(user)
  → Run cancelled

deadline / fatal error
  failure outcome + cleanup
  → Turn aborted(error；deadline由 outcome reason表达)
  → Run failed 或 recovery_required
```

Run 建立前的失败使用 `commandId`；Run 建立后的失败必须使用真实 `runId`；无法关联的异常只能形成 Session diagnostic，不能使用
`'runtime-run'` 等固定 fallback，也不能解决 completion waiter。

当前 client `run.failure` 不是普通日志：它携带 retryable、recovery entry 与安全诊断，并参与失败 UI。迁移期完整保留；目标
`run.terminal(status=failed)` 必须内嵌等价 terminal outcome/recovery 数据。非终态诊断改走独立 Session/runtime diagnostic，不能继续
复用 `run.failure`。只有所有 Client、History、Agent API 与 failure-mode tests 已切换后，LFC-08 才删除旧分支；同一 live Run 不双发。

Task completion、Turn terminal、Run Store transition、terminal outcome 与 State snapshot 必须在同一 State/Store transaction
决定；对外 notification 只能在 commit 后发布。包含 `turn.completed` 的正常事务继续触发既有 named checkpoint 后置动作，不能因
事件改名或 client projection 调整而丢失 rewind 边界。内部 reducer 若因 completion guard 需要保持既有事件先后，可以保留内部顺序，
但 Client 必须从 committed projection 观察一致状态，不能把事务中间态当作下一 Run 的 admission 事实。

### 5.6 BudgetScope

本计划不修改 Resource Budget 的 State/event 持久 shape。现有 `resourceBudget.runId` 在 typed view 和文档中别名为
`budgetScopeId`，并明确禁止参与 Runtime Run waiter、query 或 terminal correlation；wire/history 仍保留原字段。

Budget scope 究竟绑定一个 Task、一个 continuation lineage 还是其他边界，需要独立方案回答 Plan draft、Provider continuation、
reservation/waiter/Subagent cleanup 与 restart 后的 close 语义。该持久化改名、`resource_budget.closed` 和 format epoch 不属于
LFC-00～08 的完成条件。

## 6. Client 与 TUI 生命周期

### 6.1 Per-Session 状态

```ts
interface TuiSessionRuntimeState {
  readonly authority: {
    readonly sessionId: string;
    readonly revision: number;
    readonly run: RunView;
    readonly activeTask?: TaskView;
    readonly interactionQueue: RuntimeInteractionQueueProjection;
  };
  readonly commands: {
    readonly promptSubmissions: ReadonlyMap<string, PromptSubmission>;
    readonly cancellation: CancelCommandState;
  };
  readonly presentation: {
    readonly requests: ReadonlyMap<string, RequestAssembly>;
    readonly thought?: ThoughtProjection;
    readonly tools: ReadonlyMap<string, ToolProjection>;
    readonly timeline: readonly TimelineItem[];
  };
  readonly render: RenderLifecycle;
}
```

Connection/subscription generation 是 RuntimeClient 的临时 transport fence，不是持久 Session authority，也不写入用户
SessionSnapshot。reconnect 后所有 Session authority view 先进入 `unknown/not_ready`，只有新 connection generation 的
reset/replay/snapshot 被接受后恢复。后台 event buffer 保存完整 accepted envelope，不保存裸 event。

### 6.2 Server Run view

```ts
type RunView =
  | { readonly state: 'unknown'; readonly sessionId: string; readonly revision: number }
  | { readonly state: 'idle'; readonly sessionId: string; readonly revision: number }
  | {
      readonly state: 'recovery_required';
      readonly sessionId: string;
      readonly runId: string;
      readonly revision: number;
      readonly reasonCode: string;
    }
  | {
      readonly state: 'active';
      readonly sessionId: string;
      readonly runId: string;
      readonly initialTurnId: string;
      readonly activeTurnId: string;
      readonly revision: number;
      readonly status: 'queued' | 'running' | 'waiting';
      readonly phase: 'planning' | 'building';
    }
  | {
      readonly state: 'terminal';
      readonly sessionId: string;
      readonly runId: string;
      readonly initialTurnId: string;
      readonly finalTurnId: string;
      readonly revision: number;
      readonly result: 'completed' | 'failed' | 'cancelled';
      readonly outcome: RunTerminalOutcome;
    };
```

RunView 只能由 applied receipt、accepted authoritative event、authoritative snapshot、exact Run query 与 reconnect recovery 推进。
`SET_RUNNING`、`model.requested`、Tool/Thought terminal、Promise、Ink flush、Footer 与 component unmount 均不得修改 Server Run 语义。
`recovery_required` 不是 terminal 或 idle：它阻塞 successor admission，不能正常 resolve Run Promise，也不能被显示成 cancelled/failed；
只有显式 resume/reconciliation 可以把它细化为 active 或 precise terminal。

### 6.3 Local command

```ts
type StartCommandState =
  | { readonly state: 'idle' }
  | { readonly state: 'reserved'; readonly sessionId: string; readonly promptId: string }
  | {
      readonly state: 'submitting';
      readonly sessionId: string;
      readonly promptId: string;
      readonly commandId: string;
    }
  | {
      readonly state: 'accepted';
      readonly sessionId: string;
      readonly promptId: string;
      readonly commandId: string;
      readonly runId: string;
      readonly revisionFloor: number;
    }
  | {
      readonly state: 'failed';
      readonly sessionId: string;
      readonly promptId: string;
      readonly commandId: string;
      readonly code: string;
    };
```

本地 Enter 只推进 `reserved/submitting`；receipt accepted 后才建立 Run identity。现有 `running` 在迁移期仅作为 selector，最终删除
独立写入。兼容 busy selector 必须包含：Server Run active、StartCommand reserved/submitting、CancelCommand
submitting/accepted 以及 Host cleanup/recovery pending；不能因删除本地 `SET_RUNNING` 产生 receipt 前的双提交窗口。

### 6.4 Run completion waiter

```ts
interface AcceptedRunIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly commandId: string;
  readonly revisionFloor: number;
}
```

唯一完成条件：

```text
result.runId == accepted.runId
&& result revision >= revisionFloor
&& result 来自 authoritative Run resource
&& result 是 completed | failed | cancelled precise terminal
```

保留 terminal-before-receipt candidate join。Query fallback 查询 exact Run resource；不能仅以 `activeWork` 缺失、TUI idle 或 Promise
finally 结束 waiter。Task/Turn terminal 只参与展示，不解决后继 Run callback。

`completed` 正常 resolve；`cancelled` 沿现有 facade 的取消语义收敛；`failed` 携带 terminal outcome 进入既有错误/恢复 UI；
`recovery_required` 不作为成功或 precise terminal，而是返回 typed recovery-needed 结果、保持 successor admission blocked，并等待显式
resume/reconciliation。Query 得到 read-only recovery projection 不得伪造 client terminal event。

### 6.5 Runtime event envelope

```ts
type TuiRuntimeEnvelope =
  | {
      readonly source: 'durable' | 'replay';
      readonly sessionId: string;
      readonly revision: number;
      /** RuntimeClient-local transport fence，不是 Session domain authority。 */
      readonly connectionGeneration: number;
      readonly event: RuntimeClientEvent;
    }
  | {
      readonly source: 'ephemeral';
      readonly sessionId: string;
      readonly connectionGeneration: number;
      readonly workId: string;
      readonly turnId: string;
      readonly actorId: string;
      readonly attemptId: string;
      readonly compositionRevision: string;
      readonly streamId: string;
      /** Model text/reasoning 必填；tool.progress 可省略并以 toolId/event identity 归属。 */
      readonly requestId?: string;
      readonly sequence: number;
      readonly event: RuntimeClientEvent;
    };
```

Native Client 先通过 connection generation/revision store 接受 notification，再 dispatch。durable notification 只有 store 返回
`applied` 才能进入 presentation reducer；`ignored`、同 revision 不一致与 `resync_required` 均不得 dispatch 原 event。
`resync_required` 将该 Session authority view 置为 `unknown/not_ready` 并触发既有重新订阅或精确 query。event revision 必须等于被接受
projection revision。

Ephemeral envelope 保留现有 work/turn/actor/attempt/composition/stream/sequence 全部 fencing identity，不能用单一 generation 替代。
sequence gap 使对应 RequestAssembly 进入 `presentation_incomplete`，在 history/snapshot/resubscribe 补齐前不得 seal；若当前 transport
无法提供完整性证明，LFC-04 必须先新增 explicit presentation-complete fact，再允许 LFC-06 消费。terminal 后的旧 ephemeral packet 按
`requestId + attemptId + streamId + sequence` 丢弃。

### 6.6 Prompt join

```ts
type PromptSubmission =
  | { readonly state: 'queued'; readonly submissionId: string; readonly text: string }
  | {
      readonly state: 'joining';
      readonly submissionId: string;
      readonly attemptCommandIds: readonly string[];
      readonly text: string;
      readonly receipt?: StartReceipt;
      readonly message?: DurableUserMessage;
    }
  | {
      readonly state: 'materialized';
      readonly submissionId: string;
      readonly acceptedCommandId: string;
      readonly messageId: string;
      readonly runId: string;
    }
  | {
      readonly state: 'failed';
      readonly submissionId: string;
      readonly lastCommandId: string;
      readonly code: string;
    };
```

本计划选择：logical `submissionId` 在 `runtime_busy` 重试间保持稳定，每次 wire attempt 使用新的 `commandId`；accepted start receipt
返回 canonical `runId + messageId`，其中 `messageId` 复用现有 `commandDerivedId(acceptedCommandId, 'message')` 的稳定推导；相同
accepted command 的 receipt replay 必须逐字返回相同 messageId，不新增临时 response-only identity，也不要求 SQLite receipt 另存第二份
可漂移值。随后 `user.message.messageId` 与之 join。文本不再是 identity。必须保持 receipt-first、message-first、
相同文本 prompt、第一条失败第二条成功、replay 与后台 Session 行为。该 receipt 扩展属于 LFC-04 exact contract 变更。

### 6.7 Cancel command

```ts
type CancelCommandState =
  | { readonly state: 'idle' }
  | {
      readonly state: 'cancel_after_accept';
      readonly sessionId: string;
      readonly submissionId: string;
    }
  | {
      readonly state: 'submitting' | 'accepted';
      readonly sessionId: string;
      readonly runId: string;
      readonly turnId: string;
      readonly commandId: string;
    }
  | {
      readonly state: 'failed';
      readonly sessionId: string;
      readonly runId: string;
      readonly commandId: string;
      readonly code: string;
    };
```

Esc/Ctrl+C 可立即显示 Cancelling，但不写 Run terminal。cancel receipt 失败恢复可重试状态；只有匹配 runId 的权威 terminal 才更新
RunView。receipt 已 accepted 但 projection 暂未到达时，仍按 accepted identity 发 cancel，不能因 `activeWork` 暂时为空直接返回。

在 start receipt 前按取消时：尚未发送的 local reservation 可以直接撤销；已经发送的 command 不能假设撤回，进入
`cancel_after_accept`。若 start 被拒绝则清除该状态；若迟到 receipt accepted，则立即使用 canonical runId/activeTurnId 发送一次
`cancel_turn`。新 contract 中 Run 已建立后的 cancel 必须要求 runId；旧 optional V1 shape 只存在 compatibility decoder，不能成为新 writer。

## 7. Presentation 与 Render 生命周期

### 7.1 RequestAssembly

```ts
type RequestAssembly =
  | {
      readonly state: 'collecting';
      readonly requestId: string;
      readonly text: StreamAssembly;
      readonly reasoning: StreamAssembly;
      readonly possibleThoughtId?: string;
    }
  | {
      readonly state: 'execution_terminal_seen';
      readonly requestId: string;
      readonly terminal: ModelResponseTerminal;
      readonly text: StreamAssembly;
      readonly reasoning: StreamAssembly;
    }
  | {
      readonly state: 'presentation_incomplete';
      readonly requestId: string;
      readonly expectedSequence: number;
      readonly observedSequence: number;
      readonly recovery: 'resubscribe' | 'history' | 'explicit_complete_fact';
    }
  | {
      readonly state: 'presentation_sealed';
      readonly requestId: string;
      readonly result:
        | { readonly kind: 'final_answer'; readonly components: readonly MarkdownComponent[] }
        | {
            readonly kind: 'tool_response';
            readonly presentationGroupId: string;
            readonly hiddenNarration?: string;
          };
    };
```

优先强化现有 Service presentation frame flush/barrier，不立即新增 wire event。只有 trace 证明 durable/ephemeral 边界仍不能封口时，才提出
`model.presentation_sealed` ADR。只要 RuntimeClient 允许 ephemeral 丢弃或 sequence gap，而 history/snapshot 又不能补齐，explicit complete
fact 就是 LFC-04 的前置条件，不得以 `model.responded` 猜测展示完整。

尚未分类内容只存在于 RequestAssembly，不作为隐藏 Timeline text block。最终删除 `responsePending` block 与相关创建/删除/恢复路径。
RequestAssembly 只保留当前 Run 中尚未 seal 或需要补齐的 request；一旦结果物化为 Timeline item 就立即删除完整 text/reasoning buffer。
不得把 sealed request 累积为第二份 history。LFC-00 必须从现有 protocol limits 固定单 request 字节上限和同时未决 request 上限；超限或
无法补齐的 gap 进入 `presentation_incomplete`，不得无限保留或静默截断后 seal。

### 7.2 Thought

```ts
type ThoughtProjection =
  | {
      readonly state: 'live';
      readonly thoughtId: string;
      readonly requestIds: readonly string[];
      readonly toolIds: readonly string[];
      readonly latestActivity?: ThoughtActivity;
      readonly modelDurationMs: number;
    }
  | {
      readonly state: 'sealed';
      readonly thoughtId: string;
      readonly result: 'done' | 'error' | 'cancelled';
      readonly summary: SealedThoughtSummary;
      readonly digest: string;
    };
```

等待 model terminal 是 RequestAssembly 状态，不再是 Thought 的 `awaiting_terminal`。`model.requested`、reasoning completed 与当前工具
全部 terminal 不单独关闭 Thought；final answer classification、standalone tool、interaction、retry/error/cancel 与安全 Turn/Run 收尾可以关闭。

### 7.3 Timeline

```ts
type TimelineItem =
  | {
      readonly state: 'live';
      readonly id: string;
      readonly kind:
        | 'thought'
        | 'tool'
        | 'subagent_group'
        | 'interaction'
        | 'structure'
        | 'compaction';
      readonly payload: LivePresentation;
    }
  | {
      readonly state: 'sealed';
      readonly id: string;
      readonly kind:
        | 'user'
        | 'text'
        | 'thought'
        | 'tool'
        | 'subagent_group'
        | 'interaction'
        | 'file_change'
        | 'local_notice'
        | 'legacy_reason';
      readonly payload: SealedPresentation;
      readonly digest: string;
    };
```

Tool、Thought、Subagent group、Interaction 与 text 的终态知识由 projector 消费一次。Renderer 不再从子工具状态、`active/result`、
resolved 或 streaming flags 生成第二份完成判断。

现有展示兼容映射必须显式保留：`reason → legacy_reason`、`file_change → file_change`、`LOCAL_TEXT/LOCAL_COMMAND` 与
recovery/error notice → `local_notice`、compaction progress → live `compaction` 或既有 chrome owner。LFC-06 不得以新 union 未列出为由
删除、合并或改变这些内容；完整 `OutputBlock kind → Timeline/local chrome owner` 清单属于 LFC-00 交付物。

### 7.4 RenderLifecycle

```ts
interface RenderLifecycle {
  readonly epoch: number;
  readonly staticCommitted: ReadonlyMap<string, string>;
  readonly dynamicPainted: ReadonlySet<string>;
  readonly terminal: 'mounted' | 'unmounting' | 'disposed';
}
```

目标数据流：

```text
LiveItem → SealedItem → 连续 sealed 前缀 → Static committed
```

迁移期间保留当前 Static prefix、fingerprint/reference stability、zero-height Static、synchronized output、resize/session remount 和
dynamic tail 限制。先增加 sealed digest/render ledger 断言，再在 PTY 证明等价后删除 renderer 中的 per-kind terminal 推导。

`staticCommitted` 只在 Ink `<Static>` commit 已由 render adapter 确认后写入，不代表 commit planner 的意图。相同 epoch 内同 ID
不同 digest 是 invariant failure；新 epoch 可以重建物理 owner，但必须先完成既有 clear/synchronized-output barrier。对已经进入
`dynamicPainted` 的 item，只有当前 PTY 已证明的 ownership transfer 才允许即时 Static；其他类型保持 dynamic 至新 epoch，不引入未经
验证的通用游标擦除协议。

Render quiescent 只表示没有待输出 frame，不能表示 Server idle 或允许新 Run。TUI unmount/dispose 不取消 Server Run。

## 8. 旧新行为对比

| 场景 | 旧判定 | 新判定 |
| --- | --- | --- |
| 用户按 Enter | 本地 `SET_RUNNING` 可能先令 TUI running | `StartCommand.reserved/submitting`；receipt 后建立 RunView |
| Run 开始 | receipt、user message、model requested 都可能表现为开始 | applied receipt + canonical Run resource |
| Run 完成 | task/turn/run terminal、idle projection、Promise 可能相互影响 | exact runId + revision floor 的 Run terminal/query |
| Provider continuation | 新 Turn 可能丢失原 Store Run identity | Run identity 稳定，activeTurnId 前移，仍终结原 Run |
| Recovery unknown | 可能被 terminal/idle selector 压平 | `recovery_required` 阻塞态，不正常 resolve 或 admit successor |
| Plan draft pending | Turn terminal 可能把整个 activeWork completed | Run/Turn completed，Task 保持 active |
| Cancel | 本地 pending 与 Server terminal 容易混用 | CancelCommand 与 RunView terminal 分开 |
| 错误 | 缺 identity 时使用固定 runId | command failure、real Run terminal 或 Session diagnostic |
| Session switch | 保存 `running` 布尔值 | 恢复完整 per-Session RunView/command/presentation |
| Prompt echo | 主要按文本 join | promptId/commandId/messageId join |
| Model response | 标量 current fields 与隐藏 block | RequestAssembly Map 与一次分类 |
| Thought | active/pending/result/phase 组合 | LiveThought 或 SealedThought |
| Static | renderer 理解各业务 terminal | projector 发布 sealed，renderer 只提交 |
| Exit | `SET_EXITED` 可能连带清运行态 | render disposed 与 Server Run 完成无关 |

## 9. 必须保持的功能场景

| 场景 | 必须保持的事实 | 目标权威 | 主要回归风险 |
| --- | --- | --- | --- |
| 普通回答 | prompt、answer、terminal 最终唯一 | Run resource + prompt join | terminal 提前/重复 |
| Task 跨 Turn | Task 可继续接受 successor Turn | Task lifecycle | Turn terminal 误结束 Task |
| Plan draft pending | Turn/Run 完成，Task/Plan active | Task/Turn/Run 分离 | 无法继续 Plan |
| Provider Action continuation | 同一 Run 创建 continuation Turn，最后仍使用原 runId | stable execution handle | Run row 泄漏、terminal 错绑新 Turn |
| Plan review | receipt 前不关闭，批准后恢复原 Turn | interaction queue | 重复提交/丢 identity |
| ask_user answer/cancel | 解决对应 interaction/tool，不自动 cancel Run | interaction/tool | whole-run 误取消 |
| Approval reject | target rejected、siblings cancelled、Turn aborted 原子提交 | Server transaction | sibling 继续执行 |
| Ctrl+C | 立即显示 Cancelling，terminal 后真正 cancelled | CancelCommand + Run terminal | 本地假 idle |
| receipt 前 Ctrl+C | 未发送 reservation 本地撤销；已发送 command 等 receipt 后立即 cancel | cancel-after-accept | accepted Run 被遗忘 |
| Deadline/fatal | cleanup 后 precise failed；无法确认时 recovery_required | Host closure | Store Run 残留 active或误放行 successor |
| Model/Tool retry | 不创建新 Run，unknown effect 不重放 | 子生命周期 | 旧事件污染 successor |
| Subagent | 同组终态后 seal，cleanup 前 successor busy | child/group + Host | 过早 Static/过早 admission |
| Prompt FIFO | 每 Session 独立，相同文本可区分 | prompt identity | 串 Session/误删 echo |
| Terminal-before-receipt | candidate 与 receipt 按 identity join | accepted Run identity | waiter 丢失 |
| Stale snapshot/event | 不结束 successor，不清新 interaction | generation/revision | 状态回退 |
| Reconnect/replay | 不自动重放 mutation，live/history 等价 | RuntimeClient/History | 重复事件/旧 authority |
| Ephemeral gap | sequence gap 不得 seal 不完整回答 | stream fencing + recovery/complete fact | 截断正文被提交 Static |
| Multi-session | 后台 terminal 不修改前台 | Session envelope | foreground 污染 |
| TUI exit | detach/unmount，不隐式 cancel | render/client lifecycle | Server 工作被误停 |
| Service shutdown | Server 自己 cancel/drain/cleanup | operation owner | 进程早退 |
| Run query/recovery | GET 不触发恢复；resume 才恢复 | Host/Store | 只读查询产生副作用 |
| Fork/rewind/delete | 只处理允许的 settled boundary | Store transaction | State/Run 不一致 |
| Static/PTY | 每项一次、零空闲 stdout、滚动不跳 | sealed + render owner | 重复 scrollback |

## 10. 实施阶段

### LFC-00：基线、词汇与 ADR

状态：completed（2026-09-04；基线见 `docs/space/understanding/2026-09-04-server-tui-lifecycle-baseline.md`，
决策见 ADR-0173）

- 固定 Task、Turn、RuntimeRun、BudgetScope alias、SessionOperation、RunView、Presentation 与 Render 的定义；
- 新增 ADR，明确 `runId=initialTurnId` 的 V1 创建兼容、同 Run Provider continuation Turn、Work 不是领域实体、
  precise terminal 与 recovery-required 分离、三层 terminal 不可互相替代；
- ADR 固定稳定 Run identity 由唯一 active Run row + transaction revision + current Turn 联合证明；continuation 与 terminal 都使用该
  stable row，无法唯一恢复时 fail closed；
- 定义 `CanonicalTaskCompletionFact` normalization，完整保留现有 raw `run.completed` 的 output、guard version、plan identity、outcome、
  transaction 与 checkpoint 边界；raw event 改名另立后续 format 计划；
- 采集 normal、plan、Provider Action continuation、approval、cancel-before/after-receipt、retry、recovery、ephemeral gap、replay、
  multi-session、exit、Static 的输入/输出 trace；
- 为每条 trace 保存 Server event/revision、Task/Turn/Run projection、Client event、TUI Timeline 与 PTY evidence；
- 不修改生产行为。

完成门禁：已知生命周期问题都有稳定 reproduction；current behavior 与目标变化逐项登记；完成阶段
`overengineering-check`，不得建立无消费者的新协议或状态。

### LFC-01：Server 内部 view 与 identity assertion

状态：completed（2026-09-04；stable execution handle、continuation Run row、pure activeWork compatibility、busy recovery与
fake identity清理已完成）

- 引入 `RuntimeExecutionHandle(runId/initialTurnId/activeTurnId)`、TaskView、RunView、BudgetScope alias；
- `activeWork` 改为纯 compatibility projector，不再由 terminal helper 就地维护；
- 修复 recovery 将 active `running|waiting` 都视为 busy；
- 删除 `'runtime-run'` fake identity；
- Run/initial Turn/continuation Turn/receipt identity、revision 与 single-active-Run invariant 加强断言；
- 盘点并覆盖 `CliRuntimeBridge`、bootstrap stored-snapshot builder、Host session registry、notification projector、Protocol mapper、
  RuntimeClient snapshot store、Agent API read adapter、foreground CLI 与 History adapter；
- 明确 Run-resource-enabled current App Server 路径使用 Run Store；`supportsRunStorage()===false` 的 legacy/test 路径只保留
  compatibility terminal，必须在 LFC-04 前迁移或从 production/release qualification 排除；
- 保持 V1 wire 与 Store schema 不变。

完成门禁：现有 activeWork golden 尽量不变；normal/plan/cancel/recovery、Host Run 与 Store 测试通过。

### LFC-02：Server 唯一 terminal closure

状态：completed（2026-09-04；continuation terminal使用stable Run row，bridge unexpected/flush failure进入原子
unknown outcome + Turn abort，normal/cancel/deadline/approval/recovery定向矩阵通过）

- 所有 normal、cancel、deadline、approval reject、recovery failure 与 unexpected return 走统一收口；
- Task、Turn、RuntimeRun 分别终结，禁止 `terminalizeActiveWork()` 跨实体传播；
- continuation Turn 结束同一个 stable Run，不按 final turnId 寻找新的 Run row；
- 每个 accepted Run 最终恰有一个 real-identity precise terminal，或进入显式 `recovery_required` 阻塞态；
- cleanup incomplete 保持 recovery_required/outcome_unknown，不伪造 precise terminal 或 completed；
- 先持久化 terminal/cleanup facts，再传播 AbortSignal 的既有顺序不变。
- Task/Turn/Run mutation、terminal outcome、snapshot 在同一事务决定；`turn.completed` named checkpoint 后置动作保持。

完成门禁：所有早退路径无 active Turn/Run 泄漏；successor admission、Subagent cleanup 与 cancellation tests 通过。

### LFC-03：Client Run completion fencing

状态：completed（2026-09-04；AcceptedRunIdentity、terminal-before-receipt join、exact Run query fallback与
recovery-required/failed fencing完成）

- Native client 分离 local reservation、accepted Run、terminal candidate 与 Server Run status；
- completion waiter 绑定 `sessionId/runId/commandId/revisionFloor`；
- terminal-before-receipt 按 identity join；
- query fallback 查询 exact Run，不以 activeWork 缺失单独结束；
- Task/Turn terminal、model/tool terminal、Ink flush 与 finally 均不能完成 Run Promise；
- 保持 `runTask()/waitForRunCompletion()/tryReservePrompt()` facade。

完成门禁：全部 out-of-order、stale projection、busy successor、terminal gap 与 replay tests 通过。

### LFC-04：Contract 与 Session projection 收敛

状态：completed（2026-09-04；projection v2 activeTask/currentRun、stable live/history terminal、derived receipt messageId、
required cancel runId、accept-before-dispatch与gap resubscribe完成）

- 引入 `activeTask`、带 active/terminal/recovery-required 的 `currentRun` 与 real-identity terminal projection；
- Provider continuation transaction 推进唯一 active Run row，Host terminal 从 committed Run transition 生成，不修改 current
  State/event format；
- interaction 只通过 `activeInteractionId` 引用 canonical queue；
- durable envelope 携带 Session/revision 与 RuntimeClient-local connection generation；ephemeral envelope 完整保留
  work/turn/actor/attempt/composition/stream/sequence fencing；Run terminal 带真实 runId；
- accepted start receipt 返回由 accepted commandId 稳定推导的 canonical messageId + runId，receipt replay 完全一致；logical
  submissionId 与 busy-retry commandId 分离；
- canonical Task completion normalizer/reducer/projector/history 全链路切换，保留 raw writer、legacy filter、
  output/guard/plan/outcome、stable runId、同事务 Run transition 与 named checkpoint；
- Run 建立前失败改为 command failure；无法归属只发 Session diagnostic；
- exact protocol/schema version 切换，同一 connection 只发布一种 vocabulary；
- 旧 `activeWork` 由 compatibility mapper 短期输出，明确删除 tranche。

完成门禁：Runtime Contract/Protocol/Server/Client/InProcess/JSON conformance、History live/replay 等价、same-build default 与 daemon
compatibility tests 通过。

### LFC-05：TUI RunView、command 与 Session identity

状态：completed（2026-09-04；per-Session runtimeAuthority、Start/Cancel command state、currentRun selector、
cancel-after-accept与Session切换保存完成）

- 每 Session 建立 RunView、StartCommand、CancelCommand 与 PromptSubmission；
- Native client 只 dispatch 已被 generation/revision store 接受的 event envelope；
- `SET_RUNNING` 降级为 local command/presentation action，`running` 改为 selector；
- `cancellationPending` 绑定 runId；receipt 前取消使用 cancel-after-accept；accepted 但 projection 尚未到达时仍正确发送；
- SessionSnapshot 保存完整 domain authority identity但不持久化 connection generation；背景 buffer 保存 accepted envelope；
- Footer、输入许可与 queued prompt 只使用 selector，不写回 Server Run 状态。

完成门禁：prompt FIFO、receipt/message/terminal 乱序、cancel、session switch、multi-session 与 TUI reducer tests 通过；用户可见布局
和文案不改变。

### LFC-06：Prompt、Request、Thought 与 Timeline projection

状态：completed（2026-09-04；messageId/FIFO prompt join、bounded RequestAssembly、Timeline live/sealed projector与
OutputBlock单向render compatibility完成）

- prompt join 改用 promptId/commandId/messageId；
- 标量 current request fields 迁入 `Map<requestId, RequestAssembly>`；
- 未分类正文留在 RequestAssembly，不创建隐藏 Timeline text；
- Thought 改为 `LiveThought | SealedThought`，删除其 `awaiting_terminal` authority；
- Tool/Subagent/Interaction projection 一次性发布 `LiveItem | SealedItem`；
- 先通过 compatibility adapter 继续生成现有 OutputBlock，避免同时重写 renderer。

完成门禁：reasoning/tools/final ownership、retry、late event、approval/input/subagent、相同文本 prompt 与 replay tests 通过。

### LFC-07：Render lifecycle 与 Static owner

状态：completed（2026-09-04；RenderEpoch/commit ledger、Store 8 PTY fixture、终态摘要封口与同 revision MCP
poll 静默完成，cancel-successor/long-answer/subagent/resize 真实 PTY 全部通过）

- 引入 sealed digest、RenderEpoch 与 commit ledger；
- renderer 只消费连续 sealed 前缀和 dynamic suffix；
- 保留现有 Static prefix、fingerprint、zero-height Static、synchronized output 与 dynamic tail；
- 真实 PTY 证明行为等价后，删除 `isBlockSettledInRun` 中的业务终态推导；
- resize/session switch/presentation remount 只通过明确 render epoch 改变物理 owner；
- unmount/dispose 与 Server Run terminal 分离。

完成门禁：Static/scrollback/focus/resize/overlay/long-answer/subagent PTY；每个 block 只出现一次；完成后零 stdout。

### LFC-08：退休客户端/TUI兼容层

状态：completed（2026-09-05；依赖计划
[`TUI Message Projection & Rendering Convergence`](2026-09-05-tui-message-projection-rendering-convergence.md)
已完成；generation/identity fencing、reducer-owned Timeline、复杂PTY矩阵与兼容层清理全部收敛）

- 保留 current raw `run.completed` writer，但所有领域逻辑只消费 canonical Task completion normalization；事件改名另立未来计划；
- 统一 client Run terminal vocabulary，删除 `run.failure` 重复分支；
- 删除 `activeWork`、独立 `running`、Timeline `responsePending`、`thoughtPhaseStatus` 与迁移 compatibility selectors；
- Resource Budget 只保留 typed-view `budgetScopeId` alias 和跨域禁止规则；持久字段/scope terminal 另立后续计划；
- 删除 test-only shadow projection，不保留永久双状态。

完成门禁：全量 runtime/CLI/TUI/release/qualification/docs gates；最终完整 diff 执行 `overengineering-check`。

## 11. Task 执行矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| LFC-00 | 当前源码/测试 | ADR、trace/golden、本计划确认 | docs、现有 baseline tests | 无生产变化，可直接撤销文档/fixture |
| LFC-01 | LFC-00 | Server typed views、continuation mapping、consumer inventory、compatibility activeWork | Kernel/Host/Store/Service/API/CLI projection | 保留 V1 wire/schema；回滚内部 projector |
| LFC-02 | LFC-01 | unique terminal closure、early-return convergence | completion/cancel/recovery/Subagent | 不改 Store shape；回滚前保留 terminal leak tests |
| LFC-03 | LFC-02 | Native client accepted Run/waiter fencing | service-mode TUI client ordering tests | facade 不变；可回滚内部 state machine |
| LFC-04 | LFC-03 | Contract/Protocol/currentRun、completion payload、receipt message identity | contract/protocol/server/client/history/release matrix | exact version fail closed；不得 dual publish |
| LFC-05 | LFC-04 | per-Session RunView/command/prompt identity | TUI reducer/FIFO/session/cancel | 旧 fields 暂作 selector；不得恢复第二权威 |
| LFC-06 | LFC-05 | RequestAssembly/Thought/Timeline + OutputBlock adapter | ownership/retry/replay/interaction | adapter 单向；逐实体回滚，不 dual write |
| LFC-07 | LFC-06 | RenderEpoch/sealed/commit ledger | Ink + PTY scroll/focus/resize | 保留当前物理策略直至 PTY 通过 |
| LFC-08 | LFC-07、TMR-08 | 客户端/TUI旧语义与兼容层删除 | full runtime/CLI/TUI/release/qualification | 跟随 ADR-0174 exact format candidate；无 live fallback |

## 12. 定向验证矩阵

### 12.1 Server

- normal completion：Task/Turn/Run 各自恰好一个 terminal；
- `plan_draft_pending`：Turn/Run completed，Task active；
- Provider Action：同一 Run 从 initial Turn 前移到 continuation Turn，最终 terminal 仍匹配原 runId；
- Provider Action 提交 continuation 后重启：State/Run row 可恢复原 runId，live/history terminal identity 相同；
- approval reject：target rejected、siblings cancelled、Turn aborted、Run cancelled；
- ask_user cancel：按当前产品语义只结算对应 interaction/tool，不误 cancel Run；
- Ctrl+C/deadline/fatal/recovery failure：cleanup 后 Run cancelled/failed，不能确认时进入 recovery_required；
- unexpected generator return：不得留下 running Run；
- restart nonterminal query：只读 unknown/recovery_required，不触发 recovery；
- resume：显式 recovery，不重放 unknown effect；
- fork/rewind/delete：只接受允许的 settled boundary，receipt 语义不变；
- multi-client：同 command/interaction 只有一个 applied，其余 replay/conflict。

### 12.2 Native Client/TUI projection

- receipt-first、message-first、terminal-first；
- accepted receipt response loss/idempotent replay 返回相同 derived messageId/runId；
- receipt 前取消、accepted receipt 迟到与 cancel-after-accept；
- 相同文本的连续 prompt、第一条失败第二条成功；
- stale snapshot/event、旧 generation、旧 Run terminal；
- terminal notification gap + exact Run query fallback；
- active Run cancel 在 projection 尚未到达时仍发送；
- cancel failure 不产生本地 terminal；
- foreground/background Session 隔离；
- live/replay 同一 messageId、toolId、interactionId 幂等；
- historical pending interaction 不自动取得 settlement authority。
- durable notification 只有 snapshot store `applied` 后才 dispatch；ignored/resync-required event 不进入 reducer；
- ephemeral sequence gap 进入 presentation_incomplete，不提交截断结果。

### 12.3 Presentation/PTY

- pure reasoning、tool-only exploration、reasoning→tools→reasoning→final；
- tool-bearing narration 不形成重复 Thought/text；
- Markdown 段落/列表/表格/围栏代码边界；
- standalone tool、并发 Subagent、approval/input/plan block seal；
- 每个 user/tool/thought/subagent/text 只出现一次；
- 完成后输入、focus、timer tick 为零 stdout；
- resize/session switch 后历史正确重绘，不串 Session、不重复 scrollback；
- 用户向上滚动后不被空闲刷新拉回；
- TUI exit 先 unmount/恢复终端，再有界清理，不隐式 cancel Server Run。

### 12.4 Projection consumer 清单

LFC-01 必须形成机器可审查的完整清单，至少覆盖：

| Consumer | 当前依赖 | 迁移要求 |
| --- | --- | --- |
| `CliRuntimeBridge` | process-local `#running/#activeWork` | 从 Task/Run/operation view 纯投影，不就地 terminalize |
| bootstrap stored-snapshot builder | State/interaction 恢复 activeWork | 普通 running、waiting 与 continuation Run 均可恢复 |
| Host session registry | same-revision cleanup enrichment | 保留 cleanup enrichment，不把 recovery_required 当 idle |
| Host notification projector | active owner 与 ephemeral fencing | 使用 stable runId/activeTurnId，保留完整 stream identity |
| Runtime Protocol mapper/codec | exact Session/event shape | 新旧 version 各自 exact，unknown fields fail closed |
| RuntimeClient snapshot store | revision/generation/reset | accept-before-dispatch，resync 后 Session unknown |
| Native TUI client | run waiter/query/cancel/FIFO | exact Run identity，不读取兼容 Work 作为完成权威 |
| foreground CLI | terminal loop | 与 TUI 使用相同 Run terminal 规则 |
| Agent API read adapter | Session running/waiting/terminal status | 从 currentRun/activeTask 投影，不丢 terminal status |
| History adapter | legacy event 展开 | 经 State/history normalizer 后再生成 client presentation |
| TUI reducer | presentation 与 interaction | 使用 accepted envelope，不直接读取 raw Server State |

新增、遗漏或仍消费 `activeWork/running/run.completed/run.failure` 的 production 路径必须在 LFC-04 前登记，不能以测试未命中视为
无消费者。

### 12.5 History 与 live 语义等价

保留两个边界，禁止合并成一个含糊的 normalizer：

1. **State/history normalizer**：读取旧持久事件，使用 pre-event State 恢复 Task/Run/Turn identity，完整保留 output、guard、plan identity、
   outcome、revision 与 checkpoint 边界；它不生成 TUI block；
2. **Client presentation projector**：把 canonical current facts 转为安全 client events；live 与 history 共用同一 closed vocabulary，
   保留旧 reasoning segment ID、request identity 与 presentation group 的既有推导规则。

“live/history 等价”不是事件字节相同，而是对同一 durable事实满足：

```text
Task/Run/Turn identity 与 terminal outcome 相同
Interaction queue replacement 相同
Tool/Subagent terminal 相同
最终 Timeline item 顺序、kind、sealed payload digest 相同
```

ephemeral reasoning 仅在已有 current history contract 能重建时纳入 digest；无法重建的 live-only activity 不得改变 durable final answer、
Tool、Thought summary 或 Static 历史。Observer history 不触发 legacy import、Host recovery 或 mutation。

### 12.6 Release、daemon 与 rollback 兼容矩阵

| 组合 | 预期 |
| --- | --- |
| old client → old daemon | 保持当前行为 |
| old client → new daemon | protocol/capability 不匹配时 fail closed；不得自动升级或降级 daemon |
| new client → old daemon | fail closed并给出 matching client/daemon 诊断 |
| new client → new daemon | 使用单一新 vocabulary，不 dual publish |
| default same-build stdio | client/server 同 candidate 原子切换 |
| upgrade 时旧 daemon active | 不停止、不替换；新 client 不能连接不兼容旧 daemon |
| new binary 读取 current history | 使用相同 current format，经纯 State/history normalization 解释旧命名 |
| old binary 读取本计划写入的 history | 持久 State/event format 不变；必须由 current-format replay regression 证明 |
| rollback | 只切完整 candidate；本计划不引入新持久 format，不需要 fallback reader或数据库改写 |

LFC-04 必须提供 source/installed、parent-owned stdio、显式 daemon、macOS/Linux/Windows 的 exact version/capability 测试。任何新
State/event semantic 若旧 candidate 无法读取，rollback 支持边界必须在发布前明确，不能仅声明“切回 active pointer”。

## 13. 兼容策略

### 13.1 保留

- State/Event/Revision/Transaction 与单一 Kernel reducer authority；
- `runtime_runs` 表、Run Store CAS、Run query/fork/rewind/recovery；
- V1 `runId === initialTurnId` 创建兼容；Provider continuation 保留 stable runId；
- applied receipt replay 与 start transaction；
- RuntimeClient generation、snapshot replacement、interaction queue；
- per-Session prompt FIFO；
- current presentation frame barrier；
- current Static/PTY 已验证机制；
- default same-build App Server 与 explicit daemon exact compatibility；
- TUI exit detach、Service shutdown cancel/drain。
- Run-resource-enabled current App Server path 的 Run Store；run-storage-disabled legacy/test path 在切换前有显式清单和退出条件。

### 13.2 禁止

- production feature flag 分流两套生命周期；
- dual Host、dual Store、dual terminal、dual writer；
- `try-new-catch-old` 或 fallback execution；
- TUI 读取 Kernel State/Store concrete；
- Work 新增领域 authority；
- 无真实消费者的 Run/Turn ID 分裂；
- 数据库在线重写；
- 用 UI/Promise/Ink 状态补造 Server terminal。

### 13.3 允许的迁移工具

允许 test/dev-only shadow projection：同一 authoritative event stream 同时送入旧 compatibility projector 与新 normalized projector，
只比较结果；不得持久化、发布、admit command、触发 cleanup 或决定 terminal，parity 后删除。

协议变化使用 exact version。一个 live connection 只发送一种 lifecycle vocabulary；History adapter 负责旧事件 normalization。

## 14. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| Task active、旧 activeWork 却 terminal | 内部 Task/Run view 分离；plan draft golden 固定 |
| 旧 `run.completed` 同时像 Task/Run | 单一 normalization；新 live 不双发 |
| terminal-before-receipt | terminal candidate + canonical runId/revision floor join |
| query fallback 误结束 successor | exact Run GET，不以 activeWork absence 单独判断 |
| accepted Run 尚未投影时 cancel 被吞 | CancelCommand 使用 receipt identity，不依赖 activeWork 可见性 |
| stale notification 污染当前 TUI | Native accept-before-dispatch + Session/generation/revision envelope |
| 同文本 prompt 误 join | promptId/commandId/messageId，不以文本为 identity |
| Request/Thought 重构改变展示 | OutputBlock compatibility adapter + ownership golden |
| Static 重复或滚动跳动 | 保留当前策略；sealed ledger 先观察；真实 PTY 后切换 |
| 兼容层永久化 | 每个 Task 指定删除 tranche；阶段/最终 overengineering gate |
| BudgetScope 扩大主线 | 本计划只做 alias/隔离；持久 rename 与 close 另立后续计划 |
| 实施时工作树存在同 authority dirty diff | 先冻结/合并对应改动，或使用独立 worktree 与唯一 Git owner |
| Provider continuation 丢 Run identity | Run handle 保留 initial/active Turn；terminal 按 stable runId，不以 final turnId 查 Run row |
| recovery unknown 被当 terminal | 使用 recovery_required 阻塞态；显式 recovery 后才精确终结 |
| raw/normalized completion 不等价 | CanonicalTaskCompletionFact 完整保留 output/guard/plan/outcome，事务与 checkpoint 同步验证 |
| ephemeral fencing 被简化 | 保留现有 owner/attempt/composition/stream/sequence 全 tuple |

## 15. Rollback

1. LFC-01～03 只改内部 view/closure/client state，可在保持新增 regression tests 的前提下逐阶段回滚；
2. LFC-04 协议切换按 exact version 整体回滚，不允许一端新一端旧或 live dual event；
3. LFC-05～06 保留单向 OutputBlock compatibility adapter，按实体回滚 projection，但不得恢复多完成权；
4. LFC-07 在 PTY 未通过前保留当前物理 owner；若新 ledger/commit planner 回归，回滚到已验证 Static 行为；
5. 本计划保持 current State/event format，rollback 只切完整 candidate；不得借机增加 fallback reader、写回旧 Store或删除
   history normalization；未来 raw event 改名必须另立 format/rollback 计划；
6. 任一阶段发现需要第二 Host、第二 Store、长期 dual state、自动历史重写或无法证明的终端擦除协议，阶段保持
   `in_progress/blocked`，不得以兼容名义继续扩张。

## 16. 完成定义

只有同时满足以下条件，本计划才能标记 completed：

1. Run-resource-enabled production path 的每个 applied start receipt 对应唯一 stable Run；Provider continuation Turn 不创建孤立
   Run；每个 Run 最多一个 precise terminal；run-storage-disabled compatibility path 已迁移或明确退出 production；
2. Task、Turn、Run 的终态互不替代；
3. Plan draft pending 能安全跨 Turn；
4. 所有 early return 均收敛 Turn/Run或进入 recovery_required，不留下无 owner 的 active resource；
5. Client completion 只接受 exact runId/revision；
6. TUI `running`、cancel、prompt、Session switch 不再拥有 Server terminal 权力；
7. Request/Thought 不再通过非法布尔组合表达 ownership；
8. Renderer 不再推导业务 terminal；
9. live/history/reconnect 按 §12.5 的 identity/outcome/Timeline digest 语义等价；
10. Static/PTY 无重复、无空闲 stdout、滚动稳定；
11. 迁移 compatibility/shadow authority 已删除；
12. owner README、`docs/active/`、新 ADR、文档映射与验证共同收敛；
13. 每个 tranche 与最终完整 diff 均完成 `overengineering-check`；
14. canonical Task completion normalization 完整保留 raw output、guard、plan identity、outcome、同事务 Run transition 与 named checkpoint；
15. recovery_required、ephemeral gap、cancel-before-receipt 与 stale notification 均按 fail-closed 状态机收敛；
16. stage/commit/push/PR 前完成 `document-before-commit`、`check:docs-impact`、`check:docs` 与相关验证。

## 17. 三方审查记录

审查日期：2026-09-04

| 审查方 | 初审结论 | 主要阻塞 | 最终结论 |
| --- | --- | --- | --- |
| Server lifecycle | changes requested | Provider continuation 反证 Run/current Turn 1:1；stable runId 缺恢复承载；completion payload/transaction 不完整 | approve，无剩余 P0/P1 |
| Client/TUI lifecycle | changes requested | recovery_required、accept-before-dispatch、ephemeral gap、prompt/cancel identity、Timeline/Static owner 不完整 | approve，无剩余 P0/P1 |
| Migration/regression | changes requested | persistent format、history normalizer、consumer/release矩阵、ephemeral tuple、receipt messageId replay 不完整 | approve，无剩余 P0/P1 |

审查后完成的关键修订：

1. Run 改为 stable accepted-command scope：创建时 `runId=initialTurnId`，Provider Action 可以在同一 Run 内建立 continuation Turn；
2. 保持 current State/event format，不给 Turn 新增持久字段、不退休 raw `run.completed`；stable Run 由唯一 active Run row、
   transaction revision 与 current Turn 联合证明，不能证明时进入 recovery_required；
3. 引入内部 `CanonicalTaskCompletionFact`，完整保留 output、guard、plan identity、outcome、同事务 Run transition 与 named checkpoint；
4. 区分 precise terminal 与 recovery_required，后者不 resolve normal completion、不 admit successor；
5. durable notification 只有 RuntimeClient snapshot store `applied` 后才进入 TUI；ephemeral 保留完整 fencing tuple并处理 sequence gap；
6. prompt 使用稳定 submissionId、每次 retry commandId 与 accepted-command-derived messageId；补充 cancel-before-receipt；
7. 补齐 activeWork consumers、run-storage-disabled compatibility path、History/live语义等价和 release/daemon/rollback矩阵；
8. BudgetScope 持久改名与 close 明确移出本计划，避免扩大主线和引入新 format。

三方 approve 表示本计划可以进入 LFC-00 基线与 ADR 阶段，不表示实施已经开始，也不改变当前源码、测试、workspace README、
`docs/active/` 与 accepted ADR 的 authority。
