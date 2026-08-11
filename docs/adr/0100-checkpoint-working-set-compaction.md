# ADR-0100：三级压缩采用 Checkpoint 工作集，不以会话记忆为前置

状态：accepted
日期：2026-08-10
决策者：`github:@ferqx`
补充：ADR-0021、ADR-0022、ADR-0024、ADR-0090、ADR-0091、ADR-0095、ADR-0096
取代：ADR-0098 中“会话记忆是第二级且属于当前完整三级”的决定
关联：`docs/design/2026-08-10-progressive-context-compaction-rfc.md`、
`docs/space/plans/2026-08-10-progressive-context-compaction.md`
协议细化：ADR-0101（accepted）冻结 verified checkpoint、Working Set 区间、Summary→Primary 续跑和持久所有权，
并局部取代本文中“custom 可无条件直达摘要”“本地估算可返回容量错误”和通用 compact boundary
持久化表述。

## 决策

当前上下文压缩主链固定为三个成本和损失逐级增加的层级：

1. **MicroCompact**：确定性回收旧的、可重建的工具结果正文。它不调用模型，不删除 transcript，不改变工具
   terminal、receipt、结构化事实或当前 turn。
2. **Checkpoint Working Set**：复用已经激活并可验证的 checkpoint summary，拼接受保护的最近原文窗口和
   checkpoint 未覆盖的完整 tail。它不调用模型；没有可用 checkpoint 时返回 `unavailable`。
3. **SummaryCompact**：只有第二级不可用、工作集仍不可接纳，或用户携带自定义摘要指令时，才用一次无工具、
   零 SDK retry 的单叙事请求生成或更新 checkpoint，然后重新构造工作集。

全工具有限输出预算、verified terminal 和 immutable transcript 是三级的安全基础，不单独算作第四层。现有
确定性 context reclaim 可被改造为 MicroCompact，但在统一编排器接入和资格通过前仍只代表已实现基础，不能
直接宣称新三级可用。

## 单一编排入口

普通请求只允许一个 compaction orchestrator，固定按 `raw → MicroCompact → Working Set → SummaryCompact`
求值。每一步都必须从同一 immutable source 和 projection environment 构造新的候选，并对最终实际 Provider
payload 重新执行 resource 与 Provider data admission。通用 Provider HTTP 400/413 或错误文本不能推断 overflow，
也不能触发压缩或重试。

自动 SummaryCompact 只能由本地可证明的容量压力和显式启用策略触发；手动自定义 `/compact` 可以直接进入
第三级。摘要失败不得删除 transcript、伪造 boundary、重放已开始的 Provider attempt 或阻断仍可接纳的普通请求。

## Checkpoint 工作集

第二级的活动上下文由以下部分组成：

```text
system/runtime context
  + active checkpoint summary
  + protected recent original window
  + all uncovered tail
```

窗口和 tail 必须以完整 tool call/result block、完整流式 assistant message 和 settled turn 为原子边界。未覆盖
tail 必须全部保留；若它本身超过容量，第二级不可静默丢弃中间消息，只能进入第三级或返回明确容量错误。
checkpoint 无效、缺失或与 transcript coverage 不一致时，第二级返回 `unavailable`，不能猜测或修补正文。
recent window 可以有意覆盖 checkpoint 已总结范围中的最后若干原始 block；它排在 summary 之后，用重复少量近期
事实换取操作细节，不改变 checkpoint coverage。该窗口与 current turn、全部 uncovered tail 保持原文，不再应用
MicroCompact；较旧、未进入工作集的内容只由 summary 表达。

## 可选前缀来源

未来如需 Session Memory，只能通过窄接口作为第二级的可选前缀来源：

```typescript
interface CompactPrefixProvider {
  getVerifiedPrefix(input: CompactPrefixRequest):
    | ActiveCheckpointSummary
    | SessionMemory
    | 'unavailable';
}
```

本决定的首版只允许 `ActiveCheckpointSummary`。`SessionMemory` 不在当前计划内，不是自动压缩、恢复、资格或发布
前置；未来接入必须另立 accepted ADR 与实施计划，并保持低权限 assistant history、source coverage、final admission
和 fail-closed 规则。它不能成为 Plan、Verification、授权、Tool、Skill 或 Runtime 状态的新权威。

## 持久化与恢复

原始 transcript 始终是 source of truth。compact boundary 只保存类型、覆盖范围、保留窗口、token 计数和必要
稳定身份，不保存被回收正文。恢复从最后一个有效 checkpoint/boundary 和其后的原始消息重建；校验失败时回退
到更早有效 checkpoint 或 raw transcript。该降级只适用于 projection/boundary 不可用；Store checksum、event
ordering、tool pairing 或 transcript 本身损坏仍按 Runtime correctness failure 处理。rewind/fork 必须遵循目标
cut，Store exact CAS 与 generation fence 不变。

## 结果

该决定让第二级立即复用已有 checkpoint 能力，不再等待一套独立记忆生命周期；正常的重复压缩可零模型调用，
而第三级仍负责在信息过旧或 tail 过大时刷新摘要。代价是首次达到容量压力且没有 checkpoint 时仍需要一次摘要，
checkpoint 的长期保真也必须通过 recent window、增量 source 和 continuation evidence 约束。Session Memory 仍可未来
增强跨长会话保留率，但其失败不会拖累压缩主链。
