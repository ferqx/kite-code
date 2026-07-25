# ADR-0027: 思考延续跨过非探索工具边界（同批继承）

**Status**: accepted  
**Date**: 2026-07-25  
**Decision makers**: @chenchao  

## Context

真实会话（`tui-ms0ihe3d-0`）中，一次模型响应的工具为 `search_files → task（子代理）→ read_file×2`。按规则 3，`task` 作为非探索工具关闭了 Thought，后段 2 个 read 以**非思考**聚合渲染（`● read 2 files`）：

```
● Thought for 3s · searched 1 file pattern → [子代理块] → ● read 2 files
```

这 4 个工具是同一次模型调用的决策，思考链未被任何可见文本打断，后段工具却失去了思考归属。整批无法聚合为单个块——这是渲染模型的硬约束：非探索工具（子代理 / 写入卡片）需要独立富渲染块，Thought 聚合块是单棵连续的树，不能跨过其他块（否则块序颠倒）。

ADR-0026 已确立文本边界不继承（文本是思路的显式分界）；但非探索工具边界不是模型的显式分界，前后工具同属一批决策。

## Decision

1. `closeCurrentThought` 增加关闭原因参数：`text`（可见文本）、`tool`（非探索工具）、`human_wait`（审批 / 提问 / 方案评审等待）、`boundary`（模型调用 / 重试 / 错误 / 取消 / 中断）。
2. `tool` / `human_wait` 关闭 `hasThinking` 的块时记录延续上下文 `thoughtCarryover`（含 `modelMs`）；同一响应批次内后续 `tool_call` 创建的探索聚合块继承 `hasThinking=true` / `hasThought=true` / `modelMs`。
3. 清除条件：`text` / `final` 事件（ADR-0026）、`model.requested`（无条件——新调用 = 新决策）、`model_retry` / `error` / 取消 / 中断（生命周期边界）、新的 `reason` 事件（新思考替代）。
4. 继承块的 `totalElapsedMs` 仍冻结于同一 `modelMs`——前后两块的时长是同一次模型调用时长，规则 22 语义保持为真，不引入新标签形态。
5. 块仍必须切分（物理约束不变），只延续标签归属：`● Thought for 3s · searched 1 file pattern` → [子代理块] → `● Thought for 3s · read 2 files`。

## Alternatives

- **整批聚合为单个块**：Thought 树需跨越子代理 / 写入卡片——顺序块渲染下不可行（块序颠倒）；把子代理降级为树中一行会失去富 UI。否决（硬约束）。
- **延续块带思考标记但不带时长**（`Thought · read 2 files`）：引入新标签形态；继承同一 `modelMs` 后规则 22 语义为真，无需新形态。否决。
- **维持现状（纯统计标签）**：同批决策的后段工具视觉上失去思考归属，与真实会话中观察到的"思考单元"不符（用户基于两次真实会话反馈提出）。否决。
- **文本边界也继承**：与 ADR-0026 冲突（文本是模型的显式旁白、思路分界，已接受）。不采纳。

## Consequences

- 数据模型：`TuiState` 新增可选字段 `thoughtCarryover: { modelMs?: number }`；`tool_summary` 结构不变（继承发生在建块时）。`cancelRunningBlocks` / `settleActiveThought` 在轮次边界清除延续。
- 行为变化（记录于 thought-pre-consolidation.md 规则 3/20/23）：纯统计标签收窄为"无 reasoning 的响应"专属；非文本边界后的聚合块带 Thought 标签。
- 与 ADR-0026 共同定义 Thought 边界完整规则：文本边界 → 并入题头、不继承；非文本边界 → 块切分、标签继承。
- 回放一致性：新旧日志经同一 reducer 回放；旧日志无 `modelMs` 时无延续上下文，行为与旧版一致。

## Rollback

移除关闭原因参数与 carryover 逻辑（`closeCurrentThought` 恢复单参，建块分支不读 `thoughtCarryover`），还原规则 3/20 措辞，行为回到纯统计标签。字段可选，旧数据兼容。
