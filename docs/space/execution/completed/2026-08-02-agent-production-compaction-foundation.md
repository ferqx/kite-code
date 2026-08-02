# Agent 生产化 Phase 4 本地 Compaction Foundation 完成记录

状态：completed
日期：2026-08-02
计划：[`2026-07-29-agent-production-compaction-qualification.md`](../../plans/2026-07-29-agent-production-compaction-qualification.md)
Executor：`github:@ferqx`
复核基线：`dc64d25d67c9e40330676668b5f039872d04269a`
实现 PR：[#21](https://github.com/ferqx/kite-code/pull/21)

## 完成范围

`MS:1B-DONE` 与 2B.1 closure 后，Task 4.1、4.2、4.3、4.6 与 4.8 的本地 foundation 已满足依赖：

- 4.1：strict/versioned `CompactionCaseV1`、1–5 increment 和无 live content fixture；
- 4.2：structure/replay/lease/tool-pair failure taxonomy 与 fail-closed adapter；
- 4.3：deterministic fact matcher 的 path/case/whitespace normalization、critical fact 和 forbidden
  claim 规则；
- 4.6：route/behavior identity 与 qualification registry；当前 supported route set 明确为空；
- 4.8：无资格 route 的 no-compaction TUI/CLI handoff，保留 transcript/artifact，并把过长任务显示为
  unsupported 而非成功。

两路最终整体 Review 均为 GO，P0/P1/P2=`0/0/0`。`bun test tests/evals/compaction` 为
36 pass/0 fail；PR #21 的完整 TUI system 38 scenarios 覆盖 compaction handoff 入口。

## 未完成与真实 evidence waiting

4.4 的本地 blind contract 不具备 authenticated semantic evaluator authority，保持 `in_progress`。
4.5 仍等待 2B.4 的真实重复运行基础；4.7 需要显式 live route；4.9 需要真实 task/route、Phase 3
dashboard/kill-switch、G3/G4 与 internal rollout evidence。External manual canary、SLO 和 maturity
窗口未发生。本记录不产生 `MS:4-INTERNAL-AUTO-FRESH` 或 `MS:4-MANUAL-STABLE`，manual/auto
compaction 继续 off。

## 回滚与安全边界

任一 critical fact、tool pair、lease、route identity 或 transcript preservation 失败都关闭 route
qualification；不得用 synthetic score、contract-only adapter 或无 compaction handoff 提升 manual/auto
maturity。原 transcript/checkpoint 保留，cohort 保持 0。
