# Capability Progressive Disclosure

状态：active

读取时机：修改 MCP/Skill catalog、模型工具披露、`tool_search`、Runtime binding、Skill activation 或模型上下文预算策略时。

验证：`bun run test tests/runtime/capability-search.test.ts`、`bun run test tests/runtime/tool-controller.test.ts`、`bun run test tests/mcp-supervisor.test.ts`、`bun run test tests/tool-definitions.test.ts`、`bun run typecheck`。

`capabilityCatalogV1`、`mcpRuntimeBindingV1` 与 `toolSearchV1` 已完成迁移并默认开启。MCP Tool ≤20 且 token budget 充足时直接绑定，跳过 `tool_search` 往返；Skill 使用扣除 MCP 后的剩余预算独立判断，防止各自不超预算的小目录合计撑爆上下文窗口。显式关闭任一 MCP flag 只用于 fail-closed 诊断，不恢复旧 adapter。

Capability disclosure 的 token budget 使用与 context preflight 相同的 `ResolvedModelCapabilities.contextWindowTokens`。模型名称和默认模型列表不提供窗口能力；没有显式 disclosure budget 时采用保守的 1024-token catalog budget，直到模型条目、adapter runtime metadata 或兼容字段提供可验证窗口。

Per-tool 名称注入（`## Available MCP Tool Names` 段落）已移除。模型初始只通过 system prompt 中的固定 MCP Capability Usage 规则和工具列表中的 `list_mcp_tools`、`tool_search`、`list_mcp_resources` 三个内置工具发现 MCP 能力。`tool_search` 在 `toolSearchV1` 开启且 provider 支持工具调用时始终可用，不受 disclosure mode 影响；小目录直绑场景中 `tool_search` 仍保持可用，作为模型的 fallback 发现路径。规则明确禁止将 Resource 列表为空推断为 MCP Tool 不存在，并将三种用户意图路由到对应工具。

上述可用性只适用于未携带 sealed production execution boundary 的路径。当前 sealed boundary
只在 App 提供匹配 boundary/run/profile/network/endpoint/invocation identity 的单次 transport
receipt 后允许 remote HTTP Provider lookup/readiness；实际 fetch 仍逐 hop 执行 DNS/private/
allowlist/pinned-address 检查。当前 production TUI 没有该 controller，因此 `tool_search`、MCP
inventory/resource 和动态 Tool 继续 fail closed。local stdio 在 native conformance 前始终排除。
模型披露不能被当作执行许可。

`list_mcp_tools` 是确定性的纯只读盘点工具，不触发网络连接或等待 Provider discovery。基于 CapabilitySnapshot 和 ProviderDirectorySnapshot 构建脱敏清单。列出每个 Provider 的状态、next_action、可用 Tool 名称，支持 provider 过滤和 cursor 分页；输出不含 capabilityId、revision、schema 或 binding。mcpManager 不存在时返回合法空清单。`configured_provider_count` 和 `available_tool_count` 为全量去重值，不受 provider 过滤影响；过滤时额外返回 `matched_provider_count` 和 `matched_tool_count`。Provider 名和 Tool 名通过 `safeCapabilityMetadata`（`src/core/capabilities/public-metadata.ts`）统一清理：过滤控制字符和 surrogates、压缩空白、以 code point 安全截断至 96 字符。

`tool_search` 只负责按意图发现能力（"哪个 Capability 可以完成这个动作"），不再承担全量 Tool inventory。包含 MCP 清单意图的查询（中英文均支持，中文不依赖空格分词）会被重定向为 `inventory_query` + `next_tool: list_mcp_tools`，提醒模型使用正确的盘点工具。这是错误恢复机制，不作为 inventory 的主要实现。包含业务关键词的 query 继续使用相关性排序。

`tool_search`、`list_mcp_tools`、`list_mcp_resources` 与 `read_mcp_resource` 的 schema、契约和执行已由 ToolSpec Registry 统一提供。搜索 spec 负责 feature gate、inventory redirect、Provider readiness 重试、候选投影以及 `capability.search_completed` 事件；controller 仅保留 disclosure、binding、policy 等执行前治理并追加 spec 投影事件，不得重算搜索结果。

