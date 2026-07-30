# Feature flags

状态：active
读取时机：新增、删除或调整 runtime feature flag、配置合并、CLI 覆盖或灰度策略时。
验证：`bun test tests/config/features.test.ts`。

Runtime feature flags are registered in `src/core/config/features.ts`. Configuration is read from the optional `features` object in user and project `kite-code.jsonc`; project values override user values.

Use `bun run agent run --feature autoReviewV2` for a one-run override. A value can be explicit, for example `--feature autoReviewV2=false`. Unknown names fail fast.

New flags must default to `false`, include tests for both values, and retain the old path for at least two weeks before it is removed. Flags may default to `true` only after their migration ADR is accepted and the production TUI path has end-to-end coverage. `planLifecycleV2` and `interactionControllerV2` are established migrations and default to `true`.

Exception: ADR-0007 explicitly replaces the old MCP adapter, and ADR-0020 completes stable on-demand loading. `capabilityCatalogV1`、`mcpRuntimeBindingV1` and `toolSearchV1` therefore default to `true`; disabling any of them remains a fail-closed diagnostic override and must never re-enable a legacy MCP execution path.

With `toolSearchV1` enabled, MCP schemas are always loaded on demand through metadata-only search and retained in the session while revisions match; Skill disclosure still uses provider support and context budget.

`autoReviewV2` currently gates configurable reviewer timeouts; disabled deployments retain the established 15-second reviewer timeout. This enables a reversible rollout without weakening policy checks or changing auto-mode routing.

生产治理基础 schema 使用三个默认关闭的迁移 flag：

| 开关 | 默认值 | 当前职责 |
| --- | --- | --- |
| `sessionLoggingPolicyV1` | `false` | 注册 metadata-first 日志策略 schema；关闭时 policy resolver 收紧为 `off` |
| `providerDataPolicyV1` | `false` | 注册仓库受控的 Provider 数据策略 schema；当前批准 route bundle 为空 |
| `resourceBudgetV1` | `false` | 注册 Runtime v18 累计预算 ledger；invocation admission 接入前不能产生 production 资格 |

这些开关目前只保护 schema 迁移边界。单独打开开关不会让 Provider route、production logging
或 production run 获得资格；对应 admission/composition Task 完成前仍 fail closed。用户、项目和
CLI 覆盖只能在后续 effective policy 组合中收紧批准上限。


上下文压缩的 flag 术语（功能开关）真值如下：

| 开关 | 默认值 | 职责 |
| --- | --- | --- |
| `contextCompactionV2` | `true` | 启用 checkpoint 术语（检查点）、统一投影与压缩基础契约 |
| `contextCompactionAutoV1` | `false` | 允许 `compaction.autoMode` 进入 `shadow` 或 `live`；不解释 Provider 术语（模型供应商）错误 |
| `contextCompactionManualV1` | `true` | 允许 `/compact` 产生 `manual` |

压缩原因固定为 `manual | auto`。自动模式固定为 `off | shadow | live`：`off` 不判断，`shadow` 只计算 trigger eligibility 术语（触发资格）且不调用摘要模型、不写 checkpoint 术语（检查点），`live` 命中阈值后产生 `reason=auto`。默认 flag 术语（功能开关）为 `false`，且未配置 `autoMode` 时按 `off` 处理。

通用 HTTP 400、其他 Provider 术语（模型供应商）失败、token ratio 术语（文本计量比例）或压缩失败都不会创建 hard block 术语（硬阻断）；用户可在会话恢复交互后自行执行 `/compact`。
