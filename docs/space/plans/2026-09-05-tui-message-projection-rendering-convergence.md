# TUI Message Projection & Rendering Convergence

状态：completed（2026-09-05；TMR-00～TMR-08全部完成，全词汇投影、复杂交互PTY与交付门禁均已收口）

优先级：P0

依赖：当前 Runtime Kernel、Runtime Server/Client exact protocol、Store 8、ADR-0173

关联：[ADR-0174](../../adr/0174-tui-message-projection-event-format-epoch.md)、
[Server/TUI lifecycle convergence](2026-09-04-server-tui-lifecycle-convergence.md)、
[TMR-00 frozen baseline](../understanding/2026-09-05-tui-message-projection-baseline.md)

## 1. 目标

把 TUI 消息路径收敛为一条可验证的单向投影：

```text
Agent Run Server committed facts
  → Runtime Client safety projection
  → Accepted Presentation Envelope
  → TUI Message Projector
  → Live/Sealed Timeline
  → OutputBlock render adapter
  → Ink Static/Dynamic physical owner
```

Server 拥有 Task、Turn、Run、Tool、Subagent 与 Interaction 事实；Runtime Client 拥有连接 generation、
revision、执行 identity 与 stream fencing；TUI projector 拥有消息归属、聚合和单调 `Live → Sealed`；renderer
只消费 Timeline state、visual digest 与 RenderEpoch。slash command、乐观 prompt 和本地诊断保留为明确的
presentation-only action，不得反向修改 Server lifecycle。

本计划是 LFC-08 的前置依赖。TMR-08 未完成前，LFC-08 必须保持 `in_progress`。

## 2. 已锁定决策

- 升级持久 State/Event format epoch，为 Subagent step 写入稳定且必填的 `stepId + toolCallId`。
- 旧历史只由 migration reader 按事件顺序合成 deterministic legacy identity；新 writer 不双写，普通启动不在线回写。
- Runtime projection/protocol 使用 exact version；同一连接只传一种版本，回滚切换完整 candidate。
- Native TUI 只接收带 Session、connection generation、durability、revision、Run/Task/Turn 与 stream identity 的
  accepted envelope，不接收裸 Server lifecycle event。
- 当前 Run 固定 admission 时的模型快照；运行中选择模型只影响下一 Run。
- 主题和语言立即在新的 visual RenderEpoch 重绘当前 viewport，不重启 Run、不改 Timeline identity，也不重复追加
  native scrollback。
- renderer、Ink flush、promise completion 与 Footer 均不能替代 Server Run terminal。

## 3. 阶段与门禁

### TMR-00：基线与反例

状态：completed（2026-09-05）

冻结 reasoning/content 顺序、工具、Subagent/审批、queued successor、terminal-before-receipt、配置/overlay/
Session/resize、`/clear`、late event/reconnect/history replay 的 Server event、accepted envelope、Timeline、
OutputBlock 与 PTY frame trace。每个已知缺陷必须有稳定 reproduction。

门禁：baseline/golden 可重复；执行本阶段 `overengineering-check`。

### TMR-01：Server 与 Client identity

状态：completed（2026-09-05；receipt-time generation、event identity scope与live/history envelope fencing完成）

- 新格式写入并校验 Subagent `stepId/toolCallId`，migration reader 只处理已支持旧格式。
- 投影 Subagent suspended/deferred/auto-review phase 与 review；Approval 携带一致的 interaction generation 和 owner。
- accepted envelope 不丢 Session/Run/Task/Turn/stream identity；Run terminal 后关闭其 ephemeral stream。
- terminal-before-receipt 在 receipt join 后重新派发权威 projection；restart hydration 保留最近 settled currentRun。
- 为 Kernel event 建立穷尽 coverage 分类：`client_visible | internal_only | client_unavailable | normalized_by`。

门禁：Kernel、Contract、Protocol、Host、Client、Store、history/reconnect/out-of-order tests。

### TMR-02：Message Projector 单调状态机

状态：completed（2026-09-05；已随identity/Timeline最终实现复验）

每个 Session 分别维护 authority、prompts、requests、tools、subagents、interactions 与 Timeline。所有 envelope
先过 identity fence；Task/Turn/Run terminal 只结算精确匹配实体。Request overflow 只污染所属 request；
`model.responded` 显式发布 model-terminal sealed answer；input settlement seal interaction；terminal entity 不接受
late update。terminal-before-started Subagent 使用有界 pending join，过期投影 unavailable。Approval settlement 必须
精确匹配 interactionId、generation 与 owner。

门禁：reducer 反例与 property-style 乱序测试。

### TMR-03：Tool 与 Subagent 聚合

状态：completed（2026-09-05；canonical presentation/displayLabel与Subagent/Approval聚合完成）

工具聚合只使用 Server `presentation/presentationGroupId/toolCallId`；started 才可见，terminal 后不可变。
Subagent card 使用 `subagentId`，聚合使用 `concurrencyGroupId`，step 只按 `stepId/toolCallId` 更新；审批 owner
精确更新 child/step。人工审批聚焦隐藏 Run 状态行，auto-review 不生成 Footer 人工审批；group 只在所有 child
terminal 后 seal。

门禁：人工审批、auto-review、同名并发、interleaved sibling、cancel/recovery component 与 PTY；
`Sub-agent Automatic Review` 稳定通过。

### TMR-04：Timeline 唯一 sealed 权威

