# Agent Note: 以原 Model ledger 发布 Context 压缩来源

Status: implemented

## Problem

压缩既改变下一次 Model 的所选输入，又涉及付费 Model、原始正文和取消/恢复边界。若压缩器直接调用 Provider、删除消息或单独维护循环，无法沿原 Execution/usage/权限/来源证明这次摘要，也可能把失败或取消的半份结果当有效上下文。

## Decision

2026-10-15：[持续执行决定](2026-10-15-long-running-agent-continuation.md)细化默认 Service 的自动触发、单任务内压缩与失败指纹生命周期：相同失败输入只让出一次普通决策边界，不能永久禁用。本文关于实际 Model ledger、不可变历史、低信任摘要、事务和未知发布的理由继续适用。

可信单选 ContextCompressor 只给纯算法描述；手动/自动在原 defaultLoop/UnifiedExecution 内使用普通有来源的 Model。context_snapshot 保存有限 pending 描述、已发布原范围引用和 reset marker；没有新增基础表或第二 Loop。覆盖范围由原 selection 及序列上界确定，原 Model 请求/完整 Artifact/usage 保留。summary 以低信任 user 来源进入下一请求，不授 Tool 权限。压缩不增加 contextSelectionId。

2026-10-23：只保摘要无法保证运行中已接收的引导仍对后续模型可见。本次参考 Codex 固定版本 [`a390571745da105cfdc85443dd1d38bf78e5ea6e` 的原输入保留](https://github.com/openai/codex/blob/a390571745da105cfdc85443dd1d38bf78e5ea6e/codex-rs/core/src/compact.rs)及[上下文与真实用户区分](https://github.com/openai/codex/blob/a390571745da105cfdc85443dd1d38bf78e5ea6e/codex-rs/core/src/context/contextual_user_message.rs)，在原 selected history 中保留真实用户输入，不另存一份指令记忆。Core 核原 Command／应用回执和 sealed Fork 链，只在实际 Model 投影保留原 Message 全文、附件和 sourceIds；Agent 邮件与工具正文不能凭 user role 获得资格。模型顺序明确为摘要、已覆盖原输入原序、未覆盖尾部；静态 contract 说明较新用户纠正优先于派生摘要，旧终态输入仍是历史。公开历史、HTTP 和 SQL 格式保持。

Codex 本地路径对保留内容另设 token 预算，超限可截断。Kite 沿现有完整正文及明确窗口失败合同，不照搬该静默裁剪策略；可信算法收到实际 `retainedMessages`，默认 Service 在自动触发和摘要后预检都计算保留成本，无继续空间时保原历史并明确失败。这一调整保留本记录关于 Model ledger、单 Loop、低信任摘要与发布事务的其余理由。

同日进一步核对 Codex 当前固定版本 [`d6817454d76885e9d0e118bbf82e507aed6f715a` 的 remote V2 保留规则](https://github.com/openai/codex/blob/d6817454d76885e9d0e118bbf82e507aed6f715a/codex-rs/core/src/compact_remote_v2.rs#L529-L577)：父到子任务与后续指示可以保留真实 AgentMessage 类型，子返回的进度和最终结果则不在原文集合中。保留任务要求与认定用户授权是两个问题。Kite 复用原 Command、父子／root、sender Tool、carrier Job 与封存配置输入证明，补保留初始委派、steer、followup 原文和 sourceIds；不把它们归成人类输入。坏 Agent 来源不能退成人类协议，旧取消／中断／失败任务继续保持历史语义。Core 与默认 Service 复用实际上下文组装边界，避免仅凭 Source ID 将合法历史从压缩请求中排除。公开历史与存储协议保持。

仅真实 assistant 且其 source 指向压缩 Model Execution 时属于摘要 Model 历史，不能成为未提交的 selected 内容、Fork 配对或边界。普通 User 的 commandId/sourceId 即使与压缩 Model UUID 相同，也保真实 User 类型；不能只按字符串碰撞排除。手动发布和 Run completion/read-set 同事务；自动成功后原普通工作独立继续。已确认的 Provider/纯算法失败先核实际 Model identity/generation/终态，再保旧输入继续。单独取消自动摘要 Execution 时，仅在原 Store/Session/Run/generation/compressionId、实际 cancelled 终态、持久取消时间和准确 execution_cancel_requested 结果码全部成立后，沿旧上下文继续；伪造相同 Provider 错误码不取得资格。手动压缩、SQL/不明、整个 Run 取消或子 Run 到期不这样降级。一个最后失败的完整输入 fingerprint 避免同一未变化上下文立即重试，不制造累计额度或冷却。focus/自定义说明没有算法硬裁剪。

窗口/有效缩减不能由 Core 字节常数伪造，可信 validateSummary/validateExpanded 分别核真实输出与reset展开输入。没有窗口预检不能强reset。Fork只复制SQL封存的原summary链接，body读取仍原Store/Session/Model/Artifact scope，不复制执行资格。新 selection 不暗继承旧点；Query/cold readonly 不发Provider。

同Session压缩卡的原输入快捷入口区分当前准入Store和原Model出处；显式恢复A→B不隐藏合法原调用，也不重标压缩／BodyRef。实际Native父回调仅选择准确ModelExecution，敏感确认后沿既有Main／Client／Core核当前B和原Execution／Run／Command／root-work主体血缘、完整EOF／bytes／SHA；关闭和切换释放所属读取。保originSession等于所选Session，跨Session封存压缩卡不扩大当前Inspector的scope。现行产品依据为[Native手册](../../../../docs/handbook/clients/desktop/README.md)，完整实现与真实A→B／两冷DOM及原窗口范围归[Native owner](../../../../apps/desktop/README.md)和[恢复整例](../../../../apps/desktop/test/isolated/native-restored-compression-input.test.tsx)；阅读不放宽原压缩／重置或旧工作执行门禁。

2026-10-23 真实模型样本 `a36f802d` 进一步证明，完整原文保留不能单独保证任务继续：摘要将内部维护请求误记为新业务目标，后继模型在原委派仍完整时继续作摘要。参考 Codex 固定版本的 [checkpoint 提示](https://github.com/openai/codex/blob/d6817454d76885e9d0e118bbf82e507aed6f715a/codex-rs/prompts/templates/compact/prompt.md)及[交接前缀](https://github.com/openai/codex/blob/d6817454d76885e9d0e118bbf82e507aed6f715a/codex-rs/prompts/templates/compact/summary_prefix.md)，默认算法明确本次是供后继模型继续原任务的内部 checkpoint，维护说明不成为新目标、取消或后续工具限制；静态 contract 同样说明压缩后按原授权继续。这里补解释范围，不替代原文保留，不按关键词改写摘要，也不增加权限。实际请求和维护消息生命周期由默认 Service 回归核验，真实语义行为由原窗口独立验收。

同日样本 `d72a391e` 的摘要已正确记住“只读一次已完成、尚待发送”，后继模型仍因当前窗口没有原 Tool 回执而自行重读。这与摘要不能独立证明当前外部状态并不矛盾：checkpoint 仍需承接带来源的过去步骤，缺少原始交换不等于动作未发生，更不授予重复执行资格。静态 contract 据此明确压缩只改变窗口、不重置历史，原次数限制保持；更强核验与原限制冲突时说明证据缺口，不能用重放消除未知。摘要仍不是新的执行回执、当前状态或权限证明，必要完成策略也不放宽。此样本另有材料两个编号用途未标明导致核验码选择偏移，测试材料补明确字段标签；原完整读取、独立任务码与单次读取断言保留，不能将该选择偏移误记为来源丢失。

## Alternatives considered

- 压缩扩展直接调用 Provider：丢失原 Execution、权限和usage链，未采用。
- 独立压缩 Loop/状态表：与同一Loop、原ledger和无第二引擎要求冲突，未采用。
- 删除历史/改写旧消息：破坏Rewind、Fork和原body来源，未采用。
- Core按字节或固定token认定缩减/窗口：不能证明真实模型能力，采用可信纯validator。
- 只加强摘要提示词或验证摘要包含某些关键词：无法保证原引导的完整语义，也无法证明最新纠正未被旧摘要覆盖；保留原来源输入，摘要继续承接事实。
- 只保最新一条引导、按正文解析“有效要求”或另建指令状态表：会丢掉独立旧约束，或增加新的语义分类与持久 authority；保留当前选中真实输入及原时间顺序，由正常模型理解后续纠正。
- 只保人类原文，或把父 Agent 任务改标成人类以取得保留：前者使子压缩继续依赖摘要记住任务，后者混淆授权来源；保留经过核验的下行任务，来源与权限仍独立。
- 根据任意自然语言引用固定全部文件／工具正文：需要新增依赖解析与永久保留语义，Codex 也未提供这种保证；摘要提示保留完成原任务必要的已读细节，原 Tool／Artifact 仍按现有读取协议保存，不新增依赖闭包。

## Consequences

默认算法已由 Service 公开工厂装配，Core 27/381、默认本机 SDK 5/125 和开发 Native/TUI 窗口各有切片证据；这些测试不证明任意 Provider 窗口或真实摘要质量。原body异常、未知Part、权限/Store/owner不一致均不能靠摘要转换成执行资格。现有owner、测试和产品预期分别见 [压缩owner](../../../../packages/agent/src/storage/sqlite/context/compression.README.md)、[真实Core测试](../../../../packages/agent/test/isolated/context/compression.test.ts) 和 [模型与配置手册](../../../../docs/handbook/features/models-and-configuration.md)。


实际来源碰撞先以合法 User 重现旧错误，再核 selected context、完整 sealed Model input、真实 Provider request 和 Fork 内再次压缩；五文件31/429邻接含原≥17MiB恢复媒体。Run公开内部事实读取原SQL保存的不可变selection，不把普通Execution的nullable交付字段当原Model选择。默认Service的两个实际显式两层压缩/Files场景另通过三文件6/259，合法User与published summary ID/完整正文或生成指令同时碰撞仍保精确checkpoint trigger；摘要展开核原published记录、完整输出和原输入，仅排除Core最末真实生成指令，不凭prefix制造User来源。这些证据不外推自动压缩checkpoint或任意模型窗口。

## 既有决定的适用范围

本记录仅替代新统一 Agent 路径中的旧 State/effect/checkpoint 实现边界。旧正式入口尚未全部退役，因此不归档其记录。[manual/auto](../simplification/2026-07-23-context-compaction-manual-auto-only.md)中不以估算比例阻断会话、Provider 错误不推断 overflow 的理由继续适用；[单一叙述](../simplification/2026-07-23-context-compaction-single-narrative.md)的低信任摘要与准确候选预检理由保留；[原 checkpoint](../feature/2026-07-23-context-compaction-checkpoint.md)保留不可变历史、来源和 Tool 配对理由。新路径不恢复旧结构化 mandatory-fact schema、RuntimeState authority、累计冷却或 hard block。现行实现与待验证范围见 [Service owner](../../../../apps/service/README.md)和[实施证据](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。
