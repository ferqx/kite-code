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
- `subagent.started`可携带父 task 的`parentToolCallId`及Runtime签发的opaque `concurrencyGroupId`；前者建立准确的
  task归属，后者让同一并发派发批次的child在live与History中按真实dispatch identity聚合。旧History可缺少这两个字段。
- child内部tool lifecycle从queued到terminal均可携带仅用于展示的`presentationOwner { subagentId, parentToolCallId }`。
  Client据此把hidden异常保留在所属task执行过程；terminal-only replay也不按`toolId`格式、名称或到达顺序猜测，缺少owner的旧终态异常仍可独立展示。
- `subagent.completed`携带Runtime实测`toolCallCount + durationMs`；`subagent.failed`可携带同类终态计量和仅含
  `code + stage`的低敏感度诊断，App projector不得把`modelInvocationId` correlation带入Client边界。
- `AcceptedPresentationEnvelope` 是唯一进入消息 projector 的接收边界：每个 envelope 固定 Session、connection
  generation、durability，以及由事件 coverage scope 要求的 Run/Task/Turn identity 与 ephemeral stream tuple；model/tool/subagent/interaction 事件必须绑定 Turn，Task/Turn/Run terminal 的 envelope identity 必须与事件字段精确相等；Subagent step/review/phase 和审批 owner
  均使用稳定 child/tool identity，不能由展示层按工具名或到达顺序补全。
- `tool.review` 保留主工具的确切 toolId／reviewId、封闭审查状态与有界原因，来自真实 auto_review 请求／完成事件；不携带 reviewer model、权限材料或原始 result。`approval.granted` 可携带明确 approve_once／same_command，旧事实缺省时不猜授权范围。它们只表达展示事实，不提供新的授权路径。
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

计划审核可携带封闭的 `review { text, truncated }` 展示投影：正文最多 65,536 个 UTF-16 单位，截断显式可见；旧历史可缺省。该字段由 App 从计划正文和步骤脱敏生成，参与稳定交互身份比对，不携带 Artifact 路径或 Store handle。

Session projection 可携带已持久化的 `workspaceDigest`，供桌面目录与当前信任身份分组核对；摘要不赋予授权，不需要暴露 workspace 路径。

同一 Session revision 的投影允许更新 model 元数据，以及已接受 Run 的排队到运行、活动到终态或缺省 Task 关联补齐；Host 与 Client 共用[投影补齐判定](src/projection-enrichment.ts)。这些更新不产生新消息版本；初始／当前 Turn、Run revision、已有 Task、interaction identity 及其他稳定 Session 字段必须保持一致。终态只在允许的 cleanup 更新中补齐 outcome，不能借元数据更新回退或替换运行身份。该纯规则不读取或写入 Store，也不增加协议字段。

`create_session.model` 与 `start_turn.model` 是可选的无凭据 Session route。前者把准备态选择绑定到新 Session，后者只更新该 Session 的下一次 Run；缺省时恢复已持久化 route，再回退到 Workspace 默认配置。Provider 凭据和 endpoint 始终由 Service composition 解析，不能进入命令。

成功文件操作的 `tool.file_changed` 可携带有界 `path` 展示字段。客户端按 toolId 关联既有终态输出，路径不是任意文件读取或打开授权；本机宿主执行外部跳转前必须重新核实其工作区边界。

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
- `subagent.started.parentToolCallId`与child tool lifecycle的`presentationOwner`只提供Presentation ownership，
  `subagent.started.concurrencyGroupId`只提供Presentation grouping，均不授予调度或授权能力；Contract validator
  对其执行closed identity校验，缺少这些字段的旧History事件保持合法。
- Contract 不泄漏具体执行、存储或展示 authority。

## 测试

`bun test packages/runtime-contract/test`

## 文档影响

模块局部变化更新本 README；跨包 Session 或客户端语义同时更新 [Runtime 架构](../../docs/active/six-concept-runtime-architecture.md)。

## 产品与修改导航

[共享产品定义](../../docs/handbook/README.md) · [开发地图](../../docs/development/architecture.md)。本模块说明实现，不重新定义客户端操作。

- [src/index.ts](src/index.ts)
- [test](test)

## 深入机制

- [Runtime 访问对象与投影边界](docs/access-and-projections.md)

会话日志摘要可包含持久 Workspace membership（ID、digest、展示名），不包含 canonical path；目录分页按原 cursor 契约执行，membership 不是执行授权。

按需恢复与原命令回执查询见[访问与恢复说明](docs/access-and-projections.md)。
