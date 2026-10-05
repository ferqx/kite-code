# Agent Note: 以原 Model ledger 发布 Context 压缩来源

Status: implemented

## Problem

压缩既改变下一次 Model 的所选输入，又涉及付费 Model、原始正文和取消/恢复边界。若压缩器直接调用 Provider、删除消息或单独维护循环，无法沿原 Execution/usage/权限/来源证明这次摘要，也可能把失败或取消的半份结果当有效上下文。

## Decision

可信单选 ContextCompressor 只给纯算法描述；手动/自动在原 defaultLoop/UnifiedExecution 内使用普通有来源的 Model。context_snapshot 保存有限 pending 描述、已发布原范围引用和 reset marker；没有新增基础表或第二 Loop。覆盖范围由原 selection 及序列上界确定，原 Model 请求/完整 Artifact/usage 保留。summary 以低信任 user 来源进入下一请求，不授 Tool 权限。压缩不增加 contextSelectionId。

仅真实 assistant 且其 source 指向压缩 Model Execution 时属于摘要 Model 历史，不能成为未提交的 selected 内容、Fork 配对或边界。普通 User 的 commandId/sourceId 即使与压缩 Model UUID 相同，也保真实 User 类型；不能只按字符串碰撞排除。手动发布和 Run completion/read-set 同事务；自动成功后原普通工作独立继续。已确认的 Provider/纯算法失败先核实际 Model identity/generation/终态，再保旧输入继续；SQL/不明/取消不这样降级。一个最后失败的完整输入 fingerprint 避免同一未变化上下文立即重试，不制造累计额度或冷却。focus/自定义说明没有算法硬裁剪。

窗口/有效缩减不能由 Core 字节常数伪造，可信 validateSummary/validateExpanded 分别核真实输出与reset展开输入。没有窗口预检不能强reset。Fork只复制SQL封存的原summary链接，body读取仍原Store/Session/Model/Artifact scope，不复制执行资格。新 selection 不暗继承旧点；Query/cold readonly 不发Provider。

## Alternatives considered

- 压缩扩展直接调用 Provider：丢失原 Execution、权限和usage链，未采用。
- 独立压缩 Loop/状态表：与同一Loop、原ledger和无第二引擎要求冲突，未采用。
- 删除历史/改写旧消息：破坏Rewind、Fork和原body来源，未采用。
- Core按字节或固定token认定缩减/窗口：不能证明真实模型能力，采用可信纯validator。

## Consequences

默认算法已由 Service 公开工厂装配，Core 27/381、默认本机 SDK 5/125 和开发 Native/TUI 窗口各有切片证据；这些测试不证明任意 Provider 窗口或真实摘要质量。原body异常、未知Part、权限/Store/owner不一致均不能靠摘要转换成执行资格。现有owner、测试和产品预期分别见 [压缩owner](../../../../packages/agent/src/storage/sqlite/context/compression.README.md)、[真实Core测试](../../../../packages/agent/test/isolated/context/compression.test.ts) 和 [模型与配置手册](../../../../docs/handbook/features/models-and-configuration.md)。


实际来源碰撞先以合法 User 重现旧错误，再核 selected context、完整 sealed Model input、真实 Provider request 和 Fork 内再次压缩；五文件31/429邻接含原≥17MiB恢复媒体。Run公开内部事实读取原SQL保存的不可变selection，不把普通Execution的nullable交付字段当原Model选择。默认Service的两个实际显式两层压缩/Files场景另通过三文件6/259，合法User与published summary ID/完整正文或生成指令同时碰撞仍保精确checkpoint trigger；摘要展开核原published记录、完整输出和原输入，仅排除Core最末真实生成指令，不凭prefix制造User来源。这些证据不外推自动压缩checkpoint或任意模型窗口。

## 既有决定的适用范围

本记录仅替代新统一 Agent 路径中的旧 State/effect/checkpoint 实现边界。旧正式入口尚未全部退役，因此不归档其记录。[manual/auto](../simplification/2026-07-23-context-compaction-manual-auto-only.md)中不以估算比例阻断会话、Provider 错误不推断 overflow 的理由继续适用；[单一叙述](../simplification/2026-07-23-context-compaction-single-narrative.md)的低信任摘要与准确候选预检理由保留；[原 checkpoint](../feature/2026-07-23-context-compaction-checkpoint.md)保留不可变历史、来源和 Tool 配对理由。新路径不恢复旧结构化 mandatory-fact schema、RuntimeState authority、累计冷却或 hard block。现行实现与待验证范围见 [Service owner](../../../../apps/service/README.md)和[实施证据](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。
