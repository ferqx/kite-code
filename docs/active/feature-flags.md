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

生产治理基础 schema 使用以下默认关闭的迁移 flag：

| 开关 | 默认值 | 当前职责 |
| --- | --- | --- |
| `sessionLoggingPolicyV1` | `false` | App 注入 resolved logging policy；关闭时为 `off`，开启时默认 metadata-only |
| `providerDataPolicyV1` | `false` | 所有模型 dispatch 使用 release-pinned Provider 数据 gate；当前批准 route bundle 为空 |
| `remoteMcpEgressPolicyV1` | `false` | 开启远程 HTTP MCP 单 invocation 内容许可；关闭时 remote content=no-egress |
| `resourceBudgetV1` | `false` | 启用 Runtime v19 累计预算 admission、FIFO/compound permit 与恢复语义 |
| `boundedCancellationV1` | `false` | 启用 run deadline、统一 AbortSignal 与 descendant/process-tree 有界清理 |
| `terminalOutcomeV1` | `false` | 控制 CLI 的结构化 terminal presentation；持久化 outcome 始终保留 |
| `executionBoundaryV1` | `false` | 允许 composition root 消费 release-pinned `ExecutionBoundaryV1`；开启本身不产生平台资格或边界 artifact |
| `networkBoundaryV1` | `false` | 启用 sealed boundary 的逐 invocation DNS/redirect/endpoint admission；关闭时 production network 只能收紧为 `off` |

`providerDataPolicyV1` 或 `resourceBudgetV1` 单独打开不会让 production run 自动获得资格：
前者仍要求批准 registry/gate，且当前 route 集合为空；后者只允许新 run 建立 limited preset
ledger，v17 及更早 snapshot 的 `legacy_unconfigured` 状态仍拒绝热迁移。关闭任一开关时，
production profile 必须 fail closed；开发 profile 才可显式使用旧路径。用户、项目和 CLI 覆盖
不能放宽批准 policy/budget。`terminalOutcomeV1=false` 只用于 rollout 回退，不允许 production
客户端把 `unknown`、`blocked`、`budget_exhausted` 或 `resource_saturated` 显示成完成；
CLI 关闭时只省略派生 presentation，原始结构化 outcome 不被删除。启用 resource budget 但未
启用 bounded cancellation 时，模型不披露 writer、Shell 和 child capability，Controller 同时
拒绝其执行，不能退回无界副作用路径。

`remoteMcpEgressPolicyV1=false` 不恢复旧远程外发：HTTP MCP 只有空参数的 content-free Tool Call
可继续，任何非空最终参数都在 Provider readiness/Tool request 前拒绝。开启后仍必须由 App
边界注入独立的单次 permit resolver；缺失、格式错误、超过五分钟 TTL、过期、
revision/argument/classification 不匹配、nonce replay 或 receipt 持久化失败全部 fail closed。
该 flag 不继承 `providerDataPolicyV1` 的
模型 route consent，也不替代 sealed MCP transport 的逐 invocation receipt 与 endpoint admission。

`sessionLoggingPolicyV1` 开启不等于允许正文。`content` 还要求 release artifact 明确允许且
用户/管理员在用户配置显式 opt-in；project config 永远不能开启。关闭 flag 必须收紧为 `off`，
不能回退到旧 content serializer。

`executionBoundaryV1` 的用户、项目或 CLI 值只控制 rollout 请求，不能定义
`ExecutionBoundaryV1`。普通 CLI 直接用 `--feature` 把 `executionBoundaryV1` 或
`networkBoundaryV1` 设为 true 会立即拒绝；production 的有效值固定为 release artifact ceiling 与 rollout 请求的
逻辑与；user、project、CLI/App 的每个显式值也按逻辑与组合，全部未指定时使用默认关闭。任一
为 `false` 都关闭，后层的 `true` 不能抬高前层或 artifact ceiling。普通
`loadAgentConfig()` 不投影 boundary；只有 `loadProductionAgentConfig()` 接受 release-controlled
`artifactExecutionBoundary`，并在返回可运行配置前使用仓库固定、revision/digest 校验的批准
qualification registry。artifact 缺失/非法、Workspace 不匹配、实际环境无精确 qualification 或
任一 backend 维度未强制时，生产 capability surface 全部关闭；审批不能恢复。当前批准 registry
为空支持集，因此本 flag 不产生 production artifact 或可运行的 production shell/writer。

`networkBoundaryV1` 同样按 user、project、CLI/App 的显式值 deny-wins 组合；全部未指定时默认
关闭。关闭不能恢复旧 `allow_all`：production capability surface 的 network 轴被关闭，sealed
boundary 内的 `web_fetch` 在 DNS 前以 `network_off` 拒绝，Shell/Skill descendant 固定使用
network-off。开启允许 `web_fetch` 与具备 App receipt controller 的 remote HTTP MCP 使用 release
boundary 的精确 host allowlist；每个请求/redirect hop 独立解析并把 socket 固定到已批准 IP。
当前 production TUI 没有该 MCP controller，因此 remote transport 仍关闭；local stdio 无条件排除。
该 flag 不提供 URL path 级隔离，也不产生平台资格。

上下文压缩的 flag 术语（功能开关）真值如下：

| 开关 | 默认值 | 职责 |
| --- | --- | --- |
| `contextCompactionV2` | `true` | 启用 checkpoint 术语（检查点）、统一投影与压缩基础契约 |
| `contextCompactionAutoV1` | `false` | 允许 `compaction.autoMode` 进入 `shadow` 或 `live`；不解释 Provider 术语（模型供应商）错误 |
| `contextCompactionManualV1` | `true` | 允许 `/compact` 产生 `manual` |

压缩原因固定为 `manual | auto`。自动模式固定为 `off | shadow | live`：`off` 不判断，`shadow` 只计算 trigger eligibility 术语（触发资格）且不调用摘要模型、不写 checkpoint 术语（检查点），`live` 命中阈值后产生 `reason=auto`。默认 flag 术语（功能开关）为 `false`，且未配置 `autoMode` 时按 `off` 处理。

通用 HTTP 400、其他 Provider 术语（模型供应商）失败、token ratio 术语（文本计量比例）或压缩失败都不会创建 hard block 术语（硬阻断）；用户可在会话恢复交互后自行执行 `/compact`。
