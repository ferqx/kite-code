# 文档体系

AI 请先读 [AGENTS.md](AGENTS.md) 获取简明工作流。本文件是 AI 与开发者共用的入口。

当前总体架构见 [Kite Code 六概念 Runtime 架构](active/six-concept-runtime-architecture.md)：它把物理上的 `protocol → core → app` 三层与 Core 内部的 Agent、Runtime Kernel、Capability、Policy、Execution、Verification 六概念统一起来。上下文缩减的当前实现边界见
[三级上下文缩减：渐进式实现与资格边界](active/three-tier-context-reduction.md)；该文档描述已通过
PSMC-03～06 Gate 的 Micro/Working Set/Summary、strict-v24 branch/continuation，以及仍保持暂停的 Session
Memory 和默认关闭的 rollout 边界。

## 权威顺序

1. 用户、system 与 developer 的直接指令。
2. 当前源码与测试。
3. 与改动范围匹配的 `active/` 记录。
4. `adr/` 中已接受的 ADR。
5. 计划、调研、完成记录与外部参考。
6. `design/` 和 `deprecated/` 永远不是当前实现依据。

代码与 active 记录冲突时，必须在同一改动中更新 active 记录，不得静默保留过期文档。

## 目录职责

- `active/` — 当前行为、不变量、边界和操作指引。
- `design/` — 未来 RFC 与提案；批准后必须先转入 `space/plans/` 才能实施。
- `adr/` — 已接受的架构决策；不改写历史，使用新 ADR 替代旧决定。
- `deprecated/` — 不得作为实现依据的历史材料。
- `space/plans/` — 具有明确验证条件的提案或进行中工作。
- `space/execution/completed/` — 已完成工作的验证证据。
- `space/understanding/`、`space/references/`、`space/backlog/` — 背景、调研与延期工作。

## 文档生命周期

```text
design/RFC → space/plan → 实施 + active/ + ADR（架构级变更）
                                  ↓
                      execution/completed 验证证据
                                  ↓
                         不再有效时迁入 deprecated/
```

每份新 `active/` 记录必须包含：

```markdown
状态：active
读取时机：何时必须阅读。
验证：对应测试或验证命令。
相关：关联 ADR、计划或代码入口（可选）。
```

新文档必须使用 `active/` 路径。
