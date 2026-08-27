# TUI 交互规范

本页是 `apps/kite-cli` 的 owner-local current authority，覆盖 Overlay、输入焦点、状态行、Session 导航和用户交互投影。

## Runtime 输入与投影边界

- TUI command/query/subscribe 只消费 typed Native client surface；生产路径固定为 terminal
  `LocalKiteConnection/RuntimeClient → companion kite-service RuntimeServer → Service RuntimeAccess`。TUI 不组合 Server。
- reducer、block replay 与 interaction UI 只接收封闭 `RuntimeClientEvent`/client interaction projection。未知或无法安全投影的事实显示固定 unavailable/error 状态，绝不扩张为 `any` 或 raw Runtime event。
- TUI本地只缓存`model.responded.messageId → requestId`与tool queue的opaque `presentationGroupId`配对；匹配结果只
  决定Presentation step归属，不参与Runtime command、approval或execution identity。新事件不按“当前block/上一条event”
  猜group；identity缺失或不匹配的工具保持独立neutral group，不得把当前Thought当作wildcard owner。
- 普通 prompt 不做本地 optimistic append；唯一显示来源是 RuntimeClient 的 durable `user.message`。
  reducer 以 canonical `messageId` 处理重连/回放幂等，不能按文本去重，因此同一消息只显示一次、
  两个不同轮次的相同文本仍保留两条。`USER_MESSAGE` 只用于不会进入 Runtime 的本地 slash echo。
- 输入框在当前Turn运行时提交的普通消息进入本TUI的FIFO，等待authoritative远端run/cleanup idle后再取得prompt
  reservation并发送；不得在`tryReservePrompt()`失败时静默清空。恢复中的active projection即使没有本地run Promise也必须
  等待Service projection变为idle。队列在Enter时固定Session identity，切换前台不能改投目标；单条失败仍对调用方可见且
  不阻塞后续消息。排队会显示明确提示，最终command失败显示可重试的“未发送”错误。
- 历史 Session 的完整 durable replay 只通过 `RuntimeClient.history` 的 App-injected `RuntimeHistoryClient`
  向前分页读取 complete closed transcript，并与 live 事件共用 reducer。短期 subscription replay/gap reset
  不是完整 history source。event-free snapshot仍是当前activity/interaction的权威projection：Service投影同revision
  完整interaction queue与active identity，Native adapter和reducer按该集合替换本地interaction Map、pending approvals
  与focus，而不是追加一个focused interaction。它可清除已不存在的旧queue项或停止已经不存在的active work，但不制造
  approval settlement或用户取消事件。
- TUI 不直接 import 或持有 Runtime Host、SQLite/Store、Kernel、Builtin executor、RuntimeLogQueryPort 或 transport/server concrete type；它不自建 mailbox、receipt、recovery 或 SQLite fallback。
- TUI 的 Native client surface 是显式 `TuiRuntimeClientFacade` / `TuiSessionFacade` method 与字段清单；不得从
  Service `SessionManager` 推导类型，也不得使用 Proxy、Reflect fallback、动态 member cache 或 set trap 让
  implementation 新成员自动进入 TUI。新增 surface 必须同时修改interface、adapter与fake/native conformance tests。
- Workspace Trust、Provider/model、MCP、Skill与status逐方法消费exact App Control client，request/response都通过
  browser-safe codec；first-run raw credential只通过Native credential client。TUI不持有Config Repository、
  credential writer、MCP Supervisor、actual Skill manifest、Host或Store；这些 owner与raw Runtime/history projector
  已 clean-relocate 到 `apps/kite-service`。
- MCP mutation的applied/rejected/outcome-unknown提示由controller在消费单次response后写入；后续250ms safe snapshot
  轮询只更新control projection，不得清除尚在展示的mutation结果或据此重放mutation。
- Workspace Trust 是两阶段Runtime admission。启动先 `prepareAppControl()` 并显示Service query/decision结果；只有
  canonical Workspace及Service发现的exact external-read scope均被用户确认后才打开Runtime connection。TUI逐项显示
  safe snapshot中的canonical只读roots并把scope digest绑定到decision，不按命令名自行推断。scope/revision conflict会刷新
  snapshot并回到普通授权选项，用户再次确认即可继续；decline或真实unavailable时不发送Runtime initialize，
  不以cwd或wire path绕过，也不回退embedded。Trust status枚举只用于内部路由，不作为用户可见状态行。
- TUI exit、first-run、Workspace Trust与config error统一调用一个idempotent exit coordinator。退出只关闭client
  connection并清理UI/observability，不调用`abortAll`或Runtime Application owner dispose；Ctrl+C取消当前Turn仍通过
  explicit Runtime cancel command。React unmount不得二次fire-and-forget shutdown。

## 单一交互表面

- Slash command 打开的帮助、模型、权限、推理深度、主题、语言、Session、MCP 与恢复页面共用一个 modal 边界。
- Slash suggestion 只拥有 partial completion；已经精确匹配的命令由主输入的 Enter 路径提交一次。
  Esc 可关闭当前 suggestion，后续输入变化才重新打开，不能由 suggestion 与 TextInput 各提交一次或互相吞掉。
