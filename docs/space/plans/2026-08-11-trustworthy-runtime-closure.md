# 可信运行时收口计划

状态：active
日期：2026-08-11
优先级：P0
替代：`2026-08-09-agent-core-tool-plan-sandbox-optimization.md` 和
`2026-08-10-ci-stabilization-and-plan-evidence.md` 的剩余执行范围
依据：当前源码、测试、active 文档及 ADR-0094、ADR-0095、ADR-0096、ADR-0097

## 目标

完成可信运行时的统一审查，清除剩余兼容债，并形成可验证、可交付的最终候选。本计划只收口现有实现，不扩张产品能力。

## 当前状态

- 保留 CompletionGuard、Plan evidence、ToolOutcome、Recovery Journal、只读 Git inspect、安全门禁和串行 Subagent。
- Git mutation、Subagent 专用并行调度及重复的恢复完成态已经删除。
- ToolOutcome legacy/shadow 兼容层仍待清理，这是当前唯一未完成的迁移债。
- Prompt Contract V2 默认值仍为 `false`。
- Git production qualification 仍为 `excluded`，不得表述为已支持。
- 当前改动未 stage、commit 或 push；最终结果以收口后的完整复验为准。

## 剩余工作

按以下顺序执行：

### 1. 清理 ToolOutcome legacy/shadow

- 让当前执行路径只写入并消费 canonical `outcomeV1`。
- legacy decoder 仅用于读取历史 replay。
- 删除不再被当前路径使用的 shadow 写入、比较和兼容分支。
- 验证当前运行、历史 replay、失败恢复与终态一致性。

### 2. 完成统一审查与候选关闭

- 审查保留组件的职责、依赖方向以及 current/replay/cancel/resume 路径，修复未解决的 P0/P1 问题。
- 确认已删除的 Git mutation、Subagent 专用并行调度和重复恢复完成态没有残留或重新进入公开契约。
- 确认只读 Git inspect 仍经过 broker 和安全门禁；production qualification 继续保持 `excluded`。
- 同步受影响的 active 文档和最终完成记录，运行完整验证后再交付。

## 验证

- ToolOutcome current/replay、失败恢复和终态定向回归。
- 只读 Git inspect 的 broker、安全边界和 hostile repository 回归。
- 串行 Subagent 的委派、预算、取消和恢复回归。
- `bun run test`
- `bun run typecheck`
- `bun run check:core-boundary`
- `bun run check:docs-impact`
- `bun run check:docs`
- `bun run format:check`
- `git diff --check`

## 完成条件

以下条件全部满足后，本计划才可标记为 completed：

1. 当前路径只使用 `outcomeV1`，历史 replay 仍可由 legacy decoder 正确读取。
2. 统一审查无未解决的 P0/P1，保留功能通过定向回归和完整验证。
3. Git production qualification 保持诚实的 `excluded`，Prompt Contract V2 仍默认关闭。
4. 实现、active 文档与完成记录一致，交付范围不混入无关改动。

stage、commit、push 或创建 PR 前，必须完整执行项目 `document-before-commit` Skill；文档影响或 Required 验证未通过时不得交付。
