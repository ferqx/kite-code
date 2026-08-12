# ADR-0102：超大 Working Set 工具结果的投影卸载

状态：accepted
日期：2026-08-11
决策者：`github:@ferqx`
补充：ADR-0100、ADR-0101

## 背景

Verified Checkpoint Working Set 保留完整的 recent overlap `W`。当 `W` 中的不可分工具块超过固定容量时，
当前实现只能以 `recent_window_exceeds_capacity` 回退 raw；它安全但会使长会话无法获得 L3 缩减。

## 决策

新增默认关闭的 `oversizedBlockOffloadV1`。在启用且 `toolResultBudgetV2` 已启用时，Working Set 可在**仅 W**
内把一个完整、已结算、可稳定重读的只读工具块投影为确定性 tool-result stub。它只允许 `read_file`、
`search_content`、`search_files`，且块中的所有调用都必须：成功、`read_only`、有 `budget_v2` receipt、raw/projected
digest 和稳定 locator，并且调用工具仍在当前 Provider tool set 中。多调用块要么所有 result 同时替换，要么完全保留。

stub 固定记录版本、确定性引用、工具名、原内容 token/byte 计数、内容 digest，以及
`repeat_tool_call_with_original_arguments` 提示；assistant tool-call、参数、顺序和 tool-result pairing 保持原样。
模型可以重新执行已存在的只读工具取得当前内容；本 ADR 不新增读取历史 transcript 的模型工具。

原始 transcript、canonical block、V3 source range digest、checkpoint coverage 和 Micro reclaim commit 永不改变。
卸载仅影响一次 ephemeral Provider projection；`T=[c,n)`、当前/active turn、用户和普通 assistant 文本、runtime、
失败/副作用/legacy/MCP/Shell 工具块、interaction/verification barrier 一律不允许卸载。无法产生完整安全替身时维持
既有 no-dispatch/raw fallback。

effective=true 的策略进入 projection environment digest，因此启用会使旧 prepared artifact/route proof 失效；关闭时保留
pre-L2.5 digest 形状与 Provider payload 字节。该功能先作为本地 shadow/live qualification 的默认关闭能力；
不是 default-on、无限会话或跨 Provider 质量承诺。

## 后果

- 已覆盖历史中的大只读读取结果可释放 W 容量，而不截断或篡改 durable history。
- 模型若需要细节，会以原参数重做只读读取；目标资源在之后可能已变化，因此 stub 提供 digest，而不是声称重读就是
  历史原文。
- 首期不解决超大用户文本、普通 assistant 文本、未覆盖 tail 或 effectful 工具；它们继续 fail-closed。
- 未来的 `rehydrate_context_block` 必须另行 ADR：它需要 transcript authority、thread/generation/ref 绑定、range/bytes/
  call-count 限制、Provider data admission，以及 fork/rewind/reset 失效规则。

## 替代方案

- 直接扩大 Working Set：不可预测地占用主上下文，不能控制长会话成本。
- 截断或拆分原子工具块：破坏 tool pairing 与可重放语义。
- 把旧原文写入摘要：会使摘要成本/幻觉面扩大，也不能按需恢复精确正文。

## 回滚

关闭 `oversizedBlockOffloadV1` 即恢复原有 Working Set 选择与 raw fallback；没有 durable state、事件或 transcript
迁移需要回滚。
