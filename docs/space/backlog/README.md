# Backlog

`backlog/` 是已知问题与待实现功能的工作清单目录。

与 `understanding/` 的区别：
- `understanding/` — 记录设计理由、心智模型、背景解释（"为什么是这样"）
- `backlog/` — 记录已识别但尚未排期的问题和缺口（"还欠什么"）

与 `execution/active/` 的区别：
- `execution/active/` — 约束当前改动的强制性规则
- `backlog/` — 不约束当前改动，仅标记已知缺口

## 条目格式

每条一个文件，命名 `YYYY-MM-DD-<slug>.md`，包含：
- 问题描述 + 影响
- 相关文件/位置
- 建议方向（可选）

解决的问题应从 backlog 移除，转为 `execution/completed/` 中的完成记录。
