# Space 记录

`docs/space/` 是仓库本地的持久 agent 上下文记录系统。它让决策可发现，同时避免把 `AGENTS.md` 变成长篇手册。

使用方式：

1. 先读 `index.md`。
2. 只继续读取与当前任务范围匹配的记录。
3. 如果新增、移动、退役或实质修改记录，必须在同一改动中更新 `index.md`。

目录职责：

- `understanding/`：设计理由、心智模型和背景解释。
- `execution/active/`：会约束未来改动的当前有效规则。
- `execution/completed/`：已完成实现记录和验证说明。
- `references/`：影响本地决策的外部资料摘要。
- `generated/`：派生或临时材料，权威性较低。

权威顺序：

1. 用户、developer 和 system 的直接指令。
2. 仓库源码和测试。
3. `index.md` 中链接的 `execution/active/` 记录。
4. `understanding/` 和 `references/` 记录。
5. `generated/` 记录。

该目录的设计规则见 `understanding/space-system-design.md`。

边界：`docs/space/` 不是运行时计划存储。每次运行的 `graph.state.plan` 仍保存在 LangGraph checkpoint 状态中；space 记录只保存持久设计规则、实现历史和外部参考。
