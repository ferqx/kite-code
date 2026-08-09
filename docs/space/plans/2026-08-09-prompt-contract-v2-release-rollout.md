# Prompt Contract V2 默认关闭发布与迁移资格计划

状态：active
日期：2026-08-09
关联：ADR-0092、`docs/active/feature-flags.md`、`docs/active/real-model-test-boundary.md`、`docs/active/open-source-first-release.md`

## 目标

先以 `promptContractV2=false` 发布可回滚候选，在真实可用版本中同时保留 legacy/V2 至少十四个完整自然日；观察期结束后，只在最终候选提交上重新运行真实模型 A/B。是否把默认值改为 `true` 必须由新的迁移 ADR 决定，不能由实现阶段 A/B、确定性 mock 或 production TUI E2E 单独推出。

## 阶段与门禁

1. **发布资格**：集成最新 `main`，解决 ADR 编号冲突；三平台 session-log ACL smoke、production TUI V2 PTY E2E、Required 与 OSS Release Candidate CI 全部通过。
2. **默认关闭灰度**：发布产物保持 `promptContractV2=false`，记录 release/tag、精确 source commit、开始时间和回滚入口。未发布的 PR 或临时 merge ref 不开始十四日计时。
3. **双路径观察**：从默认关闭版本真实可用时起至少十四个完整自然日，legacy 与显式 opt-in V2 都保持可运行；持续保留确定性双路径门禁，并记录阻断缺陷、回滚或兼容性事件。任一需要重新发布候选的 V2 实质修复都会重置最终候选 identity；是否重置观察窗口由迁移 ADR 按风险说明。
4. **最终候选 A/B**：观察窗口结束后，把 runner 绑定到计划用于迁移的精确候选 commit，按 `docs/active/real-model-test-boundary.md` 运行真实模型 legacy/V2 对照；只保存聚合指标、脱敏失败分类和 `contentLogged=false` 证据。2026-08-08 的实现阶段 A/B 仅为基线，不满足本阶段。
5. **迁移决策**：新增迁移 ADR，引用 release identity、观察起止时间、CI 与最终候选 A/B 证据，明确选择保持默认关闭、默认开启或延长灰度。只有 ADR 接受“默认开启”后，才能在同一迁移改动中翻转默认值并更新 active 文档。

## 当前状态

- release identity：GitHub prerelease
  [`v0.1.0`](https://github.com/ferqx/kite-code/releases/tag/v0.1.0)，source/tag commit
  `b3a2df663b728592056d3979cf7bdaedbb6d6c10`，发布时间 `2026-08-09T10:34:36Z`；六个 macOS
  arm64/Linux x64/Windows x64 candidate 与 SHA-256 sidecar 均已上传；
- 双路径观察开始：`2026-08-09T18:34:36+08:00`；为覆盖至少十四个完整自然日，最早结束时间固定为
  `2026-08-24T00:00:00+08:00`，在此之前不得运行迁移资格 A/B 或决定默认开启；
- 最终候选 commit 与 A/B：待观察窗口结束后登记；
- 迁移 ADR：待上述证据完整后创建。

## 回滚

灰度期间保持 `promptContractV2=false` 即为默认回滚面；显式 opt-in 出现问题时停止 opt-in，不删除 capability revision、项目指令 snapshot 或 Runtime 历史，也不回退与 flag 无关的正确性和安全修复。