- Modal 可见时隐藏主输入提示、Footer 状态栏和 slash suggestion，不允许两个交互表面同时取得键盘 authority。
- 页面只解释展示状态；route、selection、draft、controller command 与 Runtime facts 仍由宿主 owner 管理。
- First-run/setup 使用独立 `FirstRunShell`，不复用普通 Overlay lifecycle。

## Overlay 布局

`OverlayFrame` 唯一拥有标题、正文、可选消息和快捷键四区的外层节奏与水平 inset。页面根节点不得重复
`marginTop` 或 `paddingX`，不存在的消息不渲染占位空行。

- Summary、Section、List、ChoiceList、DetailList、Message、ImpactNotice、EmptyState 与 ShortcutBar 使用共享 primitive。
- 可选择列表把每个可操作行直接交给 ScrollList/VirtualList；heading 不参与编号或 selection。
- 搜索行、问题说明、warning callout 与首个选项之间固定保留一行；组内选项保持紧凑。
- 删除、禁用、重连、认证、配置写入、权限或恢复动作显示“将做什么/不会做什么”的影响边界。
- 危险确认默认选择取消；普通导航和只读查看不显示副作用提示。

## 审批、问答与方案审核

- Approval Overlay 只绑定 durable queue 当前 `activeApprovalId`；后台 pending record 不抢占 Footer 或键盘。
- Enter/Esc 携带 exact `interactionId` 与 generation；Enter 提交当前 grant，Esc 只拒绝当前焦点，迟到 action 为 no-op。
- Ctrl+C 取消整轮 queued/awaiting/authorized/running siblings，不能退化为 focused reject。
- approval、ask_user、Plan review及其Enter/Esc动作在`respond_interaction`获得applied/idempotent receipt前保持可见；
  accepted receipt后才允许本地结束提交态，canonical granted/batch-released/rejected/input/plan event仍拥有durable结果。
  transport/protocol/identity失败不得被吞掉，UI显示可重试错误且不伪造已授权、已回答或已取消事实。
- 不存在interrupt清除后自动补发cancel的旁路。交互只由当前用户动作的一次receipt链路与后续authoritative queue/event
  收敛；否则已接受动作可能被第二个fire-and-forget cancel覆盖。
- `ask_user` 单题把问题放入标题，多题使用 `n / total` meta；自定义输入留在原列表，已完成回答不得在恢复时重开。
- Plan review、MCP recovery/admission 与其他交互同样只由 canonical terminal event 清除。
- Plan approval 由单个 `plan.approved.executionMode` 同时固定本次 Task 执行模式与 Session/TUI 镜像；不得
  在它之前插入 `interaction_mode.changed`，否则会先清除 awaiting-review interaction，令随后 approval identity
  fail closed。用户后续独立切换全局模式时才产生 `interaction_mode.changed`。
- Provider recovery/admission 与 verification 只显示 provider ID、封闭 action、verification ID/revision
  和固定选项。Provider body、credential、directory 内容、verification evidence/path/stdout 不进入 TUI；
  retry 必须绑定 directory revision，waive/defer/cancel 不伪造一个 revision。

## 选择器与 Session

- 模型 identity 是 `provider + model name`；不同 provider 的同名模型保持独立 key 和 route。
- `/model`、`/permissions`、`/effort`、`/theme`、`/language` 不接受选择参数，必须打开选择器并显式确认。
- `full` 是唯一 unrestricted interaction mode；restricted backend 不可兑现 scope 时 fail closed。
- Session 切换恢复各自模型 route、interaction mode、context 与 Runtime projection，不继承上一 Session 的瞬时状态。
- 历史 Session 先等待 typed Runtime readiness/recovery，再通过 HistoryClient 读取 persisted head 并提交 navigation；迟到 load 不覆盖新选择。
- Session 删除是带 scoped command receipt 的 Runtime command；Host/Store 在单一事务边界删除 Session
  facts 并保留 receipt。TUI 不直接删除 SQLite 行，也不能在 close snapshot 之后把已删 Session 复活。

## 主输入与状态行

- `InputLine` 在首次 Ink effect flush 注册 `useInput` 后立即可编辑；注册前不显示假焦点，不使用固定延时作为门禁。
- 状态阶段单向推进 `Thinking → Working → Finishing`；进入 Working 后不因模型/工具交替回退。
- Retry、Approval、Input 与 Compaction 是覆盖态，不改变底层阶段。手动 compaction 使用消息区动画，自动 compaction 与当前 run 状态并存。
- 工具卡可乐观显示 running，但执行耗时从 durable `tool.started` 开始；迟到 started 不复活终态卡片。
- 工具 policy/formatter 只使用封闭 canonical category；动态 MCP/Provider 工具另携带 App 投影的有界
  `displayLabel`，所以本地界面保留具体名称而不把任意字符串提升成 capability。不得用通用 `tool` 占位
  覆盖已经投影的具体名称。
- queued 工具只缓存 call ID、category、display label 与完整有界 arguments；started 才物化。普通本地
  path/pattern/command/result 可显示，明显 credential 仍在 App projector 过滤。
- TUI 只根据结构化 terminal outcome、safeRetry 与 canonical events 决定完成/错误，不从本地化文本反推。

## 验证

`bun test apps/kite-cli/test`、`bun run test:tui:system:core`、`bun run typecheck`。
