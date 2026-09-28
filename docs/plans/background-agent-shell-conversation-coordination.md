# 后台 Agent 与 Shell 的会话协调方案

状态：阶段 A–C 的等待修复及真实 DeepSeek 验证已完成。阶段 D0 的独立子 Session、三子正式入口、父作用域审批代理、父结果一次接纳与原 Run 续轮已通过受控验证；待审批／已决定审批以及排队中 revision0 子线程的真实 SIGKILL 重启窗口已验收。实际打包 Electron 的 `--execution-recovery` 组合 smoke 通过，使用隔离 HOME 和模拟 Provider。阶段 D2 的跨 Session QueueOnly 邮箱、`list_agents` 与 `wait_agent` 已通过正式入口受控验证。D3 的 `followup_task`、`interrupt_agent` 正式 App Server 成功路径已验收；`current_turn` 零 Tool 旧 grant 的内部在线与两种真实 SIGKILL 窗口通过，来源 mode revision 独立于子 Session 初始 revision 时亦可通过准确授权事实验证；正式 App Server 定向回归与 2026-09-26 合成隔离真实 DeepSeek 用例均验证非零 Tool 旧 grant 的静态只读 Surface 在原 Run 下一次 Model 消费邮件，且没有新 Run。原 Run 的工具 Surface 与派发限制为 `read_file`／`search_content`／`search_files` 和旧 grant 的交集；其他安全条件改走 `new_turn`。完成、派发前失败及取消的 `new_turn` followup 已凭目标终态与来源资金 ACK 生成跨 Session 回复，并由 Store 幂等恢复；已受理且尚未路由／派发的续任务可凭持久证据结算 `expired`、`context_unavailable`、`authorization_changed`、来源 Tool 确定失败或来源 Run 用户取消；取消在原事务记录释放原因，准备后过期的目标终态与来源备付恢复也已通过真实竞态测试。已尝试但不确定的结果继续失败关闭。备付 `queued`、准确槽获取与有界等待 `capacity_timeout` 已有 Store／Host／正式 App Server 定向验证，满位超时不启动目标 Provider。`after_turn` 独立子 Session 的旧父 Run 完成后继续派发、后续人类 Run 显式 `current_turn`／`new_turn`、自动汇报抑制与预算释放已通过正式入口受控验收。旧会话必须在新客户端兼容展示：Store10／11 合成旧会话经候选转换保留原 ID、Event 与 History 回放；当前用户库曾被错误重置，不能把未来兼容测试视为其完整恢复。日期：2026-09-26。适用：Native Runtime、TUI、CLI、开发中的 Desktop，以及只读观察的 Web。

本阶段补充验收：正式 App Server 的 `current_turn` 边界 5/5，包括原 Run 下一次只读模型消费消息，以及 Provider 返回未公布的 Shell Tool 时被拒绝；两处真实 SIGKILL 恢复 2/2；满位排队／有位后启动的容量回归 2/2。另有 queued 容量真实 SIGKILL 恢复 1/1：两个占槽 child 的在途 Provider 尝试在崩溃后成为 unknown，来源备付保持 queued 并报告 `followup_recovery_required`；没有目标路由／派发或来源释放，不能在该不确定状态结算 `capacity_timeout`。Store 的 queued 后备证明已收紧为两种准确事实：仍 queued 且无槽获取事件，或已转 reserved 且有准确 `resource_budget.child_slot_acquired`；不再凭状态单独推断槽已取得。这些是本地受控 Provider 和进程恢复证据，D3 的 `new_turn` 与 `current_turn` 各有独立合成隔离环境下的真实 DeepSeek 定向验收；不以模型是否回显提示词标记作为通过条件。

本方案面向真实会话中多个后台子 Agent 与有限 Shell 的派发、等待、部分结果、用户引导和停止。原“一个 child 回复后本轮回复失败”已从本机持久事件和结果 Artifact 定位为 child `suspended` 结果在 Kernel 接纳前被 Service 投影为 `unavailable` 的窗口；准确失败时序和仍需补验范围见第 7 节。Codex 的 Agent 通信只作为目标行为依据，不能用工具改名替代 Kite 的接纳与恢复验证。

## 1. 参考依据与 Kite 现状

