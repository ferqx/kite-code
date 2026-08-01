# ADR-0049：按副作用感知的只读并行调度与执行态展示

状态：accepted
日期：2026-07-29
关联：ADR-0001、ADR-0030、ADR-0043、ADR-0047
取代：ADR-0047 第 7 条的 queued 未来块保活与渲染层隐藏方案

## 背景

模型一次响应可以声明多个工具调用。Runtime 必须先把这些调用持久化进队列，才能保持
assistant tool call 与 Tool Result 成对、支持交互屏障、取消后续 sibling 和崩溃恢复。
因此，队列是必要的内核事实，但不代表每个调用已经开始执行。

原调度器把整个队列收敛到单工具执行通道。结果是一个长时间 Shell 即使已经被证明只读，
也会阻塞后面的 `read_file`、`search_content` 等独立读取。与此同时，TUI 在
`tool.queued` 时就创建可见块，再依赖 OutputArea 隐藏执行前沿之后的块。这使渲染树包含
尚未发生的未来工作；当前调用被取消或失败时，原先隐藏的 queued 块可能短暂显现，甚至被
结算成用户从未见过的 Cancelled 块。

## 决策

1. Runtime 保留完整、持久的工具队列。`tool.queued` 只表示模型声明已被接受并等待调度，
   不表示执行已开始。
2. Scheduler 可以把**连续**且满足全部条件的调用组成一个 `run_tools` effect：
   - 入队时已经持久化为 `effectClass=read_only` 且 `sideEffect=false`；
   - 属于无交互语义的受信任内置读取工具；
   - Approval Policy 以当前 phase、workspace 和 authorization 再次判断为 allow 且无需审批。
3. 一个并行批次最多包含 4 个调用。遇到 `ask_user`、Plan/Skill/Task/Tool Search 控制工具、
   动态 MCP、已批准后恢复的调用、写入、外部副作用、未知分类或任何需要审批的调用时立即
   停止组批；屏障调用保持独占执行。屏障之后的读取不能越过它。
4. Effect Executor 对批次内的调用分别进入同一 Tool Controller 执行链并发执行。每个调用
   仍独立产生 started/progress/terminal Runtime Event；Kernel 的事件入口继续串行归纳和
   持久化。完成先后不改变 assistant 声明的 Tool Result 上下文顺序。
5. 同一模型消息、同一任务中的 Shell sibling 采用逐调用放行。一个调用获批后立即启动；
   它发出 `tool.started` 后，Runner 可以在其执行期间继续请求下一个 sibling 的审批，
   后一个获批后同样立即启动。该重叠不能跨越非 Shell、不同模型消息、不同任务或其他交互
   边界。并发 Shell lease 只接受同一 turn、属于该 effect 且调用仍处于相容生命周期的事件，
   因此取消后的迟到进度或结果不能覆盖终态。`tool.execution_ready` 只保留旧回放兼容。
6. 用户显式拒绝或取消任一工具审批时，Kernel 原子写入当前目标的 `approval.rejected`、
   其余未终结 sibling 的 `tool.cancelled` 和 `turn.aborted(cause=user)`。Runner 立即退出，
   Agent abort 本轮执行信号；后续审批、queued 工具和模型调用都不得继续。策略拒绝、
   sandbox 缺失、系统自动审查失败以及 `ask_user` 拒答不属于该用户取消语义；`ask_user`
   取消只形成失败 Tool Result，模型继续同一 turn。方案执行确认属于授权屏障：取消
   `request_plan_review` 时保留 draft，取消方案工具和其余未终结 sibling，写入
   `turn.aborted(cause=user)`，Runner 不得继续调用模型。
7. TUI 不在 `tool.queued` 时创建 `tool_card` 或 `tool_summary`，只在临时状态中保存
   `callId → name/args`。审批载荷与待授权命令只进入 Footer interrupt；调用只有收到
   `tool.started`，或在开始前直接失败且需要展示诊断时，才物化可见块。
8. 启动前的 `tool.cancelled` 与审批拒绝只删除临时元数据，不展示取消或失败工具卡；已经
   开始的块仍按实际终态收尾。OutputArea 不再推断或隐藏执行前沿。

## 后果

- 只读 Shell 与同批独立读取可以重叠，长时间只读调用不再制造全局串行阻塞。
- Shell 获批后立即开始；用户处理后续审批时，已经批准的命令不会空等。
- 取消任一工具审批会明确终止整个当前 turn；已经运行的 sibling 不会在用户取消后继续执行。
- 写入、未知命令和交互仍保持确定的顺序屏障，不会被后续读取越过。
- TUI 消息列表成为实际执行与交互日志，不再包含尚未开始的调度计划。
- 会话取消不会留下未来 queued 调用的 Cancelled 噪音；Runtime event log 仍保留完整审计。
- 新增可并行工具时，必须同时证明副作用分类、审批直通和无交互语义，不能只把名字加入集合。

## 备选方案

- 全部工具继续串行：拒绝。安全但把独立读取错误地绑定到前一个长任务的延迟。
- 所有 read-only 分类直接并行：拒绝。`ask_user`、只读 subagent 和动态 MCP 仍可能包含
  交互、外部连接或运行时 binding 约束。
- 继续在 queued 时建块并由 OutputArea 隐藏：拒绝。渲染状态会继续领先真实执行状态，
  取消和回放仍需修补未来块。
- 写入与读取也并行：拒绝。会引入读写竞态、审批越序和不可预测的上下文结果。
- 收集完全部 Shell 审批后再统一启动：拒绝。它把一个调用的执行延迟错误地绑定到其他
  sibling 的用户决策延迟。
- 只拒绝当前审批调用并继续 sibling：拒绝。用户取消审批表达的是停止本轮授权流程，继续
  已启动命令、后续审批或模型调用会违背该交互意图。

## 回滚

Scheduler 恢复单调用 `run_tools` effect，Executor 恢复单路径执行；TUI 仍应保留
“实际开始时才物化、审批只进 Footer”的展示边界，避免重新引入未来 queued 块。
