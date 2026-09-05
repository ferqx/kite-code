# Runtime Contract

## 定位

`@kite-ai/runtime-contract` 是 Kite Runtime 的私有、进程内客户端边界。它只暴露 JSON-safe 的 command、query、subscription、notification 与 presentation 数据。

## 拥有职责

- 定义 Session command、query、receipt、notification 和 projection。
- 定义封闭的 `RuntimeClientEvent`、`RuntimeClientInteraction` 与 complete history transcript DTO；未知
  Runtime 事实必须由 App projector 省略或投影为 `unavailable`，不得透传原始对象。
- 本地展示 DTO 保留有界 reasoning segment、动态工具 label、JSON-safe arguments、terminal result/progress
  与取消原因；只过滤明显 credential/authority material，不把普通 path/pattern/command/result 清空。
- `model.text_delta` 与 `reasoning.activity` 必须携带对应 model request identity；live projector 保留 Kernel
  event 的 `requestId`，history replay 从 durable model invocation identity 重建同一字段。`tool.queued`可携带
  opaque `presentationGroupId`，只把tool call与产生它的closed model message关联，不暴露Provider或Kernel payload。
- `subagent.started`可携带Runtime签发的opaque `concurrencyGroupId`；同一并发派发批次的child在live与History中
  保留该字段，使展示层能按真实dispatch identity聚合，串行child不携带该字段。
- `subagent.completed`携带Runtime实测`toolCallCount + durationMs`；`subagent.failed`可携带同类终态计量和仅含
  `code + stage`的低敏感度诊断，App projector不得把`modelInvocationId` correlation带入Client边界。
- `AcceptedPresentationEnvelope` 是唯一进入消息 projector 的接收边界：每个 envelope 固定 Session、connection
  generation、durability，以及由事件 coverage scope 要求的 Run/Task/Turn identity 与 ephemeral stream tuple；model/tool/subagent/interaction 事件必须绑定 Turn，Task/Turn/Run terminal 的 envelope identity 必须与事件字段精确相等；Subagent step/review/phase 和审批 owner
  均使用稳定 child/tool identity，不能由展示层按工具名或到达顺序补全。
- 固定 command identity、expected revision、幂等回放与冲突语义。
- 定义private、closed的Run projection、`get_run`/bounded `list_runs` query，以及applied/replayed command receipt上的original
  Run resource；这些DTO不代表Public Agent API route已开放。
- Session projection schema v2把`activeTask`与current-or-last `currentRun`分开；currentRun携带stable
  `runId/initialTurnId/activeTurnId`、revision、precise terminal或`recovery_required`；不存在第二份Work lifecycle DTO。
  accepted start receipt另投影由同commandId确定性派生的`messageId`，不增加持久receipt字段。
- 为已认证的 App admission 定义可选的进程内 `RuntimeCommandContext`（connection/request identity 与 opaque
  Worker binding reference）；它只随 `RuntimeAccess.command()` 在本进程内传递，永不进入 Runtime Protocol、History 或 Browser
  contract。
- 为未来 transport adapter 提供中立数据边界。

## 不拥有职责

- 不包含 Kernel State、Host lifecycle、Provider handle、SQLite 类型或 TUI block。
- 不执行命令、不持久化、不分配 identity。
- 当前不是公共 SDK 或网络协议兼容承诺。

## 允许依赖

本 package 没有 workspace 或运行时依赖。

## 公开入口

只导出 package 根入口 `@kite-ai/runtime-contract`；`src/index.ts` 仅组合分域 contract。

## 关键不变量

- 所有客户端数据保持普通 JSON-safe 数据。
- command 必须携带唯一 `commandId`；Session mutation 使用 revision fencing。
- 已建立Run的`cancel_turn`必须同时携带canonical `runId`与active `turnId`；缺失或错配在执行前fail closed。
- Run query只接受Session-scoped opaque identity和最多200项的ASC keyset cursor；Run resource只出现在创建它的original/replayed
  applied receipt，不允许Client以当前query结果伪造原始command response。
