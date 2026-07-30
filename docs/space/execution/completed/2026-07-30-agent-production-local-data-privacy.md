# Agent 生产化 Phase 1A Task 1A.1/1A.5 完成记录

状态：completed
日期：2026-07-30
计划：
[`2026-07-29-agent-production-local-data-privacy.md`](../../plans/2026-07-29-agent-production-local-data-privacy.md)
执行者：`github:@ferqx`
实现提交：
`1A.1=4b8eec058df0af545675fc0e1c4135ee855848fd`；
`1A.5=1e21055eb8b2579d710eb566728294f2ad8b2621`

## Task 1A.1

- 固化 `SessionLoggingPolicyV1`、`ProviderDataPolicyV1`、canonical route identity、
  `WorkspaceDataLabelV1` 和空的 D-14 approved bundle。
- `sessionLoggingPolicyV1`、`providerDataPolicyV1` 默认关闭；关闭时不恢复未治理正文日志或
  Provider 外发路径。

## Task 1A.5

- 新增仓库 bundle registry/loader、registry digest、route/data/payload admission 和脱敏状态
  投影。
- `limited` unknown/missing/expired/drift route fail closed；unknown custom endpoint 仅允许
  `internal_experimental` 且正文分类不高于 internal。
- secret label、credential/private-key marker 和 protected-path marker 在 Provider dispatch
  前阻断；mock Provider 请求数保持为零。
- Model Controller 在 `providerDataPolicyV1=true` 时强制要求注入 immutable gate；缺 gate 不
  回退开发配置。

## 验证

- `bun test tests/config/provider-data-policy.test.ts tests/model-provider-data-policy.test.ts`：
  11 pass；
- 完整默认套件：main 2018 pass/6 skip，5 个隔离文件 26 pass；
- `bun run check:docs-impact`、`bun run check:docs`、`bun run check:core-boundary`、
  `bun run typecheck`、Biome 和 `git diff --check`：通过；
- pre-commit golden：10 pass。

## 回滚与限制

- 回滚设置 `providerDataPolicyV1=false`；production route 全部关闭，旧 qualification 不恢复。
- 当前 approved route bundle 为空，因此本记录不产生 production-qualified route，也不产生
  `MS:1A-DONE`。
- Session logger metadata mapper/composition/secure writer 仍由 1A.2–1A.4 完成；remote MCP
  content egress 仍等待 1A.6。
