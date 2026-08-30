# 仓库 Agent 规则

修改文档前，先阅读 `docs/AGENTS.md`。项目事实的权威顺序为：用户直接指令、源码与测试、对应 workspace README/本地文档、`docs/active/` 跨包当前规则、已接受的 ADR、其他历史或设计文档。

## 基本规则

1. `packages/agent-kernel/` 不得依赖其他 workspace、I/O runtime 或 TUI 展示类型。
2. 当前行为发生变化时，必须在同一改动中更新 owner workspace 文档；跨包行为、安全、恢复、发布或运维变化还必须更新相关 `docs/active/` 文档。
3. `docs/design/`、`docs/space/plans/`、`docs/space/execution/completed/` 和 `docs/deprecated/` 不是当前实现依据。
4. 架构决策需要新增 ADR，不得改写已接受 ADR 的历史结论。
5. 不得覆盖或清理与当前任务无关的用户改动。

## 并发开发规则

1. 每个可写任务使用独立 branch 和 Git worktree；主工作树只用于只读检查、集成与最终验证。
2. 一个 worktree 只有一个 Git owner。只有该任务的主 Agent 可以 stage、commit、push 或创建 Pull Request；协作者不得修改 staged 状态。
3. 同一 current authority 被两个任务同时影响时必须串行：先合并一个任务，另一个 rebase 后重新运行文档影响门禁。
4. 不得用 `git add -A` 吸收同一工作树中的无关改动。发现不属于当前任务的 dirty 文件时，保留原样并将可写任务迁入独立 worktree。

## 阶段完成前过度设计门禁

每个显式实施阶段或 Task tranche 在标记 `completed` 前，必须读取并显式执行项目 Skill
`.agents/skills/overengineering-check/SKILL.md`。检查该阶段新增的 process、持久状态、协议、恢复路径、兼容层、抽象、配置和测试矩阵是否有
当前需求与生产消费者；仅由自身测试/文档支撑、为未发布格式保留或被带入普通启动路径的一次性机制必须删除或延期，阶段保持
`in_progress`。最终交付前还必须对完整 diff 再执行一次。该 Skill 不替代 correctness、安全、文档影响或提交门禁，也不授权扩大用户范围。

## 提交前文档门禁

在暂存已完成的功能实现、创建提交、推送代码或创建 Pull Request 前，必须读取 `.agents/skills/document-before-commit/SKILL.md`，显式激活项目 Skill `document-before-commit`，并完整执行该 Skill。

Skill 必须：

1. 检查已暂存、未暂存和未跟踪的实现及文档变更；
2. 根据 `docs/documentation-map.json` 判断文档影响；
3. 更新相关 `docs/active/`、根文档、`docs/book/`、ADR 或计划状态；
4. 运行 `bun run check:docs-impact`、`bun run check:docs` 和相关验证；
5. 在文档与实现未共同收敛时返回 blocked，并停止提交。

`action=stage` 使用默认 `all` 作用域验证任务 worktree 的完整改动；完成显式 staging 后，`action=commit`、`push` 或 `pull_request` 还必须使用 `--scope=staged` 验证实际提交边界。CI 继续使用 `range`。

行为无变化的内部重构不要求制造无意义的文档修改。但仍必须完成文档影响判断；如果映射范围不准确，应在同一改动中修正 `docs/documentation-map.json`，不得绕过检查。

在 `bun run check:docs-impact` 失败时，不得宣称任务完成、创建提交、推送或创建 Pull Request。禁止使用 `--no-verify` 绕过仓库的文档与验证钩子。
