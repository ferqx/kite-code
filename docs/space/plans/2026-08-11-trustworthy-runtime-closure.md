# 可信运行时收口计划

状态：archived
日期：2026-08-11
优先级：P0
替代：`2026-08-09-agent-core-tool-plan-sandbox-optimization.md` 和
`2026-08-10-ci-stabilization-and-plan-evidence.md` 的剩余执行范围
依据：当前源码、测试、active 文档及 ADR-0094、ADR-0095、ADR-0096、ADR-0097

## 目标

完成可信运行时的统一审查，清除剩余兼容债，并形成可验证、可交付的最终候选。本计划只收口现有实现，不扩张产品能力。

## 最终状态

- 保留 CompletionGuard、Plan evidence、ToolOutcome、Recovery Journal、只读 Git inspect、安全门禁和串行 Subagent。
- Git mutation、Subagent 专用并行调度及重复的恢复完成态已经删除。
- ToolOutcome current 路径只由 Kernel 写入并发布 canonical `outcomeV1`；reducer、TUI、
  Session Logger 和 metrics 已删除 legacy/shadow fallback。
- pre-v23 历史终态仅由独立 historical replay decoder 保守转换，不从 stderr、result
  body 或 provider 文本推导可重放性。
- Prompt Contract V2 默认值仍为 `false`。
- Git production qualification 仍为 `excluded`，不得表述为已支持。
- 统一审查没有未解决的 P0/P1，也没有发现有明确证据应在本计划内继续删除的架构或工程冗余。
- 完成记录：[`2026-08-11-trustworthy-runtime-closure.md`](../execution/completed/2026-08-11-trustworthy-runtime-closure.md)。
- 统一审查通过后已获用户授权提交；未 push。

## 完成结果

已按以下顺序完成：

### 1. ToolOutcome legacy/shadow 清理

- Kernel 成为唯一 current-event canonicalization 边界，Runner/Agent 只发布 Kernel
  实际持久化的事件。
- current reducer 拒绝缺失或非法 outcome；历史 restore 和 Session replay 先进入唯一 decoder。
- 删除 `legacyToolOutcomeV1`、历史 fallback 辅助函数、consumer 的 optional fallback、
  Kernel envelope 绕过入口和失去用途的迁移措辞。
- 保留工具 payload 中仍有模型 transcript/展示用途的 `result`、`failure` 和历史 `error`；
  它们不再是 current outcome 权威来源。

### 2. 统一审查与候选关闭

- 保留了单一 Kernel/Reducer 状态源、CompletionGuard、Plan evidence、Recovery Journal、
  只读 `git_inspect`、安全边界和串行 Subagent。
- Git mutation、Subagent 专用并行 batch 和重复 recovery terminal 没有回到公开契约或可达执行路径。
- `promptContractV2` 源码默认值与回归断言均为 `false`。
- `git_inspect` 仍只包含 status/diff/log/branch-list，并通过 broker、repository/binary/
  protected-path/hostile-config/native-deny 门禁；三平台 production qualification 仍为 `excluded`。

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