状态：completed（2026-09-05；Timeline由组合reducer持有，生产renderer只消费Timeline render model）

`LiveTimelineItem | SealedTimelineItem` 是唯一完成权威；`Live → Sealed` 只由 projector 执行一次。
OutputBlock 仅作单向 render adapter；renderer 与 Static owner 不再读取各 block 子字段推断 terminal。

门禁：同一 envelope 输入的 live/history/replay Timeline identity、state 与 digest 一致。

### TMR-05：Static、digest 与 RenderEpoch

状态：completed（2026-09-05；已随reducer-owned Timeline最终实现复验）

visual digest 使用覆盖全部 renderer-visible 字段的 canonical serialization。Static ledger 只提交 sealed digest，
committed item 永不变化。`/clear` 推进独立 RenderEpoch 且逻辑 ID 不复用；render 阶段无 stdout 副作用；overlay
只挂载自身子树。Session、明确 visual presentation change 与双向 resize reflow 使用同步 commit，且不重复 scrollback。

门禁：每个 Static item 恰好一次、无 committed mutation、终态后零空闲 stdout。

### TMR-06：模型、主题与语言

状态：completed（2026-09-05；已随renderer最终实现复验）

模型 selector 等待异步保存；失败保持旧 desired model，成功只更新下一 Run 配置。Bridge 每次 start-turn admission
解析最新配置并冻结执行快照；当前 Run 的展示和 provider request 不变。主题/语言成功后开启 visual RenderEpoch，
一次同步重绘当前 viewport；失败只输出本地诊断。

门禁：active streaming 切换模型/主题/语言不丢 token、不重复正文、不重启请求，下一 Run 的真实 provider request
与展示一致。

### TMR-07：完整验证矩阵

状态：completed（2026-09-05；63类client-visible事件闭环、Timeline convergence与46文件串行PTY通过）

完成 event→envelope→Timeline 全词汇、terminal/late-event、approval owner/generation、Subagent identity/order、
request overflow、input settlement、digest sensitivity、clear epoch 单元/属性测试；完成 aggregation、overlay、selector、
reflow 组件测试；完成计划列明的 14 类真实 PTY journey。共享全局 fixture 只能由仓库串行 runner 调度，不能交给
单个并行 `bun test` invocation。

门禁：targeted、workspace、release foundation、fault qualification 与完整串行 TUI PTY 全部通过。

### TMR-08：兼容层退休与交付

状态：completed（2026-09-05；兼容层清理、current docs、overengineering与全部交付门禁通过）

删除裸 `RUNTIME_EVENT` lifecycle path、Runtime final projection 中的旧 event action、OutputBlock per-kind terminal
推导、旧 fingerprint、unused running/shadow state/write-only ledger。更新所有 owner README、active rules、ADR、系统
测试文档与 LFC-08 dependency。每一 tranche 及最终 diff 执行 `overengineering-check`；提交前执行
`document-before-commit` 与完整 docs/type/runtime/CLI/service/release/qualification/PTY gates。

## 4. 完成标准

- 每个 Kernel event 都有显式 coverage 决策；用户可见 event 都有闭合安全投影。
- TUI lifecycle 输入具备完整 Session/Run/Turn 与连接 identity。
- 消息实体只有 `Live → Sealed`，terminal 后 late event 不可修改或重开。
- Tool、Subagent group/step、Interaction/Approval 有稳定 identity，manual/auto-review 更新真实 child。
- renderer 不推导业务 terminal，visual digest 覆盖全部可见字段。
- `/clear`、overlay、模型、主题、语言、Session 与 resize 不重复、不丢失、不发生 ledger collision。
- 新模型只用于下一 Run，provider request、Server projection 与 TUI 展示一致。
- `Sub-agent Automatic Review`、完整 PTY、release、qualification 与 docs gates 稳定通过。
- TMR-08 完成后才允许关闭本计划并重新评估 LFC-08。

## 5. 完成证据

- `bun run typecheck`：16 workspace通过。
- `bun run test`：完整默认矩阵通过；真实进程身份相关daemon用例在沙箱外执行。
- `bun run test:tui:system`：仓库串行runner的46个PTY场景文件全部通过；沙箱内无法读取进程身份的显式daemon文件
  以相同代码在本机进程权限下单独复跑2/2通过。矩阵包括Sub-agent Automatic Review、root/child approval
  approve/reject/Esc/Ctrl+C、terminal-before-receipt、terminal后late event、active-stream模型/主题/语言、同名Subagent
  step交错、`/clear`、双向resize、reconnect/replay、Session与Static/scrollback ownership。
- `bun run format:check`、`bun run check:docs-impact`、`bun run check:docs`、
  `bun run check:pre-release-architecture`、`bun run release:gate:foundation`、`bun run test:runtime:fault`全部通过。
- 63个`client_visible` Kernel event均通过event→projector→Client validator→Accepted envelope闭环；live/history/direct
  replay的Timeline identity、state、digest与RenderModel逐项一致。
- 最终`overengineering-check`结论为pass：稳定identity、exact protocol、accepted envelope、Timeline/RenderEpoch与
  `restart_required`只读降级均有生产消费者和回归测试；无效的强制recovery、connection tracking与retry scaffolding已删除，
  未保留dual writer/protocol、第二lifecycle authority或只写ledger；同时删除无生产消费者的`subscribeAccepted()`、
  `execute()`迁移别名、Timeline旧alias、`rendererVisibleBlock`导出与`isBlockSettledInRun`包装。
