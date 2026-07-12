# 文档指引

1. 先读 `docs/README.md`，再按任务的“读取时机”只读取匹配的 `docs/active/` 记录。
2. `docs/active/` 描述当前行为。它与代码冲突时，以代码为准，并在同一改动中更新 active 记录。
3. 不得直接依据 `docs/design/`、`docs/deprecated/` 或 `docs/space/execution/completed/` 实现功能。
4. 修改 core 前，检查是否需要计划、ADR、feature flag、golden/replay 测试或边界规则更新。
5. 新的当前行为文档必须放在 `docs/active/`，并包含 `状态：active`、`读取时机：`、`验证：`。
6. active 规则的规范路径是 `docs/active/`；不得使用已废弃的 `docs/space/execution/active/`。
