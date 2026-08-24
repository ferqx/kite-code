# 功能开关

状态：active
读取时机：新增、删除或调整 runtime feature flag、配置合并、CLI 覆盖或灰度策略时。
验证：`bun test tests/config/features.test.ts`、`bun run test:tui:system prompt-contract-v2-production`。

Runtime 功能开关注册在 `apps/kite/src/config/features.ts`。配置从用户级和项目级 `kite-code.jsonc` 的可选 `features` 对象读取；项目值覆盖用户值。

单次运行可使用 `bun run agent run --feature autoReview` 覆盖。值可以显式给出，例如 `--feature autoReview=false`；未知名称会立即失败。

新增开关必须默认 `false` 并覆盖两个取值的测试。Kite Code 未发布；当 current 路径成为唯一生产语义后，必须删除旧分支与对应 flag，不保留回滚 alias。只有 ADR 已接受且 production TUI 路径具有端到端覆盖时，开关才可默认 `true`。

Production Runtime format 不受 feature flag 控制。RA-06 已直接切换到 schema v26、SQLite Store 与
`kite-runtime-modularization-v1-2026-08-19`；不存在 SQLite Store reader、旧 dispatch composition 或 runtime rollback flag。
这项 format authority 不适用上面的普通功能 rollout 保留期。

例外是 ADR-0007 已明确替换旧 MCP adapter，ADR-0020 已完成稳定按需加载。因此 `capabilityCatalog`、`mcpRuntimeBinding` 和 `toolSearch` 默认 `true`；关闭其中任一个仍只是 fail-closed 诊断覆盖，绝不能重新启用旧 MCP 执行路径。

启用 `toolSearch` 后，MCP Tool 数量在 1–20 之间且其 schema 估算 token 未超过 disclosure budget 时可直接绑定；其他情况下，只有整体 catalog 仍适合该预算才直接披露，超出预算则通过仅含元数据的搜索按需加载。revision 匹配时已加载能力保留在会话中；Skill 披露仍按 Provider tool-call 支持与上下文预算独立决策。

Prompt 分层、项目指令快照、简洁工具契约、phase-stable builtin/MCP 声明与 Runtime phase policy 是唯一生产路径，不受 feature flag 选择。production-mode TUI 路径确定性覆盖出站角色顺序、项目上下文、唯一 Runtime block、稳定的 Planning 声明和 Runtime 自身的 phase 拒绝。

`autoReview` 当前控制可配置的 reviewer timeout；关闭的部署保留既有的 15 秒 reviewer timeout。这使灰度可逆，而不会削弱 policy 检查或改变 auto mode 路由。

生产治理基础 schema 使用以下默认关闭的迁移 flag：

| 开关 | 默认值 | 当前职责 |
| --- | --- | --- |
| `sessionLoggingPolicy` | `true` | App 注入 resolved logging policy；默认 metadata-only，显式关闭时为 `off` |
| `resourceBudget` | `false` | 启用 Runtime v19 累计预算 admission、FIFO/compound permit 与恢复语义 |
| `boundedCancellation` | `false` | 启用 descendant/process-tree 的有界清理资格；run deadline 由 `resourceBudget` 持久化并执行，不由该开关创建或关闭 |
| `terminalOutcome` | `false` | 控制 CLI 的结构化 terminal presentation；持久化 outcome 始终保留 |
| `executionBoundary` | `false` | 允许 composition root 消费 release-pinned `ExecutionBoundary`；开启本身不产生平台资格或边界 artifact |
| `brokeredGit` | `false` | 请求 ADR-0097 typed Git surface；ADR-0131 后既有 native-deny qualification 失效，只有后续 ADR 与新鲜平台 evidence 建立不缩小 Workspace 的资格模型时才可生效 |
| `networkBoundary` | `false` | 启用 sealed boundary 的逐 invocation DNS/redirect/endpoint admission；关闭时 production network 只能收紧为 `off` |
| `releaseProfile` | `false` | 请求使用 artifact-pinned Release Profile；没有独立 artifact authority 时 true 不生效且 CLI 拒绝抬高 |
| `observabilityMetrics` | `false` | 允许 artifact-authorized、用户已 consent 的无正文 metric exporter；普通 CLI 只能设为 false |

Phase 5 的 `verification`、`mcpExecutionRecord`、`mcpProviderAction`、
`skillActivation` 与 `skillWorkflow` 也全部默认关闭。Release admission 不接受 profile 自报开关：
它验证实际 resolved flags，MCP write 同时要求两个 MCP flag 与 Verification，Skill 同时要求
activation/workflow，并继续检查 dependency revision、route/platform 和实际 G3–G5 freshness。
当前六条 capability profile（Verification、MCP write、Skills readonly/effectful、manual/auto
Compaction）全部 `under_development/off`。

`resourceBudget` 单独打开不会让 production run 自动获得资格：它只允许新 run 建立 limited preset
ledger。Runtime restore 只接受当前精确 format epoch，旧 snapshot 在进入 budget reducer 前即
fail closed。关闭任一开关时，production profile 必须 fail closed；开发 profile 才可显式使用旧路径。用户、项目和 CLI 覆盖
不能放宽批准 policy/budget。`terminalOutcome=false` 只用于 rollout 回退，不允许 production
客户端把 `unknown`、`blocked`、`budget_exhausted` 或 `resource_saturated` 显示成完成；
CLI 关闭时只省略派生 presentation，原始结构化 outcome 不被删除。启用 resource budget 但未
启用 bounded cancellation 时，模型不披露 writer、Shell 和 child capability，Controller 同时
拒绝其执行，不能退回无界副作用路径。

