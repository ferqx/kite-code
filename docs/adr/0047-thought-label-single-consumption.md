# ADR-0047：Thought 标签在阶段边界单次消费

状态：accepted
日期：2026-07-29
关联：ADR-0027、ADR-0030、`docs/active/thought-pre-consolidation.md`

## 背景

Runtime 会在一次模型响应中先排队多个工具，再顺序执行。一次 reasoning 后若工具序列为
`Bash → read/search`，Bash 作为独立工具关闭 Thought，随后探索聚合又依据 ADR-0027
继承相同的 `modelMs`。终端因此先显示 `Thought for 3s`，Bash 完成后再次显示
`Thought for 3s · read 1 file`。两个标签来自同一条 `model.responded`，会被用户理解为
模型进行了两次思考。

执行前沿隐藏只能阻止 queued 聚合在 Bash 运行期间提前出现，不能消除 Bash 完成后的
重复标签，因此需要修正 reducer 的归属模型。

## 决策

1. 一段 reasoning 的内容、时长和 `Thought for Xs` 标签只能由一个 Thought 块消费一次。
2. 非探索工具、人机等待或文本边界关闭 Thought 后，不记录或传播思考延续上下文。
3. 边界后的探索工具仍创建 `tool_summary` 并展示完整工具步骤，但初始
   `hasThought=false`，标题使用纯工具统计。
4. 只有后续真实 `reason` 事件才能把活动聚合切换为 Thought，并加入新的模型调用时长；
   若边界后的探索聚合仍活跃，reasoning 必须并入该块并将标题原位升级为
   `Thought for Xs · <工具统计>`，不得另建纯 Thought 块。
5. `model.requested` 仍不是活动探索阶段的关闭边界；本决策只约束已经被可见边界关闭的
   Thought，不改变 ADR-0030 的跨模型调用聚合。
6. 本决策覆盖 ADR-0027 的 carryover 字段与标签继承结论。
7. Runtime 同批排队时，审批目标之后、工具仍全部为 `queued` 的探索聚合属于未来阶段。
   `approval.requested` 不得提前关闭它；OutputArea 在审批期间隐藏该块，执行到达后它继续
   接收下一次真实 reasoning。

## 后果

- `Thought for Xs` 的出现次数与真实 reasoning 段一致。
- 独立工具后的 read/search 不丢失执行过程，但不会伪造第二次思考。
- `TuiState.thoughtCarryover` 被移除；历史事件日志无需迁移，回放采用新的展示语义。

## 备选方案

- 仅在 OutputArea 隐藏继承标签：拒绝。状态仍错误，回放、Static 冻结和其他渲染入口会不一致。
- 保留 `Thought` 但移除时长：拒绝。仍会被理解为新的思考，并引入额外标签形态。
- 把独立工具嵌入 Thought 树：拒绝。会损失工具卡的富渲染和审批交互。

## 回滚

恢复 `thoughtCarryover`，并按 ADR-0027 在跨边界探索聚合中继承
`hasThinking`、`hasThought` 与 `modelMs`。