[Codex Responses Multi-agent 指南](https://developers.openai.com/api/docs/guides/responses-multi-agent)区分创建、查询、等待、排队消息、显式续轮和中断。固定源码提交 `40eac3ce8a0c10cbcb9db910d529355eb2f8fc09` 中，[V1 定向等待](https://github.com/openai/codex/blob/40eac3ce8a0c10cbcb9db910d529355eb2f8fc09/codex-rs/core/src/tools/handlers/multi_agents/wait.rs)对指定目标做 wait-any；[V2 `wait_agent`](https://github.com/openai/codex/blob/40eac3ce8a0c10cbcb9db910d529355eb2f8fc09/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs)等待调用者邮箱更新、用户引导或超时。`wait_agent` 不承诺每次返回所有 Agent 的全量状态；整体状态由 [`list_agents`](https://github.com/openai/codex/blob/40eac3ce8a0c10cbcb9db910d529355eb2f8fc09/codex-rs/core/src/tools/handlers/multi_agents_v2/list_agents.rs)查询。成功等待回执与消息正文进入下一模型上下文也是两个事实。

Kite 已有[执行手册](../handbook/features/execution.md)、[Builtin 工具契约](../../packages/builtin-runtime/docs/tool-pipeline.md)、[CompletionGuard](../active/completion-guard.md)和 [Service owner](../../apps/kite-service/docs/runtime-application.md)：`task(background=true)` 返回 task ID；`task_wait` 对指定 1–8 个 task ID 做有限 wait-any；`task_read` 补读状态或报告。`shell_execute(yield_ms)` 返回 Shell 句柄，`shell_read` 按游标读取或等待，`shell_stop` 精确停止。required 子任务结果仍属于原 Run：唯一 watcher 先写结果 Artifact，Kernel 接纳后以低权限具名内容进入主模型输入。阶段 A–C 沿用这套权威，不另建结果收件箱、生命周期 registry 或 `await_agent`／`wait_shell` 同义工具。

当前代码还有四个关键事实：

- [CompletionGuard](../../packages/agent-kernel/src/completion.ts)先判断未终态工具／required Shell，再判断 required 子 Agent。子 Agent 的 `wait_for_background` 有独立无纠错等待；Shell 的 `wait_for_tool` 仍可能进入普通纠错路径。混合运行的局部终态必须以真实 Service/Host 时序验证。
- [运行器](../../apps/kite-service/src/bootstrap/runtime/state-runner.ts)在自动等待中重算条件。A 终态而 B/C 仍 required 时，A 的结果可已接纳，主模型通常等全部 required 解除后才再调用；需要首个结果决策时应显式使用 `task_wait`。完成等待 port 在生产入口已接线，缺失时现明确报错而不落入 `Completion blocked...` 通用终态；用户原故障的根因另见第 7 节的 watcher 提交间隙。
- 用户→活动主 Agent 的 [`steer_turn`](../handbook/features/execution.md)已存在。当前[子 Agent 模型循环](../../packages/builtin-runtime/src/subagent/model-loop-engine.ts)只维护本次任务的局部消息；普通终态结果没有可续轮的完整对话。现有审批 continuation 不能冒充普通 Agent 续轮。
- 现有[部分完成测试](../../apps/kite-service/test/isolated/runtime-server-required-background-partial-wait.test.ts)覆盖两个 child 的错峰完成，没有覆盖三个 child、多个有限 Shell、真实 Provider 或实际 Desktop 的组合。

原失败 Run 的 `completion.blocked`、`run.error`、task 身份和结果 Artifact 时序已在第 7 节记录；持久库未保存可证明的 App binary version。原判断依据是持久事件与源码提交顺序，不是截图或先前的条件风险推断。

## 2. 产品行为与不变量

1. **四个事实分开。** 工具已接受、后台执行已终态、结果已被 Kernel 接纳、结果已进入主模型输入分别表达。最后一项只能证明已提供给模型，不能证明模型理解或采纳。一个 child 的成功、失败或取消不得由等待设施直接映射为父 `run.error`；主 Agent 仍可依据具名失败结果决定自身答复。
2. **身份准确。** 当前 `task_id` 标识一次 child 执行及其原 Run 结果，Shell ID 标识一次命令；等待、读取、停止都针对准确执行 ID。阶段 D 以稳定 `agent_id` 标识 Agent，以独立 `agentThreadId` 标识其会话线程，以逐轮 `task_id` 标识执行；三者不得互相代用。
3. **等待是观察。** `task_wait`／`shell_read` 的一次等待窗口到期只表示暂无新事实；不改变任务总期限、授权、父 Run 身份或纠错次数。用户引导让等待返回，不取消已派发工作。
4. **局部终态不是整轮终态。** A 已结算、B/C 仍 required 时，父 Run 非终态；A 的具名结果只接纳一次，B/C 的义务仍在。心跳、重复 `running` 快照和无关 revision 不唤起主模型。
5. **真实在途等待不算模型错误。** live admitted attempt 的工具、required Shell 和 child 均不因等待或局部唤醒增加 CompletionGuard 的 correction attempt。未知 owner／外部副作用走有证据的恢复或 unknown，不伪造成功或无限等待。
6. **停止以清理证据为准。** 精确停止一个 child 或 Shell 与取消父 Run 分开；停止受理、执行退出和清理确认也分开。未知副作用不得自动重放。
7. **低权限交付。** 子 Agent 结果和阶段 D 的 Agent 间消息保留来源，不视为用户授权；运行中消息不能扩大原任务权限、预算或 deadline，新轮重新校验授权。
8. **主、子引导分开。** Kite 现有 `steer_turn` 由活动主 Run 处理。Codex 式 `send_message` 只排队，`followup_task` 才触发目标继续；回执均不等于模型已读或已执行。已发模型请求、已启动工具和已展示 final 不追溯改写；停止另走独立操作。

## 3. 阶段 A–C：当前工具的合理调用

| 意图 | 主 Agent 动作 | Runtime 必须保证 |
| --- | --- | --- |
| 独立子任务 | 并发 `task(background=true)`，取得各 `task_id`；写入冲突时串行 | 分别准入、执行和保留原 Run 的 required 义务 |
| 首个子结果会改变后续动作 | 对准确 ID 调一次 `task_wait` | 指定 1–8 个目标的有界 wait-any；返回当时快照，不取消其余 child |
| 已无独立工作，只需等齐 | 提交完成候选 | CompletionGuard 在同一 Run 等 required 结果；局部终态只重算，不反复请求模型 |
| 查询或补读截断报告 | `task_read(task_id)` | 读状态／Artifact，不把读取当成生命周期确认 |
| 用户引导活动主 Agent | 现有 `steer_turn` | 同 Run 持久受理并按当前 Kite 规则处理未派发的旧动作 |
| 停止一个 child | `task_cancel(task_id)` | 只停止准确目标，观察真实终态，兄弟任务继续 |
| 运行有限命令 | `shell_execute`，超过 `yield_ms` 后持有 shell ID | `timeout_ms` 是总执行期限；命令继续受管 |
| 需要 Shell 输出／终态 | `shell_read(shell_id,cursor,wait_ms 或 wait_until)` | 增量读取与有限等待；重复读不重复执行，等待超时不杀进程 |
| 停止一个 Shell | `shell_stop(shell_id)` | 精确停止并核对执行与清理事实 |
| 显式 service | `shell_execute(mode=service)`，再实际验证服务 | `running` 不等于业务 ready；service 存活不构成父 Run 永久未完成义务 |

`task_wait` 用于**中间决策**，自动 CompletionGuard 等待用于**最终依赖**；前者不是所有子 Agent 的全局收件箱。两者观察同一 canonical task 状态，只有 watcher 与 Kernel 接纳的终态解除 required 义务。`shell_read` 已承担即时读取和等待，不增设 `wait_shell`。模型工具描述和示例应阻止反复 `task_read`、Shell sleep 或空说“正在等待”的模型轮询。

`result_disposition=after_turn` 仍遵循现有结构化授权、预算预留、原 deadline 和 `human_start_preferred` 规则，不算本轮 required。阶段 D 的显式 `followup_task` 使用第 4 节单独定义的邮箱与后备预算协议，不借用 after-turn 的自动汇报 Run。

典型当前会话：主 Agent 派发 A/B/C 和一个有限 Shell，继续独立工作。若 A 的结论影响下一步，它对 A/B/C 的 task ID 调 `task_wait`；A 先终态则处理 A，B/C 和 Shell 继续。若只需最终汇总，提交完成候选，Runtime 等齐剩余 required 工作。用户在等待时发引导，由原 Run 处理；每次局部终态只更新事实，最终才恢复模型形成答复。

## 4. Codex 式 Agent 通信：Kite 接线决定

[OpenAI 官方 Multi-agent 文档](https://developers.openai.com/api/docs/guides/responses-multi-agent)将 `send_message`（排队）、`followup_task`（启动或恢复非根 Agent）、`wait_agent`（调用者邮箱等待）、`list_agents`（Agent 树状态）和 `interrupt_agent`（独立中断）分开。固定源码提交 `40eac3ce8a0c10cbcb9db910d529355eb2f8fc09` 中，[`send_message = QueueOnly`](https://github.com/openai/codex/blob/40eac3ce8a0c10cbcb9db910d529355eb2f8fc09/codex-rs/core/src/tools/handlers/multi_agents_v2/send_message.rs#L35-L47)、[`followup_task = TriggerTurn`](https://github.com/openai/codex/blob/40eac3ce8a0c10cbcb9db910d529355eb2f8fc09/codex-rs/core/src/tools/handlers/multi_agents_v2/followup_task.rs#L35-L47) 的[共同处理器](https://github.com/openai/codex/blob/40eac3ce8a0c10cbcb9db910d529355eb2f8fc09/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs#L57-L93)成功时返回空工具结果，不返回新 task ID；[`wait_agent`](https://github.com/openai/codex/blob/40eac3ce8a0c10cbcb9db910d529355eb2f8fc09/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L35-L163)只返回唤醒／超时摘要，不是结果正文或所有 Agent 快照。这些是交互依据；Kite 的现行会话边界见 §4.0，原单 Session 草案的取舍由 Agent Note 0190 保留。

### 4.0 会话线程边界：阶段 D 的新前提

[Codex CLI 的 Subagents 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)把子 Agent 的工作场所称为 Agent thread，CLI 可用 `/agent` 切换并查看各线程；主线程汇总子线程结果。该文档证明独立上下文的产品语义，不规定 Kite 或 Codex 的数据库布局。Kite 在阶段 D 选择更明确的运行边界：每个 Agent 拥有独立的持久会话线程（`agentThreadId`／Store Session ID）、State revision、模型 transcript、轮次与执行 owner。子线程可继承工作区与受限配置，创建时记录 `parentAgentId`／`parentThreadId`，但不能直接在父线程 State 上提交自己的生命周期、模型或进度事件；兄弟线程的正常写入也不能使彼此的 effect lease 失效。同一 SQLite 文件可以保存多个 Session，独立线程不要求独立数据库文件或工作树。

子线程是内部 Agent 执行会话，不是空间下的顶层会话。Store 须持久记录根／子线程类型及父线程血缘；旧会话迁移时按已证实的原有顶层会话身份标记为根线程。空间会话列表及其搜索、最近会话等同源查询须在排序、游标和 `LIMIT` 之前过滤子线程，不能仅靠客户端或取页后隐藏。子线程的状态和历史由父线程的 Agent 树入口或授权的 Agent 详情访问；已知子线程 ID 也不绕过父子血缘与权限校验。重启、迁移和分页后均保持这一可见性边界。

开发版 Desktop 已将已创建子 Session 的详情接到父会话“环境信息 → 子智能体”及相应工具消息：两处均从父作用域列表验证 task 身份，详情复用主会话消息和工具投影，并按历史 sequence 衔接经父作用域授权的实时订阅。没有对应子 Session 的旧后台条目不开放详情；子详情保持只读，也不进入顶层目录。客户端与协议的运行证据以本次定向测试和 Electron 验收为准。

父子之间只通过有来源和幂等身份的跨线程协议联系：父工具受理创建意图并建立准确的 required 义务；子线程独立运行，其委派任务从私有 Artifact 读取并作为低权限 Agent 输入准备，不冒充人类 `user.message_appended`；子终态先在自己的线程结算，再以确定性结果通知交给父线程，由父线程单独接纳、解除原 Run 义务并准备低权限模型输入。`send_message` 的成功只证明持久受理，目标读取和模型输入各有独立事实；`followup_task` 为目标线程创建或继续一轮，不复用旧 `task_id`、授权或预算。取消父 Run、停止一个子 Agent、子线程自身结束是不同操作，不暗中停止兄弟线程。

上述 required claim 只适用于 `result_disposition=required`。`after_turn` 已接入独立子 Session：原 `task` Tool 回执同事务保存非必需子创建意图、有界委派额度和一次自动汇报模型后备，不建立 required claim；原父 Run 正常结束后，子凭 retained funding ledger、原 deadline、封存 grant 和 child owner 证据继续派发。子终态先封存，再由父 Session 按原血缘一次导入具名结果，不注入后来的人类 Run。自动汇报仅在原后备及 `human_start_preferred` 条件成立时至多启动一次，抑制时释放后备；原任务仍活动期间，父 Session 的新 Run 可按现行直接子授权与独立资金约束发送 `followup_task`。创建失败、取消、预算 unknown 与重启保留准确意图及释放／恢复事实；正式入口跨 Run 验收见阶段 D。

跨线程不能借用“所有 Agent 共用一个 Session revision”取得原子性。Host/Store 须明确消息 outbox／inbox、命令 receipt、投递确认与崩溃重放的唯一 owner；允许共享事务存储，但父子 State 分别按各自 Session revision 提交。资金仍由准确来源 Run 授权并可在发送方 Run 结束后结算，子线程只使用有界委派额度；结果和邮件正文保留私有引用。任何跨线程步骤失败，必须保留可查询的待交付或恢复事实，不能返回成功后静默丢失，也不能重放未确认的外部副作用。

首轮创建与结果桥接按以下提交顺序收敛：父线程在原 `task` Tool 受理事务中写确定性 `agent_id`／`agentThreadId`、创建意图、原 Run required claim、有限委派预算和工具 receipt；原 Tool 的短期预算在同批事务中按已发生的一次调用调和，再建立贯穿子生命周期的委派预留。Host 按该意图幂等初始化子 Session：revision 0 仅预绑定准确来源，预算未配置；子线程首次启动事务同时接纳委派任务 Artifact、配置不超过父委派上界的预算、创建自己的 Run 与 Turn。父线程再次确认原 Run／required claim 有效并记录委派 dispatch ACK 后，子 Provider 才能派发。重启前仍可能用到的受限 grant 必须有不可变私有证据及准确摘要；原 grant 过期、策略收紧或绑定不可用时具名失败，不能重发更宽的授权。若子 Session 确证无法创建，或已创建但尚未激活／派发而被放弃，父线程以同一意图身份结算具名失败和原 required claim，不留下永久 `running`。子线程先将不可变结果 Artifact、终态及带原父 Run／Turn／Tool attempt 的待投递结果记录在自己的事务中结算。桥接器只凭这条已结算记录，在父线程事务中一次性接纳原 `subagent.background_result_persisted`、解除准确 required claim，并写投递确认；相同结果身份重试只返回已有确认，摘要冲突拒绝。若子事务已提交而父事务未提交，记录保留待投递，重启后继续桥接；父事务已提交而确认回传丢失时只重放确认，不再执行 child 或再注入结果。父 Run 已取消时按取消事实结束原 claim，保留子终态供历史读取，不重开父 Run 或注入后续人类 Run；桥接器只有在父线程对该结果或取消已持久结算后才确认投递。任一中间状态都可查询和恢复，不能从子线程的成功直接推断父线程已收到。

#### D0 的记录、事务与 owner

| 记录／动作 | 唯一写入 owner | 提交与校验边界 |
| --- | --- | --- |
| 子线程身份及创建意图 | 父 Session | `agentThreadId` 从准确父 Session、Tool invocation 与稳定 `agent_id` 按域分隔确定；原 Run／Turn／Tool attempt、grant digest、required claim、Tool receipt 与创建意图同一父事务。模型参数或客户端不能自行指定子 Session ID。|
| 子 Session 初始化与启动确认 | 子 Session；确认回写父 Session | Store 以父意图和相同创建 identity 幂等创建独立 Session／Controller，绑定 `parentSessionId`、Workspace/project digest 和受限 grant；子执行只能在子创建回执持久后启动。父确认丢失时从创建回执恢复，不创建第二个子 Session。|
| 子终态与待投递结果 | 子 Session | 唯一 watcher 在子执行清理证据齐全后封存不可变结果 Artifact 与终态；外部尝试已持久而清理无法确认时，仅 fenced recovery generation 可封存 `unknown/cleanupConfirmed=false`。单有 Artifact 不得解除父 claim。|
| 父结果接纳与投递回执 | 父 Session | 桥接器读取已结算的子终态，核对父意图、原 claim、grant/result digest 和父 Run 状态；在一个父事务中接纳原结果并结算 claim，同时保存按 delivery ID 唯一的回执。子 outbox 的已确认标记可在随后子事务中写入，以父持久回执为准重放；摘要冲突拒绝。|
| 消息与续轮 | 发送 Session／接收 Session | 发送方事务保存命令 receipt、私有正文 ref 与有界预算意图；跨线程 outbox 经目标血缘和授权检查投递，接收方自己的事务才推进 inbox／模型输入水位。`followup_task` 在子 Session 继续或创建下一轮，不让子模型事件写入父 State。|

所有子 Session 仍属于原 Workspace，但不是顶层会话。目标 Store 以 `runtime_sessions.parent_session_id` 的 NULL／准确父 Session ID 为单一根／子判据，旧会话迁移时回填 NULL；子 Session 创建须检查父链、Workspace/project 一致、无环和当前授权。`agent_id`、`agentThreadId`、初始 `task_id` 的一对一映射留在父创建意图与子创建回执，旧历史 task 没有子 Session 时只保留其原结果可读性，不凭相似 ID 伪造线程。`parent_session_id` 的确切物理格式与 Store 10→候选格式转换须按 schema/epoch 完整验证；未发布的 Store11 可以修订候选，但不得静默原位升级用户现有 Store10。

父 Session 的 close/delete、Fork 和 Rewind 不能只处理父 State 后留下不可发现的子线程，亦不能由外键级联无证据地删除已接纳的子结果。在具体 child 清理／历史保留策略和投递 outbox 结算得到验证前，这些操作遇到子线程血缘时 fail closed；后续决定须同时更新产品会话语义与 Store/Host owner。

| 崩溃／竞态窗口 | 恢复时的唯一可执行动作 |
| --- | --- |
| 父创建意图已提交，子 Session 未创建 | 按同一 identity 重试子 Session 创建；确证永久失败时父线程提交具名失败和 claim settlement，重放原 Tool receipt。|
| 子 Session 已创建，父启动确认丢失 | 从子创建回执核对并回写确认；不得再创建或再派发已确认的外部 attempt。|
| 结果 Artifact 已写，子终态事务未提交 | 结果仍未交付；子 owner 依清理和 dispatch 证据恢复或标记 unknown，不能从 Artifact 猜测成功或重复 Provider 操作。|
| 子模型／工具尝试已持久，进程中断且清理不能确认 | 子恢复 generation 将原 Run 标 unknown、封存 unknown 结果，再以 cleanupConfirmed=false 释放 owner；父事务在验证子 owner 为 recovery_required 后一次性结算 required 结果，原委派预算保持 unknown，不重放外部尝试。|
| 子终态／outbox 已提交，父结果尚未接纳 | 桥接器按 delivery ID 重试父事务；父 Run 仍 required 时才接纳原结果。|
| 父结果／receipt 已提交，子确认丢失 | 只查询父 receipt 并确认子 outbox；父结果帧和 claim 不再写第二次。|
| 父 Run 已取消或在途取消 | 先核对父取消与原 claim settlement；子结果保留历史，桥接只记录取消投递结果，不唤醒旧 Run 或注入新的人类 Run。|

D0 验收至少覆盖：三个子 Session 并发注册、handle、模型和终态写入时各自 revision／lease 只随自身事实变化；上述每个崩溃点重启后仅一次外部执行和父结果；子线程创建永久失败与父取消均无永久 required；空间列表、搜索、最近会话、分页和直接 ID 查询在排序、游标与 `LIMIT` 前排除内部子线程，父 Agent 树授权读取仍可见；Store10 旧根会话转换后仍可见，内部子线程在排序和分页前保持隐藏。客户端后过滤、单测中的同 Session Agent 行或 Artifact 存在都不足以通过这些验收。

阶段 D 的 D0 设计核对定义身份映射、事务 owner、崩溃窗口与列表过滤边界。Store10／11 旧根会话经候选转换保持原 ID、State、Event 与 History 回放；三子正式入口验证彼此独立的 revision／lease、准确父结果与根列表可见性；真实 SIGKILL 验证创建、排队、审批决定、原 Run 续接和一次接纳。消息的跨线程受理／投递由 D2 QueueOnly 验收覆盖；D3 的资金授权、`new_turn`、受限 `current_turn` 与直接子停止另由各自 Store/Host/Service 事务及正式入口验收支持，不能仅凭 D0／D2 的证据推断。

用户已澄清：开发数据可重置，不等于旧会话兼容要求可以取消。[会话连续性方案](session-store-compatibility-and-continuity.md#历史用户数据恢复)要求新客户端保留旧根会话原 ID、已提交 State/Event 与 History 回放；本机当前库曾被错误清空，需将其数据恢复问题与未来兼容实现分别报告。

正式入口的启动恢复还须在持久意图扫描后允许父 Session 查询与命令继续进行；长时间运行的子模型不能让父会话入口一直等待。后台恢复结果必须可观察，`recovery_required` 不得作为未处理的 Promise 丢失。正式入口已将恢复扫描的调度与完成分开，父会话入口不等待长时间运行的子模型，失败按准确子意图写入需恢复诊断；正式 App Server 进程崩溃重启用例已验证持久意图恢复、子模型在途时父查询响应和一次父结果导入；父模型在结果导入后消费准确具名 `<subagent_result>` 并恰好一次完成原 Run 的崩溃重启验收已通过。

独立子 Session 的审批由父 Session 受控代理交互展示与提交决定，私下绑定准确 child intent、grant、Tool、interaction 和 owner generation；子 Session 单独接纳决定，再从已持久的 Model／Tool 点恢复。正式入口的批准和拒绝测试，以及待审批、已决定两处真实 SIGKILL 测试，均核对原父子 Run 续接、已尝试外部动作不重放、工具只派发一次、父结果只接纳一次。缺少恢复证据继续 fail closed；客户端只使用父 Session ID 与 revision，不开放直接子 Session 命令。

#### 4.0.1 跨线程邮箱的实现边界

阶段 D 的 Agent 目录以 `runtime_sessions.parent_session_id` 和各线程 Agent 身份为基础，一个 Agent 只拥有自己的 Session。当前 Store14 沿用 Store13 的来源线程 outbox 与目标线程 inbox：发送方的准确 Tool 回执、私有正文引用、消息身份和待投递记录在来源 Session 事务中原子受理；接收方在自己的 Session 事务中按相同消息 ID 写一次 inbox 与接收事件。父子血缘、Workspace 身份、当前执行授权和目标状态在受理及投递时分别复验；知道 Agent ID 或子线程 ID 不形成权限。旧 Store11 的同 Session 邮箱表及工具路径仅为保留格式，不作为当前跨线程协议。

当前 Store14 沿用 Store13 的来源 outbox／目标 inbox 的有界 `QueueOnly` 记录、来源 Tool 身份、跨 Session 血缘核对、私有正文和各自 fenced 事务。正式 App Server 的 `send_message` 从准确来源 Tool 受理，经目标 Event／inbox 投递，在目标后继模型输入中产生一次低权限 `<agent_message>`；空闲目标只排队。冷启动按未确认来源索引重放，重复扫描不产生第二条目标消息。`followup_task` 已由来源 Tool 受理并在子 Session 中准确路由；完成态终态 ACK 可生成确定性的 `reply` 邮件，待投递邮件按同一来源索引恢复。旧同 Session 表暂留，其工具开关保持关闭。

正文只在来源私有 Artifact 保存一份。目标 inbox 以受限引用读取它：接收时若目标有准确活动 Run，保存该 Run 作为可投向模型的收件归属；若目标空闲，保留未绑定的排队消息，不能在后来任意人类 Run 中自动注入。目标只为归属当前 Run 的消息按自己的顺序推进 `mail_input_prepared` 水位；读列表、`wait_agent` 唤醒及 outbox 投递确认均不推进模型已读水位。来源 outbox 仍可枚举未有目标接收回执的消息；进程在任一步骤退出时按消息 ID 查询目标 inbox 后重试投递，不能重新执行发送 Tool 或生成第二条成功回执。跨线程步骤不要求父子 State 同时提交，但每一步都有明确 Session revision、幂等键和可查询的待恢复事实。QueueOnly 不申请目标模型预算，也不唤醒空闲目标；TriggerTurn 在来源资金 Run 锁定有界后备预算后，才允许目标按 §4.0 的新轮协议接纳。

| 模型操作 | Kite 目标契约 |
| --- | --- |
| `list_agents` | 授权范围内只读 Agent 树、状态与有界最近消息摘要；不消费邮箱、不启动执行 |
| `wait_agent(timeout_ms?)` | 有界等待调用者邮箱新事实或用户引导；超时只结束本次等待；返回原因摘要，消息正文以独立低权限帧进入后继模型输入 |
| `send_message(agent_id,message)` | 持久 QueueOnly；活动目标在下一个可用模型输入边界读取，空闲目标保持排队；成功回执不证明已读，也不触发模型 |
| `followup_task(agent_id,message)` | 持久 TriggerTurn；当前新受理的 `independent_turn_v2` 在原子任务终态后启动独立新 Run，旧 v1 已受理请求才按原 grant 可能沿 `current_turn` 继续。模型可见成功输出为空，调用者通过 `wait_agent`／`list_agents` 观察；准确授权与恢复条件见 [Service owner](../../apps/kite-service/docs/runtime-application.md) |
| `interrupt_agent(agent_id)` | 精确中断目标活动轮，保留 Agent 身份与已结算历史；与现有 `task_cancel` 共享底层执行停止和清理证据，不取消其他 Agent |
| 用户→主 Agent `steer_turn` | 保留现有同 Run 用户引导，不转成 Agent 间 QueueOnly 消息 |

## 5. 阶段 A–C 的结果交付与等待状态

`DecisionWait` 是主 Agent 显式 `task_wait`／`shell_read` 的一次观察；`CompletionWait` 是完成候选仍有 required 工作时的自动等待。二者是父 Run 的等待意图，并非 child 或 Shell 的新生命周期。

```mermaid
stateDiagram-v2
    [*] --> Working: Run 已受理
    Working --> Working: 派发后台工作／继续独立工作
    Working --> DecisionWait: 显式等待
    DecisionWait --> Working: 目标可行动／引导／本次超时
    Working --> CompletionWait: final 候选仍有 required 工作
    CompletionWait --> CompletionWait: 局部终态后重算
    CompletionWait --> Working: required 全部接纳／用户引导
    Working --> Completed: CompletionGuard 接受
    Working --> Recovery: owner 或结果事实未知
    DecisionWait --> Recovery: owner 或结果事实未知
    CompletionWait --> Recovery: owner 或结果事实未知
    Recovery --> Working: 已证明的同 Run 恢复
    Recovery --> Unknown: 暂无足够证据
    Unknown --> Recovery: 新恢复证据
    Recovery --> Failed: 已证实不可恢复
    Working --> Cancelled: 已确认整轮取消
    DecisionWait --> Cancelled: 已确认整轮取消
    CompletionWait --> Cancelled: 已确认整轮取消
```

| 层级 | 阶段 A–C 的唯一职责 |
| --- | --- |
| Agent Kernel | 从 canonical State 判定 required、完成和等待；按原身份接纳具名结果并保护 correction 语义 |
| Runtime Host／Store | 维持 Run、Turn、Tool/attempt/receipt、执行权威与有序事务；等待和恢复遵循持久事实 |
| Service background owner | 持有活 Shell／child 句柄、事件驱动 waiter、Shell 输出游标与终态观察；结果写入后唤醒 |
| Builtin Runtime | 提供 `task_wait`／`task_read`／`shell_read` 的模型契约、安全 schema 和子任务执行 |
| Runtime Contract／客户端 | 投影同一 Run 的等待原因、task/Shell 卡片和已证明的结果状态，不取得执行权 |

子 Agent watcher 先保存完整 Artifact，再提交唯一 terminal/notification；Kernel 接纳后才解除对应义务。`task_wait` 的工具回执可以与同一子任务的 canonical 结果同时被模型看见，但不应生成第二份子 Agent 结果帧。Shell 的增量输出、exit、cleanup 由受管 owner 证明；`shell_read` 的一次超时不是执行超时。多个终态同时到达按 Session 事实顺序接纳，下一模型输入可以一并包含多份具名结果，不为此引入第二个结果数据库。

当前 `wait_for_tool` 与 `wait_for_background` 可以保留不同执行路径，但必须共享“真实在途等待不属于纠错”的语义。两个有限 Shell 中一个先结束时，另一个仍 required，则保持自动等待；Shell 与 child 混合时，从 `wait_for_tool` 转向 `wait_for_background` 不应再请求模型来发现仍有依赖。运行器构造必须具备完成等待 port；port 缺失／抛错、owner 更替或结果尚未接纳须进入有分类的恢复／unknown 路径，不得把正常待处理状态兜底为不可恢复的 `Completion blocked...` 错误。

## 6. 失败、恢复与客户端反馈

| 场景 | 阶段 A–C 目标处理 |
| --- | --- |
| 一次 `task_wait`／`shell_read` 超时 | 返回仍在运行或无变化；保留原工作与 Run，correction attempt 不变 |
| child 失败、取消、报告截断 | 保存准确终态与具名摘要；父 Agent 可解释、补读或另行安排，不机械生成父 `run.error` |
| Shell 非零退出、总期限到期 | 保留退出码、已有输出、执行与清理事实；由父 Agent 处理，读取超时不冒充命令超时 |
| A 先结束、B/C 仍运行 | A 接纳一次，B/C required 义务保持；显式等待可返回，自动完成等待继续 |
| 用户引导与终态同刻到达 | 按现有 Session 顺序各消费一次，保持同 Run/Turn，不发起两个并发主模型请求 |
| 精确停止或整轮取消 | 分别记录意图、回执和真实清理；迟到结果不能复活已关闭 Run |
| Store、owner 或 wait port 异常 | 以持久事实恢复或显示 unknown；不能证明的外部副作用不重放，不把未知当作完成 |

TUI、CLI 和开发中的 Desktop 使用同一 canonical 状态。任务卡可区分派发、执行、收尾、终态和“结果已进入主模型输入”；最后一项必须有对应 prepared input revision 证据，不能从通知排队推断。父 Run 显示等待原因时，初始 required 集合与当前仍运行的集合需区分：阶段 C 若要显示动态“剩余任务”，必须从已接纳终态推导或新增有权威的等待原因更新，并测试局部完成后的变化；否则只显示原等待集合及各任务卡的实时状态。用户仍能在等待时引导主 Agent 或精确停止目标；Web 只读。私有子 Agent 内容和完整 Shell 输出不进入状态摘要或诊断日志。Codex 式 Agent 邮箱卡属于阶段 D，当前客户端不能显示未实现的“已排队消息”状态。

## 7. 实施顺序与验证

2026-09-23 的阶段 A 证据：本机 Session `98515a46-1073-4d35-825e-0359638d76e3` 的 Run `turn_b9b45e20b49018a5c67297501d96ad7a` 在三个 required child 等待中，以 `wait_for_background/correctionAttempt=0` 阻断；首个 child 的 `suspended` 结果 Artifact 于 2026-09-20 13:57:59.197 UTC 写入，父 Run 于 .202 因 `Required background sub-agent settlement requires explicit recovery.` 报错，而该 child 的 `subagent.background_result_persisted` 于 .242 才提交，settlement proof 于 .258 写入。另一个 2026-09-22 的三 child Run 出现同类错误。库有 format epoch 和 schema 版本，但没有可核对的 App binary version；因此不能仅凭事件确认两次客户端的精确安装版本。只读审计未读取提示词或报告正文。源码链路是 watcher 先设置 `suspended` 活状态，而投影把它映射为 `unavailable`；中间的 Kernel cleanup revision 唤醒等待器后，恢复 claim 尚不存在，触发父 Run 的错误。阶段 B 现把活记录的终态公开延迟到回调与 proof 完成；失败时先落 recovery claim。

受控验证已通过 [Service/Host 三 child、双 Shell 与混合顺序回归](../../apps/kite-service/test/isolated/runtime-server-required-background-three-child-barrier.test.ts)、[显式部分 `task_wait` 回归](../../apps/kite-service/test/isolated/runtime-server-required-background-partial-wait.test.ts)、[watcher 提交间隙回归](../../apps/kite-service/test/background-subagent-runtime.test.ts)、[Native TUI facade 协议回归](../../apps/kite-cli/test/isolated/tui-required-background-service.test.ts)、[Desktop 渲染回归](../../apps/kite-desktop/test/isolated/ui.test.tsx)和[实际打包 Electron 窗口 smoke](../../apps/kite-desktop/scripts/native-smoke.ts)。窗口 smoke 使用隔离 HOME 与本地模拟 Provider，验证 A 完成时 B/C 仍运行、同一父 Run 保持等待，全部结算后才给出唯一终态。首次 child Provider 连续失败或已派发模型请求被取消时，启用预算可使 reservation 进入 `unknown` 并阻止新的父模型准入，这是[现行失败分类契约](../active/failure-classification.md)要求的 `reconciliation_required` 边界；失败结果交付及准确取消后兄弟继续的协调用例在预算关闭的对照条件下验证。预算开启且用量未知时不宣称父 Run 正常完成，也不通过虚构零用量或上界实际用量绕过恢复。2026-09-25 再次使用本机配置中的凭据、官方 `/models` 公布的 `deepseek-flash` 运行真实 DeepSeek 隔离多 Session 套件，通过 required child 的单次 `task_wait`、部分结果、跨 Session 隔离及 after-turn 恰好一个续行 Run；本机配置原写的 `deepseek-v4-flash` 当时未在 `/models` 公布，未修改原配置。该套件只证明 A–C 生产路径。D0 已有正式 App Server 三子、审批及真实 SIGKILL 重启验收；实际打包 Electron 的 `--execution-recovery` 路径也通过。2026-09-26 的[合成隔离真实 DeepSeek D0 三子用例](../../tests/e2e/live/model/background-three-independent.live.ts)还验证了同一父 Run 的三个不同子 Session 各自进行真实模型请求、结算并被父级各导入一次，父 Run／Turn 各只完成一次，根列表隐藏子线程；真实外部 Provider 下的审批和崩溃窗口仍由本地受控进程测试提供确定性证据，不由三子在线用例推断。D3 的 Agent 列表／等待、显式续轮和直接子停止已通过正式 App Server 受控验收；零 Tool `current_turn` 的在线、route-only 和 released 两种真实 SIGKILL 恢复通过内部真实链路。2026-09-26 的合成隔离测试使用官方 DeepSeek `deepseek-flash` 端点，已验证 D3 `new_turn` 的一个独立子 Session、续轮结算和一封跨 Run 回复；另一个独立的合成隔离用例已验证 D3 `current_turn`：required review 子首模型先调用 FIFO Shell，父 Run 在 Shell 等待时受理 followup，子第二次真实模型调用以同一 Run 消费邮件并结算，父 required 结果只导入一次。三套新增测试只发送新建合成会话的任务正文，不使用旧会话数据；没有断言模型回显提示词标记。父子独立 mode revision 的受限当前轮守卫和非零 Tool 旧 grant 限制见第 4 节与阶段 D 状态。

D3 最近的定向证据是[正式入口当前轮边界](../../apps/kite-service/test/isolated/runtime-server-current-turn-boundary.test.ts) 5/5：已尝试首模型拒绝路由、无界 `code` grant 拒绝、过早 followup 的后继处理、只读第二次模型消费，以及未公布 Shell Tool 在路由后拒绝。[正式入口容量排队](../../apps/kite-service/test/isolated/runtime-server-followup-capacity-queue.test.ts) 2/2：有位后仅启动一个续轮，满位超时零目标 Provider 派发。[queued 容量真实 SIGKILL 恢复](../../apps/kite-service/test/isolated/cross-session-followup-queued-sigkill.test.ts) 1/1：占槽尝试 unknown 时保留 queued 备付，报告 `followup_recovery_required`，没有目标路由／派发或来源释放，不能伪造 `capacity_timeout`。零 Tool 路由后的 route-only／released 两处真实 SIGKILL 验收 2/2 仍由[内部集成夹具](../../apps/kite-service/test/isolated/child-session-orchestrator-integration-fixture.ts)覆盖；[合成隔离真实 DeepSeek D3 用例](../../tests/e2e/live/model/background-agent-followup.live.ts)于 2026-09-26 通过：固定官方端点的 `deepseek-flash` 在正式 Service/Host 链路创建一个独立子 Session；第二个父 Run 受理一次 `followup_task`，目标 `new_turn` 完成并产生唯一跨 Run `reply`。断言还核对两次子模型尝试、一次输入准备、父子无 `run.error`。[独立的合成隔离真实 DeepSeek 当前轮用例](../../tests/e2e/live/model/background-agent-current-turn.live.ts)于 2026-09-26 通过：required review 子的首模型调用 FIFO Shell 阻塞，父在同一 Run 受理一次 `followup_task`；释放 FIFO 后子路由为 `current_turn`，唯一 `agent.mail_input_prepared` 绑定准确的第二次真实模型 invocation，子仍在同一 Run 结算，父 required 终态只导入一次。用例核对事件身份与次数，没有断言模型回显提示词标记，也不证明带工具 grant 的全部崩溃窗口。

### 阶段 A：固定失败事实

在实际 Service/Host 入口，使一个父 Run/Turn 派发三个只读 child，随后给出完成候选；控制 A/B/C 错峰结算，记录模型调用、工具终态、`completion.blocked` 的 code／nextAction／correctionAttempt、各 task/attempt、`subagent.background_result_persisted`、Kernel 接纳、owner watermark、Run/Turn 事件和客户端投影。再分别验证一个 child 首先成功、失败、取消；另做两个有限 Shell 及 Shell+child。受控 Provider 已覆盖成功先到、失败先到、排队 child 取消先到、双 Shell 两种顺序及首个非零退出、单 Shell+单 child 两种顺序，以及 S1/S2+A/B 的 Shell 先、child 先、同批结算；正式 Service/Host barrier 文件 11/11 通过。排队 child 取消用例不代表运行中 child 与 Shell 的取消排序；混合精确停止的证据见下段，Shell 到期和用户引导等剩余竞态仍须按下表核对。实际打包 Electron 已覆盖三个 child 局部完成时的等待和任务卡；真实 Provider 的上述隔离多 Session 用例已通过。原失败 Run 的精确安装版本在当前持久库中不可证明。

补充的[混合精确停止正式入口验收](../../apps/kite-service/test/isolated/runtime-server-mixed-background-stop.test.ts) 2/2 通过：停止有限 Shell 后，独立 required child 继续，父 Run 零纠错等待并唯一完成；反向停止正在进行模型请求的 child 后，清理已确认且 Shell 不受影响，但已派发模型预算成为 `unknown`，父 Run 按 `reconciliation_required` 保守终止，不能宣称正常完成。该测试使用响应中断的受控 Shell 执行器；实际进程超时及其清理尚未由正式混合入口证明。

### 阶段 B：等待与部分完成修复

按阶段 A 证据对真实失败分支做最小修复。所有有证据的在途工具、required Shell 和 child 均使用不消耗 correction attempt 的等待语义；完成等待 port 不得是可无声缺失的可选接线。核对自动 barrier、显式 `task_wait`、`shell_read`、结果幂等接纳和 owner 恢复。保持现有 Artifact、Store、watcher 和 Kernel 权威，不新增通用调度器。

### 阶段 C：模型调用与展示

更新工具描述与真实会话示例，使模型在需要首个结果决策时选 `task_wait`，只需等齐时提交完成候选；Shell 按游标使用 `shell_read`。验证具名结果进入主模型输入、截断后补读、准确来源标签与幂等性。客户端明确初始等待集合和当前任务卡状态；若承诺动态剩余集合，完成其权威推导与测试。

### 阶段 D：Codex 式 Agent 消息与续轮

按 §4.0 与 [Agent Note 0191](../../.agents/notes/implemented/feature/2026-09-26-independent-agent-sessions-and-result-bridge.md)实施：D0／D1 的独立子 Session、根会话过滤、结果桥接与审批恢复已完成受控验收；D2 的跨线程邮箱与模型输入水位已在正式入口通过受控验收。`list_agents` 与 `wait_agent` 的跨 Session 模型 Surface、直接子树读取、未读唤醒及超时也已通过正式入口受控回归。D3 的 `followup_task` 来源 Tool 持久受理、空成功回执、目标 `new_turn` 终态及来源 ACK，和 `interrupt_agent` 的准确直接子停止，已通过正式 App Server 回归；当前轮零 Tool 旧 grant 的路由及 route-only／released 两种进程级重启窗口通过内部真实链路验收。不同 Session 的 mode revision 数值不能直接作为相同策略证明；Store 已分别核验来源政策及其 revision、目标初始 mode／revision 0，来源 auto revision 1 与子 revision 0 的 `current_turn` 在线及真实 SIGKILL 用例已通过。当前轮的非零 Tool 旧 grant 仅在有限、无 binding 的 `explore`／`plan`／`review` 角色中受理，并把下一模型 Surface 与后续工具派发压到静态只读工具交集；正式 App Server 定向测试覆盖第二次模型请求的原 Run 消费。有限备付排队等待执行位、满位 `capacity_timeout` 的定向回归已通过。A–C 的等待故障修复不依赖 D3 完成。

2026-09-26 补齐 `after_turn` 独立子 Session 的跨 Run 接线：父 `task` 一次受理子额度与自动汇报额度，原父 Run 完成后子执行仍可在原期限内继续；重启只保留 Store 可证明的 pending、同进程 live ACK 和已封存结果的报告预留。正式 App Server 的[新轮验收](../../apps/kite-service/test/isolated/runtime-server-after-turn-independent-followup.test.ts)与[当前轮验收](../../apps/kite-service/test/isolated/runtime-server-after-turn-current-turn-reply.test.ts)各通过，核对后续人类 Run 的显式续轮、唯一回信、原子结果一次导入和 `human_start_preferred` 抑制自动汇报后的预算释放。Store 的原父 Run 检查允许 `after_turn` 已完成 Run 的未结算子意图继续外部工作；`required` 仍要求活动父 Run。Host 在等待空闲前后均检查后续人类 Run，避免自动汇报等待与显式续轮互相阻塞。真实 Provider 的 D0／D3 独立验收已覆盖共享生产链路；这两个 `after_turn` 跨 Run 排序由受控 Provider 验证，尚未扩展为真实 Provider 单独用例。

### 阶段 A–C 的事件级验收

以下每组都核对同一 `runId/turnId`、模型调用次数、`correctionAttempt`、每个 terminal 的持久次数，并在部分完成检查点断言**没有** `turn.aborted(cause=error)` 或 `run.error`。正常等待不可仅以客户端“仍在运行”卡片证明。

| 场景 | 必须观察到 |
| --- | --- |
| 三 child 自动 barrier | 同一父轮派发 A/B/C 并提交 final 候选；首个 `completion.blocked(nextAction=wait_for_background,correctionAttempt=0)` 后，A、B 依次结算而 C 仍在时不再请求主模型；各结果帧只接纳一次，父轮仍 waiting；C 结算后仅一次主模型调用包含三个不同 task 的具名结果，最终各一次 `run.completed`／`turn.completed`。交换终态顺序并覆盖首个成功、失败、取消 |
| 三 child 显式 `task_wait` | wait 工具租约在 A 终态前已建立；A 同时唤醒 wait 并被 canonical 接纳，下一模型输入有一个 `task_wait` 回执和一个 A 的 `<subagent_result task_id>` 帧，没有 B/C 结果；后续 final 对 B/C 可再进入零纠错自动等待。重放 terminal、重连后不再注入第二帧或第二次唤醒 |
| 两个 required finite Shell | 完成候选先进入 `wait_for_tool`，correction attempt 为 0；S1 退出而 S2 仍在时无主模型调用、无第二次纠错拦截、无父 `run.error`；S2 退出后只恢复一次并看到两项终态。两种先后顺序和首个非零／到期／取消均验证，输出游标与 cleanup 各准确结算 |
| Shell 与 child 混合 | child 先终态而 Shell 仍在时保持 `wait_for_tool`；Shell 先终态而 child 仍在时无模型调用地转到 `wait_for_background`；同时结算只唤醒一次。扩展为 S1/S2+A/B 防止重复 owner 通知触发多次调用 |
| 用户引导、deadline、停止 | 引导在首个终态前、两个终态之间、最后终态同刻的各排序中，下一次主模型调用最多一次，输入各含一次引导及已接纳结果，兄弟任务继续；再次 final 可重入零纠错等待。精确停止不影响兄弟；deadline／整轮取消与终态竞态只生成一个父终态 |
| 持久化与 owner 故障注入 | Artifact 已写但 Kernel 尚未接纳时 required 不解除；无关 owner watermark 不调用模型；wait port 抛错／owner 代际丢失进入有分类恢复或 unknown，不能掉入泛化的 `Completion blocked...` 致命兜底；旧租约、重复通知与迟到 terminal 不产生第二次结果帧 |
| 模型输入与客户端 | 每个已接纳 child 的输入是带准确 task ID、低权限来源的具名 `<subagent_result>` 帧；完整报告保留在 Artifact，`task_read` 只用于截断或诊断。客户端等待原因若显示动态剩余 ID，A/B 结算后该集合准确缩小；若采用初始集合，卡片终态准确，文案不称其为“剩余” |

阶段 A–C 的设计与交付证据以本方案第 7 节为准；阶段 D 按 §4.0 的每 Agent 独立 Session 决定与现行 owner 契约核对。[Agent Note 0190](../../.agents/notes/implemented/feature/2026-09-26-codex-style-agent-mailbox-and-followup-authority.md)保留原交互及单 Session 取舍的历史正文，其共享 Session 事务范围已暂停作为实施依据。[Agent Note 0191](../../.agents/notes/implemented/feature/2026-09-26-independent-agent-sessions-and-result-bridge.md)及已同步的 owner 文档记录 D0 已确认设计；各实施迭代完成后执行 `iteration_complete`。受控 D0／D2／D3 验收支持已开放的独立子 Session、QueueOnly 邮箱、Agent 列表／等待、显式续轮和直接子停止；真实 DeepSeek 验证覆盖 A–C，以及 D3 各自独立的合成 `new_turn`／跨 Run 回复和 `current_turn` 同 Run 邮件输入；其他竞态与恢复边界仍以本地受控 mock 和进程级测试验证。