`providerDataPolicy` 与 `remoteMcpEgressPolicy` 已删除。Model 的四种 purpose 固定经过唯一 Model Gateway；
HTTP MCP 固定经过 transport/endpoint admission、JSON-safe bounded argument
inspection 与 shared CredentialBroker。二者都没有 release-pinned route allowlist、DataOrigin/EgressAuthority
或单次 content permit，也不能通过配置恢复旧实现。

`sessionLoggingPolicy` 开启不等于允许正文。`content` 还要求 release artifact 明确允许且
用户/管理员在用户配置显式 opt-in；project config 永远不能开启。关闭 flag 必须收紧为 `off`，
不能回退到旧 content serializer。

`executionBoundary` 的用户、项目或 CLI 值只控制 rollout 请求，不能定义
`ExecutionBoundary`。普通 CLI 直接用 `--feature` 把 `executionBoundary` 或
`networkBoundary` 设为 true 会立即拒绝；production 的有效值固定为 release artifact ceiling 与 rollout 请求的
逻辑与；user、project、CLI/App 的每个显式值也按逻辑与组合，全部未指定时使用默认关闭。任一
为 `false` 都关闭，后层的 `true` 不能抬高前层或 artifact ceiling。普通
`loadAgentConfig()` 不投影 boundary；只有 `loadProductionAgentConfig()` 接受 release-controlled
`artifactExecutionBoundary`，并在返回可运行配置前使用仓库固定、revision/digest 校验的批准
qualification registry。artifact 缺失/非法、Workspace 不匹配、实际环境无精确 qualification 或
任一 backend 维度未强制时，生产 capability surface 全部关闭；审批不能恢复。当前批准 registry
为空支持集，因此本 flag 不产生 production artifact 或可运行的 production shell/writer。

`brokeredGit=true` 也不会单独披露 Git。composition 还必须注入精确
`brokered-git-r1` capability surface、共享 protected-path evaluator 与 App Git process adapter，并通过
后续 ADR 定义的新资格模型。ADR-0131 禁止为了资格重新添加 Workspace `.git` 名称级 deny；缺少任一项时 `gitInspect` 为 false；
不得从 generic `process`/`read_only_only` 推断。ADR-0134 删除 raw Git token 的强制 broker routing并保留
`git status`/无 patch `git log` 的 hardened read environment；ADR-0136 要求所有 raw Git 在进入该 environment
前按 Full、Auto、Accept Edits 治理，不从 read-only grammar、Workspace target 或 local subcommand 推导免审
授权。这些规则都不推导或冒充 `gitInspect` capability。当前三平台 brokered Git
qualification 均为 excluded；它们与唯一 Prompt/工具契约路径相互独立。

`networkBoundary` 同样按 user、project、CLI/App 的显式值 deny-wins 组合；全部未指定时默认
关闭。关闭不能恢复旧 `allow_all`：production capability surface 的 network 轴被关闭，sealed
boundary 内的 `web_fetch` 在 DNS 前以 `network_off` 拒绝，Shell/Skill descendant 固定使用
network-off。开启允许 `web_fetch` 与具备 App receipt controller 的 remote HTTP MCP 使用 release
boundary 的精确 host allowlist；每个请求/redirect hop 独立解析并把 socket 固定到已批准 IP。
当前 production TUI 没有该 MCP controller，因此 remote transport 仍关闭；local stdio 无条件排除。
该 flag 不提供 URL path 级隔离，也不产生平台资格。

`releaseProfile` 不是普通功能开关。有效 Release composition 同时要求 App 注入的 artifact
authority、embedded profile 和 deny-wins rollout/restriction layers；project/user 不能提供前两项。
普通 CLI 的 `--feature releaseProfile=true` 立即拒绝，false 只会收紧。当前 D-04 支持集为空，
所以即使 foundation fixture 同时打开 artifact/rollout，production profile 仍以
`production_support_set_empty` 拒绝；internal fixture 的 capability、预算、route、logging 和
telemetry 也全部关闭。production composition 必须携带 registry 接受的非空外部 support identity，
不能使用 internal profile；controlled config 在 Runtime 创建前再次验证该身份，调用者不能用
`production + internal-dogfood` 绕过空支持集。

`observabilityMetrics` 不是 remote telemetry 的单一授权。有效 exporter 同时要求 release artifact
明确允许、flag=true、用户 consent 有效和 exporter 已配置；project 配置只能关闭。普通 CLI 的
`--feature observabilityMetrics=true` 会拒绝，false 只收紧。关闭时注入 no-op reporter，不回退到
历史通用 OTel serializer，也不创建磁盘 spool。

上下文压缩的 flag 术语（功能开关）真值如下：

| 开关 | 默认值 | 职责 |
| --- | --- | --- |
| `contextCompaction` | `true` | 启用 checkpoint 术语（检查点）、统一投影与压缩基础契约 |
| `contextCompactionAuto` | `false` | 允许 `compaction.autoMode` 进入 `shadow` 或 `live`；不解释 Provider 术语（模型供应商）错误 |
| `contextCompactionManual` | `true` | 允许 `/compact` 产生 `manual` |

压缩原因固定为 `manual | auto`。自动模式固定为 `off | shadow | live`：`off` 不判断，`shadow` 只计算 trigger eligibility 术语（触发资格）且不调用摘要模型、不写 checkpoint 术语（检查点），`live` 命中阈值后产生 `reason=auto`。默认 flag 术语（功能开关）为 `false`，且未配置 `autoMode` 时按 `off` 处理。

通用 HTTP 400、其他 Provider 术语（模型供应商）失败、token ratio 术语（文本计量比例）或压缩失败都不会创建 hard block 术语（硬阻断）；用户可在会话恢复交互后自行执行 `/compact`。
