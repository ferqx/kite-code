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
- 固定 command identity、expected revision、幂等回放与冲突语义。
- 定义private、closed的Run projection、`get_run`/bounded `list_runs` query，以及applied/replayed command receipt上的original
  Run resource；这些DTO不代表Public Agent API route已开放。
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
- Run query只接受Session-scoped opaque identity和最多200项的ASC keyset cursor；Run resource只出现在创建它的original/replayed
  applied receipt，不允许Client以当前query结果伪造原始command response。
- `delete_session` 是 Host-owned mutation：按 scoped command identity 删除 Session durable facts并保留
  receipt；Client/TUI 不能直接调用 Store delete。重放同一 digest 返回原 receipt，不同 digest fail closed。
- `respond_interaction` 必须携带匹配的 client-safe interaction identity：Session revision，及按 kind
  所需的 approval generation/grants、Plan identity、provider directory revision 或 verification revision。Approval
  interaction可选携带有界原始command供用户作知情决定；它不携带cwd、grant subject或binding digest。
- `RuntimeSubscriptionSpec` 是唯一可序列化 selector；`AbortSignal` 只属于 local
  `RuntimeSubscription`，不得进入 wire。
- `RuntimeCommandContext` 必须在 admission 后 strict validate/freeze；`bindingReference` 只能由 App-owned admission
  提供，Contract package 不解释其内容、不持有 credential，也不按 Session 反查 authority。
- `plan.approved` 是审核 settlement 的封闭 client event，携带 interaction identity、Session revision 与
  execution mode；Client 不从 raw Plan/Kernel event 推断审核已完成。
- `RuntimeHistorySessionTranscript` 只含同一 `RuntimeClientEvent` union；它是 display/recovery evidence，
  不携带 callback、Store handle 或历史 interaction settlement authority。
- `ListRuntimeLogEventsRequest`允许同时携带exclusive `afterSequence < beforeSequence`，形成有界sequence window；
  单侧cursor仍保持原语义，等于或反向window fail closed。该窗口只约束只读History，不产生snapshot/receipt或Store authority。
- `RuntimeSessionProjection.interactionQueue` 是同 revision 的完整、有序替换集；`activeInteractionId` 必须属于该集，
  每个interaction的`sessionRevision`是当前 settlement CAS，必须等于queue/session revision；稳定交互身份由
  `interactionId`与kind-specific generation/plan/provider/verification/input/command字段共同组成。Session revision
  前进时Service以相同稳定身份重新投影当前CAS，identity重复、缺失、内容漂移或activeWork/queue完整身份不一致全部
  fail closed；同ID/revision但command、grants或其他kind-specific字段不同同样非法。
- Live notification 与 History transcript 必须通过同一个 exact `RuntimeClientEvent` validator；closed DTO
  新增可选字段时，类型、validator 与 wire codec 必须同步，不能让实时订阅可见而恢复/回放拒绝同一事件。
- 模型展示事件的 `requestId` 是 exact closed DTO 的必填字段；缺字段或额外字段均不进入 client boundary。
- 新写入的tool queue projection用`presentationGroupId`与`model.responded.messageId`精确配对；该字段只参与
  Presentation grouping，不是execution、authorization或settlement identity。旧History没有该可选字段时仍可回放。
- Contract 不泄漏具体执行、存储或展示 authority。

## 测试

`bun test packages/runtime-contract/test`

## 文档影响

模块局部变化更新本 README；跨包 Session 或客户端语义同时更新 [Runtime 架构](../../docs/active/six-concept-runtime-architecture.md)。