零匹配搜索结果（`candidates.length === 0`）总是附带 `catalog_summary`（available_mcp_tool_count、available_skill_count、configured_provider_count、unavailable_provider_count）和显式说明消息，避免模型把 "zero matches" 解释为 "empty catalog"。`unavailable_provider_count` 排除 `ready` 和 `degraded`（后者被视为 callable）；当存在非 ready Provider 时额外返回 `non_healthy_provider_count`。

模型请求与其返回的 Tool Call 之间可能跨越 catalog revision。跨 revision 的 `tool_search` 缓存在 reducer 中被判定为 stale 并丢弃，不产生 binding。具体 Tool 的后续搜索与执行仍必须基于当前 descriptor/revision fail closed。

当 MCP directory 存在 unavailable Provider 时，即使可用 catalog 未超预算，也可以同时暴露 `tool_search`。query 可匹配 provider 名称或最近一次成功 discovery 的 Tool 名称；公共 provider 结果最多 4 条，稳定排序，只包含安全截断名称、`pending_approval|rejected|disabled|login_required|connecting|degraded|failed|quarantined`、有限 diagnostic code 和固定 next action。首次 discovery 前不虚构 Tool 名称。Provider 摘要不进入候选 binding，也不提供可执行 handle。

当查询明确命中仍处于 `connecting` 的 Provider 且当前没有候选 Tool 时，`tool_search` 最多等待 5 秒完成该 Provider 的初始 discovery，然后基于最新 revisioned snapshot 重新搜索。等待接受 Runtime 取消信号，取消时立即中止等待并重新抛出，不返回成功结果。单个 Provider 连接失败可容忍，不终止整个搜索；超时或失败仍只返回不可用 Provider 元数据，不虚构 Tool、Schema 或 binding。

有限 binding 的模型工具声明同样不得透传远端自然语言：工具 description 使用 Runtime 固定契约，模型可见 input schema 会递归移除 `description`、`title`、`$comment`、`examples` 和 `default` 注释；Runtime 参数校验仍使用原始 revisioned schema，因此该清理不会放宽执行边界。

远端 schema 在 admission 前通过单次遍历校验预算：256 KiB UTF-8 字节上限、32 层深度上限、4096 对象节点上限、1024 属性上限。超限 schema 进入 `quarantined` 诊断，不进入 catalog。Provider 状态判断（callable/unavailable/healthy）统一在 `src/core/capabilities/provider-status.ts` 中定义，inventory、search、tool controller 共享同一来源。

搜索结果通过 `capability.search_completed` 持久化。下一次模型调用重新核对 catalog/capability revision，把命中的 MCP Tool 合并进 session-loaded set，并为全部仍有效的 loaded Tool 生成新的 turn-scoped binding；命中的 Skill 仍只生成本轮 disclosure。`capability.bindings_issued` 原子替换本轮 binding/disclosure、持久化完整 loaded set 并消费搜索结果。catalog 漂移会淘汰对应 loaded Tool，且不得回退到旧 MCP 注入。

搜索只负责发现，不负责授权。MCP 调用仍必须携带 Runtime-issued binding，并继续经过 schema、policy、approval、execution record 和 verification；Skill activation 在该 flag 开启时必须匹配本轮 disclosure，猜测 Skill ID 会被拒绝。关闭 flag 只恢复现有的治理型全量 binding 路径，不恢复旧 MCP adapter 或 Prompt Skill 正文注入。

MCP Resources 不进入 `tool_search`、session-loaded Tool set 或 turn-scoped binding。`list_mcp_resources` 与 `read_mcp_resource` 是稳定内置只读工具：前者从 Runtime Resource Directory 枚举静态 URI，后者只读取当前 discovery snapshot 中存在的 URI。Resource discovery 与 Tool progressive disclosure 保持独立。

三类 MCP 暴露概念必须正交：Provider != Tool != Resource。任何一个为空不自动推出另外两个为空。

Disclosure/search 仍只表示发现，不表示 release admission。Phase 5 profile 即使列出 capability，也必须
重新验证实际 feature flags、dependency revision、embedded ceiling、route/platform allowlist 和实际
G3/G4/G5 freshness；unknown/stale/failed 全部 blocked。当前 MCP write 与 Skills production route/
profile 均为空或 off。
