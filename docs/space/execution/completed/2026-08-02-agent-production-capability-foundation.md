# Agent 生产化 Phase 5 本地 Capability Foundation 完成记录

状态：completed
日期：2026-08-02
计划：[`2026-07-29-agent-production-capability-rollout.md`](../../plans/2026-07-29-agent-production-capability-rollout.md)
Executor：`github:@ferqx`
复核基线：`dc64d25d67c9e40330676668b5f039872d04269a`
实现 PR：[#21](https://github.com/ferqx/kite-code/pull/21)

## 完成范围

Task 5.1、5.2、5A.1、5A.2、5C.1、5C.2 与 5.4 的本地 foundation 已完成：

- strict Capability Profile/admission 只能收紧 embedded ceiling，并对 unknown dependency、platform、
  freshness 和 Gate 缺失 fail closed；
- CLI/TUI 分开展示 Agent final、Runtime terminal、Plan、checks 与 Verification，不允许 UI 绕过
  admission 或显示模糊“完成”；
- required Verification 的 risk-derived mode、repair/waive/compensation、budget、replay/recovery 和
  rollback 后存量事实均完成 conformance；
- Skill readonly/effectful 对 write/destructive/unknown dependency 保守升级，workflow contract 绑定
  strict schema、revision、reference、output、recovery 和 budget；
- active/book/map/ADR 与共同 framework boundary 已收敛，未完成轨道继续保持 off。

两路最终整体 Review 均为 GO，P0/P1/P2=`0/0/0`。本记录的六个定向 suite 为 29 pass/0 fail；
PR #21 的完整 TUI system 38 scenarios 还覆盖 capability status 生产入口。

## 未完成与真实 evidence waiting

四个 capability profile 均为 `under_development/off`，route/platform allowlist 为空、cohort=0。
5.3A/5.3C 等 task/adversarial evidence 仍等待 `MS:2B-DONE`；MCP write 还等待 stable Verification、
真实 route 和 Provider/recovery evidence。任何 internal dogfood、external canary、beta/stable maturity、
SLO 或第三方安全评审均未发生。本记录不产生任何 `MS:5*-STABLE`。

## 回滚与安全边界

回滚只能关闭新 admission、缩小 allowlist/cohort，并保留既有 required Verification、intent/receipt
与 unknown/reconciliation 状态。不得恢复 prompt Skill 正文注入、把 unknown effect 当 readonly、
跳过 dependency revision，或用本地 contract fixture 提升 maturity。
