# Agent 协作等待与最终答复的展示优化

状态：已按用户确认的方案实施并完成定向评审，2026-09-27。范围为开发中的 Kite Desktop 主会话；Web 继续只读，TUI 的现有交互未改变。

本方案细化[桌面客户端日常体验方向](desktop-client.md#首轮验证后的日常体验方向)中的“执行与交互”和“Subagent 桌面协作”。当前产品行为仍以[桌面手册](../handbook/clients/desktop/README.md)和[执行与结果](../handbook/features/execution.md)为准；本文保留方案、验收场景和实施依据；现行产品行为见桌面手册。

## 问题与依据

2026-09-27 本机多 Agent 会话出现以下顺序：主模型输出较长的“已派发，等结果回来汇总”正文；随后同一 Run 因三个 required 子任务进入 `completion.blocked → wait_for_background`；子任务结果被父会话接纳后，主模型继续并写出真正的最终答复，最后才出现 `run.completed` 和 `turn.completed`。当时侧栏保持运行图形是准确的，但正文结束后缺少清楚的等待说明，容易被理解为“主 Agent 已最终回复，界面却仍在 loading”。个人会话内容和 ID 不纳入仓库。

当前实现的责任与证据：

- [Kernel 完成检查](../../packages/agent-kernel/src/completion.ts)在 required 子任务未结算时阻止终结；[Service runner](../../apps/kite-service/src/bootstrap/runtime/state-runner.ts)保持同一 Run 等待，收到可行动状态后继续。
- [Service 投影](../../apps/kite-service/src/runtime-client/event-projector.ts)把 `model.responded` 正文和工具调用数交给客户端；`completion.blocked` 与 required-child-wait 事实没有成为独立的用户消息。
- [Desktop 投影](../../apps/kite-desktop/src/presentation.ts)在 `model.responded` 后把当前文字结为已输出、`finalReply: false`，只在 `turn.terminal(completed)` 后确认最终回复；[共享消息组件](../../packages/kite-client-ui/src/Conversation.tsx)此时移除“正在回复”。
- [Desktop 会话页](../../apps/kite-desktop/src/App.tsx)和[共享侧栏](../../packages/kite-client-ui/src/Sidebar.tsx)依据 Run `waiting` 保留活动图形；现行[桌面手册](../handbook/clients/desktop/README.md)明确不显示单独的后台等待提示。

### Codex CLI 参考边界

| 已核实的 Codex 行为 | 来源 | 对 Kite 的含义 |
| --- | --- | --- |
| Agent 消息可标 `commentary` 或 `final_answer`；阶段可缺失，不能仅凭文本长度或单次模型输出判断最终。 | [App Server 文档](https://learn.chatgpt.com/docs/app-server)、[消息定义](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs#L871-L885) | 区分过程正文与终局答复，同时保留 Turn 终态作为完成权威。Kite 当前模型接口不承诺提供 Codex 的 `phase` 字段，不能直接复制其 wire 值。 |
| TUI 的运行态由任务开始和完成事件控制，等待工具明确显示正在等待 Agent、等待结束及各 Agent 状态。 | [Turn 生命周期](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/turn_runtime.rs#L67-L171)、[多 Agent 展示](https://github.com/openai/codex/blob/main/codex-rs/tui/src/multi_agents.rs#L186-L385) | 已有侧栏运行态继续由 Run 终态决定；在消息阅读列补足可见的等待状态。 |
| 子 Agent 有独立线程，主 Agent 等结果后汇总；CLI 可切换查看活动子线程。 | [Subagents 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents) | 复用 Kite 已有子会话详情，不为这次状态提示增加新导航或调度入口。 |

参考材料核对日期为 2026-09-27。Codex 的协议和 TUI 实现是交互参照，不是 Kite Runtime 的兼容要求。

## 目标行为

1. **正文阶段清楚。** 一次模型输出结束，只说明该段文字已输出；终局事件到达前正文保持中性展示，不提前标成“过程更新”或“最终答复”。同轮确有后续工具或等待事实时，由相邻的工具记录和等待状态说明工作仍在继续。最终答复仅在准确 `turn.completed` 后标记。不能从“我已完成”“我会等待”等模型措辞、文本长度或 spinner 推断终局。流式文字仍显示现有“正在回复”，该段输出结束后停止流式动画。
2. **等待阶段可见。** 当所选父 Run 的持久投影为 `status: waiting` 且 `waitingReason.kind: required_background`，在消息阅读列现有消息之后显示一条轻量状态“正在等待子 Agent 结果”。仅在所选 Session 与投影身份相同、主会话历史已加载、当前显示的确是主会话正文时展示；工作台、新对话、子会话详情和切换／重接中的非当前投影都不展示。它是运行状态，不是主 Agent 新说的一句话，也不插入人类/模型 transcript。原有子 Agent 卡片继续逐项展示创建、运行、完成或失败；侧栏活动图形和停止、运行中引导继续可用。
3. **恢复处理可辨。** 父 Run 因必需结果接纳而退出等待后，等待状态及时消失；若后续模型或工具已开始，按现有过程记录展示其实际动作。不要仅因子线程自身结束就宣称“主 Agent 已收到”或“正在汇总”。真正的最终答复和停止图形仍以 Run/Turn 终态为准。
4. **异常不伪装成功。** 失败、取消、恢复待核对以及用户在等待期间追加引导，都遵循已有 Run 和子任务事实。离开等待不自动显示“全部完成”；未能确认的子任务保持 unknown/unavailable 语义。`after_turn` 子任务若不阻塞当前 Run，不显示本轮 required 等待状态。
5. **历史与重接一致。** 切换会话、刷新或恢复订阅后，活动等待提示由最新服务投影重建，同一 Run 只显示一处。Turn 已终结时不因旧正文或历史子任务卡片重新显示等待。本轮 Web 不传入 Desktop 专属等待展示数据，也不显示该提示；共享组件不能自行推断服务状态。

等待状态首轮使用不带数量的文案。现有 `waitingReason.taskIds` 是进入等待时的必需任务集合，不直接表示当前剩余数；子线程终态与父会话结果接纳也有先后顺序。子 Agent 卡片负责逐项进度，避免把“已完成 2/3”建立在不同水位的客户端快照上。若后续需要聚合计数，应先证明同一父级接纳水位上的准确来源，再另行核定文案。

## 实施边界与交接

| Owner | 拟做工作 | 边界 |
| --- | --- | --- |
| Desktop presentation / App | 从所选 Session 的当前 Run 持久投影、`currentRun.status` 与 `waitingReason` 推导活动等待视图；保持现有 `finalReply` 的终态判定；仅在主会话已加载、未打开子详情且身份匹配时向共享页面传递可选展示数据。 | 不读取 Store，不靠当前模型文本猜测状态；会话切换、重接、工作台和新对话不沿用上一会话的等待视图。 |
| 共享 `kite-client-ui` | 在当前 Turn 的消息末尾渲染等待状态，提供可访问的 `role=status` 文案；不占用输入框上方独立状态行，不重复子 Agent 卡片。 | 组件只消费 Desktop 端给定的状态；Web 本轮不传入该数据。组件不决定 Run 完成，也不产生新的消息事实。 |
| Service / Runtime Contract / Kernel | 首轮复用已有 `currentRun.waitingReason`、子 Agent 生命周期与 `turn.terminal`。 | 不新增持久状态、调度器、轮询、工具操作或协议字段；若实施中发现现有投影不能准确承载所选状态，先补确切证据并评审最小契约变更。 |

本方案不改变 required 子任务的接纳、唤醒、预算、取消和恢复语义。Codex CLI 的消息 `phase` 只用于确定呈现原则；Kite 首轮通过已存在的模型消息、后续工作事实和 Turn 终态区分“仍在进行”与“已最终完成”，不把未接入的 Provider 字段伪造成稳定协议，也不增加持久的“等待结束”历史项。

## 验收场景

| 场景 | 必须观察到的结果 |
| --- | --- |
| 一次模型回复同时派发三个 required 子 Agent，并写出较长说明 | 说明先保持中性展示；模型文字停止流动后，Run 仍显示活动，阅读列明确显示等待状态；不会出现最终答复标记。 |
| 三个子任务错峰结束 | 卡片按各自真实终态更新；父结果未全部接纳前保持等待；仅子任务日志或进度变化不触发主模型空转。 |
| 全部结果接纳并继续主模型 | 等待状态消失，新的模型/工具过程按真实事件显示；最终正文经 `turn.completed` 确认后才标记最终，侧栏活动图形在 Run 终态后停止。 |
| 等待中切走、刷新、返回；历史重放 | 只从匹配的父会话投影恢复一条准确等待状态；终态历史不复活等待，也不把旧正文升成最终回复。 |
| 等待中打开子会话详情，或切到工作台、新对话、正在加载的另一会话 | 不把父 Run 的等待提示插入子会话或非当前会话的消息阅读列；返回已加载的父会话时再由当前投影显示。 |
| 最后一段模型正文已输出，终局事件尚未到达 | 正文保持中性展示，没有短暂的“过程更新”或“最终答复”误标；准确 `turn.completed` 到达后才确认为最终。 |
| 一个子任务失败、取消或结果未知；父 Run 失败或用户停止 | 子任务与父级分别显示真实状态和已有失败/恢复提示；等待状态不冒充成功，停止按钮和运行中引导遵守原有权限。 |
| `after_turn` 或没有后台子任务的普通 Run；Web 只读页面 | 不出现 required 等待提示；Web 本轮始终维持当前只读呈现，即使共享组件支持 Desktop 的可选展示数据。 |

实施验证应先覆盖 Desktop 投影与共享页面组件的事件/DOM 测试，再用隔离的真实 Service 三子错峰用例核对等待、结果接纳和重接，最后在 Electron 窗口核对正文、状态、停止按钮、键盘焦点与窄窗口布局。测试分别记录所断言的行为，不能用静态截图替代持久事件和终态检查。交付时同步桌面手册、Desktop 和共享 UI owner；只有实际改动 Runtime Client 契约时才同步其 owner 与跨包 active 文档。

## 评审记录

2026-09-27 内部只读评审核对了桌面手册、Desktop/Service/Runtime Contract/共享 UI 的现行路径及 Codex CLI 官方资料。发现并修正三项：终态前最后正文不能预先标“过程更新”；父级提示必须排除子会话详情及非当前会话；Web 本轮不消费可选状态。现有 `currentRun.waitingReason` 足以支持活动等待提示，未发现必须新增 Runtime 状态或协议字段的阻断。评审仅证明方案与当前证据相容，不构成产品确认或运行验收。


## 实施与验收记录

2026-09-27：Desktop App 仅在所选父 Session 与投影匹配、连接及历史就绪、当前展示主会话，且持久 Run 为 `waiting/required_background` 时传入 `requiredSubagentWait`。共享会话页在消息阅读列末尾用现有 Marker 绘制单条 `role=status`；Web 不传入。离开等待、切换会话、打开子会话详情或转到其他页面时提示撤下。没有改变 Service、Runtime Contract、Kernel 或消息历史；既有 `turn.completed` 仍负责最终回复身份。

验证：共享页面 70 项测试、Desktop UI 81 项测试、Service 三子任务及混合等待 11 项测试、共享与 Desktop 类型检查通过；Electron renderer/host 打包通过。隔离 HOME 与本机模型 fixture 的打包 Electron 窗口验收（`bun run --cwd apps/kite-desktop test:native:window --execution-recovery`）通过：三子错峰等待、等待中刷新恢复、部分结果接纳、打开子会话详情、最终回复终态、停止入口、输入焦点与 900 px 窄窗口布局均已核对。此模式跳过原生 smoke 中与本次交互无关的复制按钮与文件变更几何检查；默认 smoke 仍受这些旧断言影响，不能据定向通过宣称整个默认 smoke 通过。没有调用外部 Provider。

本次交付的产品与实现事实已同步[桌面手册](../handbook/clients/desktop/README.md)、[Desktop 会话 owner](../../apps/kite-desktop/docs/conversation-ui.md)和[共享 UI owner](../../packages/kite-client-ui/README.md)。此前评审提出的三项边界由当前实现和测试保持。
