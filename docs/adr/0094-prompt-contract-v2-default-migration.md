# ADR-0094：Prompt Contract V2 保持默认关闭

状态：superseded by ADR-0098
日期：2026-08-09
决策者：github:@ferqx
取代：ADR-0092 第 5 条中的固定十四日等待条件；不改变其 Prompt 架构、双路径或回滚结论

> 本 ADR 保留当时保持默认关闭的历史决策；当前默认值由 ADR-0098 取代并设为启用。

## 背景

Prompt Contract V2 已完成最新 `main` 集成、ADR 编号调整、三平台 session-log ACL smoke、显式启用
V2 的 production TUI PTY E2E、Required 与 OSS Release Candidate CI，并以默认关闭方式发布
[`v0.1.0`](https://github.com/ferqx/kite-code/releases/tag/v0.1.0)。release source/tag commit 为
`b3a2df663b728592056d3979cf7bdaedbb6d6c10`，六个三平台候选与 SHA-256 sidecar 均已上传。

原迁移计划要求双路径至少保留十四个完整自然日。2026-08-09，维护者直接决定不再需要该日历门禁，
因此可立即使用最终候选证据做迁移决策。该指令不等于要求默认开启，也不取消真实模型 A/B、生产 TUI
E2E、发布 CI 或独立 ADR 的证据要求。

用于迁移决策的最终候选为 `c98b4702dbb1ed2d6231966d82cca6784a398ba5`。它相对 release source
只增加灰度计划记录，没有 Runtime 行为变化；该提交的 Required 与 OSS Release Candidate 三平台任务均
通过。显式运行 `KITE_RUN_PROMPT_AB=1 bun run test:prompt:live`，使用
`opencode_go / deepseek-v4-flash` 得到：

- legacy：25/30（83.33%），无效工具名 0，参数错误 4，重复调用 5，安全违规 0；
- V2：23/30（76.67%），无效工具名 0，参数错误 1，重复调用 4，安全违规 0；
- 总耗时：legacy 149,580 ms，V2 131,719 ms；
- `contentLogged=false`，未保存 system prompt、项目指令、用户/模型正文或工具参数。

V2 改善参数错误、重复调用和耗时，但任务成功率比 legacy 低 6.67 个百分点。实现阶段 A/B 曾显示
V2 略高，说明结果尚不稳定，不能用那次基线覆盖最终候选结果。

## 决策

1. 取消本次迁移的固定十四日等待条件，不再以 `2026-08-24` 作为决策前置条件。
2. 接受最终候选 A/B 为本次迁移证据，并因任务成功率回退决定保持 `promptContractV2=false`。
3. 保留 legacy 与显式 `--feature promptContractV2=true` 路径；不删除 V2、项目指令 snapshot、
   capability revision 或 Runtime 历史。
4. ADR-0094 不授权未来自动翻转。若后续候选消除或能充分解释任务成功率回退，必须在新的精确候选上
   重跑真实 A/B，并由新的迁移 ADR 决定默认开启。

## 备选方案

1. **立即默认开启 V2**：拒绝。安全指标通过且次要指标改善，但最终候选任务成功率低于 legacy。
2. **继续等待十四日再决策**：拒绝。维护者已直接取消固定日历门禁；继续等待不会改变当前 A/B 证据。
3. **删除 V2 并只保留 legacy**：拒绝。V2 已有 production E2E、安全边界与多项效率改善，显式 opt-in
   仍提供后续改进和复验路径。

## 影响

- 当前发布与 `main` 都继续默认走 legacy，用户可显式启用 V2。
- 不产生 Runtime 或配置默认值代码改动；回滚面保持不变。
- 固定十四日门禁从当前规则中移除，但未来默认开启仍需要新的最终候选真实 A/B 和独立 ADR。
- 本轮 Prompt Contract V2 发布与迁移资格计划可以归档。

## 回滚

本决策没有翻转产品默认值，无需 Runtime 回滚。若显式 V2 出现问题，停止 opt-in 即可；若未来证据支持
默认开启，新增 ADR 并在同一迁移改动中更新默认值、active 文档和相关测试。
