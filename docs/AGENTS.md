# 文档指引

1. 先读 `docs/README.md`，再读改动所属 workspace README；只有跨包行为、安全、恢复、发布或运维任务才按“读取时机”读取匹配的 `docs/active/` 记录。
2. Workspace README/本地文档描述 owner-local 当前行为，`docs/active/` 描述跨包当前行为。它们与代码冲突时，以代码为准，并在同一改动中更新对应 current authority。
3. 不得直接依据 `docs/design/`、`docs/deprecated/` 或 `docs/space/execution/completed/` 实现功能。
4. 修改 core 前，检查是否需要计划、ADR、feature flag、golden/replay 测试或边界规则更新。
5. 新的模块局部当前文档放在 `<workspace>/docs/` 并由 README 索引；新的跨包当前文档放在 `docs/active/`，并包含 `状态：active`、`读取时机：`、`验证：`。
6. active 规则的规范路径是 `docs/active/`；不得使用已废弃的 `docs/space/execution/active/`。
7. 在 stage、commit、push 或创建 PR 前，必须读取 `.agents/skills/document-before-commit/SKILL.md`，显式执行项目 Skill `document-before-commit`，依据 `docs/documentation-map.json` V2 检查全部工作树影响，并通过 `bun run check:docs-impact`。
8. 功能实现、验证和相关当前文档未共同收敛时，不得宣称任务完成。行为无变化时不得制造无意义文档改动；应修正过宽映射或说明可验证的无影响边界。
9. 可写任务可直接使用只有本任务改动且只有一个 Git owner的当前工作树；存在无关 dirty 文件、并发写入、用户要求隔离或长期独立分支需求时，才创建独立 branch/worktree。协作 Agent 可以读取、测试或修改明确分配的互斥路径，但不得 stage 或提交。
10. 两个任务命中同一 workspace/current authority 时必须串行，不得通过共享 dirty工作树或临时兼容副本并发修改同一事实。
11. 临时worktree完成验证后默认合并回原分支并清理；需要独立PR、用户要求保留或不能安全fast-forward时，停止并请求方向。
