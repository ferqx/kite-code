# ADR-0174：TUI 消息投影升级事件格式并使用单一 Timeline 权威

**Status**: accepted
**Date**: 2026-09-05
**Decision makers**: @chenchao
**Complements**: ADR-0114、ADR-0117、ADR-0143、ADR-0167、ADR-0168、ADR-0172、ADR-0173

## Context

ADR-0173 分离了 Server Run、Client command、Presentation 与 Render 生命周期，但当前 Subagent step 持久事实没有
稳定 step/tool-call identity，Runtime 到 Native TUI 的事件入口又可能丢失 generation、Run/Task/Turn 与 stream fencing。
TUI 因而只能按工具名或最后一个 pending step 猜测归属，并在 OutputBlock/renderer 中再次推导 terminal。乱序、重连、
审批续跑、auto-review、`/clear` 与 overlay remount 会暴露重复、错配或 sealed item 被晚到事件修改的问题。

仅在 TUI 内增加 heuristics 无法修复缺失的事实 identity。继续保留裸 event 和 block-specific terminal 判断还会形成第二
生命周期权威。

## Decision

1. 升级持久 State/Event format epoch。Subagent tool admission 分配稳定 `stepId`，并把相同 `stepId + toolCallId`
   写入 started/result/replay 事实；新 writer 不再产生缺失 identity 的事件。
2. 已支持的旧历史只在 migration reader 中按持久顺序生成 deterministic `legacy:<subagentId>:<ordinal>` identity。
   普通启动不回写数据库，也不双写新旧格式；旧 reader 不支持新格式。发布和回滚均切换完整 candidate。
3. Runtime projection/protocol 升级 exact version。Native TUI 接收 accepted presentation envelope，保留 session、
   connection generation、durability、revision、run/task/turn 与 ephemeral stream identity。
4. Approval queued/settled 使用同一 `interactionId + generation + InteractionOwner`。Subagent phase、step 与 review
   使用显式 client event；无法安全投影的事件转 typed unavailable，不由 projector 静默丢弃。
5. 每个 Kernel event 必须在穷尽 coverage 表中分类为 client visible、internal only、client unavailable 或由另一
   canonical event normalized。新增 event 未分类时编译或测试失败。
6. TUI Message Projector 是消息聚合及 `Live → Sealed` 的唯一业务权威。Timeline item 带 source identity、state、
   canonical visual digest 与 render model；OutputBlock 只作单向渲染适配，renderer/Ink 不再推导业务 terminal。
7. RenderEpoch 只管理物理 viewport 所有权。`/clear`、Session/presentation identity change 与 resize 不复用 ledger
   identity；overlay 不重挂载整个 App；主题/语言重绘 viewport 但不复制 native scrollback。
8. 活跃 Run 使用 admission 时冻结的 model config。运行中选择的新模型持久化为 desired config，只在下一次
   start-turn admission 解析并生效。

## Alternatives

- 按 toolName 或 pending 顺序继续匹配 Subagent result：拒绝；并发同名步骤无法可靠关联。
- 只升级 client DTO、不升级持久事实：拒绝；history/replay 仍无法产生稳定真实 identity。
- 双 writer、live 双协议或在线回写：拒绝；会制造双权威并扩大回滚风险。
- renderer 继续按 block kind 判断 terminal：拒绝；它与 projector 的 sealed 决策重复。
- 模型选择立即修改 active Run：拒绝；会让已 admission 的 Server execution 与 TUI header/provider request 分裂。

## Consequences

- State/Event、Contract、Protocol、Server、Client 与 TUI 必须作为 exact-version candidate 一起发布。
- 旧历史迁移可读但不冒充新 writer identity；不确定 projection 显式显示 unavailable。
- live、history 与 reconnect 对相同事实产生相同 Timeline identity/digest，late event 不能重开 terminal entity。
- 物理重绘与业务生命周期解耦；视觉偏好变化不重发 Server 事件或复制历史。

## Rollback

回滚只允许切换到能读取其自身 epoch 的完整旧 candidate。不得让旧进程读取新格式、不得在线降级数据库、不得启用
dual protocol/writer。候选切换前必须保留原 Store 并遵循现有 release rollback 边界。
