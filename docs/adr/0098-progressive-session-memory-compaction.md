# ADR-0098：渐进式会话记忆压缩取代高复杂度 L3 收敛路线

状态：superseded（由 ADR-0100 取代；旧路线清场决定仍作为历史依据保留）
日期：2026-08-10
决策者：`github:@ferqx`
补充：ADR-0021、ADR-0022、ADR-0024、ADR-0090、ADR-0091、ADR-0095、ADR-0096
取代：ADR-0097 中把 `cache_safe_fork:v1`、checkpoint v2 三段证明、真实 Provider cache receipt
资格和 durable refill guard 作为完整三级必要条件的决定
关联：`docs/design/2026-08-10-progressive-session-memory-compaction-rfc.md`、
`docs/space/plans/2026-08-10-progressive-session-memory-compaction.md`
后续：ADR-0100 将当前三级改为 MicroCompact、Checkpoint Working Set 与 SummaryCompact；Session Memory
降为不阻断当前压缩路线的可选增强。

## 决策

上下文压缩采用按成本与损失递增的三级路径：

1. **局部压缩**：只改变 Provider projection，按工具类型、年龄、大小和保留标记清理旧工具输出；原始
   transcript 不删除。图片、文档和其他大块内容使用各自的有限预算。
2. **会话记忆压缩**：复用已经持久化的会话记忆，并拼接一个满足最小 token、最少文本消息和最大 token
   上限的最近原文窗口；触发压缩时不调用摘要模型。
3. **模型摘要兜底**：只用于带自定义指令的手动压缩、会话记忆不可用或明确的紧急降级。它保持单次、
   无工具、零 SDK retry 的单叙事请求。

三层共享一个压缩入口和优先级链。普通自动压缩先尝试会话记忆压缩；失败或不适用时才进入模型摘要。
任何切分都必须以完整 tool call/result block 和完整流式 assistant message 为原子边界。

三级是最终能力模型，不是首个版本的原子发布要求。允许按以下顺序独立发布：先交付局部压缩与模型摘要
兜底，再以 shadow 方式建立会话记忆，最后在资格通过后启用会话记忆压缩。会话记忆不可用必须是普通的
`unavailable` 分支，不能阻断第一阶段或普通请求。

每次局部或全量压缩都写入显式 boundary。boundary 只保存压缩类型、源范围、保留范围、token 计数和必要的
稳定身份，不保存被清理正文，也不成为 Plan、Verification、授权或 Runtime 状态的新权威。恢复只从最后一个
有效全量 boundary、其记忆/摘要和 boundary 后原始消息重建活动模型上下文。

## 保留的现有基础

- 不可变 transcript 与 Provider projection 分离；
- 工具调用和工具结果的原子配对、verified terminal 与有限输出预算；
- pure prepare、最终实际 payload admission、effect lease、exact CAS 和 generation fence；
- 单叙事摘要、无工具执行、零自动 retry 与通用 Provider 400/413 不推断 overflow；
- 默认关闭的新路径、metadata-only observability 和正文隐私边界。

ADR-0096 的 L1 有限预算与统一 prepared/admission 继续有效。其确定性旧工具结果回收能力归入新的第一级
局部压缩，不再承担“完整三级中的独立语义层”含义。

## 停止继续扩展的路线

- 不再以 Provider prompt-cache 命中作为自动摘要的正确性前提；
- 不再要求 `cache_safe_fork:v1` 才能进入自动三级路径；
- 不再把 checkpoint v2 三段 digest/proof chain 作为会话恢复的主要模型；
- 不再为摘要维护独立的 30 warm/30 cold cache 资格注册表；
- 不再把 durable refill guard 作为完整三级交付的必要组成。

已经写入工作树的相关实现先冻结，不直接删除。新计划必须逐项判定为保留、改造或删除，并以旧功能默认
关闭、原有测试不回归、持久数据可恢复为删除前置条件。

## 结果

优势是自动压缩的常规路径不再依赖额外 Provider 调用，延迟、成本、失败面和持久化协议复杂度同时下降；
最近原文窗口保留操作细节，会话记忆保留长期目标和决定。代价是需要新增明确的会话记忆生命周期、记忆质量
验证、boundary 恢复和过期/冲突策略；这些由新 RFC 与计划闭合。
