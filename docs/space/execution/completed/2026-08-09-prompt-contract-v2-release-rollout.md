# Prompt Contract V2 默认关闭发布与迁移决策完成记录

状态：completed
完成日期：2026-08-09
计划：[`../../plans/2026-08-09-prompt-contract-v2-release-rollout.md`](../../plans/2026-08-09-prompt-contract-v2-release-rollout.md)
架构：[`../../../adr/0092-prompt-contract-v2.md`](../../../adr/0092-prompt-contract-v2.md)、[`../../../adr/0094-prompt-contract-v2-default-migration.md`](../../../adr/0094-prompt-contract-v2-default-migration.md)

## 完成范围

- Prompt Contract V2 与当时最新 `main` 集成，架构 ADR 调整为 ADR-0092；
- 三平台 session-log ACL smoke 与显式启用 V2 的 production TUI PTY E2E 通过；
- Qwen Token Plan 发布 smoke 迁移为 ADR-0093 固定的 OpenCode Go route；
- PR [#41](https://github.com/ferqx/kite-code/pull/41) 的全部发布门禁和 PR CI 通过并合并；
- 以 `promptContractV2=false` 发布 prerelease
  [`v0.1.0`](https://github.com/ferqx/kite-code/releases/tag/v0.1.0)，source/tag commit 为
  `b3a2df663b728592056d3979cf7bdaedbb6d6c10`，六个候选/sidecar 资产均上传并校验；
- PR [#42](https://github.com/ferqx/kite-code/pull/42) 登记发布 identity，合并后 main 为
  `c98b4702dbb1ed2d6231966d82cca6784a398ba5`；它相对 release source 只包含计划文档变化；
- 维护者直接取消固定十四日等待条件；最终候选真实模型 A/B 随即执行；
- ADR-0094 基于最终证据决定保持默认关闭，不翻转代码默认值。

## 验证证据

- final candidate Required：<https://github.com/ferqx/kite-code/actions/runs/31308967023>，成功；
- final candidate OSS Release Candidate：<https://github.com/ferqx/kite-code/actions/runs/31308967012>，
  macOS arm64/Linux x64/Windows x64 全部成功；
- release source 的 Required、OSS Release Candidate 与 MCP native keyring smoke：
  <https://github.com/ferqx/kite-code/actions/runs/31307539684>、
  <https://github.com/ferqx/kite-code/actions/runs/31307539688>、
  <https://github.com/ferqx/kite-code/actions/runs/31307539690>，全部成功；
- 最终候选真实 A/B：`KITE_RUN_PROMPT_AB=1 bun run test:prompt:live`，
  `opencode_go / deepseek-v4-flash`，legacy 25/30、V2 23/30，安全违规 0/0，无效工具名 0/0，
  参数错误 4/1，重复调用 5/4，总耗时 149,580/131,719 ms，`contentLogged=false`；
- 确定性双路径复验：feature flag、Prompt token budget 与 A/B runner contract 共 9 pass、0 fail。

## 结论

固定十四日等待不再是本次迁移门禁，但取消等待不会把弱证据升级为默认开启资格。最终候选 V2 的任务
成功率低于 legacy，因此 `promptContractV2` 保持默认关闭；显式 opt-in 与回滚路径继续存在。未来若要
默认开启，必须在新的最终候选上重新获取真实 A/B 证据并新增迁移 ADR。
