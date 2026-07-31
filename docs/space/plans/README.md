# Plans

`plans/` 保存实施计划文档 — 事前规划"怎么做"的方案。

> **入口**：所有计划的首个入口是 [`index.md`](index.md) — 全局注册表，记录每个计划的状态、依赖和分叉关系。

## 与其他类别的区别

| 类别 | 时态 | 用途 |
|------|------|------|
| `backlog/` | 将来 | 已知问题列表，轻量标记，不含实施方案 |
| **`plans/`** | **将来** | **详细实施方案：步骤、涉及文件、依赖顺序、验证方法** |
| `../active/` | 现在 | 约束当前行为的强制性规则 |
| `execution/completed/` | 过去 | 已完成实现记录和验证证据 |
| `understanding/` | 过去 | 设计理由、心智模型、背景解释 |

关键区分：
- `backlog/tui-issues.md` 说"这个问题存在，影响是什么，大概方向是什么" — 一个 item 一行
- `plans/xxx-roadmap.md` 说"分四步解决，每一步涉及哪些文件，怎么验证" — 可执行的工程计划

## 计划文档格式

每条一个文件，命名 `YYYY-MM-DD-<slug>.md`。内容应包含：

- **目标** — 要解决什么问题
- **范围** — 涉及的文件或子系统
- **步骤** — 有序的实施步骤，每步包含：
  - 具体改动描述
  - 涉及文件
  - 依赖项（前置步骤）
  - 验证方法（测试命令、检查点）
  - feature flag/迁移策略；不适用时显式写明原因
  - rollback/失败时的安全状态
- **风险** — 已知难点或依赖

多步骤计划应在步骤正文前提供任务执行矩阵，最少包含：

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| `<稳定 ID>` | `<前置 Task/Gate>` | `<代码、测试、文档>` | `<可执行命令/检查点>` | `<flag、兼容、rollback>` |

矩阵的一行必须唯一对应一个正文 Task。计划级“主要改动范围”或最终验收清单不能代替逐 Task
文件、依赖和验证。尚未确定执行人、branch 或 baseline commit 时，计划必须保持 `draft`；
激活 Task 前再写入可审计 execution binding，不得用虚构人员或占位 identity 越过门禁。

每个 Task 的完成记录可汇总到同一 Phase 文件，但计划必须写出具体
`docs/space/execution/completed/YYYY-MM-DD-*.md` 目标路径，完成记录内按 Task ID 分节，并逐项
记录实现/测试/文档影响、实际 commit/artifact、运行命令与结果、未运行项、风险、Gate、偏差和
rollback。`N/A` 必须在同一字段内用括号说明原因。

2026-07-29 Agent 生产就绪计划组额外运行：

```bash
bun run scripts/check-plan-execution-matrix.ts
```

该门禁检查矩阵与正文 Task 一一对应、`dependsOn` 稳定语法、跨计划引用、依赖环、milestone
唯一 producer、完成记录目标以及 D-01–D-14 的必填字段。当前 1B.1/1B.4 completion ratchet 与
1A.6 activation ratchet 还会在 Pull Request quality job 中使用完整 Git 历史，验证 evidence commit
存在并可从 PR merge
`HEAD` 到达；squash/rebase 合入后的 push 仍校验记录字段，但不把被历史重写替换的原 SHA 强制
当作新主干祖先。`bun run check:docs` 已包含该门禁。

## 生命周期

1. 创建：识别到需要多步骤实施的任务时，从 backlog 或审查中提取
2. 执行中：随着进展更新各步骤状态
3. 完成后：
   - 将计划状态改为 `completed`，完成记录确认后再改为 `archived`
   - 保留 `plans/` 中的文件作为历史设计参考，不删除、不再作为当前实现依据
   - 在 `execution/completed/` 中创建完成记录
   - 如有新的约束规则，在 `../active/` 中创建
   - 如有未完成项，更新 `backlog/`