- `delete_session` 是 Host-owned mutation：按 scoped command identity 删除 Session durable facts并保留
  receipt；Client/TUI 不能直接调用 Store delete。重放同一 digest 返回原 receipt，不同 digest fail closed。
- `respond_interaction` 必须携带匹配的 client-safe interaction identity：Session revision，及按 kind
  所需的 approval generation/grants、Plan identity、provider directory revision 或 verification revision。Approval
  interaction可选携带有界原始command供用户作知情决定；它不携带cwd、grant subject或binding digest。
- Approval grant闭集为`approve_once|same_command`；Contract只绑定用户选择与interaction identity，不解释command
  effects或自行选择Sandbox scope。
- `RuntimeSubscriptionSpec` 是唯一可序列化 selector；`AbortSignal` 只属于 local
  `RuntimeSubscription`，不得进入 wire。
- `RuntimeCommandContext` 必须在 admission 后 strict validate/freeze；`bindingReference` 只能由 App-owned admission
  提供，Contract package 不解释其内容、不持有 credential，也不按 Session 反查 authority。
- `plan.approved` 是审核 settlement 的封闭 client event，携带 interaction identity、Session revision 与
  execution mode；Client 不从 raw Plan/Kernel event 推断审核已完成。
- `RuntimeHistorySessionTranscript` 只含同一 `RuntimeClientEvent` union；它是 display/recovery evidence，
  并以`restart_required`明确标记没有durable terminal的Turn，使客户端在订阅前尝试显式Server恢复；若恢复被旧effect lease
  暂时fence，TUI只能只读展示durable transcript并报告本地诊断，不得合成Run terminal。
  每个durable record同时携带用于构造Accepted envelope的Run/Task/Turn identity；首条用户消息早于lifecycle admission时，
  Service reader在后续`task.started/turn.started`到达后按持久顺序前向join，无法join的旧记录使用明确的`legacy-*`
  迁移identity。TUI仍不接受无identity lifecycle event，也不携带callback、Store handle或历史interaction settlement authority。
- `ListRuntimeLogEventsRequest`允许同时携带exclusive `afterSequence < beforeSequence`，形成有界sequence window；
  单侧cursor仍保持原语义，等于或反向window fail closed。该窗口只约束只读History，不产生snapshot/receipt或Store authority。
- `RuntimeSessionProjection.interactionQueue` 是同 revision 的完整、有序替换集；`activeInteractionId` 必须属于该集，
  每个interaction的`sessionRevision`是当前 settlement CAS，必须等于queue/session revision；稳定交互身份由
  `interactionId`与kind-specific generation/plan/provider/verification/input/command字段共同组成。Session revision
  前进时Service以相同稳定身份重新投影当前CAS，identity重复、缺失、内容漂移或currentRun/queue身份不一致全部
  fail closed；同ID/revision但command、grants或其他kind-specific字段不同同样非法。
- Live notification 与 History transcript 必须通过同一个 exact `RuntimeClientEvent` validator；closed DTO
  新增可选字段时，类型、validator 与 wire codec 必须同步，不能让实时订阅可见而恢复/回放拒绝同一事件。
- 模型展示事件的 `requestId` 是 exact closed DTO 的必填字段；缺字段或额外字段均不进入 client boundary。
- 新写入的tool queue projection用`presentationGroupId`与`model.responded.messageId`精确配对；该字段只参与
  Presentation grouping，不是execution、authorization或settlement identity。旧History没有该可选字段时仍可回放。
- `subagent.started.concurrencyGroupId`同样只属于Presentation grouping，不授予调度或授权能力；Contract validator
  对其执行bounded identifier校验，缺少该字段的串行或旧History事件保持合法。
- Contract 不泄漏具体执行、存储或展示 authority。

## 测试

`bun test packages/runtime-contract/test`

## 文档影响

模块局部变化更新本 README；跨包 Session 或客户端语义同时更新 [Runtime 架构](../../docs/active/six-concept-runtime-architecture.md)。
