# 仓库 Agent 规则

修改文档前，先阅读 `docs/AGENTS.md`。项目事实的权威顺序为：用户直接指令、源码与测试、`docs/active/` 当前规则、已接受的 ADR、其他历史或设计文档。

## 基本规则

1. `src/core/` 不得依赖 `src/app/` 或 TUI 展示类型。
2. 当前行为发生变化时，必须在同一改动中更新相关 `docs/active/` 文档。
3. `docs/design/`、`docs/space/plans/`、`docs/space/execution/completed/` 和 `docs/deprecated/` 不是当前实现依据。
4. 架构决策需要新增 ADR，不得改写已接受 ADR 的历史结论。
5. 不得覆盖或清理与当前任务无关的用户改动。

## 提交前文档门禁

在暂存已完成的功能实现、创建提交、推送代码或创建 Pull Request 前，必须读取 `.agents/skills/document-before-commit/SKILL.md`，显式激活项目 Skill `document-before-commit`，并完整执行该 Skill。

Skill 必须：

1. 检查已暂存、未暂存和未跟踪的实现及文档变更；
2. 根据 `docs/documentation-map.json` 判断文档影响；
3. 更新相关 `docs/active/`、根文档、`docs/book/`、ADR 或计划状态；
4. 运行 `bun run check:docs-impact`、`bun run check:docs` 和相关验证；
5. 在文档与实现未共同收敛时返回 blocked，并停止提交。

行为无变化的内部重构不要求制造无意义的文档修改。但仍必须完成文档影响判断；如果映射范围不准确，应在同一改动中修正 `docs/documentation-map.json`，不得绕过检查。

在 `bun run check:docs-impact` 失败时，不得宣称任务完成、创建提交、推送或创建 Pull Request。禁止使用 `--no-verify` 绕过仓库的文档与验证钩子。
