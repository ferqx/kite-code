# Plans 注册表

最后更新：2026-05-26

所有实施计划的统一入口。每个计划文件有独立状态，本注册表提供全局视图和分叉关系。

## 状态说明

| 状态 | 含义 |
|------|------|
| `draft` | 方案初稿，待确认后方可执行 |
| `active` | 执行中 |
| `blocked` | 被依赖项阻塞 |
| `superseded` | 被另一个方案替代（记录替代关系） |
| `completed` | 已完成，应移至 `execution/completed/` |

## 当前计划

| 计划 | 状态 | 优先级 | 依赖 | 替代/分叉 | 阶段产出 |
|------|------|--------|------|-----------|----------|
| [`2026-05-20-tui-production-roadmap.md`](2026-05-20-tui-production-roadmap.md) | completed | P0 | — | — | Step2 感知闭环：流式指示器 + Plan 连线 + Phase 确认<br>Step3 防御纵深：Error Boundary + Checkpoint 关闭 + Temp 清理<br>Step4 功能补齐：手动 Compaction |<!-- replaced by 2026-05-22-production-gaps-closure.md for remaining gaps -->|
| [`2026-05-22-production-gaps-closure.md`](2026-05-22-production-gaps-closure.md) | completed | P0 | — | 替代 2026-05-20 路线图中未完成项 | Phase1 ✅ MCP + 事件闭环<br>Phase2 ✅ Rewind + MCP Resources<br>Phase3 ✅ Skills 系统<br>Hooks + 自定义命令延后 |
| [`2026-05-22-production-gaps-phase1.md`](2026-05-22-production-gaps-phase1.md) | completed | P0 | — | — | Phase 1 详细实施计划（8 tasks, 8 commits）。 |
| [`2026-05-22-production-gaps-phase2.md`](2026-05-22-production-gaps-phase2.md) | completed | P0 | — | — | Phase 2 详细实施计划（7 tasks）。Rewind（Revert+Fork）+ MCP Resources。 |
| [`2026-05-22-skills-system.md`](2026-05-22-skills-system.md) | superseded | P1 | — | 被 [2026-05-23-skills-system-phase3.md](2026-05-23-skills-system-phase3.md) 替代 | — |
| [`2026-05-23-skills-system-phase3.md`](2026-05-23-skills-system-phase3.md) | completed | P0 | Phase 1 + Phase 2 | — | Skills 系统实施计划（11 tasks）。agentskills.io 标准。 |
| [`2026-05-24-multi-session-concurrency.md`](2026-05-24-multi-session-concurrency.md) | completed | P0 | — | — | 多会话并发执行（3 tasks）。 |
| [`2026-05-25-e2e-restructure.md`](2026-05-25-e2e-restructure.md) | completed | P1 | — | — | E2E 测试套件重构（~71 tests，P0-P3 分层）。 |
| [`2026-05-26-tui-claude-code-parity.md`](2026-05-26-tui-claude-code-parity.md) | completed | P0 | — | — | TUI Claude Code 全面对标：布局重构、快捷键精简、功能补全、配置、主题（14 tasks）。 |

## 计划文件命名规范

```
plans/YYYY-MM-DD-<slug>.md
```

- 日期：计划创建日期
- slug：简短描述，kebab-case

## 计划取代规则

当方案 B 替代方案 A 时：
1. 方案 A 的状态改为 `superseded`
2. 在方案 A 的"替代/分叉"列注明被哪个方案替代
3. 方案 B 的开头注明"替代 [方案 A](path)"

当计划完成后：
1. 移除文件
2. 在 `execution/completed/` 创建完成记录
3. 如有未完成项，在 `backlog/` 中创建条目
4. 更新本注册表

## 方案间依赖

如果一个计划依赖另一个计划的产物，在"依赖"列标注计划文件名。被依赖的计划必须先完成，或与依赖方并行推进时明确划分阶段。
