# 上下文压缩生产化实施完成记录

完成日期：2026-07-22

关联计划：[`2026-07-21-context-compaction-production-rollout.md`](../../plans/2026-07-21-context-compaction-production-rollout.md)

## 已交付

- 上下文压缩收敛为 manual/auto 共用的单次 Markdown narrative pipeline，保留不可变 transcript、安全 turn/tool boundary、轻量 checkpoint 与 XML-safe 唯一 summary frame。
- 后续简化删除 M1 工具结果投影、固定 `recentTurns` 与 bounded prefix；manual 一次总结全部安全历史，auto 仅保护当前 turn，显式输入上限超出时整体失败。
- 删除 structured summary、fact ledger、通用 overflow recovery、模型名静态 capability fallback 和 ratio-driven hard block。
- 完成 checkpoint replay/reset、environment freshness、stale result 丢弃、三阶段进度、脱敏终态通知、Core context snapshot、注入式指标与稳定 `off/shadow/live` rollout。
- 增加显式 opt-in 的原子本地 debug 输出、Required CI 五个固定 job、legacy symbol 扫描及独立真实 Provider runner。
- 同步更新 active、book、README、ADR 关联计划和测试边界文档；无需仓库外 GitHub ruleset。

## 验证证据

- `quality`：`typecheck`、`format:check`、`lint`、`check:core-boundary`、`check:compaction-legacy`、`check:docs`、`check:docs-impact` 全部通过。Biome 保留仓库既有 warning/info，命令退出码为 0。
- `unit`：简化后的完整非 PTY 套件 1701 passed、2 skipped、0 failed；会话总结聚焦套件 261 passed、0 failed。
- `compaction-contract`：5 passed，0 failed。
- `runtime-e2e`：7 passed，0 failed。
- `tui-system`：122 passed，0 failed。
- 真实 Provider：DeepSeek `deepseek-v4-flash` 的 `manual-direct-summary` 与 `incremental-summary` 通过；未记录请求、响应正文或凭证。
- 补充矩阵覆盖：manual/auto/stale progress cleanup、跨 completed/failed/cancelled 终态竞态去重、fresh Footer projection、shadow 零压缩副作用、20 次增量 digest chain，以及 Windows owner-only/no-inheritance ACL callback 与 Windows 条件实机检查。
- `git diff --check` 通过。

## 后续边界

- 仓库默认 `contextCompactionAutoV1=false`，rollout mode 保持 `off`；灰度启用属于后续运营动作，不改变默认配置。
- Provider 错误、空/截断/timeout、stale 与 auto 控制语义继续由确定性 contract 测试覆盖；真实配额只验证 Provider 敏感路径。
