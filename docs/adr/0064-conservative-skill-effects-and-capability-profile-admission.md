# ADR-0064：Skill effect 保守分类与 Capability Profile 证据准入

状态：accepted
日期：2026-08-02
决策者：`github:@ferqx`（Capability + Security & Privacy，single-maintainer）
关联：D-10、Phase 5、ADR-0008、ADR-0051

## 背景

项目未来会接受外部 Pull Request 和 project Skill，但当前只有单维护者。把 Skill 自声明的 readonly、
某一个 feature flag 或 profile 中的 freshness 数字当成实际准入证据，会让 dependency drift、unknown
effect 或缺失 G3–G5 绕过发布边界。代码存在也不代表某 capability 已 internal/canary/stable。

## 决策

1. Skill 只有在自身及全部 dependency 的 effective effects 都明确为 `none|read` 时才属于
   `skills_readonly`。write、destructive、unknown、解析失败或 dependency drift 一律归
   `skills_effectful` 并保持 off，不能乐观降级。
2. project Skill 还要求 Workspace Trust；manifest/allowed-tools 只表达 ceiling，不构成预批准。
   effectful Skill 必须 required Verification，并继承 worktree、Provider Data、预算、recovery 与
   compensation 边界。
3. 每条 release track 使用 strict `CapabilityProfileV1`。Admission 同时检查全部 required feature
   flags、精确 dependency revision、embedded ceiling、platform/route allowlist、实际 evidence age 与
   G3/G4/G5；缺失/unknown/stale/failed 全部 blocked。MCP write 必须有显式 route。
4. 关闭 track 只停止新 admission 并把 cohort 置 0；不删除 intent、Receipt、required Verification、
   Skill frame 或 unknown/reconciliation facts。
5. 当前 Verification、MCP write 和两类 Skill profile 全部 under-development/off；本地 conformance
   不是 internal/canary/maturity evidence，也不产生 stable milestone。

## 备选方案

- 信任 Skill 自称 readonly：拒绝，dependency 或 Tool ceiling 可引入副作用。
- unknown effect 按 read 处理：拒绝，无法 fail closed。
- 单 feature flag 即准入：拒绝，不能证明依赖、route、证据 freshness 或 Gate。
- rollback 删除旧 Verification/Receipt：拒绝，会破坏恢复和审计事实。

## 后果

一些合法 Skill 会因 unknown dependency 被保守归为 effectful，需要补齐 schema/revision 才能重新分类。
每条 capability 的启用成本增加，但开源贡献无法仅靠 manifest/profile 文本取得生产能力。

## 回滚

可以关闭单 track、清空 route allowlist、cohort 归零或回滚 profile/artifact。不得回滚为 unknown=read、
manifest 自授权、缺 G3–G5 继续准入，或删除已有 Receipt/Verification 来简化 rollback。
